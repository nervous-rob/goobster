/**
 * Goobster web app service worker: makes the portal installable and
 * launchable offline. Strategy is deliberately conservative:
 *  - the app shell (static files under /app/) is network-first with a
 *    cache fallback, so a running server always serves fresh code and the
 *    cache only answers when the network can't;
 *  - /api/ requests are NEVER cached or intercepted (auth, SSE streams,
 *    and live data must always hit the server).
 */

// Bump when the precached shell changes so activate() drops the stale cache.
const CACHE_NAME = 'goobster-app-v3';
const SHELL = [
    '/app/',
    '/app/index.html',
    '/app/style.css',
    '/app/app.js',
    '/app/api.js',
    '/app/chat.js',
    '/app/memory.js',
    '/app/exchange.js',
    '/app/tasks.js',
    '/app/usage.js',
    '/app/parlor.js',
    '/app/parlorWorkspace.js',
    '/app/parlorUi.js',
    '/app/markdown.js',
    '/app/highlight.js',
    '/app/math.js',
    '/app/codeblocks.js',
    '/app/graph.js',
    '/app/modal.js',
    '/app/manifest.webmanifest',
    '/app/icons/goobster.svg',
    '/app/icons/icon-192.png',
    '/app/icons/icon-512.png',
    '/app/icons/apple-touch-icon-180.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    // Static app files only: same origin, GET, under /app/, never the API.
    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith('/app/')) return;
    if (url.pathname.startsWith('/app/share/')) return; // token URLs stay live-only

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Refresh the cached copy on every successful fetch
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                if (cached) return cached;
                // Offline navigation to any /app/ route falls back to the shell
                if (event.request.mode === 'navigate') {
                    const shell = await caches.match('/app/index.html');
                    if (shell) return shell;
                }
                return Response.error();
            })
    );
});
