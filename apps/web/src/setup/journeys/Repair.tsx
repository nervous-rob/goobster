import { useEffect, useState } from 'react';
import { useRecord, useSuggest } from '../data';
import { HealthPanel } from '../health';
import { blocks, RepairPlan } from '../plan';
import { OperationProgress, useRun } from '../run';
import { useTransport } from '../transport';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import { JourneyFrame, PlanFailure, usePlanCheck } from './common';

/** Put the program files, the database schema and the feature choice back. Your data and settings are never touched. */
export function Repair({ step, id, go }: { step: string; id: string | null; go: (step: string, id?: string | null) => void }) {
    const transport = useTransport();
    const record = useRecord();
    const suggest = useSuggest();
    const planner = usePlanCheck('install.repair');
    const [source, setSource] = useState('');
    const [unsigned, setUnsigned] = useState(false);
    const run = useRun(step === 'progress' && id ? id : 'none');
    const current = record.data?.record;

    function input() {
        return {
            ...(source.trim() ? { source: source.trim() } : {}),
            ...(unsigned ? { release: { allowUnsigned: true } } : {})
        };
    }

    useEffect(() => {
        if (step === 'review' && planner.phase.kind === 'idle') void planner.check(input());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, planner.phase.kind]);

    if (step === 'progress' && id) {
        return (
            <JourneyFrame title="Repair">
                <StepFrame id="repair-progress" title="Repairing">
                    <OperationProgress run={run} title="Repair" autoStart
                        kept="Your data, your settings file and the manager records were not touched."
                        failureHelp={<p>Repair can be run again; it picks up where it stopped. <a href="#/repair/scope">Start it again</a>.</p>}>
                        {run.phase === 'applied' && (
                            <div data-testid="repair-done">
                                <p role="status" className="wizard-success">Repaired. Check that everything answers:</p>
                                <HealthPanel canStart={transport.mode === 'manager'} />
                            </div>
                        )}
                    </OperationProgress>
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'review') {
        const phase = planner.phase;
        const needsSource = phase.kind === 'failed' && phase.code === 'REPAIR_SOURCE_REQUIRED';
        return (
            <JourneyFrame title="Repair">
                <StepFrame id="repair-review" title="Review the repair" lead="This is what repair will do. Nothing has changed yet.">
                    {(phase.kind === 'checking' || phase.kind === 'idle') && <p role="status" className="hint">Checking with the manager…</p>}
                    {phase.kind === 'failed' && (
                        <PlanFailure phase={phase} help={needsSource ? <p>Go back and choose a copy of this release to repair from.</p> : undefined} />
                    )}
                    {phase.kind === 'ready' && (
                        <>
                            <RepairPlan operation={phase.operation} />
                            {blocks(phase.operation) && <p role="alert" className="settings-danger">The manager found something that blocks this repair.</p>}
                        </>
                    )}
                    <StepNav onBack={() => { planner.reset(); go('scope'); }}
                        onNext={phase.kind === 'ready' ? () => go('progress', phase.operation.id) : undefined}
                        nextLabel="Repair" nextDisabled={phase.kind !== 'ready' || blocks(phase.operation)} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    return (
        <JourneyFrame title="Repair">
            <StepFrame id="repair-scope" title="Repair this installation"
                lead="Repair verifies the program files against the release they came from, restores any that are damaged, opens the database again and rewrites the feature choice.">
                {record.isError && <p role="alert" className="settings-danger">{describeError(record.error).message}</p>}
                <ul className="wizard-list" data-testid="repair-scope">
                    <li><strong>Checked and restored:</strong> the program files{current?.release ? ` of ${String(current.release.version || current.release.releaseId)}` : ''}.</li>
                    <li><strong>Re-applied:</strong> the database schema and the feature choice.</li>
                    <li><strong>Kept exactly as they are:</strong> your data, your settings file and the manager records.</li>
                </ul>
                <details className="wizard-details">
                    <summary>If the program files are too damaged to repair in place</summary>
                    <p className="hint">Repair needs a good copy of the same release. Choose one found on this machine, or type its folder.</p>
                    {(suggest.data?.sources || []).length > 0 && (
                        <div role="radiogroup" aria-label="Copies of the release">
                            {(suggest.data?.sources || []).map((entry) => (
                                <label key={entry.dir} className="wizard-choice">
                                    <input type="radio" name="repair-source" checked={source === entry.dir} onChange={() => setSource(entry.dir)} />
                                    {' '}Goobster {entry.version} <span className="hint">({formatBytes(entry.totalBytes)} · {entry.dir})</span>
                                </label>
                            ))}
                        </div>
                    )}
                    <div className="wizard-field">
                        <label htmlFor="repair-source">Folder of the release</label>
                        <input id="repair-source" className="input" value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} data-testid="repair-source" />
                    </div>
                    <label className="wizard-choice"><input type="checkbox" checked={unsigned} onChange={(event) => setUnsigned(event.target.checked)} /> The copy is not signed (advanced)</label>
                </details>
                <StepNav onBack={() => go('home')} backLabel="Cancel" onNext={() => go('review')} nextLabel="Review the repair" nextDisabled={!current} />
            </StepFrame>
        </JourneyFrame>
    );
}
