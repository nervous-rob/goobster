const economyService = require('../economyService');
const stockService = require('../stockService');
const exchangeConfig = require('./exchangeConfig');
const optionsMarket = require('./optionsMarket');
const optionsService = require('./optionsService');
const groupPlayService = require('./groupPlayService');
const exchangeEvents = require('./exchangeEvents');
const { toSqlTime } = require('./accountService');
const { ExchangeError } = require('./errors');

// Wheel 1: how far above spot the strike lands. The odds The Data Daddy
// ordained: mostly modest, occasionally ambitious, once in a hundred the
// sacred moonshot.
const STRIKE_WHEEL = Object.freeze([
    { chance: 80, min: 1, max: 5, label: 'the 80% bucket (+1% to +5%)' },
    { chance: 19, min: 6, max: 10, label: 'the 19% bucket (+6% to +10%)' },
    { chance: 1, min: 20, max: 20, label: 'THE SACRED +20% MOONSHOT' }
]);

// Wheel 2: what fraction of each participant's wallet rides.
const ALLOCATION_WHEEL = Object.freeze([
    { chance: 50, percent: 5 },
    { chance: 30, percent: 10 },
    { chance: 15, percent: 20 },
    { chance: 4, percent: 35 },
    { chance: 1, percent: 50 }
]);

const DEFAULT_UNDERLYING = 'SPX';
const MAX_PARTICIPANTS = 50;

/**
 * The Daily Ballistic Goblin Wheel: two spins, one missile, no coordinates
 * chosen - only revealed.
 *
 * Wheel 1 picks how far out of the money the call goes; Wheel 2 picks what
 * percentage of each participant's wallet rides on it. The exchange then
 * buys the nearest listed call at spot x (1 + target%) on the nearest expiry
 * (same-day when the guild allows it) for every participant.
 *
 * Consent is groupPlayService's: explicit opt-outs are always excluded, the
 * guild's override (ON by default) covers everyone else, and participating
 * stands in for the personal Goblin Mode acknowledgement on same-day
 * contracts - the ritual IS the consent form, and every ticket still shows
 * the max loss.
 *
 * The RNG is constructor-injectable (like GamblingService) so every spin is
 * deterministic under test.
 */
class WheelService {
    constructor(rng = Math.random) {
        this.rng = rng;
    }

    /** Roll 1-100 and map it onto a wheel's buckets. */
    _roll(wheel) {
        const roll = 1 + Math.floor(this.rng() * 100);
        let cumulative = 0;
        for (const bucket of wheel) {
            cumulative += bucket.chance;
            if (roll <= cumulative) return { roll, bucket };
        }
        return { roll, bucket: wheel[wheel.length - 1] };
    }

    /** Wheel 1: the strike target. */
    spinStrikeWheel() {
        const { roll, bucket } = this._roll(STRIKE_WHEEL);
        const span = bucket.max - bucket.min;
        const targetPercent = span === 0
            ? bucket.min
            : bucket.min + Math.floor(this.rng() * (span + 1));
        return { roll, targetPercent: Math.min(bucket.max, targetPercent), label: bucket.label };
    }

    /** Wheel 2: the allocation. */
    spinAllocationWheel() {
        const { roll, bucket } = this._roll(ALLOCATION_WHEEL);
        return { roll, percent: bucket.percent };
    }

    /**
     * The full ritual: spin both wheels, pick the contract, deploy for every
     * participant. Nothing is deployed when the guild has not enabled
     * options; each participant's failure (usually poverty) is reported, not
     * fatal.
     * @param {Object} params - { guildId, symbol?, now? }
     */
    async spin({ guildId, symbol = DEFAULT_UNDERLYING, now = new Date() }) {
        exchangeConfig.requireFeature(guildId, 'optionsEnabled', 'Options (and therefore the Wheel)');
        const settings = exchangeConfig.get(guildId);

        const resolved = optionsMarket.resolveUnderlying(symbol);
        const quote = await stockService.getQuote(resolved.symbol);

        const strikeSpin = this.spinStrikeWheel();
        const allocationSpin = this.spinAllocationWheel();

        // Nearest listed strike at spot x (1 + target%)
        const increment = optionsMarket.strikeIncrement(quote.price);
        const strike = Math.round((quote.price * (1 + strikeSpin.targetPercent / 100)) / increment) * increment;

        // Same-day when the guild allows it and the bell has not rung;
        // otherwise the nearest listed expiry
        const expiries = optionsMarket.listExpiries({ now });
        if (expiries.length === 0) throw new ExchangeError('NO_EXPIRIES', 'No tradable expiries right now.');
        const sameDay = expiries[0].zeroDte && settings.zeroDteEnabled;
        const expiry = sameDay ? expiries[0].expiry : expiries.find(entry => !entry.zeroDte)?.expiry || expiries[0].expiry;

        const contract = await optionsMarket.quoteContract({
            symbol: resolved.symbol, optionType: 'CALL', strike, expiry, guildId, now
        });

        const participants = groupPlayService.listParticipants({ guildId, limit: MAX_PARTICIPANTS });
        const deployments = [];
        let totalContracts = 0;
        let totalPoints = 0;

        for (const participant of participants) {
            const balance = economyService.getBalance(guildId, participant.userId);
            const effectivePercent = participant.maxAllocationPercent === null
                ? allocationSpin.percent
                : Math.min(allocationSpin.percent, participant.maxAllocationPercent);
            const budget = Math.floor(balance * effectivePercent / 100);
            // A whale's budget can exceed the per-order contract cap: clamp,
            // never error - the Wheel deploys what it may
            const contracts = Math.min(
                Math.floor(budget / contract.costPerContract),
                optionsService.MAX_CONTRACTS
            );

            if (contracts <= 0) {
                deployments.push({
                    userId: participant.userId, source: participant.source,
                    skipped: true,
                    reason: budget <= 0
                        ? 'nothing to deploy'
                        : `budget ${budget.toLocaleString()} is under one contract (${contract.costPerContract.toLocaleString()})`
                });
                continue;
            }

            try {
                const fill = await optionsService.buyToOpen({
                    guildId, userId: participant.userId,
                    symbol: resolved.symbol, optionType: 'CALL', strike, expiry,
                    contracts, now, viaGroupEvent: true
                });
                totalContracts += contracts;
                totalPoints += fill.cost;
                deployments.push({
                    userId: participant.userId, source: participant.source,
                    skipped: false, contracts, cost: fill.cost,
                    percent: effectivePercent, balance: fill.balance, positionId: fill.positionId
                });
            } catch (error) {
                deployments.push({
                    userId: participant.userId, source: participant.source,
                    skipped: true, reason: error.message
                });
            }
        }

        const result = {
            guildId,
            underlying: resolved.symbol,
            alias: resolved.alias,
            label: optionsMarket.label(resolved),
            spot: quote.price,
            strikeSpin,
            allocationSpin,
            strike,
            expiry,
            zeroDte: contract.zeroDte,
            premium: contract.ask,
            costPerContract: contract.costPerContract,
            probabilityItm: contract.probabilityItm,
            breakEven: contract.breakEven,
            participants: participants.length,
            deployments,
            totalContracts,
            totalPoints,
            simulated: true,
            at: toSqlTime(now)
        };

        exchangeEvents.record({
            guildId, eventType: 'wheel-spin', symbol: resolved.symbol, amount: -totalPoints,
            detail: {
                strikeRoll: strikeSpin.roll, targetPercent: strikeSpin.targetPercent,
                allocationRoll: allocationSpin.roll, allocationPercent: allocationSpin.percent,
                strike, expiry, zeroDte: contract.zeroDte,
                participants: participants.length, deployed: deployments.filter(d => !d.skipped).length,
                totalContracts, totalPoints
            }
        });
        return result;
    }
}

module.exports = new WheelService();
module.exports.WheelService = WheelService;
module.exports.STRIKE_WHEEL = STRIKE_WHEEL;
module.exports.ALLOCATION_WHEEL = ALLOCATION_WHEEL;
