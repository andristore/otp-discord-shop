// Discord IDs remain the only account key. Names are display metadata.
let active;
const escapeName=value=>String(value || '').replace(/[\r\n\u0000-\u001f\u007f]/g,'').slice(0,32).replace(/[\\`*_~|<>\[\]()]/g,'\\$&');
function createBuyerProfiles({db,resolveUser}){
 db.exec('CREATE TABLE IF NOT EXISTS buyer_profiles(discord_id TEXT PRIMARY KEY,username TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 function remember(user){if(!user || !/^\d{17,20}$/.test(String(user.id)) || typeof user.username!=='string' || !user.username.trim())return;db.prepare('INSERT INTO buyer_profiles(discord_id,username) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username,updated_at=CURRENT_TIMESTAMP').run(String(user.id),user.username.slice(0,32));}
 const label=(id,includeId=true)=>{const name=db.prepare('SELECT username FROM buyer_profiles WHERE discord_id=?').get(String(id))?.username;return includeId?(name?'@'+escapeName(name)+' (ID: '+id+')':String(id)+' (username belum tersedia)'):(name?'@'+escapeName(name):'Username belum tersedia');};
 async function hydrate(ids){if(!resolveUser)return;await Promise.allSettled([...new Set(ids.map(String))].slice(0,10).map(async id=>{if(!/^\d{17,20}$/.test(id) || db.prepare('SELECT 1 FROM buyer_profiles WHERE discord_id=?').get(id))return;let timer;try{const user=await Promise.race([resolveUser(id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),3000);})]);if(String(user?.id)===id)remember(user);}catch{}finally{clearTimeout(timer);}}));}
 return {remember,label,hydrate};
}
function configureBuyerProfiles(profiles){active=profiles;}
const buyerLabel=(id,includeId=true)=>active?active.label(id,includeId):(includeId?String(id):'Username belum tersedia');
const rememberBuyer=user=>active?.remember(user);
const hydrateBuyers=ids=>active?.hydrate(ids) || Promise.resolve();
function withBuyer(payload,interaction){
 if(!/^(confirm_buy:|cancel_order:|check_otp:|direct_email:|direct_check:|direct_history$|topup_amount$|topup_check:|topup_history$|active_invoice$|manual_request_submit$|manual_request_detail:|shop_balance$|shop_order_history$)/.test(String(interaction.customId || '')))return payload;
 const result=typeof payload==='string'?{content:payload}:{...payload};
 const name=escapeName(interaction.user?.username),id=String(interaction.user?.id || '');
 if(!/^\d{17,20}$/.test(id))return payload;
 if(String(result.content || '').startsWith('Pembeli: '))return {...result,allowedMentions:{parse:[]}};
 const heading='Pembeli: '+(name?'@'+name+' • ':'')+'ID: '+id+'\n\n';
 return {...result,content:heading+String(result.content || '').slice(0,2000-heading.length),allowedMentions:{parse:[]}};
}
module.exports={createBuyerProfiles,configureBuyerProfiles,buyerLabel,rememberBuyer,hydrateBuyers,withBuyer,escapeName};
