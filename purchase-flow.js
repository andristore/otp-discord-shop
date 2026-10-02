function flowOptions(stage, state, catalog) {
  const {services,countries,products,operators=[]}=catalog;
  if(stage==='app') return services.filter(s=>s.active!==false).map(s=>({value:String(s.id),label:s.name}));
  const matching=products.filter(p=>String(p.platform_id)===state.app);
  if(stage==='country') {
    const ids=new Set(matching.map(p=>String(p.country_id)));
    return countries.filter(c=>c.active!==false && ids.has(String(c.id)))
      .map(c=>({value:String(c.id),label:`${c.emoji || ''} ${c.name}`.trim()}));
  }
  const local=matching.filter(p=>String(p.country_id)===state.country);
  if(stage==='operator') {
    const choices=new Map();
    for(const p of local) {
      const value=p.operator_id==null?'any':String(p.operator_id);
      const meta=operators.find(o=>(o.operator_id==null?'any':String(o.operator_id))===value);
      choices.set(value,{value,label:meta?.name || p.operator_name || (value==='any'?'Otomatis (Any)':`Operator ${value}`)});
    }
    return [...choices.values()];
  }
  if(stage==='product') return local.filter(p=>(p.operator_id==null?'any':String(p.operator_id))===state.operator)
    .sort((a,b)=>Number(a.price?.canonical_amount ?? a.price)-Number(b.price?.canonical_amount ?? b.price))
    .map(p=>({value:String(p.id),label:p.name || `Produk ${p.id}`,
      description:`${Number(p.price?.canonical_amount ?? p.price ?? 0).toLocaleString('id-ID')} IDR • ${p.active && Number(p.available)>0?`Stok ${p.available}`:'Tidak tersedia'}`}));
  throw new Error('Tahap pembelian tidak valid.');
}

function createPurchaseFlow({discord,smscode,smsCatalogProducts}) {
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle}=discord;
  const titles={app:'1. Pilih Aplikasi',country:'2. Pilih Negara',operator:'3. Pilih Operator',product:'4. Pilih Harga & Stok'};
  const next={app:'country',country:'operator',operator:'product'};
  const previous={country:'app',operator:'country',product:'operator'};
  const cache=new Map();
  async function list(path) {
    const cached=cache.get(path);
    if(cached && cached.expires>Date.now()) return cached.data;
    const r=await smscode(path);
    if(!Array.isArray(r.data)) throw new Error('Format daftar SMSCode tidak valid.');
    cache.set(path,{data:r.data,expires:Date.now()+60000});
    return r.data;
  }
  function key(prefix,stage,state,page=0) {
    return `${prefix}:${stage}:${state.app || '-'}:${state.country || '-'}:${state.operator || '-'}:${page}`;
  }
  async function catalog(stage,state) {
    const [services,countries,result]=await Promise.all([
      list('/catalog/services'),list('/catalog/countries'),smsCatalogProducts()
    ]);
    const operators=['operator','product'].includes(stage)?await list(`/catalog/operators?country_id=${encodeURIComponent(state.country)}&platform_id=${encodeURIComponent(state.app)}`):[];
    return {services,countries,products:result.data,operators};
  }
  function render(stage,state,options,requested=0) {
    const pages=Math.max(1,Math.ceil(options.length/20));
    const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);
    const components=[];
    const visible=options.slice(page*20,(page+1)*20);
    for(let offset=0;offset<visible.length;offset+=5) {
      components.push(new ActionRowBuilder().addComponents(...visible.slice(offset,offset+5).map(o=>
        new ButtonBuilder().setCustomId(stage==='product'?`pick_product:${o.value}`:`${key('flow_pick',stage,state,page)}:${o.value}`)
          .setLabel(String(stage==='product'?o.description:o.label).slice(0,80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(stage==='product' && o.description.includes('Tidak tersedia'))
      )));
    }
    const buttons=[];
    if(pages>1) buttons.push(
      new ButtonBuilder().setCustomId(key('flow_page',stage,state,page-1)).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(key('flow_page',stage,state,page+1)).setLabel('Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(page===pages-1));
    if(previous[stage])buttons.push(new ButtonBuilder().setCustomId(key('flow_page',previous[stage],state)).setLabel('Kembali').setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setCustomId('shop_products').setLabel('Mulai Ulang').setStyle(ButtonStyle.Primary));
    components.push(new ActionRowBuilder().addComponents(...buttons));
    return {content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(`🛒 OTP Maboyy • ${titles[stage]}`)
      .setDescription(options.length?(stage==='product'?'Pilih harga dan stok, lalu periksa konfirmasi pembelian.':'Tekan tombol pilihan untuk melanjutkan.'):'Pilihan ini belum memiliki produk di katalog SMSCode. Kembali atau pilih aplikasi lain.')
      .setFooter({text:`Halaman ${page+1}/${pages} • ${options.length} pilihan`})],components};
  }
  return async function handleFlow(i) {
    const id=String(i.customId || '');
    if(id!=='shop_products' && !id.startsWith('flow_page:') && !id.startsWith('flow_select:') && !id.startsWith('flow_pick:'))return false;
    if(id==='shop_products') {
      await i.deferReply({ephemeral:true});
      const state={};
      await i.editReply(render('app',state,flowOptions('app',state,await catalog('app',state))));
      return true;
    }
    const [prefix,stage,app,country,operator,rawPage,picked]=id.split(':');
    const state={app:app==='-'?undefined:app,country:country==='-'?undefined:country,operator:operator==='-'?undefined:operator};
    await i.deferUpdate();
    if(!titles[stage])throw new Error('Menu tidak valid. Buka Beli OTP kembali.');
    const data=await catalog(stage,state);
    if(prefix==='flow_select' || prefix==='flow_pick') {
      const value=prefix==='flow_pick'?picked:i.values?.[0];
      if(!flowOptions(stage,state,data).some(o=>o.value===value)) {
        await i.editReply({content:'Pilihan tidak tersedia lagi. Klik Mulai Ulang.',embeds:[],components:render('app',{},[]).components});
        return true;
      }
      state[stage]=value;
      // Service IDs use platform_id in SMSCode products.
      const target=next[stage];
      if(!target)throw new Error('Pilihan tidak valid.');
      await i.editReply(render(target,state,flowOptions(target,state,await catalog(target,state))));
    } else {
      await i.editReply(render(stage,state,flowOptions(stage,state,data),Number(rawPage)));
    }
    return true;
  };
}
module.exports={flowOptions,createPurchaseFlow};
