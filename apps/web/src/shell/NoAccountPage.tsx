import { useState } from 'react';
import { api, ApiError } from '../lib/api';

/**
 * Shown when the session is real but /me refuses it (403): the principal has
 * no account on this installation yet (`identity.requireAccount`) or the
 * account was disabled. The person needs a way out - Sign out works without
 * an account - and, for a Discord member, the reassurance that the right
 * next step is a grant from the host, not a second, empty account.
 */
export function NoAccountPage({ error }: { error: ApiError }) {
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const disabled = error.code === 'ACCOUNT_DISABLED';

    async function signOut() {
        setBusy(true);
        setFailure(null);
        try {
            await api.logout();
        } catch (err) {
            setFailure((err as Error).message);
            setBusy(false);
        }
    }

    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <img className="login-logo" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                <h1>{disabled ? 'Account disabled' : 'Almost in'}</h1>
                <p className="login-sub" role="status">{error.message}</p>
                {!disabled && (
                    <p className="hint">
                        This installation lets people in one at a time. Ask the host to grant your account from Host → Accounts -
                        everything Goobster already knows about you from Discord stays with it. There is no need to create a
                        separate account with an email address; that would start from scratch.
                    </p>
                )}
                {failure && <div className="login-error" role="alert">{failure}</div>}
                <button className="btn primary big" type="button" onClick={signOut} disabled={busy}>
                    {busy ? 'Signing out…' : 'Sign out'}
                </button>
            </div>
        </div>
    );
}
