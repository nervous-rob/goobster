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

let themeColorFrame = 0;
/**
 * Keep the PWA/browser chrome on the page's own surface. `--bg` is rebuilt
 * from theme + accent by the stylesheet, so it is read back after a paint
 * rather than duplicated here.
 */
function syncThemeColor(): void {
    if (themeColorFrame) return;
    themeColorFrame = window.requestAnimationFrame(() => {
        themeColorFrame = 0;
        const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
        if (!meta) return;
        // <body> animates its background, so resolve --bg on a probe that
        // does not, then drop the probe.
        const probe = document.createElement('span');
        probe.style.cssText = 'position:fixed;width:0;height:0;transition:none;background-color:var(--bg)';
        document.body.appendChild(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        if (!bg || bg === 'rgba(0, 0, 0, 0)') return;
        // The surface is declared in oklch; hand the chrome plain sRGB.
        try {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            if (!ctx) { meta.content = bg; return; }
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            meta.content = `rgb(${r}, ${g}, ${b})`;
        } catch {
            meta.content = bg;
        }
    });
}

/** Paint the theme on <body> without persisting (used for live preview). */
export function paintTheme(choice: ThemeChoice): void {
    document.body.classList.toggle('light', resolveTheme(choice) === 'light');
    syncThemeColor();
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
    syncThemeColor();
}

/** Persist the device accent copy and paint it. */
export function setStoredAccent(choice: AccentChoice): void {
    localStorage.setItem(ACCENT_KEY, choice);
    paintAccent(choice);
    window.dispatchEvent(new CustomEvent<AccentChoice>(ACCENT_EVENT, { detail: choice }));
}
