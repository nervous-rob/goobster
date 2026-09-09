import { useCallback } from 'react';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['profile']['values'];
type Draft = {
    callUser: string;
    callGoobster: string;
    customInstructions: string;
    personalityDirective: string;
    memeMode: boolean;
};

const NAME_MAX = 32;
const TEXT_MAX = 2000;

const toDraft = (v: Values): Draft => ({
    callUser: v.callUser || '',
    callGoobster: v.callGoobster || '',
    customInstructions: v.customInstructions || '',
    personalityDirective: v.personalityDirective || '',
    memeMode: Boolean(v.memeMode)
});

const LABELS: Record<string, string> = {
    callUser: 'What Goobster calls you',
    callGoobster: 'What you call Goobster',
    customInstructions: 'Custom instructions',
    personalityDirective: 'Personality directive',
    memeMode: 'Meme mode'
};

export function ProfileSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['profile'];
    onDirty: (dirty: boolean) => void;
}) {
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        for (const key of ['callUser', 'callGoobster', 'customInstructions', 'personalityDirective']) {
            if (key in diff) diff[key] = String(diff[key]).trim() || null;
        }
        return diff;
    }, []);
    const d = useSectionDraft('profile', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    const effective = section.effective as Record<string, string | null>;
    const nameError = d.draft.callUser.length > NAME_MAX || d.draft.callGoobster.length > NAME_MAX
        ? `Names are at most ${NAME_MAX} characters.` : null;

    return (
        <section className="settings-section" aria-labelledby="settings-profile-title">
            <SectionHeader id="profile" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="preferred-name" label="What Goobster calls you"
                hint={<>Used in the Study and your DMs. Currently <strong>{effective.callUser}</strong>{!section.values.callUser && ' (from your Discord account)'}. Servers keep their own nickname via <code>/nickname</code>.</>}
                error={d.draft.callUser.length > NAME_MAX ? nameError : null}>
                <input id="preferred-name-input" className="input" maxLength={NAME_MAX + 8} value={d.draft.callUser}
                    placeholder={effective.callUser || 'Your Discord name'}
                    onChange={(e) => d.set({ callUser: e.target.value })} />
            </Field>

            <Field id="bot-name" label="What you call Goobster"
                hint={<>A private alias for him in your DMs and the Study. Currently <strong>{effective.callGoobster}</strong>.</>}
                error={d.draft.callGoobster.length > NAME_MAX ? nameError : null}>
                <input id="bot-name-input" className="input" maxLength={NAME_MAX + 8} value={d.draft.callGoobster}
                    placeholder="Goobster"
                    onChange={(e) => d.set({ callGoobster: e.target.value })} />
            </Field>

            <Field id="custom-instructions" label="Custom instructions"
                hint="Standing guidance for how he should respond to you — tone, format, things to always keep in mind. Applies in the Study and DMs; servers may add their own directives."
                error={d.draft.customInstructions.length > TEXT_MAX ? `At most ${TEXT_MAX} characters.` : null}>
                <textarea id="custom-instructions-input" className="input" rows={4} maxLength={TEXT_MAX + 50}
                    value={d.draft.customInstructions}
                    placeholder="e.g. Keep answers short. I write Python. Call out when you're unsure."
                    onChange={(e) => d.set({ customInstructions: e.target.value })} />
                <div className="hint settings-counter">{d.draft.customInstructions.length}/{TEXT_MAX}</div>
            </Field>

            <Field id="personality-directive" label="Personality directive"
                hint="A private character note for your conversations only — who he is when it's just you two. Server owners set a separate directive for their server."
                error={d.draft.personalityDirective.length > TEXT_MAX ? `At most ${TEXT_MAX} characters.` : null}>
                <textarea id="personality-directive-input" className="input" rows={3} maxLength={TEXT_MAX + 50}
                    value={d.draft.personalityDirective}
                    placeholder="e.g. Dry wit, warm underneath. Never uses exclamation marks."
                    onChange={(e) => d.set({ personalityDirective: e.target.value })} />
            </Field>

            <Field id="meme-mode" label="Meme mode" inline
                hint="Lets him lean into internet humour and references when he talks to you.">
                <button id="meme-mode-input" type="button" className={`toggle${d.draft.memeMode ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.memeMode} aria-label="Meme mode"
                    onClick={() => d.set({ memeMode: !d.draft.memeMode })} />
            </Field>

            <SaveBar section="profile" draft={d} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
