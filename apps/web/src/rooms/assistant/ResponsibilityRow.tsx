import { useDateLabel } from '../../hooks/useDateLabel';
import { useMe } from '../../hooks/useSession';
import type { AssistantInitiative, AssistantLearnedRate, Responsibility } from '../../lib/types';
import { describeGrants, describeInterruption, describeListening, describeNoticing, describeSharing, externalOperationsPerDay, reachesGitHub, writesOutside, type Project } from './grants';
import { SOURCE_TEXT, SourcesPreview } from './SourcesPreview';
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

const perDay = (cap: number | null) => (cap === null ? 'no daily limit' : cap === 0 ? 'nothing' : `up to ${cap} a day`);

/** What feedback taught about one source: the rate now, the usual one, and why. */
function learnedText(rate: AssistantLearnedRate): string {
    const changed = rate.cap !== rate.usual;
    const reasons = [
        rate.lowered ? `you said "less of this" ${rate.lowered === 1 ? 'once' : `${rate.lowered} times`}` : '',
        rate.dismissals ? `${rate.dismissals} dismissed, ignored or already known` : '',
        rate.acceptances ? `${rate.acceptances} started, accepted or useful` : ''
    ].filter(Boolean).join(' · ');
    const now = rate.stopped ? 'proposes nothing now' : changed ? `may propose ${perDay(rate.cap)} now` : `proposes at its usual rate (${perDay(rate.usual)})`;
    return `${now}${changed ? ` (usually ${perDay(rate.usual)})` : ''}${reasons ? ` · ${reasons}` : ''}`;
}

export function ResponsibilityRow({ item, projects, work, learned, busy, onAct, onActOnWork, onResetRate }: {
    item: Responsibility;
    projects: Map<string, Project>;
    work: AssistantInitiative[];
    learned: AssistantLearnedRate[];
    busy: boolean;
    onAct: (item: Responsibility, action: string, question?: string) => void;
    onActOnWork: (work: AssistantInitiative, action: string) => void;
    onResetRate: (rate: AssistantLearnedRate) => void;
}) {
    const whenLabel = useDateLabel();
    const me = useMe();
    const listening = describeListening(item, me.assistant.name);
    const proposed = item.proposedBy === 'model';
    const actions = proposed && item.status === 'DRAFT' ? PROPOSED_DRAFT : ACTIONS[item.status] || [];
    const noticing = describeNoticing(item);
    const hasSources = (item.scopes?.sources || []).length > 0 && ['DRAFT', 'ACTIVE', 'PAUSED', 'NEEDS_REVIEW'].includes(item.status);
    const sharing = describeSharing(item);
    return (
        <div id={`responsibility-${item.id}`} className="list-row task-row" data-testid="responsibility-row">
            <div className="row-body">
                <strong>{item.title}</strong>{' '}
                <span className="badge" data-testid="responsibility-status">{STATUS_TEXT[item.status] || item.status.toLowerCase()}</span>
                {proposed && <>{' '}<span className="badge" data-testid="responsibility-proposed">proposed in a conversation</span></>}
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
                    {' · '}<span data-testid="responsibility-interruption-rule">{describeInterruption(item.rules?.interruption)}</span>
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
                {learned.length > 0 && (
                    <div className="assistant-learned" data-testid="responsibility-learned">
                        <div className="row-meta">Learned from your feedback. It changes only how often a source may propose work, never what this responsibility may do.</div>
                        <ul>
                            {learned.map((rate) => (
                                <li key={rate.adapter} data-testid="responsibility-learned-row">
                                    <strong>{SOURCE_TEXT[rate.adapter] || rate.adapter}</strong>: {learnedText(rate)}
                                    <button type="button" className="btn small subtle" style={{ marginLeft: 8 }} disabled={busy}
                                        onClick={() => onResetRate(rate)} data-testid="responsibility-learned-reset">
                                        Reset
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
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
