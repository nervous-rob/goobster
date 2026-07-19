/**
 * Unit tests for the table manager (services/tableGames/tableManager.js):
 * money escrow through the economy ledger, atomic commit + journal, crash
 * recovery refunds, and subscriber broadcasting - against a throwaway
 * SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tables-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const economyService = require('../services/economyService');
const { TableManager } = require('../services/tableGames/tableManager');

const GUILD = '700000000000000001';
const CHANNEL = '700000000000000002';
const ALICE = '700000000000000011';
const BOB = '700000000000000012';

// Identity shuffle: deck pops A♣, K♣, Q♣, J♣, 10♣, 9♣ ... deterministically
const identityRng = () => 0.999999;

let manager;

beforeEach(() => {
    db.run('DELETE FROM economy_wallets');
    db.run('DELETE FROM economy_transactions');
    db.run('DELETE FROM economy_settings');
    db.run('DELETE FROM table_games');
    manager = new TableManager();
});

afterEach(() => {
    manager.stop();
    jest.restoreAllMocks();
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

function subscriberFor(userId, name) {
    const messages = [];
    return { userId, name, send: m => messages.push(m), messages };
}

describe('escrow and settlement through the ledger', () => {
    test('a bet debits immediately; the payout credits on settle', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        // Force deterministic dealing inside the engine via a patched applyAction
        const engine = table.engine;
        const original = engine.applyAction.bind(engine);
        jest.spyOn(engine, 'applyAction').mockImplementation((state, action) => original(state, action, identityRng));

        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);

        // Identity shuffle deals Alice a natural blackjack (A+Q) vs dealer 20:
        // bet 100 escrowed, settle pays 250 back in the same commit chain
        manager.act({ table, userId: ALICE, action: 'bet', amount: 100 });
        expect(table.state.phase).toBe('settled');
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1150);

        const types = economyService.getHistory({ guildId: GUILD, userId: ALICE, limit: 5 }).map(r => r.type);
        expect(types).toContain('table-blackjack-bet');
        expect(types).toContain('table-blackjack-payout');
    });

    test('a bet the player cannot cover is rejected and nothing commits', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });

        expect(() => manager.act({ table, userId: ALICE, action: 'bet', amount: 5000 }))
            .toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));

        // State did not advance, the balance is untouched, and no table rows
        // hit the ledger (the whole commit - including the lazy wallet
        // creation - rolled back)
        expect(table.state.phase).toBe('waiting');
        expect(table.state.seats[0].bet).toBe(0);
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);
        const tableRows = economyService.getHistory({ guildId: GUILD, userId: ALICE })
            .filter(row => row.type.startsWith('table-'));
        expect(tableRows).toHaveLength(0);
    });

    test('leaving before the deal refunds the escrow', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        manager.act({ table, userId: BOB, name: 'Bob', action: 'sit' });
        manager.act({ table, userId: ALICE, action: 'bet', amount: 200 });
        expect(economyService.getBalance(GUILD, ALICE)).toBe(800);

        manager.act({ table, userId: ALICE, action: 'leave' });
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);
    });
});

describe('journal and crash recovery', () => {
    test('live state is journaled on every commit', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });

        const row = db.get('SELECT state, gameType FROM table_games WHERE guildId = @g', { g: GUILD });
        expect(row.gameType).toBe('blackjack');
        expect(JSON.parse(row.state).seats[0].userId).toBe(ALICE);
    });

    test('recovery refunds escrowed bets from an unfinished hand', () => {
        // Simulate a crash: a journaled acting-phase state with 150 escrowed
        economyService.adjust({ guildId: GUILD, userId: ALICE, amount: -150, type: 'table-blackjack-bet' });
        const engine = require('../services/tableGames/blackjack');
        const state = engine.createTable();
        state.phase = 'acting';
        state.seats[0] = { userId: ALICE, name: 'Alice', bet: 150, totalWagered: 150, hand: [], doubled: false, standing: false, busted: false, blackjack: false, left: false, outcome: null, payout: null };
        db.run(
            `INSERT INTO table_games (guildId, channelId, gameType, state) VALUES (@g, @c, 'blackjack', @s)`,
            { g: GUILD, c: CHANNEL, s: JSON.stringify(state) }
        );
        const balanceBefore = economyService.getBalance(GUILD, ALICE);

        const fresh = new TableManager();
        const result = fresh.recoverFromJournal();

        expect(result).toEqual({ tables: 1, refunds: 1 });
        expect(economyService.getBalance(GUILD, ALICE)).toBe(balanceBefore + 150);
        expect(db.all('SELECT * FROM table_games')).toHaveLength(0);
    });

    test('closing a table refunds escrow and clears the journal', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
        manager.act({ table, userId: BOB, name: 'Bob', action: 'sit' });
        manager.act({ table, userId: ALICE, action: 'bet', amount: 300 }); // betting phase, escrowed

        manager.closeTable(table);
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);
        expect(db.all('SELECT * FROM table_games')).toHaveLength(0);
        expect(manager.tables.size).toBe(0);
    });
});

describe('subscribers', () => {
    test('subscribers get an initial state and per-user update views', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        const alice = subscriberFor(ALICE, 'Alice');
        const bob = subscriberFor(BOB, 'Bob');
        manager.subscribe(table, alice);
        manager.subscribe(table, bob);

        expect(alice.messages[0].type).toBe('state');

        manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit', seat: 1 });

        const aliceUpdate = alice.messages.at(-1);
        const bobUpdate = bob.messages.at(-1);
        expect(aliceUpdate.type).toBe('update');
        expect(aliceUpdate.events).toContainEqual(expect.objectContaining({ type: 'sit', seat: 1 }));
        expect(aliceUpdate.view.yourSeat).toBe(1);
        expect(bobUpdate.view.yourSeat).toBeNull();
    });

    test('unsubscribing stops updates', () => {
        const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
        const alice = subscriberFor(ALICE, 'Alice');
        const unsubscribe = manager.subscribe(table, alice);
        unsubscribe();
        const count = alice.messages.length;
        manager.act({ table, userId: BOB, name: 'Bob', action: 'sit' });
        expect(alice.messages).toHaveLength(count);
    });
});

describe('timers', () => {
    test('the engine-declared timer fires the system action', async () => {
        jest.useFakeTimers();
        try {
            const table = manager.getTable({ guildId: GUILD, channelId: CHANNEL });
            const engine = table.engine;
            const original = engine.applyAction.bind(engine);
            jest.spyOn(engine, 'applyAction').mockImplementation((state, action) => original(state, action, identityRng));

            manager.act({ table, userId: ALICE, name: 'Alice', action: 'sit' });
            manager.act({ table, userId: BOB, name: 'Bob', action: 'sit' });
            manager.act({ table, userId: ALICE, action: 'bet', amount: 100 });
            expect(table.state.phase).toBe('betting');
            expect(table.timer).not.toBeNull();

            // The 20s betting window elapses -> the system deals without Bob
            jest.advanceTimersByTime(21000);
            expect(['acting', 'settled']).toContain(table.state.phase);
            expect(table.state.seats[0].hand.length).toBeGreaterThanOrEqual(2);
            expect(table.state.seats[1].hand).toHaveLength(0); // Bob sat out
        } finally {
            jest.useRealTimers();
        }
    });
});
