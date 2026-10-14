import type { ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { whenLabel } from '../observatory/format';
import { ciBadge } from '../../components/repoParts';
import type { ProjectViewId } from '../../lib/rooms';

type NowPayload = {
    running: { id: number; startedBy: string | null; createdAt: string }[];
    failure: { id: number; status: string; errorCode: string | null; exitCode: number | null; finishedAt: string | null; stderrTail: string | null } | null;
    needsYou: { count: number; cards: { id: string; column: string; title: string; detail: string | null }[] };
    repos: {
        name: string; repo: string; branch: string | null; ahead: number | null; behind: number | null; changed: number | null;
        operation: string | null; conflicts: number; ci: { state: 'success' | 'failure' | 'pending' | 'none'; failing: string[] } | null;
        pr: { number: number; title: string; url: string; draft: boolean } | null; remoteError: string | null;
    }[];
    instructions: { exists: boolean; lines?: number; updatedAt?: string };
    lastGoobster: { at: string; excerpt: string; conversationTitle: string | null } | null;
};

const INSTRUCTIONS_TEMPLATE = `# Project instructions

Goobster reads this file (GOOBSTER.md) before every turn on this project: chat, commands, triggers and CI fixes.

## What this project is

## How to run and test it
- 

## Conventions
- 

## Don't
- 
`;

/**
 * The Overview's "Now": what is happening on the project and what needs a
 * person, from one read (GET /projects/:slug/now). Each line links to the
 * view that acts on it; a failed run can be asked about straight away.
 */
export function NowPanel({ slug, ownerId, onOpen, askGoobster, canRun }: {
    slug: string;
    ownerId: string;
    onOpen: (view: ProjectViewId) => void;
    askGoobster: (text: string) => void;
    canRun: boolean;
}) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const now = useQuery({
        queryKey: keys.projectNow(slug, ownerId),
        queryFn: () => api.projectNow(slug, ownerId) as Promise<NowPayload>,
        retry: false,
        refetchInterval: (query) => ((query.state.data as NowPayload | undefined)?.running.length ? 15_000 : 60_000)
    });
    if (now.isPending) return <section className="obs-now" data-testid="project-now"><div className="hint">Checking what is going on…</div></section>;
    if (now.isError) return null;
    const data = now.data;
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.projectNow(slug, ownerId) });

    async function rerun(jobId: number) {
        try {
            const job = await api.observatoryRerunJob(jobId) as { id: number };
            toast(`Started run #${job.id}.`);
            await refresh();
            await queryClient.invalidateQueries({ queryKey: keys.observatory });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function addInstructions() {
        try {
            await api.putProjectContent(slug, 'GOOBSTER.md', INSTRUCTIONS_TEMPLATE, ownerId);
            toast('Created GOOBSTER.md: fill it in from Files.');
            await refresh();
            onOpen('files');
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const items: ReactElement[] = [];
    for (const job of data.running) {
        items.push(
            <li key={`run-${job.id}`} className="obs-now-item">
                <span className="tool-spinner" aria-hidden="true" /> Run #{job.id} is running
                <span className="hint"> · started {whenLabel(job.createdAt)}{job.startedBy ? ` by ${job.startedBy}` : ''}</span>
                <button type="button" className="btn small" onClick={() => onOpen('runs')}>Runs</button>
            </li>
        );
    }
    if (data.failure) {
        const failure = data.failure;
        items.push(
            <li key="failure" className="obs-now-item is-failure">
                ❌ Run #{failure.id} {failure.status === 'TIMED_OUT' ? 'timed out' : 'failed'}
                {failure.exitCode != null ? ` (exit ${failure.exitCode})` : ''}
                <span className="hint"> · {whenLabel(failure.finishedAt || undefined)}</span>
                {failure.stderrTail && <pre className="obs-now-tail">{failure.stderrTail}</pre>}
                <div className="tool-card-actions">
                    <button type="button" className="btn small" onClick={() => askGoobster(
                        `Run #${failure.id} in this project ${failure.status === 'TIMED_OUT' ? 'timed out' : 'failed'}`
                        + `${failure.exitCode != null ? ` with exit ${failure.exitCode}` : ''}. Look at its output and what changed since the last good run, `
                        + 'find the cause and fix it, then run it again.'
                    )}>Ask Goobster why</button>
                    {canRun && <button type="button" className="btn small" onClick={() => void rerun(failure.id)}>Run again</button>}
                    <button type="button" className="btn small subtle" onClick={() => onOpen('runs')}>Runs</button>
                </div>
            </li>
        );
    }
    for (const card of data.needsYou.cards) {
        items.push(
            <li key={`needs-${card.id}`} className="obs-now-item">
                🙋 {card.title}{card.detail ? <span className="hint"> · {card.detail}</span> : null}
                <button type="button" className="btn small" onClick={() => onOpen('plan')}>Plan</button>
            </li>
        );
    }
    for (const repo of data.repos) {
        const attention = repo.operation || repo.ci?.state === 'failure' || (repo.changed || 0) > 0 || (repo.behind || 0) > 0;
        items.push(
            <li key={`repo-${repo.name}`} className={`obs-now-item${repo.operation || repo.ci?.state === 'failure' ? ' is-failure' : ''}`}>
                📦 {repo.repo} <code>{repo.branch || 'detached'}</code>
                {repo.operation ? <> · ⚠️ {repo.operation} stopped on {repo.conflicts} conflict(s)</> : null}
                {repo.ci ? <> · {ciBadge({ state: repo.ci.state, failing: repo.ci.failing.map((name) => ({ name, conclusion: 'failure', url: null, summary: '' })), pending: [], passed: 0, total: 0 })}</> : null}
                {repo.ci?.failing.length ? <span className="hint"> ({repo.ci.failing.join(', ')})</span> : null}
                {repo.pr ? <> · <a href={repo.pr.url} target="_blank" rel="noreferrer">PR #{repo.pr.number}</a></> : null}
                {(repo.changed || 0) > 0 ? <span className="hint"> · {repo.changed} uncommitted</span> : null}
                {(repo.behind || 0) > 0 ? <span className="hint"> · {repo.behind} behind</span> : null}
                {(repo.ahead || 0) > 0 ? <span className="hint"> · {repo.ahead} to push</span> : null}
                {!attention && !repo.pr ? <span className="hint"> · up to date</span> : null}
                <button type="button" className="btn small" onClick={() => onOpen('code')}>Code</button>
            </li>
        );
    }
    if (!data.instructions.exists) {
        items.push(
            <li key="instructions" className="obs-now-item">
                📝 No project instructions yet: a GOOBSTER.md tells Goobster how to run, test and work on this project every turn.
                <button type="button" className="btn small" onClick={() => void addInstructions()}>Add GOOBSTER.md</button>
            </li>
        );
    }

    return (
        <section className="obs-now" data-testid="project-now" aria-labelledby="obs-now-title">
            <div className="obs-section-head">
                <h3 id="obs-now-title">Now</h3>
                {data.instructions.exists && (
                    <span className="hint">GOOBSTER.md · {data.instructions.lines} line(s){data.instructions.updatedAt ? ` · edited ${whenLabel(data.instructions.updatedAt)}` : ''}</span>
                )}
            </div>
            {items.length === 0
                ? <div className="hint">Nothing running, nothing failing, nothing waiting on you.</div>
                : <ul className="obs-now-list">{items}</ul>}
            {data.lastGoobster && (
                <div className="obs-now-last">
                    <span className="hint">Goobster, {whenLabel(data.lastGoobster.at)}{data.lastGoobster.conversationTitle ? ` in ${data.lastGoobster.conversationTitle}` : ''}:</span>
                    {' '}{data.lastGoobster.excerpt}
                    <button type="button" className="btn small subtle" onClick={() => onOpen('conversation')}>Conversation</button>
                </div>
            )}
        </section>
    );
}
