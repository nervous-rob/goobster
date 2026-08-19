/* Goobster portal service worker (Phase 4 flip).
 * Network-first for /app/* static files; never intercept /api/*.
 * Documents are never cached — index.html points at hashed JS that
 * vanish on the next Vite build, and a stale shell is an unstyled page.
 * Share URLs stay live-only (unguessable token capability).
 */
const CACHE = 'goobster-app-v1';
const SHELL = ['/app/manifest.webmanifest', '/app/style.css'];

function isDocumentPath(pathname) {
    return pathname === '/app' || pathname === '/app/' || pathname.endsWith('.html');
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
    if (!url.pathname.startsWith('/app')) return;
    if (url.pathname.startsWith('/app/share/')) return;
    if (url.pathname.startsWith('/app/observatory/share/')) return;
    if (request.mode === 'navigate' || isDocumentPath(url.pathname)) {
        event.respondWith(fetch(request).catch(async () => {
            const cache = await caches.open(CACHE);
            return (await cache.match('/app/style.css')) ? new Response(
                '<!doctype html><title>Goobster</title><p>You are offline. Reconnect to open the house.</p>',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            ) : undefined;
        }));
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
