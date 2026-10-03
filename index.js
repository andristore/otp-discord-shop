require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require("discord.js");

const {createBuyerProfiles,configureBuyerProfiles,rememberBuyer}=require("./buyer-profiles");
const {createManualProducts,createManualProductsHandler}=require("./manual-products");
const {createOrderHistory,createOrderHistoryHandler}=require("./order-history");
const {createAdminHandler,configureAdminAccess}=require("./admin");
const {createPurchaseFlow}=require("./purchase-flow");
const {createPayments,createPaymentHandler}=require("./payments");
const {createPricing}=require("./pricing");
const {createCommerce}=require("./commerce");
const {createDirectPayments,createDirectHandler}=require("./direct-payments");
const {createOperations,createOperationsHandler}=require("./operations");
const {createServerAccess,createServerAccessHandler}=require("./server-access");
const {createStaff,createStaffHandler}=require("./staff");
const {HOME_ID,withHome,addHomeNavigation}=require("./navigation");
const {createShopTools,createShopToolsHandler}=require("./shop-tools");
const {createEfficiency,createEfficiencyHandler}=require("./efficiency");
const {createStoreFeatures,createStoreFeatureHandler,REFUND_GUIDE}=require("./store-features");
const app = express();
const databasePath = process.env.DB_PATH || (process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "shop.db")
  : "shop.db");
fs.mkdirSync(path.dirname(path.resolve(databasePath)), {recursive: true});
const db = new Database(databasePath);
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
let storeFeatures;
const assertStoreOpen=()=>storeFeatures?.assertOpen();
const commerce=createCommerce({db,pricing,smsCreateOrder,smsCancel,assertOpen:assertStoreOpen});
app.use(express.json({verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf);}}));
let direct,manualProducts;
const payments=createPayments({db,onSettled:payment=>payment.order_id.startsWith('manual-buy-')?manualProducts.fulfillPayment(payment):direct.fulfill(payment)});
direct=createDirectPayments({db,payments,commerce,smsCatalogProducts,smsCreateOrder,smsCancel,assertOpen:assertStoreOpen});
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
  const query=['platform_id','country_id','operator_id'].filter(key=>filters[key]!=null)
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
const sendDiscordDM=async(id,content)=>{if(!client.isReady())throw new Error('Discord belum siap');const user=await client.users.fetch(id);await user.send({content,allowedMentions:{parse:[]}});};
const staff=createStaff({db});configureAdminAccess(staff);
storeFeatures=createStoreFeatures({db,staff,sendDM:sendDiscordDM});
manualProducts=createManualProducts({db,staff,payments,maintenance:()=>storeFeatures.maintenance(),audit:(id,action)=>{if(!staff.isAdmin(id))throw Error('Akses ditolak.');db.prepare('INSERT INTO shop_admin_audit(admin_id,action) VALUES(?,?)').run(id,action);}});
const serverAccess=createServerAccess({db,sendDM:sendDiscordDM,staff});
const operations=createOperations({db,smscode,smsOrder,smsCancel,payments,
  sendDM:sendDiscordDM,staff});
client.on('guildCreate',guild=>serverAccess.register(guild).catch(console.error));
client.on('guildDelete',guild=>{if(!guild.unavailable)serverAccess.removed(guild.id);});
client.once('clientReady',async()=>{for(const guild of client.guilds.cache.values())try{await serverAccess.register(guild);}catch(e){console.error(e);}});
async function startDiscord(){
  if(!process.env.DISCORD_TOKEN) return console.log("DISCORD_TOKEN belum diisi; bot tidak dijalankan.");
  const commands=[
    new SlashCommandBuilder().setName("shop").setDescription("Buka panel toko OTP"),
    new SlashCommandBuilder().setName("admin").setDescription("Buka panel admin toko")
  ].map(x=>x.toJSON());
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  if(process.env.DISCORD_CLIENT_ID) await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),{body:commands});
  function money(n){ return `${Number(n||0).toLocaleString("id-ID")} IDR`; }

  async function getBalance(id){
    db.prepare("INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING").run(id);
    return db.prepare("SELECT balance FROM users WHERE discord_id=?").get(id).balance;
  }

  function shopEmbed(title="Hi, Belanja Produk Digital Yukk"){
    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🛍️ ${title}`)
      .setDescription("Selamat datang di Produk Digital by Maboyy")
      .setFooter({text:"since 2020 • Andri Store"});
  }

  function mainRow(){
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("shop_products").setLabel("Beli OTP").setEmoji("🛒").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("shop_manual_products").setLabel("Produk Lainnya").setEmoji("📦").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("shop_balance").setLabel("Saldo").setEmoji("💰").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("shop_orders").setLabel("Pesanan").setEmoji("📦").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("shop_topup").setLabel("Isi Saldo").setEmoji("💳").setStyle(ButtonStyle.Primary)
    ),new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("shop_help").setLabel("Bantuan").setEmoji("❓").setStyle(ButtonStyle.Secondary)
    )];
  }

  const efficiency=createEfficiency({db,staff});
  const toolkit=createShopTools({db,staff,payments,smsCatalogProducts,pricing,sendDM:sendDiscordDM,backupDir:process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(databasePath)),"backups")});
  const buyerProfiles=createBuyerProfiles({db,resolveUser:id=>client.users.fetch(id)});
  configureBuyerProfiles(buyerProfiles);
  commerce.setCoupons(toolkit.coupons);
  const handleTools=createShopToolsHandler({discord:require("discord.js"),tools:toolkit,staff,commerce});
  const handleEfficiency=createEfficiencyHandler({discord:require("discord.js"),model:efficiency,commerce,payments,features:storeFeatures,staff,smscode,operations});
  const handleAdmin=createAdminHandler({discord:require("discord.js"),db,smscode,pricing,resolveUser:id=>client.users.fetch(id),audit:toolkit.audit});
  const handleManualProducts=createManualProductsHandler({discord:require("discord.js"),model:manualProducts,staff,sendDM:async(id,payload)=>{const user=await client.users.fetch(id);await user.send(withHome(payload));}});
  const handleOrderHistory=createOrderHistoryHandler({discord:require("discord.js"),model:createOrderHistory({db}),payments});
  const handleFlow=createPurchaseFlow({discord:require("discord.js"),smscode,smsCatalogProducts,pricing,resolveFavorite:(user,id)=>efficiency.favorite(user,id)});
  const handleProviderFlow=createPurchaseFlow({discord:require("discord.js"),smscode,smsCatalogProducts,pricing,adminView:true});
  const handlePayment=createPaymentHandler({discord:require("discord.js"),payments,manualInstructions:()=>operations.settings().manual,adminIds:i=>staff.contactIds(i.guildId)});
  const handleStaff=createStaffHandler({discord:require("discord.js"),staff,resolveUser:id=>client.users.fetch(id)});
  const handleOperations=createOperationsHandler({discord:require("discord.js"),ops:operations});
  const handleServerAccess=createServerAccessHandler({discord:require("discord.js"),access:serverAccess,resolveChannel:id=>client.channels.fetch(id),resolveRole:async(guildId,roleId)=>(await client.guilds.fetch(guildId)).roles.fetch(roleId)});
  const handleDirect=createDirectHandler({discord:require("discord.js"),direct,payments});
  const handleStoreFeatures=createStoreFeatureHandler({discord:require("discord.js"),features:storeFeatures,staff});
  direct.setNotifier(async row=>{const user=await client.users.fetch(row.discord_id);await user.send(withHome(handleDirect.status(row)));});
  client.on("interactionCreate", async i=>{
    try {
      const id=i.user.id;
      if(await serverAccess.gate(i))return;
      rememberBuyer(i.user);
      addHomeNavigation(i);
      if(i.isButton() && (i.customId===HOME_ID || i.customId==='manual_back')){
        return i.reply({ephemeral:true,embeds:[shopEmbed()],components:mainRow()});
      }
      if(await handleStoreFeatures(i))return;
      if(storeFeatures.maintenance() && /^(shop_products|flow_|pick_product:|buy_again:|confirm_buy:|qris_buy:|direct_email:|favorite_open:|tool_coupon)/.test(String(i.customId || ''))){
        return i.reply({ephemeral:true,content:'🔧 Toko sedang maintenance. Pembelian baru dihentikan sementara. Pesanan, OTP, dan tagihan sebelumnya tetap tersedia.'});
      }
      if(await handleTools(i))return;
      if(await handleOrderHistory(i))return;
      if(await handleEfficiency(i))return;
      if(await handleStaff(i))return;
      if(await handleServerAccess(i))return;
      if(await handleOperations(i)) return;
      if(await handleManualProducts(i)) return;
      if(await handleAdmin(i)) return;
      if(await handleProviderFlow(i)) return;
      if(await handlePayment(i)) return;
      if(await handleDirect(i)) return;
      if(await handleFlow(i)) return;

      if(i.isChatInputCommand() && i.commandName==="shop"){
        return i.reply({embeds:[shopEmbed()],components:mainRow()});
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
                "5. OTP dikirim melalui DM saat masuk; **Cek OTP** tetap tersedia\n\n" +
                "Jika order gagal, hubungi admin toko."
              )],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop_refund_guide').setLabel('Panduan Refund').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('tool_ticket_new').setLabel('Buat Tiket Bantuan').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('tool_tickets:0').setLabel('Tiket Saya').setStyle(ButtonStyle.Primary))]
          });
        }

        if(i.customId==="shop_order_history"){
          const rows=db.prepare(`SELECT o.id,o.product_name,o.provider_order_id,o.phone,o.status,o.amount,o.created_at,
            p.name FROM orders o LEFT JOIN products p ON p.id=o.product_id
            WHERE o.discord_id=? ORDER BY o.id DESC LIMIT 10`).all(id);
          if(!rows.length) return i.reply({ephemeral:true,content:"Anda belum memiliki pesanan."});
          const desc=rows.map(o=>`**#${o.provider_order_id}** • ${o.product_name||o.name||"OTP"}\n📱 ${o.phone||"-"} • ${o.status} • ${money(o.amount)}`).join("\n\n");
          const repeatRows=[];for(let n=0;n<rows.length;n+=5)repeatRows.push(new ActionRowBuilder().addComponents(...rows.slice(n,n+5).map(o=>new ButtonBuilder().setCustomId('buy_again:'+o.id).setLabel(('Beli Lagi • '+o.provider_order_id).slice(0,80)).setStyle(ButtonStyle.Secondary))));
          return i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle("📦 Pesanan Saya").setDescription(desc)],components:repeatRows});
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
                .setDescription("OTP akan dikirim melalui DM saat masuk. Tombol **Cek OTP** tetap tersedia jika DM tidak diterima.")],
              components:[buttons]
            });
          }catch(e){
            const owner=/saldo tidak cukup/i.test(e.message)?staff.contactIds(i.guildId)[0]:null;
            if(owner)return i.editReply({content:'❌ '+e.message+' Tekan Hubungi Admin untuk isi saldo melalui DM.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Hubungi Admin').setStyle(ButtonStyle.Link).setURL('https://discord.com/users/'+owner))]});
            return i.editReply("❌ Gagal membuat order: "+e.message);
          }
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

      if((i.isButton() && (i.customId.startsWith("pick_product:") || i.customId.startsWith('buy_again:'))) || (i.isStringSelectMenu() && i.customId==="buy_product")){
        await i.deferReply({ephemeral:true});
        const repeat=i.customId?.startsWith('buy_again:')?storeFeatures.repeat(i.customId.split(':')[1],id):null;
        const pid=Number(repeat?repeat.productId:i.isButton()?i.customId.split(":")[1]:i.values[0]);
        const parts=repeat?(repeat.platformId && repeat.countryId?['pick_product',String(pid),String(repeat.platformId),String(repeat.countryId),repeat.operatorId==null?'any':String(repeat.operatorId)]:[]):i.isButton()?i.customId.split(':'):[];
        const filters=parts.length>=4?{platform_id:parts[2],country_id:parts[3]}:{};
        if(parts[4] && parts[4]!=='any')filters.operator_id=parts[4];
        const data=await smsCatalogProducts(filters);
        const p=(data.data||[]).find(x=>Number(x.id)===pid && (parts.length<4 || ((x.operator_id==null?'any':String(x.operator_id))===(parts[4] || 'any') && String(x.platform_id)===parts[2] && String(x.country_id)===parts[3])));
        if(!p || !productAvailable(p)) return i.editReply({content:"Produk sedang tidak tersedia. Pilih layanan lain dari katalog."});
        const quote=commerce.quote(id,p);
        const price=quote.amount;
        const balance=await getBalance(id);
        const confirm=new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_buy:${quote.token}`).setLabel("Bayar Pakai Saldo").setEmoji("💰").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`qris_buy:${quote.token}`).setLabel("Bayar Langsung QRIS").setEmoji("💳").setStyle(ButtonStyle.Primary).setDisabled(price<1000),
          new ButtonBuilder().setCustomId("shop_products").setLabel("Kembali").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('shop_refund_guide').setLabel('Panduan Refund').setStyle(ButtonStyle.Secondary)
        );
        return i.editReply({
          embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle("🧾 Konfirmasi Pembelian")
            .addFields(
              {name:"Produk",value:`**${p.name}**`,inline:false},
              {name:"Harga",value:`**${money(price)}**`,inline:true},
              {name:"Saldo",value:`**${money(balance)}**`,inline:true},
              {name:"Stok",value:`**${p.available}**`,inline:true}
            )
            .setDescription("Pastikan produk dan harga terbaru sudah benar sebelum melanjutkan.\n\nRefund harga produk masuk ke saldo bot, termasuk pembayaran QRIS. Biaya QRIS tidak ikut dikembalikan. Pesanan yang sudah menerima OTP tidak dapat dibatalkan. Tekan Panduan Refund untuk detail.")],
          components:[confirm,new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('favorite_save:'+quote.token).setLabel('Simpan Favorit').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('tool_coupon:'+quote.token).setLabel('Gunakan Voucher').setStyle(ButtonStyle.Primary))]
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
  const otpPoll=setInterval(()=>operations.pollOTP().catch(console.error),15000);otpPoll.unref();
  const lowPoll=setInterval(()=>operations.pollLow().catch(console.error),60000);lowPoll.unref();
  operations.pollOTP().catch(console.error);operations.pollLow().catch(console.error);
  const pendingPoll=setInterval(()=>toolkit.reconcile().catch(console.error),30000);pendingPoll.unref();toolkit.reconcile().catch(console.error);
  const ticketPoll=setInterval(()=>toolkit.notifyTickets().catch(console.error),30000);ticketPoll.unref();toolkit.notifyTickets().catch(console.error);
  const stockPoll=setInterval(()=>toolkit.stock().catch(console.error),60000);stockPoll.unref();toolkit.stock().catch(console.error);
  const backupPoll=setInterval(()=>toolkit.backup().catch(console.error),3600000);backupPoll.unref();toolkit.backup().catch(console.error);
  const manualPoll=setInterval(()=>storeFeatures.poll().catch(console.error),30000);manualPoll.unref();storeFeatures.poll().catch(console.error);
  const manualProductPoll=setInterval(()=>manualProducts.poll().catch(console.error),30000);manualProductPoll.unref();manualProducts.poll().catch(console.error);
}
startDiscord();

app.listen(process.env.PORT||3000,()=>console.log(`Dashboard: http://localhost:${process.env.PORT||3000}`));
