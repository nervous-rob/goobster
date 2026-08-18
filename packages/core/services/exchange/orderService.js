const db = require('../../db');
const stockService = require('../stockService');
const stockPortfolioService = require('../stockPortfolioService');
const shortService = require('./shortService');
const exchangeEvents = require('./exchangeEvents');
const { toSqlTime } = require('./accountService');
const { ExchangeError } = require('./errors');

const MAX_OPEN_ORDERS = 25;
const MAX_UNITS = 1_000_000;
const SIDES = ['BUY', 'SELL', 'SHORT', 'COVER'];
const ORDER_TYPES = ['LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP'];

/**
 * Resting orders: limit, stop, stop-limit, and trailing stop.
 *
 * Orders are intentions, not reservations - nothing is escrowed when one is
 * placed, and every fill runs the ordinary trade path (same wallet checks,
 * same ledger entries, same buying-power rules). An order that can no longer
 * be honoured is REJECTED with the reason attached rather than silently
 * dropped, so `/orders list` always explains itself.
 *
 * A stop is a *trigger*, not a guaranteed price: the engine checks prices on
 * its tick, so a gap through a stop fills at the price it finds, exactly like
 * the real thing.
 */
class OrderService {
    /**
     * Place a resting order.
     * @param {Object} params - { guildId, userId, symbol, side, orderType, units,
     *                            limitPrice?, stopPrice?, trailPercent?, expiresAt? }
     */
    async place({
        guildId, userId, symbol, side, orderType, units,
        limitPrice = null, stopPrice = null, trailPercent = null, expiresAt = null, now = new Date()
    }) {
        const normalizedSide = String(side || '').toUpperCase();
        const normalizedType = String(orderType || '').toUpperCase();
        if (!SIDES.includes(normalizedSide)) {
            throw new ExchangeError('BAD_SIDE', `Side must be one of: ${SIDES.join(', ').toLowerCase()}.`);
        }
        if (!ORDER_TYPES.includes(normalizedType)) {
            throw new ExchangeError('BAD_ORDER_TYPE', `Order type must be one of: ${ORDER_TYPES.join(', ').toLowerCase()}.`);
        }

        const amount = Number(units);
        if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_UNITS) {
            throw new ExchangeError('BAD_UNITS', `Units must be a positive number up to ${MAX_UNITS.toLocaleString()}.`);
        }

        const open = (await db.get(
            `SELECT COUNT(*) AS count FROM exchange_orders
             WHERE guildId = @guildId AND userId = @userId AND status IN ('OPEN', 'TRIGGERED')`,
            { guildId, userId }
        )).count;
        if (open >= MAX_OPEN_ORDERS) {
            throw new ExchangeError('TOO_MANY_ORDERS', `You already have ${MAX_OPEN_ORDERS} working orders. Cancel one first.`);
        }

        const needsLimit = normalizedType === 'LIMIT' || normalizedType === 'STOP_LIMIT';
        const needsStop = normalizedType === 'STOP' || normalizedType === 'STOP_LIMIT';
        if (needsLimit && !(Number(limitPrice) > 0)) {
            throw new ExchangeError('BAD_PRICE', 'A limit order needs a positive limit price.');
        }
        if (needsStop && !(Number(stopPrice) > 0)) {
            throw new ExchangeError('BAD_PRICE', 'A stop order needs a positive stop price.');
        }
        if (normalizedType === 'TRAILING_STOP') {
            const trail = Number(trailPercent);
            if (!Number.isFinite(trail) || trail <= 0 || trail >= 100) {
                throw new ExchangeError('BAD_TRAIL', 'A trailing stop needs a trail between 0 and 100 percent.');
            }
            if (normalizedSide !== 'SELL' && normalizedSide !== 'COVER') {
                throw new ExchangeError('BAD_TRAIL', 'Trailing stops protect an open position - use side sell (for a long) or cover (for a short).');
            }
        }

        const quote = await stockService.getQuote(symbol);
        const resolved = quote.symbol;
        if (normalizedSide === 'SELL' && !await stockPortfolioService.getHolding({ guildId, userId, symbol: resolved })) {
            throw new ExchangeError('NO_HOLDING', `You don't hold any ${resolved} to sell.`);
        }
        if (normalizedSide === 'COVER' && !await shortService.getPosition({ guildId, userId, symbol: resolved })) {
            throw new ExchangeError('NO_SHORT', `You have no short position in ${resolved} to cover.`);
        }

        const id = await db.insert(
            `INSERT INTO exchange_orders (
                 guildId, userId, symbol, side, orderType, units,
                 limitPrice, stopPrice, trailPercent, trailAnchor, expiresAt
             ) VALUES (
                 @guildId, @userId, @symbol, @side, @orderType, @units,
                 @limitPrice, @stopPrice, @trailPercent, @trailAnchor, @expiresAt
             )`,
            {
                guildId, userId, symbol: resolved, side: normalizedSide, orderType: normalizedType,
                units: amount,
                limitPrice: needsLimit ? Number(limitPrice) : null,
                stopPrice: needsStop ? Number(stopPrice) : null,
                trailPercent: normalizedType === 'TRAILING_STOP' ? Number(trailPercent) : null,
                trailAnchor: normalizedType === 'TRAILING_STOP' ? quote.price : null,
                expiresAt: expiresAt ? toSqlTime(new Date(expiresAt)) : null
            }
        );

        await exchangeEvents.record({
            guildId, userId, eventType: 'order-place', symbol: resolved,
            detail: { id, side: normalizedSide, orderType: normalizedType, units: amount, limitPrice, stopPrice, trailPercent }
        });

        return {
            order: await this.get({ guildId, userId, id }),
            referencePrice: quote.price,
            triggerHint: this._triggerDescription({
                side: normalizedSide, orderType: normalizedType,
                limitPrice, stopPrice, trailPercent, trailAnchor: quote.price
            }),
            now: toSqlTime(now)
        };
    }

    async get({ guildId, userId, id }) {
        return await db.get(
            'SELECT * FROM exchange_orders WHERE id = @id AND guildId = @guildId AND userId = @userId',
            { guildId, userId, id }
        ) || null;
    }

    /** A user's orders (working ones by default). */
    async list({ guildId, userId, status = 'working', limit = 25 }) {
        const filter = status === 'working'
            ? "AND status IN ('OPEN', 'TRIGGERED')"
            : status === 'all' ? '' : 'AND status = @status';
        return await db.all(
            `SELECT * FROM exchange_orders WHERE guildId = @guildId AND userId = @userId ${filter}
             ORDER BY id DESC LIMIT @limit`,
            { guildId, userId, status, limit }
        );
    }

    /** Cancel a working order. */
    async cancel({ guildId, userId, id }) {
        const order = await this.get({ guildId, userId, id });
        if (!order) throw new ExchangeError('NO_ORDER', `No order #${id} of yours.`);
        if (order.status !== 'OPEN' && order.status !== 'TRIGGERED') {
            throw new ExchangeError('ORDER_CLOSED', `Order #${id} is already ${order.status.toLowerCase()}.`);
        }
        await db.run(
            `UPDATE exchange_orders SET status = 'CANCELLED', closedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id }
        );
        await exchangeEvents.record({ guildId, userId, eventType: 'order-cancel', symbol: order.symbol, detail: { id } });
        return await this.get({ guildId, userId, id });
    }

    /**
     * Walk every working order in a guild against fresh prices: expire the
     * stale ones, drag trailing anchors along, and fill whatever triggered.
     * @returns {Promise<{checked: number, filled: Array, rejected: Array, expired: Array}>}
     */
    async evaluate({ guildId = null, now = new Date() } = {}) {
        const filter = guildId ? 'AND guildId = @guildId' : '';
        const orders = await db.all(
            `SELECT * FROM exchange_orders WHERE status IN ('OPEN', 'TRIGGERED') ${filter}
             ORDER BY id LIMIT 500`,
            { guildId }
        );
        const result = { checked: orders.length, filled: [], rejected: [], expired: [] };
        if (orders.length === 0) return result;

        const prices = new Map();
        for (const order of orders) {
            if (order.expiresAt && new Date(`${order.expiresAt}Z`).getTime() <= now.getTime()) {
                await this._close(order, 'EXPIRED', 'Order reached its good-until time.');
                result.expired.push(order);
                continue;
            }

            if (!prices.has(order.symbol)) {
                try {
                    prices.set(order.symbol, (await stockService.getQuote(order.symbol)).price);
                } catch {
                    prices.set(order.symbol, null);
                }
            }
            const price = prices.get(order.symbol);
            if (price === null) continue;

            const anchor = await this._advanceTrail(order, price);
            if (!this._isTriggered({ ...order, trailAnchor: anchor }, price)) continue;

            if (order.orderType === 'STOP_LIMIT') {
                if (order.status === 'OPEN') {
                    await db.run(
                        `UPDATE exchange_orders SET status = 'TRIGGERED', triggeredAt = @stamp, updatedAt = CURRENT_TIMESTAMP
                         WHERE id = @id`,
                        { id: order.id, stamp: toSqlTime(now) }
                    );
                }
                if (!this._limitSatisfied(order, price)) continue;
            }

            try {
                const fill = await this._fill(order, now);
                result.filled.push({ order, fill, price });
            } catch (error) {
                await this._close(order, 'REJECTED', error.message);
                result.rejected.push({ order, reason: error.message });
                await exchangeEvents.record({
                    guildId: order.guildId, userId: order.userId, eventType: 'order-reject',
                    symbol: order.symbol, detail: { id: order.id, reason: error.message }
                });
            }
        }
        return result;
    }

    /** Trailing stops ratchet with the position and never give ground. */
    async _advanceTrail(order, price) {
        if (order.orderType !== 'TRAILING_STOP') return order.trailAnchor;
        const anchor = order.trailAnchor ?? price;
        const next = order.side === 'SELL' ? Math.max(anchor, price) : Math.min(anchor, price);
        if (next !== anchor) {
            await db.run('UPDATE exchange_orders SET trailAnchor = @next, updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
                { id: order.id, next });
        }
        return next;
    }

    _limitSatisfied(order, price) {
        const buying = order.side === 'BUY' || order.side === 'COVER';
        return buying ? price <= order.limitPrice : price >= order.limitPrice;
    }

    _isTriggered(order, price) {
        if (order.orderType === 'LIMIT') return this._limitSatisfied(order, price);
        if (order.orderType === 'TRAILING_STOP') {
            const trail = order.trailPercent / 100;
            return order.side === 'SELL'
                ? price <= order.trailAnchor * (1 - trail)
                : price >= order.trailAnchor * (1 + trail);
        }
        // STOP and the trigger half of STOP_LIMIT: a stop fires when the market
        // moves *against* the position it protects.
        const upward = order.side === 'BUY' || order.side === 'COVER';
        return upward ? price >= order.stopPrice : price <= order.stopPrice;
    }

    async _fill(order, now) {
        let fill;
        if (order.side === 'BUY') {
            fill = await stockPortfolioService.buy({ guildId: order.guildId, userId: order.userId, symbol: order.symbol, units: order.units });
        } else if (order.side === 'SELL') {
            fill = await stockPortfolioService.sell({ guildId: order.guildId, userId: order.userId, symbol: order.symbol, units: order.units });
        } else if (order.side === 'SHORT') {
            fill = await shortService.openShort({ guildId: order.guildId, userId: order.userId, symbol: order.symbol, units: order.units, now });
        } else {
            fill = await shortService.cover({ guildId: order.guildId, userId: order.userId, symbol: order.symbol, units: order.units, now });
        }

        const points = fill.cost ?? fill.proceeds ?? 0;
        await db.run(
            `UPDATE exchange_orders SET status = 'FILLED', filledPrice = @price, filledUnits = @units,
                 points = @points, closedAt = @stamp, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: order.id, price: fill.price, units: fill.units, points, stamp: toSqlTime(now) }
        );
        await exchangeEvents.record({
            guildId: order.guildId, userId: order.userId, eventType: 'order-fill', symbol: order.symbol,
            amount: points,
            detail: { id: order.id, side: order.side, orderType: order.orderType, units: fill.units, price: fill.price }
        });
        return fill;
    }

    async _close(order, status, note) {
        await db.run(
            `UPDATE exchange_orders SET status = @status, note = @note, closedAt = CURRENT_TIMESTAMP,
                 updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
            { id: order.id, status, note: note ? String(note).slice(0, 300) : null }
        );
    }

    _triggerDescription({ side, orderType, limitPrice, stopPrice, trailPercent, trailAnchor }) {
        const buying = side === 'BUY' || side === 'COVER';
        if (orderType === 'LIMIT') {
            return `fills when ${buying ? 'the price falls to' : 'the price rises to'} $${Number(limitPrice).toFixed(2)}`;
        }
        if (orderType === 'STOP') {
            return `triggers when the price ${buying ? 'rises to' : 'falls to'} $${Number(stopPrice).toFixed(2)}`;
        }
        if (orderType === 'STOP_LIMIT') {
            return `triggers at $${Number(stopPrice).toFixed(2)}, then fills only at $${Number(limitPrice).toFixed(2)} or better`;
        }
        const level = side === 'SELL'
            ? trailAnchor * (1 - trailPercent / 100)
            : trailAnchor * (1 + trailPercent / 100);
        return `trails ${trailPercent}% from $${Number(trailAnchor).toFixed(2)} (currently triggers at $${level.toFixed(2)})`;
    }
}

module.exports = new OrderService();
module.exports.MAX_OPEN_ORDERS = MAX_OPEN_ORDERS;
