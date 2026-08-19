/* Goobster next-client service worker (Phase 4).
 * Network-first for /app/next/*; never intercept /api/*.
 * Documents are never cached — index.html points at hashed CSS/JS that
 * vanish on the next Vite build, and a stale shell is an unstyled page.
 */
const CACHE = 'goobster-next-v2';
const SHELL = ['/app/next/manifest.webmanifest', '/app/next/style.css'];

function isDocumentPath(pathname) {
    return pathname === '/app/next' || pathname === '/app/next/' || pathname.endsWith('.html');
}

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
    if (request.mode === 'navigate' || isDocumentPath(url.pathname)) {
        event.respondWith(fetch(request));
        return;
    }
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
            throw new Error('offline');
        }
    })());
});
