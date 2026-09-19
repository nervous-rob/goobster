/**
 * Web image search behind the findImages tool - a small provider registry
 * in the spitballSearchService shape. Every adapter returns the same
 * candidate:
 *
 *   { title, imageUrl, pageUrl, width, height, mime, description,
 *     credit, license, provider }
 *
 * Adapters, in the order they are asked:
 *   - wikipedia  (keyless): the lead image of the best-matching article -
 *                high precision for "what does X look like".
 *   - commons    (keyless): Wikimedia Commons file search (bitmaps only),
 *                with description/artist/license from the file page.
 *   - perplexity (optional, needs PERPLEXITY_API_KEY): `return_images`,
 *                asked only when the free providers came up short. Plans
 *                without image support answer with nothing, which is fine.
 *
 * No provider is required: with no network at all the tool reports "no
 * images found" instead of failing. Candidates are deduplicated by URL and
 * filtered by size so icons and thumbnails never win.
 */

const config = require('../config/fileDiscoveryConfig');

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const RASTER_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function stripHtml(html) {
    return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function cleanFileTitle(title) {
    return String(title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').trim();
}

function stripTracking(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        for (const key of [...u.searchParams.keys()]) {
            if (key.startsWith('utm_')) u.searchParams.delete(key);
        }
        return u.toString();
    } catch {
        return url;
    }
}

/** Normalize one MediaWiki `imageinfo` entry into a candidate. */
function candidateFromImageInfo(page, provider) {
    const info = page?.imageinfo?.[0];
    if (!info) return null;
    const mime = String(info.mime || '').toLowerCase();
    const rasterOriginal = RASTER_MIMES.has(mime);
    // Small raster originals are taken as-is; big ones (and SVG/PDF/TIFF
    // pages, which still have a raster thumbnail) use the sized thumbnail
    // so the portal gets something it can show without an 8MB download.
    const useOriginal = rasterOriginal
        && (info.size || 0) <= config.MAX_FILE_BYTES
        && (info.width || 0) <= config.THUMB_WIDTH;
    const imageUrl = stripTracking(useOriginal ? info.url : (info.thumburl || (rasterOriginal ? info.url : null)));
    if (!imageUrl) return null;
    const width = useOriginal || !info.thumburl ? info.width : info.thumbwidth;
    const height = useOriginal || !info.thumburl ? info.height : info.thumbheight;
    const meta = info.extmetadata || {};
    return {
        title: cleanFileTitle(page.title),
        imageUrl,
        pageUrl: info.descriptionurl || null,
        width: Number(width) || null,
        height: Number(height) || null,
        mime: rasterOriginal ? mime : (/\.png(\?|$)/i.test(imageUrl) ? 'image/png' : 'image/jpeg'),
        description: stripHtml(meta.ImageDescription?.value).slice(0, 300) || null,
        credit: stripHtml(meta.Artist?.value).slice(0, 120) || stripHtml(meta.Credit?.value).slice(0, 120) || null,
        license: stripHtml(meta.LicenseShortName?.value).slice(0, 60) || null,
        provider
    };
}

class ImageSearchService {
    /**
     * @param {Object} [deps]
     * @param {Function} [deps.fetch] - fetch implementation (tests)
     * @param {Object} [deps.perplexity] - service with isConfigured()/searchImages()
     */
    constructor(deps = {}) {
        this._fetch = deps.fetch || ((...args) => globalThis.fetch(...args));
        this._perplexity = deps.perplexity || null;
    }

    get perplexity() {
        if (this._perplexity === null) {
            this._perplexity = require('./perplexityService');
        }
        return this._perplexity;
    }

    /** Names of the providers that would be asked right now. */
    listProviders() {
        const providers = ['wikipedia', 'commons'];
        if (this.perplexity?.isConfigured?.()) providers.push('perplexity');
        return providers;
    }

    async _getJson(base, params) {
        const url = new URL(base);
        for (const [key, value] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
            url.searchParams.set(key, String(value));
        }
        const response = await this._fetch(url.toString(), {
            headers: { 'User-Agent': config.USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(config.SEARCH_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`${url.hostname} answered ${response.status}`);
        return await response.json();
    }

    /** Commons file search restricted to bitmaps; imageinfo rides the same call. */
    async searchCommons(query, limit) {
        const data = await this._getJson(COMMONS_API, {
            action: 'query',
            generator: 'search',
            gsrsearch: `${query} filetype:bitmap`,
            gsrnamespace: 6,
            gsrlimit: Math.max(1, Math.min(10, limit)),
            prop: 'imageinfo',
            iiprop: 'url|size|mime|extmetadata',
            iiurlwidth: config.THUMB_WIDTH,
            iiextmetadatafilter: 'ImageDescription|Artist|Credit|LicenseShortName'
        });
        const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
        return pages
            .sort((a, b) => (a.index || 0) - (b.index || 0))
            .map(page => candidateFromImageInfo(page, 'Wikimedia Commons'))
            .filter(Boolean);
    }

    /** Lead image of the best-matching English Wikipedia article(s). */
    async searchWikipediaLead(query, limit) {
        const data = await this._getJson(WIKIPEDIA_API, {
            action: 'query',
            generator: 'search',
            gsrsearch: query,
            gsrlimit: Math.max(1, Math.min(3, limit)),
            prop: 'pageimages',
            piprop: 'name'
        });
        const pages = (Array.isArray(data?.query?.pages) ? data.query.pages : [])
            .sort((a, b) => (a.index || 0) - (b.index || 0))
            .filter(page => page.pageimage);
        if (pages.length === 0) return [];
        const titles = pages.map(page => `File:${page.pageimage}`);
        const info = await this._getJson(WIKIPEDIA_API, {
            action: 'query',
            titles: titles.join('|'),
            prop: 'imageinfo',
            iiprop: 'url|size|mime|extmetadata',
            iiurlwidth: config.THUMB_WIDTH,
            iiextmetadatafilter: 'ImageDescription|Artist|Credit|LicenseShortName'
        });
        const infoPages = Array.isArray(info?.query?.pages) ? info.query.pages : [];
        const byName = new Map(infoPages.map(page => [cleanFileTitle(page.title).toLowerCase(), page]));
        const out = [];
        for (const page of pages) {
            const infoPage = byName.get(cleanFileTitle(page.pageimage).toLowerCase());
            const candidate = candidateFromImageInfo(infoPage, 'Wikipedia');
            if (!candidate) continue;
            out.push({
                ...candidate,
                // The article title reads better than the file name.
                title: page.title || candidate.title,
                description: candidate.description || `Lead image of the Wikipedia article "${page.title}".`
            });
        }
        return out;
    }

    async searchPerplexity(query) {
        if (!this.perplexity?.isConfigured?.()) return [];
        const images = await this.perplexity.searchImages(query);
        return images.map(img => ({
            title: null,
            imageUrl: stripTracking(img.imageUrl),
            pageUrl: img.pageUrl,
            width: img.width,
            height: img.height,
            mime: null,
            description: null,
            credit: img.pageUrl ? (() => { try { return new URL(img.pageUrl).hostname.replace(/^www\./, ''); } catch { return null; } })() : null,
            license: null,
            provider: 'Perplexity'
        }));
    }

    /**
     * @param {string} query
     * @param {{ limit?: number }} [opts] - how many the caller wants; more
     *   candidates than that are returned so download failures can be skipped.
     * @returns {Promise<{ candidates: Array, providersTried: string[], errors: string[] }>}
     */
    async search(query, { limit = config.DEFAULT_IMAGES_PER_CALL } = {}) {
        const want = Math.max(1, Math.min(config.MAX_IMAGES_PER_CALL, Number(limit) || 1));
        const clean = String(query || '').trim();
        if (!clean) return { candidates: [], providersTried: [], errors: [] };

        const providersTried = [];
        const errors = [];
        const seen = new Set();
        const candidates = [];
        const add = (list) => {
            for (const cand of list) {
                if (!cand?.imageUrl || seen.has(cand.imageUrl)) continue;
                if ((cand.width && cand.width < config.MIN_IMAGE_DIMENSION)
                    || (cand.height && cand.height < config.MIN_IMAGE_DIMENSION)) continue;
                seen.add(cand.imageUrl);
                candidates.push(cand);
            }
        };

        const tryProvider = async (name, fn) => {
            providersTried.push(name);
            try {
                add(await fn());
            } catch (error) {
                errors.push(`${name}: ${error?.message || 'failed'}`);
            }
        };

        await tryProvider('wikipedia', () => this.searchWikipediaLead(clean, 1));
        await tryProvider('commons', () => this.searchCommons(clean, want + 3));
        if (candidates.length < want && this.perplexity?.isConfigured?.()) {
            await tryProvider('perplexity', () => this.searchPerplexity(clean));
        }
        return { candidates: rankByRelevance(clean, candidates).slice(0, want + 3), providersTried, errors };
    }
}

/**
 * Lexical relevance: the share of query terms found in a candidate's title
 * + description. Search engines match loosely ("M43" also names a
 * cartridge and a German cap), so candidates covering more of the actual
 * words win, and zero-coverage ones are dropped when anything better
 * exists. Providers without titles (Perplexity) keep their engine order.
 */
function rankByRelevance(query, candidates) {
    // "M-1943", "M1943" and "U.S." should all meet: drop punctuation that
    // sits between alphanumerics before tokenizing.
    const normalize = (text) => String(text || '').toLowerCase().replace(/(?<=[\p{L}\p{N}])[-.](?=[\p{L}\p{N}])/gu, '');
    const terms = normalize(query).split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2);
    if (terms.length === 0) return candidates;
    const coverage = (text) => {
        const hay = ` ${normalize(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
        return terms.filter(t => hay.includes(t)).length / terms.length;
    };
    const scored = candidates.map((cand, index) => {
        const scorable = Boolean(cand.title || cand.description);
        // The title counts double because Commons descriptions are long and
        // mention everything in the frame; a Wikipedia lead image earns a
        // precision bonus - it is the picture an encyclopedia chose for the
        // thing itself.
        const relevance = scorable
            ? Math.min(1, (2 * coverage(cand.title) + coverage(cand.description)) / 3)
            : null;
        const score = (relevance ?? 0) + (cand.provider === 'Wikipedia' && relevance > 0 ? 0.25 : 0);
        return { cand, index, scorable, relevance, score };
    });
    const best = Math.max(0, ...scored.map(s => s.relevance || 0));
    return scored
        .filter(s => !s.scorable || best === 0 || s.relevance > 0)
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map(s => ({ ...s.cand, relevance: s.relevance }));
}

module.exports = new ImageSearchService();
module.exports.ImageSearchService = ImageSearchService;
module.exports.candidateFromImageInfo = candidateFromImageInfo;
module.exports.rankByRelevance = rankByRelevance;
