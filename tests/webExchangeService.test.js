/**
 * Unit tests for the browser trading terminal (services/webExchangeService):
 * the guild-membership gate every method starts with, domain-error
 * translation into HTTP-shaped errors, and - the invariant that outranks
 * every feature here - that a web trade moves points through
 * economyService.adjust and lands in the wallet ledger, exactly like the
 * slash command does.
 *
 * The market data layer is mocked so the specs are deterministic and offline.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-webexchange-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const PRICE = 200;

jest.mock('@goobster/core/services/stockService', () => {
    class StockError extends Error {
        constructor(code, message) {
            super(message);
            this.code = code;
        }
    }
    return {
        StockError,
        HISTORY_RANGES: ['1mo', '3mo', '6mo', '1y'],
        normalizeSymbol: (symbol) => String(symbol || '').trim().toUpperCase(),
        getQuote: jest.fn(async (symbol) => {
            const normalized = String(symbol || '').trim().toUpperCase();
            if (normalized === 'NOPE') throw new StockError('UNKNOWN_SYMBOL', 'No such symbol: NOPE.');
            return {
                symbol: normalized, name: `${normalized} Inc.`, price: 200,
                currency: 'USD', asOf: '2026-01-02 15:00:00', cached: false, stale: false
            };
        }),
        getHistory: jest.fn(async (symbol, range) => ({
            symbol: String(symbol).toUpperCase(), range,
            currency: 'USD', points: [{ date: '2026-01-01', close: 190 }, { date: '2026-01-02', close: 200 }]
        })),
        search: jest.fn(async () => ([{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NMS', quoteType: 'EQUITY' }])),
        getSymbolInfo: jest.fn(() => null)
    };
});

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const webExchangeService = require('@goobster/core/services/webExchangeService');

const USER = '600000000000000001';
const OUTSIDER = '600000000000000002';
const GUILD = '700000000000000001';
const ABSENT_GUILD = '700000000000000009';

const client = {
    user: { id: '800000000000000001' },
    guilds: {
        cache: new Map([[GUILD, {
            id: GUILD,
            name: 'Test Guild',
            members: {
                fetch: async (userId) => {
                    if (userId !== USER) throw new Error('Unknown Member');
                    return { id: userId, displayName: 'rob', user: { username: 'rob' } };
                }
            }
        }]])
    }
};

beforeEach(() => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings',
        'stock_trades', 'short_positions', 'option_positions', 'option_trades',
        'exchange_orders', 'exchange_accounts', 'exchange_events', 'exchange_settings'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
});

/** Top the wallet up so premium-sized orders are affordable. */
function fund(amount) {
    return economyService.adjust({ guildId: GUILD, userId: USER, amount, type: 'test-grant' });
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('guild access', () => {
    test('a non-member is refused before any data is read', async () => {
        await expect(webExchangeService.overview({ client, guildId: GUILD, userId: OUTSIDER }))
            .rejects.toMatchObject({ status: 403, code: 'NOT_A_MEMBER' });
        // Nothing was created for the outsider
        expect(db.get(
            'SELECT COUNT(*) AS n FROM economy_wallets WHERE userId = @userId', { userId: OUTSIDER }
        ).n).toBe(0);
    });

    test('a guild Goobster is not in answers 404, and a bogus id 400', async () => {
        await expect(webExchangeService.overview({ client, guildId: ABSENT_GUILD, userId: USER }))
            .rejects.toMatchObject({ status: 404, code: 'UNKNOWN_GUILD' });
        await expect(webExchangeService.overview({ client, guildId: 'not-a-snowflake', userId: USER }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SCOPE' });
    });

    test('every mutating method checks membership too', async () => {
        const calls = [
            webExchangeService.tradeStock({ client, guildId: GUILD, userId: OUTSIDER, side: 'buy', symbol: 'AAPL', units: 1 }),
            webExchangeService.tradeOption({
                client, guildId: GUILD, userId: OUTSIDER, action: 'buy',
                symbol: 'AAPL', optionType: 'CALL', strike: 200, expiry: '2026-09-18', contracts: 1
            }),
            webExchangeService.placeOrder({
                client, guildId: GUILD, userId: OUTSIDER, symbol: 'AAPL',
                side: 'BUY', orderType: 'LIMIT', units: 1, limitPrice: 100
            }),
            webExchangeService.cancelOrder({ client, guildId: GUILD, userId: OUTSIDER, orderId: 1 })
        ];
        for (const call of calls) {
            await expect(call).rejects.toMatchObject({ status: 403, code: 'NOT_A_MEMBER' });
        }
    });
});

describe('overview', () => {
    test('reports the guild feature flags and a fresh account audit', async () => {
        const result = await webExchangeService.overview({ client, guildId: GUILD, userId: USER });

        // Everything risky is off until an admin opts the server in
        expect(result.features).toEqual({
            marginEnabled: false, optionsEnabled: false, zeroDteEnabled: false,
            predictionsEnabled: false, futuresEnabled: false
        });
        expect(result.audit.snapshot.account.accountType).toBe('CASH');
        expect(result.audit.snapshot.cash).toBe(result.audit.ledger.net);
        expect(result.audit.ledger.reconciles).toBe(true);
        expect(result.currencyName).toBeTruthy();
    });

    test('follows the feature switches once an admin flips them', async () => {
        exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true });
        const result = await webExchangeService.overview({ client, guildId: GUILD, userId: USER });
        expect(result.features).toEqual(expect.objectContaining({
            marginEnabled: true, optionsEnabled: true, futuresEnabled: false
        }));
    });
});

describe('stock trading', () => {
    test('a web buy moves points through the ledger and records the fill', async () => {
        const opening = economyService.getBalance(GUILD, USER);
        const result = await webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'buy', symbol: 'aapl', units: 2
        });

        expect(result).toEqual(expect.objectContaining({ symbol: 'AAPL', units: 2, price: PRICE }));
        expect(result.cost).toBe(2 * PRICE);
        expect(result.balance).toBe(opening - 2 * PRICE);
        // The wallet is what the service reported, and the ledger explains it
        expect(economyService.getBalance(GUILD, USER)).toBe(result.balance);
        const ledger = db.all(
            'SELECT amount, type FROM economy_transactions WHERE guildId = @g AND userId = @u ORDER BY id',
            { g: GUILD, u: USER }
        );
        expect(ledger.map(row => row.amount).reduce((a, b) => a + b, 0)).toBe(result.balance);
        expect(ledger.some(row => row.amount === -2 * PRICE)).toBe(true);
        expect(db.get(
            'SELECT units, side FROM stock_trades WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER }
        )).toEqual({ units: 2, side: 'BUY' });
    });

    test('selling with no units closes the whole position', async () => {
        await webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'buy', symbol: 'AAPL', units: 3
        });
        const result = await webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'sell', symbol: 'AAPL', units: null
        });
        expect(result.units).toBe(3);
        expect(db.get(
            'SELECT COUNT(*) AS n FROM stock_holdings WHERE guildId = @g AND userId = @u', { g: GUILD, u: USER }
        ).n).toBe(0);
    });

    test('an unsupported side is refused before the market is touched', async () => {
        await expect(webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'yolo', symbol: 'AAPL', units: 1
        })).rejects.toMatchObject({ status: 400, code: 'BAD_SIDE' });
    });

    test('shorting needs both the guild switch and a margin account', async () => {
        const short = () => webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'short', symbol: 'AAPL', units: 1
        });

        // Gate 1: the guild has not opted into margin at all
        await expect(short()).rejects.toMatchObject({ status: 400, code: 'FEATURE_OFF' });

        // Gate 2: the trader is still on a cash account
        exchangeConfig.set(GUILD, { marginEnabled: true });
        await expect(short()).rejects.toMatchObject({ status: 400 });

        accountService.setAccountType({ guildId: GUILD, userId: USER, accountType: 'MARGIN' });
        const opened = await short();
        expect(opened.proceeds).toBe(PRICE);
        expect(opened.position.units).toBe(1);
    });

    test('a market-data failure surfaces as a 400 with its own code', async () => {
        await expect(webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'buy', symbol: 'NOPE', units: 1
        })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_SYMBOL' });
    });
});

describe('quotes, history, and search', () => {
    test('a quote carries the caller exposure and wallet', async () => {
        await webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'buy', symbol: 'AAPL', units: 1
        });
        const result = await webExchangeService.quote({ client, guildId: GUILD, userId: USER, symbol: 'aapl' });
        expect(result.quote.symbol).toBe('AAPL');
        expect(result.holding).toEqual(expect.objectContaining({ symbol: 'AAPL', units: 1 }));
        expect(result.shortPosition).toBeNull();
        expect(result.balance).toBe(economyService.getBalance(GUILD, USER));
        expect(result.currencyName).toBeTruthy();
    });

    test('history and search delegate to the market data layer', async () => {
        const history = await webExchangeService.history({
            client, guildId: GUILD, userId: USER, symbol: 'AAPL', range: '1y'
        });
        expect(history.points).toHaveLength(2);

        const results = await webExchangeService.search({
            client, guildId: GUILD, userId: USER, query: 'apple'
        });
        expect(results[0].symbol).toBe('AAPL');
    });
});

describe('options', () => {
    test('the chain is refused while options are off for the guild', async () => {
        await expect(webExchangeService.chain({ client, guildId: GUILD, userId: USER, symbol: 'AAPL' }))
            .rejects.toMatchObject({ status: 400, code: 'FEATURE_OFF' });
    });

    test('an enabled guild gets a simulated chain, honestly labelled', async () => {
        exchangeConfig.set(GUILD, { optionsEnabled: true });
        const chain = await webExchangeService.chain({ client, guildId: GUILD, userId: USER, symbol: 'AAPL' });
        expect(chain.simulated).toBe(true);
        expect(chain.underlying).toBe('AAPL');
        expect(chain.rows.length).toBeGreaterThan(0);
        for (const row of chain.rows) {
            expect(row.call.simulated).toBe(true);
            expect(row.put.simulated).toBe(true);
        }
    });

    test('an unsupported action is refused', async () => {
        await expect(webExchangeService.tradeOption({
            client, guildId: GUILD, userId: USER, action: 'yolo'
        })).rejects.toMatchObject({ status: 400, code: 'BAD_ACTION' });
    });

    test('buying a contract debits cash and opens a LONG position', async () => {
        exchangeConfig.set(GUILD, { optionsEnabled: true });
        const chain = await webExchangeService.chain({ client, guildId: GUILD, userId: USER, symbol: 'AAPL' });
        const row = chain.rows.find(candidate => candidate.call.costPerContract > 0);
        // Long options are cash-paid and never borrowed, so the wallet has to cover it
        fund(row.call.costPerContract * 2);
        const before = economyService.getBalance(GUILD, USER);

        const result = await webExchangeService.tradeOption({
            client, guildId: GUILD, userId: USER, action: 'buy', symbol: 'AAPL',
            optionType: 'CALL', strike: row.strike, expiry: chain.expiry, contracts: 1
        });

        expect(result.contracts).toBe(1);
        expect(result.balance).toBe(before - result.cost);
        expect(db.get(
            'SELECT side, status FROM option_positions WHERE id = @id', { id: result.positionId }
        )).toEqual({ side: 'LONG', status: 'OPEN' });
    });
});

describe('resting orders', () => {
    test('place, list, and cancel round-trip for the owner', async () => {
        const { order, triggerHint } = await webExchangeService.placeOrder({
            client, guildId: GUILD, userId: USER, symbol: 'AAPL',
            side: 'BUY', orderType: 'LIMIT', units: 2, limitPrice: 150
        });
        expect(order.status).toBe('OPEN');
        expect(triggerHint).toBeTruthy();

        const orders = await webExchangeService.listOrders({ client, guildId: GUILD, userId: USER });
        expect(orders.map(row => row.id)).toContain(order.id);

        const cancelled = await webExchangeService.cancelOrder({
            client, guildId: GUILD, userId: USER, orderId: String(order.id)
        });
        expect(cancelled.status).toBe('CANCELLED');
    });

    test('cancelling an order that is not yours is a 400, not a silent no-op', async () => {
        await expect(webExchangeService.cancelOrder({
            client, guildId: GUILD, userId: USER, orderId: 4242
        })).rejects.toMatchObject({ status: 400 });
    });
});

describe('leaderboard', () => {
    test('ranks by equity and resolves display names through the guild', async () => {
        await webExchangeService.tradeStock({
            client, guildId: GUILD, userId: USER, side: 'buy', symbol: 'AAPL', units: 1
        });
        const board = await webExchangeService.leaderboard({ client, guildId: GUILD, userId: USER });
        const row = board.rows.find(candidate => candidate.userId === USER);
        expect(row).toEqual(expect.objectContaining({ name: 'rob', accountType: 'CASH' }));
        expect(row.equity).toBeGreaterThan(0);
        // A member who left (or was never fetchable) stays an id-only row
        expect(board.rows.every(candidate => 'name' in candidate)).toBe(true);
        expect(board.currencyName).toBeTruthy();
    });
});
