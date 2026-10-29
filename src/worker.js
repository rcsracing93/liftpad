// LiftPad API. Every request comes here first (run_worker_first); paths outside /api/ go to the
// static app in /public (Workers Assets).
import { lookupLinks } from './links.js';
import { vinCheckDigit, feItems, feVariants, matchFeOption, canadianTrims, engineMatches, parseDoorcardRead, feRowFresh, VIN_SHAPE, scrubText, parseRecalls, pickWeight, maskVin, scrubDeep, d1Lines, d1IsPaid, d1Month } from './lib.js';
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
// HANDOFF 17 (B9): one more route, GET /api/photos/<car>/<file>. It works only while a read_doorcard job for exactly that photo is claimed by
// the caller (checked in the route). ALI page images (/api/ali/...) are not in this list, so they stay 403.
const PROC_ROUTES = [
  ['GET', /^\/api\/(whoami|tabs|vehicles|needs-confirming|service-log\.csv)$/], ['GET', /^\/api\/vehicles\/\d+$/], ['GET', /^\/api\/photos\/\d+\/[0-9TZ-]+\.(?:jpg|png|webp)$/],
  ['POST', /^\/api\/vehicles\/\d+\/values$/], ['POST', /^\/api\/jobs\/claim$/], ['POST', /^\/api\/jobs\/\d+\/(result|renew|fail)$/],
  // HANDOFF 18 (C1): the N100 pushes the ops log. Only this POST; every GET under /api/admin/ is Rick's own login (checked in the route).
  ['POST', /^\/api\/admin\/log$/]];

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
// HANDOFF 17 (B5): a value with an engine applies only to a car with that engine; a car with no engine set sees all of them; a value with no engine applies to all.
// The engines are compared by a normalized key (lib.js engineMatches: displacement, cylinders, turbo, electric), which SQL cannot do. So the SQL counts
// below take only the values with NO engine tag (CAR_VALS); the few tagged values are added per car in JS (tagCounts).
const CAR_VALS_ANY = `((x.scope='car' AND x.vehicle_id=v.id) OR (x.scope='model' AND x.make=v.make AND x.model=v.model AND x.year_from<=v.year AND x.year_to>=v.year))`;
const CAR_VALS = `(${CAR_VALS_ANY} AND x.engine IS NULL)`;
async function tagCounts(env, cars) {
  const tagged = (await env.DB.prepare("SELECT x.id, x.scope, x.vehicle_id, x.make, x.model, x.year_from, x.year_to, x.status, x.warn, x.engine FROM vals x WHERE x.engine IS NOT NULL AND x.status<>'rejected'").all()).results;
  const out = new Map(cars.map(c => [c.id, { nvals: 0, nproposed: 0, nblock: 0, ncaution: 0 }]));
  for (const c of cars) for (const x of tagged) {
    const mine = (x.scope === 'car' && x.vehicle_id === c.id) || (x.scope === 'model' && x.make === c.make && x.model === c.model && x.year_from <= c.year && x.year_to >= c.year);
    if (!mine || !engineMatches(c.engine, x.engine)) continue;
    const o = out.get(c.id); o.nvals++; if (x.status === 'proposed') o.nproposed++; if (x.warn === 2) o.nblock++; if (x.warn === 1) o.ncaution++;
  }
  return out;
}
// Display order: car override, then model-year value; confirmed before proposed; rejected hidden.
// Ultrareview B #4: a car with an engine shows its engine's value first; a car with NO engine shows the untagged value first, and the
// app keeps the engine-tagged values out of the headline picks (no_headline) and labels them on the value card.
async function carValues(env, v, withRejected) {
  const { results } = await env.DB.prepare(`${VAL_SELECT} WHERE ((x.scope='car' AND x.vehicle_id=?) OR (x.scope='model' AND x.make=? AND x.model=? AND x.year_from<=? AND x.year_to>=?))
    ${withRejected ? '' : "AND x.status<>'rejected'"}
    ORDER BY t.sort, f.sort, f.id, (x.scope='car') DESC, (x.status='confirmed') DESC, ((x.engine IS NOT NULL) * ?) DESC, x.id`).bind(v.id, v.make, v.model, v.year, v.year, v.engine ? 1 : -1).all();
  results.forEach(x => { x.no_headline = !v.engine && !!x.engine; });
  return results.filter(x => engineMatches(v.engine, x.engine));   // HANDOFF 17: by the normalized engine key, not by text
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
  // Opus review finding 8: the summary of a photo read says whether the car has a saved VIN ("VIN matches / differs / read"): not for the processor.
  if (me.processor) v.jobs.forEach(j => { if (j.kind === 'read_doorcard') j.result_summary = null; });
  v.hidden = hidden(v, me.nowMs); v.mine = v.grp === 'mine' ? 1 : 0;
  // HANDOFF 18 (C7, C8): the cached recalls answer and the curb weight; facts_due tells the app to post /facts once the page is drawn.
  if (!me.processor) { const cf = await carFacts(env, v, me.nowMs); v.recalls = cf.recalls; v.curb = cf.curb; v.weight_error = cf.weight_error; v.facts_due = cf.due; }
  v.no_vin = !v.vin; v.no_doorcard = !placardFields(v.values).size;   // HANDOFF 17 (B10), computed
  return v;
}
// Decision 11 + HANDOFF 15 (ultrareview F6): a car sent to the processor never holds the VIN, the notes, the owner or the ALI-derived
// adapter notes. Every route that returns a car object passes it through here; the keys are removed, not blanked.
const PRIVATE_CAR_KEYS = ['vin', 'notes', 'owner', 'chart_notes', 'chart_notes_footer', 'no_vin', 'no_doorcard'];
const forMe = (v, me) => { if (v && me.processor) PRIVATE_CAR_KEYS.forEach(k => { delete v[k]; }); return v; };
const TRIM_MAX = 60;
// HANDOFF 17: the car fields that the Add car lists and the one-time "Pick engine from the list" set. Only keys present in b are returned.
function carExtras(b) {
  const out = {};
  for (const k of ['variant', 'engine']) if (k in b) {
    const t = String(b[k] ?? '').trim();
    if (t.length > 80 || /[\u0000-\u001f]/.test(t)) return { err: `${k} has at most 80 characters and no control characters` };
    out[k] = t || null;
  }
  if ('fe_id' in b) {
    if (b.fe_id === null || b.fe_id === '') out.fe_id = null;
    else { const n = Number(b.fe_id); if (!Number.isInteger(n) || n < 1 || n > 9999999) return { err: 'fe_id must be a whole number' }; out.fe_id = n; }
  }
  if ('fuel' in b) {
    const t = String(b.fuel ?? '').trim();
    if (t && !FUELS.includes(t)) return { err: `Fuel must be one of ${FUELS.join(', ')}` };
    out.fuel = t || null;
  }
  return out;
}
// B7: every VIN, typed or read, must pass the ISO 3779 check digit. A car first sold outside North America may fail it: Rick saves it with not_us.
const notUs = b => b.not_us === true || b.not_us === 1 || b.not_us === '1';
function vinProblem(vin, b) {
  if (!VIN_SHAPE.test(vin)) return bad('A VIN has 17 letters and digits, with no I, O or Q');
  if (!vinCheckDigit(vin) && !notUs(b)) return json({ error: 'The VIN check digit fails. Check the VIN, or save it as a VIN that is not US-market.', check_failed: true }, 400);
  return null;
}
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
    source: b.source, note: b.note, warn, status, engine: b.engine ? String(b.engine).trim().slice(0, 80) : null, ...tq }, me));
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
  if (v.engine) req.engine = v.engine;   // HANDOFF 17 (B5): the worker answers for this engine and posts the values with the engine tag
  const r = await env.DB.prepare('INSERT INTO jobs(kind, target, request, status, created_at, updated_at) VALUES(?,?,?,?,?,?) RETURNING id')
    .bind(kind, modelKey(v), JSON.stringify(req), 'queued', me.now, me.now).first();
  return r.id;
}
// HANDOFF 13: a car that Rick adds, or whose trim he changes, gets a research job by itself for its missing fields. Not for the
// self-test token (its test cars would cost real research), and not when a job for the car or model is still open (no duplicate).
// The switch is the Worker variable LP_AUTO_RESEARCH ("1" = on). Default OFF (Rick, 2026-10-24): it is turned on only after the first
// live run of the research worker on the 2022 Sonata has passed (see the release plan).
// Ultrareview B #3 and #7: an open job blocks a new one only when it is a research or workup job (a pending photo read is a read_doorcard job
// on the target car:<id> and must not stop research) AND it is for the same engine (a car of the same model and year with another engine
// is not blocked; a car with an engine and a job without one are different requests too).
const sameEngine = (a, b) => { const x = String(a ?? '').trim(), y = String(b ?? '').trim(); return !x || !y ? x === y : engineMatches(x, y); };
async function openJob(env, v) {
  const open = (await env.DB.prepare("SELECT id, request FROM jobs WHERE target IN (?, ?) AND kind IN ('research','workup') AND status IN ('queued','claimed')").bind('car:' + v.id, modelKey(v)).all()).results;
  return open.find(j => { try { return sameEngine(JSON.parse(j.request).engine, v.engine); } catch (e) { return true; } }) || null;
}
async function autoResearch(env, v, me) {
  if (env.LP_AUTO_RESEARCH !== '1' || me.tool || me.processor || await openJob(env, v)) return null;
  const miss = await missingFields(env, v);
  return miss.length ? await queueJob(env, v, 'research', miss, me) : null;
}
// HANDOFF 17 (B12): kinds = the job kinds the caller works on. The research worker asks for research and workup, the photo script for
// read_doorcard, so neither takes the other's job. No kinds given = research and workup only (an old caller never gets a photo job).
const JOB_KINDS = ['research', 'workup', 'read_doorcard'];
async function claimJob(env, me, onlyId, kinds) {
  const until = new Date(me.nowMs + LEASE_MIN * 60e3).toISOString();
  const ks = Array.isArray(kinds) && kinds.length ? kinds.filter(k => JOB_KINDS.includes(k)) : ['research', 'workup'];
  if (!ks.length) return null;
  const r = await env.DB.prepare(`UPDATE jobs SET status='claimed', claimed_by=?, lease_until=?, attempts=attempts+1, updated_at=?
    WHERE id = (SELECT id FROM jobs WHERE (status='queued' OR (status='claimed' AND lease_until < ?)) AND kind IN (${ks.map(() => '?').join(',')}) ${onlyId ? 'AND id=?' : ''} ORDER BY created_at, id LIMIT 1)
    RETURNING id, kind, target, request, attempts, lease_until`).bind(...[me.token, until, me.now, me.now, ...ks, ...(onlyId ? [onlyId] : [])]).first();
  if (!r) return null;
  r.request = JSON.parse(r.request);
  return r;
}
async function jobResult(env, id, b, me) {
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  if (!j) return bad('Job not found', 404);
  if (j.status !== 'claimed' || j.claimed_by !== me.token || !(j.lease_until > me.now)) return bad('This job is not claimed by you, or the lease ran out. Claim it again.', 409);
  if (j.kind === 'read_doorcard') return doorcardResult(env, j, b, me);
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
    // HANDOFF 17 (B5): only a value that the worker marked for the request's engine (its own "engine" field; the worker does that for the fields that
    // differ by engine) carries the tag. A value without it (lug-nut torque, lift points) applies to every engine. A confirmed value for no engine or
    // for the same engine blocks it. (Opus review finding 1.)
    const eng = rq.engine && x.engine && engineMatches(rq.engine, x.engine) ? String(rq.engine) : null;
    const conf = (await env.DB.prepare("SELECT engine FROM vals WHERE field_id=? AND scope='model' AND make=? AND model=? AND year_from<=? AND year_to>=? AND status='confirmed'").bind(f.id, rq.make, rq.model, rq.year, rq.year).all()).results;
    if (conf.some(c => !c.engine || engineMatches(eng, c.engine))) { skipped++; continue; }
    stmts.push(...insertValueStmts(env, { field_id: f.id, scope: 'model', make: rq.make, model: rq.model, year_from: rq.year, year_to: rq.year,
      value: String(x.value).trim(), confidence: x.confidence, source: x.source, note: x.note, status: 'proposed', engine: eng, ...tq }, me));
  }
  stmts.push(env.DB.prepare("UPDATE jobs SET status='done', result_summary=?, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed' AND claimed_by=?")
    .bind(`${vals.length - skipped} proposed value(s)${skipped ? `, ${skipped} skipped (already confirmed)` : ''}`, me.now, id, me.token));
  await env.DB.batch(stmts);
  return json({ ok: true, proposed: vals.length - skipped, skipped });
}

// ---------- Engine lists: fueleconomy.gov through the Worker (HANDOFF 17, B1-B3) ----------
// The answers are cached in fe_menu. Ultrareview B #2: an EMPTY answer is never cached (it is asked again next time), and a row is kept for ever only
// when it was fetched AFTER its model year ended (the list is complete then). A row fetched during or before its model year (new models are added
// all year) is fetched again after a year.
// If the fetch fails the old row is used (even an expired one); with no row the caller gets an empty list and "error".
const FE_REFRESH_MS = 365 * 864e5;
async function feMenu(env, year, make, model) {
  const row = await env.DB.prepare('SELECT options_json, fetched_at FROM fe_menu WHERE year=? AND make=? AND model=?').bind(year, make, model || '').first();
  const cached = row ? JSON.parse(row.options_json) : null;
  if (feRowFresh(row, year, Date.now(), FE_REFRESH_MS)) return { items: cached };
  const q = `year=${year}&make=${encodeURIComponent(make)}${model ? '&model=' + encodeURIComponent(model) : ''}`;
  try {
    const r = await fetch(`${env.FE}/menu/${model ? 'options' : 'model'}?${q}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const items = feItems(await r.json());
    if (!items.length) return cached && cached.length ? { items: cached, stale: true } : { items };   // empty: not cached (a later ask fetches again); an old list is not replaced by nothing
    await env.DB.prepare('INSERT INTO fe_menu(year, make, model, options_json, fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(year, make, model) DO UPDATE SET options_json=excluded.options_json, fetched_at=excluded.fetched_at')
      .bind(year, make, model || '', JSON.stringify(items), new Date().toISOString()).run();
    return { items };
  } catch (e) {
    return row ? { items: JSON.parse(row.options_json), stale: true } : { items: [], error: 'fueleconomy.gov did not answer' };
  }
}
// The VIN decode names displacement, cylinders and electrification. Look through every variant of the plain model for exactly one option
// with that engine. Several matches are narrowed by the drive type (4WD/AWD or 2WD) only when that leaves exactly one.
async function feMatch(env, year, make, model, dec) {
  const all = [];
  for (const vr of feVariants((await feMenu(env, year, make, '')).items, model))
    for (const o of (await feMenu(env, year, make, vr.text)).items) all.push({ variant: vr.text, ...o });
  if (!all.length) return null;
  const one = matchFeOption(all, dec);
  if (one) return one;
  const cand = all.filter(o => matchFeOption([o], dec));
  if (cand.length < 2 || !dec.drive) return null;
  const wd = /4x4|4wd|4-wheel|awd|all-wheel/i.test(dec.drive) ? /4WD|AWD/ : /2wd|rwd|fwd|front|rear/i.test(dec.drive) ? /2WD|RWD|FWD/ : null;
  const by = wd ? cand.filter(o => wd.test(o.variant)) : [];
  return by.length === 1 ? by[0] : null;
}
// Trim names for the Add car list: those LiftPad already has for this make, model and year, then the Canadian specs (labelled).
async function trimNames(env, year, make, model) {
  const out = [], seen = new Set();
  const add = (name, source) => { const k = fold(name); if (name && !seen.has(k)) { seen.add(k); out.push({ name, source }); } };
  const mine = await env.DB.prepare("SELECT DISTINCT trim FROM vehicles WHERE make=? AND model=? AND year=? AND trim<>'' AND trim NOT LIKE 'SELFTEST%' ORDER BY trim").bind(make, model, year).all();
  mine.results.forEach(r => add(r.trim, 'LiftPad'));
  try {
    const nm = (await env.DB.prepare('SELECT nhtsa_name FROM makes WHERE name=?').bind(make).first() || {}).nhtsa_name || make;
    const r = await fetch(`${env.NHTSA}/GetCanadianVehicleSpecifications/?Year=${year}&Make=${encodeURIComponent(nm)}&Model=${encodeURIComponent(model)}&units=&format=json`, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (r.ok) canadianTrims(await r.json()).forEach(t => add(t.name, 'Canadian specs'));
  } catch (e) { /* NHTSA down (503 is common): the list has the LiftPad names only */ }
  return out;
}
// ---------- Recalls and curb weight (HANDOFF 18, C7, C8) ----------
// Once a day per car, never through the research model, and only after the car page is on screen (the app posts /api/vehicles/<id>/facts).
// Recalls: NHTSA recallsByVehicle has no per-VIN "open" status, so the line says "N recalls for this model year". When the car has a saved VIN,
// the model name comes from the NHTSA VIN decode (Rick 2026-10-28: the full VIN may go to NHTSA); if that fails, the car's own year, make and
// model are used. A good answer is kept 20 hours; a failed try is repeated after 1 hour; the old answer stays when a try fails.
const FACTS_OK_MS = 20 * 3600e3, FACTS_RETRY_MS = 3600e3;
const fresh2 = (ok, tr, nowMs) => (ok && nowMs - Date.parse(ok) < FACTS_OK_MS) || (tr && nowMs - Date.parse(tr) < FACTS_RETRY_MS);
async function nhtsaJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function recallNames(env, v) {
  const out = [];
  if (v.vin && VIN_SHAPE.test(String(v.vin).toUpperCase())) {
    try {
      const d = (await nhtsaJson(`${env.NHTSA}/DecodeVinValues/${String(v.vin).toUpperCase()}?format=json`)).Results[0];
      if (d && d.Make && d.Model && parseInt(d.ModelYear, 10)) out.push({ make: d.Make, model: d.Model, year: parseInt(d.ModelYear, 10), by: 'vin' });
    } catch (e) { /* the decode failed: the car's own names are used */ }
  }
  const nm = (await env.DB.prepare('SELECT nhtsa_name FROM makes WHERE name=?').bind(v.make).first() || {}).nhtsa_name || v.make;
  out.push({ make: nm, model: v.model, year: v.year, by: 'saved' });
  return out;
}
async function refreshRecalls(env, v, f, me) {
  if (fresh2(f && f.recalls_ok_at, f && f.recalls_try_at, me.nowMs)) return;
  let hit = null, empty = null;
  for (const c of await recallNames(env, v)) {
    try {
      const items = parseRecalls(await nhtsaJson(`${env.RECALLS}/recallsByVehicle?make=${encodeURIComponent(c.make)}&model=${encodeURIComponent(c.model)}&modelYear=${c.year}`));
      if (items && items.length) { hit = { ...c, items }; break; }
      if (items && !empty) empty = { ...c, items };   // an empty list from one spelling is kept, but the next name is tried before "0 recalls" is shown
    } catch (e) { /* try the next name (the i4 answers HTTP 400 for some names) */ }
  }
  if (!hit) hit = empty;
  if (hit) {
    await env.DB.prepare(`INSERT INTO car_facts(vehicle_id, recalls_json, recalls_count, recalls_by, recalls_model, recalls_ok_at, recalls_try_at, recalls_error) VALUES(?,?,?,?,?,?,?,NULL)
      ON CONFLICT(vehicle_id) DO UPDATE SET recalls_json=excluded.recalls_json, recalls_count=excluded.recalls_count, recalls_by=excluded.recalls_by, recalls_model=excluded.recalls_model,
      recalls_ok_at=excluded.recalls_ok_at, recalls_try_at=excluded.recalls_try_at, recalls_error=NULL`)
      .bind(v.id, JSON.stringify(hit.items), hit.items.length, hit.by, `${hit.year} ${hit.make} ${hit.model}`.slice(0, 80), me.now, me.now).run();
  } else {
    await env.DB.prepare(`INSERT INTO car_facts(vehicle_id, recalls_try_at, recalls_error) VALUES(?,?,?)
      ON CONFLICT(vehicle_id) DO UPDATE SET recalls_try_at=excluded.recalls_try_at, recalls_error=excluded.recalls_error`).bind(v.id, me.now, 'NHTSA did not give a recalls answer').run();
  }
}
// Curb weight from the Canadian specs: a PROPOSED value. A confirmed value is never replaced (the UPDATE says so, not only the check).
async function refreshWeight(env, v, f, me) {
  if (v.curb_status === 'confirmed') return;
  if (fresh2(v.curb_at, f && f.weight_try_at, me.nowMs)) return;
  let err = '';
  try {
    const nm = (await env.DB.prepare('SELECT nhtsa_name FROM makes WHERE name=?').bind(v.make).first() || {}).nhtsa_name || v.make;
    const w = pickWeight(canadianTrims(await nhtsaJson(`${env.NHTSA}/GetCanadianVehicleSpecifications/?Year=${v.year}&Make=${encodeURIComponent(nm)}&Model=${encodeURIComponent(v.model)}&units=&format=json`)), v.trim);
    if (w) {
      await env.DB.prepare("UPDATE vehicles SET curb_lb=?, curb_front_pct=?, curb_source=?, curb_status='proposed', curb_at=? WHERE id=? AND curb_status IS NOT 'confirmed'").bind(w.lb, w.front_pct, w.source, me.now, v.id).run();
      await env.DB.prepare(`INSERT INTO car_facts(vehicle_id, weight_try_at, weight_error) VALUES(?,?,NULL) ON CONFLICT(vehicle_id) DO UPDATE SET weight_try_at=excluded.weight_try_at, weight_error=NULL`).bind(v.id, me.now).run();
      return;
    }
    err = 'No Canadian weight found for this car';
  } catch (e) { err = 'NHTSA did not give a weight answer'; }
  await env.DB.prepare(`INSERT INTO car_facts(vehicle_id, weight_try_at, weight_error) VALUES(?,?,?) ON CONFLICT(vehicle_id) DO UPDATE SET weight_try_at=excluded.weight_try_at, weight_error=excluded.weight_error`).bind(v.id, me.now, err).run();
}
async function carFacts(env, v, nowMs = Date.now()) {
  const f = await env.DB.prepare('SELECT * FROM car_facts WHERE vehicle_id=?').bind(v.id).first();
  let items = []; try { items = f && f.recalls_json ? JSON.parse(f.recalls_json) : []; } catch (e) { items = []; }
  return {
    due: !fresh2(f && f.recalls_ok_at, f && f.recalls_try_at, nowMs) || (v.curb_status !== 'confirmed' && !fresh2(v.curb_at, f && f.weight_try_at, nowMs)),
    recalls: f && f.recalls_ok_at ? { count: f.recalls_count, by: f.recalls_by, model: f.recalls_model, as_of: f.recalls_ok_at, items, error: f.recalls_error || null } : (f && f.recalls_error ? { count: null, error: f.recalls_error, items: [] } : null),
    curb: v.curb_lb ? { lb: v.curb_lb, front_pct: v.curb_front_pct, source: v.curb_source, status: v.curb_status, at: v.curb_at } : null,
    weight_error: f && f.weight_error || null,
  };
}
async function refreshFacts(env, v, me) {
  let f = await env.DB.prepare('SELECT * FROM car_facts WHERE vehicle_id=?').bind(v.id).first();
  await refreshRecalls(env, v, f, me);
  f = await env.DB.prepare('SELECT * FROM car_facts WHERE vehicle_id=?').bind(v.id).first();
  await refreshWeight(env, v, f, me);
  return carFacts(env, await vehicleRow(env, v.id));
}
// Rick types or confirms the weight. { action: 'confirm', lb?, front_pct? } keeps the proposed numbers or replaces them with his; { action: 'clear' } removes it.
async function curbDecision(env, v, b, me) {
  if (b.action === 'clear') {
    await env.DB.prepare('UPDATE vehicles SET curb_lb=NULL, curb_front_pct=NULL, curb_source=NULL, curb_status=NULL, curb_at=NULL WHERE id=?').bind(v.id).run();
    return json({ ok: true, curb: null });
  }
  if (b.action !== 'confirm') return bad('action is confirm or clear');
  const typed = b.lb !== undefined && b.lb !== null && b.lb !== '';
  const lb = typed ? Number(b.lb) : v.curb_lb;
  if (!Number.isInteger(lb) || lb < 500 || lb > 20000) return bad('The curb weight is a whole number of pounds from 500 to 20000');
  let fp = b.front_pct === undefined ? v.curb_front_pct : (b.front_pct === null || b.front_pct === '' ? null : Number(b.front_pct));
  if (fp !== null && fp !== undefined && (!Number.isInteger(fp) || fp < 20 || fp > 80)) return bad('The front share is a whole percent from 20 to 80');
  if (!typed && !v.curb_lb) return bad('There is no proposed weight to confirm');
  await env.DB.prepare("UPDATE vehicles SET curb_lb=?, curb_front_pct=?, curb_source=?, curb_status='confirmed', curb_at=? WHERE id=?")
    .bind(lb, fp ?? null, typed ? 'Typed by Rick' : v.curb_source, me.now, v.id).run();
  return json({ ok: true, curb: (await carFacts(env, await vehicleRow(env, v.id))).curb });
}

// ---------- Admin page (HANDOFF 18, C1 to C5, C10) ----------
// ops_log rows come from the N100 (POST /api/admin/log, processor token). The page itself is Rick's own Access login only: the processor,
// the self-test tool and any service token get 403. Secrets are scrubbed again here before the insert; a VIN is masked to its last 4.
const OPS_KINDS = ['queue', 'worker_run', 'health', 'backup', 'token_check', 'export', 'd1_usage'], OPS_LEVELS = ['green', 'amber', 'red'];
const OPS_KEEP_DAYS = 30, OPS_PUSH_MAX = 60, OPS_DATA_MAX = 6000;
const NY = 'America/New_York';
// Rick's own Access login: an e-mail, no service token. LP_ADMIN_EMAILS (optional, comma list) narrows it to those addresses; unset = every
// address that the Access policy lets in (the policy is the first gate).
const rickOnly = (me, env) => { const a = list(env && env.LP_ADMIN_EMAILS).map(x => x.toLowerCase()); return !!me.email && !me.token && (!a.length || a.includes(me.email.toLowerCase())); };
const worstOf = ls => ls.includes('red') ? 'red' : ls.includes('amber') ? 'amber' : 'green';
const nyDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: NY }).format(new Date(ms));
// UTC start of a New York calendar day (the offset is 4 or 5 hours), and the start of the next one.
function nyStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  for (const off of [4, 5]) { const s = Date.UTC(y, m - 1, d, off); if (nyDay(s) === day && nyDay(s - 1) !== day) return s; }
  return Date.UTC(y, m - 1, d);
}
// A job error in words (Rick 2026-10-26: "error text in words").
function errorWords(e) {
  const t = String(e || '');
  if (/daily_limit/i.test(t)) return 'The daily job limit was reached.';
  if (/\b429\b|rate.?limit/i.test(t)) return 'The Claude API was busy (error 429). The job can be tried again.';
  if (/\b529\b|overload/i.test(t)) return 'The Claude API was overloaded (error 529).';
  if (/time.?out|timed out|ETIMEDOUT/i.test(t)) return 'The Claude API did not answer in time (timeout).';
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid.*key/i.test(t)) return 'The Claude API key or the service token was refused.';
  if (/worker broke/i.test(t)) return 'The research worker stopped with an error.';
  return scrubText(t).slice(0, 160) || 'No error text.';
}
async function adminLogPush(env, b, me) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (rows.length > OPS_PUSH_MAX) return bad(`At most ${OPS_PUSH_MAX} rows in one push`);
  const extra = list(env.LP_SCRUB_WORDS), stmts = [];
  for (const r of rows) {
    if (!r || !OPS_KINDS.includes(r.kind) || !OPS_LEVELS.includes(r.level)) return bad('A row has an unknown kind or level');
    const t = Date.parse(r.ts), ts = Number.isFinite(t) && Math.abs(t - me.nowMs) < 2 * 864e5 ? new Date(t).toISOString() : me.now;
    // scrubbed string by string (the structure stays valid JSON); a data field over the limit is dropped and the row says so
    let data = r.data === undefined || r.data === null ? null : JSON.stringify(scrubDeep(r.data, extra));
    let dropped = false;
    if (data !== null && data.length > OPS_DATA_MAX) { data = null; dropped = true; }
    stmts.push(env.DB.prepare('INSERT INTO ops_log(ts, kind, level, text, data_json) VALUES(?,?,?,?,?)').bind(ts, r.kind, r.level, (scrubText(r.text, extra) + (dropped ? ' (details too large, not kept)' : '')).slice(0, 500), data));
  }
  let pruned = 0;
  if (b.prune) {
    // the real clock, never the test clock (a processor request with a future x-lp-now must not be able to empty the log)
    const cut = new Date(Date.now() - OPS_KEEP_DAYS * 864e5).toISOString();
    const p = await env.DB.prepare('DELETE FROM ops_log WHERE ts < ?').bind(cut).run();
    pruned = p.meta && p.meta.changes || 0;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, inserted: stmts.length, pruned });
}
const latestOps = async (env, kind) => {
  const r = await env.DB.prepare('SELECT ts, level, text, data_json FROM ops_log WHERE kind=? ORDER BY ts DESC, id DESC LIMIT 1').bind(kind).first();
  if (!r) return null;
  try { r.data = r.data_json ? JSON.parse(r.data_json) : null; } catch (e) { r.data = null; }
  delete r.data_json; return r;
};
// The D1 lines are in lib.js (d1Lines): free limits by default, the monthly included amounts on Workers Paid (LP_D1_PLAN = "paid"). The month so far
// is the last d1_usage report of each UTC day of this month, added up (at most 31 rows).
async function d1MonthRows(env, nowMs) {
  const start = new Date(nowMs).toISOString().slice(0, 8) + '01';
  const rows = (await env.DB.prepare("SELECT data_json FROM ops_log WHERE id IN (SELECT max(id) FROM ops_log WHERE kind='d1_usage' AND ts >= ? GROUP BY substr(ts, 1, 10))").bind(start).all()).results;
  return rows.map(r => { try { return JSON.parse(r.data_json); } catch (e) { return null; } }).filter(Boolean);
}
async function adminStatus(env, me, url, withLog) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : nyDay(me.nowMs);
  const kind = OPS_KINDS.includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : '';
  // Queue: live from the jobs table.
  const cnt = {}; (await env.DB.prepare('SELECT status, count(*) n FROM jobs GROUP BY status').all()).results.forEach(r => { cnt[r.status] = r.n; });
  const oldest = await env.DB.prepare("SELECT min(created_at) t FROM jobs WHERE status='queued'").first();
  const waitMin = oldest && oldest.t ? Math.round((me.nowMs - Date.parse(oldest.t)) / 60e3) : 0;
  const failed = (await env.DB.prepare("SELECT id, kind, attempts, error, updated_at FROM jobs WHERE status='failed' AND updated_at > ? ORDER BY updated_at DESC LIMIT 8").bind(new Date(me.nowMs - 7 * 864e5).toISOString()).all()).results
    .map(j => ({ id: j.id, kind: j.kind, attempts: j.attempts, at: j.updated_at, why: errorWords(j.error) }));
  const failed24 = failed.filter(j => Date.parse(j.at) > me.nowMs - 864e5).length;
  const expired = (await env.DB.prepare("SELECT count(*) n FROM jobs WHERE status='claimed' AND lease_until < ?").bind(me.now).first()).n;
  const qLevel = waitMin > 120 || failed24 >= 3 ? 'red' : waitMin > 30 || failed24 > 0 || expired > 0 ? 'amber' : 'green';
  const qReason = qLevel === 'green' ? `Queue is clear: ${cnt.queued || 0} waiting, ${cnt.claimed || 0} running.`
    : [waitMin > 30 ? `The oldest waiting job is ${waitMin} minutes old.` : '', failed24 ? `${failed24} job${failed24 === 1 ? '' : 's'} failed in the last 24 hours.` : '', expired ? `${expired} running job${expired === 1 ? ' has' : 's have'} lost its lease.` : ''].filter(Boolean).join(' ');
  const queue = { level: qLevel, reason: qReason, counts: { queued: cnt.queued || 0, claimed: cnt.claimed || 0, done: cnt.done || 0, failed: cnt.failed || 0 }, oldest_wait_min: waitMin, failed };
  // Worker runs: the last pushed run, and the cost lines from the health report.
  const health = await latestOps(env, 'health'), run = await latestOps(env, 'worker_run'), d1 = await latestOps(env, 'd1_usage');
  const hAge = health ? (me.nowMs - Date.parse(health.ts)) / 3600e3 : null;
  // The N100 sends each item flat: { name, level, reason, ...extra facts }. A nested "data" object is accepted too. The extra facts are the item's data.
  let items = health && health.data && Array.isArray(health.data.items) ? health.data.items.map(i => {
    const { name, level, reason, data, ...rest } = i || {};
    return { name: String(name).slice(0, 40), level: OPS_LEVELS.includes(level) ? level : 'amber', reason: scrubText(reason).slice(0, 200), data: data || (Object.keys(rest).length ? rest : undefined) };
  }) : [];
  if (health && !items.length) items = [{ name: 'n100_report', level: health.level, reason: `The health report came without its lines (too large or damaged). ${health.text}`.slice(0, 200) }];
  if (!health) items = [{ name: 'n100_report', level: 'red', reason: 'No health report has arrived from the N100 yet.' }];
  else if (hAge > 1) items.unshift({ name: 'n100_report', level: hAge > 3 ? 'red' : 'amber', reason: `The N100 health report is ${hAge.toFixed(1)} hours old. The collector may have stopped.` });
  const cost = items.find(i => i.name === 'research_cost');
  const costOut = cost ? { today_usd: cost.data && cost.data.today_usd, month_usd: cost.data && cost.data.month_usd, daily_cap_usd: cost.data && cost.data.daily_cap_usd } : null;
  const runItem = items.find(i => i.name === 'research_worker_run');
  const workerRuns = { level: worstOf([runItem ? runItem.level : 'amber', cost ? cost.level : 'green']), reason: runItem ? runItem.reason : 'No research worker line in the health report.',
    last_run: run ? { ts: run.ts, level: run.level, text: run.text, data: run.data } : null, cost: costOut };
  // Results: what research and door-card reads proposed (the work is in Needs confirming).
  const prop = await env.DB.prepare("SELECT (SELECT count(*) FROM vals WHERE status='proposed') v, (SELECT count(*) FROM photo_reads WHERE status='proposed') p").first();
  const recent = (await env.DB.prepare("SELECT id, kind, result_summary, updated_at FROM jobs WHERE status='done' AND result_summary IS NOT NULL ORDER BY updated_at DESC LIMIT 5").all()).results
    .map(j => ({ id: j.id, kind: j.kind, at: j.updated_at, summary: scrubText(j.result_summary).slice(0, 200) }));
  const results = { level: 'green', reason: `${prop.v} proposed value${prop.v === 1 ? '' : 's'} and ${prop.p} proposed VIN${prop.p === 1 ? '' : 's'} wait in Needs confirming.`, proposed_values: prop.v, proposed_vins: prop.p, recent };
  const paid = d1IsPaid(env.LP_D1_PLAN);
  const d1items = d1Lines(d1, me.nowMs, paid ? 'paid' : 'free', paid ? d1Month(await d1MonthRows(env, me.nowMs)) : {});
  const all = [queue.level, workerRuns.level, ...items.map(i => i.level), ...d1items.map(i => i.level)];   // worstOf ignores the grey "info" lines
  const out = { now: me.now, day, kind, overall: worstOf(all), queue, worker_runs: workerRuns, results, n100: { as_of: health ? health.ts : null, items }, d1: { as_of: d1 ? d1.ts : null, plan: paid ? 'paid' : 'free', items: d1items } };
  if (withLog) {
    const s = nyStart(day), e = nyStart(nyDay(s + 36 * 3600e3));
    out.log = (await env.DB.prepare(`SELECT id, ts, kind, level, text FROM ops_log WHERE ts >= ? AND ts < ? ${kind ? 'AND kind = ?' : "AND kind <> 'health'"} ORDER BY ts DESC, id DESC LIMIT 200`)
      .bind(...[new Date(s).toISOString(), new Date(e).toISOString(), ...(kind ? [kind] : [])]).all()).results;
    // On Workers Paid the D1 usage lines of the log are grey info too (the N100 writes them against the free limits for the Kuma alert).
    if (paid) out.log.forEach(l => { if (l.kind === 'd1_usage') l.level = 'info'; });
  }
  return out;
}

// How the VIN decode tells the fuel (the Oil tab and the service cart read vehicles.fuel).
function fuelOf(d) {
  const el = d.ElectrificationLevel || '', fp = d.FuelTypePrimary || '';
  if (/^BEV/i.test(el) || (/^electric$/i.test(fp.trim()) && !d.FuelTypeSecondary)) return 'ev';
  if (/plug-?in|^PHEV/i.test(el)) return 'phev';
  if (/hybrid|^(HEV|MHEV)/i.test(el)) return 'hybrid';
  if (/diesel/i.test(fp)) return 'diesel';
  if (/gasoline|e85|flex/i.test(fp)) return 'gas';
  return '';
}

// ---------- Door-jamb photo read (HANDOFF 17, B6-B7, B9) ----------
// The job request holds exactly these keys and nothing else (a test asserts it): the photo, and year, make, model and engine.
// The saved VIN is NOT in the request (Rick 2026-10-27): the Worker compares the VIN that was read with the saved VIN when the result arrives.
// The photo goes to Claude direct from the N100 script. Owner, notes, service text and other photos never go.
const PHOTO_RE = /^[0-9TZ-]+\.(?:jpg|png|webp)$/;
async function queueDoorcard(env, v, photo, me) {
  if (me.processor) return bad('The processor cannot start a photo read', 403);
  if (!PHOTO_RE.test(photo)) return bad('Need photo=<file name of a photo of this car>');
  if (!env.BUCKET) return bad('Photo storage is not set up (no R2 binding)', 404);
  if (!await env.BUCKET.head(`photos/${v.id}/${photo}`)) return bad('No such photo', 404);
  const open = await env.DB.prepare("SELECT id FROM jobs WHERE kind='read_doorcard' AND target=? AND status IN ('queued','claimed') AND json_extract(request, '$.photo')=? LIMIT 1").bind('car:' + v.id, photo).first();
  if (open) return json({ ok: true, id: open.id, already: true });
  const req = { car: v.id, photo, year: v.year, make: v.make, model: v.model, engine: v.engine || '' };
  const r = await env.DB.prepare('INSERT INTO jobs(kind, target, request, status, created_at, updated_at) VALUES(?,?,?,?,?,?) RETURNING id')
    .bind('read_doorcard', 'car:' + v.id, JSON.stringify(req), 'queued', me.now, me.now).first();
  return json({ ok: true, id: r.id }, 201);
}
// The result of a read_doorcard job: the values read from the photo become PROPOSED car-scope tire values (the door card is car scope),
// and a VIN becomes a photo_reads row (a proposal; it never replaces a saved VIN). Rick confirms both beside the photo.
async function doorcardResult(env, j, b, me) {
  const rq = JSON.parse(j.request), r = b.read;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('Need read: the values read from the photo');
  const v = await vehicleRow(env, rq.car);
  if (!v) return bad('Car not found', 404);
  const pr0 = parseDoorcardRead(r);   // lib.js: the one rule set; ops/read_doorcard.py mirrors it (ultrareview B #1)
  if (pr0.err) return bad(pr0.err);
  const { sf, sr, pf, pr, sp, spPsi } = pr0;
  const vin = r.vin ? String(r.vin).trim().toUpperCase() : null;
  if (vin && !VIN_SHAPE.test(vin)) return bad('A VIN has 17 letters and digits, with no I, O or Q');
  const day = me.now.slice(0, 10), source = `Door-jamb label photo, ${day} (read from photo)`, note = `photo ${rq.photo}`;
  const rows = [];
  if (pf !== null && pr !== null) rows.push(['Pressure', `${pf} / ${pr} psi`]);
  if (sf || sr) rows.push(['Size', sf && sr && sf !== sr ? `${sf} / ${sr}` : (sf || sr)]);
  if (sp.state === 'psi') rows.push(['Spare pressure', `${spPsi} psi`]);
  else if (sp.state === 'none') rows.push(['Spare pressure', 'none']);   // 'not_on_label' proposes nothing: it is not the same as none
  // Rick 2026-10-27: a read that EQUALS a confirmed car-scope value shows "matches" and creates no proposal; the same for a VIN equal to the saved VIN.
  // A read equal to a value that is still only proposed is not proposed twice.
  const stmts = [], matches = []; let proposed = 0;
  for (const [name, value] of rows) {
    const f = await fieldByName(env, 'tires', name);
    if (!f) return bad(`Unknown field "${name}" on tab "tires"`);
    const same = (await env.DB.prepare("SELECT status FROM vals WHERE field_id=? AND scope='car' AND vehicle_id=? AND value=? AND status<>'rejected'").bind(f.id, v.id, value).all()).results;
    if (same.some(s => s.status === 'confirmed')) { matches.push(name); continue; }
    if (same.length) continue;
    stmts.push(...insertValueStmts(env, { field_id: f.id, scope: 'car', vehicle_id: v.id, value, confidence: 'High', source, note, status: 'proposed' }, me));
    proposed++;
  }
  let vinNote = 'no VIN on this photo', vinState = 'none';
  if (vin) {
    const ok = vinCheckDigit(vin) ? 1 : 0;
    if (v.vin === vin) { vinNote = 'VIN matches the saved VIN'; vinState = 'matches'; }   // no proposal
    else {
      if (!await env.DB.prepare("SELECT 1 FROM photo_reads WHERE vehicle_id=? AND vin=? AND status IN ('proposed','confirmed') LIMIT 1").bind(v.id, vin).first())
        stmts.push(env.DB.prepare("INSERT INTO photo_reads(vehicle_id, photo, job_id, vin, vin_ok, status, created_at) VALUES(?,?,?,?,?,'proposed',?)").bind(v.id, rq.photo, j.id, vin, ok, me.now));
      vinNote = (v.vin ? 'VIN differs from the saved VIN' : 'VIN read') + (ok ? '' : ', check digit fails'); vinState = 'proposed';
    }
  }
  stmts.push(env.DB.prepare("UPDATE jobs SET status='done', result_summary=?, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed' AND claimed_by=?")
    .bind(`${proposed} proposed value(s)${matches.length ? '; matches the confirmed value: ' + matches.join(', ') : ''}; ${vinNote}`, me.now, j.id, me.token));
  await env.DB.batch(stmts);
  // Ultrareview B #10: the processor gets no "vin" word. "matches / differs / read" says something about the saved VIN, so it is stored in the
  // job summary (hidden from the processor in the car payload) and shown to Rick only. The tire counts stay (no VIN information).
  return json(me.processor ? { ok: true, proposed, matches } : { ok: true, proposed, matches, vin: vinState });
}
// A VIN proposal from a photo: confirm or reject (Rick only). A saved VIN is NEVER replaced: a proposal that differs from it cannot be
// confirmed. With no saved VIN the proposal fills it, if the check digit passes or Rick says it is not a US-market VIN.
async function decideVinProposal(env, id, action, b, me) {
  if (me.processor) return bad('The processor cannot confirm or reject a VIN', 403);   // like the value routes: the self-test tool may, so the live self-test can grade it
  const p = await env.DB.prepare('SELECT * FROM photo_reads WHERE id=?').bind(id).first();
  if (!p) return bad('No such VIN proposal', 404);
  if (p.status !== 'proposed') return bad('This VIN proposal is already decided', 409);
  const stmts = [];
  if (action === 'confirm') {
    const v = await vehicleRow(env, p.vehicle_id);
    if (!v) return bad('Car not found', 404);
    if (v.vin && v.vin !== p.vin) return bad('The car has a saved VIN that differs. A saved VIN is not replaced by a photo. Reject this proposal, or change the VIN by hand in Edit car.', 409);
    if (!v.vin) {
      if (!p.vin_ok && !(b.not_us === true || b.not_us === 1 || b.not_us === '1')) return json({ error: 'The VIN check digit fails. Save it only as a VIN that is not US-market.', check_failed: true }, 409);
      stmts.push(env.DB.prepare("UPDATE vehicles SET vin=? WHERE id=? AND (vin IS NULL OR vin='')").bind(p.vin, v.id));
    }
  }
  stmts.push(env.DB.prepare('UPDATE photo_reads SET status=?, decided_at=?, decided_by=? WHERE id=? AND status=\'proposed\'').bind(action === 'confirm' ? 'confirmed' : 'rejected', me.now, me.device, id));
  await env.DB.batch(stmts);
  return json({ ok: true });
}
// "No VIN" and "No door card" are computed, never stored. The door card counts when a confirmed car-scope tire value cites a placard.
async function badgeMap(env) {
  const placard = new Set((await env.DB.prepare("SELECT x.vehicle_id id, x.source FROM vals x JOIN fields f ON f.id = x.field_id JOIN tabs t ON t.id = f.tab_id WHERE t.name='tires' AND x.scope='car' AND x.status='confirmed'").all()).results
    .filter(r => PLACARD.test(r.source || '')).map(r => r.id));
  return placard;
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

// HANDOFF 17 (B0): D1's own count of rows written (meta.rows_written, indexes included) for the requests of the self-test tool token only.
// The count goes back in the header x-lp-rows-written, so a rehearsal or a self-test run can print and grade its real cost. Other callers
// (Rick's browser, the processor) use the plain database object and get no header.
function meterDb(db, acc) {
  const add = r => { if (r && r.meta && r.meta.rows_written) acc.w += r.meta.rows_written; return r; };
  const wrap = s => new Proxy(s, { get(t, k) {
    if (k === '__raw') return t;
    if (k === 'bind') return (...a) => wrap(t.bind(...a));
    if (k === 'run' || k === 'all') return async () => add(await t[k]());
    if (k === 'first') return async col => { const r = add(await t.all()), row = r.results[0]; return row === undefined ? null : (col ? row[col] : row); };
    return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
  } });
  return new Proxy(db, { get(t, k) {
    if (k === 'prepare') return q => wrap(t.prepare(q));
    if (k === 'batch') return async stmts => { const rs = await t.batch(stmts.map(s => s.__raw || s)); rs.forEach(add); return rs; };
    return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
  } });
}
const app = {
  async fetch(req, env) {
    const acc = { w: 0, on: false };
    const r = await app.handle(req, env, acc);
    if (!acc.on) return r;
    const h = new Headers(r.headers); h.set('x-lp-rows-written', String(acc.w));
    return new Response(r.body, { status: r.status, headers: h });
  },
  async handle(req, env, acc) {
    const url = new URL(req.url); const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      const me = await who(req, env);
      if (me.badJwt) return bad('The Access token could not be verified', 403);
      if (me.tool) { acc.on = true; env = { ...env, DB: meterDb(env.DB, acc) }; }
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
      // HANDOFF 18 (C1, C5): the ops log. The N100 pushes with the processor token; everything else under /api/admin/ is Rick's own login only.
      if (p === '/api/admin/log' && m === 'POST') {
        if (!me.processor) return bad('Only the processor token pushes the log', 403);
        return adminLogPush(env, await req.json().catch(() => ({})), me);
      }
      if (p.startsWith('/api/admin/')) {
        if (!rickOnly(me, env)) return bad('The Admin page is for Rick only', 403);
        if (p === '/api/admin/status' && m === 'GET') return json(await adminStatus(env, me, url, true));
        if (p === '/api/admin/dot' && m === 'GET') return json({ level: (await adminStatus(env, me, url, false)).overall });
        return bad('Not found', 404);
      }
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
        const year = parseInt(d.ModelYear, 10) || null, make = d.Make ? await canonMake(env, d.Make) : '';
        // HANDOFF 17 (B3): the decode first. fe = the one fueleconomy.gov option that matches the decode (variant, id, text), or null (the app shows the dropdown).
        let fe = null;
        // Ultrareview B #8: only the Add car decode asks (?fe=1). The car page decodes for the engine text and the EV flag alone, with no fueleconomy.gov calls.
        if (url.searchParams.get('fe') === '1' && year && make && d.Model && d.ErrorCode === '0') {
          try { fe = await feMatch(env, year, make, d.Model, { disp: d.DisplacementL, cyl: d.EngineCylinders, ev, drive: d.DriveType }); } catch (e) { fe = null; }
        }
        return json({ vin, year, make, model: d.Model || '', trim: [d.Trim, d.Series].filter(Boolean).join(' '),
          engine, fuel: d.FuelTypePrimary || '', fuel_class: fuelOf(d), electrification: d.ElectrificationLevel || '', ev, fe: fe ? { variant: fe.variant, id: +fe.value || null, text: fe.text } : null,
          check: vinCheckDigit(vin), error: d.ErrorCode !== '0' ? d.ErrorText : '' });
      }
      // HANDOFF 17 (B1, B2): the Add car lists. variants of a model, and the engine options of a variant, from fueleconomy.gov (cached in D1).
      if (p === '/api/fe' && m === 'GET') {
        const year = parseInt(url.searchParams.get('year'), 10), make = url.searchParams.get('make') || '', model = url.searchParams.get('model') || '', variant = url.searchParams.get('variant') || '';
        if (!make || !model || !yearOk(year)) return bad('Need year, make and model');
        if (year < 1984) return json({ variants: [], options: [], classic: true });
        const vs = await feMenu(env, year, make, '');
        const variants = feVariants(vs.items, model);
        const op = variant ? await feMenu(env, year, make, variant) : { items: [] };
        return json({ variants, options: variant ? op.items : [], error: vs.error || op.error || '', stale: !!(vs.stale || op.stale) });
      }
      if (p === '/api/trims' && m === 'GET') {
        const year = parseInt(url.searchParams.get('year'), 10), make = url.searchParams.get('make') || '', model = url.searchParams.get('model') || '';
        if (!make || !model || !yearOk(year)) return bad('Need year, make and model');
        return json({ trims: await trimNames(env, year, make, model) });
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
        // Ultrareview B #6: only a confirmed value of the same engine, or with no engine tag, is replaced (engineMatches, as the car page does).
        // A proposal with no engine tag is compared with untagged rows only, so it never shows another engine's value as the one it replaces.
        for (const x of results) {
          const cs = (await env.DB.prepare(`SELECT c.value, c.ftlb_lo, c.ftlb_hi, c.engine FROM vals c WHERE c.field_id=? AND c.status='confirmed' AND c.id<>? AND (
            (? = 'car' AND c.scope='car' AND c.vehicle_id=?) OR (? = 'model' AND c.scope='model' AND c.make=? AND c.model=? AND c.year_from<=? AND c.year_to>=?)) ORDER BY c.id`)
            .bind(x.field_id, x.id, x.scope, x.vehicle_id, x.scope, x.make, x.model, x.year_to, x.year_from).all()).results;
          const c = cs.find(r => x.engine ? (!r.engine || engineMatches(x.engine, r.engine)) : !r.engine);
          x.replaces = c ? (c.ftlb_lo != null ? `${c.ftlb_lo}${c.ftlb_hi != null ? '-' + c.ftlb_hi : ''} ft-lb` : c.value) : null;
        }
        // HANDOFF 17: VIN proposals read from a photo (never for the processor: it must not see a VIN) and the missing-data badges per car.
        if (me.processor) return json({ count: results.length, values: results });
        const vp = (await env.DB.prepare(`SELECT r.id, r.vehicle_id, r.photo, r.vin, r.vin_ok, r.created_at, v.year, v.make, v.model, v.vin saved FROM photo_reads r JOIN vehicles v ON v.id = r.vehicle_id
          WHERE r.status='proposed' ORDER BY r.id`).all()).results.map(({ saved, ...r }) => ({ ...r, car: `${r.year} ${r.make} ${r.model}`, saved_state: !saved ? 'none' : saved === r.vin ? 'matches' : 'differs' }));
        const placard = await badgeMap(env);
        const badges = (await env.DB.prepare("SELECT id, year, make, model, vin FROM vehicles ORDER BY make, model, year").all()).results
          .map(c => ({ vehicle_id: c.id, car: `${c.year} ${c.make} ${c.model}`, no_vin: !c.vin, no_doorcard: !placard.has(c.id) })).filter(c => c.no_vin || c.no_doorcard);
        return json({ count: results.length, values: results, vin_proposals: vp, badges });
      }
      if (p === '/api/vehicles' && m === 'GET') {
        // Storyboard T1: each tile has a status line - how many values there are, how many wait for a
        // confirm, and how many block values (warn = 2, an open problem) apply. Home shows only a block;
        // a caution (warn = 1, a standing step such as the air suspension) shows on the Lift tab (HANDOFF 10).
        const placard = await badgeMap(env);   // HANDOFF 17 (B10): "No VIN" and "No door card", computed, never stored
        const all = (await env.DB.prepare(`SELECT v.id, v.year, v.make, v.model, v.trim, v.grp, v.last_seen, v.owner, v.fuel, v.engine, (v.vin IS NULL OR v.vin = '') no_vin, strftime('%Y-%m-%dT%H:%M:%fZ', v.created) created_iso,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND ${CAR_VALS}) nvals,
          (SELECT count(*) FROM vals x WHERE x.status='proposed' AND ${CAR_VALS}) nproposed,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND x.warn=2 AND ${CAR_VALS}) nblock,
          (SELECT count(*) FROM vals x WHERE x.status<>'rejected' AND x.warn=1 AND ${CAR_VALS}) ncaution
          FROM vehicles v ORDER BY CASE v.grp WHEN 'mine' THEN 0 WHEN 'frequent' THEN 1 ELSE 2 END, v.make, v.model, v.year`).all()).results
          .map(v => ({ ...v, no_vin: !!v.no_vin, no_doorcard: !placard.has(v.id), hidden: hidden(v, me.nowMs), mine: v.grp === 'mine' ? 1 : 0 }));
        const tcs = await tagCounts(env, all);   // HANDOFF 17: the values tagged with an engine that matches the car's engine
        all.forEach(v => { const t = tcs.get(v.id); v.nvals += t.nvals; v.nproposed += t.nproposed; v.nblock += t.nblock; v.ncaution += t.ncaution; });
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
        // HANDOFF 17 (B2, B7): variant, engine, fe_id and fuel from the Add car lists; a VIN must pass the check digit unless Rick says not_us.
        const x = carExtras(b); if (x.err) return bad(x.err);
        const vin = String(b.vin || '').trim().toUpperCase();
        if (vin) { const ve = vinProblem(vin, b); if (ve) return ve; }
        const r = await env.DB.prepare('INSERT INTO vehicles(year, make, model, trim, vin, mine, grp, last_seen, variant, engine, fe_id, fuel) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
          .bind(year, b.make, b.model, b.trim || '', vin, grp === 'mine' ? 1 : 0, grp, me.now, x.variant ?? null, x.engine ?? null, x.fe_id ?? null, x.fuel ?? null).first();
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
        if (['owner', 'fuel', 'engine', 'variant', 'fe_id', 'hide_chart_cautions'].some(k => k in b) && !('grp' in b) && !('vin' in b) && !('trim' in b)) {
          if (me.processor) return bad('The processor cannot change these fields', 403);
          const set = {};
          if ('owner' in b) {
            const t = String(b.owner ?? '').trim();
            if (t.length > 60 || /[\u0000-\u001f]/.test(t)) return bad('owner has at most 60 characters and no control characters');
            set.owner = t || null;
          }
          // HANDOFF 17 (B4): engine, variant, fe_id and fuel from the list. Only Rick, one explicit save; nothing changes by itself.
          const ex = carExtras(b); if (ex.err) return bad(ex.err);
          Object.assign(set, ex);
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
          if (vin) { const ve = vinProblem(vin, b); if (ve) return ve; }   // HANDOFF 17 (B7): shape and check digit
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
          env.DB.prepare('DELETE FROM photo_reads WHERE vehicle_id=?').bind(+mm[1]),
          env.DB.prepare('DELETE FROM car_facts WHERE vehicle_id=?').bind(+mm[1]),   // HANDOFF 18: the cached recalls go with the car
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
        // HANDOFF 18 (C0.1): an R2 put can fail once ("put: internal error (10001)"). Try once more; if it fails again, say so in plain words.
        let stored = false;
        for (let i = 0; i < 2 && !stored; i++) {
          try { await env.BUCKET.put(key, body, { httpMetadata: { contentType: ct } }); stored = true; } catch (e) { stored = false; }
        }
        if (!stored) return bad('Upload failed - try again', 502);
        return json({ name, url: '/api/' + key, size: body.byteLength }, 201);
      }
      mm = p.match(/^\/api\/photos\/(\d+)\/([0-9TZ-]+\.(?:jpg|png|webp))$/);
      if (mm && (m === 'GET' || m === 'DELETE')) {
        // HANDOFF 17 (B9): the processor may GET one photo, only while a read_doorcard job for exactly that car and photo is claimed by its token.
        if (me.processor) {
          const own = m === 'GET' && await env.DB.prepare("SELECT 1 FROM jobs WHERE kind='read_doorcard' AND status='claimed' AND claimed_by=? AND lease_until>? AND json_extract(request, '$.car')=? AND json_extract(request, '$.photo')=? LIMIT 1")
            .bind(me.token, me.now, +mm[1], mm[2]).first();
          if (!own) return bad('Photos are not for the processor', 403);
        }
        if (!env.BUCKET) return bad('Photo storage is not set up (no R2 binding)', 404);
        const key = `photos/${mm[1]}/${mm[2]}`;
        if (m === 'DELETE') { await env.BUCKET.delete(key); return json({ ok: true }); }
        const o = await env.BUCKET.get(key); if (!o) return bad('No such photo', 404);
        return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', 'content-length': String(o.size), 'cache-control': 'private, max-age=604800' } });
      }
      if (p.startsWith('/api/photos/')) return bad('Not a photo address', 400);
      // HANDOFF 17 (B6): start the photo read for one photo of this car.
      mm = p.match(/^\/api\/vehicles\/(\d+)\/doorcard$/);
      if (mm && m === 'POST') {
        const v = await vehicleRow(env, +mm[1]); if (!v) return bad('Car not found', 404);
        return queueDoorcard(env, v, String((await req.json().catch(() => ({}))).photo || ''), me);
      }
      // HANDOFF 18 (C7, C8): refresh the recalls and the Canadian-specs weight of one car (at most once a day each); Rick confirms or types the weight.
      mm = p.match(/^\/api\/vehicles\/(\d+)\/facts$/);
      if (mm && m === 'POST') {
        const v = await vehicleRow(env, +mm[1]); if (!v) return bad('Car not found', 404);
        return json(await refreshFacts(env, v, me));
      }
      mm = p.match(/^\/api\/vehicles\/(\d+)\/weight$/);
      if (mm && m === 'POST') {
        const v = await vehicleRow(env, +mm[1]); if (!v) return bad('Car not found', 404);
        return curbDecision(env, v, await req.json().catch(() => ({})), me);
      }
      mm = p.match(/^\/api\/vin-proposals\/(\d+)\/(confirm|reject)$/);
      if (mm && m === 'POST') return decideVinProposal(env, +mm[1], mm[2], await req.json().catch(() => ({})), me);
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
      // HANDOFF 19: the self-test fails jobs on purpose and removes them again, so the Admin page shows no PROBLEM from test jobs. Only the self-test tool
      // token (never the processor, never a browser login) and only FAILED jobs whose error text starts with "selftest". The processor allowlist refuses it first.
      if (p === '/api/jobs/selftest' && m === 'DELETE') {
        if (!me.tool || me.processor) return bad('This route is for the self-test tool token only', 403);
        const gone = (await env.DB.prepare("DELETE FROM jobs WHERE status='failed' AND error LIKE 'selftest%' RETURNING id").all()).results;
        return json({ ok: true, removed: gone.length });
      }
      if (p.startsWith('/api/jobs/') && !me.processor) return bad('Processor only. This route needs the processor service token.', 403);
      if (p === '/api/jobs/claim' && m === 'POST') {
        const b = await req.json().catch(() => ({}));
        const j = await claimJob(env, me, parseInt(b.only_id, 10) || null, b.kinds);
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
export default app;
