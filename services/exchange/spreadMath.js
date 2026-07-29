/**
 * Multi-leg option payoff analysis - pure functions, no I/O.
 *
 * A spread's payoff at expiry is piecewise linear in the underlying price
 * with kinks only at the strikes, so max gain, max loss, and break-evens are
 * fully determined by the vertex payoffs plus the slopes beyond the outermost
 * strikes. That makes the analysis exact for ANY structure - verticals,
 * condors, butterflies, straddles, ratio spreads - not just the named ones.
 */

/** Payoff of one leg at expiry, per share (sign carries buy/sell). */
function legPayoffAt({ price, leg }) {
    const intrinsic = leg.optionType === 'PUT'
        ? Math.max(0, leg.strike - price)
        : Math.max(0, price - leg.strike);
    const sign = leg.action === 'SELL' ? -1 : 1;
    return sign * intrinsic * leg.contracts * (leg.contractSize || 100);
}

/** Total position payoff at expiry (before premium) at one price. */
function payoffAt({ price, legs }) {
    return legs.reduce((sum, leg) => sum + legPayoffAt({ price, leg }), 0);
}

/**
 * Full expiry profile of a set of legs given the net premium paid (positive
 * = debit) - profit(S) = payoff(S) - netDebit.
 *
 * @param {Array} legs - { action: 'BUY'|'SELL', optionType, strike, contracts, contractSize? }
 * @param {number} netDebit - points paid (negative for a net credit)
 * @returns {{maxGain: number|null, maxLoss: number|null, breakEvens: number[],
 *            unboundedGain: boolean, unboundedLoss: boolean}}
 *          maxGain/maxLoss are null when unbounded on that side.
 */
function analyzeSpread({ legs, netDebit }) {
    const strikes = [...new Set(legs.map(leg => leg.strike))].sort((a, b) => a - b);
    const vertices = [0, ...strikes];
    const profits = vertices.map(price => payoffAt({ price, legs }) - netDebit);

    // Beyond the top strike every call is pure slope and every put is flat
    const callSlope = legs
        .filter(leg => leg.optionType === 'CALL')
        .reduce((sum, leg) => sum + (leg.action === 'SELL' ? -1 : 1) * leg.contracts * (leg.contractSize || 100), 0);

    let maxGain = Math.max(...profits);
    let maxLoss = Math.min(...profits);
    const unboundedGain = callSlope > 0;
    const unboundedLoss = callSlope < 0;

    const breakEvens = [];
    for (let i = 1; i < vertices.length; i++) {
        const [p0, p1] = [profits[i - 1], profits[i]];
        if ((p0 < 0 && p1 >= 0) || (p0 >= 0 && p1 < 0)) {
            const [s0, s1] = [vertices[i - 1], vertices[i]];
            breakEvens.push(s0 + (s1 - s0) * (Math.abs(p0) / (Math.abs(p0) + Math.abs(p1))));
        } else if (p1 === 0 && p0 !== 0) {
            breakEvens.push(vertices[i]);
        }
    }
    // A crossing on the open-ended segment above the top strike
    const topProfit = profits[profits.length - 1];
    if (callSlope !== 0 && ((topProfit < 0 && callSlope > 0) || (topProfit > 0 && callSlope < 0))) {
        breakEvens.push(vertices[vertices.length - 1] + Math.abs(topProfit) / Math.abs(callSlope));
    }

    return {
        maxGain: unboundedGain ? null : round2(maxGain),
        maxLoss: unboundedLoss ? null : round2(maxLoss),
        breakEvens: [...new Set(breakEvens.map(round2))].sort((a, b) => a - b),
        unboundedGain,
        unboundedLoss
    };
}

/**
 * Recognize the classic structures so the receipt can name what it is
 * selling you. Anything unrecognized is honestly called a custom spread.
 */
function classifySpread(legs) {
    const sorted = [...legs].sort((a, b) => a.strike - b.strike);
    const calls = sorted.filter(leg => leg.optionType === 'CALL');
    const puts = sorted.filter(leg => leg.optionType === 'PUT');
    const buys = sorted.filter(leg => leg.action === 'BUY');
    const sells = sorted.filter(leg => leg.action === 'SELL');
    const sameQty = sorted.every(leg => leg.contracts === sorted[0].contracts);
    const expiries = new Set(legs.map(leg => leg.expiry));
    if (expiries.size > 1) return 'calendar/diagonal spread';

    if (legs.length === 1) {
        const leg = legs[0];
        return `${leg.action === 'SELL' ? 'short' : 'long'} ${leg.optionType.toLowerCase()}`;
    }

    if (legs.length === 2 && sameQty) {
        if (calls.length === 1 && puts.length === 1) {
            if (buys.length === 2) {
                return calls[0].strike === puts[0].strike ? 'long straddle' : 'long strangle';
            }
            if (sells.length === 2) {
                return calls[0].strike === puts[0].strike ? 'short straddle' : 'short strangle';
            }
        }
        if ((calls.length === 2 || puts.length === 2) && buys.length === 1 && sells.length === 1) {
            const type = calls.length === 2 ? 'call' : 'put';
            const bought = buys[0];
            const sold = sells[0];
            const bullish = type === 'call' ? bought.strike < sold.strike : sold.strike < bought.strike;
            const debit = (type === 'call') === bullish;
            return `${bullish ? 'bull' : 'bear'} ${type} spread (${debit ? 'debit' : 'credit'})`;
        }
    }

    if (legs.length === 3 && (calls.length === 3 || puts.length === 3)) {
        const middle = sorted[1];
        if (sorted[0].action === sorted[2].action && middle.action !== sorted[0].action
            && middle.contracts === sorted[0].contracts + sorted[2].contracts) {
            return `${sorted[0].action === 'BUY' ? 'long' : 'short'} butterfly`;
        }
    }

    if (legs.length === 4 && calls.length === 2 && puts.length === 2 && sameQty) {
        const [lowPut, highPut] = puts;
        const [lowCall, highCall] = calls;
        const shortInner = highPut.action === 'SELL' && lowCall.action === 'SELL'
            && lowPut.action === 'BUY' && highCall.action === 'BUY';
        const longInner = highPut.action === 'BUY' && lowCall.action === 'BUY'
            && lowPut.action === 'SELL' && highCall.action === 'SELL';
        if (shortInner) return 'iron condor (short volatility)';
        if (longInner) return 'inverse iron condor (long volatility)';
    }

    if ((calls.length === legs.length || puts.length === legs.length) && buys.length && sells.length && !sameQty) {
        return 'ratio spread';
    }
    return 'custom spread';
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

module.exports = { payoffAt, analyzeSpread, classifySpread };
