/**
 * Unit tests for the pure slots engine (services/tableGames/slots.js).
 * No database needed. The paytable is tested directly against hand-built
 * reels; full rounds run deterministically via injected RNGs.
 */
const engine = require('../services/tableGames/slots');
const { evaluateReels, REEL_STRIP } = require('../services/tableGames/slots');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

/** An RNG that lands every reel on the given symbol. */
function rngFor(symbols) {
    const queue = symbols.map(symbol => REEL_STRIP.indexOf(symbol) / REEL_STRIP.length);
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

describe('the paytable', () => {
    test('triples pay their line, best line first', () => {
        expect(evaluateReels(['seven', 'seven', 'seven'])).toMatchObject({ pays: 150 });
        expect(evaluateReels(['diamond', 'diamond', 'diamond'])).toMatchObject({ pays: 40 });
        expect(evaluateReels(['cherry', 'cherry', 'cherry'])).toMatchObject({ pays: 6 });
    });

    test('partial sevens and cherry pairs pay small', () => {
        expect(evaluateReels(['seven', 'seven', 'lemon'])).toMatchObject({ pays: 10 });
        expect(evaluateReels(['seven', 'bell', 'lemon'])).toMatchObject({ pays: 2 });
        expect(evaluateReels(['cherry', 'cherry', 'bell'])).toMatchObject({ pays: 1 });
        // A single seven outranks a cherry pair (first match wins)
        expect(evaluateReels(['cherry', 'cherry', 'seven'])).toMatchObject({ pays: 2 });
    });

    test('mixed reels miss', () => {
        expect(evaluateReels(['cherry', 'lemon', 'bell'])).toBeNull();
    });
});

describe('betting and spinning', () => {
    test('a bet escrows and opens the betting window', () => {
        const state = seated([ALICE, BOB]);
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-slots-bet'
        }));
        expect(result.state.phase).toBe('betting');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'spin' }));
    });

    test('all bets in spins every machine and settles at once', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 }));
        // Both seats' reels land on triple cherries (pays 6x)
        const result = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50 }, rngFor(['cherry']));

        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0].reels).toEqual(['cherry', 'cherry', 'cherry']);
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 600, type: 'table-slots-payout'
        }));
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: BOB, amount: 300, type: 'table-slots-payout'
        }));
        expect(result.state.results.entries).toHaveLength(2);
    });

    test('a miss loses the bet and pays nothing', () => {
        let state = seated([ALICE]);
        const result = engine.applyAction(
            state,
            { userId: ALICE, action: 'bet', amount: 100 },
            rngFor(['cherry', 'lemon', 'bell'])
        );
        expect(result.state.seats[0].outcome).toBe('lose');
        expect(result.charges.filter(c => c.type === 'table-slots-payout')).toHaveLength(0);
        expect(result.state.results.entries[0]).toMatchObject({ outcome: 'lose', payout: 0 });
    });

    test('players without a bet cannot force the spin', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }));
        expect(() => engine.applyAction(state, { userId: BOB, action: 'spin' }))
            .toThrow(expect.objectContaining({ code: 'NO_BET' }));
        // The system spin (betting-window timer) is always allowed
        const result = engine.applyAction(state, { action: 'spin', system: true }, rngFor(['bell']));
        expect(result.state.phase).toBe('settled');
    });

    test('leaving during betting refunds the escrow', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 80 }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 80, type: 'table-slots-refund'
        }));
        expect(result.state.phase).toBe('waiting');
    });
});

describe('rounds, escrow, and views', () => {
    test('next-round resets bets and reels', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }, rngFor(['star'])));
        expect(state.phase).toBe('settled');

        const result = engine.applyAction(state, { action: 'next-round', system: true });
        expect(result.state.phase).toBe('waiting');
        expect(result.state.seats[0]).toMatchObject({ userId: ALICE, bet: 0, reels: null, outcome: null });

        expect(() => engine.applyAction(state, { userId: ALICE, action: 'next-round' }))
            .toThrow(expect.objectContaining({ code: 'SYSTEM_ONLY' }));
    });

    test('escrow refunds cover the betting phase only', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 70 }));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 70 }]);

        ({ state } = engine.applyAction(state, { action: 'spin', system: true }, rngFor(['bell'])));
        expect(engine.getEscrowRefunds(state)).toEqual([]);
    });

    test('views expose reels, paytable, and outcomes', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }, rngFor(['star'])));

        const view = engine.getView(state, ALICE);
        expect(view.gameType).toBe('slots');
        expect(view.yourSeat).toBe(0);
        expect(view.paytable[0]).toMatchObject({ pays: 150 });
        expect(view.seats[0]).toMatchObject({
            reels: ['star', 'star', 'star'],
            outcome: 'win',
            payout: 500,
            lineName: 'Triple stars'
        });
    });
});
