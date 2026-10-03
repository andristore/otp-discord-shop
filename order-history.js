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
    let content=`**🧾 ${t(i.user.id,'Detail Pesanan','Order Details')} • ${safe(o.name)}**\n${t(i.user.id,'Invoice / bukti transaksi','Invoice / transaction receipt')}: ${safe(o.receipt)}\n${t(i.user.id,'Jenis','Type')}: ${o.kind==='otp'?'OTP':t(i.user.id,'Produk Digital','Digital Product')}\n${t(i.user.id,'Pembayaran','Payment')}: ${o.payment_method==='qris'?'QRIS':t(i.user.id,'Saldo','Balance')}\n${t(i.user.id,'Harga produk','Product price')}: **${money(o.amount)}**\n${t(i.user.id,'Status pesanan','Order status')}: ${safe(o.status)}\n${t(i.user.id,'Tanggal','Date')}: ${safe(o.created_at)} UTC`;
    if(o.invoice){let p;try{p=payments.get(o.invoice,i.user.id);}catch{}
     if(p)content+=`\n${t(i.user.id,'Status pembayaran','Payment status')}: ${safe(p.status)}\n${t(i.user.id,'Biaya pembeli','Customer fee')}: ${money(p.fee_customer)}\n${t(i.user.id,'Total tagihan','Invoice total')}: ${money(p.total_charge??o.amount)}`;
     actions.push(button((o.kind==='digital'?'manual_invoice_check:':'direct_check:')+o.invoice,'Cek Pembayaran & Pesanan',3));
    }else content+='\n'+t(i.user.id,'Bukti pembayaran saldo internal toko.','Internal store balance payment receipt.');
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
  }catch(e){await i.editReply({content:e.message,embeds:[],allowedMentions:{parse:[]},components:[row(button('history_list:all:orders:0','Kembali'),button('shop_home','Menu Awal'))]});}
  return true;
 };
}
module.exports={createOrderHistory,createOrderHistoryHandler};
