/**
 * Unit tests for the pure roulette engine (services/tableGames/roulette.js).
 * No database needed - the engine is a pure state machine. Deterministic
 * spins are produced with a fixed RNG: the winning number is
 * floor(rng() * 37).
 */
const engine = require('../services/tableGames/roulette');
const { wheelColor } = require('../services/tableGames/roulette');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

/** An RNG that makes the wheel land on `number` (mid-bucket to dodge float error). */
const landOn = (number) => () => (number + 0.5) / 37;

function seated(users = [ALICE]) {
    let state = engine.createTable();
    for (const userId of users) {
        ({ state } = engine.applyAction(state, { userId, name: `p${userId.slice(-1)}`, action: 'sit' }));
    }
    return state;
}

describe('wheel colors', () => {
    test('zero is green, reds and blacks split the rest', () => {
        expect(wheelColor(0)).toBe('green');
        expect(wheelColor(1)).toBe('red');
        expect(wheelColor(17)).toBe('black');
        expect(wheelColor(36)).toBe('red');
        const reds = Array.from({ length: 36 }, (_, i) => i + 1).filter(n => wheelColor(n) === 'red');
        expect(reds).toHaveLength(18);
    });
});

describe('seating and betting', () => {
    test('a bet escrows and opens the betting window', () => {
        let state = seated();
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, kind: 'red' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-roulette-bet'
        }));
        expect(result.state.phase).toBe('betting');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'spin' }));
    });

    test('multiple bets stack on one seat', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'straight', target: 17 }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 25, kind: 'dozen', target: 2 }));
        expect(state.seats[0].bets).toHaveLength(2);
        expect(state.seats[0].totalWagered).toBe(75);
    });

    test('invalid bet kinds and targets are rejected', () => {
        const state = seated();
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'corner' }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'straight', target: 37 }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'dozen', target: 0 }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 5, kind: 'red' }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        expect(() => engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50, kind: 'red' }))
            .toThrow(expect.objectContaining({ code: 'NOT_SEATED' }));
    });

    test('clearing bets refunds everything and reverts to waiting', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'red' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 30, kind: 'odd' }));

        const result = engine.applyAction(state, { userId: ALICE, action: 'clear-bets' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 80, type: 'table-roulette-refund'
        }));
        expect(result.state.seats[0].bets).toHaveLength(0);
        expect(result.state.phase).toBe('waiting');
        expect(result.state.timer).toBeNull();
    });

    test('leaving during betting refunds the escrow', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 60, kind: 'black' }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 40, kind: 'red' }));

        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 60, type: 'table-roulette-refund'
        }));
        // Bob still has a live bet, so the window stays open
        expect(result.state.phase).toBe('betting');
    });
});

describe('spins and payouts', () => {
    function spinWith(bets, number, users = [ALICE]) {
        let state = seated(users);
        for (const bet of bets) {
            ({ state } = engine.applyAction(state, { action: 'bet', userId: ALICE, ...bet }));
        }
        return engine.applyAction(state, { userId: ALICE, action: 'spin' }, landOn(number));
    }

    test('straight up pays 35:1', () => {
        const result = spinWith([{ amount: 10, kind: 'straight', target: 17 }], 17);
        expect(result.state.result).toEqual({ number: 17, color: 'black' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 360, type: 'table-roulette-payout'
        }));
        expect(result.state.seats[0].outcome).toBe('win');
    });

    test('even-money and 2:1 bets pay correctly and losers get nothing', () => {
        // 20 is black and even: red loses, even wins 1:1, dozen2 wins 2:1
        const result = spinWith([
            { amount: 100, kind: 'red' },
            { amount: 50, kind: 'even' },
            { amount: 30, kind: 'dozen', target: 2 }
        ], 20);
        // even: 50*2 = 100 back; dozen: 30*3 = 90 back
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 190, type: 'table-roulette-payout'
        }));
    });

    test('zero wipes out the even-money bets', () => {
        const result = spinWith([
            { amount: 100, kind: 'red' },
            { amount: 100, kind: 'black' },
            { amount: 100, kind: 'odd' },
            { amount: 100, kind: 'even' },
            { amount: 100, kind: 'low' },
            { amount: 100, kind: 'high' }
        ], 0);
        expect(result.charges.filter(c => c.type === 'table-roulette-payout')).toHaveLength(0);
        expect(result.state.seats[0].outcome).toBe('lose');
        expect(result.state.result.color).toBe('green');
    });

    test('column bets follow the layout', () => {
        // 25 is in column 1 (25 = 3*8 + 1)
        const win = spinWith([{ amount: 10, kind: 'column', target: 1 }], 25);
        expect(win.charges).toContainEqual(expect.objectContaining({ amount: 30 }));
        const lose = spinWith([{ amount: 10, kind: 'column', target: 2 }], 25);
        expect(lose.charges.filter(c => c.type === 'table-roulette-payout')).toHaveLength(0);
    });

    test('players without a bet cannot spin; spectators cannot spin', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'red' }));
        expect(() => engine.applyAction(state, { userId: BOB, action: 'spin' }))
            .toThrow(expect.objectContaining({ code: 'NO_BET' }));
    });

    test('the system spin timer settles the round', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'high' }));
        const result = engine.applyAction(state, { action: 'spin', system: true }, landOn(36));
        expect(result.state.phase).toBe('settled');
        expect(result.state.results.entries[0]).toMatchObject({ userId: ALICE, outcome: 'win', payout: 100 });
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'next-round' }));
    });

    test('next-round clears bets and outcomes but keeps history', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, kind: 'red' }));
        ({ state } = engine.applyAction(state, { action: 'spin', system: true }, landOn(3)));
        expect(state.history).toHaveLength(1);

        const result = engine.applyAction(state, { action: 'next-round', system: true });
        expect(result.state.phase).toBe('waiting');
        expect(result.state.seats[0]).toMatchObject({ userId: ALICE, bets: [], totalWagered: 0, outcome: null });
        expect(result.state.history).toHaveLength(1);
        expect(result.state.result).toEqual({ number: 3, color: 'red' });

        expect(() => engine.applyAction(state, { userId: ALICE, action: 'next-round' }))
            .toThrow(expect.objectContaining({ code: 'SYSTEM_ONLY' }));
    });
});

describe('escrow and views', () => {
    test('escrow refunds cover the betting phase only', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 70, kind: 'red' }));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 70 }]);

        ({ state } = engine.applyAction(state, { action: 'spin', system: true }, landOn(5)));
        expect(engine.getEscrowRefunds(state)).toEqual([]);
    });

    test('views label bets and expose the history', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 10, kind: 'dozen', target: 1 }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 10, kind: 'straight', target: 0 }));

        const view = engine.getView(state, ALICE);
        expect(view.gameType).toBe('roulette');
        expect(view.yourSeat).toBe(0);
        expect(view.seats[0].bets.map(b => b.label)).toEqual(['1st 12', '0']);

        const spectator = engine.getView(state, BOB);
        expect(spectator.yourSeat).toBeNull();
    });

    test('isEmpty tracks seated players', () => {
        let state = engine.createTable();
        expect(engine.isEmpty(state)).toBe(true);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        expect(engine.isEmpty(state)).toBe(false);
    });
});
