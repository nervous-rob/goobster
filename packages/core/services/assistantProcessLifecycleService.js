/**
 * Pausing, archiving, restoring and cleaning up processes (DA-5b, ADR 0020).
 *
 * `assistantProcessService` describes and judges a process; this service is
 * the only part of process stewardship that changes one. Retirement goes
 * through explicit stages, each a separate decision:
 *
 *   running -> PAUSED -> ARCHIVED -> CLEANED
 *                 \-> resumed          \-> restored (paused)
 *
 *  - Pause stops future launches in the owning service's own claim, so a
 *    launch cannot slip in behind it. Work that had already started is
 *    counted and left to finish (a followed-source check is dropped
 *    instead, and stores nothing).
 *  - Archive keeps the definition row, its history and a record of how it
 *    ended. It is never a delete. An archived process cannot be switched
 *    on, here or where it was made, until it is restored.
 *  - Restore brings the definition back paused. Resume is a separate act
 *    that checks, at that moment, that the person still reaches it and
 *    that what it depends on is running.
 *  - Cleanup removes only what the process alone derived (its recorded
 *    observations, a followed source's unkept fetched entries and cached
 *    page text), from a manifest of exact row ids frozen at preview. The
 *    definition, the contract, kept and research-linked entries, Inbox
 *    results, delivery records and the jobs it started are never in it.
 *
 * Who may act: the person, on their own processes, through `act()`. The
 * assistant, on the steward pass, may pause a process whose purpose is over
 * when an ACTIVE responsibility grants `process.pause` on exactly that
 * process, and may archive what it paused that way when `process.archive`
 * is granted and it has stayed paused for `ARCHIVE_AFTER_DAYS`. Both are
 * checked with `authorize()` immediately before the change. Without a
 * grant it files a request instead and changes nothing. It never resumes,
 * restores or cleans up, and an unopened result is never a reason to act.
 *
 * Spec: documentation/process_stewardship.md ("Retiring a process").
 */

const { createHash } = require('node:crypto');
const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const { SCHEDULED_WORK } = require('./scheduledWorkRegistry');
const requireOptional = require('../utils/optionalModule').forModule(module);

const STAGES = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'CLEANED'];
const ACTIONS = ['pause', 'resume', 'archive', 'restore', 'keep', 'preview_cleanup', 'cleanup'];
const RELEVANCE_IDENTITY = 'process_relevance:';
const GATE_KIND = 'process_retirement';
/** The assistant archives only what it paused itself, after this long paused with the purpose still over. */
const ARCHIVE_AFTER_DAYS = 7;
/** A previewed cleanup manifest can be applied for this long. */
const MANIFEST_TTL_MS = 60 * 60 * 1000;
/** Rows of one type a single manifest may name; more than this takes another cleanup. */
const MANIFEST_MAX = 5000;
/** A run that recorded a start and no end is counted as running for this long. */
const STARTED_WINDOW_MS = 60 * 60 * 1000;
const DELETE_CHUNK = 400;
const RETIRE_REASON = 'RETIRE_';

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

function quoted(name) {
    return `"${String(name || 'A process').slice(0, 80)}"`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the owning services know how to do, by process kind. */
const OWNERS = {
    automation: {
        service: () => require('./automationManagerService'),
        startedPolicy: 'finish'
    },
    project_trigger: {
        // Owned by the projects feature: absent when that feature is not installed.
        service: () => requireOptional('./projectTriggerService', { feature: 'projects' }),
        startedPolicy: 'finish'
    },
    attention_watch: {
        service: () => require('./attentionWatchService'),
        startedPolicy: 'finish'
    },
    followed_source: {
        service: () => require('./followedSourceService'),
        startedPolicy: 'abandon'
    }
};

class AssistantProcessLifecycleService {
    constructor() {
        this.STAGES = STAGES;
        this.ACTIONS = ACTIONS;
        this.ARCHIVE_AFTER_DAYS = ARCHIVE_AFTER_DAYS;
        this.MANIFEST_TTL_MS = MANIFEST_TTL_MS;
    }

    _error(code, message, status = 409, details = null) {
        const { AssistantProcessError } = require('./assistantProcessService');
        return new AssistantProcessError(code, message, status, details);
    }

    /** The service that owns processes of this kind. */
    _ownerOf(kind) {
        const service = OWNERS[kind]?.service();
        if (!service) throw this._error('UNAVAILABLE', 'What this process belongs to is not available on this installation.');
        return service;
    }

    present(row) {
        if (!row) return null;
        return {
            stage: String(row.stage).toLowerCase(),
            revision: Number(row.revision),
            actor: row.actorKind,
            responsibilityId: row.responsibilityId == null ? null : Number(row.responsibilityId),
            reasonCode: row.reasonCode || null,
            pausedAt: row.pausedAt || null,
            archivedAt: row.archivedAt || null,
            cleanedAt: row.cleanedAt || null,
            resumedAt: row.resumedAt || null,
            started: row.startedPolicy ? { count: Number(row.startedCount || 0), policy: row.startedPolicy } : null,
            final: parseJson(row.finalJson, null),
            cleaned: parseJson(row.cleanedJson, null),
            kept: row.keptRevision == null ? null : { revision: Number(row.keptRevision), reason: row.keptReason || null, at: row.keptAt || null }
        };
    }

    /** Every lifecycle row a person has, by process reference. */
    async forOwner(userId) {
        const rows = await db.all('SELECT * FROM assistant_process_lifecycle WHERE ownerUserId = @owner', { owner: String(userId) });
        return new Map(rows.map(row => [`${row.processKind}:${row.processId}`, row]));
    }

    async _row(kind, id) {
        return db.get(
            'SELECT * FROM assistant_process_lifecycle WHERE processKind = @kind AND processId = @id',
            { kind, id: String(id) }
        );
    }

    /**
     * Create or advance a process's lifecycle row. `seen` is the row this
     * decision was made on (null: none yet); a row that moved since answers
     * REVISION_CONFLICT instead of being overwritten.
     */
    async _write(owner, entry, seen, fields) {
        const now = fields.updatedAt || utcText();
        if (!seen) {
            const columns = {
                stage: 'ACTIVE', actorKind: 'person', responsibilityId: null, reasonCode: null, startedCount: 0, startedPolicy: null,
                pausedAt: null, archivedAt: null, cleanedAt: null, resumedAt: null, finalJson: null, cleanedJson: null,
                keptRevision: null, keptReason: null, keptAt: null, ...fields
            };
            try {
                const id = await db.insert(
                    `INSERT INTO assistant_process_lifecycle
                        (ownerUserId, processKind, processId, name, stage, actorKind, responsibilityId, reasonCode, startedCount,
                         startedPolicy, pausedAt, archivedAt, cleanedAt, resumedAt, finalJson, cleanedJson, keptRevision, keptReason,
                         keptAt, updatedAt)
                     VALUES (@owner, @kind, @id, @name, @stage, @actorKind, @responsibilityId, @reasonCode, @startedCount,
                         @startedPolicy, @pausedAt, @archivedAt, @cleanedAt, @resumedAt, @finalJson, @cleanedJson, @keptRevision,
                         @keptReason, @keptAt, @updatedAt)`,
                    {
                        owner, kind: entry.kind, id: String(entry.id), name: String(entry.described.name || '').slice(0, 200),
                        ...columns, updatedAt: now
                    }
                );
                return db.get('SELECT * FROM assistant_process_lifecycle WHERE id = @id', { id });
            } catch (error) {
                if (!/UNIQUE|duplicate key/i.test(String(error?.message || ''))) throw error;
                throw this._error('REVISION_CONFLICT', 'This process changed while that was being applied. Refresh and try again.');
            }
        }
        const names = Object.keys(fields).filter(key => key !== 'updatedAt');
        const result = await db.run(
            `UPDATE assistant_process_lifecycle SET ${names.map(key => `${key} = @${key}`).join(', ')}${names.length ? ', ' : ''}
                name = @name, revision = revision + 1, updatedAt = @updatedAt
             WHERE id = @rowId AND revision = @expected`,
            {
                ...Object.fromEntries(names.map(key => [key, fields[key]])),
                name: String(entry.described.name || '').slice(0, 200), updatedAt: now, rowId: seen.id, expected: seen.revision
            }
        );
        if (result.changes !== 1) {
            throw this._error('REVISION_CONFLICT', 'This process changed while that was being applied. Refresh and try again.');
        }
        return db.get('SELECT * FROM assistant_process_lifecycle WHERE id = @id', { id: seen.id });
    }

    /** Is the process switched on where it lives (whatever is holding it back from running)? */
    _switchedOn(described) {
        if (described.enabled || described.heldBy === 'attention') return true;
        // A watch in the middle of its turn re-arms afterwards unless it is paused.
        return described.status === 'FIRING' && !described.pausedAt && !described.archived;
    }

    /**
     * A person switched a paused process back on where it was made: the
     * stewardship record follows, it does not fight them.
     */
    async _followNative(owner, entry, row, now) {
        if (!row || row.stage !== 'PAUSED' || !this._switchedOn(entry.described)) return row;
        try {
            // Switching it back on is also the answer to "is it still needed".
            const candidate = entry.assessment.relevance === 'retirement_candidate';
            return await this._write(owner, entry, row, {
                stage: 'ACTIVE', resumedAt: utcText(now), reasonCode: 'RESUMED_ELSEWHERE',
                ...(candidate
                    ? { keptRevision: entry.contract.revision, keptReason: entry.assessment.reasons.relevance, keptAt: utcText(now) }
                    : {}),
                updatedAt: utcText(now)
            });
        } catch (error) {
            if (error.code !== 'REVISION_CONFLICT') throw error;
            return this._row(entry.kind, entry.id);
        }
    }

    /** Other processes of this person that cannot work without `ref` and are not archived. */
    _dependents(entries, ref) {
        return entries
            .filter(entry => entry.ref !== ref && (entry.dependsOn || []).includes(ref) && !entry.described.archived)
            .map(entry => ({ ref: entry.ref, name: entry.described.name, enabled: this._switchedOn(entry.described) }));
    }

    /** What the person may do with this process now. */
    controls(entry, row) {
        const stage = row?.stage || 'ACTIVE';
        if (entry.described.archived || stage === 'ARCHIVED' || stage === 'CLEANED') return ['restore', 'preview_cleanup', 'cleanup'];
        if (this._switchedOn(entry.described)) {
            const kept = row?.keptRevision != null && Number(row.keptRevision) === Number(entry.contract?.revision)
                && row.keptReason === entry.assessment.reasons.relevance;
            return entry.assessment.relevance === 'retirement_candidate' && !kept ? ['pause', 'keep'] : ['pause'];
        }
        if (stage !== 'PAUSED') return ['archive'];
        const ended = entry.kind === 'attention_watch' && !['ARMED', 'FIRING'].includes(entry.described.status);
        return ended ? ['archive'] : ['resume', 'archive'];
    }

    /** One assessed process of the person's, with its lifecycle row brought in line with what it is doing. */
    async _load(userId, kind, id, now) {
        const processes = require('./assistantProcessService');
        const { ref } = await processes._resolve(userId, kind, id);
        const { processes: entries } = await processes.assess({ userId, now });
        const entry = entries.find(candidate => candidate.ref === `${ref.kind}:${ref.id}`);
        if (!entry) throw this._error('NOT_FOUND', 'No such process.', 404);
        const row = await this._followNative(String(userId), entry, await this._row(ref.kind, ref.id), now);
        return { entry, entries, row };
    }

    /** Translate an owning service's refusal into this route's contract. */
    async _owning(fn) {
        try {
            return await fn();
        } catch (error) {
            if (error?.name === 'AssistantProcessError') throw error;
            if (typeof error?.code === 'string' && /^[A-Z_]{2,40}$/.test(error.code)) {
                throw this._error(error.code, error.message, error.status === 404 ? 404 : 409);
            }
            throw error;
        }
    }

    /** Runs that recorded a start and no end lately (automations mark both). */
    async _startedRuns(kind, id, now) {
        const row = await db.get(
            `SELECT COUNT(*) AS n FROM assistant_process_observations started
             WHERE started.processKind = @kind AND started.processId = @id AND started.phase = 'dispatch'
               AND started.reasonCode = 'STARTED' AND started.observedAt >= @since
               AND NOT EXISTS (
                   SELECT 1 FROM assistant_process_observations ended
                   WHERE ended.processKind = started.processKind AND ended.processId = started.processId
                     AND ended.occurrenceKey = started.occurrenceKey AND ended.phase = 'outcome')`,
            { kind, id: String(id), since: utcText(new Date(now.getTime() - STARTED_WINDOW_MS)) }
        );
        return Number(row?.n || 0);
    }

    /**
     * Stop future launches of one process and say what was already running.
     * Shared by the person's action and the assistant's grant path; the
     * caller has already decided the actor may do this.
     */
    async _pause({ owner, entry, row, actorKind, responsibilityId = null, reasonCode, now }) {
        const stage = row?.stage || 'ACTIVE';
        if (entry.described.archived || stage === 'ARCHIVED' || stage === 'CLEANED') {
            throw this._error('ARCHIVED', 'This process is archived. Restore it first.');
        }
        if (!this._switchedOn(entry.described)) {
            if (stage === 'PAUSED') return { row, changed: false, started: this.present(row).started };
            throw this._error('NOT_RUNNING', 'This process is already switched off.');
        }
        const spec = OWNERS[entry.kind];
        const outcome = await this._owning(() => this._ownerOf(entry.kind).stewardPause({ id: entry.id, now: utcText(now) }));
        if (!outcome.changed) throw this._error('CHANGED', 'This process changed while that was being applied. Refresh and try again.');
        const started = outcome.started ?? (entry.kind === 'automation' ? await this._startedRuns(entry.kind, entry.id, now) : 0);
        const written = await this._write(owner, entry, row, {
            stage: 'PAUSED', actorKind, responsibilityId, reasonCode, startedCount: started, startedPolicy: spec.startedPolicy,
            pausedAt: utcText(now), resumedAt: null, updatedAt: utcText(now)
        });
        return { row: written, changed: true, started: { count: started, policy: spec.startedPolicy }, dropped: outcome.dropped || 0 };
    }

    /** How the process stood when it was archived: states, codes and times, never output. */
    _final(entry) {
        const judged = entry.assessment;
        return {
            execution: judged.execution,
            relevance: judged.relevance,
            reasons: judged.reasons,
            lastRunAt: entry.described.lastRunAt || null,
            lastOkAt: judged.health.lastOkAt,
            lastFailureAt: judged.health.lastFailureAt,
            causeCode: judged.health.causeCode
        };
    }

    async _archive({ owner, entry, row, actorKind, responsibilityId = null, reasonCode, now }) {
        const stage = row?.stage || 'ACTIVE';
        if (entry.described.archived && (stage === 'ARCHIVED' || stage === 'CLEANED')) return { row, changed: false };
        if (this._switchedOn(entry.described)) throw this._error('PAUSE_FIRST', 'Pause this process before archiving it.');
        const outcome = await this._owning(() => this._ownerOf(entry.kind).stewardArchive({ id: entry.id, now: utcText(now) }));
        if (!outcome.changed && !entry.described.archived) {
            throw this._error('CHANGED', 'This process changed while that was being applied. Refresh and try again.');
        }
        const written = await this._write(owner, entry, row, {
            stage: 'ARCHIVED', archivedAt: utcText(now), finalJson: JSON.stringify(this._final(entry)),
            ...(stage === 'PAUSED' ? {} : { actorKind, responsibilityId, reasonCode }),
            updatedAt: utcText(now)
        });
        return { row: written, changed: true };
    }

    async _resolveRequest(owner, ref) {
        try {
            await require('./assistantUpdateService').resolveGate({ audience: { userId: owner }, identityKey: `${RELEVANCE_IDENTITY}${ref}` });
        } catch (error) {
            logger.warn?.(`[assistant processes] retirement request not resolved: ${error.message}`);
        }
    }

    /** Does the person still reach the project this process belongs to? */
    async _reachesProject(owner, projectId) {
        if (projectId == null) return true;
        const row = await db.get(
            `SELECT 1 AS ok FROM observatory_projects p WHERE p.id = @id
             AND (p.userId = @owner OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @owner))`,
            { id: Number(projectId), owner }
        );
        return Boolean(row);
    }

    /**
     * The person acts on one of their own processes.
     *
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} params.kind
     * @param {string|number} params.id
     * @param {string} params.action - one of ACTIONS
     * @param {number} [params.expectedRevision] - the lifecycle revision the person saw (0: none yet)
     * @param {number} [params.cleanupId] - `cleanup`: the previewed manifest
     * @param {string} [params.manifestHash] - `cleanup`: its hash, as shown at preview
     * @returns {Promise<Object>} `{ action, changed, lifecycle, controls, ... }`
     */
    async act({ userId, kind, id, action, expectedRevision = undefined, cleanupId = null, manifestHash = null, now = new Date() }) {
        if (!ACTIONS.includes(action)) throw this._error('INVALID_ACTION', `action must be one of ${ACTIONS.join(', ')}.`, 400);
        const owner = String(userId);
        const { entry, entries, row } = await this._load(owner, kind, id, now);
        if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== Number(row?.revision || 0)) {
            throw this._error('REVISION_CONFLICT', 'This process changed since you loaded it.', 409, { revision: Number(row?.revision || 0) });
        }
        const dependents = this._dependents(entries, entry.ref);
        let result;
        switch (action) {
        case 'pause': {
            const paused = await this._pause({ owner, entry, row, actorKind: 'person', reasonCode: 'PERSON', now });
            await this._resolveRequest(owner, entry.ref);
            result = { row: paused.row, changed: paused.changed, started: paused.started, dependents };
            break;
        }
        case 'resume':
            result = await this._resume({ owner, entry, entries, row, now });
            break;
        case 'archive': {
            const archived = await this._archive({ owner, entry, row, actorKind: 'person', reasonCode: 'PERSON', now });
            await this._resolveRequest(owner, entry.ref);
            result = { row: archived.row, changed: archived.changed, dependents };
            break;
        }
        case 'restore':
            result = await this._restore({ owner, entry, row, now });
            break;
        case 'keep':
            result = await this._keep({ owner, entry, row, now });
            break;
        case 'preview_cleanup':
            result = { row, changed: false, cleanup: await this._previewCleanup({ owner, entry, row, now }), dependents };
            break;
        default:
            result = await this._applyCleanup({ owner, entry, entries, row, cleanupId, manifestHash, now });
        }
        const { row: written, ...rest } = result;
        const after = await this._load(owner, kind, id, now);
        return {
            action,
            ...rest,
            process: { kind: entry.kind, id: entry.id, ref: entry.ref, name: entry.described.name, enabled: after.entry.described.enabled },
            lifecycle: this.present(after.row || written),
            controls: this.controls(after.entry, after.row || written)
        };
    }

    /**
     * Resume is checked at the moment it is asked for, not when the process
     * was paused: the person must still reach what it belongs to, and what
     * it depends on must be running.
     */
    async _resume({ owner, entry, entries, row, now }) {
        const stage = row?.stage || 'ACTIVE';
        if (entry.described.archived || stage === 'ARCHIVED' || stage === 'CLEANED') {
            throw this._error('RESTORE_FIRST', 'This process is archived. Restore it, then resume it.');
        }
        if (this._switchedOn(entry.described)) return { row, changed: false };
        if (stage !== 'PAUSED') {
            throw this._error('NOT_PAUSED_HERE', 'This process was switched off where it was made. Switch it back on there.');
        }
        if (!await this._reachesProject(owner, entry.described.projectId ?? null)) {
            throw this._error('RESOURCE_UNAVAILABLE', 'You no longer have access to the project this process belongs to.');
        }
        const byRef = new Map(entries.map(candidate => [candidate.ref, candidate]));
        const blockedBy = (entry.dependsOn || []).filter((ref) => {
            const upstream = byRef.get(ref);
            return !upstream || !this._switchedOn(upstream.described);
        });
        if (blockedBy.length) {
            throw this._error('DEPENDENCY_BLOCKED',
                `It depends on ${blockedBy.map(ref => quoted(byRef.get(ref)?.described.name || ref)).join(', ')}, which ${blockedBy.length === 1 ? 'is' : 'are'} not running. Resume ${blockedBy.length === 1 ? 'that' : 'those'} first.`,
                409, { blockedBy });
        }
        const outcome = await this._owning(() => this._ownerOf(entry.kind).stewardResume({ id: entry.id, userId: owner }));
        // Resuming something whose purpose is over is the person's answer to
        // "is it still needed": it is not asked, or paused, again for that reason.
        const reason = this._endedReason(entry);
        const written = await this._write(owner, entry, row, {
            stage: 'ACTIVE', resumedAt: utcText(now), actorKind: 'person', responsibilityId: null, reasonCode: 'PERSON',
            ...(reason ? { keptRevision: entry.contract.revision, keptReason: reason, keptAt: utcText(now) } : {}),
            updatedAt: utcText(now)
        });
        await this._resolveRequest(owner, entry.ref);
        return { row: written, changed: true, skipped: outcome.skipped || 0 };
    }

    /** Why this process's purpose is over, if it is (whether or not it is switched on). */
    _endedReason(entry) {
        const { TARGET_ENDED } = require('./assistant/processes/assessment');
        const reason = entry.assessment.reasons.relevance;
        if (!entry.contract?.purpose) return null;
        return ['GOAL_RESOLVED', 'GOAL_ABANDONED', 'FIRED_FOR_GOOD'].includes(reason) || TARGET_ENDED[reason] ? reason : null;
    }

    async _restore({ owner, entry, row, now }) {
        const stage = row?.stage || 'ACTIVE';
        if (!entry.described.archived && stage !== 'ARCHIVED' && stage !== 'CLEANED') {
            throw this._error('NOT_ARCHIVED', 'This process is not archived.');
        }
        await this._owning(() => this._ownerOf(entry.kind).stewardRestore({ id: entry.id }));
        const written = await this._write(owner, entry, row, {
            stage: 'PAUSED', actorKind: 'person', responsibilityId: null, reasonCode: 'RESTORED',
            pausedAt: utcText(now), archivedAt: null, startedCount: 0, startedPolicy: null, updatedAt: utcText(now)
        });
        await this._expireManifests(entry, 'INVALIDATED', now);
        // What a cleanup removed is gone: say so instead of implying it came back.
        return { row: written, changed: true, notRestored: parseJson(row?.cleanedJson, null) };
    }

    async _keep({ owner, entry, row, now }) {
        if (entry.assessment.relevance !== 'retirement_candidate') {
            throw this._error('NOT_A_CANDIDATE', 'Nothing suggests this process has outlived its purpose.');
        }
        const written = await this._write(owner, entry, row, {
            keptRevision: entry.contract.revision, keptReason: entry.assessment.reasons.relevance, keptAt: utcText(now), updatedAt: utcText(now)
        });
        await this._resolveRequest(owner, entry.ref);
        return { row: written, changed: true };
    }

    /* ------------------------------------------------------------------ */
    /* Cleanup                                                             */
    /* ------------------------------------------------------------------ */

    /** What identifies the definition a manifest was made for. */
    _definitionHash(entry) {
        const { name, trigger, projectId = null, ownerUserId } = entry.described;
        return createHash('sha256').update(JSON.stringify({ name, trigger, projectId, ownerUserId })).digest('hex');
    }

    _manifestHash(manifest) {
        const { ref, lifecycleRevision, contractRevision, definitionHash, items } = manifest;
        return createHash('sha256')
            .update(JSON.stringify({ ref, lifecycleRevision, contractRevision, definitionHash, items }))
            .digest('hex');
    }

    async _expireManifests(entry, status, now) {
        await db.run(
            `UPDATE assistant_process_cleanups SET status = @status, updatedAt = @now
             WHERE processKind = @kind AND processId = @id AND status = 'PREVIEWED'`,
            { status, now: utcText(now), kind: entry.kind, id: String(entry.id) }
        );
    }

    /**
     * Freeze the exact rows a cleanup of this process may remove, and count
     * what it will leave alone. Everything in `items` is derived by this
     * process alone and can be re-derived or done without; nothing a person
     * wrote, kept or was sent is ever listed.
     */
    async _buildManifest(owner, entry, row) {
        const count = async (sql, params) => Number((await db.get(sql, params))?.n || 0);
        const ids = async (sql, params) => {
            const rows = await db.all(`${sql} ORDER BY id LIMIT ${MANIFEST_MAX + 1}`, params);
            return { ids: rows.slice(0, MANIFEST_MAX).map(item => Number(item.id)), more: rows.length > MANIFEST_MAX };
        };
        const key = { owner, kind: entry.kind, id: String(entry.id) };
        const observations = await ids(
            'SELECT id FROM assistant_process_observations WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id', key
        );
        const items = { observations: observations.ids, sourceEntries: [], sourceCache: false };
        const keeps = { definition: true, contract: Boolean(entry.contract) };
        let more = observations.more;
        const resultSource = require('./assistantProcessService').ADAPTERS[entry.kind].resultSource;
        if (resultSource) {
            keeps.inboxResults = await count(
                'SELECT COUNT(*) AS n FROM inbox_items WHERE userId = @owner AND sourceType = @source AND sourceId = @id',
                { owner, source: resultSource, id: String(entry.id) }
            );
        }
        if (entry.kind === 'project_trigger') {
            keeps.deliveries = await count('SELECT COUNT(*) AS n FROM project_trigger_deliveries WHERE triggerId = @id', { id: entry.id });
            keeps.jobs = await count("SELECT COUNT(*) AS n FROM observatory_jobs WHERE triggerId = @id AND startedBy = 'trigger'", { id: entry.id });
        }
        if (entry.kind === 'followed_source') {
            const fetched = await ids(
                'SELECT id FROM followed_source_entries WHERE sourceId = @id AND kept = 0 AND expeditionId IS NULL', { id: entry.id }
            );
            items.sourceEntries = fetched.ids;
            more = more || fetched.more;
            keeps.keptEntries = await count(
                'SELECT COUNT(*) AS n FROM followed_source_entries WHERE sourceId = @id AND (kept = 1 OR expeditionId IS NOT NULL)', { id: entry.id }
            );
            const cache = await db.get('SELECT lastHash, lastText FROM followed_sources WHERE id = @id', { id: entry.id });
            items.sourceCache = Boolean(cache?.lastHash || cache?.lastText);
        }
        return {
            ref: entry.ref,
            lifecycleRevision: Number(row.revision),
            contractRevision: entry.contract ? Number(entry.contract.revision) : null,
            definitionHash: this._definitionHash(entry),
            items,
            keeps,
            more
        };
    }

    _presentCleanup(record) {
        const manifest = parseJson(record.manifestJson, {});
        return {
            id: Number(record.id),
            status: record.status,
            manifestHash: record.manifestHash,
            expiresAt: record.expiresAt,
            removes: {
                observations: (manifest.items?.observations || []).length,
                sourceEntries: (manifest.items?.sourceEntries || []).length,
                sourceCache: Boolean(manifest.items?.sourceCache)
            },
            keeps: manifest.keeps || {},
            more: Boolean(manifest.more),
            result: parseJson(record.resultJson, null),
            appliedAt: record.appliedAt || null
        };
    }

    _requireArchived(entry, row) {
        if (!row || !entry.described.archived || !['ARCHIVED', 'CLEANED'].includes(row.stage)) {
            throw this._error('ARCHIVE_FIRST', 'Only an archived process can be cleaned up.');
        }
    }

    async _previewCleanup({ owner, entry, row, now }) {
        this._requireArchived(entry, row);
        const manifest = await this._buildManifest(owner, entry, row);
        await this._expireManifests(entry, 'EXPIRED', now);
        const id = await db.insert(
            `INSERT INTO assistant_process_cleanups
                (ownerUserId, processKind, processId, name, status, manifestJson, manifestHash, lifecycleRevision, expiresAt, updatedAt)
             VALUES (@owner, @kind, @id, @name, 'PREVIEWED', @manifestJson, @hash, @lifecycleRevision, @expiresAt, @now)`,
            {
                owner, kind: entry.kind, id: String(entry.id), name: String(entry.described.name || '').slice(0, 200),
                manifestJson: JSON.stringify(manifest), hash: this._manifestHash(manifest), lifecycleRevision: manifest.lifecycleRevision,
                expiresAt: utcText(new Date(now.getTime() + MANIFEST_TTL_MS)), now: utcText(now)
            }
        );
        return this._presentCleanup(await db.get('SELECT * FROM assistant_process_cleanups WHERE id = @id', { id }));
    }

    /** The newest previewed or applied manifest for a process, for the detail read. */
    async latestCleanup(owner, kind, id) {
        const record = await db.get(
            `SELECT * FROM assistant_process_cleanups
             WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id AND status IN ('PREVIEWED', 'APPLIED')
             ORDER BY id DESC LIMIT 1`,
            { owner: String(owner), kind, id: String(id) }
        );
        return record ? this._presentCleanup(record) : null;
    }

    /**
     * Apply a previewed manifest: exactly the rows it names, each delete
     * repeating the ownership test, and only while everything the manifest
     * was made against is unchanged.
     */
    async _applyCleanup({ owner, entry, entries, row, cleanupId, manifestHash, now }) {
        if (!manifestHash || typeof manifestHash !== 'string') {
            throw this._error('MANIFEST_REQUIRED', 'Preview the cleanup first, then confirm it with the manifest it showed.', 400);
        }
        const key = { owner, kind: entry.kind, id: String(entry.id) };
        const record = cleanupId
            ? await db.get(
                'SELECT * FROM assistant_process_cleanups WHERE id = @cleanupId AND ownerUserId = @owner AND processKind = @kind AND processId = @id',
                { ...key, cleanupId: Number(cleanupId) }
            )
            : await db.get(
                `SELECT * FROM assistant_process_cleanups
                 WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id AND manifestHash = @hash
                 ORDER BY id DESC LIMIT 1`,
                { ...key, hash: manifestHash }
            );
        if (!record) throw this._error('MANIFEST_NOT_FOUND', 'No such cleanup preview. Preview it again.', 404);
        if (record.manifestHash !== manifestHash) {
            throw this._error('MANIFEST_MISMATCH', 'That is not the cleanup that was previewed. Preview it again.');
        }
        if (record.status === 'APPLIED') {
            return { row, changed: false, cleanup: this._presentCleanup(record) };
        }
        const stale = async (status, code, message) => {
            await db.run(
                "UPDATE assistant_process_cleanups SET status = @status, updatedAt = @now WHERE id = @id AND status = 'PREVIEWED'",
                { status, now: utcText(now), id: record.id }
            );
            return this._error(code, message);
        };
        if (record.status !== 'PREVIEWED') throw this._error('MANIFEST_STALE', 'That cleanup preview is no longer valid. Preview it again.');
        if (record.expiresAt <= utcText(now)) throw await stale('EXPIRED', 'MANIFEST_EXPIRED', 'That cleanup preview has expired. Preview it again.');
        this._requireArchived(entry, row);
        const manifest = parseJson(record.manifestJson, null);
        if (!manifest
            || Number(manifest.lifecycleRevision) !== Number(row.revision)
            || (manifest.contractRevision ?? null) !== (entry.contract ? Number(entry.contract.revision) : null)
            || manifest.definitionHash !== this._definitionHash(entry)) {
            throw await stale('INVALIDATED', 'MANIFEST_STALE', 'This process changed since the cleanup was previewed. Preview it again.');
        }
        const dependents = this._dependents(entries, entry.ref);
        if (dependents.length) {
            throw this._error('DEPENDENTS_EXIST',
                `${dependents.map(item => quoted(item.name)).join(', ')} still ${dependents.length === 1 ? 'depends' : 'depend'} on this process. Archive ${dependents.length === 1 ? 'it' : 'them'} or remove the dependency first.`,
                409, { dependents });
        }
        const result = await db.transaction(async () => {
            const removed = { observations: 0, sourceEntries: 0, sourceCache: false };
            const chunks = (list) => {
                const out = [];
                const clean = (list || []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
                for (let at = 0; at < clean.length; at += DELETE_CHUNK) out.push(clean.slice(at, at + DELETE_CHUNK));
                return out;
            };
            for (const chunk of chunks(manifest.items.observations)) {
                removed.observations += (await db.run(
                    `DELETE FROM assistant_process_observations
                     WHERE id IN (${chunk.join(', ')}) AND ownerUserId = @owner AND processKind = @kind AND processId = @id`,
                    key
                )).changes || 0;
            }
            if (entry.kind === 'followed_source') {
                // Still archived, still this person's: the predicate is part of every write.
                const mine = 'sourceId IN (SELECT id FROM followed_sources WHERE id = @id AND userId = @owner AND archivedAt IS NOT NULL)';
                for (const chunk of chunks(manifest.items.sourceEntries)) {
                    removed.sourceEntries += (await db.run(
                        `DELETE FROM followed_source_entries
                         WHERE id IN (${chunk.join(', ')}) AND kept = 0 AND expeditionId IS NULL AND ${mine}`,
                        { id: entry.id, owner }
                    )).changes || 0;
                }
                if (manifest.items.sourceCache || manifest.items.sourceEntries.length) {
                    // Without its fetched history the source starts over from a new baseline when it is next checked.
                    const reset = await db.run(
                        `UPDATE followed_sources SET initialized = 0, etag = NULL, lastModified = NULL, lastHash = NULL, lastText = NULL,
                            latestEntryId = CASE WHEN latestEntryId IN (SELECT e.id FROM followed_source_entries e WHERE e.sourceId = @id)
                                THEN latestEntryId ELSE NULL END
                         WHERE id = @id AND userId = @owner AND archivedAt IS NOT NULL`,
                        { id: entry.id, owner }
                    );
                    removed.sourceCache = Boolean(manifest.items.sourceCache) && reset.changes > 0;
                }
            }
            const outcome = {
                removed,
                skipped: {
                    observations: manifest.items.observations.length - removed.observations,
                    sourceEntries: manifest.items.sourceEntries.length - removed.sourceEntries
                },
                kept: manifest.keeps
            };
            const before = parseJson(row.cleanedJson, null);
            const total = {
                observations: Number(before?.observations || 0) + removed.observations,
                sourceEntries: Number(before?.sourceEntries || 0) + removed.sourceEntries,
                sourceCache: Boolean(before?.sourceCache) || removed.sourceCache
            };
            const written = await this._write(owner, entry, row, {
                stage: 'CLEANED', cleanedAt: utcText(now), cleanedJson: JSON.stringify(total), updatedAt: utcText(now)
            });
            await db.run(
                `UPDATE assistant_process_cleanups SET status = 'APPLIED', resultJson = @result, appliedAt = @now, updatedAt = @now
                 WHERE id = @id AND status = 'PREVIEWED'`,
                { id: record.id, result: JSON.stringify(outcome), now: utcText(now) }
            );
            return { written, outcome };
        });
        const applied = await db.get('SELECT * FROM assistant_process_cleanups WHERE id = @id', { id: record.id });
        return { row: result.written, changed: true, cleanup: this._presentCleanup(applied) };
    }

    /* ------------------------------------------------------------------ */
    /* The assistant, on the steward pass                                  */
    /* ------------------------------------------------------------------ */

    /**
     * An ACTIVE responsibility of this person that grants `operation` on
     * exactly this process and would be honoured now, or null. A probe: the
     * caller still calls `authorize()` immediately before it acts.
     */
    async _grantFor(owner, operation, ref, now) {
        const responsibilities = require('./assistantResponsibilityService');
        const rows = await db.all(
            "SELECT id, revision, title, operationsJson FROM assistant_responsibilities WHERE ownerUserId = @owner AND status = 'ACTIVE' ORDER BY id",
            { owner }
        );
        for (const candidate of rows) {
            const grants = parseJson(candidate.operationsJson, []);
            const named = Array.isArray(grants) && grants.some(grant => grant?.operation === operation
                && grant.resource?.kind === 'process' && (grant.resource.ids || []).includes(ref));
            if (!named) continue;
            const request = {
                responsibilityId: candidate.id, revision: candidate.revision, operation,
                resource: { kind: 'process', id: ref }, actorUserId: owner, now
            };
            if ((await responsibilities.wouldAuthorize(request)).ok) return { id: Number(candidate.id), title: candidate.title, request };
        }
        return null;
    }

    async _publish(owner, entry, fields) {
        return require('./assistantUpdateService').publish({
            audience: { userId: owner },
            identityKey: `${RELEVANCE_IDENTITY}${entry.ref}`,
            kind: 'process',
            components: ['processes'],
            evidence: [{ kind: 'process', id: entry.ref }],
            actions: [{ kind: 'open_process', id: entry.ref }],
            deliver: true,
            ...fields
        });
    }

    /** The retirement request's occurrence: a new one each time it is asked again after being answered. */
    async _requestOccurrence(owner, ref) {
        const previous = await db.get(
            'SELECT gateJson, gateResolvedAt FROM assistant_updates WHERE audienceKey = @audienceKey AND identityKey = @identityKey',
            { audienceKey: String(owner), identityKey: `${RELEVANCE_IDENTITY}${ref}` }
        );
        const occurrence = Number(parseJson(previous?.gateJson, null)?.occurrence) || 1;
        return previous?.gateJson && previous.gateResolvedAt ? occurrence + 1 : occurrence;
    }

    /**
     * One person's pass: follow what they changed elsewhere, act on
     * processes whose purpose is over where a grant covers it, ask where
     * none does, and close requests that no longer apply.
     *
     * @param {{ owner: string, entries: Array, now: Date }} params - `entries` from `assess()`
     * @returns {Promise<{ requested: number, paused: number, archived: number }>}
     */
    async steward({ owner, entries, now = new Date() }) {
        const result = { requested: 0, paused: 0, archived: 0 };
        if (features.enforcedOff('assistant')) return result;
        const { ENDED_TEXT } = require('./assistantIncidentService');
        const rows = await this.forOwner(owner);
        const asking = new Set();
        for (const entry of entries) {
            let row = rows.get(entry.ref) || null;
            try {
                row = await this._followNative(owner, entry, row, now);
                if (entry.assessment.relevance === 'retirement_candidate') {
                    const reason = entry.assessment.reasons.relevance;
                    const why = ENDED_TEXT[reason] || 'What it was for is over.';
                    if (row?.keptRevision != null && Number(row.keptRevision) === Number(entry.contract.revision) && row.keptReason === reason) continue;
                    const dependents = this._dependents(entries, entry.ref).filter(item => item.enabled);
                    const grant = dependents.length ? null : await this._grantFor(owner, 'process.pause', entry.ref, now);
                    if (grant && (await require('./assistantResponsibilityService').authorize(grant.request)).ok) {
                        const paused = await this._pause({
                            owner, entry, row, actorKind: 'assistant', responsibilityId: grant.id, reasonCode: `${RETIRE_REASON}${reason}`.slice(0, 64), now
                        });
                        const running = paused.started.count
                            ? ` ${plural(paused.started.count, 'run')} already under way ${paused.started.policy === 'finish' ? 'will finish' : 'stored nothing'}.`
                            : '';
                        await this._publish(owner, entry, {
                            title: `Paused ${quoted(entry.described.name)}`,
                            summary: `${why} I paused it under ${quoted(grant.title)}.${running} Nothing was deleted, and you can resume it from Processes.`,
                            source: { kind: 'process', id: entry.ref, revision: `paused:${paused.row.revision}` },
                            responsibilityId: grant.id,
                            happenedAt: now
                        });
                        await this._resolveRequest(owner, entry.ref);
                        result.paused += 1;
                        continue;
                    }
                    asking.add(entry.ref);
                    const held = dependents.length
                        ? ` ${plural(dependents.length, 'other process', 'other processes')} of yours ${dependents.length === 1 ? 'depends' : 'depend'} on it.`
                        : '';
                    const { changed } = await this._publish(owner, entry, {
                        title: `${quoted(entry.described.name)} may no longer be needed`,
                        summary: `${why} It is still switched on.${held} Nothing was changed: pause it, or say it should keep running.`,
                        source: { kind: 'process', id: entry.ref, revision: `r${entry.contract.revision}:${reason}` },
                        gate: { kind: GATE_KIND, id: entry.ref, occurrence: await this._requestOccurrence(owner, entry.ref) }
                    });
                    if (changed) result.requested += 1;
                    continue;
                }
                if (await this._archiveDue(owner, entry, row, now)) result.archived += 1;
            } catch (error) {
                logger.warn?.(`[assistant processes] stewardship of one process failed: ${error.message}`);
            }
        }
        await this._closeRequests(owner, asking);
        return result;
    }

    /** Archive a process the assistant paused as a retirement, once it has stayed that way long enough and a grant covers it. */
    async _archiveDue(owner, entry, row, now) {
        if (!row || row.stage !== 'PAUSED' || row.actorKind !== 'assistant' || !String(row.reasonCode || '').startsWith(RETIRE_REASON)) return false;
        if (this._switchedOn(entry.described) || entry.described.archived || !this._endedReason(entry)) return false;
        if (!row.pausedAt || row.pausedAt > utcText(new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 86400000))) return false;
        const grant = await this._grantFor(owner, 'process.archive', entry.ref, now);
        if (!grant || !(await require('./assistantResponsibilityService').authorize(grant.request)).ok) return false;
        const archived = await this._archive({
            owner, entry, row, actorKind: 'assistant', responsibilityId: grant.id, reasonCode: row.reasonCode, now
        });
        await this._publish(owner, entry, {
            title: `Archived ${quoted(entry.described.name)}`,
            summary: `It stayed paused for ${ARCHIVE_AFTER_DAYS} days with its purpose still over, so I archived it under ${quoted(grant.title)}. Its settings and history are kept, and you can restore it from Processes.`,
            source: { kind: 'process', id: entry.ref, revision: `archived:${archived.row.revision}` },
            responsibilityId: grant.id,
            happenedAt: now
        });
        return true;
    }

    /** Resolve retirement requests still open for processes that are no longer being asked about. */
    async _closeRequests(owner, asking) {
        const open = await db.all(
            `SELECT identityKey FROM assistant_updates
             WHERE audienceKey = @audienceKey AND identityKey LIKE @prefix AND gateJson IS NOT NULL AND gateResolvedAt IS NULL`,
            { audienceKey: String(owner), prefix: `${RELEVANCE_IDENTITY}%` }
        );
        for (const { identityKey } of open) {
            const ref = String(identityKey).slice(RELEVANCE_IDENTITY.length);
            if (!asking.has(ref)) await this._resolveRequest(owner, ref);
        }
    }

    /**
     * Retention: rows whose process is gone; ACTIVE rows (a resume or a
     * "keep" that is all that is left) untouched for `days`; manifests that
     * were never applied a week after they expired, applied ones after `days`.
     */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        let lifecycle = (await db.run(
            "DELETE FROM assistant_process_lifecycle WHERE stage = 'ACTIVE' AND updatedAt < @cutoff", { cutoff }
        )).changes || 0;
        let cleanups = (await db.run(
            `DELETE FROM assistant_process_cleanups
             WHERE (status = 'APPLIED' AND updatedAt < @cutoff) OR (status <> 'APPLIED' AND expiresAt < @week)`,
            { cutoff, week: utcText(new Date(now.getTime() - 7 * 86400000)) }
        )).changes || 0;
        for (const kind of Object.keys(OWNERS)) {
            const adapter = require('./assistantProcessService').ADAPTERS[kind];
            if (adapter.feature && features.enforcedOff(adapter.feature)) continue;
            const orphan = `processKind = @kind AND NOT EXISTS (SELECT 1 FROM ${SCHEDULED_WORK[kind].table} t WHERE CAST(t.id AS TEXT) = processId)`;
            lifecycle += (await db.run(`DELETE FROM assistant_process_lifecycle WHERE ${orphan}`, { kind })).changes || 0;
            cleanups += (await db.run(`DELETE FROM assistant_process_cleanups WHERE ${orphan}`, { kind })).changes || 0;
        }
        return { lifecycle, cleanups };
    }
}

module.exports = new AssistantProcessLifecycleService();
module.exports.AssistantProcessLifecycleService = AssistantProcessLifecycleService;
module.exports.ACTIONS = ACTIONS;
module.exports.GATE_KIND = GATE_KIND;
module.exports.ARCHIVE_AFTER_DAYS = ARCHIVE_AFTER_DAYS;
module.exports.MANIFEST_TTL_MS = MANIFEST_TTL_MS;
