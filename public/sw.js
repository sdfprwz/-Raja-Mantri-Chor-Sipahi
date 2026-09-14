/* Raja Mantri Chor Sipahi — PWA service worker */
const CACHE_VERSION = 'rmcs-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
// App shell — cached on install. socket.io + API + rooms stay network-only.
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/style.css',
  '/client.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/assets/hero-group.jpg',
  '/assets/raja.jpg',
  '/assets/mantari.jpg',
  '/assets/chor.jpg',
  '/assets/sipahi.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rmcs-') && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never cache: realtime + backend.
  if (url.pathname.startsWith('/socket.io/')) return;
  if (url.pathname === '/health') return;

  // Navigations: network-first, fall back to cache, then offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/offline.html')))
    );
    return;
  }

  // Static assets: cache-first, then network + populate cache.
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') ||
     ['/style.css', '/client.js', '/pwa.js', '/manifest.webmanifest'].includes(url.pathname))
  ) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(request, copy)).catch(() => {});
            }
            return res;
          }).catch(() => caches.match('/offline.html'))
      )
    );
  }
});
