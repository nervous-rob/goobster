import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../hooks/useToast';
import type { useVoiceChat, VoiceChatStatus } from '../hooks/useVoiceChat';

/**
 * Full-screen voice-chat surface (the ChatGPT/Gemini voice-mode pattern):
 * a level-reactive orb, live partial-transcript captions so the user can
 * see what is being heard, reply captions while Goobster speaks, and a
 * control row - mute, auto/press-to-send mode, send-now, voice + speed
 * settings, end. Tapping the orb (or anywhere on it) while Goobster is
 * speaking interrupts the reply and reopens the mic.
 */

type VoiceChatHandle = ReturnType<typeof useVoiceChat>;

const STATUS_LABELS: Record<VoiceChatStatus, string> = {
    idle: '',
    listening: 'Listening',
    transcribing: 'Got it — transcribing…',
    thinking: 'Goobster is thinking…',
    speaking: 'Goobster is speaking'
};

const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function VoiceChatOverlay({ voiceChat }: { voiceChat: VoiceChatHandle }) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [savingVoice, setSavingVoice] = useState(false);

    const settingsQ = useQuery({
        queryKey: ['voice-settings'],
        queryFn: () => api.voiceSettings(),
        staleTime: 60_000
    });
    const voicesQ = useQuery({
        queryKey: ['voice-list'],
        queryFn: () => api.voiceList(),
        enabled: settingsOpen,
        staleTime: 5 * 60_000,
        retry: false
    });

    // The saved playback speed applies to the session as soon as it's known
    const speed = settingsQ.data?.speed ?? 1;
    useEffect(() => {
        voiceChat.setPlaybackSpeed(speed);
    }, [speed, voiceChat]);

    // Esc ends the session
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') voiceChat.stop();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [voiceChat]);

    async function saveVoice(fields: { voiceId?: string | null; speed?: number }) {
        setSavingVoice(true);
        try {
            const saved = await api.saveVoiceSettings(fields);
            queryClient.setQueryData(['voice-settings'], saved);
            if (fields.speed !== undefined) voiceChat.setPlaybackSpeed(saved.speed);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setSavingVoice(false);
        }
    }

    const { status, level, partial, transcript, speakingText, talking, muted, mode, engine } = voiceChat;

    const hint = useMemo(() => {
        if (muted) return 'Microphone muted — tap the mic to unmute.';
        if (status === 'listening') {
            return mode === 'manual'
                ? 'Press-to-send: talk as long as you like, then hit Send.'
                : 'Speak, then pause — your words send automatically.';
        }
        if (status === 'speaking') return 'Tap the orb to interrupt.';
        return '';
    }, [status, mode, muted]);

    // What the caption bubble shows: the live partial while talking, the
    // committed transcript while the turn is running.
    const caption = partial
        || ((status === 'transcribing' || status === 'thinking') ? transcript : '');

    const orbScale = status === 'listening' && !muted ? 1 + Math.min(level, 1) * 0.3 : 1;

    return (
        <div className="voice-overlay" role="dialog" aria-label="Voice chat">
            <div className="voice-overlay-head">
                <div className="voice-overlay-title">
                    🎙 Voice chat
                    <span className="voice-engine-chip">
                        {engine === 'live' ? 'Live captions' : 'Standard'}
                    </span>
                </div>
                <button type="button" className="icon-action voice-overlay-close" title="End voice chat" onClick={voiceChat.stop}>✕</button>
            </div>

            <div className="voice-overlay-stage">
                <button
                    type="button"
                    className={`voice-orb ${status}${muted ? ' muted' : ''}${talking ? ' talking' : ''}`}
                    style={{ transform: `scale(${orbScale.toFixed(3)})` }}
                    onClick={() => { if (status === 'speaking') voiceChat.interrupt(); }}
                    aria-label={status === 'speaking' ? 'Interrupt Goobster' : STATUS_LABELS[status]}
                >
                    <span className="voice-orb-core" />
                </button>
                <div className="voice-overlay-status">
                    {muted && status === 'listening' ? 'Muted' : STATUS_LABELS[status]}
                </div>
                {hint && <div className="voice-overlay-hint">{hint}</div>}

                {caption ? (
                    <div className={`voice-caption user${partial ? ' partial' : ''}`}>
                        <span className="voice-caption-who">You</span>
                        {caption}
                    </div>
                ) : null}
                {status === 'speaking' && speakingText ? (
                    <div className="voice-caption bot">
                        <span className="voice-caption-who">Goobster</span>
                        {speakingText}
                    </div>
                ) : null}
            </div>

            {settingsOpen && (
                <div className="voice-settings-panel">
                    <div className="field">
                        <label htmlFor="voice-picker">Goobster's voice</label>
                        <select
                            id="voice-picker"
                            className="select"
                            disabled={savingVoice || voicesQ.isPending}
                            value={settingsQ.data?.voiceId || ''}
                            onChange={(e) => void saveVoice({ voiceId: e.target.value || null })}
                        >
                            <option value="">Server default</option>
                            {(voicesQ.data?.voices || []).map((voice) => (
                                <option key={voice.id} value={voice.id}>
                                    {voice.name}{voice.category ? ` · ${voice.category}` : ''}
                                </option>
                            ))}
                        </select>
                        {voicesQ.isError && <div className="hint">{(voicesQ.error as Error).message}</div>}
                    </div>
                    <div className="field">
                        <label>Playback speed</label>
                        <div className="segment voice-speed-segment">
                            {SPEED_STEPS.map((step) => (
                                <button
                                    key={step}
                                    type="button"
                                    className={`segment-btn${Math.abs(speed - step) < 0.01 ? ' active' : ''}`}
                                    disabled={savingVoice}
                                    onClick={() => void saveVoice({ speed: step })}
                                >{step}×</button>
                            ))}
                        </div>
                    </div>
                    <div className="hint">Your voice pick also applies to “Listen” read-alouds. Servers set their own voice with /setvoice.</div>
                </div>
            )}

            <div className="voice-overlay-controls">
                <button
                    type="button"
                    className={`voice-ctl${muted ? ' on' : ''}`}
                    title={muted ? 'Unmute microphone' : 'Mute microphone'}
                    aria-pressed={muted}
                    onClick={voiceChat.toggleMute}
                >{muted ? '🔇' : '🎙'}<span className="voice-ctl-label">{muted ? 'Unmute' : 'Mute'}</span></button>

                <button
                    type="button"
                    className={`voice-ctl${mode === 'manual' ? ' on' : ''}`}
                    title={mode === 'manual'
                        ? 'Press-to-send is on: you decide when each utterance sends'
                        : 'Auto-send is on: pausing sends your words'}
                    aria-pressed={mode === 'manual'}
                    onClick={() => voiceChat.setMode(mode === 'manual' ? 'auto' : 'manual')}
                >⏯<span className="voice-ctl-label">{mode === 'manual' ? 'Press to send' : 'Auto send'}</span></button>

                {mode === 'manual' && (
                    <button
                        type="button"
                        className="voice-ctl send"
                        title="Send what you've said"
                        disabled={status !== 'listening' || !talking}
                        onClick={voiceChat.sendNow}
                    >➤<span className="voice-ctl-label">Send</span></button>
                )}

                <button
                    type="button"
                    className={`voice-ctl${settingsOpen ? ' on' : ''}`}
                    title="Voice & speed settings"
                    aria-expanded={settingsOpen}
                    onClick={() => setSettingsOpen((open) => !open)}
                >⚙<span className="voice-ctl-label">Voice</span></button>

                <button
                    type="button"
                    className="voice-ctl end"
                    title="End voice chat"
                    onClick={voiceChat.stop}
                >◼<span className="voice-ctl-label">End</span></button>
            </div>
        </div>
    );
}
