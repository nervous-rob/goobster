/**
 * The process catalog's read model (DA-1d, ADR 0017).
 *
 * Adapters describe existing recurring processes (automations, project
 * triggers, Attention watches, followed sources) through one typed
 * reference `<kind>:<id>`, without taking over their scheduling. A person
 * may attach a contract saying what the process is for and what healthy
 * looks like. `assess()` judges each process on two axes, execution and
 * relevance, from typed evidence (assistant/processes/assessment.js). It is
 * a read: nothing here pauses, repairs or deletes anything.
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
 * Spec: documentation/delegated_responsibilities.md ("Processes") and
 * documentation/process_stewardship.md.
 */

const db = require('../db');
const { features } = require('../features/featureState');
const logger = require('../utils/logger');
const { SCHEDULED_WORK } = require('./scheduledWorkRegistry');
const assessment = require('./assistant/processes/assessment');

const PHASES = ['schedule', 'dispatch', 'execution', 'output', 'delivery', 'outcome'];
const OUTCOMES = ['ok', 'skipped', 'blocked', 'deferred', 'failed', 'unknown'];
const CRITICALITY = ['low', 'normal', 'high'];
const REASON_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const OBSERVATION_PAGE = 50;
/** Processes of one kind read per person, and the newest observations weighed per process. */
const LIST_MAX = 200;
const ASSESS_OBSERVATIONS = 80;
const ASSESS_WINDOW_DAYS = 90;
const DEPENDS_ON_MAX = 8;
/** `record({ keepResult })`: the stored row is `ok` and the new one only says nothing happened. */
const KEPT = "@keep = 1 AND assistant_process_observations.outcome = 'ok' AND excluded.outcome = 'skipped'";

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
 * Each adapter reads existing process rows and presents the fields a
 * steward needs: owner, name, enabled, cadence and last/next times. Labels
 * only; a followed source's URL is not part of the read model.
 *
 * `dependsOn` lists processes this one cannot work without (a chained
 * trigger's source trigger); `attentionItemId` is the goal a watch was
 * armed for; `resultSource` is the Inbox `sourceType` its results are
 * filed under, where it files any.
 */
function adapter({ feature = null, table, columns, present, history = null, resultSource = null }) {
    return {
        feature,
        resultSource,
        async describe(id) {
            const row = await db.get(`SELECT ${columns} FROM ${table} WHERE id = @id`, { id });
            return row ? present(row) : null;
        },
        async list(userId) {
            return db.all(`SELECT id FROM ${table} WHERE userId = @userId ORDER BY id`, { userId });
        },
        /** Every process of this kind the person owns, described, in one query. */
        async listDescribed(userId) {
            const rows = await db.all(
                `SELECT ${columns} FROM ${table} WHERE userId = @userId ORDER BY id LIMIT ${LIST_MAX}`, { userId }
            );
            return rows.map(row => ({ id: Number(row.id), ...present(row) }));
        },
        ...(history ? { history } : {})
    };
}

const ADAPTERS = {
    automation: adapter({
        table: 'automations',
        columns: 'id, userId, name, schedule, isEnabled, lastRun, nextRun, createdAt',
        resultSource: 'automation',
        present: row => ({
            ownerUserId: row.userId,
            name: row.name,
            enabled: Boolean(row.isEnabled),
            trigger: { kind: 'cron', schedule: row.schedule, timezone: 'UTC' },
            lastRunAt: row.lastRun || null,
            nextRunAt: row.nextRun || null,
            createdAt: row.createdAt
        })
    }),
    project_trigger: adapter({
        feature: 'projects',
        table: 'project_triggers',
        columns: 'id, userId, projectId, name, kind, schedule, eventTopic, isEnabled, lastRun, nextRun, sourceTriggerId, createdAt',
        present: row => ({
            ownerUserId: row.userId,
            name: row.name,
            enabled: Boolean(row.isEnabled),
            projectId: Number(row.projectId),
            trigger: row.kind === 'cron'
                ? { kind: 'cron', schedule: row.schedule, timezone: 'UTC' }
                : { kind: 'event', topic: row.eventTopic },
            lastRunAt: row.lastRun || null,
            nextRunAt: row.nextRun || null,
            dependsOn: row.sourceTriggerId ? [`project_trigger:${Number(row.sourceTriggerId)}`] : [],
            createdAt: row.createdAt
        }),
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
    }),
    attention_watch: adapter({
        table: 'attention_watches',
        columns: 'id, userId, label, topic, status, fireCount, maxFires, expiresAt, lastFiredAt, itemId, createdAt',
        resultSource: 'watch',
        present: row => ({
            ownerUserId: row.userId,
            name: row.label,
            enabled: row.status === 'ARMED',
            trigger: { kind: 'event', topic: row.topic, fires: Number(row.fireCount), maxFires: Number(row.maxFires) },
            status: row.status,
            lastRunAt: row.lastFiredAt || null,
            nextRunAt: null,
            expiresAt: row.expiresAt || null,
            attentionItemId: row.itemId == null ? null : Number(row.itemId),
            createdAt: row.createdAt
        })
    }),
    followed_source: adapter({
        table: 'followed_sources',
        columns: 'id, userId, projectId, label, kind, enabled, lastCheckedAt, nextCheckAt, createdAt',
        present: row => ({
            ownerUserId: row.userId,
            name: row.label,
            enabled: Boolean(row.enabled),
            projectId: row.projectId == null ? null : Number(row.projectId),
            trigger: { kind: 'poll', source: row.kind },
            lastRunAt: row.lastCheckedAt || null,
            nextRunAt: row.nextCheckAt || null,
            createdAt: row.createdAt
        })
    })
};

function parseRef(kind, id) {
    const adapter = Object.prototype.hasOwnProperty.call(ADAPTERS, kind) ? ADAPTERS[kind] : null;
    const n = Number(id);
    if (!adapter || !Number.isSafeInteger(n) || n <= 0) return null;
    return { kind, id: n, adapter };
}

/** A stored `dependsOn` list; anything that is not a known `<kind>:<id>` is dropped. */
function parseRefs(raw) {
    if (!raw) return [];
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => {
        if (typeof entry !== 'string') return false;
        const [kind, id] = entry.split(':');
        return Boolean(parseRef(kind, id));
    });
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
     * @param {boolean} [params.keepResult] - for an occurrence observed many times (a day of polls):
     *   a later `skipped` does not replace an `ok` already recorded for it
     */
    async record({ processKind, processId, ownerUserId, occurrenceKey, phase, outcome, reasonCode = null, evidence = null, observedAt = null, keepResult = false }) {
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
                    outcome = CASE WHEN ${KEPT} THEN assistant_process_observations.outcome ELSE excluded.outcome END,
                    reasonCode = CASE WHEN ${KEPT} THEN assistant_process_observations.reasonCode ELSE excluded.reasonCode END,
                    evidenceKind = excluded.evidenceKind, evidenceId = excluded.evidenceId,
                    attempts = assistant_process_observations.attempts + 1,
                    observedAt = CASE WHEN ${KEPT} THEN assistant_process_observations.observedAt ELSE excluded.observedAt END`,
                {
                    keep: keepResult ? 1 : 0,
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

    /**
     * The occurrence a process already recorded against this evidence (the
     * dispatch that started a job), or null. Never throws.
     */
    async occurrenceFor({ processKind, processId, evidence }) {
        try {
            if (features.enforcedOff('assistant') || !evidence?.kind || evidence.id == null) return null;
            const row = await db.get(
                `SELECT occurrenceKey FROM assistant_process_observations
                 WHERE processKind = @kind AND processId = @id AND evidenceKind = @evidenceKind AND evidenceId = @evidenceId
                 ORDER BY id LIMIT 1`,
                { kind: processKind, id: String(processId), evidenceKind: String(evidence.kind), evidenceId: String(evidence.id) }
            );
            return row?.occurrenceKey || null;
        } catch (error) {
            logger.warn?.(`[assistant processes] occurrence lookup failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Move the phases recorded under a provisional occurrence onto the real
     * one, where it does not already have them. Never throws.
     */
    async mergeOccurrence({ processKind, processId, from, into }) {
        try {
            if (features.enforcedOff('assistant') || !from || !into || from === into) return 0;
            const result = await db.run(
                `UPDATE assistant_process_observations SET occurrenceKey = @into
                 WHERE processKind = @kind AND processId = @id AND occurrenceKey = @from
                   AND NOT EXISTS (
                       SELECT 1 FROM assistant_process_observations held
                       WHERE held.processKind = @kind AND held.processId = @id AND held.occurrenceKey = @into
                         AND held.phase = assistant_process_observations.phase)`,
                { kind: processKind, id: String(processId), from: String(from), into: String(into) }
            );
            return result.changes || 0;
        } catch (error) {
            logger.warn?.(`[assistant processes] occurrence not merged: ${error.message}`);
            return 0;
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
            dependsOn: parseRefs(row.dependsOnJson),
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

    /**
     * The owner's processes of every available kind, each with whether a
     * contract exists and how it is doing. A read.
     */
    async list({ userId, now = new Date() }) {
        const { processes, counts } = await this.assess({ userId, now });
        return {
            processes: processes.map(entry => ({
                kind: entry.kind,
                id: entry.id,
                ref: entry.ref,
                name: entry.described.name,
                enabled: entry.described.enabled,
                trigger: entry.described.trigger,
                lastRunAt: entry.described.lastRunAt,
                nextRunAt: entry.described.nextRunAt,
                hasContract: Boolean(entry.contract),
                criticality: entry.contract?.criticality || 'normal',
                assessment: entry.assessment,
                incident: entry.incident
            })),
            counts
        };
    }

    /**
     * Judge every process the person owns (assistant/processes/assessment.js).
     *
     * A bounded number of queries whatever the number of processes: one per
     * kind, then contracts, recent observations, linked goals, delivered
     * results and open incidents. A read: it records and announces nothing.
     *
     * @param {{ userId: string, now?: Date }} params
     * @returns {Promise<{ processes: Array, counts: Object }>} each entry is
     *   `{ kind, id, ref, described, contract, dependsOn, assessment, incident }`
     */
    async assess({ userId, now = new Date() }) {
        const owner = String(userId);
        const entries = [];
        for (const [kind, source] of Object.entries(ADAPTERS)) {
            if (source.feature && features.enforcedOff(source.feature)) continue;
            for (const { id, ...described } of await source.listDescribed(owner)) {
                entries.push({ kind, id, ref: `${kind}:${id}`, described, contract: null, observations: [] });
            }
        }
        if (!entries.length) return { processes: [], counts: this._counts([]) };
        const byRef = new Map(entries.map(entry => [entry.ref, entry]));

        for (const row of await db.all('SELECT * FROM assistant_process_contracts WHERE ownerUserId = @owner', { owner })) {
            const entry = byRef.get(`${row.processKind}:${row.processId}`);
            if (entry) entry.contract = this._presentContract(row);
        }
        const observed = await db.all(
            `SELECT processKind, processId, occurrenceKey, phase, outcome, reasonCode, observedAt FROM (
                 SELECT o.*, ROW_NUMBER() OVER (
                     PARTITION BY o.processKind, o.processId ORDER BY o.observedAt DESC, o.id DESC
                 ) AS recency
                 FROM assistant_process_observations o
                 WHERE o.ownerUserId = @owner AND o.observedAt >= @since
             ) ranked WHERE recency <= @per`,
            { owner, since: utcText(new Date(now.getTime() - ASSESS_WINDOW_DAYS * 86400000)), per: ASSESS_OBSERVATIONS }
        );
        for (const row of observed) byRef.get(`${row.processKind}:${row.processId}`)?.observations.push(row);

        // A followed source is only polled while its owner's Attention covers research.
        if (entries.some(entry => entry.kind === 'followed_source' && entry.described.enabled)
            && !await require('./followedSourceService').active(owner)) {
            for (const entry of entries) {
                if (entry.kind !== 'followed_source' || !entry.described.enabled) continue;
                entry.described.enabled = false;
                entry.described.heldBy = 'attention';
            }
        }

        const itemIds = [...new Set(entries
            .map(entry => entry.contract?.attentionItemId ?? entry.described.attentionItemId ?? null)
            .filter(id => Number.isSafeInteger(id) && id > 0))];
        const items = new Map();
        if (itemIds.length) {
            const rows = await db.all(
                `SELECT id, state FROM attention_items WHERE userId = @owner AND id IN (${itemIds.join(', ')})`, { owner }
            );
            for (const row of rows) items.set(Number(row.id), { state: row.state });
        }
        const results = await this._deliveredResults(owner, now);

        for (const entry of entries) {
            const itemId = entry.contract?.attentionItemId ?? entry.described.attentionItemId ?? null;
            const source = ADAPTERS[entry.kind].resultSource;
            entry.dependsOn = [...new Set([...(entry.described.dependsOn || []), ...(entry.contract?.dependsOn || [])])];
            entry.assessment = assessment.assessProcess({
                described: entry.described,
                contract: entry.contract,
                observations: entry.observations,
                linkedItem: itemId ? items.get(itemId) || null : null,
                results: source ? results.get(`${source}:${entry.id}`) || null : null,
                now
            });
            delete entry.observations;
        }
        assessment.relate(entries, { now });

        const membership = await require('./assistantIncidentService').membership({ userId: owner });
        for (const entry of entries) entry.incident = membership.get(entry.ref) || null;
        return { processes: entries, counts: this._counts(entries) };
    }

    /** Results each process filed in the Inbox lately, and how many were never opened. */
    async _deliveredResults(owner, now) {
        const sources = [...new Set(Object.values(ADAPTERS).map(source => source.resultSource).filter(Boolean))];
        const out = new Map();
        if (!sources.length) return out;
        const rows = await db.all(
            `SELECT sourceType, sourceId, COUNT(*) AS total,
                    SUM(CASE WHEN readAt IS NULL THEN 1 ELSE 0 END) AS unread
             FROM inbox_items
             WHERE userId = @owner AND createdAt >= @since AND sourceType IN (${sources.map(name => `'${name}'`).join(', ')})
             GROUP BY sourceType, sourceId`,
            { owner, since: utcText(new Date(now.getTime() - assessment.DEFAULTS.ignoredWindowSeconds * 1000)) }
        );
        for (const row of rows) out.set(`${row.sourceType}:${row.sourceId}`, { total: Number(row.total), unread: Number(row.unread) });
        return out;
    }

    /** Separate numbers per state; nothing here adds them into one score. */
    _counts(entries) {
        const counts = {
            total: entries.length,
            healthy: 0, degraded: 0, blocked: 0, stalled: 0, unreachable: 0, unknown: 0,
            notWorking: 0, retirementCandidates: 0, reviewDue: 0
        };
        for (const { assessment: judged } of entries) {
            counts[judged.execution] += 1;
            if (assessment.NOT_WORKING.includes(judged.execution)) counts.notWorking += 1;
            if (judged.relevance === 'retirement_candidate') counts.retirementCandidates += 1;
            if (judged.signals.reviewDue) counts.reviewDue += 1;
        }
        return counts;
    }

    /**
     * One process: the adapter's description, its contract (if any), its
     * recent observations, where the process already keeps one its own
     * delivery history, how it is doing and the incident it is part of. A
     * read: it changes nothing.
     */
    async get({ userId, kind, id, limit = OBSERVATION_PAGE, now = new Date() }) {
        const { ref } = await this._resolve(userId, kind, id);
        const size = Math.max(1, Math.min(OBSERVATION_PAGE, Number(limit) || OBSERVATION_PAGE));
        const { processes } = await this.assess({ userId, now });
        const entry = processes.find(candidate => candidate.ref === `${ref.kind}:${ref.id}`);
        if (!entry) throw notFound();
        const observed = await db.all(
            `SELECT * FROM assistant_process_observations
             WHERE processKind = @kind AND processId = @id
             ORDER BY observedAt DESC, id DESC LIMIT @limit`,
            { kind: ref.kind, id: String(ref.id), limit: size }
        );
        const history = ref.adapter.history ? await ref.adapter.history(ref.id, size) : [];
        return {
            process: { kind: ref.kind, id: ref.id, ref: entry.ref, ...entry.described, dependsOn: entry.dependsOn },
            contract: entry.contract,
            observations: observed.map(row => this._presentObservation(row)),
            history,
            assessment: entry.assessment,
            incident: entry.incident
        };
    }

    _contractFields(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('A JSON body is required.');
        const allowed = ['purpose', 'attentionItemId', 'projectId', 'expectedCadenceSeconds', 'freshnessSeconds',
            'quietResultOk', 'criticality', 'reviewAt', 'stopCondition', 'dependsOn', 'expectedRevision'];
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
        let dependsOn = [];
        if (body.dependsOn !== undefined && body.dependsOn !== null) {
            if (!Array.isArray(body.dependsOn) || body.dependsOn.length > DEPENDS_ON_MAX) {
                throw bad(`dependsOn is a list of at most ${DEPENDS_ON_MAX} process references.`);
            }
            dependsOn = [...new Set(body.dependsOn.map((entry) => {
                const [kind, id] = typeof entry === 'string' ? entry.split(':') : [];
                const ref = parseRef(kind, id);
                if (!ref || entry !== `${ref.kind}:${ref.id}`) throw bad('dependsOn entries look like "automation:12".');
                return entry;
            }))];
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
            stopCondition: optionalText(body.stopCondition, 'stopCondition', 1000),
            dependsOnJson: dependsOn.length ? JSON.stringify(dependsOn) : null
        };
    }

    async _validateLinks(userId, fields, self) {
        for (const entry of parseRefs(fields.dependsOnJson)) {
            if (entry === self) throw bad('A process cannot depend on itself.', 'INVALID_LINK');
            const [kind, id] = entry.split(':');
            const described = await ADAPTERS[kind].describe(Number(id));
            if (!described || described.ownerUserId !== String(userId)) {
                throw bad(`dependsOn names ${entry}, which is not one of your processes.`, 'INVALID_LINK');
            }
        }
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
        await this._validateLinks(userId, fields, `${ref.kind}:${ref.id}`);
        return db.transaction(async () => {
            const existing = await db.get(
                'SELECT * FROM assistant_process_contracts WHERE processKind = @kind AND processId = @id',
                { kind: ref.kind, id: String(ref.id) }
            );
            if (!existing) {
                const contractId = await db.insert(
                    `INSERT INTO assistant_process_contracts
                        (ownerUserId, processKind, processId, purpose, attentionItemId, projectId, expectedCadenceSeconds,
                         freshnessSeconds, quietResultOk, criticality, reviewAt, stopCondition, dependsOnJson)
                     VALUES (@owner, @kind, @id, @purpose, @attentionItemId, @projectId, @expectedCadenceSeconds,
                         @freshnessSeconds, @quietResultOk, @criticality, @reviewAt, @stopCondition, @dependsOnJson)`,
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
                    stopCondition = @stopCondition, dependsOnJson = @dependsOnJson,
                    ownerUserId = @owner, revision = revision + 1, updatedAt = @now
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
