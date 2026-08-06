/**
 * Web chat: runs browser chat turns through the SAME pipeline as Discord
 * chat (utils/chatHandler.handleChatInteraction) by building a web-shaped
 * pseudo-interaction - the createPseudoInteraction pattern from
 * events/messageCreate.js, extended with the web capabilities the handler
 * understands (onStreamDelta for raw token streaming, sendFullResponse for
 * unchunked delivery, maxInputLength for long pastes).
 *
 * Conversation scope: the user's DM scope ("dm:<userId>"), so web chat
 * shares long-term memory, facts, nicknames, and personality settings with
 * the user's Discord DMs. The active message window lives in its own
 * synthetic channel ("web:<userId>") - rebuilt from SQLite instead of the
 * Discord API, so history survives restarts and reloads.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('../db');
const { handleChatInteraction } = require('../utils/chatHandler');
const { dmScopeId } = require('../utils/dmScope');
const { createPlaceholderThreadId } = require('../utils/chat/chatDb');

const WEB_CHANNEL_PREFIX = 'web:';
// Custom interface, custom limits: web inputs are not bound by Discord's
// 2000-char message cap (long pastes of code/logs are a core web use case).
const MAX_INPUT_LENGTH = 20000;
const HISTORY_PAGE_LIMIT = 200;
const RATE_LIMIT_TURNS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const FILE_TTL_MS = 6 * 60 * 60 * 1000;

/** Machine-readable web app error (panelService's PanelError pattern). */
class WebChatError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebChatError';
        this.status = status;
        this.code = code;
    }
}

class WebChatService {
    constructor() {
        /** @type {Set<string>} users with a turn in flight */
        this._activeTurns = new Set();
        /** @type {Map<string, number[]>} userId -> recent turn timestamps */
        this._recentTurns = new Map();
        /**
         * Generated files surfaced to the browser (image tool output).
         * Transient and re-derivable (regenerate the image) - an allowed
         * in-memory exception to the SQLite rule.
         * @type {Map<string, { path: string, name: string, userId: string, createdAt: number }>}
         */
        this._files = new Map();
    }

    /** Synthetic channel id for a user's web conversation. */
    channelIdFor(userId) {
        return `${WEB_CHANNEL_PREFIX}${userId}`;
    }

    get maxInputLength() {
        return MAX_INPUT_LENGTH;
    }

    /**
     * The guild_conversations row backing a user's web chat, if it exists.
     * @param {string} userId
     * @returns {number|null}
     */
    _guildConvId(userId) {
        const channelId = this.channelIdFor(userId);
        const row = db.get(
            `SELECT id FROM guild_conversations
             WHERE guildId = @scope AND channelId = @channelId AND threadId = @threadId`,
            {
                scope: dmScopeId(userId),
                channelId,
                threadId: createPlaceholderThreadId(channelId)
            }
        );
        return row ? row.id : null;
    }

    /**
     * Chat history for the web UI, oldest first.
     * @param {Object} params
     * @param {string} params.userId
     * @param {number} [params.limit]
     * @param {number} [params.beforeId] - paginate: rows with id < beforeId
     * @returns {Array<{id:number, role:string, content:string, createdAt:string}>}
     */
    getHistory({ userId, limit = 50, beforeId = null }) {
        const guildConvId = this._guildConvId(userId);
        if (!guildConvId) return [];

        const bounded = Math.max(1, Math.min(Number(limit) || 50, HISTORY_PAGE_LIMIT));
        const params = { guildConvId, limit: bounded };
        if (beforeId) params.beforeId = Number(beforeId);
        const rows = db.all(
            `SELECT id, message, isBot, createdAt FROM messages
             WHERE guildConversationId = @guildConvId
               ${beforeId ? 'AND id < @beforeId' : ''}
             ORDER BY id DESC LIMIT @limit`,
            params
        );
        return rows.reverse().map(row => ({
            id: row.id,
            role: row.isBot ? 'assistant' : 'user',
            content: row.message,
            createdAt: row.createdAt
        }));
    }

    /**
     * Register a generated file so the browser can fetch it (authenticated
     * route in web/appApi.js). Returns the URL path.
     * @param {string} filePath - absolute or repo-relative local path
     * @param {string} userId - owner (only they may fetch it)
     * @returns {{ url: string, name: string }|null}
     */
    _registerFile(filePath, userId) {
        try {
            const resolved = path.resolve(String(filePath));
            if (!fs.existsSync(resolved)) return null;
            // Prune expired entries opportunistically
            const now = Date.now();
            for (const [id, entry] of this._files) {
                if (now - entry.createdAt > FILE_TTL_MS) this._files.delete(id);
            }
            const id = crypto.randomBytes(16).toString('hex');
            const name = path.basename(resolved);
            this._files.set(id, { path: resolved, name, userId, createdAt: now });
            return { url: `/api/app/files/${id}`, name };
        } catch {
            return null;
        }
    }

    /**
     * Look up a registered file for serving.
     * @param {string} fileId
     * @param {string} userId - requesting user (must be the owner)
     * @returns {{ path: string, name: string }|null}
     */
    getFile(fileId, userId) {
        const entry = this._files.get(String(fileId));
        if (!entry) return null;
        if (entry.userId !== userId) return null;
        if (Date.now() - entry.createdAt > FILE_TTL_MS) {
            this._files.delete(String(fileId));
            return null;
        }
        return { path: entry.path, name: entry.name };
    }

    /** Sliding-window rate limit; throws 429 when exceeded. */
    _checkRateLimit(userId) {
        const now = Date.now();
        const stamps = (this._recentTurns.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (stamps.length >= RATE_LIMIT_TURNS) {
            throw new WebChatError(429, 'RATE_LIMITED',
                `Slow down - at most ${RATE_LIMIT_TURNS} messages per minute.`);
        }
        stamps.push(now);
        this._recentTurns.set(userId, stamps);
    }

    /**
     * Build the Collection-like result chatContext expects from
     * channel.messages.fetch(): newest-first, with a .size property, rows
     * mapped to Discord-message shape. Backed by SQLite, not the gateway.
     * @param {string} userId
     * @param {string} botId
     * @param {number} limit
     */
    _fetchContextMessages(userId, botId, limit) {
        const guildConvId = this._guildConvId(userId);
        const result = [];
        if (guildConvId) {
            const rows = db.all(
                `SELECT m.id, m.message, m.isBot, u.discordId, u.username
                 FROM messages m JOIN users u ON u.id = m.createdBy
                 WHERE m.guildConversationId = @guildConvId
                 ORDER BY m.id DESC LIMIT @limit`,
                { guildConvId, limit: Math.max(1, Math.min(Number(limit) || 20, 100)) }
            );
            for (const row of rows) {
                result.push({
                    id: `db-${row.id}`,
                    content: row.message,
                    author: {
                        id: row.isBot ? botId : row.discordId,
                        username: row.isBot ? 'Goobster' : row.username
                    },
                    member: null,
                    reference: null
                });
            }
        }
        // chatContext reads .size (Discord Collections); arrays only have
        // .length, so mirror it. reverse() mutates in place and returns the
        // same object, keeping the property intact.
        result.size = result.length;
        return result;
    }

    /**
     * Validate and reserve a web chat turn. Validation errors throw
     * synchronously (before any SSE stream starts), so routes can still
     * answer with a proper HTTP status. The returned handle's run(events)
     * executes the turn; events fire as it progresses:
     *  - onTyping()                     the bot started working
     *  - onDelta(text)                  raw streamed token delta
     *  - onMessage({content, attachments, isError})  a completed bot message
     * @param {Object} params
     * @param {import('discord.js').Client} params.client
     * @param {string} params.userId - Discord user snowflake
     * @param {string} params.userName - display name for prompts/memory
     * @param {string} params.message - the user's message
     * @returns {{ run: (events?: Object) => Promise<void>, release: () => void }}
     */
    startTurn({ client, userId, userName, message }) {
        if (!client?.user) {
            throw new WebChatError(503, 'BOT_OFFLINE', 'Goobster is not connected to Discord yet.');
        }
        const text = String(message ?? '').trim();
        if (!text) {
            throw new WebChatError(400, 'EMPTY_MESSAGE', 'Message cannot be empty.');
        }
        if (text.length > MAX_INPUT_LENGTH) {
            throw new WebChatError(400, 'MESSAGE_TOO_LONG',
                `Message is too long (max ${MAX_INPUT_LENGTH} characters).`);
        }
        if (this._activeTurns.has(userId)) {
            throw new WebChatError(409, 'TURN_IN_FLIGHT',
                'A reply is already being generated - wait for it to finish.');
        }
        this._checkRateLimit(userId);

        this._activeTurns.add(userId);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this._activeTurns.delete(userId);
        };

        return {
            release,
            run: async (events = {}) => {
                try {
                    const interaction = this._buildInteraction({ client, userId, userName, text, events });
                    await handleChatInteraction(interaction);
                } finally {
                    release();
                }
            }
        };
    }

    /**
     * Run one web chat turn end to end (startTurn + run in one call).
     * @param {Object} params - { client, userId, userName, message, events }
     */
    async runTurn({ client, userId, userName, message, events = {} }) {
        const turn = this.startTurn({ client, userId, userName, message });
        await turn.run(events);
    }

    /**
     * The web-shaped pseudo-interaction fed to handleChatInteraction.
     * @param {Object} params - { client, userId, userName, text, events }
     */
    _buildInteraction({ client, userId, userName, text, events }) {
        const channelId = this.channelIdFor(userId);
        const service = this;

        const channel = {
            id: channelId,
            isThread: () => false,
            sendTyping: async () => {
                try { events.onTyping?.(); } catch { /* never break the turn */ }
            },
            messages: {
                fetch: async ({ limit = 20 } = {}) =>
                    service._fetchContextMessages(userId, client.user.id, limit)
            },
            send: async (payload) => {
                service._emitMessage(events, payload, userId);
                return { id: `web-msg-${Date.now()}` };
            }
        };

        const interaction = {
            id: `web-${userId}-${Date.now()}`,
            user: { id: userId, username: userName || `user_${userId}` },
            guild: null,
            guildId: null,
            member: null,
            client,
            content: text,
            channel,
            channelId,
            imageUrls: [],
            // Web capabilities the chat pipeline understands
            maxInputLength: MAX_INPUT_LENGTH,
            sourceDescription:
                `You are chatting with ${userName || 'the user'} through Goobster's private web chat interface ` +
                `(a browser app, not Discord). It is a one-on-one conversation that shares long-term memory with ` +
                `their Discord DMs. Markdown is fully supported and there is no message length limit - ` +
                `keep the conversation personal and conversational.`,
            onStreamDelta: (delta) => {
                try { events.onDelta?.(delta); } catch { /* never break the turn */ }
            },
            sendFullResponse: async (content, { isError = false } = {}) => {
                service._emitMessage(events, content, userId, isError);
            },
            deferReply: async () => {},
            editReply: async (response) => {
                service._emitMessage(events, response, userId);
            },
            reply: async (response) => {
                service._emitMessage(events, response, userId);
            },
            followUp: async (response) => {
                service._emitMessage(events, response, userId);
            },
            options: {
                getString: () => text
            }
        };

        return interaction;
    }

    /**
     * Normalize a Discord-style send/reply payload into a web message event.
     * @param {Object} events
     * @param {string|Object} payload
     * @param {string} userId
     * @param {boolean} [isError]
     */
    _emitMessage(events, payload, userId, isError = false) {
        let content = '';
        const attachments = [];

        if (typeof payload === 'string') {
            if (payload === '✅') return; // Discord-ism: silent ack, not a message
            content = payload;
        } else if (payload && typeof payload === 'object') {
            content = typeof payload.content === 'string' ? payload.content : '';
            if (payload.ephemeral && !content) return;
            for (const file of Array.isArray(payload.files) ? payload.files : []) {
                const filePath = typeof file === 'string' ? file : file?.attachment;
                if (typeof filePath !== 'string') continue;
                const registered = this._registerFile(filePath, userId);
                if (registered) attachments.push(registered);
            }
        }

        if (!content && attachments.length === 0) return;
        try {
            events.onMessage?.({ content, attachments, isError: Boolean(isError) });
        } catch { /* never break the turn */ }
    }
}

module.exports = new WebChatService();
module.exports.WebChatError = WebChatError;
