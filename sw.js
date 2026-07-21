const CACHE_NAME = 'soxl-v4-defensive-25-5-v8-reference-ui';
const APP_SHELL = [
  './',
  './index.html',
  './v40_defensive_core.js',
  './v40_defensive_patch.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => key === CACHE_NAME ? null : caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // Quote JSON must never be served cache-first because the daily value changes.
    if (url.pathname.endsWith('/data/latest-close.json')) {
      event.respondWith(
        fetch(req, { cache: 'no-store' })
          .then(res => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then(cache => cache.put('./data/latest-close.json', copy));
            }
            return res;
          })
          .catch(() => caches.match('./data/latest-close.json'))
      );
      return;
    }

    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
