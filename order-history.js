const {errorText}=require('./languages');
const {orderProgress,progressText}=require('./shop-improvements');
const safe=s=>String(s??'').replace(/([\\`*_~|<>\[\]])/g,'\\$1');
const money=n=>Number(n||0).toLocaleString('id-ID')+' IDR';

// QRIS OTP invoices that have created an OTP order appear once, on that order.
const union=`SELECT 'otp:'||o.id AS key,'otp' AS kind,
 COALESCE(NULLIF(o.product_name,''),p.name,'OTP') AS name,o.amount,o.status AS state,o.created_at,
 (SELECT d.invoice_id FROM direct_purchases d WHERE d.discord_id=o.discord_id AND d.provider_order_id=o.provider_order_id LIMIT 1) AS invoice
 FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.discord_id=?
 UNION ALL SELECT 'digital:'||m.id,'digital',m.product_name,m.amount,m.state,m.created_at,m.invoice_id
 FROM manual_product_orders m WHERE m.discord_id=?
 UNION ALL SELECT 'invoice:'||d.invoice_id,'otp',d.name,d.amount,d.state,d.created_at,d.invoice_id
 FROM direct_purchases d WHERE d.discord_id=? AND NOT EXISTS
 (SELECT 1 FROM orders o WHERE o.discord_id=d.discord_id AND o.provider_order_id=d.provider_order_id)`;

function createOrderHistory({db,now=Date.now}){
 const searches=new Map();
 function list(user,requested=0,filter='all',criteria=null){
  if(!['all','otp'].includes(filter))throw Error('Kategori tidak dikenal.');
  const args=[user,user,user],conditions=filter==='otp'?["kind='otp'"]:[];
  if(criteria){if(criteria.invoice){conditions.push("instr(lower(COALESCE(invoice,CASE WHEN kind='otp' THEN 'SALDO-OTP-' ELSE 'SALDO-PRODUK-' END||substr(key,instr(key,':')+1))),lower(?))>0");args.push(criteria.invoice);}if(criteria.product){conditions.push('instr(lower(name),lower(?))>0');args.push(criteria.product);}if(criteria.date){conditions.push("strftime('%Y-%m-%d',created_at,'+7 hours')=?");args.push(criteria.date);}}
  const query='SELECT * FROM ('+union+')'+(conditions.length?' WHERE '+conditions.join(' AND '):'');
  const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get(...args).n;
  const pages=Math.max(1,Math.ceil(count/5)),page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);
  return {count,pages,page,rows:db.prepare(query+' ORDER BY created_at DESC,key DESC LIMIT 5 OFFSET ?').all(...args,page*5)};
 }
 function detail(user,key){
  const [type,...parts]=String(key).split(':'),id=parts.join(':');let row;
  if(type==='digital'){
   row=db.prepare('SELECT * FROM manual_product_orders WHERE id=? AND discord_id=?').get(id,user);
   if(row)return {...row,key,kind:'digital',name:row.product_name,status:row.state,invoice:row.invoice_id,receipt:row.invoice_id||'SALDO-PRODUK-'+row.id};
  }else if(type==='otp'){
   row=db.prepare('SELECT o.*,p.name AS local_name FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.id=? AND o.discord_id=?').get(id,user);
   if(row){const d=db.prepare('SELECT invoice_id FROM direct_purchases WHERE provider_order_id=? AND discord_id=? ORDER BY created_at DESC LIMIT 1').get(row.provider_order_id,user);
    return {...row,key,kind:'otp',name:row.product_name||row.local_name||'OTP',invoice:d?.invoice_id,payment_method:d?'qris':'balance',receipt:d?.invoice_id||'SALDO-OTP-'+row.id};}
  }else if(type==='invoice'){
   row=db.prepare('SELECT * FROM direct_purchases WHERE invoice_id=? AND discord_id=?').get(id,user);
   if(row)return {...row,key,kind:'otp',status:row.state,invoice:row.invoice_id,payment_method:'qris',receipt:row.invoice_id};
  }
  throw Error('Pesanan tidak ditemukan.');
 }
 function search(user,key,page=0,criteria=null,filter='all',mode='orders'){
  for(const [k,v] of searches)if(now()-v.created>15*60000)searches.delete(k);
  if(criteria){criteria=Object.fromEntries(['invoice','product','date'].map(k=>[k,String(criteria[k]||'').trim()]));
   if(!Object.values(criteria).some(Boolean))throw Error('Isi invoice, nama produk, atau tanggal.');
   if(criteria.invoice.length>100||criteria.product.length>80)throw Error('Pencarian terlalu panjang.');
   if(criteria.date&&(!/^\d{4}-\d{2}-\d{2}$/.test(criteria.date)||!Number.isFinite(Date.parse(criteria.date+'T00:00:00Z'))||new Date(criteria.date+'T00:00:00Z').toISOString().slice(0,10)!==criteria.date))throw Error('Tanggal harus YYYY-MM-DD (WIB).');
   if(!['all','otp'].includes(filter)||!['orders','invoices'].includes(mode))throw Error('Menu tidak dikenal.');
   for(const [k,v] of searches)if(v.user===user)searches.delete(k);
   key=require('node:crypto').randomUUID();searches.set(key,{user,criteria,filter,mode,created:now()});
  }
  const session=searches.get(key);if(!session||session.user!==user)throw Error('Pencarian kedaluwarsa. Tekan Cari Pesanan kembali.');
  return {...list(user,page,session.filter,session.criteria),key,filter:session.filter,mode:session.mode};
 }
 return {list,detail,search};
}

function createOrderHistoryHandler({discord,model,payments,premium,language=()=>'id'}){
 const {ActionRowBuilder,ButtonBuilder,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
 const t=(user,id,en)=>language(user)==='en'?en:id;
 const button=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0,80)).setStyle(style);
 const row=(...items)=>new ActionRowBuilder().addComponents(...items);
 function view(user,page,filter,mode,search=null){
  const r=search||model.list(user,page,filter),components=[];
  const pageId=n=>search?`history_search_page:${r.key}:${n}`:`history_list:${filter}:${mode}:${n}`;
  if(r.rows.length)components.push(row(...r.rows.map(o=>button('history_detail:'+o.key,(o.kind==='otp'?'OTP • ':'Produk • ')+o.name))));
  components.push(row(button(pageId(r.page-1),'Sebelumnya').setDisabled(r.page===0),button(pageId(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1),button('history_search:'+filter+':'+mode,'Cari Pesanan')));
  components.push(row(button('history_list:all:orders:0','Riwayat Pesanan'),button('history_list:all:invoices:0','Invoice'),button('history_list:otp:orders:0','Riwayat OTP'),button('shop_home','Menu Awal')));
  return {content:`**${mode==='invoices'?t(user,'🧾 Invoice & Bukti Transaksi','🧾 Invoices & Receipts'):filter==='otp'?t(user,'🔢 Riwayat OTP','🔢 OTP History'):t(user,'📦 Riwayat Pesanan','📦 Order History')}**\n${r.count?t(user,'Pilih pesanan untuk melihat invoice, status, dan hasil.','Choose an order to view its invoice, status and delivery.'):t(user,'Belum ada pesanan.','No orders yet.')}\n${t(user,'Halaman ','Page ')}${r.page+1}/${r.pages} • ${r.count} ${t(user,'pesanan','orders')}\n\n`+r.rows.map(o=>`**${safe(o.name)}** • ${o.kind==='otp'?'OTP':t(user,'Produk Digital','Digital Product')}\n${money(o.amount)} • ${safe(o.state)}\n${mode==='invoices'?t(user,'Invoice / bukti: ','Invoice / receipt: ')+safe(o.invoice||(o.kind==='otp'?'SALDO-OTP-':'SALDO-PRODUK-')+o.key.split(':').slice(1).join(':'))+'\n':''}${t(user,'Tanggal: ','Date: ')}${safe(o.created_at)} UTC`).join('\n\n'),allowedMentions:{parse:[]},components};
 }
 return async i=>{
  const id=String(i.customId||'');
  if(id.startsWith('history_search:')){const [,filter,mode]=id.split(':');await i.showModal(new ModalBuilder().setCustomId('history_search_submit:'+filter+':'+mode).setTitle('Cari Pesanan').addComponents(...[['invoice','Invoice / bukti transaksi (opsional)',100],['product','Nama produk (opsional)',80],['date','Tanggal WIB YYYY-MM-DD (opsional)',10]].map(([key,label,max])=>row(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(max)))));return true;}
  if(!['shop_orders','shop_order_history','direct_history'].includes(id)&&!id.startsWith('manual_orders:')&&!id.startsWith('history_list:')&&!id.startsWith('history_detail:')&&!id.startsWith('history_search_submit:')&&!id.startsWith('history_search_page:'))return false;
  await i.deferReply({ephemeral:true});
  try{
   if(id.startsWith('history_search_submit:')||id.startsWith('history_search_page:')){const parts=id.split(':'),r=id.startsWith('history_search_submit:')?model.search(i.user.id,null,0,{invoice:i.fields.getTextInputValue('invoice'),product:i.fields.getTextInputValue('product'),date:i.fields.getTextInputValue('date')},parts[1],parts[2]):model.search(i.user.id,parts[1],Number(parts[2]));await i.editReply(view(i.user.id,r.page,r.filter,r.mode,r));}
   else if(!id.startsWith('history_detail:')){
    const parts=id.split(':'),filter=id==='shop_order_history'?'otp':id.startsWith('history_list:')?parts[1]:'all',mode=id==='direct_history'?'invoices':id.startsWith('history_list:')?parts[2]:'orders';
    if(!['orders','invoices'].includes(mode))throw Error('Menu tidak dikenal.');
    await i.editReply(view(i.user.id,Number(id.startsWith('manual_orders:')?parts[1]:parts[3]||0),filter,mode));
   }else{
    const o=model.detail(i.user.id,id.slice('history_detail:'.length)),components=[],actions=[];
    let content=`**🧾 ${t(i.user.id,'Detail Pesanan','Order Details')} • ${safe(o.name)}**\n${t(i.user.id,'Invoice / bukti transaksi','Invoice / transaction receipt')}: ${safe(o.receipt)}\n${t(i.user.id,'Jenis','Type')}: ${o.kind==='otp'?'OTP':t(i.user.id,'Produk Digital','Digital Product')}\n${t(i.user.id,'Metode pembayaran','Payment method')}: ${o.payment_method==='qris'?'QRIS':t(i.user.id,'Saldo','Balance')}\n${t(i.user.id,'Harga produk','Product price')}: **${money(o.amount)}**\n${t(i.user.id,'Status pesanan','Order status')}: ${safe(o.status)}\n${t(i.user.id,'Tanggal','Date')}: ${safe(o.created_at)} UTC`;
    let verifiedPayment;
    if(o.invoice){let p;try{p=payments.get(o.invoice,i.user.id);}catch{}
     verifiedPayment=p;
     if(p)content+=`\n${t(i.user.id,'Status pembayaran','Payment status')}: ${safe(p.status)}\n${t(i.user.id,'Biaya pembeli','Customer fee')}: ${money(p.fee_customer)}\n${t(i.user.id,'Total tagihan','Invoice total')}: ${money(p.total_charge??o.amount)}`;
     actions.push(button((o.kind==='digital'?'manual_invoice_check:':'direct_check:')+o.invoice,'Cek Pembayaran & Pesanan',3));
    }else content+='\n'+t(i.user.id,'Bukti pembayaran saldo internal toko.','Internal store balance payment receipt.');
    content+='\n'+progressText(orderProgress(o,o.kind,verifiedPayment),language(i.user.id)==='en');
    if(o.kind==='digital'){
     if(o.state==='completed'&&o.delivery)content+=`\n\n**${t(i.user.id,'Data Produk','Product Data')}**\n${safe(o.delivery)}`;
     actions.push(button('manual_repeat:'+o.id,'Beli Lagi'));
     if(premium&&o.state==='completed'){if(o.expires_ms)content+='\n'+t(i.user.id,'Masa aktif berakhir','Valid until')+': <t:'+Math.floor(o.expires_ms/1000)+':F>';if(o.warranty_ms){content+='\n'+t(i.user.id,'Garansi sampai','Warranty until')+': <t:'+Math.floor(o.warranty_ms/1000)+':F>';actions.push(button('premium_claim:'+o.id,'Klaim Garansi'));}}
    }else if(o.provider_order_id){
     content+=`\nOrder OTP: ${safe(o.provider_order_id)}\n${t(i.user.id,'Nomor','Phone')}: ${safe(o.phone||'-')}\nOTP: ${safe(o.otp||t(i.user.id,'Belum diterima','Not received'))}`;
     actions.push(button('check_otp:'+o.provider_order_id,'Cek OTP',3));
     if(o.key.startsWith('otp:'))actions.push(button('buy_again:'+o.id,'Beli Lagi'));
    }
    if(actions.length)components.push(row(...actions));
    components.push(row(button('history_list:all:orders:0','Kembali'),button('shop_home','Menu Awal')));
    const guide=premium&&o.kind==='digital'&&o.state==='completed'&&o.guide_snapshot?[{title:t(i.user.id,'Panduan Penggunaan','Usage Guide'),description:safe(o.guide_snapshot)}]:[];
    // Long delivery data stays in a private embed, avoiding Discord's content limit.
    if(content.length>1900){const {EmbedBuilder}=discord;await i.editReply({content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('Detail Pesanan').setDescription(content),...guide],allowedMentions:{parse:[]},components});}
    else await i.editReply({content,embeds:guide,allowedMentions:{parse:[]},components});
   }
  }catch(e){await i.editReply({content:errorText(e,language(i.user.id)==='en'),embeds:[],allowedMentions:{parse:[]},components:[row(button('history_list:all:orders:0','Kembali'),button('shop_home','Menu Awal'))]});}
  return true;
 };
}
// Durable, redacted order receipts. Delivery secrets never enter this queue.
function createOrderChannel({db,staff,resolveChannel,send,now=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS order_channel_settings(id INTEGER PRIMARY KEY CHECK(id=1),guild_id TEXT,channel_id TEXT,enabled INTEGER NOT NULL DEFAULT 0,initialized INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO order_channel_settings(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS order_channel_receipts(order_key TEXT PRIMARY KEY,state TEXT NOT NULL,attempt_ms INTEGER NOT NULL DEFAULT 0,message_id TEXT);
 CREATE INDEX IF NOT EXISTS order_channel_pending ON order_channel_receipts(state,attempt_ms);`);
 const config=()=>db.prepare('SELECT * FROM order_channel_settings WHERE id=1').get();
 const owner=user=>{if(!staff.isOwner(user))throw Error('Pengaturan tujuan laporan hanya untuk owner.');};
 const columns=db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name);
 const digitalColumns=db.prepare('PRAGMA table_info(manual_product_orders)').all().map(c=>c.name);
 const otpDelivery=columns.includes('otp_notified')?"CASE WHEN (COALESCE(o.otp,'')<>'' AND o.otp_notified=o.otp)"+(columns.includes('otp_message')?" OR (COALESCE(o.otp,'')='' AND COALESCE(o.otp_message,'')<>'' AND o.otp_notified='message:'||o.otp_message)":'')+" THEN 'sent' ELSE 'pending_dm' END":"'pending_dm'";
 const digitalDelivery=digitalColumns.includes('notified')?"CASE WHEN m.notified=1 THEN 'sent' ELSE 'pending_dm' END":"'pending_dm'";
 const finished=`SELECT 'otp:'||o.id AS key,o.discord_id,COALESCE(NULLIF(o.product_name,''),p.name,'OTP') AS name,o.amount,o.created_at,
 COALESCE((SELECT d.invoice_id FROM direct_purchases d WHERE d.discord_id=o.discord_id AND d.provider_order_id=o.provider_order_id LIMIT 1),'SALDO-OTP-'||o.id) AS invoice,
 CASE WHEN EXISTS(SELECT 1 FROM direct_purchases d WHERE d.discord_id=o.discord_id AND d.provider_order_id=o.provider_order_id) THEN 'QRIS' ELSE 'Saldo' END AS method,'OTP' AS kind,${otpDelivery} AS delivery_state
 FROM orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.status IN ('OTP_RECEIVED','COMPLETED') ${columns.includes('refunded')?'AND o.refunded=0':''} ${columns.includes('is_owner_test')?'AND COALESCE(o.is_owner_test,0)=0':''}
 UNION ALL SELECT 'digital:'||m.id,m.discord_id,m.product_name,m.amount,m.created_at,COALESCE(m.invoice_id,'SALDO-PRODUK-'||m.id),CASE WHEN m.payment_method='qris' THEN 'QRIS' ELSE 'Saldo' END,'Produk Digital',${digitalDelivery}
 FROM manual_product_orders m WHERE m.state='completed'`;
 function discover(state='pending'){db.prepare('INSERT OR IGNORE INTO order_channel_receipts(order_key,state) SELECT key,? FROM ('+finished+')').run(state);}
 async function channel(guildId,channelId){const c=await resolveChannel(channelId);if(!c||c.guildId!==guildId||c.type!==0||!c.canReport)throw Error('Gunakan channel teks server yang bisa dilihat bot, dengan izin Kirim Pesan dan Embed Links.');return c;}
 const commit=db.transaction((guildId,channelId)=>{const old=config();if(!old.initialized)discover('skipped');db.prepare('UPDATE order_channel_settings SET guild_id=?,channel_id=?,enabled=1,initialized=1 WHERE id=1').run(guildId,channelId);});
 async function configure(user,guildId,channelId){owner(user);guildId=String(guildId).trim();channelId=String(channelId).trim();if(!/^\d{17,20}$/.test(guildId)||!/^\d{17,20}$/.test(channelId))throw Error('Isi ID server dan channel yang valid.');await channel(guildId,channelId);owner(user);commit(guildId,channelId);return config();}
 function disable(user){owner(user);db.prepare('UPDATE order_channel_settings SET enabled=0 WHERE id=1').run();}
 const backfill=db.transaction(user=>{owner(user);if(!config().enabled)throw Error('Atur channel tujuan terlebih dahulu.');discover();db.prepare("UPDATE order_channel_receipts SET state='pending',attempt_ms=0 WHERE state='skipped'").run();return stats();});
 function stats(){return {config:config(),pending:db.prepare("SELECT COUNT(*) n FROM order_channel_receipts WHERE state='pending'").get().n,sent:db.prepare("SELECT COUNT(*) n FROM order_channel_receipts WHERE state='sent'").get().n};}
 function payload(o){let username;try{username=db.prepare('SELECT username FROM buyer_profiles WHERE discord_id=?').get(o.discord_id)?.username;}catch{}
 return {embeds:[{color:0x00a65a,title:'🧾 Pesanan Selesai',description:`Pembeli: ${username?'@'+safe(username)+' • ':''}${safe(o.discord_id)}\nProduk: ${safe(String(o.name).slice(0,180))}\nJenis: ${o.kind}\nHarga: ${money(o.amount)}\nPembayaran: ${o.method}\nInvoice: ${safe(String(o.invoice).slice(0,150))}\nStatus pesanan: Selesai\nPengiriman: ${o.delivery_state==='sent'?'Berhasil dikirim ke DM':'Hasil tersedia; pengiriman DM belum terkonfirmasi'}\nDipesan: ${safe(o.created_at)} UTC`,footer:{text:'est. 2020 — Bot Otomatis 24/7'}}],allowedMentions:{parse:[]}};}
 let busy=false;
 async function poll(){if(busy||!config().enabled)return;busy=true;try{discover();const rows=db.prepare("SELECT * FROM order_channel_receipts WHERE state='pending' AND attempt_ms<=? ORDER BY attempt_ms,order_key LIMIT 10").all(now()-60000);
 for(const r of rows){const cfg=config();if(!cfg.enabled)break;db.prepare('UPDATE order_channel_receipts SET attempt_ms=? WHERE order_key=?').run(now(),r.order_key);
 try{const c=await channel(cfg.guild_id,cfg.channel_id);const current=config();if(!current.enabled||current.channel_id!==cfg.channel_id||current.guild_id!==cfg.guild_id)break;const o=db.prepare('SELECT * FROM ('+finished+') WHERE key=?').get(r.order_key);if(!o){db.prepare("UPDATE order_channel_receipts SET state='skipped' WHERE order_key=?").run(r.order_key);continue;}
 const m=await send(c,payload(o));db.prepare("UPDATE order_channel_receipts SET state='sent',message_id=? WHERE order_key=?").run(m?.id||null,r.order_key);
 }catch{/* Persist pending receipt; retry after one minute without affecting payment or buyer DM. */}}
 }finally{busy=false;}}
 async function test(user){owner(user);const cfg=config();if(!cfg.enabled)throw Error('Atur channel tujuan terlebih dahulu.');const c=await channel(cfg.guild_id,cfg.channel_id);owner(user);await send(c,{content:'✅ Tes laporan pesanan berhasil. Pesanan selesai akan dilaporkan di channel ini.',allowedMentions:{parse:[]}});}
 return {configure,disable,backfill,stats,poll,test};
}
function createOrderChannelHandler({discord,model,staff}){
 const {ActionRowBuilder,ButtonBuilder,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
 const button=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style),row=(...b)=>new ActionRowBuilder().addComponents(...b);
 function view(){const s=model.stats(),c=s.config;return {content:`**Laporan Pesanan ke Channel**\nStatus: ${c.enabled?'Aktif':'Nonaktif'}\nServer: ${c.guild_id||'Belum diatur'}\nChannel: ${c.channel_id?'<#'+c.channel_id+'>':'Belum diatur'}\nTerkirim: ${s.sent} • Antrean: ${s.pending}\n\nMencakup OTP berhasil dan produk digital selesai. Data akun, password, dan OTP tidak ditampilkan. Riwayat lama hanya dikirim jika dipilih oleh owner.`,allowedMentions:{parse:[]},components:[row(button('admin_order_channel_config','Atur Channel'),button('admin_order_channel_test','Tes Channel'),button('admin_order_channel_backfill_confirm','Kirim Riwayat Lama')),row(button('admin_order_channel_disable','Nonaktifkan',4),button('admin_order_channel','Perbarui'),button('admin_reports_menu','Kembali'))]};}
 return async i=>{const id=String(i.customId||'');if(!/^admin_order_channel(?::|_|$)/.test(id))return false;if(!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
 try{if(id==='admin_order_channel'){await i.reply({ephemeral:true,...view()});return true;}if(!staff.isOwner(i.user.id))throw Error('Pengaturan tujuan laporan hanya untuk owner.');
 if(id==='admin_order_channel_config'){await i.showModal(new ModalBuilder().setCustomId('admin_order_channel_save').setTitle('Channel Laporan Pesanan').addComponents(...[['guild','ID server tujuan'],['channel','ID channel tujuan']].map(([key,label])=>row(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)))));return true;}
 if(id==='admin_order_channel_backfill_confirm'){await i.reply({ephemeral:true,content:'Kirim semua riwayat pesanan selesai yang belum pernah dilaporkan ke channel tujuan? Pengguna yang dapat melihat channel tersebut akan dapat membaca ringkasan transaksi.',components:[row(button('admin_order_channel_backfill','Kirim Riwayat Lama',3),button('admin_order_channel','Batal'))]});return true;}
 await i.deferReply({ephemeral:true});
 if(id==='admin_order_channel_save')await model.configure(i.user.id,i.fields.getTextInputValue('guild'),i.fields.getTextInputValue('channel'));
 else if(id==='admin_order_channel_disable')model.disable(i.user.id);
 else if(id==='admin_order_channel_backfill')model.backfill(i.user.id);
 else if(id==='admin_order_channel_test')await model.test(i.user.id);
 else throw Error('Menu tidak dikenal.');await i.editReply(view());
 }catch(e){const p={content:e.message,allowedMentions:{parse:[]},components:[row(button('admin_order_channel','Kembali'))]};if(i.deferred)await i.editReply(p);else await i.reply({ephemeral:true,...p});}return true;};
}
module.exports={createOrderHistory,createOrderHistoryHandler,createOrderChannel,createOrderChannelHandler};
