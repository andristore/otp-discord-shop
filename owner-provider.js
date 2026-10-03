function createOwnerProviderHandler({discord,staff,commerce,smscode,smsCatalogProducts}){
  const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=discord;
  const row=choices=>new ActionRowBuilder().addComponents(...choices.map(([id,label])=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Primary)));
  const money=n=>Number(n).toLocaleString('id-ID')+' IDR';
  return async i=>{
    const id=String(i.customId||'');
    if(!['admin_test_otp','admin_health'].includes(id)&&!id.startsWith('admin_owner_'))return false;
    if(!staff.isOwner(i.user.id)){await i.reply({ephemeral:true,content:'Akses ditolak. Saldo dan pembelian langsung provider hanya untuk owner toko.'});return true;}
    await i.deferReply({ephemeral:true});
    try{
      if(id==='admin_test_otp'||id==='admin_health'){
        const r=await smscode('/balance'),b=Number(r.data?.balance?.canonical_amount??r.data?.balance);
        if(!Number.isSafeInteger(b)||b<0)throw Error('Saldo SMSCode tidak tersedia.');
        await i.editReply({content:`**Saldo Provider — Owner**\nSaldo SMSCode: **${money(b)}**\n\nPembelian khusus owner menggunakan saldo SMSCode langsung, tanpa memotong saldo pembeli atau membuat tagihan QRIS. Harga provider ditampilkan sebelum konfirmasi. Nomor sungguhan tetap berbayar.\nOTP dikirim ke DM owner dan pesanan tercatat dengan label [OWNER]; tidak dihitung sebagai penjualan pelanggan.`,components:[row([['provider_catalog','Pilih OTP untuk Dibeli'],['admin_system_menu','Kembali']])]});
      }else if(id.startsWith('admin_owner_quote:')){
        const [,pid,app,country,operator]=id.split(':');
        if(![pid,app,country].every(v=>/^\d+$/.test(v||''))||!(/^(any|\d+)$/.test(operator||'')))throw Error('Pilihan produk tidak valid.');
        const r=await smsCatalogProducts({platform_id:app,country_id:country,...(operator==='any'?{}:{operator_id:operator})});
        const p=r.data.find(p=>String(p.id)===pid&&String(p.platform_id)===app&&String(p.country_id)===country&&(p.operator_id==null?'any':String(p.operator_id))===operator);
        if(!p||!p.active||Number(p.available)<=0)throw Error('Produk tidak tersedia. Pilih produk kembali.');
        const q=commerce.ownerQuote(i.user.id,p);
        await i.editReply({content:`**Konfirmasi Pembelian Owner**\nProduk: ${p.name}\nBiaya saldo provider: **${money(q.providerAmount)}**\nSaldo pembeli tidak dipotong. Konfirmasi berlaku 5 menit.\nTekan konfirmasi untuk membeli nomor sungguhan.`,allowedMentions:{parse:[]},components:[row([['admin_owner_buy:'+q.token,'Konfirmasi — Bayar Saldo Provider'],['provider_catalog','Kembali']])]});
      }else if(id.startsWith('admin_owner_buy:')){
        const r=await commerce.ownerBuy(i.user.id,id.split(':')[1]);
        await i.editReply({content:`✅ **Pembelian Owner Berhasil**\nOrder: ${r.order.id}\nNomor: ${r.order.phone_number}\nBiaya provider: ${money(r.providerAmount)}\nSaldo pembeli tidak dipotong. Gunakan nomor untuk meminta SMS pada aplikasi yang dipilih; OTP dikirim ke DM Anda.`,components:[row([['check_otp:'+r.order.id,'Cek OTP'],['cancel_order:'+r.order.id,'Batalkan'],['admin_test_otp','Saldo Provider']])]});
      }else throw Error('Menu owner tidak dikenali.');
    }catch(e){await i.editReply({content:e.message,allowedMentions:{parse:[]},components:[row([['admin_test_otp','Kembali ke Provider']])]});}
    return true;
  };
}
module.exports={createOwnerProviderHandler};
