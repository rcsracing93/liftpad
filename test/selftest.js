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
// HANDOFF 17: a fake fueleconomy.gov for the local run (run_selftest_local.sh starts the Worker with FE=http://127.0.0.1:8789/fe). It serves
// SAVED answers from the 2026-10-26 probe, the three shapes (list, one object, null), and counts the requests so the D1 cache can be graded.
const FE_HITS = { n: 0 }, RC_HITS = { n: 0 }, CAN_HITS = { n: 0 };
let feSrv = null;
if (LOCAL) {
  const MENUS = {
    'model|2021|Jeep': { menuItem: [{ text: 'Grand Cherokee 2WD', value: 'Grand Cherokee 2WD' }, { text: 'Grand Cherokee 4WD', value: 'Grand Cherokee 4WD' }, { text: 'Wrangler', value: 'Wrangler' }] },
    'options|2021|Jeep|Grand Cherokee 4WD': { menuItem: [{ text: 'Auto 8-spd, 6 cyl, 3.6 L', value: '43167' }, { text: 'Auto 8-spd, 8 cyl, 5.7 L', value: '43168' }] },
    'options|2021|Jeep|Grand Cherokee 2WD': { menuItem: { text: 'Auto 8-spd, 6 cyl, 3.6 L', value: '43160' } },
    // Ultrareview B #8: Ford 2013 is not asked by any other check, so the first request for it is graded (the NHTSA example VIN is a 2013 Ford F-150).
    'model|2013|Ford': { menuItem: [{ text: 'F-150 2WD', value: 'F-150 2WD' }] },
    'options|2013|Ford|F-150 2WD': { menuItem: { text: 'Auto 6-spd, 6 cyl, 3.5 L', value: '33000' } },
    'model|2025|BMW': { menuItem: [{ text: 'i4 eDrive40 Gran Coupe', value: 'a' }] },
    'options|2025|BMW|i4 eDrive40 Gran Coupe': { menuItem: { text: 'Auto (A1)', value: '48308' } },
  };
  feSrv = createServer((q, r) => {
    const u = new URL(q.url, 'http://x'), g = k => u.searchParams.get(k);
    // Ultrareview B #8 (2026-10-28): a fake NHTSA decode, so the VIN checks run without the network (the container may be offline). It answers the
    // VIN decode with the public example vehicle (a 2013 Ford F-150, 3.5 L, 6 cyl); every other NHTSA path answers 503 ("NHTSA down", as the tests expect).
    // HANDOFF 18: the recalls (RECALLS=.../recalls) and the Canadian-specs weight. recallsByVehicle answers by model name (the saved shapes of the
    // 2026-10-28 probe: campaigns with V and E numbers, dates as dd/mm/yyyy); an unknown model is 400, as NHTSA does for the i4. RC_HITS counts the asks.
    if (u.pathname.startsWith('/recalls/')) {
      RC_HITS.n++; r.setHeader('content-type', 'application/json');
      const m = (g('model') || '').toLowerCase();
      const rec = (n, d, e) => ({ NHTSACampaignNumber: n, ReportReceivedDate: d, Component: 'FUEL SYSTEM: PUMP', Summary: 'The fuel pump may fail.', Consequence: 'Stall.', Remedy: 'Free replacement.', ...e });
      if (m === 'f-150') { r.end(JSON.stringify({ Count: 3, results: [rec('20V314000', '28/05/2020'), rec('18V421000', '20/06/2018'), rec('19E012000', '01/01/2019')] })); return; }
      if (m === 'hornet b') { r.end(JSON.stringify({ Count: 1, results: [rec('73V001000', '02/02/1973')] })); return; }
      r.statusCode = 400; r.end(JSON.stringify({ message: 'Bad request' })); return;
    }
    if (u.pathname.startsWith('/nhtsa/GetCanadianVehicleSpecifications')) {
      CAN_HITS.n++; r.setHeader('content-type', 'application/json');
      if ((g('Model') || '') !== 'Hornet B') { r.statusCode = 503; r.end('{}'); return; }
      const row = (name, cw, wd) => ({ Specs: [{ Name: 'Model', Value: name }, { Name: 'CW', Value: cw }, { Name: 'WD', Value: wd }] });
      r.end(JSON.stringify({ Count: 2, Results: [row('HORNET 2DR SEDAN', '1100', '55/45'), row('HORNET SELFTEST B 2DR', '1250', '56/44')] }));
      return;
    }
    if (u.pathname.startsWith('/nhtsa/')) {
      r.setHeader('content-type', 'application/json');
      if (!u.pathname.startsWith('/nhtsa/DecodeVinValues/')) { r.statusCode = 503; r.end('{}'); return; }
      if (u.pathname.split('/').pop().startsWith('9')) { r.statusCode = 500; r.end('{}'); return; }   // a VIN decode that fails (the recalls fall back to the car's own names)
      r.end(JSON.stringify({ Results: [{ Make: 'FORD', Model: 'F-150', ModelYear: '2013', Trim: 'XLT', Series: '', DisplacementL: '3.5', EngineCylinders: '6', EngineModel: '', FuelTypePrimary: 'Gasoline', FuelTypeSecondary: '', ElectrificationLevel: '', DriveType: '4x4', ErrorCode: '0', ErrorText: '' }] }));
      return;
    }
    FE_HITS.n++;
    const key = u.pathname.endsWith('/menu/model') ? `model|${g('year')}|${g('make')}` : `options|${g('year')}|${g('make')}|${g('model')}`;
    r.setHeader('content-type', 'application/json');
    if (g('make') === 'Failmake') { r.statusCode = 503; r.end('{}'); return; }
    r.end(JSON.stringify(MENUS[key] ?? null));   // no result = null
  });
  await new Promise(ok2 => feSrv.listen(8789, '127.0.0.1', ok2));
}
const hdr = as => {
  const h = { 'content-type': 'application/json', 'x-lp-device': 'selftest' };
  if (LOCAL) {
    const c = { tool: { common_name: 'selftest-id' }, proc: { common_name: 'processor-id' }, phone: { email: 'owner@example.com' }, other: { email: 'someone-else@example.com' }, phonecase: { email: 'OWNER@Example.com' } }[as];
    if (c) h['cf-access-jwt-assertion'] = sign(c);
    // Known-bad samples for the JWT check (STANDARD 6.9): processor claims, but a wrong signature or an old token.
    if (as === 'forged') h['cf-access-jwt-assertion'] = sign({ common_name: 'processor-id' }, sign.other);
    if (as === 'expired') h['cf-access-jwt-assertion'] = sign({ common_name: 'processor-id', exp: Math.floor(Date.now() / 1000) - 60 });
  } else if (as === 'proc') { h['CF-Access-Client-Id'] = process.env.LP_PROC_ID; h['CF-Access-Client-Secret'] = process.env.LP_PROC_SECRET; }
  else if (process.env.CF_ACCESS_CLIENT_ID) { h['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID; h['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET; }
  return h;
};
// A GET that fails with a network error (no HTTP answer: ECONNRESET, "fetch failed") is tried again, up to 2 more times. After the
// burst of page-image requests the review host reset connections (2026-10-27). A write is never retried (it could run twice), and an
// HTTP error answer is never retried (it is graded).
const getRetry = async (url, init) => { for (let i = 0; ; i++) { try { return await fetch(url, init); } catch (e) { if (i >= 2) throw e; await new Promise(z => setTimeout(z, 1500)); } } };
// HANDOFF 17 (B0): D1's rows_written (meta, indexes included) for every request of the tool token; the Worker sends it in x-lp-rows-written.
const ROWS = { n: 0, seen: 0 };
const call = async (p, o = {}) => {
  const h = hdr(o.as || 'tool'); if (o.now) h['x-lp-now'] = o.now;
  const init = { method: o.method || 'GET', headers: h, body: o.body ? JSON.stringify(o.body) : undefined };
  // A DELETE is retried too (2026-10-27, live run 3): it can run twice safely, and a lost delete left a temp car on live.
  // A PUT is retried too (live run 4): the only PUT is the chart box, which writes the same row again.
  const r = ['GET', 'DELETE', 'PUT'].includes(init.method) ? await getRetry(BASE + p, init) : await fetch(BASE + p, init);
  const rw = r.headers.get('x-lp-rows-written'); if (rw !== null && Number.isFinite(+rw)) { ROWS.n += +rw; ROWS.seen++; }
  let d; try { d = await r.json(); } catch { d = null; } return { s: r.status, d };
};
const plus = (ms) => new Date(Date.now() + ms).toISOString();
const MIN = 60e3, DAY = 864e5;
const hasProc = LOCAL || (process.env.LP_PROC_ID && process.env.LP_PROC_SECRET);

const PRIV = process.env.LP_PRIVATE_TESTS;
if (PRIV && !existsSync(PRIV)) { console.error('LP_PRIVATE_TESTS file not found: ' + PRIV); process.exit(2); }
const priv = PRIV ? await import(pathToFileURL(PRIV).href) : null;

// 2026-10-27 (live run 3): a temp car whose create answer was lost (network error) has no id in the test, so its own cleanup cannot find
// it; it stayed on live and broke a later check. Every car whose trim starts with SELFTEST is a temp car of this test (all checks use that
// trim), so the sweep removes them: at the start (a leftover of an earlier run) and at the end.
const sweep = async () => {
  const l = (await call('/api/vehicles?hidden=1')).d, left = Array.isArray(l) ? l.filter(c => /^SELFTEST/.test(c.trim || '')) : [], bad = [];
  for (const c of left) { const s = (await call('/api/vehicles/' + c.id, { method: 'DELETE' }).catch(() => ({ s: 'net' }))).s; if (s !== 200 && s !== 404) bad.push(`car ${c.id}: ${s}`); }
  const after = (await call('/api/vehicles?hidden=1')).d;
  return { n: left.length, bad, still: Array.isArray(after) ? after.filter(c => /^SELFTEST/.test(c.trim || '')).length : -1 };
};
// Live run 4: a temp-car POST lost its answer (network error, no HTTP status). The car may exist then, so a second POST could make a
// second car. postCar looks first for the car by its trim and model (both unique to the caller), and posts again only when it is not there.
const postCar = async body => {
  try { return await call('/api/vehicles', { method: 'POST', body }); } catch (e) { /* no answer: look before posting again */ }
  await new Promise(z => setTimeout(z, 1500));
  const l = (await call('/api/vehicles?hidden=1')).d, c = Array.isArray(l) && l.find(x => x.trim === body.trim && x.model === body.model);
  if (c) { const v = await call(`/api/vehicles/${c.id}?peek=1`); return { s: 201, d: v.d }; }
  return call('/api/vehicles', { method: 'POST', body });
};
await t('sweep before the run: no SELFTEST car is left from an earlier run', async () => { const r = await sweep(); ok(!r.bad.length && r.still === 0, `${r.bad.join('; ')} still ${r.still}`); return `${r.n} removed`; });

// ---------- basics ----------
let health = {};
await t('health: API answers', async () => {
  const { s, d } = await call('/api/health?full=1'); ok(s === 200 && d && d.ok === true && d.full === true && d.m >= 1, JSON.stringify(d)); health = d;
  const min = priv?.minCounts; if (min) ok(d.a >= min.a && d.c >= min.c && d.v >= min.v, 'below minCounts ' + JSON.stringify(min) + ': ' + JSON.stringify(d));
  return `lift-guide rows ${d.a}, classics ${d.c}, cars ${d.v}, makes ${d.m}, values ${d.vals} (${d.proposed} proposed), open jobs ${d.jobs}, schema ${d.schema}`;
});
// Ultrareview F11 (D1 read quota): the 15-minute ping (no ?full) reads under 5 rows and holds no count; ?full=1 has every count.
await t('ultrareview F11: light /api/health reads under 5 rows and has no counts; ?full=1 has all counts', async () => {
  const { s, d } = await call('/api/health');
  ok(s === 200 && d && d.ok === true && /^\d{4}$/.test(String(d.schema)) && d.full === false, 'light answer: ' + s + ' ' + JSON.stringify(d));
  ok(!['a', 'c', 'v', 'm', 'vals', 'proposed', 'jobs', 'pages', 'defaults', 'ranges'].some(k => k in d), 'light answer has a count: ' + JSON.stringify(d));
  ok(typeof d.rows_read === 'number', 'NOT MEASURED: D1 gave no rows_read: ' + JSON.stringify(d.rows_read));
  ok(d.rows_read < 5, 'light rows_read ' + d.rows_read);
  const f = ['a', 'c', 'v', 'm', 'vals', 'proposed', 'jobs', 'pages', 'defaults', 'ranges', 'schema'].filter(k => !(k in health)); ok(!f.length, 'full answer misses ' + f);
  return `light rows_read ${d.rows_read}, full rows_read ${health.rows_read}`;
});
// Ultrareview 2 #9: a make typed or decoded in other letter case is stored as the makes table spells it (value lookups compare with =).
await t('ultrareview 2 #9: a car added as "HONDA" is stored with the make as the makes table spells it', async () => {
  const mk = ((await call('/api/makes?q=hon')).d || []).find(m => m.name.toLowerCase() === 'honda');
  ok(mk, 'NOT CHECKED: no Honda row in the makes table');
  const r = await call('/api/vehicles', { method: 'POST', body: { year: 2015, make: 'HONDA', model: 'Civic', trim: 'SELFTEST MAKE', grp: 'visitor' } });
  if (r.d && r.d.id) await call('/api/vehicles/' + r.d.id, { method: 'DELETE' });
  ok(r.s === 201 && r.d.make === mk.name, `stored make ${JSON.stringify(r.d && r.d.make)}, makes table ${mk.name}`); return 'HONDA -> ' + r.d.make;
});
// Ultrareview 2 #1: a token the Worker cannot verify (wrong signature, expired) is refused on every route, not let in as an ordinary caller.
if (LOCAL) await t('ultrareview 2 #1: an unverifiable Access token gets 403 on every route (fail closed)', async () => {
  const bad = [];
  for (const as of ['forged', 'expired']) for (const [m, p] of [['GET', '/api/vehicles'], ['GET', '/api/whoami'], ['GET', '/api/tabs'], ['POST', '/api/vehicles']]) {
    const s = (await call(p, { as, method: m, body: m === 'POST' ? { year: 1973, make: 'AMC', model: 'Hornet', trim: 'SELFTEST JWT' } : undefined })).s;
    if (s !== 403) bad.push(`${as} ${m} ${p}: ${s}`);
  }
  ok(!bad.length, bad.join('; ')); return '8 calls refused';
});
else skip('ultrareview 2 #1: an unverifiable Access token gets 403 on every route (fail closed)', 'live: the test cannot sign a token');
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
    // Live run 4 (2026-10-27): the burst of page requests from the N100 got connection resets. A HEAD is retried after a network error
    // (no HTTP answer), the requests are 50 ms apart, and the check waits 3 s after the burst before the next checks.
    for (const x of okPages) { const r = await getRetry(BASE + pageUrl(x), { method: 'HEAD', headers: hdr('tool') }); if (r.status !== 200 || +r.headers.get('content-length') !== x.bytes) bad2.push(`${pageUrl(x)}: ${r.status} ${r.headers.get('content-length')}`); await new Promise(z => setTimeout(z, 50)); }
    await new Promise(z => setTimeout(z, 3000));
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
      if (/^SELFTEST/.test(c.trim || '')) continue;   // a temp car of another check (its model may be written in other case on purpose)
      const v = (await call(`/api/vehicles/${c.id}?peek=1`)).d; if (!v.ali || v.ali.d !== 0) continue;
      const pg = okPages.find(x => x.edition === v.ali.edition && x.pdf_page === v.ali.pdf_page);
      ok(v.ali.img === (pg ? pageUrl(pg) : null), `${v.make} ${v.model}: img ${v.ali.img}, page ${JSON.stringify(pg)}`);
      const ch = ((await call(`/api/models?make=${encodeURIComponent(v.make)}&year=${v.year}&nhtsa=0`)).d.find(m => m.label === v.model) || {}).charts || [];
      const eds = ch.map(x => x.edition); ok(eds.every((e, i) => !i || eds[i - 1] >= e), `${v.model} charts not newest first: ${eds}`);
      ok(v.ali.edition === eds[0], `${v.model}: card uses edition ${v.ali.edition}, newest is ${eds[0]}`); n++;
    }
    return `${n} car(s) checked`;
  });
  // HANDOFF 9: the guides spell some names in another case (CT200H in 2019, CT200h in 2026), so the chart
  // lookup ignores case. Two temp visitor cars (UPPER and lower case model) must get the same chart as a
  // car that has one. Each temp car is deleted again, also when a check fails.
  await t('chart lookup ignores case: the model in UPPER or lower case gets the same chart', async () => {
    let src = null;
    for (const c of (await call('/api/vehicles')).d) { const v = (await call(`/api/vehicles/${c.id}?peek=1`)).d; if (v.ali && v.ali.d === 0) { src = v; break; } }
    ok(src, 'no car with a chart to copy');
    let id = null; const bad2 = [];
    try {
      for (const model of [src.model.toUpperCase(), src.model.toLowerCase()]) {
        const r = await postCar({ year: src.year, make: src.make, model, trim: 'SELFTEST CASE', grp: 'visitor' });
        if (r.s !== 201) { bad2.push(`${model}: create ${r.s}`); continue; }
        id = r.d.id; const a = r.d.ali, w = src.ali;
        if (!a || a.chart !== w.chart || a.edition !== w.edition || a.pdf_page !== w.pdf_page) bad2.push(`${model}: ${JSON.stringify(a)}, wanted ${w.edition} ${w.chart} p${w.pdf_page}`);
        const d = await call('/api/vehicles/' + id, { method: 'DELETE' }); if (d.s !== 200) bad2.push(`${model}: delete ${d.s}`); else id = null;
      }
    } finally { if (id) { try { await call('/api/vehicles/' + id, { method: 'DELETE' }); } catch (e) { bad2.push('cleanup: ' + e.message); } } }
    ok(!bad2.length, bad2.join('; '));
    return `${src.make} ${src.model} ${src.year}: ${src.ali.edition} ${src.ali.chart}`;
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
  'chart lookup ignores case: the model in UPPER or lower case gets the same chart', 'chart box: drawn once, shown on the car, cleared again', 'a bad chart box is refused; the processor cannot draw one'].forEach(n => skip(n, 'no page images in ali_pages'));
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
  const fe0 = FE_HITS.n;   // Ultrareview B #8: this is the FIRST decode of the Ford (2013) in the run (the local run has a fake NHTSA), so an old Worker that always asks fueleconomy.gov shows here
  const { s, d } = await call('/api/vin?vin=1FTFW1CT5DFC10312');
  if (s >= 500) return 'NHTSA not reachable: ' + JSON.stringify(d).slice(0, 80);
  ok(FE_HITS.n === fe0, `Ultrareview B #8: the decode without fe=1 made ${FE_HITS.n - fe0} fueleconomy.gov request(s)`);
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

// ---------- adapter notes per chart (HANDOFF 12) ----------
// A car with a chart carries chart_notes: null (no row for the chart) or the five fields. The processor never gets it.
// A database before migration 0007 has no chart_notes key to check: skipped.
{
  let noteCar = null;
  for (const c of (await call('/api/vehicles')).d) { const v = (await call(`/api/vehicles/${c.id}?peek=1`)).d; if (v.ali && 'chart_notes' in v) { noteCar = v; break; } }
  if (noteCar) {
    await t('adapter notes: the car record has chart_notes with its five fields, verified is no, ai or rick', async () => {
      const n = noteCar.chart_notes; if (n === null) return 'no notes row for this chart (null)';
      ok(['adapters', 'height_note', 'cautions', 'kit_mark', 'verified'].every(k => k in n) && ['no', 'ai', 'rick'].includes(n.verified), JSON.stringify(n)); return 'verified ' + n.verified;
    });
    if (hasProc) await t('adapter notes: the processor never gets chart_notes', async () => { const d = (await call(`/api/vehicles/${noteCar.id}?peek=1`, { as: 'proc' })).d; ok(d && !('chart_notes' in d), 'the processor got chart_notes'); });
    else skip('adapter notes: the processor never gets chart_notes', 'no processor token');
  } else ['adapter notes: the car record has chart_notes with its five fields, verified is no, ai or rick', 'adapter notes: the processor never gets chart_notes'].forEach(n => skip(n, 'no car with a chart, or no chart_notes in the answer (before migration 0007)'));
}

// ---------- a temporary visitor car ----------
let car, valId, val2;
await t('add a visitor car (temp)', async () => {
  const r = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet', trim: 'SELFTEST', grp: 'visitor' } });
  ok(r.s === 201 && r.d.grp === 'visitor', 'create ' + r.s + ' ' + JSON.stringify(r.d)); car = r.d.id; cleanup.push(['car', car]);
});

// ---------- status flow and history (decisions 2, 3) ----------
await t('a new value is proposed, with one insert history row', async () => {
  const r = await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'torque', field: 'Torque', value: '75 ft-lb', ftlb_lo: 75, confidence: 'Low', source: 'selftest' } });
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
// ---------- warning levels (HANDOFF 10): 0 none, 1 caution (Lift tab only), 2 block (Home too) ----------
await t('warning levels: set on create and by edit, counted on the car list (nblock, ncaution), dated in the history; bad levels and the processor refused', async () => {
  const counts = async () => { const c = (await call('/api/vehicles')).d.find(x => x.id === car); return [c.nblock, c.ncaution]; };
  const [b0, c0] = await counts(); ok(b0 === 0 && c0 === 0, `a fresh car has nblock ${b0}, ncaution ${c0}`);
  const mk = { tab: 'lift', field: 'Air suspension', value: 'selftest warn step', confidence: 'Low', source: 'selftest' };
  const r = await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { ...mk, warn: 1 } }); ok(r.s === 201, 'create ' + r.s + ' ' + JSON.stringify(r.d));
  const v = r.d.values.find(x => x.value === mk.value); ok(v && v.warn === 1, 'created with ' + JSON.stringify(v)); const id = v.id; cleanup.push(['val', id]);
  let [b, c] = await counts(); ok(b === 0 && c === 1, `caution: nblock ${b}, ncaution ${c}`);
  ok((await call(`/api/values/${id}`, { method: 'PATCH', body: { warn: 2 } })).s === 200, 'patch to block');
  [b, c] = await counts(); ok(b === 1 && c === 0, `block: nblock ${b}, ncaution ${c}`);
  let h = (await call(`/api/values/${id}/history`)).d, l = h[h.length - 1]; ok(l.action === 'update' && l.old_value === l.new_value && l.device === 'selftest', 'level change is not dated: ' + JSON.stringify(l));
  const refused = [];
  for (const w of [3, -1, 'x', 1.5]) { const s = (await call(`/api/values/${id}`, { method: 'PATCH', body: { warn: w } })).s; if (s !== 400) refused.push(`patch ${w}: ${s}`); }
  { const s = (await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { ...mk, value: 'selftest warn bad', warn: 5 } })).s; if (s !== 400) refused.push(`create 5: ${s}`); }
  if (hasProc) {
    const p1 = (await call(`/api/values/${id}`, { as: 'proc', method: 'PATCH', body: { warn: 0 } })).s; if (p1 !== 403) refused.push(`processor clears a block: ${p1}`);
    const p2 = (await call(`/api/vehicles/${car}/values`, { as: 'proc', method: 'POST', body: { ...mk, value: 'selftest warn proc', warn: 1 } })).s; if (p2 !== 403) refused.push(`processor sets a level: ${p2}`);
  }
  ok(!refused.length, 'not refused: ' + refused.join('; '));
  [b, c] = await counts(); ok(b === 1 && c === 0, `after the refusals: nblock ${b}, ncaution ${c}`);
  ok((await call(`/api/values/${id}`, { method: 'PATCH', body: { warn: 0 } })).s === 200, 'patch to none');
  [b, c] = await counts(); ok(b === 0 && c === 0, `none: nblock ${b}, ncaution ${c}`);
  ok((await call(`/api/values/${id}`, { method: 'DELETE' })).s === 200, 'delete the test value');
  return 'create 1, to 2, to 0; counts; 4 bad levels and 1 bad create refused' + (hasProc ? '; processor refused twice' : '');
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
// HANDOFF 13: Rick edits the trim; the change is logged with its date; the processor can neither change it nor read the log.
await t('trim edit: saved, logged, same value is no change, too long refused; the processor gets 403 and no notes', async () => {
  const r1 = await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { trim: '  SELFTEST EDIT  ' } }); ok(r1.s === 200 && r1.d.trim === 'SELFTEST EDIT' && r1.d.changed === true, JSON.stringify(r1.d));
  const v = (await call(`/api/vehicles/${car}?peek=1`)).d; ok(v.trim === 'SELFTEST EDIT', 'trim not saved: ' + v.trim);
  ok(/^\d{4}-\d\d-\d\d trim ".*" -> "SELFTEST EDIT"/m.test(v.notes || ''), 'no dated log line: ' + JSON.stringify(v.notes));
  const r2 = await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { trim: 'SELFTEST EDIT' } }); ok(r2.s === 200 && r2.d.changed === false, 'same trim made a change');
  ok(((await call(`/api/vehicles/${car}?peek=1`)).d.notes || '').split('\n').length === (v.notes || '').split('\n').length, 'same trim added a log line');
  ok((await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { trim: 'x'.repeat(61) } })).s === 400, 'a 61-character trim was accepted');
  if (hasProc) {
    ok((await call(`/api/vehicles/${car}`, { as: 'proc', method: 'PATCH', body: { trim: 'PROC' } })).s === 403, 'the processor changed the trim');
    const pv = (await call(`/api/vehicles/${car}?peek=1`, { as: 'proc' })).d; ok(pv && !('notes' in pv), 'the processor got the notes');
  }
  ok((await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { trim: 'SELFTEST' } })).s === 200, 'restore');
});
// HANDOFF 13: a car that Rick adds, or whose trim he changes, gets a research job by itself (his own login: a phone here). The self-test
// token never does (its test cars would cost real research); an open job for the model stops a second one. Local run only.
// The switch (Worker variable LP_AUTO_RESEARCH, default OFF) is reported by /api/health. Live must stay 0 until Rick turns it on.
await t('auto research switch: /api/health reports it as 0 or 1', async () => { ok(health.auto_research === 0 || health.auto_research === 1, 'auto_research: ' + JSON.stringify(health.auto_research)); return 'auto_research ' + health.auto_research; });
// The build commit (Worker variable LP_BUILD, set by the deploy script) is reported by /api/health; null when the deploy did not set it.
await t('build: /api/health reports the build commit or null', async () => { ok(health.build === null || (typeof health.build === 'string' && /^[0-9a-f]{7,40}$/.test(health.build)), 'build: ' + JSON.stringify(health.build)); return 'build ' + health.build; });
if (LOCAL && hasProc && health.auto_research === 0) await t('auto research OFF (the default): Rick adds a car and changes its trim -> no job', async () => {
  const bad2 = [], ids = [];
  try {
    const a = await call('/api/vehicles', { as: 'phone', method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet Off', trim: 'SELFTEST OFF', grp: 'visitor' } }); ids.push(a.d.id);
    if (!(a.s === 201 && a.d.jobs.length === 0)) bad2.push('a job was made with the switch off: ' + JSON.stringify(a.d.jobs));
    const t1 = await call(`/api/vehicles/${a.d.id}`, { as: 'phone', method: 'PATCH', body: { trim: 'SELFTEST OFF 2' } });
    if (!(t1.s === 200 && t1.d.changed === true && t1.d.research_job === null)) bad2.push('a trim change made a job: ' + JSON.stringify(t1.d));
  } finally { for (const id of ids) { const d = await call('/api/vehicles/' + id, { method: 'DELETE' }); if (d.s !== 200) bad2.push('cleanup ' + d.s); } }
  ok(!bad2.length, bad2.join('; '));
});
if (LOCAL && hasProc && health.auto_research === 1) await t('auto research ON: Rick adds a car or changes its trim -> one research job; the tool token -> none; no duplicate', async () => {
  const bad2 = [], ids = [], mk = trim => ({ year: 1973, make: 'AMC', model: 'Hornet Auto', trim, grp: 'visitor' });
  const jobsOf = async id => (await call(`/api/vehicles/${id}?peek=1`)).d.jobs;
  try {
    const a = await call('/api/vehicles', { as: 'phone', method: 'POST', body: mk('SELFTEST AUTO') }); ids.push(a.d.id);
    if (!(a.s === 201 && a.d.jobs.length === 1 && a.d.jobs[0].kind === 'research' && a.d.jobs[0].status === 'queued')) bad2.push('Rick adds a car: ' + a.s + ' ' + JSON.stringify(a.d.jobs));
    const t1 = await call(`/api/vehicles/${a.d.id}`, { as: 'phone', method: 'PATCH', body: { trim: 'SELFTEST AUTO 2' } });
    if (!(t1.s === 200 && t1.d.changed === true && t1.d.research_job === null)) bad2.push('open job, trim change made a second job: ' + JSON.stringify(t1.d));
    if ((await jobsOf(a.d.id)).length !== 1) bad2.push('job count after the trim change: ' + (await jobsOf(a.d.id)).length);
    const b = await call('/api/vehicles', { method: 'POST', body: { ...mk('SELFTEST AUTO TOOL'), model: 'Hornet Tool' } }); ids.push(b.d.id);
    if (!(b.s === 201 && b.d.jobs.length === 0)) bad2.push('the tool token got a job: ' + JSON.stringify(b.d.jobs));
    const t2 = await call(`/api/vehicles/${b.d.id}`, { as: 'phone', method: 'PATCH', body: { trim: 'SELFTEST AUTO TOOL 2' } });
    if (!(t2.s === 200 && Number.isInteger(t2.d.research_job))) bad2.push('Rick changes the trim, no open job: ' + JSON.stringify(t2.d));
    const t3 = await call(`/api/vehicles/${b.d.id}`, { as: 'phone', method: 'PATCH', body: { trim: 'SELFTEST AUTO TOOL 2' } });
    if (!(t3.s === 200 && t3.d.changed === false && t3.d.research_job === undefined)) bad2.push('same trim made a job: ' + JSON.stringify(t3.d));
    const tj = await call(`/api/vehicles/${b.d.id}`, { method: 'PATCH', body: { trim: 'SELFTEST AUTO TOOL 3' } });
    if (!(tj.s === 200 && tj.d.research_job === null)) bad2.push('tool token trim change made a job: ' + JSON.stringify(tj.d));
  } finally {
    for (const id of ids) {
      for (const j of await jobsOf(id).catch(() => [])) { await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: j.id } }); await call(`/api/jobs/${j.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } }); }
      const d = await call('/api/vehicles/' + id, { method: 'DELETE' }); if (d.s !== 200) bad2.push('cleanup ' + d.s);
    }
  }
  ok(!bad2.length, bad2.join('; '));
});
// HANDOFF 13: "I checked this chart" and "Undo". Rick's login (a phone here) can do it; the tool token only on the temp edition
// 'selftest'; the processor never. The temp row is made and removed by the endpoint itself.
if (health.schema >= '0008') {
  const CK = { edition: 'selftest', chart: 'selftest-a' }, ck = (action, o = {}) => call('/api/chart-checks', { method: 'POST', body: { ...CK, action }, ...o });
  await t('chart check: check, undo, who and when; refused for others', async () => {
    const bad2 = [];
    try {
      const a = await ck('check'); if (!(a.s === 200 && a.d.chart_notes.verified === 'rick' && a.d.chart_notes.verified_by && a.d.chart_notes.verified_at && a.d.history.length === 1)) bad2.push('check: ' + a.s + ' ' + JSON.stringify(a.d));
      const a2 = await ck('check'); if (!(a2.s === 200 && a2.d.changed === false)) bad2.push('second check: ' + JSON.stringify(a2.d));
      const u = await ck('undo'); if (!(u.s === 200 && u.d.chart_notes.verified === 'no' && u.d.chart_notes.verified_by === null && u.d.history.map(h => h.action).join() === 'check,undo')) bad2.push('undo: ' + u.s + ' ' + JSON.stringify(u.d));
      const u2 = await ck('undo'); if (u2.s !== 409) bad2.push('second undo: ' + u2.s);
      if (hasProc) { const p = await ck('check', { as: 'proc' }); if (p.s !== 403) bad2.push('processor: ' + p.s); }
      const real = await call('/api/chart-checks', { method: 'POST', body: { edition: '2026', chart: 'any-chart', action: 'check' } }); if (real.s !== 403) bad2.push('tool token on a real chart: ' + real.s);
      if (LOCAL) {
        // Rick's own login (a phone here): who is his email; a changed text makes the label fall back by itself; history is kept.
        const ph = await ck('check', { as: 'phone' }); if (!(ph.s === 200 && ph.d.chart_notes.verified === 'rick' && ph.d.chart_notes.verified_by === 'owner@example.com')) bad2.push('phone check: ' + ph.s + ' ' + JSON.stringify(ph.d));
        const ed = await ck('selftest_edit', { body: { ...CK, action: 'selftest_edit', adapters: 'selftest text changed' } }); if (!(ed.s === 200 && ed.d.chart_notes.verified === 'no')) bad2.push('text change did not drop the label: ' + ed.s + ' ' + JSON.stringify(ed.d));
        const ph2 = await ck('check', { as: 'phone' }); if (!(ph2.s === 200 && ph2.d.chart_notes.verified === 'rick' && ph2.d.history.length === 4)) bad2.push('check after the change: ' + ph2.s + ' ' + JSON.stringify(ph2.d));
        const pu = await ck('undo', { as: 'phone' }); if (!(pu.s === 200 && pu.d.chart_notes.verified === 'no' && pu.d.history.map(h => h.action).join() === 'check,undo,check,check,undo')) bad2.push('phone undo: ' + pu.s + ' ' + JSON.stringify(pu.d.history));
        const pe = await ck('selftest_edit', { as: 'phone', body: { ...CK, action: 'selftest_edit', adapters: 'x' } }); if (pe.s !== 403) bad2.push('phone ran a self-test action: ' + pe.s);
      }
    } finally { const c = await ck('cleanup'); if (c.s !== 200) bad2.push('cleanup ' + c.s); }
    ok(!bad2.length, bad2.join('; '));
  });
} else skip('chart check: check, undo, who and when; refused for others', 'schema before 0008');
// Decision 9: the make's typical value and the thread range; a torque outside the range is flagged.
if (health.defaults > 0 && health.ranges > 0) {
  await t('the car gets the typical value for its make and the range for that thread', async () => {
    const T = (await call(`/api/vehicles/${car}?peek=1`)).d.typical;
    ok(T && T.make && T.make.make === 'AMC' && T.make.confidence === 'Low' && T.range && T.range.thread === T.make.thread && T.thread_from === 'make', JSON.stringify(T));
    return `${T.make.thread}, ~${T.make.torque_ftlb} ft-lb (${T.make.edition}); range ${T.range.torque_min}-${T.range.torque_max}`;
  });
  await t('a torque outside the thread range is flagged, one inside is not (car and needs-confirming)', async () => {
    const r = await call(`/api/vehicles/${car}/values`, { method: 'POST', body: { tab: 'torque', field: 'Torque', value: '500 ft-lb', ftlb_lo: 500, confidence: 'Low', source: 'selftest' } });
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
  await t('lease renew (HANDOFF 13): extends a valid lease, refused after expiry, refused for the self-test tool', async () => {
    const r1 = await call(`/api/jobs/${job}/renew`, { as: 'proc', now: plus(15 * MIN), method: 'POST', body: {} }); ok(r1.s === 200 && r1.d.lease_until > plus(24 * MIN), JSON.stringify(r1.d));
    const r2 = await call(`/api/jobs/${job}/renew`, { as: 'proc', now: plus(60 * MIN), method: 'POST', body: {} }); ok(r2.s === 409, 'expired lease renewed: ' + r2.s);
    const r3 = await call(`/api/jobs/${job}/renew`, { method: 'POST', body: {} }); ok(r3.s === 403, 'tool token renewed: ' + r3.s);
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
  // HANDOFF 19 (Rick 2026-10-29): the self-test fails jobs on purpose; they must not stay as failed jobs (the Admin page turned PROBLEM from them).
  // The self-test token removes failed jobs whose error text starts with "selftest"; the processor token and a real failed job are left alone.
  await t('fail: failed test jobs are removed again (tool token only; the processor is refused; a real failure stays)', async () => {
    const mk = async () => (await call('/api/jobs', { method: 'POST', body: { vehicle_id: car, kind: 'research', fields: [{ tab: 'tires', field: 'Size' }] } })).d.id;
    const failIt = async (id, error) => { ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: id } })).d.id === id, 'claim ' + id); ok((await call(`/api/jobs/${id}/fail`, { as: 'proc', method: 'POST', body: { error } })).s === 200, 'fail ' + id); };
    // A failed job with a real-looking error is made in local mode only: it could not be removed again on live.
    const mine = await mk(), real = LOCAL ? await mk() : null; await failIt(mine, 'selftest cleanup'); if (real) await failIt(real, 'HTTP 429 rate limit');
    ok((await call('/api/jobs/selftest', { as: 'proc', method: 'DELETE' })).s === 403, 'the processor token may remove jobs');
    const r = await call('/api/jobs/selftest', { method: 'DELETE' }); ok(r.s === 200 && r.d.removed >= 1, 'tool token: ' + r.s + ' ' + JSON.stringify(r.d));
    const jobs = (await call(`/api/vehicles/${car}?peek=1`)).d.jobs;
    ok(!jobs.some(j => j.id === mine), 'the failed test job is still there'); if (real) ok(jobs.some(j => j.id === real && j.status === 'failed'), 'a real failed job was removed');
    return `removed ${r.d.removed}`;
  });
  // HANDOFF 13 (Rick): the server refuses High on a safety field from the processor unless the source cites a page ("p.").
  await t('result: High on a safety field needs a source with a page (p.); the whole result is refused otherwise', async () => {
    const job3 = (await call('/api/jobs', { method: 'POST', body: { vehicle_id: car, kind: 'research', fields: [{ tab: 'torque', field: 'Torque' }] } })).d.id;
    ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: job3 } })).d.id === job3, 'claim');
    const mk = (conf, source) => ({ values: [{ tab: 'torque', field: 'Torque', value: '75 ft-lb (102 Nm)', ftlb_lo: 75, ftlb_src: 'printed', confidence: conf, source }] });
    const bad1 = await call(`/api/jobs/${job3}/result`, { as: 'proc', method: 'POST', body: mk('High', 'selftest research, no page') });
    ok(bad1.s === 400 && /page/.test(bad1.d.error || ''), 'High without a page: ' + bad1.s + ' ' + JSON.stringify(bad1.d));
    ok(!(await call(`/api/vehicles/${car}?peek=1`)).d.values.some(y => y.source === 'selftest research, no page'), 'a value was stored by the refused result');
    const web = await call(`/api/jobs/${job3}/result`, { as: 'proc', method: 'POST', body: mk('High', 'https://example.com/p.html') });
    ok(web.s === 400, 'High with a URL that only looks like a page: ' + web.s);
    const low = await call(`/api/jobs/${job3}/result`, { as: 'proc', method: 'POST', body: { values: [{ tab: 'torque', field: 'Socket', value: '19 mm (selftest)', confidence: 'High', source: 'selftest research, no page' }] } });
    ok(low.s === 200, 'High on a field that is not a safety field: ' + low.s + ' ' + JSON.stringify(low.d));
    const j4 = (await call('/api/jobs', { method: 'POST', body: { vehicle_id: car, kind: 'research', fields: [{ tab: 'torque', field: 'Torque' }] } })).d.id;
    ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: j4 } })).d.id === j4, 'claim 4');
    const good = await call(`/api/jobs/${j4}/result`, { as: 'proc', method: 'POST', body: mk('High', 'Owner manual p.7-16 (selftest)') });
    // HANDOFF 15: the result is accepted (200). It is posted, or skipped when the model year already has a confirmed Torque value (the test car's own).
    ok(good.s === 200 && good.d.proposed + good.d.skipped === 1, 'High with a page: ' + good.s + ' ' + JSON.stringify(good.d));
    const v = (await call(`/api/vehicles/${car}?peek=1`)).d.values;
    for (const y of v.filter(z => /selftest/.test(z.source || '') && z.entered_by === 'processor' && !cleanup.some(c => c[1] === z.id))) cleanup.push(['val', y.id]);
  });
} else ['claim: 10-minute lease, request is private', 'a claimed job is not handed out again while its lease runs', 'lease expiry: after 10 minutes (test clock) the job is claimed again',
  'lease renew (HANDOFF 13): extends a valid lease, refused after expiry, refused for the self-test tool',
  'result: values come back proposed, with history, job done', 'a result for a job that is not claimed is refused', 'fail: a claimed job can be marked failed',
  'result: High on a safety field needs a source with a page (p.); the whole result is refused otherwise'].forEach(n => skip(n, 'no processor token given'));

// ---------- groups and visitor hiding (decisions 4, 5) ----------
await t('opening a car sets last_seen; a visitor hides after 30 days (test clock)', async () => {
  const t0 = new Date().toISOString();
  await call(`/api/vehicles/${car}`, { now: t0 });
  const at = async (ms, q = '') => (await call('/api/vehicles' + q, { now: new Date(Date.parse(t0) + ms).toISOString() })).d.find(c => c.id === car);
  ok(await at(29 * DAY), 'hidden at 29 days'); ok(!(await at(31 * DAY)), 'still shown at 31 days');
  const h = await at(31 * DAY, '?hidden=1'); ok(h && h.hidden === true, 'not in the "show hidden" list');
});
// Only with a processor token: without one the job cannot be closed, stays open, and the next run gets no new job (review copy, 2026-10-27).
if (!hasProc) skip('Frequent queues a workup job for the missing fields', 'no processor token: the job could not be closed again');
else await t('Frequent queues a workup job for the missing fields', async () => {
  const r = await call(`/api/vehicles/${car}`, { method: 'PATCH', body: { grp: 'frequent' } }); ok(r.s === 200 && r.d.workup_job, JSON.stringify(r.d));
  const w = (await call(`/api/vehicles/${car}?peek=1`)).d; ok(w.grp === 'frequent' && w.jobs.some(j => j.id === r.d.workup_job && j.kind === 'workup'), JSON.stringify(w.jobs));
  if (hasProc) { ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: r.d.workup_job } })).d.id === r.d.workup_job, 'claim workup');
    ok((await call(`/api/jobs/${r.d.workup_job}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } })).s === 200, 'close workup'); }
});
if (!hasProc) skip('a frequent car is never hidden', 'no processor token: the car is not made Frequent (see above)');
else await t('a frequent car is never hidden', async () => { const c = (await call('/api/vehicles', { now: plus(400 * DAY) })).d.find(x => x.id === car); ok(c && !c.hidden, 'hidden'); });

// ---------- HANDOFF 15: ft-lb numbers, door card wins, owner, fuel, service log ----------
// One temp car (1973 AMC Hornet Svc), removed at the end with its own values and visits. Model-scope test values are removed by id.
// Nothing here changes a saved VIN or another car (the chart-caution check on a real chart runs in local mode only and restores the flag).
if (health.schema >= '0009') {
  const bad2 = [], chk = (c, m) => { if (!c) bad2.push(m); }, mv = [], svcIds = [];   // svcIds: every visit this block makes (its history rows must be gone at the end)
  // Ultrareview 2026-10-27: one result line per finding. n counts the checks, so a finding that measured nothing is not a PASS.
  const UR = {}, urChk = (k, c, m) => { const u = UR[k] = UR[k] || { n: 0, bad: [] }; u.n++; if (!c) u.bad.push(m); };
  const PRIV_KEYS = ['vin', 'notes', 'owner', 'chart_notes', 'chart_notes_footer', 'no_vin', 'no_doorcard'], TEST_VIN = '1FTFW1CT5DFC10312';
  let tc = null, procVal = null, tcPhoto = null;
  const mkVal = (body, as) => call(`/api/vehicles/${tc}/values`, { method: 'POST', body, as });
  try {
    const c0 = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet Svc', trim: 'SELFTEST SVC', grp: 'visitor' } });
    chk(c0.s === 201, 'temp car ' + c0.s); tc = c0.d && c0.d.id;
    if (tc) {
      // ft-lb numbers
      const nt = await mkVal({ tab: 'torque', field: 'Torque', value: '75 ft-lb', confidence: 'Low', source: 'selftest' }); chk(nt.s === 400 && /ftlb_lo/.test(nt.d.error || ''), 'torque without ftlb_lo: ' + nt.s);
      const nb = await mkVal({ tab: 'torque', field: 'Torque', value: '75 ft-lb', ftlb_lo: 75, ftlb_hi: 70, confidence: 'Low', source: 'selftest' }); chk(nb.s === 400, 'ftlb_hi below ftlb_lo: ' + nb.s);
      const ns = await mkVal({ tab: 'torque', field: 'Torque', value: '75 ft-lb', ftlb_lo: 75, ftlb_src: 'guess', confidence: 'Low', source: 'selftest' }); chk(ns.s === 400, 'bad ftlb_src: ' + ns.s);
      const ok1 = await mkVal({ tab: 'torque', field: 'Torque', value: '100 N-m', ftlb_lo: 74, ftlb_src: 'converted', confidence: 'Low', source: 'selftest' }); chk(ok1.s === 201, 'torque with numbers: ' + ok1.s);
      // The value is found by its own source, and removed at the end (a model-scope value does not go with the car; before 2026-10-27
      // it was left on the database after every run, and a second run then read the first run's value).
      const tq = ok1.d && ok1.d.values.find(x => x.field === 'Torque' && x.source === 'selftest' && x.value === '100 N-m' && x.ftlb_lo === 74); if (tq) mv.push(tq.id);
      chk(tq && tq.ftlb_lo === 74 && tq.ftlb_hi === null && tq.ftlb_src === 'converted', 'numbers not stored: ' + JSON.stringify(tq));
      const pt = tq && await call('/api/values/' + tq.id, { method: 'PATCH', body: { ftlb_lo: 79, ftlb_hi: 94, ftlb_src: 'printed' } }); chk(pt && pt.s === 200, 'patch numbers ' + (pt && pt.s));
      const th = await mkVal({ tab: 'torque', field: 'Thread', value: 'M12x1.5', confidence: 'Low', source: 'selftest' }); const thv = th.d && th.d.values.find(x => x.field === 'Thread' && x.value === 'M12x1.5' && x.source === 'selftest'); if (thv) mv.push(thv.id);
      const pth = thv && await call('/api/values/' + thv.id, { method: 'PATCH', body: { ftlb_lo: 5 } }); chk(pth && pth.s === 400, 'numbers on a non-torque field: ' + (pth && pth.s));
      const after = (await call(`/api/vehicles/${tc}?peek=1`)).d.values.find(x => x.field === 'Torque'); chk(after && after.ftlb_lo === 79 && after.ftlb_hi === 94 && after.ftlb_src === 'printed', 'patched numbers: ' + JSON.stringify(after));
      // Ultrareview F10: the patch above changed only the numbers (same text); history keeps the old and the new numbers.
      if (tq) { const th2 = (await call(`/api/values/${tq.id}/history`)).d || [], ins = th2[0] || {}, up = th2[th2.length - 1] || {};
        urChk('f10', ins.action === 'insert' && ins.new_ftlb_lo === 74 && ins.new_ftlb_src === 'converted', 'insert row numbers: ' + JSON.stringify([ins.new_ftlb_lo, ins.new_ftlb_src]));
        urChk('f10', up.action === 'update' && up.old_value === up.new_value && up.old_ftlb_lo === 74 && up.new_ftlb_lo === 79 && up.old_ftlb_hi === null && up.new_ftlb_hi === 94
          && up.old_ftlb_src === 'converted' && up.new_ftlb_src === 'printed', 'update row numbers: ' + JSON.stringify([up.action, up.old_ftlb_lo, up.new_ftlb_lo, up.old_ftlb_hi, up.new_ftlb_hi, up.old_ftlb_src, up.new_ftlb_src])); }
      // Ultrareview 2 #8 (migration 0011): a warning level change and a source change are in the history, old and new.
      if (tq) {
        await call('/api/values/' + tq.id, { method: 'PATCH', body: { warn: 2 } });
        await call('/api/values/' + tq.id, { method: 'PATCH', body: { warn: 0 } });
        await call('/api/values/' + tq.id, { method: 'PATCH', body: { source: 'selftest 2' } });
        const h8 = (await call(`/api/values/${tq.id}/history`)).d || [], n = h8.length, [w1, w2, s1] = [h8[n - 3] || {}, h8[n - 2] || {}, h8[n - 1] || {}];
        urChk('ur2-8', w1.old_warn === 0 && w1.new_warn === 2 && w2.old_warn === 2 && w2.new_warn === 0, 'warning rows: ' + JSON.stringify([w1.old_warn, w1.new_warn, w2.old_warn, w2.new_warn]));
        urChk('ur2-8', s1.old_source === 'selftest' && s1.new_source === 'selftest 2', 'source row: ' + JSON.stringify([s1.old_source, s1.new_source]));
      }
      // unknown field -> 400 (the worker never creates a field)
      const uf = await mkVal({ tab: 'tires', field: 'SELFTEST NO SUCH FIELD', value: '35 psi', confidence: 'Low', source: 'selftest' }); chk(uf.s === 400 && /Unknown field/.test(uf.d.error || ''), 'unknown field: ' + uf.s);
      // door card wins
      const mp = await mkVal({ tab: 'tires', field: 'Pressure', value: '30 psi (model)', confidence: 'Low', source: 'manual', scope: 'model' }); const mpv = mp.d && mp.d.values.find(x => x.value === '30 psi (model)'); if (mpv) mv.push(mpv.id);
      const cp = await mkVal({ tab: 'tires', field: 'Pressure', value: '35 psi (door)', confidence: 'High', source: 'Door placard photo', scope: 'car', status: 'confirmed' });
      const dv = (await call(`/api/vehicles/${tc}?peek=1`)).d.values.filter(x => x.tab === 'tires');
      chk(dv.find(x => x.value === '30 psi (model)')?.hidden_by_placard === true && dv.find(x => x.value === '35 psi (door)')?.hidden_by_placard === false, 'door card wins flags: ' + JSON.stringify(dv.map(x => [x.value, x.hidden_by_placard])));
      // Ultrareview F9: a model value of another tire field (Size) is not hidden by the door-card Pressure.
      const ms = await mkVal({ tab: 'tires', field: 'Size', value: 'E78-14 (model)', confidence: 'Low', source: 'manual', scope: 'model' }); const msv = ms.d && ms.d.values && ms.d.values.find(x => x.value === 'E78-14 (model)'); if (msv) mv.push(msv.id);
      urChk('f9', msv && msv.hidden_by_placard === false, 'model Size hidden by the door-card Pressure: ' + (msv && msv.hidden_by_placard));
      urChk('f9', dv.find(x => x.value === '30 psi (model)')?.hidden_by_placard === true, 'model Pressure not hidden');
      // Ultrareview 2 #3: a Size confirmed through the door-jamb screen (its source text) now hides the model Size.
      await mkVal({ tab: 'tires', field: 'Size', value: 'E78-14 (door)', confidence: 'High', source: 'Door-jamb label photo, 2026-10-27', scope: 'car', status: 'confirmed' });
      const ms2 = ((await call(`/api/vehicles/${tc}?peek=1`)).d.values || []).find(x => x.value === 'E78-14 (model)');
      urChk('ur2-3', ms2 && ms2.hidden_by_placard === true, 'model Size not hidden by a "Door-jamb label photo" value: ' + (ms2 && ms2.hidden_by_placard));
      if (hasProc) {
        const jb = await call('/api/jobs', { method: 'POST', body: { vehicle_id: tc, kind: 'research' } });
        // Ultrareview F9 (changed check): only the door-card field (Pressure) is not asked; every other tire field with no value is asked.
        const tireNames = (await call('/api/tabs')).d.fields.filter(f => f.tab === 'tires').map(f => f.name), haveT = new Set((await call(`/api/vehicles/${tc}?peek=1`)).d.values.filter(x => x.tab === 'tires').map(x => x.field));
        if (jb.s === 201) { const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: jb.d.id } }); const askT = cl.d.request.fields.filter(f => f.tab === 'tires').map(f => f.field).sort();
          const wantT = tireNames.filter(n => !haveT.has(n)).sort();
          urChk('f9', !askT.includes('Pressure') && askT.join() === wantT.join() && wantT.length > 0, `tire fields asked ${askT} want ${wantT}`);
          await call(`/api/jobs/${jb.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } }); }
        else chk(false, 'research job ' + jb.s);
        // a result for a field that already has a confirmed model value is skipped
        const sv = await mkVal({ tab: 'torque', field: 'Socket', value: '19 mm', confidence: 'High', source: 'selftest', scope: 'model', status: 'confirmed' }); const svv = sv.d && sv.d.values.find(x => x.field === 'Socket'); if (svv) mv.push(svv.id);
        const j2 = await call('/api/jobs', { method: 'POST', body: { vehicle_id: tc, kind: 'research', fields: [{ tab: 'torque', field: 'Socket' }] } });
        await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: j2.d.id } });
        const rs = await call(`/api/jobs/${j2.d.id}/result`, { as: 'proc', method: 'POST', body: { values: [{ tab: 'torque', field: 'Socket', value: '21 mm', confidence: 'Low', source: 'selftest research' }] } });
        chk(rs.s === 200 && rs.d.proposed === 0 && rs.d.skipped === 1, 'confirmed field skipped: ' + rs.s + ' ' + JSON.stringify(rs.d));
        // Ultrareview F3 (changed check; before: a torque result without ftlb_lo was refused with 400). Rick 2026-10-27: the server reads
        // the numbers from the text and marks them converted, so an old research worker or a hand-run queue.sh result still works.
        // A text with no number is still refused.
        const j3 = await call('/api/jobs', { method: 'POST', body: { vehicle_id: tc, kind: 'research', fields: [{ tab: 'torque', field: 'Torque' }] } });
        await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: j3.d.id } });
        const r0 = await call(`/api/jobs/${j3.d.id}/result`, { as: 'proc', method: 'POST', body: { values: [{ tab: 'torque', field: 'Torque', value: 'tight', confidence: 'Low', source: 'selftest research' }] } });
        urChk('f3', r0.s === 400, 'torque text with no number: ' + r0.s);
        const rt = await call(`/api/jobs/${j3.d.id}/result`, { as: 'proc', method: 'POST', body: { values: [{ tab: 'torque', field: 'Torque', value: '75-80 ft-lb (102-108 Nm)', confidence: 'Low', source: 'selftest research' }] } });
        urChk('f3', rt.s === 200 && rt.d.proposed === 1, 'processor torque without ftlb_lo: ' + rt.s);
        if (rt.s !== 200) await call(`/api/jobs/${j3.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } });
        const rv = ((await call(`/api/vehicles/${tc}?peek=1`)).d.values || []).find(x => x.field === 'Torque' && x.source === 'selftest research'); if (rv) mv.push(rv.id);
        urChk('f3', rv && rv.ftlb_lo === 75 && rv.ftlb_hi === 80 && rv.ftlb_src === 'converted' && rv.status === 'proposed', 'numbers from the text: ' + JSON.stringify(rv && [rv.ftlb_lo, rv.ftlb_hi, rv.ftlb_src, rv.status]));
        const j3b = await call('/api/jobs', { method: 'POST', body: { vehicle_id: tc, kind: 'research', fields: [{ tab: 'torque', field: 'Torque' }] } });
        await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: j3b.d.id } });
        const rn = await call(`/api/jobs/${j3b.d.id}/result`, { as: 'proc', method: 'POST', body: { values: [{ tab: 'torque', field: 'Torque', value: '140 N·m', confidence: 'Low', source: 'selftest research nm' }] } });
        if (rn.s !== 200) await call(`/api/jobs/${j3b.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } });
        const rnv = ((await call(`/api/vehicles/${tc}?peek=1`)).d.values || []).find(x => x.source === 'selftest research nm'); if (rnv) mv.push(rnv.id);
        urChk('f3', rn.s === 200 && rnv && rnv.ftlb_lo === 103 && rnv.ftlb_hi === null && rnv.ftlb_src === 'converted', 'N-m only text: ' + rn.s + ' ' + JSON.stringify(rnv && [rnv.ftlb_lo, rnv.ftlb_src]));
      }
      // owner: Rick sees it, the processor never gets the key
      const ow = await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { owner: 'Owner Test' } }); chk(ow.s === 200, 'owner patch ' + ow.s);
      chk((await call(`/api/vehicles/${tc}?peek=1`)).d.owner === 'Owner Test', 'owner not saved');
      chk((await call('/api/vehicles')).d.find(c => c.id === tc)?.owner === 'Owner Test', 'owner not in the list');
      if (hasProc) {
        const pd = (await call(`/api/vehicles/${tc}?peek=1`, { as: 'proc' })).d, pl = (await call('/api/vehicles', { as: 'proc' })).d;
        chk(!('owner' in pd), 'processor detail has an owner key'); chk(Array.isArray(pl) && pl.length && pl.every(c => !('owner' in c)), 'processor list has an owner key');
        chk((await call(`/api/vehicles/${tc}`, { as: 'proc', method: 'PATCH', body: { owner: 'X' } })).s === 403, 'processor changed an owner');
        // Ultrareview F6: every route the processor may call that answers with car data holds no private key and no private text.
        // The temp car gets the test VIN and a notes line (a trim change), so a leak of either can be seen.
        await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { vin: TEST_VIN } });
        await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { trim: 'SELFTEST SVC2' } });
        // A car list or one car is checked key by key; the needs-confirming answer ({count, values}) holds values, not cars: text only.
        const leak = (what, r) => { urChk('f6', r.s >= 200 && r.s < 300, `${what}: status ${r.s}`);
          const cars = Array.isArray(r.d) ? r.d : r.d && r.d.count !== undefined ? [] : [r.d];
          for (const o of cars) for (const k of PRIV_KEYS) urChk('f6', !(o && typeof o === 'object' && k in o), `${what}: key ${k}`);
          urChk('f6', !/Owner Test|1FTFW1CT5DFC10312|SELFTEST SVC\\?" ->/.test(JSON.stringify(r.d)), `${what}: private text`); };
        leak('GET /api/vehicles', await call('/api/vehicles?hidden=1', { as: 'proc' }));
        leak('GET /api/vehicles/:id', await call(`/api/vehicles/${tc}?peek=1`, { as: 'proc' }));
        const pv1 = await call(`/api/vehicles/${tc}/values`, { as: 'proc', method: 'POST', body: { tab: 'torque', field: 'Socket', value: '17 mm', confidence: 'Low', source: 'selftest proc', scope: 'car' } });
        leak('POST /api/vehicles/:id/values', pv1);
        procVal = pv1.d && pv1.d.values && (pv1.d.values.find(x => x.source === 'selftest proc') || {}).id;
        urChk('allow', procVal && pv1.d.values.find(x => x.id === procVal).status === 'proposed', 'processor value not proposed');
        leak('GET /api/needs-confirming', await call('/api/needs-confirming', { as: 'proc' }));
        leak('GET /api/tabs', await call('/api/tabs', { as: 'proc' }));
        // Rick 2026-10-27: the processor cannot add a car (the self-test makes its temp car with the tool token). Old code made one: removed.
        const pc2 = await call('/api/vehicles', { as: 'proc', method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet Svc', trim: 'SELFTEST PROC', vin: TEST_VIN } });
        urChk('allow', pc2.s === 403, 'processor adds a car: ' + pc2.s);
        if (pc2.d && pc2.d.id) { urChk('f6', !PRIV_KEYS.some(k => k in pc2.d), 'POST /api/vehicles answer has a private key'); await call('/api/vehicles/' + pc2.d.id, { method: 'DELETE' }); }
      }
      // fuel and the items a car offers
      chk((await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { fuel: 'steam' } })).s === 400, 'bad fuel accepted');
      chk((await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { fuel: 'gas' } })).s === 200, 'fuel gas');
      const gasItems = (await call('/api/service-items?car=' + tc)).d.map(i => i.name); chk(gasItems.includes('Oil change') && gasItems.includes('Other'), 'gas items: ' + gasItems);
      chk((await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { fuel: 'ev' } })).s === 200, 'fuel ev');
      const evItems = (await call('/api/service-items?car=' + tc)).d.map(i => i.name); chk(!evItems.includes('Oil change') && !evItems.includes('Engine air filter') && evItems.includes('Tire rotation'), 'ev items: ' + evItems);
      const evJob = await call('/api/jobs', { method: 'POST', body: { vehicle_id: tc, kind: 'research' } });
      if (evJob.s === 201 && hasProc) { const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: evJob.d.id } }); chk(!cl.d.request.fields.some(f => f.tab === 'oil'), 'oil asked for an EV'); await call(`/api/jobs/${evJob.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } }); }
      const ev = await call(`/api/vehicles/${tc}/service`, { method: 'POST', body: { date: new Date().toISOString().slice(0, 10), mileage: 1000, items: [{ item_id: 1 }] } }); chk(ev.s === 400, 'oil change on an EV: ' + ev.s);
      chk((await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { fuel: 'gas' } })).s === 200, 'fuel gas again');
      // service log
      const today = new Date().toISOString().slice(0, 10), items = (await call('/api/service-items?car=' + tc)).d, byName = n => items.find(i => i.name === n).id;
      const post = async (b, o = {}) => { const r = await call(`/api/vehicles/${tc}/service`, { method: 'POST', body: b, ...o }); if (r.d && r.d.id) svcIds.push(r.d.id); return r; };
      const oil = { item_id: byName('Oil change'), option: 'With filter' };
      chk((await post({ date: '2999-01-01', mileage: 5000, items: [oil] })).s === 400, 'future date');
      chk((await post({ date: today, items: [oil] })).s === 400, 'no mileage');
      chk((await post({ date: today, mileage: 5000, items: [] })).s === 400, 'no items');
      chk((await post({ date: today, mileage: 5000, items: [{ item_id: byName('Oil change') }] })).s === 400, 'option missing');
      chk((await post({ date: today, mileage: 5000, items: [oil, oil] })).s === 400, 'item twice');
      chk((await post({ date: today, mileage: 5000, items: [{ item_id: byName('Other'), other_text: '' }] })).s === 400, 'Other without text');
      // Only with a processor token: without one, the request carries no processor identity and grades nothing.
      if (hasProc) chk((await post({ date: today, mileage: 5000, items: [oil] }, { as: 'proc' })).s === 403, 'processor posted a visit');
      const v1 = await post({ date: '2025-06-01', mileage: 40000, items: [oil, { item_id: byName('Other'), other_text: 'transmission fluid' }, { item_id: byName('Tire rotation') }] }); chk(v1.s === 201, 'visit 1 ' + v1.s + ' ' + JSON.stringify(v1.d));
      const v3 = await post({ date: '2026-06-01', mileage: 50000, items: [{ item_id: byName('Brake pads'), option: 'Front' }] }); chk(v3.s === 201, 'visit 3 ' + v3.s);
      const low = await post({ date: '2025-12-01', mileage: 30000, items: [oil] }); chk(low.s === 409 && low.d.confirm_needed === true && low.d.before?.mileage === 40000 && low.d.after?.mileage === 50000, 'mileage lower than an earlier visit: ' + low.s + ' ' + JSON.stringify(low.d));
      const high = await post({ date: '2025-12-01', mileage: 60000, items: [oil] }); chk(high.s === 409, 'mileage higher than a later visit: ' + high.s);
      const forced = await post({ date: '2025-12-01', mileage: 30000, force: 1, items: [oil] }); chk(forced.s === 201, 'force: ' + forced.s);
      const fine = await post({ date: '2025-12-02', mileage: 45000, items: [{ item_id: byName('Cabin air filter') }] }); chk(fine.s === 201, 'in order: ' + fine.s);
      const hist = (await call(`/api/vehicles/${tc}/service`)).d;
      chk(hist.entries.length === 4 && hist.entries.map(e => e.date).join() === '2026-06-01,2025-12-02,2025-12-01,2025-06-01', 'order: ' + hist.entries.map(e => e.date));
      chk(hist.last_done[byName('Oil change')]?.date === '2025-12-01' && hist.last_mileage === 50000, 'last_done / last_mileage: ' + JSON.stringify([hist.last_done, hist.last_mileage]));
      // the owner filter of the all-cars list worked on no join before (an SQL error, 500); it answers 200 with a list
      const byOwner = await call('/api/service?owner=Nobody'); chk(byOwner.s === 200 && Array.isArray(byOwner.d) && byOwner.d.length === 0, 'owner filter: ' + byOwner.s);
      // edit, soft delete, history rows
      // The edit goes through the same mileage-order check: 41000 on 2025-06-01 is above the later visit at 30000, so it asks first (409), then force.
      const ed0 = await call('/api/service/' + v1.d.id, { method: 'PATCH', body: { mileage: 41000 } }); chk(ed0.s === 409 && ed0.d.confirm_needed === true, 'edit mileage-order check ' + ed0.s);
      const ed = await call('/api/service/' + v1.d.id, { method: 'PATCH', body: { mileage: 41000, force: 1 } }); chk(ed.s === 200, 'edit ' + ed.s);
      if (hasProc) chk((await call('/api/service/' + v1.d.id, { method: 'PATCH', body: { mileage: 41000 }, as: 'proc' })).s === 403, 'processor edited a visit');
      const del = await call('/api/service/' + v3.d.id, { method: 'DELETE' }); chk(del.s === 200, 'delete ' + del.s);
      const gone = (await call(`/api/vehicles/${tc}/service`)).d.entries; chk(gone.length === 3 && !gone.some(e => e.id === v3.d.id), 'soft delete not hidden');
      const hs = (await call(`/api/service/${v3.d.id}/history`)).d; chk(hs.map(h => h.action).join() === 'insert,delete' && hs[1].before_json && /Brake pads/.test(hs[1].before_json), 'delete history: ' + JSON.stringify(hs.map(h => h.action)));
      const he = (await call(`/api/service/${v1.d.id}/history`)).d; chk(he.map(h => h.action).join() === 'insert,update', 'edit history: ' + he.map(h => h.action));
      // CSV equals the history; the processor may read the CSV (nightly export) but not the rows, and gets no owner
      const csv = await fetch(BASE + '/api/service-log.csv?car=' + tc, { headers: hdr('tool') }); const ct = await csv.text(); const lines = ct.trim().split('\n');
      const nItems = (await call(`/api/vehicles/${tc}/service`)).d.entries.reduce((n, e) => n + e.items.length, 0);
      chk(csv.status === 200 && lines[0] === 'date,mileage,item,option,other_text,car,owner' && lines.length - 1 === nItems, 'csv rows ' + (lines.length - 1) + ' vs items ' + nItems);
      chk(/Owner Test/.test(ct), 'csv has no owner for Rick');
      chk(/transmission fluid/.test(ct) && !/Brake pads/.test(ct), 'csv content');
      const lube = await (await fetch(BASE + '/api/service-log.csv?car=' + tc + '&format=lubelogger', { headers: hdr('tool') })).text(); chk(lube.split('\n')[0] === 'Date,Odometer,Description,Notes,Cost', 'lubelogger header: ' + lube.split('\n')[0]);
      if (hasProc) {
        const pc = await fetch(BASE + '/api/service-log.csv?car=' + tc, { headers: hdr('proc') }); const pt2 = await pc.text(); chk(pc.status === 200 && !/Owner Test/.test(pt2), 'processor csv: ' + pc.status + ' owner leaked ' + /Owner Test/.test(pt2));
        for (const p of ['/api/service', `/api/vehicles/${tc}/service`, '/api/service-items']) chk((await call(p, { as: 'proc' })).s === 403, 'processor read ' + p);
      }
      // a formula in a typed line is neutralised in the CSV
      const fm = await post({ date: today, mileage: 51000, items: [{ item_id: byName('Other'), other_text: '=1+1' }] }); chk(fm.s === 201, 'formula visit ' + fm.s);
      chk(/'=1\+1/.test(await (await fetch(BASE + '/api/service-log.csv?car=' + tc, { headers: hdr('tool') })).text()), 'csv formula not neutralised');
      // Ultrareview 2 #2: a door-jamb photo of the temp car; it must be gone from R2 after the car is deleted (checked in finally).
      const ph = await raw(`/api/vehicles/${tc}/photos`, { method: 'POST', body: GREY });
      if (ph.status === 201) tcPhoto = (await ph.json()).name; else urChk('ur2-2', false, 'test photo not stored: ' + ph.status);
      // Ultrareview F5: the car becomes an EV after an oil-change visit; an edit of only the date keeps every item, and an added item
      // that an EV does not offer (Engine air filter) is still refused.
      chk((await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { fuel: 'ev' } })).s === 200, 'fuel ev for F5');
      const f5 = await call('/api/service/' + v1.d.id, { method: 'PATCH', body: { date: '2025-06-02', force: 1 } });
      urChk('f5', f5.s === 200 && f5.d.items && f5.d.items.length === 3 && f5.d.items.some(i => i.name === 'Oil change'), 'date-only edit on an EV: ' + f5.s + ' ' + JSON.stringify(f5.d && (f5.d.items || f5.d.error)));
      const f5b = await call('/api/service/' + v1.d.id, { method: 'PATCH', body: { force: 1, items: [oil, { item_id: byName('Engine air filter') }] } });
      urChk('f5', f5b.s === 400, 'added item that an EV does not offer: ' + f5b.s);
      const f5c = (await call(`/api/vehicles/${tc}/service`)).d; urChk('f5', Array.isArray(f5c.all_items) && f5c.all_items.some(i => i.name === 'Oil change') && !f5c.items.some(i => i.name === 'Oil change'), 'all_items for the cart');
      chk((await call(`/api/vehicles/${tc}`, { method: 'PATCH', body: { fuel: 'gas' } })).s === 200, 'fuel gas after F5');
      // Ultrareview F7: the processor cannot delete a car; the car and its visits stay.
      if (hasProc) {
        const n0 = (await call(`/api/vehicles/${tc}/service`)).d.entries.length;
        const pdel = await call('/api/vehicles/' + tc, { as: 'proc', method: 'DELETE' }); urChk('f7', pdel.s === 403, 'processor DELETE car: ' + pdel.s);
        urChk('f7', (await call(`/api/vehicles/${tc}?peek=1`)).s === 200, 'car gone after the processor DELETE');
        const n1 = ((await call(`/api/vehicles/${tc}/service`)).d || {}).entries; urChk('f7', Array.isArray(n1) && n1.length === n0 && n0 > 0, `visits before ${n0}, after ${n1 && n1.length}`);
        // Rick 2026-10-27: every route that is not on the processor list answers 403 (ids of the temp car, its visit and its processor value).
        const vid = svcIds[0] || 0, val = procVal || 0, enc = encodeURIComponent;
        const notAllowed = [['GET', '/api/health'], ['GET', '/api/ali/pages'], ['GET', '/api/ali/2019/p001.jpg'], ['HEAD', '/api/ali/2019/p001.jpg'],
          ['POST', '/api/chart-checks', {}], ['PUT', '/api/ali/boxes', {}], ['DELETE', '/api/ali/boxes?edition=x&chart=y'], ['GET', '/api/makes?q=a'],
          ['GET', '/api/models?make=AMC&year=1973'], ['GET', '/api/vin?vin=' + enc(TEST_VIN)], ['GET', '/api/apps'], ['GET', '/api/links?make=AMC&year=1973'],
          ['GET', '/api/service-items'], ['GET', '/api/service'], ['GET', `/api/service/${vid}/history`], ['PATCH', `/api/service/${vid}`, {}],
          ['DELETE', `/api/service/${vid}`], ['GET', `/api/vehicles/${tc}/service`], ['POST', `/api/vehicles/${tc}/service`, {}],
          ['PATCH', `/api/vehicles/${tc}`, { grp: 'mine' }], ['PATCH', `/api/vehicles/${tc}`, { owner: 'X' }], ['GET', `/api/vehicles/${tc}/photos`],
          ['POST', `/api/vehicles/${tc}/photos`, {}], ['GET', `/api/photos/${tc}/2000-01-01T00-00-00-000Z.jpg`], ['DELETE', `/api/photos/${tc}/2000-01-01T00-00-00-000Z.jpg`],
          ['PATCH', `/api/values/${val}`, { note: 'x' }], ['POST', `/api/values/${val}/confirm`, {}], ['POST', `/api/values/${val}/reject`, {}],
          ['GET', `/api/values/${val}/history`], ['DELETE', `/api/values/${val}`], ['POST', '/api/jobs', { vehicle_id: tc }], ['GET', '/api/no-such-route'],
          ['PATCH', `/api/vehicles/${tc}`, { grp: 'frequent' }], ['DELETE', `/api/vehicles/${tc}`]];
        for (const [meth, path, body] of notAllowed) { const r = await call(path, { as: 'proc', method: meth, body }); urChk('allow', r.s === 403, `${meth} ${path}: ${r.s}`); }
        const g = (await call(`/api/vehicles/${tc}?peek=1`)).d; urChk('allow', g && g.grp === 'visitor' && g.owner === 'Owner Test','temp car group or owner changed: ' + (g && g.grp));
      }
      // Jeep switch, local mode only: a real car with a chart caution; the flag is set and restored
      if (LOCAL) {
        const cars = (await call('/api/vehicles?hidden=1')).d;
        for (const c of cars.filter(x => x.id !== tc)) { const d = (await call(`/api/vehicles/${c.id}?peek=1`)).d; if (d.chart_notes && d.chart_notes.cautions && !d.hide_chart_cautions) {
          const on = await call(`/api/vehicles/${c.id}`, { method: 'PATCH', body: { hide_chart_cautions: 1 } }); const d2 = (await call(`/api/vehicles/${c.id}?peek=1`)).d;
          chk(on.s === 200 && d2.chart_notes.cautions === null && d2.chart_notes.cautions_hidden === true, 'caution not hidden: ' + on.s);
          await call(`/api/vehicles/${c.id}`, { method: 'PATCH', body: { hide_chart_cautions: 0 } }); chk((await call(`/api/vehicles/${c.id}?peek=1`)).d.chart_notes.cautions === d.chart_notes.cautions, 'caution not restored'); break; } }
      }
    }
  } catch (e) { bad2.push('exception: ' + e.message); }
  finally {
    for (const id of mv) { const s = (await call('/api/values/' + id, { method: 'DELETE' }).catch(() => ({ s: 'net' }))).s; if (s !== 200 && s !== 404) bad2.push('delete test value ' + s); }
    if (tc) { const s = (await call('/api/vehicles/' + tc, { method: 'DELETE' }).catch(() => ({ s: 'net' }))).s; if (s !== 200) bad2.push('delete temp car ' + s); }
    if (tc && tcPhoto) { const g = await raw(`/api/photos/${tc}/${tcPhoto}`).catch(() => ({ status: 'net' })); urChk('ur2-2', g.status === 404, `photo of the deleted car still served: ${g.status}`);
      if (g.status === 200) await raw(`/api/photos/${tc}/${tcPhoto}`, { method: 'DELETE' }).catch(() => null); }
    // Decision 4 (Rick 2026-10-27): the self-test leaves no service-history row behind, also on live.
    for (const id of svcIds) { const h = await call(`/api/service/${id}/history`).catch(() => ({ s: 'net', d: null })); if (h.s !== 200 || !Array.isArray(h.d) || h.d.length) bad2.push(`history rows left for visit ${id}: ${h.s} ${Array.isArray(h.d) ? h.d.length : '?'}`); }
  }
  await t('HANDOFF 15: ft-lb numbers, door card wins, owner, fuel, service log (400 / 409 / soft delete / CSV / processor limits)', async () => { ok(!bad2.length, bad2.join('; ')); return 'temp car removed'; });
  const UR_NAMES = { f6: 'ultrareview F6: no private car key or text on any processor route', f7: 'ultrareview F7: the processor cannot delete a real car (403), its visits stay',
    allow: 'processor allowlist: every route not on the list is 403 (add car, change group, delete car too); values proposed only',
    f5: 'ultrareview F5: a visit edit keeps its own items after the fuel changes; an added item must apply', f9: 'ultrareview F9: the door card hides and skips only its own field',
    f10: 'ultrareview F10: value history keeps the old and new ft-lb numbers',
    f3: 'ultrareview F3: a torque result without ftlb_lo gets the numbers from its text, marked converted; no number is 400',
    'ur2-2': 'ultrareview 2 #2: deleting a car deletes its door-jamb photos (no reused id can see them)',
    'ur2-3': 'ultrareview 2 #3: a value saved by the door-jamb screen ("Door-jamb label photo") counts as the door card',
    'ur2-8': 'ultrareview 2 #8: the value history keeps old and new warning level and source' };
  for (const [k, name] of Object.entries(UR_NAMES)) {
    if (!hasProc && ['f6', 'f7', 'allow', 'f3'].includes(k)) { skip(name, 'no processor token'); continue; }
    await t(name, async () => { const u = UR[k]; ok(u && u.n > 0, 'NOT CHECKED: 0 checks ran'); ok(!u.bad.length, u.bad.join('; ')); return `${u.n} checks`; });
  }
} else skip('HANDOFF 15: ft-lb numbers, door card wins, owner, fuel, service log', 'schema before 0009');

// ---------- HANDOFF 17: engine lists, VIN check digit, door-jamb photo read, badges ----------
// Temp cars (1973 AMC Hornet B, trim SELFTEST B) with their photos go with the car. Every job this block makes is claimed and closed here, so
// the N100 photo script never gets one (a read_doorcard job is claimed within the same second it is queued). Model-scope test values are removed by id.
// The only VINs are the public NHTSA example VIN and that VIN with its last character changed (check digit fails).
if (health.schema >= '0012') {
  const GOOD = '1FTFW1CT5DFC10312', BADV = GOOD.slice(0, 16) + '8', made = [], vals17 = [];
  const mkCar = async (extra = {}) => { const r = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet B', trim: 'SELFTEST B', grp: 'visitor', ...extra } }); if (r.d && r.d.id) made.push(r.d.id); return r; };
  const carOf = async id => (await call(`/api/vehicles/${id}?peek=1`)).d;
  const addVal = async (id, body) => { const r = await call(`/api/vehicles/${id}/values`, { method: 'POST', body: { confidence: 'Low', source: 'selftest', ...body } }); return r; };
  const track = r => { (r.d && r.d.values || []).filter(x => x.source === 'selftest' && x.scope === 'model').forEach(x => { if (!vals17.includes(x.id)) vals17.push(x.id); }); return r; };
  // A value added for ANOTHER engine than the car's own is not in the answer of the add call, so track() cannot see it and it used to stay in the
  // database for ever (the review database keeps state between runs: the second rehearsal then saw extra values and failed, 2026-10-28). The sweep
  // deletes every proposed model-scope value with the source "selftest", at the start and at the end of this section.
  const sweepVals = async () => { const nc = (await call('/api/needs-confirming')).d; for (const x of (nc && nc.values) || []) if (x.source === 'selftest' && x.scope === 'model') await call('/api/values/' + x.id, { method: 'DELETE' }).catch(() => null); };
  // one photo read: upload a photo, queue the job, claim it as the processor, post the result. Returns the pieces for the checks.
  const readJob = async (id, read) => {
    const up = await raw(`/api/vehicles/${id}/photos`, { method: 'POST', body: GREY }), photo = (await up.json()).name;
    const q = await call(`/api/vehicles/${id}/doorcard`, { method: 'POST', body: { photo } });
    const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d && q.d.id, kinds: ['read_doorcard'] } });
    const res = cl.d && cl.d.id ? await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { read } }) : null;
    return { photo, q, cl, res };
  };
  try {
    await sweepVals();
    await t('HANDOFF 17 B7: VIN check digit on add, edit and a VIN decode; "not a US-market VIN" saves a failing one', async () => {
      const b = [];
      let r = await mkCar({ vin: BADV }); if (r.s !== 400 || !(r.d && r.d.check_failed)) b.push(`add with a failing check digit: ${r.s}`);
      r = await mkCar({ vin: 'ABCDEFGHIJKLMNOPQ' }); if (r.s !== 400 || (r.d && r.d.check_failed)) b.push(`add with a bad shape: ${r.s}`);
      r = await mkCar({ vin: BADV, not_us: true }); if (r.s !== 201 || (await carOf(r.d.id)).vin !== BADV) b.push(`add with not_us: ${r.s}`);
      r = await mkCar({ vin: GOOD.toLowerCase() }); if (r.s !== 201 || (await carOf(r.d.id)).vin !== GOOD) b.push(`add with a good VIN in lower case: ${r.s}`);
      const c = await mkCar(); const id = c.d.id;
      let p = await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { vin: BADV } }); if (p.s !== 400 || !p.d.check_failed) b.push(`edit with a failing check digit: ${p.s}`);
      if ((await carOf(id)).vin) b.push('the failing VIN was saved');
      p = await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { vin: BADV, not_us: true } }); if (p.s !== 200 || (await carOf(id)).vin !== BADV) b.push(`edit with not_us: ${p.s}`);
      p = await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { vin: '' } }); if (p.s !== 200 || (await carOf(id)).vin) b.push('clear');
      const d1 = await call('/api/vin?vin=' + GOOD);   // NHTSA answers; a 500 here is NHTSA down
      if (d1.s === 200 && d1.d.check !== true) b.push('decode of the good VIN: check ' + d1.d.check);
      const d2 = await call('/api/vin?vin=' + BADV); if (d2.s === 200 && d2.d.check !== false) b.push('decode of the failing VIN: check ' + d2.d.check);
      ok(!b.length, b.join('; ')); return 'add, edit, decode';
    });
    if (LOCAL) await t('HANDOFF 17 B1: fueleconomy lists through the Worker: variants, options, one object, no result, D1 cache, error, classic', async () => {
      const b = [], n0 = FE_HITS.n, q = '/api/fe?year=2021&make=Jeep&model=Grand%20Cherokee', v4 = '&variant=Grand%20Cherokee%204WD';
      const a = await call(q); if (a.s !== 200 || a.d.variants.map(x => x.text).join() !== 'Grand Cherokee 2WD,Grand Cherokee 4WD') b.push('variants: ' + JSON.stringify(a.d));
      const o = await call(q + v4); if (o.s !== 200 || o.d.options.map(x => x.value).join() !== '43167,43168') b.push('options: ' + JSON.stringify(o.d));
      const o2 = await call(q + '&variant=Grand%20Cherokee%202WD'); if (o2.d.options.length !== 1 || o2.d.options[0].value !== '43160') b.push('one object: ' + JSON.stringify(o2.d));
      const h1 = FE_HITS.n - n0; if (h1 !== 3) b.push(`requests to fueleconomy.gov ${h1}, want 3`);
      await call(q); await call(q + v4); await call(q + '&variant=Grand%20Cherokee%202WD');
      if (FE_HITS.n - n0 !== h1) b.push(`the cache did not answer: ${FE_HITS.n - n0} requests`);
      const nr = await call('/api/fe?year=2021&make=Jeep&model=Nothing'); if (nr.s !== 200 || nr.d.variants.length) b.push('no result: ' + JSON.stringify(nr.d));
      const ev = await call('/api/fe?year=2025&make=BMW&model=i4&variant=i4%20eDrive40%20Gran%20Coupe'); if (ev.d.options.length !== 1 || /\d\.\d\s*L/.test(ev.d.options[0].text)) b.push('electric option: ' + JSON.stringify(ev.d));
      const er = await call('/api/fe?year=2021&make=Failmake&model=X'); if (er.s !== 200 || er.d.variants.length || !er.d.error) b.push('fetch error with no saved row: ' + JSON.stringify(er.d));
      const n1 = FE_HITS.n; const cl = await call('/api/fe?year=1973&make=AMC&model=Hornet'); if (cl.s !== 200 || !cl.d.classic || FE_HITS.n !== n1) b.push('classic: ' + JSON.stringify(cl.d));
      if ((await call('/api/fe?year=2021&model=X')).s !== 400) b.push('missing make is not 400');
      const tr = await call('/api/trims?year=1973&make=AMC&model=Hornet%20B'); if (tr.s !== 200 || !Array.isArray(tr.d.trims) || tr.d.trims.some(x => /^SELFTEST/.test(x.name))) b.push('trims: ' + JSON.stringify(tr.d));
      ok(!b.length, b.join('; ')); return `${h1} requests, then 0 more from the cache`;
    }); else skip('HANDOFF 17 B1: fueleconomy lists through the Worker', 'local mode only (the fake fueleconomy.gov)');
    await t('HANDOFF 17 B2/B4/B5: variant, engine, fe_id and fuel on a car; a value with an engine shows only on that engine; research carries the engine', async () => {
      const b = [], E1 = 'Auto 8-spd, 8 cyl, 5.7 L', E2 = 'Auto 8-spd, 6 cyl, 3.6 L';
      const c = await mkCar({ engine: E1, variant: 'Grand Cherokee 4WD', fe_id: 43168, fuel: 'gas' }); const id = c.d && c.d.id;
      const cv = await carOf(id); if (c.s !== 201 || cv.engine !== E1 || cv.variant !== 'Grand Cherokee 4WD' || cv.fe_id !== 43168 || cv.fuel !== 'gas') b.push('fields not stored: ' + JSON.stringify([cv.engine, cv.variant, cv.fe_id, cv.fuel]));
      if ((await mkCar({ engine: 'x'.repeat(81) })).s !== 400) b.push('an engine of 81 characters was accepted');
      if ((await mkCar({ fe_id: 'abc' })).s !== 400) b.push('a bad fe_id was accepted');
      const c2 = await mkCar(); const id2 = c2.d.id;   // no engine
      for (const [value, engine] of [['generic oil', undefined], ['oil for the V8', E1], ['oil for the V6', E2]]) {
        const r = track(await addVal(id, { tab: 'oil', field: 'Oil type', value, scope: 'model', engine })); if (r.s !== 201) b.push('add value ' + r.s);
      }
      const oil = async i => ((await carOf(i)).values || []).filter(x => x.field === 'Oil type').map(x => x.value);
      let s = await oil(id); if (s.join() !== 'oil for the V8,generic oil') b.push('car with the V8: ' + s);
      s = await oil(id2); if (s.length !== 3) b.push('car with no engine sees ' + s);
      await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { engine: E2, fe_id: 43167 } }); s = await oil(id); if (s.join() !== 'oil for the V6,generic oil') b.push('car with the V6: ' + s);
      const hl = ((await call('/api/vehicles')).d || []).find(x => x.id === id); if (!hl || hl.nvals < 2) b.push('Home counts: ' + JSON.stringify(hl && hl.nvals));
      if (hasProc) {
        const jb = await call('/api/jobs', { method: 'POST', body: { vehicle_id: id, kind: 'research', fields: [{ tab: 'oil', field: 'Quantity' }] } });
        const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: jb.d && jb.d.id, kinds: ['research', 'workup'] } });
        if (!cl.d || cl.d.request.engine !== E2) b.push('the research request has no engine: ' + JSON.stringify(cl.d && cl.d.request));
        const rs = cl.d && cl.d.id ? await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { values: [
          { tab: 'oil', field: 'Quantity', value: '5.5 qt', confidence: 'Low', source: 'https://example.com/selftest', engine: E2 },   // marked for the engine (as the worker does for oil)
          { tab: 'torque', field: 'Thread', value: 'M12x1.5', confidence: 'Low', source: 'https://example.com/selftest' }] } }) : { s: 'no job' };   // not engine-dependent: no tag
        if (rs.s !== 200) b.push('result ' + rs.s);
        const pv = ((await call(`/api/vehicles/${id}?peek=1`)).d.values || []).filter(x => x.source === 'https://example.com/selftest');
        const q = pv.find(x => x.field === 'Quantity'), th = pv.find(x => x.field === 'Thread');
        if (!q || q.engine !== E2 || q.scope !== 'model') b.push('the value marked for the engine has no engine tag: ' + JSON.stringify(q && [q.engine, q.scope]));
        if (!th || th.engine !== null) b.push('a value not marked for the engine got a tag (Opus finding 1): ' + JSON.stringify(th && th.engine));
        pv.forEach(x => vals17.push(x.id));
        const jb2 = await call('/api/jobs', { method: 'POST', body: { vehicle_id: id2, kind: 'research', fields: [{ tab: 'oil', field: 'Filter' }] } });
        const cl2 = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: jb2.d && jb2.d.id, kinds: ['research'] } });
        if (!cl2.d || 'engine' in cl2.d.request) b.push('a car with no engine has an engine key in its request');
        if (cl2.d && cl2.d.id) await call(`/api/jobs/${cl2.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } });
      }
      ok(!b.length, b.join('; ')); return 'engine filter, order, request and result';
    });
    await t('HANDOFF 17 (Rick 2026-10-27): engines match by a normalized key (displacement, cylinders, turbo, electric), not by text', async () => {
      const b = [], LIST20 = 'Auto (variable gear ratios), 4 cyl, 2.0 L';
      const id = (await mkCar({ engine: LIST20 })).d.id;
      for (const [value, engine] of [['tag 2.0 L', '2.0 L'], ['tag 2.0L spelling', '2.0L'], ['tag list text', LIST20], ['tag 1.5 L turbo', '1.5 L turbo'], ['tag 2.0 L turbo', '2.0 L Turbo'], ['tag 4 cyl 2.0 L', '4 cyl 2.0 L'], ['tag 6 cyl 2.0 L', '6 cyl 2.0 L'], ['no tag', undefined]])
        track(await addVal(id, { tab: 'oil', field: 'Filter', value, scope: 'model', engine }));
      const seen = async () => ((await carOf(id)).values || []).filter(x => x.field === 'Filter').map(x => x.value).sort();
      const want = ['no tag', 'tag 2.0 L', 'tag 2.0L spelling', 'tag 4 cyl 2.0 L', 'tag list text'];
      let s = await seen(); if (s.join() !== want.join()) b.push('2.0 L car (list text) sees: ' + s);
      await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { engine: '2.0 L' } }); s = await seen();   // a later pick or another spelling never hides a value
      if (s.join() !== ['no tag', 'tag 2.0 L', 'tag 2.0L spelling', 'tag 4 cyl 2.0 L', 'tag 6 cyl 2.0 L', 'tag list text'].sort().join()) b.push('2.0 L car (short text) sees: ' + s);
      await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { engine: '1.5 L Turbo' } }); s = await seen();
      if (s.join() !== ['no tag', 'tag 1.5 L turbo'].join()) b.push('1.5 L turbo car sees: ' + s);
      const hl = ((await call('/api/vehicles')).d || []).find(x => x.id === id), nv = (await carOf(id)).values.length;   // Home counts equal what the car shows
      if (!hl || hl.nvals !== nv) b.push(`Home counts ${hl && hl.nvals}, the car shows ${nv}`);
      ok(!b.length, b.join('; ')); return 'normalized key';
    });
    await t('Ultrareview B #4: a car with no engine sees the untagged value first, the tagged ones are flagged no_headline; a car with an engine is not flagged', async () => {
      const b = [], E = 'Auto (variable gear ratios), 4 cyl, 2.0 L';
      const none = (await mkCar({ year: 1975 })).d.id, eng = (await mkCar({ year: 1975, engine: E })).d.id;
      for (const [value, engine] of [['tagged oil 2.0', E], ['generic oil', undefined]]) track(await addVal(none, { tab: 'oil', field: 'Oil type', value, scope: 'model', engine }));
      const vs = async i => ((await carOf(i)).values || []).filter(x => x.field === 'Oil type');
      let s = await vs(none);
      if (s.map(x => x.value).join() !== 'generic oil,tagged oil 2.0') b.push('car with no engine, order: ' + s.map(x => x.value));
      const g = s.find(x => x.value === 'generic oil'), tg = s.find(x => x.value === 'tagged oil 2.0');
      if (!g || !tg || g.no_headline !== false || tg.no_headline !== true || tg.engine !== E) b.push('car with no engine, flags: ' + JSON.stringify(s.map(x => [x.value, x.no_headline, x.engine])));
      s = await vs(eng);
      if (s.map(x => x.value).join() !== 'tagged oil 2.0,generic oil' || s.some(x => x.no_headline)) b.push('car with the engine: ' + JSON.stringify(s.map(x => [x.value, x.no_headline])));
      ok(!b.length, b.join('; ')); return 'order and no_headline';
    });
    await t('Ultrareview B #6: Needs confirming "replaces" looks at the same engine or no engine only, and the row carries the engine', async () => {
      const b = [], EA = 'Auto, 4 cyl, 2.0 L', EB = 'Auto, 4 cyl, 1.5 L turbo';
      const id = (await mkCar({ year: 1979 })).d.id;
      const mk = async (value, engine, confirm) => {
        const r = track(await addVal(id, { tab: 'oil', field: 'Filter', value, scope: 'model', engine })), x = ((r.d && r.d.values) || []).find(y => y.value === value);
        if (x && confirm) await call(`/api/values/${x.id}/confirm`, { method: 'POST', body: {} });
        return x;
      };
      await mk('filter A confirmed', EA, true); await mk('filter B proposed', EB, false); await mk('filter A proposed', EA, false); await mk('filter untagged proposed', undefined, false);
      const nc = (await call('/api/needs-confirming')).d.values, get = v => nc.find(x => x.value === v);
      if (!get('filter B proposed') || !get('filter A proposed') || !get('filter untagged proposed')) b.push('a proposal is missing from Needs confirming');
      else {
        if (get('filter B proposed').replaces) b.push('a proposal for engine B shows the value of engine A as replaced: ' + get('filter B proposed').replaces);
        if (get('filter A proposed').replaces !== 'filter A confirmed') b.push('the same engine does not show the replaced value: ' + get('filter A proposed').replaces);
        if (get('filter untagged proposed').replaces) b.push('an untagged proposal shows a tagged value as replaced');
        if (get('filter B proposed').engine !== EB) b.push('the row has no engine: ' + get('filter B proposed').engine);
      }
      ok(!b.length, b.join('; ')); return 'replaces by engine';
    });
    if (LOCAL) await t('Ultrareview B #8 and #2: /api/vin asks fueleconomy.gov only with fe=1; an empty fueleconomy answer is not cached', async () => {
      const b = [];
      const n0 = FE_HITS.n, d0 = await call('/api/vin?vin=' + GOOD);
      if (d0.s === 200) {
        if (FE_HITS.n !== n0) b.push(`the car-page decode made ${FE_HITS.n - n0} fueleconomy.gov request(s)`);
        const n1 = FE_HITS.n, d1 = await call('/api/vin?fe=1&vin=' + GOOD);
        if (d1.s !== 200 || FE_HITS.n === n1) b.push('the Add car decode (fe=1) made no fueleconomy.gov request');
        else if (d1.d.fe && d1.d.fe.id !== 33000) b.push('the Add car decode matched another option: ' + JSON.stringify(d1.d.fe));
      }   // a 500 here is NHTSA down: the two checks above are skipped, the cache check below still runs
      const q = '/api/fe?year=2021&make=Jeep&model=Wrangler&variant=Nothing%20Here';
      await call(q);
      const h = FE_HITS.n; await call(q); const h1 = FE_HITS.n - h; await call(q); const h2 = FE_HITS.n - h - h1;
      if (h1 !== 1 || h2 !== 1) b.push(`an empty answer was cached: ${h1} then ${h2} request(s), want 1 and 1`);
      ok(!b.length, b.join('; ')); return 'fe=1 only; empty not cached';
    }); else skip('Ultrareview B #8 and #2', 'local mode only (the fake fueleconomy.gov)');
    if (hasProc) await t('Ultrareview B #3 and #7: a waiting photo read does not stop the Frequent workup; a job for another engine does not block; the same engine does', async () => {
      const b = [], EA = 'Auto, 4 cyl, 2.0 L', EB = 'Auto, 4 cyl, 1.5 L turbo', open = [];
      const drop = async (jid, kinds) => { const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: jid, kinds } }); if (cl.d && cl.d.id) await call(`/api/jobs/${cl.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } }); };
      const freq = async id => (await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { grp: 'frequent' } })).d;
      try {
        const a = (await mkCar({ year: 1978, engine: EA })).d.id;
        const up = await raw(`/api/vehicles/${a}/photos`, { method: 'POST', body: GREY }), photo = (await up.json()).name;
        const pj = await call(`/api/vehicles/${a}/doorcard`, { method: 'POST', body: { photo } }); if (pj.s !== 201) b.push('photo job ' + pj.s); else open.push([pj.d.id, ['read_doorcard']]);
        const w1 = await freq(a); if (!w1 || !w1.workup_job) b.push('a waiting photo read stopped the workup'); else open.push([w1.workup_job, ['workup']]);
        const c = (await mkCar({ year: 1978, engine: EB })).d.id, w2 = await freq(c);
        if (!w2 || !w2.workup_job) b.push('a job for engine A blocked the workup of a car with engine B'); else open.push([w2.workup_job, ['workup']]);
        const d = (await mkCar({ year: 1978, engine: EA })).d.id, w3 = await freq(d);
        if (w3 && w3.workup_job) { b.push('a second workup for the same engine was queued'); open.push([w3.workup_job, ['workup']]); }
      } finally { for (const [jid, kinds] of open) await drop(jid, kinds); }
      ok(!b.length, b.join('; ')); return 'photo job and engines';
    });
    if (hasProc) {
      await t('HANDOFF 17 B6/B9/B12: a photo read job: key list, claim by kind, photo only while claimed, result to proposals, no VIN on any car or list route of the processor', async () => {
        const b = [], c = await mkCar({ engine: 'E-DOOR', vin: GOOD }), id = c.d.id;
        const up = await raw(`/api/vehicles/${id}/photos`, { method: 'POST', body: GREY }), photo = (await up.json()).name;
        if ((await call(`/api/vehicles/${id}/doorcard`, { method: 'POST', body: { photo: '2000-01-01T00-00-00-000Z.jpg' } })).s !== 404) b.push('a photo that does not exist was queued');
        if ((await call(`/api/vehicles/${id}/doorcard`, { method: 'POST', body: { photo: '../x.jpg' } })).s !== 400) b.push('a bad photo name was queued');
        if ((await call(`/api/vehicles/${id}/doorcard`, { as: 'proc', method: 'POST', body: { photo } })).s !== 403) b.push('the processor started a read');
        const q = await call(`/api/vehicles/${id}/doorcard`, { method: 'POST', body: { photo } }); if (q.s !== 201 || !q.d.id) b.push('queue ' + q.s);
        const q2 = await call(`/api/vehicles/${id}/doorcard`, { method: 'POST', body: { photo } }); if (!q2.d || q2.d.id !== q.d.id || !q2.d.already) b.push('a second queue for the same photo made a second job');
        const pu = `/api/photos/${id}/${photo}`;
        if ((await raw(pu, { as: 'proc' })).status !== 403) b.push('the photo was served before the job was claimed');
        if (!(await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id } })).d.none) b.push('a claim with no kinds got the photo job');
        if (!(await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['research', 'workup'] } })).d.none) b.push('a research claim got the photo job');
        const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['read_doorcard'] } });
        if (!cl.d || cl.d.kind !== 'read_doorcard') b.push('no claim: ' + JSON.stringify(cl.d));
        const keys = Object.keys(cl.d && cl.d.request || {}).sort().join(); if (keys !== 'car,engine,make,model,photo,year') b.push('request keys (no saved VIN): ' + keys);
        if (cl.d && (JSON.stringify(cl.d.request).includes(GOOD) || cl.d.request.engine !== 'E-DOOR' || cl.d.request.photo !== photo)) b.push('request values');
        const pg = await raw(pu, { as: 'proc' }); if (pg.status !== 200 || (await pg.arrayBuffer()).byteLength !== GREY.length) b.push('the claimed photo: ' + pg.status);
        if ((await raw(`/api/photos/${id}/2000-01-01T00-00-00-000Z.jpg`, { as: 'proc' })).status !== 403) b.push('another photo name was served');
        if ((await raw(pu, { as: 'proc', method: 'DELETE' })).status !== 403) b.push('the processor deleted a photo');
        if ((await raw('/api/ali/2019/p001.jpg', { as: 'proc' })).status !== 403) b.push('an ALI page was served to the processor');
        for (const [bad, why] of [[{}, 'no read'], [{ read: { psi_front: 5, psi_rear: 32 } }, 'psi 5'], [{ read: { psi_front: 32.5, psi_rear: 32 } }, 'psi 32.5'], [{ read: { spare: { state: 'maybe' } } }, 'spare state'],
          [{ read: { spare: { state: 'psi' } } }, 'spare psi missing'], [{ read: { size_front: 'garbage' } }, 'size'], [{ read: { vin: 'ABC' } }, 'vin shape']]) {
          const r = await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: bad }); if (r.s !== 400) b.push(`${why}: ${r.s}`);
        }
        const rs = await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { read: { size_front: '235/50R18', size_rear: '255/45R18', psi_front: 32, psi_rear: 35, spare: { state: 'none' }, vin: GOOD } } });
        // Ultrareview B #10: the processor's answer has no "vin" word (it would confirm the saved VIN to the processor). The tool's job summary below says "matches".
        if (rs.s !== 200 || rs.d.proposed !== 3 || 'vin' in rs.d || rs.d.matches.length) b.push('result (the VIN equals the saved VIN: no proposal, no vin word for the processor): ' + rs.s + JSON.stringify(rs.d));
        const tv = ((await carOf(id)).values || []).filter(x => x.tab === 'tires' && x.scope === 'car');
        const want = { Pressure: '32 / 35 psi', Size: '235/50R18 / 255/45R18', 'Spare pressure': 'none' };
        for (const [f, v] of Object.entries(want)) { const x = tv.find(y => y.field === f); if (!x || x.value !== v || x.status !== 'proposed' || x.confidence !== 'High' || !/\(read from photo\)/.test(x.source) || x.note !== 'photo ' + photo) b.push(`${f}: ` + JSON.stringify(x && [x.value, x.status, x.source, x.note])); }
        const jd = ((await carOf(id)).jobs || []).find(j => j.id === q.d.id); if (!jd || jd.status !== 'done' || /[A-Z0-9]{17}/.test(jd.result_summary || '')) b.push('job summary: ' + JSON.stringify(jd));
        const pj = ((await call(`/api/vehicles/${id}?peek=1`, { as: 'proc' })).d.jobs || []).find(j => j.id === q.d.id); if (!pj || pj.result_summary !== null) b.push('the processor sees the photo job summary (it says whether a VIN is saved): ' + JSON.stringify(pj && pj.result_summary));
        if ((await raw(pu, { as: 'proc' })).status !== 403) b.push('the photo was served after the job was done');
        const nc = (await call('/api/needs-confirming')).d, vp = (nc.vin_proposals || []).find(p => p.vehicle_id === id);
        if (vp) b.push('a VIN equal to the saved VIN made a proposal: ' + JSON.stringify(vp));
        const jsum = ((await carOf(id)).jobs || []).find(j => j.id === q.d.id); if (!jsum || !/VIN matches the saved VIN/.test(jsum.result_summary || '')) b.push('the job summary does not say the VIN matches: ' + (jsum && jsum.result_summary));
        const pn = await call('/api/needs-confirming', { as: 'proc' }); if ('vin_proposals' in pn.d || JSON.stringify(pn.d).includes(GOOD)) b.push('the processor sees a VIN proposal');
        // Rick 2026-10-27: a read equal to a CONFIRMED car-scope value says "matches" and makes no proposal. Confirm the pressure, read the same again.
        const pv = ((await carOf(id)).values || []).find(x => x.field === 'Pressure' && x.scope === 'car' && x.status === 'proposed');
        if (pv) await call(`/api/values/${pv.id}/confirm`, { method: 'POST', body: {} });
        const r3 = await readJob(id, { size_front: '235/50R18', size_rear: '255/45R18', psi_front: 32, psi_rear: 35, spare: { state: 'none' }, vin: GOOD });
        if (!r3.res || r3.res.s !== 200 || r3.res.d.proposed !== 0 || r3.res.d.matches.join() !== 'Pressure' || 'vin' in r3.res.d) b.push('a read equal to a confirmed value: ' + JSON.stringify(r3.res && r3.res.d));
        const cnt = ((await carOf(id)).values || []).filter(x => x.field === 'Pressure' && x.scope === 'car').length; if (cnt !== 1) b.push('a matching read made a second Pressure value: ' + cnt);
        const j3 = ((await carOf(id)).jobs || []).find(j => j.id === (r3.q.d && r3.q.d.id)); if (!j3 || !/matches the confirmed value: Pressure/.test(j3.result_summary || '')) b.push('the job summary does not say matches: ' + (j3 && j3.result_summary));
        // a pending VIN proposal can be confirmed (a car with no VIN, below); a decided one cannot be decided again
        // a second photo: another VIN, spare not on the label. A saved VIN is never replaced.
        const r2 = await readJob(id, { psi_front: 30, psi_rear: 30, spare: { state: 'not_on_label' }, vin: BADV });
        if (!r2.res || r2.res.s !== 200 || r2.res.d.proposed !== 1) b.push('second read: ' + JSON.stringify(r2.res && r2.res.d));
        if (((await carOf(id)).values || []).filter(x => x.field === 'Spare pressure').length !== 1) b.push('not_on_label proposed a spare value');
        const vp2 = ((await call('/api/needs-confirming')).d.vin_proposals || []).find(p => p.vehicle_id === id);
        if (!vp2 || vp2.saved_state !== 'differs' || vp2.vin_ok) b.push('second proposal: ' + JSON.stringify(vp2));
        if (vp2) { const cf = await call(`/api/vin-proposals/${vp2.id}/confirm`, { method: 'POST', body: { not_us: true } }); if (cf.s !== 409) b.push('a differing VIN was confirmed: ' + cf.s);
          if ((await carOf(id)).vin !== GOOD) b.push('THE SAVED VIN CHANGED');
          if ((await call(`/api/vin-proposals/${vp2.id}/reject`, { method: 'POST', body: {} })).s !== 200) b.push('reject'); }
        // a car with no VIN: the proposal fills it; a failing check digit needs not_us
        const e = await mkCar(); const re = await readJob(e.d.id, { vin: GOOD });
        if (!re.res || re.res.s !== 200 || re.res.d.proposed !== 0 || 'vin' in re.res.d) b.push('read for a car with no VIN: ' + JSON.stringify(re.res && re.res.d));
        const pe = ((await call('/api/needs-confirming')).d.vin_proposals || []).find(p => p.vehicle_id === e.d.id);
        if (!pe || pe.saved_state !== 'none') b.push('proposal for a car with no VIN: ' + JSON.stringify(pe));
        if (pe) {
          if ((await call(`/api/vin-proposals/${pe.id}/confirm`, { as: 'proc', method: 'POST', body: {} })).s !== 403) b.push('the processor confirmed a VIN');
          if ((await call(`/api/vin-proposals/${pe.id}/confirm`, { method: 'POST', body: {} })).s !== 200 || (await carOf(e.d.id)).vin !== GOOD) b.push('confirm fills the empty VIN');
          if ((await call(`/api/vin-proposals/${pe.id}/confirm`, { method: 'POST', body: {} })).s !== 409) b.push('a decided proposal was decided again');
        }
        const f = await mkCar(); const rf = await readJob(f.d.id, { vin: BADV });
        const pf = ((await call('/api/needs-confirming')).d.vin_proposals || []).find(p => p.vehicle_id === f.d.id);
        if (!pf || pf.vin_ok) b.push('failing proposal: ' + JSON.stringify(pf));
        if (pf) { const c1 = await call(`/api/vin-proposals/${pf.id}/confirm`, { method: 'POST', body: {} }); if (c1.s !== 409 || !c1.d.check_failed || (await carOf(f.d.id)).vin) b.push('a failing check digit was saved without not_us: ' + c1.s);
          const c2 = await call(`/api/vin-proposals/${pf.id}/confirm`, { method: 'POST', body: { not_us: true } }); if (c2.s !== 200 || (await carOf(f.d.id)).vin !== BADV) b.push('not_us confirm: ' + c2.s); }
        void rf;
        ok(!b.length, b.join('; ')); return 'key list, claim by kind, photo access, result, VIN proposals';
      });
      await t('HANDOFF 17 B10: "No VIN" and "No door card" are computed; the processor does not get them', async () => {
        const b = [], c = await mkCar(), id = c.d.id, row = async () => ((await call('/api/vehicles')).d || []).find(x => x.id === id);
        let r = await row(); if (!r || r.no_vin !== true || r.no_doorcard !== true) b.push('new car: ' + JSON.stringify(r && [r.no_vin, r.no_doorcard]));
        let nc = (await call('/api/needs-confirming')).d; if (!(nc.badges || []).some(x => x.vehicle_id === id && x.no_vin && x.no_doorcard)) b.push('Needs confirming has no badge for the car');
        await addVal(id, { tab: 'tires', field: 'Pressure', value: '30 psi', scope: 'car', status: 'confirmed', confidence: 'High', source: 'Door-jamb label photo, 2026-10-27' });
        await call(`/api/vehicles/${id}`, { method: 'PATCH', body: { vin: GOOD } });
        r = await row(); if (!r || r.no_vin !== false || r.no_doorcard !== false) b.push('after VIN and a confirmed door card: ' + JSON.stringify(r && [r.no_vin, r.no_doorcard]));
        nc = (await call('/api/needs-confirming')).d; if ((nc.badges || []).some(x => x.vehicle_id === id)) b.push('the badge stays in Needs confirming');
        const pl = (await call('/api/vehicles', { as: 'proc' })).d.find(x => x.id === id); if (!pl || 'no_vin' in pl || 'no_doorcard' in pl || 'vin' in pl) b.push('the processor list has a badge or VIN key: ' + Object.keys(pl || {}));
        const pv = (await call(`/api/vehicles/${id}?peek=1`, { as: 'proc' })).d; if ('no_vin' in pv || 'no_doorcard' in pv || 'vin' in pv) b.push('the processor car has a badge or VIN key');
        ok(!b.length, b.join('; ')); return 'badges';
      });
    } else skip('HANDOFF 17 B6/B9/B10: photo read job, badges', 'no processor token');
  } finally {
    for (const id of vals17) await call('/api/values/' + id, { method: 'DELETE' }).catch(() => null);
    await sweepVals().catch(() => null);
    for (const id of made) await call('/api/vehicles/' + id, { method: 'DELETE' }).catch(() => null);
  }
} else skip('HANDOFF 17: engine lists, VIN check digit, photo read, badges', 'schema before 0012');

// ---------- HANDOFF 18: the Admin page, the ops log, recalls and the curb weight ----------
// Local mode only for everything that writes ops_log rows or asks the fake NHTSA (a live run must leave no row behind). The live run checks the
// refusals: every /api/admin/* GET is 403 for the tool token (and for the processor token when there is one).
// The only VINs are the public NHTSA example VIN (on the allowlist of the export check), and two made-up VINs that FAIL the check digit and are built
// from parts, so this file holds no VIN-shaped literal: NODEC starts with 9 (the fake VIN decode fails for it; saved with not_us), PLANT_VIN is
// planted in the scrub test. The fake Anthropic key is built from two parts for the same reason (the export check looks for the sk-ant- text).
if (health.schema >= '0013') {
  const GOOD = '1FTFW1CT5DFC10312', NODEC = '9TESTX' + '000XX000000', PLANT_VIN = '3TESTY' + '000YY' + '000001', FAKE_KEY = 'sk-' + 'ant-api03-SECRETSECRET', made = [];
  const mkCar = async (extra = {}) => { const r = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet B', trim: 'SELFTEST B', grp: 'visitor', ...extra } }); if (r.d && r.d.id) made.push(r.d.id); return r; };
  const carOf = async id => (await call(`/api/vehicles/${id}?peek=1`)).d;
  const PLANT = 'Bearer abc123token ' + FAKE_KEY + ' CF_ACCESS_CLIENT_SECRET ' + 'a'.repeat(40) + ' someone@example.com team-x.cloudflareaccess.com ' + PLANT_VIN;
  const PLANTED = ['Bearer abc123token', FAKE_KEY, 'CF_ACCESS_CLIENT_SECRET', 'a'.repeat(32), 'someone@example.com', 'cloudflareaccess.com', PLANT_VIN];
  const push = async (rows, now, extra = {}) => call('/api/admin/log', { as: 'proc', method: 'POST', now, body: { rows, ...extra } });
  try {
    await t('HANDOFF 18 C5: every /api/admin/* GET is refused for the tool token' + (hasProc ? ' and the processor token' : '') + '; a forged or expired token is refused too', async () => {
      const b = [];
      for (const p of ['/api/admin/status', '/api/admin/dot', '/api/admin/nothing']) {
        const r = await call(p); if (r.s !== 403) b.push(`tool ${p}: ${r.s}`);
        if (hasProc) { const q = await call(p, { as: 'proc' }); if (q.s !== 403) b.push(`processor ${p}: ${q.s}`); }
        if (LOCAL) for (const who of ['forged', 'expired']) { const q = await call(p, { as: who }); if (q.s !== 403) b.push(`${who} ${p}: ${q.s}`); }
      }
      if (hasProc) { const r = await call('/api/admin/log', { method: 'POST', body: { rows: [] } }); if (r.s !== 403) b.push('the tool token pushed the log: ' + r.s); }
      ok(!b.length, b.join('; ')); return 'tool, processor, forged, expired';
    });
    // Rick 2026-10-28 (live deploy run 2): the processor may POST /api/admin/log and nothing else under /api/admin. Safe on LIVE: the push is EMPTY
    // (no rows, no prune), so nothing is written. The allowlist, not LP_ADMIN_EMAILS, is what lets the processor in; LP_ADMIN_EMAILS guards the rest.
    if (hasProc) await t('HANDOFF 18 C5: the processor token may POST /api/admin/log (an empty push, nothing written) and may not GET any /api/admin route or POST another admin path; the tool token may not push', async () => {
      const b = [];
      const e = await call('/api/admin/log', { as: 'proc', method: 'POST', body: { rows: [] } });
      if (e.s !== 200 || !e.d || e.d.ok !== true || e.d.inserted !== 0 || e.d.pruned !== 0) b.push('empty push as the processor: ' + e.s + ' ' + JSON.stringify(e.d));
      for (const p of ['/api/admin/status', '/api/admin/dot', '/api/admin/log', '/api/admin/nothing']) { const r = await call(p, { as: 'proc' }); if (r.s !== 403) b.push(`processor GET ${p}: ${r.s}`); }
      for (const p of ['/api/admin/status', '/api/admin/dot', '/api/admin/nothing']) { const r = await call(p, { as: 'proc', method: 'POST', body: {} }); if (r.s !== 403) b.push(`processor POST ${p}: ${r.s}`); }
      const tp = await call('/api/admin/log', { method: 'POST', body: { rows: [] } }); if (tp.s !== 403) b.push('the tool token pushed: ' + tp.s);
      ok(!b.length, b.join('; ')); return 'processor: empty POST 200; every GET and other POST 403';
    }); else skip('HANDOFF 18 C5: the processor token and /api/admin/log', 'no processor token');
    if (LOCAL) {
      // Rick 2026-10-28: the Admin page is for the login in LP_ADMIN_EMAILS only (deploy.sh sets it from LP_ACCESS_EMAIL in the private deploy.env;
      // the local run sets owner@example.com). Any other Access login is refused on the page routes and on /api/admin, GET and POST.
      await t('HANDOFF 18 C5: any other Access login (an e-mail that is not LP_ADMIN_EMAILS) gets 403 on /api/admin/*, the page data and the gear dot; the listed login gets 200; a different case of the listed address is accepted', async () => {
        const b = [];
        for (const p of ['/api/admin/status', '/api/admin/dot', '/api/admin/nothing']) {
          const o = await call(p, { as: 'other' }); if (o.s !== 403 || !/Rick only/.test((o.d && o.d.error) || '')) b.push(`other login ${p}: ${o.s} ${JSON.stringify(o.d)}`);
        }
        const po = await call('/api/admin/log', { as: 'other', method: 'POST', body: { rows: [{ kind: 'backup', level: 'green', text: 'x' }] } }); if (po.s !== 403) b.push('other login pushed the log: ' + po.s);
        const ok1 = await call('/api/admin/status', { as: 'phone' }); if (ok1.s !== 200 || !ok1.d || !ok1.d.queue) b.push('the listed login: ' + ok1.s);
        const ok2 = await call('/api/admin/dot', { as: 'phone' }); if (ok2.s !== 200) b.push('the listed login, dot: ' + ok2.s);
        const ok3 = await call('/api/admin/dot', { as: 'phonecase' }); if (ok3.s !== 200) b.push('the listed address in another letter case: ' + ok3.s);
        ok(!b.length, b.join('; ')); return 'other login 403, listed login 200';
      });
      await t('HANDOFF 18 C1/C4: the processor pushes rows; secrets are scrubbed in the Worker (text and data); a VIN is masked to its last 4; bad kind or level, too many rows, a far time are handled', async () => {
        const b = [], now = new Date().toISOString();
        // The health row gets a time 5 hours ago (the test clock), so the next check can see an old report; no later row is pushed before it.
        const hOld = new Date(Date.now() - 5 * 3600e3).toISOString();
        const r0 = await push([{ ts: hOld, kind: 'health', level: 'amber', text: 'N100 health: amber', data: { items: [{ name: 'disk_root', level: 'amber', reason: 'disk / 85% full ' + PLANT, pad: PLANT, note: ['x ' + PLANT] }] } }], hOld);
        const r1 = await push([{ ts: now, kind: 'backup', level: 'red', text: 'backup failed: ' + PLANT }]);
        if (r0.s !== 200 || r0.d.inserted !== 1 || r1.s !== 200 || r1.d.inserted !== 1) b.push('push: ' + r0.s + JSON.stringify(r0.d) + ' ' + r1.s + JSON.stringify(r1.d));
        const st = await call('/api/admin/status', { as: 'phone' }); if (st.s !== 200) { b.push('status as Rick: ' + st.s); return ok(false, b.join('; ')); }
        const all = JSON.stringify(st.d);
        for (const w of PLANTED) if (all.includes(w)) b.push('the status still holds: ' + w);
        if (!all.includes('*'.repeat(13) + PLANT_VIN.slice(-4))) b.push('the VIN is not masked to the last 4');
        if (!/backup failed/.test(JSON.stringify(st.d.log))) b.push('the backup row is not in the log');
        if ((await push([{ ts: now, kind: 'nonsense', level: 'red', text: 'x' }])).s !== 400) b.push('an unknown kind was accepted');
        if ((await push([{ ts: now, kind: 'backup', level: 'purple', text: 'x' }])).s !== 400) b.push('an unknown level was accepted');
        if ((await push(Array.from({ length: 61 }, () => ({ ts: now, kind: 'backup', level: 'green', text: 'x' })))).s !== 400) b.push('61 rows were accepted');
        const n0 = (await call('/api/admin/status', { as: 'phone' })).d.log.length;
        await push([{ ts: '2020-01-01T00:00:00Z', kind: 'export', level: 'green', text: 'far-past-row' }]);
        const lg = (await call('/api/admin/status', { as: 'phone' })).d.log; if (lg.length !== n0 + 1 || !lg.some(l => l.text === 'far-past-row' && Math.abs(Date.parse(l.ts) - Date.now()) < 60e3)) b.push('a time 6 years ago was not replaced by now');
        ok(!b.length, b.join('; ')); return 'scrub, mask, 400s, far time';
      });
      await t('HANDOFF 18 C1: the prune call deletes rows older than 30 days and keeps the rest; the log filters by day and kind', async () => {
        const b = [], old = new Date(Date.now() - 40 * 864e5).toISOString();
        const r = await push([{ ts: old, kind: 'export', level: 'green', text: 'forty-days-old-row' }], old);   // the test clock (tool token) lets a row take an old time
        if (r.s !== 200) b.push('push with a test clock: ' + r.s);
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(old));
        const s1 = (await call('/api/admin/status?day=' + day, { as: 'phone' })).d; if (!s1.log.some(l => l.text === 'forty-days-old-row')) b.push('the old row is not in the log of its day');
        if ((await call('/api/admin/status?day=' + day + '&kind=backup', { as: 'phone' })).d.log.some(l => l.text === 'forty-days-old-row')) b.push('the kind filter kept an export row');
        if (!(await call('/api/admin/status?day=' + day + '&kind=export', { as: 'phone' })).d.log.some(l => l.text === 'forty-days-old-row')) b.push('the kind filter lost the export row');
        const p = await push([{ ts: new Date().toISOString(), kind: 'export', level: 'green', text: 'fresh-row' }], undefined, { prune: true });
        if (p.s !== 200 || !(p.d.pruned >= 1)) b.push('prune: ' + p.s + JSON.stringify(p.d));
        if ((await call('/api/admin/status?day=' + day, { as: 'phone' })).d.log.some(l => l.text === 'forty-days-old-row')) b.push('the old row survived the prune');
        if (!(await call('/api/admin/status', { as: 'phone' })).d.log.some(l => l.text === 'fresh-row')) b.push('the fresh row was pruned');
        ok(!b.length, b.join('; ')); return 'prune at 30 days, day and kind filter';
      });
      await t('HANDOFF 18 C3/C10: the status turns amber or red with the reason in words: old N100 report, red item, D1 at 55% and 85%, a failed job with a 429 and a timeout', async () => {
        const b = [], lv = async () => (await call('/api/admin/status', { as: 'phone' })).d;
        const hOld = new Date(Date.now() - 5 * 3600e3).toISOString();
        await push([{ ts: hOld, kind: 'health', level: 'green', text: 'N100 health: green', data: { items: [{ name: 'disk_root', level: 'green', reason: 'disk / 20% full' }] } }], hOld);
        let s = await lv(); const old = s.n100.items.find(i => i.name === 'n100_report'); if (!old || old.level !== 'red' || !/hours old/.test(old.reason)) b.push('a 5 hour old report: ' + JSON.stringify(old));
        const now = new Date().toISOString();
        await push([{ ts: now, kind: 'health', level: 'red', text: 'N100 health: red', data: { items: [{ name: 'disk_nas', level: 'red', reason: 'NAS mount missing' }, { name: 'backup_file', level: 'red', reason: 'backup older than 26 h (30 h)' },
          { name: 'research_worker_run', level: 'red', reason: 'last research worker run failed (error)' }, { name: 'research_cost', level: 'green', reason: 'research cost today $0.10', today_usd: 0.1, month_usd: 1, daily_cap_usd: 2 },   // flat, as health_collect.py writes it
          { name: 'token_expiry', level: 'green', reason: 'all tokens have more than 60 days left', expires: { cloudflare_api_token: '2027-12-31' } }] } }]);
        s = await lv(); const it = n => s.n100.items.find(i => i.name === n);
        if (!it('disk_nas') || it('disk_nas').level !== 'red' || it('disk_nas').reason !== 'NAS mount missing') b.push('disk_nas: ' + JSON.stringify(it('disk_nas')));
        if (!it('backup_file') || !/older than 26 h/.test(it('backup_file').reason)) b.push('backup_file');
        if (s.overall !== 'red' || s.worker_runs.level !== 'red' || !/failed/.test(s.worker_runs.reason)) b.push('overall/worker: ' + s.overall + ' ' + s.worker_runs.level);
        if (s.worker_runs.cost.today_usd !== 0.1 || s.worker_runs.cost.daily_cap_usd !== 2) b.push('cost: ' + JSON.stringify(s.worker_runs.cost));
        if (!it('token_expiry') || !it('token_expiry').data || it('token_expiry').data.expires.cloudflare_api_token !== '2027-12-31') b.push('token expiry dates: ' + JSON.stringify(it('token_expiry')));
        // a health row whose details were too large is kept, with its own level, as one line (not an empty card)
        await push([{ ts: new Date(Date.now() + 1000).toISOString(), kind: 'health', level: 'red', text: 'N100 health: red (big)', data: { items: [{ name: 'disk_root', level: 'red', reason: 'x'.repeat(7000) }] } }]);
        const big = await lv(); const bi = big.n100.items.find(i => i.name === 'n100_report');
        if (!bi || bi.level !== 'red' || !/without its lines/.test(bi.reason) || big.overall !== 'red') b.push('a too large health row: ' + JSON.stringify(bi) + ' ' + big.overall);
        if (it('n100_report')) b.push('a fresh report is called old');
        await push([{ ts: now, kind: 'd1_usage', level: 'amber', text: 'D1', data: { day: 'x', databases: [{ name: 'liftpad', rows_written: 55000, rows_read: 100 }] } }]);
        // HANDOFF 19 (Rick 2026-10-29): free plan = levels against the free daily limits; Workers Paid (LP_D1_PLAN=paid) = the free-limit % is grey info and the
        // colour is the share of the monthly included amounts (so 55,000 and 85,000 rows written today are "info" and the month line stays green).
        const PAID = process.env.LP_D1_PLAN === 'paid';
        s = await lv(); let w = s.d1.items.find(i => /rows_written$/.test(i.name));
        if (PAID) {
          if (s.d1.plan !== 'paid') b.push('plan: ' + s.d1.plan);
          if (!w || w.level !== 'info' || !/55,000 rows written today = 55% of the old free daily limit \(info only on Workers Paid\)/.test(w.reason)) b.push('d1 55% paid: ' + JSON.stringify(w));
          const mo = s.d1.items.find(i => /rows_written_month$/.test(i.name)); if (!mo || mo.level !== 'green' || !/of 50,000,000 included/.test(mo.reason)) b.push('d1 month paid: ' + JSON.stringify(mo));
        } else if (!w || w.level !== 'amber' || !/55,000 rows written today of 100,000 free \(55%\)/.test(w.reason)) b.push('d1 55%: ' + JSON.stringify(w));
        await push([{ ts: now, kind: 'd1_usage', level: 'red', text: 'D1', data: { day: 'x', databases: [{ name: 'liftpad', rows_written: 85000, rows_read: 100 }] } }]);
        s = await lv(); w = s.d1.items.find(i => /rows_written$/.test(i.name));
        if (PAID) { if (!w || w.level !== 'info') b.push('d1 85% paid is not grey info: ' + JSON.stringify(w)); if (s.d1.items.some(i => i.level === 'red' || i.level === 'amber')) b.push('a paid D1 line is coloured at 85% of the free limit: ' + JSON.stringify(s.d1.items.filter(i => i.level !== 'info' && i.level !== 'green').map(i => i.name))); }
        else if (!w || w.level !== 'red') b.push('d1 85%: ' + JSON.stringify(w));
        // a failed job: 429 and a timeout, in words; the secret in the error text is not shown
        const c = await mkCar(); const ids = [];
        for (const err of ['HTTP 429 rate_limit_error ' + FAKE_KEY, 'timed out after 120 s']) {
          const j = await call('/api/jobs', { method: 'POST', body: { vehicle_id: c.d.id, kind: 'research', fields: [{ tab: 'torque', field: 'Torque' }] } });
          const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: j.d && j.d.id, kinds: ['research', 'workup'] } });
          if (cl.d && cl.d.id) { await call(`/api/jobs/${cl.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: err } }); ids.push(cl.d.id); } else b.push('no claim for the job: ' + JSON.stringify(cl.d));
        }
        s = await lv(); const why = s.queue.failed.map(f => f.why).join(' | ');
        if (!/busy \(error 429\)/.test(why) || !/did not answer in time/.test(why) || /SECRET/.test(JSON.stringify(s))) b.push('failed job words: ' + why);
        if (s.queue.level === 'green' || !/failed in the last 24 hours/.test(s.queue.reason)) b.push('queue: ' + s.queue.level + ' ' + s.queue.reason);
        const dot = await call('/api/admin/dot', { as: 'phone' }); if (dot.s !== 200 || dot.d.level !== 'red') b.push('dot: ' + dot.s + JSON.stringify(dot.d));
        ok(!b.length, b.join('; ')); return 'levels and reasons';
      });
      await t('HANDOFF 21 F7: the Admin status carries today\'s parts jobs (the N100 item research_parts, flat as health_collect.py writes it): jobs, posted, dropped, failed, the drop reasons; a failed parts job turns the worker line amber; no such item = parts is null', async () => {
        const b = [], lv = async () => (await call('/api/admin/status', { as: 'phone' })).d;
        const t1 = new Date(Date.now() + 1000).toISOString();
        await push([{ ts: t1, kind: 'health', level: 'amber', text: 'N100 health: amber', data: { items: [{ name: 'research_worker_run', level: 'green', reason: 'last research worker run ok, 0.1 h ago' },
          { name: 'research_parts', level: 'amber', reason: 'parts today: 2 of 5 jobs, 5 posted, 3 dropped (non-US source 2); 1 failed', jobs: 2, posted: 5, dropped: 3, failed: 1, daily_cap: 5, reasons: { 'non-US source': 2, 'source not checkable': 1 } }] } }]);
        const s = await lv(), p = s.worker_runs.parts;
        if (!p || p.jobs !== 2 || p.posted !== 5 || p.dropped !== 3 || p.failed !== 1 || p.daily_cap !== 5 || p.reasons['non-US source'] !== 2 || p.reasons['source not checkable'] !== 1 || p.level !== 'amber') b.push('parts: ' + JSON.stringify(p));
        if (s.worker_runs.level !== 'amber') b.push('the worker line is ' + s.worker_runs.level);
        const t2 = new Date(Date.now() + 2000).toISOString();
        await push([{ ts: t2, kind: 'health', level: 'green', text: 'N100 health: green', data: { items: [{ name: 'research_worker_run', level: 'green', reason: 'last research worker run ok, 0.1 h ago' }] } }]);
        const s2 = await lv(); if (s2.worker_runs.parts !== null) b.push('parts without an item: ' + JSON.stringify(s2.worker_runs.parts));
        ok(!b.length, b.join('; ')); return 'parts line, amber on a failed job, null without the item';
      });
    } else skip('HANDOFF 18 C1/C3/C4/C10: the ops log, scrubbing, prune, levels', 'local mode only (a live run leaves no log row behind)');

    if (LOCAL) {
      await t('HANDOFF 18 C8: recalls by the VIN decode (model name from the decode), counted once a day, never the E (equipment) campaigns; a failed decode falls back to the car\'s own names; no VIN change', async () => {
        const b = [], c = await mkCar({ vin: GOOD }), id = c.d.id;
        const a = await carOf(id); if (a.recalls !== null || a.facts_due !== true) b.push('before the first ask: ' + JSON.stringify([a.recalls, a.facts_due]));
        const n0 = RC_HITS.n, r = await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} });
        if (r.s !== 200 || !r.d.recalls || r.d.recalls.count !== 2 || r.d.recalls.by !== 'vin' || !/F-150/.test(r.d.recalls.model) || r.d.recalls.items.some(i => /E/.test(i.campaign))) b.push('by VIN: ' + r.s + JSON.stringify(r.d.recalls && [r.d.recalls.count, r.d.recalls.by, r.d.recalls.model]));
        if (r.d.recalls && (r.d.recalls.items[0].campaign !== '20V314000' || r.d.recalls.items[0].date !== '2020-05-28')) b.push('order or date: ' + JSON.stringify(r.d.recalls.items[0]));
        if (RC_HITS.n - n0 !== 1) b.push('NHTSA asked ' + (RC_HITS.n - n0) + ' times');
        await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} }); if (RC_HITS.n - n0 !== 1) b.push('a second ask the same minute went to NHTSA again');
        const v = await carOf(id); if (!v.recalls || v.recalls.count !== 2 || v.facts_due !== false) b.push('the car payload: ' + JSON.stringify([v.recalls && v.recalls.count, v.facts_due]));
        await call(`/api/vehicles/${id}/facts`, { method: 'POST', now: new Date(Date.now() + 21 * 3600e3).toISOString(), body: {} }); if (RC_HITS.n - n0 !== 2) b.push('after 21 hours NHTSA was not asked again: ' + (RC_HITS.n - n0));
        const d = await mkCar({ vin: NODEC, not_us: true }), n1 = RC_HITS.n, r2 = await call(`/api/vehicles/${d.d.id}/facts`, { method: 'POST', body: {} });
        if (!r2.d.recalls || r2.d.recalls.by !== 'saved' || r2.d.recalls.count !== 1 || !/Hornet B/i.test(r2.d.recalls.model) || RC_HITS.n - n1 !== 1) b.push('fallback to the saved names: ' + JSON.stringify(r2.d.recalls && [r2.d.recalls.by, r2.d.recalls.count, r2.d.recalls.model]));
        const e = await mkCar(), r3 = await call(`/api/vehicles/${e.d.id}/facts`, { method: 'POST', body: {} }); if (!r3.d.recalls || r3.d.recalls.by !== 'saved' || r3.d.recalls.count !== 1) b.push('a car with no VIN: ' + JSON.stringify(r3.d.recalls));
        if ((await carOf(id)).vin !== GOOD || (await carOf(d.d.id)).vin !== NODEC) b.push('A SAVED VIN CHANGED');
        ok(!b.length, b.join('; ')); return 'by VIN, fallback, once a day';
      });
      await t('HANDOFF 18 C8: a model NHTSA answers 400 for (the i4) says "not available", never "0 recalls"; the try is repeated after 1 hour, not before; an old good answer stays', async () => {
        const b = [], c = await mkCar({ model: 'Failmodel' }), id = c.d.id, n0 = RC_HITS.n;
        const r = await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} });
        if (!r.d.recalls || r.d.recalls.count !== null || !/did not give a recalls answer/.test(r.d.recalls.error || '')) b.push('failed answer: ' + JSON.stringify(r.d.recalls));
        const k = RC_HITS.n - n0; await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} }); if (RC_HITS.n - n0 !== k) b.push('the failed try was repeated at once');
        await call(`/api/vehicles/${id}/facts`, { method: 'POST', now: new Date(Date.now() + 61 * 60e3).toISOString(), body: {} }); if (RC_HITS.n - n0 <= k) b.push('the failed try was not repeated after 61 minutes');
        ok(!b.length, b.join('; ')); return 'failure is not zero';
      });
      await t('HANDOFF 18 C7: the curb weight is PROPOSED from the Canadian specs (the trim row, else the base model), with the split; the processor cannot ask or confirm; Rick confirms or types; a confirmed weight is never replaced; no VIN change', async () => {
        const b = [], c = await mkCar({ vin: GOOD }), id = c.d.id, n0 = CAN_HITS.n;
        const r = await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} });
        const w = r.d.curb; if (!w || w.lb !== 2756 || w.front_pct !== 56 || w.status !== 'proposed' || w.source !== 'Canadian specs, HORNET SELFTEST B 2DR') b.push('trim row: ' + JSON.stringify(w));
        const base = await mkCar({ trim: 'SELFTEST C' }), rb = await call(`/api/vehicles/${base.d.id}/facts`, { method: 'POST', body: {} });
        if (!rb.d.curb || rb.d.curb.lb !== 2425 || rb.d.curb.front_pct !== 55 || rb.d.curb.source !== 'Canadian specs, base model') b.push('base model: ' + JSON.stringify(rb.d.curb));
        const nf = await mkCar({ model: 'Failmodel' }), rf = await call(`/api/vehicles/${nf.d.id}/facts`, { method: 'POST', body: {} });
        if (rf.d.curb !== null || !rf.d.weight_error) b.push('no Canadian answer: ' + JSON.stringify([rf.d.curb, rf.d.weight_error]));
        const k = CAN_HITS.n - n0; await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} }); if (CAN_HITS.n - n0 !== k) b.push('the weight was asked again the same minute');
        if (hasProc) {
          if ((await call(`/api/vehicles/${id}/facts`, { as: 'proc', method: 'POST', body: {} })).s !== 403) b.push('the processor asked for facts');
          if ((await call(`/api/vehicles/${id}/weight`, { as: 'proc', method: 'POST', body: { action: 'confirm' } })).s !== 403) b.push('the processor confirmed a weight');
        }
        for (const [body, why] of [[{ action: 'confirm', lb: 'abc' }, 'lb abc'], [{ action: 'confirm', lb: 100 }, 'lb 100'], [{ action: 'confirm', lb: 30000 }, 'lb 30000'], [{ action: 'confirm', front_pct: 90 }, 'front 90'], [{ action: 'nonsense' }, 'action']]) {
          const x = await call(`/api/vehicles/${id}/weight`, { method: 'POST', body }); if (x.s !== 400) b.push(`${why}: ${x.s}`);
        }
        const none = await mkCar({ model: 'Failmodel' }); if ((await call(`/api/vehicles/${none.d.id}/weight`, { method: 'POST', body: { action: 'confirm' } })).s !== 400) b.push('confirm with no weight');
        const cf = await call(`/api/vehicles/${id}/weight`, { method: 'POST', body: { action: 'confirm' } }); if (cf.s !== 200 || cf.d.curb.status !== 'confirmed' || cf.d.curb.lb !== 2756) b.push('confirm: ' + JSON.stringify(cf.d));
        const ty = await call(`/api/vehicles/${id}/weight`, { method: 'POST', body: { action: 'confirm', lb: '2800', front_pct: 58 } }); if (ty.s !== 200 || ty.d.curb.lb !== 2800 || ty.d.curb.front_pct !== 58 || ty.d.curb.source !== 'Typed by Rick' || ty.d.curb.status !== 'confirmed') b.push('typed: ' + JSON.stringify(ty.d));
        await call(`/api/vehicles/${id}/facts`, { method: 'POST', now: new Date(Date.now() + 25 * 3600e3).toISOString(), body: {} });
        const after = (await carOf(id)).curb; if (!after || after.lb !== 2800 || after.status !== 'confirmed') b.push('a confirmed weight was replaced: ' + JSON.stringify(after));
        const cl = await call(`/api/vehicles/${id}/weight`, { method: 'POST', body: { action: 'clear' } }); if (cl.s !== 200 || cl.d.curb !== null || (await carOf(id)).curb !== null) b.push('clear');
        if ((await carOf(id)).vin !== GOOD) b.push('A SAVED VIN CHANGED');
        const pc = (await call('/api/vehicles', { as: 'proc' })).d.find(x => x.id === id); if (hasProc && pc && 'recalls' in pc) b.push('the processor list has recalls');
        const pv = hasProc ? (await call(`/api/vehicles/${id}?peek=1`, { as: 'proc' })).d : null; if (pv && ('recalls' in pv || 'curb' in pv || 'facts_due' in pv || 'vin' in pv)) b.push('the processor car has recalls, curb or a VIN key');
        ok(!b.length, b.join('; ')); return 'proposed, confirm, typed, never replaced';
      });
      await t('HANDOFF 18 C8: a car with cached facts can be deleted (its car_facts row goes with it)', async () => {
        const c = await mkCar(), id = c.d.id; await call(`/api/vehicles/${id}/facts`, { method: 'POST', body: {} });
        const d = await call('/api/vehicles/' + id, { method: 'DELETE' }); made.splice(made.indexOf(id), 1);
        ok(d.s === 200 && (await call('/api/vehicles/' + id)).s === 404, 'delete ' + d.s); return 'deleted';
      });
    } else skip('HANDOFF 18 C7/C8: recalls and curb weight through the Worker', 'local mode only (the fake NHTSA)');
  } finally {
    for (const id of made) await call('/api/vehicles/' + id, { method: 'DELETE' }).catch(() => null);
  }
} else skip('HANDOFF 18: Admin, ops log, recalls, curb weight', 'schema before 0013');

// ---------- HANDOFF 21 (F2): parts routes ----------
// The research worker posts parts only through its job result (kind parts). The processor token is refused on every other parts route and on
// deleting a car. One bad item in a result is dropped with a reason; the good items are stored (one bad item must not 400 the job).
// Every part number below is made up (they start with 99 or 98: no catalog uses them; the export gate refuses a real one): WIX 99011, Purolator PL99012,
// Mopar 9910130AB; 98001 stands for the number that a New Zealand page gives and must never be stored.
if (health.schema >= '0014' && hasProc) {
  const GOOD = '1FTFW1CT5DFC10312', made = [];
  const mkCar = async (extra = {}) => { const r = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet B', trim: 'SELFTEST B', grp: 'visitor', ...extra } }); if (r.d && r.d.id) made.push(r.d.id); return r; };
  const US1 = 'https://www.rockauto.com/en/catalog/example,2020,sample+model,2.0l+l4,1000000,engine,oil+filter', US2 = 'https://www.oreillyauto.com/shop/b/oil-filters/selftest';
  const SRC = `${US1} and ${US2}`;
  const P = (o = {}) => ({ item: 'oil_filter', choice: 'first', brand: 'WIX', part_no: '99011', confidence: 'Medium', source: SRC, ...o });
  const research = async (id, parts) => {
    const q = await call(`/api/vehicles/${id}/parts-research`, { method: 'POST', body: {} }); ok(q.s === 201 && q.d.id, 'queue ' + q.s + JSON.stringify(q.d));
    const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['parts'] } }); ok(cl.d && cl.d.id === q.d.id, 'claim ' + JSON.stringify(cl.d));
    const r = await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { parts } }); return { q, cl, r };
  };
  const carOf = async id => (await call(`/api/vehicles/${id}?peek=1`)).d;
  const partsOf = async id => (await call(`/api/vehicles/${id}/parts`)).d;
  const find = (d, item, choice) => d.parts.find(x => x.item === item && x.choice === choice);
  const why = (r, re) => r.d.drops.some(x => re.test(x.reason));
  let jeep = null, jp = null;
  try {
    await t('F2: the parts job request holds year, make, model, engine, trim and fuel only (no VIN, no owner); a claim with no kinds never gets it', async () => {
      const c = await mkCar({ vin: GOOD }); await call('/api/vehicles/' + c.d.id, { method: 'PATCH', body: { owner: 'Zed Q Owner' } });
      const q = await call(`/api/vehicles/${c.d.id}/parts-research`, { method: 'POST', body: {} }); ok(q.s === 201, 'queue ' + q.s);
      const again = await call(`/api/vehicles/${c.d.id}/parts-research`, { method: 'POST', body: {} }); ok(again.d.already === true && again.d.id === q.d.id, 'a second queue made a second job');
      ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id } })).d.none === true, 'a claim with no kinds got the parts job');
      ok((await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['research', 'workup'] } })).d.none === true, 'a research claim got the parts job');
      const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['parts'] } });
      ok(cl.d.kind === 'parts' && JSON.stringify(Object.keys(cl.d.request).sort()) === JSON.stringify(['engine', 'fuel', 'make', 'model', 'trim', 'year']), 'request keys ' + JSON.stringify(cl.d.request));
      ok(!JSON.stringify(cl.d).includes(GOOD) && !/Zed/.test(JSON.stringify(cl.d)), 'the claim holds the VIN or the owner');
      ok((await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { parts: [] } })).s === 200, 'empty result');
      return 'six keys';
    });
    await t('F2: a result must be a list; one bad item is dropped with its reason and the good item is stored (not a 400 for the job)', async () => {
      const c = await mkCar(); jeep = c.d.id;
      const bad1 = await call('/api/vehicles/' + jeep + '/parts-research', { method: 'POST', body: {} });
      const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: bad1.d.id, kinds: ['parts'] } });
      ok((await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { values: [] } })).s === 400, 'no parts list');
      const r = await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { parts: [P({ item: 'bogus' }), P()] } });
      ok(r.s === 200 && r.d.proposed === 1 && r.d.drops.length === 1 && /unknown item/.test(r.d.drops[0].reason), 'bad+good ' + r.s + JSON.stringify(r.d));
      const d = await partsOf(jeep), o = find(d, 'oil_filter', 'first'); ok(o && o.part_no === '99011' && o.confidence === 'Medium' && o.status === 'proposed' && o.check_car === 1 && o.job_id === cl.d.id, JSON.stringify(o));
      const job = (await carOf(jeep)).jobs.find(j => j.id === cl.d.id); ok(job && job.status === 'done' && /1 proposed part\(s\), 1 dropped/.test(job.result_summary), JSON.stringify(job));
      ok((await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { parts: [P()] } })).s === 409, 'a done job took a second result');
      return 'bad dropped, good stored';
    });
    await t('F2: grading case - WIX 99011 / Purolator PL99012 / Mopar 9910130AB from US sources; the New Zealand page number 98001 is dropped as non-US and never stored', async () => {
      const c = await mkCar({ trim: 'SELFTEST B' }); jp = c.d.id;
      const r = (await research(jp, [P({ source: 'https://www.wixfilters.com/en-nz/filters/98001' }), P({ choice: 'other', brand: 'Purolator', part_no: 'PL99012' }),
        P({ choice: 'oem', brand: 'Mopar', part_no: '9910130AB', also_fits: '09910130AA' }), P({ part_no: '99011', also_fits: '99011XP' })])).r;
      ok(r.s === 200 && r.d.proposed === 3 && r.d.drops.length === 1 && /non-US source/.test(r.d.drops[0].reason), JSON.stringify(r.d));
      const d = await partsOf(jp), nos = d.parts.map(x => x.part_no).sort(); ok(JSON.stringify(nos) === JSON.stringify(['99011', '9910130AB', 'PL99012']), 'stored ' + nos);
      ok(!JSON.stringify(d).includes('98001') && find(d, 'oil_filter', 'first').also_fits === '99011XP' && d.parts.every(x => x.confidence === 'Medium' && x.check_car === 1 && x.status === 'proposed'), JSON.stringify(d.parts));
      return 'three stored, 98001 dropped';
    });
    await t('F2: every server check drops its item with a reason (no URL, memory only, High part number, wrong brand, non-US host, locale path, size, missing size, no number, High fluid from the web, conflict not Low, slot twice)', async () => {
      const c = await mkCar(), id = c.d.id;
      const r = (await research(id, [
        P({ source: 'from my memory, WIX 99011' }), P({ choice: 'other', brand: 'Purolator', part_no: 'PL99012', confidence: 'High' }), P({ item: 'cabin_air_filter', brand: 'Purolator' }),
        P({ item: 'engine_air_filter', source: 'https://www.wixfilters.co.nz/x and ' + US1 }), P({ item: 'cabin_air_filter', choice: 'other', brand: 'Purolator', part_no: 'C35667', source: 'https://www.example.com/en-nz/a ' + US1 }),
        { item: 'wiper_driver', choice: 'first', brand: 'Bosch', size_in: 40, confidence: 'Low', source: US1 }, { item: 'wiper_passenger', choice: 'first', brand: 'Bosch', confidence: 'Low', source: US1 },
        P({ item: 'engine_air_filter', choice: 'other', brand: 'Purolator', part_no: '' }), { item: 'brake_fluid', choice: 'spec', spec_text: 'DOT 4', confidence: 'High', source: 'https://www.example.com/us/brake-fluid' },
        P({ choice: 'oem', brand: 'Mopar', part_no: '9910130AB', conflict_no: '9910130AA' }), P({ item: 'cabin_air_filter', part_no: '99015' }), P({ item: 'cabin_air_filter', part_no: '99015XP' }),
        P({ item: 'oil_filter', choice: 'first', part_no: 'bad!!no' }), { item: 'wiper_rear', choice: 'other', brand: 'Rain-X', size_in: 12, confidence: 'Low', source: US1 }])).r;
      const want = [/no source/, /never High/, /must be WIX/, /non-US/, /non-US/, /8 to 32/, /size in inches/, /needs a part number/, /manual page/, /always Low/, /twice/, /not a part number/];
      ok(r.s === 200, 'status ' + r.s); const miss = want.filter(re => !why(r, re)); ok(!miss.length, 'no drop for ' + miss + ' in ' + JSON.stringify(r.d.drops));
      const wr = find(await partsOf(id), 'wiper_rear', 'other');
      ok(r.d.proposed === 2 && wr && wr.size_in === 12 && wr.part_no === '' && wr.brand === 'Rain-X', 'the size-only Rain-X wiper was not stored ' + JSON.stringify(r.d));
      return `${r.d.drops.length} dropped, ${r.d.proposed} stored`;
    });
    await t('F2: a fluid from an owner-manual page may be High, a part number never; a conflict stores one row with conflict_no and confidence Low', async () => {
      const c = await mkCar(), id = c.d.id;
      const r = (await research(id, [{ item: 'brake_fluid', choice: 'spec', spec_text: 'DOT 4', confidence: 'High', source: 'Owner manual p.312 (selftest)' },
        { item: 'coolant', choice: 'spec', spec_text: 'OAT, selftest spec', confidence: 'Medium', source: US1 }, P({ part_no: '99011', conflict_no: '98002', confidence: 'Low', source: US1 + ' says 99011; ' + US2 + ' says 98002' })])).r;
      ok(r.s === 200 && r.d.proposed === 3 && !r.d.drops.length, JSON.stringify(r.d));
      const d = await partsOf(id), bf = find(d, 'brake_fluid', 'spec'), o = find(d, 'oil_filter', 'first');
      ok(bf.confidence === 'High' && bf.part_no === '' && o.conflict_no === '98002' && o.confidence === 'Low' && o.part_no === '99011', JSON.stringify([bf, o]));
      return 'manual High fluid, conflict row';
    });
    await t('F2: an electric car has no oil filter or engine air filter; its coolant needs a manual page', async () => {
      const c = await mkCar(), id = c.d.id; await call('/api/vehicles/' + id, { method: 'PATCH', body: { fuel: 'ev' } });
      const r = (await research(id, [P(), P({ item: 'engine_air_filter', part_no: '99014' }), P({ item: 'cabin_air_filter', part_no: '99015' }),
        { item: 'coolant', choice: 'spec', spec_text: 'selftest', confidence: 'Medium', source: US1 }, { item: 'brake_fluid', choice: 'spec', spec_text: 'DOT 4', confidence: 'Medium', source: US1 }])).r;
      ok(r.d.proposed === 2 && r.d.drops.length === 3 && r.d.drops.filter(x => /does not apply to an electric car/.test(x.reason)).length === 2 && r.d.drops.some(x => x.item === 'coolant/spec' && /manual page/.test(x.reason)), JSON.stringify(r.d));
      const d = await partsOf(id); ok(!d.applies.includes('oil_filter') && !d.applies.includes('engine_air_filter') && d.applies.includes('cabin_air_filter') && d.fuel === 'ev', JSON.stringify(d.applies));
      return 'EV items';
    });
    await t('F2: Rick confirms (check flag off, history row), a confirm is not repeated, a new search never overwrites a confirmed part and replaces a proposed one (with history), reject frees the slot', async () => {
      const b = [], d0 = await partsOf(jp), o = find(d0, 'oil_filter', 'first'), ch = find(d0, 'oil_filter', 'other');
      const cf = await call(`/api/parts/${o.id}/confirm`, { method: 'POST', body: {} }); if (cf.s !== 200 || cf.d.part.status !== 'confirmed' || cf.d.part.check_car !== 0 || !cf.d.part.confirmed_at || !cf.d.part.confirmed_by) b.push('confirm ' + JSON.stringify(cf.d));
      if ((await call(`/api/parts/${o.id}/confirm`, { method: 'POST', body: {} })).s !== 409) b.push('a confirm was repeated');
      const r = (await research(jp, [P({ part_no: '99999' }), P({ choice: 'other', brand: 'Purolator', part_no: 'PL99999' })])).r;
      if (r.d.skipped !== 1 || r.d.proposed !== 1) b.push('re-search ' + JSON.stringify(r.d));
      const d1 = await partsOf(jp); if (find(d1, 'oil_filter', 'first').part_no !== '99011' || find(d1, 'oil_filter', 'first').status !== 'confirmed') b.push('a confirmed part was overwritten');
      const ch1 = find(d1, 'oil_filter', 'other'); if (ch1.id !== ch.id || ch1.part_no !== 'PL99999' || ch1.check_car !== 1) b.push('the proposed row was not replaced in place ' + JSON.stringify(ch1));
      const h = (await call(`/api/parts/${ch.id}/history`)).d; if (JSON.stringify(h.map(x => x.action)) !== JSON.stringify(['insert', 'update']) || !/PL99012/.test(h[1].old_json) || !/PL99999/.test(h[1].new_json)) b.push('history ' + JSON.stringify(h.map(x => x.action)));
      const rj = await call(`/api/parts/${ch.id}/reject`, { method: 'POST', body: {} }); if (rj.s !== 200 || rj.d.part.status !== 'rejected') b.push('reject');
      if (find(await partsOf(jp), 'oil_filter', 'other')) b.push('a rejected part is still listed');
      const r2 = (await research(jp, [P({ choice: 'other', brand: 'Purolator', part_no: 'PL99012' })])).r; const n = find(await partsOf(jp), 'oil_filter', 'other');
      if (r2.d.proposed !== 1 || !n || n.id === ch.id || n.part_no !== 'PL99012') b.push('the freed slot did not take a new row ' + JSON.stringify(r2.d));
      const ho = (await call(`/api/parts/${o.id}/history`)).d; if (JSON.stringify(ho.map(x => x.action)) !== JSON.stringify(['insert', 'confirm'])) b.push('confirm history ' + JSON.stringify(ho.map(x => x.action)));
      ok(!b.length, b.join('; ')); return 'confirm, replace, reject';
    });
    await t('F2: Rick edits a part (shape, size, High and empty checks) with a history row, and deletes one (history row kept)', async () => {
      const b = [], d0 = await partsOf(jp), o = find(d0, 'oil_filter', 'first');
      const e = await call(`/api/parts/${o.id}`, { method: 'PATCH', body: { part_no: 'wix 99011xp', source: 'Rick typed it' } }); if (e.s !== 200 || e.d.part.part_no !== 'WIX 99011XP' || e.d.part.source !== 'Rick typed it' || e.d.part.status !== 'confirmed') b.push('edit ' + e.s + JSON.stringify(e.d));
      for (const [body, why2] of [[{ part_no: 'bad!!no' }, 'shape'], [{ confidence: 'High' }, 'High on a number'], [{ confidence: 'Sure' }, 'confidence'], [{ size_in: 40 }, 'size 40'], [{ size_in: 'big' }, 'size text'], [{}, 'empty']]) {
        const x = await call(`/api/parts/${o.id}`, { method: 'PATCH', body }); if (x.s !== 400) b.push(`${why2}: ${x.s}`);
      }
      if ((await call('/api/parts/99999999', { method: 'PATCH', body: { part_no: '1234' } })).s !== 404) b.push('missing part');
      const ho = (await call(`/api/parts/${o.id}/history`)).d; if (ho.map(x => x.action).join() !== 'insert,confirm,update' || !/99011"/.test(ho[2].old_json) || !/WIX 99011XP/.test(ho[2].new_json)) b.push('edit history ' + ho.map(x => x.action));
      const del = find(await partsOf(jp), 'oil_filter', 'other'); const dl = await call(`/api/parts/${del.id}`, { method: 'DELETE' }); if (dl.s !== 200) b.push('delete ' + dl.s);
      if (find(await partsOf(jp), 'oil_filter', 'other')) b.push('deleted part still listed');
      const hd = (await call(`/api/parts/${del.id}/history`)).d; if (hd[hd.length - 1].action !== 'delete' || !/PL99012/.test(hd[hd.length - 1].old_json)) b.push('delete history');
      ok(!b.length, b.join('; ')); return 'edit, delete, history';
    });
    await t('F2 review 3: Rick\'s edit keeps the per-item rules - a wiper keeps a size 8 to 32, a filter keeps its part number, a fluid keeps its spec text (400 otherwise, nothing changes)', async () => {
      const b = [], c = await mkCar(), id = c.d.id;
      const r = (await research(id, [P(), { item: 'wiper_driver', choice: 'first', brand: 'Bosch', size_in: 22, confidence: 'Medium', source: SRC },
        { item: 'coolant', choice: 'spec', brand: '', spec_text: 'test coolant spec', confidence: 'Medium', source: SRC }])).r; ok(r.d.proposed === 3, JSON.stringify(r.d));
      const d0 = await partsOf(id), f = find(d0, 'oil_filter', 'first'), w = find(d0, 'wiper_driver', 'first'), fl = find(d0, 'coolant', 'spec'), before = JSON.stringify(d0.parts);
      for (const [pid, body, why2] of [[w.id, { size_in: null }, 'wiper size null'], [w.id, { size_in: '' }, 'wiper size empty'], [w.id, { size_in: '18in' }, 'wiper size text'], [f.id, { part_no: '' }, 'filter number cleared'], [fl.id, { spec_text: '' }, 'fluid spec cleared']]) {
        const x = await call(`/api/parts/${pid}`, { method: 'PATCH', body }); if (x.s !== 400) b.push(`${why2}: ${x.s}`);
      }
      if (JSON.stringify((await partsOf(id)).parts) !== before) b.push('a refused edit changed a part');
      const okw = await call(`/api/parts/${w.id}`, { method: 'PATCH', body: { size_in: 18 } }); if (okw.s !== 200 || okw.d.part.size_in !== 18) b.push('a valid size was refused');
      ok(!b.length, b.join('; ')); return 'wiper, filter, fluid';
    });
    await t('F2 review 7: a .co address and a /catalog/ac-dc/ path are US sources; /en-nz/ and .co.nz are dropped as non-US', async () => {
      const b = [], c = await mkCar(), id = c.d.id;
      const r = (await research(id, [P({ source: 'https://www.partsgeek.co/catalog/x and ' + US1 }), P({ choice: 'other', brand: 'Purolator', part_no: 'PL99012', source: 'https://www.rockauto.com/en/catalog/ac-dc/x and ' + US1 }),
        P({ item: 'cabin_air_filter', part_no: '99021', source: 'https://www.wixfilters.com/en-nz/f/1 and ' + US1 }), P({ item: 'engine_air_filter', part_no: '99031', source: 'https://www.wixfilters.co.nz/x and ' + US1 })])).r;
      if (r.d.proposed !== 2 || r.d.drops.length !== 2 || !r.d.drops.every(x => /non-US/.test(x.reason))) b.push(JSON.stringify(r.d));
      ok(!b.length, b.join('; ')); return 'short lists';
    });
    await t('F2 Opus 4: deleting a car closes its open parts job (a claim for it finds nothing), so no paid result can land on a car that gets the same id later', async () => {
      const b = [], c = await mkCar(), id = c.d.id;
      const q = await call(`/api/vehicles/${id}/parts-research`, { method: 'POST', body: {} }); if (q.s !== 201) b.push('queue ' + q.s);
      if ((await call('/api/vehicles/' + id, { method: 'DELETE' })).s !== 200) b.push('delete');
      const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['parts'] } });
      if (!cl.d || cl.d.none !== true) b.push('the job of a deleted car was still claimable: ' + JSON.stringify(cl.d).slice(0, 120));
      ok(!b.length, b.join('; ')); return 'job closed with the car';
    });
    await t('F2 Opus 7: the self-test token cannot turn a real car into a SELFTEST car, and cannot start a parts search on a car that is not one', async () => {
      const b = [], c = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet B', trim: 'Plain Real', grp: 'visitor' } }); ok(c.s === 201 || c.s === 200, 'create ' + c.s); made.push(c.d.id);
      const t1 = await call('/api/vehicles/' + c.d.id, { method: 'PATCH', body: { trim: 'SELFTEST Z' } }); if (t1.s !== 403) b.push('trim to SELFTEST: ' + t1.s);
      const t2 = await call(`/api/vehicles/${c.d.id}/parts-research`, { method: 'POST', body: {} }); if (t2.s !== 403) b.push('parts search: ' + t2.s);
      ok(!b.length, b.join('; ')); return '403, 403';
    });
    await t('F2 seed: the tool token may queue a parts search on a real car only with {"seed":true} (the live seed of "yes research parts"); the answer of GET /parts says seed support; the test claims and closes its own job at once', async () => {
      const b = [], c = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet B', trim: 'Plain Seed', grp: 'visitor' } }); ok(c.s === 201 || c.s === 200, 'create ' + c.s); made.push(c.d.id);
      if ((await partsOf(c.d.id)).seed !== true) b.push('GET /parts does not say seed: true');
      for (const [body, why2] of [[{}, 'no flag'], [{ seed: 'yes' }, 'seed not true'], [{ seed: false }, 'seed false']]) { const x = await call(`/api/vehicles/${c.d.id}/parts-research`, { method: 'POST', body }); if (x.s !== 403) b.push(`${why2}: ${x.s}`); }
      const q = await call(`/api/vehicles/${c.d.id}/parts-research`, { method: 'POST', body: { seed: true } }); if (q.s !== 201 || !q.d.id) b.push('seed queue ' + q.s + JSON.stringify(q.d));
      if (q.d && q.d.id) {
        const q2 = await call(`/api/vehicles/${c.d.id}/parts-research`, { method: 'POST', body: { seed: true } }); if (!q2.d || q2.d.already !== true) b.push('a second seed call made a second job');
        const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['parts'] } });
        if (!cl.d || cl.d.id !== q.d.id || JSON.stringify(Object.keys(cl.d.request || {}).sort()) !== JSON.stringify(['engine', 'fuel', 'make', 'model', 'trim', 'year'])) b.push('claim ' + JSON.stringify(cl.d).slice(0, 160));
        else if ((await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { parts: [] } })).s !== 200) b.push('the test job could not be closed');
      }
      ok(!b.length, b.join('; ')); return 'seed flag';
    });
    await t('F2 Opus 8: High is only for a fluid - a wiper that carries a number only in also-fits cannot be High (research drops it, an edit is refused)', async () => {
      const b = [], c = await mkCar(), id = c.d.id;
      const r = (await research(id, [{ item: 'wiper_driver', choice: 'first', brand: 'Bosch', size_in: 22, also_fits: '99022', confidence: 'High', source: SRC }])).r;
      if (r.d.proposed !== 0 || !why(r, /never High/)) b.push('result ' + JSON.stringify(r.d));
      const r2 = (await research(id, [{ item: 'wiper_driver', choice: 'first', brand: 'Bosch', size_in: 22, also_fits: '99022', confidence: 'Medium', source: SRC }])).r; if (r2.d.proposed !== 1) b.push('medium ' + JSON.stringify(r2.d));
      const w = find(await partsOf(id), 'wiper_driver', 'first'); const e = await call(`/api/parts/${w.id}`, { method: 'PATCH', body: { confidence: 'High' } }); if (e.s !== 400) b.push('edit to High: ' + e.s);
      ok(!b.length, b.join('; ')); return 'never High';
    });
    await t('F2 review 5: Find parts does not overwrite a proposed row that Rick edited; a different number goes to conflict_no (Low) with a note; the skip is counted as edited by Rick', async () => {
      const b = [], c = await mkCar(), id = c.d.id;
      await research(id, [P()]); const o = find(await partsOf(id), 'oil_filter', 'first');
      const e = await call(`/api/parts/${o.id}`, { method: 'PATCH', body: { part_no: '99011XP' } }); if (e.s !== 200 || e.d.part.status !== 'proposed') b.push('edit ' + e.s);
      const r = (await research(id, [P({ part_no: '99077' })])).r;
      if (r.d.skipped !== 1 || r.d.skipped_edited !== 1 || r.d.proposed !== 0) b.push('counts ' + JSON.stringify(r.d));
      const n = find(await partsOf(id), 'oil_filter', 'first');
      if (n.part_no !== '99011XP' || n.conflict_no !== '99077' || n.confidence !== 'Low' || !/Find parts later found 99077/.test(n.source) || n.check_car !== 1) b.push('row ' + JSON.stringify(n));
      const r2 = (await research(id, [P({ part_no: '99077' })])).r; if (r2.d.skipped_edited !== 1) b.push('second search ' + JSON.stringify(r2.d));
      const r3 = (await research(id, [P({ part_no: '99011XP' })])).r; const n3 = find(await partsOf(id), 'oil_filter', 'first'); if (r3.d.skipped_edited !== 1 || n3.part_no !== '99011XP') b.push('same number ' + JSON.stringify(r3.d));
      ok(!b.length, b.join('; ')); return 'edited row kept, conflict shown';
    });
    await t('F2: the processor token is refused (403) on every parts route and on deleting a car; nothing changes', async () => {
      const b = [], d0 = await partsOf(jp), o = find(d0, 'oil_filter', 'first'), before = JSON.stringify(d0.parts);
      for (const [p, m, body] of [[`/api/vehicles/${jp}/parts`, 'GET'], [`/api/vehicles/${jp}/parts-research`, 'POST', {}], [`/api/parts/${o.id}/confirm`, 'POST', {}], [`/api/parts/${o.id}/reject`, 'POST', {}],
        [`/api/parts/${o.id}`, 'PATCH', { part_no: '1234' }], [`/api/parts/${o.id}`, 'DELETE'], [`/api/parts/${o.id}/history`, 'GET'], [`/api/vehicles/${jp}`, 'DELETE']]) {
        const x = await call(p, { as: 'proc', method: m, body }); if (x.s !== 403) b.push(`${m} ${p}: ${x.s}`);
      }
      if ((await call(`/api/vehicles/${jp}`)).s !== 200 || JSON.stringify((await partsOf(jp)).parts) !== before) b.push('the car or its parts changed');
      if (LOCAL) for (const as of ['forged', 'expired']) if ((await call(`/api/parts/${o.id}/confirm`, { as, method: 'POST', body: {} })).s !== 403) b.push(as + ' token confirmed');   // a live run cannot sign a token (Access refuses those before the Worker)
      ok(!b.length, b.join('; ')); return '8 routes, 403 each';
    });
    await t('F2: the self-test tool token may confirm, reject, edit or delete a part ONLY on a SELFTEST car (403 on any other car, nothing changes); Rick\'s login may', async () => {
      const b = [], c = await mkCar(), id = c.d.id;
      const r = (await research(id, [P(), P({ choice: 'other', brand: 'Purolator', part_no: 'PL99012' })])).r; ok(r.d.proposed === 2, JSON.stringify(r.d));
      const d0 = await partsOf(id), o = find(d0, 'oil_filter', 'first'), ch = find(d0, 'oil_filter', 'other');
      try {
        ok((await call('/api/vehicles/' + id, { method: 'PATCH', body: { trim: 'Plain' } })).s === 200, 'the trim change');   // a car that is not a SELFTEST car
        const before = JSON.stringify((await partsOf(id)).parts);
        for (const [p, m, body] of [[`/api/parts/${o.id}/confirm`, 'POST', {}], [`/api/parts/${o.id}/reject`, 'POST', {}], [`/api/parts/${o.id}`, 'PATCH', { part_no: '1234' }], [`/api/parts/${o.id}`, 'DELETE']]) {
          const x = await call(p, { method: m, body }); if (x.s !== 403) b.push(`tool ${m} ${p}: ${x.s}`);
        }
        if (JSON.stringify((await partsOf(id)).parts) !== before) b.push('a part changed');
        if (LOCAL) {   // Rick's own login (a phone) is not gated
          const cf = await call(`/api/parts/${o.id}/confirm`, { as: 'phone', method: 'POST', body: {} }); if (cf.s !== 200 || cf.d.part.status !== 'confirmed') b.push('Rick confirm ' + cf.s);
          const pe = await call(`/api/parts/${ch.id}`, { as: 'phone', method: 'PATCH', body: { source: 'Rick typed it' } }); if (pe.s !== 200) b.push('Rick edit ' + pe.s);
          if ((await call(`/api/parts/${ch.id}/reject`, { as: 'phone', method: 'POST', body: {} })).s !== 200) b.push('Rick reject');
          if ((await call(`/api/parts/${o.id}`, { as: 'phone', method: 'DELETE' })).s !== 200) b.push('Rick delete');
        }
      } finally { await call('/api/vehicles/' + id, { method: 'PATCH', body: { trim: 'SELFTEST B' } }); }
      const back = await call(`/api/parts/${(find(await partsOf(id), 'oil_filter', 'first') || { id: 0 }).id}/confirm`, { method: 'POST', body: {} });
      if (!LOCAL && back.s !== 200) b.push('on a SELFTEST car the tool token was refused: ' + back.s);
      ok(!b.length, b.join('; ')); return 'tool refused off SELFTEST cars';
    });
    await t('F2: the processor may post parts only for a job it has claimed (an unclaimed or another job is 409), and the result needs a car', async () => {
      const q = await call(`/api/vehicles/${jp}/parts-research`, { method: 'POST', body: {} });
      ok((await call(`/api/jobs/${q.d.id}/result`, { as: 'proc', method: 'POST', body: { parts: [P()] } })).s === 409, 'a queued job took a result');
      const cl = await call('/api/jobs/claim', { as: 'proc', method: 'POST', body: { only_id: q.d.id, kinds: ['parts'] } });
      ok((await call(`/api/jobs/${cl.d.id}/result`, { as: 'proc', method: 'POST', body: { parts: new Array(41).fill(P()) } })).s === 400, 'more than 40 parts');
      ok((await call(`/api/jobs/${cl.d.id}/fail`, { as: 'proc', method: 'POST', body: { error: 'selftest cleanup' } })).s === 200, 'fail'); return 'claim rule';
    });
    await t('F2: deleting a car removes its parts rows (no foreign key stop) and the car is gone', async () => {
      ok((await partsOf(jp)).parts.length >= 2, 'the car holds no parts rows, so the delete proves nothing');
      const d = await call('/api/vehicles/' + jp, { method: 'DELETE' }); made.splice(made.indexOf(jp), 1);
      ok(d.s === 200 && (await call('/api/vehicles/' + jp)).s === 404, 'delete ' + d.s + JSON.stringify(d.d)); return 'deleted with parts';
    });
  } finally {
    for (const id of made) await call('/api/vehicles/' + id, { method: 'DELETE' }).catch(() => null);
  }
} else skip('HANDOFF 21 F2: parts routes', health.schema >= '0014' ? 'no processor token' : 'schema before 0014');

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
  // HANDOFF 19: the jobs the run failed on purpose go too, so the Admin page shows no PROBLEM from test jobs (HANDOFF 18 C3 counts failed jobs of the last 24 hours).
  { const sw = await tc('/api/jobs/selftest', { method: 'DELETE' }); chk(sw.s === 200, 'remove the failed test jobs ' + sw.s); const sw2 = await tc('/api/jobs/selftest', { method: 'DELETE' }); chk(sw2.s === 200 && sw2.d.removed === 0, 'a failed test job is left: ' + JSON.stringify(sw2.d)); }
  ok(!bad2.length, bad2.join('; '));
});
await t('sweep after the run: no SELFTEST car is left', async () => { const r = await sweep(); ok(!r.bad.length && r.still === 0, `${r.bad.join('; ')} still ${r.still}`); return `${r.n} removed by the sweep`; });
// HANDOFF 17 (B0, Rick 2026-10-27): a self-test or rehearsal run must stay small. Measured, not estimated: the sum of D1 meta.rows_written over
// every tool-token request of this run (temp cars, values, history rows, visits and their deletes; the full seed is NOT part of it).
await t('B0: this run wrote under 2,000 rows to D1 (measured from D1 meta)', async () => {
  ok(ROWS.seen > 0, 'NOT MEASURED: no response carried x-lp-rows-written');
  const max = +(process.env.LP_ROWS_MAX || 2000);
  ok(ROWS.n < max, `rows_written ${ROWS.n} over ${ROWS.seen} requests, limit ${max}`);
  return `rows_written ${ROWS.n} over ${ROWS.seen} requests (limit ${max})`;
});
if (srv) srv.close();
if (feSrv) feSrv.close();

const pass = res.filter(r => r.ok).length, skipped = res.filter(r => r.skip).length, fail = res.length - pass - skipped;
const rep = `# LiftPad self-test\n\nTarget: ${BASE}\nTime: ${new Date().toISOString()}\nMode: ${LOCAL ? 'local (self-signed JWTs)' : 'live (service tokens)'}\nPrivate checks: ${priv ? 'yes' : 'no'}\nResult: ${pass}/${res.length - skipped} passed, ${skipped} skipped, ${fail} failed\n\n` +
  res.map(r => `- ${r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.m ? ' - ' + r.m : ''}`).join('\n') + '\n';
console.log(rep); if (process.argv[3]) writeFileSync(process.argv[3], rep);
process.exit(fail === 0 ? 0 : 1);
