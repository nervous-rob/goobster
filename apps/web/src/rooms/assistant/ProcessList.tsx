import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useDateLabel } from '../../hooks/useDateLabel';
import type { AssistantProcess, AssistantProcessList, ProcessExecution, ProcessIncident, ProcessRelevance } from '../../lib/types';

/**
 * Processes (documentation/process_stewardship.md): the recurring work a
 * person has set up, with two separate judgments for each. Whether it is
 * working, and whether it is still needed, are never folded into one mark.
 *
 * Read-only. Nothing here pauses, repairs or removes a process; each one is
 * still managed where it was made.
 */

const KIND_TEXT: Record<AssistantProcess['kind'], { label: string; to: string | null }> = {
    automation: { label: 'Scheduled task', to: '/activity/scheduled' },
    project_trigger: { label: 'Project trigger', to: '/projects' },
    attention_watch: { label: 'Watch', to: '/activity/attention' },
    followed_source: { label: 'Followed source', to: null }
};

const EXECUTION_TEXT: Record<ProcessExecution, { text: string; mark: string }> = {
    healthy: { text: 'Working', mark: '○' },
    degraded: { text: 'Running with a problem', mark: '▲' },
    blocked: { text: 'Blocked', mark: '■' },
    stalled: { text: 'Not running on time', mark: '■' },
    unreachable: { text: 'Cannot reach what it acts on', mark: '■' },
    unknown: { text: 'Not enough to judge', mark: '?' }
};

const RELEVANCE_TEXT: Record<ProcessRelevance, string> = {
    active: 'Still needed',
    awaiting_event: 'Waiting for its event',
    satisfied: 'Its purpose is met',
    superseded: 'Its purpose went away',
    dormant: 'Switched off',
    retirement_candidate: 'May no longer be needed',
    unknown: 'Usefulness not judged'
};

/** Why the purpose is over, where the relevance reason says so. */
const ENDED_TEXT: Record<string, string> = {
    GOAL_RESOLVED: 'The goal it was set up for is resolved.',
    GOAL_ABANDONED: 'The goal it was set up for was dropped.',
    TARGET_MERGED: 'What it was watching has been merged.',
    TARGET_CLOSED: 'What it was watching has been closed.',
    TARGET_DONE: 'What it was watching is finished.',
    TARGET_DELETED: 'What it was watching has been deleted.',
    TARGET_GONE: 'What it was watching is gone.',
    TARGET_SUPERSEDED: 'What it was watching has been replaced.',
    FIRED_FOR_GOOD: 'It has fired as many times as it was set to.'
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function executionReason(process: AssistantProcess, nameOf: (ref: string) => string): string {
    const { reasons, health } = process.assessment;
    const code = health.causeCode ? ` (${health.causeCode})` : '';
    switch (reasons.execution) {
        case 'RUNNING_NORMALLY': return 'Its recent runs finished cleanly.';
        case 'RECENT_FAILURE': return `${health.failRun > 1 ? `Its last ${health.failRun} runs failed` : 'Its latest run failed'}${code}.`;
        case 'RECOVERING': return 'It ran cleanly once after failing. One more clean run counts as recovered.';
        case 'OUTPUT_FAILED': return `It ran, but what it produced did not pass its check${code}.`;
        case 'OUTPUT_STALE': return 'It runs, but has produced nothing new in the time its contract expects.';
        case 'FAILING_REPEATEDLY': return `It has failed ${health.failRun} times in a row${code}.`;
        case 'REPORTED_BLOCKED': return `Its latest run was stopped before it could do its work${code}.`;
        case 'ENDED_IN_FAILURE': return `It ended in a failure and is no longer running${code}.`;
        case 'TARGET_UNREACHABLE': return `What it acts on could not be found${code}.`;
        case 'SHARED_CAUSE': return `It is failing for the same reason as other processes${health.sharedCause ? ` (${health.sharedCause})` : ''}.`;
        case 'DEPENDENCY_BLOCKED': return `It waits on ${health.blockedBy ? `"${nameOf(health.blockedBy)}"` : 'another process'}, which is not working.`;
        case 'SCHEDULE_OVERDUE': return 'It is past the time it should have run.';
        case 'CADENCE_MISSED': return 'It has not run as often as its contract expects.';
        case 'NO_OBSERVATIONS': return 'Nothing has been recorded about its runs yet.';
        case 'NO_VERDICT': return 'Its runs recorded nothing that says whether they worked.';
        case 'NOT_RUNNING': return 'It is switched off.';
        default: return '';
    }
}

function relevanceReason(process: AssistantProcess): string {
    const { relevance, reasons } = process.assessment;
    if (reasons.relevance === 'PURPOSE_UNKNOWN') return 'No purpose is recorded for it, so whether it is still useful is not judged.';
    if (ENDED_TEXT[reasons.relevance]) {
        return `${ENDED_TEXT[reasons.relevance]}${relevance === 'retirement_candidate' ? ' It is still switched on.' : ''}`;
    }
    if (reasons.relevance === 'FIRED_RECENTLY') return 'It fired in the last week.';
    if (reasons.relevance === 'WAITING_FOR_EVENT') return 'It has not fired lately. That is normal for something that waits.';
    return '';
}

function incidentTitle(incident: ProcessIncident): string {
    const failing = incident.members.filter((member) => member.role === 'failing');
    const first = `"${failing[0]?.name || 'A process'}"`;
    if (incident.key.startsWith('cause:')) return `${plural(failing.length, 'process', 'processes')} blocked by the same problem`;
    if (incident.causeCode === 'SCHEDULE_OVERDUE' || incident.causeCode === 'CADENCE_MISSED') return `${first} has stopped running`;
    return `${first} keeps failing`;
}

function IncidentRow({ incident }: { incident: ProcessIncident }) {
    const whenLabel = useDateLabel();
    const failing = incident.members.filter((member) => member.role === 'failing');
    const waiting = incident.members.filter((member) => member.role === 'dependent');
    const shared = incident.key.startsWith('cause:');
    const names = (members: ProcessIncident['members']) => members.map((member) => `"${member.name || member.ref}"`).join(', ');
    return (
        <li className="assistant-row process-incident" data-testid="process-incident">
            <div className="assistant-row-main">
                <span className="badge" data-testid="process-incident-status">{incident.status === 'RECOVERING' ? 'Recovering' : 'Open'}</span>{' '}
                <strong>{incidentTitle(incident)}</strong>
                {shared && <div className="hint">{names(failing)}{incident.causeCode ? ` · cause ${incident.causeCode}` : ''}</div>}
                {waiting.length > 0 && <div className="hint">Waiting on it: {names(waiting)}</div>}
                <div className="row-meta">
                    Open since {whenLabel(incident.openedAt)}
                    {incident.status === 'RECOVERING' && incident.recoveringSince
                        ? ` · working again since ${whenLabel(incident.recoveringSince)}; it closes after a day without a failure`
                        : ''}
                </div>
            </div>
        </li>
    );
}

function ProcessRow({ process, nameOf }: { process: AssistantProcess; nameOf: (ref: string) => string }) {
    const whenLabel = useDateLabel();
    const kind = KIND_TEXT[process.kind];
    const judged = process.assessment;
    const execution = EXECUTION_TEXT[judged.execution];
    const why = executionReason(process, nameOf);
    const usefulness = relevanceReason(process);
    // The process's own record of its last run, or failing that the newest run observed.
    const lastRan = process.lastRunAt
        || [judged.health.lastOkAt, judged.health.lastFailureAt].filter(Boolean).sort().pop()
        || null;
    return (
        <div id={`process-${process.kind}-${process.id}`} className={`list-row task-row process-row is-${judged.execution}`}
            data-testid="process-row" data-process={process.ref}>
            <div className="row-body">
                <strong>{process.name}</strong>{' '}
                <span className="row-meta">{kind.label}{process.enabled ? '' : ' · off'}</span>
                <div className="process-judgment" data-testid="process-execution">
                    <span className="process-axis">Working?</span>{' '}
                    <span className="process-state"><span aria-hidden="true">{execution.mark}</span> {execution.text}</span>
                    {why && <span className="hint"> {why}</span>}
                </div>
                <div className="process-judgment" data-testid="process-relevance">
                    <span className="process-axis">Still needed?</span>{' '}
                    <span className="process-state">{RELEVANCE_TEXT[judged.relevance]}</span>
                    {usefulness && <span className="hint"> {usefulness}</span>}
                </div>
                {(judged.signals.reviewDue || judged.signals.resultsIgnored) && (
                    <div className="hint" data-testid="process-signals">
                        {judged.signals.reviewDue && 'The review date you set for it has passed. '}
                        {judged.signals.resultsIgnored && 'Its recent results were not opened. That alone is not a reason to stop it.'}
                    </div>
                )}
                <div className="row-meta">
                    {lastRan ? `Last ran ${whenLabel(lastRan)}` : 'Has not run yet'}
                    {process.nextRunAt && process.enabled ? ` · next ${whenLabel(process.nextRunAt)}` : ''}
                    {process.incident ? ` · part of an ${process.incident.status === 'RECOVERING' ? 'incident that is recovering' : 'open incident'}` : ''}
                </div>
            </div>
            {kind.to && (
                <div className="inbox-actions">
                    <Link to={kind.to as never} className="btn subtle">Manage →</Link>
                </div>
            )}
        </div>
    );
}

/** Not-working first, then problems, then the rest, each group by name. */
const ORDER: ProcessExecution[] = ['blocked', 'unreachable', 'stalled', 'degraded', 'unknown', 'healthy'];

/** Switched off with nothing to report: a finished watch, a paused task. Folded away until asked for. */
const isIdle = (process: AssistantProcess) => !process.enabled && process.assessment.execution === 'unknown' && !process.incident;

export function ProcessList({ data, pending, error }: { data: AssistantProcessList | undefined; pending: boolean; error: Error | null }) {
    const [showIdle, setShowIdle] = useState(false);
    const sorted = [...(data?.processes || [])].sort((a, b) =>
        ORDER.indexOf(a.assessment.execution) - ORDER.indexOf(b.assessment.execution) || a.name.localeCompare(b.name));
    const idle = sorted.filter(isIdle).length;
    const processes = showIdle ? sorted : sorted.filter((process) => !isIdle(process));
    const byRef = new Map(sorted.map((process) => [process.ref, process.name]));
    const nameOf = (ref: string) => byRef.get(ref) || ref;
    const counts = data?.counts;
    const summary: string[] = [];
    if (counts) {
        summary.push(plural(counts.total, 'process', 'processes'));
        if (counts.notWorking) summary.push(`${counts.notWorking} not working`);
        if (counts.degraded) summary.push(`${counts.degraded} running with a problem`);
        if (counts.retirementCandidates) summary.push(`${counts.retirementCandidates} may no longer be needed`);
        if (counts.unknown) summary.push(`${counts.unknown} not enough to judge`);
    }
    return (
        <section id="processes" className="assistant-processes" aria-labelledby="processes-heading" data-testid="assistant-processes">
            <h2 id="processes-heading">Processes</h2>
            <p className="hint" style={{ maxWidth: 720 }}>
                The recurring work you have set up: scheduled tasks, project triggers, watches and followed sources.
                Each is judged twice from what it recorded: whether it is working, and whether it is still needed.
                This is a report. Nothing here changes a process.
            </p>
            {pending && <div className="empty">Loading…</div>}
            {error && <div className="empty" role="alert">{error.message}</div>}
            {data && sorted.length === 0 && <div className="hint" data-testid="processes-empty">No recurring work is set up yet.</div>}
            {data && sorted.length > 0 && <div className="row-meta" data-testid="processes-summary">{summary.join(' · ')}</div>}
            {data && data.incidents.length > 0 && (
                <ul className="assistant-list" style={{ marginTop: 10 }} aria-label="Open incidents">
                    {data.incidents.map((incident) => <IncidentRow key={incident.id} incident={incident} />)}
                </ul>
            )}
            {processes.length > 0 && (
                <div className="list-card" style={{ marginTop: 10 }}>
                    {processes.map((process) => <ProcessRow key={process.ref} process={process} nameOf={nameOf} />)}
                </div>
            )}
            {idle > 0 && (
                <button type="button" className="btn subtle" style={{ marginTop: 10 }} aria-expanded={showIdle}
                    data-testid="processes-show-idle" onClick={() => setShowIdle((value) => !value)}>
                    {showIdle ? 'Hide switched off' : `Show ${idle} switched off`}
                </button>
            )}
        </section>
    );
}
