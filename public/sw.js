// sw.js — общий service worker для всех панелей (админка/грумер/менеджер).
// Кэшируется только статическая оболочка (HTML/иконки/JS-библиотеки).
// Запросы к /api/ ВСЕГДА идут напрямую в сеть, без кэша — там живые данные
// (заказы, остатки, токены авторизации), кэшировать их нельзя ни в коем случае.

const CACHE_NAME = 'taiga-shell-v1';
const SHELL_FILES = [
  '/taiga-admin.html',
  '/taiga-groomer.html',
  '/taiga-manager.html',
  '/taiga-warehouse.html',
  '/config.js',
  '/qrcode.min.js',
  '/images/taiga-logo.png',
  '/images/icons/icon-192.png',
  '/images/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API-запросы — никогда не кэшируем, всегда напрямую в сеть.
  if (url.pathname.startsWith('/api/')) {
    return; // не перехватываем — браузер сам сходит в сеть как обычно
  }

  // Только GET-запросы имеет смысл кэшировать.
  if (event.request.method !== 'GET') return;

  // Статика: сеть в приоритете (чтобы не залипнуть на старой версии после
  // обновления сайта), а кэш — как резерв на случай обрыва связи.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
