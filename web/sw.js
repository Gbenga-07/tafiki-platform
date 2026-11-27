/* Tafiki service worker.
   It never caches pages, account data or money figures: everything comes live from the network.
   Its only job is to show a plain "you're offline" page when a page can't load at all. */
const OFFLINE = 'tafiki-offline-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(OFFLINE).then(c => c.addAll(['/offline.html', '/img/app/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== OFFLINE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin === location.origin && u.pathname === '/img/app/icon-192.png') { // the offline page's own icon
    e.respondWith(fetch(e.request).catch(() => caches.match('/img/app/icon-192.png')));
    return;
  }
  if (e.request.mode !== 'navigate') return; // API calls, images and scripts go straight to the network
  e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
});
