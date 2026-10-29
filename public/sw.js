// Network first. If the network fails, use the last saved copy, so lookups work in the garage without Wi-Fi.
// /api/ is never answered with the app page (Handoff 3 step 0, 2026-10-17): a typed /api/ address
// is not handled here at all, and a failed /api/ fetch gets its saved JSON copy or a JSON error.
const C = 'liftpad-v5';
const SHELL = ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest', '/icon.svg', '/fonts.css'];
const offline = async (hit) => { const h = new Headers(hit.headers); h.set('x-liftpad-cache', 'offline'); return new Response(await hit.blob(), { status: hit.status, headers: h }); };
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) {
    if (r.mode === 'navigate') return;
    e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); } return res; })
      .catch(async () => { const hit = await caches.match(r); if (hit) return offline(hit);
        return new Response(JSON.stringify({ error: 'Offline - no saved copy of this data' }), { status: 503, headers: { 'content-type': 'application/json', 'x-liftpad-cache': 'offline' } }); }));
    return;
  }
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); } return res; })
    .catch(async () => { const hit = await caches.match(r); return hit ? offline(hit) : caches.match('/index.html'); }));
});
