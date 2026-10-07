import { useCallback, useState, type ReactNode } from 'react';
import type { InstallOperation } from '../../lib/types';
import { useTransport } from '../transport';
import { describeError, Details, ErrorSummary, Findings, type Problem } from '../ui';

export type PlanPhase =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'ready'; operation: InstallOperation }
    | { kind: 'failed'; message: string; code: string; details: unknown; operation: InstallOperation | null };

/** Plan and validate one install kind; nothing is applied. */
export function usePlanCheck(kind: string) {
    const transport = useTransport();
    const [phase, setPhase] = useState<PlanPhase>({ kind: 'idle' });
    const check = useCallback(async (input: unknown): Promise<InstallOperation | null> => {
        setPhase({ kind: 'checking' });
        try {
            const { operation } = await transport.preview(kind, input);
            setPhase({ kind: 'ready', operation });
            return operation;
        } catch (error) {
            const described = describeError(error);
            const operation = (described.details as { operation?: InstallOperation } | null)?.operation || null;
            setPhase({ kind: 'failed', message: described.message, code: described.code, details: described.details, operation });
            return null;
        }
    }, [kind, transport]);
    const reset = useCallback(() => setPhase({ kind: 'idle' }), []);
    return { phase, check, reset };
}

export function PlanFailure({ phase, help }: { phase: Extract<PlanPhase, { kind: 'failed' }>; help?: ReactNode }) {
    const problems: Problem[] = [{ message: phase.message }];
    return (
        <div data-testid="plan-failure" data-code={phase.code}>
            <ErrorSummary problems={problems} title="This cannot be done yet" />
            {phase.operation?.plan.preflight && <Findings findings={phase.operation.plan.preflight.findings} />}
            {help}
            <Details code={phase.code} details={phase.details} />
        </div>
    );
}

export function JourneyFrame({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="wizard-journey" data-testid="journey">
            <p className="wizard-crumbs"><a href="#/maintain" data-testid="back-to-maintain">Installation</a> › {title}</p>
            {children}
        </div>
    );
}
