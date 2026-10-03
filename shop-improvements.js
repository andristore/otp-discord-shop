// Shared presentation only: never changes financial or notifier flags.
function orderProgress(o,kind='digital',payment=null){
 const state=String(o.state||o.status||'').toLowerCase();
 if(o.refunded||state==='refunded')return {payment:'refunded',delivery:'cancelled'};
 if(['expired','expire','deny','cancel','canceled','cancelled','failure','failed'].includes(state))return {payment:'inactive',delivery:'cancelled'};
 const paid=kind==='digital'?['pending','completed'].includes(state)||Boolean(payment?.credited):Boolean(o.provider_order_id)||Boolean(payment?.credited);
 if(!paid)return {payment:'unpaid',delivery:'awaiting_payment'};
 if(kind==='digital')return {payment:'paid',delivery:state==='completed'?(o.notified?'sent':'pending_dm'):'processing'};
 const token=o.otp||(o.otp_message?'message:'+o.otp_message:null);
 return {payment:'paid',delivery:token?(o.otp_notified===token?'sent':'pending_dm'):'waiting_otp'};
}
function progressText(p,en=false){const words=en?{paid:'Payment verified',unpaid:'Awaiting payment',refunded:'Refunded to balance',inactive:'Invoice/order inactive',sent:'Delivered via DM',pending_dm:'Ready; awaiting DM delivery',processing:'Awaiting admin delivery',waiting_otp:'Waiting for OTP',awaiting_payment:'Awaiting payment',cancelled:'Cancelled'}:{paid:'Pembayaran terverifikasi',unpaid:'Menunggu pembayaran',refunded:'Dikembalikan ke saldo',inactive:'Tagihan/pesanan tidak aktif',sent:'Berhasil dikirim ke DM',pending_dm:'Hasil tersedia; menunggu pengiriman DM',processing:'Menunggu pengiriman admin',waiting_otp:'Menunggu OTP',awaiting_payment:'Menunggu pembayaran',cancelled:'Dibatalkan'};return `${en?'Payment':'Pembayaran'}: ${words[p.payment]}\n${en?'Delivery':'Pengiriman'}: ${words[p.delivery]}`;}
// Persistent panel locations and delivery diagnostics. Never store account/OTP bodies here.
function createShopImprovements({db,staff,access,resolveChannel,now=Date.now}) {
  db.exec(`CREATE TABLE IF NOT EXISTS storefront_panels(guild_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,message_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS delivery_attempts(kind TEXT NOT NULL,ref TEXT NOT NULL,discord_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 1,last_attempt INTEGER NOT NULL,last_code TEXT NOT NULL DEFAULT '',last_manual INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,ref));`);
  const sending=new Set(),publishing=new Set(),retrying=new Set();
  const admin=id=>{if(!staff.isAdmin(id))throw Error('Akses ditolak.');};
  async function send(kind,ref,recipient,fn) {
    if(!['digital','otp'].includes(kind))throw Error('Jenis pengiriman tidak valid.');
    ref=String(ref);const key=kind+':'+ref;
    if(sending.has(key))throw Error('Pengiriman sedang berjalan.');
    sending.add(key);
    try {
      db.prepare(`INSERT INTO delivery_attempts(kind,ref,discord_id,attempts,last_attempt) VALUES(?,?,?,1,?)
        ON CONFLICT(kind,ref) DO UPDATE SET attempts=attempts+1,pending=1,last_attempt=excluded.last_attempt,discord_id=excluded.discord_id`).run(kind,ref,recipient,now());
      try {await fn();db.prepare("UPDATE delivery_attempts SET pending=0,last_code='' WHERE kind=? AND ref=?").run(kind,ref);}
      catch(e){db.prepare('UPDATE delivery_attempts SET last_code=? WHERE kind=? AND ref=?').run(Number(e.code)===50007?'DM_CLOSED':'SEND_FAILED',kind,ref);throw e;}
    } finally {sending.delete(key);}
  }
  function eligible(r){
    if(r.kind==='digital'){const o=db.prepare('SELECT * FROM manual_product_orders WHERE id=? AND discord_id=?').get(r.ref,r.discord_id);return o&&!o.notified&&['completed','refunded'].includes(o.state)?o:null;}
    const o=db.prepare('SELECT * FROM orders WHERE id=? AND discord_id=?').get(r.ref,r.discord_id),token=o&&(o.otp||(o.otp_message?'message:'+o.otp_message:null));
    return o&&!o.refunded&&token&&o.otp_notified!==token?o:null;
  }
  function failed(user,page=0){admin(user);
    const query=`SELECT a.* FROM delivery_attempts a WHERE a.pending=1 AND
      ((a.kind='digital' AND EXISTS(SELECT 1 FROM manual_product_orders o WHERE o.id=a.ref AND o.discord_id=a.discord_id AND o.notified=0 AND o.state IN ('completed','refunded')))
      OR (a.kind='otp' AND EXISTS(SELECT 1 FROM orders o WHERE CAST(o.id AS TEXT)=a.ref AND o.discord_id=a.discord_id AND o.refunded=0 AND
        ((o.otp IS NOT NULL AND COALESCE(o.otp_notified,'')<>o.otp) OR (o.otp IS NULL AND o.otp_message IS NOT NULL AND COALESCE(o.otp_notified,'')<>('message:'||o.otp_message))))))`;
    const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get().n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);
    return {count,pages,page,rows:db.prepare(query+' ORDER BY last_attempt DESC,kind,ref LIMIT 5 OFFSET ?').all(page*5)};
  }
  async function retry(user,kind,ref,{products,operations}){
    admin(user);const key=kind+':'+ref,r=db.prepare('SELECT * FROM delivery_attempts WHERE kind=? AND ref=? AND pending=1').get(kind,String(ref));
    if(!r||!eligible(r))throw Error('Pengiriman sudah selesai atau tidak ditemukan.');
    if(retrying.has(key)||sending.has(key))throw Error('Pengiriman sedang berjalan.');
    if(r.last_manual&&now()-r.last_manual<30000)throw Error('Tunggu 30 detik sebelum mencoba lagi.');
    retrying.add(key);db.prepare('UPDATE delivery_attempts SET last_manual=? WHERE kind=? AND ref=?').run(now(),kind,String(ref));
    try {if(kind==='digital')await products.notify(eligible(r));else await operations.pollOTP(eligible(r).provider_order_id);
      return !eligible(r); // The authoritative notifier flag, not merely an HTTP response.
    } finally {retrying.delete(key);}
  }
  function location(user,guild){admin(user);return db.prepare('SELECT * FROM storefront_panels WHERE guild_id=?').get(guild);}
  async function publish(user,guild,channelId,payload){
    admin(user);const a=access.get(guild);
    if(!a||a.status!=='approved'||!a.present)throw Error('Server harus disetujui dan bot masih berada di server.');
    if(a.channel_id&&a.channel_id!==channelId)throw Error('Gunakan channel toko yang sudah diatur di Server & Channel.');
    if(publishing.has(guild))throw Error('Panel sedang diperbarui.');
    publishing.add(guild);
    try {const previous=location(user,guild);
      if(previous&&previous.channel_id!==channelId)throw Error('Hapus panel lama sebelum memindahkan channel.');
      const channel=await resolveChannel(channelId);
      if(!channel||channel.guildId!==guild||channel.type!==0||typeof channel.send!=='function')throw Error('Pilih channel teks pada server ini.');
      admin(user);const current=access.get(guild);if(current?.status!=='approved'||!current.present||(current.channel_id&&current.channel_id!==channelId))throw Error('Izin server/channel sudah berubah.');
      let message;
      if(previous){try{message=await channel.messages.fetch(previous.message_id);}catch(e){if(Number(e.code)!==10008)throw e;}}
      if(message)await message.edit(payload);else message=await channel.send(payload);
      db.prepare('INSERT INTO storefront_panels VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id').run(guild,channelId,message.id);
      return message.id;
    }finally{publishing.delete(guild);}
  }
  async function remove(user,guild){admin(user);if(publishing.has(guild))throw Error('Panel sedang diperbarui.');publishing.add(guild);
    try {const p=location(user,guild);if(!p)return;const c=await resolveChannel(p.channel_id);if(!c||c.guildId!==guild)throw Error('Channel tidak ditemukan.');
      try{const m=await c.messages.fetch(p.message_id);admin(user);await m.delete();}catch(e){if(Number(e.code)!==10008)throw e;}
      db.prepare('DELETE FROM storefront_panels WHERE guild_id=?').run(guild);
    }finally{publishing.delete(guild);}
  }
  return {send,failed,retry,location,publish,remove};
}
function createImprovementsHandler({discord,model,products,operations,staff}){
  const {ActionRowBuilder,ButtonBuilder,EmbedBuilder}=discord;
  const button=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style);
  const row=(...b)=>new ActionRowBuilder().addComponents(...b);
  const back=()=>row(button('admin_system_access','Kembali'),button('admin_home','Menu Awal Admin'));
  const panel=()=>({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('🛍️ Hi, Belanja Produk Digital Yukk').setDescription('Selamat datang di Produk Digital by Maboyy\nWelcome to Digital Products by Maboyy\n\nTekan Mulai Belanja, pilih bahasa, lalu pilih produk.\nPress Start Shopping, choose your language, then choose a product.').setFooter({text:'est. 2020 — Bot Otomatis 24/7'})],components:[row(button('shop_start','Mulai Belanja / Start Shopping',3))],allowedMentions:{parse:[]}});
  return async i=>{
    const id=String(i.customId||'');if(!/^admin_(?:shop_panel(?:_|$)|dm_failed:|dm_retry:)/.test(id))return false;
    if(!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    await i.deferReply({ephemeral:true});
    try {
      if(id.startsWith('admin_dm_')){
        let result='';if(id.startsWith('admin_dm_retry:')){const [,kind,...ref]=id.split(':');result=await model.retry(i.user.id,kind,ref.join(':'),{products,operations})?'✅ DM berhasil dikirim.':'❌ DM belum berhasil. Minta pembeli mengaktifkan DM dari anggota server.';}
        const r=model.failed(i.user.id,id.startsWith('admin_dm_failed:')?Number(id.split(':')[1]):0),components=[];
        if(r.rows.length)components.push(row(...r.rows.map(o=>button('admin_dm_retry:'+o.kind+':'+o.ref,'Coba Ulang • '+(o.kind==='otp'?'OTP ':'Produk ')+o.ref))));
        components.push(row(button('admin_dm_failed:'+(r.page-1),'Sebelumnya').setDisabled(!r.page),button('admin_dm_failed:'+(r.page+1),'Berikutnya').setDisabled(r.page===r.pages-1),button('admin_dm_failed:'+r.page,'Perbarui')));
        components.push(row(button('admin_payment_checks','Kembali'),button('admin_home','Menu Awal Admin')));
        await i.editReply({content:(result?result+'\n\n':'')+'**DM Gagal**\n'+(r.count?'Pengiriman otomatis tetap mencoba ulang. Tombol tidak membuat pembelian baru.':'Tidak ada DM pesanan yang tertunda.')+'\nHalaman '+(r.page+1)+'/'+r.pages+' • '+r.count+' pengiriman\n\n'+r.rows.map(o=>`${o.kind==='otp'?'OTP':'Produk'} #${o.ref}\nPembeli: ${o.discord_id}\nPercobaan: ${o.attempts} • ${o.last_code==='DM_CLOSED'?'DM pembeli tertutup':'Pengiriman gagal'}`).join('\n\n'),components,allowedMentions:{parse:[]}});
      }else{
        if(!i.guildId)throw Error('Buka pengaturan Panel Toko dari server tujuan.');
        if(id==='admin_shop_panel_publish'){const message=await model.publish(i.user.id,i.guildId,i.channelId,panel());await i.editReply({content:'✅ Panel toko tersimpan / diperbarui.\nhttps://discord.com/channels/'+i.guildId+'/'+i.channelId+'/'+message,components:[back()]});}
        else if(id==='admin_shop_panel_remove_confirm')await i.editReply({content:'Hapus pesan panel toko pada server ini?',components:[row(button('admin_shop_panel_remove','Ya, Hapus Panel',4),button('admin_shop_panel','Batal'))]});
        else {if(id==='admin_shop_panel_remove')await model.remove(i.user.id,i.guildId);const p=model.location(i.user.id,i.guildId);await i.editReply({content:'**Panel Toko Permanen**\nBuka channel toko yang diizinkan, lalu tekan Pasang / Perbarui. Satu panel per server. Pembeli bisa memilih bahasa dan berbelanja tanpa mengetik /shop.\n'+(p?'Panel: https://discord.com/channels/'+i.guildId+'/'+p.channel_id+'/'+p.message_id:'Belum ada panel.'),components:[row(button('admin_shop_panel_publish','Pasang / Perbarui Panel',3),...(p?[button('admin_shop_panel_remove_confirm','Hapus Panel',4)]:[])),back()]});}
      }
    }catch(e){await i.editReply({content:[50001,50013].includes(Number(e.code))?'Bot perlu izin Lihat Channel, Kirim Pesan, dan Sematkan Tautan di channel toko.':String(e.message||'Gagal memproses menu.').slice(0,1700),components:[back()],allowedMentions:{parse:[]}});}
    return true;
  };
}
module.exports={createShopImprovements,createImprovementsHandler,orderProgress,progressText};
