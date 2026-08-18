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

function makeCharacters() {
    characterService.createCharacter({
        guildId: GUILD, userId: ALICE, name: 'Alice Vell', origin: 'Clockwork pilgrim',
        calling: 'troubadour', complication: 'Cannot resist a dare',
        stats: { might: 0, finesse: 1, wits: 2, heart: 3 }
    });
    characterService.createCharacter({
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

beforeEach(() => {
    db.run('DELETE FROM tavern_adventure_log');
    db.run('DELETE FROM tavern_party_members');
    db.run('DELETE FROM tavern_adventures');
    db.run('DELETE FROM tavern_characters');
    makeCharacters();
});

describe('party lifecycle', () => {
    test('create, join, and the busy-channel / one-party-per-user guards', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        expect(adventure.status).toBe('RECRUITING');

        // One adventure per channel
        expect(() => service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: BOB }))
            .toThrow(/already an open adventure/);
        // One open party per user per guild
        expect(() => service.createParty({ guildId: GUILD, channelId: CHANNEL2, questId: 'rat-problem', userId: ALICE }))
            .toThrow(/already in an open adventure/);
        // Characters required
        expect(() => service.join(adventure.id, EVE)).toThrow(/need a character/);

        const { members } = service.join(adventure.id, BOB);
        expect(members.map(m => m.character.name)).toEqual(['Alice Vell', 'Bob the Door']);
        expect(() => service.join(adventure.id, BOB)).toThrow(/already in this party/);
    });

    test('begin initializes clocks, spotlight, and the first scene', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);

        expect(() => service.begin(adventure.id, EVE)).toThrow(TavernError);

        const started = service.begin(adventure.id, ALICE);
        expect(started.adventure.status).toBe('ACTIVE');
        expect(started.adventure.sceneId).toBe('arrival');
        expect(started.adventure.state.clocks).toEqual({ bell: 0, collapse: 0 });
        expect(started.adventure.state.spotlight).toEqual([ALICE, BOB]);
        expect(started.scene.title).toBe('The Road Ends at Brinewatch');
    });

    test('leave keeps the story alive until the table empties', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        service.begin(adventure.id, ALICE);

        expect(service.leave(adventure.id, ALICE)).toEqual({ remaining: 1, abandoned: false });
        expect(service.leave(adventure.id, BOB)).toEqual({ remaining: 0, abandoned: true });
        expect(service.getAdventure(adventure.id).status).toBe('ABANDONED');
    });

    test('abandon is founder-or-admin only', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        expect(() => service.abandon(adventure.id, BOB)).toThrow(/party founder/);
        service.abandon(adventure.id, BOB, { force: true });
        expect(service.getAdventure(adventure.id).status).toBe('ABANDONED');
    });
});

describe('checks, clocks, and Spark', () => {
    function startBrinewatch(service) {
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        service.begin(adventure.id, ALICE);
        return adventure.id;
    }

    test('a successful check applies its effects and consumes once-options', () => {
        // Alice questions Pell: d20(10) + heart(3) = 13 vs DC 10 -> success
        const service = new AdventureService(rollQueue(10));
        const id = startBrinewatch(service);

        const result = service.chooseOption(id, ALICE, 'question-pell');
        expect(result.success).toBe(true);
        expect(result.total).toBe(13);
        expect(result.adventure.state.clocks.bell).toBe(1);
        expect(result.outcomeText).toMatch(/bell didn't fall/i);

        // once: true - the option is gone now
        const { adventure, quest } = { adventure: service.getAdventure(id), quest: require('@goobster/core/services/tavern/questLoader').getQuest('missing-bell-of-brinewatch') };
        expect(service.availableOptions(adventure, quest).map(o => o.key)).not.toContain('question-pell');
        // spotlight rotated to Bob
        expect(service.spotlightUser(adventure)).toBe(BOB);
    });

    test('a failed check hurts, offers a Spark reroll, and the reroll carries through', () => {
        // Bob climbs the tower: d20(5) + finesse(0) = 5 vs 13 -> fail (damage 1)
        // Spark reroll: d20(19) + 0 = 19 -> success (bell +1)
        const service = new AdventureService(rollQueue(5, 19));
        const id = startBrinewatch(service);

        const fail = service.chooseOption(id, BOB, 'climb-tower');
        expect(fail.success).toBe(false);
        expect(fail.canReroll).toBe(true);
        expect(characterService.getCharacter(GUILD, BOB).health).toBe(9);

        const reroll = service.sparkReroll(id, BOB);
        expect(reroll.success).toBe(true);
        expect(reroll.adventure.state.clocks.bell).toBe(1);
        // Spark spent; the first failure's cost stands
        expect(characterService.getCharacter(GUILD, BOB).spark).toBe(0);
        expect(characterService.getCharacter(GUILD, BOB).health).toBe(9);
        // No chaining rerolls
        expect(() => service.sparkReroll(id, BOB)).toThrow(TavernError);
    });

    test('natural 20 and natural 1 both feed the Spark economy', () => {
        // Alice nat-20s Pell (spark +1), Bob nat-1s the tide study
        // (spark +1 AND the danger clock ticks).
        const service = new AdventureService(rollQueue(20, 1));
        const id = startBrinewatch(service);

        const crit = service.chooseOption(id, ALICE, 'question-pell');
        expect(crit.success).toBe(true);
        expect(characterService.getCharacter(GUILD, ALICE).spark).toBe(2);

        const fumble = service.chooseOption(id, BOB, 'study-tide');
        expect(fumble.success).toBe(false);
        expect(characterService.getCharacter(GUILD, BOB).spark).toBe(2);
        expect(fumble.adventure.state.clocks.collapse).toBe(1);
    });

    test('travel options move the scene without a roll', () => {
        const service = new AdventureService(rollQueue());
        const id = startBrinewatch(service);

        const result = service.chooseOption(id, ALICE, 'to-chapel');
        expect(result.kind).toBe('travel');
        expect(result.sceneChanged).toBe(true);
        expect(result.adventure.sceneId).toBe('chapel');
    });

    test('the big move turns a doomed check into a success, once per adventure', () => {
        const service = new AdventureService(rollQueue(2));
        const id = startBrinewatch(service);
        service.chooseOption(id, ALICE, 'to-chapel');

        service.useBigMove(id, BOB);
        expect(() => service.useBigMove(id, BOB)).toThrow(/already happened/);

        // d20(2) + might(3) = 5 vs 13 would fail - but the big move says no
        const result = service.chooseOption(id, BOB, 'ram-door');
        expect(result.auto).toBe(true);
        expect(result.success).toBe(true);
        expect(result.sceneChanged).toBe(true);
        expect(result.adventure.sceneId).toBe('crypt');
    });

    test('item bonuses declared by the campaign apply to the right option', () => {
        const service = new AdventureService(rollQueue(11));
        const id = startBrinewatch(service);
        service.chooseOption(id, ALICE, 'to-chapel');
        db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'crypt', id });

        // The hymnal grants +2 on sing-hymn: d20(11) + wits(2) + 2 = 15 >= 13
        const alice = characterService.getCharacter(GUILD, ALICE);
        characterService.addItem(alice.id, 'Waterlogged Hymnal');
        const result = service.chooseOption(id, ALICE, 'sing-hymn');
        expect(result.bonus).toBe(2);
        expect(result.total).toBe(15);
        expect(result.success).toBe(true);
        expect(result.adventure.sceneId).toBe('finale');
        expect(result.adventure.state.flags.maren).toBe('singing');
    });
});

describe('endings, rewards, and recaps', () => {
    test('a chosen ending completes the adventure and pays the party', () => {
        const service = new AdventureService(rollQueue(10, 13));
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        service.begin(adventure.id, ALICE);

        service.chooseOption(adventure.id, ALICE, 'to-chapel');
        // Bob knocks politely: 10 + heart(1) = 11 vs 10 -> success (+1 spark, bell +1)
        service.chooseOption(adventure.id, BOB, 'knock-politely');
        db.run('UPDATE tavern_adventures SET sceneId = @s WHERE id = @id', { s: 'crypt', id: adventure.id });
        // Alice parleys: 13 + heart(3) = 16 vs 16 -> success, to the finale
        const parley = service.chooseOption(adventure.id, ALICE, 'parley');
        expect(parley.adventure.sceneId).toBe('finale');

        const ended = service.chooseOption(adventure.id, BOB, 'hang-bell');
        expect(ended.ended.endingId).toBe('hang-bell');

        const finished = service.getAdventure(adventure.id);
        expect(finished.status).toBe('COMPLETED');
        expect(finished.endingId).toBe('hang-bell');

        for (const userId of [ALICE, BOB]) {
            const character = characterService.getCharacter(GUILD, userId);
            expect(character.milestones).toBe(1);
            expect(character.adventuresCompleted).toBe(1);
            expect(character.health).toBe(character.maxHealth);
            expect(character.inventory).toContain('Brinewatch Bell-Rope');
        }

        const recap = service.getLatestRecap(GUILD, CHANNEL);
        expect(recap.questId).toBe('missing-bell-of-brinewatch');
        expect(recap.content).toMatch(/The Missing Bell of Brinewatch/);
        expect(recap.content).toMatch(/The Bell Comes Home/);
        expect(recap.content).toMatch(/Alice Vell, Bob the Door/);
    });

    test('a danger clock filling forces its ending', () => {
        const service = new AdventureService(rollQueue(2));
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'rat-problem', userId: ALICE });
        service.begin(adventure.id, ALICE);

        // Marnie's patience is nearly gone; one more freeform fumble fills it
        const state = service.getAdventure(adventure.id).state;
        state.clocks.patience = 3;
        db.run('UPDATE tavern_adventures SET state = @state WHERE id = @id', { state, id: adventure.id });

        const result = service.freeform(adventure.id, ALICE, 'I juggle the union minutes');
        expect(result.success).toBe(false);
        expect(result.ended.endingId).toBe('walkout');
        expect(service.getAdventure(adventure.id).status).toBe('COMPLETED');
        // The walkout has no trophy - but the hearth still restores and rewards
        const alice = characterService.getCharacter(GUILD, ALICE);
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

    test('success advances the progress clock, failure ticks danger', () => {
        const service = new AdventureService(rollQueue(18, 2));
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        service.begin(adventure.id, ALICE);

        // 18 + wits(2) = 20 vs default 13 -> success -> bell +1
        const win = service.freeform(adventure.id, ALICE, 'I examine the tide charts');
        expect(win.success).toBe(true);
        expect(win.adventure.state.clocks.bell).toBe(1);
        expect(win.outcomeText).toMatch(/secrets/);

        // 2 + might(3) = 5 vs 13 -> failure -> collapse +1
        const loss = service.freeform(adventure.id, BOB, 'I ram the tower');
        expect(loss.success).toBe(false);
        expect(loss.adventure.state.clocks.collapse).toBe(1);
    });

    test('an AI interpretation is honored but clamped to real stats/DCs', () => {
        const service = new AdventureService(rollQueue(10));
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        service.begin(adventure.id, ALICE);

        const result = service.freeform(adventure.id, ALICE, 'I charm the warden', { stat: 'heart', dc: 12 });
        expect(result.stat).toBe('heart');
        expect(result.dc).toBe(12);
        expect(result.total).toBe(13);

        const bogus = service.freeform(adventure.id, BOB, 'I do the thing', { stat: 'charisma', dc: 999 });
        expect(['might', 'finesse', 'wits', 'heart']).toContain(bogus.stat);
        expect(bogus.dc).toBe(13);
    });

    test('non-members cannot act', () => {
        const service = new AdventureService(rollQueue());
        const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: ALICE });
        service.join(adventure.id, BOB);
        service.begin(adventure.id, ALICE);
        expect(() => service.freeform(adventure.id, EVE, 'I heckle from the bar')).toThrow(/not in this party/);
        expect(() => service.chooseOption(adventure.id, EVE, 'question-pell')).toThrow(/not in this party/);
    });
});
