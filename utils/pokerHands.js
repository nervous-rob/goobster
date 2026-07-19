/**
 * Minimal 5-card poker: deck building, hand evaluation, and comparison.
 * Used by the /gamble poker game (5-card showdown vs. the dealer).
 *
 * Cards are { rank: 2..14, suit: 'S'|'H'|'D'|'C' } (14 = ace).
 * Evaluations are comparable arrays: [category, tiebreak1, tiebreak2, ...],
 * higher category first (8 = straight flush ... 0 = high card).
 */

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_EMOJI = { S: '\u2660\uFE0F', H: '\u2665\uFE0F', D: '\u2666\uFE0F', C: '\u2663\uFE0F' };
const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

const HAND_NAMES = [
    'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'
];

/**
 * Build a standard 52-card deck.
 * @returns {Array<{rank: number, suit: string}>}
 */
function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
    }
    return deck;
}

/**
 * Fisher-Yates shuffle (in place). `rng` is injectable for tests.
 * @param {Array} deck
 * @param {() => number} [rng] returns [0,1)
 * @returns {Array} the same array
 */
function shuffle(deck, rng = Math.random) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

/**
 * Evaluate a 5-card hand into a comparable array.
 * @param {Array<{rank: number, suit: string}>} cards - exactly 5
 * @returns {number[]} [category, ...tiebreaks] (compare element-wise)
 */
function evaluateHand(cards) {
    if (!Array.isArray(cards) || cards.length !== 5) {
        throw new Error('A poker hand must have exactly 5 cards');
    }

    const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
    const isFlush = cards.every(c => c.suit === cards[0].suit);

    // Straight detection, including the wheel (A-2-3-4-5)
    let straightHigh = 0;
    const unique = [...new Set(ranks)];
    if (unique.length === 5) {
        if (unique[0] - unique[4] === 4) {
            straightHigh = unique[0];
        } else if (unique[0] === 14 && unique[1] === 5 && unique[1] - unique[4] === 3) {
            straightHigh = 5; // ace plays low
        }
    }

    // Group ranks by count, ordered by count then rank (e.g. full house: [trip, pair])
    const counts = new Map();
    for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
    const groups = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const shape = groups.map(g => g[1]).join('');
    const groupRanks = groups.map(g => g[0]);

    if (straightHigh && isFlush) return [8, straightHigh];
    if (shape === '41') return [7, ...groupRanks];
    if (shape === '32') return [6, ...groupRanks];
    if (isFlush) return [5, ...ranks];
    if (straightHigh) return [4, straightHigh];
    if (shape === '311') return [3, ...groupRanks];
    if (shape === '221') return [2, ...groupRanks];
    if (shape === '2111') return [1, ...groupRanks];
    return [0, ...ranks];
}

/**
 * Compare two evaluations. Positive = a wins, negative = b wins, 0 = tie.
 */
function compareHands(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Human name for an evaluation, e.g. "Two Pair".
 */
function handName(evaluation) {
    return HAND_NAMES[evaluation[0]];
}

/**
 * Render a card like "A♠️" or "10♥️".
 */
function formatCard(card) {
    const rank = RANK_NAMES[card.rank] || String(card.rank);
    return `${rank}${SUIT_EMOJI[card.suit]}`;
}

/**
 * Render a hand like "A♠️ K♦️ 7♣️ 7♥️ 2♠️".
 */
function formatHand(cards) {
    return cards.map(formatCard).join(' ');
}

module.exports = { buildDeck, shuffle, evaluateHand, compareHands, handName, formatCard, formatHand, HAND_NAMES };
