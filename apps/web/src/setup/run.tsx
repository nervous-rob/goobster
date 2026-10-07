import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import type { InstallOperation } from '../lib/types';
import { useTransport } from './transport';
import { describeError, Details, LiveRegion, stepLabel, StepList } from './ui';

export type RunPhase = 'loading' | 'ready' | 'running' | 'applied' | 'failed' | 'gone';

export type Run = {
    operation: InstallOperation | null;
    phase: RunPhase;
    reconnecting: boolean;
    error: { message: string; code: string; details: unknown } | null;
    start: () => void;
    starting: boolean;
    /** What the manager answered to the apply request: in memory only, gone after a reload (the journal never holds it). */
    result: Record<string, unknown> | null;
};

function phaseOf(operation: InstallOperation | null, loadError: unknown): RunPhase {
    if (!operation) return loadError instanceof ApiError && (loadError.status === 404 || loadError.code === 'NOT_FOUND') ? 'gone' : 'loading';
    switch (operation.status) {
    case 'applying': return 'running';
    case 'applied': return 'applied';
    case 'failed':
    case 'cancelled': return 'failed';
    default: return 'ready';
    }
}

/**
 * One operation, followed from its id (the URL carries it). The apply request
 * and the polling are separate on purpose: a reload, a dropped connection or a
 * restarting manager loses only the request, never the operation, and the next
 * poll finds it where it is.
 */
export function useRun(id: string): Run {
    const transport = useTransport();
    const client = useQueryClient();
    const [starting, setStarting] = useState(false);
    const [applyError, setApplyError] = useState<Run['error']>(null);
    const [result, setResult] = useState<Run['result']>(null);
    const query = useQuery({
        queryKey: ['setup', 'operation', id],
        queryFn: () => transport.operation(id),
        retry: false,
        enabled: id !== 'none',
        refetchInterval: (q) => {
            const status = q.state.data?.status;
            if (q.state.error instanceof ApiError && q.state.error.code === 'NETWORK') return 2000;
            return status === 'applying' || status === 'planned' ? 1000 : (status === 'validated' && starting ? 700 : false);
        },
        staleTime: 0
    });
    const operation = query.data ?? null;
    const phase = phaseOf(operation, query.error);
    const reconnecting = Boolean(query.error) && query.error instanceof ApiError && query.error.code === 'NETWORK';

    const start = useCallback(() => {
        if (starting) return;
        setStarting(true);
        setApplyError(null);
        transport.apply(id).then((applied) => {
            client.setQueryData(['setup', 'operation', id], applied.operation);
            setResult(applied.result);
        }).catch((error: unknown) => {
            if (error instanceof ApiError && error.code === 'NETWORK') return;
            const described = describeError(error);
            setApplyError(described);
            void client.invalidateQueries({ queryKey: ['setup', 'operation', id] });
        }).finally(() => setStarting(false));
    }, [client, id, starting, transport]);

    const error = applyError || (operation?.status === 'failed' && operation.error
        ? { message: operation.error.message, code: operation.error.code, details: null }
        : (query.error && !reconnecting && phase !== 'gone' ? describeError(query.error) : null));
    return { operation, phase, reconnecting, error, start, starting, result };
}

export function failedStepOf(operation: InstallOperation): string | null {
    const failed = operation.steps.find((step) => step.status === 'failed');
    return failed ? failed.name : null;
}

/** The last step that finished before an interruption or failure. */
export function lastDoneStep(operation: InstallOperation): string | null {
    const done = operation.steps.filter((step) => step.status === 'done' && step.name !== 'validate' && step.name !== 'recovered');
    return done.length > 0 ? done[done.length - 1].name : null;
}

/**
 * Per-step progress of a running operation: a live region announces the
 * current step, a reconnect banner covers a manager that is restarting, and a
 * failure says what finished, what did not, and what is kept.
 */
export function OperationProgress({ run, title, autoStart, kept, failureHelp, children }: {
    run: Run; title: string; autoStart?: boolean; kept?: ReactNode; failureHelp?: ReactNode; children?: ReactNode;
}) {
    const started = useRef(false);
    useEffect(() => {
        if (autoStart && run.phase === 'ready' && !started.current) {
            started.current = true;
            run.start();
        }
    }, [autoStart, run]);
    const operation = run.operation;
    const planned = operation ? (operation.plan.steps || []).map((step) => step.name) : [];
    const failedStep = operation ? failedStepOf(operation) : null;
    const lastDone = operation ? lastDoneStep(operation) : null;
    const interrupted = Boolean(operation?.steps.some((step) => step.name === 'recovered'));
    const current = operation && run.phase === 'running' ? planned.find((name) => !operation.steps.some((step) => step.name === name)) : null;

    return (
        <div data-testid="operation-progress" data-phase={run.phase} aria-busy={run.phase === 'running'}>
            <LiveRegion>
                {run.phase === 'running' && current ? `${title}: ${stepLabel(current)}.` : ''}
                {run.phase === 'applied' ? `${title}: finished.` : ''}
                {run.phase === 'failed' ? `${title}: failed${failedStep ? ` at ${stepLabel(failedStep)}` : ''}.` : ''}
            </LiveRegion>
            {run.reconnecting && (
                <p className="wizard-callout" role="status" data-testid="reconnecting">
                    <strong>Reconnecting…</strong> The manager did not answer. If it is restarting this clears by itself; this page keeps trying and needs no reload.
                </p>
            )}
            {run.phase === 'loading' && !run.reconnecting && <p role="status" className="hint">Looking for the operation…</p>}
            {run.phase === 'gone' && (
                <p role="alert" className="settings-danger" data-testid="operation-gone">
                    The manager no longer knows this operation (it may have restarted before the operation was recorded). Go back and plan it again.
                </p>
            )}
            {run.phase === 'ready' && !autoStart && (
                <p><button type="button" className="btn primary" onClick={run.start} disabled={run.starting} data-testid="operation-start">Start</button></p>
            )}
            {run.phase === 'ready' && autoStart && <p role="status" className="hint">Starting…</p>}
            {operation && planned.length > 0 && (
                <StepList planned={planned} done={operation.steps} status={operation.status} failedStep={failedStep} />
            )}
            {run.phase === 'applied' && <p role="status" className="wizard-success" data-testid="operation-applied">Finished.</p>}
            {run.phase === 'failed' && (
                <div className="wizard-errors" role="alert" data-testid="operation-failed">
                    <strong>{interrupted ? 'This was interrupted.' : `${title} did not finish.`}</strong>
                    <p>{run.error?.message || 'The manager reported a failure.'}</p>
                    {lastDone && <p>The last step that finished was <em>{stepLabel(lastDone)}</em>{failedStep ? `; it stopped at ${stepLabel(failedStep)}` : ''}.</p>}
                    {interrupted && <p>The manager restarted while this was running, so it stopped at the last durable step.</p>}
                    {kept && <p data-testid="what-was-kept">{kept}</p>}
                    {failureHelp}
                    <Details code={run.error?.code} details={run.error?.details} />
                </div>
            )}
            {run.phase !== 'failed' && run.error && <p role="alert" className="settings-danger">{run.error.message}</p>}
            {children}
        </div>
    );
}
