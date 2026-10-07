import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstallOperation } from '../../lib/types';
import { typedSecret, useAnswers, type Answers } from '../answers';
import { useConfigReport, useSource, useSuggest } from '../data';
import { hasDiscordToken, installInput, layoutFor, ownerInput, ownerProblems, fieldProblems, pathProblem, selectedFeatures, titleOf } from '../model';
import { blocks, NewPlan } from '../plan';
import { useTransport } from '../transport';
import { describeError, Details, ErrorSummary, StepFrame, StepNav, type Problem } from '../ui';
import type { StepProps } from './order';

const RUN_KEY = 'goobster-setup-run';

export type RunRecord = { install: string; owner: string | null; digest: string };

export function readRun(): RunRecord | null {
    try {
        const parsed = JSON.parse(window.sessionStorage.getItem(RUN_KEY) || 'null') as RunRecord | null;
        return parsed && typeof parsed.install === 'string' ? parsed : null;
    } catch { return null; }
}

export function writeRun(run: RunRecord | null) {
    try {
        if (run) window.sessionStorage.setItem(RUN_KEY, JSON.stringify(run));
        else window.sessionStorage.removeItem(RUN_KEY);
    } catch { /* optional */ }
}

/** Everything that decides the plan except the secrets, so a plan is reused only while the answers behind it are unchanged. */
export function digestOf(answers: Answers, secretIds: ReadonlySet<string>): string {
    const fields = Object.fromEntries(Object.entries(answers.fields).filter(([id]) => !secretIds.has(id)));
    return JSON.stringify({
        label: answers.label, source: answers.sourceDir, unsigned: answers.allowUnsigned, layout: answers.layout, roots: answers.roots,
        features: answers.features, fields, defaults: answers.instanceDefaults,
        owner: { create: answers.owner.create, login: answers.owner.loginName, display: answers.owner.displayName }
    });
}

const STEP_OF_FIELD: Array<[RegExp, string]> = [
    [/^(discord|ai|ollama)\./, 'connections'], [/^identity\./, 'defaults'], [/^webapp\./, 'access'], [/^defaults\./, 'defaults']
];

function hrefForField(id: string | undefined): string {
    const step = STEP_OF_FIELD.find(([pattern]) => id && pattern.test(id))?.[1] || 'where';
    return `#/setup/${step}`;
}

type Phase = { kind: 'checking' } | { kind: 'ready'; operation: InstallOperation; owner: InstallOperation | null }
    | { kind: 'failed'; problems: Problem[]; findings: InstallOperation | null; code: string; details: unknown };

/** The exact plan, with every finding. Nothing is applied until Install. */
export function Review({ go }: StepProps) {
    const transport = useTransport();
    const client = useQueryClient();
    const { answers, dropSecrets, update } = useAnswers();
    const suggest = useSuggest();
    const source = useSource(answers.sourceDir);
    const { fields, query: configQuery } = useConfigReport();
    const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
    const ran = useRef(false);
    const answersRef = useRef(answers);
    answersRef.current = answers;

    const secretIds = useCallback(() => new Set([...fields.values()].filter((field) => field.secret).map((field) => field.id)), [fields]);

    const localProblems = useCallback((): Problem[] => {
        const current = answersRef.current;
        const found: Problem[] = [];
        if (!current.sourceDir.trim()) found.push({ message: 'No release is chosen.', href: '#/setup/where' });
        for (const role of ['code', 'cache', 'logs', 'uploads'] as const) {
            const problem = pathProblem(role, current.roots[role], `where-${role}`);
            if (problem) found.push({ message: problem.message, href: '#/setup/where' });
        }
        const owner = ownerProblems(current, fields).map((problem) => ({ ...problem, href: '#/setup/connections' }));
        found.push(...owner.map((problem) => ({ message: problem.message, href: problem.href })));
        found.push(...fieldProblems(current, fields, Object.keys(current.fields)).map((problem) => ({ message: problem.message, href: hrefForField(problem.message.split(':')[0]) })));
        for (const id of current.reenter) {
            if (id !== 'owner.password') found.push({ message: `Enter ${id} again (this page does not keep keys), or leave it out.`, href: '#/setup/connections' });
        }
        return found;
    }, [fields]);

    const check = useCallback(async () => {
        if (!suggest.data) return;
        setPhase({ kind: 'checking' });
        const current = answersRef.current;
        const secrets = secretIds();
        const digest = digestOf(current, secrets);
        const previous = readRun();
        const typedAny = Object.entries(current.fields).some(([id, draft]) => secrets.has(id) && typedSecret(draft)) || current.owner.password !== '';
        if (previous && previous.digest === digest && !typedAny) {
            try {
                const [operation, owner] = await Promise.all([
                    transport.operation(previous.install),
                    previous.owner ? transport.operation(previous.owner).catch(() => null) : Promise.resolve(null)
                ]);
                if (operation.status === 'validated' && (!previous.owner || (owner && owner.status === 'validated'))) {
                    setPhase({ kind: 'ready', operation, owner });
                    return;
                }
            } catch { /* plan again below */ }
        }
        const local = localProblems();
        if (local.length > 0) {
            setPhase({ kind: 'failed', problems: local, findings: null, code: '', details: null });
            return;
        }
        const input = installInput({ answers: current, suggest: suggest.data, source: source.data, fields });
        let operation: InstallOperation;
        try {
            ({ operation } = await transport.preview('install.new', input));
        } catch (error) {
            dropSecrets();
            const described = describeError(error);
            const details = (described.details || {}) as { id?: string; operation?: InstallOperation };
            setPhase({
                kind: 'failed',
                problems: [{ message: described.message, href: details.id ? hrefForField(details.id) : undefined }],
                findings: details.operation && details.operation.plan?.preflight ? details.operation : null,
                code: described.code,
                details: described.details
            });
            return;
        }
        let ownerOperation: InstallOperation | null = null;
        if (current.owner.create) {
            try {
                ({ operation: ownerOperation } = await transport.preview('owner.create', ownerInput(current)));
            } catch (error) {
                dropSecrets();
                const described = describeError(error);
                setPhase({ kind: 'failed', problems: [{ message: described.message, href: '#/setup/connections' }], findings: null, code: described.code, details: described.details });
                return;
            }
        }
        dropSecrets();
        writeRun({ install: operation.id, owner: ownerOperation ? ownerOperation.id : null, digest });
        void client.invalidateQueries({ queryKey: ['setup', 'operation'] });
        setPhase({ kind: 'ready', operation, owner: ownerOperation });
    }, [suggest.data, secretIds, transport, localProblems, source.data, fields, dropSecrets, client]);

    useEffect(() => {
        if (ran.current || !suggest.data || configQuery.isPending) return;
        if (answers.sourceDir.trim() && source.isPending && source.fetchStatus !== 'idle') return;
        ran.current = true;
        void check();
    }, [suggest.data, configQuery.isPending, source.isPending, source.fetchStatus, answers.sourceDir, check]);

    const layout = layoutFor(answers, fields);
    const blocked = phase.kind === 'ready' && blocks(phase.operation);
    const leaveOut = answers.reenter.length > 0;

    return (
        <StepFrame id="review" title="Review, then install"
            lead="This is the exact plan the manager will carry out. Nothing has been changed yet.">
            {phase.kind === 'checking' && <p role="status" aria-live="polite" className="hint" data-testid="review-checking">Checking the plan with the manager…</p>}
            {phase.kind === 'failed' && (
                <>
                    <ErrorSummary problems={phase.problems} title="The plan cannot be made yet" />
                    {phase.findings && <NewFindings operation={phase.findings} />}
                    <Details code={phase.code} details={phase.details} />
                    {leaveOut && (
                        <p className="hint">
                            <button type="button" className="btn small" onClick={() => update((previous) => ({ ...previous, reenter: [] }))} data-testid="leave-out">Leave those keys out</button>
                            {' '}and check again.
                        </p>
                    )}
                    <StepNav onBack={() => go('access')} backLabel="Back"
                        extra={<button type="button" className="btn" data-testid="review-recheck" onClick={() => { ran.current = true; void check(); }}>Check again</button>} />
                </>
            )}
            {phase.kind === 'ready' && (
                <>
                    <dl className="wizard-facts" data-testid="review-answers">
                        <div className="wizard-fact"><dt>Installation</dt><dd>{answers.label || 'Goobster'}</dd></div>
                        <div className="wizard-fact"><dt>Discord</dt><dd>{hasDiscordToken(answers, fields) || answers.reenter.includes('discord.token') ? 'Connected (token given)' : 'Not connected'}</dd></div>
                        <div className="wizard-fact"><dt>Owner account</dt><dd>{phase.owner ? `${answers.owner.loginName} (created after the install)` : 'Not created: sign in with Discord'}</dd></div>
                        <div className="wizard-fact"><dt>Layout</dt><dd>{layout}</dd></div>
                    </dl>
                    <NewPlan operation={phase.operation} titles={(id) => titleOf(source.data, id)} />
                    {selectedFeatures(answers, source.data).length === 0 && <p className="hint">Only the core is installed.</p>}
                    {blocked && <p role="alert" className="settings-danger" data-testid="review-blocked">The manager found something that blocks this install. Fix it, then check again.</p>}
                    <StepNav onBack={() => go('access')}
                        extra={blocked ? <button type="button" className="btn" data-testid="review-recheck" onClick={() => { ran.current = true; void check(); }}>Check again</button> : null}
                        onNext={() => go('progress', phase.operation.id)} nextLabel="Install" nextDisabled={blocked} />
                </>
            )}
        </StepFrame>
    );
}

function NewFindings({ operation }: { operation: InstallOperation }) {
    return (
        <div data-testid="review-findings">
            <h3 className="section-title">What the manager found</h3>
            <ul className="wizard-findings">
                {(operation.plan.preflight?.findings || []).map((finding, index) => (
                    <li key={`${finding.code}-${index}`} data-severity={finding.severity} data-code={finding.code}>{finding.detail}</li>
                ))}
            </ul>
        </div>
    );
}
