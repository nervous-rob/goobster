/* Goobster next-client service worker (Phase 4).
 * Network-first for /app/next/*; never intercept /api/*.
 */
const CACHE = 'goobster-next-v1';
const SHELL = ['/app/next/', '/app/next/index.html', '/app/next/manifest.webmanifest'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return;
    if (!url.pathname.startsWith('/app/next')) return;
    event.respondWith((async () => {
        try {
            const fresh = await fetch(request);
            if (fresh.ok) {
                const cache = await caches.open(CACHE);
                cache.put(request, fresh.clone());
            }
            return fresh;
        } catch {
            const cached = await caches.match(request);
            if (cached) return cached;
            if (request.mode === 'navigate') {
                const shell = await caches.match('/app/next/index.html');
                if (shell) return shell;
            }
            throw new Error('offline');
        }
    })());
});
