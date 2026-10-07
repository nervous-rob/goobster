import { useEffect, useState, type ReactElement } from 'react';
import type { DatabaseReport } from '../../lib/types';
import { describeError, ErrorSummary } from '../ui';
import { useDatabaseApi } from './api';
import { connectionBody, connectionProblems, signatureOf, TLS_CHOICES, type DatabaseAnswer, type FormProblem } from './model';
import { ProbeReport } from './ProbeReport';

type Props = {
    value: DatabaseAnswer;
    onChange: (next: DatabaseAnswer) => void;
    problems?: FormProblem[];
    /** The application role's password is typed here; a provisioning run creates the role with it. */
    passwordLabel?: string;
};

/** Host, port, database, schema, user, secret, TLS and the optional CA file. The secret stays in this page's memory. */
export function ConnectionForm({ value, onChange, problems = [], passwordLabel = 'Password' }: Props) {
    const set = <K extends keyof DatabaseAnswer>(key: K, next: DatabaseAnswer[K]) => onChange({ ...value, [key]: next });
    const problemOf = (field: string) => problems.find((problem) => problem.field === field)?.message;
    const tls = TLS_CHOICES.find((choice) => choice.value === value.tlsMode) || TLS_CHOICES[0];
    const field = (id: string, label: string, input: ReactElement, help?: string) => (
        <div className="wizard-field">
            <label htmlFor={id}>{label}</label>
            {input}
            {help && <span className="hint" id={`${id}-help`}>{help}</span>}
            {problemOf(id) && <span className="settings-danger" role="alert" data-testid={`${id}-problem`}>{problemOf(id)}</span>}
        </div>
    );
    return (
        <fieldset className="wizard-fieldset" data-testid="db-connection-form">
            <legend>Connection to the server</legend>
            {field('db-host', 'Host', <input id="db-host" className="input" value={value.host} spellCheck={false} autoComplete="off" aria-describedby="db-host-help"
                onChange={(event) => set('host', event.target.value)} data-testid="db-host" />, 'The name or address of the server, as this machine reaches it. Not a URL.')}
            {field('db-port', 'Port', <input id="db-port" className="input" inputMode="numeric" value={value.port} spellCheck={false} autoComplete="off"
                onChange={(event) => set('port', event.target.value)} data-testid="db-port" />, 'PostgreSQL listens on 5432 unless its administrator changed it.')}
            {field('db-database', 'Database', <input id="db-database" className="input" value={value.database} spellCheck={false} autoComplete="off"
                onChange={(event) => set('database', event.target.value)} data-testid="db-database" />)}
            {field('db-schema', 'Schema', <input id="db-schema" className="input" value={value.schema} spellCheck={false} autoComplete="off" aria-describedby="db-schema-help"
                onChange={(event) => set('schema', event.target.value)} data-testid="db-schema" />, 'Goobster creates its tables here and never in another schema. It must hold nothing that is not Goobster\'s. Default: public.')}
            {field('db-user', 'User', <input id="db-user" className="input" value={value.user} spellCheck={false} autoComplete="off"
                onChange={(event) => set('user', event.target.value)} data-testid="db-user" />, 'The role Goobster runs as. Use a role of its own, not a superuser.')}
            {field('db-password', passwordLabel, <input id="db-password" className="input" type="password" value={value.password} autoComplete="new-password" aria-describedby="db-password-help"
                onChange={(event) => set('password', event.target.value)} data-testid="db-password" />,
            'Sent once to the manager for a test or a plan and then forgotten by this page. It is saved only inside the connection the manager writes to its own private file.')}
            {field('db-tls', 'Encryption (TLS)', (
                <select id="db-tls" className="select" value={value.tlsMode} aria-describedby="db-tls-help"
                    onChange={(event) => set('tlsMode', event.target.value as DatabaseAnswer['tlsMode'])} data-testid="db-tls">
                    {TLS_CHOICES.map((choice) => <option key={choice.value || 'default'} value={choice.value}>{choice.label}</option>)}
                </select>
            ), tls.help)}
            {field('db-ca', 'CA file (optional)', <input id="db-ca" className="input" value={value.caFile} spellCheck={false} autoComplete="off" aria-describedby="db-ca-help"
                onChange={(event) => set('caFile', event.target.value)} data-testid="db-ca" />,
            'Full path, on this machine, of the certificate authority file that signed the server\'s certificate. Needed for verify-full.')}
        </fieldset>
    );
}

/**
 * "Test connection": the manager's read-only probe. Nothing is created or
 * changed on the server or on this machine; the answer is a report.
 */
export function TestConnection({ value, onReport, needPassword = true, children }: {
    value: DatabaseAnswer;
    onReport?: (report: DatabaseReport | null) => void;
    needPassword?: boolean;
    children?: (report: DatabaseReport, stale: boolean) => ReactElement | null;
}) {
    const databaseApi = useDatabaseApi();
    const [report, setReport] = useState<DatabaseReport | null>(null);
    const [testedFor, setTestedFor] = useState('');
    const [busy, setBusy] = useState(false);
    const [local, setLocal] = useState<FormProblem[]>([]);
    const [failure, setFailure] = useState<{ message: string; code: string } | null>(null);
    const stale = report !== null && testedFor !== signatureOf(value);

    useEffect(() => { onReport?.(report && !stale ? report : null); }, [report, stale]); // eslint-disable-line react-hooks/exhaustive-deps

    async function run() {
        const problems = connectionProblems(value, { needPassword });
        setLocal(problems);
        setFailure(null);
        if (problems.length > 0) return;
        const signature = signatureOf(value);
        setBusy(true);
        try {
            const result = await databaseApi.test(connectionBody(value));
            setReport(result);
            setTestedFor(signature);
        } catch (error) {
            const described = describeError(error);
            setReport(null);
            setFailure({ message: described.message, code: described.code });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="wizard-form" data-testid="db-test-panel">
            <ErrorSummary problems={local.map((problem) => ({ field: problem.field, message: problem.message }))} title="Fix these before testing" />
            <div className="wizard-actions">
                <button type="button" className="btn" onClick={() => { void run(); }} disabled={busy} data-testid="db-test">{busy ? 'Testing…' : 'Test connection'}</button>
                <span className="hint">Read-only: it connects, looks and disconnects. Nothing is created or changed.</span>
            </div>
            {failure && <p role="alert" className="settings-danger" data-testid="db-test-failure" data-code={failure.code}>{failure.message}</p>}
            {report && stale && <p className="hint" role="status" data-testid="db-report-stale">The settings changed since this test. Test again before going on.</p>}
            {report && <ProbeReport report={report} stale={stale} />}
            {report && children ? children(report, stale) : null}
        </div>
    );
}
