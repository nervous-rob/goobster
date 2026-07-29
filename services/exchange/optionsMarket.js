const db = require('../../db');
const stockService = require('../stockService');
const { StockError } = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const { riskFreeRate } = require('./exchangeConfig');
const optionsMath = require('./optionsMath');
const { ExchangeError } = require('./errors');

// Contracts settle against the 16:00 America/New_York close, which is 20:00
// UTC for most of the year. The game uses a fixed UTC hour so an expiry is a
// single unambiguous instant everywhere.
const EXPIRY_HOUR_UTC = 20;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// A contract in its final minutes still has *some* time value; without a floor
// the pricer would divide by zero right at the bell.
const MIN_TIME_YEARS = 1 / (365 * 24 * 60);

const CONTRACT_SIZE = 100;
const DEFAULT_VOL = 0.35;
const MIN_VOL = 0.05;
const MAX_VOL = 4;
const VOL_CACHE_HOURS = 12;

// Index tickers people actually say out loud, mapped to the Yahoo symbols that
// quote them. Index options are cash-settled, which is exactly how every
// contract in this game settles anyway.
const INDEX_ALIASES = Object.freeze({
    SPX: '^GSPC',
    SPXW: '^GSPC',
    NDX: '^NDX',
    RUT: '^RUT',
    VIX: '^VIX',
    DJX: '^DJI',
    DJI: '^DJI'
});

const MIN_PREMIUM = 0.01;

/** Round to a fixed number of decimals without float dust. */
function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/** UTC date key (YYYY-MM-DD) for a Date. */
function dateKey(date) {
    return date.toISOString().slice(0, 10);
}

/** The exact settlement instant of an expiry date. */
function expiryInstant(expiry) {
    const [year, month, day] = String(expiry).split('-').map(Number);
    if (!year || !month || !day) {
        throw new ExchangeError('BAD_EXPIRY', `"${expiry}" is not a valid expiry date (use YYYY-MM-DD).`);
    }
    return new Date(Date.UTC(year, month - 1, day, EXPIRY_HOUR_UTC, 0, 0));
}

function isWeekend(date) {
    const day = date.getUTCDay();
    return day === 0 || day === 6;
}

/**
 * Simulated option market: volatility estimation, the expiry calendar, strike
 * ladders, and premium quotes.
 *
 * Premiums are Black-Scholes values off the REAL underlying price with a
 * volatility smile and a house spread - they are clearly labelled simulated
 * everywhere they surface, because no keyless real chain exists.
 */
class OptionsMarket {
    /**
     * Resolve a spoken ticker to the symbol the quote feed knows.
     * @returns {{symbol: string, alias: string|null, isIndex: boolean}}
     */
    resolveUnderlying(rawSymbol) {
        const requested = stockService.normalizeSymbol(rawSymbol);
        const mapped = INDEX_ALIASES[requested];
        return {
            symbol: mapped || requested,
            alias: mapped ? requested : null,
            isIndex: !!mapped || requested.startsWith('^')
        };
    }

    /** Display label for a resolved underlying ("SPX (^GSPC)"). */
    label(resolved) {
        return resolved.alias ? `${resolved.alias} (${resolved.symbol})` : resolved.symbol;
    }

    /** Years until settlement, floored so a 0DTE contract stays priceable. */
    timeToExpiry(expiry, now = new Date()) {
        const ms = expiryInstant(expiry).getTime() - now.getTime();
        return Math.max(MIN_TIME_YEARS, ms / YEAR_MS);
    }

    /** True once the settlement instant has passed. */
    hasExpired(expiry, now = new Date()) {
        return now.getTime() >= expiryInstant(expiry).getTime();
    }

    /** True when the contract expires on today's date (the 0DTE gate). */
    isZeroDte(expiry, now = new Date()) {
        return String(expiry) === dateKey(now);
    }

    /**
     * Annualized volatility for a symbol: cached per symbol, recomputed from
     * three months of daily closes at most twice a day. Falls back to a
     * middling default when history is unavailable, so a feed outage degrades
     * the *precision* of a quote rather than blocking the trade.
     * @returns {Promise<{vol: number, source: 'realized'|'cached'|'default'}>}
     */
    async getVolatility(symbol, { now = new Date() } = {}) {
        const cached = db.get(
            'SELECT impliedVol, ivUpdatedAt FROM stock_symbols WHERE symbol = @symbol',
            { symbol }
        );
        if (cached?.impliedVol > 0 && cached.ivUpdatedAt) {
            const ageHours = (now.getTime() - new Date(`${cached.ivUpdatedAt}Z`).getTime()) / 3_600_000;
            if (Number.isFinite(ageHours) && ageHours < VOL_CACHE_HOURS) {
                return { vol: cached.impliedVol, source: 'cached' };
            }
        }

        let vol = null;
        try {
            const history = await stockService.getHistory(symbol, '3mo');
            vol = optionsMath.realizedVolatility(history.points.map(point => point.close));
        } catch (error) {
            if (error instanceof StockError && error.code === 'UNKNOWN_SYMBOL') throw error;
        }

        if (!vol) {
            if (cached?.impliedVol > 0) return { vol: cached.impliedVol, source: 'cached' };
            return { vol: DEFAULT_VOL, source: 'default' };
        }

        const clamped = Math.min(MAX_VOL, Math.max(MIN_VOL, vol));
        db.run(
            `INSERT INTO stock_symbols (symbol, impliedVol, ivUpdatedAt)
             VALUES (@symbol, @vol, CURRENT_TIMESTAMP)
             ON CONFLICT(symbol) DO UPDATE SET
                 impliedVol = excluded.impliedVol,
                 ivUpdatedAt = CURRENT_TIMESTAMP`,
            { symbol, vol: clamped }
        );
        return { vol: clamped, source: 'realized' };
    }

    /**
     * The volatility smile: out-of-the-money contracts trade richer than
     * at-the-money ones, and the very front of the curve is elevated because
     * a day of news is a bigger fraction of a day than of a quarter. Both are
     * real market behaviour, and both are what make 0DTE premiums expensive.
     */
    smiledVol({ baseVol, spot, strike, timeYears }) {
        const moneyness = Math.abs(Math.log(strike / spot));
        const smile = 1 + Math.min(1.5, 3.2 * moneyness);
        const days = timeYears * 365;
        const termBump = days < 7 ? 1 + 0.45 * (1 - days / 7) : 1;
        return Math.min(MAX_VOL, Math.max(MIN_VOL, baseVol * smile * termBump));
    }

    /**
     * Half the bid/ask spread as a fraction of mid. Wider on same-day and
     * cheap contracts: the house is the only counterparty, and lottery tickets
     * cost more to write than they look.
     */
    halfSpread({ timeYears, mid, spot }) {
        const days = timeYears * 365;
        let spread = 0.02;
        if (days < 1) spread += 0.05;
        else if (days < 7) spread += 0.02;
        if (mid < 0.05 * spot * 0.02) spread += 0.03;
        return Math.min(0.25, spread);
    }

    /**
     * Price one contract. Returns the full trader-facing picture: mid/bid/ask
     * premium per share, the greeks, break-even, and the probabilities.
     * @param {{symbol, optionType, strike, expiry, guildId?, now?, quote?}} params
     */
    async quoteContract({ symbol, optionType, strike, expiry, guildId = null, now = new Date(), quote = null }) {
        const type = String(optionType || '').toUpperCase();
        if (type !== 'CALL' && type !== 'PUT') {
            throw new ExchangeError('BAD_OPTION_TYPE', 'Option type must be CALL or PUT.');
        }
        const strikePrice = Number(strike);
        if (!Number.isFinite(strikePrice) || strikePrice <= 0) {
            throw new ExchangeError('BAD_STRIKE', 'Strike must be a positive number.');
        }

        const resolved = this.resolveUnderlying(symbol);
        const underlyingQuote = quote || await stockService.getQuote(resolved.symbol);
        if (underlyingQuote.currency && underlyingQuote.currency !== 'USD') {
            throw new ExchangeError('NOT_USD', `${resolved.symbol} trades in ${underlyingQuote.currency}; only USD-quoted underlyings have contracts (1 point = $1).`);
        }

        const spot = underlyingQuote.price;
        const timeYears = this.timeToExpiry(expiry, now);
        const { vol: baseVol, source: volSource } = await this.getVolatility(resolved.symbol, { now });
        const vol = this.smiledVol({ baseVol, spot, strike: strikePrice, timeYears });
        const rate = riskFreeRate(guildId ? exchangeConfig.get(guildId) : exchangeConfig.DEFAULTS);

        const theoretical = optionsMath.price({ spot, strike: strikePrice, timeYears, vol, rate, optionType: type });
        const intrinsic = optionsMath.intrinsicValue({ spot, strike: strikePrice, optionType: type });
        const mid = Math.max(MIN_PREMIUM, theoretical, intrinsic);
        const half = this.halfSpread({ timeYears, mid, spot });
        const ask = round(Math.max(mid * (1 + half), mid + MIN_PREMIUM), 2);
        const bid = round(Math.max(MIN_PREMIUM, Math.min(mid * (1 - half), mid - MIN_PREMIUM)), 2);

        const contractGreeks = optionsMath.greeks({ spot, strike: strikePrice, timeYears, vol, rate, optionType: type });
        return {
            underlying: resolved.symbol,
            underlyingAlias: resolved.alias,
            underlyingName: underlyingQuote.name,
            isIndex: resolved.isIndex,
            optionType: type,
            strike: strikePrice,
            expiry,
            spot,
            asOf: underlyingQuote.asOf,
            stale: !!underlyingQuote.stale,
            contractSize: CONTRACT_SIZE,
            timeYears,
            daysToExpiry: round(timeYears * 365, 3),
            zeroDte: this.isZeroDte(expiry, now),
            iv: round(vol, 4),
            volSource,
            mid: round(mid, 2),
            bid,
            ask,
            intrinsic: round(intrinsic, 2),
            extrinsic: round(Math.max(0, mid - intrinsic), 2),
            greeks: {
                delta: round(contractGreeks.delta, 4),
                gamma: round(contractGreeks.gamma, 6),
                theta: round(contractGreeks.theta, 4),
                vega: round(contractGreeks.vega, 4),
                rho: round(contractGreeks.rho, 4)
            },
            breakEven: round(optionsMath.breakEven({ strike: strikePrice, premium: ask, optionType: type }), 2),
            probabilityItm: round(optionsMath.probabilityItm({ spot, strike: strikePrice, timeYears, vol, rate, optionType: type }), 4),
            probabilityOfProfit: round(optionsMath.probabilityOfProfit({
                spot, strike: strikePrice, premium: ask, timeYears, vol, rate, optionType: type
            }), 4),
            // Cost/credit of one contract in points, with the game's
            // house-favouring rounding (buys up, sells down)
            costPerContract: Math.ceil(ask * CONTRACT_SIZE),
            creditPerContract: Math.floor(bid * CONTRACT_SIZE),
            simulated: true
        };
    }

    /** Strike spacing that keeps a chain readable at any price level. */
    strikeIncrement(spot) {
        if (spot < 5) return 0.5;
        if (spot < 25) return 1;
        if (spot < 100) return 2.5;
        if (spot < 400) return 5;
        if (spot < 1200) return 10;
        if (spot < 4000) return 25;
        return 50;
    }

    /** A ladder of strikes centred on the money. */
    strikeLadder(spot, depth = 5) {
        const increment = this.strikeIncrement(spot);
        const atm = Math.round(spot / increment) * increment;
        const strikes = [];
        for (let i = -depth; i <= depth; i++) {
            const strike = round(atm + i * increment, 4);
            if (strike > 0) strikes.push(strike);
        }
        return strikes;
    }

    /**
     * The expiry calendar: every remaining weekday this week (same-day first),
     * then the next four Fridays, then two monthly third-Fridays. Weekend
     * dates are skipped - the underlying does not print a close on Saturday.
     * @returns {Array<{expiry: string, days: number, zeroDte: boolean, label: string}>}
     */
    listExpiries({ now = new Date(), limit = 8 } = {}) {
        const candidates = new Set();
        const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        for (let i = 0; i < 5; i++) {
            const day = new Date(today.getTime() + i * 86_400_000);
            if (!isWeekend(day)) candidates.add(dateKey(day));
        }
        for (let i = 0; i < 35; i++) {
            const day = new Date(today.getTime() + i * 86_400_000);
            if (day.getUTCDay() === 5) candidates.add(dateKey(day));
        }
        for (let monthOffset = 0; monthOffset <= 2; monthOffset++) {
            const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
            let fridays = 0;
            for (let day = 1; day <= 31; day++) {
                const candidate = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day));
                if (candidate.getUTCMonth() !== monthStart.getUTCMonth()) break;
                if (candidate.getUTCDay() !== 5) continue;
                if (++fridays === 3) {
                    if (candidate.getTime() >= today.getTime()) candidates.add(dateKey(candidate));
                    break;
                }
            }
        }

        return [...candidates]
            .filter(expiry => !this.hasExpired(expiry, now))
            .sort()
            .slice(0, limit)
            .map(expiry => {
                const days = this.timeToExpiry(expiry, now) * 365;
                const zeroDte = this.isZeroDte(expiry, now);
                return {
                    expiry,
                    days: round(days, 2),
                    zeroDte,
                    label: zeroDte ? '0DTE (today)' : `${Math.ceil(days)}d`
                };
            });
    }

    /**
     * A full option chain for one expiry: calls and puts across a strike
     * ladder, priced in a single pass off one underlying quote.
     */
    async buildChain({ symbol, expiry = null, depth = 5, guildId = null, now = new Date() }) {
        const resolved = this.resolveUnderlying(symbol);
        const quote = await stockService.getQuote(resolved.symbol);
        const expiries = this.listExpiries({ now });
        if (expiries.length === 0) {
            throw new ExchangeError('NO_EXPIRIES', 'No tradable expiries are available right now.');
        }
        const chosen = expiry || expiries[0].expiry;
        if (this.hasExpired(chosen, now)) {
            throw new ExchangeError('EXPIRED', `${chosen} has already settled - pick a later expiry.`);
        }

        const strikes = this.strikeLadder(quote.price, depth);
        const rows = [];
        for (const strike of strikes) {
            const [call, put] = await Promise.all([
                this.quoteContract({ symbol: resolved.symbol, optionType: 'CALL', strike, expiry: chosen, guildId, now, quote }),
                this.quoteContract({ symbol: resolved.symbol, optionType: 'PUT', strike, expiry: chosen, guildId, now, quote })
            ]);
            rows.push({ strike, call, put });
        }

        return {
            underlying: resolved.symbol,
            underlyingAlias: resolved.alias,
            label: this.label(resolved),
            name: quote.name,
            spot: quote.price,
            asOf: quote.asOf,
            stale: !!quote.stale,
            expiry: chosen,
            zeroDte: this.isZeroDte(chosen, now),
            expiries,
            rows,
            simulated: true
        };
    }
}

module.exports = new OptionsMarket();
module.exports.CONTRACT_SIZE = CONTRACT_SIZE;
module.exports.EXPIRY_HOUR_UTC = EXPIRY_HOUR_UTC;
module.exports.INDEX_ALIASES = INDEX_ALIASES;
module.exports.expiryInstant = expiryInstant;
module.exports.dateKey = dateKey;
