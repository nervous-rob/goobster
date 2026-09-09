import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, fetchSpeech } from '../../lib/api';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { useToast } from '../../hooks/useToast';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['voice']['values'];
type Draft = { voiceId: string; speed: number; accent: string };

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const LABELS: Record<string, string> = { voiceId: 'Speaking voice', speed: 'Playback speed', accent: 'Spoken accent' };

const toDraft = (v: Values): Draft => ({
    voiceId: v.voiceId || '',
    speed: Number(v.speed) || 1,
    accent: v.accent || ''
});

export function VoiceSection({ section, capabilities, onDirty }: {
    section: UserSettingsResponse['sections']['voice'];
    capabilities: UserSettingsResponse['capabilities'];
    onDirty: (dirty: boolean) => void;
}) {
    const toast = useToast();
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        if ('voiceId' in diff) diff.voiceId = draft.voiceId || null;
        if ('accent' in diff) diff.accent = draft.accent || null;
        return diff;
    }, []);
    const d = useSectionDraft('voice', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    const ttsAvailable = Boolean(capabilities?.tts);
    const voicesQ = useQuery({
        queryKey: ['voices'],
        queryFn: () => api.voiceList(),
        enabled: ttsAvailable,
        staleTime: 10 * 60_000
    });
    const voices = voicesQ.data?.voices || [];
    const effective = section.effective;
    const accents = section.accents || [];

    // Voice preview is an explicit action, never a side effect of changing
    // the dropdown. It plays the draft voice without saving anything.
    const [previewing, setPreviewing] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    useEffect(() => () => { audioRef.current?.pause(); }, []);
    async function preview() {
        if (previewing) {
            audioRef.current?.pause();
            setPreviewing(false);
            return;
        }
        setPreviewing(true);
        try {
            const blob = await fetchSpeech('Hi, this is how I sound. Change the voice or speed and preview again.', null, { voiceId: d.draft.voiceId || null });
            const audio = new Audio(URL.createObjectURL(blob));
            audio.playbackRate = d.draft.speed;
            audioRef.current = audio;
            audio.onended = () => setPreviewing(false);
            audio.onerror = () => setPreviewing(false);
            await audio.play();
        } catch (error) {
            setPreviewing(false);
            toast((error as Error).message, true);
        }
    }

    const savedVoiceMissing = d.draft.voiceId && voices.length > 0 && !voices.some((v) => v.id === d.draft.voiceId);

    return (
        <section className="settings-section" aria-labelledby="settings-voice-title">
            <SectionHeader id="voice" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            {!ttsAvailable && (
                <div className="settings-banner muted" role="status">
                    Speech isn't available on this host (no ElevenLabs key), so the voice picker is read-only. Your saved choice is kept and playback speed still applies to anything that can play.
                </div>
            )}

            <div className="settings-effective">
                Speaking as <strong>{effective.voiceName || 'the host default voice'}</strong>
                {effective.accentLabel ? <> with a {effective.accentLabel} accent</> : null}
                {' '}at {effective.speed}× speed.
            </div>

            <Field id="voice-pick" label="Speaking voice"
                hint="Used for Study voice chat and “Listen” read-alouds in your private conversations. Servers pick theirs with /setvoice."
                error={voicesQ.isError ? `Voice library unavailable (${(voicesQ.error as Error).message}). Your saved voice is kept; speed and accent can still be saved.` : null}>
                <div className="settings-inline-row">
                    <select id="voice-pick-input" className="select" value={d.draft.voiceId} disabled={!ttsAvailable}
                        onChange={(e) => d.set({ voiceId: e.target.value })}>
                        <option value="">Host default voice</option>
                        {savedVoiceMissing && <option value={d.draft.voiceId}>{section.values.voiceName || d.draft.voiceId} (saved; not in library)</option>}
                        {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.category ? ` · ${v.category}` : ''}</option>)}
                    </select>
                    <button type="button" className="btn" disabled={!ttsAvailable} onClick={preview} aria-pressed={previewing}>
                        {previewing ? '■ Stop' : '▶ Preview'}
                    </button>
                </div>
            </Field>

            <Field id="voice-accent" label="Spoken accent"
                hint="Adds an ElevenLabs v3 audio tag to read-alouds. Live Discord voice (Flash) ignores it.">
                <select id="voice-accent-input" className="select" value={d.draft.accent}
                    onChange={(e) => d.set({ accent: e.target.value })}>
                    <option value="">No accent tag</option>
                    {accents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
            </Field>

            <Field id="voice-speed" label="Playback speed"
                hint="Applies to the next thing he says; already-playing audio keeps its speed.">
                <div className="segment settings-segment" role="radiogroup" aria-label="Playback speed" id="voice-speed-input">
                    {SPEEDS.map((s) => (
                        <button key={s} type="button" role="radio" aria-checked={d.draft.speed === s}
                            className={`segment-btn${d.draft.speed === s ? ' active' : ''}`}
                            onClick={() => d.set({ speed: s })}>{s}×</button>
                    ))}
                </div>
            </Field>

            <SaveBar section="voice" draft={d} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
