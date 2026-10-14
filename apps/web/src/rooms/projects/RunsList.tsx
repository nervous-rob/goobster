import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DiffView } from '../../components/repoParts';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { whenLabel } from '../observatory/format';
import { STATUS_ICONS, type Job } from './types';
import type { Trigger } from './AutomationsTab';
import { featureActive } from '../../lib/rooms';

type LivePayload = {
    status: string;
    running: boolean;
    streaming: boolean;
    liveSupported: boolean;
    at: string | null;
    unchanged?: boolean;
    stdout?: string;
    stderr?: string;
    bytes?: number | null;
};

/**
 * What a running run is printing, refreshed every two seconds from the job
 * row (written by the job loop every few seconds, so this works whichever
 * process serves the portal). Follows the end unless the reader scrolled up.
 */
function LiveLog({ jobId }: { jobId: number }) {
    const [data, setData] = useState<LivePayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const preRef = useRef<HTMLPreElement | null>(null);
    const follow = useRef(true);
    const since = useRef<string | null>(null);

    useEffect(() => {
        let stopped = false;
        let timer: number | undefined;
        const tick = async () => {
            try {
                const next = await api.observatoryJobLive(jobId, since.current) as LivePayload;
                if (stopped) return;
                setError(null);
                if (!next.unchanged) {
                    since.current = next.at;
                    setData(next);
                }
                if (next.running) timer = window.setTimeout(() => void tick(), 2000);
            } catch (failure) {
                if (stopped) return;
                setError((failure as Error).message);
                timer = window.setTimeout(() => void tick(), 5000);
            }
        };
        void tick();
        return () => { stopped = true; if (timer) window.clearTimeout(timer); };
    }, [jobId]);

    useEffect(() => {
        const node = preRef.current;
        if (node && follow.current) node.scrollTop = node.scrollHeight;
    }, [data]);

    const text = [data?.stdout || '', data?.stderr ? `--- stderr ---\n${data.stderr}` : ''].filter(Boolean).join('\n');
    return (
        <div className="obs-live-log" data-testid={`live-log-${jobId}`}>
            <div className="hint">
                {data?.streaming ? <><span className="tool-spinner" aria-hidden="true" /> Live output</> : 'Output'}
                {data?.at ? ` · updated ${new Date(`${data.at.replace(' ', 'T')}Z`).toLocaleTimeString()}` : ''}
                {data?.bytes ? ` · ${(data.bytes / 1024).toFixed(1)} KB so far` : ''}
                {data && data.running && !data.streaming && !data.liveSupported
                    ? ' · live output is not available with a remote sandbox runner; it appears when the segment ends' : ''}
                {data && data.running && !data.streaming && data.liveSupported ? ' · waiting for output…' : ''}
                {error ? ` · ${error}` : ''}
            </div>
            {text && (
                <pre
                    ref={preRef}
                    className="obs-live-pre"
                    onScroll={(event) => {
                        const node = event.currentTarget;
                        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
                    }}
                >{text}</pre>
            )}
        </div>
    );
}

type JobChanges = { goodJobId: number | null; goodRev: string | null; failedRev: string | null };
type HistoryDiff = { label: string; empty: boolean; content: string; truncated?: boolean };

/**
 * What to do about a failed run: run the same code again, ask Goobster why
 * (pre-filled in the project chat), or see what changed in the workspace
 * between the last run that completed and this one (workspace snapshots).
 */
function FailedRunActions({ slug, ownerId, job, canRun, onChanged, askGoobster }: {
    slug: string;
    ownerId?: string | null;
    job: Job;
    canRun: boolean;
    onChanged: () => void;
    askGoobster?: (text: string) => void;
}) {
    const toast = useToast();
    const [showChanges, setShowChanges] = useState(false);
    const changes = useQuery({
        queryKey: ['job-changes', job.id],
        queryFn: () => api.observatoryJobChanges(job.id) as Promise<JobChanges>,
        enabled: showChanges,
        retry: false
    });
    const range = changes.data;
    const diff = useQuery({
        queryKey: ['job-changes-diff', job.id, range?.goodRev || '', range?.failedRev || ''],
        queryFn: () => api.projectHistoryDiff(slug, { rev: range?.goodRev, to: range?.failedRev || 'workspace' }, ownerId) as Promise<HistoryDiff>,
        enabled: Boolean(showChanges && range?.goodRev),
        retry: false
    });

    return (
        <div className="tool-card-actions" data-testid={`run-actions-${job.id}`}>
            {canRun && (
                <button type="button" className="btn small" onClick={async () => {
                    try {
                        const started = await api.observatoryRerunJob(job.id) as { id: number };
                        toast(`Started run #${started.id} with the same code.`);
                        onChanged();
                    } catch (error) { toast((error as Error).message, true); }
                }}>Run again</button>
            )}
            {askGoobster && (
                <button type="button" className="btn small" onClick={() => askGoobster(
                    `Run #${job.id} in this project ${job.status === 'TIMED_OUT' ? 'timed out' : 'failed'}`
                    + `${job.exitCode != null ? ` with exit ${job.exitCode}` : ''}. Read its output and what changed since the last good run, `
                    + 'find the cause, fix it, and run it again.'
                )}>Ask Goobster why</button>
            )}
            <button type="button" className="btn small subtle" onClick={() => setShowChanges((value) => !value)}>
                {showChanges ? 'Hide changes' : 'Changes since last good run'}
            </button>
            {showChanges && (
                <div className="obs-run-changes">
                    {changes.isPending && <div className="hint">Looking for the last good run…</div>}
                    {changes.isError && <div className="hint">{(changes.error as Error).message}</div>}
                    {range && !range.goodJobId && <div className="hint">No earlier run completed, so there is nothing to compare with.</div>}
                    {range && range.goodJobId && !range.goodRev && <div className="hint">Run #{range.goodJobId} completed, but no workspace snapshot was kept for it.</div>}
                    {range?.goodRev && (
                        <div className="hint">From run #{range.goodJobId} (completed) to {range.failedRev ? `run #${job.id}` : 'the workspace now'}:</div>
                    )}
                    {diff.isPending && range?.goodRev && <div className="hint">Loading the diff…</div>}
                    {diff.data && (diff.data.empty ? <div className="hint">No file changed between them.</div> : <DiffView text={diff.data.content} />)}
                    {diff.data?.truncated && <div className="hint">Diff truncated: Files → history has the rest.</div>}
                </div>
            )}
        </div>
    );
}

const CONTRACT_REASONS: Record<string, string> = {
    missing: 'missing',
    too_small: 'too small',
    invalid_json: 'invalid JSON',
    directory: 'is a directory',
    not_a_file: 'not a regular file',
    illegal_path: 'illegal path'
};

/**
 * The runs of one project (API: jobs), newest first, with cancel / resume
 * where legal. `limit` gives the Overview its short "latest runs" slice;
 * the Runs view shows them all.
 */
export function RunsList({
    slug, ownerId, jobs, limit, onChanged, emptyHint, askGoobster
}: {
    slug: string;
    ownerId?: string | null;
    jobs: Job[];
    limit?: number;
    onChanged: () => void;
    emptyHint?: string;
    /** Open the project chat with a request pre-filled (never sends). */
    askGoobster?: (text: string) => void;
}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const executionOn = featureActive(me, 'observatory');
    // Trigger names for run provenance ("started by trigger X"); shares the
    // Automations view's cache entry.
    const triggersQ = useQuery({
        queryKey: keys.projectTriggers(slug, ownerId),
        queryFn: () => api.projectTriggers(slug, ownerId) as Promise<{ triggers: Trigger[] }>,
        retry: false,
        enabled: jobs.some((j) => j.triggerId != null)
    });
    const triggerNames = new Map<number, string>(
        (triggersQ.data?.triggers || []).map((t) => [t.id, t.name] as const)
    );
    const shown = limit ? jobs.slice(0, limit) : jobs;

    if (jobs.length === 0) {
        return (
            <div className="empty" data-tour="project-runs-empty">
                {emptyHint || (executionOn
                    ? 'No runs yet — open the Conversation and ask Goobster to start one, or run a script from Files.'
                    : 'No runs yet. Code execution is off on this installation, so runs cannot start here; the project can still be organized.')}
            </div>
        );
    }

    return (
        <div className="list-card" data-tour="project-runs">
            {shown.map((job) => (
                <div key={job.id} className="list-row task-row" data-testid={`run-${job.id}`}>
                    <div className="row-body">
                        <span className="badge">{STATUS_ICONS[job.status] || ''} {job.status}</span>
                        <strong>Run #{job.id}</strong>
                        <div className="row-meta">
                            {[job.language, `${job.segments || 0} segment(s)`, `${job.resumeCount || 0} resume(s)`,
                                job.finishedAt ? `finished ${whenLabel(job.finishedAt)}` : `heartbeat ${whenLabel(job.lastHeartbeatAt)}`]
                                .filter(Boolean).join(' · ')}
                        </div>
                        {job.error ? <div className="row-meta obs-error">{job.error}</div> : null}
                        <RunProvenance job={job} triggers={triggerNames} />
                        {job.status === 'RUNNING' && <LiveLog jobId={job.id} />}
                        {job.stdoutTail?.trim() ? (
                            <details className="obs-tail"><summary>stdout tail</summary><pre>{job.stdoutTail}</pre></details>
                        ) : null}
                        {job.stderrTail?.trim() ? (
                            <details className="obs-tail"><summary>stderr tail</summary><pre>{job.stderrTail}</pre></details>
                        ) : null}
                        {(job.status === 'FAILED' || job.status === 'TIMED_OUT') && (
                            <FailedRunActions slug={slug} ownerId={ownerId} job={job} canRun={executionOn} onChanged={onChanged} askGoobster={askGoobster} />
                        )}
                    </div>
                    {job.status === 'RUNNING' && (
                        <button type="button" className="btn danger" onClick={async () => {
                            if (!await confirm(`Cancel run #${job.id}?`)) return;
                            try {
                                await api.observatoryCancelJob(job.id);
                                toast(`Run #${job.id} cancelled.`);
                                onChanged();
                            } catch (error) { toast((error as Error).message, true); }
                        }}>Cancel</button>
                    )}
                    {(job.status === 'INTERRUPTED' || job.status === 'TIMED_OUT') && (
                        <button
                            type="button"
                            className="btn"
                            title={executionOn ? 'Resume from the last checkpoint' : 'Code execution is off on this installation'}
                            disabled={!executionOn}
                            onClick={async () => {
                                try {
                                    await api.observatoryResumeJob(job.id);
                                    toast(`Run #${job.id} resumed.`);
                                    onChanged();
                                } catch (error) { toast((error as Error).message, true); }
                            }}
                        >Resume</button>
                    )}
                </div>
            ))}
        </div>
    );
}

/**
 * Expandable diagnostics for one run: stable error code, who started it
 * (and the upstream run an event stage reacted to), and the per-output
 * verdict of its frozen contract. Renders nothing for a plain ad-hoc run
 * with no contract, so the list stays quiet in the common case.
 */
export function RunProvenance({ job, triggers }: { job: Job; triggers: Map<number, string> }) {
    const contract = job.outputContractResult;
    const hasContract = Boolean(contract && Array.isArray(contract.checks) && contract.checks.length);
    const interesting = Boolean(
        (job.errorCode && job.errorCode !== 'EXIT_NONZERO')
        || job.parentJobId != null
        || job.triggerId != null
        || hasContract
    );
    if (!interesting) return null;
    const startedBy = job.startedBy === 'trigger' && job.triggerId != null
        ? `trigger “${triggers.get(job.triggerId) || `#${job.triggerId}`}”`
        : (job.startedBy || 'unknown');
    const failedChecks = hasContract ? contract!.checks.filter((c) => !c.ok).length : 0;
    const summaryBits = [
        job.errorCode && job.errorCode !== 'EXIT_NONZERO' ? job.errorCode : null,
        job.parentJobId != null ? `after run #${job.parentJobId}` : null,
        hasContract
            ? (contract!.ok
                ? `${contract!.checks.length} output(s) validated`
                : `${failedChecks} of ${contract!.checks.length} output(s) failed`)
            : null
    ].filter(Boolean);
    return (
        <details className="obs-tail obs-job-detail" data-testid={`job-detail-${job.id}`}>
            <summary>{summaryBits.length ? summaryBits.join(' · ') : 'details'}</summary>
            <dl className="obs-kv">
                {job.errorCode ? (<><dt>Error code</dt><dd><code>{job.errorCode}</code></dd></>) : null}
                <dt>Started by</dt><dd>{startedBy}</dd>
                {job.parentJobId != null ? (
                    <><dt>Source run</dt><dd>#{job.parentJobId} (this stage reacted to its settlement)</dd></>
                ) : null}
                {hasContract ? (
                    <>
                        <dt>Required outputs</dt>
                        <dd>
                            <ul className="obs-contract">
                                {contract!.checks.map((check) => (
                                    <li key={check.path} className={check.ok ? 'ok' : 'failed'}>
                                        {check.ok ? '✅' : '❌'} <code>{check.path}</code>
                                        {check.type && check.type !== 'file' ? ` · ${check.type}` : ''}
                                        {check.minBytes ? ` · ≥ ${check.minBytes} B` : ''}
                                        {check.ok
                                            ? (check.sizeBytes != null ? ` · ${check.sizeBytes} B` : '')
                                            : ` · ${CONTRACT_REASONS[check.reason || ''] || check.reason || 'failed'}`}
                                    </li>
                                ))}
                            </ul>
                            {contract!.checkedAt ? <div className="hint">checked {whenLabel(contract!.checkedAt)}</div> : null}
                        </dd>
                    </>
                ) : null}
            </dl>
        </details>
    );
}
