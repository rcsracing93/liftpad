// LiftPad self-test. Usage: node test/selftest.js <base-url> [report-file]
// Live (behind Cloudflare Access): CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET = the self-test
//   service token; LP_PROC_ID / LP_PROC_SECRET = the processor service token.
// Local (wrangler dev, no Access): LP_LOCAL_JWT=1. The test makes its own RSA key, serves it at
//   http://127.0.0.1:8788/certs and signs Access-style JWTs for three callers: the self-test tool
//   (common_name selftest-id), the processor (processor-id) and a phone (an email). Start the Worker
//   with LP_ACCESS_CERTS=http://127.0.0.1:8788/certs LP_ACCESS_AUD=local-test-aud
//   LP_PROCESSOR_IDS=processor-id LP_TOOL_IDS=selftest-id.
// Optional: LP_PRIVATE_TESTS=<path to a .mjs file> adds checks for your own data (see README).
// Classics checks are skipped when the database has no classics rows (a public-seed build).
// Makes one temporary visitor car, its values and two jobs, and removes or closes them again.
// Exit code 0 = no check failed.
import { writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer, get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { generateKeyPairSync, createSign } from 'node:crypto';
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const LOCAL = process.env.LP_LOCAL_JWT === '1';
const res = []; const cleanup = [];
async function t(name, fn) { try { const m = await fn(); res.push({ name, ok: true, m: m || '' }); } catch (e) { res.push({ name, ok: false, m: e.message }); } }
const skip = (name, why) => res.push({ name, skip: true, m: why });
const ok = (c, m) => { if (!c) throw new Error(m); };

// ---------- callers ----------
let sign = null, srv = null;
if (LOCAL) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-1', alg: 'RS256', use: 'sig' };
  srv = createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(ok2 => srv.listen(8788, '127.0.0.1', ok2));
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;   // a key the Worker does not know
  sign = (claims, key = privateKey) => { const h = b64({ alg: 'RS256', kid: 'local-1', typ: 'JWT' }), p = b64({ aud: ['local-test-aud'], exp: Math.floor(Date.now() / 1000) + 600, ...claims });
    const s = createSign('RSA-SHA256').update(h + '.' + p).sign(key).toString('base64url'); return `${h}.${p}.${s}`; };
  sign.other = other;
}
const hdr = as => {
  const h = { 'content-type': 'application/json', 'x-lp-device': 'selftest' };
  if (LOCAL) {
    const c = { tool: { common_name: 'selftest-id' }, proc: { common_name: 'processor-id' }, phone: { email: 'owner@example.com' } }[as];
    if (c) h['cf-access-jwt-assertion'] = sign(c);
    // Known-bad samples for the JWT check (STANDARD 6.9): processor claims, but a wrong signature or an old token.
    if (as === 'forged') h['cf-access-jwt-assertion'] = sign({ common_name: 'processor-id' }, sign.other);
    if (as === 'expired') h['cf-access-jwt-assertion'] = sign({ common_name: 'processor-id', exp: Math.floor(Date.now() / 1000) - 60 });
  } else if (as === 'proc') { h['CF-Access-Client-Id'] = process.env.LP_PROC_ID; h['CF-Access-Client-Secret'] = process.env.LP_PROC_SECRET; }
  else if (process.env.CF_ACCESS_CLIENT_ID) { h['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID; h['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET; }
  return h;
};
const call = async (p, o = {}) => {
  const h = hdr(o.as || 'tool'); if (o.now) h['x-lp-now'] = o.now;
  const r = await fetch(BASE + p, { method: o.method || 'GET', headers: h, body: o.body ? JSON.stringify(o.body) : undefined });
  let d; try { d = await r.json(); } catch { d = null; } return { s: r.status, d };
};
const plus = (ms) => new Date(Date.now() + ms).toISOString();
const MIN = 60e3, DAY = 864e5;
const hasProc = LOCAL || (process.env.LP_PROC_ID && process.env.LP_PROC_SECRET);

const PRIV = process.env.LP_PRIVATE_TESTS;
if (PRIV && !existsSync(PRIV)) { console.error('LP_PRIVATE_TESTS file not found: ' + PRIV); process.exit(2); }
const priv = PRIV ? await import(pathToFileURL(PRIV).href) : null;

// ---------- basics ----------
let health = {};
await t('health: API answers', async () => {
  const { s, d } = await call('/api/health'); ok(s === 200 && d && d.ok === true && d.m >= 1, JSON.stringify(d)); health = d;
  const min = priv?.minCounts; if (min) ok(d.a >= min.a && d.c >= min.c && d.v >= min.v, 'below minCounts ' + JSON.stringify(min) + ': ' + JSON.stringify(d));
  return `lift-guide rows ${d.a}, classics ${d.c}, cars ${d.v}, makes ${d.m}, values ${d.vals} (${d.proposed} proposed), open jobs ${d.jobs}, schema ${d.schema}`;
});
await t('schema is at migration 0003 or later', async () => { ok(String(health.schema) >= '0003', 'schema ' + health.schema); });
await t('app page loads', async () => { const r = await fetch(BASE + '/', { headers: hdr('tool') }); const x = await r.text(); ok(r.status === 200 && x.includes('LiftPad'), 'status ' + r.status); });
// Handoff 3 step 0 (Rick, phone, 2026-10-16): a browser navigation to an /api/ address must reach the
// Worker and get JSON, not the app's index.html. Headers as a browser sends them for a typed address.
// Sent with node:http(s), not fetch: Node fetch replaces Sec-Fetch-Mode with "cors" (FIX 2026-10-16).
const rawGet = (url, headers) => new Promise((done, fail) => {
  (url.startsWith('https:') ? httpsGet : httpGet)(url, { headers }, r => { let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c); r.on('end', () => done({ s: r.statusCode, ct: r.headers['content-type'] || '', x: b })); }).on('error', fail);
});
await t('a browser navigation to /api/whoami gets JSON, not the app page', async () => {
  const h = { ...hdr('tool'), accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none', 'upgrade-insecure-requests': '1' };
  delete h['content-type'];
  const { s, ct, x } = await rawGet(BASE + '/api/whoami', h);
  ok(s === 200 && ct.startsWith('application/json') && !x.includes('<html'), `status ${s}, ${ct}, starts ${JSON.stringify(x.slice(0, 40))}`);
  ok(JSON.parse(x).tool === true, 'not the whoami answer: ' + x.slice(0, 80));
});
await t('make "stu" -> Studebaker', async () => { const { d } = await call('/api/makes?q=stu'); ok(d[0]?.name === 'Studebaker', JSON.stringify(d)); });
await t('make "ame" -> AMC (alias)', async () => { const { d } = await call('/api/makes?q=ame'); ok(d.some(m => m.name === 'AMC'), JSON.stringify(d)); });
await t('make "citroen" -> Citroën', async () => { const { d } = await call('/api/makes?q=citroen'); ok(d.some(m => m.name === 'Citroën'), JSON.stringify(d)); });
await t('make "ram" -> Ram first', async () => { const { d } = await call('/api/makes?q=ram'); ok(d[0]?.name === 'Ram', JSON.stringify(d)); });
await t('empty query lists my makes first', async () => {
  const mine = new Set((await call('/api/vehicles')).d.filter(c => c.mine).map(c => c.make)); const k = Math.min(mine.size, 3); if (!k) return 'no cars marked mine - nothing to order';
  const { d } = await call('/api/makes?q='); ok(d.slice(0, k).every(m => m.mine), JSON.stringify(d.slice(0, k + 1))); return `first ${k} are mine`;
});
const CL = 'no classics rows in this database';
if (health.c > 0) {
  await t('Dodge 1972: no Torino', async () => { const { d } = await call('/api/models?make=Dodge&year=1972&nhtsa=0'); ok(!d.some(m => /torino/i.test(m.label)), d.map(m => m.label).join(',')); return `${d.length} models`; });
  await t('AMC 1973 has Hornet and Javelin', async () => { const { d } = await call('/api/models?make=AMC&year=1973&nhtsa=0'); const n = d.map(m => m.label); ok(n.includes('Hornet') && n.includes('Javelin'), n.join(',')); });
  await t('Studebaker 1960 has Lark', async () => { const { d } = await call('/api/models?make=Studebaker&year=1960&nhtsa=0'); ok(d.some(m => m.label === 'Lark'), d.map(m => m.label).join(',')); });
  await t('years-unknown models hidden until typed', async () => { const a = (await call('/api/models?make=MG&year=1970&nhtsa=0')).d; const b = (await call('/api/models?make=MG&year=1970&nhtsa=0&q=tf')).d; ok(!a.some(m => m.unknown), 'unknown shown'); return `${a.length} shown, typed "tf": ${b.map(m => m.label).join(',')}`; });
} else ['Dodge 1972: no Torino', 'AMC 1973 has Hornet and Javelin', 'Studebaker 1960 has Lark', 'years-unknown models hidden until typed'].forEach(n => skip(n, CL));
await t('bad year rejected', async () => { const { s } = await call('/api/models?make=Ford&year=19'); ok(s === 400, 'status ' + s); });
await t('bad VIN rejected', async () => { const { s, d } = await call('/api/vin?vin=ABC'); ok(s === 400 && /17/.test(d.error), JSON.stringify(d)); });
await t('tabs and fields come from the database', async () => { const { d } = await call('/api/tabs'); ok(['lift', 'torque', 'tires'].every(n => d.tabs.some(t2 => t2.name === n)) && d.fields.some(f => f.tab === 'torque' && f.name === 'Torque' && f.is_safety), JSON.stringify(d.tabs)); return `${d.tabs.length} tabs, ${d.fields.length} fields`; });
// ---------- Apps screen (HANDOFF 6) ----------
let apps = [];
await t('apps: /api/apps answers with http(s) tiles, sorted by sort then name', async () => {
  const { s, d } = await call('/api/apps'); ok(s === 200 && Array.isArray(d), `status ${s}: ${JSON.stringify(d)}`); apps = d;
  ok(d.every(a => a.name && /^https?:\/\//.test(a.url) && Number.isInteger(a.sort)), JSON.stringify(d));
  ok(d.every((a, i) => !i || d[i - 1].sort < a.sort || (d[i - 1].sort === a.sort && d[i - 1].name.localeCompare(a.name) <= 0)), 'not sorted: ' + d.map(a => a.name).join(', '));
  return `${d.length} app(s)`;
});
// Your own rows come from LP_PRIVATE_TESTS (export const apps = [{ name, url }]); a public-seed
// build (no classics rows) has the sample row.
const wantApps = priv?.apps || (health.c > 0 ? null : [{ name: 'Sample app', url: 'https://example.com' }]);
if (wantApps) await t('apps: the expected tiles are there with their exact address', async () => {
  const miss = wantApps.filter(w => !apps.some(a => a.name === w.name && a.url === w.url)); ok(!miss.length, 'missing: ' + miss.map(w => w.name).join(', ')); return wantApps.map(w => w.name).join(', ');
});
else skip('apps: the expected tiles are there with their exact address', 'no LP_PRIVATE_TESTS apps list and not a public-seed build');
if (hasProc) await t('apps: not for the processor (403)', async () => { const { s } = await call('/api/apps', { as: 'proc' }); ok(s === 403, 'status ' + s); });
else skip('apps: not for the processor (403)', 'no processor token');
await t('app page has the Apps button in the header', async () => {
  const x = await (await fetch(BASE + '/', { headers: hdr('tool') })).text();
  ok(/<header>[\s\S]*<a class="btn appsbtn" id="appsbtn" href="#\/apps">[\s\S]*Apps<\/a><\/header>/.test(x), 'no Apps button in the header of index.html');
});
// ---------- ALI page images (Handoff 3 step 1, decisions 3 and 4) ----------
const pages = (await call('/api/ali/pages')).d || [];
const okPages = Array.isArray(pages) ? pages.filter(x => x.status === 'ok') : [];
const pageUrl = x => `/api/ali/${x.edition}/p${String(x.pdf_page).padStart(3, '0')}.jpg`;
if (okPages.length) {
  await t('every listed page image is in R2 with the listed size (HEAD)', async () => {
    const bad2 = [];
    for (const x of okPages) { const r = await fetch(BASE + pageUrl(x), { method: 'HEAD', headers: hdr('tool') }); if (r.status !== 200 || +r.headers.get('content-length') !== x.bytes) bad2.push(`${pageUrl(x)}: ${r.status} ${r.headers.get('content-length')}`); }
    ok(!bad2.length, bad2.slice(0, 5).join('; '));
    const miss = pages.filter(x => x.status === 'missing_from_scan').map(x => x.guide_page);
    return `${okPages.length} pages, ${okPages.reduce((s, x) => s + x.bytes, 0)} bytes; guide pages missing from the scan: ${miss.join(', ') || 'none'}`;
  });
  await t('a page image is a JPEG with a private cache header and the listed size', async () => {
    const x = okPages[0]; const r = await fetch(BASE + pageUrl(x), { headers: hdr('tool') }); const b = new Uint8Array(await r.arrayBuffer());
    ok(r.status === 200 && r.headers.get('content-type') === 'image/jpeg' && /private/.test(r.headers.get('cache-control') || ''), `status ${r.status}, ${r.headers.get('content-type')}, ${r.headers.get('cache-control')}`);
    ok(b.length === x.bytes && b[0] === 0xFF && b[1] === 0xD8, `length ${b.length}, starts ${b[0]} ${b[1]}`);
  });
  await t('a car with a chart page gets its image address, newest edition first', async () => {
    const cars = (await call('/api/vehicles')).d; let n = 0;
    for (const c of cars) {
      const v = (await call(`/api/vehicles/${c.id}?peek=1`)).d; if (!v.ali || v.ali.d !== 0) continue;
      const pg = okPages.find(x => x.edition === v.ali.edition && x.pdf_page === v.ali.pdf_page);
      ok(v.ali.img === (pg ? pageUrl(pg) : null), `${v.make} ${v.model}: img ${v.ali.img}, page ${JSON.stringify(pg)}`);
      const ch = ((await call(`/api/models?make=${encodeURIComponent(v.make)}&year=${v.year}&nhtsa=0`)).d.find(m => m.label === v.model) || {}).charts || [];
      const eds = ch.map(x => x.edition); ok(eds.every((e, i) => !i || eds[i - 1] >= e), `${v.model} charts not newest first: ${eds}`);
      ok(v.ali.edition === eds[0], `${v.model}: card uses edition ${v.ali.edition}, newest is ${eds[0]}`); n++;
    }
    return `${n} car(s) checked`;
  });
  // Chart boxes (decision 6). A box Rick drew is never changed: the write checks run only on a
  // chart with no box, and remove their box again.
  let boxCar = null;
  for (const c of (await call('/api/vehicles')).d) { const v = (await call(`/api/vehicles/${c.id}?peek=1`)).d; if (v.ali && v.ali.img) { boxCar = v; break; } }
  if (boxCar && !boxCar.ali.box) {
    const A = boxCar.ali, key = { edition: A.edition, chart: A.chart, pdf_page: A.pdf_page };
    await t('chart box: drawn once, shown on the car, cleared again', async () => {
      const r = await call('/api/ali/boxes', { method: 'PUT', body: { ...key, x: 0.5, y: 0.25, w: 0.4, h: 0.3 } }); cleanup.push(['box', key]);
      ok(r.s === 200, 'put ' + r.s + ' ' + JSON.stringify(r.d));
      const b = (await call(`/api/vehicles/${boxCar.id}?peek=1`)).d.ali.box; ok(b && b.x === 0.5 && b.y === 0.25 && b.w === 0.4 && b.h === 0.3, JSON.stringify(b));
      ok((await call(`/api/ali/boxes?edition=${encodeURIComponent(A.edition)}&chart=${encodeURIComponent(A.chart)}`, { method: 'DELETE' })).s === 200, 'delete');
      ok((await call(`/api/vehicles/${boxCar.id}?peek=1`)).d.ali.box === null, 'box still there');
      return `${A.edition} ${boxCar.make} ${boxCar.model}`;
    });
  } else skip('chart box: drawn once, shown on the car, cleared again', boxCar ? 'the first chart page already has a box (not changed)' : 'no car with a chart page');
  await t('a bad chart box is refused; the processor cannot draw one', async () => {
    const A = boxCar ? boxCar.ali : { edition: '2019', chart: 'X', pdf_page: 1 };
    const key = { edition: A.edition, chart: A.chart, pdf_page: A.pdf_page };
    const out = (await call('/api/ali/boxes', { method: 'PUT', body: { ...key, x: 0.8, y: 0.1, w: 0.4, h: 0.3 } })).s;
    const none = (await call('/api/ali/boxes', { method: 'PUT', body: { ...key, chart: 'NO-SUCH', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).s;
    const proc = hasProc ? (await call('/api/ali/boxes', { as: 'proc', method: 'PUT', body: { ...key, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).s : 403;
    ok(out === 400 && none === 404 && proc === 403, `outside the page ${out}, unknown chart ${none}, processor ${proc}`);
  });
} else ['every listed page image is in R2 with the listed size (HEAD)', 'a page image is a JPEG with a private cache header and the listed size', 'a car with a chart page gets its image address, newest edition first',
  'chart box: drawn once, shown on the car, cleared again', 'a bad chart box is refused; the processor cannot draw one'].forEach(n => skip(n, 'no page images in ali_pages'));
await t('a bad page address is refused, a missing page is 404', async () => {
  const a = await fetch(BASE + '/api/ali/2019/p1.jpg', { headers: hdr('tool') }); const b = await fetch(BASE + '/api/ali/2019/p999.jpg', { headers: hdr('tool') });
  ok(a.status === 400 && b.status === 404, `p1.jpg ${a.status}, p999.jpg ${b.status}`);
});
// ---------- Oil tab (Handoff 3 step 3, decision 7) ----------
await t('the Oil tab has Oil type, Quantity (qt) and Filter', async () => {
  const { d } = await call('/api/tabs'); const f = d.fields.filter(x => x.tab === 'oil').map(x => x.name + (x.unit ? ` (${x.unit})` : ''));
  ok(d.tabs.some(x => x.name === 'oil' && x.label === 'Oil') && ['Oil type', 'Quantity (qt)', 'Filter'].every(n => f.includes(n)), JSON.stringify(f));
  return f.join(', ');
});
// A public sample VIN (NHTSA's own API example, a 2013 Ford F-150): it goes to NHTSA only.
await t('VIN decode gives fuel type and the EV flag (gas car: no EV)', async () => {
  const { s, d } = await call('/api/vin?vin=1FTFW1CT5DFC10312');
  if (s >= 500) return 'NHTSA not reachable: ' + JSON.stringify(d).slice(0, 80);
  ok(s === 200 && d.ev === false && /gasoline/i.test(d.fuel) && typeof d.engine === 'string', JSON.stringify(d)); return `${d.year} ${d.make} ${d.model}, ${d.fuel}, ${d.engine}`;
});
// ---------- Lookup links (Handoff 3 step 5, decision 8): the built address only - never fetched ----------
await t('lookup links: the built K&N and RockAuto addresses for the 5 sample cars (not fetched)', async () => {
  const KN = 'https://www.knfilters.com/oil-filters/', RA = 'https://www.rockauto.com/en/catalog/';
  const cars = [
    [{ year: 2018, make: 'Honda', model: 'Civic', engine: '2.0L 4 cyl' }, KN + 'honda/civic/2.0l-l4-gas/2018', RA + 'honda,2018,civic'],
    [{ year: 2021, make: 'Jeep', model: 'Grand Cherokee', engine: '5.7L 8 cyl' }, KN + 'jeep/grand-cherokee/5.7l-v8-gas/2021', RA + 'jeep,2021,grand+cherokee'],
    [{ year: 2007, make: 'Ford', model: 'Mustang', engine: '4.6L 8 cyl' }, KN + 'ford/mustang/4.6l-v8-gas/2007', RA + 'ford,2007,mustang'],
    [{ year: 2025, make: 'BMW', model: 'i4', engine: '', ev: 1 }, null, RA + 'bmw,2025,i4'],
    [{ year: 1973, make: 'AMC', model: 'Hornet', engine: '' }, KN + 'american-motors/hornet', RA + 'amc,1973,hornet']];
  const bad2 = [];
  for (const [c, kn, ra] of cars) {
    const { s, d } = await call('/api/links?' + new URLSearchParams({ ...c, ev: c.ev ? '1' : '0' }));
    if (s !== 200) { bad2.push(`${c.make}: status ${s}`); continue; }
    const k = d.find(l => l.label.startsWith('K&N')), r = d.find(l => l.label.startsWith('RockAuto'));
    if ((k ? k.url : null) !== kn) bad2.push(`${c.make} K&N ${k && k.url}`);
    if (!r || r.url !== ra) bad2.push(`${c.make} RockAuto ${r && r.url}`);
    if (c.ev && d.some(l => l.tabs.includes('oil'))) bad2.push(`${c.make}: oil links for an EV`);
  }
  const ford = (await call('/api/links?year=2021&make=Ford&model=Mustang')).d.find(l => l.label.startsWith('Ford owner manual'));
  const old = (await call('/api/links?year=2007&make=Ford&model=Mustang')).d.find(l => l.label.startsWith('Ford owner manual'));
  if (!ford || ford.url !== 'https://www.ford.com/support/vehicle/mustang/2021/owner-manuals/' || old) bad2.push(`Ford manual 2021 ${ford && ford.url}, 2007 ${old && old.url}`);
  // Rick's tap check (LINKS-RESULTS 2026-10-17): new patterns, fixed addresses, patterns first, no NHTSA link.
  const hc = (await call('/api/links?year=2018&make=Honda&model=Civic&engine=2.0L+4+cyl')).d;
  const want = { 'tirepressure.com': 'https://tirepressure.com/honda-civic-tire-pressure', 'Wheel-Size (thread, torque, bolt pattern)': 'https://www.wheel-size.com/size/honda/civic/',
    'Wix filter finder': 'https://www.wixfilters.com/en-us/filter-finder.html', 'Purolator part finder': 'https://www.purolatornow.com/en/part-finder.html',
    'Mobil 1 oil filters': 'https://www.mobil.com/en/lubricants/for-personal-vehicles/our-products/oil-filters', 'Honda owner manuals (MyGarage)': 'https://mygarage.honda.com/s/find-honda' };
  for (const [label, url] of Object.entries(want)) { const l = hc.find(x => x.label === label); if (!l || l.url !== url) bad2.push(`${label}: ${l && l.url}`); }
  const jp = (await call('/api/links?year=2021&make=Jeep&model=Grand+Cherokee')).d.find(x => x.label === 'tirepressure.com');
  if (!jp || jp.url !== 'https://tirepressure.com/jeep-grand-cherokee-tire-pressure' || !/not yet checked/.test(jp.note)) bad2.push(`Jeep tirepressure ${jp && jp.url} ${jp && jp.note}`);
  for (const [c] of cars) { const d = (await call('/api/links?' + new URLSearchParams({ ...c, ev: c.ev ? '1' : '0' }))).d;
    const firstFixed = d.findIndex(x => x.kind !== 'pattern'); if (firstFixed >= 0 && d.slice(firstFixed).some(x => x.kind === 'pattern')) bad2.push(`${c.make}: a pattern link after a fixed one`);
    if (d.some(x => /nhtsa\.gov/.test(x.url))) bad2.push(`${c.make}: the NHTSA link is still there`); }
  ok(!bad2.length, bad2.join('; '));
  return '5 cars, 10 K&N/RockAuto addresses, Ford manual 2013+ only, 7 addresses from Rick\'s check, patterns first';
});
if (priv) await priv.default({ t, call, ok });

// ---------- identity (decision 6, 7) ----------
await t('whoami: self-test token is a tool, not the processor', async () => { const { d } = await call('/api/whoami'); ok(d.tool === true && d.processor === false, JSON.stringify(d)); });
if (hasProc) await t('whoami: processor token is the processor', async () => { const { d } = await call('/api/whoami', { as: 'proc' }); ok(d.processor === true && d.device === 'processor', JSON.stringify(d)); });
else skip('whoami: processor token is the processor', 'no processor token given');
if (LOCAL) {
  await t('whoami: a phone session is not the processor', async () => { const { d } = await call('/api/whoami', { as: 'phone' }); ok(d.processor === false && d.tool === false && d.email === 'owner@example.com', JSON.stringify(d)); });
  await t('a phone cannot set the test clock', async () => { const { d } = await call('/api/whoami', { as: 'phone', now: '2001-01-01T00:00:00.000Z' }); ok(!d.now.startsWith('2001'), d.now); });
} else ['whoami: a phone session is not the processor', 'a phone cannot set the test clock'].forEach(n => skip(n, 'live: no phone session in a script - check /api/whoami on the phone (README)'));

// ---------- a temporary visitor car ----------
let car, valId, val2;
await t('add a visitor car (temp)', async () => {
  const r = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet', trim: 'SELFTEST', grp: 'visitor' } });
  ok(r.s === 201 && r.d.grp === 'visitor', 'create ' + r.s + ' ' + JSON.stringify(r.d)); car = r.d.id; cleanup.push(['car', car]);
});

// ---------- status flow and history (decisions 2, 3) ----------
await t('a new value is proposed, with one insert history row', async () => {
  const r = await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'torque', field: 'Torque', value: '75 ft-lb', confidence: 'Low', source: 'selftest' } });
  ok(r.s === 201, 'add ' + r.s + ' ' + JSON.stringify(r.d)); const v = r.d.values.find(x => x.source === 'selftest' && x.field === 'Torque');
  ok(v && v.status === 'proposed' && v.scope === 'model' && v.year_from === 1973 && v.entered_by === 'selftest', JSON.stringify(v)); valId = v.id; cleanup.push(['val', valId]);
  const h = (await call(`/api/values/${valId}/history`)).d; ok(h.length === 1 && h[0].action === 'insert' && h[0].new_status === 'proposed' && h[0].device === 'selftest', JSON.stringify(h));
});
await t('the processor cannot confirm a value', async () => { if (!hasProc) return 'no processor token'; const { s } = await call(`/api/values/${valId}/confirm`, { as: 'proc', method: 'POST', body: {} }); ok(s === 403, 'status ' + s); });
await t('confirm: status confirmed, confirmed_at and confirmed_by set, history row', async () => {
  ok((await call(`/api/values/${valId}/confirm`, { method: 'POST', body: {} })).s === 200, 'confirm');
  const v = (await call(`/api/vehicles/${car}?peek=1`)).d.values.find(x => x.id === valId);
  ok(v.status === 'confirmed' && v.confirmed_at && v.confirmed_by === 'selftest', JSON.stringify(v));
  const h = (await call(`/api/values/${valId}/history`)).d; ok(h.length === 2 && h[1].action === 'confirm' && h[1].old_status === 'proposed' && h[1].new_status === 'confirmed', JSON.stringify(h));
});
await t('edit: history keeps old and new value', async () => {
  ok((await call(`/api/values/${valId}`, { method: 'PATCH', body: { value: '80 ft-lb' } })).s === 200, 'patch');
  const h = (await call(`/api/values/${valId}/history`)).d; const l = h[h.length - 1];
  ok(h.length === 3 && l.action === 'update' && l.old_value === '75 ft-lb' && l.new_value === '80 ft-lb', JSON.stringify(l));
});
await t('bad input refused: confidence, tab, empty value', async () => {
  ok((await call(`/api/values/${valId}`, { method: 'PATCH', body: { confidence: 'Sure' } })).s === 400, 'bad confidence accepted');
  ok((await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'paint', field: 'x', value: 'y', confidence: 'Low' } })).s === 400, 'bad tab accepted');
  ok((await call(`/api/values/${valId}`, { method: 'PATCH', body: { value: '' } })).s === 400, 'empty value accepted');
});
await t('reject: hidden from the car, kept with history', async () => {
  const r = await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'torque', field: 'Socket', value: '99 mm', confidence: 'Low', source: 'selftest' } });
  val2 = r.d.values.find(x => x.field === 'Socket' && x.source === 'selftest').id; cleanup.push(['val', val2]);
  ok((await call(`/api/values/${val2}/reject`, { method: 'POST', body: {} })).s === 200, 'reject');
  ok(!(await call(`/api/vehicles/${car}?peek=1`)).d.values.some(x => x.id === val2), 'rejected value still shown');
  const h = (await call(`/api/values/${val2}/history`)).d; ok(h[h.length - 1].action === 'reject' && h[h.length - 1].new_status === 'rejected', JSON.stringify(h));
});
// Live fault 2026-10-17: a deleted value's id was given to the next new value, which then showed the
// old value's history. A new value must get a new id and a history of exactly one row.
await t('delete a value, add one: the new value has a new id and one history row', async () => {
  const add = async v => (await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'torque', field: 'Socket', value: v, confidence: 'Low', source: 'selftest' } })).d.values.find(x => x.value === v).id;
  const a = await add('98 mm'); cleanup.push(['val', a]);
  ok((await call(`/api/values/${a}`, { method: 'DELETE' })).s === 200, 'delete');
  const b = await add('97 mm'); cleanup.push(['val', b]);
  ok(b > a, `new id ${b} is not above the deleted id ${a}`);
  const h = (await call(`/api/values/${b}/history`)).d; ok(h.length === 1 && h[0].action === 'insert', JSON.stringify(h));
  return `deleted ${a}, new ${b}`;
});
// Decision 10: door-jamb photos in the private bucket, never for the processor. A plain grey test
// JPEG (not a real photo), removed again.
const GREY = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//wAALCAAsACIBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AKwAAAAAAAAAH//Z', 'base64');
const raw = (p, o = {}) => { const h = hdr(o.as || 'tool'); h['content-type'] = o.type || 'image/jpeg'; return fetch(BASE + p, { method: o.method || 'GET', headers: h, body: o.body }); };
await t('door-jamb photo: stored in the private bucket, listed, read back the same, deleted', async () => {
  const r = await raw(`/api/vehicles/${car}/photos`, { method: 'POST', body: GREY }); const d = await r.json();
  ok(r.status === 201 && /^\d{4}-\d\d-\d\dT[\d-]+Z\.jpg$/.test(d.name) && d.url === `/api/photos/${car}/${d.name}`, r.status + ' ' + JSON.stringify(d));
  cleanup.push(['photo', d.url]);
  const l = (await call(`/api/vehicles/${car}/photos`)).d; ok(l.some(x => x.name === d.name), 'not listed: ' + JSON.stringify(l));
  const g = await raw(d.url); const b = Buffer.from(await g.arrayBuffer());
  ok(g.status === 200 && g.headers.get('content-type') === 'image/jpeg' && b.equals(GREY), `get ${g.status} ${g.headers.get('content-type')} ${b.length} bytes`);
  ok((await call(d.url, { method: 'DELETE' })).s === 200 && (await raw(d.url)).status === 404, 'not deleted');
  return d.name;
});
await t('photos: the processor can neither store nor read one; a non-image is refused', async () => {
  const pp = hasProc ? (await raw(`/api/vehicles/${car}/photos`, { as: 'proc', method: 'POST', body: GREY })).status : 403;
  const pg = hasProc ? (await raw(`/api/vehicles/${car}/photos`, { as: 'proc' })).status : 403;
  const txt = (await raw(`/api/vehicles/${car}/photos`, { method: 'POST', type: 'text/plain', body: 'not a photo' })).status;
  ok(pp === 403 && pg === 403 && txt === 400, `processor store ${pp}, list ${pg}; text ${txt}`);
});
// Decision 11: the VIN is saved on the car, checked, and never given to the processor.
await t('VIN: a bad VIN is refused, a good one is saved; the processor never sees it', async () => {
  ok((await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { vin: 'ABCDEFGHIJKLMNOPQ' } })).s === 400, 'a VIN with I and O was accepted');
  ok((await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { vin: '1ftfw1ct5dfc10312' } })).s === 200, 'save');
  ok((await call(`/api/vehicles/${car}?peek=1`)).d.vin === '1FTFW1CT5DFC10312', 'not saved in capitals');
  if (hasProc) { const pv = (await call(`/api/vehicles/${car}?peek=1`, { as: 'proc' })).d; ok(pv && !('vin' in pv), 'the processor got the VIN'); }
  ok((await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { vin: '' } })).s === 200, 'clear');
});
// Decision 9: the make's typical value and the thread range; a torque outside the range is flagged.
if (health.defaults > 0 && health.ranges > 0) {
  await t('the car gets the typical value for its make and the range for that thread', async () => {
    const T = (await call(`/api/vehicles/${car}?peek=1`)).d.typical;
    ok(T && T.make && T.make.make === 'AMC' && T.make.confidence === 'Low' && T.range && T.range.thread === T.make.thread && T.thread_from === 'make', JSON.stringify(T));
    return `${T.make.thread}, ~${T.make.torque_ftlb} ft-lb (${T.make.edition}); range ${T.range.torque_min}-${T.range.torque_max}`;
  });
  await t('a torque outside the thread range is flagged, one inside is not (car and needs-confirming)', async () => {
    const r = await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'torque', field: 'Torque', value: '500 ft-lb', confidence: 'Low', source: 'selftest' } });
    const hi = r.d.values.find(x => x.value === '500 ft-lb'); cleanup.push(['val', hi.id]);
    const mid = r.d.values.find(x => x.id === valId);
    ok(hi.range_flag === 'outside' && mid && mid.range_flag === 'inside', `500: ${hi.range_flag}, ${mid && mid.value}: ${mid && mid.range_flag}`);
    const n = (await call('/api/needs-confirming')).d.values.find(x => x.id === hi.id); ok(n && n.range_flag === 'outside', JSON.stringify(n));
  });
} else ['the car gets the typical value for its make and the range for that thread', 'a torque outside the thread range is flagged, one inside is not (car and needs-confirming)'].forEach(n => skip(n, 'no make_defaults or thread_ranges rows'));
await t('needs-confirming counts proposed values', async () => { const { d } = await call('/api/needs-confirming'); ok(typeof d.count === 'number' && d.values.every(x => x.status === 'proposed'), JSON.stringify(d).slice(0, 200)); return `${d.count} proposed`; });

// ---------- research queue (decision 6) ----------
let job, job2;
await t('queue a research job: request holds only make, model, year, trim, fields', async () => {
  const r = await call('/api/jobs', { method: 'POST', body: { vehicle_id: car, kind: 'research', fields: [{ tab: 'tires', field: 'Size' }] } }); ok(r.s === 201, 'queue ' + r.s); job = r.d.id;
});
await t('processor route refused without the processor token', async () => {
  ok((await call('/api/jobs/claim', { method: 'POST', body: { only_id: job } })).s === 403, 'self-test token was allowed to claim');
  if (LOCAL) {
    for (const as of ['phone', 'none', 'forged', 'expired']) ok((await call('/api/jobs/claim', { as, method: 'POST', body: { only_id: job } })).s === 403, as + ' allowed');
    return 'self-test token, phone, no JWT, forged JWT, expired JWT: 403';
  }
  return 'self-test token: 403';
});
if (hasProc) {
  let lease;
  await t('claim: 10-minute lease, request is private', async () => {
    const { s, d } = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: job } }); ok(s === 200 && d.id === job, JSON.stringify(d));
    const mins = (Date.parse(d.lease_until) - Date.now()) / MIN; ok(mins > 9 && mins <= 10.1, 'lease ' + d.lease_until); lease = d.lease_until;
    ok(Object.keys(d.request).sort().join(',') === 'fields,make,model,trim,year' && d.request.make === 'AMC' && d.request.year === 1973, JSON.stringify(d.request));
  });
  await t('a claimed job is not handed out again while its lease runs', async () => { const { d } = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: job } }); ok(d.none === true, JSON.stringify(d)); });
  await t('lease expiry: after 10 minutes (test clock) the job is claimed again', async () => {
    const { d } = await call('/api/jobs/claim', { as: 'proc', now: plus(11 * MIN), method: 'POST', body: { only_id: job } }); ok(d.id === job && d.attempts === 2 && d.lease_until > lease, JSON.stringify(d));
  });
  await t('result: values come back proposed, with history, job done', async () => {
    const r = await call(`/api/jobs/${job}/result`, { as: 'proc', method: 'POST', body: { values: [{ tab: 'tires', field: 'Size', value: 'E78-14 (selftest)', confidence: 'Low', source: 'selftest research' }] } });
    ok(r.s === 200 && r.d.proposed === 1, 'result ' + r.s + ' ' + JSON.stringify(r.d));
    const v = (await call(`/api/vehicles/${car}?peek=1`)).d; const x = v.values.find(y => y.field === 'Size' && y.source === 'selftest research');
    ok(x && x.status === 'proposed' && x.entered_by === 'processor', JSON.stringify(x)); cleanup.push(['val', x.id]);
    ok(v.jobs.find(j => j.id === job)?.status === 'done', JSON.stringify(v.jobs));
    const h = (await call(`/api/values/${x.id}/history`)).d; ok(h.length === 1 && h[0].device === 'processor', JSON.stringify(h));
  });
  await t('a result for a job that is not claimed is refused', async () => { const r = await call(`/api/jobs/${job}/result`, { as: 'proc', method: 'POST', body: { values: [] } }); ok(r.s === 409, 'status ' + r.s); });
  await t('fail: a claimed job can be marked failed', async () => {
    job2 = (await call('/api/jobs', { method: 'POST', body: { vehicle_id: car, kind: 'research', fields: [{ tab: 'tires', field: 'Pressure' }] } })).d.id;
    ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: job2 } })).d.id === job2, 'claim');
    ok((await call(`/api/jobs/${job2}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest' } })).s === 200, 'fail');
    ok((await call(`/api/vehicles/${car}?peek=1`)).d.jobs.find(j => j.id === job2)?.status === 'failed', 'not failed');
  });
} else ['claim: 10-minute lease, request is private', 'a claimed job is not handed out again while its lease runs', 'lease expiry: after 10 minutes (test clock) the job is claimed again',
  'result: values come back proposed, with history, job done', 'a result for a job that is not claimed is refused', 'fail: a claimed job can be marked failed'].forEach(n => skip(n, 'no processor token given'));

// ---------- groups and visitor hiding (decisions 4, 5) ----------
await t('opening a car sets last_seen; a visitor hides after 30 days (test clock)', async () => {
  const t0 = new Date().toISOString();
  await call(`/api/vehicles/${car}`, { now: t0 });
  const at = async (ms, q = '') => (await call('/api/vehicles' + q, { now: new Date(Date.parse(t0) + ms).toISOString() })).d.find(c => c.id === car);
  ok(await at(29 * DAY), 'hidden at 29 days'); ok(!(await at(31 * DAY)), 'still shown at 31 days');
  const h = await at(31 * DAY, '?hidden=1'); ok(h && h.hidden === true, 'not in the "show hidden" list');
});
await t('Frequent queues a workup job for the missing fields', async () => {
  const r = await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { grp: 'frequent' } }); ok(r.s === 200 && r.d.workup_job, JSON.stringify(r.d));
  const w = (await call(`/api/vehicles/${car}?peek=1`)).d; ok(w.grp === 'frequent' && w.jobs.some(j => j.id === r.d.workup_job && j.kind === 'workup'), JSON.stringify(w.jobs));
  if (hasProc) { ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: r.d.workup_job } })).d.id === r.d.workup_job, 'claim workup');
    ok((await call(`/api/jobs/${r.d.workup_job}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } })).s === 200, 'close workup'); }
});
await t('a frequent car is never hidden', async () => { const c = (await call('/api/vehicles', { now: plus(400 * DAY) })).d.find(x => x.id === car); ok(c && !c.hidden, 'hidden'); });

// ---------- cleanup ----------
// Every step runs and every problem is listed, so one failed step (a network error, or no value id
// because the value check failed) never leaves the temp car on live (it did on 2026-10-22, car 5).
await t('cleanup: temp values (history kept) and temp car removed', async () => {
  const bad2 = [], chk = (c, m) => { if (!c) bad2.push(m); };
  const tc = async (p, o) => { try { return await call(p, o); } catch (e) { return { s: 'network error: ' + e.message, d: null }; } };
  for (const [k, id] of cleanup.reverse()) if (k === 'val') { const s = (await tc(`/api/values/${id}`, { method: 'DELETE' })).s; chk(s === 200 || s === 404, 'delete value ' + s); }
    else if (k === 'photo') { const s = (await tc(id, { method: 'DELETE' })).s; chk(s === 200, 'delete test photo ' + s); }
    else if (k === 'box') { const s = (await tc(`/api/ali/boxes?edition=${encodeURIComponent(id.edition)}&chart=${encodeURIComponent(id.chart)}`, { method: 'DELETE' })).s; chk(s === 200, 'delete test box ' + s); }
  if (valId) { const h = (await tc(`/api/values/${valId}/history`)).d; chk(Array.isArray(h) && h.length && h[h.length - 1].action === 'delete', 'no delete history row'); }
  else chk(false, 'no value id (the value check failed): history not checked');
  if (car) { const s = (await tc('/api/vehicles/' + car, { method: 'DELETE' })).s; chk(s === 200, 'delete car ' + s); chk((await tc('/api/vehicles/' + car)).s === 404, 'car still there'); }
  ok(!bad2.length, bad2.join('; '));
});
if (srv) srv.close();

const pass = res.filter(r => r.ok).length, skipped = res.filter(r => r.skip).length, fail = res.length - pass - skipped;
const rep = `# LiftPad self-test\n\nTarget: ${BASE}\nTime: ${new Date().toISOString()}\nMode: ${LOCAL ? 'local (self-signed JWTs)' : 'live (service tokens)'}\nPrivate checks: ${priv ? 'yes' : 'no'}\nResult: ${pass}/${res.length - skipped} passed, ${skipped} skipped, ${fail} failed\n\n` +
  res.map(r => `- ${r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.m ? ' - ' + r.m : ''}`).join('\n') + '\n';
console.log(rep); if (process.argv[3]) writeFileSync(process.argv[3], rep);
process.exit(fail === 0 ? 0 : 1);
