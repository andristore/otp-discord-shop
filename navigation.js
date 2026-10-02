const HOME_ID = 'shop_home';

function buttonColor(button) {
  if (button.type !== 2 || !button.custom_id || ![1, 2, 3, 4].includes(button.style)) return {...button};
  const id = button.custom_id;
  let style = 1; // Blue: store submenus and navigation.
  if (/^(flow_pick:|provider_flow_pick:|pick_product:|provider_product:|product:)/.test(id)) style = 2;
  else if (button.style === 4 || /(^|[_:])(cancel|delete|remove|revoke|reject|rejected|refund)([_:]|$)/.test(id)) style = 4;
  else if (button.style === 3 || /^(shop_balance$|confirm_buy:|qris_buy:|topup_qris$|topup_check:|direct_check:|check_otp:|admin_store_approve:)/.test(id)) style = 3;
  return {...button, style};
}

function withHome(payload) {
  const result = typeof payload === 'string' ? {content: payload} : {...payload};
  const rows = (result.components || []).map(row => {
    const data = typeof row.toJSON === 'function' ? row.toJSON() : row;
    return {...data, components: (data.components || []).map(buttonColor)};
  });
  const ids = new Set(rows.flatMap(row => row.components.map(component => component.custom_id)));
  if (['shop_products', 'shop_balance', 'shop_orders', 'shop_topup', 'shop_help'].every(id => ids.has(id))) {
    return {...result, components: rows.map(row => ({...row, components: row.components.filter(component => component.custom_id !== HOME_ID)})).filter(row => row.components.length)};
  }
  if (rows.some(row => row.components.some(component => component.custom_id === HOME_ID))) return {...result, components: rows};
  const button = {type: 2, style: 1, custom_id: HOME_ID, label: 'Menu Awal', emoji: {name: '🏠'}};
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
  return {...result, components: rows};
}

function addHomeNavigation(interaction) {
  for (const method of ['reply', 'editReply', 'update', 'followUp']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = (payload, ...args) => original(withHome(payload), ...args);
  }
}

module.exports = {HOME_ID, withHome, addHomeNavigation};
