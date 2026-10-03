// One policy for visible buttons and direct/old interaction submissions.
function ownerOnly(id) {
  id=String(id||'');
  return /^(provider_|admin_owner_|admin_df_|admin_smscode_webhook|admin_ops_low|admin_store_maintenance|admin_tools_(backup|report|csv|fee|audit)|admin_healthcheck_(midtrans|invoice|callbacks|errors|alerts|refund))/.test(id)
    || ['admin_digiflazz','admin_health','admin_test_otp','admin_system_provider','admin_catalog_provider','admin_reports_menu','admin_healthcheck','admin_healthcheck_dm','admin_ops_manual','admin_ops_manual_save','admin_store_maintenance'].includes(id);
}
function privateMenu(payload,isOwner) {
  if(isOwner||!payload||typeof payload!=='object'||!Array.isArray(payload.components))return payload;
  return {...payload,components:payload.components.map(row=>{
    const data=typeof row.toJSON==='function'?row.toJSON():row;
    return {...data,components:(data.components||[]).filter(item=>!ownerOnly(item.custom_id||item.customId))};
  }).filter(row=>row.components.length)};
}
async function protectOwnerInteraction(i,staff) {
  if(ownerOnly(i.customId)&&!staff.isOwner(i.user.id)) {
    await i.reply({ephemeral:true,content:'Akses ditolak. Fitur privat ini khusus owner toko.'});return true;
  }
  for(const method of ['reply','editReply','update'])if(typeof i[method]==='function') {
    const original=i[method].bind(i);
    i[method]=payload=>original(privateMenu(payload,staff.isOwner(i.user.id)));
  }
  return false;
}
module.exports={ownerOnly,privateMenu,protectOwnerInteraction};
