export const CONSERVATORY_STORAGE_PREFIX = 'goobster.conservatory.';

export function conservatoryStorageKey(key: string): string {
    return key.startsWith(CONSERVATORY_STORAGE_PREFIX) ? key : `${CONSERVATORY_STORAGE_PREFIX}${key}`;
}

export function readConservatoryStorage(key: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage.getItem(conservatoryStorageKey(key));
    } catch {
        return null;
    }
}

export function writeConservatoryStorage(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(conservatoryStorageKey(key), value);
    } catch {
        // Storage full or unavailable — callers treat this as best-effort.
    }
}

export function removeConservatoryStorage(key: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(conservatoryStorageKey(key));
    } catch {
        // best-effort
    }
}

/** Drops every Conservatory localStorage key. Sample clips live in IndexedDB. */
export function clearConservatoryStorage(): void {
    if (typeof window === 'undefined') return;
    try {
        const doomed: string[] = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
            const stored = window.localStorage.key(i);
            if (stored?.startsWith(CONSERVATORY_STORAGE_PREFIX)) doomed.push(stored);
        }
        for (const stored of doomed) window.localStorage.removeItem(stored);
    } catch {
        // best-effort
    }
}
