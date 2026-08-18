/**
 * The options wing: simulated chains, buying and closing contracts, the 0DTE
 * goblin-mode gate, and cash settlement at expiry.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-options-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const economyService = require('../services/economyService');
const stockService = require('../services/stockService');
const exchangeConfig = require('../services/exchange/exchangeConfig');
const accountService = require('../services/exchange/accountService');
const optionsMarket = require('../services/exchange/optionsMarket');
const optionsService = require('../services/exchange/optionsService');

const GUILD = '700000000000000001';
const USER = '700000000000000002';

// A fixed "now" keeps every expiry calculation in these tests deterministic.
const NOW = new Date('2026-07-29T14:00:00Z');
const TODAY = '2026-07-29';
const NEXT_MONTH = '2026-08-28';

const PRICES = { '^GSPC': 6000, AAPL: 200 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('../services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return {
        symbol: resolved, name: `${resolved} Index`, price, currency: 'USD',
        asOf: '2026-07-29 14:00:00', cached: false, stale: false
    };
}

function reset() {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'exchange_accounts',
        'exchange_settings', 'option_positions', 'option_trades', 'exchange_events', 'stock_symbols'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { '^GSPC': 6000, AAPL: 200 });
}

function fund(points) {
    economyService.getWallet(GUILD, USER);
    db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u',
        { g: GUILD, u: USER, points });
}

beforeEach(() => {
    reset();
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    // A flat 30% annualized series, so every premium in these tests is
    // reproducible without touching the network.
    jest.spyOn(stockService, 'getHistory').mockImplementation(async symbol => {
        const resolved = stockService.normalizeSymbol(symbol);
        const closes = [];
        let price = PRICES[resolved] || 100;
        for (let i = 0; i < 60; i++) {
            price *= i % 2 ? 1.019 : 1 / 1.019; // ~30% annualized
            closes.push(price);
        }
        return { symbol: resolved, currency: 'USD', points: closes.map((close, i) => ({ date: `2026-05-${i + 1}`, close })) };
    });
    exchangeConfig.set(GUILD, { optionsEnabled: true });
    fund(1_000_000);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('the simulated chain', () => {
    test('resolves spoken index tickers to their quote symbols', () => {
        expect(optionsMarket.resolveUnderlying('spx')).toMatchObject({ symbol: '^GSPC', alias: 'SPX', isIndex: true });
        expect(optionsMarket.resolveUnderlying('aapl')).toMatchObject({ symbol: 'AAPL', alias: null, isIndex: false });
    });

    test('quotes a contract with greeks, break-even, and both probabilities', async () => {
        const contract = await optionsMarket.quoteContract({
            symbol: 'SPX', optionType: 'CALL', strike: 6000, expiry: NEXT_MONTH, guildId: GUILD, now: NOW
        });
        expect(contract.underlying).toBe('^GSPC');
        expect(contract.ask).toBeGreaterThan(contract.bid);
        expect(contract.greeks.delta).toBeGreaterThan(0.4);
        expect(contract.greeks.delta).toBeLessThan(0.7);
        expect(contract.greeks.theta).toBeLessThan(0);
        expect(contract.breakEven).toBeGreaterThan(6000);
        expect(contract.probabilityOfProfit).toBeLessThan(contract.probabilityItm);
        expect(contract.simulated).toBe(true);
        expect(contract.costPerContract).toBe(Math.ceil(contract.ask * 100));
    });

    test('a put gains value as the underlying falls', async () => {
        const rich = await optionsMarket.quoteContract({
            symbol: 'AAPL', optionType: 'PUT', strike: 200, expiry: NEXT_MONTH, guildId: GUILD, now: NOW
        });
        PRICES.AAPL = 160;
        const richer = await optionsMarket.quoteContract({
            symbol: 'AAPL', optionType: 'PUT', strike: 200, expiry: NEXT_MONTH, guildId: GUILD, now: NOW
        });
        expect(richer.mid).toBeGreaterThan(rich.mid);
        expect(richer.greeks.delta).toBeLessThan(rich.greeks.delta);
    });

    test('same-day contracts are marked, priced thinner, and decay hardest', async () => {
        const sameDay = await optionsMarket.quoteContract({
            symbol: 'SPX', optionType: 'CALL', strike: 6000, expiry: TODAY, guildId: GUILD, now: NOW
        });
        const monthly = await optionsMarket.quoteContract({
            symbol: 'SPX', optionType: 'CALL', strike: 6000, expiry: NEXT_MONTH, guildId: GUILD, now: NOW
        });
        expect(sameDay.zeroDte).toBe(true);
        expect(sameDay.mid).toBeLessThan(monthly.mid);
        expect(Math.abs(sameDay.greeks.theta)).toBeGreaterThan(Math.abs(monthly.greeks.theta));
        // Gamma mode: a same-day at-the-money contract is all convexity
        expect(sameDay.greeks.gamma).toBeGreaterThan(monthly.greeks.gamma);
    });

    test('a far out-of-the-money same-day call is a lottery ticket', async () => {
        const lottery = await optionsMarket.quoteContract({
            symbol: 'SPX', optionType: 'CALL', strike: 6600, expiry: TODAY, guildId: GUILD, now: NOW
        });
        expect(lottery.probabilityItm).toBeLessThan(0.02);
        expect(lottery.mid).toBeLessThan(5);
    });

    test('builds a chain of calls and puts centred on the money', async () => {
        const chain = await optionsMarket.buildChain({ symbol: 'SPX', expiry: NEXT_MONTH, depth: 3, guildId: GUILD, now: NOW });
        expect(chain.rows).toHaveLength(7);
        expect(chain.spot).toBe(6000);
        const strikes = chain.rows.map(row => row.strike);
        expect(Math.min(...strikes)).toBeLessThan(6000);
        expect(Math.max(...strikes)).toBeGreaterThan(6000);
        for (const row of chain.rows) {
            expect(row.call.optionType).toBe('CALL');
            expect(row.put.optionType).toBe('PUT');
        }
    });

    test('the default chain expiry skips 0DTE unless the guild enabled it', async () => {
        // NOW is a weekday before the bell, so the front expiry is today's
        // 0DTE contract. With same-day trading off (the default), the chain
        // must open on an expiry the guild can actually trade...
        const gated = await optionsMarket.buildChain({ symbol: 'SPX', depth: 1, guildId: GUILD, now: NOW });
        expect(gated.expiry).not.toBe(TODAY);
        expect(gated.zeroDte).toBe(false);
        expect(gated.expiries[0]).toMatchObject({ expiry: TODAY, zeroDte: true });

        // ...with same-day trading on, the front expiry is the default...
        exchangeConfig.set(GUILD, { zeroDteEnabled: true });
        const front = await optionsMarket.buildChain({ symbol: 'SPX', depth: 1, guildId: GUILD, now: NOW });
        expect(front.expiry).toBe(TODAY);
        expect(front.zeroDte).toBe(true);

        // ...and an explicit request is never overridden (viewing is fine,
        // only trading is gated).
        exchangeConfig.set(GUILD, { zeroDteEnabled: false });
        const explicit = await optionsMarket.buildChain({
            symbol: 'SPX', expiry: TODAY, depth: 1, guildId: GUILD, now: NOW
        });
        expect(explicit.expiry).toBe(TODAY);
        expect(explicit.zeroDte).toBe(true);
    });

    test('the expiry calendar leads with today and skips weekends', () => {
        const expiries = optionsMarket.listExpiries({ now: NOW });
        expect(expiries[0]).toMatchObject({ expiry: TODAY, zeroDte: true });
        for (const entry of expiries) {
            const day = new Date(`${entry.expiry}T12:00:00Z`).getUTCDay();
            expect(day).not.toBe(0);
            expect(day).not.toBe(6);
        }
    });

    test('refuses an expiry that already settled', async () => {
        await expect(optionsMarket.buildChain({ symbol: 'SPX', expiry: '2026-07-01', guildId: GUILD, now: NOW }))
            .rejects.toMatchObject({ code: 'EXPIRED' });
    });
});

describe('buying contracts', () => {
    test('debits the full premium and opens a position', async () => {
        const fill = await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 210, expiry: NEXT_MONTH, contracts: 2, now: NOW
        });
        expect(fill.contracts).toBe(2);
        expect(fill.cost).toBe(fill.contract.costPerContract * 2);
        expect(fill.maxLoss).toBe(fill.cost);
        expect(economyService.getBalance(GUILD, USER)).toBe(1_000_000 - fill.cost);
        expect(fill.position).toMatchObject({ underlying: 'AAPL', optionType: 'CALL', strike: 210, contracts: 2, status: 'OPEN' });
        expect(economyService.getHistory({ guildId: GUILD, userId: USER })[0]).toMatchObject({ type: 'option-buy' });
    });

    test('repeat buys average into one lot', async () => {
        await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 210, expiry: NEXT_MONTH, contracts: 1, now: NOW
        });
        const second = await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 210, expiry: NEXT_MONTH, contracts: 3, now: NOW
        });
        expect(second.position.contracts).toBe(4);
        expect(optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(1);
    });

    test('premium is never borrowed, even on a margin account', async () => {
        exchangeConfig.set(GUILD, { optionsEnabled: true, marginEnabled: true, maxLeverage: 4 });
        accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        accountService.setLeverage({ guildId: GUILD, userId: USER, leverage: 4 });
        db.run('UPDATE economy_wallets SET balance = 100 WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER });

        await expect(optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 200, expiry: NEXT_MONTH, contracts: 5, now: NOW
        })).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
        expect(accountService.getAccount(GUILD, USER).marginLoan).toBe(0);
    });

    test('options are refused entirely when the guild has not enabled them', async () => {
        exchangeConfig.set(GUILD, { optionsEnabled: false });
        await expect(optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 200, expiry: NEXT_MONTH, contracts: 1, now: NOW
        })).rejects.toMatchObject({ code: 'FEATURE_OFF' });
    });
});

describe('the 0DTE gate', () => {
    test('same-day contracts need the guild switch AND goblin mode', async () => {
        const order = {
            guildId: GUILD, userId: USER, symbol: 'SPX', optionType: 'CALL',
            strike: 6000, expiry: TODAY, contracts: 1, now: NOW
        };

        // Guild has options on, but not 0DTE
        await expect(optionsService.buyToOpen(order)).rejects.toMatchObject({ code: 'FEATURE_OFF' });

        exchangeConfig.set(GUILD, { optionsEnabled: true, zeroDteEnabled: true });
        await expect(optionsService.buyToOpen(order)).rejects.toMatchObject({ code: 'GOBLIN_MODE_REQUIRED' });

        accountService.setGoblinMode({ guildId: GUILD, userId: USER, enabled: true });
        const fill = await optionsService.buyToOpen(order);
        expect(fill.contract.zeroDte).toBe(true);
    });

    test('goblin mode cannot be switched on when the guild forbids 0DTE', () => {
        expect(() => accountService.setGoblinMode({ guildId: GUILD, userId: USER, enabled: true }))
            .toThrow(/switched off/i);
    });

    test('the opt-in itself is audited', () => {
        exchangeConfig.set(GUILD, { optionsEnabled: true, zeroDteEnabled: true });
        accountService.setGoblinMode({ guildId: GUILD, userId: USER, enabled: true });
        const events = require('../services/exchange/exchangeEvents').list({ guildId: GUILD, userId: USER });
        expect(events[0]).toMatchObject({ eventType: 'goblin-mode-on' });
    });

    test('a later expiry never needs goblin mode', async () => {
        const fill = await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'SPX', optionType: 'CALL',
            strike: 6000, expiry: NEXT_MONTH, contracts: 1, now: NOW
        });
        expect(fill.contract.zeroDte).toBe(false);
    });
});

describe('closing and settlement', () => {
    async function openCall(strike = 200, expiry = NEXT_MONTH) {
        return optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike, expiry, contracts: 1, now: NOW
        });
    }

    test('selling to close credits the bid and books the result', async () => {
        const fill = await openCall(200);
        PRICES.AAPL = 240;
        const close = await optionsService.sellToClose({
            guildId: GUILD, userId: USER, positionId: fill.positionId, now: NOW
        });
        expect(close.proceeds).toBeGreaterThan(fill.cost);
        expect(close.realized).toBeGreaterThan(0);
        expect(close.position.status).toBe('CLOSED');
        expect(economyService.getBalance(GUILD, USER)).toBe(1_000_000 - fill.cost + close.proceeds);
    });

    test('a partial close leaves the rest of the lot open', async () => {
        const fill = await optionsService.buyToOpen({
            guildId: GUILD, userId: USER, symbol: 'AAPL', optionType: 'CALL',
            strike: 200, expiry: NEXT_MONTH, contracts: 4, now: NOW
        });
        const close = await optionsService.sellToClose({
            guildId: GUILD, userId: USER, positionId: fill.positionId, contracts: 1, now: NOW
        });
        expect(close.position).toMatchObject({ contracts: 3, status: 'OPEN' });
    });

    test('an in-the-money contract settles for its intrinsic value', async () => {
        const fill = await openCall(200, TODAY_EXPIRY());
        PRICES.AAPL = 260;
        const settled = await optionsService.settleExpired({ guildId: GUILD, now: afterTheBell() });

        expect(settled).toHaveLength(1);
        expect(settled[0].status).toBe('EXERCISED');
        expect(settled[0].payout).toBe(6000); // (260 - 200) x 100
        expect(economyService.getBalance(GUILD, USER)).toBe(1_000_000 - fill.cost + 6000);
        expect(economyService.getHistory({ guildId: GUILD, userId: USER })[0]).toMatchObject({ type: 'option-settle' });
    });

    test('an out-of-the-money contract expires worthless and pays nothing', async () => {
        const fill = await openCall(260, TODAY_EXPIRY());
        PRICES.AAPL = 190;
        const settled = await optionsService.settleExpired({ guildId: GUILD, now: afterTheBell() });

        expect(settled[0]).toMatchObject({ status: 'EXPIRED', payout: 0 });
        expect(settled[0].realized).toBe(-fill.cost);
        expect(economyService.getBalance(GUILD, USER)).toBe(1_000_000 - fill.cost);
        expect(optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(0);
    });

    test('settlement defers rather than expiring a contract on a feed outage', async () => {
        await openCall(200, TODAY_EXPIRY());
        stockService.getQuote.mockRejectedValue(new Error('feed down'));
        const settled = await optionsService.settleExpired({ guildId: GUILD, now: afterTheBell() });
        expect(settled).toHaveLength(0);
        expect(optionsService.listPositions({ guildId: GUILD, userId: USER })).toHaveLength(1);
    });

    test('a contract past its bell can no longer be traded by hand', async () => {
        const fill = await openCall(200, TODAY_EXPIRY());
        await expect(optionsService.sellToClose({
            guildId: GUILD, userId: USER, positionId: fill.positionId, now: afterTheBell()
        })).rejects.toMatchObject({ code: 'EXPIRED' });
    });
});

/** Today's expiry, with goblin mode already unlocked for the buyer. */
function TODAY_EXPIRY() {
    exchangeConfig.set(GUILD, { optionsEnabled: true, zeroDteEnabled: true });
    accountService.setGoblinMode({ guildId: GUILD, userId: USER, enabled: true });
    return TODAY;
}

function afterTheBell() {
    return new Date('2026-07-29T20:30:00Z');
}
