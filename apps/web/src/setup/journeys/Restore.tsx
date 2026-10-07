import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { BackupInspection, RestoreRetained, RestoreStatusView } from '../../lib/types';
import { useSuggest } from '../data';
import { OperationProgress, useRun } from '../run';
import { useTransport } from '../transport';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import { ENCRYPTION_NOTE, useBackupStatus } from './Backup';
import { BarrierPanel } from './barrier';
import { JourneyFrame, PlanFailure, usePlanCheck } from './common';

type RestorePlan = {
    archive: { dir: string; createdAt: string | null; engine: string; tables: number; rows: number; fileSets: Array<{ id: string; label: string; files: number }> };
    compatibility: { engineMatches: boolean; fingerprintMatches: boolean; schemaChanged: boolean };
    config: { included: boolean; encrypted: boolean; restore: boolean; skipped: string | null; passphraseVerified: boolean };
    database: { engine: string; occupied: boolean | null; rows: unknown };
    safetyBackup: { required: boolean; dir?: string; reason?: string; unknownOccupancy?: boolean };
    replaces: { database: boolean; fileSets: string[]; fileSetsAbsentInArchive: string[]; configJson: boolean };
    keptAside: string;
    afterwards: { instancePaused: boolean; maintenance: string; resume: string };
    secretsToReenter: string[];
    confirmation: { required: boolean; satisfied: boolean };
    resumeOf: { restoreId: string; status: string; done: string[] } | null;
    notes: string[];
};

type RestoreResult = {
    restoreId: string; archive: string; schemaChanged: boolean;
    files: Array<{ id: string; files: number }>;
    config: { restored: boolean; skipped: string | null };
    safetyBackup: { archive: string; dir: string; tables: number; rows: number } | null;
    interrupted: Record<string, number>; interruptedTotal: number;
    rowCounts: { tables: number; mismatches: unknown; matchesArchive: boolean };
    instancePaused: boolean;
    maintenance: { held: boolean; operationId?: string; fence?: number };
    workersMode?: string; workersRestarted: boolean;
    retained: RestoreRetained[]; secretsToReenter: string[]; resumed: boolean; next: string[];
};

const BLOCK_TEXT: Record<string, string> = {
    ENGINE_MISMATCH: 'This archive was made on a different database engine than this installation uses. A restore never converts between them.',
    ARCHIVE_INCOMPLETE: 'The archive is incomplete or damaged (a file is missing or does not match its checksum).',
    ARCHIVE_INSIDE_DATA: 'The archive is inside the manager\'s store or a data folder that a restore replaces. Copy it somewhere else first.',
    NOT_INSTALLED: 'There is no installation record to restore into.'
};

const WARNING_TEXT: Record<string, string> = {
    SCHEMA_CHANGED: 'The database layout changed since this archive was made. A restore can still go ahead if you accept that.',
    TAKEN_WHILE_RUNNING: 'The archive was taken while the application was running, so it is checked for completeness but not for being a single instant.'
};

/** What the manager recorded about the last restore: stays true after a reload and after the portal comes back. */
export function RestoreStatusPanel({ restore }: { restore: RestoreStatusView }) {
    return (
        <div className="wizard-callout" data-testid="restore-status" data-status={restore.status}>
            <p><strong>Last restore:</strong> {restore.status} (archive <code>{restore.archive}</code>{restore.completedAt ? `, finished ${restore.completedAt}` : ''}).</p>
            {restore.failure && <p role="alert">It stopped at <em>{restore.failure.substep || restore.failure.step}</em> ({restore.failure.code}).</p>}
            {restore.advice && <p data-testid="restore-advice">{restore.advice}</p>}
            {restore.retained.length > 0 && <RetainedList retained={restore.retained} />}
        </div>
    );
}

function RetainedList({ retained }: { retained: RestoreRetained[] }) {
    return (
        <div data-testid="restore-retained">
            <p>What the restore replaced was moved aside, never deleted:</p>
            <ul className="wizard-list">
                {retained.map((entry) => <li key={`${entry.kind}-${entry.path}`}>{entry.kind === 'safety-backup' ? 'safety backup' : entry.kind}{entry.id ? ` (${entry.id})` : ''}: <code>{entry.path}</code></li>)}
            </ul>
            <p className="hint">Delete these yourself once you are sure the restored data is right.</p>
        </div>
    );
}

/** Replace the database, the data files and (with the passphrase) config.json from an archive, inside the maintenance barrier. */
export function Restore({ step, id, go }: { step: string; id: string | null; go: (step: string, id?: string | null) => void }) {
    const transport = useTransport();
    const status = useBackupStatus();
    const suggest = useSuggest();
    const planner = usePlanCheck('backup.restore');
    const [dir, setDir] = useState('');
    const [inspectDir, setInspectDir] = useState('');
    const [withoutConfig, setWithoutConfig] = useState(false);
    const [passphrase, setPassphrase] = useState('');
    const [acceptSchemaChange, setAcceptSchemaChange] = useState(false);
    const [release, setRelease] = useState(false);
    const [confirm, setConfirm] = useState('');
    const [confirmTried, setConfirmTried] = useState(false);
    const run = useRun(step === 'progress' && id ? id : 'none');

    const inspection = useQuery({
        queryKey: ['setup', 'backup-inspect', inspectDir],
        queryFn: () => transport.backupInspect(inspectDir),
        enabled: inspectDir.length > 0,
        retry: false, staleTime: 0
    });
    const view: BackupInspection | undefined = inspection.data;

    useEffect(() => () => { setPassphrase(''); setConfirm(''); }, []);

    function input(withConfirm: string) {
        return {
            dir: dir.trim(),
            ...(withConfirm ? { confirm: withConfirm } : {}),
            withoutConfig,
            ...(!withoutConfig && passphrase ? { passphrase } : {}),
            ...(acceptSchemaChange ? { acceptSchemaChange: true } : {}),
            ...(release ? { release: true } : {})
        };
    }

    useEffect(() => {
        if (step === 'review' && planner.phase.kind === 'idle') {
            if (!dir.trim()) go('source');
            else void planner.check(input(''));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, planner.phase.kind]);

    const managerPort = suggest.data?.ports.manager ?? 3400;

    if (step === 'progress' && id) {
        return (
            <JourneyFrame title="Restore">
                <StepFrame id="restore-progress" title="Restoring"
                    lead="The application is stopped while the data is replaced. Do not stop the manager or restart the machine.">
                    {transport.mode === 'portal' && (
                        <p className="wizard-callout" data-testid="restore-disconnect-note">
                            The portal refuses changes while the restore runs and is restarted onto the restored data at the end, so this browser will lose its connection. That is expected.
                            Continue on the manager page, <code>http://127.0.0.1:{managerPort}/manager/</code> (open it from the machine, or through the SSH forward), which keeps answering.
                        </p>
                    )}
                    <OperationProgress run={run} title="Restore" autoStart
                        kept="What was replaced is kept aside, never deleted, and nothing is rolled back automatically. The maintenance barrier stays up."
                        failureHelp={<p>Run the same restore again to carry on from the first step that did not finish, or release maintenance and put the set-aside material back by hand. <a href="#/restore/source">Start again</a>.</p>}>
                        {run.phase === 'applied' && <RestoreResultView result={run.result as RestoreResult | null} canRelease={transport.mode === 'manager'} />}
                    </OperationProgress>
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'review') {
        const phase = planner.phase;
        const needsConfirm = phase.kind === 'failed' && phase.code === 'CONFIRMATION_REQUIRED';
        const operation = phase.kind === 'ready' ? phase.operation : (needsConfirm ? phase.operation : null);
        const plan = operation ? (operation.plan as unknown as RestorePlan) : null;
        const confirmed = phase.kind === 'ready';
        return (
            <JourneyFrame title="Restore">
                <StepFrame id="restore-review" title="Review the restore" lead="This is what will be replaced. Nothing has changed yet.">
                    {(phase.kind === 'checking' || phase.kind === 'idle') && <p role="status" className="hint">Checking the archive with the manager…</p>}
                    {phase.kind === 'failed' && !needsConfirm && (
                        <PlanFailure phase={phase} help={phase.code === 'BAD_PASSPHRASE' || phase.code === 'PASSPHRASE_REQUIRED'
                            ? <p>Nothing was changed. Go back and type the passphrase again, or choose to leave config.json as it is.</p> : undefined} />
                    )}
                    {plan && <RestorePlanView plan={plan} />}
                    {plan && (
                        <div className="wizard-field" data-testid="restore-confirm">
                            <label htmlFor="restore-confirm-input">Type this installation&apos;s id to confirm</label>
                            <input id="restore-confirm-input" className="input" value={confirm} spellCheck={false} autoComplete="off" data-testid="restore-confirm-input"
                                onChange={(event) => { setConfirm(event.target.value); setConfirmTried(false); }} />
                            <span className="hint">The id is shown on the installation page. A restore replaces the database; this is the deliberate confirmation.</span>
                            <p>
                                <button type="button" className="btn" disabled={confirm.trim().length === 0 || phase.kind === 'checking'} data-testid="restore-confirm-check"
                                    onClick={() => { setConfirmTried(true); void planner.check(input(confirm.trim())); }}>Check the confirmation</button>
                            </p>
                            {confirmTried && needsConfirm && <p role="alert" className="settings-danger" data-testid="restore-confirm-wrong">That is not this installation&apos;s id. Nothing was changed.</p>}
                            {confirmed && <p role="status" className="wizard-success" data-testid="restore-confirmed">Confirmed.</p>}
                        </div>
                    )}
                    <StepNav onBack={() => { planner.reset(); setConfirm(''); go('options'); }}
                        onNext={() => { if (phase.kind === 'ready') { setPassphrase(''); setConfirm(''); go('progress', phase.operation.id); } }}
                        nextLabel="Restore now" nextDisabled={!confirmed} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    if (step === 'options') {
        const archiveHasConfig = view?.configIncluded === true;
        return (
            <JourneyFrame title="Restore">
                <StepFrame id="restore-options" title="What to restore" lead="The database and the data files are always restored. config.json is restored only when the passphrase opens it.">
                    {archiveHasConfig ? (
                        <fieldset className="wizard-fieldset">
                            <legend>config.json</legend>
                            <label className="wizard-choice">
                                <input type="checkbox" checked={withoutConfig} onChange={(event) => setWithoutConfig(event.target.checked)} data-testid="restore-without-config" />
                                <span>Leave config.json as it is (restore without it)</span>
                            </label>
                            {!withoutConfig && (
                                <div className="wizard-field">
                                    <label htmlFor="restore-passphrase">Passphrase the backup was made with</label>
                                    <input id="restore-passphrase" type="password" className="input" autoComplete="off" value={passphrase}
                                        onChange={(event) => setPassphrase(event.target.value)} data-testid="restore-passphrase" />
                                    <span className="hint">A wrong passphrase is found before anything changes. It is held by this page only until the plan is made and stored nowhere.</span>
                                </div>
                            )}
                        </fieldset>
                    ) : <p className="hint" data-testid="restore-no-config">This archive has no config.json, so the current one is left as it is.</p>}
                    {view?.schemaChangeNeedsAcceptance && (
                        <label className="wizard-choice">
                            <input type="checkbox" checked={acceptSchemaChange} onChange={(event) => setAcceptSchemaChange(event.target.checked)} data-testid="restore-accept-schema" />
                            <span>Accept that the database layout changed since this archive was made</span>
                        </label>
                    )}
                    <label className="wizard-choice">
                        <input type="checkbox" checked={release} onChange={(event) => setRelease(event.target.checked)} data-testid="restore-release" />
                        <span>Release maintenance when the restore finishes (the instance stays paused either way)</span>
                    </label>
                    <StepNav onBack={() => go('source')}
                        onNext={() => { planner.reset(); go('review'); }}
                        nextLabel="Review the restore" nextDisabled={archiveHasConfig && !withoutConfig && passphrase.length === 0} />
                </StepFrame>
            </JourneyFrame>
        );
    }

    const lastRestore = status.data?.restore || null;
    return (
        <JourneyFrame title="Restore">
            <StepFrame id="restore-source" title="Restore from a backup"
                lead="Choose a backup folder. The manager reads it and says whether this installation can restore it. Nothing changes yet.">
                <p className="wizard-callout" data-testid="restore-warning">
                    A restore replaces the database and the data files with the archive&apos;s. The application is stopped while it runs, and it comes back <strong>paused</strong>.
                    What is replaced is moved aside, not deleted. {ENCRYPTION_NOTE}
                </p>
                {status.isError && <p role="alert" className="settings-danger">{describeError(status.error).message}</p>}
                {lastRestore && lastRestore.status !== 'completed' && <RestoreStatusPanel restore={lastRestore} />}
                <BarrierPanel canRelease={transport.mode === 'manager'} />
                <div className="wizard-field">
                    <label htmlFor="restore-dir">Folder of the backup</label>
                    <input id="restore-dir" className="input" value={dir} spellCheck={false} data-testid="restore-dir"
                        onChange={(event) => { setDir(event.target.value); }} />
                    <span className="hint">The folder a backup wrote, an absolute path{status.data?.suggestedDir ? `, for example below ${status.data.suggestedDir}` : ''}.</span>
                </div>
                <p>
                    <button type="button" className="btn" disabled={dir.trim().length === 0 || inspection.isFetching} data-testid="restore-inspect"
                        onClick={() => { if (inspectDir === dir.trim()) void inspection.refetch(); else setInspectDir(dir.trim()); }}>Inspect this backup</button>
                </p>
                {inspection.isError && <p role="alert" className="settings-danger" data-testid="restore-inspect-error" data-code={describeError(inspection.error).code}>{describeError(inspection.error).message}</p>}
                {view && <InspectionView view={view} />}
                <StepNav onBack={() => go('home')} backLabel="Cancel"
                    onNext={() => go('options')}
                    nextLabel="Continue" nextDisabled={!view || !view.restorable || inspectDir !== dir.trim()} />
            </StepFrame>
        </JourneyFrame>
    );
}

function InspectionView({ view }: { view: BackupInspection }) {
    const sets = view.fileSets.reduce((sum, set) => sum + (set.bytes || 0), 0);
    return (
        <div data-testid="restore-inspection" data-restorable={view.restorable ? 'true' : 'false'}>
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Made</dt><dd>{view.createdAt || 'unknown'}{view.version ? ` by Goobster ${view.version}` : ''}</dd></div>
                <div className="wizard-fact"><dt>Database</dt><dd>{view.engine}: {view.tables} tables, {view.rows} rows {view.engineMatches ? '(matches this installation)' : '(does NOT match this installation)'}</dd></div>
                <div className="wizard-fact"><dt>Files</dt><dd>{view.fileSets.length > 0 ? view.fileSets.map((set) => `${set.label} (${set.files})`).join(', ') : 'none'}{sets > 0 ? `, ${formatBytes(sets)}` : ''}</dd></div>
                <div className="wizard-fact"><dt>config.json</dt><dd data-testid="inspect-config">{view.configIncluded ? 'included, encrypted with the backup passphrase' : 'not included'}</dd></div>
                <div className="wizard-fact"><dt>The archive itself</dt><dd>{view.archiveEncrypted ? 'encrypted' : 'not encrypted'}</dd></div>
                <div className="wizard-fact"><dt>Whole</dt><dd>{view.integrity.ok ? 'every file matches its checksum' : `problems: ${view.integrity.problems.join(', ')}`}</dd></div>
                <div className="wizard-fact"><dt>Belongs here</dt><dd>{view.target.installationRecorded ? `the target is this installation${view.target.dataRootMatches === false ? ' (but its data root differs from the record)' : ''}` : 'there is no installation record'}</dd></div>
            </dl>
            {view.blocks.length > 0 && (
                <ul className="wizard-findings" data-testid="inspect-blocks">
                    {view.blocks.map((code) => <li key={code} data-severity="block" data-code={code}><span className="badge state-revoked">Blocks the restore</span> {BLOCK_TEXT[code] || code}</li>)}
                </ul>
            )}
            {view.warnings.length > 0 && (
                <ul className="wizard-findings" data-testid="inspect-warnings">
                    {view.warnings.map((code) => <li key={code} data-severity="warn" data-code={code}><span className="badge state-unverified">Worth knowing</span> {WARNING_TEXT[code] || code}</li>)}
                </ul>
            )}
            {view.restorable && <p role="status" className="wizard-success" data-testid="inspect-ok">This installation can restore this backup.</p>}
            {view.envSecretsToReenter.length > 0 && (
                <p className="hint" data-testid="inspect-secrets">The archive never holds these environment secrets; enter them again afterwards: {view.envSecretsToReenter.join(', ')}.</p>
            )}
        </div>
    );
}

function RestorePlanView({ plan }: { plan: RestorePlan }) {
    return (
        <div data-testid="restore-plan">
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Archive</dt><dd><code>{plan.archive.dir}</code> ({plan.archive.engine}, {plan.archive.tables} tables, {plan.archive.rows} rows)</dd></div>
                <div className="wizard-fact"><dt>Replaces</dt><dd data-testid="plan-replaces">the database{plan.replaces.fileSets.length > 0 ? `, ${plan.replaces.fileSets.join(', ')}` : ''}{plan.replaces.configJson ? ', config.json' : ''}</dd></div>
                <div className="wizard-fact"><dt>config.json</dt><dd data-testid="plan-config">{plan.config.restore ? 'restored (the passphrase opened it)' : `left as it is${plan.config.skipped ? ` (${plan.config.skipped})` : ''}`}</dd></div>
                <div className="wizard-fact"><dt>Safety backup</dt><dd>{plan.safetyBackup.required ? <>of what is there now, written to <code>{plan.safetyBackup.dir}</code> and verified first</> : (plan.safetyBackup.reason || 'not needed')}</dd></div>
                <div className="wizard-fact"><dt>Afterwards</dt><dd>the instance is paused and maintenance stays {plan.afterwards.maintenance === 'released' ? 'released' : 'held'}</dd></div>
            </dl>
            {plan.resumeOf && <p className="wizard-callout" data-testid="plan-resume-of">An earlier restore of this archive stopped part way; this one carries on from the first step that did not finish.</p>}
            <p className="hint">{plan.keptAside}</p>
            {plan.secretsToReenter.length > 0 && (
                <div data-testid="plan-secrets">
                    <p><strong>You will have to enter again:</strong></p>
                    <ul className="wizard-list">{plan.secretsToReenter.map((name) => <li key={name}>{name}</li>)}</ul>
                </div>
            )}
        </div>
    );
}

function RestoreResultView({ result, canRelease }: { result: RestoreResult | null; canRelease: boolean }) {
    const status = useBackupStatus();
    const fallback = status.data?.restore || null;
    if (!result) {
        return (
            <div data-testid="restore-done-reloaded">
                <p role="status" className="wizard-success">The restore finished.</p>
                {fallback && <RestoreStatusPanel restore={fallback} />}
                <BarrierPanel canRelease={canRelease} />
                <ResumeNote />
            </div>
        );
    }
    const kinds = Object.entries(result.interrupted).map(([name, count]) => `${count} ${name}`);
    return (
        <div data-testid="restore-done">
            <p role="status" className="wizard-success">The restore finished. The instance is paused.</p>
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Database</dt><dd>restored; {result.rowCounts.tables} tables, row counts {result.rowCounts.matchesArchive ? 'match the archive' : 'DO NOT all match the archive'}</dd></div>
                <div className="wizard-fact"><dt>Files</dt><dd>{result.files.length > 0 ? result.files.map((set) => `${set.id} (${set.files})`).join(', ') : 'none'}</dd></div>
                <div className="wizard-fact"><dt>config.json</dt><dd data-testid="result-config">{result.config.restored ? 'restored' : `left as it was${result.config.skipped ? ` (${result.config.skipped})` : ''}`}</dd></div>
                <div className="wizard-fact"><dt>Interrupted work</dt><dd data-testid="result-interrupted">{result.interruptedTotal} item{result.interruptedTotal === 1 ? '' : 's'} marked &quot;interrupted by restore&quot; and never retried{kinds.length > 0 ? ` (${kinds.join(', ')})` : ''}</dd></div>
                <div className="wizard-fact"><dt>Safety backup</dt><dd>{result.safetyBackup ? <code>{result.safetyBackup.dir}</code> : 'none (the target held no data)'}</dd></div>
                <div className="wizard-fact"><dt>Maintenance</dt><dd data-testid="result-maintenance">{result.maintenance.held ? 'still held' : 'released'}</dd></div>
                <div className="wizard-fact"><dt>Application processes</dt><dd>{result.workersRestarted ? 'restarted onto the restored data' : 'not restarted by the manager: restart them yourself so they open the restored database'}</dd></div>
            </dl>
            {result.secretsToReenter.length > 0 && (
                <div data-testid="result-secrets">
                    <p><strong>Enter these again:</strong></p>
                    <ul className="wizard-list">{result.secretsToReenter.map((name) => <li key={name}>{name}</li>)}</ul>
                </div>
            )}
            {result.retained.length > 0 && <RetainedList retained={result.retained} />}
            <BarrierPanel canRelease={canRelease} />
            <ResumeNote />
        </div>
    );
}

function ResumeNote() {
    return (
        <div data-testid="restore-resume-note">
            <p><strong>Coming back safely.</strong> Two separate controls, in this order:</p>
            <ol className="wizard-list">
                <li>Check the restored data. The instance is paused, so nothing scheduled runs yet.</li>
                <li>Release maintenance (above, or <code>node apps/manager/cli.js release</code>). This lets the application write again; it does not resume anything.</li>
                <li>Resume the instance: Host room, Instance page, Resume. Scheduled work starts again only then.</li>
            </ol>
        </div>
    );
}
