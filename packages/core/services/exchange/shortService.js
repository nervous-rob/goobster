const db = require('../../db');
const economyService = require('../economyService');
const stockService = require('../stockService');
const { StockError } = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const accountService = require('./accountService');
const { toSqlTime } = require('./accountService');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

const UNIT_PRECISION = 4;
const MAX_UNITS = 1_000_000;

/**
 * Short selling: borrow units you do not own, sell them for points now, and
 * buy them back later - hopefully cheaper.
 *
 * A short is a *liability*: the proceeds land in the wallet immediately, but
 * the units owed are marked to market on every risk snapshot, and the position
 * rents its borrow at the guild's annual rate until it is covered. Shorts
 * require a margin account, because an unbounded loss needs collateral.
 */
class ShortService {
    _normalizeUnits(units) {
        const value = Number(units);
        if (!Number.isFinite(value) || value <= 0 || value > MAX_UNITS) {
            throw new ExchangeError('BAD_UNITS', `Units must be a positive number up to ${MAX_UNITS.toLocaleString()}.`);
        }
        return Math.round(value * 10 ** UNIT_PRECISION) / 10 ** UNIT_PRECISION;
    }

    async _getTradableQuote(symbol) {
        const quote = await stockService.getQuote(symbol);
        if (quote.currency && quote.currency !== 'USD') {
            throw new StockError('NOT_USD', `${quote.symbol} trades in ${quote.currency}; only USD-listed symbols can be traded (1 point = $1).`);
        }
        return quote;
    }

    /** A single short position, or null. */
    getPosition({ guildId, userId, symbol }) {
        return db.get(
            `SELECT symbol, units, proceeds, avgPrice, borrowFeeAccrued, lastFeeAt, openedAt
             FROM short_positions WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol`,
            { guildId, userId, symbol }
        ) || null;
    }

    /** Every short a user holds in a guild. */
    listPositions({ guildId, userId }) {
        return db.all(
            `SELECT symbol, units, proceeds, avgPrice, borrowFeeAccrued, openedAt
             FROM short_positions WHERE guildId = @guildId AND userId = @userId ORDER BY symbol`,
            { guildId, userId }
        );
    }

    /**
     * Open or add to a short position. Proceeds are credited immediately
     * (rounded down, as every sale in this game is), and the resulting
     * exposure must still fit inside the account's buying power.
     */
    async openShort({ guildId, userId, symbol, units, now = new Date() }) {
        exchangeConfig.requireFeature(guildId, 'marginEnabled', 'Short selling and margin');
        const account = accountService.getAccount(guildId, userId);
        if (account.accountType !== 'MARGIN') {
            throw new ExchangeError('CASH_ACCOUNT', 'Short selling needs a margin account (`/margin account type:margin`).');
        }

        const amount = this._normalizeUnits(units);
        const quote = await this._getTradableQuote(symbol);
        // You cannot short a stock you are long: that is just selling it.
        const longHolding = db.get(
            'SELECT units FROM stock_holdings WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol',
            { guildId, userId, symbol: quote.symbol }
        );
        if (longHolding) {
            throw new ExchangeError('LONG_HELD', `You are long ${quote.symbol}; sell that position before shorting it.`);
        }

        const notional = amount * quote.price;
        const proceeds = Math.floor(notional);
        if (proceeds <= 0) {
            throw new ExchangeError('BAD_UNITS', 'That short is worth less than one point - short more units.');
        }

        const snapshot = await accountService.getSnapshot({ guildId, userId, now });
        if (snapshot.buyingPower < notional) {
            throw new ExchangeError('INSUFFICIENT_BUYING_POWER',
                `Shorting ${amount} ${quote.symbol} needs ${Math.ceil(notional).toLocaleString()} points of buying power; you have ${Math.floor(snapshot.buyingPower).toLocaleString()} at ${snapshot.account.leverage}x.`);
        }

        return db.transaction(() => {
            const existing = this.getPosition({ guildId, userId, symbol: quote.symbol });
            const balance = economyService.adjust({
                guildId, userId, amount: proceeds,
                type: 'stock-short-open',
                detail: JSON.stringify({ symbol: quote.symbol, units: amount, price: quote.price })
            });

            if (existing) {
                const totalUnits = round(existing.units + amount, UNIT_PRECISION);
                const avgPrice = (existing.avgPrice * existing.units + quote.price * amount) / totalUnits;
                db.run(
                    `UPDATE short_positions SET units = @totalUnits, proceeds = proceeds + @proceeds,
                         avgPrice = @avgPrice, updatedAt = CURRENT_TIMESTAMP
                     WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol`,
                    { guildId, userId, symbol: quote.symbol, totalUnits, proceeds, avgPrice }
                );
            } else {
                db.run(
                    `INSERT INTO short_positions (guildId, userId, symbol, units, proceeds, avgPrice, lastFeeAt)
                     VALUES (@guildId, @userId, @symbol, @units, @proceeds, @price, @stamp)`,
                    { guildId, userId, symbol: quote.symbol, units: amount, proceeds, price: quote.price, stamp: toSqlTime(now) }
                );
            }

            db.run(
                `INSERT INTO stock_trades (guildId, userId, symbol, side, units, price, points)
                 VALUES (@guildId, @userId, @symbol, 'SELL', @units, @price, @proceeds)`,
                { guildId, userId, symbol: quote.symbol, units: amount, price: quote.price, proceeds }
            );
            exchangeEvents.record({
                guildId, userId, eventType: 'short-open', symbol: quote.symbol, amount: proceeds,
                detail: { units: amount, price: quote.price }
            });

            const position = this.getPosition({ guildId, userId, symbol: quote.symbol });
            return {
                symbol: quote.symbol, name: quote.name, units: amount, price: quote.price,
                proceeds, balance, position,
                liquidationPrice: this._liquidationPrice(snapshot, quote.symbol)
            };
        });
    }

    /**
     * Buy back borrowed units (all of them by default), paying any accrued
     * borrow fee. A margin account may borrow to cover - being unable to
     * afford the buy-back is exactly how a short goes wrong.
     */
    async cover({ guildId, userId, symbol, units = null, now = new Date() }) {
        const normalized = stockService.normalizeSymbol(symbol);
        const position = this.getPosition({ guildId, userId, symbol: normalized });
        if (!position) {
            throw new ExchangeError('NO_SHORT', `You have no short position in ${normalized}.`);
        }
        const amount = units === null ? position.units : this._normalizeUnits(units);
        if (amount > position.units + 1e-9) {
            throw new ExchangeError('NO_SHORT', `You are only short ${position.units} units of ${normalized}.`);
        }

        const quote = await this._getTradableQuote(normalized);
        const fraction = amount / position.units;
        const cost = Math.ceil(amount * quote.price);
        const feeShare = Math.ceil(position.borrowFeeAccrued * fraction);
        const total = cost + feeShare;

        await accountService.ensureFunds({ guildId, userId, cost: total, reason: `cover ${normalized}`, now });

        return db.transaction(() => {
            const openProceeds = Math.round(position.proceeds * fraction);
            const balance = economyService.adjust({
                guildId, userId, amount: -total,
                type: 'stock-short-cover',
                detail: JSON.stringify({ symbol: normalized, units: amount, price: quote.price, borrowFee: feeShare })
            });

            const remaining = round(position.units - amount, UNIT_PRECISION);
            if (remaining > 0) {
                db.run(
                    `UPDATE short_positions SET units = @remaining,
                         proceeds = MAX(0, proceeds - @openProceeds),
                         borrowFeeAccrued = MAX(0, borrowFeeAccrued - @feeShare),
                         updatedAt = CURRENT_TIMESTAMP
                     WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol`,
                    { guildId, userId, symbol: normalized, remaining, openProceeds, feeShare }
                );
            } else {
                db.run(
                    'DELETE FROM short_positions WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol',
                    { guildId, userId, symbol: normalized }
                );
            }

            db.run(
                `INSERT INTO stock_trades (guildId, userId, symbol, side, units, price, points)
                 VALUES (@guildId, @userId, @symbol, 'BUY', @units, @price, @cost)`,
                { guildId, userId, symbol: normalized, units: amount, price: quote.price, cost }
            );

            const realized = openProceeds - total;
            exchangeEvents.record({
                guildId, userId, eventType: 'short-cover', symbol: normalized, amount: realized,
                detail: { units: amount, price: quote.price, borrowFee: feeShare, cost }
            });

            return {
                symbol: normalized, name: quote.name, units: amount, price: quote.price,
                cost, borrowFee: feeShare, realized, balance,
                position: this.getPosition({ guildId, userId, symbol: normalized })
            };
        });
    }

    /**
     * Accrue the borrow fee on every short a user holds. Like interest, the
     * fee is a liability that rides on the position and is settled on cover -
     * a trader with an empty wallet still owes the rent.
     * @returns {{accrued: number}} points of fee added
     */
    accrueBorrowFees({ guildId, userId, now = new Date() }) {
        const { borrowFeeRate } = exchangeConfig.get(guildId);
        if (borrowFeeRate <= 0) return { accrued: 0 };

        const positions = db.all(
            `SELECT symbol, units, avgPrice, borrowFeeAccrued, lastFeeAt
             FROM short_positions WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
        let accrued = 0;
        for (const position of positions) {
            const last = position.lastFeeAt ? new Date(`${position.lastFeeAt}Z`) : now;
            const years = Math.max(0, now.getTime() - last.getTime()) / (365 * 24 * 60 * 60 * 1000);
            // Rent is charged on the value borrowed at the opening price - the
            // mark-to-market swing is the trader's P/L, not the lender's rent.
            const fee = position.units * position.avgPrice * borrowFeeRate * years;
            accrued += fee;
            db.run(
                `UPDATE short_positions SET borrowFeeAccrued = borrowFeeAccrued + @fee,
                     lastFeeAt = @stamp, updatedAt = CURRENT_TIMESTAMP
                 WHERE guildId = @guildId AND userId = @userId AND symbol = @symbol`,
                { guildId, userId, symbol: position.symbol, fee, stamp: toSqlTime(now) }
            );
        }
        if (accrued >= 1) {
            exchangeEvents.record({
                guildId, userId, eventType: 'borrow-fee', amount: Math.round(accrued),
                detail: { rate: borrowFeeRate, positions: positions.length }
            });
        }
        return { accrued };
    }

    /** The short's liquidation price out of a snapshot, when one exists. */
    _liquidationPrice(snapshot, symbol) {
        const level = snapshot.liquidationLevels.find(entry => entry.symbol === symbol && entry.direction === 'SHORT');
        return level ? level.price : null;
    }
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

module.exports = new ShortService();
