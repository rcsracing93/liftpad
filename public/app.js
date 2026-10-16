// LiftPad front end. Hash routes: #/  #/add  #/car/<id>
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TABS = { lift: 'Lift', torque: 'Torque', tires: 'Tires' };
async function api(path, opt = {}) {
  const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const d = await r.json().catch(() => ({ error: 'Bad response from server' }));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  $('#net').hidden = r.headers.get('x-liftpad-cache') !== 'offline';
  return d;
}
function crumb(t) { $('#crumb').textContent = t || ''; }
function fail(e) { $('#view').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><a class="btn" href="#/">Back to my cars</a></div>`; }

// ---------- Home ----------
async function home() {
  crumb('My cars');
  const cars = await api('/vehicles');
  $('#view').innerHTML = `<div class="cars">${cars.map(c => `<a class="carbtn" href="#/car/${c.id}"><b>${c.year} ${esc(c.make)} ${esc(c.model)}</b><span>${esc(c.trim)}</span></a>`).join('')}
    <a class="carbtn add" href="#/add">+ Add car</a></div>`;
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
    <div class="or">or</div>
    <div class="field"><label for="vin">VIN</label><div class="row"><input id="vin" maxlength="17" autocomplete="off" placeholder="17 characters" style="font-family:var(--mono)"><button type="button" id="vin-go">Decode</button></div></div>
  </section><section class="card" id="res"><h2>Pick a car</h2><p class="note">Type a make. "stu" finds Studebaker, "ram" finds Ram.</p></section></div>`;
  const show = async () => {
    const R = $('#res');
    if (!st.make || !st.year || !st.model) { R.innerHTML = `<h2>${esc([st.year || '', st.make].join(' ').trim() || 'Pick a car')}</h2><p class="note">${st.make ? (st.year ? 'Pick a model.' : 'Type the 4-digit year.') : 'Type a make.'}</p>`; return; }
    R.innerHTML = `<h2>${st.year} ${esc(st.make)} ${esc(st.model)}</h2><p class="note">${st.chartNote || ''}</p><button class="primary" id="save">Save car</button><p class="err" id="saveerr"></p>`;
    $('#save').onclick = async () => {
      try { const v = await api('/vehicles', { method: 'POST', body: { ...st, trim: $('#trim').value.trim() } }); location.hash = '#/car/' + v.id; }
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
async function car(id) {
  const v = await api('/vehicles/' + id);
  crumb(`${v.year} ${v.make} ${v.model}`);
  const rows = v.specs.filter(s => s.tab === tab);
  let ali = '';
  if (tab === 'lift') {
    const a = v.ali;
    if (!a) ali = `<div class="warn bad">No ALI chart for this car in the 2019 guide.</div>`;
    else if (a.d === 0) ali = `<dl><dt>ALI chart</dt><dd><span class="val">${esc(a.chart)}</span><span class="pill ${a.status === 'ok' ? 'High' : 'Missing'}">${a.status === 'ok' ? 'High' : 'Missing'}</span><div class="src">guide p.${a.guide_page}${a.pdf_page ? ' · PDF p.' + a.pdf_page : ''} · ${a.year_from}-${a.year_to}</div></dd></dl>`;
    else ali = `<div class="warn">ALI chart ${esc(a.chart)} covers ${a.year_from}-${a.year_to}, not ${v.year}. Check it is the same body before you use it. (guide p.${a.guide_page})</div>`;
  }
  $('#view').innerHTML = `<section class="card">
    <div><h2>${v.year} ${esc(v.make)} ${esc(v.model)}</h2><div class="src">${esc(v.trim)}</div></div>
    <div class="tabs" role="tablist">${Object.entries(TABS).map(([k, t]) => `<button role="tab" aria-selected="${tab === k}" data-t="${k}">${t}</button>`).join('')}</div>
    ${rows.filter(s => s.warn).map(s => `<div class="warn"><b>${esc(s.field)}:</b> ${esc(s.value)}</div>`).join('')}
    ${ali}
    <dl>${rows.filter(s => !s.warn).map(s => `<dt>${esc(s.field)}</dt><dd><span class="val">${esc(s.value)}</span><span class="pill ${s.confidence}">${s.confidence}</span><div class="src">${esc(s.source)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}<button class="edit ghost" data-e="${s.id}">Edit</button></dd>`).join('') || '<dt>Values</dt><dd class="note">Nothing yet. Add the first value below.</dd>'}</dl>
    <details id="addspec"><summary class="lbl" style="cursor:pointer;min-height:44px;display:flex;align-items:center">+ Add a ${TABS[tab]} value</summary>${specForm()}</details>
  </section>
  <div class="row"><a class="btn" href="#/">My cars</a><button class="ghost" id="del">Delete car</button></div><p id="delmsg"></p>`;
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; car(id); });
  wireForm($('#addspec form'), body => api(`/vehicles/${id}/specs`, { method: 'POST', body: { ...body, tab } }).then(() => car(id)));
  document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const s = v.specs.find(x => x.id == b.dataset.e); const dd = b.closest('dd'); dd.innerHTML = specForm(s);
    wireForm(dd.querySelector('form'), body => api('/specs/' + s.id, { method: 'PATCH', body }).then(() => car(id)), () => api('/specs/' + s.id, { method: 'DELETE' }).then(() => car(id)));
  });
  $('#del').onclick = () => { $('#delmsg').innerHTML = `This deletes the car and all its values. <button class="primary" id="del2">Yes, delete</button>`; $('#del2').onclick = () => api('/vehicles/' + id, { method: 'DELETE' }).then(() => location.hash = '#/'); };
}
function specForm(s = {}) {
  return `<form class="form" style="margin-top:12px"><div class="field"><label>Name</label><input name="field" value="${esc(s.field)}" placeholder="e.g. Torque" required></div>
  <div class="field"><label>Value</label><input name="value" value="${esc(s.value)}" placeholder="e.g. 100 ft-lb" required></div>
  <div class="field"><label>Confidence</label><select name="confidence">${['High', 'Medium', 'Low'].map(c => `<option ${s.confidence === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
  <div class="field"><label>Source</label><input name="source" value="${esc(s.source)}" placeholder="Where it came from"></div>
  <div class="field"><label>Note</label><input name="note" value="${esc(s.note)}"></div>
  <div class="row"><button class="primary" type="submit">Save</button>${s.id ? '<button type="button" class="ghost" data-rm>Delete value</button>' : ''}</div><p class="err"></p></form>`;
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
    if (h === '#/add') add();
    else if (h.startsWith('#/car/')) await car(h.slice(6));
    else await home();
  } catch (e) { fail(e); }
}
addEventListener('hashchange', () => { tab = 'lift'; route(); });
route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
