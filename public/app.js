// LiftPad front end. Hash routes: #/  #/add  #/car/<id>  #/confirm
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
function fail(e) { $('#view').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><a class="btn" href="#/">Back to my cars</a></div>`; }
const GROUP = { mine: 'My cars', frequent: 'Frequent', visitor: 'Visitors' };
const pill = s => `<span class="pill ${s === 'confirmed' ? 'High' : s === 'rejected' ? 'Missing' : 'Low'}">${s === 'confirmed' ? 'Confirmed' : s === 'rejected' ? 'Rejected' : 'Proposed'}</span>`;
const when = t => t ? String(t).slice(0, 16).replace('T', ' ') : '';

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
async function home() {
  crumb('My cars');
  const [cars, need] = await Promise.all([api('/vehicles' + (showHidden ? '?hidden=1' : '')), api('/needs-confirming')]);
  const btn = c => `<a class="carbtn" href="#/car/${c.id}"><b>${c.year} ${esc(c.make)} ${esc(c.model)}</b><span>${esc(c.trim)}${c.hidden ? ' · hidden' : ''}</span></a>`;
  const sec = g => { const cs = cars.filter(c => c.grp === g); return cs.length || g === 'mine' ? `<h2 class="lbl">${GROUP[g]}</h2><div class="cars">${cs.map(btn).join('')}${g === 'mine' ? '<a class="carbtn add" href="#/add">+ Add car</a>' : ''}</div>` : ''; };
  $('#view').innerHTML = `${need.count ? `<a class="warn" href="#/confirm" style="display:block">Needs confirming: <b>${need.count}</b> value${need.count === 1 ? '' : 's'}</a>` : ''}
    ${sec('mine')}${sec('frequent')}${sec('visitor')}
    <label class="note" style="display:flex;gap:8px;align-items:center;min-height:44px"><input type="checkbox" id="showhid" ${showHidden ? 'checked' : ''}> Show hidden visitors (not seen for 30 days)</label>
    <p class="src">This screen: ${esc(device)} · <a href="#/" id="rename">change</a></p>`;
  $('#showhid').onchange = e => { showHidden = e.target.checked; home(); };
  $('#rename').onclick = e => { e.preventDefault(); pickDevice(); };
}

// ---------- Needs confirming ----------
async function confirmPage() {
  crumb('Needs confirming');
  const d = await api('/needs-confirming');
  $('#view').innerHTML = `<section class="card"><h2>Needs confirming (${d.count})</h2>
    <p class="note">Check each value against the manual or the door placard, then confirm or reject it.</p>
    <dl>${d.values.map(x => `<dt>${esc(x.make)} ${esc(x.model)} ${x.year_from}${x.year_to !== x.year_from ? '-' + x.year_to : ''} · ${esc(x.tab)} · ${esc(x.field)}</dt>
      <dd><span class="val">${esc(x.value)}</span><span class="pill ${x.confidence}">${x.confidence}</span><div class="src">${esc(x.source)}</div>${x.note ? `<div class="note">${esc(x.note)}</div>` : ''}
      <div class="row"><button class="primary" data-ok="${x.id}">Confirm</button><button class="ghost" data-no="${x.id}">Reject</button></div></dd>`).join('') || '<dd class="note">Nothing to confirm.</dd>'}</dl></section>
    <a class="btn" href="#/">My cars</a>`;
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
  $('#view').innerHTML = `<div class="grid"><section class="form">
    <div class="field"><label for="make">Make</label><input id="make" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Type 2-3 letters"><ul class="list" id="make-list" role="listbox" hidden></ul></div>
    <div class="field"><label for="year">Year</label><input id="year" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits" disabled></div>
    <div class="field"><label for="model">Model</label><input id="model" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Pick make and year first" disabled><ul class="list" id="model-list" role="listbox" hidden></ul></div>
    <div class="field"><label for="trim">Trim / engine (optional)</label><input id="trim" autocomplete="off" placeholder="e.g. Trailhawk 5.7L"></div>
    <div class="field"><label for="grp">Group</label><select id="grp"><option value="visitor">Visitor</option><option value="frequent">Frequent</option><option value="mine">My car</option></select></div>
    <div class="or">or</div>
    <div class="field"><label for="vin">VIN</label><div class="row"><input id="vin" maxlength="17" autocomplete="off" placeholder="17 characters" style="font-family:var(--mono)"><button type="button" id="vin-go">Decode</button></div></div>
  </section><section class="card" id="res"><h2>Pick a car</h2><p class="note">Type a make. "stu" finds Studebaker, "ram" finds Ram.</p></section></div>`;
  const show = async () => {
    const R = $('#res');
    if (!st.make || !st.year || !st.model) { R.innerHTML = `<h2>${esc([st.year || '', st.make].join(' ').trim() || 'Pick a car')}</h2><p class="note">${st.make ? (st.year ? 'Pick a model.' : 'Type the 4-digit year.') : 'Type a make.'}</p>`; return; }
    R.innerHTML = `<h2>${st.year} ${esc(st.make)} ${esc(st.model)}</h2><p class="note">${st.chartNote || ''}</p><button class="primary" id="save">Save car</button><p class="err" id="saveerr"></p>`;
    $('#save').onclick = async () => {
      try { const v = await api('/vehicles', { method: 'POST', body: { ...st, trim: $('#trim').value.trim(), grp: $('#grp').value } }); location.hash = '#/car/' + v.id; }
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
      $('#make').value = d.make; $('#year').value = d.year || ''; $('#year').disabled = false; $('#model').value = d.model; $('#model').disabled = false; $('#trim').value = d.trim;
      st.chartNote = d.error ? 'NHTSA note: ' + d.error : 'Decoded by NHTSA. Check make and model match the lists.'; show(); }
    catch (e) { R.innerHTML = `<h2>VIN</h2><p class="err">${esc(e.message)}</p>`; }
  };
  $('#make').focus();
}

// ---------- Car ----------
let tab = 'lift';
let meta = null;
async function car(id) {
  if (!meta) meta = await api('/tabs');
  const v = await api('/vehicles/' + id);
  crumb(`${v.year} ${v.make} ${v.model}`);
  if (!meta.tabs.some(t => t.name === tab)) tab = meta.tabs[0]?.name || 'lift';
  const rows = v.values.filter(s => s.tab === tab);
  let ali = '';
  if (tab === 'lift') {
    const a = v.ali;
    if (!a) ali = `<div class="warn bad">No ALI chart for this car in the 2019 guide.</div>`;
    else if (a.d === 0) ali = `<dl><dt>ALI chart</dt><dd><span class="val">${esc(a.chart)}</span><span class="pill ${a.status === 'ok' ? 'High' : 'Missing'}">${a.status === 'ok' ? 'High' : 'Missing'}</span><div class="src">guide p.${a.guide_page}${a.pdf_page ? ' · PDF p.' + a.pdf_page : ''} · ${a.year_from}-${a.year_to}</div></dd></dl>`;
    else ali = `<div class="warn">ALI chart ${esc(a.chart)} covers ${a.year_from}-${a.year_to}, not ${v.year}. Check it is the same body before you use it. (guide p.${a.guide_page})</div>`;
  }
  const job = v.jobs[0];
  const jobLine = !job ? '' : job.status === 'done' ? `<span class="warn">Results ready - confirm${job.result_summary ? ' (' + esc(job.result_summary) + ')' : ''}</span>`
    : job.status === 'failed' ? `<span class="warn bad">Research failed: ${esc(job.error)}</span>` : `<span class="note">${job.status === 'claimed' ? 'Researching' : 'Queued'}</span>`;
  const valueDd = s => `<dd data-v="${s.id}"><span class="val">${esc(s.value)}</span><span class="pill ${s.confidence}">${s.confidence}</span>${pill(s.status)}${s.scope === 'car' ? '<span class="tag">this car only</span>' : `<span class="tag">${s.year_from}${s.year_to !== s.year_from ? '-' + s.year_to : ''}</span>`}
    <div class="src">${esc(s.source)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
    <div class="row">${s.status === 'proposed' ? `<button class="primary" data-ok="${s.id}">Confirm</button><button class="ghost" data-no="${s.id}">Reject</button>` : ''}<button class="ghost" data-h="${s.id}">History</button><button class="edit ghost" data-e="${s.id}">Edit</button></div><div class="hist"></div></dd>`;
  $('#view').innerHTML = `<section class="card">
    <div><h2>${v.year} ${esc(v.make)} ${esc(v.model)}</h2><div class="src">${esc(v.trim)} · ${GROUP[v.grp]}</div></div>
    <div class="tabs" role="tablist">${meta.tabs.map(t => `<button role="tab" aria-selected="${tab === t.name}" data-t="${t.name}">${esc(t.label)}</button>`).join('')}</div>
    ${rows.filter(s => s.warn).map(s => `<div class="warn"><b>${esc(s.field)}:</b> ${esc(s.value)} ${pill(s.status)}</div>`).join('')}
    ${ali}
    <dl>${rows.filter(s => !s.warn).map(s => `<dt>${esc(s.field)}${s.is_safety ? ' <span class="tag">safety</span>' : ''}</dt>${valueDd(s)}`).join('') || '<dt>Values</dt><dd class="note">Nothing yet. Add the first value below, or tap Research.</dd>'}</dl>
    <details id="addspec"><summary class="lbl" style="cursor:pointer;min-height:44px;display:flex;align-items:center">+ Add a ${esc(meta.tabs.find(t => t.name === tab)?.label || tab)} value</summary>${valueForm(v)}</details>
  </section>
  <div class="row"><button id="research">Research missing values</button>${jobLine}</div>
  <div class="row">${Object.keys(GROUP).filter(g => g !== v.grp).map(g => `<button class="ghost" data-g="${g}">Move to ${GROUP[g]}</button>`).join('')}</div>
  <div class="row"><a class="btn" href="#/">My cars</a><button class="ghost" id="del">Delete car</button></div><p id="delmsg"></p>`;
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; car(id); });
  wireStatus(() => car(id));
  document.querySelectorAll('[data-h]').forEach(b => b.onclick = async () => {
    const box = b.closest('dd').querySelector('.hist');
    const h = await api(`/values/${b.dataset.h}/history`);
    box.innerHTML = `<ol class="src">${h.map(r => `<li>${when(r.at)} · ${esc(r.device)} · ${r.action}${r.old_value != null && r.old_value !== r.new_value ? ` · "${esc(r.old_value)}" → "${esc(r.new_value ?? '')}"` : r.new_value != null ? ` · "${esc(r.new_value)}"` : ''}${r.old_status !== r.new_status ? ` · ${esc(r.old_status ?? '')} → ${esc(r.new_status ?? '')}` : ''}</li>`).join('')}</ol>`;
  });
  wireForm($('#addspec form'), body => api(`/vehicles/${id}/values`, { method: 'POST', body: { ...body, tab, status: body.confirm ? 'confirmed' : 'proposed' } }).then(() => car(id)));
  document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const s = v.values.find(x => x.id == b.dataset.e); const dd = b.closest('dd'); dd.innerHTML = editForm(s);
    wireForm(dd.querySelector('form'), body => api('/values/' + s.id, { method: 'PATCH', body }).then(() => car(id)), () => api('/values/' + s.id, { method: 'DELETE' }).then(() => car(id)));
  });
  document.querySelectorAll('[data-g]').forEach(b => b.onclick = () => api('/vehicles/' + id, { method: 'PATCH', body: { grp: b.dataset.g } }).then(() => car(id)).catch(fail));
  $('#research').onclick = () => api('/jobs', { method: 'POST', body: { vehicle_id: +id, kind: 'research' } }).then(() => car(id)).catch(e => { $('#delmsg').textContent = e.message; });
  $('#del').onclick = () => { $('#delmsg').innerHTML = `This deletes the car and its own values. Values for the model and year stay. <button class="primary" id="del2">Yes, delete</button>`; $('#del2').onclick = () => api('/vehicles/' + id, { method: 'DELETE' }).then(() => location.hash = '#/'); };
}
function valueForm(v) {
  const fs = meta.fields.filter(f => f.tab === tab);
  return `<form class="form" style="margin-top:12px"><div class="field"><label>Field</label><select name="field">${fs.map(f => `<option>${esc(f.name)}</option>`).join('')}</select></div>
  <div class="field"><label>Value</label><input name="value" placeholder="e.g. 100 ft-lb" required></div>
  <div class="field"><label>Confidence</label><select name="confidence">${['High', 'Medium', 'Low'].map(c => `<option>${c}</option>`).join('')}</select></div>
  <div class="field"><label>Source</label><input name="source" placeholder="Where it came from"></div>
  <div class="field"><label>Note</label><input name="note"></div>
  <div class="field"><label>Applies to</label><select name="scope"><option value="model">Every ${esc(v.make)} ${esc(v.model)} in these years</option><option value="car">This car only (override)</option></select></div>
  <div class="row"><div class="field"><label>From year</label><input name="year_from" inputmode="numeric" maxlength="4" value="${v.year}"></div><div class="field"><label>To year</label><input name="year_to" inputmode="numeric" maxlength="4" value="${v.year}"></div></div>
  <label class="note" style="display:flex;gap:8px;align-items:center;min-height:44px"><input type="checkbox" name="confirm" value="1"> I checked this value - mark it confirmed</label>
  <div class="row"><button class="primary" type="submit">Save</button></div><p class="err"></p></form>`;
}
function editForm(s) {
  return `<form class="form" style="margin-top:12px">
  <div class="field"><label>Value</label><input name="value" value="${esc(s.value)}" required></div>
  <div class="field"><label>Confidence</label><select name="confidence">${['High', 'Medium', 'Low'].map(c => `<option ${s.confidence === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
  <div class="field"><label>Source</label><input name="source" value="${esc(s.source)}"></div>
  <div class="field"><label>Note</label><input name="note" value="${esc(s.note)}"></div>
  <div class="row"><button class="primary" type="submit">Save</button><button type="button" class="ghost" data-rm>Delete value</button></div><p class="err"></p></form>`;
}
function wireForm(f, save, remove) {
  if (!f) return;
  f.onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); try { await save(b); } catch (x) { f.querySelector('.err').textContent = x.message; } };
  const rm = f.querySelector('[data-rm]'); if (rm && remove) rm.onclick = () => remove().catch(x => f.querySelector('.err').textContent = x.message);
}

// ---------- Router ----------
async function route() {
  const h = location.hash || '#/';
  try {
    if (!device) pickDevice();
    else if (h === '#/add') add();
    else if (h === '#/confirm') await confirmPage();
    else if (h.startsWith('#/car/')) await car(h.slice(6));
    else await home();
  } catch (e) { fail(e); }
}
addEventListener('hashchange', () => { tab = 'lift'; route(); });
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
