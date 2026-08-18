/**
 * Group-play opt-ins (explicit choices, the override-all default, opt-outs
 * that always win) and the Ballistic Goblin Wheel that spends them.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-exchange-wheel-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const stockService = require('@goobster/core/services/stockService');
const exchangeConfig = require('@goobster/core/services/exchange/exchangeConfig');
const accountService = require('@goobster/core/services/exchange/accountService');
const groupPlayService = require('@goobster/core/services/exchange/groupPlayService');
const optionsService = require('@goobster/core/services/exchange/optionsService');
const { WheelService, STRIKE_WHEEL, ALLOCATION_WHEEL } = require('@goobster/core/services/exchange/wheelService');

const GUILD = '940000000000000001';
const DADDY = '940000000000000002';
const BEBES = '940000000000000003';
const LURKER = '940000000000000004';

const NOW = new Date('2026-07-29T14:00:00Z');
const PRICES = { '^GSPC': 6000, AAPL: 200 };

/** An rng that returns a scripted sequence (0..1). */
function sequenceRng(values) {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

function quoteFor(symbol) {
    const resolved = stockService.normalizeSymbol(symbol);
    const price = PRICES[resolved];
    if (!price) {
        const { StockError } = require('@goobster/core/services/stockService');
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
        'economy_wallets', 'economy_transactions', 'economy_settings', 'exchange_accounts',
        'exchange_settings', 'exchange_optins', 'option_positions', 'option_trades',
        'exchange_events', 'stock_symbols'
    ]) {
        db.run(`DELETE FROM ${table}`);
    }
    Object.assign(PRICES, { '^GSPC': 6000, AAPL: 200 });
    jest.spyOn(stockService, 'getQuote').mockImplementation(async symbol => quoteFor(symbol));
    jest.spyOn(stockService, 'getHistory').mockImplementation(async symbol => {
        const closes = [];
        let price = PRICES[stockService.normalizeSymbol(symbol)] || 100;
        for (let i = 0; i < 60; i++) {
            price *= i % 2 ? 1.019 : 1 / 1.019;
            closes.push(price);
        }
        return { symbol, currency: 'USD', points: closes.map((close, i) => ({ date: `2026-05-${i + 1}`, close })) };
    });
    exchangeConfig.set(GUILD, { optionsEnabled: true, zeroDteEnabled: true });
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('opt-in tracking', () => {
    test('the override-all default counts every wallet holder as in', () => {
        fund(DADDY, 1000);
        fund(BEBES, 1000);
        const state = groupPlayService.effectiveOptIn(GUILD, DADDY);
        expect(state).toMatchObject({ optedIn: true, source: 'override' });

        const participants = groupPlayService.listParticipants({ guildId: GUILD });
        expect(participants.map(p => p.userId).sort()).toEqual([DADDY, BEBES].sort());
        expect(participants.every(p => p.source === 'override')).toBe(true);
    });

    test('an explicit opt-out always wins over the override', () => {
        fund(DADDY, 1000);
        fund(BEBES, 1000);
        groupPlayService.setOptIn({ guildId: GUILD, userId: BEBES, optedIn: false });

        expect(groupPlayService.effectiveOptIn(GUILD, BEBES)).toMatchObject({ optedIn: false, source: 'explicit' });
        const participants = groupPlayService.listParticipants({ guildId: GUILD });
        expect(participants.map(p => p.userId)).toEqual([DADDY]);
    });

    test('with the override off, only explicit opt-ins ride', () => {
        fund(DADDY, 1000);
        fund(BEBES, 1000);
        groupPlayService.setOverride({ guildId: GUILD, enabled: false, byUserId: DADDY });
        expect(groupPlayService.listParticipants({ guildId: GUILD })).toEqual([]);

        groupPlayService.setOptIn({ guildId: GUILD, userId: DADDY, optedIn: true, maxAllocationPercent: 25 });
        const participants = groupPlayService.listParticipants({ guildId: GUILD });
        expect(participants).toEqual([{ userId: DADDY, source: 'explicit', maxAllocationPercent: 25 }]);
    });

    test('an explicit opt-in without a wallet still rides (the wallet is created at deploy)', () => {
        groupPlayService.setOptIn({ guildId: GUILD, userId: LURKER, optedIn: true });
        expect(groupPlayService.listParticipants({ guildId: GUILD }).map(p => p.userId)).toContain(LURKER);
    });

    test('turning the override back on does not resurrect an opt-out', () => {
        fund(BEBES, 1000);
        groupPlayService.setOptIn({ guildId: GUILD, userId: BEBES, optedIn: false });
        groupPlayService.setOverride({ guildId: GUILD, enabled: false });
        groupPlayService.setOverride({ guildId: GUILD, enabled: true });
        expect(groupPlayService.effectiveOptIn(GUILD, BEBES).optedIn).toBe(false);
    });

    test('every consent change is audited', () => {
        groupPlayService.setOptIn({ guildId: GUILD, userId: DADDY, optedIn: true });
        groupPlayService.setOptIn({ guildId: GUILD, userId: DADDY, optedIn: false });
        groupPlayService.setOverride({ guildId: GUILD, enabled: false, byUserId: BEBES });
        const events = require('@goobster/core/services/exchange/exchangeEvents').list({ guildId: GUILD });
        const types = events.map(event => event.eventType);
        expect(types).toContain('group-opt-in');
        expect(types).toContain('group-opt-out');
        expect(types).toContain('opt-in-override-off');
    });

    test('rejects a nonsense allocation cap', () => {
        expect(() => groupPlayService.setOptIn({ guildId: GUILD, userId: DADDY, optedIn: true, maxAllocationPercent: 150 }))
            .toThrow(/between 0 and 100/);
    });
});

describe('the wheels', () => {
    test('roll 80 lands in the 1-5% bucket, 99 in 6-10%, 100 in the moonshot', () => {
        // _roll computes 1 + floor(rng*100): 0.79 -> 80, 0.98 -> 99, 0.99 -> 100
        expect(new WheelService(sequenceRng([0.79, 0])).spinStrikeWheel().targetPercent).toBeLessThanOrEqual(5);
        const high = new WheelService(sequenceRng([0.98, 0.99])).spinStrikeWheel();
        expect(high.targetPercent).toBeGreaterThanOrEqual(6);
        expect(high.targetPercent).toBeLessThanOrEqual(10);
        expect(new WheelService(sequenceRng([0.99])).spinStrikeWheel().targetPercent).toBe(20);
    });

    test('the allocation wheel follows its published odds boundaries', () => {
        expect(new WheelService(sequenceRng([0.49])).spinAllocationWheel().percent).toBe(5);
        expect(new WheelService(sequenceRng([0.50])).spinAllocationWheel().percent).toBe(10);
        expect(new WheelService(sequenceRng([0.80])).spinAllocationWheel().percent).toBe(20);
        expect(new WheelService(sequenceRng([0.95])).spinAllocationWheel().percent).toBe(35);
        expect(new WheelService(sequenceRng([0.99])).spinAllocationWheel().percent).toBe(50);
    });

    test('the wheel odds sum to exactly 100 on both wheels', () => {
        expect(STRIKE_WHEEL.reduce((sum, bucket) => sum + bucket.chance, 0)).toBe(100);
        expect(ALLOCATION_WHEEL.reduce((sum, bucket) => sum + bucket.chance, 0)).toBe(100);
    });
});

describe('the spin', () => {
    test('deploys a wheel-chosen slice of every participant into the chosen call', async () => {
        fund(DADDY, 1_000_000);
        fund(BEBES, 200_000);
        // Wheel 1: roll 12 -> 80% bucket; sub-roll picks +1%; Wheel 2: roll 1 -> 5%
        const wheel = new WheelService(sequenceRng([0.11, 0, 0]));
        const result = await wheel.spin({ guildId: GUILD, now: NOW });

        expect(result.strikeSpin.targetPercent).toBe(1);
        expect(result.allocationSpin.percent).toBe(5);
        expect(result.underlying).toBe('^GSPC');
        expect(result.strike).toBe(6050); // nearest 25-increment to 6000 x 1.01 = 6060 -> 6050
        expect(result.zeroDte).toBe(true); // guild allows same-day and it's before the bell

        const deployed = result.deployments.filter(d => !d.skipped);
        expect(deployed).toHaveLength(2);
        for (const deployment of deployed) {
            const budget = Math.floor((deployment.userId === DADDY ? 1_000_000 : 200_000) * 0.05);
            expect(deployment.contracts).toBe(Math.floor(budget / result.costPerContract));
        }
        // The contracts really exist
        expect(optionsService.listPositions({ guildId: GUILD, userId: DADDY })[0])
            .toMatchObject({ underlying: '^GSPC', strike: 6050, optionType: 'CALL', side: 'LONG' });
    });

    test('participating stands in for personal Goblin Mode on same-day contracts', async () => {
        fund(DADDY, 1_000_000);
        expect(accountService.getAccount(GUILD, DADDY).goblinMode).toBe(0);
        const result = await new WheelService(sequenceRng([0.11, 0, 0])).spin({ guildId: GUILD, now: NOW });
        expect(result.deployments[0].skipped).toBe(false);
        // The flag itself was never silently flipped
        expect(accountService.getAccount(GUILD, DADDY).goblinMode).toBe(0);
    });

    test('a hand-rolled 0DTE purchase still needs Goblin Mode', async () => {
        fund(DADDY, 1_000_000);
        await expect(optionsService.buyToOpen({
            guildId: GUILD, userId: DADDY, symbol: 'SPX', optionType: 'CALL',
            strike: 6050, expiry: '2026-07-29', contracts: 1, now: NOW
        })).rejects.toMatchObject({ code: 'GOBLIN_MODE_REQUIRED' });
    });

    test('falls back to the next expiry when the guild forbids 0DTE', async () => {
        exchangeConfig.set(GUILD, { optionsEnabled: true, zeroDteEnabled: false });
        fund(DADDY, 1_000_000);
        const result = await new WheelService(sequenceRng([0.11, 0, 0])).spin({ guildId: GUILD, now: NOW });
        expect(result.zeroDte).toBe(false);
        expect(result.expiry > '2026-07-29').toBe(true);
    });

    test('honours a personal allocation cap below the wheel percentage', async () => {
        fund(DADDY, 1_000_000);
        groupPlayService.setOptIn({ guildId: GUILD, userId: DADDY, optedIn: true, maxAllocationPercent: 2 });
        // Wheel 2 rolls 50%
        const result = await new WheelService(sequenceRng([0.11, 0, 0.99])).spin({ guildId: GUILD, now: NOW });
        expect(result.allocationSpin.percent).toBe(50);
        const deployment = result.deployments.find(d => d.userId === DADDY);
        expect(deployment.percent).toBe(2);
        expect(deployment.cost).toBeLessThanOrEqual(20_000);
    });

    test('the broke are skipped with a reason, never an error', async () => {
        fund(DADDY, 1_000_000);
        fund(BEBES, 3); // three points
        const result = await new WheelService(sequenceRng([0.11, 0, 0])).spin({ guildId: GUILD, now: NOW });
        const poor = result.deployments.find(d => d.userId === BEBES);
        expect(poor.skipped).toBe(true);
        expect(poor.reason).toBeTruthy();
        expect(result.deployments.find(d => d.userId === DADDY).skipped).toBe(false);
    });

    test('opt-outs are never deployed, whatever the override says', async () => {
        fund(DADDY, 1_000_000);
        fund(BEBES, 1_000_000);
        groupPlayService.setOptIn({ guildId: GUILD, userId: BEBES, optedIn: false });
        const result = await new WheelService(sequenceRng([0.11, 0, 0])).spin({ guildId: GUILD, now: NOW });
        expect(result.deployments.some(d => d.userId === BEBES)).toBe(false);
        expect(optionsService.listPositions({ guildId: GUILD, userId: BEBES })).toHaveLength(0);
    });

    test('the whole spin is refused when the guild has options off', async () => {
        exchangeConfig.set(GUILD, { optionsEnabled: false, zeroDteEnabled: false });
        await expect(new WheelService(sequenceRng([0.11, 0, 0])).spin({ guildId: GUILD, now: NOW }))
            .rejects.toMatchObject({ code: 'FEATURE_OFF' });
    });

    test('the spin lands in the audit trail with both rolls', async () => {
        fund(DADDY, 1_000_000);
        await new WheelService(sequenceRng([0.11, 0, 0])).spin({ guildId: GUILD, now: NOW });
        const events = require('@goobster/core/services/exchange/exchangeEvents').list({ guildId: GUILD, types: ['wheel-spin'] });
        expect(events).toHaveLength(1);
        expect(events[0].detail).toMatchObject({ targetPercent: 1, allocationPercent: 5, strike: 6050 });
    });
});
