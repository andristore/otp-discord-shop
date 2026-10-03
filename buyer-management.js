const {buyerLabel}=require('./buyer-profiles');
const MONTH=30*24*60*60*1000;
function createBuyerManagement({db,staff,now=Date.now}){
 db.exec(`CREATE TABLE IF NOT EXISTS buyer_account_status(discord_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'active',last_active INTEGER NOT NULL,changed_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS buyer_inactive ON buyer_account_status(state,last_active);
 CREATE TABLE IF NOT EXISTS buyer_account_audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,discord_id TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 function seed(){db.prepare("INSERT OR IGNORE INTO buyer_account_status(discord_id,last_active,changed_at) SELECT discord_id,?,? FROM users").run(now(),now());}
 seed();
 const admin=user=>{if(!staff.isAdmin(user))throw Error('Akses admin sudah dicabut.');};
 function audit(actor,target,action){db.prepare('INSERT INTO buyer_account_audit(actor,discord_id,action,created_at) VALUES(?,?,?,?)').run(actor,target,action,now());}
 function touch(user){if(!/^\d{17,20}$/.test(String(user)))return;
  db.transaction(()=>{const old=db.prepare('SELECT state FROM buyer_account_status WHERE discord_id=?').get(user);
   db.prepare("INSERT INTO buyer_account_status(discord_id,state,last_active,changed_at) VALUES(?,'active',?,?) ON CONFLICT(discord_id) DO UPDATE SET state='active',last_active=excluded.last_active,changed_at=CASE WHEN buyer_account_status.state<>'active' THEN excluded.changed_at ELSE buyer_account_status.changed_at END").run(user,now(),now());
   if(old&&old.state!=='active')audit(user,user,'Aktif kembali melalui interaksi bot');
  })();
 }
 function busy(user){
  if(db.prepare("SELECT 1 FROM orders WHERE discord_id=? AND refunded=0 AND (UPPER(COALESCE(status,'')) NOT IN ('COMPLETED','CANCELED','CANCELLED','EXPIRED','FAILED','REFUNDED') OR (COALESCE(otp,'')<>'' AND COALESCE(otp_notified,'')<>otp)) LIMIT 1").get(user))return true;
  if(db.prepare("SELECT 1 FROM topups WHERE discord_id=? AND (status IN ('creating','pending') OR (status='settlement' AND credited=0)) LIMIT 1").get(user))return true;
  if(db.prepare("SELECT 1 FROM manual_product_orders WHERE discord_id=? AND (state IN ('pending','awaiting_payment') OR (state='completed' AND notified=0)) LIMIT 1").get(user))return true;
  if(db.prepare("SELECT 1 FROM manual_topup_requests WHERE discord_id=? AND status='pending' LIMIT 1").get(user))return true;
  if(db.prepare("SELECT 1 FROM direct_purchases d WHERE d.discord_id=? AND (d.state IN ('processing','review','resolving') OR (d.state='pending' AND NOT EXISTS(SELECT 1 FROM topups t WHERE t.order_id=d.invoice_id AND t.credited=0 AND t.status IN ('expire','deny','cancel','failure')))) LIMIT 1").get(user))return true;
  return false;
 }
 function detail(user,target){admin(user);const r=db.prepare("SELECT u.*,COALESCE(s.state,'active') state,s.last_active FROM users u LEFT JOIN buyer_account_status s ON s.discord_id=u.discord_id WHERE u.discord_id=?").get(target);if(!r)throw Error('Pembeli tidak ditemukan.');return {...r,busy:busy(target)};}
 const change=db.transaction((user,target,action)=>{
  admin(user);if(!['archived','deleted','active'].includes(action))throw Error('Aksi tidak dikenal.');
  if(action==='deleted'&&!staff.isOwner(user))throw Error('Hanya owner boleh menghapus pembeli dari daftar.');
  const r=detail(user,target);
  if(action==='deleted'){
   if(staff.isOwner(target))throw Error('Akun owner tidak dapat dihapus atau diarsipkan.');
   if(r.balance!==0)throw Error('Saldo harus 0 IDR. Saldo pembeli tidak boleh dihapus.');
   if(r.busy)throw Error('Masih ada pesanan, pembayaran, pengajuan, atau pengiriman yang belum selesai.');
  }
  seed();if(r.state===action)return r;
  db.prepare('UPDATE buyer_account_status SET state=?,changed_at=? WHERE discord_id=?').run(action,now(),target);
  audit(user,target,action==='active'?'Pulihkan pembeli':action==='deleted'?'Hapus pembeli dari daftar':'Arsipkan pembeli');return detail(user,target);
 });
 function list(user,page=0,filter='active'){
  admin(user);if(!['active','archived','deleted'].includes(filter))throw Error('Filter tidak dikenal.');
  const query="SELECT u.*,COALESCE(s.state,'active') state,s.last_active FROM users u LEFT JOIN buyer_account_status s ON s.discord_id=u.discord_id WHERE COALESCE(s.state,'active')=?";
  const count=db.prepare('SELECT COUNT(*) n FROM ('+query+')').get(filter).n,pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);
  return {count,pages,page,filter,rows:db.prepare(query+' ORDER BY u.balance DESC,u.discord_id LIMIT 5 OFFSET ?').all(filter,page*5)};
 }
 const sweep=db.transaction(()=>{
  seed();const rows=db.prepare("SELECT s.discord_id FROM buyer_account_status s JOIN users u ON u.discord_id=s.discord_id WHERE s.state='active' AND s.last_active<=? ORDER BY s.last_active LIMIT 100").all(now()-MONTH);let count=0;
  for(const r of rows){
   db.prepare("UPDATE buyer_account_status SET state='archived',changed_at=? WHERE discord_id=? AND state='active'").run(now(),r.discord_id);audit('SYSTEM',r.discord_id,'Arsip otomatis setelah 30 hari tidak aktif');count++;
  }return count;
 });
 return {touch,detail,list,change,sweep};
}
function createBuyerManagementHandler({discord,model,staff}){
 const {ActionRowBuilder,ButtonBuilder}=discord;
 const button=(id,label,style=1)=>new ButtonBuilder().setCustomId(id).setLabel(label.slice(0,80)).setStyle(style);
 const row=(...items)=>new ActionRowBuilder().addComponents(...items);
 const back=()=>row(button('admin_buyers_list:active:0','Kelola Pembeli'),button('admin_home','Menu Awal Admin'));
 const money=n=>Number(n||0).toLocaleString('id-ID')+' IDR';
 return async i=>{
  const id=String(i.customId||'');if(!id.startsWith('admin_buyers_'))return false;
  if(!staff.isAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak.'});return true;}
  await i.deferReply({ephemeral:true});
  try{
   const [key,arg,extra]=id.split(':'),user=i.user.id;
   if(key==='admin_buyers_list'){
    const r=model.list(user,Number(extra||0),arg||'active'),components=[];
    if(r.rows.length)components.push(row(...r.rows.map(b=>button('admin_buyers_detail:'+b.discord_id,buyerLabel(b.discord_id,false)+' • '+money(b.balance),2))));
    components.push(row(...['active','archived','deleted'].map(k=>button('admin_buyers_list:'+k+':0:filter',{active:'Aktif',archived:'Arsip',deleted:'Dihapus'}[k]).setDisabled(k===r.filter))));
    components.push(row(button(`admin_buyers_list:${r.filter}:${r.page-1}`,'Sebelumnya').setDisabled(!r.page),button(`admin_buyers_list:${r.filter}:${r.page+1}`,'Berikutnya').setDisabled(r.page===r.pages-1),button('admin_balance_menu','Kembali'),button('admin_home','Menu Awal Admin')));
    await i.editReply({content:`**Kelola Pembeli • ${{active:'Aktif',archived:'Arsip',deleted:'Dihapus'}[r.filter]}**\nHalaman ${r.page+1}/${r.pages} • ${r.count} akun\nArsip otomatis: semua akun pembeli setelah 30 hari tidak memakai bot. Saldo dan transaksi tetap tersimpan; hitungan diulang saat aktif kembali.\nPenghapusan hanya menyembunyikan akun; riwayat tetap tersimpan.`,allowedMentions:{parse:[]},components});
   }else if(key==='admin_buyers_detail'){
    const b=model.detail(user,arg),buttons=[];
    if(b.state==='active')buttons.push(button('admin_buyers_confirm:'+arg+':archived','Arsipkan Pembeli'));
    else buttons.push(button('admin_buyers_apply:'+arg+':active','Pulihkan Pembeli',3));
    if(b.state!=='deleted'&&staff.isOwner(user))buttons.push(button('admin_buyers_confirm:'+arg+':deleted','Hapus Pembeli',4));
    await i.editReply({content:`**${buyerLabel(arg,false)}**\nID: ${arg}\nSaldo: **${money(b.balance)}**\nStatus: ${b.state}\nTerakhir aktif di bot: ${b.last_active?new Date(b.last_active).toISOString():'Belum tercatat'}\nProses tertunda: ${b.busy?'Ada':'Tidak ada'}\n\nMenghapus atau mengarsipkan tidak menghapus transaksi. Akun aktif kembali bila pembeli memakai bot lagi.`,allowedMentions:{parse:[]},components:[row(...buttons),back()]});
   }else if(key==='admin_buyers_confirm'){
    model.detail(user,arg);if(!['archived','deleted'].includes(extra))throw Error('Aksi tidak dikenal.');if(extra==='deleted'&&!staff.isOwner(user))throw Error('Hanya owner boleh menghapus pembeli.');
    await i.editReply({content:`${extra==='deleted'?'Hapus dari daftar':'Arsipkan'} pembeli ID ${arg}? Riwayat transaksi tetap tersimpan. ${extra==='deleted'?'Untuk hapus: saldo harus 0 dan tidak ada proses tertunda.':'Saldo dan proses transaksi tidak berubah.'}`,components:[row(button('admin_buyers_apply:'+arg+':'+extra,'Ya, Konfirmasi',extra==='deleted'?4:1),button('admin_buyers_detail:'+arg,'Batal'))],allowedMentions:{parse:[]}});
   }else if(key==='admin_buyers_apply'){
    model.change(user,arg,extra);await i.editReply({content:extra==='active'?'Pembeli dipulihkan.':'Pembeli disembunyikan dari daftar aktif. Riwayat transaksi tetap tersimpan.',components:[back()]});
   }else throw Error('Menu tidak dikenal.');
  }catch(e){await i.editReply({content:e.message,allowedMentions:{parse:[]},components:[back()]});}
  return true;
 };
}
module.exports={MONTH,createBuyerManagement,createBuyerManagementHandler};
