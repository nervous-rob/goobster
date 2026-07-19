/**
 * Unit tests for the point-currency economy (services/economyService.js)
 * against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-economy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const economyService = require('../services/economyService');
const { EconomyError } = require('../services/economyService');

const GUILD = '300000000000000001';
const ALICE = '300000000000000002';
const BOB = '300000000000000003';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    db.run('DELETE FROM economy_wallets');
    db.run('DELETE FROM economy_transactions');
    db.run('DELETE FROM economy_settings');
});

describe('settings', () => {
    test('defaults apply when nothing is configured', () => {
        const settings = economyService.getSettings(GUILD);
        expect(settings).toEqual({ currencyName: 'points', startingBalance: 1000, dailyAmount: 100 });
    });

    test('currency can be renamed (e.g. "Jimmy points")', () => {
        economyService.setCurrencyName(GUILD, 'Jimmy points');
        expect(economyService.getSettings(GUILD).currencyName).toBe('Jimmy points');
    });

    test('rejects blank and over-long names', () => {
        expect(() => economyService.setCurrencyName(GUILD, '   ')).toThrow(EconomyError);
        expect(() => economyService.setCurrencyName(GUILD, 'x'.repeat(33))).toThrow(EconomyError);
    });

    test('amounts are configurable and preserved across partial updates', () => {
        economyService.setCurrencyName(GUILD, 'doubloons');
        economyService.setAmounts({ guildId: GUILD, startingBalance: 500 });
        economyService.setAmounts({ guildId: GUILD, dailyAmount: 25 });
        expect(economyService.getSettings(GUILD)).toEqual({
            currencyName: 'doubloons', startingBalance: 500, dailyAmount: 25
        });
    });
});

describe('wallets and ledger', () => {
    test('first touch grants the starting balance and records it', () => {
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);
        const history = economyService.getHistory({ guildId: GUILD, userId: ALICE });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ amount: 1000, balanceAfter: 1000, type: 'starting-balance' });
    });

    test('adjust moves the balance and appends to the ledger', () => {
        economyService.getWallet(GUILD, ALICE);
        const balance = economyService.adjust({ guildId: GUILD, userId: ALICE, amount: -300, type: 'test' });
        expect(balance).toBe(700);
        expect(economyService.getHistory({ guildId: GUILD, userId: ALICE })[0])
            .toMatchObject({ amount: -300, balanceAfter: 700, type: 'test' });
    });

    test('balances can never go negative', () => {
        economyService.getWallet(GUILD, ALICE);
        expect(() => economyService.adjust({ guildId: GUILD, userId: ALICE, amount: -1001, type: 'test' }))
            .toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);
    });

    test('non-integer amounts are rejected', () => {
        expect(() => economyService.adjust({ guildId: GUILD, userId: ALICE, amount: 1.5, type: 'test' }))
            .toThrow(expect.objectContaining({ code: 'BAD_AMOUNT' }));
    });
});

describe('transfer', () => {
    test('moves points atomically between users', () => {
        const { fromBalance, toBalance } = economyService.transfer({
            guildId: GUILD, fromUserId: ALICE, toUserId: BOB, amount: 400
        });
        expect(fromBalance).toBe(600);
        expect(toBalance).toBe(1400);
    });

    test('rejects self-transfers, bad amounts, and overdrafts', () => {
        expect(() => economyService.transfer({ guildId: GUILD, fromUserId: ALICE, toUserId: ALICE, amount: 1 }))
            .toThrow(expect.objectContaining({ code: 'SELF_TRANSFER' }));
        expect(() => economyService.transfer({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, amount: 0 }))
            .toThrow(expect.objectContaining({ code: 'BAD_AMOUNT' }));
        expect(() => economyService.transfer({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, amount: 99999 }))
            .toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
        // Failed transfer must not move anything
        expect(economyService.getBalance(GUILD, ALICE)).toBe(1000);
        expect(economyService.getBalance(GUILD, BOB)).toBe(1000);
    });
});

describe('daily claim', () => {
    test('claims once, then hits the 24h cooldown', () => {
        const { amount, balance } = economyService.claimDaily(GUILD, ALICE);
        expect(amount).toBe(100);
        expect(balance).toBe(1100);
        expect(() => economyService.claimDaily(GUILD, ALICE))
            .toThrow(expect.objectContaining({ code: 'DAILY_COOLDOWN' }));
    });

    test('is claimable again after the cooldown elapses', () => {
        economyService.claimDaily(GUILD, ALICE);
        db.run(`UPDATE economy_wallets SET lastDailyAt = datetime('now', '-25 hours') WHERE userId = @u`, { u: ALICE });
        expect(economyService.claimDaily(GUILD, ALICE).balance).toBe(1200);
    });

    test('a zero daily amount disables claims', () => {
        economyService.setAmounts({ guildId: GUILD, dailyAmount: 0 });
        expect(() => economyService.claimDaily(GUILD, ALICE))
            .toThrow(expect.objectContaining({ code: 'DAILY_DISABLED' }));
    });
});

describe('leaderboard', () => {
    test('orders wallets by balance', () => {
        economyService.getWallet(GUILD, ALICE);
        economyService.getWallet(GUILD, BOB);
        economyService.adjust({ guildId: GUILD, userId: BOB, amount: 500, type: 'test' });
        const rows = economyService.leaderboard(GUILD);
        expect(rows.map(r => r.userId)).toEqual([BOB, ALICE]);
    });
});
