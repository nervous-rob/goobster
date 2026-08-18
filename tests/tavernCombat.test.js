/**
 * The combat system, played deterministically against the real
 * dungeon-tenant-rights campaign: encounter setup, attack rolls, telegraphed
 * enemy intents and round cadence, loot, victory transitions, Spark rerolls
 * on missed attacks, usable items, and the social bypass.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-combat-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const characterService = require('@goobster/core/services/tavern/characterService');
const { AdventureService } = require('@goobster/core/services/tavern/adventureService');
const questLoader = require('@goobster/core/services/tavern/questLoader');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');

const GUILD = '910000000000000001';
const CHANNEL = '910000000000000010';
const ALICE = '910000000000000101'; // might 3
const BOB = '910000000000000102';

function rollQueue(...rolls) {
    const queue = [...rolls];
    return () => ((queue.length ? queue.shift() : 10) - 1) / 20;
}

async function makeAlice() {
    await characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice the Advocate', origin: 'Disbarred storm barrister',
        calling: 'vanguard', complication: 'Objects to everything',
        stats: { might: 3, finesse: 1, wits: 2, heart: 0 }
    });
}

async function startAtHall(service, withBob = false) {
    await makeAlice();
    if (withBob) {
        await characterService.createCharacter({
            guildId: GUILD, userId: BOB, name: 'Bob the Paralegal', origin: 'Notary of the deep',
            calling: 'guide', complication: 'Bills by the hour',
            stats: { might: 1, finesse: 1, wits: 2, heart: 2 }
        });
    }
    const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'dungeon-tenant-rights', userId: ALICE });
    if (withBob) await service.join(adventure.id, BOB);
    await service.begin(adventure.id, ALICE);
    await service.chooseOption(adventure.id, ALICE, 'descend');
    return adventure.id;
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
});

describe('encounter setup', () => {
    test('entering an encounter scene arms the combat state and telegraphs intents', async () => {
        const service = new AdventureService(rollQueue());
        const id = await startAtHall(service);
        const adventure = await service.getAdventure(id);
        const quest = questLoader.getQuest('dungeon-tenant-rights');

        expect(adventure.sceneId).toBe('grievance-hall');
        expect(adventure.state.combat.sceneId).toBe('grievance-hall');
        const living = service.livingEnemies(adventure, quest);
        expect(living).toHaveLength(1);
        expect(living[0].name).toBe('The Clause Golem');
        expect(living[0].currentHealth).toBe(8);
        expect(service.telegraphedIntent(adventure, living[0])).toMatch(/gavel-fist toward the cracked ceiling/);
    });

    test('attacking outside combat is refused politely', async () => {
        const service = new AdventureService(rollQueue());
        await makeAlice();
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'dungeon-tenant-rights', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        await expect(service.attack(adventure.id, ALICE, 'clause-golem')).rejects.toThrow(/nothing here that wants fighting/i);
    });
});

describe('attack resolution and enemy rounds', () => {
    test('a hit damages the golem; solo party means it answers every action', async () => {
        // Attack d20(12) + might(3) = 15 vs defense 13 -> hit for 2
        const service = new AdventureService(rollQueue(12));
        const id = await startAtHall(service);

        const result = await service.attack(id, ALICE, 'clause-golem');
        expect(result.kind).toBe('attack');
        expect(result.success).toBe(true);
        expect(result.adventure.state.combat.enemies['clause-golem'].health).toBe(6);
        // Solo party: the enemy round fires immediately - intent executed, damage taken
        expect(result.happenings.join('\n')).toMatch(/The Clause Golem.*gavel-fist/s);
        expect((await characterService.getCharacter(GUILD, ALICE)).health).toBe(8);
        // The NEXT intent is telegraphed
        expect(result.happenings.join('\n')).toMatch(/Next: .*subpoena/s);
    });

    test('a natural 20 crits for +1 damage and grants Spark', async () => {
        const service = new AdventureService(rollQueue(20));
        const id = await startAtHall(service);
        const result = await service.attack(id, ALICE, 'clause-golem');
        expect(result.adventure.state.combat.enemies['clause-golem'].health).toBe(5);
        expect(result.happenings.join('\n')).toMatch(/Natural 20/);
        expect((await characterService.getCharacter(GUILD, ALICE)).spark).toBe(2);
    });

    test('a missed attack still draws the round, and Spark can reroll it', async () => {
        // Miss with 5, reroll hits with 15
        const service = new AdventureService(rollQueue(5, 15));
        const id = await startAtHall(service);

        const miss = await service.attack(id, ALICE, 'clause-golem');
        expect(miss.success).toBe(false);
        expect(miss.canReroll).toBe(true);
        expect(miss.adventure.state.combat.enemies['clause-golem'].health).toBe(8);
        expect(miss.happenings.join('\n')).toMatch(/weathers the attempt/);
        // The golem answered the whiff
        expect((await characterService.getCharacter(GUILD, ALICE)).health).toBe(8);

        const reroll = await service.sparkReroll(id, ALICE);
        expect(reroll.success).toBe(true);
        expect(reroll.adventure.state.combat.enemies['clause-golem'].health).toBe(6);
        expect((await characterService.getCharacter(GUILD, ALICE)).spark).toBe(0);
    });

    test('with two members the golem acts every second action, cycling intents', async () => {
        // Hit, hit (golem 4), miss, hit (golem 2) - alive throughout
        const service = new AdventureService(rollQueue(12, 12, 5, 12));
        const id = await startAtHall(service, true);

        const first = await service.attack(id, ALICE, 'clause-golem');
        expect(first.happenings.join('\n')).not.toMatch(/💥/); // round not yet due
        const second = await service.attack(id, BOB, 'clause-golem');
        expect(second.happenings.join('\n')).toMatch(/💥 It catches Bob the Paralegal for 2/);
        const third = await service.attack(id, ALICE, 'clause-golem');
        expect(third.happenings.join('\n')).not.toMatch(/💥/);
        const fourth = await service.attack(id, BOB, 'clause-golem');
        // Second enemy round executes the SECOND intent (cycled)
        expect(fourth.happenings.join('\n')).toMatch(/subpoena/);
        expect(fourth.adventure.state.combat.enemies['clause-golem'].health).toBe(2);
    });

    test('defeat drops loot and victory moves the scene', async () => {
        // Golem has 8 health; four hits at 2 = down. All rolls 15.
        const service = new AdventureService(rollQueue(15, 15, 15, 15));
        const id = await startAtHall(service);

        await service.attack(id, ALICE, 'clause-golem'); // 6
        await service.attack(id, ALICE, 'clause-golem'); // 4
        await service.attack(id, ALICE, 'clause-golem'); // 2
        const final = await service.attack(id, ALICE, 'clause-golem'); // 0

        expect(final.happenings.join('\n')).toMatch(/is defeated!/);
        expect(final.happenings.join('\n')).toMatch(/Deed-Seal of Deed's End/);
        expect(final.happenings.join('\n')).toMatch(/The encounter is won!/);
        expect(final.sceneChanged).toBe(true);
        expect(final.adventure.sceneId).toBe('settlement');
        expect(final.adventure.state.flags.golem).toBe('subdued');
        expect((await characterService.getCharacter(GUILD, ALICE)).inventory).toContain("Deed-Seal of Deed's End");
        await expect(service.attack(id, ALICE, 'clause-golem')).rejects.toThrow(TavernError);
    });

    test('the social path bypasses combat entirely', async () => {
        // cite-precedent: d20(15) + wits(2) = 17 vs 16 -> success -> settlement
        const service = new AdventureService(rollQueue(15));
        const id = await startAtHall(service);
        const result = await service.chooseOption(id, ALICE, 'cite-precedent');
        expect(result.success).toBe(true);
        expect(result.adventure.sceneId).toBe('settlement');
        expect(result.adventure.state.flags.golem).toBe('outargued');
        // No combat in the new scene
        expect(result.adventure.state.combat).toBeNull();
    });
});

describe('usable items', () => {
    test('using a consumable heals, is consumed, and draws the enemy round', async () => {
        const service = new AdventureService(rollQueue(15, 5));
        await makeAlice();
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'dungeon-tenant-rights', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        // Pick up the poultice from the steward (heart... roll 15 + 0 = 15 vs 10)
        await service.chooseOption(adventure.id, ALICE, 'interview-skeleton');
        expect((await characterService.getCharacter(GUILD, ALICE)).inventory).toContain('Lease-Sealed Poultice');
        await service.chooseOption(adventure.id, ALICE, 'descend');

        // Take a hit first (miss with 5 -> golem answers for 2)
        await service.attack(adventure.id, ALICE, 'clause-golem');
        expect((await characterService.getCharacter(GUILD, ALICE)).health).toBe(8);

        const result = await service.useItem(adventure.id, ALICE, 'lease-sealed poultice');
        expect(result.kind).toBe('item');
        expect(result.outcomeText).toMatch(/enforceable clauses/);
        expect(result.happenings.join('\n')).toMatch(/recovers 3/);
        // Consumed, and the golem noticed (solo party: round fires)
        expect((await characterService.getCharacter(GUILD, ALICE)).inventory).not.toContain('Lease-Sealed Poultice');
        expect(result.happenings.join('\n')).toMatch(/The Clause Golem/);

        // Unknown/undefined items do nothing mechanical
        await expect(service.useItem(adventure.id, ALICE, 'Framed Writ of Dwelling')).rejects.toThrow(/nothing obvious happens/i);
    });

    test('give and drop manage the pack', async () => {
        await makeAlice();
        await characterService.createCharacter({
            guildId: GUILD, userId: BOB, name: 'Bob', origin: 'Notary', calling: 'guide',
            complication: 'Bills by the hour', stats: { might: 1, finesse: 1, wits: 2, heart: 2 }
        });
        const alice = await characterService.getCharacter(GUILD, ALICE);
        await characterService.addItem(alice.id, 'Pebble of Unresolved Litigation');

        const { to } = await characterService.transferItem({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, item: 'pebble of unresolved litigation' });
        expect(to.inventory).toContain('Pebble of Unresolved Litigation');
        expect((await characterService.getCharacter(GUILD, ALICE)).inventory).toEqual([]);
        await expect((async () => await characterService.transferItem({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, item: 'pebble of unresolved litigation' }))())
            .rejects.toThrow(/not carrying/);

        const bob = await characterService.getCharacter(GUILD, BOB);
        expect(await characterService.removeItem(bob.id, 'Pebble of Unresolved Litigation')).toBe('Pebble of Unresolved Litigation');
        expect(await characterService.removeItem(bob.id, 'Pebble of Unresolved Litigation')).toBeNull();
    });
});

describe('encounter validation', () => {
    test('the validator catches malformed enemies', () => {
        const quest = questLoader.getQuest('dungeon-tenant-rights');
        const broken = JSON.parse(JSON.stringify(quest));
        broken.scenes['grievance-hall'].encounter.enemies[0].health = 999;
        broken.scenes['grievance-hall'].encounter.enemies[0].defense = 'unbeatable';
        broken.scenes['grievance-hall'].encounter.enemies[0].intents = [];
        const errors = questLoader.validateQuest(broken);
        expect(errors.join('\n')).toMatch(/health must be 1-20/);
        expect(errors.join('\n')).toMatch(/defense must be/);
        expect(errors.join('\n')).toMatch(/intents must be a non-empty list/);
    });
});
