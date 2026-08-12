// Bump this on every deploy that touches a file in STATIC — it's the only
// thing that forces browsers with an old SW already installed (Safari,
// Android Chrome) to fetch the new files instead of serving stale ones
// from cache forever.
const CACHE_VERSION = 'v20';
const CACHE = `coder-cache-${CACHE_VERSION}`;

const STATIC = [
  '/',
  '/index.html',
  '/app.js',
  '/processor.js',
  '/robot.js',
  '/particles.js',
  '/audio-analyser.js',
  '/coder.webp',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for static assets. WebSocket connections never reach a
// service worker's fetch handler (browsers don't route ws:/wss: upgrades
// through it), but we guard on scheme and path anyway so this stays
// correct even if that ever changes — plus a plain non-GET bypass.
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (url.startsWith('ws:') || url.startsWith('wss:') || url.includes('/ws')) return;

  e.respondWith(
    caches.match(e.request).then((cached) => cached ?? fetch(e.request))
  );
});
