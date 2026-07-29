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

const db = require('../db');
const economyService = require('../services/economyService');
const stockService = require('../services/stockService');
const stockPortfolioService = require('../services/stockPortfolioService');
const exchangeConfig = require('../services/exchange/exchangeConfig');
const accountService = require('../services/exchange/accountService');
const shortService = require('../services/exchange/shortService');
const optionsService = require('../services/exchange/optionsService');
const orderService = require('../services/exchange/orderService');
const predictionService = require('../services/exchange/predictionService');
const privacyService = require('../services/privacyService');

const GUILD = '930000000000000001';
const USER = '930000000000000002';
const BYSTANDER = '930000000000000003';

const NOW = new Date('2026-07-29T14:00:00Z');
const EXPIRY = '2026-08-28';
const PRICES = { AAPL: 200, TSLA: 100 };

const EXCHANGE_TABLES = [
    'exchange_accounts', 'short_positions', 'option_positions', 'option_trades',
    'exchange_orders', 'prediction_positions', 'exchange_events'
];

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('../services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: `${resolved} Inc.`, price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

function fund(userId, points) {
    economyService.getWallet(GUILD, userId);
    db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId, points });
}

function countFor(table, userId) {
    return db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE userId = @userId`, { userId }).c;
}

/** Open one of everything so the erasure has something to miss. */
async function buildFullBook(userId) {
    fund(userId, 200_000);
    accountService.setAccountType({ guildId: GUILD, userId, accountType: 'MARGIN' });
    accountService.setLeverage({ guildId: GUILD, userId, leverage: 3 });
    accountService.borrow({ guildId: GUILD, userId, amount: 5_000, reason: 'test' });
    await stockPortfolioService.buy({ guildId: GUILD, userId, symbol: 'AAPL', units: 10 });
    await shortService.openShort({ guildId: GUILD, userId, symbol: 'TSLA', units: 5, now: NOW });
    await optionsService.buyToOpen({
        guildId: GUILD, userId, symbol: 'AAPL', optionType: 'CALL',
        strike: 210, expiry: EXPIRY, contracts: 1, now: NOW
    });
    await orderService.place({
        guildId: GUILD, userId, symbol: 'AAPL', side: 'SELL', orderType: 'STOP', units: 10, stopPrice: 150
    });
    const market = predictionService.createMarket({
        guildId: GUILD, symbol: 'AAPL', comparator: 'ABOVE', threshold: 250,
        closesAt: '2026-08-14 20:00:00', resolvesAt: '2026-08-14 20:00:00', createdBy: userId, now: NOW
    });
    await predictionService.buy({ guildId: GUILD, userId, marketId: market.id, side: 'YES', contracts: 5, now: NOW });
    return market;
}

beforeEach(() => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings', 'stock_trades',
        'exchange_settings', 'prediction_markets', 'stock_symbols', ...EXCHANGE_TABLES
    ]) {
        db.run(`DELETE FROM ${table}`);
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
    exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true, predictionsEnabled: true, maxLeverage: 4 });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('the transparency report', () => {
    test('describes the exchange account alongside the wallet', async () => {
        await buildFullBook(USER);
        const report = privacyService.buildUserReport({ guildId: GUILD, userId: USER });

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

    test('reports no account for somebody who never traded', () => {
        const report = privacyService.buildUserReport({ guildId: GUILD, userId: BYSTANDER });
        expect(report.exchange.accountType).toBeNull();
        expect(report.exchange.optionPositions).toBe(0);
    });
});

describe('erasure', () => {
    test('every exchange table is emptied for the user', async () => {
        await buildFullBook(USER);
        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: countFor(table, USER) }).not.toEqual({ table, rows: 0 });
        }

        const counts = privacyService.forgetUser({ userId: USER });
        expect(counts.exchange).toBeGreaterThan(0);

        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: countFor(table, USER) }).toEqual({ table, rows: 0 });
        }
    });

    test('the audit proves zero remaining rows', async () => {
        await buildFullBook(USER);
        privacyService.forgetUser({ userId: USER });

        const audit = privacyService.auditUser({ userId: USER });
        expect(audit.total).toBe(0);
        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: audit.byTable[table] }).toEqual({ table, rows: 0 });
        }
    });

    test('a market they opened survives, but their name comes off it', async () => {
        const market = await buildFullBook(USER);
        privacyService.forgetUser({ userId: USER });

        const remaining = predictionService.getMarket({ guildId: GUILD, id: market.id });
        expect(remaining).not.toBeNull();
        expect(remaining.createdBy).toBeNull();
    });

    test('another trader in the same guild is untouched', async () => {
        await buildFullBook(USER);
        await buildFullBook(BYSTANDER);

        privacyService.forgetUser({ userId: USER });

        for (const table of EXCHANGE_TABLES) {
            expect({ table, rows: countFor(table, BYSTANDER) }).not.toEqual({ table, rows: 0 });
        }
        expect(economyService.getBalance(GUILD, BYSTANDER)).toBeGreaterThan(0);
    });
});
