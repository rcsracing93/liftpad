// LiftPad API. Static app in /public is served by Workers Assets; /api/* comes here.
// Cloudflare Access sits in front of the whole hostname, so this code does no auth of its own.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bad = (m, s = 400) => json({ error: m }, s);
const fold = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function score(name, q) {
  q = fold(q.trim()); if (!q) return 2; const n = fold(name);
  if (n.startsWith(q)) return 0;
  return n.split(/[\s\/\-()]+/).some(w => w.startsWith(q)) ? 1 : -1;
}
const yearOk = y => Number.isInteger(y) && y >= 1885 && y <= new Date().getFullYear() + 2;

async function makes(env, q) {
  const { results } = await env.DB.prepare('SELECT name, aliases FROM makes').all();
  const mine = new Set((await env.DB.prepare('SELECT DISTINCT make FROM vehicles WHERE mine=1').all()).results.map(r => r.make));
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
  const ali = await env.DB.prepare('SELECT model, chart, guide_page, pdf_page, status, year_from, year_to FROM ali_index WHERE make=? AND year_from<=? AND year_to>=?').bind(make, year, year).all();
  ali.results.forEach(r => add(r.model, { source: 'ALI', chart: { chart: r.chart, guide_page: r.guide_page, pdf_page: r.pdf_page, status: r.status, years: `${r.year_from}-${r.year_to}` } }));
  const cl = await env.DB.prepare('SELECT model, year_from, year_to, model_years FROM classics WHERE make=? AND (year_from IS NULL OR (year_from<=? AND year_to+(1-model_years)>=?))').bind(make, year, year).all();
  cl.results.forEach(r => add(r.model, { source: 'classics', unknown: r.year_from == null }));
  if (withNhtsa) (await nhtsaModels(env, make, year)).forEach(n => add(n, { source: 'NHTSA' }));
  return [...map.values()].map(o => ({ ...o, s: score(o.label, q || '') }))
    .filter(o => o.s >= 0 && !(o.unknown && !(q || '').trim()))
    .sort((a, b) => (!!a.unknown - !!b.unknown) || a.s - b.s || a.label.localeCompare(b.label))
    .map(({ s, ...o }) => o);
}

async function nearestChart(env, make, model, year) {
  const { results } = await env.DB.prepare('SELECT chart, guide_page, pdf_page, status, year_from, year_to FROM ali_index WHERE make=? AND model=?').bind(make, model).all();
  let best = null;
  for (const r of results) { const d = year < r.year_from ? r.year_from - year : year > r.year_to ? year - r.year_to : 0; if (!best || d < best.d) best = { ...r, d }; }
  return best;
}

async function vehicle(env, id) {
  const v = await env.DB.prepare('SELECT * FROM vehicles WHERE id=?').bind(id).first();
  if (!v) return null;
  v.specs = (await env.DB.prepare('SELECT id, tab, field, value, confidence, source, note, warn, updated FROM specs WHERE vehicle_id=? ORDER BY tab, warn DESC, id').bind(id).all()).results;
  v.ali = await nearestChart(env, v.make, v.model, v.year);
  return v;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url); const p = url.pathname; const m = req.method;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (p === '/api/health') { const n = await env.DB.prepare('SELECT (SELECT count(*) FROM ali_index) a, (SELECT count(*) FROM classics) c, (SELECT count(*) FROM vehicles) v, (SELECT count(*) FROM makes) m').first(); return json({ ok: true, ...n }); }
      if (p === '/api/makes' && m === 'GET') return json(await makes(env, url.searchParams.get('q') || ''));
      if (p === '/api/models' && m === 'GET') {
        const make = url.searchParams.get('make'); const year = parseInt(url.searchParams.get('year'), 10);
        if (!make || !yearOk(year)) return bad('Need make and a 4-digit year');
        return json(await models(env, make, year, url.searchParams.get('q') || '', url.searchParams.get('nhtsa') !== '0'));
      }
      if (p === '/api/vin' && m === 'GET') {
        const vin = (url.searchParams.get('vin') || '').trim().toUpperCase();
        if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return bad('A VIN has 17 letters and digits, with no I, O or Q');
        const r = await fetch(`${env.NHTSA}/DecodeVinValues/${vin}?format=json`); const d = (await r.json()).Results[0];
        return json({ vin, year: parseInt(d.ModelYear, 10) || null, make: d.Make ? d.Make[0] + d.Make.slice(1).toLowerCase() : '', model: d.Model || '', trim: [d.Trim, d.Series].filter(Boolean).join(' '), error: d.ErrorCode !== '0' ? d.ErrorText : '' });
      }
      if (p === '/api/vehicles' && m === 'GET') return json((await env.DB.prepare('SELECT id, year, make, model, trim, mine FROM vehicles ORDER BY mine DESC, make, model').all()).results);
      if (p === '/api/vehicles' && m === 'POST') {
        const b = await req.json(); const year = parseInt(b.year, 10);
        if (!b.make || !b.model || !yearOk(year)) return bad('Need year, make and model');
        const r = await env.DB.prepare('INSERT INTO vehicles(year, make, model, trim, vin, mine) VALUES(?,?,?,?,?,?) RETURNING id').bind(year, b.make, b.model, b.trim || '', b.vin || '', b.mine === false ? 0 : 1).first();
        return json(await vehicle(env, r.id), 201);
      }
      let mm = p.match(/^\/api\/vehicles\/(\d+)$/);
      if (mm && m === 'GET') { const v = await vehicle(env, +mm[1]); return v ? json(v) : bad('Car not found', 404); }
      if (mm && m === 'DELETE') { await env.DB.prepare('DELETE FROM specs WHERE vehicle_id=?').bind(+mm[1]).run(); await env.DB.prepare('DELETE FROM vehicles WHERE id=?').bind(+mm[1]).run(); return json({ ok: true }); }
      mm = p.match(/^\/api\/vehicles\/(\d+)\/specs$/);
      if (mm && m === 'POST') {
        const b = await req.json();
        if (!['lift', 'torque', 'tires'].includes(b.tab) || !b.field || !b.value || !['High', 'Medium', 'Low'].includes(b.confidence)) return bad('Need tab, field, value and confidence');
        await env.DB.prepare('INSERT INTO specs(vehicle_id, tab, field, value, confidence, source, note, warn) VALUES(?,?,?,?,?,?,?,?)').bind(+mm[1], b.tab, b.field, b.value, b.confidence, b.source || '', b.note || '', b.warn ? 1 : 0).run();
        return json(await vehicle(env, +mm[1]), 201);
      }
      mm = p.match(/^\/api\/specs\/(\d+)$/);
      if (mm && m === 'PATCH') {
        const b = await req.json(); const f = ['field', 'value', 'confidence', 'source', 'note'].filter(k => k in b);
        if (!f.length) return bad('Nothing to change');
        if (b.confidence && !['High', 'Medium', 'Low'].includes(b.confidence)) return bad('Confidence must be High, Medium or Low');
        await env.DB.prepare(`UPDATE specs SET ${f.map(k => k + '=?').join(', ')}, updated=datetime('now') WHERE id=?`).bind(...f.map(k => b[k]), +mm[1]).run();
        return json({ ok: true });
      }
      if (mm && m === 'DELETE') { await env.DB.prepare('DELETE FROM specs WHERE id=?').bind(+mm[1]).run(); return json({ ok: true }); }
      return bad('Not found', 404);
    } catch (e) { return bad('Server error: ' + e.message, 500); }
  }
};
