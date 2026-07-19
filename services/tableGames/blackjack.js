const { buildDeck, shuffle, formatCard } = require('../../utils/pokerHands');
const { GameError } = require('./gameError');

// House rules (v1): 4-deck shoe, dealer stands on all 17s, blackjack pays
// 3:2 (rounded down), double on any first two cards, no splits yet.
const DECKS = 4;
const SEAT_COUNT = 5;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 10000;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 20000;
const ACT_TIMEOUT_MS = 25000;
const NEXT_HAND_DELAY_MS = 6000;

/** Blackjack value of a hand: total plus whether an ace counts as 11. */
function handValue(cards) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
        if (card.rank === 14) { total += 11; aces++; }
        else if (card.rank >= 11) total += 10;
        else total += card.rank;
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total, soft: aces > 0 };
}

function isBlackjack(cards) {
    return cards.length === 2 && handValue(cards).total === 21;
}

/**
 * Multiplayer blackjack engine. Pure state machine: no database, no timers,
 * no Discord - the table manager owns those. Every transition returns
 * `{ state, events, charges }`; charges are point movements the manager must
 * apply atomically with the state commit (negative = escrow a bet, positive
 * = payout). `state.timer` declares the next scheduled system action.
 */
const blackjackEngine = {
    gameType: 'blackjack',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'blackjack',
            phase: 'waiting', // waiting -> betting -> acting -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            dealer: { hand: [], revealed: false },
            deck: [],
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
    applyAction(state, { userId = null, name = null, action, amount = null, seat = null, system = false }, rng = Math.random) {
        const next = structuredClone(state);
        const events = [];
        const charges = [];
        const ctx = { next, events, charges, rng };

        switch (action) {
            case 'sit': this._sit(ctx, { userId, name, seat }); break;
            case 'leave': this._leave(ctx, { userId }); break;
            case 'bet': this._bet(ctx, { userId, amount }); break;
            case 'deal': this._deal(ctx, { userId, system }); break;
            case 'hit': this._hit(ctx, { userId }); break;
            case 'stand': this._stand(ctx, { userId }); break;
            case 'double': this._double(ctx, { userId }); break;
            case 'timeout-act': this._timeoutAct(ctx, { system }); break;
            case 'next-hand': this._nextHand(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view of the table. Blackjack is mostly public; the
     * dealer's hole card and the deck stay hidden until the reveal.
     */
    getView(state, userId = null) {
        const dealerCards = state.dealer.revealed
            ? state.dealer.hand
            : state.dealer.hand.slice(0, 1);
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);

        return {
            gameType: 'blackjack',
            phase: state.phase,
            handId: state.handId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            activeSeat: state.activeSeat,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            dealer: {
                cards: dealerCards.map(card => ({ ...card, label: formatCard(card) })),
                hiddenCard: !state.dealer.revealed && state.dealer.hand.length > 1,
                total: dealerCards.length > 0 ? handValue(dealerCards).total : null
            },
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                bet: s.bet,
                totalWagered: s.totalWagered,
                doubled: s.doubled,
                standing: s.standing,
                busted: s.busted,
                blackjack: s.blackjack,
                left: s.left,
                outcome: s.outcome,
                payout: s.payout,
                isTurn: state.phase === 'acting' && state.activeSeat === i,
                cards: s.hand.map(card => ({ ...card, label: formatCard(card) })),
                total: s.hand.length > 0 ? handValue(s.hand).total : null,
                soft: s.hand.length > 0 ? handValue(s.hand).soft : false
            }),
            results: state.results
        };
    },

    /**
     * Points escrowed in an unfinished hand, per user - what a crash
     * recovery must refund.
     * @returns {Array<{userId: string, amount: number}>}
     */
    getEscrowRefunds(state) {
        if (state.phase !== 'betting' && state.phase !== 'acting') return [];
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
            bet: 0,
            totalWagered: 0,
            hand: [],
            doubled: false,
            standing: false,
            busted: false,
            blackjack: false,
            left: false,
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

        if (next.phase === 'acting' && seatState.totalWagered > 0) {
            // Mid-hand: the hand plays out as a stand; the seat is flagged and
            // cleared after settlement so the payout still lands.
            seatState.left = true;
            seatState.standing = true;
            events.push({ type: 'leave', seat: index, userId, pending: true });
            if (next.activeSeat === index) this._advance(ctx);
            return;
        }

        if (next.phase === 'betting' && seatState.totalWagered > 0) {
            charges.push({
                userId,
                amount: seatState.totalWagered,
                type: 'table-blackjack-refund',
                detail: { handId: next.handId, reason: 'left-before-deal' }
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
                this._dealCards(ctx);
            }
        }
    },

    _bet(ctx, { userId, amount }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'waiting' && next.phase !== 'betting') {
            throw new GameError('BAD_PHASE', 'Bets are closed - wait for the next hand.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'Take a seat before betting.');
        const seatState = next.seats[index];
        if (seatState.bet > 0) throw new GameError('ALREADY_BET', 'Your bet is already in.');
        if (!Number.isInteger(amount) || amount < next.minBet || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Bet must be a whole number between ${next.minBet} and ${next.maxBet}.`);
        }

        seatState.bet = amount;
        seatState.totalWagered = amount;
        events.push({ type: 'bet', seat: index, userId, amount });
        charges.push({
            userId,
            amount: -amount,
            type: 'table-blackjack-bet',
            detail: { handId: next.handId + 1, seat: index }
        });

        if (next.phase === 'waiting') {
            next.phase = 'betting';
            next.timer = { action: 'deal', ms: BET_WINDOW_MS };
            events.push({ type: 'betting-open' });
        }
        if (this._allBetsIn(next)) {
            this._dealCards(ctx);
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
        this._dealCards(ctx);
    },

    _dealCards(ctx) {
        const { next, events, rng } = ctx;
        if (!next.seats.some(s => s && s.bet > 0)) {
            throw new GameError('NO_BETS', 'Nobody has bet yet.');
        }

        next.handId += 1;
        next.deck = shuffle(
            Array.from({ length: DECKS }, () => buildDeck()).flat(),
            rng || Math.random
        );
        next.dealer = { hand: [], revealed: false };

        // Seats without a bet sit this hand out
        for (const s of next.seats) {
            if (!s) continue;
            s.hand = [];
            s.doubled = false;
            s.standing = false;
            s.busted = false;
            s.blackjack = false;
            s.outcome = null;
            s.payout = null;
        }

        const inHand = next.seats.filter(s => s && s.bet > 0);
        for (let round = 0; round < 2; round++) {
            for (const s of inHand) s.hand.push(next.deck.pop());
            next.dealer.hand.push(next.deck.pop());
        }

        for (const s of inHand) {
            if (isBlackjack(s.hand)) {
                s.blackjack = true;
                s.standing = true;
            }
        }

        next.phase = 'acting';
        events.push({ type: 'deal', handId: next.handId });
        next.activeSeat = null;
        this._advance(ctx);
    },

    _requireTurn(next, userId) {
        const index = this._seatOf(next, userId);
        if (next.phase !== 'acting' || index === -1 || next.activeSeat !== index) {
            throw new GameError('NOT_YOUR_TURN', 'It is not your turn.');
        }
        return index;
    },

    _hit(ctx, { userId }) {
        const { next, events } = ctx;
        const index = this._requireTurn(next, userId);
        const seatState = next.seats[index];

        seatState.hand.push(next.deck.pop());
        const { total } = handValue(seatState.hand);
        events.push({ type: 'card', seat: index, card: formatCard(seatState.hand.at(-1)), total });

        if (total > 21) {
            seatState.busted = true;
            events.push({ type: 'bust', seat: index, userId });
            this._advance(ctx);
        } else if (total === 21) {
            seatState.standing = true;
            this._advance(ctx);
        } else {
            next.timer = { action: 'timeout-act', ms: ACT_TIMEOUT_MS };
        }
    },

    _stand(ctx, { userId }) {
        const { next, events } = ctx;
        const index = this._requireTurn(next, userId);
        next.seats[index].standing = true;
        events.push({ type: 'stand', seat: index, userId });
        this._advance(ctx);
    },

    _double(ctx, { userId }) {
        const { next, events, charges } = ctx;
        const index = this._requireTurn(next, userId);
        const seatState = next.seats[index];
        if (seatState.hand.length !== 2 || seatState.doubled) {
            throw new GameError('CANT_DOUBLE', 'Doubling is only allowed on your first two cards.');
        }

        charges.push({
            userId,
            amount: -seatState.bet,
            type: 'table-blackjack-bet',
            detail: { handId: next.handId, seat: index, double: true }
        });
        seatState.totalWagered += seatState.bet;
        seatState.doubled = true;

        seatState.hand.push(next.deck.pop());
        const { total } = handValue(seatState.hand);
        events.push({ type: 'double', seat: index, userId });
        events.push({ type: 'card', seat: index, card: formatCard(seatState.hand.at(-1)), total });
        if (total > 21) {
            seatState.busted = true;
            events.push({ type: 'bust', seat: index, userId });
        } else {
            seatState.standing = true;
        }
        this._advance(ctx);
    },

    _timeoutAct(ctx, { system }) {
        const { next, events } = ctx;
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'acting' || next.activeSeat === null) return; // stale timer
        const index = next.activeSeat;
        next.seats[index].standing = true;
        events.push({ type: 'stand', seat: index, userId: next.seats[index].userId, timeout: true });
        this._advance(ctx);
    },

    _nextHand({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s) continue;
            if (s.left) { next.seats[i] = null; continue; }
            s.bet = 0;
            s.totalWagered = 0;
            s.hand = [];
            s.doubled = false;
            s.standing = false;
            s.busted = false;
            s.blackjack = false;
            s.outcome = null;
            s.payout = null;
        }
        next.dealer = { hand: [], revealed: false };
        next.activeSeat = null;
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'hand-reset' });
    },

    /** Move the turn to the next undecided seat, or play out the dealer. */
    _advance(ctx) {
        const { next } = ctx;
        const start = next.activeSeat === null ? 0 : next.activeSeat + 1;
        for (let i = start; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (s && s.bet > 0 && !s.standing && !s.busted) {
                next.activeSeat = i;
                next.timer = { action: 'timeout-act', ms: ACT_TIMEOUT_MS };
                ctx.events.push({ type: 'turn', seat: i, userId: s.userId });
                return;
            }
        }
        next.activeSeat = null;
        this._dealerPlay(ctx);
    },

    _dealerPlay(ctx) {
        const { next, events } = ctx;
        next.dealer.revealed = true;
        events.push({ type: 'dealer-reveal', card: formatCard(next.dealer.hand[1]) });

        const anyoneStanding = next.seats.some(s => s && s.bet > 0 && !s.busted);
        if (anyoneStanding) {
            // Stand on all 17s
            while (handValue(next.dealer.hand).total < 17) {
                next.dealer.hand.push(next.deck.pop());
                events.push({
                    type: 'dealer-card',
                    card: formatCard(next.dealer.hand.at(-1)),
                    total: handValue(next.dealer.hand).total
                });
            }
        }
        this._settle(ctx);
    },

    _settle(ctx) {
        const { next, events, charges } = ctx;
        const dealerTotal = handValue(next.dealer.hand).total;
        const dealerBust = dealerTotal > 21;
        const dealerBlackjack = isBlackjack(next.dealer.hand);
        const results = [];

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0) continue;

            const total = handValue(s.hand).total;
            let outcome;
            let payout = 0;

            if (s.busted) {
                outcome = 'bust';
            } else if (s.blackjack && !dealerBlackjack) {
                outcome = 'blackjack';
                payout = s.totalWagered + Math.floor(s.totalWagered * 1.5);
            } else if (dealerBust || total > dealerTotal) {
                outcome = 'win';
                payout = s.totalWagered * 2;
            } else if ((s.blackjack && dealerBlackjack) || total === dealerTotal) {
                outcome = 'push';
                payout = s.totalWagered;
            } else {
                outcome = 'lose';
            }

            s.outcome = outcome;
            s.payout = payout;
            if (payout > 0) {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-blackjack-payout',
                    detail: { handId: next.handId, seat: i, outcome }
                });
            }
            results.push({ seat: i, userId: s.userId, name: s.name, outcome, wagered: s.totalWagered, payout, total });
            events.push({ type: outcome === 'push' ? 'push' : outcome === 'bust' || outcome === 'lose' ? 'lose' : outcome, seat: i, userId: s.userId, payout });
        }

        next.phase = 'settled';
        next.results = { handId: next.handId, dealerTotal, dealerBust, entries: results };
        next.timer = { action: 'next-hand', ms: NEXT_HAND_DELAY_MS };
        events.push({ type: 'settled', dealerTotal, dealerBust });
    }
};

module.exports = blackjackEngine;
module.exports.GameError = GameError;
module.exports.handValue = handValue;
