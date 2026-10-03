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
 let last=null;
 function baseUrl(){const base=String(env.GAME_CHECK_BASE_URL||'https://game-check.evogamestore.com').trim().replace(/\/$/,'');if(!['https://game-check.evogamestore.com','https://gamecheck.evogamestore.com'].includes(base))throw failure('Alamat layanan Evo tidak valid. Owner perlu memeriksa GAME_CHECK_BASE_URL.','CONFIG_INVALID');return base;}
 function failure(message,code,http=null){last={code,http,at:Date.now()};const e=Error(message);e.diagnostic=code+(http?' • HTTP '+http:'');return e;}
 function networkError(e){const code=String(e?.cause?.code||e?.code||'');return e?.name==='TimeoutError'||e?.name==='AbortError'?'TIMEOUT':['ENOTFOUND','EAI_AGAIN'].includes(code)?'DNS_FAILED':['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)?'TLS_FAILED':'NETWORK_FAILED';}
 const enabled=()=>env.NICKNAME_PROVIDER==='evogamestore';
 function supports(brand){return enabled()&&!!gameCode(brand);}
 async function check(brand,target,context={}){
  if(!supports(brand))return null;
  const game=gameCode(brand),key=String(env.GAME_CHECK_API_KEY||'').trim();
  if(!key)throw Error('Owner belum mengisi key gratis layanan cek akun. Saldo belum dipotong.');
  const parts=String(target).split('|'),userId=String(context.userId||parts[0]).trim(),zone=String(context.server||parts[1]||'').trim();
  if(ZONE.has(game)&&!zone)throw Error('Pengecekan membutuhkan ID dan server terpisah. Isi tujuan dengan format ID|server atau buka Isi ID / Tujuan.');
  if(!/^[a-zA-Z0-9._@+#\-]{1,80}$/.test(userId)||zone&&!/^[a-zA-Z0-9_\-]{1,20}$/.test(zone))throw Error('ID/server untuk pengecekan tidak valid.');
  const base=baseUrl();
  let res,data;
  try{
   res=await fetchImpl(base+'/api/v1/check',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-API-Key':key},body:JSON.stringify({game,user_id:userId,...(zone?{zone}:{})}),signal:AbortSignal.timeout(12000)});
  }catch(e){throw failure('Layanan cek akun sedang tidak tersedia. Coba lagi; saldo belum dipotong.',networkError(e));}
  if(res.status===401||res.status===403)throw failure('Key layanan cek akun perlu diperiksa owner. Saldo belum dipotong.','AUTH_FAILED',res.status);
  if(res.status===429)throw failure('Batas pengecekan layanan tercapai. Tunggu sebentar; saldo belum dipotong.','RATE_LIMIT',429);
  try{data=await res.json();}catch{throw failure('Respons layanan cek akun bukan JSON yang valid. Coba lagi; saldo belum dipotong.','INVALID_JSON',res.status);}
  if(res.status===404&&data?.status==='not_found')throw failure('ID/server tidak ditemukan. Periksa kembali sebelum topup.','ACCOUNT_NOT_FOUND',404);
  if(!res.ok||data?.status!=='success')throw failure('Layanan belum berhasil memverifikasi akun. Coba lagi; saldo belum dipotong.','UPSTREAM_FAILURE',res.status);
  const name=data?.data?.username;
  if(typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f\x7f]/.test(name))throw failure('Hasil cek akun tidak valid. Saldo belum dipotong.','INVALID_RESPONSE',res.status);
  last={code:'CHECK_OK',http:res.status||200,at:Date.now()};return name.trim();
 }
 async function health(){const base=baseUrl();let res;try{res=await fetchImpl(base+'/api/v1/health',{method:'GET',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});}catch(e){throw failure('Koneksi ke layanan cek akun gagal.',networkError(e));}if(!res.ok)throw failure('Endpoint health belum berhasil merespons.','HEALTH_HTTP_ERROR',res.status);last={code:'HEALTH_REACHABLE',http:res.status||200,at:Date.now()};return last;}
 return {health,diagnostics:()=>last,enabled,supports,check,requiresZone:brand=>supports(brand)&&ZONE.has(gameCode(brand))};
}
module.exports={createGameAccountCheck,gameCode};
