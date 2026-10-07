import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ResetPreview } from '../../lib/types';
import { useTransport } from '../transport';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import { ENCRYPTION_NOTE, useBackupStatus } from './Backup';
import { BarrierPanel } from './barrier';
import { JourneyFrame, planAndApply } from './common';

const FEATURE_ID = /^[a-z][A-Za-z0-9]{0,31}$/;

type ResetResult = {
    scope: string; feature: string | null; resumed: boolean;
    backup: { verified: boolean; archive: string | null };
    outcome: { tables?: Record<string, unknown>; files?: { total?: number }; vectors?: { before: number; after: number } } | null;
    paused: boolean; barrier: string; next: string;
};

type Phase =
    | { kind: 'idle' }
    | { kind: 'holding' }
    | { kind: 'resetting' }
    | { kind: 'done'; result: ResetResult | null }
    | { kind: 'failed'; message: string; code: string; released: boolean };

export const RESET_COMMAND = 'node apps/manager/cli.js reset --scope instance';

function onRecoveryPage(): boolean {
    return window.location.pathname.replace(/\/+$/, '').endsWith('/recovery');
}

function cliCommand(scope: 'instance' | 'feature', feature: string): string {
    return scope === 'feature' ? `node apps/manager/cli.js reset --scope feature --feature ${feature || '<feature>'}` : RESET_COMMAND;
}

/**
 * Empty the application's data (one dormant feature's, or all of it) after a verified backup. The reset itself is `data.reset`
 * and runs only inside a held maintenance barrier, which holds the portal down: it runs from the manager page or the CLI.
 */
export function Reset({ step, go }: { step: string; id: string | null; go: (step: string, id?: string | null) => void }) {
    const transport = useTransport();
    const status = useBackupStatus();
    const [scope, setScope] = useState<'instance' | 'feature'>('feature');
    const [feature, setFeature] = useState('');
    const [previewKey, setPreviewKey] = useState('');
    const [dir, setDir] = useState('');
    const [skipConfig, setSkipConfig] = useState(false);
    const [passphrase, setPassphrase] = useState('');
    const [confirm, setConfirm] = useState('');
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

    const featureOk = scope === 'instance' || FEATURE_ID.test(feature);
    const wanted = scope === 'instance' ? 'instance' : (FEATURE_ID.test(feature) ? `feature:${feature}` : '');
    const plan = useQuery({
        queryKey: ['setup', 'reset-plan', previewKey],
        queryFn: () => transport.resetPlan(scope, scope === 'feature' ? feature : undefined),
        enabled: previewKey.length > 0,
        retry: false, staleTime: 0
    });
    const preview: ResetPreview | undefined = plan.data;

    useEffect(() => {
        if (!dir && status.data?.suggestedDir) setDir(`${status.data.suggestedDir.replace(/[\\/]+$/, '')}/before-reset`);
    }, [status.data, dir]);
    useEffect(() => () => { setPassphrase(''); setConfirm(''); }, []);

    const managerMode = transport.mode === 'manager';
    const instanceNeedsLocal = scope === 'instance' && !onRecoveryPage();
    const canRunHere = managerMode && !instanceNeedsLocal;
    const command = cliCommand(scope, feature);
    const backupReady = dir.trim().length > 0 && (skipConfig || !preview?.backup.includesConfig || passphrase.length > 0);
    const confirmed = preview?.confirm !== null && preview?.confirm !== undefined && confirm === preview.confirm;

    async function execute() {
        if (!preview) return;
        setPhase({ kind: 'holding' });
        let held: { operationId: string; fence: number } | null = null;
        try {
            const entered = await planAndApply(transport, 'maintenance.enter', { reason: 'data-reset', timeoutSeconds: 120 });
            const result = entered.result as { operationId?: string; fence?: number } | null;
            if (!result || typeof result.operationId !== 'string' || typeof result.fence !== 'number') throw new Error('The manager did not say which maintenance it holds.');
            held = { operationId: result.operationId, fence: result.fence };
            setPhase({ kind: 'resetting' });
            const applied = await planAndApply(transport, 'data.reset', {
                scope, ...(scope === 'feature' ? { feature } : {}),
                backup: { dir: dir.trim(), ...(skipConfig ? { skipConfig: true } : { passphrase }) },
                confirm,
                maintenance: held
            });
            setPassphrase('');
            setConfirm('');
            setPhase({ kind: 'done', result: applied.result as ResetResult | null });
        } catch (error) {
            const described = describeError(error);
            let released = false;
            if (held) {
                try {
                    await planAndApply(transport, 'maintenance.release', { operationId: held.operationId, fence: held.fence });
                    released = true;
                } catch { /* the barrier panel shows what is still held */ }
            }
            setPhase({ kind: 'failed', message: described.message, code: described.code, released });
        }
    }

    if (step === 'run') {
        return (
            <JourneyFrame title="Reset">
                <StepFrame id="reset-run" title={scope === 'instance' ? 'Reset the whole instance' : `Reset the data of ${feature}`}
                    lead="Last check. This empties data after a verified backup, and it cannot be undone once it starts replacing data.">
                    {!managerMode && (
                        <div className="wizard-callout" data-testid="reset-cli-only">
                            <p>A reset runs inside the maintenance barrier, which holds the portal down, so it cannot be driven from the portal. Run it from the manager page, or on the machine:</p>
                            <pre><code>{command}</code></pre>
                            <p className="hint">The command asks for the backup folder, the passphrase and the typed confirmation, and prints the plan first. <code>--dry-run</code> only shows it.</p>
                        </div>
                    )}
                    {managerMode && instanceNeedsLocal && (
                        <div className="wizard-callout" data-testid="reset-needs-local">
                            <p>Resetting the whole instance needs the recovery credential or the local command line, not this session. On the machine:</p>
                            <pre><code>{command}</code></pre>
                            <p className="hint">Resetting one dormant feature&apos;s data works from here.</p>
                        </div>
                    )}
                    {canRunHere && phase.kind === 'idle' && (
                        <>
                            <ul className="wizard-list" data-testid="reset-summary">
                                <li>The application stops writing (maintenance is held), then a backup is written to <code>{dir.trim()}</code> and verified.</li>
                                <li>Only then is the data removed. If the backup cannot be verified, nothing is touched.</li>
                                <li>Afterwards the instance is paused and maintenance stays held until you release it.</li>
                            </ul>
                            <StepNav onBack={() => go('confirm')} onNext={() => void execute()} nextLabel="Reset now" nextDisabled={!confirmed} />
                        </>
                    )}
                    {phase.kind === 'holding' && <p role="status" className="hint" data-testid="reset-holding">Holding maintenance: waiting for the application to stop writing…</p>}
                    {phase.kind === 'resetting' && <p role="status" className="hint" data-testid="reset-resetting">Backing up, verifying and resetting…</p>}
                    {phase.kind === 'failed' && (
                        <div className="wizard-errors" role="alert" data-testid="reset-failed" data-code={phase.code}>
                            <strong>The reset did not finish.</strong>
                            <p>{phase.message}</p>
                            <p>{phase.released ? 'Maintenance was released; the application can write again and nothing was removed.' : 'Maintenance may still be held (see below). If data was already being removed, run the same reset again to carry on.'}</p>
                            <p><a href="#/reset/scope" data-testid="reset-again">Start again</a></p>
                        </div>
                    )}
                    {phase.kind === 'done' && <ResetResultView result={phase.result} />}
                    {(phase.kind === 'done' || phase.kind === 'failed') && <BarrierPanel canRelease={managerMode} />}
                    {!canRunHere && <StepNav onBack={() => go('confirm')} />}
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'confirm') {
        return (
            <JourneyFrame title="Reset">
                <StepFrame id="reset-confirm" title="Confirm" lead="Type the confirmation exactly as shown. It names this installation, so it cannot be typed by habit.">
                    {preview ? (
                        <>
                            <p>Type: <code data-testid="reset-confirm-text">{preview.confirm}</code></p>
                            <div className="wizard-field">
                                <label htmlFor="reset-confirm-input">Confirmation</label>
                                <input id="reset-confirm-input" className="input" value={confirm} spellCheck={false} autoComplete="off" data-testid="reset-confirm-input"
                                    onChange={(event) => setConfirm(event.target.value)} />
                                {confirm.length > 0 && !confirmed && <span className="hint" data-testid="reset-confirm-mismatch">Not the same yet.</span>}
                            </div>
                        </>
                    ) : <p role="alert" className="settings-danger">Go back and choose what to reset.</p>}
                    <StepNav onBack={() => go('backup')} onNext={() => go('run')} nextLabel="Continue" nextDisabled={!confirmed} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'backup') {
        return (
            <JourneyFrame title="Reset">
                <StepFrame id="reset-backup" title="The backup first" lead="A reset only runs after a backup that has been written and verified. If it cannot be verified, nothing is removed.">
                    <div className="wizard-field">
                        <label htmlFor="reset-backup-dir">Where to write the backup</label>
                        <input id="reset-backup-dir" className="input" value={dir} spellCheck={false} data-testid="reset-backup-dir" onChange={(event) => setDir(event.target.value)} />
                        <span className="hint">Outside the data being removed.</span>
                    </div>
                    {preview?.backup.includesConfig && (
                        <>
                            <label className="wizard-choice">
                                <input type="checkbox" checked={skipConfig} onChange={(event) => setSkipConfig(event.target.checked)} data-testid="reset-skip-config" />
                                <span>Leave config.json out of the backup</span>
                            </label>
                            {!skipConfig && (
                                <div className="wizard-field">
                                    <label htmlFor="reset-passphrase">Passphrase for config.json in the backup</label>
                                    <input id="reset-passphrase" type="password" className="input" autoComplete="new-password" value={passphrase}
                                        onChange={(event) => setPassphrase(event.target.value)} data-testid="reset-passphrase" />
                                </div>
                            )}
                        </>
                    )}
                    <p className="wizard-callout">{ENCRYPTION_NOTE}</p>
                    <StepNav onBack={() => go('scope')} onNext={() => go('confirm')} nextLabel="Continue" nextDisabled={!backupReady} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    return (
        <JourneyFrame title="Reset">
            <StepFrame id="reset-scope" title="Reset data" lead="Empty one dormant feature&apos;s data, or all of the application's data. Settings, accounts of the manager and the program files are never touched.">
                <fieldset className="wizard-fieldset">
                    <legend>What to reset</legend>
                    <label className="wizard-choice">
                        <input type="radio" name="reset-scope" checked={scope === 'feature'} onChange={() => { setScope('feature'); setPreviewKey(''); }} data-testid="reset-scope-feature" />
                        <span><strong>One feature</strong> that is turned off: its data only.</span>
                    </label>
                    {scope === 'feature' && (
                        <div className="wizard-field">
                            <label htmlFor="reset-feature">Feature id</label>
                            <input id="reset-feature" className="input" value={feature} spellCheck={false} data-testid="reset-feature"
                                onChange={(event) => { setFeature(event.target.value.trim()); setPreviewKey(''); }} />
                            <span className="hint">The id as the Features page shows it. The feature has to be off first.</span>
                        </div>
                    )}
                    <label className="wizard-choice">
                        <input type="radio" name="reset-scope" checked={scope === 'instance'} onChange={() => { setScope('instance'); setPreviewKey(''); }} data-testid="reset-scope-instance" />
                        <span><strong>The whole instance</strong>: every application table, the vector index and every owned data folder.</span>
                    </label>
                </fieldset>
                <p>
                    <button type="button" className="btn" disabled={!featureOk || !wanted} data-testid="reset-preview"
                        onClick={() => setPreviewKey(`${wanted}:${Date.now()}`)}>Show what would be removed</button>
                </p>
                {plan.isError && <p role="alert" className="settings-danger" data-testid="reset-preview-error" data-code={describeError(plan.error).code}>{describeError(plan.error).message}</p>}
                {preview && <ResetPreviewView preview={preview} />}
                <StepNav onBack={() => go('home')} backLabel="Cancel" onNext={() => go('backup')} nextLabel="Continue"
                    nextDisabled={!preview || preview.featureActive === true} />
            </StepFrame>
        </JourneyFrame>
    );
}

function ResetPreviewView({ preview }: { preview: ResetPreview }) {
    const rows = preview.tables.cleared.reduce((sum, entry) => sum + (entry.rows || 0), 0);
    const bytes = preview.files.reduce((sum, set) => sum + (set.bytes || 0), 0);
    return (
        <div data-testid="reset-preview-view" data-empty={preview.empty ? 'true' : 'false'}>
            {preview.featureActive === true && (
                <p role="alert" className="settings-danger" data-testid="reset-feature-active">That feature is active. Turn it off first (Features page), restart, then reset its data.</p>
            )}
            {preview.empty && <p className="hint">There is nothing to remove for this scope.</p>}
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Tables emptied</dt><dd data-testid="reset-tables">{preview.tables.cleared.length}{rows > 0 ? ` (${rows} rows)` : ''}</dd></div>
                <div className="wizard-fact"><dt>Tables kept</dt><dd>{preview.tables.kept.length}</dd></div>
                <div className="wizard-fact"><dt>Data folders emptied</dt><dd data-testid="reset-files">{preview.files.length > 0 ? preview.files.map((set) => `${set.label}${set.files !== undefined ? ` (${set.files} files)` : ''}`).join(', ') : 'none'}{bytes > 0 ? `, ${formatBytes(bytes)}` : ''}</dd></div>
                <div className="wizard-fact"><dt>Backup</dt><dd>required first and verified ({preview.backup.verified}); config.json {preview.backup.includesConfig ? 'is included, encrypted' : 'is not included'}</dd></div>
            </dl>
            <p className="hint" data-testid="reset-boundary">{preview.boundary}</p>
        </div>
    );
}

function ResetResultView({ result }: { result: ResetResult | null }) {
    const tables = result?.outcome?.tables ? Object.keys(result.outcome.tables).length : null;
    return (
        <div data-testid="reset-done">
            <p role="status" className="wizard-success">The reset finished. The instance is paused.</p>
            {result && (
                <dl className="wizard-facts">
                    <div className="wizard-fact"><dt>Backup</dt><dd>{result.backup.verified ? 'written and verified before anything was removed' : 'not verified'}</dd></div>
                    {tables !== null && <div className="wizard-fact"><dt>Tables emptied</dt><dd>{tables}</dd></div>}
                    {result.outcome?.files?.total !== undefined && <div className="wizard-fact"><dt>Files removed</dt><dd>{result.outcome.files.total}</dd></div>}
                    <div className="wizard-fact"><dt>Maintenance</dt><dd>still held</dd></div>
                </dl>
            )}
            <p>Release maintenance when you are ready, then resume the instance (Host room, Instance page, Resume). They are separate controls.</p>
        </div>
    );
}
