import { conservatoryStorageKey, clearConservatoryStorage } from '../music-lab/lib/storage';
/**
 * Device-applied appearance prefs (UI02–UI04). Account values live in
 * user_settings; this paints the current document and keeps a local copy
 * so a refresh does not flash the default before settings load.
 */

export type TextSize = 's' | 'm' | 'l';
export type Density = 'comfortable' | 'compact';
export type ReducedMotion = 'system' | 'on' | 'off';
/** Where the primary room navigation lives: the left sidebar or a bar across the top. */
export type NavLayout = 'sidebar' | 'top';
/** How wide rooms draw: centred on a column (the default) or across the whole window. */
export type PageWidth = 'centered' | 'full';
/** The icon language the portal draws its room, view and section icons in; `emoji` is the original look. */
export type IconStyle = 'emoji' | 'mono' | 'blocks' | 'sigils' | 'pixel' | 'neon' | 'constellation';
export const ICON_STYLES: IconStyle[] = ['emoji', 'mono', 'blocks', 'sigils', 'pixel', 'neon', 'constellation'];
export function isIconStyle(value: unknown): value is IconStyle {
    return typeof value === 'string' && (ICON_STYLES as string[]).includes(value);
}

const TEXT_KEY = 'goobster-text-size';
const DENSITY_KEY = 'goobster-density';
const MOTION_KEY = 'goobster-reduced-motion';
const NAV_LAYOUT_KEY = 'goobster-nav-layout';
const PAGE_WIDTH_KEY = 'goobster-page-width';
const ICON_STYLE_KEY = 'goobster-icon-style';
const MIC_KEY = 'goobster-preferred-mic';
const VOLUME_KEY = 'goobster-voice-volume';

export const APPEARANCE_EVENT = 'goobster-appearance-changed';
/** Fired with the layout as `detail` on every paint (preview or persist) so the shell re-renders. */
export const NAV_LAYOUT_EVENT = 'goobster-nav-layout-changed';

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

export function getStoredNavLayout(): NavLayout {
    return localStorage.getItem(NAV_LAYOUT_KEY) === 'top' ? 'top' : 'sidebar';
}

/**
 * Paint the navigation layout without persisting (live preview). The shell
 * renders the sidebar or the top bar from this event, and the `<html>`
 * attribute lets the stylesheet adjust before React mounts.
 */
export function paintNavLayout(layout: NavLayout): void {
    document.documentElement.dataset.navLayout = layout;
    window.dispatchEvent(new CustomEvent<NavLayout>(NAV_LAYOUT_EVENT, { detail: layout }));
}

export function persistNavLayout(layout: NavLayout): void {
    localStorage.setItem(NAV_LAYOUT_KEY, layout);
    paintNavLayout(layout);
}

export function getStoredPageWidth(): PageWidth {
    return localStorage.getItem(PAGE_WIDTH_KEY) === 'full' ? 'full' : 'centered';
}

/** Paint the page width without persisting (live preview); the stylesheet reads `html[data-page-width]`. */
export function paintPageWidth(width: PageWidth): void {
    document.documentElement.dataset.pageWidth = width;
}

export function persistPageWidth(width: PageWidth): void {
    localStorage.setItem(PAGE_WIDTH_KEY, width);
    paintPageWidth(width);
}

/** Fired with the style as `detail` on every paint so `<Icon>` instances re-render. */
export const ICON_STYLE_EVENT = 'goobster-icon-style-changed';

export function getStoredIconStyle(): IconStyle {
    const raw = localStorage.getItem(ICON_STYLE_KEY);
    return isIconStyle(raw) ? raw : 'emoji';
}

/** Paint the icon style without persisting (live preview); `<Icon>` reads `html[data-icon-style]`. */
export function paintIconStyle(style: IconStyle): void {
    document.documentElement.dataset.iconStyle = style;
    window.dispatchEvent(new CustomEvent<IconStyle>(ICON_STYLE_EVENT, { detail: style }));
}

export function persistIconStyle(style: IconStyle): void {
    localStorage.setItem(ICON_STYLE_KEY, style);
    paintIconStyle(style);
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
        'goobster-accent',
        'goobster-surface',
        TEXT_KEY,
        DENSITY_KEY,
        MOTION_KEY,
        NAV_LAYOUT_KEY,
        PAGE_WIDTH_KEY,
        ICON_STYLE_KEY,
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
            if (key && key.startsWith(conservatoryStorageKey(''))) conservatory = true;
        }
    } catch { /* private mode */ }
    return { keys, conservatory };
}

export function clearDeviceLocalData({ includeConservatory = false } = {}): void {
    for (const key of deviceLocalKeys()) {
        try { localStorage.removeItem(key); } catch { /* private mode */ }
    }
    if (includeConservatory) clearConservatoryStorage();
}
