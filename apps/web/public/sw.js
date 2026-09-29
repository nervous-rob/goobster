/* Goobster portal service worker (documentation/pwa.md).
 *
 * - Never intercepts /api/* (auth, SSE, live data) and leaves share URLs
 *   live-only (the unguessable token is the capability).
 * - Documents are never cached: index.html points at hashed chunks that
 *   vanish on the next build, and a stale shell is an unstyled page. An
 *   offline navigation gets the precached offline page instead.
 * - Hashed chunks under /app/assets/ are cache-first (the name is the
 *   version); everything else under /app/ is network-first with the cache
 *   answering offline - and answering a 404 too, so a tab that outlived a
 *   deploy can still load the chunk it was built against.
 * - The cache is named after the build (the server stamps
 *   __GOOBSTER_BUILD__ when it serves this file), so `activate` drops the
 *   previous build's cache without anyone bumping a constant.
 * - Web Push: shows a notification pointing at a portal path, skipped when
 *   a window is already visible (the in-app notice covers that case);
 *   clicking focuses an open window and navigates it, or opens one.
 * - Web Share Target: the shared payload is parked in a cache and the
 *   browser is redirected to the chat, which picks it up.
 */
const BUILD = '__GOOBSTER_BUILD__';
const CACHE = `goobster-app-${BUILD}`;
const SHARE_CACHE = 'goobster-share-target';
const SHELL = ['/app/manifest.webmanifest', '/app/style.css', '/app/offline.html', '/app/icons/goobster.svg', '/app/icons/icon-192.png'];
const OFFLINE_PAGE = '/app/offline.html';

function isDocumentPath(pathname) {
    return pathname === '/app' || pathname === '/app/' || pathname.endsWith('.html');
}

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// The page asks the waiting worker to take over once the person accepted
// the update; the page reloads on `controllerchange`.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request) {
    try {
        const fresh = await fetch(request);
        if (fresh.ok) {
            const cache = await caches.open(CACHE);
            cache.put(request, fresh.clone());
            return fresh;
        }
        const cached = await caches.match(request);
        return cached || fresh;
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
    }
}

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fresh = await fetch(request);
    if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
    }
    return fresh;
}

async function navigation(request) {
    try {
        return await fetch(request);
    } catch (error) {
        const offline = await caches.match(OFFLINE_PAGE);
        if (offline) return offline;
        throw error;
    }
}

async function parkShare(request) {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const text = [form.get('title'), form.get('text'), form.get('url')]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join('\n');
    const files = form.getAll('files').filter((file) => file && typeof file === 'object' && 'size' in file);
    const names = [];
    await cache.put('/app/share-target/text', new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    for (let index = 0; index < files.length; index++) {
        const file = files[index];
        names.push({ name: file.name || `shared-${index + 1}`, type: file.type || 'application/octet-stream' });
        await cache.put(`/app/share-target/file/${index}`, new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }));
    }
    await cache.put('/app/share-target/files', new Response(JSON.stringify(names), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('/app/chat?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/app/share-target') {
        event.respondWith(parkShare(request).catch(() => Response.redirect('/app/chat', 303)));
        return;
    }
    if (request.method !== 'GET') return;
    if (url.pathname.startsWith('/api/')) return;
    if (!url.pathname.startsWith('/app')) return;
    if (url.pathname.startsWith('/app/share/')) return;
    if (url.pathname.startsWith('/app/observatory/share/')) return;
    if (url.pathname === '/app/sw.js') return;
    if (request.mode === 'navigate' || isDocumentPath(url.pathname)) {
        event.respondWith(navigation(request));
        return;
    }
    if (url.pathname.startsWith('/app/assets/')) {
        event.respondWith(cacheFirst(request));
        return;
    }
    event.respondWith(networkFirst(request));
});

// --- Web Push -----------------------------------------------------------------

function portalUrl(link) {
    const path = typeof link === 'string' && link.startsWith('/') ? link : '/activity/inbox';
    return path.startsWith('/app/') || path === '/app' ? path : `/app${path}`;
}

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { title: event.data ? event.data.text() : 'Goobster' };
    }
    const title = data.title || 'Goobster';
    const link = portalUrl(data.link);
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // A visible window already showed the in-app notice.
        if (data.kind !== 'test' && windows.some((client) => client.visibilityState === 'visible')) return;
        await self.registration.showNotification(title, {
            body: data.body || undefined,
            tag: data.tag || undefined,
            renotify: Boolean(data.tag),
            icon: '/app/icons/icon-192.png',
            badge: '/app/icons/icon-192.png',
            data: { link }
        });
    })());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = portalUrl(event.notification.data && event.notification.data.link);
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const target = windows.find((client) => client.url.includes('/app')) || windows[0];
        if (target) {
            try {
                await target.focus();
            } catch { /* focus needs a gesture on some platforms */ }
            target.postMessage({ type: 'goobster:navigate', path: link });
            return;
        }
        await self.clients.openWindow(link);
    })());
});

// The push service rotated the subscription: re-subscribe with the same
// server key and tell the server, best effort (the session cookie rides
// along on this same-origin request).
self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
        const old = event.oldSubscription;
        const key = (event.newSubscription && event.newSubscription.options && event.newSubscription.options.applicationServerKey)
            || (old && old.options && old.options.applicationServerKey);
        if (!key) return;
        const fresh = event.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await fetch('/api/app/push/subscriptions', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: fresh.toJSON() })
        });
    })().catch(() => { /* the page re-subscribes on its next visit */ }));
});
