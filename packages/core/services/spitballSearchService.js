/**
 * Provider-agnostic source search for Spitball Expeditions (spec §11).
 * Spec: documentation/spitball_expeditions.md
 *
 * The domain model never depends on one search API: every adapter implements
 *
 *   { name, isAvailable() -> boolean,
 *     search(query, { limit }) -> Promise<NormalizedSourceDraft[]> }
 *
 * where a NormalizedSourceDraft is the pre-persistence shape
 *
 *   { provider, sourceType, url, title, author, publisher, publishedAt,
 *     text, metadata }
 *
 * (canonical URL, content hash, scoring, and dedupe happen downstream in the
 * pipeline, which is also where budgets live).
 *
 * Adapters:
 *  - wikipedia: keyless MediaWiki search + plain-text extracts. Real page
 *    text, so claims extracted from it have honest provenance.
 *  - perplexity: the existing Perplexity integration (optional, key-gated).
 *    Emits ONE synthesis source per query - the grounded answer text with
 *    its citation list in metadata - deliberately labeled
 *    sourceType 'search_synthesis' so downstream consumers can weight it
 *    below primary text.
 *  - arxiv: keyless arXiv Atom API (title + abstract). Marked
 *    onlyWhenPreferred, so it is queried only when the expedition's Lens
 *    prefers preprint/peer_reviewed source classes - the Lens influencing
 *    source selection, not just prompt wording (spec §6.2).
 *
 * Future adapters (Crossref, PubMed, user artifacts, uploaded PDFs) plug in
 * by appending to the provider list.
 */

const axios = require('axios');
const perplexityService = require('./perplexityService');
const logger = require('../utils/logger');

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_TIMEOUT_MS = 15_000;
/** Bounded extract length per article (the pipeline caps again on persist). */
const WIKIPEDIA_EXTRACT_CHARS = 12_000;

const ARXIV_API = 'http://export.arxiv.org/api/query';
const ARXIV_TIMEOUT_MS = 15_000;
const ARXIV_ABSTRACT_CHARS = 8_000;

/** Minimal Atom entity decoding for the fields we surface. */
function decodeXml(text) {
    return String(text || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

const wikipediaProvider = {
    name: 'wikipedia',
    sourceTypes: ['reference'],

    isAvailable() {
        return true; // keyless public API
    },

    /**
     * MediaWiki search -> plain-text intro extracts for the top hits.
     * @returns {Promise<Array<Object>>} normalized source drafts
     */
    async search(query, { limit = 3 } = {}) {
        const found = await axios.get(WIKIPEDIA_API, {
            timeout: WIKIPEDIA_TIMEOUT_MS,
            params: {
                action: 'query', list: 'search', srsearch: query,
                srlimit: Math.min(Math.max(limit, 1), 5), format: 'json',
                srprop: 'timestamp'
            },
            headers: { 'User-Agent': 'Goobster/1.0 (self-hosted Discord companion)' }
        });
        const hits = found.data?.query?.search || [];
        if (hits.length === 0) return [];

        const titles = hits.map(hit => hit.title).join('|');
        const extracts = await axios.get(WIKIPEDIA_API, {
            timeout: WIKIPEDIA_TIMEOUT_MS,
            params: {
                action: 'query', prop: 'extracts', titles,
                explaintext: 1, exsectionformat: 'plain', format: 'json',
                // Whole-article plain text is enormous; intro sections carry
                // the claim-worthy overview content.
                exintro: 1
            },
            headers: { 'User-Agent': 'Goobster/1.0 (self-hosted Discord companion)' }
        });
        const pages = Object.values(extracts.data?.query?.pages || {});
        const byTitle = new Map(pages.map(page => [page.title, page]));

        const drafts = [];
        for (const hit of hits) {
            const page = byTitle.get(hit.title);
            const text = String(page?.extract || '').slice(0, WIKIPEDIA_EXTRACT_CHARS);
            if (!text) continue;
            drafts.push({
                provider: 'wikipedia',
                sourceType: 'reference',
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
                title: hit.title,
                author: null,
                publisher: 'Wikipedia',
                publishedAt: hit.timestamp || null,
                text,
                metadata: { pageId: page?.pageid ?? null, query }
            });
        }
        return drafts;
    }
};

const arxivProvider = {
    name: 'arxiv',
    sourceTypes: ['preprint', 'peer_reviewed'],
    // Scholarly abstracts only help lenses that want them; a general or
    // storytelling expedition should not spend budget here.
    onlyWhenPreferred: true,

    isAvailable() {
        return true; // keyless public API
    },

    /** arXiv Atom search -> title + abstract drafts (dependency-free parse). */
    async search(query, { limit = 3 } = {}) {
        // AND-joined terms, not an exact phrase: generated research queries
        // rarely match a title/abstract verbatim.
        const terms = String(query).toLowerCase().split(/[^a-z0-9-]+/)
            .filter(term => term.length > 2).slice(0, 6);
        if (terms.length === 0) return [];
        const response = await axios.get(ARXIV_API, {
            timeout: ARXIV_TIMEOUT_MS,
            params: {
                search_query: terms.map(term => `all:${term}`).join(' AND '),
                start: 0,
                max_results: Math.min(Math.max(limit, 1), 5),
                sortBy: 'relevance'
            },
            headers: { 'User-Agent': 'Goobster/1.0 (self-hosted Discord companion)' },
            responseType: 'text'
        });
        const xml = String(response.data || '');
        const drafts = [];
        for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
            const entry = match[1];
            const id = decodeXml(entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]);
            const title = decodeXml(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]);
            const summary = decodeXml(entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]);
            const published = decodeXml(entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]);
            const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
                .map(m => decodeXml(m[1])).filter(Boolean).slice(0, 6);
            if (!title || !summary) continue;
            drafts.push({
                provider: 'arxiv',
                sourceType: 'preprint',
                url: id || null,
                title,
                author: authors.join(', ') || null,
                publisher: 'arXiv',
                publishedAt: published || null,
                text: `${title}. ${summary}`.slice(0, ARXIV_ABSTRACT_CHARS),
                metadata: { query, abstractOnly: true }
            });
        }
        return drafts;
    }
};

const perplexityProvider = {
    name: 'perplexity',
    sourceTypes: ['search_synthesis'],

    isAvailable() {
        return perplexityService.isConfigured();
    },

    async search(query) {
        const { content, searchResults } = await perplexityService.searchDetailed(query);
        const text = String(content || '').trim();
        if (!text) return [];
        return [{
            provider: 'perplexity',
            sourceType: 'search_synthesis',
            url: null,
            title: `Web research: ${String(query).slice(0, 150)}`,
            author: null,
            publisher: 'Perplexity',
            publishedAt: null,
            text,
            metadata: {
                query,
                citations: searchResults
                    .map(result => ({
                        title: String(result?.title || '').slice(0, 200) || null,
                        url: String(result?.url || '').slice(0, 500) || null
                    }))
                    .filter(citation => citation.url)
                    .slice(0, 20)
            }
        }];
    }
};

class SpitballSearchService {
    /** @param {Array<Object>} [providers] - adapter overrides (tests inject) */
    constructor(providers = null) {
        this.providers = providers || [perplexityProvider, wikipediaProvider, arxivProvider];
    }

    /** @returns {string[]} names of the adapters usable right now */
    availableProviders() {
        return this.providers.filter(provider => {
            try {
                return provider.isAvailable();
            } catch {
                return false;
            }
        }).map(provider => provider.name);
    }

    /**
     * Run one query across every eligible provider. A provider failure is
     * logged and skipped - one broken adapter must never sink a cycle.
     * Providers marked `onlyWhenPreferred` participate only when the Lens's
     * preferred source classes intersect theirs; general-purpose providers
     * always run so a narrow Lens never zeroes out the search.
     * @param {string} query
     * @param {Object} [opts] - { limitPerProvider, preferredSourceTypes }
     * @returns {Promise<Array<Object>>} normalized source drafts
     */
    async search(query, { limitPerProvider = 3, preferredSourceTypes = null } = {}) {
        const preferred = Array.isArray(preferredSourceTypes) ? new Set(preferredSourceTypes) : null;
        const drafts = [];
        for (const provider of this.providers) {
            try {
                if (!provider.isAvailable()) continue;
                if (provider.onlyWhenPreferred) {
                    const wanted = preferred
                        && (provider.sourceTypes || []).some(type => preferred.has(type));
                    if (!wanted) continue;
                }
                const results = await provider.search(query, { limit: limitPerProvider });
                for (const draft of results || []) {
                    if (draft && draft.text) drafts.push(draft);
                }
            } catch (error) {
                logger.warn?.(`[spitball] Search provider ${provider.name} failed for "${String(query).slice(0, 80)}": ${error.message}`);
            }
        }
        return drafts;
    }
}

module.exports = new SpitballSearchService();
module.exports.SpitballSearchService = SpitballSearchService;
module.exports.wikipediaProvider = wikipediaProvider;
module.exports.perplexityProvider = perplexityProvider;
module.exports.arxivProvider = arxivProvider;
