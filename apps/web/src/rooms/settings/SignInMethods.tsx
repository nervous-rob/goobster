import { FormEvent, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { keys } from '../../lib/query';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { Field } from './SectionFrame';

const ACCOUNT_KEY = ['account-summary'];

/**
 * Settings -> Account: the sign-in methods on this account. Login name +
 * passphrase (enroll or change), the recovery email address, and the
 * Discord connection. Sensitive changes need a recent authentication; the
 * panel offers a re-auth box when the server says so.
 */
export function SignInMethods() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const summary = useQuery({ queryKey: ACCOUNT_KEY, queryFn: () => api.account() });
    const [loginName, setLoginName] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [reauthPassword, setReauthPassword] = useState('');
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [needsReauth, setNeedsReauth] = useState(false);

    const data = summary.data;
    useEffect(() => {
        if (data?.account?.loginName && !loginName) setLoginName(data.account.loginName);
    }, [data, loginName]);

    // The OAuth callback lands back here with ?link=<outcome>.
    useEffect(() => {
        const outcome = new URLSearchParams(window.location.search).get('link');
        if (!outcome) return;
        const messages: Record<string, [string, boolean]> = {
            ok: ['Discord connected.', false],
            conflict: ['That Discord account already belongs to another account here. Nothing was changed.', true],
            link_expired: ['The connect request expired. Try again.', true],
            link_session_mismatch: ['That connect request came from a different session. Try again.', true]
        };
        const [message, isError] = messages[outcome] || ['Discord connect did not complete.', true];
        toast(message, isError);
        window.history.replaceState(null, '', window.location.pathname);
    }, [toast]);

    async function refresh() {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY }),
            queryClient.invalidateQueries({ queryKey: keys.me })
        ]);
    }

    function handle(error: unknown) {
        const apiError = error as ApiError;
        if (apiError.code === 'REAUTH_REQUIRED') {
            setNeedsReauth(true);
            toast(data?.hasPassword
                ? 'Confirm your password below first.'
                : 'Sign out and back in first, then set your password within a few minutes.', true);
            return;
        }
        toast(apiError.message, true);
    }

    async function saveCredentials(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        try {
            const result = await api.setCredentials({
                loginName: loginName.trim() || undefined,
                currentPassword: currentPassword || undefined,
                newPassword
            });
            setCurrentPassword('');
            setNewPassword('');
            setNeedsReauth(false);
            toast(data?.hasPassword ? 'Password changed.' : `You can now sign in as ${result.loginName}.`);
            await refresh();
        } catch (error) {
            handle(error);
        } finally {
            setBusy(false);
        }
    }

    async function reauth(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        try {
            await api.reauth(reauthPassword);
            setReauthPassword('');
            setNeedsReauth(false);
            toast('Confirmed. You have a few minutes to make changes.');
            await refresh();
        } catch (error) {
            toast((error as ApiError).message, true);
        } finally {
            setBusy(false);
        }
    }

    async function saveEmail(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        try {
            const result = await api.setEmail(email.trim());
            setEmail('');
            setNeedsReauth(false);
            toast(result.sent ? `Check ${result.address} for a confirmation link.` : 'That address is already verified.');
            await refresh();
        } catch (error) {
            handle(error);
        } finally {
            setBusy(false);
        }
    }

    async function resendVerification() {
        setBusy(true);
        try {
            const result = await api.resendVerification();
            toast(result.sent ? `A new link is on its way to ${result.address}.` : 'That address is already verified.');
            await refresh();
        } catch (error) {
            handle(error);
        } finally {
            setBusy(false);
        }
    }

    async function removeEmail() {
        if (!await confirm('Remove the email address from this account? You will not be able to reset your password by email until you add one again.')) return;
        setBusy(true);
        try {
            await api.removeEmail();
            toast('Email address removed.');
            await refresh();
        } catch (error) {
            handle(error);
        } finally {
            setBusy(false);
        }
    }

    async function disconnect() {
        if (!await confirm('Disconnect Discord from this account? Your data and login name stay; Discord DMs and server access through this account stop.')) return;
        setBusy(true);
        try {
            await api.disconnectIdentity('discord');
            toast('Discord disconnected.');
            await refresh();
        } catch (error) {
            handle(error);
        } finally {
            setBusy(false);
        }
    }

    if (summary.isPending) return <div className="hint">Loading sign-in methods…</div>;
    if (!data) return null;

    const nativeOff = !data.nativeLogin;
    return (
        <>
            <Field id="sign-in-password" label={data.hasPassword ? 'Login name & password' : 'Add a login name & password'} scope="Your account"
                hint={nativeOff
                    ? 'Password sign-in is not enabled on this installation. The host can turn it on.'
                    : data.hasPassword
                        ? `Change your passphrase (at least ${data.passwordMinLength} characters). Your current one is required.`
                        : `Sign in without Discord. Pick a login name and a passphrase of at least ${data.passwordMinLength} characters. This needs a recent sign-in (${data.recentAuthMinutes} min).`}>
                {!nativeOff && !data.account && (
                    <div className="hint">The host has not granted this account yet, so it cannot have a password.</div>
                )}
                {!nativeOff && data.account && (
                    <form className="settings-stack" onSubmit={saveCredentials} id="sign-in-password-input">
                        <input className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                            placeholder="Login name" minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                            value={loginName} onChange={(e) => setLoginName(e.target.value)} required={!data.account.loginName}
                            aria-label="Login name" />
                        {data.hasPassword && (
                            <input className="input" type="password" autoComplete="current-password" placeholder="Current password"
                                value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required aria-label="Current password" />
                        )}
                        <input className="input" type="password" autoComplete="new-password" placeholder={data.hasPassword ? 'New passphrase' : 'Passphrase'}
                            minLength={data.passwordMinLength} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required aria-label="New passphrase" />
                        <button type="submit" className="btn primary" disabled={busy || newPassword.length < data.passwordMinLength}>
                            {data.hasPassword ? 'Change password' : 'Save sign-in'}
                        </button>
                    </form>
                )}
                {needsReauth && data.hasPassword && (
                    <form className="settings-stack" onSubmit={reauth} aria-label="Confirm your password">
                        <div className="hint">Confirm your password to unlock changes for {data.recentAuthMinutes} minutes.</div>
                        <input className="input" type="password" autoComplete="current-password" placeholder="Your password"
                            value={reauthPassword} onChange={(e) => setReauthPassword(e.target.value)} required aria-label="Password to confirm" />
                        <button type="submit" className="btn" disabled={busy || !reauthPassword}>Confirm</button>
                    </form>
                )}
            </Field>

            <Field id="sign-in-email" label="Email" scope="Your account"
                hint={!data.mail.enabled
                    ? `This installation cannot send email${data.mail.reason ? ` (${data.mail.reason.replace(/\.$/, '').toLowerCase()})` : ''}, so an address would have no use here.`
                    : data.email?.verified
                        ? 'Verified. You can sign in with it and reset your password by email. Changing it starts verification again.'
                        : data.email
                            ? 'Not verified yet. Follow the link in the confirmation message; until then the address cannot be used to sign in or to reset your password.'
                            : `Optional. A verified address lets you sign in with it and reset a forgotten password yourself. Adding one needs a recent sign-in (${data.recentAuthMinutes} min).`}>
                {data.mail.enabled && data.account && (
                    <div className="settings-stack" id="sign-in-email-input">
                        {data.email && (
                            <div className="list-card">
                                <div className="list-row">
                                    <span>
                                        <code>{data.email.address}</code>{' '}
                                        <span className={`badge ${data.email.verified ? 'state-verified' : 'state-unverified'}`}>{data.email.verified ? 'verified' : 'unverified'}</span>
                                    </span>
                                    <span style={{ display: 'flex', gap: 6 }}>
                                        {!data.email.verified && (
                                            <button type="button" className="btn small" disabled={busy} onClick={() => void resendVerification()}>
                                                {data.email.pendingVerification ? 'Resend link' : 'Send link'}
                                            </button>
                                        )}
                                        <button type="button" className="btn subtle small" disabled={busy} onClick={() => void removeEmail()}>Remove</button>
                                    </span>
                                </div>
                            </div>
                        )}
                        <form className="settings-stack" onSubmit={saveEmail} aria-label={data.email ? 'Change email address' : 'Add email address'}>
                            <input className="input" type="email" autoComplete="email" spellCheck={false} maxLength={254}
                                placeholder={data.email ? 'New email address' : 'Email address'} value={email}
                                onChange={(e) => setEmail(e.target.value)} required aria-label="Email address" />
                            <button type="submit" className="btn" disabled={busy || !email.trim()}>
                                {data.email ? 'Change address' : 'Add address'}
                            </button>
                        </form>
                    </div>
                )}
                {data.mail.enabled && !data.account && (
                    <div className="hint">The host has not granted this account yet.</div>
                )}
            </Field>

            <Field id="sign-in-discord" label="Discord" scope="Your account"
                hint={data.kind === 'legacy'
                    ? 'This account is its Discord identity, so Discord cannot be disconnected from it. Add a login name and password above to sign in without Discord.'
                    : data.discord.linked
                        ? 'Connected. Disconnecting keeps your data and password; Discord DMs and server-scoped features stop.'
                        : 'Connect Discord to reach Goobster from DMs and servers with this account.'}>
                <div className="list-card" id="sign-in-discord-input">
                    <div className="list-row">
                        <span>
                            {data.discord.linked ? 'Connected' : 'Not connected'}
                            {data.discord.subject && <span className="hint"> · user id <code>{data.discord.subject}</code></span>}
                        </span>
                        {data.discord.canConnect && data.discordLoginAvailable && (
                            <a className="btn small" href="/api/app/auth/link/discord" onClick={(event) => {
                                if (!data.recentAuth) {
                                    event.preventDefault();
                                    handle(new ApiError(403, 'REAUTH_REQUIRED', ''));
                                }
                            }}>Connect Discord</a>
                        )}
                        {data.discord.canConnect && !data.discordLoginAvailable && (
                            <span className="hint">Discord login is not configured here.</span>
                        )}
                        {data.discord.linked && data.kind === 'native' && (
                            <button type="button" className="btn subtle small" disabled={busy || !data.discord.canDisconnect}
                                title={data.discord.canDisconnect ? undefined : 'Set a login name and password first.'}
                                onClick={() => void disconnect()}>
                                Disconnect
                            </button>
                        )}
                    </div>
                </div>
            </Field>
        </>
    );
}
