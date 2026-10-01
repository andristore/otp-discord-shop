require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const {
  Client, GatewayIntentBits, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require("discord.js");

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

app.use(express.json());
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
  const r = await fetch(base + path, {...options, headers});
  const body = await r.text();
  let data; try { data = JSON.parse(body); } catch { data = {success:false,error:{message:body}}; }
  if(!r.ok || data.success === false) {
    throw new Error(data?.error?.message || `SMSCode HTTP ${r.status}`);
  }
  return data;
}

function uuidKey(){ return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

async function smsCatalogProducts(){
  return smscode("/catalog/products?limit=100&page=1");
}

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
    const rows=(data.data||[]).filter(p=>p.active && p.available>0);
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

app.post("/api/order", async(req,res)=>{
  const {discordId,productId}=req.body;
  if(!discordId||!productId) return res.status(400).json({error:"discordId dan productId wajib"});
  db.prepare("INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING").run(discordId);
  const user=db.prepare("SELECT * FROM users WHERE discord_id=?").get(discordId);
  try {
    const data=await smsCreateOrder(productId);
    const order=data.data?.orders?.[0];
    if(!order) throw new Error("SMSCode tidak mengembalikan order");
    const amount=order.amount?.canonical_amount ?? order.amount ?? 0;
    if(user.balance < amount) {
      await smsCancel(order.id).catch(()=>{});
      return res.status(400).json({error:"Saldo toko tidak cukup"});
    }
    db.transaction(()=>{
      db.prepare("UPDATE users SET balance=balance-? WHERE discord_id=?").run(amount,discordId);
      db.prepare("INSERT INTO orders(discord_id,product_id,provider_order_id,phone,amount) VALUES(?,?,?,?,?)")
        .run(discordId,productId,String(order.id),order.phone_number,amount);
    })();
    res.json({ok:true,orderId:order.id,phone:order.phone_number,amount,status:order.status});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.get("/api/order/:id", async(req,res)=>{
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

app.post("/api/order/:id/cancel", async(req,res)=>{
  const order=db.prepare("SELECT * FROM orders WHERE provider_order_id=?").get(req.params.id);
  if(!order) return res.status(404).json({error:"Order tidak ditemukan"});
  try {
    const result=await smsCancel(req.params.id);
    const refund=result.data?.refund_amount?.canonical_amount ?? result.data?.refund_amount ?? order.amount;
    db.prepare("UPDATE orders SET status='CANCELED' WHERE id=?").run(order.id);
    db.prepare("UPDATE users SET balance=balance+? WHERE discord_id=?").run(refund,order.discord_id);
    res.json({ok:true,status:"CANCELED",refund});
  } catch(e){res.status(502).json({error:e.message});}
});

app.post("/api/discord/balance", (req,res)=>{
  const id=String(req.body.discordId||"");
  if(!id) return res.status(400).json({error:"discordId wajib"});
  db.prepare("INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING").run(id);
  res.json(db.prepare("SELECT balance FROM users WHERE discord_id=?").get(id));
});

const client = new Client({intents:[GatewayIntentBits.Guilds]});
async function startDiscord(){
  if(!process.env.DISCORD_TOKEN) return console.log("DISCORD_TOKEN belum diisi; bot tidak dijalankan.");
  const commands=[
    new SlashCommandBuilder().setName("shop").setDescription("Buka panel toko OTP")
  ].map(x=>x.toJSON());
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  if(process.env.DISCORD_CLIENT_ID) await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),{body:commands});
  function money(n){ return `${Number(n||0).toLocaleString("id-ID")} IDR`; }

  async function getBalance(id){
    db.prepare("INSERT INTO users(discord_id,balance) VALUES(?,0) ON CONFLICT(discord_id) DO NOTHING").run(id);
    return db.prepare("SELECT balance FROM users WHERE discord_id=?").get(id).balance;
  }

  function shopEmbed(balance, title="OTP Virtual Store"){
    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🛍️ ${title}`)
      .setDescription(
        "Selamat datang di toko OTP virtual.\\n\\n" +
        "Pilih menu di bawah untuk mulai bertransaksi.\\n" +
        "🔒 Transaksi diproses otomatis melalui provider."
      )
      .addFields({name:"💰 Saldo Anda",value:`**${money(balance)}**`,inline:true})
      .setFooter({text:"OTP Virtual Store • Automated Service"});
  }

  function mainRow(){
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("shop_products").setLabel("Beli OTP").setEmoji("🛒").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("shop_balance").setLabel("Saldo").setEmoji("💰").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("shop_orders").setLabel("Pesanan").setEmoji("📦").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("shop_help").setLabel("Bantuan").setEmoji("❓").setStyle(ButtonStyle.Secondary)
    );
  }

  async function productMenu(){
    const data=await smsCatalogProducts();
    const products=(data.data||[]).filter(p=>p.active && p.available>0).slice(0,25);
    const menu=new StringSelectMenuBuilder()
      .setCustomId("buy_product")
      .setPlaceholder("Pilih layanan OTP...");
    for(const p of products){
      const price=p.price?.canonical_amount ?? p.price ?? 0;
      menu.addOptions(new StringSelectMenuOptionBuilder()
        .setLabel(`${String(p.name).slice(0,80)}`)
        .setDescription(`${money(price)} • Stok ${p.available}`)
        .setValue(String(p.id)));
    }
    return {products, row:new ActionRowBuilder().addComponents(menu)};
  }

  client.on("interactionCreate", async i=>{
    try {
      const id=i.user.id;

      if(i.isChatInputCommand() && i.commandName==="shop"){
        const balance=await getBalance(id);
        return i.reply({embeds:[shopEmbed(balance)],components:[mainRow()]});
      }

      if(i.isButton()){
        if(i.customId==="shop_balance"){
          const balance=await getBalance(id);
          return i.reply({
            ephemeral:true,
            embeds:[new EmbedBuilder().setColor(0x57F287).setTitle("💰 Saldo Anda").setDescription(`Saldo saat ini:\\n\\n# **${money(balance)}**`)]
          });
        }

        if(i.customId==="shop_help"){
          return i.reply({
            ephemeral:true,
            embeds:[new EmbedBuilder().setColor(0xFEE75C).setTitle("❓ Bantuan")
              .setDescription(
                "**Cara membeli OTP**\\n" +
                "1. Klik **Beli OTP**\\n" +
                "2. Pilih layanan\\n" +
                "3. Konfirmasi pembelian\\n" +
                "4. Nomor akan diberikan\\n" +
                "5. Klik **Cek OTP** untuk mengambil kode\\n\\n" +
                "Jika order gagal, hubungi admin toko."
              )]
          });
        }

        if(i.customId==="shop_products"){
          await i.deferReply({ephemeral:true});
          try{
            const {products,row}=await productMenu();
            if(!products.length) return i.editReply({content:"Stok OTP sedang kosong.",components:[]});
            return i.editReply({
              embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle("🛒 Pilih Produk")
                .setDescription("Pilih layanan OTP dari dropdown berikut.")],
              components:[row]
            });
          }catch(e){return i.editReply({content:"Gagal mengambil katalog: "+e.message,components:[]});}
        }

        if(i.customId==="shop_orders"){
          const rows=db.prepare(`SELECT o.provider_order_id,o.phone,o.status,o.amount,o.created_at,
            p.name FROM orders o LEFT JOIN products p ON p.id=o.product_id
            WHERE o.discord_id=? ORDER BY o.id DESC LIMIT 10`).all(id);
          if(!rows.length) return i.reply({ephemeral:true,content:"Anda belum memiliki pesanan."});
          const desc=rows.map(o=>`**#${o.provider_order_id}** • ${o.name||"OTP"}\\n📱 ${o.phone||"-"} • ${o.status} • ${money(o.amount)}`).join("\\n\\n");
          return i.reply({ephemeral:true,embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle("📦 Pesanan Saya").setDescription(desc)]});
        }

        if(i.customId.startsWith("confirm_buy:")){
          const pid=Number(i.customId.split(":")[1]);
          await i.deferReply({ephemeral:true});
          try{
            const data=await smsCreateOrder(pid);
            const order=data.data?.orders?.[0];
            if(!order) throw new Error("Provider tidak mengembalikan order.");
            const amount=order.amount?.canonical_amount ?? order.amount ?? 0;
            const balance=await getBalance(id);
            if(balance<amount){
              await smsCancel(order.id).catch(()=>{});
              return i.editReply(`❌ Saldo tidak cukup. Harga **${money(amount)}**, saldo Anda **${money(balance)}**.`);
            }
            db.transaction(()=>{
              db.prepare("UPDATE users SET balance=balance-? WHERE discord_id=?").run(amount,id);
              db.prepare("INSERT INTO orders(discord_id,product_id,provider_order_id,phone,amount) VALUES(?,?,?,?,?)")
                .run(id,pid,String(order.id),order.phone_number,amount);
            })();
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
              .setDescription(`Status: **${d.status}**\\nNomor: **${d.phone_number||order.phone}**\\n\\nTekan **Cek OTP** lagi beberapa saat kemudian.`)]});
          }catch(e){return i.editReply("❌ Gagal mengecek OTP: "+e.message);}
        }

        if(i.customId.startsWith("cancel_order:")){
          const poid=i.customId.split(":")[1];
          const order=db.prepare("SELECT * FROM orders WHERE provider_order_id=? AND discord_id=?").get(poid,id);
          if(!order) return i.reply({ephemeral:true,content:"Order tidak ditemukan."});
          await i.deferReply({ephemeral:true});
          try{
            const result=await smsCancel(poid);
            const refund=result.data?.refund_amount?.canonical_amount ?? result.data?.refund_amount ?? order.amount;
            db.transaction(()=>{
              db.prepare("UPDATE orders SET status='CANCELED' WHERE id=?").run(order.id);
              db.prepare("UPDATE users SET balance=balance+? WHERE discord_id=?").run(refund,id);
            })();
            return i.editReply(`✅ Order dibatalkan. **${money(refund)}** dikembalikan ke saldo.`);
          }catch(e){return i.editReply("❌ Tidak dapat membatalkan order: "+e.message);}
        }
      }

      if(i.isStringSelectMenu() && i.customId==="buy_product"){
        const pid=Number(i.values[0]);
        const data=await smsCatalogProducts();
        const p=(data.data||[]).find(x=>Number(x.id)===pid);
        if(!p) return i.reply({ephemeral:true,content:"Produk sudah tidak tersedia."});
        const price=p.price?.canonical_amount ?? p.price ?? 0;
        const balance=await getBalance(id);
        const confirm=new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`confirm_buy:${pid}`).setLabel("Konfirmasi Beli").setEmoji("✅").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("shop_products").setLabel("Kembali").setEmoji("↩️").setStyle(ButtonStyle.Secondary)
        );
        return i.reply({
          ephemeral:true,
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
