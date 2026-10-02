function createServerAccess({db,sendDM,env=process.env,staff}) {
  const isAdmin=id=>staff?staff.isAdmin(id):require('./admin').isDiscordAdmin(id,env.ADMIN_DISCORD_IDS || '');
  db.exec(`CREATE TABLE IF NOT EXISTS discord_server_access (
    guild_id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT,members INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',present INTEGER NOT NULL DEFAULT 1,notified TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );CREATE TABLE IF NOT EXISTS discord_server_access_audit (
    id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,admin_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  const get=id=>db.prepare('SELECT * FROM discord_server_access WHERE guild_id=?').get(String(id));
  const registering=new Map();
  function register(guild) {
    const key=String(guild.id);if(registering.has(key))return registering.get(key);
    const job=registerGuild(guild).finally(()=>registering.delete(key));registering.set(key,job);return job;
  }
  async function registerGuild(guild) {
    const id=String(guild.id);
    db.prepare(`INSERT INTO discord_server_access(guild_id,name,owner_id,members) VALUES(?,?,?,?)
      ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name,owner_id=excluded.owner_id,members=excluded.members,present=1,
        status=CASE WHEN discord_server_access.present=0 THEN 'pending' ELSE discord_server_access.status END,
        notified=CASE WHEN discord_server_access.present=0 THEN '' ELSE discord_server_access.notified END`).run(id,String(guild.name || id).slice(0,100),guild.ownerId || null,Number(guild.memberCount) || 0);
    const row=get(id);
    if(row.status!=='pending' || !sendDM)return row;
    const sent=new Set(row.notified.split(',').filter(Boolean));
    for(const adminId of staff?staff.ids():[...new Set((env.ADMIN_DISCORD_IDS || '').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x)))])if(!sent.has(adminId)) {
      try {
        await sendDM(adminId,`🔐 Hi, Belanja Produk Digital Yukk — permintaan izin server\nServer: ${row.name}\nID: ${id}\nPemilik: ${row.owner_id || '-'}\nLayanan terkunci sampai disetujui. Buka /admin → Transaksi → Izin Server untuk menyetujui atau menolak.`);
        sent.add(adminId);db.prepare('UPDATE discord_server_access SET notified=? WHERE guild_id=?').run([...sent].join(','),id);
      }catch{}
    }return get(id);
  }
  function decide(id,adminId,status) {
    if(!isAdmin(adminId))throw new Error('Akses ditolak. Hanya admin toko boleh mengubah izin server.');
    if(!['approved','rejected','revoked'].includes(status))throw new Error('Status izin tidak valid.');
    return db.transaction(()=>{
      const row=get(id);if(!row)throw new Error('Server tidak ditemukan.');
      if(status==='approved' && !row.present)throw new Error('Bot sudah keluar dari server tersebut.');
      if(row.status!==status){db.prepare('UPDATE discord_server_access SET status=? WHERE guild_id=?').run(status,id);db.prepare('INSERT INTO discord_server_access_audit(guild_id,admin_id,action) VALUES(?,?,?)').run(id,adminId,status);}
      return get(id);
    })();
  }
  function list(page=0) {
    const count=db.prepare('SELECT COUNT(*) n FROM discord_server_access').get().n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);
    return {page,pages,count,rows:db.prepare("SELECT * FROM discord_server_access ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at DESC,guild_id ASC LIMIT 5 OFFSET ?").all(page*5)};
  }
  async function gate(i) {
    if(!i.guildId)return false;
    const id=String(i.customId || '');
    const adminMenu=(i.isChatInputCommand() && i.commandName==='admin') || id.startsWith('admin_') || id.startsWith('provider_');
    if(adminMenu && isAdmin(i.user.id))return false;
    if(get(i.guildId)?.status==='approved')return false;
    await i.reply({ephemeral:true,content:'🔒 Server ini belum mendapat izin admin Hi, Belanja Produk Digital Yukk. Minta admin toko membuka /admin → Transaksi → Izin Server untuk verifikasi.'});return true;
  }
  const removed=id=>db.prepare("UPDATE discord_server_access SET present=0,status='revoked' WHERE guild_id=?").run(String(id));
  return {get,list,register,decide,gate,removed};
}
function createServerAccessHandler({discord,access}) {
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=discord;
  const labels={pending:'Menunggu verifikasi',approved:'Disetujui',rejected:'Ditolak',revoked:'Izin dicabut'};
  const row=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)));
  return async i=>{
    const id=String(i.customId || '');if(!id.startsWith('admin_ops_guild'))return false;
    if(!require('./admin').isDiscordAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Izin server hanya untuk admin toko.'});return true;}
    await i.deferReply({ephemeral:true});
    try {
      if(id==='admin_ops_guilds' || id.startsWith('admin_ops_guilds:')) {
        const r=access.list(Number(id.split(':')[1]) || 0),components=[];
        if(r.rows.length)components.push(row(r.rows.map(g=>['admin_ops_guild:'+g.guild_id,`${g.name} • ${labels[g.status]}`.slice(0,80)])));
        const nav=row([[`admin_ops_guilds:${r.page-1}`,'Sebelumnya'],[`admin_ops_guilds:${r.page+1}`,'Berikutnya'],['admin_transactions_menu','Kembali']]);nav.components[0].setDisabled(r.page===0);nav.components[1].setDisabled(r.page===r.pages-1);components.push(nav);
        await i.editReply({content:`**Izin Server**\nHalaman ${r.page+1}/${r.pages} • ${r.count} server\n${r.count?'Pilih server untuk memeriksa izin.':'Belum ada server terdaftar.'}`,components});
      } else {
        const [,guildId,status]=id.split(':');
        const g=status?access.decide(guildId,i.user.id,status):access.get(guildId);if(!g)throw new Error('Server tidak ditemukan.');
        const actions=[];
        if(g.present && g.status!=='approved')actions.push(['admin_ops_guild:'+guildId+':approved','Setujui Server']);
        if(g.status==='approved')actions.push(['admin_ops_guild:'+guildId+':revoked','Cabut Izin']);
        else if(g.status!=='rejected')actions.push(['admin_ops_guild:'+guildId+':rejected','Tolak Server']);
        actions.push(['admin_ops_guilds','Kembali']);
        await i.editReply({content:`**${g.name}**\nID Server: ${g.guild_id}\nPemilik: ${g.owner_id || '-'}\nAnggota: ${g.members}\nBot masih di server: ${g.present?'Ya':'Tidak'}\nStatus: **${labels[g.status]}**\n\nPersetujuan mengaktifkan layanan toko pada server ini. Pencabutan izin langsung mengunci layanan.`,allowedMentions:{parse:[]},components:[row(actions)]});
      }
    }catch(e){await i.editReply({content:e.message,components:[]});}return true;
  };
}
module.exports={createServerAccess,createServerAccessHandler};
