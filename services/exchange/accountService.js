const db = require('../../db');
const economyService = require('../economyService');
const stockService = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const marginMath = require('./marginMath');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

/**
 * Exchange accounts: the cash/margin switch, the loan book, the goblin-mode
 * opt-in, and the full risk snapshot every other service reads before it lets
 * anyone take on exposure.
 *
 * Invariants this service defends:
 *   - Wallet balances never go negative; borrowing is an explicit liability in
 *     `exchange_accounts.marginLoan`, not an overdrawn wallet.
 *   - Every borrow and repayment moves points through economyService.adjust(),
 *     so the ledger still explains every point in every wallet.
 *   - A cash account behaves exactly as it did before the exchange existed.
 */
class ExchangeAccountService {
    /** The account row, created lazily as a plain cash account. */
    getAccount(guildId, userId) {
        const existing = db.get(
            'SELECT * FROM exchange_accounts WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        if (existing) return existing;

        db.run(
            `INSERT INTO exchange_accounts (guildId, userId) VALUES (@guildId, @userId)
             ON CONFLICT(guildId, userId) DO NOTHING`,
            { guildId, userId }
        );
        return db.get(
            'SELECT * FROM exchange_accounts WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
    }

    /** Accounts that carry risk (a loan, a short, or an option) in a guild. */
    activeAccounts(guildId) {
        return db.all(
            `SELECT DISTINCT userId FROM (
                 SELECT userId FROM exchange_accounts WHERE guildId = @guildId AND marginLoan > 0
                 UNION SELECT userId FROM short_positions WHERE guildId = @guildId
                 UNION SELECT userId FROM option_positions WHERE guildId = @guildId AND status = 'OPEN'
                 UNION SELECT userId FROM exchange_accounts WHERE guildId = @guildId AND marginCallAt IS NOT NULL
             )`,
            { guildId }
        ).map(row => row.userId);
    }

    /**
     * Switch between a cash and a margin account. Downgrading to cash is
     * refused while the account still owes money or holds a short - those
     * only exist because margin exists.
     */
    setAccountType({ guildId, userId, accountType }) {
        const type = String(accountType || '').toUpperCase();
        if (type !== 'CASH' && type !== 'MARGIN') {
            throw new ExchangeError('BAD_ACCOUNT_TYPE', 'Account type must be CASH or MARGIN.');
        }
        const settings = this.getAccount(guildId, userId);
        if (type === 'MARGIN') {
            exchangeConfig.requireFeature(guildId, 'marginEnabled', 'Margin accounts');
        } else {
            if (settings.marginLoan > 0) {
                throw new ExchangeError('LOAN_OUTSTANDING', `Repay your ${settings.marginLoan.toLocaleString()} point loan before switching back to a cash account.`);
            }
            const shorts = db.get(
                'SELECT COUNT(*) AS count FROM short_positions WHERE guildId = @guildId AND userId = @userId',
                { guildId, userId }
            ).count;
            if (shorts > 0) {
                throw new ExchangeError('SHORTS_OPEN', 'Close your short positions before switching back to a cash account.');
            }
        }

        db.run(
            `UPDATE exchange_accounts SET accountType = @type,
                 leverage = CASE WHEN @type = 'CASH' THEN 1 ELSE leverage END,
                 updatedAt = CURRENT_TIMESTAMP
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId, type }
        );
        exchangeEvents.record({ guildId, userId, eventType: 'account-type', detail: { accountType: type } });
        return this.getAccount(guildId, userId);
    }

    /** Set the account's leverage tier, bounded by the guild's maximum. */
    setLeverage({ guildId, userId, leverage }) {
        const settings = exchangeConfig.requireFeature(guildId, 'marginEnabled', 'Margin accounts');
        const account = this.getAccount(guildId, userId);
        if (account.accountType !== 'MARGIN') {
            throw new ExchangeError('CASH_ACCOUNT', 'Switch to a margin account first (`/margin account type:margin`).');
        }
        const value = Number(leverage);
        if (!Number.isFinite(value) || value < 1 || value > settings.maxLeverage) {
            throw new ExchangeError('BAD_LEVERAGE', `Leverage must be between 1x and ${settings.maxLeverage}x in this server.`);
        }
        db.run(
            'UPDATE exchange_accounts SET leverage = @value, updatedAt = CURRENT_TIMESTAMP WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId, value }
        );
        exchangeEvents.record({ guildId, userId, eventType: 'leverage', detail: { leverage: value } });
        return this.getAccount(guildId, userId);
    }

    /**
     * Goblin mode: the deliberate opt-in that unlocks same-day-expiry
     * contracts. It exists so nobody reaches 0DTE by accident - an accidental
     * nuke is less fun than an intentional one.
     */
    setGoblinMode({ guildId, userId, enabled }) {
        if (enabled) exchangeConfig.requireFeature(guildId, 'zeroDteEnabled', 'Same-day (0DTE) contracts');
        this.getAccount(guildId, userId);
        db.run(
            'UPDATE exchange_accounts SET goblinMode = @enabled, updatedAt = CURRENT_TIMESTAMP WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId, enabled: enabled ? 1 : 0 }
        );
        exchangeEvents.record({
            guildId, userId,
            eventType: enabled ? 'goblin-mode-on' : 'goblin-mode-off',
            detail: { enabled: !!enabled }
        });
        return this.getAccount(guildId, userId);
    }

    /**
     * Draw down the margin loan: points are credited to the wallet (so the
     * ledger shows where they came from) and the debt is recorded.
     * @returns {number} the new loan balance
     */
    borrow({ guildId, userId, amount, reason = null }) {
        const points = Math.ceil(Number(amount));
        if (!Number.isFinite(points) || points <= 0) {
            throw new ExchangeError('BAD_AMOUNT', 'Borrow amount must be a positive number of points.');
        }
        const account = this.getAccount(guildId, userId);
        if (account.accountType !== 'MARGIN') {
            throw new ExchangeError('CASH_ACCOUNT', 'Only margin accounts can borrow.');
        }

        return db.transaction(() => {
            economyService.adjust({
                guildId, userId, amount: points,
                type: 'margin-borrow', detail: JSON.stringify({ reason })
            });
            db.run(
                `UPDATE exchange_accounts SET marginLoan = marginLoan + @points,
                     lastInterestAt = COALESCE(lastInterestAt, CURRENT_TIMESTAMP),
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE guildId = @guildId AND userId = @userId`,
                { guildId, userId, points }
            );
            exchangeEvents.record({ guildId, userId, eventType: 'margin-borrow', amount: points, detail: { reason } });
            return this.getAccount(guildId, userId).marginLoan;
        });
    }

    /**
     * Repay the loan from the wallet (all of it by default). Capitalized
     * interest is part of the loan, so this pays that down too.
     * @returns {{repaid: number, loan: number, balance: number}}
     */
    repay({ guildId, userId, amount = null }) {
        const account = this.getAccount(guildId, userId);
        if (account.marginLoan <= 0) {
            throw new ExchangeError('NO_LOAN', 'You have no margin loan outstanding.');
        }
        const balance = economyService.getBalance(guildId, userId);
        const requested = amount === null ? Math.min(account.marginLoan, balance) : Math.floor(Number(amount));
        if (!Number.isFinite(requested) || requested <= 0) {
            throw new ExchangeError('BAD_AMOUNT', 'Repayment must be a positive number of points.');
        }
        const repaid = Math.min(requested, account.marginLoan);
        if (repaid > balance) {
            throw new ExchangeError('INSUFFICIENT_FUNDS', `You only have ${balance.toLocaleString()} points; that repayment needs ${repaid.toLocaleString()}.`);
        }

        return db.transaction(() => {
            const newBalance = economyService.adjust({
                guildId, userId, amount: -repaid,
                type: 'margin-repay', detail: JSON.stringify({ loanBefore: account.marginLoan })
            });
            db.run(
                `UPDATE exchange_accounts SET marginLoan = marginLoan - @repaid, updatedAt = CURRENT_TIMESTAMP
                 WHERE guildId = @guildId AND userId = @userId`,
                { guildId, userId, repaid }
            );
            // Clearing the loan clears the sub-point interest riding on it.
            // A fraction of a point can never be charged, and carrying it
            // would leave a paid-off account showing a phantom point of debt.
            db.run(
                `UPDATE exchange_accounts SET accruedInterest = 0, lastInterestAt = NULL
                 WHERE guildId = @guildId AND userId = @userId AND marginLoan = 0`,
                { guildId, userId }
            );
            exchangeEvents.record({ guildId, userId, eventType: 'margin-repay', amount: repaid });
            return { repaid, loan: this.getAccount(guildId, userId).marginLoan, balance: newBalance };
        });
    }

    /**
     * Accrue continuous interest on the loan since the last accrual. Interest
     * capitalizes into the loan (it is debt, not a wallet debit) so a trader
     * with an empty wallet still owes what they owe.
     * @returns {{accrued: number, capitalized: number}}
     */
    accrueInterest({ guildId, userId, now = new Date() }) {
        const account = this.getAccount(guildId, userId);
        if (account.marginLoan <= 0) {
            if (account.accruedInterest > 0 || account.lastInterestAt) {
                db.run(
                    `UPDATE exchange_accounts SET accruedInterest = 0, lastInterestAt = NULL
                     WHERE guildId = @guildId AND userId = @userId`,
                    { guildId, userId }
                );
            }
            return { accrued: 0, capitalized: 0 };
        }

        const { interestRate } = exchangeConfig.get(guildId);
        const last = account.lastInterestAt ? new Date(`${account.lastInterestAt}Z`) : now;
        const elapsedMs = Math.max(0, now.getTime() - last.getTime());
        const years = elapsedMs / (365 * 24 * 60 * 60 * 1000);
        const accrued = account.marginLoan * interestRate * years;

        const total = account.accruedInterest + accrued;
        const capitalized = Math.floor(total);
        const remainder = total - capitalized;

        db.run(
            `UPDATE exchange_accounts SET
                 marginLoan = marginLoan + @capitalized,
                 accruedInterest = @remainder,
                 lastInterestAt = @stamp,
                 updatedAt = CURRENT_TIMESTAMP
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId, capitalized, remainder, stamp: toSqlTime(now) }
        );
        if (capitalized > 0) {
            exchangeEvents.record({
                guildId, userId, eventType: 'margin-interest', amount: capitalized,
                detail: { rate: interestRate, days: Number((years * 365).toFixed(4)) }
            });
        }
        return { accrued, capitalized };
    }

    /**
     * The full risk picture for one account: positions, exposure, equity,
     * buying power, maintenance requirement, margin health, and the price
     * levels where things go wrong.
     *
     * Quotes are fetched once per distinct symbol. A symbol whose price is
     * unavailable is reported with `priced: false` and excluded from the
     * totals, and the snapshot says so - risk numbers built on missing prices
     * must never look authoritative.
     */
    async getSnapshot({ guildId, userId, now = new Date() }) {
        const settings = exchangeConfig.get(guildId);
        const account = this.getAccount(guildId, userId);
        const cash = economyService.getBalance(guildId, userId);
        const quotes = new Map();
        let pricingGaps = 0;

        const quoteFor = async symbol => {
            if (quotes.has(symbol)) return quotes.get(symbol);
            let quote = null;
            try {
                quote = await stockService.getQuote(symbol);
            } catch {
                pricingGaps++;
            }
            quotes.set(symbol, quote);
            return quote;
        };

        const longRows = db.all(
            'SELECT symbol, units, costBasis FROM stock_holdings WHERE guildId = @guildId AND userId = @userId ORDER BY symbol',
            { guildId, userId }
        );
        const shortRows = db.all(
            `SELECT symbol, units, proceeds, avgPrice, borrowFeeAccrued, openedAt
             FROM short_positions WHERE guildId = @guildId AND userId = @userId ORDER BY symbol`,
            { guildId, userId }
        );
        const optionRows = db.all(
            `SELECT * FROM option_positions
             WHERE guildId = @guildId AND userId = @userId AND status = 'OPEN'
             ORDER BY expiry, underlying, strike`,
            { guildId, userId }
        );

        const longs = [];
        let longValue = 0;
        for (const row of longRows) {
            const quote = await quoteFor(row.symbol);
            const value = quote ? row.units * quote.price : null;
            if (value !== null) longValue += value;
            longs.push({
                symbol: row.symbol,
                units: row.units,
                costBasis: row.costBasis,
                price: quote?.price ?? null,
                stale: quote?.stale ?? true,
                priced: !!quote,
                value,
                profitLoss: value === null ? null : value - row.costBasis
            });
        }

        const shorts = [];
        let shortValue = 0;
        for (const row of shortRows) {
            const quote = await quoteFor(row.symbol);
            const value = quote ? row.units * quote.price : null;
            if (value !== null) shortValue += value;
            shorts.push({
                symbol: row.symbol,
                units: row.units,
                proceeds: row.proceeds,
                avgPrice: row.avgPrice,
                borrowFeeAccrued: row.borrowFeeAccrued,
                openedAt: row.openedAt,
                price: quote?.price ?? null,
                stale: quote?.stale ?? true,
                priced: !!quote,
                value,
                // A short profits when the buy-back costs less than the credit
                profitLoss: value === null ? null : row.proceeds - value
            });
        }

        const options = [];
        let optionValue = 0;
        let optionDeltaDollars = 0;
        for (const row of optionRows) {
            let contract = null;
            try {
                contract = await optionsMarket.quoteContract({
                    symbol: row.underlying,
                    optionType: row.optionType,
                    strike: row.strike,
                    expiry: row.expiry,
                    guildId,
                    now,
                    quote: await quoteFor(row.underlying) || undefined
                });
            } catch {
                pricingGaps++;
            }
            const notional = row.contracts * row.contractSize;
            const value = contract ? contract.bid * notional : null;
            if (value !== null) {
                optionValue += value;
                optionDeltaDollars += contract.greeks.delta * contract.spot * notional;
            }
            options.push({
                id: row.id,
                underlying: row.underlying,
                optionType: row.optionType,
                strike: row.strike,
                expiry: row.expiry,
                contracts: row.contracts,
                contractSize: row.contractSize,
                openPremium: row.openPremium,
                costBasis: row.costBasis,
                openedAt: row.openedAt,
                zeroDte: optionsMarket.isZeroDte(row.expiry, now),
                daysToExpiry: contract?.daysToExpiry ?? null,
                spot: contract?.spot ?? null,
                mark: contract?.bid ?? null,
                iv: contract?.iv ?? null,
                greeks: contract?.greeks ?? null,
                breakEven: contract?.breakEven ?? null,
                probabilityItm: contract?.probabilityItm ?? null,
                priced: !!contract,
                value,
                profitLoss: value === null ? null : value - row.costBasis,
                maxLoss: row.costBasis
            });
        }

        const debt = account.marginLoan + account.accruedInterest;
        const accountEquity = marginMath.equity({ cash, longValue, optionValue, shortValue, debt });
        const maintenance = marginMath.maintenanceRequirement({
            longValue, shortValue,
            maintenanceMargin: settings.maintenanceMargin,
            shortMaintenanceMargin: settings.shortMaintenanceMargin
        });
        const power = marginMath.buyingPower({
            accountType: account.accountType,
            cash,
            equity: accountEquity,
            optionValue,
            longValue,
            shortValue,
            leverage: account.leverage
        });
        const marginCall = accountEquity < maintenance;
        const exposure = longValue + shortValue + optionValue;

        const liquidationLevels = [
            ...longs.filter(p => p.priced).map(position => ({
                symbol: position.symbol,
                direction: 'LONG',
                price: marginMath.liquidationPrice({
                    direction: 'LONG',
                    units: position.units,
                    cash,
                    optionValue,
                    otherLongValue: longValue - position.value,
                    otherShortValue: shortValue,
                    debt,
                    maintenanceMargin: settings.maintenanceMargin,
                    shortMaintenanceMargin: settings.shortMaintenanceMargin
                })
            })),
            ...shorts.filter(p => p.priced).map(position => ({
                symbol: position.symbol,
                direction: 'SHORT',
                price: marginMath.liquidationPrice({
                    direction: 'SHORT',
                    units: position.units,
                    cash,
                    optionValue,
                    otherLongValue: longValue,
                    otherShortValue: shortValue - position.value,
                    debt,
                    maintenanceMargin: settings.maintenanceMargin,
                    shortMaintenanceMargin: settings.shortMaintenanceMargin
                })
            }))
        ].filter(level => level.price !== null);

        return {
            guildId,
            userId,
            settings,
            account: {
                accountType: account.accountType,
                leverage: account.leverage,
                goblinMode: !!account.goblinMode,
                marginLoan: account.marginLoan,
                accruedInterest: account.accruedInterest,
                marginCallAt: account.marginCallAt,
                liquidations: account.liquidations
            },
            cash,
            longs,
            shorts,
            options,
            longValue,
            shortValue,
            optionValue,
            optionDeltaDollars,
            exposure,
            debt,
            equity: accountEquity,
            maintenance,
            excessLiquidity: accountEquity - maintenance,
            buyingPower: power,
            marginCall,
            leverageUsed: accountEquity > 0 ? exposure / accountEquity : null,
            marginMove: marginMath.marketMoveToMarginCall({
                cash, longValue, optionValue, optionDeltaDollars, shortValue, debt,
                maintenanceMargin: settings.maintenanceMargin,
                shortMaintenanceMargin: settings.shortMaintenanceMargin
            }),
            liquidationLevels,
            pricingGaps,
            asOf: toSqlTime(now)
        };
    }

    /**
     * Reserve `cost` points for a purchase, borrowing the shortfall on a
     * margin account. Cash accounts simply verify the wallet covers it, which
     * keeps their behaviour byte-for-byte what it was before margin existed.
     * @returns {Promise<{borrowed: number}>}
     */
    async ensureFunds({ guildId, userId, cost, reason = null, now = new Date() }) {
        const needed = Math.ceil(Number(cost));
        if (!(needed > 0)) return { borrowed: 0 };

        const account = this.getAccount(guildId, userId);
        const cash = economyService.getBalance(guildId, userId);
        if (cash >= needed) return { borrowed: 0 };
        if (account.accountType !== 'MARGIN') {
            const { currencyName } = economyService.getSettings(guildId);
            throw new ExchangeError('INSUFFICIENT_FUNDS', `Not enough ${currencyName}: you have ${cash.toLocaleString()}, that needs ${needed.toLocaleString()}.`);
        }

        const snapshot = await this.getSnapshot({ guildId, userId, now });
        if (snapshot.buyingPower < needed) {
            throw new ExchangeError('INSUFFICIENT_BUYING_POWER',
                `That order needs ${needed.toLocaleString()} points of buying power; you have ${Math.floor(snapshot.buyingPower).toLocaleString()} at ${snapshot.account.leverage}x.`);
        }
        this.borrow({ guildId, userId, amount: needed - cash, reason });
        return { borrowed: needed - cash };
    }

    /** Flag or clear a margin call, returning whether the state changed. */
    setMarginCall({ guildId, userId, called, now = new Date() }) {
        const account = this.getAccount(guildId, userId);
        const wasCalled = !!account.marginCallAt;
        if (called === wasCalled) return { changed: false, since: account.marginCallAt };
        db.run(
            `UPDATE exchange_accounts SET marginCallAt = @stamp, updatedAt = CURRENT_TIMESTAMP
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId, stamp: called ? toSqlTime(now) : null }
        );
        return { changed: true, since: called ? toSqlTime(now) : null };
    }

    /** Count a completed forced liquidation against the account. */
    recordLiquidation({ guildId, userId }) {
        db.run(
            `UPDATE exchange_accounts SET liquidations = liquidations + 1, updatedAt = CURRENT_TIMESTAMP
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
    }
}

/** SQLite's UTC text format (matches CURRENT_TIMESTAMP). */
function toSqlTime(date) {
    return date.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = new ExchangeAccountService();
module.exports.toSqlTime = toSqlTime;
