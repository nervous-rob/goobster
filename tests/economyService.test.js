/**
 * Unit tests for the point-currency economy (services/economyService.js)
 * against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-economy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const { EconomyError } = require('@goobster/core/services/economyService');

const GUILD = '300000000000000001';
const ALICE = '300000000000000002';
const BOB = '300000000000000003';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM economy_wallets');
    await db.run('DELETE FROM economy_transactions');
    await db.run('DELETE FROM economy_settings');
});

describe('settings', () => {
    test('defaults apply when nothing is configured', async () => {
        const settings = await economyService.getSettings(GUILD);
        expect(settings).toEqual({ currencyName: 'points', startingBalance: 1000, dailyAmount: 100 });
    });

    test('currency can be renamed (e.g. "Jimmy points")', async () => {
        await economyService.setCurrencyName(GUILD, 'Jimmy points');
        expect((await economyService.getSettings(GUILD)).currencyName).toBe('Jimmy points');
    });

    test('rejects blank and over-long names', async () => {
        await expect((async () => await economyService.setCurrencyName(GUILD, '   '))()).rejects.toThrow(EconomyError);
        await expect((async () => await economyService.setCurrencyName(GUILD, 'x'.repeat(33)))()).rejects.toThrow(EconomyError);
    });

    test('amounts are configurable and preserved across partial updates', async () => {
        await economyService.setCurrencyName(GUILD, 'doubloons');
        await economyService.setAmounts({ guildId: GUILD, startingBalance: 500 });
        await economyService.setAmounts({ guildId: GUILD, dailyAmount: 25 });
        expect(await economyService.getSettings(GUILD)).toEqual({
            currencyName: 'doubloons', startingBalance: 500, dailyAmount: 25
        });
    });
});

describe('wallets and ledger', () => {
    test('first touch grants the starting balance and records it', async () => {
        expect(await economyService.getBalance(GUILD, ALICE)).toBe(1000);
        const history = await economyService.getHistory({ guildId: GUILD, userId: ALICE });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ amount: 1000, balanceAfter: 1000, type: 'starting-balance' });
    });

    test('adjust moves the balance and appends to the ledger', async () => {
        await economyService.getWallet(GUILD, ALICE);
        const balance = await economyService.adjust({ guildId: GUILD, userId: ALICE, amount: -300, type: 'test' });
        expect(balance).toBe(700);
        expect((await economyService.getHistory({ guildId: GUILD, userId: ALICE }))[0])
            .toMatchObject({ amount: -300, balanceAfter: 700, type: 'test' });
    });

    test('balances can never go negative', async () => {
        await economyService.getWallet(GUILD, ALICE);
        await expect((async () => await economyService.adjust({ guildId: GUILD, userId: ALICE, amount: -1001, type: 'test' }))())
            .rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
        expect(await economyService.getBalance(GUILD, ALICE)).toBe(1000);
    });

    test('non-integer amounts are rejected', async () => {
        await expect((async () => await economyService.adjust({ guildId: GUILD, userId: ALICE, amount: 1.5, type: 'test' }))())
            .rejects.toThrow(expect.objectContaining({ code: 'BAD_AMOUNT' }));
    });
});

describe('transfer', () => {
    test('moves points atomically between users', async () => {
        const { fromBalance, toBalance } = await economyService.transfer({
            guildId: GUILD, fromUserId: ALICE, toUserId: BOB, amount: 400
        });
        expect(fromBalance).toBe(600);
        expect(toBalance).toBe(1400);
    });

    test('rejects self-transfers, bad amounts, and overdrafts', async () => {
        await expect((async () => await economyService.transfer({ guildId: GUILD, fromUserId: ALICE, toUserId: ALICE, amount: 1 }))())
            .rejects.toThrow(expect.objectContaining({ code: 'SELF_TRANSFER' }));
        await expect((async () => await economyService.transfer({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, amount: 0 }))())
            .rejects.toThrow(expect.objectContaining({ code: 'BAD_AMOUNT' }));
        await expect((async () => await economyService.transfer({ guildId: GUILD, fromUserId: ALICE, toUserId: BOB, amount: 99999 }))())
            .rejects.toThrow(expect.objectContaining({ code: 'INSUFFICIENT_FUNDS' }));
        // Failed transfer must not move anything
        expect(await economyService.getBalance(GUILD, ALICE)).toBe(1000);
        expect(await economyService.getBalance(GUILD, BOB)).toBe(1000);
    });
});

describe('daily claim', () => {
    test('claims once, then hits the 24h cooldown', async () => {
        const { amount, balance } = await economyService.claimDaily(GUILD, ALICE);
        expect(amount).toBe(100);
        expect(balance).toBe(1100);
        await expect((async () => await economyService.claimDaily(GUILD, ALICE))())
            .rejects.toThrow(expect.objectContaining({ code: 'DAILY_COOLDOWN' }));
    });

    test('is claimable again after the cooldown elapses', async () => {
        await economyService.claimDaily(GUILD, ALICE);
        await db.run(`UPDATE economy_wallets SET lastDailyAt = datetime('now', '-25 hours') WHERE userId = @u`, { u: ALICE });
        expect((await economyService.claimDaily(GUILD, ALICE)).balance).toBe(1200);
    });

    test('a zero daily amount disables claims', async () => {
        await economyService.setAmounts({ guildId: GUILD, dailyAmount: 0 });
        await expect((async () => await economyService.claimDaily(GUILD, ALICE))())
            .rejects.toThrow(expect.objectContaining({ code: 'DAILY_DISABLED' }));
    });
});

describe('leaderboard', () => {
    test('orders wallets by balance', async () => {
        await economyService.getWallet(GUILD, ALICE);
        await economyService.getWallet(GUILD, BOB);
        await economyService.adjust({ guildId: GUILD, userId: BOB, amount: 500, type: 'test' });
        const rows = await economyService.leaderboard(GUILD);
        expect(rows.map(r => r.userId)).toEqual([BOB, ALICE]);
    });
});
