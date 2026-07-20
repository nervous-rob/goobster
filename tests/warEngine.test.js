/**
 * Unit tests for the pure Casino War engine (services/tableGames/war.js).
 * No database needed. Straight rounds run deterministically via the
 * identity-shuffle RNG; tie/war scenarios are exercised on hand-built
 * war-phase states with a stacked deck (documented state shape).
 */
const engine = require('../services/tableGames/war');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

// An RNG stuck just below 1 makes the Fisher-Yates shuffle the identity
// permutation, so the shoe pops A♣(14), K♣(13), Q♣(12), J♣(11)…
const identityRng = () => 0.999999;

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
 * A hand-built war-phase state: ALICE tied the dealer on an 8 and must
 * decide; BOB (when present) already has a winning king. The deck is
 * stacked so the war burns three cards, then pops ALICE's war card and
 * the dealer's war card in that order.
 */
function warState({ withBob = false, aliceWarCard, dealerWarCard } = {}) {
    const state = engine.createTable();
    state.phase = 'war';
    state.roundId = 1;
    state.dealerCard = card(8, 'H');
    state.seats[0] = {
        userId: ALICE, name: 'alice', isBot: false, bet: 100, totalWagered: 100,
        card: card(8, 'S'), warCard: null, atWar: true, warDecision: null, outcome: null, payout: null
    };
    if (withBob) {
        state.seats[1] = {
            userId: BOB, name: 'bob', isBot: false, bet: 50, totalWagered: 50,
            card: card('K'), warCard: null, atWar: false, warDecision: null, outcome: null, payout: null
        };
    }
    state.deck = [dealerWarCard, aliceWarCard, card(2, 'C'), card(3, 'C'), card(4, 'C')];
    return state;
}

describe('betting and dealing', () => {
    test('a bet escrows and opens the betting window', () => {
        const state = seated([ALICE, BOB]);
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-war-bet'
        }));
        expect(result.state.phase).toBe('betting');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'deal' }));
    });

    test('a straight round settles immediately: higher card wins even money', () => {
        // Identity shuffle: ALICE draws A♣ (14), the dealer shows K♣ (13)
        let state = seated([ALICE]);
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100 }, identityRng);

        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0].outcome).toBe('win');
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 200, type: 'table-war-payout'
        }));
    });

    test('lower card loses the bet', () => {
        // Two bettors: ALICE pops A♣, BOB pops K♣, dealer shows Q♣ - both
        // win; flip the comparison by rebuilding a settled state by hand.
        const state = warState({ aliceWarCard: card(2), dealerWarCard: card('A') });
        state.seats[0].atWar = false;
        state.seats[0].card = card(3);
        const ctx = { next: state, events: [], charges: [] };
        engine._settle(ctx);
        expect(state.seats[0].outcome).toBe('lose');
        expect(ctx.charges).toHaveLength(0);
    });

    test('leaving during betting refunds the escrow', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 80 }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 80, type: 'table-war-refund'
        }));
        expect(result.state.phase).toBe('waiting');
    });
});

describe('ties and the war phase', () => {
    test('a tie moves the table to the war phase with a decision timer', () => {
        const state = warState({ aliceWarCard: card('A'), dealerWarCard: card(2) });
        const view = engine.getView(state, ALICE);
        expect(view.phase).toBe('war');
        expect(view.seats[0]).toMatchObject({ atWar: true, decided: false });
    });

    test('going to war escrows a matching bet; winning returns both plus even money on the original', () => {
        const state = warState({ withBob: true, aliceWarCard: card('A'), dealerWarCard: card(2) });
        const result = engine.applyAction(state, { userId: ALICE, action: 'war' });

        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-war-bet'
        }));
        expect(result.state.phase).toBe('settled');
        // 100 original + 100 raise back + 100 winnings
        expect(result.state.seats[0]).toMatchObject({ outcome: 'win', payout: 300 });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 300, type: 'table-war-payout'
        }));
        // BOB's king beat the 8 and settles in the same transition
        expect(result.state.seats[1]).toMatchObject({ outcome: 'win', payout: 100 });
    });

    test('tying the war doubles the bonus', () => {
        const state = warState({ aliceWarCard: card(9, 'S'), dealerWarCard: card(9, 'H') });
        const result = engine.applyAction(state, { userId: ALICE, action: 'war' });
        expect(result.state.seats[0]).toMatchObject({ outcome: 'win', payout: 400 });
    });

    test('losing the war loses both bets', () => {
        const state = warState({ aliceWarCard: card(2, 'S'), dealerWarCard: card('A') });
        const result = engine.applyAction(state, { userId: ALICE, action: 'war' });
        expect(result.state.seats[0]).toMatchObject({ outcome: 'lose', payout: 0 });
        expect(result.charges.filter(c => c.type === 'table-war-payout')).toHaveLength(0);
    });

    test('surrender returns half the bet', () => {
        const state = warState({ aliceWarCard: card('A'), dealerWarCard: card(2) });
        const result = engine.applyAction(state, { userId: ALICE, action: 'surrender' });
        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0]).toMatchObject({ outcome: 'surrender', payout: 50 });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 50, type: 'table-war-payout'
        }));
    });

    test('the war timer surrenders undecided seats', () => {
        const state = warState({ aliceWarCard: card('A'), dealerWarCard: card(2) });
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'timeout-war' }))
            .toThrow(expect.objectContaining({ code: 'SYSTEM_ONLY' }));

        const result = engine.applyAction(state, { action: 'timeout-war', system: true });
        expect(result.state.phase).toBe('settled');
        expect(result.state.seats[0]).toMatchObject({ outcome: 'surrender', payout: 50 });
    });

    test('war actions are rejected without a tie', () => {
        const state = warState({ withBob: true, aliceWarCard: card('A'), dealerWarCard: card(2) });
        expect(() => engine.applyAction(state, { userId: BOB, action: 'war' }))
            .toThrow(expect.objectContaining({ code: 'NOT_AT_WAR' }));
    });
});

describe('rounds, escrow, and views', () => {
    test('escrow refunds cover betting and war phases', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 70 }));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 70 }]);

        const atWar = warState({ aliceWarCard: card('A'), dealerWarCard: card(2) });
        atWar.seats[0].totalWagered = 200;
        expect(engine.getEscrowRefunds(atWar)).toEqual([{ userId: ALICE, amount: 200 }]);
    });

    test('next-round resets cards and bets', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }, identityRng));
        expect(state.phase).toBe('settled');

        const result = engine.applyAction(state, { action: 'next-round', system: true });
        expect(result.state.phase).toBe('waiting');
        expect(result.state.dealerCard).toBeNull();
        expect(result.state.seats[0]).toMatchObject({ userId: ALICE, bet: 0, card: null, outcome: null });
    });

    test('views label every card and hide nothing', () => {
        let state = seated([ALICE]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }, identityRng));

        const view = engine.getView(state, ALICE);
        expect(view.gameType).toBe('war');
        expect(view.yourSeat).toBe(0);
        expect(view.dealerCard.label).toBeTruthy();
        expect(view.seats[0].card.label).toBeTruthy();
        expect(view.seats[0].outcome).toBe('win');
    });
});
