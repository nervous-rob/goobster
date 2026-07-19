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

/**
 * Per-game "advisors" turn a personalized view into a decision. Each
 * advisor exposes:
 *   buildDecisionContext(view, extras) -> { messages } for the AI call
 *     (messages may carry `images` - the extension point for feeding the
 *     model screenshots of the rendered table alongside the metadata)
 *   legalize(decision, view) -> a guaranteed-legal decision
 *   fallback(view, rng) -> heuristic decision when the AI is unavailable
 *
 * Adding bot support for another game = adding an advisor here.
 */
const ADVISORS = {
    holdem: {
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
        }
    }
};

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
    // A pair on the board alone shouldn't excite us - require our hole
    // cards to participate for "strong"
    if (category >= 2) return 2;
    if (category === 1) return 1;
    return 0;
}

/**
 * Goobster as a table-game player. This is a side-effect service (never
 * part of an engine): it subscribes to tables like any other client,
 * watches personalized views, asks the AI (with a heuristic fallback) what
 * to do on its turns, acts through the TableManager, and delivers table
 * talk to the Activity clients, the Discord channel, and - when a voice
 * session is live - the voice channel.
 */
class BotPlayer {
    constructor({
        tableManager,
        client = null,
        config = {},
        logger = console,
        aiService = aiServiceSingleton,
        economy = economyService,
        voiceSessions = null, // lazy-required by default (heavy deps)
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
        this.rng = rng;
        this.actDelayMs = actDelayMs;
        this.commentCooldownMs = commentCooldownMs;

        const botConfig = config.activity?.bot || {};
        this.enabled = botConfig.enabled !== false;
        this.textComments = botConfig.textComments === true;
        this.voiceComments = botConfig.voiceComments === true;

        this.tables = new Map(); // table.key -> { table, unsubscribe, thinking, lastCommentAt, timer }
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

        const record = { table, unsubscribe: () => {}, thinking: false, lastCommentAt: 0, timer: null };
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

        // The last human stood up: no point playing against ourselves.
        const humansSeated = view.seats.some(s => s && !s.isBot);
        if (!humansSeated && view.phase !== 'acting') {
            // Defer: we're inside subscriber iteration; leaving triggers a
            // broadcast that mutates the subscriber set.
            setTimeout(() => this.dismiss(record.table), 0).unref?.();
            return;
        }

        if (this._isMyTurn(view)) {
            this._scheduleAction(record);
        }

        for (const event of message.events || []) {
            if (event.type === 'settled') this._maybeCommentOnOutcome(record);
        }
    }

    _isMyTurn(view) {
        return view.phase === 'acting'
            && view.yourSeat !== null
            && view.activeSeat === view.yourSeat;
    }

    _scheduleAction(record) {
        if (record.thinking) return;
        record.thinking = true;
        record.timer = setTimeout(() => {
            record.timer = null;
            this._actNow(record)
                .catch(error => this.logger.error?.('[BotPlayer] Turn handling failed:', error))
                .finally(() => { record.thinking = false; });
        }, this.actDelayMs);
        record.timer.unref?.();
    }

    async _actNow(record) {
        const { table } = record;
        if (!this.tables.has(table.key)) return;
        const view = table.engine.getView(table.state, this.userId);
        if (!this._isMyTurn(view)) return; // stale (someone re-raised, hand ended...)

        const decision = await this._decide(record, view);

        try {
            this.tableManager.act({
                table,
                userId: this.userId,
                name: BOT_NAME,
                action: decision.action === 'raise' ? 'bet' : decision.action,
                amount: decision.amount
            });
        } catch (error) {
            // Wallet or rule rejection (e.g. can't cover the raise): retreat
            // to the safest legal action.
            const retreat = view.toCall > 0 ? 'fold' : 'check';
            this.logger.warn?.(`[BotPlayer] ${decision.action} rejected (${error.message}); ${retreat}ing instead`);
            try {
                this.tableManager.act({ table, userId: this.userId, name: BOT_NAME, action: retreat });
            } catch (retryError) {
                this.logger.error?.('[BotPlayer] Retreat action failed too:', retryError.message);
            }
            return;
        }

        if (decision.comment) this._say(record, decision.comment);
    }

    async _decide(record, view) {
        const advisor = ADVISORS[view.gameType];
        try {
            const context = advisor.buildDecisionContext(view, {
                balance: this.economy.getBalance(record.table.guildId, this.userId),
                currencyName: this.economy.getSettings(record.table.guildId).currencyName
            });
            const response = await this.aiService.chatText(context.messages, {
                temperature: 0.7,
                max_tokens: 150,
                usageContext: { guildId: record.table.guildId, userId: this.userId }
            });
            const jsonMatch = String(response || '').match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('no JSON in model response');
            const parsed = JSON.parse(jsonMatch[0]);
            const decision = advisor.legalize(parsed, view);
            decision.comment = this._cleanComment(parsed.comment);
            return decision;
        } catch (error) {
            this.logger.warn?.(`[BotPlayer] AI decision unavailable (${error.message}); using heuristic`);
            return advisor.legalize(advisor.fallback(view, this.rng), view);
        }
    }

    // ------------------------------------------------------------------
    // Table talk
    // ------------------------------------------------------------------

    _cleanComment(comment) {
        if (typeof comment !== 'string') return null;
        const trimmed = comment.trim().slice(0, 160);
        return trimmed.length > 0 ? trimmed : null;
    }

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

        let line;
        try {
            const response = await this.aiService.generateText(
                `You are Goobster, a quirky Discord bot playing ${view.gameType} with server members. ` +
                `You just ${mine.outcome === 'win' ? `won the ${view.results.pot} pot` : 'lost the hand'}` +
                `${mine.handName ? ` with ${mine.handName}` : ''}. ` +
                'Reply with ONLY one short, playful table-talk line (max 100 chars). No quotes.',
                { temperature: 0.9, max_tokens: 60, usageContext: { guildId: record.table.guildId, userId: this.userId } }
            );
            line = this._cleanComment(response);
        } catch {
            line = this._canned(mine.outcome === 'win' ? 'win' : 'lose');
        }
        if (line) this._say(record, line);
    }

    /**
     * Deliver a table-talk line: always to the Activity clients (chat
     * message), optionally to the Discord channel and the live voice
     * session, per config.
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

    /** Speak through an already-running voice session, if any. */
    _speak(guildId, text) {
        try {
            const voiceSessions = this._voiceSessions
                || (this._voiceSessions = require('../voice/voiceSessionService'));
            const session = voiceSessions.getSession?.(guildId);
            if (!session?.ttsService?.textToSpeech) return;
            Promise.resolve(
                session.ttsService.textToSpeech(text, session.voiceChannel, session.connection)
            ).catch(error => this.logger.warn?.('[BotPlayer] Voice comment failed:', error.message));
        } catch (error) {
            this.logger.warn?.('[BotPlayer] Voice comment unavailable:', error.message);
        }
    }
}

module.exports = { BotPlayer, ADVISORS, holdemStrength, BOT_NAME };
