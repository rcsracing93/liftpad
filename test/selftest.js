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
import { createServer } from 'node:http';
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
await t('schema is at migration 0002 or later', async () => { ok(String(health.schema) >= '0002', 'schema ' + health.schema); });
await t('app page loads', async () => { const r = await fetch(BASE + '/', { headers: hdr('tool') }); const x = await r.text(); ok(r.status === 200 && x.includes('LiftPad'), 'status ' + r.status); });
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
await t('cleanup: temp values (history kept) and temp car removed', async () => {
  for (const [k, id] of cleanup.reverse()) if (k === 'val') { const s = (await call(`/api/values/${id}`, { method: 'DELETE' })).s; ok(s === 200 || s === 404, 'delete value ' + s); }
  const h = (await call(`/api/values/${valId}/history`)).d; ok(h[h.length - 1].action === 'delete', 'no delete history row');
  if (car) { ok((await call('/api/vehicles/' + car, { method: 'DELETE' })).s === 200, 'delete car'); ok((await call('/api/vehicles/' + car)).s === 404, 'car still there'); }
});
if (srv) srv.close();

const pass = res.filter(r => r.ok).length, skipped = res.filter(r => r.skip).length, fail = res.length - pass - skipped;
const rep = `# LiftPad self-test\n\nTarget: ${BASE}\nTime: ${new Date().toISOString()}\nMode: ${LOCAL ? 'local (self-signed JWTs)' : 'live (service tokens)'}\nPrivate checks: ${priv ? 'yes' : 'no'}\nResult: ${pass}/${res.length - skipped} passed, ${skipped} skipped, ${fail} failed\n\n` +
  res.map(r => `- ${r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.m ? ' - ' + r.m : ''}`).join('\n') + '\n';
console.log(rep); if (process.argv[3]) writeFileSync(process.argv[3], rep);
process.exit(fail === 0 ? 0 : 1);
