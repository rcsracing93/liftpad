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
const GROUPS = ['mine', 'frequent', 'visitor'];
const HIDE_DAYS = 30, LEASE_MIN = 10, PHOTO_MAX = 8 * 1048576;
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);

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
    if (!jwks || Date.now() - jwksAt > 3600e3) { const r = await fetch(env.LP_ACCESS_CERTS); jwks = (await r.json()).keys || []; jwksAt = Date.now(); }
    const k = jwks.find(x => x.kid === hd.kid); if (!k) return null;
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
  return { email: c && c.email || '', token, processor, tool, device, now: now.toISOString(), nowMs: now.getTime() };
}

// ---------- Makes and models (unchanged rules) ----------
async function makes(env, q) {
  const { results } = await env.DB.prepare('SELECT name, aliases FROM makes').all();
  const mine = new Set((await env.DB.prepare("SELECT DISTINCT make FROM vehicles WHERE grp='mine'").all()).results.map(r => r.make));
  return results.map(r => { const ss = [r.name, ...(r.aliases ? r.aliases.split('|') : [])].map(n => score(n, q)).filter(x => x >= 0); return { name: r.name, mine: mine.has(r.name), s: ss.length ? Math.min(...ss) : -1 }; })
    .filter(r => r.s >= 0).sort((a, b) => a.s - b.s || (b.mine - a.mine) || a.name.localeCompare(b.name)).slice(0, 10)
    .map(({ name, mine }) => ({ name, mine }));
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
// stay as fallback). img: the page image route when the page is in ali_pages (w, h in pixels).
const pageKey = (edition, pdf) => `ali/${edition}/p${String(pdf).padStart(3, '0')}.jpg`;
async function nearestChart(env, make, model, year) {
  const { results } = await env.DB.prepare(`SELECT a.chart, a.guide_page, a.pdf_page, a.status, a.year_from, a.year_to, a.edition, p.w, p.h,
    b.x bx, b.y by, b.w bw, b.h bh
    FROM ali_index a LEFT JOIN ali_pages p ON p.edition = a.edition AND p.pdf_page = a.pdf_page AND p.status = 'ok'
    LEFT JOIN ali_chart_boxes b ON b.edition = a.edition AND b.chart = a.chart AND b.pdf_page = a.pdf_page
    WHERE a.make=? AND a.model=? ORDER BY a.edition DESC, a.id`).bind(make, model).all();
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
  x.value, x.confidence, x.source, x.note, x.warn, x.status, x.entered_at, x.entered_by, x.confirmed_at, x.confirmed_by, x.updated_at
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
const ftlb = t => { const m = String(t || '').match(/(\d+(?:\.\d+)?)\s*(n\s*·?\s*m\b)?/i); return m ? (m[2] ? +m[1] / 1.35582 : +m[1]) : null; };
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
  const n = ftlb(x.value); if (n == null) return null;
  return n < range.torque_min - 0.5 || n > range.torque_max + 0.5 ? 'outside' : 'inside';
};
const hidden = (v, nowMs) => v.grp === 'visitor' && (nowMs - Date.parse(v.last_seen || v.created_iso || 0)) > HIDE_DAYS * 864e5;
async function vehicleRow(env, id) {
  return env.DB.prepare("SELECT *, strftime('%Y-%m-%dT%H:%M:%fZ', created) created_iso FROM vehicles WHERE id=?").bind(id).first();
}
async function vehicle(env, id, me, touch) {
  const v = await vehicleRow(env, id);
  if (!v) return null;
  if (touch) { await env.DB.prepare('UPDATE vehicles SET last_seen=? WHERE id=?').bind(me.now, id).run(); v.last_seen = me.now; }
  v.values = await carValues(env, v, false);
  v.typical = await typical(env, v.make, v.year, v.values);
  v.values.forEach(x => { x.range_flag = rangeFlag(x, v.typical.range); });
  v.ali = await nearestChart(env, v.make, v.model, v.year);
  v.jobs = (await env.DB.prepare("SELECT id, kind, status, result_summary, error, created_at, updated_at FROM jobs WHERE target IN (?, ?) ORDER BY id DESC LIMIT 5")
    .bind('car:' + id, modelKey(v)).all()).results;
  v.hidden = hidden(v, me.nowMs); v.mine = v.grp === 'mine' ? 1 : 0;
  return v;
}
const modelKey = v => `model:${v.make}|${v.model}|${v.year}`;
async function fieldByName(env, tab, name) {
  return env.DB.prepare('SELECT f.id FROM fields f JOIN tabs t ON t.id = f.tab_id WHERE t.name=? AND f.name=?').bind(tab, name).first();
}
// A new value's id is above every id in vals AND in history, so the id of a deleted value is never
// given again (a reused id would show the old value's history). Also used by tools/import.py.
const NEW_VAL_ID = `(SELECT MAX(m) + 1 FROM (SELECT COALESCE(MAX(id), 0) AS m FROM vals UNION ALL SELECT COALESCE(MAX(value_id), 0) FROM history))`;
// Insert one value and its history row in one batch. last_insert_rowid() is the new value's id.
function insertValueStmts(env, x, me) {
  return [
    env.DB.prepare(`INSERT INTO vals(id, field_id, scope, make, model, year_from, year_to, vehicle_id, value, confidence, source, note, warn, status,
      entered_at, entered_by, confirmed_at, confirmed_by, updated_at) VALUES(${NEW_VAL_ID},?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(x.field_id, x.scope, x.make ?? null, x.model ?? null, x.year_from ?? null, x.year_to ?? null, x.vehicle_id ?? null, x.value, x.confidence,
        x.source || '', x.note || '', x.warn ? 1 : 0, x.status, me.now, me.device, x.status === 'confirmed' ? me.now : null, x.status === 'confirmed' ? me.device : null, me.now),
    env.DB.prepare(`INSERT INTO history(value_id, action, new_value, new_status, new_confidence, at, device) VALUES(last_insert_rowid(), 'insert', ?, ?, ?, ?, ?)`)
      .bind(x.value, x.status, x.confidence, me.now, me.device)];
}
async function addValue(env, v, b, me) {
  const tab = String(b.tab || ''), name = String(b.field || '').trim();
  if (!name || !String(b.value || '').trim() || !CONF.includes(b.confidence)) return bad('Need tab, field, value and confidence (High, Medium or Low)');
  const f = await fieldByName(env, tab, name);
  if (!f) return bad(`Unknown field "${name}" on tab "${tab}"`);
  const scope = b.scope === 'car' ? 'car' : 'model';
  const yf = scope === 'model' ? parseInt(b.year_from ?? v.year, 10) : null, yt = scope === 'model' ? parseInt(b.year_to ?? v.year, 10) : null;
  if (scope === 'model' && (!yearOk(yf) || !yearOk(yt) || yf > yt)) return bad('Year range is not valid');
  // A browser entry by Rick is confirmed only when he asks for it; the processor can only propose.
  const status = !me.processor && b.status === 'confirmed' ? 'confirmed' : 'proposed';
  await env.DB.batch(insertValueStmts(env, { field_id: f.id, scope, make: scope === 'model' ? v.make : null, model: scope === 'model' ? v.model : null,
    year_from: yf, year_to: yt, vehicle_id: scope === 'car' ? v.id : null, value: String(b.value).trim(), confidence: b.confidence,
    source: b.source, note: b.note, warn: b.warn, status }, me));
  return null;
}
// Change a value and write its history row in the same batch. The history row copies the old
// state from the row itself, so it can never describe a state the row did not have.
async function changeValue(env, id, action, set, me) {
  const old = await env.DB.prepare('SELECT * FROM vals WHERE id=?').bind(id).first();
  if (!old) return bad('Value not found', 404);
  if (action === 'delete') {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO history(value_id, action, old_value, old_status, old_confidence, at, device) SELECT id, 'delete', value, status, confidence, ?, ? FROM vals WHERE id=?`).bind(me.now, me.device, id),
      env.DB.prepare('DELETE FROM vals WHERE id=?').bind(id)]);
    return json({ ok: true });
  }
  const keys = Object.keys(set);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO history(value_id, action, old_value, new_value, old_status, new_status, old_confidence, new_confidence, at, device)
      SELECT id, ?, value, ?, status, ?, confidence, ?, ?, ? FROM vals WHERE id=?`)
      .bind(action, set.value ?? old.value, set.status ?? old.status, set.confidence ?? old.confidence, me.now, me.device, id),
    env.DB.prepare(`UPDATE vals SET ${keys.map(k => k + '=?').join(', ')}, updated_at=? WHERE id=?`).bind(...keys.map(k => set[k]), me.now, id)]);
  return json({ ok: true });
}

// ---------- Jobs (research queue, processor-agnostic) ----------
async function missingFields(env, v) {
  const { fields } = await tabsFields(env);
  const have = new Set((await carValues(env, v, false)).map(x => x.field_id));
  return fields.filter(f => !have.has(f.id)).map(f => ({ tab: f.tab, field: f.name }));
}
// The request holds only make, model, year, trim and field names. Never a VIN, a name, notes or photos.
async function queueJob(env, v, kind, wanted, me) {
  const req = { make: v.make, model: v.model, year: v.year, trim: v.trim || '', fields: wanted };
  const r = await env.DB.prepare('INSERT INTO jobs(kind, target, request, status, created_at, updated_at) VALUES(?,?,?,?,?,?) RETURNING id')
    .bind(kind, modelKey(v), JSON.stringify(req), 'queued', me.now, me.now).first();
  return r.id;
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
  const stmts = [];
  for (const x of vals) {
    if (!x || !String(x.value || '').trim() || !CONF.includes(x.confidence) || !String(x.source || '').trim()) return bad('Each value needs field, value, confidence and source');
    const f = await fieldByName(env, String(x.tab || ''), String(x.field || ''));
    if (!f) return bad(`Unknown field "${x.field}" on tab "${x.tab}"`);
    stmts.push(...insertValueStmts(env, { field_id: f.id, scope: 'model', make: rq.make, model: rq.model, year_from: rq.year, year_to: rq.year,
      value: String(x.value).trim(), confidence: x.confidence, source: x.source, note: x.note, status: 'proposed' }, me));
  }
  stmts.push(env.DB.prepare("UPDATE jobs SET status='done', result_summary=?, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed' AND claimed_by=?")
    .bind(`${vals.length} proposed value(s)`, me.now, id, me.token));
  await env.DB.batch(stmts);
  return json({ ok: true, proposed: vals.length });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url); const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const me = await who(req, env);
      if (p === '/api/health') { const n = await env.DB.prepare("SELECT (SELECT count(*) FROM ali_index) a, (SELECT count(*) FROM classics) c, (SELECT count(*) FROM vehicles) v, (SELECT count(*) FROM makes) m, (SELECT count(*) FROM vals) vals, (SELECT count(*) FROM vals WHERE status='proposed') proposed, (SELECT count(*) FROM jobs WHERE status IN ('queued','claimed')) jobs, (SELECT count(*) FROM ali_pages WHERE status='ok') pages, (SELECT count(*) FROM make_defaults) defaults, (SELECT count(*) FROM thread_ranges) ranges, (SELECT max(id) FROM schema_migrations) schema").first(); return json({ ok: true, ...n }); }
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
        return json({ vin, year: parseInt(d.ModelYear, 10) || null, make: d.Make ? d.Make[0] + d.Make.slice(1).toLowerCase() : '', model: d.Model || '', trim: [d.Trim, d.Series].filter(Boolean).join(' '),
          engine, fuel: d.FuelTypePrimary || '', electrification: d.ElectrificationLevel || '', ev, error: d.ErrorCode !== '0' ? d.ErrorText : '' });
      }
      if (p === '/api/tabs' && m === 'GET') return json(await tabsFields(env));
      // Decision 8: lookup links for one car (built, never fetched).
      if (p === '/api/links' && m === 'GET') {
        const q = k => url.searchParams.get(k) || '';
        if (!q('make') || !yearOk(parseInt(q('year'), 10))) return bad('Need make and a 4-digit year');
        return json(lookupLinks({ year: q('year'), make: q('make'), model: q('model'), engine: q('engine'), ev: q('ev') === '1' }));
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
        return json({ count: results.length, values: results });
      }
      if (p === '/api/vehicles' && m === 'GET') {
        // Storyboard T1: each tile has a status line - how many values there are, how many wait for a
        // confirm, and whether a warning value (e.g. air suspension) applies.
        const all = (await env.DB.prepare(`SELECT v.id, v.year, v.make, v.model, v.trim, v.grp, v.last_seen, strftime('%Y-%m-%dT%H:%M:%fZ', v.created) created_iso,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND ${CAR_VALS}) nvals,
          (SELECT count(*) FROM vals x WHERE x.status='proposed' AND ${CAR_VALS}) nproposed,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND x.warn=1 AND ${CAR_VALS}) nwarn
          FROM vehicles v ORDER BY CASE v.grp WHEN 'mine' THEN 0 WHEN 'frequent' THEN 1 ELSE 2 END, v.make, v.model, v.year`).all()).results
          .map(v => ({ ...v, hidden: hidden(v, me.nowMs), mine: v.grp === 'mine' ? 1 : 0 }));
        return json(url.searchParams.get('hidden') === '1' ? all : all.filter(v => !v.hidden));
      }
      if (p === '/api/vehicles' && m === 'POST') {
        const b = await req.json(); const year = parseInt(b.year, 10);
        if (!b.make || !b.model || !yearOk(year)) return bad('Need year, make and model');
        const grp = GROUPS.includes(b.grp) ? b.grp : (b.mine === true ? 'mine' : 'visitor');
        const r = await env.DB.prepare('INSERT INTO vehicles(year, make, model, trim, vin, mine, grp, last_seen) VALUES(?,?,?,?,?,?,?,?) RETURNING id')
          .bind(year, b.make, b.model, b.trim || '', b.vin || '', grp === 'mine' ? 1 : 0, grp, me.now).first();
        return json(await vehicle(env, r.id, me, false), 201);
      }
      let mm = p.match(/^\/api\/vehicles\/(\d+)$/);
      // Decision 11: the VIN is on the car record only and goes to NHTSA only - never to the processor.
      if (mm && m === 'GET') { const v = await vehicle(env, +mm[1], me, url.searchParams.get('peek') !== '1'); if (v && me.processor) delete v.vin; return v ? json(v) : bad('Car not found', 404); }
      if (mm && m === 'PATCH') {
        const b = await req.json(); const v = await vehicleRow(env, +mm[1]);
        if (!v) return bad('Car not found', 404);
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
        if (b.grp === 'frequent' && v.grp !== 'frequent') { const miss = await missingFields(env, v); if (miss.length) job = await queueJob(env, v, 'workup', miss, me); }
        return json({ ok: true, workup_job: job });
      }
      if (mm && m === 'DELETE') {
        // Car overrides go with the car, each with its history row; model-year values stay (other cars use them).
        const ids = (await env.DB.prepare("SELECT id FROM vals WHERE scope='car' AND vehicle_id=?").bind(+mm[1]).all()).results.map(r => r.id);
        for (const id of ids) await changeValue(env, id, 'delete', {}, me);
        await env.DB.batch([env.DB.prepare('DELETE FROM specs WHERE vehicle_id=?').bind(+mm[1]), env.DB.prepare('DELETE FROM vehicles WHERE id=?').bind(+mm[1])]);
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
        return json(await vehicle(env, v.id, me, false), 201);
      }
      mm = p.match(/^\/api\/values\/(\d+)$/);
      if (mm && m === 'PATCH') {
        const b = await req.json(); const set = {};
        for (const k of ['value', 'confidence', 'source', 'note']) if (k in b) set[k] = String(b[k] ?? '').trim();
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
