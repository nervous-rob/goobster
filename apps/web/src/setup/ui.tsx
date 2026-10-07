import { useEffect, useRef, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import type { InstallFinding, InstallStepRecord } from '../lib/types';
import { failureOf } from '../rooms/host/shared';

export function formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export type Problem = { field?: string; message: string; href?: string };

/** A readable sentence for an error, plus the code kept for the "details" fold. */
export function describeError(error: unknown): { message: string; code: string; details: unknown } {
    const failure = failureOf(error);
    return { message: failure.message, code: failure.code, details: failure.details };
}

export function isSessionProblem(error: unknown): boolean {
    return error instanceof ApiError && (error.code === 'SESSION_INVALID' || error.code === 'UNAUTHENTICATED');
}

/** Moves keyboard focus to the step's heading when the step changes, so a screen reader announces it. */
export function StepFrame({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [id]);
    return (
        <section className="wizard-step" aria-labelledby={`step-${id}-title`} data-testid={`step-${id}`}>
            <h2 id={`step-${id}-title`} ref={heading} tabIndex={-1}>{title}</h2>
            {lead && <p className="wizard-lead">{lead}</p>}
            {children}
        </section>
    );
}

/** The list at the top of a step that names what is wrong and links to the field. */
export function ErrorSummary({ problems, title = 'Fix these before you continue' }: { problems: Problem[]; title?: string }) {
    const box = useRef<HTMLDivElement>(null);
    const signature = problems.map((problem) => `${problem.field || ''}:${problem.message}`).join('|');
    useEffect(() => { if (problems.length > 0) box.current?.focus({ preventScroll: false }); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
    if (problems.length === 0) return null;
    return (
        <div className="wizard-errors" role="alert" tabIndex={-1} ref={box} data-testid="error-summary">
            <strong>{title}</strong>
            <ul>
                {problems.map((problem, index) => (
                    <li key={`${problem.field || 'general'}-${index}`}>
                        {problem.href
                            ? <a href={problem.href}>{problem.message}</a>
                            : problem.field
                            ? <a href={`#${problem.field}`} onClick={(event) => {
                                const target = document.getElementById(problem.field as string);
                                if (target) { event.preventDefault(); target.focus(); target.scrollIntoView?.({ block: 'center' }); }
                            }}>{problem.message}</a>
                            : problem.message}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function Details({ code, details, summary = 'Details for support' }: { code?: string; details?: unknown; summary?: string }) {
    if (!code && !details) return null;
    return (
        <details className="wizard-details">
            <summary>{summary}</summary>
            {code && <div>Code: <code>{code}</code></div>}
            {details ? <pre>{JSON.stringify(details, null, 2).slice(0, 1500)}</pre> : null}
        </details>
    );
}

export function StepNav({ onBack, backLabel = 'Back', onNext, nextLabel = 'Continue', nextDisabled, busy, extra }: {
    onBack?: () => void; backLabel?: string; onNext?: () => void; nextLabel?: string; nextDisabled?: boolean; busy?: boolean; extra?: ReactNode;
}) {
    return (
        <div className="wizard-nav">
            {onBack && <button type="button" className="btn" onClick={onBack} data-testid="nav-back">{backLabel}</button>}
            {extra}
            {onNext && (
                <button type="button" className="btn primary" onClick={onNext} disabled={nextDisabled || busy} data-testid="nav-next">
                    {busy ? 'Working…' : nextLabel}
                </button>
            )}
        </div>
    );
}

const SEVERITY_LABEL: Record<string, string> = { block: 'Blocks the install', warn: 'Worth knowing', info: 'Note' };

export function Findings({ findings }: { findings: InstallFinding[] }) {
    if (findings.length === 0) return <p className="hint" data-testid="no-findings">The manager found nothing that stops this.</p>;
    return (
        <ul className="wizard-findings" data-testid="findings">
            {findings.map((finding, index) => (
                <li key={`${finding.code}-${index}`} data-severity={finding.severity} data-code={finding.code}>
                    <span className={`badge ${finding.severity === 'block' ? 'state-revoked' : (finding.severity === 'warn' ? 'state-unverified' : '')}`}>{SEVERITY_LABEL[finding.severity] || finding.severity}</span>
                    {' '}{finding.detail}
                    <span className="sr-only"> ({finding.code})</span>
                </li>
            ))}
        </ul>
    );
}

const STEP_LABEL: Record<string, string> = {
    preflight: 'Check the machine', stage: 'Copy the program files', verify: 'Verify the files', ownership: 'Record what is owned',
    'init-db': 'Create the database', 'write-config': 'Write the settings', 'write-features': 'Save the feature choice',
    activate: 'Switch to the new version', 'register-service': 'Register as a service', finalize: 'Finish',
    record: 'Update the record', 'retire-old': 'Retire the old version', 'unregister-service': 'Unregister the service',
    tombstone: 'Leave a marker', 'remove-code': 'Remove the program files', 'remove-data': 'Remove the data', 'remove-ownership': 'Remove the record'
};

export function stepLabel(name: string): string {
    return STEP_LABEL[name] || name;
}

/** The plan's steps with what the manager has recorded for each. */
export function StepList({ planned, done, status, failedStep }: { planned: string[]; done: InstallStepRecord[]; status: string; failedStep?: string | null }) {
    const byName = new Map(done.map((step) => [step.name, step]));
    const firstOpen = planned.findIndex((name) => !byName.has(name));
    return (
        <ol className="wizard-steps" data-testid="step-list">
            {planned.map((name, index) => {
                const record = byName.get(name);
                const state = record
                    ? (record.status === 'failed' ? 'failed' : 'done')
                    : (failedStep === name ? 'failed' : (status === 'applying' && index === firstOpen ? 'running' : (status === 'applied' ? 'skipped' : 'waiting')));
                return (
                    <li key={name} data-step={name} data-state={state}>
                        <span className="wizard-step-mark" aria-hidden="true">{state === 'done' ? '✓' : state === 'failed' ? '✗' : state === 'running' ? '…' : state === 'skipped' ? '–' : '○'}</span>
                        {' '}{stepLabel(name)}
                        <span className="sr-only"> — {state}</span>
                    </li>
                );
            })}
        </ol>
    );
}

export function Tunnel({ port = 3400 }: { port?: number | null }) {
    const shown = port ?? 3400;
    return (
        <div className="wizard-tunnel" data-testid="tunnel">
            <p>
                Goobster&apos;s setup page only answers on the machine it runs on. On a machine with no screen, forward it to the computer you are sitting at,
                then open the address on that computer:
            </p>
            <pre><code>ssh -L {shown}:127.0.0.1:{shown} &lt;host&gt;</code></pre>
            <p className="hint">Replace <code>&lt;host&gt;</code> with the machine&apos;s name. Then open <code>http://127.0.0.1:{shown}/manager/</code>.</p>
        </div>
    );
}

export function LiveRegion({ children }: { children: ReactNode }) {
    return <div className="sr-only" role="status" aria-live="polite" data-testid="live-region">{children}</div>;
}

/** Whether `candidate` sits inside one of the allowed bases (a hint only: the manager decides). */
export function insideBase(candidate: string, bases: string[], separator: string): boolean {
    const clean = (value: string) => value.replace(/[\\/]+$/, '');
    const target = clean(candidate);
    return bases.some((base) => {
        const root = clean(base);
        return target === root || target.startsWith(root + separator) || target.startsWith(`${root}/`);
    });
}
