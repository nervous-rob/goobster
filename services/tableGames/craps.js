const { GameError } = require('./gameError');

// House rules (v1): street-simple craps. Pass line and don't pass are
// taken on the come-out only (don't pass pushes on 12); the field is a
// single-roll bet available before every roll (2 and 12 pay 2:1, the
// other field numbers 1:1). A round runs from come-out to a natural,
// craps, seven-out, or the point being made; anyone with a live bet may
// throw the dice, and the table rolls itself when nobody does.
const SEAT_COUNT = 8;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 10000;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 20000;
const ROLL_INTERVAL_MS = 12000;
const NEXT_ROUND_DELAY_MS = 7000;
const HISTORY_LENGTH = 12;

const FIELD_WINS = { 2: 3, 3: 2, 4: 2, 9: 2, 10: 2, 11: 2, 12: 3 }; // total -> payout multiple of the stake

const BET_KINDS = new Set(['pass', 'dont', 'field']);
const BET_LABELS = { pass: 'Pass line', dont: "Don't pass", field: 'Field' };

/**
 * Multiplayer craps engine. Pure state machine like the other tables: no
 * database, no timers, no Discord - every transition returns
 * `{ state, events, charges }` and the manager owns the side effects.
 * Everyone bets during the shared windows (no turn order); each roll
 * resolves the field immediately and the line bets per craps rules.
 */
const crapsEngine = {
    gameType: 'craps',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'craps',
            phase: 'waiting', // waiting -> betting (repeats while the point is on) -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            point: null,
            dice: null,      // [d1, d2] of the last roll
            history: [],     // recent roll totals, newest first
            roundId: 0,
            rollCount: 0,
            minBet,
            maxBet,
            results: null,
            timer: null
        };
    },

    /**
     * Apply a player or system action.
     * @param {Object} state - current engine state (not mutated)
     * @param {Object} action - { userId, name, action, amount?, seat?, kind?, system? }
     * @param {() => number} [rng] - injectable RNG for the dice
     * @returns {{state: Object, events: Array, charges: Array}}
     * @throws {GameError} on illegal moves
     */
    applyAction(state, { userId = null, name = null, action, amount = null, seat = null, kind = null, isBot = false, system = false }, rng = Math.random) {
        const next = structuredClone(state);
        const events = [];
        const charges = [];
        const ctx = { next, events, charges, rng };

        switch (action) {
            case 'sit': this._sit(ctx, { userId, name, seat, isBot }); break;
            case 'leave': this._leave(ctx, { userId }); break;
            case 'bet': this._bet(ctx, { userId, amount, kind }); break;
            case 'roll': this._rollAction(ctx, { userId, system }); break;
            case 'next-round': this._nextRound(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view of the table. Craps is fully public - only the next
     * roll (which does not exist until the RNG fires) is unknown.
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);

        return {
            gameType: 'craps',
            phase: state.phase,
            roundId: state.roundId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            point: state.point,
            dice: state.dice,
            history: state.history,
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                isBot: s.isBot === true,
                bets: s.bets.map(b => ({ ...b, label: BET_LABELS[b.kind] })),
                resolved: s.resolved,
                totalWagered: s.bets.reduce((sum, b) => sum + b.amount, 0)
                    + s.resolved.reduce((sum, r) => sum + r.wagered, 0),
                outcome: s.outcome,
                payout: s.payout,
                left: s.left
            }),
            results: state.results
        };
    },

    /**
     * Points escrowed in live (unresolved) bets, per user - what a crash
     * recovery must refund.
     * @returns {Array<{userId: string, amount: number}>}
     */
    getEscrowRefunds(state) {
        if (state.phase !== 'betting') return [];
        return state.seats
            .filter(s => s && s.bets.length > 0)
            .map(s => ({ userId: s.userId, amount: s.bets.reduce((sum, b) => sum + b.amount, 0) }));
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

    _sit({ next, events }, { userId, name, seat, isBot = false }) {
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
            isBot,
            bets: [],      // live bets: { kind, amount }
            resolved: [],  // this round's settled bets: { kind, outcome, wagered, payout }
            outcome: null,
            payout: null,
            left: false
        };
        events.push({ type: 'sit', seat: index, userId, name });
    },

    _leave(ctx, { userId }) {
        const { next, events, charges } = ctx;
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'You are not seated.');
        const seatState = next.seats[index];

        if (next.phase === 'betting') {
            // Field bets have not ridden a roll yet - always refundable.
            // Line bets refund on the come-out too, but once the point is
            // on they must ride (walking away from the unfavorable phase
            // would flip the odds): the seat is flagged and cleared after
            // the round settles, payouts still landing in the wallet.
            const refundable = next.point === null
                ? seatState.bets
                : seatState.bets.filter(b => b.kind === 'field');
            for (const bet of refundable) {
                charges.push({
                    userId,
                    amount: bet.amount,
                    type: 'table-craps-refund',
                    detail: { roundId: next.roundId, kind: bet.kind, reason: 'left-table' }
                });
            }
            const riding = seatState.bets.filter(b => !refundable.includes(b));
            if (riding.length > 0) {
                seatState.bets = riding;
                seatState.left = true;
                events.push({ type: 'leave', seat: index, userId, pending: true });
                return;
            }
        }

        next.seats[index] = null;
        events.push({ type: 'leave', seat: index, userId });

        if (next.phase === 'betting' && !next.seats.some(s => s && s.bets.length > 0)) {
            // The only bettor left: back to waiting, cancel the roll timer
            next.phase = 'waiting';
            next.point = null;
            next.timer = null;
        }
    },

    _bet(ctx, { userId, amount, kind }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'waiting' && next.phase !== 'betting') {
            throw new GameError('BAD_PHASE', 'Bets are closed - wait for the next round.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'Take a seat before betting.');
        const seatState = next.seats[index];
        if (!BET_KINDS.has(kind)) {
            throw new GameError('BAD_BET', 'Bet on pass, dont, or field.');
        }
        if ((kind === 'pass' || kind === 'dont') && next.point !== null) {
            throw new GameError('BAD_BET', 'Line bets are only taken on the come-out roll.');
        }
        if (seatState.bets.some(b => b.kind === kind)) {
            throw new GameError('ALREADY_BET', `Your ${BET_LABELS[kind]} bet is already down.`);
        }
        if (!Number.isInteger(amount) || amount < next.minBet || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Bet must be a whole number between ${next.minBet} and ${next.maxBet}.`);
        }

        seatState.bets.push({ kind, amount });
        events.push({ type: 'bet', seat: index, userId, amount, kind, label: BET_LABELS[kind] });
        charges.push({
            userId,
            amount: -amount,
            type: 'table-craps-bet',
            detail: { roundId: next.roundId + (next.point === null && next.rollCount === 0 ? 1 : 0), kind, seat: index }
        });

        if (next.phase === 'waiting') {
            next.phase = 'betting';
            next.timer = { action: 'roll', ms: BET_WINDOW_MS };
            events.push({ type: 'betting-open' });
        }
    },

    _rollAction(ctx, { userId, system }) {
        const { next } = ctx;
        if (next.phase !== 'betting') throw new GameError('BAD_PHASE', 'Nothing to roll.');
        if (!system) {
            const index = this._seatOf(next, userId);
            if (index === -1 || next.seats[index].bets.length === 0) {
                throw new GameError('NO_BET', 'Put some chips down before throwing the dice.');
            }
        }
        if (!next.seats.some(s => s && s.bets.length > 0)) {
            throw new GameError('NO_BETS', 'Nobody has bet yet.');
        }
        this._roll(ctx);
    },

    _roll(ctx) {
        const { next, events, rng } = ctx;
        const roll = () => 1 + Math.floor((rng || Math.random)() * 6);
        const dice = [roll(), roll()];
        const total = dice[0] + dice[1];
        const comeOut = next.point === null;

        if (comeOut && next.rollCount === 0) next.roundId += 1;
        next.rollCount += 1;
        next.dice = dice;
        next.history = [total, ...next.history].slice(0, HISTORY_LENGTH);
        events.push({ type: 'roll', dice, total, comeOut });

        // Field bets resolve on every roll
        this._resolveBets(ctx, 'field', bet => {
            const pays = FIELD_WINS[total];
            return pays ? { outcome: 'win', payout: bet.amount * pays } : { outcome: 'lose', payout: 0 };
        });

        let roundOver = false;
        if (comeOut) {
            if (total === 7 || total === 11) {
                events.push({ type: 'natural', total });
                this._resolveBets(ctx, 'pass', bet => ({ outcome: 'win', payout: bet.amount * 2 }));
                this._resolveBets(ctx, 'dont', () => ({ outcome: 'lose', payout: 0 }));
                roundOver = true;
            } else if (total === 2 || total === 3 || total === 12) {
                events.push({ type: 'craps', total });
                this._resolveBets(ctx, 'pass', () => ({ outcome: 'lose', payout: 0 }));
                this._resolveBets(ctx, 'dont', bet => total === 12
                    ? { outcome: 'push', payout: bet.amount }
                    : { outcome: 'win', payout: bet.amount * 2 });
                roundOver = true;
            } else {
                next.point = total;
                events.push({ type: 'point-set', point: total });
            }
        } else if (total === next.point) {
            events.push({ type: 'point-made', point: next.point });
            this._resolveBets(ctx, 'pass', bet => ({ outcome: 'win', payout: bet.amount * 2 }));
            this._resolveBets(ctx, 'dont', () => ({ outcome: 'lose', payout: 0 }));
            roundOver = true;
        } else if (total === 7) {
            events.push({ type: 'seven-out' });
            this._resolveBets(ctx, 'pass', () => ({ outcome: 'lose', payout: 0 }));
            this._resolveBets(ctx, 'dont', bet => ({ outcome: 'win', payout: bet.amount * 2 }));
            roundOver = true;
        }

        // A round with nothing left riding (e.g. field-only players) ends
        // even when a point was just set - the point means nothing without
        // a live line bet.
        if (roundOver || !next.seats.some(s => s && s.bets.length > 0)) {
            this._settle(ctx);
            return;
        }
        // The point is on (or stays on): the next roll follows automatically,
        // with the window open for fresh field bets.
        next.timer = { action: 'roll', ms: ROLL_INTERVAL_MS };
    },

    /**
     * Move every live bet of a kind to the seat's resolved list using
     * `decide(bet) -> { outcome, payout }`, charging payouts and emitting
     * per-bet events.
     */
    _resolveBets(ctx, kind, decide) {
        const { next, events, charges } = ctx;
        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s) continue;
            const bet = s.bets.find(b => b.kind === kind);
            if (!bet) continue;

            const { outcome, payout } = decide(bet);
            s.bets = s.bets.filter(b => b !== bet);
            s.resolved.push({ kind, outcome, wagered: bet.amount, payout });
            if (payout > 0) {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-craps-payout',
                    detail: { roundId: next.roundId, seat: i, kind, outcome }
                });
            }
            events.push({ type: outcome, seat: i, userId: s.userId, payout, wagered: bet.amount, kind, label: BET_LABELS[kind] });
        }
    },

    _settle(ctx) {
        const { next, events } = ctx;
        const entries = [];
        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.resolved.length === 0) continue;
            const wagered = s.resolved.reduce((sum, r) => sum + r.wagered, 0);
            const payout = s.resolved.reduce((sum, r) => sum + r.payout, 0);
            const net = payout - wagered;
            s.outcome = net > 0 ? 'win' : net === 0 ? 'push' : 'lose';
            s.payout = payout;
            entries.push({ seat: i, userId: s.userId, name: s.name, outcome: s.outcome, wagered, payout });
        }

        next.phase = 'settled';
        next.point = null;
        next.results = { roundId: next.roundId, dice: next.dice, entries };
        next.timer = { action: 'next-round', ms: NEXT_ROUND_DELAY_MS };
        events.push({ type: 'settled', dice: next.dice });
    },

    _nextRound({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s) continue;
            if (s.left) { next.seats[i] = null; continue; }
            s.bets = [];
            s.resolved = [];
            s.outcome = null;
            s.payout = null;
        }
        next.dice = null;
        next.rollCount = 0;
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'round-reset' });
    }
};

module.exports = crapsEngine;
module.exports.FIELD_WINS = FIELD_WINS;
