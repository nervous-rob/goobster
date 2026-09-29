/**
 * The installed-app plumbing (documentation/pwa.md): install prompt,
 * service-worker registration and updates, stale-chunk recovery, the app
 * badge and the online/offline signal. Everything degrades to a no-op
 * where the browser lacks the API.
 */
import { useCallback, useEffect, useState } from 'react';

// --- Install prompt ------------------------------------------------------------

type BeforeInstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export const INSTALL_EVENT = 'goobster-install-changed';

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;

/**
 * Chromium fires `beforeinstallprompt` early, often before React mounts,
 * so the listener is attached from `main.tsx` and the event kept for the
 * Settings button to replay.
 */
export function captureInstallPrompt(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event as BeforeInstallPromptEvent;
        window.dispatchEvent(new Event(INSTALL_EVENT));
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        installed = true;
        window.dispatchEvent(new Event(INSTALL_EVENT));
    });
}

export function isStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.matchMedia?.('(display-mode: window-controls-overlay)').matches) return true;
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const iPadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return /iPhone|iPad|iPod/.test(ua) || iPadOs;
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = deferredPrompt;
    if (!event) return 'unavailable';
    try {
        await event.prompt();
        const choice = await event.userChoice;
        if (choice.outcome === 'accepted') {
            deferredPrompt = null;
            window.dispatchEvent(new Event(INSTALL_EVENT));
        }
        return choice.outcome;
    } catch {
        return 'unavailable';
    }
}

/** Settings → Appearance field that holds the install card and instructions. */
export const INSTALL_FIELD_ID = 'install-app';

const INSTALL_NUDGE_KEY = 'goobster-install-nudge-dismissed-at';
const INSTALL_NUDGE_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export function installNudgeDismissed(): boolean {
    try {
        const at = Number(localStorage.getItem(INSTALL_NUDGE_KEY) || 0);
        return at > 0 && Date.now() - at < INSTALL_NUDGE_SNOOZE_MS;
    } catch {
        return false;
    }
}

export function dismissInstallNudge(): void {
    try { localStorage.setItem(INSTALL_NUDGE_KEY, String(Date.now())); } catch { /* private mode */ }
    window.dispatchEvent(new Event(INSTALL_EVENT));
}

export function useInstallPrompt(): {
    /** Chromium handed us a prompt we can replay on click. */
    available: boolean;
    installed: boolean;
    standalone: boolean;
    ios: boolean;
    /** Nothing to offer: already installed, or running as the app. */
    done: boolean;
    /** The shell banner may be shown (installable, not snoozed). */
    nudge: boolean;
    install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
    dismissNudge: () => void;
} {
    const [, bump] = useState(0);
    useEffect(() => {
        const onChange = () => bump((n) => n + 1);
        window.addEventListener(INSTALL_EVENT, onChange);
        return () => window.removeEventListener(INSTALL_EVENT, onChange);
    }, []);
    const available = Boolean(deferredPrompt);
    const standalone = isStandalone();
    const ios = isIos();
    const done = standalone || installed;
    return {
        available,
        installed,
        standalone,
        ios,
        done,
        // Only nudge where a one-tap (or one-sheet) install actually exists;
        // browsers that need a menu dig get the nav entry, not a banner.
        nudge: !done && (available || ios) && !installNudgeDismissed(),
        install: promptInstall,
        dismissNudge: dismissInstallNudge
    };
}

// --- Service worker: registration, updates, worker messages -----------------------

export const SW_UPDATE_EVENT = 'goobster-sw-update';
export const NAVIGATE_EVENT = 'goobster-navigate';

let waitingWorker: ServiceWorker | null = null;
let reloadOnControllerChange = false;

function announceWaiting(worker: ServiceWorker): void {
    waitingWorker = worker;
    window.dispatchEvent(new Event(SW_UPDATE_EVENT));
}

function trackInstalling(worker: ServiceWorker): void {
    worker.addEventListener('statechange', () => {
        // `installed` with a live controller means an update is waiting;
        // on the very first install there is no controller and the worker
        // simply takes over.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announceWaiting(worker);
    });
}

export function registerServiceWorker(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller) announceWaiting(registration.waiting);
        if (registration.installing) trackInstalling(registration.installing);
        registration.addEventListener('updatefound', () => {
            if (registration.installing) trackInstalling(registration.installing);
        });
        // A tab that stays open for days still learns about a deploy.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) registration.update().catch(() => { /* offline */ });
        });
    }).catch(() => { /* optional */ });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadOnControllerChange) window.location.reload();
    });
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string; path?: string } | null;
        if (data?.type === 'goobster:navigate' && typeof data.path === 'string') {
            window.dispatchEvent(new CustomEvent<string>(NAVIGATE_EVENT, { detail: data.path }));
        }
    });
}

export function hasWaitingUpdate(): boolean {
    return Boolean(waitingWorker);
}

/** The person accepted the update: let the waiting worker take over, then reload. */
export function applyUpdate(): void {
    if (!waitingWorker) {
        window.location.reload();
        return;
    }
    reloadOnControllerChange = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    // If the new worker never claims (another tab holds it back), do not
    // leave the person on a dead button.
    window.setTimeout(() => { if (reloadOnControllerChange) window.location.reload(); }, 4000);
}

export function useServiceWorkerUpdate(): { available: boolean; apply: () => void } {
    const [available, setAvailable] = useState(() => hasWaitingUpdate());
    useEffect(() => {
        const onUpdate = () => setAvailable(true);
        window.addEventListener(SW_UPDATE_EVENT, onUpdate);
        return () => window.removeEventListener(SW_UPDATE_EVENT, onUpdate);
    }, []);
    return { available, apply: applyUpdate };
}

// --- Stale-chunk recovery ------------------------------------------------------

const RELOAD_KEY = 'goobster-chunk-reload';
const RELOAD_WINDOW_MS = 60_000;

/** A lazy route whose hashed chunk vanished with a deploy (or never loaded offline). */
export function isChunkLoadError(error: unknown): boolean {
    const message = String((error as { message?: string })?.message || error || '');
    return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading (CSS )?chunk/i.test(message);
}

/**
 * Reload at most once per minute so a genuinely broken build cannot spin
 * the tab; returns whether a reload was issued.
 */
export function reloadOnce(): boolean {
    try {
        const last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0);
        if (Date.now() - last < RELOAD_WINDOW_MS) return false;
        window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
        // private mode: still reload once per page life
        if ((window as Window & { __goobsterReloaded?: boolean }).__goobsterReloaded) return false;
        (window as Window & { __goobsterReloaded?: boolean }).__goobsterReloaded = true;
    }
    window.location.reload();
    return true;
}

/** Vite reports failed modulepreloads as `vite:preloadError` on window. */
export function installChunkRecovery(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('vite:preloadError', (event) => {
        if (reloadOnce()) event.preventDefault();
    });
}

// --- App badge -----------------------------------------------------------------

type BadgeNavigator = Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
};

export function setAppBadge(count: number): void {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as BadgeNavigator;
    try {
        if (count > 0) void nav.setAppBadge?.(count)?.catch(() => { /* no badge surface */ });
        else void nav.clearAppBadge?.()?.catch(() => { /* no badge surface */ });
    } catch { /* unsupported */ }
}

// --- Online / offline ----------------------------------------------------------

export function useOnline(): boolean {
    const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    useEffect(() => {
        const up = () => setOnline(true);
        const down = () => setOnline(false);
        window.addEventListener('online', up);
        window.addEventListener('offline', down);
        return () => {
            window.removeEventListener('online', up);
            window.removeEventListener('offline', down);
        };
    }, []);
    return online;
}

/** Subscribe to the worker's "open this path" messages (notification clicks). */
export function useWorkerNavigation(onNavigate: (path: string) => void): void {
    const handler = useCallback((event: Event) => {
        const path = (event as CustomEvent<string>).detail;
        if (typeof path === 'string') onNavigate(path);
    }, [onNavigate]);
    useEffect(() => {
        window.addEventListener(NAVIGATE_EVENT, handler);
        return () => window.removeEventListener(NAVIGATE_EVENT, handler);
    }, [handler]);
}
