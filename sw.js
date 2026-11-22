const CACHE_NAME = 'lodge-music-v59';

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/console.js',
  './assets/store.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        CORE_ASSETS.map((asset) => cache.add(asset))
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  // Never intercept cross-origin calls (Firebase Firestore / Auth / Google APIs)
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  const lowerPath = url.pathname.toLowerCase();
  const isAudioFile =
    lowerPath.endsWith('.mp3') ||
    lowerPath.endsWith('.wav') ||
    lowerPath.endsWith('.ogg') ||
    lowerPath.endsWith('.m4a') ||
    lowerPath.endsWith('.aac') ||
    lowerPath.endsWith('.flac');

  if (isAudioFile) {
    const cleanRequestTarget = new Request(url.origin + url.pathname);
    event.respondWith(
      caches.match(cleanRequestTarget).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        if (navigator.connection) {
          const connectionType = navigator.connection.type;
          const saveDataActive = navigator.connection.saveData;

          if (connectionType === 'cellular' || saveDataActive === true) {
            if (url.searchParams.get('forceMobile') !== 'true') {
              return new Response(
                JSON.stringify({ error: "Cellular download blocked. Turn on 'Allow Mobile Data' on the home screen." }),
                { status: 403, headers: { 'Content-Type': 'application/json' } }
              );
            }
          }
        }

        return fetch(event.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200) {
            return networkResponse;
          }
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(cleanRequestTarget, responseToCache);
          });
          return networkResponse;
        });
      })
    );
    return;
  }

  // Network-first for HTML, JS, CSS, and JSON so updates are always fresh when online
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});