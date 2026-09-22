/** A browser lifetime is bound to one installation, account and session. */
import type { Me } from './types';

export const SESSION_CHANGED = 'goobster-session-changed';
export const ACCOUNT_STORAGE_CHANGED = 'goobster-account-storage-changed';
const NOTICE_KEY = 'goobster-session-notice';
let current: Me | null = null;
let lifetime = new AbortController();

export function sessionKey(me: Me | null): string {
    return me ? `${me.identity?.installationId || location.origin}/${me.user.id}/${me.sessionId || ''}` : '';
}

export function accountStoragePrefix(): string {
    if (!current) throw new Error('Sign in before using account storage.');
    return `goobster.account.${encodeURIComponent(current.identity?.installationId || location.origin)}.${encodeURIComponent(current.user.id)}.`;
}

export function bindBrowserAccount(me: Me | null): void {
    if (sessionKey(me) === sessionKey(current)) return;
    lifetime.abort();
    lifetime = new AbortController();
    current = me;
    window.dispatchEvent(new Event(ACCOUNT_STORAGE_CHANGED));
}

/** Hide private UI immediately; every tab then resolves the cookie again. */
export function sessionChanged(broadcast = true): void {
    lifetime.abort();
    lifetime = new AbortController();
    current = null;
    window.dispatchEvent(new Event(ACCOUNT_STORAGE_CHANGED));
    window.dispatchEvent(new Event(SESSION_CHANGED));
    if (broadcast) {
        try { localStorage.setItem(NOTICE_KEY, crypto.randomUUID()); } catch { /* private mode */ }
    }
}

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
    if (event.key === NOTICE_KEY) sessionChanged(false);
});

export async function accountFetch(url: string, init: RequestInit = {}): Promise<Response> {
    // /me resolves changes; auth endpoints intentionally replace the cookie.
    const target = new URL(url, location.origin);
    const privateRequest = target.origin === location.origin && target.pathname.startsWith('/api/app/')
        && !['/api/app/me', '/api/app/config'].includes(target.pathname)
        && !target.pathname.startsWith('/api/app/auth/');
    const scope = lifetime;
    const headers = new Headers(init.headers);
    if (current && privateRequest) {
        headers.set('X-Goobster-Account', current.user.id);
        if (current.sessionId) headers.set('X-Goobster-Session', String(current.sessionId));
    }
    const signal = init.signal ? AbortSignal.any([init.signal, scope.signal]) : scope.signal;
    const response = await fetch(url, { ...init, headers, signal });
    if (scope.signal.aborted) throw new DOMException('Account changed', 'AbortError');
    if (privateRequest && (response.status === 401 || response.headers.get('X-Goobster-Session-Invalid') === '1')) {
        sessionChanged();
        throw new DOMException('Session ended', 'AbortError');
    }
    return response;
}
