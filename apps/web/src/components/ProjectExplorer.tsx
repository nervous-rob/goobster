import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

export function ProjectExplorer({ slug, onChanged }: { slug: string; onChanged: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<Selection | null>(null);
    const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({ '': true });
    const [wsChildren, setWsChildren] = useState<Record<string, WsEntry[]>>({});
    const [editNote, setEditNote] = useState('');
    const [draft, setDraft] = useState<string | null>(null);
    const [diffAgainst, setDiffAgainst] = useState<number | ''>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const assets = useQuery({
        queryKey: keys.projectAssets(slug),
        queryFn: () => api.projectAssets(slug) as Promise<{ assets: AssetRow[] }>,
        retry: false
    });
    const assetList = assets.data?.assets || [];

    const currentAsset = selected?.root === 'assets' ? selected.slug : null;
    const versions = useQuery({
        queryKey: [...keys.projectAssets(slug), currentAsset, 'versions'],
        queryFn: () => api.projectAssetVersions(slug, currentAsset as string) as Promise<{ versions: AssetVersion[] }>,
        enabled: Boolean(currentAsset),
        retry: false
    });
    const assetDetail = useQuery({
        queryKey: [...keys.projectAssets(slug), currentAsset, 'head'],
        queryFn: () => api.projectAsset(slug, currentAsset as string) as Promise<AssetDetail>,
        enabled: Boolean(currentAsset),
        retry: false
    });
    const diffDetail = useQuery({
        queryKey: [...keys.projectAssets(slug), currentAsset, diffAgainst || 'none'],
        queryFn: () => api.projectAsset(slug, currentAsset as string, diffAgainst as number) as Promise<AssetDetail>,
        enabled: Boolean(currentAsset && diffAgainst !== ''),
        retry: false
    });

    useEffect(() => {
        setDraft(null);
        setEditNote('');
        setDiffAgainst('');
    }, [currentAsset, assetDetail.data?.version]);

    useEffect(() => {
        void loadWorkspace('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug]);

    async function loadWorkspace(dirPath: string) {
        const listing = await api.projectFiles(slug, dirPath) as { entries?: WsEntry[] };
        setWsChildren((prev) => ({ ...prev, [dirPath]: listing.entries || [] }));
    }

    async function toggleWorkspace(dirPath: string) {
        setWsOpen((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));
        if (!wsChildren[dirPath]) {
            try { await loadWorkspace(dirPath); } catch (error) {
                toast((error as Error).message, true);
            }
        }
    }

    async function saveAsset() {
        const detail = assetDetail.data;
        if (!detail || draft == null) return;
        try {
            const saved = await api.saveProjectAsset(slug, {
                slug: detail.slug,
                name: detail.name,
                kind: detail.kind,
                language: detail.language,
                source: draft,
                note: editNote || undefined,
                origin: 'portal'
            }) as { version: number; deduped?: boolean };
            toast(saved.deduped ? 'Already the head — nothing to save.' : `Saved v${saved.version}.`);
            setDraft(null);
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug) });
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function rollback(version: number) {
        if (!currentAsset) return;
        if (!await confirm(`Roll "${assetDetail.data?.name || currentAsset}" back to v${version}? History stays.`)) return;
        try {
            await api.rollbackProjectAsset(slug, currentAsset, version);
            toast(`Rolled back to v${version}.`);
            setDiffAgainst('');
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(slug) });
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function runAsset(background: boolean) {
        if (!currentAsset) return;
        try {
            const result = await api.runProjectAsset(slug, currentAsset, background) as {
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
            await api.putProjectContent(slug, selected.path, draft);
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
            await api.deleteProjectContent(slug, selected.path);
            toast('Deleted.');
            const parent = selected.path.includes('/') ? selected.path.replace(/\/[^/]+$/, '') : '';
            setSelected(null);
            await loadWorkspace(parent);
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function uploadFiles(files: FileList | null) {
        if (!files?.length) return;
        const dir = selected?.root === 'workspace' && selected.kind === 'directory'
            ? selected.path
            : '';
        try {
            for (const file of [...files]) {
                const dest = dir ? `${dir}/${file.name}` : file.name;
                await api.putProjectContent(slug, dest, file);
            }
            toast(`Uploaded ${files.length} file(s).`);
            await loadWorkspace(dir);
            onChanged();
        } catch (error) {
            toast((error as Error).message, true);
        }
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
                    </button>
                    {entry.kind === 'directory' && open && renderWorkspaceNodes(entry.path, depth + 1)}
                </div>
            );
        });
    }

    return (
        <div className="obs-explorer">
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
                                    void api.runProjectAsset(slug, asset.slug, true)
                                        .then(() => { toast(`Started ${asset.slug}.`); onChanged(); })
                                        .catch((error) => toast((error as Error).message, true));
                                }}
                            >▶</span>
                        )}
                    </button>
                ))}
                <div className="obs-tree-root">workspace/</div>
                {renderWorkspaceNodes('', 1)}
                <div className="obs-tree-actions">
                    <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>⬆ Upload</button>
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
                        <div className="obs-explorer-split">
                            <div className="obs-explorer-editor">
                                <CodeEditor
                                    value={headSource}
                                    language={assetDetail.data.language}
                                    onChange={setDraft}
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
                    <div className="obs-explorer-crumb">
                        <strong>workspace/{selected.path || ''}</strong>
                        <span className="hint">Directory</span>
                        <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>⬆ Upload here</button>
                    </div>
                )}
                {selected?.root === 'workspace' && selected.kind === 'file' && (
                    <WorkspaceFileView
                        slug={slug}
                        filePath={selected.path}
                        draft={draft}
                        onDraft={setDraft}
                        onSave={() => void saveWorkspaceFile()}
                        onDelete={() => void deleteWorkspaceFile()}
                    />
                )}
            </section>
        </div>
    );
}

function WorkspaceFileView({
    slug, filePath, draft, onDraft, onSave, onDelete
}: {
    slug: string;
    filePath: string;
    draft: string | null;
    onDraft: (value: string) => void;
    onSave: () => void;
    onDelete: () => void;
}) {
    const toast = useToast();
    const [text, setText] = useState<string | null>(null);
    const [kind, setKind] = useState<'text' | 'image' | 'video' | 'binary'>('text');
    const url = api.projectContentUrl(slug, filePath);
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
        fetch(url, { credentials: 'same-origin' })
            .then((res) => {
                if (!res.ok) throw new Error('Could not read that file.');
                return res.text();
            })
            .then((body) => { setText(body); onDraft(body); })
            .catch((error) => toast((error as Error).message, true));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slug, filePath]);

    return (
        <>
            <div className="obs-explorer-crumb">
                <strong>workspace/{filePath}</strong>
                <a className="btn" href={api.projectContentUrl(slug, filePath, true)}>⬇ Download</a>
                {kind === 'text' && <button type="button" className="btn primary" disabled={draft == null} onClick={onSave}>Save</button>}
                <button type="button" className="btn danger" onClick={onDelete}>Delete</button>
            </div>
            {kind === 'image' && <img className="obs-file-preview" src={url} alt={filePath} />}
            {kind === 'video' && <video className="obs-video" src={url} controls preload="metadata" />}
            {kind === 'binary' && (
                <div className="empty">
                    Binary file. <a href={api.projectContentUrl(slug, filePath, true)}>Download</a>
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
        </>
    );
}
