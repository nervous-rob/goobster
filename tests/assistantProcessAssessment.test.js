/**
 * Process health and relevance as pure functions (DA-5a, ADR 0019;
 * documentation/process_stewardship.md). No database: the inputs are the
 * adapter's description, the contract and typed observations.
 *
 * The properties under test: health comes only from typed verdicts and
 * never from an absence of errors; a quiet or infrequent process is not a
 * broken one; relevance needs a stated purpose and typed evidence that it
 * ended; an unopened result changes nothing; one upstream cause is one
 * outage, and what depends on a broken process is blocked with it.
 */

const {
    DEFAULTS, EXECUTION, RELEVANCE, assessProcess, incidentWorthy, relate, summarize, isUpstream
} = require('@goobster/core/services/assistant/processes/assessment');

const NOW = new Date('2026-11-10T12:00:00Z');
const DAY = 86400;
const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');

const cron = (overrides = {}) => ({
    name: 'nightly import', enabled: true, trigger: { kind: 'cron', schedule: '0 3 * * *' },
    lastRunAt: at(9 * 3600), nextRunAt: at(-15 * 3600), createdAt: at(200 * DAY), ...overrides
});
const purpose = (overrides = {}) => ({ purpose: 'Keep the ledger current', revision: 1, criticality: 'normal', quietResultOk: false, ...overrides });

/** One `outcome`-phase row per occurrence, oldest first, `step` seconds apart, the newest `step` ago. */
function runs(outcomes, { step = DAY, code = 'RUN_FAILED', phase = 'outcome' } = {}) {
    return outcomes.map((outcome, index) => ({
        occurrenceKey: `fire:${index}`, phase, outcome,
        reasonCode: outcome === 'failed' || outcome === 'blocked' ? code : null,
        observedAt: at((outcomes.length - index) * step)
    }));
}
const judge = (input) => assessProcess({ described: cron(), now: NOW, ...input });

describe('execution', () => {
    test('every verdict is one of the documented states', () => {
        expect(EXECUTION).toEqual(['healthy', 'degraded', 'blocked', 'stalled', 'unreachable', 'unknown']);
        expect(RELEVANCE).toEqual(['active', 'awaiting_event', 'satisfied', 'superseded', 'dormant', 'retirement_candidate', 'unknown']);
    });

    test('nothing observed is unknown, never healthy: an absence of errors is not evidence', () => {
        expect(judge({ observations: [] })).toMatchObject({ execution: 'unknown', reasons: { execution: 'NO_OBSERVATIONS' } });
        // Only skips and deferrals: it never actually ran, so there is still no verdict.
        expect(judge({ observations: runs(['skipped', 'deferred', 'skipped']) }))
            .toMatchObject({ execution: 'unknown', reasons: { execution: 'NO_VERDICT' } });
    });

    test('clean runs are healthy', () => {
        expect(judge({ observations: runs(['ok', 'ok', 'ok']) }))
            .toMatchObject({ execution: 'healthy', reasons: { execution: 'RUNNING_NORMALLY' }, health: { okRun: 3, failRun: 0 } });
    });

    test('a daily import that keeps succeeding with stale output is degraded', () => {
        // It ran every day, and every run said "nothing new" for six days,
        // against a contract that expects something fresh every two.
        const observations = [
            ...runs(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']),
            { occurrenceKey: 'fire:0', phase: 'output', outcome: 'ok', reasonCode: 'CONTENT_CHANGED', observedAt: at(7 * DAY) },
            ...[1, 2, 3, 4, 5, 6].map(index => ({
                occurrenceKey: `fire:${index}`, phase: 'output', outcome: 'skipped', reasonCode: 'NO_CHANGE', observedAt: at((7 - index) * DAY)
            }))
        ];
        const stale = judge({ contract: purpose({ freshnessSeconds: 2 * DAY }), observations });
        expect(stale).toMatchObject({ execution: 'degraded', reasons: { execution: 'OUTPUT_STALE' }, health: { failRun: 0, okRun: 7 } });
        // The same history with no freshness expectation is not judged stale.
        expect(judge({ contract: purpose(), observations }).execution).toBe('healthy');
        // And a run whose output failed its contract is degraded however fresh it is.
        const failedOutput = [
            ...runs(['ok', 'ok']),
            { occurrenceKey: 'fire:1', phase: 'output', outcome: 'failed', reasonCode: 'OUTPUT_CONTRACT_FAILED', observedAt: at(DAY) }
        ];
        expect(judge({ observations: failedOutput })).toMatchObject({
            execution: 'degraded', reasons: { execution: 'OUTPUT_FAILED' }, health: { causeCode: 'OUTPUT_CONTRACT_FAILED' }
        });
    });

    test('a quiet monitor stays healthy: an unchanged result is its success', () => {
        const observations = [
            ...runs(['ok', 'ok', 'ok', 'ok', 'ok']),
            ...[0, 1, 2, 3, 4].map(index => ({
                occurrenceKey: `fire:${index}`, phase: 'output', outcome: 'skipped', reasonCode: 'NO_CHANGE', observedAt: at((5 - index) * DAY)
            }))
        ];
        const monitor = purpose({ quietResultOk: true, freshnessSeconds: 2 * DAY });
        expect(judge({ contract: monitor, observations })).toMatchObject({ execution: 'healthy', relevance: 'active' });
        // Without that declaration the same silence is stale output.
        expect(judge({ contract: purpose({ freshnessSeconds: 2 * DAY }), observations }).execution).toBe('degraded');
    });

    test('a monthly job that has been idle for three weeks is healthy', () => {
        const monthly = cron({
            trigger: { kind: 'cron', schedule: '0 3 1 * *' }, lastRunAt: at(21 * DAY), nextRunAt: at(-9 * DAY)
        });
        const observations = [{ occurrenceKey: 'fire:oct', phase: 'outcome', outcome: 'ok', reasonCode: null, observedAt: at(21 * DAY) }];
        expect(assessProcess({ described: monthly, observations, now: NOW }))
            .toMatchObject({ execution: 'healthy', health: { overdueSeconds: null } });
        // Still healthy with its cadence stated: three weeks is inside two months.
        expect(assessProcess({ described: monthly, contract: purpose({ expectedCadenceSeconds: 30 * DAY }), observations, now: NOW }).execution)
            .toBe('healthy');
    });

    test('a schedule that slipped past its grace, or a stated cadence missed twice over, is stalled', () => {
        const late = cron({ nextRunAt: at(2 * 3600) });
        expect(assessProcess({ described: late, observations: runs(['ok']), now: NOW }))
            .toMatchObject({ execution: 'stalled', reasons: { execution: 'SCHEDULE_OVERDUE' } });
        // Inside the hour of grace it is just about to run.
        expect(assessProcess({ described: cron({ nextRunAt: at(1800) }), observations: runs(['ok']), now: NOW }).execution).toBe('healthy');
        // A polled source gets a day.
        const poll = cron({ trigger: { kind: 'poll', source: 'feed' }, nextRunAt: at(6 * 3600) });
        expect(assessProcess({ described: poll, observations: runs(['ok']), now: NOW }).execution).toBe('healthy');
        const event = cron({ trigger: { kind: 'event', topic: 'job_completed' }, nextRunAt: null, lastRunAt: at(10 * DAY) });
        expect(assessProcess({ described: event, contract: purpose({ expectedCadenceSeconds: 2 * DAY }), observations: [], now: NOW }))
            .toMatchObject({ execution: 'stalled', reasons: { execution: 'CADENCE_MISSED' } });
        // No stated cadence: nothing says an event was due.
        expect(assessProcess({ described: event, contract: purpose(), observations: [], now: NOW }).execution).toBe('unknown');
    });

    test('a stall earns an incident after a day, counting only time the installation was running', () => {
        const judged = (hours) => assessProcess({ described: cron({ nextRunAt: at(hours * 3600) }), observations: runs(['ok']), now: NOW });
        expect(incidentWorthy(judged(2))).toBe(false);
        expect(incidentWorthy(judged(25))).toBe(true);
        // Three days overdue, but nothing could have run it until an hour ago.
        expect(incidentWorthy(judged(72), { upSeconds: 3600 })).toBe(false);
        expect(incidentWorthy(judged(72), { upSeconds: 25 * 3600 })).toBe(true);
    });

    test('one or two failures degrade; three in a row block; a missing target is unreachable', () => {
        expect(judge({ observations: runs(['ok', 'failed']) })).toMatchObject({ execution: 'degraded', reasons: { execution: 'RECENT_FAILURE' } });
        expect(judge({ observations: runs(['ok', 'failed', 'failed']) }).execution).toBe('degraded');
        const blocked = judge({ observations: runs(['ok', 'failed', 'failed', 'failed']) });
        expect(blocked).toMatchObject({
            execution: 'blocked', reasons: { execution: 'FAILING_REPEATEDLY' }, health: { failRun: 3, causeCode: 'RUN_FAILED', upstream: false }
        });
        expect(incidentWorthy(blocked)).toBe(true);
        expect(incidentWorthy(judge({ observations: runs(['failed', 'failed']) }))).toBe(false);
        // Failures count however briefly this installation has been up.
        expect(incidentWorthy(blocked, { upSeconds: 60 })).toBe(true);
        expect(judge({ observations: runs(['failed', 'failed', 'failed'], { code: 'CHANNEL_NOT_FOUND' }) }))
            .toMatchObject({ execution: 'unreachable', reasons: { execution: 'TARGET_UNREACHABLE' } });
        // A process that says it is blocked is believed at once, but one report is not yet an incident.
        const reported = judge({ observations: runs(['ok', 'blocked'], { code: 'ACCOUNT_BUDGET' }) });
        expect(reported).toMatchObject({ execution: 'blocked', reasons: { execution: 'REPORTED_BLOCKED' }, health: { upstream: true } });
        expect(incidentWorthy(reported)).toBe(false);
    });

    test('recovery needs two clean runs: one success after a failing streak is still degraded', () => {
        expect(judge({ observations: runs(['failed', 'failed', 'failed', 'ok']) }))
            .toMatchObject({ execution: 'degraded', reasons: { execution: 'RECOVERING' }, health: { okRun: 1, priorFailRun: 3 } });
        expect(judge({ observations: runs(['failed', 'failed', 'failed', 'ok', 'ok']) }).execution).toBe('healthy');
        // A single blip followed by a success was never an incident, so there is nothing to recover from.
        expect(judge({ observations: runs(['ok', 'failed', 'ok']) }).execution).toBe('healthy');
    });

    test('a retried occurrence is one occurrence: its phases combine, worst verdict first', () => {
        const summary = summarize([
            { occurrenceKey: 'job:1', phase: 'dispatch', outcome: 'ok', reasonCode: 'DISPATCH_DELIVERED', observedAt: at(120) },
            { occurrenceKey: 'job:1', phase: 'execution', outcome: 'failed', reasonCode: 'JOB_TIMED_OUT', observedAt: at(60) },
            { occurrenceKey: 'job:0', phase: 'dispatch', outcome: 'ok', reasonCode: 'DISPATCH_DELIVERED', observedAt: at(DAY) }
        ]);
        expect(summary).toMatchObject({ occurrences: 2, failRun: 1, okRun: 0, failureCode: 'JOB_TIMED_OUT' });
    });

    test('a switched-off process is not judged; a one-shot that ended in failure is blocked for a week', () => {
        expect(judge({ described: cron({ enabled: false }), observations: runs(['failed', 'failed', 'failed']) }))
            .toMatchObject({ execution: 'unknown', reasons: { execution: 'NOT_RUNNING' } });
        const failedWatch = (lastRunAt) => ({
            name: 'tell me when it lands', enabled: false, status: 'FAILED',
            trigger: { kind: 'event', topic: 'observatory.job_completed' }, lastRunAt, nextRunAt: null, createdAt: at(30 * DAY)
        });
        const observations = [{ occurrenceKey: 'fire:1', phase: 'execution', outcome: 'failed', reasonCode: 'FIRE_FAILED', observedAt: at(3600) }];
        expect(assessProcess({ described: failedWatch(at(3600)), observations, now: NOW }))
            .toMatchObject({ execution: 'blocked', reasons: { execution: 'ENDED_IN_FAILURE' } });
        expect(assessProcess({ described: failedWatch(at(8 * DAY)), observations: [], now: NOW }).execution).toBe('unknown');
    });
});

describe('relevance', () => {
    const watch = (overrides = {}) => ({
        name: 'watch the release branch', enabled: true, status: 'ARMED',
        trigger: { kind: 'event', topic: 'observatory.job_completed' }, lastRunAt: null, nextRunAt: null, createdAt: at(20 * DAY), ...overrides
    });

    test('with no stated purpose relevance is unknown, whatever else is true', () => {
        for (const input of [
            { described: cron(), observations: runs(['ok', 'ok']) },
            { described: cron({ enabled: false }) },
            { described: watch(), linkedItem: { state: 'resolved' } },
            { described: watch(), contract: { purpose: null, revision: 1 }, linkedItem: { state: 'resolved' } }
        ]) {
            expect(assessProcess({ now: NOW, ...input })).toMatchObject({
                relevance: 'unknown', purposeKnown: false, reasons: { relevance: 'PURPOSE_UNKNOWN' }
            });
        }
    });

    test('a watch on a merged branch is a retirement candidate under its contract', () => {
        // Typed evidence, either way it arrives: the goal it was armed for is
        // resolved, or its own newest observation says the target was merged.
        const byGoal = assessProcess({ described: watch(), contract: purpose({ purpose: 'Tell me when the release branch is green' }), linkedItem: { state: 'resolved' }, now: NOW });
        expect(byGoal).toMatchObject({ relevance: 'retirement_candidate', reasons: { relevance: 'GOAL_RESOLVED' } });
        const merged = [{ occurrenceKey: 'check:9', phase: 'outcome', outcome: 'skipped', reasonCode: 'TARGET_MERGED', observedAt: at(600) }];
        const byTarget = assessProcess({ described: watch(), contract: purpose(), observations: merged, now: NOW });
        expect(byTarget).toMatchObject({ relevance: 'retirement_candidate', reasons: { relevance: 'TARGET_MERGED' } });
        // Evidence that was followed by more work is not current evidence.
        const reopened = [...merged, { occurrenceKey: 'check:10', phase: 'outcome', outcome: 'ok', reasonCode: null, observedAt: at(60) }];
        expect(assessProcess({ described: watch(), contract: purpose(), observations: reopened, now: NOW }).relevance).toBe('active');
        // Once it is switched off there is nothing left to retire.
        expect(assessProcess({ described: watch({ enabled: false, status: 'CANCELLED' }), contract: purpose(), linkedItem: { state: 'resolved' }, now: NOW }).relevance)
            .toBe('satisfied');
        expect(assessProcess({ described: watch({ enabled: false, status: 'CANCELLED' }), contract: purpose(), linkedItem: { state: 'abandoned' }, now: NOW }).relevance)
            .toBe('superseded');
    });

    test('an ignored result alone gives no retirement authority', () => {
        const ignored = judge({ contract: purpose(), observations: runs(['ok', 'ok', 'ok']), results: { total: 9, unread: 9 } });
        expect(ignored).toMatchObject({
            execution: 'healthy', relevance: 'active', reasons: { relevance: 'PURPOSE_CURRENT' }, signals: { resultsIgnored: true }
        });
        // Read some of them and even the weak signal goes away.
        expect(judge({ contract: purpose(), results: { total: 9, unread: 8 } }).signals.resultsIgnored).toBe(false);
        expect(judge({ contract: purpose(), results: { total: 2, unread: 2 } }).signals.resultsIgnored).toBe(false);
        // With no purpose it is unknown, not a candidate.
        expect(judge({ results: { total: 9, unread: 9 } }).relevance).toBe('unknown');
    });

    test('dormant, awaiting an event, active, and a passed review date', () => {
        expect(judge({ described: cron({ enabled: false }), contract: purpose() }).relevance).toBe('dormant');
        expect(assessProcess({ described: watch(), contract: purpose(), now: NOW }))
            .toMatchObject({ relevance: 'awaiting_event', reasons: { relevance: 'WAITING_FOR_EVENT' } });
        expect(assessProcess({ described: watch({ lastRunAt: at(DAY) }), contract: purpose(), now: NOW }).relevance).toBe('active');
        expect(assessProcess({ described: watch({ enabled: false, status: 'FIRED' }), contract: purpose(), now: NOW }))
            .toMatchObject({ relevance: 'satisfied', reasons: { relevance: 'FIRED_FOR_GOOD' } });
        const due = judge({ contract: purpose({ reviewAt: at(DAY) }) });
        expect(due).toMatchObject({ relevance: 'active', signals: { reviewDue: true } });
        expect(judge({ contract: purpose({ reviewAt: at(-DAY) }) }).signals.reviewDue).toBe(false);
    });
});

describe('what processes mean to each other', () => {
    const entry = (ref, observations, extra = {}) => ({
        ref, described: cron(), dependsOn: [], ...extra,
        assessment: assessProcess({ described: cron(), observations, now: NOW })
    });

    test('one provider outage is one cause: the processes that hit it are blocked together, and their dependents with them', () => {
        const outage = { step: 3600, code: 'PROVIDER_UNAVAILABLE' };
        const entries = relate([
            entry('automation:1', runs(['ok', 'failed', 'failed'], outage)),
            entry('automation:2', runs(['ok', 'ok', 'failed'], outage)),
            entry('automation:3', runs(['ok', 'ok', 'ok'])),
            entry('project_trigger:4', runs(['ok', 'ok']), { dependsOn: ['automation:1'] }),
            entry('project_trigger:5', runs(['ok']), { dependsOn: ['project_trigger:4'] }),
            entry('automation:6', runs(['ok', 'failed'], { step: 3600, code: 'RUN_FAILED' }))
        ], { now: NOW });
        const by = Object.fromEntries(entries.map(item => [item.ref, item.assessment]));
        // Neither had failed three times alone; together it is one outage.
        expect(by['automation:1']).toMatchObject({ execution: 'blocked', reasons: { execution: 'SHARED_CAUSE' }, health: { sharedCause: 'PROVIDER_UNAVAILABLE' } });
        expect(by['automation:2']).toMatchObject({ execution: 'blocked', health: { sharedCause: 'PROVIDER_UNAVAILABLE' } });
        expect(by['automation:3']).toMatchObject({ execution: 'healthy', health: { sharedCause: null } });
        expect(by['project_trigger:4']).toMatchObject({ execution: 'blocked', reasons: { execution: 'DEPENDENCY_BLOCKED' }, health: { blockedBy: 'automation:1' } });
        // Through a chain.
        expect(by['project_trigger:5']).toMatchObject({ execution: 'blocked', health: { blockedBy: 'project_trigger:4' } });
        // A failure with its own cause is its own problem.
        expect(by['automation:6']).toMatchObject({ execution: 'degraded', health: { sharedCause: null } });
    });

    test('the same code a week apart, or a cause that is the process\'s own, is not a shared outage', () => {
        const old = relate([
            entry('automation:1', runs(['failed', 'failed'], { step: 3 * DAY, code: 'PROVIDER_UNAVAILABLE' })),
            entry('automation:2', runs(['failed', 'failed'], { step: 3 * DAY, code: 'PROVIDER_UNAVAILABLE' }))
        ], { now: NOW });
        expect(old.map(item => item.assessment.health.sharedCause)).toEqual([null, null]);
        const own = relate([
            entry('automation:1', runs(['failed', 'failed'], { step: 3600 })),
            entry('automation:2', runs(['failed', 'failed'], { step: 3600 }))
        ], { now: NOW });
        expect(own.map(item => item.assessment.execution)).toEqual(['degraded', 'degraded']);
        expect(isUpstream('FEATURE_UNAVAILABLE')).toBe(true);
        expect(isUpstream('TOKEN_BUDGET')).toBe(true);
        expect(isUpstream('RUN_FAILED')).toBe(false);
        expect(isUpstream(null)).toBe(false);
    });

    test('the defaults are the documented ones', () => {
        expect(DEFAULTS).toMatchObject({
            incidentFailures: 3, recoveryOk: 2, cooldownSeconds: DAY, sharedCauseWindowSeconds: DAY,
            cronGraceSeconds: 3600, pollGraceSeconds: DAY, stalledIncidentSeconds: DAY, cadenceMissFactor: 2,
            activeWindowSeconds: 7 * DAY, terminalFailureWindowSeconds: 7 * DAY, ignoredResults: 3, ignoredWindowSeconds: 30 * DAY
        });
    });
});
