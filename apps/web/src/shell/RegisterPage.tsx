import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';

/**
 * /app/register - open sign-up. Nothing is an account until the person
 * follows the link mailed to them; this page only parks the request and
 * then says so. It reads the same whether the address was new or already
 * belonged to someone, so it cannot be used to look people up.
 */
export function RegisterPage() {
    const config = useQuery({ queryKey: keys.config, queryFn: () => api.config() });
    const [email, setEmail] = useState('');
    const [loginName, setLoginName] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);

    const cfg = config.data;
    const minLength = cfg?.passwordMinLength ?? 15;
    const mismatch = confirm.length > 0 && confirm !== password;
    const closed = cfg && cfg.registration !== 'open';

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (mismatch) return;
        setBusy(true);
        setError(null);
        try {
            await api.signup({ email: email.trim(), loginName: loginName.trim(), password, displayName: displayName.trim() || undefined });
            setSentTo(email.trim());
            setPassword('');
            setConfirm('');
        } catch (err) {
            const apiError = err as ApiError;
            setError(apiError.code === 'TOO_MANY_ATTEMPTS'
                ? 'Too many sign-ups from here for now. Try again in an hour.'
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
                {closed && (
                    <>
                        <h1>Invitation only</h1>
                        <p className="login-sub">This installation is not taking open sign-ups. Ask the host for an invitation link.</p>
                        <a className="btn" href="/app/">Back to sign in</a>
                    </>
                )}
                {sentTo && (
                    <>
                        <h1>Check your email</h1>
                        <p className="login-sub" role="status">
                            If <strong>{sentTo}</strong> can receive mail, a link to finish creating your account is on its way.
                            Open it on this device to be signed in straight away. The link works once.
                        </p>
                        <p className="hint">Already have an account with that address? The message says so and points you to a password reset instead.</p>
                        <a className="btn subtle" href="/app/">Back to sign in</a>
                    </>
                )}
                {cfg && !closed && !sentTo && (
                    <>
                        <h1>Join {cfg.installationName}</h1>
                        <p className="login-sub">
                            Pick a login name and a passphrase. Your email is only used to confirm the account and to reset the passphrase if you forget it.
                        </p>
                        <form className="native-login" onSubmit={onSubmit} aria-label="Create your account">
                            <label className="hint" htmlFor="register-email">Email</label>
                            <input id="register-email" className="input" type="email" autoComplete="email" spellCheck={false}
                                required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
                            <label className="hint" htmlFor="register-login">Login name</label>
                            <input id="register-login" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                                required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                                title="3-32 letters, digits, dots, dashes, or underscores"
                                value={loginName} onChange={(e) => setLoginName(e.target.value)} />
                            <label className="hint" htmlFor="register-display">What Goobster should call you (optional)</label>
                            <input id="register-display" className="input" autoComplete="nickname" maxLength={100}
                                value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                            <label className="hint" htmlFor="register-password">Passphrase (at least {minLength} characters)</label>
                            <input id="register-password" className="input" type="password" autoComplete="new-password"
                                required minLength={minLength} value={password} onChange={(e) => setPassword(e.target.value)} />
                            <label className="hint" htmlFor="register-confirm">Repeat it</label>
                            <input id="register-confirm" className="input" type="password" autoComplete="new-password"
                                required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch || undefined} />
                            {mismatch && <div className="login-error" role="alert">The two passphrases differ.</div>}
                            {error && <div className="login-error" role="alert">{error}</div>}
                            <button className="btn primary big" type="submit"
                                disabled={busy || mismatch || !email.trim() || !loginName.trim() || password.length < minLength}>
                                {busy ? 'Sending your link…' : 'Create account'}
                            </button>
                        </form>
                        <a className="btn subtle" href="/app/">I already have an account</a>
                    </>
                )}
            </div>
        </div>
    );
}
