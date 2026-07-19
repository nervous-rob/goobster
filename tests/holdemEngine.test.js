/**
 * Unit tests for the pure Texas Hold'em engine (services/tableGames/holdem.js).
 * No database needed. Deterministic hands come from the identity-shuffle RNG
 * (single deck popping A♣, K♣, Q♣, J♣, 10♣, ...) or from hand-built acting
 * states in the documented shape.
 */
const engine = require('../services/tableGames/holdem');

const ALICE = '600000000000000001';
const BOB = '600000000000000002';
const CAROL = '600000000000000003';

// Identity shuffle: pop order A♣, K♣, Q♣, J♣, 10♣, 9♣, 8♣, 7♣, 6♣ ...
const identityRng = () => 0.999999;

function card(rank, suit = 'S') {
    const rankMap = { A: 14, K: 13, Q: 12, J: 11 };
    return { rank: rankMap[rank] || Number(rank), suit };
}

function sitMany(users) {
    let state = engine.createTable();
    for (const userId of users) {
        ({ state } = engine.applyAction(state, { userId, name: `p${userId.slice(-1)}`, action: 'sit' }));
    }
    return state;
}

/** Heads-up hand dealt with the identity shuffle (blinds posted). */
function dealtHeadsUp() {
    let state = sitMany([ALICE, BOB]);
    // Button lands on seat 0 (Alice): Alice posts SB 5, Bob posts BB 10.
    // Cards: Bob A♣Q♣, Alice K♣J♣. Alice (button/SB) acts first preflop.
    const result = engine.applyAction(state, { userId: ALICE, action: 'deal' }, identityRng);
    return result;
}

/**
 * Hand-built river state (documented engine state shape): betting round
 * fresh on the river with a chosen board and hole cards.
 */
function riverState({ community, hands, pot = 200, button = 0 }) {
    const state = engine.createTable();
    state.phase = 'acting';
    state.street = 'river';
    state.handId = 1;
    state.community = community;
    state.pot = pot;
    state.button = button;
    state.currentBet = 0;
    state.deck = [];
    state.contributions = {};
    hands.forEach((hand, i) => {
        state.seats[i] = {
            userId: hand.userId,
            name: hand.userId.slice(-4),
            isBot: false,
            hand: hand.cards,
            folded: hand.folded === true,
            streetBet: 0,
            totalWagered: pot / hands.length,
            acted: false,
            left: false,
            outcome: null,
            payout: null
        };
        state.contributions[hand.userId] = pot / hands.length;
    });
    state.activeSeat = (button + 1) % hands.length;
    state.timer = { action: 'timeout-act', ms: 30000 };
    return state;
}

describe('seating and dealing', () => {
    test('two seated players arm the auto-deal timer', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        expect(state.timer).toBeNull();
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'sit' }));
        expect(state.timer).toEqual(expect.objectContaining({ action: 'deal' }));
    });

    test('a hand needs two players', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'deal' }))
            .toThrow(expect.objectContaining({ code: 'NOT_ENOUGH_PLAYERS' }));
    });

    test('dealing posts blinds as escrow charges and deals hole cards', () => {
        const { state, charges } = dealtHeadsUp();
        expect(state.phase).toBe('acting');
        expect(state.street).toBe('preflop');
        expect(state.pot).toBe(15);
        expect(charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: -5, type: 'table-holdem-bet' }));
        expect(charges).toContainEqual(expect.objectContaining({ userId: BOB, amount: -10, type: 'table-holdem-bet' }));
        expect(state.seats[0].hand).toHaveLength(2);
        expect(state.seats[1].hand).toHaveLength(2);
        // Heads-up: the button (small blind) acts first preflop
        expect(state.button).toBe(0);
        expect(state.activeSeat).toBe(0);
    });
});

describe('betting rounds', () => {
    test('call and check advance to the flop', () => {
        let { state } = dealtHeadsUp();
        let result = engine.applyAction(state, { userId: ALICE, action: 'call' });
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: ALICE, amount: -5 }));
        state = result.state;
        expect(state.street).toBe('preflop'); // BB still has the option

        ({ state } = engine.applyAction(state, { userId: BOB, action: 'check' }));
        expect(state.street).toBe('flop');
        expect(state.community).toHaveLength(3);
        expect(state.currentBet).toBe(0);
        // Postflop heads-up: the big blind (non-button) acts first
        expect(state.activeSeat).toBe(1);
    });

    test('checking when facing a bet is illegal; calling nothing is illegal', () => {
        const { state } = dealtHeadsUp();
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'check' }))
            .toThrow(expect.objectContaining({ code: 'CANT_CHECK' }));
        expect(() => engine.applyAction(state, { userId: BOB, action: 'fold' }))
            .toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    });

    test('a raise reopens the action and must clear the minimum', () => {
        let { state } = dealtHeadsUp();
        expect(() => engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 15 }))
            .toThrow(expect.objectContaining({ code: 'BAD_BET' })); // min raise-to is 20

        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 30 }));
        expect(state.currentBet).toBe(30);
        expect(state.activeSeat).toBe(1);

        // Bob re-raises; the action reopens and comes back to Alice
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'bet', amount: 60 }));
        expect(state.activeSeat).toBe(0);
        expect(() => engine.applyAction(state, { userId: BOB, action: 'check' }))
            .toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    });

    test('folding to a raise awards the pot uncontested', () => {
        let { state } = dealtHeadsUp();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 50 }));
        const result = engine.applyAction(state, { userId: BOB, action: 'fold' });

        expect(result.state.phase).toBe('settled');
        expect(result.state.results.uncontested).toBe(true);
        // Pot: Alice 50 + Bob's BB 10 = 60, all to Alice, hole cards not revealed
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 60, type: 'table-holdem-payout'
        }));
        expect(result.state.results.entries[0].hole).toBeNull();
    });

    test('turn timeout folds when facing a bet, checks when free', () => {
        let { state } = dealtHeadsUp();
        // Alice (SB, owes 5) times out -> fold -> Bob wins uncontested
        const folded = engine.applyAction(state, { action: 'timeout-act', system: true });
        expect(folded.state.phase).toBe('settled');
        expect(folded.state.results.entries[0].userId).toBe(BOB);

        // Same dealt hand, different line: Alice calls, then Bob (option,
        // nothing owed) times out -> check instead of fold
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'call' }));
        const checked = engine.applyAction(state, { action: 'timeout-act', system: true });
        expect(checked.state.street).toBe('flop');
        expect(checked.events).toContainEqual(expect.objectContaining({ type: 'check', timeout: true }));
    });
});

describe('showdown', () => {
    test('best hand wins the pot at showdown', () => {
        const state = riverState({
            community: [card(2, 'H'), card(7, 'D'), card(9, 'C'), card('J', 'H'), card(3, 'C')],
            hands: [
                { userId: ALICE, cards: [card('A', 'S'), card('A', 'H')] }, // pair of aces
                { userId: BOB, cards: [card('K', 'S'), card(4, 'D')] }      // king high
            ]
        });
        let result = engine.applyAction(state, { userId: BOB, action: 'check' });
        result = engine.applyAction(result.state, { userId: ALICE, action: 'check' });

        expect(result.state.phase).toBe('settled');
        expect(result.charges).toContainEqual(expect.objectContaining({
            userId: ALICE, amount: 200, type: 'table-holdem-payout'
        }));
        const aliceEntry = result.state.results.entries.find(e => e.userId === ALICE);
        expect(aliceEntry).toMatchObject({ outcome: 'win', handName: 'Pair' });
        expect(aliceEntry.hole).toHaveLength(2);
        const bobEntry = result.state.results.entries.find(e => e.userId === BOB);
        expect(bobEntry.outcome).toBe('lose');
    });

    test('ties split the pot with the odd chip to the earliest winner', () => {
        const state = riverState({
            pot: 201,
            community: [card('A', 'H'), card('K', 'D'), card('Q', 'C'), card('J', 'H'), card('10', 'C')], // broadway on board
            hands: [
                { userId: ALICE, cards: [card(2, 'S'), card(3, 'H')] },
                { userId: BOB, cards: [card(4, 'S'), card(5, 'D')] }
            ]
        });
        let result = engine.applyAction(state, { userId: BOB, action: 'check' });
        result = engine.applyAction(result.state, { userId: ALICE, action: 'check' });

        const payouts = result.charges.filter(c => c.type === 'table-holdem-payout');
        expect(payouts).toHaveLength(2);
        expect(payouts.map(p => p.amount).sort((a, b) => b - a)).toEqual([101, 100]);
    });

    test('a full identity-shuffle hand runs deal -> river -> showdown', () => {
        // Board runs out 10♣9♣8♣7♣6♣; Alice's J♣ makes the higher straight
        // flush (J-high) over Bob's board-played 10-high
        let { state } = dealtHeadsUp();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'call' }));
        ({ state } = engine.applyAction(state, { userId: BOB, action: 'check' }));
        for (const street of ['turn', 'river', 'done']) {
            if (state.phase !== 'acting') break;
            ({ state } = engine.applyAction(state, { userId: BOB, action: 'check' }));
            ({ state } = engine.applyAction(state, { userId: ALICE, action: 'check' }));
            if (street !== 'done') expect(['acting', 'settled']).toContain(state.phase);
        }
        expect(state.phase).toBe('settled');
        expect(state.results.entries.every(e => e.handName === 'Straight Flush')).toBe(true);
        const alice = state.results.entries.find(e => e.userId === ALICE);
        const bob = state.results.entries.find(e => e.userId === BOB);
        expect(alice).toMatchObject({ outcome: 'win', payout: 20 });
        expect(bob).toMatchObject({ outcome: 'lose', payout: 0 });
    });
});

describe('leaving, refunds, and views', () => {
    test('leaving mid-hand folds and forfeits the chips already in the pot', () => {
        let { state } = dealtHeadsUp();
        const result = engine.applyAction(state, { userId: ALICE, action: 'leave' });
        // Alice's SB stays in the pot; Bob wins it uncontested
        expect(result.charges.filter(c => c.type === 'table-holdem-refund')).toHaveLength(0);
        expect(result.charges).toContainEqual(expect.objectContaining({ userId: BOB, amount: 15 }));
        expect(result.state.seats[0].left).toBe(true);

        const reset = engine.applyAction(result.state, { action: 'next-hand', system: true });
        expect(reset.state.seats[0]).toBeNull();
        expect(reset.state.timer).toBeNull(); // only Bob remains
    });

    test('escrow refunds cover everyone who paid into an unfinished hand', () => {
        let { state } = dealtHeadsUp();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'bet', amount: 40 }));
        expect(engine.getEscrowRefunds(state)).toEqual(expect.arrayContaining([
            { userId: ALICE, amount: 40 }, // SB 5 + raise-to-40 top-up
            { userId: BOB, amount: 10 }
        ]));

        const settled = engine.applyAction(state, { userId: BOB, action: 'fold' }).state;
        expect(engine.getEscrowRefunds(settled)).toEqual([]);
    });

    test('hole cards are private until showdown; the deck never leaks', () => {
        const { state } = dealtHeadsUp();
        const aliceView = engine.getView(state, ALICE);
        expect(aliceView.seats[0].cards).toHaveLength(2);
        expect(aliceView.seats[1].cards).toBeNull();
        expect(aliceView.seats[1].cardCount).toBe(2);
        expect(aliceView.toCall).toBe(5);

        const spectator = engine.getView(state, CAROL);
        expect(spectator.yourSeat).toBeNull();
        expect(spectator.seats[0].cards).toBeNull();
        expect(spectator.seats[1].cards).toBeNull();
        expect(JSON.stringify(spectator)).not.toContain('"deck"');
    });

    test('the bot flag flows through sit into the view', () => {
        let state = engine.createTable();
        ({ state } = engine.applyAction(state, { userId: ALICE, action: 'sit' }));
        ({ state } = engine.applyAction(state, { userId: 'bot1', name: 'Goobster', action: 'sit', isBot: true }));
        const view = engine.getView(state, ALICE);
        expect(view.seats[1].isBot).toBe(true);
        expect(view.seats[0].isBot).toBe(false);
    });
});
