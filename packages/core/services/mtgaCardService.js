/**
 * Arena card catalog: resolves MTGA's numeric card ids (grpIds, the only
 * thing Player.log deck lists contain) to card names via Scryfall's keyless
 * API, cached permanently in the mtga_cards table - card printings never
 * change, so a resolved id never needs refetching. The same self-hosted
 * pattern as stockService's keyless Yahoo feed: no API key, graceful
 * failure, SQLite as the cache.
 *
 * Scryfall's bulk /cards/collection endpoint does not accept arena_id
 * identifiers, so unknown ids are fetched one at a time from
 * GET /cards/arena/{id} with the polite inter-request delay their API
 * guidelines ask for. Large first-time libraries are resolved in caller-
 * driven batches (resolveArenaIdsBatched) so a 4k-card catalog is a
 * sequence of short requests instead of one request that dies at a
 * hard cap or an HTTP timeout. 429s back off and retry; only the FIRST
 * import of a library pays this cost, after which the catalog is local.
 */

const axios = require('axios');
const db = require('../db');

const SCRYFALL_ARENA_URL = 'https://api.scryfall.com/cards/arena/';
const REQUEST_DELAY_MS = 80;      // Scryfall asks for 50-100ms between calls
const REQUEST_TIMEOUT_MS = 10000;
const RATE_LIMIT_RETRIES = 5;
const LOOKUP_BATCH_DEFAULT = 150;
const LOOKUP_BATCH_MIN = 25;
const LOOKUP_BATCH_MAX = 300;
const HEADERS = Object.freeze({
    'User-Agent': 'Goobster/1.0 (self-hosted Discord bot; MTGA deck import)',
    'Accept': 'application/json'
});

/** Machine-readable web app error (duck-typed status+code contract). */
class MtgaCardError extends Error {
    constructor(status, code, message, options = {}) {
        super(message, options);
        this.name = 'MtgaCardError';
        this.status = status;
        this.code = code;
    }
}

function clampLookupBudget(value) {
    if (value == null || value === '') return LOOKUP_BATCH_DEFAULT;
    const n = Number(value);
    if (!Number.isFinite(n)) return LOOKUP_BATCH_DEFAULT;
    return Math.max(LOOKUP_BATCH_MIN, Math.min(LOOKUP_BATCH_MAX, Math.floor(n)));
}

class MtgaCardService {
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Resolve Arena card ids to { name, setCode, collectorNumber }.
     * Cached ids answer locally; unknown ids are fetched from Scryfall and
     * cached forever. An id Scryfall does not know maps to null (the caller
     * decides how to degrade - it is never silently dropped).
     * @param {Iterable<number>} arenaIds
     * @returns {Promise<Map<number, {name, setCode, collectorNumber}|null>>}
     */
    async resolveArenaIds(arenaIds) {
        const { catalog } = await this.resolveArenaIdsBatched(arenaIds);
        return catalog;
    }

    /**
     * Same catalog as resolveArenaIds, but stops after `maxNewLookups` fresh
     * Scryfall fetches so a large library can be warmed across several
     * short HTTP requests. Already-cached ids never count against the budget.
     * @param {Iterable<number>} arenaIds
     * @param {Object} [options]
     * @param {number} [options.maxNewLookups]
     * @returns {Promise<{ catalog: Map, lookedUp: number, remaining: number, total: number }>}
     */
    async resolveArenaIdsBatched(arenaIds, { maxNewLookups = Infinity } = {}) {
        const unique = [...new Set(arenaIds)];
        const catalog = new Map();
        const missing = [];

        for (const arenaId of unique) {
            const row = await db.get(
                'SELECT name, setCode, collectorNumber FROM mtga_cards WHERE arenaId = @arenaId',
                { arenaId }
            );
            if (row) catalog.set(arenaId, row);
            else missing.push(arenaId);
        }

        const budget = Number.isFinite(maxNewLookups)
            ? Math.max(0, Math.floor(maxNewLookups))
            : missing.length;
        const toFetch = missing.slice(0, budget);

        for (const arenaId of toFetch) {
            const card = await this._fetchCard(arenaId);
            if (card) {
                await db.run(
                    `INSERT INTO mtga_cards (arenaId, name, setCode, collectorNumber)
                     VALUES (@arenaId, @name, @setCode, @collectorNumber)
                     ON CONFLICT (arenaId) DO NOTHING`,
                    { arenaId, ...card }
                );
            }
            catalog.set(arenaId, card);
            await this._sleep(REQUEST_DELAY_MS);
        }
        return {
            catalog,
            lookedUp: toFetch.length,
            remaining: missing.length - toFetch.length,
            total: unique.length
        };
    }

    /**
     * One Scryfall lookup. 404 = Scryfall doesn't know the id (returns null,
     * not cached - a card from a brand-new set may resolve next week); 429
     * retries with exponential backoff (honours Retry-After when present);
     * anything else is a clear 502 for the route to surface.
     */
    async _fetchCard(arenaId, attempt = 0) {
        try {
            const { data } = await axios.get(`${SCRYFALL_ARENA_URL}${arenaId}`, {
                timeout: REQUEST_TIMEOUT_MS,
                headers: HEADERS
            });
            if (!data?.name) return null;
            return {
                name: String(data.name),
                setCode: data.set ? String(data.set).toUpperCase() : null,
                collectorNumber: data.collector_number ? String(data.collector_number) : null
            };
        } catch (error) {
            const status = error.response?.status;
            if (status === 404) return null;
            if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
                const retryAfter = Number(error.response?.headers?.['retry-after']);
                const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.ceil(retryAfter * 1000)
                    : 1000 * (2 ** attempt);
                await this._sleep(waitMs);
                return await this._fetchCard(arenaId, attempt + 1);
            }
            throw new MtgaCardError(502, 'SCRYFALL_UNAVAILABLE',
                status === 429
                    ? 'Scryfall asked us to slow down - wait a minute and try the import again. Already-looked-up cards are cached.'
                    : 'Could not reach Scryfall to resolve card names - try the import again in a minute.',
                { cause: error });
        }
    }
}

module.exports = new MtgaCardService();
module.exports.MtgaCardService = MtgaCardService;
module.exports.MtgaCardError = MtgaCardError;
module.exports.clampLookupBudget = clampLookupBudget;
module.exports.LOOKUP_BATCH_DEFAULT = LOOKUP_BATCH_DEFAULT;
module.exports.LOOKUP_BATCH_MIN = LOOKUP_BATCH_MIN;
module.exports.LOOKUP_BATCH_MAX = LOOKUP_BATCH_MAX;
