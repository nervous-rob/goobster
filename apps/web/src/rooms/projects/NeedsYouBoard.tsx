import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { projectPath } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';
import { GateDecision } from '../../components/GateDecision';
import type { ProjectBoard, ProjectBoardCard } from '../../lib/types';

const NEEDS_YOU_COLUMNS = [
    { id: 'approve', label: 'Approve' },
    { id: 'answer', label: 'Answer' },
    { id: 'unblock', label: 'Unblock' },
    { id: 'review', label: 'Review' },
    { id: 'assistant', label: 'Goobster\'s steps' },
    { id: 'setup', label: 'Setup' }
] as const;

/**
 * Cross-project review board (documentation/assistant_home.md, "Project
 * boards"). An approval, answer, block or review here is the same request
 * Home and the Inbox show: where the server described its decision, the
 * buttons decide it in place, and it is settled everywhere at once. A
 * request addressed to a project's owner is listed for its members as
 * waiting on the owner, with nothing to press.
 *
 * Every card is also a link to the project view that resolves it - the Plan
 * for approvals, answers, blocks, reviews and Goobster's steps; the Overview
 * for setup findings - so a card survives refresh and Back.
 */
export function NeedsYouBoard() {
    const me = useMe();
    const [filter, setFilter] = useState('');
    const q = useQuery({
        queryKey: keys.projectNeedsYou(),
        queryFn: () => api.projectNeedsYou() as Promise<ProjectBoard>,
        retry: false
    });
    const cards = (q.data?.cards || []).filter((card) => {
        if (!filter.trim()) return true;
        const needle = filter.trim().toLowerCase();
        return [card.projectSlug, card.projectName, card.title, card.column]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle));
    });
    if (q.isPending) return null;
    if (!q.data?.cards?.length) return null;
    const mine = cards.filter((card) => card.mine !== false).length;

    return (
        <div className="obs-needs-you" data-tour="project-needs-you" data-testid="project-needs-you">
            <div className="obs-section-head">
                <h3>Needs you</h3>
                <span className="badge" data-testid="project-needs-you-count">{mine}</span>
                {cards.length > mine && <span className="hint">{cards.length - mine} waiting on a project&apos;s owner</span>}
            </div>
            <p className="hint">
                Approvals, design choices, blocked plans, steps for Goobster and setup-contract findings across your projects.
                Decide here where a card offers it, or open the card to continue in that project&apos;s Plan.
            </p>
            <input
                className="input"
                placeholder="Filter by project or column…"
                aria-label="Filter by project or column"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
            />
            <div className="obs-needs-columns">
                {NEEDS_YOU_COLUMNS.map((col) => {
                    const colCards = cards.filter((c) => c.column === col.id);
                    if (!colCards.length) return null;
                    return (
                        <div key={col.id} className="obs-needs-column">
                            <div className="section-title">{col.label} ({colCards.length})</div>
                            <div className="list-card">
                                {colCards.map((card) => <BoardCard key={card.id} card={card} viewerId={me.user.id} />)}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function BoardCard({ card, viewerId }: { card: ProjectBoardCard; viewerId: string }) {
    const theirs = card.mine === false;
    const body = (
        <>
            <div className="row-body">
                <strong>{card.title}</strong>
                <span className="badge">{card.projectSlug}</span>
                {card.choices?.length ? (
                    <span className="badge">{card.choices.length} choices</span>
                ) : null}
                {theirs && <span className="badge" data-testid="board-waiting-on">Waiting on the owner</span>}
                {card.gate?.snoozedUntil && <span className="badge">Snoozed</span>}
                {/* A decision states what it changes; the card's own text would say it twice. */}
                {card.detail && !card.decision?.detail ? <div className="row-meta">{card.detail}</div> : null}
            </div>
            <span className="obs-chevron" aria-hidden="true">›</span>
        </>
    );
    const row = card.projectSlug
        ? (
            <Link
                className="list-row task-row"
                to={projectPath(
                    { owner: card.ownerId || viewerId, slug: card.projectSlug },
                    card.column === 'setup' ? 'overview' : 'plan'
                ) as never}
            >
                {body}
            </Link>
        )
        : <div className="list-row task-row">{body}</div>;
    const extras = card.decision || card.column === 'assistant' || card.gate?.inboxItemId;
    return (
        <div className={`obs-needs-card${theirs ? ' is-theirs' : ''}`} data-testid="board-card" data-card={card.id}>
            {row}
            {extras && (
                <div className="obs-needs-card-actions">
                    {card.decision && <GateDecision card={card.decision} surface="project" />}
                    {card.column === 'assistant' && (
                        <Link to="/assistant" hash={card.initiativeId ? undefined : 'assistant-draft-title'} className="btn small subtle">
                            {card.state === 'undelegated' ? 'Delegate it in Assistant' : 'Open Assistant'}
                        </Link>
                    )}
                    {card.gate?.inboxItemId != null && (
                        <Link to="/activity/inbox" hash={`inbox-${card.gate.inboxItemId}`} className="btn small subtle">In Inbox</Link>
                    )}
                </div>
            )}
        </div>
    );
}
