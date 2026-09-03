const CACHE_NAME = 'lectureai-shell-v10';
const CORE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  // Cache the new shell, but do not call skipWaiting here. A newly downloaded
  // service worker must not replace the worker controlling an active lecture.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE)));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  // Do not call clients.claim(). Existing pages keep their current controller until
  // the user explicitly reloads after the lecture, preventing a mid-session worker swap.
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
      }
      return response;
    }).catch(() => caches.match('/')));
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
