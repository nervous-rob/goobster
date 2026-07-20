/**
 * Unit tests for the pure craps engine (services/tableGames/craps.js).
 * No database needed. Dice are forced through an injected RNG: rng value v
 * produces die 1 + floor(v * 6), so v = (die - 1) / 6 rolls exactly `die`.
 */
const engine = require('../services/tableGames/craps');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

/** An RNG that yields the given dice in order (values in 1..6). */
function diceRng(...dice) {
    const queue = dice.map(die => (die - 1) / 6);
    let i = 0;
    return () => queue[i++ % queue.length];
}

function seated(users = [ALICE]) {
    let state = engine.createTable();
    for (const userId of users) {
        ({ state } = engine.applyAction(state, { userId, name: `p${userId.slice(-1)}`, action: 'sit' }));
    }
    return state;
}

describe('betting', () => {
    test('a bet escrows and opens the betting window', () => {
        const state = seated([ALICE, BOB]);
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-craps-bet'
        }));
        expect(result.state.phase).toBe('betting');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'roll' }));
    });

    test('bad kinds, duplicate bets, and off-seat bets are rejected', () => {
        let state = seated([ALICE, BOB]);
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'hardways' }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'pass' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'pass' }))
            .toThrow(expect.objectContaining({ code: 'ALREADY_BET' }));
        // A second, different bet is allowed
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 20, kind: 'field' });
        expect(result.state.seats[0].bets).toHaveLength(2);
    });

    test('line bets are come-out only', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'pass' }));
        ({ state } = engine.applyAction(state, { action: 'roll', system: true }, diceRng(2, 2))); // point 4
        expect(state.point).toBe(4);
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'dont' }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        // Field bets stay available while the point is on
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 20, kind: 'field' });
        expect(result.state.seats[0].bets).toContainEqual({ kind: 'field', amount: 20 });
    });
});

describe('come-out rolls', () => {
    test('a natural 7 wins pass and loses dont', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50, kind: 'dont' }));
        const result = engine.applyAction(state, { action: 'roll', system: true }, diceRng(3, 4));

        expect(result.state.phase).toBe('settled');
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 200, type: 'table-craps-payout'
        }));
        expect(result.state.seats[0].outcome).toBe('win');
        expect(result.state.seats[1].outcome).toBe('lose');
    });

    test('craps 2 loses pass and wins dont; 12 pushes dont', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50, kind: 'dont' }));
        const result = engine.applyAction(state, { action: 'roll', system: true }, diceRng(1, 1));
        expect(result.state.seats[0].outcome).toBe('lose');
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: BOB, amount: 100 }));

        let state2 = seated([BOB]);
        ({ state: state2 } = engine.applyAction(state2, { userId: BOB, action: 'bet', amount: 50, kind: 'dont' }));
        const push = engine.applyAction(state2, { action: 'roll', system: true }, diceRng(6, 6));
        expect(push.state.seats[0].resolved[0]).toMatchObject({ outcome: 'push', payout: 50 });
    });

    test('a point number arms the point instead of settling', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        const result = engine.applyAction(state, { action: 'roll', system: true }, diceRng(4, 5));
        expect(result.state.point).toBe(9);
        expect(result.state.phase).toBe('betting');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'roll' }));
        expect(result.events).toContainEqual(expect.objectContaining({ type: 'point-set', point: 9 }));
    });
});

describe('point rolls', () => {
    function withPoint(kind = 'pass') {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind }));
        ({ state } = engine.applyAction(state, { action: 'roll', system: true }, diceRng(4, 4))); // point 8
        return state;
    }

    test('making the point wins pass even money', () => {
        const result = engine.applyAction(withPoint(), { action: 'roll', system: true }, diceRng(6, 2));
        expect(result.state.phase).toBe('settled');
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 200 }));
        expect(result.state.seats[0].outcome).toBe('win');
    });

    test('seven-out loses pass and wins dont', () => {
        const passResult = engine.applyAction(withPoint(), { action: 'roll', system: true }, diceRng(1, 6));
        expect(passResult.state.seats[0].outcome).toBe('lose');

        const dontResult = engine.applyAction(withPoint('dont'), { action: 'roll', system: true }, diceRng(1, 6));
        expect(dontResult.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 200 }));
    });

    test('other totals keep the round going', () => {
        const result = engine.applyAction(withPoint(), { action: 'roll', system: true }, diceRng(2, 3));
        expect(result.state.phase).toBe('betting');
        expect(result.state.point).toBe(8);
    });
});

describe('the field', () => {
    test('field bets resolve on every roll: 2 and 12 pay 2:1, others 1:1', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 30, kind: 'field' }));
        const double = engine.applyAction(state, { action: 'roll', system: true }, diceRng(6, 6));
        expect(double.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 90 }));

        let state2 = seated([ALICE]);
        ({ state: state2 } = engine.applyAction(state2, { userId: ALICE, action: 'bet', amount: 30, kind: 'field' }));
        const single = engine.applyAction(state2, { action: 'roll', system: true }, diceRng(1, 2));
        expect(single.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 60 }));

        let state3 = seated([ALICE]);
        ({ state: state3 } = engine.applyAction(state3, { userId: ALICE, action: 'bet', amount: 30, kind: 'field' }));
        // 3+3=6 is not a field number - and with no line bet the round ends
        const miss = engine.applyAction(state3, { action: 'roll', system: true }, diceRng(3, 3));
        expect(miss.charges.filter(c => c.type === 'table-craps-payout')).toHaveLength(0);
        expect(miss.state.seats[0].resolved[0]).toMatchObject({ kind: 'field', outcome: 'lose' });
    });

    test('a field-only table still settles when the field resolves mid-point', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 30, kind: 'field' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        // Come-out 4: point set, field (4) pays 1:1, pass rides on
        const result = engine.applyAction(state, { action: 'roll', system: true }, diceRng(2, 2));
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 60 }));
        expect(result.state.phase).toBe('betting');
        expect(result.state.seats[0].bets).toEqual([{ kind: 'pass', amount: 100 }]);
    });
});

describe('leaving, escrow, and views', () => {
    test('leaving on the come-out refunds everything', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 80, kind: 'pass' }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 80, type: 'table-craps-refund'
        }));
        expect(result.state.seats[0]).toBeNull();
    });

    test('leaving with the point on: field refunds, line bets ride', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        ({ state } = engine.applyAction(state, { action: 'roll', system: true }, diceRng(2, 2))); // point 4
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 20, kind: 'field' }));

        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 20, type: 'table-craps-refund'
        }));
        expect(result.state.seats[0]).toMatchObject({ left: true, bets: [{ kind: 'pass', amount: 100 }] });

        // The ride finishes and the seat clears on the next round
        let after = engine.applyAction(result.state, { action: 'roll', system: true }, diceRng(2, 2)).state;
        expect(after.phase).toBe('settled');
        after = engine.applyAction(after, { action: 'next-round', system: true }).state;
        expect(after.seats[0]).toBeNull();
    });

    test('escrow refunds cover live bets only', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 30, kind: 'field' }));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 130 }]);

        // Point set: the field resolved (won), only the pass line is live
        ({ state } = engine.applyAction(state, { action: 'roll', system: true }, diceRng(2, 2)));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 100 }]);
    });

    test('views expose the point, dice, history, and labeled bets', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'pass' }));
        ({ state } = engine.applyAction(state, { action: 'roll', system: true }, diceRng(3, 2))); // point 5

        const view = engine.getView(state, ALICE);
        expect(view.gameType).toBe('craps');
        expect(view.point).toBe(5);
        expect(view.dice).toEqual([3, 2]);
        expect(view.history).toEqual([5]);
        expect(view.seats[0].bets[0]).toMatchObject({ kind: 'pass', label: 'Pass line' });
        expect(view.seats[0].totalWagered).toBe(100);
    });
});
