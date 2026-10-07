import { useState } from 'react';
import type { DatabaseReport } from '../../lib/types';
import { DATABASE_PASSWORD, useAnswers } from '../answers';
import { ConnectionForm, TestConnection } from '../database/ConnectionForm';
import { EngineGuidance, ServerStorageBlock, StorageOwnership } from '../database/Explain';
import { connectionProblems, isLoopback, MANAGED_LATER, usable, type DatabaseAnswer, type FormProblem } from '../database/model';
import { Provision } from '../database/Provision';
import { useConfigReport, useSuggest } from '../data';
import { layoutFor } from '../model';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import type { StepProps } from './order';

/**
 * Where the data lives: one file on this machine, or a PostgreSQL server that
 * somebody already runs. A server the installer would set up itself (Docker or
 * a native package) is not offered yet and says so.
 */
export function Database({ go }: StepProps) {
    const suggest = useSuggest();
    const { answers, update } = useAnswers();
    const { fields } = useConfigReport();
    const data = suggest.data;
    const dataRoot = data?.roots.data;
    const sep = data?.separator || '/';
    const layout = layoutFor(answers, fields);
    const database = answers.database;
    const [report, setReport] = useState<DatabaseReport | null>(null);
    const [shown, setShown] = useState<FormProblem[]>([]);
    const postgres = database.engine === 'postgres';
    const setDatabase = (next: DatabaseAnswer) => update((previous) => ({
        ...previous,
        database: next,
        reenter: next.password ? previous.reenter.filter((id) => id !== DATABASE_PASSWORD) : previous.reenter
    }));
    const problems = postgres ? shown : [];
    const ready = !postgres || usable(report);

    return (
        <StepFrame id="database" title="Where does the data live?"
            lead="Goobster keeps people, conversations and memory in a database. Choose the one file on this machine, or a PostgreSQL server you already run.">
            {suggest.isError && <p role="alert" className="settings-danger">{describeError(suggest.error).message}</p>}
            <EngineGuidance layout={layout} engine={database.engine} />
            {data && (
                <fieldset className="wizard-fieldset">
                    <legend>Database</legend>
                    <div role="radiogroup" aria-label="Database engine">
                        <label className="wizard-choice">
                            <input type="radio" name="engine" checked={!postgres} onChange={() => { setReport(null); setDatabase({ ...database, engine: 'sqlite' }); }} data-testid="engine-sqlite" />
                            {' '}<strong>SQLite</strong> <span className="hint">a single file, nothing to run or maintain (recommended for one machine)</span>
                        </label>
                        <label className="wizard-choice">
                            <input type="radio" name="engine" checked={postgres} onChange={() => setDatabase({ ...database, engine: 'postgres' })} data-testid="engine-postgres-existing" />
                            {' '}<strong>An existing PostgreSQL server</strong> <span className="hint">one you or your host already run, on this machine or another</span>
                        </label>
                        <label className="wizard-choice" aria-disabled="true">
                            <input type="radio" name="engine" disabled aria-describedby="postgres-later" data-testid="engine-postgres-docker" />
                            {' '}<strong>A PostgreSQL server the installer sets up in Docker</strong>
                        </label>
                        <label className="wizard-choice" aria-disabled="true">
                            <input type="radio" name="engine" disabled aria-describedby="postgres-later" data-testid="engine-postgres-native" />
                            {' '}<strong>A PostgreSQL server the installer sets up on this machine</strong>{' '}
                            <span id="postgres-later" className="hint" data-testid="postgres-later">{MANAGED_LATER}</span>
                        </label>
                    </div>
                    {!postgres && (
                        <>
                            <dl className="wizard-facts">
                                <dt>Data folder</dt>
                                <dd data-testid="data-root"><code>{dataRoot?.path}</code> <span className="hint">{formatBytes(dataRoot?.freeBytes)} free</span></dd>
                                <dt>Database file</dt>
                                <dd><code>{`${dataRoot?.path}${sep}goobster.sqlite`}</code></dd>
                                <dt>Settings file</dt>
                                <dd><code>{data.roots.config.path}</code></dd>
                                <dt>Manager records</dt>
                                <dd><code>{data.roots.managerStore.path}</code></dd>
                            </dl>
                            <StorageOwnership engine="sqlite" />
                            <p className="hint">
                                These three belong to the manager that is running this page and are fixed for this installation; to put them somewhere else, start the manager with its
                                data folder set to that place. The installer creates the database file{answers.owner.create ? ' and the owner account' : ''} when you press Install.
                            </p>
                        </>
                    )}
                </fieldset>
            )}
            {postgres && (
                <>
                    <ConnectionForm value={database} onChange={(next) => setDatabase(next)} problems={problems} passwordLabel="Password of the application user" />
                    <TestConnection value={database} onReport={setReport} onProblems={setShown} />
                    <Provision value={database} report={report} onDone={() => setReport(null)} />
                    <ServerStorageBlock host={database.host} port={database.port} database={database.database} schema={database.schema} local={database.host !== '' && isLoopback(database.host)} />
                    <StorageOwnership engine="postgres" />
                    <p className="hint" data-testid="postgres-next-hint">
                        {ready
                            ? 'The server is ready. The installer creates Goobster\'s tables in it when you press Install.'
                            : 'Test the connection first; Continue unlocks when the server can be used. The installer never writes into a schema that holds anything else.'}
                    </p>
                </>
            )}
            <StepNav onBack={() => go('connections')}
                onNext={() => { if (postgres && !usable(report)) { setShown(connectionProblems(database)); return; } go('defaults'); }}
                nextDisabled={!data || (postgres && !ready)} />
        </StepFrame>
    );
}
