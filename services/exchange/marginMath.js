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
    longValue = 0,
    shortValue = 0,
    leverage = 1
}) {
    if (accountType !== 'MARGIN') return Math.max(0, cash);
    const collateral = Math.max(0, accountEquity - optionValue);
    const capacity = collateral * leverage;
    return Math.max(0, capacity - longValue - shortValue);
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

module.exports = {
    equity,
    maintenanceRequirement,
    buyingPower,
    liquidationPrice,
    marketMoveToMarginCall,
    liquidationPlan
};
