import { Link } from '@tanstack/react-router';
import type { AssistantInitiative } from '../../lib/types';

/** The proposed, running and finished work under one responsibility. */

const WORK_STATUS: Record<string, string> = {
    CANDIDATE: 'proposed', QUEUED: 'queued', RUNNING: 'working', WAITING: 'waiting', REVIEW: 'needs review',
    COMPLETED: 'done', FAILED: 'failed', CANCELLED: 'cancelled', SUPERSEDED: 'superseded'
};

/** Plain words for the machine codes a run can stop with. */
const STOP_TEXT: Record<string, string> = {
    TOKEN_BUDGET: 'Today\'s token budget for this responsibility is used up. It continues when the day resets.',
    ACCOUNT_BUDGET: 'Your account\'s token limit is used up. It continues when the limit resets.',
    NO_PROVIDER: 'No AI provider is available right now. It will try again.',
    PROVIDER_ERROR: 'The AI provider failed. You can try again.',
    NO_RESULT: 'It finished without a result. You can try again.',
    OPERATION_UNCERTAIN: 'A step may or may not have happened. Check before trying again.',
    REPLAN_REQUIRED: 'The responsibility changed since this was proposed.',
    LEASE_EXPIRED: 'It was interrupted and will pick up where it left off.',
    VERIFICATION_FAILED: 'The step\'s result did not pass the check: a file it had to produce is missing, empty or was not written by this run. The plan step is marked failed. Retry it from the plan.',
    STEP_BLOCKED: 'It reported that it could not finish the plan step. The plan step is marked failed. Retry it from the plan.',
    NO_STEP_REPORT: 'It ended without reporting a result for the plan step. The plan step is marked failed. Retry it from the plan.',
    STEP_FAILED: 'The plan step failed. Retry it from the plan.',
    EVIDENCE_LIMIT: 'The plan already holds as much evidence as it can. The plan step is marked failed.',
    PLAN_NOT_ACTIVE: 'The plan is no longer running, so this step was not started.',
    PLAN_REVISION_STALE: 'The plan changed since this was proposed. It is proposed again once the new plan is approved and started.',
    STEP_NOT_ELIGIBLE: 'The plan step was already taken, finished or skipped.',
    PLAN_STEP_CLOSED: 'Someone closed the plan step, so this work was stopped.',
    PLAN_BUDGET: 'The plan has used up the assistant runs it allows.',
    PLAN_BLOCKED: 'The plan is blocked. It tries again once the plan is running.',
    RESOURCE_UNAVAILABLE: 'You no longer have access to the project, so this was stopped.',
    PRIVATE_CONTEXT: 'It read your private knowledge, so it was not allowed to write into a shared project.',
    STEERED: 'You changed direction in that conversation, so this was stopped. Nothing it had already done was undone.',
    SOURCE_GONE: 'What this came from is gone, was un-kept, or is no longer yours to read, so it was not started.',
    SOURCE_NOT_COVERED: 'The responsibility no longer covers where this came from, so it was not started.',
    SOURCE_MOVED: 'The branch has a newer commit since this was proposed. It is proposed again if that one settles red.',
    PILOT_ONLY: 'Noticing work from these sources is limited to the installation\'s owner for now, so this was not started.',
    OPEN_LIMIT: 'This responsibility already had as many open requests from conversations as it takes at once. Try again when some are finished.',
    NO_STEP: 'The plan step no longer exists or is no longer for Goobster.',
    INTERRUPTED_BY_RESTORE: 'It was working when this installation was restored from a backup, so it was stopped. A step may or may not have happened. Check before trying again.'
};

function originSummary(origin: NonNullable<AssistantInitiative['origin']>) {
    switch (origin.kind) {
        case 'parlor_message':
        case 'chat_message':
            return origin.excerpt ? <blockquote>{origin.excerpt}</blockquote> : <div className="hint">The message is no longer available to you.</div>;
        case 'followed_source_entry':
            return <div className="hint">{origin.entryTitle ? `"${origin.entryTitle}"` : 'An item you kept'}{origin.sourceLabel ? ` from ${origin.sourceLabel}` : ''}</div>;
        case 'ci_verdict':
            return <div className="hint">{origin.repo} {origin.branch}: {origin.state} at {origin.sha}{origin.moved ? ' (the branch has moved on)' : ''}</div>;
        default:
            return <div className="hint">{origin.language} run #{origin.jobId}: {String(origin.status || '').toLowerCase().replace('_', ' ')}</div>;
    }
}

function originLink(origin: NonNullable<AssistantInitiative['origin']>): string | null {
    const link = (origin as { link?: string | null }).link;
    return link && link.startsWith('/') ? link : null;
}

function originLinkText(origin: NonNullable<AssistantInitiative['origin']>): string {
    if (origin.kind === 'parlor_message' || origin.kind === 'chat_message') {
        return `Open the conversation${origin.conversationTitle ? `: ${origin.conversationTitle}` : ''}`;
    }
    return origin.kind === 'ci_verdict' ? 'Open the code view' : 'Open the project';
}

export function WorkList({ items, busy, onAct }: { items: AssistantInitiative[]; busy: boolean; onAct: (item: AssistantInitiative, action: string) => void }) {
    if (!items.length) return null;
    return (
        <ul className="assistant-work" data-testid="responsibility-work">
            {items.map((item) => {
                const run = item.run;
                const note = item.status === 'WAITING' || item.status === 'FAILED' || item.status === 'REVIEW'
                    ? (STOP_TEXT[item.stopCode || ''] || (item.waitReason === 'responsibility' ? 'Waiting for the responsibility to be active again.' : null))
                    : (item.status === 'SUPERSEDED' || item.status === 'CANCELLED') && (item.planStep || item.origin)
                        ? (STOP_TEXT[item.stopCode || ''] || null)
                        : null;
                const origin = item.origin;
                return (
                    <li key={item.id} className="assistant-work-item" data-testid="initiative-row">
                        <div className="assistant-row-main">
                            <span className="badge" data-testid="initiative-status">{WORK_STATUS[item.status] || item.status.toLowerCase()}</span>{' '}
                            {item.title}
                            {origin && (
                                <div className="assistant-origin" data-testid="initiative-origin">
                                    {!origin.available
                                        ? <div className="hint">What this came from is no longer available to you.</div>
                                        : originSummary(origin)}
                                    {origin.available && originLink(origin) && (
                                        <Link to={originLink(origin) as never} className="assistant-origin-link" data-testid="initiative-origin-link">
                                            {originLinkText(origin)} →
                                        </Link>
                                    )}
                                </div>
                            )}
                            {run?.resultTitle && (
                                <div className="assistant-result" data-testid="initiative-result">
                                    <strong>{run.resultTitle}</strong>
                                    {run.resultSummary && <div className="hint">{run.resultSummary}</div>}
                                </div>
                            )}
                            {item.status === 'COMPLETED' && item.outcome === 'NO_CHANGE' && <div className="hint">Checked: nothing needs your attention.</div>}
                            {note && <div className="hint">{note}</div>}
                            {run && (run.tokensUsed > 0 || run.searches > 0) && (
                                <div className="row-meta">Used {run.tokensUsed.toLocaleString()} tokens · {run.searches} web search{run.searches === 1 ? '' : 'es'}</div>
                            )}
                        </div>
                        <div className="assistant-row-actions">
                            {item.status === 'CANDIDATE' && (
                                <>
                                    <button type="button" className="btn primary" disabled={busy} onClick={() => onAct(item, 'queue')}>Start</button>
                                    <button type="button" className="btn subtle" disabled={busy} onClick={() => onAct(item, 'cancel')}>Dismiss</button>
                                </>
                            )}
                            {['QUEUED', 'RUNNING', 'WAITING'].includes(item.status) && (
                                <button type="button" className="btn subtle" disabled={busy} onClick={() => onAct(item, 'cancel')}>Cancel</button>
                            )}
                            {(['FAILED', 'CANCELLED'].includes(item.status) || (item.status === 'SUPERSEDED' && (item.planStep || item.origin))) && (
                                <button type="button" className="btn subtle" disabled={busy} onClick={() => onAct(item, 'retry')}>Try again</button>
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
