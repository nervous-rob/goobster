/**
 * Unit tests for the Player.log library import: the tolerant log parser
 * (utils/mtgaLogParser.js), the Scryfall-backed card catalog with its
 * SQLite cache (services/mtgaCardService.js), and the end-to-end
 * mtgaService.importFromLog flow with content-hash dedupe.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-mtga-log-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const axios = require('axios');
const db = require('@goobster/core/db');
const { extractDecksFromLog, LogParseError } = require('@goobster/core/utils/mtgaLogParser');
const { parseDeck } = require('@goobster/core/utils/mtgaDeckParser');
const mtgaCardService = require('@goobster/core/services/mtgaCardService');
const {
    clampLookupBudget, LOOKUP_BATCH_DEFAULT, LOOKUP_BATCH_MIN, LOOKUP_BATCH_MAX
} = mtgaCardService;
const mtgaService = require('@goobster/core/services/mtgaService');

const USER = '400000000000000001';

// Synthetic Arena ids used across the fixtures
const STRIKE = 82001;   // "Lightning Strike"
const MOUNTAIN = 82002; // "Mountain"
const ABRADE = 82003;   // "Abrade"
const BARAL = 82004;    // "Baral, Chief of Compliance"

const CARDS = {
    [STRIKE]: { name: 'Lightning Strike', setCode: 'DMU', collectorNumber: '137' },
    [MOUNTAIN]: { name: 'Mountain', setCode: 'DMU', collectorNumber: '269' },
    [ABRADE]: { name: 'Abrade', setCode: 'VOW', collectorNumber: '139' },
    [BARAL]: { name: 'Baral, Chief of Compliance', setCode: 'A25', collectorNumber: '43' }
};

/** A V3-era log line: flat [id, count, ...] arrays behind a logger prefix. */
const V3_LINE = '[UnityCrossThreadLogger]<== Deck.GetDeckListsV3(17) '
    + JSON.stringify([{
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Izzet Burn', format: 'Standard',
        mainDeck: [STRIKE, 4, MOUNTAIN, 20],
        sideboard: [ABRADE, 2],
        commandZoneGRPIds: [], companionGRPIds: []
    }]);

/** The same deck edited later in the log - the newer copy must win. */
const V3_LINE_EDITED = '[UnityCrossThreadLogger]<== Deck.GetDeckListsV3(99) '
    + JSON.stringify([{
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Izzet Burn v2', format: 'Standard',
        mainDeck: [STRIKE, 4, MOUNTAIN, 21],
        sideboard: [], commandZoneGRPIds: [], companionGRPIds: []
    }]);

/** A newer-client line: object card arrays, name in a summary envelope. */
const COURSE_LINE = '[UnityCrossThreadLogger]==> EventGetCoursesV2 '
    + JSON.stringify({
        Courses: [{
            CourseDeckSummary: { Name: 'Brawl Baral' },
            CourseDeck: {
                MainDeck: [
                    { cardId: MOUNTAIN, quantity: 59 }
                ],
                Sideboard: [],
                CommandZone: [{ cardId: BARAL, quantity: 1 }],
                Companions: []
            }
        }]
    });

/** JSON-in-string: the request/response envelope habit. */
const WRAPPED_LINE = '[UnityCrossThreadLogger]==> Deck.UpsertDeckV2 '
    + JSON.stringify({
        id: 55,
        request: JSON.stringify({
            Summary: { Name: 'Wrapped Deck' },
            Deck: { MainDeck: [{ grpId: STRIKE, quantity: 4 }], Sideboard: [] }
        })
    });

const NOISE = [
    '[UnityCrossThreadLogger]2/2/2026 3:14:15 PM: Match to match...',
    'Some prose line mentioning mainDeck without JSON',
    '{"maindeck": "not a card list"}',
    ''
].join('\n');

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM mtga_decks');
    await db.run('DELETE FROM mtga_folders');
    await db.run('DELETE FROM mtga_cards');
    jest.restoreAllMocks();
});

describe('extractDecksFromLog', () => {
    test('parses V3 flat-array deck lists', () => {
        const decks = extractDecksFromLog(`${NOISE}\n${V3_LINE}`);
        expect(decks).toHaveLength(1);
        expect(decks[0].key).toBe('id:11111111-2222-3333-4444-555555555555');
        expect(decks[0].name).toBe('Izzet Burn');
        expect(decks[0].format).toBe('Standard');
        expect(decks[0].boards.main).toEqual([
            { arenaId: STRIKE, count: 4 }, { arenaId: MOUNTAIN, count: 20 }
        ]);
        expect(decks[0].boards.sideboard).toEqual([{ arenaId: ABRADE, count: 2 }]);
    });

    test('the last occurrence of a deck id wins (logs repeat the library)', () => {
        const decks = extractDecksFromLog(`${V3_LINE}\n${NOISE}\n${V3_LINE_EDITED}`);
        expect(decks).toHaveLength(1);
        expect(decks[0].name).toBe('Izzet Burn v2');
        expect(decks[0].boards.main).toContainEqual({ arenaId: MOUNTAIN, count: 21 });
    });

    test('parses object-array card lists with summary-envelope names', () => {
        const decks = extractDecksFromLog(COURSE_LINE);
        expect(decks).toHaveLength(1);
        expect(decks[0].name).toBe('Brawl Baral');
        expect(decks[0].boards.main).toEqual([{ arenaId: MOUNTAIN, count: 59 }]);
        expect(decks[0].boards.commander).toEqual([{ arenaId: BARAL, count: 1 }]);
    });

    test('finds decks inside stringified request envelopes', () => {
        const decks = extractDecksFromLog(WRAPPED_LINE);
        expect(decks).toHaveLength(1);
        expect(decks[0].name).toBe('Wrapped Deck');
        expect(decks[0].boards.main).toEqual([{ arenaId: STRIKE, count: 4 }]);
    });

    test('a log with no deck lists fails with the Detailed Logs hint', () => {
        expect(() => extractDecksFromLog(NOISE)).toThrow(LogParseError);
        expect(() => extractDecksFromLog(NOISE)).toThrow(/Detailed Logs/);
        expect(() => extractDecksFromLog('')).toThrow(/empty/);
    });

    test('keeps every distinct deck instead of silently dropping the tail', () => {
        const lines = Array.from({ length: 250 }, (_, i) =>
            `[UnityCrossThreadLogger]<== Deck.GetDeckListsV3(${i}) `
            + JSON.stringify([{
                id: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
                name: `Deck ${i}`,
                mainDeck: [STRIKE, 4, MOUNTAIN, 20]
            }])
        );
        const decks = extractDecksFromLog(lines.join('\n'));
        expect(decks).toHaveLength(250);
        expect(decks[0].name).toBe('Deck 0');
        expect(decks[249].name).toBe('Deck 249');
    });
});

describe('mtgaCardService', () => {
    test('clampLookupBudget stays inside the polite Scryfall window', () => {
        expect(clampLookupBudget(null)).toBe(LOOKUP_BATCH_DEFAULT);
        expect(clampLookupBudget(1)).toBe(LOOKUP_BATCH_MIN);
        expect(clampLookupBudget(9999)).toBe(LOOKUP_BATCH_MAX);
        expect(clampLookupBudget(80)).toBe(80);
    });

    test('fetches unknown ids from Scryfall and caches them forever', async () => {
        const get = jest.spyOn(axios, 'get').mockImplementation(async (url) => {
            const arenaId = Number(url.split('/').pop());
            const card = CARDS[arenaId];
            if (!card) {
                const error = new Error('not found');
                error.response = { status: 404 };
                throw error;
            }
            return { data: { name: card.name, set: card.setCode.toLowerCase(), collector_number: card.collectorNumber } };
        });

        const first = await mtgaCardService.resolveArenaIds([STRIKE, MOUNTAIN, STRIKE]);
        expect(first.get(STRIKE)).toEqual(CARDS[STRIKE]);
        expect(first.get(MOUNTAIN)).toEqual(CARDS[MOUNTAIN]);
        expect(get).toHaveBeenCalledTimes(2); // unique ids only

        get.mockClear();
        const second = await mtgaCardService.resolveArenaIds([STRIKE, MOUNTAIN]);
        expect(second.get(STRIKE)).toEqual(CARDS[STRIKE]);
        expect(get).not.toHaveBeenCalled(); // served from the SQLite cache
    });

    test('an id Scryfall does not know resolves to null and is not cached', async () => {
        const get = jest.spyOn(axios, 'get').mockImplementation(async () => {
            const error = new Error('not found');
            error.response = { status: 404 };
            throw error;
        });
        const resolved = await mtgaCardService.resolveArenaIds([999999]);
        expect(resolved.get(999999)).toBeNull();
        expect((await db.get('SELECT COUNT(*) AS c FROM mtga_cards')).c).toBe(0);
        expect(get).toHaveBeenCalledTimes(1);
    });

    test('network failure surfaces as a clear 502', async () => {
        jest.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(mtgaCardService.resolveArenaIds([STRIKE]))
            .rejects.toMatchObject({ status: 502, code: 'SCRYFALL_UNAVAILABLE' });
    });

    test('a large catalog is fetched in batches with no hard cap', async () => {
        jest.spyOn(mtgaCardService, '_fetchCard').mockResolvedValue({
            name: 'Shock', setCode: 'M21', collectorNumber: '1'
        });
        jest.spyOn(mtgaCardService, '_sleep').mockResolvedValue();
        const ids = Array.from({ length: 1600 }, (_, i) => 900000 + i);

        const first = await mtgaCardService.resolveArenaIdsBatched(ids, { maxNewLookups: 200 });
        expect(first.lookedUp).toBe(200);
        expect(first.remaining).toBe(1400);
        expect(first.total).toBe(1600);
        expect(mtgaCardService._fetchCard).toHaveBeenCalledTimes(200);

        const second = await mtgaCardService.resolveArenaIdsBatched(ids, { maxNewLookups: 200 });
        expect(second.lookedUp).toBe(200);
        expect(second.remaining).toBe(1200);
        expect(mtgaCardService._fetchCard).toHaveBeenCalledTimes(400);
        expect((await db.get('SELECT COUNT(*) AS c FROM mtga_cards')).c).toBe(400);
    });

    test('429s back off and retry instead of failing the import', async () => {
        jest.spyOn(mtgaCardService, '_sleep').mockResolvedValue();
        const get = jest.spyOn(axios, 'get')
            .mockRejectedValueOnce(Object.assign(new Error('slow down'), {
                response: { status: 429, headers: { 'retry-after': '1' } }
            }))
            .mockResolvedValueOnce({
                data: { name: 'Lightning Strike', set: 'dmu', collector_number: '137' }
            });

        const resolved = await mtgaCardService.resolveArenaIds([STRIKE]);
        expect(resolved.get(STRIKE)).toEqual(CARDS[STRIKE]);
        expect(get).toHaveBeenCalledTimes(2);
        expect(mtgaCardService._sleep).toHaveBeenCalled();
    });
});

describe('importFromLog', () => {
    function mockCatalog(cards = CARDS) {
        jest.spyOn(mtgaCardService, 'resolveArenaIdsBatched').mockImplementation(async (ids) => {
            const catalog = new Map();
            const unique = [...new Set(ids)];
            for (const id of unique) catalog.set(id, cards[id] || null);
            return { catalog, lookedUp: 0, remaining: 0, total: unique.length };
        });
    }

    test('imports the library with resolved names and Arena-format re-export', async () => {
        mockCatalog();
        const folder = await mtgaService.createFolder({ userId: USER, name: 'From Arena' });
        const result = await mtgaService.importFromLog({
            userId: USER, text: `${V3_LINE}\n${COURSE_LINE}`, folderId: folder.id
        });

        expect(result.status).toBe('ok');
        expect(result.skipped).toBe(0);
        expect(result.unresolvedCards).toBe(0);
        expect(result.decks.map(deck => deck.name).sort()).toEqual(['Brawl Baral', 'Izzet Burn']);

        const burn = result.decks.find(deck => deck.name === 'Izzet Burn');
        expect(burn.mainCount).toBe(24);
        expect(burn.sideboardCount).toBe(2);
        expect(burn.folderId).toBe(folder.id);
        expect(burn.format).toBe('Standard');

        // The generated export is real Arena text: our own paste parser
        // round-trips it with identical counts.
        const exported = await mtgaService.exportDeck({ userId: USER, deckId: burn.id });
        expect(exported.text).toContain('4 Lightning Strike (DMU) 137');
        const reparsed = parseDeck(exported.text);
        expect(reparsed.name).toBe('Izzet Burn');
        expect(reparsed.counts).toEqual({ main: 24, sideboard: 2, commander: 0, companion: 0 });

        const brawl = await mtgaService.getDeck({
            userId: USER, deckId: result.decks.find(deck => deck.name === 'Brawl Baral').id
        });
        expect(brawl.boards.map(board => board.board)).toEqual(['commander', 'main']);
    });

    test('re-importing the same log is idempotent (content-hash dedupe)', async () => {
        mockCatalog();
        const first = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(first.decks).toHaveLength(1);

        const again = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(again.decks).toHaveLength(0);
        expect(again.skipped).toBe(1);

        // A rename does not defeat the dedupe - the hash is content-based
        await mtgaService.updateDeck({ userId: USER, deckId: first.decks[0].id, name: 'Renamed' });
        const renamed = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(renamed.skipped).toBe(1);
    });

    test('a deck already imported by paste is skipped by the log import', async () => {
        mockCatalog();
        await mtgaService.importDecks({
            userId: USER,
            text: 'About\nName Izzet Burn\n\nDeck\n4 Lightning Strike (DMU) 137\n20 Mountain (DMU) 269\n\nSideboard\n2 Abrade (VOW) 139'
        });
        const result = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(result.decks).toHaveLength(0);
        expect(result.skipped).toBe(1);
    });

    test('unresolvable cards import with a visible placeholder, never dropped', async () => {
        mockCatalog({ [STRIKE]: CARDS[STRIKE] });
        const result = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(result.unresolvedCards).toBe(2); // Mountain + Abrade unresolved
        const deck = await mtgaService.getDeck({ userId: USER, deckId: result.decks[0].id });
        const names = deck.boards.flatMap(board => board.cards.map(card => card.name));
        expect(names).toContain('Lightning Strike');
        expect(names).toContain(`Unknown card #${MOUNTAIN}`);
        expect(deck.mainCount).toBe(24); // counts intact despite placeholders
    });

    test('previewFromLog lists every deck without resolving cards', async () => {
        const fetch = jest.spyOn(mtgaCardService, 'resolveArenaIdsBatched');
        const { decks } = await mtgaService.previewFromLog({
            text: `${V3_LINE}\n${COURSE_LINE}`
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(decks.map(deck => deck.name).sort()).toEqual(['Brawl Baral', 'Izzet Burn']);
        const burn = decks.find(deck => deck.name === 'Izzet Burn');
        expect(burn.key).toBe('id:11111111-2222-3333-4444-555555555555');
        expect(burn.mainCount).toBe(24);
        expect(burn.sideboardCount).toBe(2);
        expect(burn.uniqueCards).toBe(3);
    });

    test('importFromLog imports only the decks the player picked', async () => {
        mockCatalog();
        const preview = await mtgaService.previewFromLog({
            text: `${V3_LINE}\n${COURSE_LINE}`
        });
        const burn = preview.decks.find(deck => deck.name === 'Izzet Burn');
        const result = await mtgaService.importFromLog({
            userId: USER, text: `${V3_LINE}\n${COURSE_LINE}`, deckKeys: [burn.key]
        });
        expect(result.status).toBe('ok');
        expect(result.decks).toHaveLength(1);
        expect(result.decks[0].name).toBe('Izzet Burn');
        expect(await mtgaService.listDecks({ userId: USER })).toHaveLength(1);
    });

    test('an empty selection is rejected', async () => {
        mockCatalog();
        await expect(mtgaService.importFromLog({
            userId: USER, text: V3_LINE, deckKeys: []
        })).rejects.toMatchObject({ status: 400, code: 'BAD_SELECTION' });
    });

    test('a small lookup budget returns resolving until the catalog is warm', async () => {
        let fetched = 0;
        jest.spyOn(mtgaCardService, 'resolveArenaIdsBatched').mockImplementation(async (requested) => {
            const unique = [...new Set(requested)];
            fetched += 1;
            if (fetched === 1) {
                return { catalog: new Map(), lookedUp: 1, remaining: 2, total: unique.length };
            }
            const catalog = new Map();
            for (const id of unique) catalog.set(id, CARDS[id] || null);
            return { catalog, lookedUp: 2, remaining: 0, total: unique.length };
        });

        const first = await mtgaService.importFromLog({
            userId: USER, text: V3_LINE, lookupBudget: 25
        });
        expect(first.status).toBe('resolving');
        expect(first.remaining).toBe(2);
        expect(first.resolved).toBe(1);
        expect(first.decks).toHaveLength(0);
        expect(await mtgaService.listDecks({ userId: USER })).toHaveLength(0);

        const second = await mtgaService.importFromLog({
            userId: USER, text: V3_LINE, lookupBudget: 25
        });
        expect(second.status).toBe('ok');
        expect(second.decks).toHaveLength(1);
    });
});
