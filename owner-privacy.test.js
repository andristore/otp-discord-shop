const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ownerOnly,privateMenu,protectOwnerInteraction}=require('./owner-privacy');
test('private provider, gateway, backup and financial routes include old buttons and modal saves',()=>{
 for(const id of ['provider_catalog','provider_product:1','admin_health','admin_test_otp','admin_owner_buy:1','admin_digiflazz','admin_df_settings_save','admin_system_provider','admin_smscode_webhook_test','admin_smscode_webhook_save','admin_ops_low','admin_ops_low_save','admin_reports_menu','admin_tools_csv:month','admin_tools_fee_update:1','admin_tools_backup_download','admin_tools_audit:0','admin_healthcheck','admin_healthcheck_errors','admin_healthcheck_midtrans_test_save','admin_healthcheck_callbacks:0','admin_healthcheck_invoice_save','admin_healthcheck_refund_save:1','admin_ops_manual_save','admin_store_maintenance','admin_store_maintenance:on','admin_store_maintenance:off'])assert.equal(ownerOnly(id),true,id);
 for(const id of ['shop_games','df_buy:1','admin_manual_catalog:0','admin_manual_orders:0','admin_balance_add','admin_buyers_menu','admin_payment_requests','admin_healthcheck_overdue:0','admin_healthcheck_stock:0','admin_tools_tickets:0','admin_tools_coupons:0'])assert.equal(ownerOnly(id),false,id);
});
test('private menu buttons disappear without mutating payloads, links or owner menus',()=>{
 const p={content:'ok',components:[{toJSON:()=>({type:1,components:[{custom_id:'admin_system_provider'},{custom_id:'admin_buyers_menu'},{url:'https://example.com',style:5}]})},{type:1,components:[{custom_id:'admin_tools_backup'}]}]};
 const q=privateMenu(p,false);assert.equal(q.components.length,1);assert.deepEqual(q.components[0].components,[{custom_id:'admin_buyers_menu'},{url:'https://example.com',style:5}]);assert.equal(p.components.length,2);assert.equal(privateMenu(p,true),p);
});
test('ordinary admins cannot submit sensitive buttons or modal posts before any handler runs',async()=>{
 for(const customId of ['admin_ops_low','admin_ops_low_save','admin_smscode_webhook_test','admin_healthcheck_midtrans_test_save','admin_tools_backup_download']){let response;const i={customId,user:{id:'admin'},reply:async p=>response=p};assert.equal(await protectOwnerInteraction(i,{isOwner:()=>false}),true);assert.equal(response.ephemeral,true);assert.match(response.content,/khusus owner/);}
});
test('owner response visibility follows revoked access and preserves private ephemeral responses',async()=>{
 let owner=true,response;const staff={isOwner:()=>owner},i={user:{id:'owner'},customId:'admin_system_menu',reply:async p=>response=p,editReply:async p=>response=p,update:async p=>response=p};assert.equal(await protectOwnerInteraction(i,staff),false);
 const p={ephemeral:true,components:[{type:1,components:[{custom_id:'admin_tools_backup'},{custom_id:'admin_home'}]}]};await i.reply(p);assert.equal(response.components[0].components.length,2);owner=false;await i.editReply(p);assert.equal(response.ephemeral,true);assert.deepEqual(response.components[0].components,[{custom_id:'admin_home'}]);
});
test('production installs privacy guard before all feature handlers',()=>{
 const code=require('node:fs').readFileSync(require.resolve('./index'),'utf8');const start=code.indexOf('client.on("interactionCreate"');const guard=code.indexOf('if(await protectOwnerInteraction(i,staff))return;',start);assert.ok(guard>start);for(const name of ['handleHealth','handleStoreFeatures','handleTools','handleSMSWebhook','handleOperations','handleAdmin','handleProviderFlow'])assert.ok(code.indexOf('if(await '+name+'(i))',start)>guard,name);
});
