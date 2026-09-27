// service worker: precache every file the console needs, serve cache-first,
// never fetch anything that is not on this origin. bump VERSION on release.

const VERSION = 'gabriel-console-v1';
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
  './js/landing.js',
  './js/app.js',
  './vendor/qrcode.js',
  './vendor/jsQR.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

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
    // nothing off-origin is ever requested by this app; refuse rather than leak
    event.respondWith(new Response('', { status: 403, statusText: 'off-origin request blocked' }));
    return;
  }
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        if (res && res.ok) {
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
