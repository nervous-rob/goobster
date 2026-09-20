/**
 * The in-app inbox (shared-instance Increment C, spec §6).
 *
 * Every result of unattended work addressed to one person - a due
 * reminder, a scheduled task's reply, a watch that fired, an invitation, a
 * notice the attention system raised - lands here first, durably, and is
 * then optionally echoed to Discord. The echo is bookkeeping on the item
 * (`discordStatus`), never the source of truth: a closed DM, a bot that is
 * down, or an installation with no Discord adapter changes what the person
 * sees in Discord, not whether the result exists.
 *
 * Producers call `deliver()` once per result. It never throws for a
 * delivery problem (the caller has already done the work) and never
 * re-runs anything on retry. The portal reads the list, marks items read,
 * and archives them; /forget-me erases them (privacyService).
 */

const db = require('../db');
const eventBus = require('./eventBusService');
const { toGateway } = require('../gateway');
const identityConfig = require('../config/identityConfig');

const KINDS = ['reminder', 'task', 'watch', 'notice', 'invite', 'project', 'expedition', 'system'];
const MAX_TITLE = 200;
const MAX_BODY = 16_000;
const MAX_LIST = 100;
// Discord's message cap; the inbox keeps the full body, the DM gets a head.
const DM_BODY_LIMIT = 1800;

class InboxError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'InboxError';
        this.status = status;
        this.code = code;
    }
}

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Inbox channel ids mark deliveries that go to the inbox, not Discord. */
const INBOX_CHANNEL_PREFIX = 'inbox:';

function inboxChannelId(userId) {
    return `${INBOX_CHANNEL_PREFIX}${userId}`;
}

function isInboxChannelId(channelId) {
    return typeof channelId === 'string' && channelId.startsWith(INBOX_CHANNEL_PREFIX);
}

class InboxService {
    constructor() {
        this.InboxError = InboxError;
        this.KINDS = KINDS;
    }

    /**
     * Persist one result for one person, then echo it to Discord when the
     * caller asks for it and the person can receive it there.
     *
     * @param {Object} params
     * @param {string} params.userId - principal id (snowflake or usr_…)
     * @param {string} params.kind - one of KINDS
     * @param {string} params.title
     * @param {string} [params.body] - Markdown
     * @param {{ type: string, id: string|number }} [params.source]
     * @param {string} [params.link] - portal path (e.g. '/tasks')
     * @param {Array<{ url: string, name: string }>} [params.attachments]
     * @param {string} [params.dedupeKey] - same key twice = one item
     * @param {Object|false} [params.discord] - `{ gateway, discordUserId?, payload? }`
     *   to also DM the person; omit/false to keep the result in-app only.
     *   `discordUserId` defaults to the principal's Discord subject. Pass
     *   `{ status: 'sent' | 'failed', error? }` when the producer already
     *   delivered through Discord itself and only wants that recorded.
     * @returns {Promise<{ item: Object, created: boolean, discord: { status: string, error: string|null } }>}
     */
    async deliver({
        userId, kind, title, body = null, source = null, link = null,
        attachments = null, dedupeKey = null, discord = false
    }) {
        const owner = String(userId ?? '').trim();
        if (!owner) throw new InboxError(400, 'BAD_USER', 'An inbox item needs an owner.');
        if (!KINDS.includes(kind)) throw new InboxError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}.`);
        const cleanTitle = String(title ?? '').trim().slice(0, MAX_TITLE);
        if (!cleanTitle) throw new InboxError(400, 'BAD_TITLE', 'An inbox item needs a title.');
        const cleanBody = body == null ? null : String(body).slice(0, MAX_BODY);
        const files = Array.isArray(attachments)
            ? attachments.filter(a => a && typeof a.url === 'string').map(a => ({ url: a.url, name: a.name || null }))
            : [];

        const params = {
            userId: owner,
            kind,
            title: cleanTitle,
            body: cleanBody,
            sourceType: source?.type ? String(source.type) : null,
            sourceId: source?.id != null ? String(source.id) : null,
            link: link ? String(link).slice(0, 500) : null,
            attachmentsJson: files.length > 0 ? JSON.stringify(files) : null,
            dedupeKey: dedupeKey ? String(dedupeKey).slice(0, 200) : null
        };

        let row = null;
        let created = true;
        if (params.dedupeKey) {
            row = await db.get(
                'SELECT * FROM inbox_items WHERE userId = @userId AND dedupeKey = @dedupeKey',
                { userId: owner, dedupeKey: params.dedupeKey }
            );
            if (row) created = false;
        }
        if (!row) {
            const id = await db.insert(
                `INSERT INTO inbox_items (userId, kind, title, body, sourceType, sourceId, link, attachmentsJson, dedupeKey)
                 VALUES (@userId, @kind, @title, @body, @sourceType, @sourceId, @link, @attachmentsJson, @dedupeKey)`,
                params
            );
            row = await db.get('SELECT * FROM inbox_items WHERE id = @id', { id });
            eventBus.publish('inbox', { userId: owner, itemId: row.id, kind });
        }

        let echo = { status: row.discordStatus, error: row.discordError || null };
        if (created && discord) {
            echo = await this._echoToDiscord(row, discord);
            row = (await db.get('SELECT * FROM inbox_items WHERE id = @id', { id: row.id })) || row;
        }
        return { item: this._publicItem(row), created, discord: echo };
    }

    /**
     * The Discord echo. Resolves the person's Discord subject, sends a
     * compact DM that points back at the inbox item, and records the
     * outcome on the row. Never throws.
     */
    async _echoToDiscord(row, { gateway = null, client = null, discordUserId = null, payload = null, status = null, error = null } = {}) {
        const resolved = toGateway(gateway || client);
        const finish = async (status, error = null) => {
            await db.run(
                `UPDATE inbox_items SET discordStatus = @status, discordError = @error,
                        discordSentAt = CASE WHEN @status = 'sent' THEN @now ELSE discordSentAt END
                 WHERE id = @id`,
                { id: row.id, status, error: error ? String(error).slice(0, 300) : null, now: nowUtc() }
            );
            return { status, error };
        };
        if (status) {
            // The producer already delivered through a Discord channel of
            // its own (a legacy DM-channel automation): record, don't resend.
            return finish(status === 'sent' ? 'sent' : 'failed', error || null);
        }
        if (!resolved) return finish('skipped', 'no gateway');
        const subject = discordUserId || await this._discordSubject(row.userId);
        if (!subject) return finish('skipped', 'no Discord identity');
        const message = payload || this._dmPayload(row);
        let outcome;
        try {
            outcome = await resolved.sendDm(subject, message);
        } catch (error) {
            outcome = { ok: false, error: error.message };
        }
        if (outcome?.ok) return finish('sent');
        const reason = outcome?.error || 'unknown';
        // A missing adapter is a skip, not a failure: nothing to retry.
        return finish(reason === 'DISCORD_DISABLED' ? 'skipped' : 'failed', reason);
    }

    /** The compact Discord rendering of an item (the inbox keeps the whole thing). */
    _dmPayload(row) {
        const body = row.body ? String(row.body) : '';
        const head = body.length > DM_BODY_LIMIT ? `${body.slice(0, DM_BODY_LIMIT - 1)}…` : body;
        const files = row.attachmentsJson ? this._parseAttachments(row.attachmentsJson) : [];
        const more = files.length > 0 ? `\n\n📎 ${files.length} attachment(s) - open them in the portal.` : '';
        return {
            content: `**${row.title}**${head ? `\n\n${head}` : ''}${more}`,
            allowedMentions: { users: [], roles: [] }
        };
    }

    async _discordSubject(userId) {
        const identityService = require('./identityService');
        if (identityService.isSnowflake(userId)) return String(userId);
        const linked = await db.get(
            `SELECT subject FROM auth_identities
             WHERE principalId = @userId AND provider = 'discord' ORDER BY id LIMIT 1`,
            { userId }
        ).catch(() => null);
        return linked?.subject || null;
    }

    _parseAttachments(json) {
        try {
            const parsed = JSON.parse(json);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    _publicItem(row) {
        return {
            id: row.id,
            kind: row.kind,
            title: row.title,
            body: row.body || null,
            source: row.sourceType ? { type: row.sourceType, id: row.sourceId } : null,
            link: row.link || null,
            attachments: row.attachmentsJson ? this._parseAttachments(row.attachmentsJson) : [],
            read: Boolean(row.readAt),
            archived: Boolean(row.archivedAt),
            discord: { status: row.discordStatus, error: row.discordError || null, sentAt: row.discordSentAt || null },
            createdAt: row.createdAt
        };
    }

    // --- Reading ------------------------------------------------------------

    /**
     * @param {Object} params - { userId, unread?, archived?, limit? }
     * @returns {Promise<{ items: Object[], unread: number }>}
     */
    async list({ userId, unread = false, archived = false, limit = 50 }) {
        const bounded = Math.max(1, Math.min(Number(limit) || 50, MAX_LIST));
        const where = ['userId = @userId', archived ? 'archivedAt IS NOT NULL' : 'archivedAt IS NULL'];
        if (unread) where.push('readAt IS NULL');
        const rows = await db.all(
            `SELECT * FROM inbox_items WHERE ${where.join(' AND ')}
             ORDER BY createdAt DESC, id DESC LIMIT ${bounded}`,
            { userId: String(userId) }
        );
        return { items: rows.map(row => this._publicItem(row)), unread: await this.unreadCount(userId) };
    }

    async unreadCount(userId) {
        const row = await db.get(
            'SELECT COUNT(*) AS c FROM inbox_items WHERE userId = @userId AND readAt IS NULL AND archivedAt IS NULL',
            { userId: String(userId) }
        );
        return Number(row?.c || 0);
    }

    async get({ userId, itemId }) {
        const row = await db.get(
            'SELECT * FROM inbox_items WHERE id = @id AND userId = @userId',
            { id: Number(itemId), userId: String(userId) }
        );
        if (!row) throw new InboxError(404, 'NOT_FOUND', 'No such inbox item.');
        return this._publicItem(row);
    }

    async markRead({ userId, itemId, read = true }) {
        const result = read
            ? await db.run(
                'UPDATE inbox_items SET readAt = @now WHERE id = @id AND userId = @userId',
                { id: Number(itemId), userId: String(userId), now: nowUtc() }
            )
            : await db.run(
                'UPDATE inbox_items SET readAt = NULL WHERE id = @id AND userId = @userId',
                { id: Number(itemId), userId: String(userId) }
            );
        if (!result.changes) throw new InboxError(404, 'NOT_FOUND', 'No such inbox item.');
        eventBus.publish('inbox', { userId: String(userId), itemId: Number(itemId) });
        return this.get({ userId, itemId });
    }

    async markAllRead({ userId }) {
        const result = await db.run(
            'UPDATE inbox_items SET readAt = @now WHERE userId = @userId AND readAt IS NULL AND archivedAt IS NULL',
            { userId: String(userId), now: nowUtc() }
        );
        eventBus.publish('inbox', { userId: String(userId) });
        return { updated: result.changes || 0 };
    }

    async archive({ userId, itemId }) {
        const result = await db.run(
            'UPDATE inbox_items SET archivedAt = @now, readAt = COALESCE(readAt, @now) WHERE id = @id AND userId = @userId',
            { id: Number(itemId), userId: String(userId), now: nowUtc() }
        );
        if (!result.changes) throw new InboxError(404, 'NOT_FOUND', 'No such inbox item.');
        eventBus.publish('inbox', { userId: String(userId), itemId: Number(itemId) });
        return { archived: true };
    }

    // --- Privacy ------------------------------------------------------------

    /** Erase one person's inbox (privacy / forget-me). */
    async forgetUser(userId, handle = db) {
        if (!userId) return 0;
        return (await handle.run('DELETE FROM inbox_items WHERE userId = @userId', { userId: String(userId) })).changes || 0;
    }

    async countForUser(userId) {
        const row = await db.get('SELECT COUNT(*) AS c FROM inbox_items WHERE userId = @userId', { userId: String(userId) });
        return Number(row?.c || 0);
    }

    /** The label producers use when speaking as the assistant. */
    get assistantName() {
        return identityConfig.assistantName;
    }
}

module.exports = new InboxService();
module.exports.InboxService = InboxService;
module.exports.InboxError = InboxError;
module.exports.KINDS = KINDS;
module.exports.inboxChannelId = inboxChannelId;
module.exports.isInboxChannelId = isInboxChannelId;
module.exports.INBOX_CHANNEL_PREFIX = INBOX_CHANNEL_PREFIX;
