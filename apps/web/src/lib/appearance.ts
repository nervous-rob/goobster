/**
 * Device-applied appearance prefs (UI02–UI04). Account values live in
 * user_settings; this paints the current document and keeps a local copy
 * so a refresh does not flash the default before settings load.
 */

export type TextSize = 's' | 'm' | 'l';
export type Density = 'comfortable' | 'compact';
export type ReducedMotion = 'system' | 'on' | 'off';

const TEXT_KEY = 'goobster-text-size';
const DENSITY_KEY = 'goobster-density';
const MOTION_KEY = 'goobster-reduced-motion';
const MIC_KEY = 'goobster-preferred-mic';
const VOLUME_KEY = 'goobster-voice-volume';

export const APPEARANCE_EVENT = 'goobster-appearance-changed';

export function getStoredTextSize(): TextSize {
    const raw = localStorage.getItem(TEXT_KEY);
    return raw === 's' || raw === 'l' ? raw : 'm';
}

export function getStoredDensity(): Density {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
}

export function getStoredReducedMotion(): ReducedMotion {
    const raw = localStorage.getItem(MOTION_KEY);
    return raw === 'on' || raw === 'off' ? raw : 'system';
}

export function getStoredMicId(): string | null {
    return localStorage.getItem(MIC_KEY) || null;
}

export function getStoredVoiceVolume(): number {
    const n = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

export function paintAppearance(opts: {
    textSize?: TextSize;
    density?: Density;
    reducedMotion?: ReducedMotion;
}): void {
    const root = document.documentElement;
    if (opts.textSize) root.dataset.textSize = opts.textSize;
    if (opts.density) root.dataset.density = opts.density;
    if (opts.reducedMotion) {
        root.dataset.reducedMotion = opts.reducedMotion;
        const reduce = opts.reducedMotion === 'on'
            || (opts.reducedMotion === 'system' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
        root.classList.toggle('reduce-motion', Boolean(reduce));
    }
}

export function persistAppearance(opts: {
    textSize?: TextSize;
    density?: Density;
    reducedMotion?: ReducedMotion;
}): void {
    if (opts.textSize) localStorage.setItem(TEXT_KEY, opts.textSize);
    if (opts.density) localStorage.setItem(DENSITY_KEY, opts.density);
    if (opts.reducedMotion) localStorage.setItem(MOTION_KEY, opts.reducedMotion);
    paintAppearance(opts);
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
}

export function persistMicId(id: string | null): void {
    if (id) localStorage.setItem(MIC_KEY, id);
    else localStorage.removeItem(MIC_KEY);
}

export function persistVoiceVolume(value: number): void {
    localStorage.setItem(VOLUME_KEY, String(value));
}

export function deviceLocalKeys(): string[] {
    return [
        'goobster-theme',
        TEXT_KEY,
        DENSITY_KEY,
        MOTION_KEY,
        MIC_KEY,
        VOLUME_KEY,
        'goobster.map.linkByTag',
        'goobster-exchange-guild'
    ];
}

export function previewDeviceClear(): { keys: string[]; conservatory: boolean } {
    const keys = deviceLocalKeys().filter((key) => {
        try { return localStorage.getItem(key) !== null; } catch { return false; }
    });
    let conservatory = false;
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith('goobster.conservatory.')) conservatory = true;
        }
    } catch { /* private mode */ }
    return { keys, conservatory };
}

export function clearDeviceLocalData({ includeConservatory = false } = {}): void {
    for (const key of deviceLocalKeys()) {
        try { localStorage.removeItem(key); } catch { /* private mode */ }
    }
    if (includeConservatory) {
        try {
            const doomed: string[] = [];
            for (let i = 0; i < localStorage.length; i += 1) {
                const key = localStorage.key(i);
                if (key && key.startsWith('goobster.conservatory.')) doomed.push(key);
            }
            for (const key of doomed) localStorage.removeItem(key);
        } catch { /* private mode */ }
    }
}
