const ids=value=>[...new Set(String(value || '').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x)))];
function createStaff({db,env=process.env}) {
  db.exec(`CREATE TABLE IF NOT EXISTS store_staff(discord_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS store_staff_audit(id INTEGER PRIMARY KEY,discord_id TEXT NOT NULL,owner_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const owners=ids(String(env.OWNER_DISCORD_IDS || '').trim() || env.ADMIN_DISCORD_IDS);
  const isOwner=id=>owners.includes(String(id));
  db.exec('CREATE TABLE IF NOT EXISTS store_guild_contacts(guild_id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,updated_by TEXT NOT NULL)');
  function contactIds(guildId) {
    if(!guildId)return owners.slice(0,1);
    const contact=db.prepare('SELECT admin_id FROM store_guild_contacts WHERE guild_id=?').get(String(guildId));
    return contact&&isAdmin(contact.admin_id)?[contact.admin_id]:[];
  }
  function setContact(ownerId,guildId,adminId) {
    if(!isOwner(ownerId))throw Error('Hanya owner boleh mengatur kontak admin server.');
    if(!/^\d{17,20}$/.test(String(guildId)))throw Error('Buka pengaturan ini di server yang ingin diatur.');
    if(!isAdmin(adminId))throw Error('Kontak harus sudah terdaftar sebagai admin toko.');
    db.prepare('INSERT INTO store_guild_contacts VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET admin_id=excluded.admin_id,updated_by=excluded.updated_by').run(String(guildId),String(adminId),String(ownerId));
  }
  function isAdmin(id) {
    id=String(id);if(isOwner(id))return true;
    const saved=db.prepare('SELECT enabled FROM store_staff WHERE discord_id=?').get(id);
    return saved?saved.enabled===1:ids(env.ADMIN_DISCORD_IDS).includes(id);
  }
  function list() {
    const saved=db.prepare('SELECT * FROM store_staff').all();
    const active=new Set([...owners,...ids(env.ADMIN_DISCORD_IDS)]);
    for(const s of saved){if(s.enabled)active.add(s.discord_id);else if(!isOwner(s.discord_id))active.delete(s.discord_id);}
    return [...active].sort().map(id=>({id,owner:isOwner(id)}));
  }
  function change(ownerId,id,enabled) {
    if(!isOwner(ownerId))throw new Error('Hanya owner toko yang boleh memilih admin.');
    if(!/^\d{17,20}$/.test(id))throw new Error('ID Discord pengguna tidak valid.');
    if(isOwner(id))throw new Error('Akun owner tetap memiliki akses. Ubah daftar owner melalui Variables Railway.');
    if(![0,1].includes(enabled))throw new Error('Status admin tidak valid.');
    db.transaction(()=>{
      db.prepare('INSERT INTO store_staff(discord_id,enabled,updated_by) VALUES(?,?,?) ON CONFLICT(discord_id) DO UPDATE SET enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP').run(id,enabled,ownerId);
      db.prepare('INSERT INTO store_staff_audit(discord_id,owner_id,action) VALUES(?,?,?)').run(id,ownerId,enabled?'grant':'revoke');
    })();
  }
  return {isOwner,isAdmin,list,ids:()=>list().map(s=>s.id),change,contactIds,setContact};
}
function createStaffHandler({discord,staff,resolveUser}) {
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const row=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)));
  return async i=>{
    const id=String(i.customId || '');if(!id.startsWith('admin_staff_'))return false;
    if(!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
    if(id==='admin_staff_access') {
      const r=row([['admin_ops_guilds','Izin Server'],['admin_staff_list:0','Admin Toko'],['admin_staff_contact','Kontak Admin Server'],['admin_transactions_menu','Kembali']]);r.components[1].setDisabled(!staff.isOwner(i.user.id));r.components[2].setDisabled(!staff.isOwner(i.user.id));
      await i.reply({ephemeral:true,content:'**Izin & Admin**\nKelola izin server. Pengaturan admin toko hanya tersedia untuk owner.',components:[r]});return true;
    }
    if(!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Hanya owner toko yang boleh mengelola admin.'});return true;}
    if(id==='admin_staff_contact') {
      if(!i.guildId){await i.reply({ephemeral:true,content:'Buka /admin di server yang ingin diatur kontaknya.'});return true;}
      await i.showModal(new ModalBuilder().setCustomId('admin_staff_contact_save').setTitle('Kontak Admin Server Ini').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id').setLabel('ID Discord admin untuk server ini').setRequired(true).setMaxLength(20).setStyle(TextInputStyle.Short))));return true;
    }
    if(id==='admin_staff_add') {
      await i.showModal(new ModalBuilder().setCustomId('admin_staff_save').setTitle('Tambah Admin Toko')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id').setLabel('ID Discord pengguna calon admin').setRequired(true).setMaxLength(20).setStyle(TextInputStyle.Short))));return true;
    }
    await i.deferReply({ephemeral:true});
    try {
      if(id==='admin_staff_contact_save') {
        const target=i.fields.getTextInputValue('id').trim(),user=await resolveUser(target);
        if(!user||user.bot)throw Error('Pilih akun admin pengguna, bukan bot.');
        staff.setContact(i.user.id,i.guildId,target);
        await i.editReply({content:`✅ Kontak admin server ini: <@${target}>. Server lain tetap memakai kontak masing-masing.`,allowedMentions:{parse:[]},components:[row([['admin_staff_access','Kembali']])]});
      }else if(id==='admin_staff_save') {
        const target=i.fields.getTextInputValue('id').trim();if(!/^\d{17,20}$/.test(target))throw new Error('ID pengguna tidak valid.');
        const user=await resolveUser(target);if(!user || user.bot)throw new Error('Gunakan ID akun pengguna, bukan bot.');
        staff.change(i.user.id,target,1);await i.editReply({content:`✅ Pengguna ${target} ditambahkan sebagai admin toko.`,components:[row([['admin_staff_list:0','Daftar Admin']])]});
      } else if(id.startsWith('admin_staff_detail:') || id.startsWith('admin_staff_revoke:')) {
        const target=id.split(':')[1];
        if(id.startsWith('admin_staff_revoke:')){staff.change(i.user.id,target,0);await i.editReply({content:`✅ Akses admin ${target} dicabut.`,components:[row([['admin_staff_list:0','Daftar Admin']])]});}
        else {
          const actions=staff.isOwner(target)?[]:[['admin_staff_revoke:'+target,'Cabut Akses Admin']];actions.push(['admin_staff_list:0','Kembali']);
          await i.editReply({content:`ID: ${target}\nPeran: ${staff.isOwner(target)?'Owner':'Admin'}\nAdmin dapat mengelola saldo, harga, transaksi dan izin server toko. Pencabutan akses berlaku segera.`,components:[row(actions)]});
        }
      } else if(id.startsWith('admin_staff_list:')) {
        const all=staff.list(),pages=Math.max(1,Math.ceil(all.length/5)),requested=Number(id.split(':')[1]);
        const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1),components=[];
        if(all.length)components.push(row(all.slice(page*5,page*5+5).map(s=>['admin_staff_detail:'+s.id,`${s.owner?'Owner':'Admin'} • ${s.id}`])));
        const nav=row([[`admin_staff_list:${page-1}`,'Sebelumnya'],[`admin_staff_list:${page+1}`,'Berikutnya'],['admin_staff_add','Tambah Admin'],['admin_staff_access','Kembali']]);nav.components[0].setDisabled(page===0);nav.components[1].setDisabled(page===pages-1);components.push(nav);
        await i.editReply({content:`**Admin Toko**\nHalaman ${page+1}/${pages} • ${all.length} akun\nPilih akun untuk memeriksa atau mencabut akses.`,components});
      }else throw new Error('Menu admin toko tidak dikenali.');
    }catch(e){await i.editReply({content:e.message,components:[]});}return true;
  };
}
module.exports={createStaff,createStaffHandler};
