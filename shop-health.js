function createShopHealth({diagnostics,db,staff,payments,products,sendDM,inspectChannel,env=process.env,now=Date.now}){
  db.exec(`CREATE TABLE IF NOT EXISTS shop_health_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS overdue_notifications(kind TEXT NOT NULL,ref TEXT NOT NULL,admin_id TEXT NOT NULL,sent_at INTEGER NOT NULL,PRIMARY KEY(kind,ref,admin_id));`);
  const admin=id=>{if(!staff.isAdmin(id))throw Error('Akses ditolak.');};
  const read=(k,f)=>db.prepare('SELECT value FROM shop_health_settings WHERE key=?').get(k)?.value??f;
  const write=(k,v)=>db.prepare('INSERT INTO shop_health_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));
  function settings(user){admin(user);return {minutes:Number(read('minutes','15')),enabled:read('enabled','1')==='1'};}
  function configure(user,value){admin(user);if(!/^\d+$/.test(String(value))||Number(value)<5||Number(value)>1440)throw Error('Batas keterlambatan 5–1440 menit, tanpa titik.');write('minutes',value);}
  function toggle(user){const s=settings(user);write('enabled',s.enabled?'0':'1');}
  const lateQuery=`SELECT 'digital_pending' kind,id ref,discord_id,updated_at since FROM manual_product_orders WHERE state='pending'
    UNION ALL SELECT 'digital_dm',id,discord_id,updated_at FROM manual_product_orders WHERE state IN ('completed','refunded') AND notified=0
    UNION ALL SELECT 'otp_review',invoice_id,discord_id,created_at FROM direct_purchases WHERE state IN ('review','processing')
    UNION ALL SELECT 'paid_pending',m.id,m.discord_id,COALESCE(p.paid_at,m.updated_at) FROM manual_product_orders m JOIN topups p ON p.order_id=m.invoice_id WHERE m.state='awaiting_payment' AND p.credited=1`;
  function overdueQuery(){return 'SELECT * FROM ('+lateQuery+") WHERE julianday(since)<=julianday(?,'unixepoch')-?/1440.0";}
  function page(query,args,requested=0){const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get(...args).n,pages=Math.max(1,Math.ceil(count/5)),p=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);return {count,pages,page:p,rows:db.prepare(query+' ORDER BY kind,ref LIMIT 5 OFFSET ?').all(...args,p*5)};}
  function overdue(user,p=0){const s=settings(user);return {...page(overdueQuery(),[now()/1000,s.minutes],p),...s};}
  let notifying=false;
  async function poll(){if(notifying||!sendDM||read('enabled','1')!=='1')return;notifying=true;
    try {for(const id of staff.ids().filter(x=>staff.isAdmin(x))){const query='SELECT q.* FROM ('+overdueQuery()+') q WHERE NOT EXISTS(SELECT 1 FROM overdue_notifications n WHERE n.kind=q.kind AND n.ref=q.ref AND n.admin_id=?) ORDER BY q.since LIMIT 5';
      for(const o of db.prepare(query).all(now()/1000,Number(read('minutes','15')),id)){
        if(!staff.isAdmin(id))break;
        try{await sendDM(id,`⚠️ Pesanan perlu ditangani\n${label(o.kind)}\nID: ${o.ref}\nPembeli: ${o.discord_id}\nBuka /admin → Pembayaran → Pemeriksaan → Pesanan Terlambat. Tidak ada pemotongan saldo atau refund otomatis dari peringatan ini.`);db.prepare('INSERT OR IGNORE INTO overdue_notifications VALUES(?,?,?,?)').run(o.kind,o.ref,id,now());}catch{}
      }
    }}finally{notifying=false;}
  }
  let findingsQuery=`SELECT 'wallet' kind,discord_id ref,'Saldo negatif' reason FROM users WHERE balance<0
    UNION ALL SELECT 'digital',o.id,'Pesanan QRIS tidak cocok dengan pembayaran tercatat' FROM manual_product_orders o
      LEFT JOIN topups p ON p.order_id=o.invoice_id WHERE o.payment_method='qris' AND o.state IN ('pending','completed','refunded')
      AND (p.order_id IS NULL OR p.credited<>1 OR p.discord_id<>o.discord_id OR p.amount<>o.amount OR p.purpose<>'purchase')
    UNION ALL SELECT 'digital',o.id,'Pembayaran lunas, pesanan belum diproses' FROM manual_product_orders o JOIN topups p ON p.order_id=o.invoice_id WHERE o.state='awaiting_payment' AND p.credited=1
    UNION ALL SELECT 'invoice',p.order_id,'Pembayaran pembelian tidak terhubung ke pesanan' FROM topups p WHERE p.purpose='purchase' AND p.credited=1
      AND NOT EXISTS(SELECT 1 FROM manual_product_orders m WHERE m.invoice_id=p.order_id) AND NOT EXISTS(SELECT 1 FROM direct_purchases d WHERE d.invoice_id=p.order_id)
    UNION ALL SELECT 'otp',d.invoice_id,'Pesanan berhasil tanpa catatan OTP yang cocok' FROM direct_purchases d WHERE d.state='fulfilled' AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.provider_order_id=d.provider_order_id AND o.discord_id=d.discord_id)
    UNION ALL SELECT 'invoice',p.order_id,'Status lunas tetapi belum ditandai terverifikasi' FROM topups p WHERE p.status='settlement' AND p.credited=0
    UNION ALL SELECT 'otp',d.invoice_id,'Pesanan OTP tidak cocok dengan pembayaran tercatat' FROM direct_purchases d LEFT JOIN topups p ON p.order_id=d.invoice_id WHERE d.state IN ('processing','review','fulfilled','refunded') AND (p.order_id IS NULL OR p.credited<>1 OR p.discord_id<>d.discord_id OR p.amount<>d.amount OR p.purpose<>'purchase')
    UNION ALL SELECT 'stock',CAST(s.id AS TEXT),'Data terjual tidak terhubung ke pesanan selesai' FROM manual_product_stock s WHERE s.state='sold' AND NOT EXISTS(SELECT 1 FROM manual_product_orders o WHERE o.id=s.order_id AND o.state='completed')`;
  const topupColumns=db.prepare('PRAGMA table_info(topups)').all().map(c=>c.name);
  if(topupColumns.includes('provider_ref')&&topupColumns.includes('gateway'))findingsQuery+=" UNION ALL SELECT 'invoice',order_id,'Pembuatan invoice belum pasti; referensi gateway belum diterima' FROM topups WHERE gateway='tripay' AND status='creating' AND provider_ref IS NULL AND credited=0";
  function reconcile(user,p=0){admin(user);return page(findingsQuery,[],p);}
  async function readiness(user,guildId,channelId){admin(user);const dbOK=!!db.prepare('SELECT 1 ok').get().ok;
    let channel='Buka dari channel toko pada server tujuan.';if(guildId)try{channel=await inspectChannel(guildId,channelId);}catch{channel='Channel belum dapat diperiksa. Periksa izin bot.';}
    admin(user);
    const automatic=db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN p.quantity=0 OR NOT EXISTS(SELECT 1 FROM manual_product_stock s WHERE s.product_id=p.id AND s.state='available') THEN 1 ELSE 0 END) unready FROM manual_products p WHERE p.deleted=0 AND p.enabled=1 AND p.auto_enabled=1`).get();
    const issues=reconcile(user).count;let backup='Belum ada hasil tes pemulihan';if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='shop_tools_settings'").get()){const at=db.prepare("SELECT value FROM shop_tools_settings WHERE key='backup_verified_at'").get()?.value;const tested=db.prepare("SELECT value FROM shop_tools_settings WHERE key='backup_verified_file'").get()?.value,current=db.prepare("SELECT value FROM shop_tools_settings WHERE key='backup_last'").get()?.value;if(at)backup=(tested===current?'Backup terbaru lolos tes: ':'Salinan sebelumnya lolos tes: ')+at;}
    return {dbOK,backup,gateway:payments.configured?(payments.production?'Produksi — konfigurasi tersedia':'Sandbox / mode uji'):'Belum dikonfigurasi',provider:!!env.SMSCODE_API_TOKEN,webhook:!!(env.SMSCODE_WEBHOOK_URL&&env.SMSCODE_WEBHOOK_SECRET),channel,automatic:Number(automatic.total),unready:Number(automatic.unready||0),issues};
  }
  async function testDM(user){admin(user);await sendDM(user,'✅ Tes DM admin berhasil. Tidak ada pembelian, pemotongan saldo, atau perubahan stok.');}
  async function recoverInvoice(user,invoice,reference){admin(user);invoice=String(invoice||'').trim();reference=String(reference||'').trim();if(!/^[a-zA-Z0-9_-]{1,100}$/.test(invoice)||! /^[a-zA-Z0-9_-]{1,100}$/.test(reference))throw Error('Isi ID invoice dan referensi TriPay yang valid dari dashboard merchant.');
    const p=db.prepare("SELECT * FROM topups WHERE order_id=? AND gateway='tripay'").get(invoice);if(!p)throw Error('Invoice TriPay tidak ditemukan.');
    const updated=await payments.refresh(invoice,p.discord_id,reference);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_product_orders'").get()){
      const order=db.prepare('SELECT id FROM manual_product_orders WHERE invoice_id=? AND discord_id=?').get(invoice,p.discord_id);if(order&&products?.refresh)await products.refresh(p.discord_id,order.id);
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shop_admin_audit'").get())db.prepare('INSERT INTO shop_admin_audit(admin_id,action) VALUES(?,?)').run(user,'Verifikasi referensi TriPay untuk invoice '+invoice);
    return updated;
  }
  return {recoverInvoice,errors:user=>{admin(user);return diagnostics?.recent()||[];},settings,configure,toggle,overdue,poll,reconcile,readiness,testDM};
}
const label=k=>({paid_pending:'Pembayaran lunas, pesanan belum diproses',digital_pending:'Produk dibayar, menunggu admin',digital_dm:'Hasil produk / refund belum terkirim ke DM',otp_review:'Pembayaran OTP perlu diperiksa'}[k]||k);
function createHealthHandler({discord,model,staff}){
  const {ActionRowBuilder,ButtonBuilder,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const b=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style),row=(...v)=>new ActionRowBuilder().addComponents(...v);
  return async i=>{const id=String(i.customId||'');if(!id.startsWith('admin_healthcheck'))return false;
    if(!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    const user=i.user.id,home=b('admin_home','Menu Awal Admin');
    if(id==='admin_healthcheck_limit'){const s=model.settings(user);await i.showModal(new ModalBuilder().setCustomId('admin_healthcheck_limit_save').setTitle('Batas Pesanan Terlambat').addComponents(row(new TextInputBuilder().setCustomId('minutes').setLabel('Menit (5–1440)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(4).setValue(String(s.minutes)))));return true;}
    if(id==='admin_healthcheck_invoice'){const m=new ModalBuilder().setCustomId('admin_healthcheck_invoice_save').setTitle('Pulihkan Referensi TriPay');for(const [key,label]of [['invoice','ID invoice bot'],['reference','Referensi dari dashboard TriPay']])m.addComponents(row(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));await i.showModal(m);return true;}
    await i.deferReply({ephemeral:true});
    try {
      if(id==='admin_healthcheck_invoice_save'){const p=await model.recoverInvoice(user,i.fields.getTextInputValue('invoice'),i.fields.getTextInputValue('reference'));await i.editReply({content:'Referensi diperiksa langsung melalui API TriPay. Status: '+p.status+'. Tidak membuat tagihan baru.',components:[row(b('admin_healthcheck_reconcile:0','Kembali'),home)]});
      }else if(id==='admin_healthcheck_errors'){const rows=model.errors(user);await i.editReply({content:'**Catatan Gangguan Bot**\nMenyimpan 100 kelompok gangguan, menampilkan 10 terbaru. Token, secret dan isi akun tidak disimpan.\n\n'+(rows.map(r=>`${r.scope} • ${r.code} • ${r.count} kali\nReferensi: ${r.ref||'-'} • <t:${Math.floor(r.seen_at/1000)}:R>`).join('\n\n')||'Belum ada gangguan tercatat.'),allowedMentions:{parse:[]},components:[row(b('admin_healthcheck_errors','Perbarui'),b('admin_healthcheck','Kembali'),home)]});
      }else if(id.startsWith('admin_healthcheck_overdue:')||id==='admin_healthcheck_limit_save'||id==='admin_healthcheck_toggle'){
        if(id==='admin_healthcheck_limit_save')model.configure(user,i.fields.getTextInputValue('minutes'));if(id==='admin_healthcheck_toggle')model.toggle(user);
        const r=model.overdue(user,id.includes(':')?Number(id.split(':')[1]):0);
        await i.editReply({content:`**Pesanan Terlambat**\nPeringatan admin: ${r.enabled?'Aktif':'Nonaktif'} • batas ${r.minutes} menit\nHalaman ${r.page+1}/${r.pages} • ${r.count} pesanan\n\n`+r.rows.map(o=>`${label(o.kind)}\nID: ${o.ref}\nPembeli: ${o.discord_id}`).join('\n\n'),allowedMentions:{parse:[]},components:[row(b('admin_healthcheck_overdue:'+(r.page-1),'Sebelumnya').setDisabled(!r.page),b('admin_healthcheck_overdue:'+(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1),b('admin_healthcheck_overdue:'+r.page,'Perbarui')),row(b('admin_healthcheck_limit','Atur Batas'),b('admin_healthcheck_toggle',r.enabled?'Matikan Peringatan':'Aktifkan Peringatan'),b('admin_payment_requests','Proses Pesanan')),row(b('admin_payment_checks','Kembali'),home)]});
      }else if(id.startsWith('admin_healthcheck_reconcile:')){
        const r=model.reconcile(user,Number(id.split(':')[1]));await i.editReply({content:`**Pencocokan Catatan Transaksi**\nHalaman ${r.page+1}/${r.pages} • ${r.count} temuan\nPemeriksaan lokal; tidak mengubah saldo, status gateway, refund, atau stok.\n\n`+(r.count?r.rows.map(o=>`${o.reason}\nID: ${o.ref}`).join('\n\n'):'Tidak ada ketidakcocokan pada aturan yang diperiksa. Ini bukan rekonstruksi seluruh mutasi saldo atau konfirmasi langsung gateway.'),allowedMentions:{parse:[]},components:[row(b('admin_healthcheck_reconcile:'+(r.page-1),'Sebelumnya').setDisabled(!r.page),b('admin_healthcheck_reconcile:'+(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1),b('admin_healthcheck_reconcile:'+r.page,'Perbarui')),row(b('admin_healthcheck_invoice','Pulihkan Referensi TriPay')),row(b('admin_payment_issues','Periksa Pesanan'),b('admin_payment_checks','Kembali'),home)]});
      }else{
        let prefix='';if(id==='admin_healthcheck_dm'){await model.testDM(user);prefix='✅ Tes DM terkirim ke Anda.\n\n';}
        const r=await model.readiness(user,i.guildId,i.channelId);await i.editReply({content:prefix+`**Kesiapan Toko**\nBackup: ${r.backup}\nDatabase: ${r.dbOK?'OK':'Perlu diperiksa'}\nQRIS: ${r.gateway}\nAPI SMSCode: ${r.provider?'Konfigurasi tersedia':'Belum diisi'}\nWebhook SMSCode: ${r.webhook?'Konfigurasi tersedia':'Belum lengkap'}\nChannel: ${r.channel}\nProduk otomatis aktif: ${r.automatic} • stok/data belum siap: ${r.unready}\nKetidakcocokan transaksi: ${r.issues}\n\nKonfigurasi tersedia belum membuktikan koneksi/API/webhook berhasil. Gunakan tes webhook yang sudah ada dan lakukan transaksi uji sesuai mode gateway. Tes DM admin tidak menjamin DM semua pembeli terbuka.`,components:[row(b('admin_healthcheck','Perbarui'),b('admin_healthcheck_dm','Tes DM Admin',3),b('admin_smscode_webhook_test','Tes Webhook SMSCode')),row(b('admin_healthcheck_errors','Catatan Gangguan'),b('admin_system_data','Kembali'),home)]});
      }
    }catch(e){await i.editReply({content:id==='admin_healthcheck_dm'?'Tes DM gagal. Aktifkan DM dari anggota server, lalu coba lagi.':String(e.message||'Pemeriksaan gagal.').slice(0,1700),components:[row(b(id.includes('overdue')||id.includes('reconcile')||id.includes('limit')||id.includes('toggle')?'admin_payment_checks':'admin_system_data','Kembali'),home)],allowedMentions:{parse:[]}});}
    return true;
  };
}
module.exports={createShopHealth,createHealthHandler};
