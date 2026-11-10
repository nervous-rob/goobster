import { useDateLabel } from '../../hooks/useDateLabel';
import type { AssistantInitiative, Responsibility } from '../../lib/types';
import { describeGrants, type Project } from './grants';
import { WorkList } from './WorkList';

/** One responsibility: what it grants, its work, and its lifecycle buttons. */

const STATUS_TEXT: Record<string, string> = {
    DRAFT: 'draft', ACTIVE: 'active', PAUSED: 'paused', NEEDS_REVIEW: 'needs review',
    COMPLETED: 'completed', REVOKED: 'revoked', EXPIRED: 'expired', ARCHIVED: 'archived'
};

/** Which lifecycle buttons a status offers (the server re-checks each one). */
const ACTIONS: Record<string, Array<{ action: string; label: string; primary?: boolean; danger?: boolean; confirm?: string }>> = {
    DRAFT: [
        { action: 'activate', label: 'Activate', primary: true },
        { action: 'revoke', label: 'Discard', danger: true, confirm: 'Discard this draft? It never ran.' }
    ],
    ACTIVE: [
        { action: 'pause', label: 'Pause' },
        { action: 'complete', label: 'Mark complete', confirm: 'Mark this complete? Its open work is cancelled and it stops for good.' },
        { action: 'revoke', label: 'Revoke', danger: true, confirm: 'Revoke this? Its open work is cancelled now and it cannot be turned back on.' }
    ],
    PAUSED: [
        { action: 'resume', label: 'Resume', primary: true },
        { action: 'revoke', label: 'Revoke', danger: true, confirm: 'Revoke this? Its open work is cancelled now and it cannot be turned back on.' }
    ],
    NEEDS_REVIEW: [
        { action: 'resume', label: 'Looks right, resume', primary: true },
        { action: 'revoke', label: 'Revoke', danger: true, confirm: 'Revoke this? Its open work is cancelled now and it cannot be turned back on.' }
    ],
    COMPLETED: [{ action: 'archive', label: 'Archive' }],
    REVOKED: [{ action: 'archive', label: 'Archive' }],
    EXPIRED: [{ action: 'archive', label: 'Archive' }]
};

/** A draft proposed in a conversation never ran: discarding it deletes it instead of keeping a revoked record. */
const PROPOSED_DRAFT = [
    { action: 'activate', label: 'Activate', primary: true },
    { action: 'discard', label: 'Discard', danger: true, confirm: 'Discard this draft? It was proposed in a conversation and never ran. It is deleted.' }
];

export function ResponsibilityRow({ item, projects, work, busy, onAct, onActOnWork }: {
    item: Responsibility;
    projects: Map<string, Project>;
    work: AssistantInitiative[];
    busy: boolean;
    onAct: (item: Responsibility, action: string, question?: string) => void;
    onActOnWork: (work: AssistantInitiative, action: string) => void;
}) {
    const whenLabel = useDateLabel();
    const proposed = item.proposedBy === 'model';
    const actions = proposed && item.status === 'DRAFT' ? PROPOSED_DRAFT : ACTIONS[item.status] || [];
    return (
        <div id={`responsibility-${item.id}`} className="list-row task-row" data-testid="responsibility-row">
            <div className="row-body">
                <strong>{item.title}</strong>{' '}
                <span className="badge" data-testid="responsibility-status">{STATUS_TEXT[item.status] || item.status.toLowerCase()}</span>
                {proposed && <>{' '}<span className="badge" data-testid="responsibility-proposed">proposed in a conversation</span></>}
                {item.outcome && <div className="hint">{item.outcome}</div>}
                <ul className="assistant-grants">
                    {describeGrants(item.operations, projects).map((line) => <li key={line}>May {line}</li>)}
                </ul>
                <div className="row-meta">
                    {item.rules?.autoStart ? 'Starts proposed work automatically · ' : 'Each piece of work waits for Start · '}
                    {item.expiresAt ? `Ends ${whenLabel(item.expiresAt)}` : 'No end date'}
                    {' · '}revision {item.revision}
                </div>
                <WorkList items={work} busy={busy} onAct={onActOnWork} />
            </div>
            <div className="inbox-actions">
                {actions.map((option) => (
                    <button key={option.action} type="button" disabled={busy}
                        className={`btn${option.primary ? ' primary' : option.danger ? ' danger' : ' subtle'}`}
                        onClick={() => onAct(item, option.action, option.confirm)}>
                        {option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
