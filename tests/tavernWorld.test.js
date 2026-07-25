/**
 * Phase 2 - the world remembers: NPC relationships (including via engine
 * effects and travel-option effects), Guest Rooms, shared lore written by
 * endings, and chapter gating (`requires`).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-world-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const worldService = require('../services/tavern/worldService');
const characterService = require('../services/tavern/characterService');
const questLoader = require('../services/tavern/questLoader');
const { AdventureService } = require('../services/tavern/adventureService');
const { TavernError } = require('../services/tavern/tavernError');

const GUILD = '600000000000000001';
const CHANNEL = '600000000000000010';
const CHANNEL2 = '600000000000000011';
const ALICE = '600000000000000101';

function rollQueue(...rolls) {
    const queue = [...rolls];
    return () => ((queue.length ? queue.shift() : 10) - 1) / 20;
}

function makeAlice() {
    return characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice Vell', origin: 'Clockwork pilgrim',
        calling: 'guide', complication: 'Cannot resist a dare',
        stats: { might: 0, finesse: 1, wits: 2, heart: 3 }
    });
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    db.run('DELETE FROM tavern_adventure_log');
    db.run('DELETE FROM tavern_party_members');
    db.run('DELETE FROM tavern_adventures');
    db.run('DELETE FROM tavern_characters');
    db.run('DELETE FROM tavern_npc_relationships');
    db.run('DELETE FROM tavern_rooms');
    db.run('DELETE FROM tavern_lore');
});

describe('NPC relationships', () => {
    test('adjust, clamp, and label standings', () => {
        expect(worldService.getRelationship(GUILD, 'marnie', ALICE)).toEqual({ score: 0, label: 'Just another guest' });
        expect(worldService.adjustRelationship(GUILD, 'marnie', ALICE, 2).label).toBe('Trusted regular');
        expect(worldService.adjustRelationship(GUILD, 'marnie', ALICE, 99).score).toBe(5);
        expect(worldService.adjustRelationship(GUILD, 'bix', ALICE, -99)).toEqual({ score: -5, label: 'Banned from the good chairs' });
        expect(worldService.listRelationships(GUILD, ALICE).map(r => r.npcKey)).toEqual(['marnie', 'bix']);
        expect(() => worldService.adjustRelationship(GUILD, 'nobody', ALICE, 1)).toThrow(TavernError);
    });

    test('travel-option effects move relationships (rat-problem verdict)', () => {
        makeAlice();
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: ALICE });
        service.begin(adventure.id, ALICE);
        service.chooseOption(adventure.id, ALICE, 'to-verdict');

        const result = service.chooseOption(adventure.id, ALICE, 'side-with-bix');
        expect(result.ended.endingId).toBe('management-wins');
        expect(result.happenings.join('\n')).toMatch(/Bix Copperthumb will remember this/);
        expect(worldService.getRelationship(GUILD, 'bix', ALICE).score).toBe(1);
    });
});

describe('Guest Rooms', () => {
    test('set, read, clear, and length limit', () => {
        expect(worldService.getRoom(GUILD, ALICE)).toBeNull();
        worldService.setRoom(GUILD, ALICE, 'A hammock, a bell-shard on the sill, and a suspicious amount of rope.');
        expect(worldService.getRoom(GUILD, ALICE)).toMatch(/hammock/);
        expect(() => worldService.setRoom(GUILD, ALICE, 'x'.repeat(501))).toThrow(/under 500/);
        expect(worldService.setRoom(GUILD, ALICE, '')).toBeNull();
        expect(worldService.getRoom(GUILD, ALICE)).toBeNull();
    });
});

describe('shared world lore', () => {
    test('endings write their world entries into the guild record', () => {
        makeAlice();
        const service = new AdventureService(rollQueue(15, 15, 15));
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.begin(adventure.id, ALICE);
        service.chooseOption(adventure.id, ALICE, 'to-chapel');
        db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'finale', id: adventure.id });

        const result = service.chooseOption(adventure.id, ALICE, 'hang-bell');
        expect(result.ended.endingId).toBe('hang-bell');

        const world = worldService.getWorld(GUILD);
        expect(world.location.map(e => e.name)).toContain('Brinewatch');
        expect(world.character.map(e => e.name)).toContain('Maren, the Drowned Sexton');
        expect(worldService.getLore(GUILD, 'brinewatch').content).toMatch(/got its bell/);
        expect(worldService.listLoreNames(GUILD, 'mar')).toContain('Maren, the Drowned Sexton');
        // The ending choice also moved Marnie's opinion
        expect(worldService.getRelationship(GUILD, 'marnie', ALICE).score).toBe(1);
    });

    test('retelling the same lore updates content without duplicating', () => {
        worldService.recordLore({ guildId: GUILD, kind: 'location', name: 'Brinewatch', content: 'First telling.' });
        worldService.recordLore({ guildId: GUILD, kind: 'location', name: 'Brinewatch', content: 'Second telling.' });
        const world = worldService.getWorld(GUILD);
        expect(world.location).toHaveLength(1);
        expect(world.location[0].content).toBe('Second telling.');
    });
});

describe('campaign chapters', () => {
    test('a required chapter gates the quest until the server completes it', () => {
        makeAlice();
        const service = new AdventureService(rollQueue());
        const chapter2 = questLoader.getQuest('signal-in-the-salt');
        expect(chapter2.requires).toBe('missing-bell-of-brinewatch');
        expect(service.isQuestUnlocked(GUILD, chapter2)).toBe(false);
        expect(() => service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'signal-in-the-salt', userId: ALICE }))
            .toThrow(/isn't on the board yet/);

        // Complete chapter 1 (any ending) and the gate opens
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.begin(adventure.id, ALICE);
        service.chooseOption(adventure.id, ALICE, 'to-chapel');
        db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'finale', id: adventure.id });
        service.chooseOption(adventure.id, ALICE, 'sink-bell');

        expect(service.isQuestUnlocked(GUILD, chapter2)).toBe(true);
        const started = service.createParty({ guildId: GUILD, channelId: CHANNEL2, questId: 'signal-in-the-salt', userId: ALICE });
        expect(started.adventure.status).toBe('RECRUITING');
    });
});
