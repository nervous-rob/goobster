import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streamObservatoryCommand } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { MenuButton } from '../shell/MenuButton';
import { HeaderOverflow } from '../shell/HeaderOverflow';
import { WorkshopInbox, type InboxApplet } from '../components/WorkshopInbox';
import { ProjectExplorer } from '../components/ProjectExplorer';
import { ProjectChatDock } from '../components/ProjectChatDock';
import { ProjectPeopleModal } from './observatory/PeopleModal';
import { KnowledgeTab } from './observatory/KnowledgeTab';
import { MissionTab } from './observatory/MissionTab';
import { AppsTab } from './observatory/AppsTab';
import { ArtifactGallery } from './observatory/ArtifactGallery';
import { ToolChip } from '../components/ToolChip';
import { whenLabel } from './observatory/format';

type Project = {
    id?: number;
    slug: string;
    name: string;
    ownerId?: string;
    ownerName?: string | null;
    role?: 'owner' | 'collaborator';
    shared?: boolean;
    runningJobs?: number;
    totalJobs?: number;
    sizeMb?: number;
    quotaMb?: number;
    updatedAt?: string;
};
type ProjectInvite = {
    id: number;
    slug: string;
    name?: string;
    ownerId?: string;
    inviterName?: string | null;
    inviterId?: string;
};
type ContractCheck = {
    path: string;
    type?: string;
    minBytes?: number;
    ok: boolean;
    reason?: string | null;
    sizeBytes?: number | null;
};
type ContractResult = { ok: boolean; checkedAt?: string; checks: ContractCheck[] };
type Job = {
    id: number;
    status: string;
    language?: string;
    segments?: number;
    resumeCount?: number;
    exitCode?: number | null;
    checkpointAt?: string;
    finishedAt?: string;
    lastHeartbeatAt?: string;
    error?: string | null;
    // Stable failure reason (EXIT_NONZERO, TIMED_OUT, CANCELLED, OUTPUT_CONTRACT_FAILED, ...)
    errorCode?: string | null;
    // Provenance: who started it and, for event-chained stages, the settled job it reacted to.
    startedBy?: string | null;
    triggerId?: number | null;
    parentJobId?: number | null;
    // Frozen output-contract verdict (null when the job declared no required outputs).
    outputContractResult?: ContractResult | null;
    stdoutTail?: string;
    stderrTail?: string;
};
type FileRow = {
    path: string;
    size: number;
    url?: string;
    isVideo?: boolean;
    isImage?: boolean;
    modifiedAt?: string;
};
type Detail = {
    project: Project;
    jobs: Job[];
    files: FileRow[];
    checkpoint?: string | null;
    totalFiles?: number;
};
type CommandChip = { name: string; phase: string; isError?: boolean; argsPreview?: string };

const STATUS_ICONS: Record<string, string> = {
    RUNNING: '🟢', COMPLETED: '✅', FAILED: '❌',
    TIMED_OUT: '⏱️', CANCELLED: '⏹️', INTERRUPTED: '💤'
};

export function ObservatoryRoom() {
    const toast = useToast();
    const me = useMe();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<{ slug: string; ownerId: string; tab?: 'mission' | 'overview' } | null>(null);
    const slug = selected?.slug ?? null;
    const ownerId = selected?.ownerId ?? null;
    const openTab = selected?.tab;
    const [inboxPreview, setInboxPreview] = useState(false);
    const [dockOpen, setDockOpen] = useState(false);
    const [peopleOpen, setPeopleOpen] = useState(false);
    const [commandOpen, setCommandOpen] = useState(false);
    const [instructions, setInstructions] = useState('');
    const [command, setCommand] = useState<{
        active: boolean;
        label: string;
        draft: string;
        error: boolean;
        chips: CommandChip[];
    } | null>(null);

    const list = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        retry: false
    });
    const detail = useQuery({
        queryKey: [...keys.observatory, slug, ownerId],
        queryFn: () => api.observatoryProject(slug as string, ownerId) as Promise<Detail>,
        enabled: Boolean(slug),
        retry: false
    });
    const invitesQ = useQuery({
        queryKey: keys.projectInvites,
        queryFn: () => api.projectInvites() as Promise<{ invites: ProjectInvite[] }>,
        retry: false
    });

    const projects = list.data?.projects || [];
    const project = detail.data;
    const onInboxPreview = useCallback((applet: InboxApplet | null) => {
        setInboxPreview(Boolean(applet));
    }, []);

    async function runCommand() {
        const text = instructions.trim();
        if (!text) {
            toast('Tell Goobster what to do first.', true);
            return;
        }
        setCommandOpen(false);
        setCommand({
            active: true,
            label: slug ? `Commanding "${project?.project.name || slug}"…` : 'Commanding the Observatory…',
            draft: '',
            error: false,
            chips: []
        });
        let draft = '';
        let finalShown = false;
        try {
            await streamObservatoryCommand(
                { project: slug, owner: ownerId, instructions: text },
                {
                    onTool: (event) => {
                        setCommand((prev) => {
                            if (!prev) return prev;
                            const chips = [...prev.chips];
                            if (event.phase === 'start') {
                                chips.push({
                                    name: event.name,
                                    phase: 'start',
                                    argsPreview: event.argsPreview
                                });
                            } else {
                                for (let i = chips.length - 1; i >= 0; i--) {
                                    if (chips[i].name === event.name && chips[i].phase === 'start') {
                                        chips[i] = {
                                            name: event.name,
                                            phase: 'result',
                                            isError: event.isError,
                                            argsPreview: chips[i].argsPreview ?? event.argsPreview
                                        };
                                        break;
                                    }
                                }
                            }
                            return { ...prev, chips };
                        });
                    },
                    onDelta: (delta) => {
                        if (finalShown) return;
                        draft += delta;
                        setCommand((prev) => prev ? { ...prev, draft } : prev);
                    },
                    onMessage: (message) => {
                        finalShown = true;
                        let markdown = message.content || '';
                        for (const attachment of message.attachments || []) {
                            markdown += `\n\n📎 [${attachment.name || 'file'}](${attachment.url})`;
                        }
                        setCommand((prev) => prev ? { ...prev, draft: markdown, error: Boolean(message.isError) } : prev);
                    },
                    onError: (error) => {
                        setCommand((prev) => prev ? { ...prev, error: true, draft: error.message || 'Something went wrong.' } : prev);
                    }
                }
            );
            setCommand((prev) => prev ? { ...prev, active: false, label: slug ? `Command finished — "${project?.project.name || slug}"` : 'Command finished' } : prev);
        } catch (error) {
            setCommand((prev) => prev ? { ...prev, active: false, error: true, label: 'Command failed', draft: (error as Error).message } : prev);
        } finally {
            await queryClient.invalidateQueries({ queryKey: keys.observatory });
        }
    }

    if (list.isError && !slug) {
        return (
            <main className="pane next-pane is-in" id="pane-observatory">
                <header className="pane-header">
                    <div className="title-row">
                        <MenuButton />
                        <h1>The Observatory</h1>
                    </div>
                </header>
                <div className="pane-body">
                    <div className="empty">The Observatory is unavailable right now.</div>
                    <div className="hint">{(list.error as Error).message}</div>
                </div>
            </main>
        );
    }

    return (
        <main className="pane next-pane is-in" id="pane-observatory">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>{slug && project ? `🔭 ${project.project.name}` : 'The Observatory'}</h1>
                </div>
                <div className="pane-header-actions">
                    {slug && !inboxPreview && <button type="button" className="btn" onClick={() => { setSelected(null); setPeopleOpen(false); setDockOpen(false); }}>← Back</button>}
                    {slug
                        ? <button type="button" className={`btn${dockOpen ? ' primary' : ''}`} onClick={() => setDockOpen((open) => !open)}>
                            {dockOpen ? 'Hide chat' : 'Chat'}
                        </button>
                        : <button type="button" className="btn primary" onClick={() => { setInstructions(''); setCommandOpen(true); }}>✨ Command</button>}
                    <HeaderOverflow>
                        {slug && !inboxPreview && (
                            <button type="button" className="btn" onClick={() => setPeopleOpen(true)}>People</button>
                        )}
                        <button type="button" className="btn" onClick={() => queryClient.invalidateQueries({ queryKey: keys.observatory })}>Refresh</button>
                    </HeaderOverflow>
                </div>
            </header>
            <div className="pane-body">
                <div className={`obs-view${slug ? ' is-project' : ''}`}>
                {command && (
                    <div className="obs-command">
                        <div className="obs-command-head">
                            <span>{command.active ? <span className="tool-spinner" /> : (command.error ? '⚠' : '✨')}</span>
                            <strong>{command.label}</strong>
                            <span style={{ flex: 1 }} />
                            {command.active
                                ? <button type="button" className="btn danger" onClick={() => { void api.stop(); }}>◼ Stop</button>
                                : <button type="button" className="btn subtle" onClick={() => setCommand(null)}>✕</button>}
                        </div>
                        <div className="obs-command-strip">
                            {command.chips.map((chip, index) => (
                                <ToolChip
                                    key={`${chip.name}-${index}`}
                                    name={chip.name}
                                    argsPreview={chip.argsPreview}
                                    running={chip.phase === 'start'}
                                    isError={chip.isError}
                                />
                            ))}
                        </div>
                        <div className={`obs-command-reply${command.error ? ' error' : ''}`}>
                            <Markdown source={command.draft} onNotify={toast} />
                        </div>
                    </div>
                )}

                {!slug && !inboxPreview && list.isPending && <div className="empty">Loading…</div>}
                {!slug && !inboxPreview && list.data && projects.length === 0 && (
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">🔭</div>
                        <div className="empty-title">No projects yet</div>
                        <div className="hint" style={{ maxWidth: 460, margin: '0 auto 18px' }}>
                            Projects are persistent workspaces for apps, scripts, data, and automations.
                            Ask for one in chat, or command Goobster directly.
                        </div>
                        <button type="button" className="btn primary big" onClick={() => { setInstructions(''); setCommandOpen(true); }}>
                            ✨ Give Goobster instructions
                        </button>
                    </div>
                )}
                {!slug && !inboxPreview && (invitesQ.data?.invites || []).length > 0 && (
                    <div className="parlor-invites">
                        <div className="panel-section-head"><span>Invitations</span></div>
                        {(invitesQ.data?.invites || []).map((invite) => (
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
                                        if (result.slug && result.ownerId) {
                                            setSelected({ slug: result.slug, ownerId: result.ownerId });
                                        }
                                        toast('You joined the project.');
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
                {!slug && !inboxPreview && projects.length > 0 && (
                    <>
                        <NeedsYouBoard
                            onOpenProject={(next) => {
                                setSelected(next);
                            }}
                        />
                        <div className="section-title">Projects</div>
                        <div className="list-card">
                            {projects.map((item) => (
                                <div
                                    key={`${item.ownerId || ''}:${item.slug}`}
                                    className="list-row task-row obs-project-card"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setSelected({ slug: item.slug, ownerId: item.ownerId || me.user.id })}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            setSelected({ slug: item.slug, ownerId: item.ownerId || me.user.id });
                                        }
                                    }}
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
                                        <div className="row-meta">
                                            {item.role === 'collaborator'
                                                ? `owner ${item.ownerName || item.ownerId} · `
                                                : ''}
                                            {item.runningJobs ? `🟢 ${item.runningJobs} running · ` : ''}
                                            {item.totalJobs} job(s) · {item.sizeMb}/{item.quotaMb} MB · updated {whenLabel(item.updatedAt)}
                                        </div>
                                    </div>
                                    <span className="obs-chevron" aria-hidden="true">›</span>
                                </div>
                            ))}
                        </div>
                        <div className="hint" style={{ marginTop: 10 }}>
                            Open a project to watch its jobs, renders, and files live — and to render, share,
                            or ✨ command Goobster to continue it. Background jobs notify you in your Inbox (and Discord, when connected) when they finish.
                        </div>
                    </>
                )}
                {!slug && (
                    <WorkshopInbox onPreviewChange={onInboxPreview} />
                )}

                {slug && detail.isPending && <div className="empty">Loading…</div>}
                {slug && detail.isError && (
                    <div className="empty">Could not load this project. {(detail.error as Error).message}</div>
                )}
                {slug && project && (
                    <div className="obs-project-layout">
                        {dockOpen && (
                            <button
                                type="button"
                                className="obs-chat-backdrop"
                                aria-label="Close project chat"
                                onClick={() => setDockOpen(false)}
                            />
                        )}
                        <div className="obs-project-main">
                            <DetailView
                                key={`${slug}:${ownerId}:${openTab || 'overview'}`}
                                detail={project}
                                ownerId={ownerId}
                                initialTab={openTab === 'mission' ? 'mission' : 'overview'}
                                onDeleted={() => { setSelected(null); queryClient.invalidateQueries({ queryKey: keys.observatory }); }}
                                onChanged={() => queryClient.invalidateQueries({ queryKey: keys.observatory })}
                            />
                        </div>
                        <ProjectChatDock
                            slug={slug}
                            ownerId={ownerId}
                            projectName={project.project.name}
                            open={dockOpen}
                            onToggle={() => setDockOpen((open) => !open)}
                        />
                    </div>
                )}
                {peopleOpen && slug && (
                    <ProjectPeopleModal
                        slug={slug}
                        ownerId={ownerId}
                        meId={me.user.id}
                        onClose={() => setPeopleOpen(false)}
                        onLeft={() => {
                            setPeopleOpen(false);
                            setSelected(null);
                            queryClient.invalidateQueries({ queryKey: keys.observatory });
                        }}
                    />
                )}
                </div>
            </div>

            {commandOpen && (
                <Modal onClose={() => setCommandOpen(false)} wide>
                    <h2>{slug ? `Command "${project?.project.name || slug}"` : 'Command the Observatory'}</h2>
                    <p className="hint">
                        {slug
                            ? 'Goobster continues this project with your instructions — running code, starting jobs, or rendering.'
                            : 'Goobster acts across your whole Observatory — it can create projects, start runs, and render results.'}
                    </p>
                    <textarea
                        className="input"
                        rows={5}
                        value={instructions}
                        onChange={(e) => setInstructions(e.target.value)}
                        placeholder="What should Goobster do?"
                        autoFocus
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void runCommand();
                            }
                        }}
                    />
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={() => setCommandOpen(false)}>Cancel</button>
                        <button type="button" className="btn primary" disabled={command?.active} onClick={() => void runCommand()}>Run</button>
                    </div>
                </Modal>
            )}
        </main>
    );
}

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

function NeedsYouBoard({
    onOpenProject
}: {
    onOpenProject: (next: { slug: string; ownerId: string; tab?: 'mission' | 'overview' }) => void;
}) {
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
        <div className="obs-needs-you">
            <div className="obs-section-head">
                <h3>Needs you</h3>
                <span className="badge">{cards.length}</span>
            </div>
            <p className="hint">
                Approvals, design choices, blocked missions, and setup-contract findings across your projects.
                Open a card to continue in that project&apos;s Mission tab.
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
                                {colCards.map((card) => (
                                    <div
                                        key={card.id}
                                        className="list-row task-row"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => {
                                            if (!card.projectSlug) return;
                                            onOpenProject({
                                                slug: card.projectSlug,
                                                ownerId: card.ownerId || me.user.id,
                                                tab: card.column === 'setup' ? 'overview' : 'mission'
                                            });
                                        }}
                                        onKeyDown={(event) => {
                                            if ((event.key === 'Enter' || event.key === ' ') && card.projectSlug) {
                                                event.preventDefault();
                                                onOpenProject({
                                                    slug: card.projectSlug,
                                                    ownerId: card.ownerId || me.user.id,
                                                    tab: card.column === 'setup' ? 'overview' : 'mission'
                                                });
                                            }
                                        }}
                                    >
                                        <div className="row-body">
                                            <strong>{card.title}</strong>
                                            <span className="badge">{card.projectSlug}</span>
                                            {card.choices?.length ? (
                                                <span className="badge">{card.choices.length} choices</span>
                                            ) : null}
                                            {card.detail ? <div className="row-meta">{card.detail}</div> : null}
                                        </div>
                                        <span className="obs-chevron" aria-hidden="true">›</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function DetailView({
    detail, ownerId, initialTab = 'overview', onDeleted, onChanged
}: {
    detail: Detail;
    ownerId?: string | null;
    initialTab?: 'overview' | 'mission' | 'explorer' | 'apps' | 'automations' | 'knowledge';
    onDeleted: () => void;
    onChanged: () => void;
}) {
    const [tab, setTab] = useState(initialTab);
    const toast = useToast();
    const confirm = useConfirm();
    const p = detail.project;
    // Trigger names for job provenance ("started by trigger X"); shares the
    // Automations tab's cache entry.
    const triggersQ = useQuery({
        queryKey: keys.projectTriggers(p.slug, ownerId),
        queryFn: () => api.projectTriggers(p.slug, ownerId) as Promise<{ triggers: Trigger[] }>,
        retry: false,
        enabled: detail.jobs.some((j) => j.triggerId != null)
    });
    const triggerNames = new Map<number, string>(
        (triggersQ.data?.triggers || []).map((t) => [t.id, t.name] as const)
    );
    const completed = detail.jobs.filter((j) => j.status === 'COMPLETED').length;
    const failed = detail.jobs.filter((j) => j.status === 'FAILED' || j.status === 'TIMED_OUT').length;
    const quotaPct = Math.min(100, Math.round(((p.sizeMb || 0) / Math.max(p.quotaMb || 1, 1)) * 100));
    const statusBits = [
        p.runningJobs ? `${p.runningJobs} running` : null,
        `${p.totalJobs || 0} job${p.totalJobs === 1 ? '' : 's'}`,
        completed ? `${completed} completed` : null,
        failed ? `${failed} failed` : null,
        `${p.sizeMb} / ${p.quotaMb} MB`,
        p.updatedAt ? `updated ${whenLabel(p.updatedAt)}` : null
    ].filter(Boolean);

    return (
        <>
            <div className={`obs-project-head${tab === 'overview' ? '' : ' is-compact'}`}>
                <div className="obs-project-status">
                    <p className="obs-status-line">{statusBits.join(' · ')}</p>
                    {tab === 'overview' && (
                        <div className="obs-quota" role="img" aria-label={`Disk quota ${quotaPct}% used`}>
                            <i style={{ width: `${quotaPct}%` }} />
                        </div>
                    )}
                </div>
                {tab === 'overview' && (
                <div className="obs-actions">
                    <button
                        type="button"
                        className="btn"
                        onClick={async () => {
                            try {
                                const result = await api.observatoryRender(p.slug, null, ownerId) as { frames: number; fps: number };
                                toast(`Rendered ${result.frames} frame(s) at ${result.fps} fps.`);
                                onChanged();
                            } catch (error) {
                                toast((error as Error).message, true);
                            }
                        }}
                    >Render video</button>
                    <a className="btn" target="_blank" rel="noopener" href={api.observatoryDashboardUrl(p.slug, ownerId)}>Snapshot</a>
                    {p.role !== 'collaborator' && (
                    <button
                        type="button"
                        className="btn"
                        onClick={async () => {
                            try {
                                const status = await api.observatoryShareStatus(p.slug, ownerId) as { shared?: boolean; url?: string };
                                if (!status.shared) {
                                    const created = await api.observatoryCreateShare(p.slug, ownerId) as { url: string };
                                    const url = new URL(created.url, window.location.origin).href;
                                    try { await navigator.clipboard.writeText(url); } catch { /* denied */ }
                                    toast(`Share link copied: ${url}`);
                                } else if (await confirm('Revoke the share link? The URL stops working immediately.')) {
                                    await api.observatoryRevokeShare(p.slug, ownerId);
                                    toast('Share link revoked.');
                                } else if (status.url) {
                                    const url = new URL(status.url, window.location.origin).href;
                                    try { await navigator.clipboard.writeText(url); } catch { /* denied */ }
                                    toast(`Still shared — link copied: ${url}`);
                                }
                                onChanged();
                            } catch (error) {
                                toast((error as Error).message, true);
                            }
                        }}
                    >{p.shared ? 'Shared' : 'Share'}</button>
                    )}
                    {p.role !== 'collaborator' && (
                    <button
                        type="button"
                        className="btn danger"
                        onClick={async () => {
                            if (!await confirm(`Delete "${p.name}" and its whole workspace? Files and job history are gone for good.`)) return;
                            try {
                                await api.observatoryDeleteProject(p.slug, ownerId);
                                toast('Project deleted.');
                                onDeleted();
                            } catch (error) {
                                toast((error as Error).message, true);
                            }
                        }}
                    >Delete</button>
                    )}
                </div>
                )}
            </div>

            <div className="segment obs-tabs" role="tablist">
                <button type="button" className={`segment-btn${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
                <button type="button" className={`segment-btn${tab === 'mission' ? ' active' : ''}`} onClick={() => setTab('mission')}>Mission</button>
                <button type="button" className={`segment-btn${tab === 'explorer' ? ' active' : ''}`} onClick={() => setTab('explorer')}>Explorer</button>
                <button type="button" className={`segment-btn${tab === 'apps' ? ' active' : ''}`} onClick={() => setTab('apps')}>Apps</button>
                <button type="button" className={`segment-btn${tab === 'automations' ? ' active' : ''}`} onClick={() => setTab('automations')}>Automations</button>
                <button type="button" className={`segment-btn${tab === 'knowledge' ? ' active' : ''}`} onClick={() => setTab('knowledge')}>Knowledge</button>
            </div>

            {tab === 'mission' && <MissionTab slug={p.slug} ownerId={ownerId} />}
            {tab === 'explorer' && <ProjectExplorer slug={p.slug} ownerId={ownerId} onChanged={onChanged} />}
            {tab === 'apps' && <AppsTab slug={p.slug} ownerId={ownerId} />}
            {tab === 'automations' && <AutomationsTab slug={p.slug} ownerId={ownerId} role={p.role} />}
            {tab === 'knowledge' && <KnowledgeTab slug={p.slug} ownerId={ownerId} projectId={p.id} />}

            {tab === 'overview' && (
                <div className="obs-overview">
                    <OverviewMission slug={p.slug} ownerId={ownerId} onOpen={() => setTab('mission')} />
                    <section className="obs-overview-jobs">
                        <div className="obs-section-head">
                            <h3>Jobs</h3>
                            <span className="hint">{detail.jobs.length || 'none yet'}</span>
                        </div>
                        {detail.jobs.length === 0
                            ? <div className="empty">No jobs yet — open chat and ask Goobster to start one.</div>
                            : (
                                <div className="list-card">
                                    {detail.jobs.map((job) => (
                                        <div key={job.id} className="list-row task-row">
                                            <div className="row-body">
                                                <span className="badge">{STATUS_ICONS[job.status] || ''} {job.status}</span>
                                                <strong>Job #{job.id}</strong>
                                                <div className="row-meta">
                                                    {[job.language, `${job.segments || 0} segment(s)`, `${job.resumeCount || 0} resume(s)`,
                                                        job.finishedAt ? `finished ${whenLabel(job.finishedAt)}` : `heartbeat ${whenLabel(job.lastHeartbeatAt)}`]
                                                        .filter(Boolean).join(' · ')}
                                                </div>
                                                {job.error ? <div className="row-meta obs-error">{job.error}</div> : null}
                                                <JobProvenance job={job} triggers={triggerNames} />
                                                {job.stdoutTail?.trim() ? (
                                                    <details className="obs-tail"><summary>stdout tail</summary><pre>{job.stdoutTail}</pre></details>
                                                ) : null}
                                            </div>
                                            {job.status === 'RUNNING' && (
                                                <button type="button" className="btn danger" onClick={async () => {
                                                    if (!await confirm(`Cancel job #${job.id}?`)) return;
                                                    try {
                                                        await api.observatoryCancelJob(job.id);
                                                        toast(`Job #${job.id} cancelled.`);
                                                        onChanged();
                                                    } catch (error) { toast((error as Error).message, true); }
                                                }}>Cancel</button>
                                            )}
                                            {(job.status === 'INTERRUPTED' || job.status === 'TIMED_OUT') && (
                                                <button type="button" className="btn" onClick={async () => {
                                                    try {
                                                        await api.observatoryResumeJob(job.id);
                                                        toast(`Job #${job.id} resumed.`);
                                                        onChanged();
                                                    } catch (error) { toast((error as Error).message, true); }
                                                }}>Resume</button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                    </section>
                    <ArtifactGallery
                        files={detail.files}
                        totalFiles={detail.totalFiles}
                        onBrowse={() => setTab('explorer')}
                    />
                </div>
            )}
        </>
    );
}

const CONTRACT_REASONS: Record<string, string> = {
    missing: 'missing',
    too_small: 'too small',
    invalid_json: 'invalid JSON',
    directory: 'is a directory',
    not_a_file: 'not a regular file',
    illegal_path: 'illegal path'
};

/**
 * Expandable diagnostics for one job: stable error code, who started it
 * (and the upstream job an event stage reacted to), and the per-output
 * verdict of its frozen contract. Renders nothing for a plain ad-hoc job
 * with no contract, so the list stays quiet in the common case.
 */
function JobProvenance({ job, triggers }: { job: Job; triggers: Map<number, string> }) {
    const contract = job.outputContractResult;
    const hasContract = Boolean(contract && Array.isArray(contract.checks) && contract.checks.length);
    const interesting = Boolean(
        (job.errorCode && job.errorCode !== 'EXIT_NONZERO')
        || job.parentJobId != null
        || job.triggerId != null
        || hasContract
    );
    if (!interesting) return null;
    const startedBy = job.startedBy === 'trigger' && job.triggerId != null
        ? `trigger “${triggers.get(job.triggerId) || `#${job.triggerId}`}”`
        : (job.startedBy || 'unknown');
    const failedChecks = hasContract ? contract!.checks.filter((c) => !c.ok).length : 0;
    const summaryBits = [
        job.errorCode && job.errorCode !== 'EXIT_NONZERO' ? job.errorCode : null,
        job.parentJobId != null ? `after job #${job.parentJobId}` : null,
        hasContract
            ? (contract!.ok
                ? `${contract!.checks.length} output(s) validated`
                : `${failedChecks} of ${contract!.checks.length} output(s) failed`)
            : null
    ].filter(Boolean);
    return (
        <details className="obs-tail obs-job-detail" data-testid={`job-detail-${job.id}`}>
            <summary>{summaryBits.length ? summaryBits.join(' · ') : 'details'}</summary>
            <dl className="obs-kv">
                {job.errorCode ? (<><dt>Error code</dt><dd><code>{job.errorCode}</code></dd></>) : null}
                <dt>Started by</dt><dd>{startedBy}</dd>
                {job.parentJobId != null ? (
                    <><dt>Source job</dt><dd>#{job.parentJobId} (this stage reacted to its settlement)</dd></>
                ) : null}
                {hasContract ? (
                    <>
                        <dt>Required outputs</dt>
                        <dd>
                            <ul className="obs-contract">
                                {contract!.checks.map((check) => (
                                    <li key={check.path} className={check.ok ? 'ok' : 'failed'}>
                                        {check.ok ? '✅' : '❌'} <code>{check.path}</code>
                                        {check.type && check.type !== 'file' ? ` · ${check.type}` : ''}
                                        {check.minBytes ? ` · ≥ ${check.minBytes} B` : ''}
                                        {check.ok
                                            ? (check.sizeBytes != null ? ` · ${check.sizeBytes} B` : '')
                                            : ` · ${CONTRACT_REASONS[check.reason || ''] || check.reason || 'failed'}`}
                                    </li>
                                ))}
                            </ul>
                            {contract!.checkedAt ? <div className="hint">checked {whenLabel(contract!.checkedAt)}</div> : null}
                        </dd>
                    </>
                ) : null}
            </dl>
        </details>
    );
}

function OverviewMission({
    slug, ownerId, onOpen
}: {
    slug: string;
    ownerId?: string | null;
    onOpen: () => void;
}) {
    const q = useQuery({
        queryKey: keys.projectMission(slug, ownerId),
        queryFn: () => api.projectMission(slug, ownerId) as Promise<{
            mission: { title: string; status: string; evaluation?: { overall?: string } } | null;
        }>
    });
    const mission = q.data?.mission;
    if (!mission) {
        return (
            <section className="obs-overview-mission">
                <div className="obs-section-head">
                    <h3>Mission</h3>
                    <button type="button" className="btn" onClick={onOpen}>Start one</button>
                </div>
                <p className="hint">No open mission — name an outcome and how you will know it worked.</p>
            </section>
        );
    }
    return (
        <section className="obs-overview-mission">
            <div className="obs-section-head">
                <h3>Mission</h3>
                <span className="badge">{mission.status}</span>
            </div>
            <p className="obs-mission-objective">{mission.title}</p>
            <button type="button" className="btn" onClick={onOpen}>Open mission</button>
        </section>
    );
}

type Trigger = {
    id: number;
    name: string;
    kind: 'cron' | 'event';
    schedule?: string | null;
    nextRun?: string | null;
    eventTopic?: string | null;
    sourceAssetId?: number | null;
    sourceTriggerId?: number | null;
    action: 'run_script' | 'render' | 'fetch_data' | 'agent_prompt';
    actionAssetId?: number | null;
    actionParams?: Record<string, unknown>;
    isEnabled: boolean;
    lastRun?: string | null;
    // Dispatch result ("started: job #12, awaiting settlement") ...
    lastOutcome?: string | null;
    // ... vs. how the most recently started stage actually settled.
    lastJobOutcome?: string | null;
};

type Delivery = {
    id: number;
    sourceJobId: number;
    sourceStatus?: string | null;
    sourceFinishedAt?: string | null;
    status: 'STARTED' | 'DELIVERED' | 'RETRYABLE' | 'FAILED' | 'SKIPPED';
    attempts: number;
    childJobId?: number | null;
    childStatus?: string | null;
    childErrorCode?: string | null;
    detail?: string | null;
    nextAttemptAt?: string | null;
    updatedAt: string;
};

type ScriptAsset = { id: number; slug: string; name: string; currentVersion?: number | null };

type TriggerDraft = {
    name: string;
    kind: 'cron' | 'event';
    schedule: string;
    eventTopic: 'job_completed' | 'job_failed' | 'job_settled';
    sourceAssetId: string;
    sourceTriggerId: string;
    action: Trigger['action'];
    actionAssetId: string;
    background: boolean;
    requiredOutputs: string;
    fps: string;
    url: string;
    filename: string;
    prompt: string;
    allowSelfChain: boolean;
    maxChainDepth: string;
    isEnabled: boolean;
};

const EMPTY_DRAFT: TriggerDraft = {
    name: '',
    kind: 'cron',
    schedule: '0 2 * * *',
    eventTopic: 'job_settled',
    sourceAssetId: '',
    sourceTriggerId: '',
    action: 'run_script',
    actionAssetId: '',
    background: true,
    requiredOutputs: '',
    fps: '',
    url: '',
    filename: '',
    prompt: '',
    allowSelfChain: false,
    maxChainDepth: '',
    isEnabled: true
};

function draftFromTrigger(trigger: Trigger): TriggerDraft {
    const params = trigger.actionParams || {};
    return {
        name: trigger.name,
        kind: trigger.kind,
        schedule: trigger.schedule || '0 2 * * *',
        eventTopic: (trigger.eventTopic as TriggerDraft['eventTopic']) || 'job_settled',
        sourceAssetId: trigger.sourceAssetId != null ? String(trigger.sourceAssetId) : '',
        sourceTriggerId: trigger.sourceTriggerId != null ? String(trigger.sourceTriggerId) : '',
        action: trigger.action,
        actionAssetId: trigger.actionAssetId != null ? String(trigger.actionAssetId) : '',
        background: params.background !== false && params.background !== 0,
        requiredOutputs: Array.isArray(params.requiredOutputs) && params.requiredOutputs.length
            ? JSON.stringify(params.requiredOutputs, null, 2)
            : '',
        fps: params.fps != null ? String(params.fps) : '',
        url: typeof params.url === 'string' ? params.url : '',
        filename: typeof params.filename === 'string' ? params.filename : '',
        prompt: typeof params.prompt === 'string' ? params.prompt : '',
        allowSelfChain: params.allowSelfChain === true || params.allowSelfChain === 1,
        maxChainDepth: params.maxChainDepth != null ? String(params.maxChainDepth) : '',
        isEnabled: trigger.isEnabled
    };
}

/** Parse the required-outputs textarea: empty clears; otherwise a JSON array. */
function parseRequiredOutputs(text: string): unknown[] | null {
    const raw = text.trim();
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Required outputs must be a JSON array like [{ "path": "out/{utc_date}.json", "type": "json" }].');
    }
    if (!Array.isArray(parsed)) throw new Error('Required outputs must be a JSON array.');
    return parsed;
}

function payloadFromDraft(draft: TriggerDraft): Record<string, unknown> {
    const actionParams: Record<string, unknown> = {};
    if (draft.action === 'run_script') {
        actionParams.background = draft.background;
        // null drops a previously stored contract (the API merges params).
        actionParams.requiredOutputs = parseRequiredOutputs(draft.requiredOutputs);
    }
    if (draft.action === 'render' && draft.fps.trim()) actionParams.fps = Number(draft.fps);
    if (draft.action === 'fetch_data') {
        actionParams.url = draft.url.trim();
        if (draft.filename.trim()) actionParams.filename = draft.filename.trim();
    }
    if (draft.action === 'agent_prompt') actionParams.prompt = draft.prompt;
    if (draft.allowSelfChain) actionParams.allowSelfChain = true;
    if (draft.maxChainDepth.trim()) actionParams.maxChainDepth = Number(draft.maxChainDepth);
    return {
        name: draft.name.trim(),
        kind: draft.kind,
        schedule: draft.kind === 'cron' ? draft.schedule.trim() : null,
        eventTopic: draft.kind === 'event' ? draft.eventTopic : null,
        sourceAssetId: draft.kind === 'event' && draft.sourceAssetId ? Number(draft.sourceAssetId) : null,
        sourceTriggerId: draft.kind === 'event' && draft.sourceTriggerId ? Number(draft.sourceTriggerId) : null,
        action: draft.action,
        actionAssetId: draft.action === 'run_script' && draft.actionAssetId
            ? Number(draft.actionAssetId)
            : null,
        actionParams,
        isEnabled: draft.isEnabled
    };
}

/** "from ingest" / "from trigger Nightly" for the automation row meta. */
function describeFilters(trigger: Trigger, scripts: ScriptAsset[], triggers: Trigger[]): string | null {
    if (trigger.kind !== 'event') return null;
    const parts: string[] = [];
    if (trigger.sourceAssetId != null) {
        const asset = scripts.find((s) => s.id === trigger.sourceAssetId);
        parts.push(asset ? asset.slug : `asset #${trigger.sourceAssetId}`);
    }
    if (trigger.sourceTriggerId != null) {
        const source = triggers.find((t) => t.id === trigger.sourceTriggerId);
        parts.push(source ? `trigger "${source.name}"` : `trigger #${trigger.sourceTriggerId}`);
    }
    return parts.length ? `from ${parts.join(' + ')}` : null;
}

const DELIVERY_ICONS: Record<Delivery['status'], string> = {
    STARTED: '⏳', DELIVERED: '📬', RETRYABLE: '🔁', FAILED: '❌', SKIPPED: '⏭️'
};

/**
 * Per-event delivery records of an event trigger, loaded when expanded:
 * which settled source job relayed as which child job, or why it has not
 * (busy project = RETRYABLE with a next attempt; FAILED / SKIPPED with a reason).
 */
function TriggerDeliveries({ slug, ownerId, trigger }: { slug: string; ownerId?: string | null; trigger: Trigger }) {
    const [open, setOpen] = useState(false);
    const q = useQuery({
        queryKey: [...keys.projectTriggers(slug, ownerId), 'deliveries', trigger.id],
        queryFn: () => api.projectTriggerDeliveries(slug, trigger.id, ownerId) as Promise<{ deliveries: Delivery[] }>,
        enabled: open,
        retry: false
    });
    const deliveries = q.data?.deliveries || [];
    return (
        <details
            className="obs-tail obs-deliveries"
            data-testid={`trigger-deliveries-${trigger.id}`}
            onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
            <summary>deliveries</summary>
            {!open ? null : q.isLoading
                ? <div className="hint">Loading…</div>
                : q.error
                    ? <div className="row-meta obs-error">{(q.error as Error).message}</div>
                    : deliveries.length === 0
                        ? <div className="hint">No matching job has settled yet.</div>
                        : (
                            <ul className="obs-delivery-list">
                                {deliveries.map((d) => (
                                    <li key={d.id} className={`delivery-${d.status.toLowerCase()}`}>
                                        <span className="badge">{DELIVERY_ICONS[d.status]} {d.status}</span>
                                        {' '}source job #{d.sourceJobId}{d.sourceStatus ? ` (${d.sourceStatus})` : ''}
                                        {d.childJobId ? <> → child job #{d.childJobId}{d.childStatus ? ` ${d.childStatus}` : ''}{d.childErrorCode ? ` (${d.childErrorCode})` : ''}</> : null}
                                        <div className="row-meta">
                                            {[
                                                `${d.attempts} attempt(s)`,
                                                d.nextAttemptAt ? `next ${whenLabel(d.nextAttemptAt)}` : null,
                                                d.detail || null,
                                                whenLabel(d.updatedAt)
                                            ].filter(Boolean).join(' · ')}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
        </details>
    );
}

function AutomationsTab({ slug, ownerId, role }: { slug: string; ownerId?: string | null; role?: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; id?: number; draft: TriggerDraft } | null>(null);

    const list = useQuery({
        queryKey: keys.projectTriggers(slug, ownerId),
        queryFn: () => api.projectTriggers(slug, ownerId) as Promise<{ triggers: Trigger[] }>,
        retry: false
    });
    const scripts = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), 'script'],
        queryFn: () => api.projectAssets(slug, 'script', ownerId) as Promise<{ assets: ScriptAsset[] }>,
        retry: false
    });

    const triggers = list.data?.triggers || [];
    const scriptAssets = scripts.data?.assets || [];

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: keys.projectTriggers(slug, ownerId) });
    }

    async function toggleEnabled(trigger: Trigger) {
        try {
            await api.updateProjectTrigger(slug, trigger.id, { isEnabled: !trigger.isEnabled }, ownerId);
            toast(trigger.isEnabled ? `Paused "${trigger.name}".` : `Armed "${trigger.name}".`);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function remove(trigger: Trigger) {
        if (!await confirm(`Delete trigger "${trigger.name}"?`)) return;
        try {
            await api.deleteProjectTrigger(slug, trigger.id, ownerId);
            toast(`Deleted "${trigger.name}".`);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function save() {
        if (!editor) return;
        try {
            const body = payloadFromDraft(editor.draft);
            if (editor.mode === 'create') {
                await api.createProjectTrigger(slug, body, ownerId);
                toast(`Created trigger "${editor.draft.name}".`);
            } else if (editor.id != null) {
                await api.updateProjectTrigger(slug, editor.id, body, ownerId);
                toast(`Updated "${editor.draft.name}".`);
            }
            setEditor(null);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    if (list.isPending) return <div className="empty">Loading automations…</div>;
    if (list.isError) return <div className="empty">{(list.error as Error).message}</div>;

    return (
        <div className="obs-automations">
            <div className="obs-apps-toolbar">
                <div className="hint" style={{ flex: 1, margin: 0 }}>
                    Cron and event triggers on this project. Deterministic actions skip the agent.
                </div>
                <button
                    type="button"
                    className="btn primary"
                    onClick={() => setEditor({ mode: 'create', draft: { ...EMPTY_DRAFT } })}
                >+ New trigger</button>
            </div>
            {triggers.length === 0
                ? (
                    <div className="empty-state" style={{ marginTop: '4vh' }}>
                        <div className="empty-title">No automations yet</div>
                        <div className="hint">Run a stored script on a schedule, or chain jobs with job_settled.</div>
                    </div>
                )
                : (
                    <div className="list-card">
                        {triggers.map((trigger) => (
                            <div key={trigger.id} className="list-row task-row">
                                <div className="row-body">
                                    <span className="badge">{trigger.isEnabled ? '🟢' : '⏸️'} {trigger.kind}</span>
                                    <strong>{trigger.name}</strong>
                                    <div className="row-meta">
                                        {[
                                            trigger.kind === 'cron'
                                                ? `cron ${trigger.schedule}`
                                                : trigger.eventTopic,
                                            describeFilters(trigger, scriptAssets, triggers),
                                            trigger.action,
                                            Array.isArray(trigger.actionParams?.requiredOutputs)
                                                && trigger.actionParams.requiredOutputs.length
                                                ? `${trigger.actionParams.requiredOutputs.length} required output(s)`
                                                : null,
                                            trigger.lastRun ? `last ${whenLabel(trigger.lastRun)}` : 'never ran'
                                        ].filter(Boolean).join(' · ')}
                                    </div>
                                    {trigger.lastOutcome || trigger.lastJobOutcome ? (
                                        <div className="row-meta obs-outcomes">
                                            {trigger.lastOutcome ? <span>dispatch: {trigger.lastOutcome}</span> : null}
                                            {trigger.lastJobOutcome ? <span>stage: {trigger.lastJobOutcome}</span> : null}
                                        </div>
                                    ) : null}
                                    {trigger.kind === 'event' ? (
                                        <TriggerDeliveries slug={slug} ownerId={ownerId} trigger={trigger} />
                                    ) : null}
                                </div>
                                <button type="button" className="btn" onClick={() => void toggleEnabled(trigger)}>
                                    {trigger.isEnabled ? 'Pause' : 'Enable'}
                                </button>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() => setEditor({
                                        mode: 'edit',
                                        id: trigger.id,
                                        draft: draftFromTrigger(trigger)
                                    })}
                                >Edit</button>
                                <button type="button" className="btn danger" onClick={() => void remove(trigger)}>
                                    Delete
                                </button>
                            </div>
                        ))}
                    </div>
                )}

            {editor && (
                <Modal onClose={() => setEditor(null)} wide>
                    <h2>{editor.mode === 'create' ? 'New trigger' : `Edit "${editor.draft.name}"`}</h2>
                    <div className="obs-trigger-form">
                        <label className="field">
                            <span className="hint">Name</span>
                            <input
                                className="input"
                                value={editor.draft.name}
                                onChange={(e) => setEditor({
                                    ...editor, draft: { ...editor.draft, name: e.target.value }
                                })}
                            />
                        </label>
                        <label className="field">
                            <span className="hint">When</span>
                            <select
                                className="select"
                                value={editor.draft.kind}
                                onChange={(e) => setEditor({
                                    ...editor,
                                    draft: { ...editor.draft, kind: e.target.value as TriggerDraft['kind'] }
                                })}
                            >
                                <option value="cron">Cron (UTC)</option>
                                <option value="event">Event</option>
                            </select>
                        </label>
                        {editor.draft.kind === 'cron'
                            ? (
                                <label className="field">
                                    <span className="hint">Schedule (5-field cron, UTC)</span>
                                    <input
                                        className="input"
                                        value={editor.draft.schedule}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, schedule: e.target.value }
                                        })}
                                        placeholder="0 2 * * *"
                                    />
                                </label>
                            )
                            : (
                                <label className="field">
                                    <span className="hint">Event</span>
                                    <select
                                        className="select"
                                        value={editor.draft.eventTopic}
                                        onChange={(e) => setEditor({
                                            ...editor,
                                            draft: {
                                                ...editor.draft,
                                                eventTopic: e.target.value as TriggerDraft['eventTopic']
                                            }
                                        })}
                                    >
                                        <option value="job_settled">job_settled (any terminal state)</option>
                                        <option value="job_completed">job_completed</option>
                                        <option value="job_failed">job_failed</option>
                                    </select>
                                </label>
                            )}
                        {editor.draft.kind === 'event' && (
                            <>
                                <label className="field">
                                    <span className="hint">Only jobs from script (upstream stage, optional)</span>
                                    <select
                                        className="select"
                                        value={editor.draft.sourceAssetId}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, sourceAssetId: e.target.value }
                                        })}
                                    >
                                        <option value="">Any job in the project</option>
                                        {scriptAssets.map((asset) => (
                                            <option key={asset.id} value={asset.id}>
                                                {asset.name} ({asset.slug})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field">
                                    <span className="hint">Only jobs started by trigger (optional)</span>
                                    <select
                                        className="select"
                                        value={editor.draft.sourceTriggerId}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, sourceTriggerId: e.target.value }
                                        })}
                                    >
                                        <option value="">Any trigger or manual run</option>
                                        {triggers
                                            .filter((t) => editor.mode !== 'edit' || t.id !== editor.id)
                                            .map((t) => (
                                                <option key={t.id} value={t.id}>{t.name}</option>
                                            ))}
                                    </select>
                                </label>
                            </>
                        )}
                        <label className="field">
                            <span className="hint">Action</span>
                            <select
                                className="select"
                                value={editor.draft.action}
                                onChange={(e) => setEditor({
                                    ...editor,
                                    draft: { ...editor.draft, action: e.target.value as Trigger['action'] }
                                })}
                            >
                                <option value="run_script">Run script</option>
                                <option value="render">Render frames</option>
                                <option value="fetch_data">Fetch data (allowlisted host)</option>
                                {role !== 'collaborator' && <option value="agent_prompt">Agent prompt</option>}
                            </select>
                        </label>
                        {editor.draft.action === 'run_script' && (
                            <>
                                <label className="field">
                                    <span className="hint">Script asset</span>
                                    <select
                                        className="select"
                                        value={editor.draft.actionAssetId}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, actionAssetId: e.target.value }
                                        })}
                                    >
                                        <option value="">Select a script…</option>
                                        {scriptAssets.map((asset) => (
                                            <option key={asset.id} value={asset.id}>
                                                {asset.name} ({asset.slug}
                                                {asset.currentVersion ? ` · v${asset.currentVersion}` : ''})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field checkbox">
                                    <input
                                        type="checkbox"
                                        checked={editor.draft.background}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, background: e.target.checked }
                                        })}
                                    />
                                    <span>Background job (records provenance, can chain)</span>
                                </label>
                                <label className="field">
                                    <span className="hint">
                                        Required outputs (optional JSON; exit 0 without them settles FAILED)
                                    </span>
                                    <textarea
                                        className="input"
                                        rows={3}
                                        value={editor.draft.requiredOutputs}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, requiredOutputs: e.target.value }
                                        })}
                                        placeholder={'[{ "path": "pipeline/manifest_{utc_date}.json", "type": "json", "minBytes": 2 }]'}
                                    />
                                </label>
                            </>
                        )}
                        {editor.draft.action === 'render' && (
                            <label className="field">
                                <span className="hint">FPS (optional)</span>
                                <input
                                    className="input"
                                    value={editor.draft.fps}
                                    onChange={(e) => setEditor({
                                        ...editor, draft: { ...editor.draft, fps: e.target.value }
                                    })}
                                    placeholder="24"
                                />
                            </label>
                        )}
                        {editor.draft.action === 'fetch_data' && (
                            <>
                                <label className="field">
                                    <span className="hint">HTTPS URL (allowlisted host)</span>
                                    <input
                                        className="input"
                                        value={editor.draft.url}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, url: e.target.value }
                                        })}
                                    />
                                </label>
                                <label className="field">
                                    <span className="hint">Filename (optional)</span>
                                    <input
                                        className="input"
                                        value={editor.draft.filename}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, filename: e.target.value }
                                        })}
                                    />
                                </label>
                            </>
                        )}
                        {editor.draft.action === 'agent_prompt' && (
                            <label className="field">
                                <span className="hint">Prompt</span>
                                <textarea
                                    className="input"
                                    rows={4}
                                    value={editor.draft.prompt}
                                    onChange={(e) => setEditor({
                                        ...editor, draft: { ...editor.draft, prompt: e.target.value }
                                    })}
                                />
                            </label>
                        )}
                        <label className="field checkbox">
                            <input
                                type="checkbox"
                                checked={editor.draft.isEnabled}
                                onChange={(e) => setEditor({
                                    ...editor, draft: { ...editor.draft, isEnabled: e.target.checked }
                                })}
                            />
                            <span>Enabled</span>
                        </label>
                        {editor.draft.kind === 'event' && (
                            <label className="field checkbox">
                                <input
                                    type="checkbox"
                                    checked={editor.draft.allowSelfChain}
                                    onChange={(e) => setEditor({
                                        ...editor,
                                        draft: { ...editor.draft, allowSelfChain: e.target.checked }
                                    })}
                                />
                                <span>Allow self-chain (fire on a job this trigger started)</span>
                            </label>
                        )}
                    </div>
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={() => setEditor(null)}>Cancel</button>
                        <button type="button" className="btn primary" onClick={() => void save()}>Save</button>
                    </div>
                </Modal>
            )}
        </div>
    );
}
