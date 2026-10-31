// Network first. If the network fails, use the last saved copy, so lookups work in the garage without Wi-Fi.
// /api/ is never answered with the app page (Handoff 3 step 0, 2026-10-17): a typed /api/ address
// is not handled here at all, and a failed /api/ fetch gets its saved JSON copy or a JSON error.
// HANDOFF 19 (D6): each saved copy carries the time it was saved (x-liftpad-saved), so the app can say "data saved 2 days ago".
// A car page is saved as /api/vehicles/<id>?peek=1 by the background fetch on Home; the same page without peek (the car screen) falls back to it.
const C = 'liftpad-v7';   // HANDOFF 20 (E1): fonts-ui.css joins the shell (Barlow, Barlow Semi Condensed and JetBrains Mono, self-hosted)
const SHELL = ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest', '/icon.svg', '/fonts.css', '/fonts-ui.css'];
const offline = async (hit) => { const h = new Headers(hit.headers); h.set('x-liftpad-cache', 'offline'); return new Response(await hit.blob(), { status: hit.status, headers: h }); };
const keep = async (r, res) => { const h = new Headers(res.headers); h.set('x-liftpad-saved', String(Date.now())); const c = await caches.open(C); await c.put(r, new Response(await res.blob(), { status: res.status, headers: h })); };
const CAR = /^\/api\/vehicles\/\d+$/;
// The car page has two saved copies (with and without peek): offline, the newer one wins.
const savedAt = hit => Number(hit && hit.headers.get('x-liftpad-saved')) || 0;
const saved = async (r, u) => {
  const own = await caches.match(r);
  if (!CAR.test(u.pathname)) return own;
  const other = await caches.match(new Request(u.origin + u.pathname + (u.search ? '' : '?peek=1')));
  return savedAt(other) > savedAt(own) ? other : (own || other);
};
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) {
    if (r.mode === 'navigate') return;
    e.respondWith(fetch(r).then(res => { if (res.ok) e.waitUntil(keep(r, res.clone())); return res; })
      .catch(async () => { const hit = await saved(r, u); if (hit) return offline(hit);
        return new Response(JSON.stringify({ error: 'Offline - no saved copy of this data' }), { status: 503, headers: { 'content-type': 'application/json', 'x-liftpad-cache': 'offline' } }); }));
    return;
  }
  e.respondWith(fetch(r).then(res => { if (res.ok) e.waitUntil(keep(r, res.clone())); return res; })
    .catch(async () => { const hit = await caches.match(r); return hit ? offline(hit) : caches.match('/index.html'); }));
});
