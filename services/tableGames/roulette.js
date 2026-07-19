const { GameError } = require('./gameError');

// House rules (v1): European single-zero wheel. Straight bets pay 35:1,
// dozens/columns 2:1, even-money bets 1:1 (zero loses them all - no la
// partage). Players may stack multiple bets before the spin.
const SEAT_COUNT = 8;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 10000;
const MAX_BETS_PER_SEAT = 20;
const HISTORY_LENGTH = 12;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 30000;
const NEXT_ROUND_DELAY_MS = 10000;

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

/**
 * Bet catalogue: payout multiple (winnings per point staked, stake returned
 * on top), whether a numeric target is required, and the win predicate.
 */
const BET_KINDS = {
    straight: { pays: 35, target: n => Number.isInteger(n) && n >= 0 && n <= 36, wins: (n, t) => n === t },
    red: { pays: 1, target: null, wins: n => RED_NUMBERS.has(n) },
    black: { pays: 1, target: null, wins: n => n !== 0 && !RED_NUMBERS.has(n) },
    odd: { pays: 1, target: null, wins: n => n !== 0 && n % 2 === 1 },
    even: { pays: 1, target: null, wins: n => n !== 0 && n % 2 === 0 },
    low: { pays: 1, target: null, wins: n => n >= 1 && n <= 18 },
    high: { pays: 1, target: null, wins: n => n >= 19 },
    dozen: { pays: 2, target: n => Number.isInteger(n) && n >= 1 && n <= 3, wins: (n, t) => n >= (t - 1) * 12 + 1 && n <= t * 12 },
    column: { pays: 2, target: n => Number.isInteger(n) && n >= 1 && n <= 3, wins: (n, t) => n !== 0 && ((n - 1) % 3) + 1 === t }
};

function wheelColor(number) {
    if (number === 0) return 'green';
    return RED_NUMBERS.has(number) ? 'red' : 'black';
}

/** Human label for a bet, e.g. "17", "red", "1st 12", "column 2". */
function describeBet(kind, target) {
    switch (kind) {
        case 'straight': return String(target);
        case 'dozen': return ['1st 12', '2nd 12', '3rd 12'][target - 1];
        case 'column': return `column ${target}`;
        case 'low': return '1-18';
        case 'high': return '19-36';
        default: return kind;
    }
}

/**
 * Multiplayer European roulette engine. Pure state machine like blackjack:
 * no database, no timers, no Discord - every transition returns
 * `{ state, events, charges }` and the manager owns the side effects.
 * Everyone bets during the betting window; the spin settles all seats at
 * once (there is no turn order).
 */
const rouletteEngine = {
    gameType: 'roulette',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'roulette',
            phase: 'waiting', // waiting -> betting -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            roundId: 0,
            minBet,
            maxBet,
            result: null,   // { number, color } of the last spin
            history: [],    // recent winning numbers, newest first
            results: null,  // settlement summary of the last round
            timer: null
        };
    },

    /**
     * Apply a player or system action.
     * @param {Object} state - current engine state (not mutated)
     * @param {Object} action - { userId, name, action, amount?, seat?, kind?, target?, system? }
     * @param {() => number} [rng] - injectable RNG for spins
     * @returns {{state: Object, events: Array, charges: Array}}
     * @throws {GameError} on illegal moves
     */
    applyAction(state, { userId = null, name = null, action, amount = null, seat = null, kind = null, target = null, system = false }, rng = Math.random) {
        const next = structuredClone(state);
        const events = [];
        const charges = [];
        const ctx = { next, events, charges, rng };

        switch (action) {
            case 'sit': this._sit(ctx, { userId, name, seat }); break;
            case 'leave': this._leave(ctx, { userId }); break;
            case 'bet': this._bet(ctx, { userId, amount, kind, target }); break;
            case 'clear-bets': this._clearBets(ctx, { userId }); break;
            case 'spin': this._spin(ctx, { userId, system }); break;
            case 'next-round': this._nextRound(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view of the table. Roulette is fully public - only the
     * upcoming spin (which does not exist until the RNG fires) is unknown.
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);

        return {
            gameType: 'roulette',
            phase: state.phase,
            roundId: state.roundId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            result: state.result,
            history: state.history,
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                totalWagered: s.totalWagered,
                bets: s.bets.map(b => ({ ...b, label: describeBet(b.kind, b.target) })),
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
            .filter(s => s && s.totalWagered > 0)
            .map(s => ({ userId: s.userId, amount: s.totalWagered }));
    },

    /** Whether the table has no seated players and can be discarded. */
    isEmpty(state) {
        return state.seats.every(s => s === null);
    },

    // ------------------------------------------------------------------
    // Transitions
    // ------------------------------------------------------------------

    _seatOf(state, userId) {
        return state.seats.findIndex(s => s && s.userId === userId);
    },

    _sit({ next, events }, { userId, name, seat }) {
        if (!userId) throw new GameError('NO_USER', 'Sitting requires a user.');
        if (this._seatOf(next, userId) !== -1) throw new GameError('ALREADY_SEATED', 'You are already at the table.');

        let index = seat;
        if (index === null || index === undefined) {
            index = next.seats.findIndex(s => s === null);
        }
        if (index < 0 || index >= SEAT_COUNT) throw new GameError('BAD_SEAT', 'That seat does not exist.');
        if (next.seats[index] !== null) throw new GameError('SEAT_TAKEN', 'That seat is taken.');

        next.seats[index] = {
            userId,
            name: name || 'player',
            bets: [],
            totalWagered: 0,
            outcome: null,
            payout: null
        };
        events.push({ type: 'sit', seat: index, userId, name });
    },

    _leave(ctx, { userId }) {
        const { next, events, charges } = ctx;
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'You are not seated.');
        const seatState = next.seats[index];

        if (next.phase === 'betting' && seatState.totalWagered > 0) {
            charges.push({
                userId,
                amount: seatState.totalWagered,
                type: 'table-roulette-refund',
                detail: { roundId: next.roundId, reason: 'left-before-spin' }
            });
        }
        next.seats[index] = null;
        events.push({ type: 'leave', seat: index, userId });

        if (next.phase === 'betting' && !next.seats.some(s => s && s.totalWagered > 0)) {
            // The only bettor left: back to waiting, cancel the spin timer
            next.phase = 'waiting';
            next.timer = null;
        }
    },

    _bet(ctx, { userId, amount, kind, target }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'waiting' && next.phase !== 'betting') {
            throw new GameError('BAD_PHASE', 'Bets are closed - wait for the next spin.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'Take a seat before betting.');
        const seatState = next.seats[index];
        if (seatState.bets.length >= MAX_BETS_PER_SEAT) {
            throw new GameError('TOO_MANY_BETS', `At most ${MAX_BETS_PER_SEAT} bets per spin.`);
        }

        const spec = BET_KINDS[kind];
        if (!spec) throw new GameError('BAD_BET', 'Unknown bet type.');
        if (spec.target && !spec.target(target)) {
            throw new GameError('BAD_BET', `Invalid target for a ${kind} bet.`);
        }
        if (!spec.target) target = null;
        if (!Number.isInteger(amount) || amount < next.minBet || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Bet must be a whole number between ${next.minBet} and ${next.maxBet}.`);
        }

        seatState.bets.push({ kind, target, amount });
        seatState.totalWagered += amount;
        events.push({ type: 'bet', seat: index, userId, amount, label: describeBet(kind, target) });
        charges.push({
            userId,
            amount: -amount,
            type: 'table-roulette-bet',
            detail: { roundId: next.roundId + 1, seat: index, bet: describeBet(kind, target) }
        });

        if (next.phase === 'waiting') {
            next.phase = 'betting';
            next.timer = { action: 'spin', ms: BET_WINDOW_MS };
            events.push({ type: 'betting-open' });
        }
    },

    _clearBets(ctx, { userId }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'betting') throw new GameError('BAD_PHASE', 'There are no bets to clear.');
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'You are not seated.');
        const seatState = next.seats[index];
        if (seatState.totalWagered === 0) throw new GameError('NO_BETS', 'You have no bets down.');

        charges.push({
            userId,
            amount: seatState.totalWagered,
            type: 'table-roulette-refund',
            detail: { roundId: next.roundId, reason: 'cleared-bets' }
        });
        seatState.bets = [];
        seatState.totalWagered = 0;
        events.push({ type: 'clear-bets', seat: index, userId });

        if (!next.seats.some(s => s && s.totalWagered > 0)) {
            next.phase = 'waiting';
            next.timer = null;
        }
    },

    _spin(ctx, { userId, system }) {
        const { next, events, charges, rng } = ctx;
        if (next.phase !== 'betting') throw new GameError('BAD_PHASE', 'Nothing to spin.');
        if (!system) {
            const index = this._seatOf(next, userId);
            if (index === -1 || next.seats[index].totalWagered === 0) {
                throw new GameError('NO_BET', 'Place a bet before spinning.');
            }
        }
        if (!next.seats.some(s => s && s.totalWagered > 0)) {
            throw new GameError('NO_BETS', 'Nobody has bet yet.');
        }

        next.roundId += 1;
        const number = Math.min(36, Math.floor((rng || Math.random)() * 37));
        const color = wheelColor(number);
        next.result = { number, color };
        next.history = [{ number, color }, ...next.history].slice(0, HISTORY_LENGTH);
        events.push({ type: 'spin', roundId: next.roundId, number, color });

        const entries = [];
        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.totalWagered === 0) continue;

            let payout = 0;
            for (const bet of s.bets) {
                const spec = BET_KINDS[bet.kind];
                if (spec.wins(number, bet.target)) payout += bet.amount * (spec.pays + 1);
            }

            s.outcome = payout > 0 ? 'win' : 'lose';
            s.payout = payout;
            if (payout > 0) {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-roulette-payout',
                    detail: { roundId: next.roundId, seat: i, number }
                });
            }
            entries.push({ seat: i, userId: s.userId, name: s.name, outcome: s.outcome, wagered: s.totalWagered, payout });
            events.push({ type: s.outcome, seat: i, userId: s.userId, payout });
        }

        next.phase = 'settled';
        next.results = { roundId: next.roundId, number, color, entries };
        next.timer = { action: 'next-round', ms: NEXT_ROUND_DELAY_MS };
        events.push({ type: 'settled', number, color });
    },

    _nextRound({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (const s of next.seats) {
            if (!s) continue;
            s.bets = [];
            s.totalWagered = 0;
            s.outcome = null;
            s.payout = null;
        }
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'round-reset' });
    }
};

module.exports = rouletteEngine;
module.exports.describeBet = describeBet;
module.exports.wheelColor = wheelColor;
module.exports.RED_NUMBERS = RED_NUMBERS;
