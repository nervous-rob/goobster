/**
 * Resting orders (limit, stop, stop-limit, trailing stop) and the risk
 * engine's fill pass.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-orders-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const stockPortfolioService = require('@goobster/core/services/stockPortfolioService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const shortService = require('@goobster/core/services/exchange/shortService');
const orderService = require('@goobster/core/services/exchange/orderService');

const GUILD = '800000000000000001';
const USER = '800000000000000002';
const PRICES = { AAPL: 200, TSLA: 100 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('@goobster/core/services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: `${resolved} Inc.`, price, currency: 'USD', asOf: '2026-07-29 00:00:00', cached: false, stale: false };
}

async function fund(points) {
    await economyService.getWallet(GUILD, USER);
    await db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER, points });
}

beforeEach(async () => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings',
        'stock_trades', 'exchange_accounts', 'exchange_settings', 'short_positions',
        'exchange_events', 'exchange_orders'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { AAPL: 200, TSLA: 100 });
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    await fund(10_000);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('placing orders', () => {
    test('a limit buy rests until the price comes to it', async () => {
        const placed = await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 2, limitPrice: 180
        });
        expect(placed.order).toMatchObject({ symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', status: 'OPEN' });
        expect(placed.triggerHint).toMatch(/falls to \$180/);

        const quiet = await orderService.evaluate({ guildId: GUILD });
        expect(quiet.filled).toHaveLength(0);

        PRICES.AAPL = 175;
        const filled = await orderService.evaluate({ guildId: GUILD });
        expect(filled.filled).toHaveLength(1);
        expect(await orderService.get({ guildId: GUILD, userId: USER, id: placed.order.id }))
            .toMatchObject({ status: 'FILLED', filledUnits: 2, filledPrice: 175 });
        expect((await stockPortfolioService.getHolding({ guildId: GUILD, userId: USER, symbol: 'AAPL' })).units).toBe(2);
    });

    test('rejects a sell order for a position that is not held', async () => {
        await expect(orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'SELL', orderType: 'LIMIT', units: 1, limitPrice: 250
        })).rejects.toMatchObject({ code: 'NO_HOLDING' });
    });

    test('validates the price a given order type actually needs', async () => {
        await expect(orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 1
        })).rejects.toMatchObject({ code: 'BAD_PRICE' });
        await expect(orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'STOP', units: 1
        })).rejects.toMatchObject({ code: 'BAD_PRICE' });
    });

    test('caps how many orders one trader may rest', async () => {
        for (let i = 0; i < orderService.MAX_OPEN_ORDERS; i++) {
            await orderService.place({
                guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 1, limitPrice: 10
            });
        }
        await expect(orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 1, limitPrice: 10
        })).rejects.toMatchObject({ code: 'TOO_MANY_ORDERS' });
    });

    test('cancelling stops the order from ever filling', async () => {
        const placed = await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 1, limitPrice: 250
        });
        await orderService.cancel({ guildId: GUILD, userId: USER, id: placed.order.id });
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.filled).toHaveLength(0);
        expect((await orderService.get({ guildId: GUILD, userId: USER, id: placed.order.id })).status).toBe('CANCELLED');
    });
});

describe('stop orders', () => {
    beforeEach(async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 5 });
    });

    test('a stop-loss sell fires on the way down, at the price it finds', async () => {
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'SELL', orderType: 'STOP', units: 5, stopPrice: 180
        });
        PRICES.AAPL = 190;
        expect((await orderService.evaluate({ guildId: GUILD })).filled).toHaveLength(0);

        // The market gaps straight through the stop: it fills where it lands
        PRICES.AAPL = 150;
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.filled).toHaveLength(1);
        expect(result.filled[0].price).toBe(150);
        expect(await stockPortfolioService.getHolding({ guildId: GUILD, userId: USER, symbol: 'AAPL' })).toBeNull();
    });

    test('a stop-limit triggers but waits for its limit', async () => {
        const placed = await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'SELL', orderType: 'STOP_LIMIT',
            units: 5, stopPrice: 180, limitPrice: 175
        });
        PRICES.AAPL = 160; // through the stop, below the limit
        const triggered = await orderService.evaluate({ guildId: GUILD });
        expect(triggered.filled).toHaveLength(0);
        expect((await orderService.get({ guildId: GUILD, userId: USER, id: placed.order.id })).status).toBe('TRIGGERED');

        PRICES.AAPL = 178; // back above the limit
        const filled = await orderService.evaluate({ guildId: GUILD });
        expect(filled.filled).toHaveLength(1);
    });

    test('a trailing stop ratchets up with the price and never gives ground', async () => {
        const placed = await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'SELL', orderType: 'TRAILING_STOP',
            units: 5, trailPercent: 10
        });
        expect(placed.order.trailAnchor).toBe(200);

        PRICES.AAPL = 300;
        await orderService.evaluate({ guildId: GUILD });
        expect((await orderService.get({ guildId: GUILD, userId: USER, id: placed.order.id })).trailAnchor).toBe(300);

        PRICES.AAPL = 280; // -6.7% from the high: not yet
        expect((await orderService.evaluate({ guildId: GUILD })).filled).toHaveLength(0);

        PRICES.AAPL = 265; // -11.7% from the high
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.filled).toHaveLength(1);
        expect(result.filled[0].price).toBe(265);
    });

    test('a trailing stop must protect a position, not open one', async () => {
        await expect(orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'TRAILING_STOP', units: 1, trailPercent: 5
        })).rejects.toMatchObject({ code: 'BAD_TRAIL' });
    });
});

describe('short-side orders', () => {
    beforeEach(async () => {
        await exchangeConfig.set(GUILD, { marginEnabled: true, maxLeverage: 4 });
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 3 });
    });

    test('a limit short opens when the price rallies to it', async () => {
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'TSLA', side: 'SHORT', orderType: 'LIMIT', units: 5, limitPrice: 130
        });
        PRICES.TSLA = 140;
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.filled).toHaveLength(1);
        expect(await shortService.getPosition({ guildId: GUILD, userId: USER, symbol: 'TSLA' })).toMatchObject({ units: 5 });
    });

    test('a buy-stop covers a short that is running away', async () => {
        await shortService.openShort({ guildId: GUILD, userId: USER, symbol: 'TSLA', units: 5 });
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'TSLA', side: 'COVER', orderType: 'STOP', units: 5, stopPrice: 120
        });
        PRICES.TSLA = 125;
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.filled).toHaveLength(1);
        expect(await shortService.getPosition({ guildId: GUILD, userId: USER, symbol: 'TSLA' })).toBeNull();
    });
});

describe('orders that cannot fill', () => {
    test('an unaffordable fill is rejected with the reason attached', async () => {
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 100, limitPrice: 250
        });
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.rejected).toHaveLength(1);
        const order = (await orderService.list({ guildId: GUILD, userId: USER, status: 'all' }))[0];
        expect(order.status).toBe('REJECTED');
        expect(order.note).toMatch(/Not enough/i);
    });

    test('a good-until time expires the order untouched', async () => {
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT',
            units: 1, limitPrice: 250, expiresAt: new Date(Date.now() - 60_000)
        });
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.expired).toHaveLength(1);
        expect(result.filled).toHaveLength(0);
        expect(await stockPortfolioService.getHolding({ guildId: GUILD, userId: USER, symbol: 'AAPL' })).toBeNull();
    });

    test('a price outage leaves the order working rather than guessing', async () => {
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 1, limitPrice: 250
        });
        stockService.getQuote.mockRejectedValue(new Error('feed down'));
        const result = await orderService.evaluate({ guildId: GUILD });
        expect(result.filled).toHaveLength(0);
        expect(await orderService.list({ guildId: GUILD, userId: USER })).toHaveLength(1);
    });
});
