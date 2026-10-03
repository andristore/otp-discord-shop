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
    // Products without operator_id are the Any inventory, not all carriers.
    // The dedicated operator endpoint is authoritative for selectable carriers.
    for(const o of operators) {
      const value=o.operator_id==null?'any':String(o.operator_id);
      choices.set(value,{value,label:o.name || o.local_name || (value==='any'?'Otomatis (Any)':`Operator ${value}`)});
    }
    if(choices.size) return [...choices.values()];
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

function createPurchaseFlow({discord,smscode,smsCatalogProducts,pricing,adminView=false,resolveFavorite,isOwner=()=>false}) {
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const searches=new Map();
  const searchKey=(user,stage,state)=>`${user}:${stage}:${state.app || '-'}`;
  function queryFor(user,stage,state){const entry=searches.get(searchKey(user,stage,state));return entry && entry.expires>Date.now()?entry.query:'';}
  const titles={app:'1. Pilih Aplikasi',country:'2. Pilih Negara',operator:'3. Pilih Operator',product:'4. Pilih Harga & Stok'};
  const next={app:'country',country:'operator',operator:'product'};
  const previous={country:'app',operator:'country',product:'operator'};
  const cache=new Map();
  const startId=adminView?'provider_catalog':'shop_products';
  const productPrefix=adminView?'provider_product':'pick_product';
  async function list(path) {
    const cached=cache.get(path);
    if(cached && cached.expires>Date.now()) return cached.data;
    const r=await smscode(path);
    if(!Array.isArray(r.data)) throw new Error('Format daftar SMSCode tidak valid.');
    cache.set(path,{data:r.data,expires:Date.now()+60000});
    return r.data;
  }
  function key(prefix,stage,state,page=0) {
    return `${adminView?'provider_'+prefix:prefix}:${stage}:${state.app || '-'}:${state.country || '-'}:${state.operator || '-'}:${page}`;
  }
  async function catalog(stage,state) {
    // First screen needs only application names, not the full product inventory.
    if(stage==='app') return {services:await list('/catalog/services'),countries:[],products:[],operators:[]};
    const filters={platform_id:state.app};
    if(state.country && stage!=='country')filters.country_id=state.country;
    if(stage==='product' && state.operator && state.operator!=='any')filters.operator_id=state.operator;
    const [countries,result,operators]=await Promise.all([
      stage==='country'?list('/catalog/countries'):Promise.resolve([]),
      smsCatalogProducts(filters),
      ['operator','product'].includes(stage)?list(`/catalog/operators?country_id=${encodeURIComponent(state.country)}&platform_id=${encodeURIComponent(state.app)}`):Promise.resolve([])
    ]);
    return {services:[],countries,products:pricing?result.data.map(p=>({...p,providerPrice:Number(p.price?.canonical_amount ?? p.price),price:pricing.price(p.price?.canonical_amount ?? p.price)})):result.data,operators};
  }
  function optionsFor(stage,state,data) {
    const options=flowOptions(stage,state,data);
    if(adminView && stage==='product')for(const o of options) {
      const p=data.products.find(p=>String(p.id)===o.value);
      o.description=`Dasar ${p.providerPrice.toLocaleString('id-ID')} • Jual ${p.price.toLocaleString('id-ID')} • Stok ${p.available || 0}`;
    }
    const query=String(state.searchQuery || '').normalize('NFKC').toLocaleLowerCase('id-ID');
    return query && ['app','country'].includes(stage)?options.filter(o=>o.label.normalize('NFKC').toLocaleLowerCase('id-ID').includes(query)):options;
  }
  function render(stage,state,options,requested=0) {
    const pageSize=['app','country'].includes(stage)?15:20;
    const pages=Math.max(1,Math.ceil(options.length/pageSize));
    const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);
    const components=[];
    const visible=options.slice(page*pageSize,(page+1)*pageSize);
    for(let offset=0;offset<visible.length;offset+=5) {
      components.push(new ActionRowBuilder().addComponents(...visible.slice(offset,offset+5).map(o=>
        new ButtonBuilder().setCustomId(stage==='product'?`${productPrefix}:${o.value}:${state.app}:${state.country}${state.operator && state.operator!=='any'?':'+state.operator:''}`:`${key('flow_pick',stage,state,page)}:${o.value}`)
          .setLabel(String(stage==='product'?o.description:o.label).slice(0,80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!adminView && stage==='product' && o.description.includes('Tidak tersedia'))
      )));
    }
    const buttons=[];
    if(pages>1) buttons.push(
      new ButtonBuilder().setCustomId(key('flow_page',stage,state,page-1)).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(key('flow_page',stage,state,page+1)).setLabel('Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(page===pages-1));
    if(previous[stage])buttons.push(new ButtonBuilder().setCustomId(key('flow_page',previous[stage],state)).setLabel('Kembali').setStyle(ButtonStyle.Secondary));
    buttons.push(new ButtonBuilder().setCustomId(startId).setLabel('Mulai Ulang').setStyle(ButtonStyle.Primary));
    if(!adminView && stage==='app')buttons.push(new ButtonBuilder().setCustomId('favorites').setLabel('Favorit Saya').setStyle(ButtonStyle.Secondary));
    if(adminView)buttons.push(new ButtonBuilder().setCustomId('admin_home').setLabel('Panel Admin').setStyle(ButtonStyle.Secondary));
    if(['app','country'].includes(stage))buttons.push(new ButtonBuilder().setCustomId(key('flow_search',stage,state)).setLabel(stage==='app'?'Cari Aplikasi':'Cari Negara').setStyle(ButtonStyle.Primary));
    for(let offset=0;offset<buttons.length;offset+=5)components.push(new ActionRowBuilder().addComponents(...buttons.slice(offset,offset+5)));
    return {content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(`🛒 Hi, Belanja Produk Digital Yukk • ${titles[stage]}`)
      .setDescription(options.length?(adminView && stage==='product'?'Harga dasar dan stok dari SMSCode; harga jual mengikuti pengaturan toko. Tekan produk untuk detail.':stage==='product'?'Pilih harga dan stok, lalu periksa konfirmasi pembelian.':'Tekan tombol pilihan untuk melanjutkan.'):'Pilihan ini belum memiliki produk di katalog SMSCode. Kembali atau pilih aplikasi lain.')
      .setFooter({text:`Halaman ${page+1}/${pages} • ${options.length} pilihan`})],components};
  }
  return async function handleFlow(i) {
    const originalId=String(i.customId || '');
    if(adminView && !originalId.startsWith('provider_'))return false;
    if(!adminView && originalId.startsWith('provider_'))return false;
    if(adminView && !require('./admin').isDiscordAdmin((i.user?.id || 'legacy'))) {
      await i.reply({ephemeral:true,content:'Akses ditolak. Katalog ini hanya untuk admin toko.'});return true;
    }
    if(adminView && originalId.startsWith('provider_product:')) {
      await i.deferReply({ephemeral:true});
      const [,pid,app,country,operator]=originalId.split(':');
      const data=await catalog('product',{app,country,operator});const p=data.products.find(p=>String(p.id)===pid && (p.operator_id==null?'any':String(p.operator_id))===(operator || 'any'));
      if(!p){await i.editReply({content:'Produk tidak tersedia lagi.'});return true;}
      await i.editReply({embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(`Katalog Provider • ${String(p.name || p.id).slice(0,180)}`)
        .setDescription(`Harga dasar: **${p.providerPrice.toLocaleString('id-ID')} IDR**\nHarga jual: **${p.price.toLocaleString('id-ID')} IDR**\nSelisih: **${(p.price-p.providerPrice).toLocaleString('id-ID')} IDR**\nStok: **${p.available || 0}**\nStatus: **${p.active?'Aktif':'Nonaktif'}**`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('admin_pricing').setLabel('Atur Harga Jual Semua Layanan').setStyle(ButtonStyle.Primary),...(isOwner(i.user.id)?[new ButtonBuilder().setCustomId(`admin_owner_quote:${pid}:${app}:${country}:${operator || 'any'}`).setLabel('Beli Pakai Saldo Provider (Owner)').setStyle(ButtonStyle.Success)]:[]))]});return true;
    }
    if(!adminView && originalId.startsWith('favorite_open:')){
      await i.deferReply({ephemeral:true});
      const f=resolveFavorite(i.user.id,originalId.split(':')[1]);
      const state={app:f.app,country:f.country,operator:f.operator};
      await i.editReply(render('product',state,optionsFor('product',state,await catalog('product',state))));return true;
    }
    const id=adminView?(originalId===startId?'shop_products':originalId.replace(/^provider_/,'')):originalId;
    if(id!=='shop_products' && !/^flow_(page|select|pick|search|search_submit):/.test(id))return false;
    if(id==='shop_products') {
      await i.deferReply({ephemeral:true});
      const state={};
      for(const k of searches.keys())if(k.startsWith((i.user?.id || 'legacy')+':'))searches.delete(k);
      await i.editReply(render('app',state,optionsFor('app',state,await catalog('app',state))));
      return true;
    }
    const [prefix,stage,app,country,operator,rawPage,picked]=id.split(':');
    const state={app:app==='-'?undefined:app,country:country==='-'?undefined:country,operator:operator==='-'?undefined:operator};
    if(prefix==='flow_search' || prefix==='flow_search_submit'){
      if(!['app','country'].includes(stage))throw new Error('Pencarian hanya untuk aplikasi dan negara.');
      if(prefix==='flow_search'){
        await i.showModal(new ModalBuilder().setCustomId(key('flow_search_submit',stage,state)).setTitle(stage==='app'?'Cari Aplikasi':'Cari Negara').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Nama (kosongkan untuk semua)').setRequired(false).setMaxLength(80).setStyle(TextInputStyle.Short))));return true;
      }
      for(const [k,v]of searches)if(v.expires<Date.now())searches.delete(k);
      if(searches.size>=1000)searches.delete(searches.keys().next().value);
      const query=i.fields.getTextInputValue('query').trim().slice(0,80);
      searches.set(searchKey((i.user?.id || 'legacy'),stage,state),{query,expires:Date.now()+600000});
      state.searchQuery=query;
      await i.deferReply({ephemeral:true});await i.editReply(render(stage,state,optionsFor(stage,state,await catalog(stage,state))));return true;
    }
    state.searchQuery=queryFor((i.user?.id || 'legacy'),stage,state);
    await i.deferUpdate();
    if(!titles[stage])throw new Error('Menu tidak valid. Buka Beli OTP kembali.');
    const data=await catalog(stage,state);
    if(prefix==='flow_select' || prefix==='flow_pick') {
      const value=prefix==='flow_pick'?picked:i.values?.[0];
      if(!optionsFor(stage,state,data).some(o=>o.value===value)) {
        await i.editReply({content:'Pilihan tidak tersedia lagi. Klik Mulai Ulang.',embeds:[],components:render('app',{},[]).components});
        return true;
      }
      state[stage]=value;
      // Service IDs use platform_id in SMSCode products.
      const target=next[stage];
      if(!target)throw new Error('Pilihan tidak valid.');
      state.searchQuery=queryFor((i.user?.id || 'legacy'),target,state);
      await i.editReply(render(target,state,optionsFor(target,state,await catalog(target,state))));
    } else {
      await i.editReply(render(stage,state,optionsFor(stage,state,data),Number(rawPage)));
    }
    return true;
  };
}
module.exports={flowOptions,createPurchaseFlow};
