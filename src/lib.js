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
    out.push({ name, curb_lb: spec.CW ? Math.round(+spec.CW * 2.2046226) : null });
  }
  return out;
}
