const {randomUUID,createHash}=require('node:crypto');
const {buyerLabel}=require('./buyer-profiles');
const money=n=>`${Number(n).toLocaleString('id-ID')} IDR`;
const safe=s=>String(s || '').replace(/([\\`*_~|<>\[\]])/g,'\\$1');

function createManualProducts({diagnostics,db,staff,audit=()=>{},maintenance=()=>false,payments}) {
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
  for(const [table,columns] of Object.entries({manual_products:{auto_enabled:'INTEGER NOT NULL DEFAULT 0',deleted:'INTEGER NOT NULL DEFAULT 0',quantity:'INTEGER',parent_id:'INTEGER',cost:'INTEGER'},manual_product_quotes:{auto_enabled:'INTEGER NOT NULL DEFAULT 0',cost_snapshot:'INTEGER'},manual_product_orders:{automatic:'INTEGER NOT NULL DEFAULT 0',quantity_reserved:'INTEGER NOT NULL DEFAULT 0',payment_method:"TEXT NOT NULL DEFAULT 'balance'",invoice_id:'TEXT',notified:'INTEGER NOT NULL DEFAULT 0',polled_at:'INTEGER',cost_snapshot:'INTEGER'}})) {
    const existing=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));
    for(const [name,type] of Object.entries(columns))if(!existing.has(name)){
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      if(table==='manual_product_orders'&&name==='notified')db.prepare("UPDATE manual_product_orders SET notified=1 WHERE state IN ('completed','refunded')").run();
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS manual_invoice_unique ON manual_product_orders(invoice_id);
    CREATE TABLE IF NOT EXISTS manual_product_stock(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id INTEGER NOT NULL,
      body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'available',order_id TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS manual_stock_available ON manual_product_stock(product_id,state);
    CREATE TABLE IF NOT EXISTS manual_admin_search(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,query TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS manual_product_edit_events(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,product_id INTEGER NOT NULL,request_hash TEXT NOT NULL);`);
  let notifier,polling=false;const notifying=new Set();
  const admin=id=>{if(!staff.isAdmin(id))throw Error('Akses ditolak.');};
  const remove=db.transaction((user,id)=>{admin(user);const p=db.prepare('SELECT * FROM manual_products WHERE id=?').get(id);if(!p)throw Error('Produk manual tidak ditemukan.');if(p.deleted)return;
    db.prepare('UPDATE manual_products SET deleted=1,enabled=0 WHERE id=?').run(id);audit(user,'Hapus produk manual #'+id+' dari katalog');
  });
  const product=id=>{const p=db.prepare('SELECT * FROM manual_products WHERE id=?').get(id);if(!p || p.deleted)throw Error('Produk manual tidak ditemukan atau sudah dihapus.');if(p.parent_id){const root=db.prepare('SELECT deleted FROM manual_products WHERE id=?').get(p.parent_id);if(!root||root.deleted)throw Error('Produk utama sudah dihapus.');}return p;};
  function validate(p) {
    const name=String(p.name || '').trim(),description=String(p.description || '').trim(),raw=String(p.price).trim(),price=Number(raw);
    if(!name || name.length>80 || !description || description.length>800 || !/^\d+$/.test(raw) || !Number.isSafeInteger(price) || price<1 || price>1000000 || ![0,1].includes(p.enabled))throw Error('Nama 1–80 karakter, deskripsi 1–800 karakter, harga 1–1.000.000 rupiah tanpa titik, status 1 atau 0.');
    const quantity=p.quantity==null?null:Number(p.quantity);if(quantity!==null && (!/^\d+$/.test(String(p.quantity)) || !Number.isSafeInteger(quantity) || quantity<0 || quantity>1000000))throw Error('Stok jual harus angka 0–1.000.000 tanpa titik.');const cost=p.cost==null||String(p.cost).trim()===''?null:Number(p.cost);if(cost!==null&&(!/^\d+$/.test(String(p.cost).trim())||!Number.isSafeInteger(cost)||cost<0||cost>1000000))throw Error('Modal 0–1.000.000 IDR tanpa titik; kosongkan jika belum diketahui.');return {name,description,price,enabled:p.enabled,quantity,cost};
  }
  const save=db.transaction((user,id,fields)=>{admin(user);const p=validate(fields);
    if(id){product(id);db.prepare('UPDATE manual_products SET name=?,description=?,price=?,enabled=?,quantity=?,cost=? WHERE id=?').run(p.name,p.description,p.price,p.enabled,p.quantity,p.cost,id);}
    else id=Number(db.prepare('INSERT INTO manual_products(name,description,price,enabled,quantity,cost) VALUES(?,?,?,?,?,?)').run(p.name,p.description,p.price,p.enabled,p.quantity,p.cost).lastInsertRowid);
    audit(user,`Simpan produk manual #${id}: ${p.name} • ${p.price} IDR`);return product(id);
  });
  function stockCount(id){return db.prepare("SELECT COUNT(*) n FROM manual_product_stock WHERE product_id=? AND state='available'").get(id).n;}
  const sellStock=p=>p.quantity===null?(p.auto_enabled?stockCount(p.id):'Belum diatur'):p.quantity;
  function restoreQuantity(o){if(o.quantity_reserved){db.prepare('UPDATE manual_products SET quantity=quantity+1 WHERE id=? AND quantity IS NOT NULL').run(o.product_id);db.prepare('UPDATE manual_product_orders SET quantity_reserved=0 WHERE id=?').run(o.id);}}
  function stocks(user,id,requested=0,availableOnly=false){admin(user);product(id);return page('SELECT id,product_id,state FROM manual_product_stock WHERE product_id=?'+(availableOnly?" AND state='available'":'')+' ORDER BY id DESC',[id],requested);}
  function stock(user,id){admin(user);const s=db.prepare('SELECT * FROM manual_product_stock WHERE id=?').get(id);if(!s)throw Error('Data stok tidak ditemukan.');return s;}
  const saveStock=db.transaction((user,productId,id,body)=>{admin(user);product(productId);body=String(body || '').trim();if(!body || body.length>1000)throw Error('Isi satu data produk, maksimal 1000 karakter.');
    if(id){const s=stock(user,id);if(s.product_id!==Number(productId) || s.state!=='available')throw Error('Stok sudah dialokasikan atau terjual, tidak dapat diubah.');db.prepare('UPDATE manual_product_stock SET body=? WHERE id=?').run(body,id);}
    else id=Number(db.prepare('INSERT INTO manual_product_stock(product_id,body) VALUES(?,?)').run(productId,body).lastInsertRowid);
    audit(user,'Simpan stok produk #'+productId+' • data #'+id);return stock(user,id);
  });
  const saveWithStock=db.transaction((user,id,fields,body,eventId)=>{admin(user);product(id);const p=validate(fields);body=String(body || '').trim();if(body.length>1000 || !eventId)throw Error('Data stok maksimal 1000 karakter.');
    const hash=createHash('sha256').update(JSON.stringify([p,body])).digest('hex'),previous=db.prepare('SELECT * FROM manual_product_edit_events WHERE id=?').get(eventId);
    if(previous){if(previous.admin_id!==user || previous.product_id!==Number(id) || previous.request_hash!==hash)throw Error('Pengubahan produk tidak sesuai.');return product(id);}
    db.prepare('UPDATE manual_products SET name=?,description=?,price=?,enabled=?,quantity=?,cost=? WHERE id=?').run(p.name,p.description,p.price,p.enabled,p.quantity,p.cost,id);
    if(body)db.prepare('INSERT INTO manual_product_stock(product_id,body) VALUES(?,?)').run(id,body);
    audit(user,'Ubah produk #'+id+(body?' dan tambah satu stok data':''));db.prepare('INSERT INTO manual_product_edit_events VALUES(?,?,?,?)').run(eventId,user,id,hash);return product(id);
  });
  const createWithStock=db.transaction((user,fields,body,eventId)=>{admin(user);const p=validate(fields);body=String(body || '').trim();if(body.length>1000 || !eventId)throw Error('Data kirim otomatis maksimal 1000 karakter.');
    const hash=createHash('sha256').update(JSON.stringify(['create',p,body])).digest('hex'),previous=db.prepare('SELECT * FROM manual_product_edit_events WHERE id=?').get(eventId);
    if(previous){if(previous.admin_id!==user || previous.request_hash!==hash)throw Error('Penambahan produk tidak sesuai.');return product(previous.product_id);}
    const id=Number(db.prepare('INSERT INTO manual_products(name,description,price,enabled,auto_enabled,quantity,cost) VALUES(?,?,?,?,?,?,?)').run(p.name,p.description,p.price,p.enabled,body?1:0,p.quantity,p.cost).lastInsertRowid);
    if(body)db.prepare('INSERT INTO manual_product_stock(product_id,body) VALUES(?,?)').run(id,body);
    audit(user,'Tambah produk #'+id+(body?' dengan satu stok dan kirim otomatis aktif':''));db.prepare('INSERT INTO manual_product_edit_events VALUES(?,?,?,?)').run(eventId,user,id,hash);return product(id);
  });
  function testPreview(user,id){
    admin(user);const p=product(id),data=db.prepare("SELECT body FROM manual_product_stock WHERE product_id=? AND state='available' ORDER BY id LIMIT 1").get(id);
    const reason=maintenance()?'Toko sedang maintenance.':!p.enabled?'Produk sedang nonaktif.':p.quantity===0?'Stok jual habis.':!p.auto_enabled?'Pengiriman produk masih diproses admin.':!data?'Data Produk siap kirim belum tersedia.':'';
    return {product:p,ready:!reason,reason,body:!reason?data.body:'',quantity:sellStock(p),dataCount:stockCount(id)};
  }
  function preview(user,id){
    admin(user);const p=product(id),data=db.prepare("SELECT body FROM manual_product_stock WHERE product_id=? AND state='available' ORDER BY id LIMIT 1").get(id);
    if(!data)throw Error('Belum ada Data Produk tersedia untuk pratinjau.');
    return {product:p,body:data.body};
  }
  const toggleAuto=db.transaction((user,id)=>{admin(user);const p=product(id);if(!p.auto_enabled&&!stockCount(id))throw Error('Tambahkan stok data terlebih dahulu.');db.prepare('UPDATE manual_products SET auto_enabled=? WHERE id=?').run(p.auto_enabled?0:1,id);audit(user,'Ubah kirim otomatis produk #'+id);return product(id);});
  function reserveStock(o){const p=product(o.product_id);if(p.quantity!==null){if(!db.prepare('UPDATE manual_products SET quantity=quantity-1 WHERE id=? AND quantity>0').run(p.id).changes)throw Error('Stok jual habis.');db.prepare('UPDATE manual_product_orders SET quantity_reserved=1 WHERE id=?').run(o.id);}if(!o.automatic)return;const s=db.prepare("SELECT id FROM manual_product_stock WHERE product_id=? AND state='available' ORDER BY id LIMIT 1").get(o.product_id);if(!s)throw Error('Stok data habis. Pilih produk lain.');db.prepare("UPDATE manual_product_stock SET state='reserved',order_id=? WHERE id=? AND state='available'").run(o.id,s.id);}
  function deliverStock(o){if(!o.automatic)return;const s=db.prepare("SELECT * FROM manual_product_stock WHERE order_id=? AND state='reserved'").get(o.id);if(!s)throw Error('Stok pesanan perlu diperiksa admin.');db.prepare("UPDATE manual_product_stock SET state='sold' WHERE id=?").run(s.id);db.prepare("UPDATE manual_product_orders SET state='completed',delivery=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(s.body,o.id);}
  function page(query,args,requested,size=10) {
    const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get(...args).n,pages=Math.max(1,Math.ceil(count/size));
    const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);
    return {count,pages,page,rows:db.prepare(query+' LIMIT ? OFFSET ?').all(...args,size,page*size)};
  }
  function catalog(user,requested=0,asAdmin=false){if(asAdmin)admin(user);return page('SELECT * FROM manual_products WHERE deleted=0 AND parent_id IS NULL'+(asAdmin?'':' AND enabled=1')+' ORDER BY id DESC',[],requested);}
  function search(user,key,requested=0,query){
    admin(user);db.prepare('DELETE FROM manual_admin_search WHERE expires_at<?').run(Date.now());
    if(query!==undefined){query=String(query||'').trim();if(!query||query.length>80)throw Error('Kata pencarian harus 1–80 karakter.');key=randomUUID();db.prepare('INSERT INTO manual_admin_search VALUES(?,?,?,?)').run(key,user,query,Date.now()+15*60000);}
    const session=db.prepare('SELECT * FROM manual_admin_search WHERE id=? AND admin_id=? AND expires_at>=?').get(key,user,Date.now());if(!session)throw Error('Pencarian kedaluwarsa. Cari produk kembali.');
    const r=page("SELECT p.* FROM manual_products p WHERE p.deleted=0 AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM manual_products root WHERE root.id=p.parent_id AND root.deleted=0)) AND instr(lower(p.name),lower(?))>0 ORDER BY p.id DESC",[session.query],requested,5);return {...r,key,query:session.query};
  }
  function quote(user,id){if(maintenance())throw Error('Toko sedang maintenance.');const p=product(id);if(!p.enabled||(p.parent_id&&!product(p.parent_id).enabled))throw Error('Produk sedang nonaktif.');
    const token=randomUUID();db.prepare('DELETE FROM manual_product_quotes WHERE expires_at<? AND id NOT IN (SELECT id FROM manual_product_orders)').run(Date.now());
    if(p.quantity===0)throw Error('Stok jual habis.');if(p.auto_enabled&&!stockCount(id))throw Error('Data kirim otomatis belum tersedia.');
    db.prepare('INSERT INTO manual_product_quotes(id,discord_id,product_id,product_name,description,amount,expires_at,auto_enabled,cost_snapshot) VALUES(?,?,?,?,?,?,?,?,?)').run(token,user,p.id,p.name,p.description,p.price,Date.now()+15*60000,p.auto_enabled,p.cost);return {...p,token};
  }
  function checkout(user,token){if(maintenance())throw Error('Toko sedang maintenance.');const q=db.prepare('SELECT * FROM manual_product_quotes WHERE id=? AND discord_id=?').get(token,user);
    if(!q || q.expires_at<Date.now())throw Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');const p=product(q.product_id);
    if(!p.enabled || (p.parent_id&&!product(p.parent_id).enabled) || p.price!==q.amount || p.name!==q.product_name || p.description!==q.description || p.auto_enabled!==q.auto_enabled)throw Error('Produk berubah atau nonaktif. Pilih kembali untuk melihat data terbaru.');return q;
  }
  const buy=db.transaction((user,token)=>{
    const previous=db.prepare('SELECT * FROM manual_product_orders WHERE id=?').get(token);
    if(previous){if(previous.discord_id!==user)throw Error('Pesanan tidak ditemukan.');if(previous.payment_method!=='balance')throw Error('Pesanan memakai QRIS. Buka Pesanan Manual untuk melanjutkan tagihan.');return previous;}
    const q=checkout(user,token);
    if(!db.prepare('UPDATE users SET balance=balance-? WHERE discord_id=? AND balance>=?').run(q.amount,user,q.amount).changes)throw Error('Saldo tidak cukup. Isi saldo dahulu.');
    db.prepare('INSERT INTO manual_product_orders(id,discord_id,product_id,product_name,description,amount,automatic,cost_snapshot) VALUES(?,?,?,?,?,?,?,?)').run(token,user,q.product_id,q.product_name,q.description,q.amount,q.auto_enabled,q.cost_snapshot);
    const o=getOrder(user,token);reserveStock(o);deliverStock(o);
    return getOrder(user,token);
  });
  async function notify(o){if(!notifier || o.notified || notifying.has(o.id) || !['completed','refunded'].includes(o.state))return;notifying.add(o.id);
    try{await notifier(o);db.prepare('UPDATE manual_product_orders SET notified=1 WHERE id=?').run(o.id);}catch{diagnostics?.record('product_dm','FAILED',o.id);console.warn('Pengiriman DM produk belum berhasil; pesanan',o.id,'akan dicoba ulang.');}finally{notifying.delete(o.id);}}
  const settle=db.transaction(payment=>{const o=db.prepare('SELECT * FROM manual_product_orders WHERE invoice_id=?').get(payment.order_id),p=payments?.get(payment.order_id,payment.discord_id);
    if(!o || !p?.credited || p.purpose!=='purchase' || p.discord_id!==o.discord_id || p.amount!==o.amount || o.payment_method!=='qris')throw Error('Pembayaran produk belum terverifikasi.');
    if(o.state==='awaiting_payment'){db.prepare("UPDATE manual_product_orders SET state='pending',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);deliverStock(o);}return getOrder(o.discord_id,o.id);
  });
  async function fulfillPayment(payment){const o=settle(payment);await notify(o);return o;}
  const reserveInvoice=db.transaction((user,token)=>{const previous=db.prepare('SELECT * FROM manual_product_orders WHERE id=?').get(token);
    if(previous){if(previous.discord_id!==user || previous.payment_method!=='qris')throw Error('Pesanan sudah memakai metode pembayaran lain.');return {order:previous,created:false};}
    payments.assertCanCreate?.(user);const q=checkout(user,token);if(q.amount<1000)throw Error('QRIS minimal 1.000 IDR. Gunakan saldo untuk harga lebih kecil.');const invoice='manual-buy-'+randomUUID();
    db.prepare("INSERT INTO manual_product_orders(id,discord_id,product_id,product_name,description,amount,automatic,payment_method,invoice_id,state,cost_snapshot) VALUES(?,?,?,?,?,?,?,'qris',?,'awaiting_payment',?)").run(token,user,q.product_id,q.product_name,q.description,q.amount,q.auto_enabled,invoice,q.cost_snapshot);
    const o=getOrder(user,token);reserveStock(o);return {order:o,created:true};
  });
  async function createQR(user,token,customer){if(!payments?.configured)throw Error('QRIS belum aktif.');require('./payments').parseCustomerEmail(customer.email);
    const r=reserveInvoice(user,token);if(!r.created)return {order:r.order,payment:payments.get(r.order.invoice_id,user)};
    try{const p=await payments.create(user,r.order.amount,{...customer,purpose:'purchase',orderId:r.order.invoice_id});if(p.credited)await fulfillPayment(p);return {order:getOrder(user,token),payment:p};}
    catch{const p=payments.get(r.order.invoice_id,user);diagnostics?.record('payment',p?.status==='failure'?'REJECTED':'UNCERTAIN',r.order.invoice_id);if(p&&!p.credited&&['expire','deny','cancel','failure'].includes(p.status)){releaseUnpaid(user,token);throw Error('Pembuatan tagihan ditolak. Stok sudah dikembalikan; periksa konfigurasi pembayaran sebelum mencoba lagi.');}throw Error('Status pembuatan tagihan belum pasti. Buka Riwayat Pesanan / Invoice untuk pemeriksaan; jangan membayar ulang.');}
  }
  const releaseUnpaid=db.transaction((user,id)=>{const o=getOrder(user,id),p=payments.get(o.invoice_id,user);
    if(o.state==='awaiting_payment'&&!p?.credited&&['expire','deny','cancel','failure'].includes(p?.status)){restoreQuantity(o);db.prepare("UPDATE manual_product_stock SET state='available',order_id=NULL WHERE order_id=? AND state='reserved'").run(o.id);db.prepare("UPDATE manual_product_orders SET state='expired',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);}return getOrder(user,id);
  });
  async function refresh(user,id){let o=getOrder(user,id);if(o.payment_method==='qris'&&o.state==='awaiting_payment'){await payments.refresh(o.invoice_id,user);const p=payments.get(o.invoice_id,user);o=p?.credited?await fulfillPayment(p):releaseUnpaid(user,id);}await notify(o);return o;}
  async function poll(){if(polling)return;polling=true;try{for(const o of db.prepare("SELECT * FROM manual_product_orders WHERE state='awaiting_payment' ORDER BY COALESCE(polled_at,0),created_at LIMIT 5").all()){db.prepare('UPDATE manual_product_orders SET polled_at=? WHERE id=?').run(Date.now(),o.id);try{await refresh(o.discord_id,o.id);}catch{diagnostics?.record('product_poll','FAILED',o.id);}}
    for(const o of db.prepare("SELECT * FROM manual_product_orders WHERE notified=0 AND state IN ('completed','refunded') LIMIT 10").all())await notify(o);
  }finally{polling=false;}}
  function getOrder(user,id,asAdmin=false){if(asAdmin)admin(user);const o=db.prepare('SELECT * FROM manual_product_orders WHERE id=?').get(id);if(!o || (!asAdmin && o.discord_id!==user))throw Error('Pesanan tidak ditemukan.');return o;}
  function orders(user,requested=0,asAdmin=false){if(asAdmin)admin(user);return page('SELECT * FROM manual_product_orders'+(asAdmin?'':' WHERE discord_id=?')+' ORDER BY CASE WHEN state=\'pending\' THEN 0 ELSE 1 END,created_at DESC,rowid DESC',asAdmin?[]:[user],requested);}
  const finish=db.transaction((user,id,delivery)=>{admin(user);const o=getOrder(user,id,true);delivery=String(delivery || '').trim();
    if(o.state!=='pending')throw Error('Pesanan sudah diproses.');if(!delivery || delivery.length>1000)throw Error('Isi hasil/keterangan pengiriman, maksimal 1000 karakter.');
    db.prepare("UPDATE manual_product_orders SET state='completed',delivery=?,admin_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(delivery,user,id);audit(user,'Selesaikan pesanan manual '+id);return getOrder(user,id,true);
  });
  const refund=db.transaction((user,id)=>{admin(user);const o=getOrder(user,id,true);if(o.state==='refunded')return o;if(o.state!=='pending')throw Error('Pesanan selesai tidak dapat dibatalkan dari menu ini.');
    const balance=db.prepare('SELECT balance FROM users WHERE discord_id=?').get(o.discord_id)?.balance ?? 0;
    if(!Number.isSafeInteger(balance) || !Number.isSafeInteger(balance+o.amount))throw Error('Saldo pembeli perlu diperiksa.');
    db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(o.discord_id,o.amount);
    restoreQuantity(o);db.prepare("UPDATE manual_product_orders SET state='refunded',admin_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(user,id);audit(user,'Refund pesanan manual '+id);return getOrder(user,id,true);
  });
  return {catalog,search,product,preview,testPreview,remove,save,quote,buy,orders,getOrder,finish,refund,stockCount,sellStock,stocks,stock,saveStock,saveWithStock,createWithStock,toggleAuto,createQR,refresh,fulfillPayment,poll,notify,setNotifier:fn=>notifier=fn,orderByInvoice:(user,id)=>{const o=db.prepare('SELECT * FROM manual_product_orders WHERE invoice_id=? AND discord_id=?').get(id,user);if(!o)throw Error('Tagihan tidak ditemukan.');return o;},payment:o=>payments?.get(o.invoice_id,o.discord_id),qrisConfigured:()=>!!payments?.configured};
}

function createManualProductsHandler({discord,model,staff,sendDM=async()=>{},premium,language=()=>'id'}) {
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const button=(id,label,style=2)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style);
  const row=(...buttons)=>new ActionRowBuilder().addComponents(...buttons);
  const t=(user,id,en)=>language(user)==='en'?en:id;
  const status=o=>({awaiting_payment:'Menunggu pembayaran QRIS',expired:'Tagihan tidak aktif',pending:'Menunggu admin',completed:'Selesai',refunded:'Dibatalkan • saldo dikembalikan'}[o.state]);
  const embed=(title,description)=>new EmbedBuilder().setTitle(title).setColor(0x5865F2).setDescription(description);
  const home=admin=>button(admin?'admin_home':'shop_home',admin?'Menu Awal Admin':'Menu Awal',1);
  function catalog(user,p,admin) {
    const data=model.catalog(user,p,admin),components=[];
    for(let n=0;n<data.rows.length;n+=5)components.push(row(...data.rows.slice(n,n+5).map(x=>button(`${admin?'admin_manual_detail':'manual_detail'}:${x.id}`,x.name))));
    components.push(row(button(`${admin?'admin_manual_catalog':'manual_catalog'}:${data.page-1}`,'Sebelumnya',1).setDisabled(data.page===0),button(`${admin?'admin_manual_catalog':'manual_catalog'}:${data.page+1}`,'Berikutnya',1).setDisabled(data.page===data.pages-1),...(admin?[button('admin_manual_add','Tambah Produk',3)]:[]),button(admin?'admin_catalog_manual':'manual_back','Kembali',1),home(admin)));
    if(admin)components.push(row(button('admin_manual_search','Cari Produk',1)));
    return {content:'',embeds:[embed('📦 Produk Manual',`${data.count?'Pilih produk di bawah.':'Belum ada produk manual tersedia.'}\n\nPembayaran saldo atau QRIS. Produk dengan stok otomatis dikirim setelah pembayaran terverifikasi.\nHalaman ${data.page+1}/${data.pages} • ${data.count} produk`)],components};
  }
  function searchView(user,key,page,query){const r=model.search(user,key,page,query);return {content:`**Hasil Pencarian Produk**\nKata: ${safe(r.query)}\nHalaman ${r.page+1}/${r.pages} • ${r.count} hasil\n${r.count?'Pilih produk atau varian untuk mengelolanya.':'Tidak ada produk yang cocok.'}`,allowedMentions:{parse:[]},embeds:[],components:[...(r.rows.length?[row(...r.rows.map(p=>button('admin_manual_detail:'+p.id,p.name,2)))]:[]),row(button('admin_manual_search_page:'+r.key+':'+(r.page-1),'Sebelumnya',1).setDisabled(!r.page),button('admin_manual_search_page:'+r.key+':'+(r.page+1),'Berikutnya',1).setDisabled(r.page===r.pages-1),button('admin_manual_search','Cari Lagi',1)),row(button('admin_manual_catalog:0','Kembali',1),home(true))]};}
  function detail(p,admin,user) {
    const extras=premium?`\n${p.duration_days?t(user,'Masa aktif: ','Validity: ')+p.duration_days+t(user,' hari setelah pesanan selesai.\n',' days after order completion.\n'):''}${p.warranty_days?t(user,'Garansi: ','Warranty: ')+p.warranty_days+t(user,' hari setelah pesanan selesai.\n',' days after order completion.\n'):''}`:'';
    const components=[admin?row(button('admin_manual_edit:'+p.id,'Ubah Produk',1),button('admin_manual_delivery_data:'+p.id+':0','Data & Stok',1),button('admin_manual_settings:'+p.id,'Pengaturan',1)):row(button('manual_quote:'+p.id,'Beli Produk',3))];
    if(premium&&!admin){const actions=[];if(!p.parent_id&&premium.variants('',p.id).count)actions.push(button('premium_variants:'+p.id+':0','Pilih Varian',2));if(!premium.available(p.id))actions.push(button('premium_watch:'+p.id,'Notifikasi Stok',1));if(actions.length)components.push(row(...actions));}
    components.push(row(button(p.parent_id?(admin?'admin_premium_variants:':'premium_variants:')+p.parent_id+':0':admin?'admin_manual_catalog:0':'manual_catalog:0','Kembali',1),home(admin)));
    return {content:'',embeds:[embed('📦 '+p.name,`${safe(p.description)}\n\n${t(user,'Harga jual: **','Selling price: **')}${money(p.price)}**\n${t(user,'Status pengiriman: ','Delivery: ')}${p.auto_enabled?t(user,'Otomatis','Automatic'):t(user,'Diproses admin','Processed by admin')}\n${p.auto_enabled||admin?t(user,'Stok jual: ','Sale stock: ')+model.sellStock(p)+'\n':''}${admin?`${t(user,'Status: ','Status: ')}${p.enabled?t(user,'Aktif','Active'):t(user,'Nonaktif','Inactive')}`:t(user,'Data dikirim setelah pembayaran terverifikasi.','Data is delivered after payment verification.')}${extras}`)],components};
  }
  function order(o,admin,user=o.discord_id) {return {content:`${t(user,'Pembeli: ','Customer: ')}${buyerLabel(o.discord_id)}\n\n**${t(user,'Pesanan Manual #','Digital Order #')}${o.id}**\n${t(user,'Produk: ','Product: ')}${safe(o.product_name)}\n${t(user,'Harga: ','Price: ')}${money(o.amount)}\n${t(user,'Pembayaran: ','Payment: ')}${o.payment_method==='qris'?'QRIS':t(user,'Saldo','Balance')}\n${t(user,'Status: ','Status: ')}${language(user)==='en'?({awaiting_payment:'Awaiting QRIS payment',expired:'Invoice inactive',pending:'Awaiting admin',completed:'Completed',refunded:'Cancelled • refunded to balance'}[o.state]||o.state):status(o)}\n${premium&&o.expires_ms?t(user,'Masa aktif berakhir: <t:','Valid until: <t:')+Math.floor(o.expires_ms/1000)+':F>\n':''}${premium&&o.warranty_ms?t(user,'Garansi sampai: <t:','Warranty until: <t:')+Math.floor(o.warranty_ms/1000)+':F>\n':''}`,allowedMentions:{parse:[]},embeds:[o.delivery?embed(t(user,'Hasil / keterangan pengiriman','Delivery Details'),safe(o.delivery)):embed(t(user,'Detail Produk','Product Details'),safe(o.description)),...(premium&&o.state==='completed'&&o.guide_snapshot?[embed(t(user,'Panduan Penggunaan','Usage Guide'),safe(o.guide_snapshot))]:[])],components:[...(premium&&!admin&&o.state==='completed'&&o.warranty_ms?[row(button('premium_claim:'+o.id,'Klaim Garansi',1))]:[]),...(o.state==='awaiting_payment'?[row(button((admin?'admin_manual_payment_check:':'manual_payment_check:')+o.id,'Cek QRIS & Pesanan',3))]:[]),...(admin&&o.state==='pending'?[row(button('admin_manual_deliver:'+o.id,'Kirim / Selesaikan',3),button('admin_manual_refund_confirm:'+o.id,'Batalkan & Refund',4))]:[]),row(button(admin?'admin_manual_orders:0':'shop_orders','Kembali',1),home(admin))]};}
  function orders(user,p,admin) {const data=model.orders(user,p,admin),components=[];
    for(let n=0;n<data.rows.length;n+=5)components.push(row(...data.rows.slice(n,n+5).map(o=>button(`${admin?'admin_manual_order':'manual_order'}:${o.id}`,`${o.product_name} • ${status(o)} • ${money(o.amount)}`))));
    components.push(row(button(`${admin?'admin_manual_orders':'manual_orders'}:${data.page-1}`,'Sebelumnya',1).setDisabled(data.page===0),button(`${admin?'admin_manual_orders':'manual_orders'}:${data.page+1}`,'Berikutnya',1).setDisabled(data.page===data.pages-1),button(admin?'admin_payment_requests':'manual_catalog:0','Kembali',1),home(admin)));
    return {content:`**Pesanan Produk Manual**\n${data.count?'Pilih pesanan untuk melihat detail.':'Belum ada pesanan.'}\nHalaman ${data.page+1}/${data.pages} • ${data.count} pesanan`,embeds:[],components};
  }
  function editView(p,user){
    return {content:'',embeds:[embed('Ubah Produk • '+p.name,`Deskripsi:\n${safe(p.description)}\n\nHarga jual: ${money(p.price)}\nModal per unit: ${p.cost===null?'Belum diisi':money(p.cost)}`)],components:[row(button('admin_manual_data:'+p.id,'Nama & Deskripsi',1),button('admin_manual_price:'+p.id,'Harga & Modal',3)),row(button('admin_manual_detail:'+p.id,'Kembali',1),home(true))]};
  }
  function settingsView(p){
    return {content:'',embeds:[embed('Pengaturan • '+p.name,`Produk: **${p.enabled?'Aktif':'Nonaktif'}**\nPengiriman: **${p.auto_enabled?'Otomatis':'Diproses admin'}**\n\nAtur status, pengiriman, dan tes produk di sini.`)],components:[row(button('admin_manual_toggle:'+p.id,p.enabled?'Nonaktifkan Produk':'Aktifkan Produk',p.enabled?4:3),button('admin_manual_auto:'+p.id,p.auto_enabled?'Matikan Kirim Otomatis':'Aktifkan Kirim Otomatis',1)),row(...(premium?[button('admin_premium_menu:'+p.id,p.parent_id?'Panduan & Garansi':'Varian, Panduan & Garansi',1)]:[]),button('admin_manual_test:'+p.id,'Tes Beli',1)),row(button('admin_manual_delete_confirm:'+p.id,'Hapus Produk',4)),row(button('admin_manual_detail:'+p.id,'Kembali',1),home(true))]};
  }
  function deliveryDataView(user,id,page=0){
    const p=model.product(id),data=model.stocks(user,id,page,true),components=[];
    for(let n=0;n<data.rows.length;n+=5)components.push(row(...data.rows.slice(n,n+5).map(s=>button('admin_manual_stock_edit:'+s.id,`Data Produk #${s.id}`,2))));
    components.push(row(button('admin_manual_delivery_data:'+id+':'+(data.page-1),'Sebelumnya',1).setDisabled(data.page===0),button('admin_manual_delivery_data:'+id+':'+(data.page+1),'Berikutnya',1).setDisabled(data.page===data.pages-1),button('admin_manual_detail:'+id,'Kembali',1),home(true)));
    components.push(row(button('admin_manual_stock_add:'+id,'Tambah Data Produk',3),button('admin_manual_quantity:'+id,'Atur Stok Jual',1),button('admin_manual_preview:'+id,'Pratinjau Pesan',1)));
    return {content:'',embeds:[embed('Data Produk • '+p.name,`Stok jual: **${model.sellStock(p)}**\nData siap kirim: **${data.count}**\n\n${data.count?'Pilih data untuk mengubah akun atau kode.':'Belum ada data siap kirim. Tekan Tambah Data Produk.'}\nSatu data unik untuk satu pembeli.\nHalaman ${data.page+1}/${data.pages}`)],components};
  }
  function modal(id,title,fields){return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...fields.map(([key,label,value,max,long,required=true])=>{const input=new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(long?TextInputStyle.Paragraph:TextInputStyle.Short).setRequired(required).setMaxLength(max);if(String(value))input.setValue(String(value));return row(input);}));}

  function paymentView(o,p){if(o.state!=='awaiting_payment')return order(o,false);const response=order(o,false),user=o.discord_id;
    response.content+='\n'+t(user,'Tagihan: ','Invoice: ')+o.invoice_id+'\n'+t(user,'Status pembayaran: ','Payment status: ')+(p?.status||t(user,'belum terkonfirmasi','unconfirmed'))+'\n'+t(user,'Jangan membuat pembayaran ulang.','Do not create another payment.');
    if(p?.qr_url)response.embeds=[embed(t(user,'QRIS Produk Lainnya','Digital Product QRIS'),`${t(user,'Harga produk: ','Product price: ')}${money(o.amount)}\n${t(user,'Biaya pembeli: ','Customer fee: ')}${money(p.fee_customer||0)}\n${t(user,'Total bayar: ','Payment total: ')}**${money(p.total_charge||o.amount)}**\n${p.production?t(user,'Pindai QRIS untuk membayar.','Scan QRIS to pay.'):t(user,'MODE UJI — gunakan simulator ','TEST MODE — use the simulator ')+(p.gateway==='midtrans'?'Midtrans':'TriPay')+'.'}\n${o.automatic?t(user,'Data dikirim otomatis setelah pembayaran lunas.','Data is delivered automatically after full payment.'):t(user,'Produk ini diproses admin setelah pembayaran lunas.','An admin processes this product after full payment.')}`).setImage(p.qr_url)];return response;}
  model.setNotifier(o=>sendDM(o.discord_id,order(o,false),o));
  async function notify(o){await model.notify(o);return !!model.getOrder(o.discord_id,o.id).notified;}
  return async function handle(i) {
    const id=String(i.customId || ''),admin=id.startsWith('admin_manual_');
    if(id.startsWith('manual_orders:'))return false; // Legacy buttons are handled by unified order history.
    if(!admin && !id.startsWith('manual_') && id!=='shop_manual_products')return false;
    if(admin&&!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    const user=i.user.id,parts=id.split(':'),key=parts[0],arg=parts[1];
    try {
      if(i.isModalSubmit()) {
        const value=k=>i.fields.getTextInputValue(k);
        if(key==='admin_manual_search_submit'){await i.reply({ephemeral:true,...searchView(user,null,0,value('query'))});}
        else if(key==='admin_manual_save') {
          let body='';try{body=value('stock');}catch{}
          let quantity;try{quantity=value('quantity');}catch{}const p=model.createWithStock(user,{name:value('name'),description:value('description'),price:value('price'),enabled:1,quantity},body,i.id);await i.reply({ephemeral:true,...detail(p,true,user)});
        }else if(key==='admin_manual_data_save' || key==='admin_manual_price_save') {
          const old=model.product(arg);let p;if(key==='admin_manual_data_save'){let body='',quantity=old.quantity;try{body=value('stock');}catch{}try{const raw=value('quantity');if(raw!==undefined)quantity=raw;}catch{}p=model.saveWithStock(user,arg,{...old,name:value('name'),description:value('description'),quantity},body,i.id);}else {let cost=old.cost;try{cost=value('cost');}catch{}p=model.save(user,arg,{...old,price:value('price'),cost});}await i.reply({ephemeral:true,...editView(p,user)});
        }else if(key==='admin_manual_quantity_save') {
          const p=model.product(arg);model.save(user,arg,{...p,quantity:value('quantity')});await i.reply({ephemeral:true,...deliveryDataView(user,arg)});
        }else if(key==='admin_manual_stock_save') {
          const stockId=parts[2];model.saveStock(user,arg,stockId || null,value('body'));await i.reply({ephemeral:true,...deliveryDataView(user,arg)});
        }else if(key==='manual_qris_email') {
          await i.deferReply({ephemeral:true});const result=await model.createQR(user,arg,{email:value('email'),name:i.user.username});await i.editReply(paymentView(result.order,result.payment));
        }else if(key==='admin_manual_deliver_save') {
          const o=model.finish(user,arg,value('delivery'));await i.reply({ephemeral:true,...order(o,true,user)});const sent=await notify(o);if(!sent)await i.followUp({ephemeral:true,content:'DM pembeli tidak terkirim. Hasil tetap tersimpan dan bisa dibaca di Pesanan → Riwayat Pesanan.'});
        }else throw Error('Form produk manual tidak dikenali.');
        return true;
      }
      if(!i.isButton())return false;
      if(id==='shop_manual_products')await i.reply({ephemeral:true,...catalog(user,0,false)});
      else if(key==='manual_catalog' || key==='admin_manual_catalog')await i.update(catalog(user,Number(arg),admin));
      else if(key==='admin_manual_orders')await i.reply({ephemeral:true,...orders(user,Number(arg),admin)});
      else if(key==='manual_detail' || key==='admin_manual_detail'){const p=model.product(arg);if(!admin&&!p.enabled)throw Error('Produk sedang nonaktif.');await i.update(detail(p,admin,user));}
      else if(id==='admin_manual_search')await i.showModal(modal('admin_manual_search_submit','Cari Produk',[['query','Nama produk / varian','',80]]));
      else if(key==='admin_manual_search_page')await i.update(searchView(user,arg,Number(parts[2]||0)));
      else if(id==='admin_manual_add')await i.showModal(modal('admin_manual_save','Tambah Produk Manual',[['name','Nama produk','Produk baru',80],['quantity','Jumlah stok jual (angka)','1',7],['stock','Data DM unik: 1 akun/kode (opsional)','',1000,true,false],['description','Deskripsi & waktu proses','Jelaskan produk dan perkiraan waktu proses.',800,true],['price','Harga jual IDR, tanpa titik','5000',7]]));
      else if(key==='admin_manual_delete_confirm'){const p=model.product(arg);await i.reply({ephemeral:true,content:`Hapus produk **${safe(p.name)}** dari katalog?\nRiwayat pesanan tetap tersimpan. Tagihan QRIS yang sudah dibuat tetap diproses sesuai pesanan.`,allowedMentions:{parse:[]},components:[row(button('admin_manual_delete:'+p.id,'Ya, Hapus Produk',4),button('admin_manual_settings:'+p.id,'Batal',1),home(true))]});}
      else if(key==='admin_manual_delete'){model.remove(user,arg);await i.update(catalog(user,0,true));}
      else if(key==='admin_manual_settings')await i.update(settingsView(model.product(arg)));
      else if(key==='admin_manual_edit')await i.update(editView(model.product(arg),user,Number(parts[2] || 0)));
      else if(key==='admin_manual_data' || key==='admin_manual_price'){const p=model.product(arg);await i.showModal(key==='admin_manual_data'?modal('admin_manual_data_save:'+p.id,'Ubah Produk',[['name','Nama produk',p.name,80],['description','Deskripsi & waktu proses',p.description,800,true]]):modal('admin_manual_price_save:'+p.id,'Harga & Modal',[['price','Harga jual IDR, tanpa titik',p.price,7],['cost','Modal/unit IDR (kosong = belum tahu)',p.cost??'',7,false,false]]));}
      else if(key==='admin_manual_quantity'){const p=model.product(arg);await i.showModal(modal('admin_manual_quantity_save:'+p.id,'Atur Stok Jual',[['quantity','Jumlah stok jual tersedia (angka)',p.quantity??(p.auto_enabled?model.stockCount(p.id):0),7]]));}
      else if(key==='admin_manual_delivery_data')await i.update(deliveryDataView(user,arg,Number(parts[2] || 0)));
      else if(key==='admin_manual_stock')await i.reply({ephemeral:true,...deliveryDataView(user,arg,Number(parts[2] || 0))});
      else if(key==='admin_manual_stock_add')await i.showModal(modal('admin_manual_stock_save:'+arg,'Tambah Data Produk',[['body','Akun/kode unik untuk satu pembeli','',1000,true]]));
      else if(key==='admin_manual_stock_edit'){const s=model.stock(user,arg);if(s.state!=='available')throw Error('Stok sudah dialokasikan atau terjual.');await i.showModal(modal('admin_manual_stock_save:'+s.product_id+':'+s.id,'Ubah Data Produk',[['body','Akun/kode unik untuk satu pembeli',s.body,1000,true]]));}
      else if(key==='admin_manual_test'){
        const t=model.testPreview(user,arg),p=t.product;
        await i.reply({ephemeral:true,content:`**🧪 Tes Beli Admin • ${safe(p.name)}**\nHarga jual: ${money(p.price)}\nStok jual: ${t.quantity}\nData siap kirim: ${t.dataCount}\nMetode pembeli: saldo${model.qrisConfigured()&&p.price>=1000?' / QRIS':''}\n\n${t.ready?'Pengiriman otomatis siap diuji. Tekan tombol di bawah untuk mengirim contoh data ke DM Anda.':safe(t.reason)}\n\nIni simulasi: tidak membuat tagihan, memotong saldo, mengurangi stok, atau mencatat pesanan penjualan.`,allowedMentions:{parse:[]},components:[row(button('admin_manual_test_dm:'+p.id,'Kirim Tes ke DM Saya',3).setDisabled(!t.ready),button('admin_manual_settings:'+p.id,'Kembali',1),home(true))]});
      }
      else if(key==='admin_manual_test_dm'){
        const t=model.testPreview(user,arg);if(!t.ready)throw Error(t.reason);
        await i.deferReply({ephemeral:true});
        try{
          await sendDM(user,{content:'🧪 **TES ADMIN — BUKAN PESANAN PENJUALAN**',embeds:[embed('Data Produk • '+t.product.name,`Harga jual: ${money(t.product.price)}\n\n${safe(t.body)}\n\nData ini hanya contoh tes dan tetap tersedia untuk pembeli. Stok dan saldo tidak berubah.`)],allowedMentions:{parse:[]},components:[row(button('admin_manual_settings:'+t.product.id,'Kembali',1),home(true))]});
          await i.editReply({content:'✅ Contoh Data Produk berhasil dikirim ke DM Anda. Stok dan saldo tetap sama.',components:[row(button('admin_manual_settings:'+t.product.id,'Kembali',1),home(true))]});
        }catch{
          await i.editReply({content:'DM tes tidak terkirim. Aktifkan izin DM dari anggota server, lalu coba lagi. Stok dan saldo tetap sama.',components:[row(button('admin_manual_test:'+t.product.id,'Coba Lagi',1),button('admin_manual_settings:'+t.product.id,'Kembali',1),home(true))]});
        }
      }
      else if(key==='admin_manual_auto')await i.update(settingsView(model.toggleAuto(user,arg)));
      else if(key==='admin_manual_toggle'){const p=model.product(arg);await i.update(settingsView(model.save(user,arg,{...p,enabled:p.enabled?0:1})));}
      else if(key==='admin_manual_preview'){
        const t=model.preview(user,arg);
        await i.reply({ephemeral:true,content:'Pratinjau pribadi admin. Data tetap tersedia; belum ada pesan dikirim ke pembeli.',embeds:[embed('Hasil / keterangan pengiriman',safe(t.body))],allowedMentions:{parse:[]},components:[row(button('admin_manual_delivery_data:'+t.product.id+':0','Kembali',1),home(true))]});
      }
      else if(key==='manual_quote'||key==='manual_repeat'){
        const productId=key==='manual_repeat'?model.getOrder(user,arg).product_id:arg;
        const p=model.quote(user,productId);await i.update({content:'',embeds:[embed(t(user,'Konfirmasi Pembelian Manual','Confirm Digital Purchase'),`${t(user,'Pembeli: ','Customer: ')}${buyerLabel(user)}\n${t(user,'Produk: ','Product: ')}${safe(p.name)}\n${safe(p.description)}\n\n${t(user,'Harga: ','Price: ')}**${money(p.price)}**\n${premium&&p.duration_days?t(user,'Masa aktif: ','Validity: ')+p.duration_days+t(user,' hari.\n',' days.\n'):''}${premium&&p.warranty_days?t(user,'Garansi: ','Warranty: ')+p.warranty_days+t(user,' hari.\n',' days.\n'):''}${t(user,'Pilih pembayaran saldo atau QRIS. ','Choose balance or QRIS payment. ')}${p.auto_enabled?t(user,'Data dikirim otomatis setelah pembayaran terverifikasi.','Data is delivered automatically after payment verification.'):t(user,'Admin akan memproses pesanan setelah pembayaran.','An admin processes your order after payment.')} ${t(user,'Konfirmasi berlaku 15 menit.','Confirmation is valid for 15 minutes.')}`)],allowedMentions:{parse:[]},components:[row(button('manual_buy:'+p.token,'Bayar Saldo',3),button('manual_qris:'+p.token,'Bayar QRIS',3).setDisabled(!model.qrisConfigured()||p.price<1000),button('manual_detail:'+p.id,'Kembali',1),home(false))]});}
      else if(key==='manual_buy'){const o=model.buy(user,arg);await i.update(order(o,false));await model.notify(o);}
      else if(key==='manual_qris')await i.showModal(modal('manual_qris_email:'+arg,'Email Pembayaran QRIS',[['email','Alamat email tagihan','',254]]));
      else if(key==='manual_invoice_check'){await i.deferReply({ephemeral:true});const current=model.orderByInvoice(user,arg);const o=await model.refresh(user,current.id);await i.editReply(paymentView(o,model.payment(o)));}
      else if(key==='admin_manual_payment_check'){await i.deferReply({ephemeral:true});const current=model.getOrder(user,arg,true),o=await model.refresh(current.discord_id,arg);if(!staff.isAdmin(user))throw Error('Akses ditolak.');await i.editReply(order(o,true,user));}
      else if(key==='manual_payment_check'){await i.deferReply({ephemeral:true});const o=await model.refresh(user,arg);await i.editReply(paymentView(o,model.payment(o)));}
      else if(key==='manual_order' || key==='admin_manual_order')await i.reply({ephemeral:true,...order(model.getOrder(user,arg,admin),admin,user)});
      else if(key==='admin_manual_deliver'){model.getOrder(user,arg,true);await i.showModal(modal('admin_manual_deliver_save:'+arg,'Kirim Produk Manual',[['delivery','Hasil / keterangan pengiriman','Pesanan Anda telah diproses.',1000,true]]));}
      else if(key==='admin_manual_refund_confirm'){const o=model.getOrder(user,arg,true);if(o.state!=='pending')throw Error('Pesanan sudah diproses.');await i.reply({ephemeral:true,content:`Batalkan pesanan ${safe(o.product_name)} dan kembalikan ${money(o.amount)} ke saldo pembeli?`,components:[row(button('admin_manual_refund:'+arg,'Ya, Batalkan & Refund',4),button('admin_manual_order:'+arg,'Kembali',1),home(true))]});}
      else if(key==='admin_manual_refund'){const o=model.refund(user,arg);await i.update(order(o,true,user));const sent=await notify(o);if(!sent)await i.followUp({ephemeral:true,content:'Refund tersimpan. DM tidak terkirim; pembeli dapat melihat hasil di Pesanan Manual.'});}
      else throw Error('Menu produk manual tidak dikenali.');
    }catch(e){
      const insufficient=!admin&&/saldo tidak cukup/i.test(e.message);
      const contactId=insufficient?(staff.contactIds?staff.contactIds(i.guildId)[0]:staff.list?.().find(s=>s.owner)?.id):null;
      const owner=contactId&&/^\d{17,20}$/.test(contactId)?{id:contactId}:null;
      const contact=owner?new ButtonBuilder().setLabel('Hubungi Admin').setStyle(5).setURL('https://discord.com/users/'+owner.id):null;
      const payload={ephemeral:true,content:e.message+(insufficient&&!contact&&i.guildId?' Kontak admin server belum diatur oleh owner.':'')+(contact?' Tekan Hubungi Admin untuk isi saldo melalui DM.':''),allowedMentions:{parse:[]},components:[row(...(admin?[button('admin_manual_orders:0','Pesanan Manual',1)]:[]),...(contact?[contact]:[]),home(admin))]};if(i.deferred&&!i.replied)await i.editReply(payload);else if(i.replied)await i.followUp(payload);else await i.reply(payload);
    }
    return true;
  };
}
module.exports={createManualProducts,createManualProductsHandler};
