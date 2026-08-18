const { buildDeck, shuffle, formatCard } = require('../../utils/pokerHands');
const { GameError } = require('./gameError');

// House rules (v1): Casino War, 6-deck shoe reshuffled every round. One
// card to each bettor and one communal dealer card; higher rank wins even
// money (aces high). A tie sends that seat to war: surrender for half the
// bet back (rounded down), or go to war by matching the original bet - a
// fresh communal dealer card is drawn, each warring seat gets a card, and
// winning (or tying) the war returns both bets plus even money on the
// original; tying the war doubles that bonus.
const DECKS = 6;
const SEAT_COUNT = 6;
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 10000;

// Timer windows (the manager schedules these; the engine only declares them)
const BET_WINDOW_MS = 20000;
const WAR_DECISION_MS = 15000;
const NEXT_ROUND_DELAY_MS = 7000;

/**
 * Multiplayer Casino War engine. Pure state machine like the other tables:
 * no database, no timers, no Discord - every transition returns
 * `{ state, events, charges }` and the manager owns the side effects.
 * The only player decision is war-or-surrender after a tie, made
 * simultaneously by every tied seat (phase 'war').
 */
const warEngine = {
    gameType: 'war',
    seatCount: SEAT_COUNT,

    /**
     * A fresh, empty table.
     */
    createTable({ minBet = DEFAULT_MIN_BET, maxBet = DEFAULT_MAX_BET } = {}) {
        return {
            gameType: 'war',
            phase: 'waiting', // waiting -> betting -> [war] -> settled -> waiting
            seats: Array.from({ length: SEAT_COUNT }, () => null),
            dealerCard: null,
            warDealerCard: null,
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
            case 'war': this._war(ctx, { userId }); break;
            case 'surrender': this._surrender(ctx, { userId }); break;
            case 'timeout-war': this._timeoutWar(ctx, { system }); break;
            case 'next-round': this._nextRound(ctx, { system }); break;
            default: throw new GameError('BAD_ACTION', `Unknown action "${action}".`);
        }

        return { state: next, events, charges };
    },

    /**
     * Personalized view of the table. War has no hidden information - every
     * card is dealt face up; only the shoe stays on the server.
     */
    getView(state, userId = null) {
        const yourSeat = state.seats.findIndex(s => s && s.userId === userId);
        const label = card => (card ? { ...card, label: formatCard(card) } : null);

        return {
            gameType: 'war',
            phase: state.phase,
            roundId: state.roundId,
            minBet: state.minBet,
            maxBet: state.maxBet,
            yourSeat: yourSeat === -1 ? null : yourSeat,
            timerMs: state.timer?.ms ?? null,
            timerAction: state.timer?.action ?? null,
            dealerCard: label(state.dealerCard),
            warDealerCard: label(state.warDealerCard),
            seats: state.seats.map((s, i) => s && {
                seat: i,
                userId: s.userId,
                name: s.name,
                isBot: s.isBot === true,
                bet: s.bet,
                totalWagered: s.totalWagered,
                card: label(s.card),
                warCard: label(s.warCard),
                atWar: s.atWar,
                decided: s.atWar ? s.warDecision !== null : null,
                outcome: s.outcome,
                payout: s.payout
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
        if (state.phase !== 'betting' && state.phase !== 'war') return [];
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
            totalWagered: 0,
            card: null,
            warCard: null,
            atWar: false,
            warDecision: null, // 'war' | 'surrender' once decided
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

        if (next.phase === 'war' && seatState.atWar && seatState.warDecision === null) {
            // Leaving mid-tie counts as a surrender so the round can finish
            this._applySurrender(ctx, index);
            next.seats[index] = null;
            events.push({ type: 'leave', seat: index, userId });
            this._maybeFinishWar(ctx);
            return;
        }

        if (next.phase === 'betting' && seatState.totalWagered > 0) {
            charges.push({
                userId,
                amount: seatState.totalWagered,
                type: 'table-war-refund',
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
            type: 'table-war-bet',
            detail: { roundId: next.roundId + 1, seat: index }
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
        next.deck = shuffle(
            Array.from({ length: DECKS }, () => buildDeck()).flat(),
            rng || Math.random
        );
        next.warDealerCard = null;

        for (const s of next.seats) {
            if (!s) continue;
            s.card = null;
            s.warCard = null;
            s.atWar = false;
            s.warDecision = null;
            s.outcome = null;
            s.payout = null;
        }

        const inRound = next.seats.filter(s => s && s.bet > 0);
        for (const s of inRound) s.card = next.deck.pop();
        next.dealerCard = next.deck.pop();
        events.push({ type: 'deal', roundId: next.roundId });

        let ties = 0;
        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0) continue;
            if (s.card.rank === next.dealerCard.rank) {
                s.atWar = true;
                ties++;
                events.push({ type: 'tie', seat: i, userId: s.userId });
            }
        }

        if (ties > 0) {
            next.phase = 'war';
            next.timer = { action: 'timeout-war', ms: WAR_DECISION_MS };
            return;
        }
        this._settle(ctx);
    },

    _requireAtWar(next, userId) {
        const index = this._seatOf(next, userId);
        if (next.phase !== 'war' || index === -1 || !next.seats[index].atWar || next.seats[index].warDecision !== null) {
            throw new GameError('NOT_AT_WAR', 'You have no tie to settle.');
        }
        return index;
    },

    _war(ctx, { userId }) {
        const { next, events, charges } = ctx;
        const index = this._requireAtWar(next, userId);
        const seatState = next.seats[index];

        charges.push({
            userId,
            amount: -seatState.bet,
            type: 'table-war-bet',
            detail: { roundId: next.roundId, seat: index, war: true }
        });
        seatState.totalWagered += seatState.bet;
        seatState.warDecision = 'war';
        events.push({ type: 'war', seat: index, userId });
        this._maybeFinishWar(ctx);
    },

    _surrender(ctx, { userId }) {
        const { next, events } = ctx;
        const index = this._requireAtWar(next, userId);
        this._applySurrender(ctx, index);
        events.push({ type: 'surrender', seat: index, userId, payout: next.seats[index].payout });
        this._maybeFinishWar(ctx);
    },

    /** Half the bet back (rounded down), decided but out of the war round. */
    _applySurrender(ctx, index) {
        const { next, charges } = ctx;
        const seatState = next.seats[index];
        const refund = Math.floor(seatState.bet / 2);
        seatState.warDecision = 'surrender';
        seatState.outcome = 'surrender';
        seatState.payout = refund;
        if (refund > 0) {
            charges.push({
                userId: seatState.userId,
                amount: refund,
                type: 'table-war-payout',
                detail: { roundId: next.roundId, seat: index, outcome: 'surrender' }
            });
        }
    },

    _timeoutWar(ctx, { system }) {
        const { next, events } = ctx;
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'war') return; // stale timer
        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (s && s.atWar && s.warDecision === null) {
                this._applySurrender(ctx, i);
                events.push({ type: 'surrender', seat: i, userId: s.userId, payout: s.payout, timeout: true });
            }
        }
        this._maybeFinishWar(ctx);
    },

    /** Once every tied seat has decided, play out the war (if anyone raised). */
    _maybeFinishWar(ctx) {
        const { next, events } = ctx;
        if (next.phase !== 'war') return;
        const undecided = next.seats.some(s => s && s.atWar && s.warDecision === null);
        if (undecided) return;

        const warring = next.seats.filter(s => s && s.warDecision === 'war');
        if (warring.length > 0) {
            // Traditional burn, then one new card each and a fresh dealer card
            next.deck.splice(-3, 3);
            for (const s of warring) s.warCard = next.deck.pop();
            next.warDealerCard = next.deck.pop();
            events.push({ type: 'war-cards', dealer: formatCard(next.warDealerCard) });
        }
        this._settle(ctx);
    },

    _settle(ctx) {
        const { next, events, charges } = ctx;
        const dealerRank = next.dealerCard.rank;
        const entries = [];

        for (let i = 0; i < next.seats.length; i++) {
            const s = next.seats[i];
            if (!s || s.bet === 0) continue;

            let outcome = s.outcome; // surrendered seats settled already
            let payout = s.payout ?? 0;

            if (outcome === null) {
                if (s.warDecision === 'war') {
                    // War round: winning OR tying beats the dealer; a tie
                    // doubles the even-money bonus on the original bet.
                    if (s.warCard.rank > next.warDealerCard.rank) {
                        outcome = 'win';
                        payout = s.totalWagered + s.bet;
                    } else if (s.warCard.rank === next.warDealerCard.rank) {
                        outcome = 'win';
                        payout = s.totalWagered + s.bet * 2;
                    } else {
                        outcome = 'lose';
                    }
                } else if (s.card.rank > dealerRank) {
                    outcome = 'win';
                    payout = s.bet * 2;
                } else {
                    outcome = 'lose';
                }
            }

            s.outcome = outcome;
            s.payout = payout;
            if (payout > 0 && outcome !== 'surrender') {
                charges.push({
                    userId: s.userId,
                    amount: payout,
                    type: 'table-war-payout',
                    detail: { roundId: next.roundId, seat: i, outcome }
                });
            }
            entries.push({ seat: i, userId: s.userId, name: s.name, outcome, wagered: s.totalWagered, payout, wentToWar: s.warDecision === 'war' });
            if (outcome !== 'surrender') {
                events.push({ type: outcome, seat: i, userId: s.userId, payout, wagered: s.totalWagered });
            }
        }

        next.phase = 'settled';
        next.results = { roundId: next.roundId, dealerCard: formatCard(next.dealerCard), entries };
        next.timer = { action: 'next-round', ms: NEXT_ROUND_DELAY_MS };
        events.push({ type: 'settled' });
    },

    _nextRound({ next, events }, { system }) {
        if (!system) throw new GameError('SYSTEM_ONLY', 'Not a player action.');
        if (next.phase !== 'settled') return; // stale timer

        for (const s of next.seats) {
            if (!s) continue;
            s.bet = 0;
            s.totalWagered = 0;
            s.card = null;
            s.warCard = null;
            s.atWar = false;
            s.warDecision = null;
            s.outcome = null;
            s.payout = null;
        }
        next.dealerCard = null;
        next.warDealerCard = null;
        next.phase = 'waiting';
        next.results = null;
        next.timer = null;
        events.push({ type: 'round-reset' });
    }
};

module.exports = warEngine;
