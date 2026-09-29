import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import {
    disablePush, enablePush, getPushSubscription, permissionState, pushSupported, PUSH_STATE_EVENT
} from '../lib/notifications';
import { isIos, isStandalone } from '../lib/pwa';

const PUSH_KEY = ['push'] as const;

/**
 * Browser notifications for this device (documentation/pwa.md): the
 * server says whether push is available on this installation and how many
 * devices the person enrolled; the browser says whether *this* one is.
 */
export function PushSettings() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const supported = pushSupported();
    const [permission, setPermission] = useState(() => permissionState());
    const [endpoint, setEndpoint] = useState<string | null>(null);
    const [busy, setBusy] = useState<'on' | 'off' | 'test' | 'all' | null>(null);

    const refreshLocal = useCallback(async () => {
        setPermission(permissionState());
        const sub = await getPushSubscription();
        setEndpoint(sub?.endpoint || null);
    }, []);
    useEffect(() => {
        void refreshLocal();
        window.addEventListener(PUSH_STATE_EVENT, refreshLocal);
        return () => window.removeEventListener(PUSH_STATE_EVENT, refreshLocal);
    }, [refreshLocal]);

    const status = useQuery({
        queryKey: [...PUSH_KEY, endpoint || ''],
        queryFn: () => api.push(endpoint),
        staleTime: 30_000
    });
    const invalidate = () => queryClient.invalidateQueries({ queryKey: PUSH_KEY });

    const data = status.data;
    const thisDevice = Boolean(endpoint && data?.thisDevice);

    async function turnOn() {
        if (!data?.publicKey) return;
        setBusy('on');
        try {
            const result = await enablePush(data.publicKey);
            toast(`Notifications are on for this device (${result.devices} ${result.devices === 1 ? 'device' : 'devices'} total).`);
            await invalidate();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
            void refreshLocal();
        }
    }

    async function turnOff() {
        setBusy('off');
        try {
            await disablePush();
            toast('Notifications are off for this device.');
            await invalidate();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
            void refreshLocal();
        }
    }

    async function sendTest() {
        setBusy('test');
        try {
            const result = await api.testPush();
            if (result.sent > 0) toast(`Sent to ${result.sent} ${result.sent === 1 ? 'device' : 'devices'}.`);
            else if (result.pruned > 0) toast('That device is no longer reachable and was removed.', true);
            else toast('No device received it. Check the browser allows notifications.', true);
            await invalidate();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
        }
    }

    async function removeAll() {
        const ok = await confirm('Turn off browser notifications on every device? Each one can be turned back on from its own Settings.');
        if (!ok) return;
        setBusy('all');
        try {
            await api.unsubscribePush({ all: true });
            if (endpoint) {
                const sub = await getPushSubscription();
                try { await sub?.unsubscribe(); } catch { /* already gone */ }
            }
            toast('Browser notifications are off everywhere.');
            window.dispatchEvent(new Event(PUSH_STATE_EVENT));
            await invalidate();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
            void refreshLocal();
        }
    }

    if (!supported) {
        return (
            <div className="hint" data-testid="push-unsupported">
                {isIos() && !isStandalone()
                    ? 'On iPhone and iPad, add Goobster to your Home Screen first (Share → Add to Home Screen), then turn notifications on from the installed app.'
                    : 'This browser cannot receive push notifications.'}
            </div>
        );
    }
    if (status.isLoading) return <div className="hint">Checking…</div>;
    if (!data?.enabled) {
        return (
            <div className="hint" data-testid="push-disabled">
                {data?.reason === 'disabled'
                    ? 'The host turned browser notifications off for this installation.'
                    : 'This installation has no push keys configured, so browser notifications are unavailable. The host can set them in config.json (webapp.push) or let Goobster generate a pair under data/.'}
            </div>
        );
    }
    if (permission === 'denied') {
        return (
            <div className="hint" data-testid="push-blocked">
                Notifications are blocked for this site. Allow them in the browser's site settings, then come back here.
            </div>
        );
    }

    return (
        <div className="settings-stack push-settings" data-testid="push-settings">
            <div className="settings-inline-row">
                {thisDevice ? (
                    <button type="button" className="btn" disabled={busy !== null} onClick={turnOff} data-testid="push-off">
                        {busy === 'off' ? 'Turning off…' : 'Turn off for this device'}
                    </button>
                ) : (
                    <button type="button" className="btn primary" disabled={busy !== null} onClick={turnOn} data-testid="push-on">
                        {busy === 'on' ? 'Turning on…' : 'Turn on for this device'}
                    </button>
                )}
                {(data.devices > 0) && (
                    <button type="button" className="btn subtle" disabled={busy !== null} onClick={sendTest}>
                        {busy === 'test' ? 'Sending…' : 'Send a test'}
                    </button>
                )}
            </div>
            <div className="hint" data-testid="push-devices">
                {thisDevice ? 'On for this device. ' : 'Off for this device. '}
                {data.devices === 0
                    ? 'No devices enrolled.'
                    : `${data.devices} ${data.devices === 1 ? 'device is' : 'devices are'} enrolled on your account.`}
                {data.devices > 0 && (
                    <>
                        {' '}
                        <button type="button" className="link-btn" disabled={busy !== null} onClick={removeAll}>
                            {busy === 'all' ? 'Removing…' : 'Turn off everywhere'}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
