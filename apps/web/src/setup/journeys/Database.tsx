import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { DatabaseReport, DatabaseStatus } from '../../lib/types';
import { DATABASE_PASSWORD, useAnswers } from '../answers';
import { useDatabaseApi } from '../database/api';
import { ConnectionForm, TestConnection } from '../database/ConnectionForm';
import { ConnectPlan, SchemaPlan } from '../database/DatabasePlans';
import { EngineGuidance, FailureHelp, ServerStorageBlock, StorageOwnership, ThreeKinds } from '../database/Explain';
import { connectionBody, connectionProblems, isLoopback, usable, type DatabaseAnswer } from '../database/model';
import { Provision } from '../database/Provision';
import { blocks } from '../plan';
import { OperationProgress, useRun } from '../run';
import { describeError, StepFrame, StepNav } from '../ui';
import { JourneyFrame, PlanFailure, usePlanCheck } from './common';

type Go = (step: string, id?: string | null) => void;

const TITLE = 'Database';

const HELP_BY_CODE: Record<string, string> = {
    MIGRATION_REQUIRED: 'This installation\'s SQLite database holds data. Connecting it to an empty server would leave that data behind, so it is refused: moving the data is the migration (the `migrate` command of the manager, documented in the migration guide). Nothing was changed.',
    NOT_MANAGED: 'This installation was not set up by the manager, so the manager does not change where its data lives. Adopt it first.',
    SCHEMA_FOREIGN: 'That schema holds tables that are not Goobster\'s. Choose another schema or database; Goobster never writes into one that is shared.',
    SCHEMA_NEWER: 'That database was written by a newer release of Goobster. Update this installation rather than connecting it.',
    PROBE_BLOCKED: 'The server test found something that blocks this. Test the connection above and read what it says.',
    ENV_OVERRIDES_OVERLAY: 'The environment this manager runs in sets a database connection of its own, which wins over what is saved here. Remove it from the service environment, then try again.'
};

function statusKey(mode: string) { return ['database', 'status', mode]; }

function useDatabaseStatus() {
    const databaseApi = useDatabaseApi();
    return useQuery({ queryKey: statusKey('current'), queryFn: () => databaseApi.status(), retry: false, staleTime: 0, refetchInterval: 8000 });
}

function describeConnection(status: DatabaseStatus) {
    const connection = status.connection;
    return connection ? `${connection.host}:${connection.port}/${connection.database}${connection.schema && connection.schema !== 'public' ? ` (schema ${connection.schema})` : ''} as ${connection.user}` : 'not set';
}

function StatusView({ go }: { go: Go }) {
    const status = useDatabaseStatus();
    const data = status.data;
    const sqliteHasData = Boolean(data?.sqlite && data.sqlite.present && !data.sqlite.empty);
    return (
        <JourneyFrame title={TITLE}>
            <StepFrame id="database-status" title="Database" lead="Where this installation keeps its data, and the three different jobs that touch it.">
                {status.isError && <p role="alert" className="settings-danger">{describeError(status.error).message}</p>}
                {!data && !status.isError && <p role="status" className="hint">Reading the database settings…</p>}
                {data && (
                    <>
                        <dl className="wizard-facts" data-testid="database-facts">
                            <div className="wizard-fact"><dt>Engine</dt><dd data-testid="database-engine">{data.engine === 'postgres' ? 'PostgreSQL' : 'SQLite'}</dd></div>
                            {data.engine === 'postgres'
                                ? <div className="wizard-fact"><dt>Server</dt><dd><code data-testid="database-connection">{describeConnection(data)}</code> <span className="hint">(the password is not shown)</span></dd></div>
                                : <div className="wizard-fact"><dt>File</dt><dd data-testid="database-sqlite">{data.sqlite ? (data.sqlite.present ? (data.sqlite.empty ? 'present and empty' : `present, holds data (${data.sqlite.tables} tables)`) : 'not created yet') : 'unknown'}</dd></div>}
                            <div className="wizard-fact"><dt>Storage</dt><dd><StorageOwnership engine={data.engine} /></dd></div>
                        </dl>
                        {data.mismatch && (
                            <p role="alert" className="wizard-callout" data-testid="database-mismatch">
                                The installation record and the saved connection disagree. That is what a connection change that stopped half-way looks like: run the connection again to finish it.
                            </p>
                        )}
                        {data.maintenance?.active && (
                            <p role="status" className="wizard-callout" data-testid="database-maintenance">
                                Maintenance is on (phase {data.maintenance.phase || 'unknown'}). The application is held until it is released.
                            </p>
                        )}
                        {data.engine === 'sqlite' && sqliteHasData && (
                            <p role="status" className="wizard-callout" data-testid="database-migrate-hint">
                                This SQLite database holds data. To move it to a PostgreSQL server, use the migration (<code>node apps/manager/cli.js migrate</code>), not a connection change.
                            </p>
                        )}
                        {data.pairedRefusesSqlite && <p role="alert" className="settings-danger" data-testid="database-paired">This layout cannot run on SQLite.</p>}
                        <div className="wizard-actions">
                            <button type="button" className="btn primary" onClick={() => go('connect')} disabled={!data.managed} data-testid="database-connect">Connect to a PostgreSQL server…</button>
                            <button type="button" className="btn" onClick={() => go('schema')} disabled={!data.managed} data-testid="database-schema">Update the schema…</button>
                        </div>
                        <ThreeKinds />
                        <FailureHelp status={data} />
                    </>
                )}
                <StepNav onBack={() => go('home')} backLabel="Back to the installation" />
            </StepFrame>
        </JourneyFrame>
    );
}

/** The connection form, the test, and (for a connection) the preparation of the server. */
function ConnectionStep({ mode, go }: { mode: 'connect' | 'schema'; go: Go }) {
    const { answers, update } = useAnswers();
    const status = useDatabaseStatus();
    const database = answers.database;
    const [report, setReport] = useState<DatabaseReport | null>(null);
    const [shown, setShown] = useState(false);
    const setDatabase = (next: DatabaseAnswer) => update((previous) => ({
        ...previous,
        database: { ...next, engine: 'postgres' },
        reenter: next.password ? previous.reenter.filter((id) => id !== DATABASE_PASSWORD) : previous.reenter
    }));
    useEffect(() => {
        if (database.engine !== 'postgres') update((previous) => ({ ...previous, database: { ...previous.database, engine: 'postgres' } }));
    }, [database.engine, update]);
    const problems = shown ? connectionProblems(database) : [];
    const state = report?.schema?.state;
    const ready = mode === 'connect' ? usable(report) : Boolean(report && report.verdict.ok && (state === 'empty' || state === 'goobster-older'));
    const reason = mode === 'schema' && report && !ready && report.verdict.ok
        ? (state === 'goobster-current' ? 'The schema is already up to date: there is nothing to apply.' : 'The schema can only be applied to an empty schema or to Goobster\'s own older one.')
        : null;

    return (
        <JourneyFrame title={mode === 'connect' ? 'Connect to a server' : 'Update the schema'}>
            <StepFrame id={`database-${mode}`} title={mode === 'connect' ? 'Connect to a PostgreSQL server' : 'Update the schema'}
                lead={mode === 'connect'
                    ? 'Tell Goobster where an existing server is and how to sign in. This saves the connection; it moves no data.'
                    : 'Brings Goobster\'s tables up to date in a database it already uses, or creates them in an empty schema. Never touches a schema that holds anything else.'}>
                {mode === 'connect' && <EngineGuidance layout={status.data?.layout || 'lite'} engine="postgres" />}
                <ConnectionForm value={database} onChange={setDatabase} problems={problems} passwordLabel={mode === 'connect' ? 'Password of the application user' : 'Password'} />
                <TestConnection value={database} onReport={setReport} />
                {mode === 'connect' && <Provision value={database} report={report} onDone={() => setReport(null)} />}
                <ServerStorageBlock host={database.host} port={database.port} database={database.database} schema={database.schema} local={database.host !== '' && isLoopback(database.host)} />
                {reason && <p className="hint" role="status" data-testid="schema-reason">{reason}</p>}
                <StepNav onBack={() => go('status')}
                    onNext={() => { if (!ready) { setShown(true); return; } go(mode === 'connect' ? 'review-connect' : 'review-schema'); }}
                    nextLabel="Review" nextDisabled={!ready} />
            </StepFrame>
        </JourneyFrame>
    );
}

function Review({ mode, go }: { mode: 'connect' | 'schema'; go: Go }) {
    const { answers, update } = useAnswers();
    const [release, setRelease] = useState(true);
    const planner = usePlanCheck(mode === 'connect' ? 'database.connect' : 'database.schema.apply');
    const phase = planner.phase;
    const database = answers.database;
    const missing = connectionProblems(database).length > 0;

    useEffect(() => {
        if (phase.kind === 'idle' && !missing) {
            void planner.check({ connection: connectionBody(database), ...(mode === 'connect' && release ? { release: true } : {}) });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase.kind, missing]);

    const help = phase.kind === 'failed' ? HELP_BY_CODE[phase.code] : undefined;
    const back = () => { planner.reset(); go(mode === 'connect' ? 'connect' : 'schema'); };
    const begin = (id: string) => {
        update((previous) => ({ ...previous, database: { ...previous.database, password: '' } }));
        go('progress', id);
    };

    return (
        <JourneyFrame title="Review">
            <StepFrame id={`database-review-${mode}`} title={mode === 'connect' ? 'Review the connection' : 'Review the schema update'} lead="This is what will happen. Nothing has changed yet.">
                {missing && <p role="alert" className="settings-danger" data-testid="database-retype">This page does not keep the password. Go back and enter it again.</p>}
                {(phase.kind === 'checking' || (phase.kind === 'idle' && !missing)) && <p role="status" className="hint">Checking with the manager…</p>}
                {phase.kind === 'failed' && <PlanFailure phase={phase} help={help ? <p data-testid="plan-help">{help}</p> : undefined} />}
                {phase.kind === 'ready' && (
                    <>
                        {mode === 'connect' ? <ConnectPlan operation={phase.operation} /> : <SchemaPlan operation={phase.operation} />}
                        {mode === 'connect' && (
                            <label className="wizard-choice">
                                <input type="checkbox" checked={release} onChange={(event) => { setRelease(event.target.checked); planner.reset(); }} data-testid="database-release" />
                                {' '}Let the application start on the new database when the connection is saved <span className="hint">(otherwise maintenance stays on until you release it)</span>
                            </label>
                        )}
                        {blocks(phase.operation) && <p role="alert" className="settings-danger">The manager found something that blocks this.</p>}
                    </>
                )}
                <StepNav onBack={back}
                    onNext={phase.kind === 'ready' ? () => begin(phase.operation.id) : undefined}
                    nextLabel={mode === 'connect' ? 'Connect' : 'Apply the schema'} nextDisabled={phase.kind !== 'ready' || blocks(phase.operation)} />
            </StepFrame>
        </JourneyFrame>
    );
}

function Progress({ id, go }: { id: string; go: Go }) {
    const run = useRun(id);
    const kind = run.operation?.kind;
    const connecting = kind === 'database.connect';
    const released = Boolean((run.operation?.plan as { release?: boolean } | undefined)?.release);
    return (
        <JourneyFrame title={TITLE}>
            <StepFrame id="database-progress" title={connecting ? 'Connecting' : 'Updating the schema'}>
                <OperationProgress run={run} title={connecting ? 'Connect' : 'Schema update'} autoStart
                    kept="Nothing else was changed: the data in the old database and the server's other databases are untouched."
                    failureHelp={<p>Fix what the step says, then <a href="#/database/status">start again</a>. Each step is safe to repeat.</p>}>
                    {run.phase === 'applied' && (
                        <div data-testid="database-done">
                            <p role="status" className="wizard-success">{connecting ? 'The connection is saved and the new database passed its checks.' : 'The schema is up to date.'}</p>
                            {connecting && !released && (
                                <p className="wizard-callout" data-testid="database-barrier-up">
                                    Maintenance is still on, so the application has not started on the new database. Release it when you are ready:
                                    {' '}<code>node apps/manager/cli.js release</code>.
                                </p>
                            )}
                            {connecting && released && <p className="hint">Maintenance is off. Restart the application from the Host room so it opens the new connection.</p>}
                            <div className="wizard-actions"><button type="button" className="btn" onClick={() => go('status')} data-testid="database-back">Back to the database</button></div>
                        </div>
                    )}
                </OperationProgress>
            </StepFrame>
        </JourneyFrame>
    );
}

/** Connecting an installation to an existing PostgreSQL server, and updating its schema. */
export function DatabaseJourney({ step, id, go }: { step: string; id: string | null; go: Go }) {
    if (step === 'progress' && id) return <Progress id={id} go={go} />;
    if (step === 'connect' || step === 'schema') return <ConnectionStep mode={step} go={go} />;
    if (step === 'review-connect') return <Review mode="connect" go={go} />;
    if (step === 'review-schema') return <Review mode="schema" go={go} />;
    return <StatusView go={go} />;
}
