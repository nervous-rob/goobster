/**
 * Web exchange terminal: the browser façade over the stock game and the
 * Jimbucks Exchange. Every method verifies live guild membership first
 * (utils/webGuildAccess), then delegates to the SAME services the slash
 * commands use - stockPortfolioService, shortService, optionsService,
 * orderService, auditService - so every invariant they enforce (all point
 * movement through economyService.adjust, feature gates, margin
 * requirements, ledger completeness) holds for web trades by construction.
 *
 * Domain errors (ExchangeError / StockError / EconomyError) carry a
 * machine-readable code and a user-presentable message; they are translated
 * to 400s here so the API layer can surface them directly.
 */

const economyService = require('./economyService');
const stockService = require('./stockService');
const stockPortfolioService = require('./stockPortfolioService');
const exchangeConfig = require('./exchange/exchangeConfig');
const shortService = require('./exchange/shortService');
const optionsService = require('./exchange/optionsService');
const optionsMarket = require('./exchange/optionsMarket');
const orderService = require('./exchange/orderService');
const auditService = require('./exchange/auditService');
const { requireGuildMember } = require('../utils/webGuildAccess');

/** Machine-readable web exchange error (HTTP status + code). */
class WebExchangeError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebExchangeError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Translate a domain error (code + friendly message, no HTTP status) into a
 * 400 the routes can surface; anything already carrying a status passes
 * through, and unknown errors keep bubbling to the 500 handler.
 */
function translate(error) {
    if (error?.status && error?.code) return error;
    if (error?.code && error?.message) {
        return new WebExchangeError(400, error.code, error.message);
    }
    return error;
}

const STOCK_SIDES = new Set(['buy', 'sell', 'short', 'cover']);
const OPTION_ACTIONS = new Set(['buy', 'close', 'write', 'buyback']);

class WebExchangeService {
    /**
     * The portfolio view: full account audit (positions, greeks, equity,
     * buying power, liquidation levels, risk flags, recent ledger) plus the
     * guild's exchange feature flags, so the UI knows what to offer.
     * @param {Object} params - { client, guildId, userId }
     */
    async overview({ client, guildId, userId }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            const audit = await auditService.auditAccount({ guildId, userId });
            const settings = await exchangeConfig.get(guildId);
            return {
                currencyName: audit.currencyName,
                features: {
                    marginEnabled: settings.marginEnabled,
                    optionsEnabled: settings.optionsEnabled,
                    zeroDteEnabled: settings.zeroDteEnabled,
                    predictionsEnabled: settings.predictionsEnabled,
                    futuresEnabled: settings.futuresEnabled
                },
                audit
            };
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * A live quote plus the caller's exposure to the symbol.
     * @param {Object} params - { client, guildId, userId, symbol }
     */
    async quote({ client, guildId, userId, symbol }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            const quote = await stockService.getQuote(symbol);
            return {
                quote,
                holding: await stockPortfolioService.getHolding({ guildId, userId, symbol: quote.symbol }),
                shortPosition: await shortService.getPosition({ guildId, userId, symbol: quote.symbol }),
                balance: await economyService.getBalance(guildId, userId),
                currencyName: (await economyService.getSettings(guildId)).currencyName
            };
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * Daily close history for the chart.
     * @param {Object} params - { client, guildId, userId, symbol, range }
     */
    async history({ client, guildId, userId, symbol, range = '3mo' }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            return await stockService.getHistory(symbol, range);
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * Symbol search (grows the local indicator database as a side effect).
     * @param {Object} params - { client, guildId, userId, query }
     */
    async search({ client, guildId, userId, query }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            return await stockService.search(String(query || '').slice(0, 50));
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * A stock trade: buy / sell (longs) or short / cover (margin feature,
     * gated by the underlying service).
     * @param {Object} params - { client, guildId, userId, side, symbol, units }
     */
    async tradeStock({ client, guildId, userId, side, symbol, units }) {
        await requireGuildMember({ client, guildId, userId });
        const normalizedSide = String(side || '').toLowerCase();
        if (!STOCK_SIDES.has(normalizedSide)) {
            throw new WebExchangeError(400, 'BAD_SIDE', 'Side must be buy, sell, short, or cover.');
        }
        // sell/cover accept null units = "the whole position"
        const amount = units === null || units === undefined || units === '' ? null : Number(units);
        try {
            if (normalizedSide === 'buy') {
                return await stockPortfolioService.buy({ guildId, userId, symbol, units: amount });
            }
            if (normalizedSide === 'sell') {
                return await stockPortfolioService.sell({ guildId, userId, symbol, units: amount });
            }
            if (normalizedSide === 'short') {
                return await shortService.openShort({ guildId, userId, symbol, units: amount });
            }
            return await shortService.cover({ guildId, userId, symbol, units: amount });
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * The simulated option chain for a symbol + expiry.
     * @param {Object} params - { client, guildId, userId, symbol, expiry }
     */
    async chain({ client, guildId, userId, symbol, expiry = null }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            await exchangeConfig.requireFeature(guildId, 'optionsEnabled', 'Options trading');
            return await optionsMarket.buildChain({ symbol, expiry, guildId });
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * An option trade. Long side (cash): buy / close. Written side (margin,
     * enforced by optionsService): write / buyback.
     * @param {Object} params - { client, guildId, userId, action,
     *                            symbol?, optionType?, strike?, expiry?, contracts?, positionId? }
     */
    async tradeOption({ client, guildId, userId, action, symbol, optionType, strike, expiry, contracts, positionId }) {
        await requireGuildMember({ client, guildId, userId });
        const normalized = String(action || '').toLowerCase();
        if (!OPTION_ACTIONS.has(normalized)) {
            throw new WebExchangeError(400, 'BAD_ACTION', 'Action must be buy, close, write, or buyback.');
        }
        try {
            if (normalized === 'buy' || normalized === 'write') {
                const params = {
                    guildId, userId, symbol,
                    optionType: String(optionType || '').toUpperCase(),
                    strike: Number(strike),
                    expiry: String(expiry || ''),
                    contracts: Number(contracts)
                };
                return normalized === 'buy'
                    ? await optionsService.buyToOpen(params)
                    : await optionsService.sellToOpen(params);
            }
            const closeParams = {
                guildId, userId,
                positionId: Number(positionId),
                contracts: contracts === null || contracts === undefined || contracts === '' ? null : Number(contracts)
            };
            return normalized === 'close'
                ? await optionsService.sellToClose(closeParams)
                : await optionsService.buyToClose(closeParams);
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * Working resting orders.
     * @param {Object} params - { client, guildId, userId }
     */
    async listOrders({ client, guildId, userId }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            return await orderService.list({ guildId, userId, status: 'all', limit: 25 });
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * Place a resting order (limit / stop / stop-limit / trailing stop).
     * @param {Object} params - { client, guildId, userId, symbol, side,
     *                            orderType, units, limitPrice?, stopPrice?, trailPercent? }
     */
    async placeOrder({ client, guildId, userId, symbol, side, orderType, units, limitPrice, stopPrice, trailPercent }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            return await orderService.place({
                guildId, userId, symbol, side, orderType, units,
                limitPrice: limitPrice || null,
                stopPrice: stopPrice || null,
                trailPercent: trailPercent || null
            });
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * Cancel one of the caller's own working orders.
     * @param {Object} params - { client, guildId, userId, orderId }
     */
    async cancelOrder({ client, guildId, userId, orderId }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            return await orderService.cancel({ guildId, userId, id: Number(orderId) });
        } catch (error) {
            throw translate(error);
        }
    }

    /**
     * The guild's equity leaderboard, with display names resolved
     * best-effort through the guild.
     * @param {Object} params - { client, guildId, userId }
     */
    async leaderboard({ client, guildId, userId }) {
        await requireGuildMember({ client, guildId, userId });
        try {
            const rows = await auditService.leaderboard({ guildId, limit: 15 });
            const guild = client.guilds.cache.get(guildId);
            const named = await Promise.all(rows.map(async (row) => {
                let name = null;
                try {
                    const member = await guild.members.fetch(row.userId);
                    name = member.displayName || member.user?.username || null;
                } catch { /* left the server or unfetchable - id-only row */ }
                return { ...row, name, isBot: row.userId === client.user?.id };
            }));
            return {
                currencyName: (await economyService.getSettings(guildId)).currencyName,
                rows: named
            };
        } catch (error) {
            throw translate(error);
        }
    }
}

module.exports = new WebExchangeService();
module.exports.WebExchangeError = WebExchangeError;
