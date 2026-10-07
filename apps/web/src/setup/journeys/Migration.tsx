import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { MigrationPreflight, MigrationReportItem } from '../../lib/types';
import { useRecord } from '../data';
import { useTransport } from '../transport';
import { describeError, StepFrame, StepNav } from '../ui';
import { JourneyFrame } from './common';

export const MIGRATE_COMMANDS = [
    'node apps/manager/cli.js migrate preflight --answers pre.json',
    'node apps/manager/cli.js migrate run --answers run.json --confirm <installationId>',
    'node apps/manager/cli.js migrate status'
];

const STATE_TEXT: Record<string, string> = {
    none: 'No migration has been started on this installation.',
    unreadable: 'The migration record cannot be read; it was left as it is.'
};

function itemText(item: MigrationReportItem): string {
    const detail = item.detail === undefined || item.detail === null ? ''
        : (typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail));
    return `${item.code}${item.extension ? ` (${item.extension})` : ''}${detail ? `: ${detail}` : ''}${!detail && item.action ? `: ${item.action}` : ''}`;
}

/** SQLite to Postgres: where a migration stands, the rollback boundary, and a read-only preflight. The run itself is the command line. */
export function Migration({ go }: { step: string; id: string | null; go: (step: string, id?: string | null) => void }) {
    const transport = useTransport();
    const record = useRecord();
    const status = useQuery({ queryKey: ['setup', 'migrate-status'], queryFn: () => transport.migrateStatus(), retry: false, staleTime: 0, refetchInterval: 5000 });
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState<MigrationPreflight | null>(null);
    const [problem, setProblem] = useState<{ message: string; code: string } | null>(null);
    useEffect(() => () => setUrl(''), []);

    const preflight = transport.migratePreflight;
    const view = status.data;
    const engine = record.data?.record?.database?.engine;

    async function check() {
        if (!preflight) return;
        setBusy(true);
        setProblem(null);
        setReport(null);
        try {
            setReport(await preflight(url.trim()));
        } catch (error) {
            const described = describeError(error);
            setProblem({ message: described.message, code: described.code });
        } finally {
            setUrl('');
            setBusy(false);
        }
    }

    return (
        <JourneyFrame title="Migration">
            <StepFrame id="migration" title="Move to Postgres"
                lead="Move this installation's database from SQLite to Postgres. It is checked here without changing anything; the move itself runs from the command line on the machine.">
                {status.isError && <p role="alert" className="settings-danger" data-testid="migrate-status-error">{describeError(status.error).message}</p>}
                {engine === 'postgres' && <p className="hint" data-testid="migrate-already">This installation already uses Postgres. There is no path back to SQLite.</p>}
                {view && (
                    <div data-testid="migrate-status" data-state={view.state}>
                        <dl className="wizard-facts">
                            <div className="wizard-fact"><dt>State</dt><dd data-testid="migrate-state">{view.state}{STATE_TEXT[view.state] ? ` — ${STATE_TEXT[view.state]}` : ''}</dd></div>
                            {view.progress && <div className="wizard-fact"><dt>Copy</dt><dd>{view.progress.tablesDone} of {view.progress.tablesTotal} tables, {view.progress.rowsCopied} rows{view.progress.current ? `, now ${view.progress.current}` : ''}</dd></div>}
                            {view.failure && <div className="wizard-fact"><dt>Stopped at</dt><dd>{view.failure.step || 'unknown'}{view.failure.code ? ` (${view.failure.code})` : ''}</dd></div>}
                            <div className="wizard-fact"><dt>Rollback</dt><dd data-testid="migrate-rollback">{view.rollback.possible ? 'still possible' : `not possible (${view.rollback.reason || 'see below'})`}</dd></div>
                        </dl>
                        <p className="wizard-callout" data-testid="migrate-rollback-limit">{view.rollbackLimit}</p>
                    </div>
                )}

                <h3>Check a Postgres target</h3>
                {preflight ? (
                    <div data-testid="migrate-preflight-form">
                        <div className="wizard-field">
                            <label htmlFor="migrate-url">Postgres connection address</label>
                            <input id="migrate-url" type="password" className="input" autoComplete="off" spellCheck={false} value={url} data-testid="migrate-url"
                                onChange={(event) => setUrl(event.target.value)} placeholder="postgres://user:password@host:5432/database" />
                            <span className="hint">It holds the database password, so it is held by this page only while the check runs, and never stored, logged or put in the address bar.</span>
                        </div>
                        <p><button type="button" className="btn" disabled={busy || url.trim().length === 0} onClick={() => void check()} data-testid="migrate-preflight">{busy ? 'Checking…' : 'Check this target'}</button></p>
                    </div>
                ) : (
                    <p className="hint" data-testid="migrate-preflight-cli">
                        The connection address holds a password, so it is not typed into the portal. Check the target from the manager page, or with <code>{MIGRATE_COMMANDS[0]}</code>.
                    </p>
                )}
                {problem && <p role="alert" className="settings-danger" data-testid="migrate-preflight-error" data-code={problem.code}>{problem.message}</p>}
                {report && (
                    <div data-testid="migrate-report" data-ready={report.ready ? 'true' : 'false'}>
                        <p role="status" className={report.ready ? 'wizard-success' : 'settings-danger'} data-testid="migrate-ready">
                            {report.ready ? 'Ready: nothing stops this move.' : `Blocked: ${report.blocks.length} thing${report.blocks.length === 1 ? '' : 's'} to fix first.`}
                        </p>
                        {report.estimate && <p className="hint">{report.estimate.tables ?? '?'} tables, {report.estimate.rows ?? '?'} rows to copy.</p>}
                        {(['blocks', 'provisioning', 'warnings'] as const).map((group) => report[group].length > 0 && (
                            <div key={group} data-testid={`migrate-${group}`}>
                                <strong>{group === 'blocks' ? 'Blocks the move' : group === 'provisioning' ? 'Will be set up for you' : 'Worth knowing'}</strong>
                                <ul className="wizard-list">{report[group].map((item, index) => <li key={`${item.code}-${index}`} data-code={item.code}>{itemText(item)}</li>)}</ul>
                            </div>
                        ))}
                    </div>
                )}

                <h3>Running the move</h3>
                <p>The move backs up first, holds maintenance, copies and verifies every table, then switches. It runs from the command line on the machine, where it can show progress and be resumed:</p>
                <pre data-testid="migrate-commands"><code>{MIGRATE_COMMANDS.join('\n')}</code></pre>
                <p className="hint">The address and the backup passphrase go in an answers file (mode 0600) or a hidden prompt, never on the command line.</p>
                <StepNav onBack={() => go('home')} backLabel="Back" />
            </StepFrame>
        </JourneyFrame>
    );
}
