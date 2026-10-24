// LiftPad front end. Hash routes: #/  #/add  #/car/<id>  #/car/<id>/page (page viewer)  #/confirm  #/apps
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Device label (decision 7): picked once per browser, sent with every call, used in the history.
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: ask again next time */ } } };
let device = store.get('lp-device');
async function api(path, opt = {}) {
  const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json', 'x-lp-device': device }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const d = await r.json().catch(() => ({ error: 'Bad response from server' }));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  $('#net').hidden = r.headers.get('x-liftpad-cache') !== 'offline';
  return d;
}
function crumb(t) { $('#crumb').textContent = t || ''; }
// A screen that loads slowly must not draw over a newer one (a fast tap to another screen): route()
// counts, and a screen draws only while its count is still the newest.
let routeSeq = 0;
const fresh = () => { const s = routeSeq; return () => s === routeSeq; };
function fail(e) { $('#view').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><a class="btn" href="#/">Back to my cars</a></div>`; }
const GROUP = { mine: 'My cars', frequent: 'Frequent', visitor: 'Visitors' };
const pill = s => `<span class="pill st-${esc(s)}">${s === 'confirmed' ? 'Confirmed' : s === 'rejected' ? 'Rejected' : 'Proposed'}</span>`;
// The key numbers (decision 1: 48 px on the lift screen): torque, tire pressures, oil quantity.
const KEY = new Set(['Torque', 'Pressure', 'Spare pressure', 'Quantity']);
const keyCls = s => KEY.has(s.field) && /^\s*~?\d/.test(s.value) ? ' key' : '';
const when = t => t ? String(t).slice(0, 16).replace('T', ' ') : '';
const boxStyle = b => `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
// Oil tab inputs (Handoff 3 decision 7). Each value is saved as text: "0W-20 · dexos1", "4.4 qt",
// "Wix 57356". A quantity is shown in both units, with the words "with filter".
const GRADES = ['0W-8', '0W-16', '0W-20', '0W-30', '0W-40', '5W-20', '5W-30', '5W-40', '10W-30', '10W-40', '15W-40', '20W-50'];
const BRANDS = ['Wix', 'Fram', 'K&N', 'Mobil 1', 'Purolator', 'OEM'];
const QT_L = 0.946353;
const OIL_UI = {
  'Oil type': {
    html: () => `<div class="field"><label for="og">Oil type</label><select id="og" name="grade">${GRADES.map(g => `<option>${g}</option>`).join('')}<option value="Other">Other</option></select></div>
      <div class="field" id="ogo" hidden><label for="ogt">Other oil type</label><input id="ogt" name="grade_other"></div>
      <div class="field"><label for="ogs">Spec (optional)</label><input id="ogs" name="spec" placeholder="e.g. dexos1 or MS-6395"></div>`,
    value: b => { const g = b.grade === 'Other' ? (b.grade_other || '').trim() : b.grade; const sp = (b.spec || '').trim(); return g && sp ? `${g} · ${sp}` : (g || ''); } },
  'Quantity': {
    html: () => `<div class="row"><div class="field"><label for="oq">Quantity, with filter</label><input id="oq" name="qty" inputmode="decimal" required></div>
      <div class="field"><label for="ou">Unit</label><select id="ou" name="unit"><option>qt</option><option>L</option></select></div></div>`,
    value: b => { const n = parseFloat(String(b.qty || '').replace(',', '.')); return n > 0 && n < 100 ? `${+n.toFixed(2)} ${b.unit === 'L' ? 'L' : 'qt'}` : ''; } },
  'Filter': {
    html: () => `<div class="row"><div class="field"><label for="ob">Filter brand</label><select id="ob" name="brand">${BRANDS.map(x => `<option>${esc(x)}</option>`).join('')}<option value="Other">Other</option></select></div>
      <div class="field"><label for="op">Part number</label><input id="op" name="part" required></div></div>`,
    value: b => `${b.brand === 'Other' ? '' : b.brand + ' '}${(b.part || '').trim()}`.trim() } };
const showVal = s => {
  const m = s.tab === 'oil' && s.field === 'Quantity' && String(s.value).match(/^(\d+(?:\.\d+)?)\s*(qt|L)$/i);
  if (!m) return s.value;
  const n = +m[1], qt = m[2].toLowerCase() === 'qt';
  return `${n} ${qt ? 'qt' : 'L'} (${(qt ? n * QT_L : n / QT_L).toFixed(1)} ${qt ? 'L' : 'qt'}) with filter`;
};

// ---------- Device label ----------
function pickDevice() {
  crumb('This screen');
  $('#view').innerHTML = `<section class="card"><h2>Name this screen</h2><p class="note">LiftPad writes this name next to every change, so the history shows where it was made. You pick it once.</p>
    <div class="row">${['Lift screen', 'Phone', 'Mac'].map(n => `<button class="primary" data-d="${n}">${n}</button>`).join('')}</div>
    <div class="field"><label for="devname">Other name</label><div class="row"><input id="devname" maxlength="40" placeholder="e.g. iPad"><button id="devgo">Use</button></div></div></section>`;
  const use = n => { n = n.replace(/[^\w .-]/g, '').trim().slice(0, 40); if (!n) return; device = n; store.set('lp-device', n); route(); };
  document.querySelectorAll('[data-d]').forEach(b => b.onclick = () => use(b.dataset.d));
  $('#devgo').onclick = () => use($('#devname').value);
}

// ---------- Home ----------
let showHidden = false;
// Storyboard T1: My cars as big tiles with a status line, Frequent, Visitors as chips; Needs
// confirming (with its count) and + Car in the header.
async function home() {
  const live = fresh();
  const [cars, need] = await Promise.all([api('/vehicles' + (showHidden ? '?hidden=1' : '')), api('/needs-confirming')]);
  if (!live()) return;
  crumb(device);
  $('#hnav').innerHTML = `<a class="btn" href="#/confirm">Needs confirming<span class="count">${need.count}</span></a><a class="btn primary" href="#/add">+ Car</a>`;
  // HANDOFF 10: Home shows only a block (warn = 2, an open problem). A caution (warn = 1) is on the Lift tab only.
  const status = c => c.nblock ? ['warn', 'Warning - see the Lift tab'] : c.nproposed ? ['todo', `${c.nproposed} value${c.nproposed === 1 ? '' : 's'} to confirm`]
    : c.nvals ? ['ok', 'All values confirmed'] : ['none', 'No values yet'];
  const tile = c => { const [k, t] = status(c); return `<a class="carbtn" href="#/car/${c.id}"><b>${c.year} ${esc(c.make)} ${esc(c.model)}</b><span>${esc(c.trim)}${c.hidden ? ' · hidden' : ''}</span><span class="status ${k}">${t}</span></a>`; };
  const ago = c => { const d = Math.floor((Date.now() - Date.parse(c.last_seen || c.created_iso || 0)) / 864e5); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`; };
  const g = k => cars.filter(c => c.grp === k);
  $('#view').innerHTML = `<section aria-label="My cars" class="tabbody"><h2 class="lbl">My cars</h2><div class="cars">${g('mine').map(tile).join('') || '<div class="empty">No cars yet. Tap + Car.</div>'}</div></section>
    <section aria-label="Frequent" class="tabbody"><h2 class="lbl">Frequent</h2><div class="cars small">${g('frequent').map(tile).join('')}${g('frequent').length < 3 ? '<div class="empty">Mark a visitor Frequent to keep it here</div>' : ''}</div></section>
    <section aria-label="Visitors" class="tabbody"><h2 class="lbl">Visitors - hidden 30 days after the last visit</h2>
      <div class="chips">${g('visitor').map(c => `<a class="chip" href="#/car/${c.id}">${c.year} ${esc(c.make)} ${esc(c.model)}<span>${c.hidden ? 'hidden · ' : ''}${ago(c)}</span></a>`).join('') || '<div class="empty">No visitors</div>'}</div>
      <label class="toggle"><input type="checkbox" id="showhid" ${showHidden ? 'checked' : ''}><span class="st"></span>Show hidden visitors (not seen for 30 days)</label></section>
    <div class="row"><span class="src">This screen: ${esc(device)}</span><button class="ghost" id="rename">Change name</button></div>`;
  $('#showhid').onchange = e => { showHidden = e.target.checked; home(); };
  $('#rename').onclick = () => pickDevice();
}

// ---------- Needs confirming ----------
async function confirmPage() {
  const live = fresh();
  const d = await api('/needs-confirming');
  if (!live()) return;
  crumb('Needs confirming');
  // Storyboard T6 / P3: one row per value - what, the value, confidence and source, Confirm / Reject.
  const what = x => x.scope === 'car' ? 'this car only' : `${esc(x.make)} ${esc(x.model)} ${x.year_from}${x.year_to !== x.year_from ? '-' + x.year_to : ''}`;
  $('#view').innerHTML = `<div class="carhead"><a class="btn" href="#/">Home</a><div><h2>Needs confirming</h2><div class="src">${d.count} proposed value${d.count === 1 ? '' : 's'} · check each against the manual or the door label, then confirm or reject</div></div></div>
    <div role="list" class="tabbody">${d.values.map(x => `<div role="listitem" class="crow${x.range_flag === 'outside' ? ' flag' : ''}"><div class="tabbody" style="gap:6px">
      <span class="meta">${what(x)} · ${esc(x.tab)} · ${esc(x.field)}</span>
      <span class="val${keyCls(x)}">${esc(showVal(x))}</span>
      <span class="meta"><span class="pill ${esc(x.confidence)}" style="margin-left:0">${esc(x.confidence)}</span> ${x.warn ? `<span class="pill lv-${x.warn === 2 ? 'block' : 'caution'}" style="margin-left:0">${x.warn === 2 ? 'Block - do not lift yet' : 'Caution'}</span> ` : ''}${esc(x.source)}</span>${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}
      ${x.range_flag === 'outside' && x.range ? `<span class="err">Outside the usual range for ${esc(x.range.thread)} (${x.range.torque_min}-${x.range.torque_max} ft-lb). Check it before you confirm.</span>` : ''}</div>
      <div class="acts"><button class="ok" data-ok="${x.id}">Confirm</button><button data-no="${x.id}">Reject</button></div></div>`).join('') || '<p class="note">Nothing to confirm.</p>'}</div>
    <p class="note">A confirmed model-year value applies to every car of that model and year. Each confirm or reject is kept in the value's history.</p>`;
  wireStatus(confirmPage);
}
function wireStatus(after) {
  document.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => api(`/values/${b.dataset.ok}/confirm`, { method: 'POST', body: {} }).then(after).catch(fail));
  document.querySelectorAll('[data-no]').forEach(b => b.onclick = () => api(`/values/${b.dataset.no}/reject`, { method: 'POST', body: {} }).then(after).catch(fail));
}

// ---------- Combobox ----------
function combo(input, list, fetchItems, onPick) {
  let items = [], act = 0, t;
  const render = () => {
    list.innerHTML = items.length ? items.map((it, i) => `<li role="option" aria-selected="${i === act}" data-i="${i}">${esc(it.label)}${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}</li>`).join('') : '<li class="empty">No match</li>';
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const load = () => { clearTimeout(t); t = setTimeout(async () => { try { items = await fetchItems(input.value); act = 0; render(); } catch (e) { list.innerHTML = `<li class="empty">${esc(e.message)}</li>`; list.hidden = false; } }, 120); };
  const pick = i => { const it = items[i]; if (!it) return; input.value = it.label; close(); onPick(it); };
  input.addEventListener('input', load); input.addEventListener('focus', load);
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(act); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('pointerdown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- Add car ----------
function add() {
  crumb('Add car');
  const st = { make: '', year: 0, model: '', trim: '', vin: '' };
  // Storyboard T5: whose car first (Mine / Frequent / Visitor), one tap each.
  $('#view').innerHTML = `<div class="carhead"><a class="btn" href="#/">Cancel</a><h2>Add a car</h2></div><div class="grid"><section class="form">
    <fieldset class="field" style="border:0;margin:0;padding:0"><legend class="lbl" style="margin-bottom:8px">Whose car</legend>
      <div class="seg" id="grp">${[['mine', 'Mine'], ['frequent', 'Frequent'], ['visitor', 'Visitor']].map(([k, l]) => `<button type="button" data-grp="${k}" aria-pressed="${k === 'visitor'}">${l}</button>`).join('')}</div></fieldset>
    <div class="field"><label for="make">Make</label><input id="make" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Type 2-3 letters"><ul class="list" id="make-list" role="listbox" hidden></ul></div>
    <div class="field"><label for="year">Year</label><input id="year" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits" disabled></div>
    <div class="field"><label for="model">Model</label><input id="model" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Pick make and year first" disabled><ul class="list" id="model-list" role="listbox" hidden></ul></div>
    <div class="field"><label for="trim">Trim / engine (optional)</label><input id="trim" autocomplete="off" placeholder="e.g. EX 2.0L"></div>
    <div class="or">or</div>
    <div class="field"><label for="vin">VIN</label><div class="row"><input id="vin" maxlength="17" autocomplete="off" placeholder="17 characters" style="font-family:var(--mono)"><button type="button" id="vin-go">Decode</button>${scanButton('vin-scan')}</div></div>
  </section><section class="card" id="res"><h2>Pick a car</h2><p class="note">Type a make. "stu" finds Studebaker, "ram" finds Ram.</p></section></div>`;
  const show = async () => {
    const R = $('#res');
    if (!st.make || !st.year || !st.model) { R.innerHTML = `<h2>${esc([st.year || '', st.make].join(' ').trim() || 'Pick a car')}</h2><p class="note">${st.make ? (st.year ? 'Pick a model.' : 'Type the 4-digit year.') : 'Type a make.'}</p>`; return; }
    R.innerHTML = `<h2>${st.year} ${esc(st.make)} ${esc(st.model)}</h2><p class="note">${st.chartNote || ''}</p><button class="primary" id="save">Save car</button><p class="err" id="saveerr"></p>`;
    $('#save').onclick = async () => {
      try { const v = await api('/vehicles', { method: 'POST', body: { ...st, trim: $('#trim').value.trim(), grp: $('#grp [aria-pressed="true"]').dataset.grp } }); location.hash = '#/car/' + v.id; }
      catch (e) { $('#saveerr').textContent = e.message; }
    };
  };
  combo($('#make'), $('#make-list'), q => api('/makes?q=' + encodeURIComponent(q)).then(r => r.map(m => ({ label: m.name, tag: m.mine ? 'my car' : '' }))),
    it => { st.make = it.label; st.model = ''; $('#year').disabled = false; $('#model').value = ''; $('#model').disabled = !st.year; $('#year').focus(); show(); });
  $('#year').addEventListener('input', e => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = v; st.model = '';
    st.year = v.length === 4 ? +v : 0; $('#model').disabled = !st.year; $('#model').value = '';
    $('#model').placeholder = st.year ? 'Tap to see models' : 'Type the year first'; if (st.year) $('#model').focus(); show();
  });
  combo($('#model'), $('#model-list'), q => api(`/models?make=${encodeURIComponent(st.make)}&year=${st.year}&q=${encodeURIComponent(q)}`)
    .then(r => r.map(m => ({ label: m.label, charts: m.charts, tag: m.charts.length ? m.charts.map(c => c.chart).join(', ') : m.unknown ? 'years unknown' : m.source }))),
    it => { st.model = it.label; st.chartNote = it.charts.length ? `ALI chart ${it.charts.map(c => c.chart + (c.status === 'ok' ? ` (guide p.${c.guide_page})` : ' (page missing from scan)')).join(', ')}` : 'No ALI chart for this year.'; show(); });
  $('#vin-go').onclick = async () => {
    const R = $('#res');
    try { const d = await api('/vin?vin=' + encodeURIComponent($('#vin').value)); Object.assign(st, { vin: d.vin, year: d.year, make: d.make, model: d.model });
      $('#make').value = d.make; $('#year').value = d.year || ''; $('#year').disabled = false; $('#model').value = d.model; $('#model').disabled = false;
      $('#trim').value = [d.trim, d.engine].filter(Boolean).join(' ');
      st.chartNote = (d.error ? 'NHTSA note: ' + d.error : 'Decoded by NHTSA. Check make and model match the lists.') + (d.ev ? ' Battery-electric: no engine oil.' : ''); show(); }
    catch (e) { R.innerHTML = `<h2>VIN</h2><p class="err">${esc(e.message)}</p>`; }
  };
  wireScan('vin-scan', vin => { $('#vin').value = vin; $('#vin-go').click(); }, m => { $('#res').innerHTML = `<h2>VIN</h2><p class="err">${esc(m)}</p>`; });
  document.querySelectorAll('[data-grp]').forEach(b => b.onclick = () => document.querySelectorAll('[data-grp]').forEach(x => x.setAttribute('aria-pressed', String(x === b))));
  $('#make').focus();
}

// ---------- Car ----------
let tab = 'lift';
let meta = null;
// HANDOFF 12: the adapter notes of the chart on the Lift tab. Three check levels, always in words (Rick, 2026-10-24):
// no (or no row at all) "Not checked - read the page", ai "AI-checked - the page is the source", rick "Checked by
// Rick". The block shows its whole text at every level; the label is the first line.
const VERIFIED = { no: 'Not checked - read the page.', ai: 'AI-checked - the page is the source.', rick: 'Checked by Rick.' };
// The kit mark "Do not use a 2-post" makes the block red and puts it first on the tab, with the chart's words. Under
// every block one fixed line (the lift's own numbers come from the data: foot; the words below are the fallback).
const FOOT_FALLBACK = 'The chart gives no pad height. Check that the pads reach the lift points and the arms clear the car.';
const adaptersBlock = (n, foot) => {
  const lv = n && VERIFIED[n.verified] ? n.verified : 'no', stop = !!n && /^Do not use a 2-post/.test(n.kit_mark || '');
  const lead = `<div class="vlabel"><b>${VERIFIED[lv]}</b></div>`;
  const end = `<div class="adfoot">${esc(foot || FOOT_FALLBACK)}</div>`;
  if (!n) return { stop: false, html: `<div class="adapters unchecked" data-verified="no">${lead}<div>LiftPad has no adapter notes for this chart.</div>${end}</div>` };
  return { stop, html: `<div class="adapters${lv === 'no' ? ' unchecked' : ''}${stop ? ' stop' : ''}" data-verified="${lv}" data-kit="${stop ? 'stop' : 'note'}">
    ${stop ? '<div class="stopline"><b>Do not use a 2-post.</b> The chart says so. Read its words below.</div>' : ''}${lead}
    <div><b>Adapters (from the guide):</b> ${esc(n.adapters || 'no adapter callout on the chart')}</div>
    ${n.height_note ? `<div><b>Height:</b> ${esc(n.height_note)}</div>` : ''}
    <div><b>Your kit:</b> ${esc(n.kit_mark || 'height not given')}</div>
    ${n.cautions ? `<div><b>Cautions:</b> ${esc(n.cautions)}</div>` : ''}${end}</div>` };
};
async function car(id) {
  const live = fresh();
  if (!meta) meta = await api('/tabs');
  const v = await api('/vehicles/' + id);
  if (!meta.tabs.some(t => t.name === tab)) tab = meta.tabs[0]?.name || 'lift';
  const rows = v.values.filter(s => s.tab === tab);
  let ali = '', pageCard = '';
  if (tab === 'lift') {
    const a = v.ali;
    if (!a) ali = `<div class="warn bad">No ALI chart for this car in the lift guide.</div>`;
    else if (a.d === 0) ali = `<dl><dt>ALI chart</dt><dd><span class="val">${esc(a.chart)}</span><span class="pill ${a.status === 'ok' ? 'High' : 'Missing'}">${a.status === 'ok' ? 'High' : 'Missing'}</span><div class="src">ALI ${esc(a.edition)} · guide p.${a.guide_page}${a.pdf_page ? ' · PDF p.' + a.pdf_page : ''} · ${a.year_from}-${a.year_to}</div></dd></dl>`;
    else ali = `<div class="warn">ALI chart ${esc(a.chart)} covers ${a.year_from}-${a.year_to}, not ${v.year}. Check it is the same body before you use it. (guide p.${a.guide_page})</div>`;
    // Storyboard T2: the whole page, the chart's box on it when one is drawn, "Use chart XX" in large text.
    if (a && a.img) pageCard = `<a class="pagecard" href="#/car/${v.id}/page" aria-label="Open the ALI page full screen">
      <span class="pageimg" style="aspect-ratio:${a.w}/${a.h}"><img src="${esc(a.img)}" alt="ALI ${esc(a.edition)} guide page ${a.guide_page}${a.box ? ', chart ' + esc(a.chart) + ' outlined' : ''}">${a.box ? `<span class="pbox" style="${boxStyle(a.box)}"></span>` : ''}</span>
      <span class="usechart">Use chart ${esc(a.chart)} - tap to open</span></a>`;
    else if (a && a.status === 'missing_from_scan') pageCard = `<div class="warn bad">The page for chart ${esc(a.chart)} (guide p.${a.guide_page}) is missing from the ${esc(a.edition)} scan. Use a paper guide.</div>`;
  }
  const ad = tab === 'lift' && v.ali ? adaptersBlock(v.chart_notes, v.chart_notes_footer) : { stop: false, html: '' };
  const job = v.jobs[0];
  const jobLine = !job ? '' : job.status === 'done' ? `<span class="warn">Results ready - confirm${job.result_summary ? ' (' + esc(job.result_summary) + ')' : ''}</span>`
    : job.status === 'failed' ? `<span class="warn bad">Research failed: ${esc(job.error)}</span>` : `<span class="note">${job.status === 'claimed' ? 'Researching' : 'Queued'}</span>`;
  // The VIN decode (NHTSA only, cached) gives the engine for the lookup links and the EV flag.
  const lookTab = ['oil', 'torque', 'tires'].includes(tab);
  const dec = lookTab && v.vin ? await api('/vin?vin=' + encodeURIComponent(v.vin)).catch(() => null) : null;
  // Decision 7: NHTSA says battery-electric -> no engine oil.
  let evNote = '';
  if (tab === 'oil' && dec && dec.ev) evNote = `<div class="warn"><b>No engine oil (EV).</b> NHTSA says this car is battery-electric (${esc(dec.electrification || dec.fuel)}). It has no engine oil to change.</div>`;
  // Decision 8: links Rick opens and reads himself; LiftPad never fetches them. A tap fills the Source box.
  let links = '';
  if (lookTab) {
    const L = (await api(`/links?year=${v.year}&make=${encodeURIComponent(v.make)}&model=${encodeURIComponent(v.model)}&engine=${encodeURIComponent((dec && dec.engine) || '')}&ev=${dec && dec.ev ? 1 : 0}`).catch(() => [])).filter(l => l.tabs.includes(tab));
    if (L.length) links = `<details class="links"><summary class="lbl">Look it up yourself (${L.length} links)</summary>
      <p class="note">Each opens the site in a new tab. LiftPad never reads these sites for you. Enter what you find below: the source is filled in.</p>
      <ul>${L.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-src="${esc(l.label)}">${esc(l.label)}</a>${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</li>`).join('')}</ul></details>`;
  }
  // Decision 9: after the car's own values, the make's typical value (Low), then the thread range
  // as a sanity check only. A torque outside the range is flagged on the value.
  const R = v.typical && v.typical.range, MK = v.typical && v.typical.make;
  const rangeWarn = s => s.range_flag === 'outside' && R ? `<div class="warn bad">Outside the usual range for ${esc(R.thread)} (${R.torque_min}-${R.torque_max} ft-lb). Check it before you use it.</div>` : '';
  let typ = '';
  if (tab === 'torque' && MK) {
    const own = rows.some(s => s.field === 'Torque');
    typ += `<div class="typical${own ? ' after' : ''}"><div class="lbl">${own ? 'Typical for ' + esc(v.make) + ' (for comparison)' : 'No value for this car yet - typical for ' + esc(v.make)}</div>
      ${MK.torque_ftlb != null ? `<span class="val${own ? '' : ' key'}">~${MK.torque_ftlb} ft-lb</span> <span class="src">(${Math.round(MK.torque_ftlb * 1.35582)} Nm)</span>` : ''}<span class="pill Low">Low</span>
      <div>${[MK.thread, MK.socket && MK.socket + ' socket'].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="note">Typical for ${esc(v.make)} ${esc(MK.era)} - not confirmed for this car.${MK.note ? ' ' + esc(MK.note) + '.' : ''} (table ${esc(MK.edition)})</div></div>`;
  }
  if (tab === 'torque' && R) typ += `<p class="src">Range for ${esc(R.thread)}${v.typical.thread_from === 'make' ? ` (the typical ${esc(v.make)} thread)` : ''}: ${R.torque_min}-${R.torque_max} ft-lb. A sanity check only, never the car's value. (table ${esc(R.edition)})</p>`;
  // Decision 1: a proposed value looks different (dashed amber box, the word Proposed) from a confirmed one.
  const valueDd = s => `<dd data-v="${s.id}" class="v-${esc(s.status)}"><div><span class="val${keyCls(s)}">${esc(showVal(s))}</span></div>
    <div><span class="pill ${esc(s.confidence)}" style="margin-left:0">${esc(s.confidence)}</span>${pill(s.status)}${s.scope === 'car' ? '<span class="tag">this car only</span>' : `<span class="tag">${s.year_from}${s.year_to !== s.year_from ? '-' + s.year_to : ''}</span>`}</div>
    <div class="src">${esc(s.source)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}${rangeWarn(s)}
    <div class="row">${s.status === 'proposed' ? `<button class="ok" data-ok="${s.id}">Confirm</button><button class="ghost" data-no="${s.id}">Reject</button>` : ''}<button class="ghost" data-h="${s.id}">History</button><button class="ghost" data-e="${s.id}">Edit</button></div><div class="hist"></div></dd>`;
  // Storyboard T4: a visiting car opens with a first look at Lift, Torque and Tires side by side.
  const best = f => v.values.find(x => x.field === f && x.status === 'confirmed') || v.values.find(x => x.field === f);
  const firstLook = v.grp !== 'visitor' ? '' : `<div class="first">
    <section aria-label="Lift"><h3>Lift</h3>${v.ali ? `<span class="val">Use chart ${esc(v.ali.chart)}</span><span class="src">ALI ${esc(v.ali.edition)} · ${v.ali.year_from}-${v.ali.year_to} · p.${v.ali.guide_page}</span>` : '<span class="note">No ALI chart</span>'}</section>
    <section aria-label="Torque"><h3>Torque</h3>${best('Torque') ? `<span class="val key">${esc(best('Torque').value)}</span>${pill(best('Torque').status)}` : MK && MK.torque_ftlb != null ? `<span class="val key">~${MK.torque_ftlb} ft-lb</span><span><span class="pill Low" style="margin-left:0">Low</span> <span class="note">Typical for ${esc(v.make)} - not confirmed</span></span>` : '<span class="note">No value yet</span>'}</section>
    <section aria-label="Tires"><h3>Tires</h3>${best('Pressure') ? `<span class="val key">${esc(best('Pressure').value)}</span>${pill(best('Pressure').status)}` : `<span class="note">No values yet. The door-jamb label is the maker's own source.</span><a class="btn primary" href="#/car/${v.id}/jamb">Door-jamb photo</a>`}</section></div>`;
  if (!live()) return;
  crumb(`${v.year} ${v.make} ${v.model}`);
  $('#view').innerHTML = `${firstLook}<section class="card">
    <div class="carhead"><a class="btn" href="#/">My cars</a><div><h2>${v.year} ${esc(v.make)} ${esc(v.model)}</h2><div class="src">${esc(v.trim)} · ${GROUP[v.grp]}</div></div></div>
    <div class="tabs" role="tablist">${meta.tabs.map(t => `<button role="tab" aria-selected="${tab === t.name}" data-t="${t.name}">${esc(t.label)}</button>`).join('')}</div>
    <div class="${pageCard ? 'liftgrid' : 'tabbody'}"><div class="tabbody">
    ${ad.stop ? ad.html : ''}${rows.filter(s => s.warn).sort((a, b) => b.warn - a.warn).map(s => `<div class="warn${s.warn === 2 ? ' bad' : ''}" data-level="${s.warn === 2 ? 'block' : 'caution'}"><dl><dt><b>${s.warn === 2 ? 'Do not lift yet' : 'Caution'}</b> - ${esc(s.field)}</dt>${valueDd(s)}</dl></div>`).join('')}
    ${ali}${ad.stop ? '' : ad.html}${evNote}
    ${evNote && !rows.length ? '' : `<dl>${rows.filter(s => !s.warn).map(s => `<dt>${esc(s.field)}${s.is_safety ? ' <span class="tag">safety</span>' : ''}</dt>${valueDd(s)}`).join('') || '<dt>Values</dt><dd class="note">Nothing yet. Add the first value below, or tap Research.</dd>'}</dl>`}
    ${tab === 'tires' ? `<a class="btn primary big" href="#/car/${v.id}/jamb">Door-jamb photo</a><p class="note">The label on the driver door pillar is the maker's own source. Take a photo, then type what it says.</p>` : ''}
    ${typ}${links}
    <details id="addspec" ${evNote ? 'hidden' : ''}><summary class="lbl">+ Add a ${esc(meta.tabs.find(t => t.name === tab)?.label || tab)} value</summary>${valueForm(v)}</details>
    </div>${pageCard}</div>
  </section>
  <div class="row"><button id="research">Research missing values</button>${jobLine}</div>
  <div class="row">${Object.keys(GROUP).filter(g => g !== v.grp).map(g => `<button class="ghost" data-g="${g}">Move to ${GROUP[g]}</button>`).join('')}</div>
  <div class="card" id="vinbox"><div><span class="lbl">VIN</span> <span class="val" id="vinnow">${esc(v.vin || 'none')}</span></div>
    <div class="row"><input id="vinin" maxlength="17" autocomplete="off" placeholder="17 characters" aria-label="VIN" style="font-family:var(--mono)" value="${esc(v.vin || '')}"><button id="vinsave">Save VIN</button>${scanButton('vinscan')}</div>
    <p class="note">The VIN stays on this car and goes only to NHTSA, to decode the engine and the EV flag.</p><p class="err" id="vinerr"></p></div>
  <div class="row"><button class="ghost" id="del">Delete car</button></div><p id="delmsg"></p>`;
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; car(id); });
  wireStatus(() => car(id));
  document.querySelectorAll('[data-h]').forEach(b => b.onclick = async () => {
    const box = b.closest('dd').querySelector('.hist');
    const h = await api(`/values/${b.dataset.h}/history`);
    box.innerHTML = `<ol class="src">${h.map(r => `<li>${when(r.at)} · ${esc(r.device)} · ${r.action}${r.old_value != null && r.old_value !== r.new_value ? ` · "${esc(r.old_value)}" → "${esc(r.new_value ?? '')}"` : r.new_value != null ? ` · "${esc(r.new_value)}"` : ''}${r.old_status !== r.new_status ? ` · ${esc(r.old_status ?? '')} → ${esc(r.new_status ?? '')}` : ''}</li>`).join('')}</ol>`;
  });
  wireValueInputs($('#addspec form'));
  document.querySelectorAll('.links a[data-src]').forEach(a => a.addEventListener('click', () => {
    const src = `${a.dataset.src}, ${new Date().toISOString().slice(0, 10)}`;
    store.set('lp-lastsrc', JSON.stringify({ car: v.id, src }));
    const box = $('#addspec input[name=source]'); if (box) box.value = src;
  }));
  wireForm($('#addspec form'), body => api(`/vehicles/${id}/values`, { method: 'POST', body: { ...body, tab, status: body.confirm ? 'confirmed' : 'proposed' } }).then(() => car(id)));
  document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const s = v.values.find(x => x.id == b.dataset.e); const dd = b.closest('dd'); dd.innerHTML = editForm(s);
    wireForm(dd.querySelector('form'), body => api('/values/' + s.id, { method: 'PATCH', body }).then(() => car(id)), () => api('/values/' + s.id, { method: 'DELETE' }).then(() => car(id)));
  });
  $('#vinsave').onclick = () => api('/vehicles/' + id, { method: 'PATCH', body: { vin: $('#vinin').value } }).then(() => car(id)).catch(e => { $('#vinerr').textContent = e.message; });
  wireScan('vinscan', vin => { $('#vinin').value = vin; $('#vinerr').textContent = 'VIN read from the photo - check it, then Save VIN.'; }, m => { $('#vinerr').textContent = m; });
  document.querySelectorAll('[data-g]').forEach(b => b.onclick = () => api('/vehicles/' + id, { method: 'PATCH', body: { grp: b.dataset.g } }).then(() => car(id)).catch(fail));
  $('#research').onclick = () => api('/jobs', { method: 'POST', body: { vehicle_id: +id, kind: 'research' } }).then(() => car(id)).catch(e => { $('#delmsg').textContent = e.message; });
  $('#del').onclick = () => { $('#delmsg').innerHTML = `This deletes the car and its own values. Values for the model and year stay. <button class="primary" id="del2">Yes, delete</button>`; $('#del2').onclick = () => api('/vehicles/' + id, { method: 'DELETE' }).then(() => location.hash = '#/'); };
}
function valueForm(v) {
  const fs = meta.fields.filter(f => f.tab === tab);
  return `<form class="form" style="margin-top:12px"><div class="field"><label>Field</label><select name="field">${fs.map(f => `<option>${esc(f.name)}</option>`).join('')}</select></div>
  <div id="valin">${valueInputs(fs[0]?.name)}</div>
  <div class="field"><label>Confidence</label><select name="confidence">${['High', 'Medium', 'Low'].map(c => `<option>${c}</option>`).join('')}</select></div>
  <div class="field"><label>Source</label><input name="source" placeholder="Where it came from" value="${esc(lastSource(v.id))}"></div>
  <div class="field"><label>Note</label><input name="note"></div>
  ${warnSelect(0)}
  <div class="field"><label>Applies to</label><select name="scope"><option value="model">Every ${esc(v.make)} ${esc(v.model)} in these years</option><option value="car">This car only (override)</option></select></div>
  <div class="row"><div class="field"><label>From year</label><input name="year_from" inputmode="numeric" maxlength="4" value="${v.year}"></div><div class="field"><label>To year</label><input name="year_to" inputmode="numeric" maxlength="4" value="${v.year}"></div></div>
  <label class="toggle"><input type="checkbox" name="confirm" value="1"><span class="st"></span>I checked this value - mark it confirmed</label>
  <div class="row"><button class="primary" type="submit">Save</button></div><p class="err"></p></form>`;
}
// The lookup link Rick tapped last for this car (decision 8: source pre-filled, date automatic).
const lastSource = id => { try { const s = JSON.parse(store.get('lp-lastsrc') || 'null'); return s && s.car === id ? s.src : ''; } catch (e) { return ''; } };
// The value inputs for one field: the oil inputs on the Oil tab, else one text box.
const valueInputs = name => (tab === 'oil' && OIL_UI[name]) ? OIL_UI[name].html() : '<div class="field"><label for="vv">Value</label><input id="vv" name="value" placeholder="e.g. 100 ft-lb" required></div>';
function wireValueInputs(f) {
  if (!f) return;
  const sel = f.querySelector('select[name=field]');
  const grade = () => { const g = f.querySelector('#og'); if (g) g.onchange = () => { f.querySelector('#ogo').hidden = g.value !== 'Other'; }; };
  sel.onchange = () => { f.querySelector('#valin').innerHTML = valueInputs(sel.value); grade(); };
  grade();
  f.compose = b => (tab === 'oil' && OIL_UI[b.field]) ? OIL_UI[b.field].value(b) : b.value;
}
// The warning level of a value (HANDOFF 10). Caution: a standing step, shown on the Lift tab. Block: an open
// problem, shown on Home too, until the value is fixed or you set it back to None.
const warnSelect = lv => `<div class="field"><label>Warning</label><select name="warn">${[[0, 'None'], [1, 'Caution - a standing safety step (Lift tab)'], [2, 'Block - do not lift yet (Home and Lift tab)']].map(([n, t]) => `<option value="${n}" ${+lv === n ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
function editForm(s) {
  return `<form class="form" style="margin-top:12px">
  <div class="field"><label>Value</label><input name="value" value="${esc(s.value)}" required></div>
  <div class="field"><label>Confidence</label><select name="confidence">${['High', 'Medium', 'Low'].map(c => `<option ${s.confidence === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
  <div class="field"><label>Source</label><input name="source" value="${esc(s.source)}"></div>
  <div class="field"><label>Note</label><input name="note" value="${esc(s.note)}"></div>
  ${warnSelect(s.warn)}
  <div class="row"><button class="primary" type="submit">Save</button><button type="button" class="ghost" data-rm>Delete value</button></div><p class="err"></p></form>`;
}
function wireForm(f, save, remove) {
  if (!f) return;
  f.onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); if (f.compose) b.value = f.compose(b);
    try { await save(b); } catch (x) { f.querySelector('.err').textContent = x.message; } };
  const rm = f.querySelector('[data-rm]'); if (rm && remove) rm.onclick = () => remove().catch(x => f.querySelector('.err').textContent = x.message);
}

// ---------- Door-jamb photo (Handoff 3 decision 10, storyboard P1 and P2) ----------
// The photo goes to private storage only (photos/<car>/<time>.jpg) and is never sent to any model;
// Rick reads the label and types the numbers. Big phone photos are made smaller (2400 px) first.
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.85));
  } catch (e) { return file; }
}
async function jamb(id) {
  const live = fresh();
  const v = await api(`/vehicles/${id}?peek=1`);
  const photos = await api(`/vehicles/${id}/photos`).catch(() => []);
  if (!live()) return;
  crumb(`${v.year} ${v.make} ${v.model} · door-jamb label`);
  $('#view').innerHTML = `<section class="card phoneflow"><h2>Door-jamb label</h2><div class="src">${v.year} ${esc(v.make)} ${esc(v.model)} ${esc(v.trim)}</div>
    <ul class="note"><li>Driver door open, label on the door pillar.</li><li>Get the whole label, no glare.</li><li>The photo stays in your private storage. No one else reads it.</li></ul>
    <label class="btn primary big" for="jcam">Take photo</label><input type="file" id="jcam" accept="image/*" capture="environment" hidden>
    <label class="btn big" for="jpick">Choose from photos</label><input type="file" id="jpick" accept="image/*" hidden>
    <p class="err" id="jerr"></p>
    ${photos.length ? `<h3 class="lbl">Earlier photos</h3><div class="row">${photos.slice(0, 6).map(ph => `<a class="btn" href="#/car/${v.id}/jamb/${esc(ph.name)}">${esc(ph.name.slice(0, 10))} ${esc(ph.name.slice(11, 16).replace('-', ':'))}</a>`).join('')}</div>` : ''}
    <a class="btn" href="#/car/${v.id}">Back to the car</a></section>`;
  const up = async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    $('#jerr').textContent = 'Saving the photo...';
    try {
      const b = await shrink(f);
      const r = await fetch(`/api/vehicles/${id}/photos`, { method: 'POST', headers: { 'content-type': b.type || 'image/jpeg', 'x-lp-device': device }, body: b });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      location.hash = `#/car/${id}/jamb/${d.name}`;
    } catch (x) { $('#jerr').textContent = x.message; }
  };
  $('#jcam').onchange = up; $('#jpick').onchange = up;
}
// P2: the photo beside the fields. "Correct - confirm" saves confirmed High (the placard is the
// maker's own label); "Save as proposed" keeps them for later. They are this car's own values.
async function jambRead(id, name) {
  const live = fresh();
  const v = await api(`/vehicles/${id}?peek=1`);
  if (!live()) return;
  const own = f => v.values.find(x => x.tab === 'tires' && x.field === f && x.scope === 'car');
  const cur = f => (own(f) || v.values.find(x => x.tab === 'tires' && x.field === f) || {}).value || '';
  const pr = cur('Pressure').match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/) || cur('Pressure').match(/(\d+(?:\.\d+)?)/);
  const num = s => (String(s).match(/\d+(?:\.\d+)?/) || [''])[0];
  const src = `/api/photos/${v.id}/${name}`;
  crumb(`${v.year} ${v.make} ${v.model} · check the read`);
  $('#view').innerHTML = `<section class="card phoneflow"><h2>Check the read</h2><p class="note">Compare with the photo and type what the label says.</p>
    <a class="jphoto" href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Your door-jamb label photo"></a>
    <form class="form" id="jform">
      <div class="row"><div class="field"><label for="jf">Front psi</label><input id="jf" name="front" inputmode="decimal" value="${esc(pr ? pr[1] : '')}"></div>
      <div class="field"><label for="jr">Rear psi</label><input id="jr" name="rear" inputmode="decimal" value="${esc(pr ? (pr[2] || pr[1]) : '')}"></div></div>
      <div class="field"><label for="js">Tire size</label><input id="js" name="size" value="${esc(cur('Size'))}" placeholder="e.g. 215/55R16"></div>
      <div class="field"><label for="jp">Spare psi (optional)</label><input id="jp" name="spare" inputmode="decimal" value="${esc(num(cur('Spare pressure')))}"></div>
      <p class="note">The photo stays in your private storage. Only the numbers are saved to this car.</p>
      <button class="primary ok big" type="button" id="jok">Correct - confirm</button>
      <button class="ghost" type="button" id="jlater">Save as proposed, check later</button>
      <p class="err" id="jerr"></p></form>
    <a class="btn" href="#/car/${v.id}/jamb">Retake</a></section>`;
  const save = async confirm => {
    const b = Object.fromEntries(new FormData($('#jform'))); const day = new Date().toISOString().slice(0, 10);
    const psi = x => x === '' ? '' : (+x >= 10 && +x <= 99 ? String(+x) : null);
    const [f, r, s] = [psi(b.front.trim()), psi(b.rear.trim()), psi(b.spare.trim())];
    if (f === null || r === null || s === null) { $('#jerr').textContent = 'A pressure must be a number from 10 to 99 psi.'; return; }
    const rows = [['Pressure', f && r ? `${f} / ${r} psi` : ''], ['Size', b.size.trim()], ['Spare pressure', s ? `${s} psi` : '']].filter(x => x[1]);
    if (!rows.length) { $('#jerr').textContent = 'Type at least one value from the label.'; return; }
    try {
      for (const [field, value] of rows) {
        // A confirmed value is changed only by "Correct - confirm"; "Save as proposed" then adds a
        // proposed value beside it, for Rick to confirm or reject later.
        const o0 = own(field);
        if (!confirm && o0 && o0.value === value) continue;   // nothing new to keep
        const o = o0 && (confirm || o0.status !== 'confirmed') ? o0 : null;
        const body = { value, confidence: 'High', source: `Door-jamb label photo, ${day}`, note: `photo ${name}` };
        if (o) { if (o.value !== value || o.confidence !== 'High') await api('/values/' + o.id, { method: 'PATCH', body }); if (confirm && o.status !== 'confirmed') await api(`/values/${o.id}/confirm`, { method: 'POST', body: {} }); }
        else await api(`/vehicles/${v.id}/values`, { method: 'POST', body: { ...body, tab: 'tires', field, scope: 'car', status: confirm ? 'confirmed' : 'proposed' } });
      }
      nextTab = 'tires'; location.hash = '#/car/' + v.id;
    } catch (x) { $('#jerr').textContent = x.message; }
  };
  $('#jok').onclick = () => save(true); $('#jlater').onclick = () => save(false);
}
// ---------- VIN (decision 11): typed, or read from a photo of the VIN label where the browser can ----------
const canScan = 'BarcodeDetector' in window;
async function scanVin(file) {
  const want = ['code_39', 'code_128', 'data_matrix', 'qr_code', 'pdf417'];
  const have = await BarcodeDetector.getSupportedFormats().catch(() => want);
  const bd = new BarcodeDetector({ formats: want.filter(f => have.includes(f)) });
  for (const c of await bd.detect(await createImageBitmap(file))) {
    const m = String(c.rawValue || '').toUpperCase().replace(/^I(?=[A-HJ-NPR-Z0-9]{17}$)/, '').match(/[A-HJ-NPR-Z0-9]{17}/);
    if (m) return m[0];
  }
  return '';
}
const scanButton = id => canScan ? `<label class="btn" for="${id}">Scan VIN label</label><input type="file" id="${id}" accept="image/*" capture="environment" hidden>` : '';
function wireScan(id, onVin, onErr) {
  const el = $('#' + id); if (!el) return;
  el.onchange = async () => { const f = el.files && el.files[0]; if (!f) return;
    try { const vin = await scanVin(f); if (vin) onVin(vin); else onErr('No VIN barcode found in the photo. Type the VIN.'); } catch (x) { onErr('Could not read the photo. Type the VIN.'); } };
}

// ---------- Page viewer (Handoff 3 decision 5, storyboard T3) and outline mode (decision 6) ----------
// Full screen: pinch zoom, drag, double-tap to zoom on a spot, + / -, Fit page, Close. Opens on the
// chart's box if one is drawn. With a mouse or trackpad (the Mac) "Outline this chart" draws the box
// once; every car on that chart then uses it. Drag means move the page, except in outline mode.
async function viewer(id) {
  const live = fresh();
  const v = await api(`/vehicles/${id}?peek=1`); const a = v.ali;
  if (!live()) return;
  if (!a || !a.img) { location.hash = '#/car/' + id; return; }
  crumb(`${v.year} ${v.make} ${v.model} · page`);
  const fine = matchMedia('(pointer: fine)').matches;
  $('#view').innerHTML = `<div class="viewer" id="vw" role="dialog" aria-label="ALI page viewer">
    <div class="vbar"><a class="btn primary" href="#/car/${v.id}">Close</a>
      <span class="vtitle">Use chart ${esc(a.chart)}</span><span class="vsub">ALI ${esc(a.edition)} · guide p.${a.guide_page} · ${a.year_from}-${a.year_to}</span>
      <span class="vtools" id="vtools"></span></div>
    <div class="vstage" id="stage"><div class="vpage" id="vpage" style="width:${a.w}px;height:${a.h}px"><img src="${esc(a.img)}" alt="ALI ${esc(a.edition)} guide page ${a.guide_page}" draggable="false"><span class="pbox" id="vbox" hidden></span><span class="pdraw" id="vdraw" hidden></span></div>
      <p class="vhint" id="vhint">Pinch to zoom · drag to move · double-tap to zoom on a spot</p></div></div>`;
  const stage = $('#stage'), pg = $('#vpage'), W = a.w, H = a.h;
  let s = 1, x = 0, y = 0, box = a.box, mode = 'view', draft = null, err = '';
  const fit = () => Math.min(stage.clientWidth / W, stage.clientHeight / H);
  const draw = () => {
    const f = fit(); s = Math.min(Math.max(s, f), f * 8);
    const pw = W * s, ph = H * s, sw = stage.clientWidth, sh = stage.clientHeight;
    x = pw <= sw ? (sw - pw) / 2 : Math.min(0, Math.max(sw - pw, x));
    y = ph <= sh ? (sh - ph) / 2 : Math.min(0, Math.max(sh - ph, y));
    pg.style.transform = `translate(${x}px,${y}px) scale(${s})`; pg.style.setProperty('--s', s); pg.dataset.zoom = (s / f).toFixed(3);
  };
  const zoomAt = (ns, cx, cy) => { x = cx - (cx - x) * ns / s; y = cy - (cy - y) * ns / s; s = ns; draw(); };
  const center = () => [stage.clientWidth / 2, stage.clientHeight / 2];
  const fitPage = () => { s = fit(); draw(); };
  const toBox = b => { s = Math.min(stage.clientWidth / (b.w * W), stage.clientHeight / (b.h * H)) * 0.9; draw();
    x = stage.clientWidth / 2 - (b.x + b.w / 2) * W * s; y = stage.clientHeight / 2 - (b.y + b.h / 2) * H * s; draw(); };
  const showBox = () => { const el = $('#vbox'); el.hidden = !box; if (box) el.setAttribute('style', boxStyle(box)); };
  const showDraft = () => { const el = $('#vdraw'); el.hidden = !draft; if (draft) el.setAttribute('style', boxStyle(norm(draft))); };
  const norm = d => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
  const tools = () => {
    const T = $('#vtools'); stage.classList.toggle('outline', mode === 'outline');
    $('#vhint').textContent = mode === 'outline' ? `Drag a box around chart ${a.chart}, then Save box` : 'Pinch to zoom · drag to move · double-tap to zoom on a spot';
    T.innerHTML = (mode === 'outline'
      ? `<button class="primary" id="bsave" ${draft ? '' : 'disabled'}>Save box</button><button id="bcancel">Cancel</button>`
      : `<button id="zout" aria-label="Zoom out">−</button><button id="zin" aria-label="Zoom in">+</button><button id="zfit">Fit page</button>` +
        (fine ? `<button id="bout">Outline this chart</button>${box ? '<button id="bclear">Clear box</button>' : ''}` : '')) + (err ? `<span class="err">${esc(err)}</span>` : '');
    const on = (k, f) => { const b = $('#' + k); if (b) b.onclick = f; };
    on('zin', () => zoomAt(s * 1.5, ...center())); on('zout', () => zoomAt(s / 1.5, ...center())); on('zfit', fitPage);
    on('bout', () => { mode = 'outline'; draft = null; err = ''; tools(); });
    on('bcancel', () => { mode = 'view'; draft = null; showDraft(); tools(); });
    on('bclear', () => api(`/ali/boxes?edition=${encodeURIComponent(a.edition)}&chart=${encodeURIComponent(a.chart)}`, { method: 'DELETE' })
      .then(() => { box = null; showBox(); tools(); }).catch(e => { err = e.message; tools(); }));
    on('bsave', () => api('/ali/boxes', { method: 'PUT', body: { edition: a.edition, chart: a.chart, pdf_page: a.pdf_page, ...norm(draft) } })
      .then(r => { box = r.box; draft = null; mode = 'view'; err = ''; showDraft(); showBox(); tools(); }).catch(e => { err = e.message; tools(); }));
  };
  // Pointers: one = drag (or draw in outline mode), two = pinch about their middle.
  const pts = new Map(); let start = null, moved = false, lastTap = 0, lastXY = null;
  const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onPage = ([px, py]) => [Math.min(1, Math.max(0, (px - x) / s / W)), Math.min(1, Math.max(0, (py - y) / s / H))];
  const snap = () => { const p = [...pts.values()]; const two = p.length > 1;
    return { n: p.length, s, x, y, mid: two ? [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2] : p[0], dist: two ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0 }; };
  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.vhint')) return;
    try { stage.setPointerCapture(e.pointerId); } catch (x) { /* a pointer the browser no longer tracks */ }
    pts.set(e.pointerId, local(e)); moved = false;
    if (mode === 'outline' && pts.size === 1) { const [px, py] = onPage(local(e)); draft = { x0: px, y0: py, x1: px, y1: py }; showDraft(); return; }
    start = snap();
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, local(e));
    if (mode === 'outline') { if (draft) { [draft.x1, draft.y1] = onPage(local(e)); showDraft(); } return; }
    const now = snap(); if (!start || now.n !== start.n) { start = now; return; }
    if (Math.hypot(now.mid[0] - start.mid[0], now.mid[1] - start.mid[1]) > 6 || now.n > 1) moved = true;
    s = start.s; x = start.x; y = start.y;
    if (now.n > 1 && start.dist) { x += now.mid[0] - start.mid[0]; y += now.mid[1] - start.mid[1]; zoomAt(start.s * now.dist / start.dist, now.mid[0], now.mid[1]); }
    else { x += now.mid[0] - start.mid[0]; y += now.mid[1] - start.mid[1]; draw(); }
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return; const p = local(e); pts.delete(e.pointerId);
    if (mode === 'outline') { if (draft) { const b = norm(draft); if (b.w < 0.01 || b.h < 0.01) draft = null; showDraft(); tools(); } return; }
    if (pts.size) { start = snap(); return; }
    if (moved) return;
    const t = Date.now();
    if (t - lastTap < 350 && lastXY && Math.hypot(p[0] - lastXY[0], p[1] - lastXY[1]) < 40) { const f = fit(); zoomAt(s > f * 1.5 ? f : s * 2.5, p[0], p[1]); lastTap = 0; }
    else { lastTap = t; lastXY = p; }
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => { e.preventDefault(); const p = local(e); zoomAt(s * Math.exp(-e.deltaY * 0.002), p[0], p[1]); }, { passive: false });
  const onResize = () => { if (stage.isConnected) draw(); else removeEventListener('resize', onResize); };
  addEventListener('resize', onResize);
  tools(); showBox();
  if (box) toBox(box); else fitPage();
}

// ---------- Apps (HANDOFF 6) ----------
// Tiles from /api/apps. A tile is a plain link without a target, so it opens in the same tab and
// Fully Kiosk stays on one page. Only http(s) addresses become links. Icons are drawn here.
const ICONS = {
  apps: '<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/>',
  cctv: '<path d="M2 6.5l15-3 1.5 6-15 3zM16 12.5l-1.5 2.5H9v4H6v2H3v-7h3v2h1.5l1-2.5z"/><path d="M19 6l3-1v5l-3 1z"/>' };
const appIcon = n => `<svg aria-hidden="true" viewBox="0 0 24 24">${ICONS[n] || ICONS.apps}</svg>`;
let appsBack = '#/', appsTab = null;   // Back on the Apps screen: the screen (and car tab) it came from
async function appsPage() {
  const live = fresh();
  const list = await api('/apps');
  if (!live()) return;
  crumb('Apps');
  const tiles = list.filter(a => /^https?:\/\//i.test(a.url))
    .map(a => `<a class="carbtn apptile" href="${esc(a.url)}">${appIcon(a.icon)}<b>${esc(a.name)}</b></a>`).join('');
  $('#view').innerHTML = `<div class="carhead"><a class="btn" href="${esc(appsBack)}">Back</a><h2>Apps</h2></div>
    ${tiles ? `<div class="apps">${tiles}</div>` : '<div class="empty">No apps yet.</div>'}`;
}

// ---------- Router ----------
async function route() {
  const h = location.hash || '#/';
  routeSeq++;
  $('#hnav').innerHTML = '';   // the home screen fills it
  try {
    if (!device) pickDevice();
    else if (h === '#/add') add();
    else if (h === '#/confirm') await confirmPage();
    else if (h === '#/apps') await appsPage();
    else if (/^#\/car\/\d+\/page$/.test(h)) await viewer(h.split('/')[2]);
    else if (/^#\/car\/\d+\/jamb$/.test(h)) await jamb(h.split('/')[2]);
    else if (/^#\/car\/\d+\/jamb\/[0-9TZ-]+\.(jpg|png|webp)$/.test(h)) await jambRead(h.split('/')[2], h.split('/')[4]);
    else if (h.startsWith('#/car/')) await car(h.slice(6));
    else await home();
  } catch (e) { fail(e); }
}
let nextTab = null;   // a screen that sends Rick back to a car can name the tab to open
addEventListener('hashchange', e => {
  const from = new URL(e.oldURL).hash || '#/', to = location.hash || '#/';
  if (to === '#/apps' && from !== '#/apps') { appsBack = from; appsTab = tab; }   // remember where Apps was opened
  else if (from === '#/apps' && to === appsBack && appsTab) nextTab = appsTab;     // Back opens the same car tab
  tab = nextTab || 'lift'; nextTab = null; route();
});
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
