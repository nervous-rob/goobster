import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ProjectViewId } from '../../lib/rooms';

type TimelineEntry = {
    id: string;
    kind: 'snapshot' | 'run' | 'repo' | 'plan';
    at: string;
    actor: { type: 'person' | 'goobster' | 'automation'; name: string };
    title: string;
    detail?: string | null;
    status?: string;
    ref?: Record<string, unknown>;
};
type TimelinePage = { entries: TimelineEntry[]; nextBefore: string | null };

const KIND_LABELS: Record<TimelineEntry['kind'], { label: string; icon: string; view: ProjectViewId }> = {
    snapshot: { label: 'Files', icon: '📝', view: 'files' },
    run: { label: 'Runs', icon: '▶️', view: 'runs' },
    repo: { label: 'Code', icon: '📦', view: 'code' },
    plan: { label: 'Plan', icon: '🎯', view: 'plan' }
};
const ACTOR_ICONS: Record<TimelineEntry['actor']['type'], string> = { person: '👤', goobster: '🤖', automation: '⏱️' };

function local(utcText: string): Date {
    return new Date(`${utcText.replace(' ', 'T')}Z`);
}

/**
 * Everything that happened on the project, newest first, one feed: file
 * snapshots, runs, clones/pushes/merges/pull requests, plan changes - each
 * with who did it (a person, Goobster, an automation). Grouped by day;
 * kinds can be filtered; older entries page in by time.
 */
export function TimelineView({ slug, ownerId, onOpen }: { slug: string; ownerId: string; onOpen: (view: ProjectViewId) => void }) {
    const [kinds, setKinds] = useState<TimelineEntry['kind'][]>([]);
    const feed = useInfiniteQuery({
        queryKey: ['project-timeline', slug, ownerId, kinds.join(',')],
        queryFn: ({ pageParam }) => api.projectTimeline(slug, { before: pageParam, limit: 50, kinds }, ownerId) as Promise<TimelinePage>,
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextBefore,
        retry: false
    });
    const entries = feed.data?.pages.flatMap((page) => page.entries) || [];
    const days: { day: string; items: TimelineEntry[] }[] = [];
    for (const entry of entries) {
        const day = local(entry.at).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        if (days.length === 0 || days[days.length - 1].day !== day) days.push({ day, items: [] });
        days[days.length - 1].items.push(entry);
    }
    const toggle = (kind: TimelineEntry['kind']) =>
        setKinds((current) => (current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]));

    return (
        <div className="obs-section obs-timeline" data-testid="project-timeline">
            <div className="obs-section-head">
                <h3>Timeline</h3>
                <span className="hint">what happened, and who did it</span>
            </div>
            <div className="obs-timeline-filters" role="group" aria-label="Show">
                {(Object.keys(KIND_LABELS) as TimelineEntry['kind'][]).map((kind) => (
                    <button key={kind} type="button" aria-pressed={kinds.includes(kind)}
                        className={`btn small${kinds.includes(kind) ? ' primary' : ''}`} onClick={() => toggle(kind)}>
                        {KIND_LABELS[kind].icon} {KIND_LABELS[kind].label}
                    </button>
                ))}
                {kinds.length > 0 && <button type="button" className="btn small subtle" onClick={() => setKinds([])}>All</button>}
            </div>
            {feed.isPending && <div className="hint">Loading…</div>}
            {feed.isError && <div className="hint">{(feed.error as Error).message}</div>}
            {feed.data && entries.length === 0 && <div className="empty">Nothing has happened here yet.</div>}
            {days.map((group) => (
                <section key={group.day} className="obs-timeline-day">
                    <h4 className="obs-timeline-date">{group.day}</h4>
                    <ol className="obs-timeline-list">
                        {group.items.map((entry) => (
                            <li key={entry.id} className={`obs-timeline-item kind-${entry.kind}${entry.status === 'FAILED' || entry.status === 'TIMED_OUT' ? ' is-failure' : ''}`}>
                                <time dateTime={local(entry.at).toISOString()} className="hint">
                                    {local(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </time>
                                <span aria-hidden="true">{KIND_LABELS[entry.kind].icon}</span>
                                <span className="obs-timeline-body">
                                    <span className="obs-timeline-actor" title={entry.actor.type}>{ACTOR_ICONS[entry.actor.type]} {entry.actor.name}</span>
                                    {' '}{entry.title}
                                    {entry.detail ? <span className="hint"> · {entry.detail}</span> : null}
                                </span>
                                <button type="button" className="btn small subtle" onClick={() => onOpen(KIND_LABELS[entry.kind].view)}>
                                    {KIND_LABELS[entry.kind].label}
                                </button>
                            </li>
                        ))}
                    </ol>
                </section>
            ))}
            {feed.hasNextPage && (
                <button type="button" className="btn" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                    {feed.isFetchingNextPage ? 'Loading…' : 'Older'}
                </button>
            )}
        </div>
    );
}
