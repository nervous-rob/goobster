export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'goobster-theme';
export const THEME_EVENT = 'goobster-theme-changed';

export function getStoredTheme(): ThemeChoice {
    const raw = localStorage.getItem(KEY);
    return raw === 'light' || raw === 'system' ? raw : 'dark';
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
