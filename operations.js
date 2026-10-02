function createOperations({db,smscode,smsOrder,smsCancel,payments,env=process.env,sendDM,now=()=>Date.now(),staff}) {
  db.exec(`CREATE TABLE IF NOT EXISTS shop_operations_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_resolutions(invoice_id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,provider_order_id TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS admin_settings_audit(id INTEGER PRIMARY KEY,admin_id TEXT NOT NULL,setting TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const columns=db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name);
  for(const name of ['otp_notified','otp_polled_at'])if(!columns.includes(name))db.exec(`ALTER TABLE orders ADD COLUMN ${name} TEXT`);
  // A restart during reconciliation returns to review without repeating financial actions.
  db.prepare("UPDATE direct_purchases SET state='review',error='Resolusi terputus saat restart. Periksa catatan dan order provider sebelum melanjutkan.' WHERE state='resolving'").run();
  const read=(key,fallback)=>db.prepare('SELECT value FROM shop_operations_settings WHERE key=?').get(key)?.value ?? fallback;
  const write=(key,value)=>db.prepare('INSERT INTO shop_operations_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
  const settings=()=>({manual:read('manual_instructions',env.MANUAL_TOPUP_INSTRUCTIONS || ''),lowThreshold:Number(read('low_threshold','10000')),lowEnabled:read('low_enabled','1')==='1'});
  function saveManual(adminId,text) {
    if(staff && !staff.isAdmin(adminId))throw new Error('Akses admin sudah dicabut.');
    text=String(text).trim();if(text.length>1100)throw new Error('Petunjuk maksimal 1.100 karakter.');
    db.transaction(()=>{write('manual_instructions',text);db.prepare('INSERT INTO admin_settings_audit(admin_id,setting) VALUES(?,?)').run(adminId,'Pembayaran manual');})();
  }
  function saveLow(adminId,threshold,enabled) {
    if(staff && !staff.isAdmin(adminId))throw new Error('Akses admin sudah dicabut.');
    if(!/^\d+$/.test(String(threshold)) || !Number.isSafeInteger(Number(threshold)) || Number(threshold)>100000000 || !['0','1'].includes(enabled))throw new Error('Batas saldo 0–100.000.000 rupiah; status 1 aktif atau 0 nonaktif.');
    db.transaction(()=>{write('low_threshold',threshold);write('low_enabled',enabled);write('low_notified','');db.prepare('INSERT INTO admin_settings_audit(admin_id,setting) VALUES(?,?)').run(adminId,'Peringatan saldo provider');})();
  }
  function buyer(id) {
    if(!/^\d{17,20}$/.test(id))throw new Error('Masukkan ID Discord pengguna yang benar.');
    const account=db.prepare('SELECT * FROM users WHERE discord_id=?').get(id);
    if(!account)return null;
    return {account,orders:db.prepare('SELECT * FROM orders WHERE discord_id=? ORDER BY id DESC LIMIT 3').all(id),topups:db.prepare("SELECT * FROM topups WHERE discord_id=? AND purpose='topup' ORDER BY created_at DESC,rowid DESC LIMIT 3").all(id)};
  }
  let otpBusy=false,lowBusy=false,lastLow=-Infinity;
  async function pollOTP() {
    if(otpBusy || !sendDM)return;otpBusy=true;
    try {
      const rows=db.prepare("SELECT * FROM orders WHERE provider_order_id IS NOT NULL AND refunded=0 AND (status IN ('ACTIVE','OTP_RECEIVED','pending') OR (otp IS NOT NULL AND COALESCE(otp_notified,'')<>otp)) ORDER BY COALESCE(otp_polled_at,'') ASC,id ASC LIMIT 10").all();
      for(const row of rows) {
        db.prepare('UPDATE orders SET otp_polled_at=? WHERE id=?').run(new Date(now()).toISOString(),row.id);
        try {
          if(['ACTIVE','OTP_RECEIVED','pending'].includes(row.status)) {
            const d=(await smsOrder(row.provider_order_id)).data;
            if(!d || String(d.id)!==String(row.provider_order_id))continue;
            db.prepare('UPDATE orders SET otp=COALESCE(?,otp),status=?,phone=COALESCE(?,phone) WHERE id=? AND refunded=0').run(d.otp_code || null,d.status || row.status,d.phone_number || null,row.id);
          }
          const latest=db.prepare('SELECT * FROM orders WHERE id=?').get(row.id);
          if(!latest.refunded && latest.otp && latest.otp_notified!==latest.otp) {
            await sendDM(latest.discord_id,`🔢 Hi, OTP Sms Virtual — OTP masuk\nOrder: ${latest.provider_order_id}\nNomor: ${latest.phone || '-'}\nOTP: ${latest.otp}\nGunakan kode pada layanan yang Anda beli.`);
            db.prepare('UPDATE orders SET otp_notified=? WHERE id=?').run(latest.otp,latest.id);
          }
        }catch { /* Keep unsent OTP for a later DM retry and the buyer's Cek OTP button. */ }
      }
    }finally{otpBusy=false;}
  }
  async function pollLow(force=false) {
    if(lowBusy || !sendDM || (!force && now()-lastLow<300000))return;
    lowBusy=true;lastLow=now();
    try {
      const s=settings();if(!s.lowEnabled)return;
      const result=await smscode('/balance');const b=result.data?.balance;
      const balance=Number(b && typeof b==='object'?b.canonical_amount:b);
      if(b==null || !Number.isSafeInteger(balance) || balance<0)throw new Error('Saldo provider tidak valid.');
      if(balance>=s.lowThreshold){write('low_notified','');return;}
      const notified=new Set(read('low_notified','').split(',').filter(Boolean));
      const admins=staff?staff.ids():[...new Set((env.ADMIN_DISCORD_IDS || '').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x)))];
      for(const id of admins)if(!notified.has(id)) {
        try{await sendDM(id,`⚠️ Hi, OTP Sms Virtual — saldo SMSCode menipis\nSaldo: ${balance.toLocaleString('id-ID')} IDR\nBatas peringatan: ${s.lowThreshold.toLocaleString('id-ID')} IDR\nIsi saldo provider agar pesanan dapat diproses.`);notified.add(id);write('low_notified',[...notified].join(','));}catch{}
      }
    }finally{lowBusy=false;}
  }
  const issue=id=>db.prepare('SELECT * FROM direct_purchases WHERE invoice_id=?').get(id);
  function issues(page=0) {
    const count=db.prepare("SELECT COUNT(*) n FROM direct_purchases WHERE state='review'").get().n;
    const pages=Math.max(1,Math.ceil(count/5));page=Math.min(Math.max(Number.isSafeInteger(page)?page:0,0),pages-1);
    return {page,pages,count,rows:db.prepare("SELECT * FROM direct_purchases WHERE state='review' ORDER BY created_at DESC,rowid DESC LIMIT 5 OFFSET ?").all(page*5)};
  }
  async function resolve({invoiceId,adminId,action,orderId,note,confirmation}) {
    if(staff && !staff.isAdmin(adminId))throw new Error('Akses admin sudah dicabut.');
    if(!['attach','refund'].includes(action) || !note?.trim() || note.length>200)throw new Error('Isi catatan pemeriksaan (maksimal 200 karakter).');
    if(confirmation!=='SUDAH DIPERIKSA')throw new Error('Ketik SUDAH DIPERIKSA setelah mencocokkan tagihan dan riwayat SMSCode.');
    const previous=db.prepare('SELECT * FROM admin_resolutions WHERE invoice_id=?').get(invoiceId);
    if(previous)return previous;
    let row=issue(invoiceId);
    if(!row || row.state!=='review')throw new Error('Tagihan bukan transaksi yang perlu diperiksa.');
    // Refresh through authenticated gateway status before any refund or manual fulfillment.
    const paid=await payments.refresh(invoiceId,row.discord_id);
    if(!paid?.credited || !['PAID','settlement'].includes(paid.providerStatus) || paid.purpose!=='purchase' || paid.status!=='settlement' || paid.amount!==row.amount)throw new Error('Pembayaran belum terverifikasi lunas.');
    if(staff && !staff.isAdmin(adminId))throw new Error('Akses admin sudah dicabut.');
    const claim=db.prepare("UPDATE direct_purchases SET state='resolving' WHERE invoice_id=? AND state='review'").run(invoiceId);
    if(!claim.changes)throw new Error('Transaksi sudah diselesaikan atau sedang diperiksa admin lain.');
    try {
      row=issue(invoiceId);orderId=String(orderId || row.provider_order_id || '').trim();
      if(orderId && !/^\d+$/.test(orderId))throw new Error('ID order provider harus angka.');
      if(row.provider_order_id && orderId!==row.provider_order_id)throw new Error('ID order berbeda dari pesanan yang tercatat.');
      let order;
      if(orderId) {
        if(db.prepare('SELECT id FROM orders WHERE provider_order_id=?').get(orderId) || db.prepare('SELECT invoice_id FROM direct_purchases WHERE provider_order_id=? AND invoice_id<>?').get(orderId,invoiceId))throw new Error('Order sudah terhubung ke transaksi lain.');
        order=(await smsOrder(orderId)).data;
        if(!order || String(order.id)!==orderId || Number(order.product_id)!==row.product_id)throw new Error('Order provider tidak cocok dengan produk tagihan.');
      }
      if(action==='attach') {
        if(!order || !order.phone_number || !['ACTIVE','OTP_RECEIVED','COMPLETED'].includes(order.status) || Number(order.amount?.canonical_amount ?? order.amount)!==row.provider_amount || (order.operator_id==null?null:String(order.operator_id))!==(row.operator_id==null?null:String(row.operator_id)))throw new Error('Order harus aktif/sudah menerima OTP, dengan harga dan operator sesuai tagihan.');
      } else if(order) {
        if(order.otp_code || ['OTP_RECEIVED','COMPLETED'].includes(order.status))throw new Error('Order sudah menerima OTP; refund ditolak. Gunakan Hubungkan Pesanan.');
        db.prepare("UPDATE direct_purchases SET provider_order_id=? WHERE invoice_id=? AND state='resolving'").run(orderId,invoiceId);
        if(order.status==='ACTIVE') {
          await smsCancel(orderId);order=(await smsOrder(orderId)).data;
        }
        if(!order || String(order.id)!==orderId || order.otp_code || !['CANCELED','EXPIRED'].includes(order.status))throw new Error('Pembatalan/berakhirnya order belum terkonfirmasi; saldo belum dikembalikan.');
      }
      db.transaction(()=>{
        if(staff && !staff.isAdmin(adminId))throw new Error('Akses admin sudah dicabut.');
        if(orderId && (db.prepare('SELECT id FROM orders WHERE provider_order_id=?').get(orderId) || db.prepare('SELECT invoice_id FROM direct_purchases WHERE provider_order_id=? AND invoice_id<>?').get(orderId,invoiceId)))throw new Error('Order sudah terhubung ke transaksi lain.');
        if(action==='attach') {
          db.prepare('INSERT INTO orders(discord_id,product_id,provider_order_id,phone,otp,amount,provider_amount,status) VALUES(?,?,?,?,?,?,?,?)').run(row.discord_id,row.product_id,orderId,order.phone_number,order.otp_code || null,row.amount,row.provider_amount,order.status);
          if(row.voucher_code)db.prepare('UPDATE orders SET voucher_code=?,discount_amount=?,original_amount=? WHERE provider_order_id=?').run(row.voucher_code,row.discount_amount,row.original_amount,orderId);
        } else {
          const before=db.prepare('SELECT balance FROM users WHERE discord_id=?').get(row.discord_id)?.balance || 0;
          if(!Number.isSafeInteger(before+row.amount))throw new Error('Saldo melebihi batas penyimpanan.');
          db.prepare('INSERT INTO users(discord_id,balance) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance=balance+excluded.balance').run(row.discord_id,row.amount);
        }
        const changed=db.prepare("UPDATE direct_purchases SET state=?,provider_order_id=?,error=?,notified=0 WHERE invoice_id=? AND state='resolving'").run(action==='attach'?'fulfilled':'refunded',orderId || null,action==='refund'?'Admin mengembalikan harga produk ke saldo bot.':null,invoiceId);
        if(!changed.changes)throw new Error('Status transaksi berubah; resolusi dibatalkan.');
        db.prepare('INSERT INTO admin_resolutions(invoice_id,admin_id,action,note,provider_order_id) VALUES(?,?,?,?,?)').run(invoiceId,adminId,action,note.trim(),orderId || null);
      })();
      return db.prepare('SELECT * FROM admin_resolutions WHERE invoice_id=?').get(invoiceId);
    }catch(e){db.prepare("UPDATE direct_purchases SET state='review',error=? WHERE invoice_id=? AND state='resolving'").run(String(e.message).slice(0,500),invoiceId);throw e;}
  }
  return {settings,saveManual,saveLow,buyer,issue,issues,resolve,pollOTP,pollLow};
}

function createOperationsHandler({discord,ops}) {
  const {EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,ModalBuilder,TextInputBuilder,TextInputStyle}=discord;
  const money=n=>`${Number(n).toLocaleString('id-ID')} IDR`;
  const buttons=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary)));
  function modal(id,title,fields) {
    const m=new ModalBuilder().setCustomId(id).setTitle(title);
    for(const [key,label,max,value='',paragraph=false,required=true] of fields) {
      const input=new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(paragraph?TextInputStyle.Paragraph:TextInputStyle.Short).setMaxLength(max).setRequired(required);
      if(value)input.setValue(value);m.addComponents(new ActionRowBuilder().addComponents(input));
    }return m;
  }
  return async function handler(i) {
    const id=String(i.customId || '');
    if(!id.startsWith('admin_ops_') && id!=='admin_payment_issues')return false;
    if(!require('./admin').isDiscordAdmin(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Fitur ini hanya untuk admin toko.'});return true;}
    if(i.isButton()) {
      if(id==='admin_ops_manual') {
        await i.showModal(modal('admin_ops_manual_save','Pengaturan Pembayaran Manual',[
          ['instructions','Rekening, penerima, dan petunjuk pembayaran',1100,ops.settings().manual,true,false]]));return true;
      }
      if(id==='admin_ops_low') {
        const s=ops.settings();await i.showModal(modal('admin_ops_low_save','Peringatan Saldo Provider',[
          ['threshold','Peringatkan jika saldo di bawah (IDR)',9,String(s.lowThreshold)],['enabled','Status: 1 aktif, 0 nonaktif',1,s.lowEnabled?'1':'0']]));return true;
      }
      if(id==='admin_ops_buyer') {await i.showModal(modal('admin_ops_buyer_find','Cari Pembeli',[['buyer','ID Discord pengguna pembeli',20]]));return true;}
      if(id.startsWith('admin_ops_attach:') || id.startsWith('admin_ops_refund:')) {
        const invoice=id.split(':')[1],r=ops.issue(invoice);
        if(!r || r.state!=='review'){await i.reply({ephemeral:true,content:'Tagihan sudah diselesaikan atau tidak ditemukan.'});return true;}
        const attach=id.startsWith('admin_ops_attach:');
        await i.showModal(modal(`admin_ops_resolve:${attach?'attach':'refund'}:${invoice}`,attach?'Hubungkan Pesanan Provider':'Kembalikan ke Saldo Pembeli',[
          ['order','ID order SMSCode (kosong jika tidak ada)',20,r.provider_order_id || '',false,attach || Boolean(r.provider_order_id)],
          ['note','Catatan bukti pemeriksaan',200,'',true],['confirm','Ketik SUDAH DIPERIKSA',20]]));return true;
      }
    }
    await i.deferReply({ephemeral:true});
    try {
      if(id==='admin_ops_manual_save') {ops.saveManual(i.user.id,i.fields.getTextInputValue('instructions'));await i.editReply({content:'✅ Petunjuk pembayaran manual tersimpan. Pembeli melihatnya saat Isi Saldo → Manual.'});}
      else if(id==='admin_ops_low_save') {ops.saveLow(i.user.id,i.fields.getTextInputValue('threshold').trim(),i.fields.getTextInputValue('enabled').trim());await i.editReply({content:'✅ Pengaturan peringatan saldo tersimpan. Peringatan dikirim melalui DM admin.'});}
      else if(id==='admin_ops_buyer_find') {
        const buyerId=i.fields.getTextInputValue('buyer').trim(),r=ops.buyer(buyerId);
        await i.editReply({content:r?`Pembeli: <@${buyerId}>\nID: ${buyerId}\nSaldo: **${money(r.account.balance)}**\n\n**Pesanan terakhir**\n${r.orders.map(o=>`#${o.provider_order_id} • ${money(o.amount)} • ${o.status}`).join('\n') || 'Belum ada.'}\n\n**Isi saldo QRIS terakhir**\n${r.topups.map(t=>`${money(t.amount)} • ${t.status}`).join('\n') || 'Belum ada.'}`:'Akun pembeli belum tersimpan.',allowedMentions:{parse:[]}});
      } else if(id==='admin_payment_issues' || id.startsWith('admin_ops_issues:')) {
        const r=ops.issues(Number(id.split(':')[1]) || 0);
        const components=r.rows.length?[buttons(r.rows.map(x=>['admin_ops_issue:'+x.invoice_id,`${money(x.amount)} • ${x.discord_id}`]))]:[];
        const nav=buttons([[`admin_ops_issues:${r.page-1}`,'Sebelumnya'],[`admin_ops_issues:${r.page+1}`,'Berikutnya'],['admin_transactions_menu','Kembali']]);nav.components[0].setDisabled(r.page===0);nav.components[1].setDisabled(r.page===r.pages-1);components.push(nav);
        await i.editReply({content:`**Pembayaran Perlu Diperiksa**\nHalaman ${r.page+1}/${r.pages} • ${r.count} transaksi\n${r.count?'Pilih transaksi untuk memeriksa dan menyelesaikan.':'Tidak ada transaksi bermasalah.'}`,components});
      } else if(id.startsWith('admin_ops_issue:')) {
        const r=ops.issue(id.split(':')[1]);if(!r)throw new Error('Tagihan tidak ditemukan.');
        await i.editReply({content:`Tagihan: ${r.invoice_id}\nPembeli: ${r.discord_id}\nHarga jual: ${money(r.amount)}\nBiaya provider: ${money(r.provider_amount)}\nOrder provider: ${r.provider_order_id || 'Belum diketahui'}\nStatus: ${r.state}\n${r.error || ''}\n\nPeriksa pembayaran gateway dan riwayat SMSCode. Hubungkan hanya order yang benar milik transaksi ini. Untuk refund tanpa ID order, pastikan di riwayat SMSCode tidak ada order berhasil/masih aktif. Refund hanya harga produk ke saldo bot; biaya QRIS tidak termasuk.`,allowedMentions:{parse:[]},components:r.state==='review'?[buttons([['admin_ops_attach:'+r.invoice_id,'Hubungkan Pesanan'],['admin_ops_refund:'+r.invoice_id,'Refund ke Saldo'],['admin_payment_issues','Kembali']])]:[buttons([['admin_payment_issues','Kembali']])]});
      } else if(id.startsWith('admin_ops_resolve:')) {
        const [,action,invoiceId]=id.split(':');
        const r=await ops.resolve({invoiceId,action,adminId:i.user.id,orderId:i.fields.getTextInputValue('order').trim(),note:i.fields.getTextInputValue('note').trim(),confirmation:i.fields.getTextInputValue('confirm').trim()});
        await i.editReply({content:r.action==='attach'?'✅ Pesanan provider dihubungkan ke pembeli.':'✅ Harga produk dikembalikan ke saldo pembeli.',components:[buttons([['admin_payment_issues','Kembali']])]});
      } else throw new Error('Menu tidak dikenali. Buka /admin kembali.');
    }catch(e){await i.editReply({content:e.message,embeds:[],components:[]});}
    return true;
  };
}
module.exports={createOperations,createOperationsHandler};
