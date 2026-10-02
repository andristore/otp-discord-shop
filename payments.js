const {createHmac,timingSafeEqual,randomUUID}=require('node:crypto');
function validSignature(raw,signature,key) {
  if(!key || !Buffer.isBuffer(raw) || typeof signature!=='string' || !/^[a-f0-9]{64}$/i.test(signature))return false;
  return timingSafeEqual(createHmac('sha256',key).update(raw).digest(),Buffer.from(signature,'hex'));
}
function parseCustomerEmail(value) {
  const email=String(value || '').trim();
  if(email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Masukkan alamat email yang valid untuk tagihan QRIS.');
  return email;
}
function parseTopup(value,minimum=5000) {
  const raw=String(value).trim();const amount=Number(raw);
  if(!/^\d+$/.test(raw) || !Number.isSafeInteger(amount) || amount<minimum || amount>1000000)throw new Error(`Nominal QRIS harus bilangan bulat ${minimum.toLocaleString('id-ID')}–1.000.000 IDR.`);
  return amount;
}
function validateStatus(payment,status) {
  const fee=Number(status.fee_customer);const merchantFee=Number(status.fee_merchant);const total=Number(status.amount);
  const items=status.order_items;
  const subtotal=Array.isArray(items)?items.reduce((n,i)=>n+Number(i.price)*Number(i.quantity),0):NaN;
  if(status.merchant_ref!==payment.order_id || typeof status.reference!=='string' || !status.reference ||
    (payment.provider_ref && status.reference!==payment.provider_ref) || status.payment_method!==payment.channel ||
    !Number.isSafeInteger(fee) || fee<0 || !Number.isSafeInteger(merchantFee) || merchantFee<0 ||
    subtotal!==payment.amount || total!==payment.amount+fee ||
    (payment.total_charge!=null && (total!==payment.total_charge || fee!==payment.fee_customer || merchantFee!==payment.fee_merchant)) ||
    Number(status.amount_received)!==total-fee-merchantFee || !['UNPAID','PAID','FAILED','EXPIRED','REFUND'].includes(status.status))throw new Error('Data pembayaran tidak sesuai tagihan.');
  return status.status==='PAID';
}
function createPayments({db,fetchImpl=fetch,env=process.env,onSettled=async()=>{}}) {
  const apiKey=env.TRIPAY_API_KEY,privateKey=env.TRIPAY_PRIVATE_KEY,merchantCode=env.TRIPAY_MERCHANT_CODE;
  const gateway=env.PAYMENT_GATEWAY || 'tripay';
  if(!['tripay','midtrans'].includes(gateway))throw new Error('PAYMENT_GATEWAY harus tripay atau midtrans.');
  const production=env.TRIPAY_IS_PRODUCTION==='true';const configured=Boolean(apiKey && privateKey && merchantCode);
  const channel=env.TRIPAY_QRIS_CHANNEL || 'QRIS';
  if(!['QRIS','QRISC','QRIS2','QRIS_SHOPEEPAY'].includes(channel))throw new Error('TRIPAY_QRIS_CHANNEL tidak didukung. Gunakan kode channel QRIS aktif di akun TriPay.');
  db.exec(`CREATE TABLE IF NOT EXISTS topups(order_id TEXT PRIMARY KEY,discord_id TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'creating',qr_url TEXT,credited INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const columns=new Set(db.prepare('PRAGMA table_info(topups)').all().map(c=>c.name));
  for(const [name,type] of Object.entries({purpose:"TEXT NOT NULL DEFAULT 'topup'",gateway:"TEXT NOT NULL DEFAULT 'midtrans'",provider_ref:'TEXT',channel:'TEXT',total_charge:'INTEGER',fee_customer:'INTEGER',fee_merchant:'INTEGER',production:'INTEGER',paid_at:'TEXT'}))if(!columns.has(name))db.exec(`ALTER TABLE topups ADD COLUMN ${name} ${type}`);
  async function request(path,body,live=production) {
    if(!configured)throw new Error('QRIS TriPay belum dikonfigurasi oleh admin.');
    const base=live?'https://tripay.co.id/api':'https://tripay.co.id/api-sandbox';
    const response=await fetchImpl(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:'Bearer '+apiKey},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();
    if(!response.ok || result.success!==true || !result.data)throw new Error('TriPay belum dapat memproses permintaan. Periksa channel/konfigurasi atau cek tagihan sebelum mencoba lagi.');
    return result.data;
  }
  const normalize=s=>({UNPAID:'pending',PAID:'settlement',EXPIRED:'expire',FAILED:'failure',REFUND:'refund'})[s];
  function qrUrl(value) {if(!value)return null;const u=new URL(value);if(u.protocol!=='https:' || u.username || u.password)throw new Error('Alamat QR TriPay tidak valid.');return u.href;}
  const apply=db.transaction((status)=>{
    const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='tripay'").get(status.merchant_ref);
    if(!p)throw new Error('Tagihan tidak ditemukan.');const settled=validateStatus(p,status);
    db.prepare('UPDATE topups SET provider_ref=?,total_charge=?,fee_customer=?,fee_merchant=?,qr_url=COALESCE(?,qr_url) WHERE order_id=?').run(status.reference,Number(status.amount),Number(status.fee_customer),Number(status.fee_merchant),qrUrl(status.qr_url),p.order_id);
    if(!p.credited){
      db.prepare('UPDATE topups SET status=? WHERE order_id=?').run(normalize(status.status),p.order_id);
      if(settled){const changed=db.prepare('UPDATE topups SET credited=1,paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP) WHERE order_id=? AND credited=0').run(p.order_id);
        if(changed.changes && p.purpose==='topup')db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(p.discord_id,p.amount);
      }
    }
    return db.prepare('SELECT * FROM topups WHERE order_id=?').get(p.order_id);
  });
  async function refresh(orderId,userId,callbackReference) {
    const p=db.prepare('SELECT * FROM topups WHERE order_id=?').get(orderId);
    if(!p || (userId && p.discord_id!==userId))throw new Error('Tagihan tidak ditemukan.');
    if(p.gateway==='midtrans')return midtrans.refresh(orderId,userId);
    if(p.gateway!=='tripay')throw new Error('Gateway tagihan tidak didukung.');
    if(Boolean(p.production)!==production)throw new Error('Tagihan dibuat pada mode TriPay berbeda. Hubungi admin; jangan membayar ulang.');
    const reference=p.provider_ref || callbackReference;
    if(!reference)throw new Error('Referensi TriPay belum diterima. Tunggu callback atau minta admin memeriksa merchant_ref '+p.order_id+'. Jangan membuat pembayaran ulang dulu.');
    const status=await request('/transaction/detail?reference='+encodeURIComponent(reference),undefined,Boolean(p.production));
    validateStatus(p,status);
    const updated=apply(status);if(updated.credited && updated.purpose==='purchase' && status.status==='PAID')await onSettled(updated);return {...updated,providerStatus:status.status};
  }
  const active=userId=>db.prepare("SELECT * FROM topups WHERE discord_id=? AND gateway IN ('tripay','midtrans') AND credited=0 AND status IN ('creating','pending') ORDER BY created_at,rowid LIMIT 1").get(userId);
  function assertCanCreate(userId){const p=active(userId);if(p){const e=new Error('Masih ada tagihan QRIS aktif. Buka Tagihan Aktif untuk melanjutkan pembayaran; jangan membayar ulang.');e.code='ACTIVE_INVOICE';throw e;}}
  const reserve=db.transaction((orderId,userId,amount,purpose)=>{assertCanCreate(userId);db.prepare("INSERT INTO topups(order_id,discord_id,amount,purpose,gateway,channel,production) VALUES(?,?,?,?,'tripay',?,?)").run(orderId,userId,amount,purpose,channel,production?1:0);});
  const midtrans=require('./midtrans').createMidtrans({db,fetchImpl,env,onSettled,assertCanCreate});
  async function create(userId,amount,options={}) {
    if(gateway==='midtrans')return midtrans.create(userId,amount,options);
    if(!configured)throw new Error('QRIS TriPay belum dikonfigurasi oleh admin.');
    const purpose=options.purpose==='purchase'?'purchase':'topup';
    amount=parseTopup(amount,purpose==='purchase'?1000:5000);const email=parseCustomerEmail(options.email);
    const orderId=options.orderId || 'maboyy-'+randomUUID();
    reserve(orderId,userId,amount,purpose);
    const status=await request('/transaction/create',{method:channel,merchant_ref:orderId,amount,customer_name:String(options.name || 'Pembeli Hi, OTP Sms Virtual').slice(0,100),customer_email:email,
      order_items:[{name:purpose==='purchase'?'Pembelian Hi, OTP Sms Virtual':'Isi Saldo Hi, OTP Sms Virtual',price:amount,quantity:1}],expired_time:Math.floor(Date.now()/1000)+1200,
      signature:createHmac('sha256',privateKey).update(merchantCode+orderId+amount).digest('hex')});
    // Reuse the same strict checks for the charge response and subsequent detail responses.
    validateStatus(db.prepare('SELECT * FROM topups WHERE order_id=?').get(orderId),status);
    const p=apply(status);if(p.credited && p.purpose==='purchase')await onSettled(p);
    if(!p.qr_url)throw new Error('QR TriPay belum tersedia. Cek tagihan '+orderId+' sebelum membuat transaksi baru.');return p;
  }
  function mount(app) {
    midtrans.mount(app);
    app.post('/api/payments/tripay/callback',async(req,res)=>{
      if(!configured)return res.status(503).json({success:false,message:'Pembayaran belum aktif'});
      if(!validSignature(req.rawBody,req.get('X-Callback-Signature'),privateKey) || req.get('X-Callback-Event')!=='payment_status')return res.status(403).json({success:false,message:'Callback tidak valid'});
      const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='tripay'").get(req.body.merchant_ref);
      if(!p)return res.status(404).json({success:false,message:'Tagihan tidak ditemukan'});
      if(typeof req.body.reference!=='string' || (p.provider_ref && p.provider_ref!==req.body.reference))return res.status(403).json({success:false,message:'Referensi tidak sesuai'});
      try {await refresh(p.order_id,undefined,req.body.reference);res.json({success:true});}
      catch {res.status(502).json({success:false,message:'Konfirmasi TriPay belum tersedia; ulangi callback'});}
    });
  }
  return {create,refresh,mount,gateway,configured:gateway==='midtrans'?midtrans.configured:configured,production:gateway==='midtrans'?midtrans.production:production,canPoll:configured || midtrans.configured,active,assertCanCreate,
    get:(id,userId)=>db.prepare('SELECT * FROM topups WHERE order_id=? AND discord_id=?').get(id,userId),
    recent:userId=>db.prepare("SELECT * FROM topups WHERE discord_id=? AND purpose='topup' ORDER BY created_at DESC,rowid DESC LIMIT 5").all(userId)};
}
function createPaymentHandler({discord,payments,env=process.env,manualInstructions,adminIds}) {
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const money=v=>Number(v).toLocaleString('id-ID')+' IDR';
  return async function handlePayment(i) {
    const id=String(i.customId || '');
    if(!['shop_topup','topup_qris','topup_manual','topup_amount','topup_history'].includes(id) && !id.startsWith('topup_check:'))return false;
    if(id==='shop_topup') {
      await i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('💳 Isi Saldo • Hi, OTP Sms Virtual')
        .setDescription('Minimal isi saldo **5.000 IDR**.\n\n**QRIS Otomatis** — saldo masuk setelah pembayaran terverifikasi.\n**Manual** — hubungi admin dan kirim bukti pembayaran; saldo ditambahkan setelah diperiksa.')],components:[new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('topup_qris').setLabel('QRIS Otomatis').setStyle(ButtonStyle.Primary).setDisabled(!payments.configured),
          new ButtonBuilder().setCustomId('topup_manual').setLabel('Manual').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('active_invoice').setLabel('Tagihan Aktif').setStyle(ButtonStyle.Secondary))]});return true;
    }
    if(id==='topup_manual') {
      const admins=(adminIds?adminIds():(env.ADMIN_DISCORD_IDS || '').split(',').map(s=>s.trim()).filter(s=>/^\d{17,20}$/.test(s))).slice(0,5);
      const instructions=String(manualInstructions?manualInstructions():env.MANUAL_TOPUP_INSTRUCTIONS || '').trim().slice(0,1100);
      await i.reply({ephemeral:true,allowedMentions:{parse:[]},embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('💵 Isi Saldo Manual')
        .setDescription(`Minimal isi saldo **5.000 IDR**.\n\n1. Hubungi admin untuk meminta tujuan pembayaran dan konfirmasi nominal.\n2. Lakukan pembayaran sesuai petunjuk admin.\n3. Kirim bukti pembayaran dan ID Discord Anda kepada admin.\n4. Setelah pembayaran diperiksa, admin menambahkan saldo.\n\n**ID Discord Anda:** ${i.user.id}\n**Admin:** ${admins.length?admins.map(a=>`<@${a}>`).join(', '):'Hubungi pengelola toko.'}${instructions?'\n\n**Petunjuk pembayaran:**\n'+instructions:''}\n\nTekan Kirim Gambar Bukti untuk petunjuk upload langsung melalui /bukti. Admin memeriksa mutasi sebelum menyetujui. Tekan Status Pengajuan untuk melihat hasilnya.`)],components:[new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('shop_balance').setLabel('Cek Saldo').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('shop_topup').setLabel('Kembali').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('manual_upload').setLabel('Kirim Gambar Bukti').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('manual_request_list:0').setLabel('Status Pengajuan').setStyle(ButtonStyle.Secondary))]});return true;
    }
    if(!payments.configured && !id.startsWith('topup_check:') && id!=='topup_history') {await i.reply({ephemeral:true,content:'QRIS belum aktif. Admin perlu mengisi konfigurasi pembayaran. Anda tetap bisa memakai Isi Saldo → Manual.'});return true;}
    if(id==='topup_qris' && payments.active?.(i.user.id)){await i.reply({ephemeral:true,content:'Masih ada tagihan QRIS aktif. Lanjutkan tagihan sebelumnya.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('active_invoice').setLabel('Buka Tagihan Aktif').setStyle(ButtonStyle.Primary))]});return true;}
    if(id==='topup_qris') {
      await i.showModal(new ModalBuilder().setCustomId('topup_amount').setTitle('Isi Saldo QRIS • Hi, OTP Sms Virtual')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount')
          .setLabel('Nominal IDR (5.000–1.000.000)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('email').setLabel('Email untuk tagihan QRIS').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(254))));
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
        const p=await payments.create(i.user.id,parseTopup(i.fields.getTextInputValue('amount')),{email:i.fields.getTextInputValue('email'),name:i.user.username});
        await i.editReply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('💳 QRIS • Hi, OTP Sms Virtual')
          .setDescription(`Saldo masuk: **${money(p.amount)}**\nBiaya QRIS pembeli: **${money(p.fee_customer || 0)}**\nTotal bayar: **${money(p.total_charge)}**\n${p.production?'Bayar dengan memindai QRIS.':'MODE UJI — gunakan simulator '+(p.gateway==='midtrans'?'Midtrans':'TriPay')+'; bukan pembayaran nyata.'}\nSaldo masuk otomatis setelah pembayaran dikonfirmasi.`)
          .setImage(p.qr_url).setFooter({text:p.order_id})],components:[new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('topup_check:'+p.order_id).setLabel('Cek Pembayaran').setStyle(ButtonStyle.Success))]});
      }
    }catch(e){await i.editReply({content:e.message+' Hubungi admin jika status tagihan belum jelas.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('active_invoice').setLabel('Tagihan Aktif').setStyle(ButtonStyle.Secondary))]});}
    return true;
  };
}
module.exports={validSignature,parseTopup,parseCustomerEmail,validateStatus,createPayments,createPaymentHandler};
