const db = require('../db');
const economyService = require('./economyService');
const { EconomyError } = require('./economyService');
const stockService = require('./stockService');
const { StockError } = require('./stockService');

// Units support fractional shares to 4 decimal places
const UNIT_PRECISION = 4;
const MAX_UNITS = 1_000_000;

/**
 * The stock trading game: users spend guild points to buy stock units at the
 * live price (1 point = $1), the buy price is remembered per trade, and they
 * can check in on their positions later (which refreshes the current price).
 *
 * Point conversion is conservative for the house: buys round the cost up to a
 * whole point, sells round the proceeds down.
 */
class StockPortfolioService {
    /**
     * Validate a unit amount (positive, <= MAX_UNITS, 4dp).
     * @throws {EconomyError} BAD_UNITS
     */
    _normalizeUnits(units) {
        const value = Number(units);
        if (!Number.isFinite(value) || value <= 0 || value > MAX_UNITS) {
            throw new EconomyError('BAD_UNITS', `Units must be a positive number up to ${MAX_UNITS.toLocaleString()}.`);
        }
        return Math.round(value * 10 ** UNIT_PRECISION) / 10 ** UNIT_PRECISION;
    }

    /**
     * Quote a symbol and require it to be USD-priced (the game pegs
     * 1 point = $1, so non-USD listings would need FX conversion).
     */
    async _getTradableQuote(symbol) {
        const quote = await stockService.getQuote(symbol);
        if (quote.currency && quote.currency !== 'USD') {
            throw new StockError('NOT_USD', `${quote.symbol} trades in ${quote.currency}; only USD-listed symbols can be traded (1 point = $1).`);
        }
        return quote;
    }

    /**
     * Buy units of a stock with points at the current price.
     * @param {Object} params - { guildId, userId, symbol, units }
     * @returns {Promise<{symbol, name, units, price, cost, balance, holding}>}
     */
    async buy({ guildId, userId, symbol, units }) {
        const amount = this._normalizeUnits(units);
        const quote = await this._getTradableQuote(symbol);
        const cost = Math.ceil(amount * quote.price);
        if (cost <= 0) {
            throw new EconomyError('BAD_UNITS', 'That order is worth less than one point - buy more units.');
        }

        return db.transaction(() => {
            const balance = economyService.adjust({
                guildId, userId, amount: -cost,
                type: 'stock-buy', detail: JSON.stringify({ symbol: quote.symbol, units: amount, price: quote.price })
            });
            db.run(
                `INSERT INTO stock_holdings (guildId, userId, symbol, units, costBasis)
                 VALUES (@guildId, @userId, @symbol, @units, @cost)
                 ON CONFLICT(guildId, userId, symbol) DO UPDATE SET
                     units = units + @units,
                     costBasis = costBasis + @cost,
                     updatedAt = CURRENT_TIMESTAMP`,
                { guildId, userId, symbol: quote.symbol, units: amount, cost }
            );
            db.run(
                `INSERT INTO stock_trades (guildId, userId, symbol, side, units, price, points)
                 VALUES (@guildId, @userId, @symbol, 'BUY', @units, @price, @cost)`,
                { guildId, userId, symbol: quote.symbol, units: amount, price: quote.price, cost }
            );
            const holding = this.getHolding({ guildId, userId, symbol: quote.symbol });
            return { symbol: quote.symbol, name: quote.name, units: amount, price: quote.price, cost, balance, holding };
        });
    }

    /**
     * Sell units of a held stock for points at the current price.
     * @param {Object} params - { guildId, userId, symbol, units?: number|null } (null = sell all)
     * @returns {Promise<{symbol, name, units, price, proceeds, balance, holding}>}
     */
    async sell({ guildId, userId, symbol, units = null }) {
        const normalized = stockService.normalizeSymbol(symbol);
        const holding = this.getHolding({ guildId, userId, symbol: normalized });
        if (!holding) {
            throw new EconomyError('NO_HOLDING', `You don't hold any ${normalized}.`);
        }

        const amount = units === null ? holding.units : this._normalizeUnits(units);
        if (amount > holding.units + 1e-9) {
            throw new EconomyError('NO_HOLDING', `You only hold ${holding.units} units of ${normalized}.`);
        }

        const quote = await this._getTradableQuote(normalized);
        const proceeds = Math.floor(amount * quote.price);

        return db.transaction(() => {
            const remaining = Math.round((holding.units - amount) * 10 ** UNIT_PRECISION) / 10 ** UNIT_PRECISION;
            if (remaining > 0) {
                // Reduce the cost basis proportionally to the units sold
                const soldBasis = Math.round(holding.costBasis * (amount / holding.units));
                db.run(
                    `UPDATE stock_holdings SET units = @remaining, costBasis = @newBasis, updatedAt = CURRENT_TIMESTAMP
                     WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol`,
                    { guildId, userId, symbol: quote.symbol, remaining, newBasis: Math.max(0, holding.costBasis - soldBasis) }
                );
            } else {
                db.run(
                    'DELETE FROM stock_holdings WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol',
                    { guildId, userId, symbol: quote.symbol }
                );
            }
            const balance = economyService.adjust({
                guildId, userId, amount: proceeds,
                type: 'stock-sell', detail: JSON.stringify({ symbol: quote.symbol, units: amount, price: quote.price })
            });
            db.run(
                `INSERT INTO stock_trades (guildId, userId, symbol, side, units, price, points)
                 VALUES (@guildId, @userId, @symbol, 'SELL', @units, @price, @proceeds)`,
                { guildId, userId, symbol: quote.symbol, units: amount, price: quote.price, proceeds }
            );
            return {
                symbol: quote.symbol, name: quote.name, units: amount, price: quote.price,
                proceeds, balance, holding: this.getHolding({ guildId, userId, symbol: quote.symbol })
            };
        });
    }

    /**
     * A single holding row, or null.
     * @returns {{symbol, units, costBasis}|null}
     */
    getHolding({ guildId, userId, symbol }) {
        return db.get(
            `SELECT symbol, units, costBasis FROM stock_holdings
             WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol`,
            { guildId, userId, symbol }
        ) || null;
    }

    /**
     * Check in on all positions: refreshes each symbol's price (short-TTL
     * cache keeps this cheap) and computes value and profit/loss vs. what was
     * paid.
     * @returns {Promise<{positions: Array, totalValue: number, totalCost: number, totalPL: number}>}
     */
    async getPortfolio({ guildId, userId }) {
        const holdings = db.all(
            `SELECT symbol, units, costBasis FROM stock_holdings
             WHERE guildId = @guildId AND userId = @userId ORDER BY symbol`,
            { guildId, userId }
        );

        const positions = [];
        let totalValue = 0;
        let totalCost = 0;
        for (const holding of holdings) {
            let quote = null;
            try {
                quote = await stockService.getQuote(holding.symbol);
            } catch {
                // Price source down and no snapshot: report the position without a value
            }
            const value = quote ? holding.units * quote.price : null;
            positions.push({
                symbol: holding.symbol,
                name: quote?.name || holding.symbol,
                units: holding.units,
                costBasis: holding.costBasis,
                price: quote?.price ?? null,
                asOf: quote?.asOf ?? null,
                stale: quote?.stale ?? true,
                value,
                profitLoss: value === null ? null : value - holding.costBasis
            });
            totalCost += holding.costBasis;
            if (value !== null) totalValue += value;
        }
        return { positions, totalValue, totalCost, totalPL: totalValue - totalCost };
    }

    /**
     * Recent trades (newest first) - the "when you bought and at what price"
     * record.
     */
    getTrades({ guildId, userId, limit = 10 }) {
        return db.all(
            `SELECT symbol, side, units, price, points, createdAt FROM stock_trades
             WHERE guildId = @guildId AND userId = @userId
             ORDER BY id DESC LIMIT @limit`,
            { guildId, userId, limit }
        );
    }
}

module.exports = new StockPortfolioService();
