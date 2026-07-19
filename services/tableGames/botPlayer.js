const aiServiceSingleton = require('../aiService');
const economyService = require('../economyService');
const { GameError } = require('./gameError');

// How long Goobster "thinks" before acting (feels human, batches updates)
const ACT_DELAY_MS = 1500;
// Never comment more often than this per table
const COMMENT_COOLDOWN_MS = 8000;
// Bankroll management: top the bot up whenever it runs low (the house can
// print its own chips; ledger type makes that auditable)
const MIN_BANKROLL = 500;
const TOPUP_AMOUNT = 2000;

const BOT_NAME = 'Goobster';
const FALLBACK_BOT_ID = 'goobster-bot';

/**
 * The bot's table personality, configurable via activity.bot.persona. It is
 * injected into every decision prompt, so a reckless persona really will
 * fire off wild bets and a cautious one will nurse its chips.
 */
const DEFAULT_PERSONA =
    'quirky, clever, and a little dramatic - enjoys a spicy bet when the moment feels right, ' +
    'but hates losing chips to boredom';

/**
 * Table-talk lines used when no AI provider is available (or the model
 * response has no comment). Keyed by moment.
 */
const CANNED_LINES = {
    win: ['Beep boop, ship it my way. 🤖', 'The house always... wait, I AM the house.', 'GG - my circuits called it.'],
    lose: ['Recalibrating... that one hurt.', 'You got me. This time.', 'I folded my dignity along with that hand.'],
    join: ['Deal me in! 🃏', 'Goobster has entered the table. Protect your chips.']
};

/** Quips for fallback bets (no AI around to write its own). */
const BET_LINES = {
    blackjack: ['Dealer, be gentle.', 'Card counting? Me? I only count in binary.', 'Chips in. Courage found.'],
    roulette: ['The wheel whispered to me.', 'Physics is just a suggestion.', 'My random number generator has a good feeling.'],
    baccarat: ['Squeeze the cards sloooowly.', 'This one is all skill. (It is not.)', 'Fortune favors the bot.']
};

function cleanComment(comment) {
    if (typeof comment !== 'string') return null;
    const trimmed = comment.trim().slice(0, 160);
    return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Hidden-information hygiene: models love to narrate their own hole cards
// ("tosses the 10-4 into the muck..."), which is terrible poker. Comments in
// competitive games run through a deterministic filter and are dropped when
// they mention the bot's hidden cards or telegraph hand strength.
// ---------------------------------------------------------------------------

const HAND_STRENGTH_TERMS = new RegExp(
    '\\b(pairs?|two pair|trips|sets?|straights?|flush(?:es)?|full house|boat|quads?|' +
    'four of a kind|three of a kind|high card|kickers?|pocket|suited|off-?suit|' +
    'connectors?|overpair|top pair|nuts|draw(?:ing|s)?|bluff(?:ing)?|monster|rags?|junk|air)\\b', 'i');
const CARD_GLYPHS = /[♠♥♦♣]/;
// Any card-rank word is off-limits mid-hand - even ranks the bot does not
// hold (a claimed "my king-ten" reveals information whether true or bluffed)
const RANK_TERMS = /\b(?:aces?|kings?|queens?|jacks?|tens?|nines?|eights?|sevens?|sixes?|fives?|fours?|threes?|twos?|deuces?|treys?)\b/i;
const HOLE_DIGITS = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10' };

/**
 * Whether a table-talk line would leak hidden-card information while the
 * hand is live: any card glyph, any hand-strength talk, any card-rank word
 * at all, or the bot's own hole ranks as bare digits.
 */
function leaksHiddenCards(comment, holeCards) {
    if (CARD_GLYPHS.test(comment)) return true;
    if (HAND_STRENGTH_TERMS.test(comment)) return true;
    if (RANK_TERMS.test(comment)) return true;
    for (const card of holeCards) {
        const digit = HOLE_DIGITS[card.rank];
        if (digit && new RegExp(`\\b${digit}\\b`).test(comment)) return true;
    }
    return false;
}

/** A human (non-bot) seat has chips in the current round. */
function humanHasWagered(view) {
    return view.seats.some(s => s && !s.isBot
        && ((s.bet ?? 0) > 0 || (s.totalWagered ?? 0) > 0));
}

/** Identifies "this decision window" so a failed action isn't retried forever. */
function roundKey(view) {
    return `${view.gameType}:${view.handId ?? view.roundId ?? 0}:${view.phase}:${view.street ?? ''}:${view.activeSeat ?? ''}`;
}

/** Clamp a model-supplied amount into the table limits (or null if unusable). */
function clampAmount(raw, view) {
    const amount = Math.floor(Number(raw));
    if (!Number.isFinite(amount)) return null;
    return Math.max(view.minBet, Math.min(view.maxBet, amount));
}

/** A plausible fallback bet size: 1-4 big units, clamped to the table limits. */
function betAmount(view, rng) {
    const amount = view.minBet * (1 + Math.floor(rng() * 4));
    return Math.max(view.minBet, Math.min(view.maxBet, amount));
}

function maybeLine(game, rng) {
    if (rng() >= 0.35) return null;
    const lines = BET_LINES[game] || [];
    return lines[Math.floor(rng() * lines.length)] || null;
}

/** 0 = weak, 1 = medium, 2 = strong (pre- and postflop). */
function holdemStrength(hole, community) {
    const ranks = hole.map(c => c.rank);
    if (community.length === 0) {
        if (ranks[0] === ranks[1]) return ranks[0] >= 8 ? 2 : 1;
        if (ranks.every(r => r >= 11)) return 2;
        if (ranks.every(r => r >= 9) || hole[0].suit === hole[1].suit) return 1;
        return 0;
    }
    // Postflop: category of the best 5-card hand (needs pokerHands.bestHand)
    const { bestHand } = require('../../utils/pokerHands');
    const category = bestHand([...hole, ...community]).evaluation[0];
    if (category >= 2) return 2;
    if (category === 1) return 1;
    return 0;
}

/** The shared system message carrying the persona into every decision. */
function personaMessage(persona) {
    return {
        role: 'system',
        content: 'You are Goobster, a Discord bot playing casino table games with server members for points. ' +
            `Your persona: ${persona}. Let this persona genuinely drive your risk appetite, bet sizing, and play ` +
            'style - a wild persona makes wild bets, a careful one protects its chips. Keep table talk short and ' +
            'fun. In games with hidden information you are playing AGAINST the other players: NEVER state, hint ' +
            'at, or joke about your own cards, their ranks or suits, or how strong or weak your hand is - not ' +
            'even when folding. Trash-talk opponents and react to the board instead.'
    };
}

/** Public info about the other seats, passed to the model like a player would see it. */
function seatSummaries(view) {
    return view.seats
        .filter(s => s && s.seat !== view.yourSeat)
        .map(s => ({
            name: s.name,
            bet: s.bet ?? s.totalWagered ?? 0,
            ...(s.cards ? { cards: s.cards.map(c => c.label), total: s.total, busted: s.busted, standing: s.standing } : {}),
            ...(s.bets ? { bets: s.bets.map(b => b.label) } : {}),
            ...(s.target ? { backing: s.target } : {})
        }));
}

/**
 * Per-game "advisors". Every game is decided BY THE MODEL - the advisor's
 * job is to hand it the same information and options a human player sees,
 * then police the response:
 *   needsAction(view) -> whether the bot should act on this view
 *   buildDecisionContext(view, { persona, balance, currencyName, images }) ->
 *     { messages } for the AI call (messages may carry `images` - the
 *     extension point for feeding rendered-table screenshots to vision models)
 *   legalize(decision, view) -> { actions: [engine moves] } | { pass: true } | null
 *     (null = unusable response; the fallback plays instead)
 *   fallback(view, rng) -> a decision in the same shape the model returns,
 *     used only when no AI provider responds
 *   retreat(view) -> a safe free action when a move is rejected (e.g. not
 *     enough points), or null to sit the round out
 *
 * Adding bot support for another game = adding an advisor here.
 */
const ADVISORS = {
    holdem: {
        needsAction(view) {
            return view.phase === 'acting'
                && view.yourSeat !== null
                && view.activeSeat === view.yourSeat;
        },

        buildDecisionContext(view, { persona, balance, currencyName, images = [] } = {}) {
            const mySeat = view.seats[view.yourSeat];
            const minRaiseTo = view.currentBet === 0 ? view.minBet : view.currentBet + view.minBet;
            const metadata = {
                game: 'no-limit texas holdem',
                street: view.street,
                yourHoleCards: (mySeat.cards || []).map(c => c.label),
                communityCards: view.community.map(c => c.label),
                pot: view.pot,
                toCall: view.toCall,
                currentStreetBet: view.currentBet,
                minRaiseTo,
                maxRaiseTo: view.maxBet,
                yourChipsInPot: mySeat.totalWagered,
                yourBalance: balance,
                currency: currencyName,
                players: view.seats
                    .filter(s => s && s.cardCount > 0)
                    .map(s => ({
                        name: s.name,
                        you: s.seat === view.yourSeat,
                        folded: s.folded,
                        chipsInPotThisStreet: s.streetBet,
                        chipsInPotThisHand: s.totalWagered,
                        hasButton: s.isButton
                    }))
            };

            const prompt = [
                'It is your turn in a no-limit Texas Hold\'em hand on Discord.',
                `Game state: ${JSON.stringify(metadata)}`,
                '',
                'Your options: fold; check (only when nothing to call); call; raise (street total between minRaiseTo and maxRaiseTo).',
                'Respond with ONLY JSON, no other text:',
                '{"action": "fold" | "check" | "call" | "raise", "amount": <raise-to street total, integer, only for raise>, "comment": "<optional table talk - must NOT mention or hint at your cards or hand strength - max 100 chars, or omit>"}'
            ].join('\n');

            return {
                messages: [
                    personaMessage(persona),
                    { role: 'user', content: prompt, ...(images.length > 0 ? { images } : {}) }
                ]
            };
        },

        /** Clamp/repair a model decision into something the engine accepts. */
        legalize(decision, view) {
            const minRaiseTo = view.currentBet === 0 ? view.minBet : view.currentBet + view.minBet;
            let action = String(decision?.action || '').toLowerCase();
            let amount = Number.isFinite(Number(decision?.amount)) ? Math.floor(Number(decision.amount)) : null;

            if (action === 'bet') action = 'raise';
            if (!['fold', 'check', 'call', 'raise'].includes(action)) {
                action = view.toCall > 0 ? 'fold' : 'check';
            }
            if (action === 'check' && view.toCall > 0) action = 'fold';
            if (action === 'call' && view.toCall === 0) action = 'check';
            if (action === 'raise') {
                if (minRaiseTo > view.maxBet) action = view.toCall > 0 ? 'call' : 'check';
                else amount = Math.max(minRaiseTo, Math.min(view.maxBet, amount ?? minRaiseTo));
            }
            return {
                actions: [{
                    action: action === 'raise' ? 'bet' : action,
                    amount: action === 'raise' ? amount : null
                }]
            };
        },

        /** Crude but serviceable heuristic when no AI provider is around. */
        fallback(view, rng = Math.random) {
            const mySeat = view.seats[view.yourSeat];
            const hole = mySeat.cards || [];
            const strength = holdemStrength(hole, view.community);
            const minRaiseTo = view.currentBet === 0 ? view.minBet : view.currentBet + view.minBet;
            const smallCall = view.toCall <= Math.max(2 * view.minBet, Math.floor(view.pot / 4));

            if (strength >= 2) {
                // Strong: raise (bounded) or call a re-raise war
                const target = Math.min(view.maxBet, Math.max(minRaiseTo, view.currentBet + 3 * view.minBet));
                if (view.currentBet >= view.maxBet || rng() < 0.3) {
                    return view.toCall > 0 ? { action: 'call' } : { action: 'check' };
                }
                return { action: 'raise', amount: target };
            }
            if (strength === 1) {
                if (view.toCall === 0) return { action: 'check' };
                return smallCall ? { action: 'call' } : { action: 'fold' };
            }
            // Weak: free card, cheap peek preflop, rare small bluff
            if (view.toCall === 0) {
                if (rng() < 0.1) return { action: 'raise', amount: minRaiseTo };
                return { action: 'check' };
            }
            if (view.street === 'preflop' && view.toCall <= view.minBet) return { action: 'call' };
            return { action: 'fold' };
        },

        retreat(view) {
            return view.toCall > 0 ? 'fold' : 'check';
        },

        /**
         * Hold'em is competitive with hidden cards: drop any mid-hand
         * comment that mentions the bot's hole cards or hand strength.
         */
        sanitizeComment(comment, view) {
            const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
            return leaksHiddenCards(comment, mySeat?.cards || []) ? null : comment;
        }
    },

    blackjack: {
        needsAction(view) {
            const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
            if (!mySeat) return false;
            // The bot follows, never leads: it only bets into a betting
            // window a human already opened.
            if (view.phase === 'betting' && mySeat.bet === 0) return humanHasWagered(view);
            return view.phase === 'acting' && view.activeSeat === view.yourSeat;
        },

        buildDecisionContext(view, { persona, balance, currencyName, images = [] } = {}) {
            const mySeat = view.seats[view.yourSeat];
            const rules = 'dealer stands on all 17s, blackjack pays 3:2, double on your first two cards only, no splits';
            let metadata;
            let optionsText;
            if (view.phase !== 'acting') {
                metadata = {
                    game: 'blackjack',
                    decision: 'place your bet for the next hand (or sit it out)',
                    rules,
                    minBet: view.minBet,
                    maxBet: view.maxBet,
                    yourBalance: balance,
                    currency: currencyName,
                    otherPlayers: seatSummaries(view)
                };
                optionsText = [
                    'Your options: bet any whole amount between minBet and maxBet, sized to your persona; or pass to sit this hand out.',
                    'Respond with ONLY JSON, no other text:',
                    '{"action": "bet" | "pass", "amount": <integer, only for bet>, "comment": "<optional playful table talk, max 100 chars, or omit>"}'
                ].join('\n');
            } else {
                const canDouble = mySeat.cards.length === 2 && !mySeat.doubled;
                metadata = {
                    game: 'blackjack',
                    decision: 'play your hand',
                    rules,
                    yourHand: mySeat.cards.map(c => c.label),
                    yourTotal: mySeat.total,
                    softTotal: mySeat.soft,
                    yourBet: mySeat.bet,
                    canDouble,
                    dealerShowing: view.dealer.cards[0]?.label ?? null,
                    yourBalance: balance,
                    currency: currencyName,
                    otherPlayers: seatSummaries(view)
                };
                optionsText = [
                    `Your options: hit; stand${canDouble ? '; double (one card, doubles your bet)' : ''}.`,
                    'Respond with ONLY JSON, no other text:',
                    '{"action": "hit" | "stand"' + (canDouble ? ' | "double"' : '') + ', "comment": "<optional playful table talk, max 100 chars, or omit>"}'
                ].join('\n');
            }

            const prompt = [
                'You are seated at a blackjack table on Discord.',
                `Game state: ${JSON.stringify(metadata)}`,
                '',
                optionsText
            ].join('\n');

            return {
                messages: [
                    personaMessage(persona),
                    { role: 'user', content: prompt, ...(images.length > 0 ? { images } : {}) }
                ]
            };
        },

        legalize(decision, view) {
            const action = String(decision?.action || '').toLowerCase();
            if (view.phase !== 'acting') {
                if (action === 'pass' || action === 'sit-out') return { pass: true };
                if (action !== 'bet') return null;
                const amount = clampAmount(decision.amount, view);
                if (amount === null) return null;
                return { actions: [{ action: 'bet', amount }] };
            }
            const mySeat = view.seats[view.yourSeat];
            const canDouble = mySeat.cards.length === 2 && !mySeat.doubled;
            if (action === 'double') {
                // A double when doubling is off the table still means "give
                // me a card"
                return { actions: [{ action: canDouble ? 'double' : 'hit' }] };
            }
            if (action === 'hit' || action === 'stand') return { actions: [{ action }] };
            return null;
        },

        /** Bet-a-little + simplified basic strategy, only without a provider. */
        fallback(view, rng = Math.random) {
            if (view.phase !== 'acting') {
                return { action: 'bet', amount: betAmount(view, rng) };
            }
            const mySeat = view.seats[view.yourSeat];
            const up = view.dealer.cards[0];
            const upVal = up ? (up.rank === 14 ? 11 : Math.min(10, up.rank)) : 10;
            const { total, soft } = mySeat;
            const canDouble = mySeat.cards.length === 2 && !mySeat.doubled;

            if (canDouble && !soft && (total === 10 || total === 11) && upVal <= 9) return { action: 'double' };
            if (soft) return { action: total <= 17 || (total === 18 && upVal >= 9) ? 'hit' : 'stand' };
            if (total <= 11) return { action: 'hit' };
            if (total === 12) return { action: upVal >= 4 && upVal <= 6 ? 'stand' : 'hit' };
            if (total <= 16) return { action: upVal <= 6 ? 'stand' : 'hit' };
            return { action: 'stand' };
        },

        retreat(view) {
            // A rejected double (not enough points) stands; a rejected bet
            // just sits the hand out.
            return view.phase === 'acting' ? 'stand' : null;
        }
    },

    roulette: {
        needsAction(view) {
            const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
            return Boolean(mySeat)
                && view.phase === 'betting'
                && mySeat.totalWagered === 0
                && humanHasWagered(view);
        },

        buildDecisionContext(view, { persona, balance, currencyName, images = [] } = {}) {
            const metadata = {
                game: 'european roulette (single zero)',
                decision: 'place your bets for this spin (or sit it out)',
                betTypes: {
                    straight: 'one number, target 0-36, pays 35:1',
                    'red/black/odd/even/low/high': 'pays 1:1 (low is 1-18, high is 19-36; zero loses these)',
                    dozen: 'target 1-3, pays 2:1',
                    column: 'target 1-3, pays 2:1'
                },
                minBetEach: view.minBet,
                maxBetEach: view.maxBet,
                yourBalance: balance,
                currency: currencyName,
                recentNumbers: view.history.map(h => `${h.number} ${h.color}`),
                otherPlayers: seatSummaries(view)
            };

            const prompt = [
                'You are at a roulette table on Discord and the betting window is open.',
                `Game state: ${JSON.stringify(metadata)}`,
                '',
                'Your options: place 1 to 5 bets (each with its own amount, sized to your persona), or pass to sit this spin out.',
                'Respond with ONLY JSON, no other text:',
                '{"bets": [{"kind": "straight" | "red" | "black" | "odd" | "even" | "low" | "high" | "dozen" | "column", "target": <integer, only for straight/dozen/column>, "amount": <integer>}], "comment": "<optional playful table talk, max 100 chars, or omit>"}',
                'or {"action": "pass"}'
            ].join('\n');

            return {
                messages: [
                    personaMessage(persona),
                    { role: 'user', content: prompt, ...(images.length > 0 ? { images } : {}) }
                ]
            };
        },

        legalize(decision, view) {
            if (String(decision?.action || '').toLowerCase() === 'pass') return { pass: true };
            const list = Array.isArray(decision?.bets) ? decision.bets
                : decision?.kind ? [decision] : null;
            if (!list) return null;

            const actions = [];
            for (const bet of list.slice(0, 5)) {
                const kind = String(bet?.kind || '').toLowerCase();
                let target = Number.isFinite(Number(bet?.target)) ? Math.floor(Number(bet.target)) : null;
                if (kind === 'straight') {
                    if (target === null || target < 0 || target > 36) continue;
                } else if (kind === 'dozen' || kind === 'column') {
                    if (target === null || target < 1 || target > 3) continue;
                } else if (['red', 'black', 'odd', 'even', 'low', 'high'].includes(kind)) {
                    target = null;
                } else {
                    continue;
                }
                const amount = clampAmount(bet?.amount, view);
                if (amount === null) continue;
                actions.push({ action: 'bet', kind, target, amount });
            }
            return actions.length > 0 ? { actions } : null;
        },

        fallback(view, rng = Math.random) {
            const r = rng();
            let bet;
            if (r < 0.2) bet = { kind: 'red' };
            else if (r < 0.4) bet = { kind: 'black' };
            else if (r < 0.5) bet = { kind: 'odd' };
            else if (r < 0.6) bet = { kind: 'even' };
            else if (r < 0.75) bet = { kind: 'dozen', target: 1 + Math.floor(rng() * 3) };
            else if (r < 0.9) bet = { kind: 'column', target: 1 + Math.floor(rng() * 3) };
            else bet = { kind: 'straight', target: Math.floor(rng() * 37) };
            return { bets: [{ ...bet, amount: betAmount(view, rng) }] };
        }
    },

    baccarat: {
        needsAction(view) {
            const mySeat = view.yourSeat !== null ? view.seats[view.yourSeat] : null;
            return Boolean(mySeat)
                && view.phase === 'betting'
                && mySeat.bet === 0
                && humanHasWagered(view);
        },

        buildDecisionContext(view, { persona, balance, currencyName, images = [] } = {}) {
            const metadata = {
                game: 'baccarat (punto banco)',
                decision: 'back a side for this round (or sit it out)',
                betTypes: {
                    player: 'pays 1:1',
                    banker: 'pays 1:1 minus 5% commission (best odds)',
                    tie: 'pays 8:1 (player/banker bets push on a tie)'
                },
                minBet: view.minBet,
                maxBet: view.maxBet,
                yourBalance: balance,
                currency: currencyName,
                otherPlayers: seatSummaries(view)
            };

            const prompt = [
                'You are at a baccarat table on Discord and the betting window is open.',
                `Game state: ${JSON.stringify(metadata)}`,
                '',
                'Your options: bet on player, banker, or tie with any whole amount between minBet and maxBet, sized to your persona; or pass to sit this round out.',
                'Respond with ONLY JSON, no other text:',
                '{"action": "bet" | "pass", "target": "player" | "banker" | "tie", "amount": <integer, only for bet>, "comment": "<optional playful table talk, max 100 chars, or omit>"}'
            ].join('\n');

            return {
                messages: [
                    personaMessage(persona),
                    { role: 'user', content: prompt, ...(images.length > 0 ? { images } : {}) }
                ]
            };
        },

        legalize(decision, view) {
            const action = String(decision?.action || '').toLowerCase();
            if (action === 'pass' || action === 'sit-out') return { pass: true };
            const target = String(decision?.target || '').toLowerCase();
            if (!['player', 'banker', 'tie'].includes(target)) return null;
            const amount = clampAmount(decision?.amount, view);
            if (amount === null) return null;
            return { actions: [{ action: 'bet', target, amount }] };
        },

        fallback(view, rng = Math.random) {
            const r = rng();
            const target = r < 0.5 ? 'banker' : r < 0.85 ? 'player' : 'tie';
            return { action: 'bet', target, amount: betAmount(view, rng) };
        }
    }
};

/**
 * Goobster as a table-game player. This is a side-effect service (never
 * part of an engine): it subscribes to tables like any other client,
 * watches personalized views, and plays every game the way a person would -
 * the full game state and the same options a player has go to the AI
 * provider, whose response is validated/clamped before it touches the
 * table (a built-in fallback plays only when no provider responds). Table
 * talk goes to the Activity clients, optionally the Discord channel, and -
 * whenever the bot is in a voice channel of that guild - the voice channel.
 */
class BotPlayer {
    constructor({
        tableManager,
        client = null,
        config = {},
        logger = console,
        aiService = aiServiceSingleton,
        economy = economyService,
        voiceSessions = null,     // lazy-required by default (heavy deps)
        getVoiceConnection = null, // injectable for tests
        ttsService = null,         // injectable for tests
        rng = Math.random,
        actDelayMs = ACT_DELAY_MS,
        commentCooldownMs = COMMENT_COOLDOWN_MS
    }) {
        this.tableManager = tableManager;
        this.client = client;
        this.logger = logger;
        this.aiService = aiService;
        this.economy = economy;
        this._voiceSessions = voiceSessions;
        this._getVoiceConnection = getVoiceConnection;
        this._ttsService = ttsService;
        this.rng = rng;
        this.actDelayMs = actDelayMs;
        this.commentCooldownMs = commentCooldownMs;

        const botConfig = config.activity?.bot || {};
        this.enabled = botConfig.enabled !== false;
        this.textComments = botConfig.textComments === true;
        this.voiceComments = botConfig.voiceComments !== false;
        this.persona = typeof botConfig.persona === 'string' && botConfig.persona.trim().length > 0
            ? botConfig.persona.trim().slice(0, 500)
            : DEFAULT_PERSONA;

        this.tables = new Map(); // table.key -> { table, unsubscribe, thinking, lastCommentAt, skipKey, timer }
    }

    get userId() {
        return this.client?.user?.id || FALLBACK_BOT_ID;
    }

    supports(gameType) {
        return Boolean(ADVISORS[gameType]);
    }

    isAtTable(table) {
        return this.tables.has(table.key);
    }

    /**
     * Seat Goobster at a table (invited from the Activity). Ensures a
     * bankroll, subscribes for updates, and sits with the bot flag.
     * @throws {GameError} when the bot is disabled/unsupported/already there
     */
    invite(table) {
        if (!this.enabled) throw new GameError('BOT_DISABLED', 'Goobster is not taking a seat right now.');
        if (!this.supports(table.engine.gameType)) {
            throw new GameError('BOT_UNSUPPORTED', `Goobster does not play ${table.engine.gameType} yet.`);
        }
        if (this.isAtTable(table)) throw new GameError('BOT_ALREADY_SEATED', 'Goobster is already at this table.');

        this._ensureBankroll(table.guildId);

        const record = { table, unsubscribe: () => {}, thinking: false, lastCommentAt: 0, skipKey: null, timer: null };
        this.tables.set(table.key, record);
        record.unsubscribe = this.tableManager.subscribe(table, {
            userId: this.userId,
            name: BOT_NAME,
            send: (message) => this._onMessage(record, message)
        });

        try {
            this.tableManager.act({ table, userId: this.userId, name: BOT_NAME, action: 'sit', isBot: true });
        } catch (error) {
            this._teardown(record);
            throw error;
        }

        this._say(record, this._canned('join'));
    }

    /** Remove Goobster from a table (player request, or self-dismissal). */
    dismiss(table) {
        const record = this.tables.get(table.key);
        if (!record) return;
        try {
            this.tableManager.act({ table, userId: this.userId, action: 'leave' });
        } catch (error) {
            if (!(error instanceof GameError)) this.logger.warn?.('[BotPlayer] Leave failed:', error.message);
        }
        this._teardown(record);
    }

    /** Drop every table (shutdown). */
    stop() {
        for (const record of [...this.tables.values()]) this._teardown(record);
    }

    _teardown(record) {
        if (record.timer) clearTimeout(record.timer);
        record.unsubscribe();
        this.tables.delete(record.table.key);
    }

    _ensureBankroll(guildId) {
        try {
            const balance = this.economy.getBalance(guildId, this.userId);
            if (balance < MIN_BANKROLL) {
                this.economy.adjust({
                    guildId,
                    userId: this.userId,
                    amount: TOPUP_AMOUNT,
                    type: 'bot-bankroll',
                    detail: JSON.stringify({ reason: 'table-buy-in' })
                });
            }
        } catch (error) {
            this.logger.warn?.('[BotPlayer] Bankroll top-up failed:', error.message);
        }
    }

    // ------------------------------------------------------------------
    // Update handling
    // ------------------------------------------------------------------

    _onMessage(record, message) {
        if (message.type !== 'state' && message.type !== 'update') return;
        const view = message.view;
        if (!view) return;
        const advisor = ADVISORS[view.gameType];
        if (!advisor) return;

        // The last human stood up: no point playing against ourselves.
        const humansSeated = view.seats.some(s => s && !s.isBot);
        if (!humansSeated && view.phase !== 'acting') {
            // Defer: we're inside subscriber iteration; leaving triggers a
            // broadcast that mutates the subscriber set.
            setTimeout(() => this.dismiss(record.table), 0).unref?.();
            return;
        }

        if (advisor.needsAction(view) && record.skipKey !== roundKey(view)) {
            this._scheduleAction(record);
        }

        for (const event of message.events || []) {
            if (event.type === 'settled') {
                this._ensureBankroll(record.table.guildId);
                this._maybeCommentOnOutcome(record);
            }
        }
    }

    _scheduleAction(record) {
        if (record.thinking) return;
        record.thinking = true;
        record.timer = setTimeout(() => {
            record.timer = null;
            this._actNow(record)
                .catch(error => this.logger.error?.('[BotPlayer] Turn handling failed:', error))
                .finally(() => {
                    record.thinking = false;
                    // Some transitions hand the turn right back (e.g. the
                    // bot's blackjack bet deals a hand where it acts first);
                    // that broadcast arrived while we were still "thinking".
                    if (!this.tables.has(record.table.key)) return;
                    const view = record.table.engine.getView(record.table.state, this.userId);
                    const advisor = ADVISORS[view.gameType];
                    if (advisor?.needsAction(view) && record.skipKey !== roundKey(view)) {
                        this._scheduleAction(record);
                    }
                });
        }, this.actDelayMs);
        record.timer.unref?.();
    }

    async _actNow(record) {
        const { table } = record;
        if (!this.tables.has(table.key)) return;
        const view = table.engine.getView(table.state, this.userId);
        const advisor = ADVISORS[view.gameType];
        if (!advisor || !advisor.needsAction(view)) return; // stale
        if (record.skipKey === roundKey(view)) return;

        const decision = await this._decide(record, view);
        if (!decision) return;
        if (decision.pass || !decision.actions?.length) {
            // The persona chose to sit this round out
            record.skipKey = roundKey(view);
            if (decision.comment) this._say(record, decision.comment);
            return;
        }

        let acted = false;
        for (const move of decision.actions) {
            try {
                this.tableManager.act({ table, userId: this.userId, name: BOT_NAME, ...move });
                acted = true;
            } catch (error) {
                if (!acted) {
                    // First move rejected (wallet or rules): take the
                    // advisor's free action, or sit the round out.
                    const retreat = advisor.retreat?.(view) ?? null;
                    this.logger.warn?.(`[BotPlayer] ${move.action} rejected (${error.message}); ${retreat ? retreat + 'ing' : 'sitting out'} instead`);
                    if (retreat) {
                        try {
                            this.tableManager.act({ table, userId: this.userId, name: BOT_NAME, action: retreat });
                        } catch (retryError) {
                            this.logger.error?.('[BotPlayer] Retreat action failed too:', retryError.message);
                            record.skipKey = roundKey(view);
                        }
                    } else {
                        record.skipKey = roundKey(view);
                    }
                    return;
                }
                // Later moves (extra roulette bets) can fail independently
                this.logger.warn?.(`[BotPlayer] Follow-up ${move.action} rejected (${error.message})`);
                break;
            }
        }

        if (acted && decision.comment) this._say(record, decision.comment);
    }

    /**
     * Ask the model to play the bot's turn: full game state + the player's
     * options go in, ONLY-JSON comes back, and the advisor's validator
     * repairs it into legal moves. The heuristic fallback plays only when
     * no provider produces a usable answer.
     */
    async _decide(record, view) {
        const advisor = ADVISORS[view.gameType];
        const guildId = record.table.guildId;

        let balance = null;
        let currencyName = 'points';
        try {
            balance = this.economy.getBalance(guildId, this.userId);
            currencyName = this.economy.getSettings(guildId).currencyName;
        } catch { /* decisions degrade fine without wallet context */ }

        let parsed = null;
        try {
            const context = advisor.buildDecisionContext(view, {
                persona: this.persona, balance, currencyName
            });
            const response = await this.aiService.chatText(context.messages, {
                temperature: 0.8,
                max_tokens: 250,
                usageContext: { guildId, userId: this.userId }
            });
            const jsonMatch = String(response || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
            }
        } catch (error) {
            this.logger.warn?.(`[BotPlayer] AI decision unavailable (${error.message}); using fallback strategy`);
        }

        if (parsed) {
            const decision = advisor.legalize(parsed, view);
            if (decision) {
                let comment = cleanComment(parsed.comment);
                if (comment && advisor.sanitizeComment) {
                    const safe = advisor.sanitizeComment(comment, view);
                    if (!safe) this.logger.info?.('[BotPlayer] Dropped a comment that would have revealed hidden cards');
                    comment = safe;
                }
                return { ...decision, comment };
            }
            this.logger.warn?.('[BotPlayer] Model decision failed validation; using fallback strategy');
        }

        const fallback = advisor.legalize(advisor.fallback(view, this.rng), view);
        return fallback ? { ...fallback, comment: maybeLine(view.gameType, this.rng) } : null;
    }

    // ------------------------------------------------------------------
    // Table talk
    // ------------------------------------------------------------------

    _canned(moment) {
        const lines = CANNED_LINES[moment] || [];
        if (lines.length === 0) return null;
        return lines[Math.floor(this.rng() * lines.length)];
    }

    async _maybeCommentOnOutcome(record) {
        if (this.rng() > 0.5) return;
        const view = record.table.engine.getView(record.table.state, this.userId);
        const mine = view.results?.entries?.find(e => e.userId === this.userId);
        if (!mine) return;

        const wagered = mine.wagered ?? mine.totalWagered ?? null;
        const net = wagered !== null && typeof mine.payout === 'number' ? mine.payout - wagered : null;
        const outcomeText = mine.outcome === 'push'
            ? 'pushed (bet returned)'
            : mine.outcome === 'win' || mine.outcome === 'blackjack'
                ? `won${mine.handName ? ` with ${mine.handName}` : ''}${net !== null ? ` (net ${net >= 0 ? '+' : ''}${net})` : ''}`
                : 'lost the round';

        let line;
        try {
            const response = await this.aiService.generateText(
                `You are Goobster, a Discord bot playing ${view.gameType} with server members. ` +
                `Your persona: ${this.persona}. You just ${outcomeText}. ` +
                'Reply with ONLY one short, playful in-persona table-talk line (max 100 chars). No quotes.',
                { temperature: 0.9, max_tokens: 60, usageContext: { guildId: record.table.guildId, userId: this.userId } }
            );
            line = cleanComment(response);
        } catch {
            line = this._canned(mine.outcome === 'lose' || mine.outcome === 'bust' ? 'lose' : 'win');
        }
        if (line) this._say(record, line);
    }

    /**
     * Deliver a table-talk line: always to the Activity clients (chat
     * message), optionally to the Discord channel, and out loud whenever
     * the bot is in one of the guild's voice channels.
     */
    _say(record, text) {
        if (!text) return;
        const now = Date.now();
        if (now - record.lastCommentAt < this.commentCooldownMs) return;
        record.lastCommentAt = now;

        this.tableManager.notify(record.table, { type: 'chat', from: BOT_NAME, bot: true, text });

        if (this.textComments && this.client) {
            this.client.channels.fetch(record.table.channelId)
                .then(channel => channel?.isTextBased?.() ? channel.send({
                    content: `🎰 ${text}`,
                    allowedMentions: { users: [], roles: [] }
                }) : null)
                .catch(() => {});
        }

        if (this.voiceComments) this._speak(record.table.guildId, text);
    }

    /**
     * Speak a line into the guild's voice channel when the bot is already
     * connected there - either through a live /voicechat session (reusing
     * its TTS pipeline) or any other voice connection (music, /speak...).
     * Never joins a voice channel on its own.
     */
    _speak(guildId, text) {
        try {
            const voiceSessions = this._voiceSessions
                || (this._voiceSessions = require('../voice/voiceSessionService'));
            const session = voiceSessions.getSession?.(guildId);
            if (session?.ttsService?.textToSpeech) {
                Promise.resolve(
                    session.ttsService.textToSpeech(text, session.voiceChannel, session.connection)
                ).catch(error => this.logger.warn?.('[BotPlayer] Voice comment failed:', error.message));
                return;
            }

            const getConnection = this._getVoiceConnection
                || (this._getVoiceConnection = require('@discordjs/voice').getVoiceConnection);
            const connection = getConnection(guildId);
            if (!connection) return; // not in a voice channel - stay quiet

            const tts = this._resolveTts();
            if (!tts?.textToSpeech || tts.disabled) return;
            const channelId = connection.joinConfig?.channelId;
            const voiceChannel = channelId ? this.client?.channels?.cache?.get(channelId) : null;
            Promise.resolve(
                tts.textToSpeech(text, voiceChannel, connection)
            ).catch(error => this.logger.warn?.('[BotPlayer] Voice comment failed:', error.message));
        } catch (error) {
            this.logger.warn?.('[BotPlayer] Voice comment unavailable:', error.message);
        }
    }

    _resolveTts() {
        if (this._ttsService) return this._ttsService;
        try {
            return require('../serviceManager').voiceService?.tts || null;
        } catch {
            return null;
        }
    }
}

module.exports = { BotPlayer, ADVISORS, holdemStrength, BOT_NAME, DEFAULT_PERSONA };
