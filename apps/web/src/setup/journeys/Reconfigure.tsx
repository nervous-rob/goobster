import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAnswers } from '../answers';
import { KEYS, useConfigReport, useRecord } from '../data';
import { FieldList } from '../fields';
import { HealthPanel } from '../health';
import { fieldProblems, pathProblem } from '../model';
import { blocks, ReconfigurePlan } from '../plan';
import { OperationProgress, useRun } from '../run';
import { useTransport } from '../transport';
import { describeError, ErrorSummary, StepFrame, StepNav, type Problem } from '../ui';
import { JourneyFrame, PlanFailure, usePlanCheck } from './common';

const CONNECTIONS = ['discord.token', 'discord.clientId', 'discord.guildIds', 'ai.provider', 'ai.openai.apiKey', 'ai.anthropic.apiKey', 'ai.gemini.apiKey', 'ollama.host', 'ollama.model', 'webapp.publicUrl', 'identity.installationName', 'identity.assistantName'];
const MOVABLE = [
    { role: 'cache', label: 'Cache' },
    { role: 'logs', label: 'Logs' },
    { role: 'uploads', label: 'Uploads' }
] as const;

/** Change connections, names, layout and folders. The review shows the exact difference and what waits for a restart. */
export function Reconfigure({ step, id, go, restartPanel }: {
    step: string; id: string | null; go: (step: string, id?: string | null) => void; restartPanel?: ReactNode;
}) {
    const transport = useTransport();
    const { answers, update, dropSecrets } = useAnswers();
    const record = useRecord();
    const { query, report, fields } = useConfigReport();
    const planner = usePlanCheck('install.reconfigure');
    const [problems, setProblems] = useState<Problem[]>([]);
    const seeded = useRef(false);
    const current = record.data?.record;

    useEffect(() => {
        if (seeded.current || !current || !current.roots) return;
        seeded.current = true;
        update((previous) => ({
            ...previous,
            layout: previous.layout !== 'auto' ? previous.layout : 'auto',
            roots: {
                code: current.roots?.code || '',
                cache: previous.roots.cache || current.roots?.cache || '',
                logs: previous.roots.logs || current.roots?.logs || '',
                uploads: previous.roots.uploads || current.roots?.uploads || ''
            }
        }));
    }, [current, update]);

    function input(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        if (current?.roots) {
            const roots: Record<string, string> = {};
            for (const { role } of MOVABLE) if (answers.roots[role] && answers.roots[role] !== current.roots[role]) roots[role] = answers.roots[role];
            if (Object.keys(roots).length > 0) out.roots = roots;
        }
        if (answers.layout !== 'auto' && answers.layout !== current?.layout) out.layout = answers.layout;
        const config: Array<{ id: string; value: unknown }> = [];
        for (const [fieldId, draft] of Object.entries(answers.fields)) {
            if (draft.action === 'set') {
                const built = fieldProblems(answers, fields, [fieldId]);
                if (built.length === 0) {
                    const value = fields.get(fieldId)?.type === 'boolean' ? draft.value === true : (fields.get(fieldId)?.type === 'list' ? String(draft.value).split(',').map((item) => item.trim()).filter(Boolean) : (['integer', 'number'].includes(fields.get(fieldId)?.type || '') ? Number(draft.value) : draft.value));
                    config.push({ id: fieldId, value });
                }
            }
        }
        if (config.length > 0) out.config = config;
        return out;
    }

    function review() {
        const found: Problem[] = [...fieldProblems(answers, fields, Object.keys(answers.fields))];
        for (const { role, label } of MOVABLE) {
            const problem = pathProblem(label.toLowerCase(), answers.roots[role], `reconfigure-${role}`);
            if (problem) found.push(problem);
        }
        setProblems(found);
        if (found.length === 0) go('review');
    }

    useEffect(() => {
        if (step !== 'review' || planner.phase.kind !== 'idle' || !current || !report) return;
        void (async () => {
            await planner.check(input());
            dropSecrets();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, current, report, planner.phase.kind]);

    const run = useRun(step === 'progress' && id ? id : 'none');
    const client = useQueryClient();

    if (step === 'progress' && id) {
        const result = run.operation?.plan.changes;
        return (
            <JourneyFrame title="Reconfigure">
                <StepFrame id="reconfigure-progress" title="Applying the changes">
                    <OperationProgress run={run} title="Reconfigure" autoStart
                        kept="Your data is untouched. The previous settings stay in force until the processes restart."
                        failureHelp={<p><a href="#/reconfigure/edit">Change the answers and try again</a>, or <a href="#/repair/scope">run Repair</a>.</p>}>
                        {run.phase === 'applied' && (
                            <div data-testid="reconfigure-done">
                                <p role="note" className="wizard-pending" data-testid="pending-restart">
                                    <strong>Saved, waiting for a restart.</strong>{' '}
                                    {(result?.config?.length || result?.layout || result?.roots) ? 'The running processes still use the old settings until they restart.' : 'Nothing needed to change.'}
                                </p>
                                {transport.mode === 'manager' && (
                                    <p>
                                        <button type="button" className="btn primary" data-testid="restart-workers"
                                            onClick={() => { void transport.lifecycleAction('restart').then(() => client.invalidateQueries({ queryKey: KEYS.lifecycle })).catch(() => undefined); }}>Restart now</button>
                                    </p>
                                )}
                                {restartPanel}
                                {transport.mode === 'manager' && <HealthPanel canStart />}
                            </div>
                        )}
                    </OperationProgress>
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'review') {
        const phase = planner.phase;
        return (
            <JourneyFrame title="Reconfigure">
                <StepFrame id="reconfigure-review" title="Review the changes" lead="This is the difference between what is installed and what you asked for. Nothing has changed yet.">
                    {(phase.kind === 'checking' || phase.kind === 'idle') && <p role="status" className="hint">Checking the changes with the manager…</p>}
                    {phase.kind === 'failed' && <PlanFailure phase={phase} />}
                    {phase.kind === 'ready' && (
                        <>
                            <ReconfigurePlan operation={phase.operation} />
                            {blocks(phase.operation) && <p role="alert" className="settings-danger">The manager found something that blocks this. Fix it, then check again.</p>}
                        </>
                    )}
                    <StepNav onBack={() => { planner.reset(); go('edit'); }}
                        onNext={phase.kind === 'ready' ? () => go('progress', phase.operation.id) : undefined}
                        nextLabel="Apply" nextDisabled={phase.kind !== 'ready' || blocks(phase.operation) || phase.operation.plan.noop === true} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    return (
        <JourneyFrame title="Reconfigure">
            <StepFrame id="reconfigure-edit" title="Reconfigure" lead="Change only what you need. Anything you leave alone stays as it is.">
                <ErrorSummary problems={problems} />
                {(record.isPending || query.isPending) && <p role="status" className="hint">Reading the installation…</p>}
                {record.isError && <p role="alert" className="settings-danger">{describeError(record.error).message}</p>}
                {current && report && (
                    <>
                        <fieldset className="wizard-fieldset">
                            <legend>Layout</legend>
                            <div className="wizard-field">
                                <label htmlFor="reconfigure-layout">How it runs</label>
                                <select id="reconfigure-layout" className="select" value={answers.layout}
                                    onChange={(event) => update((previous) => ({ ...previous, layout: event.target.value as 'auto' | 'lite' | 'standalone' }))} data-testid="reconfigure-layout">
                                    <option value="auto">Keep {current.layout}</option>
                                    {current.layout !== 'lite' && <option value="lite">lite: the Discord bot serves the portal</option>}
                                    {current.layout !== 'standalone' && <option value="standalone">standalone: the portal runs on its own</option>}
                                </select>
                                <span className="hint">The layout needs what it runs on: a Discord token for lite, the web app switched on for standalone.</span>
                            </div>
                        </fieldset>
                        <fieldset className="wizard-fieldset">
                            <legend>Folders</legend>
                            <p className="hint">Program files <code>{current.roots?.code}</code>, data and settings stay where they are; moving those is a backup and restore job.</p>
                            {MOVABLE.map(({ role, label }) => (
                                <div key={role} className="wizard-field">
                                    <label htmlFor={`reconfigure-${role}`}>{label}</label>
                                    <input id={`reconfigure-${role}`} className="input" value={answers.roots[role]} spellCheck={false}
                                        onChange={(event) => update((previous) => ({ ...previous, roots: { ...previous.roots, [role]: event.target.value } }))} data-testid={`reconfigure-${role}`} />
                                </div>
                            ))}
                        </fieldset>
                        <h3 className="section-title">Connections and names</h3>
                        <FieldList ids={CONNECTIONS} report={report} />
                    </>
                )}
                <StepNav onBack={() => go('home')} backLabel="Cancel" onNext={review} nextLabel="Review the changes" nextDisabled={!current || !report} />
            </StepFrame>
        </JourneyFrame>
    );
}
