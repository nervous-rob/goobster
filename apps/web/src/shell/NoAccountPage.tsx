import { FormEvent, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { BerryMark } from '../components/BerryMark';

const STATUS_KEY = ['access-request-status'];

/** No account yet means no user settings to read; format with the browser's locale. */
function whenLabel(stamp: string | null | undefined): string {
    if (!stamp) return '';
    const date = new Date(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return stamp;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * Shown when the session is real but /me refuses it (403): the principal has
 * no account on this installation yet (`identity.requireAccount`) or the
 * account was disabled. The person needs a way out - Sign out works without
 * an account - and, for a Discord member, the right next step: ask the host
 * from here. The request reaches the host's Goobster Inbox and Discord DMs,
 * where one click lets the person in; this page polls and, once approved,
 * asks /me again so they land inside without a reload.
 */
export function NoAccountPage({ error, onApproved }: { error: ApiError; onApproved?: () => void }) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState('');
    const [failure, setFailure] = useState<string | null>(null);
    const disabled = error.code === 'ACCOUNT_DISABLED';

    const status = useQuery({
        queryKey: STATUS_KEY,
        queryFn: () => api.accessRequestStatus(),
        enabled: !disabled,
        retry: false,
        // While the host is deciding, watch for the answer.
        refetchInterval: (query) => query.state.data?.pending ? 5_000 : false
    });
    const view = status.data;
    const request = view?.request ?? null;

    useEffect(() => {
        if (view?.member || request?.status === 'approved') onApproved?.();
    }, [view?.member, request?.status, onApproved]);

    async function ask(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setFailure(null);
        try {
            await api.requestAccess(note.trim() || null);
            await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
        } catch (err) {
            setFailure((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

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

    const pending = Boolean(view?.pending);
    const declined = request?.status === 'declined' && !view?.canRequest;

    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <BerryMark className="login-logo" size={72} />
                <h1>{disabled ? 'Account disabled' : pending ? 'Asked the host' : 'Almost in'}</h1>
                <p className="login-sub" role="status">
                    {pending
                        ? 'Your request is with the host. You will be let in the moment they approve it - this page is watching.'
                        : error.message}
                </p>

                {!disabled && view && pending && request && (
                    <p className="hint" data-testid="access-request-pending">
                        Sent {whenLabel(request.createdAt)} to the host&apos;s Goobster Inbox{view.discord ? ' and Discord DMs' : ''}.
                        Everything Goobster already knows about you from Discord stays with you when they approve.
                    </p>
                )}

                {!disabled && view && !pending && declined && (
                    <p className="hint" role="status" data-testid="access-request-declined">
                        The host did not grant access this time. You can ask again {view.retryAt ? whenLabel(view.retryAt) : 'tomorrow'},
                        or talk to them directly.
                    </p>
                )}

                {!disabled && view && view.canRequest && (
                    <form className="native-login" onSubmit={ask} data-testid="access-request-form" aria-label="Ask the host to let you in">
                        <p className="hint">
                            This installation lets people in one at a time. Ask the host from here - the request lands in their Goobster
                            Inbox{view.discord ? ' and Discord DMs' : ''}, where one click lets you in. No need to create a separate account
                            with an email address; that would start from scratch.
                        </p>
                        <label className="hint" htmlFor="access-request-note">A word for the host (optional)</label>
                        <input id="access-request-note" className="input" value={note} maxLength={280} disabled={busy}
                            placeholder="e.g. It's Sam from the Tuesday game" onChange={(e) => setNote(e.target.value)} />
                        <button className="btn primary big" type="submit" disabled={busy}>
                            {busy ? 'Asking…' : 'Ask the host to let me in'}
                        </button>
                    </form>
                )}

                {!disabled && status.isError && (
                    <p className="hint">
                        Ask the host to grant your account from Host → Accounts. Everything Goobster already knows about you from
                        Discord stays with it; there is no need to create a separate account with an email address.
                    </p>
                )}

                {failure && <div className="login-error" role="alert">{failure}</div>}
                <button className={`btn big${pending || disabled || !view?.canRequest ? ' primary' : ''}`} type="button" onClick={signOut} disabled={busy}>
                    {busy ? 'Working…' : 'Sign out'}
                </button>
            </div>
        </div>
    );
}
