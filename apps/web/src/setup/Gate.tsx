import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { managerApi } from './api';
import { MINT_BOOTSTRAP, MINT_RECOVERY } from './commands';
import type { ManagerStatus } from './transport';
import { describeError, Details, ErrorSummary, type Problem } from './ui';

const CREDENTIAL_TEXT: Record<string, string> = {
    BOOTSTRAP_INVALID: 'That setup credential is not valid. It works once and is replaced when it is used or when the manager restarts.',
    BOOTSTRAP_EXPIRED: 'That setup credential has expired.',
    RECOVERY_INVALID: 'That recovery credential is not valid. It works once.',
    RECOVERY_EXPIRED: 'That recovery credential has expired.',
    ALREADY_CLAIMED: 'This installation already has an owner, so first-time setup is closed.',
    LOCAL_ONLY: 'Recovery works only from the machine itself. Open this page through an SSH tunnel.',
    TOO_MANY_ATTEMPTS: 'Too many tries. Wait a minute, then try again.'
};

/** The command that gets a new credential for the manager's current state. */
export function CredentialHelp({ state, why }: { state: ManagerStatus['state'] | null; why?: string }) {
    const command = state === 'unclaimed' ? MINT_BOOTSTRAP : MINT_RECOVERY;
    return (
        <div className="wizard-callout" data-testid="credential-help">
            {why && <p>{why}</p>}
            <p>On the machine Goobster is installed on, run this in its folder to get a new one-time {state === 'unclaimed' ? 'setup' : 'recovery'} credential:</p>
            <pre><code data-testid="mint-command">{command}</code></pre>
            <p className="hint">It prints the credential once and it expires in about 15 minutes. Paste it below.</p>
        </div>
    );
}

function problemsFor(error: unknown, fieldId: string): { problems: Problem[]; code: string; details: unknown } {
    const described = describeError(error);
    const text = error instanceof ApiError ? (CREDENTIAL_TEXT[error.code] || described.message) : described.message;
    return { problems: [{ field: error instanceof ApiError && error.code.startsWith('BAD_') ? undefined : fieldId, message: text }], code: described.code, details: described.details };
}

/** First-time setup: the one-time credential and the name of this installation. */
export function ClaimForm({ status, onDone }: { status: ManagerStatus; onDone: () => void }) {
    const [credential, setCredential] = useState('');
    const [label, setLabel] = useState('Goobster');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<ReturnType<typeof problemsFor> | null>(null);
    const [attempted, setAttempted] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setAttempted(true);
        if (!credential.trim() || !label.trim()) {
            setFailure({ problems: [
                ...(!credential.trim() ? [{ field: 'setup-credential', message: 'Paste the setup credential the manager printed.' }] : []),
                ...(!label.trim() ? [{ field: 'setup-label', message: 'Give this installation a name.' }] : [])
            ], code: '', details: null });
            return;
        }
        setBusy(true);
        setFailure(null);
        try {
            await managerApi.claim({ credential: credential.trim(), label: label.trim() });
            setCredential('');
            onDone();
        } catch (error) {
            setCredential('');
            setFailure(problemsFor(error, 'setup-credential'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={(event) => void submit(event)} noValidate className="wizard-form" data-testid="claim-form">
            {failure && <ErrorSummary problems={failure.problems} />}
            {failure && failure.problems.length > 0 && (failure.code === 'BOOTSTRAP_INVALID' || failure.code === 'BOOTSTRAP_EXPIRED') && (
                <CredentialHelp state={status.state} />
            )}
            <div className="wizard-field">
                <label htmlFor="setup-credential">Setup credential</label>
                <input id="setup-credential" className="input" type="password" autoComplete="off" spellCheck={false}
                    value={credential} onChange={(event) => setCredential(event.target.value)} data-testid="setup-credential"
                    aria-describedby="setup-credential-hint" aria-invalid={attempted && !credential.trim()} />
                <span id="setup-credential-hint" className="hint">
                    The manager printed it when it started. It works once, goes only to this machine, and is not kept by this page.
                    {status.setup && !status.setup.bootstrapPending ? ' The manager says none is pending right now: restart it, or mint a new one below.' : ''}
                </span>
            </div>
            <div className="wizard-field">
                <label htmlFor="setup-label">What should this installation be called?</label>
                <input id="setup-label" className="input" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)}
                    data-testid="setup-label" aria-invalid={attempted && !label.trim()} />
                <span className="hint">Only you see it: it names this installation in the manager&apos;s records.</span>
            </div>
            <button type="submit" className="btn primary" disabled={busy} data-testid="claim-submit">{busy ? 'Checking…' : 'Start setup'}</button>
            {status.setup && (status.setup.expired || !status.setup.bootstrapPending) && <CredentialHelp state="unclaimed" why="There is no usable setup credential right now." />}
            <Details code={failure?.code} details={failure?.details} />
        </form>
    );
}

/** Coming back to an installation that exists: the one-time recovery credential. */
export function UnlockForm({ status, onDone, why }: { status: ManagerStatus; onDone: () => void; why?: string }) {
    const [credential, setCredential] = useState('');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<ReturnType<typeof problemsFor> | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!credential.trim()) {
            setFailure({ problems: [{ field: 'recovery-credential', message: 'Paste the recovery credential.' }], code: '', details: null });
            return;
        }
        setBusy(true);
        setFailure(null);
        try {
            await managerApi.unlock({ credential: credential.trim() });
            setCredential('');
            onDone();
        } catch (error) {
            setCredential('');
            setFailure(problemsFor(error, 'recovery-credential'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={(event) => void submit(event)} noValidate className="wizard-form" data-testid="unlock-form">
            <CredentialHelp state={status.state === 'unclaimed' ? 'claimed' : status.state} why={why} />
            {failure && <ErrorSummary problems={failure.problems} />}
            <div className="wizard-field">
                <label htmlFor="recovery-credential">Recovery credential</label>
                <input id="recovery-credential" className="input" type="password" autoComplete="off" spellCheck={false}
                    value={credential} onChange={(event) => setCredential(event.target.value)} data-testid="recovery-credential" />
            </div>
            <button type="submit" className="btn primary" disabled={busy} data-testid="unlock-submit">{busy ? 'Checking…' : 'Unlock'}</button>
            <Details code={failure?.code} details={failure?.details} />
        </form>
    );
}
