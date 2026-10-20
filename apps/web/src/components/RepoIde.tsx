import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { accountFetch } from '../lib/browserAccount';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { CodeEditor, languageFromPath, type EditorSelection } from './CodeEditor';
import { DiffView } from './repoParts';
import type { RepoEntry } from './ProjectRepos';

type ChangeKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflict';
type Change = { path: string; code: string; kind: ChangeKind; from?: string };
type ChangesPayload = {
    branch: string | null; upstream: string | null; ahead: number; behind: number;
    operation: string | null; head: string | null; files: Change[]; truncated: boolean;
};
type WsEntry = { path: string; name: string; kind: 'file' | 'directory'; size: number };
type Tab = {
    rel: string;
    content: string;
    saved: string;
    base: string | null;
    error?: string;
    binary?: boolean;
};

const MAX_OPEN_BYTES = 1024 * 1024;
const MAX_ASK_CHARS = 6000;
const KIND_LETTER: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', untracked: 'U', renamed: 'R', conflict: '!' };

/**
 * An editor for one clone (`workspace/repos/<name>`), with git in it: the
 * tree marks what changed, the gutter shows added / changed / removed lines
 * against HEAD, a tab can flip to its diff, and the Changes pane commits
 * (everything or the ticked files), discards a file, pulls and pushes - all
 * through the same project repository routes the Code view uses, with the
 * viewer's own GitHub connection. "Ask Goobster" sends the selected lines to
 * the project chat, pre-filled, never sent.
 */
export function RepoIde({ slug, ownerId, entry, onClose, askGoobster }: {
    slug: string;
    ownerId?: string | null;
    entry: RepoEntry;
    onClose: () => void;
    askGoobster?: (text: string) => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const root = `repos/${entry.name}`;
    const [pane, setPane] = useState<'files' | 'changes'>('files');
    const [open, setOpen] = useState<Record<string, boolean>>({ '': true });
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [active, setActive] = useState<string | null>(null);
    const [diffFor, setDiffFor] = useState<string | null>(null);
    const [selection, setSelection] = useState<EditorSelection | null>(null);
    const [message, setMessage] = useState('');
    const [unticked, setUnticked] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState<string | null>(null);

    const changesKey = keys.projectRepoDetail(slug, entry.name, 'changes', ownerId);
    const changes = useQuery({
        queryKey: changesKey,
        queryFn: () => api.projectRepoChanges(slug, entry.name, ownerId) as Promise<ChangesPayload>,
        retry: false
    });
    const byPath = useMemo(() => new Map((changes.data?.files || []).map((change) => [change.path, change])), [changes.data]);
    const dirtyDirs = useMemo(() => {
        const dirs = new Set<string>();
        for (const change of changes.data?.files || []) {
            const parts = change.path.split('/');
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
        }
        return dirs;
    }, [changes.data]);

    const refreshGit = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: ['project-repos', slug] });
        await queryClient.invalidateQueries({ queryKey: ['project-files', slug] });
    }, [queryClient, slug]);

    async function openFile(rel: string, size?: number, reload = false) {
        setActive(rel);
        setDiffFor(null);
        if (reload) setTabs((prev) => prev.filter((tab) => tab.rel !== rel));
        else if (tabs.some((tab) => tab.rel === rel)) return;
        if (size != null && size > MAX_OPEN_BYTES) {
            setTabs((prev) => [...prev, { rel, content: '', saved: '', base: null, error: 'This file is over 1 MB: download it from Files instead.' }]);
            return;
        }
        setTabs((prev) => [...prev, { rel, content: '', saved: '', base: null }]);
        try {
            const [res, base] = await Promise.all([
                accountFetch(api.projectContentUrl(slug, `${root}/${rel}`, false, ownerId), { credentials: 'same-origin' }),
                api.projectRepoFile(slug, entry.name, rel, ownerId).catch(() => null) as Promise<{ exists: boolean; binary?: boolean; content: string } | null>
            ]);
            if (!res.ok) throw new Error(res.status === 404 ? 'This file is not in the working tree (deleted?).' : 'Could not read that file.');
            const text = await res.text();
            const binary = text.slice(0, 8000).includes('\u0000') || Boolean(base?.binary);
            setTabs((prev) => prev.map((tab) => (tab.rel === rel
                ? { ...tab, content: text, saved: text, base: base ? (base.exists ? base.content : '') : null, binary }
                : tab)));
        } catch (error) {
            setTabs((prev) => prev.map((tab) => (tab.rel === rel ? { ...tab, error: (error as Error).message } : tab)));
        }
    }

    async function closeTab(rel: string) {
        const tab = tabs.find((t) => t.rel === rel);
        if (tab && tab.content !== tab.saved && !await confirm(`Close ${rel} without saving?`)) return;
        const rest = tabs.filter((t) => t.rel !== rel);
        setTabs(rest);
        if (active === rel) setActive(rest.length ? rest[rest.length - 1].rel : null);
    }

    const current = tabs.find((tab) => tab.rel === active) || null;
    const dirty = current ? current.content !== current.saved : false;

    async function save(rel = active) {
        const tab = tabs.find((t) => t.rel === rel);
        if (!tab || tab.content === tab.saved || tab.binary || tab.error) return;
        try {
            await api.putProjectContent(slug, `${root}/${tab.rel}`, tab.content, ownerId);
            setTabs((prev) => prev.map((t) => (t.rel === tab.rel ? { ...t, saved: tab.content } : t)));
            toast(`Saved ${tab.rel}.`);
            await refreshGit();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function run(label: string, fn: () => Promise<unknown>, done: (result: unknown) => string | null) {
        setBusy(label);
        try {
            const result = await fn();
            const note = done(result);
            if (note) toast(note);
            await refreshGit();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
        }
    }

    const files = changes.data?.files || [];
    const chosen = files.filter((file) => !unticked[file.path]).map((file) => file.path);
    const unsaved = tabs.filter((tab) => tab.content !== tab.saved);

    async function commit() {
        if (unsaved.length && !await confirm(`${unsaved.length} open file(s) have unsaved edits that will not be in this commit. Commit anyway?`)) return;
        const all = chosen.length === files.length;
        await run('commit', () => api.projectRepoAction(slug, entry.name, 'commit', { message, ...(all ? {} : { paths: chosen }) }, ownerId),
            (result) => {
                const out = result as { committed: boolean; short?: string };
                if (out.committed) setMessage('');
                return out.committed ? `Committed ${out.short}.` : 'Nothing to commit.';
            });
        setUnticked({});
    }

    async function discard(change: Change) {
        if (!await confirm(change.kind === 'untracked' || change.kind === 'added'
            ? `Delete the new file ${change.path}? A workspace snapshot is kept.`
            : `Throw away your changes to ${change.path}? A workspace snapshot is kept.`)) return;
        await run(`discard:${change.path}`, () => api.projectRepoDiscard(slug, entry.name, change.path, ownerId), () => `Discarded ${change.path}.`);
        // Reload an open tab of that file from disk.
        if (tabs.some((tab) => tab.rel === change.path)) {
            if (change.kind !== 'untracked' && change.kind !== 'added') {
                void openFile(change.path, undefined, true);
            } else {
                setTabs((prev) => prev.filter((tab) => tab.rel !== change.path));
                if (active === change.path) setActive(null);
            }
        }
    }

    function ask() {
        if (!current || !selection || selection.empty || !askGoobster) return;
        const lang = languageFromPath(current.rel);
        const text = selection.text.length > MAX_ASK_CHARS ? `${selection.text.slice(0, MAX_ASK_CHARS)}\n… (cut)` : selection.text;
        const lines = selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}-${selection.toLine}`;
        askGoobster(`About ${root}/${current.rel}, ${lines}${dirty ? ' (unsaved edit)' : ''}:\n\`\`\`${lang === 'text' ? '' : lang}\n${text}\n\`\`\`\n`);
    }

    // Warn before leaving the page with unsaved edits.
    useEffect(() => {
        if (!unsaved.length) return undefined;
        const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [unsaved.length]);

    const diff = useQuery({
        queryKey: [...keys.projectRepoDetail(slug, entry.name, 'diff', ownerId), diffFor || ''],
        queryFn: () => api.projectRepoDiff(slug, entry.name, diffFor, ownerId) as Promise<{ patch: string; empty: boolean; truncated: boolean }>,
        enabled: diffFor != null,
        retry: false
    });

    const data = changes.data;
    return (
        <div className="repo-ide" data-testid="repo-ide">
            <div className="repo-ide-bar">
                <button type="button" className="btn small subtle" onClick={async () => {
                    if (unsaved.length && !await confirm(`Leave the editor? ${unsaved.length} file(s) have unsaved edits.`)) return;
                    onClose();
                }}>← Repositories</button>
                <strong>{entry.repo}</strong>
                <code>{data?.branch || entry.status?.branch || 'detached'}</code>
                {data && <span className="hint">{data.ahead}↑ {data.behind}↓ · {files.length} changed{data.operation ? ` · ⚠️ ${data.operation} in progress` : ''}</span>}
                <span className="repo-ide-bar-actions">
                    <button type="button" className="btn small" disabled={busy != null} onClick={() => void run('pull',
                        () => api.projectRepoAction(slug, entry.name, 'pull', {}, ownerId),
                        (result) => ((result as { updated: boolean }).updated ? 'Pulled.' : 'Already up to date.'))}>Pull</button>
                    <button type="button" className="btn small" disabled={busy != null || !data || data.ahead === 0 && Boolean(data.upstream)} onClick={() => void run('push',
                        () => api.projectRepoAction(slug, entry.name, 'push', {}, ownerId),
                        (result) => {
                            const pushed = result as { branch: string; compareUrl?: string | null };
                            return pushed.compareUrl ? `Pushed ${pushed.branch}. Open a pull request: ${pushed.compareUrl}` : `Pushed ${pushed.branch}.`;
                        })}>Push</button>
                </span>
            </div>
            <div className="repo-ide-main">
                <aside className="repo-ide-side">
                    <div className="repo-ide-side-tabs" role="tablist">
                        <button type="button" role="tab" aria-selected={pane === 'files'} className={`btn small${pane === 'files' ? ' primary' : ' subtle'}`} onClick={() => setPane('files')}>Files</button>
                        <button type="button" role="tab" aria-selected={pane === 'changes'} className={`btn small${pane === 'changes' ? ' primary' : ' subtle'}`} onClick={() => setPane('changes')}>
                            Changes{files.length ? ` (${files.length})` : ''}
                        </button>
                    </div>
                    {pane === 'files' && (
                        <div className="repo-ide-tree" role="tree" aria-label={`Files of ${entry.repo}`}>
                            <TreeLevel slug={slug} ownerId={ownerId} root={root} dir="" depth={0} open={open}
                                onToggle={(dir) => setOpen((prev) => ({ ...prev, [dir]: !prev[dir] }))}
                                onOpenFile={(rel, size) => void openFile(rel, size)} active={active} byPath={byPath} dirtyDirs={dirtyDirs} />
                        </div>
                    )}
                    {pane === 'changes' && (
                        <div className="repo-ide-changes">
                            {changes.isError && <div className="hint">{(changes.error as Error).message}</div>}
                            {data && files.length === 0 && <div className="hint">No uncommitted changes.</div>}
                            {files.map((change) => (
                                <div key={change.path} className={`repo-ide-change kind-${change.kind}`}>
                                    <input type="checkbox" checked={!unticked[change.path]} aria-label={`Include ${change.path}`}
                                        onChange={(e) => setUnticked((prev) => ({ ...prev, [change.path]: !e.target.checked }))} />
                                    <span className="repo-ide-letter" title={change.kind}>{KIND_LETTER[change.kind]}</span>
                                    <button type="button" className="repo-ide-link" onClick={() => {
                                        if (change.kind === 'deleted') { setActive(null); setDiffFor(change.path); }
                                        else { void openFile(change.path).then(() => setDiffFor(change.path)); }
                                    }}>{change.path}</button>
                                    <button type="button" className="btn small subtle" disabled={busy != null} title="Discard this file's changes"
                                        onClick={() => void discard(change)}>↺</button>
                                </div>
                            ))}
                            {data?.truncated && <div className="hint">Only the first 1000 changes are listed.</div>}
                            {files.length > 0 && (
                                <div className="repo-ide-commit">
                                    <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)}
                                        placeholder="Commit message" aria-label="Commit message" />
                                    <button type="button" className="btn primary" disabled={busy != null || !message.trim() || chosen.length === 0}
                                        onClick={() => void commit()}>
                                        {chosen.length === files.length ? `Commit all (${files.length})` : `Commit ${chosen.length} file(s)`}
                                    </button>
                                    <span className="hint">Authored as your GitHub account; push when ready.</span>
                                </div>
                            )}
                        </div>
                    )}
                </aside>
                <section className="repo-ide-editor">
                    <div className="repo-ide-tabs" role="tablist">
                        {tabs.map((tab) => (
                            <div key={tab.rel} className={`repo-ide-tab${tab.rel === active ? ' active' : ''}`} role="tab" aria-selected={tab.rel === active}>
                                <button type="button" className="repo-ide-tab-name" title={tab.rel} onClick={() => { setActive(tab.rel); setDiffFor(null); }}>
                                    {tab.rel.split('/').pop()}{tab.content !== tab.saved ? ' ●' : ''}
                                </button>
                                <button type="button" className="repo-ide-tab-close" aria-label={`Close ${tab.rel}`} onClick={() => void closeTab(tab.rel)}>×</button>
                            </div>
                        ))}
                    </div>
                    {current && (
                        <div className="repo-ide-toolbar">
                            <code className="repo-ide-path">{current.rel}</code>
                            {byPath.get(current.rel) && <span className="hint">{byPath.get(current.rel)?.kind}</span>}
                            <span className="repo-ide-toolbar-actions">
                                {askGoobster && selection && !selection.empty && (
                                    <button type="button" className="btn small" onClick={ask}>
                                        Ask Goobster about {selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}–${selection.toLine}`}
                                    </button>
                                )}
                                <button type="button" className={`btn small${diffFor === current.rel ? ' primary' : ''}`}
                                    onClick={() => setDiffFor(diffFor === current.rel ? null : current.rel)}>Diff vs HEAD</button>
                                <button type="button" className="btn small primary" disabled={!dirty} onClick={() => void save()} title="Ctrl/Cmd+S">Save</button>
                            </span>
                        </div>
                    )}
                    {diffFor && (!current || diffFor === current.rel) ? (
                        <div className="repo-ide-diff">
                            {diff.isPending && <div className="hint">Loading the diff…</div>}
                            {diff.isError && <div className="hint">{(diff.error as Error).message}</div>}
                            {diff.data && (diff.data.empty ? <div className="hint">No changes against HEAD.</div> : <DiffView text={diff.data.patch} />)}
                            {dirty && <div className="hint">The diff shows the saved file; save to include your edits.</div>}
                        </div>
                    ) : current ? (
                        current.error ? <div className="empty">{current.error}</div>
                            : current.binary ? <div className="empty">Binary file: not editable here.</div>
                                : (
                                    <div className="repo-ide-code">
                                        <CodeEditor
                                            key={current.rel}
                                            value={current.content}
                                            language={languageFromPath(current.rel)}
                                            gitBase={current.base}
                                            onChange={(value) => setTabs((prev) => prev.map((tab) => (tab.rel === current.rel ? { ...tab, content: value } : tab)))}
                                            onSelectionChange={setSelection}
                                            onSave={() => void save(current.rel)}
                                        />
                                    </div>
                                )
                    ) : (
                        <div className="empty">Open a file from the tree, or a change to see its diff.</div>
                    )}
                </section>
            </div>
        </div>
    );
}

function TreeLevel({ slug, ownerId, root, dir, depth, open, onToggle, onOpenFile, active, byPath, dirtyDirs }: {
    slug: string;
    ownerId?: string | null;
    root: string;
    dir: string;
    depth: number;
    open: Record<string, boolean>;
    onToggle: (dir: string) => void;
    onOpenFile: (rel: string, size?: number) => void;
    active: string | null;
    byPath: Map<string, Change>;
    dirtyDirs: Set<string>;
}) {
    const listing = useQuery({
        queryKey: keys.projectFiles(slug, dir ? `${root}/${dir}` : root, ownerId),
        queryFn: () => api.projectFiles(slug, dir ? `${root}/${dir}` : root, ownerId) as Promise<{ entries?: WsEntry[] }>,
        retry: false
    });
    if (listing.isPending) return <div className="hint" style={{ paddingLeft: 8 + depth * 12 }}>…</div>;
    if (listing.isError) return <div className="hint" style={{ paddingLeft: 8 + depth * 12 }}>{(listing.error as Error).message}</div>;
    const entries = [...(listing.data?.entries || [])].sort((a, b) =>
        (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return (
        <>
            {entries.map((item) => {
                const rel = dir ? `${dir}/${item.name}` : item.name;
                if (item.kind === 'directory') {
                    return (
                        <div key={rel} role="treeitem" aria-expanded={Boolean(open[rel])}>
                            <button type="button" className={`repo-ide-node is-dir${dirtyDirs.has(rel) ? ' is-dirty' : ''}`}
                                style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onToggle(rel)}>
                                {open[rel] ? '▾' : '▸'} {item.name}
                            </button>
                            {open[rel] && (
                                <div role="group">
                                    <TreeLevel slug={slug} ownerId={ownerId} root={root} dir={rel} depth={depth + 1} open={open}
                                        onToggle={onToggle} onOpenFile={onOpenFile} active={active} byPath={byPath} dirtyDirs={dirtyDirs} />
                                </div>
                            )}
                        </div>
                    );
                }
                const change = byPath.get(rel);
                return (
                    <button key={rel} type="button" role="treeitem"
                        className={`repo-ide-node${rel === active ? ' active' : ''}${change ? ` kind-${change.kind}` : ''}`}
                        style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onOpenFile(rel, item.size)}>
                        <span className="repo-ide-node-name">{item.name}</span>
                        {change && <span className="repo-ide-letter" title={change.kind}>{KIND_LETTER[change.kind]}</span>}
                    </button>
                );
            })}
        </>
    );
}
