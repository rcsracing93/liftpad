// Network first. If the network fails, use the last saved copy, so lookups work in the garage without Wi-Fi.
const C = 'liftpad-v3';
const SHELL = ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); } return res; })
    .catch(async () => { const hit = await caches.match(r); if (!hit) return caches.match('/index.html');
      const h = new Headers(hit.headers); h.set('x-liftpad-cache', 'offline'); return new Response(await hit.blob(), { status: hit.status, headers: h }); }));
});
