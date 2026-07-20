/**
 * Unit tests for the pure Let It Ride engine (services/tableGames/letride.js).
 * No database needed. The paytable is tested directly as a pure function;
 * decision flows run on hand-built ride-phase states (documented state
 * shape) so hands and community cards are exact.
 */
const engine = require('../services/tableGames/letride');
const { payoutMultiple } = require('../services/tableGames/letride');
const { evaluateHand } = require('../utils/pokerHands');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

function card(rank, suit = 'S') {
    const rankMap = { A: 14, K: 13, Q: 12, J: 11 };
    return { rank: rankMap[rank] || Number(rank), suit };
}

function seated(users = [ALICE]) {
    let state = engine.createTable();
    for (const userId of users) {
        ({ state } = engine.applyAction(state, { userId, name: `p${userId.slice(-1)}`, action: 'sit' }));
    }
    return state;
}

/**
 * A hand-built ride1 state: ALICE holds a pair of kings + 4, BOB holds
 * junk; the face-down community cards are a king and a 2.
 */
function ride1State({ withBob = true } = {}) {
    const state = engine.createTable();
    state.phase = 'ride1';
    state.roundId = 1;
    state.community = [card('K', 'D'), card(2, 'C')];
    state.seats[0] = {
        userId: ALICE, name: 'alice', isBot: false, bet: 100, spots: 3,
        hand: [card('K', 'S'), card('K', 'H'), card(4, 'S')],
        decision: null, handName: null, outcome: null, payout: null, left: false
    };
    if (withBob) {
        state.seats[1] = {
            userId: BOB, name: 'bob', isBot: false, bet: 50, spots: 3,
            hand: [card(2, 'S'), card(7, 'H'), card(9, 'D')],
            decision: null, handName: null, outcome: null, payout: null, left: false
        };
    }
    return state;
}

describe('the paytable', () => {
    const pays = cards => payoutMultiple(evaluateHand(cards));

    test('pair of tens or better pays 1:1; low pairs lose', () => {
        expect(pays([card(10, 'S'), card(10, 'H'), card(2, 'S'), card(5, 'D'), card(9, 'C')])).toBe(1);
        expect(pays([card(9, 'S'), card(9, 'H'), card(2, 'S'), card(5, 'D'), card('K', 'C')])).toBe(-1);
        expect(pays([card('A', 'S'), card('K', 'H'), card(2, 'S'), card(5, 'D'), card(9, 'C')])).toBe(-1);
    });

    test('the big hands scale up to the royal', () => {
        expect(pays([card(3, 'S'), card(3, 'H'), card(6, 'S'), card(6, 'D'), card(9, 'C')])).toBe(2);
        expect(pays([card(7, 'S'), card(7, 'H'), card(7, 'D'), card(5, 'D'), card(9, 'C')])).toBe(3);
        expect(pays([card(5, 'S'), card(6, 'H'), card(7, 'D'), card(8, 'D'), card(9, 'C')])).toBe(5);
        expect(pays([card(2, 'S'), card(6, 'S'), card(7, 'S'), card(8, 'S'), card('J', 'S')])).toBe(8);
        expect(pays([card(7, 'S'), card(7, 'H'), card(7, 'D'), card(9, 'C'), card(9, 'S')])).toBe(11);
        expect(pays([card(7, 'S'), card(7, 'H'), card(7, 'D'), card(7, 'C'), card(9, 'S')])).toBe(50);
        expect(pays([card(5, 'S'), card(6, 'S'), card(7, 'S'), card(8, 'S'), card(9, 'S')])).toBe(200);
        expect(pays([card(10, 'S'), card('J', 'S'), card('Q', 'S'), card('K', 'S'), card('A', 'S')])).toBe(1000);
    });
});

describe('betting and dealing', () => {
    test('the ante escrows three equal bets', () => {
        const state = seated([ALICE, BOB]);
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -300, type: 'table-letride-bet'
        }));
        expect(result.state.seats[0]).toMatchObject({ bet: 100, spots: 3 });
        expect(result.state.phase).toBe('betting');
    });

    test('all bets in deals three cards each and moves to ride1', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 }));
        const result = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50 });

        expect(result.state.phase).toBe('ride1');
        expect(result.state.seats[0].hand).toHaveLength(3);
        expect(result.state.community).toHaveLength(2);
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'timeout-ride' }));
    });

    test('leaving during betting refunds all three bets', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 80 }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 240, type: 'table-letride-refund'
        }));
    });
});

describe('ride decisions', () => {
    test('pulling back refunds one bet; riding keeps it; the phase advances when all decide', () => {
        const state = ride1State();
        const afterAlice = engine.applyAction(state, { userId: ALICE, action: 'ride' });
        expect(afterAlice.state.phase).toBe('ride1'); // BOB still deciding
        expect(afterAlice.charges).toHaveLength(0);

        const afterBob = engine.applyAction(afterAlice.state, { userId: BOB, action: 'pull' });
        expect(afterBob.charges).toContainEqual(expect.objectContaining({
            userId: BOB, amount: 50, type: 'table-letride-refund'
        }));
        expect(afterBob.state.phase).toBe('ride2');
        expect(afterBob.state.seats[0].spots).toBe(3);
        expect(afterBob.state.seats[1].spots).toBe(2);
        // Decisions reset for the second choice
        expect(afterBob.state.seats[0].decision).toBeNull();
    });

    test('double decisions and off-phase decisions are rejected', () => {
        const state = ride1State();
        const { state: decided } = engine.applyAction(state, { userId: ALICE, action: 'ride' });
        expect(() => engine.applyAction(decided, { userId: ALICE, action: 'pull' }))
            .toThrow(expect.objectContaining({ code: 'ALREADY_DECIDED' }));

        const fresh = seated([ALICE]);
        expect(() => engine.applyAction(fresh, { userId: ALICE, action: 'ride' }))
            .toThrow(expect.objectContaining({ code: 'BAD_PHASE' }));
    });

    test('the timeout pulls back for undecided players', () => {
        const state = ride1State();
        const result = engine.applyAction(state, { action: 'timeout-ride', system: true });
        expect(result.state.phase).toBe('ride2');
        expect(result.state.seats[0].spots).toBe(2);
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 100 }));
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'pull', seat: 0, timeout: true }));
    });

    test('a full ride pays trips on every spot at showdown', () => {
        // ALICE: K K 4 + community K 2 = three kings (3:1 on each spot)
        let state = ride1State({ withBob: false });
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'ride' }));
        expect(state.phase).toBe('ride2');
        const result = engine.applyAction(state, { userId: ALICE, action: 'ride' });

        expect(result.state.phase).toBe('settled');
        // 3 spots x 100 x (3 + 1) = 1200
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 1200, type: 'table-letride-payout'
        }));
        expect(result.state.seats[0]).toMatchObject({ outcome: 'win', handName: 'Three of a Kind' });
        expect(result.state.results.entries[0].holeCards).toHaveLength(3);
    });

    test('pulling both bets still rides the third', () => {
        let state = ride1State({ withBob: false });
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'pull' }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'pull' });
        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0].spots).toBe(1);
        // 1 spot x 100 x (3 + 1) = 400
        expect(result.state.seats[0].payout).toBe(400);
    });

    test('a losing hand pays nothing', () => {
        const state = ride1State();
        state.seats[0] = null; // BOB only: junk hand
        const { state: mid } = engine.applyAction(state, { userId: BOB, action: 'ride' });
        const result = engine.applyAction(mid, { userId: BOB, action: 'ride' });
        expect(result.state.seats[1]).toMatchObject({ outcome: 'lose', payout: 0 });
        expect(result.charges.filter(c => c.type === 'table-letride-payout')).toHaveLength(0);
    });
});

describe('hidden information and views', () => {
    test('hole cards are private until showdown', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50 }));

        const aliceView = engine.getView(state, ALICE);
        expect(aliceView.seats[0].cards).toHaveLength(3);
        expect(aliceView.seats[1].cards).toBeNull();
        expect(aliceView.seats[1].cardCount).toBe(3);
        expect(aliceView.community).toHaveLength(0);
        expect(aliceView.communityCount).toBe(2);
    });

    test('community cards reveal by phase', () => {
        let state = ride1State({ withBob: false });
        expect(engine.getView(state, ALICE).community).toHaveLength(0);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'ride' }));
        expect(engine.getView(state, ALICE).community).toHaveLength(1);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'ride' }));
        const view = engine.getView(state, ALICE);
        expect(view.community).toHaveLength(2);
        expect(view.seats[0].handName).toBe('Three of a Kind');
    });

    test('escrow refunds track the bets still riding', () => {
        let state = ride1State({ withBob: false });
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 300 }]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'pull' }));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 200 }]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'ride' }));
        expect(engine.getEscrowRefunds(state)).toEqual([]); // settled
    });

    test('mid-hand leavers ride to showdown and clear next round', () => {
        let state = ride1State({ withBob: false });
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'leave' }));
        expect(state.seats[0]).toMatchObject({ left: true, decision: 'ride' });
        expect(state.phase).toBe('ride2');

        // The remaining decision times out (pull), then the hand settles
        ({ state } = engine.applyAction(state, { action: 'timeout-ride', system: true }));
        expect(state.phase).toBe('settled');
        expect(state.seats[0].payout).toBeGreaterThan(0);

        ({ state } = engine.applyAction(state, { action: 'next-round', system: true }));
        expect(state.seats[0]).toBeNull();
    });

    test('next-round resets hands and bets', () => {
        let state = ride1State({ withBob: false });
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'ride' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'ride' }));
        expect(state.phase).toBe('settled');

        const result = engine.applyAction(state, { action: 'next-round', system: true });
        expect(result.state.phase).toBe('waiting');
        expect(result.state.seats[0]).toMatchObject({ bet: 0, spots: 0, hand: [] });
        expect(result.state.community).toHaveLength(0);

        expect(() => engine.applyAction(state, { userId: ALICE, action: 'next-round' }))
            .toThrow(expect.objectContaining({ code: 'SYSTEM_ONLY' }));
    });
});
