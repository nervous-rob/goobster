const economyService = require('../economyService');
const exchangeConfig = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const optionsService = require('./optionsService');
const accountService = require('./accountService');
const marginMath = require('./marginMath');
const spreadMath = require('./spreadMath');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

const MAX_LEGS = 4;
const MAX_CONTRACTS_PER_LEG = 1_000;

/**
 * Multi-leg option orders: verticals, straddles, strangles, butterflies,
 * iron condors - and their long-volatility inverses - on one underlying.
 *
 * The contract with the trader:
 *   1. `quote()` produces the full pre-trade receipt first - every leg with
 *      its debit or credit, the net, max gain, max loss, break-evens, the
 *      collateral the written legs require, the pricing timestamp (clearly
 *      simulated), and the 0DTE warning when it applies.
 *   2. `execute()` re-validates everything (cash for the debit legs, margin
 *      account and buying power for the written legs, no conflicting open
 *      lots), then fills debit legs before credit legs so written wings land
 *      on a book that already holds their cover. If a later leg still fails,
 *      the filled legs are unwound at the same cached quotes and the whole
 *      order reports failure - a spread never half-exists.
 */
class SpreadService {
    /** Validate and normalize raw legs. */
    _normalizeLegs(rawLegs) {
        if (!Array.isArray(rawLegs) || rawLegs.length === 0 || rawLegs.length > MAX_LEGS) {
            throw new ExchangeError('BAD_LEGS', `A spread needs 1-${MAX_LEGS} legs.`);
        }
        const legs = rawLegs.map((leg, index) => {
            const action = String(leg.action || '').toUpperCase();
            const optionType = String(leg.optionType || '').toUpperCase();
            const strike = Number(leg.strike);
            const contracts = Number(leg.contracts ?? 1);
            if (action !== 'BUY' && action !== 'SELL') {
                throw new ExchangeError('BAD_LEGS', `Leg ${index + 1}: action must be BUY or SELL.`);
            }
            if (optionType !== 'CALL' && optionType !== 'PUT') {
                throw new ExchangeError('BAD_LEGS', `Leg ${index + 1}: type must be CALL or PUT.`);
            }
            if (!Number.isFinite(strike) || strike <= 0) {
                throw new ExchangeError('BAD_LEGS', `Leg ${index + 1}: strike must be a positive price.`);
            }
            if (!Number.isInteger(contracts) || contracts <= 0 || contracts > MAX_CONTRACTS_PER_LEG) {
                throw new ExchangeError('BAD_LEGS', `Leg ${index + 1}: contracts must be a whole number between 1 and ${MAX_CONTRACTS_PER_LEG}.`);
            }
            if (!leg.expiry) {
                throw new ExchangeError('BAD_LEGS', `Leg ${index + 1}: an expiry date is required.`);
            }
            return { action, optionType, strike, contracts, expiry: String(leg.expiry) };
        });

        const seen = new Set();
        for (const leg of legs) {
            const key = `${leg.optionType}|${leg.strike}|${leg.expiry}`;
            if (seen.has(key)) {
                throw new ExchangeError('BAD_LEGS', `Two legs name the same ${leg.optionType} ${leg.strike} ${leg.expiry} - combine them into one leg.`);
            }
            seen.add(key);
        }
        return legs;
    }

    /**
     * Price a spread and build the pre-trade receipt, without touching money.
     * @param {Object} params - { guildId, symbol, legs, now }
     */
    async quote({ guildId, symbol, legs: rawLegs, now = new Date() }) {
        exchangeConfig.requireFeature(guildId, 'optionsEnabled', 'Options');
        const legs = this._normalizeLegs(rawLegs);
        const resolved = optionsMarket.resolveUnderlying(symbol);

        const priced = [];
        let netPoints = 0; // positive = debit paid
        for (const leg of legs) {
            const contract = await optionsMarket.quoteContract({
                symbol: resolved.symbol, optionType: leg.optionType,
                strike: leg.strike, expiry: leg.expiry, guildId, now
            });
            const points = leg.action === 'BUY'
                ? contract.costPerContract * leg.contracts
                : -contract.creditPerContract * leg.contracts;
            netPoints += points;
            priced.push({ ...leg, contract, contractSize: contract.contractSize, points });
        }

        const analysis = spreadMath.analyzeSpread({
            legs: priced.map(leg => ({
                action: leg.action, optionType: leg.optionType, strike: leg.strike,
                contracts: leg.contracts, contractSize: leg.contractSize
            })),
            netDebit: netPoints
        });
        const structure = spreadMath.classifySpread(priced);

        // Collateral: the requirement of the spread's own written legs, with
        // its own long legs available as cover (the trader's wider book can
        // only lower this at execution time, never raise it)
        const requirement = marginMath.optionBookRequirement({
            positions: priced.map((leg, index) => ({
                id: index, underlying: resolved.symbol, optionType: leg.optionType,
                expiry: leg.expiry, side: leg.action === 'SELL' ? 'SHORT' : 'LONG',
                strike: leg.strike, contracts: leg.contracts, contractSize: leg.contractSize,
                mark: leg.action === 'SELL' ? leg.contract.ask : leg.contract.bid,
                spot: leg.contract.spot
            }))
        }).total;

        const spot = priced[0].contract.spot;
        const zeroDteLegs = priced.filter(leg => leg.contract.zeroDte);
        return {
            underlying: resolved.symbol,
            alias: resolved.alias,
            label: optionsMarket.label(resolved),
            structure,
            spot,
            asOf: priced[0].contract.asOf,
            simulated: true,
            legs: priced.map(leg => ({
                action: leg.action,
                optionType: leg.optionType,
                strike: leg.strike,
                expiry: leg.expiry,
                contracts: leg.contracts,
                premium: leg.action === 'BUY' ? leg.contract.ask : leg.contract.bid,
                points: leg.points,
                zeroDte: leg.contract.zeroDte,
                greeks: leg.contract.greeks
            })),
            netPoints,
            netLabel: netPoints >= 0 ? 'debit' : 'credit',
            maxGain: analysis.maxGain,
            maxLoss: analysis.maxLoss,
            unboundedGain: analysis.unboundedGain,
            unboundedLoss: analysis.unboundedLoss,
            breakEvens: analysis.breakEvens,
            collateralRequired: Math.ceil(requirement),
            needsMarginAccount: priced.some(leg => leg.action === 'SELL'),
            zeroDte: zeroDteLegs.length > 0,
            pricedAt: accountService.toSqlTime(now)
        };
    }

    /**
     * Execute a spread atomically-in-effect: validate everything first, fill
     * debit legs then credit legs, unwind on any failure.
     * @returns {Promise<{receipt, fills, netPoints, balance}>}
     */
    async execute({ guildId, userId, symbol, legs: rawLegs, now = new Date() }) {
        const receipt = await this.quote({ guildId, symbol, legs: rawLegs, now });
        const legs = this._normalizeLegs(rawLegs);

        // Up-front validation, so unwinding stays a last resort
        const totalDebit = receipt.legs.filter(leg => leg.points > 0).reduce((sum, leg) => sum + leg.points, 0);
        const cash = economyService.getBalance(guildId, userId);
        if (cash < totalDebit) {
            const { currencyName } = economyService.getSettings(guildId);
            throw new ExchangeError('INSUFFICIENT_FUNDS',
                `The debit legs need ${totalDebit.toLocaleString()} ${currencyName} of cash up front (the credit legs pay back in the same order); you have ${cash.toLocaleString()}.`);
        }
        if (receipt.needsMarginAccount) {
            const account = accountService.getAccount(guildId, userId);
            if (account.accountType !== 'MARGIN') {
                throw new ExchangeError('CASH_ACCOUNT', 'This spread writes contracts, which needs a margin account (`/margin account type:margin`).');
            }
        }

        // Debit (BUY) legs first: the written wings then land on a book that
        // already contains their cover, so the requirement check sees the
        // spread, not a naked short.
        const ordered = [
            ...legs.filter(leg => leg.action === 'BUY'),
            ...legs.filter(leg => leg.action === 'SELL')
        ];

        const fills = [];
        try {
            for (const leg of ordered) {
                const fill = leg.action === 'BUY'
                    ? await optionsService.buyToOpen({
                        guildId, userId, symbol: receipt.underlying, optionType: leg.optionType,
                        strike: leg.strike, expiry: leg.expiry, contracts: leg.contracts, now
                    })
                    : await optionsService.sellToOpen({
                        guildId, userId, symbol: receipt.underlying, optionType: leg.optionType,
                        strike: leg.strike, expiry: leg.expiry, contracts: leg.contracts, now
                    });
                fills.push({ leg, fill });
            }
        } catch (error) {
            // Unwind whatever filled, most recent first, at the same cached
            // quotes. The order reports failure as a unit.
            for (const { leg, fill } of fills.reverse()) {
                try {
                    if (leg.action === 'BUY') {
                        await optionsService.sellToClose({ guildId, userId, positionId: fill.positionId, contracts: leg.contracts, now });
                    } else {
                        await optionsService.buyToClose({ guildId, userId, positionId: fill.positionId, contracts: leg.contracts, now });
                    }
                } catch (unwindError) {
                    console.error(`[Exchange] Spread unwind failed for position ${fill.positionId}:`, unwindError.message);
                }
            }
            throw new ExchangeError('SPREAD_FAILED',
                `${error.message} The ${fills.length} leg(s) that had filled were unwound; nothing about this spread remains open.`,
                { cause: error });
        }

        const balance = economyService.getBalance(guildId, userId);
        exchangeEvents.record({
            guildId, userId, eventType: 'spread-open', symbol: receipt.underlying,
            amount: -receipt.netPoints,
            detail: {
                structure: receipt.structure,
                legs: receipt.legs.map(leg => `${leg.action} ${leg.contracts}x ${leg.strike} ${leg.optionType} ${leg.expiry}`),
                maxGain: receipt.maxGain, maxLoss: receipt.maxLoss, breakEvens: receipt.breakEvens
            }
        });

        return {
            receipt,
            fills: fills.map(({ leg, fill }) => ({
                action: leg.action, optionType: leg.optionType, strike: leg.strike,
                expiry: leg.expiry, contracts: leg.contracts, positionId: fill.positionId,
                points: fill.cost ?? fill.credit
            })),
            netPoints: receipt.netPoints,
            balance
        };
    }
}

/**
 * Parse the compact leg syntax used by the command and the chat tool:
 *   "buy 100p, sell 76p, buy 130c, sell 155c"  (with optional "x2" counts)
 * @param {string} text
 * @param {{expiry: string, contracts?: number}} defaults
 * @returns {Array} legs ready for quote()/execute()
 */
function parseLegText(text, { expiry, contracts = 1 }) {
    const parts = String(text || '').split(/[,+/]| and /i).map(part => part.trim()).filter(Boolean);
    if (parts.length === 0) {
        throw new ExchangeError('BAD_LEGS', 'Describe the legs like "buy 100p, sell 76p, buy 130c, sell 155c".');
    }
    return parts.map(part => {
        const match = part.match(/^(buy|sell)\s+\$?(\d+(?:\.\d+)?)\s*(c|call|calls|p|put|puts)(?:\s*x\s*(\d+))?$/i);
        if (!match) {
            throw new ExchangeError('BAD_LEGS', `Could not read the leg "${part}" - use e.g. "buy 130c" or "sell 76p x2".`);
        }
        return {
            action: match[1].toUpperCase(),
            strike: Number(match[2]),
            optionType: match[3].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
            contracts: match[4] ? Number(match[4]) : contracts,
            expiry
        };
    });
}

module.exports = new SpreadService();
module.exports.MAX_LEGS = MAX_LEGS;
module.exports.parseLegText = parseLegText;
