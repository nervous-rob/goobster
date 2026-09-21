import { FormEvent, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import { tokenFromLocation } from './InvitePage';

/**
 * /app/recover?token=… - finish an operator-issued password reset. Every
 * other session of the account is signed out when this succeeds.
 */
export function RecoverPage() {
    const token = useMemo(tokenFromLocation, []);
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const config = useQuery({ queryKey: keys.config, queryFn: () => api.config() });
    const [loginName, setLoginName] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [needsLoginName, setNeedsLoginName] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const minLength = config.data?.passwordMinLength ?? 15;
    const mismatch = confirm.length > 0 && confirm !== password;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (mismatch) return;
        setBusy(true);
        setError(null);
        try {
            await api.recover({ token, password, loginName: loginName.trim() || undefined });
            await queryClient.invalidateQueries({ queryKey: keys.me });
            await navigate({ to: '/' });
        } catch (err) {
            const apiError = err as ApiError;
            if (apiError.code === 'LOGIN_NAME_REQUIRED') setNeedsLoginName(true);
            setError(apiError.message);
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
                {!token && <p className="login-error" role="alert">This reset link is missing its token.</p>}
                {token && (
                    <>
                        <p className="login-sub">Choose a new passphrase. Every other device will be signed out.</p>
                        <form className="native-login" onSubmit={onSubmit} aria-label="Reset your password">
                            {needsLoginName && (
                                <>
                                    <label className="hint" htmlFor="recover-login">Login name (this account has none yet)</label>
                                    <input id="recover-login" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                                        required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                                        value={loginName} onChange={(e) => setLoginName(e.target.value)} />
                                </>
                            )}
                            <label className="hint" htmlFor="recover-password">New passphrase (at least {minLength} characters)</label>
                            <input id="recover-password" className="input" type="password" autoComplete="new-password"
                                required minLength={minLength} value={password} onChange={(e) => setPassword(e.target.value)} />
                            <label className="hint" htmlFor="recover-confirm">Repeat it</label>
                            <input id="recover-confirm" className="input" type="password" autoComplete="new-password"
                                required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch || undefined} />
                            {mismatch && <div className="login-error" role="alert">The two passphrases differ.</div>}
                            {error && <div className="login-error" role="alert">{error}</div>}
                            <button className="btn primary big" type="submit" disabled={busy || mismatch || password.length < minLength}>
                                {busy ? 'Resetting…' : 'Set new password'}
                            </button>
                        </form>
                    </>
                )}
                <a className="btn subtle" href="/app/">Back to sign in</a>
            </div>
        </div>
    );
}
