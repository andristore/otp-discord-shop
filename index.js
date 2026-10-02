require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require("discord.js");

const {createAdminHandler}=require("./admin");
const {createPurchaseFlow}=require("./purchase-flow");
const {createPayments,createPaymentHandler}=require("./payments");
const {createPricing}=require("./pricing");
const {createCommerce}=require("./commerce");
const {createDirectPayments,createDirectHandler}=require("./direct-payments");
const app = express();
const db = new Database("shop.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  service TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  provider_order_id TEXT,
  phone TEXT,
  otp TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

if (db.prepare("SELECT COUNT(*) c FROM products").get().c === 0) {
  const add = db.prepare("INSERT INTO products (name,country,service,price) VALUES (?,?,?,?)");
  add.run("Indonesia • WhatsApp", "ID", "WhatsApp", 5000);
  add.run("Indonesia • Telegram", "ID", "Telegram", 5000);
  add.run("Indonesia • SMS", "ID", "SMS", 4000);
}

const pricing=createPricing(db);
const commerce=createCommerce({db,pricing,smsCreateOrder,smsCancel});
app.use(express.json({verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf);}}));
let direct;
const payments=createPayments({db,onSettled:payment=>direct.fulfill(payment)});
direct=createDirectPayments({db,payments,commerce,smsCatalogProducts,smsCreateOrder,smsCancel});
payments.mount(app);
const directPoll=setInterval(()=>direct.poll().catch(console.error),30000);
directPoll.unref();
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret: process.env.SESSION_SECRET || "replace-me",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false }
}));
app.use(express.static("public"));

function admin(req,res,next){
  if(req.session.admin) return next();
  res.status(401).json({error:"Unauthorized"});
}

async function smscode(path, options={}) {
  const base = (process.env.SMSCODE_API_BASE_URL || "https://api.smscode.gg/v1").replace(/\/$/,"");
  if(!process.env.SMSCODE_API_TOKEN) throw new Error("SMSCODE_API_TOKEN belum diisi");
  const headers = {
    "Content-Type":"application/json",
    "Authorization":`Bearer ${process.env.SMSCODE_API_TOKEN}`,
    ...(options.headers||{})
  };
  const r = await fetch(base + path, {...options, headers, signal: options.signal || AbortSignal.timeout(15_000)});
  const body = await r.text();
  let data; try { data = JSON.parse(body); } catch { data = {success:false,error:{message:body}}; }
  if(!r.ok || data.success === false) {
    throw new Error(data?.error?.message || `SMSCode HTTP ${r.status}`);
  }
  return data;
}

function uuidKey(){ return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

const CATALOG_CACHE_MS = 60_000;
const catalogCache = new Map();
const catalogLoading = new Map();

async function smsCatalogProducts(filters={}){
  const query=['platform_id','country_id'].filter(key=>filters[key]!=null)
    .map(key=>`${key}=${encodeURIComponent(filters[key])}`).join('&');
  const cached=catalogCache.get(query);
  if(cached && Date.now() < cached.expiresAt) return cached.result;
  if(catalogLoading.has(query)) return catalogLoading.get(query);
  const loading = (async()=>{
    const products = new Map();
    const limit = 1000;
    for(let page=1; ; page++){
      const result = await smscode(`/catalog/products?limit=${limit}&page=${page}&sort=name_asc${query?"&"+query:""}`);
      if(!Array.isArray(result.data)) throw new Error("Format katalog SMSCode tidak valid.");
      const rows = result.data;
      if(!rows.length) break;
      const before = products.size;
      for(const product of rows){
        if(product.id == null) throw new Error("Produk SMSCode tidak memiliki ID.");
        products.set(String(product.id), product);
      }
      if(products.size === before) throw new Error("SMSCode mengulang halaman katalog; coba lagi nanti.");
      const pageLimit = Number(result.meta?.limit) || limit;
      if(rows.length < pageLimit) break;
    }
    const result = {data: [...products.values()]};
    for(const [key,entry] of catalogCache) if(entry.expiresAt<=Date.now())catalogCache.delete(key);
    catalogCache.set(query,{result, expiresAt: Date.now() + CATALOG_CACHE_MS});
    return result;
  })();
  catalogLoading.set(query,loading);
  try { return await loading; }
  finally { catalogLoading.delete(query); }
}

function catalogPage(products, requestedPage=0){
  const pageCount = Math.max(1, Math.ceil(products.length / 25));
  const page = Math.min(Math.max(Number.isSafeInteger(requestedPage) ? requestedPage : 0, 0), pageCount-1);
  return {page, pageCount, products: products.slice(page*25, (page+1)*25)};
}

function productAvailable(p){ return Boolean(p.active) && Number(p.available)>0; }

async function smsCreateOrder(productId){
  return smscode("/orders/create", {
    method:"POST",
    headers:{"Idempotency-Key":uuidKey()},
    body:JSON.stringify({product_id:Number(productId), quantity:1})
  });
}

async function smsOrder(orderId){
  return smscode(`/orders/${encodeURIComponent(orderId)}`);
}

async function smsCancel(orderId){
  return smscode("/orders/cancel", {
    method:"POST",
    body:JSON.stringify({id:Number(orderId)})
  });
}

async function smsFinish(orderId){
  return smscode("/orders/finish", {
    method:"POST",
    body:JSON.stringify({id:Number(orderId)})
  });
}

app.get("/api/products",async(req,res)=>{
  try {
    const data=await smsCatalogProducts();
    const rows=data.data.map(p=>({...p,price:pricing.price(p.price?.canonical_amount ?? p.price)}));
    res.json(rows);
  } catch(e) {
    res.status(502).json({error:e.message});
  }
});

app.post("/api/admin/login",(req,res)=>{
  if(req.body.password && req.body.password === process.env.ADMIN_PASSWORD){
    req.session.admin = true; return res.json({ok:true});
  }
  res.status(401).json({error:"Password salah"});
});
app.post("/api/admin/logout",admin,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/admin/products",admin,(req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all()));
app.post("/api/admin/products",admin,(req,res)=>{
  const {name,country,service,price,enabled=true}=req.body;
  if(!name||!country||!service||Number(price)<0) return res.status(400).json({error:"Data produk tidak valid"});
  const x=db.prepare("INSERT INTO products(name,country,service,price,enabled) VALUES(?,?,?,?,?)")
    .run(name,country,service,Number(price),enabled?1:0);
  res.json({id:x.lastInsertRowid});
});
app.patch("/api/admin/products/:id",admin,(req,res)=>{
  const p=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if(!p) return res.status(404).json({error:"Produk tidak ditemukan"});
  const name=req.body.name ?? p.name, country=req.body.country ?? p.country,
        service=req.body.service ?? p.service, price=Number(req.body.price ?? p.price),
        enabled=req.body.enabled===undefined?p.enabled:(req.body.enabled?1:0);
  db.prepare("UPDATE products SET name=?,country=?,service=?,price=?,enabled=? WHERE id=?")
    .run(name,country,service,price,enabled,p.id);
  res.json({ok:true});
});

app.get("/api/admin/health",admin,async(req,res)=>{
  try {
    const bal=await smscode("/balance");
    res.json({ok:true,provider:"SMSCode",balance:bal.data});
  } catch(e){ res.json({ok:true,provider:"SMSCode",connected:false,error:e.message}); }
});

app.post("/api/order",admin,async(req,res)=>{
  const {discordId,productId}=req.body;
  if(!discordId||!productId)return res.status(400).json({error:"discordId dan productId wajib"});
  try {
    const catalog=await smsCatalogProducts();
    const p=catalog.data.find(p=>Number(p.id)===Number(productId));
    if(!p || !productAvailable(p))return res.status(400).json({error:"Produk tidak tersedia"});
    const q=commerce.quote(String(discordId),p);
    const {order,amount}=await commerce.buy(String(discordId),q.token);
    res.json({ok:true,orderId:order.id,phone:order.phone_number,amount,status:order.status});
  }catch(e){res.status(502).json({error:e.message});}
});

app.get("/api/order/:id",admin, async(req,res)=>{
  const order=db.prepare("SELECT * FROM orders WHERE provider_order_id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:"Order tidak ditemukan"});
  try {
    const result=await smsOrder(req.params.id);
    const d=result.data;
    db.prepare("UPDATE orders SET otp=?,status=?,phone=? WHERE id=?")
      .run(d.otp_code||null,d.status||"ACTIVE",d.phone_number||order.phone,order.id);
    res.json({ok:true,status:d.status,otp:d.otp_code||null,phone:d.phone_number||order.phone,expiresAt:d.expires_at});
  } catch(e){res.status(502).json({error:e.message});}
});

app.post("/api/order/:id/cancel",admin,async(req,res)=>{
  const order=db.prepare("SELECT * FROM orders WHERE provider_order_id=?").get(req.params.id);
  if(!order)return res.status(404).json({error:"Order tidak ditemukan"});
  try {const refund=await commerce.cancel(req.params.id,order.discord_id);res.json({ok:true,status:"CANCELED",refund});}
  catch(e){res.status(502).json({error:e.message});}
});

app.post("/api/discord/balance",admin, (req,res)=>{
  const id=String(req.body.discordId||"");
  if(!id) return res.status(400).json({error:"discordId wajib"});
  db.prepare("INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING").run(id);
  res.json(db.prepare("SELECT balance FROM users WHERE discord_id=?").get(id));
});

const client = new Client({intents:[GatewayIntentBits.Guilds]});
async function startDiscord(){
  if(!process.env.DISCORD_TOKEN) return console.log("DISCORD_TOKEN belum diisi; bot tidak dijalankan.");
  const commands=[
    new SlashCommandBuilder().setName("shop").setDescription("Buka panel toko OTP"),
    new SlashCommandBuilder().setName("admin").setDescription("Buka panel admin toko OTP")
  ].map(x=>x.toJSON());
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  if(process.env.DISCORD_CLIENT_ID) await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),{body:commands});
  function money(n){ return `${Number(n||0).toLocaleString("id-ID")} IDR`; }

  async function getBalance(id){
    db.prepare("INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING").run(id);
    return db.prepare("SELECT balance FROM users WHERE discord_id=?").get(id).balance;
  }

  function shopEmbed(balance, title="OTP Maboyy"){
    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🛍️ ${title}`)
      .setDescription(
        "Selamat datang di OTP Maboyy.\n\n" +
        "Pilih menu di bawah untuk mulai bertransaksi.\n" +
        "🔒 Transaksi diproses otomatis melalui provider."
      )
      .addFields({name:"💰 Saldo Anda",value:`**${money(balance)}**`,inline:true})
      .setFooter({text:"OTP Maboyy • Automated Service"});
  }

  function mainRow(){
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("shop_products").setLabel("Beli OTP").setEmoji("🛒").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("shop_balance").setLabel("Saldo").setEmoji("💰").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("shop_orders").setLabel("Pesanan").setEmoji("📦").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("shop_topup").setLabel("Isi Saldo QRIS").setEmoji("💳").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("shop_help").setLabel("Bantuan").setEmoji("❓").setStyle(ButtonStyle.Secondary)
    );
  }

  const handleAdmin=createAdminHandler({discord:require("discord.js"),db,smscode,pricing,resolveUser:id=>client.users.fetch(id)});
  const handleFlow=createPurchaseFlow({discord:require("discord.js"),smscode,smsCatalogProducts,pricing});
  const handleProviderFlow=createPurchaseFlow({discord:require("discord.js"),smscode,smsCatalogProducts,pricing,adminView:true});
  const handlePayment=createPaymentHandler({discord:require("discord.js"),payments});
  const handleDirect=createDirectHandler({discord:require("discord.js"),direct,payments});
  direct.setNotifier(async row=>{const user=await client.users.fetch(row.discord_id);await user.send(handleDirect.status(row));});
  client.on("interactionCreate", async i=>{
    try {
      const id=i.user.id;
      if(await handleAdmin(i)) return;
      if(await handleProviderFlow(i)) return;
      if(await handlePayment(i)) return;
      if(await handleDirect(i)) return;
      if(await handleFlow(i)) return;

      if(i.isChatInputCommand() && i.commandName==="shop"){
        const balance=await getBalance(id);
        return i.reply({embeds:[shopEmbed(balance)],components:[mainRow(),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("topup_history").setLabel("Riwayat Isi Saldo").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("direct_history").setLabel("Riwayat QRIS Beli").setStyle(ButtonStyle.Secondary))]});
      }

      if(i.isButton()){
        if(i.customId==="shop_balance"){
          const balance=await getBalance(id);
          return i.reply({
            ephemeral:true,
            embeds:[new EmbedBuilder().setColor(0x57F287).setTitle("💰 Saldo Anda").setDescription(`Saldo saat ini:\n\n# **${money(balance)}**`)]
          });
        }

        if(i.customId==="shop_help"){
          return i.reply({
            ephemeral:true,
            embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle("❓ Bantuan")
              .setDescription(
                "**Cara membeli OTP**\n" +
                "1. Klik **Beli OTP**\n" +
                "2. Pilih aplikasi, negara, operator, dan harga\n" +
                "3. Konfirmasi pembelian\n" +
                "4. Nomor akan diberikan\n" +
                "5. Klik **Cek OTP** untuk mengambil kode\n\n" +
                "Jika order gagal, hubungi admin toko."
              )]
          });
        }

        if(i.customId==="shop_orders"){
          const rows=db.prepare(`SELECT o.provider_order_id,o.phone,o.status,o.amount,o.created_at,
            p.name FROM orders o LEFT JOIN products p ON p.id=o.product_id
            WHERE o.discord_id=? ORDER BY o.id DESC LIMIT 10`).all(id);
          if(!rows.length) return i.reply({ephemeral:true,content:"Anda belum memiliki pesanan."});
          const desc=rows.map(o=>`**#${o.provider_order_id}** • ${o.name||"OTP"}\n📱 ${o.phone||"-"} • ${o.status} • ${money(o.amount)}`).join("\n\n");
          return i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle("📦 Pesanan Saya").setDescription(desc)]});
        }

        if(i.customId.startsWith("confirm_buy:")){
          const token=i.customId.split(":")[1];
          await i.deferReply({ephemeral:true});
          try{
            const {order,amount}=await commerce.buy(id,token);
            const buttons=new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`check_otp:${order.id}`).setLabel("Cek OTP").setEmoji("🔢").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`cancel_order:${order.id}`).setLabel("Batalkan").setEmoji("❌").setStyle(ButtonStyle.Danger)
            );
            return i.editReply({
              embeds:[new EmbedBuilder().setColor(0x57F287).setTitle("✅ Order Berhasil")
                .addFields(
                  {name:"Order",value:`\`${order.id}\``,inline:true},
                  {name:"Nomor",value:`**${order.phone_number}**`,inline:true},
                  {name:"Harga",value:`**${money(amount)}**`,inline:true},
                  {name:"Status",value:`**${order.status}**`,inline:true}
                )
                .setDescription("Tunggu SMS masuk, lalu tekan **Cek OTP**.")],
              components:[buttons]
            });
          }catch(e){return i.editReply("❌ Gagal membuat order: "+e.message);}
        }

        if(i.customId.startsWith("check_otp:")){
          const poid=i.customId.split(":")[1];
          const order=db.prepare("SELECT * FROM orders WHERE provider_order_id=? AND discord_id=?").get(poid,id);
          if(!order) return i.reply({ephemeral:true,content:"Order tidak ditemukan."});
          await i.deferReply({ephemeral:true});
          try{
            const result=await smsOrder(poid), d=result.data;
            db.prepare("UPDATE orders SET otp=?,status=?,phone=? WHERE id=?")
              .run(d.otp_code||null,d.status||"ACTIVE",d.phone_number||order.phone,order.id);
            if(d.otp_code){
              return i.editReply({embeds:[new EmbedBuilder().setColor(0x57F287).setTitle("🔢 OTP Diterima")
                .addFields({name:"Nomor",value:`\`${d.phone_number||order.phone}\``,inline:true},{name:"OTP",value:`**${d.otp_code}**`,inline:true})
                .setDescription("Gunakan kode tersebut pada layanan yang Anda beli.") ]});
            }
            return i.editReply({embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle("⏳ OTP Belum Masuk")
              .setDescription(`Status: **${d.status}**\nNomor: **${d.phone_number||order.phone}**\n\nTekan **Cek OTP** lagi beberapa saat kemudian.`)]});
          }catch(e){return i.editReply("❌ Gagal mengecek OTP: "+e.message);}
        }

        if(i.customId.startsWith("cancel_order:")){
          const poid=i.customId.split(":")[1];
          const order=db.prepare("SELECT * FROM orders WHERE provider_order_id=? AND discord_id=?").get(poid,id);
          if(!order) return i.reply({ephemeral:true,content:"Order tidak ditemukan."});
          await i.deferReply({ephemeral:true});
          try{
            const refund=await commerce.cancel(poid,id);
            return i.editReply(`✅ Order dibatalkan. **${money(refund)}** dikembalikan ke saldo.`);
          }catch(e){return i.editReply("❌ Tidak dapat membatalkan order: "+e.message);}
        }
      }

      if((i.isButton() && i.customId.startsWith("pick_product:")) || (i.isStringSelectMenu() && i.customId==="buy_product")){
        await i.deferReply({ephemeral:true});
        const pid=Number(i.isButton()?i.customId.split(":")[1]:i.values[0]);
        const parts=i.isButton()?i.customId.split(':'):[];
        const data=await smsCatalogProducts(parts.length>=4?{platform_id:parts[2],country_id:parts[3]}:{});
        const p=(data.data||[]).find(x=>Number(x.id)===pid);
        if(!p || !productAvailable(p)) return i.editReply({content:"Produk sedang tidak tersedia. Pilih layanan lain dari katalog."});
        const quote=commerce.quote(id,p);
        const price=quote.amount;
        const balance=await getBalance(id);
        const confirm=new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_buy:${quote.token}`).setLabel("Bayar Pakai Saldo").setEmoji("💰").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`qris_buy:${quote.token}`).setLabel("Bayar Langsung QRIS").setEmoji("💳").setStyle(ButtonStyle.Primary).setDisabled(price<1000),
          new ButtonBuilder().setCustomId("shop_products").setLabel("Kembali").setEmoji("↩️").setStyle(ButtonStyle.Secondary)
        );
        return i.editReply({
          embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle("🧾 Konfirmasi Pembelian")
            .addFields(
              {name:"Produk",value:`**${p.name}**`,inline:false},
              {name:"Harga",value:`**${money(price)}**`,inline:true},
              {name:"Saldo",value:`**${money(balance)}**`,inline:true},
              {name:"Stok",value:`**${p.available}**`,inline:true}
            )
            .setDescription("Pastikan produk dan harga sudah benar sebelum melanjutkan.")],
          components:[confirm]
        });
      }
    } catch(e){
      console.error(e);
      try{
        if(i.deferred) await i.editReply("❌ Terjadi kesalahan.");
        else if(!i.replied) await i.reply({ephemeral:true,content:"❌ Terjadi kesalahan."});
      }catch{}
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}
startDiscord();

app.listen(process.env.PORT||3000,()=>console.log(`Dashboard: http://localhost:${process.env.PORT||3000}`));
