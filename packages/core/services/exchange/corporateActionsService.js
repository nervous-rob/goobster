const axios = require('axios');
const db = require('../../db');
const economyService = require('../economyService');
const accountService = require('./accountService');
const { toSqlTime } = require('./accountService');
const exchangeEvents = require('./exchangeEvents');

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const HTTP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; GoobsterBot/1.0)' };
const HTTP_TIMEOUT_MS = 10_000;
// A symbol's events are re-checked at most this often
const SWEEP_INTERVAL_HOURS = 20;

/**
 * Corporate actions from the REAL feed: cash dividends and stock splits, as
 * reported by the same keyless chart endpoint that prices everything else
 * (`events=div,splits`).
 *
 * Rules that keep this honest:
 *   - Every event is recorded once globally (`corporate_actions`) and applied
 *     exactly once across all guilds.
 *   - Events observed on a symbol's FIRST sweep are recorded WITHOUT being
 *     applied: they predate our knowledge of the symbol, and back-paying a
 *     month of dividends to positions that did not exist then would invent
 *     money.
 *   - Dividends: longs are paid (floor), shorts owe them (ceil, borrowed onto
 *     the margin loan when the wallet cannot pay) - short a stock through its
 *     ex-date and you pay the dividend, like everywhere real.
 *   - Splits: stock units, short units, option strikes/premiums, resting
 *     order prices, and event-contract thresholds are all adjusted so nobody
 *     gains or loses a point from bookkeeping. Total cost bases are
 *     unchanged - a split moves decimal points, not value.
 */
class CorporateActionsService {
    /** Fetch dividends and splits for one symbol from the live feed. */
    async fetchEvents(symbol, { range = '1mo' } = {}) {
        const { data } = await axios.get(`${CHART_URL}${encodeURIComponent(symbol)}`, {
            params: { range, interval: '1d', events: 'div,splits' },
            headers: HTTP_HEADERS,
            timeout: HTTP_TIMEOUT_MS
        });
        const events = data?.chart?.result?.[0]?.events || {};
        const dividends = Object.values(events.dividends || {})
            .filter(event => Number.isFinite(event.amount) && event.amount > 0)
            .map(event => ({ date: dateKey(event.date), amount: event.amount }));
        const splits = Object.values(events.splits || {})
            .filter(event => event.numerator > 0 && event.denominator > 0)
            .map(event => ({ date: dateKey(event.date), ratio: event.numerator / event.denominator }));
        return { dividends, splits };
    }

    /** Symbols anybody holds, is short, or has paper against. */
    async trackedSymbols() {
        return (await db.all(
            `SELECT DISTINCT symbol FROM (
                 SELECT symbol FROM stock_holdings
                 UNION SELECT symbol FROM short_positions
                 UNION SELECT underlying AS symbol FROM option_positions WHERE status = 'OPEN'
             ) WHERE symbol NOT LIKE '^%'`
        )).map(row => row.symbol);
    }

    /**
     * The engine pass: check every tracked symbol (at most once per
     * SWEEP_INTERVAL_HOURS) and apply anything new.
     * @returns {Promise<{checked: number, applied: Array}>}
     */
    async sweep({ now = new Date() } = {}) {
        const applied = [];
        let checked = 0;

        for (const symbol of await this.trackedSymbols()) {
            const meta = await db.get(
                'SELECT corporateCheckedAt FROM stock_symbols WHERE symbol = @symbol', { symbol }
            );
            const lastChecked = meta?.corporateCheckedAt ? new Date(`${meta.corporateCheckedAt}Z`) : null;
            if (lastChecked && (now.getTime() - lastChecked.getTime()) / 3_600_000 < SWEEP_INTERVAL_HOURS) continue;

            checked++;
            let events;
            try {
                events = await this.fetchEvents(symbol);
            } catch (error) {
                console.warn(`[Exchange] Corporate-action check failed for ${symbol}:`, error.message);
                continue;
            }

            // First sweep: record history as already-processed, apply nothing
            const firstSweep = !lastChecked;
            for (const dividend of events.dividends) {
                const inserted = await this._recordEvent({ symbol, actionType: 'DIVIDEND', eventDate: dividend.date, value: dividend.amount, apply: !firstSweep });
                if (inserted && !firstSweep) {
                    applied.push({ symbol, type: 'DIVIDEND', ...dividend, ...await this.applyDividend({ symbol, amount: dividend.amount, date: dividend.date }) });
                }
            }
            for (const split of events.splits) {
                const inserted = await this._recordEvent({ symbol, actionType: 'SPLIT', eventDate: split.date, value: split.ratio, apply: !firstSweep });
                if (inserted && !firstSweep) {
                    applied.push({ symbol, type: 'SPLIT', ...split, ...await this.applySplit({ symbol, ratio: split.ratio, date: split.date }) });
                }
            }

            await db.run(
                `INSERT INTO stock_symbols (symbol, corporateCheckedAt) VALUES (@symbol, @stamp)
                 ON CONFLICT(symbol) DO UPDATE SET corporateCheckedAt = @stamp`,
                { symbol, stamp: toSqlTime(now) }
            );
        }
        return { checked, applied };
    }

    /** Record an event once; returns true when it is new. */
    async _recordEvent({ symbol, actionType, eventDate, value, apply }) {
        return (await db.run(
            `INSERT INTO corporate_actions (symbol, actionType, eventDate, value, applied)
             VALUES (@symbol, @actionType, @eventDate, @value, @applied)
             ON CONFLICT(symbol, actionType, eventDate) DO NOTHING`,
            { symbol, actionType, eventDate, value, applied: apply ? 1 : 0 }
        )).changes > 0;
    }

    /**
     * Pay a dividend to every long and collect it from every short, across
     * all guilds.
     */
    async applyDividend({ symbol, amount, date }) {
        let paid = 0;
        let collected = 0;

        for (const holding of await db.all('SELECT guildId, userId, units FROM stock_holdings WHERE symbol = @symbol', { symbol })) {
            const points = Math.floor(holding.units * amount);
            if (points <= 0) continue;
            await economyService.adjust({
                guildId: holding.guildId, userId: holding.userId, amount: points,
                type: 'dividend', detail: JSON.stringify({ symbol, perShare: amount, units: holding.units, date })
            });
            await exchangeEvents.record({
                guildId: holding.guildId, userId: holding.userId, eventType: 'dividend',
                symbol, amount: points, detail: { perShare: amount, units: holding.units, date }
            });
            paid += points;
        }

        for (const short of await db.all('SELECT guildId, userId, units FROM short_positions WHERE symbol = @symbol', { symbol })) {
            const points = Math.ceil(short.units * amount);
            if (points <= 0) continue;
            const balance = await economyService.getBalance(short.guildId, short.userId);
            if (balance < points) {
                // Shorts only exist on margin accounts; the obligation lands
                // on the loan when the wallet cannot pay it
                try {
                    await accountService.borrow({
                        guildId: short.guildId, userId: short.userId,
                        amount: points - balance, reason: `dividend owed on short ${symbol}`
                    });
                } catch (error) {
                    console.warn(`[Exchange] Could not finance short dividend for ${short.userId}:`, error.message);
                    continue;
                }
            }
            await economyService.adjust({
                guildId: short.guildId, userId: short.userId, amount: -points,
                type: 'dividend-short', detail: JSON.stringify({ symbol, perShare: amount, units: short.units, date })
            });
            await exchangeEvents.record({
                guildId: short.guildId, userId: short.userId, eventType: 'dividend-short',
                symbol, amount: -points, detail: { perShare: amount, units: short.units, date }
            });
            collected += points;
        }
        return { paid, collected };
    }

    /**
     * Apply a split everywhere a price or a unit count references the symbol.
     * Ratio 2 = 2-for-1 (units double, prices halve); 0.5 = 1-for-2 reverse.
     */
    async applySplit({ symbol, ratio, date }) {
        const counts = await db.transaction(async () => {
            const holdings = (await db.run(
                `UPDATE stock_holdings SET units = ROUND(units * @ratio, 4), updatedAt = CURRENT_TIMESTAMP
                 WHERE symbol = @symbol`,
                { symbol, ratio }
            )).changes;
            const shorts = (await db.run(
                `UPDATE short_positions SET units = ROUND(units * @ratio, 4),
                     avgPrice = avgPrice / @ratio, updatedAt = CURRENT_TIMESTAMP
                 WHERE symbol = @symbol`,
                { symbol, ratio }
            )).changes;
            // Whole ratios multiply contract count (the OCC way); fractional
            // ratios adjust the deliverable size instead
            const wholeRatio = Number.isInteger(ratio);
            const options = (await db.run(
                `UPDATE option_positions SET
                     strike = strike / @ratio,
                     openPremium = openPremium / @ratio,
                     contracts = CASE WHEN @whole THEN CAST(contracts * @ratio AS INTEGER) ELSE contracts END,
                     contractSize = CASE WHEN @whole THEN contractSize ELSE CAST(ROUND(contractSize * @ratio) AS INTEGER) END,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE underlying = @symbol AND status = 'OPEN'`,
                { symbol, ratio, whole: wholeRatio ? 1 : 0 }
            )).changes;
            const orders = (await db.run(
                `UPDATE exchange_orders SET
                     units = ROUND(units * @ratio, 4),
                     limitPrice = CASE WHEN limitPrice IS NULL THEN NULL ELSE limitPrice / @ratio END,
                     stopPrice = CASE WHEN stopPrice IS NULL THEN NULL ELSE stopPrice / @ratio END,
                     trailAnchor = CASE WHEN trailAnchor IS NULL THEN NULL ELSE trailAnchor / @ratio END,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE symbol = @symbol AND status IN ('OPEN', 'TRIGGERED')`,
                { symbol, ratio }
            )).changes;
            const markets = (await db.run(
                `UPDATE prediction_markets SET threshold = threshold / @ratio, updatedAt = CURRENT_TIMESTAMP
                 WHERE symbol = @symbol AND status IN ('OPEN', 'CLOSED')`,
                { symbol, ratio }
            )).changes;
            const perps = (await db.run(
                `UPDATE perp_positions SET
                     units = units * @ratio,
                     entryPrice = entryPrice / @ratio,
                     liquidationPrice = liquidationPrice / @ratio,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE symbol = @symbol AND status = 'OPEN'`,
                { symbol, ratio }
            )).changes;
            return { holdings, shorts, options, orders, markets, perps };
        });

        // One event per guild that held anything through the split
        const guilds = await db.all(
            `SELECT DISTINCT guildId FROM (
                 SELECT guildId FROM stock_holdings WHERE symbol = @symbol
                 UNION SELECT guildId FROM short_positions WHERE symbol = @symbol
                 UNION SELECT guildId FROM option_positions WHERE underlying = @symbol AND status = 'OPEN'
             )`,
            { symbol }
        );
        for (const { guildId } of guilds) {
            await exchangeEvents.record({
                guildId, eventType: 'stock-split', symbol,
                detail: { ratio, date, adjusted: counts }
            });
        }
        return counts;
    }
}

function dateKey(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

module.exports = new CorporateActionsService();
