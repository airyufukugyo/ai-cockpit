/* Secretary Cockpit PWA - service worker.
   オフライン閲覧用にアプリシェルだけをキャッシュする。
   Google API（tasks/sheets）など別オリジンへのリクエストは絶対にキャッシュせず素通し。 */
const CACHE = 'cockpit-v3';
const SHELL = ['./', './index.html', './app.js', './manifest.json',
  './icon.svg', './defs.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 同一オリジンの GET だけ扱う。Google API 等は素通し（キャッシュしない）。
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
