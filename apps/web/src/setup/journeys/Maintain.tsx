import { useRecord, useSuggest } from '../data';
import { HealthPanel } from '../health';
import { LAYOUT_TEXT, summarizeRoots } from '../model';
import { describeError, StepFrame } from '../ui';
import { useState } from 'react';
import { useTransport, type FirstRun } from '../transport';

/** An installation that exists: what it is, whether it works, and the three things you can do to it. */
export function Maintain({ go, recovery }: { go: (journey: string, step?: string) => void; recovery?: boolean }) {
    const transport = useTransport();
    const record = useRecord();
    const suggest = useSuggest();
    const [health, setHealth] = useState<FirstRun | null>(null);
    const data = record.data?.record;
    const databaseBroken = health?.checks.some((check) => check.id === 'database' && !check.ok) === true;
    return (
        <StepFrame id="maintain" title={recovery ? 'Recover this installation' : 'This installation'}
            lead={recovery
                ? 'You unlocked this with a recovery credential. Repair puts the program files and the database back without touching your data.'
                : 'Change how it is set up, put it right if something broke, or remove it.'}>
            {record.isError && <p role="alert" className="settings-danger">{describeError(record.error).message}</p>}
            {data && (
                <dl className="wizard-facts" data-testid="record-facts">
                    <div className="wizard-fact"><dt>Installation</dt><dd><code data-testid="installation-id">{data.installationId}</code></dd></div>
                    <div className="wizard-fact"><dt>Layout</dt><dd>{data.layout} <span className="hint">{LAYOUT_TEXT[data.layout || ''] || ''}</span></dd></div>
                    <div className="wizard-fact"><dt>Version</dt><dd>{data.release ? `${String(data.release.version || data.release.releaseId)} with ${data.release.features.length} optional part${data.release.features.length === 1 ? '' : 's'}` : 'Adopted, not installed by the manager'}</dd></div>
                    <div className="wizard-fact"><dt>Database</dt><dd>{data.database?.engine}</dd></div>
                    {summarizeRoots(data.roots).map(([name, value]) => <div key={name} className="wizard-fact"><dt>{name}</dt><dd><code>{value}</code></dd></div>)}
                </dl>
            )}
            {record.data && !record.data.installed && <p className="hint" data-testid="not-installed">There is no installation to maintain yet. <a href="#/setup/welcome">Start the setup.</a></p>}
            {databaseBroken && (
                <p className="wizard-callout" role="alert" data-testid="repair-recommended">
                    The database could not be opened. <strong>Repair</strong> opens it again and applies the schema without touching your data.
                </p>
            )}
            <div className="wizard-actions" data-testid="maintain-actions">
                <button type="button" className="btn" onClick={() => go('reconfigure', 'edit')} disabled={!record.data?.installed} data-testid="action-reconfigure">Reconfigure…</button>
                <button type="button" className={`btn${databaseBroken || recovery ? ' primary' : ''}`} onClick={() => go('repair', 'scope')} disabled={!record.data?.installed} data-testid="action-repair">Repair…</button>
                <button type="button" className="btn danger" onClick={() => go('uninstall', 'choose')} disabled={!record.data?.installed} data-testid="action-uninstall">Uninstall…</button>
                <button type="button" className="btn" onClick={() => go('database', 'status')} disabled={!record.data?.installed} data-testid="action-database">Database…</button>
            </div>
            {suggest.data && data && <p className="hint">Logs are in <code>{data.roots?.logs}</code>.</p>}
            {data && <HealthPanel onResult={setHealth} canStart={transport.mode === 'manager'} />}
        </StepFrame>
    );
}
