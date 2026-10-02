const {randomUUID}=require('node:crypto');
function createCommerce({db,pricing,smsCreateOrder,smsCancel}) {
  const columns=db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name);
  if(!columns.includes('provider_amount'))db.exec('ALTER TABLE orders ADD COLUMN provider_amount INTEGER');
  if(!columns.includes('refunded'))db.exec('ALTER TABLE orders ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0');
  const checkouts=new Map();const locks=new Set();const cancelLocks=new Set();
  function quote(userId,product) {
    for(const [key,c] of checkouts)if(c.expires<Date.now())checkouts.delete(key);
    const providerAmount=Number(product.price?.canonical_amount ?? product.price);
    const amount=pricing.price(providerAmount);const token=randomUUID();
    checkouts.set(token,{userId,productId:Number(product.id),providerAmount,amount,name:product.name || `Produk ${product.id}`,platformId:product.platform_id,countryId:product.country_id,expires:Date.now()+300000});
    return {token,amount,providerAmount};
  }
  async function buy(userId,token) {
    const q=checkouts.get(token);
    if(!q || q.userId!==userId || q.expires<Date.now())throw new Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');
    if(locks.has(userId))throw new Error('Pembelian sedang diproses. Tunggu hasilnya.');
    if(pricing.price(q.providerAmount)!==q.amount)throw new Error('Harga jual berubah. Pilih produk kembali untuk melihat harga terbaru.');
    db.prepare('INSERT OR IGNORE INTO users(discord_id,balance) VALUES(?,0)').run(userId);
    if(db.prepare('SELECT balance FROM users WHERE discord_id=?').get(userId).balance<q.amount)throw new Error('Saldo tidak cukup untuk harga jual produk.');
    locks.add(userId);checkouts.delete(token);
    let order;let saved=false;
    try {
      const result=await smsCreateOrder(q.productId);order=result.data?.orders?.[0];
      if(!order)throw new Error('Provider tidak mengembalikan order.');
      const providerAmount=Number(order.amount?.canonical_amount ?? order.amount);
      if(providerAmount!==q.providerAmount)throw new Error('Harga provider berubah. Order akan dibatalkan; pilih produk kembali.');
      db.transaction(()=>{
        const debit=db.prepare('UPDATE users SET balance=balance-? WHERE discord_id=? AND balance>=?').run(q.amount,userId,q.amount);
        if(!debit.changes)throw new Error('Saldo tidak cukup.');
        db.prepare('INSERT INTO orders(discord_id,product_id,provider_order_id,phone,amount,provider_amount,status) VALUES(?,?,?,?,?,?,?)')
          .run(userId,q.productId,String(order.id),order.phone_number,q.amount,providerAmount,order.status || 'ACTIVE');
      })();
      saved=true;return {order,amount:q.amount};
    } catch(error) {
      if(order && !saved){try{await smsCancel(order.id);}catch{throw new Error('Order provider terbentuk tetapi pembatalan belum terkonfirmasi. Hubungi admin sebelum mencoba lagi.');}}
      throw error;
    } finally {locks.delete(userId);}
  }
  async function cancel(orderId,userId) {
    const order=db.prepare('SELECT * FROM orders WHERE provider_order_id=? AND discord_id=?').get(String(orderId),userId);
    if(!order)throw new Error('Order tidak ditemukan.');
    if(order.refunded || (order.status==='CANCELED' && order.provider_amount==null))return 0;
    if(order.otp || ['COMPLETED','OTP_RECEIVED'].includes(order.status))throw new Error('Order sudah menerima OTP atau selesai.');
    if(cancelLocks.has(String(orderId)))throw new Error('Pembatalan sedang diproses.');
    cancelLocks.add(String(orderId));
    try {
      await smsCancel(orderId);
      return db.transaction(()=>{
        const updated=db.prepare("UPDATE orders SET status='CANCELED',refunded=1 WHERE id=? AND refunded=0").run(order.id);
        if(!updated.changes)return 0;
        db.prepare('UPDATE users SET balance=balance+? WHERE discord_id=?').run(order.amount,userId);
        return order.amount;
      })();
    } finally {cancelLocks.delete(String(orderId));}
  }
  return {quote,buy,cancel,checkout(userId,token,consume=false){
    const q=checkouts.get(token);
    if(!q || q.userId!==userId || q.expires<Date.now())throw new Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');
    if(pricing.price(q.providerAmount)!==q.amount)throw new Error('Harga jual berubah. Pilih produk kembali.');
    if(consume)checkouts.delete(token);
    return {...q};
  }};
}
module.exports={createCommerce};
