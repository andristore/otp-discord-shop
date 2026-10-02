function parsePricing(percent,fee) {
  const p=String(percent).trim().replace(',','.');const f=String(fee).trim();
  if(!/^\d+(\.\d{1,2})?$/.test(p) || Number(p)>1000 || !/^\d+$/.test(f) || !Number.isSafeInteger(Number(f)) || Number(f)>1000000)throw new Error('Markup harus 0–1000% (maksimal 2 desimal). Tambahan IDR harus bilangan bulat 0–1.000.000.');
  return {basisPoints:Math.round(Number(p)*100),fee:Number(f)};
}
function sellingPrice(cost,settings) {
  cost=Number(cost);
  if(!Number.isSafeInteger(cost)||cost<0)throw new Error('Harga provider tidak valid.');
  const total=cost+Math.ceil(cost*settings.basisPoints/10000)+settings.fee;
  if(!Number.isSafeInteger(total))throw new Error('Harga jual tidak valid.');
  return total;
}
function createPricing(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS price_settings(id INTEGER PRIMARY KEY CHECK(id=1),basis_points INTEGER NOT NULL DEFAULT 0,fee INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO price_settings(id) VALUES(1);`);
  return {
    get:()=>{const r=db.prepare('SELECT * FROM price_settings WHERE id=1').get();return {basisPoints:r.basis_points,fee:r.fee};},
    set:(percent,fee)=>{const s=parsePricing(percent,fee);db.prepare('UPDATE price_settings SET basis_points=?,fee=? WHERE id=1').run(s.basisPoints,s.fee);return s;},
    price(cost){return sellingPrice(cost,this.get());}
  };
}
module.exports={parsePricing,sellingPrice,createPricing};
