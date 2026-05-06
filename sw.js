const CACHE_NAME = 'filer-mvp-shell-v2';
const ROOT_URL = self.registration.scope;
const INDEX_URL = new URL('index.html', self.registration.scope).toString();
const SYNC_URL = new URL('sync.js', self.registration.scope).toString();
const APP_SHELL = [ROOT_URL, INDEX_URL, SYNC_URL];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys
                .filter((key) => key !== CACHE_NAME)
                .map((key) => caches.delete(key))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }

    const isSameOrigin = new URL(event.request.url).origin === self.location.origin;
    if (!isSameOrigin) {
        return;
    }

    if (event.request.mode === 'navigate') {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            try {
                const networkResponse = await fetch(event.request, { cache: 'no-store' });
                if (networkResponse && networkResponse.ok) {
                    cache.put(INDEX_URL, networkResponse.clone());
                    cache.put(ROOT_URL, networkResponse.clone());
                }
                return networkResponse;
            } catch {
                const offlineShell =
                    (await cache.match(event.request, { ignoreSearch: true })) ||
                    (await cache.match(INDEX_URL, { ignoreSearch: true })) ||
                    (await cache.match(ROOT_URL, { ignoreSearch: true }));

                if (offlineShell) {
                    return offlineShell;
                }

                return new Response('Offline. App shell not cached yet.', {
                    status: 503,
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cachedResponse = await cache.match(event.request, { ignoreSearch: true });
        if (cachedResponse) {
            return cachedResponse;
        }

        const networkResponse = await fetch(event.request);
        cache.put(event.request, networkResponse.clone());
        return networkResponse;
    })());
});
