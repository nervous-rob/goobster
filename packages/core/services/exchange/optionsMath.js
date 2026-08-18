/**
 * Black-Scholes option pricing and greeks - pure functions, no I/O.
 *
 * The Jimbucks Exchange has no real option feed (Yahoo's chain endpoint needs
 * an authenticated crumb), so every premium the game quotes is *derived* from
 * the real underlying price plus a volatility estimate. That makes premiums
 * simulated-but-honest: they respond to the real spot, real time decay, and a
 * real volatility smile, and they are reproducible for a given set of inputs.
 *
 * Everything here is deterministic and unit-tested; callers own the I/O.
 */

/** Standard normal probability density. */
function normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 error-function
 * approximation (|error| < 1.5e-7 - far below the precision this game needs).
 */
function normCdf(x) {
    if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const poly = t * (0.254829592
        + t * (-0.284496736
            + t * (1.421413741
                + t * (-1.453152027
                    + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-z * z);
    return 0.5 * (1 + sign * erf);
}

/**
 * d1/d2 of the Black-Scholes formula. Returns null when the inputs describe a
 * contract with no optionality left (expired or zero vol), so callers fall
 * back to intrinsic value instead of dividing by zero.
 */
function dTerms({ spot, strike, timeYears, vol, rate = 0 }) {
    if (!(spot > 0) || !(strike > 0) || !(timeYears > 0) || !(vol > 0)) return null;
    const sigmaRootT = vol * Math.sqrt(timeYears);
    const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeYears) / sigmaRootT;
    return { d1, d2: d1 - sigmaRootT, sigmaRootT };
}

/** Intrinsic value per share of a call/put at a given spot. */
function intrinsicValue({ spot, strike, optionType }) {
    return optionType === 'PUT'
        ? Math.max(0, strike - spot)
        : Math.max(0, spot - strike);
}

/**
 * Theoretical per-share premium of a European call or put.
 * @param {{spot: number, strike: number, timeYears: number, vol: number, rate?: number, optionType: 'CALL'|'PUT'}} params
 * @returns {number} premium in the underlying's currency (never negative)
 */
function price({ spot, strike, timeYears, vol, rate = 0, optionType }) {
    const terms = dTerms({ spot, strike, timeYears, vol, rate });
    if (!terms) return intrinsicValue({ spot, strike, optionType });

    const discountedStrike = strike * Math.exp(-rate * timeYears);
    const value = optionType === 'PUT'
        ? discountedStrike * normCdf(-terms.d2) - spot * normCdf(-terms.d1)
        : spot * normCdf(terms.d1) - discountedStrike * normCdf(terms.d2);
    return Math.max(0, value);
}

/**
 * The full greek set for a contract. Theta is per *day* and vega/rho are per
 * 1 percentage point, i.e. the units traders actually read off a screen.
 * @returns {{delta, gamma, theta, vega, rho}}
 */
function greeks({ spot, strike, timeYears, vol, rate = 0, optionType }) {
    const terms = dTerms({ spot, strike, timeYears, vol, rate });
    if (!terms) {
        // Expired (or volatility-free): the contract is pure intrinsic value,
        // so it moves 1:1 with spot when in the money and not at all otherwise.
        const inTheMoney = intrinsicValue({ spot, strike, optionType }) > 0;
        const delta = inTheMoney ? (optionType === 'PUT' ? -1 : 1) : 0;
        return { delta, gamma: 0, theta: 0, vega: 0, rho: 0 };
    }

    const { d1, d2 } = terms;
    const rootT = Math.sqrt(timeYears);
    const pdf = normPdf(d1);
    const discountedStrike = strike * Math.exp(-rate * timeYears);

    const delta = optionType === 'PUT' ? normCdf(d1) - 1 : normCdf(d1);
    const gamma = pdf / (spot * vol * rootT);
    const vega = spot * pdf * rootT / 100;

    const decay = -(spot * pdf * vol) / (2 * rootT);
    const carry = optionType === 'PUT'
        ? rate * discountedStrike * normCdf(-d2)
        : -rate * discountedStrike * normCdf(d2);
    const theta = (decay + carry) / 365;

    const rho = (optionType === 'PUT'
        ? -timeYears * discountedStrike * normCdf(-d2)
        : timeYears * discountedStrike * normCdf(d2)) / 100;

    return { delta, gamma, theta, vega, rho };
}

/**
 * Risk-neutral probability that the contract finishes in the money - N(d2) for
 * a call, N(-d2) for a put. This is what the UI shows as "probability ITM",
 * and it is also the fair price of a binary contract on the same event, which
 * is how the exchange prices event contracts.
 */
function probabilityItm({ spot, strike, timeYears, vol, rate = 0, optionType }) {
    const terms = dTerms({ spot, strike, timeYears, vol, rate });
    if (!terms) return intrinsicValue({ spot, strike, optionType }) > 0 ? 1 : 0;
    return optionType === 'PUT' ? normCdf(-terms.d2) : normCdf(terms.d2);
}

/**
 * Break-even underlying price at expiry for a long contract bought at
 * `premium` per share: strike + premium for a call, strike - premium for a put.
 */
function breakEven({ strike, premium, optionType }) {
    return optionType === 'PUT'
        ? Math.max(0, strike - premium)
        : strike + premium;
}

/**
 * Probability that a long position is profitable at expiry, i.e. that the
 * underlying finishes past break-even rather than merely in the money.
 */
function probabilityOfProfit({ spot, strike, premium, timeYears, vol, rate = 0, optionType }) {
    const target = breakEven({ strike, premium, optionType });
    if (target <= 0) return optionType === 'PUT' ? 0 : 1;
    return probabilityItm({ spot, strike: target, timeYears, vol, rate, optionType });
}

/**
 * Annualized volatility implied by an observed premium (bisection on price,
 * which is monotonic in vol). Returns null when no volatility in the search
 * range reproduces the premium - e.g. a quote below intrinsic value.
 */
function impliedVolatility({ spot, strike, timeYears, rate = 0, optionType, premium, tolerance = 1e-6, maxIterations = 100 }) {
    if (!(timeYears > 0) || !(premium > 0)) return null;
    let low = 1e-4;
    let high = 5;
    if (price({ spot, strike, timeYears, vol: high, rate, optionType }) < premium) return null;
    if (price({ spot, strike, timeYears, vol: low, rate, optionType }) > premium) return null;

    for (let i = 0; i < maxIterations; i++) {
        const mid = (low + high) / 2;
        const value = price({ spot, strike, timeYears, vol: mid, rate, optionType });
        if (Math.abs(value - premium) < tolerance) return mid;
        if (value > premium) high = mid;
        else low = mid;
    }
    return (low + high) / 2;
}

/**
 * Annualized realized volatility from a series of closing prices (the standard
 * deviation of daily log returns, scaled by sqrt(252) trading days).
 * @param {number[]} closes - chronological closing prices (>= 3 needed)
 * @returns {number|null} annualized vol, or null when the series is too short
 */
function realizedVolatility(closes, { periodsPerYear = 252 } = {}) {
    const series = (closes || []).filter(value => Number.isFinite(value) && value > 0);
    if (series.length < 3) return null;

    const returns = [];
    for (let i = 1; i < series.length; i++) {
        returns.push(Math.log(series[i] / series[i - 1]));
    }
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    // Sample variance (n-1): the series is a sample of the price process
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const vol = Math.sqrt(variance * periodsPerYear);
    return Number.isFinite(vol) && vol > 0 ? vol : null;
}

module.exports = {
    normPdf,
    normCdf,
    intrinsicValue,
    price,
    greeks,
    probabilityItm,
    probabilityOfProfit,
    breakEven,
    impliedVolatility,
    realizedVolatility
};
