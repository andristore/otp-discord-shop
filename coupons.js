function createCoupons({db,staff,audit=()=>{},now=Date.now}){
  db.exec(`CREATE TABLE IF NOT EXISTS shop_coupons(code TEXT PRIMARY KEY,discount INTEGER NOT NULL,minimum INTEGER NOT NULL,expires_at INTEGER NOT NULL,max_uses INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS shop_coupon_uses(reference TEXT PRIMARY KEY,code TEXT NOT NULL,discord_id TEXT NOT NULL,discount INTEGER NOT NULL,invoice_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  const admin=id=>{if(!staff.isAdmin(id))throw new Error('Akses ditolak.');};
  const code=value=>{const c=String(value).trim().toUpperCase();if(!/^[A-Z0-9_-]{1,20}$/.test(c))throw new Error('Kode voucher 1–20 huruf/angka, - atau _.');return c;};
  const activeUses="(u.invoice_id IS NULL OR NOT EXISTS(SELECT 1 FROM topups t WHERE t.order_id=u.invoice_id) OR EXISTS(SELECT 1 FROM topups t WHERE t.order_id=u.invoice_id AND (t.credited=1 OR t.status IN ('creating','pending'))))";
  function create(id,v){admin(id);const c=code(v.code),discount=Number(v.discount),minimum=Number(v.minimum),limit=Number(v.limit);if(!/^\d{4}-\d{2}-\d{2}$/.test(v.expiry))throw new Error('Tanggal kedaluwarsa YYYY-MM-DD (WIB).');const expires=Date.parse(v.expiry+'T16:59:59.999Z');if(!Number.isFinite(expires) || new Date(expires).toISOString().slice(0,10)!==v.expiry || expires<=now() || !Number.isSafeInteger(discount) || discount<1 || discount>1000000 || !Number.isSafeInteger(minimum) || minimum<0 || minimum>1000000 || !Number.isSafeInteger(limit) || limit<1 || limit>1000000)throw new Error('Diskon 1–1.000.000, minimum 0–1.000.000, batas pakai 1–1.000.000, tanggal harus mendatang.');
    db.transaction(()=>{if(db.prepare('SELECT 1 FROM shop_coupons WHERE code=?').get(c))throw new Error('Kode sudah ada. Buat kode baru.');db.prepare('INSERT INTO shop_coupons(code,discount,minimum,expires_at,max_uses) VALUES(?,?,?,?,?)').run(c,discount,minimum,expires,limit);audit(id,'Buat voucher '+c);})();return c;
  }
  function discount(user,c,q){c=code(c);const v=db.prepare('SELECT * FROM shop_coupons WHERE code=?').get(c);if(!v || !v.enabled || v.expires_at<=now())throw new Error('Voucher tidak aktif atau kedaluwarsa.');const base=q.originalAmount ?? q.amount;
    if(base<v.minimum)throw new Error('Belum memenuhi minimum pembelian voucher.');if(v.discount>base-q.providerAmount)throw new Error('Diskon melebihi margin layanan ini. Pilih layanan lain.');
    const uses=db.prepare('SELECT * FROM shop_coupon_uses u WHERE u.code=? AND '+activeUses).all(c);if(uses.some(u=>u.discord_id===user))throw new Error('Voucher sudah dipakai atau sedang terikat tagihan Anda.');if(uses.length>=v.max_uses)throw new Error('Batas pemakaian voucher sudah tercapai.');return {code:c,discount:v.discount,amount:base-v.discount,originalAmount:base};
  }
  function claim(user,q,reference,invoiceId=null){if(!q.coupon)return;const previous=db.prepare('SELECT * FROM shop_coupon_uses WHERE reference=?').get(reference);if(previous){if(previous.discord_id!==user || previous.code!==q.coupon || previous.discount!==q.discount)throw new Error('Pemakaian voucher tidak sesuai.');return;}
    const d=discount(user,q.coupon,{...q,amount:q.originalAmount});if(d.amount!==q.amount || d.discount!==q.discount)throw new Error('Voucher berubah. Pilih produk kembali.');db.prepare('INSERT INTO shop_coupon_uses(reference,code,discord_id,discount,invoice_id) VALUES(?,?,?,?,?)').run(reference,d.code,user,d.discount,invoiceId);
  }
  function list(id,page=0){admin(id);const n=db.prepare('SELECT COUNT(*) n FROM shop_coupons').get().n,pages=Math.max(1,Math.ceil(n/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);return {count:n,page,pages,rows:db.prepare('SELECT * FROM shop_coupons ORDER BY expires_at DESC,code LIMIT 5 OFFSET ?').all(page*5)};}
  function toggle(id,c){admin(id);c=code(c);db.transaction(()=>{const v=db.prepare('SELECT * FROM shop_coupons WHERE code=?').get(c);if(!v)throw new Error('Voucher tidak ditemukan.');db.prepare('UPDATE shop_coupons SET enabled=? WHERE code=?').run(v.enabled?0:1,c);audit(id,'Ubah status voucher '+c);})();}
  return {create,discount,claim,list,toggle};
}
module.exports={createCoupons};
