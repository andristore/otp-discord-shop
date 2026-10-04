'use strict';
const https=require('node:https');
const {isIP}=require('node:net');
function validIPv4(value){
 const ip=String(value||'').trim();if(isIP(ip)!==4)return null;
 const [a,b]=ip.split('.').map(Number);
 if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19))return null;
 return ip;
}
function requestIPv4(url){return new Promise((resolve,reject)=>{
 const req=https.get(url,{family:4,headers:{Accept:'text/plain'}},res=>{
  if(res.statusCode!==200){res.resume();reject(Error('status'));return;}
  let data='';res.setEncoding('utf8');res.on('data',chunk=>{data+=chunk;if(data.length>128)req.destroy(Error('response'));});
  res.on('error',reject);res.on('end',()=>{const ip=validIPv4(data);ip?resolve(ip):reject(Error('invalid'));});
 });const timer=setTimeout(()=>req.destroy(Error('timeout')),4000);timer.unref();req.on('close',()=>clearTimeout(timer));req.on('error',reject);
});}
function createServerIP({request=requestIPv4,now=Date.now}={}){
 let snapshot=null,pending=null,nextCheck=0;
 async function refresh(){
  if(pending)return pending;if(now()<nextCheck)return snapshot;
  pending=(async()=>{for(const url of ['https://api.ipify.org','https://checkip.amazonaws.com']){try{
   const ip=validIPv4(await request(url));if(!ip)continue;
   snapshot={ip,checkedAt:now(),available:true};nextCheck=now()+60000;return snapshot;
  }catch{}}
  snapshot={ip:null,checkedAt:now(),available:false};nextCheck=now()+30000;return snapshot;
  })();try{return await pending;}finally{pending=null;}
 }
 return {refresh};
}
function serverIPText(result){return '\n\n**🌐 IP Keluar Server (Owner)**\n'+(result?.available&&validIPv4(result.ip)?'IPv4: `'+result.ip+'`\nDiperiksa: '+new Date(result.checkedAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})+' WIB\nIP saat ini dapat berubah atau berbeda antar koneksi. Periksa kembali setelah redeploy.':'Belum bisa memeriksa IP. Coba lagi nanti.');}
module.exports={createServerIP,validIPv4,serverIPText};
