import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { useDateLabel } from '../../hooks/useDateLabel';
import { GateDecision } from '../../components/GateDecision';
import type {
    AssistantProcess, AssistantProcessList, ProcessAction, ProcessActionResult, ProcessCleanup, ProcessExecution,
    ProcessIncident, ProcessRelevance, ProcessRepair
} from '../../lib/types';

/**
 * Processes (documentation/process_stewardship.md): the recurring work a
 * person has set up, with two separate judgments for each. Whether it is
 * working, and whether it is still needed, are never folded into one mark.
 *
 * A process can be paused, resumed, archived and restored here. Nothing on
 * this page deletes one: archiving keeps the process and its history, and
 * cleaning up an archived process first shows exactly what it would remove.
 *
 * A failing process may carry a repair: one typed action (run it once more,
 * or point a followed source at the address it now redirects to) that is
 * checked against the process's own next run and undone if it fails. A
 * repair that waits for the person is answered here with the same decision
 * card Home and the Inbox show. Anything else about a process is still
 * edited where it was made.
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
        case 'PAUSED': return 'It is paused, so it is not being judged.';
        case 'ARCHIVED': return 'It is archived, so it is not being judged.';
        default: return '';
    }
}

function relevanceState(process: AssistantProcess): string {
    const { relevance, reasons } = process.assessment;
    if (relevance === 'dormant' && reasons.relevance === 'PAUSED') return 'Paused';
    if (relevance === 'dormant' && reasons.relevance === 'ARCHIVED') return 'Archived';
    return RELEVANCE_TEXT[relevance];
}

/** What stewardship has done with a process, in a sentence or two. Empty when it has done nothing. */
function lifecycleText(process: AssistantProcess, assistantName: string, whenLabel: (value: string) => string): string {
    const state = process.lifecycle;
    if (!state) return '';
    const who = state.actor === 'assistant' ? assistantName : 'you';
    const parts: string[] = [];
    if (state.stage === 'paused') {
        if (state.reasonCode === 'RESTORED') {
            parts.push(`Restored${state.pausedAt ? ` ${whenLabel(state.pausedAt)}` : ''}. It stays paused until you resume it.`);
        } else {
            parts.push(`Paused by ${who}${state.pausedAt ? ` ${whenLabel(state.pausedAt)}` : ''}.`);
            const ended = state.reasonCode?.startsWith('RETIRE_') ? ENDED_TEXT[state.reasonCode.slice('RETIRE_'.length)] : null;
            if (ended) parts.push(ended);
            if (state.started?.count) {
                parts.push(state.started.policy === 'abandon'
                    ? 'A check that was under way was dropped, and nothing from it was stored.'
                    : `${plural(state.started.count, 'run')} that had already started ${state.started.count === 1 ? 'was' : 'were'} left to finish.`);
            }
            if (state.actor === 'assistant') parts.push('Resume it if you still want it.');
        }
    } else if (state.stage === 'archived' || state.stage === 'cleaned') {
        parts.push(`Archived by ${who}${state.archivedAt ? ` ${whenLabel(state.archivedAt)}` : ''}. It cannot run until it is restored, and it comes back paused.`);
        if (state.cleaned) {
            const removed = removedText(state.cleaned);
            if (removed.length) parts.push(`Cleaned up${state.cleanedAt ? ` ${whenLabel(state.cleanedAt)}` : ''}: ${removed.join(', ')} removed. Restoring does not bring ${removed.length === 1 && state.cleaned.observations === 1 ? 'it' : 'them'} back.`);
        }
    } else if (state.kept && process.assessment.relevance === 'retirement_candidate') {
        parts.push(`You chose to keep it running${state.kept.at ? ` ${whenLabel(state.kept.at)}` : ''}.`);
    }
    return parts.join(' ');
}

const REPAIR_WHY: Record<string, string> = {
    VERIFY_TIMEOUT: 'no run finished in the time allowed',
    RELAPSED: 'its next scheduled run failed again',
    DEPENDENTS_STILL_BLOCKED: 'what depends on it is still blocked'
};

/** Where a repair stands, in a sentence or two. Empty for one that was withdrawn or declined. */
function repairText(repair: ProcessRepair, assistantName: string, whenLabel: (value: string) => string): string {
    const did = repair.action === 'follow_redirect'
        ? `pointed it at the address it now redirects to${repair.address ? ` (${repair.address})` : ''}`
        : 'ran it once more with nothing changed';
    const when = repair.appliedAt ? ` ${whenLabel(repair.appliedAt)}` : '';
    const lead = `${assistantName} ${did}${when}${repair.actor === 'person' ? ', as you approved' : ''}`;
    const undone = repair.rollback === 'restored' ? ' Its previous address was put back.'
        : repair.rollback === 'kept' ? ' Its address was changed again afterwards, so it was left as it is.' : '';
    const attempts = repair.allowed && repair.attempt ? ` Attempt ${repair.attempt} of ${repair.allowed}.` : '';
    switch (repair.status) {
        case 'proposed':
            return repair.action === 'follow_redirect'
                ? `Its address now redirects to ${repair.address || 'another address'}. Nothing has been changed.`
                : 'A repair is proposed: run it once more with nothing changed. Nothing has been done yet.';
        case 'verifying':
            return `Repair under way: ${lead}. The run after it is being checked.${attempts}`;
        case 'observing':
            return `Repaired: ${lead}, and the run after that worked. Its next scheduled run is being watched before it counts as fixed.`;
        case 'succeeded':
            return `Repair held: ${lead}, and its next scheduled run worked too.`;
        case 'failed': {
            const why = REPAIR_WHY[repair.stopCode || ''] || `the run after it failed${repair.stopCode ? ` (${repair.stopCode})` : ''}`;
            const after = repair.direction === 'asked' ? ' No attempts are left.'
                : repair.direction === 'leave' ? ' You chose to leave it running.'
                    : repair.direction === 'pause' ? ' You chose to pause it.' : '';
            return `Repair did not work: ${lead}, but ${why}.${undone}${attempts}${after}`;
        }
        case 'closed':
            return repair.appliedAt ? `A repair was started${when} and closed without a result${repair.stopCode ? ` (${repair.stopCode})` : ''}.${undone}` : '';
        default:
            return '';
    }
}

function removedText(removes: { observations: number; sourceEntries: number; sourceCache: boolean }): string[] {
    const out: string[] = [];
    if (removes.observations) out.push(plural(removes.observations, 'run record'));
    if (removes.sourceEntries) out.push(plural(removes.sourceEntries, 'fetched entry', 'fetched entries'));
    if (removes.sourceCache) out.push('the stored copy of the page');
    return out;
}

function keptText(keeps: ProcessCleanup['keeps']): string[] {
    const out = ['the process itself'];
    if (keeps.contract) out.push('its purpose');
    if (keeps.inboxResults) out.push(`${plural(keeps.inboxResults, 'result')} in your Inbox`);
    if (keeps.deliveries) out.push(plural(keeps.deliveries, 'delivery record'));
    if (keeps.jobs) out.push(`${plural(keeps.jobs, 'run')} it started in the project`);
    if (keeps.keptEntries) out.push(`${plural(keeps.keptEntries, 'entry', 'entries')} you kept or researched`);
    return out;
}

const ACTION_LABEL: Partial<Record<ProcessAction, string>> = {
    pause: 'Pause', resume: 'Resume', archive: 'Archive', restore: 'Restore', keep: 'Keep it running', preview_cleanup: 'Clean up…'
};

/** What an action did, said once after it. */
function outcomeText(process: AssistantProcess, result: ProcessActionResult): string {
    const name = `"${process.name}"`;
    const waiting = (result.dependents || []).filter((item) => item.enabled).map((item) => `"${item.name}"`);
    const depends = waiting.length ? ` ${waiting.join(', ')} ${waiting.length === 1 ? 'depends' : 'depend'} on it and ${waiting.length === 1 ? 'is' : 'are'} still switched on.` : '';
    switch (result.action) {
        case 'pause': {
            if (!result.changed) return `${name} was already paused.`;
            const started = result.started?.count
                ? result.started.policy === 'abandon'
                    ? ' A check that was under way was dropped.'
                    : ` ${plural(result.started.count, 'run')} that had already started will finish.`
                : '';
            const dropped = result.dropped ? ` ${plural(result.dropped, 'event')} waiting to be retried will not be.` : '';
            return `Paused ${name}. Nothing new will start.${started}${dropped}${depends}`;
        }
        case 'resume':
            return result.changed
                ? `Resumed ${name}.${result.skipped ? ` ${plural(result.skipped, 'event')} that happened while it was paused will not be replayed.` : ''}`
                : `${name} is already running.`;
        case 'archive': return `Archived ${name}. It and its history are kept.${depends}`;
        case 'restore': {
            const gone = result.notRestored ? removedText(result.notRestored) : [];
            return `Restored ${name}. It is paused until you resume it.${gone.length ? ` What was cleaned up (${gone.join(', ')}) is not restored.` : ''}`;
        }
        case 'keep': return `${name} stays on. You will not be asked again unless its purpose changes.`;
        case 'cleanup': {
            const removed = result.cleanup?.result ? removedText(result.cleanup.result.removed) : [];
            return removed.length ? `Removed ${removed.join(', ')} of ${name}.` : `Nothing of ${name} needed removing.`;
        }
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

function CleanupPreview({ cleanup, busy, onConfirm, onCancel }: {
    cleanup: ProcessCleanup; busy: boolean; onConfirm: () => void; onCancel: () => void;
}) {
    const removes = removedText(cleanup.removes);
    return (
        <div className="process-cleanup" data-testid="process-cleanup-preview" role="group" aria-label="Cleanup preview">
            {removes.length > 0
                ? <div><strong>This removes exactly:</strong> {removes.join(', ')}.</div>
                : <div><strong>There is nothing to remove.</strong></div>}
            <div className="hint">It keeps {keptText(cleanup.keeps).join(', ')}.</div>
            {cleanup.more && <div className="hint">There is more than one cleanup can take. Preview again afterwards for the rest.</div>}
            {removes.length > 0 && <div className="hint">What is removed cannot be brought back, also not by restoring the process.</div>}
            <div className="inbox-actions" style={{ marginTop: 6 }}>
                {removes.length > 0 && (
                    <button type="button" className="btn danger" disabled={busy} data-testid="process-cleanup-confirm" onClick={onConfirm}>Remove these</button>
                )}
                <button type="button" className="btn subtle" disabled={busy} onClick={onCancel}>{removes.length > 0 ? 'Cancel' : 'Close'}</button>
            </div>
        </div>
    );
}

function ProcessRow({ process, nameOf, assistantName, busy, cleanup, onAct, onConfirmCleanup, onCancelCleanup }: {
    process: AssistantProcess; nameOf: (ref: string) => string; assistantName: string; busy: boolean;
    cleanup: ProcessCleanup | null;
    onAct: (process: AssistantProcess, action: ProcessAction) => void;
    onConfirmCleanup: (process: AssistantProcess, cleanup: ProcessCleanup) => void;
    onCancelCleanup: () => void;
}) {
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
    const stage = process.archived ? 'archived' : process.lifecycle?.stage === 'paused' && !process.enabled ? 'paused' : null;
    const stewardship = lifecycleText(process, assistantName, whenLabel);
    const repair = process.repair;
    const repairing = repair ? repairText(repair, assistantName, whenLabel) : '';
    const actions = process.controls.filter((action) => ACTION_LABEL[action]);
    return (
        <div id={`process-${process.kind}-${process.id}`} className={`list-row task-row process-row is-${judged.execution}`}
            data-testid="process-row" data-process={process.ref}>
            <div className="row-body">
                <strong>{process.name}</strong>{' '}
                <span className="row-meta">{kind.label}{stage ? ` · ${stage}` : process.enabled ? '' : ' · off'}</span>
                <div className="process-judgment" data-testid="process-execution">
                    <span className="process-axis">Working?</span>{' '}
                    <span className="process-state"><span aria-hidden="true">{execution.mark}</span> {execution.text}</span>
                    {why && <span className="hint"> {why}</span>}
                </div>
                <div className="process-judgment" data-testid="process-relevance">
                    <span className="process-axis">Still needed?</span>{' '}
                    <span className="process-state">{relevanceState(process)}</span>
                    {usefulness && <span className="hint"> {usefulness}</span>}
                </div>
                {(judged.signals.reviewDue || judged.signals.resultsIgnored) && (
                    <div className="hint" data-testid="process-signals">
                        {judged.signals.reviewDue && 'The review date you set for it has passed. '}
                        {judged.signals.resultsIgnored && 'Its recent results were not opened. That alone is not a reason to stop it.'}
                    </div>
                )}
                {stewardship && <div className="hint" data-testid="process-lifecycle">{stewardship}</div>}
                {repair && repairing && (
                    <div className="process-repair" data-testid="process-repair" data-repair-status={repair.status}>
                        <span className="hint">{repairing}</span>
                        {repair.diagnosis && <span className="hint"> Diagnosis: {repair.diagnosis}</span>}
                        {repair.ask && <GateDecision card={repair.ask} surface="processes" />}
                    </div>
                )}
                <div className="row-meta">
                    {lastRan ? `Last ran ${whenLabel(lastRan)}` : 'Has not run yet'}
                    {process.nextRunAt && process.enabled ? ` · next ${whenLabel(process.nextRunAt)}` : ''}
                    {process.incident ? ` · part of an ${process.incident.status === 'RECOVERING' ? 'incident that is recovering' : 'open incident'}` : ''}
                </div>
                {cleanup && (
                    <CleanupPreview cleanup={cleanup} busy={busy}
                        onConfirm={() => onConfirmCleanup(process, cleanup)} onCancel={onCancelCleanup} />
                )}
            </div>
            <div className="inbox-actions">
                {actions.map((action) => (
                    <button key={action} type="button" className={action === 'keep' || action === 'resume' ? 'btn' : 'btn subtle'}
                        disabled={busy} data-testid={`process-${action}`} onClick={() => onAct(process, action)}>
                        {ACTION_LABEL[action]}
                    </button>
                ))}
                {kind.to && !process.archived && <Link to={kind.to as never} className="btn subtle">Manage →</Link>}
            </div>
        </div>
    );
}

/** Not-working first, then problems, then the rest, each group by name. */
const ORDER: ProcessExecution[] = ['blocked', 'unreachable', 'stalled', 'degraded', 'unknown', 'healthy'];

/**
 * Switched off where it was made, with nothing to report: a finished watch,
 * a task turned off by hand. Folded away until asked for. A process paused
 * here stays in view, because resuming it is done here.
 */
const isIdle = (process: AssistantProcess) => !process.enabled && !process.archived && process.lifecycle?.stage !== 'paused'
    && process.assessment.execution === 'unknown' && !process.incident;

export function ProcessList({ data, pending, error }: { data: AssistantProcessList | undefined; pending: boolean; error: Error | null }) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [showIdle, setShowIdle] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState('');
    const [preview, setPreview] = useState<{ ref: string; cleanup: ProcessCleanup } | null>(null);
    const sorted = [...(data?.processes || [])].sort((a, b) =>
        ORDER.indexOf(a.assessment.execution) - ORDER.indexOf(b.assessment.execution) || a.name.localeCompare(b.name));
    const current = sorted.filter((process) => !process.archived);
    const archived = sorted.filter((process) => process.archived);
    const idle = current.filter(isIdle).length;
    const processes = showIdle ? current : current.filter((process) => !isIdle(process));
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
        if (counts.paused) summary.push(`${counts.paused} paused`);
        if (counts.archived) summary.push(`${counts.archived} archived`);
    }

    const refresh = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.assistantProcesses }),
        queryClient.invalidateQueries({ queryKey: keys.home }),
        queryClient.invalidateQueries({ queryKey: ['inbox'] })
    ]);

    async function run(process: AssistantProcess, action: ProcessAction, extra: { cleanupId?: number; manifestHash?: string } = {}) {
        setBusy(process.ref);
        setNotice('');
        try {
            const result = await api.assistantProcessAction(process, { action, expectedRevision: process.lifecycle?.revision ?? 0, ...extra });
            if (action === 'preview_cleanup' && result.cleanup) {
                setPreview({ ref: process.ref, cleanup: result.cleanup });
            } else {
                setPreview(null);
                setNotice(outcomeText(process, result));
            }
        } catch (failure) {
            toast((failure as Error).message, true);
            if (action === 'cleanup') setPreview(null);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    async function act(process: AssistantProcess, action: ProcessAction) {
        if (action === 'archive' && !await confirm(
            `Archive "${process.name}"? It will not run again unless you restore it. The process, its history and its results are kept; nothing is deleted.`
        )) return;
        await run(process, action);
    }

    const row = (process: AssistantProcess) => (
        <ProcessRow key={process.ref} process={process} nameOf={nameOf} assistantName={me.assistant.name}
            busy={busy === process.ref} cleanup={preview?.ref === process.ref ? preview.cleanup : null}
            onAct={(target, action) => void act(target, action)}
            onConfirmCleanup={(target, cleanup) => void run(target, 'cleanup', { cleanupId: cleanup.id, manifestHash: cleanup.manifestHash })}
            onCancelCleanup={() => setPreview(null)} />
    );
    return (
        <section id="processes" className="assistant-processes" aria-labelledby="processes-heading" data-testid="assistant-processes">
            <h2 id="processes-heading">Processes</h2>
            <p className="hint" style={{ maxWidth: 720 }}>
                The recurring work you have set up: scheduled tasks, project triggers, watches and followed sources.
                Each is judged twice from what it recorded: whether it is working, and whether it is still needed.
                You can pause, archive and restore each one here. Nothing here deletes a process: archiving keeps it and its history,
                and cleaning up an archived one shows exactly what it would remove before anything goes.
                A process that keeps failing may be offered one repair, which is checked against its next run and undone if it does not work.
            </p>
            {pending && <div className="empty">Loading…</div>}
            {error && <div className="empty" role="alert">{error.message}</div>}
            {data && sorted.length === 0 && <div className="hint" data-testid="processes-empty">No recurring work is set up yet.</div>}
            {data && sorted.length > 0 && <div className="row-meta" data-testid="processes-summary">{summary.join(' · ')}</div>}
            <div className="hint" role="status" aria-live="polite" data-testid="process-notice">{notice}</div>
            {data && data.incidents.length > 0 && (
                <ul className="assistant-list" style={{ marginTop: 10 }} aria-label="Open incidents">
                    {data.incidents.map((incident) => <IncidentRow key={incident.id} incident={incident} />)}
                </ul>
            )}
            {processes.length > 0 && (
                <div className="list-card" style={{ marginTop: 10 }}>
                    {processes.map(row)}
                </div>
            )}
            {idle > 0 && (
                <button type="button" className="btn subtle" style={{ marginTop: 10 }} aria-expanded={showIdle}
                    data-testid="processes-show-idle" onClick={() => setShowIdle((value) => !value)}>
                    {showIdle ? 'Hide switched off' : `Show ${idle} switched off`}
                </button>
            )}
            {archived.length > 0 && (
                <>
                    {' '}
                    <button type="button" className="btn subtle" style={{ marginTop: 10 }} aria-expanded={showArchived}
                        data-testid="processes-show-archived" onClick={() => setShowArchived((value) => !value)}>
                        {showArchived ? 'Hide archived' : `Show ${archived.length} archived`}
                    </button>
                    {showArchived && (
                        <div className="list-card" style={{ marginTop: 10 }} data-testid="processes-archived">
                            {archived.map(row)}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
