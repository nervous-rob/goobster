/**
 * Canonical material updates (DA-1c, ADR 0017).
 *
 * One `assistant_updates` row is one material outcome for one audience (a
 * person, or a project's members). It can belong to several components
 * (knowledge, research, projects, ...) without being duplicated, so counts
 * over components overlap and top-level counts use distinct ids.
 *
 * `publish()` is idempotent on (audience, identityKey): publishing the same
 * material state again changes nothing, and a material change bumps
 * `materialRevision` and takes a new installation-wide `sequence`. Read
 * state is per account in `assistant_update_receipts`: `deliveredRevision`
 * (a mention, an Inbox filing) and `acknowledgedRevision` (an explicit
 * acknowledgment of one exact revision) are separate, so delivery never
 * clears a highlight and an old acknowledgment never hides a new revision.
 *
 * A project-audience update (DA-11c) is read by the project's members as
 * they are now: leaving the project ends it at once, and the member's
 * receipts for the project's updates are deleted (`forgetMemberReceipts`).
 * It shows who produced it and carries no link into the producer's private
 * records. It has no Inbox envelope; its producer is told separately.
 *
 * A person-audience update has exactly one Inbox envelope (sourceType
 * `assistant_update`, sourceId `<id>:<revision>`). A new revision refreshes
 * that envelope in place; reading it acknowledges only the rendered
 * revision. Reads never acknowledge, deliver or resolve anything.
 *
 * Spec: documentation/delegated_responsibilities.md ("Updates").
 */

const crypto = require('node:crypto');
const db = require('../db');
const logger = require('../utils/logger');

const COMPONENTS = ['knowledge', 'research', 'projects', 'processes', 'conversations', 'responsibilities'];
const KINDS = ['finding', 'progress', 'process', 'question', 'responsibility'];
const ACTION_KINDS = ['open_responsibility', 'open_initiative', 'open_process', 'open_project', 'open_evidence', 'open_review', 'open_conversation'];
/** Where a member who is not the producer may be sent from a project's update. */
const SHARED_ACTIONS = ['open_project', 'open_conversation', 'open_evidence', 'open_review'];
const INBOX_SOURCE_TYPE = 'assistant_update';
const PAGE_MAX = 50;
const ACK_MAX = 100;
const COUNT_SCAN_MAX = 500;
const SEQUENCE_RETRIES = 4;

const LIMITS = { title: 200, summary: 2000, identityKey: 200, refs: 20, refId: 200 };

class AssistantUpdateError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AssistantUpdateError';
        this.code = code;
        this.status = status;
    }
}

const bad = (message, code = 'INVALID_UPDATE') => new AssistantUpdateError(code, message, 400);

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function text(value, field, max, { required = false } = {}) {
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        if (required) throw bad(`${field} is required.`);
        return null;
    }
    if (typeof value !== 'string') throw bad(`${field} must be text.`);
    const clean = value.trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function positiveId(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function refList(value, field, allowedKinds = null) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw bad(`${field} must be a list.`);
    if (value.length > LIMITS.refs) throw bad(`${field} has more than ${LIMITS.refs} entries.`);
    return value.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string' || entry.id === undefined || entry.id === null) {
            throw bad(`${field} entries are { kind, id }.`);
        }
        if (allowedKinds && !allowedKinds.includes(entry.kind)) throw bad(`${field} kind must be one of ${allowedKinds.join(', ')}.`);
        const id = String(entry.id);
        if (id.length > LIMITS.refId || entry.kind.length > 40) throw bad(`${field} entry is too long.`);
        return { kind: entry.kind, id };
    });
}

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

function fingerprintOf(material) {
    return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

/** Opaque, actor-bound page cursor over (sequence, id) under a fixed snapshot ceiling. */
function encodeCursor({ userId, sequence, id, ceiling }) {
    const tag = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
    return Buffer.from(JSON.stringify({ t: tag, s: sequence, i: id, c: ceiling })).toString('base64url');
}

function decodeCursor(cursor, userId) {
    if (!cursor) return null;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    } catch {
        throw bad('That page cursor is not valid.', 'INVALID_CURSOR');
    }
    const tag = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12);
    if (!parsed || parsed.t !== tag || !Number.isSafeInteger(parsed.s) || !Number.isSafeInteger(parsed.i) || !Number.isSafeInteger(parsed.c)) {
        throw bad('That page cursor is not valid.', 'INVALID_CURSOR');
    }
    return { sequence: parsed.s, id: parsed.i, ceiling: parsed.c };
}

class AssistantUpdateService {
    constructor() {
        this.COMPONENTS = COMPONENTS;
        this.KINDS = KINDS;
        this.INBOX_SOURCE_TYPE = INBOX_SOURCE_TYPE;
    }

    /** Projects the person can read right now (owner or member). */
    async _projectIds(userId) {
        const rows = await db.all(
            `SELECT p.id FROM observatory_projects p
             WHERE p.userId = @userId
                OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @userId)`,
            { userId: String(userId) }
        );
        return rows.map(row => Number(row.id));
    }

    _audience(audience) {
        if (!audience || typeof audience !== 'object') throw bad('audience is required.');
        if (audience.userId) {
            return { audienceKind: 'user', audienceKey: String(audience.userId), audienceUserId: String(audience.userId), projectId: null };
        }
        const projectId = positiveId(audience.projectId);
        if (projectId) return { audienceKind: 'project', audienceKey: `project:${projectId}`, audienceUserId: null, projectId };
        throw bad('audience needs a userId or a projectId.');
    }

    /** Everyone who can see this update: its person, or its project's owner and members. */
    async _audienceUserIds(row) {
        if (row.audienceKind === 'user') return row.audienceUserId ? [String(row.audienceUserId)] : [];
        const rows = await db.all(
            `SELECT userId FROM observatory_projects WHERE id = @projectId
             UNION SELECT userId FROM project_members WHERE projectId = @projectId`,
            { projectId: Number(row.projectId) }
        );
        return rows.map(member => String(member.userId));
    }

    /** Tell open portals this update changed (kinds only; see assistantLiveService). Never throws. */
    async _announce(row, kinds) {
        try {
            require('./assistantLiveService').changed(await this._audienceUserIds(row), kinds);
        } catch { /* a display signal never fails the change */ }
    }

    async _nextSequence() {
        const row = await db.get('SELECT MAX(sequence) AS top FROM assistant_updates', {});
        return Number(row?.top || 0) + 1;
    }

    /**
     * Record a material update, or confirm an unchanged one. Never throws for
     * a duplicate; a lost sequence race retries.
     *
     * @param {Object} params
     * @param {{ userId?: string, projectId?: number }} params.audience
     * @param {string} params.identityKey - stable identity, e.g. `initiative:12`
     * @param {string} params.kind - one of KINDS
     * @param {string} params.title
     * @param {string} [params.summary] - written by the producing workflow
     * @param {string[]} params.components - one or more of COMPONENTS
     * @param {{ kind: string, id: string, occurrence?: number }} [params.gate]
     * @param {boolean} [params.deliver] - file/refresh the recipient's Inbox envelope
     * @param {boolean} [params.deliverNow] - false inside a caller's transaction:
     *   the envelope stays pending until `deliverPending()` runs after commit
     * @returns {Promise<{ update: Object, changed: boolean, created: boolean }>}
     */
    async publish(params) {
        const prepared = this._prepare(params);
        let lastError = null;
        for (let attempt = 0; attempt < SEQUENCE_RETRIES; attempt += 1) {
            try {
                const result = await db.transaction(async () => this._upsert(prepared));
                if (result.changed) await this._announce(result.row, prepared.material.gate ? ['update', 'gate'] : 'update');
                if (result.changed && prepared.envelope && params.deliverNow !== false) {
                    await this.deliverPending({ id: result.row.id });
                }
                const row = await db.get('SELECT * FROM assistant_updates WHERE id = @id', { id: result.row.id });
                return { update: this.present(row, null), changed: result.changed, created: result.created };
            } catch (error) {
                if (!String(error?.message || '').includes('UNIQUE')) throw error;
                lastError = error;
            }
        }
        throw lastError;
    }

    _prepare(params = {}) {
        const audience = this._audience(params.audience);
        const identityKey = text(params.identityKey, 'identityKey', LIMITS.identityKey, { required: true });
        if (!KINDS.includes(params.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}.`);
        const components = Array.isArray(params.components) ? [...new Set(params.components)] : [];
        if (!components.length || components.some(c => !COMPONENTS.includes(c))) {
            throw bad(`components must be one or more of ${COMPONENTS.join(', ')}.`);
        }
        components.sort();
        const gate = params.gate
            ? { kind: String(params.gate.kind), id: String(params.gate.id), occurrence: Number(params.gate.occurrence) || 1 }
            : null;
        const material = {
            kind: params.kind,
            title: text(params.title, 'title', LIMITS.title, { required: true }),
            summary: text(params.summary, 'summary', LIMITS.summary),
            components,
            sourceKind: params.source?.kind ? String(params.source.kind) : null,
            sourceId: params.source?.id != null ? String(params.source.id) : null,
            sourceRevision: params.source?.revision != null ? String(params.source.revision) : null,
            evidence: refList(params.evidence, 'evidence'),
            actions: refList(params.actions, 'actions', ACTION_KINDS),
            gate
        };
        return {
            audience,
            identityKey,
            envelope: Boolean(params.deliver) && audience.audienceKind === 'user',
            material,
            fingerprint: fingerprintOf(material),
            producerUserId: params.producerUserId ? String(params.producerUserId) : null,
            responsibilityId: positiveId(params.responsibilityId),
            initiativeId: positiveId(params.initiativeId),
            happenedAt: params.happenedAt ? utcText(new Date(params.happenedAt)) : utcText()
        };
    }

    async _upsert({ audience, identityKey, envelope, material, fingerprint, producerUserId, responsibilityId, initiativeId, happenedAt }) {
        const existing = await db.get(
            'SELECT * FROM assistant_updates WHERE audienceKey = @audienceKey AND identityKey = @identityKey',
            { audienceKey: audience.audienceKey, identityKey }
        );
        const columns = {
            kind: material.kind,
            title: material.title,
            summary: material.summary,
            componentsJson: JSON.stringify(material.components),
            sourceKind: material.sourceKind,
            sourceId: material.sourceId,
            sourceRevision: material.sourceRevision,
            evidenceJson: JSON.stringify(material.evidence),
            actionsJson: JSON.stringify(material.actions),
            gateJson: material.gate ? JSON.stringify(material.gate) : null,
            responsibilityId,
            initiativeId,
            producerUserId,
            fingerprint,
            happenedAt,
            envelope: envelope ? 1 : 0
        };
        if (existing && existing.fingerprint === fingerprint) return { row: existing, changed: false, created: false };
        const sequence = await this._nextSequence();
        const now = utcText();
        if (existing) {
            const gateChanged = (existing.gateJson || null) !== columns.gateJson;
            await db.run(
                `UPDATE assistant_updates SET
                    kind = @kind, title = @title, summary = @summary, componentsJson = @componentsJson,
                    sourceKind = @sourceKind, sourceId = @sourceId, sourceRevision = @sourceRevision,
                    evidenceJson = @evidenceJson, actionsJson = @actionsJson, gateJson = @gateJson,
                    gateResolvedAt = CASE WHEN @gateChanged = 1 THEN NULL ELSE gateResolvedAt END,
                    responsibilityId = COALESCE(@responsibilityId, responsibilityId),
                    initiativeId = COALESCE(@initiativeId, initiativeId),
                    producerUserId = COALESCE(@producerUserId, producerUserId),
                    fingerprint = @fingerprint, happenedAt = @happenedAt,
                    envelopeRequested = CASE WHEN @envelope = 1 THEN 1 ELSE envelopeRequested END,
                    materialRevision = materialRevision + 1, sequence = @sequence, updatedAt = @now
                 WHERE id = @id`,
                { ...columns, gateChanged: gateChanged ? 1 : 0, sequence, now, id: existing.id }
            );
            const row = await db.get('SELECT * FROM assistant_updates WHERE id = @id', { id: existing.id });
            return { row, changed: true, created: false };
        }
        const id = await db.insert(
            `INSERT INTO assistant_updates
                (audienceKind, audienceKey, audienceUserId, projectId, producerUserId, identityKey, kind,
                 materialRevision, fingerprint, sequence, title, summary, componentsJson, responsibilityId,
                 initiativeId, sourceKind, sourceId, sourceRevision, evidenceJson, actionsJson, gateJson, happenedAt,
                 envelopeRequested)
             VALUES (@audienceKind, @audienceKey, @audienceUserId, @projectId, @producerUserId, @identityKey, @kind,
                 1, @fingerprint, @sequence, @title, @summary, @componentsJson, @responsibilityId,
                 @initiativeId, @sourceKind, @sourceId, @sourceRevision, @evidenceJson, @actionsJson, @gateJson, @happenedAt,
                 @envelope)`,
            { ...columns, ...audience, identityKey, sequence }
        );
        const row = await db.get('SELECT * FROM assistant_updates WHERE id = @id', { id });
        return { row, changed: true, created: true };
    }

    /**
     * File or refresh every owed Inbox envelope (one update, one person's, or
     * a bounded batch). Call outside a transaction: filing can contact.
     * @returns {Promise<number>} envelopes filed or refreshed
     */
    async deliverPending({ id = null, userId = null, limit = 100 } = {}) {
        const filters = ["audienceKind = 'user'", 'envelopeRequested = 1', 'envelopeRevision < materialRevision'];
        const params = { limit: Math.max(1, Math.min(500, Number(limit) || 100)) };
        if (id) {
            filters.push('id = @id');
            params.id = Number(id);
        }
        if (userId) {
            filters.push('audienceUserId = @userId');
            params.userId = String(userId);
        }
        const rows = await db.all(
            `SELECT * FROM assistant_updates WHERE ${filters.join(' AND ')} ORDER BY sequence LIMIT @limit`, params
        );
        let delivered = 0;
        for (const row of rows) {
            try {
                if (await this._deliverEnvelope(row)) delivered += 1;
            } catch (error) {
                logger.warn?.(`[assistant updates] inbox envelope failed: ${error.message}`);
            }
        }
        return delivered;
    }

    /**
     * File, or refresh in place, the recipient's single Inbox envelope for
     * this update. Filing is quiet: no browser push and no Discord echo.
     * Whether the update also leaves the portal is the responsibility's
     * interruption rule, applied by assistantDeliveryService through
     * Attention's contact path (documentation/delegated_delivery.md).
     */
    async _deliverEnvelope(row) {
        const inboxService = require('./inboxService');
        const sourceId = `${row.id}:${row.materialRevision}`;
        const link = '/home';
        let itemId = null;
        if (row.inboxItemId) {
            const refreshed = await inboxService.refreshEnvelope({
                userId: row.audienceUserId, itemId: row.inboxItemId, title: row.title, body: row.summary, sourceId
            });
            if (refreshed) itemId = row.inboxItemId;
        }
        if (!itemId) {
            const { item } = await inboxService.deliver({
                userId: row.audienceUserId,
                kind: 'notice',
                title: row.title,
                body: row.summary,
                source: { type: INBOX_SOURCE_TYPE, id: sourceId },
                link,
                dedupeKey: `assistant_update:${row.id}`,
                discord: false,
                push: false
            });
            if (!item?.id) return false;
            itemId = item.id;
        }
        await this._envelopeFiled(row, itemId);
        // An open request under an `immediate` rule is contacted about now
        // when this process sends; otherwise on the steward's next pass.
        await require('./assistantDeliveryService').contactNow({ id: row.id });
        return true;
    }

    async _envelopeFiled(row, itemId) {
        await db.run(
            `UPDATE assistant_updates SET inboxItemId = @itemId,
                envelopeRevision = CASE WHEN envelopeRevision < @revision THEN @revision ELSE envelopeRevision END
             WHERE id = @id`,
            { itemId, revision: row.materialRevision, id: row.id }
        );
        await this._recordDelivered(row.id, row.audienceUserId, row.materialRevision);
    }

    async _recordDelivered(updateId, userId, revision) {
        await db.run(
            `INSERT INTO assistant_update_receipts (updateId, userId, deliveredRevision, updatedAt)
             VALUES (@updateId, @userId, @revision, @now)
             ON CONFLICT (updateId, userId) DO UPDATE SET
                deliveredRevision = CASE WHEN excluded.deliveredRevision > assistant_update_receipts.deliveredRevision
                    THEN excluded.deliveredRevision ELSE assistant_update_receipts.deliveredRevision END,
                updatedAt = excluded.updatedAt`,
            { updateId, userId: String(userId), revision: Number(revision), now: utcText() }
        );
    }

    /** Mark a gate resolved (the domain service decided it); the update stays in history. */
    async resolveGate({ audience, identityKey }) {
        const resolved = this._audience(audience);
        const { audienceKey } = resolved;
        const result = await db.run(
            `UPDATE assistant_updates SET gateResolvedAt = @now, updatedAt = @now
             WHERE audienceKey = @audienceKey AND identityKey = @identityKey AND gateJson IS NOT NULL AND gateResolvedAt IS NULL`,
            { audienceKey, identityKey, now: utcText() }
        );
        if (result.changes > 0) await this._announce(resolved, 'gate');
        return result.changes > 0;
    }

    /**
     * @param {Object} row
     * @param {Object|null} receipt - the viewer's receipt for it
     * @param {Date} [now]
     * @param {{ viewer?: string, names?: Map<string, string> }} [view] - who is looking, and the
     *   display names of the producers of project updates
     */
    present(row, receipt, now = new Date(), view = {}) {
        const acknowledged = Number(receipt?.acknowledgedRevision || 0);
        const snoozed = Boolean(receipt?.snoozedUntil && receipt.snoozedUntil > utcText(now));
        const gate = parseJson(row.gateJson, null);
        const shared = row.audienceKind === 'project';
        // On a project's update, who produced it is shown; where it came from
        // (their responsibility, their work item) is the producer's alone.
        const own = !shared || (view.viewer != null && row.producerUserId === String(view.viewer));
        const actions = parseJson(row.actionsJson, []);
        return {
            id: Number(row.id),
            revision: Number(row.materialRevision),
            sequence: Number(row.sequence),
            kind: row.kind,
            title: row.title,
            summary: row.summary || null,
            componentIds: parseJson(row.componentsJson, []),
            audience: row.audienceKind === 'project' ? { kind: 'project', projectId: Number(row.projectId) } : { kind: 'private' },
            producer: shared
                ? { name: (row.producerUserId && view.names?.get(String(row.producerUserId))) || null, you: own }
                : null,
            responsibilityId: row.responsibilityId == null || !own ? null : Number(row.responsibilityId),
            initiativeId: row.initiativeId == null || !own ? null : Number(row.initiativeId),
            source: row.sourceKind ? { kind: row.sourceKind, id: row.sourceId, revision: row.sourceRevision || null } : null,
            evidence: parseJson(row.evidenceJson, []),
            actions: own ? actions : actions.filter(action => SHARED_ACTIONS.includes(action.kind)),
            gate: gate ? { ...gate, resolved: Boolean(row.gateResolvedAt) } : null,
            needsAction: Boolean(gate && !row.gateResolvedAt) && !snoozed,
            unseen: acknowledged < Number(row.materialRevision),
            acknowledgedRevision: acknowledged,
            deliveredRevision: Number(receipt?.deliveredRevision || 0),
            snoozedUntil: snoozed ? receipt.snoozedUntil : null,
            inboxItemId: row.audienceKind === 'user' && row.inboxItemId ? Number(row.inboxItemId) : null,
            happenedAt: row.happenedAt,
            updatedAt: row.updatedAt
        };
    }

    _visibility(userId, projectIds, alias = '') {
        const params = { userId: String(userId) };
        const clauses = [`(${alias}audienceKind = 'user' AND ${alias}audienceUserId = @userId)`];
        if (projectIds.length) {
            const names = projectIds.map((id, index) => {
                params[`p${index}`] = id;
                return `@p${index}`;
            });
            clauses.push(`(${alias}audienceKind = 'project' AND ${alias}projectId IN (${names.join(', ')}))`);
        }
        return { where: `(${clauses.join(' OR ')})`, params };
    }

    async _receipts(userId, ids) {
        if (!ids.length) return new Map();
        const params = { userId: String(userId) };
        const names = ids.map((id, index) => {
            params[`u${index}`] = id;
            return `@u${index}`;
        });
        const rows = await db.all(
            `SELECT * FROM assistant_update_receipts WHERE userId = @userId AND updateId IN (${names.join(', ')})`,
            params
        );
        return new Map(rows.map(row => [Number(row.updateId), row]));
    }

    /**
     * A page of the updates the person can see now, newest first, plus
     * distinct-id counts. A read: no acknowledgment, delivery or resolution.
     */
    async list({ userId, component = null, responsibilityId = null, cursor = null, limit = 20, now = new Date() }) {
        if (!userId) throw bad('A user id is required.');
        if (component && !COMPONENTS.includes(component)) throw bad(`component must be one of ${COMPONENTS.join(', ')}.`);
        const size = Math.max(1, Math.min(PAGE_MAX, Number(limit) || 20));
        const projectIds = await this._projectIds(userId);
        const { where, params } = this._visibility(userId, projectIds);
        const position = decodeCursor(cursor, userId);
        const ceiling = position ? position.ceiling : Number((await db.get('SELECT MAX(sequence) AS top FROM assistant_updates', {}))?.top || 0);
        const filters = [where, 'sequence <= @ceiling'];
        const query = { ...params, ceiling, limit: size + 1 };
        if (component) {
            filters.push('componentsJson LIKE @component');
            query.component = `%"${component}"%`;
        }
        const rid = positiveId(responsibilityId);
        if (rid) {
            filters.push('responsibilityId = @rid');
            query.rid = rid;
        }
        if (position) {
            filters.push('(sequence < @afterSequence OR (sequence = @afterSequence AND id < @afterId))');
            query.afterSequence = position.sequence;
            query.afterId = position.id;
        }
        const rows = await db.all(
            `SELECT * FROM assistant_updates WHERE ${filters.join(' AND ')}
             ORDER BY sequence DESC, id DESC LIMIT @limit`,
            query
        );
        const page = rows.slice(0, size);
        const receipts = await this._receipts(userId, page.map(row => Number(row.id)));
        const names = await this._producerNames(page);
        const updates = page.map(row => this.present(row, receipts.get(Number(row.id)), now, { viewer: userId, names }));
        const last = page[page.length - 1];
        return {
            asOf: new Date(now).toISOString(),
            updates,
            nextCursor: rows.length > size && last
                ? encodeCursor({ userId, sequence: Number(last.sequence), id: Number(last.id), ceiling })
                : null,
            ...(position ? {} : await this.summary({ userId, projectIds, now }))
        };
    }

    /** Distinct-id counts and per-component counts (which overlap by design). */
    async summary({ userId, projectIds = null, now = new Date() }) {
        const ids = projectIds || await this._projectIds(userId);
        const { where, params } = this._visibility(userId, ids, 'u.');
        const rows = await db.all(
            `SELECT u.id, u.materialRevision, u.componentsJson, u.gateJson, u.gateResolvedAt, u.sequence,
                    r.acknowledgedRevision, r.snoozedUntil
             FROM assistant_updates u
             LEFT JOIN assistant_update_receipts r ON r.updateId = u.id AND r.userId = @userId
             WHERE ${where}
             ORDER BY u.sequence DESC LIMIT @cap`,
            { ...params, cap: COUNT_SCAN_MAX }
        );
        const nowText = utcText(now);
        const components = new Map(COMPONENTS.map(id => [id, { id, unseen: 0, needsAction: 0, latestUpdateId: null }]));
        let unseen = 0;
        let needsAction = 0;
        for (const row of rows) {
            const isUnseen = Number(row.acknowledgedRevision || 0) < Number(row.materialRevision);
            const snoozed = Boolean(row.snoozedUntil && row.snoozedUntil > nowText);
            const isAction = Boolean(row.gateJson && !row.gateResolvedAt) && !snoozed;
            if (isUnseen) unseen += 1;
            if (isAction) needsAction += 1;
            for (const componentId of parseJson(row.componentsJson, [])) {
                const entry = components.get(componentId);
                if (!entry) continue;
                if (isUnseen) entry.unseen += 1;
                if (isAction) entry.needsAction += 1;
                if (entry.latestUpdateId === null) entry.latestUpdateId = Number(row.id);
            }
        }
        return {
            counts: { unseen, needsAction, complete: rows.length < COUNT_SCAN_MAX },
            components: [...components.values()]
        };
    }

    /**
     * Display names of the people who produced the page's project updates:
     * the name the project knows them by, then their nickname, then their
     * account name. Nobody is named from a private source.
     */
    async _producerNames(rows) {
        const wanted = [...new Set(rows.filter(row => row.audienceKind === 'project' && row.producerUserId)
            .map(row => `${row.projectId}\u0000${row.producerUserId}`))];
        const names = new Map();
        for (const key of wanted) {
            const [projectId, userId] = key.split('\u0000');
            if (names.has(userId)) continue;
            try {
                const member = await db.get(
                    'SELECT userName FROM project_members WHERE projectId = @projectId AND userId = @userId',
                    { projectId: Number(projectId), userId }
                );
                const nickname = member?.userName ? null : await db.get('SELECT nickname FROM user_nicknames WHERE userId = @userId LIMIT 1', { userId });
                const principal = member?.userName || nickname?.nickname ? null
                    : await db.get('SELECT displayName FROM principals WHERE id = @userId LIMIT 1', { userId });
                const name = member?.userName || nickname?.nickname || principal?.displayName || null;
                if (name) names.set(userId, name);
            } catch { /* a name is cosmetic: the update still shows */ }
        }
        return names;
    }

    /**
     * A person left a project (or was removed): the receipts they hold for
     * its updates go with their membership. What they could read already
     * ended with it; this is the record of having read it.
     * @returns {Promise<number>} receipts deleted
     */
    async forgetMemberReceipts({ projectId, userId }) {
        const id = positiveId(projectId);
        if (!id || !userId) return 0;
        return (await db.run(
            `DELETE FROM assistant_update_receipts
             WHERE userId = @userId
               AND updateId IN (SELECT id FROM assistant_updates WHERE audienceKind = 'project' AND projectId = @projectId)`,
            { userId: String(userId), projectId: id }
        )).changes;
    }

    /** A project is gone: so are the findings shared with it, and everyone's receipts for them. */
    async forgetProject(projectId) {
        const id = positiveId(projectId);
        if (!id) return 0;
        await db.run(
            `DELETE FROM assistant_update_receipts
             WHERE updateId IN (SELECT id FROM assistant_updates WHERE audienceKind = 'project' AND projectId = @projectId)`,
            { projectId: id }
        );
        return (await db.run(
            "DELETE FROM assistant_updates WHERE audienceKind = 'project' AND projectId = @projectId", { projectId: id }
        )).changes;
    }

    async _visibleRow(userId, id) {
        const row = await db.get('SELECT * FROM assistant_updates WHERE id = @id', { id: Number(id) });
        if (!row) return null;
        if (row.audienceKind === 'user') return row.audienceUserId === String(userId) ? row : null;
        const projects = await this._projectIds(userId);
        return projects.includes(Number(row.projectId)) ? row : null;
    }

    /**
     * The stored row of one update this person can see, or null. For
     * services that act on the update's gate (assistantGateService).
     */
    /**
     * This person's own updates for a set of identities, as they see them
     * now (receipts applied), keyed by identity. A read. Used by the
     * project board to show a project's gates as the same canonical
     * requests Home and the Inbox show.
     * @param {{ userId: string, identityKeys: string[], now?: Date }} params
     * @returns {Promise<Map<string, Object>>}
     */
    async personalByIdentity({ userId, identityKeys, now = new Date() }) {
        const keys = [...new Set((identityKeys || []).map(String))].slice(0, 200);
        if (!userId || !keys.length) return new Map();
        const params = { userId: String(userId) };
        const names = keys.map((key, index) => {
            params[`k${index}`] = key;
            return `@k${index}`;
        });
        const rows = await db.all(
            `SELECT * FROM assistant_updates
             WHERE audienceKind = 'user' AND audienceUserId = @userId AND identityKey IN (${names.join(', ')})`,
            params
        );
        const receipts = await this._receipts(userId, rows.map(row => Number(row.id)));
        return new Map(rows.map(row => [row.identityKey, this.present(row, receipts.get(Number(row.id)), now)]));
    }

    async rowFor({ userId, id }) {
        const clean = positiveId(id);
        return userId && clean ? this._visibleRow(userId, clean) : null;
    }

    /**
     * Acknowledge exact revisions. Idempotent; acknowledging an older
     * revision never clears a newer one; an id the person cannot see is
     * reported as not found, never acknowledged.
     * @param {{ userId: string, items: Array<{ id: number, revision: number }> }} params
     */
    async acknowledge({ userId, items }) {
        if (!userId) throw bad('A user id is required.');
        if (!Array.isArray(items) || !items.length) throw bad('items must list { id, revision } pairs.');
        if (items.length > ACK_MAX) throw bad(`At most ${ACK_MAX} items per acknowledgment.`);
        const results = [];
        for (const item of items) {
            const id = positiveId(item?.id);
            const revision = Number(item?.revision);
            if (!id || !Number.isSafeInteger(revision) || revision < 1) throw bad('items must list { id, revision } pairs.');
            const row = await this._visibleRow(userId, id);
            if (!row) {
                results.push({ id, status: 'not_found' });
                continue;
            }
            const acknowledged = Math.min(revision, Number(row.materialRevision));
            await db.run(
                `INSERT INTO assistant_update_receipts (updateId, userId, acknowledgedRevision, deliveredRevision, updatedAt)
                 VALUES (@updateId, @userId, @revision, @revision, @now)
                 ON CONFLICT (updateId, userId) DO UPDATE SET
                    acknowledgedRevision = CASE WHEN excluded.acknowledgedRevision > assistant_update_receipts.acknowledgedRevision
                        THEN excluded.acknowledgedRevision ELSE assistant_update_receipts.acknowledgedRevision END,
                    deliveredRevision = CASE WHEN excluded.deliveredRevision > assistant_update_receipts.deliveredRevision
                        THEN excluded.deliveredRevision ELSE assistant_update_receipts.deliveredRevision END,
                    updatedAt = excluded.updatedAt`,
                { updateId: id, userId: String(userId), revision: acknowledged, now: utcText() }
            );
            if (row.audienceKind === 'user' && row.inboxItemId && acknowledged === Number(row.materialRevision)) {
                await db.run(
                    `UPDATE inbox_items SET readAt = COALESCE(readAt, @now)
                     WHERE id = @itemId AND userId = @userId AND sourceType = @type AND sourceId = @sourceId`,
                    { itemId: row.inboxItemId, userId: String(userId), type: INBOX_SOURCE_TYPE, sourceId: `${row.id}:${row.materialRevision}`, now: utcText() }
                );
            }
            results.push({
                id,
                status: acknowledged < Number(row.materialRevision) ? 'older_revision' : 'acknowledged',
                acknowledgedRevision: acknowledged,
                currentRevision: Number(row.materialRevision)
            });
        }
        // The person's other tabs and devices drop the highlight too.
        if (results.some(result => result.status !== 'not_found')) {
            require('./assistantLiveService').changed(String(userId), 'update');
        }
        return { results };
    }

    /** Inbox read of an envelope: acknowledge exactly the revision it rendered. */
    async acknowledgeInboxRevision(userId, sourceId) {
        const match = /^(\d+):(\d+)$/.exec(String(sourceId || ''));
        if (!match) return null;
        return this.acknowledge({ userId, items: [{ id: Number(match[1]), revision: Number(match[2]) }] });
    }

    /** Record that a revision reached the person (a conversational mention); never acknowledges. */
    async markDelivered({ userId, id, revision }) {
        const row = await this._visibleRow(userId, id);
        if (!row) return false;
        await this._recordDelivered(Number(row.id), userId, Math.min(Number(revision), Number(row.materialRevision)));
        return true;
    }

    /** Hide an open gate from Needs you until `until`; it stays open. */
    async snooze({ userId, id, until }) {
        const row = await this._visibleRow(userId, id);
        if (!row) throw new AssistantUpdateError('NOT_FOUND', 'No such update.', 404);
        const date = new Date(until);
        if (Number.isNaN(date.getTime())) throw bad('until must be a timestamp.');
        await db.run(
            `INSERT INTO assistant_update_receipts (updateId, userId, snoozedUntil, updatedAt)
             VALUES (@updateId, @userId, @until, @now)
             ON CONFLICT (updateId, userId) DO UPDATE SET snoozedUntil = excluded.snoozedUntil, updatedAt = excluded.updatedAt`,
            { updateId: Number(row.id), userId: String(userId), until: utcText(date), now: utcText() }
        );
        require('./assistantLiveService').changed(String(userId), 'update');
        return true;
    }

    /**
     * Receipts for a project's updates held by someone who no longer reads
     * the project, and findings whose project is gone: the removal paths
     * delete them at once, this catches one that was missed.
     */
    async sweepProjectReceipts() {
        const receipts = (await db.run(
            `DELETE FROM assistant_update_receipts
             WHERE updateId IN (SELECT id FROM assistant_updates WHERE audienceKind = 'project')
               AND NOT EXISTS (
                   SELECT 1 FROM assistant_updates u
                   WHERE u.id = assistant_update_receipts.updateId
                     AND (EXISTS (SELECT 1 FROM observatory_projects p WHERE p.id = u.projectId AND p.userId = assistant_update_receipts.userId)
                          OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = u.projectId AND m.userId = assistant_update_receipts.userId)))`,
            {}
        )).changes;
        const orphans = await db.all(
            `SELECT id FROM assistant_updates
             WHERE audienceKind = 'project' AND NOT EXISTS (SELECT 1 FROM observatory_projects p WHERE p.id = assistant_updates.projectId)
             ORDER BY id LIMIT 1000`,
            {}
        );
        for (const { id } of orphans) {
            await db.run('DELETE FROM assistant_update_receipts WHERE updateId = @id', { id });
            await db.run('DELETE FROM assistant_updates WHERE id = @id', { id });
        }
        return receipts + orphans.length;
    }

    /** Retention: updates without an open gate untouched for `days` (receipts cascade). */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        const stale = await db.all(
            `SELECT id FROM assistant_updates
             WHERE updatedAt < @cutoff AND (gateJson IS NULL OR gateResolvedAt IS NOT NULL)
             ORDER BY id LIMIT 1000`,
            { cutoff }
        );
        let removed = 0;
        for (const { id } of stale) {
            await db.run('DELETE FROM assistant_update_receipts WHERE updateId = @id', { id });
            removed += (await db.run('DELETE FROM assistant_updates WHERE id = @id', { id })).changes;
        }
        return removed + await this.sweepProjectReceipts();
    }
}

module.exports = new AssistantUpdateService();
module.exports.AssistantUpdateService = AssistantUpdateService;
module.exports.AssistantUpdateError = AssistantUpdateError;
module.exports.COMPONENTS = COMPONENTS;
module.exports.KINDS = KINDS;
module.exports.INBOX_SOURCE_TYPE = INBOX_SOURCE_TYPE;
