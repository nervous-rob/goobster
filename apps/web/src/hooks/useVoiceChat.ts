import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchSpeech } from '../lib/api';
import { VoiceLiveSession, type VoiceSendMode } from '../lib/voiceLiveSession';

/**
 * Hands-free voice-chat session for the Study chat.
 *
 * Two capture engines behind one interface:
 *  - live:  mic worklet -> 16kHz PCM over WebSocket -> ElevenLabs Scribe
 *           realtime (streaming partial transcripts) - used when the server
 *           reports capabilities.live.
 *  - batch: MediaRecorder + local VAD -> POST /api/app/voice/transcribe
 *           (no partials) - the fallback when only batch STT is configured.
 *
 * Either way the loop is: listening → transcribing → thinking → speaking →
 * listening. The microphone only feeds STT while `listening`, so the bot
 * never hears its own reply. Extras: mute, auto/press-to-send modes, live
 * partial captions, mic level for the visualizer, playback speed, and
 * tap-to-interrupt while the reply is being spoken.
 */

export type VoiceChatStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
export type { VoiceSendMode };

type VoiceChatOptions = {
    /** Called with the recognized text; the caller sends it as a chat message. */
    onUtterance: (text: string) => void;
    onNotify?: (message: string, isError?: boolean) => void;
};

// Batch-engine voice-activity detection (RMS of Web Audio float samples).
const BASE_SPEECH_THRESHOLD = 0.012;
const NOISE_FLOOR_MULTIPLIER = 2.5;
const SILENCE_HANGOVER_MS = 1300;
const MIN_SPEECH_MS = 250;
const MAX_UTTERANCE_MS = 90_000;
const IDLE_RESTART_MS = 15_000;
const MONITOR_INTERVAL_MS = 60;
// Float RMS that maps to a "full" level meter
const LEVEL_FULL_RMS = 0.14;

// A moment of silence used to "unlock" the reply audio element inside the
// mic-tap gesture: mobile Safari only lets an element play() programmatically
// later if it already played during a user gesture.
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma === -1 ? result : result.slice(comma + 1));
        };
        reader.onerror = () => reject(new Error('Could not read the recording.'));
        reader.readAsDataURL(blob);
    });
}

export function useVoiceChat({ onUtterance, onNotify }: VoiceChatOptions) {
    const [status, setStatus] = useState<VoiceChatStatus>('idle');
    const statusRef = useRef<VoiceChatStatus>('idle');
    const [engine, setEngine] = useState<'live' | 'batch' | null>(null);
    const [partial, setPartial] = useState('');
    const [transcript, setTranscript] = useState('');
    const [speakingText, setSpeakingText] = useState('');
    const [level, setLevel] = useState(0);
    const [talking, setTalking] = useState(false);
    const [muted, setMutedState] = useState(false);
    const [mode, setModeState] = useState<VoiceSendMode>('auto');

    // Bumped on every start/stop so in-flight async work from a previous
    // session can tell it has been superseded and bail out.
    const generationRef = useRef(0);
    const mutedRef = useRef(false);
    const modeRef = useRef<VoiceSendMode>('auto');
    const speedRef = useRef(1);

    // Live engine
    const liveRef = useRef<VoiceLiveSession | null>(null);
    // Batch engine
    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const monitorRef = useRef<number | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<BlobPart[]>([]);
    const vadRef = useRef({ speechStartedAt: 0, lastVoiceAt: 0, recorderStartedAt: 0, noiseFloor: BASE_SPEECH_THRESHOLD });
    // Reply playback: ONE shared element per session, created and "unlocked"
    // inside the mic-tap gesture so mobile Safari lets replies play later.
    const playbackElRef = useRef<HTMLAudioElement | null>(null);
    const playbackRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
    // Keep the phone's screen awake while a session runs (a locked screen
    // kills microphone capture); best-effort, absent on older browsers.
    const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

    const onUtteranceRef = useRef(onUtterance);
    onUtteranceRef.current = onUtterance;
    const onNotifyRef = useRef(onNotify);
    onNotifyRef.current = onNotify;

    const setStatusBoth = useCallback((next: VoiceChatStatus) => {
        statusRef.current = next;
        setStatus(next);
        // The live engine only feeds STT while listening
        liveRef.current?.setPaused(next !== 'listening');
        if (next !== 'listening') setLevel(0);
    }, []);

    const stopPlayback = useCallback(() => {
        const playback = playbackRef.current;
        if (!playback) return;
        playbackRef.current = null;
        try { playback.audio.pause(); } catch { /* already stopped */ }
        playback.audio.onended = null;
        playback.audio.onerror = null;
        URL.revokeObjectURL(playback.url);
        setSpeakingText('');
    }, []);

    const releaseWakeLock = useCallback(() => {
        const lock = wakeLockRef.current;
        wakeLockRef.current = null;
        if (lock) void lock.release().catch(() => undefined);
    }, []);

    const acquireWakeLock = useCallback(async () => {
        const wakeLock = (navigator as Navigator & {
            wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
        }).wakeLock;
        if (!wakeLock) return;
        try {
            releaseWakeLock();
            wakeLockRef.current = await wakeLock.request('screen');
        } catch { /* denied (low battery, background) - the session still works */ }
    }, [releaseWakeLock]);

    const stopRecorder = useCallback(() => {
        const recorder = recorderRef.current;
        recorderRef.current = null;
        chunksRef.current = [];
        if (recorder && recorder.state !== 'inactive') {
            recorder.onstop = null;
            try { recorder.stop(); } catch { /* already stopped */ }
        }
    }, []);

    const stop = useCallback(() => {
        generationRef.current += 1;
        releaseWakeLock();
        liveRef.current?.stop();
        liveRef.current = null;
        if (monitorRef.current !== null) {
            window.clearInterval(monitorRef.current);
            monitorRef.current = null;
        }
        stopRecorder();
        stopPlayback();
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        analyserRef.current = null;
        const ctx = audioContextRef.current;
        audioContextRef.current = null;
        if (ctx) void ctx.close().catch(() => undefined);
        setEngine(null);
        setPartial('');
        setTranscript('');
        setSpeakingText('');
        setTalking(false);
        setLevel(0);
        setMutedState(false);
        mutedRef.current = false;
        setStatusBoth('idle');
    }, [stopRecorder, stopPlayback, setStatusBoth, releaseWakeLock]);

    useEffect(() => () => stop(), [stop]);

    /* ---------- batch engine (MediaRecorder + local VAD) ---------- */

    const beginRecorderSegment = useCallback(() => {
        const stream = streamRef.current;
        if (!stream) return;
        stopRecorder();
        const recorder = new MediaRecorder(stream);
        const chunks: BlobPart[] = [];
        recorder.addEventListener('dataavailable', (event) => {
            if (event.data?.size > 0) chunks.push(event.data);
        });
        recorder.start(250);
        recorderRef.current = recorder;
        chunksRef.current = chunks;
        vadRef.current.speechStartedAt = 0;
        vadRef.current.lastVoiceAt = 0;
        vadRef.current.recorderStartedAt = Date.now();
        setTalking(false);
    }, [stopRecorder]);

    const startListening = useCallback(() => {
        if (liveRef.current) {
            setStatusBoth('listening');
            return;
        }
        if (!streamRef.current) return;
        setStatusBoth('listening');
        beginRecorderSegment();
    }, [beginRecorderSegment, setStatusBoth]);

    /** Resume listening after a turn that produced nothing to speak. */
    const resume = useCallback(() => {
        if (statusRef.current === 'idle' || statusRef.current === 'listening' || statusRef.current === 'speaking') return;
        startListening();
    }, [startListening]);

    const finalizeUtterance = useCallback((generation: number) => {
        const recorder = recorderRef.current;
        if (!recorder) return;
        setStatusBoth('transcribing');
        setTalking(false);
        recorderRef.current = null;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const mimeType = recorder.mimeType || 'audio/webm';
        recorder.onstop = async () => {
            if (generation !== generationRef.current) return;
            try {
                const blob = new Blob(chunks, { type: mimeType });
                const audio = await blobToBase64(blob);
                if (generation !== generationRef.current) return;
                const { text } = await api.transcribe(audio, mimeType);
                if (generation !== generationRef.current) return;
                const trimmed = (text || '').trim();
                if (!trimmed) {
                    startListening();
                    return;
                }
                setTranscript(trimmed);
                setStatusBoth('thinking');
                onUtteranceRef.current(trimmed);
            } catch (error) {
                if (generation !== generationRef.current) return;
                onNotifyRef.current?.((error as Error).message || 'Transcription failed.', true);
                startListening();
            }
        };
        try { recorder.stop(); } catch { /* already stopped */ }
    }, [setStatusBoth, startListening]);

    const monitorTick = useCallback((generation: number) => {
        if (generation !== generationRef.current) return;
        if (statusRef.current !== 'listening') return;
        const analyser = analyserRef.current;
        if (!analyser) return;
        if (mutedRef.current) {
            setLevel(0);
            return;
        }
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        setLevel(Math.min(1, rms / LEVEL_FULL_RMS));

        const vad = vadRef.current;
        // Track the ambient noise floor: sink quickly toward quiet readings,
        // rise only slowly, so a threshold above it survives noisy rooms.
        vad.noiseFloor = rms < vad.noiseFloor
            ? vad.noiseFloor * 0.9 + rms * 0.1
            : Math.min(vad.noiseFloor * 1.005, BASE_SPEECH_THRESHOLD * 4);
        const threshold = Math.max(BASE_SPEECH_THRESHOLD, vad.noiseFloor * NOISE_FLOOR_MULTIPLIER);

        const now = Date.now();
        if (rms >= threshold) {
            vad.lastVoiceAt = now;
            if (!vad.speechStartedAt) {
                vad.speechStartedAt = now;
                setTalking(true);
            }
        }
        if (vad.speechStartedAt) {
            if (now - vad.speechStartedAt >= MAX_UTTERANCE_MS) {
                finalizeUtterance(generation);
                return;
            }
            if (modeRef.current === 'manual') return; // press-to-send decides
            const silenceMs = now - vad.lastVoiceAt;
            const speechMs = vad.lastVoiceAt - vad.speechStartedAt;
            if (silenceMs >= SILENCE_HANGOVER_MS) {
                if (speechMs >= MIN_SPEECH_MS) finalizeUtterance(generation);
                else beginRecorderSegment(); // a blip, not speech
            }
        } else if (modeRef.current === 'auto' && now - vad.recorderStartedAt >= IDLE_RESTART_MS) {
            beginRecorderSegment();
        }
    }, [finalizeUtterance, beginRecorderSegment]);

    const startBatch = useCallback(async (generation: number) => {
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true }
            });
        } catch {
            onNotifyRef.current?.('Microphone access was denied.', true);
            return false;
        }
        if (generation !== generationRef.current) {
            // Superseded while the permission prompt was open
            stream.getTracks().forEach((track) => track.stop());
            return false;
        }
        streamRef.current = stream;
        const AudioContextCtor = window.AudioContext
            || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextCtor) {
            const ctx = new AudioContextCtor();
            // iOS starts contexts suspended even inside a gesture chain
            if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            audioContextRef.current = ctx;
            analyserRef.current = analyser;
        }
        vadRef.current.noiseFloor = BASE_SPEECH_THRESHOLD;
        return true;
    }, []);

    /* ---------- live engine (worklet + WebSocket + Scribe realtime) ---------- */

    const startLive = useCallback(async (generation: number) => {
        const session = new VoiceLiveSession();
        try {
            await session.start({
                onPartial: (text) => {
                    if (generation !== generationRef.current) return;
                    setPartial(text);
                },
                onUtterance: (text) => {
                    if (generation !== generationRef.current) return;
                    setPartial('');
                    setTranscript(text);
                    setStatusBoth('thinking');
                    onUtteranceRef.current(text);
                },
                onUtteranceEmpty: () => {
                    if (generation !== generationRef.current) return;
                    setPartial('');
                    if (statusRef.current === 'transcribing') startListening();
                },
                onCommit: () => {
                    if (generation !== generationRef.current) return;
                    if (statusRef.current === 'listening') setStatusBoth('transcribing');
                },
                onTalking: (isTalking) => {
                    if (generation !== generationRef.current) return;
                    setTalking(isTalking);
                    if (!isTalking) setPartial('');
                },
                onLevel: (value) => {
                    if (generation !== generationRef.current) return;
                    setLevel(value);
                },
                onError: (message) => {
                    if (generation !== generationRef.current) return;
                    onNotifyRef.current?.(message, true);
                },
                onClosed: () => {
                    if (generation !== generationRef.current) return;
                    onNotifyRef.current?.('The live transcription connection closed.', true);
                    stop();
                }
            }, { mode: modeRef.current });
        } catch (error) {
            try { session.stop(); } catch { /* already gone */ }
            const message = (error as Error).message || '';
            if (/microphone|denied|permission/i.test(message)) {
                onNotifyRef.current?.('Microphone access was denied.', true);
            } else {
                onNotifyRef.current?.(message || 'Could not start live transcription.', true);
            }
            return false;
        }
        liveRef.current = session;
        return true;
    }, [setStatusBoth, startListening, stop]);

    /* ---------- shared session controls ---------- */

    const start = useCallback(async ({ live = false } = {}) => {
        if (statusRef.current !== 'idle') return;
        if (!navigator.mediaDevices?.getUserMedia) {
            onNotifyRef.current?.('This browser does not support microphone recording.', true);
            return;
        }
        // Unlock the reply audio element NOW, synchronously inside the tap
        // gesture, so mobile Safari lets replies play() minutes from now.
        if (!playbackElRef.current) playbackElRef.current = new Audio();
        const unlockEl = playbackElRef.current;
        unlockEl.src = SILENT_WAV;
        void unlockEl.play().catch(() => { /* unlock only */ });

        generationRef.current += 1;
        const generation = generationRef.current;

        if (live) {
            if (!(await startLive(generation))) return;
            setEngine('live');
        } else {
            if (!window.MediaRecorder) {
                onNotifyRef.current?.('This browser does not support microphone recording.', true);
                return;
            }
            if (!(await startBatch(generation))) return;
            monitorRef.current = window.setInterval(() => monitorTick(generation), MONITOR_INTERVAL_MS);
            setEngine('batch');
        }
        setModeState(modeRef.current);
        startListening();
        void acquireWakeLock();
    }, [startLive, startBatch, monitorTick, startListening, acquireWakeLock]);

    // A backgrounded tab drops the wake lock; take it back when the user
    // returns while a session is still running.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible' && statusRef.current !== 'idle') {
                void acquireWakeLock();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [acquireWakeLock]);

    /** Speak the assistant's reply, then go back to listening. */
    const speak = useCallback(async (text: string) => {
        if (statusRef.current === 'idle') return;
        const generation = generationRef.current;
        setStatusBoth('speaking');
        setSpeakingText(text);
        try {
            const blob = await fetchSpeech(text);
            if (generation !== generationRef.current) return;
            stopPlayback();
            setSpeakingText(text);
            const url = URL.createObjectURL(blob);
            // Reuse the session's gesture-unlocked element (mobile Safari)
            const audio = playbackElRef.current || new Audio();
            playbackElRef.current = audio;
            audio.src = url;
            audio.playbackRate = speedRef.current;
            playbackRef.current = { audio, url };
            const finish = () => {
                if (playbackRef.current?.audio === audio && playbackRef.current.url === url) {
                    playbackRef.current = null;
                    audio.onended = null;
                    audio.onerror = null;
                    URL.revokeObjectURL(url);
                }
                if (generation === generationRef.current) {
                    setSpeakingText('');
                    startListening();
                }
            };
            audio.onended = finish;
            audio.onerror = finish;
            await audio.play();
        } catch (error) {
            if (generation !== generationRef.current) return;
            setSpeakingText('');
            onNotifyRef.current?.((error as Error).message || 'Read-aloud failed.', true);
            startListening();
        }
    }, [setStatusBoth, stopPlayback, startListening]);

    /** Tap-to-interrupt: stop the spoken reply and listen again. */
    const interrupt = useCallback(() => {
        if (statusRef.current !== 'speaking') return;
        stopPlayback();
        startListening();
    }, [stopPlayback, startListening]);

    const toggleMute = useCallback(() => {
        const next = !mutedRef.current;
        mutedRef.current = next;
        setMutedState(next);
        if (liveRef.current) {
            liveRef.current.setMuted(next);
        } else {
            for (const track of streamRef.current?.getAudioTracks() || []) track.enabled = !next;
            // Whatever was half-recorded while unmuted is discarded
            if (statusRef.current === 'listening') beginRecorderSegment();
        }
        setTalking(false);
        setPartial('');
    }, [beginRecorderSegment]);

    const setMode = useCallback((next: VoiceSendMode) => {
        if (modeRef.current === next) return;
        modeRef.current = next;
        setModeState(next);
        if (liveRef.current) {
            liveRef.current.setMode(next);
        } else if (statusRef.current === 'listening') {
            beginRecorderSegment(); // drop the half-heard utterance
        }
        setTalking(false);
        setPartial('');
    }, [beginRecorderSegment]);

    /** Press-to-send: commit the current utterance right now. */
    const sendNow = useCallback(() => {
        if (statusRef.current !== 'listening') return;
        if (liveRef.current) {
            liveRef.current.sendNow();
            return;
        }
        if (vadRef.current.speechStartedAt) {
            finalizeUtterance(generationRef.current);
        }
    }, [finalizeUtterance]);

    const setPlaybackSpeed = useCallback((speed: number) => {
        speedRef.current = speed;
        const audio = playbackRef.current?.audio;
        if (audio) audio.playbackRate = speed;
    }, []);

    return {
        status,
        active: status !== 'idle',
        /** Reads the live status without waiting for a re-render (for use inside stream callbacks). */
        isActive: useCallback(() => statusRef.current !== 'idle', []),
        engine,
        partial,
        transcript,
        speakingText,
        level,
        talking,
        muted,
        mode,
        start,
        stop,
        speak,
        resume,
        interrupt,
        toggleMute,
        setMode,
        sendNow,
        setPlaybackSpeed
    };
}
