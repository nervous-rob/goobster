import { useCallback } from 'react';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['profile']['values'];
type Draft = {
    callUser: string;
    accountPreferredName: string;
    callGoobster: string;
    customInstructions: string;
    personalityDirective: string;
    memeMode: boolean;
    answerLength: Values['answerLength'];
    tone: Values['tone'];
    humor: Values['humor'];
    responseLanguage: string;
    timezone: string;
    measurementSystem: Values['measurementSystem'];
    timeFormat: Values['timeFormat'];
    dateLocale: string;
};

const NAME_MAX = 32;
const TEXT_MAX = 2000;
const LANGUAGES: Array<{ value: string; label: string }> = [
    { value: '', label: 'Follow the conversation' },
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'it', label: 'Italian' },
    { value: 'pt', label: 'Portuguese' },
    { value: 'nl', label: 'Dutch' },
    { value: 'pl', label: 'Polish' },
    { value: 'ru', label: 'Russian' },
    { value: 'ja', label: 'Japanese' },
    { value: 'ko', label: 'Korean' },
    { value: 'zh', label: 'Chinese' }
];

const toDraft = (v: Values): Draft => ({
    callUser: v.callUser || '',
    accountPreferredName: v.accountPreferredName || '',
    callGoobster: v.callGoobster || '',
    customInstructions: v.customInstructions || '',
    personalityDirective: v.personalityDirective || '',
    memeMode: Boolean(v.memeMode),
    answerLength: v.answerLength || 'balanced',
    tone: v.tone || 'warm',
    humor: v.humor || 'light',
    responseLanguage: v.responseLanguage || '',
    timezone: v.timezone || '',
    measurementSystem: v.measurementSystem || 'follow-locale',
    timeFormat: v.timeFormat || 'follow-locale',
    dateLocale: v.dateLocale || ''
});

const LABELS: Record<string, string> = {
    callUser: 'What Goobster calls you in private chats',
    accountPreferredName: 'Account-wide preferred name',
    callGoobster: 'What you call Goobster',
    customInstructions: 'Custom instructions',
    personalityDirective: 'Personality directive',
    memeMode: 'Meme mode',
    answerLength: 'Default answer length',
    tone: 'Default tone',
    humor: 'Humor and emoji',
    responseLanguage: 'Preferred response language',
    timezone: 'Timezone',
    measurementSystem: 'Units',
    timeFormat: 'Clock',
    dateLocale: 'Date locale'
};

const TIMEZONES = (() => {
    try {
        return (Intl.supportedValuesOf?.('timeZone') || ['UTC']).slice();
    } catch {
        return ['UTC'];
    }
})();

export function ProfileSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['profile'];
    onDirty: (dirty: boolean) => void;
}) {
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        for (const key of ['callUser', 'accountPreferredName', 'callGoobster', 'customInstructions', 'personalityDirective', 'timezone', 'dateLocale', 'responseLanguage']) {
            if (key in diff) diff[key] = String(diff[key]).trim() || null;
        }
        return diff;
    }, []);
    const d = useSectionDraft('profile', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    const effective = section.effective as Record<string, string | null>;
    const nameError = d.draft.callUser.length > NAME_MAX || d.draft.callGoobster.length > NAME_MAX
        || d.draft.accountPreferredName.length > NAME_MAX
        ? `Names are at most ${NAME_MAX} characters.` : null;

    return (
        <section className="settings-section" aria-labelledby="settings-profile-title">
            <SectionHeader id="profile" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="preferred-name" label="What Goobster calls you" scope="Private chats & DMs"
                hint={<>Used in the Study and your DMs. Currently <strong>{effective.callUser}</strong>{!section.values.callUser && ' (from account fallback or Discord)'}. Servers keep their own nickname via <code>/nickname</code>.</>}
                error={d.draft.callUser.length > NAME_MAX ? nameError : null}>
                <input id="preferred-name-input" className="input" maxLength={NAME_MAX + 8} value={d.draft.callUser}
                    placeholder={effective.callUser || 'Your Discord name'}
                    onChange={(e) => d.set({ callUser: e.target.value })} />
            </Field>

            <Field id="account-name" label="Account-wide preferred name" scope="Your account"
                hint="Used when a chat or server has no explicit nickname. Does not rename your Discord account."
                error={d.draft.accountPreferredName.length > NAME_MAX ? nameError : null}>
                <input id="account-name-input" className="input" maxLength={NAME_MAX + 8} value={d.draft.accountPreferredName}
                    placeholder="Optional fallback"
                    onChange={(e) => d.set({ accountPreferredName: e.target.value })} />
            </Field>

            <Field id="bot-name" label="What you call Goobster" scope="Private chats & DMs"
                hint={<>A private alias for him in your DMs and the Study. Currently <strong>{effective.callGoobster}</strong>.</>}
                error={d.draft.callGoobster.length > NAME_MAX ? nameError : null}>
                <input id="bot-name-input" className="input" maxLength={NAME_MAX + 8} value={d.draft.callGoobster}
                    placeholder="Goobster"
                    onChange={(e) => d.set({ callGoobster: e.target.value })} />
            </Field>

            <Field id="custom-instructions" label="Custom instructions" scope="Your account"
                hint="Standing guidance for how he should respond to you — tone, format, things to always keep in mind. Applies in the Study and DMs; servers may add their own directives."
                error={d.draft.customInstructions.length > TEXT_MAX ? `At most ${TEXT_MAX} characters.` : null}>
                <textarea id="custom-instructions-input" className="input" rows={4} maxLength={TEXT_MAX + 50}
                    value={d.draft.customInstructions}
                    placeholder="e.g. Keep answers short. I write Python. Call out when you're unsure."
                    onChange={(e) => d.set({ customInstructions: e.target.value })} />
                <div className="hint settings-counter">{d.draft.customInstructions.length}/{TEXT_MAX}</div>
            </Field>

            <Field id="personality-directive" label="Personality directive" scope="Private chats & DMs"
                hint="A private character note for your conversations only — who he is when it's just you two. Server owners set a separate directive for their server."
                error={d.draft.personalityDirective.length > TEXT_MAX ? `At most ${TEXT_MAX} characters.` : null}>
                <textarea id="personality-directive-input" className="input" rows={3} maxLength={TEXT_MAX + 50}
                    value={d.draft.personalityDirective}
                    placeholder="e.g. Dry wit, warm underneath. Never uses exclamation marks."
                    onChange={(e) => d.set({ personalityDirective: e.target.value })} />
            </Field>

            <Field id="meme-mode" label="Meme mode" inline scope="Your account"
                hint="Lets him lean into internet humour and references. When this is on, it wins over the structured humor preference below.">
                <button id="meme-mode-input" type="button" className={`toggle${d.draft.memeMode ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.memeMode} aria-label="Meme mode"
                    onClick={() => d.set({ memeMode: !d.draft.memeMode })} />
            </Field>

            <Field id="answer-length" label="Default answer length" scope="Your account"
                hint="A soft preference, not a token budget. An explicit request in the current turn wins.">
                <select id="answer-length-input" className="input" value={d.draft.answerLength}
                    onChange={(e) => d.set({ answerLength: e.target.value as Draft['answerLength'] })}>
                    <option value="concise">Concise</option>
                    <option value="balanced">Balanced</option>
                    <option value="detailed">Detailed</option>
                </select>
            </Field>

            <Field id="tone" label="Default tone" scope="Your account"
                hint="Structured tone for regular chat. Custom instructions still win if they conflict.">
                <select id="tone-input" className="input" value={d.draft.tone}
                    onChange={(e) => d.set({ tone: e.target.value as Draft['tone'] })}>
                    <option value="neutral">Neutral</option>
                    <option value="warm">Warm</option>
                    <option value="direct">Direct</option>
                    <option value="playful">Playful</option>
                </select>
            </Field>

            <Field id="humor" label="Humor and emoji" scope="Your account"
                hint={d.draft.memeMode
                    ? 'Meme mode is on, so it currently wins over this control.'
                    : 'Optional structured preference. Meme mode, if enabled, wins.'}>
                <select id="humor-input" className="input" value={d.draft.humor}
                    onChange={(e) => d.set({ humor: e.target.value as Draft['humor'] })}>
                    <option value="off">Rare</option>
                    <option value="light">Light</option>
                    <option value="playful">Playful</option>
                </select>
            </Field>

            <Field id="language" label="Preferred response language" scope="Your account"
                hint="Default for new replies. This is not the speech-recognition language.">
                <select id="language-input" className="input" value={d.draft.responseLanguage}
                    onChange={(e) => d.set({ responseLanguage: e.target.value })}>
                    {LANGUAGES.map((lang) => <option key={lang.value || 'follow'} value={lang.value}>{lang.label}</option>)}
                </select>
            </Field>

            <Field id="timezone" label="Timezone" scope="Your account"
                hint="IANA zone for display and scheduling. Adding a timezone does not silently reinterpret existing UTC quiet hours — convert those in Initiative.">
                <select id="timezone-input" className="input" value={d.draft.timezone}
                    onChange={(e) => d.set({ timezone: e.target.value })}>
                    <option value="">Not set</option>
                    {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
            </Field>

            <Field id="units" label="Units and clock" scope="Your account"
                hint="How times and measurements should be written. Persisted timestamps stay in UTC.">
                <div className="settings-row">
                    <select id="units-input" className="input" value={d.draft.measurementSystem} aria-label="Units"
                        onChange={(e) => d.set({ measurementSystem: e.target.value as Draft['measurementSystem'] })}>
                        <option value="follow-locale">Units: follow locale</option>
                        <option value="metric">Metric</option>
                        <option value="imperial">Imperial</option>
                    </select>
                    <select className="input" value={d.draft.timeFormat} aria-label="Clock"
                        onChange={(e) => d.set({ timeFormat: e.target.value as Draft['timeFormat'] })}>
                        <option value="follow-locale">Clock: follow locale</option>
                        <option value="12">12-hour</option>
                        <option value="24">24-hour</option>
                    </select>
                    <input className="input" value={d.draft.dateLocale} placeholder="Date locale (optional, e.g. en-GB)"
                        aria-label="Date locale"
                        onChange={(e) => d.set({ dateLocale: e.target.value })} />
                </div>
            </Field>

            <SaveBar section="profile" draft={d} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
