import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { HostLifecycleWorker } from '../lib/types';
import { MINT_RECOVERY } from './commands';
import { KEYS, useSuggest } from './data';
import { useTransport, type FirstRun } from './transport';
import { describeError, LiveRegion } from './ui';

export type WorkerStage = 'starting' | 'acknowledged' | 'healthy' | 'failed' | 'stopped';

export function stageOf(worker: HostLifecycleWorker, current: number): WorkerStage {
    if (['crash-loop', 'exited', 'backoff', 'conflict'].includes(worker.state)) return 'failed';
    if (worker.state === 'stopped' || worker.state === 'stopping') return 'stopped';
    const acked = worker.ackedRevision !== null && worker.ackedRevision >= current;
    if (worker.healthy === true && acked) return 'healthy';
    if (worker.state === 'running' && acked) return 'acknowledged';
    return 'starting';
}

const STAGE_TEXT: Record<WorkerStage, string> = {
    starting: 'Starting…',
    acknowledged: 'Running; checking that it answers…',
    healthy: 'Healthy',
    failed: 'Failed',
    stopped: 'Not running'
};

export function WorkerRows({ workers, current }: { workers: HostLifecycleWorker[]; current: number }) {
    if (workers.length === 0) return <p className="hint" data-testid="no-workers">Nothing is running yet.</p>;
    return (
        <ul className="list-card wizard-workers" style={{ listStyle: 'none', padding: 0 }} data-testid="worker-rows">
            {workers.map((worker) => {
                const stage = stageOf(worker, current);
                return (
                    <li key={worker.name} className="list-row" data-testid="worker-row" data-worker={worker.name} data-stage={stage}>
                        <span><strong>{worker.name}</strong> <span className={`badge ${stage === 'healthy' ? 'state-verified' : (stage === 'failed' ? 'state-revoked' : 'state-unverified')}`}>{STAGE_TEXT[stage]}</span></span>
                        {stage === 'failed' && (
                            <span className="settings-danger" data-testid="worker-failure">
                                It stopped{worker.lastExit && worker.lastExit.code !== undefined && worker.lastExit.code !== null ? ` with exit code ${worker.lastExit.code}` : ''}
                                {worker.lastExit?.signal ? ` (signal ${worker.lastExit.signal})` : ''}{worker.crashLoop ? ' and keeps stopping' : ''}.
                            </span>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

export function RecoveryInfo({ logs }: { logs?: string }) {
    return (
        <div className="wizard-callout" data-testid="recovery-info">
            <p><strong>What was kept:</strong> your data, your settings file and the manager&apos;s records are untouched; only the running programs failed.</p>
            <p><strong>Where to look:</strong> each process writes what it did to the logs folder{logs ? <> (<code>{logs}</code>)</> : ''}; the last lines say why it stopped.</p>
            <p><strong>If you cannot sign in:</strong> on this machine run <code>{MINT_RECOVERY}</code> and use the credential on the recovery page of this manager.</p>
        </div>
    );
}

/**
 * The first-run check and the per-worker state, polled until everything
 * passes. A process that was merely started is never reported as working:
 * "healthy" means it acknowledged the current revision and answered its
 * health check.
 */
export function HealthPanel({ onResult, canStart = true }: { onResult?: (result: FirstRun | null) => void; canStart?: boolean }) {
    const transport = useTransport();
    const client = useQueryClient();
    const suggest = useSuggest();
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);
    const firstRun = useQuery({
        queryKey: KEYS.firstRun,
        queryFn: async () => {
            const result = await transport.firstRun();
            onResult?.(result);
            return result;
        },
        retry: false,
        refetchInterval: (query) => (query.state.data?.ok ? false : 2000)
    });
    const lifecycle = useQuery({
        queryKey: KEYS.lifecycle,
        queryFn: () => transport.lifecycle(),
        retry: false,
        refetchInterval: (query) => (firstRun.data?.ok && query.state.data?.workers.every((worker) => worker.healthy === true) ? false : 1500)
    });
    const result = firstRun.data;
    const workers = lifecycle.data?.workers || [];
    const supervising = lifecycle.data?.supervising === true;
    const failed = workers.some((worker) => stageOf(worker, lifecycle.data?.current ?? 0) === 'failed');

    async function start() {
        setStarting(true);
        setStartError(null);
        try {
            const planned = await transport.preview('lifecycle.start', undefined);
            await transport.apply(planned.operation.id);
        } catch (error) {
            setStartError(describeError(error).message);
        } finally {
            setStarting(false);
            await client.invalidateQueries({ queryKey: KEYS.lifecycle });
            await client.invalidateQueries({ queryKey: KEYS.firstRun });
        }
    }

    const spoken = result ? (result.ok ? 'Everything checked out.' : `${result.checks.filter((check) => !check.ok).length} check${result.checks.filter((check) => !check.ok).length === 1 ? '' : 's'} still failing.`) : '';
    return (
        <div data-testid="health-panel" data-ok={result?.ok === true}>
            <LiveRegion>{spoken}</LiveRegion>
            {(firstRun.isError || lifecycle.isError) && (
                <p className="wizard-callout" role="status" data-testid="health-reconnecting">
                    <strong>Reconnecting…</strong> {describeError(firstRun.error || lifecycle.error).message}
                </p>
            )}
            <h3 className="section-title">Application processes</h3>
            <WorkerRows workers={workers} current={lifecycle.data?.current ?? 0} />
            {!supervising && canStart && (
                <p>
                    <button type="button" className="btn" onClick={() => void start()} disabled={starting} data-testid="start-workers">{starting ? 'Starting…' : 'Start Goobster'}</button>
                    {startError && <span role="alert" className="settings-danger"> {startError}</span>}
                </p>
            )}
            <h3 className="section-title">Checks</h3>
            {!result && <p role="status" className="hint">Checking…</p>}
            {result && (
                <ul className="list-card wizard-checks" style={{ listStyle: 'none', padding: 0 }} data-testid="first-run-checks">
                    {result.checks.map((check) => (
                        <li key={check.id} className="list-row" data-testid="first-run-check" data-check={check.id} data-ok={check.ok}
                            style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                            <span>
                                <span className={`badge ${check.ok ? 'state-verified' : 'state-revoked'}`}>{check.ok ? 'Passed' : 'Not yet'}</span>
                                {' '}<strong>{check.label}</strong> <span className="hint">{check.detail}</span>
                            </span>
                            {!check.ok && check.hint && <span className="hint" data-testid="check-hint">{check.hint}</span>}
                        </li>
                    ))}
                </ul>
            )}
            {failed && <RecoveryInfo logs={suggest.data?.roots.logs.path} />}
            <p>
                <button type="button" className="btn small" data-testid="check-again"
                    onClick={() => { void client.invalidateQueries({ queryKey: KEYS.firstRun }); void client.invalidateQueries({ queryKey: KEYS.lifecycle }); }}>Check again</button>
            </p>
        </div>
    );
}
