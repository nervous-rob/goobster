/**
 * Multi-leg spreads: payoff analysis, structure recognition, the pre-trade
 * receipt, atomic execution, and the unwind that keeps a failed spread from
 * half-existing.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-spreads-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const optionsService = require('@goobster/core/services/exchange/optionsService');
const spreadMath = require('@goobster/core/services/exchange/spreadMath');
const spreadService = require('@goobster/core/services/exchange/spreadService');
const { parseLegText } = require('@goobster/core/services/exchange/spreadService');

const GUILD = '960000000000000001';
const USER = '960000000000000002';

const NOW = new Date('2026-07-29T14:00:00Z');
const EXPIRY = '2026-09-02';
const PRICES = { SPCX: 115 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('@goobster/core/services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: 'Space Exploration Technologies', price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

async function fund(points) {
    await economyService.getWallet(GUILD, USER);
    await db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER, points });
}

// The Data Daddy's inverse iron condor, verbatim from the transcript:
// puts at 100 and 76, calls at 130 and 155, expiring September 2
const CONDOR_TEXT = 'buy 100p, sell 76p, buy 130c, sell 155c';

beforeEach(async () => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'exchange_accounts',
        'exchange_settings', 'option_positions', 'option_trades', 'exchange_events', 'stock_symbols'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
    PRICES.SPCX = 115;
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    jest.spyOn(stockService, 'getHistory').mockImplementation(async symbol => {
        const closes = [];
        let price = 115;
        for (let i = 0; i < 60; i++) {
            price *= i % 2 ? 1.025 : 1 / 1.025;
            closes.push(price);
        }
        return { symbol, currency: 'USD', points: closes.map((close, i) => ({ date: `2026-05-${i + 1}`, close })) };
    });
    await exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true, maxLeverage: 4 });
    await fund(50_000);
    await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('leg parsing', () => {
    test('reads the compact syntax with counts', () => {
        const legs = parseLegText('buy 100p, sell 76p x2, buy 130c', { expiry: EXPIRY, contracts: 1 });
        expect(legs).toEqual([
            { action: 'BUY', optionType: 'PUT', strike: 100, contracts: 1, expiry: EXPIRY },
            { action: 'SELL', optionType: 'PUT', strike: 76, contracts: 2, expiry: EXPIRY },
            { action: 'BUY', optionType: 'CALL', strike: 130, contracts: 1, expiry: EXPIRY }
        ]);
    });

    test('rejects gibberish with the offending leg named', () => {
        expect(() => parseLegText('buy 100p, yeet 5x', { expiry: EXPIRY }))
            .toThrow(/Could not read the leg "yeet 5x"/);
    });
});

describe('payoff analysis', () => {
    test('a bull call debit spread has capped gain and capped loss', () => {
        const analysis = spreadMath.analyzeSpread({
            legs: [
                { action: 'BUY', optionType: 'CALL', strike: 100, contracts: 1 },
                { action: 'SELL', optionType: 'CALL', strike: 110, contracts: 1 }
            ],
            netDebit: 400
        });
        expect(analysis).toMatchObject({ maxGain: 600, maxLoss: -400, unboundedGain: false, unboundedLoss: false });
        expect(analysis.breakEvens).toEqual([104]);
    });

    test('a naked-ish ratio spread reports unbounded loss', () => {
        const analysis = spreadMath.analyzeSpread({
            legs: [
                { action: 'BUY', optionType: 'CALL', strike: 100, contracts: 1 },
                { action: 'SELL', optionType: 'CALL', strike: 110, contracts: 2 }
            ],
            netDebit: 100
        });
        expect(analysis.unboundedLoss).toBe(true);
        expect(analysis.maxLoss).toBeNull();
    });

    test('a long straddle profits on either tail', () => {
        const analysis = spreadMath.analyzeSpread({
            legs: [
                { action: 'BUY', optionType: 'CALL', strike: 100, contracts: 1 },
                { action: 'BUY', optionType: 'PUT', strike: 100, contracts: 1 }
            ],
            netDebit: 800
        });
        expect(analysis.unboundedGain).toBe(true);
        expect(analysis.maxLoss).toBe(-800);
        expect(analysis.breakEvens).toEqual([92, 108]);
    });

    test('recognizes the classic structures by their legs', () => {
        const condor = parseLegText(CONDOR_TEXT, { expiry: EXPIRY });
        expect(spreadMath.classifySpread(condor)).toBe('inverse iron condor (long volatility)');

        const shortCondor = parseLegText('sell 100p, buy 76p, sell 130c, buy 155c', { expiry: EXPIRY });
        expect(spreadMath.classifySpread(shortCondor)).toBe('iron condor (short volatility)');

        expect(spreadMath.classifySpread(parseLegText('buy 115c, buy 115p', { expiry: EXPIRY }))).toBe('long straddle');
        expect(spreadMath.classifySpread(parseLegText('buy 100c, sell 110c', { expiry: EXPIRY }))).toBe('bull call spread (debit)');
        expect(spreadMath.classifySpread(parseLegText('buy 100c, sell 110c x2, buy 120c', { expiry: EXPIRY }))).toBe('long butterfly');
    });
});

describe('the pre-trade receipt', () => {
    test('prices every leg and reports outcomes, collateral, and the caveats', async () => {
        const legs = parseLegText(CONDOR_TEXT, { expiry: EXPIRY });
        const receipt = await spreadService.quote({ guildId: GUILD, symbol: 'SPCX', legs, now: NOW });

        expect(receipt.structure).toBe('inverse iron condor (long volatility)');
        expect(receipt.legs).toHaveLength(4);
        expect(receipt.netPoints).toBeGreaterThan(0); // long-vol condor is a net debit
        expect(receipt.netLabel).toBe('debit');
        expect(receipt.maxLoss).toBeLessThan(0);
        expect(receipt.maxGain).toBeGreaterThan(0);
        expect(receipt.breakEvens.length).toBeGreaterThanOrEqual(2);
        expect(receipt.needsMarginAccount).toBe(true); // it has sell legs
        expect(receipt.simulated).toBe(true);
        expect(receipt.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
        // The receipt never moves money
        expect(await economyService.getBalance(GUILD, USER)).toBe(50_000);
    });
});

describe('execution', () => {
    test('fires all four condor legs and nets the wallet by exactly the receipt', async () => {
        const legs = parseLegText(CONDOR_TEXT, { expiry: EXPIRY });
        const result = await spreadService.execute({ guildId: GUILD, userId: USER, symbol: 'SPCX', legs, now: NOW });

        expect(result.fills).toHaveLength(4);
        const positions = await optionsService.listPositions({ guildId: GUILD, userId: USER });
        expect(positions).toHaveLength(4);
        expect(positions.filter(p => p.side === 'SHORT')).toHaveLength(2);
        expect(await economyService.getBalance(GUILD, USER)).toBe(50_000 - result.netPoints);

        // In the inverse condor the LONG wings are the deeper-in-the-money
        // side, so both written wings are fully covered: a defined-risk net
        // debit needs no margin at all
        const snapshot = await accountService.getSnapshot({ guildId: GUILD, userId: USER, now: NOW });
        expect(snapshot.optionRequirement).toBe(0);
        expect(result.receipt.collateralRequired).toBe(0);
    });

    test('the SHORT condor (risky wings written) requires the strike widths', async () => {
        const legs = parseLegText('sell 100p, buy 76p, sell 130c, buy 155c', { expiry: EXPIRY });
        await spreadService.execute({ guildId: GUILD, userId: USER, symbol: 'SPCX', legs, now: NOW });
        const snapshot = await accountService.getSnapshot({ guildId: GUILD, userId: USER, now: NOW });
        expect(snapshot.optionRequirement).toBeCloseTo((100 - 76) * 100 + (155 - 130) * 100, -1);
    });

    test('a spread with sell legs is refused on a cash account before anything fills', async () => {
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'CASH' });
        const legs = parseLegText(CONDOR_TEXT, { expiry: EXPIRY });
        await expect(spreadService.execute({ guildId: GUILD, userId: USER, symbol: 'SPCX', legs, now: NOW }))
            .rejects.toMatchObject({ code: 'CASH_ACCOUNT' });
        expect(await optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(0);
    });

    test('an all-long spread works fine on a cash account', async () => {
        await accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'CASH' });
        const legs = parseLegText('buy 115c, buy 115p', { expiry: EXPIRY });
        const result = await spreadService.execute({ guildId: GUILD, userId: USER, symbol: 'SPCX', legs, now: NOW });
        expect(result.receipt.structure).toBe('long straddle');
        expect(await optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(2);
    });

    test('insufficient cash for the debit legs is refused up front', async () => {
        await fund(10);
        const legs = parseLegText(CONDOR_TEXT, { expiry: EXPIRY });
        await expect(spreadService.execute({ guildId: GUILD, userId: USER, symbol: 'SPCX', legs, now: NOW }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(await optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(0);
    });

    test('a failure mid-spread unwinds the filled legs - nothing half-exists', async () => {
        const legs = parseLegText(CONDOR_TEXT, { expiry: EXPIRY });
        // Sabotage the LAST leg (a sell): the buys will already have filled
        const original = optionsService.sellToOpen.bind(optionsService);
        let sells = 0;
        jest.spyOn(optionsService, 'sellToOpen').mockImplementation(async args => {
            if (++sells === 2) throw new Error('simulated mid-spread failure');
            return original(args);
        });

        await expect(spreadService.execute({ guildId: GUILD, userId: USER, symbol: 'SPCX', legs, now: NOW }))
            .rejects.toMatchObject({ code: 'SPREAD_FAILED' });

        const open = await optionsService.listPositions({ guildId: GUILD, userId: USER });
        expect(open).toHaveLength(0);
        // The unwind cost the bid/ask spread but the ledger explains every step
        const ledger = await economyService.getHistory({ guildId: GUILD, userId: USER, limit: 20 });
        expect(ledger.filter(row => row.type === 'option-buy').length).toBeGreaterThan(0);
        expect(ledger.filter(row => row.type === 'option-sell').length).toBeGreaterThan(0);
    });

    test('duplicate legs are rejected as a user error', () => {
        expect(() => spreadService._normalizeLegs([
            { action: 'BUY', optionType: 'CALL', strike: 130, contracts: 1, expiry: EXPIRY },
            { action: 'SELL', optionType: 'CALL', strike: 130, contracts: 1, expiry: EXPIRY }
        ])).toThrow(/combine them into one leg/);
    });
});
