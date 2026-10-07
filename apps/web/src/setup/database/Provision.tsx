import { useEffect, useMemo, useState } from 'react';
import type { DatabaseReport, InstallOperation } from '../../lib/types';
import { useTransport } from '../transport';
import { describeError, ErrorSummary } from '../ui';
import { connectionBody, connectionProblems, PROVISION_ACTIONS, type DatabaseAnswer } from './model';

type PlanView = {
    actions: Array<{ action: string; permitted: boolean; statements: string[] }>;
    blocked: Array<{ action: string; reason?: string }>;
    dba: string[];
    elevated?: { user: string; database: string; persisted: boolean };
};

function planOf(operation: InstallOperation): PlanView {
    const plan = operation.plan as unknown as Partial<PlanView>;
    return { actions: plan.actions || [], blocked: plan.blocked || [], dba: plan.dba || [], elevated: plan.elevated };
}

const DBA_INTRO = 'If you are not the database administrator, give the statements below to whoever is. Replace <APPLICATION_PASSWORD> with the password above; nothing here ever contains it.';

/**
 * Prepare an existing server for Goobster with an administrative credential
 * that is used once and not kept: only the ticked actions, only the database,
 * schema and role named above. The administrator's password stays in this
 * component's memory and goes to the manager in one request.
 */
export function Provision({ value, report, onDone }: { value: DatabaseAnswer; report: DatabaseReport | null; onDone: () => void }) {
    const transport = useTransport();
    const needed = useMemo(() => (report?.verdict.provisioning.required || []).map((step) => step.action), [report]);
    const [ticked, setTicked] = useState<string[]>(needed);
    const [user, setUser] = useState('');
    const [password, setPassword] = useState('');
    const [database, setDatabase] = useState('');
    const [plan, setPlan] = useState<{ operation: InstallOperation; view: PlanView } | null>(null);
    const [busy, setBusy] = useState<'plan' | 'run' | null>(null);
    const [problems, setProblems] = useState<Array<{ field?: string; message: string }>>([]);
    const [failure, setFailure] = useState<{ message: string; code: string; dba: string[] } | null>(null);
    const [done, setDone] = useState<Array<{ action: string; status: string }> | null>(null);

    useEffect(() => { setTicked(needed); setPlan(null); }, [needed.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

    const dba = report?.verdict.provisioning.dba || [];
    const toggle = (action: string) => {
        setPlan(null);
        setTicked((previous) => (previous.includes(action) ? previous.filter((entry) => entry !== action) : [...previous, action]));
    };

    function input() {
        return {
            connection: connectionBody(value),
            elevated: { user: user.trim(), password, ...(database.trim() ? { database: database.trim() } : {}) },
            actions: ticked
        };
    }

    function localProblems() {
        const found: Array<{ field?: string; message: string }> = connectionProblems(value).map((problem) => ({ field: problem.field, message: problem.message }));
        if (!user.trim()) found.push({ field: 'prov-user', message: 'Enter the administrator\'s user name.' });
        if (ticked.length === 0) found.push({ message: 'Tick at least one action.' });
        return found;
    }

    async function check() {
        const found = localProblems();
        setProblems(found);
        setFailure(null);
        setDone(null);
        if (found.length > 0) return;
        setBusy('plan');
        try {
            const { operation } = await transport.preview('database.provision', input());
            setPlan({ operation, view: planOf(operation) });
        } catch (error) {
            const described = describeError(error);
            const details = (described.details || {}) as { dba?: string[] };
            setPlan(null);
            setFailure({ message: described.message, code: described.code, dba: Array.isArray(details.dba) ? details.dba : [] });
        } finally {
            setBusy(null);
        }
    }

    async function run() {
        if (!plan) return;
        setBusy('run');
        setFailure(null);
        try {
            const applied = await transport.apply(plan.operation.id);
            const results = (applied.result as { done?: Array<{ action: string; status: string }> } | null)?.done || [];
            setDone(results);
            setPlan(null);
            setPassword('');
            onDone();
        } catch (error) {
            const described = describeError(error);
            setFailure({ message: described.message, code: described.code, dba: [] });
            setPassword('');
            setPlan(null);
        } finally {
            setBusy(null);
        }
    }

    return (
        <fieldset className="wizard-fieldset" data-testid="db-provision">
            <legend>Prepare the server (optional)</legend>
            <p className="hint">
                Needs an administrative credential for this one job. It is used once, never saved and never logged. It may only create the
                database, the schema and the application role named above; it refuses to touch a schema that already holds anything else.
            </p>
            <div role="group" aria-label="Actions" className="wizard-list">
                {PROVISION_ACTIONS.map((action) => (
                    <label key={action.id} className="wizard-choice">
                        <input type="checkbox" checked={ticked.includes(action.id)} onChange={() => toggle(action.id)} data-testid={`prov-${action.id}`} />
                        {' '}<span><strong>{action.label}</strong> <span className="hint">{action.help}{needed.includes(action.id) ? ' (the test says this is needed)' : ''}</span></span>
                    </label>
                ))}
            </div>
            <ErrorSummary problems={problems} title="Fix these before checking" />
            <div className="wizard-field">
                <label htmlFor="prov-user">Administrator user</label>
                <input id="prov-user" className="input" value={user} onChange={(event) => { setUser(event.target.value); setPlan(null); }} spellCheck={false} autoComplete="off" data-testid="prov-user" />
            </div>
            <div className="wizard-field">
                <label htmlFor="prov-password">Administrator password</label>
                <input id="prov-password" className="input" type="password" value={password} onChange={(event) => { setPassword(event.target.value); setPlan(null); }} autoComplete="new-password" data-testid="prov-password" />
            </div>
            <div className="wizard-field">
                <label htmlFor="prov-database">Maintenance database (optional)</label>
                <input id="prov-database" className="input" value={database} onChange={(event) => { setDatabase(event.target.value); setPlan(null); }} spellCheck={false} autoComplete="off" data-testid="prov-database" />
                <span className="hint">Where the administrator connects to create a database. Default: postgres.</span>
            </div>
            <div className="wizard-actions">
                <button type="button" className="btn" onClick={() => { void check(); }} disabled={busy !== null} data-testid="prov-check">{busy === 'plan' ? 'Checking…' : 'Check what this will do'}</button>
            </div>
            {failure && (
                <div role="alert" className="settings-danger" data-testid="prov-failure" data-code={failure.code}>
                    <p>{failure.message}</p>
                    {failure.dba.length > 0 && <><p>{DBA_INTRO}</p><pre data-testid="prov-dba"><code>{failure.dba.join('\n')}</code></pre></>}
                </div>
            )}
            {plan && (
                <div data-testid="prov-plan">
                    <h3 className="section-title">What will run, in order</h3>
                    <ol className="wizard-outline">
                        {plan.view.actions.map((entry) => (
                            <li key={entry.action} data-action={entry.action}>
                                <strong>{PROVISION_ACTIONS.find((candidate) => candidate.id === entry.action)?.label || entry.action}</strong>
                                <pre><code>{entry.statements.join('\n')}</code></pre>
                            </li>
                        ))}
                    </ol>
                    <p className="hint">Run as <code>{plan.view.elevated?.user}</code>. That credential is not stored.</p>
                    <div className="wizard-actions">
                        <button type="button" className="btn primary" onClick={() => { void run(); }} disabled={busy !== null} data-testid="prov-run">{busy === 'run' ? 'Running…' : 'Run these actions'}</button>
                    </div>
                </div>
            )}
            {done && (
                <div role="status" className="wizard-success" data-testid="prov-done">
                    Done: {done.map((entry) => `${PROVISION_ACTIONS.find((candidate) => candidate.id === entry.action)?.label || entry.action} (${entry.status === 'already' ? 'was already there' : 'done'})`).join('; ') || 'nothing to do'}. Test the connection again.
                </div>
            )}
            {dba.length > 0 && (
                <details className="wizard-details" data-testid="prov-dba-details">
                    <summary>I am not the administrator: the statements to hand over</summary>
                    <p className="hint">{DBA_INTRO}</p>
                    <pre><code>{dba.join('\n')}</code></pre>
                </details>
            )}
        </fieldset>
    );
}
