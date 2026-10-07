import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { HostApplied, HostOperationKind, HostPreview } from '../../lib/types';
import { failureOf, HOST_KEYS, type HostFailure } from './shared';

export const GRACE_SECONDS = 60;

export type ChangeState =
    | { phase: 'idle' }
    | { phase: 'previewing' }
    | { phase: 'ready'; kind: HostOperationKind; preview: HostPreview }
    | { phase: 'applying'; kind: HostOperationKind; preview: HostPreview }
    | { phase: 'applied'; kind: HostOperationKind; preview: HostPreview; applied: HostApplied; scheduled: boolean; scheduleError: HostFailure | null }
    | { phase: 'failed'; failure: HostFailure; stale: boolean };

/** Whether the applied change waits for a restart (features pending, config fields that read at start). */
export function needsRestart(kind: HostOperationKind, applied: HostApplied): boolean {
    const result = applied.result || {};
    if (kind === 'features.set') return (result.pending || []).length > 0;
    if (kind === 'config.set') return (result.restartRequired || []).length > 0;
    return false;
}

/**
 * One preview, apply and optional restart-schedule flow. The preview is the
 * manager's plan and applies nothing; apply runs exactly that operation. A
 * stale revision (409 REVISION_CONFLICT) refetches the page's data and says
 * so; nothing is ever overwritten.
 */
export function useChange(onSettled?: () => void) {
    const queryClient = useQueryClient();
    const [state, setState] = useState<ChangeState>({ phase: 'idle' });

    const refresh = useCallback(async () => {
        await Promise.all(Object.values(HOST_KEYS).map((key) => queryClient.invalidateQueries({ queryKey: key })));
        onSettled?.();
    }, [queryClient, onSettled]);

    const preview = useCallback(async (kind: HostOperationKind, input: unknown): Promise<boolean> => {
        setState({ phase: 'previewing' });
        try {
            const result = await api.hostPreview(kind, input);
            setState({ phase: 'ready', kind, preview: result });
            return true;
        } catch (error) {
            const failure = failureOf(error);
            const stale = failure.code === 'REVISION_CONFLICT';
            setState({ phase: 'failed', failure, stale });
            if (stale) await refresh();
            return false;
        }
    }, [refresh]);

    const apply = useCallback(async ({ schedule }: { schedule: boolean }) => {
        if (state.phase !== 'ready') return;
        const { kind, preview: planned } = state;
        setState({ phase: 'applying', kind, preview: planned });
        let applied: HostApplied;
        try {
            applied = await api.hostApply(planned.operation.id);
        } catch (error) {
            const failure = failureOf(error);
            const stale = failure.code === 'REVISION_CONFLICT';
            setState({ phase: 'failed', failure, stale });
            await refresh();
            return;
        }
        let scheduled = false;
        let scheduleError: HostFailure | null = null;
        if (schedule && needsRestart(kind, applied)) {
            try {
                const plan = await api.hostPreview('lifecycle.apply', { changeRef: planned.operation.id, graceSeconds: GRACE_SECONDS });
                await api.hostApply(plan.operation.id);
                scheduled = true;
            } catch (error) {
                scheduleError = failureOf(error);
            }
        }
        setState({ phase: 'applied', kind, preview: planned, applied, scheduled, scheduleError });
        await refresh();
    }, [state, refresh]);

    const reset = useCallback(() => setState({ phase: 'idle' }), []);

    return { state, preview, apply, reset };
}
