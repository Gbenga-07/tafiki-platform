/* Tafiki service worker.
   - Keeps a copy of the app itself (the page code, no account data) so the installed apps open instantly;
     a fresh copy is fetched in the background every time and used on the next open.
   - Never stores API responses, balances or any money figures: those always come live from the server.
   - Shows a plain "you're offline" page if the app can't load at all. */
const OFFLINE = 'tafiki-offline-v1';
const SHELL = 'tafiki-shell-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(OFFLINE).then(c => c.addAll(['/offline.html', '/img/app/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== OFFLINE && k !== SHELL).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname === '/img/app/icon-192.png') { // the offline page's own icon
    e.respondWith(fetch(e.request).catch(() => caches.match('/img/app/icon-192.png')));
    return;
  }
  if (e.request.mode !== 'navigate' || u.pathname === '/offline.html') return; // API calls, images and scripts go straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match('/__app');
    const fresh = fetch(e.request).then(r => {
      if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) cache.put('/__app', r.clone());
      return r;
    });
    if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
    try { return await fresh; } catch (err) { return (await caches.match('/offline.html')) || Response.error(); }
  })());
});
