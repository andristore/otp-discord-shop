const {createHash,timingSafeEqual,randomUUID}=require('node:crypto');
function validMidtransSignature(body,key){
  if(!key || !body || !['order_id','status_code','gross_amount','signature_key'].every(k=>typeof body[k]==='string') || !/^[a-f0-9]{128}$/i.test(body.signature_key))return false;
  const digest=createHash('sha512').update(body.order_id+body.status_code+body.gross_amount+key).digest();
  return timingSafeEqual(digest,Buffer.from(body.signature_key,'hex'));
}
function validateMidtransStatus(p,s){
  const raw=String(s.gross_amount ?? '');
  if(s.order_id!==p.order_id || s.payment_type!=='qris' || s.currency!=='IDR' || !/^\d+(?:\.00)?$/.test(raw) || Number(raw)!==p.amount ||
    typeof s.transaction_id!=='string' || !s.transaction_id || (p.provider_ref && p.provider_ref!==s.transaction_id) ||
    !['pending','settlement','expire','deny','cancel','failure','refund','partial_refund'].includes(s.transaction_status) ||
    (s.transaction_status==='settlement' && s.fraud_status!=null && s.fraud_status!=='accept'))throw new Error('Data pembayaran Midtrans tidak sesuai tagihan.');
  return s.transaction_status==='settlement';
}
function midtransExpiry(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return null;
  const ms=Date.parse(value.replace(' ','T')+'+07:00');
  return Number.isFinite(ms)&&new Date(ms+7*3600000).toISOString().slice(0,19).replace('T',' ')===value?ms:null;
}
function createMidtrans({db,fetchImpl=fetch,env=process.env,onSettled,assertCanCreate,diagnostics}){
  const serverKey=env.MIDTRANS_SERVER_KEY,production=env.MIDTRANS_IS_PRODUCTION==='true',configured=Boolean(serverKey);
  const acquirer=env.MIDTRANS_QRIS_ACQUIRER || 'gopay';
  if(!['gopay','airpay shopee'].includes(acquirer))throw new Error('MIDTRANS_QRIS_ACQUIRER harus gopay atau airpay shopee.');
  const base=production?'https://api.midtrans.com':'https://api.sandbox.midtrans.com';
  db.exec('CREATE TABLE IF NOT EXISTS midtrans_health(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const note=(k,v)=>db.prepare('INSERT INTO midtrans_health VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));
  const read=k=>db.prepare('SELECT value FROM midtrans_health WHERE key=?').get(k)?.value;
  function health(){return {configured,production,acquirer,callbackPath:'/api/payments/midtrans/callback',lastAPI:Number(read('api_ms')||0),lastCallback:Number(read('callback_ms')||0),apiCode:read('api_code')||'Belum diuji',callbackCode:read('callback_code')||'Belum diterima'};}
  async function request(path,body){
    if(!configured)throw new Error('MIDTRANS_SERVER_KEY belum diisi oleh admin.');
    try{
    const res=await fetchImpl(base+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(serverKey+':').toString('base64'),'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const s=await res.json(),code=String(s?.status_code||'');
    note('api_ms',Date.now());note('api_code',/^\d{3}$/.test(code)?code:'INVALID_RESPONSE');
    if(!res.ok || !['200','201','202'].includes(code)){
      const e=new Error('Midtrans '+(/^\d{3}$/.test(code)?code:'respons tidak valid')+'. Periksa konfigurasi atau status tagihan sebelum mencoba lagi.');
      e.creationRejected=!!body&&['400','401','402','403','405','408','410','413'].includes(code)&&!s?.transaction_id&&(res.status==null||res.status<500);throw e;
    }return s;
    }catch(e){if(!e.creationRejected){note('api_ms',Date.now());if(!/^Midtrans \d{3}\./.test(e.message||''))note('api_code','FAILED');}diagnostics?.record('payment','FAILED','midtrans');throw e;}
  }
  function qrUrl(status){const action=status.actions?.find(a=>a.name==='generate-qr-code-v2' && a.method==='GET') || status.actions?.find(a=>a.name==='generate-qr-code' && a.method==='GET');if(!action)return null;
    const u=new URL(action.url);if(u.origin!==base || u.username || u.password || !/^\/v[24]\/qris\/.+\/qr-code$/.test(u.pathname))throw new Error('Alamat QR Midtrans tidak valid.');return u.href;
  }
  const apply=db.transaction(s=>{
    const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(s.order_id);if(!p)throw new Error('Tagihan tidak ditemukan.');
    const settled=validateMidtransStatus(p,s),qr=qrUrl(s);
    db.prepare('UPDATE topups SET provider_ref=?,channel=\'qris\',total_charge=?,fee_customer=0,qr_url=COALESCE(?,qr_url) WHERE order_id=?').run(s.transaction_id,p.amount,qr,p.order_id);
    const refund=['refund','partial_refund'].includes(s.transaction_status),raw=String(s.refund_amount??'');
    const refundAmount=refund&&/^\d+(?:\.00)?$/.test(raw)&&Number.isSafeInteger(Number(raw))&&Number(raw)<=p.amount?Number(raw):null;
    const observed=p.provider_status==='refund'?'refund':p.provider_status==='partial_refund'&&!refund?'partial_refund':s.transaction_status;
    db.prepare('UPDATE topups SET provider_status=?,expires_ms=COALESCE(?,expires_ms),external_refund_amount=CASE WHEN ? IS NULL THEN external_refund_amount ELSE MAX(COALESCE(external_refund_amount,0),?) END WHERE order_id=?').run(observed,midtransExpiry(s.expiry_time),refundAmount,refundAmount,p.order_id);
    if(!p.credited){db.prepare('UPDATE topups SET status=? WHERE order_id=?').run(s.transaction_status,p.order_id);if(settled){const changed=db.prepare('UPDATE topups SET credited=1,paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE order_id=? AND credited=0').run(p.order_id);if(changed.changes && p.purpose==='topup')db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(p.discord_id,p.amount);}}
    return db.prepare('SELECT * FROM topups WHERE order_id=?').get(p.order_id);
  });
  async function refresh(id,userId){const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(id);if(!p || (userId && p.discord_id!==userId))throw new Error('Tagihan tidak ditemukan.');
    if(p.production==null || Boolean(p.production)!==production)throw new Error('Mode tagihan Midtrans berbeda atau belum tercatat. Hubungi admin; jangan membayar ulang.');
    const status=await request('/v2/'+encodeURIComponent(id)+'/status');validateMidtransStatus(p,status);const r=apply(status);db.prepare('UPDATE topups SET status_checked_ms=? WHERE order_id=?').run(Date.now(),id);if(r.credited && r.purpose==='purchase' && r.provider_status==='settlement' && status.transaction_status==='settlement')await onSettled(r);return {...r,providerStatus:status.transaction_status};
  }
  const reserve=db.transaction((id,userId,amount,purpose)=>{assertCanCreate(userId);db.prepare("INSERT INTO topups(order_id,discord_id,amount,purpose,gateway,channel,production) VALUES(?,?,?,?,'midtrans','qris',?)").run(id,userId,amount,purpose,production?1:0);});
  async function create(userId,amount,options={}){if(!configured)throw new Error('MIDTRANS_SERVER_KEY belum diisi oleh admin.');
    const {parseTopup,parseCustomerEmail}=require('./payments');const purpose=options.purpose==='purchase'?'purchase':'topup';amount=parseTopup(amount,purpose==='purchase'?1000:5000);const email=parseCustomerEmail(options.email),id=options.orderId || 'maboyy-'+randomUUID();reserve(id,userId,amount,purpose);
    let s;try{s=await request('/v2/charge',{payment_type:'qris',qris:{acquirer},transaction_details:{order_id:id,gross_amount:amount},item_details:[{id:purpose,name:purpose==='purchase'?'Pembelian Produk Digital':'Isi Saldo Toko',price:amount,quantity:1}],customer_details:{first_name:String(options.name || 'Pembeli').slice(0,100),email}});}catch(e){if(e.creationRejected)db.prepare("UPDATE topups SET status='failure' WHERE order_id=? AND status='creating' AND provider_ref IS NULL AND credited=0").run(id);throw e;}
    validateMidtransStatus(db.prepare('SELECT * FROM topups WHERE order_id=?').get(id),s);
    const r=apply(s);if(r.credited && r.purpose==='purchase')await onSettled(r);if(!r.qr_url)throw new Error('QR belum diterima. Buka Tagihan Aktif dan periksa Midtrans sebelum membuat tagihan baru.');return r;
  }
  function mount(app){app.post('/api/payments/midtrans/callback',async(req,res)=>{
    if(!configured)return res.status(503).json({success:false,message:'Midtrans belum aktif'});
    if(!validMidtransSignature(req.body,serverKey))return res.status(403).json({success:false,message:'Signature tidak valid'});
    const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(req.body.order_id);if(!p)return res.status(404).json({success:false,message:'Tagihan tidak ditemukan'});
    try{validateMidtransStatus(p,req.body);await refresh(p.order_id);db.prepare('UPDATE topups SET verified_callback_ms=? WHERE order_id=?').run(Date.now(),p.order_id);note('callback_ms',Date.now());note('callback_code','VERIFIED');res.json({success:true});}catch{note('callback_ms',Date.now());note('callback_code','RETRY_REQUIRED');diagnostics?.record('webhook','FAILED','midtrans');res.status(502).json({success:false,message:'Konfirmasi belum tersedia; ulangi notifikasi'});}
  });}
  async function inspect(id){const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(id);if(!p)throw new Error('Invoice Midtrans tidak ditemukan.');if(p.production==null||Boolean(p.production)!==production)throw new Error('Mode invoice berbeda dari konfigurasi Midtrans.');const s=await request('/v2/'+encodeURIComponent(id)+'/status');validateMidtransStatus(p,s);return {order_id:p.order_id,status:s.transaction_status,amount:p.amount,expires_ms:midtransExpiry(s.expiry_time)};}
  return {configured,production,create,refresh,mount,health,inspect};
}
function refundReviewFilter(alias){if(!/^[a-z]+$/.test(alias))throw Error('Alias tidak valid.');return `NOT EXISTS(SELECT 1 FROM gateway_refund_reviews r WHERE r.order_id=${alias}.order_id AND r.state='resolved' AND r.observed_status IS ${alias}.provider_status AND r.observed_amount IS ${alias}.external_refund_amount AND r.observed_ref IS ${alias}.provider_ref)`;}
module.exports={validMidtransSignature,validateMidtransStatus,createMidtrans,midtransExpiry,refundReviewFilter};
