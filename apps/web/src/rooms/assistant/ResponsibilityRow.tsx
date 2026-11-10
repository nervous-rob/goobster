import { useDateLabel } from '../../hooks/useDateLabel';
import { useMe } from '../../hooks/useSession';
import type { AssistantInitiative, Responsibility } from '../../lib/types';
import { describeGrants, describeListening, describeNoticing, describeSharing, externalOperationsPerDay, reachesGitHub, writesOutside, type Project } from './grants';
import { SourcesPreview } from './SourcesPreview';
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

export function ResponsibilityRow({ item, projects, work, busy, onAct, onActOnWork }: {
    item: Responsibility;
    projects: Map<string, Project>;
    work: AssistantInitiative[];
    busy: boolean;
    onAct: (item: Responsibility, action: string, question?: string) => void;
    onActOnWork: (work: AssistantInitiative, action: string) => void;
}) {
    const whenLabel = useDateLabel();
    const me = useMe();
    const listening = describeListening(item, me.assistant.name);
    const noticing = describeNoticing(item);
    const hasSources = (item.scopes?.sources || []).length > 0 && ['DRAFT', 'ACTIVE', 'PAUSED', 'NEEDS_REVIEW'].includes(item.status);
    const sharing = describeSharing(item);
    return (
        <div id={`responsibility-${item.id}`} className="list-row task-row" data-testid="responsibility-row">
            <div className="row-body">
                <strong>{item.title}</strong>{' '}
                <span className="badge" data-testid="responsibility-status">{STATUS_TEXT[item.status] || item.status.toLowerCase()}</span>
                {item.outcome && <div className="hint">{item.outcome}</div>}
                <ul className="assistant-grants">
                    {describeGrants(item.operations, projects).map((line) => <li key={line}>May {line}</li>)}
                    {listening && <li data-testid="responsibility-listens">{listening}</li>}
                    {noticing && <li data-testid="responsibility-notices">{noticing}</li>}
                    {sharing && <li data-testid="responsibility-shares">{sharing}</li>}
                </ul>
                {hasSources && <SourcesPreview responsibilityId={item.id} revision={item.revision} />}
                <div className="row-meta">
                    {item.rules?.autoStart ? 'Starts proposed work automatically · ' : 'Each piece of work waits for Start · '}
                    {item.expiresAt ? `Ends ${whenLabel(item.expiresAt)}` : 'No end date'}
                    {' · '}revision {item.revision}
                </div>
                {reachesGitHub(item.operations) && (
                    <div className="row-meta" data-testid="responsibility-reach">
                        Pushes and pull requests go to GitHub as you and cannot be undone from here · at most {externalOperationsPerDay(item.budgets)} a day
                    </div>
                )}
                {writesOutside(item.operations) && (
                    <div className="row-meta" data-testid="responsibility-connector-reach">
                        Writes to outside services are made as you and cannot be undone from here · at most {externalOperationsPerDay(item.budgets)} outside operations a day
                    </div>
                )}
                <WorkList items={work} busy={busy} onAct={onActOnWork} />
            </div>
            <div className="inbox-actions">
                {(ACTIONS[item.status] || []).map((option) => (
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
