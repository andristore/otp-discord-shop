"use strict";
// Documented public integration: https://game-check.evogamestore.com/
const GAMES={
 'mobile legends':'mobile-legends','mobile legends bang bang':'mobile-legends','ml':'mobile-legends',
 'free fire':'free-fire','free fire max':'free-fire','ff':'free-fire',
 'pubg mobile':'pubg-mobile','valorant':'valorant','genshin impact':'genshin-impact',
 'honkai star rail':'honkai-star-rail','point blank':'point-blank'
};
const ZONE=new Set(['mobile-legends','genshin-impact','honkai-star-rail']);
function gameCode(brand){return GAMES[String(brand).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()]||null;}
function createGameAccountCheck({env=process.env,fetchImpl=fetch}){
 const enabled=()=>env.NICKNAME_PROVIDER==='evogamestore';
 function supports(brand){return enabled()&&!!gameCode(brand);}
 async function check(brand,target,context={}){
  if(!supports(brand))return null;
  const game=gameCode(brand),key=String(env.GAME_CHECK_API_KEY||'').trim();
  if(!key)throw Error('Owner belum mengisi key gratis layanan cek akun. Saldo belum dipotong.');
  const parts=String(target).split('|'),userId=String(context.userId||parts[0]).trim(),zone=String(context.server||parts[1]||'').trim();
  if(ZONE.has(game)&&!zone)throw Error('Pengecekan membutuhkan ID dan server terpisah. Isi tujuan dengan format ID|server atau buka Isi ID / Tujuan.');
  if(!/^[a-zA-Z0-9._@+#\-]{1,80}$/.test(userId)||zone&&!/^[a-zA-Z0-9_\-]{1,20}$/.test(zone))throw Error('ID/server untuk pengecekan tidak valid.');
  let res,data;
  try{
   res=await fetchImpl('https://gamecheck.evogamestore.com/api/v1/check',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-API-Key':key},body:JSON.stringify({game,user_id:userId,...(zone?{zone}:{})}),signal:AbortSignal.timeout(12000)});
   data=await res.json();
  }catch{throw Error('Layanan cek akun sedang tidak tersedia. Coba lagi; saldo belum dipotong.');}
  if(res.status===401||res.status===403)throw Error('Key layanan cek akun perlu diperiksa owner. Saldo belum dipotong.');
  if(res.status===429)throw Error('Batas pengecekan layanan tercapai. Tunggu sebentar; saldo belum dipotong.');
  if(res.status===404&&data?.status==='not_found')throw Error('ID/server tidak ditemukan. Periksa kembali sebelum topup.');
  if(!res.ok||data?.status!=='success')throw Error('Layanan belum berhasil memverifikasi akun. Coba lagi; saldo belum dipotong.');
  const name=data?.data?.username;
  if(typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f\x7f]/.test(name))throw Error('Hasil cek akun tidak valid. Saldo belum dipotong.');
  return name.trim();
 }
 return {enabled,supports,check,requiresZone:brand=>supports(brand)&&ZONE.has(gameCode(brand))};
}
module.exports={createGameAccountCheck,gameCode};
