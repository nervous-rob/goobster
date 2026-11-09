/**
 * Opportunities and durable source cursors (DA-1b, ADR 0017).
 *
 * An initiative is one attempt at advancing an active responsibility,
 * derived from a change in a source the responsibility links to (its
 * Attention item, its project plan). It is an attempt, not another goal
 * list. Nothing here runs work: DA-3's runner will claim QUEUED attempts.
 *
 * Reliability comes from durable state, not events:
 *  - `reconcile()` reads each linked source's current material state and
 *    compares it with `assistant_source_cursors`. The first scan after
 *    activation records a baseline and proposes nothing (history is
 *    evidence, not new orders). A later change proposes one candidate and
 *    advances the cursor in the same transaction, so a crash between the
 *    two re-proposes (deduplicated) instead of losing the change.
 *  - domain events are hints that schedule an early reconcile for the
 *    owner. Missing a hint delays a candidate until the next periodic
 *    pass; it never loses one.
 *  - (responsibility, dedupeKey, sourceRevision, attempt) is unique, so
 *    repeated hints and rescans produce one opportunity per source change.
 *
 * Authority: candidates are derived only for ACTIVE, unexpired grants whose
 * owner has Attention enabled. `claim()` re-checks the grant at the moment a
 * worker takes the attempt and fences the attempt with a lease token. A
 * responsibility that ends cancels its open attempts in the same
 * transaction as the status change (`onResponsibilityChanged`).
 *
 * Spec: documentation/delegated_responsibilities.md ("Initiatives").
 */

const crypto = require('node:crypto');
const db = require('../db');
const { features } = require('../features/featureState');
const attentionPolicyService = require('./attentionPolicyService');

const STATUSES = ['CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'];
const OPEN_STATUSES = ['CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW'];
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'];
const WAIT_REASONS = ['dependency', 'budget', 'user_question', 'access', 'responsibility'];
const OUTCOMES = ['DONE', 'NO_ACTION', 'ALREADY_KNOWN', 'NO_CHANGE'];
const HUMAN_ACTIONS = ['queue', 'cancel', 'retry', 'accept', 'reject'];
const LEASE_MS = 10 * 60 * 1000;
const MAX_DEPTH = 3;
const RECONCILE_BATCH = 50;
const LIST_MAX = 100;

class AssistantInitiativeError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = 'AssistantInitiativeError';
        this.code = code;
        this.status = status;
        if (details) this.details = details;
    }
}

const notFound = () => new AssistantInitiativeError('NOT_FOUND', 'No such initiative.', 404);

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function fingerprint(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

/**
 * Source adapters: each reads the CURRENT material state of one linked
 * record and returns a revision fingerprint plus deterministic text. The
 * text names the record; it never copies private content.
 */
const SOURCES = {
    attention_item: {
        async read(responsibility) {
            if (!responsibility.attentionItemId) return [];
            const item = await db.get(
                `SELECT id, userId, state, goal, unresolved, deadlineAt, kind
                 FROM attention_items WHERE id = @id`,
                { id: responsibility.attentionItemId }
            );
            if (!item || item.userId !== responsibility.ownerUserId) return [];
            return [{
                sourceId: String(item.id),
                revision: fingerprint([item.state, item.goal, item.unresolved, item.deadlineAt]),
                title: `Linked ${String(item.kind || 'goal').replace(/_/g, ' ')} changed`,
                reason: item.state === 'resolved' ? 'resolved' : 'changed',
                category: 'attention'
            }];
        }
    },
    project_plan: {
        feature: 'projects',
        async read(responsibility) {
            if (!responsibility.planId || !responsibility.projectId) return [];
            const plan = await db.get(
                'SELECT id, projectId, status, planRevision FROM project_missions WHERE id = @id',
                { id: responsibility.planId }
            );
            if (!plan || Number(plan.projectId) !== Number(responsibility.projectId)) return [];
            return [{
                sourceId: String(plan.id),
                revision: `${plan.planRevision}:${plan.status}`,
                title: 'Linked project plan changed',
                reason: String(plan.status || '').toLowerCase(),
                category: 'project'
            }];
        }
    }
};

class AssistantInitiativeService {
    constructor() {
        this.STATUSES = STATUSES;
        this.HUMAN_ACTIONS = HUMAN_ACTIONS;
        this.SOURCE_KINDS = Object.keys(SOURCES);
        this._hinted = new Set();
        this._hintTimer = null;
        this._unsubscribe = null;
    }

    _responsibilities() {
        return require('./assistantResponsibilityService');
    }

    present(row) {
        if (!row) return null;
        return {
            id: Number(row.id),
            responsibilityId: Number(row.responsibilityId),
            responsibilityRevision: Number(row.responsibilityRevision),
            ownerUserId: row.ownerUserId,
            actingUserId: row.actingUserId || null,
            audience: row.audience,
            projectId: row.projectId == null ? null : Number(row.projectId),
            source: { kind: row.sourceKind, id: row.sourceId, revision: row.sourceRevision },
            dedupeKey: row.dedupeKey,
            attempt: Number(row.attempt),
            title: row.title,
            reason: row.reason || null,
            status: row.status,
            waitReason: row.waitReason || null,
            outcome: row.outcome || null,
            stopCode: row.stopCode || null,
            revision: Number(row.revision),
            leased: Boolean(row.leaseToken),
            leaseExpiresAt: row.leaseExpiresAt || null,
            parentInitiativeId: row.parentInitiativeId == null ? null : Number(row.parentInitiativeId),
            depth: Number(row.depth || 0),
            recheckAfter: row.recheckAfter || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            endedAt: row.endedAt || null
        };
    }

    async _row(id) {
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n <= 0) return null;
        return db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id: n });
    }

    async get({ userId, id }) {
        const row = await this._row(id);
        if (!row || row.ownerUserId !== String(userId)) throw notFound();
        return this.present(row);
    }

    async list({ userId, responsibilityId = null, status = null, limit = 50 }) {
        if (status && !STATUSES.includes(status)) {
            throw new AssistantInitiativeError('INVALID_STATUS', `status must be one of ${STATUSES.join(', ')}.`);
        }
        const params = { userId: String(userId), limit: Math.max(1, Math.min(LIST_MAX, Number(limit) || 50)) };
        const filters = ['ownerUserId = @userId'];
        if (responsibilityId) {
            filters.push('responsibilityId = @rid');
            params.rid = Number(responsibilityId);
        }
        if (status) {
            filters.push('status = @status');
            params.status = status;
        }
        const rows = await db.all(
            `SELECT * FROM assistant_initiatives WHERE ${filters.join(' AND ')} ORDER BY id DESC LIMIT @limit`,
            params
        );
        return { initiatives: rows.map(row => this.present(row)) };
    }

    /** Is this grant one we may derive work for right now? */
    async _grantLive(responsibility, now = new Date()) {
        if (features.enforcedOff('assistant')) return false;
        const presented = this._responsibilities().present(responsibility, now);
        if (!presented || presented.status !== 'ACTIVE') return false;
        const policy = await attentionPolicyService.get(responsibility.ownerUserId);
        return Boolean(policy?.enabled);
    }

    /**
     * Propose one opportunity. Idempotent on (responsibility, dedupeKey,
     * sourceRevision, attempt 1); an older open attempt at the same
     * opportunity is superseded. Must run inside a transaction.
     */
    async _propose(responsibility, source, sourceKind) {
        const dedupeKey = `${sourceKind}:${source.sourceId}`;
        const existing = await db.get(
            `SELECT * FROM assistant_initiatives
             WHERE responsibilityId = @rid AND dedupeKey = @dedupeKey AND sourceRevision = @revision AND attempt = 1`,
            { rid: responsibility.id, dedupeKey, revision: source.revision }
        );
        if (existing) return { initiative: existing, created: false };
        await db.run(
            `UPDATE assistant_initiatives
             SET status = 'SUPERSEDED', stopCode = 'NEWER_SOURCE_REVISION', leaseToken = NULL, leaseExpiresAt = NULL,
                 revision = revision + 1, endedAt = @now, updatedAt = @now
             WHERE responsibilityId = @rid AND dedupeKey = @dedupeKey AND status IN ('CANDIDATE', 'QUEUED', 'WAITING')`,
            { rid: responsibility.id, dedupeKey, now: utcText() }
        );
        const scopes = (() => { try { return JSON.parse(responsibility.scopesJson || '{}'); } catch { return {}; } })();
        const audience = scopes.audience === 'project' && responsibility.projectId ? 'project' : 'private';
        const id = await db.insert(
            `INSERT INTO assistant_initiatives
                (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, audience, projectId,
                 sourceKind, sourceId, sourceRevision, dedupeKey, attempt, title, reason)
             VALUES (@rid, @rrev, @owner, @acting, @audience, @projectId,
                 @sourceKind, @sourceId, @revision, @dedupeKey, 1, @title, @reason)`,
            {
                rid: responsibility.id,
                rrev: responsibility.revision,
                owner: responsibility.ownerUserId,
                acting: responsibility.actingUserId,
                audience,
                projectId: responsibility.projectId ?? null,
                sourceKind,
                sourceId: source.sourceId,
                revision: source.revision,
                dedupeKey,
                title: source.title,
                reason: source.reason || null
            }
        );
        return { initiative: await this._row(id), created: true };
    }

    /**
     * Compare one responsibility's linked sources with their cursors.
     * @returns {Promise<{ baselined: number, proposed: number[] }>}
     */
    async reconcileResponsibility(responsibilityId, { now = new Date() } = {}) {
        const outcome = { baselined: 0, proposed: [] };
        const responsibility = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: Number(responsibilityId) });
        if (!responsibility || !(await this._grantLive(responsibility, now))) return outcome;
        for (const [sourceKind, adapter] of Object.entries(SOURCES)) {
            if (adapter.feature && features.enforcedOff(adapter.feature)) continue;
            const sources = await adapter.read(responsibility);
            for (const source of sources) {
                await db.transaction(async () => {
                    const cursor = await db.get(
                        `SELECT * FROM assistant_source_cursors
                         WHERE responsibilityId = @rid AND sourceKind = @kind AND sourceId = @sourceId`,
                        { rid: responsibility.id, kind: sourceKind, sourceId: source.sourceId }
                    );
                    if (!cursor) {
                        await db.run(
                            `INSERT INTO assistant_source_cursors
                                (responsibilityId, sourceKind, sourceId, sourceRevision, baselineRevision)
                             VALUES (@rid, @kind, @sourceId, @revision, @authority)`,
                            { rid: responsibility.id, kind: sourceKind, sourceId: source.sourceId, revision: source.revision, authority: responsibility.authorityRevision }
                        );
                        outcome.baselined += 1;
                        return;
                    }
                    if (cursor.sourceRevision === source.revision) return;
                    const { initiative, created } = await this._propose(responsibility, source, sourceKind);
                    await db.run(
                        `UPDATE assistant_source_cursors SET sourceRevision = @revision, updatedAt = @now
                         WHERE id = @id AND sourceRevision = @previous`,
                        { id: cursor.id, revision: source.revision, previous: cursor.sourceRevision, now: utcText() }
                    );
                    if (created) outcome.proposed.push(Number(initiative.id));
                });
            }
        }
        return outcome;
    }

    /** A bounded pass over active grants (all, or one owner's). */
    async reconcile({ userId = null, limit = RECONCILE_BATCH, now = new Date() } = {}) {
        if (features.enforcedOff('assistant')) return { scanned: 0, baselined: 0, proposed: 0 };
        const params = { limit: Math.max(1, Math.min(500, Number(limit) || RECONCILE_BATCH)) };
        if (userId) params.userId = String(userId);
        const rows = await db.all(
            `SELECT id FROM assistant_responsibilities
             WHERE status = 'ACTIVE' ${userId ? 'AND ownerUserId = @userId' : ''}
             ORDER BY updatedAt ASC, id ASC LIMIT @limit`,
            params
        );
        let baselined = 0;
        let proposed = 0;
        for (const { id } of rows) {
            const result = await this.reconcileResponsibility(id, { now });
            baselined += result.baselined;
            proposed += result.proposed.length;
        }
        return { scanned: rows.length, baselined, proposed };
    }

    /**
     * Status hook, called by the responsibility service inside the same
     * transaction as a status change. Ending a grant ends its open work;
     * pausing it parks queued work (a running attempt stops at its next
     * authorize()); resuming re-baselines nothing and leaves parked work
     * waiting for its owner, because it was planned under older authority.
     */
    async onResponsibilityChanged(responsibility) {
        const now = utcText();
        if (['REVOKED', 'EXPIRED', 'COMPLETED', 'ARCHIVED'].includes(responsibility.status)) {
            await db.run(
                `UPDATE assistant_initiatives
                 SET status = 'CANCELLED', stopCode = @code, leaseToken = NULL, leaseExpiresAt = NULL,
                     revision = revision + 1, endedAt = @now, updatedAt = @now
                 WHERE responsibilityId = @rid AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW')`,
                { rid: responsibility.id, code: `RESPONSIBILITY_${responsibility.status}`, now }
            );
        } else if (['PAUSED', 'NEEDS_REVIEW'].includes(responsibility.status)) {
            await db.run(
                `UPDATE assistant_initiatives
                 SET status = 'WAITING', waitReason = 'responsibility', stopCode = @code,
                     leaseToken = NULL, leaseExpiresAt = NULL, revision = revision + 1, updatedAt = @now
                 WHERE responsibilityId = @rid AND status IN ('QUEUED', 'RUNNING')`,
                { rid: responsibility.id, code: `RESPONSIBILITY_${responsibility.status}`, now }
            );
        }
    }

    async _write(row, expectedRevision, sets, { allowFrom }) {
        if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== Number(row.revision)) {
            throw new AssistantInitiativeError('REVISION_CONFLICT', 'This initiative changed since you loaded it.', 409, { revision: Number(row.revision) });
        }
        if (allowFrom && !allowFrom.includes(row.status)) {
            throw new AssistantInitiativeError('INVALID_TRANSITION', `Cannot do that to a ${row.status.toLowerCase()} initiative.`, 409, { status: row.status });
        }
        const params = { id: row.id, expected: row.revision, now: utcText() };
        const assignments = Object.keys(sets).map((column) => {
            params[`set_${column}`] = sets[column];
            return `${column} = @set_${column}`;
        });
        assignments.push('revision = revision + 1', 'updatedAt = @now');
        const result = await db.run(
            `UPDATE assistant_initiatives SET ${assignments.join(', ')} WHERE id = @id AND revision = @expected`,
            params
        );
        if (result.changes !== 1) {
            const current = await this._row(row.id);
            throw new AssistantInitiativeError('REVISION_CONFLICT', 'This initiative changed since you loaded it.', 409, { revision: current ? Number(current.revision) : null });
        }
        return this._row(row.id);
    }

    /**
     * The owner's actions: queue (approve a candidate for the runner),
     * cancel, retry (a new attempt of a failed/cancelled one), accept /
     * reject (a REVIEW outcome).
     */
    async act({ userId, id, action, expectedRevision }) {
        if (!HUMAN_ACTIONS.includes(action)) {
            throw new AssistantInitiativeError('INVALID_ACTION', `action must be one of ${HUMAN_ACTIONS.join(', ')}.`);
        }
        return db.transaction(async () => {
            const row = await this._row(id);
            if (!row || row.ownerUserId !== String(userId)) throw notFound();
            const now = utcText();
            if (action === 'queue') {
                const responsibility = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: row.responsibilityId });
                if (!responsibility || !(await this._grantLive(responsibility))) {
                    throw new AssistantInitiativeError('RESPONSIBILITY_INACTIVE', 'Its responsibility is not active, or Attention is off.', 409);
                }
                // Queuing is the owner re-approving the attempt under the grant as it is now.
                return { initiative: this.present(await this._write(row, expectedRevision,
                    { status: 'QUEUED', waitReason: null, stopCode: null, responsibilityRevision: responsibility.revision },
                    { allowFrom: ['CANDIDATE', 'WAITING'] })) };
            }
            if (action === 'cancel') {
                return { initiative: this.present(await this._write(row, expectedRevision,
                    { status: 'CANCELLED', stopCode: 'CANCELLED_BY_OWNER', leaseToken: null, leaseExpiresAt: null, endedAt: now },
                    { allowFrom: OPEN_STATUSES })) };
            }
            if (action === 'accept') {
                return { initiative: this.present(await this._write(row, expectedRevision,
                    { status: 'COMPLETED', outcome: row.outcome || 'DONE', endedAt: now }, { allowFrom: ['REVIEW'] })) };
            }
            if (action === 'reject') {
                return { initiative: this.present(await this._write(row, expectedRevision,
                    { status: 'CANCELLED', stopCode: 'REJECTED_BY_OWNER', endedAt: now }, { allowFrom: ['REVIEW'] })) };
            }
            // retry: a new attempt of the same opportunity, under the current grant.
            if (!['FAILED', 'CANCELLED'].includes(row.status)) {
                throw new AssistantInitiativeError('INVALID_TRANSITION', `Cannot retry a ${row.status.toLowerCase()} initiative.`, 409, { status: row.status });
            }
            if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== Number(row.revision)) {
                throw new AssistantInitiativeError('REVISION_CONFLICT', 'This initiative changed since you loaded it.', 409, { revision: Number(row.revision) });
            }
            const responsibility = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: row.responsibilityId });
            if (!responsibility || !(await this._grantLive(responsibility))) {
                throw new AssistantInitiativeError('RESPONSIBILITY_INACTIVE', 'Its responsibility is not active, or Attention is off.', 409);
            }
            const open = await db.get(
                `SELECT id FROM assistant_initiatives WHERE responsibilityId = @rid AND dedupeKey = @key
                 AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW')`,
                { rid: row.responsibilityId, key: row.dedupeKey }
            );
            if (open) throw new AssistantInitiativeError('ALREADY_OPEN', 'Another attempt at this is already open.', 409, { id: Number(open.id) });
            const top = await db.get(
                'SELECT MAX(attempt) AS top FROM assistant_initiatives WHERE responsibilityId = @rid AND dedupeKey = @key AND sourceRevision = @revision',
                { rid: row.responsibilityId, key: row.dedupeKey, revision: row.sourceRevision }
            );
            const newId = await db.insert(
                `INSERT INTO assistant_initiatives
                    (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, audience, projectId,
                     sourceKind, sourceId, sourceRevision, dedupeKey, attempt, title, reason, status, parentInitiativeId, depth)
                 VALUES (@rid, @rrev, @owner, @acting, @audience, @projectId,
                     @sourceKind, @sourceId, @revision, @dedupeKey, @attempt, @title, @reason, 'QUEUED', @parent, @depth)`,
                {
                    rid: row.responsibilityId,
                    rrev: responsibility.revision,
                    owner: row.ownerUserId,
                    acting: responsibility.actingUserId,
                    audience: row.audience,
                    projectId: row.projectId,
                    sourceKind: row.sourceKind,
                    sourceId: row.sourceId,
                    revision: row.sourceRevision,
                    dedupeKey: row.dedupeKey,
                    attempt: Number(top?.top || row.attempt) + 1,
                    title: row.title,
                    reason: 'retry',
                    parent: row.id,
                    depth: Math.min(MAX_DEPTH, Number(row.depth || 0))
                }
            );
            return { initiative: this.present(await this._row(newId)) };
        });
    }

    /**
     * Take a QUEUED attempt for execution (the DA-3 runner's entry point).
     * Re-checks the grant now, enforces the grant's concurrentInitiatives
     * budget, and returns a lease token every later write must present.
     * @returns {Promise<{ ok: true, initiative, leaseToken } | { ok: false, code }>}
     */
    async claim({ id, now = new Date() }) {
        return db.transaction(async () => {
            const row = await this._row(id);
            if (!row) return { ok: false, code: 'NOT_FOUND' };
            if (row.status !== 'QUEUED') return { ok: false, code: 'NOT_QUEUED', status: row.status };
            const responsibility = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: row.responsibilityId });
            if (!responsibility || !(await this._grantLive(responsibility, now))) return { ok: false, code: 'RESPONSIBILITY_INACTIVE' };
            if (Number(row.responsibilityRevision) < Number(responsibility.authorityRevision)) {
                await this._write(row, null, { status: 'WAITING', waitReason: 'responsibility', stopCode: 'REPLAN_REQUIRED' }, {});
                return { ok: false, code: 'REVISION_CONFLICT' };
            }
            let budgets;
            try { budgets = JSON.parse(responsibility.budgetsJson || '{}') || {}; } catch { budgets = {}; }
            if (Number.isSafeInteger(budgets.concurrentInitiatives)) {
                const running = await db.get(
                    "SELECT COUNT(*) AS n FROM assistant_initiatives WHERE responsibilityId = @rid AND status = 'RUNNING'",
                    { rid: row.responsibilityId }
                );
                if (Number(running?.n || 0) >= budgets.concurrentInitiatives) return { ok: false, code: 'BUDGET_LIMIT' };
            }
            const leaseToken = crypto.randomBytes(16).toString('hex');
            const updated = await this._write(row, null, {
                status: 'RUNNING',
                leaseToken,
                leaseExpiresAt: utcText(new Date(now.getTime() + LEASE_MS)),
                waitReason: null,
                stopCode: null
            }, {});
            return { ok: true, initiative: this.present(updated), leaseToken };
        });
    }

    /**
     * Settle a claimed attempt. A worker whose lease was reaped or whose
     * attempt was cancelled holds a stale token and is refused (fencing).
     * @param {{ id, leaseToken, status: 'WAITING'|'REVIEW'|'COMPLETED'|'FAILED', outcome?, waitReason?, stopCode?, recheckAfter? }} params
     */
    async settle({ id, leaseToken, status, outcome = null, waitReason = null, stopCode = null, recheckAfter = null }) {
        if (!['WAITING', 'REVIEW', 'COMPLETED', 'FAILED'].includes(status)) {
            throw new AssistantInitiativeError('INVALID_TRANSITION', 'A claimed initiative settles as WAITING, REVIEW, COMPLETED or FAILED.');
        }
        if (status === 'COMPLETED' && outcome && !OUTCOMES.includes(outcome)) {
            throw new AssistantInitiativeError('INVALID_OUTCOME', `outcome must be one of ${OUTCOMES.join(', ')}.`);
        }
        if (status === 'WAITING' && !WAIT_REASONS.includes(waitReason)) {
            throw new AssistantInitiativeError('INVALID_WAIT_REASON', `waitReason must be one of ${WAIT_REASONS.join(', ')}.`);
        }
        return db.transaction(async () => {
            const row = await this._row(id);
            if (!row || row.status !== 'RUNNING' || !leaseToken || row.leaseToken !== leaseToken) {
                return { ok: false, code: 'LEASE_LOST' };
            }
            const terminal = TERMINAL_STATUSES.includes(status);
            const updated = await this._write(row, null, {
                status,
                outcome: status === 'COMPLETED' ? (outcome || 'DONE') : outcome,
                waitReason: status === 'WAITING' ? waitReason : null,
                stopCode,
                recheckAfter: recheckAfter ? utcText(new Date(recheckAfter)) : null,
                leaseToken: null,
                leaseExpiresAt: null,
                endedAt: terminal ? utcText() : null
            }, {});
            return { ok: true, initiative: this.present(updated) };
        });
    }

    /**
     * Extend a claimed attempt's lease (the runner calls this as it works).
     * False means the lease is gone: the attempt was cancelled, parked or
     * reaped, and the caller must stop without writing anything more.
     */
    async renewLease({ id, leaseToken, now = new Date() }) {
        if (!leaseToken) return false;
        const result = await db.run(
            `UPDATE assistant_initiatives SET leaseExpiresAt = @expires, updatedAt = @now
             WHERE id = @id AND status = 'RUNNING' AND leaseToken = @token`,
            { id: Number(id), token: leaseToken, expires: utcText(new Date(now.getTime() + LEASE_MS)), now: utcText(now) }
        );
        return result.changes > 0;
    }

    /**
     * WAITING attempts whose recheck time has come go back to QUEUED, when
     * what they waited for can clear by itself (a budget window, a missing
     * dependency). They were queued by their owner once already; a wait on
     * the person, on access or on the responsibility needs a human action.
     */
    async requeueDue({ now = new Date() } = {}) {
        const result = await db.run(
            `UPDATE assistant_initiatives
             SET status = 'QUEUED', waitReason = NULL, stopCode = NULL, recheckAfter = NULL,
                 revision = revision + 1, updatedAt = @now
             WHERE status = 'WAITING' AND waitReason IN ('budget', 'dependency')
               AND recheckAfter IS NOT NULL AND recheckAfter <= @now`,
            { now: utcText(now) }
        );
        return result.changes || 0;
    }

    /** Return RUNNING attempts whose lease lapsed to QUEUED, without their token. */
    async reapExpiredLeases({ now = new Date() } = {}) {
        const result = await db.run(
            `UPDATE assistant_initiatives
             SET status = 'QUEUED', leaseToken = NULL, leaseExpiresAt = NULL, stopCode = 'LEASE_EXPIRED',
                 revision = revision + 1, updatedAt = @now
             WHERE status = 'RUNNING' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= @now`,
            { now: utcText(now) }
        );
        return result.changes || 0;
    }

    /** Ask for an early reconcile of one owner's grants (event-bus hint). */
    hint(userId) {
        if (!userId) return;
        this._hinted.add(String(userId));
        if (this._hintTimer) return;
        this._hintTimer = setTimeout(() => {
            this._hintTimer = null;
            const owners = [...this._hinted];
            this._hinted.clear();
            (async () => {
                for (const owner of owners) {
                    await this.reconcile({ userId: owner });
                    // The same hint moves a project gate (approve, answer,
                    // review) into or out of Needs you without waiting a pass.
                    await require('./assistantGateService').adoptProjectGates({ userId: owner });
                }
            })().catch(() => {});
        }, 2000);
        this._hintTimer.unref?.();
    }

    /** Subscribe to the domain bus for hints (idempotent). */
    listen() {
        if (this._unsubscribe) return;
        const bus = require('./domainEventBus');
        this._unsubscribe = bus.subscribe(['attention.*', 'mission.*'], (event) => {
            if (event?.payload?.userId) this.hint(event.payload.userId);
        });
    }

    stopListening() {
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        if (this._hintTimer) clearTimeout(this._hintTimer);
        this._hintTimer = null;
        this._hinted.clear();
    }

    /** Retention: terminal attempts untouched for `days`. */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        const result = await db.run(
            `DELETE FROM assistant_initiatives
             WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED') AND updatedAt < @cutoff`,
            { cutoff }
        );
        return result.changes || 0;
    }
}

module.exports = new AssistantInitiativeService();
module.exports.AssistantInitiativeService = AssistantInitiativeService;
module.exports.AssistantInitiativeError = AssistantInitiativeError;
module.exports.SOURCES = SOURCES;
