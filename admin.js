function isDiscordAdmin(id, configured=process.env.ADMIN_DISCORD_IDS || '') {
  return configured.split(',').map(value=>value.trim()).filter(Boolean).includes(String(id));
}

function parseProduct(fields) {
  const name=fields.getTextInputValue('name').trim();
  const country=fields.getTextInputValue('country').trim();
  const service=fields.getTextInputValue('service').trim();
  const rawPrice=fields.getTextInputValue('price').trim();
  const active=fields.getTextInputValue('enabled').trim();
  const price=Number(rawPrice);
  if(!name || !country || !service || !/^\d+$/.test(rawPrice) || !Number.isSafeInteger(price) || !['0','1'].includes(active)) {
    throw new Error('Isi semua kolom. Harga harus bilangan bulat nonnegatif; status harus 1 (aktif) atau 0 (nonaktif).');
  }
  return {name,country,service,price,enabled:Number(active)};
}

function createAdminHandler({discord, db, smscode,pricing}) {
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,
    ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const amount=value=>`${Number(value || 0).toLocaleString('id-ID')} IDR`;
  function home() {
    return {content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('⚙️ Panel Admin')
      .setDescription('Atur persentase keuntungan dan harga jual melalui Atur Harga Jual. Harga dasar dan stok provider mengikuti SMSCode. Katalog lokal dikelola terpisah.')],components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_products:0').setLabel('Katalog Lokal').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin_add').setLabel('Tambah Produk').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('admin_health').setLabel('Koneksi & Saldo Provider').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('admin_pricing').setLabel('Atur Harga Jual').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin_close').setLabel('Tutup Panel').setStyle(ButtonStyle.Secondary)
      )]};
  }
  function products(requested=0) {
    const count=db.prepare('SELECT COUNT(*) c FROM products').get().c;
    const total=Math.max(1,Math.ceil(count/20));
    const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),total-1);
    const rows=db.prepare('SELECT * FROM products ORDER BY id DESC LIMIT 20 OFFSET ?').all(page*20);
    const components=[];
    for(let offset=0;offset<rows.length;offset+=5) {
      components.push(new ActionRowBuilder().addComponents(...rows.slice(offset,offset+5).map(p=>
        new ButtonBuilder().setCustomId(`admin_edit:${p.id}`)
          .setLabel(`#${p.id} ${p.name} • ${amount(p.price)} • ${p.enabled?'aktif':'nonaktif'}`.slice(0,80))
          .setStyle(ButtonStyle.Secondary)
      )));
    }
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_products:${page-1}`).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(`admin_products:${page+1}`).setLabel('Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(page===total-1),
      new ButtonBuilder().setCustomId('admin_add').setLabel('Tambah').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin_home').setLabel('Panel Admin').setStyle(ButtonStyle.Primary)
    ));
    return {content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Katalog Lokal')
      .setDescription(rows.length?'Tekan tombol produk untuk mengubah nama, negara, layanan, harga, atau status aktif.':'Belum ada produk lokal.')
      .setFooter({text:`Halaman ${page+1}/${total} • ${count} produk lokal`})],components};
  }
  function productModal(product) {
    const modal=new ModalBuilder().setCustomId(product?`admin_save:${product.id}`:'admin_create')
      .setTitle(product?'Edit Produk Lokal':'Tambah Produk Lokal');
    for(const [key,label,value,max] of [
      ['name','Nama produk',product?.name || '',100],
      ['country','Negara (contoh ID)',product?.country || '',40],
      ['service','Layanan (contoh WhatsApp)',product?.service || '',100],
      ['price','Harga IDR (bilangan bulat)',String(product?.price ?? ''),16],
      ['enabled','Status: 1 aktif, 0 nonaktif',String(product?.enabled ?? 1),1]
    ]) {
      const input=new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(max);
      if(value) input.setValue(value);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    return modal;
  }
  return async function handleAdmin(i) {
    const command=i.isChatInputCommand() && i.commandName==='admin';
    if(!command && !String(i.customId || '').startsWith('admin_')) return false;
    if(!isDiscordAdmin(i.user.id)) {
      await i.reply({ephemeral:true,content:'Akses ditolak. ID Discord Anda belum terdaftar sebagai admin toko.'});
      return true;
    }
    if(command) { await i.reply({ephemeral:true,...home()}); return true; }
    if(i.isButton()) {
      if(i.customId==='admin_pricing') {
        const settings=pricing.get();
        await i.showModal(new ModalBuilder().setCustomId('admin_pricing_save').setTitle('Atur Harga Jual Semua Layanan')
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('percent').setLabel('Markup (%) dari harga provider').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.basisPoints/100)).setMaxLength(7)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fee').setLabel('Tambahan tetap IDR (0 jika tidak ada)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.fee)).setMaxLength(7))
          ));
      }
      else if(i.customId.startsWith('admin_edit:')) {
        const p=db.prepare('SELECT * FROM products WHERE id=?').get(i.customId.split(':')[1]);
        if(!p) await i.reply({ephemeral:true,content:'Produk lokal tidak ditemukan.'});
        else await i.showModal(productModal(p));
      }
      else if(i.customId==='admin_add') await i.showModal(productModal());
      else if(i.customId==='admin_home') await i.update(home());
      else if(i.customId==='admin_close') await i.update({content:'Panel admin ditutup. Ketik /admin untuk membukanya kembali.',embeds:[],components:[]});
      else if(i.customId.startsWith('admin_products:')) await i.update(products(Number(i.customId.split(':')[1])));
      else if(i.customId==='admin_health') {
        await i.deferReply({ephemeral:true});
        try {
          const result=await smscode('/balance');
          const balance=result.data?.balance;
          const canonical=balance && typeof balance==='object'?balance.canonical_amount:balance;
          await i.editReply({content:`✅ SMSCode terhubung.\nSaldo provider: ${canonical == null?'Tidak tersedia':amount(canonical)}`});
        } catch {
          await i.editReply({content:'❌ Koneksi SMSCode gagal. Periksa konfigurasi token/API dan coba lagi.'});
        }
      }
      return true;
    }
    if(i.isStringSelectMenu() && i.customId==='admin_edit') {
      const p=db.prepare('SELECT * FROM products WHERE id=?').get(i.values[0]);
      if(!p) await i.reply({ephemeral:true,content:'Produk lokal tidak ditemukan.'});
      else await i.showModal(productModal(p));
      return true;
    }
    if(i.isModalSubmit() && i.customId==='admin_pricing_save') {
      try {
        const settings=pricing.set(i.fields.getTextInputValue('percent'),i.fields.getTextInputValue('fee'));
        await i.reply({ephemeral:true,content:`✅ Harga jual semua layanan: harga provider + ${settings.basisPoints/100}% + ${amount(settings.fee)}. Pecahan dibulatkan ke atas. Contoh provider 5.000 IDR → jual ${amount(pricing.price(5000))}.`,components:home().components});
      }catch(e){await i.reply({ephemeral:true,content:e.message});}
      return true;
    }
    if(i.isModalSubmit() && (i.customId==='admin_create' || i.customId.startsWith('admin_save:'))) {
      let p;
      try { p=parseProduct(i.fields); }
      catch(error) { await i.reply({ephemeral:true,content:error.message}); return true; }
      if(i.customId==='admin_create') {
        db.prepare('INSERT INTO products(name,country,service,price,enabled) VALUES(?,?,?,?,?)')
          .run(p.name,p.country,p.service,p.price,p.enabled);
      } else {
        const result=db.prepare('UPDATE products SET name=?,country=?,service=?,price=?,enabled=? WHERE id=?')
          .run(p.name,p.country,p.service,p.price,p.enabled,i.customId.split(':')[1]);
        if(!result.changes) { await i.reply({ephemeral:true,content:'Produk lokal tidak ditemukan.'}); return true; }
      }
      await i.reply({ephemeral:true,content:'✅ Produk lokal tersimpan.',components:home().components});
      return true;
    }
    await i.reply({ephemeral:true,content:'Menu admin tidak dikenali. Buka /admin kembali.'});
    return true;
  };
}

module.exports={isDiscordAdmin,parseProduct,createAdminHandler};
