/**
 * Perpetual futures: isolated margin, leverage caps, funding erosion, and
 * liquidation - plus real dividends and splits from the corporate-actions
 * sweep (they share a mocked market).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-perps-test-${process.pid}.sqlite`);
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
const perpsService = require('../services/exchange/perpsService');
const corporateActionsService = require('../services/exchange/corporateActionsService');

const GUILD = '970000000000000001';
const USER = '970000000000000002';
const OTHER = '970000000000000003';

const NOW = new Date('2026-07-29T14:00:00Z');
const PRICES = { 'BTC-USD': 100_000, AAPL: 200 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('../services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: resolved, price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

function fund(userId, points) {
    economyService.getWallet(GUILD, userId);
    db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId, points });
}

beforeEach(() => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings', 'stock_trades',
        'exchange_accounts', 'exchange_settings', 'short_positions', 'exchange_orders',
        'option_positions', 'perp_positions', 'corporate_actions', 'prediction_markets',
        'exchange_events', 'stock_symbols'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { 'BTC-USD': 100_000, AAPL: 200 });
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true, futuresEnabled: true, maxPerpLeverage: 20 });
    fund(USER, 100_000);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('opening perps', () => {
    test('escrows the margin and reports the liquidation price', async () => {
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG',
            margin: 10_000, leverage: 10, now: NOW
        });
        expect(position.notional).toBe(100_000);
        expect(position.units).toBeCloseTo(1, 6);
        expect(economyService.getBalance(GUILD, USER)).toBe(90_000);
        // 10x long with a 20% buffer: liquidation 8% below entry
        expect(position.liquidationPrice).toBeCloseTo(100_000 * (1 - 0.08), 0);
        expect(economyService.getHistory({ guildId: GUILD, userId: USER })[0]).toMatchObject({ type: 'perp-open', amount: -10_000 });
    });

    test('needs the guild feature and respects the leverage cap', async () => {
        await expect(perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 100, leverage: 50, now: NOW
        })).rejects.toMatchObject({ code: 'BAD_LEVERAGE' });

        exchangeConfig.set(GUILD, { futuresEnabled: false });
        await expect(perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 100, leverage: 5, now: NOW
        })).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    });

    test('works on a plain cash account - the margin is the whole risk', async () => {
        expect(accountService.getAccount(GUILD, USER).accountType).toBe('CASH');
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'SHORT', margin: 1_000, leverage: 5, now: NOW
        });
        expect(position.direction).toBe('SHORT');
    });
});

describe('closing and liquidation', () => {
    test('a winning long returns margin plus profit', async () => {
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 10_000, leverage: 5, now: NOW
        });
        PRICES['BTC-USD'] = 110_000; // +10% on 5x = +50%
        const result = await perpsService.close({ guildId: GUILD, userId: USER, id: position.id, now: NOW });
        expect(result.realized).toBeCloseTo(5_000, -1);
        expect(economyService.getBalance(GUILD, USER)).toBe(90_000 + result.payout);
    });

    test('a losing short can never lose more than its margin', async () => {
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'SHORT', margin: 1_000, leverage: 10, now: NOW
        });
        PRICES['BTC-USD'] = 200_000; // catastrophic squeeze
        const result = await perpsService.close({ guildId: GUILD, userId: USER, id: position.id, now: NOW });
        expect(result.payout).toBe(0);
        expect(result.realized).toBe(-1_000);
        expect(economyService.getBalance(GUILD, USER)).toBe(99_000);
    });

    test('the sweep liquidates a position whose mark crossed the line', async () => {
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 10_000, leverage: 10, now: NOW
        });
        PRICES['BTC-USD'] = 91_000; // below the ~92,000 liquidation price
        const result = await perpsService.sweep({ guildId: GUILD, now: NOW });

        expect(result.liquidated).toHaveLength(1);
        const row = perpsService.getPosition({ guildId: GUILD, userId: USER, id: position.id });
        expect(row.status).toBe('LIQUIDATED');
        // The 20% buffer remnant came back, most of the margin did not
        expect(row.payout).toBeLessThan(3_000);
        expect(require('../services/exchange/exchangeEvents').list({ guildId: GUILD, types: ['perp-liquidation'] })).toHaveLength(1);
    });

    test('funding rent erodes the margin over time', async () => {
        exchangeConfig.set(GUILD, { futuresEnabled: true, maxPerpLeverage: 20, fundingRateDaily: 0.01 });
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 10_000, leverage: 10, now: NOW
        });
        const fiveDays = new Date(NOW.getTime() + 5 * 86_400_000);
        await perpsService.sweep({ guildId: GUILD, now: fiveDays });

        const row = perpsService.getPosition({ guildId: GUILD, userId: USER, id: position.id });
        expect(row.fundingAccrued).toBeCloseTo(100_000 * 0.01 * 5, -2); // 5,000 of rent
        // Closing now returns margin - funding (price unchanged)
        const result = await perpsService.close({ guildId: GUILD, userId: USER, id: position.id, now: fiveDays });
        expect(result.payout).toBeCloseTo(5_000, -2);
    });

    test('funding that fully eats the margin liquidates the position', async () => {
        exchangeConfig.set(GUILD, { futuresEnabled: true, maxPerpLeverage: 20, fundingRateDaily: 0.01 });
        const position = await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 10_000, leverage: 10, now: NOW
        });
        // 10 days at 1%/day of a 100k notional = the whole margin
        const tenDays = new Date(NOW.getTime() + 10 * 86_400_000);
        const result = await perpsService.sweep({ guildId: GUILD, now: tenDays });
        expect(result.liquidated).toHaveLength(1);
        expect(result.liquidated[0].payout).toBe(0);
        expect(perpsService.getPosition({ guildId: GUILD, userId: USER, id: position.id }).status).toBe('LIQUIDATED');
    });

    test('a feed outage never liquidates a perp', async () => {
        await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 10_000, leverage: 10, now: NOW
        });
        stockService.getQuote.mockRejectedValue(new Error('feed down'));
        const result = await perpsService.sweep({ guildId: GUILD, now: NOW });
        expect(result.liquidated).toHaveLength(0);
    });

    test('marked perps appear in the account snapshot without becoming collateral', async () => {
        await perpsService.open({
            guildId: GUILD, userId: USER, symbol: 'BTC-USD', direction: 'LONG', margin: 10_000, leverage: 5, now: NOW
        });
        PRICES['BTC-USD'] = 105_000;
        const snapshot = await accountService.getSnapshot({ guildId: GUILD, userId: USER, now: NOW });
        expect(snapshot.perps).toHaveLength(1);
        expect(snapshot.perpValue).toBeCloseTo(12_500, -1); // margin + 25% gain
        expect(snapshot.equity).toBeCloseTo(90_000 + 12_500, -1);
        // Cash account: buying power stays the wallet, untouched by the perp
        expect(snapshot.buyingPower).toBe(90_000);
    });
});

describe('corporate actions', () => {
    beforeEach(() => {
        jest.spyOn(corporateActionsService, 'fetchEvents').mockResolvedValue({ dividends: [], splits: [] });
    });

    test('the first sweep records history without applying it', async () => {
        fund(USER, 10_000);
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 10 });
        corporateActionsService.fetchEvents.mockResolvedValue({
            dividends: [{ date: '2026-07-20', amount: 1 }], splits: []
        });
        const result = await corporateActionsService.sweep({ now: NOW });
        expect(result.applied).toHaveLength(0);
        expect(db.get('SELECT COUNT(*) AS c FROM corporate_actions').c).toBe(1);
        // Nobody got paid for history that predates our knowledge
        expect(economyService.getBalance(GUILD, USER)).toBe(10_000 - 2_000);
    });

    test('a new dividend pays longs and charges shorts', async () => {
        fund(USER, 10_000);
        fund(OTHER, 10_000);
        accountService.setAccountType({ guildId: GUILD, userId: OTHER, accountType: 'MARGIN' });
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 10 });
        await shortService.openShort({ guildId: GUILD, userId: OTHER, symbol: 'AAPL', units: 4, now: NOW });

        // First sweep primes the symbol; the dividend arrives afterwards
        await corporateActionsService.sweep({ now: NOW });
        corporateActionsService.fetchEvents.mockResolvedValue({
            dividends: [{ date: '2026-07-30', amount: 2.5 }], splits: []
        });
        const later = new Date(NOW.getTime() + 24 * 3_600_000);
        const result = await corporateActionsService.sweep({ now: later });

        expect(result.applied).toHaveLength(1);
        expect(result.applied[0]).toMatchObject({ type: 'DIVIDEND', paid: 25, collected: 10 });
        const longLedger = economyService.getHistory({ guildId: GUILD, userId: USER })[0];
        expect(longLedger).toMatchObject({ type: 'dividend', amount: 25 });
        const shortLedger = economyService.getHistory({ guildId: GUILD, userId: OTHER })[0];
        expect(shortLedger).toMatchObject({ type: 'dividend-short', amount: -10 });
    });

    test('a split adjusts units, prices, strikes, and thresholds without moving value', async () => {
        fund(USER, 50_000);
        accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 10 });
        jest.spyOn(stockService, 'getHistory').mockResolvedValue({
            symbol: 'AAPL', currency: 'USD',
            points: Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, close: 200 * (i % 2 ? 1.01 : 1 / 1.01) }))
        });
        await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 220, expiry: '2026-08-28', contracts: 1, now: NOW
        });
        await orderService.place({
            guildId: GUILD, userId: USER, symbol: 'AAPL', side: 'SELL', orderType: 'STOP', units: 10, stopPrice: 150
        });

        await corporateActionsService.sweep({ now: NOW }); // prime
        corporateActionsService.fetchEvents.mockResolvedValue({
            dividends: [], splits: [{ date: '2026-07-30', ratio: 2 }]
        });
        const balanceBefore = economyService.getBalance(GUILD, USER);
        await corporateActionsService.sweep({ now: new Date(NOW.getTime() + 24 * 3_600_000) });

        expect(db.get("SELECT units, costBasis FROM stock_holdings WHERE symbol = 'AAPL'"))
            .toMatchObject({ units: 20 }); // costBasis untouched: value conserved
        expect(db.get("SELECT strike, contracts FROM option_positions WHERE underlying = 'AAPL'"))
            .toMatchObject({ strike: 110, contracts: 2 });
        expect(db.get("SELECT stopPrice, units FROM exchange_orders WHERE symbol = 'AAPL'"))
            .toMatchObject({ stopPrice: 75, units: 20 });
        expect(economyService.getBalance(GUILD, USER)).toBe(balanceBefore); // splits move no money
    });
});
