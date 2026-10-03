const {randomUUID}=require('node:crypto');
function createCommerce({db,pricing,smsCreateOrder,smsCancel,assertOpen=()=>{}}) {
  const columns=db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name);
  if(!columns.includes('provider_amount'))db.exec('ALTER TABLE orders ADD COLUMN provider_amount INTEGER');
  if(!columns.includes('refunded'))db.exec('ALTER TABLE orders ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0');
  for(const name of ['platform_id','country_id','operator_id','product_name'])if(!columns.includes(name))db.exec(`ALTER TABLE orders ADD COLUMN ${name} TEXT`);
  for(const [name,type] of Object.entries({voucher_code:"TEXT",discount_amount:"INTEGER NOT NULL DEFAULT 0",original_amount:"INTEGER"}))if(!db.prepare("PRAGMA table_info(orders)").all().some(c=>c.name===name))db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  if(!columns.includes('is_owner_test'))db.exec('ALTER TABLE orders ADD COLUMN is_owner_test INTEGER NOT NULL DEFAULT 0');
  let coupons,isOwner=()=>false;
  const checkouts=new Map();const locks=new Set();const cancelLocks=new Set();
  function quote(userId,product) {
    for(const [key,c] of checkouts)if(c.expires<Date.now())checkouts.delete(key);
    const providerAmount=Number(product.price?.canonical_amount ?? product.price);
    const amount=pricing.price(providerAmount);const token=randomUUID();
    checkouts.set(token,{userId,productId:Number(product.id),providerAmount,amount,name:product.name || `Produk ${product.id}`,platformId:product.platform_id,countryId:product.country_id,operatorId:product.operator_id ?? null,expires:Date.now()+300000});
    return {token,amount,providerAmount};
  }
  async function buy(userId,token) {
    assertOpen();
    const q=checkouts.get(token);
    if(!q || q.userId!==userId || q.expires<Date.now())throw new Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');
    if(q.ownerOnly&&!isOwner(userId))throw Error('Hanya owner boleh memakai saldo provider.');
    if(locks.has(userId))throw new Error('Pembelian sedang diproses. Tunggu hasilnya.');
    if(!q.ownerOnly&&pricing.price(q.providerAmount)!==(q.originalAmount ?? q.amount))throw new Error('Harga jual berubah. Pilih produk kembali untuk melihat harga terbaru.');
    db.prepare('INSERT OR IGNORE INTO users(discord_id,balance) VALUES(?,0)').run(userId);
    if(!q.ownerOnly&&db.prepare('SELECT balance FROM users WHERE discord_id=?').get(userId).balance<q.amount)throw new Error('Saldo tidak cukup untuk harga jual produk.');
    locks.add(userId);checkouts.delete(token);
    let order;let saved=false;
    try {
      const result=await smsCreateOrder(q.productId);order=result.data?.orders?.[0];
      if(!order)throw new Error('Provider tidak mengembalikan order.');
      const providerAmount=Number(order.amount?.canonical_amount ?? order.amount);
      if(providerAmount!==q.providerAmount)throw new Error('Harga provider berubah. Order akan dibatalkan; pilih produk kembali.');
      db.transaction(()=>{
        if(!q.ownerOnly){const debit=db.prepare('UPDATE users SET balance=balance-? WHERE discord_id=? AND balance>=?').run(q.amount,userId,q.amount);
        if(!debit.changes)throw new Error('Saldo tidak cukup.');
        coupons?.claim(userId,q,'wallet:'+String(order.id));}
        db.prepare('INSERT INTO orders(discord_id,product_id,provider_order_id,phone,amount,provider_amount,status) VALUES(?,?,?,?,?,?,?)')
          .run(userId,q.productId,String(order.id),order.phone_number,q.amount,providerAmount,order.status || 'ACTIVE');
        db.prepare('UPDATE orders SET platform_id=?,country_id=?,operator_id=?,product_name=? WHERE provider_order_id=? AND discord_id=?').run(q.platformId==null?null:String(q.platformId),q.countryId==null?null:String(q.countryId),q.operatorId==null?null:String(q.operatorId),q.name,String(order.id),userId);
        db.prepare('UPDATE orders SET voucher_code=?,discount_amount=?,original_amount=? WHERE provider_order_id=? AND discord_id=?').run(q.coupon || null,q.discount || 0,q.originalAmount ?? q.amount,String(order.id),userId);
        if(q.ownerOnly)db.prepare('UPDATE orders SET is_owner_test=1 WHERE provider_order_id=? AND discord_id=?').run(String(order.id),userId);
      })();
      saved=true;return {order,amount:q.amount,providerAmount,ownerOnly:Boolean(q.ownerOnly)};
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
  return {quote,buy,cancel,async ownerBuy(userId,token){const q=checkouts.get(token);if(!isOwner(userId)||!q?.ownerOnly)throw Error('Hanya konfirmasi saldo provider owner yang boleh diproses.');return buy(userId,token);},setOwnerAccess:check=>isOwner=check,ownerQuote(userId,product){if(!isOwner(userId))throw Error('Hanya owner boleh memakai saldo provider.');const q=quote(userId,product),saved=checkouts.get(q.token);Object.assign(saved,{ownerOnly:true,amount:0,name:'[OWNER] '+saved.name});return {...q,amount:0};},setCoupons:engine=>coupons=engine,
    applyCoupon(userId,token,code){const q=this.checkout(userId,token);const d=coupons.discount(userId,code,q);const saved=checkouts.get(token);Object.assign(saved,{originalAmount:d.originalAmount,amount:d.amount,discount:d.discount,coupon:d.code});return {...saved};},
    claimCoupon(userId,q,reference,invoice){coupons?.claim(userId,q,reference,invoice);},checkout(userId,token,consume=false){
    const q=checkouts.get(token);
    if(!q || q.userId!==userId || q.expires<Date.now())throw new Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');
    if(q.ownerOnly)throw Error('Konfirmasi owner hanya untuk saldo provider.');
    if(pricing.price(q.providerAmount)!==(q.originalAmount ?? q.amount))throw new Error('Harga jual berubah. Pilih produk kembali.');
    if(consume)checkouts.delete(token);
    return {...q};
  }};
}
module.exports={createCommerce};
