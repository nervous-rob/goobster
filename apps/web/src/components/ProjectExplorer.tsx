import { useAttachmentDrop } from '../hooks/useAttachmentDrop';
import { accountFetch } from '../lib/browserAccount';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { diffLines } from 'diff';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { CodeEditor, languageFromPath, type EditorSelection } from './CodeEditor';
import { DiffView } from './repoParts';
import { fileContextItems, usePublishViewContext } from '../hooks/useViewContext';

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

type SearchResult = {
    hits: { path: string; line: number; text: string }[];
    files: string[];
    filesScanned: number;
    truncated: boolean;
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
    if (kind === 'script') return '📜';
    return '📝';
}

const ASSET_GROUPS: { kind: string; label: string }[] = [
    { kind: 'app', label: 'Apps' },
    { kind: 'script', label: 'Scripts' },
    { kind: 'note', label: 'Notes' }
];

/** Per-viewer explorer layout, remembered in this browser only. */
type ExplorerPrefs = {
    width?: number;
    workspaceOpen?: boolean;
    assetsOpen?: boolean;
    closedGroups?: string[];
    showHidden?: boolean;
};
const PREFS_KEY = 'goobster.projectExplorer';
const TREE_MIN = 200;
const TREE_MAX = 560;
const TREE_DEFAULT = 300;
/** Above this many assets the section starts collapsed (until the viewer opens it). */
const ASSETS_COLLAPSE_AT = 12;

function readPrefs(): ExplorerPrefs {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed as ExplorerPrefs : {};
    } catch {
        return {};
    }
}

function writePrefs(prefs: ExplorerPrefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/**
 * A long name truncates in the middle, keeping its end (dates, versions and
 * the extension usually tell siblings apart). Plain text, so the button's
 * accessible name is still the whole name.
 */
function TreeName({ name }: { name: string }) {
    if (name.length <= 22) return <span className="obs-tree-name">{name}</span>;
    const keep = Math.min(12, Math.floor(name.length / 3));
    return (
        <span className="obs-tree-name is-split">
            <span className="obs-tree-name-head">{name.slice(0, -keep)}</span>
            <span className="obs-tree-name-tail">{name.slice(-keep)}</span>
        </span>
    );
}

function clampWidth(width: number): number {
    return Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(width)));
}

export function ProjectExplorer({ slug, ownerId, onChanged, askGoobster }: {
    slug: string;
    ownerId?: string | null;
    onChanged: () => void;
    /** Open the project chat with a request pre-filled (the editor's "Ask Goobster"). */
    askGoobster?: (text: string) => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<Selection | null>(null);
    const [wsOpen, setWsOpen] = useState<Record<string, boolean>>({ '': true });
    // `?file=<path>` (the command palette, links): open that workspace file
    // with its folders unfolded.
    const linkedFile = (useSearch({ strict: false }) as { file?: unknown }).file;
    useEffect(() => {
        if (typeof linkedFile !== 'string' || !linkedFile) return;
        const parts = linkedFile.split('/').filter(Boolean);
        setWsOpen((prev) => {
            const next = { ...prev };
            for (let i = 1; i < parts.length; i++) next[parts.slice(0, i).join('/')] = true;
            return next;
        });
        setSelected({ root: 'workspace', path: parts.join('/'), kind: 'file' });
    }, [linkedFile]);
    const [searchText, setSearchText] = useState('');
    const [prefs, setPrefsState] = useState<ExplorerPrefs>(() => readPrefs());
    const setPrefs = (patch: ExplorerPrefs) => setPrefsState((prev) => {
        const next = { ...prev, ...patch };
        writePrefs(next);
        return next;
    });
    const treeWidth = clampWidth(prefs.width ?? TREE_DEFAULT);
    const filter = searchText.trim().toLowerCase();
    const [searchFor, setSearchFor] = useState('');
    const search = useQuery({
        queryKey: keys.projectSearch(slug, searchFor, ownerId),
        queryFn: () => api.projectSearch(slug, searchFor, null, ownerId) as Promise<SearchResult>,
        enabled: searchFor.length >= 2,
        retry: false
    });
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

    /** True when the entry's name matches the filter, or a loaded descendant's does. */
    function matchesFilter(entry: WsEntry): boolean {
        if (!filter) return true;
        if (entry.name.toLowerCase().includes(filter)) return true;
        if (entry.kind !== 'directory') return false;
        return (wsChildren[entry.path] || []).some(matchesFilter);
    }

    function renderWorkspaceNodes(dirPath: string, depth: number) {
        const all = wsChildren[dirPath] || [];
        const hidden = all.filter((entry) => entry.name.startsWith('.'));
        const visible = all.filter((entry) => (prefs.showHidden || !entry.name.startsWith('.')) && matchesFilter(entry));
        const nodes = visible.map((entry) => {
            // A filter shows the matches inside loaded folders without opening them for good.
            const open = Boolean(wsOpen[entry.path]) || Boolean(filter && entry.kind === 'directory'
                && !entry.name.toLowerCase().includes(filter) && (wsChildren[entry.path] || []).some(matchesFilter));
            const active = selected?.root === 'workspace' && selected.path === entry.path;
            const icon = entry.kind === 'directory' ? (open ? '📂' : '📁') : (entry.isImage ? '🖼' : entry.isVideo ? '🎬' : '📄');
            return (
                <div key={entry.path}>
                    <button
                        type="button"
                        className={`obs-tree-item${active ? ' active' : ''}${entry.name.startsWith('.') ? ' is-hidden' : ''}`}
                        style={{ paddingLeft: 8 + depth * 14 }}
                        title={`workspace/${entry.path}${entry.kind === 'file' ? ` · ${sizeLabel(entry.size)}${entry.modifiedAt ? ` · ${whenLabel(entry.modifiedAt)}` : ''}` : ''}`}
                        onClick={() => {
                            setSelected({ root: 'workspace', path: entry.path, kind: entry.kind });
                            if (entry.kind === 'directory') void toggleWorkspace(entry.path);
                        }}
                    >
                        <span className="obs-tree-icon">{icon}</span>
                        <TreeName name={entry.name} />
                        {entry.kind === 'file' && <span className="obs-tree-meta">{sizeLabel(entry.size)}</span>}
                    </button>
                    {entry.kind === 'directory' && open && renderWorkspaceNodes(entry.path, depth + 1)}
                </div>
            );
        });
        if (hidden.length && !filter) {
            nodes.push(
                <button
                    key={`${dirPath}:hidden`}
                    type="button"
                    className="obs-tree-more"
                    style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => setPrefs({ showHidden: !prefs.showHidden })}
                >
                    {prefs.showHidden ? 'Hide dotfiles' : `+ ${hidden.length} hidden`}
                </button>
            );
        }
        return nodes;
    }

    function startResize(event: ReactPointerEvent<HTMLDivElement>) {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = treeWidth;
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('convs-resizing');
        const move = (e: PointerEvent) => setPrefsState((prev) => ({ ...prev, width: clampWidth(startWidth + e.clientX - startX) }));
        const up = () => {
            document.body.classList.remove('convs-resizing');
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            setPrefsState((prev) => { writePrefs(prev); return prev; });
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    }

    const filteredAssets = filter
        ? assetList.filter((asset) => `${asset.slug} ${asset.name}`.toLowerCase().includes(filter))
        : assetList;
    const assetsOpen = filter ? true : (prefs.assetsOpen ?? assetList.length <= ASSETS_COLLAPSE_AT);
    const workspaceOpen = filter ? true : (prefs.workspaceOpen ?? true);
    const closedGroups = new Set(prefs.closedGroups || []);
    const groupedAssets = [
        ...ASSET_GROUPS.map((group) => ({ ...group, rows: filteredAssets.filter((asset) => asset.kind === group.kind) })),
        { kind: 'other', label: 'Other', rows: filteredAssets.filter((asset) => !ASSET_GROUPS.some((group) => group.kind === asset.kind)) }
    ].filter((group) => group.rows.length);
    const rootCount = (wsChildren[''] || []).filter((entry) => prefs.showHidden || !entry.name.startsWith('.')).length;

    function renderAsset(asset: AssetRow) {
        const active = selected?.root === 'assets' && selected.slug === asset.slug;
        return (
            <button
                key={asset.slug}
                type="button"
                className={`obs-tree-item${active ? ' active' : ''}`}
                style={{ paddingLeft: 22 }}
                title={`assets/${asset.slug}${asset.name && asset.name !== asset.slug ? ` · ${asset.name}` : ''}`}
                onClick={() => setSelected({ root: 'assets', slug: asset.slug })}
            >
                <span className="obs-tree-icon">{assetIcon(asset.kind)}</span>
                <TreeName name={asset.slug} />
                {asset.currentVersion ? <span className="obs-tree-meta">v{asset.currentVersion}</span> : null}
                {asset.kind === 'script' && (
                    <span
                        className="obs-tree-run"
                        title="Run in the background"
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
        );
    }

    return (
        <div className="obs-explorer attachment-drop-zone" {...drop.dropProps}>
            {drop.indicator}
            <aside className="obs-tree" style={{ width: treeWidth }}>
                <div className="obs-tree-toolbar">
                    <form
                        className="obs-search"
                        role="search"
                        onSubmit={(event) => { event.preventDefault(); setSearchFor(searchText.trim()); }}
                    >
                        <input
                            className="input"
                            type="search"
                            value={searchText}
                            onChange={(event) => { setSearchText(event.target.value); if (!event.target.value) setSearchFor(''); }}
                            onKeyDown={(event) => { if (event.key === 'Escape') { setSearchText(''); setSearchFor(''); } }}
                            placeholder="Filter… (Enter searches inside)"
                            title="Type to filter file and asset names; press Enter to search inside workspace files; Esc clears."
                            aria-label="Search the workspace"
                        />
                    </form>
                    <button
                        type="button"
                        className="btn small"
                        title={`Upload into workspace/${uploadDir}`}
                        aria-label="Upload"
                        disabled={uploading || drop.busy}
                        onClick={() => fileInputRef.current?.click()}
                    >⬆</button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ''; }}
                    />
                </div>
                <div className="obs-tree-scroll">
                    {searchFor.length >= 2 && (
                        <div className="obs-search-results" data-testid="workspace-search-results">
                            <div className="obs-tree-section-head is-static">
                                <span>Contents matching “{searchFor}”</span>
                                <button type="button" className="obs-tree-clear" aria-label="Clear search"
                                    onClick={() => { setSearchText(''); setSearchFor(''); }}>✕</button>
                            </div>
                            {search.isPending && <span className="hint">Searching…</span>}
                            {search.isError && <span className="hint">{(search.error as Error).message}</span>}
                            {search.data && (
                                <>
                                    <span className="hint">
                                        {search.data.hits.length} line(s){search.data.truncated ? ' (capped)' : ''} in {search.data.filesScanned} file(s)
                                    </span>
                                    {search.data.files.map((file) => (
                                        <button key={`f:${file}`} type="button" className="obs-search-hit"
                                            onClick={() => setSelected({ root: 'workspace', path: file, kind: 'file' })}>📄 {file}</button>
                                    ))}
                                    {search.data.hits.map((hit) => (
                                        <button key={`${hit.path}:${hit.line}`} type="button" className="obs-search-hit"
                                            onClick={() => setSelected({ root: 'workspace', path: hit.path, kind: 'file' })}>
                                            <code>{hit.path}:{hit.line}</code> {hit.text}
                                        </button>
                                    ))}
                                </>
                            )}
                        </div>
                    )}

                    <button
                        type="button"
                        className="obs-tree-section-head"
                        aria-expanded={workspaceOpen}
                        onClick={() => setPrefs({ workspaceOpen: !workspaceOpen })}
                    >
                        <span className="obs-tree-caret">{workspaceOpen ? '▾' : '▸'}</span>
                        <span>workspace/</span>
                        <span className="obs-tree-count">{rootCount}</span>
                    </button>
                    {workspaceOpen && renderWorkspaceNodes('', 1)}

                    <button
                        type="button"
                        className="obs-tree-section-head"
                        aria-expanded={assetsOpen}
                        onClick={() => setPrefs({ assetsOpen: !assetsOpen })}
                    >
                        <span className="obs-tree-caret">{assetsOpen ? '▾' : '▸'}</span>
                        <span>assets/</span>
                        <span className="obs-tree-count">{filter ? `${filteredAssets.length}/${assetList.length}` : assetList.length}</span>
                    </button>
                    {assetsOpen && assets.isPending && <div className="hint obs-tree-note">Loading assets…</div>}
                    {assetsOpen && groupedAssets.map((group) => {
                        const groupOpen = Boolean(filter) || !closedGroups.has(group.kind);
                        return (
                            <div key={group.kind} role="group" aria-label={group.label}>
                                {groupedAssets.length > 1 && (
                                    <button
                                        type="button"
                                        className="obs-tree-group-head"
                                        aria-expanded={groupOpen}
                                        onClick={() => {
                                            const next = new Set(closedGroups);
                                            if (groupOpen) next.add(group.kind); else next.delete(group.kind);
                                            setPrefs({ closedGroups: [...next] });
                                        }}
                                    >
                                        <span className="obs-tree-caret">{groupOpen ? '▾' : '▸'}</span>
                                        <span>{group.label}</span>
                                        <span className="obs-tree-count">{group.rows.length}</span>
                                    </button>
                                )}
                                {groupOpen && group.rows.map(renderAsset)}
                            </div>
                        );
                    })}
                    {assetsOpen && filter && !filteredAssets.length && assetList.length > 0 && (
                        <div className="hint obs-tree-note">No asset names match.</div>
                    )}
                </div>
                <div className="obs-tree-footer hint">
                    Drop files to upload into workspace/{uploadDir}. Clones in repos/ open in the Code view's editor.
                </div>
            </aside>
            <div
                className="obs-tree-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the file tree"
                aria-valuemin={TREE_MIN}
                aria-valuemax={TREE_MAX}
                aria-valuenow={treeWidth}
                tabIndex={0}
                onPointerDown={startResize}
                onDoubleClick={() => setPrefs({ width: TREE_DEFAULT })}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') setPrefs({ width: clampWidth(treeWidth - 24) });
                    if (event.key === 'ArrowRight') setPrefs({ width: clampWidth(treeWidth + 24) });
                }}
            />
            <section className="obs-explorer-main">
                {!selected && (
                    <div className="empty obs-explorer-empty">
                        <p>Pick a file from workspace/ or assets/.</p>
                        <p className="hint">
                            {rootCount} item(s) at the workspace root · {assetList.length} asset(s).
                            Type in the box to filter names; press Enter to search inside files.
                            Drag the tree's edge to resize it.
                        </p>
                    </div>
                )}

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
                        askGoobster={askGoobster}
                    />
                )}
            </section>
        </div>
    );
}

function WorkspaceFileView({
    slug, ownerId, filePath, entry, draft, onDraft, onSave, onDelete, refreshToken = 0, onRestored, askGoobster
}: {
    askGoobster?: (text: string) => void;
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
    const [selection, setSelection] = useState<EditorSelection | null>(null);
    const viewContext = fileContextItems(`workspace/${filePath}`, kind === 'text' ? selection : null, draft != null ? ' (unsaved edit)' : '');
    usePublishViewContext('files:file', viewContext.file);
    usePublishViewContext('files:selection', viewContext.selection);
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
                {kind === 'text' && askGoobster && selection && !selection.empty && (
                    <button type="button" className="btn" onClick={() => {
                        const lang = languageFromPath(filePath);
                        const lines = selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}-${selection.toLine}`;
                        const text = selection.text.length > 6000 ? `${selection.text.slice(0, 6000)}\n… (cut)` : selection.text;
                        askGoobster(`About workspace/${filePath}, ${lines}:\n\`\`\`${lang === 'text' ? '' : lang}\n${text}\n\`\`\`\n`);
                    }}>Ask Goobster about {selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}–${selection.toLine}`}</button>
                )}
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
                                onSelectionChange={setSelection}
                                onSave={onSave}
                            />
                        </div>
                    )}
                </div>
                <WorkspaceHistoryRail slug={slug} ownerId={ownerId} filePath={filePath} onRestored={onRestored} />
            </div>
        </>
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
