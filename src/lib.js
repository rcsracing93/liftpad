// Pure helpers for Handoff B (HANDOFF 17): the VIN check digit and mask, and the parsers for fueleconomy.gov and the NHTSA
// Canadian specs. No network and no database here, so a node test can run them on saved answers.

// ---------- VIN ----------
// ISO 3779: transliteration of letters, position weights, remainder 10 = X. Position 9 holds the check digit.
const TRANS = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/;
// null when the text is not a 17-character VIN shape, else true (check digit passes) or false (fails).
export function vinCheckDigit(vin) {
  const v = String(vin || '').trim().toUpperCase();
  if (!VIN_SHAPE.test(v)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = v[i], n = /\d/.test(c) ? +c : TRANS[c];
    sum += n * WEIGHTS[i];
  }
  const r = sum % 11;
  return v[8] === (r === 10 ? 'X' : String(r));
}
// Every run of 5 or more letters and digits that could be (part of) a VIN is masked to its last 4. Used for logs and error text.
export const maskVin = s => String(s ?? '').replace(/[A-HJ-NPR-Z0-9]{5,}/gi, m => '*'.repeat(m.length - 4) + m.slice(-4));

// ---------- fueleconomy.gov ----------
// A menu answer is a list, one object, or null: always a list of { text, value }.
export function feItems(data) {
  if (!data || typeof data !== 'object') return [];
  const m = data.menuItem;
  if (m === undefined || m === null) return [];
  return (Array.isArray(m) ? m : [m]).map(i => ({ text: String(i.text ?? ''), value: String(i.value ?? '') })).filter(i => i.text);
}
// "Auto 8-spd, 8 cyl, 5.7 L" -> { disp: '5.7', cyl: 8 }. Also reads "4.6 L V8". An electric option has neither: null.
export function feEngine(text) {
  const t = String(text || '');
  const d = t.match(/(\d+(?:\.\d+)?)\s*L\b/i);
  const c = t.match(/(\d+)\s*cyl/i) || t.match(/\bV(\d+)\b/i);
  if (!d) return null;
  return { disp: (+d[1]).toFixed(1), cyl: c ? +c[1] : null };
}
// The vPIC decode gives displacement, cylinders and electrification. Exactly one option must match, else null (the dropdown is shown).
export function matchFeOption(options, dec) {
  if (!options.length || !dec) return null;
  let hit;
  if (dec.ev) hit = options.filter(o => !feEngine(o.text));
  else {
    const disp = dec.disp && Number.isFinite(+dec.disp) && +dec.disp > 0 ? (+dec.disp).toFixed(1) : null;
    if (!disp) return null;
    hit = options.filter(o => { const e = feEngine(o.text); return e && e.disp === disp && (!dec.cyl || !e.cyl || e.cyl === +dec.cyl); });
  }
  return hit.length === 1 ? hit[0] : null;
}
// ---------- Engine key (Rick 2026-10-27) ----------
// Engines are matched by a normalized key, never by exact text, so "2.0 L", "2.0L" and the list's "Auto (variable gear ratios), 4 cyl, 2.0 L"
// are one engine, and a later pick from the list or another spelling never hides a value. The key is displacement + cylinders (when the text
// names them) + turbo/supercharged + electric. null = the text names no engine we can read (it then matches only itself, ignoring case and spacing).
export function engineKey(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const d = t.match(/(\d+(?:\.\d+)?)\s*(?:L\b|litre|liter)/i);
  const c = t.match(/(\d+)\s*cyl/i) || t.match(/\bV(\d+)\b/i) || t.match(/\b[LI](\d)\b/);
  const turbo = /turbo|sup(?:er)?\s*charg|\bt-?gdi\b/i.test(t);
  if (d) return { disp: (+d[1]).toFixed(1), cyl: c ? +c[1] : null, turbo, ev: false };
  if (/\b(electric|ev|bev)\b|\(A1\)/i.test(t)) return { disp: null, cyl: null, turbo: false, ev: true };
  return null;
}
// Does a value tagged with engine `tag` apply to a car whose engine is `carEngine`? No tag, or a car with no engine set, always applies.
export function engineMatches(carEngine, tag) {
  const a = String(carEngine ?? '').trim(), b = String(tag ?? '').trim();
  if (!b || !a) return true;
  const ka = engineKey(a), kb = engineKey(b);
  if (!ka || !kb) return a.toLowerCase().replace(/\s+/g, ' ') === b.toLowerCase().replace(/\s+/g, ' ');
  if (ka.ev || kb.ev) return ka.ev && kb.ev;
  return ka.disp === kb.disp && ka.turbo === kb.turbo && (ka.cyl === null || kb.cyl === null || ka.cyl === kb.cyl);
}
// Ultrareview B #2: is a cached fe_menu row still good? Never an empty list. Kept for ever only when it was fetched AFTER its model year ended
// (the list is complete then); a row fetched during or before its model year is good for one year (new models are added all year).
export function feRowFresh(row, year, nowMs, maxAgeMs) {
  if (!row) return false;
  let items;
  try { items = JSON.parse(row.options_json); } catch (e) { return false; }
  if (!Array.isArray(items) || !items.length) return false;
  const at = Date.parse(row.fetched_at);
  if (!Number.isFinite(at)) return false;
  return new Date(at).getUTCFullYear() > year || nowMs - at < maxAgeMs;
}
// The fueleconomy model names start with the plain model ("Grand Cherokee 4WD"). A variant list for one plain model.
export const feVariants = (items, model) => items.filter(i => i.text.toLowerCase().startsWith(String(model || '').toLowerCase()));

// ---------- Door-jamb photo read: the checks (ultrareview B #1) ----------
// ONE rule set for a read from the photo. The Worker (doorcardResult) uses it; ops/read_doorcard.py mirrors it (TIRE_SIZE_RE, psi 10-99), and
// a test feeds the same cases (tests/.../read_doorcard.py/answer_cases.js) to both, so the script never posts a read that the Worker refuses.
export const TIRE_SIZE_RE = /^[A-Za-z]{0,2}\d{3}\/\d{2}\s?[A-Za-z]{0,2}\s?R?\s?\d{2}[A-Za-z0-9 ]{0,6}$/;
export const PSI_MIN = 10, PSI_MAX = 99;
const intOrNull = (x, lo, hi) => x === undefined || x === null || x === '' ? null : (Number.isInteger(x) && x >= lo && x <= hi ? x : NaN);
// r = the read object. Returns { err } or the cleaned values { sf, sr, pf, pr, sp, spPsi }. The VIN is checked by the caller.
export function parseDoorcardRead(r) {
  const sf = r.size_front ? String(r.size_front).trim() : null, sr = r.size_rear ? String(r.size_rear).trim() : null;
  for (const s of [sf, sr]) if (s && !TIRE_SIZE_RE.test(s)) return { err: 'A tire size looks like 235/50R18' };
  const pf = intOrNull(r.psi_front, PSI_MIN, PSI_MAX), pr = intOrNull(r.psi_rear, PSI_MIN, PSI_MAX);
  if (Number.isNaN(pf) || Number.isNaN(pr)) return { err: `A pressure is a whole number of psi from ${PSI_MIN} to ${PSI_MAX}` };
  const sp = r.spare && typeof r.spare === 'object' ? r.spare : { state: 'not_on_label' };
  if (!['none', 'psi', 'not_on_label'].includes(sp.state)) return { err: 'spare.state is none, psi or not_on_label' };
  const spPsi = intOrNull(sp.psi, PSI_MIN, PSI_MAX);
  if (Number.isNaN(spPsi) || (sp.state === 'psi' && spPsi === null)) return { err: `A spare in psi needs a pressure from ${PSI_MIN} to ${PSI_MAX}` };
  return { sf, sr, pf, pr, sp, spPsi };
}

// ---------- Secret scrubbing (HANDOFF 18, REVIEW 2.9) ----------
// Used for every text that goes into ops_log. The N100 scrubs with the same patterns before the push (ops/ops_push.py), the Worker again
// before the insert. Order matters little; each pattern is replaced by a fixed word. A VIN shape is masked to its last 4 (not removed).
// `extra` = more words to remove (the Access team host, for example).
const SCRUB_PATTERNS = [
  [/Bearer\s+\S+/g, '[scrubbed]'],
  [/sk-ant-\S*/g, '[scrubbed]'],
  [/CF_ACCESS\S*/g, '[scrubbed]'],
  [/\b[0-9a-fA-F]{32,}\b/g, '[scrubbed]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[scrubbed]'],
  [/[\w-]+\.cloudflareaccess\.com/gi, '[scrubbed]'],
  [/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/g, '[scrubbed]'],   // a Cloudflare API token is 40 characters (the N100 sends none, but cf.env has one)
];
export function scrubText(s, extra = []) {
  let t = String(s ?? '');
  for (const [re, to] of SCRUB_PATTERNS) t = t.replace(re, to);
  for (const w of extra) if (w) t = t.split(w).join('[scrubbed]');
  // any run of 17 or more VIN letters and digits, in any case, with or without a word boundary ("VIN1HGC...") is masked to its last 4
  return t.replace(/[A-HJ-NPR-Z0-9]{17,}/gi, m => '*'.repeat(m.length - 4) + m.slice(-4));
}
// The same scrub on every string inside a value (the JSON structure is kept: scrubbing the JSON text would let one match eat the rest of it).
export function scrubDeep(x, extra = []) {
  if (typeof x === 'string') return scrubText(x, extra);
  if (Array.isArray(x)) return x.map(i => scrubDeep(i, extra));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [scrubText(k, extra), scrubDeep(v, extra)]));
  return x;
}
// Pressures of a saved text, front then rear: "38 F / 44 R psi", "38 psi F / 44 psi R", "Front 38, Rear 44", "32 psi" (rear = front). Tire sizes are skipped.
export function psiPair(text) {
  const t = String(text ?? '').replace(/\b\d{3}\/\d{2}\s?[A-Za-z]{0,2}\s?R?\s?\d{2}\b/g, ' ');
  const n = (t.match(/\d+(?:\.\d+)?/g) || []).filter(x => +x >= 10 && +x <= 99);
  return n.length ? [n[0], n[1] || n[0]] : null;
}

// ---------- NHTSA recalls (HANDOFF 18, C8) ----------
// recallsByVehicle answers { Count, results: [ { NHTSACampaignNumber, ReportReceivedDate "dd/mm/yyyy", Component, Summary, Consequence, Remedy } ] }.
// The campaign number starts with the two-digit year and V (vehicle) or E (equipment: a tire, a child seat). Only V campaigns are counted
// for the car; the E ones are not about this car. Texts are cut so the cached row stays small. null = the answer is not a recalls answer.
export function parseRecalls(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) return null;
  const cut = (x, n) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const seen = new Set(), items = [];
  for (const r of data.results) {
    const num = cut(r.NHTSACampaignNumber, 20);
    if (!num || seen.has(num) || !/^\d\d[Vv]/.test(num)) continue;
    seen.add(num);
    const d = String(r.ReportReceivedDate || '').match(/^(\d\d)\/(\d\d)\/(\d{4})$/);
    items.push({ campaign: num.toUpperCase(), date: d ? `${d[3]}-${d[2]}-${d[1]}` : '', component: cut(r.Component, 120), summary: cut(r.Summary, 500), consequence: cut(r.Consequence, 300), remedy: cut(r.Remedy, 300) });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || b.campaign.localeCompare(a.campaign));
  return items;
}

// ---------- NHTSA Canadian specs ----------
// Names are Canada-market names ("CIVIC EX-T/TOURING 4DR SEDAN"); every one is labelled "Canadian specs" by the caller.
export function canadianTrims(data) {
  const out = [], seen = new Set();
  for (const r of (data && Array.isArray(data.Results) ? data.Results : [])) {
    const spec = {};
    for (const s of r.Specs || []) spec[s.Name] = s.Value;
    const name = String(spec.Model || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, curb_lb: spec.CW ? Math.round(+spec.CW * 2.2046226) : null, front_pct: frontPct(spec.WD) });
  }
  return out;
}
// The weight split is "48/52" (front/rear), in field WD. Front share in percent, or null when the text is not a split that adds to 100.
export function frontPct(text) {
  const m = String(text ?? '').match(/^\s*(\d{2})\s*[/:-]\s*(\d{2})\s*$/);
  return m && +m[1] + +m[2] === 100 ? +m[1] : null;
}
// HANDOFF 18 (C7): the curb weight line for a car. A row whose model name holds the car's trim as a whole word is the trim's weight; all
// such rows must agree (the same weight), else the lookup falls back to the base model = the lightest row. { lb, front_pct, source } or null.
// source is always "Canadian specs, base model" or "Canadian specs, <row name>" (Rick: base model is the label when the trim does not match).
export function pickWeight(rows, trim) {
  const have = (rows || []).filter(r => r.curb_lb > 0);
  if (!have.length) return null;
  const t = String(trim ?? '').trim().toLowerCase();
  if (t) {
    const word = new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '($|[^a-z0-9])', 'i');
    const hit = have.filter(r => word.test(r.name));
    if (hit.length && new Set(hit.map(r => r.curb_lb)).size === 1) return { lb: hit[0].curb_lb, front_pct: hit[0].front_pct ?? null, source: `Canadian specs, ${hit[0].name}` };
  }
  const base = have.reduce((a, b) => (b.curb_lb < a.curb_lb ? b : a));
  return { lb: base.curb_lb, front_pct: base.front_pct ?? null, source: 'Canadian specs, base model' };
}
// HANDOFF 19 (Rick 2026-10-29): the D1 lines of the Admin page. Free plan (default): today's rows against the old FREE daily limits, 50% amber, 80% red.
// Workers Paid (the Worker variable LP_D1_PLAN = "paid", set by tools/deploy.sh from deploy.env): the free-limit % is grey info only (level "info": no
// colour, never the red dot), and the colour is judged against the monthly INCLUDED amounts, summed from the daily reports of this month.
// The Kuma alert (ops_push.py) stays on the free limits: it is for the decision to cancel the paid plan.
export const D1_FREE = { rows_written: 100000, rows_read: 5000000 };   // free plan, per day
export const D1_PAID = { rows_written: 50e6, rows_read: 25e9 };        // Workers Paid, included per month
export const d1IsPaid = plan => String(plan ?? '').trim().toLowerCase() === 'paid';
const pctText = p => !Number.isFinite(p) ? '?' : p >= 1 ? String(Math.round(p)) : p === 0 ? '0' : '<1';
const lvOf = p => p >= 80 ? 'red' : p >= 50 ? 'amber' : 'green';
// The month so far: each daily report row is the cumulative count of its UTC day, so the caller gives the LAST report of each day; the days are added up.
export function d1Month(dayRows) {
  const m = {};
  for (const r of dayRows || []) for (const x of (r && Array.isArray(r.databases) ? r.databases : [])) {
    const o = m[x.name] || (m[x.name] = { rows_written: 0, rows_read: 0 });
    o.rows_written += Number(x.rows_written) || 0; o.rows_read += Number(x.rows_read) || 0;
  }
  return m;
}
export function d1Lines(row, nowMs, plan = 'free', month = {}) {
  if (!row || !row.data || !Array.isArray(row.data.databases)) return [{ name: 'd1_usage', level: 'amber', reason: 'No D1 usage report has arrived yet.' }];
  const age = (nowMs - Date.parse(row.ts)) / 3600e3, out = [], paid = d1IsPaid(plan), num = n => Number.isFinite(n) ? n.toLocaleString('en-US') : '?';
  for (const d of row.data.databases.slice(0, 6)) for (const k of ['rows_written', 'rows_read']) {
    const nm = String(d.name).replace(/[^\w-]/g, '').slice(0, 30), n = Number(d[k]), pct = 100 * n / D1_FREE[k], word = k.replace('_', ' ');
    if (!paid) {
      out.push({ name: `d1_${nm}_${k}`, level: lvOf(Math.round(pct)), reason: `${d.name}: ${num(n)} ${word} today of ${D1_FREE[k].toLocaleString('en-US')} free (${Number.isFinite(pct) ? Math.round(pct) : '?'}%).` });
    } else {
      const mo = (month[d.name] || {})[k] || 0, mpct = 100 * mo / D1_PAID[k];
      out.push({ name: `d1_${nm}_${k}`, level: 'info', reason: `${d.name}: ${num(n)} ${word} today = ${pctText(pct)}% of the old free daily limit (info only on Workers Paid).` });
      out.push({ name: `d1_${nm}_${k}_month`, level: lvOf(mpct), reason: `${d.name}: ${num(mo)} ${word} this month of ${D1_PAID[k].toLocaleString('en-US')} included (${pctText(mpct)}%).` });
    }
  }
  if (age > 26) out.push({ name: 'd1_usage_age', level: 'amber', reason: `The D1 usage report is ${Math.round(age)} hours old.` });
  return out;
}
