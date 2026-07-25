/**
 * Character sheets: creation validation, one-per-guild, advancement,
 * Spark/health clamps, and inventory - against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-char-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const characterService = require('../services/tavern/characterService');
const { TavernError } = require('../services/tavern/tavernError');
const { SPARK_CAP } = require('../services/tavern/content');

const GUILD = '300000000000000001';
const USER = '300000000000000002';

const baseCharacter = (overrides = {}) => ({
    guildId: GUILD,
    userId: USER,
    name: 'Pella Brinewatch',
    origin: 'Retired goblin tax collector',
    calling: 'guide',
    complication: 'Cannot resist a dare',
    stats: { might: 0, finesse: 1, wits: 2, heart: 3 },
    ...overrides
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    db.run('DELETE FROM tavern_party_members');
    db.run('DELETE FROM tavern_adventures');
    db.run('DELETE FROM tavern_characters');
});

describe('createCharacter', () => {
    test('creates a full sheet with defaults', () => {
        const character = characterService.createCharacter(baseCharacter());
        expect(character.name).toBe('Pella Brinewatch');
        expect(character.calling).toBe('guide');
        expect(character.heart).toBe(3);
        expect(character.health).toBe(10);
        expect(character.maxHealth).toBe(10);
        expect(character.spark).toBe(1);
        expect(character.inventory).toEqual([]);
        expect(character.milestones).toBe(0);
    });

    test('rejects stat spreads that do not sum to the pool', () => {
        expect(() => characterService.createCharacter(baseCharacter({
            stats: { might: 3, finesse: 3, wits: 3, heart: 3 }
        }))).toThrow(TavernError);
        expect(() => characterService.createCharacter(baseCharacter({
            stats: { might: 1, finesse: 1, wits: 1, heart: 1 }
        }))).toThrow(/Distribute exactly/);
    });

    test('rejects out-of-range stats, bad callings, and missing fields', () => {
        expect(() => characterService.createCharacter(baseCharacter({
            stats: { might: 4, finesse: 1, wits: 1, heart: 0 }
        }))).toThrow(TavernError);
        expect(() => characterService.createCharacter(baseCharacter({ calling: 'paladin' })))
            .toThrow(/Calling must be one of/);
        expect(() => characterService.createCharacter(baseCharacter({ name: '' })))
            .toThrow(/name/i);
    });

    test('one character per user per guild', () => {
        characterService.createCharacter(baseCharacter());
        expect(() => characterService.createCharacter(baseCharacter()))
            .toThrow(/already have a character/);
    });
});

describe('advancement and condition', () => {
    test('advance requires an unspent milestone and respects the +3 cap', () => {
        const character = characterService.createCharacter(baseCharacter());
        expect(() => characterService.advance(GUILD, USER, 'might')).toThrow(/No unspent milestones/);

        characterService.recordCompletion(character.id);
        const advanced = characterService.advance(GUILD, USER, 'might');
        expect(advanced.might).toBe(1);
        expect(advanced.advancesSpent).toBe(1);

        expect(() => characterService.advance(GUILD, USER, 'wits')).toThrow(/No unspent milestones/);

        characterService.recordCompletion(character.id);
        expect(() => characterService.advance(GUILD, USER, 'heart')).toThrow(/already at \+3/);
    });

    test('recordCompletion grants milestone, spark (capped), and hearth rest', () => {
        const character = characterService.createCharacter(baseCharacter());
        characterService.adjustHealth(character.id, -6);
        for (let i = 0; i < SPARK_CAP + 2; i++) characterService.recordCompletion(character.id);
        const after = characterService.getById(character.id);
        expect(after.health).toBe(after.maxHealth);
        expect(after.spark).toBe(SPARK_CAP);
        expect(after.milestones).toBe(SPARK_CAP + 2);
        expect(after.adventuresCompleted).toBe(SPARK_CAP + 2);
    });

    test('health floors at 1 during play and reports the stagger', () => {
        const character = characterService.createCharacter(baseCharacter());
        expect(characterService.adjustHealth(character.id, -4)).toEqual({ health: 6, staggered: false });
        expect(characterService.adjustHealth(character.id, -99)).toEqual({ health: 1, staggered: true });
        expect(characterService.adjustHealth(character.id, 99)).toEqual({ health: 10, staggered: false });
    });

    test('spark clamps to 0..cap', () => {
        const character = characterService.createCharacter(baseCharacter());
        expect(characterService.adjustSpark(character.id, -5)).toBe(0);
        expect(characterService.adjustSpark(character.id, 99)).toBe(SPARK_CAP);
    });
});

describe('inventory and editing', () => {
    test('items accumulate and hasItem matches case-insensitively', () => {
        const character = characterService.createCharacter(baseCharacter());
        characterService.addItem(character.id, 'Waterlogged Hymnal');
        const withItem = characterService.getById(character.id);
        expect(withItem.inventory).toEqual(['Waterlogged Hymnal']);
        expect(characterService.hasItem(withItem, 'waterlogged hymnal')).toBe(true);
        expect(characterService.hasItem(withItem, 'ordinary hymnal')).toBe(false);
    });

    test('edit changes descriptive fields only', () => {
        characterService.createCharacter(baseCharacter());
        const edited = characterService.editCharacter({
            guildId: GUILD, userId: USER, name: 'Pella the Bold', complication: 'Allergic to prophecy'
        });
        expect(edited.name).toBe('Pella the Bold');
        expect(edited.complication).toBe('Allergic to prophecy');
        expect(edited.origin).toBe('Retired goblin tax collector');
    });

    test('retire deletes the sheet but refuses while in an open party', () => {
        const character = characterService.createCharacter(baseCharacter());
        db.run(`INSERT INTO tavern_adventures (guildId, channelId, questId, status, createdBy)
                VALUES (@g, 'c1', 'rat-problem', 'ACTIVE', @u)`, { g: GUILD, u: USER });
        const adventureId = db.get('SELECT id FROM tavern_adventures').id;
        db.run(`INSERT INTO tavern_party_members (adventureId, userId, characterId)
                VALUES (@a, @u, @c)`, { a: adventureId, u: USER, c: character.id });

        expect(() => characterService.retireCharacter(GUILD, USER)).toThrow(/open adventure/);

        db.run('DELETE FROM tavern_party_members');
        const retired = characterService.retireCharacter(GUILD, USER);
        expect(retired.name).toBe('Pella Brinewatch');
        expect(characterService.getCharacter(GUILD, USER)).toBeNull();
    });
});
