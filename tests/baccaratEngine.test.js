/**
 * Unit tests for the pure baccarat engine (services/tableGames/baccarat.js).
 * No database needed. The tableau (third-card rules) is tested directly as
 * a pure function; settlement math is tested by settling hand-built hands;
 * and one full deal runs deterministically via the identity-shuffle RNG.
 */
const engine = require('../services/tableGames/baccarat');
const { handValue, bankerDraws } = require('../services/tableGames/baccarat');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';

// An RNG stuck just below 1 makes the Fisher-Yates shuffle the identity
// permutation, so the shoe pops A♣(1), K♣(0), Q♣(0), J♣(0), 10♣(0), 9♣(9)…
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

/** Settle hand-built hands against hand-built bets (documented state shape). */
function settleWith({ playerHand, bankerHand, bets }) {
    const next = engine.createTable();
    next.phase = 'betting';
    next.roundId = 1;
    bets.forEach((bet, i) => {
        next.seats[i] = { userId: bet.userId, name: bet.userId.slice(-4), bet: bet.amount, target: bet.target, outcome: null, payout: null };
    });
    next.playerHand = playerHand;
    next.bankerHand = bankerHand;
    const ctx = { next, events: [], charges: [] };
    engine._settle(ctx, { natural: false });
    return ctx;
}

describe('hand values', () => {
    test('pips mod 10, aces are 1, tens and faces are 0', () => {
        expect(handValue([card(7), card(8)])).toBe(5);
        expect(handValue([card('A'), card('K')])).toBe(1);
        expect(handValue([card('10'), card('J'), card('Q')])).toBe(0);
        expect(handValue([card(9), card(9)])).toBe(8);
        expect(handValue([card(4), card(5)])).toBe(9);
    });
});

describe('the banker tableau', () => {
    test('banker draws on 0-5 and stands on 6-7 when the player stood', () => {
        for (const total of [0, 1, 2, 3, 4, 5]) expect(bankerDraws(total, null)).toBe(true);
        for (const total of [6, 7]) expect(bankerDraws(total, null)).toBe(false);
    });

    test('banker responses to the player third card follow the tableau', () => {
        expect(bankerDraws(2, 8)).toBe(true);   // 0-2 always draw
        expect(bankerDraws(3, 8)).toBe(false);  // 3 stands only vs 8
        expect(bankerDraws(3, 7)).toBe(true);
        expect(bankerDraws(4, 1)).toBe(false);  // 4 draws vs 2-7
        expect(bankerDraws(4, 2)).toBe(true);
        expect(bankerDraws(4, 7)).toBe(true);
        expect(bankerDraws(5, 3)).toBe(false);  // 5 draws vs 4-7
        expect(bankerDraws(5, 4)).toBe(true);
        expect(bankerDraws(6, 5)).toBe(false);  // 6 draws vs 6-7
        expect(bankerDraws(6, 6)).toBe(true);
        expect(bankerDraws(7, 6)).toBe(false);  // 7 always stands
    });
});

describe('seating and betting', () => {
    test('a bet escrows and opens the betting window', () => {
        const state = seated([ALICE, BOB]);
        const result = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, target: 'banker' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: -100, type: 'table-baccarat-bet'
        }));
        expect(result.state.phase).toBe('betting');
        expect(result.state.timer).toEqual(expect.objectContaining({ action: 'deal' }));
    });

    test('bad targets, double bets, and off-seat bets are rejected', () => {
        let state = seated([ALICE, BOB]);
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, target: 'dealer' }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' }));
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, target: 'player' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, target: 'tie' }))
            .toThrow(expect.objectContaining({ code: 'ALREADY_BET' }));
    });

    test('leaving during betting refunds the escrow', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 80, target: 'tie' }));
        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 80, type: 'table-baccarat-refund'
        }));
        expect(result.state.phase).toBe('waiting');
    });
});

describe('dealing and settlement', () => {
    test('a full deterministic round: deal, tableau, and payouts in one transition', () => {
        // Identity shuffle: player gets A♣+Q♣ (1) and draws 10♣ (still 1);
        // banker gets K♣+J♣ (0) and draws 9♣ (9). Banker wins 9 to 1.
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 100, target: 'banker' }));
        // All bets in -> the round deals and settles immediately
        const result = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 50, target: 'player' }, identityRng);

        expect(result.state.phase).toBe('settled');
        expect(result.state.results).toMatchObject({ winner: 'banker', playerTotal: 1, bankerTotal: 9 });
        expect(result.state.playerHand).toHaveLength(3);
        expect(result.state.bankerHand).toHaveLength(3);

        // Banker win pays 1:1 minus 5% commission: 100 + floor(95) = 195
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 195, type: 'table-baccarat-payout'
        }));
        expect(result.state.seats[1].outcome).toBe('lose');
        expect(result.charges.filter(c => c.userId === BOB && c.type === 'table-baccarat-payout')).toHaveLength(0);
    });

    test('a player win pays even money', () => {
        const { next, charges } = settleWith({
            playerHand: [card(4), card(5)],   // 9
            bankerHand: [card(3), card(4)],   // 7
            bets: [{ userId: ALICE, amount: 100, target: 'player' }]
        });
        expect(next.results.winner).toBe('player');
        expect(charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 200 }));
    });

    test('a tie pays tie bets 8:1 and pushes the others', () => {
        const { next, charges } = settleWith({
            playerHand: [card(4), card(3)],   // 7
            bankerHand: [card(2), card(5)],   // 7
            bets: [
                { userId: ALICE, amount: 10, target: 'tie' },
                { userId: BOB, amount: 100, target: 'banker' }
            ]
        });
        expect(next.results.winner).toBe('tie');
        expect(charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: 90 }));
        expect(charges).toContainEqual(expect.objectContaining({ userId: BOB, amount: 100 }));
        expect(next.seats[1].outcome).toBe('push');
    });

    test('players without a bet cannot force the deal', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, target: 'player' }));
        expect(() => engine.applyAction(state, { userId: BOB, action: 'deal' }))
            .toThrow(expect.objectContaining({ code: 'NO_BET' }));
        // The system deal (betting-window timer) is always allowed
        const result = engine.applyAction(state, { action: 'deal', system: true }, identityRng);
        expect(result.state.phase).toBe('settled');
    });

    test('next-round resets bets and hands', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, target: 'player' }, identityRng));
        expect(state.phase).toBe('settled');

        const result = engine.applyAction(state, { action: 'next-round', system: true });
        expect(result.state.phase).toBe('waiting');
        expect(result.state.seats[0]).toMatchObject({ userId: ALICE, bet: 0, target: null });
        expect(result.state.playerHand).toHaveLength(0);

        expect(() => engine.applyAction(state, { userId: ALICE, action: 'next-round' }))
            .toThrow(expect.objectContaining({ code: 'SYSTEM_ONLY' }));
    });
});

describe('escrow and views', () => {
    test('escrow refunds cover the betting phase only', () => {
        let state = seated([ALICE, BOB]);
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 70, target: 'banker' }));
        expect(engine.getEscrowRefunds(state)).toEqual([{ userId: ALICE, amount: 70 }]);

        ({ state } = engine.applyAction(state, { action: 'deal', system: true }, identityRng));
        expect(engine.getEscrowRefunds(state)).toEqual([]);
    });

    test('views expose both communal hands with labels', () => {
        let state = seated();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50, target: 'player' }, identityRng));

        const view = engine.getView(state, ALICE);
        expect(view.gameType).toBe('baccarat');
        expect(view.yourSeat).toBe(0);
        expect(view.playerHand.total).toBe(1);
        expect(view.bankerHand.total).toBe(9);
        expect(view.playerHand.cards[0].label).toBeTruthy();
        expect(view.seats[0]).toMatchObject({ target: 'player', outcome: 'lose' });
    });
});
