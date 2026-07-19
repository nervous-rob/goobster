const { buildDeck, shuffle, formatCard } = require('../../utils/pokerHands');
const { GameError } = require('./gameError');

// House rules (v1): punto banco with the standard tableau, 6-deck shoe
// reshuffled every round. Player pays 1:1, banker 1:1 minus 5% commission
// (rounded down), tie 8:1; player/banker bets push on a tie.
const DECKS = 6;
const SEAT_COUNT = 7;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 10000;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 20000;
const NEXT_ROUND_DELAY_MS = 8000;

const BET_TARGETS = new Set(['player', 'banker', 'tie']);

/** Baccarat value of a hand: pip sum mod 10 (ace = 1, tens/faces = 0). */
function handValue(cards) {
    let total = 0;
    for (const card of cards) {
        if (card.rank === 14) total += 1;
        else if (card.rank >= 10) total += 0;
        else total += card.rank;
    }
    return total % 10;
}

/** Baccarat value of a single card (the tableau keys off the player's third card). */
function cardValue(card) {
    if (card.rank === 14) return 1;
    if (card.rank >= 10) return 0;
    return card.rank;
}

/**
 * Whether the banker draws a third card, per the punto banco tableau.
 * @param {number} bankerTotal - banker's two-card total
 * @param {number|null} playerThird - value of the player's third card, or
 *   null when the player stood pat
 */
function bankerDraws(bankerTotal, playerThird) {
    if (playerThird === null) return bankerTotal <= 5;
    switch (bankerTotal) {
        case 0: case 1: case 2: return true;
        case 3: return playerThird !== 8;
        case 4: return playerThird >= 2 && playerThird <= 7;
        case 5: return playerThird >= 4 && playerThird <= 7;
        case 6: return playerThird === 6 || playerThird === 7;
        default: return false;
    }
}

/**
 * Multiplayer punto banco engine. Pure state machine like blackjack: no
 * database, no timers, no Discord. There are no player decisions after the
 * bet - the tableau plays both hands out - so a round settles in the same
 * transition that deals it.
 */
const baccaratEngine = {
    gameType: 'baccarat',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'baccarat',
            phase: 'waiting', // waiting -> betting -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            playerHand: [],
            bankerHand: [],
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
     * @param {Object} action - { userId, name, action, amount?, seat?, target?, system? }
     * @param {() => number} [rng] - injectable RNG for shuffles
     * @returns {{state: Object, events: Array, charges: Array}}
     * @throws {GameError} on illegal moves
     */
    applyAction(state, { userId = null, name = null, action, amount = null, seat = null, target = null, isBot = false, system = false }, rng = Math.random) {
        const next = structuredClone(state);
        const events = [];
        const charges = [];
        const ctx = { next, events, charges, rng };

        switch (action) {
            case 'sit': this._sit(ctx, { userId, name, seat, isBot }); break;
            case 'leave': this._leave(ctx, { userId }); break;
            case 'bet': this._bet(ctx, { userId, amount, target }); break;
            case 'deal': this._deal(ctx, { userId, system }); break;
            case 'next-round': this._nextRound(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view of the table. Baccarat has no hidden information -
     * both hands are communal and dealt face up.
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);

        return {
            gameType: 'baccarat',
            phase: state.phase,
            roundId: state.roundId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            playerHand: {
                cards: state.playerHand.map(card => ({ ...card, label: formatCard(card) })),
                total: state.playerHand.length > 0 ? handValue(state.playerHand) : null
            },
            bankerHand: {
                cards: state.bankerHand.map(card => ({ ...card, label: formatCard(card) })),
                total: state.bankerHand.length > 0 ? handValue(state.bankerHand) : null
            },
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                isBot: s.isBot === true,
                bet: s.bet,
                target: s.target,
                outcome: s.outcome,
                payout: s.payout
            }),
            results: state.results
        };
    },

    /**
     * Points escrowed in an undealt round, per user - what a crash recovery
     * must refund.
     * @returns {Array<{userId: string, amount: number}>}
     */
    getEscrowRefunds(state) {
        if (state.phase !== 'betting') return [];
        return state.seats
            .filter(s => s && s.bet > 0)
            .map(s => ({ userId: s.userId, amount: s.bet }));
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
            bet: 0,
            target: null,
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

        if (next.phase === 'betting' && seatState.bet > 0) {
            charges.push({
                userId,
                amount: seatState.bet,
                type: 'table-baccarat-refund',
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

    _bet(ctx, { userId, amount, target }) {
        const { next, events, charges } = ctx;
        if (next.phase !== 'waiting' && next.phase !== 'betting') {
            throw new GameError('BAD_PHASE', 'Bets are closed - wait for the next round.');
        }
        const index = this._seatOf(next, userId);
        if (index === -1) throw new GameError('NOT_SEATED', 'Take a seat before betting.');
        const seatState = next.seats[index];
        if (seatState.bet > 0) throw new GameError('ALREADY_BET', 'Your bet is already in.');
        if (!BET_TARGETS.has(target)) {
            throw new GameError('BAD_BET', 'Bet on player, banker, or tie.');
        }
        if (!Number.isInteger(amount) || amount < next.minBet || amount > next.maxBet) {
            throw new GameError('BAD_BET', `Bet must be a whole number between ${next.minBet} and ${next.maxBet}.`);
        }

        seatState.bet = amount;
        seatState.target = target;
        events.push({ type: 'bet', seat: index, userId, amount, target });
        charges.push({
            userId,
            amount: -amount,
            type: 'table-baccarat-bet',
            detail: { roundId: next.roundId + 1, seat: index, target }
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
        const deck = shuffle(
            Array.from({ length: DECKS }, () => buildDeck()).flat(),
            rng || Math.random
        );

        // Standard order: player, banker, player, banker
        next.playerHand = [deck.pop()];
        next.bankerHand = [deck.pop()];
        next.playerHand.push(deck.pop());
        next.bankerHand.push(deck.pop());
        events.push({ type: 'deal', roundId: next.roundId });

        const playerTwo = handValue(next.playerHand);
        const bankerTwo = handValue(next.bankerHand);
        const natural = playerTwo >= 8 || bankerTwo >= 8;

        let playerThird = null;
        if (!natural && playerTwo <= 5) {
            const card = deck.pop();
            next.playerHand.push(card);
            playerThird = cardValue(card);
            events.push({ type: 'player-card', card: formatCard(card), total: handValue(next.playerHand) });
        }
        if (!natural && bankerDraws(bankerTwo, playerThird)) {
            const card = deck.pop();
            next.bankerHand.push(card);
            events.push({ type: 'banker-card', card: formatCard(card), total: handValue(next.bankerHand) });
        }

        this._settle(ctx, { natural });
    },

    _settle(ctx, { natural }) {
        const { next, events, charges } = ctx;
        const playerTotal = handValue(next.playerHand);
        const bankerTotal = handValue(next.bankerHand);
        const winner = playerTotal > bankerTotal ? 'player'
            : bankerTotal > playerTotal ? 'banker'
                : 'tie';
        const entries = [];

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0) continue;

            let outcome;
            let payout = 0;
            if (s.target === winner) {
                outcome = 'win';
                if (winner === 'player') payout = s.bet * 2;
                else if (winner === 'banker') payout = s.bet + Math.floor(s.bet * 0.95);
                else payout = s.bet * 9;
            } else if (winner === 'tie') {
                // Player/banker bets push when the hands tie
                outcome = 'push';
                payout = s.bet;
            } else {
                outcome = 'lose';
            }

            s.outcome = outcome;
            s.payout = payout;
            if (payout > 0) {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-baccarat-payout',
                    detail: { roundId: next.roundId, seat: i, outcome, winner }
                });
            }
            entries.push({ seat: i, userId: s.userId, name: s.name, target: s.target, outcome, wagered: s.bet, payout });
            events.push({ type: outcome, seat: i, userId: s.userId, payout });
        }

        next.phase = 'settled';
        next.results = { roundId: next.roundId, winner, playerTotal, bankerTotal, natural, entries };
        next.timer = { action: 'next-round', ms: NEXT_ROUND_DELAY_MS };
        events.push({ type: 'settled', winner, playerTotal, bankerTotal });
    },

    _nextRound({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (const s of next.seats) {
            if (!s) continue;
            s.bet = 0;
            s.target = null;
            s.outcome = null;
            s.payout = null;
        }
        next.playerHand = [];
        next.bankerHand = [];
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'round-reset' });
    }
};

module.exports = baccaratEngine;
module.exports.handValue = handValue;
module.exports.bankerDraws = bankerDraws;
