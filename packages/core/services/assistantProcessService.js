/**
 * The process catalog's read model (DA-1d, ADR 0017).
 *
 * Adapters describe existing recurring processes (automations, project
 * triggers, Attention watches, followed sources) through one typed
 * reference `<kind>:<id>`, without taking over their scheduling. A person
 * may attach a contract saying what the process is for and what healthy
 * looks like; nothing here pauses, repairs or deletes anything (DA-5).
 *
 * Observations are typed per occurrence: (process, occurrenceKey, phase) is
 * unique, so a retried delivery updates one row instead of adding another,
 * and success, skip, block, deferral and failure are recorded rather than
 * inferred from an absence of errors. Rows carry machine codes and
 * references only: never output, prompts, URLs or error text.
 *
 * `record()` is called from the schedulers that already own each process.
 * It never throws and does nothing while the assistant feature is off.
 *
 * Spec: documentation/delegated_responsibilities.md ("Processes").
 */

const db = require('../db');
const { features } = require('../features/featureState');
const logger = require('../utils/logger');
const { SCHEDULED_WORK } = require('./scheduledWorkRegistry');

const PHASES = ['schedule', 'dispatch', 'execution', 'output', 'delivery', 'outcome'];
const OUTCOMES = ['ok', 'skipped', 'blocked', 'deferred', 'failed', 'unknown'];
const CRITICALITY = ['low', 'normal', 'high'];
const REASON_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const OBSERVATION_PAGE = 50;

class AssistantProcessError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = 'AssistantProcessError';
        this.code = code;
        this.status = status;
        if (details) this.details = details;
    }
}

const bad = (message, code = 'INVALID_CONTRACT') => new AssistantProcessError(code, message, 400);
const notFound = () => new AssistantProcessError('NOT_FOUND', 'No such process.', 404);

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Each adapter reads one existing process row and presents the fields a
 * steward needs: owner, name, enabled, cadence and last/next times. Labels
 * only; a followed source's URL is not part of the read model.
 */
const ADAPTERS = {
    automation: {
        feature: null,
        async describe(id) {
            const row = await db.get(
                'SELECT id, userId, name, schedule, isEnabled, lastRun, nextRun, createdAt FROM automations WHERE id = @id',
                { id }
            );
            if (!row) return null;
            return {
                ownerUserId: row.userId,
                name: row.name,
                enabled: Boolean(row.isEnabled),
                trigger: { kind: 'cron', schedule: row.schedule, timezone: 'UTC' },
                lastRunAt: row.lastRun || null,
                nextRunAt: row.nextRun || null,
                createdAt: row.createdAt
            };
        },
        async list(userId) {
            return db.all('SELECT id FROM automations WHERE userId = @userId ORDER BY id', { userId });
        }
    },
    project_trigger: {
        feature: 'projects',
        async describe(id) {
            const row = await db.get(
                `SELECT id, userId, projectId, name, kind, schedule, eventTopic, isEnabled, lastRun, nextRun, createdAt
                 FROM project_triggers WHERE id = @id`,
                { id }
            );
            if (!row) return null;
            return {
                ownerUserId: row.userId,
                name: row.name,
                enabled: Boolean(row.isEnabled),
                projectId: Number(row.projectId),
                trigger: row.kind === 'cron'
                    ? { kind: 'cron', schedule: row.schedule, timezone: 'UTC' }
                    : { kind: 'event', topic: row.eventTopic },
                lastRunAt: row.lastRun || null,
                nextRunAt: row.nextRun || null,
                createdAt: row.createdAt
            };
        },
        async list(userId) {
            return db.all('SELECT id FROM project_triggers WHERE userId = @userId ORDER BY id', { userId });
        },
        /** Existing delivery ledger rows, presented as observations (status only). */
        async history(id, limit) {
            const rows = await db.all(
                `SELECT sourceJobId, status, attempts, childJobId, updatedAt FROM project_trigger_deliveries
                 WHERE triggerId = @id ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
                { id, limit }
            );
            const map = { STARTED: 'unknown', DELIVERED: 'ok', RETRYABLE: 'deferred', FAILED: 'failed', SKIPPED: 'skipped' };
            return rows.map(row => ({
                occurrenceKey: `job:${row.sourceJobId}`,
                phase: 'delivery',
                outcome: map[row.status] || 'unknown',
                reasonCode: `DELIVERY_${row.status}`,
                evidence: row.childJobId ? { kind: 'observatory_job', id: String(row.childJobId) } : null,
                attempts: Number(row.attempts || 0),
                observedAt: row.updatedAt,
                origin: 'project_trigger_deliveries'
            }));
        }
    },
    attention_watch: {
        feature: null,
        async describe(id) {
            const row = await db.get(
                `SELECT id, userId, label, topic, status, fireCount, maxFires, expiresAt, lastFiredAt, createdAt
                 FROM attention_watches WHERE id = @id`,
                { id }
            );
            if (!row) return null;
            return {
                ownerUserId: row.userId,
                name: row.label,
                enabled: row.status === 'ARMED',
                trigger: { kind: 'event', topic: row.topic, fires: Number(row.fireCount), maxFires: Number(row.maxFires) },
                status: row.status,
                lastRunAt: row.lastFiredAt || null,
                nextRunAt: null,
                expiresAt: row.expiresAt || null,
                createdAt: row.createdAt
            };
        },
        async list(userId) {
            return db.all('SELECT id FROM attention_watches WHERE userId = @userId ORDER BY id', { userId });
        }
    },
    followed_source: {
        feature: null,
        async describe(id) {
            const row = await db.get(
                `SELECT id, userId, projectId, label, kind, enabled, lastCheckedAt, nextCheckAt, createdAt
                 FROM followed_sources WHERE id = @id`,
                { id }
            );
            if (!row) return null;
            return {
                ownerUserId: row.userId,
                name: row.label,
                enabled: Boolean(row.enabled),
                projectId: row.projectId == null ? null : Number(row.projectId),
                trigger: { kind: 'poll', source: row.kind },
                lastRunAt: row.lastCheckedAt || null,
                nextRunAt: row.nextCheckAt || null,
                createdAt: row.createdAt
            };
        },
        async list(userId) {
            return db.all('SELECT id FROM followed_sources WHERE userId = @userId ORDER BY id', { userId });
        }
    }
};

function parseRef(kind, id) {
    const adapter = Object.prototype.hasOwnProperty.call(ADAPTERS, kind) ? ADAPTERS[kind] : null;
    const n = Number(id);
    if (!adapter || !Number.isSafeInteger(n) || n <= 0) return null;
    return { kind, id: n, adapter };
}

function optionalInt(value, field, { min = 0 } = {}) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min) throw bad(`${field} must be an integer of at least ${min}.`);
    return n;
}

function optionalText(value, field, max) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw bad(`${field} must be text.`);
    const clean = value.trim();
    if (!clean) return null;
    if (clean.length > max) throw bad(`${field} is longer than ${max} characters.`);
    return clean;
}

class AssistantProcessService {
    constructor() {
        this.KINDS = Object.keys(ADAPTERS);
        this.PHASES = PHASES;
        this.OUTCOMES = OUTCOMES;
    }

    /**
     * Record one observation. Never throws; returns false when skipped.
     * @param {Object} params
     * @param {string} params.processKind
     * @param {number|string} params.processId
     * @param {string} params.ownerUserId
     * @param {string} params.occurrenceKey - stable per occurrence (a scheduled fire time, a source job)
     * @param {string} params.phase - one of PHASES
     * @param {string} params.outcome - one of OUTCOMES
     * @param {string} [params.reasonCode] - machine code, `[A-Za-z0-9_.:-]{1,64}`
     * @param {{ kind: string, id: string|number }} [params.evidence]
     */
    async record({ processKind, processId, ownerUserId, occurrenceKey, phase, outcome, reasonCode = null, evidence = null, observedAt = null }) {
        try {
            if (features.enforcedOff('assistant')) return false;
            if (!ADAPTERS[processKind] || !PHASES.includes(phase) || !OUTCOMES.includes(outcome)) return false;
            if (!ownerUserId || !occurrenceKey || processId === undefined || processId === null) return false;
            const code = reasonCode && REASON_CODE.test(String(reasonCode)) ? String(reasonCode) : (reasonCode ? 'UNCLASSIFIED' : null);
            const at = observedAt ? utcText(new Date(observedAt)) : utcText();
            await db.run(
                `INSERT INTO assistant_process_observations
                    (ownerUserId, processKind, processId, occurrenceKey, phase, outcome, reasonCode, evidenceKind, evidenceId, observedAt)
                 VALUES (@owner, @kind, @id, @occurrence, @phase, @outcome, @code, @evidenceKind, @evidenceId, @at)
                 ON CONFLICT (processKind, processId, occurrenceKey, phase) DO UPDATE SET
                    outcome = excluded.outcome, reasonCode = excluded.reasonCode,
                    evidenceKind = excluded.evidenceKind, evidenceId = excluded.evidenceId,
                    attempts = assistant_process_observations.attempts + 1, observedAt = excluded.observedAt`,
                {
                    owner: String(ownerUserId),
                    kind: processKind,
                    id: String(processId),
                    occurrence: String(occurrenceKey).slice(0, 120),
                    phase,
                    outcome,
                    code,
                    evidenceKind: evidence?.kind ? String(evidence.kind).slice(0, 40) : null,
                    evidenceId: evidence?.id != null ? String(evidence.id).slice(0, 120) : null,
                    at
                }
            );
            return true;
        } catch (error) {
            logger.warn?.(`[assistant processes] observation not recorded: ${error.message}`);
            return false;
        }
    }

    /** Resolve and authorize one process for its owner; 404 otherwise. */
    async _resolve(userId, kind, id) {
        const ref = parseRef(kind, id);
        if (!ref) throw notFound();
        if (ref.adapter.feature && features.enforcedOff(ref.adapter.feature)) {
            throw new AssistantProcessError('FEATURE_UNAVAILABLE', 'That kind of process is not available on this installation.', 409, { feature: ref.adapter.feature });
        }
        const described = await ref.adapter.describe(ref.id);
        if (!described || described.ownerUserId !== String(userId)) throw notFound();
        return { ref, described };
    }

    _presentContract(row) {
        if (!row) return null;
        return {
            id: Number(row.id),
            revision: Number(row.revision),
            purpose: row.purpose || null,
            attentionItemId: row.attentionItemId == null ? null : Number(row.attentionItemId),
            projectId: row.projectId == null ? null : Number(row.projectId),
            expectedCadenceSeconds: row.expectedCadenceSeconds == null ? null : Number(row.expectedCadenceSeconds),
            freshnessSeconds: row.freshnessSeconds == null ? null : Number(row.freshnessSeconds),
            quietResultOk: Boolean(row.quietResultOk),
            criticality: row.criticality,
            reviewAt: row.reviewAt || null,
            stopCondition: row.stopCondition || null,
            updatedAt: row.updatedAt
        };
    }

    _presentObservation(row) {
        return {
            occurrenceKey: row.occurrenceKey,
            phase: row.phase,
            outcome: row.outcome,
            reasonCode: row.reasonCode || null,
            evidence: row.evidenceKind ? { kind: row.evidenceKind, id: row.evidenceId } : null,
            attempts: Number(row.attempts),
            observedAt: row.observedAt,
            origin: 'assistant_process_observations'
        };
    }

    /** The owner's processes of every available kind, with whether a contract exists. */
    async list({ userId }) {
        const out = [];
        for (const [kind, adapter] of Object.entries(ADAPTERS)) {
            if (adapter.feature && features.enforcedOff(adapter.feature)) continue;
            const rows = await adapter.list(String(userId));
            for (const { id } of rows.slice(0, 200)) {
                const described = await adapter.describe(Number(id));
                if (!described) continue;
                const contract = await db.get(
                    'SELECT id FROM assistant_process_contracts WHERE processKind = @kind AND processId = @id',
                    { kind, id: String(id) }
                );
                out.push({ kind, id: Number(id), ref: `${kind}:${id}`, name: described.name, enabled: described.enabled, hasContract: Boolean(contract) });
            }
        }
        return { processes: out };
    }

    /**
     * One process: the adapter's description, its contract (if any), its
     * recent observations and, where the process already keeps one, its own
     * delivery history. A read: it changes nothing.
     */
    async get({ userId, kind, id, limit = OBSERVATION_PAGE }) {
        const { ref, described } = await this._resolve(userId, kind, id);
        const size = Math.max(1, Math.min(OBSERVATION_PAGE, Number(limit) || OBSERVATION_PAGE));
        const contract = await db.get(
            'SELECT * FROM assistant_process_contracts WHERE processKind = @kind AND processId = @id',
            { kind: ref.kind, id: String(ref.id) }
        );
        const observed = await db.all(
            `SELECT * FROM assistant_process_observations
             WHERE processKind = @kind AND processId = @id
             ORDER BY observedAt DESC, id DESC LIMIT @limit`,
            { kind: ref.kind, id: String(ref.id), limit: size }
        );
        const history = ref.adapter.history ? await ref.adapter.history(ref.id, size) : [];
        return {
            process: { kind: ref.kind, id: ref.id, ref: `${ref.kind}:${ref.id}`, ...described },
            contract: this._presentContract(contract),
            observations: observed.map(row => this._presentObservation(row)),
            history,
            // Health and relevance judgments arrive with process stewardship (DA-5).
            assessment: { execution: 'unknown', relevance: 'unknown', purposeKnown: Boolean(contract?.purpose) }
        };
    }

    _contractFields(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A JSON body is required.');
        const allowed = ['purpose', 'attentionItemId', 'projectId', 'expectedCadenceSeconds', 'freshnessSeconds',
            'quietResultOk', 'criticality', 'reviewAt', 'stopCondition', 'expectedRevision'];
        for (const key of Object.keys(body)) {
            if (!allowed.includes(key)) throw bad(`Unknown field "${key}".`);
        }
        if (body.criticality !== undefined && !CRITICALITY.includes(body.criticality)) {
            throw bad(`criticality must be one of ${CRITICALITY.join(', ')}.`);
        }
        let reviewAt = null;
        if (body.reviewAt) {
            const date = new Date(body.reviewAt);
            if (Number.isNaN(date.getTime())) throw bad('reviewAt must be a timestamp.');
            reviewAt = utcText(date);
        }
        return {
            purpose: optionalText(body.purpose, 'purpose', 1000),
            attentionItemId: optionalInt(body.attentionItemId, 'attentionItemId', { min: 1 }),
            projectId: optionalInt(body.projectId, 'projectId', { min: 1 }),
            expectedCadenceSeconds: optionalInt(body.expectedCadenceSeconds, 'expectedCadenceSeconds', { min: 60 }),
            freshnessSeconds: optionalInt(body.freshnessSeconds, 'freshnessSeconds', { min: 60 }),
            quietResultOk: body.quietResultOk === true ? 1 : 0,
            criticality: body.criticality || 'normal',
            reviewAt,
            stopCondition: optionalText(body.stopCondition, 'stopCondition', 1000)
        };
    }

    async _validateLinks(userId, fields) {
        if (fields.attentionItemId) {
            const item = await db.get('SELECT userId FROM attention_items WHERE id = @id', { id: fields.attentionItemId });
            if (!item || item.userId !== String(userId)) throw bad('attentionItemId is not one of your attention items.', 'INVALID_LINK');
        }
        if (fields.projectId) {
            const project = await db.get(
                `SELECT 1 AS ok FROM observatory_projects p WHERE p.id = @id
                 AND (p.userId = @userId OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @userId))`,
                { id: fields.projectId, userId: String(userId) }
            );
            if (!project) throw bad('projectId is not a project you can reach.', 'INVALID_LINK');
        }
    }

    /**
     * Create or replace the contract for one of the person's processes. An
     * existing contract needs `expectedRevision` (compare-and-swap).
     */
    async putContract({ userId, kind, id, body }) {
        const { ref } = await this._resolve(userId, kind, id);
        const fields = this._contractFields(body);
        await this._validateLinks(userId, fields);
        return db.transaction(async () => {
            const existing = await db.get(
                'SELECT * FROM assistant_process_contracts WHERE processKind = @kind AND processId = @id',
                { kind: ref.kind, id: String(ref.id) }
            );
            if (!existing) {
                const contractId = await db.insert(
                    `INSERT INTO assistant_process_contracts
                        (ownerUserId, processKind, processId, purpose, attentionItemId, projectId, expectedCadenceSeconds,
                         freshnessSeconds, quietResultOk, criticality, reviewAt, stopCondition)
                     VALUES (@owner, @kind, @id, @purpose, @attentionItemId, @projectId, @expectedCadenceSeconds,
                         @freshnessSeconds, @quietResultOk, @criticality, @reviewAt, @stopCondition)`,
                    { owner: String(userId), kind: ref.kind, id: String(ref.id), ...fields }
                );
                return { contract: this._presentContract(await db.get('SELECT * FROM assistant_process_contracts WHERE id = @id', { id: contractId })), created: true };
            }
            if (Number(body.expectedRevision) !== Number(existing.revision)) {
                throw new AssistantProcessError('REVISION_CONFLICT', 'This contract changed since you loaded it.', 409, { revision: Number(existing.revision) });
            }
            const result = await db.run(
                `UPDATE assistant_process_contracts SET
                    purpose = @purpose, attentionItemId = @attentionItemId, projectId = @projectId,
                    expectedCadenceSeconds = @expectedCadenceSeconds, freshnessSeconds = @freshnessSeconds,
                    quietResultOk = @quietResultOk, criticality = @criticality, reviewAt = @reviewAt,
                    stopCondition = @stopCondition, ownerUserId = @owner, revision = revision + 1, updatedAt = @now
                 WHERE id = @cid AND revision = @expected`,
                { ...fields, owner: String(userId), cid: existing.id, expected: existing.revision, now: utcText() }
            );
            if (result.changes !== 1) {
                throw new AssistantProcessError('REVISION_CONFLICT', 'This contract changed since you loaded it.', 409);
            }
            return { contract: this._presentContract(await db.get('SELECT * FROM assistant_process_contracts WHERE id = @id', { id: existing.id })), created: false };
        });
    }

    async deleteContract({ userId, kind, id }) {
        const { ref } = await this._resolve(userId, kind, id);
        const result = await db.run(
            'DELETE FROM assistant_process_contracts WHERE processKind = @kind AND processId = @id AND ownerUserId = @owner',
            { kind: ref.kind, id: String(ref.id), owner: String(userId) }
        );
        return { deleted: result.changes > 0 };
    }

    /**
     * Retention: observations older than `days`, and contracts and
     * observations whose process no longer exists.
     */
    async prune({ days = 90, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        let observations = (await db.run(
            'DELETE FROM assistant_process_observations WHERE observedAt < @cutoff', { cutoff }
        )).changes || 0;
        let contracts = 0;
        for (const [kind, adapter] of Object.entries(ADAPTERS)) {
            const table = SCHEDULED_WORK[kind].table;
            if (adapter.feature && features.enforcedOff(adapter.feature)) continue;
            const orphan = `processKind = @kind AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE CAST(t.id AS TEXT) = processId)`;
            observations += (await db.run(`DELETE FROM assistant_process_observations WHERE ${orphan}`, { kind })).changes || 0;
            contracts += (await db.run(`DELETE FROM assistant_process_contracts WHERE ${orphan}`, { kind })).changes || 0;
        }
        return { observations, contracts };
    }
}

module.exports = new AssistantProcessService();
module.exports.AssistantProcessService = AssistantProcessService;
module.exports.AssistantProcessError = AssistantProcessError;
module.exports.ADAPTERS = ADAPTERS;
