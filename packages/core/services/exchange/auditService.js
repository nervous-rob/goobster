const db = require('../../db');
const economyService = require('../economyService');
const exchangeConfig = require('./exchangeConfig');
const accountService = require('./accountService');
const optionsService = require('./optionsService');
const orderService = require('./orderService');
const predictionService = require('./predictionService');
const optionsMarket = require('./optionsMarket');
const exchangeEvents = require('./exchangeEvents');

/**
 * The exchange's auditor: everything Goobster (or an admin) needs to explain
 * an account, an economy, or an anomaly - without touching a single row.
 *
 * Three views:
 *   - auditAccount: one trader, end to end (positions, greeks, leverage,
 *     liquidation levels, realized P/L, wallet ledger, engine events)
 *   - auditGuild: the whole market (money supply, exposure, open interest,
 *     concentration, liquidations, house take)
 *   - reconcile: integrity checks that prove the books add up, so a bug in a
 *     new instrument shows up as a failed invariant instead of quiet drift
 *
 * Everything here is read-only by construction.
 */
class ExchangeAuditService {
    /**
     * Everything about one trader's exchange activity.
     * @param {{guildId: string, userId: string, ledgerLimit?: number, eventLimit?: number}} params
     */
    async auditAccount({ guildId, userId, ledgerLimit = 10, eventLimit = 10, now = new Date() }) {
        const snapshot = await accountService.getSnapshot({ guildId, userId, now });
        const { currencyName } = await economyService.getSettings(guildId);

        const ledgerByType = await db.all(
            `SELECT type, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS net
             FROM economy_transactions WHERE guildId = @guildId AND userId = @userId
             GROUP BY type ORDER BY ABS(SUM(amount)) DESC`,
            { guildId, userId }
        );
        const ledgerTotal = ledgerByType.reduce((sum, row) => sum + row.net, 0);

        const optionsRealized = await db.get(
            `SELECT COALESCE(SUM(realizedPL), 0) AS net, COUNT(*) AS closed,
                    SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expiredWorthless,
                    SUM(CASE WHEN status = 'EXERCISED' THEN 1 ELSE 0 END) AS exercised
             FROM option_positions
             WHERE guildId = @guildId AND userId = @userId AND status != 'OPEN'`,
            { guildId, userId }
        );
        const predictionsRealized = await db.get(
            `SELECT COALESCE(SUM(COALESCE(payout, 0) - cost), 0) AS net, COUNT(*) AS settled
             FROM prediction_positions
             WHERE guildId = @guildId AND userId = @userId AND status = 'SETTLED'`,
            { guildId, userId }
        );
        const shortsRealized = await db.get(
            `SELECT COALESCE(SUM(amount), 0) AS net, COUNT(*) AS covers
             FROM exchange_events
             WHERE guildId = @guildId AND userId = @userId AND eventType = 'short-cover'`,
            { guildId, userId }
        );
        const perpsRealized = await db.get(
            `SELECT COALESCE(SUM(realizedPL), 0) AS net, COUNT(*) AS closed,
                    SUM(CASE WHEN status = 'LIQUIDATED' THEN 1 ELSE 0 END) AS liquidated
             FROM perp_positions
             WHERE guildId = @guildId AND userId = @userId AND status != 'OPEN'`,
            { guildId, userId }
        );
        const dividendsReceived = await db.get(
            `SELECT COALESCE(SUM(amount), 0) AS net FROM exchange_events
             WHERE guildId = @guildId AND userId = @userId AND eventType IN ('dividend', 'dividend-short')`,
            { guildId, userId }
        );
        const financingPaid = await db.get(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM exchange_events
             WHERE guildId = @guildId AND userId = @userId AND eventType IN ('margin-interest', 'borrow-fee')`,
            { guildId, userId }
        );

        const openOrders = await orderService.list({ guildId, userId, status: 'working', limit: 25 });
        const predictions = await predictionService.listPositions({ guildId, userId, status: 'OPEN', limit: 25 });
        const optionHistory = (await optionsService.listPositions({ guildId, userId, status: null, limit: 100 }))
            .filter(position => position.status !== 'OPEN')
            .slice(0, 10);

        return {
            guildId,
            userId,
            currencyName,
            snapshot,
            openOrders,
            predictions,
            optionHistory,
            realized: {
                options: optionsRealized.net,
                optionsClosed: optionsRealized.closed,
                optionsExpiredWorthless: optionsRealized.expiredWorthless || 0,
                optionsExercised: optionsRealized.exercised || 0,
                predictions: predictionsRealized.net,
                predictionsSettled: predictionsRealized.settled,
                shorts: shortsRealized.net,
                shortCovers: shortsRealized.covers,
                perps: perpsRealized.net,
                perpsClosed: perpsRealized.closed || 0,
                perpsLiquidated: perpsRealized.liquidated || 0,
                dividendsNet: dividendsReceived.net,
                financingPaid: financingPaid.total
            },
            ledger: {
                byType: ledgerByType,
                net: ledgerTotal,
                // Every point in the wallet must be explained by the ledger
                reconciles: ledgerTotal === snapshot.cash,
                recent: await economyService.getHistory({ guildId, userId, limit: ledgerLimit })
            },
            events: await exchangeEvents.list({ guildId, userId, limit: eventLimit }),
            risks: this._riskFlags(snapshot),
            asOf: snapshot.asOf
        };
    }

    /** Human-readable warnings about an account's current state. */
    _riskFlags(snapshot) {
        const flags = [];
        if (snapshot.marginCall) flags.push('MARGIN CALL: equity is below the maintenance requirement.');
        if (snapshot.debt > 0 && snapshot.equity > 0 && snapshot.debt > snapshot.equity) {
            flags.push('Debt exceeds equity - the loan is bigger than the account.');
        }
        if (snapshot.leverageUsed && snapshot.leverageUsed > snapshot.account.leverage) {
            flags.push(`Exposure is ${snapshot.leverageUsed.toFixed(2)}x equity, above the account's ${snapshot.account.leverage}x tier.`);
        }
        if (snapshot.marginMove && snapshot.marginMove.drop > 0 && snapshot.marginMove.drop < 0.15) {
            flags.push(`A ${(snapshot.marginMove.drop * 100).toFixed(1)}% move against this book triggers a margin call.`);
        }
        const zeroDte = snapshot.options.filter(option => option.zeroDte);
        if (zeroDte.length > 0) {
            const risked = zeroDte.reduce((sum, option) => sum + option.costBasis, 0);
            flags.push(`${zeroDte.length} same-day contract(s) expiring today with ${risked.toLocaleString()} points at risk - most likely value at the bell is 0.`);
        }
        const nakedCalls = snapshot.options.filter(option => option.side === 'SHORT' && option.optionType === 'CALL' && option.maxLoss === null);
        if (nakedCalls.length > 0) {
            flags.push(`${nakedCalls.length} written call position(s) with UNBOUNDED loss potential (naked unless covered by shares).`);
        }
        for (const perp of snapshot.perps.filter(position => position.priced)) {
            const distance = Math.abs(perp.price - perp.liquidationPrice) / perp.price;
            if (distance < 0.05) {
                flags.push(`Perp #${perp.id} (${perp.direction} ${perp.symbol}) is ${(distance * 100).toFixed(1)}% from its $${perp.liquidationPrice.toFixed(2)} liquidation price.`);
            }
        }
        const shortsAtRisk = snapshot.shorts.filter(position => position.priced && position.price > position.avgPrice * 1.2);
        for (const position of shortsAtRisk) {
            flags.push(`${position.symbol} short is ${(((position.price / position.avgPrice) - 1) * 100).toFixed(0)}% underwater.`);
        }
        if (snapshot.pricingGaps > 0) {
            flags.push(`${snapshot.pricingGaps} position(s) could not be priced - these numbers are incomplete.`);
        }
        return flags;
    }

    /**
     * The whole market: money supply, exposure, concentration, and what the
     * engine has been doing.
     */
    async auditGuild({ guildId, topN = 10, now = new Date() }) {
        const settings = await exchangeConfig.get(guildId);
        const { currencyName } = await economyService.getSettings(guildId);

        const wallets = await db.get(
            `SELECT COUNT(*) AS count, COALESCE(SUM(balance), 0) AS total, COALESCE(MAX(balance), 0) AS largest
             FROM economy_wallets WHERE guildId = @guildId`,
            { guildId }
        );
        const loans = await db.get(
            `SELECT COUNT(*) AS accounts, COALESCE(SUM(marginLoan), 0) AS total,
                    COALESCE(SUM(liquidations), 0) AS liquidations,
                    SUM(CASE WHEN marginCallAt IS NOT NULL THEN 1 ELSE 0 END) AS called,
                    SUM(CASE WHEN accountType = 'MARGIN' THEN 1 ELSE 0 END) AS marginAccounts,
                    SUM(CASE WHEN goblinMode = 1 THEN 1 ELSE 0 END) AS goblins
             FROM exchange_accounts WHERE guildId = @guildId`,
            { guildId }
        );

        const longBook = await db.all(
            `SELECT symbol, SUM(units) AS units, SUM(costBasis) AS costBasis, COUNT(*) AS holders
             FROM stock_holdings WHERE guildId = @guildId GROUP BY symbol ORDER BY costBasis DESC LIMIT @topN`,
            { guildId, topN }
        );
        const shortBook = await db.all(
            `SELECT symbol, SUM(units) AS units, SUM(proceeds) AS proceeds, COUNT(*) AS shorts
             FROM short_positions WHERE guildId = @guildId GROUP BY symbol ORDER BY proceeds DESC LIMIT @topN`,
            { guildId, topN }
        );
        const optionOpenInterest = await db.all(
            `SELECT underlying, optionType, expiry, SUM(contracts) AS contracts, SUM(costBasis) AS premium,
                    COUNT(DISTINCT userId) AS traders
             FROM option_positions WHERE guildId = @guildId AND status = 'OPEN'
             GROUP BY underlying, optionType, expiry ORDER BY premium DESC LIMIT @topN`,
            { guildId, topN }
        );
        const zeroDteOpenInterest = optionOpenInterest.filter(row => optionsMarket.isZeroDte(row.expiry, now));

        const perpBook = await db.all(
            `SELECT symbol, direction, COUNT(*) AS positions, SUM(margin) AS margin,
                    SUM(margin * leverage) AS notional
             FROM perp_positions WHERE guildId = @guildId AND status = 'OPEN'
             GROUP BY symbol, direction ORDER BY notional DESC LIMIT @topN`,
            { guildId, topN }
        );
        const writtenBook = await db.get(
            `SELECT COUNT(*) AS lots, COALESCE(SUM(contracts), 0) AS contracts,
                    COALESCE(SUM(costBasis), 0) AS premiumCollected
             FROM option_positions WHERE guildId = @guildId AND status = 'OPEN' AND side = 'SHORT'`,
            { guildId }
        );
        const groupPlay = await require('./groupPlayService').summarize(guildId);

        const workingOrders = (await db.get(
            `SELECT COUNT(*) AS count FROM exchange_orders
             WHERE guildId = @guildId AND status IN ('OPEN', 'TRIGGERED')`,
            { guildId }
        )).count;
        const markets = await predictionService.listMarkets({ guildId, status: 'OPEN', limit: 25 });
        const marketExposure = await db.get(
            `SELECT COALESCE(SUM(cost), 0) AS staked, COUNT(*) AS positions
             FROM prediction_positions WHERE guildId = @guildId AND status = 'OPEN'`,
            { guildId }
        );

        // The house take: what the economy paid the exchange in financing and
        // lost to expiring paper, net of what it won back.
        const houseFlow = await db.all(
            `SELECT type, COALESCE(SUM(amount), 0) AS net, COUNT(*) AS count
             FROM economy_transactions WHERE guildId = @guildId
               AND type IN ('option-buy', 'option-sell', 'option-settle', 'prediction-buy',
                            'prediction-settle', 'prediction-refund', 'stock-short-open',
                            'stock-short-cover', 'margin-borrow', 'margin-repay')
             GROUP BY type`,
            { guildId }
        );

        const traders = await this.leaderboard({ guildId, limit: topN, now });
        const totalEquity = traders.reduce((sum, trader) => sum + Math.max(0, trader.equity), 0);
        const concentration = totalEquity > 0
            ? traders.reduce((sum, trader) => sum + (Math.max(0, trader.equity) / totalEquity) ** 2, 0)
            : 0;

        return {
            guildId,
            currencyName,
            settings,
            moneySupply: {
                wallets: wallets.count,
                circulating: wallets.total,
                largestWallet: wallets.largest,
                outstandingLoans: loans.total,
                netOfDebt: wallets.total - loans.total
            },
            accounts: {
                total: loans.accounts,
                margin: loans.marginAccounts || 0,
                goblinMode: loans.goblins || 0,
                underMarginCall: loans.called || 0,
                lifetimeLiquidations: loans.liquidations || 0
            },
            longBook,
            shortBook,
            optionOpenInterest,
            zeroDteOpenInterest,
            writtenBook,
            perpBook,
            groupPlay,
            workingOrders,
            predictionMarkets: markets,
            predictionExposure: marketExposure,
            houseFlow,
            traders,
            concentration: {
                // Herfindahl index over trader equity: 1.0 = one trader owns
                // the entire market, ~1/n = evenly spread
                hhi: Number(concentration.toFixed(4)),
                topShare: totalEquity > 0 && traders.length > 0
                    ? Number((Math.max(0, traders[0].equity) / totalEquity).toFixed(4))
                    : 0
            },
            engineActivity: await exchangeEvents.countsByType({ guildId, sinceDays: 7 }),
            recentEvents: await exchangeEvents.list({ guildId, limit: 10 }),
            asOf: accountService.toSqlTime(now)
        };
    }

    /**
     * Traders ranked by total equity (wallet + positions - debt), which is the
     * only ranking that survives leverage: a big wallet funded by a big loan
     * is not a big account.
     */
    async leaderboard({ guildId, limit = 10, now = new Date() }) {
        const userIds = (await db.all(
            `SELECT DISTINCT userId FROM (
                 SELECT userId FROM economy_wallets WHERE guildId = @guildId
                 UNION SELECT userId FROM stock_holdings WHERE guildId = @guildId
                 UNION SELECT userId FROM short_positions WHERE guildId = @guildId
                 UNION SELECT userId FROM option_positions WHERE guildId = @guildId AND status = 'OPEN'
                 UNION SELECT userId FROM perp_positions WHERE guildId = @guildId AND status = 'OPEN'
             ) LIMIT 300`,
            { guildId }
        )).map(row => row.userId);

        const rows = [];
        for (const userId of userIds) {
            try {
                const snapshot = await accountService.getSnapshot({ guildId, userId, now });
                rows.push({
                    userId,
                    equity: snapshot.equity,
                    cash: snapshot.cash,
                    exposure: snapshot.exposure,
                    debt: snapshot.debt,
                    marginCall: snapshot.marginCall,
                    accountType: snapshot.account.accountType,
                    leverage: snapshot.account.leverage,
                    goblinMode: snapshot.account.goblinMode
                });
            } catch {
                // A trader we cannot price is left off the board rather than
                // ranked on a guess
            }
        }
        return rows.sort((a, b) => b.equity - a.equity).slice(0, limit);
    }

    /**
     * Integrity checks. Each returns a list of offending rows; an empty result
     * for every check means the books add up.
     *
     * The settlement checks read the clock from `now` like the rest of the
     * auditor, so a caller (or a test) that fixes the clock gets a fixed answer.
     * @param {{guildId: string, sampleSize?: number, now?: Date}} params
     * @returns {{checks: Array<{name, description, ok, count, sample}>, ok: boolean}}
     */
    async reconcile({ guildId, sampleSize = 5, now = new Date() }) {
        const stamp = accountService.toSqlTime(now);
        const today = stamp.slice(0, 10);
        const checks = [];
        const add = (name, description, rows) => {
            checks.push({
                name,
                description,
                ok: rows.length === 0,
                count: rows.length,
                sample: rows.slice(0, sampleSize)
            });
        };

        add('wallet-ledger-drift',
            'Every wallet balance must equal the sum of its ledger entries.',
            await db.all(
                `SELECT w.userId, w.balance, COALESCE(t.total, 0) AS ledgerTotal,
                        w.balance - COALESCE(t.total, 0) AS drift
                 FROM economy_wallets w
                 LEFT JOIN (
                     SELECT userId, SUM(amount) AS total FROM economy_transactions
                     WHERE guildId = @guildId GROUP BY userId
                 ) t ON t.userId = w.userId
                 WHERE w.guildId = @guildId AND w.balance != COALESCE(t.total, 0)`,
                { guildId }
            ));

        add('loan-without-margin',
            'Only margin accounts may carry a loan.',
            await db.all(
                `SELECT userId, marginLoan FROM exchange_accounts
                 WHERE guildId = @guildId AND accountType != 'MARGIN' AND marginLoan > 0`,
                { guildId }
            ));

        add('short-without-margin',
            'Only margin accounts may hold a short position.',
            await db.all(
                `SELECT s.userId, s.symbol, s.units FROM short_positions s
                 LEFT JOIN exchange_accounts a ON a.guildId = s.guildId AND a.userId = s.userId
                 WHERE s.guildId = @guildId AND (a.accountType IS NULL OR a.accountType != 'MARGIN')`,
                { guildId }
            ));

        add('long-and-short',
            'Nobody may be long and short the same symbol at once.',
            await db.all(
                `SELECT h.userId, h.symbol FROM stock_holdings h
                 JOIN short_positions s ON s.guildId = h.guildId AND s.userId = h.userId AND s.symbol = h.symbol
                 WHERE h.guildId = @guildId`,
                { guildId }
            ));

        add('unsettled-expiries',
            'No open contract may sit past its settlement time.',
            await db.all(
                `SELECT id, userId, underlying, optionType, strike, expiry FROM option_positions
                 WHERE guildId = @guildId AND status = 'OPEN' AND expiry < @today`,
                { guildId, today }
            ));

        add('unsettled-markets',
            'No event contract may sit past its resolution time.',
            await db.all(
                `SELECT id, question, resolvesAt FROM prediction_markets
                 WHERE guildId = @guildId AND status IN ('OPEN', 'CLOSED')
                   AND resolvesAt < datetime(@stamp, '-15 minutes')`,
                { guildId, stamp }
            ));

        add('orphan-sell-orders',
            'Every working sell/cover order must have a position behind it.',
            await db.all(
                `SELECT o.id, o.userId, o.symbol, o.side FROM exchange_orders o
                 WHERE o.guildId = @guildId AND o.status IN ('OPEN', 'TRIGGERED')
                   AND ((o.side = 'SELL' AND NOT EXISTS (
                            SELECT 1 FROM stock_holdings h
                            WHERE h.guildId = o.guildId AND h.userId = o.userId AND h.symbol = o.symbol))
                     OR (o.side = 'COVER' AND NOT EXISTS (
                            SELECT 1 FROM short_positions s
                            WHERE s.guildId = o.guildId AND s.userId = o.userId AND s.symbol = o.symbol)))`,
                { guildId }
            ));

        add('impossible-positions',
            'Positions must have positive size and non-negative basis.',
            await db.all(
                `SELECT 'option' AS kind, id, userId FROM option_positions
                 WHERE guildId = @guildId AND status = 'OPEN' AND (contracts <= 0 OR costBasis < 0)
                 UNION ALL
                 SELECT 'prediction', id, userId FROM prediction_positions
                 WHERE guildId = @guildId AND status = 'OPEN' AND (contracts <= 0 OR cost < 0)`,
                { guildId }
            ));

        add('written-without-margin',
            'Only margin accounts may have written (short) option positions.',
            await db.all(
                `SELECT o.id, o.userId, o.underlying, o.strike FROM option_positions o
                 LEFT JOIN exchange_accounts a ON a.guildId = o.guildId AND a.userId = o.userId
                 WHERE o.guildId = @guildId AND o.status = 'OPEN' AND o.side = 'SHORT'
                   AND (a.accountType IS NULL OR a.accountType != 'MARGIN')`,
                { guildId }
            ));

        add('long-and-short-contract',
            'Nobody may hold and have written the same contract at once.',
            await db.all(
                `SELECT a.userId, a.underlying, a.optionType, a.strike, a.expiry
                 FROM option_positions a
                 JOIN option_positions b ON b.guildId = a.guildId AND b.userId = a.userId
                     AND b.underlying = a.underlying AND b.optionType = a.optionType
                     AND b.strike = a.strike AND b.expiry = a.expiry
                     AND b.status = 'OPEN' AND b.side = 'SHORT'
                 WHERE a.guildId = @guildId AND a.status = 'OPEN' AND a.side = 'LONG'`,
                { guildId }
            ));

        add('impossible-perps',
            'Open perps must have positive margin, units, and a liquidation price.',
            await db.all(
                `SELECT id, userId, symbol FROM perp_positions
                 WHERE guildId = @guildId AND status = 'OPEN'
                   AND (margin <= 0 OR units <= 0 OR liquidationPrice < 0)`,
                { guildId }
            ));

        add('settled-without-payout',
            'A settled winning contract must have recorded its payout.',
            await db.all(
                `SELECT p.id, p.userId, p.side, m.outcome FROM prediction_positions p
                 JOIN prediction_markets m ON m.id = p.marketId
                 WHERE p.guildId = @guildId AND p.status = 'SETTLED' AND m.status = 'SETTLED'
                   AND p.side = m.outcome AND COALESCE(p.payout, 0) <= 0`,
                { guildId }
            ));

        return { checks, ok: checks.every(check => check.ok) };
    }

    /**
     * Compact plain-text rendering of an account audit - the form Goobster
     * reads back in chat and voice.
     */
    renderAccountAudit(audit, { label = 'this trader' } = {}) {
        const { snapshot, realized, currencyName } = audit;
        const lines = [];
        const money = value => `${Math.round(value).toLocaleString()} ${currencyName}`;

        lines.push(`ACCOUNT AUDIT - ${label} (as of ${audit.asOf} UTC)`);
        lines.push(`Type: ${snapshot.account.accountType}${snapshot.account.accountType === 'MARGIN' ? ` at ${snapshot.account.leverage}x` : ''}` +
            `${snapshot.account.goblinMode ? ' | GOBLIN MODE ON (0DTE unlocked)' : ''}`);
        lines.push(`Cash ${money(snapshot.cash)} | Longs ${money(snapshot.longValue)} | Shorts ${money(snapshot.shortValue)} | Options ${money(snapshot.optionValue)}`);
        lines.push(`Debt ${money(snapshot.debt)} | Equity ${money(snapshot.equity)} | Buying power ${money(snapshot.buyingPower)}`);
        lines.push(`Maintenance ${money(snapshot.maintenance)} | Excess liquidity ${money(snapshot.excessLiquidity)}` +
            `${snapshot.marginCall ? ' | *** MARGIN CALL ***' : ''}`);
        if (snapshot.marginMove && snapshot.marginMove.drop > 0) {
            lines.push(`A ${(snapshot.marginMove.drop * 100).toFixed(1)}% adverse market move triggers a margin call.`);
        }

        if (snapshot.longs.length > 0) {
            lines.push('Longs:');
            for (const position of snapshot.longs) {
                lines.push(`  ${position.symbol} ${position.units} @ ${position.price === null ? 'unpriced' : `$${position.price.toFixed(2)}`}` +
                    `${position.value === null ? '' : ` = ${money(position.value)} (P/L ${formatSigned(position.profitLoss)})`}`);
            }
        }
        if (snapshot.shorts.length > 0) {
            lines.push('Shorts:');
            for (const position of snapshot.shorts) {
                lines.push(`  ${position.symbol} -${position.units} from $${position.avgPrice.toFixed(2)}` +
                    `${position.price === null ? '' : ` now $${position.price.toFixed(2)} (P/L ${formatSigned(position.profitLoss)})`}` +
                    `${position.borrowFeeAccrued >= 1 ? `, borrow fee ${Math.round(position.borrowFeeAccrued)}` : ''}`);
            }
        }
        if (snapshot.options.length > 0) {
            lines.push('Options:');
            for (const option of snapshot.options) {
                const mark = option.side === 'SHORT' ? option.markAsk : option.mark;
                lines.push(`  #${option.id} ${option.side === 'SHORT' ? 'WROTE ' : ''}${option.contracts}x ${option.underlying} ${option.strike} ${option.optionType} ${option.expiry}` +
                    `${option.zeroDte ? ' [0DTE]' : ''} ${option.side === 'SHORT' ? 'collected' : 'paid'} $${option.openPremium.toFixed(2)}` +
                    `${mark === null || mark === undefined ? ' (unpriced)' : ` now $${mark.toFixed(2)} (P/L ${formatSigned(option.profitLoss)}` +
                        `${option.greeks ? `, delta ${option.greeks.delta.toFixed(2)}, theta ${option.greeks.theta.toFixed(2)}/day` : ''}` +
                        `${option.probabilityItm === null ? '' : `, ${(option.probabilityItm * 100).toFixed(0)}% ITM odds`})`}` +
                    `${option.side === 'SHORT' && option.maxLoss === null ? ' [UNBOUNDED LOSS]' : ''}`);
            }
        }
        if (snapshot.perps && snapshot.perps.length > 0) {
            lines.push('Perpetual futures (isolated margin):');
            for (const perp of snapshot.perps) {
                lines.push(`  #${perp.id} ${perp.direction} ${perp.symbol} ${perp.leverage}x from $${perp.entryPrice.toFixed(2)}` +
                    `${perp.priced ? ` now $${perp.price.toFixed(2)} (P/L ${formatSigned(perp.unrealized)})` : ' (unpriced)'}` +
                    `, margin ${perp.margin.toLocaleString()}, liquidates at $${perp.liquidationPrice.toFixed(2)}` +
                    `${perp.fundingAccrued >= 1 ? `, funding owed ${Math.round(perp.fundingAccrued)}` : ''}`);
            }
        }
        if (audit.openOrders.length > 0) {
            lines.push('Working orders:');
            for (const order of audit.openOrders) {
                lines.push(`  #${order.id} ${order.side} ${order.units} ${order.symbol} ${order.orderType}` +
                    `${order.limitPrice ? ` limit $${order.limitPrice}` : ''}${order.stopPrice ? ` stop $${order.stopPrice}` : ''}` +
                    `${order.trailPercent ? ` trail ${order.trailPercent}%` : ''} [${order.status}]`);
            }
        }
        if (audit.predictions.length > 0) {
            lines.push('Event contracts:');
            for (const position of audit.predictions) {
                lines.push(`  #${position.marketId} ${position.side} x${position.contracts} @ ${Math.round(position.avgPrice)} - ${position.question}`);
            }
        }

        lines.push(`Realized: options ${formatSigned(realized.options)} (${realized.optionsExpiredWorthless} expired worthless, ${realized.optionsExercised} exercised), ` +
            `shorts ${formatSigned(realized.shorts)}, perps ${formatSigned(realized.perps)}${realized.perpsLiquidated > 0 ? ` (${realized.perpsLiquidated} liquidated)` : ''}, ` +
            `event contracts ${formatSigned(realized.predictions)}, dividends ${formatSigned(realized.dividendsNet)}, financing paid ${Math.round(realized.financingPaid).toLocaleString()}`);
        lines.push(`Ledger: ${audit.ledger.byType.length} entry types, net ${formatSigned(audit.ledger.net)}, ` +
            `${audit.ledger.reconciles ? 'reconciles with the wallet' : 'DOES NOT RECONCILE with the wallet'}`);
        if (audit.risks.length > 0) {
            lines.push(`Risk flags: ${audit.risks.join(' ')}`);
        }
        if (audit.events.length > 0) {
            lines.push(`Recent exchange events: ${audit.events.slice(0, 5).map(event => `${event.eventType}${event.symbol ? ` ${event.symbol}` : ''}`).join(', ')}`);
        }
        return lines.join('\n');
    }

    /** Compact plain-text rendering of the guild-wide audit. */
    renderGuildAudit(audit, { names = new Map() } = {}) {
        const money = value => `${Math.round(value).toLocaleString()} ${audit.currencyName}`;
        const lines = [];

        lines.push('EXCHANGE AUDIT (server-wide)');
        lines.push(`Features: margin ${onOff(audit.settings.marginEnabled)}, options ${onOff(audit.settings.optionsEnabled)}, ` +
            `0DTE ${onOff(audit.settings.zeroDteEnabled)}, event contracts ${onOff(audit.settings.predictionsEnabled)}; ` +
            `max leverage ${audit.settings.maxLeverage}x, interest ${(audit.settings.interestRate * 100).toFixed(1)}%/yr, ` +
            `maintenance ${(audit.settings.maintenanceMargin * 100).toFixed(0)}%`);
        lines.push(`Money supply: ${money(audit.moneySupply.circulating)} across ${audit.moneySupply.wallets} wallets, ` +
            `${money(audit.moneySupply.outstandingLoans)} lent out, net ${money(audit.moneySupply.netOfDebt)}`);
        lines.push(`Accounts: ${audit.accounts.total} on the exchange, ${audit.accounts.margin} on margin, ` +
            `${audit.accounts.goblinMode} in goblin mode, ${audit.accounts.underMarginCall} under margin call, ` +
            `${audit.accounts.lifetimeLiquidations} lifetime liquidations`);

        if (audit.longBook.length > 0) {
            lines.push(`Most-held longs: ${audit.longBook.slice(0, 5).map(row => `${row.symbol} (${row.holders} holders, ${money(row.costBasis)} invested)`).join(', ')}`);
        }
        if (audit.shortBook.length > 0) {
            lines.push(`Most-shorted: ${audit.shortBook.slice(0, 5).map(row => `${row.symbol} (${row.shorts} shorts, ${money(row.proceeds)} credited)`).join(', ')}`);
        }
        if (audit.optionOpenInterest.length > 0) {
            lines.push(`Option open interest: ${audit.optionOpenInterest.slice(0, 5).map(row => `${row.underlying} ${row.expiry} ${row.optionType} x${row.contracts}`).join(', ')}`);
        }
        if (audit.zeroDteOpenInterest.length > 0) {
            const premium = audit.zeroDteOpenInterest.reduce((sum, row) => sum + row.premium, 0);
            lines.push(`0DTE open interest expiring today: ${audit.zeroDteOpenInterest.reduce((sum, row) => sum + row.contracts, 0)} contracts, ${money(premium)} of premium at risk.`);
        }
        if (audit.writtenBook && audit.writtenBook.lots > 0) {
            lines.push(`Written contracts outstanding: ${audit.writtenBook.contracts} across ${audit.writtenBook.lots} lot(s), ${money(audit.writtenBook.premiumCollected)} of premium collected.`);
        }
        if (audit.perpBook && audit.perpBook.length > 0) {
            lines.push(`Perp book: ${audit.perpBook.map(row => `${row.symbol} ${row.direction} x${row.positions} (${money(row.notional)} notional)`).join(', ')}.`);
        }
        if (audit.groupPlay) {
            lines.push(`Group play (the Wheel): override-all ${audit.groupPlay.optInOverride ? 'ON' : 'off'}, ` +
                `${audit.groupPlay.explicitOptIns} opt-in(s), ${audit.groupPlay.explicitOptOuts} opt-out(s), ${audit.groupPlay.participants} riding the next spin.`);
        }
        lines.push(`Working orders: ${audit.workingOrders}. Open event markets: ${audit.predictionMarkets.length} with ${money(audit.predictionExposure.staked)} staked.`);

        if (audit.traders.length > 0) {
            lines.push('Top traders by equity:');
            for (const trader of audit.traders.slice(0, 5)) {
                const name = names.get(trader.userId) || trader.userId;
                lines.push(`  ${name}: equity ${money(trader.equity)} (cash ${money(trader.cash)}, exposure ${money(trader.exposure)}` +
                    `${trader.debt > 0 ? `, debt ${money(trader.debt)}` : ''})${trader.marginCall ? ' [MARGIN CALL]' : ''}`);
            }
            lines.push(`Concentration: HHI ${audit.concentration.hhi}, top account holds ${(audit.concentration.topShare * 100).toFixed(1)}% of ranked equity.`);
        }
        if (audit.engineActivity.length > 0) {
            lines.push(`Engine activity (7d): ${audit.engineActivity.slice(0, 8).map(row => `${row.eventType} x${row.count}`).join(', ')}`);
        }
        return lines.join('\n');
    }
}

function onOff(value) {
    return value ? 'ON' : 'off';
}

function formatSigned(value) {
    if (value === null || value === undefined) return 'n/a';
    return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()}`;
}

module.exports = new ExchangeAuditService();
