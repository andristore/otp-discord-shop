const {createHmac,createHash,timingSafeEqual}=require('node:crypto');
function verifySignature(raw,signature,secret){
  if(!secret||!Buffer.isBuffer(raw)||typeof signature!=='string'||!/^sha256=[a-fA-F0-9]{64}$/.test(signature))return false;
  return timingSafeEqual(createHmac('sha256',secret).update(raw).digest(),Buffer.from(signature.slice(7),'hex'));
}
function createSMSCodeWebhook({db,operations,env=process.env,now=()=>Date.now()}){
  db.exec(`CREATE TABLE IF NOT EXISTS smscode_webhook_jobs(order_id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS smscode_webhook_receipts(hash TEXT PRIMARY KEY,received_at INTEGER NOT NULL);`);
  let busy=false;
  async function drain(){
    if(busy)return;busy=true;
    try{
      db.prepare('DELETE FROM smscode_webhook_receipts WHERE received_at<?').run(now()-172800000);
      db.prepare('DELETE FROM smscode_webhook_jobs WHERE received_at<?').run(now()-172800000);
      const jobs=db.prepare('SELECT * FROM smscode_webhook_jobs WHERE next_attempt<=? ORDER BY received_at LIMIT 10').all(now());
      for(const job of jobs){
        db.prepare('UPDATE smscode_webhook_jobs SET next_attempt=? WHERE order_id=?').run(now()+15000,job.order_id);
        try{if(await operations.pollOTP(job.order_id))db.prepare('DELETE FROM smscode_webhook_jobs WHERE order_id=? AND generation=?').run(job.order_id,job.generation);}catch{}
      }
    }finally{busy=false;}
  }
  function receive(req,res){
    if(!env.SMSCODE_WEBHOOK_SECRET)return res.status(503).json({error:'Webhook belum dikonfigurasi.'});
    if(!verifySignature(req.rawBody,req.get('X-Webhook-Signature'),env.SMSCODE_WEBHOOK_SECRET))return res.status(401).json({error:'Signature tidak valid.'});
    let event;try{event=JSON.parse(req.rawBody.toString('utf8'));}catch{return res.status(400).json({error:'JSON tidak valid.'});}
    if(!['order.otp_received','order.completed','order.expired','order.canceled'].includes(event?.event))return res.json({received:true,ignored:true});
    const id=event.data?.order_id;
    if((typeof id!=='string'&&(!Number.isSafeInteger(id)||id<=0))||!/^\d{1,20}$/.test(String(id)))return res.status(400).json({error:'Order ID tidak valid.'});
    const hash=createHash('sha256').update(req.rawBody).digest('hex');
    try{
      db.transaction(()=>{
        const added=db.prepare('INSERT OR IGNORE INTO smscode_webhook_receipts(hash,received_at) VALUES(?,?)').run(hash,now());
        if(added.changes)db.prepare('INSERT INTO smscode_webhook_jobs(order_id,received_at,next_attempt) VALUES(?,?,0) ON CONFLICT(order_id) DO UPDATE SET received_at=excluded.received_at,next_attempt=0,generation=generation+1').run(String(id),now());
      })();
    }catch{return res.status(503).json({error:'Webhook belum dapat disimpan.'});}
    res.json({received:true});
    // Acknowledge before API reads or Discord delivery: provider timeout is 3 seconds.
    void drain().catch(()=>{});
  }
  return {receive,drain,mount:app=>app.post('/webhooks/smscode',receive)};
}
function httpCode(value){const n=Number(value);return Number.isInteger(n)&&n>=100&&n<=599?n:'tidak diketahui';}
async function providerRequest(fetchImpl,url,options,stage){
  let res;
  try{res=await fetchImpl(url,{...options,signal:AbortSignal.timeout(15000)});}catch(e){
    const code=e?.cause?.code||e?.code;
    const reason=['TimeoutError','AbortError'].includes(e?.name)||code==='ETIMEDOUT'?'Koneksi melewati batas waktu 15 detik.':code==='ENOTFOUND'?'Alamat API provider tidak dapat ditemukan (DNS).':'Koneksi ke API provider gagal.';
    throw Error(stage+': '+reason+' Periksa koneksi Railway dan SMSCODE_API_BASE_URL.');
  }
  const status=httpCode(res.status),label=stage+' — API SMSCode HTTP '+status;
  if(!res.ok){
    const hint=status===401?'Periksa SMSCODE_API_TOKEN.':status===403?'Periksa izin API akun SMSCode.':status===429?'Batas permintaan provider tercapai. Tunggu sebelum mencoba kembali.':status>=500?'Provider mengembalikan kesalahan server. Coba lagi setelah layanan pulih.':'Permintaan ditolak. Periksa konfigurasi API provider.';
    throw Error(label+'. '+hint);
  }
  let result;try{result=await res.json();}catch{throw Error(label+'. Respons provider bukan JSON yang valid.');}
  if(result?.success!==true)throw Error(label+'. Provider melaporkan tes/permintaan tidak berhasil.'+(result?.data?.status_code!==undefined?' Pengiriman ke bot HTTP '+httpCode(result.data.status_code)+'.':''));
  return result;
}
function checkDelivery(result){
  const status=httpCode(result.data?.status_code);
  if(status!==200)throw Error('Tes webhook belum mendapat HTTP 200. Pengiriman SMSCode ke bot HTTP '+status+'. '+(status===401?'Periksa kesamaan secret webhook.':status===404?'Periksa path /webhooks/smscode pada domain publik Railway.':'Periksa domain publik HTTPS dan deployment Railway.'));
}
async function configureSMSCodeWebhook({env=process.env,fetchImpl=fetch}={}){
  const url=env.SMSCODE_WEBHOOK_URL,secret=env.SMSCODE_WEBHOOK_SECRET,token=env.SMSCODE_API_TOKEN;
  if(!url||!secret||!token)throw Error('Isi SMSCODE_WEBHOOK_URL, SMSCODE_WEBHOOK_SECRET, dan SMSCODE_API_TOKEN di Railway.');
  const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/webhooks/smscode'||parsed.search||parsed.hash)throw Error('URL harus HTTPS dan berakhir /webhooks/smscode.');
  const base=(env.SMSCODE_API_BASE_URL||'https://api.smscode.gg/v1').replace(/\/$/,'');
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  await providerRequest(fetchImpl,base+'/webhook',{method:'PATCH',headers,body:JSON.stringify({webhook_url:url,webhook_secret:secret})},'Simpan konfigurasi');
  const result=await providerRequest(fetchImpl,base+'/webhook/test',{method:'POST',headers},'Jalankan tes webhook');
  checkDelivery(result);
  return {status:200};
}
async function testSMSCodeWebhook({env=process.env,fetchImpl=fetch}={}){
  if(!env.SMSCODE_API_TOKEN||!env.SMSCODE_WEBHOOK_URL||!env.SMSCODE_WEBHOOK_SECRET)throw Error('Lengkapi SMSCODE_API_TOKEN, SMSCODE_WEBHOOK_URL, dan SMSCODE_WEBHOOK_SECRET di Railway.');
  const base=(env.SMSCODE_API_BASE_URL||'https://api.smscode.gg/v1').replace(/\/$/,''),headers={Authorization:'Bearer '+env.SMSCODE_API_TOKEN};
  const config=await providerRequest(fetchImpl,base+'/webhook',{headers},'Baca konfigurasi webhook');
  if(config.data?.webhook_url!==env.SMSCODE_WEBHOOK_URL)throw Error('URL webhook SMSCode belum sesuai Railway. Jalankan node smscode-webhook.js di Console Railway untuk mendaftarkannya.');
  if(config.data?.webhook_secret!==env.SMSCODE_WEBHOOK_SECRET)throw Error('Secret webhook SMSCode belum sesuai Railway. Jalankan node smscode-webhook.js di Console Railway untuk menyamakan konfigurasi.');
  const result=await providerRequest(fetchImpl,base+'/webhook/test',{method:'POST',headers},'Jalankan tes webhook');
  checkDelivery(result);
  return {status:200};
}
function createSMSCodeWebhookHandler({staff,runTest=()=>testSMSCodeWebhook(),now=()=>Date.now()}){
  let busy=false,last=-Infinity;
  return async i=>{
    if(i.customId!=='admin_smscode_webhook_test')return false;
    if(!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Tes webhook hanya untuk admin toko.'});return true;}
    if(busy||now()-last<60000){await i.reply({ephemeral:true,content:'Tes sedang berjalan atau baru dilakukan. Tunggu 60 detik sebelum mencoba lagi.'});return true;}
    await i.deferReply({ephemeral:true});busy=true;last=now();
    try{await runTest();await i.editReply({content:'✅ Tes Webhook SMSCode berhasil — HTTP 200. URL dan secret sesuai konfigurasi Railway. Tes ini tidak membeli nomor, mengubah saldo, atau mengirim OTP palsu. Untuk menguji pengiriman OTP ke pembeli, gunakan pesanan OTP sungguhan.'});}
    catch(e){await i.editReply({content:'❌ '+e.message});}finally{busy=false;}
    return true;
  };
}
if(require.main===module){
  require('dotenv').config();
  configureSMSCodeWebhook().then(()=>console.log('Webhook SMSCode tersimpan dan tes HTTP 200 berhasil.')).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={createSMSCodeWebhook,verifySignature,configureSMSCodeWebhook,testSMSCodeWebhook,createSMSCodeWebhookHandler};
