/* ParMap service worker
 * - App shell (same-origin): network-first with a 3.5 s timeout, falling back
 *   to cache. Online users always get the latest deploy; offline still works.
 * - Leaflet from unpkg (versioned URL): cache-first.
 * - Map tiles: cached for 7 days with a size cap, so areas you've viewed work offline.
 * - APIs (Gemini, Overpass, Photon) are never cached here.
 * Bump VERSION when you add or rename files in SHELL.
 */
const VERSION = '1.0.0';
const SHELL_CACHE = `parmap-shell-${VERSION}`;
const RUNTIME_CACHE = 'parmap-runtime-v1';
const TILE_CACHE = 'parmap-tiles-v1';
const MAX_TILES = 600;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/router.js',
  './js/utils.js',
  './js/db.js',
  './js/store.js',
  './js/stats.js',
  './js/geo.js',
  './js/ai.js',
  './js/ui.js',
  './js/charts.js',
  './js/demo.js',
  './js/pwa.js',
  './js/views/map.js',
  './js/views/rounds.js',
  './js/views/stats.js',
  './js/views/courses.js',
  './js/views/course-detail.js',
  './js/views/round-detail.js',
  './js/views/round-form.js',
  './js/views/course-picker.js',
  './js/views/filters.js',
  './js/views/settings.js',
  './js/views/importer.js',
  './js/views/scan.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    const rt = await caches.open(RUNTIME_CACHE);
    await Promise.all(CDN.map(async (u) => {
      try {
        const res = await fetch(u, { mode: 'cors' });
        if (res.ok) await rt.put(u, res);
      } catch { /* CDN unreachable during install; cached on first use instead */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('parmap-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event));
  } else if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
  } else if (isTile(url)) {
    event.respondWith(tile(req));
  }
  // Everything else (AI and search APIs) goes straight to the network.
});

function isTile(url) {
  return url.hostname === 'tile.openstreetmap.org' || url.hostname === 'server.arcgisonline.com';
}

async function networkFirst(event) {
  const req = event.request;
  const isNav = req.mode === 'navigate';
  const cache = await caches.open(SHELL_CACHE);
  const key = isNav ? './index.html' : req;
  const network = (async () => {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await cache.put(key, res.clone());
    return res;
  })();
  network.catch(() => {});
  event.waitUntil(network.catch(() => {}));
  const cached = await cache.match(key, { ignoreSearch: true });
  if (!cached) return network;
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
    ]);
  } catch {
    return cached;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreVary: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

// Tiles you've viewed are kept for offline use but refreshed after a week,
// in line with the OpenStreetMap tile usage policy.
const TILE_MAX_AGE = 7 * 24 * 3600 * 1000;
let tilePuts = 0;
async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  const fresh = cached && Date.now() - new Date(cached.headers.get('date') || 0).getTime() < TILE_MAX_AGE;
  if (fresh) return cached;
  try {
    const res = await fetch(req);
    // Only CORS responses are cached (opaque ones inflate storage quota).
    if (res.ok) {
      cache.put(req, res.clone()).then(() => {
        if (++tilePuts % 40 === 0) trimTiles(cache);
      }).catch(() => {});
    }
    return res;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_TILES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}
