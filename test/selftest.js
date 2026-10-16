// LiftPad self-test. Usage: node test/selftest.js <base-url> [report-file]
// For a site behind Cloudflare Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (a service token).
// Optional: LP_PRIVATE_TESTS=<path to a .mjs file> adds checks for your own data (see README).
// Classics checks are skipped when the database has no classics rows (a public-seed build).
// Makes one temporary car and deletes it again. Exit code 0 = no check failed.
import { writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const H = { 'content-type': 'application/json' };
if (process.env.CF_ACCESS_CLIENT_ID) { H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID; H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET; }
const res = []; let tmp;
const call = async (p, o = {}) => { const r = await fetch(BASE + p, { headers: H, ...o, body: o.body ? JSON.stringify(o.body) : undefined }); let d; try { d = await r.json(); } catch { d = null; } return { s: r.status, d, r }; };
async function t(name, fn) { try { const m = await fn(); res.push({ name, ok: true, m: m || '' }); } catch (e) { res.push({ name, ok: false, m: e.message }); } }
const skip = (name, why) => res.push({ name, skip: true, m: why });
const ok = (c, m) => { if (!c) throw new Error(m); };

const PRIV = process.env.LP_PRIVATE_TESTS;
if (PRIV && !existsSync(PRIV)) { console.error('LP_PRIVATE_TESTS file not found: ' + PRIV); process.exit(2); }
const priv = PRIV ? await import(pathToFileURL(PRIV).href) : null;

let health = {};
await t('health: API answers', async () => {
  const { s, d } = await call('/api/health'); ok(s === 200 && d && d.ok === true && d.m >= 1, JSON.stringify(d)); health = d;
  const min = priv?.minCounts; if (min) ok(d.a >= min.a && d.c >= min.c && d.v >= min.v, 'below minCounts ' + JSON.stringify(min) + ': ' + JSON.stringify(d));
  return `lift-guide rows ${d.a}, classics ${d.c}, cars ${d.v}, makes ${d.m}`;
});
await t('app page loads', async () => { const r = await fetch(BASE + '/', { headers: H }); const x = await r.text(); ok(r.status === 200 && x.includes('LiftPad'), 'status ' + r.status); });
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
if (priv) await priv.default({ t, call, ok });
await t('add car, add value, edit, delete (temp)', async () => {
  let r = await call('/api/vehicles', { method: 'POST', body: { year: 1973, make: 'AMC', model: 'Hornet', trim: 'SELFTEST' } }); ok(r.s === 201, 'create ' + r.s); tmp = r.d.id;
  r = await call(`/api/vehicles/${tmp}/specs`, { method: 'POST', body: { tab: 'torque', field: 'Torque', value: '75 ft-lb', confidence: 'Low', source: 'selftest' } }); ok(r.s === 201 && r.d.specs.length === 1, 'spec ' + r.s);
  const sid = r.d.specs[0].id; r = await call('/api/specs/' + sid, { method: 'PATCH', body: { confidence: 'High' } }); ok(r.s === 200, 'patch ' + r.s);
  r = await call('/api/specs/' + sid, { method: 'PATCH', body: { confidence: 'Sure' } }); ok(r.s === 400, 'bad confidence accepted');
  r = await call(`/api/vehicles/${tmp}/specs`, { method: 'POST', body: { tab: 'paint', field: 'x', value: 'y', confidence: 'Low' } }); ok(r.s === 400, 'bad tab accepted');
});
await t('cleanup temp car', async () => { if (!tmp) return 'none'; const r = await call('/api/vehicles/' + tmp, { method: 'DELETE' }); ok(r.s === 200, 'delete ' + r.s); ok((await call('/api/vehicles/' + tmp)).s === 404, 'still there'); });

const pass = res.filter(r => r.ok).length, skipped = res.filter(r => r.skip).length, fail = res.length - pass - skipped;
const rep = `# LiftPad self-test\n\nTarget: ${BASE}\nTime: ${new Date().toISOString()}\nPrivate checks: ${priv ? 'yes' : 'no'}\nResult: ${pass}/${res.length - skipped} passed, ${skipped} skipped, ${fail} failed\n\n` +
  res.map(r => `- ${r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.m ? ' - ' + r.m : ''}`).join('\n') + '\n';
console.log(rep); if (process.argv[3]) writeFileSync(process.argv[3], rep);
process.exit(fail === 0 ? 0 : 1);
