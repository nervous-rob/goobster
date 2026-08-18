const axios = require('axios');
const db = require('../db');

// Yahoo Finance public endpoints (keyless). All calls degrade gracefully:
// network failures surface as StockError('UNAVAILABLE') and cached data is
// used when it is fresh enough.
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const HTTP_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; GoobsterBot/1.0)' };
const HTTP_TIMEOUT_MS = 10_000;

// A quote snapshot younger than this is served from SQLite without hitting
// the network (the price checker refreshes when a user checks in).
const QUOTE_TTL_MINUTES = 5;

const HISTORY_RANGES = { '1mo': '1mo', '3mo': '3mo', '6mo': '6mo', '1y': '1y' };

/** User-presentable stock errors (code + friendly message). */
class StockError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'StockError';
        this.code = code;
    }
}

/**
 * Stock market data layer for the trading game: quote lookups with a
 * short-TTL SQLite cache, symbol search, and daily price history for graphs.
 * Every successful lookup grows the local symbol database (`stock_symbols`)
 * and records a price snapshot (`stock_prices`).
 */
class StockService {
    /**
     * Normalize a ticker like " aapl " -> "AAPL".
     * @throws {StockError} BAD_SYMBOL
     */
    normalizeSymbol(symbol) {
        const cleaned = String(symbol || '').trim().toUpperCase();
        if (!cleaned || cleaned.length > 12 || !/^[A-Z0-9.^=-]+$/.test(cleaned)) {
            throw new StockError('BAD_SYMBOL', `"${symbol}" doesn't look like a stock symbol.`);
        }
        return cleaned;
    }

    /**
     * Current quote for a symbol. Serves the cached snapshot when fresh,
     * otherwise fetches from Yahoo, upserts symbol metadata, and records a
     * new snapshot. On network failure, falls back to the last snapshot of
     * any age (flagged stale) before giving up.
     * @param {string} rawSymbol
     * @param {{maxAgeMinutes?: number}} [opts]
     * @returns {Promise<{symbol, name, price, currency, asOf, cached: boolean, stale: boolean}>}
     */
    async getQuote(rawSymbol, { maxAgeMinutes = QUOTE_TTL_MINUTES } = {}) {
        const symbol = this.normalizeSymbol(rawSymbol);

        const cached = this._latestSnapshot(symbol, maxAgeMinutes);
        if (cached) return { ...cached, cached: true, stale: false };

        try {
            const quote = await this._fetchQuote(symbol);
            this._recordQuote(quote);
            return { ...quote, cached: false, stale: false };
        } catch (error) {
            if (error instanceof StockError && error.code === 'UNKNOWN_SYMBOL') throw error;
            const last = this._latestSnapshot(symbol, null);
            if (last) return { ...last, cached: true, stale: true };
            throw error instanceof StockError
                ? error
                : new StockError('UNAVAILABLE', `Couldn't fetch a quote for ${symbol} right now.`);
        }
    }

    /**
     * Search for symbols by company name or ticker fragment. Matches are
     * added to the local symbol database.
     * @returns {Promise<Array<{symbol, name, exchange, quoteType}>>}
     */
    async search(query, limit = 5) {
        const q = String(query || '').trim();
        if (!q) return [];
        let data;
        try {
            ({ data } = await axios.get(SEARCH_URL, {
                params: { q, quotesCount: limit, newsCount: 0 },
                headers: HTTP_HEADERS,
                timeout: HTTP_TIMEOUT_MS
            }));
        } catch (error) {
            throw new StockError('UNAVAILABLE', 'Stock symbol search is unavailable right now.', { cause: error });
        }

        const results = (data?.quotes || [])
            .filter(item => item.symbol)
            .slice(0, limit)
            .map(item => ({
                symbol: item.symbol,
                name: item.longname || item.shortname || item.symbol,
                exchange: item.exchDisp || item.exchange || null,
                quoteType: item.quoteType || null
            }));

        for (const item of results) {
            db.run(
                `INSERT INTO stock_symbols (symbol, name, exchange, quoteType)
                 VALUES (@symbol, @name, @exchange, @quoteType)
                 ON CONFLICT(symbol) DO UPDATE SET
                     name = COALESCE(excluded.name, name),
                     exchange = COALESCE(excluded.exchange, exchange),
                     quoteType = COALESCE(excluded.quoteType, quoteType),
                     updatedAt = CURRENT_TIMESTAMP`,
                item
            );
        }
        return results;
    }

    /**
     * Daily closing prices for a range ('1mo'|'3mo'|'6mo'|'1y'), for the
     * historical graphs.
     * @returns {Promise<{symbol, currency, points: Array<{date: string, close: number}>}>}
     */
    async getHistory(rawSymbol, range = '3mo') {
        const symbol = this.normalizeSymbol(rawSymbol);
        const yahooRange = HISTORY_RANGES[range];
        if (!yahooRange) {
            throw new StockError('BAD_RANGE', `Range must be one of: ${Object.keys(HISTORY_RANGES).join(', ')}.`);
        }

        const result = await this._fetchChart(symbol, { range: yahooRange, interval: '1d' });
        const timestamps = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];
        const points = [];
        for (let i = 0; i < timestamps.length; i++) {
            if (closes[i] === null || closes[i] === undefined) continue;
            points.push({
                date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
                close: closes[i]
            });
        }
        if (points.length === 0) {
            throw new StockError('NO_DATA', `No price history available for ${symbol}.`);
        }
        return { symbol, currency: result.meta?.currency || null, points };
    }

    /**
     * Locally known symbol metadata (null when the symbol was never seen).
     */
    getSymbolInfo(rawSymbol) {
        const symbol = this.normalizeSymbol(rawSymbol);
        return db.get('SELECT symbol, name, exchange, currency, quoteType FROM stock_symbols WHERE symbol = @symbol', { symbol }) || null;
    }

    /** Latest stored snapshot, optionally bounded by age in minutes. */
    _latestSnapshot(symbol, maxAgeMinutes) {
        const ageFilter = maxAgeMinutes === null
            ? ''
            : `AND p.asOf > datetime('now', '-' || @maxAge || ' minutes')`;
        const row = db.get(
            `SELECT p.symbol, p.price, p.asOf, s.name, s.currency
             FROM stock_prices p LEFT JOIN stock_symbols s ON s.symbol = p.symbol
             WHERE p.symbol = @symbol ${ageFilter}
             ORDER BY p.id DESC LIMIT 1`,
            { symbol, maxAge: maxAgeMinutes }
        );
        if (!row) return null;
        return { symbol: row.symbol, name: row.name || row.symbol, price: row.price, currency: row.currency, asOf: row.asOf };
    }

    /** Fetch the chart payload for a symbol (also used for plain quotes). */
    async _fetchChart(symbol, params) {
        let data;
        try {
            ({ data } = await axios.get(`${CHART_URL}${encodeURIComponent(symbol)}`, {
                params,
                headers: HTTP_HEADERS,
                timeout: HTTP_TIMEOUT_MS,
                // Yahoo answers 404 with a JSON error body for unknown symbols
                validateStatus: status => status === 200 || status === 404
            }));
        } catch (error) {
            throw new StockError('UNAVAILABLE', `Couldn't reach the stock data service for ${symbol}.`, { cause: error });
        }
        const result = data?.chart?.result?.[0];
        if (!result || !result.meta) {
            throw new StockError('UNKNOWN_SYMBOL', `No stock found for symbol ${symbol}.`);
        }
        return result;
    }

    async _fetchQuote(symbol) {
        const result = await this._fetchChart(symbol, { range: '1d', interval: '1d' });
        const meta = result.meta;
        const price = meta.regularMarketPrice;
        if (!Number.isFinite(price) || price <= 0) {
            throw new StockError('NO_DATA', `No current price available for ${symbol}.`);
        }
        return {
            symbol: meta.symbol || symbol,
            name: meta.longName || meta.shortName || symbol,
            price,
            currency: meta.currency || null,
            exchange: meta.fullExchangeName || meta.exchangeName || null,
            quoteType: meta.instrumentType || null,
            asOf: new Date((meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000)
                .toISOString().replace('T', ' ').slice(0, 19)
        };
    }

    /** Upsert symbol metadata and record a price snapshot. */
    _recordQuote(quote) {
        db.transaction(() => {
            db.run(
                `INSERT INTO stock_symbols (symbol, name, exchange, currency, quoteType)
                 VALUES (@symbol, @name, @exchange, @currency, @quoteType)
                 ON CONFLICT(symbol) DO UPDATE SET
                     name = COALESCE(excluded.name, name),
                     exchange = COALESCE(excluded.exchange, exchange),
                     currency = COALESCE(excluded.currency, currency),
                     quoteType = COALESCE(excluded.quoteType, quoteType),
                     updatedAt = CURRENT_TIMESTAMP`,
                {
                    symbol: quote.symbol, name: quote.name, exchange: quote.exchange || null,
                    currency: quote.currency, quoteType: quote.quoteType || null
                }
            );
            db.run(
                `INSERT INTO stock_prices (symbol, price, asOf) VALUES (@symbol, @price, CURRENT_TIMESTAMP)`,
                { symbol: quote.symbol, price: quote.price }
            );
        });
    }
}

module.exports = new StockService();
module.exports.StockError = StockError;
module.exports.HISTORY_RANGES = Object.keys(HISTORY_RANGES);
