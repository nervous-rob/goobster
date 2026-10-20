import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { renderApplet as renderAppletJs } from '../../renderers/codeblocks.js';
import { readAppletAccess, resetAppletAccess } from '../../renderers/appletProjectAccess.js';
import { whenLabel } from './format';

type AppAsset = {
    slug: string;
    name: string;
    kind: string;
    currentVersion?: number | null;
    language?: string | null;
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
            onActivity?: (entry: AppActivity) => void;
            onProjectChanged?: (what: ProjectChange) => void;
        }
    ) => void;
    fn(container, opts);
}

export function AppsTab({ slug, ownerId }: { slug: string; ownerId?: string | null }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<string | null>(null);
    const [viewVersion, setViewVersion] = useState<number | ''>('');
    const stageRef = useRef<HTMLDivElement>(null);
    const [activity, setActivity] = useState<AppActivity[]>([]);
    const [accessTick, setAccessTick] = useState(0);

    const list = useQuery({
        queryKey: keys.projectAssets(slug, ownerId),
        queryFn: () => api.projectAssets(slug, 'app', ownerId) as Promise<{ assets: AppAsset[] }>,
        retry: false
    });
    const apps = [...(list.data?.assets || [])].sort((a, b) => a.name.localeCompare(b.name));
    const currentSlug = selected || apps[0]?.slug || null;
    const currentApp = apps.find((app) => app.slug === currentSlug) || apps[0] || null;

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

    const access = useMemo(
        () => (detail.data?.source ? readAppletAccess({ project: slug, owner: ownerId || null, source: detail.data.source }) : null),
        // accessTick re-reads after the app asks for (or is refused) a capability.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [detail.data?.source, slug, ownerId, accessTick]
    );

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage || !detail.data?.source) return;
        stage.replaceChildren();
        renderApplet(stage, {
            source: detail.data.source,
            language: detail.data.language,
            notify: toast,
            requestGrant: confirm,
            grants: detail.data.grants,
            ownProject: slug,
            ownOwner: ownerId,
            onActivity: (entry) => {
                setActivity((prev) => [entry, ...prev].slice(0, 50));
                setAccessTick((n) => n + 1);
            },
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
    }, [detail.data, toast, confirm, slug, ownerId, queryClient]);

    function resetAccess() {
        if (!detail.data?.source) return;
        resetAppletAccess({ project: slug, owner: ownerId || null, source: detail.data.source });
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

    if (list.isPending) return <div className="empty">Loading apps…</div>;
    if (list.isError) return <div className="empty">{(list.error as Error).message}</div>;
    if (apps.length === 0) {
        return (
            <div className="empty-state" style={{ marginTop: '4vh' }}>
                <div className="empty-title">No apps yet</div>
                <div className="hint">
                    Save an html or svg fence from the Study with “Save to project…”,
                    or ask Goobster to save_app.
                </div>
            </div>
        );
    }

    const headVersion = detail.data?.currentVersion ?? currentApp?.currentVersion ?? null;
    const showingVersion = viewVersion === '' ? headVersion : viewVersion;
    const showingOld = viewVersion !== '' && viewVersion !== headVersion;
    const history = versions.data?.versions || [];

    return (
        <div className="obs-apps">
            {apps.length > 1 && (
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
                            <strong>{app.name}</strong>
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
                        <span className={`obs-version-badge${showingOld ? ' is-old' : ''}`}>
                            {showingVersion != null ? `v${showingVersion}` : '—'}
                            {showingOld ? ' · older snapshot' : ' · current'}
                        </span>
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

                <aside className="obs-apps-history">
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
                </aside>
            </div>
        </div>
    );
}
