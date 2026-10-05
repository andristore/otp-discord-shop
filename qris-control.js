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
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const button=(id,label)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Primary);
  return async i=>{
    const dokuIds=['admin_owner_qris_doku','admin_owner_qris_doku_inspect','admin_owner_qris_doku_process','admin_owner_qris_doku_inspect_save','admin_owner_qris_doku_process_save'];
    if(!['admin_owner_qris','admin_owner_qris_enable','admin_owner_qris_disable','admin_owner_qris_recover',...dokuIds].includes(i.customId))return false;
    if(!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Pengaturan QRIS khusus owner.'});return true;}
    if(['admin_owner_qris_doku_inspect','admin_owner_qris_doku_process'].includes(i.customId)){
      await i.showModal(new ModalBuilder().setCustomId(i.customId+'_save').setTitle(i.customId.endsWith('_process')?'Verifikasi & Proses Invoice':'Periksa Invoice DOKU').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('invoice').setLabel('ID invoice yang tercatat di bot').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64))));return true;
    }
    await i.deferReply({ephemeral:true});let notice='';
    try{
      if(!staff.isOwner(i.user.id))throw Error('Akses owner sudah dicabut.');
      if(dokuIds.includes(i.customId)){
        if(i.customId.endsWith('_save')){
          const invoice=i.fields.getTextInputValue('invoice').trim();if(!/^[a-zA-Z0-9_-]{1,64}$/.test(invoice))throw Error('ID invoice tidak valid.');
          if(i.customId.includes('_inspect_')){const r=await payments.inspectDoku(invoice);notice='**Hasil pemeriksaan**\nInvoice: '+r.order_id+'\nStatus: '+(r.waiting?'Menunggu jeda API • <t:'+Math.ceil(r.retryAt/1000)+':R>':r.status)+'\nNominal: '+r.amount.toLocaleString('id-ID')+' IDR\nPemeriksaan ini tidak menambah saldo atau mengirim pesanan.\n\n';}
          else{
            // Resolve from this merchant's DOKU invoice, never from buyer-supplied amounts.
            const r=await payments.inspectDokuLocal(invoice);
            if(!staff.isOwner(i.user.id))throw Error('Akses owner sudah dicabut.');
            const p=await payments.refresh(invoice,r.discord_id);
            notice='**Verifikasi & Proses**\nInvoice: '+invoice+'\n'+(p.provider_status==='REFUNDED'?'Refund perlu dicocokkan dengan saldo/pesanan.':p.credited?'✅ Pembayaran terverifikasi. Saldo atau pengiriman mengikuti jenis invoice.':p.nextCheckMs?'Menunggu jeda API • <t:'+Math.ceil(p.nextCheckMs/1000)+':R>':'Status: '+p.status+' • belum ada pembayaran terverifikasi.')+'\n\n';
          }
        }
        if(!staff.isOwner(i.user.id))throw Error('Akses owner sudah dicabut.');
        const h=payments.dokuHealth(),time=v=>v?'<t:'+Math.floor(v/1000)+':R>':'Belum tercatat';
        await i.editReply({content:notice+'**Alur DOKU QRIS — Owner**\nGateway tagihan baru: '+(payments.gateway==='doku'?'DOKU':'Gateway lain')+'\nCredential Checkout: '+(h.configured?'Tersedia':'Belum lengkap')+'\nMode: '+(h.production?'Produksi':'Sandbox • QRIS tidak tersedia')+'\nCallback: '+(h.callbackUrl||'https://DOMAIN-PUBLIK-BOT'+h.callbackPath)+'\n'+(!h.publicUrlValid?'DOKU_PUBLIC_BASE_URL tidak valid; gunakan origin HTTPS.\n':'')+'API terakhir: '+h.apiCode+' • '+time(h.lastAPI)+'\nCallback: '+h.callbackCode+' • '+time(h.lastCallback)+'\n\n1. Pastikan QRIS berstatus ACTIVE di DOKU.\n2. Isi credential Checkout di Variables hosting.\n3. Pasang URL callback di pengaturan QR Payment DOKU.\n4. Pembeli membuka Bayar QRIS, membayar, lalu Cek Pembayaran.\n\nPeriksa Invoice hanya membaca status. Verifikasi & Proses dapat menambah saldo atau melanjutkan pesanan sesudah pembayaran sah. Jeda API minimal 60 detik per invoice; callback sah diproses langsung. Key tersedia belum membuktikan QRIS aktif.',allowedMentions:{parse:[]},components:[new ActionRowBuilder().addComponents(button('admin_owner_qris_doku_inspect','Periksa Invoice'),button('admin_owner_qris_doku_process','Verifikasi & Proses')),new ActionRowBuilder().addComponents(button('admin_owner_qris_doku','Perbarui'),button('admin_owner_qris','Kembali'))]});return true;
      }
      if(i.customId==='admin_owner_qris_enable')payments.control.setEnabled(true);
      if(i.customId==='admin_owner_qris_disable')payments.control.setEnabled(false);
      if(i.customId==='admin_owner_qris_recover'){const r=await payments.control.recover(payments);notice=`Diperiksa: ${r.checked} • terverifikasi: ${r.paid} • gagal diperiksa: ${r.failed}. Pemeriksaan mengikuti jeda API; tidak membuat tagihan baru.\n\n`;}
      const h=payments.control.snapshot(payments),time=key=>h.events[key]?'<t:'+Math.floor(h.events[key].seen_ms/1000)+':R>':'Belum tercatat';
      await i.editReply({content:notice+`**Pengaturan QRIS — Owner**\nPembayaran baru: ${h.enabled?'Diizinkan':'Dihentikan'}\nKonfigurasi: ${h.configured?'Tersedia':'Belum lengkap'}\nMode: ${h.production?'Produksi':'Uji'}\nRespons API terakhir: ${time('api_ok')}\nCallback terverifikasi: ${time('callback_ok')}\nGangguan API: ${time('api_failed')}\nGangguan notifikasi: ${time('callback_failed')}\n\nInvoice: ${h.totals.total} • lunas: ${h.totals.paid} • tertunda: ${h.totals.pending} • kedaluwarsa: ${h.totals.expired}\nNominal terverifikasi: ${Number(h.totals.amount).toLocaleString('id-ID')} IDR\n\nKonfigurasi/API merespons bukan bukti layanan QRIS sudah disetujui. Menghentikan pembayaran baru tidak menghentikan verifikasi invoice lama. Peringatan dikirim ke DM owner, maksimal sekali per jam.`,allowedMentions:{parse:[]},components:[
        new ActionRowBuilder().addComponents(button('admin_owner_qris','Perbarui'),button(h.enabled?'admin_owner_qris_disable':'admin_owner_qris_enable',h.enabled?'Hentikan QRIS Baru':'Izinkan QRIS Baru'),button('admin_owner_qris_recover','Cek Invoice Tertunda'),...(payments.dokuHealth?[button('admin_owner_qris_doku','Alur DOKU')]:[])),
        new ActionRowBuilder().addComponents(button('admin_healthcheck_callbacks:0','Pantau Callback'),button('admin_healthcheck_reconcile:0','Cocokkan Transaksi'),button('admin_system_provider','Kembali'))]});
    }catch{await i.editReply({content:'Pemeriksaan QRIS belum berhasil. Jangan membayar ulang atau menambah saldo manual sebelum status dipastikan.',components:[new ActionRowBuilder().addComponents(button('admin_owner_qris','Kembali'))]});}
    return true;
  };
}
module.exports={createQrisControl,createQrisControlHandler};
