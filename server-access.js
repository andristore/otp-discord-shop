function createServerAccess({db,sendDM,env=process.env,staff,isMember=async()=>false}) {
  const isAdmin=id=>staff?staff.isAdmin(id):require('./admin').isDiscordAdmin(id,env.ADMIN_DISCORD_IDS || '');
  db.exec(`CREATE TABLE IF NOT EXISTS discord_server_access (
    guild_id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT,members INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',present INTEGER NOT NULL DEFAULT 1,notified TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );CREATE TABLE IF NOT EXISTS discord_server_access_audit (
    id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,admin_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  const get=id=>db.prepare('SELECT * FROM discord_server_access WHERE guild_id=?').get(String(id));
  if(!db.prepare('PRAGMA table_info(discord_server_access)').all().some(c=>c.name==='channel_id'))db.exec('ALTER TABLE discord_server_access ADD COLUMN channel_id TEXT');
  if(!db.prepare('PRAGMA table_info(discord_server_access)').all().some(c=>c.name==='role_id'))db.exec('ALTER TABLE discord_server_access ADD COLUMN role_id TEXT');
  function setRole(guildId,adminId,roleId){
    if(!isAdmin(adminId))throw Error('Akses ditolak.');
    if(roleId!==null&&(!/^\d{17,20}$/.test(String(roleId))||String(roleId)===String(guildId)))throw Error('Pilih role khusus, bukan @everyone.');
    return db.transaction(()=>{if(!get(guildId))throw Error('Server tidak ditemukan.');db.prepare('UPDATE discord_server_access SET role_id=? WHERE guild_id=?').run(roleId,String(guildId));db.prepare('INSERT INTO discord_server_access_audit(guild_id,admin_id,action) VALUES(?,?,?)').run(String(guildId),String(adminId),'role:'+(roleId||'all'));return get(guildId);})();
  }
  function setChannel(guildId,adminId,channelId){
    if(!isAdmin(adminId))throw Error('Akses ditolak.');
    if(channelId!==null&&!/^\d{17,20}$/.test(String(channelId)))throw Error('ID channel tidak valid.');
    return db.transaction(()=>{if(!get(guildId))throw Error('Server tidak ditemukan.');db.prepare('UPDATE discord_server_access SET channel_id=? WHERE guild_id=?').run(channelId,String(guildId));db.prepare('INSERT INTO discord_server_access_audit(guild_id,admin_id,action) VALUES(?,?,?)').run(String(guildId),String(adminId),'channel:'+ (channelId||'all'));return get(guildId);})();
  }
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
        await sendDM(adminId,`🔐 Hi, Belanja Produk Digital Yukk — permintaan izin server\nServer: ${row.name}\nID: ${id}\nPemilik: ${row.owner_id || '-'}\nLayanan terkunci sampai disetujui. Buka /admin → Sistem → Server & Channel untuk menyetujui atau menolak.`);
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
  async function dmLinks(userId) {
    const ownerIds=staff?.ownerList?staff.ownerList().map(p=>p.id):String(env.OWNER_DISCORD_IDS||env.ADMIN_DISCORD_IDS||'').split(',').map(id=>id.trim());
    const ownerId=ownerIds.find(id=>/^\d{17,20}$/.test(String(id)));
    const buttons=[];
    if(ownerId)buttons.push({type:2,style:5,label:'Hubungi Owner',url:'https://discord.com/users/'+ownerId});
    let serverURL;
    try {
      const url=new URL(String(env.SHOP_SERVER_INVITE_URL||'').trim());
      if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&((url.hostname==='discord.gg'&&/^\/[A-Za-z0-9-]+\/?$/.test(url.pathname))||(url.hostname==='discord.com'&&/^\/invite\/[A-Za-z0-9-]+\/?$/.test(url.pathname))))serverURL=url.href;
    }catch{}
    const servers=db.prepare("SELECT guild_id,channel_id,name FROM discord_server_access WHERE status='approved' AND present=1 ORDER BY created_at,guild_id").all();
    const joined=[];
    for(let offset=0;offset<servers.length&&joined.length<24;offset+=5){
      const batch=servers.slice(offset,offset+5);
      const matches=await Promise.all(batch.map(async server=>{if(!/^\d{17,20}$/.test(server.guild_id))return false;try{return await isMember(server.guild_id,String(userId))===true;}catch{return false;}}));
      for(let j=0;j<batch.length&&joined.length<24;j++)if(matches[j])joined.push(batch[j]);
    }
    for(const server of joined)buttons.push({type:2,style:5,label:joined.length===1?'Buka Server':('Buka '+server.name).slice(0,80),url:'https://discord.com/channels/'+server.guild_id+'/'+(/^\d{17,20}$/.test(server.channel_id||'')?server.channel_id:'@home')});
    if(!joined.length&&serverURL)buttons.push({type:2,style:5,label:'Server Owner',url:serverURL});
    return Array.from({length:Math.ceil(buttons.length/5)},(_,r)=>({type:1,components:buttons.slice(r*5,r*5+5)}));
  }
  async function gate(i) {
    if(!i.guildId){
      if(isAdmin(i.user.id))return false;
      const deferred=typeof i.deferReply==='function';if(deferred)await i.deferReply({ephemeral:true});
      const components=await dmLinks(i.user.id);
      await (deferred?i.editReply.bind(i):i.reply.bind(i))({ephemeral:true,content:'🔒 Menu bot melalui DM hanya untuk admin toko. Untuk belanja, cek saldo, isi saldo, atau melihat pesanan, buka /shop di server Discord yang sudah disetujui. Data pesanan tetap dikirim ke DM Anda.',allowedMentions:{parse:[]},components});
      return true;
    }
    if(isAdmin(i.user.id))return false;
    const server=get(i.guildId);
    if(server?.status==='approved'){
      if(server.role_id&&!isAdmin(i.user.id)){
        const roles=i.member?.roles;
        const hasRole=Array.isArray(roles)?roles.includes(server.role_id):roles?.cache?.has(server.role_id);
        if(!hasRole){await i.reply({ephemeral:true,content:`🔒 Anda memerlukan role <@&${server.role_id}> untuk menggunakan bot toko. Hubungi admin server untuk mendapatkan role.`,allowedMentions:{parse:[]}});return true;}
      }
      if(!server.channel_id||String(i.channelId)===server.channel_id)return false;
      await i.reply({ephemeral:true,content:`🔒 Gunakan menu toko di <#${server.channel_id}>. Channel ini tidak diizinkan untuk transaksi.`,allowedMentions:{parse:[]}});return true;
    }
    await i.reply({ephemeral:true,content:'🔒 Server ini belum mendapat izin admin toko. Minta admin membuka /admin → Sistem → Server & Channel untuk verifikasi.'});return true;
  }
  const removed=id=>db.prepare("UPDATE discord_server_access SET present=0,status='revoked' WHERE guild_id=?").run(String(id));
  return {get,list,register,decide,gate,removed,setChannel,setRole};
}
function createServerAccessHandler({discord,access,resolveChannel,resolveRole}) {
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const labels={pending:'Menunggu verifikasi',approved:'Disetujui',rejected:'Ditolak',revoked:'Izin dicabut'};
  const row=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)));
  return async i=>{
    const id=String(i.customId || '');if(!id.startsWith('admin_ops_guild')&&id!=='admin_ops_server_menu')return false;
    if(!require('./admin').isDiscordAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Izin server hanya untuk admin toko.'});return true;}
    if(id.startsWith('admin_ops_guild_role:')){
      const g=access.get(id.split(':')[1]);if(!g){await i.reply({ephemeral:true,content:'Server tidak ditemukan.'});return true;}
      await i.showModal(new ModalBuilder().setCustomId('admin_ops_guild_role_save:'+g.guild_id).setTitle('Role Pengguna Bot').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('role').setLabel('ID role khusus; 0 untuk semua anggota').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setValue(g.role_id||'0'))));return true;
    }
    await i.deferReply({ephemeral:true});
    try {
      if(id==='admin_ops_server_menu'){
        await i.editReply({content:'**Server & Channel**\nAtur persetujuan server dan channel transaksi pembeli. Kontak admin dapat ditetapkan owner dari server terkait.',components:[row([['admin_ops_guilds','Kelola Server & Channel'],['admin_staff_contact','Kontak Admin Server'],['admin_system_menu','Kembali']])]});
      }else if(id.startsWith('admin_ops_guild_role_save:')){
        const guildId=id.split(':')[1],raw=i.fields.getTextInputValue('role').trim();
        if(raw!=='0'){
          if(!/^\d{17,20}$/.test(raw)||raw===guildId)throw Error('Gunakan ID role khusus, bukan @everyone.');
          const role=await resolveRole?.(guildId,raw);
          if(!role||String(role.guild?.id)!==guildId||role.managed)throw Error('Pilih role anggota yang dapat diberikan manual dalam server tersebut.');
        }
        const g=access.setRole(guildId,i.user.id,raw==='0'?null:raw);
        await i.editReply({content:`✅ Role pengguna bot ${g.name}: ${g.role_id?'<@&'+g.role_id+'>':'semua anggota'}. Admin toko tetap memiliki akses tanpa role ini.`,allowedMentions:{parse:[]},components:[row([['admin_ops_guild:'+guildId,'Kembali ke Server']])]});
      }else if(id.startsWith('admin_ops_guild_channel_save:')){
        const guildId=id.split(':')[1],raw=i.fields.getTextInputValue('channel').trim();
        if(raw!=='0'){
          if(!/^\d{17,20}$/.test(raw))throw Error('Gunakan ID channel teks yang valid.');
          const channel=await resolveChannel?.(raw);
          if(!channel||String(channel.guildId)!==guildId||![0,5].includes(channel.type))throw Error('Channel harus berupa channel teks/pengumuman dalam server yang dipilih.');
        }
        const g=access.setChannel(guildId,i.user.id,raw==='0'?null:raw);
        await i.editReply({content:`✅ Channel transaksi ${g.name}: ${g.channel_id?'<#'+g.channel_id+'>':'semua channel'}.`,allowedMentions:{parse:[]},components:[row([['admin_ops_guild:'+guildId,'Kembali ke Server']])]});
      }else if(id==='admin_ops_guilds' || id.startsWith('admin_ops_guilds:')) {
        const r=access.list(Number(id.split(':')[1]) || 0),components=[];
        if(r.rows.length)components.push(row(r.rows.map(g=>['admin_ops_guild:'+g.guild_id,`${g.name} • ${labels[g.status]}`.slice(0,80)])));
        const nav=row([[`admin_ops_guilds:${r.page-1}`,'Sebelumnya'],[`admin_ops_guilds:${r.page+1}`,'Berikutnya'],['admin_ops_server_menu','Kembali']]);nav.components[0].setDisabled(r.page===0);nav.components[1].setDisabled(r.page===r.pages-1);components.push(nav);
        await i.editReply({content:`**Izin Server**\nHalaman ${r.page+1}/${r.pages} • ${r.count} server\n${r.count?'Pilih server untuk memeriksa izin.':'Belum ada server terdaftar.'}`,components});
      } else {
        const [,guildId,status]=id.split(':');
        const g=status?access.decide(guildId,i.user.id,status):access.get(guildId);if(!g)throw new Error('Server tidak ditemukan.');
        const actions=[];
        if(g.present && g.status!=='approved')actions.push(['admin_ops_guild:'+guildId+':approved','Setujui Server']);
        if(g.status==='approved')actions.push(['admin_ops_guild:'+guildId+':revoked','Cabut Izin']);
        else if(g.status!=='rejected')actions.push(['admin_ops_guild:'+guildId+':rejected','Tolak Server']);
        actions.push(['admin_ops_guild_channel:'+guildId,'Atur Channel'],['admin_ops_guild_role:'+guildId,'Atur Role Bot'],['admin_ops_guilds','Kembali']);
        await i.editReply({content:`**${g.name}**\nID Server: ${g.guild_id}\nPemilik: ${g.owner_id || '-'}\nAnggota: ${g.members}\nBot masih di server: ${g.present?'Ya':'Tidak'}\nStatus: **${labels[g.status]}**\nChannel transaksi: ${g.channel_id?'<#'+g.channel_id+'>':'Semua channel'}\nRole pengguna bot: ${g.role_id?'<@&'+g.role_id+'>':'Semua anggota'}\n\nPersetujuan mengaktifkan layanan toko pada server ini. Pencabutan izin langsung mengunci layanan.`,allowedMentions:{parse:[]},components:[row(actions)]});
      }
    }catch(e){await i.editReply({content:e.message,components:[]});}return true;
  };
}
module.exports={createServerAccess,createServerAccessHandler};
