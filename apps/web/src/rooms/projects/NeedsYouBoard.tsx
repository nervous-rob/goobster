import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { projectPath } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';

type NeedsYouCard = {
    id: string;
    column: string;
    title: string;
    detail?: string | null;
    projectSlug?: string;
    projectName?: string;
    ownerId?: string;
    choices?: Array<{ id: string; label: string }>;
};

const NEEDS_YOU_COLUMNS = [
    { id: 'approve', label: 'Approve' },
    { id: 'answer', label: 'Answer' },
    { id: 'unblock', label: 'Unblock' },
    { id: 'review', label: 'Review' },
    { id: 'setup', label: 'Setup' }
] as const;

/**
 * Cross-project review board. Every card is a link to the project view
 * that resolves it - the Plan for approvals, answers, blocks and reviews;
 * the Overview for setup findings - so a card survives refresh and Back.
 */
export function NeedsYouBoard() {
    const me = useMe();
    const [filter, setFilter] = useState('');
    const q = useQuery({
        queryKey: keys.projectNeedsYou(),
        queryFn: () => api.projectNeedsYou() as Promise<{ cards: NeedsYouCard[]; text: string }>,
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

    return (
        <div className="obs-needs-you" data-tour="project-needs-you">
            <div className="obs-section-head">
                <h3>Needs you</h3>
                <span className="badge">{cards.length}</span>
            </div>
            <p className="hint">
                Approvals, design choices, blocked plans, and setup-contract findings across your projects.
                Open a card to continue in that project&apos;s Plan.
            </p>
            <input
                className="input"
                placeholder="Filter by project or column…"
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
                                {colCards.map((card) => {
                                    const body = (
                                        <>
                                            <div className="row-body">
                                                <strong>{card.title}</strong>
                                                <span className="badge">{card.projectSlug}</span>
                                                {card.choices?.length ? (
                                                    <span className="badge">{card.choices.length} choices</span>
                                                ) : null}
                                                {card.detail ? <div className="row-meta">{card.detail}</div> : null}
                                            </div>
                                            <span className="obs-chevron" aria-hidden="true">›</span>
                                        </>
                                    );
                                    if (!card.projectSlug) {
                                        return <div key={card.id} className="list-row task-row">{body}</div>;
                                    }
                                    return (
                                        <Link
                                            key={card.id}
                                            className="list-row task-row"
                                            to={projectPath(
                                                { owner: card.ownerId || me.user.id, slug: card.projectSlug },
                                                card.column === 'setup' ? 'overview' : 'plan'
                                            ) as never}
                                        >
                                            {body}
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
