/**
 * Unit tests for the MTGA deck library: the Arena export parser
 * (utils/mtgaDeckParser.js) and the folder/deck service
 * (services/mtgaService.js), against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-mtga-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;
// The privacy-coverage test runs a real forgetUser, which also sweeps the
// uploads directory - keep that away from the repo's data/ tree.
process.env.GOOBSTER_UPLOADS_DIR = path.join(os.tmpdir(), `goobster-mtga-test-uploads-${process.pid}`);

const db = require('@goobster/core/db');
const { parseDeck, parseDeckList, DeckParseError } = require('@goobster/core/utils/mtgaDeckParser');
const mtgaService = require('@goobster/core/services/mtgaService');
const privacyService = require('@goobster/core/services/privacyService');

const USER = '300000000000000001';
const OTHER = '300000000000000002';

const ARENA_EXPORT = `About
Name Izzet Aggro

Deck
4 Lightning Strike (DMU) 137
3 Fires of Victory (DMU) 133
20 Mountain (DMU) 269

Sideboard
2 Abrade (VOW) 139
1 Unlicensed Hearse (SNC) 246
`;

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    db.run('DELETE FROM mtga_decks');
    db.run('DELETE FROM mtga_folders');
});

describe('parseDeck', () => {
    test('parses a full Arena export with About name, sections, and set codes', () => {
        const deck = parseDeck(ARENA_EXPORT);
        expect(deck.name).toBe('Izzet Aggro');
        expect(deck.counts).toEqual({ main: 27, sideboard: 3, commander: 0, companion: 0 });
        expect(deck.cards).toHaveLength(5);
        expect(deck.cards[0]).toEqual({
            board: 'main', count: 4, name: 'Lightning Strike',
            setCode: 'DMU', collectorNumber: '137'
        });
        expect(deck.cards[3].board).toBe('sideboard');
    });

    test('parses a header-less export (blank line splits main from sideboard)', () => {
        const deck = parseDeck('4 Shock\n20 Mountain\n\n2 Abrade');
        expect(deck.name).toBeNull();
        expect(deck.counts.main).toBe(24);
        expect(deck.counts.sideboard).toBe(2);
        expect(deck.cards[0].setCode).toBeNull();
    });

    test('parses Commander and Companion sections', () => {
        const deck = parseDeck([
            'Commander', '1 Baral, Chief of Compliance (A25) 43', '',
            'Companion', '1 Jegantha, the Wellspring (IKO) 222', '',
            'Deck', '99 Island (ANB) 113'
        ].join('\n'));
        expect(deck.counts).toEqual({ main: 99, sideboard: 0, commander: 1, companion: 1 });
    });

    test('keeps split-card names and names ending in parentheses intact', () => {
        const deck = parseDeck('Deck\n4 Fire // Ice (MH2) 290\n2 Borrowing 100,000 Arrows\n1 Hazmat Suit (Used) (UST) 57');
        expect(deck.cards.map(c => c.name)).toEqual([
            'Fire // Ice', 'Borrowing 100,000 Arrows', 'Hazmat Suit (Used)'
        ]);
        expect(deck.cards[2].setCode).toBe('UST');
    });

    test('rejects empty and card-less pastes', () => {
        expect(() => parseDeck('')).toThrow(DeckParseError);
        expect(() => parseDeck('Deck\nSideboard')).toThrow(/No card lines/);
    });

    test('rejects pastes that are mostly not deck lines', () => {
        expect(() => parseDeck('hello there\ngeneral kenobi\nsome prose\n1 Shock'))
            .toThrow(/doesn't look like deck lines/);
    });
});

describe('parseDeckList', () => {
    test('a single export yields one deck', () => {
        expect(parseDeckList(ARENA_EXPORT)).toHaveLength(1);
    });

    test('splits several exports pasted back-to-back', () => {
        const decks = parseDeckList(`${ARENA_EXPORT}\nAbout\nName Mono White\n\nDeck\n24 Plains (DMU) 262\n`);
        expect(decks).toHaveLength(2);
        expect(decks[0].name).toBe('Izzet Aggro');
        expect(decks[1].name).toBe('Mono White');
        expect(decks[1].counts.main).toBe(24);
    });
});

describe('folders', () => {
    test('create, list with deck counts, rename, delete', () => {
        const folder = mtgaService.createFolder({ userId: USER, name: 'Standard' });
        expect(folder.name).toBe('Standard');

        mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT, folderId: folder.id });
        const folders = mtgaService.listFolders(USER);
        expect(folders).toHaveLength(1);
        expect(folders[0].deckCount).toBe(1);

        mtgaService.renameFolder({ userId: USER, folderId: folder.id, name: 'Standard 2026' });
        expect(mtgaService.listFolders(USER)[0].name).toBe('Standard 2026');

        // Deleting the folder keeps the deck (drops to Unfiled)
        mtgaService.deleteFolder({ userId: USER, folderId: folder.id });
        expect(mtgaService.listFolders(USER)).toHaveLength(0);
        const decks = mtgaService.listDecks({ userId: USER });
        expect(decks).toHaveLength(1);
        expect(decks[0].folderId).toBeNull();
    });

    test('duplicate names are rejected per user, allowed across users', () => {
        mtgaService.createFolder({ userId: USER, name: 'Brews' });
        expect(() => mtgaService.createFolder({ userId: USER, name: 'brews' }))
            .toThrow(/already have a folder/);
        expect(() => mtgaService.createFolder({ userId: OTHER, name: 'Brews' })).not.toThrow();
    });

    test('folder operations are owner-scoped', () => {
        const folder = mtgaService.createFolder({ userId: USER, name: 'Mine' });
        expect(() => mtgaService.deleteFolder({ userId: OTHER, folderId: folder.id }))
            .toThrow(/No such folder/);
        expect(() => mtgaService.importDecks({ userId: OTHER, text: ARENA_EXPORT, folderId: folder.id }))
            .toThrow(/No such folder/);
    });
});

describe('deck import and library', () => {
    test('imports an export with its About name, counts, and verbatim re-export', () => {
        const { decks } = mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT });
        expect(decks).toHaveLength(1);
        expect(decks[0].name).toBe('Izzet Aggro');
        expect(decks[0].mainCount).toBe(27);
        expect(decks[0].sideboardCount).toBe(3);

        const exported = mtgaService.exportDeck({ userId: USER, deckId: decks[0].id });
        expect(exported.text).toBe(ARENA_EXPORT.trim());
    });

    test('name override applies to single-deck pastes only', () => {
        const single = mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT, name: 'My Build' });
        expect(single.decks[0].name).toBe('My Build');

        const bulk = mtgaService.importDecks({
            userId: USER,
            text: `${ARENA_EXPORT}\nAbout\nName Mono White\n\nDeck\n24 Plains (DMU) 262\n`,
            name: 'Ignored'
        });
        expect(bulk.decks.map(d => d.name)).toEqual(['Izzet Aggro', 'Mono White']);
    });

    test('getDeck groups cards by board in stable order', () => {
        const { decks } = mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT });
        const deck = mtgaService.getDeck({ userId: USER, deckId: decks[0].id });
        expect(deck.boards.map(b => b.board)).toEqual(['main', 'sideboard']);
        expect(deck.boards[0].cards[0].name).toBe('Lightning Strike');
        expect(deck.rawText).toContain('4 Lightning Strike (DMU) 137');
    });

    test('listDecks filters by folder and by unfiled', () => {
        const folder = mtgaService.createFolder({ userId: USER, name: 'Standard' });
        mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT, folderId: folder.id });
        mtgaService.importDecks({ userId: USER, text: '4 Shock\n20 Mountain' });

        expect(mtgaService.listDecks({ userId: USER })).toHaveLength(2);
        expect(mtgaService.listDecks({ userId: USER, folderId: folder.id })).toHaveLength(1);
        expect(mtgaService.listDecks({ userId: USER, folderId: 'unfiled' })).toHaveLength(1);
    });

    test('updateDeck renames and moves between folders', () => {
        const folder = mtgaService.createFolder({ userId: USER, name: 'Standard' });
        const { decks } = mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT });

        const moved = mtgaService.updateDeck({
            userId: USER, deckId: decks[0].id, name: 'Renamed', folderId: folder.id
        });
        expect(moved.name).toBe('Renamed');
        expect(moved.folderId).toBe(folder.id);

        const unfiled = mtgaService.updateDeck({ userId: USER, deckId: decks[0].id, folderId: null });
        expect(unfiled.folderId).toBeNull();
    });

    test('deck operations are owner-scoped; delete cascades card rows', () => {
        const { decks } = mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT });
        const deckId = decks[0].id;
        expect(() => mtgaService.getDeck({ userId: OTHER, deckId })).toThrow(/No such deck/);
        expect(() => mtgaService.deleteDeck({ userId: OTHER, deckId })).toThrow(/No such deck/);

        mtgaService.deleteDeck({ userId: USER, deckId });
        expect(db.get('SELECT COUNT(*) AS c FROM mtga_deck_cards WHERE deckId = @deckId', { deckId }).c).toBe(0);
    });

    test('rejects imports that are not deck text', () => {
        expect(() => mtgaService.importDecks({ userId: USER, text: '' })).toThrow(/Paste a deck/);
        expect(() => mtgaService.importDecks({ userId: USER, text: 'just some prose\nnothing here' }))
            .toThrow(/No card lines|doesn't look like deck lines/);
    });
});

describe('privacy coverage', () => {
    test('/forget-me erases the deck library and the audit counts it', () => {
        const folder = mtgaService.createFolder({ userId: USER, name: 'Standard' });
        mtgaService.importDecks({ userId: USER, text: ARENA_EXPORT, folderId: folder.id });
        mtgaService.importDecks({ userId: OTHER, text: '4 Shock\n20 Mountain' });

        const counts = privacyService.forgetUser({ userId: USER });
        expect(counts.mtga).toBe(2); // 1 deck + 1 folder

        expect(privacyService.auditUser({ userId: USER }).total).toBe(0);
        // The other user's library is untouched
        expect(mtgaService.listDecks({ userId: OTHER })).toHaveLength(1);
    });
});
