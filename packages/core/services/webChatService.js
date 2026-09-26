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
const { toGateway } = require('../gateway');
const { resolveAssistantUser } = require('./assistantIdentity');
const identityConfig = require('../config/identityConfig');
const { handleChatInteraction } = require('../utils/chatHandler');
const sandboxConfig = require('../config/sandboxConfig');
const { dmScopeId } = require('../utils/dmScope');
const { createPlaceholderThreadId, getOrCreateConversation } = require('../utils/chat/chatDb');
const eventBus = require('./eventBusService');
const {
    emptyProgress,
    cloneProgress,
    parseProgress,
    applyProgressEvent
} = require('../utils/webTurnProgress');

const WEB_CHANNEL_PREFIX = 'web:';
// Custom interface, custom limits: web inputs are not bound by Discord's
// 2000-char message cap (long pastes of code/logs are a core web use case).
const MAX_INPUT_LENGTH = 20000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024; // ~6MB of binary per image
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
// Text/document attachments (code, logs, notes) ride alongside images and
// are folded into the prompt as fenced blocks.
const MAX_TEXT_FILES_PER_MESSAGE = 4;
const MAX_TEXT_FILE_CHARS = 50000;
const MAX_TEXT_FILES_TOTAL_CHARS = 120000;
const MAX_FILE_NAME_LENGTH = 80;
// PDFs arrive as base64 and are converted to text server-side (pdf-parse),
// then ride the normal text-attachment path.
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_LENGTH = 80;
const HISTORY_PAGE_LIMIT = 200;
const CONVERSATION_LIST_LIMIT = 100;
const RATE_LIMIT_TURNS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Watchdog. A turn is wedged when it has shown no progress (no token, tool
// start/result, or typing) for TURN_IDLE_MAX_MS - e.g. a provider stream
// that stalled mid-flight and never resolved. It is force-aborted and its
// lock released, so one bad turn can never lock the user out of the portal
// until the next bot restart. Age alone is not the test: a project turn
// that is on its fifteenth tool call is working, not wedged, and killing
// it mid-sequence is exactly the "tools ran, then silence" failure.
// A single foreground sandbox run emits nothing between its start and
// result, so the idle window is never shorter than that run's time limit.
// TURN_MAX_AGE_MS is the absolute ceiling for a turn that keeps making
// progress; the agent loop is handed a deadline TURN_DEADLINE_MARGIN_MS
// before it so it hands off gracefully instead of being cut off.
const TURN_IDLE_MAX_MS = Math.max(
    15 * 60 * 1000,
    Number(sandboxConfig.timeoutMs || 0) + 60 * 1000
);
const TURN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TURN_DEADLINE_MARGIN_MS = 5 * 60 * 1000;
const FILE_TTL_MS = 6 * 60 * 60 * 1000;
// Incognito conversations are transient by definition: an in-memory window
// (an allowed exception to the SQLite rule) that is never persisted. The
// cap stays under chatContext's SUMMARY_TRIGGER so a summary can never be
// written for an incognito exchange.
const INCOGNITO_MAX_MESSAGES = 24;
const INCOGNITO_TTL_MS = 2 * 60 * 60 * 1000;
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];
// Read-only share links: bounded transcript, unguessable token
const SHARE_MESSAGE_LIMIT = 500;
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;
const MAX_QUEUE_LENGTH = 10;
const PROGRESS_PERSIST_MS = 250;

/** Machine-readable web app error (panelService's PanelError pattern). */
class WebChatError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'WebChatError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

/**
 * Attach the optional display hints (caption, source link, renderer kind)
 * a stored/sent file carries to its registered { url, name }. Only string
 * values are forwarded and bounded so metadata can never bloat an SSE event.
 */
function decorateAttachment(registered, hints = {}) {
    const out = { ...registered };
    // The registry names a file by its on-disk basename (artifact storage
    // prefixes a content hash); the sender's name is the one to show.
    if (typeof hints?.name === 'string' && hints.name.trim()) out.name = hints.name.trim().slice(0, 200);
    if (typeof hints?.caption === 'string' && hints.caption.trim()) out.caption = hints.caption.trim().slice(0, 400);
    if (typeof hints?.sourceUrl === 'string' && /^https?:\/\//i.test(hints.sourceUrl)) out.sourceUrl = hints.sourceUrl.slice(0, 2000);
    if (typeof hints?.kind === 'string' && /^[a-z]{1,16}$/.test(hints.kind)) out.kind = hints.kind;
    return out;
}

/** "4m 12s" / "37s" - for user-facing in-flight turn messages. */
function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

class WebChatService {
    constructor() {
        /** @type {Map<string, { aborted: boolean, startedAt: number, abort: () => void }>} in-flight turn per user */
        this._activeTurns = new Map();
        /**
         * Incognito context windows: userId -> transient message list.
         * Deliberately in-memory only (incognito = never persisted); a
         * restart wipes them, which is the correct behavior.
         * @type {Map<string, { messages: Array<{content: string, isBot: boolean}>, updatedAt: number }>}
         */
        this._incognito = new Map();
        /** Last startTurn runtime so a queued follow-up can run unattended. */
        this._runtimeByUser = new Map();
        /** In-memory follow-ups for incognito (never persisted). */
        this._incognitoQueue = new Map();
        this._kicking = new Set();
    }

    get maxInputLength() {
        return MAX_INPUT_LENGTH;
    }

    /**
     * Why a turn counts as wedged, or null while it is healthy: quiet for
     * TURN_IDLE_MAX_MS, or older than the absolute TURN_MAX_AGE_MS ceiling.
     * @param {{ startedAt: number, lastActivityAt?: number|null }} turn
     * @param {number} [now]
     * @returns {string|null}
     */
    _wedgedReason(turn, now = Date.now()) {
        const startedAt = Number(turn.startedAt) || now;
        if (now - startedAt > TURN_MAX_AGE_MS) {
            return `ran for over ${Math.round(TURN_MAX_AGE_MS / 60000)} minutes`;
        }
        const lastActivityAt = Number(turn.lastActivityAt) || startedAt;
        if (now - lastActivityAt > TURN_IDLE_MAX_MS) {
            return `showed no progress for ${Math.round(TURN_IDLE_MAX_MS / 60000)} minutes`;
        }
        return null;
    }

    /**
     * The user's in-flight turn, or null. Watchdog built in: a turn that
     * has gone quiet for TURN_IDLE_MAX_MS (or past the absolute age
     * ceiling) is treated as wedged - it gets aborted (cancelling its
     * in-flight provider request via the abort signal) and evicted, so a
     * stalled stream can never hold the per-user lock forever. A turn that
     * keeps producing tokens or tool events is left alone however long it
     * has been running.
     *
     * Local replica: `_activeTurns` holds the AbortController. Other
     * replicas read `web_live_turns` so a second api process 409s instead
     * of starting a parallel turn (Phase 5c).
     * @param {string} userId
     */
    async _liveTurn(userId) {
        const local = this._activeTurns.get(userId);
        if (local) {
            const wedged = this._wedgedReason(local);
            if (wedged) {
                console.warn(`[WebChat] Turn for user ${userId} ${wedged} - aborting it and releasing the lock`);
                try { local.abort('watchdog'); } catch { /* eviction must never throw */ }
                if (local.abortPoll) {
                    clearInterval(local.abortPoll);
                    local.abortPoll = null;
                }
                this._activeTurns.delete(userId);
                await db.run(
                    'DELETE FROM web_live_turns WHERE userId = @userId AND turnId = @turnId',
                    { userId, turnId: local.turnId }
                ).catch(() => {});
                eventBus.publish('web-turn', {
                    userId,
                    phase: 'settled',
                    turnId: local.turnId,
                    conversationId: local.conversationId ?? null,
                    invalidate: ['chat-turn', 'chat-queue', 'conversations']
                });
                void this._kickQueue(userId);
                return null;
            }
            return local;
        }
        const row = await db.get(
            `SELECT turnId, startedAtMs, conversationId, aborted, progressJson, lastActivityAtMs
             FROM web_live_turns WHERE userId = @userId`,
            { userId }
        );
        if (!row) return null;
        if (this._wedgedReason({ startedAt: Number(row.startedAtMs), lastActivityAt: row.lastActivityAtMs })) {
            await db.run('DELETE FROM web_live_turns WHERE userId = @userId', { userId }).catch(() => {});
            void this._kickQueue(userId);
            return null;
        }
        return {
            remote: true,
            turnId: row.turnId,
            startedAt: Number(row.startedAtMs),
            lastActivityAt: row.lastActivityAtMs != null ? Number(row.lastActivityAtMs) : null,
            conversationId: row.conversationId ?? null,
            aborted: Number(row.aborted) === 1,
            progress: parseProgress(row.progressJson),
            abort: () => {
                db.run(
                    'UPDATE web_live_turns SET aborted = 1 WHERE userId = @userId',
                    { userId }
                ).catch(() => {});
            }
        };
    }

    /**
     * The user's in-flight turn as client-facing status, so the browser can
     * show (and offer to stop) a reply that is still generating - e.g. after
     * a reload, from another conversation, or when the SSE stream died while
     * the server kept working.
     * @param {string} userId
     * @returns {{inFlight: boolean, elapsedMs?: number, conversationId?: number|null, turnId?: string, progress?: object}}
     */
    async turnStatus(userId, runtime = null) {
        if (runtime) this._rememberRuntime(userId, runtime);
        const turn = await this._liveTurn(userId);
        if (!turn) {
            void this._kickQueue(userId);
            return { inFlight: false };
        }
        return {
            inFlight: true,
            elapsedMs: Date.now() - turn.startedAt,
            conversationId: turn.conversationId ?? null,
            turnId: turn.turnId,
            progress: cloneProgress(turn.progress)
        };
    }

    /** The 409 every send/edit path throws while a turn holds the lock. */
    _turnInFlightError(userId, action = 'wait for it to finish or stop it', turn = null) {
        const live = turn || this._activeTurns.get(userId);
        const elapsedMs = live ? Date.now() - live.startedAt : 0;
        return new WebChatError(409, 'TURN_IN_FLIGHT',
            `A reply you asked for ${formatElapsed(elapsedMs)} ago is still being generated ` +
            `(long tool runs and slower models can take a while) - ${action}.`,
            { elapsedMs, conversationId: live?.conversationId ?? null });
    }

    _rememberRuntime(userId, runtime) {
        if (!runtime || !userId) return;
        const prev = this._runtimeByUser.get(userId) || {};
        this._runtimeByUser.set(userId, {
            client: runtime.client !== undefined ? runtime.client : prev.client,
            gateway: runtime.gateway !== undefined ? runtime.gateway : prev.gateway,
            userName: runtime.userName || prev.userName
        });
    }

    _emitTurnEvent(turnState, kind, payload) {
        if (!turnState) return;
        turnState.progress = applyProgressEvent(turnState.progress || emptyProgress(), kind, payload);
        // Every event is proof of life for the idle watchdog.
        turnState.lastActivityAt = Date.now();
        // Incognito progress stays in `_activeTurns` only — writing the
        // prompt/draft/tools into progressJson would persist the thing
        // incognito opted out of, even if the lock row is later deleted.
        // The activity timestamp carries no content, so it is written for
        // incognito too - other replicas judge wedged-ness from it.
        if (turnState.incognito) {
            this._schedulePersistProgress(turnState);
        } else if (kind === 'tool' || kind === 'message' || kind === 'typing') {
            this._persistProgress(turnState);
        } else {
            this._schedulePersistProgress(turnState);
        }
        for (const listener of turnState.listeners || []) {
            try {
                if (kind === 'typing') listener.onTyping?.();
                else if (kind === 'delta') listener.onDelta?.(payload);
                else if (kind === 'tool') listener.onTool?.(payload);
                else if (kind === 'message') listener.onMessage?.(payload);
            } catch { /* a subscriber must never break the turn */ }
        }
    }

    _schedulePersistProgress(turnState) {
        if (turnState.persistTimer) return;
        turnState.persistTimer = setTimeout(() => {
            turnState.persistTimer = null;
            this._persistProgress(turnState);
        }, PROGRESS_PERSIST_MS);
        turnState.persistTimer.unref?.();
    }

    _persistProgress(turnState) {
        if (!turnState?.turnId || !turnState.userId) return;
        const lastActivityAtMs = turnState.lastActivityAt || Date.now();
        if (turnState.incognito) {
            db.run(
                `UPDATE web_live_turns SET lastActivityAtMs = @lastActivityAtMs
                 WHERE userId = @userId AND turnId = @turnId`,
                { userId: turnState.userId, turnId: turnState.turnId, lastActivityAtMs }
            ).catch(() => {});
            return;
        }
        const json = JSON.stringify(turnState.progress || emptyProgress());
        db.run(
            `UPDATE web_live_turns SET progressJson = @progressJson, lastActivityAtMs = @lastActivityAtMs
             WHERE userId = @userId AND turnId = @turnId`,
            { userId: turnState.userId, turnId: turnState.turnId, progressJson: json, lastActivityAtMs }
        ).catch(() => {});
    }

    /**
     * Subscribe to a local in-flight turn so a returning browser can keep
     * watching thoughts/tools/tokens. Snapshot is the current progress.
     * When `expectedTurnId` is set and a different turn holds the lock,
     * do not subscribe — the caller asked for a specific turn.
     */
    attachToTurn(userId, listener, expectedTurnId = null) {
        const turn = this._activeTurns.get(userId);
        if (!turn || !listener) {
            return { snapshot: null, conversationId: null, turnId: null, unsubscribe: () => {} };
        }
        if (expectedTurnId && turn.turnId !== String(expectedTurnId)) {
            // Do not subscribe — the caller asked for a different turn.
            return {
                snapshot: null,
                conversationId: turn.conversationId ?? null,
                turnId: turn.turnId,
                unsubscribe: () => {}
            };
        }
        if (!turn.listeners) turn.listeners = new Set();
        turn.listeners.add(listener);
        return {
            snapshot: cloneProgress(turn.progress),
            conversationId: turn.conversationId ?? null,
            turnId: turn.turnId,
            unsubscribe: () => {
                turn.listeners.delete(listener);
            }
        };
    }

    /**
     * Last persisted snapshot for a turn this replica is not running
     * (another api process holds the AbortController). Used by the
     * reconnect SSE to poll progressJson until the row disappears.
     */
    async getPersistedTurn(userId) {
        const row = await db.get(
            `SELECT turnId, startedAtMs, conversationId, progressJson
             FROM web_live_turns WHERE userId = @userId`,
            { userId }
        );
        if (!row) return null;
        return {
            turnId: row.turnId,
            conversationId: row.conversationId ?? null,
            startedAt: Number(row.startedAtMs),
            progress: parseProgress(row.progressJson)
        };
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
    async _adoptLegacyConversation(userId) {
        const legacyChannel = `${WEB_CHANNEL_PREFIX}${userId}`;
        const hasRow = await db.get(
            'SELECT 1 AS ok FROM web_conversations WHERE channelId = @legacyChannel',
            { legacyChannel }
        );
        if (hasRow) return;
        const legacyConv = await db.get(
            `SELECT id FROM guild_conversations
             WHERE guildId = @scope AND channelId = @legacyChannel`,
            { scope: dmScopeId(userId), legacyChannel }
        );
        if (!legacyConv) return;
        await db.run(
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
    async listConversations(userId) {
        await this._adoptLegacyConversation(userId);
        await this.purgeExpiredConversations(userId);
        return await db.all(
            `SELECT wc.id, wc.title, wc.createdAt, wc.lastMessageAt,
                    wc.parentConversationId, wc.branchedFromMessageId,
                    (SELECT COUNT(*) FROM messages m
                     JOIN guild_conversations gc ON gc.id = m.guildConversationId
                     WHERE gc.guildId = @scope AND gc.channelId = wc.channelId) AS messageCount,
                    EXISTS (SELECT 1 FROM web_share_links s WHERE s.conversationId = wc.id) AS shared
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
    async createConversation(userId) {
        const key = crypto.randomBytes(6).toString('hex');
        const row = await db.get(
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
    async _requireConversation(userId, conversationId = null, allowExpired = false) {
        if (!allowExpired) await this.purgeExpiredConversations(userId);
        if (conversationId !== null && conversationId !== undefined) {
            const row = await db.get(
                `SELECT id, channelId, title FROM web_conversations
                 WHERE id = @conversationId AND userId = @userId`,
                { conversationId: Number(conversationId), userId }
            );
            if (!row) {
                throw new WebChatError(404, 'NO_SUCH_CONVERSATION', 'No such conversation.');
            }
            return row;
        }
        await this._adoptLegacyConversation(userId);
        const latest = await db.get(
            `SELECT id, channelId, title FROM web_conversations
             WHERE userId = @userId
             ORDER BY COALESCE(lastMessageAt, createdAt) DESC, id DESC LIMIT 1`,
            { userId }
        );
        if (latest) return latest;
        const created = await this.createConversation(userId);
        return await db.get(
            'SELECT id, channelId, title FROM web_conversations WHERE id = @id',
            { id: created.id }
        );
    }

    /**
     * Rename a conversation.
     * @param {Object} params - { userId, conversationId, title }
     */
    async renameConversation({ userId, conversationId, title }) {
        const clean = String(title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
        if (!clean) {
            throw new WebChatError(400, 'BAD_TITLE', 'Title cannot be empty.');
        }
        const conversation = await this._requireConversation(userId, conversationId);
        await db.run('UPDATE web_conversations SET title = @clean WHERE id = @id',
            { clean, id: conversation.id });
        return { id: conversation.id, title: clean };
    }

    /** Purge expired, inactive Study conversations for one owner. */
    async purgeExpiredConversations(userId) {
        const days = await require('./userSettingsService').getPreference(userId, 'chatHistoryRetentionDays');
        if (!days) return 0;
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        const rows = await db.all(
            `SELECT id FROM web_conversations WHERE userId = @userId
             AND COALESCE(lastMessageAt, createdAt) < @cutoff
             AND NOT EXISTS (SELECT 1 FROM web_live_turns t WHERE t.conversationId = web_conversations.id
                 AND t.lastActivityAtMs > @liveAfter)`,
            { userId, cutoff, liveAfter: Date.now() - TURN_MAX_AGE_MS }
        );
        let purged = 0;
        for (const row of rows) {
            try { await this.deleteConversation({ userId, conversationId: row.id }); purged++; }
            catch (error) { if (error.code !== 'NO_SUCH_CONVERSATION') throw error; }
        }
        return purged;
    }

    async _removeOrphanAttachments(userId, candidates) {
        if (!candidates.size) return;
        const remaining = await db.all('SELECT metadata FROM messages WHERE metadata IS NOT NULL');
        const referenced = new Set();
        for (const row of remaining) {
            try { for (const file of JSON.parse(row.metadata)?.attachments || []) {
                if (file.path) referenced.add(path.resolve(file.path));
            } } catch { /* legacy metadata */ }
        }
        const uploadDir = path.resolve(require('../utils/webUploads').userUploadDir(userId));
        for (const file of candidates) {
            const resolved = path.resolve(file);
            if (referenced.has(resolved)) continue;
            await db.run('DELETE FROM web_generated_files WHERE userId = @userId AND path = @path', { userId, path: resolved });
            // Saved artifacts/projects have their own lifecycles. Never unlink their bytes.
            if (path.dirname(resolved) === uploadDir) await fs.promises.rm(resolved, { force: true });
        }
    }

    /**
     * Delete a conversation and everything in it (messages, summaries, the
     * chat containers, and the sidebar row) in one transaction.
     * @param {Object} params - { userId, conversationId }
     */
    async deleteConversation({ userId, conversationId }) {
        const conversation = await this._requireConversation(userId, conversationId, true);
        const scope = dmScopeId(userId);
        const attachmentPaths = new Set();
        const result = await db.transaction(async () => {
            const guildConv = await db.get(
                `SELECT id FROM guild_conversations
                 WHERE guildId = @scope AND channelId = @channelId`,
                { scope, channelId: conversation.channelId }
            );
            let deletedMessages = 0;
            if (guildConv) {
                const metadataRows = await db.all('SELECT metadata FROM messages WHERE guildConversationId = @id', { id: guildConv.id });
                for (const row of metadataRows) {
                    try { for (const file of JSON.parse(row.metadata)?.attachments || []) {
                        if (typeof file.path === 'string') attachmentPaths.add(file.path);
                    } } catch { /* legacy metadata */ }
                }
                deletedMessages = (await db.run(
                    'DELETE FROM messages WHERE guildConversationId = @id', { id: guildConv.id }
                )).changes;
                await db.run('DELETE FROM conversation_summaries WHERE guildConversationId = @id', { id: guildConv.id });
                await db.run('DELETE FROM conversations WHERE guildConversationId = @id', { id: guildConv.id });
                await db.run('DELETE FROM guild_conversations WHERE id = @id', { id: guildConv.id });
            }
            await db.run('DELETE FROM web_chat_queue WHERE userId = @userId AND conversationId = @id',
                { userId, id: conversation.id });
            // A deleted conversation must stop being shareable immediately
            await db.run('DELETE FROM web_share_links WHERE conversationId = @id', { id: conversation.id });
            // Branch children survive but lose the dangling lineage pointer
            await db.run(
                'UPDATE web_conversations SET parentConversationId = NULL WHERE parentConversationId = @id',
                { id: conversation.id }
            );
            await db.run('DELETE FROM web_conversations WHERE id = @id', { id: conversation.id });
            return { deleted: true, deletedMessages };
        });
        await this._removeOrphanAttachments(userId, attachmentPaths);
        return result;
    }

    /**
     * The guild_conversations row backing one web conversation, if any.
     * @param {string} channelId
     * @param {string} userId
     * @returns {number|null}
     */
    async _guildConvIdFor(userId, channelId) {
        const row = await db.get(
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
    async getHistory({ userId, conversationId = null, limit = 50, beforeId = null }) {
        const conversation = await this._requireConversation(userId, conversationId);
        const guildConvId = await this._guildConvIdFor(userId, conversation.channelId);
        if (!guildConvId) return [];

        const bounded = Math.max(1, Math.min(Number(limit) || 50, HISTORY_PAGE_LIMIT));
        const params = { guildConvId, limit: bounded };
        if (beforeId) params.beforeId = Number(beforeId);
        const rows = await db.all(
            `SELECT id, message, isBot, createdAt, metadata FROM messages
             WHERE guildConversationId = @guildConvId
               ${beforeId ? 'AND id < @beforeId' : ''}
             ORDER BY id DESC LIMIT @limit`,
            params
        );
        const history = [];
        for (const row of rows.reverse()) {
            const entry = {
                id: row.id,
                role: row.isBot ? 'assistant' : 'user',
                content: row.message,
                createdAt: row.createdAt
            };
            const attachments = await this._attachmentsFromMetadata(row.metadata, userId);
            if (attachments.length > 0) entry.attachments = attachments;
            if (row.isBot) {
                const steps = this._stepsFromMetadata(row.metadata);
                if (steps.length > 0) entry.steps = steps;
            }
            history.push(entry);
        }
        return history;
    }

    /**
     * The persisted turn timeline for one bot message (metadata.steps,
     * written by the chat pipeline). Older rows predate the timeline but may
     * carry a toolTranscript - derive tool-only steps from it so their
     * "Thinking" trail isn't empty.
     * @param {string|null} metadata - JSON string from the messages row
     * @returns {Array<Object>}
     */
    _stepsFromMetadata(metadata) {
        if (!metadata) return [];
        let parsed;
        try {
            parsed = JSON.parse(metadata);
        } catch {
            return [];
        }
        if (Array.isArray(parsed?.steps) && parsed.steps.length > 0) {
            return parsed.steps;
        }
        if (Array.isArray(parsed?.toolTranscript) && parsed.toolTranscript.length > 0) {
            const preview = (text, cap) => {
                const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
                return clean.length > cap ? `${clean.slice(0, cap)}…` : clean;
            };
            return parsed.toolTranscript.map((tool, index) => ({
                type: 'tool',
                id: index,
                name: tool.name,
                argsPreview: preview(tool.arguments, 200),
                resultPreview: preview(tool.result, 500),
                isError: Boolean(tool.isError)
            }));
        }
        return [];
    }

    /**
     * Full-text search across every message in the user's web conversations
     * (the sidebar search box). LIKE over SQLite is plenty at self-hosted
     * scale and needs no index maintenance; results come back newest-first
     * with a snippet centered on the first match so the UI can highlight it.
     * @param {Object} params - { userId, query, limit }
     * @returns {Array<{conversationId:number, title:string|null, messageId:number, role:string, snippet:string, createdAt:string}>}
     */
    async searchMessages({ userId, query, limit = 20 }) {
        await this.purgeExpiredConversations(userId);
        const clean = String(query ?? '').trim();
        if (clean.length < 2) return [];
        const bounded = Math.max(1, Math.min(Number(limit) || 20, 50));
        // Escape LIKE wildcards so a literal "%" in the query stays literal
        const escaped = clean.replace(/[\\%_]/g, ch => `\\${ch}`);

        const rows = await db.all(
            `SELECT m.id AS messageId, m.message, m.isBot, m.createdAt,
                    wc.id AS conversationId, wc.title
             FROM messages m
             JOIN guild_conversations gc ON gc.id = m.guildConversationId
             JOIN web_conversations wc ON wc.channelId = gc.channelId AND wc.userId = @userId
             WHERE gc.guildId = @scope AND m.message LIKE @pattern ESCAPE '\\'
             ORDER BY m.id DESC LIMIT @limit`,
            {
                userId,
                scope: dmScopeId(userId),
                pattern: `%${escaped}%`,
                limit: bounded
            }
        );

        return rows.map(row => {
            const index = row.message.toLowerCase().indexOf(clean.toLowerCase());
            const start = Math.max(0, index - 40);
            const end = Math.min(row.message.length, index + clean.length + 60);
            const snippet = `${start > 0 ? '…' : ''}${row.message.slice(start, end)}${end < row.message.length ? '…' : ''}`;
            return {
                conversationId: row.conversationId,
                title: row.title || null,
                messageId: row.messageId,
                role: row.isBot ? 'assistant' : 'user',
                snippet,
                createdAt: row.createdAt
            };
        });
    }

    /**
     * Rebuild servable attachments from a stored message's metadata,
     * re-registering each file that still exists on disk.
     * @param {string|null} metadata - JSON string from the messages row
     * @param {string} userId - owner of the resulting file URLs
     * @returns {Array<{url: string, name: string}>}
     */
    async _attachmentsFromMetadata(metadata, userId) {
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
            const registered = await this._registerFile(file.path, userId);
            if (registered) attachments.push(decorateAttachment(registered, file));
        }
        return attachments;
    }

    /**
     * Delete a message and everything after it in one conversation - the
     * primitive behind "edit & resend" and "regenerate" (truncate history,
     * then send a fresh turn; the context window rebuilds from SQLite).
     * @param {Object} params - { userId, conversationId, messageId }
     */
    async truncateFrom({ userId, conversationId, messageId }) {
        const conversation = await this._requireConversation(userId, conversationId);
        const editing = await this._liveTurn(userId);
        if (editing) {
            throw this._turnInFlightError(userId, 'wait for it to finish (or stop it) before editing history', editing);
        }
        const guildConvId = await this._guildConvIdFor(userId, conversation.channelId);
        if (!guildConvId) {
            throw new WebChatError(404, 'NOT_FOUND', 'No such message.');
        }
        const result = await db.run(
            `DELETE FROM messages
             WHERE guildConversationId = @guildConvId AND id >= @messageId`,
            { guildConvId, messageId: Number(messageId) }
        );
        if (result.changes === 0) {
            throw new WebChatError(404, 'NOT_FOUND', 'No such message.');
        }
        return { deleted: result.changes };
    }

    /**
     * Fork a conversation at a message: everything BEFORE that message is
     * copied into a fresh conversation (lineage recorded on the new row),
     * and the original stays untouched - editing an earlier message no
     * longer has to destroy the old branch. The client then sends the
     * edited text as the branch's next turn, so the chat pipeline itself
     * never learns about branching (the copied rows ARE the context).
     * @param {Object} params - { userId, conversationId, messageId }
     * @returns {{id:number, title:string|null, parentConversationId:number, branchedFromMessageId:number, messageCount:number}}
     */
    async branchFrom({ userId, conversationId, messageId }) {
        const conversation = await this._requireConversation(userId, conversationId);
        const branching = await this._liveTurn(userId);
        if (branching) {
            throw this._turnInFlightError(userId, 'wait for it to finish (or stop it) before branching', branching);
        }
        const guildConvId = await this._guildConvIdFor(userId, conversation.channelId);
        const branchPoint = guildConvId
            ? await db.get(
                'SELECT id FROM messages WHERE guildConversationId = @guildConvId AND id = @messageId',
                { guildConvId, messageId: Number(messageId) }
            )
            : null;
        if (!branchPoint) {
            throw new WebChatError(404, 'NOT_FOUND', 'No such message.');
        }

        const scope = dmScopeId(userId);
        return await db.transaction(async () => {
            const key = crypto.randomBytes(6).toString('hex');
            const channelId = this._channelId(userId, key);
            const title = conversation.title
                ? `${conversation.title}`.slice(0, MAX_TITLE_LENGTH - 9) + ' (branch)'
                : null;
            const newConv = await db.get(
                `INSERT INTO web_conversations
                     (userId, channelId, title, lastMessageAt, parentConversationId, branchedFromMessageId)
                 VALUES (@userId, @channelId, @title, datetime('now'), @parentId, @messageId)
                 RETURNING id, title, createdAt, lastMessageAt, parentConversationId, branchedFromMessageId`,
                { userId, channelId, title, parentId: conversation.id, messageId: Number(messageId) }
            );

            // The backing chat container mirrors the source's prompt link
            const sourceGuildConv = await db.get(
                'SELECT promptId FROM guild_conversations WHERE id = @id', { id: guildConvId }
            );
            const newGuildConvId = Number(await db.insert(
                `INSERT INTO guild_conversations (guildId, channelId, threadId, promptId)
                 VALUES (@scope, @channelId, @threadId, @promptId)`,
                {
                    scope, channelId,
                    threadId: createPlaceholderThreadId(channelId),
                    promptId: sourceGuildConv?.promptId ?? null
                }
            ));

            // Copy the shared history (everything before the branch point),
            // preserving authorship and timestamps so the rebuilt context
            // window reads identically in both branches.
            const rows = await db.all(
                `SELECT conversationId, createdBy, message, isBot, metadata, createdAt
                 FROM messages
                 WHERE guildConversationId = @guildConvId AND id < @messageId
                 ORDER BY id ASC`,
                { guildConvId, messageId: Number(messageId) }
            );
            const conversationIdByCreator = new Map();
            for (const row of rows) {
                if (!conversationIdByCreator.has(row.createdBy)) {
                    conversationIdByCreator.set(
                        row.createdBy,
                        await getOrCreateConversation(row.createdBy, newGuildConvId)
                    );
                }
                await db.run(
                    `INSERT INTO messages
                         (conversationId, guildConversationId, createdBy, message, isBot, metadata, createdAt)
                     VALUES (@conversationId, @guildConvId, @createdBy, @message, @isBot, @metadata, @createdAt)`,
                    {
                        conversationId: conversationIdByCreator.get(row.createdBy),
                        guildConvId: newGuildConvId,
                        createdBy: row.createdBy,
                        message: row.message,
                        isBot: row.isBot,
                        metadata: row.metadata,
                        createdAt: row.createdAt
                    }
                );
            }

            return { ...newConv, messageCount: rows.length, shared: 0 };
        });
    }

    // --- Read-only share links ------------------------------------------------

    /**
     * Create (or return the existing) read-only share link for a
     * conversation. One active link per conversation; the token grants
     * read access to that conversation's text and nothing else.
     * @param {Object} params - { userId, conversationId }
     * @returns {{ token: string, url: string, createdAt: string }}
     */
    async createShareLink({ userId, conversationId }) {
        const conversation = await this._requireConversation(userId, conversationId);
        const existing = await db.get(
            'SELECT token, createdAt FROM web_share_links WHERE conversationId = @id',
            { id: conversation.id }
        );
        if (existing) {
            return { token: existing.token, url: `/app/share/${existing.token}`, createdAt: existing.createdAt };
        }
        const token = crypto.randomBytes(20).toString('hex');
        const row = await db.get(
            `INSERT INTO web_share_links (userId, conversationId, token)
             VALUES (@userId, @conversationId, @token)
             RETURNING token, createdAt`,
            { userId, conversationId: conversation.id, token }
        );
        return { token: row.token, url: `/app/share/${row.token}`, createdAt: row.createdAt };
    }

    /**
     * The share state of one conversation (for the share dialog).
     * @param {Object} params - { userId, conversationId }
     * @returns {{ shared: boolean, url?: string, token?: string, createdAt?: string }}
     */
    async getShareLink({ userId, conversationId }) {
        const conversation = await this._requireConversation(userId, conversationId);
        const row = await db.get(
            'SELECT token, createdAt FROM web_share_links WHERE conversationId = @id',
            { id: conversation.id }
        );
        if (!row) return { shared: false };
        return { shared: true, token: row.token, url: `/app/share/${row.token}`, createdAt: row.createdAt };
    }

    /**
     * Revoke a conversation's share link. The URL stops working instantly.
     * @param {Object} params - { userId, conversationId }
     * @returns {{ revoked: boolean }}
     */
    async revokeShareLink({ userId, conversationId }) {
        const conversation = await this._requireConversation(userId, conversationId);
        const result = await db.run(
            'DELETE FROM web_share_links WHERE conversationId = @id AND userId = @userId',
            { id: conversation.id, userId }
        );
        return { revoked: result.changes > 0 };
    }

    /**
     * Resolve a public share token into a read-only transcript. No auth -
     * the unguessable token is the capability. Strictly scoped: the query
     * starts at the token, so no other conversation is reachable, and the
     * payload never includes the owner's id or attachment URLs (files stay
     * behind the owner-bound authenticated route).
     * @param {string} token
     * @returns {{ title: string, sharedAt: string, messages: Array<{role:string, content:string, createdAt:string}> }}
     */
    async getSharedConversation(token) {
        const clean = String(token || '').trim().toLowerCase();
        if (!SHARE_TOKEN_PATTERN.test(clean)) {
            throw new WebChatError(404, 'NOT_FOUND', 'This share link does not exist (or was revoked).');
        }
        let link = await db.get(
            `SELECT s.createdAt AS sharedAt, wc.title, wc.channelId, wc.userId
             FROM web_share_links s
             JOIN web_conversations wc ON wc.id = s.conversationId
             WHERE s.token = @token`,
            { token: clean }
        );
        if (!link) {
            throw new WebChatError(404, 'NOT_FOUND', 'This share link does not exist (or was revoked).');
        }
        await this.purgeExpiredConversations(link.userId);
        link = await db.get(
            `SELECT s.createdAt AS sharedAt, wc.title, wc.channelId, wc.userId
             FROM web_share_links s JOIN web_conversations wc ON wc.id = s.conversationId
             WHERE s.token = @token`, { token: clean }
        );
        if (!link) throw new WebChatError(404, 'NOT_FOUND', 'This share link has expired.');
        const guildConvId = await this._guildConvIdFor(link.userId, link.channelId);
        const rows = guildConvId
            ? await db.all(
                `SELECT message, isBot, createdAt FROM messages
                 WHERE guildConversationId = @guildConvId
                 ORDER BY id ASC LIMIT @limit`,
                { guildConvId, limit: SHARE_MESSAGE_LIMIT }
            )
            : [];
        return {
            title: link.title || 'Shared conversation',
            sharedAt: link.sharedAt,
            messages: rows.map(row => ({
                role: row.isBot ? 'assistant' : 'user',
                content: row.message,
                createdAt: row.createdAt
            }))
        };
    }

    // --- AI settings (provider / model / reasoning, mirrors /aisettings) -----

    /**
     * The user's web/DM-scope AI settings, plus the provider catalog the
     * settings UI renders. Raw override fields are null when the global
     * default applies; `effective` resolves what a turn would actually use.
     * @param {string} userId
     */
    async getAiSettings(userId) {
        const aiService = require('./aiService');
        const { getGuildAI } = require('../utils/guildSettings');
        const scope = dmScopeId(userId);
        const current = await getGuildAI(scope);
        const providers = aiService.listProviders();

        const preset = aiService.getThoughtfulPreset(current.provider || undefined);
        const thoughtful = Boolean(preset)
            && current.model === preset.model
            && current.reasoningEffort === 'high';

        const effectiveProviderKey = current.provider || aiService.getProvider();
        const effectiveProvider = providers.find(p => p.key === effectiveProviderKey) || null;
        const { getUserInstructions, MAX_INSTRUCTIONS_LENGTH } = require('../utils/userInstructions');
        return {
            provider: current.provider || null,
            model: current.model || null,
            reasoningEffort: current.reasoningEffort || null,
            thoughtful,
            thoughtfulAvailable: Boolean(preset),
            customInstructions: await getUserInstructions(userId),
            customInstructionsMaxLength: MAX_INSTRUCTIONS_LENGTH,
            effective: {
                provider: effectiveProviderKey,
                providerName: effectiveProvider?.name || effectiveProviderKey,
                model: current.model || effectiveProvider?.chatModel || aiService.getDefaultModel(),
                reasoningEffort: current.reasoningEffort || null
            },
            providers
        };
    }

    /**
     * The chat models a provider's API key can actually use (live listing
     * from the provider, cached in aiService) - feeds the settings modal's
     * model dropdown. [] means "listing unavailable"; the client falls back
     * to the catalog defaults.
     * @param {string} [providerKey]
     * @returns {Promise<string[]>}
     */
    async listModels(providerKey) {
        const aiService = require('./aiService');
        return await aiService.listModels(providerKey || undefined);
    }

    async listModelCatalog(providerKey, workflow) {
        return require('./aiService').listModelCatalog(providerKey, workflow);
    }

    /**
     * Update the user's web/DM-scope AI overrides (same storage the
     * /aisettings command uses, so Discord DMs follow along). Only the
     * provided keys change; null/empty clears a key back to the default.
     * @param {Object} params - { userId, provider?, model?, reasoningEffort? }
     */
    async setAiSettings({ userId, provider, model, reasoningEffort, customInstructions }) {
        const userSettingsService = require('./userSettingsService');
        const hasInstructions = customInstructions !== undefined;
        const hasChat = provider !== undefined || model !== undefined || reasoningEffort !== undefined;

        if (!hasInstructions && !hasChat) {
            throw new WebChatError(400, 'NO_CHANGES',
                'Provide provider, model, reasoningEffort, or customInstructions to change.');
        }

        try {
            if (hasInstructions) {
                await userSettingsService.updateSection({
                    userId,
                    section: 'profile',
                    changes: { customInstructions }
                });
            }
            if (hasChat) {
                const changes = {};
                if (provider !== undefined) changes.provider = provider;
                if (model !== undefined) changes.model = model;
                if (reasoningEffort !== undefined) changes.reasoningEffort = reasoningEffort;
                await userSettingsService.updateSection({
                    userId,
                    section: 'chat',
                    changes
                });
            }
        } catch (error) {
            throw new WebChatError(error.status || 400, error.code || 'BAD_REQUEST', error.message);
        }
        return await this.getAiSettings(userId);
    }

    /**
     * Toggle Thoughtful Mode for the user's web/DM scope (same storage the
     * /thoughtfulmode command uses, so Discord DMs follow along).
     * @param {Object} params - { userId, thoughtful }
     */
    async setThoughtful({ userId, thoughtful }) {
        const userSettingsService = require('./userSettingsService');
        try {
            await userSettingsService.updateSection({
                userId,
                section: 'chat',
                changes: { thoughtful: Boolean(thoughtful) }
            });
        } catch (error) {
            throw new WebChatError(error.status || 400, error.code || 'BAD_REQUEST', error.message);
        }
        return await this.getAiSettings(userId);
    }

    // --- Generated file registry ---------------------------------------------

    /**
     * Register a generated file so the browser can fetch it (authenticated
     * route in web/appApi.js). Rows live in `web_generated_files` so an
     * api restart (or a second replica sharing the data volume) can still
     * authorize the download. Returns the URL path.
     * @param {string} filePath - absolute or repo-relative local path
     * @param {string} userId - owner (only they may fetch it)
     * @returns {Promise<{ url: string, name: string }|null>}
     */
    async _registerFile(filePath, userId, { pruneExpired = true } = {}) {
        try {
            const resolved = path.resolve(String(filePath));
            if (!fs.existsSync(resolved)) return null;
            // Prune expired rows opportunistically; reuse (and refresh)
            // an existing registration so repeated history loads don't grow
            // the registry and keep serving a stable URL per file.
            if (pruneExpired) {
                await db.run(
                    `DELETE FROM web_generated_files
                     WHERE createdAt < datetime('now', '-${FILE_TTL_MS / (60 * 60 * 1000)} hours')`
                );
            }
            const id = crypto.randomBytes(16).toString('hex');
            const name = path.basename(resolved);
            // Multiple inbox items (or tabs) may renew the same file at
            // once. Return the winning registration instead of losing a
            // link to a unique-key race.
            const registered = await db.get(
                `INSERT INTO web_generated_files (id, userId, path, name, createdAt)
                 VALUES (@id, @userId, @path, @name, CURRENT_TIMESTAMP)
                 ON CONFLICT(userId, path) DO UPDATE SET createdAt = CURRENT_TIMESTAMP
                 RETURNING id, name`,
                { id, userId, path: resolved, name }
            );
            return { url: `/api/app/files/${registered.id}`, name: registered.name };
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
     * @returns {Promise<{ url: string, name: string }|null>}
     */
    async registerFile(filePath, userId) {
        return this._registerFile(filePath, userId);
    }

    /**
     * Capture an owner-verified file reference for a durable server-side
     * record. Unlike a download, this may recover an expired registration
     * that has not yet been pruned. Never return the reference to a browser.
     */
    async getFileReference(url, userId) {
        const match = /^\/api\/app\/files\/([0-9a-f]{32})$/i.exec(String(url || ''));
        if (!match) return null;
        const row = await db.get(
            'SELECT userId, path FROM web_generated_files WHERE id = @id AND userId = @userId',
            { id: match[1], userId: String(userId) }
        );
        return row ? { userId: row.userId, path: row.path } : null;
    }

    /** Renew a download from a trusted stored reference for its original owner. */
    async restoreFileReference(reference, userId) {
        if (reference?.userId !== String(userId) || typeof reference.path !== 'string') return null;
        // Do not prune here: other legacy inbox attachments may still need
        // their expired registry entries to recover a durable reference.
        return this._registerFile(reference.path, userId, { pruneExpired: false });
    }

    /**
     * Look up a registered file for serving.
     * @param {string} fileId
     * @param {string} userId - requesting user (must be the owner)
     * @returns {Promise<{ path: string, name: string }|null>}
     */
    async getFile(fileId, userId) {
        await this.purgeExpiredConversations(userId);
        const id = String(fileId);
        if (!/^[0-9a-f]{32}$/i.test(id)) return null;
        const entry = await db.get(
            `SELECT id, userId, path, name, createdAt FROM web_generated_files
             WHERE id = @id`,
            { id }
        );
        if (!entry || entry.userId !== userId) return null;
        const fresh = await db.get(
            `SELECT 1 AS ok FROM web_generated_files
             WHERE id = @id AND createdAt >= datetime('now', '-${FILE_TTL_MS / (60 * 60 * 1000)} hours')`,
            { id }
        );
        if (!fresh) {
            await db.run('DELETE FROM web_generated_files WHERE id = @id', { id });
            return null;
        }
        if (!fs.existsSync(entry.path)) return null;
        return { path: entry.path, name: entry.name };
    }

    /**
     * Drop every generated-file registry row for a user (/forget-me).
     * Files on disk are left alone unless they live in a per-user directory
     * that another forget path already removes (uploads, observatory).
     * @param {string} userId
     * @returns {Promise<number>} rows deleted
     */
    async forgetGeneratedFiles(userId) {
        return (await db.run(
            'DELETE FROM web_generated_files WHERE userId = @userId',
            { userId }
        )).changes;
    }

    // --- Turns ---------------------------------------------------------------

    /** Sliding-window rate limit; throws 429 when exceeded. */
    async _checkRateLimit(userId) {
        const { consumeWindow } = require('../utils/slidingWindowLimit');
        const ok = await consumeWindow({
            scope: 'web_chat',
            subject: userId,
            max: RATE_LIMIT_TURNS,
            windowMs: RATE_LIMIT_WINDOW_MS
        });
        if (!ok) {
            throw new WebChatError(429, 'RATE_LIMITED',
                `Slow down - at most ${RATE_LIMIT_TURNS} messages per minute.`);
        }
    }

    // --- Incognito (transient, never persisted) -------------------------------

    /** The user's live incognito window, pruning expired ones. */
    _incognitoEntry(userId) {
        const entry = this._incognito.get(userId);
        if (!entry) return null;
        if (Date.now() - entry.updatedAt > INCOGNITO_TTL_MS) {
            this._incognito.delete(userId);
            return null;
        }
        return entry;
    }

    /** Append one message to the user's incognito window (bounded). */
    _appendIncognito(userId, content, isBot) {
        if (!content) return;
        let entry = this._incognitoEntry(userId);
        if (!entry) {
            entry = { messages: [], updatedAt: Date.now() };
            this._incognito.set(userId, entry);
        }
        entry.messages.push({ content, isBot });
        if (entry.messages.length > INCOGNITO_MAX_MESSAGES) {
            entry.messages.splice(0, entry.messages.length - INCOGNITO_MAX_MESSAGES);
        }
        entry.updatedAt = Date.now();
    }

    /**
     * Drop the user's incognito window (leaving incognito mode, or the
     * "new incognito chat" action).
     * @param {string} userId
     * @returns {{cleared: boolean}}
     */
    clearIncognito(userId) {
        this._incognitoQueue.delete(userId);
        return { cleared: this._incognito.delete(userId) };
    }

    /**
     * Context fetch for incognito turns: same Collection-like shape as
     * _fetchContextMessages, but backed by the in-memory window.
     */
    _fetchIncognitoContext(userId, botId, limit) {
        const entry = this._incognitoEntry(userId);
        const rows = entry ? entry.messages.slice(-Math.max(1, Math.min(Number(limit) || 20, INCOGNITO_MAX_MESSAGES))) : [];
        // Newest first, like channel.messages.fetch
        const result = rows.reverse().map((row, index) => ({
            id: `incog-${index}`,
            content: row.content,
            author: {
                id: row.isBot ? botId : userId,
                username: row.isBot ? 'Goobster' : 'user'
            },
            member: null,
            reference: null
        }));
        result.size = result.length;
        return result;
    }

    // --- Attachment validation -------------------------------------------------

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
     * Validate text/document attachments: bounded count and size, plain
     * text only (the client reads files as text before sending).
     * @param {Array<{name: string, content: string}>|null} files
     * @returns {Array<{name: string, content: string}>}
     */
    _validateTextFiles(files) {
        if (files === undefined || files === null) return [];
        if (!Array.isArray(files)) {
            throw new WebChatError(400, 'BAD_FILES', 'files must be an array of { name, content }.');
        }
        if (files.length > MAX_TEXT_FILES_PER_MESSAGE) {
            throw new WebChatError(400, 'BAD_FILES', `At most ${MAX_TEXT_FILES_PER_MESSAGE} files per message.`);
        }
        let total = 0;
        const clean = [];
        for (const file of files) {
            const name = String(file?.name ?? '').trim()
                // eslint-disable-next-line no-control-regex -- stripping control chars from filenames is the point
                .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
                .slice(0, MAX_FILE_NAME_LENGTH) || 'attachment.txt';
            const content = typeof file?.content === 'string' ? file.content : null;
            if (content === null) {
                throw new WebChatError(400, 'BAD_FILES', 'Each file needs string content.');
            }
            if (content.length > MAX_TEXT_FILE_CHARS) {
                throw new WebChatError(400, 'BAD_FILES',
                    `"${name}" is too large (max ${MAX_TEXT_FILE_CHARS.toLocaleString()} characters per file).`);
            }
            total += content.length;
            if (total > MAX_TEXT_FILES_TOTAL_CHARS) {
                throw new WebChatError(400, 'BAD_FILES',
                    `Attached files are too large together (max ${MAX_TEXT_FILES_TOTAL_CHARS.toLocaleString()} characters).`);
            }
            clean.push({ name, content });
        }
        return clean;
    }

    /**
     * Convert PDF attachments ({ name, contentBase64 }) into plain-text
     * entries ({ name, content }) via pdf-parse, so they ride the normal
     * text-attachment path. Async by necessity (PDF parsing), so it runs in
     * the route handler BEFORE startTurn - extraction failures stay proper
     * HTTP errors instead of mid-stream SSE errors.
     * @param {Array<Object>|null} files - mixed text and PDF entries
     * @returns {Promise<Array<{name: string, content: string}>|null>}
     */
    async extractDocumentFiles(files) {
        if (!Array.isArray(files)) return files;
        const out = [];
        for (const file of files) {
            if (typeof file?.contentBase64 !== 'string') {
                out.push(file);
                continue;
            }
            const name = String(file?.name ?? 'document.pdf');
            let buffer;
            try {
                buffer = Buffer.from(file.contentBase64, 'base64');
            } catch {
                throw new WebChatError(400, 'BAD_FILES', `"${name}" could not be decoded.`);
            }
            if (buffer.length === 0 || buffer.length > MAX_PDF_BYTES) {
                throw new WebChatError(400, 'BAD_FILES',
                    `"${name}" is too large (max ${Math.floor(MAX_PDF_BYTES / (1024 * 1024))}MB per PDF).`);
            }
            let text;
            try {
                const { PDFParse } = require('pdf-parse');
                const parser = new PDFParse({ data: buffer });
                try {
                    const result = await parser.getText();
                    text = String(result?.text || '').trim();
                } finally {
                    await parser.destroy().catch(() => {});
                }
            } catch (error) {
                throw new WebChatError(400, 'BAD_FILES',
                    `"${name}" could not be read as a PDF: ${error.message}`);
            }
            if (!text) {
                throw new WebChatError(400, 'BAD_FILES',
                    `"${name}" contains no extractable text (it may be a scanned document).`);
            }
            if (text.length > MAX_TEXT_FILE_CHARS) {
                // Leave headroom for the truncation note so the result still
                // passes _validateTextFiles' per-file cap.
                text = `${text.slice(0, MAX_TEXT_FILE_CHARS - 200)}\n\n[Truncated: the PDF text was longer than ${MAX_TEXT_FILE_CHARS.toLocaleString()} characters.]`;
            }
            out.push({ name, content: text });
        }
        return out;
    }

    /**
     * Fold text attachments into the message the pipeline (and history)
     * sees. The exact marker format is what the web client parses back
     * into collapsible attachment chips when rendering user messages.
     * @param {string} text
     * @param {Array<{name: string, content: string}>} textFiles
     */
    _composeWithFiles(text, textFiles) {
        if (textFiles.length === 0) return text;
        const blocks = textFiles.map(file =>
            `[Attached file: ${file.name}]\n\`\`\`\`\n${file.content}\n\`\`\`\``);
        return `${text}\n\n${blocks.join('\n\n')}`;
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
    async _fetchContextMessages(userId, channelId, botId, limit) {
        const guildConvId = await this._guildConvIdFor(userId, channelId);
        const result = [];
        if (guildConvId) {
            const rows = await db.all(
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
    async _autoTitle({ conversationId, userMessage }) {
        const fallback = userMessage.replace(/\s+/g, ' ').trim().slice(0, 48)
            + (userMessage.length > 48 ? '…' : '');
        await db.run(
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
                await db.run('UPDATE web_conversations SET title = @clean WHERE id = @id',
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
    async stopTurn(userId) {
        const active = this._activeTurns.get(userId);
        if (active) {
            active.abort('stop');
            await db.run(
                'UPDATE web_live_turns SET aborted = 1 WHERE userId = @userId',
                { userId }
            ).catch(() => {});
            return true;
        }
        const row = await db.get(
            'SELECT startedAtMs, lastActivityAtMs FROM web_live_turns WHERE userId = @userId',
            { userId }
        );
        if (!row) return false;
        if (this._wedgedReason({ startedAt: Number(row.startedAtMs), lastActivityAt: row.lastActivityAtMs })) {
            await db.run('DELETE FROM web_live_turns WHERE userId = @userId', { userId }).catch(() => {});
            return false;
        }
        await db.run(
            'UPDATE web_live_turns SET aborted = 1 WHERE userId = @userId',
            { userId }
        );
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
     * @param {Array<{name,content}>} [params.files] - text attachments
     * @param {boolean} [params.incognito] - transient turn: no history, no memory
     * @param {boolean} [params.spoken] - the reply will be read aloud (portal
     *   voice chat): the prompt asks for speech-shaped prose, no Markdown/URLs/tables
     * @returns {{ run: (events?: Object) => Promise<void>, release: () => Promise<void>, abort: () => void, conversationId: number|null }}
     */
    async startTurn({
        client, gateway, userId, userName, message, conversationId = null,
        images = null, files = null, incognito = false,
        isAutomation = false, sourceDescription = null, spoken = false
    }) {
        await require('./resourceAdmissionService').assertActor(userId);
        if (!isAutomation) await require('./usageBudgetService').assertAvailable(userId);
        // Resolve the assistant identity through whichever seam this process
        // has: the live client (bot / lite), the gateway (the api service
        // reaching the bot), or the installation's own assistant identity.
        // Discord's bot user is a transport identity, not a prerequisite for
        // a chat turn (spec §6), so this never reports the bot as offline.
        const resolvedGateway = toGateway(gateway || client);
        const botUser = await resolveAssistantUser({ client, gateway: resolvedGateway });
        this._rememberRuntime(userId, { client, gateway: resolvedGateway, userName });
        const text = String(message ?? '').trim();
        if (!text) {
            throw new WebChatError(400, 'EMPTY_MESSAGE', 'Message cannot be empty.');
        }
        if (text.length > MAX_INPUT_LENGTH) {
            throw new WebChatError(400, 'MESSAGE_TOO_LONG',
                `Message is too long (max ${MAX_INPUT_LENGTH} characters).`);
        }
        const imageUrls = this._validateImages(images);
        const textFiles = this._validateTextFiles(files);
        const composed = this._composeWithFiles(text, textFiles);
        const {
            decodeDataUrlImage,
            fromTextFile,
            fromSavedPath,
            normalizeIncomingAttachments
        } = require('../utils/incomingAttachments');
        const incomingAttachmentItems = textFiles.map(fromTextFile);
        const existing = await this._liveTurn(userId);
        if (existing) {
            throw this._turnInFlightError(userId, 'wait for it to finish or stop it', existing);
        }
        // Persist uploaded images to disk so the transcript can re-serve
        // them after a reload (incognito persists nothing, by definition).
        let userAttachments = null;
        if (!incognito && imageUrls.length > 0) {
            const { saveDataUrlImage } = require('../utils/webUploads');
            userAttachments = imageUrls
                .map(dataUrl => {
                    try { return saveDataUrlImage(userId, dataUrl); } catch { return null; }
                })
                .filter(Boolean);
            if (userAttachments.length === 0) userAttachments = null;
        }
        if (userAttachments?.length) {
            for (const saved of userAttachments) {
                incomingAttachmentItems.push(fromSavedPath({ name: saved.name, path: saved.path }));
            }
        } else {
            for (const dataUrl of imageUrls) {
                const decoded = decodeDataUrlImage(dataUrl);
                if (decoded) incomingAttachmentItems.push(decoded);
            }
        }
        const incomingAttachments = incomingAttachmentItems.length > 0
            ? normalizeIncomingAttachments(incomingAttachmentItems)
            : null;
        // Incognito turns never touch web_conversations - their window
        // lives in memory only and evaporates.
        const conversation = incognito ? null : await this._requireConversation(userId, conversationId);
        let inboxInstructions = conversation ? await require('./conversationContextService').instructions({
            userId, kind: 'chat', conversationId: conversation.id
        }) : null;
        await this._checkRateLimit(userId);

        // The abort controller hard-cancels the in-flight provider
        // request/stream (fetch/SDK signal); `aborted` additionally stops
        // the agent loop between rounds.
        const controller = new AbortController();
        const turnId = crypto.randomBytes(8).toString('hex');
        const initialProgress = emptyProgress(text);
        const startedAtMs = Date.now();
        try {
            await db.run(
                `INSERT INTO web_live_turns (userId, turnId, startedAtMs, conversationId, aborted, progressJson, lastActivityAtMs)
                 VALUES (@userId, @turnId, @startedAtMs, @conversationId, 0, @progressJson, @startedAtMs)`,
                {
                    userId,
                    turnId,
                    startedAtMs,
                    conversationId: conversation?.id ?? null,
                    // Lock metadata only for incognito — the prompt/draft live
                    // on turnState.progress in memory (same rule as the window).
                    progressJson: incognito ? null : JSON.stringify(initialProgress)
                }
            );
        } catch (error) {
            if (String(error.message || '').includes('UNIQUE')) {
                throw this._turnInFlightError(userId);
            }
            throw error;
        }
        const turnState = {
            aborted: false,
            // 'stop' (the user asked) or 'watchdog' (the turn was evicted):
            // the chat pipeline ends quietly for the former and delivers a
            // handoff for the latter.
            abortReason: null,
            turnId,
            userId,
            incognito: Boolean(incognito),
            startedAt: startedAtMs,
            lastActivityAt: startedAtMs,
            // The agent loop stops starting tool rounds here and hands off,
            // well before the absolute watchdog ceiling would cut it off.
            deadlineAt: startedAtMs + TURN_MAX_AGE_MS - TURN_DEADLINE_MARGIN_MS,
            // Lets turnStatus point the browser at the conversation that is
            // holding the per-user lock (null for incognito turns).
            conversationId: conversation?.id ?? null,
            signal: controller.signal,
            listeners: new Set(),
            progress: initialProgress,
            abort: (reason = 'stop') => {
                if (!turnState.aborted) turnState.abortReason = reason;
                turnState.aborted = true;
                try { controller.abort(); } catch { /* double-abort is fine */ }
            }
        };
        this._activeTurns.set(userId, turnState);
        // Cross-replica Stop writes aborted=1; pick it up without making
        // shouldAbort async (the agent loop checks it synchronously).
        const abortPoll = setInterval(() => {
            db.get(
                'SELECT aborted FROM web_live_turns WHERE userId = @userId AND turnId = @turnId',
                { userId, turnId }
            ).then((row) => {
                if (Number(row?.aborted) === 1) turnState.abort('stop');
            }).catch(() => {});
        }, 1000);
        abortPoll.unref?.();
        turnState.abortPoll = abortPoll;
        let released = false;
        const release = async () => {
            if (released) return;
            released = true;
            clearInterval(abortPoll);
            turnState.abortPoll = null;
            // Identity-guarded: if the watchdog already evicted this turn
            // and a successor took the lock, settling late must not free
            // the successor's lock.
            if (this._activeTurns.get(userId) === turnState) {
                this._activeTurns.delete(userId);
            }
            if (turnState.persistTimer) {
                clearTimeout(turnState.persistTimer);
                turnState.persistTimer = null;
            }
            const settledListeners = [...(turnState.listeners || [])];
            turnState.listeners = new Set();
            await db.run(
                'DELETE FROM web_live_turns WHERE userId = @userId AND turnId = @turnId',
                { userId, turnId }
            ).catch(() => {});
            for (const listener of settledListeners) {
                try { listener.onSettled?.(); } catch { /* never break release */ }
            }
            // Reactive clients (this browser after a reload, another tab)
            // learn the turn settled and refetch the finished transcript.
            eventBus.publish('web-turn', {
                userId,
                phase: 'settled',
                turnId,
                conversationId: conversation?.id ?? null,
                invalidate: [
                    'chat-turn',
                    'chat-queue',
                    'conversations',
                    ...(conversation ? [`history:${conversation.id}`] : [])
                ]
            });
            void this._kickQueue(userId);
        };
        eventBus.publish('web-turn', {
            userId,
            phase: 'started',
            turnId,
            conversationId: conversation?.id ?? null,
            invalidate: ['chat-turn']
        });

        return {
            conversationId: conversation?.id ?? null,
            abort: turnState.abort,
            release,
            run: async (events = {}) => require('../utils/workContext').run(
                { kind: 'chat', id: turnId, actor: userId }, async () => {
                const sseListener = {
                    onTyping: events.onTyping,
                    onDelta: events.onDelta,
                    onTool: events.onTool,
                    onMessage: events.onMessage
                };
                turnState.listeners.add(sseListener);
                const hubEvents = {
                    onTyping: () => this._emitTurnEvent(turnState, 'typing'),
                    onDelta: (delta) => this._emitTurnEvent(turnState, 'delta', delta),
                    onTool: (event) => this._emitTurnEvent(turnState, 'tool', event),
                    onMessage: (payload) => this._emitTurnEvent(turnState, 'message', payload)
                };
                try {
                    if (conversation) {
                        inboxInstructions = await require('./conversationContextService').instructions({
                            userId, kind: 'chat', conversationId: conversation.id
                        });
                        await db.run(
                            `UPDATE web_conversations SET lastMessageAt = datetime('now') WHERE id = @id`,
                            { id: conversation.id }
                        );
                        if (!conversation.title) {
                            await this._autoTitle({ conversationId: conversation.id, userMessage: text });
                        }
                    }
                    // Incognito: capture completed bot replies so the
                    // transient window can serve the next turn's context.
                    const capturedReplies = [];
                    const effectiveEvents = incognito
                        ? {
                            ...hubEvents,
                            onMessage: (payload) => {
                                if (payload?.content && !payload.isError) capturedReplies.push(payload.content);
                                hubEvents.onMessage(payload);
                            }
                        }
                        : hubEvents;
                    const interaction = this._buildInteraction({
                        client, gateway: resolvedGateway, botUser, userId, userName,
                        text: composed,
                        channelId: incognito
                            ? `${WEB_CHANNEL_PREFIX}${userId}:incognito`
                            : conversation.channelId,
                        imageUrls, turnState,
                        incognito,
                        userAttachments,
                        incomingAttachments,
                        events: effectiveEvents,
                        isAutomation,
                        sourceDescription,
                        spoken
                    });
                    interaction.inboxInstructions = inboxInstructions;
                    await handleChatInteraction(interaction);
                    if (interaction.budgetError) throw interaction.budgetError;
                    if (incognito) {
                        this._appendIncognito(userId, composed, false);
                        for (const reply of capturedReplies) {
                            this._appendIncognito(userId, reply, true);
                        }
                    }
                } finally {
                    turnState.listeners.delete(sseListener);
                    await release();
                }
            })
        };
    }

    /**
     * Run one web chat turn end to end (startTurn + run in one call).
     * @param {Object} params - { client, userId, userName, message, conversationId, images, files, incognito, events }
     */
    async runTurn({
        client, gateway, userId, userName, message, conversationId = null,
        images = null, files = null, incognito = false, events = {},
        isAutomation = false, sourceDescription = null, spoken = false
    }) {
        const turn = await this.startTurn({
            client, gateway, userId, userName, message, conversationId, images, files, incognito,
            isAutomation, sourceDescription, spoken
        });
        await turn.run(events);
    }

    /**
     * The web-shaped pseudo-interaction fed to handleChatInteraction.
     * @param {Object} params - { client, userId, userName, text, channelId, imageUrls, turnState, incognito, events }
     */
    /**
     * The SITUATION line for a portal turn: which surface the words came
     * through and how the reply will be consumed. Voice chat replaces the
     * "Markdown is fully supported" pitch - a spoken reply has no rendering.
     */
    _defaultSourceDescription({ userName, incognito = false, spoken = false }) {
        const who = userName || 'the user';
        const surface = spoken
            ? `You are talking with ${who} through Goobster's web VOICE CHAT (a browser app, not Discord): ` +
              'they spoke into a microphone, their words were transcribed, and your reply is read aloud to them ' +
              'by text-to-speech while the same words show as a caption.'
            : `You are chatting with ${who} through Goobster's private web chat interface (a browser app, not Discord).`;
        const memory = incognito
            ? 'This is INCOGNITO MODE - a temporary conversation that is not stored and leaves no memory.'
            : 'It is a one-on-one conversation that shares long-term memory with their Discord DMs.';
        const format = spoken
            ? 'Keep the conversation personal and conversational, the way you would speak on a call.'
            : 'Markdown is fully supported and there is no message length limit - keep the conversation personal and conversational.';
        return `${surface} ${memory} ${format}`;
    }

    _buildInteraction({
        client, gateway = null, botUser = null, userId, userName, text, channelId,
        imageUrls, turnState, incognito = false, userAttachments = null,
        incomingAttachments = null, events, isAutomation = false, sourceDescription = null,
        spoken = false
    }) {
        const service = this;
        const botUserId = botUser?.id || client?.user?.id;
        // In the api process there is no live client: tools that only read
        // the bot identity get this shim, and everything that actually
        // needs Discord goes through interaction.gateway.
        const effectiveClient = client?.user?.id
            ? client
            : { user: { id: botUserId, username: botUser?.username || identityConfig.assistantName } };

        const channel = {
            id: channelId,
            isThread: () => false,
            sendTyping: async () => {
                try { events.onTyping?.(); } catch { /* never break the turn */ }
            },
            messages: {
                fetch: async ({ limit = 20 } = {}) => incognito
                    ? service._fetchIncognitoContext(userId, botUserId, limit)
                    : service._fetchContextMessages(userId, channelId, botUserId, limit)
            },
            send: async (payload) => {
                await service._emitMessage(events, payload, userId);
                return { id: `web-msg-${Date.now()}` };
            }
        };

        const interaction = {
            id: `web-${userId}-${Date.now()}`,
            // The durable turn id (web_live_turns): the work id the failure
            // and resource ledgers key on for this turn.
            turnId: turnState?.turnId || null,
            user: { id: userId, username: userName || `user_${userId}` },
            guild: null,
            guildId: null,
            member: null,
            client: effectiveClient,
            gateway,
            content: text,
            channel,
            channelId,
            imageUrls,
            // Uploaded images already saved to disk - the pipeline writes
            // these onto the user message row (metadata.attachments) so the
            // transcript can re-serve them after a reload.
            userAttachments,
            incomingAttachments,
            // Web capabilities the chat pipeline understands
            maxInputLength: Math.max(MAX_INPUT_LENGTH, text.length),
            shouldAbort: () => turnState.aborted,
            // 'stop' vs 'watchdog': only a user Stop ends the turn quietly.
            abortReason: () => turnState.abortReason,
            // The agent loop finalizes (hands off) once this passes, so the
            // watchdog ceiling is never what ends a working turn.
            turnDeadlineAt: turnState.deadlineAt,
            turnStartedAt: turnState.startedAt,
            // Hard-cancels the in-flight provider request/stream on Stop or
            // watchdog eviction (see chatHandler's chatOptions.signal).
            abortSignal: turnState.signal,
            skipHistory: incognito,
            isAutomation: isAutomation === true,
            // Voice chat: the reply is synthesized, so chatHandler asks the
            // model for speech-shaped prose (see spokenReplyContract).
            spoken: spoken === true,
            // Tool-activity chips: per-tool progress streamed to the browser
            onToolEvent: (event) => {
                try { events.onTool?.(event); } catch { /* never break the turn */ }
            },
            sourceDescription: sourceDescription
                || service._defaultSourceDescription({ userName, incognito, spoken }),
            onStreamDelta: (delta) => {
                try { events.onDelta?.(delta); } catch { /* never break the turn */ }
            },
            sendFullResponse: async (content, { isError = false } = {}) => {
                await service._emitMessage(events, content, userId, isError);
            },
            deferReply: async () => {},
            editReply: async (response) => {
                await service._emitMessage(events, response, userId);
            },
            reply: async (response) => {
                await service._emitMessage(events, response, userId);
            },
            followUp: async (response) => {
                await service._emitMessage(events, response, userId);
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
    async _emitMessage(events, payload, userId, isError = false) {
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
                const registered = await this._registerFile(filePath, userId);
                if (registered) {
                    // Discord's AttachmentPayload `description` is the alt
                    // text; the files tools also pass sourceUrl/kind, which
                    // discord.js ignores and the portal renders as captions.
                    attachments.push(decorateAttachment(registered, {
                        name: typeof file === 'object' ? file.name : null,
                        caption: typeof file === 'object' ? file.description : null,
                        sourceUrl: typeof file === 'object' ? file.sourceUrl : null,
                        kind: typeof file === 'object' ? file.kind : null
                    }));
                }
            }
        }

        if (!content && attachments.length === 0) return;
        try {
            events.onMessage?.({ content, attachments, isError: Boolean(isError) });
        } catch { /* never break the turn */ }
    }

    // --- Follow-up queue ----------------------------------------------------

    async listQueue(userId, runtime = null) {
        if (runtime) this._rememberRuntime(userId, runtime);
        void this._kickQueue(userId);
        const incognito = this._incognitoQueue.get(userId) || [];
        const rows = await db.all(
            `SELECT id, conversationId, position, message, imagesJson, filesJson, incognito, createdAt
             FROM web_chat_queue WHERE userId = @userId
             ORDER BY position ASC, id ASC`,
            { userId }
        );
        const persisted = rows.map((row) => this._queueRowToItem(row));
        return { items: [...incognito, ...persisted].map((item) => this._queuePublicItem(item)) };
    }

    async enqueue({
        userId, userName, client, gateway, message, conversationId = null,
        images = null, files = null, incognito = false
    }) {
        this._rememberRuntime(userId, { client, gateway, userName });
        const text = String(message ?? '').trim();
        if (!text) throw new WebChatError(400, 'EMPTY_MESSAGE', 'Message cannot be empty.');
        if (text.length > MAX_INPUT_LENGTH) {
            throw new WebChatError(400, 'MESSAGE_TOO_LONG',
                `Message is too long (max ${MAX_INPUT_LENGTH} characters).`);
        }
        const imageUrls = this._validateImages(images);
        const textFiles = this._validateTextFiles(files);
        if (incognito) {
            const list = this._incognitoQueue.get(userId) || [];
            if (list.length >= MAX_QUEUE_LENGTH) {
                throw new WebChatError(400, 'QUEUE_FULL',
                    `At most ${MAX_QUEUE_LENGTH} follow-ups can wait in the queue.`);
            }
            const item = {
                id: `incog-${Date.now()}-${list.length}`,
                conversationId: null,
                position: list.length,
                message: text,
                images: imageUrls,
                files: textFiles,
                incognito: true
            };
            list.push(item);
            this._incognitoQueue.set(userId, list);
            void this._kickQueue(userId);
            return this._queuePublicItem(item);
        }
        const countRow = await db.get(
            'SELECT COUNT(*) AS c FROM web_chat_queue WHERE userId = @userId',
            { userId }
        );
        if ((countRow?.c || 0) >= MAX_QUEUE_LENGTH) {
            throw new WebChatError(400, 'QUEUE_FULL',
                `At most ${MAX_QUEUE_LENGTH} follow-ups can wait in the queue.`);
        }
        if (conversationId != null) {
            await this._requireConversation(userId, conversationId);
        }
        const maxPos = await db.get(
            'SELECT MAX(position) AS m FROM web_chat_queue WHERE userId = @userId',
            { userId }
        );
        const position = Number(maxPos?.m || 0) + 1;
        const id = await db.insert(
            `INSERT INTO web_chat_queue (userId, conversationId, position, message, imagesJson, filesJson, incognito)
             VALUES (@userId, @conversationId, @position, @message, @imagesJson, @filesJson, 0)`,
            {
                userId,
                conversationId: conversationId ?? null,
                position,
                message: text,
                imagesJson: imageUrls.length ? JSON.stringify(imageUrls) : null,
                filesJson: textFiles.length ? JSON.stringify(textFiles) : null
            }
        );
        eventBus.publish('web-turn', {
            userId,
            phase: 'queued',
            conversationId: conversationId ?? null,
            invalidate: ['chat-queue']
        });
        void this._kickQueue(userId);
        return this._queuePublicItem({
            id,
            conversationId: conversationId ?? null,
            position,
            message: text,
            images: imageUrls,
            files: textFiles,
            incognito: false
        });
    }

    async removeQueued(userId, id) {
        if (typeof id === 'string' && String(id).startsWith('incog-')) {
            const list = (this._incognitoQueue.get(userId) || []).filter((item) => item.id !== id);
            this._incognitoQueue.set(userId, list);
            return { removed: true };
        }
        const result = await db.run(
            'DELETE FROM web_chat_queue WHERE id = @id AND userId = @userId',
            { id: Number(id), userId }
        );
        if (!result.changes) throw new WebChatError(404, 'NOT_FOUND', 'That queued message is gone.');
        eventBus.publish('web-turn', {
            userId, phase: 'queued', invalidate: ['chat-queue']
        });
        return { removed: true };
    }

    async reorderQueue(userId, ids) {
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new WebChatError(400, 'BAD_ORDER', 'ids must be the queue in the desired order.');
        }
        const incognito = ids.every((id) => typeof id === 'string' && String(id).startsWith('incog-'));
        if (incognito) {
            const list = this._incognitoQueue.get(userId) || [];
            const byId = new Map(list.map((item) => [item.id, item]));
            if (ids.length !== list.length || ids.some((id) => !byId.has(id))) {
                throw new WebChatError(400, 'BAD_ORDER', 'ids must list every queued message once.');
            }
            this._incognitoQueue.set(userId, ids.map((id, index) => ({ ...byId.get(id), position: index })));
            return this.listQueue(userId);
        }
        const rows = await db.all(
            'SELECT id FROM web_chat_queue WHERE userId = @userId ORDER BY position ASC, id ASC',
            { userId }
        );
        const have = rows.map((row) => Number(row.id));
        const want = ids.map((id) => Number(id));
        if (have.length !== want.length || [...have].sort((a, b) => a - b).join() !== [...want].sort((a, b) => a - b).join()) {
            throw new WebChatError(400, 'BAD_ORDER', 'ids must list every queued message once.');
        }
        await db.transaction(async (tx) => {
            let position = 1;
            for (const id of want) {
                await tx.run(
                    'UPDATE web_chat_queue SET position = @position WHERE id = @id AND userId = @userId',
                    { position, id, userId }
                );
                position += 1;
            }
        });
        eventBus.publish('web-turn', {
            userId, phase: 'queued', invalidate: ['chat-queue']
        });
        return this.listQueue(userId);
    }

    _queueRowToItem(row) {
        const parseJsonArray = (json) => {
            try {
                const value = json ? JSON.parse(json) : [];
                return Array.isArray(value) ? value : [];
            } catch {
                return [];
            }
        };
        return {
            id: row.id,
            conversationId: row.conversationId ?? null,
            position: row.position,
            message: row.message,
            images: parseJsonArray(row.imagesJson),
            files: parseJsonArray(row.filesJson),
            incognito: Number(row.incognito) === 1,
            createdAt: row.createdAt
        };
    }

    /** List/enqueue payloads omit image/file bytes; the drain still has them. */
    _queuePublicItem(item) {
        return {
            id: item.id,
            conversationId: item.conversationId ?? null,
            position: item.position,
            message: item.message,
            imageCount: Array.isArray(item.images) ? item.images.length : 0,
            fileCount: Array.isArray(item.files) ? item.files.length : 0,
            incognito: Boolean(item.incognito),
            createdAt: item.createdAt || null
        };
    }

    async _popQueue(userId) {
        const incognito = this._incognitoQueue.get(userId) || [];
        if (incognito.length > 0) {
            const item = incognito.shift();
            this._incognitoQueue.set(userId, incognito);
            return item;
        }
        return db.transaction(async (tx) => {
            const live = await tx.get(
                'SELECT 1 AS ok FROM web_live_turns WHERE userId = @userId',
                { userId }
            );
            if (live) return null;
            // One statement claims the head row. SELECT-then-DELETE would
            // let two Postgres workers both read the same row; the loser
            // still "got" it and later requeued a duplicate. RETURNING is
            // empty for whoever lost the delete.
            const row = await tx.get(
                `DELETE FROM web_chat_queue
                 WHERE id = (
                     SELECT id FROM (
                         SELECT id FROM web_chat_queue
                         WHERE userId = @userId
                         ORDER BY position ASC, id ASC
                         LIMIT 1
                     ) AS claimed
                 )
                 RETURNING id, conversationId, position, message, imagesJson, filesJson, incognito`,
                { userId }
            );
            if (!row) return null;
            return this._queueRowToItem(row);
        });
    }

    async _requeueFront(userId, item) {
        if (!item) return;
        if (item.incognito || (typeof item.id === 'string' && String(item.id).startsWith('incog-'))) {
            const list = this._incognitoQueue.get(userId) || [];
            this._incognitoQueue.set(userId, [item, ...list]);
            return;
        }
        const minPos = await db.get(
            'SELECT MIN(position) AS m FROM web_chat_queue WHERE userId = @userId',
            { userId }
        );
        const position = Number.isFinite(Number(minPos?.m)) ? Number(minPos.m) - 1 : 1;
        await db.run(
            `INSERT INTO web_chat_queue (userId, conversationId, position, message, imagesJson, filesJson, incognito)
             VALUES (@userId, @conversationId, @position, @message, @imagesJson, @filesJson, 0)`,
            {
                userId,
                conversationId: item.conversationId ?? null,
                position,
                message: item.message,
                imagesJson: item.images?.length ? JSON.stringify(item.images) : null,
                filesJson: item.files?.length ? JSON.stringify(item.files) : null
            }
        );
    }

    async _kickQueue(userId) {
        if (!userId || this._kicking.has(userId)) return;
        this._kicking.add(userId);
        try {
            await require('./resourceAdmissionService').assertActor(userId);
            if (await this._liveTurn(userId)) return;
            const item = await this._popQueue(userId);
            if (!item) return;
            const runtime = this._runtimeByUser.get(userId) || {};
            let turn;
            try {
                turn = await this.startTurn({
                    client: runtime.client,
                    gateway: runtime.gateway,
                    userId,
                    userName: runtime.userName,
                    message: item.message,
                    conversationId: item.conversationId,
                    images: item.images,
                    files: item.files,
                    incognito: Boolean(item.incognito)
                });
            } catch (error) {
                await this._requeueFront(userId, item).catch(() => {});
                if (error?.code !== 'TURN_IN_FLIGHT' && error?.code !== 'RATE_LIMITED') {
                    console.warn('[WebChat] Queue kick failed:', error.message || error);
                }
                return;
            }
            // Do not hold `_kicking` across `run()` — release() kicks the
            // next item when this turn settles.
            turn.run({}).catch((error) => {
                console.warn('[WebChat] Queued turn failed:', error.message || error);
                void this._kickQueue(userId);
            });
        } finally {
            this._kicking.delete(userId);
        }
    }
}

module.exports = new WebChatService();
module.exports.WebChatError = WebChatError;
module.exports.TURN_IDLE_MAX_MS = TURN_IDLE_MAX_MS;
module.exports.TURN_MAX_AGE_MS = TURN_MAX_AGE_MS;
module.exports.TURN_DEADLINE_MARGIN_MS = TURN_DEADLINE_MARGIN_MS;
