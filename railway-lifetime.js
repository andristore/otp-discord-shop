'use strict';
const {createHash}=require('node:crypto');
const DAY=86400000,ENDPOINT='https://backboard.railway.com/graphql/v2';
// Discover actual fields from Railway's authenticated schema; never calculate
// trial expiry from sign-up, deployment, billing period or a manually set date.
const TYPE='kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
const SCHEMA_QUERY=`query RailwayTrialSchema { __schema { queryType { name } types { kind name fields(includeDeprecated:true) { name type { ${TYPE} } args { name defaultValue type { ${TYPE} } } } } } }`;
const END_FIELDS=new Set(['trialEndsAt','trialEndAt','trialEndDate','trialExpiresAt','trialExpirationDate','trialExpiration','trialExpiry','trialExpiryDate','trialEnd']);
const DAY_FIELDS=new Set(['trialDaysRemaining','remainingTrialDays','trialDaysLeft']);
const LINKS=new Set(['customer','billing','billingDetails','subscription','activeSubscription','trial','freeTrial','plan','account','workspace','team']);
const PLAN_FIELDS=new Set(['plan','planId','subscriptionPlan','tier']);
const FLAG_FIELDS=new Set(['isTrial','isTrialing','onTrial']);
const nameOK=s=>/^[_A-Za-z][_0-9A-Za-z]*$/.test(s||'');
function unwrap(t){let list=false;while(t?.ofType){if(t.kind==='LIST')list=true;t=t.ofType;}return {...t,list};}
const required=f=>(f.args||[]).some(a=>a.type?.kind==='NON_NULL'&&a.defaultValue==null);
function dateWIB(ms){return new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',dateStyle:'long',timeStyle:'short'}).format(ms)+' WIB';}
function fail(code){const e=Error(code);e.code=code;return e;}
function expiryValue(v){
  if(typeof v==='number'&&Number.isFinite(v)){const ms=v>=1e12?v:v>=1e9?v*1000:NaN;return Number.isFinite(ms)&&ms>=Date.UTC(2020,0,1)&&ms<=Date.UTC(2101,0,1)?ms:null;}
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v))return null;
  const ms=Date.parse(v);return Number.isFinite(ms)&&ms>=Date.UTC(2020,0,1)&&ms<=Date.UTC(2101,0,1)?ms:null;
}
function schemaPaths(schema,rootType){
  const types=new Map(schema.types.map(t=>[t.name,t])),paths=[];
  function visit(type,path,seen){
    if(path.length>5||seen.has(type))return;
    for(const f of types.get(type)?.fields||[]){
      if(!nameOK(f.name)||required(f))continue;
      const u=unwrap(f.type);if(u.list)continue;
      const p=[...path,f.name],trialObject=/(?:Free)?Trial/i.test(type)||['trial','freeTrial'].includes(path.at(-1));
      let kind=END_FIELDS.has(f.name)?'expiry':DAY_FIELDS.has(f.name)?'days':PLAN_FIELDS.has(f.name)?'plan':FLAG_FIELDS.has(f.name)?'flag':null;
      if(trialObject&&['expiresAt','endsAt','endAt','endDate','expiryDate'].includes(f.name))kind='expiry';
      if(trialObject&&['daysRemaining','daysLeft'].includes(f.name))kind='days';
      if(['SCALAR','ENUM'].includes(u.kind)&&kind)paths.push({path:p,kind});
      if(u.kind==='OBJECT'&&LINKS.has(f.name))visit(u.name,p,new Set([...seen,type]));
    }
  }
  visit(rootType,[],new Set());return paths;
}
function selection(paths){const tree={};for(const p of paths){let node=tree;for(const key of p.path){if(!nameOK(key))throw fail('SCHEMA_UNSUPPORTED');node=node[key]||(node[key]={});}}const print=node=>Object.entries(node).map(([key,child])=>key+(Object.keys(child).length?' { '+print(child)+' }':'')).join(' ');return print(tree);}
function rootCall(f,values){
  if(!f||!nameOK(f.name))return null;const parts=[];
  for(const a of f.args||[]){if(!nameOK(a.name))return null;if(values[a.name]!=null)parts.push(a.name+': '+JSON.stringify(String(values[a.name])));else if(a.type?.kind==='NON_NULL'&&a.defaultValue==null)return null;}
  return f.name+(parts.length?'('+parts.join(', ')+')':'');
}
const pathValue=(obj,path)=>path.reduce((v,k)=>v?.[k],obj);
function normalize(data,paths,scope,checkedAt){
  const read=kind=>paths.filter(p=>p.kind===kind).map(p=>pathValue(data,p.path)).filter(v=>v!=null);
  const plans=read('plan').filter(v=>typeof v==='string'),flags=read('flag').filter(v=>typeof v==='boolean');
  const paid=plans.some(v=>/^(HOBBY|PRO|ENTERPRISE|BUSINESS)$/i.test(v)),free=plans.some(v=>/^FREE$/i.test(v));
  if(paid||free||flags.includes(false))return {scope,checkedAt,expires:null,days:null,plan:plans[0]||null,trial:false};
  const rawEnds=read('expiry'),rawDays=read('days'),ends=rawEnds.map(expiryValue);
  if(ends.some(v=>v===null)||rawDays.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>36500))throw fail('INVALID_RESPONSE');
  const unique=[...new Set(ends)];if(unique.length>1)throw fail('AMBIGUOUS_TRIAL');
  if(!unique.length&&!rawDays.length)throw fail('TRIAL_UNAVAILABLE');
  if(!unique.length&&new Set(rawDays).size>1)throw fail('AMBIGUOUS_TRIAL');
  return {scope,checkedAt,expires:unique[0]??null,days:rawDays[0]??null,plan:plans[0]||null,trial:true};
}
function createRailwayClient({env=process.env,fetchImpl=fetch,now=Date.now}){
  const token=String(env.RAILWAY_API_TOKEN||'').trim(),workspace=String(env.RAILWAY_WORKSPACE_ID||'').trim(),project=String(env.RAILWAY_PROJECT_ID||'').trim();
  let schema=null,route=null,nextAttempt=0,current={state:'unconfigured',snapshot:null},pending=null;
  async function request(query){
    let res;try{res=await fetchImpl(ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query}),redirect:'error',signal:AbortSignal.timeout(8000)});}catch{throw fail('NETWORK_ERROR');}
    if(res.status===401||res.status===403)throw fail('AUTH_ERROR');
    if(res.status===429){const wait=Number(res.headers?.get?.('retry-after'));nextAttempt=now()+Math.max(300000,Number.isFinite(wait)?Math.min(wait*1000,86400000):300000);throw fail('RATE_LIMIT');}
    let body;try{body=await res.json();}catch{throw fail('INVALID_RESPONSE');}
    if(body.errors?.length){if(body.errors.some(e=>/not authorized|unauthorized|forbidden|authentication/i.test(e.message||'')))throw fail('AUTH_ERROR');if(body.errors.some(e=>e.extensions?.code==='GRAPHQL_VALIDATION_FAILED')){schema=null;route=null;throw fail('SCHEMA_UNSUPPORTED');}throw fail('API_ERROR');}
    if(!res.ok)throw fail('UPSTREAM_ERROR');
    if(!body.data||typeof body.data!=='object')throw fail('INVALID_RESPONSE');return body.data;
  }
  async function discover(){
    if(!schema){schema=(await request(SCHEMA_QUERY)).__schema;if(!schema?.queryType?.name||!Array.isArray(schema.types)){schema=null;throw fail('SCHEMA_UNSUPPORTED');}}
    const types=new Map(schema.types.map(t=>[t.name,t])),roots=types.get(schema.queryType.name)?.fields||[];
    const tryRoot=(root,values,scope)=>{const f=roots.find(f=>f.name===root),u=unwrap(f?.type);if(u.kind!=='OBJECT'||u.list)return null;const call=rootCall(f,values);if(!call)return null;const paths=schemaPaths(schema,u.name);if(!paths.some(p=>['expiry','days'].includes(p.kind)))return null;return {root,call,paths,scope};};
    if(workspace){for(const root of ['workspace','team','customer']){const candidate=tryRoot(root,root==='customer'?{workspaceId:workspace,teamId:workspace}:{id:workspace,workspaceId:workspace,teamId:workspace},'workspace:'+workspace);if(candidate)return candidate;}throw fail('SCHEMA_UNSUPPORTED');}
    if(project){
      const direct=tryRoot('project',{id:project,projectId:project},'project:'+project);if(direct)return direct;
      const f=roots.find(f=>f.name==='project'),u=unwrap(f?.type),fields=types.get(u.name)?.fields||[],call=rootCall(f,{id:project,projectId:project});
      const ids=fields.filter(f=>['workspaceId','teamId'].includes(f.name)&&!required(f)&&['SCALAR','ENUM'].includes(unwrap(f.type).kind));
      const links=fields.filter(f=>['workspace','team'].includes(f.name)&&!required(f)&&unwrap(f.type).kind==='OBJECT'&&(types.get(unwrap(f.type).name)?.fields||[]).some(x=>x.name==='id'&&!required(x)));
      if(!call||(!ids.length&&!links.length))throw fail('WORKSPACE_REQUIRED');
      const data=(await request('query RailwayProjectWorkspace { '+call+' { '+[...ids.map(f=>f.name),...links.map(f=>f.name+' { id }')].join(' ')+' } }')).project;
      const found=[...new Set([...ids.map(f=>data?.[f.name]),...links.map(f=>data?.[f.name]?.id)].filter(v=>typeof v==='string'&&v))];
      if(found.length!==1)throw fail('WORKSPACE_REQUIRED');
      const id=found[0];for(const root of ['workspace','team','customer']){const candidate=tryRoot(root,root==='customer'?{workspaceId:id,teamId:id}:{id,workspaceId:id,teamId:id},'workspace:'+id);if(candidate)return candidate;}throw fail('SCHEMA_UNSUPPORTED');
    }
    // Account scope only when no project/workspace is configured. Never silently
    // substitute a personal account for a failed project workspace lookup.
    const me=tryRoot('me',{},'account:'+createHash('sha256').update(token).digest('hex').slice(0,16));if(me)return me;
    throw fail('WORKSPACE_REQUIRED');
  }
  function refresh(){
    if(!token)return Promise.resolve({state:'unconfigured',snapshot:null});
    if(pending)return pending;if(now()<nextAttempt)return Promise.resolve(current);
    pending=(async()=>{try{if(!route)route=await discover();const data=await request('query RailwayTrialStatus { '+route.call+' { '+selection(route.paths)+' } }');const snapshot=normalize(data[route.root],route.paths,route.scope,now());current={state:'ready',snapshot};nextAttempt=now()+900000;}catch(e){current={state:e.code||'API_ERROR',snapshot:current.snapshot};nextAttempt=Math.max(nextAttempt,now()+300000);}return current;})().finally(()=>pending=null);return pending;
  }
  return {refresh};
}
const ERRORS={unconfigured:'Belum terhubung. Tambahkan RAILWAY_API_TOKEN di Variables Railway.',AUTH_ERROR:'Token ditolak. Gunakan Account API Token yang memiliki akses ke workspace proyek.',SCHEMA_UNSUPPORTED:'API Railway belum menyediakan field trial yang dikenali.',WORKSPACE_REQUIRED:'Workspace belum teridentifikasi. Tambahkan RAILWAY_WORKSPACE_ID sesuai workspace proyek.',TRIAL_UNAVAILABLE:'API terhubung, tetapi data masa trial tidak tersedia.',AMBIGUOUS_TRIAL:'Data trial tidak konsisten; sisa hari belum dapat dipastikan.',INVALID_RESPONSE:'Respons Railway tidak valid; sisa hari belum dapat dipastikan.',RATE_LIMIT:'Batas API tercapai. Pemeriksaan akan dicoba kembali.',NETWORK_ERROR:'Koneksi Railway gagal. Pemeriksaan akan dicoba kembali.',UPSTREAM_ERROR:'Railway sedang gagal merespons.',API_ERROR:'API Railway gagal membaca data trial.'};
function lifetimeText(s){
  let out='\n\n**🚂 Masa Trial Railway • Otomatis**';
  if(s?.state!=='ready'){out+='\n'+(ERRORS[s?.state]||'Data belum tersedia.');if(s?.snapshot)out+='\nTerakhir berhasil: '+dateWIB(s.snapshot.checkedAt)+' (data lama; bukan status saat ini).';return out;}
  const v=s.snapshot;if(!v)return out+'\nData belum tersedia.';
  if(v.plan)out+='\nPaket: '+String(v.plan).replace(/[^a-zA-Z0-9 _-]/g,'').slice(0,40);
  if(!v.trial)return out+'\nTidak sedang menggunakan trial menurut API Railway.\nDiperiksa: '+dateWIB(v.checkedAt);
  if(v.expires!==null){const minutes=Math.max(0,Math.ceil((v.expires-(s.now??Date.now()))/60000));out+='\nBerakhir: '+dateWIB(v.expires)+'\nSisa: '+(minutes===0?'Trial telah berakhir':Math.floor(minutes/1440)+' hari '+Math.floor(minutes%1440/60)+' jam '+minutes%60+' menit');}
  else out+='\nSisa trial dari API: '+v.days+' hari (saat pemeriksaan terakhir).';
  return out+'\nPengingat owner: H-3.\nDiperiksa: '+dateWIB(v.checkedAt)+' • disegarkan setiap 15 menit.';
}
function createRailwayLifetime({db,staff,sendDM,env=process.env,fetchImpl=fetch,now=Date.now,client=createRailwayClient({env,fetchImpl,now})}){
  // v2 notices are scoped to the account/workspace returned by the API. Legacy
  // manually configured dates and their notification history are ignored.
  db.exec('CREATE TABLE IF NOT EXISTS railway_trial_notices(notice_key TEXT NOT NULL,owner_id TEXT NOT NULL,sent_ms INTEGER,next_attempt_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(notice_key,owner_id));');
  let current={state:'unconfigured',snapshot:null,now:now()},pending=null;
  const settings=()=>({...current,now:now()});
  async function refresh(){const result=await client.refresh();current={...result,now:now()};return settings();}
  function poll(){if(pending)return pending;pending=(async()=>{const s=await refresh(),v=s.snapshot;if(s.state!=='ready'||!v?.trial)return;const remaining=v.expires!==null?v.expires-now():v.days*DAY;if(!Number.isFinite(remaining)||remaining>3*DAY)return;const key=v.scope+':H3:'+(v.expires??'one-time-trial');for(const {id} of staff.ownerList()){if(!staff.isOwner(id))continue;const n=db.prepare('SELECT * FROM railway_trial_notices WHERE notice_key=? AND owner_id=?').get(key,id);if((n?.sent_ms!==null&&n?.sent_ms!==undefined)||(n&&n.next_attempt_ms>now()))continue;db.prepare('INSERT INTO railway_trial_notices(notice_key,owner_id,next_attempt_ms) VALUES(?,?,?) ON CONFLICT(notice_key,owner_id) DO UPDATE SET next_attempt_ms=excluded.next_attempt_ms').run(key,id,now()+3600000);try{const r=await sendDM(id,'⚠️ Masa trial Railway sudah H-3 atau kurang.'+lifetimeText({...s,now:now()})+'\nPeriksa dashboard Railway. Kredit trial dapat habis lebih awal. Bot harus tetap berjalan untuk mengirim pengingat.');if(r===false)continue;db.prepare('UPDATE railway_trial_notices SET sent_ms=? WHERE notice_key=? AND owner_id=?').run(now(),key,id);}catch{/* Failed DM retries in one hour. */}}})().finally(()=>pending=null);return pending;}
  return {settings,refresh,poll};
}
function createRailwayHandler({discord,staff,model}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=discord;
  const panel=()=>({content:'**Railway • Khusus Owner**'+lifetimeText(model.settings())+'\nTanggal manual tidak digunakan. Koneksi memakai RAILWAY_API_TOKEN dari Variables Railway.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('admin_railway_refresh').setLabel('Cek Koneksi / Perbarui').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('admin_bot_ping').setLabel('Kembali ke Ping').setStyle(ButtonStyle.Secondary))]});
  return async i=>{const id=String(i.customId||'');if(!id.startsWith('admin_railway_'))return false;if(!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Koneksi Railway khusus owner.'});return true;}if(!['admin_railway_menu','admin_railway_refresh','admin_railway_edit','admin_railway_save'].includes(id))return false;await i.deferReply({ephemeral:true});if(!staff.isOwner(i.user.id)){await i.editReply({content:'Akses owner telah dicabut.',components:[]});return true;}await model.refresh();if(!staff.isOwner(i.user.id)){await i.editReply({content:'Akses owner telah dicabut.',components:[]});return true;}await i.editReply(panel());return true;};
}
module.exports={createRailwayLifetime,createRailwayClient,createRailwayHandler,lifetimeText,dateWIB,expiryValue,schemaPaths,normalize,SCHEMA_QUERY};
