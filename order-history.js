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

function createOrderHistory({db}){
 function list(user,requested=0,filter='all'){
  if(!['all','otp'].includes(filter))throw Error('Kategori tidak dikenal.');
  const args=[user,user,user],query='SELECT * FROM ('+union+')'+(filter==='otp'?" WHERE kind='otp'":'');
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
 return {list,detail};
}

function createOrderHistoryHandler({discord,model,payments}){
 const {ActionRowBuilder,ButtonBuilder}=discord;
 const button=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0,80)).setStyle(style);
 const row=(...items)=>new ActionRowBuilder().addComponents(...items);
 function view(user,page,filter,mode){
  const r=model.list(user,page,filter),components=[];
  if(r.rows.length)components.push(row(...r.rows.map(o=>button('history_detail:'+o.key,(o.kind==='otp'?'OTP • ':'Produk • ')+o.name))));
  components.push(row(button(`history_list:${filter}:${mode}:${r.page-1}`,'Sebelumnya').setDisabled(r.page===0),button(`history_list:${filter}:${mode}:${r.page+1}`,'Berikutnya').setDisabled(r.page===r.pages-1)));
  components.push(row(button('history_list:all:orders:0','Riwayat Pesanan'),button('history_list:all:invoices:0','Invoice'),button('history_list:otp:orders:0','Riwayat OTP'),button('shop_home','Menu Awal')));
  return {content:`**${mode==='invoices'?'🧾 Invoice & Bukti Transaksi':filter==='otp'?'🔢 Riwayat OTP':'📦 Riwayat Pesanan'}**\n${r.count?'Pilih pesanan untuk melihat invoice, status, dan hasil.':'Belum ada pesanan.'}\nHalaman ${r.page+1}/${r.pages} • ${r.count} pesanan\n\n`+r.rows.map(o=>`**${safe(o.name)}** • ${o.kind==='otp'?'OTP':'Produk Digital'}\n${money(o.amount)} • ${safe(o.state)}\n${mode==='invoices'?'Invoice / bukti: '+safe(o.invoice||(o.kind==='otp'?'SALDO-OTP-':'SALDO-PRODUK-')+o.key.split(':').slice(1).join(':'))+'\n':''}Tanggal: ${safe(o.created_at)} UTC`).join('\n\n'),allowedMentions:{parse:[]},components};
 }
 return async i=>{
  const id=String(i.customId||'');
  if(!['shop_orders','shop_order_history','direct_history'].includes(id)&&!id.startsWith('manual_orders:')&&!id.startsWith('history_list:')&&!id.startsWith('history_detail:'))return false;
  await i.deferReply({ephemeral:true});
  try{
   if(!id.startsWith('history_detail:')){
    const parts=id.split(':'),filter=id==='shop_order_history'?'otp':id.startsWith('history_list:')?parts[1]:'all',mode=id==='direct_history'?'invoices':id.startsWith('history_list:')?parts[2]:'orders';
    if(!['orders','invoices'].includes(mode))throw Error('Menu tidak dikenal.');
    await i.editReply(view(i.user.id,Number(id.startsWith('manual_orders:')?parts[1]:parts[3]||0),filter,mode));
   }else{
    const o=model.detail(i.user.id,id.slice('history_detail:'.length)),components=[],actions=[];
    let content=`**🧾 Detail Pesanan • ${safe(o.name)}**\nInvoice / bukti transaksi: ${safe(o.receipt)}\nJenis: ${o.kind==='otp'?'OTP':'Produk Digital'}\nPembayaran: ${o.payment_method==='qris'?'QRIS':'Saldo'}\nHarga produk: **${money(o.amount)}**\nStatus pesanan: ${safe(o.status)}\nTanggal: ${safe(o.created_at)} UTC`;
    if(o.invoice){let p;try{p=payments.get(o.invoice,i.user.id);}catch{}
     if(p)content+=`\nStatus pembayaran: ${safe(p.status)}\nBiaya pembeli: ${money(p.fee_customer)}\nTotal tagihan: ${money(p.total_charge??o.amount)}`;
     actions.push(button((o.kind==='digital'?'manual_invoice_check:':'direct_check:')+o.invoice,'Cek Pembayaran & Pesanan',3));
    }else content+='\nBukti pembayaran saldo internal toko.';
    if(o.kind==='digital'){
     if(o.state==='completed'&&o.delivery)content+=`\n\n**Data Produk**\n${safe(o.delivery)}`;
    }else if(o.provider_order_id){
     content+=`\nOrder OTP: ${safe(o.provider_order_id)}\nNomor: ${safe(o.phone||'-')}\nOTP: ${safe(o.otp||'Belum diterima')}`;
     actions.push(button('check_otp:'+o.provider_order_id,'Cek OTP',3));
     if(o.key.startsWith('otp:'))actions.push(button('buy_again:'+o.id,'Beli Lagi'));
    }
    if(actions.length)components.push(row(...actions));
    components.push(row(button('history_list:all:orders:0','Kembali'),button('shop_home','Menu Awal')));
    // Long delivery data stays in a private embed, avoiding Discord's content limit.
    if(content.length>1900){const {EmbedBuilder}=discord;await i.editReply({content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('Detail Pesanan').setDescription(content)],allowedMentions:{parse:[]},components});}
    else await i.editReply({content,embeds:[],allowedMentions:{parse:[]},components});
   }
  }catch(e){await i.editReply({content:e.message,embeds:[],allowedMentions:{parse:[]},components:[row(button('history_list:all:orders:0','Kembali'),button('shop_home','Menu Awal'))]});}
  return true;
 };
}
module.exports={createOrderHistory,createOrderHistoryHandler};
