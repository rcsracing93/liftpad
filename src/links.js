// LiftPad assisted lookup (Handoff 3 decision 8): one-tap links that Rick opens and reads himself.
// Never fetched by LiftPad or by any job: most of these sites ban automated access in their terms
// (source checks 2026-10-16). Pattern links are built only where the site has a stable address
// (examples quoted in the source checks); a deeper address that needs a site-internal id is never
// guessed. Fixed links go to the site's own search page. Pure function: no network, no database.
const slug = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const KN_MAKE = { amc: 'american-motors' };
// "2.0L 4 cyl", "5.7L 8 cyl Hemi" -> "2.0l-l4-gas", "5.7l-v8-gas". Only 4 and 8 cylinders: a 6 can
// be inline or V, so no guess (the link then stops at make and model).
function knEngine(engine) {
  const d = String(engine || '').match(/(\d+\.\d)\s*L/i), c = String(engine || '').match(/(\d+)\s*cyl/i);
  if (!d || !c) return '';
  const lay = { 4: 'l4', 8: 'v8' }[+c[1]];
  return lay ? `${d[1].toLowerCase()}l-${lay}-${/diesel/i.test(engine) ? 'diesel' : 'gas'}` : '';
}
export function lookupLinks({ year, make, model, engine = '', ev = false }) {
  const y = parseInt(year, 10), mk = slug(make), md = slug(model), out = [];
  const add = (tabs, label, url, kind, note = '') => out.push({ tabs, label, url, kind, note });
  // Oil (no oil links for a battery-electric car)
  if (!ev) {
    const e = knEngine(engine);
    if (mk && md) add(['oil'], 'K&N oil filter lookup', `https://www.knfilters.com/oil-filters/${KN_MAKE[mk] || mk}/${md}${e && y ? `/${e}/${y}` : ''}`, 'pattern',
      e && y ? '' : 'Pick the engine and year on the page.');
    add(['oil'], 'AMSOIL vehicle lookup', 'https://www.amsoil.com/lookup/auto-and-light-truck/', 'fixed', 'Capacity, grade and filters - read by hand; no bots allowed.');
    add(['oil'], 'Wix filter lookup', 'https://www.wixfilters.com/', 'fixed');
    add(['oil'], 'Fram filter lookup', 'https://www.fram.com/', 'fixed');
    // Not in the source checks: the address is not confirmed (purolator.com is a courier company).
    add(['oil'], 'Purolator filter lookup', 'https://www.purolatorautofilters.net/', 'fixed', 'Address not yet confirmed.');
    add(['oil'], 'Mobil 1 filter and oil finder', 'https://www.mobil1.com/', 'fixed');
    add(['oil'], 'Oil filter cross-reference', 'https://www.oilfilter-crossreference.com/', 'fixed', 'A second opinion only.');
  }
  // RockAuto: make, year, model level only; the engine is picked on the page (deeper addresses use an
  // internal engine id). Spaces in a model are "+".
  if (mk && y && model) add(ev ? ['torque', 'tires'] : ['oil', 'torque', 'tires'], 'RockAuto parts catalog', `https://www.rockauto.com/en/catalog/${mk},${y},${String(model).trim().toLowerCase().replace(/\s+/g, '+')}`, 'pattern',
    ev ? 'Pick the model on the page.' : 'Pick the engine, then Engine > Oil Filter (or Wheel > Lug Nut).');
  // Owner's manual portals (the manual is the authority for torque, oil and pressures)
  if (mk === 'ford' && y >= 2013 && md) add(['oil', 'torque', 'tires'], `Ford owner manual ${y} ${model}`, `https://www.ford.com/support/vehicle/${md}/${y}/owner-manuals/`, 'pattern');
  if (['jeep', 'dodge', 'chrysler', 'ram'].includes(mk)) add(['oil', 'torque', 'tires'], 'Mopar owner manual (sign-in)', 'https://www.mopar.com/en-us/my-vehicle/owners-manual.html', 'fixed');
  if (mk === 'honda' || mk === 'acura') add(['oil', 'torque', 'tires'], 'Honda owner manuals (MyGarage)', 'https://mygarage.honda.com/', 'fixed');
  // Wheels and tires (the door placard photo is the best source; these are cross-checks)
  add(['tires'], 'Tire Rack - OE tire sizes', 'https://www.tirerack.com/', 'fixed', 'Read by hand only.');
  add(['tires'], 'tirepressure.com', 'https://tirepressure.com/', 'fixed', 'Read by hand only.');
  add(['torque', 'tires'], 'Wheel-Size (thread, torque, bolt pattern)', 'https://www.wheel-size.com/', 'fixed', 'Read by hand only.');
  add(['tires'], 'NHTSA: where the tire placard is', 'https://www.nhtsa.gov/equipment/tires', 'fixed');
  return out;
}
