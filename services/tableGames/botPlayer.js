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
 * Table-talk lines used when no AI provider is available (or the model
 * response has no comment). Keyed by moment.
 */
const CANNED_LINES = {
    win: ['Beep boop, ship it my way. 🤖', 'The house always... wait, I AM the house.', 'GG - my circuits called it.'],
    lose: ['Recalibrating... that one hurt.', 'You got me. This time.', 'I folded my dignity along with that hand.'],
    join: ['Deal me in! 🃏', 'Goobster has entered the table. Protect your chips.']
};

/** Quips when placing chance-game bets (kept canned - no AI call per bet). */
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

/** A human (non-bot) seat has chips in the current round. */
function humanHasWagered(view) {
    return view.seats.some(s => s && !s.isBot
        && ((s.bet ?? 0) > 0 || (s.totalWagered ?? 0) > 0));
}

/** Identifies "this decision window" so a failed action isn't retried forever. */
function roundKey(view) {
    return `${view.gameType}:${view.handId ?? view.roundId ?? 0}:${view.phase}:${view.street ?? ''}:${view.activeSeat ?? ''}`;
}

/** A plausible bet size: 1-4 big units, clamped to the table limits. */
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

/**
 * Per-game "advisors" turn a personalized view into a decision. Each
 * advisor exposes:
 *   needsAction(view) -> whether the bot should act on this view
 *   decide(view, helpers) -> { action, amount?, kind?, target?, comment? }
 *     helpers = { ai, rng, balance, currencyName }; `ai(messages, opts)`
 *     resolves to model text or null (unavailable/failed)
 *   retreat(view) -> a safe free action when the decision was rejected
 *     (e.g. not enough points), or null to sit the round out
 *
 * Hold'em is played through the AI (with a heuristic fallback); the chance
 * games use built-in strategy, keeping the AI for table talk. Adding bot
 * support for another game = adding an advisor here.
 */
const ADVISORS = {
    holdem: {
        needsAction(view) {
            return view.phase === 'acting'
                && view.yourSeat !== null
                && view.activeSeat === view.yourSeat;
        },

        buildDecisionContext(view, { balance, currencyName, images = [] } = {}) {
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
                'It is your turn in a friendly no-limit Texas Hold\'em game on Discord.',
                'Play reasonably well: fold junk to big bets, value-bet strong hands, and bluff occasionally.',
                `Game state: ${JSON.stringify(metadata)}`,
                '',
                'Respond with ONLY JSON, no other text:',
                '{"action": "fold" | "check" | "call" | "raise", "amount": <raise-to street total, integer, only for raise>, "comment": "<optional playful table talk, max 100 chars, or omit>"}'
            ].join('\n');

            return {
                messages: [
                    { role: 'system', content: 'You are Goobster, a quirky and clever Discord bot, playing poker with server members. Keep table talk short, fun, and never reveal your actual cards.' },
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
            return { action, amount: action === 'raise' ? amount : null };
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

        async decide(view, { ai, rng, balance, currencyName }) {
            let parsed = null;
            const context = this.buildDecisionContext(view, { balance, currencyName });
            const response = await ai(context.messages, { temperature: 0.7, max_tokens: 150 });
            if (response) {
                const jsonMatch = String(response).match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = null; }
                }
            }
            const legal = this.legalize(parsed || this.fallback(view, rng), view);
            return {
                action: legal.action === 'raise' ? 'bet' : legal.action,
                amount: legal.amount,
                comment: cleanComment(parsed?.comment)
            };
        },

        retreat(view) {
            return view.toCall > 0 ? 'fold' : 'check';
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

        decide(view, { rng }) {
            const mySeat = view.seats[view.yourSeat];
            if (view.phase === 'betting') {
                return { action: 'bet', amount: betAmount(view, rng), comment: maybeLine('blackjack', rng) };
            }

            // Simplified basic strategy (this engine has no splits)
            const up = view.dealer.cards[0];
            const upVal = up ? (up.rank === 14 ? 11 : Math.min(10, up.rank)) : 10;
            const { total, soft } = mySeat;
            const canDouble = mySeat.cards.length === 2 && !mySeat.doubled;

            if (canDouble && !soft && (total === 10 || total === 11) && upVal <= 9) return { action: 'double' };
            if (soft) {
                return { action: total <= 17 || (total === 18 && upVal >= 9) ? 'hit' : 'stand' };
            }
            if (total <= 11) return { action: 'hit' };
            if (total === 12) return { action: upVal >= 4 && upVal <= 6 ? 'stand' : 'hit' };
            if (total <= 16) return { action: upVal <= 6 ? 'stand' : 'hit' };
            return { action: 'stand' };
        },

        retreat(view) {
            // A rejected double (or hit that cannot happen) stands; a
            // rejected bet just sits the hand out.
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

        decide(view, { rng }) {
            const r = rng();
            let bet;
            if (r < 0.2) bet = { kind: 'red' };
            else if (r < 0.4) bet = { kind: 'black' };
            else if (r < 0.5) bet = { kind: 'odd' };
            else if (r < 0.6) bet = { kind: 'even' };
            else if (r < 0.75) bet = { kind: 'dozen', target: 1 + Math.floor(rng() * 3) };
            else if (r < 0.9) bet = { kind: 'column', target: 1 + Math.floor(rng() * 3) };
            else bet = { kind: 'straight', target: Math.floor(rng() * 37) };

            return {
                action: 'bet',
                amount: betAmount(view, rng),
                kind: bet.kind,
                target: bet.target ?? null,
                comment: maybeLine('roulette', rng)
            };
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

        decide(view, { rng }) {
            const r = rng();
            const target = r < 0.5 ? 'banker' : r < 0.85 ? 'player' : 'tie';
            return {
                action: 'bet',
                amount: betAmount(view, rng),
                target,
                comment: maybeLine('baccarat', rng)
            };
        }
    }
};

/**
 * Goobster as a table-game player. This is a side-effect service (never
 * part of an engine): it subscribes to tables like any other client,
 * watches personalized views, decides through the per-game advisors (AI
 * where it matters, built-in strategy for the chance games), acts through
 * the TableManager, and delivers table talk to the Activity clients, the
 * Discord channel, and - whenever the bot is in a voice channel of that
 * guild - the voice channel.
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
        if (!decision?.action) return;
        const { comment, ...move } = decision;

        try {
            this.tableManager.act({ table, userId: this.userId, name: BOT_NAME, ...move });
        } catch (error) {
            // Wallet or rule rejection: take the advisor's free action, or
            // sit this round out entirely.
            const retreat = advisor.retreat?.(view) ?? null;
            this.logger.warn?.(`[BotPlayer] ${move.action} rejected (${error.message}); ${retreat ? retreat + 'ing' : 'sitting out'} instead`);
            if (retreat) {
                try {
                    this.tableManager.act({ table, userId: this.userId, name: BOT_NAME, action: retreat });
                    return;
                } catch (retryError) {
                    this.logger.error?.('[BotPlayer] Retreat action failed too:', retryError.message);
                }
            }
            record.skipKey = roundKey(view);
            return;
        }

        if (comment) this._say(record, comment);
    }

    async _decide(record, view) {
        const advisor = ADVISORS[view.gameType];
        const guildId = record.table.guildId;

        let balance = null;
        let currencyName = 'points';
        try {
            balance = this.economy.getBalance(guildId, this.userId);
            currencyName = this.economy.getSettings(guildId).currencyName;
        } catch { /* decisions degrade fine without wallet context */ }

        const ai = async (messages, opts = {}) => {
            try {
                return await this.aiService.chatText(messages, {
                    ...opts,
                    usageContext: { guildId, userId: this.userId }
                });
            } catch (error) {
                this.logger.warn?.(`[BotPlayer] AI decision unavailable (${error.message}); using built-in strategy`);
                return null;
            }
        };

        return advisor.decide(view, { ai, rng: this.rng, balance, currencyName });
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
                `You are Goobster, a quirky Discord bot playing ${view.gameType} with server members. ` +
                `You just ${outcomeText}. ` +
                'Reply with ONLY one short, playful table-talk line (max 100 chars). No quotes.',
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

module.exports = { BotPlayer, ADVISORS, holdemStrength, BOT_NAME };
