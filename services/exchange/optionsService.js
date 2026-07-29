const db = require('../../db');
const economyService = require('../economyService');
const stockService = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const optionsMath = require('./optionsMath');
const accountService = require('./accountService');
const { toSqlTime } = require('./accountService');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

const MAX_CONTRACTS = 10_000;

/**
 * The options wing: long calls and puts, including same-day (0DTE) index
 * contracts.
 *
 * Deliberately long-only in v1. Buying a contract has a known maximum loss -
 * the premium - which keeps the game's accounting finite. Selling uncovered
 * contracts has unbounded loss and would need a whole assignment/margin
 * apparatus before it could be safe, so it is not offered.
 *
 * Premiums are paid in cash. A long option is not marginable collateral, so
 * it can never be bought with borrowed points: the most a trader can lose on
 * a contract is money they actually had.
 *
 * Contracts are cash-settled at expiry against the underlying's price at the
 * settlement instant: in the money pays the intrinsic value, out of the money
 * pays exactly nothing.
 */
class OptionsService {
    /** Positions (open by default) for one trader. */
    listPositions({ guildId, userId, status = 'OPEN', limit = 50 }) {
        const filter = status ? 'AND status = @status' : '';
        return db.all(
            `SELECT * FROM option_positions
             WHERE guildId = @guildId AND userId = @userId ${filter}
             ORDER BY expiry, underlying, strike LIMIT @limit`,
            { guildId, userId, status, limit }
        );
    }

    getPosition({ guildId, userId, id }) {
        return db.get(
            'SELECT * FROM option_positions WHERE id = @id AND guildId = @guildId AND userId = @userId',
            { guildId, userId, id }
        ) || null;
    }

    /** Recent option fills, newest first. */
    listTrades({ guildId, userId, limit = 10 }) {
        return db.all(
            `SELECT * FROM option_trades WHERE guildId = @guildId AND userId = @userId
             ORDER BY id DESC LIMIT @limit`,
            { guildId, userId, limit }
        );
    }

    /**
     * Validate that this trader may touch this expiry. Same-day contracts need
     * the guild to allow them AND the trader to have opted into goblin mode -
     * the most likely value of a 0DTE contract at the bell is zero, so nobody
     * arrives here by accident.
     */
    _assertTradable({ guildId, userId, expiry, now }) {
        exchangeConfig.requireFeature(guildId, 'optionsEnabled', 'Options');
        if (optionsMarket.hasExpired(expiry, now)) {
            throw new ExchangeError('EXPIRED', `${expiry} has already settled - pick a later expiry.`);
        }
        if (!optionsMarket.isZeroDte(expiry, now)) return;

        exchangeConfig.requireFeature(guildId, 'zeroDteEnabled', 'Same-day (0DTE) contracts');
        const account = accountService.getAccount(guildId, userId);
        if (!account.goblinMode) {
            throw new ExchangeError('GOBLIN_MODE_REQUIRED',
                'Same-day contracts are behind Goblin Mode. Turn it on with `/margin goblin enabled:true` first - it is an explicit acknowledgement that the most likely value of this contract at the bell is zero.');
        }
    }

    /**
     * Buy to open (or add to) a long contract.
     * @param {Object} params - { guildId, userId, symbol, optionType, strike, expiry, contracts }
     * @returns {Promise<Object>} fill details, the resulting position, and the risk picture
     */
    async buyToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts, now = new Date() }) {
        const count = normalizeContracts(contracts);
        this._assertTradable({ guildId, userId, expiry, now });

        const contract = await optionsMarket.quoteContract({
            symbol, optionType, strike, expiry, guildId, now
        });
        const cost = contract.costPerContract * count;
        if (cost <= 0) {
            throw new ExchangeError('BAD_ORDER', 'That order costs less than one point - buy more contracts.');
        }

        const balance = economyService.getBalance(guildId, userId);
        if (balance < cost) {
            const { currencyName } = economyService.getSettings(guildId);
            throw new ExchangeError('INSUFFICIENT_FUNDS',
                `Contracts are paid in cash (never borrowed): you have ${balance.toLocaleString()} ${currencyName}, that order needs ${cost.toLocaleString()}.`);
        }

        return db.transaction(() => {
            const newBalance = economyService.adjust({
                guildId, userId, amount: -cost,
                type: 'option-buy',
                detail: JSON.stringify({
                    underlying: contract.underlying, optionType: contract.optionType,
                    strike: contract.strike, expiry, contracts: count, premium: contract.ask
                })
            });

            const existing = db.get(
                `SELECT * FROM option_positions
                 WHERE guildId = @guildId AND userId = @userId AND underlying = @underlying
                   AND optionType = @optionType AND strike = @strike AND expiry = @expiry AND status = 'OPEN'`,
                {
                    guildId, userId, underlying: contract.underlying,
                    optionType: contract.optionType, strike: contract.strike, expiry
                }
            );

            let positionId;
            if (existing) {
                const totalContracts = existing.contracts + count;
                const avgPremium = (existing.openPremium * existing.contracts + contract.ask * count) / totalContracts;
                db.run(
                    `UPDATE option_positions SET contracts = @totalContracts, openPremium = @avgPremium,
                         costBasis = costBasis + @cost, openIv = @iv, updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: existing.id, totalContracts, avgPremium, cost, iv: contract.iv }
                );
                positionId = existing.id;
            } else {
                positionId = db.run(
                    `INSERT INTO option_positions (
                         guildId, userId, underlying, optionType, strike, expiry,
                         contracts, contractSize, openPremium, costBasis, openIv
                     ) VALUES (
                         @guildId, @userId, @underlying, @optionType, @strike, @expiry,
                         @contracts, @contractSize, @premium, @cost, @iv
                     )`,
                    {
                        guildId, userId, underlying: contract.underlying, optionType: contract.optionType,
                        strike: contract.strike, expiry, contracts: count,
                        contractSize: contract.contractSize, premium: contract.ask, cost, iv: contract.iv
                    }
                ).lastInsertRowid;
            }

            this._recordTrade({
                guildId, userId, positionId, contract, action: 'BUY_TO_OPEN', contracts: count,
                premium: contract.ask, points: cost
            });
            exchangeEvents.record({
                guildId, userId, eventType: 'option-open', symbol: contract.underlying, amount: -cost,
                detail: {
                    optionType: contract.optionType, strike: contract.strike, expiry,
                    contracts: count, premium: contract.ask, zeroDte: contract.zeroDte
                }
            });

            return {
                positionId,
                contract,
                contracts: count,
                cost,
                balance: newBalance,
                maxLoss: cost,
                breakEven: contract.breakEven,
                position: db.get('SELECT * FROM option_positions WHERE id = @id', { id: positionId })
            };
        });
    }

    /**
     * Sell to close some or all of an open position at the current bid.
     * @param {Object} params - { guildId, userId, positionId, contracts?: number|null }
     */
    async sellToClose({ guildId, userId, positionId, contracts = null, now = new Date() }) {
        const position = this.getPosition({ guildId, userId, id: positionId });
        if (!position || position.status !== 'OPEN') {
            throw new ExchangeError('NO_POSITION', 'You have no open contract with that id.');
        }
        if (optionsMarket.hasExpired(position.expiry, now)) {
            throw new ExchangeError('EXPIRED', 'That contract has already reached its settlement time; the exchange will settle it on the next tick.');
        }

        const count = contracts === null ? position.contracts : normalizeContracts(contracts);
        if (count > position.contracts) {
            throw new ExchangeError('NO_POSITION', `You only hold ${position.contracts} of those contracts.`);
        }

        const contract = await optionsMarket.quoteContract({
            symbol: position.underlying, optionType: position.optionType,
            strike: position.strike, expiry: position.expiry, guildId, now
        });
        const proceeds = contract.creditPerContract * count;
        const closedBasis = Math.round(position.costBasis * (count / position.contracts));

        return db.transaction(() => {
            const balance = economyService.adjust({
                guildId, userId, amount: proceeds,
                type: 'option-sell',
                detail: JSON.stringify({
                    underlying: position.underlying, optionType: position.optionType,
                    strike: position.strike, expiry: position.expiry, contracts: count, premium: contract.bid
                })
            });

            const remaining = position.contracts - count;
            if (remaining > 0) {
                db.run(
                    `UPDATE option_positions SET contracts = @remaining,
                         costBasis = MAX(0, costBasis - @closedBasis), updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: position.id, remaining, closedBasis }
                );
            } else {
                db.run(
                    `UPDATE option_positions SET status = 'CLOSED', closePremium = @premium,
                         proceeds = @proceeds, realizedPL = @realized, closedAt = CURRENT_TIMESTAMP,
                         updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: position.id, premium: contract.bid, proceeds, realized: proceeds - closedBasis }
                );
            }

            this._recordTrade({
                guildId, userId, positionId: position.id, contract, action: 'SELL_TO_CLOSE',
                contracts: count, premium: contract.bid, points: proceeds
            });
            exchangeEvents.record({
                guildId, userId, eventType: 'option-close', symbol: position.underlying, amount: proceeds - closedBasis,
                detail: {
                    optionType: position.optionType, strike: position.strike, expiry: position.expiry,
                    contracts: count, premium: contract.bid
                }
            });

            return {
                position: db.get('SELECT * FROM option_positions WHERE id = @id', { id: position.id }),
                contract,
                contracts: count,
                proceeds,
                realized: proceeds - closedBasis,
                balance
            };
        });
    }

    /**
     * Settle one expired position against the underlying's settlement price.
     * In the money pays intrinsic value; out of the money pays nothing, which
     * is the outcome the warning screens are about.
     * @returns {Promise<{status, payout, realized, settlePrice}>}
     */
    async settlePosition({ position, now = new Date() }) {
        let settlePrice = null;
        try {
            const quote = await stockService.getQuote(position.underlying);
            settlePrice = quote.price;
        } catch {
            // No settlement price: leave the position open so the next tick can
            // try again rather than expiring it worthless on a feed outage.
            return { status: 'DEFERRED', payout: 0, realized: 0, settlePrice: null };
        }

        const intrinsic = optionsMath.intrinsicValue({
            spot: settlePrice, strike: position.strike, optionType: position.optionType
        });
        const payout = Math.floor(intrinsic * position.contractSize * position.contracts);
        const status = payout > 0 ? 'EXERCISED' : 'EXPIRED';
        const realized = payout - position.costBasis;

        db.transaction(() => {
            if (payout > 0) {
                economyService.adjust({
                    guildId: position.guildId, userId: position.userId, amount: payout,
                    type: 'option-settle',
                    detail: JSON.stringify({
                        underlying: position.underlying, optionType: position.optionType,
                        strike: position.strike, expiry: position.expiry,
                        contracts: position.contracts, settlePrice
                    })
                });
            }
            db.run(
                `UPDATE option_positions SET status = @status, closePremium = @intrinsic, proceeds = @payout,
                     realizedPL = @realized, closedAt = @stamp, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: position.id, status, intrinsic, payout, realized, stamp: toSqlTime(now) }
            );
            db.run(
                `INSERT INTO option_trades (
                     guildId, userId, positionId, underlying, optionType, strike, expiry,
                     action, contracts, premium, underlyingPrice, points
                 ) VALUES (
                     @guildId, @userId, @positionId, @underlying, @optionType, @strike, @expiry,
                     @action, @contracts, @premium, @settlePrice, @payout
                 )`,
                {
                    guildId: position.guildId, userId: position.userId, positionId: position.id,
                    underlying: position.underlying, optionType: position.optionType,
                    strike: position.strike, expiry: position.expiry,
                    action: payout > 0 ? 'EXERCISE' : 'EXPIRE',
                    contracts: position.contracts, premium: intrinsic, settlePrice, payout
                }
            );
            exchangeEvents.record({
                guildId: position.guildId, userId: position.userId,
                eventType: payout > 0 ? 'option-exercise' : 'option-expire',
                symbol: position.underlying, amount: realized,
                detail: {
                    optionType: position.optionType, strike: position.strike, expiry: position.expiry,
                    contracts: position.contracts, settlePrice, payout
                }
            });
        });

        return { status, payout, realized, settlePrice };
    }

    /**
     * Settle every contract whose expiry has passed (the risk engine's
     * expiration and assignment pass).
     * @returns {Promise<Array>} one result per settled position
     */
    async settleExpired({ guildId = null, now = new Date() } = {}) {
        const filter = guildId ? 'AND guildId = @guildId' : '';
        const due = db.all(
            `SELECT * FROM option_positions WHERE status = 'OPEN' AND expiry <= @today ${filter}
             ORDER BY expiry LIMIT 500`,
            { guildId, today: optionsMarket.dateKey(now) }
        ).filter(position => optionsMarket.hasExpired(position.expiry, now));

        const settled = [];
        for (const position of due) {
            try {
                const result = await this.settlePosition({ position, now });
                if (result.status !== 'DEFERRED') settled.push({ position, ...result });
            } catch (error) {
                console.warn(`[Exchange] Failed to settle option ${position.id}:`, error.message);
            }
        }
        return settled;
    }

    _recordTrade({ guildId, userId, positionId, contract, action, contracts, premium, points }) {
        db.run(
            `INSERT INTO option_trades (
                 guildId, userId, positionId, underlying, optionType, strike, expiry,
                 action, contracts, premium, underlyingPrice, iv, points
             ) VALUES (
                 @guildId, @userId, @positionId, @underlying, @optionType, @strike, @expiry,
                 @action, @contracts, @premium, @spot, @iv, @points
             )`,
            {
                guildId, userId, positionId,
                underlying: contract.underlying, optionType: contract.optionType,
                strike: contract.strike, expiry: contract.expiry,
                action, contracts, premium, spot: contract.spot, iv: contract.iv, points
            }
        );
    }
}

function normalizeContracts(contracts) {
    const count = Number(contracts);
    if (!Number.isInteger(count) || count <= 0 || count > MAX_CONTRACTS) {
        throw new ExchangeError('BAD_CONTRACTS', `Contracts must be a whole number between 1 and ${MAX_CONTRACTS.toLocaleString()}.`);
    }
    return count;
}

module.exports = new OptionsService();
module.exports.MAX_CONTRACTS = MAX_CONTRACTS;
