import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';

/**
 * /app/forgot - ask for a password reset by email. The answer is the same
 * whether or not the address is on file; the link, if any, arrives in the
 * inbox. Only a *verified* address qualifies.
 */
export function ForgotPage() {
    const config = useQuery({ queryKey: keys.config, queryFn: () => api.config() });
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);

    const cfg = config.data;
    const unavailable = cfg && !cfg.emailRecovery;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await api.forgot(email.trim());
            setSentTo(email.trim());
        } catch (err) {
            const apiError = err as ApiError;
            setError(apiError.code === 'TOO_MANY_ATTEMPTS'
                ? 'Too many requests for now. Try again in an hour.'
                : apiError.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <img className="login-logo" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                <h1>Reset your password</h1>
                {unavailable && (
                    <p className="login-sub">This installation cannot send email. Ask the host for a reset link instead.</p>
                )}
                {sentTo && (
                    <p className="login-sub" role="status">
                        If <strong>{sentTo}</strong> is the verified address of an account here, a reset link is on its way.
                        It works once and expires soon; every other signed-in device is signed out when you use it.
                    </p>
                )}
                {cfg && !unavailable && !sentTo && (
                    <>
                        <p className="login-sub">Enter the email address on your account and we will send you a link to choose a new passphrase.</p>
                        <form className="native-login" onSubmit={onSubmit} aria-label="Request a password reset">
                            <label className="hint" htmlFor="forgot-email">Email</label>
                            <input id="forgot-email" className="input" type="email" autoComplete="email" spellCheck={false}
                                required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
                            {error && <div className="login-error" role="alert">{error}</div>}
                            <button className="btn primary big" type="submit" disabled={busy || !email.trim()}>
                                {busy ? 'Sending…' : 'Send reset link'}
                            </button>
                        </form>
                    </>
                )}
                <a className="btn subtle" href="/app/">Back to sign in</a>
            </div>
        </div>
    );
}
