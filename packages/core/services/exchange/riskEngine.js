const db = require('../../db');
const economyService = require('../economyService');
const stockPortfolioService = require('../stockPortfolioService');
const exchangeConfig = require('./exchangeConfig');
const accountService = require('./accountService');
const shortService = require('./shortService');
const optionsService = require('./optionsService');
const orderService = require('./orderService');
const predictionService = require('./predictionService');
const marginMath = require('./marginMath');
const exchangeEvents = require('./exchangeEvents');

const TICK_INTERVAL_MS = 5 * 60 * 1000;
// Below this the account is beyond saving by a partial sale, so everything goes
const HOPELESS_EQUITY = 0;
const MAX_LIQUIDATION_PASSES = 2;

/**
 * The boring back-end correctness that maximum risk requires.
 *
 * Every tick, for each guild that uses the exchange:
 *   1. accrue margin interest and short borrow fees
 *   2. settle contracts whose expiry has passed
 *   3. settle event contracts that reached their resolution time
 *   4. fill or expire resting orders
 *   5. mark every account, raise margin calls, and force-liquidate the ones
 *      that stayed under water past the grace period
 *
 * Everything it does lands in `exchange_events` (why) and, when points move,
 * in `economy_transactions` (what) - so a liquidation is always explainable
 * after the fact. Notifications are best-effort DMs; a closed DM never blocks
 * a settlement.
 */
class RiskEngine {
    constructor(client = null) {
        this.client = client;
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.runOnce().catch(error =>
            console.error('[Exchange] Risk tick failed:', error.message)
        ), TICK_INTERVAL_MS);
        // Unref so a pending tick never holds the process open on shutdown
        if (typeof this.timer.unref === 'function') this.timer.unref();
        console.log('[Exchange] Risk engine scheduled (every 5 minutes)');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Guilds with anything the engine could act on. */
    async activeGuilds() {
        return (await db.all(
            `SELECT DISTINCT guildId FROM (
                 SELECT guildId FROM exchange_settings
                 UNION SELECT guildId FROM exchange_accounts WHERE marginLoan > 0 OR marginCallAt IS NOT NULL
                 UNION SELECT guildId FROM short_positions
                 UNION SELECT guildId FROM option_positions WHERE status = 'OPEN'
                 UNION SELECT guildId FROM exchange_orders WHERE status IN ('OPEN', 'TRIGGERED')
                 UNION SELECT guildId FROM prediction_markets WHERE status IN ('OPEN', 'CLOSED')
             )`
        )).map(row => row.guildId);
    }

    /**
     * One full pass over every active guild.
     * @returns {Promise<{guilds: number, results: Array}>}
     */
    async runOnce({ now = new Date() } = {}) {
        if (this.running) return { guilds: 0, results: [], skipped: true };
        this.running = true;
        try {
            const guilds = await this.activeGuilds();
            const results = [];
            for (const guildId of guilds) {
                try {
                    results.push(await this.runGuild({ guildId, now }));
                } catch (error) {
                    console.error(`[Exchange] Risk tick failed for guild ${guildId}:`, error.message);
                }
            }

            // Corporate actions are global (a dividend is a dividend in every
            // guild), throttled internally to ~daily per symbol
            try {
                const corporateActionsService = require('./corporateActionsService');
                const swept = await corporateActionsService.sweep({ now });
                if (swept.applied.length > 0) {
                    console.log(`[Exchange] Applied ${swept.applied.length} corporate action(s):`,
                        swept.applied.map(a => `${a.symbol} ${a.type}`).join(', '));
                }
            } catch (error) {
                console.warn('[Exchange] Corporate-action sweep failed:', error.message);
            }

            return { guilds: guilds.length, results };
        } finally {
            this.running = false;
        }
    }

    /** One guild's full risk pass. */
    async runGuild({ guildId, now = new Date() }) {
        const summary = {
            guildId,
            interest: 0,
            borrowFees: 0,
            optionsSettled: [],
            marketsSettled: [],
            orders: null,
            marginCalls: [],
            liquidations: [],
            perps: { funded: 0, liquidated: [] }
        };

        for (const userId of await accountService.activeAccounts(guildId)) {
            const { capitalized } = await accountService.accrueInterest({ guildId, userId, now });
            summary.interest += capitalized;
            const { accrued } = await shortService.accrueBorrowFees({ guildId, userId, now });
            summary.borrowFees += accrued;
        }

        summary.optionsSettled = await optionsService.settleExpired({ guildId, now });
        for (const settled of summary.optionsSettled) {
            const p = settled.position;
            const name = `${p.contracts}x ${p.underlying} ${p.strike} ${p.optionType}`;
            if (p.side === 'SHORT') {
                await this._notify(p.userId, settled.status === 'EXERCISED'
                    ? `📙 Your written ${name} was **assigned**: you paid ${Math.abs(settled.payout).toLocaleString()} points of settlement (net ${formatSigned(settled.realized)} after the premium you collected).`
                    : `📗 Your written ${name} expired **worthless** - you keep the whole ${p.costBasis.toLocaleString()}-point premium.`);
            } else {
                await this._notify(p.userId, settled.status === 'EXERCISED'
                    ? `📗 Your ${name} expired **in the money** and settled for ${settled.payout.toLocaleString()} points (P/L ${formatSigned(settled.realized)}).`
                    : `📕 Your ${name} expired **worthless**. Max loss realized: ${p.costBasis.toLocaleString()} points.`);
            }
        }

        // Perpetual futures: funding rent and liquidation-price checks
        const perpsService = require('./perpsService');
        summary.perps = await perpsService.sweep({ guildId, now });
        for (const liquidated of summary.perps.liquidated) {
            await this._notify(liquidated.position.userId,
                `💥 Your ${liquidated.position.direction} perp on ${liquidated.position.symbol} was **liquidated** at $${liquidated.exitPrice.toFixed(2)} ` +
                `(entry $${liquidated.position.entryPrice.toFixed(2)}, ${liquidated.position.leverage}x). ` +
                `${liquidated.payout > 0 ? `${liquidated.payout.toLocaleString()} points of margin came back.` : 'The margin is gone.'}`);
        }

        summary.marketsSettled = await predictionService.settleDue({ guildId, now });
        summary.orders = await orderService.evaluate({ guildId, now });
        for (const { order, fill, price } of summary.orders.filled) {
            await this._notify(order.userId,
                `⚡ Your ${order.orderType.toLowerCase().replace('_', '-')} ${order.side.toLowerCase()} order on ${order.symbol} filled: ${fill.units} units @ $${price.toFixed(2)}.`);
        }
        for (const { order, reason } of summary.orders.rejected) {
            await this._notify(order.userId, `🚫 Your ${order.side.toLowerCase()} order on ${order.symbol} could not fill and was cancelled: ${reason}`);
        }

        const health = await this.checkMargin({ guildId, now });
        summary.marginCalls = health.calls;
        summary.liquidations = health.liquidations;
        return summary;
    }

    /**
     * Mark every risk-carrying account and act on the ones under water:
     * raise a margin call, then force-liquidate once the grace period has
     * elapsed (immediately when equity has gone negative - there is nothing
     * left to protect).
     */
    async checkMargin({ guildId, now = new Date() }) {
        const settings = await exchangeConfig.get(guildId);
        const calls = [];
        const liquidations = [];

        for (const userId of await accountService.activeAccounts(guildId)) {
            let snapshot;
            try {
                snapshot = await accountService.getSnapshot({ guildId, userId, now });
            } catch (error) {
                console.warn(`[Exchange] Could not mark account ${userId}:`, error.message);
                continue;
            }
            // A snapshot missing prices cannot justify selling somebody's
            // positions - wait for a tick with real marks.
            if (snapshot.pricingGaps > 0) continue;

            if (!snapshot.marginCall) {
                const { changed } = await accountService.setMarginCall({ guildId, userId, called: false, now });
                if (changed) {
                    await exchangeEvents.record({ guildId, userId, eventType: 'margin-call-cleared', amount: Math.round(snapshot.equity) });
                    await this._notify(userId, `✅ Margin call cleared. Equity ${Math.round(snapshot.equity).toLocaleString()} points against a ${Math.round(snapshot.maintenance).toLocaleString()} requirement.`);
                }
                continue;
            }

            const { changed, since } = await accountService.setMarginCall({ guildId, userId, called: true, now });
            const calledSince = since || (await accountService.getAccount(guildId, userId)).marginCallAt;
            if (changed) {
                await exchangeEvents.record({
                    guildId, userId, eventType: 'margin-call', amount: Math.round(snapshot.maintenance - snapshot.equity),
                    detail: { equity: Math.round(snapshot.equity), maintenance: Math.round(snapshot.maintenance) }
                });
                calls.push({ userId, snapshot });
                await this._notify(userId,
                    `🚨 **Margin call.** Equity ${Math.round(snapshot.equity).toLocaleString()} points is below the ${Math.round(snapshot.maintenance).toLocaleString()} maintenance requirement. ` +
                    `Add points, close positions, or repay your loan within ${settings.marginCallGraceMinutes} minutes - after that the exchange liquidates for you.`);
            }

            const elapsedMinutes = calledSince
                ? (now.getTime() - new Date(`${calledSince}Z`).getTime()) / 60_000
                : 0;
            const hopeless = snapshot.equity <= HOPELESS_EQUITY;
            if (!hopeless && elapsedMinutes < settings.marginCallGraceMinutes) continue;

            const result = await this.liquidate({ guildId, userId, snapshot, now, reason: hopeless ? 'negative-equity' : 'margin-call-expired' });
            if (result.closed.length > 0) liquidations.push(result);
        }

        return { calls, liquidations };
    }

    /**
     * Force-close enough exposure to bring an account back above its
     * maintenance requirement, then sweep the freed cash into the loan.
     * Largest positions go first; a still-broken account is flushed entirely
     * on the second pass.
     */
    async liquidate({ guildId, userId, snapshot = null, now = new Date(), reason = 'margin-call' }) {
        const settings = await exchangeConfig.get(guildId);
        let current = snapshot || await accountService.getSnapshot({ guildId, userId, now });
        const closed = [];

        for (let pass = 0; pass < MAX_LIQUIDATION_PASSES; pass++) {
            const shortfall = current.maintenance - current.equity;
            if (shortfall <= 0 && current.debt <= 0) break;

            const positions = [
                ...current.longs.filter(p => p.priced).map(p => ({ key: p.symbol, direction: 'LONG', value: p.value, units: p.units })),
                ...current.shorts.filter(p => p.priced).map(p => ({ key: p.symbol, direction: 'SHORT', value: p.value, units: p.units }))
            ];
            if (positions.length === 0) break;

            // Second pass: partial repair failed, so close everything left
            const plan = pass === 0
                ? marginMath.liquidationPlan({
                    positions, shortfall,
                    maintenanceMargin: settings.maintenanceMargin,
                    shortMaintenanceMargin: settings.shortMaintenanceMargin
                })
                : positions.map(position => ({ ...position, units: position.units }));
            if (plan.length === 0) break;

            for (const step of plan) {
                const units = Math.min(
                    step.units === undefined ? 0 : roundUnits(step.units),
                    roundUnits(positions.find(p => p.key === step.key && p.direction === step.direction)?.units ?? 0)
                );
                if (!(units > 0)) continue;
                try {
                    const fill = step.direction === 'LONG'
                        ? await stockPortfolioService.sell({ guildId, userId, symbol: step.key, units })
                        : await shortService.cover({ guildId, userId, symbol: step.key, units, now });
                    closed.push({ symbol: step.key, direction: step.direction, units, price: fill.price });
                    await exchangeEvents.record({
                        guildId, userId, eventType: 'liquidation', symbol: step.key,
                        amount: fill.proceeds ?? -(fill.cost ?? 0),
                        detail: { direction: step.direction, units, price: fill.price, reason }
                    });
                } catch (error) {
                    console.warn(`[Exchange] Liquidation of ${step.key} for ${userId} failed:`, error.message);
                }
            }

            current = await accountService.getSnapshot({ guildId, userId, now });
            if (!current.marginCall) break;
        }

        // Sweep whatever the sales raised into the loan
        let repaid = 0;
        const account = await accountService.getAccount(guildId, userId);
        if (account.marginLoan > 0) {
            const balance = await economyService.getBalance(guildId, userId);
            const amount = Math.min(account.marginLoan, balance);
            if (amount > 0) {
                repaid = (await accountService.repay({ guildId, userId, amount })).repaid;
            }
        }

        if (closed.length > 0) {
            await accountService.recordLiquidation({ guildId, userId });
            const after = await accountService.getSnapshot({ guildId, userId, now });
            await accountService.setMarginCall({ guildId, userId, called: after.marginCall, now });
            await this._notify(userId,
                `💥 **Forced liquidation.** The exchange closed ${closed.map(c => `${roundUnits(c.units)} ${c.symbol}`).join(', ')} ` +
                `${repaid > 0 ? `and repaid ${repaid.toLocaleString()} points of your loan ` : ''}` +
                `to restore your maintenance margin. Equity is now ${Math.round(after.equity).toLocaleString()} points. Reason: ${reason}.`);
        }

        return { closed, repaid, reason };
    }

    /** Best-effort DM. A user with DMs closed never blocks a settlement. */
    async _notify(userId, message) {
        if (!this.client || !userId) return;
        try {
            const user = await this.client.users.fetch(userId);
            await user.send(message);
        } catch {
            // Closed DMs are expected; the event log is the durable record
        }
    }
}

function formatSigned(value) {
    return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString()}`;
}

function roundUnits(value) {
    return Math.round(Number(value) * 10 ** 4) / 10 ** 4;
}

module.exports = RiskEngine;
module.exports.TICK_INTERVAL_MS = TICK_INTERVAL_MS;
