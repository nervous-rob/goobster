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
        config: { activity: { bot: { enabled: true } } },
        logger: { info() {}, warn() {}, error() {} },
        actDelayMs: 0,
        commentCooldownMs: 0,
        rng: () => 0.99, // no random bluffs/comments unless forced
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
        const blackjack = manager.getTable({ guildId: GUILD, channelId: '800000000000000003', gameType: 'blackjack' });
        expect(() => bot.invite(blackjack)).toThrow(expect.objectContaining({ code: 'BOT_UNSUPPORTED' }));

        const table = holdemTable();
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        bot.invite(table);
        expect(() => bot.invite(table)).toThrow(expect.objectContaining({ code: 'BOT_ALREADY_SEATED' }));
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

describe('decision legalization and heuristics', () => {
    const advisor = ADVISORS.holdem;
    const baseView = {
        gameType: 'holdem', street: 'flop', minBet: 10, maxBet: 10000,
        currentBet: 50, toCall: 50, pot: 120, yourSeat: 0, community: [],
        seats: [{ seat: 0, cards: [], totalWagered: 10, streetBet: 0 }]
    };

    test('nonsense actions collapse to safe ones', () => {
        expect(advisor.legalize({ action: 'jump' }, baseView)).toEqual({ action: 'fold', amount: null });
        expect(advisor.legalize({ action: 'check' }, baseView)).toEqual({ action: 'fold', amount: null });
        expect(advisor.legalize({ action: 'call' }, { ...baseView, currentBet: 0, toCall: 0 }))
            .toEqual({ action: 'check', amount: null });
        expect(advisor.legalize({ action: 'raise', amount: 999999 }, baseView))
            .toEqual({ action: 'raise', amount: 10000 });
    });

    test('preflop strength ratings make sense', () => {
        const c = (rank, suit = 'S') => ({ rank, suit });
        expect(holdemStrength([c(14), c(14, 'H')], [])).toBe(2);  // aces
        expect(holdemStrength([c(13), c(12, 'H')], [])).toBe(2);  // KQ
        expect(holdemStrength([c(9), c(8)], [])).toBe(1);         // suited connectors
        expect(holdemStrength([c(7), c(2, 'H')], [])).toBe(0);    // junk
    });
});
