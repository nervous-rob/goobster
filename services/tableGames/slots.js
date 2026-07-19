const { GameError } = require('./gameError');

// House rules (v1): a bank of classic 3-reel slot machines - one machine
// per seat, all pulled together. Everyone bets during the shared betting
// window, then every seat's reels spin in the same transition and settle
// at once (like baccarat, there are no post-bet decisions). Payouts are a
// multiple of the bet, stake included; the weighted reel strip below gives
// the house roughly a 7% edge.
const SEAT_COUNT = 6;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 10000;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 15000;
const NEXT_ROUND_DELAY_MS = 7000;

// One strip shared by all three reels: symbol id -> weight (out of 21)
const REEL_STRIP = [
    ...Array(6).fill('cherry'),
    ...Array(5).fill('lemon'),
    ...Array(4).fill('bell'),
    ...Array(3).fill('star'),
    ...Array(2).fill('diamond'),
    'seven'
];

/**
 * Payline catalogue, checked top to bottom - the first match pays.
 * `pays` is the TOTAL returned per point staked (stake included), so a
 * multiplier of 1 is money back and 2 doubles the bet.
 */
const PAYTABLE = [
    { name: 'JACKPOT 7-7-7', pays: 150, matches: reels => reels.every(s => s === 'seven') },
    { name: 'Triple diamonds', pays: 40, matches: reels => reels.every(s => s === 'diamond') },
    { name: 'Triple bells', pays: 15, matches: reels => reels.every(s => s === 'bell') },
    { name: 'Triple stars', pays: 10, matches: reels => reels.every(s => s === 'star') },
    { name: 'Triple lemons', pays: 8, matches: reels => reels.every(s => s === 'lemon') },
    { name: 'Triple cherries', pays: 6, matches: reels => reels.every(s => s === 'cherry') },
    { name: 'Two sevens', pays: 10, matches: reels => reels.filter(s => s === 'seven').length === 2 },
    { name: 'Lucky seven', pays: 2, matches: reels => reels.filter(s => s === 'seven').length === 1 },
    { name: 'Cherry pair', pays: 1, matches: reels => reels.filter(s => s === 'cherry').length >= 2 }
];

/** The first matching payline for a spin, or null on a miss. */
function evaluateReels(reels) {
    return PAYTABLE.find(line => line.matches(reels)) || null;
}

/**
 * Multiplayer slot-bank engine. Pure state machine like the other tables:
 * no database, no timers, no Discord - every transition returns
 * `{ state, events, charges }` and the manager owns the side effects.
 */
const slotsEngine = {
    gameType: 'slots',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty bank of machines.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'slots',
            phase: 'waiting', // waiting -> betting -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            roundId: 0,
            minBet,
            maxBet,
            results: null,
            timer: null
        };
    },

    /**
     * Apply a player or system action.
     * @param {Object} state - current engine state (not mutated)
     * @param {Object} action - { userId, name, action, amount?, seat?, system? }
     * @param {() => number} [rng] - injectable RNG for the reels
     * @returns {{state: Object, events: Array, charges: Array}}
     * @throws {GameError} on illegal moves
     */
    applyAction(state, { userId = null, name = null, action, amount = null, seat = null, isBot = false, system = false }, rng = Math.random) {
        const next = structuredClone(state);
        const events = [];
        const charges = [];
        const ctx = { next, events, charges, rng };

        switch (action) {
            case 'sit': this._sit(ctx, { userId, name, seat, isBot }); break;
            case 'leave': this._leave(ctx, { userId }); break;
            case 'bet': this._bet(ctx, { userId, amount }); break;
            case 'spin': this._spin(ctx, { userId, system }); break;
            case 'next-round': this._nextRound(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view of the bank. Slots have no hidden information -
     * every machine's reels are on display.
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);

        return {
            gameType: 'slots',
            phase: state.phase,
            roundId: state.roundId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            paytable: PAYTABLE.map(line => ({ name: line.name, pays: line.pays })),
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                isBot: s.isBot === true,
                bet: s.bet,
                reels: s.reels,
                lineName: s.lineName,
                outcome: s.outcome,
                payout: s.payout
            }),
            results: state.results
        };
    },

    /**
     * Points escrowed in an unspun round, per user - what a crash recovery
     * must refund.
     * @returns {Array<{userId: string, amount: number}>}
     */
    getEscrowRefunds(state) {
        if (state.phase !== 'betting') return [];
        return state.seats
            .filter(s => s && s.bet > 0)
            .map(s => ({ userId: s.userId, amount: s.bet }));
    },

    /** Whether the bank has no seated players and can be discarded. */
    isEmpty(state) {
        return state.seats.every(s => s === null);
    },

    // ------------------------------------------------------------------
    // Transitions
    // ------------------------------------------------------------------

    _seatOf(state, userId) {
        return state.seats.findIndex(s => s && s.userId === userId);
    },

    _sit({ next, events }, { userId, name, seat, isBot = false }) {
        if (!userId) throw new GameError('NO_USER', 'Sitting requires a user.');
        if (this._seatOf(next, userId) !== -1) throw new GameError('ALREADY_SEATED', 'You are already at a machine.');

        let index = seat;
        if (index === null || index === undefined) {
            index = next.seats.findIndex(s => s === null);
        }
        if (index < 0 || index >= SEAT_COUNT) throw new GameError('BAD_SEAT', 'That machine does not exist.');
        if (next.seats[index] !== null) throw new GameError('SEAT_TAKEN', 'That machine is taken.');

        next.seats[index] = {
            userId,
            name: name || 'player',
            isBot,
            bet: 0,
            reels: null,
            lineName: null,
            outcome: null,
            payout: null
        };
        events.push({ type: 'sit', seat: index, userId, name });
    },

    _leave(ctx, { userId }) {
        const { next, events, charges } = ctx;
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'You are not at a machine.');
        const seatState = next.seats[index];

        if (next.phase === 'betting' && seatState.bet > 0) {
            charges.push({
                userId,
                amount: seatState.bet,
                type: 'table-slots-refund',
                detail: { roundId: next.roundId, reason: 'left-before-spin' }
            });
        }
        next.seats[index] = null;
        events.push({ type: 'leave', seat: index, userId });

        if (next.phase === 'betting') {
            if (!next.seats.some(s => s && s.bet > 0)) {
                // The only bettor left: back to waiting, cancel the spin timer
                next.phase = 'waiting';
                next.timer = null;
            } else if (this._allBetsIn(next)) {
                this._spinReels(ctx);
            }
        }
    },

    _bet(ctx, { userId, amount }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'waiting' && next.phase !== 'betting') {
            throw new GameError('BAD_PHASE', 'The reels are spinning - wait for the next round.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'Pick a machine before betting.');
        const seatState = next.seats[index];
        if (seatState.bet > 0) throw new GameError('ALREADY_BET', 'Your coins are already in.');
        if (!Number.isInteger(amount) || amount < next.minBet || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Bet must be a whole number between ${next.minBet} and ${next.maxBet}.`);
        }

        seatState.bet = amount;
        events.push({ type: 'bet', seat: index, userId, amount });
        charges.push({
            userId,
            amount: -amount,
            type: 'table-slots-bet',
            detail: { roundId: next.roundId + 1, seat: index }
        });

        if (next.phase === 'waiting') {
            next.phase = 'betting';
            next.timer = { action: 'spin', ms: BET_WINDOW_MS };
            events.push({ type: 'betting-open' });
        }
        if (this._allBetsIn(next)) {
            this._spinReels(ctx);
        }
    },

    _allBetsIn(state) {
        const seated = state.seats.filter(s => s !== null);
        return seated.length > 0 && seated.every(s => s.bet > 0);
    },

    _spin(ctx, { userId, system }) {
        const { next } = ctx;
        if (next.phase !== 'betting') throw new GameError('BAD_PHASE', 'Nothing to spin.');
        if (!system) {
            const index = this._seatOf(next, userId);
            if (index === -1 || next.seats[index].bet === 0) {
                throw new GameError('NO_BET', 'Put some coins in before pulling the lever.');
            }
        }
        this._spinReels(ctx);
    },

    _spinReels(ctx) {
        const { next, events, charges, rng } = ctx;
        if (!next.seats.some(s => s && s.bet > 0)) {
            throw new GameError('NO_BETS', 'Nobody has bet yet.');
        }

        next.roundId += 1;
        events.push({ type: 'spin', roundId: next.roundId });
        const entries = [];

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0) continue;

            s.reels = Array.from({ length: 3 }, () =>
                REEL_STRIP[Math.floor((rng || Math.random)() * REEL_STRIP.length)]);
            const line = evaluateReels(s.reels);
            const payout = line ? s.bet * line.pays : 0;
            s.lineName = line ? line.name : null;
            s.outcome = payout > s.bet ? 'win' : payout > 0 ? 'push' : 'lose';
            s.payout = payout;

            if (payout > 0) {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-slots-payout',
                    detail: { roundId: next.roundId, seat: i, line: s.lineName }
                });
            }
            entries.push({ seat: i, userId: s.userId, name: s.name, reels: s.reels, line: s.lineName, outcome: s.outcome, wagered: s.bet, payout });
            events.push({ type: s.outcome, seat: i, userId: s.userId, payout, wagered: s.bet, line: s.lineName });
        }

        next.phase = 'settled';
        next.results = { roundId: next.roundId, entries };
        next.timer = { action: 'next-round', ms: NEXT_ROUND_DELAY_MS };
        events.push({ type: 'settled' });
    },

    _nextRound({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (const s of next.seats) {
            if (!s) continue;
            s.bet = 0;
            s.reels = null;
            s.lineName = null;
            s.outcome = null;
            s.payout = null;
        }
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'round-reset' });
    }
};

module.exports = slotsEngine;
module.exports.evaluateReels = evaluateReels;
module.exports.PAYTABLE = PAYTABLE;
module.exports.REEL_STRIP = REEL_STRIP;
