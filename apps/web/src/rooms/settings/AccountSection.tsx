import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { UserSettingsResponse } from '../../lib/types';
import { useSession } from '../../hooks/useSession';
import { useConfirm } from '../../hooks/useConfirm';
import { Field, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

export function AccountSection({ section }: { section: UserSettingsResponse['sections']['account'] }) {
    const me = useSession();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const name = me?.user.name || section.values.username;
    const avatar = me?.user.avatar || section.values.avatar;

    async function signOut() {
        if (!await confirm('Sign out of the portal on this device? Your settings and memories stay put.')) return;
        setBusy(true);
        try { await api.logout(); } catch { /* already out */ }
        // Never flash this person's data at the next person who signs in.
        queryClient.clear();
        window.location.reload();
    }

    return (
        <section className="settings-section" aria-labelledby="settings-account-title">
            <SectionHeader id="account" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="identity" label="Signed in as"
                hint="Your Discord identity is the account. Changing what Goobster calls you (Profile) never changes this.">
                <div className="settings-identity" id="identity-input">
                    {avatar && <img className="avatar" src={avatar} alt="" width={40} height={40} />}
                    <div>
                        <div><strong>{name}</strong></div>
                        <div className="hint">Discord user id <code>{section.values.userId}</code></div>
                    </div>
                </div>
            </Field>

            <Field id="sign-out" label="Sign out" hint="Ends the portal session on this device only.">
                <button id="sign-out-input" type="button" className="btn" disabled={busy} onClick={signOut}>
                    {busy ? 'Signing out…' : 'Sign out'}
                </button>
            </Field>
        </section>
    );
}
