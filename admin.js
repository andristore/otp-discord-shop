const {buyerLabel,rememberBuyer,hydrateBuyers}=require('./buyer-profiles');
let staffAccess;
function configureAdminAccess(access) {staffAccess=access;}
function isDiscordAdmin(id, configured=process.env.ADMIN_DISCORD_IDS || '') {
  if(arguments.length<2 && staffAccess)return staffAccess.isAdmin(id);
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

function createManualBalance(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS manual_balance_credits (
    interaction_id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, discord_id TEXT NOT NULL,
    amount INTEGER NOT NULL, note TEXT NOT NULL, balance_after INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  return db.transaction(({interactionId,adminId,buyerId,amount,note})=>{
    if(!interactionId || !/^\d{17,20}$/.test(buyerId) || !Number.isSafeInteger(amount) || amount<5000 || amount>1000000 || !note.trim() || note.length>200) {
      throw new Error('ID pembeli harus ID Discord pengguna. Nominal 5.000–1.000.000 rupiah dan catatan wajib diisi.');
    }
    const previous=db.prepare('SELECT * FROM manual_balance_credits WHERE interaction_id=?').get(interactionId);
    if(previous) {
      if(previous.admin_id!==adminId || previous.discord_id!==buyerId || previous.amount!==amount || previous.note!==note) throw new Error('Data transaksi tidak sesuai.');
      return previous;
    }
    const before=db.prepare('SELECT balance FROM users WHERE discord_id=?').get(buyerId)?.balance || 0;
    if(!Number.isSafeInteger(before+amount)) throw new Error('Saldo melebihi batas penyimpanan.');
    db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(buyerId,amount);
    db.prepare('INSERT INTO manual_balance_credits(interaction_id,admin_id,discord_id,amount,note,balance_after) VALUES(?,?,?,?,?,?)').run(interactionId,adminId,buyerId,amount,note,before+amount);
    return db.prepare('SELECT * FROM manual_balance_credits WHERE interaction_id=?').get(interactionId);
  });
}

function createAdminHandler({discord, db, smscode,pricing,staff,resolveUser,audit=()=>{}}) {
  let creditBalance;
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,
    ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const amount=value=>`${Number(value || 0).toLocaleString('id-ID')} IDR`;
  function menu(title,description,choices,back='admin_home') {
    return {content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle(title).setDescription(description)],components:[
      ...Array.from({length:Math.ceil(choices.length/5)},(_,r)=>new ActionRowBuilder().addComponents(...choices.slice(r*5,r*5+5).map(([id,label,style=ButtonStyle.Primary])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style)))),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(back).setLabel('Kembali').setStyle(ButtonStyle.Secondary))
    ]};
  }
  function section(id) {
    if(id==='admin_catalog_menu')return menu('🏪 Toko','Pilih kategori yang ingin dikelola.\n\n📱 OTP Provider — layanan SMSCode dan markup harga.\n📦 Produk Lainnya — produk digital, stok, dan harga jual.\n🎟️ Promo — voucher diskon.',[
      ['admin_catalog_provider','📱 OTP Provider'],['admin_catalog_manual','📦 Produk Lainnya'],['admin_catalog_promo','🎟️ Promo']]);
    if(id==='admin_catalog_provider')return menu('📱 OTP Provider','Periksa katalog SMSCode atau atur markup harga jual OTP.',[
      ['provider_catalog','Lihat Layanan',ButtonStyle.Secondary],['admin_pricing','Atur Harga OTP']], 'admin_catalog_menu');
    if(id==='admin_catalog_manual')return menu('📦 Produk Lainnya','Pilih Kelola Produk untuk menambah produk, mengubah data, stok, harga jual, status, atau menghapus produk.',[
      ['admin_manual_catalog:0','Kelola Produk']], 'admin_catalog_menu');
    if(id==='admin_catalog_promo')return menu('🎟️ Promo','Buat voucher dan atur status promo toko.',[
      ['admin_tools_coupons:0','Kelola Voucher']], 'admin_catalog_menu');
    if(id==='admin_balance_menu')return menu('👥 Pembeli','Akun, saldo, dan bantuan pembeli.',[
      ['admin_balances:0','Daftar Saldo'],['admin_ops_buyer','Cari Pembeli'],['admin_balance_add','Tambah Saldo'],['admin_balance_history','Riwayat Saldo Manual'],['admin_tools_tickets:0','Tiket Bantuan']]);
    if(id==='admin_transactions_menu')return menu('💳 Pembayaran','Verifikasi pembayaran dan pengajuan.',[
      ['admin_manual_orders:0','Pesanan Produk Manual'],['admin_store_requests:0','Pengajuan Manual'],['admin_payment_issues','Perlu Diperiksa'],['admin_tools_reconcile','Cek Topup Tertunda'],['admin_topup_history','Riwayat Isi Saldo'],['admin_direct_history','Riwayat QRIS Beli'],['admin_ops_manual','Petunjuk Bayar Manual']]);
    if(id==='admin_reports_menu')return menu('📊 Laporan','Penjualan, biaya, dan ekspor CSV.',[
      ['admin_tools_report:day','Hari Ini'],['admin_tools_report:month','Bulan Ini'],['admin_tools_fees:0','Riwayat Biaya Gateway']]);
    if(id==='admin_system_menu')return menu('🛠️ Sistem','Pilih kategori pengaturan bot.',[
      ['admin_system_access','Akses Bot'],['admin_system_provider','Provider & Webhook'],['admin_system_data','Data & Pemeliharaan']]);
    if(id==='admin_system_access')return menu('🔐 Akses Bot','Kelola admin serta izin server, channel, dan role pengguna bot.',[
      ['admin_staff_access','Admin Toko'],['admin_ops_server_menu','Server & Channel']], 'admin_system_menu');
    if(id==='admin_system_provider')return menu('📱 Provider & Webhook','Saldo, pembelian owner, tes webhook, dan peringatan provider.',[
      ['admin_health','Saldo Provider (Owner)'],['admin_test_otp','Beli OTP Provider (Owner)'],['admin_smscode_webhook_test','Tes Webhook SMSCode'],['admin_ops_low','Peringatan Saldo']], 'admin_system_menu');
    if(id==='admin_system_data')return menu('🗂️ Data & Pemeliharaan','Backup data, aktivitas admin, dan status operasional toko.',[
      ['admin_tools_backup','Backup (Owner)'],['admin_tools_audit:0','Aktivitas Admin'],['admin_store_maintenance','Maintenance']], 'admin_system_menu');
  }
  async function buyerBalances(requested=0,filter="all") {
    if(!["all","positive","zero"].includes(filter))throw Error("Filter saldo tidak dikenal.");
    const where=filter==="positive"?" WHERE balance>0":filter==="zero"?" WHERE balance=0":"";
    const title={all:"Semua akun",positive:"Memiliki saldo",zero:"Saldo nol"}[filter];
    const summary=db.prepare('SELECT COUNT(*) count, COALESCE(SUM(balance),0) total, COALESCE(SUM(CASE WHEN balance>0 THEN 1 ELSE 0 END),0) funded FROM users').get();
    const pages=Math.max(1,Math.ceil(db.prepare("SELECT COUNT(*) n FROM users"+where).get().n/10));
    const page=Math.min(Math.max(Number.isSafeInteger(requested)?requested:0,0),pages-1);
    const rows=db.prepare('SELECT discord_id,balance FROM users'+where+' ORDER BY balance DESC, discord_id ASC LIMIT 10 OFFSET ?').all(page*10);
    await hydrateBuyers(rows.map(r=>r.discord_id));
    return {content:'',allowedMentions:{parse:[]},embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('💰 Daftar Saldo Pembeli')
      .setDescription(`Total saldo akun: **${amount(summary.total)}**\nJumlah akun: **${summary.count}** • Memiliki saldo: **${summary.funded}**\nTampilan: **${title}**\n\n${rows.length?rows.map((r,n)=>`${page*10+n+1}. ${buyerLabel(r.discord_id,false)}\nID: ${r.discord_id}\nSaldo: **${amount(r.balance)}**`).join('\n\n'):(filter==='all'?'Belum ada akun pembeli tersimpan.':'Belum ada akun pada filter ini.')}`)
      .setFooter({text:`Halaman ${page+1}/${pages} • ${db.prepare("SELECT COUNT(*) n FROM users"+where).get().n} akun • Urutan saldo terbesar`})],components:[new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`admin_balances:${page-1}:${filter}`).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
        new ButtonBuilder().setCustomId(`admin_balances:${page+1}:${filter}`).setLabel('Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(page===pages-1),
        new ButtonBuilder().setCustomId(`admin_balances:${page}:${filter}`).setLabel('Perbarui').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin_balance_menu').setLabel('Kembali').setStyle(ButtonStyle.Secondary)
      ),new ActionRowBuilder().addComponents(...[['all','Semua Akun'],['positive','Memiliki Saldo'],['zero','Saldo Nol']].map(([key,label])=>new ButtonBuilder().setCustomId('admin_balances:0:'+key+':filter').setLabel(label).setStyle(ButtonStyle.Primary).setDisabled(filter===key)))]};
  }
  function home() {
    return {content:'',embeds:[new EmbedBuilder().setColor(0x5865F2).setTitle('⚙️ Panel Admin')
      .setDescription('Pilih kategori untuk mengelola Hi, Belanja Produk Digital Yukk.')],components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_catalog_menu').setLabel('Toko').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('admin_balance_menu').setLabel('Pembeli').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin_transactions_menu').setLabel('Pembayaran').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin_reports_menu').setLabel('Laporan').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('admin_system_menu').setLabel('Sistem').setStyle(ButtonStyle.Primary)
      ),new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_eff_summary').setLabel('Ringkasan').setStyle(ButtonStyle.Primary),
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
    if(['admin_test_otp','admin_health'].includes(i.customId)&&staff&&!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Hanya owner dapat melihat saldo dan membeli langsung dari provider.'});return true;}
    if(i.isButton()) {
      if(i.customId==='admin_test_otp'){
        await i.reply({ephemeral:true,content:'**Tes Pembelian OTP — Admin**\n\nTes menggunakan nomor SMSCode sungguhan. Pilih aplikasi, negara, operator, dan produk; harga ditampilkan sebelum Anda mengonfirmasi pembayaran.\n\nPembayaran memakai saldo akun admin atau QRIS yang tersedia. Saldo provider SMSCode juga harus cukup. Menekan Mulai Tes belum membeli nomor.\n\nSetelah order berhasil, gunakan nomor pada layanan yang dipilih untuk meminta SMS. Bot akan memperbarui status/OTP melalui webhook atau polling cadangan, lalu mengirim OTP ke DM akun admin yang membeli.\n\nOrder tetap tercatat di Riwayat OTP dan Riwayat Pesanan. Ini bukan transaksi gratis/simulasi; aturan pembatalan dan refund biasa tetap berlaku.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop_products').setLabel('Mulai Tes Pembelian OTP').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('admin_system_menu').setLabel('Kembali').setStyle(ButtonStyle.Primary))]});return true;
      }
      if(i.customId.startsWith('admin_balances:')) {
        await i.update(await buyerBalances(Number(i.customId.split(':')[1]),i.customId.split(':')[2]||'all'));return true;
      }
      if(['admin_catalog_menu','admin_catalog_provider','admin_catalog_manual','admin_catalog_promo','admin_balance_menu','admin_transactions_menu','admin_reports_menu','admin_system_menu','admin_system_access','admin_system_provider','admin_system_data'].includes(i.customId)) {
        await i.update(section(i.customId));return true;
      }
      if(i.customId==='admin_topup_history' || i.customId==='admin_direct_history') {
        const topup=i.customId==='admin_topup_history';
        const rows=db.prepare(topup?"SELECT * FROM topups WHERE purpose='topup' ORDER BY created_at DESC,rowid DESC LIMIT 5":"SELECT * FROM direct_purchases ORDER BY created_at DESC,rowid DESC LIMIT 5").all();
        await hydrateBuyers(rows.map(r=>r.discord_id));
        const title=topup?'Riwayat Isi Saldo QRIS':'Riwayat QRIS Beli';
        const content=rows.length?rows.map(r=>topup?`Tagihan: ${r.order_id}\nPembeli: ${buyerLabel(r.discord_id)}\nSaldo: ${amount(r.amount)} • Status: ${r.status}\nSaldo masuk: ${r.credited?'Ya':'Belum'} • ${r.created_at} UTC`:`Tagihan: ${r.invoice_id}\nPembeli: ${buyerLabel(r.discord_id)}\nHarga: ${amount(r.amount)} • Status: ${r.state}\nOrder: ${r.provider_order_id || '-'} • ${r.created_at} UTC`).join('\n\n'):'Belum ada transaksi.';
        await i.reply({ephemeral:true,content:`**${title} — 5 transaksi terakhir**\n\n${content}`,allowedMentions:{parse:[]},components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('admin_home').setLabel('Panel Admin').setStyle(ButtonStyle.Primary))]});return true;
      }
      if(i.customId==='admin_balance_add') {
        const modal=new ModalBuilder().setCustomId('admin_balance_save').setTitle('Tambah Saldo Pembeli');
        for(const [key,label,max] of [['buyer','ID Discord pengguna pembeli',20],['amount','Nominal rupiah (minimal 5000, tanpa titik)',7],['note','Catatan / referensi pembayaran',200]]) {
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max)));
        }
        await i.showModal(modal);return true;
      }
      if(i.customId==='admin_balance_history') {
        creditBalance ||= createManualBalance(db);
        const rows=db.prepare('SELECT * FROM manual_balance_credits ORDER BY created_at DESC, rowid DESC LIMIT 4').all();
        await hydrateBuyers(rows.map(r=>r.discord_id));
        await i.reply({ephemeral:true,content:rows.length?rows.map(r=>`Pembeli: ${buyerLabel(r.discord_id)}\nTambah: ${amount(r.amount)} • Saldo setelah transaksi: ${amount(r.balance_after)}\nAdmin: ${r.admin_id} • ${r.created_at} UTC\nCatatan: ${r.note}`).join('\n\n'):'Belum ada penambahan saldo manual.',allowedMentions:{parse:[]}});return true;
      }
      if(i.customId==='admin_payment_issues') {
        const rows=db.prepare("SELECT * FROM direct_purchases WHERE state='review' ORDER BY created_at DESC LIMIT 5").all();
        await hydrateBuyers(rows.map(r=>r.discord_id));
        await i.reply({ephemeral:true,content:rows.length?rows.map(r=>`Tagihan: ${r.invoice_id}\nPembeli: ${buyerLabel(r.discord_id)}\nProduk: ${r.product_id} • ${amount(r.amount)}\nOrder provider: ${r.provider_order_id || 'Belum diketahui'}\n${r.error}`).join('\n\n'):'Tidak ada pembayaran yang perlu diperiksa.'});return true;
      }
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
    if(i.isModalSubmit() && i.customId==='admin_balance_save') {
      await i.deferReply({ephemeral:true});
      try {
        const buyerId=i.fields.getTextInputValue('buyer').trim();
        const raw=i.fields.getTextInputValue('amount').trim();
        const note=i.fields.getTextInputValue('note').trim();
        if(!/^\d{17,20}$/.test(buyerId) || !/^\d+$/.test(raw) || Number(raw)<5000 || Number(raw)>1000000 || !note || note.length>200) throw new Error('Isi ID Discord pengguna pembeli, nominal 5.000–1.000.000 tanpa titik/koma, dan catatan.');
        let buyer;
        try {buyer=await resolveUser(buyerId);} catch {throw new Error('Pengguna Discord tidak dapat diperiksa. Periksa ID pembeli dan coba lagi.');}
        if(!buyer || buyer.bot) throw new Error('ID tersebut bukan pengguna pembeli. Gunakan ID akun pengguna, bukan bot/server/channel.');
        if(!isDiscordAdmin(i.user.id))throw new Error('Akses admin sudah dicabut.');
        rememberBuyer(buyer);
        creditBalance ||= createManualBalance(db);
        const result=creditBalance({interactionId:i.id,adminId:i.user.id,buyerId,amount:Number(raw),note});
        await i.editReply({content:`✅ Saldo pembeli ${buyerLabel(buyerId)} ditambah ${amount(result.amount)}.\nSaldo setelah transaksi: ${amount(result.balance_after)}\nCatatan: ${note}`,allowedMentions:{parse:[]}});
      } catch(error) {await i.editReply({content:error.message,allowedMentions:{parse:[]}});}
      return true;
    }
    if(i.isModalSubmit() && i.customId==='admin_pricing_save') {
      try {
        const settings=pricing.set(i.fields.getTextInputValue('percent'),i.fields.getTextInputValue('fee'));
        audit(i.user.id,'Ubah harga jual: '+settings.basisPoints/100+'% + '+settings.fee+' IDR');
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
      audit(i.user.id,'Simpan produk lokal '+p.name+' ('+p.price+' IDR)');
      await i.reply({ephemeral:true,content:'✅ Produk lokal tersimpan.',components:home().components});
      return true;
    }
    await i.reply({ephemeral:true,content:'Menu admin tidak dikenali. Buka /admin kembali.'});
    return true;
  };
}

module.exports={isDiscordAdmin,configureAdminAccess,parseProduct,createAdminHandler,createManualBalance};
