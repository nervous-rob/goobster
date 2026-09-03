/**
 * Capability bridge for sandboxed mini-apps.
 *
 * The iframe has no allow-same-origin, so generated HTML cannot see the
 * session cookie or /api/app. The parent posts a MessageChannel port on
 * load; the applet asks for Observatory files through that port; this
 * module validates the declaration + user grant, then fetches with the
 * signed-in session and returns only the content.
 *
 * Own-project short-circuit: an app asset rendered from inside project X
 * may read X with no meta tag and no grant. Cross-project reads still
 * need goobster-observatory-read + an approved grant. Legacy Workshop
 * pins omit ownProject and keep today's declare+grant rule.
 *
 * Keep the grant parser and short-circuit in sync with
 * packages/core/utils/appletCapabilities.js.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const GRANT_STORAGE_PREFIX = 'goobster:applet-grants:';

export function extractObservatoryReadProjects(source) {
    const slugs = [];
    const seen = new Set();
    const re = new RegExp(META_TAG_RE.source, 'gi');
    let match;
    while ((match = re.exec(String(source || '')))) {
        const tag = match[0];
        const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
        if (String(name || '').toLowerCase() !== 'goobster-observatory-read') continue;
        const content = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
        for (const part of content.split(/[,\s]+/)) {
            const slug = String(part || '').trim().toLowerCase();
            if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
            seen.add(slug);
            slugs.push(slug);
        }
    }
    return slugs;
}

export function observatoryContentUrl(project, relativePath, owner = null) {
    const slug = encodeURIComponent(String(project || '').trim());
    const pathPart = String(relativePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
    const qs = owner ? `?owner=${encodeURIComponent(owner)}` : '';
    return `/api/app/observatory/projects/${slug}/content/${pathPart}${qs}`;
}

export function appletTitleFromSource(source) {
    const title = String(source || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title) {
        const clean = title[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (clean) return clean.slice(0, 80);
    }
    return 'This mini-app';
}

export function grantPromptMessage(appletTitle, project) {
    return `${appletTitle} wants read-only access to Observatory project \`${project}\`.`;
}

export function contentHash(source) {
    let hash = 0;
    const text = String(source || '');
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return `h${(hash >>> 0).toString(16)}`;
}

function readStoredGrants(key) {
    try {
        const raw = sessionStorage.getItem(key);
        if (!raw) return { granted: [], denied: [] };
        const parsed = JSON.parse(raw);
        return {
            granted: Array.isArray(parsed.granted) ? parsed.granted : [],
            denied: Array.isArray(parsed.denied) ? parsed.denied : []
        };
    } catch {
        return { granted: [], denied: [] };
    }
}

function writeStoredGrants(key, granted, denied) {
    try {
        sessionStorage.setItem(key, JSON.stringify({
            granted: [...granted],
            denied: [...denied]
        }));
    } catch { /* private mode / quota */ }
}

function inferResponseType(mime, requested) {
    if (requested === 'json' || requested === 'text' || requested === 'dataurl' || requested === 'bytes') {
        return requested;
    }
    if ((mime || '').includes('json')) return 'json';
    if ((mime || '').startsWith('image/')) return 'dataurl';
    return 'text';
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function fetchObservatoryFile(project, filePath, responseType, owner = null) {
    const url = observatoryContentUrl(project, filePath, owner);
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) {
        let code = 'READ_FAILED';
        let message = 'Could not read that Observatory file.';
        try {
            const body = await response.json();
            code = body?.error?.code || code;
            message = body?.error?.message || message;
        } catch { /* not JSON */ }
        return { ok: false, error: { code, message, status: response.status } };
    }
    const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    const wanted = inferResponseType(mime, responseType);
    try {
        if (wanted === 'json') {
            return { ok: true, mime, content: await response.json(), encoding: 'json' };
        }
        if (wanted === 'text') {
            return { ok: true, mime, content: await response.text(), encoding: 'utf8' };
        }
        const buffer = await response.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        if (wanted === 'dataurl') {
            return { ok: true, mime, content: `data:${mime};base64,${base64}`, encoding: 'dataurl' };
        }
        return { ok: true, mime, content: base64, encoding: 'base64' };
    } catch {
        return { ok: false, error: { code: 'PARSE_FAILED', message: 'The file could not be parsed as requested.' } };
    }
}

/**
 * Injected into srcdoc so generated applets can write:
 *   const port = await connectToGoobster();
 *   const data = await request(port, { type: 'observatory.read', project, path });
 */
export const APPLET_BRIDGE_SCRIPT = `<script>
(function () {
    if (window.__goobsterBridge) return;
    window.__goobsterBridge = true;
    var portPromise = null;
    window.connectToGoobster = function connectToGoobster() {
        if (portPromise) return portPromise;
        portPromise = new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                window.removeEventListener('message', onMessage);
                reject(new Error('Goobster bridge timed out.'));
            }, 8000);
            function onMessage(event) {
                if (!event.data || event.data.type !== 'goobster:init') return;
                if (!event.ports || !event.ports[0]) return;
                window.removeEventListener('message', onMessage);
                clearTimeout(timer);
                var port = event.ports[0];
                port.start();
                resolve(port);
            }
            window.addEventListener('message', onMessage);
        });
        return portPromise;
    };
    window.request = function request(port, payload) {
        return new Promise(function (resolve, reject) {
            var id = (crypto.randomUUID && crypto.randomUUID()) ||
                (String(Date.now()) + Math.random());
            function onMessage(event) {
                var data = event.data;
                if (!data || data.id !== id) return;
                port.removeEventListener('message', onMessage);
                if (data.ok) resolve(data.content);
                else {
                    var err = new Error((data.error && data.error.message) || 'Request failed');
                    err.code = data.error && data.error.code;
                    reject(err);
                }
            }
            port.addEventListener('message', onMessage);
            var body = {};
            if (payload && typeof payload === 'object') {
                for (var key in payload) {
                    if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
                }
            }
            body.id = id;
            port.postMessage(body);
        });
    };
})();
</script>`;

export function withBridgeScript(source) {
    const html = String(source || '');
    if (/<head[\s>]/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>\n${APPLET_BRIDGE_SCRIPT}`);
    }
    if (/<html[\s>]/i.test(html)) {
        return html.replace(/<html([^>]*)>/i, `<html$1><head>${APPLET_BRIDGE_SCRIPT}</head>`);
    }
    return `${APPLET_BRIDGE_SCRIPT}${html}`;
}

/**
 * Own port1; on iframe load, transfer port2. Honor observatory.read for
 * the own project (implicit) or for declared + granted projects.
 *
 * @param {HTMLIFrameElement} frame
 * @param {object} options
 */
export function attachAppletBridge(frame, {
    source,
    ownProject = null,
    ownOwner = null,
    requestGrant,
    approvedGrants = [],
    onGrantsChange,
    appletTitle
} = {}) {
    const declared = new Set(extractObservatoryReadProjects(source));
    const own = String(ownProject || '').trim().toLowerCase();
    const implicitOwn = SLUG_RE.test(own) ? own : null;
    const implicitOwner = ownOwner ? String(ownOwner).trim() : null;
    const title = appletTitle || appletTitleFromSource(source);
    const storageKey = GRANT_STORAGE_PREFIX + contentHash(source);
    const stored = readStoredGrants(storageKey);
    const granted = new Set([
        ...approvedGrants.filter(slug => declared.has(slug)),
        ...stored.granted.filter(slug => declared.has(slug))
    ]);
    const denied = new Set(stored.denied.filter(slug => declared.has(slug)));
    const inflight = new Map();

    const persist = (notifyParent = false) => {
        writeStoredGrants(storageKey, granted, denied);
        if (notifyParent && typeof onGrantsChange === 'function') {
            onGrantsChange({ observatoryRead: [...granted] });
        }
    };

    const ask = typeof requestGrant === 'function'
        ? requestGrant
        : async () => false;

    async function ensureGranted(project) {
        if (granted.has(project)) return true;
        if (denied.has(project)) return false;
        if (inflight.has(project)) return inflight.get(project);
        const pending = (async () => {
            const ok = await ask(grantPromptMessage(title, project));
            if (ok) {
                granted.add(project);
                persist(true);
            } else {
                denied.add(project);
                persist(false);
            }
            return ok;
        })().finally(() => inflight.delete(project));
        inflight.set(project, pending);
        return pending;
    }

    async function handleRead(request) {
        const project = String(request?.project || '').trim().toLowerCase();
        const filePath = String(request?.path || '').trim();
        if (!SLUG_RE.test(project) || !filePath) {
            return { ok: false, error: { code: 'BAD_REQUEST', message: 'Need a project slug and a relative path.' } };
        }
        // Own-project reads skip declaration and the grant dialog.
        if (implicitOwn && project === implicitOwn) {
            return fetchObservatoryFile(project, filePath, request.responseType, implicitOwner);
        }
        if (!declared.has(project)) {
            return {
                ok: false,
                error: {
                    code: 'UNDECLARED_PROJECT',
                    message: `This mini-app did not declare Observatory project \`${project}\`.`
                }
            };
        }
        if (!await ensureGranted(project)) {
            return {
                ok: false,
                error: { code: 'GRANT_DENIED', message: 'Read access was not granted.' }
            };
        }
        return fetchObservatoryFile(project, filePath, request.responseType);
    }

    const onLoad = () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = async (event) => {
            const request = event.data;
            if (!request || request.type !== 'observatory.read') return;
            const id = request.id;
            let result;
            try {
                result = await handleRead(request);
            } catch {
                result = { ok: false, error: { code: 'READ_FAILED', message: 'Could not read that Observatory file.' } };
            }
            try {
                channel.port1.postMessage({ type: 'observatory.read.result', id, ...result });
            } catch { /* frame gone */ }
        };
        channel.port1.start();
        try {
            frame.contentWindow.postMessage({ type: 'goobster:init' }, '*', [channel.port2]);
        } catch { /* torn down */ }
    };

    frame.addEventListener('load', onLoad);
    return {
        detach: () => frame.removeEventListener('load', onLoad),
        getGranted: () => [...granted]
    };
}
