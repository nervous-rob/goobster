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
 * guidelines ask for. Only the FIRST import of a library pays this cost -
 * a few hundred lookups, roughly a minute - after which the whole catalog
 * relevant to the user is local.
 */

const axios = require('axios');
const db = require('../db');

const SCRYFALL_ARENA_URL = 'https://api.scryfall.com/cards/arena/';
const REQUEST_DELAY_MS = 80;      // Scryfall asks for 50-100ms between calls
const REQUEST_TIMEOUT_MS = 10000;
const MAX_NEW_LOOKUPS = 1500;     // one import can grow the catalog this much
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class MtgaCardService {
    /**
     * Resolve Arena card ids to { name, setCode, collectorNumber }.
     * Cached ids answer locally; unknown ids are fetched from Scryfall and
     * cached forever. An id Scryfall does not know maps to null (the caller
     * decides how to degrade - it is never silently dropped).
     * @param {Iterable<number>} arenaIds
     * @returns {Promise<Map<number, {name, setCode, collectorNumber}|null>>}
     */
    async resolveArenaIds(arenaIds) {
        const unique = [...new Set(arenaIds)];
        const resolved = new Map();
        const missing = [];

        for (const arenaId of unique) {
            const row = await db.get(
                'SELECT name, setCode, collectorNumber FROM mtga_cards WHERE arenaId = @arenaId',
                { arenaId }
            );
            if (row) resolved.set(arenaId, row);
            else missing.push(arenaId);
        }
        if (missing.length > MAX_NEW_LOOKUPS) {
            throw new MtgaCardError(400, 'TOO_MANY_CARDS',
                `That import needs ${missing.length} new card lookups (max ${MAX_NEW_LOOKUPS} per import).`);
        }

        for (const arenaId of missing) {
            const card = await this._fetchCard(arenaId);
            if (card) {
                await db.run(
                    `INSERT INTO mtga_cards (arenaId, name, setCode, collectorNumber)
                     VALUES (@arenaId, @name, @setCode, @collectorNumber)
                     ON CONFLICT (arenaId) DO NOTHING`,
                    { arenaId, ...card }
                );
            }
            resolved.set(arenaId, card);
            await sleep(REQUEST_DELAY_MS);
        }
        return resolved;
    }

    /**
     * One Scryfall lookup. 404 = Scryfall doesn't know the id (returns null,
     * not cached - a card from a brand-new set may resolve next week); one
     * retry on 429; anything else is a clear 502 for the route to surface.
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
            if (status === 429 && attempt === 0) {
                await sleep(1000);
                return await this._fetchCard(arenaId, attempt + 1);
            }
            throw new MtgaCardError(502, 'SCRYFALL_UNAVAILABLE',
                'Could not reach Scryfall to resolve card names - try the import again in a minute.',
                { cause: error });
        }
    }
}

module.exports = new MtgaCardService();
module.exports.MtgaCardService = MtgaCardService;
module.exports.MtgaCardError = MtgaCardError;
