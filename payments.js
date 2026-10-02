const {createHash,timingSafeEqual,randomUUID}=require('node:crypto');

function validSignature(body,serverKey) {
  if(!serverKey || !body || !['order_id','status_code','gross_amount','signature_key'].every(k=>typeof body[k]==='string'))return false;
  if(!/^[a-f0-9]{128}$/i.test(body.signature_key))return false;
  const expected=createHash('sha512').update(body.order_id+body.status_code+body.gross_amount+serverKey).digest();
  return timingSafeEqual(expected,Buffer.from(body.signature_key,'hex'));
}
function parseTopup(value) {
  const raw=String(value).trim();
  const amount=Number(raw);
  if(!/^\d+$/.test(raw) || !Number.isSafeInteger(amount) || amount<1000 || amount>1000000) {
    throw new Error('Nominal isi saldo harus bilangan bulat antara 1.000 dan 1.000.000 IDR.');
  }
  return amount;
}
function validateStatus(payment,status) {
  if(status.order_id!==payment.order_id || Number(status.gross_amount)!==payment.amount || status.currency!=='IDR' || status.payment_type!=='qris')throw new Error('Data pembayaran tidak sesuai tagihan.');
  return status.transaction_status==='settlement' && (!status.fraud_status || status.fraud_status==='accept');
}
function createPayments({db,fetchImpl=fetch,env=process.env,onSettled=async()=>{}}) {
  const serverKey=env.MIDTRANS_SERVER_KEY;
  const production=env.MIDTRANS_IS_PRODUCTION==='true';
  const base=production?'https://api.midtrans.com/v2':'https://api.sandbox.midtrans.com/v2';
  db.exec(`CREATE TABLE IF NOT EXISTS topups (
    order_id TEXT PRIMARY KEY,discord_id TEXT NOT NULL,amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'creating',qr_url TEXT,credited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  if(!db.prepare('PRAGMA table_info(topups)').all().some(c=>c.name==='purpose'))db.exec("ALTER TABLE topups ADD COLUMN purpose TEXT NOT NULL DEFAULT 'topup'");
  async function request(path,body) {
    if(!serverKey)throw new Error('Pembayaran QRIS belum dikonfigurasi oleh admin.');
    const r=await fetchImpl(base+path,{method:body?'POST':'GET',headers:{
      'Content-Type':'application/json',Accept:'application/json',
      Authorization:'Basic '+Buffer.from(serverKey+':').toString('base64')
    },...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const data=await r.json();
    if(!r.ok || !['200','201'].includes(String(data.status_code)))throw new Error('Provider pembayaran belum dapat memproses permintaan. Coba cek status atau hubungi admin.');
    return data;
  }
  const apply=db.transaction((status)=>{
    const payment=db.prepare('SELECT * FROM topups WHERE order_id=?').get(status.order_id);
    if(!payment)throw new Error('Tagihan tidak ditemukan.');
    const settled=validateStatus(payment,status);
    if(payment.credited)return {...payment,status:'settlement'};
    db.prepare('UPDATE topups SET status=? WHERE order_id=?').run(String(status.transaction_status),payment.order_id);
    if(settled) {
      const changed=db.prepare('UPDATE topups SET credited=1 WHERE order_id=? AND credited=0').run(payment.order_id);
      if(changed.changes && payment.purpose==='topup')db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(payment.discord_id,payment.amount);
    }
    return db.prepare('SELECT * FROM topups WHERE order_id=?').get(payment.order_id);
  });
  async function refresh(orderId,userId) {
    const payment=db.prepare('SELECT * FROM topups WHERE order_id=?').get(orderId);
    if(!payment || (userId && payment.discord_id!==userId))throw new Error('Tagihan tidak ditemukan.');
    const status=await request('/'+encodeURIComponent(orderId)+'/status');
    const action=status.actions?.find(a=>a.name==='generate-qr-code');
    if(action?.url){try{const u=new URL(action.url);if(u.protocol==='https:' && ['api.midtrans.com','api.sandbox.midtrans.com'].includes(u.hostname))db.prepare('UPDATE topups SET qr_url=? WHERE order_id=?').run(u.href,orderId);}catch {}}
    const updated=apply(status);
    if(updated.credited && updated.purpose==='purchase')await onSettled(updated);
    return updated;
  }
  async function create(userId,amount,options={}) {
    if(!serverKey)throw new Error('Pembayaran QRIS belum dikonfigurasi oleh admin.');
    const purpose=options.purpose==='purchase'?'purchase':'topup';
    if(purpose==='topup')amount=parseTopup(amount);
    else if(!Number.isSafeInteger(amount)||amount<1||amount>1000000)throw new Error('Harga QRIS harus 1–1.000.000 IDR.');
    const orderId=options.orderId || 'maboyy-'+randomUUID();
    db.prepare('INSERT INTO topups(order_id,discord_id,amount,purpose) VALUES(?,?,?,?)').run(orderId,userId,amount,purpose);
    const status=await request('/charge',{payment_type:'qris',transaction_details:{order_id:orderId,gross_amount:amount},qris:{acquirer:'gopay'}});
    validateStatus({order_id:orderId,amount},status);
    const action=status.actions?.find(a=>a.name==='generate-qr-code');
    let url;
    try {url=new URL(action?.url);}catch {throw new Error(`QR belum tersedia. Cek status tagihan ${orderId}.`);}
    if(url.protocol!=='https:' || !['api.midtrans.com','api.sandbox.midtrans.com'].includes(url.hostname))throw new Error('Alamat QR provider tidak valid.');
    db.prepare('UPDATE topups SET qr_url=?,status=? WHERE order_id=?').run(url.href,status.transaction_status,orderId);
    return db.prepare('SELECT * FROM topups WHERE order_id=?').get(orderId);
  }
  function mount(app) {
    app.post('/api/payments/midtrans/notification',async(req,res)=>{
      if(!serverKey)return res.status(503).json({error:'Pembayaran belum aktif'});
      if(!validSignature(req.body,serverKey))return res.status(403).json({error:'Signature tidak valid'});
      const payment=db.prepare('SELECT * FROM topups WHERE order_id=?').get(req.body.order_id);
      if(!payment)return res.status(404).json({error:'Tagihan tidak ditemukan'});
      try {
        // transaction_status is not included in the signature: read current status from Midtrans.
        await refresh(payment.order_id);
        res.json({ok:true});
      } catch {res.status(502).json({error:'Konfirmasi provider belum tersedia; ulangi notifikasi'});}
    });
  }
  return {create,refresh,mount,configured:Boolean(serverKey),production,
    get:(id,userId)=>db.prepare('SELECT * FROM topups WHERE order_id=? AND discord_id=?').get(id,userId),
    recent:userId=>db.prepare("SELECT * FROM topups WHERE discord_id=? AND purpose='topup' ORDER BY created_at DESC LIMIT 5").all(userId)};
}

function createPaymentHandler({discord,payments}) {
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const money=v=>Number(v).toLocaleString('id-ID')+' IDR';
  return async function handlePayment(i) {
    const id=String(i.customId || '');
    if(id!=='shop_topup' && id!=='topup_amount' && id!=='topup_history' && !id.startsWith('topup_check:'))return false;
    if(!payments.configured) {await i.reply({ephemeral:true,content:'QRIS belum aktif. Admin perlu mengisi konfigurasi pembayaran.'});return true;}
    if(id==='shop_topup') {
      await i.showModal(new ModalBuilder().setCustomId('topup_amount').setTitle('Isi Saldo OTP Maboyy')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount')
          .setLabel('Nominal IDR (1.000–1.000.000)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7))));
      return true;
    }
    await i.deferReply({ephemeral:true});
    try {
      if(id==='topup_history') {
        const rows=payments.recent(i.user.id);
        await i.editReply({content:rows.length?'Pilih tagihan untuk mengecek pembayaran.':'Belum ada tagihan isi saldo.',components:rows.length?[
          new ActionRowBuilder().addComponents(rows.map(p=>new ButtonBuilder().setCustomId('topup_check:'+p.order_id).setLabel(money(p.amount)+' • '+p.status).setStyle(ButtonStyle.Secondary)))
        ]:[]});
      } else if(id.startsWith('topup_check:')) {
        const p=await payments.refresh(id.slice('topup_check:'.length),i.user.id);
        await i.editReply({content:p.credited?`✅ Pembayaran diterima. ${money(p.amount)} sudah masuk ke saldo Anda.`:`Status pembayaran: ${p.status}. Saldo ditambahkan setelah pembayaran terkonfirmasi.`});
      } else {
        const p=await payments.create(i.user.id,parseTopup(i.fields.getTextInputValue('amount')));
        await i.editReply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('💳 QRIS • OTP Maboyy')
          .setDescription(`Nominal: **${money(p.amount)}**\n${payments.production?'Bayar dengan memindai QRIS.':'MODE UJI — gunakan simulator Midtrans; bukan untuk pembayaran nyata.'}\nSaldo masuk otomatis setelah pembayaran dikonfirmasi.`)
          .setImage(p.qr_url).setFooter({text:p.order_id})],components:[new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('topup_check:'+p.order_id).setLabel('Cek Pembayaran').setStyle(ButtonStyle.Success))]});
      }
    }catch(e){await i.editReply({content:e.message+' Gunakan Riwayat Isi Saldo untuk mengecek tagihan sebelum mencoba lagi.'});}
    return true;
  };
}
module.exports={validSignature,parseTopup,validateStatus,createPayments,createPaymentHandler};
