/**
 * Web Push for the installed portal (documentation/pwa.md).
 *
 * A browser that opted in holds one `push_subscriptions` row. Producers do
 * not call this directly: the Inbox is the record of unattended work and
 * `inboxService.deliver()` echoes every new item here the same way it
 * echoes to Discord - the push is a pointer at the row, never the row
 * itself. Mentions and direct messages ride the same `notify()`.
 *
 * Payloads carry identity hints only (a title, a short label, a portal
 * path, a tag) - never a message body, a token or an address. A push
 * failure never breaks delivery: 404/410 prunes the device, other errors
 * count against it and land on the work ledger (`work_failures`,
 * documentation/work_ledger.md) as `PUSH_FAILED`.
 */

const db = require('../db');
const pushConfig = require('../config/pushConfig');
const { features } = require('../features/featureState');
const requireOptional = require('../utils/optionalModule').forModule(module);

/** Devices per person; the oldest unseen row is pruned past this. */
const MAX_DEVICES = 8;
/** Failures before a device is dropped without a 404/410. */
const MAX_FAILURES = 5;
const MAX_ENDPOINT = 2000;
const MAX_KEY = 300;
const MAX_TITLE = 120;
const MAX_BODY = 200;
/** How long the push service keeps an undelivered message. */
const TTL_SECONDS = 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

class PushError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'PushError';
        this.status = status;
        this.code = code;
    }
}

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const KIND_LABEL = {
    reminder: 'Reminder',
    task: 'Task finished',
    watch: 'A watch fired',
    notice: 'Something noticed',
    invite: 'Invitation',
    project: 'Project update',
    expedition: 'Research finished',
    system: 'From Goobster'
};

class PushService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.config] - pushConfig-shaped resolver (tests)
     * @param {{ sendNotification: Function }} [deps.sender] - web-push-shaped sender (tests)
     * @param {Object} [deps.logger]
     */
    constructor({ config = pushConfig, sender = null, logger = console } = {}) {
        this.PushError = PushError;
        this._config = config;
        this._sender = sender;
        this._logger = logger;
    }

    /** The legacy answer AND not enforced off by feature state (a no-op without a state file or GOOBSTER_FEATURE_PUSH). */
    get enabled() {
        return this._config.resolve().enabled && !features.enforcedOff('push');
    }

    get publicKey() {
        return this._config.resolve().publicKey;
    }

    /** What the Settings pane needs: is push available here, and how many devices this person has. */
    async describe(userId) {
        const resolved = this._config.resolve();
        const enabled = this.enabled;
        return {
            enabled,
            reason: resolved.enabled && !enabled ? 'feature-off' : resolved.reason,
            publicKey: enabled ? resolved.publicKey : null,
            devices: enabled ? await this.countForUser(userId) : 0
        };
    }

    /**
     * Keep one browser's subscription. The endpoint is the identity: the
     * same device re-subscribing (or another account signing in on it)
     * updates the row instead of adding one.
     */
    async subscribe({ userId, subscription, userAgent = null }) {
        const owner = String(userId ?? '').trim();
        if (!owner) throw new PushError(400, 'BAD_USER', 'A subscription needs an owner.');
        if (!this.enabled) throw new PushError(503, 'PUSH_DISABLED', 'Browser notifications are not available on this installation.');
        const clean = this._validate(subscription);
        const agent = userAgent ? String(userAgent).slice(0, 200) : null;
        const now = nowUtc();
        const existing = await db.get('SELECT id FROM push_subscriptions WHERE endpoint = @endpoint', { endpoint: clean.endpoint });
        if (existing) {
            await db.run(
                `UPDATE push_subscriptions
                 SET userId = @userId, p256dh = @p256dh, auth = @auth, userAgent = COALESCE(@userAgent, userAgent), lastSeenAt = @now, failCount = 0
                 WHERE id = @id`,
                { id: existing.id, userId: owner, ...clean, userAgent: agent, now }
            );
        } else {
            try {
                await db.insert(
                    `INSERT INTO push_subscriptions (userId, endpoint, p256dh, auth, userAgent, lastSeenAt)
                     VALUES (@userId, @endpoint, @p256dh, @auth, @userAgent, @now)`,
                    { userId: owner, ...clean, userAgent: agent, now }
                );
            } catch (error) {
                // Two tabs subscribed the same device at once: the second write becomes the update.
                if (!/unique|duplicate/i.test(String(error?.message))) throw error;
                await db.run(
                    `UPDATE push_subscriptions SET userId = @userId, p256dh = @p256dh, auth = @auth, lastSeenAt = @now, failCount = 0
                     WHERE endpoint = @endpoint`,
                    { userId: owner, ...clean, now }
                );
            }
            await this._trim(owner);
        }
        return { ok: true, devices: await this.countForUser(owner) };
    }

    /** Drop this device (by endpoint) or every device the person has. */
    async unsubscribe({ userId, endpoint = null, all = false }) {
        const owner = String(userId ?? '').trim();
        if (!owner) throw new PushError(400, 'BAD_USER', 'A subscription needs an owner.');
        let removed;
        if (all) {
            removed = (await db.run('DELETE FROM push_subscriptions WHERE userId = @userId', { userId: owner })).changes || 0;
        } else {
            const target = String(endpoint ?? '').trim();
            if (!target) throw new PushError(400, 'BAD_ENDPOINT', 'Say which device to remove.');
            removed = (await db.run(
                'DELETE FROM push_subscriptions WHERE userId = @userId AND endpoint = @endpoint',
                { userId: owner, endpoint: target }
            )).changes || 0;
        }
        return { removed, devices: await this.countForUser(owner) };
    }

    /** Whether a given endpoint belongs to this person (the Settings pane's "this device" check). */
    async hasEndpoint({ userId, endpoint }) {
        const row = await db.get(
            'SELECT id FROM push_subscriptions WHERE userId = @userId AND endpoint = @endpoint',
            { userId: String(userId ?? ''), endpoint: String(endpoint ?? '') }
        );
        return Boolean(row);
    }

    /**
     * Send one notification to every device the person has. Never throws.
     *
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} params.title
     * @param {string|null} [params.body] - one short line, a label not content
     * @param {string|null} [params.link] - portal path ('/activity/inbox')
     * @param {string|null} [params.tag] - same tag replaces the earlier notification
     * @param {string} [params.kind] - 'inbox' | 'mention' | 'dm' | 'test'
     * @param {string|number|null} [params.workId] - the row this push points at (ledger)
     * @returns {Promise<{ sent: number, failed: number, pruned: number, skipped: boolean }>}
     */
    async notify({ userId, title, body = null, link = null, tag = null, kind = 'inbox', workId = null }) {
        const summary = { sent: 0, failed: 0, pruned: 0, skipped: false };
        try {
            // Stored subscriptions stay (they are the person's data); nothing is sent while push is off.
            if (features.enforcedOff('push')) {
                summary.skipped = true;
                return summary;
            }
            const resolved = this._config.resolve();
            if (!resolved.enabled) {
                summary.skipped = true;
                return summary;
            }
            const owner = String(userId ?? '').trim();
            const cleanTitle = String(title ?? '').trim().slice(0, MAX_TITLE);
            if (!owner || !cleanTitle) {
                summary.skipped = true;
                return summary;
            }
            const rows = await db.all('SELECT * FROM push_subscriptions WHERE userId = @userId', { userId: owner });
            if (rows.length === 0) {
                summary.skipped = true;
                return summary;
            }
            const payload = JSON.stringify({
                title: cleanTitle,
                body: body ? String(body).trim().slice(0, MAX_BODY) : null,
                link: link ? String(link).slice(0, 500) : '/activity/inbox',
                tag: tag ? String(tag).slice(0, 100) : null,
                kind
            });
            const outcomes = await Promise.all(rows.map(row => this._sendOne(row, payload, resolved, { kind, workId })));
            for (const outcome of outcomes) summary[outcome]++;
        } catch (error) {
            this._logger.warn?.(`[push] notify failed: ${error.message}`);
        }
        return summary;
    }

    /** The Inbox echo: one push per new item, pointing back at the row. */
    async notifyInboxItem(row) {
        if (!row?.id) return { sent: 0, failed: 0, pruned: 0, skipped: true };
        return this.notify({
            userId: row.userId,
            title: row.title,
            body: KIND_LABEL[row.kind] || null,
            link: row.link || '/activity/inbox',
            tag: `inbox-${row.id}`,
            kind: 'inbox',
            workId: row.id
        });
    }

    /** A human @-mentioned this person in a shared discussion (identity hints only). */
    async notifyMention({ userId, fromName, title, conversationId, messageId = null }) {
        return this.notify({
            userId,
            title: `${fromName || 'Someone'} mentioned you`,
            body: title ? `in “${String(title).slice(0, 80)}”` : 'in a discussion',
            link: conversationId ? `/discussions/${conversationId}` : '/discussions',
            tag: messageId ? `mention-${conversationId}-${messageId}` : `mention-${conversationId}`,
            kind: 'mention',
            workId: conversationId ?? null
        });
    }

    /** A friend sent a direct message; the text stays in the thread. */
    async notifyDirectMessage({ userId, fromName, threadId }) {
        return this.notify({
            userId,
            title: fromName ? `New message from ${String(fromName).slice(0, 60)}` : 'New direct message',
            body: null,
            link: threadId ? `/people/messages/${threadId}` : '/people/messages',
            tag: `dm-${threadId}`,
            kind: 'dm',
            workId: threadId ?? null
        });
    }

    async _sendOne(row, payload, resolved, { kind, workId }) {
        const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
        try {
            await this._senderInstance().sendNotification(subscription, payload, {
                TTL: TTL_SECONDS,
                urgency: kind === 'test' ? 'normal' : 'high',
                timeout: SEND_TIMEOUT_MS,
                vapidDetails: { subject: resolved.subject, publicKey: resolved.publicKey, privateKey: resolved.privateKey }
            });
            await db.run(
                'UPDATE push_subscriptions SET lastSentAt = @now, failCount = 0 WHERE id = @id',
                { id: row.id, now: nowUtc() }
            );
            return 'sent';
        } catch (error) {
            const status = Number(error?.statusCode) || 0;
            if (status === 404 || status === 410) {
                await db.run('DELETE FROM push_subscriptions WHERE id = @id', { id: row.id });
                return 'pruned';
            }
            const failures = Number(row.failCount || 0) + 1;
            if (failures >= MAX_FAILURES) {
                await db.run('DELETE FROM push_subscriptions WHERE id = @id', { id: row.id });
            } else {
                await db.run('UPDATE push_subscriptions SET failCount = @failures WHERE id = @id', { id: row.id, failures });
            }
            // The reason is the push service's status, never the payload.
            await require('./workFailureService').note({
                kind: 'delivery',
                workId: workId ?? null,
                actor: row.userId,
                phase: 'web_push',
                code: 'PUSH_FAILED',
                reason: status ? `HTTP ${status}` : String(error?.code || error?.message || 'unknown').slice(0, 120)
            });
            return failures >= MAX_FAILURES ? 'pruned' : 'failed';
        }
    }

    _senderInstance() {
        if (!this._sender) this._sender = requireOptional('web-push', { feature: 'push' });
        if (!this._sender) throw new Error('Web Push delivery is not installed on this instance.');
        return this._sender;
    }

    _validate(subscription) {
        const endpoint = String(subscription?.endpoint ?? '').trim();
        let parsed;
        try {
            parsed = new URL(endpoint);
        } catch {
            parsed = null;
        }
        if (!parsed || parsed.protocol !== 'https:' || endpoint.length > MAX_ENDPOINT) {
            throw new PushError(400, 'BAD_ENDPOINT', 'The push endpoint must be an https URL.');
        }
        const p256dh = String(subscription?.keys?.p256dh ?? '').trim();
        const auth = String(subscription?.keys?.auth ?? '').trim();
        const keyShape = /^[A-Za-z0-9_-]+=*$/;
        if (!p256dh || !auth || p256dh.length > MAX_KEY || auth.length > MAX_KEY || !keyShape.test(p256dh) || !keyShape.test(auth)) {
            throw new PushError(400, 'BAD_KEYS', 'The subscription keys are missing or malformed.');
        }
        return { endpoint, p256dh, auth };
    }

    /** Keep the newest MAX_DEVICES rows per person. */
    async _trim(userId) {
        const rows = await db.all(
            `SELECT id FROM push_subscriptions WHERE userId = @userId
             ORDER BY COALESCE(lastSeenAt, createdAt) DESC, id DESC`,
            { userId }
        );
        for (const row of rows.slice(MAX_DEVICES)) {
            await db.run('DELETE FROM push_subscriptions WHERE id = @id', { id: row.id });
        }
    }

    // --- Privacy ------------------------------------------------------------

    async forgetUser(userId, handle = db) {
        if (!userId) return 0;
        return (await handle.run('DELETE FROM push_subscriptions WHERE userId = @userId', { userId: String(userId) })).changes || 0;
    }

    async countForUser(userId) {
        const row = await db.get('SELECT COUNT(*) AS c FROM push_subscriptions WHERE userId = @userId', { userId: String(userId ?? '') });
        return Number(row?.c || 0);
    }
}

module.exports = new PushService();
module.exports.PushService = PushService;
module.exports.PushError = PushError;
module.exports.MAX_DEVICES = MAX_DEVICES;
module.exports.MAX_FAILURES = MAX_FAILURES;
module.exports.KIND_LABEL = KIND_LABEL;
