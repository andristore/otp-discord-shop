const {randomUUID}=require('node:crypto');
function createDirectPayments({db,payments,commerce,smsCatalogProducts,smsCreateOrder,smsCancel}) {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_purchases (
    invoice_id TEXT PRIMARY KEY,quote_token TEXT UNIQUE NOT NULL,discord_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,platform_id TEXT,country_id TEXT,name TEXT NOT NULL,
    provider_amount INTEGER NOT NULL,amount INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
    provider_order_id TEXT,error TEXT,notified INTEGER NOT NULL DEFAULT 0,polled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // A provider request interrupted by a restart must be reconciled by admin, never sent twice.
  db.prepare("UPDATE direct_purchases SET state='review',error='Proses provider terputus saat restart; periksa order SMSCode sebelum menyelesaikan tagihan.' WHERE state='processing'").run();
  let notifier;const notifying=new Set();
  const get=(id,userId)=>db.prepare('SELECT * FROM direct_purchases WHERE invoice_id=? AND discord_id=?').get(id,userId);
  async function notify(row) {
    if(!notifier || row.notified || notifying.has(row.invoice_id) || !['fulfilled','refunded','review'].includes(row.state))return;
    notifying.add(row.invoice_id);
    try {await notifier(row);db.prepare('UPDATE direct_purchases SET notified=1 WHERE invoice_id=?').run(row.invoice_id);}catch { /* Buyer can retrieve the order through history when DMs are closed. */ }finally{notifying.delete(row.invoice_id);}
  }
  function refund(row,reason) {
    db.transaction(()=>{
      const updated=db.prepare("UPDATE direct_purchases SET state='refunded',error=? WHERE invoice_id=? AND state='processing'").run(reason,row.invoice_id);
      if(updated.changes)db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(row.discord_id,row.amount);
    })();
  }
  async function fulfill(payment) {
    const trusted=payments.get(payment.order_id,payment.discord_id);
    const row=get(payment.order_id,payment.discord_id);
    if(!row || !trusted?.credited || trusted.purpose!=='purchase' || trusted.amount!==row.amount)throw new Error('Pembayaran pembelian belum terverifikasi.');
    if(row.state!=='pending'){await notify(row);return row;}
    const claim=db.prepare("UPDATE direct_purchases SET state='processing' WHERE invoice_id=? AND state='pending'").run(row.invoice_id);
    if(!claim.changes)return get(row.invoice_id,row.discord_id);
    let products;
    try {products=await smsCatalogProducts({platform_id:row.platform_id,country_id:row.country_id});if(!Array.isArray(products.data))throw new Error('Katalog tidak valid');}
    catch {db.prepare("UPDATE direct_purchases SET state='pending',error='Menunggu katalog provider' WHERE invoice_id=?").run(row.invoice_id);return get(row.invoice_id,row.discord_id);}
    const product=products.data.find(p=>Number(p.id)===row.product_id);
    if(!product || !product.active || Number(product.available)<=0 || Number(product.price?.canonical_amount ?? product.price)!==row.provider_amount) {
      refund(row,'Produk habis/nonaktif atau harga provider berubah. Pembayaran dikembalikan ke saldo bot.');
    } else {
      try {
        const result=await smsCreateOrder(row.product_id);const order=result.data?.orders?.[0];
        if(!order?.id)throw new Error('Order provider belum terkonfirmasi.');
        db.prepare('UPDATE direct_purchases SET provider_order_id=? WHERE invoice_id=?').run(String(order.id),row.invoice_id);
        const cost=Number(order.amount?.canonical_amount ?? order.amount);
        if(cost!==row.provider_amount) {
          await smsCancel(order.id);refund(row,'Harga provider berubah. Order dibatalkan dan pembayaran dikembalikan ke saldo bot.');
        } else {
          db.transaction(()=>{
            db.prepare('INSERT INTO orders(discord_id,product_id,provider_order_id,phone,amount,provider_amount,status) VALUES(?,?,?,?,?,?,?)').run(row.discord_id,row.product_id,String(order.id),order.phone_number,row.amount,cost,order.status || 'ACTIVE');
            db.prepare("UPDATE direct_purchases SET state='fulfilled',error=NULL WHERE invoice_id=? AND state='processing'").run(row.invoice_id);
          })();
        }
      } catch {
        db.prepare("UPDATE direct_purchases SET state='review',error='Pembayaran diterima, tetapi hasil order provider perlu diperiksa admin. Jangan membayar ulang.' WHERE invoice_id=?").run(row.invoice_id);
      }
    }
    const updated=get(row.invoice_id,row.discord_id);await notify(updated);return updated;
  }
  async function create(userId,token) {
    if(!payments.configured)throw new Error('QRIS belum aktif. Admin perlu mengisi konfigurasi pembayaran.');
    const previous=db.prepare('SELECT * FROM direct_purchases WHERE quote_token=? AND discord_id=?').get(token,userId);
    if(previous)return {purchase:previous,payment:payments.get(previous.invoice_id,userId)};
    const q=commerce.checkout(userId,token);
    if(q.amount<1 || q.amount>1000000)throw new Error('Harga produk di luar batas QRIS 1–1.000.000 IDR.');
    const invoiceId='maboyy-buy-'+randomUUID();
    db.prepare('INSERT INTO direct_purchases(invoice_id,quote_token,discord_id,product_id,platform_id,country_id,name,provider_amount,amount) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(invoiceId,token,userId,q.productId,String(q.platformId),String(q.countryId),q.name,q.providerAmount,q.amount);
    commerce.checkout(userId,token,true);
    try {const payment=await payments.create(userId,q.amount,{purpose:'purchase',orderId:invoiceId});return {purchase:get(invoiceId,userId),payment};}
    catch {throw new Error('Tagihan '+invoiceId+' belum menampilkan QR. Buka Riwayat QRIS Beli sebelum membuat tagihan lain.');}
  }
  async function refresh(id,userId) {
    const row=get(id,userId);if(!row)throw new Error('Tagihan tidak ditemukan.');
    await payments.refresh(id,userId);return get(id,userId);
  }
  let polling=false;
  async function poll() {
    if(polling || !payments.configured)return;polling=true;
    try {
      const rows=db.prepare("SELECT d.* FROM direct_purchases d JOIN topups t ON t.order_id=d.invoice_id WHERE d.state='pending' AND t.status IN ('creating','pending','settlement') ORDER BY COALESCE(d.polled_at,'') ASC LIMIT 5").all();
      for(const r of rows){db.prepare('UPDATE direct_purchases SET polled_at=CURRENT_TIMESTAMP WHERE invoice_id=?').run(r.invoice_id);try{await refresh(r.invoice_id,r.discord_id);}catch {}}
      for(const r of db.prepare("SELECT * FROM direct_purchases WHERE notified=0 AND state IN ('fulfilled','refunded','review') LIMIT 5").all())await notify(r);
    } finally {polling=false;}
  }
  return {create,refresh,fulfill,get,poll,setNotifier:fn=>notifier=fn,
    order:row=>row.provider_order_id?db.prepare('SELECT * FROM orders WHERE provider_order_id=? AND discord_id=?').get(row.provider_order_id,row.discord_id):null,
    recent:userId=>db.prepare('SELECT * FROM direct_purchases WHERE discord_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5').all(userId)};
}
function createDirectHandler({discord,direct,payments}) {
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder}=discord;
  const money=v=>Number(v).toLocaleString('id-ID')+' IDR';
  function status(row) {
    const order=direct.order(row);
    if(row.state==='fulfilled' && order?.refunded)return {content:`Pesanan ${order.provider_order_id} dibatalkan. ${money(order.amount)} sudah dikembalikan ke saldo bot.`,components:[]};
    if(row.state==='fulfilled' && order)return {content:`✅ Pembayaran diterima dan pesanan berhasil.\nProduk: **${row.name}**\nHarga: **${money(row.amount)}**\nNomor: **${order.phone}**\nOrder: ${order.provider_order_id}`,components:[new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('check_otp:'+order.provider_order_id).setLabel('Cek OTP').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cancel_order:'+order.provider_order_id).setLabel('Batalkan').setStyle(ButtonStyle.Danger))]};
    if(row.state==='refunded')return {content:`Pembelian tidak dapat dilanjutkan. **${money(row.amount)} dikembalikan ke saldo bot**, bukan rekening pembayaran. ${row.error}`,components:[]};
    if(row.state==='review')return {content:`Pembayaran diterima. Admin perlu memeriksa pesanan. Jangan membayar ulang.\nTagihan: ${row.invoice_id}`,components:[]};
    return {content:row.state==='processing'?'Pembayaran diterima. Pesanan sedang dibuat.':'Menunggu konfirmasi pembayaran QRIS.',components:[checkRow(row.invoice_id)]};
  }
  function checkRow(id){return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('direct_check:'+id).setLabel('Cek Pembayaran & Pesanan').setStyle(ButtonStyle.Success));}
  async function handler(i) {
    const id=String(i.customId || '');
    if(!id.startsWith('qris_buy:') && !id.startsWith('direct_check:') && id!=='direct_history')return false;
    await i.deferReply({ephemeral:true});
    try {
      if(id==='direct_history') {
        const rows=direct.recent(i.user.id);await i.editReply({content:rows.length?'Pilih pembayaran pembelian untuk melihat status atau mengambil pesanan.':'Belum ada pembayaran QRIS pembelian.',components:rows.length?[new ActionRowBuilder().addComponents(...rows.map(r=>new ButtonBuilder().setCustomId('direct_check:'+r.invoice_id).setLabel(`${money(r.amount)} • ${r.state}`).setStyle(ButtonStyle.Secondary)))]:[]});
      }else if(id.startsWith('direct_check:')) {
        const invoice=id.slice(13);const row=await direct.refresh(invoice,i.user.id);const payment=payments.get(invoice,i.user.id);
        const response=status(row);
        if(row.state==='pending') {
          response.content=`Status pembayaran: ${payment.status}. ${payment.credited?'Pembayaran diterima; menunggu provider.':['expire','deny','cancel','failure'].includes(payment.status)?'Tagihan tidak aktif. Pilih produk kembali untuk membuat tagihan baru.':'Menunggu pembayaran; jangan membayar tagihan lain untuk pesanan ini.'}`;
          if(payment.qr_url && payment.status==='pending')response.embeds=[new EmbedBuilder().setColor(0x5865F2).setTitle('QRIS Pembelian').setDescription(`Total: **${money(row.amount)}**\n${payments.production?'Pindai QRIS untuk membayar.':'MODE UJI — bukan uang nyata.'}`).setImage(payment.qr_url)];
        }
        await i.editReply(response);
      }else {
        const {purchase,payment}=await direct.create(i.user.id,id.slice(9));
        if(purchase.state!=='pending'){await i.editReply(status(purchase));return true;}
        if(!payment?.qr_url)throw new Error('QR belum tersedia. Buka Riwayat QRIS Beli untuk mengecek tagihan.');
        await i.editReply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('💳 Bayar Langsung QRIS')
          .setDescription(`Produk: **${purchase.name}**\nTotal: **${money(purchase.amount)}**\n${payments.production?'Pindai QRIS untuk membayar.':'MODE UJI — gunakan simulator Midtrans, bukan uang nyata.'}\nPesanan dibuat otomatis setelah pembayaran terkonfirmasi. Stok diperiksa setelah pembayaran; jika habis, dana dikembalikan ke saldo bot. Lihat hasil di tombol Cek Pembayaran atau Riwayat QRIS Beli.`)
          .setImage(payment.qr_url).setFooter({text:purchase.invoice_id})],components:[checkRow(purchase.invoice_id)]});
      }
    }catch(e){await i.editReply({content:e.message});}
    return true;
  }
  handler.status=status;
  return handler;
}
module.exports={createDirectPayments,createDirectHandler};
