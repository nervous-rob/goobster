import { useAnswers } from '../answers';
import { useSuggest } from '../data';
import { describeError, formatBytes, StepFrame, StepNav } from '../ui';
import type { StepProps } from './order';

export const POSTGRES_LATER = 'Available in a later version of this installer';

/** Where the data lives. SQLite is the only engine this version sets up. */
export function Database({ go }: StepProps) {
    const suggest = useSuggest();
    const { answers } = useAnswers();
    const data = suggest.data;
    const dataRoot = data?.roots.data;
    const sep = data?.separator || '/';
    return (
        <StepFrame id="database" title="Where does the data live?"
            lead="Goobster keeps people, conversations and memory in one database file on this machine. You can back it up by copying the data folder.">
            {suggest.isError && <p role="alert" className="settings-danger">{describeError(suggest.error).message}</p>}
            {data && (
                <fieldset className="wizard-fieldset">
                    <legend>Database</legend>
                    <div role="radiogroup" aria-label="Database engine">
                        <label className="wizard-choice">
                            <input type="radio" name="engine" checked readOnly data-testid="engine-sqlite" />
                            {' '}<strong>SQLite</strong> <span className="hint">a single file, nothing to run or maintain (recommended for one machine)</span>
                        </label>
                        <label className="wizard-choice" aria-disabled="true">
                            <input type="radio" name="engine" disabled data-testid="engine-postgres" aria-describedby="postgres-later" />
                            {' '}<strong>Postgres</strong>{' '}
                            <span id="postgres-later" className="hint" data-testid="postgres-later">{POSTGRES_LATER}</span>
                        </label>
                    </div>
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
                    <p className="hint">
                        These three belong to the manager that is running this page and are fixed for this installation; to put them somewhere else, start the manager with its
                        data folder set to that place. The installer creates the database file{answers.owner.create ? ' and the owner account' : ''} when you press Install.
                    </p>
                </fieldset>
            )}
            <StepNav onBack={() => go('connections')} onNext={() => go('defaults')} nextDisabled={!data} />
        </StepFrame>
    );
}
