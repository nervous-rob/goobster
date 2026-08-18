const db = require('../../db');
const economyService = require('../economyService');
const stockService = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const marginMath = require('./marginMath');
const { toSqlTime } = require('./accountService');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

const MAX_MARGIN = 100_000_000;
// The engine liquidates when losses eat through all but this fraction of the
// posted margin - the remnant is returned, like a real perp's insurance buffer
const MAINTENANCE_BUFFER = 0.2;

/**
 * Perpetual futures: leveraged long/short contracts on any USD symbol -
 * including crypto pairs (BTC-USD, ETH-USD), which trade around the clock.
 *
 * Isolated margin, deliberately: the points posted as margin ARE the maximum
 * loss. The margin leaves the wallet when the position opens (so the wallet
 * stays honest), unrealized P/L accrues against it, funding rent erodes it
 * daily, and the engine liquidates when the mark crosses the liquidation
 * price. No position can ever dig into the rest of the account - that is
 * what the stock-margin book is for.
 */
class PerpsService {
    /** A user's open perps. */
    async listPositions({ guildId, userId, status = 'OPEN', limit = 25 }) {
        const filter = status === 'all' ? '' : 'AND status = @status';
        return await db.all(
            `SELECT * FROM perp_positions WHERE guildId = @guildId AND userId = @userId ${filter}
             ORDER BY id DESC LIMIT @limit`,
            { guildId, userId, status, limit }
        );
    }

    async getPosition({ guildId, userId, id }) {
        return await db.get(
            'SELECT * FROM perp_positions WHERE id = @id AND guildId = @guildId AND userId = @userId',
            { guildId, userId, id }
        ) || null;
    }

    /**
     * Open a perp. The margin is escrowed from the wallet immediately.
     * @param {Object} params - { guildId, userId, symbol, direction, margin, leverage }
     */
    async open({ guildId, userId, symbol, direction, margin, leverage, now = new Date() }) {
        const settings = await exchangeConfig.requireFeature(guildId, 'futuresEnabled', 'Perpetual futures');

        const side = String(direction || '').toUpperCase();
        if (side !== 'LONG' && side !== 'SHORT') {
            throw new ExchangeError('BAD_DIRECTION', 'Direction must be LONG or SHORT.');
        }
        const posted = Math.floor(Number(margin));
        if (!Number.isInteger(posted) || posted <= 0 || posted > MAX_MARGIN) {
            throw new ExchangeError('BAD_MARGIN', `Margin must be a whole number of points up to ${MAX_MARGIN.toLocaleString()}.`);
        }
        const lever = Number(leverage);
        if (!Number.isFinite(lever) || lever < 1 || lever > settings.maxPerpLeverage) {
            throw new ExchangeError('BAD_LEVERAGE', `Perp leverage must be between 1x and ${settings.maxPerpLeverage}x in this server.`);
        }

        const resolved = optionsMarket.resolveUnderlying(symbol);
        const quote = await stockService.getQuote(resolved.symbol);
        if (quote.currency && quote.currency !== 'USD') {
            throw new ExchangeError('NOT_USD', `${resolved.symbol} trades in ${quote.currency}; perps need USD marks (1 point = $1).`);
        }

        const units = (posted * lever) / quote.price;
        const state = marginMath.perpState({
            direction: side, units, entryPrice: quote.price, margin: posted,
            leverage: lever, fundingAccrued: 0, price: quote.price, maintenanceBuffer: MAINTENANCE_BUFFER
        });

        return await db.transaction(async () => {
            const balance = await economyService.adjust({
                guildId, userId, amount: -posted,
                type: 'perp-open',
                detail: JSON.stringify({ symbol: resolved.symbol, direction: side, leverage: lever, entry: quote.price })
            });
            const id = (await db.run(
                `INSERT INTO perp_positions (
                     guildId, userId, symbol, direction, units, entryPrice, margin,
                     leverage, liquidationPrice, lastFundingAt
                 ) VALUES (
                     @guildId, @userId, @symbol, @direction, @units, @entry, @margin,
                     @leverage, @liq, @stamp
                 )`,
                {
                    guildId, userId, symbol: resolved.symbol, direction: side,
                    units, entry: quote.price, margin: posted, leverage: lever,
                    liq: state.liquidationPrice, stamp: toSqlTime(now)
                }
            )).lastInsertRowid;

            await exchangeEvents.record({
                guildId, userId, eventType: 'perp-open', symbol: resolved.symbol, amount: -posted,
                detail: { id, direction: side, leverage: lever, entry: quote.price, units: round(units, 6), liquidationPrice: round(state.liquidationPrice, 2) }
            });

            return {
                id,
                symbol: resolved.symbol,
                alias: resolved.alias,
                direction: side,
                units: round(units, 6),
                entryPrice: quote.price,
                margin: posted,
                leverage: lever,
                notional: Math.round(posted * lever),
                liquidationPrice: round(state.liquidationPrice, 2),
                fundingRateDaily: settings.fundingRateDaily,
                balance
            };
        });
    }

    /**
     * Close a perp at the current mark. The wallet gets back whatever the
     * margin is worth: margin + P/L - funding, floored at zero.
     */
    async close({ guildId, userId, id, now = new Date(), reason = 'closed' }) {
        const position = await this.getPosition({ guildId, userId, id });
        if (!position || position.status !== 'OPEN') {
            throw new ExchangeError('NO_POSITION', `No open perp #${id} of yours.`);
        }
        const quote = await stockService.getQuote(position.symbol);
        return await this._settle({ position, price: quote.price, status: 'CLOSED', reason, now });
    }

    /** Settle a position at a price (close or liquidation). */
    async _settle({ position, price, status, reason, now }) {
        const state = marginMath.perpState({
            direction: position.direction, units: position.units, entryPrice: position.entryPrice,
            margin: position.margin, leverage: position.leverage,
            fundingAccrued: position.fundingAccrued, price, maintenanceBuffer: MAINTENANCE_BUFFER
        });
        const payout = Math.max(0, Math.floor(position.margin + state.unrealized));
        const realized = payout - position.margin;

        return await db.transaction(async () => {
            if (payout > 0) {
                await economyService.adjust({
                    guildId: position.guildId, userId: position.userId, amount: payout,
                    type: status === 'LIQUIDATED' ? 'perp-liquidation' : 'perp-close',
                    detail: JSON.stringify({ id: position.id, symbol: position.symbol, exit: price, reason })
                });
            }
            await db.run(
                `UPDATE perp_positions SET status = @status, exitPrice = @price, payout = @payout,
                     realizedPL = @realized, closedAt = @stamp, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: position.id, status, price, payout, realized, stamp: toSqlTime(now) }
            );
            await exchangeEvents.record({
                guildId: position.guildId, userId: position.userId,
                eventType: status === 'LIQUIDATED' ? 'perp-liquidation' : 'perp-close',
                symbol: position.symbol, amount: realized,
                detail: {
                    id: position.id, direction: position.direction, entry: position.entryPrice,
                    exit: price, funding: Math.round(position.fundingAccrued), reason
                }
            });
            return { position: { ...position, status }, exitPrice: price, payout, realized, funding: position.fundingAccrued };
        });
    }

    /**
     * The engine pass: accrue funding on every open perp and liquidate the
     * ones whose mark has crossed their liquidation price (or whose margin
     * funding has eaten). A missing mark defers - never liquidate blind.
     * @returns {Promise<{funded: number, liquidated: Array}>}
     */
    async sweep({ guildId, now = new Date() }) {
        const settings = await exchangeConfig.get(guildId);
        const open = await db.all(
            "SELECT * FROM perp_positions WHERE guildId = @guildId AND status = 'OPEN' ORDER BY id LIMIT 500",
            { guildId }
        );
        const result = { funded: 0, liquidated: [] };
        const prices = new Map();

        for (const position of open) {
            // Funding rent on notional, prorated since the last accrual
            const last = position.lastFundingAt ? new Date(`${position.lastFundingAt}Z`) : now;
            const days = Math.max(0, (now.getTime() - last.getTime()) / 86_400_000);
            const funding = position.units * position.entryPrice * settings.fundingRateDaily * days;
            if (funding > 0) {
                await db.run(
                    `UPDATE perp_positions SET fundingAccrued = fundingAccrued + @funding,
                         lastFundingAt = @stamp, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
                    { id: position.id, funding, stamp: toSqlTime(now) }
                );
                position.fundingAccrued += funding;
                result.funded += funding;
            }

            if (!prices.has(position.symbol)) {
                try {
                    prices.set(position.symbol, (await stockService.getQuote(position.symbol)).price);
                } catch {
                    prices.set(position.symbol, null);
                }
            }
            const price = prices.get(position.symbol);
            if (price === null) continue;

            const state = marginMath.perpState({
                direction: position.direction, units: position.units, entryPrice: position.entryPrice,
                margin: position.margin, leverage: position.leverage,
                fundingAccrued: position.fundingAccrued, price, maintenanceBuffer: MAINTENANCE_BUFFER
            });
            if (state.liquidated) {
                const settled = await this._settle({
                    position, price, status: 'LIQUIDATED',
                    reason: state.unrealized <= -position.margin ? 'margin-exhausted' : 'liquidation-price-crossed',
                    now
                });
                result.liquidated.push(settled);
            }
        }
        return result;
    }

    /** Mark a user's open perps for the account snapshot. */
    async markPositions({ guildId, userId, quoteFor }) {
        const positions = await this.listPositions({ guildId, userId });
        const marked = [];
        let totalValue = 0;
        for (const position of positions) {
            const quote = await quoteFor(position.symbol);
            const state = marginMath.perpState({
                direction: position.direction, units: position.units, entryPrice: position.entryPrice,
                margin: position.margin, leverage: position.leverage,
                fundingAccrued: position.fundingAccrued, price: quote?.price ?? null,
                maintenanceBuffer: MAINTENANCE_BUFFER
            });
            if (state.value !== null) totalValue += state.value;
            marked.push({
                id: position.id,
                symbol: position.symbol,
                direction: position.direction,
                units: position.units,
                entryPrice: position.entryPrice,
                margin: position.margin,
                leverage: position.leverage,
                fundingAccrued: position.fundingAccrued,
                price: quote?.price ?? null,
                priced: !!quote,
                unrealized: state.unrealized,
                value: state.value,
                liquidationPrice: round(state.liquidationPrice, 2),
                openedAt: position.openedAt
            });
        }
        return { positions: marked, totalValue };
    }
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

module.exports = new PerpsService();
module.exports.MAINTENANCE_BUFFER = MAINTENANCE_BUFFER;
