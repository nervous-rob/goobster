/**
 * The campaign forge: Goobster writing/patching campaign YAML. The model is
 * mocked (canned JSON); what's under test is the deterministic machinery -
 * validation, the ties-back guarantee, hidden fork campaigns, file writing,
 * and the twist re-pointing a live adventure.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-forge-test-${process.pid}.sqlite`);
const TEST_CAMPAIGNS = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-forge-campaigns-'));
process.env.GOOBSTER_DB_PATH = TEST_DB;
process.env.GOOBSTER_TAVERN_CAMPAIGNS_DIR = TEST_CAMPAIGNS;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const questLoader = require('@goobster/core/services/tavern/questLoader');
const campaignForge = require('@goobster/core/services/tavern/campaignForge');
const characterService = require('@goobster/core/services/tavern/characterService');
const { AdventureService } = require('@goobster/core/services/tavern/adventureService');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');

const GUILD = '920000000000000001';
const CHANNEL = '920000000000000010';
const ALICE = '920000000000000101';

function rollQueue(...rolls) {
    const queue = [...rolls];
    return () => ((queue.length ? queue.shift() : 10) - 1) / 20;
}

async function makeAlice() {
    await characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice Vell', origin: 'Clockwork pilgrim',
        calling: 'guide', complication: 'Cannot resist a dare',
        stats: { might: 0, finesse: 1, wits: 2, heart: 3 }
    });
}

/** A valid twist for rat-problem: one new scene that ends at an existing ending. */
const GOOD_TWIST = {
    note: 'The union and the party open a bakery instead.',
    entrySceneId: 'bakery-gambit',
    scenes: [{
        id: 'bakery-gambit',
        title: 'The Bakery Gambit',
        text: 'The hearing adjourns to the kitchen, where labor relations meet laminated dough.',
        options: [
            {
                key: 'bake-the-accords', label: 'Bake the accords into a celebratory loaf', emoji: '🥖',
                stat: 'heart', dc: 'routine',
                success: { text: 'The loaf rises; so does solidarity.', effects: { end: 'historic-compromise' } },
                failure: { text: 'The loaf collapses, but talks continue.', effects: { clock: { id: 'patience', delta: 1 }, goto: 'verdict' } }
            },
            { key: 'back-to-verdict', label: 'Return to the hearing', goto: 'verdict', text: 'Flour-dusted, you reconvene.' }
        ]
    }]
};

/** A valid brand-new campaign. */
const GOOD_CAMPAIGN = {
    id: 'the-soup-crusade',
    title: 'The Soup Crusade',
    type: 'one-shot',
    hook: 'The soup of the day has declared independence.',
    players: { min: 1, max: 3, recommended: '1-3' },
    duration: '15-30 min',
    difficulty: 'routine',
    tags: ['comedy'],
    affectsWorld: false,
    reward: 'Soup.',
    start: 'kitchen',
    clocks: [
        { id: 'simmer', name: 'The Simmering', size: 4, kind: 'danger', onFull: { end: 'boil-over' } }
    ],
    scenes: [{
        id: 'kitchen',
        title: 'The Kitchen Front',
        text: 'The pot has barricaded itself behind the stove.',
        options: [
            {
                key: 'negotiate', label: 'Negotiate with the soup', emoji: '🍲', stat: 'heart', dc: 'routine',
                success: { text: 'Terms are reached.', effects: { end: 'peace' } },
                failure: { text: 'The soup simmers ominously.', effects: { clock: { id: 'simmer', delta: 1 } } }
            }
        ]
    }],
    endings: [
        { id: 'peace', title: 'Soup Peace', text: 'The soup is granted the dignity it always deserved.' },
        { id: 'boil-over', title: 'The Boil-Over', text: 'The kitchen is lost. The soup is magnificent.' }
    ]
};

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
    fs.rmSync(TEST_CAMPAIGNS, { recursive: true, force: true });
});

beforeEach(async () => {
    jest.restoreAllMocks();
    await db.run('DELETE FROM tavern_adventure_log');
    await db.run('DELETE FROM tavern_party_members');
    await db.run('DELETE FROM tavern_adventures');
    await db.run('DELETE FROM tavern_characters');
    fs.rmSync(TEST_CAMPAIGNS, { recursive: true, force: true });
    fs.mkdirSync(TEST_CAMPAIGNS, { recursive: true });
    questLoader.reload();
    await makeAlice();
});

describe('checkTiesBack', () => {
    test('accepts branches that rejoin the campaign and rejects dead ends', () => {
        const quest = questLoader.getQuest('rat-problem');
        const merged = JSON.parse(JSON.stringify(quest));
        merged.scenes['bakery-gambit'] = GOOD_TWIST.scenes[0];
        expect(campaignForge.checkTiesBack(merged, new Set(['bakery-gambit']), 'bakery-gambit')).toEqual([]);

        const deadEnd = JSON.parse(JSON.stringify(quest));
        deadEnd.scenes['limbo'] = {
            id: 'limbo', title: 'Limbo', text: 'Nothing leads anywhere.',
            options: [{ key: 'wait', label: 'Wait', stat: 'wits', dc: 'routine',
                success: { text: 'Nothing.' }, failure: { text: 'Also nothing.' } }]
        };
        const errors = campaignForge.checkTiesBack(deadEnd, new Set(['limbo']), 'limbo');
        expect(errors.join('\n')).toMatch(/dead end/);
        expect(errors.join('\n')).toMatch(/must tie back/);
    });
});

describe('forgeTwist', () => {
    async function startRatProblem() {
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        return { service, adventureId: adventure.id };
    }

    test('a valid twist forges a hidden fork and re-points the adventure', async () => {
        jest.spyOn(aiService, 'generateText').mockResolvedValue(JSON.stringify(GOOD_TWIST));
        const { service, adventureId } = await startRatProblem();
        const adventure = await service.getAdventure(adventureId);
        const quest = questLoader.getQuest('rat-problem');

        const { forkQuestId, entrySceneId, note } = await campaignForge.forgeTwist({
            adventure, quest, scene: quest.scenes[adventure.sceneId],
            recentLog: '- the hearing began', twist: 'we open a bakery with the rats',
            guildId: GUILD, userId: ALICE
        });

        expect(forkQuestId).toBe(`rat-problem--twist-${adventureId}`);
        expect(entrySceneId).toBe('bakery-gambit');
        expect(note).toMatch(/bakery/i);

        // The fork is on disk, hidden, canonical, and carries ALL original content
        expect(fs.existsSync(path.join(TEST_CAMPAIGNS, forkQuestId, 'scenes', 'bakery-gambit.yaml'))).toBe(true);
        const fork = questLoader.getQuest(forkQuestId);
        expect(fork.hidden).toBe(true);
        expect(fork.canonicalId).toBe('rat-problem');
        expect(Object.keys(fork.scenes)).toEqual(expect.arrayContaining(['hearing', 'verdict', 'bakery-gambit']));
        expect(questLoader.getVisibleQuests().map(q => q.id)).not.toContain(forkQuestId);
        // The original campaign is untouched
        expect(questLoader.getQuest('rat-problem').scenes['bakery-gambit']).toBeUndefined();

        // Re-point the live adventure and play the new scene to an ORIGINAL ending
        const moved = await service.applyTwist(adventureId, forkQuestId, entrySceneId, note);
        expect(moved.adventure.questId).toBe(forkQuestId);
        expect(moved.adventure.sceneId).toBe('bakery-gambit');
        expect(moved.adventure.state.twistUsed).toBe(true);

        service.rng = rollQueue(15); // 15 + heart(3) vs routine -> success -> historic-compromise
        const ended = await service.chooseOption(adventureId, ALICE, 'bake-the-accords');
        expect(ended.ended.endingId).toBe('historic-compromise');

        // A twist completion still satisfies chapter gates on the canonical id
        const gated = { id: 'x', requires: 'rat-problem' };
        expect(await service.isQuestUnlocked(GUILD, gated)).toBe(true);
    });

    test('unusable model output fails gracefully after a repair round', async () => {
        const badTwist = { note: 'nope', entrySceneId: 'limbo', scenes: [{
            id: 'limbo', title: 'Limbo', text: 'Dead end.',
            options: [{ key: 'wait', label: 'Wait', stat: 'wits', dc: 'routine',
                success: { text: 'Nothing.' }, failure: { text: 'Nothing.' } }]
        }] };
        const generateText = jest.spyOn(aiService, 'generateText').mockResolvedValue(JSON.stringify(badTwist));
        const { service, adventureId } = await startRatProblem();
        const adventure = await service.getAdventure(adventureId);
        const quest = questLoader.getQuest('rat-problem');

        await expect(campaignForge.forgeTwist({
            adventure, quest, scene: quest.scenes[adventure.sceneId],
            recentLog: '-', twist: 'nothing forever', guildId: GUILD, userId: ALICE
        })).rejects.toThrow(TavernError);
        expect(generateText).toHaveBeenCalledTimes(2); // initial + repair round
        // Nothing written
        expect(fs.readdirSync(TEST_CAMPAIGNS)).toEqual([]);
    });
});

describe('forgeCampaign', () => {
    test('a valid generated campaign lands on the board as editable YAML', async () => {
        jest.spyOn(aiService, 'generateText').mockResolvedValue(JSON.stringify(GOOD_CAMPAIGN));
        const quest = await campaignForge.forgeCampaign({ prompt: 'a soup uprising', guildId: GUILD, userId: ALICE });

        expect(quest.id).toBe('the-soup-crusade');
        expect(quest.source).toBe('custom');
        expect(fs.existsSync(path.join(TEST_CAMPAIGNS, 'the-soup-crusade', 'quest.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(TEST_CAMPAIGNS, 'the-soup-crusade', 'scenes', 'kitchen.yaml'))).toBe(true);
        expect(questLoader.getVisibleQuests().map(q => q.id)).toContain('the-soup-crusade');

        // And it is actually playable
        const service = new AdventureService(rollQueue(15));
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'the-soup-crusade', userId: ALICE });
        await service.begin(adventure.id, ALICE);
        const result = await service.chooseOption(adventure.id, ALICE, 'negotiate');
        expect(result.ended.endingId).toBe('peace');
    });

    test('id collisions with existing quests get a unique suffix', async () => {
        jest.spyOn(aiService, 'generateText').mockResolvedValue(
            JSON.stringify({ ...GOOD_CAMPAIGN, id: 'rat-problem' })
        );
        const quest = await campaignForge.forgeCampaign({ prompt: 'rat things', guildId: GUILD, userId: ALICE });
        expect(quest.id).toMatch(/^rat-problem-\d+$/);
        expect(questLoader.getQuest('rat-problem').title).toBe('Rat Problem, Unreasonably Political');
    });

    test('invalid generations are rejected with details, nothing written', async () => {
        jest.spyOn(aiService, 'generateText').mockResolvedValue('the dog ate my JSON');
        await expect(campaignForge.forgeCampaign({ prompt: 'anything', guildId: GUILD, userId: ALICE }))
            .rejects.toThrow(/did not validate/);
        expect(fs.readdirSync(TEST_CAMPAIGNS)).toEqual([]);
    });
});
