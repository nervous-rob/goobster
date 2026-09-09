import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useOpenSettings } from '../hooks/useOpenSettings';
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
    const openSettings = useOpenSettings();
    const [settingsOpen, setSettingsOpen] = useState(false);

    const settingsQ = useQuery({
        queryKey: ['voice-settings'],
        queryFn: () => api.voiceSettings(),
        staleTime: 60_000
    });
    // The saved playback speed seeds the session; the panel can nudge it for
    // this call only. Changing the saved default lives in Settings → Voice.
    const savedSpeed = settingsQ.data?.speed ?? 1;
    const [sessionOverride, setSessionOverride] = useState<number | null>(null);
    const sessionSpeed = sessionOverride ?? savedSpeed;
    const setSessionSpeed = (value: number) => setSessionOverride(value);
    useEffect(() => {
        voiceChat.setPlaybackSpeed(sessionSpeed);
    }, [sessionSpeed, voiceChat]);

    // Esc ends the session
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') voiceChat.stop();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [voiceChat]);

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
                        <label>Playback speed for this call</label>
                        <div className="segment voice-speed-segment">
                            {SPEED_STEPS.map((step) => (
                                <button
                                    key={step}
                                    type="button"
                                    className={`segment-btn${Math.abs(sessionSpeed - step) < 0.01 ? ' active' : ''}`}
                                    onClick={() => setSessionSpeed(step)}
                                >{step}×</button>
                            ))}
                        </div>
                        <div className="hint">Applies to this call only. Your saved default is {savedSpeed}×.</div>
                    </div>
                    <div className="field">
                        <div className="hint">
                            Speaking as <strong>{settingsQ.data?.voiceName || 'the host default voice'}</strong>
                            {settingsQ.data?.accentLabel ? ` with a ${settingsQ.data.accentLabel} accent` : ''}.
                        </div>
                        <button type="button" className="btn" onClick={() => { voiceChat.stop(); openSettings('voice', 'voice-pick'); }}>
                            Change voice, accent &amp; default speed in Settings → (ends this call)
                        </button>
                    </div>
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
