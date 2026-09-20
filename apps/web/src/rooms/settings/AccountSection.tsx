import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { UserSettingsResponse } from '../../lib/types';
import { useSession } from '../../hooks/useSession';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { Field, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';
import { clearDeviceLocalData, previewDeviceClear } from '../../lib/appearance';
import { SignInMethods } from './SignInMethods';

export function AccountSection({ section }: { section: UserSettingsResponse['sections']['account'] }) {
    const me = useSession();
    const confirm = useConfirm();
    const toast = useToast();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const name = me?.user.name || section.values.username;
    const avatar = me?.user.avatar || section.values.avatar;
    const isNative = String(section.values.userId || '').startsWith('usr_');
    const sessions = useQuery({
        queryKey: ['settings-sessions'],
        queryFn: () => api.listSettingsSessions()
    });
    const preview = previewDeviceClear();

    async function signOut() {
        if (!await confirm('Sign out of the portal on this device? Your settings and memories stay put.')) return;
        setBusy(true);
        try { await api.logout(); } catch { /* already out */ }
        queryClient.clear();
        window.location.reload();
    }

    async function revoke(id: number) {
        setBusy(true);
        try {
            await api.revokeSettingsSession(id);
            await sessions.refetch();
            toast('Session signed out.');
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    async function revokeOthers() {
        if (!await confirm('Sign out every other device? This one stays signed in.')) return;
        setBusy(true);
        try {
            const result = await api.revokeOtherSessions();
            await sessions.refetch();
            toast(result.revoked ? `Signed out ${result.revoked} other session${result.revoked === 1 ? '' : 's'}.` : 'No other sessions.');
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    async function clearDevice() {
        if (!await confirm('Clear theme, density, mic, and other device-local preferences on this browser? Saved songs and Conservatory compositions stay unless you choose that separately.')) return;
        clearDeviceLocalData({ includeConservatory: false });
        toast('Device-local preferences cleared. Reload to see defaults.');
    }

    return (
        <section className="settings-section" aria-labelledby="settings-account-title">
            <SectionHeader id="account" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="identity" label="Signed in as"
                hint="Your account id never changes. Changing what Goobster calls you (Profile) never changes this.">
                <div className="settings-identity" id="identity-input">
                    {avatar && <img className="avatar" src={avatar} alt="" width={40} height={40} />}
                    <div>
                        <div><strong>{name}</strong></div>
                        <div className="hint">
                            {isNative ? 'Account id' : 'Discord user id'} <code>{section.values.userId}</code>
                            {me?.identity?.account && <> · {me.identity.account.role}{me.identity.installationName ? ` at ${me.identity.installationName}` : ''}</>}
                        </div>
                    </div>
                </div>
            </Field>

            <SignInMethods />

            <Field id="sessions" label="Active sessions" scope="Your account"
                hint="Safe metadata only — token hashes never appear. Sign out other devices is distinct from hiding your online presence.">
                <div className="list-card" id="sessions-input">
                    {sessions.isPending && <div className="list-row"><span className="hint">Loading…</span></div>}
                    {sessions.data?.map((row) => (
                        <div key={row.id} className="list-row">
                            <span>
                                {row.current ? 'This device' : (row.userName || 'Session')}
                                <span className="hint"> · last seen {row.lastSeenAt || row.createdAt}</span>
                            </span>
                            {!row.current && (
                                <button type="button" className="btn subtle small" disabled={busy} onClick={() => void revoke(row.id)}>
                                    Sign out
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                <button type="button" className="btn" disabled={busy} onClick={() => void revokeOthers()}>
                    Sign out other devices
                </button>
            </Field>

            <Field id="clear-device" label="Clear device-local data" scope="This device"
                hint={`Preview: ${preview.keys.length} preference key${preview.keys.length === 1 ? '' : 's'} on this browser${preview.conservatory ? ', plus Conservatory keys (not cleared here)' : ''}. Songs and samples stay in the Conservatory unless you wipe them there.`}>
                <button id="clear-device-input" type="button" className="btn" onClick={() => void clearDevice()}>
                    Clear this device’s preferences
                </button>
            </Field>

            <Field id="sign-out" label="Sign out" hint="Ends the portal session on this device only.">
                <button id="sign-out-input" type="button" className="btn" disabled={busy} onClick={signOut}>
                    {busy ? 'Signing out…' : 'Sign out'}
                </button>
            </Field>
        </section>
    );
}
