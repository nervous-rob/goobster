import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { renderApplet as renderAppletJs } from '../../renderers/codeblocks.js';
import { readAppletAccess, resetAppletAccess } from '../../renderers/appletProjectAccess.js';
import { whenLabel } from './format';
import { Modal } from '../../components/Modal';
import { usePublishViewContext } from '../../hooks/useViewContext';

type AppAsset = {
    slug: string;
    name: string;
    kind: string;
    currentVersion?: number | null;
    language?: string | null;
    pinned?: boolean;
    pinnedAt?: string | null;
};
type AppVersion = {
    version: number;
    isHead?: boolean;
    note?: string | null;
    language?: string;
    origin?: string | null;
    createdAt?: string;
};
type AppDetail = {
    revision?: number;
    slug: string;
    name: string;
    language: string;
    source: string;
    version: number;
    currentVersion: number | null;
    grants?: { observatoryRead?: string[] };
    pinned?: boolean;
};

/** One request an app made through the bridge (newest first in the log). */
type AppActivity = { at: number; type: string; target: string; ok: boolean; code: string | null };
type ProjectChange = 'files' | 'assets' | 'runs';

const CAPABILITY_LABEL: Record<string, string> = {
    write: 'write files & notes',
    delete: 'delete files & notes',
    run: 'run programs'
};

function renderApplet(
    container: HTMLElement,
    opts: {
        source: string;
        language?: string;
        notify?: (message: string, isError?: boolean) => void;
        requestGrant?: (message: string) => Promise<boolean>;
        grants?: { observatoryRead?: string[] };
        ownProject?: string | null;
        ownOwner?: string | null;
        ownAsset?: string | null;
        onActivity?: (entry: AppActivity) => void;
        onProjectChanged?: (what: ProjectChange) => void;
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
            ownProject?: string | null;
            ownOwner?: string | null;
            ownAsset?: string | null;
            onActivity?: (entry: AppActivity) => void;
            onProjectChanged?: (what: ProjectChange) => void;
        }
    ) => void;
    fn(container, opts);
}

/**
 * Render one project app into `stageRef` with the project bridge wired:
 * its writes refresh the views that show what it changed. Re-renders only
 * when the app's source (or language / grants) changes, so a rename or a
 * pin does not restart a running app.
 */
export function useAppStage(stageRef: RefObject<HTMLDivElement | null>, {
    slug, ownerId, detail, onActivity
}: {
    slug: string;
    ownerId?: string | null;
    detail?: AppDetail;
    onActivity?: (entry: AppActivity) => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const activityRef = useRef(onActivity);
    activityRef.current = onActivity;
    const asset = detail?.slug;
    const source = detail?.source;
    const language = detail?.language;
    const grantsKey = JSON.stringify(detail?.grants || null);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage || !source) return;
        stage.replaceChildren();
        renderApplet(stage, {
            source,
            language,
            notify: toast,
            requestGrant: confirm,
            grants: JSON.parse(grantsKey) || undefined,
            ownProject: slug,
            ownOwner: ownerId,
            ownAsset: asset,
            onActivity: (entry) => activityRef.current?.(entry),
            onProjectChanged: (what) => {
                if (what === 'files') void queryClient.invalidateQueries({ queryKey: ['project-files', slug] });
                if (what === 'assets') void queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug, ownerId) });
                if (what === 'runs') {
                    void queryClient.invalidateQueries({ queryKey: keys.observatory });
                    void queryClient.invalidateQueries({ queryKey: keys.projectNow(slug, ownerId) });
                }
            }
        });
        return () => { stage.replaceChildren(); };
    }, [stageRef, asset, source, language, grantsKey, toast, confirm, slug, ownerId, queryClient]);
}

/** The Apps view's address: `?app=<slug>` selects one, `&full=1` shows it alone. */
type AppsSearch = { app?: string; full?: string | number | boolean };

export function AppsTab({ slug, ownerId }: { slug: string; ownerId?: string | null }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const search = useSearch({ strict: false }) as AppsSearch;
    const selected = typeof search.app === 'string' && search.app ? search.app : null;
    const full = search.full === true || search.full === 1 || search.full === '1' || search.full === 'true';
    const setSearch = (patch: Partial<AppsSearch>) => void navigate({
        search: ((prev: Record<string, unknown>) => {
            const next: Record<string, unknown> = { ...prev, ...patch };
            for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
            return next;
        }) as never,
        replace: true
    } as never);
    const setSelected = (app: string) => setSearch({ app });
    const [viewVersion, setViewVersion] = useState<number | ''>('');
    const stageRef = useRef<HTMLDivElement>(null);
    const [activity, setActivity] = useState<AppActivity[]>([]);
    const [accessTick, setAccessTick] = useState(0);
    const [creating, setCreating] = useState(false);

    const list = useQuery({
        queryKey: keys.projectAssets(slug, ownerId),
        queryFn: () => api.projectAssets(slug, 'app', ownerId) as Promise<{ assets: AppAsset[] }>,
        retry: false
    });
    const apps = [...(list.data?.assets || [])].sort((a, b) => a.name.localeCompare(b.name));
    const currentApp = apps.find((app) => app.slug === selected) || apps[0] || null;
    const currentSlug = currentApp?.slug || null;

    const versions = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), currentSlug, 'versions'],
        queryFn: () => api.projectAssetVersions(slug, currentSlug as string, ownerId) as Promise<{ versions: AppVersion[] }>,
        enabled: Boolean(currentSlug),
        retry: false
    });
    const detail = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), currentSlug, viewVersion || 'head'],
        queryFn: () => api.projectAsset(slug, currentSlug as string, viewVersion === '' ? undefined : viewVersion, ownerId) as Promise<AppDetail>,
        enabled: Boolean(currentSlug),
        retry: false
    });

    useEffect(() => {
        setViewVersion('');
        setActivity([]);
    }, [currentSlug]);

    const [access, setAccess] = useState<Awaited<ReturnType<typeof readAppletAccess>> | null>(null);
    useEffect(() => {
        let active = true;
        setAccess(null);
        if (detail.data) {
            void readAppletAccess({ project: slug, owner: ownerId || null, asset: detail.data.slug, source: detail.data.source })
                .then(value => { if (active) setAccess(value); });
        }
        return () => { active = false; };
    }, [detail.data?.source, detail.data?.slug, slug, ownerId, accessTick]);

    usePublishViewContext('app', detail.data ? {
        id: `app:${detail.data.slug}:${detail.data.version}`,
        kind: 'app',
        label: detail.data.name,
        text: `Open app: ${detail.data.name} (assets/${detail.data.slug}, v${detail.data.version})`
    } : null);

    useAppStage(stageRef, {
        slug,
        ownerId,
        detail: detail.data,
        onActivity: (entry) => {
            setActivity((prev) => [entry, ...prev].slice(0, 50));
            setAccessTick((n) => n + 1);
        }
    });

    async function togglePin() {
        if (!currentApp) return;
        const pinned = !currentApp.pinned;
        try {
            await api.updateProjectAsset(slug, currentApp.slug, { pinned }, ownerId);
            toast(pinned ? `Pinned "${currentApp.name}" to the Overview.` : `Unpinned "${currentApp.name}".`);
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug, ownerId) });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function resetAccess() {
        if (!detail.data?.source) return;
        await resetAppletAccess({ project: slug, owner: ownerId || null, asset: detail.data.slug, source: detail.data.source });
        setAccessTick((n) => n + 1);
        toast('Approvals reset: the app asks again next time.');
    }

    async function rollback() {
        if (!currentSlug || viewVersion === '') return;
        if (!await confirm(`Make v${viewVersion} the current version of "${detail.data?.name || currentSlug}"? Older and newer snapshots stay in history.`)) return;
        try {
            await api.rollbackProjectAsset(slug, currentSlug, viewVersion, ownerId, detail.data?.revision);
            toast(`v${viewVersion} is now current.`);
            setViewVersion('');
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug, ownerId) });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const templateDialog = creating && (
        <NewAppFromTemplate
            slug={slug}
            ownerId={ownerId}
            onClose={() => setCreating(false)}
            onCreated={(app) => {
                setCreating(false);
                void queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug, ownerId) });
                setSelected(app);
            }}
        />
    );

    if (list.isPending) return <div className="empty">Loading apps…</div>;
    if (list.isError) return <div className="empty">{(list.error as Error).message}</div>;
    if (apps.length === 0) {
        return (
            <div className="empty-state" style={{ marginTop: '4vh' }}>
                <div className="empty-title">No apps yet</div>
                <div className="hint">
                    Start from a template, save an html or svg fence from the Study with “Save to project…”,
                    or ask Goobster to build one (save_app).
                </div>
                <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
                    + New app from template
                </button>
                {templateDialog}
            </div>
        );
    }

    const headVersion = detail.data?.currentVersion ?? currentApp?.currentVersion ?? null;
    const showingVersion = viewVersion === '' ? headVersion : viewVersion;
    const showingOld = viewVersion !== '' && viewVersion !== headVersion;
    const history = versions.data?.versions || [];

    return (
        <div className={`obs-apps${full ? ' is-full' : ''}`}>
            {templateDialog}
            {!full && (
                <div className="obs-apps-toolbar">
                    <button type="button" className="btn small" onClick={() => setCreating(true)}>+ New app from template</button>
                </div>
            )}
            {apps.length > 1 && !full && (
                <div className="obs-app-picker" role="listbox" aria-label="Apps in this project">
                    {apps.map((app) => (
                        <button
                            key={app.slug}
                            type="button"
                            role="option"
                            aria-selected={app.slug === currentSlug}
                            className={`obs-app-chip${app.slug === currentSlug ? ' active' : ''}`}
                            onClick={() => setSelected(app.slug)}
                        >
                            <strong>{app.pinned ? '📌 ' : ''}{app.name}</strong>
                            <span className="obs-app-chip-meta">
                                {app.currentVersion ? `v${app.currentVersion}` : 'no versions'}
                                {app.language ? ` · ${app.language}` : ''}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            <div className="obs-apps-workspace">
                <div className="obs-apps-stage-wrap">
                    <div className="obs-apps-identity">
                        <div className="obs-apps-identity-text">
                            <h3>{detail.data?.name || currentApp?.name || currentSlug}</h3>
                            <p className="hint">
                                Mini-app in this project
                                {detail.data?.language ? ` · ${detail.data.language}` : ''}
                                {currentApp?.slug ? ` · ${currentApp.slug}` : ''}
                            </p>
                        </div>
                        <div className="obs-apps-identity-actions">
                            <span className={`obs-version-badge${showingOld ? ' is-old' : ''}`}>
                                {showingVersion != null ? `v${showingVersion}` : '—'}
                                {showingOld ? ' · older snapshot' : ' · current'}
                            </span>
                            <button
                                type="button"
                                className={`btn small${currentApp?.pinned ? ' primary' : ''}`}
                                aria-pressed={Boolean(currentApp?.pinned)}
                                title={currentApp?.pinned ? 'Remove from the project Overview' : 'Show this app on the project Overview, for everyone on the project'}
                                onClick={() => void togglePin()}
                            >{currentApp?.pinned ? '📌 Pinned' : '📌 Pin to Overview'}</button>
                            {full ? (
                                <button type="button" className="btn small" onClick={() => setSearch({ app: currentSlug || undefined, full: undefined })}>
                                    ⤡ Exit full page
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="btn small"
                                    title="Show only this app, at an address you can bookmark"
                                    onClick={() => setSearch({ app: currentSlug || undefined, full: 1 })}
                                >⤢ Full page</button>
                            )}
                        </div>
                    </div>

                    {showingOld && (
                        <div className="obs-apps-banner" role="status">
                            <div>
                                <strong>Previewing v{viewVersion}</strong>
                                <span className="hint">
                                    {headVersion != null ? ` Current is v${headVersion}.` : ''}
                                    {' '}This does not change what people get until you make it current.
                                </span>
                            </div>
                            <div className="obs-apps-banner-actions">
                                <button type="button" className="btn" onClick={() => setViewVersion('')}>
                                    Back to current
                                </button>
                                <button type="button" className="btn primary" onClick={() => void rollback()}>
                                    Make this current
                                </button>
                            </div>
                        </div>
                    )}

                    {access && (
                        <div className="obs-app-access" data-testid="app-access">
                            <span className="obs-app-access-label">This app can</span>
                            <span className="obs-app-cap is-allowed" title="Apps always read their own project">read this project</span>
                            {access.declared.map((cap) => {
                                const state = access.allowed.includes(cap) ? 'allowed' : access.denied.includes(cap) ? 'denied' : 'ask';
                                return (
                                    <span key={cap} className={`obs-app-cap is-${state}`}
                                        title={state === 'allowed' ? 'You allowed this for this version'
                                            : state === 'denied' ? 'You refused this for this session' : 'Asks you the first time'}>
                                        {CAPABILITY_LABEL[cap] || cap}
                                        {state === 'allowed' ? ' ✓' : state === 'denied' ? ' ✕' : ' · asks first'}
                                    </span>
                                );
                            })}
                            {(access.allowed.length > 0 || access.denied.length > 0) && (
                                <button type="button" className="btn small" onClick={resetAccess}>Reset approvals</button>
                            )}
                        </div>
                    )}

                    {detail.isPending && <div className="empty">Loading app…</div>}
                    {detail.isError && <div className="empty">{(detail.error as Error).message}</div>}
                    <div ref={stageRef} className="obs-app-stage" />

                    {activity.length > 0 && (
                        <details className="obs-app-activity" data-testid="app-activity">
                            <summary>
                                App activity · {activity.length}
                                {activity.some((entry) => !entry.ok) ? ` · ${activity.filter((entry) => !entry.ok).length} refused or failed` : ''}
                            </summary>
                            <ol>
                                {activity.map((entry, index) => (
                                    <li key={`${entry.at}:${index}`} className={entry.ok ? '' : 'is-failed'}>
                                        <span className="hint">{new Date(entry.at).toLocaleTimeString()}</span>
                                        <code>{entry.type}</code>
                                        <span className="obs-app-activity-target">{entry.target}</span>
                                        <span>{entry.ok ? '✓' : entry.code || 'failed'}</span>
                                    </li>
                                ))}
                            </ol>
                        </details>
                    )}
                </div>

                {!full && <aside className="obs-apps-history">
                    <div className="obs-section-head">
                        <h3>Versions</h3>
                        <span className="hint">{history.length || '—'}</span>
                    </div>
                    <p className="hint obs-apps-history-lead">
                        Each save is a snapshot. Current is what the project runs.
                    </p>
                    {versions.isPending && <div className="hint">Loading history…</div>}
                    <ol className="obs-version-list">
                        {history.map((row) => {
                            const active = (viewVersion === '' && row.isHead) || viewVersion === row.version;
                            return (
                                <li key={row.version}>
                                    <button
                                        type="button"
                                        className={`obs-version-item${active ? ' active' : ''}`}
                                        onClick={() => setViewVersion(row.isHead ? '' : row.version)}
                                    >
                                        <span className="obs-version-item-top">
                                            <strong>v{row.version}</strong>
                                            {row.isHead ? <span className="badge">current</span> : null}
                                        </span>
                                        {row.note ? (
                                            <span className="obs-version-note" title={row.note}>{row.note}</span>
                                        ) : (
                                            <span className="hint">No note</span>
                                        )}
                                        <span className="row-meta">
                                            {[row.origin, whenLabel(row.createdAt)].filter(Boolean).join(' · ')}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                </aside>}
            </div>
        </div>
    );
}

/**
 * The Overview's pinned apps: each one live (same bridge and approvals as
 * the Apps view), with Open and Full page into the Apps view.
 */
export function PinnedApps({ slug, ownerId, onOpenApp }: {
    slug: string;
    ownerId?: string | null;
    onOpenApp: (app: string, full?: boolean) => void;
}) {
    const list = useQuery({
        queryKey: keys.projectAssets(slug, ownerId),
        queryFn: () => api.projectAssets(slug, 'app', ownerId) as Promise<{ assets: AppAsset[] }>,
        retry: false
    });
    const pinned = (list.data?.assets || [])
        .filter((app) => app.kind === 'app' && app.pinned)
        .sort((a, b) => String(a.pinnedAt || '').localeCompare(String(b.pinnedAt || '')));
    if (!pinned.length) return null;
    return (
        <section className="obs-pinned-apps" data-testid="pinned-apps">
            <div className="obs-section-head">
                <h3>Pinned apps</h3>
                <span className="hint">{pinned.length}</span>
            </div>
            <div className="obs-pinned-grid">
                {pinned.map((app) => (
                    <PinnedAppCard key={app.slug} slug={slug} ownerId={ownerId} app={app} onOpenApp={onOpenApp} />
                ))}
            </div>
        </section>
    );
}

function PinnedAppCard({ slug, ownerId, app, onOpenApp }: {
    slug: string;
    ownerId?: string | null;
    app: AppAsset;
    onOpenApp: (app: string, full?: boolean) => void;
}) {
    const stageRef = useRef<HTMLDivElement>(null);
    const detail = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), app.slug, 'head'],
        queryFn: () => api.projectAsset(slug, app.slug, undefined, ownerId) as Promise<AppDetail>,
        retry: false
    });
    useAppStage(stageRef, { slug, ownerId, detail: detail.data });
    return (
        <article className="obs-pinned-app" data-testid={`pinned-app-${app.slug}`}>
            <header>
                <strong title={app.name}>{app.name}</strong>
                <div className="obs-pinned-app-actions">
                    <button type="button" className="btn small" onClick={() => onOpenApp(app.slug)}>Open</button>
                    <button type="button" className="btn small" title="Show only this app" onClick={() => onOpenApp(app.slug, true)}>⤢</button>
                </div>
            </header>
            {detail.isError && <div className="hint">{(detail.error as Error).message}</div>}
            <div ref={stageRef} className="obs-pinned-stage" />
        </article>
    );
}

type AppTemplate = {
    id: string;
    name: string;
    description: string;
    access: string[];
    params: { key: string; label: string; placeholder?: string; required?: boolean; hint?: string }[];
    defaults: Record<string, string>;
};

/** Pick a ready-made app, name it and point it at a file; saved as an ordinary app. */
function NewAppFromTemplate({ slug, ownerId, onClose, onCreated }: {
    slug: string;
    ownerId?: string | null;
    onClose: () => void;
    onCreated: (appSlug: string) => void;
}) {
    const toast = useToast();
    const templates = useQuery({
        queryKey: ['app-templates'],
        queryFn: () => api.appTemplates() as Promise<{ templates: AppTemplate[] }>,
        staleTime: Infinity,
        retry: false
    });
    const [picked, setPicked] = useState<string | null>(null);
    const [title, setTitle] = useState('');
    const [values, setValues] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const list = templates.data?.templates || [];
    const template = list.find((t) => t.id === picked) || null;

    function pick(next: AppTemplate) {
        setPicked(next.id);
        setTitle(next.name);
        setValues({ ...next.defaults });
    }

    async function create() {
        if (!template) return;
        setBusy(true);
        try {
            const saved = await api.createAppFromTemplate(slug, { template: template.id, title, ...values }, ownerId) as { slug: string; name: string };
            toast(`Created "${saved.name}".`);
            onCreated(saved.slug);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal onClose={onClose} labelledBy="new-app-title" wide>
            <h3 id="new-app-title">New app from a template</h3>
            {templates.isPending && <p className="hint">Loading templates…</p>}
            {templates.isError && <p className="hint">{(templates.error as Error).message}</p>}
            <div className="obs-template-grid" role="radiogroup" aria-label="Templates">
                {list.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={picked === t.id}
                        className={`obs-template-card${picked === t.id ? ' active' : ''}`}
                        onClick={() => pick(t)}
                    >
                        <strong>{t.name}</strong>
                        <span className="hint">{t.description}</span>
                        <span className="obs-template-access">
                            {t.access.length ? `Asks to ${t.access.join(' and ')}` : 'Read only'}
                        </span>
                    </button>
                ))}
            </div>
            {template && (
                <form
                    className="obs-template-form"
                    onSubmit={(event) => { event.preventDefault(); void create(); }}
                >
                    <label>
                        <span>Name</span>
                        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
                    </label>
                    {template.params.map((param) => (
                        <label key={param.key}>
                            <span>{param.label}</span>
                            <input
                                className="input"
                                value={values[param.key] ?? ''}
                                placeholder={param.placeholder}
                                required={param.required}
                                onChange={(e) => setValues((prev) => ({ ...prev, [param.key]: e.target.value }))}
                            />
                            {param.hint && <small className="hint">{param.hint}</small>}
                        </label>
                    ))}
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
                            {busy ? 'Creating…' : 'Create app'}
                        </button>
                    </div>
                </form>
            )}
            {!template && (
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose}>Cancel</button>
                </div>
            )}
        </Modal>
    );
}
