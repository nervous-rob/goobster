/**
 * Web chat: runs browser chat turns through the SAME pipeline as Discord
 * chat (utils/chatHandler.handleChatInteraction) by building a web-shaped
 * pseudo-interaction - the createPseudoInteraction pattern from
 * events/messageCreate.js, extended with the web capabilities the handler
 * understands (onStreamDelta for raw token streaming, sendFullResponse for
 * unchunked delivery, maxInputLength for long pastes, shouldAbort for the
 * Stop button, imageUrls for vision attachments).
 *
 * Conversation model (the ChatGPT-style sidebar): each web conversation is
 * a web_conversations row naming a synthetic channel "web:<userId>:<key>".
 * All rows share the user's DM scope ("dm:<userId>"), so long-term memory,
 * facts, nicknames, and personality settings are shared with Discord DMs,
 * while each conversation keeps its own message window - rebuilt from
 * SQLite instead of the Discord API, so history survives restarts.
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
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024; // ~6MB of binary per image
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_TITLE_LENGTH = 80;
const HISTORY_PAGE_LIMIT = 200;
const CONVERSATION_LIST_LIMIT = 100;
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
        /** @type {Map<string, { aborted: boolean, abort: () => void }>} in-flight turn per user */
        this._activeTurns = new Map();
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

    get maxInputLength() {
        return MAX_INPUT_LENGTH;
    }

    // --- Conversations ------------------------------------------------------

    /** Synthetic channel id for one web conversation. */
    _channelId(userId, key) {
        return `${WEB_CHANNEL_PREFIX}${userId}:${key}`;
    }

    /**
     * Adopt a pre-conversations-era web chat ("web:<userId>" channel) into
     * the sidebar list, once, so nothing a user already said disappears.
     */
    _adoptLegacyConversation(userId) {
        const legacyChannel = `${WEB_CHANNEL_PREFIX}${userId}`;
        const hasRow = db.get(
            'SELECT 1 AS ok FROM web_conversations WHERE channelId = @legacyChannel',
            { legacyChannel }
        );
        if (hasRow) return;
        const legacyConv = db.get(
            `SELECT id FROM guild_conversations
             WHERE guildId = @scope AND channelId = @legacyChannel`,
            { scope: dmScopeId(userId), legacyChannel }
        );
        if (!legacyConv) return;
        db.run(
            `INSERT INTO web_conversations (userId, channelId, title, lastMessageAt)
             VALUES (@userId, @legacyChannel, 'Earlier conversation', datetime('now'))`,
            { userId, legacyChannel }
        );
    }

    /**
     * The user's conversations, most recently active first.
     * @param {string} userId
     * @returns {Array<{id:number, title:string|null, createdAt:string, lastMessageAt:string|null, messageCount:number}>}
     */
    listConversations(userId) {
        this._adoptLegacyConversation(userId);
        return db.all(
            `SELECT wc.id, wc.title, wc.createdAt, wc.lastMessageAt,
                    (SELECT COUNT(*) FROM messages m
                     JOIN guild_conversations gc ON gc.id = m.guildConversationId
                     WHERE gc.guildId = @scope AND gc.channelId = wc.channelId) AS messageCount
             FROM web_conversations wc
             WHERE wc.userId = @userId
             ORDER BY COALESCE(wc.lastMessageAt, wc.createdAt) DESC, wc.id DESC
             LIMIT @limit`,
            { userId, scope: dmScopeId(userId), limit: CONVERSATION_LIST_LIMIT }
        );
    }

    /**
     * Start a fresh conversation (untitled until the first exchange).
     * @param {string} userId
     * @returns {{id:number, title:null, createdAt:string, lastMessageAt:null}}
     */
    createConversation(userId) {
        const key = crypto.randomBytes(6).toString('hex');
        const row = db.get(
            `INSERT INTO web_conversations (userId, channelId)
             VALUES (@userId, @channelId)
             RETURNING id, title, createdAt, lastMessageAt`,
            { userId, channelId: this._channelId(userId, key) }
        );
        return { ...row, messageCount: 0 };
    }

    /**
     * Resolve a conversation the user owns (or their most recent one when
     * no id is given, creating one on first use).
     * @param {string} userId
     * @param {number|null} conversationId
     * @returns {{id:number, channelId:string, title:string|null}}
     */
    _requireConversation(userId, conversationId = null) {
        if (conversationId !== null && conversationId !== undefined) {
            const row = db.get(
                `SELECT id, channelId, title FROM web_conversations
                 WHERE id = @conversationId AND userId = @userId`,
                { conversationId: Number(conversationId), userId }
            );
            if (!row) {
                throw new WebChatError(404, 'NO_SUCH_CONVERSATION', 'No such conversation.');
            }
            return row;
        }
        this._adoptLegacyConversation(userId);
        const latest = db.get(
            `SELECT id, channelId, title FROM web_conversations
             WHERE userId = @userId
             ORDER BY COALESCE(lastMessageAt, createdAt) DESC, id DESC LIMIT 1`,
            { userId }
        );
        if (latest) return latest;
        const created = this.createConversation(userId);
        return db.get(
            'SELECT id, channelId, title FROM web_conversations WHERE id = @id',
            { id: created.id }
        );
    }

    /**
     * Rename a conversation.
     * @param {Object} params - { userId, conversationId, title }
     */
    renameConversation({ userId, conversationId, title }) {
        const clean = String(title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
        if (!clean) {
            throw new WebChatError(400, 'BAD_TITLE', 'Title cannot be empty.');
        }
        const conversation = this._requireConversation(userId, conversationId);
        db.run('UPDATE web_conversations SET title = @clean WHERE id = @id',
            { clean, id: conversation.id });
        return { id: conversation.id, title: clean };
    }

    /**
     * Delete a conversation and everything in it (messages, summaries, the
     * chat containers, and the sidebar row) in one transaction.
     * @param {Object} params - { userId, conversationId }
     */
    deleteConversation({ userId, conversationId }) {
        const conversation = this._requireConversation(userId, conversationId);
        const scope = dmScopeId(userId);
        return db.transaction(() => {
            const guildConv = db.get(
                `SELECT id FROM guild_conversations
                 WHERE guildId = @scope AND channelId = @channelId`,
                { scope, channelId: conversation.channelId }
            );
            let deletedMessages = 0;
            if (guildConv) {
                deletedMessages = db.run(
                    'DELETE FROM messages WHERE guildConversationId = @id', { id: guildConv.id }
                ).changes;
                db.run('DELETE FROM conversation_summaries WHERE guildConversationId = @id', { id: guildConv.id });
                db.run('DELETE FROM conversations WHERE guildConversationId = @id', { id: guildConv.id });
                db.run('DELETE FROM guild_conversations WHERE id = @id', { id: guildConv.id });
            }
            db.run('DELETE FROM web_conversations WHERE id = @id', { id: conversation.id });
            return { deleted: true, deletedMessages };
        });
    }

    /**
     * The guild_conversations row backing one web conversation, if any.
     * @param {string} channelId
     * @param {string} userId
     * @returns {number|null}
     */
    _guildConvIdFor(userId, channelId) {
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
     * Chat history for the web UI, oldest first. Bot messages that carry
     * generated files (metadata.attachments, written by the chat pipeline)
     * come back with servable URLs, so images survive history reloads.
     * @param {Object} params - { userId, conversationId, limit, beforeId }
     * @returns {Array<{id:number, role:string, content:string, createdAt:string, attachments?:Array}>}
     */
    getHistory({ userId, conversationId = null, limit = 50, beforeId = null }) {
        const conversation = this._requireConversation(userId, conversationId);
        const guildConvId = this._guildConvIdFor(userId, conversation.channelId);
        if (!guildConvId) return [];

        const bounded = Math.max(1, Math.min(Number(limit) || 50, HISTORY_PAGE_LIMIT));
        const params = { guildConvId, limit: bounded };
        if (beforeId) params.beforeId = Number(beforeId);
        const rows = db.all(
            `SELECT id, message, isBot, createdAt, metadata FROM messages
             WHERE guildConversationId = @guildConvId
               ${beforeId ? 'AND id < @beforeId' : ''}
             ORDER BY id DESC LIMIT @limit`,
            params
        );
        return rows.reverse().map(row => {
            const entry = {
                id: row.id,
                role: row.isBot ? 'assistant' : 'user',
                content: row.message,
                createdAt: row.createdAt
            };
            const attachments = this._attachmentsFromMetadata(row.metadata, userId);
            if (attachments.length > 0) entry.attachments = attachments;
            return entry;
        });
    }

    /**
     * Rebuild servable attachments from a stored message's metadata,
     * re-registering each file that still exists on disk.
     * @param {string|null} metadata - JSON string from the messages row
     * @param {string} userId - owner of the resulting file URLs
     * @returns {Array<{url: string, name: string}>}
     */
    _attachmentsFromMetadata(metadata, userId) {
        if (!metadata) return [];
        let parsed;
        try {
            parsed = JSON.parse(metadata);
        } catch {
            return [];
        }
        const attachments = [];
        for (const file of Array.isArray(parsed?.attachments) ? parsed.attachments : []) {
            if (typeof file?.path !== 'string') continue;
            const registered = this._registerFile(file.path, userId);
            if (registered) attachments.push(registered);
        }
        return attachments;
    }

    /**
     * Delete a message and everything after it in one conversation - the
     * primitive behind "edit & resend" and "regenerate" (truncate history,
     * then send a fresh turn; the context window rebuilds from SQLite).
     * @param {Object} params - { userId, conversationId, messageId }
     */
    truncateFrom({ userId, conversationId, messageId }) {
        const conversation = this._requireConversation(userId, conversationId);
        if (this._activeTurns.has(userId)) {
            throw new WebChatError(409, 'TURN_IN_FLIGHT',
                'Wait for the current reply to finish before editing history.');
        }
        const guildConvId = this._guildConvIdFor(userId, conversation.channelId);
        if (!guildConvId) {
            throw new WebChatError(404, 'NOT_FOUND', 'No such message.');
        }
        const result = db.run(
            `DELETE FROM messages
             WHERE guildConversationId = @guildConvId AND id >= @messageId`,
            { guildConvId, messageId: Number(messageId) }
        );
        if (result.changes === 0) {
            throw new WebChatError(404, 'NOT_FOUND', 'No such message.');
        }
        return { deleted: result.changes };
    }

    // --- AI settings (Thoughtful Mode, mirrors /thoughtfulmode in DMs) -------

    /**
     * The user's web/DM-scope AI settings.
     * @param {string} userId
     */
    async getAiSettings(userId) {
        const aiService = require('./aiService');
        const { getGuildAI } = require('../utils/guildSettings');
        const scope = dmScopeId(userId);
        const current = await getGuildAI(scope);
        const preset = aiService.getThoughtfulPreset(current.provider || undefined);
        const thoughtful = Boolean(preset)
            && current.model === preset.model
            && current.reasoningEffort === 'high';
        return {
            thoughtful,
            thoughtfulAvailable: Boolean(preset),
            model: current.model || aiService.getDefaultModel(),
            provider: current.provider || null
        };
    }

    /**
     * Toggle Thoughtful Mode for the user's web/DM scope (same storage the
     * /thoughtfulmode command uses, so Discord DMs follow along).
     * @param {Object} params - { userId, thoughtful }
     */
    async setThoughtful({ userId, thoughtful }) {
        const aiService = require('./aiService');
        const { getGuildAI, setGuildAI } = require('../utils/guildSettings');
        const scope = dmScopeId(userId);
        if (thoughtful) {
            const current = await getGuildAI(scope);
            const preset = aiService.getThoughtfulPreset(current.provider || undefined);
            if (!preset) {
                throw new WebChatError(400, 'NO_THOUGHTFUL_TIER',
                    'Thoughtful Mode needs a cloud AI provider (OpenAI, Anthropic, or Gemini).');
            }
            await setGuildAI(scope, preset);
        } else {
            await setGuildAI(scope, { provider: null, model: null, reasoningEffort: null });
        }
        return this.getAiSettings(userId);
    }

    // --- Generated file registry ---------------------------------------------

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
            // Prune expired entries opportunistically; reuse (and refresh)
            // an existing registration so repeated history loads don't grow
            // the registry and keep serving a stable URL per file.
            const now = Date.now();
            for (const [id, entry] of this._files) {
                if (now - entry.createdAt > FILE_TTL_MS) {
                    this._files.delete(id);
                    continue;
                }
                if (entry.path === resolved && entry.userId === userId) {
                    entry.createdAt = now;
                    return { url: `/api/app/files/${id}`, name: entry.name };
                }
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
     * Public wrapper around the file registry so other web surfaces (the
     * Parlor's tool-generated images) can serve local files through the
     * same owner-bound authenticated route (/api/app/files/:id).
     * @param {string} filePath
     * @param {string} userId - owner (only they may fetch it)
     * @returns {{ url: string, name: string }|null}
     */
    registerFile(filePath, userId) {
        return this._registerFile(filePath, userId);
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

    // --- Turns ---------------------------------------------------------------

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

    /** Validate vision attachments: bounded count/size, data URLs only. */
    _validateImages(images) {
        if (images === undefined || images === null) return [];
        if (!Array.isArray(images)) {
            throw new WebChatError(400, 'BAD_IMAGES', 'images must be an array of data URLs.');
        }
        if (images.length > MAX_IMAGES_PER_MESSAGE) {
            throw new WebChatError(400, 'BAD_IMAGES', `At most ${MAX_IMAGES_PER_MESSAGE} images per message.`);
        }
        for (const image of images) {
            if (typeof image !== 'string' || image.length > MAX_IMAGE_DATA_URL_CHARS
                || !IMAGE_DATA_URL_PATTERN.test(image)) {
                throw new WebChatError(400, 'BAD_IMAGES',
                    'Each image must be a png/jpeg/webp/gif data URL under ~6MB.');
            }
        }
        return images;
    }

    /**
     * Build the Collection-like result chatContext expects from
     * channel.messages.fetch(): newest-first, with a .size property, rows
     * mapped to Discord-message shape. Backed by SQLite, not the gateway.
     * @param {string} userId
     * @param {string} channelId
     * @param {string} botId
     * @param {number} limit
     */
    _fetchContextMessages(userId, channelId, botId, limit) {
        const guildConvId = this._guildConvIdFor(userId, channelId);
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
     * Fire-and-forget conversation titling (the ChatGPT pattern): a cheap
     * fallback title lands immediately; a short model-written title replaces
     * it when a provider is available. Never blocks or fails a turn.
     * @param {Object} params - { conversationId, userMessage }
     */
    _autoTitle({ conversationId, userMessage }) {
        const fallback = userMessage.replace(/\s+/g, ' ').trim().slice(0, 48)
            + (userMessage.length > 48 ? '…' : '');
        db.run(
            'UPDATE web_conversations SET title = @fallback WHERE id = @id AND title IS NULL',
            { fallback, id: conversationId }
        );

        (async () => {
            const aiService = require('./aiService');
            const title = await aiService.generateText(
                'Write a very short title (3-5 words, no quotes, no trailing punctuation) for a ' +
                `conversation that starts with this message:\n\n${userMessage.slice(0, 500)}`,
                { max_tokens: 16 }
            );
            const clean = String(title || '').replace(/["\n]/g, '').trim().slice(0, MAX_TITLE_LENGTH);
            if (clean) {
                db.run('UPDATE web_conversations SET title = @clean WHERE id = @id',
                    { clean, id: conversationId });
            }
        })().catch(() => { /* fallback title already in place */ });
    }

    /**
     * Request that the user's in-flight turn stop. The agent loop checks
     * the flag between rounds (the shouldAbort contract), so generation
     * halts at the next round boundary; partial text is kept.
     * @param {string} userId
     * @returns {boolean} whether a turn was active
     */
    stopTurn(userId) {
        const active = this._activeTurns.get(userId);
        if (!active) return false;
        active.abort();
        return true;
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
     * @param {number|null} [params.conversationId] - sidebar conversation
     * @param {string[]} [params.images] - vision attachments (data URLs)
     * @returns {{ run: (events?: Object) => Promise<void>, release: () => void, abort: () => void, conversationId: number }}
     */
    startTurn({ client, userId, userName, message, conversationId = null, images = null }) {
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
        const imageUrls = this._validateImages(images);
        if (this._activeTurns.has(userId)) {
            throw new WebChatError(409, 'TURN_IN_FLIGHT',
                'A reply is already being generated - wait for it to finish.');
        }
        const conversation = this._requireConversation(userId, conversationId);
        this._checkRateLimit(userId);

        const turnState = { aborted: false, abort: () => { turnState.aborted = true; } };
        this._activeTurns.set(userId, turnState);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this._activeTurns.delete(userId);
        };

        return {
            conversationId: conversation.id,
            abort: turnState.abort,
            release,
            run: async (events = {}) => {
                try {
                    db.run(
                        `UPDATE web_conversations SET lastMessageAt = datetime('now') WHERE id = @id`,
                        { id: conversation.id }
                    );
                    if (!conversation.title) {
                        this._autoTitle({ conversationId: conversation.id, userMessage: text });
                    }
                    const interaction = this._buildInteraction({
                        client, userId, userName, text,
                        channelId: conversation.channelId,
                        imageUrls, turnState, events
                    });
                    await handleChatInteraction(interaction);
                } finally {
                    release();
                }
            }
        };
    }

    /**
     * Run one web chat turn end to end (startTurn + run in one call).
     * @param {Object} params - { client, userId, userName, message, conversationId, images, events }
     */
    async runTurn({ client, userId, userName, message, conversationId = null, images = null, events = {} }) {
        const turn = this.startTurn({ client, userId, userName, message, conversationId, images });
        await turn.run(events);
    }

    /**
     * The web-shaped pseudo-interaction fed to handleChatInteraction.
     * @param {Object} params - { client, userId, userName, text, channelId, imageUrls, turnState, events }
     */
    _buildInteraction({ client, userId, userName, text, channelId, imageUrls, turnState, events }) {
        const service = this;

        const channel = {
            id: channelId,
            isThread: () => false,
            sendTyping: async () => {
                try { events.onTyping?.(); } catch { /* never break the turn */ }
            },
            messages: {
                fetch: async ({ limit = 20 } = {}) =>
                    service._fetchContextMessages(userId, channelId, client.user.id, limit)
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
            imageUrls,
            // Web capabilities the chat pipeline understands
            maxInputLength: MAX_INPUT_LENGTH,
            shouldAbort: () => turnState.aborted,
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
