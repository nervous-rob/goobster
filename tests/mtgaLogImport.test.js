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
const db = require('../db');
const { extractDecksFromLog, LogParseError } = require('../utils/mtgaLogParser');
const { parseDeck } = require('../utils/mtgaDeckParser');
const mtgaCardService = require('../services/mtgaCardService');
const mtgaService = require('../services/mtgaService');

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

beforeEach(() => {
    db.run('DELETE FROM mtga_decks');
    db.run('DELETE FROM mtga_folders');
    db.run('DELETE FROM mtga_cards');
    jest.restoreAllMocks();
});

describe('extractDecksFromLog', () => {
    test('parses V3 flat-array deck lists', () => {
        const decks = extractDecksFromLog(`${NOISE}\n${V3_LINE}`);
        expect(decks).toHaveLength(1);
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
});

describe('mtgaCardService', () => {
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
        expect(db.get('SELECT COUNT(*) AS c FROM mtga_cards').c).toBe(0);
        expect(get).toHaveBeenCalledTimes(1);
    });

    test('network failure surfaces as a clear 502', async () => {
        jest.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(mtgaCardService.resolveArenaIds([STRIKE]))
            .rejects.toMatchObject({ status: 502, code: 'SCRYFALL_UNAVAILABLE' });
    });
});

describe('importFromLog', () => {
    function mockCatalog() {
        jest.spyOn(mtgaCardService, 'resolveArenaIds').mockImplementation(async (ids) => {
            const map = new Map();
            for (const id of new Set(ids)) map.set(id, CARDS[id] || null);
            return map;
        });
    }

    test('imports the library with resolved names and Arena-format re-export', async () => {
        mockCatalog();
        const folder = mtgaService.createFolder({ userId: USER, name: 'From Arena' });
        const result = await mtgaService.importFromLog({
            userId: USER, text: `${V3_LINE}\n${COURSE_LINE}`, folderId: folder.id
        });

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
        const exported = mtgaService.exportDeck({ userId: USER, deckId: burn.id });
        expect(exported.text).toContain('4 Lightning Strike (DMU) 137');
        const reparsed = parseDeck(exported.text);
        expect(reparsed.name).toBe('Izzet Burn');
        expect(reparsed.counts).toEqual({ main: 24, sideboard: 2, commander: 0, companion: 0 });

        const brawl = mtgaService.getDeck({
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
        mtgaService.updateDeck({ userId: USER, deckId: first.decks[0].id, name: 'Renamed' });
        const renamed = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(renamed.skipped).toBe(1);
    });

    test('a deck already imported by paste is skipped by the log import', async () => {
        mockCatalog();
        mtgaService.importDecks({
            userId: USER,
            text: 'About\nName Izzet Burn\n\nDeck\n4 Lightning Strike (DMU) 137\n20 Mountain (DMU) 269\n\nSideboard\n2 Abrade (VOW) 139'
        });
        const result = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(result.decks).toHaveLength(0);
        expect(result.skipped).toBe(1);
    });

    test('unresolvable cards import with a visible placeholder, never dropped', async () => {
        jest.spyOn(mtgaCardService, 'resolveArenaIds').mockImplementation(async (ids) => {
            const map = new Map();
            for (const id of new Set(ids)) map.set(id, id === STRIKE ? CARDS[STRIKE] : null);
            return map;
        });
        const result = await mtgaService.importFromLog({ userId: USER, text: V3_LINE });
        expect(result.unresolvedCards).toBe(2); // Mountain + Abrade unresolved
        const deck = mtgaService.getDeck({ userId: USER, deckId: result.decks[0].id });
        const names = deck.boards.flatMap(board => board.cards.map(card => card.name));
        expect(names).toContain('Lightning Strike');
        expect(names).toContain(`Unknown card #${MOUNTAIN}`);
        expect(deck.mainCount).toBe(24); // counts intact despite placeholders
    });
});
