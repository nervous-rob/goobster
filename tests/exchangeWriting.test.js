/**
 * Option writing: sell-to-open credit, margin requirements (naked, spread,
 * covered), buy-to-close, and assignment at settlement.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-writing-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const economyService = require('../services/economyService');
const stockService = require('../services/stockService');
const stockPortfolioService = require('../services/stockPortfolioService');
const exchangeConfig = require('../services/exchange/exchangeConfig');
const accountService = require('../services/exchange/accountService');
const optionsService = require('../services/exchange/optionsService');
const marginMath = require('../services/exchange/marginMath');

const GUILD = '950000000000000001';
const USER = '950000000000000002';

const NOW = new Date('2026-07-29T14:00:00Z');
const TODAY = '2026-07-29';
const EXPIRY = '2026-08-28';
const PRICES = { AAPL: 200 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('../services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: resolved, price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

function fund(points) {
    economyService.getWallet(GUILD, USER);
    db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER, points });
}

async function writeCall({ strike = 220, contracts = 1, expiry = EXPIRY } = {}) {
    return optionsService.sellToOpen({
        guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
        strike, expiry, contracts, now: NOW
    });
}

beforeEach(() => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings', 'stock_trades',
        'exchange_accounts', 'exchange_settings', 'option_positions', 'option_trades',
        'exchange_events', 'stock_symbols'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
    PRICES.AAPL = 200;
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    jest.spyOn(stockService, 'getHistory').mockImplementation(async symbol => {
        const closes = [];
        let price = 200;
        for (let i = 0; i < 60; i++) {
            price *= i % 2 ? 1.019 : 1 / 1.019;
            closes.push(price);
        }
        return { symbol, currency: 'USD', points: closes.map((close, i) => ({ date: `2026-05-${i + 1}`, close })) };
    });
    exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true, zeroDteEnabled: true, maxLeverage: 4 });
    fund(100_000);
    accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('the naked-requirement rule', () => {
    test('matches the classic broker formula', () => {
        // ATM call: mark 5, spot 100 -> (5 + 20) x 100 = 2500
        expect(marginMath.nakedShortRequirement({ spot: 100, strike: 100, optionType: 'CALL', mark: 5 }))
            .toBe(2500);
        // Deep OTM call: OTM amount eats the 20%, floor at 10% of spot
        expect(marginMath.nakedShortRequirement({ spot: 100, strike: 140, optionType: 'CALL', mark: 0.5 }))
            .toBe((0.5 + 10) * 100);
        // Puts floor at 10% of strike
        expect(marginMath.nakedShortRequirement({ spot: 100, strike: 60, optionType: 'PUT', mark: 0.3 }))
            .toBeCloseTo((0.3 + 6) * 100, 6);
    });

    test('a covered call requires nothing; a spread requires the width; naked pays in full', () => {
        const base = { underlying: 'AAPL', optionType: 'CALL', expiry: EXPIRY, contractSize: 100, mark: 4, spot: 200 };
        const shortLot = { ...base, id: 1, side: 'SHORT', strike: 210, contracts: 2 };

        const covered = marginMath.optionBookRequirement({
            positions: [shortLot], sharesBySymbol: { AAPL: 200 }
        });
        expect(covered.total).toBe(0);

        const spread = marginMath.optionBookRequirement({
            positions: [shortLot, { ...base, id: 2, side: 'LONG', strike: 220, contracts: 2 }]
        });
        expect(spread.total).toBe((220 - 210) * 100 * 2);

        const debitSide = marginMath.optionBookRequirement({
            positions: [shortLot, { ...base, id: 2, side: 'LONG', strike: 200, contracts: 2 }]
        });
        expect(debitSide.total).toBe(0); // the long is deeper in the money

        const naked = marginMath.optionBookRequirement({ positions: [shortLot] });
        expect(naked.total).toBeCloseTo(marginMath.nakedShortRequirement({ spot: 200, strike: 210, optionType: 'CALL', mark: 4 }) * 2, 6);
    });
});

describe('selling to open', () => {
    test('credits the bid premium and opens a SHORT lot', async () => {
        const fill = await writeCall({ strike: 220, contracts: 2 });
        expect(fill.credit).toBe(fill.contract.creditPerContract * 2);
        expect(economyService.getBalance(GUILD, USER)).toBe(100_000 + fill.credit);
        expect(fill.position).toMatchObject({ side: 'SHORT', contracts: 2, status: 'OPEN' });
        expect(fill.requirement).toBeGreaterThan(0);
        expect(economyService.getHistory({ guildId: GUILD, userId: USER })[0]).toMatchObject({ type: 'option-write' });
    });

    test('needs a margin account', async () => {
        accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'CASH' });
        await expect(writeCall()).rejects.toMatchObject({ code: 'CASH_ACCOUNT' });
    });

    test('a covered call requires no margin', async () => {
        await stockPortfolioService.buy({ guildId: GUILD, userId: USER, symbol: 'AAPL', units: 100 });
        const fill = await writeCall({ strike: 220, contracts: 1 });
        expect(fill.requirement).toBe(0);
    });

    test('writing beyond buying power is refused', async () => {
        fund(500);
        await expect(writeCall({ strike: 205, contracts: 50 }))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BUYING_POWER' });
        expect(optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(0);
    });

    test('same-day writes sit behind the same Goblin Mode gate', async () => {
        await expect(writeCall({ expiry: TODAY }))
            .rejects.toMatchObject({ code: 'GOBLIN_MODE_REQUIRED' });
        accountService.setGoblinMode({ guildId: GUILD, userId: USER, enabled: true });
        const fill = await writeCall({ expiry: TODAY });
        expect(fill.contract.zeroDte).toBe(true);
    });

    test('cannot write a contract already held long, or buy one already written', async () => {
        await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 220, expiry: EXPIRY, contracts: 1, now: NOW
        });
        await expect(writeCall({ strike: 220 })).rejects.toMatchObject({ code: 'LONG_HELD' });

        const written = await writeCall({ strike: 230 });
        await expect(optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 230, expiry: EXPIRY, contracts: 1, now: NOW
        })).rejects.toMatchObject({ code: 'SHORT_HELD' });
        expect(written.position.side).toBe('SHORT');
    });

    test('the short book weighs on equity and consumes buying power', async () => {
        const before = await accountService.getSnapshot({ guildId: GUILD, userId: USER, now: NOW });
        await writeCall({ strike: 210, contracts: 2 });
        const after = await accountService.getSnapshot({ guildId: GUILD, userId: USER, now: NOW });

        expect(after.optionShortValue).toBeGreaterThan(0);
        expect(after.optionRequirement).toBeGreaterThan(0);
        expect(after.maintenance).toBeGreaterThan(before.maintenance);
        expect(after.buyingPower).toBeLessThan(before.buyingPower + 10_000); // credit did not inflate it past the requirement
    });
});

describe('buying to close', () => {
    test('closes at the ask and books the premium difference', async () => {
        const fill = await writeCall({ strike: 220, contracts: 2 });
        PRICES.AAPL = 180; // the call collapses; buying back is cheap
        const close = await optionsService.buyToClose({
            guildId: GUILD, userId: USER, positionId: fill.positionId, now: NOW
        });
        expect(close.cost).toBeLessThan(fill.credit);
        expect(close.realized).toBe(fill.credit - close.cost);
        expect(close.position.status).toBe('CLOSED');
    });

    test('close routes are side-checked', async () => {
        const fill = await writeCall();
        await expect(optionsService.sellToClose({ guildId: GUILD, userId: USER, positionId: fill.positionId, now: NOW }))
            .rejects.toMatchObject({ code: 'WRONG_SIDE' });
    });
});

describe('assignment at the bell', () => {
    beforeEach(() => accountService.setGoblinMode({ guildId: GUILD, userId: USER, enabled: true }));

    test('an ITM written call pays the intrinsic value out of the wallet', async () => {
        const fill = await writeCall({ strike: 205, expiry: TODAY, contracts: 1 });
        PRICES.AAPL = 230;
        const settled = await optionsService.settleExpired({ guildId: GUILD, now: new Date('2026-07-29T20:30:00Z') });

        expect(settled[0].status).toBe('EXERCISED');
        const owed = Math.ceil((230 - 205) * 100);
        expect(settled[0].realized).toBe(fill.credit - owed);
        expect(economyService.getBalance(GUILD, USER)).toBe(100_000 + fill.credit - owed);
        expect(economyService.getHistory({ guildId: GUILD, userId: USER })[0]).toMatchObject({ type: 'option-assign' });
    });

    test('an OTM written call expires and the writer keeps the premium', async () => {
        const fill = await writeCall({ strike: 230, expiry: TODAY, contracts: 1 });
        PRICES.AAPL = 195;
        const settled = await optionsService.settleExpired({ guildId: GUILD, now: new Date('2026-07-29T20:30:00Z') });
        expect(settled[0]).toMatchObject({ status: 'EXPIRED' });
        expect(settled[0].realized).toBe(fill.credit);
        expect(economyService.getBalance(GUILD, USER)).toBe(100_000 + fill.credit);
    });

    test('an assignment the wallet cannot pay lands on the margin loan', async () => {
        const fill = await writeCall({ strike: 205, expiry: TODAY, contracts: 2 });
        db.run('UPDATE economy_wallets SET balance = 100 WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER });
        PRICES.AAPL = 260; // owes 2 x (260-205) x 100 = 11,000
        const settled = await optionsService.settleExpired({ guildId: GUILD, now: new Date('2026-07-29T20:30:00Z') });

        expect(settled[0].status).toBe('EXERCISED');
        expect(economyService.getBalance(GUILD, USER)).toBe(0);
        expect(accountService.getAccount(GUILD, USER).marginLoan).toBe(11_000 - 100);
        void fill;
    });
});
