function validateAttachment(a){
  if(!a || !['image/png','image/jpeg','image/webp'].includes(a.contentType) || !Number.isSafeInteger(a.size) || a.size<1 || a.size>8*1024*1024)throw new Error('Pilih gambar PNG/JPG/WebP maksimal 8 MB.');
  require('./store-features').proofIdentity(a.url);return a.url;
}
function proofUploadModal(native=true){
  if(!native)return {custom_id:'manual_request_submit',title:'Kirim Bukti Pembayaran',components:[
    ['amount','Nominal IDR (minimal 5000)',7,true],['proof','Tautan gambar bukti di Discord',1000,true],['note','Catatan pengirim / waktu pembayaran',200,false]
  ].map(([custom_id,label,max_length,required])=>({type:1,components:[{type:4,custom_id,label,style:1,max_length,required}]}))};
  return {custom_id:'manual_upload_submit',title:'Kirim Bukti Pembayaran',components:[
    {type:18,label:'Nominal IDR (minimal 5000, tanpa titik)',component:{type:4,custom_id:'amount',style:1,max_length:7,required:true}},
    {type:18,label:'Gambar bukti pembayaran',description:'PNG/JPG/WebP maksimal 8 MB. Saldo masuk setelah admin memeriksa pembayaran.',component:{type:19,custom_id:'gambar',min_values:1,max_values:1,required:true}},
    {type:18,label:'Catatan pengirim / waktu pembayaran',component:{type:4,custom_id:'note',style:2,max_length:200,required:false}}
  ]};
}
function createEfficiency({db,staff}){
  db.exec(`CREATE TABLE IF NOT EXISTS buyer_favorites(id INTEGER PRIMARY KEY,discord_id TEXT NOT NULL,app TEXT NOT NULL,country TEXT NOT NULL,operator TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(discord_id,app,country,operator));`);
  function save(user,q){
    if(q.platformId==null || q.countryId==null)throw new Error('Pilih aplikasi dan negara melalui Beli OTP dahulu.');
    const app=String(q.platformId),country=String(q.countryId),operator=q.operatorId==null?'any':String(q.operatorId);
    return db.transaction(()=>{const existing=db.prepare('SELECT * FROM buyer_favorites WHERE discord_id=? AND app=? AND country=? AND operator=?').get(user,app,country,operator);if(existing)return existing;
      if(db.prepare('SELECT COUNT(*) n FROM buyer_favorites WHERE discord_id=?').get(user).n>=20)throw new Error('Maksimal 20 favorit. Hapus favorit lama terlebih dahulu.');
      const r=db.prepare('INSERT INTO buyer_favorites(discord_id,app,country,operator,name) VALUES(?,?,?,?,?)').run(user,app,country,operator,String(q.name).slice(0,120));return favorite(user,r.lastInsertRowid);
    })();
  }
  function favorite(user,id){const f=db.prepare('SELECT * FROM buyer_favorites WHERE id=? AND discord_id=?').get(Number(id),user);if(!f)throw new Error('Favorit tidak ditemukan.');return f;}
  function remove(user,id){favorite(user,id);db.prepare('DELETE FROM buyer_favorites WHERE id=? AND discord_id=?').run(Number(id),user);}
  function favorites(user,page=0){const count=db.prepare('SELECT COUNT(*) n FROM buyer_favorites WHERE discord_id=?').get(user).n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);return {page,pages,count,rows:db.prepare('SELECT * FROM buyer_favorites WHERE discord_id=? ORDER BY id DESC LIMIT 5 OFFSET ?').all(user,page*5)};}
  const activeWhere="discord_id=? AND refunded=0 AND UPPER(COALESCE(status,'')) NOT IN ('CANCELED','CANCELLED','COMPLETED','EXPIRED','FAILED','REFUNDED')";
  function activeOrders(user,page=0){const count=db.prepare('SELECT COUNT(*) n FROM orders WHERE '+activeWhere).get(user).n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);return {page,pages,count,rows:db.prepare('SELECT * FROM orders WHERE '+activeWhere+' ORDER BY CASE WHEN otp IS NULL OR otp=\'\' THEN 0 ELSE 1 END,id DESC LIMIT 5 OFFSET ?').all(user,page*5)};}
  function order(user,id){const r=db.prepare('SELECT * FROM orders WHERE id=? AND discord_id=?').get(Number(id),user);if(!r)throw new Error('Pesanan tidak ditemukan.');return r;}
  function summary(user){
    if(!staff.isAdmin(user))throw new Error('Akses ditolak.');
    const hasTable=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const digital=hasTable('manual_product_orders'),stock=hasTable('manual_products')&&hasTable('manual_product_stock');
    return {
      manual:db.prepare("SELECT COUNT(*) n FROM manual_topup_requests WHERE status='pending'").get().n,
      review:db.prepare("SELECT COUNT(*) n FROM direct_purchases WHERE state IN ('review','resolving')").get().n,
      invoices:db.prepare("SELECT COUNT(*) n FROM topups WHERE gateway IN ('tripay','midtrans') AND credited=0 AND status IN ('creating','pending')").get().n,
      processing:digital?db.prepare("SELECT COUNT(*) n FROM manual_product_orders WHERE state='pending'").get().n:0,
      delivery:digital?db.prepare("SELECT COUNT(*) n FROM manual_product_orders WHERE state='completed' AND notified=0").get().n:0,
      lowStock:stock?db.prepare("SELECT COUNT(*) n FROM manual_products p WHERE p.deleted=0 AND p.enabled=1 AND ((p.quantity IS NOT NULL AND p.quantity<=3) OR (p.auto_enabled=1 AND (SELECT COUNT(*) FROM manual_product_stock s WHERE s.product_id=p.id AND s.state='available')<=3))").get().n:0
    };
  }
  return {save,favorite,remove,favorites,activeOrders,order,summary};
}
function createEfficiencyHandler({discord,model,commerce,payments,features,staff,smscode,operations}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder}=discord;
  const row=xs=>new ActionRowBuilder().addComponents(...xs.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0,80)).setStyle(ButtonStyle.Secondary)));
  const money=n=>Number(n || 0).toLocaleString('id-ID')+' IDR';
  const nav=(prefix,r,back)=>{const n=row([[prefix+(r.page-1),'Sebelumnya'],[prefix+(r.page+1),'Berikutnya'],[back,'Kembali']]);n.components[0].setDisabled(r.page===0);n.components[1].setDisabled(r.page===r.pages-1);return n;};
  return async i=>{
    const id=String(i.customId || ''),upload=i.isChatInputCommand?.() && i.commandName==='bukti';
    if(!upload && !/^(favorites(?::|$)|favorite_(save|detail|delete):|shop_orders$|active_orders:|active_order:|active_invoice$|manual_upload$|manual_upload_submit$|admin_eff_summary$)/.test(id))return false;
    if(id==='admin_eff_summary' && !staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    if(id==='manual_upload'){
      try{await i.showModal(proofUploadModal(typeof discord.ModalSubmitFields?.prototype?.getUploadedFiles==='function'));}
      catch{await i.reply({ephemeral:true,content:'Form upload belum dapat dibuka. Gunakan formulir tautan bukti pembayaran.',components:[row([['manual_request','Kirim Tautan Bukti'],['topup_manual','Kembali']])]});}
      return true;
    }
    await i.deferReply({ephemeral:true});
    try{
      const user=i.user.id;
      if(upload || id==='manual_upload_submit'){
        let attachment,amount,note;
        if(upload){attachment=i.options.getAttachment('gambar',true);amount=i.options.getInteger('nominal',true);note=i.options.getString('catatan')?.trim() || '';}
        else {const files=i.fields.getUploadedFiles('gambar',true);if(!files || files.size!==1)throw Error('Pilih tepat satu gambar bukti pembayaran.');attachment=files.first();const raw=i.fields.getTextInputValue('amount').trim();if(!/^\d+$/.test(raw))throw Error('Nominal rupiah harus bilangan bulat tanpa titik/koma.');amount=Number(raw);note=i.fields.getTextInputValue('note').trim();}
        const proof=validateAttachment(attachment);
        const r=features.submit({id:i.id,userId:user,amount,proof,note});
        await i.editReply({content:`✅ Bukti gambar diterima. Pengajuan ${r.id}: ${money(r.amount)}. Saldo masuk setelah admin memeriksa mutasi dan menyetujui.`,components:[row([['manual_request_list:0','Status Pengajuan']])]});features.poll().catch(()=>{});
      }else if(id.startsWith('favorite_save:')){
        const f=model.save(user,commerce.checkout(user,id.split(':')[1]));await i.editReply({content:'⭐ Layanan disimpan sebagai favorit. Harga dan stok diperiksa kembali saat dibuka.',components:[row([['favorite_open:'+f.id,'Buka Favorit'],['favorites','Favorit Saya']])]});
      }else if(id==='favorites' || id.startsWith('favorites:') || id.startsWith('favorite_delete:')){
        if(id.startsWith('favorite_delete:'))model.remove(user,id.split(':')[1]);
        const r=model.favorites(user,id.startsWith('favorites:')?Number(id.split(':')[1]):0),components=[];
        if(r.rows.length)components.push(row(r.rows.map(f=>['favorite_detail:'+f.id,f.name])));components.push(nav('favorites:',r,'shop_products'));
        await i.editReply({content:`**⭐ Favorit Saya**\n${r.count} favorit • halaman ${r.page+1}/${r.pages}\n${r.count?'Pilih favorit untuk membeli atau menghapusnya.':'Simpan favorit dari halaman Konfirmasi Pembelian.'}`,components});
      }else if(id.startsWith('favorite_detail:')){
        const f=model.favorite(user,id.split(':')[1]);await i.editReply({content:`⭐ **${f.name}**\nNegara ID: ${f.country} • operator: ${f.operator==='any'?'Any':f.operator}\nBuka untuk melihat harga dan stok terbaru.`,components:[row([['favorite_open:'+f.id,'Lihat Harga & Stok'],['favorite_delete:'+f.id,'Hapus Favorit'],['favorites','Kembali'],['tool_stock:'+f.id,'Notifikasi Stok On/Off']])]});
      }else if(id==='shop_orders'){
        const r=model.activeOrders(user);await i.editReply({content:`**📦 Pesanan Saya**\n${r.count} pesanan OTP aktif.`,components:[row([['active_orders:0','OTP Aktif'],['shop_order_history','Riwayat OTP'],['manual_orders:0','Pesanan Manual']])]});
      }else if(id.startsWith('active_orders:')){
        const r=model.activeOrders(user,Number(id.split(':')[1])),components=[];
        if(r.rows.length)components.push(row(r.rows.map(o=>['active_order:'+o.id,`#${o.provider_order_id} • ${o.phone || '-'} • ${o.otp?'OTP diterima':'menunggu'}`])));components.push(nav('active_orders:',r,'shop_orders'));
        await i.editReply({content:`**📦 Pesanan Aktif**\n${r.count} pesanan • halaman ${r.page+1}/${r.pages}\nPesanan yang menunggu OTP ditampilkan dahulu.`,components});
      }else if(id.startsWith('active_order:')){
        const o=model.order(user,id.split(':')[1]);await i.editReply({content:`**${o.product_name || 'Pesanan OTP'}**\nOrder: ${o.provider_order_id}\nNomor: ${o.phone || '-'}\nStatus terakhir: ${o.status}\nHarga: ${money(o.amount)}\nTekan Cek OTP untuk memperbarui status.`,components:[row([['check_otp:'+o.provider_order_id,'Cek OTP'],['cancel_order:'+o.provider_order_id,'Batalkan'],['buy_again:'+o.id,'Beli Lagi'],['active_orders:0','Kembali']])]});
      }else if(id==='active_invoice'){
        const p=payments.active(user);
        if(!p){await i.editReply({content:'Tidak ada tagihan QRIS aktif.',components:[row([['shop_topup','Isi Saldo']])]});return true;}
        const e=new EmbedBuilder().setColor(0x5865F2).setTitle('💳 Tagihan QRIS Aktif').setDescription(`Jenis: ${p.order_id.startsWith('manual-buy-')?'Produk Lainnya':p.purpose==='purchase'?'Pembelian OTP':'Isi saldo'}\nNominal: ${money(p.amount)}\nTotal: ${p.total_charge==null?'Belum diterima':money(p.total_charge)}\nStatus: ${p.status}\n${p.production?'':'MODE UJI — gunakan simulator pembayaran.\n'}Gunakan tagihan ini; jangan membayar ulang.${p.provider_ref?'':'\nReferensi belum diterima. Minta admin memeriksa ID tagihan di dashboard gateway pembayaran.'}`).setFooter({text:p.order_id});if(p.qr_url)e.setImage(p.qr_url);
        await i.editReply({embeds:[e],components:[row([[(p.order_id.startsWith('manual-buy-')?'manual_invoice_check:':p.purpose==='purchase'?'direct_check:':'topup_check:')+p.order_id,'Cek Pembayaran'],['shop_topup','Kembali']])]});
      }else if(id==='admin_eff_summary'){
        const r=model.summary(user);let provider='Hanya owner';if(staff.isOwner?.(user))try{const v=(await smscode('/balance')).data?.balance,b=Number(v && typeof v==='object'?v.canonical_amount:v);if(v!=null && Number.isSafeInteger(b) && b>=0)provider=money(b)+(b<operations.settings().lowThreshold?' ⚠️ di bawah batas peringatan':'');}catch{}
        if(!staff.isAdmin(user))throw new Error('Akses admin sudah dicabut.');
        await i.editReply({content:`**⚙️ Ringkasan Admin**\nPengajuan manual menunggu: **${r.manual}**\nPembelian perlu pemeriksaan: **${r.review}**\nTagihan QRIS aktif: **${r.invoices}**\nProduk menunggu diproses: **${r.processing}**\nPesanan selesai dengan DM belum terkirim: **${r.delivery}**\nProduk stok menipis / habis (≤3): **${r.lowStock}**\nSaldo provider: **${provider}**\nMaintenance: **${features.maintenance()?'AKTIF':'NONAKTIF'}**`,components:[row([['admin_store_requests:0','Periksa Manual'],['admin_payment_issues','Periksa Pembayaran'],['admin_eff_summary','Segarkan']]),row([['admin_manual_orders:0','Periksa Pesanan & DM'],['admin_manual_catalog:0','Periksa Stok'],['admin_home','Panel Admin']])]});
      }
    }catch(e){await i.editReply({content:e.message,allowedMentions:{parse:[]}});}return true;
  };
}
module.exports={validateAttachment,proofUploadModal,createEfficiency,createEfficiencyHandler};
