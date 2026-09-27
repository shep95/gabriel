// service worker: precache every file the console needs, serve cache-first,
// and never fetch anything off this origin, with one exception the person
// turns on by hand: map tiles from openstreetmap.org. bump VERSION on release.

const VERSION = 'gabriel-console-v10';
const PRECACHE = [
  './',
  './index.html',
  './app.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/landing.css',
  './css/app.css',
  './js/util.js',
  './js/crypto.js',
  './js/db.js',
  './js/qr.js',
  './js/scan.js',
  './js/status.js',
  './js/state.js',
  './js/ui.js',
  './js/beacon.js',
  './js/rooms.js',
  './js/calls.js',
  './js/notify.js',
  './js/shield.js',
  './js/install.js',
  './js/geo.js',
  './js/keypad.js',
  './js/landing.js',
  './js/app.js',
  './vendor/qrcode.js',
  './vendor/jsQR.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/leaflet-images/marker-icon.png',
  './vendor/leaflet-images/marker-icon-2x.png',
  './vendor/leaflet-images/marker-shadow.png',
  './vendor/leaflet-images/layers.png',
  './vendor/leaflet-images/layers-2x.png',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/og.png',
  './vendor/fonts/inter-latin-200-normal.woff2',
  './vendor/fonts/inter-latin-300-normal.woff2',
  './vendor/fonts/inter-latin-400-normal.woff2',
];

// the only off-origin host the worker will let through. tiles are requested
// only when the person picked "openstreetmap.org" in privacy settings.
const TILE_HOSTS = new Set(['tile.openstreetmap.org', 'a.tile.openstreetmap.org', 'b.tile.openstreetmap.org', 'c.tile.openstreetmap.org']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    if (TILE_HOSTS.has(url.hostname) && event.request.method === 'GET') {
      // pass through without caching: cached tiles would be a record of where
      // the person looked, and that record would survive a lock
      event.respondWith(fetch(event.request, { referrerPolicy: 'no-referrer', credentials: 'omit' }).catch(() => new Response('', { status: 504 })));
      return;
    }
    event.respondWith(new Response('', { status: 403, statusText: 'off-origin request blocked' }));
    return;
  }
  if (event.request.method !== 'GET') return;
  if (url.pathname.endsWith('/tiles') || url.pathname.includes('/tiles/')) {
    // beacon-served tiles: network only, same reasoning as above
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 504 })));
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        // a redirected response stored in the cache throws later for navigations
        if (res && res.ok && res.type === 'basic' && !res.redirected && !url.pathname.endsWith('/healthz')) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'offline and not cached' });
      });
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'version' && event.source) event.source.postMessage({ type: 'version', version: VERSION });
});

// a notification names a sender, never content; tapping it brings the
// console forward on the room it came from
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || '#/rooms';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('app.html')) { await c.focus(); c.postMessage({ type: 'navigate', route }); return; }
    }
    await self.clients.openWindow(`./app.html${route}`);
  })());
});
