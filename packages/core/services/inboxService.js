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
const activityCorrelation = require('./activityCorrelation');
const { toGateway } = require('../gateway');
const identityConfig = require('../config/identityConfig');
const logger = require('../utils/logger');
const requireOptional = require('../utils/optionalModule').forModule(module);

const KINDS = ['reminder', 'task', 'watch', 'notice', 'invite', 'project', 'expedition', 'system'];
const MAX_TITLE = 200;
const MAX_BODY = 16_000;
const MAX_LIST = 100;
/** sourceType of a canonical assistant update's envelope (services/assistantUpdateService.js). */
const ASSISTANT_UPDATE_SOURCE = 'assistant_update';

const VIEWS = ['all', 'needs_you', 'updates', 'snoozed'];

function utcNow() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/*
 * Needs you is a filter over Inbox items, decided by the domain record each
 * item references (never by read state or wording):
 *  - an assistant update whose gate is open (and, for the default view, not
 *    snoozed by this person);
 *  - the host's copy of a pending access request;
 *  - the addressee's copy of a pending friend request.
 * Table and column names are literals; `i` is inbox_items, `@now` UTC text.
 */
const OPEN_UPDATE_GATE = (snoozed) => `(i.sourceType = 'assistant_update' AND EXISTS (
    SELECT 1 FROM assistant_updates u
    WHERE u.inboxItemId = i.id AND u.audienceKind = 'user' AND u.audienceUserId = i.userId
      AND u.gateJson IS NOT NULL AND u.gateResolvedAt IS NULL
      AND ${snoozed ? '' : 'NOT '}EXISTS (
        SELECT 1 FROM assistant_update_receipts r
        WHERE r.updateId = u.id AND r.userId = i.userId AND r.snoozedUntil IS NOT NULL AND r.snoozedUntil > @now)))`;
const OPEN_ACCESS_GATE = `(i.sourceType = 'access_request' AND EXISTS (
    SELECT 1 FROM access_requests a
    WHERE CAST(a.id AS TEXT) = i.sourceId AND a.status = 'pending' AND a.principalId <> i.userId))`;
const OPEN_FRIEND_GATE = `(i.sourceType = 'friend_request' AND EXISTS (
    SELECT 1 FROM friendships f
    WHERE CAST(f.id AS TEXT) = i.sourceId AND f.status = 'pending' AND f.addresseeId = i.userId))`;
const NEEDS_YOU_SQL = `(${OPEN_UPDATE_GATE(false)} OR ${OPEN_ACCESS_GATE} OR ${OPEN_FRIEND_GATE})`;
const SNOOZED_SQL = OPEN_UPDATE_GATE(true);
/** Informational: not a request at all, open or resolved. */
const INFORMATIONAL_SQL = `(i.sourceType IS NULL OR (i.sourceType NOT IN ('access_request', 'friend_request')
    AND NOT (i.sourceType = 'assistant_update' AND EXISTS (
        SELECT 1 FROM assistant_updates u WHERE u.inboxItemId = i.id AND u.gateJson IS NOT NULL))))`;
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
     * @param {string} [params.link] - portal path (e.g. '/activity/scheduled'); legacy paths stay valid through the client's aliases
     * @param {Array<{ url: string, name: string }>} [params.attachments]
     * @param {string} [params.dedupeKey] - same key twice = one item
     * @param {Object|false} [params.discord] - `{ gateway, discordUserId?, payload? }`
     *   to also DM the person; omit/false to keep the result in-app only.
     *   `discordUserId` defaults to the principal's Discord subject. Pass
     *   `{ status: 'sent' | 'failed', error? }` when the producer already
     *   delivered through Discord itself and only wants that recorded.
     * @param {boolean} [params.push] - `false` files the item without the
     *   browser push: for a producer whose outbound contact is decided
     *   somewhere else (delegated work, documentation/delegated_delivery.md).
     * @returns {Promise<{ item: Object, created: boolean, discord: { status: string, error: string|null } }>}
     */
    async deliver({
        userId, kind, title, body = null, source = null, link = null,
        attachments = null, dedupeKey = null, discord = false, push: pushEcho = true
    }) {
        const owner = String(userId ?? '').trim();
        if (!owner) throw new InboxError(400, 'BAD_USER', 'An inbox item needs an owner.');
        if (!KINDS.includes(kind)) throw new InboxError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}.`);
        const cleanTitle = String(title ?? '').trim().slice(0, MAX_TITLE);
        if (!cleanTitle) throw new InboxError(400, 'BAD_TITLE', 'An inbox item needs a title.');
        const cleanBody = body == null ? null : String(body).slice(0, MAX_BODY);
        const files = await this._retainAttachments(attachments, owner);

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
        // The browser echo (documentation/pwa.md): a push that points at
        // the row, to every device the person enrolled. Like the Discord
        // echo it is bookkeeping around the item, never the record.
        let push = { sent: 0, failed: 0, pruned: 0, skipped: true };
        if (created && pushEcho !== false) {
            try {
                push = await require('./pushService').notifyInboxItem(row);
            } catch { /* never throws, belt and braces */ }
        }
        return { item: await this._publicItem(row), created, discord: echo, push };
    }

    /**
     * Echo an item that is already in the Inbox: the Discord DM and the
     * browser push `deliver()` would have sent when it filed the row. For
     * an item filed quietly (`push: false`, no `discord`) whose producer
     * later decides it may leave the portal. Changes nothing about the item
     * but its Discord bookkeeping, and never throws.
     * @returns {Promise<{ item: Object|null, discord: { status: string, error: string|null }, push: Object }>}
     */
    async echo({ userId, itemId, discord = false, push: pushEcho = true }) {
        let push = { sent: 0, failed: 0, pruned: 0, skipped: true };
        const row = await db.get(
            'SELECT * FROM inbox_items WHERE id = @id AND userId = @userId AND archivedAt IS NULL',
            { id: Number(itemId), userId: String(userId ?? '') }
        );
        if (!row) return { item: null, discord: { status: 'skipped', error: 'no item' }, push };
        const echo = discord
            ? await this._echoToDiscord(row, discord)
            : { status: row.discordStatus, error: row.discordError || null };
        if (pushEcho !== false) {
            try {
                push = await require('./pushService').notifyInboxItem(row);
            } catch { /* never throws, belt and braces */ }
        }
        return { item: { id: row.id }, discord: echo, push };
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
        if (reason === 'DISCORD_DISABLED') return finish('skipped', reason);
        // The item exists, so the work is done; the echo that did not reach
        // Discord is still a failed delivery on the ledger
        // (documentation/work_ledger.md) - the reason is the gateway's
        // error, never the item's title or body.
        await require('./workFailureService').note({
            kind: 'delivery',
            workId: row.id,
            actor: row.userId,
            phase: 'discord_echo',
            code: 'DISCORD_ECHO_FAILED',
            reason
        });
        return finish('failed', reason);
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

    /** Only registry ownership can authorize a path; ignore caller-supplied references. */
    async _retainAttachments(attachments, userId) {
        if (!Array.isArray(attachments) || attachments.length === 0) return [];
        const webChatService = require('./webChatService');
        const retained = [];
        for (const attachment of Array.isArray(attachments) ? attachments : []) {
            if (typeof attachment?.url !== 'string') continue;
            const file = await webChatService.getFileReference(attachment.url, userId);
            retained.push({ url: attachment.url, name: attachment.name || null, ...(file ? { file } : {}) });
        }
        return retained;
    }

    /** Rebuild expiring download URLs without exposing the stored local paths. */
    async _attachmentsForItem(row) {
        if (!row.attachmentsJson) return [];
        const webChatService = require('./webChatService');
        const stored = [];
        const visible = [];
        for (const attachment of this._parseAttachments(row.attachmentsJson)) {
            if (typeof attachment?.url !== 'string') continue;
            // Older rows contain only a URL. Recover its path while the
            // owner-bound registry entry still exists, even after its TTL.
            const file = attachment.file?.userId === row.userId && typeof attachment.file.path === 'string'
                ? attachment.file
                : await webChatService.getFileReference(attachment.url, row.userId);
            const registered = file ? await webChatService.restoreFileReference(file, row.userId) : null;
            const publicFile = { url: registered?.url || attachment.url, name: attachment.name || registered?.name || null };
            visible.push(publicFile);
            stored.push({ ...publicFile, ...(file ? { file } : {}) });
        }
        const json = JSON.stringify(stored);
        if (json !== row.attachmentsJson) {
            await db.run(
                'UPDATE inbox_items SET attachmentsJson = @json WHERE id = @id AND userId = @userId',
                { json, id: row.id, userId: row.userId }
            );
        }
        return visible;
    }

    /**
     * The work_failures rows behind the failure items in a page, keyed by
     * row id; only the owner's rows resolve (the item and the row share
     * an actor). An item whose row has been pruned keeps its text and
     * shows no detail.
     */
    async _failuresByIdForRows(rows) {
        const workFailureService = require('./workFailureService');
        const owners = new Map();
        for (const row of rows) {
            if (row.sourceType !== workFailureService.INBOX_SOURCE_TYPE || row.sourceId == null) continue;
            if (!owners.has(row.userId)) owners.set(row.userId, []);
            owners.get(row.userId).push(row.sourceId);
        }
        const map = new Map();
        for (const [userId, ids] of owners) {
            for (const failure of await workFailureService.getManyForUser(ids, userId)) {
                map.set(String(failure.id), failure);
            }
        }
        return map;
    }

    _presentFailure(row, failureById) {
        const workFailureService = require('./workFailureService');
        if (row.sourceType !== workFailureService.INBOX_SOURCE_TYPE) return null;
        const failure = failureById.get(String(row.sourceId));
        if (!failure) return { id: Number(row.sourceId) || null, kind: null, code: null, phase: null, reason: null, workId: null, createdAt: null };
        return {
            id: Number(failure.id),
            kind: failure.kind,
            code: failure.code,
            phase: failure.phase || null,
            reason: failure.reason || null,
            workId: failure.workId || null,
            createdAt: failure.createdAt
        };
    }

    /**
     * The access requests behind the items in a page (an operator's "X is
     * asking to join" and the requester's outcome), keyed by sourceId.
     */
    async _accessByIdForRows(rows) {
        const accessRequests = require('./accessRequestService');
        if (!rows.some(row => row.sourceType === accessRequests.SOURCE_TYPE)) return new Map();
        return accessRequests.describeForRows(rows);
    }

    _presentAccess(row, accessById) {
        const accessRequests = require('./accessRequestService');
        if (row.sourceType !== accessRequests.SOURCE_TYPE) return null;
        const request = accessById.get(String(row.sourceId));
        // The request row is gone (the person was erased): the words stay,
        // there is nothing left to act on.
        if (!request) return null;
        return {
            id: request.id,
            status: request.status,
            principalId: request.principalId,
            displayName: request.displayName,
            // Only the host's own copy is actionable; the requester's
            // outcome notice never offers Approve / Decline.
            actionable: request.status === 'pending' && request.principalId !== row.userId,
            resolvedByName: request.resolvedByName,
            resolvedAt: request.resolvedAt
        };
    }

    /**
     * The friend requests behind the items in a page (the addressee's "X
     * wants to be friends" and the requester's acceptance), keyed by sourceId.
     */
    async _friendByIdForRows(rows) {
        const friendService = require('./friendService');
        if (!rows.some(row => row.sourceType === friendService.SOURCE_TYPE)) return new Map();
        return friendService.describeForRows(rows);
    }

    _presentFriend(row, friendById) {
        const friendService = require('./friendService');
        if (row.sourceType !== friendService.SOURCE_TYPE) return null;
        const request = friendById.get(String(row.sourceId));
        // The request row is gone (someone was erased): the words stay.
        if (!request) return null;
        return {
            id: request.id,
            status: request.status,
            requesterId: request.requesterId,
            requesterName: request.requesterName,
            requesterAvatar: request.requesterAvatar,
            addresseeId: request.addresseeId,
            addresseeName: request.addresseeName,
            // Only the addressee's copy offers Accept / Decline, and only
            // while the request is still open.
            actionable: request.status === 'pending' && request.addresseeId === row.userId,
            respondedAt: request.respondedAt
        };
    }

    /**
     * The canonical assistant updates behind the items in a page, keyed by
     * inbox item id, with this person's receipt (delegated_responsibilities.md,
     * "Updates"). The update row owns the gate; the item is its envelope.
     */
    async _updatesByItemForRows(rows, userId) {
        const ids = rows.filter(row => row.sourceType === ASSISTANT_UPDATE_SOURCE).map(row => Number(row.id));
        const map = new Map();
        if (!ids.length) return map;
        const params = { userId: String(userId) };
        const marks = ids.map((id, index) => { params[`i${index}`] = id; return `@i${index}`; });
        const found = await db.all(
            `SELECT u.id, u.inboxItemId, u.materialRevision, u.componentsJson, u.gateJson, u.gateResolvedAt,
                    u.actionsJson, u.responsibilityId, u.initiativeId,
                    r.acknowledgedRevision, r.snoozedUntil
             FROM assistant_updates u
             LEFT JOIN assistant_update_receipts r ON r.updateId = u.id AND r.userId = @userId
             WHERE u.audienceKind = 'user' AND u.audienceUserId = @userId AND u.inboxItemId IN (${marks.join(', ')})`,
            params
        );
        for (const row of found) map.set(Number(row.inboxItemId), row);
        return map;
    }

    _presentUpdate(row, updateByItem, nowText) {
        const update = updateByItem?.get(Number(row.id));
        if (!update) return null;
        const parse = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
        const gate = parse(update.gateJson, null);
        const snoozed = Boolean(update.snoozedUntil && update.snoozedUntil > nowText);
        return {
            id: Number(update.id),
            revision: Number(update.materialRevision),
            componentIds: parse(update.componentsJson, []),
            actions: parse(update.actionsJson, []),
            responsibilityId: update.responsibilityId == null ? null : Number(update.responsibilityId),
            initiativeId: update.initiativeId == null ? null : Number(update.initiativeId),
            unseen: Number(update.acknowledgedRevision || 0) < Number(update.materialRevision),
            gate: gate ? { ...gate, resolved: Boolean(update.gateResolvedAt) } : null,
            gateOpen: Boolean(gate && !update.gateResolvedAt),
            snoozedUntil: snoozed ? update.snoozedUntil : null
        };
    }

    /** The open decision card for an item whose request is still waiting on this person. */
    async _decisionFor(row, update) {
        const gates = requireOptional('./assistantGateService', { feature: 'assistant' });
        if (!gates) return null;
        return gates.cardForInboxItem({ userId: row.userId, item: row, update });
    }

    async _publicItem(row, noticeById = null, failureById = null, accessById = null, friendById = null, updateByItem = null) {
        let attention = null;
        if (row.sourceType === activityCorrelation.SOURCE_TYPE) {
            const map = noticeById || await activityCorrelation.noticesByIdForRows([row]);
            attention = activityCorrelation.presentDelivery(row, map);
        }
        const failure = this._presentFailure(row, failureById || await this._failuresByIdForRows([row]));
        const access = this._presentAccess(row, accessById || await this._accessByIdForRows([row]));
        const friend = this._presentFriend(row, friendById || await this._friendByIdForRows([row]));
        const update = this._presentUpdate(row, updateByItem || await this._updatesByItemForRows([row], row.userId), utcNow());
        const decision = (update?.gateOpen || access?.actionable || friend?.actionable)
            ? await this._decisionFor(row, update)
            : null;
        return {
            id: row.id,
            kind: row.kind,
            title: row.title,
            body: row.body || null,
            source: row.sourceType ? { type: row.sourceType, id: row.sourceId } : null,
            link: row.link || null,
            // The notices this row delivered, when it is an attention contact.
            // Null for every other kind. Read and archive stay on this row;
            // the notice statuses are visible here and are not actions.
            attention,
            // The work_failures row this item reports, when it is a failure
            // notice (documentation/work_ledger.md). Null for every other item.
            failure,
            // The access request this item is about (documentation/identity.md,
            // "Asking to join"): the host's copy is actionable while pending.
            access,
            // The friend request this item is about (documentation/
            // friends_and_messages.md): the addressee's copy is actionable
            // while pending.
            friend,
            // The canonical assistant update this item is the envelope of
            // (its gate, components and this person's receipt), or null.
            update,
            // Needs you: a typed, still-open request for THIS person. Derived
            // from the domain record, never from read state. A snoozed gate
            // is still open; it only leaves the default Needs-you view.
            needsAction: Boolean((update?.gateOpen && !update.snoozedUntil) || access?.actionable || friend?.actionable),
            // What this person can decide right here, when the request's kind
            // has a decision descriptor (assistantGateService): the options,
            // what each changes, and the occurrence and revision a decision
            // must carry. Null when the request is decided where it lives, is
            // settled, or the Delegated assistant feature is off.
            decision,
            ask: await require('./conversationContextService').describeItem(row),
            attachments: await this._attachmentsForItem(row),
            read: Boolean(row.readAt),
            archived: Boolean(row.archivedAt),
            discord: { status: row.discordStatus, error: row.discordError || null, sentAt: row.discordSentAt || null },
            createdAt: row.createdAt
        };
    }

    // --- Reading ------------------------------------------------------------

    /**
     * `view` selects one of the Inbox's filters over the same items:
     *  - `all` (default): open items, or the archive with `archived`;
     *  - `needs_you`: items whose typed gate is still open for this person
     *    and not snoozed. Archived items stay here while their gate is open,
     *    so archiving can never hide an unresolved request;
     *  - `snoozed`: open gates this person snoozed;
     *  - `updates`: informational items (no gate, open or resolved).
     * A read: it never marks anything read, delivered or resolved.
     * @param {Object} params - { userId, view?, unread?, archived?, limit?, cursor? }
     * @returns {Promise<{ items: Object[], unread: number, needsYou: number, view: string, nextCursor: string|null }>}
     */
    async list({ userId, view = 'all', unread = false, archived = false, limit = 50, cursor = null }) {
        if (!VIEWS.includes(view)) throw new InboxError(400, 'BAD_VIEW', `view must be one of ${VIEWS.join(', ')}.`);
        const bounded = Math.max(1, Math.min(Math.trunc(Number(limit)) || 50, MAX_LIST));
        const params = { userId: String(userId) };
        const where = ['i.userId = @userId'];
        if (view === 'needs_you' || view === 'snoozed') {
            params.now = utcNow();
            where.push(view === 'needs_you' ? NEEDS_YOU_SQL : SNOOZED_SQL);
        } else {
            where.push(archived ? 'i.archivedAt IS NOT NULL' : 'i.archivedAt IS NULL');
            if (view === 'updates') where.push(INFORMATIONAL_SQL);
        }
        if (unread) where.push('i.readAt IS NULL');
        if (cursor != null && cursor !== '') {
            const id = Number(cursor);
            if (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(id) || id < 1) {
                throw new InboxError(400, 'BAD_CURSOR', 'Invalid inbox page cursor.');
            }
            // Resolve the ordering key within this person's inbox. The row
            // can have changed read/archive state since the previous page.
            const boundary = await db.get(
                'SELECT id, createdAt FROM inbox_items WHERE id = @id AND userId = @userId',
                { id, userId: params.userId }
            );
            if (!boundary) throw new InboxError(400, 'BAD_CURSOR', 'Invalid inbox page cursor.');
            params.beforeTime = boundary.createdAt;
            params.beforeId = boundary.id;
            where.push('(i.createdAt < @beforeTime OR (i.createdAt = @beforeTime AND i.id < @beforeId))');
        }
        const rows = await db.all(
            `SELECT i.* FROM inbox_items i WHERE ${where.join(' AND ')}
             ORDER BY i.createdAt DESC, i.id DESC LIMIT ${bounded + 1}`,
            params
        );
        const page = rows.slice(0, bounded);
        const noticeById = await activityCorrelation.noticesByIdForRows(page);
        const failureById = await this._failuresByIdForRows(page);
        const accessById = await this._accessByIdForRows(page);
        const friendById = await this._friendByIdForRows(page);
        const updateByItem = await this._updatesByItemForRows(page, userId);
        return {
            view,
            items: await Promise.all(page.map(row => this._publicItem(row, noticeById, failureById, accessById, friendById, updateByItem))),
            unread: await this.unreadCount(userId),
            // A separate, differently-labelled count: never added to `unread`.
            needsYou: await this.needsYouCount(userId),
            nextCursor: rows.length > bounded ? String(page[page.length - 1].id) : null
        };
    }

    /** Open, unsnoozed requests for this person (the Needs-you view's size). */
    async needsYouCount(userId) {
        const row = await db.get(
            `SELECT COUNT(*) AS c FROM inbox_items i WHERE i.userId = @userId AND ${NEEDS_YOU_SQL}`,
            { userId: String(userId), now: utcNow() }
        );
        return Number(row?.c || 0);
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
        if (read) await this._acknowledgeCanonical(userId, [itemId]);
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
        const canonical = await db.all(
            `SELECT id FROM inbox_items
             WHERE userId = @userId AND readAt IS NULL AND archivedAt IS NULL AND sourceType = @type`,
            { userId: String(userId), type: ASSISTANT_UPDATE_SOURCE }
        );
        await this._acknowledgeCanonical(userId, canonical.map(row => row.id));
        const result = await db.run(
            'UPDATE inbox_items SET readAt = @now WHERE userId = @userId AND readAt IS NULL AND archivedAt IS NULL',
            { userId: String(userId), now: nowUtc() }
        );
        eventBus.publish('inbox', { userId: String(userId) });
        return { updated: result.changes || 0 };
    }

    /**
     * Reading the envelope of a canonical assistant update acknowledges
     * exactly the revision it rendered (its sourceId is `<id>:<revision>`),
     * never a later one. Best effort: the read itself always proceeds.
     */
    async _acknowledgeCanonical(userId, itemIds) {
        if (!itemIds.length) return;
        const updates = requireOptional('./assistantUpdateService', { feature: 'assistant' });
        if (!updates) return;
        for (const itemId of itemIds) {
            try {
                const row = await db.get(
                    'SELECT sourceType, sourceId FROM inbox_items WHERE id = @id AND userId = @userId',
                    { id: Number(itemId), userId: String(userId) }
                );
                if (row?.sourceType === ASSISTANT_UPDATE_SOURCE) await updates.acknowledgeInboxRevision(String(userId), row.sourceId);
            } catch (error) {
                logger.warn?.(`[inbox] canonical acknowledgment failed: ${error.message}`);
            }
        }
    }

    /**
     * Re-open one canonical update's envelope for its new revision instead of
     * filing a second item. Returns false when the envelope is gone.
     */
    async refreshEnvelope({ userId, itemId, title, body = null, sourceId }) {
        const result = await db.run(
            `UPDATE inbox_items
             SET title = @title, body = @body, sourceId = @sourceId, readAt = NULL, archivedAt = NULL
             WHERE id = @id AND userId = @userId AND sourceType = @type`,
            {
                id: Number(itemId),
                userId: String(userId),
                title: String(title ?? '').trim().slice(0, MAX_TITLE),
                body: body == null ? null : String(body).slice(0, MAX_BODY),
                sourceId: String(sourceId),
                type: ASSISTANT_UPDATE_SOURCE
            }
        );
        if (result.changes) eventBus.publish('inbox', { userId: String(userId), itemId: Number(itemId) });
        return result.changes > 0;
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
