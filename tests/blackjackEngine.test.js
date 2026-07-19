/**
 * Unit tests for the pure blackjack engine (services/tableGames/blackjack.js).
 * No database needed - the engine is a pure state machine. Deterministic
 * hands are produced by stacking the deck after the (RNG-seeded) shuffle.
 */
const engine = require('../services/tableGames/blackjack');
const { handValue } = require('../services/tableGames/blackjack');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

function card(rank, suit = 'S') {
    const rankMap = { A: 14, K: 13, Q: 12, J: 11 };
    return { rank: rankMap[rank] || Number(rank), suit };
}

// An RNG stuck just below 1 makes the Fisher-Yates shuffle the identity
// permutation, so a "shuffled" shoe pops cards in a known order:
// A♣, K♣, Q♣, J♣, 10♣, ... (deal order: P1, D1, P2, D2).
const identityRng = () => 0.999999;

/**
 * Construct a mid-hand acting state directly (the documented engine state
 * shape): Alice seated at seat 0 with `bet` escrowed, holding `alice`,
 * dealer holding `dealer` (hole card down), future hits popping from `rest`
 * in order.
 */
function dealStacked({ bet = 100, alice, dealer, rest = [] }) {
    let state = engine.createTable();
    ({ state } = engine.applyAction(state, { userId: ALICE, name: 'Alice', action: 'sit' }));

    const dealt = structuredClone(state);
    dealt.phase = 'acting';
    dealt.handId = 1;
    dealt.activeSeat = 0;
    dealt.timer = { action: 'timeout-act', ms: 25000 };
    dealt.deck = [...rest].reverse(); // pop() takes from the end
    dealt.dealer = { hand: [...dealer], revealed: false };

    const seat = dealt.seats[0];
    seat.bet = bet;
    seat.totalWagered = bet;
    seat.hand = [...alice];
    if (seat.hand.length === 2 && handValue(seat.hand).total === 21) {
        seat.blackjack = true;
        seat.standing = true;
    }
    return { state: dealt };
}

describe('hand values', () => {
    test('aces flex from 11 to 1', () => {
        expect(handValue([card('A'), card('K')])).toEqual({ total: 21, soft: true });
        expect(handValue([card('A'), card('A'), card(9)])).toEqual({ total: 21, soft: true });
        expect(handValue([card('A'), card('K'), card('Q')])).toEqual({ total: 21, soft: false });
        expect(handValue([card('A'), card('A'), card('K'), card('Q')])).toEqual({ total: 22, soft: false });
    });

    test('face cards count 10', () => {
        expect(handValue([card('J'), card('Q')]).total).toBe(20);
    });
});

describe('seating and betting', () => {
    test('sit, bet, and escrow charge', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, name: 'Alice', action: 'sit', seat: 2 }));
        expect(state.seats[2].userId).toBe(ALICE);

        // A second sit by the same user is rejected
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'sit' }))
            .toThrow(expect.objectContaining({ code: 'ALREADY_SEATED' }));

        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-blackjack-bet'
        }));
        // Single player with a bet: the hand deals immediately
        expect(result.state.phase).toBe('acting');
        expect(result.state.seats[2].hand).toHaveLength(2);
        expect(result.state.dealer.hand).toHaveLength(2);
    });

    test('bets below the minimum and off-seat bets are rejected', () => {
        let state = engine.createTable();
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 }))
            .toThrow(expect.objectContaining({ code: 'NOT_SEATED' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 5 }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
    });

    test('two players: hand starts when both bets are in', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, name: 'Alice', action: 'sit' }));
        ({ state } = engine.applyAction(state, { userId: BOB, name: 'Bob', action: 'sit' }));

        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }));
        expect(state.phase).toBe('betting');
        expect(state.timer).toEqual(expect.objectContaining({ action: 'deal' }));

        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 75 }));
        expect(state.phase).toBe('acting');
        expect(state.seats[0].hand).toHaveLength(2);
        expect(state.seats[1].hand).toHaveLength(2);
    });

    test('leaving during betting refunds the escrow and reverts to waiting', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'sit' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }));

        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 50, type: 'table-blackjack-refund'
        }));
        expect(result.state.phase).toBe('waiting');
        expect(result.state.timer).toBeNull();
    });
});

describe('play and settlement', () => {
    test('player win pays even money', () => {
        const { state } = dealStacked({
            alice: [card('K'), card('Q')],           // 20
            dealer: [card(9), card(8)]               // 17 - dealer stands
        });
        const result = engine.applyAction(state, { userId: ALICE, action: 'stand' });
        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0].outcome).toBe('win');
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 200, type: 'table-blackjack-payout'
        }));
    });

    test('dealer hits to 17 and can bust', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(9)],             // 19
            dealer: [card(6), card('10')],           // 16 -> must hit
            rest: [card('K')]                        // dealer draws K -> 26 bust
        });
        const result = engine.applyAction(state, { userId: ALICE, action: 'stand' });
        expect(result.state.results.dealerBust).toBe(true);
        expect(result.state.seats[0].outcome).toBe('win');
    });

    test('bust loses immediately, no payout', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(6)],             // 16
            dealer: [card(9), card(8)],
            rest: [card('Q')]                        // hit -> 26 bust
        });
        const result = engine.applyAction(state, { userId: ALICE, action: 'hit' });
        expect(result.state.seats[0].busted).toBe(true);
        expect(result.state.seats[0].outcome).toBe('bust');
        expect(result.charges.filter(c => c.type === 'table-blackjack-payout')).toHaveLength(0);
        // Dealer doesn't draw when everyone busted
        expect(result.state.dealer.hand).toHaveLength(2);
    });

    test('push returns the stake', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(9)],             // 19
            dealer: [card('10'), card(9)]            // 19
        });
        const result = engine.applyAction(state, { userId: ALICE, action: 'stand' });
        expect(result.state.seats[0].outcome).toBe('push');
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 100 }));
    });

    test('natural blackjack settles during the deal and pays 3:2', () => {
        // Identity shuffle: pop order is A♣, K♣, Q♣, J♣ - deal order P,D,P,D
        // gives Alice A+Q (natural 21) and the dealer K+J (20).
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, name: 'Alice', action: 'sit' }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 }, identityRng);

        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0].blackjack).toBe(true);
        expect(result.state.seats[0].outcome).toBe('blackjack');
        // 100 escrowed -> 100 back + 150 winnings
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 250, type: 'table-blackjack-payout'
        }));
    });

    test('double takes a second escrow and one card only', () => {
        const { state } = dealStacked({
            alice: [card(5), card(6)],               // 11 - classic double
            dealer: [card(9), card(8)],              // 17
            rest: [card('K')]                        // double card -> 21
        });
        const result = engine.applyAction(state, { userId: ALICE, action: 'double' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-blackjack-bet'
        }));
        expect(result.state.seats[0].hand).toHaveLength(3);
        expect(result.state.seats[0].outcome).toBe('win');
        // 200 wagered -> 400 back
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 400, type: 'table-blackjack-payout'
        }));
    });

    test('acting out of turn is rejected', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'sit' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50 }));
        expect(state.phase).toBe('acting');
        expect(state.activeSeat).toBe(0);
        expect(() => engine.applyAction(state, { userId: BOB, action: 'hit' }))
            .toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    });

    test('turn timeout auto-stands the active seat', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(9)],
            dealer: [card('10'), card(8)]
        });
        const result = engine.applyAction(state, { action: 'timeout-act', system: true });
        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0].outcome).toBe('win'); // 19 vs 18
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'stand', timeout: true }));
    });

    test('next-hand resets seats and clears leavers', () => {
        const { state } = dealStacked({
            alice: [card('K'), card('Q')],
            dealer: [card(9), card(8)]
        });
        let result = engine.applyAction(state, { userId: ALICE, action: 'stand' });
        expect(result.state.phase).toBe('settled');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'next-hand' }));

        result = engine.applyAction(result.state, { action: 'next-hand', system: true });
        expect(result.state.phase).toBe('waiting');
        expect(result.state.seats[0]).toMatchObject({ userId: ALICE, bet: 0, hand: [] });
        expect(result.state.results).toBeNull();
    });

    test('escrow refunds cover unfinished hands only', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(6)],
            dealer: [card(9), card(8)]
        });
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 100 }]);

        const settled = engine.applyAction(state, { userId: ALICE, action: 'stand' }).state;
        expect(engine.getEscrowRefunds(settled)).toEqual([]);
    });

    test('players cannot fire system actions', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(6)],
            dealer: [card(9), card(8)]
        });
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'timeout-act' }))
            .toThrow(expect.objectContaining({ code: 'SYSTEM_ONLY' }));
    });
});

describe('views', () => {
    test("the dealer's hole card is hidden until the reveal", () => {
        const { state } = dealStacked({
            alice: [card('K'), card(6)],
            dealer: [card(9), card(8)]
        });
        const view = engine.getView(state, ALICE);
        expect(view.dealer.cards).toHaveLength(1);
        expect(view.dealer.hiddenCard).toBe(true);
        expect(view.yourSeat).toBe(0);
        expect(view.seats[0].isTurn).toBe(true);

        const settled = engine.applyAction(state, { userId: ALICE, action: 'stand' }).state;
        const settledView = engine.getView(settled, ALICE);
        expect(settledView.dealer.cards).toHaveLength(2);
        expect(settledView.dealer.hiddenCard).toBe(false);
    });

    test('spectators get a view with no seat', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(6)],
            dealer: [card(9), card(8)]
        });
        const view = engine.getView(state, BOB);
        expect(view.yourSeat).toBeNull();
    });

    test('the raw deck never appears in a view', () => {
        const { state } = dealStacked({
            alice: [card('K'), card(6)],
            dealer: [card(9), card(8)]
        });
        const view = engine.getView(state, ALICE);
        expect(JSON.stringify(view)).not.toContain('"deck"');
    });
});
