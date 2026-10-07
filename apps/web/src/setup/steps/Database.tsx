import { useState } from 'react';
import type { DatabaseReport } from '../../lib/types';
import { DATABASE_PASSWORD, useAnswers } from '../answers';
import { ConnectionForm, TestConnection } from '../database/ConnectionForm';
import { DockerOption, dockerReady, gateOf, useDockerStatus } from '../database/DockerOption';
import { NativeOption, nativeBlockText, nativeGateOf, nativeReady, useNativeStatus } from '../database/NativeOption';
import { EngineGuidance, ServerStorageBlock, StorageOwnership } from '../database/Explain';
import { connectionProblems, DOCKER_LABEL, isLoopback, NATIVE_LABEL, usable, type DatabaseAnswer, type FormProblem } from '../database/model';
import { Provision } from '../database/Provision';
import { useConfigReport, useSuggest } from '../data';
import { layoutFor } from '../model';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import type { StepProps } from './order';

/**
 * Where the data lives: one file on this machine, a PostgreSQL server that
 * somebody already runs, or one the installer runs in Docker (enabled only
 * once the daemon check passes) or natively on this machine (enabled only
 * when the host check passes).
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
    const dockerQuery = useDockerStatus();
    const gate = gateOf(dockerQuery);
    const nativeGate = nativeGateOf(useNativeStatus());
    const postgres = database.engine === 'postgres';
    const docker = postgres && database.source === 'docker';
    const native = postgres && database.source === 'native';
    const existing = postgres && !docker && !native;
    const dockerCheck = docker ? dockerReady(database.docker, gate) : { ok: true, problems: [] };
    const nativeCheck = native ? nativeReady(database.native, nativeGate) : { ok: true, problems: [] };
    const setDatabase = (next: DatabaseAnswer) => update((previous) => ({
        ...previous,
        database: next,
        reenter: next.password ? previous.reenter.filter((id) => id !== DATABASE_PASSWORD) : previous.reenter
    }));
    const problems = existing ? shown : [];
    const ready = !postgres || (docker ? dockerCheck.ok : native ? nativeCheck.ok : usable(report));

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
                            <input type="radio" name="engine" checked={!postgres} onChange={() => { setReport(null); setShown([]); setDatabase({ ...database, engine: 'sqlite' }); }} data-testid="engine-sqlite" />
                            {' '}<strong>SQLite</strong> <span className="hint">a single file, nothing to run or maintain (recommended for one machine)</span>
                        </label>
                        <label className="wizard-choice">
                            <input type="radio" name="engine" checked={existing} onChange={() => setDatabase({ ...database, engine: 'postgres', source: 'existing' })} data-testid="engine-postgres-existing" />
                            {' '}<strong>An existing PostgreSQL server</strong> <span className="hint">one you or your host already run, on this machine or another</span>
                        </label>
                        <label className="wizard-choice" aria-disabled={gate.state === 'ready' ? undefined : 'true'}>
                            <input type="radio" name="engine" checked={docker} disabled={gate.state !== 'ready'} aria-describedby="docker-availability"
                                onChange={() => { setReport(null); setDatabase({ ...database, engine: 'postgres', source: 'docker' }); }} data-testid="engine-postgres-docker" />
                            {' '}<strong>{DOCKER_LABEL}</strong>{' '}
                            <span id="docker-availability" className="hint" data-testid="docker-availability">
                                {gate.state === 'ready' && 'Docker answered; the installer creates and looks after one container for Goobster.'}
                                {gate.state === 'checking' && 'Checking Docker…'}
                                {gate.state === 'unavailable' && `Not available: ${gate.reason}`}
                                {gate.state === 'blocked' && `Not available: ${gate.reason}`}
                            </span>
                        </label>
                        <label className="wizard-choice" aria-disabled={nativeGate.state === 'ready' ? undefined : 'true'}>
                            <input type="radio" name="engine" checked={native} disabled={nativeGate.state !== 'ready'} aria-describedby="native-availability"
                                onChange={() => { setReport(null); setDatabase({ ...database, engine: 'postgres', source: 'native' }); }} data-testid="engine-postgres-native" />
                            {' '}<strong>{NATIVE_LABEL}</strong>{' '}
                            <span id="native-availability" className="hint" data-testid="native-availability">
                                {nativeGate.state === 'ready' && 'This machine can run it; the installer creates and looks after one cluster for Goobster and leaves any other alone.'}
                                {nativeGate.state === 'checking' && 'Checking this machine…'}
                                {(nativeGate.state === 'unavailable' || nativeGate.state === 'blocked') && `Not available: ${nativeBlockText(nativeGate)}`}
                            </span>
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
            {docker && (
                <>
                    <DockerOption value={database.docker} onChange={(next) => setDatabase({ ...database, docker: next })} problems={shown} />
                    <StorageOwnership engine="postgres" docker />
                    <p className="hint" data-testid="docker-next-hint">
                        {ready
                            ? 'Docker is ready. The installer creates the container, the application\'s role and Goobster\'s tables when you press Install.'
                            : 'Continue unlocks when the check above passes and what it asks for is ticked.'}
                    </p>
                </>
            )}
            {native && (
                <>
                    <NativeOption value={database.native} onChange={(next) => setDatabase({ ...database, native: next })} problems={shown} />
                    <StorageOwnership engine="postgres" native />
                    <p className="hint" data-testid="native-next-hint">
                        {ready
                            ? 'This machine is ready. The installer installs what you approved, creates the cluster, the application\'s role and Goobster\'s tables when you press Install.'
                            : 'Continue unlocks when the check above passes and what it asks for is ticked.'}
                    </p>
                </>
            )}
            {existing && (
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
                onNext={() => {
                    if (docker && !dockerCheck.ok) { setShown(dockerCheck.problems); return; }
                    if (native && !nativeCheck.ok) { setShown(nativeCheck.problems); return; }
                    if (existing && !usable(report)) { setShown(connectionProblems(database)); return; }
                    go('defaults');
                }}
                nextDisabled={!data || (postgres && !ready)} />
        </StepFrame>
    );
}
