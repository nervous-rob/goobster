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

const db = require('@goobster/core/db');
const worldService = require('@goobster/core/services/tavern/worldService');
const characterService = require('@goobster/core/services/tavern/characterService');
const questLoader = require('@goobster/core/services/tavern/questLoader');
const { AdventureService } = require('@goobster/core/services/tavern/adventureService');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');

const GUILD = '600000000000000001';
const CHANNEL = '600000000000000010';
const CHANNEL2 = '600000000000000011';
const ALICE = '600000000000000101';

function rollQueue(...rolls) {
    const queue = [...rolls];
    return () => ((queue.length ? queue.shift() : 10) - 1) / 20;
}

async function makeAlice() {
    return await characterService.createCharacter({
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

beforeEach(async () => {
    await db.run('DELETE FROM tavern_adventure_log');
    await db.run('DELETE FROM tavern_party_members');
    await db.run('DELETE FROM tavern_adventures');
    await db.run('DELETE FROM tavern_characters');
    await db.run('DELETE FROM tavern_npc_relationships');
    await db.run('DELETE FROM tavern_rooms');
    await db.run('DELETE FROM tavern_lore');
});

describe('NPC relationships', () => {
    test('adjust, clamp, and label standings', async () => {
        expect(await worldService.getRelationship(GUILD, 'marnie', ALICE)).toEqual({ score: 0, label: 'Just another guest' });
        expect((await worldService.adjustRelationship(GUILD, 'marnie', ALICE, 2)).label).toBe('Trusted regular');
        expect((await worldService.adjustRelationship(GUILD, 'marnie', ALICE, 99)).score).toBe(5);
        expect(await worldService.adjustRelationship(GUILD, 'bix', ALICE, -99)).toEqual({ score: -5, label: 'Banned from the good chairs' });
        expect((await worldService.listRelationships(GUILD, ALICE)).map(r => r.npcKey)).toEqual(['marnie', 'bix']);
        await expect((async () => await worldService.adjustRelationship(GUILD, 'nobody', ALICE, 1))()).rejects.toThrow(TavernError);
    });

    test('travel-option effects move relationships (rat-problem verdict)', async () => {
        await makeAlice();
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        await service.chooseOption(adventure.id, ALICE, 'to-verdict');

        const result = await service.chooseOption(adventure.id, ALICE, 'side-with-bix');
        expect(result.ended.endingId).toBe('management-wins');
        expect(result.happenings.join('\n')).toMatch(/Bix Copperthumb will remember this/);
        expect((await worldService.getRelationship(GUILD, 'bix', ALICE)).score).toBe(1);
    });
});

describe('Guest Rooms', () => {
    test('set, read, clear, and length limit', async () => {
        expect(await worldService.getRoom(GUILD, ALICE)).toBeNull();
        await worldService.setRoom(GUILD, ALICE, 'A hammock, a bell-shard on the sill, and a suspicious amount of rope.');
        expect(await worldService.getRoom(GUILD, ALICE)).toMatch(/hammock/);
        await expect((async () => await worldService.setRoom(GUILD, ALICE, 'x'.repeat(501)))()).rejects.toThrow(/under 500/);
        expect(await worldService.setRoom(GUILD, ALICE, '')).toBeNull();
        expect(await worldService.getRoom(GUILD, ALICE)).toBeNull();
    });
});

describe('shared world lore', () => {
    test('endings write their world entries into the guild record', async () => {
        await makeAlice();
        const service = new AdventureService(rollQueue(15, 15, 15));
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        await service.chooseOption(adventure.id, ALICE, 'to-chapel');
        await db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'finale', id: adventure.id });

        const result = await service.chooseOption(adventure.id, ALICE, 'hang-bell');
        expect(result.ended.endingId).toBe('hang-bell');

        const world = await worldService.getWorld(GUILD);
        expect(world.location.map(e => e.name)).toContain('Brinewatch');
        expect(world.character.map(e => e.name)).toContain('Maren, the Drowned Sexton');
        expect((await worldService.getLore(GUILD, 'brinewatch')).content).toMatch(/got its bell/);
        expect(await worldService.listLoreNames(GUILD, 'mar')).toContain('Maren, the Drowned Sexton');
        // The ending choice also moved Marnie's opinion
        expect((await worldService.getRelationship(GUILD, 'marnie', ALICE)).score).toBe(1);
    });

    test('retelling the same lore updates content without duplicating', async () => {
        await worldService.recordLore({ guildId: GUILD, kind: 'location', name: 'Brinewatch', content: 'First telling.' });
        await worldService.recordLore({ guildId: GUILD, kind: 'location', name: 'Brinewatch', content: 'Second telling.' });
        const world = await worldService.getWorld(GUILD);
        expect(world.location).toHaveLength(1);
        expect(world.location[0].content).toBe('Second telling.');
    });
});

describe('campaign chapters', () => {
    test('a required chapter gates the quest until the server completes it', async () => {
        await makeAlice();
        const service = new AdventureService(rollQueue());
        const chapter2 = questLoader.getQuest('signal-in-the-salt');
        expect(chapter2.requires).toBe('missing-bell-of-brinewatch');
        expect(await service.isQuestUnlocked(GUILD, chapter2)).toBe(false);
        await expect(service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'signal-in-the-salt', userId: ALICE }))
            .rejects.toThrow(/isn't on the board yet/);

        // Complete chapter 1 (any ending) and the gate opens
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        await service.chooseOption(adventure.id, ALICE, 'to-chapel');
        await db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'finale', id: adventure.id });
        await service.chooseOption(adventure.id, ALICE, 'sink-bell');

        expect(await service.isQuestUnlocked(GUILD, chapter2)).toBe(true);
        const started = await service.createParty({ guildId: GUILD, channelId: CHANNEL2, questId: 'signal-in-the-salt', userId: ALICE });
        expect(started.adventure.status).toBe('RECRUITING');
    });
});
