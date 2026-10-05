const {randomBytes}=require('node:crypto');

// Name-based menus also work when the selected server differs from the menu's server.
function createChannelPicker({discord,staff,access,listGuilds,listChannels,save,now=Date.now}) {
  const {ActionRowBuilder,ButtonBuilder,StringSelectMenuBuilder}=discord;
  const sessions=new Map(),prefix='shopm_channel:';
  const routes={
    admin_owner_release_channel:{kind:'release',title:'Channel Notifikasi Update',back:'admin_owner_release',owner:true},
    admin_store_info_config:{kind:'info',title:'Channel Informasi / Maintenance',back:'admin_store_info',owner:true},
    admin_order_channel_config:{kind:'orders',title:'Channel Laporan Pesanan',back:'admin_order_channel',owner:true},
    admin_shop_panel_publish:{kind:'panel',title:'Channel Panel Toko',back:'admin_shop_panel'}
  };
  const legacy=/^(admin_owner_release_save|admin_store_info_save|admin_order_channel_save|admin_ops_guild_channel_save:)/;
  function authorize(user,s){
    if(!staff.isAdmin(user)||(s.owner&&!staff.isOwner(user))||(staff.canRoute&&!staff.canRoute(user,s.route)))throw Error('Akses ditolak. Izin pengaturan sudah berubah.');
  }
  function validGuild(s,id){const g=access.get(id);return g&&g.present&&(s.kind==='transactions'||g.status==='approved');}
  const row=(...c)=>new ActionRowBuilder().addComponents(...c);
  const button=(id,label)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(2);
  async function render(i,key,s,stage,page=0){
    authorize(i.user.id,s);
    const items=stage==='guild'?(await listGuilds()).filter(g=>validGuild(s,g.id)):
      (await listChannels(s.guild,s.kind)).filter(c=>c.guildId===s.guild&&(c.type===0||s.kind==='transactions'&&c.type===5)&&c.usable);
    authorize(i.user.id,s);
    if(stage==='channel'&&!validGuild(s,s.guild))throw Error('Server tidak tersedia atau izinnya sudah berubah.');
    items.sort((a,b)=>String(a.name).localeCompare(String(b.name),'id')||a.id.localeCompare(b.id));
    if(stage==='channel'&&s.kind==='transactions')items.unshift({id:'all',name:'Semua channel'});
    const pages=Math.max(1,Math.ceil(items.length/25));page=Math.min(Math.max(0,page),pages-1);
    s.stage=stage;s.page=page;s.offered=items.slice(page*25,page*25+25).map(c=>c.id);
    const components=[];
    if(s.offered.length)components.push(row(new StringSelectMenuBuilder().setCustomId(prefix+key+':select').setPlaceholder(stage==='guild'?'Pilih nama server':'Pilih nama channel').setMinValues(1).setMaxValues(1).addOptions(items.slice(page*25,page*25+25).map(c=>({label:(stage==='channel'&&c.id!=='all'?'#':'')+String(c.name).slice(0,90),value:c.id,description:(c.parentName?'Kategori: '+c.parentName:stage==='guild'?'Server tujuan pengaturan':'Channel tujuan pengaturan').slice(0,100)})))));
    components.push(row(button(prefix+key+':prev','Sebelumnya').setDisabled(page===0),button(prefix+key+':next','Berikutnya').setDisabled(page===pages-1),...(stage==='channel'&&!s.fixed?[button(prefix+key+':servers','Ganti Server')]:[]),button(s.back,'Batal / Kembali')));
    await i.editReply({content:'**'+s.title+'**\n'+(stage==='guild'?'Pilih server tujuan, lalu pilih channel.':'Pilih channel tujuan. Pengaturan disimpan setelah dipilih.')+'\nHalaman '+(page+1)+'/'+pages+' • '+items.length+' pilihan'+(!items.length?'\nTidak ada pilihan yang tersedia. Periksa izin server dan izin bot pada channel.':''),components,allowedMentions:{parse:[]}});
  }
  return async i=>{
    const id=String(i.customId||'');let route=routes[id];
    if(id.startsWith('admin_ops_guild_channel:'))route={kind:'transactions',title:'Channel Transaksi Server',back:'admin_ops_guild:'+id.split(':')[1],fixed:id.split(':')[1]};
    if(!route&&!id.startsWith(prefix)&&!legacy.test(id))return false;
    await i.deferReply({ephemeral:true});let s,locked=false;
    try{
      for(const [key,value] of sessions)if(value.expires<=now())sessions.delete(key);
      if(legacy.test(id))throw Error('Menu lama tidak digunakan lagi. Buka kembali Atur Channel dan pilih nama channel.');
      if(route){
        s={...route,route:id,user:i.user.id,expires:now()+15*60000};authorize(i.user.id,s);
        if(s.fixed){s.guild=s.fixed;if(!validGuild(s,s.guild))throw Error('Server tidak tersedia.');}
        if(sessions.size>=500)throw Error('Terlalu banyak menu aktif. Coba lagi sesaat.');
        s.busy=true;locked=true;
        const key=randomBytes(10).toString('hex');sessions.set(key,s);await render(i,key,s,s.fixed?'channel':'guild');return true;
      }
      const [,key,action]=id.split(':');s=sessions.get(key);
      if(!s||s.user!==i.user.id)throw Error('Menu bukan milik Anda atau sudah kedaluwarsa. Buka kembali Atur Channel.');
      authorize(i.user.id,s);
      if(s.busy)throw Error('Pengaturan sedang disimpan.');s.busy=true;locked=true;
      if(action==='prev'||action==='next'){await render(i,key,s,s.stage,s.page+(action==='next'?1:-1));return true;}
      if(action==='servers'&&!s.fixed){await render(i,key,s,'guild');return true;}
      if(action!=='select'||i.values?.length!==1||!s.offered.includes(i.values[0]))throw Error('Pilihan tidak valid. Buka kembali menu.');
      const value=i.values[0];
      if(s.stage==='guild'){s.guild=value;await render(i,key,s,'channel');return true;}
      try{
        if(!validGuild(s,s.guild))throw Error('Izin server sudah berubah.');
        if(value!=='all'){
          const channel=(await listChannels(s.guild,s.kind)).find(c=>c.id===value&&c.guildId===s.guild&&(c.type===0||s.kind==='transactions'&&c.type===5)&&c.usable);
          if(!channel)throw Error('Channel tidak tersedia atau izin bot sudah berubah.');
        }else if(s.kind!=='transactions')throw Error('Pilihan channel tidak valid.');
        authorize(i.user.id,s);if(!validGuild(s,s.guild))throw Error('Izin server sudah berubah.');
        await save(s.kind,i.user.id,s.guild,value==='all'?null:value);
        sessions.delete(key);
        await i.editReply({content:'✅ '+s.title+' berhasil disimpan: '+(value==='all'?'semua channel':'<#'+value+'>')+'.',allowedMentions:{parse:[]},components:[row(button(s.back,'Kembali ke Pengaturan'))]});
      }finally{s.busy=false;}
    }catch(e){await i.editReply({content:'❌ '+(/Akses|Izin|izin|Menu|menu|Server|server|Channel|channel|Pilihan|pilihan|Pengaturan|pengaturan|Terlalu/.test(String(e.message))?String(e.message).slice(0,500):'Pengaturan belum berhasil. Periksa izin bot dan koneksi, lalu coba lagi.'),allowedMentions:{parse:[]},components:[row(button(s?.back||'admin_system_access','Kembali'))]});}
    finally{if(locked)s.busy=false;}
    return true;
  };
}
module.exports={createChannelPicker};
