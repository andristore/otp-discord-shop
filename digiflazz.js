const {parsePricing,sellingPrice}=require('./pricing');
const {createHash,createHmac,randomUUID,timingSafeEqual}=require('node:crypto');

function md5(value){return createHash('md5').update(String(value)).digest('hex');}
function normalizeStatus(value){
  const s=String(value||'').trim().toLowerCase();
  if(s==='sukses'||s==='success')return 'success';
  if(s==='gagal'||s==='failed'||s==='failure')return 'failed';
  if(s==='pending'||s==='process'||s==='processing')return 'pending';
  return 'pending';
}
function positiveInt(value,label='Nilai'){
  const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error(label+' tidak valid.');return n;
}
function hmacValid(secret,raw,header){
  if(!secret||!Buffer.isBuffer(raw))return false;
  const supplied=String(header||'').trim();
  const expected='sha1='+createHmac('sha1',secret).update(raw).digest('hex');
  const a=Buffer.from(supplied),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);
}

function createDigiflazz({db,pricing,env=process.env,fetchImpl=fetch,now=()=>Date.now(),assertOpen=()=>{},staff,sendDM,audit=()=>{}}){
  db.exec(`
    CREATE TABLE IF NOT EXISTS digiflazz_products(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      category TEXT NOT NULL,
      brand TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      provider_price INTEGER NOT NULL,
      buyer_active INTEGER NOT NULL DEFAULT 0,
      seller_active INTEGER NOT NULL DEFAULT 0,
      unlimited_stock INTEGER NOT NULL DEFAULT 1,
      stock INTEGER NOT NULL DEFAULT 0,
      multi INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      updated_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_digiflazz_products_category_brand ON digiflazz_products(category,brand,product_name);
    CREATE TABLE IF NOT EXISTS digiflazz_orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_id TEXT NOT NULL UNIQUE,
      discord_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      customer_no TEXT NOT NULL,
      provider_price INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'creating',
      provider_status TEXT,
      rc TEXT,
      message TEXT,
      sn TEXT,
      buyer_last_saldo INTEGER,
      refunded INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL,
      updated_ms INTEGER NOT NULL,
      FOREIGN KEY(product_id) REFERENCES digiflazz_products(id)
    );
    CREATE INDEX IF NOT EXISTS idx_digiflazz_orders_user ON digiflazz_orders(discord_id,created_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_digiflazz_orders_pending ON digiflazz_orders(status,updated_ms);
  `);
  // Additive migrations preserve existing catalog and orders.
  function add(table,name,definition){if(!db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name===name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+definition);}
  for(const [name,type] of [['enabled','INTEGER NOT NULL DEFAULT 1'],['sell_price','INTEGER'],['target_format',"TEXT NOT NULL DEFAULT 'id'"],['target_help',"TEXT NOT NULL DEFAULT ''"],['start_cut_off',"TEXT NOT NULL DEFAULT '00:00'"],['end_cut_off',"TEXT NOT NULL DEFAULT '00:00'"]])add('digiflazz_products',name,type);
  for(const [name,type] of [['testing','INTEGER NOT NULL DEFAULT 0'],['account_hash',"TEXT NOT NULL DEFAULT ''"],['check_ms','INTEGER NOT NULL DEFAULT 0'],['actual_cost','INTEGER']])add('digiflazz_orders',name,type);
  db.exec("CREATE TABLE IF NOT EXISTS digiflazz_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,basis_points INTEGER,fee INTEGER,synced_ms INTEGER NOT NULL DEFAULT 0,webhook_ms INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO digiflazz_settings(id) VALUES(1)");
  const existingTargetFlag=db.prepare('PRAGMA table_info(digiflazz_products)').all().some(c=>c.name==='target_override');
  add('digiflazz_products','target_override','INTEGER NOT NULL DEFAULT 0');
  if(!existingTargetFlag)db.exec("UPDATE digiflazz_products SET target_override=1 WHERE target_format<>'id' OR target_help<>''");
  for(const [name,type] of [['balance_threshold','INTEGER NOT NULL DEFAULT 0'],['balance_low','INTEGER NOT NULL DEFAULT 0'],['balance_check_ms','INTEGER NOT NULL DEFAULT 0'],['last_balance','REAL']])add('digiflazz_settings',name,type);
  db.exec(`CREATE TABLE IF NOT EXISTS digiflazz_brand_presets(category TEXT NOT NULL,brand TEXT NOT NULL,target_format TEXT NOT NULL,target_help TEXT NOT NULL,PRIMARY KEY(category,brand));
    CREATE TABLE IF NOT EXISTS digiflazz_favorites(discord_id TEXT NOT NULL,category TEXT NOT NULL,brand TEXT NOT NULL,PRIMARY KEY(discord_id,category,brand));
    CREATE TABLE IF NOT EXISTS digiflazz_alerts(key TEXT PRIMARY KEY,kind TEXT NOT NULL,revision INTEGER NOT NULL,product_id INTEGER,body TEXT NOT NULL,ack_revision INTEGER NOT NULL DEFAULT 0,updated_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS digiflazz_alert_delivery(key TEXT NOT NULL,revision INTEGER NOT NULL,owner_id TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,attempt_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(key,revision,owner_id));`);
  const initialPricing=pricing.get();db.prepare('UPDATE digiflazz_settings SET basis_points=?,fee=? WHERE basis_points IS NULL').run(initialPricing.basisPoints,initialPricing.fee);
  const admin=user=>{if(!staff?.isOwner(user))throw Error('Akses ditolak. Digiflazz khusus owner.');};
  const settings=()=>db.prepare('SELECT * FROM digiflazz_settings WHERE id=1').get();
  const price=p=>p.sell_price??(settings().basis_points==null?pricing.price(p.provider_price):sellingPrice(p.provider_price,{basisPoints:settings().basis_points,fee:settings().fee}));
  const locks=new Set();let syncing=false;
  const accountHash=()=>md5(username()+':'+apiKey());
  const base=(env.DIGIFLAZZ_API_BASE_URL||'https://api.digiflazz.com/v1').replace(/\/$/,'');
  const username=()=>String(env.DIGIFLAZZ_USERNAME||'').trim();
  const apiKey=()=>String(env.DIGIFLAZZ_API_KEY||'').trim();
  const testing=()=>String(env.DIGIFLAZZ_TESTING||'false').toLowerCase()==='true';
  const category=()=>String(env.DIGIFLAZZ_CATEGORY||'Games').trim();
  function configured(){return Boolean(username()&&apiKey());}
  function requireConfig(){if(!configured())throw new Error('Digiflazz belum dikonfigurasi. Isi DIGIFLAZZ_USERNAME dan DIGIFLAZZ_API_KEY.');}
  async function post(path,body){
    const r=await fetchImpl(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const text=await r.text();let data;try{data=JSON.parse(text);}catch{throw new Error('Respons Digiflazz tidak valid.');}
    if(!r.ok)throw new Error(data?.data?.message||data?.message||`Digiflazz HTTP ${r.status}`);
    return data;
  }
  async function priceList(filters={}){
    requireConfig();
    const body={cmd:'prepaid',username:username(),sign:md5(username()+apiKey()+'pricelist')};
    if(filters.code)body.code=String(filters.code);
    if(filters.category)body.category=String(filters.category);
    if(filters.brand)body.brand=String(filters.brand);
    if(filters.type)body.type=String(filters.type);
    const data=await post('/price-list',body);
    if(!Array.isArray(data?.data))throw new Error('Format daftar harga Digiflazz tidak valid.');
    return data.data;
  }
  async function sync(){
    if(syncing)throw Error('Sinkronisasi masih berjalan.');syncing=true;try{
    const rows=await priceList();if(rows.length>50000)throw Error('Katalog terlalu besar.');const seen=new Set();for(const p of rows){if(!p?.buyer_sku_code||String(p.buyer_sku_code).length>100||!p?.product_name||String(p.product_name).length>200||seen.has(p.buyer_sku_code)||(positiveInt(p.price)<1||Number(p.price)>10000000))throw Error('Katalog tidak valid atau SKU duplikat.');seen.add(p.buyer_sku_code);}const stamp=now();
    const up=db.prepare(`INSERT INTO digiflazz_products(sku,product_name,category,brand,type,provider_price,buyer_active,seller_active,unlimited_stock,stock,multi,description,updated_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET product_name=excluded.product_name,category=excluded.category,brand=excluded.brand,type=excluded.type,provider_price=excluded.provider_price,buyer_active=excluded.buyer_active,seller_active=excluded.seller_active,unlimited_stock=excluded.unlimited_stock,stock=excluded.stock,multi=excluded.multi,description=excluded.description,updated_ms=excluded.updated_ms`);
    const tx=db.transaction(()=>{db.prepare('UPDATE digiflazz_products SET buyer_active=0,seller_active=0').run();for(const p of rows){
      if(!p?.buyer_sku_code||!p?.product_name)continue;
      const price=positiveInt(p.price,'Harga Digiflazz');const old=db.prepare('SELECT * FROM digiflazz_products WHERE sku=?').get(String(p.buyer_sku_code));
      up.run(String(p.buyer_sku_code),String(p.product_name),String(p.category||''),String(p.brand||''),String(p.type||''),price,p.buyer_product_status===true?1:0,p.seller_product_status===true?1:0,p.unlimited_stock===true?1:0,positiveInt(p.stock||0,'Stok'),p.multi?1:0,String(p.desc||'').slice(0,900),stamp);
      if(old&&old.category===category()&&price>old.provider_price)queueAlert('price:'+old.sku,'price',old.id,'Modal Digiflazz naik: '+old.product_name+' ('+old.sku+')\n'+old.provider_price+' → '+price+' IDR. Harga jual tetap: '+(old.sell_price??'mengikuti markup')+'. Periksa harga jual.',stamp);
      db.prepare('UPDATE digiflazz_products SET start_cut_off=?,end_cut_off=? WHERE sku=?').run(String(p.start_cut_off||'00:00'),String(p.end_cut_off||'00:00'),String(p.buyer_sku_code));
    }db.prepare('UPDATE digiflazz_settings SET synced_ms=? WHERE id=1').run(stamp);});tx();return rows.length;
    }finally{syncing=false;}
  }
  function availableSql(){return `enabled=1 AND buyer_active=1 AND seller_active=1 AND (unlimited_stock=1 OR stock>0)`;}
  function brands(){
    return db.prepare(`SELECT brand,COUNT(*) count,MIN(provider_price) min_price FROM digiflazz_products WHERE category=? AND ${availableSql()} GROUP BY brand ORDER BY brand COLLATE NOCASE`).all(category());
  }
  function products(brand){
    return db.prepare(`SELECT * FROM digiflazz_products WHERE category=? AND brand=? AND ${availableSql()} ORDER BY provider_price,product_name COLLATE NOCASE`).all(category(),brand).map(p=>({...p,selling_price:price(p)}));
  }
  function product(id){const p=db.prepare('SELECT * FROM digiflazz_products WHERE id=?').get(Number(id));if(!p)throw new Error('Produk Digiflazz tidak ditemukan.');return decorate(p);}
  function decorate(p){const preset=!p.target_override?db.prepare('SELECT * FROM digiflazz_brand_presets WHERE category=? AND brand=?').get(p.category,p.brand):null;return {...p,...(preset?{target_format:preset.target_format,target_help:preset.target_help}:{}),selling_price:price(p)};}
  const quotes=new Map();
  function quote(userId,productId,customerNo){
    assertOpen();requireConfig();if(testing()&&staff&&!staff.isOwner(userId))throw Error('Mode uji Digiflazz hanya untuk owner.');if(!settings().enabled)throw Error('Layanan Digiflazz sedang ditutup admin.');const p=product(productId);
    if(!p.enabled||p.category!==category()||!p.buyer_active||!p.seller_active||(!p.unlimited_stock&&p.stock<1))throw new Error('Produk sedang tidak tersedia.');
    if(cutoff(p))throw Error('Produk sedang dalam jadwal tutup provider.');
    if(now()-p.updated_ms>86400000)throw Error('Katalog perlu disinkronkan admin.');
    customerNo=String(customerNo||'').trim();
    if(!customerNo||customerNo.length>100||!/^[a-zA-Z0-9._@+|\-]+$/.test(customerNo))throw new Error('ID/nomor tujuan tidak valid.');
    if(p.selling_price<p.provider_price||p.selling_price>10000000)throw Error('Harga jual harus minimal modal dan maksimal 10 juta.');
    for(const [k,v]of quotes)if(v.expires<=now())quotes.delete(k);
    const token=randomUUID();quotes.set(token,{userId:String(userId),productId:p.id,sku:p.sku,name:p.product_name,brand:p.brand,customerNo,providerPrice:p.provider_price,amount:p.selling_price,expires:now()+5*60000});return {token,...quotes.get(token)};
  }
  function debit(user,amount){
    db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING').run(user);
    const r=db.prepare('UPDATE users SET balance=balance-? WHERE discord_id=? AND balance>=?').run(amount,user,amount);if(r.changes!==1)throw new Error('Saldo tidak cukup. Isi saldo dahulu.');
  }
  function apply(refId,data){
    return db.transaction(()=>{
      const row=db.prepare('SELECT * FROM digiflazz_orders WHERE ref_id=?').get(refId);if(!row)return null;
      if(String(data.ref_id||'')!==row.ref_id||String(data.buyer_sku_code||'')!==row.sku||String(data.customer_no||'')!==row.customer_no)throw Error('Respons Digiflazz tidak cocok.');
      if(!['sukses','success','gagal','failed','failure','pending','process','processing'].includes(String(data.status).toLowerCase()))throw Error('Status Digiflazz tidak dikenal.');
      const status=normalizeStatus(data.status);if(data.rc!=null&&(status==='success'&&String(data.rc)!=='00'||status==='pending'&&String(data.rc)!=='03'||status==='failed'&&['00','03'].includes(String(data.rc))))throw Error('Status dan kode Digiflazz tidak sesuai.');const cost=data.price==null?row.provider_price:positiveInt(data.price);
      if(status==='success'&&cost<1)throw Error('Biaya sukses tidak valid.');if(cost>row.provider_price)throw Error('Biaya provider melebihi batas pesanan.');
      if(['success','failed'].includes(row.status)){if(status!==row.status&&status!=='pending')throw Error('Status akhir bertentangan; periksa di Digiflazz.');return row;}
      db.prepare('UPDATE digiflazz_orders SET actual_cost=?,status=?,provider_status=?,rc=?,message=?,sn=?,updated_ms=? WHERE id=?').run(cost,status,String(data.status),String(data.rc||''),String(data.message||'').slice(0,500),String(data.sn||'').slice(0,800),now(),row.id);
      if(status==='failed'&&!row.refunded){const balance=db.prepare('SELECT balance FROM users WHERE discord_id=?').get(row.discord_id)?.balance;if(!Number.isSafeInteger(balance+row.amount))throw Error('Saldo refund tidak valid.');db.prepare('UPDATE users SET balance=balance+? WHERE discord_id=?').run(row.amount,row.discord_id);db.prepare('UPDATE digiflazz_orders SET refunded=1 WHERE id=?').run(row.id);}
      return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);
    })();
  }
  async function notify(row){if(!row||row.notified||!sendDM||!['success','failed'].includes(row.status)||locks.has('dm:'+row.id))return;locks.add('dm:'+row.id);try{await sendDM(row.discord_id,'Topup '+row.product_name+'\nRef: '+row.ref_id+'\nStatus: '+row.status+'\n'+(row.testing?'MODE UJI\n':'')+(row.refunded?'Saldo dikembalikan.':row.sn||''));db.prepare('UPDATE digiflazz_orders SET notified=1 WHERE id=?').run(row.id);}catch{}finally{locks.delete('dm:'+row.id);}}
  async function sendTransaction(row){
    requireConfig();const current=db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);
    if(['success','failed','review'].includes(current.status))return current;
    if(locks.has(row.ref_id)||current.check_ms&&now()-current.check_ms<60000)return current;
    if(current.account_hash!==accountHash()||!!current.testing!==testing()||now()-row.created_ms>86400000){db.prepare("UPDATE digiflazz_orders SET status='review',message='Periksa transaksi provider secara manual: akun/mode berubah atau usia melebihi 24 jam.' WHERE id=?").run(row.id);return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);}
    locks.add(row.ref_id);try{
      const claimed=db.prepare('UPDATE digiflazz_orders SET check_ms=? WHERE id=? AND check_ms=?').run(now(),row.id,current.check_ms);if(!claimed.changes)return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);
      const body={username:username(),buyer_sku_code:row.sku,customer_no:row.customer_no,ref_id:row.ref_id,sign:md5(username()+apiKey()+row.ref_id),max_price:row.provider_price,testing:!!row.testing};
      const result=await post('/transaction',body);if(!result?.data)throw Error('Format transaksi tidak valid.');const done=apply(row.ref_id,result.data);await notify(done);return done;
    }finally{locks.delete(row.ref_id);}
  }
  async function buy(userId,token){
    assertOpen();const q=quotes.get(token);if(!q||q.userId!==String(userId)||q.expires<=now())throw new Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');quotes.delete(token);
    const verified=quote(userId,q.productId,q.customerNo);quotes.delete(verified.token);const latest=product(q.productId);if(latest.provider_price!==q.providerPrice||latest.selling_price!==q.amount)throw new Error('Harga berubah. Pilih produk kembali.');
    const ref='DF-'+randomUUID();let row;
    db.transaction(()=>{if(!latest.multi&&db.prepare("SELECT 1 FROM digiflazz_orders WHERE sku=? AND customer_no=? AND status<>'failed' AND created_ms>=?").get(q.sku,q.customerNo,Math.floor((now()+25200000)/86400000)*86400000-25200000))throw Error('Provider membatasi tujuan yang sama satu kali per hari untuk produk ini.');debit(String(userId),q.amount);const r=db.prepare(`INSERT INTO digiflazz_orders(ref_id,discord_id,product_id,sku,product_name,customer_no,provider_price,amount,status,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(ref,String(userId),q.productId,q.sku,q.name,q.customerNo,q.providerPrice,q.amount,'creating',now(),now());db.prepare('UPDATE digiflazz_orders SET testing=?,account_hash=? WHERE id=?').run(testing()?1:0,accountHash(),r.lastInsertRowid);row=db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(r.lastInsertRowid);})();
    try{return await sendTransaction(row);}catch(e){db.prepare("UPDATE digiflazz_orders SET status='pending',message=?,updated_ms=? WHERE id=? AND status='creating'").run('Status provider belum terkonfirmasi: '+String(e.message).slice(0,300),now(),row.id);return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);}
  }
  async function recheck(refId,userId){const row=db.prepare('SELECT * FROM digiflazz_orders WHERE ref_id=? AND discord_id=?').get(String(refId),String(userId));if(!row)throw new Error('Pesanan tidak ditemukan.');if(['success','failed'].includes(row.status))return row;try{return await sendTransaction(row);}catch{return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);}}
  let polling=false;
  async function poll(){if(polling||!configured())return;polling=true;try{await monitorAlerts();for(const row of db.prepare("SELECT * FROM digiflazz_orders WHERE status IN ('creating','pending') AND updated_ms<=? ORDER BY updated_ms LIMIT 10").all(now()-60000)){try{await sendTransaction(row);}catch{db.prepare('UPDATE digiflazz_orders SET updated_ms=? WHERE id=?').run(now(),row.id);}}for(const r of db.prepare("SELECT * FROM digiflazz_orders WHERE status IN ('success','failed') AND notified=0 LIMIT 5").all())await notify(r);}finally{polling=false;}}
  function recent(userId,page=0){const count=db.prepare('SELECT COUNT(*) n FROM digiflazz_orders WHERE discord_id=?').get(String(userId)).n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number(page)||0,0),pages-1);return {page,pages,count,rows:db.prepare('SELECT * FROM digiflazz_orders WHERE discord_id=? ORDER BY created_ms DESC,id DESC LIMIT 5 OFFSET ?').all(String(userId),page*5)};}
  function mount(app){
    app.post('/webhooks/digiflazz',(req,res)=>{try{const secret=String(env.DIGIFLAZZ_WEBHOOK_SECRET||'');if(!hmacValid(secret,req.rawBody,req.get('X-Hub-Signature')))return res.status(401).json({ok:false});const data=req.body?.data;if(!data?.ref_id)return res.status(400).json({ok:false});const row=db.prepare('SELECT * FROM digiflazz_orders WHERE ref_id=?').get(String(data.ref_id));if(!row)return res.status(200).json({ok:true,ignored:true});const done=apply(row.ref_id,data);db.prepare('UPDATE digiflazz_settings SET webhook_ms=? WHERE id=1').run(now());notify(done).catch(()=>{});return res.json({ok:true});}catch{return res.status(400).json({ok:false});}});
  }
  function cutoff(p){const a=p.start_cut_off,b=p.end_cut_off;if(a===b||!/^\d{2}:\d{2}$/.test(a)||!/^\d{2}:\d{2}$/.test(b))return false;const t=new Date(now()+7*3600000).toISOString().slice(11,16);return a<b?t>=a&&t<b:t>=a||t<b;}
  function page(query,args=[],n=0){const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get(...args).n,pages=Math.max(1,Math.ceil(count/10)),page=Math.min(Math.max(Number.isSafeInteger(n)?n:0,0),pages-1);return {count,pages,page,rows:db.prepare(query+' LIMIT 10 OFFSET ?').all(...args,page*10)};}
  function catalogPage({brandId=0,query='',page:requested=0,adminView=false}={}){const conditions=['category=?'],args=[category()];if(!adminView)conditions.push(availableSql());if(brandId){conditions.push('brand=?');args.push(product(brandId).brand);}if(query){conditions.push('(instr(lower(product_name),lower(?))>0 OR instr(lower(sku),lower(?))>0 OR instr(lower(brand),lower(?))>0)');args.push(query,query,query);}const r=page('SELECT * FROM digiflazz_products WHERE '+conditions.join(' AND ')+' ORDER BY provider_price,product_name,id',args,requested);return {...r,rows:r.rows.map(p=>({...p,selling_price:price(p)}))};}
  function brandPage(n=0,adminView=false,filter='all'){
    if(!['all','active','partial','unavailable','closed'].includes(filter))throw Error('Filter layanan tidak dikenal.');
    if(!adminView)return page('SELECT MIN(id) id,brand,COUNT(*) count FROM digiflazz_products WHERE category=? AND '+availableSql()+' GROUP BY brand ORDER BY brand',[category()],n);
    const all=db.prepare(`SELECT MIN(id) id,brand,COUNT(*) count,SUM(enabled) enabled_count,
      SUM(CASE WHEN buyer_active=1 AND seller_active=1 AND (unlimited_stock=1 OR stock>0) THEN 1 ELSE 0 END) provider_count,
      SUM(CASE WHEN ${availableSql()} THEN 1 ELSE 0 END) available_count
      FROM digiflazz_products WHERE category=? GROUP BY brand ORDER BY brand`).all(category()).map(b=>({...b,status:!settings().enabled||!b.enabled_count?'closed':!b.available_count?'unavailable':b.available_count===b.count?'active':'partial'}));
    const summary={active:0,partial:0,unavailable:0,closed:0};for(const b of all)summary[b.status]++;
    const selected=filter==='all'?all:all.filter(b=>b.status===filter),count=selected.length,pages=Math.max(1,Math.ceil(count/10)),requested=Number.isSafeInteger(n)?n:0,pageIndex=Math.min(Math.max(requested,0),pages-1);
    return {count,pages,page:pageIndex,rows:selected.slice(pageIndex*10,pageIndex*10+10),summary,total:all.length,filter,synced_ms:settings().synced_ms,service_enabled:settings().enabled};
  }
  async function saldo(user){admin(user);requireConfig();const r=await post('/cek-saldo',{cmd:'deposit',username:username(),sign:md5(username()+apiKey()+'depo')});admin(user);const n=Number(r?.data?.deposit);if(r?.data?.deposit==null||!Number.isFinite(n)||n<0)throw Error('Saldo provider tidak valid.');return n;}
  function configure(user,id,{enabled,sell_price,target_format,target_help}){admin(user);const p=product(id);const n=sell_price===''?null:Number(sell_price);const inherit=target_format==='inherit';if(!['0','1'].includes(String(enabled))||n!==null&&(!Number.isSafeInteger(n)||n<p.provider_price||n>10000000)||!['id','concat','pipe','inherit'].includes(target_format)||String(target_help).length>300)throw Error('Status 0/1; harga minimal modal atau kosong; format id/concat/pipe.');db.prepare('UPDATE digiflazz_products SET enabled=?,sell_price=?,target_format=?,target_help=?,target_override=? WHERE id=?').run(Number(enabled),n,inherit?'id':target_format,inherit?'':String(target_help),inherit?0:1,p.id);audit(user,'Digiflazz SKU '+p.sku+': aktif '+p.enabled+' → '+enabled+', harga '+(p.sell_price??'markup')+' → '+(n??'markup'));quotes.clear();return product(id);}
  function configureService(user,{enabled,percent,fee}){admin(user);if(!['0','1'].includes(String(enabled)))throw Error('Status wajib 0/1.');const p=parsePricing(percent,fee);db.prepare('UPDATE digiflazz_settings SET enabled=?,basis_points=?,fee=? WHERE id=1').run(Number(enabled),p.basisPoints,p.fee);audit(user,'Pengaturan Digiflazz: aktif '+enabled+', markup '+percent+'%, biaya '+fee);return settings();}
  function toggleBrand(user,id,enabled){admin(user);if(!['0','1'].includes(String(enabled)))throw Error('Status wajib 0/1.');const p=product(id);const r=db.prepare('UPDATE digiflazz_products SET enabled=? WHERE category=? AND brand=?').run(Number(enabled),p.category,p.brand);audit(user,'Digiflazz layanan '+p.brand+': aktif '+enabled+' ('+r.changes+' produk)');return r.changes;}
  function adminOrders(user,n=0,pending=false){admin(user);return page('SELECT * FROM digiflazz_orders'+(pending?" WHERE status IN ('pending','creating','review')":'')+' ORDER BY created_ms DESC,id DESC',[],n);}
  async function adminCheck(user,id){admin(user);const r=db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(Number(id));if(!r)throw Error('Pesanan tidak ditemukan.');return recheck(r.ref_id,r.discord_id);}
  function overview(user){admin(user);return {...settings(),configured:configured(),testing:testing(),category:category(),total:db.prepare('SELECT COUNT(*) n FROM digiflazz_products WHERE category=?').get(category()).n,pending:db.prepare("SELECT COUNT(*) n FROM digiflazz_orders WHERE status IN ('creating','pending','review')").get().n};}
  function queueAlert(key,kind,productId,body,stamp=now()){
    db.prepare(`INSERT INTO digiflazz_alerts(key,kind,revision,product_id,body,updated_ms) VALUES(?,?,1,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=revision+1,body=excluded.body,updated_ms=excluded.updated_ms`).run(key,kind,productId,body,stamp);
  }
  function configureAlerts(user,threshold){admin(user);const n=Number(threshold);if(!/^\d+$/.test(String(threshold))||!Number.isSafeInteger(n)||n<0||n>1000000000)throw Error('Batas saldo 0–1 miliar IDR; 0 mematikan peringatan.');if(settings().balance_threshold===n)return;db.prepare('UPDATE digiflazz_settings SET balance_threshold=?,balance_low=0,balance_check_ms=0 WHERE id=1').run(n);audit(user,'Batas saldo Digiflazz: '+n);}
  let alertBusy=false;
  async function monitorAlerts(){
    if(alertBusy)return;alertBusy=true;try{
      let s=settings();if(s.balance_threshold>0&&configured()&&now()-s.balance_check_ms>=300000){
        db.prepare('UPDATE digiflazz_settings SET balance_check_ms=? WHERE id=1').run(now());
        try{const r=await post('/cek-saldo',{cmd:'deposit',username:username(),sign:md5(username()+apiKey()+'depo')}),balance=Number(r?.data?.deposit);if(r?.data?.deposit==null||!Number.isFinite(balance)||balance<0)throw Error('Saldo tidak valid');
          db.transaction(()=>{s=settings();const low=balance<=s.balance_threshold;if(low&&!s.balance_low&&s.balance_threshold>0)queueAlert('balance','balance',null,'Saldo Digiflazz menipis: '+balance+' IDR. Batas: '+s.balance_threshold+' IDR. Isi deposit provider melalui akun Buyer.');db.prepare('UPDATE digiflazz_settings SET last_balance=?,balance_low=? WHERE id=1').run(balance,low?1:0);})();
        }catch{/* Failed balance reads never count as a zero balance. */}
      }
      if(!sendDM)return;const owners=(staff?.list?.()||[]).filter(p=>p.owner&&staff.isOwner(p.id));
      for(const o of owners){if(!staff.isOwner(o.id))continue;
        const due=db.prepare(`SELECT a.* FROM digiflazz_alerts a WHERE a.ack_revision<a.revision
          AND (a.kind='price' OR (?=1 AND ?>0))
          AND NOT EXISTS(SELECT 1 FROM digiflazz_alert_delivery d WHERE d.key=a.key AND d.revision=a.revision AND d.owner_id=? AND (d.sent=1 OR d.attempt_ms>?)) ORDER BY a.updated_ms,a.key LIMIT 10`).all(settings().balance_low,settings().balance_threshold,o.id,now()-300000);
        for(const a of due){if(!staff.isOwner(o.id))break;db.prepare('INSERT OR IGNORE INTO digiflazz_alert_delivery(key,revision,owner_id) VALUES(?,?,?)').run(a.key,a.revision,o.id);db.prepare('UPDATE digiflazz_alert_delivery SET attempt_ms=? WHERE key=? AND revision=? AND owner_id=?').run(now(),a.key,a.revision,o.id);
          try{await sendDM(o.id,a.body);db.prepare('UPDATE digiflazz_alert_delivery SET sent=1 WHERE key=? AND revision=? AND owner_id=?').run(a.key,a.revision,o.id);}catch{}
        }
      }
    }finally{alertBusy=false;}
  }
  function priceAlerts(user,n=0){admin(user);return page("SELECT a.*,p.sku FROM digiflazz_alerts a JOIN digiflazz_products p ON p.id=a.product_id WHERE a.kind='price' AND a.ack_revision<a.revision ORDER BY a.updated_ms DESC,a.key",[],n);}
  function ackPrices(user){admin(user);const n=db.prepare("UPDATE digiflazz_alerts SET ack_revision=revision WHERE kind='price' AND ack_revision<revision").run().changes;audit(user,'Tinjau peringatan modal Digiflazz: '+n+' SKU');return n;}
  function preset(user,id,format,help){admin(user);const p=product(id);if(!['id','concat','pipe'].includes(format)||!String(help).trim()||String(help).length>300)throw Error('Format id/concat/pipe dan petunjuk maksimal 300 karakter wajib.');db.prepare('INSERT INTO digiflazz_brand_presets VALUES(?,?,?,?) ON CONFLICT(category,brand) DO UPDATE SET target_format=excluded.target_format,target_help=excluded.target_help').run(p.category,p.brand,format,String(help).trim());quotes.clear();audit(user,'Preset tujuan Digiflazz: '+p.brand+' / '+format);return product(id);}
  function toggleFavorite(user,id){const p=product(id);if(p.category!==category())throw Error('Kategori tidak tersedia.');const old=db.prepare('SELECT 1 FROM digiflazz_favorites WHERE discord_id=? AND category=? AND brand=?').get(String(user),p.category,p.brand);if(old){db.prepare('DELETE FROM digiflazz_favorites WHERE discord_id=? AND category=? AND brand=?').run(String(user),p.category,p.brand);return false;}db.prepare('INSERT INTO digiflazz_favorites VALUES(?,?,?)').run(String(user),p.category,p.brand);return true;}
  function favoritePage(user,n=0){return page('SELECT MIN(p.id) id,p.brand,COUNT(*) count FROM digiflazz_favorites f JOIN digiflazz_products p ON p.category=f.category AND p.brand=f.brand WHERE f.discord_id=? AND f.category=? GROUP BY p.brand ORDER BY p.brand',[String(user),category()],n);}
  function report(user,period='today'){admin(user);if(!['today','month','all'].includes(period))throw Error('Periode laporan tidak dikenal.');const date=new Date(now()+25200000).toISOString().slice(0,10);const since=period==='all'?0:Date.parse((period==='today'?date:date.slice(0,7)+'-01')+'T00:00:00+07:00');return {...db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(amount),0) revenue,COALESCE(SUM(CASE WHEN actual_cost IS NOT NULL THEN actual_cost ELSE 0 END),0) cost,COALESCE(SUM(CASE WHEN actual_cost IS NOT NULL THEN amount-actual_cost ELSE 0 END),0) profit,SUM(CASE WHEN actual_cost IS NULL THEN 1 ELSE 0 END) unknown FROM digiflazz_orders WHERE status='success' AND refunded=0 AND testing=0 AND created_ms>=?`).get(since),period};}
  return {configureAlerts,monitorAlerts,priceAlerts,ackPrices,preset,toggleFavorite,favoritePage,report,settings,catalogPage,brandPage,saldo,configure,configureService,toggleBrand,adminOrders,adminCheck,overview,configured,testing,category,sync,brands,products,product,quote,buy,recheck,recent,poll,mount,apply,hmacValid:(raw,header)=>hmacValid(String(env.DIGIFLAZZ_WEBHOOK_SECRET||''),raw,header)};
}

function createDigiflazzHandler({discord,model,getBalance,staff}){
 const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
 const sessions=new Map(),safe=s=>String(s??'').replace(/([\\`*_~|<>\[\]])/g,'\\$1'),money=n=>Number(n||0).toLocaleString('id-ID')+' IDR';
 const button=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(String(label).slice(0,80)).setStyle(style);
 const row=(...b)=>new ActionRowBuilder().addComponents(...b);
 const view=(title,text,components=[])=>({content:'',allowedMentions:{parse:[]},embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(String(title).slice(0,256)).setDescription(String(text).slice(0,4000))],components});
 const field=(key,label,value,max,required=true)=>{const f=new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max);if(String(value??''))f.setValue(String(value));return row(f);};
 const form=(id,title,fields)=>new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...fields);
 function home(user){const s=model.overview(user);return view('🎮 Digiflazz • Owner',`**${s.enabled?'Buka':'Tutup'}** • ${s.testing?'Mode uji':'Produksi'} • API ${s.configured?'siap':'belum diisi'}\n${s.total} produk • ${s.pending} transaksi perlu diperiksa\n\nPilih kategori. Pengelolaan Digiflazz khusus owner.`,[row(button('admin_df_catalog','Katalog'),button('admin_df_transactions','Transaksi'),button('admin_df_finance','Keuangan'),button('admin_df_config','Pengaturan')),row(button('admin_home','Menu Awal Admin'))]);}
 function section(action){const back=row(button('admin_digiflazz','Kembali'),button('admin_home','Menu Awal Admin'));
  if(action==='admin_df_catalog')return view('Katalog Digiflazz','Layanan, produk, dan sinkronisasi.',[row(button('admin_df_brands:0','Kelola Layanan'),button('admin_df_list:0:0','Semua Produk'),button('admin_df_search','Cari Produk')),row(button('admin_df_sync','Sinkron Katalog',3)),back]);
  if(action==='admin_df_transactions')return view('Transaksi Digiflazz','Riwayat dan pesanan yang perlu diperiksa.',[row(button('admin_df_orders:0:all','Semua Transaksi'),button('admin_df_orders:0:pending','Perlu Diperiksa')),back]);
  if(action==='admin_df_finance')return view('Keuangan Digiflazz','Saldo provider, keuntungan, dan peringatan.',[row(button('admin_df_saldo','Cek Saldo Digiflazz'),button('admin_df_report:today','Keuntungan Game'),button('admin_df_alerts','Peringatan')),back]);
  return view('Pengaturan Digiflazz','Harga, buka/tutup layanan, serta koneksi API.',[row(button('admin_df_settings','Pengaturan & Harga'),button('admin_df_connection','Koneksi & Webhook')),back]);
 }
 function alerts(){const s=model.settings();return view('⚠️ Peringatan Digiflazz',`Batas saldo: ${s.balance_threshold?money(s.balance_threshold):'Nonaktif'}\nSaldo dari pemantauan: ${s.last_balance==null?'Belum diperiksa':money(s.last_balance)}\n\nSaldo diperiksa maksimal sekali per 5 menit. Peringatan dikirim ke DM owner, sekali per kejadian; saldo pulih membuka siklus baru. Kenaikan modal dicatat saat sinkron katalog. Pengiriman yang gagal dicoba ulang.`,[row(button('admin_df_alert_config','Atur Batas Saldo'),button('admin_df_prices:0','Kenaikan Modal')),row(button('admin_digiflazz','Kembali'),button('admin_home','Menu Awal Admin'))]);}
 function products(admin,brandId,n,search=null){const r=model.catalogPage({adminView:admin,brandId,query:search?.query||'',page:n}),prefix=admin?'admin_df':'df',components=[];for(let j=0;j<r.rows.length;j+=5)components.push(row(...r.rows.slice(j,j+5).map(p=>button((admin?'admin_df_product:':'df_detail:')+p.id,p.product_name,2))));
 const pageId=n=>search?prefix+'_results:'+search.id+':'+n:prefix+'_list:'+brandId+':'+n;
 components.push(row(button(pageId(r.page-1),'Sebelumnya').setDisabled(r.page===0),button(pageId(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1),button(prefix+'_search','Cari Produk')));
 components.push(row(button(admin?'admin_df_brands:0':'shop_games','Kembali'),button(admin?'admin_home':'shop_home',admin?'Menu Awal Admin':'Menu Awal'),...(brandId?[button((admin?'admin_df_preset:':'df_favorite_toggle:')+brandId,admin?'Preset ID / Server':'Simpan / Hapus Favorit')]:[])));
 return view(search?'🔎 Hasil Pencarian':'🎮 Pilih Produk',`Halaman ${r.page+1}/${r.pages} • ${r.count} produk\nPilih produk untuk melihat harga dan petunjuk tujuan.\n${admin?'● Aktif/tutup ditampilkan pada detail.':''}`,components);}
 function brands(admin,n,filter='all'){
  const r=model.brandPage(n,admin,filter),prefix=admin?'admin_df':'df',components=[],labels={active:'Aktif',partial:'Sebagian tersedia',unavailable:'Tidak tersedia',closed:'Ditutup admin'},icons={active:'🟢',partial:'🟡',unavailable:'🔴',closed:'⏸️'};
  for(let j=0;j<r.rows.length;j+=5)components.push(row(...r.rows.slice(j,j+5).map(p=>button(prefix+'_list:'+p.id+':0',(admin?icons[p.status]+' ':'')+p.brand+' ('+(admin?p.available_count+'/'+p.count:p.count)+')',1))));
  if(admin)components.push(row(...[['all','Semua'],['active','Aktif'],['partial','Sebagian tersedia'],['unavailable','Tidak tersedia'],['closed','Ditutup admin']].map(([key,label])=>button('admin_df_brands:0:'+key,label).setDisabled(filter===key))));
  const pageId=n=>prefix+'_brands:'+n+(admin?':'+filter+':page':'');
  components.push(row(button(pageId(r.page-1),'Sebelumnya').setDisabled(r.page===0),button(pageId(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1),button(prefix+'_search','Cari Produk')));
  components.push(row(button(admin?'admin_digiflazz':'df_history:0',admin?'Kembali':'Riwayat Topup'),button(admin?'admin_home':'shop_home',admin?'Menu Awal Admin':'Menu Awal'),...(!admin?[button('df_favorites:0','Game Favorit')]:[])));
  const summary=admin?`Total: **${r.total} brand** • Aktif ${r.summary.active} • Sebagian ${r.summary.partial} • Tidak tersedia ${r.summary.unavailable} • Ditutup ${r.summary.closed}\nLayanan Digiflazz: ${r.service_enabled?'Buka':'Ditutup admin'}\nKatalog terakhir: ${r.synced_ms?new Date(r.synced_ms).toISOString():'Belum disinkronkan'}\nFilter: ${filter==='all'?'Semua':labels[filter]}\n\n`:'';
  const details=admin?r.rows.map(p=>`${icons[p.status]} **${safe(p.brand)}** — ${labels[p.status]}\nSiap menurut katalog: ${p.available_count}/${p.count} SKU • Provider tersedia: ${p.provider_count} • Toko aktif: ${p.enabled_count}`).join('\n\n'):'';
  return view('🎮 '+(admin?'Ringkasan Layanan Digiflazz':'Topup Game'),summary+`Halaman ${r.page+1}/${r.pages} • ${r.count} layanan\n${r.count?'Klik brand untuk melihat produk.':'Tidak ada brand pada pilihan ini.'}\n\n`+details+(admin?'\n\nStatus berdasarkan katalog tersimpan. Harga, jadwal tutup, dan kesegaran katalog diperiksa lagi saat pembelian.':''),components);
 }
 function detail(p,admin){return view('🎮 '+p.product_name,`${safe(p.description).slice(0,1000)}\nHarga: **${money(p.selling_price)}**\n${admin?'SKU: '+safe(p.sku)+'\nModal: '+money(p.provider_price)+'\nStatus toko: '+(p.enabled?'Aktif':'Nonaktif')+'\nProvider: '+(p.buyer_active&&p.seller_active&&(p.unlimited_stock||p.stock>0)?'Tersedia':'Tidak tersedia')+'\nFormat: '+p.target_format+'\n':''}Petunjuk: ${safe(p.target_help||'Masukkan ID tujuan sesuai format provider. ID tidak diverifikasi namanya otomatis.')}\n${model.testing()?'**MODE UJI — pengiriman tidak nyata.**':''}`,[row(...(admin?[button('admin_df_edit:'+p.id,'Atur Produk',3),button('admin_df_brand_edit:'+p.id,'Atur Layanan'),button('admin_df_preset:'+p.id,'Preset ID / Server')]:[button('df_target_open:'+p.id,'Isi ID / Tujuan',3)])),row(button((admin?'admin_df':'df')+'_list:'+p.id+':0','Kembali'),button(admin?'admin_home':'shop_home',admin?'Menu Awal Admin':'Menu Awal'))]);}
 function receipt(o,admin=false){return view('🧾 Transaksi Digiflazz',`Produk: ${safe(o.product_name)}\nTujuan: ${safe(o.customer_no)}\nHarga: ${money(o.amount)}\n${admin?'Pembeli: '+safe(o.discord_id)+'\nModal aktual: '+(o.actual_cost==null?'Belum pasti':money(o.actual_cost))+'\n':''}Ref: ${safe(o.ref_id)}\nStatus: **${safe(o.status)}**\n${safe(o.message||'')}\n${o.sn?'SN: '+safe(o.sn):''}\n${o.refunded?'Saldo telah dikembalikan.':''}\n${o.testing?'MODE UJI — bukan pengiriman nyata.':''}`, [row(button(admin?'admin_df_check:'+o.id:'df_check:'+o.ref_id,'Cek Status',3),button(admin?'admin_df_orders:0:all':'df_history:0','Riwayat'),button(admin?'admin_home':'shop_home',admin?'Menu Awal Admin':'Menu Awal'))]);}
 return async i=>{
  const id=String(i.customId||''),admin=id==='admin_digiflazz'||id.startsWith('admin_df_'),user=i.user.id;if(id!=='shop_games'&&!id.startsWith('df_')&&!admin)return false;
  if(admin&&!staff?.isOwner(user)){await i.reply({ephemeral:true,content:'Akses ditolak. Digiflazz khusus owner.'});return true;}
  const [action,arg,extra]=id.split(':');
  try{
   if(action==='admin_df_alert_config'){const v=model.settings();await i.showModal(form('admin_df_alert_save','Peringatan Saldo Provider',[field('threshold','Batas saldo IDR; 0 = matikan',v.balance_threshold,10)]));return true;}
   if(action==='admin_df_preset'){const p=model.product(arg);await i.showModal(form('admin_df_preset_save:'+p.id,'Preset ID / Server per Brand',[field('format','Format: id / concat / pipe',p.target_format,6),field('help','Petunjuk tujuan seluruh brand',p.target_help,300)]));return true;}
   if(action==='admin_df_settings'){const s=model.settings();await i.showModal(form('admin_df_settings_save','Pengaturan Digiflazz',[field('enabled','Layanan: 1 buka / 0 tutup',s.enabled,1),field('percent','Markup Digiflazz (%)',s.basis_points==null?'0':s.basis_points/100,7),field('fee','Tambahan harga (IDR)',s.fee??0,7)]));return true;}
   if(action==='admin_df_edit'){const p=model.product(arg);await i.showModal(form('admin_df_save:'+p.id,'Atur Produk Digiflazz',[field('enabled','Status toko: 1 aktif / 0 nonaktif',p.enabled,1),field('price','Harga tetap IDR; kosong = markup',p.sell_price??'',8,false),field('format','id / concat / pipe / inherit',p.target_override?p.target_format:'inherit',7),field('help','Petunjuk ID / server pembeli',p.target_help,300,false)]));return true;}
   if(action==='admin_df_brand_edit'){const p=model.product(arg);await i.showModal(form('admin_df_brand_save:'+p.id,'Atur Semua Produk Layanan',[field('enabled','Semua SKU layanan: 1 aktif / 0 tutup','',1)]));return true;}
   if(action==='df_target_open'||action==='df_product'){const p=model.product(arg);await i.showModal(form('df_target:'+p.id,'Tujuan Topup',[field('customer_no','ID pemain / nomor tujuan','',80),...(p.target_format==='id'?[]:[field('server','Server / Zone ID','',20)])]));return true;}
   if(action==='df_search'||action==='admin_df_search'){await i.showModal(form(admin?'admin_df_search_submit':'df_search_submit','Cari Produk Digiflazz',[field('query','Nama game / produk / kode SKU','',80)]));return true;}
   await i.deferReply({ephemeral:true});let payload;
   if(action==='admin_df_alert_save'){model.configureAlerts(user,i.fields.getTextInputValue('threshold'));payload=alerts();}
   else if(action==='admin_df_alerts')payload=alerts();
   else if(action==='admin_df_preset_save'){payload=detail(model.preset(user,arg,i.fields.getTextInputValue('format').trim(),i.fields.getTextInputValue('help')),true);}
   else if(action==='df_favorite_toggle'){const saved=model.toggleFavorite(user,arg);payload=products(false,Number(arg),0);payload.content=saved?'⭐ Game disimpan ke favorit.':'Game dihapus dari favorit.';}
   else if(action==='df_favorites'){const r=model.favoritePage(user,Number(arg||0)),components=[];for(let j=0;j<r.rows.length;j+=5)components.push(row(...r.rows.slice(j,j+5).map(p=>button('df_list:'+p.id+':0',p.brand))));components.push(row(button('df_favorites:'+(r.page-1),'Sebelumnya').setDisabled(r.page===0),button('df_favorites:'+(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1)));components.push(row(button('shop_games','Kembali'),button('shop_home','Menu Awal')));payload=view('⭐ Game Favorit',`Halaman ${r.page+1}/${r.pages} • ${r.count} game\nKlik game untuk melihat produk yang sedang tersedia. Simpan/hapus favorit melalui halaman produk game.`,components);}
   else if(action==='admin_df_report'){const r=model.report(user,arg||'today');payload=view('📊 Keuntungan Game',`Periode: ${r.period} (WIB, tanggal pesanan)\nPesanan sukses produksi: ${r.count}\nPenjualan: ${money(r.revenue)}\nModal aktual tercatat: ${money(r.cost)}\nKeuntungan kotor yang dapat dihitung: ${money(r.profit)}\nPesanan tanpa modal aktual: ${r.unknown||0}\n\nHanya transaksi sukses, bukan refund/mode uji. Keuntungan belum dikurangi biaya isi saldo, biaya lain, atau pajak. Pesanan tanpa modal aktual tidak diperkirakan keuntungannya.`,[row(button('admin_df_report:today','Hari Ini'),button('admin_df_report:month','Bulan Ini'),button('admin_df_report:all','Semua Waktu')),row(button('admin_digiflazz','Kembali'),button('admin_home','Menu Awal Admin'))]);}
   else if(action==='admin_df_prices'){const r=model.priceAlerts(user,Number(arg||0)),components=[];for(let j=0;j<r.rows.length;j+=5)components.push(row(...r.rows.slice(j,j+5).map(a=>button('admin_df_product:'+a.product_id,a.sku,2))));components.push(row(button('admin_df_prices:'+(r.page-1),'Sebelumnya').setDisabled(r.page===0),button('admin_df_prices:'+(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1)));components.push(row(button('admin_df_prices_confirm','Tandai Sudah Ditinjau',3).setDisabled(r.count===0),button('admin_df_alerts','Kembali')));payload=view('⚠️ Kenaikan Modal',`Halaman ${r.page+1}/${r.pages} • ${r.count} SKU perlu ditinjau\n\n`+r.rows.map(a=>safe(a.body)).join('\n\n'),components);}
   else if(action==='admin_df_prices_confirm')payload=view('Tinjau Peringatan Modal','Tandai seluruh peringatan kenaikan modal yang masih terbuka sebagai ditinjau? Harga produk tidak diubah.',[row(button('admin_df_prices_ack','Ya, Sudah Ditinjau',3),button('admin_df_prices:0','Batal'))]);
   else if(action==='admin_df_prices_ack'){model.ackPrices(user);payload=alerts();}
   else if(['admin_df_catalog','admin_df_transactions','admin_df_finance','admin_df_config'].includes(action))payload=section(action);
   else if(id==='admin_digiflazz'){payload=home(user);}
   else if(action==='admin_df_settings_save'){model.configureService(user,{enabled:i.fields.getTextInputValue('enabled'),percent:i.fields.getTextInputValue('percent'),fee:i.fields.getTextInputValue('fee')});payload=home(user);}
   else if(action==='admin_df_save'){const p=model.configure(user,arg,{enabled:i.fields.getTextInputValue('enabled'),sell_price:i.fields.getTextInputValue('price').trim(),target_format:i.fields.getTextInputValue('format').trim(),target_help:i.fields.getTextInputValue('help').trim()});payload=detail(p,true);}
   else if(action==='admin_df_brand_save'){const n=model.toggleBrand(user,arg,i.fields.getTextInputValue('enabled'));payload=view('Layanan Diperbarui',n+' produk pada layanan ini diperbarui.',[row(button('admin_df_list:'+arg+':0','Lihat Produk'),button('admin_digiflazz','Kembali'))]);}
   else if(id==='shop_games'||['df_brands','admin_df_brands'].includes(action))payload=brands(admin,Number(arg||0),extra||'all');
   else if(['df_list','admin_df_list'].includes(action))payload=products(admin,Number(arg||0),Number(extra||0));
   else if(['df_search_submit','admin_df_search_submit'].includes(action)){for(const [k,v]of sessions)if(v.expires<Date.now()||v.user===user)sessions.delete(k);const query=i.fields.getTextInputValue('query').trim();if(!query||query.length>80)throw Error('Isi kata pencarian.');const r={id:randomUUID(),user,query,admin,expires:Date.now()+15*60000};sessions.set(r.id,r);payload=products(admin,0,0,r);}
   else if(['df_results','admin_df_results'].includes(action)){const r=sessions.get(arg);if(!r||r.user!==user||r.admin!==admin||r.expires<Date.now())throw Error('Pencarian kedaluwarsa. Cari kembali.');payload=products(admin,0,Number(extra),r);}
   else if(action==='admin_df_product'||action==='df_detail')payload=detail(model.product(arg),admin);
   else if(action==='df_brand')payload=brands(false,0); // old index buttons safely reopen the stable catalog
   else if(action==='admin_df_sync'){await model.sync();if(!staff.isOwner(user))throw Error('Akses ditolak. Digiflazz khusus owner.');payload=home(user);payload.content='✅ Katalog disinkronkan. Pengaturan harga dan status toko dipertahankan.';}
   else if(action==='admin_df_saldo'){payload=view('💰 Saldo Digiflazz',money(await model.saldo(user)),[row(button('admin_digiflazz','Kembali'),button('admin_home','Menu Awal Admin'))]);}
   else if(action==='admin_df_connection'){const s=model.overview(user);payload=view('Koneksi & Webhook',`API: ${s.configured?'Dikonfigurasi':'Belum diisi'}\nMode: ${s.testing?'Uji':'Produksi'}\nWebhook: domain HTTPS bot + /webhooks/digiflazz\nCallback valid terakhir: ${s.webhook_ms?new Date(s.webhook_ms).toISOString():'Belum diterima'}\n\nBuka Keuangan → Cek Saldo Digiflazz untuk memeriksa koneksi API tanpa melakukan pembelian. Sinkron Katalog menguji akses daftar harga. Atur username, key, whitelist IP, dan secret webhook di Digiflazz/Railway.`,[row(button('admin_df_config','Kembali'))]);}
   else if(action==='df_target'){const p=model.product(arg);let target=i.fields.getTextInputValue('customer_no').trim();if(!/^[a-zA-Z0-9._@+-]{1,80}$/.test(target))throw Error('ID tujuan tidak valid.');if(p.target_format!=='id'){const server=i.fields.getTextInputValue('server').trim();if(!/^[a-zA-Z0-9_-]{1,20}$/.test(server))throw Error('ID server tidak valid.');target+=p.target_format==='pipe'?'|'+server:server;}const q=model.quote(user,p.id,target),balance=await getBalance(user);payload=view('Konfirmasi Topup',`${safe(p.product_name)}\nTujuan: **${safe(target)}**\nHarga: **${money(q.amount)}**\nSaldo: ${money(balance)}\n${model.testing()?'MODE UJI — bukan topup nyata.\n':''}Pastikan ID/server benar; pembelian sukses tidak bisa dibatalkan.`,[row(button('df_buy:'+q.token,'Bayar Pakai Saldo',3),button('df_detail:'+p.id,'Kembali'))]);}
   else if(action==='df_buy')payload=receipt(await model.buy(user,arg));
   else if(action==='df_check')payload=receipt(await model.recheck(arg,user));
   else if(action==='admin_df_check')payload=receipt(await model.adminCheck(user,arg),true);
   else if(action==='admin_df_orders'){const pending=extra==='pending',r=model.adminOrders(user,Number(arg),pending),components=[];for(let j=0;j<r.rows.length;j+=5)components.push(row(...r.rows.slice(j,j+5).map(o=>button('admin_df_check:'+o.id,o.status+' • '+o.product_name,2))));components.push(row(button('admin_df_orders:'+(r.page-1)+':'+(pending?'pending':'all'),'Sebelumnya').setDisabled(r.page===0),button('admin_df_orders:'+(r.page+1)+':'+(pending?'pending':'all'),'Berikutnya').setDisabled(r.page===r.pages-1)));components.push(row(button('admin_digiflazz','Kembali'),button('admin_home','Menu Awal Admin')));payload=view('Transaksi Digiflazz',`Halaman ${r.page+1}/${r.pages} • ${r.count} transaksi\nPemeriksaan menggunakan ref yang sama. Transaksi review harus dicocokkan di dashboard provider.`,components);}
   else if(action==='df_history'){const r=model.recent(user,Number(arg));payload=view('Riwayat Topup Game',`Halaman ${r.page+1}/${r.pages} • ${r.count} transaksi\n\n`+r.rows.map(o=>safe(o.product_name)+' • '+o.status+'\n'+money(o.amount)+' • '+safe(o.ref_id)).join('\n\n'),[...(r.rows.length?[row(...r.rows.map(o=>button('df_check:'+o.ref_id,o.product_name,2)))]:[]),row(button('df_history:'+(r.page-1),'Sebelumnya').setDisabled(r.page===0),button('df_history:'+(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1)),row(button('shop_games','Topup Game'))]);}
   else throw Error('Menu tidak dikenal.');
   await i.editReply(payload);
  }catch(e){const payload=view('Informasi Digiflazz',String(e.message).slice(0,900),[row(button(admin?'admin_digiflazz':'shop_games','Kembali'))]);if(i.deferred)await i.editReply(payload);else await i.reply({ephemeral:true,...payload});}
  return true;
 };
}
module.exports={md5,normalizeStatus,hmacValid,createDigiflazz,createDigiflazzHandler};
