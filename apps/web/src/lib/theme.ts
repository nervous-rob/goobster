export type ThemeChoice = 'light' | 'dark' | 'system';

/**
 * Accent palettes. Each id has a `html[data-accent]` block in legacy.css
 * that sets `--accent-rgb` for dark and light surfaces; the list here must
 * match `ACCENTS` in packages/core/config/userSettingsSchema.js.
 */
export type AccentChoice = 'blueberry' | 'ocean' | 'mint' | 'sunset' | 'rose' | 'violet' | 'amber' | 'graphite';

export const ACCENTS: ReadonlyArray<{ value: AccentChoice; label: string; hint: string }> = [
    { value: 'blueberry', label: 'Blueberry', hint: 'Goobster\'s own indigo. The default.' },
    { value: 'ocean', label: 'Ocean', hint: 'A clear sky blue.' },
    { value: 'mint', label: 'Mint', hint: 'Fresh green.' },
    { value: 'sunset', label: 'Sunset', hint: 'Warm coral.' },
    { value: 'rose', label: 'Rose', hint: 'Soft pink.' },
    { value: 'violet', label: 'Violet', hint: 'Deep purple.' },
    { value: 'amber', label: 'Amber', hint: 'Golden honey.' },
    { value: 'graphite', label: 'Graphite', hint: 'Quiet, nearly neutral.' }
];

const KEY = 'goobster-theme';
const ACCENT_KEY = 'goobster-accent';
export const THEME_EVENT = 'goobster-theme-changed';
export const ACCENT_EVENT = 'goobster-accent-changed';

export function getStoredTheme(): ThemeChoice {
    const raw = localStorage.getItem(KEY);
    return raw === 'light' || raw === 'system' ? raw : 'dark';
}

export function isAccent(value: unknown): value is AccentChoice {
    return ACCENTS.some((a) => a.value === value);
}

export function getStoredAccent(): AccentChoice {
    const raw = localStorage.getItem(ACCENT_KEY);
    return isAccent(raw) ? raw : 'blueberry';
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
    if (choice !== 'system') return choice;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Paint the theme on <body> without persisting (used for live preview). */
export function paintTheme(choice: ThemeChoice): void {
    document.body.classList.toggle('light', resolveTheme(choice) === 'light');
}

/** Persist the device theme and tell the shell about it. */
export function setStoredTheme(choice: ThemeChoice): void {
    localStorage.setItem(KEY, choice);
    paintTheme(choice);
    window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_EVENT, { detail: choice }));
}

/** Paint the accent on <html> without persisting (live preview). */
export function paintAccent(choice: AccentChoice): void {
    document.documentElement.dataset.accent = choice;
}

/** Persist the device accent copy and paint it. */
export function setStoredAccent(choice: AccentChoice): void {
    localStorage.setItem(ACCENT_KEY, choice);
    paintAccent(choice);
    window.dispatchEvent(new CustomEvent<AccentChoice>(ACCENT_EVENT, { detail: choice }));
}
