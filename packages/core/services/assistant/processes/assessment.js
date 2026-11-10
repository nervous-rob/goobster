'use strict';

/**
 * Process health and relevance, as pure functions (DA-5a, ADR 0020).
 *
 * A process is judged on two separate axes from typed evidence only:
 *  - execution: healthy, degraded, blocked, stalled, unreachable, unknown
 *  - relevance: active, awaiting_event, satisfied, superseded, dormant,
 *    retirement_candidate, unknown
 *
 * Nothing here reads the database, a clock or a model. The caller hands in
 * the adapter's description of the process, its contract (if any), its
 * recent typed observations and the state of a linked goal; the result is
 * the same for the same inputs. `assistantProcessService.assess()` loads
 * those inputs and `assistantIncidentService` turns the result into
 * incidents.
 *
 * Rules the shape encodes:
 *  - "It ran without an error" is never evidence of health. With no typed
 *    verdict, execution is `unknown`.
 *  - A process with no stated purpose has `unknown` relevance, always.
 *  - A result nobody opened is a weak signal (`signals.resultsIgnored`). It
 *    never changes relevance.
 *
 * Spec: documentation/process_stewardship.md.
 */

/**
 * The numbers the plan left open, with the conservative default taken for
 * each (documentation/process_stewardship.md, "Defaults").
 */
const DEFAULTS = Object.freeze({
    /** Consecutive failed occurrences before a process counts as blocked and an incident opens. */
    incidentFailures: 3,
    /** Consecutive clean occurrences before a process that was failing counts as recovered. */
    recoveryOk: 2,
    /** How long recovery must hold before an incident is resolved; a failure inside it reopens the same incident. */
    cooldownSeconds: 24 * 3600,
    /** Failures with the same upstream cause inside this window are one outage. */
    sharedCauseWindowSeconds: 24 * 3600,
    /** A cron process is stalled once its next run is this far in the past. */
    cronGraceSeconds: 3600,
    /** A polled process is stalled once its next check is this far in the past. */
    pollGraceSeconds: 24 * 3600,
    /** A stall opens an incident only after it has lasted this long. */
    stalledIncidentSeconds: 24 * 3600,
    /** With a stated cadence, a process is stalled after this many cadences without a run. */
    cadenceMissFactor: 2,
    /** An event-triggered process that fired inside this window is `active`, otherwise `awaiting_event`. */
    activeWindowSeconds: 7 * 86400,
    /** A one-shot process that ended in failure stays `blocked` this long, then `unknown`. */
    terminalFailureWindowSeconds: 7 * 86400,
    /** This many delivered results, all unopened, raise the weak "ignored" signal. */
    ignoredResults: 3,
    ignoredWindowSeconds: 30 * 86400
});

const EXECUTION = ['healthy', 'degraded', 'blocked', 'stalled', 'unreachable', 'unknown'];
const RELEVANCE = ['active', 'awaiting_event', 'satisfied', 'superseded', 'dormant', 'retirement_candidate', 'unknown'];
/** Execution states in which a process is not doing its job at all. */
const NOT_WORKING = ['blocked', 'stalled', 'unreachable'];

/**
 * Reason codes that name a cause outside the process itself: a provider, a
 * credential, a budget, a paused or missing platform capability. Processes
 * failing with the same one are one outage, not several problems.
 */
const UPSTREAM_CODE = /^(PROVIDER|UPSTREAM|NETWORK|DNS|CREDENTIALS?|AUTH|QUOTA|ACCOUNT|INSTANCE|GATEWAY|NO_PROVIDER)(_|$)|_(UNAVAILABLE|OUTAGE|TIMEOUT|RATE_LIMITED|NOT_CONFIGURED|EXHAUSTED|PAUSED|BUDGET)$/;
/** Reason codes that say the thing the process acts on is not there. */
const TARGET_MISSING_CODE = /(^|_)(NOT_FOUND|GONE|UNREACHABLE|MISSING|DELETED)$/;
/**
 * Reason codes an adapter records when the thing a process exists for has
 * ended. `satisfied`: it finished. `superseded`: it went away.
 */
const TARGET_ENDED = Object.freeze({
    TARGET_MERGED: 'satisfied',
    TARGET_CLOSED: 'satisfied',
    TARGET_DONE: 'satisfied',
    TARGET_DELETED: 'superseded',
    TARGET_GONE: 'superseded',
    TARGET_SUPERSEDED: 'superseded'
});

/** UTC text (`YYYY-MM-DD HH:MM:SS`) or an ISO string, as epoch milliseconds; null when absent or unreadable. */
function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    const text = String(value);
    const iso = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    return Number.isNaN(parsed) ? null : parsed;
}

function isUpstream(code) {
    return Boolean(code) && UPSTREAM_CODE.test(String(code));
}

/**
 * Group phase rows into occurrences, newest first. Each occurrence gets one
 * run verdict from its non-output phases (failed over blocked over ok;
 * skipped, deferred and unknown are no verdict) and one output state.
 * @param {Array<{ occurrenceKey: string, phase: string, outcome: string, reasonCode?: string|null, observedAt: string }>} observations
 */
function occurrences(observations) {
    const byKey = new Map();
    for (const row of observations || []) {
        const at = toMs(row.observedAt) ?? 0;
        let entry = byKey.get(row.occurrenceKey);
        if (!entry) {
            entry = { key: row.occurrenceKey, at: 0, run: null, code: null, output: null, outputCode: null, targetEnded: null, _rank: 0 };
            byKey.set(row.occurrenceKey, entry);
        }
        if (at > entry.at) entry.at = at;
        if (row.reasonCode && TARGET_ENDED[row.reasonCode]) entry.targetEnded = row.reasonCode;
        if (row.phase === 'output') {
            entry.output = row.outcome === 'ok' ? 'fresh' : (row.outcome === 'failed' || row.outcome === 'blocked') ? 'bad' : 'unchanged';
            entry.outputCode = row.reasonCode || null;
            continue;
        }
        const rank = row.outcome === 'failed' ? 3 : row.outcome === 'blocked' ? 2 : row.outcome === 'ok' ? 1 : 0;
        if (rank > entry._rank) {
            entry._rank = rank;
            entry.run = row.outcome;
            entry.code = row.reasonCode || null;
        }
    }
    return [...byKey.values()]
        .map(({ _rank, ...entry }) => entry)
        .sort((a, b) => b.at - a.at || (a.key < b.key ? 1 : -1));
}

/**
 * What the recent occurrences say, before any contract is applied.
 * `failRun` and `okRun` count the newest consecutive failed-or-blocked and
 * clean occurrences; `priorFailRun` is the failing streak right behind a
 * leading clean one.
 */
function summarize(observations) {
    const list = occurrences(observations);
    const judged = list.filter(entry => entry.run !== null);
    const failing = entry => entry.run === 'failed' || entry.run === 'blocked';
    let failRun = 0;
    while (failRun < judged.length && failing(judged[failRun])) failRun += 1;
    let okRun = 0;
    while (okRun < judged.length && judged[okRun].run === 'ok') okRun += 1;
    let priorFailRun = 0;
    if (okRun > 0) {
        while (okRun + priorFailRun < judged.length && failing(judged[okRun + priorFailRun])) priorFailRun += 1;
    }
    const latest = judged[0] || null;
    const lastOk = judged.find(entry => entry.run === 'ok') || null;
    const lastFailure = judged.find(failing) || null;
    const reporting = list.filter(entry => entry.output !== null);
    const lastFresh = reporting.find(entry => entry.output === 'fresh') || null;
    const lastQuiet = reporting.find(entry => entry.output !== 'bad') || null;
    const ended = list.find(entry => entry.targetEnded) || null;
    return {
        occurrences: list.length,
        judged: judged.length,
        failRun,
        okRun,
        priorFailRun,
        latest: latest ? { run: latest.run, code: latest.code, at: latest.at } : null,
        lastOkAt: lastOk ? lastOk.at : null,
        lastFailureAt: lastFailure ? lastFailure.at : null,
        failureCode: lastFailure ? lastFailure.code : null,
        reportsOutput: reporting.length > 0,
        latestOutput: reporting[0] ? { state: reporting[0].output, code: reporting[0].outputCode, at: reporting[0].at } : null,
        lastFreshAt: lastFresh ? lastFresh.at : null,
        lastQuietAt: lastQuiet ? lastQuiet.at : null,
        firstAt: list.length ? list[list.length - 1].at : null,
        latestAt: list.length ? list[0].at : null,
        // Only the newest occurrence may say the target ended: an older one was followed by more work.
        targetEnded: ended && ended === list[0] ? ended.targetEnded : null
    };
}

/** How far past due a process is, or null. A future `nextRunAt` is never overdue, however long ago the last run was. */
function overdue(described, contract, summary, nowMs, options) {
    const kind = described.trigger?.kind;
    const next = toMs(described.nextRunAt);
    if (next !== null && (kind === 'cron' || kind === 'poll')) {
        const late = (nowMs - next) / 1000;
        if (late > (kind === 'poll' ? options.pollGraceSeconds : options.cronGraceSeconds)) {
            return { reason: 'SCHEDULE_OVERDUE', seconds: Math.floor(late) };
        }
    }
    const cadence = Number(contract?.expectedCadenceSeconds) || 0;
    if (cadence > 0) {
        const last = Math.max(toMs(described.lastRunAt) ?? 0, summary.latestAt ?? 0, toMs(described.createdAt) ?? 0);
        const idle = last > 0 ? (nowMs - last) / 1000 : 0;
        if (idle > cadence * options.cadenceMissFactor) {
            return { reason: 'CADENCE_MISSED', seconds: Math.floor(idle - cadence) };
        }
    }
    return null;
}

function judgeExecution({ described, contract, summary, nowMs, options }) {
    const cause = summary.failureCode || null;
    // Deliberately stopped through stewardship: not running, and not a failure.
    if (described.archived) return { state: 'unknown', reason: 'ARCHIVED', causeCode: null };
    if (described.paused) return { state: 'unknown', reason: 'PAUSED', causeCode: null };
    if (!described.enabled) {
        const lastRun = toMs(described.lastRunAt) ?? summary.lastFailureAt;
        if (described.status === 'FAILED' && lastRun !== null && (nowMs - lastRun) / 1000 <= options.terminalFailureWindowSeconds) {
            return { state: 'blocked', reason: 'ENDED_IN_FAILURE', causeCode: cause };
        }
        return { state: 'unknown', reason: 'NOT_RUNNING', causeCode: null };
    }
    if (summary.failRun >= options.incidentFailures) {
        return TARGET_MISSING_CODE.test(String(cause || ''))
            ? { state: 'unreachable', reason: 'TARGET_UNREACHABLE', causeCode: cause }
            : { state: 'blocked', reason: 'FAILING_REPEATEDLY', causeCode: cause };
    }
    if (summary.latest?.run === 'blocked') return { state: 'blocked', reason: 'REPORTED_BLOCKED', causeCode: cause };
    const late = overdue(described, contract, summary, nowMs, options);
    if (late) return { state: 'stalled', reason: late.reason, causeCode: null, overdueSeconds: late.seconds };
    if (summary.failRun >= 1) return { state: 'degraded', reason: 'RECENT_FAILURE', causeCode: cause };
    if (summary.okRun >= 1 && summary.okRun < options.recoveryOk && summary.priorFailRun >= options.incidentFailures) {
        return { state: 'degraded', reason: 'RECOVERING', causeCode: cause };
    }
    if (summary.latestOutput?.state === 'bad') {
        return { state: 'degraded', reason: 'OUTPUT_FAILED', causeCode: summary.latestOutput.code || null };
    }
    const freshness = Number(contract?.freshnessSeconds) || 0;
    if (freshness > 0 && summary.occurrences > 0) {
        // A process that reports output is fresh when it last produced something
        // (or last checked, for a monitor whose quiet result is the success).
        const freshAt = summary.reportsOutput
            ? (contract.quietResultOk ? summary.lastQuietAt : summary.lastFreshAt)
            : summary.lastOkAt;
        const since = freshAt ?? summary.firstAt;
        if (since !== null && (nowMs - since) / 1000 > freshness) {
            return { state: 'degraded', reason: 'OUTPUT_STALE', causeCode: null };
        }
    }
    if (summary.judged === 0) {
        return { state: 'unknown', reason: summary.occurrences ? 'NO_VERDICT' : 'NO_OBSERVATIONS', causeCode: null };
    }
    return { state: 'healthy', reason: 'RUNNING_NORMALLY', causeCode: null };
}

function judgeRelevance({ described, contract, linkedItem, summary, nowMs, options }) {
    if (!contract?.purpose) return { state: 'unknown', reason: 'PURPOSE_UNKNOWN' };
    let ended = null;
    if (linkedItem?.state === 'resolved') ended = { reason: 'GOAL_RESOLVED', kind: 'satisfied' };
    else if (linkedItem?.state === 'abandoned') ended = { reason: 'GOAL_ABANDONED', kind: 'superseded' };
    else if (summary.targetEnded) ended = { reason: summary.targetEnded, kind: TARGET_ENDED[summary.targetEnded] };
    else if (described.status === 'FIRED') ended = { reason: 'FIRED_FOR_GOOD', kind: 'satisfied' };
    if (ended) {
        // What it was for is over. Still switched on: worth retiring. Already stopped: done.
        return described.enabled
            ? { state: 'retirement_candidate', reason: ended.reason }
            : { state: ended.kind, reason: ended.reason };
    }
    if (!described.enabled) {
        return { state: 'dormant', reason: described.archived ? 'ARCHIVED' : described.paused ? 'PAUSED' : 'NOT_RUNNING' };
    }
    if (described.trigger?.kind === 'event') {
        const last = Math.max(toMs(described.lastRunAt) ?? 0, summary.latestAt ?? 0);
        return last > 0 && (nowMs - last) / 1000 <= options.activeWindowSeconds
            ? { state: 'active', reason: 'FIRED_RECENTLY' }
            : { state: 'awaiting_event', reason: 'WAITING_FOR_EVENT' };
    }
    return { state: 'active', reason: 'PURPOSE_CURRENT' };
}

/**
 * Judge one process on its own evidence.
 *
 * @param {Object} input
 * @param {Object} input.described - the adapter's description (enabled, trigger, lastRunAt, nextRunAt, status, createdAt)
 * @param {Object|null} input.contract - the presented contract, or null
 * @param {Array} input.observations - recent typed observations, any order
 * @param {{ state: string }|null} [input.linkedItem] - the linked Attention item
 * @param {{ total: number, unread: number }|null} [input.results] - delivered results and how many are unopened
 * @param {Date|number} input.now
 * @param {Object} [input.options] - overrides for DEFAULTS
 */
function assessProcess({ described, contract = null, observations = [], linkedItem = null, results = null, now, options = {} }) {
    const settings = { ...DEFAULTS, ...options };
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const summary = summarize(observations);
    const execution = judgeExecution({ described, contract, summary, nowMs, options: settings });
    const relevance = judgeRelevance({ described, contract, linkedItem, summary, nowMs, options: settings });
    const reviewAt = toMs(contract?.reviewAt);
    const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
    return {
        execution: execution.state,
        relevance: relevance.state,
        purposeKnown: Boolean(contract?.purpose),
        reasons: { execution: execution.reason, relevance: relevance.reason },
        signals: {
            reviewDue: reviewAt !== null && reviewAt <= nowMs,
            // Weak: suggests a review, and is never grounds to retire anything.
            resultsIgnored: Boolean(results && results.total >= settings.ignoredResults && results.unread === results.total)
        },
        health: {
            causeCode: execution.causeCode || null,
            upstream: isUpstream(execution.causeCode),
            failRun: summary.failRun,
            okRun: summary.okRun,
            priorFailRun: summary.priorFailRun,
            overdueSeconds: execution.overdueSeconds ?? null,
            lastOkAt: iso(summary.lastOkAt),
            lastFailureAt: iso(summary.lastFailureAt),
            lastFreshAt: iso(summary.lastFreshAt),
            blockedBy: null,
            sharedCause: null
        }
    };
}

/**
 * Whether a process, judged alone, has earned an incident: it has failed
 * `incidentFailures` times running, or has been stalled for
 * `stalledIncidentSeconds`.
 *
 * `options.upSeconds` is how long this installation has been running without
 * a gap. A stall is only held against a process for time in which it could
 * have run, so the stall counts for no longer than that.
 */
function incidentWorthy(assessment, options = {}) {
    const { upSeconds = Infinity, ...overrides } = options;
    const settings = { ...DEFAULTS, ...overrides };
    if (assessment.health.failRun >= settings.incidentFailures) return true;
    if (assessment.execution !== 'stalled') return false;
    return Math.min(assessment.health.overdueSeconds || 0, upSeconds) >= settings.stalledIncidentSeconds;
}

/**
 * Apply what processes mean to each other, in place:
 *  1. Two or more processes whose newest failures carry the same upstream
 *     cause inside the window, with `incidentFailures` failures between
 *     them, are one outage: each is `blocked` with `health.sharedCause`.
 *  2. A process that depends on one that is not working is itself `blocked`
 *     (`DEPENDENCY_BLOCKED`, `health.blockedBy`), through chains.
 *
 * @param {Array<{ ref: string, dependsOn?: string[], assessment: Object }>} entries
 * @param {{ now: Date|number, options?: Object }} context
 * @returns {Array} the same entries
 */
function relate(entries, { now, options = {} }) {
    const settings = { ...DEFAULTS, ...options };
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const byCause = new Map();
    for (const entry of entries) {
        const health = entry.assessment.health;
        const failedAt = toMs(health.lastFailureAt);
        if (health.failRun < 1 || !health.upstream || failedAt === null) continue;
        if ((nowMs - failedAt) / 1000 > settings.sharedCauseWindowSeconds) continue;
        const group = byCause.get(health.causeCode) || [];
        group.push(entry);
        byCause.set(health.causeCode, group);
    }
    for (const [code, group] of byCause) {
        const failures = group.reduce((sum, entry) => sum + entry.assessment.health.failRun, 0);
        if (group.length < 2 || failures < settings.incidentFailures) continue;
        for (const entry of group) {
            entry.assessment.health.sharedCause = code;
            if (!NOT_WORKING.includes(entry.assessment.execution)) {
                entry.assessment.execution = 'blocked';
                entry.assessment.reasons.execution = 'SHARED_CAUSE';
            }
        }
    }
    const byRef = new Map(entries.map(entry => [entry.ref, entry]));
    for (let round = 0; round < 8; round += 1) {
        let changed = false;
        for (const entry of entries) {
            if (NOT_WORKING.includes(entry.assessment.execution) || !entry.described?.enabled) continue;
            const upstream = (entry.dependsOn || [])
                .map(ref => byRef.get(ref))
                .find(dep => dep && dep !== entry && NOT_WORKING.includes(dep.assessment.execution));
            if (!upstream) continue;
            entry.assessment.execution = 'blocked';
            entry.assessment.reasons.execution = 'DEPENDENCY_BLOCKED';
            entry.assessment.health.blockedBy = upstream.ref;
            changed = true;
        }
        if (!changed) break;
    }
    return entries;
}

module.exports = {
    DEFAULTS,
    EXECUTION,
    RELEVANCE,
    NOT_WORKING,
    TARGET_ENDED,
    toMs,
    isUpstream,
    occurrences,
    summarize,
    assessProcess,
    incidentWorthy,
    relate
};
