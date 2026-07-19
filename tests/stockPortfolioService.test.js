/**
 * Unit tests for the stock trading game (services/stockPortfolioService.js)
 * with a mocked quote source, against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-stocks-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const economyService = require('../services/economyService');
const stockService = require('../services/stockService');
const stockPortfolioService = require('../services/stockPortfolioService');

const GUILD = '500000000000000001';
const USER = '500000000000000002';

const QUOTES = {
    AAPL: { symbol: 'AAPL', name: 'Apple Inc.', price: 200, currency: 'USD', asOf: '2026-07-19 00:00:00', cached: false, stale: false },
    PENNY: { symbol: 'PENNY', name: 'Penny Co.', price: 0.4, currency: 'USD', asOf: '2026-07-19 00:00:00', cached: false, stale: false },
    'SAP.DE': { symbol: 'SAP.DE', name: 'SAP SE', price: 150, currency: 'EUR', asOf: '2026-07-19 00:00:00', cached: false, stale: false }
};

beforeEach(() => {
    db.run('DELETE FROM economy_wallets');
    db.run('DELETE FROM economy_transactions');
    db.run('DELETE FROM economy_settings');
    db.run('DELETE FROM stock_holdings');
    db.run('DELETE FROM stock_trades');
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => {
        const quote = QUOTES[stockService.normalizeSymbol(symbol)];
        if (!quote) {
            const { StockError } = require('../services/stockService');
            throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${symbol}.`);
        }
        return { ...quote };
    });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('buying', () => {
    test('debits points at 1 point = $1 (cost rounds up) and records the trade', async () => {
        const trade = await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'aapl', units: 2.5 });
        expect(trade).toMatchObject({ symbol: 'AAPL', units: 2.5, price: 200, cost: 500, balance: 500 });
        expect(trade.holding).toMatchObject({ units: 2.5, costBasis: 500 });

        const trades = stockPortfolioService.getTrades({ guildId: GUILD, userId: USER });
        expect(trades[0]).toMatchObject({ symbol: 'AAPL', side: 'BUY', units: 2.5, price: 200, points: 500 });

        const ledger = economyService.getHistory({ guildId: GUILD, userId: USER })[0];
        expect(ledger).toMatchObject({ amount: -500, type: 'stock-buy' });
    });

    test('fractional costs round up to whole points', async () => {
        const trade = await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'PENNY', units: 3 });
        expect(trade.cost).toBe(2); // 3 * 0.4 = 1.2 -> 2
    });

    test('repeat buys accumulate into one holding', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 1 });
        const second = await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 2 });
        expect(second.holding).toMatchObject({ units: 3, costBasis: 600 });
    });

    test('rejects orders beyond the balance without touching holdings', async () => {
        await expect(stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 100 }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(stockPortfolioService.getHolding({ guildId: GUILD, userId: USER, symbol: 'AAPL' })).toBeNull();
        expect(economyService.getBalance(GUILD, USER)).toBe(1000);
    });

    test('rejects non-USD symbols (1 point = $1 peg)', async () => {
        await expect(stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'SAP.DE', units: 1 }))
            .rejects.toMatchObject({ code: 'NOT_USD' });
    });

    test('rejects zero, negative, and absurd unit counts', async () => {
        for (const units of [0, -1, Infinity, NaN]) {
            await expect(stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units }))
                .rejects.toMatchObject({ code: 'BAD_UNITS' });
        }
    });
});

describe('selling', () => {
    test('partial sale credits proceeds (rounded down) and keeps the rest', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 4 });
        const sale = await stockPortfolioService.sell({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 1 });
        expect(sale).toMatchObject({ symbol: 'AAPL', units: 1, proceeds: 200, balance: 400 });
        expect(sale.holding).toMatchObject({ units: 3, costBasis: 600 });
    });

    test('selling everything closes the position', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 2 });
        const sale = await stockPortfolioService.sell({ guildId: GUILD, userId: USER, symbol: 'AAPL' });
        expect(sale.units).toBe(2);
        expect(sale.holding).toBeNull();
        expect(sale.balance).toBe(1000); // bought 400, sold 400
    });

    test('cannot sell what you do not hold', async () => {
        await expect(stockPortfolioService.sell({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 1 }))
            .rejects.toMatchObject({ code: 'NO_HOLDING' });
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 1 });
        await expect(stockPortfolioService.sell({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 5 }))
            .rejects.toMatchObject({ code: 'NO_HOLDING' });
    });
});

describe('portfolio check-in', () => {
    test('values positions at the current price with P/L vs cost', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 2 }); // 400 points
        QUOTES.AAPL.price = 250; // price moves up

        const portfolio = await stockPortfolioService.getPortfolio({ guildId: GUILD, userId: USER });
        expect(portfolio.positions).toHaveLength(1);
        expect(portfolio.positions[0]).toMatchObject({
            symbol: 'AAPL', units: 2, costBasis: 400, price: 250, value: 500, profitLoss: 100
        });
        expect(portfolio).toMatchObject({ totalValue: 500, totalCost: 400, totalPL: 100 });

        QUOTES.AAPL.price = 200; // restore for other tests
    });

    test('still lists positions when the price source fails', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 1 });
        stockService.getQuote.mockRejectedValue(new Error('network down'));

        const portfolio = await stockPortfolioService.getPortfolio({ guildId: GUILD, userId: USER });
        expect(portfolio.positions[0]).toMatchObject({ symbol: 'AAPL', units: 1, price: null, profitLoss: null });
    });
});
