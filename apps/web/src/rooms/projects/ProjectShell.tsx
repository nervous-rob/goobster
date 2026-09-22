import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { PROJECT_VIEWS, projectPath, projectViewFromParam, type ProjectViewId } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';
import { MenuButton } from '../../shell/MenuButton';
import { HeaderOverflow } from '../../shell/HeaderOverflow';
import { ProjectChatDock } from '../../components/ProjectChatDock';
import { ProjectExplorer } from '../../components/ProjectExplorer';
import { ProjectPeopleModal, ProjectPeople } from '../observatory/PeopleModal';
import { KnowledgeTab } from '../observatory/KnowledgeTab';
import { MissionTab } from '../observatory/MissionTab';
import { AppsTab } from '../observatory/AppsTab';
import { AutomationsTab } from './AutomationsTab';
import { CommandButton, CommandModal, CommandStrip, useProjectCommand } from './Command';
import { OverviewView } from './OverviewView';
import { RunsList } from './RunsList';
import type { Detail } from './types';

/**
 * `/projects/:owner/:slug/:view` - one project, addressed by its owner and
 * slug (two owners may share a slug), on one registered view. Selection
 * and the active view live only in the URL, so refresh, Back and links
 * land where they say. The chat dock and the People modal remain as
 * secondary presentations of the Conversation and People views.
 */
export function ProjectShell() {
    const params = useParams({ strict: false }) as { owner: string; slug: string; view?: string };
    const ownerId = decodeURIComponent(params.owner);
    const slug = decodeURIComponent(params.slug);
    // Resolve the view from the matched params, never from the live
    // pathname: while a navigation away is pending the location already
    // says `/projects` but this component still renders with the old
    // params, and a pathname-based lookup would bounce back here.
    const view = projectViewFromParam(params.view);

    // An unknown segment names the project but no view: fall back to Overview.
    if (params.view !== undefined && view === null) {
        return <Navigate to={projectPath({ owner: ownerId, slug }) as never} search={true} hash={true} replace />;
    }
    return <ProjectShellBody ownerId={ownerId} slug={slug} view={view || 'overview'} />;
}

function ProjectShellBody({ ownerId, slug, view }: { ownerId: string; slug: string; view: ProjectViewId }) {
    const me = useMe();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [dockOpen, setDockOpen] = useState(false);
    const [peopleOpen, setPeopleOpen] = useState(false);
    const [commandOpen, setCommandOpen] = useState(false);
    const { command, run, dismiss } = useProjectCommand();

    const detail = useQuery({
        queryKey: [...keys.observatory, slug, ownerId],
        queryFn: () => api.observatoryProject(slug, ownerId) as Promise<Detail>,
        retry: false
    });
    const project = detail.data?.project;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.observatory });
    const leave = () => {
        setPeopleOpen(false);
        void refresh();
        void navigate({ to: '/projects' });
    };
    const go = (next: ProjectViewId) => navigate({ to: projectPath({ owner: ownerId, slug }, next) as never });
    const showDock = dockOpen && view !== 'conversation';

    return (
        <main className="pane next-pane is-in" id="pane-observatory">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1 data-tour="project-title">
                        {project ? `🔭 ${project.name}` : <>Projects <span className="room-secondary">the Observatory</span></>}
                    </h1>
                </div>
                <div className="pane-header-actions">
                    <Link className="btn" to="/projects" data-tour="project-back">← Projects</Link>
                    {view !== 'conversation' && (
                        <button
                            type="button"
                            className={`btn${dockOpen ? ' primary' : ''}`}
                            title="The project's shared discussion, docked beside this view (also the Conversation view)"
                            onClick={() => setDockOpen((open) => !open)}
                        >
                            {dockOpen ? 'Hide chat' : 'Chat'}
                        </button>
                    )}
                    <CommandButton onOpen={() => setCommandOpen(true)} />
                    <HeaderOverflow>
                        <button type="button" className="btn" onClick={() => setPeopleOpen(true)}>People</button>
                        <button type="button" className="btn" onClick={() => void refresh()}>Refresh</button>
                    </HeaderOverflow>
                </div>
            </header>
            <nav className="view-tabs" aria-label="Project views">
                {PROJECT_VIEWS.map((entry) => (
                    <Link
                        key={entry.id}
                        to={projectPath({ owner: ownerId, slug }, entry.id) as never}
                        className={`view-tab${view === entry.id ? ' active' : ''}`}
                        aria-current={view === entry.id ? 'page' : undefined}
                        data-tour={`project-view-${entry.id}`}
                    >
                        <span aria-hidden="true">{entry.icon}</span> {entry.name}
                        {entry.id === 'runs' && project?.runningJobs ? <span className="badge">{project.runningJobs}</span> : null}
                    </Link>
                ))}
            </nav>
            <div className="pane-body">
                <div className="obs-view is-project">
                    <CommandStrip command={command} onDismiss={dismiss} />
                    {detail.isPending && <div className="empty">Loading…</div>}
                    {detail.isError && (
                        <div className="empty-state" style={{ marginTop: '6vh' }}>
                            <div className="empty-logo">🔭</div>
                            <div className="empty-title">Could not open this project</div>
                            <div className="hint" style={{ maxWidth: 460, margin: '0 auto 18px' }}>{(detail.error as Error).message}</div>
                            <Link className="btn primary" to="/projects">← All projects</Link>
                        </div>
                    )}
                    {detail.data && project && (
                        <div className="obs-project-layout">
                            {showDock && (
                                <button
                                    type="button"
                                    className="obs-chat-backdrop"
                                    aria-label="Close project chat"
                                    onClick={() => setDockOpen(false)}
                                />
                            )}
                            <div className="obs-project-main" data-tour={`project-pane-${view}`}>
                                {view === 'overview' && (
                                    <OverviewView
                                        detail={detail.data}
                                        ownerId={ownerId}
                                        onChanged={() => void refresh()}
                                        onDeleted={() => { void refresh(); void navigate({ to: '/projects' }); }}
                                        onOpen={go}
                                    />
                                )}
                                {view === 'plan' && <MissionTab slug={slug} ownerId={ownerId} />}
                                {view === 'conversation' && (
                                    <ProjectChatDock
                                        slug={slug}
                                        ownerId={ownerId}
                                        projectName={project.name}
                                        open
                                        variant="inline"
                                        onToggle={() => undefined}
                                    />
                                )}
                                {view === 'knowledge' && <KnowledgeTab slug={slug} ownerId={ownerId} projectId={project.id} />}
                                {view === 'files' && <ProjectExplorer slug={slug} ownerId={ownerId} onChanged={() => void refresh()} />}
                                {view === 'apps' && <AppsTab slug={slug} ownerId={ownerId} />}
                                {view === 'runs' && (
                                    <section className="obs-overview-jobs">
                                        <div className="obs-section-head">
                                            <h3>Runs</h3>
                                            <span className="hint">{detail.data.jobs.length || 'none yet'}</span>
                                        </div>
                                        <RunsList slug={slug} ownerId={ownerId} jobs={detail.data.jobs} onChanged={() => void refresh()} />
                                    </section>
                                )}
                                {view === 'people' && (
                                    <section className="obs-people-view">
                                        <div className="obs-section-head"><h3>People on this project</h3></div>
                                        <ProjectPeople slug={slug} ownerId={ownerId} meId={me.user.id} onLeft={leave} />
                                    </section>
                                )}
                                {view === 'automations' && <AutomationsTab slug={slug} ownerId={ownerId} role={project.role} />}
                            </div>
                            {view !== 'conversation' && (
                                <ProjectChatDock
                                    slug={slug}
                                    ownerId={ownerId}
                                    projectName={project.name}
                                    open={showDock}
                                    onToggle={() => setDockOpen((open) => !open)}
                                />
                            )}
                        </div>
                    )}
                    {peopleOpen && (
                        <ProjectPeopleModal
                            slug={slug}
                            ownerId={ownerId}
                            meId={me.user.id}
                            onClose={() => setPeopleOpen(false)}
                            onLeft={leave}
                        />
                    )}
                </div>
            </div>
            {commandOpen && (
                <CommandModal
                    target={{ slug, ownerId, name: project?.name }}
                    busy={Boolean(command?.active)}
                    onClose={() => setCommandOpen(false)}
                    onRun={(instructions) => { setCommandOpen(false); void run(instructions, { slug, ownerId, name: project?.name }); }}
                />
            )}
        </main>
    );
}
