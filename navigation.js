const HOME_ID = 'shop_home';

function withHome(payload) {
  const result = typeof payload === 'string' ? {content: payload} : {...payload};
  const rows = (result.components || []).map(row => {
    const data = typeof row.toJSON === 'function' ? row.toJSON() : row;
    return {...data, components: (data.components || []).map(component => ({...component}))};
  });
  if (rows.some(row => row.components.some(component => component.custom_id === HOME_ID))) return result;
  const button = {type: 2, style: 2, custom_id: HOME_ID, label: 'Menu Awal', emoji: {name: '🏠'}};
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
