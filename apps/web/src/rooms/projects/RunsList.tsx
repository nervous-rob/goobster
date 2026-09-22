import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { whenLabel } from '../observatory/format';
import { STATUS_ICONS, type Job } from './types';
import type { Trigger } from './AutomationsTab';

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
    slug, ownerId, jobs, limit, onChanged, emptyHint
}: {
    slug: string;
    ownerId?: string | null;
    jobs: Job[];
    limit?: number;
    onChanged: () => void;
    emptyHint?: string;
}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const executionOn = Boolean(me.features?.observatory);
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
                        {job.stdoutTail?.trim() ? (
                            <details className="obs-tail"><summary>stdout tail</summary><pre>{job.stdoutTail}</pre></details>
                        ) : null}
                        {job.stderrTail?.trim() ? (
                            <details className="obs-tail"><summary>stderr tail</summary><pre>{job.stderrTail}</pre></details>
                        ) : null}
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
