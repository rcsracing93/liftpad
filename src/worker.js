// LiftPad API. Every request comes here first (run_worker_first); paths outside /api/ go to the
// static app in /public (Workers Assets).
import { lookupLinks } from './links.js';
// Cloudflare Access sits in front of the whole hostname. This code adds one check of its own:
// processor routes (and the test clock) need the Access JWT of a service token on an allow-list.
// Values: one row per value in `vals`; every change writes a `history` row in the same D1 batch.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bad = (m, s = 400) => json({ error: m }, s);
const fold = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function score(name, q) {
  q = fold(q.trim()); if (!q) return 2; const n = fold(name);
  if (n.startsWith(q)) return 0;
  return n.split(/[\s\/\-()]+/).some(w => w.startsWith(q)) ? 1 : -1;
}
const yearOk = y => Number.isInteger(y) && y >= 1885 && y <= new Date().getFullYear() + 2;
const CONF = ['High', 'Medium', 'Low'];
// Warning level of a value (HANDOFF 10): 0 none, 1 caution (a standing safety step, shown on the Lift tab
// only), 2 block (an open problem: do not lift yet; shown on Home as well). Not given, '' and false are 0;
// true is 1 (the old yes/no flag). Anything else is null = refused.
const level = v => v === undefined || v === null || v === '' || v === false ? 0 : v === true ? 1 : [0, 1, 2].includes(Number(v)) ? Number(v) : null;
const LEVEL_ERR = 'Warning level must be 0 (none), 1 (caution) or 2 (block)';
const GROUPS = ['mine', 'frequent', 'visitor'];
const FUELS = ['gas', 'diesel', 'hybrid', 'phev', 'ev'];
const HIDE_DAYS = 30, LEASE_MIN = 10, PHOTO_MAX = 8 * 1048576;
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
// Rick 2026-10-27 (after ultrareview F6/F7): the processor token reaches only these routes; every other route answers 403 before it runs.
// Read cars, values and fields (private car keys removed), post values (proposed only), the job routes the research worker and queue.sh
// use (claim, renew, result, fail, whoami), and the service-log CSV for the nightly export. No car add, group change or car delete.
const PROC_ROUTES = [
  ['GET', /^\/api\/(whoami|tabs|vehicles|needs-confirming|service-log\.csv)$/], ['GET', /^\/api\/vehicles\/\d+$/],
  ['POST', /^\/api\/vehicles\/\d+\/values$/], ['POST', /^\/api\/jobs\/claim$/], ['POST', /^\/api\/jobs\/\d+\/(result|renew|fail)$/]];

// ---------- Identity: Access JWT (Cf-Access-Jwt-Assertion), RS256, keys from the team certs URL ----------
let jwks = null, jwksAt = 0;
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
const dec = b => JSON.parse(new TextDecoder().decode(b));
async function claims(req, env) {
  const t = req.headers.get('cf-access-jwt-assertion');
  if (!t || !env.LP_ACCESS_CERTS || !env.LP_ACCESS_AUD) return null;
  const [h, p, s] = t.split('.'); if (!s) return null;
  try {
    const hd = dec(b64u(h)); if (hd.alg !== 'RS256') return null;
    // Ultrareview 2 #1: an empty or failed key list is never cached, and an unknown kid fetches the list again once (key rotation).
    // Rick 2026-10-27: the last good list is kept in memory and in D1 (table access_keys, written only when the list changes). When a
    // fetch fails, the saved list is used; a token is refused only when no list is known at all.
    const load = async () => {
      let ks = [];
      try { const r = await fetch(env.LP_ACCESS_CERTS); if (r.ok) ks = (await r.json()).keys || []; } catch (e) { ks = []; }
      if (ks.length) {
        jwks = ks; jwksAt = Date.now();
        try {
          await env.DB.prepare(`INSERT INTO access_keys(id, jwks, saved_at) VALUES(1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET jwks = excluded.jwks, saved_at = excluded.saved_at WHERE access_keys.jwks <> excluded.jwks`).bind(JSON.stringify(ks), new Date().toISOString()).run();
        } catch (e) { /* a database before migration 0011 has no access_keys table */ }
        return ks;
      }
      if (!jwks) { try { const row = await env.DB.prepare('SELECT jwks FROM access_keys WHERE id = 1').first(); if (row) jwks = JSON.parse(row.jwks); } catch (e) { /* no table */ } }
      return jwks || [];
    };
    if (!jwks || Date.now() - jwksAt > 3600e3) await load();
    let k = (jwks || []).find(x => x.kid === hd.kid);
    if (!k) k = (await load()).find(x => x.kid === hd.kid);
    if (!k) return null;
    const key = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(s), new TextEncoder().encode(h + '.' + p))) return null;
    const c = dec(b64u(p));
    if (![].concat(c.aud).includes(env.LP_ACCESS_AUD) || !(c.exp * 1000 > Date.now())) return null;
    return c;
  } catch (e) { return null; }
}
async function who(req, env) {
  const c = await claims(req, env);
  const token = c && c.common_name ? c.common_name : '';
  const processor = !!token && list(env.LP_PROCESSOR_IDS).includes(token);
  const tool = !!token && (processor || list(env.LP_TOOL_IDS).includes(token));
  const raw = (req.headers.get('x-lp-device') || '').replace(/[^\w .-]/g, '').trim().slice(0, 40);
  const device = processor ? 'processor' : (raw || (c && c.email ? 'browser' : 'unknown'));
  // Test clock: only a tool service token may set "now" (self-test of leases and visitor hiding).
  const t = tool ? Date.parse(req.headers.get('x-lp-now') || '') : NaN;
  const now = new Date(Number.isFinite(t) ? t : Date.now());
  // Ultrareview 2 #1: a request that carries an Access token the Worker cannot verify (bad signature, expired, unknown key, or the
  // Access settings missing) is refused, not treated as an ordinary caller: the processor limits must fail closed.
  const badJwt = !!req.headers.get('cf-access-jwt-assertion') && !c;
  return { email: c && c.email || '', token, processor, tool, device, badJwt, now: now.toISOString(), nowMs: now.getTime() };
}

// ---------- Makes and models (unchanged rules) ----------
async function makes(env, q) {
  const { results } = await env.DB.prepare('SELECT name, aliases FROM makes').all();
  const mine = new Set((await env.DB.prepare("SELECT DISTINCT make FROM vehicles WHERE grp='mine'").all()).results.map(r => r.make));
  return results.map(r => { const ss = [r.name, ...(r.aliases ? r.aliases.split('|') : [])].map(n => score(n, q)).filter(x => x >= 0); return { name: r.name, mine: mine.has(r.name), s: ss.length ? Math.min(...ss) : -1 }; })
    .filter(r => r.s >= 0).sort((a, b) => a.s - b.s || (b.mine - a.mine) || a.name.localeCompare(b.name)).slice(0, 10)
    .map(({ name, mine }) => ({ name, mine }));
}
// Ultrareview 2 #9: the make as the makes table spells it (name, nhtsa_name or an alias, any case), else the text as given.
// The VIN decode gave "Bmw" for BMW, and the value lookups compare make with = (case matters), so that car missed its values.
async function canonMake(env, s) {
  const t = String(s || '').trim(); if (!t) return t;
  const r = await env.DB.prepare(`SELECT name FROM makes WHERE name = ?1 COLLATE NOCASE OR nhtsa_name = ?1 COLLATE NOCASE
    OR ('|' || COALESCE(aliases, '') || '|') LIKE ('%|' || ?1 || '|%') ORDER BY (name = ?1 COLLATE NOCASE) DESC LIMIT 1`).bind(t).first();
  return r ? r.name : t;
}
async function nhtsaModels(env, make, year) {
  const m = await env.DB.prepare('SELECT nhtsa_name FROM makes WHERE name=?').bind(make).first();
  const nm = (m && m.nhtsa_name) || make;
  if (year < 1981) return [];
  const out = new Set();
  for (const vt of ['car', 'truck', 'mpv']) {
    try {
      const r = await fetch(`${env.NHTSA}/GetModelsForMakeYear/make/${encodeURIComponent(nm)}/modelyear/${year}/vehicletype/${vt}?format=json`, { cf: { cacheTtl: 86400, cacheEverything: true } });
      if (!r.ok) continue;
      const d = await r.json();
      for (const x of d.Results || []) if (fold(x.Make_Name) === fold(nm)) out.add(x.Model_Name.trim());
    } catch (e) { /* NHTSA down: fall back to local lists */ }
  }
  return [...out];
}
async function models(env, make, year, q, withNhtsa) {
  const map = new Map();
  const add = (label, extra) => { const k = fold(label); if (!map.has(k)) map.set(k, { label, charts: [], source: extra.source }); const o = map.get(k); if (extra.chart) o.charts.push(extra.chart); if (extra.unknown) o.unknown = true; };
  // Newest edition first (decision 3): its charts come first in each model's list.
  const ali = await env.DB.prepare('SELECT model, chart, guide_page, pdf_page, status, year_from, year_to, edition FROM ali_index WHERE make=? AND year_from<=? AND year_to>=? ORDER BY edition DESC, id').bind(make, year, year).all();
  ali.results.forEach(r => add(r.model, { source: 'ALI', chart: { chart: r.chart, guide_page: r.guide_page, pdf_page: r.pdf_page, status: r.status, years: `${r.year_from}-${r.year_to}`, edition: r.edition } }));
  const cl = await env.DB.prepare('SELECT model, year_from, year_to, model_years FROM classics WHERE make=? AND (year_from IS NULL OR (year_from<=? AND year_to+(1-model_years)>=?))').bind(make, year, year).all();
  cl.results.forEach(r => add(r.model, { source: 'classics', unknown: r.year_from == null }));
  if (withNhtsa) (await nhtsaModels(env, make, year)).forEach(n => add(n, { source: 'NHTSA' }));
  return [...map.values()].map(o => ({ ...o, s: score(o.label, q || '') }))
    .filter(o => o.s >= 0 && !(o.unknown && !(q || '').trim()))
    .sort((a, b) => (!!a.unknown - !!b.unknown) || a.s - b.s || a.label.localeCompare(b.label))
    .map(({ s, ...o }) => o);
}
// The chart nearest to the car's year; on a tie the newest edition wins (decision 3: older editions
// stay as fallback). Make and model match without regard to case (HANDOFF 9: the guides spell some
// names differently, for example CT200H in 2019 and CT200h in 2026; NOCASE folds ASCII letters only). img: the page image route when the page is in ali_pages (w, h in pixels).
const pageKey = (edition, pdf) => `ali/${edition}/p${String(pdf).padStart(3, '0')}.jpg`;
async function nearestChart(env, make, model, year) {
  const { results } = await env.DB.prepare(`SELECT a.chart, a.guide_page, a.pdf_page, a.status, a.year_from, a.year_to, a.edition, p.w, p.h,
    b.x bx, b.y by, b.w bw, b.h bh
    FROM ali_index a LEFT JOIN ali_pages p ON p.edition = a.edition AND p.pdf_page = a.pdf_page AND p.status = 'ok'
    LEFT JOIN ali_chart_boxes b ON b.edition = a.edition AND b.chart = a.chart AND b.pdf_page = a.pdf_page
    WHERE a.make = ? COLLATE NOCASE AND a.model = ? COLLATE NOCASE ORDER BY a.edition DESC, a.id`).bind(make, model).all();
  let best = null;
  for (const r of results) { const d = year < r.year_from ? r.year_from - year : year > r.year_to ? year - r.year_to : 0; if (!best || d < best.d) best = { ...r, d }; }
  if (!best) return null;
  const { bx, by, bw, bh, ...a } = best;
  a.img = a.w ? '/api/' + pageKey(a.edition, a.pdf_page) : null;
  a.box = bx == null ? null : { x: bx, y: by, w: bw, h: bh };
  return a;
}
// Decision 6: a chart box, drawn once (the Mac outline mode) and used by every car on that chart.
async function setBox(env, b, me) {
  if (me.processor) return bad('The processor cannot change chart boxes', 403);
  const n = k => Number(b[k]);
  const [x, y, w, h] = ['x', 'y', 'w', 'h'].map(n);
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < 0.01 || h < 0.01 || x + w > 1.0001 || y + h > 1.0001) return bad('A box needs x, y, w, h as fractions of the page (0 to 1), at least 0.01 wide and high, inside the page');
  const row = await env.DB.prepare('SELECT 1 FROM ali_index WHERE edition=? AND chart=? AND pdf_page=? LIMIT 1').bind(String(b.edition || ''), String(b.chart || ''), parseInt(b.pdf_page, 10)).first();
  if (!row) return bad('No such chart on that page in that edition', 404);
  await env.DB.prepare(`INSERT INTO ali_chart_boxes(edition, chart, pdf_page, x, y, w, h, set_at, set_by) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(edition, chart) DO UPDATE SET pdf_page=excluded.pdf_page, x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, set_at=excluded.set_at, set_by=excluded.set_by`)
    .bind(String(b.edition), String(b.chart), parseInt(b.pdf_page, 10), x, y, w, h, me.now, me.device).run();
  return json({ ok: true, box: { x, y, w, h } });
}

// ---------- Tabs, fields, values ----------
async function tabsFields(env) {
  const tabs = (await env.DB.prepare('SELECT id, name, label, sort FROM tabs ORDER BY sort, id').all()).results;
  const fields = (await env.DB.prepare('SELECT f.id, f.tab_id, t.name tab, f.name, f.unit, f.sort, f.is_safety FROM fields f JOIN tabs t ON t.id = f.tab_id ORDER BY t.sort, f.sort, f.id').all()).results;
  return { tabs, fields };
}
const VAL_SELECT = `SELECT x.id, x.field_id, f.name field, t.name tab, f.is_safety, x.scope, x.make, x.model, x.year_from, x.year_to, x.vehicle_id,
  x.value, x.confidence, x.source, x.note, x.warn, x.status, x.entered_at, x.entered_by, x.confirmed_at, x.confirmed_by, x.updated_at,
  x.ftlb_lo, x.ftlb_hi, x.ftlb_src, x.engine
  FROM vals x JOIN fields f ON f.id = x.field_id JOIN tabs t ON t.id = f.tab_id`;
// The values of car v (alias): its own overrides and the model-year values for its year.
const CAR_VALS = `((x.scope='car' AND x.vehicle_id=v.id) OR (x.scope='model' AND x.make=v.make AND x.model=v.model AND x.year_from<=v.year AND x.year_to>=v.year))`;
// Display order: car override, then model-year value; confirmed before proposed; rejected hidden.
async function carValues(env, v, withRejected) {
  const { results } = await env.DB.prepare(`${VAL_SELECT} WHERE ((x.scope='car' AND x.vehicle_id=?) OR (x.scope='model' AND x.make=? AND x.model=? AND x.year_from<=? AND x.year_to>=?))
    ${withRejected ? '' : "AND x.status<>'rejected'"} ORDER BY t.sort, f.sort, f.id, (x.scope='car') DESC, (x.status='confirmed') DESC, x.id`).bind(v.id, v.make, v.model, v.year, v.year).all();
  return results;
}
// ---------- Typical values and thread ranges (Handoff 3 decision 9) ----------
// Display order: car override, model-year value, then the make's typical value (Low), then the
// thread's usual torque range as a sanity check only. A torque outside the range is flagged.
const THREAD = /M\d+\s*x\s*\d+(?:\.\d+)?|\d+\/\d+-\d+/i;
async function typical(env, make, year, vals) {
  const md = await env.DB.prepare(`SELECT edition, make, era, thread, socket, torque_ftlb, confidence, source, note FROM make_defaults
    WHERE make=? AND (year_from IS NULL OR year_from<=?) AND (year_to IS NULL OR year_to>=?) ORDER BY edition DESC, id LIMIT 1`).bind(make, year, year).first();
  // The thread: the car's own Thread value when there is one, else the make's typical thread.
  const own = (vals || []).find(x => x.tab === 'torque' && x.field === 'Thread' && x.status !== 'rejected' && THREAD.test(x.value));
  const thread = own ? own.value.match(THREAD)[0].replace(/\s/g, '') : (md && md.thread);
  const range = thread ? await env.DB.prepare('SELECT edition, thread, sockets, torque_min, torque_max, confidence, source, note FROM thread_ranges WHERE thread=? ORDER BY edition DESC, id LIMIT 1').bind(thread).first() : null;
  return { make: md || null, range: range || null, thread_from: own ? 'car' : md ? 'make' : null };
}
const rangeFlag = (x, range) => {
  if (!range || range.torque_min == null || x.tab !== 'torque' || x.field !== 'Torque') return null;
  // HANDOFF 15: the range check reads the stored ft-lb numbers (migration 0009), not the value text.
  const lo = x.ftlb_lo, hi = x.ftlb_hi == null ? x.ftlb_lo : x.ftlb_hi; if (lo == null) return null;
  return lo < range.torque_min - 0.5 || hi > range.torque_max + 0.5 ? 'outside' : 'inside';
};
// Ultrareview 2 #3: the door-jamb screen saves the source as "Door-jamb label photo, <date>" (app.js jambRead): a hyphen is allowed.
const PLACARD = /placard|door[\s-]*(?:card|label|jamb|pillar)/i;
// Ultrareview F9: the door card wins per field. The field ids that have a confirmed car-scope tire value from a placard.
const placardFields = vals => new Set(vals.filter(x => x.tab === 'tires' && x.scope === 'car' && x.status === 'confirmed' && PLACARD.test(x.source || '')).map(x => x.field_id));
const hidden = (v, nowMs) => v.grp === 'visitor' && (nowMs - Date.parse(v.last_seen || v.created_iso || 0)) > HIDE_DAYS * 864e5;
async function vehicleRow(env, id) {
  return env.DB.prepare("SELECT *, strftime('%Y-%m-%dT%H:%M:%fZ', created) created_iso FROM vehicles WHERE id=?").bind(id).first();
}
// HANDOFF 12: the adapter notes of one chart, read only (rows come from the import). null = no row for the chart.
// HANDOFF 13: the label "Checked by Rick" comes from chart_checks (append-only), not from the CSV level. It holds only while the
// latest row for the chart is a check AND its hash equals the hash of the text now. Else the level is chart_notes.verified (no or ai).
// A database before migration 0008 has no chart_checks table: the level is the column.
async function textHash(n) {
  const s = [n.adapters, n.height_note, n.cautions, n.kit_mark].map(x => x == null ? '' : String(x)).join('\u001f');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function latestCheck(env, edition, chart) {
  try { return await env.DB.prepare('SELECT action, text_hash, who, at FROM chart_checks WHERE edition = ? AND chart = ? ORDER BY id DESC LIMIT 1').bind(edition, chart).first() || null; }
  catch (e) { return null; }
}
async function chartNotes(env, edition, chart) {
  const n = await env.DB.prepare('SELECT edition, chart, adapters, height_note, cautions, kit_mark, verified FROM chart_notes WHERE edition = ? AND chart = ?').bind(edition, chart).first();
  if (!n) return null;
  n.verified = n.verified === 'ai' ? 'ai' : 'no';
  n.verified_by = null; n.verified_at = null;
  if (edition === 'all') return n;   // the fixed line under every block is never checked
  const k = await latestCheck(env, edition, chart);
  if (k && k.action === 'check' && k.text_hash === await textHash(n)) { n.verified = 'rick'; n.verified_by = k.who; n.verified_at = k.at; }
  return n;
}
// action: check / undo add one row to chart_checks (nothing is changed or deleted). The self-test tool may also use
// selftest_edit (change the text of its temp chart) and cleanup (remove its temp edition 'selftest' only).
async function chartCheck(env, b, me) {
  const edition = String(b.edition || ''), chart = String(b.chart || ''), action = String(b.action || '');
  if (!edition || !chart || !['check', 'undo', 'cleanup', 'selftest_edit'].includes(action)) return bad('Need edition, chart and action check or undo');
  const temp = edition === 'selftest';
  const rick = !!me.email && !me.token;
  if (me.processor || !(rick || (me.tool && temp))) return bad('Only Rick can mark a chart as checked', 403);
  if (action === 'cleanup' || action === 'selftest_edit') {
    if (!temp || !me.tool) return bad('This action is for the self-test tool on the self-test edition only', 403);
    if (action === 'cleanup') {
      await env.DB.batch([env.DB.prepare('DELETE FROM chart_notes WHERE edition = ?').bind(edition), env.DB.prepare('DELETE FROM chart_checks WHERE edition = ?').bind(edition)]);
      return json({ ok: true });
    }
    await env.DB.prepare('UPDATE chart_notes SET adapters = ? WHERE edition = ? AND chart = ?').bind(String(b.adapters || '').slice(0, 200), edition, chart).run();
    return json({ ok: true, chart_notes: await chartNotes(env, edition, chart) });
  }
  if (temp) await env.DB.prepare("INSERT OR IGNORE INTO chart_notes(edition, chart, adapters, verified) VALUES(?, ?, 'selftest', 'no')").bind(edition, chart).run();
  const raw = await env.DB.prepare('SELECT edition, chart, adapters, height_note, cautions, kit_mark FROM chart_notes WHERE edition = ? AND chart = ?').bind(edition, chart).first();
  if (!raw) return bad('No adapter notes for this chart', 404);
  const now = await chartNotes(env, edition, chart), isRick = now.verified === 'rick';
  if (action === 'check' && isRick) return json({ ok: true, changed: false, chart_notes: now });
  if (action === 'undo' && !isRick) return bad('This chart is not checked by Rick now, so Undo does not apply', 409);
  await env.DB.prepare('INSERT INTO chart_checks(edition, chart, text_hash, action, who, at) VALUES(?,?,?,?,?,?)').bind(edition, chart, await textHash(raw), action, me.email || me.device, me.now).run();
  const history = (await env.DB.prepare('SELECT action, who, at FROM chart_checks WHERE edition = ? AND chart = ? ORDER BY id').bind(edition, chart).all()).results;
  return json({ ok: true, changed: true, chart_notes: await chartNotes(env, edition, chart), history });
}
async function vehicle(env, id, me, touch) {
  const v = await vehicleRow(env, id);
  if (!v) return null;
  if (touch) { await env.DB.prepare('UPDATE vehicles SET last_seen=? WHERE id=?').bind(me.now, id).run(); v.last_seen = me.now; }
  v.values = await carValues(env, v, false);
  v.typical = await typical(env, v.make, v.year, v.values);
  // HANDOFF 15, "the door card wins": a confirmed car-scope tire value from a placard hides the model-scope values of the SAME field
  // (ultrareview F9; they stay in the database and in history; the flag lets the app and the tests see them).
  const placard = placardFields(v.values);
  v.values.forEach(x => { x.range_flag = rangeFlag(x, v.typical.range); x.hidden_by_placard = x.tab === 'tires' && x.scope === 'model' && placard.has(x.field_id); });
  v.ali = await nearestChart(env, v.make, v.model, v.year);
  v.chart_notes = v.ali ? await chartNotes(env, v.ali.edition, v.ali.chart) : null;
  // HANDOFF 15: the per-car switch hides the chart's caution text (the car's own caution stays; the chart image still shows it).
  if (v.chart_notes && v.hide_chart_cautions) v.chart_notes = { ...v.chart_notes, cautions: null, cautions_hidden: true };
  // The fixed line under every adapter block (the lift's own numbers are data: edition all, chart footer).
  v.chart_notes_footer = v.ali ? ((await chartNotes(env, 'all', 'footer')) || {}).adapters || null : null;
  v.jobs = (await env.DB.prepare("SELECT id, kind, status, result_summary, error, created_at, updated_at FROM jobs WHERE target IN (?, ?) ORDER BY id DESC LIMIT 5")
    .bind('car:' + id, modelKey(v)).all()).results;
  v.hidden = hidden(v, me.nowMs); v.mine = v.grp === 'mine' ? 1 : 0;
  return v;
}
// Decision 11 + HANDOFF 15 (ultrareview F6): a car sent to the processor never holds the VIN, the notes, the owner or the ALI-derived
// adapter notes. Every route that returns a car object passes it through here; the keys are removed, not blanked.
const PRIVATE_CAR_KEYS = ['vin', 'notes', 'owner', 'chart_notes', 'chart_notes_footer'];
const forMe = (v, me) => { if (v && me.processor) PRIVATE_CAR_KEYS.forEach(k => { delete v[k]; }); return v; };
const TRIM_MAX = 60;
const modelKey = v => `model:${v.make}|${v.model}|${v.year}`;
async function fieldByName(env, tab, name) {
  return env.DB.prepare('SELECT f.id, f.is_safety FROM fields f JOIN tabs t ON t.id = f.tab_id WHERE t.name=? AND f.name=?').bind(tab, name).first();
}
// A new value's id is above every id in vals AND in history, so the id of a deleted value is never
// given again (a reused id would show the old value's history). Also used by tools/import.py.
const NEW_VAL_ID = `(SELECT MAX(m) + 1 FROM (SELECT COALESCE(MAX(id), 0) AS m FROM vals UNION ALL SELECT COALESCE(MAX(value_id), 0) FROM history))`;
// Insert one value and its history row in one batch. last_insert_rowid() is the new value's id.
function insertValueStmts(env, x, me) {
  return [
    env.DB.prepare(`INSERT INTO vals(id, field_id, scope, make, model, year_from, year_to, vehicle_id, value, confidence, source, note, warn, status,
      entered_at, entered_by, confirmed_at, confirmed_by, updated_at, ftlb_lo, ftlb_hi, ftlb_src, engine) VALUES(${NEW_VAL_ID},?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(x.field_id, x.scope, x.make ?? null, x.model ?? null, x.year_from ?? null, x.year_to ?? null, x.vehicle_id ?? null, x.value, x.confidence,
        x.source || '', x.note || '', x.warn || 0, x.status, me.now, me.device, x.status === 'confirmed' ? me.now : null, x.status === 'confirmed' ? me.device : null, me.now,
        x.ftlb_lo ?? null, x.ftlb_hi ?? null, x.ftlb_src ?? null, x.engine ?? null),
    env.DB.prepare(`INSERT INTO history(value_id, action, new_value, new_status, new_confidence, new_ftlb_lo, new_ftlb_hi, new_ftlb_src, new_warn, new_source, new_note, at, device)
      VALUES(last_insert_rowid(), 'insert', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(x.value, x.status, x.confidence, x.ftlb_lo ?? null, x.ftlb_hi ?? null, x.ftlb_src ?? null, x.warn || 0, x.source || '', x.note || '', me.now, me.device)];
}
// HANDOFF 15: the Torque field stores the numbers to show (ft-lb only on screen). A post for it without ftlb_lo is refused (400), for the
// browser and for the research worker. ftlb_src: 'printed' = the source prints ft-lb; 'converted' = worked out from N-m.
const isTorque = (tab, name) => tab === 'torque' && name === 'Torque';
function ftlbOf(b) {
  const num = k => b[k] === undefined || b[k] === null || b[k] === '' ? null : Number(b[k]);
  const lo = num('ftlb_lo'), hi = num('ftlb_hi'), src = b.ftlb_src === undefined || b.ftlb_src === null || b.ftlb_src === '' ? 'printed' : b.ftlb_src;
  if (lo === null) return { err: 'A Torque value needs ftlb_lo (whole ft-lb)' };
  if (!Number.isInteger(lo) || lo < 1 || lo > 1000 || (hi !== null && (!Number.isInteger(hi) || hi < lo || hi > 1000))) return { err: 'ftlb_lo and ftlb_hi must be whole ft-lb numbers, from 1 to 1000, ftlb_hi not below ftlb_lo' };
  if (!['printed', 'converted'].includes(src)) return { err: 'ftlb_src must be printed or converted' };
  return { ftlb_lo: lo, ftlb_hi: hi, ftlb_src: src };
}
// Ultrareview F3: a research result for Torque without ftlb_lo (the research worker before HANDOFF 15, or a hand-written queue.sh result)
// gets its numbers from the value text: an ft-lb figure first, else an N-m figure converted. The unit of the source is not known then,
// so the value is always marked 'converted' (the app shows the tag; Rick checks it when he confirms). No number = no numbers (400 as before).
const NM_TO_FTLB = 0.737562;
function ftlbFromText(text) {
  const t = String(text || '').toLowerCase();
  let m = t.match(/(?<![\d.])(\d+)\s*(?:-|–|to)\s*(\d+)(?![\d.])\s*(?:ft[ -]?lbs?|lb[ -]?ft)/);
  if (m) return { ftlb_lo: +m[1], ftlb_hi: +m[2] };
  m = t.match(/(?<![\d.])(\d+)(?![\d.])\s*(?:ft[ -]?lbs?|lb[ -]?ft)/);
  if (m) return { ftlb_lo: +m[1] };
  m = t.match(/(?<![\d.])(\d+)\s*(?:-|–|to)\s*(\d+)(?![\d.])\s*n[·.\s-]?m\b/);
  if (m) return { ftlb_lo: Math.round(m[1] * NM_TO_FTLB), ftlb_hi: Math.round(m[2] * NM_TO_FTLB) };
  m = t.match(/(?<![\d.])(\d+)(?![\d.])\s*n[·.\s-]?m\b/);
  if (m) return { ftlb_lo: Math.round(m[1] * NM_TO_FTLB) };
  return {};
}
async function addValue(env, v, b, me) {
  const tab = String(b.tab || ''), name = String(b.field || '').trim();
  if (!name || !String(b.value || '').trim() || !CONF.includes(b.confidence)) return bad('Need tab, field, value and confidence (High, Medium or Low)');
  const f = await fieldByName(env, tab, name);
  if (!f) return bad(`Unknown field "${name}" on tab "${tab}"`);
  const warn = level(b.warn);
  if (warn === null) return bad(LEVEL_ERR);
  if (warn && me.processor) return bad('The processor cannot set a warning level', 403);
  const tq = isTorque(tab, name) ? ftlbOf(b) : {};
  if (tq.err) return bad(tq.err);
  const scope = b.scope === 'car' ? 'car' : 'model';
  const yf = scope === 'model' ? parseInt(b.year_from ?? v.year, 10) : null, yt = scope === 'model' ? parseInt(b.year_to ?? v.year, 10) : null;
  if (scope === 'model' && (!yearOk(yf) || !yearOk(yt) || yf > yt)) return bad('Year range is not valid');
  // A browser entry by Rick is confirmed only when he asks for it; the processor can only propose.
  const status = !me.processor && b.status === 'confirmed' ? 'confirmed' : 'proposed';
  await env.DB.batch(insertValueStmts(env, { field_id: f.id, scope, make: scope === 'model' ? v.make : null, model: scope === 'model' ? v.model : null,
    year_from: yf, year_to: yt, vehicle_id: scope === 'car' ? v.id : null, value: String(b.value).trim(), confidence: b.confidence,
    source: b.source, note: b.note, warn, status, ...tq }, me));
  return null;
}
// Change a value and write its history row in the same batch. The history row copies the old
// state from the row itself, so it can never describe a state the row did not have.
async function changeValue(env, id, action, set, me) {
  const old = await env.DB.prepare('SELECT * FROM vals WHERE id=?').bind(id).first();
  if (!old) return bad('Value not found', 404);
  if (action === 'delete') {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO history(value_id, action, old_value, old_status, old_confidence, old_ftlb_lo, old_ftlb_hi, old_ftlb_src, old_warn, old_source, old_note, at, device)
        SELECT id, 'delete', value, status, confidence, ftlb_lo, ftlb_hi, ftlb_src, warn, source, note, ?, ? FROM vals WHERE id=?`).bind(me.now, me.device, id),
      env.DB.prepare('DELETE FROM vals WHERE id=?').bind(id)]);
    return json({ ok: true });
  }
  const keys = Object.keys(set);
  // Ultrareview F10 (migration 0010): the row also keeps the old and new torque numbers, so a change of only the ft-lb boxes is auditable.
  const nw = k => k in set ? set[k] : old[k] ?? null;
  await env.DB.batch([
    // Ultrareview 2 #8 (migration 0011): also the warning level, the source and the note, old and new.
    env.DB.prepare(`INSERT INTO history(value_id, action, old_value, new_value, old_status, new_status, old_confidence, new_confidence,
      old_ftlb_lo, new_ftlb_lo, old_ftlb_hi, new_ftlb_hi, old_ftlb_src, new_ftlb_src, old_warn, new_warn, old_source, new_source, old_note, new_note, at, device)
      SELECT id, ?, value, ?, status, ?, confidence, ?, ftlb_lo, ?, ftlb_hi, ?, ftlb_src, ?, warn, ?, source, ?, note, ?, ?, ? FROM vals WHERE id=?`)
      .bind(action, set.value ?? old.value, set.status ?? old.status, set.confidence ?? old.confidence, nw('ftlb_lo'), nw('ftlb_hi'), nw('ftlb_src'),
        nw('warn'), nw('source'), nw('note'), me.now, me.device, id),
    env.DB.prepare(`UPDATE vals SET ${keys.map(k => k + '=?').join(', ')}, updated_at=? WHERE id=?`).bind(...keys.map(k => set[k]), me.now, id)]);
  return json({ ok: true });
}

// ---------- Jobs (research queue, processor-agnostic) ----------
async function missingFields(env, v) {
  const { fields } = await tabsFields(env);
  const vals = await carValues(env, v, false);
  const have = new Set(vals.map(x => x.field_id));
  // HANDOFF 15: no research for a tire field that has a confirmed door-card value (per field, ultrareview F9); no oil research for an electric car.
  const placard = placardFields(vals), ev = v.fuel === 'ev';
  return fields.filter(f => !have.has(f.id) && !placard.has(f.id) && !(ev && f.tab === 'oil')).map(f => ({ tab: f.tab, field: f.name }));
}
// The request holds only make, model, year, trim and field names. Never a VIN, a name, notes or photos.
async function queueJob(env, v, kind, wanted, me) {
  const req = { make: v.make, model: v.model, year: v.year, trim: v.trim || '', fields: wanted };
  const r = await env.DB.prepare('INSERT INTO jobs(kind, target, request, status, created_at, updated_at) VALUES(?,?,?,?,?,?) RETURNING id')
    .bind(kind, modelKey(v), JSON.stringify(req), 'queued', me.now, me.now).first();
  return r.id;
}
// HANDOFF 13: a car that Rick adds, or whose trim he changes, gets a research job by itself for its missing fields. Not for the
// self-test token (its test cars would cost real research), and not when a job for the car or model is still open (no duplicate).
// The switch is the Worker variable LP_AUTO_RESEARCH ("1" = on). Default OFF (Rick, 2026-10-24): it is turned on only after the first
// live run of the research worker on the 2022 Sonata has passed (see the release plan).
async function openJob(env, v) {
  return await env.DB.prepare("SELECT id FROM jobs WHERE target IN (?, ?) AND status IN ('queued','claimed') LIMIT 1").bind('car:' + v.id, modelKey(v)).first();
}
async function autoResearch(env, v, me) {
  if (env.LP_AUTO_RESEARCH !== '1' || me.tool || me.processor || await openJob(env, v)) return null;
  const miss = await missingFields(env, v);
  return miss.length ? await queueJob(env, v, 'research', miss, me) : null;
}
async function claimJob(env, me, onlyId) {
  const until = new Date(me.nowMs + LEASE_MIN * 60e3).toISOString();
  const r = await env.DB.prepare(`UPDATE jobs SET status='claimed', claimed_by=?, lease_until=?, attempts=attempts+1, updated_at=?
    WHERE id = (SELECT id FROM jobs WHERE (status='queued' OR (status='claimed' AND lease_until < ?)) ${onlyId ? 'AND id=?' : ''} ORDER BY created_at, id LIMIT 1)
    RETURNING id, kind, target, request, attempts, lease_until`).bind(...[me.token, until, me.now, me.now, ...(onlyId ? [onlyId] : [])]).first();
  if (!r) return null;
  r.request = JSON.parse(r.request);
  return r;
}
async function jobResult(env, id, b, me) {
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!j) return bad('Job not found', 404);
  if (j.status !== 'claimed' || j.claimed_by !== me.token || !(j.lease_until > me.now)) return bad('This job is not claimed by you, or the lease ran out. Claim it again.', 409);
  const rq = JSON.parse(j.request), vals = Array.isArray(b.values) ? b.values : null;
  if (!vals) return bad('Need values: a list of {tab, field, value, confidence, source}');
  const stmts = []; let skipped = 0;
  for (const x of vals) {
    if (!x || !String(x.value || '').trim() || !CONF.includes(x.confidence) || !String(x.source || '').trim()) return bad('Each value needs field, value, confidence and source');
    const f = await fieldByName(env, String(x.tab || ''), String(x.field || ''));
    if (!f) return bad(`Unknown field "${x.field}" on tab "${x.tab}"`);
    // HANDOFF 13 (Rick, review finding b): the server does not trust the processor's confidence on a safety field. High needs a source
    // that cites a page ("p.7-16", "p. 12", "PDF p.25"). Without it the whole result is refused and the job stays claimed.
    if (f.is_safety && x.confidence === 'High' && !/\bp\.\s*\d/i.test(String(x.source))) return bad(`High on the safety field "${x.field}" needs a source that cites a page (p.)`);
    const noNums = x.ftlb_lo === undefined || x.ftlb_lo === null || x.ftlb_lo === '';
    const tq = isTorque(String(x.tab), String(x.field)) ? ftlbOf(noNums ? { ...ftlbFromText(x.value), ftlb_src: 'converted' } : x) : {};
    if (tq.err) return bad(tq.err);
    // HANDOFF 15 (REVIEW problem 1): a field that already has a confirmed value for this make, model and year is skipped, not posted again.
    if (await env.DB.prepare("SELECT 1 FROM vals WHERE field_id=? AND scope='model' AND make=? AND model=? AND year_from<=? AND year_to>=? AND status='confirmed' LIMIT 1").bind(f.id, rq.make, rq.model, rq.year, rq.year).first()) { skipped++; continue; }
    stmts.push(...insertValueStmts(env, { field_id: f.id, scope: 'model', make: rq.make, model: rq.model, year_from: rq.year, year_to: rq.year,
      value: String(x.value).trim(), confidence: x.confidence, source: x.source, note: x.note, status: 'proposed', ...tq }, me));
  }
  stmts.push(env.DB.prepare("UPDATE jobs SET status='done', result_summary=?, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed' AND claimed_by=?")
    .bind(`${vals.length - skipped} proposed value(s)${skipped ? `, ${skipped} skipped (already confirmed)` : ''}`, me.now, id, me.token));
  await env.DB.batch(stmts);
  return json({ ok: true, proposed: vals.length - skipped, skipped });
}

// ---------- Service log (HANDOFF 15) ----------
// A visit = one row in service_entries (date, mileage) with its items in service_entry_items. The items a car offers come from the
// table service_items filtered by the car's fuel. Edit and delete are Rick only; a delete is soft (deleted_at). Every create, edit and
// delete adds a service_log_history row. The processor (research worker) has no access, except the CSV route for the nightly export.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = s => { if (!DATE_RE.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const MILES_MAX = 2000000;
// withInactive: also the items that are switched off (active=0); used for a visit's own items (ultrareview F5).
async function serviceItems(env, fuel, withInactive) {
  const { results } = await env.DB.prepare(`SELECT id, name, options_json, applies_fuels, sort FROM service_items ${withInactive ? '' : 'WHERE active=1'} ORDER BY sort, id`).all();
  return results.filter(r => !fuel || list(r.applies_fuels).includes(fuel))
    .map(r => { const o = r.options_json ? JSON.parse(r.options_json) : {}; return { id: r.id, name: r.name, choices: o.choices || null, text: !!o.text }; });
}
// Entries with their items, newest first (date, then mileage, then id). where: extra SQL on alias e; binds go with it.
async function serviceEntries(env, where, binds) {
  const w = `e.deleted_at IS NULL${where ? ' AND ' + where : ''}`;
  const es = (await env.DB.prepare(`SELECT e.id, e.vehicle_id, e.date, e.mileage, e.created_at, e.created_by, v.year, v.make, v.model, v.owner
    FROM service_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE ${w} ORDER BY e.date DESC, e.mileage DESC, e.id DESC`).bind(...binds).all()).results;
  const its = (await env.DB.prepare(`SELECT i.entry_id, i.item_id, s.name, i.option, i.other_text FROM service_entry_items i JOIN service_items s ON s.id = i.item_id
    JOIN service_entries e ON e.id = i.entry_id JOIN vehicles v ON v.id = e.vehicle_id WHERE ${w} ORDER BY i.id`).bind(...binds).all()).results;
  const by = new Map(es.map(e => [e.id, { ...e, items: [] }]));
  its.forEach(i => by.get(i.entry_id).items.push({ item_id: i.item_id, name: i.name, option: i.option, other_text: i.other_text }));
  return [...by.values()];
}
// Check a visit's input. Returns { err, status } or { date, mileage, items }. The mileage-order check is skipped with force.
// keep: the item ids the visit already has (an edit). They stay valid when the car's fuel or the item list changed since; only an item
// that is added must apply to the car now (ultrareview F5).
async function checkVisit(env, v, b, excludeId, me, keep) {
  const date = String(b.date || me.now.slice(0, 10)), mileage = Number(b.mileage);
  if (!validDate(date)) return { err: 'The date must be YYYY-MM-DD', status: 400 };
  if (date > me.now.slice(0, 10)) return { err: 'The date cannot be in the future', status: 400 };
  if (b.mileage === undefined || b.mileage === null || b.mileage === '' || !Number.isInteger(mileage) || mileage < 0 || mileage > MILES_MAX) return { err: `The mileage must be a whole number from 0 to ${MILES_MAX}`, status: 400 };
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 20) return { err: 'Need 1 to 20 items', status: 400 };
  const avail = new Map((await serviceItems(env, v.fuel)).map(i => [i.id, i])), seen = new Set(), items = [];
  if (keep && keep.size) for (const i of await serviceItems(env, null, true)) if (keep.has(i.id) && !avail.has(i.id)) avail.set(i.id, i);
  for (const x of b.items) {
    const id = Number(x && x.item_id), it = avail.get(id);
    if (!it) return { err: `Item ${x && x.item_id} does not apply to this car`, status: 400 };
    if (seen.has(id)) return { err: `${it.name} is in the visit twice`, status: 400 };
    seen.add(id);
    let option = '', other = '';
    if (it.choices) { option = String(x.option || ''); if (!it.choices.includes(option)) return { err: `${it.name} needs one option: ${it.choices.join(', ')}`, status: 400 }; }
    if (it.text) { other = String(x.other_text || '').trim(); if (!other || other.length > 120 || /[\u0000-\u001f]/.test(other)) return { err: 'Other needs one typed line of 1 to 120 characters', status: 400 }; }
    items.push({ item_id: id, name: it.name, option, other_text: other });
  }
  if (!(b.force === 1 || b.force === '1' || b.force === true)) {
    const ex = excludeId || 0;
    const before = await env.DB.prepare('SELECT date, mileage FROM service_entries WHERE vehicle_id=? AND deleted_at IS NULL AND id<>? AND date<? ORDER BY date DESC, mileage DESC, id DESC LIMIT 1').bind(v.id, ex, date).first();
    const after = await env.DB.prepare('SELECT date, mileage FROM service_entries WHERE vehicle_id=? AND deleted_at IS NULL AND id<>? AND date>? ORDER BY date, mileage, id LIMIT 1').bind(v.id, ex, date).first();
    const lower = await env.DB.prepare('SELECT 1 x FROM service_entries WHERE vehicle_id=? AND deleted_at IS NULL AND id<>? AND date<? AND mileage>? LIMIT 1').bind(v.id, ex, date, mileage).first();
    const higher = await env.DB.prepare('SELECT 1 x FROM service_entries WHERE vehicle_id=? AND deleted_at IS NULL AND id<>? AND date>? AND mileage<? LIMIT 1').bind(v.id, ex, date, mileage).first();
    if (lower || higher) return { conflict: { error: 'This mileage does not fit the visits before and after this date', confirm_needed: true, before: before || null, after: after || null }, status: 409 };
  }
  return { date, mileage, items };
}
const entryJson = (id, vehicle_id, d) => JSON.stringify({ id, vehicle_id, date: d.date, mileage: d.mileage, items: d.items.map(({ item_id, name, option, other_text }) => ({ item_id, name, option, other_text })) });
const itemStmts = (env, id, items) => items.map(i => env.DB.prepare('INSERT INTO service_entry_items(entry_id, item_id, option, other_text) VALUES(?,?,?,?)').bind(id, i.item_id, i.option, i.other_text));
async function addVisit(env, v, b, me) {
  const d = await checkVisit(env, v, b, 0, me);
  if (d.err) return bad(d.err, d.status);
  if (d.conflict) return json(d.conflict, 409);
  const id = ((await env.DB.prepare('SELECT COALESCE(MAX(id), 0) + 1 n FROM (SELECT id FROM service_entries UNION ALL SELECT entry_id FROM service_log_history)').first()).n);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO service_entries(id, vehicle_id, date, mileage, created_at, created_by) VALUES(?,?,?,?,?,?)').bind(id, v.id, d.date, d.mileage, me.now, me.device),
    ...itemStmts(env, id, d.items),
    env.DB.prepare("INSERT INTO service_log_history(entry_id, action, before_json, after_json, at, who) VALUES(?, 'insert', NULL, ?, ?, ?)").bind(id, entryJson(id, v.id, d), me.now, me.device)]);
  return json({ ok: true, id, date: d.date, mileage: d.mileage, items: d.items }, 201);
}
async function changeVisit(env, id, method, b, me) {
  if (me.processor) return bad('Only Rick can change or delete a visit', 403);
  const cur = (await serviceEntries(env, 'e.id=?', [id]))[0];
  if (!cur) return bad('Visit not found', 404);
  const before = entryJson(id, cur.vehicle_id, cur);
  if (method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('UPDATE service_entries SET deleted_at=? WHERE id=?').bind(me.now, id),
      env.DB.prepare("INSERT INTO service_log_history(entry_id, action, before_json, after_json, at, who) VALUES(?, 'delete', ?, NULL, ?, ?)").bind(id, before, me.now, me.device)]);
    return json({ ok: true });
  }
  const v = await vehicleRow(env, cur.vehicle_id);
  const d = await checkVisit(env, v, { date: cur.date, mileage: cur.mileage, items: cur.items, ...b }, id, me, new Set(cur.items.map(i => i.item_id)));
  if (d.err) return bad(d.err, d.status);
  if (d.conflict) return json(d.conflict, 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE service_entries SET date=?, mileage=? WHERE id=?').bind(d.date, d.mileage, id),
    env.DB.prepare('DELETE FROM service_entry_items WHERE entry_id=?').bind(id),
    ...itemStmts(env, id, d.items),
    env.DB.prepare("INSERT INTO service_log_history(entry_id, action, before_json, after_json, at, who) VALUES(?, 'update', ?, ?, ?, ?)").bind(id, before, entryJson(id, v.id, d), me.now, me.device)]);
  return json({ ok: true, id, date: d.date, mileage: d.mileage, items: d.items });
}
// CSV: one line per item. A cell that starts with = + - @ gets a leading apostrophe so a spreadsheet does not run it as a formula.
const csvCell = s => { let t = String(s ?? ''); if (/^[=+\-@]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
async function serviceCsv(env, carId, format, me) {
  const v = await vehicleRow(env, carId); if (!v) return bad('Car not found', 404);
  const es = (await serviceEntries(env, 'e.vehicle_id=?', [carId])).reverse();
  const car = `${v.year} ${v.make} ${v.model}`;
  let rows;
  if (format === 'lubelogger') {
    // LubeLogger import shape: one line per visit. Cost stays empty (LiftPad does not keep costs).
    rows = [['Date', 'Odometer', 'Description', 'Notes', 'Cost'], ...es.map(e => [e.date, e.mileage,
      e.items.map(i => i.name + (i.option ? ` (${i.option})` : '')).join('; '), e.items.filter(i => i.other_text).map(i => i.other_text).join('; '), ''])];
  } else {
    // The processor never gets the owner's name; its CSV leaves the column empty (the export script fills it from the private owners file).
    rows = [['date', 'mileage', 'item', 'option', 'other_text', 'car', 'owner'], ...es.flatMap(e => e.items.map(i => [e.date, e.mileage, i.name, i.option, i.other_text, car, me.processor ? '' : (v.owner || '')]))];
  }
  return new Response(rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url); const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const me = await who(req, env);
      if (me.badJwt) return bad('The Access token could not be verified', 403);
      if (me.processor &&!PROC_ROUTES.some(([pm, re]) => pm === m && re.test(p))) return bad('Not for the processor', 403);
      // Ultrareview F11 (Rick 2026-10-27, D1 read quota): the 15-minute ping reads only the newest migration id (the primary-key index:
      // about 1 row). The counts (about 3,600 rows read) only with ?full=1 and a tool token, once a day. rows_read is D1's own figure.
      if (p === '/api/health') {
        const full = url.searchParams.get('full') === '1';
        if (full && !me.tool) return bad('The full health check needs a tool service token', 403);
        const r = await env.DB.prepare(full ? "SELECT (SELECT count(*) FROM ali_index) a, (SELECT count(*) FROM classics) c, (SELECT count(*) FROM vehicles) v, (SELECT count(*) FROM makes) m, (SELECT count(*) FROM vals) vals, (SELECT count(*) FROM vals WHERE status='proposed') proposed, (SELECT count(*) FROM jobs WHERE status IN ('queued','claimed')) jobs, (SELECT count(*) FROM ali_pages WHERE status='ok') pages, (SELECT count(*) FROM make_defaults) defaults, (SELECT count(*) FROM thread_ranges) ranges, (SELECT max(id) FROM schema_migrations) schema"
          : 'SELECT max(id) schema FROM schema_migrations').all();
        return json({ ok: true, ...r.results[0], full, rows_read: r.meta && r.meta.rows_read != null ? r.meta.rows_read : null, auto_research: env.LP_AUTO_RESEARCH === '1' ? 1 : 0, build: env.LP_BUILD || null });
      }
      // ALI page images (decision 4): the list from ali_pages, and each image from the private bucket.
      if (p === '/api/ali/pages' && m === 'GET') {
        const ed = url.searchParams.get('edition');
        const { results } = await env.DB.prepare(`SELECT edition, pdf_page, guide_page, status, w, h, bytes FROM ali_pages ${ed ? 'WHERE edition=?' : ''} ORDER BY edition DESC, pdf_page IS NULL, pdf_page, guide_page`).bind(...(ed ? [ed] : [])).all();
        return json(results);
      }
      const pm = p.match(/^\/api\/ali\/([0-9a-z-]{1,20})\/p(\d{3})\.jpg$/);
      if (pm && (m === 'GET' || m === 'HEAD')) {
        if (!env.BUCKET) return bad('Page images are not set up (no R2 binding)', 404);
        const key = pageKey(pm[1], +pm[2]);
        const o = m === 'HEAD' ? await env.BUCKET.head(key) : await env.BUCKET.get(key);
        if (!o) return bad('No image for this page', 404);
        const h = { 'content-type': 'image/jpeg', 'content-length': String(o.size), 'cache-control': 'private, max-age=604800', etag: o.httpEtag };
        return new Response(m === 'HEAD' ? null : o.body, { headers: h });
      }
      // HANDOFF 13: "I checked this chart" and "Undo". Only Rick's own Access login (an email, no service token) may do it.
      // The self-test tool token may do it only on the temp edition 'selftest', which it creates and removes itself.
      if (p === '/api/chart-checks' && m === 'POST') return chartCheck(env, await req.json(), me);
      if (p === '/api/ali/boxes' && m === 'PUT') return setBox(env, await req.json(), me);
      if (p === '/api/ali/boxes' && m === 'DELETE') {
        if (me.processor) return bad('The processor cannot change chart boxes', 403);
        await env.DB.prepare('DELETE FROM ali_chart_boxes WHERE edition=? AND chart=?').bind(url.searchParams.get('edition') || '', url.searchParams.get('chart') || '').run();
        return json({ ok: true });
      }
      if (p.startsWith('/api/ali/')) return bad('Not a page image address. Use /api/ali/<edition>/p<NNN>.jpg', 400);
      if (p === '/api/whoami' && m === 'GET') return json({ email: me.email, token: me.token ? 'service token' : '', processor: me.processor, tool: me.tool, device: me.device, now: me.now });
      if (p === '/api/makes' && m === 'GET') return json(await makes(env, url.searchParams.get('q') || ''));
      if (p === '/api/models' && m === 'GET') {
        const make = url.searchParams.get('make'); const year = parseInt(url.searchParams.get('year'), 10);
        if (!make || !yearOk(year)) return bad('Need make and a 4-digit year');
        return json(await models(env, make, year, url.searchParams.get('q') || '', url.searchParams.get('nhtsa') !== '0'));
      }
      if (p === '/api/vin' && m === 'GET') {
        const vin = (url.searchParams.get('vin') || '').trim().toUpperCase();
        if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return bad('A VIN has 17 letters and digits, with no I, O or Q');
        const r = await fetch(`${env.NHTSA}/DecodeVinValues/${vin}?format=json`, { cf: { cacheTtl: 86400, cacheEverything: true } }); const d = (await r.json()).Results[0];
        // Decision 7: a battery-electric car has no engine oil. A plug-in or other hybrid has an engine, so
        // only BEV, or a sole fuel "Electric", counts.
        const ev = /^BEV/i.test(d.ElectrificationLevel || '') || (/^electric$/i.test((d.FuelTypePrimary || '').trim()) && !d.FuelTypeSecondary);
        const engine = [d.DisplacementL && `${(+d.DisplacementL).toFixed(1)}L`, d.EngineCylinders && `${d.EngineCylinders} cyl`, d.EngineModel].filter(Boolean).join(' ');
        return json({ vin, year: parseInt(d.ModelYear, 10) || null, make: d.Make ? await canonMake(env, d.Make) : '', model: d.Model || '', trim: [d.Trim, d.Series].filter(Boolean).join(' '),
          engine, fuel: d.FuelTypePrimary || '', electrification: d.ElectrificationLevel || '', ev, error: d.ErrorCode !== '0' ? d.ErrorText : '' });
      }
      if (p === '/api/tabs' && m === 'GET') return json(await tabsFields(env));
      // HANDOFF 6: the Apps screen tiles (rows from private-data/apps.csv), read only. Not for the
      // processor: a URL can be a LAN address.
      if (p === '/api/apps' && m === 'GET') {
        if (me.processor) return bad('Apps are not for the processor', 403);
        return json((await env.DB.prepare('SELECT id, name, url, icon, sort FROM apps ORDER BY sort, name, id').all()).results);
      }
      // Decision 8: lookup links for one car (built, never fetched).
      if (p === '/api/links' && m === 'GET') {
        const q = k => url.searchParams.get(k) || '';
        if (!q('make') || !yearOk(parseInt(q('year'), 10))) return bad('Need make and a 4-digit year');
        return json(lookupLinks({ year: q('year'), make: q('make'), model: q('model'), engine: q('engine'), ev: q('ev') === '1' }));
      }
      // HANDOFF 15: service log. The processor has no access, except the CSV route (nightly export; its owner column is empty).
      if (p === '/api/service-log.csv' && m === 'GET') {
        const car = parseInt(url.searchParams.get('car'), 10); if (!car) return bad('Need car=<id>');
        return serviceCsv(env, car, url.searchParams.get('format') === 'lubelogger' ? 'lubelogger' : 'liftpad', me);
      }
      if ((p === '/api/service-items' || p === '/api/service' || /^\/api\/service\/\d+(\/history)?$/.test(p) || /^\/api\/vehicles\/\d+\/service$/.test(p)) && me.processor) return bad('Service log is not for the processor', 403);
      if (p === '/api/service-items' && m === 'GET') {
        const car = parseInt(url.searchParams.get('car'), 10), v = car ? await vehicleRow(env, car) : null;
        return json(await serviceItems(env, v && v.fuel));
      }
      if (p === '/api/service' && m === 'GET') {
        const car = parseInt(url.searchParams.get('car'), 10), owner = url.searchParams.get('owner');
        const w = [], bnd = []; if (car) { w.push('e.vehicle_id=?'); bnd.push(car); } if (owner) { w.push('v.owner=?'); bnd.push(owner); }
        return json(await serviceEntries(env, w.join(' AND '), bnd));
      }
      let sm = p.match(/^\/api\/service\/(\d+)\/history$/);
      if (sm && m === 'GET') return json((await env.DB.prepare('SELECT id, entry_id, action, before_json, after_json, at, who FROM service_log_history WHERE entry_id=? ORDER BY id').bind(+sm[1]).all()).results);
      sm = p.match(/^\/api\/service\/(\d+)$/);
      if (sm && (m === 'PATCH' || m === 'DELETE')) return changeVisit(env, +sm[1], m, m === 'PATCH' ? await req.json() : {}, me);
      sm = p.match(/^\/api\/vehicles\/(\d+)\/service$/);
      if (sm && m === 'GET') {
        const v = await vehicleRow(env, +sm[1]); if (!v) return bad('Car not found', 404);
        const entries = await serviceEntries(env, 'e.vehicle_id=?', [v.id]), last_done = {};
        entries.forEach(e => e.items.forEach(i => { if (!last_done[i.item_id]) last_done[i.item_id] = { date: e.date, mileage: e.mileage }; }));
        // all_items: every item, also switched-off ones, so an edit can show a visit's own items that the car no longer offers (F5)
        return json({ fuel: v.fuel || null, items: await serviceItems(env, v.fuel), all_items: await serviceItems(env, null, true), entries, last_done, last_mileage: entries.length ? entries[0].mileage : null });   // entries are newest first: the latest visit by date, not the highest mileage
      }
      if (sm && m === 'POST') {
        const v = await vehicleRow(env, +sm[1]); if (!v) return bad('Car not found', 404);
        return addVisit(env, v, await req.json(), me);
      }
      if (p === '/api/needs-confirming' && m === 'GET') {
        const { results } = await env.DB.prepare(`${VAL_SELECT} WHERE x.status='proposed' ORDER BY x.make, x.model, x.year_from, t.sort, f.sort, x.id`).all();
        // A proposed torque outside the usual range of the thread is flagged here too (decision 9).
        const seen = new Map();
        for (const x of results) {
          if (x.tab !== 'torque' || x.field !== 'Torque' || x.scope !== 'model') continue;
          const k = `${x.make}|${x.model}|${x.year_from}`;
          if (!seen.has(k)) { const own = (await env.DB.prepare(`${VAL_SELECT} WHERE x.scope='model' AND x.make=? AND x.model=? AND x.year_from<=? AND x.year_to>=? AND t.name='torque'`).bind(x.make, x.model, x.year_from, x.year_from).all()).results;
            seen.set(k, (await typical(env, x.make, x.year_from, own)).range); }
          x.range_flag = rangeFlag(x, seen.get(k)); x.range = seen.get(k);
        }
        // HANDOFF 15 (suggestion 9): a proposal for a field that already has a confirmed value shows that value ("replaces").
        for (const x of results) {
          const c = await env.DB.prepare(`SELECT c.value, c.ftlb_lo, c.ftlb_hi FROM vals c WHERE c.field_id=? AND c.status='confirmed' AND c.id<>? AND (
            (? = 'car' AND c.scope='car' AND c.vehicle_id=?) OR (? = 'model' AND c.scope='model' AND c.make=? AND c.model=? AND c.year_from<=? AND c.year_to>=?)) ORDER BY c.id LIMIT 1`)
            .bind(x.field_id, x.id, x.scope, x.vehicle_id, x.scope, x.make, x.model, x.year_to, x.year_from).first();
          x.replaces = c ? (c.ftlb_lo != null ? `${c.ftlb_lo}${c.ftlb_hi != null ? '-' + c.ftlb_hi : ''} ft-lb` : c.value) : null;
        }
        return json({ count: results.length, values: results });
      }
      if (p === '/api/vehicles' && m === 'GET') {
        // Storyboard T1: each tile has a status line - how many values there are, how many wait for a
        // confirm, and how many block values (warn = 2, an open problem) apply. Home shows only a block;
        // a caution (warn = 1, a standing step such as the air suspension) shows on the Lift tab (HANDOFF 10).
        const all = (await env.DB.prepare(`SELECT v.id, v.year, v.make, v.model, v.trim, v.grp, v.last_seen, v.owner, v.fuel, strftime('%Y-%m-%dT%H:%M:%fZ', v.created) created_iso,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND ${CAR_VALS}) nvals,
          (SELECT count(*) FROM vals x WHERE x.status='proposed' AND ${CAR_VALS}) nproposed,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND x.warn=2 AND ${CAR_VALS}) nblock,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND x.warn=1 AND ${CAR_VALS}) ncaution
          FROM vehicles v ORDER BY CASE v.grp WHEN 'mine' THEN 0 WHEN 'frequent' THEN 1 ELSE 2 END, v.make, v.model, v.year`).all()).results
          .map(v => ({ ...v, hidden: hidden(v, me.nowMs), mine: v.grp === 'mine' ? 1 : 0 }));
        // HANDOFF 15: the owner's name is never sent to the processor (and so never to a model): the key is removed, not blanked.
        if (me.processor) all.forEach(v => forMe(v, me));
        else {   // suggestion 11: the last visit of each car, one line on its Home card
          const seenCar = new Set(), last = new Map();
          for (const e of await serviceEntries(env, '', [])) if (!seenCar.has(e.vehicle_id)) { seenCar.add(e.vehicle_id); last.set(e.vehicle_id, { date: e.date, mileage: e.mileage, items: e.items.map(i => i.name) }); }
          all.forEach(v => { v.last_service = last.get(v.id) || null; });
        }
        return json(url.searchParams.get('hidden') === '1' ? all : all.filter(v => !v.hidden));
      }
      if (p === '/api/vehicles' && m === 'POST') {
        const b = await req.json(); const year = parseInt(b.year, 10);
        if (!b.make || !b.model || !yearOk(year)) return bad('Need year, make and model');
        b.make = await canonMake(env, b.make);   // ultrareview 2 #9
        const grp = GROUPS.includes(b.grp) ? b.grp : (b.mine === true ? 'mine' : 'visitor');
        const r = await env.DB.prepare('INSERT INTO vehicles(year, make, model, trim, vin, mine, grp, last_seen) VALUES(?,?,?,?,?,?,?,?) RETURNING id')
          .bind(year, b.make, b.model, b.trim || '', b.vin || '', grp === 'mine' ? 1 : 0, grp, me.now).first();
        await autoResearch(env, await vehicleRow(env, r.id), me);
        return json(forMe(await vehicle(env, r.id, me, false), me), 201);
      }
      let mm = p.match(/^\/api\/vehicles\/(\d+)$/);
      // Decision 11: the VIN is on the car record only and goes to NHTSA only - never to the processor.
      if (mm && m === 'GET') { const v = forMe(await vehicle(env, +mm[1], me, url.searchParams.get('peek') !== '1'), me); return v ? json(v) : bad('Car not found', 404); }
      if (mm && m === 'PATCH') {
        const b = await req.json(); const v = await vehicleRow(env, +mm[1]);
        if (!v) return bad('Car not found', 404);
        // HANDOFF 15: owner, fuel, engine and the chart-caution switch. Not for the processor. An empty owner, fuel or engine clears it.
        if (['owner', 'fuel', 'engine', 'hide_chart_cautions'].some(k => k in b) && !('grp' in b) && !('vin' in b) && !('trim' in b)) {
          if (me.processor) return bad('The processor cannot change these fields', 403);
          const set = {};
          for (const k of ['owner', 'engine']) if (k in b) {
            const t = String(b[k] ?? '').trim();
            if (t.length > 60 || /[\u0000-\u001f]/.test(t)) return bad(`${k} has at most 60 characters and no control characters`);
            set[k] = t || null;
          }
          if ('fuel' in b) {
            const t = String(b.fuel ?? '').trim();
            if (t && !FUELS.includes(t)) return bad(`Fuel must be one of ${FUELS.join(', ')}`);
            set.fuel = t || null;
          }
          if ('hide_chart_cautions' in b) {
            if (![0, 1, true, false, '0', '1'].includes(b.hide_chart_cautions)) return bad('hide_chart_cautions must be 0 or 1');
            set.hide_chart_cautions = b.hide_chart_cautions === true || b.hide_chart_cautions === 1 || b.hide_chart_cautions === '1' ? 1 : 0;
          }
          const keys = Object.keys(set);
          await env.DB.prepare(`UPDATE vehicles SET ${keys.map(k => k + '=?').join(', ')} WHERE id=?`).bind(...keys.map(k => set[k]), v.id).run();
          return json({ ok: true, ...set });
        }
        // HANDOFF 13: Rick edits the trim. The change is logged as a dated line in vehicles.notes (no new table);
        // the processor never reads that column and never changes the trim.
        if ('trim' in b && !('grp' in b) && !('vin' in b)) {
          if (me.processor) return bad('The processor cannot change a trim', 403);
          const trim = String(b.trim || '').trim();
          if (trim.length > TRIM_MAX || /[\u0000-\u001f]/.test(trim)) return bad(`A trim has at most ${TRIM_MAX} characters and no control characters`);
          if (trim === (v.trim || '')) return json({ ok: true, trim, changed: false });
          const line = `${me.now.slice(0, 10)} trim "${v.trim || ''}" -> "${trim}" (${me.device})`;
          await env.DB.prepare("UPDATE vehicles SET trim=?, notes=CASE WHEN notes IS NULL OR notes='' THEN ? ELSE notes || char(10) || ? END WHERE id=?").bind(trim, line, line, v.id).run();
          const research_job = await autoResearch(env, { ...v, trim }, me);
          return json({ ok: true, trim, changed: true, research_job });
        }
        if ('vin' in b && !('grp' in b)) {
          if (me.processor) return bad('The processor cannot change a VIN', 403);
          const vin = String(b.vin || '').trim().toUpperCase();
          if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return bad('A VIN has 17 letters and digits, with no I, O or Q');
          await env.DB.prepare('UPDATE vehicles SET vin=? WHERE id=?').bind(vin, v.id).run();
          return json({ ok: true, vin });
        }
        if (!GROUPS.includes(b.grp)) return bad('Group must be mine, frequent or visitor');
        await env.DB.prepare('UPDATE vehicles SET grp=?, mine=? WHERE id=?').bind(b.grp, b.grp === 'mine' ? 1 : 0, v.id).run();
        let job = null;
        // Decision 5: marking a car Frequent queues a workup for every missing field.
        if (b.grp === 'frequent' && v.grp !== 'frequent' && !await openJob(env, v)) { const miss = await missingFields(env, v); if (miss.length) job = await queueJob(env, v, 'workup', miss, me); }
        return json({ ok: true, workup_job: job });
      }
      if (mm && m === 'DELETE') {
        // Ultrareview F7: the processor never deletes a car (it would also wipe the car's service log). The allowlist refuses it first.
        if (me.processor) return bad('The processor cannot delete a car', 403);
        // Ultrareview 2 #2: the car's door-jamb photos go first. vehicles.id can be given again to the next car (no AUTOINCREMENT), and that
        // car would list and serve them. Photos first: if the delete below fails, the car stays without photos, never photos without a car.
        if (env.BUCKET) {
          let cursor;
          do {
            const l = await env.BUCKET.list({ prefix: `photos/${+mm[1]}/`, cursor });
            if (l.objects.length) await env.BUCKET.delete(l.objects.map(o => o.key));
            cursor = l.truncated ? l.cursor : undefined;
          } while (cursor);
        }
        // Car overrides go with the car, each with its history row; model-year values stay (other cars use them).
        const ids = (await env.DB.prepare("SELECT id FROM vals WHERE scope='car' AND vehicle_id=?").bind(+mm[1]).all()).results.map(r => r.id);
        for (const id of ids) await changeValue(env, id, 'delete', {}, me);
        // The service log goes with the car, but not silently: one history row per visit says it was deleted with the car.
        await env.DB.batch([env.DB.prepare('DELETE FROM specs WHERE vehicle_id=?').bind(+mm[1]),
          env.DB.prepare("INSERT INTO service_log_history(entry_id, action, before_json, after_json, at, who) SELECT e.id, 'delete', '{\"deleted_with_car\":true}', NULL, ?, ? FROM service_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.vehicle_id=? AND v.trim NOT LIKE 'SELFTEST%'").bind(me.now, me.device, +mm[1]),
          // A self-test car (trim starts with SELFTEST) leaves nothing behind: its visits and their history rows go (Rick 2026-10-27).
          env.DB.prepare("DELETE FROM service_log_history WHERE entry_id IN (SELECT e.id FROM service_entries e JOIN vehicles v ON v.id = e.vehicle_id WHERE e.vehicle_id=? AND v.trim LIKE 'SELFTEST%')").bind(+mm[1]),
          env.DB.prepare('DELETE FROM service_entry_items WHERE entry_id IN (SELECT id FROM service_entries WHERE vehicle_id=?)').bind(+mm[1]),
          env.DB.prepare('DELETE FROM service_entries WHERE vehicle_id=?').bind(+mm[1]),
          env.DB.prepare('DELETE FROM vehicles WHERE id=?').bind(+mm[1])]);
        return json({ ok: true });
      }
      // Decision 10: door-jamb photos in the private bucket, photos/<car>/<time>.jpg. Never sent to any
      // model or job: the processor token can neither store nor read them.
      mm = p.match(/^\/api\/vehicles\/(\d+)\/photos$/);
      if (mm && (m === 'POST' || m === 'GET')) {
        if (me.processor) return bad('Photos are not for the processor', 403);
        if (!env.BUCKET) return bad('Photo storage is not set up (no R2 binding)', 404);
        const v = await vehicleRow(env, +mm[1]); if (!v) return bad('Car not found', 404);
        if (m === 'GET') {
          const l = await env.BUCKET.list({ prefix: `photos/${v.id}/` });
          return json(l.objects.map(o => ({ name: o.key.split('/').pop(), url: '/api/' + o.key, size: o.size, at: o.uploaded })).sort((a, b) => b.name.localeCompare(a.name)));
        }
        const ct = (req.headers.get('content-type') || '').split(';')[0].trim();
        const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[ct];
        if (!ext) return bad('A photo must be JPEG, PNG or WebP');
        const body = await req.arrayBuffer();
        if (!body.byteLength || body.byteLength > PHOTO_MAX) return bad(`A photo must be 1 byte to ${PHOTO_MAX / 1048576} MB`);
        const name = `${me.now.replace(/[:.]/g, '-')}.${ext}`, key = `photos/${v.id}/${name}`;
        await env.BUCKET.put(key, body, { httpMetadata: { contentType: ct } });
        return json({ name, url: '/api/' + key, size: body.byteLength }, 201);
      }
      mm = p.match(/^\/api\/photos\/(\d+)\/([0-9TZ-]+\.(?:jpg|png|webp))$/);
      if (mm && (m === 'GET' || m === 'DELETE')) {
        if (me.processor) return bad('Photos are not for the processor', 403);
        if (!env.BUCKET) return bad('Photo storage is not set up (no R2 binding)', 404);
        const key = `photos/${mm[1]}/${mm[2]}`;
        if (m === 'DELETE') { await env.BUCKET.delete(key); return json({ ok: true }); }
        const o = await env.BUCKET.get(key); if (!o) return bad('No such photo', 404);
        return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', 'content-length': String(o.size), 'cache-control': 'private, max-age=604800' } });
      }
      if (p.startsWith('/api/photos/')) return bad('Not a photo address', 400);
      mm = p.match(/^\/api\/vehicles\/(\d+)\/values$/);
      if (mm && m === 'POST') {
        const v = await vehicleRow(env, +mm[1]); if (!v) return bad('Car not found', 404);
        const err = await addValue(env, v, await req.json(), me); if (err) return err;
        return json(forMe(await vehicle(env, v.id, me, false), me), 201);
      }
      mm = p.match(/^\/api\/values\/(\d+)$/);
      if (mm && m === 'PATCH') {
        const b = await req.json(); const set = {};
        for (const k of ['value', 'confidence', 'source', 'note']) if (k in b) set[k] = String(b[k] ?? '').trim();
        if ('warn' in b) {   // only Rick changes or clears a warning level
          if (me.processor) return bad('The processor cannot change a warning level', 403);
          const w = level(b.warn); if (w === null) return bad(LEVEL_ERR); set.warn = w;
        }
        if ('ftlb_lo' in b || 'ftlb_hi' in b || 'ftlb_src' in b) {   // HANDOFF 15: the torque numbers, Torque field only
          const f = await env.DB.prepare('SELECT f.name, t.name tab FROM vals x JOIN fields f ON f.id = x.field_id JOIN tabs t ON t.id = f.tab_id WHERE x.id=?').bind(+mm[1]).first();
          if (!f) return bad('Value not found', 404);
          if (!isTorque(f.tab, f.name)) return bad('The ft-lb numbers belong to the Torque field only');
          const tq = ftlbOf(b); if (tq.err) return bad(tq.err);
          Object.assign(set, tq);
        }
        if (!Object.keys(set).length) return bad('Nothing to change');
        if ('value' in set && !set.value) return bad('A value cannot be empty');
        if ('confidence' in set && !CONF.includes(set.confidence)) return bad('Confidence must be High, Medium or Low');
        return changeValue(env, +mm[1], 'update', set, me);
      }
      if (mm && m === 'DELETE') return changeValue(env, +mm[1], 'delete', {}, me);
      mm = p.match(/^\/api\/values\/(\d+)\/(confirm|reject)$/);
      if (mm && m === 'POST') {
        // Only Rick confirms: a processor call can never confirm or reject.
        if (me.processor) return bad('The processor cannot confirm or reject values', 403);
        const st = mm[2] === 'confirm' ? 'confirmed' : 'rejected';
        return changeValue(env, +mm[1], mm[2], st === 'confirmed' ? { status: st, confirmed_at: me.now, confirmed_by: me.device } : { status: st }, me);
      }
      mm = p.match(/^\/api\/values\/(\d+)\/history$/);
      if (mm && m === 'GET') return json((await env.DB.prepare('SELECT * FROM history WHERE value_id=? ORDER BY id').bind(+mm[1]).all()).results);
      if (p === '/api/jobs' && m === 'POST') {
        const b = await req.json(); const v = await vehicleRow(env, parseInt(b.vehicle_id, 10));
        if (!v) return bad('Car not found', 404);
        const kind = b.kind === 'workup' ? 'workup' : 'research';
        const wanted = Array.isArray(b.fields) && b.fields.length ? b.fields.map(f => ({ tab: String(f.tab || ''), field: String(f.field || '') })) : await missingFields(env, v);
        if (!wanted.length) return bad('Nothing to research: every field has a value');
        return json({ ok: true, id: await queueJob(env, v, kind, wanted, me) }, 201);
      }
      if (p.startsWith('/api/jobs/') && !me.processor) return bad('Processor only. This route needs the processor service token.', 403);
      if (p === '/api/jobs/claim' && m === 'POST') {
        const b = await req.json().catch(() => ({}));
        const j = await claimJob(env, me, parseInt(b.only_id, 10) || null);
        return j ? json(j) : json({ none: true });
      }
      mm = p.match(/^\/api\/jobs\/(\d+)\/result$/);
      if (mm && m === 'POST') return jobResult(env, +mm[1], await req.json(), me);
      // HANDOFF 13: the research worker keeps a long job: renew the lease before it runs out (same claimer, lease still valid).
      mm = p.match(/^\/api\/jobs\/(\d+)\/renew$/);
      if (mm && m === 'POST') {
        const until = new Date(me.nowMs + LEASE_MIN * 60e3).toISOString();
        const r = await env.DB.prepare("UPDATE jobs SET lease_until=?, updated_at=? WHERE id=? AND status='claimed' AND claimed_by=? AND lease_until > ? RETURNING id, lease_until")
          .bind(until, me.now, +mm[1], me.token, me.now).first();
        return r ? json(r) : bad('This job is not claimed by you, or the lease ran out. Claim it again.', 409);
      }
      mm = p.match(/^\/api\/jobs\/(\d+)\/fail$/);
      if (mm && m === 'POST') {
        const b = await req.json().catch(() => ({}));
        const r = await env.DB.prepare("UPDATE jobs SET status='failed', error=?, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed' AND claimed_by=? RETURNING id")
          .bind(String(b.error || 'failed').slice(0, 500), me.now, +mm[1], me.token).first();
        return r ? json({ ok: true }) : bad('This job is not claimed by you', 409);
      }
      return bad('Not found', 404);
    } catch (e) { return bad('Server error: ' + e.message, 500); }
  }
};
