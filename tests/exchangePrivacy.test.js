/**
 * /forget-me must reach every exchange table. A trader who asks to be
 * forgotten cannot leave a margin loan, a short, an option lot, a resting
 * order, an event-contract stake, or an engine event trail behind.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-privacy-test-${process.pid}.sqlite`);
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
const privacyService = require('@goobster/core/services/privacyService');

const GUILD = '930000000000000001';
const USER = '930000000000000002';
const BYSTANDER = '930000000000000003';

const NOW = new Date('2026-07-29T14:00:00Z');
const EXPIRY = '2026-08-28';
const PRICES = { AAPL: 200, TSLA: 100 };

const EXCHANGE_TABLES = [
    'exchange_accounts', 'short_positions', 'option_positions', 'option_trades',
    'exchange_orders', 'prediction_positions', 'exchange_events',
    'perp_positions', 'exchange_optins'
];

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
}

async function countFor(table, userId) {
    return (await db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE userId = @userId`, { userId })).c;
}

/** Open one of everything so the erasure has something to miss. */
async function buildFullBook(userId) {
    await fund(userId, 200_000);
    await accountService.setAccountType({ guildId: GUILD, userId, accountType: 'MARGIN' });
    await accountService.setLeverage({ guildId: GUILD, userId, leverage: 3 });
    await accountService.borrow({ guildId: GUILD, userId, amount: 5_000, reason: 'test' });
    await stockPortfolioService.buy({ guildId: GUILD, userId, symbol: 'AAPL', units: 10 });
    await shortService.openShort({ guildId: GUILD, userId, symbol: 'TSLA', units: 5, now: NOW });
    await optionsService.buyToOpen({
        guildId: GUILD, userId, symbol: 'AAPL', optionType: 'CALL',
        strike: 210, expiry: EXPIRY, contracts: 1, now: NOW
    });
    await require('@goobster/core/services/exchange/perpsService').open({
        guildId: GUILD, userId, symbol: 'TSLA', direction: 'LONG', margin: 500, leverage: 2, now: NOW
    });
    await require('@goobster/core/services/exchange/groupPlayService').setOptIn({ guildId: GUILD, userId, optedIn: true, maxAllocationPercent: 10 });
    await orderService.place({
        guildId: GUILD, userId, symbol: 'AAPL', side: 'SELL', orderType: 'STOP', units: 10, stopPrice: 150
    });
    const market = await predictionService.createMarket({
        guildId: GUILD, symbol: 'AAPL', comparator: 'ABOVE', threshold: 250,
        closesAt: '2026-08-14 20:00:00', resolvesAt: '2026-08-14 20:00:00', createdBy: userId, now: NOW
    });
    await predictionService.buy({ guildId: GUILD, userId, marketId: market.id, side: 'YES', contracts: 5, now: NOW });
    return market;
}

beforeEach(async () => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings', 'stock_trades',
        'exchange_settings', 'prediction_markets', 'stock_symbols', ...EXCHANGE_TABLES
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { AAPL: 200, TSLA: 100 });
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
    await exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true, predictionsEnabled: true, futuresEnabled: true, maxLeverage: 4 });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('the transparency report', () => {
    test('describes the exchange account alongside the wallet', async () => {
        await buildFullBook(USER);
        const report = await privacyService.buildUserReport({ guildId: GUILD, userId: USER });

        expect(report.exchange).toMatchObject({
            accountType: 'MARGIN',
            leverage: 3,
            goblinMode: false,
            shortPositions: 1,
            optionPositions: 1,
            orders: 1,
            eventContracts: 1
        });
        expect(report.exchange.marginLoan).toBeGreaterThan(0);
        expect(report.exchange.optionTrades).toBeGreaterThan(0);
        expect(report.exchange.engineEvents).toBeGreaterThan(0);
    });

    test('reports no account for somebody who never traded', async () => {
        const report = await privacyService.buildUserReport({ guildId: GUILD, userId: BYSTANDER });
        expect(report.exchange.accountType).toBeNull();
        expect(report.exchange.optionPositions).toBe(0);
    });
});

describe('erasure', () => {
    test('every exchange table is emptied for the user', async () => {
        await buildFullBook(USER);
        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: await countFor(table, USER) }).not.toEqual({ table, rows: 0 });
        }

        const counts = await privacyService.forgetUser({ userId: USER });
        expect(counts.exchange).toBeGreaterThan(0);

        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: await countFor(table, USER) }).toEqual({ table, rows: 0 });
        }
    });

    test('the audit proves zero remaining rows', async () => {
        await buildFullBook(USER);
        await privacyService.forgetUser({ userId: USER });

        const audit = await privacyService.auditUser({ userId: USER });
        expect(audit.total).toBe(0);
        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: audit.byTable[table] }).toEqual({ table, rows: 0 });
        }
    });

    test('a market they opened survives, but their name comes off it', async () => {
        const market = await buildFullBook(USER);
        await privacyService.forgetUser({ userId: USER });

        const remaining = await predictionService.getMarket({ guildId: GUILD, id: market.id });
        expect(remaining).not.toBeNull();
        expect(remaining.createdBy).toBeNull();
    });

    test('another trader in the same guild is untouched', async () => {
        await buildFullBook(USER);
        await buildFullBook(BYSTANDER);

        await privacyService.forgetUser({ userId: USER });

        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: await countFor(table, BYSTANDER) }).not.toEqual({ table, rows: 0 });
        }
        expect(await economyService.getBalance(GUILD, BYSTANDER)).toBeGreaterThan(0);
    });
});
