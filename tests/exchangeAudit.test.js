/**
 * The auditor: per-account audits, the server-wide economy dashboard, and the
 * integrity checks that prove the books add up.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-audit-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const stockPortfolioService = require('@goobster/core/services/stockPortfolioService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const shortService = require('@goobster/core/services/exchange/shortService');
const optionsService = require('@goobster/core/services/exchange/optionsService');
const orderService = require('@goobster/core/services/exchange/orderService');
const predictionService = require('@goobster/core/services/exchange/predictionService');
const auditService = require('@goobster/core/services/exchange/auditService');

const GUILD = '910000000000000001';
const WHALE = '910000000000000002';
const MINNOW = '910000000000000003';

const NOW = new Date('2026-07-29T14:00:00Z');
const NEXT_MONTH = '2026-08-28';
const PRICES = { AAPL: 200, TSLA: 100, '^GSPC': 6000 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('@goobster/core/services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: `${resolved} Inc.`, price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

async function fund(userId, points) {
    await economyService.getWallet(GUILD, userId);
    await db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId, points });
    await db.run('DELETE FROM economy_transactions WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId });
    await db.run(
        `INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type)
         VALUES (@g, @u, @points, @points, 'starting-balance')`,
        { g: GUILD, u: userId, points }
    );
}

beforeEach(async () => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings', 'stock_trades',
        'exchange_accounts', 'exchange_settings', 'short_positions', 'exchange_events', 'exchange_orders',
        'option_positions', 'option_trades', 'prediction_positions', 'prediction_markets', 'stock_symbols'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { AAPL: 200, TSLA: 100, '^GSPC': 6000 });
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    jest.spyOn(stockService, 'getHistory').mockImplementation(async symbol => {
        const resolved = stockService.normalizeSymbol(symbol);
        const closes = [];
        let price = PRICES[resolved] || 100;
        for (let i = 0; i < 60; i++) {
            price *= i % 2 ? 1.02 : 1 / 1.02;
            closes.push(price);
        }
        return { symbol: resolved, currency: 'USD', points: closes.map((close, i) => ({ date: `2026-05-${i + 1}`, close })) };
    });
    await exchangeConfig.set(GUILD, {
        marginEnabled: true, optionsEnabled: true, zeroDteEnabled: true,
        predictionsEnabled: true, maxLeverage: 4
    });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

/** A trader with one of everything, so the audit has something to look at. */
async function buildBusyAccount(userId = WHALE) {
    await fund(userId, 100_000);
    await accountService.setAccountType({ guildId: GUILD, userId, accountType: 'MARGIN' });
    await accountService.setLeverage({ guildId: GUILD, userId, leverage: 3 });
    await accountService.setGoblinMode({ guildId: GUILD, userId, enabled: true });

    const option = await optionsService.buyToOpen({
        guildId: GUILD, userId, symbol: 'SPX', optionType: 'CALL',
        strike: 6100, expiry: NEXT_MONTH, contracts: 2, now: NOW
    });
    await shortService.openShort({ guildId: GUILD, userId, symbol: 'TSLA', units: 50, now: NOW });
    const market = await predictionService.createMarket({
        guildId: GUILD, symbol: 'AAPL', comparator: 'ABOVE', threshold: 250,
        closesAt: '2026-08-14 20:00:00', resolvesAt: '2026-08-14 20:00:00', createdBy: userId, now: NOW
    });
    await predictionService.buy({ guildId: GUILD, userId, marketId: market.id, side: 'YES', contracts: 5, now: NOW });
    // Deliberately more stock than the wallet holds, so the account carries a loan
    await stockPortfolioService.buy({ guildId: GUILD, userId, symbol: 'AAPL', units: 600 });
    await orderService.place({
        guildId: GUILD, userId, symbol: 'AAPL', side: 'SELL', orderType: 'STOP', units: 10, stopPrice: 150
    });
    return { option, market };
}

describe('account audit', () => {
    test('reports every instrument, the risk numbers, and the realized history', async () => {
        await buildBusyAccount();
        const audit = await auditService.auditAccount({ guildId: GUILD, userId: WHALE, now: NOW });

        expect(audit.snapshot.account).toMatchObject({ accountType: 'MARGIN', leverage: 3, goblinMode: true });
        expect(audit.snapshot.longs).toHaveLength(1);
        expect(audit.snapshot.shorts).toHaveLength(1);
        expect(audit.snapshot.options).toHaveLength(1);
        expect(audit.openOrders).toHaveLength(1);
        expect(audit.predictions).toHaveLength(1);

        expect(audit.snapshot.longValue).toBe(120_000);
        expect(audit.snapshot.shortValue).toBe(5_000);
        expect(audit.snapshot.debt).toBeGreaterThan(0);
        expect(audit.snapshot.equity).toBeGreaterThan(0);
        expect(audit.snapshot.maintenance).toBeGreaterThan(0);
        expect(audit.snapshot.buyingPower).toBeGreaterThanOrEqual(0);
        expect(audit.ledger.reconciles).toBe(true);
    });

    test('option positions carry live greeks and settlement odds', async () => {
        await buildBusyAccount();
        const audit = await auditService.auditAccount({ guildId: GUILD, userId: WHALE, now: NOW });
        const option = audit.snapshot.options[0];
        expect(option).toMatchObject({ underlying: '^GSPC', optionType: 'CALL', strike: 6100, contracts: 2 });
        expect(option.greeks.delta).toBeGreaterThan(0);
        expect(option.greeks.theta).toBeLessThan(0);
        expect(option.probabilityItm).toBeGreaterThan(0);
        expect(option.maxLoss).toBe(option.costBasis);
    });

    test('flags a margin call and the distance to one', async () => {
        await fund(MINNOW, 1000);
        await accountService.setAccountType({ guildId: GUILD, userId: MINNOW, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: MINNOW, leverage: 4 });
        await stockPortfolioService.buy({ guildId: GUILD, userId: MINNOW, symbol: 'AAPL', units: 15 });

        const healthy = await auditService.auditAccount({ guildId: GUILD, userId: MINNOW, now: NOW });
        expect(healthy.snapshot.marginMove.drop).toBeGreaterThan(0);
        expect(healthy.snapshot.marginMove.drop).toBeLessThan(0.5);
        expect(healthy.risks.some(flag => /triggers a margin call/.test(flag))).toBe(true);

        PRICES.AAPL = 150;
        const called = await auditService.auditAccount({ guildId: GUILD, userId: MINNOW, now: NOW });
        expect(called.snapshot.marginCall).toBe(true);
        expect(called.risks[0]).toMatch(/MARGIN CALL/);
    });

    test('flags same-day contracts with the premium at risk', async () => {
        await fund(MINNOW, 50_000);
        await accountService.setGoblinMode({ guildId: GUILD, userId: MINNOW, enabled: true });
        await optionsService.buyToOpen({
            guildId: GUILD, userId: MINNOW, symbol: 'SPX', optionType: 'CALL',
            strike: 6000, expiry: '2026-07-29', contracts: 1, now: NOW
        });
        const audit = await auditService.auditAccount({ guildId: GUILD, userId: MINNOW, now: NOW });
        expect(audit.risks.some(flag => /same-day contract/.test(flag))).toBe(true);
    });

    test('says so when positions could not be priced', async () => {
        await buildBusyAccount();
        stockService.getQuote.mockRejectedValue(new Error('feed down'));
        const audit = await auditService.auditAccount({ guildId: GUILD, userId: WHALE, now: NOW });
        expect(audit.snapshot.pricingGaps).toBeGreaterThan(0);
        expect(audit.risks.some(flag => /could not be priced/.test(flag))).toBe(true);
    });

    test('renders a compact report Goobster can read aloud', async () => {
        await buildBusyAccount();
        const audit = await auditService.auditAccount({ guildId: GUILD, userId: WHALE, now: NOW });
        const text = auditService.renderAccountAudit(audit, { label: 'The Data Daddy' });

        expect(text).toMatch(/ACCOUNT AUDIT - The Data Daddy/);
        expect(text).toMatch(/MARGIN at 3x/);
        expect(text).toMatch(/GOBLIN MODE ON/);
        expect(text).toMatch(/AAPL 600 @ \$200\.00/);
        expect(text).toMatch(/TSLA -50/);
        expect(text).toMatch(/6100 CALL/);
        expect(text).toMatch(/reconciles with the wallet/);
    });

    test('an untouched trader audits cleanly rather than erroring', async () => {
        const audit = await auditService.auditAccount({ guildId: GUILD, userId: MINNOW, now: NOW });
        // No positions and no debt: equity is just the wallet
        expect(audit.snapshot.equity).toBe(audit.snapshot.cash);
        expect(audit.snapshot.longs).toEqual([]);
        expect(audit.risks).toEqual([]);
        expect(auditService.renderAccountAudit(audit)).toMatch(/ACCOUNT AUDIT/);
    });
});

describe('server-wide audit', () => {
    test('reports money supply, exposure, and concentration', async () => {
        await buildBusyAccount(WHALE);
        await fund(MINNOW, 5_000);
        await stockPortfolioService.buy({ guildId: GUILD, userId: MINNOW, symbol: 'AAPL', units: 5 });

        const audit = await auditService.auditGuild({ guildId: GUILD, now: NOW });
        expect(audit.moneySupply.wallets).toBe(2);
        expect(audit.moneySupply.outstandingLoans).toBeGreaterThan(0);
        expect(audit.accounts.margin).toBe(1);
        expect(audit.accounts.goblinMode).toBe(1);
        expect(audit.longBook[0].symbol).toBe('AAPL');
        expect(audit.shortBook[0].symbol).toBe('TSLA');
        expect(audit.optionOpenInterest[0]).toMatchObject({ underlying: '^GSPC', optionType: 'CALL' });
        expect(audit.workingOrders).toBe(1);
        expect(audit.predictionMarkets).toHaveLength(1);
        expect(audit.traders[0].userId).toBe(WHALE);
        expect(audit.concentration.hhi).toBeGreaterThan(0);
        expect(audit.concentration.topShare).toBeGreaterThan(0.5);
    });

    test('ranks traders by equity, not by the size of a borrowed wallet', async () => {
        await fund(WHALE, 1_000);
        await accountService.setAccountType({ guildId: GUILD, userId: WHALE, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: WHALE, leverage: 4 });
        await accountService.borrow({ guildId: GUILD, userId: WHALE, amount: 3_000 });
        await fund(MINNOW, 2_000);

        const board = await auditService.leaderboard({ guildId: GUILD, now: NOW });
        expect(board[0].userId).toBe(MINNOW); // 2000 equity beats 1000 equity on a 4000 wallet
        expect(board.find(row => row.userId === WHALE)).toMatchObject({ cash: 4_000, debt: 3_000, equity: 1_000 });
    });

    test('surfaces the 0DTE powder keg separately', async () => {
        await fund(MINNOW, 50_000);
        await accountService.setGoblinMode({ guildId: GUILD, userId: MINNOW, enabled: true });
        await optionsService.buyToOpen({
            guildId: GUILD, userId: MINNOW, symbol: 'SPX', optionType: 'CALL',
            strike: 6000, expiry: '2026-07-29', contracts: 3, now: NOW
        });
        const audit = await auditService.auditGuild({ guildId: GUILD, now: NOW });
        expect(audit.zeroDteOpenInterest).toHaveLength(1);
        expect(auditService.renderGuildAudit(audit)).toMatch(/0DTE open interest expiring today/);
    });

    test('renders a server report naming the traders it can name', async () => {
        await buildBusyAccount(WHALE);
        const audit = await auditService.auditGuild({ guildId: GUILD, now: NOW });
        const text = auditService.renderGuildAudit(audit, { names: new Map([[WHALE, 'The Data Daddy']]) });
        expect(text).toMatch(/EXCHANGE AUDIT/);
        expect(text).toMatch(/margin ON/);
        expect(text).toMatch(/The Data Daddy: equity/);
    });
});

describe('reconciliation', () => {
    test('a healthy exchange passes every check', async () => {
        await buildBusyAccount();
        const report = await auditService.reconcile({ guildId: GUILD, now: NOW });
        expect(report.ok).toBe(true);
        for (const check of report.checks) {
            expect({ name: check.name, count: check.count }).toEqual({ name: check.name, count: 0 });
        }
    });

    test('catches an event contract left sitting past its resolution time', async () => {
        const { market } = await buildBusyAccount();
        // The same books, read after the market was due: only the clock moved
        const later = new Date('2026-08-15T00:00:00Z');
        const report = await auditService.reconcile({ guildId: GUILD, now: later });
        const check = report.checks.find(entry => entry.name === 'unsettled-markets');
        expect(report.ok).toBe(false);
        expect(check.count).toBe(1);
        expect(check.sample[0]).toMatchObject({ id: market.id, resolvesAt: '2026-08-14 20:00:00' });
    });

    test('catches a wallet that drifted from its ledger', async () => {
        await fund(MINNOW, 1_000);
        await db.run('UPDATE economy_wallets SET balance = 9999 WHERE guildId = @g AND userId = @u', { g: GUILD, u: MINNOW });

        const report = await auditService.reconcile({ guildId: GUILD, now: NOW });
        const check = report.checks.find(entry => entry.name === 'wallet-ledger-drift');
        expect(report.ok).toBe(false);
        expect(check.count).toBe(1);
        expect(check.sample[0]).toMatchObject({ userId: MINNOW, balance: 9999, drift: 8999 });
    });

    test('catches a short parked on a cash account', async () => {
        await db.run(
            `INSERT INTO short_positions (guildId, userId, symbol, units, proceeds, avgPrice)
             VALUES (@g, @u, 'TSLA', 5, 500, 100)`,
            { g: GUILD, u: MINNOW }
        );
        const report = await auditService.reconcile({ guildId: GUILD, now: NOW });
        expect(report.checks.find(entry => entry.name === 'short-without-margin').count).toBe(1);
    });

    test('catches contracts that outlived their settlement time', async () => {
        await fund(MINNOW, 50_000);
        await optionsService.buyToOpen({
            guildId: GUILD, userId: MINNOW, symbol: 'AAPL', optionType: 'CALL',
            strike: 200, expiry: NEXT_MONTH, contracts: 1, now: NOW
        });
        await db.run("UPDATE option_positions SET expiry = '2020-01-03'");
        const report = await auditService.reconcile({ guildId: GUILD, now: NOW });
        expect(report.checks.find(entry => entry.name === 'unsettled-expiries').count).toBe(1);
    });

    test('catches a working sell order with nothing behind it', async () => {
        await fund(MINNOW, 10_000);
        await stockPortfolioService.buy({ guildId: GUILD, userId: MINNOW, symbol: 'AAPL', units: 5 });
        await orderService.place({
            guildId: GUILD, userId: MINNOW, symbol: 'AAPL', side: 'SELL', orderType: 'LIMIT', units: 5, limitPrice: 300
        });
        await db.run('DELETE FROM stock_holdings');
        const report = await auditService.reconcile({ guildId: GUILD, now: NOW });
        expect(report.checks.find(entry => entry.name === 'orphan-sell-orders').count).toBe(1);
    });

    test('catches somebody long and short the same symbol', async () => {
        await fund(MINNOW, 10_000);
        await stockPortfolioService.buy({ guildId: GUILD, userId: MINNOW, symbol: 'TSLA', units: 5 });
        await db.run(
            `INSERT INTO short_positions (guildId, userId, symbol, units, proceeds, avgPrice)
             VALUES (@g, @u, 'TSLA', 5, 500, 100)`,
            { g: GUILD, u: MINNOW }
        );
        const report = await auditService.reconcile({ guildId: GUILD, now: NOW });
        expect(report.checks.find(entry => entry.name === 'long-and-short').count).toBe(1);
    });
});
