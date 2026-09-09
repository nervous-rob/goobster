import { useCallback, useEffect } from 'react';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { getStoredTheme, paintTheme, setStoredTheme, type ThemeChoice } from '../../lib/theme';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['appearance']['values'];
type Draft = { theme: ThemeChoice; linkByTag: boolean };

const THEMES: Array<{ value: ThemeChoice; label: string; hint: string }> = [
    { value: 'dark', label: '🌙 Dark', hint: 'The default.' },
    { value: 'light', label: '☀️ Light', hint: 'Bright surfaces.' },
    { value: 'system', label: '🖥️ System', hint: 'Follow this device\'s setting.' }
];

const LABELS: Record<string, string> = { theme: 'Theme', linkByTag: 'Link notes by shared tag' };
const LINK_BY_TAG_KEY = 'goobster.map.linkByTag';

export function AppearanceSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['appearance'];
    onDirty: (dirty: boolean) => void;
}) {
    // The device is authoritative for what you see right now; the account
    // copy is what a fresh device starts from. Draft edits paint immediately
    // (previewable), Discard repaints the saved value, Save writes both.
    const toDraft = useCallback((v: Values): Draft => ({
        theme: getStoredTheme() || v.theme,
        linkByTag: localStorage.getItem(LINK_BY_TAG_KEY) === null ? Boolean(v.linkByTag) : localStorage.getItem(LINK_BY_TAG_KEY) !== '0'
    }), []);
    const toChanges = useCallback((draft: Draft, baseline: Draft) =>
        diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>), []);
    const d = useSectionDraft('appearance', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    useEffect(() => { paintTheme(d.draft.theme); }, [d.draft.theme]);
    // Leaving the section with an unsaved preview restores the saved theme.
    useEffect(() => () => { paintTheme(getStoredTheme()); }, []);

    function persistLocal() {
        setStoredTheme(d.draft.theme);
        localStorage.setItem(LINK_BY_TAG_KEY, d.draft.linkByTag ? '1' : '0');
    }

    return (
        <section className="settings-section" aria-labelledby="settings-appearance-title">
            <SectionHeader id="appearance" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="theme" label="Theme" hint="Previews as you pick. Save keeps it for this device and remembers it on your account for new devices.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Theme" id="theme-input">
                    {THEMES.map((t) => (
                        <button key={t.value} type="button" role="radio" aria-checked={d.draft.theme === t.value}
                            title={t.hint}
                            className={`segment-btn${d.draft.theme === t.value ? ' active' : ''}`}
                            onClick={() => d.set({ theme: t.value })}>{t.label}</button>
                    ))}
                </div>
            </Field>

            <Field id="link-by-tag" label="Link notes by shared tag" inline
                hint="On the Spitball map and graph, draw edges between notes that share a tag.">
                <button id="link-by-tag-input" type="button" className={`toggle${d.draft.linkByTag ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.linkByTag} aria-label="Link notes by shared tag"
                    onClick={() => d.set({ linkByTag: !d.draft.linkByTag })} />
            </Field>

            <SaveBar section="appearance" draft={{ ...d,
                save: async () => { const r = await d.save(); if (r) persistLocal(); return r; },
                discard: () => { d.discard(); paintTheme(getStoredTheme()); },
                reset: async (rev) => { const r = await d.reset(rev); if (r) { setStoredTheme((r.data.values as Values).theme); localStorage.setItem(LINK_BY_TAG_KEY, (r.data.values as Values).linkByTag ? '1' : '0'); } return r; }
            }} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
