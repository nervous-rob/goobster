const db = require('../../db');
const economyService = require('../economyService');
const stockService = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const optionsMath = require('./optionsMath');
const marginMath = require('./marginMath');
const accountService = require('./accountService');
const { toSqlTime } = require('./accountService');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

const MAX_CONTRACTS = 10_000;

/**
 * The options wing: long AND written (short) calls and puts, including
 * same-day (0DTE) index contracts.
 *
 * Long contracts are paid in cash - a long option is not marginable
 * collateral, so it can never be bought with borrowed points, and the most a
 * buyer can lose is the premium.
 *
 * Written contracts collect the premium up front and require a MARGIN
 * account: the writer owes the intrinsic value at settlement (assignment),
 * which is unbounded for a naked call. While open, a short contract consumes
 * a margin requirement (naked 20% rule; strike width when paired into a
 * spread; nothing when covered by shares), and the requirement is enforced
 * against buying power before the write fills.
 *
 * Contracts are cash-settled at expiry against the underlying's price at the
 * settlement instant: longs receive the intrinsic value, writers pay it -
 * borrowed onto their margin loan if the wallet cannot, which is exactly how
 * a naked write goes wrong.
 */
class OptionsService {
    /** Positions (open by default) for one trader. */
    async listPositions({ guildId, userId, status = 'OPEN', limit = 50 }) {
        const filter = status ? 'AND status = @status' : '';
        return await db.all(
            `SELECT * FROM option_positions
             WHERE guildId = @guildId AND userId = @userId ${filter}
             ORDER BY expiry, underlying, strike LIMIT @limit`,
            { guildId, userId, status, limit }
        );
    }

    async getPosition({ guildId, userId, id }) {
        return await db.get(
            'SELECT * FROM option_positions WHERE id = @id AND guildId = @guildId AND userId = @userId',
            { guildId, userId, id }
        ) || null;
    }

    /** Recent option fills, newest first. */
    async listTrades({ guildId, userId, limit = 10 }) {
        return await db.all(
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
    async _assertTradable({ guildId, userId, expiry, now, viaGroupEvent = false }) {
        await exchangeConfig.requireFeature(guildId, 'optionsEnabled', 'Options');
        if (optionsMarket.hasExpired(expiry, now)) {
            throw new ExchangeError('EXPIRED', `${expiry} has already settled - pick a later expiry.`);
        }
        if (!optionsMarket.isZeroDte(expiry, now)) return;

        await exchangeConfig.requireFeature(guildId, 'zeroDteEnabled', 'Same-day (0DTE) contracts');
        // Group events (the Wheel) carry their own consent: participating in
        // one IS the same-day acknowledgement, so the personal Goblin Mode
        // flag is not additionally required. Only trusted server code
        // (wheelService) sets this - it is never exposed to a command or tool.
        if (viaGroupEvent) return;
        const account = await accountService.getAccount(guildId, userId);
        if (!account.goblinMode) {
            throw new ExchangeError('GOBLIN_MODE_REQUIRED',
                'Same-day contracts are behind Goblin Mode. Turn it on with `/margin goblin enabled:true` first - it is an explicit acknowledgement that the most likely value of this contract at the bell is zero.');
        }
    }

    /** The single open lot for a contract on one side, or null. */
    async _openLot({ guildId, userId, underlying, optionType, strike, expiry, side }) {
        return await db.get(
            `SELECT * FROM option_positions
             WHERE guildId = @guildId AND userId = @userId AND underlying = @underlying
               AND optionType = @optionType AND strike = @strike AND expiry = @expiry
               AND side = @side AND status = 'OPEN'`,
            { guildId, userId, underlying, optionType, strike, expiry, side }
        ) || null;
    }

    /**
     * Buy to open (or add to) a long contract.
     * @param {Object} params - { guildId, userId, symbol, optionType, strike, expiry, contracts }
     * @returns {Promise<Object>} fill details, the resulting position, and the risk picture
     */
    async buyToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts, now = new Date(), viaGroupEvent = false }) {
        const count = normalizeContracts(contracts);
        await this._assertTradable({ guildId, userId, expiry, now, viaGroupEvent });

        const contract = await optionsMarket.quoteContract({
            symbol, optionType, strike, expiry, guildId, now
        });
        const cost = contract.costPerContract * count;
        if (cost <= 0) {
            throw new ExchangeError('BAD_ORDER', 'That order costs less than one point - buy more contracts.');
        }

        const shortLot = await this._openLot({
            guildId, userId, underlying: contract.underlying, optionType: contract.optionType,
            strike: contract.strike, expiry, side: 'SHORT'
        });
        if (shortLot) {
            throw new ExchangeError('SHORT_HELD',
                `You have written that exact contract (position #${shortLot.id}); buying it back is a close, not a new long - use buy-to-close.`);
        }

        const balance = await economyService.getBalance(guildId, userId);
        if (balance < cost) {
            const { currencyName } = await economyService.getSettings(guildId);
            throw new ExchangeError('INSUFFICIENT_FUNDS',
                `Contracts are paid in cash (never borrowed): you have ${balance.toLocaleString()} ${currencyName}, that order needs ${cost.toLocaleString()}.`);
        }

        return await db.transaction(async () => {
            const newBalance = await economyService.adjust({
                guildId, userId, amount: -cost,
                type: 'option-buy',
                detail: JSON.stringify({
                    underlying: contract.underlying, optionType: contract.optionType,
                    strike: contract.strike, expiry, contracts: count, premium: contract.ask
                })
            });

            const existing = await this._openLot({
                guildId, userId, underlying: contract.underlying,
                optionType: contract.optionType, strike: contract.strike, expiry, side: 'LONG'
            });

            let positionId;
            if (existing) {
                const totalContracts = existing.contracts + count;
                const avgPremium = (existing.openPremium * existing.contracts + contract.ask * count) / totalContracts;
                await db.run(
                    `UPDATE option_positions SET contracts = @totalContracts, openPremium = @avgPremium,
                         costBasis = costBasis + @cost, openIv = @iv, updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: existing.id, totalContracts, avgPremium, cost, iv: contract.iv }
                );
                positionId = existing.id;
            } else {
                positionId = await db.insert(
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
                );
            }

            await this._recordTrade({
                guildId, userId, positionId, contract, action: 'BUY_TO_OPEN', contracts: count,
                premium: contract.ask, points: cost
            });
            await exchangeEvents.record({
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
                position: await db.get('SELECT * FROM option_positions WHERE id = @id', { id: positionId })
            };
        });
    }

    /**
     * Sell to close some or all of an open position at the current bid.
     * @param {Object} params - { guildId, userId, positionId, contracts?: number|null }
     */
    async sellToClose({ guildId, userId, positionId, contracts = null, now = new Date() }) {
        const position = await this.getPosition({ guildId, userId, id: positionId });
        if (!position || position.status !== 'OPEN') {
            throw new ExchangeError('NO_POSITION', 'You have no open contract with that id.');
        }
        if (position.side === 'SHORT') {
            throw new ExchangeError('WRONG_SIDE', `Position #${position.id} is a written contract - close it with buy-to-close.`);
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

        return await db.transaction(async () => {
            const balance = await economyService.adjust({
                guildId, userId, amount: proceeds,
                type: 'option-sell',
                detail: JSON.stringify({
                    underlying: position.underlying, optionType: position.optionType,
                    strike: position.strike, expiry: position.expiry, contracts: count, premium: contract.bid
                })
            });

            const remaining = position.contracts - count;
            if (remaining > 0) {
                await db.run(
                    `UPDATE option_positions SET contracts = @remaining,
                         costBasis = MAX(0, costBasis - @closedBasis), updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: position.id, remaining, closedBasis }
                );
            } else {
                await db.run(
                    `UPDATE option_positions SET status = 'CLOSED', closePremium = @premium,
                         proceeds = @proceeds, realizedPL = @realized, closedAt = CURRENT_TIMESTAMP,
                         updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: position.id, premium: contract.bid, proceeds, realized: proceeds - closedBasis }
                );
            }

            await this._recordTrade({
                guildId, userId, positionId: position.id, contract, action: 'SELL_TO_CLOSE',
                contracts: count, premium: contract.bid, points: proceeds
            });
            await exchangeEvents.record({
                guildId, userId, eventType: 'option-close', symbol: position.underlying, amount: proceeds - closedBasis,
                detail: {
                    optionType: position.optionType, strike: position.strike, expiry: position.expiry,
                    contracts: count, premium: contract.bid
                }
            });

            return {
                position: await db.get('SELECT * FROM option_positions WHERE id = @id', { id: position.id }),
                contract,
                contracts: count,
                proceeds,
                realized: proceeds - closedBasis,
                balance
            };
        });
    }

    /**
     * Write (sell to open) a contract, collecting the premium up front.
     *
     * Requires a MARGIN account: the writer owes the intrinsic value at
     * settlement, and while the contract is open its margin requirement -
     * naked, spread-width, or zero when covered by shares - must fit inside
     * the account's buying power.
     * @param {Object} params - { guildId, userId, symbol, optionType, strike, expiry, contracts }
     */
    async sellToOpen({ guildId, userId, symbol, optionType, strike, expiry, contracts, now = new Date() }) {
        const count = normalizeContracts(contracts);
        await this._assertTradable({ guildId, userId, expiry, now });

        const account = await accountService.getAccount(guildId, userId);
        if (account.accountType !== 'MARGIN') {
            throw new ExchangeError('CASH_ACCOUNT', 'Writing contracts needs a margin account (`/margin account type:margin`) - the seller owes the settlement.');
        }

        const contract = await optionsMarket.quoteContract({ symbol, optionType, strike, expiry, guildId, now });
        const credit = contract.creditPerContract * count;
        if (credit <= 0) {
            throw new ExchangeError('BAD_ORDER', 'That contract collects less than one point of premium - not worth the ink.');
        }

        const longLot = await this._openLot({
            guildId, userId, underlying: contract.underlying, optionType: contract.optionType,
            strike: contract.strike, expiry, side: 'LONG'
        });
        if (longLot) {
            throw new ExchangeError('LONG_HELD',
                `You hold that exact contract long (position #${longLot.id}); selling it is a close, not a write - use \`/options close\`.`);
        }

        // The requirement check: snapshot buying power already nets out every
        // existing requirement, so the new write just has to fit its own
        // incremental requirement (pairing against still-uncovered longs and
        // shares is recomputed over the whole book).
        const snapshot = await accountService.getSnapshot({ guildId, userId, now });
        const bookAfter = [
            ...snapshot.options.filter(option => option.priced).map(option => ({
                id: option.id, underlying: option.underlying, optionType: option.optionType,
                expiry: option.expiry, side: option.side, strike: option.strike,
                contracts: option.contracts, contractSize: option.contractSize,
                mark: option.side === 'SHORT' ? option.markAsk : option.mark, spot: option.spot
            })),
            {
                id: 'new', underlying: contract.underlying, optionType: contract.optionType,
                expiry: contract.expiry, side: 'SHORT', strike: contract.strike,
                contracts: count, contractSize: contract.contractSize, mark: contract.ask, spot: contract.spot
            }
        ];
        const sharesBySymbol = Object.fromEntries(
            snapshot.longs.filter(p => p.priced).map(p => [p.symbol, p.units])
        );
        const requirementAfter = marginMath.optionBookRequirement({ positions: bookAfter, sharesBySymbol }).total;
        const incremental = Math.max(0, requirementAfter - snapshot.optionRequirement);
        if (snapshot.buyingPower + credit < incremental) {
            throw new ExchangeError('INSUFFICIENT_BUYING_POWER',
                `Writing ${count}x that contract requires ${Math.ceil(incremental).toLocaleString()} points of margin; you have ${Math.floor(snapshot.buyingPower).toLocaleString()} of buying power (the ${credit.toLocaleString()} premium counts toward it).`);
        }

        return await db.transaction(async () => {
            const balance = await economyService.adjust({
                guildId, userId, amount: credit,
                type: 'option-write',
                detail: JSON.stringify({
                    underlying: contract.underlying, optionType: contract.optionType,
                    strike: contract.strike, expiry, contracts: count, premium: contract.bid
                })
            });

            const existing = await this._openLot({
                guildId, userId, underlying: contract.underlying,
                optionType: contract.optionType, strike: contract.strike, expiry, side: 'SHORT'
            });
            let positionId;
            if (existing) {
                const totalContracts = existing.contracts + count;
                const avgPremium = (existing.openPremium * existing.contracts + contract.bid * count) / totalContracts;
                await db.run(
                    `UPDATE option_positions SET contracts = @totalContracts, openPremium = @avgPremium,
                         costBasis = costBasis + @credit, openIv = @iv, updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: existing.id, totalContracts, avgPremium, credit, iv: contract.iv }
                );
                positionId = existing.id;
            } else {
                positionId = await db.insert(
                    `INSERT INTO option_positions (
                         guildId, userId, underlying, optionType, strike, expiry,
                         contracts, contractSize, side, openPremium, costBasis, openIv
                     ) VALUES (
                         @guildId, @userId, @underlying, @optionType, @strike, @expiry,
                         @contracts, @contractSize, 'SHORT', @premium, @credit, @iv
                     )`,
                    {
                        guildId, userId, underlying: contract.underlying, optionType: contract.optionType,
                        strike: contract.strike, expiry, contracts: count,
                        contractSize: contract.contractSize, premium: contract.bid, credit, iv: contract.iv
                    }
                );
            }

            await this._recordTrade({
                guildId, userId, positionId, contract, action: 'SELL_TO_OPEN', contracts: count,
                premium: contract.bid, points: credit
            });
            await exchangeEvents.record({
                guildId, userId, eventType: 'option-write', symbol: contract.underlying, amount: credit,
                detail: {
                    optionType: contract.optionType, strike: contract.strike, expiry,
                    contracts: count, premium: contract.bid, zeroDte: contract.zeroDte,
                    requirement: Math.round(incremental)
                }
            });

            return {
                positionId,
                contract,
                contracts: count,
                credit,
                balance,
                requirement: incremental,
                maxLoss: contract.optionType === 'CALL' ? null : Math.floor(contract.strike * contract.contractSize) * count - credit,
                position: await db.get('SELECT * FROM option_positions WHERE id = @id', { id: positionId })
            };
        });
    }

    /**
     * Buy back some or all of a written contract at the current ask. A margin
     * account may borrow the difference - being unable to afford the
     * buy-back is exactly how a naked write goes wrong.
     */
    async buyToClose({ guildId, userId, positionId, contracts = null, now = new Date() }) {
        const position = await this.getPosition({ guildId, userId, id: positionId });
        if (!position || position.status !== 'OPEN') {
            throw new ExchangeError('NO_POSITION', 'You have no open contract with that id.');
        }
        if (position.side !== 'SHORT') {
            throw new ExchangeError('WRONG_SIDE', `Position #${position.id} is a long contract - close it with \`/options close\`.`);
        }
        if (optionsMarket.hasExpired(position.expiry, now)) {
            throw new ExchangeError('EXPIRED', 'That contract has already reached its settlement time; the exchange will settle it on the next tick.');
        }

        const count = contracts === null ? position.contracts : normalizeContracts(contracts);
        if (count > position.contracts) {
            throw new ExchangeError('NO_POSITION', `You only wrote ${position.contracts} of those contracts.`);
        }

        const contract = await optionsMarket.quoteContract({
            symbol: position.underlying, optionType: position.optionType,
            strike: position.strike, expiry: position.expiry, guildId, now
        });
        const cost = contract.costPerContract * count;
        const closedCredit = Math.round(position.costBasis * (count / position.contracts));

        await accountService.ensureFunds({ guildId, userId, cost, reason: 'buy-to-close', now });

        return await db.transaction(async () => {
            const balance = await economyService.adjust({
                guildId, userId, amount: -cost,
                type: 'option-buy-close',
                detail: JSON.stringify({
                    underlying: position.underlying, optionType: position.optionType,
                    strike: position.strike, expiry: position.expiry, contracts: count, premium: contract.ask
                })
            });

            const remaining = position.contracts - count;
            if (remaining > 0) {
                await db.run(
                    `UPDATE option_positions SET contracts = @remaining,
                         costBasis = MAX(0, costBasis - @closedCredit), updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: position.id, remaining, closedCredit }
                );
            } else {
                await db.run(
                    `UPDATE option_positions SET status = 'CLOSED', closePremium = @premium,
                         proceeds = @negCost, realizedPL = @realized, closedAt = CURRENT_TIMESTAMP,
                         updatedAt = CURRENT_TIMESTAMP
                     WHERE id = @id`,
                    { id: position.id, premium: contract.ask, negCost: -cost, realized: closedCredit - cost }
                );
            }

            await this._recordTrade({
                guildId, userId, positionId: position.id, contract, action: 'BUY_TO_CLOSE',
                contracts: count, premium: contract.ask, points: cost
            });
            await exchangeEvents.record({
                guildId, userId, eventType: 'option-buy-close', symbol: position.underlying,
                amount: closedCredit - cost,
                detail: {
                    optionType: position.optionType, strike: position.strike, expiry: position.expiry,
                    contracts: count, premium: contract.ask
                }
            });

            return {
                position: await db.get('SELECT * FROM option_positions WHERE id = @id', { id: position.id }),
                contract,
                contracts: count,
                cost,
                realized: closedCredit - cost,
                balance
            };
        });
    }

    /**
     * Settle one expired position against the underlying's settlement price.
     * Longs receive the intrinsic value; writers pay it (assignment),
     * borrowing onto the margin loan when the wallet cannot cover. Out of the
     * money, longs get nothing and writers keep the whole premium.
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
        const short = position.side === 'SHORT';
        // Longs receive the floor, writers owe the ceiling - rounding always
        // favours the house, as everywhere else in the game
        const settlementValue = short
            ? Math.ceil(intrinsic * position.contractSize * position.contracts)
            : Math.floor(intrinsic * position.contractSize * position.contracts);
        const status = settlementValue > 0 ? 'EXERCISED' : 'EXPIRED';
        // Long: paid premium (costBasis), receives value. Short: collected
        // premium (costBasis), pays value.
        const realized = short ? position.costBasis - settlementValue : settlementValue - position.costBasis;

        // An assigned writer pays even with an empty wallet: the shortfall is
        // borrowed onto the margin loan (writes require a margin account), and
        // the risk engine takes it from there.
        if (short && settlementValue > 0) {
            const balance = await economyService.getBalance(position.guildId, position.userId);
            if (balance < settlementValue) {
                await accountService.borrow({
                    guildId: position.guildId, userId: position.userId,
                    amount: settlementValue - balance, reason: 'option assignment'
                });
            }
        }

        await db.transaction(async () => {
            if (settlementValue > 0) {
                await economyService.adjust({
                    guildId: position.guildId, userId: position.userId,
                    amount: short ? -settlementValue : settlementValue,
                    type: short ? 'option-assign' : 'option-settle',
                    detail: JSON.stringify({
                        underlying: position.underlying, optionType: position.optionType,
                        strike: position.strike, expiry: position.expiry,
                        contracts: position.contracts, settlePrice
                    })
                });
            }
            await db.run(
                `UPDATE option_positions SET status = @status, closePremium = @intrinsic, proceeds = @proceeds,
                     realizedPL = @realized, closedAt = @stamp, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                {
                    id: position.id, status, intrinsic,
                    proceeds: short ? -settlementValue : settlementValue,
                    realized, stamp: toSqlTime(now)
                }
            );
            await db.run(
                `INSERT INTO option_trades (
                     guildId, userId, positionId, underlying, optionType, strike, expiry,
                     action, contracts, premium, underlyingPrice, points
                 ) VALUES (
                     @guildId, @userId, @positionId, @underlying, @optionType, @strike, @expiry,
                     @action, @contracts, @premium, @settlePrice, @points
                 )`,
                {
                    guildId: position.guildId, userId: position.userId, positionId: position.id,
                    underlying: position.underlying, optionType: position.optionType,
                    strike: position.strike, expiry: position.expiry,
                    action: settlementValue > 0 ? (short ? 'ASSIGN' : 'EXERCISE') : 'EXPIRE',
                    contracts: position.contracts, premium: intrinsic, settlePrice, points: settlementValue
                }
            );
            await exchangeEvents.record({
                guildId: position.guildId, userId: position.userId,
                eventType: settlementValue > 0 ? (short ? 'option-assign' : 'option-exercise') : 'option-expire',
                symbol: position.underlying, amount: realized,
                detail: {
                    optionType: position.optionType, strike: position.strike, expiry: position.expiry,
                    side: position.side, contracts: position.contracts, settlePrice,
                    settlementValue
                }
            });
        });

        return { status, payout: short ? -settlementValue : settlementValue, realized, settlePrice };
    }

    /**
     * Settle every contract whose expiry has passed (the risk engine's
     * expiration and assignment pass).
     * @returns {Promise<Array>} one result per settled position
     */
    async settleExpired({ guildId = null, now = new Date() } = {}) {
        const filter = guildId ? 'AND guildId = @guildId' : '';
        const due = (await db.all(
            `SELECT * FROM option_positions WHERE status = 'OPEN' AND expiry <= @today ${filter}
             ORDER BY expiry LIMIT 500`,
            { guildId, today: optionsMarket.dateKey(now) }
        )).filter(position => optionsMarket.hasExpired(position.expiry, now));

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

    async _recordTrade({ guildId, userId, positionId, contract, action, contracts, premium, points }) {
        await db.run(
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
