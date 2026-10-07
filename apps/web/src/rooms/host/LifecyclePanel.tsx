import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { useDateLabel } from '../../hooks/useDateLabel';
import type { HostLifecycle } from '../../lib/types';
import { DocLink, failureOf, HOST_KEYS } from './shared';

const OUTCOME_LABEL: Record<string, string> = {
    applied: 'Applied',
    rolled_back: 'Rolled back',
    failed: 'Failed',
    cancelled: 'Cancelled'
};

const EVENT_LABEL: Record<string, string> = {
    committed: 'Restart started',
    'restart-now': 'Countdown skipped',
    promoted: 'New revision promoted',
    'rolled-back': 'Rolled back to the previous revision',
    failed: 'Restart failed',
    expired: 'Countdown expired',
    resumed: 'Restart resumed after the manager started',
    'forced-stop': 'Worker stopped by force',
    'crash-loop': 'Crash loop'
};

/** Next poll: quick while something is changing, slow when idle, and backing off while the portal or manager is away. */
function pollInterval(data: HostLifecycle | undefined, failures: number): number {
    if (failures > 0) return Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
    if (!data) return 5_000;
    if (data.pending || data.committing) return 2_000;
    return 10_000;
}

/** Seconds left, counted from the server's value at the moment it was read. */
function useSecondsLeft(secondsLeft: number | undefined, readAt: number): number | null {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (secondsLeft === undefined) return undefined;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [secondsLeft]);
    if (secondsLeft === undefined) return null;
    return Math.max(0, secondsLeft - Math.floor((now - readAt) / 1_000));
}

/**
 * The restart panel: the manager's staged-restart state (countdown,
 * per-worker state and acknowledged revision, last outcome, recent events)
 * with Restart now, Cancel and Restart workers. The countdown is re-synced
 * from the server on every poll; the page's own ticker only fills the
 * seconds between polls. When the portal itself restarts (the single-process
 * layout) polling backs off and resumes with no reload.
 */
export function LifecyclePanel({ title = 'Restart', enabled = true }: { title?: string; enabled?: boolean }) {
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const query = useQuery({
        queryKey: HOST_KEYS.lifecycle,
        queryFn: () => api.hostLifecycle(),
        enabled,
        retry: false,
        refetchInterval: (q) => pollInterval(q.state.data, q.state.fetchFailureCount)
    });
    const data = query.data;
    const pending = data?.pending || null;
    const left = useSecondsLeft(pending?.phase === 'countdown' ? pending.secondsLeft : undefined, query.dataUpdatedAt);
    const reconnecting = query.isError;

    const spoken = pending
        ? (pending.phase === 'countdown' && left !== null
            ? `Restart in about ${Math.max(10, Math.ceil(left / 10) * 10)} seconds.`
            : 'Restarting now. Workers are draining and starting again.')
        : '';

    async function act(action: 'restart-now' | 'cancel' | 'restart', question: string | null, done: string) {
        if (question && !await confirm(question)) return;
        setBusy(action);
        try {
            await api.hostLifecycleAction(action);
            toast(done);
        } catch (error) {
            toast(failureOf(error).message, true);
        } finally {
            setBusy(null);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: HOST_KEYS.lifecycle }),
                queryClient.invalidateQueries({ queryKey: HOST_KEYS.features }),
                queryClient.invalidateQueries({ queryKey: HOST_KEYS.audit })
            ]);
        }
    }

    return (
        <section className="settings-section" aria-labelledby="host-restart-title" data-testid="host-lifecycle">
            <h2 id="host-restart-title">{title}</h2>
            <p className="hint">
                A feature change, and settings that are read at start, take effect when the workers restart. The countdown gives people notice;
                you can skip it or cancel it until the workers are told to stop. <DocLink slug="host-operations">How restarts work</DocLink>
            </p>
            {query.isPending && <div className="hint" role="status">Loading…</div>}
            {reconnecting && (
                <div className="list-card" role="status" data-testid="host-reconnecting">
                    <div className="list-row"><span><strong>Reconnecting…</strong> <span className="hint">The portal or the manager is restarting. This page keeps trying and needs no reload.</span></span></div>
                </div>
            )}
            <div className="sr-only" aria-live="polite" role="status" data-testid="host-lifecycle-live">{spoken}</div>
            {data && (
                <div className="list-card">
                    <div className="list-row">
                        <span>Supervision</span>
                        <span>{data.supervising
                            ? <><strong>On</strong><span className="hint"> · {data.mode === 'external' ? 'workers run under another supervisor' : 'the manager starts the workers'}{data.layout ? ` · ${data.layout}` : ''}</span></>
                            : <><strong>Off</strong><span className="hint"> · the manager is not supervising workers, so restart them yourself after a change</span></>}</span>
                    </div>
                    <div className="list-row"><span>Running revision</span><span data-testid="host-revision">{data.current}</span></div>
                    <div className="list-row" data-testid="host-pending">
                        <span>Scheduled restart</span>
                        <span>
                            {!pending && <strong>None</strong>}
                            {pending?.phase === 'countdown' && (
                                <><strong data-testid="host-countdown" aria-hidden="true">{left ?? '…'} s</strong><span className="hint"> · to revision {pending.revision}</span></>
                            )}
                            {pending && pending.phase !== 'countdown' && <strong data-testid="host-committing">Restarting now, to revision {pending.revision}</strong>}
                        </span>
                    </div>
                    <div className="list-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <button type="button" className="btn small primary" data-testid="host-restart-now"
                            disabled={!pending || pending.phase !== 'countdown' || busy !== null}
                            onClick={() => void act('restart-now', 'Skip the countdown and restart now? Work in progress gets its short drain window first.', 'Restarting now.')}>
                            Restart now
                        </button>
                        <button type="button" className="btn small" data-testid="host-cancel-restart"
                            disabled={!pending || pending.phase !== 'countdown' || busy !== null}
                            onClick={() => void act('cancel', null, 'The scheduled restart was cancelled. The change stays pending.')}>
                            Cancel the restart
                        </button>
                        <button type="button" className="btn small" data-testid="host-restart-workers"
                            disabled={!data.supervising || data.committing || busy !== null}
                            onClick={() => void act('restart', 'Restart every worker at the current revision? This also clears a crash loop.', 'Restarting the workers.')}>
                            Restart workers
                        </button>
                    </div>
                    {data.lastOutcome && (
                        <div className="list-row" data-testid="host-last-outcome" data-outcome={data.lastOutcome.outcome}>
                            <span>Last restart</span>
                            <span>
                                <strong>{OUTCOME_LABEL[data.lastOutcome.outcome] || data.lastOutcome.outcome}</strong>
                                <span className="hint"> · revision {data.lastOutcome.revision}{data.lastOutcome.code ? ` · ${data.lastOutcome.code}` : ''}{data.lastOutcome.at ? ` · ${whenLabel(data.lastOutcome.at)}` : ''}</span>
                                {data.lastOutcome.outcome === 'rolled_back' && <span className="hint"> · the previous revision is running again</span>}
                            </span>
                        </div>
                    )}
                    {data.layoutError && <div className="list-row" role="alert"><span className="settings-danger">Layout problem: {data.layoutError}</span></div>}
                    {data.stateProblem && <div className="list-row" role="alert"><span className="settings-danger">The restart state file cannot be read ({data.stateProblem}); staged restarts are refused until it is fixed.</span></div>}
                </div>
            )}
            {data && data.workers.length > 0 && (
                <div className="list-card" data-testid="host-workers">
                    {data.workers.map((worker) => (
                        <div key={worker.name} className="list-row" data-testid="host-worker" data-worker={worker.name}>
                            <span><strong>{worker.name}</strong> <span className="hint">{worker.state}{worker.healthy === false ? ' · not healthy' : ''}</span></span>
                            <span className="hint">
                                revision {worker.revision ?? '-'} · acknowledged {worker.ackedRevision ?? '-'}
                                {worker.restarts ? ` · ${worker.restarts} restart${worker.restarts === 1 ? '' : 's'}` : ''}
                                {worker.crashLoop ? ' · crash loop' : ''}{worker.code ? ` · ${worker.code}` : ''}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {data && data.events.length > 0 && (
                <details>
                    <summary>Recent events</summary>
                    <div className="list-card">
                        {[...data.events].reverse().slice(0, 12).map((event, index) => (
                            <div key={`${event.at}-${index}`} className="list-row">
                                <span>{EVENT_LABEL[event.type] || event.type}{event.worker ? ` · ${event.worker}` : ''}{event.code ? ` · ${event.code}` : ''}</span>
                                <span className="hint">{event.revision !== undefined ? `revision ${event.revision} · ` : ''}{whenLabel(event.at)}</span>
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </section>
    );
}
