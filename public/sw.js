/* 余烬 · Service Worker
   目标：装到桌面之后，断网也能看见"上次看到的世界"，而不是浏览器的报错页。 */

const V = 'ember-v1';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(V)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 状态：网络优先，失败回落上一次的快照
  if (url.pathname.endsWith('/api/state')) {
    e.respondWith(networkFirstJSON(req));
    return;
  }

  // 其它接口（SSE / 动作 / 日志）一律走网络，不碰缓存
  if (url.pathname.includes('/api/')) return;

  // 页面导航：网络优先，断网给缓存的壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(V).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => hit))
  );
});

async function networkFirstJSON(req) {
  const cache = await caches.open(V);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) {
      // 让前端知道这是离线快照
      const body = await hit.clone().json().catch(() => null);
      if (body) {
        body.__offline = true;
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Ember-Offline': '1' },
        });
      }
      return hit;
    }
    throw err;
  }
}
