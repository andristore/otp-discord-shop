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

function createDigiflazz({db,pricing,env=process.env,fetchImpl=fetch,now=()=>Date.now(),assertOpen=()=>{}}){
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
    const rows=await priceList();const stamp=now();
    const up=db.prepare(`INSERT INTO digiflazz_products(sku,product_name,category,brand,type,provider_price,buyer_active,seller_active,unlimited_stock,stock,multi,description,updated_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET product_name=excluded.product_name,category=excluded.category,brand=excluded.brand,type=excluded.type,provider_price=excluded.provider_price,buyer_active=excluded.buyer_active,seller_active=excluded.seller_active,unlimited_stock=excluded.unlimited_stock,stock=excluded.stock,multi=excluded.multi,description=excluded.description,updated_ms=excluded.updated_ms`);
    const tx=db.transaction(()=>{for(const p of rows){
      if(!p?.buyer_sku_code||!p?.product_name)continue;
      const price=positiveInt(p.price,'Harga Digiflazz');
      up.run(String(p.buyer_sku_code),String(p.product_name),String(p.category||''),String(p.brand||''),String(p.type||''),price,p.buyer_product_status?1:0,p.seller_product_status?1:0,p.unlimited_stock?1:0,positiveInt(p.stock||0,'Stok'),p.multi?1:0,String(p.desc||''),stamp);
    }});tx();return rows.length;
  }
  function availableSql(){return `buyer_active=1 AND seller_active=1 AND (unlimited_stock=1 OR stock>0)`;}
  function brands(){
    return db.prepare(`SELECT brand,COUNT(*) count,MIN(provider_price) min_price FROM digiflazz_products WHERE category=? AND ${availableSql()} GROUP BY brand ORDER BY brand COLLATE NOCASE`).all(category());
  }
  function products(brand){
    return db.prepare(`SELECT * FROM digiflazz_products WHERE category=? AND brand=? AND ${availableSql()} ORDER BY provider_price,product_name COLLATE NOCASE`).all(category(),brand).map(p=>({...p,selling_price:pricing.price(p.provider_price)}));
  }
  function product(id){const p=db.prepare('SELECT * FROM digiflazz_products WHERE id=?').get(Number(id));if(!p)throw new Error('Produk Digiflazz tidak ditemukan.');return {...p,selling_price:pricing.price(p.provider_price)};}
  const quotes=new Map();
  function quote(userId,productId,customerNo){
    assertOpen();const p=product(productId);
    if(p.category!==category()||!p.buyer_active||!p.seller_active||(!p.unlimited_stock&&p.stock<1))throw new Error('Produk sedang tidak tersedia.');
    customerNo=String(customerNo||'').trim();
    if(!customerNo||customerNo.length>100||/[\r\n\t]/.test(customerNo))throw new Error('ID/nomor tujuan tidak valid.');
    for(const [k,v]of quotes)if(v.expires<=now())quotes.delete(k);
    const token=randomUUID();quotes.set(token,{userId:String(userId),productId:p.id,sku:p.sku,name:p.product_name,brand:p.brand,customerNo,providerPrice:p.provider_price,amount:p.selling_price,expires:now()+5*60000});return {token,...quotes.get(token)};
  }
  function debit(user,amount){
    db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING').run(user);
    const r=db.prepare('UPDATE users SET balance=balance-? WHERE discord_id=? AND balance>=?').run(amount,user,amount);if(r.changes!==1)throw new Error('Saldo tidak cukup. Isi saldo dahulu.');
  }
  function refund(row){
    if(row.refunded)return false;
    return db.transaction(()=>{const fresh=db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);if(!fresh||fresh.refunded)return false;db.prepare('UPDATE users SET balance=balance+? WHERE discord_id=?').run(fresh.amount,fresh.discord_id);db.prepare('UPDATE digiflazz_orders SET refunded=1,updated_ms=? WHERE id=?').run(now(),fresh.id);return true;})();
  }
  function apply(refId,data){
    const row=db.prepare('SELECT * FROM digiflazz_orders WHERE ref_id=?').get(refId);if(!row)return null;
    if(String(data.ref_id||'')!==row.ref_id||String(data.buyer_sku_code||'')!==row.sku||String(data.customer_no||'')!==row.customer_no)throw new Error('Respons transaksi Digiflazz tidak cocok dengan pesanan.');
    const status=normalizeStatus(data.status);const providerPrice=data.price==null?row.provider_price:positiveInt(data.price,'Harga transaksi');
    db.prepare(`UPDATE digiflazz_orders SET provider_price=?,status=?,provider_status=?,rc=?,message=?,sn=?,buyer_last_saldo=?,updated_ms=? WHERE id=?`).run(providerPrice,status,String(data.status||''),data.rc==null?null:String(data.rc),String(data.message||''),data.sn==null?null:String(data.sn),data.buyer_last_saldo==null?null:Math.trunc(Number(data.buyer_last_saldo)),now(),row.id);
    const current=db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);if(status==='failed')refund(current);return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);
  }
  async function sendTransaction(row){
    requireConfig();const body={username:username(),buyer_sku_code:row.sku,customer_no:row.customer_no,ref_id:row.ref_id,sign:md5(username()+apiKey()+row.ref_id)};if(testing())body.testing=true;
    const result=await post('/transaction',body);if(!result?.data)throw new Error('Format transaksi Digiflazz tidak valid.');return apply(row.ref_id,result.data);
  }
  async function buy(userId,token){
    assertOpen();const q=quotes.get(token);if(!q||q.userId!==String(userId)||q.expires<=now())throw new Error('Konfirmasi kedaluwarsa. Pilih produk kembali.');quotes.delete(token);
    const latest=product(q.productId);if(latest.provider_price!==q.providerPrice||latest.selling_price!==q.amount)throw new Error('Harga berubah. Pilih produk kembali.');
    const ref='DF-'+randomUUID();let row;
    db.transaction(()=>{debit(String(userId),q.amount);const r=db.prepare(`INSERT INTO digiflazz_orders(ref_id,discord_id,product_id,sku,product_name,customer_no,provider_price,amount,status,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(ref,String(userId),q.productId,q.sku,q.name,q.customerNo,q.providerPrice,q.amount,'creating',now(),now());row=db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(r.lastInsertRowid);})();
    try{return await sendTransaction(row);}catch(e){db.prepare("UPDATE digiflazz_orders SET status='pending',message=?,updated_ms=? WHERE id=? AND status='creating'").run('Status provider belum terkonfirmasi: '+String(e.message).slice(0,300),now(),row.id);return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);}
  }
  async function recheck(refId,userId){const row=db.prepare('SELECT * FROM digiflazz_orders WHERE ref_id=? AND discord_id=?').get(String(refId),String(userId));if(!row)throw new Error('Pesanan tidak ditemukan.');if(['success','failed'].includes(row.status))return row;try{return await sendTransaction(row);}catch{return db.prepare('SELECT * FROM digiflazz_orders WHERE id=?').get(row.id);}}
  let polling=false;
  async function poll(){if(polling||!configured())return;polling=true;try{for(const row of db.prepare("SELECT * FROM digiflazz_orders WHERE status IN ('creating','pending') AND updated_ms<=? ORDER BY updated_ms LIMIT 10").all(now()-30000)){try{await sendTransaction(row);}catch{db.prepare('UPDATE digiflazz_orders SET updated_ms=? WHERE id=?').run(now(),row.id);}}}finally{polling=false;}}
  function recent(userId,page=0){const count=db.prepare('SELECT COUNT(*) n FROM digiflazz_orders WHERE discord_id=?').get(String(userId)).n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number(page)||0,0),pages-1);return {page,pages,count,rows:db.prepare('SELECT * FROM digiflazz_orders WHERE discord_id=? ORDER BY created_ms DESC,id DESC LIMIT 5 OFFSET ?').all(String(userId),page*5)};}
  function mount(app){
    app.post('/webhooks/digiflazz',(req,res)=>{try{const secret=String(env.DIGIFLAZZ_WEBHOOK_SECRET||'');if(!hmacValid(secret,req.rawBody,req.get('X-Hub-Signature')))return res.status(401).json({ok:false});const data=req.body?.data;if(!data?.ref_id)return res.status(400).json({ok:false});const row=db.prepare('SELECT * FROM digiflazz_orders WHERE ref_id=?').get(String(data.ref_id));if(!row)return res.status(200).json({ok:true,ignored:true});apply(row.ref_id,data);return res.json({ok:true});}catch{return res.status(400).json({ok:false});}});
  }
  return {configured,category,sync,brands,products,product,quote,buy,recheck,recent,poll,mount,apply,hmacValid:(raw,header)=>hmacValid(String(env.DIGIFLAZZ_WEBHOOK_SECRET||''),raw,header)};
}

function createDigiflazzHandler({discord,model,getBalance}){
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const money=n=>`${Number(n||0).toLocaleString('id-ID')} IDR`;
  const brandState=new Map();
  function rows(buttons){const out=[];for(let i=0;i<buttons.length;i+=5)out.push(new ActionRowBuilder().addComponents(...buttons.slice(i,i+5)));return out;}
  function statusLabel(s){return s==='success'?'✅ Sukses':s==='failed'?'❌ Gagal':'⏳ Pending';}
  return async function handle(i){
    const id=String(i.customId||'');
    if(id==='shop_games'){
      if(!model.configured())return i.reply({ephemeral:true,content:'🎮 Top Up Game belum aktif. Admin perlu mengisi konfigurasi Digiflazz.'});
      await i.deferReply({ephemeral:true});const brands=model.brands();
      if(!brands.length)return i.editReply({content:'Belum ada produk game aktif. Admin perlu sinkronisasi katalog Digiflazz.'});
      const buttons=brands.slice(0,24).map((b,n)=>new ButtonBuilder().setCustomId(`df_brand:${n}`).setLabel(String(b.brand).slice(0,80)).setStyle(ButtonStyle.Primary));brandState.set(i.user.id,{brands:brands.slice(0,24).map(b=>b.brand),expires:Date.now()+600000});buttons.push(new ButtonBuilder().setCustomId('df_history:0').setLabel('Riwayat').setStyle(ButtonStyle.Secondary));
      return i.editReply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('🎮 Top Up Game').setDescription('Pilih game/brand. Harga yang tampil adalah harga jual toko.')],components:rows(buttons)});
    }
    if(id.startsWith('df_brand:')){
      const state=brandState.get(i.user.id),idx=Number(id.split(':')[1]);if(!state||state.expires<Date.now()||!state.brands[idx])return i.reply({ephemeral:true,content:'Menu kedaluwarsa. Buka Top Up Game kembali.'});
      const list=model.products(state.brands[idx]);const buttons=list.slice(0,24).map(p=>new ButtonBuilder().setCustomId(`df_product:${p.id}`).setLabel(`${String(p.product_name).slice(0,55)} • ${money(p.selling_price)}`.slice(0,80)).setStyle(ButtonStyle.Secondary));buttons.push(new ButtonBuilder().setCustomId('shop_games').setLabel('Kembali').setStyle(ButtonStyle.Primary));
      return i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(`🎮 ${state.brands[idx]}`).setDescription(list.length?'Pilih produk/nominal, lalu masukkan ID atau nomor tujuan.':'Produk sedang tidak tersedia.')],components:rows(buttons)});
    }
    if(id.startsWith('df_product:')){
      const p=model.product(id.split(':')[1]);return i.showModal(new ModalBuilder().setCustomId(`df_target:${p.id}`).setTitle('Tujuan Top Up').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('customer_no').setLabel('ID / Nomor Tujuan').setPlaceholder('Contoh: User ID / nomor HP').setRequired(true).setMaxLength(100).setStyle(TextInputStyle.Short))));
    }
    if(id.startsWith('df_target:')&&i.isModalSubmit()){
      const p=model.product(id.split(':')[1]);const q=model.quote(i.user.id,p.id,i.fields.getTextInputValue('customer_no'));const balance=await getBalance(i.user.id);
      return i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('🧾 Konfirmasi Top Up').addFields({name:'Produk',value:`**${p.product_name}**`},{name:'Tujuan',value:`\`${q.customerNo}\``,inline:true},{name:'Harga',value:`**${money(q.amount)}**`,inline:true},{name:'Saldo',value:`**${money(balance)}**`,inline:true}).setDescription('Periksa ID/nomor tujuan. Transaksi yang berhasil diproses provider tidak dapat dibatalkan.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`df_buy:${q.token}`).setLabel('Bayar Pakai Saldo').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('shop_games').setLabel('Batal').setStyle(ButtonStyle.Secondary))]});
    }
    if(id.startsWith('df_buy:')){
      await i.deferReply({ephemeral:true});try{const o=await model.buy(i.user.id,id.split(':')[1]);return i.editReply({embeds:[new EmbedBuilder().setColor(o.status==='success'?0x57F287:o.status==='failed'?0xED4245:0xFEE75C).setTitle(statusLabel(o.status)).addFields({name:'Produk',value:o.product_name},{name:'Tujuan',value:`\`${o.customer_no}\``,inline:true},{name:'Harga',value:money(o.amount),inline:true},{name:'Ref ID',value:`\`${o.ref_id}\``},{name:'Keterangan',value:String(o.message||'-').slice(0,1000)}).setDescription(o.sn?`SN: **${o.sn}**`:o.refunded?'Saldo sudah dikembalikan otomatis.':'Jika masih pending, gunakan Cek Status.')],components:o.status==='pending'?[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`df_check:${o.ref_id}`).setLabel('Cek Status').setStyle(ButtonStyle.Primary))]:[]});}catch(e){return i.editReply('❌ '+e.message);}
    }
    if(id.startsWith('df_check:')){await i.deferReply({ephemeral:true});try{const o=await model.recheck(id.slice('df_check:'.length),i.user.id);return i.editReply(`${statusLabel(o.status)} — ${o.product_name}\nTujuan: ${o.customer_no}\n${o.sn?'SN: '+o.sn:o.message||''}${o.refunded?'\nSaldo sudah dikembalikan.':''}`);}catch(e){return i.editReply('❌ '+e.message);}}
    if(id.startsWith('df_history:')){const r=model.recent(i.user.id,Number(id.split(':')[1]));const desc=r.rows.length?r.rows.map(o=>`**${statusLabel(o.status)} • ${o.product_name}**\n${o.customer_no} • ${money(o.amount)}\nRef: \`${o.ref_id}\`${o.sn?' • SN: '+o.sn:''}`).join('\n\n'):'Belum ada transaksi Top Up Game.';const buttons=[];if(r.page>0)buttons.push(new ButtonBuilder().setCustomId(`df_history:${r.page-1}`).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary));if(r.page+1<r.pages)buttons.push(new ButtonBuilder().setCustomId(`df_history:${r.page+1}`).setLabel('Berikutnya').setStyle(ButtonStyle.Secondary));buttons.push(new ButtonBuilder().setCustomId('shop_games').setLabel('Top Up Game').setStyle(ButtonStyle.Primary));return i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('🎮 Riwayat Top Up Game').setDescription(desc).setFooter({text:`Halaman ${r.page+1}/${r.pages}`})],components:rows(buttons)});}
    return false;
  };
}
module.exports={md5,normalizeStatus,hmacValid,createDigiflazz,createDigiflazzHandler};
