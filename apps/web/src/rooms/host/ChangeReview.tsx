import { useEffect, useState } from 'react';
import type { HostPlanChange } from '../../lib/types';
import { DocLink } from './shared';
import { GRACE_SECONDS, needsRestart, type ChangeState, type useChange } from './useChange';

type Change = ReturnType<typeof useChange>;

function describeChange(change: HostPlanChange, label: (id: string) => string): string {
    if (typeof change.to === 'boolean') {
        const name = label(change.id);
        return change.to ? `Turn on ${name}` : `Turn off ${name}`;
    }
    const name = label(change.id);
    if (change.action === 'remove') return change.secret ? `Remove the saved ${name}` : `Remove ${name}`;
    if (change.secret) return `Replace ${name}`;
    return `Set ${name}${change.value === undefined ? '' : ` to ${JSON.stringify(change.value)}`}`;
}

function failureText(state: Extract<ChangeState, { phase: 'failed' }>): string {
    if (state.stale) return 'Someone changed this while you were reviewing it. The page was reloaded with the current state; review it again.';
    return state.failure.message;
}

/**
 * The preview (the manager's exact plan), the Apply button and the result.
 * The preview applies nothing. Results and errors are announced
 * (`aria-live`), and a restart is scheduled only when the box is ticked.
 */
export function ChangeReview({ change, label, supervising, testId }: {
    change: Change;
    label: (id: string) => string;
    supervising: boolean;
    testId: string;
}) {
    const { state } = change;
    const [schedule, setSchedule] = useState(supervising);
    useEffect(() => { if (state.phase === 'ready') setSchedule(supervising); }, [state.phase, supervising]);

    if (state.phase === 'idle') return <div aria-live="polite" role="status" data-testid={`${testId}-live`} />;
    if (state.phase === 'previewing') return <p role="status" aria-live="polite" className="hint">Checking the change with the manager…</p>;

    if (state.phase === 'failed') {
        return (
            <div className="list-card" role="alert" data-testid={`${testId}-error`} data-code={state.failure.code}>
                <div className="list-row"><span className="settings-danger"><strong>{failureText(state)}</strong></span></div>
                {state.failure.code === 'MAIL_REQUIRED_FOR_REGISTRATION' && (
                    <div className="list-row"><span className="hint">Change <code>identity.registration</code> on the Connections page first, then come back.</span></div>
                )}
                {state.failure.code === 'DEPENDENCY_CONFLICT' && (
                    <div className="list-row"><span className="hint">A feature cannot be on while something it needs is off. Turn the dependency on in the same change, or first.</span></div>
                )}
                {state.failure.code === 'FEATURE_NOT_INSTALLED' && (
                    <div className="list-row"><span className="hint">This installation does not include that feature. <DocLink slug="packaging">How payloads are selected</DocLink></span></div>
                )}
                {state.failure.code === 'MANAGER_BRIDGE_REFUSED' && (
                    <div className="list-row"><span className="hint">Restart the portal so it reads the manager&apos;s current key. <DocLink slug="host-operations" hash="manager-unavailable">Manager unavailable</DocLink></span></div>
                )}
                <div className="list-row"><button type="button" className="btn small" onClick={change.reset}>Dismiss</button></div>
            </div>
        );
    }

    const preview = state.preview;
    const plan = preview.operation.plan;
    const changes = plan.changes || [];
    const warnings = [...(plan.warnings || []), ...preview.preview.warnings];

    if (state.phase === 'applied') {
        const restart = needsRestart(state.kind, state.applied);
        return (
            <div className="list-card" role="status" aria-live="polite" data-testid={`${testId}-applied`}>
                <div className="list-row"><span><strong>Applied.</strong> {changes.length} change{changes.length === 1 ? '' : 's'} saved through the manager.</span></div>
                {restart && !state.scheduled && (
                    <div className="list-row"><span>The change is <strong>pending</strong>: it takes effect when the workers restart. Schedule the restart from the Restart panel when you are ready.</span></div>
                )}
                {state.scheduled && (
                    <div className="list-row"><span>A restart is scheduled in {GRACE_SECONDS} seconds. Watch it, skip the wait or cancel it in the Restart panel.</span></div>
                )}
                {state.scheduleError && (
                    <div className="list-row" role="alert"><span className="settings-danger">The change was saved, but the restart could not be scheduled: {state.scheduleError.message}</span></div>
                )}
                {!restart && state.kind !== 'lifecycle.apply' && <div className="list-row"><span className="hint">Nothing needs a restart.</span></div>}
                <div className="list-row"><button type="button" className="btn small" onClick={change.reset}>Done</button></div>
            </div>
        );
    }

    const busy = state.phase === 'applying';
    return (
        <div className="list-card" data-testid={`${testId}-preview`} aria-busy={busy}>
            <div className="list-row"><span><strong>Review this change</strong> <span className="hint">Nothing has been applied yet.</span></span></div>
            {changes.map((entry) => (
                <div key={entry.id} className="list-row" data-testid={`${testId}-change`} data-id={entry.id}>
                    <span>{describeChange(entry, label)}</span>
                    {entry.ineffective && <span className="hint">The environment controls this, so it will have no effect.</span>}
                </div>
            ))}
            {plan.attestation && (
                <div className="list-row"><span className="hint">Attested by you: {plan.attestation.text}</span></div>
            )}
            {warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`} className="list-row" role="note" data-testid={`${testId}-warning`}>
                    <span className="hint">{warning.message || warning.code}</span>
                </div>
            ))}
            <div className="list-row">
                <span className="hint">
                    {preview.preview.restartRequired
                        ? 'This takes effect after a restart; until then the change shows as pending.'
                        : 'This takes effect immediately.'}
                </span>
            </div>
            {preview.preview.restartRequired && (
                <div className="list-row">
                    <label>
                        <input type="checkbox" checked={schedule} onChange={(event) => setSchedule(event.target.checked)} disabled={busy || !supervising} data-testid={`${testId}-schedule`} />
                        {' '}Schedule the restart ({GRACE_SECONDS} second countdown)
                    </label>
                    {!supervising && <span className="hint">The manager is not supervising workers here, so restart them yourself when ready.</span>}
                </div>
            )}
            <div className="list-row" style={{ gap: 8 }}>
                <button type="button" className="btn primary" disabled={busy} data-testid={`${testId}-apply`}
                    onClick={() => void change.apply({ schedule: schedule && supervising })}>
                    {busy ? 'Applying…' : 'Apply'}
                </button>
                <button type="button" className="btn subtle" disabled={busy} onClick={change.reset} data-testid={`${testId}-discard`}>Discard</button>
            </div>
        </div>
    );
}
