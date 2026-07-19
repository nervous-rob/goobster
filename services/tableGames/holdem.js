const { buildDeck, shuffle, formatCard, bestHand, compareHands, handName } = require('../../utils/pokerHands');
const { GameError } = require('./gameError');

// House rules (v1): no-limit Texas Hold'em, wallet-backed betting (every
// chip is escrowed from the wallet as it enters the pot). Blinds are
// minBet/2 and minBet; raises must increase the street total by at least
// the big blind; a street total is capped at maxBet. There are no side
// pots: a player who cannot cover a call folds instead of going all-in.
const SEAT_COUNT = 6;
const DEFAULT_MIN_BET = 10;      // big blind
const DEFAULT_MAX_BET = 10000;   // per-street cap

// Timer windows (the manager schedules these; the engine only declares them)
const DEAL_DELAY_MS = 15000;
const ACT_TIMEOUT_MS = 30000;
const NEXT_HAND_DELAY_MS = 10000;

const STREETS = ['preflop', 'flop', 'turn', 'river'];

/**
 * Multiplayer no-limit hold'em engine. Pure state machine like the other
 * table games - no database, no timers, no Discord. Hold'em is the first
 * game with hidden per-player information, so getView(state, userId) only
 * reveals the viewer's own hole cards (everyone's at showdown).
 */
const holdemEngine = {
    gameType: 'holdem',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'holdem',
            phase: 'waiting', // waiting -> acting (preflop..river) -> settled -> waiting
            street: null,
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            button: -1,
            community: [],
            deck: [],
            pot: 0,
            contributions: {}, // userId -> chips escrowed this hand (crash refunds)
            currentBet: 0,     // street total each in-hand seat must match
            activeSeat: null,
            handId: 0,
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
            case 'deal': this._deal(ctx, { userId, system }); break;
            case 'fold': this._fold(ctx, { userId }); break;
            case 'check': this._check(ctx, { userId }); break;
            case 'call': this._call(ctx, { userId }); break;
            case 'bet': this._raise(ctx, { userId, amount }); break;
            case 'timeout-act': this._timeoutAct(ctx, { system }); break;
            case 'next-hand': this._nextHand(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view: the viewer sees their own hole cards; everyone
     * else's stay hidden (a card count) until the showdown reveals them in
     * `results`. The deck never leaves the server.
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);
        const inHand = state.phase === 'acting';
        const mySeat = yourSeat === -1 ? null : state.seats[yourSeat];

        return {
            gameType: 'holdem',
            phase: state.phase,
            street: state.street,
            handId: state.handId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            button: state.button,
            pot: state.pot,
            currentBet: state.currentBet,
            activeSeat: state.activeSeat,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            toCall: mySeat && inHand && !mySeat.folded
                ? Math.max(0, state.currentBet - mySeat.streetBet)
                : 0,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            community: state.community.map(card => ({ ...card, label: formatCard(card) })),
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                isBot: s.isBot === true,
                folded: s.folded,
                streetBet: s.streetBet,
                totalWagered: s.totalWagered,
                cardCount: s.hand.length,
                cards: s.userId === userId
                    ? s.hand.map(card => ({ ...card, label: formatCard(card) }))
                    : null,
                isTurn: inHand && state.activeSeat === i,
                isButton: state.button === i,
                left: s.left,
                outcome: s.outcome,
                payout: s.payout
            }),
            results: state.results
        };
    },

    /**
     * Chips escrowed into an unfinished hand's pot, per user (folded
     * players included - their chips are in the pot but not yet settled).
     * @returns {Array<{userId: string, amount: number}>}
     */
    getEscrowRefunds(state) {
        if (state.phase !== 'acting') return [];
        return Object.entries(state.contributions)
            .filter(([, amount]) => amount > 0)
            .map(([userId, amount]) => ({ userId, amount }));
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

    _seatedCount(state) {
        return state.seats.filter(s => s !== null).length;
    },

    /** Next occupied seat index strictly after `from`, walking circularly. */
    _nextOccupied(state, from, predicate = () => true) {
        for (let step = 1; step <= SEAT_COUNT; step++) {
            const i = (from + step + SEAT_COUNT) % SEAT_COUNT;
            const s = state.seats[i];
            if (s && predicate(s)) return i;
        }
        return -1;
    },

    _inHandSeats(state) {
        return state.seats
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s && s.hand.length > 0 && !s.folded);
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
            hand: [],
            folded: false,
            streetBet: 0,
            totalWagered: 0,
            acted: false,
            left: false,
            outcome: null,
            payout: null
        };
        events.push({ type: 'sit', seat: index, userId, name });

        // A joiner mid-hand waits for the next deal; in waiting, reaching
        // two players arms the auto-deal timer.
        if (next.phase === 'waiting' && this._seatedCount(next) >= 2 && !next.timer) {
            next.timer = { action: 'deal', ms: DEAL_DELAY_MS };
            events.push({ type: 'deal-pending' });
        }
    },

    _leave(ctx, { userId }) {
        const { next, events } = ctx;
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'You are not seated.');
        const seatState = next.seats[index];

        if (next.phase === 'acting' && seatState.hand.length > 0 && !seatState.folded) {
            // Mid-hand: leaving folds; the chips already bet stay in the pot
            // and the seat clears after the hand settles.
            seatState.left = true;
            events.push({ type: 'leave', seat: index, userId, pending: true });
            this._foldSeat(ctx, index, { reason: 'left' });
            return;
        }

        next.seats[index] = null;
        events.push({ type: 'leave', seat: index, userId });

        if (next.phase === 'waiting' && this._seatedCount(next) < 2) {
            next.timer = null;
        }
    },

    _deal(ctx, { userId, system }) {
        const { next, events, rng } = ctx;
        if (next.phase !== 'waiting') throw new GameError('BAD_PHASE', 'A hand is already running.');
        if (!system && this._seatOf(next, userId) === -1) {
            throw new GameError('NOT_SEATED', 'Take a seat first.');
        }
        if (this._seatedCount(next) < 2) {
            throw new GameError('NOT_ENOUGH_PLAYERS', 'Hold\'em needs at least 2 players.');
        }

        next.handId += 1;
        next.deck = shuffle(buildDeck(), rng || Math.random);
        next.community = [];
        next.pot = 0;
        next.contributions = {};
        next.results = null;
        for (const s of next.seats) {
            if (!s) continue;
            s.hand = [];
            s.folded = false;
            s.streetBet = 0;
            s.totalWagered = 0;
            s.acted = false;
            s.outcome = null;
            s.payout = null;
        }

        next.button = this._nextOccupied(next, next.button === -1 ? SEAT_COUNT - 1 : next.button);

        // Two cards each, starting left of the button
        const order = [];
        let cursor = next.button;
        for (let i = 0; i < this._seatedCount(next); i++) {
            cursor = this._nextOccupied(next, cursor);
            order.push(cursor);
        }
        for (let round = 0; round < 2; round++) {
            for (const i of order) next.seats[i].hand.push(next.deck.pop());
        }

        // Blinds: heads-up the button posts the small blind
        const headsUp = order.length === 2;
        const sbSeat = headsUp ? next.button : order[0];
        const bbSeat = headsUp ? order[0] : order[1];
        const sb = Math.max(1, Math.floor(next.minBet / 2));
        this._commitChips(ctx, sbSeat, sb, { blind: 'small' });
        this._commitChips(ctx, bbSeat, next.minBet, { blind: 'big' });
        next.currentBet = next.minBet;

        next.phase = 'acting';
        next.street = 'preflop';
        events.push({ type: 'deal', handId: next.handId });
        events.push({ type: 'blinds', small: { seat: sbSeat, amount: sb }, big: { seat: bbSeat, amount: next.minBet } });

        // First to act preflop: left of the big blind
        next.activeSeat = this._nextOccupied(next, bbSeat, s => !s.folded && s.hand.length > 0);
        next.timer = { action: 'timeout-act', ms: ACT_TIMEOUT_MS };
        events.push({ type: 'turn', seat: next.activeSeat, userId: next.seats[next.activeSeat].userId });
    },

    /** Move chips from a seat into the pot (escrow charge + bookkeeping). */
    _commitChips({ next, charges }, seatIndex, amount, detail = {}) {
        const s = next.seats[seatIndex];
        s.streetBet += amount;
        s.totalWagered += amount;
        next.pot += amount;
        next.contributions[s.userId] = (next.contributions[s.userId] || 0) + amount;
        charges.push({
            userId: s.userId,
            amount: -amount,
            type: 'table-holdem-bet',
            detail: { handId: next.handId, seat: seatIndex, street: next.street, ...detail }
        });
    },

    _requireTurn(next, userId) {
        const index = this._seatOf(next, userId);
        if (next.phase !== 'acting' || index === -1 || next.activeSeat !== index) {
            throw new GameError('NOT_YOUR_TURN', 'It is not your turn.');
        }
        return index;
    },

    _fold(ctx, { userId }) {
        const index = this._requireTurn(ctx.next, userId);
        this._foldSeat(ctx, index, {});
    },

    /** Fold a seat (turn action, leave, or timeout) and move the hand on. */
    _foldSeat(ctx, index, { reason = null, timeout = false }) {
        const { next, events } = ctx;
        const s = next.seats[index];
        s.folded = true;
        s.acted = true;
        events.push({ type: 'fold', seat: index, userId: s.userId, reason, timeout });

        const alive = this._inHandSeats(next);
        if (alive.length === 1) {
            this._awardUncontested(ctx, alive[0].i);
            return;
        }
        if (next.activeSeat === index) this._advance(ctx);
    },

    _check(ctx, { userId }) {
        const { next, events } = ctx;
        const index = this._requireTurn(next, userId);
        const s = next.seats[index];
        if (s.streetBet < next.currentBet) {
            throw new GameError('CANT_CHECK', 'There is a bet to call.');
        }
        s.acted = true;
        events.push({ type: 'check', seat: index, userId });
        this._advance(ctx);
    },

    _call(ctx, { userId }) {
        const { next, events } = ctx;
        const index = this._requireTurn(next, userId);
        const s = next.seats[index];
        const owed = next.currentBet - s.streetBet;
        if (owed <= 0) throw new GameError('NOTHING_TO_CALL', 'Nothing to call - check instead.');

        this._commitChips(ctx, index, owed, { call: true });
        s.acted = true;
        events.push({ type: 'call', seat: index, userId, amount: owed });
        this._advance(ctx);
    },

    /** Bet/raise TO `amount` for this street. */
    _raise(ctx, { userId, amount }) {
        const { next, events } = ctx;
        const index = this._requireTurn(next, userId);
        const s = next.seats[index];

        const minTotal = next.currentBet === 0 ? next.minBet : next.currentBet + next.minBet;
        if (!Number.isInteger(amount) || amount < minTotal || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Raise to a whole number between ${minTotal} and ${next.maxBet}.`);
        }
        if (amount <= s.streetBet) throw new GameError('BAD_BET', 'That does not raise anything.');

        this._commitChips(ctx, index, amount - s.streetBet, { raiseTo: amount });
        next.currentBet = amount;
        s.acted = true;
        // Everyone else must respond to the raise
        for (const { s: other, i } of this._inHandSeats(next)) {
            if (i !== index) other.acted = false;
        }
        events.push({ type: 'raise', seat: index, userId, amount });
        this._advance(ctx);
    },

    _timeoutAct(ctx, { system }) {
        const { next, events } = ctx;
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'acting' || next.activeSeat === null) return; // stale timer
        const index = next.activeSeat;
        const s = next.seats[index];

        if (s.streetBet >= next.currentBet) {
            s.acted = true;
            events.push({ type: 'check', seat: index, userId: s.userId, timeout: true });
            this._advance(ctx);
        } else {
            this._foldSeat(ctx, index, { timeout: true });
        }
    },

    /** Move the turn on; close the betting round / hand when it completes. */
    _advance(ctx) {
        const { next, events } = ctx;
        const alive = this._inHandSeats(next);

        const unresolved = alive.filter(({ s }) => !s.acted || s.streetBet < next.currentBet);
        if (unresolved.length > 0) {
            next.activeSeat = this._nextOccupied(
                next, next.activeSeat,
                s => !s.folded && s.hand.length > 0 && (!s.acted || s.streetBet < next.currentBet)
            );
            next.timer = { action: 'timeout-act', ms: ACT_TIMEOUT_MS };
            events.push({ type: 'turn', seat: next.activeSeat, userId: next.seats[next.activeSeat].userId });
            return;
        }

        // Betting round complete - next street or showdown
        const streetIndex = STREETS.indexOf(next.street);
        if (streetIndex === STREETS.length - 1) {
            this._showdown(ctx);
            return;
        }

        next.street = STREETS[streetIndex + 1];
        next.currentBet = 0;
        for (const { s } of alive) {
            s.streetBet = 0;
            s.acted = false;
        }
        const dealt = next.street === 'flop' ? 3 : 1;
        for (let i = 0; i < dealt; i++) next.community.push(next.deck.pop());
        events.push({
            type: 'street',
            street: next.street,
            cards: next.community.slice(-dealt).map(formatCard),
            community: next.community.map(formatCard)
        });

        // First to act postflop: left of the button
        next.activeSeat = this._nextOccupied(next, next.button, s => !s.folded && s.hand.length > 0);
        next.timer = { action: 'timeout-act', ms: ACT_TIMEOUT_MS };
        events.push({ type: 'turn', seat: next.activeSeat, userId: next.seats[next.activeSeat].userId });
    },

    /** Everyone else folded: the last player takes the pot without a reveal. */
    _awardUncontested(ctx, winnerIndex) {
        const { next, events, charges } = ctx;
        const s = next.seats[winnerIndex];
        s.outcome = 'win';
        s.payout = next.pot;
        charges.push({
            userId: s.userId,
            amount: next.pot,
            type: 'table-holdem-payout',
            detail: { handId: next.handId, seat: winnerIndex, uncontested: true }
        });

        next.results = {
            handId: next.handId,
            uncontested: true,
            pot: next.pot,
            community: next.community.map(formatCard),
            entries: [{
                seat: winnerIndex, userId: s.userId, name: s.name,
                outcome: 'win', payout: next.pot, hole: null, handName: null
            }]
        };
        this._finishHand(ctx);
        events.push({ type: 'win', seat: winnerIndex, userId: s.userId, payout: next.pot, uncontested: true });
        events.push({ type: 'settled', pot: next.pot, uncontested: true });
    },

    _showdown(ctx) {
        const { next, events, charges } = ctx;
        const alive = this._inHandSeats(next);

        const ranked = alive.map(({ s, i }) => {
            const best = bestHand([...s.hand, ...next.community]);
            return { s, i, best };
        });
        let top = ranked[0].best.evaluation;
        for (const r of ranked) {
            if (compareHands(r.best.evaluation, top) > 0) top = r.best.evaluation;
        }
        const winners = ranked.filter(r => compareHands(r.best.evaluation, top) === 0);

        const share = Math.floor(next.pot / winners.length);
        let remainder = next.pot - share * winners.length;
        const entries = [];

        for (const r of ranked) {
            const won = winners.includes(r);
            let payout = 0;
            if (won) {
                payout = share + (remainder > 0 ? 1 : 0);
                if (remainder > 0) remainder--;
                charges.push({
                    userId: r.s.userId,
                    amount: payout,
                    type: 'table-holdem-payout',
                    detail: { handId: next.handId, seat: r.i, hand: handName(r.best.evaluation) }
                });
            }
            r.s.outcome = won ? 'win' : 'lose';
            r.s.payout = payout;
            entries.push({
                seat: r.i,
                userId: r.s.userId,
                name: r.s.name,
                outcome: r.s.outcome,
                payout,
                hole: r.s.hand.map(formatCard),
                holeCards: r.s.hand.map(card => ({ ...card, label: formatCard(card) })),
                handName: handName(r.best.evaluation)
            });
            events.push({ type: won ? 'win' : 'lose', seat: r.i, userId: r.s.userId, payout, hand: handName(r.best.evaluation) });
        }

        next.results = {
            handId: next.handId,
            uncontested: false,
            pot: next.pot,
            community: next.community.map(formatCard),
            entries
        };
        this._finishHand(ctx);
        events.push({ type: 'settled', pot: next.pot });
    },

    _finishHand(ctx) {
        const { next } = ctx;
        next.phase = 'settled';
        next.street = null;
        next.activeSeat = null;
        next.currentBet = 0;
        next.contributions = {};
        next.timer = { action: 'next-hand', ms: NEXT_HAND_DELAY_MS };
    },

    _nextHand({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s) continue;
            if (s.left) { next.seats[i] = null; continue; }
            s.hand = [];
            s.folded = false;
            s.streetBet = 0;
            s.totalWagered = 0;
            s.acted = false;
            s.outcome = null;
            s.payout = null;
        }
        next.community = [];
        next.pot = 0;
        next.results = null;
        next.phase = 'waiting';
        next.street = null;
        next.timer = this._seatedCount(next) >= 2 ? { action: 'deal', ms: DEAL_DELAY_MS } : null;
        events.push({ type: 'hand-reset' });
    }
};

module.exports = holdemEngine;
