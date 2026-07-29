/**
 * The exchange tools in utils/toolsRegistry.js - the surface Goobster uses to
 * trade and, crucially, to AUDIT: any member's account by mention or name, and
 * the whole market, all read-only.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tools-exchange-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// These wrapped commands boot heavy voice/music services at load time.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

const db = require('../db');
const economyService = require('../services/economyService');
const stockService = require('../services/stockService');
const stockPortfolioService = require('../services/stockPortfolioService');
const exchangeConfig = require('../services/exchange/exchangeConfig');
const accountService = require('../services/exchange/accountService');
const optionsService = require('../services/exchange/optionsService');
const toolsRegistry = require('../utils/toolsRegistry');
const { VOICE_TOOL_NAMES } = require('../services/voice/voiceTurnShared');

const GUILD = '920000000000000001';
const HUMAN = '920000000000000002';
const FRIEND = '920000000000000003';
const BOT = '920000000000000099';

const EXCHANGE_TOOLS = [
    'optionChain', 'tradeOption', 'shortStock', 'marginAccount',
    'exchangeOrder', 'eventContracts', 'auditAccount', 'auditExchange'
];

const PRICES = { AAPL: 200, TSLA: 100, '^GSPC': 6000 };

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('../services/stockService');
        throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${resolved}.`);
    }
    return { symbol: resolved, name: `${resolved} Inc.`, price, currency: 'USD', asOf: '2026-07-29 14:00:00', cached: false, stale: false };
}

/** A guild whose member lookup behaves like discord.js does. */
function makeToolContext(overrides = {}) {
    const members = new Map([
        [HUMAN, { id: HUMAN, displayName: 'The Data Daddy', user: { username: 'datadaddy' } }],
        [FRIEND, { id: FRIEND, displayName: 'Mecha-Bebes', user: { username: 'mechabebes' } }],
        [BOT, { id: BOT, displayName: 'Goobster', user: { username: 'goobster' } }]
    ]);
    return {
        guildId: GUILD,
        user: { id: HUMAN, username: 'datadaddy', bot: false },
        client: { user: { id: BOT, username: 'Goobster', bot: true } },
        guild: {
            members: {
                cache: members,
                fetch: async arg => {
                    if (typeof arg === 'string') {
                        const member = members.get(arg);
                        if (!member) throw new Error('Unknown Member');
                        return member;
                    }
                    const query = String(arg?.query || '').toLowerCase();
                    const hits = [...members.values()].filter(member =>
                        member.displayName.toLowerCase().includes(query) || member.user.username.includes(query));
                    return { first: () => hits[0] };
                }
            }
        },
        ...overrides
    };
}

/** Set an exact balance, keeping the ledger consistent so audits reconcile. */
function fund(userId, points) {
    economyService.getWallet(GUILD, userId);
    db.run('UPDATE economy_wallets SET balance = @points WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId, points });
    db.run('DELETE FROM economy_transactions WHERE guildId = @g AND userId = @u', { g: GUILD, u: userId });
    db.run(
        `INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type)
         VALUES (@g, @u, @points, @points, 'starting-balance')`,
        { g: GUILD, u: userId, points }
    );
}

beforeEach(() => {
    for (const table of [
        'economy_wallets', 'economy_transactions', 'economy_settings', 'stock_holdings', 'stock_trades',
        'exchange_accounts', 'exchange_settings', 'short_positions', 'exchange_events', 'exchange_orders',
        'option_positions', 'option_trades', 'prediction_positions', 'prediction_markets', 'stock_symbols'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { AAPL: 200, TSLA: 100, '^GSPC': 6000 });
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

describe('registration', () => {
    test('every exchange tool is registered with a usable schema', () => {
        const definitions = new Map(toolsRegistry.getDefinitions().map(def => [def.name, def]));
        for (const name of EXCHANGE_TOOLS) {
            const definition = definitions.get(name);
            expect(definition).toBeDefined();
            expect(definition.description.length).toBeGreaterThan(40);
            expect(definition.parameters.type).toBe('object');
        }
    });

    test('all of them are reachable by voice', () => {
        for (const name of EXCHANGE_TOOLS) {
            expect(VOICE_TOOL_NAMES).toContain(name);
        }
        expect(toolsRegistry.getDefinitions(VOICE_TOOL_NAMES)).toHaveLength(VOICE_TOOL_NAMES.length);
    });
});

describe('trading by tool', () => {
    beforeEach(() => fund(HUMAN, 200_000));

    test('quotes a contract with greeks and the honest "simulated" caveat', async () => {
        const result = await toolsRegistry.execute('optionChain', {
            symbol: 'SPX', optionType: 'CALL', strike: 6000, expiry: futureExpiry(),
            interactionContext: makeToolContext()
        });
        expect(result).toMatch(/SPX 6000 CALL/);
        expect(result).toMatch(/Delta/);
        expect(result).toMatch(/simulated/i);
    });

    test('buys a contract and reports the max loss and the odds', async () => {
        const result = await toolsRegistry.execute('tradeOption', {
            action: 'buy', symbol: 'AAPL', optionType: 'CALL', strike: 210,
            expiry: futureExpiry(), contracts: 2, interactionContext: makeToolContext()
        });
        expect(result).toMatch(/Bought 2x AAPL 210 CALL/);
        expect(result).toMatch(/maximum loss/);
        expect(result).toMatch(/chance of finishing profitable/);
        expect(optionsService.listPositions({ guildId: GUILD, userId: HUMAN })).toHaveLength(1);
    });

    test('a 0DTE request is refused until Goblin Mode is on, and says why', async () => {
        exchangeConfig.set(GUILD, { marginEnabled: true, optionsEnabled: true, zeroDteEnabled: true, predictionsEnabled: true });
        // Treat the order as same-day regardless of when the suite runs
        const optionsMarket = require('../services/exchange/optionsMarket');
        jest.spyOn(optionsMarket, 'isZeroDte').mockReturnValue(true);

        const order = {
            action: 'buy', symbol: 'SPX', optionType: 'CALL', strike: 6000,
            expiry: futureExpiry(), contracts: 1, interactionContext: makeToolContext()
        };
        expect(await toolsRegistry.execute('tradeOption', order)).toMatch(/Goblin Mode/);

        accountService.setGoblinMode({ guildId: GUILD, userId: HUMAN, enabled: true });
        expect(await toolsRegistry.execute('tradeOption', order)).toMatch(/expires TODAY/);
    });

    test('risk settings will not change without an explicit confirmation', async () => {
        const context = makeToolContext();
        const refused = await toolsRegistry.execute('marginAccount', { action: 'set_type', accountType: 'MARGIN', interactionContext: context });
        expect(refused).toMatch(/confirm=true/);
        expect(accountService.getAccount(GUILD, HUMAN).accountType).toBe('CASH');

        const done = await toolsRegistry.execute('marginAccount', { action: 'set_type', accountType: 'MARGIN', confirm: true, interactionContext: context });
        expect(done).toMatch(/MARGIN account/);
        expect(accountService.getAccount(GUILD, HUMAN).accountType).toBe('MARGIN');
    });

    test('shorting and covering both run through the tool', async () => {
        const context = makeToolContext();
        await toolsRegistry.execute('marginAccount', { action: 'set_type', accountType: 'MARGIN', confirm: true, interactionContext: context });
        const opened = await toolsRegistry.execute('shortStock', { action: 'short', symbol: 'TSLA', units: 10, interactionContext: context });
        expect(opened).toMatch(/Shorted 10 TSLA/);
        expect(opened).toMatch(/unbounded/);

        PRICES.TSLA = 80;
        const covered = await toolsRegistry.execute('shortStock', { action: 'cover', symbol: 'TSLA', interactionContext: context });
        expect(covered).toMatch(/Covered 10 TSLA/);
        expect(covered).toMatch(/Realized \+200/);
    });

    test('places a resting order and explains its trigger', async () => {
        const result = await toolsRegistry.execute('exchangeOrder', {
            action: 'place', symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 5, limitPrice: 150,
            interactionContext: makeToolContext()
        });
        expect(result).toMatch(/resting/);
        expect(result).toMatch(/falls to \$150/);
    });

    test('the bot can trade its own wallet when asked', async () => {
        fund(BOT, 50_000);
        const result = await toolsRegistry.execute('tradeOption', {
            action: 'buy', symbol: 'AAPL', optionType: 'PUT', strike: 190,
            expiry: futureExpiry(), contracts: 1, owner: 'bot', interactionContext: makeToolContext()
        });
        expect(result).toMatch(/Goobster's own wallet/);
        expect(optionsService.listPositions({ guildId: GUILD, userId: BOT })).toHaveLength(1);
        expect(optionsService.listPositions({ guildId: GUILD, userId: HUMAN })).toHaveLength(0);
    });
});

describe('auditing', () => {
    async function giveFriendAMess() {
        fund(FRIEND, 20_000);
        accountService.setAccountType({ guildId: GUILD, userId: FRIEND, accountType: 'MARGIN' });
        accountService.setLeverage({ guildId: GUILD, userId: FRIEND, leverage: 4 });
        await stockPortfolioService.buy({ guildId: GUILD, userId: FRIEND, symbol: 'AAPL', units: 300 });
    }

    test('audits the asker by default', async () => {
        fund(HUMAN, 5_000);
        await stockPortfolioService.buy({ guildId: GUILD, userId: HUMAN, symbol: 'AAPL', units: 10 });
        const result = await toolsRegistry.execute('auditAccount', { interactionContext: makeToolContext() });
        expect(result).toMatch(/ACCOUNT AUDIT - datadaddy/);
        expect(result).toMatch(/AAPL 10/);
    });

    test('audits another member found by display name', async () => {
        await giveFriendAMess();
        const result = await toolsRegistry.execute('auditAccount', { user: 'Mecha', interactionContext: makeToolContext() });
        expect(result).toMatch(/ACCOUNT AUDIT - Mecha-Bebes/);
        expect(result).toMatch(/MARGIN at 4x/);
        expect(result).toMatch(/AAPL 300/);
    });

    test('audits another member found by mention', async () => {
        await giveFriendAMess();
        const result = await toolsRegistry.execute('auditAccount', { user: `<@${FRIEND}>`, interactionContext: makeToolContext() });
        expect(result).toMatch(/Mecha-Bebes/);
    });

    test('"you" audits Goobster\'s own account', async () => {
        fund(BOT, 7_777);
        const result = await toolsRegistry.execute('auditAccount', { user: 'you', interactionContext: makeToolContext() });
        expect(result).toMatch(/ACCOUNT AUDIT - Goobster/);
    });

    test('says so plainly when the member is not in the server', async () => {
        const result = await toolsRegistry.execute('auditAccount', { user: 'nobody-here', interactionContext: makeToolContext() });
        expect(result).toMatch(/couldn't find "nobody-here"/);
    });

    test('surfaces a margin call in the audit text', async () => {
        await giveFriendAMess();
        PRICES.AAPL = 130;
        const result = await toolsRegistry.execute('auditAccount', { user: 'Mecha', interactionContext: makeToolContext() });
        expect(result).toMatch(/MARGIN CALL/);
    });

    test('the server-wide overview names the market and the top traders', async () => {
        await giveFriendAMess();
        const result = await toolsRegistry.execute('auditExchange', { interactionContext: makeToolContext() });
        expect(result).toMatch(/EXCHANGE AUDIT/);
        expect(result).toMatch(/Money supply/);
        expect(result).toMatch(/Mecha-Bebes: equity/);
    });

    test('the leaderboard ranks by equity with real names', async () => {
        await giveFriendAMess();
        fund(HUMAN, 60_000);
        const result = await toolsRegistry.execute('auditExchange', { view: 'leaderboard', interactionContext: makeToolContext() });
        expect(result).toMatch(/1\. The Data Daddy: equity 60,000/);
        expect(result).toMatch(/Mecha-Bebes/);
    });

    test('the event log can be narrowed to one member', async () => {
        await giveFriendAMess();
        const result = await toolsRegistry.execute('auditExchange', { view: 'events', user: 'Mecha', interactionContext: makeToolContext() });
        expect(result).toMatch(/Exchange event log for Mecha-Bebes/);
        expect(result).toMatch(/margin-borrow/);
    });

    test('reconciliation reports a clean set of books', async () => {
        await giveFriendAMess();
        const result = await toolsRegistry.execute('auditExchange', { view: 'reconcile', interactionContext: makeToolContext() });
        expect(result).toMatch(/The books add up/);
        expect(result).not.toMatch(/FAIL/);
    });

    test('reconciliation reports drift when the books break', async () => {
        fund(HUMAN, 1_000);
        db.run('UPDATE economy_wallets SET balance = 424242 WHERE guildId = @g AND userId = @u', { g: GUILD, u: HUMAN });
        const result = await toolsRegistry.execute('auditExchange', { view: 'reconcile', interactionContext: makeToolContext() });
        expect(result).toMatch(/found problems/);
        expect(result).toMatch(/FAIL wallet-ledger-drift/);
    });

    test('auditing outside a server is refused rather than guessed at', async () => {
        const result = await toolsRegistry.execute('auditAccount', { interactionContext: { user: { id: HUMAN } } });
        expect(result).toMatch(/only exists inside servers/);
    });
});

/** An expiry comfortably in the future, so these tests never depend on the clock. */
function futureExpiry() {
    const date = new Date(Date.now() + 21 * 86_400_000);
    // Land on a weekday: the calendar never lists a weekend settlement
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}
