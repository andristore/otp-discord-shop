const {buyerLabel,rememberBuyer,hydrateBuyers}=require('./buyer-profiles');
const {createManualBalance}=require('./admin');
const REFUND_GUIDE='**Pembatalan & refund**\n• Pesanan dapat dibatalkan selama belum menerima OTP dan pembatalan diterima provider.\n• Setelah OTP diterima atau pesanan selesai, pembatalan tidak tersedia.\n• Refund harga produk masuk ke **saldo bot**, termasuk pembelian langsung QRIS; bukan ke rekening/e-wallet. Biaya QRIS tidak termasuk refund.\n• Pembayaran yang hasil pesanan providernya belum jelas diperiksa admin. Jangan membayar ulang.\n• Nomor virtual tidak menjamin aplikasi menerima nomor tersebut. Simpan ID pesanan saat meminta bantuan.';

function proofIdentity(value){
  let u;try{u=new URL(String(value).trim());}catch{throw new Error('Bukti harus berupa tautan HTTPS gambar bukti pembayaran.');}
  if(u.protocol!=='https:' || u.username || u.password || !['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname) || !u.pathname.startsWith('/attachments/') || !/\.(png|jpe?g|webp)$/i.test(u.pathname))throw new Error('Upload gambar bukti ke Discord, lalu salin tautan gambar (PNG/JPG/WebP).');
  return {url:u.href,key:u.pathname};
}
function createStoreFeatures({db,staff,sendDM,resolveInfoChannel,now=()=>Date.now()}){
  db.exec(`CREATE TABLE IF NOT EXISTS store_feature_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS store_feature_audit(id INTEGER PRIMARY KEY,admin_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS manual_topup_requests(id TEXT PRIMARY KEY,discord_id TEXT NOT NULL,amount INTEGER NOT NULL,proof_url TEXT NOT NULL,proof_key TEXT UNIQUE NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',admin_id TEXT,decision_note TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,decided_at TEXT,result_notified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS manual_topup_notifications(request_id TEXT NOT NULL,admin_id TEXT NOT NULL,PRIMARY KEY(request_id,admin_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS store_info_channel(id INTEGER PRIMARY KEY CHECK(id=1),guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS store_info_posts(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,created_ms INTEGER NOT NULL,attempt_ms INTEGER NOT NULL DEFAULT 0,message_id TEXT);`);
  const credit=createManualBalance(db);
  const requireAdmin=id=>{if(!staff.isAdmin(id))throw new Error('Akses ditolak. Menu ini hanya untuk admin aktif.');};
  const maintenance=()=>db.prepare("SELECT value FROM store_feature_settings WHERE key='maintenance'").get()?.value==='1';
  function assertOpen(){if(maintenance())throw new Error('Toko sedang maintenance. Pembelian baru dihentikan sementara. Pesanan dan pembayaran sebelumnya tetap diproses.');}
  function setMaintenance(adminId,enabled){requireAdmin(adminId);db.transaction(()=>{const changed=maintenance()!==!!enabled;if(changed&&infoSetting()?.enabled)queueInfo(adminId,'maintenance',enabled?'🔧 Toko Maintenance':'✅ Toko Kembali Buka',enabled?'Pembelian baru dihentikan sementara. Pesanan, OTP, dan tagihan sebelumnya tetap diproses.':'Maintenance selesai. Pembelian baru tersedia kembali.');db.prepare("INSERT INTO store_feature_settings(key,value) VALUES('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(enabled?'1':'0');db.prepare('INSERT INTO store_feature_audit(admin_id,action) VALUES(?,?)').run(adminId,enabled?'Aktifkan maintenance':'Nonaktifkan maintenance');})();}
  const owner=id=>{requireAdmin(id);if(!staff.isOwner?.(id))throw Error('Hanya owner dapat mengatur channel informasi.');};
  const infoSetting=()=>db.prepare('SELECT * FROM store_info_channel WHERE id=1').get();
  function infoStatus(user){requireAdmin(user);return {...infoSetting(),pending:db.prepare("SELECT COUNT(*) n FROM store_info_posts WHERE state='queued'").get().n,failed:db.prepare("SELECT COUNT(*) n FROM store_info_posts WHERE state='queued' AND attempt_ms>0").get().n};}
  async function infoChannel(guild,channel){if(!resolveInfoChannel)throw Error('Pengiriman channel belum tersedia.');const c=await resolveInfoChannel(channel);if(!c||c.guildId!==guild||c.type!==0||!c.canInfo)throw Error('Gunakan channel teks dengan izin View Channel dan Send Messages untuk bot.');return c;}
  async function configureInfo(user,guild,channel){owner(user);if(!/^\d{17,20}$/.test(guild)||!/^\d{17,20}$/.test(channel))throw Error('Isi ID server dan channel Discord yang valid.');await infoChannel(guild,channel);owner(user);db.transaction(()=>{const old=infoSetting();if(old&&(old.guild_id!==guild||old.channel_id!==channel))db.prepare("UPDATE store_info_posts SET state='cancelled' WHERE state IN ('draft','queued')").run();db.prepare('INSERT INTO store_info_channel VALUES(1,?,?,1) ON CONFLICT(id) DO UPDATE SET guild_id=excluded.guild_id,channel_id=excluded.channel_id,enabled=1').run(guild,channel);db.prepare('INSERT INTO store_feature_audit(admin_id,action) VALUES(?,?)').run(user,'Atur channel informasi '+guild+'/'+channel);})();return infoStatus(user);}
  function toggleInfo(user){owner(user);const c=infoSetting();if(!c)throw Error('Atur channel terlebih dahulu.');db.prepare('UPDATE store_info_channel SET enabled=? WHERE id=1').run(c.enabled?0:1);db.prepare('INSERT INTO store_feature_audit(admin_id,action) VALUES(?,?)').run(user,c.enabled?'Nonaktifkan channel informasi':'Aktifkan channel informasi');return infoStatus(user);}
  function cleanupInfo(){db.prepare("DELETE FROM store_info_posts WHERE state IN ('sent','cancelled') AND created_ms<?").run(now()-30*86400000);db.prepare("UPDATE store_info_posts SET state='cancelled' WHERE state='draft' AND created_ms<?").run(now()-15*60000);}
  function queueInfo(user,kind,title,body){requireAdmin(user);cleanupInfo();if(db.prepare("SELECT COUNT(*) n FROM store_info_posts WHERE state='queued'").get().n>=20)throw Error('Antrean informasi penuh. Periksa izin channel sebelum mencoba kembali.');const id=require('node:crypto').randomUUID();db.prepare("INSERT INTO store_info_posts(id,admin_id,kind,title,body,state,created_ms) VALUES(?,?,?,?,?,'queued',?)").run(id,user,kind,title,body,now());return id;}
  function draftInfo(user,title,body){requireAdmin(user);cleanupInfo();const c=infoSetting();if(!c?.enabled)throw Error('Atur dan aktifkan channel informasi terlebih dahulu.');title=String(title).trim();body=String(body).trim();if(!title||title.length>100||!body||body.length>1500)throw Error('Judul 1–100 karakter dan isi 1–1.500 karakter.');if(db.prepare("SELECT COUNT(*) n FROM store_info_posts WHERE state='draft'").get().n>=20)throw Error('Terlalu banyak pratinjau. Tunggu 15 menit atau batalkan pratinjau.');const id=require('node:crypto').randomUUID();db.prepare("INSERT INTO store_info_posts(id,admin_id,kind,title,body,state,created_ms) VALUES(?,?,'announcement',?,?,'draft',?)").run(id,user,title,body,now());return db.prepare('SELECT * FROM store_info_posts WHERE id=?').get(id);}
  function confirmInfo(user,id,cancel=false){requireAdmin(user);cleanupInfo();return db.transaction(()=>{const r=db.prepare('SELECT * FROM store_info_posts WHERE id=? AND admin_id=?').get(id,user);if(!r)throw Error('Pratinjau tidak ditemukan.');if(r.state!=='draft')return r.state;if(cancel){db.prepare("UPDATE store_info_posts SET state='cancelled' WHERE id=?").run(id);return 'cancelled';}if(!infoSetting()?.enabled)throw Error('Channel informasi nonaktif.');if(db.prepare("SELECT COUNT(*) n FROM store_info_posts WHERE state='queued'").get().n>=20)throw Error('Antrean informasi penuh.');db.prepare("UPDATE store_info_posts SET state='queued' WHERE id=? AND state='draft'").run(id);db.prepare('INSERT INTO store_feature_audit(admin_id,action) VALUES(?,?)').run(user,'Kirim pengumuman '+id);return 'queued';})();}
  function testInfo(user){owner(user);if(!infoSetting()?.enabled)throw Error('Channel informasi nonaktif.');return queueInfo(user,'test','Tes Channel Informasi','Channel ini siap menerima informasi maintenance dan pengumuman toko.');}
  let infoBusy=false;
  async function pollInfo(){if(infoBusy||!resolveInfoChannel)return;infoBusy=true;try{cleanupInfo();const config=infoSetting();if(!config?.enabled)return;for(const r of db.prepare("SELECT * FROM store_info_posts WHERE state='queued' AND (attempt_ms=0 OR attempt_ms<=?) ORDER BY created_ms,id LIMIT 5").all(now()-60000)){
    if(r.kind==='announcement'&&!staff.isAdmin(r.admin_id)){db.prepare("UPDATE store_info_posts SET state='cancelled' WHERE id=?").run(r.id);continue;}
    db.prepare('UPDATE store_info_posts SET attempt_ms=? WHERE id=?').run(now(),r.id);
    try{const c=await infoChannel(config.guild_id,config.channel_id);const current=infoSetting();if(!current?.enabled||current.channel_id!==config.channel_id||current.guild_id!==config.guild_id)return;const msg=await c.send({content:r.title+'\n\n'+r.body,allowedMentions:{parse:[]}});db.prepare("UPDATE store_info_posts SET state='sent',message_id=? WHERE id=? AND state='queued'").run(msg?.id||null,r.id);}catch{}
  }}finally{infoBusy=false;}}
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
  async function poll(){await pollInfo();if(!sendDM || polling)return;polling=true;try{
    for(const adminId of staff.ids())for(const r of db.prepare("SELECT r.* FROM manual_topup_requests r WHERE r.status='pending' AND NOT EXISTS(SELECT 1 FROM manual_topup_notifications n WHERE n.request_id=r.id AND n.admin_id=?) ORDER BY r.created_at,r.id LIMIT 20").all(adminId)){
      if(db.prepare('SELECT 1 FROM manual_topup_notifications WHERE request_id=? AND admin_id=?').get(r.id,adminId))continue;
      try{await sendDM(adminId,`💵 Pengajuan isi saldo manual\nID: ${r.id}\nPembeli: ${buyerLabel(r.discord_id)}\nNominal: ${r.amount.toLocaleString('id-ID')} IDR\nBuka /admin → Pembayaran → Pengajuan Manual. Cocokkan dengan mutasi rekening sebelum menyetujui.`);db.prepare('INSERT OR IGNORE INTO manual_topup_notifications VALUES(?,?)').run(r.id,adminId);}catch{}
    }
    for(const r of db.prepare("SELECT * FROM manual_topup_requests WHERE status<>'pending' AND result_notified=0 LIMIT 20").all())try{await sendDM(r.discord_id,`Pembeli: ${buyerLabel(r.discord_id)}\nPengajuan saldo ${r.id}: ${r.status==='approved'?'DISETUJUI — '+r.amount.toLocaleString('id-ID')+' IDR masuk ke saldo':'DITOLAK'}\nCatatan admin: ${r.decision_note}\nCek Isi Saldo → Manual → Status Pengajuan.`);db.prepare('UPDATE manual_topup_requests SET result_notified=1 WHERE id=?').run(r.id);}catch{}
  }finally{polling=false;}}
  return {infoStatus,configureInfo,toggleInfo,draftInfo,confirmInfo,testInfo,pollInfo,maintenance,assertOpen,setMaintenance,submit,get,requests,decide,repeat,report,poll};
}

function createStoreFeatureHandler({discord,features,staff}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const money=n=>Number(n || 0).toLocaleString('id-ID')+' IDR';
  const row=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)));
  function modal(id,title,fields){const m=new ModalBuilder().setCustomId(id).setTitle(title);for(const [key,label,max,required=true]of fields)m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setRequired(required).setMaxLength(max).setStyle(max>1000?TextInputStyle.Paragraph:TextInputStyle.Short)));return m;}
  return async i=>{
    const id=String(i.customId || '');const admin=id.startsWith('admin_store_');
    if(!admin && !id.startsWith('manual_request') && id!=='shop_refund_guide')return false;
    if(admin && !staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    try{
      if(id==='admin_store_info_config'){
        if(!staff.isOwner?.(i.user.id))throw Error('Hanya owner dapat mengatur channel informasi.');
        await i.showModal(modal('admin_store_info_save','Atur Channel Informasi',[['guild','ID server tujuan',20],['channel','ID channel teks tujuan',20]]));return true;
      }
      if(id==='admin_store_info_compose'){await i.showModal(modal('admin_store_info_preview','Buat Pengumuman',[['title','Judul pengumuman',100],['body','Isi pengumuman',1500]]));return true;}
      if(id==='manual_request'){
        await i.showModal(modal('manual_request_submit','Ajukan Isi Saldo Manual',[['amount','Nominal IDR (5.000–1.000.000)',7],['proof','Tautan gambar bukti di Discord (HTTPS)',1000],['note','Catatan pengirim / waktu pembayaran',200,false]]));return true;
      }
      if(/^admin_store_(approve|reject):/.test(id)){
        const [action,requestId]=id.split(':');features.get(requestId,null,i.user.id);
        await i.showModal(modal(action.replace('approve','saveapprove').replace('reject','savereject')+':'+requestId,action.includes('approve')?'Setujui Saldo Manual':'Tolak Pengajuan',[['note','Catatan pemeriksaan / alasan',200],...(action.includes('approve')?[['confirmation','Ketik SUDAH DIPERIKSA',30]]:[])]));return true;
      }
      await i.deferReply({ephemeral:true});
      if(id==='admin_store_info_preview'){
        const r=features.draftInfo(i.user.id,i.fields.getTextInputValue('title'),i.fields.getTextInputValue('body'));
        await i.editReply({content:'**Pratinjau — belum dikirim**\n'+r.title+'\n\n'+r.body,allowedMentions:{parse:[]},components:[row([['admin_store_info_confirm:'+r.id,'Kirim ke Channel'],['admin_store_info_cancel:'+r.id,'Batalkan']])]});return true;
      }
      if(id.startsWith('admin_store_info_confirm:')||id.startsWith('admin_store_info_cancel:')){
        const state=features.confirmInfo(i.user.id,id.split(':')[1],id.startsWith('admin_store_info_cancel:'));await i.editReply({content:state==='queued'?'Pengumuman masuk antrean. Status kirim dapat dilihat di Channel Informasi.':'Status pengumuman: '+state,components:[row([['admin_store_info','Kembali']])]});features.pollInfo().catch(()=>{});return true;
      }
      if(['admin_store_info','admin_store_info_save','admin_store_info_toggle','admin_store_info_test'].includes(id)){
        if(id==='admin_store_info_save')await features.configureInfo(i.user.id,i.fields.getTextInputValue('guild').trim(),i.fields.getTextInputValue('channel').trim());
        if(id==='admin_store_info_toggle')features.toggleInfo(i.user.id);
        if(id==='admin_store_info_test'){features.testInfo(i.user.id);await features.pollInfo();}
        const c=features.infoStatus(i.user.id),choices=[['admin_store_info_compose','Buat Pengumuman']];if(staff.isOwner?.(i.user.id))choices.push(['admin_store_info_config','Atur Channel'],['admin_store_info_toggle',c.enabled?'Nonaktifkan Info':'Aktifkan Info'],['admin_store_info_test','Tes Channel']);
        await i.editReply({content:'**Channel Informasi**\nTujuan: '+(c.channel_id?'<#'+c.channel_id+'>':'Belum diatur')+'\nStatus: '+(c.enabled?'Aktif':'Nonaktif')+'\nAntrean: '+c.pending+' • Pernah gagal: '+c.failed+'\nPerubahan maintenance dikirim otomatis jika fitur aktif. Pengumuman lain memakai pratinjau dan konfirmasi.',allowedMentions:{parse:[]},components:[row(choices),row([['admin_store_maintenance','Kembali']])]});return true;
      }
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
        const nav=row([[prefix+(r.page-1),'Sebelumnya'],[prefix+(r.page+1),'Berikutnya'],[admin?'admin_payment_requests':'topup_manual','Kembali']]);nav.components[0].setDisabled(r.page===0);nav.components[1].setDisabled(r.page===r.pages-1);components.push(nav);
        await i.editReply({content:`**${admin?'Pengajuan Manual Menunggu':'Status Pengajuan Saya'}**\nHalaman ${r.page+1}/${r.pages} • ${r.count} pengajuan`,components});return true;
      }
      if(id.startsWith('manual_request_detail:') || id.startsWith('admin_store_detail:')){
        const r=features.get(id.split(':')[1],i.user.id,admin?i.user.id:undefined);
        await hydrateBuyers([r.discord_id]);
        await i.editReply({content:`Pengajuan: ${r.id}\nPembeli: ${buyerLabel(r.discord_id)}\nNominal: ${money(r.amount)}\nStatus: ${r.status}\nCatatan: ${r.note || '-'}\nBukti: ${r.proof_url}\nCatatan admin: ${r.decision_note || '-'}${admin?'\n\nPeriksa mutasi rekening/e-wallet, pengirim dan nominal. Gambar bukti saja tidak cukup untuk persetujuan.':''}`,allowedMentions:{parse:[]},components:[row(admin && r.status==='pending'?[[`admin_store_approve:${r.id}`,'Setujui'],[`admin_store_reject:${r.id}`,'Tolak'],['admin_store_requests:0','Kembali']]:[[admin?'admin_store_requests:0':'manual_request_list:0','Kembali']])]});return true;
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
        await i.editReply({content:`Maintenance: **${features.maintenance()?'AKTIF':'NONAKTIF'}**\nPembelian baru ditahan saat aktif. OTP, pembatalan, saldo, dan tagihan yang sudah dibuat tetap tersedia.`,components:[row([[features.maintenance()?'admin_store_maintenance:off':'admin_store_maintenance:on',features.maintenance()?'Buka Toko':'Aktifkan Maintenance'],['admin_store_info','Channel Informasi'],['admin_system_data','Kembali']])]});features.pollInfo().catch(()=>{});return true;
      }
      throw new Error('Menu tidak dikenali.');
    }catch(e){const p={content:e.message,allowedMentions:{parse:[]}};if(i.deferred || i.replied)await i.editReply(p);else await i.reply({ephemeral:true,...p});return true;}
  };
}
module.exports={REFUND_GUIDE,proofIdentity,createStoreFeatures,createStoreFeatureHandler};
