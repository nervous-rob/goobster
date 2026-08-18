const { buildDeck, shuffle, evaluateHand, formatCard, handName } = require('../../utils/pokerHands');
const { GameError } = require('./gameError');

// House rules (v1): Let It Ride, single deck per round. An ante escrows
// THREE equal bets; each player gets three cards and two community cards
// sit face down. Before each community reveal every in-hand player
// simultaneously lets the current bet ride or pulls it back (timeout pulls
// it back - the safe default); the third bet always rides. The final
// five-card hand pays every bet still riding per the paytable below
// (pair of tens or better to win).
const SEAT_COUNT = 6;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 5000;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 20000;
const DECIDE_WINDOW_MS = 20000;
const NEXT_ROUND_DELAY_MS = 8000;

/** Paytable: evaluation -> winnings per point staked ("X to 1"), stake returned on top. */
function payoutMultiple(evaluation) {
    const [category] = evaluation;
    switch (category) {
        case 8: return evaluation[1] === 14 ? 1000 : 200; // royal / straight flush
        case 7: return 50;  // four of a kind
        case 6: return 11;  // full house
        case 5: return 8;   // flush
        case 4: return 5;   // straight
        case 3: return 3;   // three of a kind
        case 2: return 2;   // two pair
        case 1: return evaluation[1] >= 10 ? 1 : -1; // pair of tens or better
        default: return -1;
    }
}

/**
 * Multiplayer Let It Ride engine. Pure state machine like the other
 * tables: no database, no timers, no Discord. This is a hidden-information
 * game: `getView` reveals hole cards only to their owner (and everyone at
 * showdown) and the community cards only as the phases reveal them.
 */
const letRideEngine = {
    gameType: 'letride',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'letride',
            phase: 'waiting', // waiting -> betting -> ride1 -> ride2 -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            community: [],   // both cards dealt at once, revealed by phase
            deck: [],
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
     * @param {() => number} [rng] - injectable RNG for shuffles
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
            case 'deal': this._deal(ctx, { userId, system }); break;
            case 'ride': this._decide(ctx, { userId, decision: 'ride' }); break;
            case 'pull': this._decide(ctx, { userId, decision: 'pull' }); break;
            case 'timeout-ride': this._timeoutRide(ctx, { system }); break;
            case 'next-round': this._nextRound(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /** How many community cards the current phase has revealed. */
    _revealedCount(state) {
        if (state.phase === 'ride2') return 1;
        if (state.phase === 'settled') return 2;
        return 0;
    },

    /**
     * Personalized view of the table: your own hole cards face up, other
     * hands as card counts until showdown (revealed via `results`).
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);
        const revealed = this._revealedCount(state);

        return {
            gameType: 'letride',
            phase: state.phase,
            roundId: state.roundId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            community: state.community.slice(0, revealed).map(card => ({ ...card, label: formatCard(card) })),
            communityCount: state.community.length,
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                isBot: s.isBot === true,
                bet: s.bet,
                spots: s.spots,
                totalWagered: s.bet * s.spots,
                decided: s.decision !== null,
                cardCount: s.hand.length,
                cards: s.userId === userId || state.phase === 'settled'
                    ? s.hand.map(card => ({ ...card, label: formatCard(card) }))
                    : null,
                handName: state.phase === 'settled' ? s.handName : null,
                outcome: s.outcome,
                payout: s.payout,
                left: s.left
            }),
            results: state.results
        };
    },

    /**
     * Points escrowed in an unfinished round, per user - what a crash
     * recovery must refund.
     * @returns {Array<{userId: string, amount: number}>}
     */
    getEscrowRefunds(state) {
        if (state.phase !== 'betting' && state.phase !== 'ride1' && state.phase !== 'ride2') return [];
        return state.seats
            .filter(s => s && s.bet > 0)
            .map(s => ({ userId: s.userId, amount: s.bet * s.spots }));
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
            bet: 0,        // per-spot ante
            spots: 0,      // bets still riding (3 after the ante)
            hand: [],
            decision: null, // this phase's choice: 'ride' | 'pull'
            handName: null,
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

        if ((next.phase === 'ride1' || next.phase === 'ride2') && seatState.bet > 0) {
            // Mid-hand: the hand rides to showdown; the seat is flagged and
            // cleared after settlement so the payout still lands.
            seatState.left = true;
            if (seatState.decision === null) {
                seatState.decision = 'ride';
                events.push({ type: 'ride', seat: index, userId, auto: true });
            }
            events.push({ type: 'leave', seat: index, userId, pending: true });
            this._maybeAdvance(ctx);
            return;
        }

        if (next.phase === 'betting' && seatState.bet > 0) {
            charges.push({
                userId,
                amount: seatState.bet * seatState.spots,
                type: 'table-letride-refund',
                detail: { roundId: next.roundId, reason: 'left-before-deal' }
            });
        }
        next.seats[index] = null;
        events.push({ type: 'leave', seat: index, userId });

        if (next.phase === 'betting') {
            if (!next.seats.some(s => s && s.bet > 0)) {
                // The only bettor left: back to waiting, cancel the deal timer
                next.phase = 'waiting';
                next.timer = null;
            } else if (this._allBetsIn(next)) {
                this._dealRound(ctx);
            }
        }
    },

    _bet(ctx, { userId, amount }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'waiting' && next.phase !== 'betting') {
            throw new GameError('BAD_PHASE', 'Bets are closed - wait for the next round.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'Take a seat before betting.');
        const seatState = next.seats[index];
        if (seatState.bet > 0) throw new GameError('ALREADY_BET', 'Your bets are already down.');
        if (!Number.isInteger(amount) || amount < next.minBet || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Bet must be a whole number between ${next.minBet} and ${next.maxBet} (it goes down three times).`);
        }

        seatState.bet = amount;
        seatState.spots = 3;
        events.push({ type: 'bet', seat: index, userId, amount: amount * 3 });
        charges.push({
            userId,
            amount: -amount * 3,
            type: 'table-letride-bet',
            detail: { roundId: next.roundId + 1, seat: index, perSpot: amount }
        });

        if (next.phase === 'waiting') {
            next.phase = 'betting';
            next.timer = { action: 'deal', ms: BET_WINDOW_MS };
            events.push({ type: 'betting-open' });
        }
        if (this._allBetsIn(next)) {
            this._dealRound(ctx);
        }
    },

    _allBetsIn(state) {
        const seated = state.seats.filter(s => s !== null);
        return seated.length > 0 && seated.every(s => s.bet > 0);
    },

    _deal(ctx, { userId, system }) {
        const { next } = ctx;
        if (next.phase !== 'betting') throw new GameError('BAD_PHASE', 'Nothing to deal.');
        if (!system) {
            const index = this._seatOf(next, userId);
            if (index === -1 || next.seats[index].bet === 0) {
                throw new GameError('NO_BET', 'Place a bet before dealing.');
            }
        }
        this._dealRound(ctx);
    },

    _dealRound(ctx) {
        const { next, events, rng } = ctx;
        if (!next.seats.some(s => s && s.bet > 0)) {
            throw new GameError('NO_BETS', 'Nobody has bet yet.');
        }

        next.roundId += 1;
        next.deck = shuffle(buildDeck(), rng || Math.random);

        for (const s of next.seats) {
            if (!s) continue;
            s.hand = [];
            s.decision = null;
            s.handName = null;
            s.outcome = null;
            s.payout = null;
        }

        const inHand = next.seats.filter(s => s && s.bet > 0);
        for (let round = 0; round < 3; round++) {
            for (const s of inHand) s.hand.push(next.deck.pop());
        }
        next.community = [next.deck.pop(), next.deck.pop()];

        next.phase = 'ride1';
        next.timer = { action: 'timeout-ride', ms: DECIDE_WINDOW_MS };
        events.push({ type: 'deal', roundId: next.roundId });
    },

    _decide(ctx, { userId, decision }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'ride1' && next.phase !== 'ride2') {
            throw new GameError('BAD_PHASE', 'There is nothing to decide right now.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'You are not seated.');
        const seatState = next.seats[index];
        if (seatState.bet === 0) throw new GameError('NOT_IN_HAND', 'You sat this round out.');
        if (seatState.decision !== null) throw new GameError('ALREADY_DECIDED', 'Your decision is already in.');

        seatState.decision = decision;
        if (decision === 'pull') {
            seatState.spots -= 1;
            charges.push({
                userId,
                amount: seatState.bet,
                type: 'table-letride-refund',
                detail: { roundId: next.roundId, seat: index, phase: next.phase, reason: 'pulled-back' }
            });
        }
        events.push({ type: decision, seat: index, userId });
        this._maybeAdvance(ctx);
    },

    _timeoutRide(ctx, { system }) {
        const { next, events, charges } = ctx;
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'ride1' && next.phase !== 'ride2') return; // stale timer

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0 || s.decision !== null) continue;
            // The safe default: pull the bet back for players who dozed off
            s.decision = 'pull';
            s.spots -= 1;
            charges.push({
                userId: s.userId,
                amount: s.bet,
                type: 'table-letride-refund',
                detail: { roundId: next.roundId, seat: i, phase: next.phase, reason: 'timeout' }
            });
            events.push({ type: 'pull', seat: i, userId: s.userId, timeout: true });
        }
        this._maybeAdvance(ctx);
    },

    /** Once every in-hand seat has decided, reveal the next card (or settle). */
    _maybeAdvance(ctx) {
        const { next, events } = ctx;
        const undecided = next.seats.some(s => s && s.bet > 0 && s.decision === null);
        if (undecided) return;

        if (next.phase === 'ride1') {
            for (const s of next.seats) {
                // Leavers ride to showdown; everyone else decides again
                if (s) s.decision = s.left ? 'ride' : null;
            }
            next.phase = 'ride2';
            next.timer = { action: 'timeout-ride', ms: DECIDE_WINDOW_MS };
            events.push({ type: 'community', card: formatCard(next.community[0]), revealed: 1 });
            return;
        }
        events.push({ type: 'community', card: formatCard(next.community[1]), revealed: 2 });
        this._settle(ctx);
    },

    _settle(ctx) {
        const { next, events, charges } = ctx;
        const entries = [];

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0) continue;

            const evaluation = evaluateHand([...s.hand, ...next.community]);
            const multiple = payoutMultiple(evaluation);
            const riding = s.bet * s.spots;
            const payout = multiple >= 0 ? riding * (multiple + 1) : 0;

            s.handName = handName(evaluation);
            s.outcome = multiple >= 0 ? 'win' : 'lose';
            s.payout = payout;
            if (payout > 0) {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-letride-payout',
                    detail: { roundId: next.roundId, seat: i, hand: s.handName, spots: s.spots }
                });
            }
            entries.push({
                seat: i,
                userId: s.userId,
                name: s.name,
                outcome: s.outcome,
                wagered: riding,
                payout,
                spots: s.spots,
                handName: s.handName,
                holeCards: s.hand.map(card => ({ ...card, label: formatCard(card) }))
            });
            events.push({ type: s.outcome, seat: i, userId: s.userId, payout, wagered: riding, hand: s.handName });
        }

        next.phase = 'settled';
        next.results = {
            roundId: next.roundId,
            community: next.community.map(card => ({ ...card, label: formatCard(card) })),
            entries
        };
        next.timer = { action: 'next-round', ms: NEXT_ROUND_DELAY_MS };
        events.push({ type: 'settled' });
    },

    _nextRound({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s) continue;
            if (s.left) { next.seats[i] = null; continue; }
            s.bet = 0;
            s.spots = 0;
            s.hand = [];
            s.decision = null;
            s.handName = null;
            s.outcome = null;
            s.payout = null;
        }
        next.community = [];
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'round-reset' });
    }
};

module.exports = letRideEngine;
module.exports.payoutMultiple = payoutMultiple;
