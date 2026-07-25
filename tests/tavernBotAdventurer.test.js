/**
 * Goobster as a party member: invitations (lazy Oddity character, guards,
 * multi-table presence), decision legalization, deterministic fallback, and
 * a full model-decided turn against a fake channel.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-bot-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const aiService = require('../services/aiService');
const characterService = require('../services/tavern/characterService');
const adventureServiceSingleton = require('../services/tavern/adventureService');
const { AdventureService } = require('../services/tavern/adventureService');
const botAdventurer = require('../services/tavern/botAdventurer');
const { TavernError } = require('../services/tavern/tavernError');

const GUILD = '700000000000000001';
const CHANNEL = '700000000000000010';
const CHANNEL2 = '700000000000000011';
const ALICE = '700000000000000101';
const BOB = '700000000000000102';
const BOT = '700000000000000999';

function rollQueue(...rolls) {
    const queue = [...rolls];
    return () => ((queue.length ? queue.shift() : 10) - 1) / 20;
}

function makeCharacters() {
    characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice Vell', origin: 'Clockwork pilgrim',
        calling: 'guide', complication: 'Cannot resist a dare',
        stats: { might: 0, finesse: 1, wits: 2, heart: 3 }
    });
    characterService.createCharacter({
        guildId: GUILD, userId: BOB, name: 'Bob the Door', origin: 'Cursed cookbook heir',
        calling: 'vanguard', complication: 'Will not abandon anyone',
        stats: { might: 3, finesse: 0, wits: 2, heart: 1 }
    });
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.restoreAllMocks();
    db.run('DELETE FROM tavern_adventure_log');
    db.run('DELETE FROM tavern_party_members');
    db.run('DELETE FROM tavern_adventures');
    db.run('DELETE FROM tavern_characters');
    makeCharacters();
});

describe('inviteBot', () => {
    test('creates the Oddity character lazily and seats him', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });

        const { members, character } = service.inviteBot(adventure.id, ALICE, BOT);
        expect(character.name).toBe('Goobster');
        expect(character.calling).toBe('oddity');
        expect(members.map(m => m.userId)).toEqual([ALICE, BOT]);

        // Guards
        expect(() => service.inviteBot(adventure.id, ALICE, BOT)).toThrow(/already at this table/);
        expect(() => service.inviteBot(adventure.id, BOB, BOT)).toThrow(/Only party members/);
    });

    test('the bot can sit at multiple tables (skips the one-party rule)', () => {
        const service = new AdventureService(rollQueue());
        const first = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.inviteBot(first.adventure.id, ALICE, BOT);

        const second = service.createParty({ guildId: GUILD, channelId: CHANNEL2, questId: 'rat-problem', userId: BOB });
        const { members } = service.inviteBot(second.adventure.id, BOB, BOT);
        expect(members.map(m => m.userId)).toEqual([BOB, BOT]);
        // Only one character sheet exists for him
        expect(db.get('SELECT COUNT(*) AS c FROM tavern_characters WHERE userId = @u', { u: BOT }).c).toBe(1);
    });

    test('invitations only work while recruiting and respect party size', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: ALICE });
        service.join(adventure.id, BOB); // rat-problem max is 2
        expect(() => service.inviteBot(adventure.id, ALICE, BOT)).toThrow(/full/);
        service.abandon(adventure.id, ALICE);

        const other = service.createParty({ guildId: GUILD, channelId: CHANNEL2, questId: 'missing-bell-of-brinewatch', userId: BOB });
        service.begin(other.adventure.id, BOB);
        expect(() => service.inviteBot(other.adventure.id, BOB, BOT)).toThrow(TavernError);
    });
});

describe('decisions', () => {
    const candidates = [
        { key: 'question-pell', label: 'Question', stat: 'heart' },
        { key: 'climb-tower', label: 'Climb', stat: 'finesse' }
    ];

    test('legalize accepts a listed choice or a sane improvised action', () => {
        expect(botAdventurer.legalize({ choice: 'question-pell' }, candidates)).toEqual({ optionKey: 'question-pell' });
        expect(botAdventurer.legalize({ choice: 'hack-the-mainframe' }, candidates)).toBeNull();
        expect(botAdventurer.legalize({ act: 'I taste the sea air suspiciously' }, candidates))
            .toEqual({ freeform: 'I taste the sea air suspiciously' });
        expect(botAdventurer.legalize({ act: 'x'.repeat(301) }, candidates)).toBeNull();
        expect(botAdventurer.legalize('nonsense', candidates)).toBeNull();
    });

    test('fallback picks the option best suited to his sheet, else improvises', () => {
        const character = { might: 1, finesse: 1, wits: 2, heart: 2 };
        expect(botAdventurer._fallback({ candidates, character, scene: { title: 'X' } })).toEqual({ optionKey: 'question-pell' });
        const improv = botAdventurer._fallback({ candidates: [], character, scene: { title: 'The Crypt' } });
        expect(typeof improv.freeform).toBe('string');
        expect(improv.freeform.length).toBeGreaterThan(10);
    });
});

describe('taking a turn', () => {
    test('plays a model-chosen option when the spotlight is his, never a travel option', async () => {
        // The singleton adventure service is what botAdventurer uses; feed it
        // fixed d20s so the outcome is deterministic.
        adventureServiceSingleton.rng = rollQueue(15, 14);

        const { adventure } = adventureServiceSingleton.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        adventureServiceSingleton.inviteBot(adventure.id, ALICE, BOT);
        adventureServiceSingleton.begin(adventure.id, ALICE);

        // Alice acts; the spotlight rotates to Goobster
        adventureServiceSingleton.chooseOption(adventure.id, ALICE, 'question-pell');
        expect(adventureServiceSingleton.spotlightUser(adventureServiceSingleton.getAdventure(adventure.id))).toBe(BOT);

        // The model tries a travel option (illegal for him), then he is
        // legalized away from it - here we answer with a legal check instead.
        const generateText = jest.spyOn(aiService, 'generateText').mockResolvedValue('{"choice": "study-tide"}');

        const channel = { client: { user: { id: BOT } }, send: jest.fn().mockResolvedValue({}) };
        await botAdventurer._takeTurn(adventure.id, channel, BOT);

        expect(generateText).toHaveBeenCalled();
        // The prompt offered only check options - no travel keys
        expect(generateText.mock.calls[0][0]).not.toMatch(/to-chapel/);
        expect(channel.send).toHaveBeenCalled();
        const posted = channel.send.mock.calls[0][0];
        expect(posted.content).toMatch(/Goobster.*Study the strange tide/s);
        // d20(14) + wits(2) = 16 vs DC 10 -> success -> bell clock advanced
        expect(posted.content).toMatch(/Success/);
        expect(adventureServiceSingleton.getAdventure(adventure.id).state.clocks.bell).toBe(2);
        // No Spark-reroll button is ever offered on his outcomes
        expect(posted.components).toEqual([]);
        // Spotlight moved on from him
        expect(adventureServiceSingleton.spotlightUser(adventureServiceSingleton.getAdventure(adventure.id))).toBe(ALICE);
    });

    test('does nothing when it is not his spotlight or he is not seated', async () => {
        adventureServiceSingleton.rng = rollQueue();
        const { adventure } = adventureServiceSingleton.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        adventureServiceSingleton.join(adventure.id, BOB);
        adventureServiceSingleton.begin(adventure.id, ALICE);

        const channel = { client: { user: { id: BOT } }, send: jest.fn() };
        await botAdventurer._takeTurn(adventure.id, channel, BOT);
        expect(channel.send).not.toHaveBeenCalled();
    });

    test('falls back deterministically when the model is unusable', async () => {
        adventureServiceSingleton.rng = rollQueue(15, 14);
        const { adventure } = adventureServiceSingleton.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        adventureServiceSingleton.inviteBot(adventure.id, ALICE, BOT);
        adventureServiceSingleton.begin(adventure.id, ALICE);
        adventureServiceSingleton.chooseOption(adventure.id, ALICE, 'question-pell');

        jest.spyOn(aiService, 'generateText').mockRejectedValue(new Error('no provider'));
        const channel = { client: { user: { id: BOT } }, send: jest.fn().mockResolvedValue({}) };
        await botAdventurer._takeTurn(adventure.id, channel, BOT);

        // Fallback picks the check option best matching his sheet (wits +2 -> study-tide)
        expect(channel.send).toHaveBeenCalled();
        expect(channel.send.mock.calls[0][0].content).toMatch(/Study the strange tide/);
    });
});
