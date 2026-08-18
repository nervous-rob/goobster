/**
 * Character sheets: creation validation, one-per-guild, advancement,
 * Spark/health clamps, and inventory - against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-char-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const characterService = require('@goobster/core/services/tavern/characterService');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');
const { SPARK_CAP } = require('@goobster/core/services/tavern/content');

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

beforeEach(async () => {
    await db.run('DELETE FROM tavern_party_members');
    await db.run('DELETE FROM tavern_adventures');
    await db.run('DELETE FROM tavern_characters');
});

describe('createCharacter', () => {
    test('creates a full sheet with defaults', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        expect(character.name).toBe('Pella Brinewatch');
        expect(character.calling).toBe('guide');
        expect(character.heart).toBe(3);
        expect(character.health).toBe(10);
        expect(character.maxHealth).toBe(10);
        expect(character.spark).toBe(1);
        expect(character.inventory).toEqual([]);
        expect(character.milestones).toBe(0);
    });

    test('rejects stat spreads that do not sum to the pool', async () => {
        await expect((async () => await characterService.createCharacter(baseCharacter({
            stats: { might: 3, finesse: 3, wits: 3, heart: 3 }
        })))()).rejects.toThrow(TavernError);
        await expect((async () => await characterService.createCharacter(baseCharacter({
            stats: { might: 1, finesse: 1, wits: 1, heart: 1 }
        })))()).rejects.toThrow(/Distribute exactly/);
    });

    test('rejects out-of-range stats, bad callings, and missing fields', async () => {
        await expect((async () => await characterService.createCharacter(baseCharacter({
            stats: { might: 4, finesse: 1, wits: 1, heart: 0 }
        })))()).rejects.toThrow(TavernError);
        await expect((async () => await characterService.createCharacter(baseCharacter({ calling: 'paladin' })))())
            .rejects.toThrow(/Calling must be one of/);
        await expect((async () => await characterService.createCharacter(baseCharacter({ name: '' })))())
            .rejects.toThrow(/name/i);
    });

    test('one character per user per guild', async () => {
        await characterService.createCharacter(baseCharacter());
        await expect((async () => await characterService.createCharacter(baseCharacter()))())
            .rejects.toThrow(/already have a character/);
    });
});

describe('advancement and condition', () => {
    test('advance requires an unspent milestone and respects the +3 cap', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        await expect((async () => await characterService.advance(GUILD, USER, 'might'))()).rejects.toThrow(/No unspent milestones/);

        await characterService.recordCompletion(character.id);
        const advanced = await characterService.advance(GUILD, USER, 'might');
        expect(advanced.might).toBe(1);
        expect(advanced.advancesSpent).toBe(1);

        await expect((async () => await characterService.advance(GUILD, USER, 'wits'))()).rejects.toThrow(/No unspent milestones/);

        await characterService.recordCompletion(character.id);
        await expect((async () => await characterService.advance(GUILD, USER, 'heart'))()).rejects.toThrow(/already at \+3/);
    });

    test('recordCompletion grants milestone, spark (capped), and hearth rest', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        await characterService.adjustHealth(character.id, -6);
        for (let i = 0; i < SPARK_CAP + 2; i++) await characterService.recordCompletion(character.id);
        const after = await characterService.getById(character.id);
        expect(after.health).toBe(after.maxHealth);
        expect(after.spark).toBe(SPARK_CAP);
        expect(after.milestones).toBe(SPARK_CAP + 2);
        expect(after.adventuresCompleted).toBe(SPARK_CAP + 2);
    });

    test('health floors at 1 during play and reports the stagger', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        expect(await characterService.adjustHealth(character.id, -4)).toEqual({ health: 6, staggered: false });
        expect(await characterService.adjustHealth(character.id, -99)).toEqual({ health: 1, staggered: true });
        expect(await characterService.adjustHealth(character.id, 99)).toEqual({ health: 10, staggered: false });
    });

    test('spark clamps to 0..cap', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        expect(await characterService.adjustSpark(character.id, -5)).toBe(0);
        expect(await characterService.adjustSpark(character.id, 99)).toBe(SPARK_CAP);
    });
});

describe('inventory and editing', () => {
    test('items accumulate and hasItem matches case-insensitively', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        await characterService.addItem(character.id, 'Waterlogged Hymnal');
        const withItem = await characterService.getById(character.id);
        expect(withItem.inventory).toEqual(['Waterlogged Hymnal']);
        expect(characterService.hasItem(withItem, 'waterlogged hymnal')).toBe(true);
        expect(characterService.hasItem(withItem, 'ordinary hymnal')).toBe(false);
    });

    test('edit changes descriptive fields only', async () => {
        await characterService.createCharacter(baseCharacter());
        const edited = await characterService.editCharacter({
            guildId: GUILD, userId: USER, name: 'Pella the Bold', complication: 'Allergic to prophecy'
        });
        expect(edited.name).toBe('Pella the Bold');
        expect(edited.complication).toBe('Allergic to prophecy');
        expect(edited.origin).toBe('Retired goblin tax collector');
    });

    test('retire deletes the sheet but refuses while in an open party', async () => {
        const character = await characterService.createCharacter(baseCharacter());
        await db.run(`INSERT INTO tavern_adventures (guildId, channelId, questId, status, createdBy)
                VALUES (@g, 'c1', 'rat-problem', 'ACTIVE', @u)`, { g: GUILD, u: USER });
        const adventureId = (await db.get('SELECT id FROM tavern_adventures')).id;
        await db.run(`INSERT INTO tavern_party_members (adventureId, userId, characterId)
                VALUES (@a, @u, @c)`, { a: adventureId, u: USER, c: character.id });

        await expect((async () => await characterService.retireCharacter(GUILD, USER))()).rejects.toThrow(/open adventure/);

        await db.run('DELETE FROM tavern_party_members');
        const retired = await characterService.retireCharacter(GUILD, USER);
        expect(retired.name).toBe('Pella Brinewatch');
        expect(await characterService.getCharacter(GUILD, USER)).toBeNull();
    });
});
