const {randomBytes}=require('node:crypto');
function createWebSecurity({env=process.env,now=Date.now}={}){
  const secret=String(env.SESSION_SECRET||''),password=String(env.ADMIN_PASSWORD||'');
  const enabled=secret.length>=32&&secret!=='replace-me'&&password.length>=12;
  const attempts=new Map(),window=15*60*1000;
  const secure=env.NODE_ENV==='production'||!!env.RAILWAY_ENVIRONMENT_ID;
  function loginLimit(req,res,next){
    if(!enabled)return res.status(503).json({error:'Dashboard admin belum diaktifkan. Isi SESSION_SECRET minimal 32 karakter dan ADMIN_PASSWORD minimal 12 karakter.'});
    const clock=now();for(const [key,r]of attempts)if(clock-r.start>=window)attempts.delete(key);
    const key=req.ip||'unknown',r=attempts.get(key)||{start:clock,count:0};
    if(r.count>=10||(!attempts.has(key)&&attempts.size>=1000)){res.set?.('Retry-After','900');return res.status(429).json({error:'Terlalu banyak percobaan login. Tunggu 15 menit.'});}
    r.count++;attempts.set(key,r);next();
  }
  function originGuard(req,res,next){
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    const origin=req.get('Origin');
    // Non-browser login is allowed; authenticated mutations require an Origin.
    if(!origin&&!req.session?.admin)return next();
    try{const u=new URL(origin);if(u.origin!==req.protocol+'://'+req.get('host'))throw Error();}
    catch{return res.status(403).json({error:'Asal permintaan dashboard tidak sesuai.'});}
    next();
  }
  return {enabled,sessionSecret:enabled?secret:randomBytes(48).toString('hex'),secure,loginLimit,originGuard};
}
function createDiagnostics({db,now=Date.now}){
  db.exec("CREATE TABLE IF NOT EXISTS bot_diagnostics(scope TEXT,code TEXT,ref TEXT,seen_at INTEGER,count INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(scope,code,ref))");
  function record(scope,code,ref=''){
    if(!['payment','provider','product_dm','product_poll','webhook','interaction'].includes(scope)||!['FAILED','REJECTED','UNCERTAIN'].includes(code))return;
    ref=/^[a-zA-Z0-9_-]{1,80}$/.test(String(ref))?String(ref):'';
    try{db.prepare('INSERT INTO bot_diagnostics(scope,code,ref,seen_at) VALUES(?,?,?,?) ON CONFLICT(scope,code,ref) DO UPDATE SET count=count+1,seen_at=excluded.seen_at').run(scope,code,ref,now());
      db.prepare('DELETE FROM bot_diagnostics WHERE rowid NOT IN (SELECT rowid FROM bot_diagnostics ORDER BY seen_at DESC,rowid DESC LIMIT 100)').run();
    }catch{console.warn('Catatan diagnostik belum dapat disimpan.');}
  }
  return {record,recent:()=>db.prepare('SELECT * FROM bot_diagnostics ORDER BY seen_at DESC LIMIT 10').all()};
}
module.exports={createWebSecurity,createDiagnostics};
