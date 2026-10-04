'use strict';
const DAY=86400000;
function parseWIB(value){
  const s=String(value||'').trim();
  if(!s)return null;
  const m=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if(!m)throw Error('Gunakan YYYY-MM-DD HH:mm dalam WIB, contoh 2026-10-20 23:59.');
  const [y,mo,d,h,mi]=m.slice(1).map(Number),t=Date.UTC(y,mo-1,d,h,mi),v=new Date(t);
  if(y<2020||y>2100||v.getUTCFullYear()!==y||v.getUTCMonth()!==mo-1||v.getUTCDate()!==d||v.getUTCHours()!==h||v.getUTCMinutes()!==mi)throw Error('Tanggal atau jam tidak valid.');
  return t-7*3600000;
}
function dateWIB(ms){return new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',dateStyle:'long',timeStyle:'short'}).format(ms)+' WIB';}
function lifetimeText(s){
  if(s.expires===null)return '\n\n**🚂 Masa Aktif Railway**\nBelum diatur oleh owner.';
  const minutes=Math.max(0,Math.ceil(s.remaining/60000)),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
  return '\n\n**🚂 Masa Aktif Railway**\nBerakhir: '+dateWIB(s.expires)+'\nSisa: '+(s.remaining<=0?'Tanggal berakhir sudah terlewati':days+' hari '+hours+' jam '+minutes%60+' menit')+'\nPengingat owner: H-3 (72 jam sebelum berakhir).\nBerdasarkan tanggal yang diatur owner; bukan pembacaan tagihan Railway.';
}
function createRailwayLifetime({db,staff,sendDM,now=Date.now}){
  db.exec(`CREATE TABLE IF NOT EXISTS railway_lifetime(id INTEGER PRIMARY KEY CHECK(id=1),expires_ms INTEGER,updated_by TEXT);
    INSERT OR IGNORE INTO railway_lifetime(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS railway_lifetime_notices(expires_ms INTEGER NOT NULL,owner_id TEXT NOT NULL,sent_ms INTEGER,next_attempt_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(expires_ms,owner_id));`);
  const settings=()=>{const expires=db.prepare('SELECT expires_ms FROM railway_lifetime WHERE id=1').get().expires_ms;return {expires,remaining:expires===null?null:expires-now()};};
  function configure(actor,value){
    if(!staff.isOwner(actor))throw Error('Akses ditolak. Pengaturan Railway khusus owner.');
    const expires=parseWIB(value);
    if(expires!==null&&expires<=now())throw Error('Tanggal berakhir harus lebih besar dari waktu sekarang.');
    db.prepare('UPDATE railway_lifetime SET expires_ms=?,updated_by=? WHERE id=1').run(expires,String(actor));
    return settings();
  }
  let pending=null;
  function poll(){
    if(pending)return pending;
    pending=(async()=>{
      const s=settings();if(s.expires===null||s.remaining>3*DAY)return;
      for(const {id} of staff.ownerList()){
        if(settings().expires!==s.expires)break;
        if(!staff.isOwner(id))continue;
        const n=db.prepare('SELECT * FROM railway_lifetime_notices WHERE expires_ms=? AND owner_id=?').get(s.expires,id);
        if((n?.sent_ms!==null&&n?.sent_ms!==undefined)||(n&&n.next_attempt_ms>now()))continue;
        db.prepare('INSERT INTO railway_lifetime_notices(expires_ms,owner_id,next_attempt_ms) VALUES(?,?,?) ON CONFLICT(expires_ms,owner_id) DO UPDATE SET next_attempt_ms=excluded.next_attempt_ms').run(s.expires,id,now()+3600000);
        try{
          const result=await sendDM(id,'⚠️ Pengingat masa aktif Railway H-3'+lifetimeText({...s,remaining:s.expires-now()})+'\nPeriksa dashboard Railway dan perpanjang bila diperlukan. Bot yang sudah berhenti tidak dapat mengirim pengingat.');
          if(result===false)continue;
          db.prepare('UPDATE railway_lifetime_notices SET sent_ms=? WHERE expires_ms=? AND owner_id=?').run(now(),s.expires,id);
        }catch{/* Retry after one hour without repeatedly messaging owners. */}
      }
    })().finally(()=>{pending=null;});return pending;
  }
  return {settings,configure,poll};
}
function createRailwayHandler({discord,staff,model}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const panel=()=>({content:'**Masa Aktif Railway • Owner**'+lifetimeText(model.settings())+'\nAtur tanggal sesuai dashboard Railway. Kosongkan tanggal untuk menonaktifkan. Pengingat dikirim satu kali per owner/tanggal, dengan percobaan ulang bila DM gagal. Bot harus tetap berjalan.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('admin_railway_edit').setLabel('Atur Tanggal Berakhir').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('admin_bot_ping').setLabel('Kembali ke Ping').setStyle(ButtonStyle.Secondary))]});
  return async i=>{
    const id=String(i.customId||'');if(!id.startsWith('admin_railway_'))return false;
    if(!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Pengaturan Railway khusus owner.'});return true;}
    if(id==='admin_railway_edit'){
      const field=new TextInputBuilder().setCustomId('expires').setLabel('Tanggal berakhir (WIB), kosong = nonaktif').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(16).setPlaceholder('2026-10-20 23:59');
      await i.showModal(new ModalBuilder().setCustomId('admin_railway_save').setTitle('Masa Aktif Railway').addComponents(new ActionRowBuilder().addComponents(field)));return true;
    }
    if(id!=='admin_railway_menu'&&id!=='admin_railway_save')return false;
    await i.deferReply({ephemeral:true});
    try{if(!staff.isOwner(i.user.id))throw Error('Akses owner telah dicabut.');if(id==='admin_railway_save')model.configure(i.user.id,i.fields.getTextInputValue('expires'));await i.editReply(panel());}
    catch(e){await i.editReply({content:e.message,components:[]});}
    return true;
  };
}
module.exports={createRailwayLifetime,createRailwayHandler,parseWIB,dateWIB,lifetimeText};
