/**
 * Browser notifications for the portal (documentation/pwa.md).
 *
 * Two layers share one permission: a local notification the open tab
 * raises through its service worker when it is hidden, and Web Push,
 * which reaches the device with no tab open. When this browser holds a
 * push subscription the local layer steps aside - the push already
 * carries the same tag, so nothing shows twice.
 */
import { api } from './api';

export const PUSH_STATE_EVENT = 'goobster-push-changed';

export type PermissionState = NotificationPermission | 'unsupported';

export function notificationsSupported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

export function pushSupported(): boolean {
    return notificationsSupported() && 'PushManager' in window;
}

export function permissionState(): PermissionState {
    if (!notificationsSupported()) return 'unsupported';
    return Notification.permission;
}

let pushActive: boolean | null = null;

async function registration(): Promise<ServiceWorkerRegistration | null> {
    if (!('serviceWorker' in navigator)) return null;
    try {
        return await navigator.serviceWorker.ready;
    } catch {
        return null;
    }
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
    if (!pushSupported()) return null;
    const reg = await registration();
    if (!reg) return null;
    try {
        const sub = await reg.pushManager.getSubscription();
        pushActive = Boolean(sub);
        return sub;
    } catch {
        return null;
    }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(normalized);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

/** Ask for permission (if needed), subscribe this browser, and tell the server. */
export async function enablePush(publicKey: string): Promise<{ devices: number }> {
    if (!pushSupported()) throw new Error('This browser cannot receive push notifications.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications were not allowed for this site.');
    const reg = await registration();
    if (!reg) throw new Error('The app is still installing; try again in a moment.');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource
        });
    }
    const result = await api.subscribePush(sub.toJSON());
    pushActive = true;
    window.dispatchEvent(new Event(PUSH_STATE_EVENT));
    return result;
}

/** Drop this browser's subscription on both ends. */
export async function disablePush(): Promise<{ devices: number }> {
    const sub = await getPushSubscription();
    let devices = 0;
    if (sub) {
        const endpoint = sub.endpoint;
        try { await sub.unsubscribe(); } catch { /* already gone */ }
        devices = (await api.unsubscribePush({ endpoint })).devices;
    }
    pushActive = false;
    window.dispatchEvent(new Event(PUSH_STATE_EVENT));
    return { devices };
}

/**
 * A notification from the open tab while it is hidden. Skipped when the
 * tab is visible (the in-app notice is on screen), when permission was
 * not granted, or when this browser receives push (which carries the
 * same tag).
 */
export async function showLocalNotification({ title, body, link, tag }: {
    title: string;
    body?: string | null;
    link?: string | null;
    tag?: string | null;
}): Promise<boolean> {
    if (!notificationsSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    if (document.visibilityState === 'visible') return false;
    if (pushActive === null) await getPushSubscription();
    if (pushActive) return false;
    const reg = await registration();
    if (!reg) return false;
    try {
        await reg.showNotification(title, {
            body: body || undefined,
            tag: tag || undefined,
            icon: '/app/icons/icon-192.png',
            badge: '/app/icons/icon-192.png',
            data: { link: link || '/activity/inbox' }
        });
        return true;
    } catch {
        return false;
    }
}
