/**
 * Extract every deck list from an MTG Arena Player.log.
 *
 * With "Detailed Logs (Plugin Support)" enabled (Options → Account), Arena
 * writes the player's full deck library into the log as JSON payloads -
 * this is the same source Untapped/17Lands read, and the only way to get a
 * whole library out of the client (Arena has no bulk export button).
 *
 * The log format has changed repeatedly across Arena versions, so parsing
 * is deliberately shape-based rather than message-name-based: any JSON
 * value found on a line mentioning a maindeck - including JSON nested
 * inside string fields, the client's request/response envelope habit - is
 * walked, and every object carrying a maindeck-shaped card list becomes a
 * deck candidate. Known card-list shapes:
 *
 *   V3 flat pairs:  "mainDeck": [86233, 4, 86234, 2, ...]
 *   object arrays:  "MainDeck": [{ "cardId": 86233, "quantity": 4 }, ...]
 *
 * Cards are Arena's numeric ids (grpIds), not names - the caller resolves
 * them (services/mtgaCardService.js). Deck lists repeat in the log (every
 * client boot re-sends the library), so candidates are deduplicated by
 * deck id (falling back to name) with the LAST occurrence winning - later
 * entries reflect the newer state of an edited deck.
 */

const MAX_LOG_LENGTH = 80 * 1024 * 1024;
const MAX_DECKS = 10000;
const MAX_CARDS_PER_DECK = 2000;
const MAX_COUNT_PER_CARD = 250;
const MAX_ARENA_ID = 99_999_999;
const MAX_WALK_DEPTH = 10;

/** Machine-readable parse failure (the web error status+code contract). */
class LogParseError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'LogParseError';
        this.status = 400;
        this.code = code;
    }
}

const DETAILED_LOGS_HINT =
    'No deck lists found in that log. In Arena, enable Options → Account → '
    + 'Detailed Logs (Plugin Support), restart the game so it reloads your '
    + 'library, then import the fresh Player.log.';

/** Lowercased key lookup: the log flips casing between client versions. */
function keyByName(obj, names) {
    for (const key of Object.keys(obj)) {
        if (names.includes(key.toLowerCase())) return obj[key];
    }
    return undefined;
}

/**
 * Normalize one card-list value into [{ arenaId, count }] (duplicated ids
 * merged), or null when the value is not card-list shaped.
 */
function normalizeCards(value) {
    if (typeof value === 'string' && /^\s*\[/.test(value)) {
        try { value = JSON.parse(value); } catch { return null; }
    }
    if (!Array.isArray(value)) return null;
    if (value.length === 0) return [];

    const counts = new Map();
    const add = (arenaId, count) => {
        if (!Number.isInteger(arenaId) || arenaId < 1 || arenaId > MAX_ARENA_ID) return false;
        if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT_PER_CARD) return false;
        counts.set(arenaId, Math.min(MAX_COUNT_PER_CARD, (counts.get(arenaId) || 0) + count));
        return true;
    };

    if (value.every(entry => typeof entry === 'number')) {
        // V3 flat pairs: [id, count, id, count, ...]
        if (value.length % 2 !== 0) return null;
        for (let i = 0; i < value.length; i += 2) {
            if (!add(value[i], value[i + 1])) return null;
        }
    } else if (value.every(entry => entry && typeof entry === 'object')) {
        for (const entry of value) {
            const arenaId = keyByName(entry, ['cardid', 'grpid', 'id']);
            const count = keyByName(entry, ['quantity', 'count', 'qty']) ?? 1;
            if (!add(Number(arenaId), Number(count))) return null;
        }
    } else {
        return null;
    }

    const cards = [...counts.entries()].map(([arenaId, count]) => ({ arenaId, count }));
    return cards.reduce((sum, card) => sum + card.count, 0) > MAX_CARDS_PER_DECK ? null : cards;
}

/**
 * A single-card zone (commander, companion): same shapes as normalizeCards,
 * plus the bare-id-array form V3 used for commandZoneGRPIds.
 */
function normalizeZone(value) {
    if (typeof value === 'string' && /^\s*\[/.test(value)) {
        try { value = JSON.parse(value); } catch { return []; }
    }
    if (!Array.isArray(value) || value.length === 0) return [];
    // Bare id list ([86233] or partner pairs [86233, 86234]) - V3's
    // commandZoneGRPIds shape. Arena ids are always far larger than a legal
    // per-card count, which is what tells a bare-id list from id/count pairs.
    if (value.every(entry => typeof entry === 'number' && entry > MAX_COUNT_PER_CARD)) {
        return normalizeCards(value.flatMap(id => [id, 1])) || [];
    }
    return normalizeCards(value) || [];
}

/**
 * JSON candidates on one log line: the payload follows a logger prefix that
 * itself contains brackets ("[UnityCrossThreadLogger]<== Name(17) [{...}]"),
 * so parsing is attempted from each early bracket position until one
 * consumes the rest of the line as valid JSON.
 */
function parseJsonCandidates(line) {
    const starts = [];
    for (const bracket of ['{', '[']) {
        let index = line.indexOf(bracket);
        for (let n = 0; n < 6 && index !== -1; n++) {
            starts.push(index);
            index = line.indexOf(bracket, index + 1);
        }
    }
    for (const start of starts.sort((a, b) => a - b)) {
        try {
            return [JSON.parse(line.slice(start))];
        } catch { /* prefix noise - try the next candidate start */ }
    }
    return [];
}

/**
 * Extract deck candidates from a Player.log (or any pasted excerpt of one).
 * @param {string} text
 * @returns {Array<{ key: string, name: string|null, format: string|null,
 *   boards: { main: Array<{arenaId, count}>, sideboard: Array, commander: Array, companion: Array } }>}
 * @throws {LogParseError} on empty/oversized input or when nothing deck-shaped is found
 */
function extractDecksFromLog(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) {
        throw new LogParseError('EMPTY_LOG', 'That file is empty - pick Arena\'s Player.log.');
    }
    if (raw.length > MAX_LOG_LENGTH) {
        throw new LogParseError('LOG_TOO_LARGE',
            'That log excerpt is too large even after keeping only the deck lists. Import the current Player.log, not an archive.');
    }

    // key -> deck; insertion order preserved, later occurrences overwrite
    // (the log is chronological, so last wins).
    const decks = new Map();
    let anonymous = 0;

    const collect = (node, inheritedName, depth) => {
        if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const entry of node) collect(entry, inheritedName, depth + 1);
            return;
        }

        // A name visible at this level names deck objects nested below it
        // (the Summary/CourseDeck envelope habit).
        const summary = keyByName(node, ['summary', 'coursedecksummary', 'decksummary', 'attributes']);
        const ownName = keyByName(node, ['name', 'deckname']);
        const name = (typeof ownName === 'string' && ownName.trim())
            ? ownName.trim()
            : (summary && typeof keyByName(summary, ['name']) === 'string'
                ? keyByName(summary, ['name']).trim()
                : inheritedName);

        const mainValue = keyByName(node, ['maindeck', 'maindeckcards']);
        const main = mainValue !== undefined ? normalizeCards(mainValue) : null;
        if (main && main.length > 0) {
            const rawFormat = keyByName(node, ['format']);
            const rawId = keyByName(node, ['id', 'deckid']);
            const key = (typeof rawId === 'string' && rawId.length >= 8)
                ? `id:${rawId}`
                : (name ? `name:${name.toLowerCase()}` : `anon:${anonymous++}`);
            decks.delete(key); // re-insert so a newer copy also moves last
            decks.set(key, {
                key,
                name: name || null,
                format: typeof rawFormat === 'string' && rawFormat.trim()
                    ? rawFormat.trim() : null,
                boards: {
                    main,
                    sideboard: normalizeZone(keyByName(node, ['sideboard', 'sideboardcards'])),
                    commander: normalizeZone(keyByName(node, ['commandzone', 'commandzonegrpids', 'commander'])),
                    companion: normalizeZone(keyByName(node, ['companions', 'companiongrpids', 'companion']))
                }
            });
        }

        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') {
                collect(value, name, depth + 1);
            } else if (typeof value === 'string' && value.length > 20
                && /^[\s]*[[{]/.test(value) && /maindeck/i.test(value)) {
                // JSON-in-string: the client wraps payloads in request/
                // response envelopes with stringified bodies.
                try { collect(JSON.parse(value), name, depth + 1); } catch { /* not JSON */ }
            }
        }
    };

    for (const line of raw.split(/\r?\n/)) {
        if (!/maindeck/i.test(line)) continue;
        for (const candidate of parseJsonCandidates(line)) {
            collect(candidate, null, 0);
        }
    }

    if (decks.size === 0) {
        throw new LogParseError('NO_DECKS', DETAILED_LOGS_HINT);
    }
    const list = [...decks.values()];
    if (list.length > MAX_DECKS) {
        throw new LogParseError('TOO_MANY_DECKS',
            `That log has ${list.length} decks (max ${MAX_DECKS}).`);
    }
    return list;
}

module.exports = { extractDecksFromLog, LogParseError, MAX_LOG_LENGTH, MAX_DECKS };
