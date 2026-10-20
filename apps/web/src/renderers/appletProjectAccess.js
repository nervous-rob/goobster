import { accountFetch, accountStoragePrefix } from '../lib/browserAccount';
import { api } from '../lib/api';
/**
 * Project access for an app opened from its own project's Apps tab: list,
 * read, write and delete workspace files and notes/scripts, and run
 * workspace files and script assets.
 *
 * Reading the own project needs nothing (as before). Write, delete and run
 * are capabilities the app must DECLARE in its source:
 *
 *   <meta name="goobster-project-access" content="write delete run">
 *
 * and the viewer approves each one the first time the app uses it. The
 * approval is remembered in this browser for this exact source (a new
 * version of the app asks again); a refusal lasts for the session. The
 * parent does every call with the viewer's own session and permissions,
 * so an app can never do more than the person looking at it.
 *
 * Apps may never write or delete an app asset (themselves included).
 */

export const PROJECT_ACCESS_META = 'goobster-project-access';
export const PROJECT_CAPABILITIES = ['write', 'delete', 'run'];
const CAPABILITY_TEXT = {
    write: 'create and change files and notes',
    delete: 'delete files and notes',
    run: 'run programs (workspace files and scripts)'
};
const ACCESS_STORAGE = 'goobster:applet-access:';
const MAX_WRITE_CHARS = 20 * 1024 * 1024;
const ASSET_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Capabilities the source declares in its goobster-project-access meta tag. */
export function extractProjectAccess(source) {
    const declared = new Set();
    const html = String(source || '');
    const metaRe = /<meta\b[^>]*>/gi;
    let match;
    while ((match = metaRe.exec(html))) {
        const tag = match[0];
        const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
        if (!name || name[1].toLowerCase() !== PROJECT_ACCESS_META) continue;
        const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const value = content ? (content[1] ?? content[2] ?? content[3] ?? '') : '';
        for (const part of value.split(/[\s,]+/)) {
            const cap = part.trim().toLowerCase();
            if (PROJECT_CAPABILITIES.includes(cap)) declared.add(cap);
        }
    }
    return [...declared];
}

function sourceHash(source) {
    let hash = 5381;
    const text = String(source || '');
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36) + text.length.toString(36);
}

function accessKey(project, owner, source) {
    return `${accountStoragePrefix()}${ACCESS_STORAGE}${owner || ''}:${project}:${sourceHash(source)}`;
}

function readSet(storage, key) {
    try {
        const parsed = JSON.parse(storage.getItem(key) || '[]');
        return new Set(Array.isArray(parsed) ? parsed.filter(cap => PROJECT_CAPABILITIES.includes(cap)) : []);
    } catch {
        return new Set();
    }
}

function writeSet(storage, key, set) {
    try {
        if (set.size) storage.setItem(key, JSON.stringify([...set]));
        else storage.removeItem(key);
    } catch { /* storage unavailable: the approval lasts for this frame only */ }
}

/** What this viewer has approved for this app source (for the Apps tab's access strip).
 * @param {{ project: string, owner?: string|null, source: string }} params
 */
export function readAppletAccess({ project, owner = null, source }) {
    const key = accessKey(project, owner, source);
    let allowed = new Set();
    let denied = new Set();
    try { allowed = readSet(localStorage, key); } catch { /* blocked */ }
    try { denied = readSet(sessionStorage, key); } catch { /* blocked */ }
    return { declared: extractProjectAccess(source), allowed: [...allowed], denied: [...denied] };
}

/** Forget every approval and refusal for this app source; it asks again next time.
 * @param {{ project: string, owner?: string|null, source: string }} params
 */
export function resetAppletAccess({ project, owner = null, source }) {
    const key = accessKey(project, owner, source);
    try { localStorage.removeItem(key); } catch { /* blocked */ }
    try { sessionStorage.removeItem(key); } catch { /* blocked */ }
}

function fail(code, message, status) {
    return { ok: false, error: { code, message, ...(status ? { status } : {}) } };
}

function failFrom(error, fallback) {
    return fail(error?.code || fallback, error?.message || 'The request failed.', error?.status);
}

function cleanPath(value, { allowEmpty = false } = {}) {
    const text = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!text && !allowEmpty) return null;
    if (text.split('/').some(part => part === '..')) return null;
    return text;
}

function contentUrl(project, filePath, owner) {
    const pathPart = filePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const qs = owner ? `?owner=${encodeURIComponent(owner)}` : '';
    return `/api/app/projects/${encodeURIComponent(project)}/content/${pathPart}${qs}`;
}

function base64ToBytes(base64) {
    const binary = atob(String(base64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** Turn a project.write payload into what putProjectContent sends. */
function writeBody(content, encoding) {
    const kind = String(encoding || (typeof content === 'string' ? 'utf8' : 'json')).toLowerCase();
    if (kind === 'json') return JSON.stringify(content, null, 2);
    if (kind === 'utf8' || kind === 'text') return String(content ?? '');
    if (kind === 'base64') return new Blob([base64ToBytes(content)]);
    if (kind === 'dataurl') {
        const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(content || ''));
        if (!match) return null;
        return new Blob([match[2] ? base64ToBytes(match[3]) : decodeURIComponent(match[3])], { type: match[1] || '' });
    }
    return null;
}

async function readContent(project, filePath, owner, responseType) {
    const response = await accountFetch(contentUrl(project, filePath, owner), { credentials: 'same-origin' });
    if (!response.ok) {
        let code = 'READ_FAILED';
        let message = 'Could not read that file.';
        try {
            const body = await response.json();
            code = body?.error?.code || code;
            message = body?.error?.message || message;
        } catch { /* not JSON */ }
        return fail(code, message, response.status);
    }
    const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    const wanted = ['json', 'text', 'dataurl', 'bytes'].includes(responseType)
        ? responseType
        : mime.includes('json') ? 'json' : mime.startsWith('image/') ? 'dataurl' : 'text';
    try {
        if (wanted === 'json') return { ok: true, mime, content: await response.json(), encoding: 'json' };
        if (wanted === 'text') return { ok: true, mime, content: await response.text(), encoding: 'utf8' };
        const base64 = bytesToBase64(await response.arrayBuffer());
        if (wanted === 'dataurl') return { ok: true, mime, content: `data:${mime};base64,${base64}`, encoding: 'dataurl' };
        return { ok: true, mime, content: base64, encoding: 'base64' };
    } catch {
        return fail('PARSE_FAILED', 'The file could not be parsed as requested.');
    }
}

/** True for every message type this module answers. */
export function isProjectAccessType(type) {
    return typeof type === 'string' && (type.startsWith('project.') || type.startsWith('assets.'));
}

/**
 * The handler for one framed app. `project` is null outside a project's
 * Apps tab (chat fences, Workshop pins): every request is then refused.
 *
 * @param {object} options
 * @param {string|null} options.project own project slug
 * @param {string|null} [options.owner] its owner (owner-qualified addresses)
 * @param {string} options.source the app's source (declarations, approval key)
 * @param {string} options.title for the approval prompt
 * @param {(message: string) => Promise<boolean>} [options.requestGrant]
 * @param {(entry: object) => void} [options.onActivity] one entry per call
 * @param {(what: 'files'|'assets'|'runs') => void} [options.onChanged] after a write, delete or run
 */
export function createProjectAccess({ project, owner = null, source, title, requestGrant, onActivity, onChanged }) {
    const declared = new Set(extractProjectAccess(source));
    const key = project ? accessKey(project, owner, source) : null;
    let allowed = new Set();
    let denied = new Set();
    if (key) {
        try { allowed = readSet(localStorage, key); } catch { /* blocked */ }
        try { denied = readSet(sessionStorage, key); } catch { /* blocked */ }
    }
    const inflight = new Map();
    const ask = typeof requestGrant === 'function' ? requestGrant : async () => false;

    async function ensure(capability) {
        if (!declared.has(capability)) {
            return fail('UNDECLARED_CAPABILITY',
                `This app did not declare "${capability}". Add <meta name="${PROJECT_ACCESS_META}" content="${capability}"> to its <head>.`);
        }
        // Read the stores again: the Apps tab may have reset them meanwhile.
        try { allowed = readSet(localStorage, key); } catch { /* blocked */ }
        try { denied = readSet(sessionStorage, key); } catch { /* blocked */ }
        if (allowed.has(capability)) return null;
        if (denied.has(capability)) return fail('ACCESS_DENIED', `You did not allow this app to ${CAPABILITY_TEXT[capability]}.`);
        if (!inflight.has(capability)) {
            inflight.set(capability, (async () => {
                const ok = await ask(`"${title}" wants to ${CAPABILITY_TEXT[capability]} in project ${project}, as you. `
                    + 'Allow it for this version of the app?');
                if (ok) {
                    allowed.add(capability);
                    try { writeSet(localStorage, key, allowed); } catch { /* blocked */ }
                } else {
                    denied.add(capability);
                    try { writeSet(sessionStorage, key, denied); } catch { /* blocked */ }
                }
                return ok;
            })().finally(() => inflight.delete(capability)));
        }
        return (await inflight.get(capability))
            ? null
            : fail('ACCESS_DENIED', `You did not allow this app to ${CAPABILITY_TEXT[capability]}.`);
    }

    async function assetKind(asset) {
        const detail = await api.projectAsset(project, asset, undefined, owner);
        return detail?.kind || null;
    }

    const handlers = {
        'project.list': async (req) => {
            const dir = cleanPath(req.path, { allowEmpty: true });
            if (dir == null) return fail('BAD_PATH', 'Need a workspace-relative folder.');
            const listing = await api.projectFiles(project, dir, owner);
            const entries = (listing?.entries || []).map(({ path, name, kind, size, modifiedAt }) => ({ path, name, kind, size, modifiedAt }));
            return { ok: true, content: entries };
        },
        'project.read': async (req) => {
            const filePath = cleanPath(req.path);
            if (!filePath) return fail('BAD_PATH', 'Need a workspace-relative file path.');
            return readContent(project, filePath, owner, req.responseType);
        },
        'project.write': async (req) => {
            const filePath = cleanPath(req.path);
            if (!filePath) return fail('BAD_PATH', 'Need a workspace-relative file path.');
            const refused = await ensure('write');
            if (refused) return refused;
            const body = writeBody(req.content, req.encoding);
            if (body == null) return fail('BAD_CONTENT', 'encoding must be utf8, json, base64 or dataurl.');
            if (typeof body === 'string' && body.length > MAX_WRITE_CHARS) return fail('FILE_TOO_LARGE', 'That is too much text for one write.');
            const written = await api.putProjectContent(project, filePath, body, owner);
            onChanged?.('files');
            return { ok: true, content: written };
        },
        'project.delete': async (req) => {
            const filePath = cleanPath(req.path);
            if (!filePath) return fail('BAD_PATH', 'Need a workspace-relative file path.');
            const refused = await ensure('delete');
            if (refused) return refused;
            const result = await api.deleteProjectContent(project, filePath, owner);
            onChanged?.('files');
            return { ok: true, content: result };
        },
        'project.run': async (req) => {
            const filePath = cleanPath(req.path);
            if (!filePath) return fail('BAD_PATH', 'Need the workspace file to run.');
            const refused = await ensure('run');
            if (refused) return refused;
            const args = Array.isArray(req.args) ? req.args.map(String) : [];
            const result = await api.runProjectFile(project, {
                path: filePath, args, stdin: typeof req.stdin === 'string' ? req.stdin : undefined,
                background: req.background === true, startedBy: 'app'
            }, owner);
            onChanged?.('runs');
            return { ok: true, content: result };
        },
        'project.job': async (req) => {
            const jobId = Number(req.jobId);
            if (!Number.isInteger(jobId) || jobId <= 0) return fail('BAD_REQUEST', 'Need a jobId.');
            const refused = await ensure('run');
            if (refused) return refused;
            return { ok: true, content: await api.observatoryJobLive(jobId, req.since || null) };
        },
        'assets.list': async (req) => {
            const kind = ['app', 'script', 'note'].includes(req.kind) ? req.kind : undefined;
            const listing = await api.projectAssets(project, kind, owner);
            return { ok: true, content: listing?.assets || [] };
        },
        'assets.read': async (req) => {
            const asset = String(req.asset || '').trim().toLowerCase();
            if (!ASSET_SLUG_RE.test(asset)) return fail('BAD_REQUEST', 'Need an asset slug.');
            const version = Number.isInteger(req.version) ? req.version : undefined;
            const detail = await api.projectAsset(project, asset, version, owner);
            const { slug, name, kind, language, source: text, version: v, currentVersion } = detail || {};
            return { ok: true, content: { slug, name, kind, language, source: text, version: v, currentVersion } };
        },
        'assets.write': async (req) => {
            const asset = String(req.asset || '').trim().toLowerCase();
            if (!ASSET_SLUG_RE.test(asset)) return fail('BAD_REQUEST', 'Need an asset slug.');
            const kind = req.kind === 'script' ? 'script' : req.kind === 'note' || req.kind == null ? 'note' : null;
            if (!kind) return fail('APP_PROTECTED', 'Apps can save notes and scripts, not apps.');
            const refused = await ensure('write');
            if (refused) return refused;
            const saved = await api.saveProjectAsset(project, {
                slug: asset,
                name: typeof req.name === 'string' && req.name.trim() ? req.name.trim() : asset,
                kind,
                language: typeof req.language === 'string' ? req.language : undefined,
                source: String(req.source ?? ''),
                note: typeof req.note === 'string' && req.note.trim() ? req.note.trim() : `Saved by the app "${title}"`,
                origin: 'portal'
            }, owner);
            onChanged?.('assets');
            return { ok: true, content: saved };
        },
        'assets.delete': async (req) => {
            const asset = String(req.asset || '').trim().toLowerCase();
            if (!ASSET_SLUG_RE.test(asset)) return fail('BAD_REQUEST', 'Need an asset slug.');
            const refused = await ensure('delete');
            if (refused) return refused;
            if (await assetKind(asset) === 'app') return fail('APP_PROTECTED', 'Apps cannot delete apps.');
            const result = await api.deleteProjectAsset(project, asset, owner);
            onChanged?.('assets');
            return { ok: true, content: result };
        },
        'assets.run': async (req) => {
            const asset = String(req.asset || '').trim().toLowerCase();
            if (!ASSET_SLUG_RE.test(asset)) return fail('BAD_REQUEST', 'Need an asset slug.');
            const refused = await ensure('run');
            if (refused) return refused;
            const result = await api.runProjectAsset(project, asset, req.background === true, owner, 'app');
            onChanged?.('runs');
            return { ok: true, content: result };
        }
    };

    /** Answer one request; never throws. */
    async function handle(request) {
        const type = String(request?.type || '');
        const run = handlers[type];
        let result;
        if (!project) {
            result = fail('NO_PROJECT', 'Project access works only for an app opened from its project\'s Apps tab.');
        } else if (!run) {
            result = fail('UNKNOWN_REQUEST', `Unknown request type "${type}".`);
        } else {
            try {
                result = await run(request);
            } catch (error) {
                result = failFrom(error, 'REQUEST_FAILED');
            }
        }
        try {
            onActivity?.({
                at: Date.now(),
                type,
                target: request?.path ?? request?.asset ?? (request?.jobId != null ? `job ${request.jobId}` : ''),
                ok: result.ok,
                code: result.ok ? null : result.error?.code || null
            });
        } catch { /* the log is best effort */ }
        return result;
    }

    return {
        handle,
        context: project ? { project, owner, access: [...declared] } : null
    };
}
