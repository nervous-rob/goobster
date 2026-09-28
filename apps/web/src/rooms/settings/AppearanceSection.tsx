import { useCallback, useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import {
    ACCENTS, SURFACES, getStoredAccent, getStoredSurface, getStoredTheme, isAccent, isSurface,
    paintAccent, paintSurface, paintTheme, setStoredAccent, setStoredSurface, setStoredTheme,
    type AccentChoice, type SurfaceChoice, type ThemeChoice
} from '../../lib/theme';
import {
    getStoredDensity,
    getStoredNavLayout,
    getStoredReducedMotion,
    getStoredTextSize,
    paintAppearance,
    paintNavLayout,
    persistAppearance,
    persistNavLayout,
    type Density,
    type NavLayout,
    type ReducedMotion,
    type TextSize
} from '../../lib/appearance';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';
import { useSession } from '../../hooks/useSession';
import { START_PAGE_OPTIONS, TOOL_ROOMS, startPageOptionFor } from '../../lib/rooms';

type Values = UserSettingsResponse['sections']['appearance']['values'];
type Draft = {
    theme: ThemeChoice;
    accent: AccentChoice;
    surface: SurfaceChoice;
    navLayout: NavLayout;
    linkByTag: boolean;
    textSize: TextSize;
    reducedMotion: ReducedMotion;
    density: Density;
    enterToSend: boolean;
    expandChatDetails: boolean;
    startPage: Values['startPage'];
    hiddenToolRooms: string[];
    preferredExchangeGuild: string;
    expeditionDefaultDepth: Values['expeditionDefaultDepth'];
    expeditionDefaultLens: string;
    parlorDefaultEmoji: string;
    parlorDefaultCharter: string;
};

const THEMES: Array<{ value: ThemeChoice; label: string; hint: string }> = [
    { value: 'dark', label: '🌙 Dark', hint: 'The default.' },
    { value: 'light', label: '☀️ Light', hint: 'Bright surfaces.' },
    { value: 'system', label: '🖥️ System', hint: 'Follow this device\'s setting.' }
];

const NAV_LAYOUTS: Array<{ value: NavLayout; label: string; hint: string }> = [
    { value: 'sidebar', label: '◧ Sidebar', hint: 'Rooms in a column on the left. The default.' },
    { value: 'top', label: '⬒ Across the top', hint: 'Rooms in a bar along the top of the page; the account menu moves to the right.' }
];

const LABELS: Record<string, string> = {
    theme: 'Theme',
    accent: 'Accent color',
    surface: 'Surface',
    navLayout: 'Navigation',
    linkByTag: 'Link notes by shared tag',
    textSize: 'Text size',
    reducedMotion: 'Reduced motion',
    density: 'Interface density',
    enterToSend: 'Enter to send',
    expandChatDetails: 'Expand chat details',
    startPage: 'Start page',
    hiddenToolRooms: 'Hidden tools',
    preferredExchangeGuild: 'Preferred Exchange server',
    expeditionDefaultDepth: 'Expedition depth',
    expeditionDefaultLens: 'Expedition lens',
    parlorDefaultEmoji: 'New persona emoji',
    parlorDefaultCharter: 'New persona charter'
};
const EXPEDITION_LENSES = [
    { id: 'general', name: 'General' },
    { id: 'scientific-literature', name: 'Scientific literature' },
    { id: 'mathematics', name: 'Mathematics' },
    { id: 'history', name: 'History' },
    { id: 'engineering', name: 'Engineering' },
    { id: 'journalism', name: 'Journalism' },
    { id: 'storytelling', name: 'Storytelling' },
    { id: 'philosophy', name: 'Philosophy' }
];
const LINK_BY_TAG_KEY = 'goobster.map.linkByTag';

export function AppearanceSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['appearance'];
    onDirty: (dirty: boolean) => void;
}) {
    const me = useSession();
    const guilds = (me?.scopes || []).filter((s) => s.kind === 'guild');

    const toDraft = useCallback((v: Values): Draft => ({
        theme: getStoredTheme() || v.theme,
        accent: isAccent(v.accent) ? v.accent : getStoredAccent(),
        surface: isSurface(v.surface) ? v.surface : getStoredSurface(),
        navLayout: v.navLayout === 'top' || v.navLayout === 'sidebar' ? v.navLayout : getStoredNavLayout(),
        linkByTag: localStorage.getItem(LINK_BY_TAG_KEY) === null ? Boolean(v.linkByTag) : localStorage.getItem(LINK_BY_TAG_KEY) !== '0',
        textSize: getStoredTextSize() || v.textSize || 'm',
        reducedMotion: getStoredReducedMotion() || v.reducedMotion || 'system',
        density: getStoredDensity() || v.density || 'comfortable',
        enterToSend: v.enterToSend !== false,
        expandChatDetails: Boolean(v.expandChatDetails),
        startPage: v.startPage || 'home',
        hiddenToolRooms: Array.isArray(v.hiddenToolRooms) ? v.hiddenToolRooms : [],
        preferredExchangeGuild: v.preferredExchangeGuild || '',
        expeditionDefaultDepth: v.expeditionDefaultDepth || 'standard',
        expeditionDefaultLens: v.expeditionDefaultLens || 'general',
        parlorDefaultEmoji: v.parlorDefaultEmoji || '',
        parlorDefaultCharter: v.parlorDefaultCharter || ''
    }), []);
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        if ('preferredExchangeGuild' in diff) diff.preferredExchangeGuild = draft.preferredExchangeGuild || null;
        if ('parlorDefaultEmoji' in diff) diff.parlorDefaultEmoji = draft.parlorDefaultEmoji.trim() || null;
        if ('parlorDefaultCharter' in diff) diff.parlorDefaultCharter = draft.parlorDefaultCharter.trim() || null;
        return diff;
    }, []);
    const d = useSectionDraft('appearance', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    useEffect(() => {
        paintTheme(d.draft.theme);
        paintAccent(d.draft.accent);
        paintSurface(d.draft.surface);
        paintAppearance({ textSize: d.draft.textSize, density: d.draft.density, reducedMotion: d.draft.reducedMotion });
    }, [d.draft.theme, d.draft.accent, d.draft.surface, d.draft.textSize, d.draft.density, d.draft.reducedMotion]);
    // The layout previews too, but not on mount: painting the stored value
    // again would only re-render the shell for nothing.
    const layoutPainted = useRef(false);
    useEffect(() => {
        if (!layoutPainted.current) { layoutPainted.current = true; return; }
        paintNavLayout(d.draft.navLayout);
    }, [d.draft.navLayout]);
    useEffect(() => () => {
        paintTheme(getStoredTheme());
        paintAccent(getStoredAccent());
        paintSurface(getStoredSurface());
        paintNavLayout(getStoredNavLayout());
        paintAppearance({
            textSize: getStoredTextSize(),
            density: getStoredDensity(),
            reducedMotion: getStoredReducedMotion()
        });
    }, []);

    function persistLocal() {
        setStoredTheme(d.draft.theme);
        setStoredAccent(d.draft.accent);
        setStoredSurface(d.draft.surface);
        persistNavLayout(d.draft.navLayout);
        localStorage.setItem(LINK_BY_TAG_KEY, d.draft.linkByTag ? '1' : '0');
        persistAppearance({
            textSize: d.draft.textSize,
            density: d.draft.density,
            reducedMotion: d.draft.reducedMotion
        });
        if (d.draft.preferredExchangeGuild) {
            try { localStorage.setItem('goobster-exchange-guild', d.draft.preferredExchangeGuild); } catch { /* private mode */ }
        }
    }

    return (
        <section className="settings-section" aria-labelledby="settings-appearance-title">
            <SectionHeader id="appearance" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="theme" label="Theme" scope="Your account"
                hint="Previews as you pick. Save keeps it for this device and remembers it on your account for new devices.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Theme" id="theme-input">
                    {THEMES.map((t) => (
                        <button key={t.value} type="button" role="radio" aria-checked={d.draft.theme === t.value}
                            title={t.hint}
                            className={`segment-btn${d.draft.theme === t.value ? ' active' : ''}`}
                            onClick={() => d.set({ theme: t.value })}>{t.label}</button>
                    ))}
                </div>
            </Field>

            <Field id="accent" label="Accent color" scope="Your account"
                hint="Tints buttons, links, the active room, and the room glow. Previews as you pick; Save keeps it on your account.">
                <div className="accent-swatches" role="radiogroup" aria-label="Accent color" id="accent-input">
                    {ACCENTS.map((a) => (
                        <button key={a.value} type="button" role="radio" aria-checked={d.draft.accent === a.value}
                            aria-label={a.label} title={a.hint} data-accent={a.value}
                            className="accent-swatch" onClick={() => d.set({ accent: a.value })}>
                            <span className="accent-swatch-dot" aria-hidden="true">{d.draft.accent === a.value ? '✓' : ''}</span>
                            <span>{a.label}</span>
                        </button>
                    ))}
                </div>
            </Field>

            <Field id="surface" label="Surface" scope="Your account"
                hint="Tinted rebuilds the backgrounds, borders, and text greys from the accent, so light/dark sets how bright the page is and the accent sets what it leans towards. Neutral keeps the fixed greys and lets the accent show in controls and the room glow only.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Surface" id="surface-input">
                    {SURFACES.map((s) => (
                        <button key={s.value} type="button" role="radio" aria-checked={d.draft.surface === s.value}
                            title={s.hint}
                            className={`segment-btn${d.draft.surface === s.value ? ' active' : ''}`}
                            onClick={() => d.set({ surface: s.value })}>{s.label}</button>
                    ))}
                </div>
            </Field>

            <Field id="nav-layout" label="Navigation" scope="Your account"
                hint="Where the rooms live. Previews as you pick. Across the top puts Usage, Host, Documentation, and Log out behind your avatar.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Navigation layout" id="nav-layout-input">
                    {NAV_LAYOUTS.map((n) => (
                        <button key={n.value} type="button" role="radio" aria-checked={d.draft.navLayout === n.value}
                            title={n.hint}
                            className={`segment-btn${d.draft.navLayout === n.value ? ' active' : ''}`}
                            onClick={() => d.set({ navLayout: n.value })}>{n.label}</button>
                    ))}
                </div>
            </Field>

            <Field id="text-size" label="Text size" scope="Your account"
                hint="A bounded reading scale. Browser zoom still works.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Text size" id="text-size-input">
                    {([['s', 'Small'], ['m', 'Medium'], ['l', 'Large']] as const).map(([value, label]) => (
                        <button key={value} type="button" role="radio" aria-checked={d.draft.textSize === value}
                            className={`segment-btn${d.draft.textSize === value ? ' active' : ''}`}
                            onClick={() => d.set({ textSize: value })}>{label}</button>
                    ))}
                </div>
            </Field>

            <Field id="reduced-motion" label="Reduced motion" scope="Your account"
                hint="Follows the system by default. Applies to atmosphere, animations, and transitions.">
                <select id="reduced-motion-input" className="input" value={d.draft.reducedMotion}
                    onChange={(e) => d.set({ reducedMotion: e.target.value as ReducedMotion })}>
                    <option value="system">Follow system</option>
                    <option value="on">Reduce motion</option>
                    <option value="off">Allow motion</option>
                </select>
            </Field>

            <Field id="density" label="Interface density" scope="Your account"
                hint="Compact never shrinks mobile controls below a usable touch target.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Density" id="density-input">
                    <button type="button" role="radio" aria-checked={d.draft.density === 'comfortable'}
                        className={`segment-btn${d.draft.density === 'comfortable' ? ' active' : ''}`}
                        onClick={() => d.set({ density: 'comfortable' })}>Comfortable</button>
                    <button type="button" role="radio" aria-checked={d.draft.density === 'compact'}
                        className={`segment-btn${d.draft.density === 'compact' ? ' active' : ''}`}
                        onClick={() => d.set({ density: 'compact' })}>Compact</button>
                </div>
            </Field>

            <Field id="enter-to-send" label="Enter to send" inline scope="Your account"
                hint="On: Enter sends in Study and Parlor, Shift+Enter inserts a newline. Off: Enter inserts a newline; use the Send button or Ctrl/Cmd+Enter. IME composition is always respected.">
                <button id="enter-to-send-input" type="button" className={`toggle${d.draft.enterToSend ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.enterToSend} aria-label="Enter to send"
                    onClick={() => d.set({ enterToSend: !d.draft.enterToSend })} />
            </Field>

            <Field id="expand-details" label="Expand chat details by default" inline scope="Your account"
                hint="Start with tool steps, thinking, and attachments expanded. You can still collapse a single message.">
                <button id="expand-details-input" type="button" className={`toggle${d.draft.expandChatDetails ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.expandChatDetails} aria-label="Expand chat details"
                    onClick={() => d.set({ expandChatDetails: !d.draft.expandChatDetails })} />
            </Field>

            <Field id="start-page" label="Start page" scope="Your account"
                hint="Where the portal opens after sign-in. Falls back to Home if that room is unavailable.">
                <select id="start-page-input" className="input" value={startPageOptionFor(d.draft.startPage)}
                    onChange={(e) => d.set({ startPage: e.target.value as Draft['startPage'] })}>
                    {START_PAGE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
            </Field>

            <Field id="hidden-tools" label="Hidden tools" scope="Your account"
                hint="Checked tools leave the Tools page and are not offered in navigation. Opening the address still works. This does not change whether the host can run the tool.">
                <div className="settings-tool-list" id="hidden-tools-input">
                    {TOOL_ROOMS.map((tool) => {
                        const hidden = d.draft.hiddenToolRooms.includes(tool.id);
                        return (
                            <label key={tool.id} className="settings-check">
                                <input type="checkbox" checked={hidden} aria-label={`Hide ${tool.name}`}
                                    onChange={() => d.set({
                                        hiddenToolRooms: hidden
                                            ? d.draft.hiddenToolRooms.filter((id) => id !== tool.id)
                                            : [...d.draft.hiddenToolRooms, tool.id]
                                    })} />
                                {tool.name}
                            </label>
                        );
                    })}
                </div>
            </Field>

            <Field id="exchange-server" label="Preferred Exchange server" scope="Your account"
                hint="Optional default among servers you can access. It never changes prices, balances, or trading rules.">
                <select id="exchange-server-input" className="input" value={d.draft.preferredExchangeGuild}
                    onChange={(e) => d.set({ preferredExchangeGuild: e.target.value })}>
                    <option value="">Ask each time</option>
                    {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
            </Field>

            <Field id="expedition-defaults" label="Defaults for new expeditions" scope="Your account"
                hint="Snapshotted into newly created personal expeditions. Existing seeds, intents, budgets, and runs stay unchanged.">
                <div className="settings-row" id="expedition-defaults-input">
                    <select className="input" aria-label="Expedition depth" value={d.draft.expeditionDefaultDepth}
                        onChange={(e) => d.set({ expeditionDefaultDepth: e.target.value as Draft['expeditionDefaultDepth'] })}>
                        <option value="focused">Focused</option>
                        <option value="standard">Standard</option>
                        <option value="deep">Deep</option>
                    </select>
                    <select className="input" aria-label="Expedition lens" value={d.draft.expeditionDefaultLens}
                        onChange={(e) => d.set({ expeditionDefaultLens: e.target.value })}>
                        {EXPEDITION_LENSES.map((lens) => <option key={lens.id} value={lens.id}>{lens.name}</option>)}
                    </select>
                </div>
            </Field>

            <Field id="parlor-defaults" label="Defaults for new personas" scope="Your account"
                hint="Applied when you create a persona without an emoji or charter. Existing and shared personas are never rewritten.">
                <div className="settings-stack" id="parlor-defaults-input">
                    <input className="input" value={d.draft.parlorDefaultEmoji} maxLength={8}
                        placeholder="Default emoji" aria-label="New persona emoji"
                        onChange={(e) => d.set({ parlorDefaultEmoji: e.target.value })} />
                    <textarea className="input" rows={3} value={d.draft.parlorDefaultCharter}
                        placeholder="Default charter for new personas" aria-label="New persona charter"
                        onChange={(e) => d.set({ parlorDefaultCharter: e.target.value })} />
                </div>
            </Field>

            <Field id="link-by-tag" label="Link notes by shared tag" inline scope="Your account"
                hint="On the Spitball map and graph, draw edges between notes that share a tag.">
                <button id="link-by-tag-input" type="button" className={`toggle${d.draft.linkByTag ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.linkByTag} aria-label="Link notes by shared tag"
                    onClick={() => d.set({ linkByTag: !d.draft.linkByTag })} />
            </Field>

            <Field id="conservatory" label="Music Lab library" scope="This device"
                hint="Music-engine parameters stay in the Music Lab editors. Settings can only point you there or clear this device's local library from Account.">
                <Link className="btn" to="/conservatory">Open Music Lab</Link>
            </Field>

            <SaveBar section="appearance" draft={{ ...d,
                save: async () => { const r = await d.save(); if (r) persistLocal(); return r; },
                discard: () => {
                    d.discard();
                    paintTheme(getStoredTheme());
                    paintAccent(getStoredAccent());
                    paintSurface(getStoredSurface());
                    paintNavLayout(getStoredNavLayout());
                },
                reset: async (rev) => {
                    const r = await d.reset(rev);
                    if (r) {
                        const values = r.data.values as Values;
                        setStoredTheme(values.theme);
                        if (isAccent(values.accent)) setStoredAccent(values.accent);
                        if (isSurface(values.surface)) setStoredSurface(values.surface);
                        if (values.navLayout === 'top' || values.navLayout === 'sidebar') persistNavLayout(values.navLayout);
                        localStorage.setItem(LINK_BY_TAG_KEY, values.linkByTag ? '1' : '0');
                        persistAppearance({
                            textSize: values.textSize,
                            density: values.density,
                            reducedMotion: values.reducedMotion
                        });
                    }
                    return r;
                }
            }} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
