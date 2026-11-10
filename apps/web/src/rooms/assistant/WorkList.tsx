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
    INTERRUPTED_BY_RESTORE: 'It was working when this installation was restored from a backup, so it was stopped. A step may or may not have happened. Check before trying again.'
};

export function WorkList({ items, busy, onAct }: { items: AssistantInitiative[]; busy: boolean; onAct: (item: AssistantInitiative, action: string) => void }) {
    if (!items.length) return null;
    return (
        <ul className="assistant-work" data-testid="responsibility-work">
            {items.map((item) => {
                const run = item.run;
                const note = item.status === 'WAITING' || item.status === 'FAILED' || item.status === 'REVIEW'
                    ? (STOP_TEXT[item.stopCode || ''] || (item.waitReason === 'responsibility' ? 'Waiting for the responsibility to be active again.' : null))
                    : null;
                return (
                    <li key={item.id} className="assistant-work-item" data-testid="initiative-row">
                        <div className="assistant-row-main">
                            <span className="badge" data-testid="initiative-status">{WORK_STATUS[item.status] || item.status.toLowerCase()}</span>{' '}
                            {item.title}
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
                            {['FAILED', 'CANCELLED'].includes(item.status) && (
                                <button type="button" className="btn subtle" disabled={busy} onClick={() => onAct(item, 'retry')}>Try again</button>
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
