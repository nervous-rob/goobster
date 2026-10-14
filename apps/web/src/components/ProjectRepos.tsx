import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { ciBadge, DiffView, type CiPayload } from './repoParts';

/**
 * Project repositories (ADR 0015) in the portal: the Code view's clone list
 * with branch, CI and pull-request state, and the shared diff renderer.
 */

export type RepoStatus = {
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
export type ComparePayload = {
    base: string; head: string; ahead: number | null; behind: number | null; identical: boolean; sharedHistory: boolean;
    commits: { short: string; author: string; message: string }[];
    files: { path: string; additions: number; deletions: number; binary: boolean }[];
    fileCount: number; additions: number; deletions: number; patch: string; truncated: boolean;
};
type PullEntry = { number: number; title: string; url: string; state: string; draft: boolean; author: string | null; head: string; base: string; ci: CiPayload | null };
export type IntegrationResult = { kind: string; base: string; result: string; conflicts: string[]; to?: string };
export type RepoEntry = {
    name: string;
    repo: string;
    path: string;
    url: string;
    clonedBranch: string;
    lastPushAt?: string | null;
    status?: RepoStatus;
};
type ReposPayload = { enabled: boolean; reason?: string | null; maxRepos: number; repos: RepoEntry[] };

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
export function RepoPanel({ slug, ownerId, onChanged, codeView = false }: {
    slug: string;
    ownerId?: string | null;
    onChanged: () => void;
    /** The Code view: a GitHub status strip per clone and the first clone's detail open. */
    codeView?: boolean;
}) {
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
    const shown = expanded ?? (codeView ? data?.repos[0]?.name ?? null : null);

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
                        {codeView && <RepoStrip slug={slug} ownerId={ownerId} entry={entry} />}
                        {codeView && <CiWatchControl slug={slug} ownerId={ownerId} entry={entry} />}
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
                            <button type="button" className="btn" onClick={() => setExpanded(shown === entry.name ? '' : entry.name)}>
                                {shown === entry.name ? 'Hide details' : 'Branches · PRs · CI'}
                            </button>
                            <button type="button" className="btn danger" disabled={busy != null} onClick={() => void remove(entry)}>Remove</button>
                        </div>
                        {shown === entry.name && (
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

type RepoSummary = {
    ci: CiPayload | null;
    pr: { number: number; title: string; url: string; draft: boolean; base: string | null } | null;
    remoteError: string | null;
};

type CiWatch = { id: number; branch: string; mode: 'notify' | 'fix'; maxFixes: number; fixesUsed: number; lastState: string | null; lastOutcome: string | null };

/** The viewer's CI watch on the clone's current branch: off, notify, or notify and try to fix. */
function CiWatchControl({ slug, ownerId, entry }: { slug: string; ownerId?: string | null; entry: RepoEntry }) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const branch = entry.status?.branch || '';
    const key = keys.projectRepoDetail(slug, entry.name, 'watches', ownerId);
    const watches = useQuery({
        queryKey: key,
        queryFn: () => api.projectRepoWatches(slug, entry.name, ownerId) as Promise<{ watches: CiWatch[] }>,
        retry: false,
        enabled: Boolean(branch)
    });
    if (!branch || watches.isError) return null;
    const current = watches.data?.watches.find((watch) => watch.branch === branch) || null;

    async function change(mode: 'off' | 'notify' | 'fix') {
        try {
            if (mode === 'off') await api.unwatchProjectRepo(slug, entry.name, branch, ownerId);
            else await api.watchProjectRepo(slug, entry.name, { branch, mode }, ownerId);
            await queryClient.invalidateQueries({ queryKey: key });
            toast(mode === 'off' ? `Stopped watching CI on ${branch}.`
                : mode === 'fix' ? `Watching CI on ${branch}; Goobster will try to fix a red build.` : `Watching CI on ${branch}; results go to your Inbox.`);
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    return (
        <label className="hint repo-watch" data-testid="repo-watch">
            👀 Watch CI on {branch}:{' '}
            <select className="input" value={current ? current.mode : 'off'} onChange={(e) => void change(e.target.value as 'off' | 'notify' | 'fix')}
                aria-label={`CI watch on ${branch}`}>
                <option value="off">off</option>
                <option value="notify">notify me</option>
                <option value="fix">notify and try to fix</option>
            </select>
            {current?.lastOutcome ? <> · {current.lastOutcome}</> : null}
        </label>
    );
}

/** One clone's GitHub state at a glance: CI on the current branch and its open pull request. */
function RepoStrip({ slug, ownerId, entry }: { slug: string; ownerId?: string | null; entry: RepoEntry }) {
    const summary = useQuery({
        queryKey: keys.projectRepoDetail(slug, entry.name, 'summary', ownerId, entry.status?.branch || ''),
        queryFn: () => api.projectRepoSummary(slug, entry.name, ownerId) as Promise<RepoSummary>,
        retry: false,
        refetchInterval: (query) => ((query.state.data as RepoSummary | undefined)?.ci?.state === 'pending' ? 30_000 : false)
    });
    if (summary.isPending) return <div className="hint">Checking GitHub…</div>;
    if (summary.isError) return <div className="hint">GitHub status unavailable: {(summary.error as Error).message}</div>;
    const { ci, pr, remoteError } = summary.data;
    return (
        <div className="hint repo-strip" data-testid="repo-strip">
            {remoteError ? <>GitHub status unavailable: {remoteError}</> : (
                <>
                    {ciBadge(ci)}
                    {ci?.failing?.length ? <> · {ci.failing.map((f) => f.name).join(', ')}</> : null}
                    {' · '}
                    {pr
                        ? <a href={pr.url} target="_blank" rel="noreferrer">PR #{pr.number}{pr.draft ? ' (draft)' : ''}: {pr.title}</a>
                        : entry.status?.branch === entry.clonedBranch ? 'base branch' : 'no pull request yet'}
                </>
            )}
        </div>
    );
}


