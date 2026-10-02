function validateAttachment(a){
  if(!a || !['image/png','image/jpeg','image/webp'].includes(a.contentType) || !Number.isSafeInteger(a.size) || a.size<1 || a.size>8*1024*1024)throw new Error('Pilih gambar PNG/JPG/WebP maksimal 8 MB.');
  require('./store-features').proofIdentity(a.url);return a.url;
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
  function summary(user){if(!staff.isAdmin(user))throw new Error('Akses ditolak.');return {manual:db.prepare("SELECT COUNT(*) n FROM manual_topup_requests WHERE status='pending'").get().n,review:db.prepare("SELECT COUNT(*) n FROM direct_purchases WHERE state IN ('review','resolving')").get().n,invoices:db.prepare("SELECT COUNT(*) n FROM topups WHERE gateway IN ('tripay','midtrans') AND credited=0 AND status IN ('creating','pending')").get().n};}
  return {save,favorite,remove,favorites,activeOrders,order,summary};
}
function createEfficiencyHandler({discord,model,commerce,payments,features,staff,smscode,operations}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder}=discord;
  const row=xs=>new ActionRowBuilder().addComponents(...xs.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0,80)).setStyle(ButtonStyle.Secondary)));
  const money=n=>Number(n || 0).toLocaleString('id-ID')+' IDR';
  const nav=(prefix,r,back)=>{const n=row([[prefix+(r.page-1),'Sebelumnya'],[prefix+(r.page+1),'Berikutnya'],[back,'Kembali']]);n.components[0].setDisabled(r.page===0);n.components[1].setDisabled(r.page===r.pages-1);return n;};
  return async i=>{
    const id=String(i.customId || ''),upload=i.isChatInputCommand?.() && i.commandName==='bukti';
    if(!upload && !/^(favorites(?::|$)|favorite_(save|detail|delete):|shop_orders$|active_orders:|active_order:|active_invoice$|manual_upload$|admin_eff_summary$)/.test(id))return false;
    if(id==='admin_eff_summary' && !staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    await i.deferReply({ephemeral:true});
    try{
      const user=i.user.id;
      if(upload){
        const proof=validateAttachment(i.options.getAttachment('gambar',true));
        const r=features.submit({id:i.id,userId:user,amount:i.options.getInteger('nominal',true),proof,note:i.options.getString('catatan')?.trim() || ''});
        await i.editReply({content:`✅ Bukti gambar diterima. Pengajuan ${r.id}: ${money(r.amount)}. Saldo masuk setelah admin memeriksa mutasi dan menyetujui.`,components:[row([['manual_request_list:0','Status Pengajuan']])]});features.poll().catch(()=>{});
      }else if(id==='manual_upload'){
        await i.editReply({content:'**Kirim gambar bukti langsung**\nKetik `/bukti`, isi **nominal** (minimal 5000), pilih/upload **gambar**, lalu kirim. Catatan bersifat opsional.\nPNG/JPG/WebP maksimal 8 MB. Tidak perlu menyalin tautan gambar.\nSaldo masuk setelah admin memeriksa pembayaran.',components:[row([['manual_request_list:0','Status Pengajuan'],['topup_manual','Kembali'],['manual_request','Alternatif Tautan']])]});
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
        const r=model.summary(user);let provider='Belum dapat diperiksa';try{const v=(await smscode('/balance')).data?.balance,b=Number(v && typeof v==='object'?v.canonical_amount:v);if(v!=null && Number.isSafeInteger(b) && b>=0)provider=money(b)+(b<operations.settings().lowThreshold?' ⚠️ di bawah batas peringatan':'');}catch{}
        if(!staff.isAdmin(user))throw new Error('Akses admin sudah dicabut.');
        await i.editReply({content:`**⚙️ Ringkasan Admin**\nPengajuan manual menunggu: **${r.manual}**\nPembelian perlu pemeriksaan: **${r.review}**\nTagihan QRIS aktif: **${r.invoices}**\nSaldo provider: **${provider}**\nMaintenance: **${features.maintenance()?'AKTIF':'NONAKTIF'}**`,components:[row([['admin_store_requests:0','Periksa Manual'],['admin_payment_issues','Periksa Pembayaran'],['admin_health','Koneksi Provider'],['admin_home','Panel Admin']])]});
      }
    }catch(e){await i.editReply({content:e.message,allowedMentions:{parse:[]}});}return true;
  };
}
module.exports={validateAttachment,createEfficiency,createEfficiencyHandler};
