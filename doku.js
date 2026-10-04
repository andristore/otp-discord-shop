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
  const get=id=>db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='doku'").get(id);
  async function request(path,body){
    if(!configured)throw Error('Konfigurasi pembayaran QRIS belum diisi oleh owner.');
    const raw=body===undefined?undefined:JSON.stringify(body),requestId=randomUUID(),timestamp=new Date(now()).toISOString().replace(/\.\d{3}Z$/,'Z');
    try{const res=await fetchImpl(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Accept:'application/json','Client-Id':clientId,'Request-Id':requestId,'Request-Timestamp':timestamp,Signature:signature({clientId,requestId,timestamp,target:path,raw},key)},...(raw===undefined?{}:{body:raw}),signal:AbortSignal.timeout(15000)});
      const result=await res.json();if(!res.ok){const e=Error('Layanan pembayaran belum dapat memproses permintaan. Periksa konfigurasi dan tagihan sebelum mencoba lagi.');e.creationRejected=body!==undefined&&[400,401,403,422].includes(res.status)&&!result?.response?.payment;throw e;}record('api_ok');return result;
    }catch(e){record('api_failed');diagnostics?.record('payment','FAILED','doku');throw e;}
  }
  const apply=db.transaction(s=>{
    const p=get(s.order?.invoice_number);if(!p)throw Error('Tagihan QRIS tidak ditemukan.');const paid=validateStatus(p,s);
    const states={PENDING:'pending',SUCCESS:'settlement',FAILED:'pending',EXPIRED:'expire',TIMEOUT:'pending',REDIRECT:'pending',REFUNDED:'refund'};
    // FAILED may describe a retryable attempt on a still usable checkout session.
    if(p.provider_status!=='REFUNDED'&&!(p.credited&&s.transaction.status!=='REFUNDED'))db.prepare('UPDATE topups SET provider_status=? WHERE order_id=?').run(s.transaction.status,p.order_id);
    if(!p.credited){db.prepare('UPDATE topups SET status=? WHERE order_id=?').run(states[s.transaction.status],p.order_id);
      if(paid&&p.provider_status!=='REFUNDED'){const changed=db.prepare('UPDATE topups SET credited=1,paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE order_id=? AND credited=0').run(p.order_id);
        if(changed.changes&&p.purpose==='topup')db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(p.discord_id,p.amount);
      }
    }return get(p.order_id);
  });
  async function finish(s){const p=apply(s);if(p.credited&&p.purpose==='purchase'&&p.provider_status==='SUCCESS')await onSettled(p);return {...p,providerStatus:s.transaction.status};}
  function accessible(id,user){const p=get(id);if(!p||(user&&p.discord_id!==user))throw Error('Tagihan QRIS tidak ditemukan.');if(p.production==null||Boolean(p.production)!==production)throw Error('Mode tagihan QRIS berbeda. Hubungi owner; jangan membayar ulang.');return p;}
  const reserve=db.transaction((id,user,amount,purpose)=>{assertCanCreate(user);db.prepare("INSERT INTO topups(order_id,discord_id,amount,purpose,gateway,channel,production,total_charge,fee_customer,expires_ms) VALUES(?,?,?,?,'doku','QRIS_DOKU',?,?,0,?)").run(id,user,amount,purpose,production?1:0,amount,now()+20*60000);});
  async function create(user,amount,options={}){
    if(!configured)throw Error('Konfigurasi pembayaran QRIS belum diisi oleh owner.');
    const {parseTopup,parseCustomerEmail}=require('./payments'),purpose=options.purpose==='purchase'?'purchase':'topup';
    amount=parseTopup(amount,purpose==='purchase'?1000:5000);const email=parseCustomerEmail(options.email),id=options.orderId||'maboyy-'+randomUUID();
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id))throw Error('ID invoice QRIS tidak valid.');reserve(id,user,amount,purpose);
    let r;try{r=await request('/checkout/v1/payment',{order:{amount,invoice_number:id,currency:'IDR',disable_retry_payment:true},payment:{payment_due_date:20,payment_method_types:['QRIS']},customer:{name:String(options.name||'Pembeli').slice(0,100),email}});}catch(e){if(e.creationRejected)db.prepare("UPDATE topups SET status='failure' WHERE order_id=? AND credited=0 AND status='creating'").run(id);throw e;}
    const data=r?.response;
    if(!r?.message?.includes('SUCCESS')||data?.order?.invoice_number!==id||Number(data.order.amount)!==amount||(data.order.currency&&data.order.currency!=='IDR')||typeof data.payment?.token_id!=='string'||!data.payment.token_id)
      throw Error('Respons invoice belum sesuai. Buka Tagihan Aktif; jangan membayar ulang.');
    const url=checkoutUrl(data.payment.url,production),expiry=providerExpiry(data.payment.expired_date)??get(id).expires_ms;
    // A callback can arrive before the creation response. Preserve a settled row.
    db.prepare("UPDATE topups SET provider_ref=?,checkout_url=?,expires_ms=?,status=CASE WHEN status='creating' THEN 'pending' ELSE status END WHERE order_id=?").run(data.payment.token_id,url,expiry,id);return get(id);
  }
  async function refresh(id,user){const p=accessible(id,user);
    if(p.credited){if(p.purpose==='purchase'&&p.provider_status==='SUCCESS')await onSettled(p);return p;}
    // DOKU requires a delay before inquiry. Signed callbacks remain immediate.
    if(now()-Date.parse(p.created_at+'Z')<60000||now()-Number(p.status_checked_ms||0)<60000)return p;
    db.prepare('UPDATE topups SET status_checked_ms=? WHERE order_id=?').run(now(),id);
    const result=await request('/orders/v1/status/'+encodeURIComponent(id));try{return await finish(result);}catch(e){record('api_failed');throw e;}
  }
  function mount(app){app.post(CALLBACK,async(req,res)=>{
    if(!configured)return res.status(503).json({success:false});
    if(!verifyCallback(req,clientId,key))return res.status(403).json({success:false});
    try{const invoice=accessible(req.body?.order?.invoice_number);validateStatus(invoice,req.body);}catch{record('callback_failed');return res.status(400).json({success:false,message:'Invoice atau nominal tidak sesuai.'});}
    try{const p=await finish(req.body);db.prepare('UPDATE topups SET verified_callback_ms=? WHERE order_id=?').run(now(),p.order_id);record('callback_ok');return res.json({success:true});}
    catch{record('callback_failed');diagnostics?.record('webhook','FAILED','doku');return res.status(502).json({success:false,message:'Notifikasi belum dapat diproses; ulangi atau periksa invoice.'});}
  });}
  return {configured,production,create,refresh,mount};
}
function paymentButton(p,discord){if(!p?.checkout_url)return null;const b=new discord.ButtonBuilder().setLabel('Bayar QRIS').setStyle(discord.ButtonStyle.Link??5).setURL(p.checkout_url);if(p.credited||['expire','failure','refund'].includes(p.status)||(p.expires_ms&&p.expires_ms<=Date.now()))b.setDisabled(true);return b;}
function paymentInstruction(p,en=false){
  const deadline=p.expires_ms?'\n'+(en?'Payment deadline: ':'Batas pembayaran: ')+'<t:'+Math.floor(p.expires_ms/1000)+':R>':'';
  if(!p.credited&&p.expires_ms&&p.expires_ms<=Date.now())return (en?'Payment window has ended. Check payment status; do not pay again until verified.':'Waktu pembayaran sudah habis. Cek status pembayaran; jangan membayar ulang sebelum status dipastikan.')+deadline;
  return (p.gateway==='doku'?(p.production?(en?'Open Pay QRIS to display your QRIS.':'Tekan Bayar QRIS untuk menampilkan QRIS.'):(en?'TEST MODE — test payment only.':'MODE UJI — hanya pembayaran uji.')):(p.production?(en?'Scan QRIS to pay.':'Pindai QRIS untuk membayar.'):(en?'TEST MODE — use the payment simulator.':'MODE UJI — gunakan simulator pembayaran.')))+deadline;
}
module.exports={signature,verifyCallback,checkoutUrl,validateStatus,createDoku,paymentButton,paymentInstruction,providerExpiry,CALLBACK};
