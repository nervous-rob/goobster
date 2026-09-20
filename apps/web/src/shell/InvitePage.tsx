import { FormEvent, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';

/** `?token=` from the address bar; the router's search is left untyped on purpose. */
export function tokenFromLocation(): string {
    return new URLSearchParams(window.location.search).get('token') || '';
}

/**
 * /app/invite?token=… - redeem an operator's invitation. The page shows
 * who is inviting and what role the link carries before anything is
 * committed; the token is consumed only when the form is submitted.
 */
export function InvitePage() {
    const token = useMemo(tokenFromLocation, []);
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const preview = useQuery({
        queryKey: ['invite', token],
        queryFn: () => api.inspectInvite(token),
        enabled: Boolean(token),
        retry: false
    });
    const [loginName, setLoginName] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const minLength = preview.data?.passwordMinLength ?? 15;
    const mismatch = confirm.length > 0 && confirm !== password;

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        if (mismatch) return;
        setBusy(true);
        setError(null);
        try {
            await api.register({ token, loginName: loginName.trim(), password, displayName: displayName.trim() || undefined });
            await queryClient.invalidateQueries({ queryKey: keys.me });
            await navigate({ to: '/' });
        } catch (err) {
            setError((err as ApiError).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <img className="login-logo" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                {!token && <p className="login-error" role="alert">This invitation link is missing its token.</p>}
                {token && preview.isPending && <p className="hint">Checking the invitation…</p>}
                {token && preview.isError && (
                    <>
                        <h1>Invitation not valid</h1>
                        <p className="login-sub">{(preview.error as ApiError).message}</p>
                        <a className="btn" href="/app/">Go to sign in</a>
                    </>
                )}
                {preview.data && (
                    <>
                        <h1>Join {preview.data.installation.name}</h1>
                        <p className="login-sub">
                            You have been invited as {preview.data.role === 'operator' ? 'an operator (host)' : 'a member'}.
                            Pick a login name and a passphrase; you can connect Discord later if you want to.
                        </p>
                        <form className="native-login" onSubmit={onSubmit} aria-label="Create your account">
                            <label className="hint" htmlFor="invite-login">Login name</label>
                            <input id="invite-login" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                                required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                                title="3-32 letters, digits, dots, dashes, or underscores"
                                value={loginName} onChange={(e) => setLoginName(e.target.value)} />
                            <label className="hint" htmlFor="invite-display">What Goobster should call you (optional)</label>
                            <input id="invite-display" className="input" autoComplete="nickname" maxLength={100}
                                value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                            <label className="hint" htmlFor="invite-password">Passphrase (at least {minLength} characters)</label>
                            <input id="invite-password" className="input" type="password" autoComplete="new-password"
                                required minLength={minLength} value={password} onChange={(e) => setPassword(e.target.value)} />
                            <label className="hint" htmlFor="invite-confirm">Repeat it</label>
                            <input id="invite-confirm" className="input" type="password" autoComplete="new-password"
                                required value={confirm} onChange={(e) => setConfirm(e.target.value)}
                                aria-invalid={mismatch || undefined} />
                            {mismatch && <div className="login-error" role="alert">The two passphrases differ.</div>}
                            {error && <div className="login-error" role="alert">{error}</div>}
                            <button className="btn primary big" type="submit" disabled={busy || mismatch || !loginName.trim() || password.length < minLength}>
                                {busy ? 'Creating your account…' : 'Create account'}
                            </button>
                            <div className="hint">Expires {preview.data.expiresAt} UTC. One use only.</div>
                        </form>
                    </>
                )}
            </div>
        </div>
    );
}
