import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, streamObservatoryCommand } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { MenuButton } from '../shell/MenuButton';
import { renderApplet as renderAppletJs } from '../renderers/codeblocks.js';

type Project = {
    slug: string;
    name: string;
    shared?: boolean;
    runningJobs?: number;
    totalJobs?: number;
    sizeMb?: number;
    quotaMb?: number;
    updatedAt?: string;
};
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
type ToolChip = { name: string; phase: string; isError?: boolean };

const STATUS_ICONS: Record<string, string> = {
    RUNNING: '🟢', COMPLETED: '✅', FAILED: '❌',
    TIMED_OUT: '⏱️', CANCELLED: '⏹️', INTERRUPTED: '💤'
};

function whenLabel(utcText?: string): string {
    if (!utcText) return '';
    const date = new Date(utcText.includes('T') ? utcText : `${utcText.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return utcText;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sizeLabel(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

export function ObservatoryRoom() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [slug, setSlug] = useState<string | null>(null);
    const [commandOpen, setCommandOpen] = useState(false);
    const [instructions, setInstructions] = useState('');
    const [command, setCommand] = useState<{
        active: boolean;
        label: string;
        draft: string;
        error: boolean;
        chips: ToolChip[];
    } | null>(null);

    const list = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        retry: false
    });
    const detail = useQuery({
        queryKey: [...keys.observatory, slug],
        queryFn: () => api.observatoryProject(slug as string) as Promise<Detail>,
        enabled: Boolean(slug),
        retry: false
    });

    const projects = list.data?.projects || [];
    const project = detail.data;

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
                { project: slug, instructions: text },
                {
                    onTool: (event) => {
                        setCommand((prev) => {
                            if (!prev) return prev;
                            const chips = [...prev.chips];
                            if (event.phase === 'start') chips.push({ name: event.name, phase: 'start' });
                            else {
                                for (let i = chips.length - 1; i >= 0; i--) {
                                    if (chips[i].name === event.name && chips[i].phase === 'start') {
                                        chips[i] = { name: event.name, phase: 'result', isError: event.isError };
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
                    {slug && <button type="button" className="btn" onClick={() => setSlug(null)}>← Back</button>}
                    <button type="button" className="btn primary" onClick={() => { setInstructions(''); setCommandOpen(true); }}>✨ Command</button>
                    <button type="button" className="btn" onClick={() => queryClient.invalidateQueries({ queryKey: keys.observatory })}>Refresh</button>
                </div>
            </header>
            <div className="pane-body">
                <div className="obs-view">
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
                                <span
                                    key={`${chip.name}-${index}`}
                                    className={`tool-chip ${chip.phase === 'start' ? 'running' : chip.isError ? 'failed' : 'done'}`}
                                >
                                    {chip.phase === 'start'
                                        ? <><span className="tool-spinner" /> {chip.name}…</>
                                        : `${chip.isError ? '⚠' : '✓'} ${chip.name}`}
                                </span>
                            ))}
                        </div>
                        <div className={`obs-command-reply${command.error ? ' error' : ''}`}>
                            <Markdown source={command.draft} onNotify={toast} />
                        </div>
                    </div>
                )}

                {!slug && list.isPending && <div className="empty">Loading…</div>}
                {!slug && list.data && projects.length === 0 && (
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">🔭</div>
                        <div className="empty-title">No projects yet</div>
                        <div className="hint" style={{ maxWidth: 460, margin: '0 auto 18px' }}>
                            Observatory projects are persistent workspaces for long-running simulations.
                            Ask for one in chat, or command Goobster directly.
                        </div>
                        <button type="button" className="btn primary big" onClick={() => { setInstructions(''); setCommandOpen(true); }}>
                            ✨ Give Goobster instructions
                        </button>
                    </div>
                )}
                {!slug && projects.length > 0 && (
                    <>
                        <div className="section-title">Projects</div>
                        <div className="list-card">
                            {projects.map((item) => (
                                <div
                                    key={item.slug}
                                    className="list-row task-row obs-project-card"
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setSlug(item.slug)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            setSlug(item.slug);
                                        }
                                    }}
                                >
                                    <div className="row-body">
                                        <strong>🔭 {item.name}</strong>
                                        <span className="badge">{item.slug}</span>
                                        {item.shared ? <span className="badge">🔗 shared</span> : null}
                                        <div className="row-meta">
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
                            or ✨ command Goobster to continue it. Background jobs notify you in Discord when they finish.
                        </div>
                    </>
                )}

                {slug && detail.isPending && <div className="empty">Loading…</div>}
                {slug && detail.isError && (
                    <div className="empty">Could not load this project. {(detail.error as Error).message}</div>
                )}
                {slug && project && (
                    <DetailView
                        detail={project}
                        onDeleted={() => { setSlug(null); queryClient.invalidateQueries({ queryKey: keys.observatory }); }}
                        onChanged={() => queryClient.invalidateQueries({ queryKey: keys.observatory })}
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

function DetailView({
    detail, onDeleted, onChanged
}: {
    detail: Detail;
    onDeleted: () => void;
    onChanged: () => void;
}) {
    const [tab, setTab] = useState<'overview' | 'apps' | 'automations'>('overview');
    const toast = useToast();
    const confirm = useConfirm();
    const p = detail.project;
    const completed = detail.jobs.filter((j) => j.status === 'COMPLETED').length;
    const failed = detail.jobs.filter((j) => j.status === 'FAILED' || j.status === 'TIMED_OUT').length;
    const quotaPct = Math.min(100, Math.round(((p.sizeMb || 0) / Math.max(p.quotaMb || 1, 1)) * 100));
    const videos = detail.files.filter((f) => f.isVideo && f.url);
    const images = detail.files.filter((f) => f.isImage && f.url).slice(0, 12);

    return (
        <>
            <div className="obs-chips">
                {p.runningJobs ? <span className="obs-chip">🟢 Running <b>{p.runningJobs}</b></span> : null}
                <span className="obs-chip">Jobs <b>{p.totalJobs}</b></span>
                <span className="obs-chip">✅ Completed <b>{completed}</b></span>
                {failed > 0 ? <span className="obs-chip">❌ Failed <b>{failed}</b></span> : null}
                <span className="obs-chip">Workspace <b>{p.sizeMb} / {p.quotaMb} MB</b></span>
                <span className="obs-chip">Updated <b>{whenLabel(p.updatedAt)}</b></span>
            </div>
            <div className="obs-quota" role="img" aria-label={`Disk quota ${quotaPct}% used`}>
                <i style={{ width: `${quotaPct}%` }} />
            </div>
            <div className="obs-actions">
                <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                        try {
                            const result = await api.observatoryRender(p.slug) as { frames: number; fps: number };
                            toast(`Rendered ${result.frames} frame(s) at ${result.fps} fps.`);
                            onChanged();
                        } catch (error) {
                            toast((error as Error).message, true);
                        }
                    }}
                >🎬 Render video</button>
                <a className="btn" target="_blank" rel="noopener" href={`/api/app/observatory/projects/${encodeURIComponent(p.slug)}/dashboard`}>📸 Snapshot page</a>
                <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                        try {
                            const status = await api.observatoryShareStatus(p.slug) as { shared?: boolean; url?: string };
                            if (!status.shared) {
                                const created = await api.observatoryCreateShare(p.slug) as { url: string };
                                const url = new URL(created.url, window.location.origin).href;
                                try { await navigator.clipboard.writeText(url); } catch { /* denied */ }
                                toast(`Share link copied: ${url}`);
                            } else if (await confirm('Revoke the share link? The URL stops working immediately.')) {
                                await api.observatoryRevokeShare(p.slug);
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
                >{p.shared ? '🔗 Shared' : '🔗 Share'}</button>
                <button
                    type="button"
                    className="btn danger"
                    onClick={async () => {
                        if (!await confirm(`Delete "${p.name}" and its whole workspace? Files and job history are gone for good.`)) return;
                        try {
                            await api.observatoryDeleteProject(p.slug);
                            toast('Project deleted.');
                            onDeleted();
                        } catch (error) {
                            toast((error as Error).message, true);
                        }
                    }}
                >✕ Delete</button>
            </div>

            <div className="segment obs-tabs" role="tablist">
                <button type="button" className={`segment-btn${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
                <button type="button" className={`segment-btn${tab === 'apps' ? ' active' : ''}`} onClick={() => setTab('apps')}>Apps</button>
                <button type="button" className={`segment-btn${tab === 'automations' ? ' active' : ''}`} onClick={() => setTab('automations')}>Automations</button>
            </div>

            {tab === 'apps' && <AppsTab slug={p.slug} />}
            {tab === 'automations' && <AutomationsTab slug={p.slug} />}

            {tab === 'overview' && videos.length > 0 && (
                <>
                    <div className="section-title">Latest render</div>
                    <video className="obs-video" src={videos[0].url} controls preload="metadata" />
                    <div className="row-meta">{videos[0].path}</div>
                </>
            )}

            {tab === 'overview' && <div className="section-title">Jobs</div>}
            {tab === 'overview' && (detail.jobs.length === 0
                ? <div className="empty">No jobs yet — ✨ command Goobster to start one.</div>
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
                                    }}>▶ Resume</button>
                                )}
                            </div>
                        ))}
                    </div>
                ))}

            {tab === 'overview' && images.length > 0 && (
                <>
                    <div className="section-title">Gallery</div>
                    <div className="obs-gallery">
                        {images.map((image) => (
                            <a key={image.path} href={image.url} target="_blank" rel="noopener" title={image.path}>
                                <img src={image.url} alt={image.path} loading="lazy" />
                                <span>{image.path}</span>
                            </a>
                        ))}
                    </div>
                </>
            )}

            {tab === 'overview' && (
                <>
                    <div className="section-title">Files ({detail.totalFiles || detail.files.length}, {p.sizeMb}/{p.quotaMb} MB)</div>
                    {detail.files.length === 0
                        ? <div className="empty">The workspace is empty.</div>
                        : (
                            <div className="list-card">
                                {detail.files.map((file) => (
                                    <div key={file.path} className="list-row task-row">
                                        <div className="row-body">
                                            {file.url
                                                ? <a href={file.url} target="_blank" rel="noopener">{file.path}</a>
                                                : <span>{file.path}</span>}
                                            <div className="row-meta">{sizeLabel(file.size)} · {whenLabel(file.modifiedAt)}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                </>
            )}
        </>
    );
}

type AppAsset = {
    slug: string;
    name: string;
    kind: string;
    currentVersion?: number | null;
    language?: string | null;
};
type AppVersion = { version: number; isHead?: boolean; note?: string | null; language?: string };
type AppDetail = {
    slug: string;
    name: string;
    language: string;
    source: string;
    version: number;
    currentVersion: number | null;
    grants?: { observatoryRead?: string[] };
};

function renderApplet(
    container: HTMLElement,
    opts: {
        source: string;
        language?: string;
        notify?: (message: string, isError?: boolean) => void;
        requestGrant?: (message: string) => Promise<boolean>;
        grants?: { observatoryRead?: string[] };
    }
): void {
    const fn = renderAppletJs as (
        el: HTMLElement,
        options: {
            source: string;
            language?: string;
            notify?: (message: string, isError?: boolean) => void;
            requestGrant?: (message: string) => Promise<boolean>;
            grants?: { observatoryRead?: string[] };
        }
    ) => void;
    fn(container, opts);
}

function AppsTab({ slug }: { slug: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<string | null>(null);
    const [viewVersion, setViewVersion] = useState<number | ''>('');
    const stageRef = useRef<HTMLDivElement>(null);

    const list = useQuery({
        queryKey: keys.projectAssets(slug),
        queryFn: () => api.projectAssets(slug, 'app') as Promise<{ assets: AppAsset[] }>,
        retry: false
    });
    const apps = list.data?.assets || [];
    const currentSlug = selected || apps[0]?.slug || null;

    const versions = useQuery({
        queryKey: [...keys.projectAssets(slug), currentSlug, 'versions'],
        queryFn: () => api.projectAssetVersions(slug, currentSlug as string) as Promise<{ versions: AppVersion[] }>,
        enabled: Boolean(currentSlug),
        retry: false
    });
    const detail = useQuery({
        queryKey: [...keys.projectAssets(slug), currentSlug, viewVersion || 'head'],
        queryFn: () => api.projectAsset(slug, currentSlug as string, viewVersion === '' ? undefined : viewVersion) as Promise<AppDetail>,
        enabled: Boolean(currentSlug),
        retry: false
    });

    useEffect(() => {
        setViewVersion('');
    }, [currentSlug]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage || !detail.data?.source) return;
        stage.replaceChildren();
        renderApplet(stage, {
            source: detail.data.source,
            language: detail.data.language,
            notify: toast,
            requestGrant: confirm,
            grants: detail.data.grants
        });
        return () => { stage.replaceChildren(); };
    }, [detail.data, toast, confirm]);

    async function rollback() {
        if (!currentSlug || viewVersion === '') return;
        if (!await confirm(`Roll "${detail.data?.name || currentSlug}" back to v${viewVersion}? The head pointer moves; history stays.`)) return;
        try {
            await api.rollbackProjectAsset(slug, currentSlug, viewVersion);
            toast(`Rolled back to v${viewVersion}.`);
            setViewVersion('');
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug) });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    if (list.isPending) return <div className="empty">Loading apps…</div>;
    if (list.isError) return <div className="empty">{(list.error as Error).message}</div>;
    if (apps.length === 0) {
        return (
            <div className="empty-state" style={{ marginTop: '4vh' }}>
                <div className="empty-title">No apps yet</div>
                <div className="hint">Save an html or svg fence from the Study with “Save to project…”, or ask Goobster to save_app.</div>
            </div>
        );
    }

    const headVersion = detail.data?.currentVersion;
    const showingOld = viewVersion !== '' && viewVersion !== headVersion;

    return (
        <div className="obs-apps">
            <div className="obs-apps-toolbar">
                <label className="field" style={{ margin: 0 }}>
                    <span className="hint">App</span>
                    <select
                        className="select"
                        value={currentSlug || ''}
                        onChange={(e) => setSelected(e.target.value)}
                    >
                        {apps.map((app) => (
                            <option key={app.slug} value={app.slug}>
                                {app.name} ({app.slug}{app.currentVersion ? ` · v${app.currentVersion}` : ''})
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field" style={{ margin: 0 }}>
                    <span className="hint">Version</span>
                    <select
                        className="select"
                        value={viewVersion === '' ? '' : String(viewVersion)}
                        onChange={(e) => setViewVersion(e.target.value === '' ? '' : Number(e.target.value))}
                    >
                        <option value="">Head{headVersion ? ` (v${headVersion})` : ''}</option>
                        {(versions.data?.versions || []).map((row) => (
                            <option key={row.version} value={row.version}>
                                v{row.version}{row.isHead ? ' · head' : ''}{row.note ? ` — ${row.note}` : ''}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    className="btn"
                    disabled={!showingOld}
                    onClick={() => void rollback()}
                >↩️ Rollback</button>
            </div>
            {detail.isPending && <div className="empty">Loading source…</div>}
            {detail.isError && <div className="empty">{(detail.error as Error).message}</div>}
            <div ref={stageRef} className="obs-app-stage" />
        </div>
    );
}

type Trigger = {
    id: number;
    name: string;
    kind: 'cron' | 'event';
    schedule?: string | null;
    nextRun?: string | null;
    eventTopic?: string | null;
    action: 'run_script' | 'render' | 'fetch_data' | 'agent_prompt';
    actionAssetId?: number | null;
    actionParams?: Record<string, unknown>;
    isEnabled: boolean;
    lastRun?: string | null;
    lastOutcome?: string | null;
};

type ScriptAsset = { id: number; slug: string; name: string; currentVersion?: number | null };

type TriggerDraft = {
    name: string;
    kind: 'cron' | 'event';
    schedule: string;
    eventTopic: 'job_completed' | 'job_failed' | 'job_settled';
    action: Trigger['action'];
    actionAssetId: string;
    background: boolean;
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
    action: 'run_script',
    actionAssetId: '',
    background: true,
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
        action: trigger.action,
        actionAssetId: trigger.actionAssetId != null ? String(trigger.actionAssetId) : '',
        background: params.background !== false && params.background !== 0,
        fps: params.fps != null ? String(params.fps) : '',
        url: typeof params.url === 'string' ? params.url : '',
        filename: typeof params.filename === 'string' ? params.filename : '',
        prompt: typeof params.prompt === 'string' ? params.prompt : '',
        allowSelfChain: params.allowSelfChain === true || params.allowSelfChain === 1,
        maxChainDepth: params.maxChainDepth != null ? String(params.maxChainDepth) : '',
        isEnabled: trigger.isEnabled
    };
}

function payloadFromDraft(draft: TriggerDraft): Record<string, unknown> {
    const actionParams: Record<string, unknown> = {};
    if (draft.action === 'run_script') actionParams.background = draft.background;
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
        action: draft.action,
        actionAssetId: draft.action === 'run_script' && draft.actionAssetId
            ? Number(draft.actionAssetId)
            : null,
        actionParams,
        isEnabled: draft.isEnabled
    };
}

function AutomationsTab({ slug }: { slug: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; id?: number; draft: TriggerDraft } | null>(null);

    const list = useQuery({
        queryKey: keys.projectTriggers(slug),
        queryFn: () => api.projectTriggers(slug) as Promise<{ triggers: Trigger[] }>,
        retry: false
    });
    const scripts = useQuery({
        queryKey: [...keys.projectAssets(slug), 'script'],
        queryFn: () => api.projectAssets(slug, 'script') as Promise<{ assets: ScriptAsset[] }>,
        retry: false
    });

    const triggers = list.data?.triggers || [];
    const scriptAssets = scripts.data?.assets || [];

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: keys.projectTriggers(slug) });
    }

    async function toggleEnabled(trigger: Trigger) {
        try {
            await api.updateProjectTrigger(slug, trigger.id, { isEnabled: !trigger.isEnabled });
            toast(trigger.isEnabled ? `Paused "${trigger.name}".` : `Armed "${trigger.name}".`);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function remove(trigger: Trigger) {
        if (!await confirm(`Delete trigger "${trigger.name}"?`)) return;
        try {
            await api.deleteProjectTrigger(slug, trigger.id);
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
                await api.createProjectTrigger(slug, body);
                toast(`Created trigger "${editor.draft.name}".`);
            } else if (editor.id != null) {
                await api.updateProjectTrigger(slug, editor.id, body);
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
                                            trigger.action,
                                            trigger.lastRun ? `last ${whenLabel(trigger.lastRun)}` : 'never ran',
                                            trigger.lastOutcome || null
                                        ].filter(Boolean).join(' · ')}
                                    </div>
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
                                <option value="agent_prompt">Agent prompt</option>
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
