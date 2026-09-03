/**
 * Capability declarations and grant helpers for sandboxed mini-apps.
 *
 * Applets run on an opaque origin (no allow-same-origin). Cross-project
 * reads declare Observatory projects via
 *   <meta name="goobster-observatory-read" content="project-slug">
 * and the trusted parent honors only those slugs after a user grant.
 * An app asset rendered from inside project X may read X's workspace
 * with no meta tag and no grant (own-project short-circuit). Legacy
 * Workshop pins pass ownProject=null and keep the declare+grant rule.
 * Shared by the pin path (persisted grants) and tests; the browser
 * bridge keeps a matching parser + short-circuit in apps/web.
 */

const OBSERVATORY_READ_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const META_TAG_RE = /<meta\b[^>]*>/gi;

function normalizeSlug(value) {
    const slug = String(value || '').trim().toLowerCase();
    return OBSERVATORY_READ_SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Project slugs declared by goobster-observatory-read meta tags.
 * Accepts comma- or whitespace-separated values and multiple tags.
 * @param {string} source
 * @returns {string[]}
 */
function extractObservatoryReadProjects(source) {
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
            const slug = normalizeSlug(part);
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            slugs.push(slug);
        }
    }
    return slugs;
}

/**
 * Owner-only content URL for one workspace-relative path. Encodes each
 * segment so slashes stay path separators.
 * @param {string} project
 * @param {string} relativePath
 */
function observatoryContentUrl(project, relativePath) {
    const slug = encodeURIComponent(String(project || '').trim());
    const pathPart = String(relativePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
    return `/api/app/observatory/projects/${slug}/content/${pathPart}`;
}

/**
 * Legalize a grants payload. Unknown keys dropped; slugs validated.
 * @param {unknown} grants
 * @returns {{ observatoryRead: string[] }}
 */
function normalizeObservatoryGrants(grants) {
    const list = Array.isArray(grants?.observatoryRead)
        ? grants.observatoryRead
        : Array.isArray(grants) ? grants : [];
    const observatoryRead = [];
    const seen = new Set();
    for (const item of list) {
        const slug = normalizeSlug(item);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        observatoryRead.push(slug);
    }
    return { observatoryRead };
}

/**
 * Approved grants that the applet still declares. A stored grant for a
 * project the source no longer names is ignored.
 * @param {string} source
 * @param {unknown} grants
 */
function legalizeObservatoryGrants(source, grants) {
    const declared = new Set(extractObservatoryReadProjects(source));
    const normalized = normalizeObservatoryGrants(grants);
    return {
        observatoryRead: normalized.observatoryRead.filter(slug => declared.has(slug))
    };
}

/**
 * Whether a mini-app may read `requestedProject` through the owner-only
 * content route. Own-project reads (asset rendered inside that project)
 * are allowed with no declaration and no grant. Cross-project reads still
 * require a declared meta tag plus an approved grant. Pass ownProject=null
 * for legacy Workshop pins so they keep today's declare+grant behavior.
 *
 * This is the non-interactive check (already-granted). The parent bridge
 * mirrors the same short-circuit, then prompts for missing cross-project
 * grants.
 *
 * @param {string} requestedProject
 * @param {{ source?: string, grants?: unknown, ownProject?: string|null }} [opts]
 * @returns {boolean}
 */
function isObservatoryReadAllowed(requestedProject, {
    source = '',
    grants = undefined,
    ownProject = null
} = {}) {
    const slug = normalizeSlug(requestedProject);
    if (!slug) return false;
    const own = normalizeSlug(ownProject);
    if (own && slug === own) return true;
    const declared = new Set(extractObservatoryReadProjects(source));
    if (!declared.has(slug)) return false;
    return legalizeObservatoryGrants(source, grants).observatoryRead.includes(slug);
}

module.exports = {
    OBSERVATORY_READ_SLUG_PATTERN,
    extractObservatoryReadProjects,
    observatoryContentUrl,
    normalizeObservatoryGrants,
    legalizeObservatoryGrants,
    isObservatoryReadAllowed
};
