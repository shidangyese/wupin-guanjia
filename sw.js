/* 物品管家 Service Worker：缓存全部静态资源，安装后可离线使用。
   注意：以后修改了文件，请把 CACHE 版本号 +1 才会更新缓存。 */
const CACHE = 'wupin-guanjia-v11';
const ASSETS = [
  './', './index.html', './style.css', './app.js',
  './manifest.webmanifest', './icon.svg',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];
self.addEventListener('install', e => {
  // 逐个缓存，单个失败不阻断安装；其余资源会在使用时由 fetch 事件补缓存
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(a => cache.add(a).catch(() => {})));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
