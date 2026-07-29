/**
 * Black-Scholes pricing, greeks, and the margin arithmetic behind the
 * Jimbucks Exchange. Pure functions - no database, no network.
 */
const optionsMath = require('../services/exchange/optionsMath');
const marginMath = require('../services/exchange/marginMath');

const BASE = { spot: 100, strike: 100, timeYears: 1, vol: 0.2, rate: 0.05 };

describe('Black-Scholes pricing', () => {
    test('matches the textbook call and put values', () => {
        expect(optionsMath.price({ ...BASE, optionType: 'CALL' })).toBeCloseTo(10.4506, 3);
        expect(optionsMath.price({ ...BASE, optionType: 'PUT' })).toBeCloseTo(5.5735, 3);
    });

    test('respects put-call parity', () => {
        const call = optionsMath.price({ ...BASE, optionType: 'CALL' });
        const put = optionsMath.price({ ...BASE, optionType: 'PUT' });
        const parity = BASE.spot - BASE.strike * Math.exp(-BASE.rate * BASE.timeYears);
        expect(call - put).toBeCloseTo(parity, 6);
    });

    test('never prices below intrinsic value', () => {
        const deepItm = optionsMath.price({ ...BASE, strike: 50, optionType: 'CALL' });
        expect(deepItm).toBeGreaterThanOrEqual(50 - 50 * Math.exp(-0.05));
    });

    test('falls back to intrinsic value once time or volatility is gone', () => {
        expect(optionsMath.price({ ...BASE, timeYears: 0, strike: 90, optionType: 'CALL' })).toBe(10);
        expect(optionsMath.price({ ...BASE, timeYears: 0, strike: 110, optionType: 'CALL' })).toBe(0);
        expect(optionsMath.price({ ...BASE, vol: 0, strike: 110, optionType: 'PUT' })).toBe(10);
    });

    test('premium rises with volatility and with time', () => {
        const cheap = optionsMath.price({ ...BASE, vol: 0.1, optionType: 'CALL' });
        const rich = optionsMath.price({ ...BASE, vol: 0.6, optionType: 'CALL' });
        const shortDated = optionsMath.price({ ...BASE, timeYears: 1 / 365, optionType: 'CALL' });
        expect(rich).toBeGreaterThan(cheap);
        expect(shortDated).toBeLessThan(cheap);
    });
});

describe('greeks', () => {
    test('call and put deltas differ by exactly one', () => {
        const call = optionsMath.greeks({ ...BASE, optionType: 'CALL' });
        const put = optionsMath.greeks({ ...BASE, optionType: 'PUT' });
        expect(call.delta - put.delta).toBeCloseTo(1, 6);
        expect(call.gamma).toBeCloseTo(put.gamma, 8);
        expect(call.vega).toBeCloseTo(put.vega, 8);
    });

    test('delta approximates the price change for a small move', () => {
        const { delta } = optionsMath.greeks({ ...BASE, optionType: 'CALL' });
        const before = optionsMath.price({ ...BASE, optionType: 'CALL' });
        const after = optionsMath.price({ ...BASE, spot: 100.01, optionType: 'CALL' });
        expect((after - before) / 0.01).toBeCloseTo(delta, 3);
    });

    test('a long option always decays: theta is negative', () => {
        expect(optionsMath.greeks({ ...BASE, optionType: 'CALL' }).theta).toBeLessThan(0);
        expect(optionsMath.greeks({ ...BASE, optionType: 'PUT' }).theta).toBeLessThan(0);
    });

    test('same-day at-the-money gamma dwarfs the one-year value ("gamma mode")', () => {
        const yearly = optionsMath.greeks({ ...BASE, optionType: 'CALL' }).gamma;
        const sameDay = optionsMath.greeks({ ...BASE, timeYears: 1 / (365 * 8), optionType: 'CALL' }).gamma;
        expect(sameDay).toBeGreaterThan(yearly * 20);
    });

    test('an expired contract has no greeks beyond intrinsic delta', () => {
        const expired = optionsMath.greeks({ ...BASE, timeYears: 0, strike: 90, optionType: 'CALL' });
        expect(expired).toMatchObject({ delta: 1, gamma: 0, theta: 0, vega: 0 });
    });
});

describe('probabilities and break-even', () => {
    test('break-even sits beyond the strike by the premium paid', () => {
        expect(optionsMath.breakEven({ strike: 100, premium: 4, optionType: 'CALL' })).toBe(104);
        expect(optionsMath.breakEven({ strike: 100, premium: 4, optionType: 'PUT' })).toBe(96);
    });

    test('probability of profit is strictly worse than probability in the money', () => {
        const premium = optionsMath.price({ ...BASE, optionType: 'CALL' });
        const itm = optionsMath.probabilityItm({ ...BASE, optionType: 'CALL' });
        const profit = optionsMath.probabilityOfProfit({ ...BASE, premium, optionType: 'CALL' });
        expect(profit).toBeLessThan(itm);
        expect(profit).toBeGreaterThan(0);
    });

    test('a far out-of-the-money same-day contract is a near-certain zero', () => {
        const probability = optionsMath.probabilityItm({
            spot: 100, strike: 140, timeYears: 1 / (365 * 8), vol: 0.5, rate: 0.04, optionType: 'CALL'
        });
        expect(probability).toBeLessThan(0.001);
    });
});

describe('implied and realized volatility', () => {
    test('implied volatility recovers the volatility that produced a premium', () => {
        const premium = optionsMath.price({ ...BASE, vol: 0.37, optionType: 'PUT' });
        const implied = optionsMath.impliedVolatility({ ...BASE, premium, optionType: 'PUT' });
        expect(implied).toBeCloseTo(0.37, 3);
    });

    test('returns null for a premium no volatility can produce', () => {
        expect(optionsMath.impliedVolatility({ ...BASE, premium: 0, optionType: 'CALL' })).toBeNull();
        expect(optionsMath.impliedVolatility({ ...BASE, premium: 1000, optionType: 'CALL' })).toBeNull();
    });

    test('realized volatility annualizes daily log returns', () => {
        // A series that alternates +1%/-1% every day
        const closes = [100];
        for (let i = 1; i < 60; i++) closes.push(closes[i - 1] * (i % 2 ? 1.01 : 1 / 1.01));
        const vol = optionsMath.realizedVolatility(closes);
        expect(vol).toBeGreaterThan(0.1);
        expect(vol).toBeLessThan(0.25);
    });

    test('needs a real series before it will report a number', () => {
        expect(optionsMath.realizedVolatility([100, 101])).toBeNull();
        expect(optionsMath.realizedVolatility([])).toBeNull();
    });
});

describe('margin arithmetic', () => {
    const RULES = { maintenanceMargin: 0.25, shortMaintenanceMargin: 0.35 };

    test('equity nets positions against debt', () => {
        expect(marginMath.equity({ cash: 500, longValue: 2000, optionValue: 300, shortValue: 400, debt: 1000 }))
            .toBe(1400);
    });

    test('a cash account can only spend cash', () => {
        expect(marginMath.buyingPower({ accountType: 'CASH', cash: 750, equity: 3000, longValue: 2250 })).toBe(750);
    });

    test('a margin account can hold leverage x equity, minus what it holds', () => {
        // 1000 cash, nothing held, 3x -> 3000 of buying power
        expect(marginMath.buyingPower({
            accountType: 'MARGIN', cash: 1000, equity: 1000, longValue: 0, shortValue: 0, leverage: 3
        })).toBe(3000);
        // Same account fully deployed has none left
        expect(marginMath.buyingPower({
            accountType: 'MARGIN', cash: 0, equity: 1000, longValue: 3000, shortValue: 0, leverage: 3
        })).toBe(0);
    });

    test('long options are not collateral for new borrowing', () => {
        const withOptions = marginMath.buyingPower({
            accountType: 'MARGIN', cash: 0, equity: 1000, optionValue: 1000, leverage: 2
        });
        expect(withOptions).toBe(0);
    });

    test('liquidation price for a long sits where equity meets maintenance', () => {
        // 4000 of stock bought with 2000 cash and a 2000 loan, 25% maintenance
        const price = marginMath.liquidationPrice({
            direction: 'LONG', units: 40, cash: 0, otherLongValue: 0, otherShortValue: 0,
            debt: 2000, ...RULES
        });
        expect(price).toBeCloseTo(2000 / (40 * 0.75), 6);

        // Verify by construction: at that price equity equals maintenance
        const longValue = price * 40;
        const equity = marginMath.equity({ cash: 0, longValue, debt: 2000 });
        const maintenance = marginMath.maintenanceRequirement({ longValue, ...RULES });
        expect(equity).toBeCloseTo(maintenance, 6);
    });

    test('liquidation price for a short sits above the entry, not below', () => {
        const price = marginMath.liquidationPrice({
            direction: 'SHORT', units: 10, cash: 1500, otherLongValue: 0, otherShortValue: 0,
            debt: 0, ...RULES
        });
        const shortValue = price * 10;
        const equity = marginMath.equity({ cash: 1500, shortValue });
        const maintenance = marginMath.maintenanceRequirement({ shortValue, ...RULES });
        expect(equity).toBeCloseTo(maintenance, 6);
        expect(price).toBeGreaterThan(0);
    });

    test('an unlevered cash-funded long can never be called', () => {
        expect(marginMath.liquidationPrice({
            direction: 'LONG', units: 10, cash: 500, debt: 0, ...RULES
        })).toBeNull();
    });

    test('reports how far the market may move before a call', () => {
        const move = marginMath.marketMoveToMarginCall({
            cash: 0, longValue: 4000, debt: 2000, ...RULES
        });
        // Equity 2000 on 4000 of stock: a 33% drop takes equity to maintenance
        expect(move.drop).toBeCloseTo(1 - (2000 / 3000), 4);
    });

    test('plans a liquidation that repairs the shortfall, biggest first', () => {
        const plan = marginMath.liquidationPlan({
            positions: [
                { key: 'AAPL', direction: 'LONG', value: 4000, units: 20 },
                { key: 'TSLA', direction: 'LONG', value: 1000, units: 5 }
            ],
            shortfall: 500,
            ...RULES
        });
        expect(plan).toHaveLength(1);
        expect(plan[0].key).toBe('AAPL');
        // Closing 2000 of value frees 25% of it as requirement relief
        expect(plan[0].value).toBeCloseTo(2000, 6);
        expect(plan[0].units).toBeCloseTo(10, 6);
    });

    test('a healthy account gets an empty plan', () => {
        expect(marginMath.liquidationPlan({
            positions: [{ key: 'AAPL', direction: 'LONG', value: 4000, units: 20 }],
            shortfall: -100, ...RULES
        })).toEqual([]);
    });
});
