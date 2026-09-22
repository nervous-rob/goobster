import { Link, Navigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { projectPath } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';
import { MenuButton } from '../../shell/MenuButton';
import type { Project } from './types';

/**
 * `/projects/:slug` - a slug without an owner (older links, hand-typed
 * URLs, "open my emergence-study"). It never guesses: one match among the
 * projects the person can see redirects to that project's canonical
 * address; several show a chooser that names each owner; none says so.
 */
export function ProjectResolver() {
    const { slug } = useParams({ strict: false }) as { slug: string };
    const me = useMe();
    const list = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        retry: false
    });
    const wanted = decodeURIComponent(slug || '').toLowerCase();
    const matches = (list.data?.projects || []).filter((p) => (
        p.slug.toLowerCase() === wanted || p.name.toLowerCase() === wanted
    ));

    if (list.isSuccess && matches.length === 1) {
        const only = matches[0];
        return <Navigate to={projectPath({ owner: only.ownerId || me.user.id, slug: only.slug }) as never} search={true} hash={true} replace />;
    }

    return (
        <main className="pane next-pane is-in" id="pane-observatory">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Projects <span className="room-secondary">the Observatory</span></h1>
                </div>
            </header>
            <div className="pane-body">
                {list.isPending && <div className="empty">Looking up “{slug}”…</div>}
                {list.isError && <div className="empty">Projects are unavailable right now. {(list.error as Error).message}</div>}
                {list.isSuccess && matches.length === 0 && (
                    <div className="empty-state" style={{ marginTop: '6vh' }} data-tour="project-resolver-missing">
                        <div className="empty-logo">🔭</div>
                        <div className="empty-title">No project called “{slug}”</div>
                        <div className="hint" style={{ maxWidth: 460, margin: '0 auto 18px' }}>
                            It may have been deleted, renamed, or belong to someone who has not invited you.
                        </div>
                        <Link className="btn primary" to="/projects">← All projects</Link>
                    </div>
                )}
                {list.isSuccess && matches.length > 1 && (
                    <div className="project-chooser" data-tour="project-resolver-chooser">
                        <div className="section-title">Which “{slug}”?</div>
                        <p className="hint">
                            More than one project you can see has this name - one per owner. Pick the one you meant;
                            its address names the owner, so the next link will not need to ask.
                        </p>
                        <div className="list-card">
                            {matches.map((item) => {
                                const ownerId = item.ownerId || me.user.id;
                                return (
                                    <Link
                                        key={`${ownerId}:${item.slug}`}
                                        className="list-row task-row obs-project-card"
                                        to={projectPath({ owner: ownerId, slug: item.slug }) as never}
                                        data-testid={`project-choice-${ownerId}`}
                                    >
                                        <div className="row-body">
                                            <strong>🔭 {item.name}</strong>
                                            <span className="badge">{item.role === 'owner' ? 'yours' : `owner ${item.ownerName || ownerId}`}</span>
                                            {item.description ? <div className="row-meta obs-goal">{item.description}</div> : null}
                                        </div>
                                        <span className="obs-chevron" aria-hidden="true">›</span>
                                    </Link>
                                );
                            })}
                        </div>
                        <Link className="btn" style={{ marginTop: 12 }} to="/projects">← All projects</Link>
                    </div>
                )}
            </div>
        </main>
    );
}
