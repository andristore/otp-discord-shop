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
function createMidtrans({db,fetchImpl=fetch,env=process.env,onSettled,assertCanCreate}){
  const serverKey=env.MIDTRANS_SERVER_KEY,production=env.MIDTRANS_IS_PRODUCTION==='true',configured=Boolean(serverKey);
  const acquirer=env.MIDTRANS_QRIS_ACQUIRER || 'gopay';
  if(!['gopay','airpay shopee'].includes(acquirer))throw new Error('MIDTRANS_QRIS_ACQUIRER harus gopay atau airpay shopee.');
  const base=production?'https://api.midtrans.com':'https://api.sandbox.midtrans.com';
  async function request(path,body){
    if(!configured)throw new Error('MIDTRANS_SERVER_KEY belum diisi oleh admin.');
    const res=await fetchImpl(base+path,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(serverKey+':').toString('base64'),'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const s=await res.json();if(!res.ok || !['200','201','202'].includes(String(s.status_code)))throw new Error('Midtrans belum dapat memproses tagihan. Periksa konfigurasi atau status tagihan sebelum mencoba lagi.');return s;
  }
  function qrUrl(status){const action=status.actions?.find(a=>a.name==='generate-qr-code-v2' && a.method==='GET') || status.actions?.find(a=>a.name==='generate-qr-code' && a.method==='GET');if(!action)return null;
    const u=new URL(action.url);if(u.origin!==base || u.username || u.password || !/^\/v[24]\/qris\/.+\/qr-code$/.test(u.pathname))throw new Error('Alamat QR Midtrans tidak valid.');return u.href;
  }
  const apply=db.transaction(s=>{
    const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(s.order_id);if(!p)throw new Error('Tagihan tidak ditemukan.');
    const settled=validateMidtransStatus(p,s),qr=qrUrl(s);
    db.prepare('UPDATE topups SET provider_ref=?,channel=\'qris\',total_charge=?,fee_customer=0,qr_url=COALESCE(?,qr_url) WHERE order_id=?').run(s.transaction_id,p.amount,qr,p.order_id);
    if(!p.credited){db.prepare('UPDATE topups SET status=? WHERE order_id=?').run(s.transaction_status,p.order_id);if(settled){const changed=db.prepare('UPDATE topups SET credited=1 WHERE order_id=? AND credited=0').run(p.order_id);if(changed.changes && p.purpose==='topup')db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(p.discord_id,p.amount);}}
    return db.prepare('SELECT * FROM topups WHERE order_id=?').get(p.order_id);
  });
  async function refresh(id,userId){const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(id);if(!p || (userId && p.discord_id!==userId))throw new Error('Tagihan tidak ditemukan.');
    if(p.production==null || Boolean(p.production)!==production)throw new Error('Mode tagihan Midtrans berbeda atau belum tercatat. Hubungi admin; jangan membayar ulang.');
    const status=await request('/v2/'+encodeURIComponent(id)+'/status');validateMidtransStatus(p,status);const r=apply(status);if(r.credited && r.purpose==='purchase' && status.transaction_status==='settlement')await onSettled(r);return {...r,providerStatus:status.transaction_status};
  }
  const reserve=db.transaction((id,userId,amount,purpose)=>{assertCanCreate(userId);db.prepare("INSERT INTO topups(order_id,discord_id,amount,purpose,gateway,channel,production) VALUES(?,?,?,?,'midtrans','qris',?)").run(id,userId,amount,purpose,production?1:0);});
  async function create(userId,amount,options={}){if(!configured)throw new Error('MIDTRANS_SERVER_KEY belum diisi oleh admin.');
    const {parseTopup,parseCustomerEmail}=require('./payments');const purpose=options.purpose==='purchase'?'purchase':'topup';amount=parseTopup(amount,purpose==='purchase'?1000:5000);const email=parseCustomerEmail(options.email),id=options.orderId || 'maboyy-'+randomUUID();reserve(id,userId,amount,purpose);
    const s=await request('/v2/charge',{payment_type:'qris',qris:{acquirer},transaction_details:{order_id:id,gross_amount:amount},item_details:[{id:purpose,name:purpose==='purchase'?'Pembelian OTP':'Isi Saldo OTP',price:amount,quantity:1}],customer_details:{first_name:String(options.name || 'Pembeli OTP').slice(0,100),email}});
    validateMidtransStatus(db.prepare('SELECT * FROM topups WHERE order_id=?').get(id),s);
    const r=apply(s);if(r.credited && r.purpose==='purchase')await onSettled(r);if(!r.qr_url)throw new Error('QR belum diterima. Buka Tagihan Aktif dan periksa Midtrans sebelum membuat tagihan baru.');return r;
  }
  function mount(app){app.post('/api/payments/midtrans/callback',async(req,res)=>{
    if(!configured)return res.status(503).json({success:false,message:'Midtrans belum aktif'});
    if(!validMidtransSignature(req.body,serverKey))return res.status(403).json({success:false,message:'Signature tidak valid'});
    const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='midtrans'").get(req.body.order_id);if(!p)return res.status(404).json({success:false,message:'Tagihan tidak ditemukan'});
    try{validateMidtransStatus(p,req.body);await refresh(p.order_id);res.json({success:true});}catch{res.status(502).json({success:false,message:'Konfirmasi belum tersedia; ulangi notifikasi'});}
  });}
  return {configured,production,create,refresh,mount};
}
module.exports={validMidtransSignature,validateMidtransStatus,createMidtrans};
