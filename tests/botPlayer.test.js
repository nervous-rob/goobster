/**
 * Tests for Goobster the table-game player (services/tableGames/botPlayer.js):
 * inviting/dismissing, AI-driven decisions (mocked aiService), heuristic
 * fallback when no provider is available, illegal-decision repair, table
 * talk delivery, and self-dismissal when left alone - against a real
 * TableManager on a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-botplayer-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/aiService', () => ({
    chat: jest.fn(),
    chatText: jest.fn(),
    generateText: jest.fn()
}));

const db = require('../db');
const aiService = require('../services/aiService');
const economyService = require('../services/economyService');
const { TableManager } = require('../services/tableGames/tableManager');
const { BotPlayer, ADVISORS, holdemStrength } = require('../services/tableGames/botPlayer');

const GUILD = '800000000000000001';
const CHANNEL = '800000000000000002';
const ALICE = '800000000000000011';
const BOT_ID = '800000000000000099';

const identityRng = () => 0.999999;

const fakeClient = { user: { id: BOT_ID } };

let manager;
let bot;

function makeBot(overrides = {}) {
    return new BotPlayer({
        tableManager: manager,
        client: fakeClient,
        config: { activity: { bot: { enabled: true, voiceComments: false } } },
        logger: { info() {}, warn() {}, error() {} },
        actDelayMs: 0,
        commentCooldownMs: 0,
        rng: () => 0.99, // no random bluffs/comments unless forced
        voiceSessions: { getSession: () => null },
        getVoiceConnection: () => null,
        ...overrides
    });
}

function holdemTable() {
    const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL, gameType: 'holdem' });
    // Deterministic deals
    const original = table.engine.applyAction.bind(table.engine);
    jest.spyOn(table.engine, 'applyAction').mockImplementation((state, action) => original(state, action, identityRng));
    return table;
}

/** Wait for pending microtasks + zero-delay timers to run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

beforeEach(() => {
    db.run('DELETE FROM economy_wallets');
    db.run('DELETE FROM economy_transactions');
    db.run('DELETE FROM economy_settings');
    db.run('DELETE FROM table_games');
    jest.clearAllMocks();
    manager = new TableManager();
    bot = makeBot();
});

afterEach(() => {
    bot.stop();
    manager.stop();
    jest.restoreAllMocks();
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('inviting Goobster', () => {
    test('invite seats the bot with the bot flag and tops up a broke bankroll', () => {
        // Drain the bot's wallet below the buy-in threshold first
        economyService.getBalance(GUILD, BOT_ID); // creates the wallet at 1000
        economyService.adjust({ guildId: GUILD, userId: BOT_ID, amount: -900, type: 'test-drain' });

        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);

        const view = table.engine.getView(table.state, ALICE);
        const botSeat = view.seats.find(s => s && s.isBot);
        expect(botSeat).toBeTruthy();
        expect(botSeat.name).toBe('Goobster');
        expect(economyService.getBalance(GUILD, BOT_ID)).toBe(2100); // 100 + 2000 top-up
        const types = economyService.getHistory({ guildId: GUILD, userId: BOT_ID, limit: 5 }).map(r => r.type);
        expect(types).toContain('bot-bankroll');
    });

    test('unsupported games and double invites are rejected', () => {
        const fakeTable = { key: 'fake', guildId: GUILD, engine: { gameType: 'craps' } };
        expect(() => bot.invite(fakeTable)).toThrow(expect.objectContaining({ code: 'BOT_UNSUPPORTED' }));

        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        expect(() => bot.invite(table)).toThrow(expect.objectContaining({ code: 'BOT_ALREADY_SEATED' }));
    });

    test('every registered table game is supported', () => {
        for (const gameType of ['blackjack', 'roulette', 'baccarat', 'holdem']) {
            expect(bot.supports(gameType)).toBe(true);
        }
    });

    test('a disabled bot never sits', () => {
        const off = makeBot({ config: { activity: { bot: { enabled: false } } } });
        const table = holdemTable();
        expect(() => off.invite(table)).toThrow(expect.objectContaining({ code: 'BOT_DISABLED' }));
    });
});

describe('playing turns', () => {
    test('the bot acts on its turn using the AI decision', async () => {
        aiService.chatText.mockResolvedValue('{"action": "call", "comment": "I smell weakness."}');
        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);

        // Watch what a human client would see (chat + updates)
        const inbox = [];
        manager.subscribe(table, { userId: ALICE, name: 'Alice', send: m => inbox.push(m) });

        // Deal: heads-up, button acts first. Keep acting until it's the bot.
        manager.act({ table, userId: ALICE, action: 'deal' });
        if (table.state.activeSeat !== null && table.state.seats[table.state.activeSeat].userId === ALICE) {
            manager.act({ table, userId: ALICE, action: 'call' });
        }
        await settle();

        // The AI was consulted with full metadata and the bot called/checked
        expect(aiService.chatText).toHaveBeenCalled();
        const prompt = aiService.chatText.mock.calls[0][0].find(m => m.role === 'user').content;
        expect(prompt).toContain('yourHoleCards');
        expect(prompt).toContain('"pot"');

        // The bot's preflop action closed the round (street advanced or the
        // hand kept moving through further bot checks)
        expect(table.state.street).not.toBe('preflop');
        // Table talk reached the human subscriber
        expect(inbox).toContainEqual(expect.objectContaining({ type: 'chat', bot: true, text: 'I smell weakness.' }));
    });

    test('an illegal AI decision is repaired before acting', async () => {
        // Raise below the minimum gets clamped up to the legal floor
        aiService.chatText.mockResolvedValue('{"action": "raise", "amount": 3}');
        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        manager.act({ table, userId: ALICE, action: 'deal' });
        if (table.state.seats[table.state.activeSeat].userId === ALICE) {
            manager.act({ table, userId: ALICE, action: 'call' });
        }
        await settle();

        expect(table.state.currentBet).toBe(20); // minBet 10 -> min raise-to 20
    });

    test('without an AI provider the heuristic fallback still plays', async () => {
        aiService.chatText.mockRejectedValue(new Error('no provider configured'));
        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        manager.act({ table, userId: ALICE, action: 'deal' });
        if (table.state.activeSeat !== null && table.state.seats[table.state.activeSeat].userId === ALICE) {
            manager.act({ table, userId: ALICE, action: 'call' });
        }
        await settle();

        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        // Whatever the heuristic chose, the bot is no longer holding up the hand
        expect(botSeat.acted || botSeat.folded || table.state.phase !== 'acting').toBe(true);
    });

    test('the bot leaves once the last human stands up', async () => {
        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        expect(bot.isAtTable(table)).toBe(true);

        manager.act({ table, userId: ALICE, action: 'leave' });
        await settle();

        expect(bot.isAtTable(table)).toBe(false);
        expect(table.engine.isEmpty(table.state)).toBe(true);
    });
});

describe('playing the other table games', () => {
    function gameTable(gameType, channelId) {
        const table = manager.getTable({ guildId: GUILD, channelId, gameType });
        const original = table.engine.applyAction.bind(table.engine);
        jest.spyOn(table.engine, 'applyAction').mockImplementation((state, action) => original(state, action, identityRng));
        return table;
    }

    test('blackjack: the model has full control of bet sizing and hand actions', async () => {
        // A reckless persona bets big; the model's exact choices are obeyed
        const wildBot = makeBot({ config: { activity: { bot: { enabled: true, voiceComments: false, persona: 'an absolutely reckless gambler' } } } });
        aiService.chatText
            .mockResolvedValueOnce('{"action": "bet", "amount": 444, "comment": "MAX POWER"}') // betting window
            .mockResolvedValueOnce('{"action": "stand", "comment": "these cards are art"}');   // hand action

        const table = gameTable('blackjack', '800000000000000020');
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        wildBot.invite(table);

        const inbox = [];
        manager.subscribe(table, { userId: ALICE, name: 'Alice', send: m => inbox.push(m) });

        manager.act({ table, userId: ALICE, action: 'bet', amount: 100 });
        await settle();

        // The model's bet amount landed as-is (within table limits)
        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        expect(botSeat.totalWagered).toBe(444);
        expect(table.state.phase).toBe('settled');
        expect(botSeat.outcome).toBe('win'); // stood on K+10=20 vs dealer 19

        // The persona was injected into the decision prompt, along with the
        // full game state and the player's options
        const [messages] = aiService.chatText.mock.calls[0];
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('an absolutely reckless gambler');
        expect(messages[1].content).toContain('"minBet"');
        expect(messages[1].content).toContain('"action": "bet" | "pass"');
        const [actMessages] = aiService.chatText.mock.calls[1];
        expect(actMessages[1].content).toContain('"yourHand"');
        expect(actMessages[1].content).toContain('dealerShowing');

        expect(inbox).toContainEqual(expect.objectContaining({ type: 'chat', text: 'MAX POWER' }));
        wildBot.stop();
    });

    test('roulette: the model can spread several bets in one window', async () => {
        aiService.chatText.mockResolvedValueOnce(
            '{"bets": [{"kind": "red", "amount": 30}, {"kind": "straight", "target": 7, "amount": 15}], "comment": "chaos time"}'
        );
        const table = gameTable('roulette', '800000000000000026');
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        manager.act({ table, userId: ALICE, action: 'bet', amount: 50, kind: 'black' });
        await settle();

        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        expect(botSeat.bets).toEqual([
            expect.objectContaining({ kind: 'red', amount: 30 }),
            expect.objectContaining({ kind: 'straight', target: 7, amount: 15 })
        ]);
        expect(botSeat.totalWagered).toBe(45);
    });

    test('a pass decision sits the round out', async () => {
        aiService.chatText.mockResolvedValueOnce('{"action": "pass", "comment": "not feeling it"}');
        const table = gameTable('baccarat', '800000000000000027');
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        manager.act({ table, userId: ALICE, action: 'bet', amount: 50, target: 'player' });
        await settle();

        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        expect(botSeat.bet).toBe(0);
        expect(aiService.chatText).toHaveBeenCalledTimes(1); // no retry loop
    });

    test('blackjack: the fallback strategy plays when no provider answers', async () => {
        const table = gameTable('blackjack', '800000000000000021');
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);

        // The bot never leads: no bet while the table is idle
        await settle();
        expect(table.state.seats.find(s => s && s.userId === BOT_ID).bet).toBe(0);

        // Alice opens the betting window; the bot follows and the hand deals.
        // Identity shuffle: Alice A♣+J♣ (blackjack), bot K♣+10♣ (20),
        // dealer Q♣+9♣ (19) - the bot stands on 20 and wins.
        manager.act({ table, userId: ALICE, action: 'bet', amount: 100 });
        await settle();

        expect(table.state.phase).toBe('settled');
        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        expect(botSeat.bet).toBeGreaterThan(0);
        expect(botSeat.outcome).toBe('win');
        const types = economyService.getHistory({ guildId: GUILD, userId: BOT_ID, limit: 10 }).map(r => r.type);
        expect(types).toContain('table-blackjack-bet');
        expect(types).toContain('table-blackjack-payout');
    });

    test('roulette: the bot places a bet once a human has chips down', async () => {
        const table = gameTable('roulette', '800000000000000022');
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        manager.act({ table, userId: ALICE, action: 'bet', amount: 50, kind: 'red' });
        await settle();

        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        expect(botSeat.totalWagered).toBeGreaterThan(0);
        expect(botSeat.bets).toHaveLength(1);

        // Alice spins; everyone settles in one commit
        manager.act({ table, userId: ALICE, action: 'spin' });
        expect(table.state.phase).toBe('settled');
        expect(botSeat.userId).toBe(BOT_ID); // seat survived settlement
    });

    test('baccarat: the bot bets a side and the round settles', async () => {
        const table = gameTable('baccarat', '800000000000000023');
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        manager.act({ table, userId: ALICE, action: 'bet', amount: 50, target: 'player' });
        await settle();

        // The bot's bet completed the table, so the round dealt and settled
        expect(table.state.phase).toBe('settled');
        const botSeat = table.state.seats.find(s => s && s.userId === BOT_ID);
        expect(['player', 'banker', 'tie']).toContain(botSeat.target);
        expect(botSeat.bet).toBeGreaterThan(0);
        expect(botSeat.outcome).toBeTruthy();
    });
});

describe('voice comments', () => {
    test('table talk is spoken through an existing voice connection', async () => {
        const tts = { textToSpeech: jest.fn().mockResolvedValue(undefined), disabled: false };
        const connection = { joinConfig: { channelId: 'vc-1' } };
        const voiceBot = makeBot({
            config: { activity: { bot: { enabled: true, voiceComments: true } } },
            getVoiceConnection: () => connection,
            ttsService: tts,
            client: { user: { id: BOT_ID }, channels: { cache: new Map([['vc-1', { name: 'casino-vc' }]]) } }
        });

        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        voiceBot.invite(table); // the join line goes out through _say

        expect(tts.textToSpeech).toHaveBeenCalledTimes(1);
        const [text, channel, conn] = tts.textToSpeech.mock.calls[0];
        expect(typeof text).toBe('string');
        expect(channel).toEqual({ name: 'casino-vc' });
        expect(conn).toBe(connection);
        voiceBot.stop();
    });

    test('a live voicechat session takes precedence and is reused', () => {
        const sessionTts = { textToSpeech: jest.fn().mockResolvedValue(undefined) };
        const session = { ttsService: sessionTts, voiceChannel: { name: 'vc' }, connection: {} };
        const voiceBot = makeBot({
            config: { activity: { bot: { enabled: true, voiceComments: true } } },
            voiceSessions: { getSession: () => session },
            getVoiceConnection: () => { throw new Error('should not be reached'); }
        });

        const table = manager.getTable({ guildId: GUILD, channelId: '800000000000000024', gameType: 'holdem' });
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        voiceBot.invite(table);

        expect(sessionTts.textToSpeech).toHaveBeenCalledTimes(1);
        expect(sessionTts.textToSpeech.mock.calls[0][1]).toEqual({ name: 'vc' });
        voiceBot.stop();
    });

    test('no voice connection means no voice comment (and no crash)', () => {
        const voiceBot = makeBot({
            config: { activity: { bot: { enabled: true, voiceComments: true } } },
            getVoiceConnection: () => null
        });
        const table = manager.getTable({ guildId: GUILD, channelId: '800000000000000025', gameType: 'holdem' });
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        expect(() => voiceBot.invite(table)).not.toThrow();
        voiceBot.stop();
    });
});

describe('hidden-card hygiene', () => {
    const holdemView = (cards) => ({
        gameType: 'holdem', phase: 'acting', street: 'preflop', yourSeat: 0, activeSeat: 0,
        minBet: 10, maxBet: 10000, currentBet: 10, toCall: 5, pot: 15, community: [],
        seats: [{ seat: 0, cards, totalWagered: 5, streetBet: 5, cardCount: 2 }]
    });
    const hole = [
        { rank: 10, suit: 'H', label: '10♥️' },
        { rank: 4, suit: 'S', label: '4♠️' }
    ];

    test('comments naming the hole cards are dropped', () => {
        const s = ADVISORS.holdem.sanitizeComment;
        expect(s('Goobster tosses the 10-4 into the muck. Too cute.', holdemView(hole))).toBeNull();
        expect(s('a TEN?! why did I keep that', holdemView(hole))).toBeNull();
        expect(s('four is my lucky number', holdemView(hole))).toBeNull();
        expect(s('10♥️ 4♠️ says hello', holdemView(hole))).toBeNull();
    });

    test('hand-strength talk is dropped even without naming cards', () => {
        const s = ADVISORS.holdem.sanitizeComment;
        expect(s('tiny two-pair vibes, but I am just checking', holdemView(hole))).toBeNull();
        expect(s('flush draw baby, let it ride', holdemView(hole))).toBeNull();
        expect(s('pocket rockets do not fold', holdemView(hole))).toBeNull();
        expect(s('what a monster', holdemView(hole))).toBeNull();
    });

    test('harmless trash talk survives', () => {
        const s = ADVISORS.holdem.sanitizeComment;
        expect(s('Your chips look better on my side of the felt.', holdemView(hole)))
            .toBe('Your chips look better on my side of the felt.');
        expect(s('Raising to 40. Sweat it out, Alice. 😈', holdemView(hole)))
            .toBe('Raising to 40. Sweat it out, Alice. 😈');
        expect(s('The pot is at 15 and I want it.', holdemView(hole)))
            .toBe('The pot is at 15 and I want it.');
    });

    test('a leaking model comment never reaches the table', async () => {
        aiService.chatText.mockResolvedValue('{"action": "call", "comment": "folding my king-ten would be criminal"}');
        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);

        const inbox = [];
        manager.subscribe(table, { userId: ALICE, name: 'Alice', send: m => inbox.push(m) });

        manager.act({ table, userId: ALICE, action: 'deal' });
        if (table.state.activeSeat !== null && table.state.seats[table.state.activeSeat].userId === ALICE) {
            manager.act({ table, userId: ALICE, action: 'call' });
        }
        await settle();

        // The action went through, the leaky comment did not
        expect(aiService.chatText).toHaveBeenCalled();
        expect(inbox.filter(m => m.type === 'chat' && /king|ten/i.test(m.text))).toHaveLength(0);
    });
});

describe('decision legalization and heuristics', () => {
    const advisor = ADVISORS.holdem;
    const baseView = {
        gameType: 'holdem', street: 'flop', minBet: 10, maxBet: 10000,
        currentBet: 50, toCall: 50, pot: 120, yourSeat: 0, community: [],
        seats: [{ seat: 0, cards: [], totalWagered: 10, streetBet: 0 }]
    };

    test('nonsense actions collapse to safe ones', () => {
        expect(advisor.legalize({ action: 'jump' }, baseView)).toEqual({ actions: [{ action: 'fold', amount: null }] });
        expect(advisor.legalize({ action: 'check' }, baseView)).toEqual({ actions: [{ action: 'fold', amount: null }] });
        expect(advisor.legalize({ action: 'call' }, { ...baseView, currentBet: 0, toCall: 0 }))
            .toEqual({ actions: [{ action: 'check', amount: null }] });
        // Raises clamp to the table cap and come out as the engine's 'bet'
        expect(advisor.legalize({ action: 'raise', amount: 999999 }, baseView))
            .toEqual({ actions: [{ action: 'bet', amount: 10000 }] });
    });

    test('blackjack validator polices the options a player has', () => {
        const bj = ADVISORS.blackjack;
        const bettingView = { gameType: 'blackjack', phase: 'betting', minBet: 10, maxBet: 10000, yourSeat: 0, seats: [{ seat: 0, bet: 0 }] };
        expect(bj.legalize({ action: 'bet', amount: 999999 }, bettingView))
            .toEqual({ actions: [{ action: 'bet', amount: 10000 }] });
        expect(bj.legalize({ action: 'pass' }, bettingView)).toEqual({ pass: true });
        expect(bj.legalize({ action: 'dance' }, bettingView)).toBeNull();

        const actingView = {
            gameType: 'blackjack', phase: 'acting', minBet: 10, maxBet: 10000, yourSeat: 0, activeSeat: 0,
            dealer: { cards: [{ rank: 10, suit: 'S', label: '10♠️' }] },
            seats: [{ seat: 0, bet: 50, cards: [{}, {}, {}], doubled: false, total: 14, soft: false }]
        };
        // Doubling with three cards is off the table -> it means "hit"
        expect(bj.legalize({ action: 'double' }, actingView)).toEqual({ actions: [{ action: 'hit' }] });
        expect(bj.legalize({ action: 'stand' }, actingView)).toEqual({ actions: [{ action: 'stand' }] });
        expect(bj.legalize({ action: 'split' }, actingView)).toBeNull();
    });

    test('roulette validator keeps only legal bets and caps the count', () => {
        const view = { gameType: 'roulette', phase: 'betting', minBet: 10, maxBet: 10000, yourSeat: 0, seats: [{ seat: 0, totalWagered: 0 }], history: [] };
        const decision = ADVISORS.roulette.legalize({
            bets: [
                { kind: 'red', amount: 50 },
                { kind: 'straight', target: 99, amount: 20 },   // bad target - dropped
                { kind: 'corner', amount: 20 },                  // unknown kind - dropped
                { kind: 'dozen', target: 2, amount: 3 },         // clamped up to minBet
                { kind: 'straight', target: 17, amount: 999999 } // clamped down to maxBet
            ]
        }, view);
        expect(decision.actions).toEqual([
            { action: 'bet', kind: 'red', target: null, amount: 50 },
            { action: 'bet', kind: 'dozen', target: 2, amount: 10 },
            { action: 'bet', kind: 'straight', target: 17, amount: 10000 }
        ]);
        expect(ADVISORS.roulette.legalize({ action: 'pass' }, view)).toEqual({ pass: true });
        expect(ADVISORS.roulette.legalize({ bets: [{ kind: 'corner', amount: 5 }] }, view)).toBeNull();
    });

    test('baccarat validator enforces the three targets', () => {
        const view = { gameType: 'baccarat', phase: 'betting', minBet: 10, maxBet: 10000, yourSeat: 0, seats: [{ seat: 0, bet: 0 }] };
        expect(ADVISORS.baccarat.legalize({ action: 'bet', target: 'TIE', amount: 80 }, view))
            .toEqual({ actions: [{ action: 'bet', target: 'tie', amount: 80 }] });
        expect(ADVISORS.baccarat.legalize({ action: 'bet', target: 'dealer', amount: 80 }, view)).toBeNull();
        expect(ADVISORS.baccarat.legalize({ action: 'pass' }, view)).toEqual({ pass: true });
    });

    test('preflop strength ratings make sense', () => {
        const c = (rank, suit = 'S') => ({ rank, suit });
        expect(holdemStrength([c(14), c(14, 'H')], [])).toBe(2);  // aces
        expect(holdemStrength([c(13), c(12, 'H')], [])).toBe(2);  // KQ
        expect(holdemStrength([c(9), c(8)], [])).toBe(1);         // suited connectors
        expect(holdemStrength([c(7), c(2, 'H')], [])).toBe(0);    // junk
    });
});
