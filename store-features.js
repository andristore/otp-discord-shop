const {createManualBalance}=require('./admin');
const REFUND_GUIDE='**Pembatalan & refund**\n• Pesanan dapat dibatalkan selama belum menerima OTP dan pembatalan diterima provider.\n• Setelah OTP diterima atau pesanan selesai, pembatalan tidak tersedia.\n• Refund harga produk masuk ke **saldo bot**, termasuk pembelian langsung QRIS; bukan ke rekening/e-wallet. Biaya QRIS tidak termasuk refund.\n• Pembayaran yang hasil pesanan providernya belum jelas diperiksa admin. Jangan membayar ulang.\n• Nomor virtual tidak menjamin aplikasi menerima nomor tersebut. Simpan ID pesanan saat meminta bantuan.';

function proofIdentity(value){
  let u;try{u=new URL(String(value).trim());}catch{throw new Error('Bukti harus berupa tautan HTTPS gambar bukti pembayaran.');}
  if(u.protocol!=='https:' || u.username || u.password || !['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname) || !u.pathname.startsWith('/attachments/') || !/\.(png|jpe?g|webp)$/i.test(u.pathname))throw new Error('Upload gambar bukti ke Discord, lalu salin tautan gambar (PNG/JPG/WebP).');
  return {url:u.href,key:u.pathname};
}
function createStoreFeatures({db,staff,sendDM,now=()=>Date.now()}){
  db.exec(`CREATE TABLE IF NOT EXISTS store_feature_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_feature_audit(id INTEGER PRIMARY KEY,admin_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS manual_topup_requests(id TEXT PRIMARY KEY,discord_id TEXT NOT NULL,amount INTEGER NOT NULL,proof_url TEXT NOT NULL,proof_key TEXT UNIQUE NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',admin_id TEXT,decision_note TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,decided_at TEXT,result_notified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS manual_topup_notifications(request_id TEXT NOT NULL,admin_id TEXT NOT NULL,PRIMARY KEY(request_id,admin_id));`);
  const credit=createManualBalance(db);
  const requireAdmin=id=>{if(!staff.isAdmin(id))throw new Error('Akses ditolak. Menu ini hanya untuk admin aktif.');};
  const maintenance=()=>db.prepare("SELECT value FROM store_feature_settings WHERE key='maintenance'").get()?.value==='1';
  function assertOpen(){if(maintenance())throw new Error('Toko sedang maintenance. Pembelian baru dihentikan sementara. Pesanan dan pembayaran sebelumnya tetap diproses.');}
  function setMaintenance(adminId,enabled){requireAdmin(adminId);db.transaction(()=>{db.prepare("INSERT INTO store_feature_settings(key,value) VALUES('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(enabled?'1':'0');db.prepare('INSERT INTO store_feature_audit(admin_id,action) VALUES(?,?)').run(adminId,enabled?'Aktifkan maintenance':'Nonaktifkan maintenance');})();}
  function submit({id,userId,amount,proof,note=''}){
    if(!/^\d{17,20}$/.test(userId) || !/^\d{17,20}$/.test(id) || !Number.isSafeInteger(amount) || amount<5000 || amount>1000000 || note.length>200)throw new Error('Nominal harus 5.000–1.000.000 IDR; catatan maksimal 200 karakter.');
    const evidence=proofIdentity(proof);
    return db.transaction(()=>{
      const previous=db.prepare('SELECT * FROM manual_topup_requests WHERE id=?').get(id);
      if(previous){if(previous.discord_id!==userId || previous.amount!==amount || previous.proof_key!==evidence.key || previous.note!==note)throw new Error('Pengajuan tidak sesuai.');return previous;}
      if(db.prepare('SELECT id FROM manual_topup_requests WHERE proof_key=?').get(evidence.key))throw new Error('Bukti ini sudah pernah diajukan. Periksa status pengajuan sebelumnya.');
      if(db.prepare("SELECT COUNT(*) n FROM manual_topup_requests WHERE discord_id=? AND status='pending'").get(userId).n>=3)throw new Error('Masih ada 3 pengajuan menunggu. Tunggu pemeriksaan admin.');
      db.prepare('INSERT INTO manual_topup_requests(id,discord_id,amount,proof_url,proof_key,note) VALUES(?,?,?,?,?,?)').run(id,userId,amount,evidence.url,evidence.key,note);
      return db.prepare('SELECT * FROM manual_topup_requests WHERE id=?').get(id);
    })();
  }
  function get(id,userId,adminId){if(adminId)requireAdmin(adminId);const r=db.prepare('SELECT * FROM manual_topup_requests WHERE id=?').get(id);if(!r || (!adminId && r.discord_id!==userId))throw new Error('Pengajuan tidak ditemukan.');return r;}
  function requests(userId,page=0,adminId){if(adminId)requireAdmin(adminId);const where=adminId?"status='pending'":'discord_id=?',args=adminId?[]:[userId];const count=db.prepare(`SELECT COUNT(*) n FROM manual_topup_requests WHERE ${where}`).get(...args).n;const pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);return {count,pages,page,rows:db.prepare(`SELECT * FROM manual_topup_requests WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 5 OFFSET ?`).all(...args,page*5)};}
  function decide({id,adminId,approve,note,confirmation}){
    requireAdmin(adminId);if(!note?.trim() || note.length>200 || (approve && confirmation!=='SUDAH DIPERIKSA'))throw new Error('Catatan wajib. Untuk persetujuan, ketik SUDAH DIPERIKSA setelah mencocokkan mutasi dan nominal.');
    return db.transaction(()=>{requireAdmin(adminId);const r=get(id,null,adminId);if(r.status!=='pending')return r;
      if(approve)credit({interactionId:'request:'+id,adminId,buyerId:r.discord_id,amount:r.amount,note:'Pengajuan '+id+': '+note.trim().slice(0,150)});
      db.prepare("UPDATE manual_topup_requests SET status=?,admin_id=?,decision_note=?,decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(approve?'approved':'rejected',adminId,note.trim(),id);
      db.prepare('INSERT INTO store_feature_audit(admin_id,action) VALUES(?,?)').run(adminId,(approve?'Setujui':'Tolak')+' saldo manual '+id);
      return get(id,null,adminId);
    })();
  }
  function repeat(id,userId){const r=db.prepare('SELECT * FROM orders WHERE id=? AND discord_id=?').get(Number(id),userId);if(!r)throw new Error('Pesanan tidak ditemukan.');const d=db.prepare('SELECT * FROM direct_purchases WHERE provider_order_id=? AND discord_id=?').get(r.provider_order_id,userId);return {productId:r.product_id,platformId:r.platform_id ?? d?.platform_id,countryId:r.country_id ?? d?.country_id,operatorId:r.operator_id ?? d?.operator_id ?? null};}
  function report(adminId,period){requireAdmin(adminId);if(!['day','month'].includes(period))throw new Error('Periode tidak valid.');const local=new Date(now()+7*3600000).toISOString();const from=period==='day'?local.slice(0,10):local.slice(0,7);return {...db.prepare(`SELECT COUNT(*) orders,COALESCE(SUM(amount),0) gross,COALESCE(SUM(CASE WHEN refunded=1 THEN amount ELSE 0 END),0) refunds,COALESCE(SUM(CASE WHEN refunded=0 THEN amount ELSE 0 END),0) net,COALESCE(SUM(CASE WHEN refunded=0 AND provider_amount IS NOT NULL THEN provider_amount ELSE 0 END),0) provider,COALESCE(SUM(CASE WHEN refunded=0 AND provider_amount IS NOT NULL THEN amount-provider_amount ELSE 0 END),0) margin,SUM(CASE WHEN refunded=0 AND provider_amount IS NULL THEN 1 ELSE 0 END) unknown FROM orders WHERE strftime('${period==='day'?'%Y-%m-%d':'%Y-%m'}',created_at,'+7 hours')=?`).get(from),period:from};}
  let polling=false;
  async function poll(){if(!sendDM || polling)return;polling=true;try{
    for(const adminId of staff.ids())for(const r of db.prepare("SELECT r.* FROM manual_topup_requests r WHERE r.status='pending' AND NOT EXISTS(SELECT 1 FROM manual_topup_notifications n WHERE n.request_id=r.id AND n.admin_id=?) ORDER BY r.created_at,r.id LIMIT 20").all(adminId)){
      if(db.prepare('SELECT 1 FROM manual_topup_notifications WHERE request_id=? AND admin_id=?').get(r.id,adminId))continue;
      try{await sendDM(adminId,`💵 Pengajuan isi saldo manual\nID: ${r.id}\nPembeli: ${r.discord_id}\nNominal: ${r.amount.toLocaleString('id-ID')} IDR\nBuka /admin → Saldo Pembeli → Pengajuan Manual. Cocokkan dengan mutasi rekening sebelum menyetujui.`);db.prepare('INSERT OR IGNORE INTO manual_topup_notifications VALUES(?,?)').run(r.id,adminId);}catch{}
    }
    for(const r of db.prepare("SELECT * FROM manual_topup_requests WHERE status<>'pending' AND result_notified=0 LIMIT 20").all())try{await sendDM(r.discord_id,`Pengajuan saldo ${r.id}: ${r.status==='approved'?'DISETUJUI — '+r.amount.toLocaleString('id-ID')+' IDR masuk ke saldo':'DITOLAK'}\nCatatan admin: ${r.decision_note}\nCek Isi Saldo → Manual → Status Pengajuan.`);db.prepare('UPDATE manual_topup_requests SET result_notified=1 WHERE id=?').run(r.id);}catch{}
  }finally{polling=false;}}
  return {maintenance,assertOpen,setMaintenance,submit,get,requests,decide,repeat,report,poll};
}

function createStoreFeatureHandler({discord,features,staff}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const money=n=>Number(n || 0).toLocaleString('id-ID')+' IDR';
  const row=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)));
  function modal(id,title,fields){const m=new ModalBuilder().setCustomId(id).setTitle(title);for(const [key,label,max,required=true]of fields)m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setRequired(required).setMaxLength(max).setStyle(TextInputStyle.Short)));return m;}
  return async i=>{
    const id=String(i.customId || '');const admin=id.startsWith('admin_store_');
    if(!admin && !id.startsWith('manual_request') && id!=='shop_refund_guide')return false;
    if(admin && !staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    try{
      if(id==='manual_request'){
        await i.showModal(modal('manual_request_submit','Ajukan Isi Saldo Manual',[['amount','Nominal IDR (5.000–1.000.000)',7],['proof','Tautan gambar bukti di Discord (HTTPS)',1000],['note','Catatan pengirim / waktu pembayaran',200,false]]));return true;
      }
      if(/^admin_store_(approve|reject):/.test(id)){
        const [action,requestId]=id.split(':');features.get(requestId,null,i.user.id);
        await i.showModal(modal(action.replace('approve','saveapprove').replace('reject','savereject')+':'+requestId,action.includes('approve')?'Setujui Saldo Manual':'Tolak Pengajuan',[['note','Catatan pemeriksaan / alasan',200],...(action.includes('approve')?[['confirmation','Ketik SUDAH DIPERIKSA',30]]:[])]));return true;
      }
      await i.deferReply({ephemeral:true});
      if(id==='shop_refund_guide'){await i.editReply({content:REFUND_GUIDE});return true;}
      if(id==='manual_request_submit'){
        const raw=i.fields.getTextInputValue('amount').trim();if(!/^\d+$/.test(raw))throw new Error('Nominal harus angka rupiah tanpa titik.');
        const r=features.submit({id:i.id,userId:i.user.id,amount:Number(raw),proof:i.fields.getTextInputValue('proof'),note:i.fields.getTextInputValue('note').trim()});
        await i.editReply({content:`✅ Pengajuan ${r.id} tersimpan. Nominal: ${money(r.amount)}. Saldo masuk setelah admin mencocokkan pembayaran dan menyetujui.`,components:[row([['manual_request_list:0','Status Pengajuan']])]});features.poll().catch(()=>{});return true;
      }
      if(id.startsWith('manual_request_list:') || id.startsWith('admin_store_requests:')){
        const r=features.requests(i.user.id,Number(id.split(':')[1]),admin?i.user.id:undefined),components=[];
        if(r.rows.length)components.push(row(r.rows.map(v=>[(admin?'admin_store_detail:':'manual_request_detail:')+v.id,`${money(v.amount)} • ${v.status} • ${v.id}`])));
        const prefix=admin?'admin_store_requests:':'manual_request_list:';
        const nav=row([[prefix+Math.max(0,r.page-1),'Sebelumnya'],[prefix+Math.min(r.pages-1,r.page+1),'Berikutnya'],[admin?'admin_balance_menu':'topup_manual','Kembali']]);nav.components[0].setDisabled(r.page===0);nav.components[1].setDisabled(r.page===r.pages-1);components.push(nav);
        await i.editReply({content:`**${admin?'Pengajuan Manual Menunggu':'Status Pengajuan Saya'}**\nHalaman ${r.page+1}/${r.pages} • ${r.count} pengajuan`,components});return true;
      }
      if(id.startsWith('manual_request_detail:') || id.startsWith('admin_store_detail:')){
        const r=features.get(id.split(':')[1],i.user.id,admin?i.user.id:undefined);
        await i.editReply({content:`Pengajuan: ${r.id}\nPembeli: ${r.discord_id}\nNominal: ${money(r.amount)}\nStatus: ${r.status}\nCatatan: ${r.note || '-'}\nBukti: ${r.proof_url}\nCatatan admin: ${r.decision_note || '-'}${admin?'\n\nPeriksa mutasi rekening/e-wallet, pengirim dan nominal. Gambar bukti saja tidak cukup untuk persetujuan.':''}`,allowedMentions:{parse:[]},components:[row(admin && r.status==='pending'?[[`admin_store_approve:${r.id}`,'Setujui'],[`admin_store_reject:${r.id}`,'Tolak'],['admin_store_requests:0','Kembali']]:[[admin?'admin_store_requests:0':'manual_request_list:0','Kembali']])]});return true;
      }
      if(/^admin_store_save(approve|reject):/.test(id)){
        const approve=id.startsWith('admin_store_saveapprove:');const r=features.decide({id:id.split(':')[1],adminId:i.user.id,approve,note:i.fields.getTextInputValue('note'),confirmation:approve?i.fields.getTextInputValue('confirmation'):''});
        await i.editReply({content:`Pengajuan ${r.id}: ${r.status}. ${r.status==='approved'?'Saldo sudah ditambahkan satu kali.':'Saldo tidak ditambahkan.'}`,components:[row([['admin_store_requests:0','Pengajuan Manual']])]});features.poll().catch(()=>{});return true;
      }
      if(id==='admin_store_tools'){
        await i.editReply({content:'**Laporan & Operasional**',components:[row([['admin_store_report:day','Laporan Hari Ini'],['admin_store_report:month','Laporan Bulan Ini'],['admin_store_maintenance','Maintenance'],['admin_transactions_menu','Kembali']])]});return true;
      }
      if(id.startsWith('admin_store_report:')){
        const r=features.report(i.user.id,id.split(':')[1]);await i.editReply({content:`**Laporan ${r.period} (WIB)**\nPesanan tercatat: ${r.orders}\nPenjualan kotor: ${money(r.gross)}\nRefund: ${money(r.refunds)}\nPenjualan setelah refund: ${money(r.net)}\nBiaya provider tercatat (tanpa order direfund): ${money(r.provider)}\nSelisih kotor tercatat: ${money(r.margin)}\nPesanan tanpa biaya provider: ${r.unknown || 0}\n\nSelisih kotor belum dikurangi biaya gateway, hosting, dan biaya lain. Topup saldo bukan penjualan. Refund dihitung pada periode pesanan dibuat.`,components:[row([['admin_store_tools','Kembali']])]});return true;
      }
      if(id==='admin_store_maintenance' || /^admin_store_maintenance:(on|off)$/.test(id)){
        if(id.includes(':'))features.setMaintenance(i.user.id,id.endsWith(':on'));
        await i.editReply({content:`Maintenance: **${features.maintenance()?'AKTIF':'NONAKTIF'}**\nPembelian baru ditahan saat aktif. OTP, pembatalan, saldo, dan tagihan yang sudah dibuat tetap tersedia.`,components:[row([[features.maintenance()?'admin_store_maintenance:off':'admin_store_maintenance:on',features.maintenance()?'Buka Toko':'Aktifkan Maintenance'],['admin_store_tools','Kembali']])]});return true;
      }
      throw new Error('Menu tidak dikenali.');
    }catch(e){const p={content:e.message,allowedMentions:{parse:[]}};if(i.deferred || i.replied)await i.editReply(p);else await i.reply({ephemeral:true,...p});return true;}
  };
}
module.exports={REFUND_GUIDE,proofIdentity,createStoreFeatures,createStoreFeatureHandler};
