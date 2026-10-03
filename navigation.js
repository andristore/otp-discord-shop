const {withBuyer}=require('./buyer-profiles');
const HOME_ID = 'shop_home';
const ADMIN_HOME_ID = 'admin_home';

function buttonColor(button) {
  if (button.type !== 2 || !button.custom_id || ![1, 2, 3, 4].includes(button.style)) return {...button};
  const id = button.custom_id;
  let style = 1; // Blue: store submenus and navigation.
  const label=String(button.label || '').trim().replace(/^🏠\s*/, '');
  const navigation=/^(Kembali|Batal|Menu Awal(?: Admin)?|Mulai Ulang|Back|Cancel|Home|Admin Home|Main Menu(?: Admin)?|Restart|Start Over|Atur Varian|Configure Variant)$/i.test(label);
  const action=id.split(':')[0];
  const selection=/^(flow_pick:|provider_flow_pick:|pick_product:|provider_product:|product:|manual_detail:|admin_manual_detail:|admin_manual_stock_edit:|admin_manual_change:|admin_buyers_detail:|admin_premium_claim_detail:|history_detail:|manual_order:|admin_manual_order:|active_order:|favorite_detail:|admin_store_detail:|manual_request_detail:|admin_ops_issue:|admin_tools_ticket:|tool_ticket:|admin_tools_fee_detail:)/.test(id);
  const destructive=button.style===4||/(^|_)(cancel|delete|remove|revoke|reject|rejected|refund)(_|$)/.test(action);
  if(navigation&&!destructive)style=1;
  else if(destructive)style=4;
  else if(selection)style=2;
  // Invoice list items are choices; the actual verification action remains green.
  else if(button.style===2&&/^topup_check:/.test(id))style=2;
  else if(button.style===3||/^(shop_balance$|confirm_buy:|qris_buy:|topup_qris$|topup_check:|direct_check:|check_otp:|admin_store_approve:)/.test(id))style=3;
  return {...button, style};
}

// Last check before Discord: duplicate IDs are invalid even on disabled buttons.
function validateComponents(rows) {
  if(rows.length>5)throw Error('Menu melebihi batas baris Discord.');
  const ids=new Set();
  for(const row of rows){
    if(!row.components.length||row.components.length>5)throw Error('Jumlah tombol pada baris menu tidak valid.');
    if(row.components.some(c=>[3,5,6,7,8].includes(c.type))&&row.components.length!==1)throw Error('Pilihan dropdown harus berada pada baris sendiri.');
    for(const c of row.components){
      if(!c.custom_id)continue;
      if(c.custom_id.length>100||ids.has(c.custom_id))throw Error('ID tombol menu tidak valid atau duplikat.');
      ids.add(c.custom_id);
    }
  }
  return rows;
}

function withHome(payload, requestedHome) {
  const result = typeof payload === 'string' ? {content: payload} : {...payload};
  let rows = (result.components || []).map(row => {
    const data = typeof row.toJSON === 'function' ? row.toJSON() : row;
    return {...data, components: (data.components || []).map(buttonColor)};
  });
  const homeId = requestedHome || (rows.some(row => row.components.some(component => /^(admin_|provider_)/.test(component.custom_id || ''))) ? ADMIN_HOME_ID : HOME_ID);
  if (homeId === ADMIN_HOME_ID) {
    let found = false;
    for (const row of rows) row.components = row.components.filter(component => {
      if (![HOME_ID, ADMIN_HOME_ID].includes(component.custom_id)) return true;
      if (found) return false;
      found = true;
      Object.assign(component, {custom_id: ADMIN_HOME_ID, label: 'Menu Awal Admin', emoji: {name: '🏠'}, style: 1});
      return true;
    });
  }
  rows=rows.filter(row=>row.components.length);
  const ids = new Set(rows.flatMap(row => row.components.map(component => component.custom_id)));
  if (['shop_products', 'shop_balance', 'shop_orders', 'shop_topup', 'shop_help'].every(id => ids.has(id))) {
    return {...result, components: validateComponents(rows.map(row => ({...row, components: row.components.filter(component => component.custom_id !== HOME_ID)})).filter(row => row.components.length))};
  }
  if (rows.some(row => row.components.some(component => component.custom_id === homeId))) return {...result, components: validateComponents(rows)};
  const button = {type: 2, style: 1, custom_id: homeId, label: homeId === ADMIN_HOME_ID ? 'Menu Awal Admin' : 'Menu Awal', emoji: {name: '🏠'}};
  const available = [...rows].reverse().find(row => row.components.length < 5 && row.components.every(component => component.type === 2));
  if (available) available.components.push(button);
  else if (rows.length < 5) rows.push({type: 1, components: [button]});
  else {
    // A full provider page already has a restart shortcut. Keep pagination
    // and product buttons intact, and replace that shortcut with the home button.
    const row = rows.find(row => row.components.some(component => ['shop_products', 'provider_catalog'].includes(component.custom_id)));
    if (!row) throw new Error('Menu tidak memiliki ruang untuk tombol Menu Awal.');
    const position = row.components.findIndex(component => ['shop_products', 'provider_catalog'].includes(component.custom_id));
    row.components[position] = button;
  }
  return {...result, components: validateComponents(rows)};
}

function addHomeNavigation(interaction) {
  const homeId = ['admin','ping'].includes(interaction.commandName) || /^(admin_|provider_)/.test(String(interaction.customId || '')) ? ADMIN_HOME_ID : HOME_ID;
  for (const method of ['reply', 'editReply', 'update', 'followUp']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = (payload, ...args) => original(withHome(withBuyer(payload, interaction), homeId), ...args);
  }
}

module.exports = {HOME_ID, ADMIN_HOME_ID, withHome, addHomeNavigation};
