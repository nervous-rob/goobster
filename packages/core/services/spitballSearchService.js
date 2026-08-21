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
 * MVP adapters:
 *  - wikipedia: keyless MediaWiki search + plain-text extracts. Real page
 *    text, so claims extracted from it have honest provenance.
 *  - perplexity: the existing Perplexity integration (optional, key-gated).
 *    Emits ONE synthesis source per query - the grounded answer text with
 *    its citation list in metadata - deliberately labeled
 *    sourceType 'search_synthesis' so downstream consumers can weight it
 *    below primary text.
 *
 * Future adapters (arXiv, Crossref, PubMed, user artifacts, uploaded PDFs)
 * plug in by appending to the provider list.
 */

const axios = require('axios');
const perplexityService = require('./perplexityService');
const logger = require('../utils/logger');

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIPEDIA_TIMEOUT_MS = 15_000;
/** Bounded extract length per article (the pipeline caps again on persist). */
const WIKIPEDIA_EXTRACT_CHARS = 12_000;

const wikipediaProvider = {
    name: 'wikipedia',

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

const perplexityProvider = {
    name: 'perplexity',

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
        this.providers = providers || [perplexityProvider, wikipediaProvider];
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
     * Run one query across every available provider. A provider failure is
     * logged and skipped - one broken adapter must never sink a cycle.
     * @param {string} query
     * @param {Object} [opts] - { limitPerProvider }
     * @returns {Promise<Array<Object>>} normalized source drafts
     */
    async search(query, { limitPerProvider = 3 } = {}) {
        const drafts = [];
        for (const provider of this.providers) {
            try {
                if (!provider.isAvailable()) continue;
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
