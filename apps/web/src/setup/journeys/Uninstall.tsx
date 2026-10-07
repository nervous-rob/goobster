import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useRecord } from '../data';
import { blocks, UninstallPlan } from '../plan';
import { OperationProgress, useRun } from '../run';
import { useTransport } from '../transport';
import { describeError, ErrorSummary, StepFrame, StepNav, type Problem } from '../ui';
import { JourneyFrame, PlanFailure, usePlanCheck } from './common';

const MANAGER_URL = 'http://127.0.0.1:3400/manager/';

/** Remove Goobster. Your data stays unless you say otherwise, and deleting it needs the installation id typed. */
export function Uninstall({ step, id, go }: { step: string; id: string | null; go: (step: string, id?: string | null) => void }) {
    const transport = useTransport();
    const client = useQueryClient();
    const record = useRecord();
    const planner = usePlanCheck('install.uninstall');
    const [keepData, setKeepData] = useState(true);
    const [typed, setTyped] = useState('');
    const [acknowledge, setAcknowledge] = useState(false);
    const [problems, setProblems] = useState<Problem[]>([]);
    const [stopping, setStopping] = useState(false);
    const [stopError, setStopError] = useState<string | null>(null);
    const run = useRun(step === 'progress' && id ? id : 'none');
    const current = record.data?.record;
    const installationId = current?.installationId || '';

    function input() {
        return { keepData, ...(keepData ? {} : { confirm: typed.trim() }), ...(acknowledge ? { acknowledgeUnknownServices: true } : {}) };
    }

    useEffect(() => {
        if (step === 'review' && planner.phase.kind === 'idle') void planner.check(input());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, planner.phase.kind]);

    function choose() {
        const found: Problem[] = [];
        if (!keepData && typed.trim() !== installationId) {
            found.push({ field: 'uninstall-confirm', message: 'Type the installation id exactly as shown to confirm deleting your data.' });
        }
        setProblems(found);
        if (found.length === 0) go('review');
    }

    async function stopWorkers() {
        setStopping(true);
        setStopError(null);
        try {
            const planned = await transport.preview('lifecycle.stop', undefined);
            await transport.apply(planned.operation.id);
            planner.reset();
        } catch (error) {
            setStopError(describeError(error).message);
        } finally {
            setStopping(false);
            await client.invalidateQueries({ queryKey: ['setup'] });
        }
    }

    if (step === 'progress' && id) {
        return (
            <JourneyFrame title="Uninstall">
                <StepFrame id="uninstall-progress" title="Uninstalling">
                    <OperationProgress run={run} title="Uninstall" autoStart
                        kept="Nothing that was not listed in the review was removed."
                        failureHelp={<p>It can be run again; it picks up where it stopped. <a href="#/uninstall/choose">Start again</a>.</p>}>
                        {run.phase === 'applied' && (
                            <div data-testid="uninstall-done" className="wizard-success" role="status">
                                <p><strong>Goobster has been removed.</strong></p>
                                <p>{run.operation?.plan.keepData
                                    ? 'Your data and settings were kept; installing again picks them up.'
                                    : 'Your data and settings were deleted with it.'}</p>
                            </div>
                        )}
                    </OperationProgress>
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'review') {
        const phase = planner.phase;
        const operation = phase.kind === 'ready' ? phase.operation : (phase.kind === 'failed' ? phase.operation : null);
        const running = operation?.plan.preflight?.findings.some((finding) => finding.code === 'WORKERS_RUNNING') === true;
        const unknown = operation?.plan.unknownServices || [];
        return (
            <JourneyFrame title="Uninstall">
                <StepFrame id="uninstall-review" title="Review what will be removed" lead="Nothing has been removed yet.">
                    {(phase.kind === 'checking' || phase.kind === 'idle') && <p role="status" className="hint">Checking with the manager…</p>}
                    {phase.kind === 'failed' && <PlanFailure phase={phase} />}
                    {phase.kind === 'ready' && <UninstallPlan operation={phase.operation} />}
                    {unknown.length > 0 && (
                        <label className="wizard-choice" data-testid="unknown-services">
                            <input type="checkbox" checked={acknowledge} onChange={(event) => { setAcknowledge(event.target.checked); planner.reset(); }} />
                            {' '}I know about services the manager did not install ({unknown.length}); leave them alone.
                        </label>
                    )}
                    {running && (
                        <div className="wizard-callout" data-testid="workers-running">
                            <p><strong>Goobster is still running.</strong> It cannot be removed while its programs are running.</p>
                            {transport.mode === 'manager' ? (
                                <p>
                                    <button type="button" className="btn" onClick={() => void stopWorkers()} disabled={stopping} data-testid="stop-workers">{stopping ? 'Stopping…' : 'Stop Goobster'}</button>
                                    {stopError && <span role="alert" className="settings-danger"> {stopError}</span>}
                                    <span className="hint"> If this manager did not start them, stop them yourself, then check again.</span>
                                </p>
                            ) : (
                                <p data-testid="portal-uninstall-note">
                                    You are using Goobster&apos;s portal, which is one of those programs, so it cannot remove itself from here. Stop Goobster, then finish from the manager at{' '}
                                    <code>{MANAGER_URL}</code> with a recovery credential.
                                </p>
                            )}
                        </div>
                    )}
                    <StepNav onBack={() => { planner.reset(); go('choose'); }}
                        extra={phase.kind !== 'checking' && phase.kind !== 'idle' ? <button type="button" className="btn" onClick={() => planner.reset()} data-testid="check-again">Check again</button> : null}
                        onNext={phase.kind === 'ready' ? () => go('progress', phase.operation.id) : undefined}
                        nextLabel={keepData ? 'Uninstall, keep my data' : 'Uninstall and delete my data'}
                        nextDisabled={phase.kind !== 'ready' || blocks(phase.operation)} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    return (
        <JourneyFrame title="Uninstall">
            <StepFrame id="uninstall-choose" title="Uninstall Goobster" lead="Choose what happens to your data. Keeping it is the default, and installing again will find it.">
                <ErrorSummary problems={problems} />
                {record.isError && <p role="alert" className="settings-danger">{describeError(record.error).message}</p>}
                <div role="radiogroup" aria-label="What to do with your data" className="wizard-fieldset">
                    <label className="wizard-choice">
                        <input type="radio" name="keep" checked={keepData} onChange={() => setKeepData(true)} data-testid="keep-data" />
                        {' '}<strong>Keep my data and settings</strong> <span className="hint">only the program files go</span>
                    </label>
                    <label className="wizard-choice">
                        <input type="radio" name="keep" checked={!keepData} onChange={() => setKeepData(false)} data-testid="delete-data" />
                        {' '}<strong>Delete my data too</strong> <span className="hint">conversations, memory, accounts and settings: this cannot be undone</span>
                    </label>
                </div>
                {!keepData && (
                    <div className="wizard-field" data-testid="confirm-field">
                        <label htmlFor="uninstall-confirm">Type the installation id to confirm</label>
                        <input id="uninstall-confirm" className="input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} data-testid="uninstall-confirm" />
                        <span className="hint">It is <code data-testid="confirm-expected">{installationId}</code>.</span>
                    </div>
                )}
                <StepNav onBack={() => go('home')} backLabel="Cancel" onNext={choose} nextLabel="Review" nextDisabled={!current} />
            </StepFrame>
        </JourneyFrame>
    );
}
