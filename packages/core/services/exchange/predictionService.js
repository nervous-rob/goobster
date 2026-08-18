const db = require('../../db');
const economyService = require('../economyService');
const stockService = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const { riskFreeRate } = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const optionsMath = require('./optionsMath');
const { toSqlTime } = require('./accountService');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

// Every contract settles at 100 points, so a price is also a probability.
const PAYOUT = 100;
// The house's cut, in points per contract: YES + NO costs 102, not 100.
const HOUSE_EDGE = 1;
const MIN_PRICE = 1;
const MAX_PRICE = 99;
const MAX_CONTRACTS = 100_000;
const MAX_HORIZON_DAYS = 365;

/**
 * Binary event contracts: "Will AAPL close above $250 by Friday?"
 *
 * Settlement is deterministic and needs no oracle - the market names a real
 * symbol, a threshold, and a resolution time, and the exchange reads the
 * underlying's price at that time. That keeps a speculative product honest:
 * nobody, including an admin, decides who won.
 *
 * Prices come from the same volatility model that prices the option chain -
 * a binary contract IS the risk-neutral probability of the event - plus a
 * fixed house edge, and are capped per user so one whale cannot own an
 * outcome.
 */
class PredictionService {
    /** Create a market. Callers gate this on Manage Server. */
    async createMarket({ guildId, symbol, comparator, threshold, closesAt, resolvesAt, question = null, createdBy = null, positionCap = 500, now = new Date() }) {
        await exchangeConfig.requireFeature(guildId, 'predictionsEnabled', 'Event contracts');

        const normalizedSymbol = optionsMarket.resolveUnderlying(symbol).symbol;
        const direction = String(comparator || '').toUpperCase();
        if (direction !== 'ABOVE' && direction !== 'BELOW') {
            throw new ExchangeError('BAD_COMPARATOR', 'Comparator must be ABOVE or BELOW.');
        }
        const level = Number(threshold);
        if (!Number.isFinite(level) || level <= 0) {
            throw new ExchangeError('BAD_THRESHOLD', 'Threshold must be a positive price.');
        }

        const resolves = parseWhen(resolvesAt, 'resolution time');
        const closes = closesAt ? parseWhen(closesAt, 'close time') : resolves;
        if (resolves.getTime() <= now.getTime()) {
            throw new ExchangeError('BAD_TIME', 'The resolution time must be in the future.');
        }
        if (closes.getTime() > resolves.getTime()) {
            throw new ExchangeError('BAD_TIME', 'Trading must close no later than the resolution time.');
        }
        const horizonDays = (resolves.getTime() - now.getTime()) / 86_400_000;
        if (horizonDays > MAX_HORIZON_DAYS) {
            throw new ExchangeError('BAD_TIME', `Markets can resolve at most ${MAX_HORIZON_DAYS} days out.`);
        }
        const cap = Math.max(1, Math.floor(Number(positionCap) || 500));

        const text = question || `Will ${normalizedSymbol} be ${direction.toLowerCase()} $${level} at ${toSqlTime(resolves)} UTC?`;
        const id = await db.insert(
            `INSERT INTO prediction_markets (
                 guildId, question, symbol, comparator, threshold, closesAt, resolvesAt, positionCap, createdBy
             ) VALUES (
                 @guildId, @question, @symbol, @comparator, @threshold, @closesAt, @resolvesAt, @cap, @createdBy
             )`,
            {
                guildId, question: text.slice(0, 300), symbol: normalizedSymbol, comparator: direction,
                threshold: level, closesAt: toSqlTime(closes), resolvesAt: toSqlTime(resolves),
                cap, createdBy
            }
        );

        await exchangeEvents.record({
            guildId, userId: createdBy, eventType: 'market-create', symbol: normalizedSymbol,
            detail: { id, comparator: direction, threshold: level, resolvesAt: toSqlTime(resolves) }
        });
        return await this.getMarket({ guildId, id });
    }

    async getMarket({ guildId, id }) {
        return await db.get(
            'SELECT * FROM prediction_markets WHERE id = @id AND guildId = @guildId',
            { guildId, id }
        ) || null;
    }

    /** Markets in a guild (open ones by default). */
    async listMarkets({ guildId, status = 'OPEN', limit = 25 }) {
        const filter = status === 'all' ? '' : 'AND status = @status';
        return await db.all(
            `SELECT * FROM prediction_markets WHERE guildId = @guildId ${filter}
             ORDER BY resolvesAt LIMIT @limit`,
            { guildId, status, limit }
        );
    }

    /** A user's contracts (open ones by default), joined to their markets. */
    async listPositions({ guildId, userId, status = 'OPEN', limit = 50 }) {
        const filter = status === 'all' ? '' : 'AND p.status = @status';
        return await db.all(
            `SELECT p.*, m.question, m.symbol, m.comparator, m.threshold, m.resolvesAt,
                    m.status AS marketStatus, m.outcome, m.settlePrice
             FROM prediction_positions p JOIN prediction_markets m ON m.id = p.marketId
             WHERE p.guildId = @guildId AND p.userId = @userId ${filter}
             ORDER BY p.id DESC LIMIT @limit`,
            { guildId, userId, status, limit }
        );
    }

    /**
     * Price a market: the risk-neutral probability of the event, converted to
     * a YES/NO price in points, plus the house edge on each side.
     */
    async quote({ market, now = new Date() }) {
        const quote = await stockService.getQuote(market.symbol);
        const resolves = new Date(`${market.resolvesAt}Z`);
        const timeYears = Math.max(
            1 / (365 * 24 * 60),
            (resolves.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000)
        );
        const { vol } = await optionsMarket.getVolatility(market.symbol, { now });
        const smiled = optionsMarket.smiledVol({
            baseVol: vol, spot: quote.price, strike: market.threshold, timeYears
        });
        const rate = riskFreeRate(await exchangeConfig.get(market.guildId));

        // "Above the threshold at resolution" is exactly a call finishing in
        // the money, which Black-Scholes gives as N(d2).
        const probability = optionsMath.probabilityItm({
            spot: quote.price,
            strike: market.threshold,
            timeYears,
            vol: smiled,
            rate,
            optionType: market.comparator === 'ABOVE' ? 'CALL' : 'PUT'
        });

        const fairYes = probability * PAYOUT;
        return {
            spot: quote.price,
            asOf: quote.asOf,
            stale: !!quote.stale,
            iv: Number(smiled.toFixed(4)),
            probability: Number(probability.toFixed(4)),
            yesPrice: clampPrice(Math.round(fairYes) + HOUSE_EDGE),
            noPrice: clampPrice(Math.round(PAYOUT - fairYes) + HOUSE_EDGE),
            payout: PAYOUT,
            daysToResolve: Number((timeYears * 365).toFixed(3)),
            simulated: true
        };
    }

    /**
     * Buy contracts on one side of a market. Contracts cost their price in
     * points and pay 100 if the side is right, nothing if it is wrong.
     */
    async buy({ guildId, userId, marketId, side, contracts, now = new Date() }) {
        await exchangeConfig.requireFeature(guildId, 'predictionsEnabled', 'Event contracts');
        const market = await this.getMarket({ guildId, id: marketId });
        if (!market) throw new ExchangeError('NO_MARKET', `No market #${marketId} in this server.`);
        if (market.status !== 'OPEN') {
            throw new ExchangeError('MARKET_CLOSED', `That market is ${market.status.toLowerCase()}.`);
        }
        if (new Date(`${market.closesAt}Z`).getTime() <= now.getTime()) {
            throw new ExchangeError('MARKET_CLOSED', 'Trading on that market has closed.');
        }

        const position = String(side || '').toUpperCase();
        if (position !== 'YES' && position !== 'NO') {
            throw new ExchangeError('BAD_SIDE', 'Side must be YES or NO.');
        }
        const count = Number(contracts);
        if (!Number.isInteger(count) || count <= 0 || count > MAX_CONTRACTS) {
            throw new ExchangeError('BAD_CONTRACTS', `Contracts must be a whole number between 1 and ${MAX_CONTRACTS.toLocaleString()}.`);
        }

        const pricing = await this.quote({ market, now });
        const price = position === 'YES' ? pricing.yesPrice : pricing.noPrice;
        const cost = price * count;

        const existing = await db.get(
            `SELECT * FROM prediction_positions
             WHERE marketId = @marketId AND userId = @userId AND side = @side AND status = 'OPEN'`,
            { marketId: market.id, userId, side: position }
        );
        const held = existing ? existing.contracts : 0;
        if (held + count > market.positionCap) {
            throw new ExchangeError('POSITION_CAP',
                `This market caps each trader at ${market.positionCap.toLocaleString()} contracts per side; you hold ${held.toLocaleString()}.`);
        }

        return await db.transaction(async () => {
            const balance = await economyService.adjust({
                guildId, userId, amount: -cost,
                type: 'prediction-buy',
                detail: JSON.stringify({ marketId: market.id, side: position, contracts: count, price })
            });

            if (existing) {
                const total = existing.contracts + count;
                const avgPrice = (existing.avgPrice * existing.contracts + price * count) / total;
                await db.run(
                    `UPDATE prediction_positions SET contracts = @total, avgPrice = @avgPrice,
                         cost = cost + @cost, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
                    { id: existing.id, total, avgPrice, cost }
                );
            } else {
                await db.run(
                    `INSERT INTO prediction_positions (marketId, guildId, userId, side, contracts, avgPrice, cost)
                     VALUES (@marketId, @guildId, @userId, @side, @contracts, @price, @cost)`,
                    { marketId: market.id, guildId, userId, side: position, contracts: count, price, cost }
                );
            }

            await exchangeEvents.record({
                guildId, userId, eventType: 'prediction-buy', symbol: market.symbol, amount: -cost,
                detail: { marketId: market.id, side: position, contracts: count, price }
            });

            return {
                market, side: position, contracts: count, price, cost, balance,
                pricing,
                maxPayout: count * PAYOUT,
                position: await db.get(
                    `SELECT * FROM prediction_positions WHERE marketId = @marketId AND userId = @userId AND side = @side AND status = 'OPEN'`,
                    { marketId: market.id, userId, side: position }
                )
            };
        });
    }

    /**
     * Settle one market against the underlying's price at resolution.
     * @returns {Promise<{outcome, settlePrice, paid, winners}>}
     */
    async settleMarket({ market, now = new Date() }) {
        let settlePrice;
        try {
            settlePrice = (await stockService.getQuote(market.symbol)).price;
        } catch {
            // No price: leave it for the next tick rather than guessing an
            // outcome real points depend on.
            return { outcome: null, settlePrice: null, paid: 0, winners: 0, deferred: true };
        }

        const outcome = market.comparator === 'ABOVE'
            ? (settlePrice > market.threshold ? 'YES' : 'NO')
            : (settlePrice < market.threshold ? 'YES' : 'NO');

        const positions = await db.all(
            "SELECT * FROM prediction_positions WHERE marketId = @marketId AND status = 'OPEN'",
            { marketId: market.id }
        );

        let paid = 0;
        let winners = 0;
        await db.transaction(async () => {
            for (const position of positions) {
                const payout = position.side === outcome ? position.contracts * PAYOUT : 0;
                if (payout > 0) {
                    await economyService.adjust({
                        guildId: position.guildId, userId: position.userId, amount: payout,
                        type: 'prediction-settle',
                        detail: JSON.stringify({ marketId: market.id, side: position.side, contracts: position.contracts, outcome })
                    });
                    paid += payout;
                    winners++;
                }
                await db.run(
                    `UPDATE prediction_positions SET status = 'SETTLED', payout = @payout,
                         settledAt = @stamp, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
                    { id: position.id, payout, stamp: toSqlTime(now) }
                );
                await exchangeEvents.record({
                    guildId: position.guildId, userId: position.userId, eventType: 'prediction-settle',
                    symbol: market.symbol, amount: payout - position.cost,
                    detail: { marketId: market.id, side: position.side, contracts: position.contracts, outcome, payout }
                });
            }
            await db.run(
                `UPDATE prediction_markets SET status = 'SETTLED', outcome = @outcome, settlePrice = @settlePrice,
                     settledAt = @stamp, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
                { id: market.id, outcome, settlePrice, stamp: toSqlTime(now) }
            );
            await exchangeEvents.record({
                guildId: market.guildId, eventType: 'market-settle', symbol: market.symbol, amount: paid,
                detail: { marketId: market.id, outcome, settlePrice, winners, positions: positions.length }
            });
        });

        return { outcome, settlePrice, paid, winners, positions: positions.length };
    }

    /**
     * Close markets whose trading window ended and settle the ones that have
     * reached their resolution time (the risk engine's settlement pass).
     */
    async settleDue({ guildId = null, now = new Date() } = {}) {
        const filter = guildId ? 'AND guildId = @guildId' : '';
        const stamp = toSqlTime(now);

        await db.run(
            `UPDATE prediction_markets SET status = 'CLOSED', updatedAt = CURRENT_TIMESTAMP
             WHERE status = 'OPEN' AND closesAt <= @stamp ${filter}`,
            { guildId, stamp }
        );

        const due = await db.all(
            `SELECT * FROM prediction_markets
             WHERE status IN ('OPEN', 'CLOSED') AND resolvesAt <= @stamp ${filter}
             ORDER BY resolvesAt LIMIT 100`,
            { guildId, stamp }
        );

        const settled = [];
        for (const market of due) {
            try {
                const result = await this.settleMarket({ market, now });
                if (!result.deferred) settled.push({ market, ...result });
            } catch (error) {
                console.warn(`[Exchange] Failed to settle market ${market.id}:`, error.message);
            }
        }
        return settled;
    }

    /** Void a market and refund every open contract at cost (admin escape hatch). */
    async voidMarket({ guildId, id, reason = null, now = new Date() }) {
        const market = await this.getMarket({ guildId, id });
        if (!market) throw new ExchangeError('NO_MARKET', `No market #${id} in this server.`);
        if (market.status === 'SETTLED' || market.status === 'VOID') {
            throw new ExchangeError('MARKET_CLOSED', `That market is already ${market.status.toLowerCase()}.`);
        }

        const positions = await db.all(
            "SELECT * FROM prediction_positions WHERE marketId = @marketId AND status = 'OPEN'",
            { marketId: market.id }
        );
        return await db.transaction(async () => {
            let refunded = 0;
            for (const position of positions) {
                await economyService.adjust({
                    guildId: position.guildId, userId: position.userId, amount: position.cost,
                    type: 'prediction-refund',
                    detail: JSON.stringify({ marketId: market.id, side: position.side, reason })
                });
                refunded += position.cost;
                await db.run(
                    `UPDATE prediction_positions SET status = 'SETTLED', payout = @payout, settledAt = @stamp,
                         updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
                    { id: position.id, payout: position.cost, stamp: toSqlTime(now) }
                );
            }
            await db.run(
                `UPDATE prediction_markets SET status = 'VOID', settledAt = @stamp, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: market.id, stamp: toSqlTime(now) }
            );
            await exchangeEvents.record({
                guildId, eventType: 'market-void', symbol: market.symbol, amount: refunded,
                detail: { marketId: market.id, reason, positions: positions.length }
            });
            return { market: await this.getMarket({ guildId, id }), refunded, positions: positions.length };
        });
    }
}

function clampPrice(value) {
    return Math.min(MAX_PRICE, Math.max(MIN_PRICE, value));
}

/** Accept an ISO-ish timestamp or a SQLite UTC string. */
function parseWhen(value, label) {
    if (value instanceof Date) return value;
    const text = String(value || '').trim();
    const iso = text.includes('T') || text.endsWith('Z') ? text : `${text.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        throw new ExchangeError('BAD_TIME', `Could not read the ${label} "${value}" - use YYYY-MM-DD HH:MM (UTC).`);
    }
    return date;
}

module.exports = new PredictionService();
module.exports.PAYOUT = PAYOUT;
module.exports.HOUSE_EDGE = HOUSE_EDGE;
