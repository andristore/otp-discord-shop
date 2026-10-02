const {randomUUID}=require('node:crypto');
const {buyerLabel}=require('./buyer-profiles');
const money=n=>`${Number(n).toLocaleString('id-ID')} IDR`;
const safe=s=>String(s || '').replace(/([\\`*_~|<>\[\]])/g,'\\$1');

function createManualProducts({db,staff,audit=()=>{},maintenance=()=>false}) {
  db.exec(`CREATE TABLE IF NOT EXISTS manual_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,description TEXT NOT NULL,
    price INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS manual_product_orders (
    id TEXT PRIMARY KEY,discord_id TEXT NOT NULL,product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,description TEXT NOT NULL,amount INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',delivery TEXT NOT NULL DEFAULT '',admin_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS manual_orders_buyer ON manual_product_orders(discord_id,created_at);
  CREATE TABLE IF NOT EXISTS manual_product_quotes (
    id TEXT PRIMARY KEY,discord_id TEXT NOT NULL,product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,description TEXT NOT NULL,amount INTEGER NOT NULL,
    expires_at INTEGER NOT NULL);
  `);
  const admin=id=>{if(!staff.isAdmin(id))throw Error('Akses ditolak.');};
  const product=id=>{const p=db.prepare('SELECT * FROM manual_products WHERE id=?').get(id);if(!p)throw Error('Produk manual tidak ditemukan.');return p;};
  function validate(p) {
    const name=String(p.name || '').trim(),description=String(p.description || '').trim(),raw=String(p.price).trim(),price=Number(raw);
    if(!name || name.length>80 || !description || description.length>800 || !/^\d+$/.test(raw) || !Number.isSafeInteger(price) || price<1 || price>1000000 || ![0,1].includes(p.enabled))throw Error('Nama 1–80 karakter, deskripsi 1–800 karakter, harga 1–1.000.000 rupiah tanpa titik, status 1 atau 0.');
    return {name,description,price,enabled:p.enabled};
  }
  const save=db.transaction((user,id,fields)=>{admin(user);const p=validate(fields);
    if(id){product(id);db.prepare('UPDATE manual_products SET name=?,description=?,price=?,enabled=? WHERE id=?').run(p.name,p.description,p.price,p.enabled,id);}
    else id=Number(db.prepare('INSERT INTO manual_products(name,description,price,enabled) VALUES(?,?,?,?)').run(p.name,p.description,p.price,p.enabled).lastInsertRowid);
    audit(user,`Simpan produk manual #${id}: ${p.name} • ${p.price} IDR`);return product(id);
  });
  function page(query,args,requested,size=10) {
    const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get(...args).n,pages=Math.max(1,Math.ceil(count/size));
    const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);
    return {count,pages,page,rows:db.prepare(query+' LIMIT ? OFFSET ?').all(...args,size,page*size)};
  }
  function catalog(user,requested=0,asAdmin=false){if(asAdmin)admin(user);return page('SELECT * FROM manual_products'+(asAdmin?'':' WHERE enabled=1')+' ORDER BY id DESC',[],requested);}
  function quote(user,id){if(maintenance())throw Error('Toko sedang maintenance.');const p=product(id);if(!p.enabled)throw Error('Produk sedang nonaktif.');
    const token=randomUUID();db.prepare('DELETE FROM manual_product_quotes WHERE expires_at<? AND id NOT IN (SELECT id FROM manual_product_orders)').run(Date.now());
    db.prepare('INSERT INTO manual_product_quotes VALUES(?,?,?,?,?,?,?)').run(token,user,p.id,p.name,p.description,p.price,Date.now()+15*60000);return {...p,token};
  }
  const buy=db.transaction((user,token)=>{
    const previous=db.prepare('SELECT * FROM manual_product_orders WHERE id=?').get(token);
    if(previous){if(previous.discord_id!==user)throw Error('Pesanan tidak ditemukan.');return previous;}
    if(maintenance())throw Error('Toko sedang maintenance.');
    const q=db.prepare('SELECT * FROM manual_product_quotes WHERE id=? AND discord_id=?').get(token,user);
    if(!q || q.expires_at<Date.now())throw Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');
    const p=product(q.product_id);
    if(!p.enabled || p.price!==q.amount || p.name!==q.product_name || p.description!==q.description)throw Error('Produk berubah atau nonaktif. Pilih kembali untuk melihat data terbaru.');
    if(!db.prepare('UPDATE users SET balance=balance-? WHERE discord_id=? AND balance>=?').run(q.amount,user,q.amount).changes)throw Error('Saldo tidak cukup. Isi saldo dahulu.');
    db.prepare('INSERT INTO manual_product_orders(id,discord_id,product_id,product_name,description,amount) VALUES(?,?,?,?,?,?)').run(token,user,p.id,q.product_name,q.description,q.amount);
    return getOrder(user,token);
  });
  function getOrder(user,id,asAdmin=false){if(asAdmin)admin(user);const o=db.prepare('SELECT * FROM manual_product_orders WHERE id=?').get(id);if(!o || (!asAdmin && o.discord_id!==user))throw Error('Pesanan tidak ditemukan.');return o;}
  function orders(user,requested=0,asAdmin=false){if(asAdmin)admin(user);return page('SELECT * FROM manual_product_orders'+(asAdmin?'':' WHERE discord_id=?')+' ORDER BY CASE WHEN state=\'pending\' THEN 0 ELSE 1 END,created_at DESC,rowid DESC',asAdmin?[]:[user],requested);}
  const finish=db.transaction((user,id,delivery)=>{admin(user);const o=getOrder(user,id,true);delivery=String(delivery || '').trim();
    if(o.state!=='pending')throw Error('Pesanan sudah diproses.');if(!delivery || delivery.length>1000)throw Error('Isi hasil/keterangan pengiriman, maksimal 1000 karakter.');
    db.prepare("UPDATE manual_product_orders SET state='completed',delivery=?,admin_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(delivery,user,id);audit(user,'Selesaikan pesanan manual '+id);return getOrder(user,id,true);
  });
  const refund=db.transaction((user,id)=>{admin(user);const o=getOrder(user,id,true);if(o.state==='refunded')return o;if(o.state!=='pending')throw Error('Pesanan selesai tidak dapat dibatalkan dari menu ini.');
    const balance=db.prepare('SELECT balance FROM users WHERE discord_id=?').get(o.discord_id)?.balance;
    if(!Number.isSafeInteger(balance) || !Number.isSafeInteger(balance+o.amount))throw Error('Saldo pembeli perlu diperiksa.');
    db.prepare('UPDATE users SET balance=balance+? WHERE discord_id=?').run(o.amount,o.discord_id);
    db.prepare("UPDATE manual_product_orders SET state='refunded',admin_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(user,id);audit(user,'Refund pesanan manual '+id);return getOrder(user,id,true);
  });
  return {catalog,product,save,quote,buy,orders,getOrder,finish,refund};
}

function createManualProductsHandler({discord,model,staff,sendDM=async()=>{}}) {
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const button=(id,label,style=2)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style);
  const row=(...buttons)=>new ActionRowBuilder().addComponents(...buttons);
  const status=o=>({pending:'Menunggu admin',completed:'Selesai',refunded:'Dibatalkan • saldo dikembalikan'}[o.state]);
  const embed=(title,description)=>new EmbedBuilder().setTitle(title).setColor(0x5865F2).setDescription(description);
  const home=admin=>button(admin?'admin_home':'shop_home',admin?'Menu Awal Admin':'Menu Awal',1);
  function catalog(user,p,admin) {
    const data=model.catalog(user,p,admin),components=[];
    for(let n=0;n<data.rows.length;n+=5)components.push(row(...data.rows.slice(n,n+5).map(x=>button(`${admin?'admin_manual_detail':'manual_detail'}:${x.id}`,`${x.name} • ${money(x.price)}${admin&&!x.enabled?' • nonaktif':''}`))));
    components.push(row(button(`${admin?'admin_manual_catalog':'manual_catalog'}:${data.page-1}`,'Sebelumnya',1).setDisabled(data.page===0),button(`${admin?'admin_manual_catalog':'manual_catalog'}:${data.page+1}`,'Berikutnya',1).setDisabled(data.page===data.pages-1),button(admin?'admin_manual_add':'manual_orders:0',admin?'Tambah Produk':'Pesanan Manual',admin?3:1),home(admin)));
    return {content:'',embeds:[embed('📦 Produk Manual',`${data.count?'Pilih produk di bawah.':'Belum ada produk manual tersedia.'}\n\nPembayaran menggunakan saldo. Pesanan dikirim/diproses admin secara manual.\nHalaman ${data.page+1}/${data.pages} • ${data.count} produk`)],components};
  }
  function detail(p,admin) {return {content:'',embeds:[embed('📦 '+p.name,`${safe(p.description)}\n\nHarga jual: **${money(p.price)}**\n${admin?`Status: ${p.enabled?'Aktif':'Nonaktif'}`:'Diproses oleh admin setelah pembayaran saldo.'}`)],components:[admin?row(button('admin_manual_data:'+p.id,'Ubah Data',1),button('admin_manual_price:'+p.id,'Atur Harga Jual',3),button('admin_manual_toggle:'+p.id,p.enabled?'Nonaktifkan':'Aktifkan',p.enabled?4:3)):row(button('manual_quote:'+p.id,'Beli dengan Saldo',3)),row(button(admin?'admin_manual_catalog:0':'manual_catalog:0','Kembali',1),home(admin))]};}
  function order(o,admin) {return {content:`Pembeli: ${buyerLabel(o.discord_id)}\n\n**Pesanan Manual #${o.id}**\nProduk: ${safe(o.product_name)}\nHarga: ${money(o.amount)}\nStatus: ${status(o)}\n${o.delivery?'':'\n'+safe(o.description)}`,allowedMentions:{parse:[]},embeds:o.delivery?[embed('Hasil / keterangan pengiriman',safe(o.delivery))]:[],components:[...(admin&&o.state==='pending'?[row(button('admin_manual_deliver:'+o.id,'Kirim / Selesaikan',3),button('admin_manual_refund_confirm:'+o.id,'Batalkan & Refund',4))]:[]),row(button(admin?'admin_manual_orders:0':'manual_orders:0','Daftar Pesanan',1),home(admin))]};}
  function orders(user,p,admin) {const data=model.orders(user,p,admin),components=[];
    for(let n=0;n<data.rows.length;n+=5)components.push(row(...data.rows.slice(n,n+5).map(o=>button(`${admin?'admin_manual_order':'manual_order'}:${o.id}`,`${o.product_name} • ${status(o)} • ${money(o.amount)}`))));
    components.push(row(button(`${admin?'admin_manual_orders':'manual_orders'}:${data.page-1}`,'Sebelumnya',1).setDisabled(data.page===0),button(`${admin?'admin_manual_orders':'manual_orders'}:${data.page+1}`,'Berikutnya',1).setDisabled(data.page===data.pages-1),home(admin)));
    return {content:`**Pesanan Produk Manual**\n${data.count?'Pilih pesanan untuk melihat detail.':'Belum ada pesanan.'}\nHalaman ${data.page+1}/${data.pages} • ${data.count} pesanan`,embeds:[],components};
  }
  function modal(id,title,fields){return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...fields.map(([key,label,value,max,long])=>row(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(long?TextInputStyle.Paragraph:TextInputStyle.Short).setRequired(true).setMaxLength(max).setValue(String(value)))));}
  async function notify(o){try{await sendDM(o.discord_id,order(o,false));return true;}catch{return false;}}
  return async function handle(i) {
    const id=String(i.customId || ''),admin=id.startsWith('admin_manual_');
    if(!admin && !id.startsWith('manual_') && id!=='shop_manual_products')return false;
    if(admin&&!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    const user=i.user.id,parts=id.split(':'),key=parts[0],arg=parts[1];
    try {
      if(i.isModalSubmit()) {
        const value=k=>i.fields.getTextInputValue(k);
        if(key==='admin_manual_save') {
          const p=model.save(user,null,{name:value('name'),description:value('description'),price:value('price'),enabled:1});await i.reply({ephemeral:true,...detail(p,true)});
        }else if(key==='admin_manual_data_save' || key==='admin_manual_price_save') {
          const old=model.product(arg),p=model.save(user,arg,{...old,...(key==='admin_manual_data_save'?{name:value('name'),description:value('description')}:{price:value('price')})});await i.reply({ephemeral:true,...detail(p,true)});
        }else if(key==='admin_manual_deliver_save') {
          const o=model.finish(user,arg,value('delivery'));await i.reply({ephemeral:true,...order(o,true)});const sent=await notify(o);if(!sent)await i.followUp({ephemeral:true,content:'DM pembeli tidak terkirim. Hasil tetap tersimpan dan bisa dibaca di Produk Manual → Pesanan Manual.'});
        }else throw Error('Form produk manual tidak dikenali.');
        return true;
      }
      if(!i.isButton())return false;
      if(id==='shop_manual_products')await i.reply({ephemeral:true,...catalog(user,0,false)});
      else if(key==='manual_catalog' || key==='admin_manual_catalog')await i.update(catalog(user,Number(arg),admin));
      else if(key==='manual_orders' || key==='admin_manual_orders')await i.reply({ephemeral:true,...orders(user,Number(arg),admin)});
      else if(key==='manual_detail' || key==='admin_manual_detail'){const p=model.product(arg);if(!admin&&!p.enabled)throw Error('Produk sedang nonaktif.');await i.update(detail(p,admin));}
      else if(id==='admin_manual_add')await i.showModal(modal('admin_manual_save','Tambah Produk Manual',[['name','Nama produk','Produk baru',80],['description','Deskripsi & waktu proses','Jelaskan produk dan perkiraan waktu proses.',800,true],['price','Harga jual IDR, tanpa titik','5000',7]]));
      else if(key==='admin_manual_data' || key==='admin_manual_price'){const p=model.product(arg);await i.showModal(key==='admin_manual_data'?modal('admin_manual_data_save:'+p.id,'Ubah Data Produk',[['name','Nama produk',p.name,80],['description','Deskripsi & waktu proses',p.description,800,true]]):modal('admin_manual_price_save:'+p.id,'Atur Harga Jual',[['price','Harga jual IDR, tanpa titik',p.price,7]]));}
      else if(key==='admin_manual_toggle'){const p=model.product(arg);await i.update(detail(model.save(user,arg,{...p,enabled:p.enabled?0:1}),true));}
      else if(key==='manual_quote'){const p=model.quote(user,arg);await i.update({content:'',embeds:[embed('Konfirmasi Pembelian Manual',`Pembeli: ${buyerLabel(user)}\nProduk: ${safe(p.name)}\n${safe(p.description)}\n\nHarga: **${money(p.price)}**\nSaldo dipotong setelah konfirmasi. Admin akan memproses pesanan. Konfirmasi berlaku 15 menit.`)],allowedMentions:{parse:[]},components:[row(button('manual_buy:'+p.token,'Konfirmasi Bayar Saldo',3),button('manual_detail:'+p.id,'Kembali',1),home(false))]});}
      else if(key==='manual_buy'){const o=model.buy(user,arg);await i.update(order(o,false));}
      else if(key==='manual_order' || key==='admin_manual_order')await i.reply({ephemeral:true,...order(model.getOrder(user,arg,admin),admin)});
      else if(key==='admin_manual_deliver'){model.getOrder(user,arg,true);await i.showModal(modal('admin_manual_deliver_save:'+arg,'Kirim Produk Manual',[['delivery','Hasil / keterangan pengiriman','Pesanan Anda telah diproses.',1000,true]]));}
      else if(key==='admin_manual_refund_confirm'){const o=model.getOrder(user,arg,true);if(o.state!=='pending')throw Error('Pesanan sudah diproses.');await i.reply({ephemeral:true,content:`Batalkan pesanan ${safe(o.product_name)} dan kembalikan ${money(o.amount)} ke saldo pembeli?`,components:[row(button('admin_manual_refund:'+arg,'Ya, Batalkan & Refund',4),button('admin_manual_order:'+arg,'Kembali',1),home(true))]});}
      else if(key==='admin_manual_refund'){const o=model.refund(user,arg);await i.update(order(o,true));const sent=await notify(o);if(!sent)await i.followUp({ephemeral:true,content:'Refund tersimpan. DM tidak terkirim; pembeli dapat melihat hasil di Pesanan Manual.'});}
      else throw Error('Menu produk manual tidak dikenali.');
    }catch(e){const payload={ephemeral:true,content:e.message,allowedMentions:{parse:[]},components:[row(home(admin))]};if(i.replied || i.deferred)await i.followUp(payload);else await i.reply(payload);}
    return true;
  };
}
module.exports={createManualProducts,createManualProductsHandler};
