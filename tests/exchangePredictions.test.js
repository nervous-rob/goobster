/**
 * Binary event contracts: probability-based pricing, position caps, and
 * deterministic settlement from the underlying's price.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-predictions-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const predictionService = require('@goobster/core/services/exchange/predictionService');

const GUILD = '900000000000000001';
const USER = '900000000000000002';
const OTHER = '900000000000000003';

const NOW = new Date('2026-07-29T14:00:00Z');
const RESOLVES = '2026-08-05 20:00:00';
const PRICES = { RKLB: 50 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('@goobster/core/services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: `${resolved} Inc.`, price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

function fund(userId, points) {
    economyService.getWallet(GUILD, userId);
    db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId, points });
}

function openMarket(overrides = {}) {
    return predictionService.createMarket({
        guildId: GUILD, symbol: 'RKLB', comparator: 'ABOVE', threshold: 60,
        closesAt: RESOLVES, resolvesAt: RESOLVES, createdBy: USER, now: NOW, ...overrides
    });
}

beforeEach(() => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'exchange_settings',
        'prediction_positions', 'prediction_markets', 'exchange_events', 'stock_symbols'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { RKLB: 50 });
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    jest.spyOn(stockService, 'getHistory').mockImplementation(async symbol => {
        const resolved = stockService.normalizeSymbol(symbol);
        const closes = [];
        let price = PRICES[resolved] || 100;
        for (let i = 0; i < 60; i++) {
            price *= i % 2 ? 1.03 : 1 / 1.03;
            closes.push(price);
        }
        return { symbol: resolved, currency: 'USD', points: closes.map((close, i) => ({ date: `2026-05-${i + 1}`, close })) };
    });
    exchangeConfig.set(GUILD, { predictionsEnabled: true });
    fund(USER, 100_000);
    fund(OTHER, 100_000);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('creating markets', () => {
    test('writes a self-describing question when none is given', () => {
        const market = openMarket();
        expect(market.question).toMatch(/Will RKLB be above \$60/);
        expect(market).toMatchObject({ symbol: 'RKLB', comparator: 'ABOVE', threshold: 60, status: 'OPEN' });
    });

    test('refuses a resolution time in the past or beyond the horizon', () => {
        expect(() => openMarket({ resolvesAt: '2026-07-01 20:00:00', closesAt: '2026-07-01 20:00:00' }))
            .toThrow(/must be in the future/);
        expect(() => openMarket({ resolvesAt: '2030-07-01 20:00:00', closesAt: '2030-07-01 20:00:00' }))
            .toThrow(/at most 365 days/);
    });

    test('refuses to let trading close after resolution', () => {
        expect(() => openMarket({ closesAt: '2026-08-06 20:00:00' })).toThrow(/no later than/);
    });

    test('needs the guild to have enabled event contracts', () => {
        exchangeConfig.set(GUILD, { predictionsEnabled: false });
        expect(() => openMarket()).toThrow(/switched off/i);
    });
});

describe('pricing', () => {
    test('an unlikely outcome is cheap and the other side is dear', async () => {
        const market = openMarket({ threshold: 90 }); // far above a $50 stock
        const pricing = await predictionService.quote({ market, now: NOW });
        expect(pricing.probability).toBeLessThan(0.1);
        expect(pricing.yesPrice).toBeLessThan(15);
        expect(pricing.noPrice).toBeGreaterThan(85);
    });

    test('a coin-flip threshold prices near the middle', async () => {
        const market = openMarket({ threshold: 50 });
        const pricing = await predictionService.quote({ market, now: NOW });
        expect(pricing.yesPrice).toBeGreaterThan(30);
        expect(pricing.yesPrice).toBeLessThan(70);
    });

    test('the two sides together cost more than the payout - that is the house edge', async () => {
        const market = openMarket({ threshold: 55 });
        const pricing = await predictionService.quote({ market, now: NOW });
        expect(pricing.yesPrice + pricing.noPrice).toBeGreaterThan(pricing.payout);
    });

    test('a BELOW market is the mirror of the ABOVE market', async () => {
        const above = await predictionService.quote({ market: openMarket({ threshold: 55 }), now: NOW });
        const below = await predictionService.quote({ market: openMarket({ threshold: 55, comparator: 'BELOW' }), now: NOW });
        expect(above.probability + below.probability).toBeCloseTo(1, 3);
    });
});

describe('trading contracts', () => {
    test('buying debits the price and promises 100 per contract', async () => {
        const market = openMarket();
        const fill = await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 10, now: NOW });
        expect(fill.cost).toBe(fill.price * 10);
        expect(fill.maxPayout).toBe(1000);
        expect(economyService.getBalance(GUILD, USER)).toBe(100_000 - fill.cost);
        expect(economyService.getHistory({ guildId: GUILD, userId: USER })[0]).toMatchObject({ type: 'prediction-buy' });
    });

    test('repeat buys average into one position', async () => {
        const market = openMarket();
        await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 5, now: NOW });
        const second = await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 15, now: NOW });
        expect(second.position.contracts).toBe(20);
        expect(predictionService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(1);
    });

    test('the per-trader cap stops one whale owning the outcome', async () => {
        const market = openMarket({ positionCap: 20 });
        await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 20, now: NOW });
        await expect(predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 1, now: NOW }))
            .rejects.toMatchObject({ code: 'POSITION_CAP' });
    });

    test('trading stops once the market closes', async () => {
        const market = openMarket();
        await expect(predictionService.buy({
            guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 1,
            now: new Date('2026-08-06T00:00:00Z')
        })).rejects.toMatchObject({ code: 'MARKET_CLOSED' });
    });
});

describe('settlement', () => {
    test('pays the winning side 100 per contract and the losing side nothing', async () => {
        const market = openMarket();
        const yes = await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 10, now: NOW });
        const no = await predictionService.buy({ guildId: GUILD, userId: OTHER, marketId: market.id, side: 'NO', contracts: 10, now: NOW });

        PRICES.RKLB = 75; // above the $60 threshold: YES wins
        const settled = await predictionService.settleDue({ guildId: GUILD, now: new Date('2026-08-05T20:30:00Z') });

        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ outcome: 'YES', settlePrice: 75, paid: 1000, winners: 1 });
        expect(economyService.getBalance(GUILD, USER)).toBe(100_000 - yes.cost + 1000);
        expect(economyService.getBalance(GUILD, OTHER)).toBe(100_000 - no.cost);
    });

    test('settles from the real price, not from who wanted what', async () => {
        const market = openMarket();
        await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 50, now: NOW });
        PRICES.RKLB = 59.99;
        const settled = await predictionService.settleDue({ guildId: GUILD, now: new Date('2026-08-05T20:30:00Z') });
        expect(settled[0].outcome).toBe('NO');
        expect(settled[0].paid).toBe(0);
    });

    test('a price outage defers settlement instead of guessing', async () => {
        const market = openMarket();
        await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 1, now: NOW });
        stockService.getQuote.mockRejectedValue(new Error('feed down'));
        const settled = await predictionService.settleDue({ guildId: GUILD, now: new Date('2026-08-05T20:30:00Z') });
        expect(settled).toHaveLength(0);
        expect(predictionService.getMarket({ guildId: GUILD, id: market.id }).status).not.toBe('SETTLED');
    });

    test('voiding a market refunds every contract at cost', async () => {
        const market = openMarket();
        const fill = await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 10, now: NOW });
        const voided = predictionService.voidMarket({ guildId: GUILD, id: market.id, reason: 'bad threshold', now: NOW });
        expect(voided.refunded).toBe(fill.cost);
        expect(economyService.getBalance(GUILD, USER)).toBe(100_000);
        expect(voided.market.status).toBe('VOID');
    });

    test('settlement is recorded in the audit trail', async () => {
        const market = openMarket();
        await predictionService.buy({ guildId: GUILD, userId: USER, marketId: market.id, side: 'YES', contracts: 3, now: NOW });
        PRICES.RKLB = 80;
        await predictionService.settleDue({ guildId: GUILD, now: new Date('2026-08-05T20:30:00Z') });
        const events = require('@goobster/core/services/exchange/exchangeEvents').list({ guildId: GUILD, types: ['market-settle'] });
        expect(events[0].detail).toMatchObject({ outcome: 'YES', settlePrice: 80 });
    });
});
