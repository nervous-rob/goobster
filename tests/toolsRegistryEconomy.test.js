/**
 * Economy/stock tool account identity (utils/toolsRegistry.js).
 *
 * Regression for the "/points admin grant to the bot, then the AI can't see
 * it" bug: the grant funds the bot's REAL Discord account wallet in
 * economyService, and the AI tools must reach that exact wallet when
 * owner="bot" - the same (guildId, userId) pair, never a synthetic id -
 * while defaulting to the requesting human's wallet.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tools-economy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// These wrapped commands boot heavy voice/music services at load time; the
// economy tools only need the registry itself.

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const pointsCommand = require('@goobster/bot/commands/economy/points');

const GUILD_ID = '600000000000000001';
const HUMAN_ID = '600000000000000002';
// The bot's own account id - the snowflake an admin passes to
// `/points admin grant user:<bot>` (a fictional one here).
const BOT_ID = '600000000000000099';
const DEFAULT_STARTING_BALANCE = 1000;

/** Interaction-like context as built for chat pseudo-interactions and voice turns. */
function makeToolContext(overrides = {}) {
    return {
        guildId: GUILD_ID,
        user: { id: HUMAN_ID, username: 'rob', bot: false },
        client: { user: { id: BOT_ID, username: 'Goobster', bot: true } },
        ...overrides
    };
}

/** Run the real `/points admin grant user:<targetId> amount:<amount>` command. */
async function adminGrant(targetId, amount) {
    const replies = [];
    await pointsCommand.execute({
        guildId: GUILD_ID,
        user: { id: HUMAN_ID },
        memberPermissions: { has: () => true },
        options: {
            getSubcommandGroup: () => 'admin',
            getSubcommand: () => 'grant',
            getUser: () => ({ id: targetId, toString: () => `<@${targetId}>` }),
            getInteger: () => amount,
            getString: () => null
        },
        deferred: false,
        replied: false,
        reply: async (msg) => { replies.push(typeof msg === 'string' ? msg : msg.content); }
    });
    return replies;
}

beforeEach(() => {
    db.run('DELETE FROM economy_wallets');
    db.run('DELETE FROM economy_transactions');
    db.run('DELETE FROM economy_settings');
    db.run('DELETE FROM stock_holdings');
    db.run('DELETE FROM stock_trades');
    jest.spyOn(stockService, 'getQuote').mockResolvedValue({
        symbol: 'AAPL', name: 'Apple Inc.', price: 200, currency: 'USD',
        asOf: '2026-07-25 00:00:00', cached: false, stale: false
    });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('admin grant to the bot account, then AI tools with owner="bot"', () => {
    test('checkPoints(owner=bot) reads the exact wallet the grant funded', async () => {
        const replies = await adminGrant(BOT_ID, 10000);
        expect(replies[0]).toContain('11,000'); // 1,000 starting + 10,000 grant

        const result = await toolsRegistry.execute('checkPoints', {
            owner: 'bot', interactionContext: makeToolContext()
        });
        expect(result).toContain('11,000');
        expect(result).toContain("Goobster's own");

        // Same shared economyService wallet, keyed on the real bot id
        expect(economyService.getBalance(GUILD_ID, BOT_ID)).toBe(11000);
    });

    test('checkPoints defaults to the requesting human, not the bot', async () => {
        await adminGrant(BOT_ID, 10000);

        const result = await toolsRegistry.execute('checkPoints', {
            interactionContext: makeToolContext()
        });
        expect(result).toContain('1,000'); // the human's own starting balance
        expect(result).not.toContain('11,000');
        expect(result).toContain("the requesting user's");
    });

    test('tradeStock(owner=bot) buys with the granted balance and no synthetic user id appears', async () => {
        await adminGrant(BOT_ID, 10000);

        const result = await toolsRegistry.execute('tradeStock', {
            action: 'buy', symbol: 'AAPL', units: 10, owner: 'bot',
            interactionContext: makeToolContext()
        });
        expect(result).toContain('Bought 10 AAPL');
        expect(result).toContain('9,000'); // 11,000 - 10 * $200

        // The debit hit the bot's shared wallet; the human's is untouched
        expect(economyService.getBalance(GUILD_ID, BOT_ID)).toBe(9000);
        expect(economyService.getBalance(GUILD_ID, HUMAN_ID)).toBe(DEFAULT_STARTING_BALANCE);

        // The holding is keyed on the real bot account id
        const holders = db.all('SELECT DISTINCT userId FROM stock_holdings WHERE guildId = @guildId', { guildId: GUILD_ID });
        expect(holders).toEqual([{ userId: BOT_ID }]);

        // No separate/synthetic ids anywhere in the guild economy
        const walletIds = db.all('SELECT userId FROM economy_wallets WHERE guildId = @guildId', { guildId: GUILD_ID })
            .map(row => row.userId);
        for (const id of walletIds) {
            expect([BOT_ID, HUMAN_ID]).toContain(id);
        }
    });

    test('checkPortfolio(owner=bot) reports the bot-held position', async () => {
        await adminGrant(BOT_ID, 10000);
        await toolsRegistry.execute('tradeStock', {
            action: 'buy', symbol: 'AAPL', units: 10, owner: 'bot',
            interactionContext: makeToolContext()
        });

        const botView = await toolsRegistry.execute('checkPortfolio', {
            owner: 'bot', interactionContext: makeToolContext()
        });
        expect(botView).toContain('AAPL: 10 units');
        expect(botView).toContain("Goobster's own");

        const humanView = await toolsRegistry.execute('checkPortfolio', {
            interactionContext: makeToolContext()
        });
        expect(humanView).toContain('No stock positions');
    });
});

describe('default (owner="user") identity', () => {
    test('tradeStock without owner trades the requesting human\'s wallet', async () => {
        const result = await toolsRegistry.execute('tradeStock', {
            action: 'buy', symbol: 'AAPL', units: 2,
            interactionContext: makeToolContext()
        });
        expect(result).toContain('Bought 2 AAPL');
        expect(economyService.getBalance(GUILD_ID, HUMAN_ID)).toBe(600); // 1,000 - 2 * $200

        const holders = db.all('SELECT DISTINCT userId FROM stock_holdings WHERE guildId = @guildId', { guildId: GUILD_ID });
        expect(holders).toEqual([{ userId: HUMAN_ID }]);
    });

    test('gamblePoints always wagers the human\'s wallet, never the bot\'s', async () => {
        await adminGrant(BOT_ID, 10000);

        const result = await toolsRegistry.execute('gamblePoints', {
            game: 'coinflip', bet: 100, call: 'heads',
            interactionContext: makeToolContext()
        });
        expect(result).toContain('🪙');

        // The human won or lost exactly the bet; the bot's wallet is untouched
        expect([900, 1100]).toContain(economyService.getBalance(GUILD_ID, HUMAN_ID));
        expect(economyService.getBalance(GUILD_ID, BOT_ID)).toBe(11000);
    });
});

describe('identity resolution failure modes', () => {
    test('owner="bot" without a resolvable bot account fails cleanly, creating no wallet', async () => {
        const result = await toolsRegistry.execute('checkPoints', {
            owner: 'bot', interactionContext: makeToolContext({ client: null })
        });
        expect(result).toContain('❌');

        const wallets = db.all('SELECT userId FROM economy_wallets WHERE guildId = @guildId', { guildId: GUILD_ID });
        expect(wallets).toEqual([]);
    });

    test('outside a guild the tools refuse regardless of owner', async () => {
        for (const owner of ['user', 'bot']) {
            const result = await toolsRegistry.execute('checkPoints', {
                owner, interactionContext: makeToolContext({ guildId: null })
            });
            expect(result).toContain('❌');
        }
    });
});
