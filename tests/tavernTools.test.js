/**
 * The tavern tools Goobster can run from chat/voice: info lookups, party
 * management (including inviting himself), freeform acting, recaps, dice,
 * and asset-service basics. AI is mocked out - tools must work without it.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-tools-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const characterService = require('@goobster/core/services/tavern/characterService');
const adventureService = require('@goobster/core/services/tavern/adventureService');
const assetService = require('@goobster/core/services/tavern/assetService');
const openaiService = require('@goobster/core/services/openaiService');

const GUILD = '800000000000000001';
const CHANNEL_ID = '800000000000000010';
const ALICE = '800000000000000101';
const BOT = '800000000000000999';

function makeContext() {
    return {
        guildId: GUILD,
        user: { id: ALICE },
        channel: { id: CHANNEL_ID, client: { user: { id: BOT } }, send: jest.fn().mockResolvedValue({}) },
        client: { user: { id: BOT } }
    };
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.restoreAllMocks();
    // Tools must work with no AI provider at all
    jest.spyOn(aiService, 'generateText').mockRejectedValue(new Error('no provider in tests'));
    // The bot's delayed turn timer is covered by its own spec; keep it from
    // firing after this suite tears down
    jest.spyOn(require('@goobster/core/services/tavern/botAdventurer'), 'maybeTakeTurn').mockImplementation(() => {});
    db.run('DELETE FROM tavern_adventure_log');
    db.run('DELETE FROM tavern_party_members');
    db.run('DELETE FROM tavern_adventures');
    db.run('DELETE FROM tavern_characters');
    characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice Vell', origin: 'Clockwork pilgrim',
        calling: 'guide', complication: 'Cannot resist a dare',
        stats: { might: 0, finesse: 1, wits: 2, heart: 3 }
    });
});

test('the tavern tools are registered (and exposed to definitions)', () => {
    const names = toolsRegistry.getDefinitions().map(def => def.name);
    for (const name of ['tavernInfo', 'tavernParty', 'tavernAct', 'tavernRecap', 'rollDice']) {
        expect(names).toContain(name);
    }
    const subset = toolsRegistry.getDefinitions(['tavernInfo', 'rollDice']).map(def => def.name);
    expect(subset.sort()).toEqual(['rollDice', 'tavernInfo']);
});

describe('tavernInfo', () => {
    test('status, rumor, board, npc, and character lookups', async () => {
        const interactionContext = makeContext();
        expect(await toolsRegistry.execute('tavernInfo', { topic: 'status', interactionContext })).toMatch(/Goobster Tavern/);
        expect(await toolsRegistry.execute('tavernInfo', { topic: 'rumor', interactionContext })).toMatch(/Rumor of the day/);
        const board = await toolsRegistry.execute('tavernInfo', { topic: 'board', interactionContext });
        expect(board).toMatch(/The Missing Bell of Brinewatch/);
        expect(board).toMatch(/🔒 Signal in the Salt/); // chapter 2 gated
        expect(await toolsRegistry.execute('tavernInfo', { topic: 'npc', npc: 'albert', interactionContext })).toMatch(/Keeper of the Impractical Beacon/);
        expect(await toolsRegistry.execute('tavernInfo', { topic: 'character', interactionContext })).toMatch(/Alice Vell .*Heart \+3/);
        expect(await toolsRegistry.execute('tavernInfo', { topic: 'world', interactionContext })).toMatch(/blank parchment/);
    });
});

describe('tavernParty + tavernAct + tavernRecap', () => {
    test('a full chat-driven session: create, invite Goobster, begin, act, recap', async () => {
        const interactionContext = makeContext();
        adventureService.rng = () => 0.7; // every d20 is 15

        const created = await toolsRegistry.execute('tavernParty', { action: 'create', questId: 'rat-problem', interactionContext });
        expect(created).toMatch(/Party posted/);
        expect(interactionContext.channel.send).toHaveBeenCalledTimes(1); // the party card

        const invited = await toolsRegistry.execute('tavernParty', { action: 'invite-bot', interactionContext });
        expect(invited).toMatch(/Goobster pulls up a chair/);

        const begun = await toolsRegistry.execute('tavernParty', { action: 'begin', interactionContext });
        expect(begun).toMatch(/begins with a party of 2/);

        const acted = await toolsRegistry.execute('tavernAct', { action: 'I read the union minutes aloud, with voices', interactionContext });
        expect(acted).toMatch(/SUCCESS|FAILURE/);

        // Wrap up via the engine and read the recap back through the tool
        const open = adventureService.getOpenAdventureInChannel(CHANNEL_ID);
        adventureService.chooseOption(open.id, ALICE, 'to-verdict');
        adventureService.chooseOption(open.id, ALICE, 'side-with-rats');
        const recap = await toolsRegistry.execute('tavernRecap', { interactionContext });
        expect(recap).toMatch(/Rat Problem, Unreasonably Political/);
        expect(recap).toMatch(/The Union Stands/);
    });

    test('friendly errors surface as text, never throws', async () => {
        const interactionContext = makeContext();
        expect(await toolsRegistry.execute('tavernAct', { action: 'I dance', interactionContext })).toMatch(/No adventure at this table/);
        expect(await toolsRegistry.execute('tavernParty', { action: 'create', questId: 'signal-in-the-salt', interactionContext })).toMatch(/isn't on the board yet/);
        expect(await toolsRegistry.execute('tavernRecap', { interactionContext })).toMatch(/blank/);
    });
});

describe('rollDice', () => {
    test('stat checks use the character sheet; expressions parse and clamp', async () => {
        const interactionContext = makeContext();
        const check = await toolsRegistry.execute('rollDice', { stat: 'heart', dc: 10, interactionContext });
        expect(check).toMatch(/Alice Vell heart check: \d+ \+ 3 = \d+ vs DC 10/);
        expect(await toolsRegistry.execute('rollDice', { expression: '2d6+1', interactionContext })).toMatch(/2d6\+1 -> \d+/);
        expect(await toolsRegistry.execute('rollDice', { expression: 'banana', interactionContext })).toMatch(/❌/);
        expect(await toolsRegistry.execute('rollDice', { expression: '99d99', interactionContext })).toMatch(/at most 20 dice/);
    });
});

describe('assetService', () => {
    test('paths live under data/tavern/assets and missing art returns null', () => {
        expect(assetService.sceneArtPath('some-quest', 'a-scene'))
            .toMatch(/data[/\\]tavern[/\\]assets[/\\]scenes[/\\]some-quest[/\\]a-scene\.png$/);
        expect(assetService.getSceneArt('no-such-quest', 'nowhere')).toBeNull();
    });

    test('generation degrades gracefully without an OpenAI key', async () => {
        jest.spyOn(openaiService, 'isConfigured').mockReturnValue(false);
        const quest = require('@goobster/core/services/tavern/questLoader').getQuest('rat-problem');
        const result = await assetService.generateQuestArt(quest);
        expect(result.generated).toEqual([]);
        expect(result.failed[0].error).toMatch(/No OpenAI key/);
    });
});
