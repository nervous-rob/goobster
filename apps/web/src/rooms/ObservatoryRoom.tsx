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
    const [tab, setTab] = useState<'overview' | 'apps'>('overview');
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
            </div>

            {tab === 'apps' && <AppsTab slug={p.slug} />}

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
