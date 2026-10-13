import { useAttachmentDrop } from '../hooks/useAttachmentDrop';
import { accountFetch } from '../lib/browserAccount';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { diffLines } from 'diff';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { CodeEditor, languageFromPath } from './CodeEditor';

type AssetRow = {
    slug: string;
    name: string;
    kind: 'app' | 'script' | 'note' | string;
    language?: string | null;
    currentVersion?: number | null;
};
type AssetDetail = {
    revision?: number;
    slug: string;
    name: string;
    kind: string;
    language: string;
    source: string;
    version: number;
    currentVersion: number | null;
    origin?: string;
    note?: string | null;
};
type AssetVersion = {
    version: number;
    isHead?: boolean;
    note?: string | null;
    origin?: string | null;
    createdAt?: string;
    language?: string;
};
type WsEntry = {
    path: string;
    name: string;
    kind: 'file' | 'directory';
    size: number;
    isImage?: boolean;
    isVideo?: boolean;
    modifiedAt?: string;
};

type HistoryCommit = {
    hash: string;
    short: string;
    when: string;
    author: { role: string; name: string };
    message: string;
    files: string[];
    fileCount: number;
};
type HistoryPayload = {
    enabled: boolean;
    reason?: string | null;
    paused?: boolean;
    sizeMb?: number;
    budgetMb?: number;
    commits: HistoryCommit[];
};
type HistoryDiff = { label: string; empty: boolean; content: string; truncated?: boolean };
type RepoStatus = {
    branch: string | null;
    upstream?: string | null;
    ahead: number;
    behind: number;
    head: string | null;
    changed: number;
    changes: { code: string; path: string }[];
    operation?: 'merge' | 'rebase' | null;
    conflicts?: string[];
    sizeMb?: number;
    error?: string;
};
type BranchEntry = {
    name: string; current: boolean; local: boolean; remote: boolean; protected: boolean; isBase: boolean;
    head: string; subject: string; aheadOfBase: number | null; behindBase: number | null;
};
type BranchesPayload = { base: string; current: string | null; branches: BranchEntry[]; remoteError: string | null };
type ComparePayload = {
    base: string; head: string; ahead: number | null; behind: number | null; identical: boolean; sharedHistory: boolean;
    commits: { short: string; author: string; message: string }[];
    files: { path: string; additions: number; deletions: number; binary: boolean }[];
    fileCount: number; additions: number; deletions: number; patch: string; truncated: boolean;
};
type CiFailure = { name: string; conclusion: string; url: string | null; summary: string };
type CiPayload = { ref: string; state: 'success' | 'failure' | 'pending' | 'none'; total: number; passed: number; failing: CiFailure[]; pending: string[]; notOnGitHub?: boolean };
type PullEntry = { number: number; title: string; url: string; state: string; draft: boolean; author: string | null; head: string; base: string; ci: CiPayload | null };
type IntegrationResult = { kind: string; base: string; result: string; conflicts: string[]; to?: string };
type RepoEntry = {
    name: string;
    repo: string;
    path: string;
    url: string;
    clonedBranch: string;
    lastPushAt?: string | null;
    status?: RepoStatus;
};
type ReposPayload = { enabled: boolean; reason?: string | null; maxRepos: number; repos: RepoEntry[] };

type Selection =
    | { root: 'assets'; slug: string }
    | { root: 'workspace'; path: string; kind: 'file' | 'directory' };

function whenLabel(utcText?: string): string {
    if (!utcText) return '';
    const date = new Date(utcText.includes('T') ? utcText : `${utcText.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return utcText;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sizeLabel(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

function assetIcon(kind: string): string {
    if (kind === 'app') return '✨';
    if (kind === 'script') return '▶';
    return '✎';
}

export function ProjectExplorer({ slug, ownerId, onChanged }: { slug: string; ownerId?: string | null; onChanged: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<Selection | null>(null);
    const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({ '': true });
    const [editNote, setEditNote] = useState('');
    const [draft, setDraft] = useState<string | null>(null);
    const [draftRevision, setDraftRevision] = useState<number | undefined>();
    const [editConflict, setEditConflict] = useState(false);
    const [diffAgainst, setDiffAgainst] = useState<number | ''>('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadingRef = useRef(false);
    const [uploading, setUploading] = useState(false);
    const [wsRefresh, setWsRefresh] = useState(0);
    const uploadDir = selected?.root === 'workspace'
        ? selected.kind === 'directory' ? selected.path : selected.path.split('/').slice(0, -1).join('/')
        : '';
    const drop = useAttachmentDrop({
        label: `Drop files into workspace/${uploadDir}`,
        disabled: uploading,
        resetKey: `${ownerId}:${slug}:${uploadDir}`,
        onDrop: async payload => {
            const shortcuts = payload.links.map((link, index) => new File(
                [`[InternetShortcut]\r\nURL=${link.url}\r\n`],
                `${link.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}-${index + 1}.url`, { type: 'text/plain' }
            ));
            await uploadFiles([...payload.files, ...shortcuts]);
        }
    });

    const assets = useQuery({
        queryKey: keys.projectAssets(slug, ownerId),
        queryFn: () => api.projectAssets(slug, undefined, ownerId) as Promise<{ assets: AssetRow[] }>,
        retry: false
    });
    const assetList = assets.data?.assets || [];

    const currentAsset = selected?.root === 'assets' ? selected.slug : null;
    const versions = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), currentAsset, 'versions'],
        queryFn: () => api.projectAssetVersions(slug, currentAsset as string, ownerId) as Promise<{ versions: AssetVersion[] }>,
        enabled: Boolean(currentAsset),
        retry: false
    });
    const assetDetail = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), currentAsset, 'head'],
        queryFn: () => api.projectAsset(slug, currentAsset as string, undefined, ownerId) as Promise<AssetDetail>,
        enabled: Boolean(currentAsset),
        retry: false
    });
    const diffDetail = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), currentAsset, diffAgainst || 'none'],
        queryFn: () => api.projectAsset(slug, currentAsset as string, diffAgainst as number, ownerId) as Promise<AssetDetail>,
        enabled: Boolean(currentAsset && diffAgainst !== ''),
        retry: false
    });

    useEffect(() => {
        setDraft(null);
        setEditNote('');
        setDiffAgainst('');
        setEditConflict(false);
        setDraftRevision(undefined);
    }, [currentAsset]);

    const openDirs = useMemo(() => {
        const dirs = new Set<string>(['']);
        for (const [dir, open] of Object.entries(wsOpen)) {
            if (open) dirs.add(dir);
        }
        return [...dirs];
    }, [wsOpen]);
    const workspaceQueries = useQueries({
        queries: openDirs.map((dirPath) => ({
            queryKey: keys.projectFiles(slug, dirPath, ownerId),
            queryFn: () => api.projectFiles(slug, dirPath, ownerId) as Promise<{ entries?: WsEntry[] }>,
            retry: false
        }))
    });
    const wsChildren = useMemo(() => {
        const map: Record<string, WsEntry[]> = {};
        openDirs.forEach((dirPath, index) => {
            map[dirPath] = workspaceQueries[index]?.data?.entries || [];
        });
        return map;
    }, [openDirs, workspaceQueries]);

    async function loadWorkspace(dirPath: string) {
        await queryClient.invalidateQueries({ queryKey: keys.projectFiles(slug, dirPath, ownerId) });
        await queryClient.fetchQuery({
            queryKey: keys.projectFiles(slug, dirPath, ownerId),
            queryFn: () => api.projectFiles(slug, dirPath, ownerId) as Promise<{ entries?: WsEntry[] }>
        });
    }

    function toggleWorkspace(dirPath: string) {
        setWsOpen((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));
    }

    /** After a snapshot restore: every open directory and the open file reload. */
    async function refreshWorkspace() {
        await queryClient.invalidateQueries({ queryKey: ['project-files', slug] });
        setDraft(null);
        setWsRefresh((n) => n + 1);
        onChanged();
    }

    async function saveAsset() {
        const detail = assetDetail.data;
        if (!detail || draft == null) return;
        try {
            const saved = await api.saveProjectAsset(slug, {
                expectedRevision: draftRevision,
                slug: detail.slug,
                name: detail.name,
                kind: detail.kind,
                language: detail.language,
                source: draft,
                note: editNote || undefined,
                origin: 'portal'
            }, ownerId) as { version: number; deduped?: boolean };
            toast(saved.deduped ? 'Already the head — nothing to save.' : `Saved v${saved.version}.`);
            setDraft(null);
            setEditConflict(false);
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug, ownerId) });
            onChanged();
        } catch (error) {
            if ((error as { status?: number }).status === 409) setEditConflict(true);
            toast((error as Error).message, true);
        }
    }

    async function rollback(version: number) {
        if (!currentAsset) return;
        if (!await confirm(`Roll "${assetDetail.data?.name || currentAsset}" back to v${version}? History stays.`)) return;
        try {
            await api.rollbackProjectAsset(slug, currentAsset, version, ownerId, assetDetail.data?.revision);
            toast(`Rolled back to v${version}.`);
            setDiffAgainst('');
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug, ownerId) });
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function runAsset(background: boolean) {
        if (!currentAsset) return;
        try {
            const result = await api.runProjectAsset(slug, currentAsset, background, ownerId) as {
                mode?: string; jobId?: number; result?: { stdout?: string; stderr?: string; ok?: boolean };
            };
            if (result.mode === 'background') {
                toast(`Job #${result.jobId} started.`);
            } else {
                const out = (result.result?.stdout || result.result?.stderr || '').trim();
                toast(out ? out.slice(0, 240) : (result.result?.ok ? 'Finished.' : 'Run finished with errors.'));
            }
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function saveWorkspaceFile() {
        if (!selected || selected.root !== 'workspace' || selected.kind !== 'file' || draft == null) return;
        try {
            await api.putProjectContent(slug, selected.path, draft, ownerId);
            toast('Saved.');
            setDraft(null);
            await loadWorkspace(selected.path.includes('/') ? selected.path.replace(/\/[^/]+$/, '') : '');
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function deleteWorkspaceFile() {
        if (!selected || selected.root !== 'workspace') return;
        if (!await confirm(`Delete ${selected.path || 'this path'}?`)) return;
        try {
            await api.deleteProjectContent(slug, selected.path, ownerId);
            toast('Deleted.');
            const parent = selected.path.includes('/') ? selected.path.replace(/\/[^/]+$/, '') : '';
            setSelected(null);
            await loadWorkspace(parent);
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function uploadFiles(files: FileList | File[] | null) {
        if (!files?.length || uploadingRef.current) return;
        const batch = Array.from(files); // FileList becomes empty when the input is reset.
        uploadingRef.current = true;
        setUploading(true);
        const dir = uploadDir;
        let count = 0;
        const errors: string[] = [];
        try {
            const listing = await api.projectFiles(slug, dir, ownerId) as { entries?: WsEntry[] };
            const existing = new Set((listing.entries || []).map(entry => entry.name));
            for (const file of batch) {
                try {
                    const dest = dir ? `${dir}/${file.name}` : file.name;
                    // Both picker and drop ask before replacing a workspace file.
                    if (existing.has(file.name)
                        && !await confirm(`Replace workspace/${dest}?`)) continue;
                    await api.putProjectContent(slug, dest, file, ownerId);
                    count++;
                    existing.add(file.name);
                } catch (error) { errors.push(`${file.name}: ${(error as Error).message}`); }
            }
            if (count) {
                await loadWorkspace(dir);
                onChanged();
            }
            toast([`Uploaded ${count} file(s) to workspace/${dir}.`, ...errors].join(' '), errors.length > 0);
        } catch (error) { toast((error as Error).message, true); }
        finally { uploadingRef.current = false; setUploading(false); }
    }

    const headSource = draft ?? assetDetail.data?.source ?? '';
    const diffs = useMemo(() => {
        if (!diffDetail.data || !assetDetail.data) return null;
        return diffLines(diffDetail.data.source, headSource);
    }, [diffDetail.data, assetDetail.data, headSource]);

    function renderWorkspaceNodes(dirPath: string, depth: number) {
        const entries = wsChildren[dirPath] || [];
        return entries.map((entry) => {
            const open = Boolean(wsOpen[entry.path]);
            const active = selected?.root === 'workspace' && selected.path === entry.path;
            return (
                <div key={entry.path}>
                    <button
                        type="button"
                        className={`obs-tree-item${active ? ' active' : ''}`}
                        style={{ paddingLeft: 12 + depth * 14 }}
                        onClick={() => {
                            setSelected({ root: 'workspace', path: entry.path, kind: entry.kind });
                            if (entry.kind === 'directory') void toggleWorkspace(entry.path);
                        }}
                    >
                        <span>{entry.kind === 'directory' ? (open ? '📂' : '📁') : (entry.isImage ? '🖼' : entry.isVideo ? '🎬' : '📄')}</span>
                        <span>{entry.name}</span>
                        {entry.kind === 'file' && <span className="hint">{sizeLabel(entry.size)}</span>}
                    </button>
                    {entry.kind === 'directory' && open && renderWorkspaceNodes(entry.path, depth + 1)}
                </div>
            );
        });
    }

    return (
        <div className="obs-explorer attachment-drop-zone" {...drop.dropProps}>
            {drop.indicator}
            <aside className="obs-tree">
                <div className="obs-tree-root">assets/</div>
                {assets.isPending && <div className="hint">Loading assets…</div>}
                {assetList.map((asset) => (
                    <button
                        key={asset.slug}
                        type="button"
                        className={`obs-tree-item${selected?.root === 'assets' && selected.slug === asset.slug ? ' active' : ''}`}
                        style={{ paddingLeft: 26 }}
                        onClick={() => setSelected({ root: 'assets', slug: asset.slug })}
                    >
                        <span>{assetIcon(asset.kind)}</span>
                        <span>{asset.slug}{asset.currentVersion ? ` · v${asset.currentVersion}` : ''}</span>
                        {asset.kind === 'script' && (
                            <span
                                className="obs-tree-run"
                                title="Run"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setSelected({ root: 'assets', slug: asset.slug });
                                    void api.runProjectAsset(slug, asset.slug, true, ownerId)
                                        .then(() => { toast(`Started ${asset.slug}.`); onChanged(); })
                                        .catch((error) => toast((error as Error).message, true));
                                }}
                            >▶</span>
                        )}
                    </button>
                ))}
                <div className="obs-tree-root">workspace/</div>
                {renderWorkspaceNodes('', 1)}
                <RepoPanel slug={slug} ownerId={ownerId} onChanged={() => void refreshWorkspace()} />
                <div className="obs-tree-actions">
                    <p className="hint">Drop files here to upload into workspace/{uploadDir}. Web links become .url shortcut files.</p>
                    <button type="button" className="btn" disabled={uploading || drop.busy} onClick={() => fileInputRef.current?.click()}>⬆ Upload</button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ''; }}
                    />
                </div>
            </aside>
            <section className="obs-explorer-main">
                {!selected && <div className="empty">Pick a file from assets/ or workspace/.</div>}

                {selected?.root === 'assets' && assetDetail.isPending && <div className="empty">Loading…</div>}
                {selected?.root === 'assets' && assetDetail.isError && (
                    <div className="empty">{(assetDetail.error as Error).message}</div>
                )}
                {selected?.root === 'assets' && assetDetail.data && (
                    <>
                        <div className="obs-explorer-crumb">
                            <strong>assets/{assetDetail.data.slug}</strong>
                            <span className="hint">v{assetDetail.data.version} · {assetDetail.data.language} · {assetDetail.data.origin}</span>
                            {assetDetail.data.kind === 'script' && (
                                <>
                                    <button type="button" className="btn" onClick={() => void runAsset(false)}>▶ Run</button>
                                    <button type="button" className="btn" onClick={() => void runAsset(true)}>▶ Background</button>
                                </>
                            )}
                            <button type="button" className="btn primary" disabled={draft == null} onClick={() => void saveAsset()}>Save</button>
                        </div>
                        {editConflict && <div role="alert" className="panel">
                            <p>Your draft is kept. Reload the current version to compare it below, then merge your changes before saving.</p>
                            <button className="btn" onClick={async () => {
                                const fresh = await assetDetail.refetch();
                                setDraftRevision(fresh.data?.revision);
                            }}>Reload current version for comparison</button>
                            <pre>{assetDetail.data.source}</pre>
                        </div>}
                        <div className="obs-explorer-split">
                            <div className="obs-explorer-editor">
                                <CodeEditor
                                    value={headSource}
                                    language={assetDetail.data.language}
                                    onChange={value => {
                                        if (draft === null) setDraftRevision(assetDetail.data?.revision);
                                        setDraft(value);
                                    }}
                                />
                                <label className="field" style={{ marginTop: 8 }}>
                                    <span className="hint">Version note</span>
                                    <input className="input" value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="what changed" />
                                </label>
                            </div>
                            <aside className="obs-version-rail">
                                <div className="section-title">History</div>
                                {(versions.data?.versions || []).map((row) => (
                                    <button
                                        key={row.version}
                                        type="button"
                                        className={`obs-version-item${diffAgainst === row.version ? ' active' : ''}`}
                                        onClick={() => setDiffAgainst(row.version === assetDetail.data?.version ? '' : row.version)}
                                    >
                                        <strong>v{row.version}</strong>{row.isHead ? ' · head' : ''}
                                        <div className="row-meta">
                                            {[row.origin, row.note, whenLabel(row.createdAt)].filter(Boolean).join(' · ')}
                                        </div>
                                    </button>
                                ))}
                                {diffAgainst !== '' && (
                                    <button type="button" className="btn" onClick={() => void rollback(diffAgainst as number)}>
                                        ↩️ Rollback to v{diffAgainst}
                                    </button>
                                )}
                            </aside>
                        </div>
                        {diffs && (
                            <pre className="obs-diff">
                                {diffs.map((part, index) => (
                                    <span
                                        key={index}
                                        className={part.added ? 'add' : part.removed ? 'del' : ''}
                                    >{part.value}</span>
                                ))}
                            </pre>
                        )}
                    </>
                )}

                {selected?.root === 'workspace' && selected.kind === 'directory' && (
                    <>
                        <div className="obs-explorer-crumb">
                            <strong>workspace/{selected.path || ''}</strong>
                            <span className="hint">Directory</span>
                            <button type="button" className="btn" disabled={uploading || drop.busy} onClick={() => fileInputRef.current?.click()}>⬆ Upload here</button>
                        </div>
                        <div className="obs-explorer-split" style={{ minHeight: 0 }}>
                            <div style={{ flex: 1, minWidth: 0 }} />
                            <WorkspaceHistoryRail
                                slug={slug}
                                ownerId={ownerId}
                                filePath={selected.path || null}
                                onRestored={refreshWorkspace}
                            />
                        </div>
                    </>
                )}
                {selected?.root === 'workspace' && selected.kind === 'file' && (
                    <WorkspaceFileView
                        slug={slug}
                        ownerId={ownerId}
                        filePath={selected.path}
                        entry={Object.values(wsChildren).flat().find((row) => row.path === selected.path)}
                        draft={draft}
                        onDraft={setDraft}
                        onSave={() => void saveWorkspaceFile()}
                        onDelete={() => void deleteWorkspaceFile()}
                        refreshToken={wsRefresh}
                        onRestored={refreshWorkspace}
                    />
                )}
            </section>
        </div>
    );
}

function WorkspaceFileView({
    slug, ownerId, filePath, entry, draft, onDraft, onSave, onDelete, refreshToken = 0, onRestored
}: {
    slug: string;
    ownerId?: string | null;
    filePath: string;
    entry?: WsEntry;
    draft: string | null;
    onDraft: (value: string) => void;
    onSave: () => void;
    onDelete: () => void;
    refreshToken?: number;
    onRestored: () => void | Promise<void>;
}) {
    const toast = useToast();
    const [text, setText] = useState<string | null>(null);
    const [kind, setKind] = useState<'text' | 'image' | 'video' | 'binary'>('text');
    const url = api.projectContentUrl(slug, filePath, false, ownerId);
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const image = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
    const video = ['mp4', 'webm'].includes(ext);
    const textExt = ['txt', 'md', 'json', 'csv', 'tsv', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
        'html', 'htm', 'css', 'svg', 'yml', 'yaml', 'xml', 'log', 'sh', 'toml', 'ini', 'cfg', 'sql'];

    useEffect(() => {
        setText(null);
        if (image) { setKind('image'); return; }
        if (video) { setKind('video'); return; }
        if (!textExt.includes(ext)) { setKind('binary'); return; }
        setKind('text');
        accountFetch(url, { credentials: 'same-origin' })
            .then((res) => {
                if (!res.ok) throw new Error('Could not read that file.');
                return res.text();
            })
            .then((body) => { setText(body); onDraft(body); })
            .catch((error) => toast((error as Error).message, true));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug, ownerId, filePath, refreshToken]);

    return (
        <>
            <div className="obs-explorer-crumb">
                <strong>workspace/{filePath}</strong>
                {entry && (
                    <span className="hint">
                        {sizeLabel(entry.size)}{entry.modifiedAt ? ` · ${whenLabel(entry.modifiedAt)}` : ''}
                    </span>
                )}
                <a className="btn" href={api.projectContentUrl(slug, filePath, true, ownerId)}>⬇ Download</a>
                {kind === 'text' && <button type="button" className="btn primary" disabled={draft == null} onClick={onSave}>Save</button>}
                <button type="button" className="btn danger" onClick={onDelete}>Delete</button>
            </div>
            <div className="obs-explorer-split">
                <div style={{ flex: 1, minWidth: 0 }}>
                    {kind === 'image' && <img className="obs-file-preview" src={url} alt={filePath} />}
                    {kind === 'video' && <video className="obs-video" src={url} controls preload="metadata" />}
                    {kind === 'binary' && (
                        <div className="empty">
                            Binary file. <a href={api.projectContentUrl(slug, filePath, true, ownerId)}>Download</a>
                        </div>
                    )}
                    {kind === 'text' && text != null && (
                        <div className="obs-explorer-editor" style={{ minHeight: 360 }}>
                            <CodeEditor
                                value={draft ?? text}
                                language={languageFromPath(filePath)}
                                onChange={onDraft}
                            />
                        </div>
                    )}
                </div>
                <WorkspaceHistoryRail slug={slug} ownerId={ownerId} filePath={filePath} onRestored={onRestored} />
            </div>
        </>
    );
}

function describeIntegration(done: IntegrationResult): string {
    if (done.result === 'conflicted') return `${done.kind} stopped on conflicts in ${done.conflicts.join(', ')}. Fix the files, then Continue (or Abort).`;
    if (done.result === 'up-to-date') return `Already contains ${done.base}.`;
    return `${done.result[0].toUpperCase()}${done.result.slice(1)} ${done.base} (now ${done.to}).`;
}

/**
 * Project repositories (ADR 0015): GitHub clones under workspace/repos/<name>,
 * pulled, committed and pushed by the server with the viewer's own connected
 * GitHub account. Files are edited through the workspace tree like any other.
 */
function RepoPanel({ slug, ownerId, onChanged }: { slug: string; ownerId?: string | null; onChanged: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [cloneRepo, setCloneRepo] = useState('');
    const [cloneBranch, setCloneBranch] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const repos = useQuery({
        queryKey: keys.projectRepos(slug, ownerId),
        queryFn: () => api.projectRepos(slug, ownerId) as Promise<ReposPayload>,
        retry: false
    });
    const data = repos.data;

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: keys.projectRepos(slug, ownerId) });
        onChanged();
    }

    async function run(label: string, fn: () => Promise<unknown>, done: (result: unknown) => string) {
        setBusy(label);
        try {
            const result = await fn();
            toast(done(result));
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
        }
    }

    async function clone() {
        const repo = cloneRepo.trim();
        if (!repo) return;
        await run('clone', () => api.cloneProjectRepo(slug, { repo, branch: cloneBranch.trim() || null }, ownerId),
            (result) => `Cloned ${(result as RepoEntry).repo} into ${(result as RepoEntry).path}.`);
        setCloneRepo('');
        setCloneBranch('');
    }

    async function commit(entry: RepoEntry) {
        const message = window.prompt(`Commit message for ${entry.repo}:`);
        if (!message?.trim()) return;
        await run(`${entry.name}:commit`, () => api.projectRepoAction(slug, entry.name, 'commit', { message }, ownerId),
            (result) => (result as { committed: boolean; short?: string }).committed
                ? `Committed ${(result as { short?: string }).short}.`
                : 'Nothing to commit.');
    }

    async function push(entry: RepoEntry) {
        await run(`${entry.name}:push`, () => api.projectRepoAction(slug, entry.name, 'push', {}, ownerId),
            (result) => {
                const pushed = result as { branch: string; compareUrl?: string | null };
                return pushed.compareUrl ? `Pushed ${pushed.branch}. Open a pull request: ${pushed.compareUrl}` : `Pushed ${pushed.branch}.`;
            });
    }

    async function pull(entry: RepoEntry) {
        await run(`${entry.name}:pull`, () => api.projectRepoAction(slug, entry.name, 'pull', {}, ownerId),
            (result) => (result as { updated: boolean; to?: string }).updated
                ? `Pulled to ${(result as { to?: string }).to}.`
                : 'Already up to date.');
    }

    async function branch(entry: RepoEntry) {
        const name = window.prompt(`Switch ${entry.repo} to branch (created if new):`, entry.status?.branch || '');
        if (!name?.trim()) return;
        await run(`${entry.name}:branch`, () => api.projectRepoAction(slug, entry.name, 'branch', { branch: name.trim() }, ownerId),
            (result) => `Now on ${(result as { branch: string }).branch}.`);
    }

    async function integrate(entry: RepoEntry, action: 'merge' | 'rebase') {
        const base = window.prompt(`${action === 'merge' ? 'Merge' : 'Rebase onto'} which branch of ${entry.repo}?`, entry.clonedBranch);
        if (!base?.trim()) return;
        await run(`${entry.name}:${action}`, () => api.projectRepoAction(slug, entry.name, action, { branch: base.trim() }, ownerId),
            (result) => describeIntegration(result as IntegrationResult));
    }

    async function finish(entry: RepoEntry, action: 'continue' | 'abort') {
        await run(`${entry.name}:${action}`, () => api.projectRepoAction(slug, entry.name, action, {}, ownerId),
            (result) => action === 'abort' ? 'Aborted; the branch is back as it was.' : describeIntegration(result as IntegrationResult));
    }

    async function reset(entry: RepoEntry) {
        if (!await confirm(`Discard local commits and changes in ${entry.path}, back to origin? A workspace snapshot is taken first.`)) return;
        await run(`${entry.name}:reset`, () => api.projectRepoAction(slug, entry.name, 'reset', {}, ownerId),
            (result) => `Reset to origin/${(result as { branch: string }).branch}.`);
    }

    async function remove(entry: RepoEntry) {
        if (!await confirm(`Remove the clone of ${entry.repo} (${entry.path})? Its files stay in workspace history.`)) return;
        await run(`${entry.name}:remove`, () => api.removeProjectRepo(slug, entry.name, ownerId), () => 'Removed.');
    }

    return (
        <>
            <div className="obs-tree-root">repos/</div>
            {repos.isError && <div className="hint" style={{ padding: '0 12px' }}>Could not load repositories.</div>}
            {data && !data.enabled && (
                <div className="hint" style={{ padding: '0 12px' }}>
                    {data.reason === 'GIT_MISSING' ? 'Repositories are off: git is not installed on this server.'
                        : data.reason === 'GITHUB_OFF' ? 'Repositories need the GitHub feature, which is off on this server.'
                            : 'Repositories are turned off on this server.'}
                </div>
            )}
            {data?.enabled && data.repos.map((entry) => {
                const st = entry.status;
                const sync = !st || st.error ? 'status unavailable'
                    : `${st.branch || 'detached'} · ${st.ahead}↑ ${st.behind}↓ · ${st.changed} changed`
                    + (st.operation ? ` · ${st.operation} stopped on ${st.conflicts?.length || 0} conflict(s)` : '');
                return (
                    <div key={entry.name} className="obs-tree-item" style={{ paddingLeft: 26, display: 'block', cursor: 'default' }}>
                        <div><span>📦</span> <a href={entry.url} target="_blank" rel="noreferrer">{entry.repo}</a></div>
                        <div className="hint">{entry.path} · {sync}</div>
                        <div className="obs-explorer-crumb" style={{ gap: 4, marginTop: 4 }}>
                            <button type="button" className="btn" disabled={busy != null} onClick={() => void pull(entry)}>Pull</button>
                            <button type="button" className="btn" disabled={busy != null} onClick={() => void commit(entry)}>Commit</button>
                            <button type="button" className="btn" disabled={busy != null} onClick={() => void push(entry)}>Push</button>
                            <button type="button" className="btn" disabled={busy != null} onClick={() => void branch(entry)}>Branch</button>
                            {st?.operation ? (
                                <>
                                    <button type="button" className="btn" disabled={busy != null} onClick={() => void finish(entry, 'continue')}>Continue</button>
                                    <button type="button" className="btn" disabled={busy != null} onClick={() => void finish(entry, 'abort')}>Abort</button>
                                </>
                            ) : (
                                <>
                                    <button type="button" className="btn" disabled={busy != null} onClick={() => void integrate(entry, 'merge')}>Merge</button>
                                    <button type="button" className="btn" disabled={busy != null} onClick={() => void integrate(entry, 'rebase')}>Rebase</button>
                                </>
                            )}
                            <button type="button" className="btn" disabled={busy != null} onClick={() => void reset(entry)}>Reset</button>
                            <button type="button" className="btn" onClick={() => setExpanded(expanded === entry.name ? null : entry.name)}>
                                {expanded === entry.name ? 'Hide details' : 'Branches · PRs · CI'}
                            </button>
                            <button type="button" className="btn danger" disabled={busy != null} onClick={() => void remove(entry)}>Remove</button>
                        </div>
                        {expanded === entry.name && (
                            <RepoDetail slug={slug} ownerId={ownerId} entry={entry} busy={busy} run={run} onChanged={onChanged} />
                        )}
                    </div>
                );
            })}
            {data?.enabled && data.repos.length < data.maxRepos && (
                <div className="obs-tree-actions">
                    <label className="field">
                        <span className="hint">Clone a GitHub repository (with your connected account)</span>
                        <input className="input" value={cloneRepo} onChange={(e) => setCloneRepo(e.target.value)} placeholder="owner/name" />
                    </label>
                    <label className="field">
                        <span className="hint">Branch (optional)</span>
                        <input className="input" value={cloneBranch} onChange={(e) => setCloneBranch(e.target.value)} placeholder="default branch" />
                    </label>
                    <button type="button" className="btn" disabled={busy != null || !cloneRepo.trim()} onClick={() => void clone()}>
                        {busy === 'clone' ? 'Cloning…' : '⬇ Clone'}
                    </button>
                </div>
            )}
        </>
    );
}

function ciBadge(ci: Pick<CiPayload, 'state' | 'failing' | 'pending' | 'passed' | 'total'> | null | undefined) {
    if (!ci || ci.state === 'none') return <span className="hint">no CI</span>;
    if (ci.state === 'success') return <span title={`${ci.passed} checks passed`}>✅ passing</span>;
    if (ci.state === 'pending') return <span title={ci.pending.join(', ')}>🟡 running</span>;
    return <span title={ci.failing.map((f) => f.name).join(', ')}>❌ {ci.failing.length} failing</span>;
}

/**
 * One clone's repository management: pick the active branch, compare any two
 * branches (the pull-request view), open pull requests and read CI. Remote
 * data comes from GitHub with the viewer's own account and degrades quietly.
 */
function RepoDetail({ slug, ownerId, entry, busy, run, onChanged }: {
    slug: string;
    ownerId?: string | null;
    entry: RepoEntry;
    busy: string | null;
    run: (label: string, fn: () => Promise<unknown>, done: (result: unknown) => string) => Promise<void>;
    onChanged: () => void;
}) {
    const [tab, setTab] = useState<'branches' | 'compare' | 'pulls' | 'ci'>('branches');
    const [base, setBase] = useState(entry.clonedBranch);
    const [head, setHead] = useState('');
    const [prTitle, setPrTitle] = useState('');
    const [prBody, setPrBody] = useState('');
    const [prDraft, setPrDraft] = useState(false);
    const queryClient = useQueryClient();
    const key = (part: string, extra = '') => keys.projectRepoDetail(slug, entry.name, part, ownerId, extra);

    const branches = useQuery({
        queryKey: key('branches'),
        queryFn: () => api.projectRepoBranches(slug, entry.name, ownerId) as Promise<BranchesPayload>,
        retry: false
    });
    const current = branches.data?.current || entry.status?.branch || '';
    const headName = head || current;
    const compare = useQuery({
        queryKey: key('compare', `${base}...${headName}`),
        queryFn: () => api.projectRepoCompare(slug, entry.name, base, headName, ownerId) as Promise<ComparePayload>,
        enabled: tab === 'compare' && Boolean(headName && base),
        retry: false
    });
    const ci = useQuery({
        queryKey: key('ci', current),
        queryFn: () => api.projectRepoCi(slug, entry.name, current, ownerId) as Promise<CiPayload>,
        enabled: tab === 'ci' && Boolean(current),
        retry: false
    });
    const pulls = useQuery({
        queryKey: key('pulls'),
        queryFn: () => api.projectRepoPulls(slug, entry.name, ownerId) as Promise<{ pulls: PullEntry[] }>,
        enabled: tab === 'pulls',
        retry: false
    });

    async function reload() {
        await queryClient.invalidateQueries({ queryKey: ['project-repos', slug] });
        onChanged();
    }

    async function activate(branch: BranchEntry) {
        await run(`${entry.name}:branch`, () => api.projectRepoAction(slug, entry.name, 'branch', { branch: branch.name }, ownerId),
            () => `Now on ${branch.name}.`);
        await reload();
    }

    async function openPr(push: boolean) {
        await run(`${entry.name}:pr`, () => api.createProjectRepoPull(slug, entry.name,
            { title: prTitle.trim(), body: prBody, head: headName, base, draft: prDraft, push }, ownerId),
        (result) => `Opened pull request #${(result as { number: number }).number}: ${(result as { url: string }).url}`);
        setPrTitle('');
        setPrBody('');
        await reload();
    }

    const errorText = (error: unknown) => (error as Error)?.message || 'Unavailable.';
    const cmp = compare.data;
    const names = branches.data?.branches.map((b) => b.name) || [];

    return (
        <div style={{ marginTop: 6 }}>
            <div className="obs-explorer-crumb" style={{ gap: 4 }}>
                {(['branches', 'compare', 'pulls', 'ci'] as const).map((id) => (
                    <button key={id} type="button" className={`btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
                        {id === 'branches' ? 'Branches' : id === 'compare' ? 'Compare' : id === 'pulls' ? 'Pull requests' : 'CI'}
                    </button>
                ))}
            </div>

            {tab === 'branches' && (
                <div style={{ marginTop: 6 }}>
                    {branches.isLoading && <div className="hint">Loading branches…</div>}
                    {branches.isError && <div className="hint">{errorText(branches.error)}</div>}
                    {branches.data?.remoteError && <div className="hint">GitHub branches unavailable: {branches.data.remoteError}</div>}
                    {branches.data?.branches.map((b) => (
                        <div key={b.name} className="obs-tree-item" style={{ display: 'flex', gap: 8, cursor: 'default', alignItems: 'center' }}>
                            <span>{b.current ? '▶' : ' '}</span>
                            <strong style={{ flex: 1 }}>{b.name}</strong>
                            <span className="hint">
                                {b.isBase ? 'base · ' : ''}{b.local ? '' : 'remote only · '}{b.local && !b.remote ? 'local only · ' : ''}{b.protected ? 'protected · ' : ''}
                                {b.aheadOfBase != null ? `${b.aheadOfBase}↑ ${b.behindBase}↓ vs ${branches.data?.base}` : b.head}
                            </span>
                            {!b.current && (
                                <button type="button" className="btn" disabled={busy != null} onClick={() => void activate(b)}>Switch</button>
                            )}
                            {!b.current && !b.isBase && (
                                <button type="button" className="btn" onClick={() => { setHead(b.name); setTab('compare'); }}>Compare</button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {tab === 'compare' && (
                <div style={{ marginTop: 6 }}>
                    <div className="obs-explorer-crumb" style={{ gap: 6, alignItems: 'center' }}>
                        <select className="input" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base branch">
                            {[...new Set([base, ...names])].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <span>←</span>
                        <select className="input" value={headName} onChange={(e) => setHead(e.target.value)} aria-label="Head branch">
                            {[...new Set([headName, ...names])].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </div>
                    {compare.isLoading && <div className="hint">Comparing…</div>}
                    {compare.isError && <div className="hint">{errorText(compare.error)}</div>}
                    {cmp && (cmp.identical ? <div className="hint">{cmp.head} and {cmp.base} are identical.</div> : (
                        <>
                            <div className="hint">
                                {cmp.ahead ?? '?'} ahead · {cmp.behind ?? '?'} behind · {cmp.fileCount} file(s) +{cmp.additions} −{cmp.deletions}
                                {cmp.sharedHistory ? '' : ' · no shared history visible (direct diff)'}
                            </div>
                            {cmp.commits.map((c) => <div key={c.short} className="hint">{c.short} {c.author}: {c.message}</div>)}
                            {cmp.files.map((f) => <div key={f.path} className="hint">{f.binary ? 'binary' : `+${f.additions} −${f.deletions}`} {f.path}</div>)}
                            {cmp.patch && <DiffView text={cmp.patch} />}
                            {cmp.truncated && <div className="hint">Diff truncated: open the files for the rest.</div>}
                            {headName !== base && (
                                <div className="obs-tree-actions">
                                    <input className="input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)}
                                        placeholder={`Pull request title (${headName} → ${base})`} />
                                    <textarea className="input" value={prBody} onChange={(e) => setPrBody(e.target.value)} placeholder="Description (optional)" rows={3} />
                                    <label className="hint"><input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} /> Draft</label>
                                    <div className="obs-explorer-crumb" style={{ gap: 4 }}>
                                        <button type="button" className="btn" disabled={busy != null || !prTitle.trim()} onClick={() => void openPr(false)}>Open pull request</button>
                                        {headName === current && (
                                            <button type="button" className="btn" disabled={busy != null || !prTitle.trim()} onClick={() => void openPr(true)}>Push and open</button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </>
                    ))}
                </div>
            )}

            {tab === 'pulls' && (
                <div style={{ marginTop: 6 }}>
                    {pulls.isLoading && <div className="hint">Loading pull requests…</div>}
                    {pulls.isError && <div className="hint">{errorText(pulls.error)}</div>}
                    {pulls.data?.pulls.length === 0 && <div className="hint">No open pull requests.</div>}
                    {pulls.data?.pulls.map((pr) => (
                        <div key={pr.number} className="obs-tree-item" style={{ display: 'block', cursor: 'default' }}>
                            <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} {pr.title}</a> {ciBadge(pr.ci)}
                            <div className="hint">{pr.head} → {pr.base}{pr.draft ? ' · draft' : ''}{pr.author ? ` · ${pr.author}` : ''}</div>
                        </div>
                    ))}
                </div>
            )}

            {tab === 'ci' && (
                <div style={{ marginTop: 6 }}>
                    <div className="hint">CI for {current || 'the current branch'}</div>
                    {ci.isLoading && <div className="hint">Loading checks…</div>}
                    {ci.isError && <div className="hint">{errorText(ci.error)}</div>}
                    {ci.data && (
                        <>
                            <div>{ciBadge(ci.data)}{ci.data.notOnGitHub ? <span className="hint"> · this branch is not on GitHub yet: push it</span> : null}</div>
                            {ci.data.failing.map((f) => (
                                <div key={f.name} className="obs-tree-item" style={{ display: 'block', cursor: 'default' }}>
                                    ❌ {f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a> : f.name} <span className="hint">({f.conclusion})</span>
                                    {f.summary && <div className="hint">{f.summary}</div>}
                                </div>
                            ))}
                            {ci.data.pending.length > 0 && <div className="hint">Still running: {ci.data.pending.join(', ')}</div>}
                        </>
                    )}
                    <button type="button" className="btn" onClick={() => void ci.refetch()}>Refresh</button>
                </div>
            )}
        </div>
    );
}

/** A unified diff from the server, coloured by line. */
function DiffView({ text }: { text: string }) {
    return (
        <pre className="obs-diff">
            {text.split('\n').map((line, index) => (
                <span
                    key={index}
                    className={line.startsWith('+') && !line.startsWith('+++') ? 'add'
                        : line.startsWith('-') && !line.startsWith('---') ? 'del' : ''}
                >{line}{'\n'}</span>
            ))}
        </pre>
    );
}

/**
 * Workspace snapshots (ADR 0014): the git history the host keeps beside the
 * workspace. With a filePath, only snapshots touching that path; without,
 * the whole workspace. Picking a snapshot shows what changed since it and
 * offers a restore (the current state is snapshotted first).
 */
function WorkspaceHistoryRail({ slug, ownerId, filePath, onRestored }: {
    slug: string;
    ownerId?: string | null;
    filePath: string | null;
    onRestored: () => void | Promise<void>;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [rev, setRev] = useState<string | null>(null);
    const history = useQuery({
        queryKey: keys.projectHistory(slug, filePath || '', ownerId),
        queryFn: () => api.projectHistory(slug, filePath || undefined, ownerId) as Promise<HistoryPayload>,
        retry: false
    });
    const diff = useQuery({
        queryKey: [...keys.projectHistory(slug, filePath || '', ownerId), 'diff', rev || ''],
        queryFn: () => api.projectHistoryDiff(slug, { rev, to: 'workspace', path: filePath || null }, ownerId) as Promise<HistoryDiff>,
        enabled: Boolean(rev),
        retry: false
    });

    useEffect(() => { setRev(null); }, [slug, ownerId, filePath]);

    const target = filePath ? `workspace/${filePath}` : 'the whole workspace';

    async function restore() {
        if (!rev) return;
        if (!await confirm(`Restore ${target} from snapshot ${rev.slice(0, 7)}? The current state is snapshotted first, so this can be undone.`)) return;
        try {
            const result = await api.restoreProjectHistory(slug, rev, filePath, ownerId) as { changed?: boolean; short?: string };
            toast(result.changed ? `Restored from ${result.short}.` : 'Nothing differed - the workspace is unchanged.');
            setRev(null);
            await queryClient.invalidateQueries({ queryKey: ['project-history', slug] });
            await onRestored();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function snapshot() {
        try {
            const result = await api.commitProjectHistory(slug, 'snapshot from the portal', ownerId) as {
                committed: boolean; short?: string; reason?: string;
            };
            toast(result.committed ? `Snapshot ${result.short} taken.`
                : result.reason === 'NO_CHANGES' ? 'Nothing changed since the latest snapshot.'
                    : result.reason === 'PAUSED' ? 'Snapshots are paused: the workspace is over its history budget.'
                        : 'Workspace history is off on this server.');
            await queryClient.invalidateQueries({ queryKey: ['project-history', slug] });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const data = history.data;
    return (
        <aside className="obs-version-rail">
            <div className="section-title">Snapshots</div>
            {history.isError && <div className="hint">Could not load snapshots.</div>}
            {data && !data.enabled && (
                <div className="hint">
                    {data.reason === 'GIT_MISSING'
                        ? 'Workspace history is off: git is not installed on this server.'
                        : 'Workspace history is turned off on this server.'}
                </div>
            )}
            {data?.enabled && (
                <>
                    <div className="hint">
                        {data.sizeMb ?? 0} / {data.budgetMb ?? 0} MB of history{data.paused ? ' · paused (over budget)' : ''}
                    </div>
                    {!filePath && (
                        <button type="button" className="btn" onClick={() => void snapshot()}>📸 Snapshot now</button>
                    )}
                    {data.commits.length === 0 && (
                        <div className="hint">No snapshots yet. One is taken after every run, save, upload, fetch and restore.</div>
                    )}
                    {data.commits.map((row) => (
                        <button
                            key={row.hash}
                            type="button"
                            className={`obs-version-item${rev === row.hash ? ' active' : ''}`}
                            onClick={() => setRev(rev === row.hash ? null : row.hash)}
                        >
                            <strong>{row.short}</strong>
                            <div className="row-meta">
                                {[row.author.name, row.message, whenLabel(row.when)].filter(Boolean).join(' · ')}
                            </div>
                        </button>
                    ))}
                    {rev && (
                        <>
                            <button type="button" className="btn" onClick={() => void restore()}>
                                ↩️ Restore {filePath ? 'from' : 'workspace from'} {rev.slice(0, 7)}
                            </button>
                            {filePath && (
                                <a className="btn" href={api.projectHistoryContentUrl(slug, rev, filePath, true, ownerId)}>
                                    ⬇ Download at {rev.slice(0, 7)}
                                </a>
                            )}
                            {diff.data && (diff.data.empty
                                ? <div className="hint">Same as the current {filePath ? 'file' : 'workspace'}.</div>
                                : <DiffView text={diff.data.content} />)}
                            {diff.data?.truncated && <div className="hint">Diff shortened; the chat tool pages the rest.</div>}
                        </>
                    )}
                </>
            )}
        </aside>
    );
}
