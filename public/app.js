// LiftPad front end. Hash routes: #/  #/add  #/car/<id>  #/car/<id>/page (page viewer)  #/confirm  #/apps
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Device label (decision 7): picked once per browser, sent with every call, used in the history.
const store = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: ask again next time */ } } };
let device = store.get('lp-device');
async function api(path, opt = {}) {
  const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json', 'x-lp-device': device }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const d = await r.json().catch(() => ({ error: 'Bad response from server' }));
  setOffline(r.headers.get('x-liftpad-cache') === 'offline', Number(r.headers.get('x-liftpad-saved')) || 0);
  if (!r.ok) { const e = new Error(d.error || ('HTTP ' + r.status)); e.data = d; throw e; }   // e.data: the whole answer (for example check_failed on a VIN)
  return d;
}
// HANDOFF 19 (D6): the banner under the header says how old the saved copy is. The service worker stamps each saved answer (x-liftpad-saved).
function savedAgo(ms) {
  if (!ms) return 'earlier';
  const h = Math.floor((Date.now() - ms) / 36e5), d = Math.floor(h / 24);
  return d >= 1 ? (d === 1 ? '1 day ago' : `${d} days ago`) : h >= 1 ? (h === 1 ? '1 hour ago' : `${h} hours ago`) : 'less than an hour ago';
}
function setOffline(off, savedMs) {
  document.body.classList.toggle('offline', off);
  const n = $('#net'); n.hidden = !off;
  if (off) n.textContent = `Offline - data saved ${savedAgo(savedMs || Number(store.get('lp-saved')) || 0)}`;
}
function crumb(t, html) { $('#crumb').textContent = t || ''; $('#carline').textContent = t || ''; if (html) { $('#crumb').innerHTML = html; $('#carline').innerHTML = html; } }
// A screen that loads slowly must not draw over a newer one (a fast tap to another screen): route()
// counts, and a screen draws only while its count is still the newest.
let routeSeq = 0;
const fresh = () => { const s = routeSeq; return () => s === routeSeq; };
function fail(e) { $('#view').innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><a class="btn" href="#/">Back to my cars</a></div>`; }
const GROUP = { mine: 'My cars', frequent: 'Frequent', visitor: 'Visitors' };
const pill = s => `<span class="pill st-${esc(s)}">${s === 'confirmed' ? 'Confirmed' : s === 'rejected' ? 'Rejected' : 'Proposed'}</span>`;
// The key numbers (decision 1: 48 px on the lift screen): torque, tire pressures, oil quantity.
const KEY = new Set(['Torque', 'Pressure', 'Spare pressure', 'Quantity', 'Oil type']);
const keyCls = s => KEY.has(s.field) && /^\s*~?\d/.test(showVal(s)) ? ' key' : '';
// HANDOFF 15: "Hyundai Sonata" card text. The owner is shown only when it is not Rick (Rick's cards stay as they were).
const ownerOf = c => c.owner && !/^rick$/i.test(c.owner.trim()) ? `${c.owner.trim()}'s ` : '';
const carName = c => `${ownerOf(c)}${c.year} ${c.make} ${c.model}`;
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
// Display only (Rick 2026-10-27): the stored text keeps its N-m part, the screen never shows it. "130 ft-lb (176 Nm)" -> "130 ft-lb";
// "140 N·m (manual: 101 ft-lb)" -> "101 ft-lb"; a text with N-m only is converted.
const NM = /(?<![A-Za-z])N[·.\s-]?m(?![A-Za-z])/i;
const noNm = t => {
  const x = String(t ?? '');
  if (!NM.test(x)) return x;
  const ft = x.match(/(\d+(?:\s*[-–]\s*\d+)?)\s*ft[ -]?lbs?/i);
  if (ft) return ft[1].replace(/\s+/g, '') + ' ft-lb';
  return x.replace(/(\d+)\s*N[·.\s-]?m(?![A-Za-z])/gi, (_, n) => Math.round(+n * 0.737562) + ' ft-lb');
};
// HANDOFF 19 (D7): "21mm" is shown "21 mm"; a tire pressure always says "cold" (the door-jamb label is a cold pressure).
const tidy = t => String(t ?? '').replace(/(\d)(mm)\b/g, '$1 $2');
const showVal = s => {
  // HANDOFF 15: torque is shown from the stored ft-lb numbers. No N-m on screen.
  if (s.tab === 'torque' && s.field === 'Torque' && s.ftlb_lo != null) return `${s.ftlb_lo}${s.ftlb_hi != null ? '-' + s.ftlb_hi : ''} ft-lb`;
  if (s.tab === 'tires' && /^(Spare )?[Pp]ressure$/.test(s.field) && /\bpsi\b/i.test(s.value) && !/cold/i.test(s.value)) return `${s.value} cold`;
  const m =s.tab === 'oil' && s.field === 'Quantity' && String(s.value).match(/^(\d+(?:\.\d+)?)\s*(qt|L)$/i);
  if (!m) return tidy(s.value);
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
  // HANDOFF 18 (C3): the gear button shows only when the Admin page answers (Rick's own login); a red dot when anything is red.
  const [cars, need, dot] = await Promise.all([api('/vehicles' + (showHidden ? '?hidden=1' : '')), api('/needs-confirming'), api('/admin/dot').catch(() => null)]);
  if (!live()) return;
  crumb('');
  // HANDOFF 19 (D5): cars first; History, Needs confirming, Admin and + Car are one row under the cars (the bottom of the list on the phone). Apps stays in the header (tablet) or ends the row (phone).
  const gear = dot ? `<a class="btn gear" id="gearbtn" href="#/admin" aria-label="Admin${dot.level === 'red' ? ' - something is red' : ''}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L14.9 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.9h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM12.9 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>Admin${dot.level === 'red' ? '<span class="reddot" role="img" aria-label="red"></span>' : ''}</a>` : '';
  const btnRow = `<nav class="homerow" aria-label="Home buttons"><a class="btn" href="#/history">History</a><a class="btn" href="#/confirm">Needs confirming<span class="count">${need.count}</span></a>${gear}<a class="btn primary" href="#/add">+ Car</a><a class="btn phoneonly" href="#/apps">Apps</a></nav>`;
  // HANDOFF 10: Home shows only a block (warn = 2, an open problem). A caution (warn = 1) is on the car screen only.
  // HANDOFF 19 (D5): the real proposals first, then "No VIN" and "No door card", as one line.
  const status = c => c.nblock ? ['warn', 'Warning - do not lift yet'] : c.nproposed ? ['todo', `${c.nproposed} value${c.nproposed === 1 ? '' : 's'} to confirm`]
    : c.nvals ? ['ok', 'All values confirmed'] : ['none', 'No values yet'];
  // Suggestion 11: one grey line with the last visit, not the history.
  const lastSvc = c => c.last_service ? `<span class="lastsvc">Last: ${esc(c.last_service.items.join(', '))}, ${esc(c.last_service.date)}, ${Number(c.last_service.mileage).toLocaleString('en-US')} mi</span>` : '';
  // HANDOFF 17 (B10): "No VIN" and "No door card", computed by the Worker.
  const badges = c => c.no_vin || c.no_doorcard ? `${c.no_vin ? '<span class="pill Missing">No VIN</span>' : ''}${c.no_doorcard ? '<span class="pill Missing">No door card</span>' : ''}` : '';
  const tile = c => { const [k, t] = status(c); return `<a class="carbtn" href="#/car/${c.id}"><b>${esc(ownerOf(c))}${c.year} ${esc(c.make)} ${esc(c.model)}</b><span>${esc(c.trim)}${c.hidden ? ' · hidden' : ''}</span><span class="status ${k}"><span class="stxt">${t}</span>${badges(c)}</span>${lastSvc(c)}</a>`; };
  const ago = c => { const d = Math.floor((Date.now() - Date.parse(c.last_seen || c.created_iso || 0)) / 864e5); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`; };
  const g = k => cars.filter(c => c.grp === k);
  $('#view').innerHTML = `<section aria-label="My cars" class="tabbody"><h2 class="lbl">My cars</h2><div class="cars">${g('mine').map(tile).join('') || '<div class="empty">No cars yet. Tap + Car.</div>'}</div></section>
    <section aria-label="Frequent" class="tabbody"><h2 class="lbl">Frequent</h2><div class="cars">${g('frequent').map(tile).join('')}${g('frequent').length < 3 ? '<div class="empty">Mark a visitor Frequent to keep it here</div>' : ''}</div></section>
    ${btnRow}
    <section aria-label="Visitors" class="tabbody"><h2 class="lbl">Visitors - hidden 30 days after the last visit</h2>
      <div class="chips">${g('visitor').map(c => `<a class="chip" href="#/car/${c.id}">${c.year} ${esc(c.make)} ${esc(c.model)}<span>${c.hidden ? 'hidden · ' : ''}${ago(c)}</span></a>`).join('') || '<div class="empty">No visitors</div>'}</div>
      ${showHidden ? '<p class="note">Hidden visitors are shown. Turn this off on the Admin page.</p>' : ''}</section>`;
  prefetchAll(cars);
}
// HANDOFF 19 (D6): when Home loads online, the pages of all cars and the chart images of Rick's cars are fetched in the background, so the
// service worker holds a copy. peek=1: a prefetch must not set the "last seen" time of a visitor. At most once in 10 minutes.
let prefetching = false;
async function prefetchAll(cars) {
  // The service worker must be in control, or the answers are not saved (its first load: controllerchange below starts Home again).
  if (prefetching || !navigator.onLine || !(navigator.serviceWorker && navigator.serviceWorker.controller) || Date.now() - (Number(store.get('lp-saved')) || 0) < 600000) return;
  prefetching = true;
  try {
    await api('/tabs');
    for (const c of cars) {
      const v = await api(`/vehicles/${c.id}?peek=1`);
      await api(`/vehicles/${c.id}/service`);
      if (c.grp !== 'visitor' && v.ali && v.ali.img) await fetch(v.ali.img);
    }
    store.set('lp-saved', String(Date.now()));
  } catch (e) { /* went offline in between: the next Home load tries again */ }
  prefetching = false;
}

// ---------- Admin (HANDOFF 18, C3, C6) ----------
// Rick's own login only (the Worker answers 403 to every other caller). Kuma stays the alerting; this page is where he looks for the why.
let adminDay = '', adminKind = '';
const LV = { green: 'OK', amber: 'Check', red: 'Problem', info: 'Info' };   // info: grey, no colour judgement (D1 free-limit % on Workers Paid)
const lvPill = l => `<span class="pill lv-${esc(l)}" style="margin-left:0">${LV[l] || esc(l)}</span>`;
const ITEM_LABEL = { disk_root: 'Disk (N100)', disk_nas: 'Disk (NAS)', backup_file: 'Last backup', backup_nas_copy: 'NAS copy of the backup', backup_nas_mount: 'NAS backups share', backup_run: 'Backup job',
  health_ping_run: 'Health ping job', token_check_run: 'Token check job', token_expiry: 'Token expiry', research_worker_run: 'Research worker', research_cost: 'Research cost',
  service_log_export: 'Service log export', n100_report: 'N100 report' };
const itemLabel = i => ITEM_LABEL[i.name] || String(i.name).replace(/^d1_/, 'D1 ').replace(/_/g, ' ');
const aitem = i => `<li class="aitem lv-${esc(i.level)}">${lvPill(i.level)} <b>${esc(itemLabel(i))}</b><span class="areason">${esc(i.reason)}</span>${i.data && i.data.expires ? `<span class="areason src">Expires: ${Object.entries(i.data.expires).map(([k, d]) => `${esc(k.replace(/_/g, ' '))} ${esc(d)}`).join(', ')}</span>` : ''}</li>`;
async function adminPage() {
  const live = fresh();
  let d;
  try { d = await api('/admin/status?' + new URLSearchParams({ ...(adminDay ? { day: adminDay } : {}), ...(adminKind ? { kind: adminKind } : {}) })); }
  catch (e) { if (!live()) return; crumb('Admin'); $('#view').innerHTML = `<section class="card"><h2>Admin</h2><p class="err">${esc(e.message)}</p><a class="btn" href="#/">Home</a></section>`; return; }
  if (!live()) return;
  crumb('Admin');
  adminDay = d.day;
  const q = d.queue, w = d.worker_runs, r = d.results;
  const lr = w.last_run;
  const money = n => n == null ? '-' : '$' + Number(n).toFixed(2);
  const KINDS = ['queue', 'worker_run', 'health', 'backup', 'token_check', 'export', 'd1_usage'];
  $('#view').innerHTML = `<div class="carhead"><a class="btn" href="#/">Home</a><div><h2>Admin ${lvPill(d.overall)}</h2><div class="src">As of ${esc(when(d.now))} UTC. Kuma sends the alerts. This page shows the reason.</div></div></div>
    <section class="card" id="adm-queue" aria-label="Queue"><h3>Queue ${lvPill(q.level)}</h3><p>${esc(q.reason)}</p>
      <p class="src">Waiting ${q.counts.queued} · running ${q.counts.claimed} · done ${q.counts.done} · failed ${q.counts.failed}${q.oldest_wait_min ? ` · oldest waiting ${q.oldest_wait_min} min` : ''}</p>
      ${q.failed.length ? `<ul class="alist">${q.failed.map(j => `<li class="aitem lv-amber"><b>Job ${j.id} (${esc(j.kind)})</b><span class="areason">${esc(j.why)} Tries: ${j.attempts}. ${esc(when(j.at))}</span></li>`).join('')}</ul>` : ''}</section>
    <section class="card" id="adm-worker" aria-label="Worker runs"><h3>Worker runs ${lvPill(w.level)}</h3><p>${esc(w.reason)}</p>
      <p class="src">${lr ? `Last run ${esc(when(lr.ts))} UTC: ${esc(lr.text)}${lr.data && lr.data.duration_s != null ? ` · ${esc(lr.data.duration_s)} s` : ''}${lr.data && lr.data.calls != null ? ` · ${esc(lr.data.calls)} calls` : ''}` : 'No run has been pushed yet.'}</p>
      <p class="src">Cost today ${money(w.cost && w.cost.today_usd)} of ${money(w.cost && w.cost.daily_cap_usd)} · this month ${money(w.cost && w.cost.month_usd)}</p></section>
    <section class="card" id="adm-results" aria-label="Results"><h3>Results ${lvPill(r.level)}</h3><p>${esc(r.reason)}</p><a class="btn" href="#/confirm">Open Needs confirming</a>
      ${r.recent.length ? `<ul class="alist">${r.recent.map(j => `<li class="aitem lv-green"><b>Job ${j.id} (${esc(j.kind)})</b><span class="areason">${esc(j.summary)}</span></li>`).join('')}</ul>` : ''}</section>
    <section class="card" id="adm-n100" aria-label="N100 health"><h3>N100 health</h3><p class="src">${d.n100.as_of ? 'Report from ' + esc(when(d.n100.as_of)) + ' UTC' : 'No report yet'}</p><ul class="alist">${d.n100.items.map(aitem).join('')}</ul></section>
    <section class="card" id="adm-d1" aria-label="D1 usage"><h3>D1 usage</h3><p class="src">${d.d1.as_of ? 'Report from ' + esc(when(d.d1.as_of)) + ' UTC. ' + (d.d1.plan === 'paid' ? 'Workers Paid: the colour is the share of the monthly included amounts (50 million rows written, 25 billion rows read). The old free daily limits are shown in grey as information.' : 'Free limits: 100,000 rows written and 5,000,000 rows read a day.') : 'No report yet'}</p><ul class="alist">${d.d1.items.map(aitem).join('')}</ul></section>
    <section class="card" id="adm-log" aria-label="Log"><h3>Log</h3>
      <div class="row"><div class="field"><label for="admday">Day (New York)</label><input id="admday" type="date" value="${esc(d.day)}"></div>
      <div class="field"><label for="admkind">Kind</label><select id="admkind"><option value="">all (no health lines)</option>${KINDS.map(k => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${k.replace('_', ' ')}</option>`).join('')}</select></div></div>
      ${d.log.length ? `<ul class="alist">${d.log.map(l => `<li class="aitem lv-${esc(l.level)}">${lvPill(l.level)} <b>${esc(l.kind.replace('_', ' '))}</b><span class="areason">${esc(l.text)}</span><span class="areason src">${esc(when(l.ts))} UTC</span></li>`).join('')}</ul>` : '<div class="empty">No log lines for this day and kind</div>'}</section>
    <section class="card" id="adm-settings" aria-label="Settings"><h3>This screen</h3>
      <div class="row"><span class="src">This screen is called: ${esc(device)}</span><button class="ghost" id="rename">Change name</button></div>
      <label class="toggle"><input type="checkbox" id="showhid" ${showHidden ? 'checked' : ''}><span class="st"></span>Show hidden visitors on Home (not seen for 30 days)</label></section>`;
  $('#admday').onchange = e => { adminDay = e.target.value; adminPage(); };
  $('#admkind').onchange = e => { adminKind = e.target.value; adminPage(); };
  $('#showhid').onchange = e => { showHidden = e.target.checked; };
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
  // HANDOFF 17 (B6): a value read from a photo shows the photo beside it, to check against the label.
  const photoOf = x => { const m = x.scope === 'car' && x.vehicle_id && /^photo (\d[0-9TZ-]*\.(?:jpg|png|webp))$/.exec(x.note || ''); return m ? `<a class="jphoto thumb" href="/api/photos/${x.vehicle_id}/${m[1]}" target="_blank" rel="noopener"><img src="/api/photos/${x.vehicle_id}/${m[1]}" alt="The door-jamb photo this value was read from"></a>` : ''; };
  const SAVED = { none: 'No VIN is saved for this car yet.', matches: 'Matches the saved VIN.', differs: 'Differs from the saved VIN. A saved VIN is not replaced by a photo.' };
  const vins = d.vin_proposals || [];
  $('#view').innerHTML = `<div class="carhead"><a class="btn" href="#/">Home</a><div><h2>Needs confirming</h2><div class="src">${d.count + vins.length} proposed item${d.count + vins.length === 1 ? '' : 's'} · check each against the manual or the door label, then confirm or reject</div></div></div>
    ${(d.badges || []).length ? `<div class="tabbody" id="missing"><span class="lbl">Missing</span>${d.badges.map(b => `<a class="btn" href="#/car/${b.vehicle_id}">${esc(b.car)} ${b.no_vin ? '<span class="pill Missing">No VIN</span>' : ''}${b.no_doorcard ? '<span class="pill Missing">No door card</span>' : ''}</a>`).join('')}</div>` : ''}
    <div role="list" class="tabbody">${vins.map(p => `<div role="listitem" class="crow vinrow${p.vin_ok ? '' : ' flag'}"><div class="tabbody" style="gap:6px">
      <span class="meta">${esc(p.car)} · VIN read from a photo</span><span class="val key" style="font-family:var(--mono)">${esc(p.vin)}</span>
      <span class="note">${SAVED[p.saved_state]}</span>${p.vin_ok ? '' : '<span class="err">The VIN check digit fails. Read the label again, or save it as a VIN that is not US-market.</span>'}
      <a class="jphoto thumb" href="/api/photos/${p.vehicle_id}/${esc(p.photo)}" target="_blank" rel="noopener"><img src="/api/photos/${p.vehicle_id}/${esc(p.photo)}" alt="The photo this VIN was read from"></a>
      ${!p.vin_ok && p.saved_state === 'none' ? `<label class="toggle"><input type="checkbox" data-notus="${p.id}"><span class="st"></span>Not a US-market VIN</label>` : ''}<span class="err" data-vinerr="${p.id}"></span></div>
      <div class="acts"><button class="ok" data-vok="${p.id}" ${p.saved_state === 'differs' ? 'disabled' : ''}>Confirm</button><button data-vno="${p.id}">Reject</button></div></div>`).join('')}
    ${d.values.map(x => `<div role="listitem" class="crow${x.range_flag === 'outside' ? ' flag' : ''}"><div class="tabbody" style="gap:6px">
      <span class="meta">${what(x)}${x.engine ? ' · engine: ' + esc(x.engine) : ''} · ${esc(x.tab)} · ${esc(x.field)}${/read from photo/.test(x.source || '') ? ' · read from photo' : ''}</span>${photoOf(x)}
      <span class="val${keyCls(x)}">${esc(showVal(x))}</span>${x.replaces ? `<span class="note">replaces: ${esc(noNm(x.replaces))}</span>` : ''}
      <span class="meta"><span class="pill ${esc(x.confidence)}" style="margin-left:0">${esc(x.confidence)}</span> ${x.warn ? `<span class="pill lv-${x.warn === 2 ? 'block' : 'caution'}" style="margin-left:0">${x.warn === 2 ? 'Block - do not lift yet' : 'Caution'}</span> ` : ''}${esc(x.source)}</span>${x.note ? `<span class="note">${esc(x.note)}</span>` : ''}
      ${x.range_flag === 'outside' && x.range ? `<span class="err">Outside the usual range for ${esc(x.range.thread)} (${x.range.torque_min}-${x.range.torque_max} ft-lb). Check it before you confirm.</span>` : ''}</div>
      <div class="acts"><button class="ok needsnet" data-ok="${x.id}">Confirm</button><button class="needsnet" data-no="${x.id}">Reject</button></div></div>`).join('') || (vins.length ? '' : '<p class="note">Nothing to confirm.</p>')}</div>
    <p class="note">A confirmed model-year value applies to every car of that model and year. Each confirm or reject is kept in the value's history.</p>`;
  wireStatus(confirmPage);
  document.querySelectorAll('[data-vok]').forEach(b => b.onclick = () => {
    const id = b.dataset.vok, nu = document.querySelector(`[data-notus="${id}"]`);
    api(`/vin-proposals/${id}/confirm`, { method: 'POST', body: { not_us: !!(nu && nu.checked) } }).then(confirmPage).catch(e => { document.querySelector(`[data-vinerr="${id}"]`).textContent = e.message; });
  });
  document.querySelectorAll('[data-vno]').forEach(b => b.onclick = () => api(`/vin-proposals/${b.dataset.vno}/reject`, { method: 'POST', body: {} }).then(confirmPage).catch(fail));
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
  const st = { make: '', year: 0, model: '', trim: '', vin: '', variant: '', engine: '', fe_id: null, fuel: '' };
  // HANDOFF 17 (B2, B3): Year, Make, Model, Variant, Engine, then an optional Trim. fe = the fueleconomy.gov lists for the picked model.
  const fe = { variants: [], options: [], error: '', checked: false }, vinInfo = { check: null };
  // Storyboard T5: whose car first (Mine / Frequent / Visitor), one tap each.
  $('#view').innerHTML = `<div class="carhead"><a class="btn" href="#/">Cancel</a><h2>Add a car</h2></div><div class="grid"><section class="form">
    <fieldset class="field" style="border:0;margin:0;padding:0"><legend class="lbl" style="margin-bottom:8px">Whose car</legend>
      <div class="seg" id="grp">${[['mine', 'Mine'], ['frequent', 'Frequent'], ['visitor', 'Visitor']].map(([k, l]) => `<button type="button" data-grp="${k}" aria-pressed="${k === 'visitor'}">${l}</button>`).join('')}</div></fieldset>
    <div class="field"><label for="year">Year</label><input id="year" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits"></div>
    <div class="field"><label for="make">Make</label><input id="make" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Type 2-3 letters"><ul class="list" id="make-list" role="listbox" hidden></ul></div>
    <div class="field"><label for="model">Model</label><input id="model" autocomplete="off" role="combobox" aria-expanded="false" placeholder="Pick year and make first" disabled><ul class="list" id="model-list" role="listbox" hidden></ul></div>
    <div class="field" id="varbox" hidden><label for="variant">Variant</label><select id="variant"></select></div>
    <div class="field" id="engbox" hidden><label for="engine">Engine (required when the list has more than one)</label><select id="engine"></select></div>
    <div class="field"><label for="trimpick">Trim (optional)</label><select id="trimpick" hidden></select><input id="trim" autocomplete="off" placeholder="e.g. EX or Limited"></div>
    <div class="or">or</div>
    <div class="field"><label for="vin">VIN</label><div class="row"><input id="vin" maxlength="17" autocomplete="off" placeholder="17 characters" style="font-family:var(--mono)"><button type="button" id="vin-go">Decode</button>${scanButton('vin-scan')}</div></div>
  </section><section class="card" id="res"><h2>Pick a car</h2><p class="note">Type a make. "stu" finds Studebaker, "ram" finds Ram.</p></section></div>`;
  const show = async () => {
    const R = $('#res');
    if (!st.make || !st.year || !st.model) { R.innerHTML = `<h2>${esc([st.year || '', st.make].join(' ').trim() || 'Pick a car')}</h2><p class="note">${st.make ? (st.year ? 'Pick a model.' : 'Type the 4-digit year.') : 'Type a make.'}</p>`; return; }
    // B2: the engine is required when the fueleconomy.gov list has more than one. A classic or a car with no list saves as before.
    // Opus review finding 5: with several variants and none picked there are no engine options yet, so the variant is required first too.
    const needVariant = fe.variants.length > 1 && !st.variant;
    const needEngine = needVariant || (fe.engineChoices && fe.options.length > 1 && !st.fe_id);
    const nus = vinInfo.check === false ? `<label class="toggle"><input type="checkbox" id="notus"><span class="st"></span>Not a US-market VIN</label>` : '';
    R.innerHTML = `<h2>${st.year} ${esc(st.make)} ${esc(st.model)}</h2><p class="note">${esc(st.chartNote || '')}</p>${st.variant ? `<p class="note">${esc(st.variant)}${st.engine ? ' · ' + esc(st.engine) : ''}</p>` : ''}
      ${vinInfo.check === false ? '<p class="err">The VIN check digit fails. Check the VIN, or tick "Not a US-market VIN" to save it anyway.</p>' : ''}${nus}
      ${fe.error ? `<p class="note">${esc(fe.error)}. Type the trim and engine yourself.</p>` : ''}
      ${fe.variants.length ? '' : `<div class="field" id="engtextbox"><label for="engtext">Engine (type it, optional)</label><input id="engtext" maxlength="80" autocomplete="off" placeholder="e.g. 2.0 L" value="${esc(st.engine)}"></div>`}
      <button class="primary" id="save" ${needEngine ? 'disabled' : ''}>Save car</button>${needEngine ? `<p class="note" id="needeng">${needVariant ? 'Pick the variant, then the engine.' : 'Pick the engine first.'}</p>` : ''}<p class="err" id="saveerr"></p>`;
    if ($('#engtext')) $('#engtext').oninput = e => { st.engine = e.target.value.trim(); };
    $('#save').onclick = async () => {
      const { chartNote, ...car } = st;
      try { const v = await api('/vehicles', { method: 'POST', body: { ...car, trim: $('#trim').value.trim(), grp: $('#grp [aria-pressed="true"]').dataset.grp, not_us: !!($('#notus') && $('#notus').checked) } }); location.hash = '#/car/' + v.id; }
      catch (e) { $('#saveerr').textContent = e.message; }
    };
  };
  const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
  // Engine text of an option, "Auto 8-spd, 8 cyl, 5.7 L": an electric option has none, so it gives no engine to pick.
  const hasEng = o => /\d\.\d\s*L\b/i.test(o.text);
  const drawEngine = () => {
    fe.engineChoices = fe.options.some(hasEng);
    $('#engbox').hidden = !fe.engineChoices;
    $('#engine').innerHTML = (fe.options.length > 1 ? opt('', 'Pick the engine', !st.fe_id) : '') + fe.options.map(o => opt(o.value, o.text, String(st.fe_id) === o.value)).join('');
    if (fe.options.length === 1) { st.fe_id = +fe.options[0].value; st.engine = fe.engineChoices ? fe.options[0].text : ''; }
    else if (!st.fe_id) st.engine = '';
    if (!fe.engineChoices && fe.options.length !== 1) { st.fe_id = null; st.engine = ''; }
  };
  const loadOptions = async variant => {
    st.variant = variant; st.fe_id = null; st.engine = '';
    if (!variant) { fe.options = []; drawEngine(); show(); return; }
    try { fe.options = (await api(`/fe?year=${st.year}&make=${encodeURIComponent(st.make)}&model=${encodeURIComponent(st.model)}&variant=${encodeURIComponent(variant)}`)).options || []; } catch (e) { fe.options = []; fe.error = e.message; }
    drawEngine(); show();
  };
  const loadLists = async () => {
    Object.assign(fe, { variants: [], options: [], error: '', engineChoices: false }); Object.assign(st, { variant: '', engine: '', fe_id: null });
    $('#varbox').hidden = true; $('#engbox').hidden = true; $('#trimpick').hidden = true;
    if (!(st.make && st.year && st.model)) return;
    const q = `year=${st.year}&make=${encodeURIComponent(st.make)}&model=${encodeURIComponent(st.model)}`;
    api('/trims?' + q).then(r => {
      if (!r.trims.length) return;
      $('#trimpick').innerHTML = opt('', 'Pick a trim') + r.trims.map(t => opt(t.name, t.source === 'LiftPad' ? t.name : `${t.name} (${t.source})`)).join('') + opt('__type', 'Type it');
      $('#trimpick').hidden = false;
    }).catch(() => { /* no list: the trim is typed */ });
    try {
      const r = await api('/fe?' + q);
      fe.variants = r.variants || []; fe.error = r.error || '';
    } catch (e) { fe.error = e.message; }
    if (fe.variants.length) {
      $('#varbox').hidden = false;
      $('#variant').innerHTML = (fe.variants.length > 1 ? opt('', 'Pick a variant', true) : '') + fe.variants.map(v => opt(v.text, v.text)).join('');
      if (fe.variants.length === 1) await loadOptions(fe.variants[0].text);
    }
    show();
  };
  $('#variant').onchange = e => loadOptions(e.target.value);
  $('#engine').onchange = e => { const o = fe.options.find(x => x.value === e.target.value); st.fe_id = o ? +o.value : null; st.engine = o && fe.engineChoices ? o.text : ''; show(); };
  $('#trimpick').onchange = e => { if (e.target.value === '__type') { $('#trim').value = ''; $('#trim').focus(); } else if (e.target.value) $('#trim').value = e.target.value; };
  const unlock = () => { $('#model').disabled = !(st.make && st.year); $('#model').placeholder = st.make && st.year ? 'Tap to see models' : 'Pick year and make first'; };
  combo($('#make'), $('#make-list'), q => api('/makes?q=' + encodeURIComponent(q)).then(r => r.map(m => ({ label: m.name, tag: m.mine ? 'my car' : '' }))),
    it => { st.make = it.label; st.model = ''; $('#model').value = ''; unlock(); loadLists(); show(); if (st.year) $('#model').focus(); });
  $('#year').addEventListener('input', e => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = v; st.model = '';
    st.year = v.length === 4 ? +v : 0; $('#model').value = ''; unlock(); loadLists(); show();
    if (st.year && !st.make) $('#make').focus(); else if (st.year) $('#model').focus();
  });
  combo($('#model'), $('#model-list'), q => api(`/models?make=${encodeURIComponent(st.make)}&year=${st.year}&q=${encodeURIComponent(q)}`)
    .then(r => r.map(m => ({ label: m.label, charts: m.charts, tag: m.charts.length ? m.charts.map(c => c.chart).join(', ') : m.unknown ? 'years unknown' : m.source }))),
    it => { st.model = it.label; st.chartNote = it.charts.length ? `ALI chart ${it.charts.map(c => c.chart + (c.status === 'ok' ? ` (guide p.${c.guide_page})` : ' (page missing from scan)')).join(', ')}` : 'No ALI chart for this year.'; loadLists(); show(); });
  $('#vin-go').onclick = async () => {
    const R = $('#res');
    try { const d = await api('/vin?fe=1&vin=' + encodeURIComponent($('#vin').value)); Object.assign(st, { vin: d.vin, year: d.year, make: d.make, model: d.model, fuel: d.fuel_class || '' });
      vinInfo.check = d.check;
      $('#make').value = d.make; $('#year').value = d.year || ''; $('#model').value = d.model; unlock();
      $('#trim').value = d.trim || '';
      st.chartNote = (d.error ? 'NHTSA note: ' + d.error : 'Decoded by NHTSA. Check make and model match the lists.') + (d.ev ? ' Battery-electric: no engine oil.' : '');
      // B3: the decode first. When it names exactly one fueleconomy.gov option, variant and engine are preselected; otherwise the dropdowns show.
      await loadLists();
      // Ultrareview B #5: with no fueleconomy.gov list (down, or the model name does not match) the engine NHTSA decoded is kept, and the typed engine box shows it.
      if (!fe.variants.length && d.engine) st.engine = d.engine;
      if (d.fe) { $('#variant').value = d.fe.variant; await loadOptions(d.fe.variant); const o = fe.options.find(x => +x.value === d.fe.id); if (o) { $('#engine').value = o.value; st.fe_id = +o.value; st.engine = fe.engineChoices ? o.text : ''; } }
      show(); }
    catch (e) { R.innerHTML = `<h2>VIN</h2><p class="err">${esc(e.message)}</p>`; }
  };
  wireScan('vin-scan', vin => { $('#vin').value = vin; $('#vin-go').click(); }, m => { $('#res').innerHTML = `<h2>VIN</h2><p class="err">${esc(m)}</p>`; });
  document.querySelectorAll('[data-grp]').forEach(b => b.onclick = () => document.querySelectorAll('[data-grp]').forEach(x => x.setAttribute('aria-pressed', String(x === b))));
  $('#year').focus();
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
const adaptersBlock = (n, foot, hideCar) => {
  // HANDOFF 15: the per-car switch for the chart's caution text (set for the Jeep). The chart image still shows the caution.
  // HANDOFF 19 (D7): one control, Show or Hide, and no sentence about the state.
  const hideBtn = hideCar ? `<button class="ghost" id="cautiontoggle" data-hide="0">Show chart caution</button>` : `<button class="ghost" id="cautiontoggle" data-hide="1">Hide chart caution</button>`;
  const lv = n && VERIFIED[n.verified] ? n.verified : 'no', stop = !!n && /^Do not use a 2-post/.test(n.kit_mark || '');
  // HANDOFF 13: "I checked this chart" until Rick has checked it; "Undo" while the check holds (it falls back by itself
  // when the chart text changes). Who and when come from chart_checks.
  const byBtn = !!n && lv === 'rick' && !!n.verified_by;
  const act = !n ? '' : lv !== 'rick' ? `<button class="primary chartcheck needsnet" data-act="check" data-ed="${esc(n.edition)}" data-chart="${esc(n.chart)}">I checked this chart</button>`
    : byBtn ? `<button class="chartcheck needsnet" data-act="undo" data-ed="${esc(n.edition)}" data-chart="${esc(n.chart)}">Undo</button>` : '';
  const lead = `<div class="vlabel"><b>${VERIFIED[lv]}</b>${byBtn ? ` <span class="note">${esc(String(n.verified_at || '').slice(0, 10))}</span>` : ''} ${act}<span class="err chartcheckerr"></span></div>`;
  const end = `<div class="adfoot">${esc(foot || FOOT_FALLBACK)}</div>`;
  if (!n) return { stop: false, html: `<div class="adapters unchecked" data-verified="no">${lead}<div>LiftPad has no adapter notes for this chart.</div>${end}</div>` };
  return { stop, html: `<div class="adapters${lv === 'no' ? ' unchecked' : ''}${stop ? ' stop' : ''}" data-verified="${lv}" data-kit="${stop ? 'stop' : 'note'}">
    ${stop ? '<div class="stopline"><b>Do not use a 2-post.</b> The chart says so. Read its words below.</div>' : ''}${lead}
    <div><b>Adapters (from the guide):</b> ${esc(n.adapters || 'no adapter callout on the chart')}</div>
    ${n.height_note ? `<div><b>Height:</b> ${esc(n.height_note)}</div>` : ''}
    <div><b>Your kit:</b> ${esc(n.kit_mark || 'height not given')}</div>
    ${n.cautions ? `<div class="chartq"><b>From the chart:</b> ${esc(n.cautions)}</div>` : ''}
    ${hideBtn}${end}</div>` };
};
// HANDOFF 18 (C7, C8): the recalls line and the curb weight. Both come from the Worker's daily cache; the page posts /facts once it is drawn.
// NHTSA lists recalls by model year, not by VIN, so the line says "for this model year". The VIN button opens NHTSA's own lookup with the
// VIN filled in, in a new tab (rel noreferrer): the full VIN is in that link only, never in a log or on the Admin page.
const NHTSA_VIN_URL = 'https://www.nhtsa.gov/recalls?vin=';
const recallInner = v => {
  const r = v.recalls, s = n => n === 1 ? '' : 's';
  const vinBtn = v.vin ? `<a class="btn" id="vinrecall" href="${NHTSA_VIN_URL}${encodeURIComponent(v.vin)}" target="_blank" rel="noopener noreferrer">Check my VIN at NHTSA</a>` : '';
  let line;
  if (!r) line = '<span class="note">Recalls: checking...</span>';
  else if (r.count == null) line = '<span class="note">Recalls not available right now.</span>';
  else if (!r.count) line = `<span class="recalls-n">0 recalls for this model year</span>`;
  else line = `<details class="recalls"><summary>${r.count} recall${s(r.count)} for this model year</summary>
    <ul class="alist">${r.items.map(i => `<li class="aitem"><b>${esc(i.campaign)}</b> <span class="src">${esc(i.date)} · ${esc(i.component)}</span><span class="areason">${esc(i.summary)}</span><span class="areason"><b>Fix:</b> ${esc(i.remedy)}</span></li>`).join('')}</ul></details>`;
  const more = r && r.count != null ? `<span class="src">${esc(r.model || '')} · as of ${esc(String(r.as_of || '').slice(0, 10))} · this list is for the model year, not for your VIN.</span>` : '';
  return `${line}${more}${vinBtn}`;
};
const lbPlain = n => Number(n).toLocaleString('en-US');
const weightInner = v => {
  const c = v.curb;
  if (!c) return `<div class="lbl">Curb weight</div><span class="note">${v.weight_error ? esc(v.weight_error) + '.' : 'Checking the Canadian specs...'}</span>${weightForm(v, false)}`;
  const split = c.front_pct != null ? `<span class="src">${c.front_pct}% front (${lbPlain(Math.round(c.lb * c.front_pct / 100))} lb) · ${100 - c.front_pct}% rear (${lbPlain(c.lb - Math.round(c.lb * c.front_pct / 100))} lb)</span>` : '';
  return `<div class="lbl">Curb weight</div><div><span class="val">${lbPlain(c.lb)} lb</span> ${pill(c.status === 'confirmed' ? 'confirmed' : 'proposed')}</div>${split}
    <span class="src">${esc(c.source || '')}${c.status === 'confirmed' ? '' : '. AI-checked only until you confirm it.'}</span>
    ${c.status === 'confirmed' ? '' : '<div class="row"><button class="ok" id="wconfirm">Confirm this weight</button></div>'}${weightForm(v, true)}`;
};
const weightForm = (v, has) => `<details id="wedit"><summary class="lbl">${has ? 'Type my own weight' : 'Type the weight myself'}</summary>
  <div class="row"><div class="field"><label for="wlb">Curb weight (lb)</label><input id="wlb" inputmode="numeric" autocomplete="off"></div>
  <div class="field"><label for="wfp">Front share (%)</label><input id="wfp" inputmode="numeric" autocomplete="off" placeholder="optional"></div>
  <button id="wsave">Save and confirm</button></div><p class="err" id="werr"></p></details>`;
function wireWeight(v) {
  const post = body => api(`/vehicles/${v.id}/weight`, { method: 'POST', body }).then(d => { v.curb = d.curb; $('#weightbox').innerHTML = weightInner(v); wireWeight(v); }).catch(e => { const el = $('#werr'); if (el) el.textContent = e.message; });
  const c = $('#wconfirm'); if (c) c.onclick = () => post({ action: 'confirm' });
  const sv = $('#wsave'); if (sv) sv.onclick = () => { const b = { action: 'confirm', lb: $('#wlb').value.trim() }; if ($('#wfp').value.trim()) b.front_pct = $('#wfp').value.trim(); post(b); };
}
// HANDOFF 19 (D1-D3): the car screen (direction A). Four tiles, no tabs. A tap on Wheels off, Tires or Oil opens a drawer; the Lift tile opens the Lift screen.
// `tab` is the value tab of the open drawer (valueForm and valueInputs read it).
let drawerKey = null;      // the open drawer: lift torque tires oil caution recalls checks edit
let redraw = () => {};     // draws the screen under the drawer again (a save inside the drawer)
const TILE_TAB = { wheels: 'torque', tires: 'tires', oil: 'oil', lift: 'lift' };
// HANDOFF 20 (review fix 8): the NHTSA VIN decode is asked once per VIN per page; the car screen (EV oil tile) and the drawer share the answer.
// A failed ask is forgotten, so the next screen tries again.
const vinAsked = new Map(), vinDone = new Map();
const vinDecode = vin => {
  if (!vin) return Promise.resolve(null);
  if (!vinAsked.has(vin)) vinAsked.set(vin, api('/vin?vin=' + encodeURIComponent(vin)).then(d => { vinDone.set(vin, d); return d; }).catch(() => { vinAsked.delete(vin); return null; }));
  return vinAsked.get(vin);
};
const RANKC = { Low: 0, Medium: 1, High: 2 };
// The value shown for a field: confirmed first. Ultrareview B #4: a value tagged for an engine is never a headline pick for a car with no engine set.
const pickVal = (v, f) => { const c = v.values.filter(x => x.field === f && !x.hidden_by_placard && !x.no_headline && x.status !== 'rejected'); return c.find(x => x.status === 'confirmed') || c[0]; };
const confPill = c => `<span class="pill ${esc(c)}">${esc(c)}</span>`;
// Badges never hide: a tile shows the confidence and status of its least confirmed value.
const weakest = list => list.filter(Boolean).sort((a, b) => (a.status === 'confirmed') - (b.status === 'confirmed') || RANKC[a.confidence] - RANKC[b.confidence])[0];
const badgesOf = s => s ? `${confPill(s.confidence)}${pill(s.status)}` : '<span class="pill Missing">Missing</span>';
const missing = what => `<span class="pill Missing">Missing ${what}</span>`;
const SIZE_RE = /(?<![0-9])\d{3}\/\d{2}\s?[A-Za-z]{0,2}\s?R?\s?\d{2}\b/g;   // 235/50ZR18, 245/40 R19, T125/70D17
const psiNumbers = t => (String(t || '').replace(SIZE_RE, ' ').match(/\d+(?:\.\d+)?/g) || []).filter(x => +x >= 10 && +x <= 99);
// A front / rear pair only when the text says front and rear ("33 F / 33 R", "32 / 32", "Front 38, Rear 44"); else the raw text is shown.
const hasFR = t => /\b[FR]\b|front|rear|\d\s*\/\s*\d/i.test(String(t || '').replace(SIZE_RE, ' '));
const firstSentence = t => String(t || '').split(/(?<=[.!?])\s+/)[0];
// Oil: the grade of this car's engine. A text for several engines ("1.6T and 2.5: SAE 0W-20 ... 2.5T: SAE 0W-30") is cut at each engine label.
const SAE = /\b\d{1,2}W-?\d{1,2}\b/i;
function oilGrade(text, v) {
  const t = String(text || ''), segs = t.split(/\.\s+(?=\d\.\d)/);
  // a turbo mark ("2.5T", or the word Turbo after the size) wins over the plain size
  const both = (String(v.engine || '') + ' ' + String(v.trim || '')).replace(/(\d\.\d)\s*L?\b[^,;]*\bturbo/i, '$1T'), tok = both.match(/\d\.\dT\b/i) || both.match(/\d\.\d/);
  const labels = s => (s.split(':')[0].match(/\d\.\dT?/gi) || []).map(x => x.toUpperCase());
  const seg = segs.length > 1 && tok ? (segs.find(s => labels(s).includes(tok[0].toUpperCase())) || segs.find(s => labels(s).some(l => l.replace(/T$/, '') === tok[0].toUpperCase().replace(/T$/, '')))) : null;
  if (segs.length > 1 && !seg) return null;   // the text is for several engines and none is this car's: the tile says so, the drawer has the text
  const m = (seg || t).match(SAE);
  return m ? m[0].toUpperCase() : '';
}
// The four tiles. Each gives { big, small, badges }; a missing value is a red chip, never an empty place.
function tileData(v) {
  const wheels = () => {
    const t = pickVal(v, 'Torque'), so = pickVal(v, 'Socket'), th = pickVal(v, 'Thread'), MK = v.typical && v.typical.make;
    const big = t ? esc(noNm(showVal(t))) : MK && MK.torque_ftlb != null ? `~${MK.torque_ftlb} ft-lb` : missing('torque');
    const small = [so ? esc(tidy(so.value)) : missing('socket'), th ? esc(th.value) : missing('thread')].join(' · ');
    // No torque of its own: a typical value is Low and "Typical", never the High / Confirmed badge of the socket; nothing at all is Missing.
    const noTorque = !t ? (MK && MK.torque_ftlb != null ? `${confPill('Low')}<span class="pill st-proposed">Typical</span>` : '<span class="pill Missing">Missing</span>') : '';
    return { big, small, badges: t ? badgesOf(weakest([t, so, th])) : noTorque };
  };
  const tires = () => {
    const p = pickVal(v, 'Pressure'), sp = pickVal(v, 'Spare pressure'), sz = pickVal(v, 'Size'), n = p ? psiNumbers(p.value) : [];
    const big = p ? esc(n.length === 2 && hasFR(p.value) ? `${n[0]} F / ${n[1]} R psi` : n.length === 1 ? `${n[0]} psi` : String(p.value).replace(/\s*cold\s*$/i, '')) : missing('pressure');
    const spare = sp ? (psiNumbers(sp.value)[0] ? `spare ${psiNumbers(sp.value)[0]} psi` : /none|no spare/i.test(sp.value) ? 'no spare' : tidy(sp.value)) : '';
    const sizes = sz ? [...new Set(String(sz.value).match(SIZE_RE) || [])] : [];
    const size = sz ? (sizes.length ? sizes.join(' / ') : String(sz.value).slice(0, 24)) : '';
    const small = [spare && esc(spare), 'cold', sz ? esc(size) : missing('size')].filter(Boolean).join(' · ');
    return { big, small, badges: badgesOf(weakest([p, sp, sz])) };
  };
  const oil = () => {
    if (v.fuel === 'ev' || v.nhtsa_ev) return { big: 'No engine oil (EV)', small: '', badges: '<span class="pill st-confirmed">EV</span>' };
    const g = pickVal(v, 'Oil type'), q = pickVal(v, 'Quantity'), f = pickVal(v, 'Filter');
    const grade = g ? oilGrade(g.value, v) : '', qm = q && String(q.value).match(/(\d+(?:\.\d+)?)\s*(qt|quarts?|L|liters?|litres?)\b/i);
    const qty = qm ? `${qm[1]} ${/^l/i.test(qm[2]) ? 'L' : 'qt'}` : '';
    const spec = g && /·/.test(g.value) ? g.value.split('·').slice(1).join('·').trim() : '';
    const big = g ? (grade === null ? 'Several engines' : esc(grade ? grade + (qty ? ' · ' + qty : '') : String(g.value).slice(0, 30))) : missing('oil type');
    const small = [grade === null ? 'see the drawer for each engine' : '', qty ? 'with filter' : missing('quantity'), spec && esc(spec), f && esc(f.value)].filter(Boolean).join(' · ');
    return { big, small, badges: badgesOf(weakest([g, q, f])) };
  };
  const lift = () => {
    const a = v.ali, pts = pickVal(v, 'Points');
    const big = a ? esc(a.chart) : missing('chart');
    const small = pts ? `<span class="clamp2">${esc(pts.value)}</span>` : missing('points');
    return { big, small, badges: pts || a ? (a && a.status !== 'ok' ? missing('page') : '') + (pts ? badgesOf(pts) : '') : badgesOf(null) };
  };
  return { lift: lift(), wheels: wheels(), tires: tires(), oil: oil() };
}
const recallText = v => {
  const r = v.recalls;
  return !r ? 'Recalls: checking...' : r.count == null ? 'Recalls not available right now.' : !r.count ? '0 recalls for this model year' : `${r.count} recall${r.count === 1 ? '' : 's'} for this model year · model year, not your VIN`;
};
const needsHtml = v => {
  // Safety values and warnings come first. A safety value, or a text that is cut short, gets "Check" (it opens the drawer with the source) and never a one-tap Confirm.
  const prop = v.values.filter(s => s.status === 'proposed' && !s.hidden_by_placard).sort((a, b) => (b.warn || 0) - (a.warn || 0) || (b.is_safety || 0) - (a.is_safety || 0)), c = v.curb && v.curb.status !== 'confirmed' ? v.curb : null;
  const rows = [...prop.map(s => { const txt = noNm(showVal(s)), long = txt.length > 40;
      return { t: `${esc(s.field)} <span class="mono">${esc(txt.slice(0, 40))}${long ? '...' : ''}</span> ${pill('proposed')}`, a: s.is_safety || s.warn || long ? `data-drawer="${esc(s.tab)}"` : `data-ok="${s.id}"`, check: !!(s.is_safety || s.warn || long) }; }),
    ...(c ? [{ t: `Curb weight <span class="mono">${lbPlain(c.lb)} lb</span> ${pill('proposed')}`, a: 'id="wconfirm2"', check: false }] : [])];
  if (!rows.length) return '';
  return `<div class="panel needs"><span class="lbl">Needs you</span>${rows.slice(0, 2).map(r => `<div class="needrow"><span>${r.t}</span>${r.check ? `<button class="t48" ${r.a}>Check</button>` : `<button class="ok t48 needsnet" ${r.a}>Confirm</button>`}</div>`).join('')}
    ${rows.length > 2 ? `<a class="src" href="#/confirm">${rows.length - 2} more in Needs confirming</a>` : ''}<span class="src offlinewhy">Confirming needs a connection.</span></div>`;
};
// The caution line: amber for a standing step (warn 1), red and "Do not lift yet" for a block (warn 2).
const cautionsOf = v => v.values.filter(s => s.warn && !s.hidden_by_placard).sort((a, b) => b.warn - a.warn);
async function car(id) {
  const live = fresh();
  if (!meta) meta = await api('/tabs');
  // HANDOFF 20 (E2): a failed visit list is marked, so offline with no saved copy does not say "No visits yet". A car that only NHTSA marks as EV
  // (its fuel is not set) gets the EV oil tile too. Review fix 8: the VIN decode does not delay the screen; it is asked once per page (vinDecode)
  // after the screen is drawn, the oil tile is redrawn when it says EV, and the drawer uses the same answer.
  const [v, svc] = await Promise.all([api('/vehicles/' + id), api(`/vehicles/${id}/service`).catch(() => ({ entries: [], unavailable: true }))]);
  if (!live()) return;
  if (v.vin && vinDone.get(v.vin) && vinDone.get(v.vin).ev) v.nhtsa_ev = true;   // seen before on this page: no flash, no request
  const T = tileData(v), cs = cautionsOf(v), c0 = cs[0], last = svc.entries[0], drafts = readDrafts().filter(d => d.car === +id);
  const stop = v.chart_notes && /^Do not use a 2-post/.test(v.chart_notes.kit_mark || '');
  crumb('', `<b>${esc(carName(v))}</b> <span class="trim">${esc(v.trim || '')}</span>`);
  $('#hnav').innerHTML = '<a class="btn t48" href="#/">My cars</a>';
  const cautionLine = c0 ? `<div class="caut row ${c0.warn === 2 ? 'block' : ''}" data-level="${c0.warn === 2 ? 'block' : 'caution'}"><a class="cautmain" href="#/car/${id}/lift"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>
      <b class="cauttitle">${esc(c0.field)}${cs.length > 1 ? ` (+${cs.length - 1})` : ''}</b><span class="cautsum">${c0.warn === 2 ? 'Do not lift yet' : esc(firstSentence(c0.value))}</span></a>${pill(c0.status)}<button class="ibtn t48" data-drawer="caution" aria-label="Caution detail">i</button></div>` : '';
  const stopLine = stop ? `<a class="caut row block" data-level="block" href="#/car/${id}/lift"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg><b class="cauttitle">Do not use a 2-post</b><span class="cautsum">The chart says so</span></a>` : '';
  const tile = (key, label, t) => `<${key === 'lift' ? `a href="#/car/${id}/lift"` : `button type="button" data-tile="${key}"`} class="tile" data-key="${key}"><span class="top"><span class="lbl">${label}</span><span class="badges">${t.badges}</span></span>
    <span class="val tbig">${t.big}</span>${t.small ? `<span class="val tsmall">${t.small}</span>` : ''}</${key === 'lift' ? 'a' : 'button'}>`;
  $('#view').innerHTML = `<div class="carscreen" data-car="${id}">
    <div class="leftcol">${stopLine}${cautionLine}<div class="tiles">${tile('lift', 'Lift', T.lift)}${tile('wheels', 'Wheels off', T.wheels)}${tile('tires', 'Tires', T.tires)}${tile('oil', 'Oil', T.oil)}</div></div>
    <div class="rightcol"><a class="btn big amber logwork" href="#/car/${id}/log">Log work</a>
      <a class="panel lastvisit" href="#/car/${id}/history"><span class="lbl">Last visit</span>${last ? `<span class="mono">${esc(last.date)} · ${miles(last.mileage)} mi</span><span>${last.items.map(itemLine).join(' · ')}</span>` : `<span>${svc.unavailable ? (navigator.onLine ? 'Could not load visits - try again.' : 'No saved visits offline.') : 'No visits yet.'}</span>`}
        ${drafts.map(d => `<span class="notsent">Not sent: ${esc(d.body.date)} · ${miles(d.body.mileage)} mi. It goes out when you are back online.</span>`).join('')}</a>
      <div id="needs">${needsHtml(v)}</div>
      <button type="button" class="recallline" id="recallbox" data-drawer="recalls">${esc(recallText(v))}</button>
      <button type="button" class="ghost editcarbtn" data-drawer="edit">Edit car</button></div></div>`;
  redraw = () => car(id);
  wireCar(v, id, live);
  if (v.vin && v.fuel !== 'ev' && !v.nhtsa_ev) {
    vinDecode(v.vin).then(dec => {
      if (!dec || !dec.ev || !live()) return;
      v.nhtsa_ev = true;
      const el = document.querySelector('.tile[data-key="oil"]');
      if (!el) return;
      el.outerHTML = tile('oil', 'Oil', tileData(v).oil);
      document.querySelector('.tile[data-key="oil"]').onclick = () => { drawerKey = TILE_TAB.oil; openDrawer(v, id, drawerKey); };
    });
  }
  if (drawerKey) openDrawer(v, id, drawerKey);
}
// Buttons of the car screen; the drawer has its own wiring (wireDrawer). Once a day per car the Worker asks NHTSA (recalls, Canadian-specs weight);
// the page is already drawn, only the recall line and the Needs you panel are redrawn.
function wireCar(v, id, live) {
  document.querySelectorAll('[data-tile]').forEach(b => b.onclick = () => { drawerKey = TILE_TAB[b.dataset.tile]; openDrawer(v, id, drawerKey); });
  document.querySelectorAll('[data-drawer]').forEach(b => b.onclick = () => { drawerKey = b.dataset.drawer; openDrawer(v, id, drawerKey); });
  const needs = () => { const n = $('#needs'); if (n) { n.innerHTML = needsHtml(v); wireNeeds(v, id); } };
  wireNeeds(v, id);
  if (v.facts_due && navigator.onLine) api(`/vehicles/${id}/facts`, { method: 'POST', body: {} }).then(f => {
    if (!live()) return;
    v.recalls = f.recalls; v.curb = f.curb; v.weight_error = f.weight_error;
    const rb = $('#recallbox'); if (rb) rb.textContent = recallText(v);
    needs();
  }).catch(() => { const rb = $('#recallbox'); if (live() && rb && !v.recalls) { v.recalls = { count: null, error: 'The check did not finish.', items: [] }; rb.textContent = recallText(v); } });
}
function wireNeeds(v, id) {
  wireStatus(() => redraw());
  document.querySelectorAll('#needs [data-drawer]').forEach(b => b.onclick = () => { drawerKey = b.dataset.drawer; openDrawer(v, id, drawerKey); });
  const c = $('#wconfirm2'); if (c) c.onclick = () => api(`/vehicles/${id}/weight`, { method: 'POST', body: { action: 'confirm' } }).then(() => redraw()).catch(fail);
}
// ---------- The drawer (HANDOFF 19, D2): one component for the three value tiles, the Lift points, the caution, the recalls, the checks and Edit car ----------
// 440 px from the right on the tablet, a bottom sheet on the phone, a dimmer behind, a 48 px Close. Wiring runs after each draw.
const DRAWER_TITLE = { torque: 'Wheels off', tires: 'Tires', oil: 'Oil', lift: 'Lift points', caution: 'Caution', recalls: 'Recalls', checks: 'Checks', edit: 'Edit car' };
async function drawerBody(v, id, key) {
  const valueKey = ['torque', 'tires', 'oil', 'lift'].includes(key);
  if (valueKey) tab = key;
  const rows = valueKey ? v.values.filter(s => s.tab === key && !s.hidden_by_placard) : [];
  const hiddenTires = key === 'tires' ? v.values.filter(s => s.hidden_by_placard).length : 0;
  const job = v.jobs[0];
  const jobLine = !job ? '' : job.status === 'done' ? `<span class="warn">Results ready - confirm${job.result_summary ? ' (' + esc(job.result_summary) + ')' : ''}</span>`
    : job.status === 'failed' ? `<span class="warn bad">Research failed: ${esc(job.error)}</span>` : `<span class="note">${job.status === 'claimed' ? 'Researching' : 'Queued'}</span>`;
  // The VIN decode (NHTSA only, cached) gives the engine for the lookup links and the EV flag.
  const lookTab = ['oil', 'torque', 'tires'].includes(key);
  const dec = lookTab && v.vin ? await vinDecode(v.vin) : null;
  // Decision 7: NHTSA says battery-electric -> no engine oil.
  let evNote = '';
  if (key === 'oil' && v.fuel === 'ev') evNote = `<div class="warn"><b>No engine oil (EV).</b> This car is battery-electric. It has no engine oil to change.</div>`;
  else if (key === 'oil' && dec && dec.ev) evNote = `<div class="warn"><b>No engine oil (EV).</b> NHTSA says this car is battery-electric (${esc(dec.electrification || dec.fuel)}). It has no engine oil to change.</div>`;
  // Decision 8: links Rick opens and reads himself; LiftPad never fetches them. A tap fills the Source box.
  let links = '';
  if (lookTab && !evNote) {   // HANDOFF 19 (D1, i4): an EV has no engine oil, so no look-it-up links and no research
    const L = (await api(`/links?year=${v.year}&make=${encodeURIComponent(v.make)}&model=${encodeURIComponent(v.model)}&engine=${encodeURIComponent((dec && dec.engine) || '')}&ev=${dec && dec.ev ? 1 : 0}`).catch(() => [])).filter(l => l.tabs.includes(tab));
    if (L.length) links = `<details class="links"><summary class="lbl">Look it up yourself (${L.length} links)</summary>
      <p class="note">Each opens the site in a new tab. LiftPad never reads these sites for you. Enter what you find below: the source is filled in.</p>
      <ul>${L.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" data-src="${esc(l.label)}">${esc(l.label)}</a>${l.note ? `<span class="note">${esc(l.note)}</span>` : ''}</li>`).join('')}</ul></details>`;
  }
  // Decision 9: after the car's own values, the make's typical value (Low), then the thread range
  // as a sanity check only. A torque outside the range is flagged on the value.
  const R = v.typical && v.typical.range, MK = v.typical && v.typical.make;
  // HANDOFF 19 (D7): one range warning per value, and not red on a value that is confirmed High (the source is the manual; the range is a sanity check).
  const rangeWarn = s => s.range_flag === 'outside' && R
    ? (s.status === 'confirmed' && s.confidence === 'High'
      ? `<div class="src rangenote">Outside the usual range for ${esc(R.thread)} (${R.torque_min}-${R.torque_max} ft-lb). Confirmed High from the source.</div>`
      : `<div class="warn bad">Outside the usual range for ${esc(R.thread)} (${R.torque_min}-${R.torque_max} ft-lb). Check it before you use it.</div>`) : '';
  let typ = '';
  const ownTq = rows.find(s => s.field === 'Torque' && s.status === 'confirmed' && s.confidence === 'High');
  // Suggestion 2: when the car's own torque is confirmed High, one grey line replaces the "Typical for" box (no red LOW badge). An outside value has its own warning above.
  if (key === 'torque' && ownTq && R) typ += ownTq.range_flag === 'outside' ? '' : `<p class="src rangeline">Range check: inside ${R.torque_min}-${R.torque_max} ft-lb</p>`;
  else if (key === 'torque' && MK) {
    const own = rows.some(s => s.field === 'Torque');
    typ += `<div class="typical${own ? ' after' : ''}"><div class="lbl">${own ? 'Typical for ' + esc(v.make) + ' (for comparison)' : 'No value for this car yet - typical for ' + esc(v.make)}</div>
      ${MK.torque_ftlb != null ? `<span class="val${own ? '' : ' key'}">~${MK.torque_ftlb} ft-lb</span>` : ''}<span class="pill Low">Low</span>
      <div>${[MK.thread, MK.socket && MK.socket + ' socket'].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="note">Typical for ${esc(v.make)} ${esc(MK.era)} - not confirmed for this car.${MK.note ? ' ' + esc(MK.note) + '.' : ''} (table ${esc(MK.edition)})</div></div>`;
  }
  if (key === 'torque' && R && !ownTq) typ +=`<p class="src">Range for ${esc(R.thread)}${v.typical.thread_from === 'make' ? ` (the typical ${esc(v.make)} thread)` : ''}: ${R.torque_min}-${R.torque_max} ft-lb. A sanity check only, never the car's value. (table ${esc(R.edition)})</p>`;
  // Decision 1: a proposed value looks different (dashed amber box, the word Proposed) from a confirmed one.
  // Suggestions 1 and 7: History and Edit show after a tap on the value card (class "open"); on the phone the source line does too.
  const valueDd = s => `<dd data-v="${s.id}" class="v-${esc(s.status)} vcard" tabindex="0"><div><span class="val${keyCls(s)}">${esc(showVal(s))}</span>${s.ftlb_src === 'converted' ? '<span class="tag">converted</span>' : ''}</div>
    <div><span class="pill ${esc(s.confidence)}" style="margin-left:0">${esc(s.confidence)}</span>${pill(s.status)}${s.scope === 'car' ? '<span class="tag">this car only</span>' : `<span class="tag">${s.year_from}${s.year_to !== s.year_from ? '-' + s.year_to : ''}</span>`}${s.engine ? `<span class="tag engtag">engine: ${esc(s.engine)}</span>` : ''}</div>
    <div class="src">${esc(s.source)}</div>${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}${rangeWarn(s)}
    ${s.status === 'proposed' ? `<div class="row"><button class="ok needsnet" data-ok="${s.id}">Confirm</button><button class="ghost needsnet" data-no="${s.id}">Reject</button></div>` : ''}
    <div class="row vacts"><button class="ghost" data-h="${s.id}">History</button><button class="ghost" data-e="${s.id}">Edit</button></div><div class="hist"></div></dd>`;
  const T = tileData(v)[key === 'torque' ? 'wheels' : key];
  const hasMissing = valueKey && /class="pill Missing"/.test(`${T.big}${T.small}${T.badges}`);
  const label = (meta.tabs.find(t => t.name === key) || {}).label || key;
  const addLabel = `+ Add ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${esc(label.toLowerCase())} value`;
  const valueList = `<dl>${rows.map(s => `<dt>${esc(s.field)}${s.is_safety ? ' <span class="tag">safety</span>' : ''}</dt>${valueDd(s)}`).join('') || '<dt>Values</dt><dd class="note">Nothing yet. Add the first value below.</dd>'}</dl>`;
  const valueTail = `${hiddenTires ? `<p class="src hiddennote">The door card wins: ${hiddenTires} value${hiddenTires === 1 ? '' : 's'} for other wheel sizes ${hiddenTires === 1 ? 'is' : 'are'} hidden (kept in the history).</p>` : ''}
    ${typ}${links}
    <details id="addspec" ${evNote ? 'hidden' : ''}><summary class="lbl">${addLabel}</summary>${valueForm(v)}</details>
    <div class="row dacts">${key === 'tires' ? `<a class="btn primary needsnet" href="#/car/${v.id}/jamb">Door-jamb photo</a>` : ''}${key === 'oil' && v.fuel !== 'ev' ? `<a class="btn" href="#/car/${v.id}/log">Log oil change</a>` : ''}
      ${hasMissing ? `<button id="research" class="needsnet">Research missing values</button>${jobLine}` : ''}</div><span class="src offlinewhy">Scans and confirming need a connection.</span><p class="err" id="delmsg"></p>`;
  const head = (title, extra = '') => `<div class="row dhead"><span class="lbl dtitle">${esc(title)} · sources and history</span><button type="button" class="t48" id="dclose">Close</button></div>${extra}`;
  if (valueKey) {
    const big = key === 'oil' && v.fuel === 'ev' ? 'No engine oil (EV)' : T.big;
    return head(DRAWER_TITLE[key], `<div class="val dbig">${big}</div>${T.small ? `<div class="val dsmall">${T.small}</div>` : ''}<div class="badges">${T.badges}</div>`) + (evNote || '') + (evNote && !rows.length ? '' : valueList) + valueTail;
  }
  if (key === 'recalls') return head('Recalls', `<div class="recalldrawer">${recallInner(v)}</div>`);
  if (key === 'caution' || key === 'checks') {
    const ad = v.ali ? adaptersBlock(v.chart_notes, v.chart_notes_footer, v.hide_chart_cautions) : { html: '<p class="note">No ALI chart for this car in the lift guide.</p>' };
    const cl = key === 'caution' ? cautionsOf(v) : [];
    return head(DRAWER_TITLE[key], `${cl.length ? `<dl>${cl.map(s => `<dt>${s.warn === 2 ? 'Do not lift yet' : 'Caution'} - ${esc(s.field)}</dt>${valueDd(s)}`).join('')}</dl>` : ''}${ad.html}<div class="weightbox" id="weightbox">${weightInner(v)}</div>`);
  }
  // key 'edit'
  return head('Edit car', `<span class="src">${esc(carName(v))} · ${GROUP[v.grp]}</span>
  <div class="row">${Object.keys(GROUP).filter(g => g !== v.grp).map(g => `<button class="ghost" data-g="${g}">Move to ${GROUP[g]}</button>`).join('')}</div>
  <div class="card" id="ownbox"><div class="row"><div class="field"><label for="ownin">Owner (shown on the card when it is not Rick)</label><input id="ownin" maxlength="60" autocomplete="off" value="${esc(v.owner || '')}"></div>
    <div class="field"><label for="fuelin">Fuel</label><select id="fuelin"><option value="">not set</option>${['gas', 'diesel', 'hybrid', 'phev', 'ev'].map(f => `<option value="${f}" ${v.fuel === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
    <button id="ownsave">Save owner and fuel</button></div><p class="err" id="ownerr"></p></div>
  <div class="card" id="trimbox"><div><span class="lbl">Trim</span> <span class="val" id="trimnow">${esc(v.trim || 'none')}</span></div>
    <div class="row"><input id="trimin" maxlength="60" autocomplete="off" placeholder="for example SE or Limited" aria-label="Trim" value="${esc(v.trim || '')}"><button id="trimsave">Save trim</button></div>
    <p class="note">The trim goes into the research request. A change is logged with its date.</p><p class="err" id="trimerr"></p></div>
  <div class="card" id="enginebox"><div><span class="lbl">Engine</span> <span class="val" id="engnow">${esc(v.engine || 'not set')}</span>${v.variant ? ` <span class="src">${esc(v.variant)}</span>` : ''}</div>
    <div class="row"><button class="ghost" id="engpick">Pick engine from the list</button></div><div class="tabbody" id="engform"></div>
    <p class="note">The engine goes into the research request, so each engine gets its own oil and tire values. Nothing changes until you tap Save engine.</p><p class="err" id="engerr"></p></div>
  <div class="card" id="vinbox"><div><span class="lbl">VIN</span> <span class="val" id="vinnow">${esc(v.vin || 'none')}</span></div>
    <div class="row"><input id="vinin" maxlength="17" autocomplete="off" placeholder="17 characters" aria-label="VIN" style="font-family:var(--mono)" value="${esc(v.vin || '')}"><button id="vinsave">Save VIN</button>${scanButton('vinscan')}</div>
    <p class="note">The VIN stays on this car and goes only to NHTSA, to decode the engine and the EV flag.</p><p class="err" id="vinerr"></p></div>
  <div class="row"><button class="ghost" id="del">Delete car</button></div><p id="delmsg"></p>`);
}
// The drawer on the screen. Every save inside it draws the screen under it again (redraw); drawerKey keeps it open.
async function openDrawer(v, id, key) {
  drawerKey = key;
  let w = $('#drawerwrap');
  if (!w) { w = document.createElement('div'); w.id = 'drawerwrap'; w.className = 'drawerwrap'; w.innerHTML = '<div class="dimmer" id="dimmer"></div><aside class="drawer" id="drawer" role="dialog" aria-modal="true"></aside>'; document.body.appendChild(w); }
  const html = await drawerBody(v, id, key);
  if (drawerKey !== key) return;   // closed, or another one opened, while the lists loaded
  $('#drawer').setAttribute('aria-label', DRAWER_TITLE[key]);
  $('#drawer').innerHTML = html;
  $('#dclose').onclick = closeDrawer; $('#dimmer').onclick = closeDrawer;
  wireDrawer(v, id);
}
function closeDrawer() { drawerKey = null; const x = $('#drawerwrap'); if (x) x.remove(); }
function wireDrawer(v, id) {
  const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
  if ($('#weightbox')) wireWeight(v);
  document.querySelectorAll('.vcard').forEach(d => d.addEventListener('click', e => { if (!e.target.closest('button,a,input,select,textarea,form')) d.classList.toggle('open'); }));
  const ct = $('#cautiontoggle'); if (ct) ct.onclick = () => api('/vehicles/' + id, { method: 'PATCH', body: { hide_chart_cautions: +ct.dataset.hide } }).then(() => redraw()).catch(fail);
  on('#ownsave', () => api('/vehicles/' + id, { method: 'PATCH', body: { owner: $('#ownin').value, fuel: $('#fuelin').value } }).then(() => redraw()).catch(e => { $('#ownerr').textContent = e.message; }));
  wireStatus(() => redraw());
  document.querySelectorAll('[data-h]').forEach(b => b.onclick = async () => {
    const box = b.closest('dd').querySelector('.hist');
    const h = await api(`/values/${b.dataset.h}/history`);
    // Ultrareview F10: the torque numbers too ("100 ft-lb → 80 ft-lb"), also when the text did not change.
    const ft = (lo, hi, src) => lo == null ? 'none' : `${lo}${hi != null ? '-' + hi : ''} ft-lb${src === 'converted' ? ' (converted)' : ''}`;
    const ftl = r => { const o = ft(r.old_ftlb_lo, r.old_ftlb_hi, r.old_ftlb_src), n = ft(r.new_ftlb_lo, r.new_ftlb_hi, r.new_ftlb_src);
      return r.old_ftlb_lo == null && r.new_ftlb_lo == null ? '' : r.action === 'insert' ? ` · ${n}` : r.action === 'delete' ? ` · ${o}` : o !== n ? ` · ${o} → ${n}` : ''; };
    // Ultrareview 2 #8: a warning level change ("warning block → none") and a source or note change are shown too (update rows only).
    const WL = ['none', 'caution', 'block'];
    const more = r => r.action !== 'update' ? '' : (r.old_warn != null && r.new_warn != null && r.old_warn !== r.new_warn ? ` · warning ${WL[r.old_warn] || r.old_warn} → ${WL[r.new_warn] || r.new_warn}` : '')
      + (r.old_source != null && r.new_source != null && r.old_source !== r.new_source ? ' · source changed' : '')
      + (r.old_note != null && r.new_note != null && r.old_note !== r.new_note ? ' · note changed' : '');
    box.innerHTML = `<ol class="src">${h.map(r => `<li>${when(r.at)} · ${esc(r.device)} · ${esc(r.action)}${r.old_value != null && r.old_value !== r.new_value ? ` · "${esc(noNm(r.old_value))}" → "${esc(noNm(r.new_value ?? ''))}"` : r.new_value != null ? ` · "${esc(noNm(r.new_value))}"` : ''}${esc(ftl(r))}${esc(more(r))}${r.old_status !== r.new_status ? ` · ${esc(r.old_status ?? '')} → ${esc(r.new_status ?? '')}` : ''}</li>`).join('')}</ol>`;
  });
  wireValueInputs($('#addspec form'));
  document.querySelectorAll('.links a[data-src]').forEach(a => a.addEventListener('click', () => {
    const src = `${a.dataset.src}, ${new Date().toISOString().slice(0, 10)}`;
    store.set('lp-lastsrc', JSON.stringify({ car: v.id, src }));
    const box = $('#addspec input[name=source]'); if (box) box.value = src;
  }));
  wireForm($('#addspec form'), body => api(`/vehicles/${id}/values`, { method: 'POST', body: { ...body, tab, status: body.confirm ? 'confirmed' : 'proposed' } }).then(() => redraw()));
  document.querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    const s = v.values.find(x => x.id == b.dataset.e); const dd = b.closest('dd'); dd.innerHTML = editForm(s);
    // The Value box shows the text without N-m; an unchanged box sends the stored text back, so the stored N-m part stays.
    wireForm(dd.querySelector('form'), body => { if (body.value === noNm(s.value)) body.value = s.value; return api('/values/' + s.id, { method: 'PATCH', body }).then(() => redraw()); }, () => api('/values/' + s.id, { method: 'DELETE' }).then(() => redraw()));
  });
  document.querySelectorAll('.chartcheck').forEach(b => b.onclick = () => api('/chart-checks', { method: 'POST', body: { edition: b.dataset.ed, chart: b.dataset.chart, action: b.dataset.act } })
    .then(() => redraw()).catch(e => { b.parentElement.querySelector('.chartcheckerr').textContent = e.message; }));
  on('#trimsave', () => api('/vehicles/' + id, { method: 'PATCH', body: { trim: $('#trimin').value } }).then(() => redraw()).catch(e => { $('#trimerr').textContent = e.message; }));
  // B7: the server checks the VIN check digit. A failed check is shown; the car is saved only after "Save as a VIN that is not US-market".
  const saveVin = notUs => api('/vehicles/' + id, { method: 'PATCH', body: { vin: $('#vinin').value, ...(notUs ? { not_us: true } : {}) } }).then(() => redraw()).catch(e => {
    $('#vinerr').textContent = e.message;
    if (e.data && e.data.check_failed) { $('#vinerr').insertAdjacentHTML('afterend', '<button class="ghost" id="vinnotus">Save as a VIN that is not US-market</button>'); $('#vinnotus').onclick = () => saveVin(true); }
  });
  on('#vinsave', () => saveVin(false));
  // B4: the one-time "Pick engine from the list" for a car that already exists. It shows the lists; Save engine is the only change.
  on('#engpick', async () => {
    const f = $('#engform'); f.innerHTML = '<p class="note">Reading the list...</p>';
    const q = `year=${v.year}&make=${encodeURIComponent(v.make)}&model=${encodeURIComponent(v.model)}`;
    try {
      const r = await api('/fe?' + q);
      if (!r.variants.length) { f.innerHTML = `<p class="note">${esc(r.error || 'The list has no entry for this car.')} Nothing to pick.</p>`; return; }
      const o = (val, t, sel) => `<option value="${esc(val)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
      f.innerHTML = `<div class="field"><label for="pkvar">Variant</label><select id="pkvar">${r.variants.length > 1 ? o('', 'Pick a variant', !v.variant) : ''}${r.variants.map(x => o(x.text, x.text, x.text === v.variant)).join('')}</select></div>
        <div class="field"><label for="pkeng">Engine</label><select id="pkeng"></select></div><button id="pksave" disabled>Save engine</button>`;
      let opts = [];
      const fill = async () => {
        const vr = $('#pkvar').value; opts = vr ? (await api(`/fe?${q}&variant=${encodeURIComponent(vr)}`)).options : [];
        $('#pkeng').innerHTML = o('', 'Pick the engine', !v.fe_id) + opts.map(x => o(x.value, x.text, +x.value === v.fe_id)).join(''); $('#pksave').disabled = !$('#pkeng').value;
      };
      $('#pkvar').onchange = fill; $('#pkeng').onchange = () => { $('#pksave').disabled = !$('#pkeng').value; };
      if ($('#pkvar').value) await fill();
      $('#pksave').onclick = () => { const x = opts.find(y => y.value === $('#pkeng').value); api('/vehicles/' + id, { method: 'PATCH', body: { variant: $('#pkvar').value, fe_id: +x.value, engine: /\d\.\d\s*L\b/i.test(x.text) ? x.text : '' } }).then(() => redraw()).catch(e => { $('#engerr').textContent = e.message; }); };
    } catch (e) { $('#engerr').textContent = e.message; }
  });
  wireScan('vinscan', vin => { $('#vinin').value = vin; $('#vinerr').textContent = 'VIN read from the photo - check it, then Save VIN.'; }, m => { $('#vinerr').textContent = m; });
  document.querySelectorAll('[data-g]').forEach(b => b.onclick = () => api('/vehicles/' + id, { method: 'PATCH', body: { grp: b.dataset.g } }).then(() => redraw()).catch(fail));
  on('#research', () => api('/jobs', { method: 'POST', body: { vehicle_id: +id, kind: 'research' } }).then(() => redraw()).catch(e => { $('#delmsg').textContent = e.message; }));
  on('#del', () => { $('#delmsg').innerHTML = `This deletes the car, its own values and its service log. Values for the model and year stay. <button class="primary" id="del2">Yes, delete</button>`; $('#del2').onclick = () => api('/vehicles/' + id, { method: 'DELETE' }).then(() => { closeDrawer(); location.hash = '#/'; }); });
}
// ---------- The Lift screen (HANDOFF 19, D3): the cautions, the points and the chart on one screen; everything else is behind Checks ----------
const CHECKED_SHORT = { rick: 'chart checked by Rick', ai: 'chart AI-checked', no: 'chart not checked' };
const CAUT_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>';
async function liftPage(id) {
  const live = fresh();
  if (!meta) meta = await api('/tabs');
  const v = await api(`/vehicles/${id}?peek=1`);
  if (!live()) return;
  const a = v.ali, n = v.chart_notes, cs = cautionsOf(v), pts = pickVal(v, 'Points');
  const stop = !!n && /^Do not use a 2-post/.test(n.kit_mark || '');
  crumb('', `<b>${esc(carName(v))}</b> <span class="trim">Lift</span>`);
  $('#hnav').innerHTML = `<a class="btn t48" href="#/car/${id}">Back to car</a>`;
  const cautBox = s => `<div class="caut ${s.warn === 2 ? 'block' : ''}" data-level="${s.warn === 2 ? 'block' : 'caution'}"><div class="row">${CAUT_ICON}<b class="cauttitle">${s.warn === 2 ? 'Do not lift yet' : 'Caution'} - ${esc(s.field)}</b>
    <span class="badges">${badgesOf(s)}</span><button class="ibtn t48" data-drawer="caution" aria-label="Source and chart checks">i</button></div><div class="cautfull">${esc(s.value)}</div></div>`;
  const pads = ((v.chart_notes_footer || '').match(/(\d+(?:\.\d+)?-\d+(?:\.\d+)?)\s*in\b/i) || [])[1];
  const adapters = n ? (!n.adapters || /^no adapter/i.test(n.adapters) ? 'none' : n.adapters) : 'no notes';
  const chartLine = a ? `<span class="lbl">Chart</span><span class="val v28">${esc(a.chart)}</span>${a.status !== 'ok' ? missing('page') : a.d !== 0 ? confPill('Medium') : confPill('High')}<span class="src">adapters: ${esc(adapters)}${pads ? ` · pads ${esc(pads)} in` : ''}</span>` : `<span class="lbl">Chart</span>${missing('chart')}`;
  const level = n && CHECKED_SHORT[n.verified] ? n.verified : 'no';
  const curb = v.curb ? `Curb weight ${lbPlain(v.curb.lb)} lb ${pill(v.curb.status === 'confirmed' ? 'confirmed' : 'proposed')}` : 'Curb weight not known yet';
  const mismatch = a && a.d !== 0 ? `<div class="warn">ALI chart ${esc(a.chart)} covers ${a.year_from}-${a.year_to}, not ${v.year}. Check it is the same body before you use it. (guide p.${a.guide_page})</div>` : '';
  const chartView = a && a.img ? `<div class="chartbox"><div class="row charthead"><b>${esc(a.chart)}${a.box ? ' · zoomed' : ''} · guide p.${a.guide_page}</b><span class="src">ALI ${esc(a.edition)} · ${a.year_from}-${a.year_to}</span></div>
      <div class="vstage lzstage" id="lzstage"><div class="vpage" id="lzpage" style="width:${a.w}px;height:${a.h}px"><img src="${esc(a.img)}" alt="ALI ${esc(a.edition)} guide page ${a.guide_page}${a.box ? ', chart ' + esc(a.chart) + ' zoomed' : ''}" draggable="false"></div></div>
      <span class="src">Pinch to zoom here.</span></div><a class="btn big amber" href="#/car/${id}/page">Whole page p.${a.guide_page} full screen</a>`
    : a && a.status === 'missing_from_scan' ? `<div class="warn bad">The page for chart ${esc(a.chart)} (guide p.${a.guide_page}) is missing from the ${esc(a.edition)} scan. Use a paper guide.</div>`
    : `<div class="warn bad">No ALI chart for this car in the lift guide.</div>`;
  $('#view').innerHTML = `<div class="carscreen liftscreen" data-car="${id}"><div class="liftleft">
    ${stop ? `<div class="caut block" data-level="block"><div class="row">${CAUT_ICON}<b class="cauttitle">Do not use a 2-post</b></div><div class="cautfull">The chart says so. Read its words in Checks.</div></div>` : ''}
    ${cs.map(cautBox).join('')}${mismatch}
    <div class="panel pointspanel"><div class="row"><span class="lbl">Points</span>${pts && pts.is_safety ? '<span class="pill">Safety value</span>' : ''}<span class="badges">${pts ? badgesOf(pts) : missing('points')}</span><button class="ibtn t48" data-drawer="lift" aria-label="Source of the points">i</button></div>
      <div class="val v28">${pts ? esc(pts.value) : 'No value yet.'}</div></div>
    <div class="row chartline">${chartLine}</div>
    ${n && n.cautions ? `<div class="chartq"><b>From the chart:</b> ${esc(n.cautions)}</div>` : ''}
    <div class="row"><span class="src grow">${curb} · ${CHECKED_SHORT[level]}</span><button type="button" class="t64" data-drawer="checks">Checks (i)</button></div></div>
    <div class="liftright">${chartView}</div></div>`;
  redraw = () => liftPage(id);
  document.querySelectorAll('[data-drawer]').forEach(b => b.onclick = () => openDrawer(v, id, b.dataset.drawer));
  if (a && a.img) zoomStage($('#lzstage'), $('#lzpage'), a.w, a.h, a.box);
  if (drawerKey) openDrawer(v, id, drawerKey);
}
// Pinch zoom, drag and double tap for the small chart view. It is the page viewer's logic in a box; the viewer itself (Whole page) is unchanged.
function zoomStage(stage, pg, W, H, box) {
  let s = 1, x = 0, y = 0, start = null, moved = false, lastTap = 0;
  const pts = new Map();
  const fit = () => Math.min(stage.clientWidth / W, stage.clientHeight / H);
  const draw = () => {
    const f = fit(); s = Math.min(Math.max(s, f), f * 8);
    const pw = W * s, ph = H * s, sw = stage.clientWidth, sh = stage.clientHeight;
    x = pw <= sw ? (sw - pw) / 2 : Math.min(0, Math.max(sw - pw, x));
    y = ph <= sh ? (sh - ph) / 2 : Math.min(0, Math.max(sh - ph, y));
    pg.style.transform = `translate(${x}px,${y}px) scale(${s})`; pg.dataset.zoom = (s / f).toFixed(3);
  };
  const zoomAt = (ns, cx, cy) => { x = cx - (cx - x) * ns / s; y = cy - (cy - y) * ns / s; s = ns; draw(); };
  const home = () => {
    if (box) { s = Math.min(stage.clientWidth / (box.w * W), stage.clientHeight / (box.h * H)) * 0.96; draw(); x = stage.clientWidth / 2 - (box.x + box.w / 2) * W * s; y = stage.clientHeight / 2 - (box.y + box.h / 2) * H * s; }
    else s = fit();
    draw();
  };
  const local = e => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const snap = () => { const p = [...pts.values()], two = p.length > 1; return { n: p.length, s, x, y, mid: two ? [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2] : p[0], dist: two ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0 }; };
  stage.addEventListener('pointerdown', e => { try { stage.setPointerCapture(e.pointerId); } catch (err) { /* a pointer the browser no longer tracks */ } pts.set(e.pointerId, local(e)); moved = false; start = snap(); });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, local(e));
    const now = snap(); if (!start || now.n !== start.n) { start = now; return; }
    if (Math.hypot(now.mid[0] - start.mid[0], now.mid[1] - start.mid[1]) > 6 || now.n > 1) moved = true;
    s = start.s; x = start.x + now.mid[0] - start.mid[0]; y = start.y + now.mid[1] - start.mid[1];
    if (now.n > 1 && start.dist) zoomAt(start.s * now.dist / start.dist, now.mid[0], now.mid[1]); else draw();
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return; const p = local(e); pts.delete(e.pointerId);
    start = pts.size ? snap() : null;
    if (pts.size || moved) return;
    const t = Date.now();
    if (t - lastTap < 350) { zoomAt(s > fit() * 1.5 ? fit() : s * 2.5, p[0], p[1]); lastTap = 0; } else lastTap = t;
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', e => { e.preventDefault(); const p = local(e); zoomAt(s * Math.exp(-e.deltaY * 0.002), p[0], p[1]); }, { passive: false });
  const onResize = () => { if (stage.isConnected) home(); else removeEventListener('resize', onResize); };
  addEventListener('resize', onResize);
  home();
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
// HANDOFF 15: the Torque field also takes the ft-lb numbers that the screen shows (two boxes and printed / converted).
const ftlbBoxes = s => `<div class="row"><div class="field"><label for="fl">ft-lb (low)</label><input id="fl" name="ftlb_lo" inputmode="numeric" required value="${s && s.ftlb_lo != null ? s.ftlb_lo : ''}"></div>
  <div class="field"><label for="fh">ft-lb (high, optional)</label><input id="fh" name="ftlb_hi" inputmode="numeric" value="${s && s.ftlb_hi != null ? s.ftlb_hi : ''}"></div>
  <div class="field"><label for="fs">Number is</label><select id="fs" name="ftlb_src"><option value="printed" ${s && s.ftlb_src === 'converted' ? '' : 'selected'}>printed in the source</option><option value="converted" ${s && s.ftlb_src === 'converted' ? 'selected' : ''}>converted from N-m</option></select></div></div>`;
const valueInputs = name => (tab === 'oil' && OIL_UI[name]) ? OIL_UI[name].html()
  : `<div class="field"><label for="vv">Value</label><input id="vv" name="value" placeholder="e.g. 100 ft-lb" required></div>${tab === 'torque' && name === 'Torque' ? ftlbBoxes(null) : ''}`;
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
  <div class="field"><label>Value</label><input name="value" value="${esc(noNm(s.value))}" required></div>
  ${s.tab === 'torque' && s.field === 'Torque' ? ftlbBoxes(s) : ''}
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
  // Delete needs a second tap (REVIEW problem 10): the first tap only arms the button.
  const rm = f.querySelector('[data-rm]'); if (rm && remove) rm.onclick = () => {
    if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = 'Tap again to delete'; setTimeout(() => { delete rm.dataset.armed; rm.textContent = 'Delete value'; }, 5000); return; }
    remove().catch(x => f.querySelector('.err').textContent = x.message);
  };
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
// HANDOFF 18 (C0.2): a photo name is a UTC time (2026-10-28T12-34-58-123Z.jpg). Show it as local time, "2026-10-28 08:34".
const photoWhen = name => {
  const m = String(name).match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)(?:-(\d{1,3}))?Z/);
  if (!m) return name;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
async function jamb(id) {
  const live = fresh();
  const v = await api(`/vehicles/${id}?peek=1`);
  const photos = await api(`/vehicles/${id}/photos`).catch(() => []);
  if (!live()) return;
  crumb(`${v.year} ${v.make} ${v.model} · door-jamb label`);
  $('#view').innerHTML = `<section class="card phoneflow"><h2>Door-jamb label</h2><div class="src">${v.year} ${esc(v.make)} ${esc(v.model)} ${esc(v.trim)}</div>
    <ul class="note"><li>Driver door open, label on the door pillar.</li><li>Get the whole label, no glare.</li><li>The photo stays in your private storage. No one else reads it.</li></ul>
    <span class="src offlinewhy">Scanning needs a connection.</span>
    <label class="btn primary big needsnet" for="jscan">Scan door jamb</label><input type="file" id="jscan" accept="image/*" capture="environment" hidden>
    <p class="note">Scan reads the photo for you (the VIN label for the VIN, the tire label for the tires). Claude sees only the photo and the car's year, make, model and engine. It never sees the saved VIN. You confirm every value. It takes about 2 minutes.</p>
    <label class="btn big" for="jcam">Take photo and type the values</label><input type="file" id="jcam" accept="image/*" capture="environment" hidden>
    <label class="btn big" for="jpick">Choose from photos</label><input type="file" id="jpick" accept="image/*" hidden>
    <p class="err" id="jerr"></p>
    ${photos.length ? `<h3 class="lbl">Earlier photos</h3><div class="row">${photos.slice(0, 6).map(ph => `<a class="btn" href="#/car/${v.id}/jamb/${esc(ph.name)}">${esc(photoWhen(ph.name))}</a>`).join('')}</div>` : ''}
    <a class="btn" href="#/car/${v.id}">Back to the car</a></section>`;
  const up = scan => async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    $('#jerr').textContent = 'Saving the photo...';
    try {
      const b = await shrink(f);
      const r = await fetch(`/api/vehicles/${id}/photos`, { method: 'POST', headers: { 'content-type': b.type || 'image/jpeg', 'x-lp-device': device }, body: b });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      if (!scan) { location.hash = `#/car/${id}/jamb/${d.name}`; return; }
      const j = await api(`/vehicles/${id}/doorcard`, { method: 'POST', body: { photo: d.name } });
      watchRead(id, j.id);
    } catch (x) { $('#jerr').textContent = x.message; }
  };
  $('#jscan').onchange = up(true); $('#jcam').onchange = up(false); $('#jpick').onchange = up(false);
}
// B6, B12: after "Scan door jamb" the phone waits for the read job (the N100 checks the queue every minute) and shows its end.
const READ_WAIT_MS = 5000, READ_WAIT_TRIES = 60;
async function watchRead(id, jobId) {
  const live = fresh();
  $('#view').innerHTML = `<section class="card phoneflow"><h2>Reading the photo</h2><p class="note" id="rd">Reading the photo - about 2 minutes.</p>
    <p class="note">You can leave this page. The values wait in Needs confirming, beside the photo.</p><a class="btn" href="#/car/${id}">Back to the car</a></section>`;
  for (let i = 0; i < READ_WAIT_TRIES; i++) {
    await new Promise(r => setTimeout(r, READ_WAIT_MS)); if (!live()) return;
    const v = await api(`/vehicles/${id}?peek=1`).catch(() => null); if (!live()) return;
    const j = v && v.jobs.find(x => x.id === jobId);
    if (j && j.status === 'done') { $('#view').innerHTML = `<section class="card phoneflow"><h2>Photo read</h2><p class="note">${esc(j.result_summary || 'Done.')}</p><a class="btn primary big" href="#/confirm">Check and confirm</a><a class="btn" href="#/car/${id}">Back to the car</a></section>`; return; }
    if (j && j.status === 'failed') {
      const limit = /^daily_limit/.test(j.error || '');
      $('#view').innerHTML = `<section class="card phoneflow"><h2>${limit ? 'Daily limit reached' : 'The photo was not read'}</h2><p class="${limit ? 'note' : 'err'}" id="rderr">${limit ? 'Daily limit reached - type the values or try tomorrow' : esc(j.error || 'The read failed.')}</p><a class="btn primary big" href="#/car/${id}/jamb">Type the values</a><a class="btn" href="#/car/${id}">Back to the car</a></section>`;
      return;
    }
  }
  if (live()) $('#rd').textContent = 'Still reading. You can leave this page; the values will appear in Needs confirming.';
}
// P2: the photo beside the fields. "Correct - confirm" saves confirmed High (the placard is the
// maker's own label); "Save as proposed" keeps them for later. They are this car's own values.
async function jambRead(id, name) {
  const live = fresh();
  const v = await api(`/vehicles/${id}?peek=1`);
  if (!live()) return;
  const own = f => v.values.find(x => x.tab === 'tires' && x.field === f && x.scope === 'car');
  const cur = f => (own(f) || v.values.find(x => x.tab === 'tires' && x.field === f) || {}).value || '';
  // HANDOFF 18 (C0.3): a model value is often written "38 F / 44 R psi", "38 psi F / 44 psi R" or "Front 38, Rear 44". The old pattern needed
  // "38 / 44", read only the 38 and put it in the rear field too (the i4 rear psi, placard 38 F / 44 R). Now: the first two numbers from 10 to 99
  // (tire sizes skipped) are front and rear; one number is both. (The same rule is psiPair in src/lib.js, graded by test_lib.js.)
  const psiNums = (cur('Pressure').replace(/\b\d{3}\/\d{2}\s?[A-Za-z]{0,2}\s?R?\s?\d{2}\b/g, ' ').match(/\d+(?:\.\d+)?/g) || []).filter(x => +x >= 10 && +x <= 99);
  const pr = psiNums.length ? [null, psiNums[0], psiNums[1] || psiNums[0]] : null;
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
      location.hash = '#/car/' + v.id;
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
    <div class="vbar"><a class="btn primary" href="#/car/${v.id}/lift">Close</a>
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
let appsBack = '#/';   // Back on the Apps screen: the screen it came from
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

// ---------- Service log (HANDOFF 15) ----------
// The fifth tab, the cart ("Log work"), the history of one car (#/car/<id>/history) and of all cars (#/history).
// A visit = one date and one mileage with several items. The server checks the date (400) and the mileage order (409, then
// "Yes, that is right" sends force=1). Edit and delete are for Rick; a delete is soft and keeps a history row.
const todayStr = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const miles = n => Number(n).toLocaleString('en-US');
const itemLine = i => `${esc(i.name)}${i.option ? ' - ' + esc(i.option) : ''}${i.other_text ? ': ' + esc(i.other_text) : ''}`;
const visitHtml = (e, withCar) => `<div class="visit vcard" data-e="${e.id}" tabindex="0"><div class="vhead"><b>${esc(e.date)}</b><span>${miles(e.mileage)} mi</span>${withCar ? `<span class="tag">${esc(carName(e))}</span>` : ''}</div>
  <ul>${e.items.map(i => `<li>${itemLine(i)}</li>`).join('')}</ul>${e.low ? '<div class="src lowmi">mileage lower than the last visit</div>' : ''}
  <div class="row vacts"><button class="ghost" data-repeat="${e.id}">Repeat</button><button class="ghost" data-vedit="${e.id}">Edit</button><button class="ghost" data-vdel="${e.id}">Delete</button></div></div>`;
// HANDOFF 19 (D7): a visit with a lower mileage than an older visit of the same car gets a grey note on the line (no block).
function flagLow(entries) {
  entries.forEach(e => { e.low = entries.some(o => o.vehicle_id === e.vehicle_id && (o.date < e.date || (o.date === e.date && o.id < e.id)) && o.mileage > e.mileage); });
  return entries;
}
// HANDOFF 19 (D6): the cart is kept in this browser (lp-cart) so a reload does not lose it. A visit sent while offline is kept as a draft (lp-draft)
// and sent through the normal server checks (date, mileage order, 409) when the connection is back.
// HANDOFF 20 (E2): one saved cart per car. lp-cart holds { "<car id>": { items, date, mileage } }; the older single-cart form { car, items, date, mileage } is read as one entry.
const cartAll = () => { try { const c = JSON.parse(store.get('lp-cart') || 'null'); return !c || typeof c !== 'object' ? {} : c.car != null ? { [c.car]: { items: c.items, date: c.date, mileage: c.mileage } } : c; } catch (e) { return {}; } };
const cartWrite = all => store.set('lp-cart', Object.keys(all).length ? JSON.stringify(all) : '');
const cartSave = () => { if (!cart || cart.editId) return; const all = cartAll(); all[cart.car] = { items: [...cart.items.entries()], date: cart.date, mileage: cart.mileage }; cartWrite(all); };
const cartDrop = () => { const c = cart; cart = null; if (!c || c.editId) return; const all = cartAll(); delete all[c.car]; cartWrite(all); };
const cartLoad = id => { const c = cartAll()[+id]; try { return c ? { car: +id, items: new Map(c.items), date: c.date, mileage: c.mileage, editId: null, keep: null } : null; } catch (e) { return null; } };
// Drafts are a list (one per visit), so a second offline visit does not replace the first.
const readDrafts = () => { try { const d = JSON.parse(store.get('lp-draft') || '[]'); return Array.isArray(d) ? d : [d]; } catch (e) { return []; } };
const writeDrafts = list => store.set('lp-draft', list.length ? JSON.stringify(list) : '');
let cart = null;   // { car, items: Map(item_id -> { option, other }), date, mileage, editId }
function wireVisits(entries, reload) {
  document.querySelectorAll('.visit').forEach(d => d.addEventListener('click', e => { if (!e.target.closest('button,a')) d.classList.toggle('open'); }));
  const find = b => entries.find(e => e.id == b);
  const start = (e, editId) => {
    // keep: an edit keeps the visit's own items, also one the car no longer offers (ultrareview F5).
    cart = { car: e.vehicle_id, items: new Map(e.items.map(i => [i.item_id, { option: i.option, other: i.other_text }])), date: editId ? e.date : todayStr(), mileage: editId ? String(e.mileage) : '', editId,
      keep: editId ? new Set(e.items.map(i => i.item_id)) : null };
    location.hash = `#/car/${e.vehicle_id}/log`;
  };
  document.querySelectorAll('[data-repeat]').forEach(b => b.onclick = () => start(find(b.dataset.repeat), null));   // Repeat: same items, date today, mileage empty
  document.querySelectorAll('[data-vedit]').forEach(b => b.onclick = () => start(find(b.dataset.vedit), +b.dataset.vedit));
  document.querySelectorAll('[data-vdel]').forEach(b => b.onclick = () => {
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; return; }
    api('/service/' + b.dataset.vdel, { method: 'DELETE' }).then(reload).catch(fail);
  });
}
async function logPage(id) {
  const live = fresh();
  const [d, v] = await Promise.all([api(`/vehicles/${id}/service`), api(`/vehicles/${id}?peek=1`)]);
  if (!live()) return;
  if (!cart || cart.car !== +id) cart = cartLoad(id) || { car: +id, items: new Map(), date: todayStr(), mileage: '', editId: null, keep: null };
  crumb('Log work');
  // Ultrareview F5: the items shown are the ones the car offers now, plus (in an edit) the visit's own items that it no longer offers.
  // An item in the cart that is in neither list is named on the screen, never dropped without a word.
  const all = d.all_items || [], keep = cart.editId && cart.keep ? cart.keep : new Set();
  const shown = [...d.items, ...all.filter(i => keep.has(i.id) && !d.items.some(x => x.id === i.id)).map(i => ({ ...i, kept: true }))];
  let busy = false;   // one send at a time (ultrareview F4)
  // The first summary line (date, mileage, miles since the last visit). Typing a mileage updates only this line: a redraw on blur
  // would replace the Submit button between the finger going down and up, and the tap would be lost.
  const sumLine = () => {
    const ok = /^\d+$/.test(cart.mileage);
    const since = ok && d.last_mileage != null ? +cart.mileage - d.last_mileage : null;
    return `${esc(cart.date)} · ${cart.mileage ? miles(cart.mileage) + ' mi' : 'no mileage yet'}${since != null ? ` <span class="src">(${since >= 0 ? '+' : ''}${miles(since)} mi since the last visit)</span>` : ''}`;
  };
  const draw = () => {
    const sel = [...cart.items.entries()].map(([iid, c]) => ({ it: shown.find(i => i.id === iid), c })).filter(x => x.it);
    const lost = [...cart.items.keys()].filter(k => !shown.some(i => i.id === k)).map(k => (all.find(i => i.id === k) || { name: 'item ' + k }).name);
    const miOk = /^\d+$/.test(cart.mileage);
    const ready = sel.length && miOk && sel.every(({ it, c }) => (!it.choices || c.option) && (!it.text || (c.other || '').trim()));
    $('#view').innerHTML = `<section class="card cartpage"><div class="carhead"><a class="btn" href="#/car/${id}">Back</a><div><h2>${cart.editId ? 'Edit visit' : 'Log work'}</h2><div class="src">${esc(carName(v))}</div></div></div>
      <div class="cartitems">${shown.map(it => {
        const on = cart.items.has(it.id), c = cart.items.get(it.id) || {}, ld = d.last_done[it.id];
        return `<div class="cartitem${on ? ' on' : ''}"><button type="button" class="itembtn" data-item="${it.id}" aria-pressed="${on}">${esc(it.name)}</button>
          ${it.kept ? '<span class="src keptnote">In this visit. Not offered for this car now.</span>' : ''}
          ${ld ? `<span class="src lastdone">Last: ${esc(ld.date)} at ${miles(ld.mileage)} mi</span>` : ''}
          ${on && it.choices ? `<div class="seg">${it.choices.map(o => `<button type="button" data-opt="${it.id}" data-v="${esc(o)}" aria-pressed="${c.option === o}">${esc(o)}</button>`).join('')}</div>` : ''}
          ${on && it.text ? `<input class="othertext" data-other="${it.id}" maxlength="120" placeholder="One line, for example transmission fluid" value="${esc(c.other || '')}" aria-label="Other work">` : ''}</div>`; }).join('')}</div>
      <div class="row cartfields"><div class="field"><label for="cdate">Date</label><input type="date" id="cdate" value="${esc(cart.date)}" max="${todayStr()}"></div>
        <div class="field"><label for="cmiles">Mileage</label><input id="cmiles" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="${d.last_mileage != null ? miles(d.last_mileage) : 'miles'}" value="${esc(cart.mileage)}"></div></div>
      <div class="cartsum" aria-label="Summary"><b>Summary</b><div id="sumline">${sumLine()}</div>
        <ul>${sel.map(({ it, c }) => `<li>${itemLine({ name: it.name, option: c.option || '', other_text: c.other || '' })}</li>`).join('') || '<li class="note">No items yet. Tap an item above.</li>'}</ul></div>
      ${lost.length ? `<div class="warn" id="cartlost"><b>Left out:</b> ${esc(lost.join(', '))}. This car does not offer ${lost.length === 1 ? 'it' : 'them'} now, so ${lost.length === 1 ? 'it is' : 'they are'} not in this visit.</div>` : ''}
      <div id="cartwarn"></div>
      <button class="primary big submit" id="csubmit" ${ready ? '' : 'disabled'}>${cart.editId ? 'Save visit' : navigator.onLine ? 'Submit' : "Not sent - I'll send it when you're back online"}</button><p class="err" id="cerr"></p></section>`;
    cartSave();
    document.querySelectorAll('[data-item]').forEach(b => b.onclick = () => { const k = +b.dataset.item; if (cart.items.has(k)) cart.items.delete(k); else cart.items.set(k, { option: '', other: '' }); draw(); });
    document.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => { cart.items.get(+b.dataset.opt).option = b.dataset.v; draw(); });
    const readyNow = () => sel.length > 0 && /^\d+$/.test(cart.mileage) && sel.every(({ it, c }) => (!it.choices || c.option) && (!it.text || (c.other || '').trim()));
    document.querySelectorAll('[data-other]').forEach(i => i.oninput = () => { cart.items.get(+i.dataset.other).other = i.value; $('#csubmit').disabled = !readyNow(); cartSave(); });
    $('#cdate').onchange = e => { cart.date = e.target.value || todayStr(); $('#sumline').innerHTML = sumLine(); cartSave(); };
    $('#cmiles').oninput = e => { cart.mileage = e.target.value.replace(/\D/g, ''); e.target.value = cart.mileage; $('#sumline').innerHTML = sumLine(); $('#csubmit').disabled = !readyNow(); cartSave(); };
    // The 409 answer (the mileage does not fit the visits before and after): one message and a button that sends again with force=1.
    const showNeed = j => {
      const nb = x => x ? `${esc(x.date)} at ${miles(x.mileage)} mi` : 'none';
      $('#cartwarn').innerHTML = `<div class="warn bad"><b>Check the mileage.</b> The visit before is ${nb(j.before)}. The visit after is ${nb(j.after)}. <button class="primary" id="forcego">Yes, that is right</button></div>`;
      $('#forcego').onclick = () => go(true);
    };
    const send = async force => {
      const body = { date: cart.date, mileage: +cart.mileage, force: force ? 1 : 0, items: sel.map(({ it, c }) => ({ item_id: it.id, option: c.option || '', other_text: c.other || '' })) };
      // Offline: a new visit is kept as a draft and goes out when the connection is back. An edit needs the connection.
      const keepDraft = () => { writeDrafts([...readDrafts(), { car: +id, body, at: Date.now() }]); cartDrop(); location.hash = '#/car/' + id; };
      if (!navigator.onLine) {
        if (cart.editId) { $('#cerr').textContent = 'Saving a change to a visit needs a connection.'; return; }
        return keepDraft();
      }
      let r;
      try { r = await fetch(cart.editId ? '/api/service/' + cart.editId : `/api/vehicles/${id}/service`, { method: cart.editId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json', 'x-lp-device': device }, body: JSON.stringify(body) }); }
      catch (e) {   // Wi-Fi without internet: navigator.onLine is true and the send fails. A new visit is kept as a draft.
        if (cart.editId) { $('#cerr').textContent = 'Saving a change to a visit needs a connection.'; return; }
        return keepDraft();
      }
      const j = await r.json().catch(() => ({ error: 'Bad response from server' }));
      if (r.status === 409 && j.confirm_needed) { showNeed(j); return; }
      if (!r.ok) { $('#cerr').textContent = j.error || 'HTTP ' + r.status; return; }
      cartDrop(); location.hash = '#/car/' + id;
    };
    if (cart.need) { const j = cart.need; cart.need = null; if (j.confirm_needed) showNeed(j); else $('#cerr').textContent = j.error || 'The visit was not sent.'; }
    // One tap sends one visit: Submit and "Yes, that is right" are both off while any request runs, POST or PATCH (a double tap would
    // log the visit twice; ultrareview F4). busy also stops a second tap that comes before the button is drawn as off.
    const go = force => {
      if (busy) return;
      busy = true; ['#csubmit', '#forcego'].forEach(s => { const b = $(s); if (b) b.disabled = true; });
      send(force).catch(x => { $('#cerr').textContent = x.message; }).finally(() => { busy = false; const b = $('#csubmit'); if (b) b.disabled = !readyNow(); const f = $('#forcego'); if (f) f.disabled = false; });
    };
    $('#csubmit').onclick = () => go(false);
  };
  draw();
}
// Full-screen history: one car, or all cars (filter by car and owner), with a print view (plain black on white).
async function historyPage(id) {
  const live = fresh();
  const [es, cars] = await Promise.all([api('/service' + (id ? '?car=' + id : '')), api('/vehicles?hidden=1')]);
  if (!live()) return;
  crumb('Service history');
  flagLow(es);
  const owners = [...new Set(es.map(e => e.owner).filter(Boolean))];
  $('#view').innerHTML = `<section class="card historypage"><div class="carhead"><a class="btn" href="${id ? '#/car/' + id : '#/'}">Back</a><div><h2>Service history</h2><div class="src">${id ? '' : 'All cars'}</div></div></div>
    ${id ? '' : `<div class="row nonprint"><div class="field"><label for="fcar">Car</label><select id="fcar"><option value="">All cars</option>${cars.map(c => `<option value="${c.id}">${esc(carName(c))}</option>`).join('')}</select></div>
      <div class="field"><label for="fown">Owner</label><select id="fown"><option value="">All owners</option>${owners.map(o => `<option>${esc(o)}</option>`).join('')}</select></div></div>`}
    <div class="row nonprint"><button id="hprint">Print</button></div>
    <div class="visits" id="hlist"></div></section>`;
  const show = () => {
    const fc = id ? '' : $('#fcar').value, fo = id ? '' : $('#fown').value;
    const rows = es.filter(e => (!fc || e.vehicle_id == fc) && (!fo || e.owner === fo));
    $('#hlist').innerHTML = rows.map(e => visitHtml(e, !id)).join('') || '<p class="note">No visits.</p>';
    wireVisits(rows, () => historyPage(id));
  };
  if (!id) { $('#fcar').onchange = show; $('#fown').onchange = show; }
  $('#hprint').onclick = () => print();
  show();
}
// Leaving the cart with items or a mileage in it asks first (hash routes: links and the hash change, not only beforeunload).
const cartDirty = hash => !!cart && /\/log$/.test(hash) && (cart.items.size > 0 || cart.mileage !== '');
function leaveAsk(to) {
  if ($('#leave')) return;
  const d = document.createElement('div'); d.id = 'leave'; d.className = 'leaveask'; d.setAttribute('role', 'alertdialog');
  d.innerHTML = `<div class="card"><h2>Leave without saving?</h2><p>The visit in the cart is not saved.</p><div class="row"><button class="primary big" id="lstay">Stay</button><button class="big" id="lgo">Leave and lose the cart</button></div></div>`;
  document.body.appendChild(d);
  $('#lstay').onclick = () => d.remove();
  $('#lgo').onclick = () => { d.remove(); cartDrop(); location.hash = to; };
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || !cartDirty(location.hash) || a.getAttribute('href') === location.hash) return;
  e.preventDefault(); e.stopPropagation(); leaveAsk(a.getAttribute('href'));
}, true);
addEventListener('beforeunload', e => { if (cartDirty(location.hash)) { e.preventDefault(); e.returnValue = ''; } });
// Suggestion 8: after 10 minutes with no touch the screen goes back to Home. It waits while a cart or an editor is open.
const IDLE_MS = Number(store.get('lp-idle-ms')) || 600000;
let idleT, routing = 0, updatedApp = false;   // routing: screens that are still loading (the idle timer waits for them); updatedApp: a new version took over (see the end of the file)
// Ultrareview F1: an editor is open = the cart, an open <details> (add a value, Edit car; not the lookup links), or a form that is not inside
// a closed <details> (a value editor in its card, the door-jamb form). The add-value form is always in a car page inside its closed <details>,
// so "#view form" alone matched on every car tab and the screen never went back to Home.
const editorOpen = () => !!document.querySelector('.cartpage, #view details[open]:not(.links), #drawerwrap details[open]:not(.links)') ||[...document.querySelectorAll('#view form, #drawerwrap form')].some(f => !f.closest('details:not([open])'));
function armIdle() {
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    if (updatedApp && !routing && !editorOpen() && !cartDirty(location.hash)) { location.reload(); return; }   // a kiosk page never reloads by itself
    if ((location.hash || '#/') === '#/') return armIdle();
    if (routing || editorOpen()) return armIdle();
    cart = null; location.hash = '#/';   // lp-cart stays: the cart comes back when Log work is opened again
  }, IDLE_MS);
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, armIdle, { passive: true }));
armIdle();

// ---------- Router ----------
async function route() {
  const h = location.hash || '#/';
  const seq = ++routeSeq;
  armIdle();     // opening a screen counts as a touch: the idle timer of the screen before must not send Rick Home from a screen that is still loading
  sendDraft();   // a visit kept offline goes out as soon as there is a connection and no open cart
  $('#hnav').innerHTML = '';   // the home screen fills it
  routing++;
  try {
    if (!device) pickDevice();
    else if (h === '#/add') add();
    else if (h === '#/confirm') await confirmPage();
    else if (h === '#/apps') await appsPage();
    else if (h === '#/admin') await adminPage();
    else if (h === '#/history') await historyPage(0);
    else if (/^#\/car\/\d+\/history$/.test(h)) await historyPage(h.split('/')[2]);
    else if (/^#\/car\/\d+\/log$/.test(h)) await logPage(h.split('/')[2]);
    else if (/^#\/car\/\d+\/lift$/.test(h)) await liftPage(h.split('/')[2]);
    else if (/^#\/car\/\d+\/page$/.test(h)) await viewer(h.split('/')[2]);
    else if (/^#\/car\/\d+\/jamb$/.test(h)) await jamb(h.split('/')[2]);
    else if (/^#\/car\/\d+\/jamb\/[0-9TZ-]+\.(jpg|png|webp)$/.test(h)) await jambRead(h.split('/')[2], h.split('/')[4]);
    else if (h.startsWith('#/car/')) await car(h.slice(6));
    else await home();
  } catch (e) { if (seq === routeSeq) fail(e); }   // a screen Rick already left must not draw its error over the new one ("Car not found" over Home, 2026-10-28)
  finally { routing--; }
}
let holdHash = false;
addEventListener('hashchange', e => {
  const from = new URL(e.oldURL).hash || '#/', to = location.hash || '#/';
  if (holdHash) { holdHash = false; return; }
  // The browser's Back button leaves the cart through the hash too: put the hash back and ask.
  if (cartDirty(from) && !/\/log$/.test(to)) { holdHash = true; location.hash = from; leaveAsk(to); return; }
  if (to === '#/apps' && from !== '#/apps') appsBack = from;   // remember where Apps was opened
  closeDrawer(); route();
});
addEventListener('online', () => { setOffline(false); sendDraft(); });
addEventListener('offline', () => setOffline(true));
if (!navigator.onLine) setOffline(true);
// HANDOFF 19 (D6): a visit kept as a draft while offline goes out through the normal server checks when the connection is back.
// A refusal (409 mileage order, 400) opens the cart again with the draft and the normal message. Nothing is dropped without a word.
let sendingDraft = false;
async function sendDraft() {
  // One run at a time (the start-up call and an online event can come together). The draft leaves the list BEFORE the send and goes back when the send
  // does not reach the server, so a visit is never sent twice. Not while a cart is open: that cart would be replaced.
  if (sendingDraft || !navigator.onLine || cartDirty(location.hash)) return;
  const list = readDrafts(); if (!list.length) return;
  sendingDraft = true;
  try {
    const d = list[0]; writeDrafts(list.slice(1));
    const r = await fetch(`/api/vehicles/${d.car}/service`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lp-device': device }, body: JSON.stringify(d.body) }).catch(() => null);
    if (!r) { writeDrafts([d, ...readDrafts()]); return; }   // still no connection: the draft stays
    const j = await r.json().catch(() => ({ error: 'Bad response from server' }));
    if (r.ok) { if (/^#\/car\/\d+$/.test(location.hash)) route(); }
    else {
      cart = { car: d.car, items: new Map(d.body.items.map(i => [i.item_id, { option: i.option, other: i.other_text }])), date: d.body.date, mileage: String(d.body.mileage), editId: null, keep: null, need: j };
      location.hash = `#/car/${d.car}/log`;
    }
  } finally { sendingDraft = false; }
  if (readDrafts().length && navigator.onLine) sendDraft();
}
sendDraft();
route();
if ('serviceWorker' in navigator) {
  // Rick 2026-10-29 (the tablet kept the page of the old version after the deploy): a page that was opened under a worker is old when a new worker takes
  // control. It reloads at once when nothing is open (no cart, no editor), else at the next idle check. The worker is also asked for an update every hour,
  // so a kiosk page that is never reloaded still finds a new version. (The first load has no worker in control: then Home starts the background save.)
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').then(reg => setInterval(() => reg.update().catch(() => {}), 3600e3)).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (had) { updatedApp = true; if (!routing && !editorOpen() && !cartDirty(location.hash)) location.reload(); return; }
    if ((location.hash || '#/') === '#/') route();
  });
}
