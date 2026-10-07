import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { OperationProgress, useRun } from '../run';
import { useTransport } from '../transport';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import { JourneyFrame, PlanFailure, usePlanCheck } from './common';

type BackupPlan = {
    destination: string; engine: string;
    fileSets: Array<{ id: string; label: string }>;
    config: { included: boolean; encrypted: boolean; reason: string | null };
    archiveEncrypted: boolean; omittedSecrets: string[];
    maintenance: { held: boolean; comparedWith: string };
    notes: string[];
};

type BackupResult = {
    archive: string; dir: string; createdAt: string; engine: string; verified: boolean; verifiedAgainst: string;
    tables: number; rows: number; files: number;
    fileSets: Array<{ id: string; label?: string; files: number; bytes?: number }> | string[];
    config: { included: boolean; encrypted: boolean }; archiveEncrypted: boolean; omittedSecrets: string[]; next: string;
};

export const ENCRYPTION_NOTE = 'Only config.json is encrypted, with the passphrase you give. The database and the files in the archive are not encrypted: keep the archive on protected storage.';

export function backupStatusKey() {
    return ['setup', 'backup-status'];
}

export function useBackupStatus() {
    const transport = useTransport();
    return useQuery({ queryKey: backupStatusKey(), queryFn: () => transport.backupStatus(), retry: false, staleTime: 0 });
}

/** Write a verified archive of the database, the data files and (encrypted) config.json. It only reads the application. */
export function Backup({ step, id, go }: { step: string; id: string | null; go: (step: string, id?: string | null) => void }) {
    const status = useBackupStatus();
    const planner = usePlanCheck('backup.create');
    const [dir, setDir] = useState('');
    const [touched, setTouched] = useState(false);
    const [includeConfig, setIncludeConfig] = useState(true);
    const [passphrase, setPassphrase] = useState('');
    const [repeat, setRepeat] = useState('');
    const run = useRun(step === 'progress' && id ? id : 'none');

    useEffect(() => {
        if (!touched && !dir && status.data?.suggestedDir) setDir(status.data.suggestedDir);
    }, [status.data, touched, dir]);

    useEffect(() => () => { setPassphrase(''); setRepeat(''); }, []);

    const mismatch = includeConfig && passphrase !== repeat;
    const formReady = dir.trim().length > 0 && (!includeConfig || (passphrase.length > 0 && !mismatch));

    function input() {
        return { dir: dir.trim(), includeConfig, ...(includeConfig ? { passphrase } : {}) };
    }

    useEffect(() => {
        if (step === 'review' && planner.phase.kind === 'idle') {
            if (!formReady) go('form');
            else void planner.check(input());
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, planner.phase.kind]);

    if (step === 'progress' && id) {
        return (
            <JourneyFrame title="Backup">
                <StepFrame id="backup-progress" title="Writing the backup">
                    <OperationProgress run={run} title="Backup" autoStart
                        kept="Nothing in the application was changed: a backup only reads it."
                        failureHelp={<p>A partly written archive is not safe to rely on. <a href="#/backup/form">Start the backup again</a>.</p>}>
                        {run.phase === 'applied' && <BackupResultView result={run.result as BackupResult | null} />}
                    </OperationProgress>
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'review') {
        const phase = planner.phase;
        const plan = phase.kind === 'ready' ? (phase.operation.plan as unknown as BackupPlan) : null;
        return (
            <JourneyFrame title="Backup">
                <StepFrame id="backup-review" title="Review the backup" lead="This is what will be written. Nothing has been written yet.">
                    {(phase.kind === 'checking' || phase.kind === 'idle') && <p role="status" className="hint">Checking with the manager…</p>}
                    {phase.kind === 'failed' && <PlanFailure phase={phase} />}
                    {plan && (
                        <div data-testid="backup-plan">
                            <dl className="wizard-facts">
                                <div className="wizard-fact"><dt>Destination</dt><dd><code data-testid="backup-destination">{plan.destination}</code></dd></div>
                                <div className="wizard-fact"><dt>Database</dt><dd>{plan.engine}, written to the archive unencrypted</dd></div>
                                <div className="wizard-fact"><dt>Files</dt><dd>{plan.fileSets.length > 0 ? plan.fileSets.map((set) => set.label).join(', ') : 'none present'}</dd></div>
                                <div className="wizard-fact"><dt>config.json</dt><dd data-testid="backup-config-state">{plan.config.included ? 'included, encrypted with your passphrase' : `not included (${plan.config.reason || 'left out'})`}</dd></div>
                                <div className="wizard-fact"><dt>The archive itself</dt><dd data-testid="backup-archive-encrypted">{plan.archiveEncrypted ? 'encrypted' : 'not encrypted'}</dd></div>
                                <div className="wizard-fact"><dt>Checked against</dt><dd>{plan.maintenance.comparedWith === 'live-counts' ? 'the live row counts (maintenance is held)' : 'the archive itself (the application keeps running)'}</dd></div>
                            </dl>
                            <p className="wizard-callout" data-testid="backup-encryption-note">{ENCRYPTION_NOTE}</p>
                            {plan.omittedSecrets.length > 0 && (
                                <div data-testid="backup-omitted">
                                    <p><strong>Never in the archive</strong> (environment secrets; enter them again after a restore):</p>
                                    <ul className="wizard-list">{plan.omittedSecrets.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
                                </div>
                            )}
                        </div>
                    )}
                    <StepNav onBack={() => { planner.reset(); go('form'); }}
                        onNext={phase.kind === 'ready' ? () => { setPassphrase(''); setRepeat(''); go('progress', phase.operation.id); } : undefined}
                        nextLabel="Write the backup" nextDisabled={phase.kind !== 'ready'} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    return (
        <JourneyFrame title="Backup">
            <StepFrame id="backup-form" title="Back up this installation"
                lead="Write a verified copy of the database, the data files and (optionally) config.json. It only reads the application, so Goobster keeps running.">
                {status.isError && <p role="alert" className="settings-danger">{describeError(status.error).message}</p>}
                <div className="wizard-field">
                    <label htmlFor="backup-dir">Where to write it</label>
                    <input id="backup-dir" className="input" value={dir} spellCheck={false} data-testid="backup-dir"
                        onChange={(event) => { setTouched(true); setDir(event.target.value); }} />
                    <span className="hint">A folder outside the manager&apos;s store and the data folders it copies. The backup goes in a dated folder inside it; the folder is created if it does not exist. Suggested from this installation&apos;s locations{status.data?.engine ? ` (${status.data.engine} database)` : ''}.</span>
                </div>
                <label className="wizard-choice">
                    <input type="checkbox" checked={includeConfig} onChange={(event) => setIncludeConfig(event.target.checked)} data-testid="backup-include-config" />
                    <span>Include config.json (Discord token and provider keys kept there). It is encrypted with a passphrase.</span>
                </label>
                {includeConfig && (
                    <fieldset className="wizard-fieldset">
                        <legend>Passphrase for config.json</legend>
                        <div className="wizard-field">
                            <label htmlFor="backup-passphrase">Passphrase</label>
                            <input id="backup-passphrase" type="password" className="input" autoComplete="new-password" value={passphrase}
                                onChange={(event) => setPassphrase(event.target.value)} data-testid="backup-passphrase" />
                        </div>
                        <div className="wizard-field">
                            <label htmlFor="backup-passphrase-repeat">Type it again</label>
                            <input id="backup-passphrase-repeat" type="password" className="input" autoComplete="new-password" value={repeat}
                                onChange={(event) => setRepeat(event.target.value)} data-testid="backup-passphrase-repeat" />
                            {mismatch && repeat.length > 0 && <span role="alert" className="settings-danger">The two do not match.</span>}
                        </div>
                        <p className="hint">The passphrase is held by this page only until the plan is made, and stored nowhere. Without it config.json cannot be restored; write it down.</p>
                    </fieldset>
                )}
                {!includeConfig && <p className="hint" data-testid="backup-without-config">config.json is left out on purpose. After a restore you will need to recreate it.</p>}
                <p className="wizard-callout" data-testid="backup-encryption-note-form">{ENCRYPTION_NOTE}</p>
                <StepNav onBack={() => go('home')} backLabel="Cancel" onNext={() => { planner.reset(); go('review'); }} nextLabel="Review the backup" nextDisabled={!formReady} />
            </StepFrame>
        </JourneyFrame>
    );
}

function BackupResultView({ result }: { result: BackupResult | null }) {
    if (!result) return <p className="hint">The backup finished and was verified. This page was reloaded, so it no longer has the details: they are in the folder you gave.</p>;
    const bytes = Array.isArray(result.fileSets) ? (result.fileSets as Array<{ bytes?: number }>).reduce((sum, set) => sum + (typeof set === 'object' ? (set.bytes || 0) : 0), 0) : 0;
    return (
        <div data-testid="backup-done">
            <p role="status" className="wizard-success">The backup is written and verified.</p>
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Archive</dt><dd><code data-testid="backup-archive">{result.dir}</code></dd></div>
                <div className="wizard-fact"><dt>Verified against</dt><dd>{result.verifiedAgainst === 'live-counts' ? 'the live row counts' : 'the archive itself'}</dd></div>
                <div className="wizard-fact"><dt>Database</dt><dd>{result.tables} tables, {result.rows} rows ({result.engine})</dd></div>
                <div className="wizard-fact"><dt>Files</dt><dd>{result.files} files{bytes > 0 ? `, ${formatBytes(bytes)}` : ''}</dd></div>
                <div className="wizard-fact"><dt>config.json</dt><dd>{result.config.included ? 'included, encrypted' : 'not included'}</dd></div>
                <div className="wizard-fact"><dt>The archive itself</dt><dd>{result.archiveEncrypted ? 'encrypted' : 'not encrypted'}</dd></div>
            </dl>
            <div data-testid="backup-omitted-result">
                <p><strong>Not in the archive</strong> (enter these again after a restore):</p>
                {result.omittedSecrets.length > 0
                    ? <ul className="wizard-list">{result.omittedSecrets.map((name) => <li key={name}><code>{name}</code></li>)}</ul>
                    : <p className="hint">No environment secrets were set.</p>}
            </div>
            <p className="hint">{result.next}</p>
        </div>
    );
}
