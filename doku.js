const {createHash,createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
const CALLBACK='/api/payments/doku/callback';
function signature({clientId,requestId,timestamp,target,raw},key){
  const parts=[`Client-Id:${clientId}`,`Request-Id:${requestId}`,`Request-Timestamp:${timestamp}`,`Request-Target:${target}`];
  if(raw!==undefined)parts.push('Digest:'+createHash('sha256').update(raw).digest('base64'));
  return 'HMACSHA256='+createHmac('sha256',key).update(parts.join('\n')).digest('base64');
}
function verifyCallback(req,clientId,key){
  if(!key||!clientId||!Buffer.isBuffer(req.rawBody)||req.get('Client-Id')!==clientId)return false;
  const requestId=req.get('Request-Id'),timestamp=req.get('Request-Timestamp'),supplied=req.get('Signature');
  if(typeof requestId!=='string'||!requestId.length||requestId.length>128||/[\r\n]/.test(requestId)||typeof timestamp!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)||!Number.isFinite(Date.parse(timestamp))||typeof supplied!=='string')return false;
  const expected=signature({clientId,requestId,timestamp,target:CALLBACK,raw:req.rawBody},key);
  const a=Buffer.from(expected),b=Buffer.from(supplied);return a.length===b.length&&timingSafeEqual(a,b);
}
function checkoutUrl(value,production){
  const u=new URL(value);const hosts=production?['checkout.doku.com']:['sandbox.doku.com'];
  if(u.protocol!=='https:'||!hosts.includes(u.hostname)||u.port||u.username||u.password||!/^\/checkout-link(?:-v2)?\/.+/.test(u.pathname))throw Error('Alamat pembayaran QRIS tidak valid.');return u.href;
}
function validateStatus(p,s){
  const amount=String(s?.order?.amount??''),state=s?.transaction?.status;
  if(s?.order?.invoice_number!==p.order_id||!/^\d+(?:\.00)?$/.test(amount)||Number(amount)!==p.amount||(s.order.currency!=null&&s.order.currency!=='IDR')||
    !['PENDING','SUCCESS','FAILED','EXPIRED','TIMEOUT','REDIRECT','REFUNDED'].includes(state)||
    (s?.channel?.id!=null&&s.channel.id!=='QRIS_DOKU')||
    (state==='SUCCESS'&&(!['QRIS','E_MONEY','EMONEY'].includes(s?.service?.id)||s?.channel?.id!=='QRIS_DOKU')))
    throw Error('Data pembayaran tidak sesuai tagihan QRIS.');
  return state==='SUCCESS';
}
function providerExpiry(value){
  if(value==null)return null;
  if(typeof value!=='string'||!/^\d{14}$/.test(value))throw Error('Batas waktu pembayaran tidak valid. Jangan membuat tagihan pengganti.');
  // Compact Checkout timestamps use WIB, as shown by the provider's response examples.
  const iso=value.slice(0,4)+'-'+value.slice(4,6)+'-'+value.slice(6,8)+'T'+value.slice(8,10)+':'+value.slice(10,12)+':'+value.slice(12,14);
  const ms=Date.parse(iso+'+07:00');
  if(!Number.isFinite(ms)||new Date(ms+7*3600000).toISOString().slice(0,19)!==iso)throw Error('Batas waktu pembayaran tidak valid. Jangan membuat tagihan pengganti.');
  return ms;
}
function createDoku({db,fetchImpl=fetch,env=process.env,onSettled=async()=>{},assertCanCreate,diagnostics,record=()=>{},now=Date.now}){
  const clientId=String(env.DOKU_CLIENT_ID||'').trim(),key=String(env.DOKU_SECRET_KEY||'').trim(),production=env.DOKU_IS_PRODUCTION==='true';
  const configured=Boolean(clientId&&key),base=production?'https://api.doku.com':'https://api-sandbox.doku.com';
  const scope=createHash('sha256').update(clientId+':'+production).digest('hex').slice(0,16);
  const columns=new Set(db.prepare('PRAGMA table_info(topups)').all().map(c=>c.name));
  for(const name of ['doku_account','doku_request_id'])if(!columns.has(name))db.exec('ALTER TABLE topups ADD COLUMN '+name+' TEXT');
  const note=(name,value)=>db.prepare('INSERT INTO qris_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('doku:'+scope+':'+name,String(value));
  const value=name=>db.prepare('SELECT value FROM qris_settings WHERE key=?').get('doku:'+scope+':'+name)?.value;
  function health(){
    let callbackUrl=null;const raw=env.DOKU_PUBLIC_BASE_URL||(env.RAILWAY_PUBLIC_DOMAIN?'https://'+env.RAILWAY_PUBLIC_DOMAIN:'');
    if(raw)try{const u=new URL(raw);if(u.protocol==='https:'&&u.hostname.length<=253&&!u.username&&!u.password&&!u.port&&['','/'].includes(u.pathname)&&!u.search&&!u.hash)callbackUrl=u.origin+CALLBACK;}catch{}
    return {configured,production,ready:configured&&production,callbackPath:CALLBACK,callbackUrl,publicUrlValid:!raw||Boolean(callbackUrl),apiCode:value('api_code')||'Belum diperiksa',lastAPI:Number(value('api_ms'))||null,callbackCode:value('callback_code')||'Belum diterima',lastCallback:Number(value('callback_ms'))||null};
  }
  const get=id=>db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='doku'").get(id);
  async function request(path,body,requestId=randomUUID()){
    if(!configured)throw Error('Konfigurasi pembayaran QRIS belum diisi oleh owner.');
    const raw=body===undefined?undefined:JSON.stringify(body),timestamp=new Date(now()).toISOString().replace(/\.\d{3}Z$/,'Z');
    let observed=false;
    try{const res=await fetchImpl(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Accept:'application/json','Client-Id':clientId,'Request-Id':requestId,'Request-Timestamp':timestamp,Signature:signature({clientId,requestId,timestamp,target:path,raw},key)},...(raw===undefined?{}:{body:raw}),signal:AbortSignal.timeout(15000)});
      observed=true;note('api_ms',now());note('api_code',Number.isInteger(res.status)?res.status:(res.ok?'OK':'FAILED'));
      const result=await res.json().catch(e=>{note('api_code','INVALID_RESPONSE');throw e;});if(!res.ok){const e=Error('Layanan pembayaran belum dapat memproses permintaan. Periksa konfigurasi dan tagihan sebelum mencoba lagi.');e.creationRejected=body!==undefined&&[400,401,403,422].includes(res.status)&&!result?.response?.payment;throw e;}record('api_ok');return result;
    }catch(e){if(!observed){note('api_ms',now());note('api_code','FAILED');}record('api_failed');diagnostics?.record('payment','FAILED','doku');throw Error(e.creationRejected?'Permintaan invoice QRIS ditolak. Periksa konfigurasi DOKU dan aktivasi layanan.':'Koneksi pembayaran belum dapat dipastikan. Buka Tagihan Aktif; jangan membuat pembayaran ulang.',{cause:e});}
  }
  const apply=db.transaction(s=>{
    const p=get(s.order?.invoice_number);if(!p)throw Error('Tagihan QRIS tidak ditemukan.');const paid=validateStatus(p,s);
    const states={PENDING:'pending',SUCCESS:'settlement',FAILED:'pending',EXPIRED:'expire',TIMEOUT:'pending',REDIRECT:'pending',REFUNDED:'refund'};
    // FAILED may describe a retryable attempt on a still usable checkout session.
    if(p.provider_status!=='REFUNDED'&&!(p.credited&&s.transaction.status!=='REFUNDED')&&!(p.status==='expire'&&!paid&&s.transaction.status!=='REFUNDED'))db.prepare('UPDATE topups SET provider_status=? WHERE order_id=?').run(s.transaction.status,p.order_id);
    if(p.provider_status==='REFUNDED'||s.transaction.status==='REFUNDED')db.prepare("UPDATE topups SET status='refund',provider_status='REFUNDED' WHERE order_id=?").run(p.order_id);
    else if(!p.credited){const next=p.status==='expire'&&!paid?'expire':states[s.transaction.status];db.prepare('UPDATE topups SET status=? WHERE order_id=?').run(next,p.order_id);
      if(paid&&p.provider_status!=='REFUNDED'){const changed=db.prepare('UPDATE topups SET credited=1,paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE order_id=? AND credited=0').run(p.order_id);
        if(changed.changes&&p.purpose==='topup')db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(p.discord_id,p.amount);
      }
    }return get(p.order_id);
  });
  async function finish(s){const p=apply(s);if(p.credited&&p.purpose==='purchase'&&p.provider_status==='SUCCESS')await onSettled(p);return {...p,providerStatus:s.transaction.status};}
  function accessible(id,user){const p=get(id);if(!p||(user&&p.discord_id!==user))throw Error('Tagihan QRIS tidak ditemukan.');if(p.production==null||Boolean(p.production)!==production)throw Error('Mode tagihan QRIS berbeda. Hubungi owner; jangan membayar ulang.');if(p.doku_account&&p.doku_account!==scope)throw Error('Invoice milik akun DOKU berbeda. Gunakan konfigurasi akun asal untuk memeriksanya; jangan membayar ulang.');return p;}
  const reserve=db.transaction((id,user,amount,purpose)=>{assertCanCreate(user);db.prepare("INSERT INTO topups(order_id,discord_id,amount,purpose,gateway,channel,production,total_charge,fee_customer,expires_ms,doku_account,doku_request_id) VALUES(?,?,?,?,'doku','QRIS_DOKU',?,?,0,?,?,?)").run(id,user,amount,purpose,production?1:0,amount,now()+20*60000,scope,randomUUID());});
  async function create(user,amount,options={}){
    if(!configured)throw Error('Konfigurasi pembayaran QRIS belum diisi oleh owner.');
    if(!production)throw Error('QRIS DOKU tersedia di mode produksi. Owner perlu memakai credential produksi dan DOKU_IS_PRODUCTION=true setelah layanan QRIS berstatus ACTIVE.');
    const {parseTopup,parseCustomerEmail}=require('./payments'),purpose=options.purpose==='purchase'?'purchase':'topup';
    amount=parseTopup(amount,purpose==='purchase'?1000:5000);const email=parseCustomerEmail(options.email),id=options.orderId||'maboyy-'+randomUUID();
    if(email.length>128)throw Error('Email tagihan DOKU maksimal 128 karakter.');
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id))throw Error('ID invoice QRIS tidak valid.');reserve(id,user,amount,purpose);
    let r;try{r=await request('/checkout/v1/payment',{order:{amount,invoice_number:id,currency:'IDR',language:options.language==='en'?'EN':'ID',auto_redirect:false,disable_retry_payment:true,line_items:[{name:purpose==='topup'?'Isi Saldo Shop.M':'Pembelian Produk Shop.M',price:amount,quantity:1}]},payment:{payment_due_date:20,payment_method_types:['QRIS']},customer:{name:String(options.name||'Pembeli').slice(0,100),email}},get(id).doku_request_id);}catch(e){if(e.cause?.creationRejected)db.prepare("UPDATE topups SET status='failure' WHERE order_id=? AND credited=0 AND status='creating'").run(id);throw e;}
    const data=r?.response;
    if(!Array.isArray(r?.message)||!r.message.includes('SUCCESS')||data?.order?.invoice_number!==id||Number(data.order.amount)!==amount||(data.order.currency&&data.order.currency!=='IDR')||typeof data.payment?.token_id!=='string'||!data.payment.token_id||data.payment.token_id.length>512||
      (data.payment.payment_method_types!=null&&(!Array.isArray(data.payment.payment_method_types)||data.payment.payment_method_types.length!==1||data.payment.payment_method_types[0]!=='QRIS')))
      throw Error('Respons invoice belum sesuai. Buka Tagihan Aktif; jangan membayar ulang.');
    const url=checkoutUrl(data.payment.url,production),expiry=providerExpiry(data.payment.expired_date)??get(id).expires_ms;
    // A callback can arrive before the creation response. Preserve a settled row.
    db.prepare("UPDATE topups SET provider_ref=?,checkout_url=?,expires_ms=?,status=CASE WHEN status='creating' THEN 'pending' ELSE status END WHERE order_id=?").run(data.payment.token_id,url,expiry,id);return get(id);
  }
  async function inquiry(p){
    const created=Date.parse(p.created_at+'Z'),retryAt=Math.max(created+60000,Number(p.status_checked_ms||0)+60000);
    if(!Number.isFinite(created))throw Error('Waktu invoice tidak valid. Hubungi owner untuk pemeriksaan.');
    if(now()<retryAt)return {waiting:true,retryAt};
    const claimed=db.prepare('UPDATE topups SET status_checked_ms=? WHERE order_id=? AND COALESCE(status_checked_ms,0)<=?').run(now(),p.order_id,now()-60000);
    if(!claimed.changes)return {waiting:true,retryAt:now()+60000};
    const result=await request('/orders/v1/status/'+encodeURIComponent(p.order_id));
    try{validateStatus(p,result);}catch(e){note('api_code','INVALID_INVOICE');record('api_failed');throw e;}
    return {result};
  }
  async function inspect(id){const p=accessible(id),r=await inquiry(p);return {order_id:p.order_id,amount:p.amount,localStatus:p.status,status:r.waiting?null:r.result.transaction.status,waiting:!!r.waiting,retryAt:r.retryAt};}
  async function refresh(id,user){const p=accessible(id,user);
    if(p.credited){if(p.purpose==='purchase'&&p.provider_status==='SUCCESS')await onSettled(p);return p;}
    // DOKU requires a delay before inquiry. Signed callbacks remain immediate.
    const r=await inquiry(p);if(r.waiting)return {...p,nextCheckMs:r.retryAt};
    try{return await finish(r.result);}catch(e){record('api_failed');throw e;}
  }
  function mount(app){app.post(CALLBACK,async(req,res)=>{
    if(!configured)return res.status(503).json({success:false});
    if(!verifyCallback(req,clientId,key))return res.status(403).json({success:false});
    let payload;try{payload=JSON.parse(req.rawBody.toString('utf8'));const invoice=accessible(payload?.order?.invoice_number);validateStatus(invoice,payload);}catch{record('callback_failed');note('callback_ms',now());note('callback_code','INVALID_INVOICE');return res.status(400).json({success:false,message:'Invoice atau nominal tidak sesuai.'});}
    let p;try{p=apply(payload);db.prepare('UPDATE topups SET verified_callback_ms=? WHERE order_id=?').run(now(),p.order_id);record('callback_ok');note('callback_ms',now());note('callback_code','VERIFIED');}
    catch{record('callback_failed');note('callback_ms',now());note('callback_code','RETRY_REQUIRED');diagnostics?.record('webhook','FAILED','doku');return res.status(502).json({success:false,message:'Notifikasi belum dapat diproses; ulangi atau periksa invoice.'});}
    res.json({success:true}); // Acknowledge durable payment before waiting on delivery providers.
    if(p.credited&&p.purpose==='purchase'&&p.provider_status==='SUCCESS')try{await onSettled(p);}catch{diagnostics?.record('delivery','FAILED',p.order_id);}
  });}
  return {configured,production,create,refresh,mount,health,inspect,local:accessible};
}
function paymentButton(p,discord){if(!p?.checkout_url)return null;const b=new discord.ButtonBuilder().setLabel('Bayar QRIS').setStyle(discord.ButtonStyle.Link??5).setURL(p.checkout_url);if(p.credited||['expire','failure','refund'].includes(p.status)||(p.expires_ms&&p.expires_ms<=Date.now()))b.setDisabled(true);return b;}
function paymentInstruction(p,en=false){
  const deadline=p.expires_ms?'\n'+(en?'Payment deadline: ':'Batas pembayaran: ')+'<t:'+Math.floor(p.expires_ms/1000)+':R>':'';
  if(!p.credited&&p.expires_ms&&p.expires_ms<=Date.now())return (en?'Payment window has ended. Check payment status; do not pay again until verified.':'Waktu pembayaran sudah habis. Cek status pembayaran; jangan membayar ulang sebelum status dipastikan.')+deadline;
  if(p.status==='refund'||p.provider_status==='REFUNDED')return en?'Refund detected. Contact the owner to reconcile this invoice.':'Refund terdeteksi. Hubungi owner untuk mencocokkan invoice ini.';
  if(p.credited)return en?'✅ Payment verified. Do not pay again.':'✅ Pembayaran terverifikasi. Jangan membayar ulang.';
  if(['expire','failure'].includes(p.status))return en?'This invoice cannot be paid. Check its status before creating another payment.':'Tagihan ini tidak dapat dibayar. Periksa status sebelum membuat pembayaran baru.';
  return (p.gateway==='doku'?(p.production?(en?'1. Open Pay QRIS.\n2. Scan or save the QRIS on the DOKU page.\n3. Pay once, then return to Check Payment.':'1. Tekan Bayar QRIS.\n2. Pindai atau simpan QRIS di halaman DOKU.\n3. Bayar satu kali, lalu kembali ke Cek Pembayaran.'):(en?'DOKU QRIS is unavailable in sandbox. Contact the owner.':'QRIS DOKU tidak tersedia di sandbox. Hubungi owner.')):(p.production?(en?'Scan QRIS to pay.':'Pindai QRIS untuk membayar.'):(en?'TEST MODE — use the payment simulator.':'MODE UJI — gunakan simulator pembayaran.')))+deadline;
}
module.exports={signature,verifyCallback,checkoutUrl,validateStatus,createDoku,paymentButton,paymentInstruction,providerExpiry,CALLBACK};
