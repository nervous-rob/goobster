/**
 * MTGA deck library: import Magic: The Gathering Arena decks into per-user
 * folders, browse them from the web portal's Decks pane, and copy them back
 * out in Arena's own format. Two import paths: pasted "Export to clipboard"
 * text (utils/mtgaDeckParser.js), and the whole library at once from
 * Arena's Player.log (utils/mtgaLogParser.js + mtgaCardService for card-id
 * resolution) - log imports are idempotent via the contentHash dedupe key.
 *
 * Everything here is personal, user-scoped data (like the Parlor and the
 * Observatory registry - no guild in the key): a user only ever sees and
 * touches their own folders and decks, enforced by the userId predicate on
 * every query. The original export text is stored verbatim on the deck row
 * (mtga_decks.rawText) so "Export to Arena" is lossless by construction;
 * the parsed card rows (mtga_deck_cards) are the queryable view used for
 * listings and the deck detail. No card database or network is involved -
 * parsing is deterministic text handling (utils/mtgaDeckParser.js).
 *
 * /forget-me deletes the whole library (folders + decks; card rows cascade)
 * and privacyService.auditUser counts both tables.
 */

const crypto = require('node:crypto');
const db = require('../db');
const { parseDeckList, DeckParseError } = require('../utils/mtgaDeckParser');
const { extractDecksFromLog, LogParseError } = require('../utils/mtgaLogParser');
const mtgaCardService = require('./mtgaCardService');

const MAX_FOLDER_NAME_LENGTH = 60;
const MAX_DECK_NAME_LENGTH = 120;
const MAX_FORMAT_LENGTH = 40;
const MAX_FOLDERS_PER_USER = 100;
const MAX_DECKS_PER_USER = 500;
const MAX_DECKS_PER_IMPORT = 25;

const BOARD_ORDER = ['commander', 'companion', 'main', 'sideboard'];

/** Machine-readable web app error (the PanelError status+code contract). */
class MtgaError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'MtgaError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Content-based dedupe key: SHA-256 of the sorted normalized card list.
 * Name-independent, so renaming a deck (in Arena or here) never defeats it.
 */
function contentHashOf(cards) {
    const lines = cards
        .map(card => `${card.board}|${String(card.name).toLowerCase()}|${card.count}`)
        .sort();
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Validate + normalize a folder or deck display name. */
function cleanName(value, { label, maxLength }) {
    const name = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > maxLength) {
        throw new MtgaError(400, 'BAD_NAME',
            `${label} name is required (max ${maxLength} characters).`);
    }
    return name;
}

/** The per-deck summary shape every listing returns. */
function deckSummary(row) {
    return {
        id: row.id,
        name: row.name,
        folderId: row.folderId,
        format: row.format,
        mainCount: row.mainCount || 0,
        sideboardCount: row.sideboardCount || 0,
        commanderCount: row.commanderCount || 0,
        companionCount: row.companionCount || 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}

const DECK_SUMMARY_SQL = `
    SELECT d.id, d.name, d.folderId, d.format, d.createdAt, d.updatedAt,
           SUM(CASE WHEN c.board = 'main' THEN c.count ELSE 0 END) AS mainCount,
           SUM(CASE WHEN c.board = 'sideboard' THEN c.count ELSE 0 END) AS sideboardCount,
           SUM(CASE WHEN c.board = 'commander' THEN c.count ELSE 0 END) AS commanderCount,
           SUM(CASE WHEN c.board = 'companion' THEN c.count ELSE 0 END) AS companionCount
    FROM mtga_decks d
    LEFT JOIN mtga_deck_cards c ON c.deckId = d.id`;

class MtgaService {
    // --- Folders -----------------------------------------------------------

    /** All of the user's folders, each with its deck count. */
    async listFolders(userId) {
        return (await db.all(
            `SELECT f.id, f.name, f.createdAt,
                    COUNT(d.id) AS deckCount
             FROM mtga_folders f
             LEFT JOIN mtga_decks d ON d.folderId = f.id
             WHERE f.userId = @userId
             GROUP BY f.id
             ORDER BY f.name COLLATE NOCASE ASC`,
            { userId }
        )).map(row => ({
            id: row.id,
            name: row.name,
            deckCount: row.deckCount,
            createdAt: row.createdAt
        }));
    }

    /** Create a folder. Names are unique per user (case-insensitive). */
    async createFolder({ userId, name }) {
        const clean = cleanName(name, { label: 'Folder', maxLength: MAX_FOLDER_NAME_LENGTH });
        const existing = await db.get(
            'SELECT COUNT(*) AS c FROM mtga_folders WHERE userId = @userId', { userId }
        );
        if ((existing?.c || 0) >= MAX_FOLDERS_PER_USER) {
            throw new MtgaError(400, 'TOO_MANY_FOLDERS',
                `At most ${MAX_FOLDERS_PER_USER} folders - delete one first.`);
        }
        try {
            const row = await db.get(
                `INSERT INTO mtga_folders (userId, name) VALUES (@userId, @name)
                 RETURNING id, name, createdAt`,
                { userId, name: clean }
            );
            return { id: row.id, name: row.name, deckCount: 0, createdAt: row.createdAt };
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) {
                throw new MtgaError(409, 'DUPLICATE_NAME', 'You already have a folder with that name.');
            }
            throw error;
        }
    }

    /** Rename one of the user's folders. */
    async renameFolder({ userId, folderId, name }) {
        const clean = cleanName(name, { label: 'Folder', maxLength: MAX_FOLDER_NAME_LENGTH });
        try {
            const result = await db.run(
                `UPDATE mtga_folders SET name = @name, updatedAt = datetime('now')
                 WHERE id = @id AND userId = @userId`,
                { id: Number(folderId), userId, name: clean }
            );
            if (result.changes === 0) throw new MtgaError(404, 'NOT_FOUND', 'No such folder.');
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) {
                throw new MtgaError(409, 'DUPLICATE_NAME', 'You already have a folder with that name.');
            }
            throw error;
        }
        return { id: Number(folderId), name: clean };
    }

    /**
     * Delete a folder. Its decks are never deleted with it - the FK's
     * ON DELETE SET NULL drops them back to Unfiled.
     */
    async deleteFolder({ userId, folderId }) {
        const result = await db.run(
            'DELETE FROM mtga_folders WHERE id = @id AND userId = @userId',
            { id: Number(folderId), userId }
        );
        if (result.changes === 0) throw new MtgaError(404, 'NOT_FOUND', 'No such folder.');
        return { deleted: true };
    }

    /** Resolve a folder the user owns (null folderId = Unfiled passthrough). */
    async _requireFolder(userId, folderId) {
        if (folderId === null || folderId === undefined || folderId === '') return null;
        const row = await db.get(
            'SELECT id FROM mtga_folders WHERE id = @id AND userId = @userId',
            { id: Number(folderId), userId }
        );
        if (!row) throw new MtgaError(404, 'NOT_FOUND', 'No such folder.');
        return row.id;
    }

    // --- Decks ---------------------------------------------------------------

    /**
     * Import one or more pasted Arena exports into a folder (null = Unfiled).
     * `name` overrides the deck's own About/Name for single-deck pastes.
     * @param {Object} params - { userId, text, folderId?, name?, format? }
     * @returns {{ decks: Array, skipped: number }}
     */
    async importDecks({ userId, text, folderId = null, name = null, format = null }) {
        const targetFolder = await this._requireFolder(userId, folderId);

        let parsed;
        try {
            parsed = parseDeckList(text);
        } catch (error) {
            if (error instanceof DeckParseError) {
                throw new MtgaError(error.status, error.code, error.message);
            }
            throw error;
        }
        if (parsed.length > MAX_DECKS_PER_IMPORT) {
            throw new MtgaError(400, 'TOO_MANY_DECKS',
                `At most ${MAX_DECKS_PER_IMPORT} decks per import.`);
        }

        const existing = await db.get(
            'SELECT COUNT(*) AS c FROM mtga_decks WHERE userId = @userId', { userId }
        );
        if ((existing?.c || 0) + parsed.length > MAX_DECKS_PER_USER) {
            throw new MtgaError(400, 'TOO_MANY_DECKS',
                `That would exceed the ${MAX_DECKS_PER_USER}-deck library cap - delete some decks first.`);
        }

        const overrideName = name === null || String(name).trim() === ''
            ? null
            : cleanName(name, { label: 'Deck', maxLength: MAX_DECK_NAME_LENGTH });
        const cleanFormat = format === null || String(format).trim() === ''
            ? null
            : String(format).replace(/\s+/g, ' ').trim().slice(0, MAX_FORMAT_LENGTH);

        const decks = await db.transaction(async () => {
            const imported = [];
            for (const [index, deck] of parsed.entries()) {
                // The override only applies to a single-deck paste; bulk pastes
                // keep each deck's own name (that's the point of About/Name).
                const deckName = (parsed.length === 1 && overrideName)
                    ? overrideName
                    : (deck.name
                        ? deck.name.slice(0, MAX_DECK_NAME_LENGTH)
                        : `Imported deck${parsed.length > 1 ? ` ${index + 1}` : ''}`);
                const row = await db.get(
                    `INSERT INTO mtga_decks (userId, folderId, name, format, rawText, contentHash)
                     VALUES (@userId, @folderId, @name, @format, @rawText, @contentHash)
                     RETURNING id, createdAt, updatedAt`,
                    {
                        userId, folderId: targetFolder, name: deckName, format: cleanFormat,
                        rawText: deck.rawText, contentHash: contentHashOf(deck.cards)
                    }
                );
                for (const card of deck.cards) {
                    await db.run(
                        `INSERT INTO mtga_deck_cards (deckId, board, name, count, setCode, collectorNumber)
                         VALUES (@deckId, @board, @name, @count, @setCode, @collectorNumber)`,
                        { deckId: row.id, ...card }
                    );
                }
                imported.push(deckSummary({
                    id: row.id,
                    name: deckName,
                    folderId: targetFolder,
                    format: cleanFormat,
                    mainCount: deck.counts.main,
                    sideboardCount: deck.counts.sideboard,
                    commanderCount: deck.counts.commander,
                    companionCount: deck.counts.companion,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt
                }));
            }
            return imported;
        });

        return { decks, skipped: 0 };
    }

    /**
     * Import the user's whole deck library from Arena's Player.log (with
     * Detailed Logs enabled - the only bulk export Arena has). Card ids are
     * resolved to names through mtgaCardService (Scryfall, cached forever),
     * an Arena-format export text is generated per deck so re-export works
     * exactly like pasted decks, and decks whose content already exists in
     * the library are skipped (the log repeats every deck on every client
     * boot - re-importing must be idempotent).
     * @param {Object} params - { userId, text, folderId? }
     * @returns {Promise<{ decks: Array, skipped: number, unresolvedCards: number }>}
     */
    async importFromLog({ userId, text, folderId = null }) {
        const targetFolder = await this._requireFolder(userId, folderId);

        let parsed;
        try {
            parsed = extractDecksFromLog(text);
        } catch (error) {
            if (error instanceof LogParseError) {
                throw new MtgaError(error.status, error.code, error.message);
            }
            throw error;
        }

        const allIds = new Set();
        for (const deck of parsed) {
            for (const board of Object.values(deck.boards)) {
                for (const card of board) allIds.add(card.arenaId);
            }
        }
        // May take a while on first import (Scryfall is polite-rate-limited);
        // everything found here is cached, so the next import is instant.
        const catalog = await mtgaCardService.resolveArenaIds(allIds);

        let unresolvedCards = 0;
        const prepared = parsed.map((deck, index) => {
            const cards = [];
            for (const board of BOARD_ORDER) {
                for (const entry of deck.boards[board]) {
                    const known = catalog.get(entry.arenaId);
                    if (!known) unresolvedCards += 1;
                    cards.push({
                        board,
                        count: entry.count,
                        name: known ? known.name : `Unknown card #${entry.arenaId}`,
                        setCode: known?.setCode || null,
                        collectorNumber: known?.collectorNumber || null
                    });
                }
            }
            const name = (deck.name || `Imported Arena deck ${index + 1}`).slice(0, MAX_DECK_NAME_LENGTH);
            return {
                name,
                format: deck.format ? deck.format.slice(0, MAX_FORMAT_LENGTH) : null,
                cards,
                contentHash: contentHashOf(cards),
                rawText: this._buildArenaExport(name, cards)
            };
        });

        let skipped = 0;
        const decks = await db.transaction(async () => {
            const imported = [];
            for (const deck of prepared) {
                const existing = await db.get(
                    'SELECT 1 AS ok FROM mtga_decks WHERE userId = @userId AND contentHash = @contentHash',
                    { userId, contentHash: deck.contentHash }
                );
                if (existing) {
                    skipped += 1;
                    continue;
                }
                const total = await db.get(
                    'SELECT COUNT(*) AS c FROM mtga_decks WHERE userId = @userId', { userId }
                );
                if ((total?.c || 0) >= MAX_DECKS_PER_USER) {
                    throw new MtgaError(400, 'TOO_MANY_DECKS',
                        `That would exceed the ${MAX_DECKS_PER_USER}-deck library cap - delete some decks first.`);
                }
                const row = await db.get(
                    `INSERT INTO mtga_decks (userId, folderId, name, format, rawText, contentHash)
                     VALUES (@userId, @folderId, @name, @format, @rawText, @contentHash)
                     RETURNING id, createdAt, updatedAt`,
                    {
                        userId, folderId: targetFolder, name: deck.name, format: deck.format,
                        rawText: deck.rawText, contentHash: deck.contentHash
                    }
                );
                const counts = { main: 0, sideboard: 0, commander: 0, companion: 0 };
                for (const card of deck.cards) {
                    counts[card.board] += card.count;
                    await db.run(
                        `INSERT INTO mtga_deck_cards (deckId, board, name, count, setCode, collectorNumber)
                         VALUES (@deckId, @board, @name, @count, @setCode, @collectorNumber)`,
                        { deckId: row.id, ...card }
                    );
                }
                imported.push(deckSummary({
                    id: row.id,
                    name: deck.name,
                    folderId: targetFolder,
                    format: deck.format,
                    mainCount: counts.main,
                    sideboardCount: counts.sideboard,
                    commanderCount: counts.commander,
                    companionCount: counts.companion,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt
                }));
            }
            return imported;
        });

        return { decks, skipped, unresolvedCards };
    }

    /**
     * Generate Arena's own export text for a resolved deck, so decks that
     * arrived through the log re-export exactly like pasted ones. The
     * (SET) number suffix is only written when both parts are known - a
     * bare "(SET)" would not survive a round-trip through the parser.
     */
    _buildArenaExport(name, cards) {
        const SECTION_LABELS = { commander: 'Commander', companion: 'Companion', main: 'Deck', sideboard: 'Sideboard' };
        const lines = ['About', `Name ${name}`];
        for (const board of BOARD_ORDER) {
            const boardCards = cards.filter(card => card.board === board);
            if (boardCards.length === 0) continue;
            lines.push('', SECTION_LABELS[board]);
            for (const card of boardCards) {
                lines.push(`${card.count} ${card.name}`
                    + (card.setCode && card.collectorNumber
                        ? ` (${card.setCode}) ${card.collectorNumber}` : ''));
            }
        }
        return lines.join('\n');
    }

    /**
     * Deck summaries, optionally narrowed to one folder ('unfiled' lists
     * decks without a folder).
     * @param {Object} params - { userId, folderId? }
     */
    async listDecks({ userId, folderId = undefined }) {
        let where = 'WHERE d.userId = @userId';
        const params = { userId };
        if (folderId === 'unfiled') {
            where += ' AND d.folderId IS NULL';
        } else if (folderId !== undefined && folderId !== null && folderId !== '') {
            where += ' AND d.folderId = @folderId';
            params.folderId = Number(folderId);
        }
        return (await db.all(
            `${DECK_SUMMARY_SQL} ${where} GROUP BY d.id ORDER BY d.updatedAt DESC, d.id DESC`,
            params
        )).map(deckSummary);
    }

    /** One deck with its full card list grouped by board. */
    async getDeck({ userId, deckId }) {
        const row = await db.get(
            `${DECK_SUMMARY_SQL} WHERE d.id = @id AND d.userId = @userId GROUP BY d.id`,
            { id: Number(deckId), userId }
        );
        if (!row) throw new MtgaError(404, 'NOT_FOUND', 'No such deck.');
        const cards = await db.all(
            `SELECT board, name, count, setCode, collectorNumber
             FROM mtga_deck_cards WHERE deckId = @deckId ORDER BY id ASC`,
            { deckId: row.id }
        );
        const boards = BOARD_ORDER
            .map(board => ({ board, cards: cards.filter(card => card.board === board) }))
            .filter(group => group.cards.length > 0);
        return { ...deckSummary(row), boards, rawText: await this._rawText(row.id) };
    }

    async _rawText(deckId) {
        return (await db.get('SELECT rawText FROM mtga_decks WHERE id = @id', { id: deckId }))?.rawText || '';
    }

    /**
     * Rename a deck and/or move it between folders (folderId null =
     * Unfiled). Only provided fields change.
     * @param {Object} params - { userId, deckId, name?, folderId? }
     */
    async updateDeck({ userId, deckId, name = undefined, folderId = undefined }) {
        const deck = await db.get(
            'SELECT id FROM mtga_decks WHERE id = @id AND userId = @userId',
            { id: Number(deckId), userId }
        );
        if (!deck) throw new MtgaError(404, 'NOT_FOUND', 'No such deck.');

        if (name !== undefined) {
            const clean = cleanName(name, { label: 'Deck', maxLength: MAX_DECK_NAME_LENGTH });
            await db.run(
                `UPDATE mtga_decks SET name = @name, updatedAt = datetime('now') WHERE id = @id`,
                { id: deck.id, name: clean }
            );
        }
        if (folderId !== undefined) {
            const target = await this._requireFolder(userId, folderId);
            await db.run(
                `UPDATE mtga_decks SET folderId = @folderId, updatedAt = datetime('now') WHERE id = @id`,
                { id: deck.id, folderId: target }
            );
        }
        return await this.getDeck({ userId, deckId: deck.id });
    }

    /** Delete a deck (card rows cascade). */
    async deleteDeck({ userId, deckId }) {
        const result = await db.run(
            'DELETE FROM mtga_decks WHERE id = @id AND userId = @userId',
            { id: Number(deckId), userId }
        );
        if (result.changes === 0) throw new MtgaError(404, 'NOT_FOUND', 'No such deck.');
        return { deleted: true };
    }

    /** The verbatim Arena export text (the client's copy-to-clipboard). */
    async exportDeck({ userId, deckId }) {
        const row = await db.get(
            'SELECT name, rawText FROM mtga_decks WHERE id = @id AND userId = @userId',
            { id: Number(deckId), userId }
        );
        if (!row) throw new MtgaError(404, 'NOT_FOUND', 'No such deck.');
        return { name: row.name, text: row.rawText };
    }
}

module.exports = new MtgaService();
module.exports.MtgaService = MtgaService;
module.exports.MtgaError = MtgaError;
