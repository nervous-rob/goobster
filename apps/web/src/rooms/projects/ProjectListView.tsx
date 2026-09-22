import { useCallback, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { projectPath } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { MenuButton } from '../../shell/MenuButton';
import { HeaderOverflow } from '../../shell/HeaderOverflow';
import { WorkshopInbox, type InboxApplet } from '../../components/WorkshopInbox';
import { whenLabel } from '../observatory/format';
import { CommandButton, CommandModal, CommandStrip, EXECUTION_OFF, useProjectCommand } from './Command';
import { CreateProjectForm } from './CreateProjectForm';
import { NeedsYouBoard } from './NeedsYouBoard';
import type { Project, ProjectInvite } from './types';

/**
 * `/projects`: every project the person owns or collaborates on, each a
 * link to its own address (`/projects/<owner>/<slug>/overview`), plus
 * invitations, the Needs-you board and the Unfiled apps inbox. Creating a
 * project is a form; ✨ Command is the richer, execution-gated path.
 */
export function ProjectListView() {
    const toast = useToast();
    const me = useMe();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const executionOn = Boolean(me.features?.observatory);
    const [inboxPreview, setInboxPreview] = useState(false);
    const [creating, setCreating] = useState(false);
    const [commandOpen, setCommandOpen] = useState(false);
    const { command, run, dismiss } = useProjectCommand();

    const list = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        retry: false
    });
    const invitesQ = useQuery({
        queryKey: keys.projectInvites,
        queryFn: () => api.projectInvites() as Promise<{ invites: ProjectInvite[] }>,
        retry: false
    });
    const projects = list.data?.projects || [];
    const invites = invitesQ.data?.invites || [];
    const onInboxPreview = useCallback((applet: InboxApplet | null) => {
        setInboxPreview(Boolean(applet));
    }, []);

    return (
        <main className="pane next-pane is-in" id="pane-observatory">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Projects <span className="room-secondary">the Observatory</span></h1>
                </div>
                <div className="pane-header-actions">
                    {!inboxPreview && (
                        <button type="button" className="btn primary" data-tour="project-new" onClick={() => setCreating(true)}>
                            + New project
                        </button>
                    )}
                    {!inboxPreview && <CommandButton onOpen={() => setCommandOpen(true)} />}
                    <HeaderOverflow>
                        <button type="button" className="btn" onClick={() => queryClient.invalidateQueries({ queryKey: keys.observatory })}>Refresh</button>
                    </HeaderOverflow>
                </div>
            </header>
            <div className="pane-body">
                <div className="obs-view">
                    <CommandStrip command={command} onDismiss={dismiss} />

                    {list.isError && (
                        <div className="empty-state" style={{ marginTop: '6vh' }}>
                            <div className="empty-logo">🔭</div>
                            <div className="empty-title">Projects are unavailable right now.</div>
                            <div className="hint">{(list.error as Error).message}</div>
                        </div>
                    )}
                    {!inboxPreview && list.isPending && <div className="empty">Loading…</div>}
                    {!inboxPreview && list.data && projects.length === 0 && (
                        <div className="empty-state" style={{ marginTop: '6vh' }} data-tour="project-empty">
                            <div className="empty-logo">🔭</div>
                            <div className="empty-title">No projects yet</div>
                            <div className="hint" style={{ maxWidth: 460, margin: '0 auto 18px' }}>
                                A project is a durable home for one piece of work: a plan, runs, files, apps,
                                knowledge and the people on it. Create one with a name and a goal
                                {executionOn ? ', or let Goobster set one up from your instructions.' : '.'}
                            </div>
                            <div className="modal-actions" style={{ justifyContent: 'center' }}>
                                <button type="button" className="btn primary big" onClick={() => setCreating(true)}>+ New project</button>
                                {executionOn && (
                                    <CommandButton big label="✨ Give Goobster instructions" onOpen={() => setCommandOpen(true)} />
                                )}
                            </div>
                            {!executionOn && <p className="hint" style={{ marginTop: 14 }}>{EXECUTION_OFF}</p>}
                        </div>
                    )}
                    {!inboxPreview && invites.length > 0 && (
                        <div className="parlor-invites" data-tour="project-invites">
                            <div className="panel-section-head"><span>Invitations</span></div>
                            {invites.map((invite) => (
                                <div key={invite.id} className="invite-item">
                                    <span className="invite-body">
                                        <span className="invite-title">{invite.name || invite.slug}</span>
                                        <span className="hint">from {invite.inviterName || invite.inviterId}</span>
                                    </span>
                                    <button type="button" className="invite-action accept" title="Accept" onClick={async () => {
                                        try {
                                            const result = await api.projectRespondInvite(invite.id, true) as {
                                                slug?: string; ownerId?: string;
                                            };
                                            await queryClient.invalidateQueries({ queryKey: keys.projectInvites });
                                            await queryClient.invalidateQueries({ queryKey: keys.observatory });
                                            toast('You joined the project.');
                                            if (result.slug && result.ownerId) {
                                                void navigate({ to: projectPath({ owner: result.ownerId, slug: result.slug }) as never });
                                            }
                                        } catch (error) { toast((error as Error).message, true); }
                                    }}>✓</button>
                                    <button type="button" className="invite-action decline" title="Decline" onClick={async () => {
                                        try {
                                            await api.projectRespondInvite(invite.id, false);
                                            await queryClient.invalidateQueries({ queryKey: keys.projectInvites });
                                        } catch (error) { toast((error as Error).message, true); }
                                    }}>✕</button>
                                </div>
                            ))}
                        </div>
                    )}
                    {!inboxPreview && projects.length > 0 && (
                        <>
                            <NeedsYouBoard />
                            <div className="section-title">Projects</div>
                            <div className="list-card" data-tour="project-list">
                                {projects.map((item) => {
                                    const ownerId = item.ownerId || me.user.id;
                                    return (
                                        <Link
                                            key={`${ownerId}:${item.slug}`}
                                            className="list-row task-row obs-project-card"
                                            to={projectPath({ owner: ownerId, slug: item.slug }) as never}
                                            data-testid={`project-card-${ownerId}-${item.slug}`}
                                        >
                                            <div className="row-body">
                                                <strong>🔭 {item.name}</strong>
                                                <span className="badge">{item.slug}</span>
                                                {item.role === 'collaborator'
                                                    ? <span className="badge">collaborator</span>
                                                    : <span className="badge">owner</span>}
                                                {item.role === 'collaborator' && item.ownerName
                                                    ? <span className="badge">{item.ownerName}</span>
                                                    : null}
                                                {item.shared ? <span className="badge">🔗 shared</span> : null}
                                                {item.description ? <div className="row-meta obs-goal">{item.description}</div> : null}
                                                <div className="row-meta">
                                                    {item.role === 'collaborator'
                                                        ? `owner ${item.ownerName || item.ownerId} · `
                                                        : ''}
                                                    {item.runningJobs ? `🟢 ${item.runningJobs} running · ` : ''}
                                                    {item.totalJobs} run{item.totalJobs === 1 ? '' : 's'} · {item.sizeMb}/{item.quotaMb} MB · updated {whenLabel(item.updatedAt)}
                                                </div>
                                            </div>
                                            <span className="obs-chevron" aria-hidden="true">›</span>
                                        </Link>
                                    );
                                })}
                            </div>
                            <div className="hint" style={{ marginTop: 10 }}>
                                Open a project for its plan, runs, files, apps, knowledge, people and automations.
                                {executionOn
                                    ? ' Background runs notify you in your Inbox (and Discord, when connected) when they finish.'
                                    : ` ${EXECUTION_OFF}`}
                            </div>
                        </>
                    )}
                    <WorkshopInbox onPreviewChange={onInboxPreview} />
                </div>
            </div>

            {creating && <CreateProjectForm onClose={() => setCreating(false)} />}
            {commandOpen && (
                <CommandModal
                    target={null}
                    busy={Boolean(command?.active)}
                    onClose={() => setCommandOpen(false)}
                    onRun={(instructions) => { setCommandOpen(false); void run(instructions, null); }}
                />
            )}
        </main>
    );
}
