import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { useAnswers } from '../answers';
import { buildChanges } from '../../rooms/host/drafts';
import { MINT_RECOVERY } from '../commands';
import { OwnerForm } from './Connections';
import { ownerInput, ownerProblems } from '../model';
import { OperationProgress, useRun } from '../run';
import { useTransport } from '../transport';
import { describeError, ErrorSummary, StepFrame, StepNav, type Problem } from '../ui';
import { readRun, writeRun } from './Review';
import type { StepProps } from './order';

type StageState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
type Stage = { id: 'owner' | 'defaults' | 'start'; label: string; state: StageState; note?: string; error?: { message: string; code: string } };

const POST_KEY = 'goobster-setup-post';
const OWNER_WAIT_SECONDS = 60;

function readPost(): Record<string, string> {
    try { return JSON.parse(window.sessionStorage.getItem(POST_KEY) || '{}') as Record<string, string>; } catch { return {}; }
}
function markPost(id: string) {
    try { window.sessionStorage.setItem(POST_KEY, JSON.stringify({ ...readPost(), [id]: 'done' })); } catch { /* optional */ }
}

/** After the files are in place: the owner account, the defaults, and starting the workers. */
function PostInstall({ go }: StepProps) {
    const transport = useTransport();
    const { answers } = useAnswers();
    const [stages, setStages] = useState<Stage[]>([
        { id: 'owner', label: 'Create the owner account', state: 'waiting' },
        { id: 'defaults', label: 'Save your defaults', state: 'waiting' },
        { id: 'start', label: 'Start Goobster', state: 'waiting' }
    ]);
    const began = useRef(false);
    const [retryProblems, setRetryProblems] = useState<Problem[]>([]);
    const [retrying, setRetrying] = useState(false);

    const patch = useCallback((id: Stage['id'], change: Partial<Stage>) => {
        setStages((previous) => previous.map((stage) => (stage.id === id ? { ...stage, ...change } : stage)));
    }, []);

    const runOwner = useCallback(async (): Promise<boolean> => {
        const record = readRun();
        if (!record || !record.owner) { patch('owner', { state: 'skipped', note: 'No owner account was asked for.' }); return true; }
        if (readPost().owner) { patch('owner', { state: 'done' }); return true; }
        patch('owner', { state: 'running' });
        try {
            let operation = await transport.operation(record.owner);
            // A reload while the account was being made: the manager is still applying it, so follow it.
            for (let waited = 0; operation.status === 'applying' && waited < OWNER_WAIT_SECONDS; waited++) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                operation = await transport.operation(record.owner);
            }
            if (operation.status === 'applied') { markPost('owner'); patch('owner', { state: 'done' }); return true; }
            if (operation.status !== 'validated') throw new ApiError(409, 'OPERATION_STATE', `The owner account step is not in a state that can run (it is ${String(operation.status)}).`);
            await transport.apply(record.owner);
            markPost('owner');
            patch('owner', { state: 'done' });
            return true;
        } catch (error) {
            const described = describeError(error);
            if (described.code === 'ACCOUNT_EXISTS') { markPost('owner'); patch('owner', { state: 'done', note: 'An account already exists, so none was added.' }); return true; }
            patch('owner', { state: 'failed', error: described });
            return false;
        }
    }, [patch, transport]);

    const runDefaults = useCallback(async () => {
        if (readPost().defaults) { patch('defaults', { state: 'done' }); return; }
        patch('defaults', { state: 'running' });
        try {
            const report = await transport.config();
            const fields = new Map(report.sections.flatMap((section) => section.fields).map((field) => [field.id, field]));
            const { changes } = buildChanges(fields, answers.instanceDefaults);
            if (changes.length === 0) { patch('defaults', { state: 'skipped', note: 'You kept the standard defaults.' }); return; }
            if (!report.defaults) { patch('defaults', { state: 'skipped', note: 'The database was not reachable, so set these later in the Host room.' }); return; }
            const planned = await transport.preview('defaults.set', { expectedRevision: report.defaults.revision, changes });
            await transport.apply(planned.operation.id);
            markPost('defaults');
            patch('defaults', { state: 'done' });
        } catch (error) {
            patch('defaults', { state: 'skipped', note: `Not saved: ${describeError(error).message} Set them later in the Host room.` });
        }
    }, [answers.instanceDefaults, patch, transport]);

    const runStart = useCallback(async () => {
        patch('start', { state: 'running' });
        try {
            const planned = await transport.preview('lifecycle.start', undefined);
            await transport.apply(planned.operation.id);
            patch('start', { state: 'done' });
        } catch (error) {
            const described = describeError(error);
            if (described.code === 'ALREADY_SUPERVISING') { patch('start', { state: 'done', note: 'It was already running.' }); return; }
            patch('start', { state: 'failed', error: described });
        }
    }, [patch, transport]);

    useEffect(() => {
        if (began.current) return;
        began.current = true;
        void (async () => {
            const ownerOk = await runOwner();
            await runDefaults();
            if (ownerOk) await runStart();
        })();
    }, [runOwner, runDefaults, runStart]);

    async function retryOwner() {
        const found = ownerProblems(answers, new Map());
        const relevant = found.filter((problem) => problem.field !== 'owner-create');
        setRetryProblems(relevant);
        if (relevant.length > 0) return;
        setRetrying(true);
        patch('owner', { state: 'running', error: undefined });
        try {
            const planned = await transport.preview('owner.create', ownerInput(answers));
            await transport.apply(planned.operation.id);
            markPost('owner');
            patch('owner', { state: 'done' });
            await runStart();
        } catch (error) {
            patch('owner', { state: 'failed', error: describeError(error) });
        } finally {
            setRetrying(false);
        }
    }

    const owner = stages.find((stage) => stage.id === 'owner') as Stage;
    const settled = stages.every((stage) => stage.state === 'done' || stage.state === 'skipped');
    const startFailed = stages.find((stage) => stage.id === 'start')?.state === 'failed';

    return (
        <div data-testid="post-install">
            <h3 className="section-title">Finishing up</h3>
            <ol className="wizard-steps" data-testid="post-stages">
                {stages.map((stage) => (
                    <li key={stage.id} data-stage={stage.id} data-state={stage.state} data-testid="post-stage">
                        <span aria-hidden="true">{stage.state === 'done' ? '✓' : stage.state === 'failed' ? '✗' : stage.state === 'running' ? '…' : stage.state === 'skipped' ? '–' : '○'}</span>
                        {' '}{stage.label}<span className="sr-only"> — {stage.state}</span>
                        {stage.note && <span className="hint"> {stage.note}</span>}
                        {stage.error && <div role="alert" className="settings-danger">{stage.error.message}</div>}
                    </li>
                ))}
            </ol>
            {owner.state === 'failed' && (
                <div data-testid="owner-retry">
                    <p>The owner account could not be created. The manager forgot the password it was given, so enter it again.</p>
                    <ErrorSummary problems={retryProblems} />
                    <OwnerForm />
                    <button type="button" className="btn primary" onClick={() => void retryOwner()} disabled={retrying} data-testid="owner-retry-submit">Create the owner account</button>
                </div>
            )}
            {startFailed && (
                <p className="hint">Goobster could not be started from here. You can try again on the next page, or start it the way you normally do. Recovery: <code>{MINT_RECOVERY}</code></p>
            )}
            <StepNav onNext={() => go('first-run')} nextLabel="Check that it works" nextDisabled={!settled && !startFailed} />
        </div>
    );
}

/** Installing: per-step progress that survives a reload, then the post-install stages. */
export function Progress({ go, id }: StepProps & { id: string | null }) {
    const run = useRun(id || 'none');
    if (!id) {
        return (
            <StepFrame id="progress" title="Installing">
                <p role="alert" className="settings-danger">There is no install to follow. <a href="#/setup/review">Go back to the review.</a></p>
            </StepFrame>
        );
    }
    return (
        <StepFrame id="progress" title="Installing Goobster"
            lead="Each step is recorded as it finishes. You can reload this page or close it; the install carries on and this page finds it again.">
            <OperationProgress run={run} title="The install" autoStart
                kept="Nothing of yours was touched: your data and settings are only written once the files are in place."
                failureHelp={(
                    <p>
                        Go back to the review to change what blocked it, or <a href="#/setup/review">check the plan again</a>. If the manager restarted, plan it again; a half-finished install is
                        picked up where it stopped.
                    </p>
                )}>
                {run.phase === 'applied' && <PostInstall go={go} />}
            </OperationProgress>
            {run.phase === 'failed' && <StepNav onBack={() => { writeRun(null); go('review'); }} backLabel="Back to the review" />}
        </StepFrame>
    );
}
