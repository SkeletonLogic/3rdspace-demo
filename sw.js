/**
 * Service worker.
 *
 * The shell is cached so the app opens instantly and survives a dropped
 * connection. API responses are deliberately NOT cached: this is an audit tool,
 * and showing a stale capture score as if it were current would be worse than
 * showing nothing. Network-first for data, cache-first for the shell.
 */

const VERSION = 'cd7208c58d';
const SHELL = `3rdspace-shell-${VERSION}`;

// Relative, so the same worker serves both a node at the origin root and the
// hosted demo under a GitHub Pages subpath.
const ASSETS = [
  './',
  './index.html',
  './app.css?v=be2556197b',
  './app.js?v=097e8db09c',
  './sound.js?v=de525bd754',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './favicon-64.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Never serve a cached audit. An out-of-date score is a false statement about
  // a real person's node. (In the hosted demo there is no /api/ at all — scores
  // are recomputed in the page from demo-data.json, which is fetched no-cache.)
  if (url.pathname.includes('/api/')) return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
