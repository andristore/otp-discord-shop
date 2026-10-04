function createQrisControl({db,env=process.env,now=Date.now}){
  db.exec(`CREATE TABLE IF NOT EXISTS qris_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS qris_health(key TEXT PRIMARY KEY,seen_ms INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS qris_alerts(owner_id TEXT PRIMARY KEY,seen_ms INTEGER NOT NULL);`);
  const enabled=()=>db.prepare("SELECT value FROM qris_settings WHERE key='enabled'").get()?.value!=='0';
  function setEnabled(value){db.prepare("INSERT INTO qris_settings(key,value) VALUES('enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value?'1':'0');}
  function record(key){if(!['api_ok','api_failed','callback_ok','callback_failed'].includes(key))return;db.prepare('INSERT INTO qris_health(key,seen_ms) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET seen_ms=excluded.seen_ms,count=count+1').run(key,now());}
  function snapshot(payments){return {enabled:enabled(),configured:payments.configured,production:payments.production,
    events:Object.fromEntries(db.prepare('SELECT * FROM qris_health').all().map(r=>[r.key,r])),
    totals:db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(credited),0) paid,COALESCE(SUM(CASE WHEN credited=1 THEN amount ELSE 0 END),0) amount,
      COALESCE(SUM(CASE WHEN credited=0 AND status IN ('creating','pending') THEN 1 ELSE 0 END),0) pending,
      COALESCE(SUM(CASE WHEN status='expire' THEN 1 ELSE 0 END),0) expired FROM topups WHERE gateway=? AND production=?`).get(payments.gateway,payments.production?1:0)};}
  let recovering=false;
  async function recover(payments){if(recovering)throw Error('Pemeriksaan QRIS sedang berjalan.');recovering=true;let checked=0,paid=0,failed=0;
    try{const rows=db.prepare("SELECT * FROM topups WHERE gateway=? AND production=? AND credited=0 AND status IN ('creating','pending') ORDER BY COALESCE(status_checked_ms,0),created_at LIMIT 5").all(payments.gateway,payments.production?1:0);
      for(const p of rows){checked++;try{const r=await payments.refresh(p.order_id,p.discord_id);if(r.credited)paid++;}catch{failed++;}}
      return {checked,paid,failed};
    }finally{recovering=false;}}
  let alerting=false;
  async function pollAlerts(payments,staff,sendDM){if(alerting)return;alerting=true;try{
    const failure=db.prepare("SELECT MAX(seen_ms) ms FROM qris_health WHERE key IN ('api_failed','callback_failed')").get().ms||0;
    const stuck=db.prepare("SELECT COUNT(*) n FROM topups WHERE gateway=? AND production=? AND credited=0 AND status IN ('creating','pending') AND julianday(created_at)<=julianday(?,'unixepoch')-15.0/1440").get(payments.gateway,payments.production?1:0,now()/1000).n;
    for(const owner of staff.ownerList()){
      const last=db.prepare('SELECT seen_ms FROM qris_alerts WHERE owner_id=?').get(owner.id)?.seen_ms||0;
      if(now()-last<3600000||(!(failure>last)&&!stuck))continue;
      try{await sendDM(owner.id,'⚠️ Pembayaran QRIS perlu diperiksa.\n'+(failure>last?'Ada permintaan API/notifikasi yang gagal.\n':'')+(stuck?stuck+' invoice belum terverifikasi setelah 15 menit.\n':'')+'Buka /admin → Sistem → Provider & Webhook → Pengaturan QRIS. Jangan menambah saldo atau membuat tagihan pengganti sebelum status terverifikasi.');
        db.prepare('INSERT INTO qris_alerts(owner_id,seen_ms) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET seen_ms=excluded.seen_ms').run(owner.id,now());
      }catch{/* Retry on next scheduled check if owner DM is unavailable. */}
    }
  }finally{alerting=false;}}
  return {enabled,setEnabled,record,snapshot,recover,pollAlerts};
}
function createQrisControlHandler({discord,payments,staff}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=discord;
  const button=(id,label)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Primary);
  return async i=>{
    if(!['admin_owner_qris','admin_owner_qris_enable','admin_owner_qris_disable','admin_owner_qris_recover'].includes(i.customId))return false;
    if(!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Pengaturan QRIS khusus owner.'});return true;}
    await i.deferReply({ephemeral:true});let notice='';
    try{
      if(i.customId==='admin_owner_qris_enable')payments.control.setEnabled(true);
      if(i.customId==='admin_owner_qris_disable')payments.control.setEnabled(false);
      if(i.customId==='admin_owner_qris_recover'){const r=await payments.control.recover(payments);notice=`Diperiksa: ${r.checked} • terverifikasi: ${r.paid} • gagal diperiksa: ${r.failed}. Pemeriksaan mengikuti jeda API; tidak membuat tagihan baru.\n\n`;}
      const h=payments.control.snapshot(payments),time=key=>h.events[key]?'<t:'+Math.floor(h.events[key].seen_ms/1000)+':R>':'Belum tercatat';
      await i.editReply({content:notice+`**Pengaturan QRIS — Owner**\nPembayaran baru: ${h.enabled?'Diizinkan':'Dihentikan'}\nKonfigurasi: ${h.configured?'Tersedia':'Belum lengkap'}\nMode: ${h.production?'Produksi':'Uji'}\nRespons API terakhir: ${time('api_ok')}\nCallback terverifikasi: ${time('callback_ok')}\nGangguan API: ${time('api_failed')}\nGangguan notifikasi: ${time('callback_failed')}\n\nInvoice: ${h.totals.total} • lunas: ${h.totals.paid} • tertunda: ${h.totals.pending} • kedaluwarsa: ${h.totals.expired}\nNominal terverifikasi: ${Number(h.totals.amount).toLocaleString('id-ID')} IDR\n\nKonfigurasi/API merespons bukan bukti layanan QRIS sudah disetujui. Menghentikan pembayaran baru tidak menghentikan verifikasi invoice lama. Peringatan dikirim ke DM owner, maksimal sekali per jam.`,allowedMentions:{parse:[]},components:[
        new ActionRowBuilder().addComponents(button('admin_owner_qris','Perbarui'),button(h.enabled?'admin_owner_qris_disable':'admin_owner_qris_enable',h.enabled?'Hentikan QRIS Baru':'Izinkan QRIS Baru'),button('admin_owner_qris_recover','Cek Invoice Tertunda')),
        new ActionRowBuilder().addComponents(button('admin_healthcheck_callbacks:0','Pantau Callback'),button('admin_healthcheck_reconcile:0','Cocokkan Transaksi'),button('admin_system_provider','Kembali'))]});
    }catch{await i.editReply({content:'Pemeriksaan QRIS belum berhasil. Jangan membayar ulang atau menambah saldo manual sebelum status dipastikan.',components:[new ActionRowBuilder().addComponents(button('admin_owner_qris','Kembali'))]});}
    return true;
  };
}
module.exports={createQrisControl,createQrisControlHandler};
