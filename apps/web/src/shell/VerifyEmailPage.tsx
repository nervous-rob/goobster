import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import { tokenFromLocation } from './InvitePage';

type Outcome =
    | { state: 'working' }
    | { state: 'registered'; name: string; loginName: string }
    | { state: 'verified'; address: string }
    | { state: 'failed'; message: string };

/**
 * /app/verify-email?token=… - the landing page for both kinds of
 * verification link. A sign-up's link creates the account and signs the
 * person in; an existing account's link marks the address verified and
 * sends them back to sign in (or to Settings if they already are).
 */
export function VerifyEmailPage() {
    const token = useMemo(tokenFromLocation, []);
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [outcome, setOutcome] = useState<Outcome>(token ? { state: 'working' } : { state: 'failed', message: 'This link is missing its token.' });
    const started = useRef(false);

    useEffect(() => {
        if (!token || started.current) return;
        started.current = true;
        (async () => {
            try {
                const result = await api.verifyEmail(token);
                if (result.kind === 'registration') {
                    await queryClient.invalidateQueries({ queryKey: keys.me });
                    setOutcome({ state: 'registered', name: result.user.name, loginName: result.user.loginName });
                    window.setTimeout(() => { void navigate({ to: '/' }); }, 1800);
                } else {
                    await queryClient.invalidateQueries({ queryKey: keys.me });
                    setOutcome({ state: 'verified', address: result.address });
                }
            } catch (err) {
                setOutcome({ state: 'failed', message: (err as ApiError).message });
            }
        })();
    }, [token, navigate, queryClient]);

    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <img className="login-logo" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                {outcome.state === 'working' && (
                    <>
                        <h1>Confirming…</h1>
                        <p className="login-sub" role="status">One moment while the link is checked.</p>
                    </>
                )}
                {outcome.state === 'registered' && (
                    <>
                        <h1>Welcome, {outcome.name}</h1>
                        <p className="login-sub" role="status">
                            Your account is ready and you are signed in. Your login name is <code>{outcome.loginName}</code>; your email works too.
                        </p>
                        <a className="btn primary big" href="/app/">Come in</a>
                    </>
                )}
                {outcome.state === 'verified' && (
                    <>
                        <h1>Email confirmed</h1>
                        <p className="login-sub" role="status">
                            <strong>{outcome.address}</strong> is now verified. You can sign in with it and use it to reset your password.
                        </p>
                        <a className="btn primary big" href="/app/settings/account">Continue</a>
                    </>
                )}
                {outcome.state === 'failed' && (
                    <>
                        <h1>Link not valid</h1>
                        <p className="login-error" role="alert">{outcome.message}</p>
                        <p className="hint">Links work once and expire. Ask for a new one from Settings → Account, or sign up again.</p>
                        <a className="btn" href="/app/">Go to sign in</a>
                    </>
                )}
            </div>
        </div>
    );
}
