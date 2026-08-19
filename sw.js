// Минимальный service worker: даёт сайту установиться как приложение и
// открываться быстрее при повторных заходах. Данные (регистрации, матчи)
// всегда берутся из сети, чтобы результаты не протухали в кэше.
const CACHE = 'rkch-v2';
const SHELL = ['./', './index.html', './favicon.svg', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) {
    // всегда свежие данные турнира
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  const isShell = e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isShell) {
    // страницу всегда берём из сети, чтобы правки на сайте были видны сразу;
    // кэш — только запасной вариант, если офлайн
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});
