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

function makeAlice() {
    characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice the Advocate', origin: 'Disbarred storm barrister',
        calling: 'vanguard', complication: 'Objects to everything',
        stats: { might: 3, finesse: 1, wits: 2, heart: 0 }
    });
}

function startAtHall(service, withBob = false) {
    makeAlice();
    if (withBob) {
        characterService.createCharacter({
            guildId: GUILD, userId: BOB, name: 'Bob the Paralegal', origin: 'Notary of the deep',
            calling: 'guide', complication: 'Bills by the hour',
            stats: { might: 1, finesse: 1, wits: 2, heart: 2 }
        });
    }
    const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'dungeon-tenant-rights', userId: ALICE });
    if (withBob) service.join(adventure.id, BOB);
    service.begin(adventure.id, ALICE);
    service.chooseOption(adventure.id, ALICE, 'descend');
    return adventure.id;
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
});

describe('encounter setup', () => {
    test('entering an encounter scene arms the combat state and telegraphs intents', () => {
        const service = new AdventureService(rollQueue());
        const id = startAtHall(service);
        const adventure = service.getAdventure(id);
        const quest = questLoader.getQuest('dungeon-tenant-rights');

        expect(adventure.sceneId).toBe('grievance-hall');
        expect(adventure.state.combat.sceneId).toBe('grievance-hall');
        const living = service.livingEnemies(adventure, quest);
        expect(living).toHaveLength(1);
        expect(living[0].name).toBe('The Clause Golem');
        expect(living[0].currentHealth).toBe(8);
        expect(service.telegraphedIntent(adventure, living[0])).toMatch(/gavel-fist toward the cracked ceiling/);
    });

    test('attacking outside combat is refused politely', () => {
        const service = new AdventureService(rollQueue());
        makeAlice();
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'dungeon-tenant-rights', userId: ALICE });
        service.begin(adventure.id, ALICE);
        expect(() => service.attack(adventure.id, ALICE, 'clause-golem')).toThrow(/nothing here that wants fighting/i);
    });
});

describe('attack resolution and enemy rounds', () => {
    test('a hit damages the golem; solo party means it answers every action', () => {
        // Attack d20(12) + might(3) = 15 vs defense 13 -> hit for 2
        const service = new AdventureService(rollQueue(12));
        const id = startAtHall(service);

        const result = service.attack(id, ALICE, 'clause-golem');
        expect(result.kind).toBe('attack');
        expect(result.success).toBe(true);
        expect(result.adventure.state.combat.enemies['clause-golem'].health).toBe(6);
        // Solo party: the enemy round fires immediately - intent executed, damage taken
        expect(result.happenings.join('\n')).toMatch(/The Clause Golem.*gavel-fist/s);
        expect(characterService.getCharacter(GUILD, ALICE).health).toBe(8);
        // The NEXT intent is telegraphed
        expect(result.happenings.join('\n')).toMatch(/Next: .*subpoena/s);
    });

    test('a natural 20 crits for +1 damage and grants Spark', () => {
        const service = new AdventureService(rollQueue(20));
        const id = startAtHall(service);
        const result = service.attack(id, ALICE, 'clause-golem');
        expect(result.adventure.state.combat.enemies['clause-golem'].health).toBe(5);
        expect(result.happenings.join('\n')).toMatch(/Natural 20/);
        expect(characterService.getCharacter(GUILD, ALICE).spark).toBe(2);
    });

    test('a missed attack still draws the round, and Spark can reroll it', () => {
        // Miss with 5, reroll hits with 15
        const service = new AdventureService(rollQueue(5, 15));
        const id = startAtHall(service);

        const miss = service.attack(id, ALICE, 'clause-golem');
        expect(miss.success).toBe(false);
        expect(miss.canReroll).toBe(true);
        expect(miss.adventure.state.combat.enemies['clause-golem'].health).toBe(8);
        expect(miss.happenings.join('\n')).toMatch(/weathers the attempt/);
        // The golem answered the whiff
        expect(characterService.getCharacter(GUILD, ALICE).health).toBe(8);

        const reroll = service.sparkReroll(id, ALICE);
        expect(reroll.success).toBe(true);
        expect(reroll.adventure.state.combat.enemies['clause-golem'].health).toBe(6);
        expect(characterService.getCharacter(GUILD, ALICE).spark).toBe(0);
    });

    test('with two members the golem acts every second action, cycling intents', () => {
        // Hit, hit (golem 4), miss, hit (golem 2) - alive throughout
        const service = new AdventureService(rollQueue(12, 12, 5, 12));
        const id = startAtHall(service, true);

        const first = service.attack(id, ALICE, 'clause-golem');
        expect(first.happenings.join('\n')).not.toMatch(/💥/); // round not yet due
        const second = service.attack(id, BOB, 'clause-golem');
        expect(second.happenings.join('\n')).toMatch(/💥 It catches Bob the Paralegal for 2/);
        const third = service.attack(id, ALICE, 'clause-golem');
        expect(third.happenings.join('\n')).not.toMatch(/💥/);
        const fourth = service.attack(id, BOB, 'clause-golem');
        // Second enemy round executes the SECOND intent (cycled)
        expect(fourth.happenings.join('\n')).toMatch(/subpoena/);
        expect(fourth.adventure.state.combat.enemies['clause-golem'].health).toBe(2);
    });

    test('defeat drops loot and victory moves the scene', () => {
        // Golem has 8 health; four hits at 2 = down. All rolls 15.
        const service = new AdventureService(rollQueue(15, 15, 15, 15));
        const id = startAtHall(service);

        service.attack(id, ALICE, 'clause-golem'); // 6
        service.attack(id, ALICE, 'clause-golem'); // 4
        service.attack(id, ALICE, 'clause-golem'); // 2
        const final = service.attack(id, ALICE, 'clause-golem'); // 0

        expect(final.happenings.join('\n')).toMatch(/is defeated!/);
        expect(final.happenings.join('\n')).toMatch(/Deed-Seal of Deed's End/);
        expect(final.happenings.join('\n')).toMatch(/The encounter is won!/);
        expect(final.sceneChanged).toBe(true);
        expect(final.adventure.sceneId).toBe('settlement');
        expect(final.adventure.state.flags.golem).toBe('subdued');
        expect(characterService.getCharacter(GUILD, ALICE).inventory).toContain("Deed-Seal of Deed's End");
        expect(() => service.attack(id, ALICE, 'clause-golem')).toThrow(TavernError);
    });

    test('the social path bypasses combat entirely', () => {
        // cite-precedent: d20(15) + wits(2) = 17 vs 16 -> success -> settlement
        const service = new AdventureService(rollQueue(15));
        const id = startAtHall(service);
        const result = service.chooseOption(id, ALICE, 'cite-precedent');
        expect(result.success).toBe(true);
        expect(result.adventure.sceneId).toBe('settlement');
        expect(result.adventure.state.flags.golem).toBe('outargued');
        // No combat in the new scene
        expect(result.adventure.state.combat).toBeNull();
    });
});

describe('usable items', () => {
    test('using a consumable heals, is consumed, and draws the enemy round', () => {
        const service = new AdventureService(rollQueue(15, 5));
        makeAlice();
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'dungeon-tenant-rights', userId: ALICE });
        service.begin(adventure.id, ALICE);
        // Pick up the poultice from the steward (heart... roll 15 + 0 = 15 vs 10)
        service.chooseOption(adventure.id, ALICE, 'interview-skeleton');
        expect(characterService.getCharacter(GUILD, ALICE).inventory).toContain('Lease-Sealed Poultice');
        service.chooseOption(adventure.id, ALICE, 'descend');

        // Take a hit first (miss with 5 -> golem answers for 2)
        service.attack(adventure.id, ALICE, 'clause-golem');
        expect(characterService.getCharacter(GUILD, ALICE).health).toBe(8);

        const result = service.useItem(adventure.id, ALICE, 'lease-sealed poultice');
        expect(result.kind).toBe('item');
        expect(result.outcomeText).toMatch(/enforceable clauses/);
        expect(result.happenings.join('\n')).toMatch(/recovers 3/);
        // Consumed, and the golem noticed (solo party: round fires)
        expect(characterService.getCharacter(GUILD, ALICE).inventory).not.toContain('Lease-Sealed Poultice');
        expect(result.happenings.join('\n')).toMatch(/The Clause Golem/);

        // Unknown/undefined items do nothing mechanical
        expect(() => service.useItem(adventure.id, ALICE, 'Framed Writ of Dwelling')).toThrow(/nothing obvious happens/i);
    });

    test('give and drop manage the pack', () => {
        makeAlice();
        characterService.createCharacter({
            guildId: GUILD, userId: BOB, name: 'Bob', origin: 'Notary', calling: 'guide',
            complication: 'Bills by the hour', stats: { might: 1, finesse: 1, wits: 2, heart: 2 }
        });
        const alice = characterService.getCharacter(GUILD, ALICE);
        characterService.addItem(alice.id, 'Pebble of Unresolved Litigation');

        const { to } = characterService.transferItem({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, item: 'pebble of unresolved litigation' });
        expect(to.inventory).toContain('Pebble of Unresolved Litigation');
        expect(characterService.getCharacter(GUILD, ALICE).inventory).toEqual([]);
        expect(() => characterService.transferItem({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, item: 'pebble of unresolved litigation' }))
            .toThrow(/not carrying/);

        const bob = characterService.getCharacter(GUILD, BOB);
        expect(characterService.removeItem(bob.id, 'Pebble of Unresolved Litigation')).toBe('Pebble of Unresolved Litigation');
        expect(characterService.removeItem(bob.id, 'Pebble of Unresolved Litigation')).toBeNull();
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
