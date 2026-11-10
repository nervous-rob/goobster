/**
 * Repairing a failing process (DA-5c, ADR 0029).
 *
 * `assistantIncidentService` says a process keeps failing; this service is
 * the only part of process stewardship that tries to make it work again. A
 * repair is one of a closed list of typed actions, applied by code:
 *
 *   rerun            one run now, with nothing about the process changed
 *                    (automations and followed sources)
 *   follow_redirect  point a followed source at the address its own server
 *                    now redirects to (followed sources failing with
 *                    REDIRECT_REFUSED)
 *
 * Nothing else about a process can be repaired: not its prompt, schedule,
 * script, contract or credentials. A repair never switches anything on.
 *
 * Every repair is recorded before it is applied, with what it changes, what
 * it replaced (the rollback plan), which processes it affects, how many
 * attempts are allowed and what will count as proof. Then:
 *
 *   PROPOSED -> VERIFYING -> OBSERVING -> SUCCEEDED
 *        \-> DECLINED | WITHDRAWN    \-> FAILED (rolled back where safe)
 *
 *  - VERIFYING: one run was launched. Proof is read from the process's own
 *    typed observations recorded after the repair, never from a model: a
 *    clean run, output that did not fail (fresh output where the contract
 *    asks for freshness), and no dependent still blocked by it.
 *  - OBSERVING: it was proved once. The next run on the process's own
 *    schedule must work too.
 *  - FAILED: verification failed, timed out or the next normal run failed.
 *    What was changed is put back, unless the person changed it again in
 *    the meantime. When the attempts for this incident are used up the
 *    person is asked what to do, and nothing more is tried.
 *
 * Who may act. The person approves a proposed repair or declines it; that
 * is their own act, on any installation where they have the capability. The
 * assistant applies a repair only from a delegated run whose responsibility
 * grants `process.repair` on exactly this process, checked by `authorize()`
 * at dispatch (assistant/runTools/processRepair.js). Without a grant the
 * steward pass files the one repair that needs no judgement (`rerun`) as a
 * request and changes nothing. The capability (`repair`) is behind the
 * pilot gate, and while the host's stop-all is on the assistant's own
 * repairs are held where they are: nothing is launched, verified or rolled
 * back until it is lifted. A person's own approval is not held.
 *
 * Spec: documentation/process_stewardship.md ("Repair").
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const { SCHEDULED_WORK } = require('./scheduledWorkRegistry');
const assessment = require('./assistant/processes/assessment');

const ACTIONS = ['rerun', 'follow_redirect'];
const REPAIR_IDENTITY = 'process_repair:';
const GATE_KIND = 'process_repair';
const CAPABILITY = 'repair';
const OPERATION = 'process.repair';
/** Attempts per incident when the grant states none, and the most a grant may allow. */
const DEFAULT_ATTEMPTS = 1;
const MAX_ATTEMPTS = 5;
/** How long a launched run has to prove a repair. */
const VERIFY_WINDOW_MS = 60 * 60 * 1000;
/** Where the contract asks for fresh output, verification waits for it this long at most. */
const FRESH_WINDOW_MAX_MS = 24 * 60 * 60 * 1000;
/** How long a proved repair waits for the next normal run before it is closed unobserved. */
const OBSERVE_WINDOW_MS = 30 * 86400000;
/** Recent observation rows remembered at apply, so a later change to one of them is seen. */
const MARKER_ROWS = 12;
const EVIDENCE_ROWS = 60;
const NOTE_CHARS = 400;
const STALL_CODES = ['SCHEDULE_OVERDUE', 'CADENCE_MISSED'];
/**
 * Failure codes that running it again cannot change: the remote server, a
 * setting or a limit refuses the same way every time.
 */
const RERUN_POINTLESS = /(^|_)(REFUSED|DENIED|FORBIDDEN|NOT_FOUND|GONE|MISSING|DELETED|TOO_LARGE|LIMIT|BUDGET|QUOTA|EXHAUSTED|PAUSED|NOT_CONFIGURED|DISABLED|INVALID)$|^NO_PROVIDER|^TARGET_/;

class AssistantProcessRepairError extends Error {
    constructor(code, message, status = 409, details = null) {
        super(message);
        this.name = 'AssistantProcessRepairError';
        this.code = code;
        this.status = status;
        if (details) this.details = details;
    }
}

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
}

function quoted(name) {
    return `"${String(name || 'A process').slice(0, 80)}"`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const coded = code => (code && !STALL_CODES.includes(code) ? ` (${code})` : '');

function hostOf(address) {
    try { return new URL(address).host; } catch { return null; }
}

/**
 * How each kind of process is run once and what it reports. A kind that is
 * not here cannot be repaired: a watch or an event trigger fires on its
 * event, and a cron trigger's fix is in its script.
 */
const KINDS = {
    automation: {
        actions: ['rerun'],
        reportsOutput: false,
        /** Make it due now; the scheduler that owns it runs it. */
        async launch({ id }) {
            await require('./automationManagerService').triggerNow({ id: Number(id) });
            return 'started';
        }
    },
    followed_source: {
        actions: ['rerun', 'follow_redirect'],
        reportsOutput: true,
        /** One check now, under the same limits as the person's own "check now". */
        async launch({ id, owner }) {
            const outcome = await require('./followedSourceService').check({ userId: owner, sourceId: Number(id) });
            return ['waiting', 'paused'].includes(outcome.status) ? 'waiting' : 'ran';
        }
    }
};

/**
 * What a set of observations recorded after a repair says.
 * @param {Array} rows - typed observations (occurrenceKey, phase, outcome, reasonCode, observedAt)
 * @param {{ output: 'not_failed'|'fresh' }} contract
 * @returns {{ state: 'passed'|'failed'|'waiting', code?: string, output?: string|null }}
 */
function judge(rows, contract) {
    const list = assessment.occurrences(rows);
    const failed = list.find(entry => entry.run === 'failed' || entry.run === 'blocked');
    if (failed) return { state: 'failed', code: failed.code || 'RUN_FAILED' };
    const bad = list.find(entry => entry.output === 'bad');
    if (bad) return { state: 'failed', code: bad.outputCode || 'OUTPUT_FAILED' };
    if (!list.some(entry => entry.run === 'ok')) return { state: 'waiting' };
    const fresh = list.some(entry => entry.output === 'fresh');
    if (contract?.output === 'fresh' && !fresh) return { state: 'waiting', ran: true };
    return { state: 'passed', output: fresh ? 'fresh' : (list.find(entry => entry.output)?.output || null) };
}

class AssistantProcessRepairService {
    constructor() {
        this.ACTIONS = ACTIONS;
        this.DEFAULT_ATTEMPTS = DEFAULT_ATTEMPTS;
        this.MAX_ATTEMPTS = MAX_ATTEMPTS;
        this.VERIFY_WINDOW_MS = VERIFY_WINDOW_MS;
    }

    _error(code, message, status = 409, details = null) {
        return new AssistantProcessRepairError(code, message, status, details);
    }

    /** Attempts a grant's budgets allow for one incident. */
    attemptsAllowed(budgets) {
        const stated = budgets?.repairAttempts;
        if (stated === undefined || stated === null) return DEFAULT_ATTEMPTS;
        const n = Number(stated);
        return Number.isSafeInteger(n) && n >= 0 ? Math.min(MAX_ATTEMPTS, n) : DEFAULT_ATTEMPTS;
    }

    present(row) {
        if (!row) return null;
        const patch = parseJson(row.patchJson, {});
        const plan = parseJson(row.planJson, {});
        return {
            id: Number(row.id),
            status: String(row.status).toLowerCase(),
            action: row.action,
            attempt: Number(row.attempt || 0),
            allowed: Number(plan.allowed || 0) || null,
            actor: row.actorKind || null,
            proposedBy: row.proposedBy,
            responsibilityId: row.responsibilityId == null ? null : Number(row.responsibilityId),
            incidentId: row.incidentId == null ? null : Number(row.incidentId),
            diagnosisCode: row.diagnosisCode || null,
            diagnosis: row.diagnosisNote || null,
            // Where a followed source was pointed, for its owner only.
            address: patch.address || null,
            verification: plan.verification || null,
            affected: plan.affected || [],
            rollback: row.rollback || null,
            stopCode: row.stopCode || null,
            direction: row.direction || null,
            appliedAt: row.appliedAt || null,
            verifiedAt: row.verifiedAt || null,
            endedAt: row.endedAt || null,
            createdAt: row.createdAt,
            revision: Number(row.revision)
        };
    }

    async _row(id) {
        return db.get('SELECT * FROM assistant_process_repairs WHERE id = @id', { id: Number(id) });
    }

    /** Compare-and-swap on the row's revision. Returns the new row, or null when it moved. */
    async _update(row, fields, now = new Date()) {
        const names = Object.keys(fields);
        const result = await db.run(
            `UPDATE assistant_process_repairs SET ${names.map(key => `${key} = @${key}`).join(', ')}${names.length ? ', ' : ''}
                revision = revision + 1, updatedAt = @updatedAt
             WHERE id = @rowId AND revision = @expected`,
            { ...fields, updatedAt: utcText(now), rowId: row.id, expected: row.revision }
        );
        if (result.changes !== 1) return null;
        this._announce(row.ownerUserId);
        return this._row(row.id);
    }

    /** A repair was recorded or moved on: the owner's open Processes report reads again (kinds only, never throws). */
    _announce(owner) {
        require('./assistantLiveService').changed(owner, 'update');
    }

    /** A person's repairs of one process, newest first. */
    async history({ userId, kind, id, limit = 10 }) {
        const rows = await db.all(
            `SELECT * FROM assistant_process_repairs WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id
             ORDER BY id DESC LIMIT @limit`,
            { owner: String(userId), kind, id: String(id), limit: Math.max(1, Math.min(50, Number(limit) || 10)) }
        );
        return rows.map(row => this.present(row));
    }

    /**
     * The newest repair of each of a person's processes, with the decision
     * card when it is waiting for them. For the Processes report.
     * @returns {Promise<Map<string, Object>>} by process reference
     */
    async summaries({ userId }) {
        const owner = String(userId);
        const rows = await db.all(
            `SELECT r.* FROM assistant_process_repairs r
             WHERE r.ownerUserId = @owner AND r.id = (
                 SELECT MAX(latest.id) FROM assistant_process_repairs latest
                 WHERE latest.ownerUserId = r.ownerUserId AND latest.processKind = r.processKind AND latest.processId = r.processId)`,
            { owner }
        );
        const out = new Map();
        for (const row of rows) {
            const ref = `${row.processKind}:${row.processId}`;
            const shown = this.present(row);
            shown.ask = null;
            if (row.status === 'PROPOSED' || row.direction === 'asked') {
                try {
                    const update = await db.get(
                        'SELECT id FROM assistant_updates WHERE audienceKey = @owner AND identityKey = @identityKey AND gateJson IS NOT NULL AND gateResolvedAt IS NULL',
                        { owner, identityKey: `${REPAIR_IDENTITY}${ref}` }
                    );
                    if (update) shown.ask = await require('./assistantGateService').card({ userId: owner, ref: update.id });
                } catch (error) {
                    logger.warn?.(`[assistant repair] decision card unavailable: ${error.message}`);
                }
            }
            out.set(ref, shown);
        }
        return out;
    }

    /**
     * An ACTIVE responsibility of this person that grants `process.repair`
     * on exactly this process and would be honoured now, or null. A probe:
     * the run still goes through `authorize()` when it acts.
     */
    async _grantFor(owner, ref, now) {
        const responsibilities = require('./assistantResponsibilityService');
        const rows = await db.all(
            "SELECT id, revision, title, operationsJson, budgetsJson FROM assistant_responsibilities WHERE ownerUserId = @owner AND status = 'ACTIVE' ORDER BY id",
            { owner }
        );
        for (const candidate of rows) {
            const grants = parseJson(candidate.operationsJson, []);
            const named = Array.isArray(grants) && grants.some(grant => grant?.operation === OPERATION
                && grant.resource?.kind === 'process' && (grant.resource.ids || []).includes(ref));
            if (!named) continue;
            const allowed = (await responsibilities.permits({
                responsibilityId: candidate.id, revision: candidate.revision, operation: OPERATION,
                resource: { kind: 'process', id: ref }, actorUserId: owner, now
            })).ok;
            if (allowed) return { id: Number(candidate.id), title: candidate.title, attempts: this.attemptsAllowed(parseJson(candidate.budgetsJson, {})) };
        }
        return null;
    }

    /** Repairs of one incident that were applied. */
    async _used(incidentId) {
        const row = await db.get(
            'SELECT COUNT(*) AS n FROM assistant_process_repairs WHERE incidentId = @incidentId AND appliedAt IS NOT NULL',
            { incidentId: Number(incidentId) }
        );
        return Number(row?.n || 0);
    }

    /** The person's processes as they are now, each with the incident it is in. */
    async _entries(owner, now) {
        const { processes } = await require('./assistantProcessService').assess({ userId: owner, now });
        return processes;
    }

    /**
     * Whether one process can be repaired now, and how. Deterministic: it
     * reads typed state only.
     *
     * @param {Object} params
     * @param {string} params.owner
     * @param {Object} params.entry - from `assess()`, with its current incident
     * @param {number|null} [params.responsibilityId] - the responsibility that would act; null for the person
     * @param {number|null} [params.ignoreId] - a proposal being answered, which does not block itself
     * @returns {Promise<{ ok: boolean, code?: string, incident?: Object, cause?: string|null, actions?: string[],
     *   used?: number, allowed?: number, grant?: Object|null, proposal?: Object|null }>}
     */
    async plan({ owner, entry, responsibilityId = null, ignoreId = null, now = new Date() }) {
        if (features.enforcedOff('assistant')) return { ok: false, code: 'FEATURE_UNAVAILABLE' };
        if (!(await require('./assistantAccessService').allows(owner, CAPABILITY))) return { ok: false, code: 'PILOT_ONLY' };
        if (!entry) return { ok: false, code: 'PROCESS_GONE' };
        const kind = KINDS[entry.kind];
        if (!kind) return { ok: false, code: 'KIND_NOT_REPAIRABLE' };
        if (!entry.described.enabled) return { ok: false, code: 'PROCESS_OFF' };
        const incident = entry.incident;
        if (!incident || incident.key !== `process:${entry.ref}` || incident.role !== 'failing' || incident.status !== 'OPEN'
            || entry.assessment.health.failRun < 1) {
            return { ok: false, code: 'NO_INCIDENT' };
        }
        const cause = entry.assessment.health.causeCode || incident.causeCode || null;
        if (STALL_CODES.includes(incident.causeCode)) return { ok: false, code: 'NOT_A_FAILURE' };
        const open = await db.all(
            `SELECT * FROM assistant_process_repairs WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id
               AND status IN ('PROPOSED', 'VERIFYING', 'OBSERVING') ORDER BY id`,
            { owner, kind: entry.kind, id: String(entry.id) }
        );
        if (open.some(row => row.status !== 'PROPOSED')) return { ok: false, code: 'REPAIR_IN_PROGRESS' };
        const proposal = open.find(row => Number(row.id) !== Number(ignoreId)) || null;
        // A request the run itself filed waits for the person; one the steward filed gives way to a grant.
        if (proposal && (responsibilityId == null || proposal.proposedBy === 'run')) return { ok: false, code: 'AWAITING_PERSON', proposal };

        let grant;
        if (responsibilityId != null) {
            const row = await db.get(
                'SELECT id, title, budgetsJson FROM assistant_responsibilities WHERE id = @id AND ownerUserId = @owner',
                { id: Number(responsibilityId), owner }
            );
            if (!row) return { ok: false, code: 'RESPONSIBILITY_NOT_FOUND' };
            grant = { id: Number(row.id), title: row.title, attempts: this.attemptsAllowed(parseJson(row.budgetsJson, {})) };
        } else {
            grant = await this._grantFor(owner, entry.ref, now);
        }
        // A grant that allows no attempts leaves every repair to the person, one approval at a time.
        const allowed = responsibilityId != null ? grant.attempts : (grant && grant.attempts > 0 ? grant.attempts : DEFAULT_ATTEMPTS);
        const used = await this._used(incident.id);
        if (used >= allowed) return { ok: false, code: 'ATTEMPTS_EXHAUSTED', incident, cause, used, allowed, grant };
        const actions = kind.actions.filter((action) => {
            if (action === 'rerun') return !RERUN_POINTLESS.test(String(cause || ''));
            return cause === 'REDIRECT_REFUSED';
        });
        if (!actions.length) return { ok: false, code: 'NO_REPAIR_KNOWN', incident, cause, used, allowed, grant };
        return { ok: true, incident, cause, actions, used, allowed, grant, proposal };
    }

    /**
     * What a delegated run is told about the process it may repair: typed
     * state, codes and times. The process's name and purpose are the
     * person's own words; nothing here is fetched content.
     */
    async diagnose({ owner, ref, responsibilityId = null, now = new Date() }) {
        const entries = await this._entries(owner, now);
        const entry = entries.find(candidate => candidate.ref === ref) || null;
        const plan = await this.plan({ owner, entry, responsibilityId, now });
        if (!entry) return { ok: false, code: plan.code };
        const observed = await db.all(
            `SELECT occurrenceKey, phase, outcome, reasonCode, observedAt FROM assistant_process_observations
             WHERE processKind = @kind AND processId = @id ORDER BY observedAt DESC, id DESC LIMIT @limit`,
            { kind: entry.kind, id: String(entry.id), limit: EVIDENCE_ROWS }
        );
        const earlier = plan.incident
            ? await db.all(
                'SELECT attempt, action, status, stopCode, rollback FROM assistant_process_repairs WHERE incidentId = @incidentId AND appliedAt IS NOT NULL ORDER BY id',
                { incidentId: plan.incident.id }
            )
            : [];
        return {
            ok: plan.ok,
            code: plan.code || null,
            ref,
            kind: entry.kind,
            name: entry.described.name,
            trigger: entry.described.trigger,
            execution: entry.assessment.execution,
            reason: entry.assessment.reasons.execution,
            cause: plan.cause ?? entry.assessment.health.causeCode ?? null,
            failRun: entry.assessment.health.failRun,
            lastOkAt: entry.assessment.health.lastOkAt,
            lastFailureAt: entry.assessment.health.lastFailureAt,
            purpose: entry.contract?.purpose || null,
            verification: this._contract(entry),
            dependents: entries.filter(candidate => candidate.assessment.health.blockedBy === ref).map(candidate => candidate.described.name),
            occurrences: assessment.occurrences(observed).slice(0, 8).map(item => ({
                at: item.at ? new Date(item.at).toISOString() : null, run: item.run, code: item.code, output: item.output
            })),
            incidentId: plan.incident?.id ?? entry.incident?.id ?? null,
            actions: plan.actions || [],
            attempts: { used: plan.used ?? 0, allowed: plan.allowed ?? 0 },
            earlier: earlier.map(row => ({
                attempt: Number(row.attempt), action: row.action, status: String(row.status).toLowerCase(),
                stopCode: row.stopCode || null, rollback: row.rollback || null
            }))
        };
    }

    /** What will count as proof for this process, from its contract. */
    _contract(entry) {
        const freshness = Number(entry.contract?.freshnessSeconds) || 0;
        const fresh = KINDS[entry.kind]?.reportsOutput && freshness > 0 && !entry.contract?.quietResultOk;
        return {
            run: 'ok',
            output: fresh ? 'fresh' : 'not_failed',
            withinSeconds: Math.floor((fresh ? Math.min(FRESH_WINDOW_MAX_MS, Math.max(VERIFY_WINDOW_MS, freshness * 1000)) : VERIFY_WINDOW_MS) / 1000)
        };
    }

    /** The newest observation rows of a process, as a marker a later read is compared with. */
    async _marker(kind, id) {
        const rows = await db.all(
            `SELECT id, occurrenceKey, phase, outcome, attempts, observedAt FROM assistant_process_observations
             WHERE processKind = @kind AND processId = @id ORDER BY id DESC LIMIT @limit`,
            { kind, id: String(id), limit: MARKER_ROWS }
        );
        const top = await db.get(
            'SELECT MAX(id) AS top FROM assistant_process_observations WHERE processKind = @kind AND processId = @id',
            { kind, id: String(id) }
        );
        return {
            top: Number(top?.top || 0),
            rows: Object.fromEntries(rows.map(row => [`${row.occurrenceKey}|${row.phase}`, [Number(row.attempts), row.observedAt, row.outcome]]))
        };
    }

    /** Observations recorded or re-recorded since a marker was taken. */
    async _evidence(kind, id, marker) {
        const rows = await db.all(
            `SELECT id, occurrenceKey, phase, outcome, reasonCode, attempts, observedAt FROM assistant_process_observations
             WHERE processKind = @kind AND processId = @id ORDER BY id DESC LIMIT @limit`,
            { kind, id: String(id), limit: EVIDENCE_ROWS }
        );
        const known = marker?.rows || {};
        return rows.filter((row) => {
            if (Number(row.id) > Number(marker?.top || 0)) return true;
            const seen = known[`${row.occurrenceKey}|${row.phase}`];
            if (!seen || Number(row.attempts) === Number(seen[0])) return false;
            // A result kept from earlier in the same occurrence (a change found before the repair) is not new.
            return !(row.phase === 'output' && row.outcome === 'ok' && seen[2] === 'ok' && row.observedAt === seen[1]);
        });
    }

    async _publish(owner, row, tag, fields) {
        const ref = `${row.processKind}:${row.processId}`;
        return require('./assistantUpdateService').publish({
            audience: { userId: owner },
            identityKey: `${REPAIR_IDENTITY}${ref}`,
            kind: 'process',
            components: ['processes'],
            source: { kind: 'process', id: ref, revision: `repair:${row.id}:${tag}` },
            evidence: [{ kind: 'process', id: ref }],
            actions: [{ kind: 'open_process', id: ref }],
            deliver: true,
            ...(row.responsibilityId != null ? { responsibilityId: Number(row.responsibilityId) } : {}),
            ...fields
        });
    }

    async _resolveAsk(owner, ref) {
        try {
            await require('./assistantUpdateService').resolveGate({ audience: { userId: owner }, identityKey: `${REPAIR_IDENTITY}${ref}` });
        } catch (error) {
            logger.warn?.(`[assistant repair] request not resolved: ${error.message}`);
        }
    }

    /** What an action does, in the first person, for an update. */
    _did(row) {
        const patch = parseJson(row.patchJson, {});
        if (row.action === 'follow_redirect') return `pointed it at the address it now redirects to (${patch.address})`;
        return 'ran it once more with nothing changed';
    }

    _undone(row) {
        if (row.rollback === 'restored') return 'I put its previous address back.';
        if (row.rollback === 'kept') return 'Its address was changed again after that, so I left it as it is now.';
        return 'Nothing about it was changed, so there is nothing to undo.';
    }

    _why(code) {
        if (code === 'VERIFY_TIMEOUT') return 'no run finished in the time allowed';
        if (code === 'RELAPSED') return 'its next scheduled run failed again';
        if (code === 'DEPENDENTS_STILL_BLOCKED') return 'what depends on it is still blocked';
        return `the run after it failed${coded(code)}`;
    }

    _who(row, grantTitle) {
        if (row.actorKind === 'person') return 'As you approved, I';
        return grantTitle ? `Under ${quoted(grantTitle)}, I` : 'I';
    }

    async _grantTitle(row) {
        if (row.responsibilityId == null) return null;
        const found = await db.get('SELECT title FROM assistant_responsibilities WHERE id = @id', { id: Number(row.responsibilityId) });
        return found?.title || null;
    }

    /**
     * File a repair as a request to the person. Nothing is changed.
     * One request per process at a time; a newer one replaces an older one.
     */
    async _propose({ owner, entry, plan, action, patch = {}, proposedBy, responsibilityId = null, initiativeId = null, note = null, now }) {
        const ref = entry.ref;
        const id = await db.transaction(async (tx) => {
            await tx.run(
                `UPDATE assistant_process_repairs SET status = 'WITHDRAWN', stopCode = 'REPLACED', endedAt = @now, revision = revision + 1, updatedAt = @now
                 WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id AND status = 'PROPOSED'`,
                { owner, kind: entry.kind, id: String(entry.id), now: utcText(now) }
            );
            return tx.insert(
                `INSERT INTO assistant_process_repairs
                    (ownerUserId, processKind, processId, name, incidentId, status, action, diagnosisCode, diagnosisNote, proposedBy,
                     responsibilityId, initiativeId, patchJson, planJson, updatedAt)
                 VALUES (@owner, @kind, @id, @name, @incidentId, 'PROPOSED', @action, @code, @note, @proposedBy,
                     @responsibilityId, @initiativeId, @patch, @plan, @now)`,
                {
                    owner, kind: entry.kind, id: String(entry.id), name: String(entry.described.name || '').slice(0, 200),
                    incidentId: plan.incident.id, action, code: plan.cause, note: note ? String(note).slice(0, NOTE_CHARS) : null,
                    proposedBy, responsibilityId, initiativeId, patch: JSON.stringify(patch),
                    plan: JSON.stringify({ affected: [ref], attempt: plan.used + 1, allowed: plan.allowed, verification: this._contract(entry) }),
                    now: utcText(now)
                }
            );
        });
        this._announce(owner);
        const row = await this._row(id);
        const name = quoted(entry.described.name);
        const failed = `It has failed ${plural(entry.assessment.health.failRun, 'time')} in a row${coded(plan.cause)}.`;
        const wording = action === 'follow_redirect'
            ? {
                title: `${name} has moved: use its new address?`,
                summary: `${failed} Its address now redirects to ${patch.address}, on a different site (${hostOf(patch.address)}), so I did not follow it. Approve to point it there: its first check afterwards only records a starting point, and the old address is put back if that check fails.`
            }
            : {
                title: `${name} keeps failing: run it once more?`,
                summary: `${failed} Running it once now, with nothing about it changed, would show whether the cause has passed. Nothing has been done: approve that, or leave it.`
            };
        await this._publish(owner, row, 'proposed', {
            ...wording,
            gate: { kind: GATE_KIND, id: ref, occurrence: Number(row.id) * 2 },
            happenedAt: now
        });
        return row;
    }

    /**
     * Apply a repair and launch the run that will prove it. The caller has
     * already established who may act; `plan` is this moment's.
     * @returns {Promise<{ applied: boolean, code?: string, row?: Object, proposed?: boolean }>}
     */
    async _start({ owner, entry, plan, action, actor, note = null, proposal = null, now }) {
        const ref = entry.ref;
        const kind = KINDS[entry.kind];
        if (await require('./instanceStateService').isPaused()) return { applied: false, code: 'INSTANCE_PAUSED' };
        let patch = proposal ? parseJson(proposal.patchJson, {}) : {};
        let snapshot = {};
        if (action === 'follow_redirect') {
            const sources = require('./followedSourceService');
            const source = await db.get('SELECT id, url FROM followed_sources WHERE id = @id AND userId = @owner', { id: Number(entry.id), owner });
            if (!source) return { applied: false, code: 'PROCESS_GONE' };
            if (!patch.address) {
                let target;
                try {
                    target = await sources.redirectTarget({ userId: owner, sourceId: source.id });
                } catch (error) {
                    return { applied: false, code: /^[A-Z_]{2,40}$/.test(error?.code || '') ? error.code : 'PROBE_FAILED' };
                }
                if (target.status !== 'redirect') {
                    return { applied: false, code: target.status === 'waiting' ? 'PROBE_DEFERRED' : target.status === 'none' ? 'NO_REDIRECT' : 'REDIRECT_UNUSABLE' };
                }
                patch = { address: target.address };
                // Another site is the person's decision, whoever holds the grant.
                if (!target.sameHost && actor.kind === 'assistant') {
                    const filed = await this._propose({
                        owner, entry, plan, action, patch, proposedBy: 'run', responsibilityId: actor.responsibilityId,
                        initiativeId: actor.initiativeId, note, now
                    });
                    return { applied: false, proposed: true, code: 'NEEDS_APPROVAL', row: filed };
                }
            }
            snapshot = { address: source.url };
        }

        const marker = await this._marker(entry.kind, entry.id);
        const dependents = (await this._entries(owner, now))
            .filter(candidate => candidate.assessment.health.blockedBy === ref).map(candidate => candidate.ref);
        const planned = {
            affected: [ref, ...dependents],
            dependents,
            attempt: plan.used + 1,
            allowed: plan.allowed,
            verification: this._contract(entry),
            rollback: action === 'follow_redirect' ? 'restore_address' : 'none',
            marker
        };
        const fields = {
            status: 'VERIFYING', attempt: planned.attempt, actorKind: actor.kind,
            responsibilityId: actor.responsibilityId ?? null, initiativeId: actor.initiativeId ?? null,
            attemptKey: actor.attemptKey ?? null, patchJson: JSON.stringify(patch), snapshotJson: JSON.stringify(snapshot),
            planJson: JSON.stringify(planned), appliedAt: utcText(now)
        };
        // Recorded before anything is touched: a crash in between leaves a repair to verify, never an unrecorded change.
        let row;
        if (proposal) {
            row = await this._update(proposal, { ...fields, ...(note ? { diagnosisNote: String(note).slice(0, NOTE_CHARS) } : {}) }, now);
            if (!row) return { applied: false, code: 'REVISION_CONFLICT' };
        } else {
            let id;
            try {
                id = await db.transaction(async (tx) => {
                    await tx.run(
                        `UPDATE assistant_process_repairs SET status = 'WITHDRAWN', stopCode = 'REPLACED', endedAt = @now, revision = revision + 1, updatedAt = @now
                         WHERE ownerUserId = @owner AND processKind = @kind AND processId = @id AND status = 'PROPOSED'`,
                        { owner, kind: entry.kind, id: String(entry.id), now: utcText(now) }
                    );
                    return tx.insert(
                        `INSERT INTO assistant_process_repairs
                            (ownerUserId, processKind, processId, name, incidentId, attempt, status, action, diagnosisCode, diagnosisNote, proposedBy,
                             actorKind, responsibilityId, initiativeId, attemptKey, patchJson, snapshotJson, planJson, appliedAt, updatedAt)
                         VALUES (@owner, @kind, @id, @name, @incidentId, @attempt, 'VERIFYING', @action, @code, @note, 'run',
                             @actorKind, @responsibilityId, @initiativeId, @attemptKey, @patchJson, @snapshotJson, @planJson, @appliedAt, @appliedAt)`,
                        {
                            owner, kind: entry.kind, id: String(entry.id), name: String(entry.described.name || '').slice(0, 200),
                            incidentId: plan.incident.id, action, code: plan.cause, note: note ? String(note).slice(0, NOTE_CHARS) : null,
                            attempt: fields.attempt, actorKind: fields.actorKind, responsibilityId: fields.responsibilityId,
                            initiativeId: fields.initiativeId, attemptKey: fields.attemptKey, patchJson: fields.patchJson,
                            snapshotJson: fields.snapshotJson, planJson: fields.planJson, appliedAt: fields.appliedAt
                        }
                    );
                });
            } catch (error) {
                if (!/UNIQUE|duplicate key/i.test(String(error?.message || ''))) throw error;
                // The same run operation, applied already.
                const again = await db.get('SELECT * FROM assistant_process_repairs WHERE attemptKey = @key', { key: actor.attemptKey });
                return { applied: true, row: again };
            }
            this._announce(owner);
            row = await this._row(id);
        }

        if (action === 'follow_redirect') {
            let changed = false;
            let refusal = 'CHANGED';
            try {
                changed = (await require('./followedSourceService').stewardReaddress({ id: entry.id, from: snapshot.address, to: patch.address })).changed;
            } catch (error) {
                refusal = /^[A-Z_]{2,40}$/.test(error?.code || '') ? error.code : 'CHANGE_FAILED';
            }
            if (!changed) {
                // Nothing was touched: it is not an attempt.
                await this._update(row, { status: 'CLOSED', stopCode: refusal, appliedAt: null, rollback: 'none', endedAt: utcText(now) }, now);
                await this._resolveAsk(owner, ref);
                return { applied: false, code: refusal };
            }
        }
        await this._resolveAsk(owner, ref);
        row = await this._launch(row, kind, owner, now);
        const settled = await this._settle(row, { owner, now, inline: true });
        if (settled.status === 'VERIFYING') {
            const title = await this._grantTitle(settled);
            await this._publish(owner, settled, 'verifying', {
                title: `Repairing ${quoted(entry.described.name)}`,
                summary: `${this._who(settled, title)} ${this._did(settled)}. I am checking that the run after it works${planned.rollback === 'none' ? '' : '; if it does not, its previous address is put back'}.${this._noted(settled)}`,
                // Whoever applied it has just been told so: by the answer to their approval, or by the run's own report.
                deliver: false,
                happenedAt: now
            });
        }
        return { applied: true, row: settled };
    }

    _noted(row) {
        return row.diagnosisNote ? ` Diagnosis: ${String(row.diagnosisNote).slice(0, NOTE_CHARS)}` : '';
    }

    /** Ask the owning service for one run now. A launch that could not start is tried again on the next pass. */
    async _launch(row, kind, owner, now) {
        let launch = 'waiting';
        try {
            launch = await kind.launch({ id: row.processId, owner });
        } catch (error) {
            logger.warn?.(`[assistant repair] launch deferred (${error?.code || 'ERROR'})`);
        }
        const result = { ...parseJson(row.resultJson, {}), launch };
        return (await this._update(row, { resultJson: JSON.stringify(result) }, now)) || this._row(row.id);
    }

    /** Put back what a repair changed, where that is still safe. */
    async _rollback(row) {
        if (row.action !== 'follow_redirect') return 'none';
        const patch = parseJson(row.patchJson, {});
        const snapshot = parseJson(row.snapshotJson, {});
        if (!patch.address || !snapshot.address) return 'none';
        try {
            const restored = await require('./followedSourceService').stewardReaddress({ id: row.processId, from: patch.address, to: snapshot.address });
            if (restored.changed) return 'restored';
            const current = await db.get('SELECT url FROM followed_sources WHERE id = @id', { id: Number(row.processId) });
            // Still the old address: the change never landed. Anything else is the person's later choice, which stands.
            return current && current.url === snapshot.address ? 'none' : 'kept';
        } catch {
            return 'kept';
        }
    }

    /**
     * Read what has been observed since a repair was applied and move it on.
     * Never launches a model, and never changes a process except to roll
     * back its own change.
     * @returns {Promise<Object>} the row as it is afterwards
     */
    async _settle(row, { owner, entries = null, now = new Date(), held = false, inline = false }) {
        if (!['VERIFYING', 'OBSERVING'].includes(row.status)) return row;
        // The host's stop-all: what the assistant applied waits exactly where it is.
        if (held && row.actorKind === 'assistant') return row;
        const ref = `${row.processKind}:${row.processId}`;
        const all = entries || await this._entries(owner, now);
        const entry = all.find(candidate => candidate.ref === ref) || null;
        const plan = parseJson(row.planJson, {});
        const close = async (stopCode, rollback) => (await this._update(row, {
            status: 'CLOSED', stopCode, rollback, endedAt: utcText(now)
        }, now)) || this._row(row.id);

        if (row.status === 'OBSERVING') {
            if (!entry) return close('PROCESS_GONE', row.rollback || 'none');
            if (!entry.described.enabled) return close('PROCESS_OFF', row.rollback || 'none');
            const verdict = judge(await this._evidence(row.processKind, row.processId, plan.observeMarker), { output: 'not_failed' });
            if (verdict.state === 'failed') return this._fail(row, entry, 'RELAPSED', { owner, now, cause: verdict.code });
            if (verdict.state === 'passed') {
                const done = await this._update(row, {
                    status: 'SUCCEEDED', endedAt: utcText(now),
                    resultJson: JSON.stringify({ ...parseJson(row.resultJson, {}), observed: { at: utcText(now), run: 'ok' } })
                }, now);
                if (!done) return this._row(row.id);
                await this._publish(owner, done, 'succeeded', {
                    title: `The repair of ${quoted(entry.described.name)} held`,
                    summary: `${this._who(done, await this._grantTitle(done))} ${this._did(done)}. The run after that worked, and so did its next scheduled run.`,
                    deliver: false,
                    happenedAt: now
                });
                return done;
            }
            const since = assessment.toMs(row.verifiedAt) ?? now.getTime();
            return now.getTime() - since > OBSERVE_WINDOW_MS ? close('NOT_OBSERVED', row.rollback || 'none') : row;
        }

        if (!entry) return close('PROCESS_GONE', 'none');
        const contract = plan.verification || { output: 'not_failed', withinSeconds: VERIFY_WINDOW_MS / 1000 };
        const verdict = judge(await this._evidence(row.processKind, row.processId, plan.marker), contract);
        if (verdict.state === 'failed') return this._fail(row, entry, verdict.code, { owner, now });
        if (verdict.state === 'waiting') {
            if (!entry.described.enabled) {
                // Switched off before it could be proved: an unproved change does not stay behind.
                const rollback = await this._rollback(row);
                const closed = await close('PROCESS_OFF', rollback);
                await this._publish(owner, closed, 'closed', {
                    title: `Stopped repairing ${quoted(entry.described.name)}`,
                    summary: `It was switched off before the repair could be checked. ${this._undone(closed)}`,
                    deliver: false,
                    happenedAt: now
                });
                return closed;
            }
            const since = assessment.toMs(row.appliedAt) ?? now.getTime();
            if (now.getTime() - since > Number(contract.withinSeconds || VERIFY_WINDOW_MS / 1000) * 1000) {
                return this._fail(row, entry, 'VERIFY_TIMEOUT', { owner, now });
            }
            // A launch that could not start, or one a crash got in before: ask again.
            if (!inline && !verdict.ran && !['started', 'ran'].includes(parseJson(row.resultJson, {}).launch)) {
                return this._launch(row, KINDS[row.processKind], owner, now);
            }
            return row;
        }
        // It ran clean. What depended on it must be free of it too.
        const blocked = all.filter(candidate => (plan.dependents || []).includes(candidate.ref)
            && candidate.assessment.health.blockedBy === ref);
        if (blocked.length) return this._fail(row, entry, 'DEPENDENTS_STILL_BLOCKED', { owner, now });
        const verified = await this._update(row, {
            status: 'OBSERVING', verifiedAt: utcText(now),
            planJson: JSON.stringify({ ...plan, observeMarker: await this._marker(row.processKind, row.processId) }),
            resultJson: JSON.stringify({
                ...parseJson(row.resultJson, {}),
                verified: { at: utcText(now), run: 'ok', output: verdict.output || null, dependentsFreed: (plan.dependents || []).length }
            })
        }, now);
        if (!verified) return this._row(row.id);
        const freed = (plan.dependents || []).length
            ? ` ${plural(plan.dependents.length, 'process', 'processes')} that depended on it can run again.`
            : '';
        await this._publish(owner, verified, 'verified', {
            title: `Repaired ${quoted(entry.described.name)}`,
            summary: `${this._who(verified, await this._grantTitle(verified))} ${this._did(verified)}, and the run after that worked${verdict.output === 'fresh' ? ' and produced something new' : ''}.${freed} I am watching its next scheduled run before calling it fixed.${this._noted(verified)}`,
            deliver: !inline,
            happenedAt: now
        });
        return verified;
    }

    /** A repair that did not hold: roll back, record, and ask for direction once attempts are used up. */
    async _fail(row, entry, code, { owner, now, cause = null }) {
        const plan = parseJson(row.planJson, {});
        const rollback = await this._rollback(row);
        const used = await this._used(row.incidentId);
        // The question is only worth asking while the problem is still one: a single late failure of a
        // process whose incident has closed is reported, not asked about.
        const incident = await db.get('SELECT status FROM assistant_process_incidents WHERE id = @id', { id: Number(row.incidentId) });
        const exhausted = used >= Number(plan.allowed || DEFAULT_ATTEMPTS) && entry.described.enabled
            && Boolean(incident) && incident.status !== 'RESOLVED';
        const failed = await this._update(row, {
            status: 'FAILED', stopCode: code, rollback, endedAt: utcText(now), direction: exhausted ? 'asked' : null,
            resultJson: JSON.stringify({ ...parseJson(row.resultJson, {}), failed: { at: utcText(now), code, cause: cause || null } })
        }, now);
        if (!failed) return this._row(row.id);
        const name = quoted(entry.described.name);
        const lead = `${this._who(failed, await this._grantTitle(failed))} ${this._did(failed)}, but ${this._why(code)}. ${this._undone(failed)}`;
        if (exhausted) {
            await this._publish(owner, failed, 'exhausted', {
                title: `${name} still fails after ${plural(used, 'repair attempt')}`,
                summary: `${lead} That was ${used === 1 ? 'the only attempt' : `the last of ${used} attempts`} allowed, so I will not try again. Pause it, or leave it running as it is.`,
                gate: { kind: GATE_KIND, id: `${row.processKind}:${row.processId}`, occurrence: Number(failed.id) * 2 + 1 },
                happenedAt: now
            });
        } else {
            await this._publish(owner, failed, 'failed', {
                title: `A repair of ${name} did not work`,
                summary: `${lead} ${used} of ${plural(Number(plan.allowed || DEFAULT_ATTEMPTS), 'attempt')} used.`,
                happenedAt: now
            });
        }
        return failed;
    }

    /** One sentence for the run that applied a repair: what happened so far. */
    _report(row, name) {
        const did = row.action === 'follow_redirect'
            ? `Pointed ${quoted(name)} at the address it now redirects to`
            : `Ran ${quoted(name)} once more to test it`;
        if (row.status === 'OBSERVING' || row.status === 'SUCCEEDED') {
            return `${did}: the run after it worked. Its next scheduled run is watched by the system before it counts as fixed; the person is told either way.`;
        }
        if (row.status === 'FAILED') {
            const undone = row.rollback === 'restored' ? ' The previous address was put back.' : row.rollback === 'kept' ? '' : ' Nothing about it was changed.';
            return `${did}: ${this._why(row.stopCode)}.${undone}${row.direction === 'asked' ? ' No attempts are left; the person has been asked what to do.' : ''}`;
        }
        if (row.status === 'VERIFYING') {
            return `${did}. The result is not in yet: the system checks it, undoes the change if it fails, and tells the person.`;
        }
        return `${did}, and the repair was closed (${row.stopCode || row.status}).`;
    }

    /**
     * A delegated run applies one repair. `authorize()` has allowed
     * `process.repair` on this process for the run's responsibility.
     *
     * @param {Object} params
     * @param {string} params.owner
     * @param {string} params.ref - `<kind>:<id>`, from the run's origin, never from the model
     * @param {string} params.action - one of ACTIONS
     * @param {string} [params.note] - the run's diagnosis, shown to the person
     * @param {number} params.responsibilityId
     * @param {number} [params.initiativeId]
     * @param {string} params.attemptKey - the run operation's identity
     * @returns {Promise<{ applied: boolean, text: string }>} text starts "Not " when nothing was applied
     */
    async repair({ owner, ref, action, note = null, responsibilityId, initiativeId = null, attemptKey, now = new Date() }) {
        const prior = attemptKey ? await db.get('SELECT * FROM assistant_process_repairs WHERE attemptKey = @key', { key: attemptKey }) : null;
        if (prior) return { applied: true, text: this._report(prior, prior.name) };
        if (!ACTIONS.includes(action)) return { applied: false, text: 'Not applied (UNKNOWN_ACTION).' };
        const entries = await this._entries(owner, now);
        const entry = entries.find(candidate => candidate.ref === ref) || null;
        const plan = await this.plan({ owner, entry, responsibilityId, now });
        if (!plan.ok) return { applied: false, text: `Not applied (${plan.code}).` };
        if (!plan.actions.includes(action)) return { applied: false, text: `Not applied (ACTION_NOT_AVAILABLE): only ${plan.actions.join(', ')} can help here.` };
        const started = await this._start({
            owner, entry, plan, action, note, now,
            actor: { kind: 'assistant', responsibilityId: Number(responsibilityId), initiativeId, attemptKey }
        });
        if (started.proposed) {
            return { applied: false, text: 'Not applied (NEEDS_APPROVAL): the new address is on a different site, so the person has been asked to approve it. Nothing was changed.' };
        }
        if (!started.applied) return { applied: false, text: `Not applied (${started.code}).` };
        return { applied: true, text: this._report(started.row, entry.described.name) };
    }

    /** Did the repair this run operation asked for get recorded? For crash recovery. */
    async applied({ attemptKey }) {
        const row = attemptKey ? await db.get('SELECT * FROM assistant_process_repairs WHERE attemptKey = @key', { key: attemptKey }) : null;
        return row ? { row, text: this._report(row, row.name) } : null;
    }

    async _owned(userId, repairId) {
        const row = await this._row(repairId);
        if (!row || row.ownerUserId !== String(userId)) throw this._error('NOT_FOUND', 'No such repair.', 404);
        return row;
    }

    /**
     * The person approves a proposed repair: it is applied as their own act.
     * @returns {Promise<{ message: string, repair: Object }>}
     */
    async approve({ userId, repairId, expectedRevision = null, now = new Date() }) {
        const owner = String(userId);
        const row = await this._owned(owner, repairId);
        if (row.status !== 'PROPOSED') throw this._error('NOT_OPEN', 'This repair is no longer waiting for an answer.');
        if (expectedRevision != null && Number(expectedRevision) !== Number(row.revision)) {
            throw this._error('REVISION_CONFLICT', 'This repair changed since it was shown.');
        }
        const ref = `${row.processKind}:${row.processId}`;
        const entries = await this._entries(owner, now);
        const entry = entries.find(candidate => candidate.ref === ref) || null;
        const plan = await this.plan({ owner, entry, ignoreId: row.id, now });
        if (!plan.ok || !plan.actions.includes(row.action)) {
            await this._withdraw(row, plan.code || 'ACTION_NOT_AVAILABLE', now);
            throw this._error('NOT_OPEN', 'This repair no longer applies: the process is not failing the way it was.');
        }
        const started = await this._start({ owner, entry, plan, action: row.action, actor: { kind: 'person' }, proposal: row, now });
        if (!started.applied) {
            if (started.code === 'REVISION_CONFLICT') throw this._error('REVISION_CONFLICT', 'This repair changed since it was shown.');
            const reasons = {
                INSTANCE_PAUSED: 'This installation is paused, so nothing can be run now.',
                FOLLOW_PAUSED: 'This source is not being checked now. Enable Attention for research and resume it first.',
                DUPLICATE_SOURCE: 'You already follow that address for this topic.',
                CHANGED: 'Its address changed since this was proposed.'
            };
            throw this._error(started.code || 'NOT_APPLIED', reasons[started.code] || 'The repair could not be applied.');
        }
        const after = started.row;
        const name = quoted(entry.described.name);
        const message = after.status === 'OBSERVING' ? `${name} ran, and it worked. Its next scheduled run is being watched.`
            : after.status === 'FAILED' ? `${name} ran and failed again${coded(after.stopCode)}.`
                : `${name} is being run now. You will be told how it went.`;
        return { message, repair: this.present(after) };
    }

    async _withdraw(row, code, now) {
        const done = await this._update(row, { status: 'WITHDRAWN', stopCode: String(code).slice(0, 64), endedAt: utcText(now) }, now);
        if (done) await this._resolveAsk(row.ownerUserId, `${row.processKind}:${row.processId}`);
        return done;
    }

    /** The person declines a proposed repair. It is not offered again for this incident. */
    async decline({ userId, repairId, expectedRevision = null, now = new Date() }) {
        const row = await this._owned(userId, repairId);
        if (row.status !== 'PROPOSED') throw this._error('NOT_OPEN', 'This repair is no longer waiting for an answer.');
        if (expectedRevision != null && Number(expectedRevision) !== Number(row.revision)) {
            throw this._error('REVISION_CONFLICT', 'This repair changed since it was shown.');
        }
        const done = await this._update(row, { status: 'DECLINED', endedAt: utcText(now) }, now);
        if (!done) throw this._error('REVISION_CONFLICT', 'This repair changed since it was shown.');
        await this._resolveAsk(row.ownerUserId, `${row.processKind}:${row.processId}`);
        return { message: `${quoted(row.name)} is left as it is.`, repair: this.present(done) };
    }

    /**
     * The person answers "attempts are used up": pause the process (their
     * own act, through the lifecycle service) or leave it running.
     */
    async direct({ userId, repairId, direction, expectedRevision = null, now = new Date() }) {
        if (!['pause', 'leave'].includes(direction)) throw this._error('INVALID_DIRECTION', 'direction must be pause or leave.', 400);
        const row = await this._owned(userId, repairId);
        if (row.direction !== 'asked') throw this._error('NOT_OPEN', 'This is no longer waiting for an answer.');
        if (expectedRevision != null && Number(expectedRevision) !== Number(row.revision)) {
            throw this._error('REVISION_CONFLICT', 'This changed since it was shown.');
        }
        let message = `${quoted(row.name)} is left running. I will not try to repair it again for this problem.`;
        if (direction === 'pause') {
            const paused = await require('./assistantProcessLifecycleService').act({
                userId: String(userId), kind: row.processKind, id: row.processId, action: 'pause', now
            });
            message = `Paused ${quoted(paused.process.name)}. Nothing new will start, and you can resume it from Processes.`;
        }
        const done = await this._update(row, { direction }, now);
        if (!done) throw this._error('REVISION_CONFLICT', 'This changed since it was shown.');
        await this._resolveAsk(row.ownerUserId, `${row.processKind}:${row.processId}`);
        return { message, repair: this.present(done) };
    }

    /**
     * One person's pass, after incidents were reconciled: move applied
     * repairs on, withdraw requests whose reason went away, and file the
     * one repair that needs no judgement where nothing has been tried and
     * no grant covers the process.
     *
     * @param {{ owner: string, now?: Date, offer?: boolean }} params - `offer` false for a person without Attention
     * @returns {Promise<{ offered: number, verified: number, failed: number, withdrawn: number }>}
     */
    async steward({ owner, now = new Date(), offer = true }) {
        const result = { offered: 0, verified: 0, failed: 0, withdrawn: 0 };
        if (features.enforcedOff('assistant')) return result;
        const live = await db.all(
            `SELECT * FROM assistant_process_repairs WHERE ownerUserId = @owner AND (status IN ('PROPOSED', 'VERIFYING', 'OBSERVING') OR direction = 'asked') ORDER BY id`,
            { owner }
        );
        const allowed = await require('./assistantAccessService').allows(owner, CAPABILITY);
        if (!live.length && (!offer || !allowed)) return result;
        const held = await require('./assistantControlService').isPaused();
        const entries = await this._entries(owner, now);
        const byRef = new Map(entries.map(entry => [entry.ref, entry]));

        for (const row of live) {
            const ref = `${row.processKind}:${row.processId}`;
            try {
                if (row.status === 'VERIFYING' || row.status === 'OBSERVING') {
                    const after = await this._settle(row, { owner, entries, now, held });
                    if (after.status === 'FAILED') result.failed += 1;
                    else if (after.status !== row.status && ['OBSERVING', 'SUCCEEDED'].includes(after.status)) result.verified += 1;
                    continue;
                }
                const entry = byRef.get(ref) || null;
                if (row.status === 'PROPOSED') {
                    const plan = await this.plan({ owner, entry, ignoreId: row.id, now });
                    if (!plan.ok || !plan.actions.includes(row.action) || Number(plan.incident.id) !== Number(row.incidentId)) {
                        if (await this._withdraw(row, plan.code || 'ACTION_NOT_AVAILABLE', now)) result.withdrawn += 1;
                    }
                    continue;
                }
                // Asked for direction: the question goes away with the problem.
                const failing = entry && entry.described.enabled && entry.incident && Number(entry.incident.id) === Number(row.incidentId)
                    && entry.incident.status === 'OPEN';
                if (!failing && await this._update(row, { direction: null }, now)) {
                    await this._resolveAsk(owner, ref);
                    result.withdrawn += 1;
                }
            } catch (error) {
                logger.warn?.(`[assistant repair] one repair could not be moved on: ${error.message}`);
            }
        }

        if (!offer || !allowed) return result;
        for (const entry of entries) {
            if (!KINDS[entry.kind] || !entry.incident) continue;
            try {
                const plan = await this.plan({ owner, entry, now });
                if (!plan.ok || !plan.actions.includes('rerun')) continue;
                // A grant that allows attempts repairs through a delegated run instead.
                if (plan.grant && plan.grant.attempts > 0) continue;
                const before = await db.get(
                    'SELECT 1 AS seen FROM assistant_process_repairs WHERE incidentId = @incidentId LIMIT 1', { incidentId: plan.incident.id }
                );
                if (before) continue;
                await this._propose({ owner, entry, plan, action: 'rerun', proposedBy: 'steward', now });
                result.offered += 1;
            } catch (error) {
                logger.warn?.(`[assistant repair] a repair could not be offered: ${error.message}`);
            }
        }
        return result;
    }

    /**
     * Retention: ended repairs older than `days` that are not waiting for
     * an answer, and repairs of processes that no longer exist.
     */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        let repairs = (await db.run(
            `DELETE FROM assistant_process_repairs
             WHERE endedAt IS NOT NULL AND endedAt < @cutoff AND (direction IS NULL OR direction <> 'asked')`,
            { cutoff }
        )).changes || 0;
        const adapters = require('./assistantProcessService').ADAPTERS;
        for (const kind of Object.keys(adapters)) {
            if (adapters[kind].feature && features.enforcedOff(adapters[kind].feature)) continue;
            repairs += (await db.run(
                `DELETE FROM assistant_process_repairs
                 WHERE processKind = @kind AND NOT EXISTS (SELECT 1 FROM ${SCHEDULED_WORK[kind].table} t WHERE CAST(t.id AS TEXT) = processId)`,
                { kind }
            )).changes || 0;
        }
        return { repairs };
    }
}

module.exports = new AssistantProcessRepairService();
module.exports.AssistantProcessRepairService = AssistantProcessRepairService;
module.exports.AssistantProcessRepairError = AssistantProcessRepairError;
module.exports.ACTIONS = ACTIONS;
module.exports.KINDS = KINDS;
module.exports.GATE_KIND = GATE_KIND;
module.exports.CAPABILITY = CAPABILITY;
module.exports.REPAIR_IDENTITY = REPAIR_IDENTITY;
module.exports.DEFAULT_ATTEMPTS = DEFAULT_ATTEMPTS;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
module.exports.VERIFY_WINDOW_MS = VERIFY_WINDOW_MS;
module.exports.judge = judge;
