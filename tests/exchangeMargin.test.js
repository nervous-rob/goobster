/**
 * Margin accounts, short selling, borrow costs, margin calls, and forced
 * liquidation, against a throwaway SQLite database with a mocked quote feed.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-margin-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const stockPortfolioService = require('@goobster/core/services/stockPortfolioService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const shortService = require('@goobster/core/services/exchange/shortService');
const RiskEngine = require('@goobster/core/services/exchange/riskEngine');

const GUILD = '600000000000000001';
const USER = '600000000000000002';

const PRICES = { AAPL: 200, TSLA: 100, MEME: 50 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('@goobster/core/services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return {
        symbol: resolved, name: `${resolved} Inc.`, price, currency: 'USD',
        asOf: '2026-07-29 00:00:00', cached: false, stale: false
    };
}

async function reset() {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings',
        'stock_trades', 'exchange_accounts', 'exchange_settings', 'short_positions',
        'exchange_events', 'exchange_orders', 'option_positions'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { AAPL: 200, TSLA: 100, MEME: 50 });
}

/** Give the user a wallet with an exact balance. */
async function fund(points) {
    await economyService.getWallet(GUILD, USER);
    await db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @guildId AND userId = @userId',
        { guildId: GUILD, userId: USER, points });
    await db.run('DELETE FROM economy_transactions WHERE guildId = @guildId AND userId = @userId',
        { guildId: GUILD, userId: USER });
    await db.run(
        `INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type)
         VALUES (@guildId, @userId, @points, @points, 'starting-balance')`,
        { guildId: GUILD, userId: USER, points }
    );
}

async function enableMargin(overrides = {}) {
    return await exchangeConfig.set(GUILD, { marginEnabled: true, maxLeverage: 4, ...overrides });
}

beforeEach(async () => {
    await reset();
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('account setup', () => {
    test('new accounts are plain cash accounts', async () => {
        const account = await accountService.getAccount(GUILD, USER);
        expect(account).toMatchObject({ accountType: 'CASH', leverage: 1, goblinMode: 0, marginLoan: 0 });
    });

    test('margin is refused until an admin enables it', async () => {
        await expect((async () => await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' }))())
            .rejects.toThrow(/switched off/i);
    });

    test('leverage is capped by the guild maximum', async () => {
        await enableMargin({ maxLeverage: 3 });
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        expect((await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 3 })).leverage).toBe(3);
        await expect((async () => await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 5 }))())
            .rejects.toThrow(/between 1x and 3x/);
    });

    test('cannot drop back to cash while a loan or short is open', async () => {
        await enableMargin();
        await fund(1000);
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await accountService.borrow({ guildId: GUILD, userId: USER, amount: 500 });
        await expect((async () => await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'CASH' }))())
            .rejects.toThrow(/Repay your 500 point loan/);
    });
});

describe('borrowing', () => {
    beforeEach(async () => {
        await enableMargin();
        await fund(1000);
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 2 });
    });

    test('a loan credits the wallet and records both sides', async () => {
        await accountService.borrow({ guildId: GUILD, userId: USER, amount: 400, reason: 'test' });
        expect(await economyService.getBalance(GUILD, USER)).toBe(1400);
        expect((await accountService.getAccount(GUILD, USER)).marginLoan).toBe(400);
        expect((await economyService.getHistory({ guildId: GUILD, userId: USER }))[0])
            .toMatchObject({ amount: 400, type: 'margin-borrow' });
    });

    test('borrowing does not create equity out of thin air', async () => {
        const before = await accountService.getSnapshot({ guildId: GUILD, userId: USER });
        await accountService.borrow({ guildId: GUILD, userId: USER, amount: 750 });
        const after = await accountService.getSnapshot({ guildId: GUILD, userId: USER });
        expect(after.equity).toBe(before.equity);
        expect(after.cash).toBe(before.cash + 750);
        expect(after.debt).toBe(750);
    });

    test('repayment debits the wallet and clears the debt', async () => {
        await accountService.borrow({ guildId: GUILD, userId: USER, amount: 600 });
        const result = await accountService.repay({ guildId: GUILD, userId: USER });
        expect(result).toMatchObject({ repaid: 600, loan: 0, balance: 1000 });
    });

    test('clearing the loan clears the sub-point interest riding on it', async () => {
        await exchangeConfig.set(GUILD, { interestRate: 0.365 });
        await accountService.borrow({ guildId: GUILD, userId: USER, amount: 500 });
        // Enough time for a fraction of a point, not a whole one
        await accountService.accrueInterest({ guildId: GUILD, userId: USER, now: new Date(Date.now() + 3_600_000) });
        expect((await accountService.getAccount(GUILD, USER)).accruedInterest).toBeGreaterThan(0);

        await accountService.repay({ guildId: GUILD, userId: USER });
        expect(await accountService.getAccount(GUILD, USER)).toMatchObject({ marginLoan: 0, accruedInterest: 0 });
        // No phantom point of debt on a paid-off account
        const snapshot = await accountService.getSnapshot({ guildId: GUILD, userId: USER });
        expect(snapshot.debt).toBe(0);
    });

    test('interest capitalizes into the loan rather than overdrawing the wallet', async () => {
        await exchangeConfig.set(GUILD, { interestRate: 0.365 }); // 0.1%/day
        await accountService.borrow({ guildId: GUILD, userId: USER, amount: 10_000 });
        await db.run('UPDATE economy_wallets SET balance = 0 WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER });

        const tenDaysLater = new Date(Date.now() + 10 * 86_400_000);
        const { capitalized } = await accountService.accrueInterest({ guildId: GUILD, userId: USER, now: tenDaysLater });
        expect(capitalized).toBeGreaterThan(90);
        expect(capitalized).toBeLessThan(110);
        expect((await accountService.getAccount(GUILD, USER)).marginLoan).toBe(10_000 + capitalized);
        expect(await economyService.getBalance(GUILD, USER)).toBe(0);
    });
});

describe('leveraged buying', () => {
    beforeEach(async () => {
        await enableMargin();
        await fund(1000);
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 3 });
    });

    test('a buy beyond the wallet borrows exactly the shortfall', async () => {
        const trade = await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 10 });
        expect(trade.cost).toBe(2000);
        expect(trade.borrowed).toBe(1000);
        expect(await economyService.getBalance(GUILD, USER)).toBe(0);
        expect((await accountService.getAccount(GUILD, USER)).marginLoan).toBe(1000);
    });

    test('buying power caps the leverage, not the wallet', async () => {
        await expect(stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 20 }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BUYING_POWER' });
        expect((await accountService.getAccount(GUILD, USER)).marginLoan).toBe(0);
    });

    test('a cash account still cannot spend what it does not have', async () => {
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'CASH' });
        await expect(stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 10 }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    });
});

describe('short selling', () => {
    beforeEach(async () => {
        await enableMargin();
        await fund(1000);
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 2 });
    });

    test('needs a margin account', async () => {
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'CASH' });
        await expect(shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 5 }))
            .rejects.toMatchObject({ code: 'CASH_ACCOUNT' });
    });

    test('credits the proceeds now and owes the units later', async () => {
        const short = await shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 5 });
        expect(short).toMatchObject({ symbol: 'TSLA', units: 5, proceeds: 500, balance: 1500 });

        const snapshot = await accountService.getSnapshot({ guildId: GUILD, userId: USER });
        expect(snapshot.shortValue).toBe(500);
        // The credit is offset by the liability, so equity is unchanged
        expect(snapshot.equity).toBe(1000);
    });

    test('profits when the price falls and loses when it rises', async () => {
        await shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 5 });
        PRICES.TSLA = 60;
        const win = await shortService.cover({ guildId: GUILD, userId: USER, symbol: 'TSLA' });
        expect(win.cost).toBe(300);
        expect(win.realized).toBe(200);
        expect(await economyService.getBalance(GUILD, USER)).toBe(1200);
    });

    test('a short squeeze costs real points', async () => {
        await shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 5 });
        PRICES.TSLA = 180;
        const loss = await shortService.cover({ guildId: GUILD, userId: USER, symbol: 'TSLA' });
        expect(loss.cost).toBe(900);
        expect(loss.realized).toBe(-400);
        expect(await economyService.getBalance(GUILD, USER)).toBe(600);
    });

    test('cannot short a symbol already held long', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 1 });
        await expect(shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 1 }))
            .rejects.toMatchObject({ code: 'LONG_HELD' });
    });

    test('borrow fees accrue on the position and are paid on cover', async () => {
        await exchangeConfig.set(GUILD, { marginEnabled: true, maxLeverage: 4, borrowFeeRate: 1.825 }); // 0.5%/day
        await shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 5 });
        const later = new Date(Date.now() + 10 * 86_400_000);
        await shortService.accrueBorrowFees({ guildId: GUILD, userId: USER, now: later });

        const position = await shortService.getPosition({ guildId: GUILD, userId: USER, symbol: 'TSLA' });
        expect(position.borrowFeeAccrued).toBeCloseTo(25, 0); // 5% of the 500 borrowed
        const cover = await shortService.cover({ guildId: GUILD, userId: USER, symbol: 'TSLA', now: later });
        expect(cover.borrowFee).toBeGreaterThanOrEqual(25);
    });

    test('shorting beyond buying power is refused', async () => {
        await expect(shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 20 }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BUYING_POWER' });
    });
});

describe('margin calls and forced liquidation', () => {
    let engine;

    beforeEach(async () => {
        await enableMargin({ maxLeverage: 4, maintenanceMargin: 0.25, marginCallGraceMinutes: 60 });
        await fund(1000);
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 4 });
        engine = new RiskEngine(null);
        // 4000 of stock on 1000 of equity: 3000 borrowed
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 20 });
    });

    test('the snapshot reports the level where the call arrives', async () => {
        const snapshot = await accountService.getSnapshot({ guildId: GUILD, userId: USER });
        expect(snapshot.equity).toBe(1000);
        expect(snapshot.maintenance).toBe(1000);
        const level = snapshot.liquidationLevels.find(entry => entry.symbol === 'AAPL');
        expect(level.price).toBeCloseTo(200, 6);
    });

    test('a healthy account is never called', async () => {
        PRICES.AAPL = 260;
        const health = await engine.checkMargin({ guildId: GUILD, now: new Date() });
        expect(health.calls).toHaveLength(0);
        expect((await accountService.getAccount(GUILD, USER)).marginCallAt).toBeNull();
    });

    test('a breach raises a call but the grace period protects the position', async () => {
        PRICES.AAPL = 180;
        const health = await engine.checkMargin({ guildId: GUILD, now: new Date() });
        expect(health.calls).toHaveLength(1);
        expect(health.liquidations).toHaveLength(0);
        expect((await accountService.getAccount(GUILD, USER)).marginCallAt).not.toBeNull();
        expect((await stockPortfolioService.getHolding({ guildId: GUILD, userId: USER, symbol: 'AAPL' })).units).toBe(20);
    });

    test('the call clears itself when the market recovers', async () => {
        PRICES.AAPL = 180;
        await engine.checkMargin({ guildId: GUILD, now: new Date() });
        PRICES.AAPL = 220;
        await engine.checkMargin({ guildId: GUILD, now: new Date() });
        expect((await accountService.getAccount(GUILD, USER)).marginCallAt).toBeNull();
    });

    test('an expired call liquidates enough to restore the requirement', async () => {
        PRICES.AAPL = 180;
        const called = new Date();
        await engine.checkMargin({ guildId: GUILD, now: called });

        const later = new Date(called.getTime() + 90 * 60_000);
        const health = await engine.checkMargin({ guildId: GUILD, now: later });
        expect(health.liquidations).toHaveLength(1);

        const after = await accountService.getSnapshot({ guildId: GUILD, userId: USER, now: later });
        expect(after.marginCall).toBe(false);
        expect(after.longValue).toBeLessThan(3600);
        expect((await accountService.getAccount(GUILD, USER)).liquidations).toBe(1);
        // Freed cash was swept into the loan
        expect(after.debt).toBeLessThan(3000);
    });

    test('a wipeout liquidates immediately, without waiting out the grace period', async () => {
        PRICES.AAPL = 120; // 2400 of stock against 3000 of debt: equity is gone
        const health = await engine.checkMargin({ guildId: GUILD, now: new Date() });
        expect(health.liquidations).toHaveLength(1);
        expect(health.liquidations[0].closed.length).toBeGreaterThan(0);
    });

    test('liquidation is recorded in the audit trail with a reason', async () => {
        PRICES.AAPL = 120;
        await engine.checkMargin({ guildId: GUILD, now: new Date() });
        const events = await require('@goobster/core/services/exchange/exchangeEvents')
            .list({ guildId: GUILD, userId: USER, types: ['liquidation'] });
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].detail).toMatchObject({ direction: 'LONG', reason: 'negative-equity' });
    });

    test('a feed outage never triggers a liquidation', async () => {
        PRICES.AAPL = 120;
        stockService.getQuote.mockRejectedValue(new Error('feed down'));
        const health = await engine.checkMargin({ guildId: GUILD, now: new Date() });
        expect(health.liquidations).toHaveLength(0);
        expect((await stockPortfolioService.getHolding({ guildId: GUILD, userId: USER, symbol: 'AAPL' })).units).toBe(20);
    });
});
