/**
 * Margin arithmetic - pure functions, no I/O, so every number the exchange
 * shows a trader before they take leverage is testable in isolation.
 *
 * The model, in one line:
 *   equity = cash + long stock + long options - short stock - debt
 * and an account is healthy while equity covers the maintenance requirement
 * on its stock exposure. Long options are fully paid, so they add to equity
 * but never create a maintenance requirement (and never back new borrowing).
 */

/** Net worth of an account, in points. */
function equity({ cash = 0, longValue = 0, optionValue = 0, shortValue = 0, debt = 0 }) {
    return cash + longValue + optionValue - shortValue - debt;
}

/** Equity the account must keep to hold its current stock exposure. */
function maintenanceRequirement({ longValue = 0, shortValue = 0, maintenanceMargin, shortMaintenanceMargin }) {
    return longValue * maintenanceMargin + shortValue * shortMaintenanceMargin;
}

/**
 * Points available for new positions.
 *
 * A cash account can only spend cash. A margin account can hold positions up
 * to `equity x leverage`, minus what it already holds - with long options
 * excluded from the collateral base, since they are not marginable.
 */
function buyingPower({
    accountType = 'CASH',
    cash = 0,
    equity: accountEquity = 0,
    optionValue = 0,
    perpValue = 0,
    longValue = 0,
    shortValue = 0,
    optionRequirement = 0,
    leverage = 1
}) {
    if (accountType !== 'MARGIN') return Math.max(0, cash);
    // Long options and perp margin are not marginable collateral, and short
    // options consume their requirement off the top
    const collateral = Math.max(0, accountEquity - optionValue - perpValue);
    const capacity = collateral * leverage;
    return Math.max(0, capacity - longValue - shortValue - optionRequirement);
}

/**
 * The price at which one stock position drags the whole account to its
 * maintenance requirement, holding every other position still.
 *
 * Solves `equity(p) = maintenance(p)` for the position's price. Returns null
 * when no such price exists on the correct side of the market (e.g. an
 * unlevered account that simply cannot be called).
 *
 * @param {Object} params
 * @param {'LONG'|'SHORT'} params.direction
 * @param {number} params.units - units held (positive for both directions)
 * @param {number} params.otherLongValue - value of the account's *other* longs
 * @param {number} params.otherShortValue - value of the account's *other* shorts
 * @returns {number|null} price per unit
 */
function liquidationPrice({
    direction,
    units,
    cash = 0,
    optionValue = 0,
    otherLongValue = 0,
    otherShortValue = 0,
    debt = 0,
    maintenanceMargin,
    shortMaintenanceMargin
}) {
    if (!(units > 0)) return null;
    const constant = cash + optionValue + otherLongValue - otherShortValue - debt
        - otherLongValue * maintenanceMargin - otherShortValue * shortMaintenanceMargin;

    if (direction === 'LONG') {
        // equity gains (1 - m) per point of price; the call comes on the way down
        const slope = units * (1 - maintenanceMargin);
        if (slope <= 0) return null;
        const price = -constant / slope;
        return price > 0 ? price : null;
    }

    // A short loses (1 + shortMaintenance) per point of price; the call is upward
    const slope = units * (1 + shortMaintenanceMargin);
    if (slope <= 0) return null;
    const price = constant / slope;
    return price > 0 ? price : null;
}

/**
 * How far the whole market can move against the account before a margin call,
 * as a fraction of current prices (0.18 = "an 18% drop calls you").
 *
 * Options enter through delta-dollars, so this is a first-order estimate: real
 * option convexity means a fast move bites sooner than the number suggests.
 * @returns {{level: number, drop: number}|null} level = market factor at the call
 */
function marketMoveToMarginCall({
    cash = 0,
    longValue = 0,
    optionValue = 0,
    optionDeltaDollars = 0,
    shortValue = 0,
    debt = 0,
    maintenanceMargin,
    shortMaintenanceMargin
}) {
    const slope = optionDeltaDollars
        + longValue * (1 - maintenanceMargin)
        - shortValue * (1 + shortMaintenanceMargin);
    if (Math.abs(slope) < 1e-9) return null;

    const constant = cash + optionValue - optionDeltaDollars - debt;
    const level = -constant / slope;
    if (!Number.isFinite(level) || level <= 0) return null;
    return { level, drop: 1 - level };
}

/**
 * Which positions to sell, and how much of each, to bring an account back to
 * its maintenance requirement. Liquidates the largest exposures first, since
 * each unit sold relieves the most requirement per unit of disruption.
 *
 * @param {Array<{key: string, direction: 'LONG'|'SHORT', value: number, units: number}>} positions
 * @returns {Array<{key: string, direction: string, units: number, value: number}>}
 */
function liquidationPlan({ positions, shortfall, maintenanceMargin, shortMaintenanceMargin }) {
    if (!(shortfall > 0)) return [];
    const plan = [];
    let remaining = shortfall;

    const ordered = [...positions].filter(p => p.value > 0 && p.units > 0)
        .sort((a, b) => b.value - a.value);

    for (const position of ordered) {
        if (remaining <= 1e-9) break;
        // Selling a long frees its maintenance requirement AND turns the
        // position into cash, so each point of value closed repairs `m` points
        // of shortfall. Covering a short repairs `1 + sm`... but only the
        // maintenance part, since the cash leaves with the buy-back.
        const repairPerValue = position.direction === 'LONG'
            ? maintenanceMargin
            : shortMaintenanceMargin;
        if (repairPerValue <= 0) continue;

        const valueNeeded = remaining / repairPerValue;
        const valueToClose = Math.min(position.value, valueNeeded);
        const units = position.units * (valueToClose / position.value);
        plan.push({
            key: position.key,
            direction: position.direction,
            units,
            value: valueToClose
        });
        remaining -= valueToClose * repairPerValue;
    }
    return plan;
}

/**
 * Margin requirement for ONE naked short contract, per the classic broker
 * rule: the mark plus 20% of the underlying less the out-of-the-money amount,
 * floored at the mark plus 10% of (spot for calls, strike for puts).
 * @returns {number} points required for one contract
 */
function nakedShortRequirement({ spot, strike, optionType, mark, contractSize = 100 }) {
    const otm = optionType === 'PUT' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    const base = Math.max(0.2 * spot - otm, 0.1 * (optionType === 'PUT' ? strike : spot));
    return (mark + Math.max(0, base)) * contractSize;
}

/**
 * The margin requirement of a whole option book, with offsets:
 *   - a short call covered by underlying shares requires nothing (the shares
 *     are the cover; they carry their own stock maintenance),
 *   - a short paired with a long of the same type/expiry requires the strike
 *     width when the long is the cheaper wing (defined risk), and nothing
 *     when the long is deeper in the money (a debit spread),
 *   - whatever is left is naked and pays the full requirement.
 *
 * Longs and shares consumed as cover are not reused. Pairing is greedy by
 * smallest width, which is also the smallest requirement.
 *
 * @param {Array} positions - open option lots: { id, underlying, optionType,
 *        expiry, side, strike, contracts, contractSize, mark, spot }
 * @param {Object} sharesBySymbol - { SYMBOL: units held long }
 * @returns {{total: number, breakdown: Array<{id, covered, spread, naked, requirement}>}}
 */
function optionBookRequirement({ positions, sharesBySymbol = {} }) {
    const shares = new Map(Object.entries(sharesBySymbol));
    const breakdown = [];
    let total = 0;

    const groups = new Map();
    for (const position of positions) {
        const key = `${position.underlying}|${position.expiry}|${position.optionType}`;
        if (!groups.has(key)) groups.set(key, { longs: [], shorts: [] });
        groups.get(key)[position.side === 'SHORT' ? 'shorts' : 'longs'].push({ ...position });
    }

    for (const group of groups.values()) {
        for (const short of group.shorts) {
            let remaining = short.contracts;
            const entry = { id: short.id, covered: 0, spread: 0, naked: 0, requirement: 0 };

            // 1. Cover calls with underlying shares
            if (short.optionType === 'CALL') {
                const held = shares.get(short.underlying) || 0;
                const coverable = Math.min(remaining, Math.floor(held / short.contractSize));
                if (coverable > 0) {
                    entry.covered = coverable;
                    remaining -= coverable;
                    shares.set(short.underlying, held - coverable * short.contractSize);
                }
            }

            // 2. Pair with long contracts of the same type/expiry, nearest strike first
            const candidates = group.longs
                .filter(long => long.contracts > 0)
                .sort((a, b) => Math.abs(a.strike - short.strike) - Math.abs(b.strike - short.strike));
            for (const long of candidates) {
                if (remaining <= 0) break;
                const paired = Math.min(remaining, long.contracts);
                const width = short.optionType === 'CALL'
                    ? long.strike - short.strike
                    : short.strike - long.strike;
                entry.spread += paired;
                entry.requirement += Math.max(0, width) * short.contractSize * paired;
                long.contracts -= paired;
                remaining -= paired;
            }

            // 3. The rest is naked
            if (remaining > 0) {
                entry.naked = remaining;
                entry.requirement += nakedShortRequirement({
                    spot: short.spot, strike: short.strike, optionType: short.optionType,
                    mark: short.mark, contractSize: short.contractSize
                }) * remaining;
            }

            total += entry.requirement;
            breakdown.push(entry);
        }
    }
    return { total, breakdown };
}

/**
 * Perpetual-future bookkeeping for one position: unrealized P/L, what the
 * margin is currently worth, and the liquidation price.
 * Isolated margin: the escrowed margin is the whole maximum loss.
 */
function perpState({ direction, units, entryPrice, margin, leverage, fundingAccrued = 0, price, maintenanceBuffer = 0.2 }) {
    const sign = direction === 'SHORT' ? -1 : 1;
    const unrealized = price === null || price === undefined
        ? null
        : sign * units * (price - entryPrice) - fundingAccrued;
    const value = unrealized === null ? null : Math.max(0, margin + unrealized);
    // The engine closes the position when losses eat through all but the
    // buffer of the margin (funding erosion shifts the level toward entry)
    const lossBudget = Math.max(0, margin * (1 - maintenanceBuffer) - fundingAccrued);
    const move = units > 0 ? lossBudget / units : 0;
    const liquidationPrice = direction === 'SHORT' ? entryPrice + move : Math.max(0, entryPrice - move);
    const liquidated = price === null || price === undefined
        ? false
        : (direction === 'SHORT' ? price >= liquidationPrice : price <= liquidationPrice);
    return { unrealized, value, liquidationPrice, liquidated, notional: units * entryPrice };
}

module.exports = {
    equity,
    maintenanceRequirement,
    buyingPower,
    liquidationPrice,
    marketMoveToMarginCall,
    liquidationPlan,
    nakedShortRequirement,
    optionBookRequirement,
    perpState
};
