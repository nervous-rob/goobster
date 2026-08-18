/**
 * The adventure engine, played deterministically against the real YAML
 * campaigns with an injected RNG: party lifecycle, checks, clocks, Spark
 * rerolls, big moves, endings, rewards, and recaps.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-adv-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const characterService = require('@goobster/core/services/tavern/characterService');
const { AdventureService } = require('@goobster/core/services/tavern/adventureService');
const { TavernError } = require('@goobster/core/services/tavern/tavernError');

const GUILD = '400000000000000001';
const CHANNEL = '400000000000000010';
const CHANNEL2 = '400000000000000011';
const ALICE = '400000000000000101'; // heart specialist
const BOB = '400000000000000102';   // might specialist
const EVE = '400000000000000103';   // not in the party

/** An RNG that yields queued d20 results (default 10 when the queue runs dry). */
function rollQueue(...rolls) {
    const queue = [...rolls];
    return () => ((queue.length ? queue.shift() : 10) - 1) / 20;
}

async function makeCharacters() {
    await characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice Vell', origin: 'Clockwork pilgrim',
        calling: 'troubadour', complication: 'Cannot resist a dare',
        stats: { might: 0, finesse: 1, wits: 2, heart: 3 }
    });
    await characterService.createCharacter({
        guildId: GUILD, userId: BOB, name: 'Bob the Door', origin: 'Human with a cursed family cookbook',
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

beforeEach(async () => {
    await db.run('DELETE FROM tavern_adventure_log');
    await db.run('DELETE FROM tavern_party_members');
    await db.run('DELETE FROM tavern_adventures');
    await db.run('DELETE FROM tavern_characters');
    await makeCharacters();
});

describe('party lifecycle', () => {
    test('create, join, and the busy-channel / one-party-per-user guards', async () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        expect(adventure.status).toBe('RECRUITING');

        // One adventure per channel
        await expect(service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: BOB }))
            .rejects.toThrow(/already an open adventure/);
        // One open party per user per guild
        await expect(service.createParty({ guildId: GUILD, channelId: CHANNEL2, questId: 'rat-problem', userId: ALICE }))
            .rejects.toThrow(/already in an open adventure/);
        // Characters required
        await expect(service.join(adventure.id, EVE)).rejects.toThrow(/need a character/);

        const { members } = await service.join(adventure.id, BOB);
        expect(members.map(m => m.character.name)).toEqual(['Alice Vell', 'Bob the Door']);
        await expect(service.join(adventure.id, BOB)).rejects.toThrow(/already in this party/);
    });

    test('begin initializes clocks, spotlight, and the first scene', async () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);

        await expect(service.begin(adventure.id, EVE)).rejects.toThrow(TavernError);

        const started = await service.begin(adventure.id, ALICE);
        expect(started.adventure.status).toBe('ACTIVE');
        expect(started.adventure.sceneId).toBe('arrival');
        expect(started.adventure.state.clocks).toEqual({ bell: 0, collapse: 0 });
        expect(started.adventure.state.spotlight).toEqual([ALICE, BOB]);
        expect(started.scene.title).toBe('The Road Ends at Brinewatch');
    });

    test('leave keeps the story alive until the table empties', async () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await service.begin(adventure.id, ALICE);

        expect(await service.leave(adventure.id, ALICE)).toEqual({ remaining: 1, abandoned: false });
        expect(await service.leave(adventure.id, BOB)).toEqual({ remaining: 0, abandoned: true });
        expect((await service.getAdventure(adventure.id)).status).toBe('ABANDONED');
    });

    test('abandon is founder-or-admin only', async () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await expect(service.abandon(adventure.id, BOB)).rejects.toThrow(/party founder/);
        await service.abandon(adventure.id, BOB, { force: true });
        expect((await service.getAdventure(adventure.id)).status).toBe('ABANDONED');
    });
});

describe('checks, clocks, and Spark', () => {
    async function startBrinewatch(service) {
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await service.begin(adventure.id, ALICE);
        return adventure.id;
    }

    test('a successful check applies its effects and consumes once-options', async () => {
        // Alice questions Pell: d20(10) + heart(3) = 13 vs DC 10 -> success
        const service = new AdventureService(rollQueue(10));
        const id = await startBrinewatch(service);

        const result = await service.chooseOption(id, ALICE, 'question-pell');
        expect(result.success).toBe(true);
        expect(result.total).toBe(13);
        expect(result.adventure.state.clocks.bell).toBe(1);
        expect(result.outcomeText).toMatch(/bell didn't fall/i);

        // once: true - the option is gone now
        const { adventure, quest } = { adventure: await service.getAdventure(id), quest: require('@goobster/core/services/tavern/questLoader').getQuest('missing-bell-of-brinewatch') };
        expect(service.availableOptions(adventure, quest).map(o => o.key)).not.toContain('question-pell');
        // spotlight rotated to Bob
        expect(service.spotlightUser(adventure)).toBe(BOB);
    });

    test('a failed check hurts, offers a Spark reroll, and the reroll carries through', async () => {
        // Bob climbs the tower: d20(5) + finesse(0) = 5 vs 13 -> fail (damage 1)
        // Spark reroll: d20(19) + 0 = 19 -> success (bell +1)
        const service = new AdventureService(rollQueue(5, 19));
        const id = await startBrinewatch(service);

        const fail = await service.chooseOption(id, BOB, 'climb-tower');
        expect(fail.success).toBe(false);
        expect(fail.canReroll).toBe(true);
        expect((await characterService.getCharacter(GUILD, BOB)).health).toBe(9);

        const reroll = await service.sparkReroll(id, BOB);
        expect(reroll.success).toBe(true);
        expect(reroll.adventure.state.clocks.bell).toBe(1);
        // Spark spent; the first failure's cost stands
        expect((await characterService.getCharacter(GUILD, BOB)).spark).toBe(0);
        expect((await characterService.getCharacter(GUILD, BOB)).health).toBe(9);
        // No chaining rerolls
        await expect(service.sparkReroll(id, BOB)).rejects.toThrow(TavernError);
    });

    test('natural 20 and natural 1 both feed the Spark economy', async () => {
        // Alice nat-20s Pell (spark +1), Bob nat-1s the tide study
        // (spark +1 AND the danger clock ticks).
        const service = new AdventureService(rollQueue(20, 1));
        const id = await startBrinewatch(service);

        const crit = await service.chooseOption(id, ALICE, 'question-pell');
        expect(crit.success).toBe(true);
        expect((await characterService.getCharacter(GUILD, ALICE)).spark).toBe(2);

        const fumble = await service.chooseOption(id, BOB, 'study-tide');
        expect(fumble.success).toBe(false);
        expect((await characterService.getCharacter(GUILD, BOB)).spark).toBe(2);
        expect(fumble.adventure.state.clocks.collapse).toBe(1);
    });

    test('travel options move the scene without a roll', async () => {
        const service = new AdventureService(rollQueue());
        const id = await startBrinewatch(service);

        const result = await service.chooseOption(id, ALICE, 'to-chapel');
        expect(result.kind).toBe('travel');
        expect(result.sceneChanged).toBe(true);
        expect(result.adventure.sceneId).toBe('chapel');
    });

    test('the big move turns a doomed check into a success, once per adventure', async () => {
        const service = new AdventureService(rollQueue(2));
        const id = await startBrinewatch(service);
        await service.chooseOption(id, ALICE, 'to-chapel');

        await service.useBigMove(id, BOB);
        await expect(service.useBigMove(id, BOB)).rejects.toThrow(/already happened/);

        // d20(2) + might(3) = 5 vs 13 would fail - but the big move says no
        const result = await service.chooseOption(id, BOB, 'ram-door');
        expect(result.auto).toBe(true);
        expect(result.success).toBe(true);
        expect(result.sceneChanged).toBe(true);
        expect(result.adventure.sceneId).toBe('crypt');
    });

    test('item bonuses declared by the campaign apply to the right option', async () => {
        const service = new AdventureService(rollQueue(11));
        const id = await startBrinewatch(service);
        await service.chooseOption(id, ALICE, 'to-chapel');
        await db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'crypt', id });

        // The hymnal grants +2 on sing-hymn: d20(11) + wits(2) + 2 = 15 >= 13
        const alice = await characterService.getCharacter(GUILD, ALICE);
        await characterService.addItem(alice.id, 'Waterlogged Hymnal');
        const result = await service.chooseOption(id, ALICE, 'sing-hymn');
        expect(result.bonus).toBe(2);
        expect(result.total).toBe(15);
        expect(result.success).toBe(true);
        expect(result.adventure.sceneId).toBe('finale');
        expect(result.adventure.state.flags.maren).toBe('singing');
    });
});

describe('endings, rewards, and recaps', () => {
    test('a chosen ending completes the adventure and pays the party', async () => {
        const service = new AdventureService(rollQueue(10, 13));
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await service.begin(adventure.id, ALICE);

        await service.chooseOption(adventure.id, ALICE, 'to-chapel');
        // Bob knocks politely: 10 + heart(1) = 11 vs 10 -> success (+1 spark, bell +1)
        await service.chooseOption(adventure.id, BOB, 'knock-politely');
        await db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'crypt', id: adventure.id });
        // Alice parleys: 13 + heart(3) = 16 vs 16 -> success, to the finale
        const parley = await service.chooseOption(adventure.id, ALICE, 'parley');
        expect(parley.adventure.sceneId).toBe('finale');

        const ended = await service.chooseOption(adventure.id, BOB, 'hang-bell');
        expect(ended.ended.endingId).toBe('hang-bell');

        const finished = await service.getAdventure(adventure.id);
        expect(finished.status).toBe('COMPLETED');
        expect(finished.endingId).toBe('hang-bell');

        for (const userId of [ALICE, BOB]) {
            const character = await characterService.getCharacter(GUILD, userId);
            expect(character.milestones).toBe(1);
            expect(character.adventuresCompleted).toBe(1);
            expect(character.health).toBe(character.maxHealth);
            expect(character.inventory).toContain('Brinewatch Bell-Rope');
        }

        const recap = await service.getLatestRecap(GUILD, CHANNEL);
        expect(recap.questId).toBe('missing-bell-of-brinewatch');
        expect(recap.content).toMatch(/The Missing Bell of Brinewatch/);
        expect(recap.content).toMatch(/The Bell Comes Home/);
        expect(recap.content).toMatch(/Alice Vell, Bob the Door/);
    });

    test('a danger clock filling forces its ending', async () => {
        const service = new AdventureService(rollQueue(2));
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: ALICE });
        await service.begin(adventure.id, ALICE);

        // Marnie's patience is nearly gone; one more freeform fumble fills it
        const state = (await service.getAdventure(adventure.id)).state;
        state.clocks.patience = 3;
        await db.run('UPDATE tavern_adventures SET state = @state WHERE id = @id', { state, id: adventure.id });

        const result = await service.freeform(adventure.id, ALICE, 'I juggle the union minutes');
        expect(result.success).toBe(false);
        expect(result.ended.endingId).toBe('walkout');
        expect((await service.getAdventure(adventure.id)).status).toBe('COMPLETED');
        // The walkout has no trophy - but the hearth still restores and rewards
        const alice = await characterService.getCharacter(GUILD, ALICE);
        expect(alice.milestones).toBe(1);
        expect(alice.inventory).toEqual([]);
    });
});

describe('freeform actions', () => {
    test('keyword inference picks a sensible stat', () => {
        const service = new AdventureService(rollQueue());
        expect(service.inferStat('I use my cooking pot as a helmet and ram the door')).toBe('might');
        expect(service.inferStat('sneak past the drowned choir')).toBe('finesse');
        expect(service.inferStat('sing a soothing shanty to the sexton')).toBe('heart');
        expect(service.inferStat('stare meaningfully at the wall')).toBe('wits');
    });

    test('success advances the progress clock, failure ticks danger', async () => {
        const service = new AdventureService(rollQueue(18, 2));
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await service.begin(adventure.id, ALICE);

        // 18 + wits(2) = 20 vs default 13 -> success -> bell +1
        const win = await service.freeform(adventure.id, ALICE, 'I examine the tide charts');
        expect(win.success).toBe(true);
        expect(win.adventure.state.clocks.bell).toBe(1);
        expect(win.outcomeText).toMatch(/secrets/);

        // 2 + might(3) = 5 vs 13 -> failure -> collapse +1
        const loss = await service.freeform(adventure.id, BOB, 'I ram the tower');
        expect(loss.success).toBe(false);
        expect(loss.adventure.state.clocks.collapse).toBe(1);
    });

    test('an AI interpretation is honored but clamped to real stats/DCs', async () => {
        const service = new AdventureService(rollQueue(10));
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await service.begin(adventure.id, ALICE);

        const result = await service.freeform(adventure.id, ALICE, 'I charm the warden', { stat: 'heart', dc: 12 });
        expect(result.stat).toBe('heart');
        expect(result.dc).toBe(12);
        expect(result.total).toBe(13);

        const bogus = await service.freeform(adventure.id, BOB, 'I do the thing', { stat: 'charisma', dc: 999 });
        expect(['might', 'finesse', 'wits', 'heart']).toContain(bogus.stat);
        expect(bogus.dc).toBe(13);
    });

    test('non-members cannot act', async () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = await service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        await service.join(adventure.id, BOB);
        await service.begin(adventure.id, ALICE);
        await expect(service.freeform(adventure.id, EVE, 'I heckle from the bar')).rejects.toThrow(/not in this party/);
        await expect(service.chooseOption(adventure.id, EVE, 'question-pell')).rejects.toThrow(/not in this party/);
    });
});
