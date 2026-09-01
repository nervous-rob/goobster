import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchSpeech } from '../lib/api';

/**
 * Hands-free voice-chat session for the Study chat: an open mic with
 * voice-activity detection segments what the user says into utterances,
 * each utterance is transcribed (`/api/app/voice/transcribe`) and handed
 * to the caller to send as a normal chat message, and the assistant's
 * reply is spoken back (`/api/app/voice/tts`) before the mic re-opens.
 *
 * The loop is: listening → transcribing → thinking → speaking → listening.
 * The microphone is only captured while `listening`, so the bot never
 * hears its own reply.
 */

export type VoiceChatStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

type VoiceChatOptions = {
    /** Called with the recognized text; the caller sends it as a chat message. */
    onUtterance: (text: string) => void;
    onNotify?: (message: string, isError?: boolean) => void;
};

// Voice-activity detection tuning. RMS is of Web Audio float samples (0..1).
const BASE_SPEECH_THRESHOLD = 0.012;
const NOISE_FLOOR_MULTIPLIER = 2.5;
const SILENCE_HANGOVER_MS = 1300; // trailing silence that ends an utterance
const MIN_SPEECH_MS = 250; // shorter bursts are treated as noise
const MAX_UTTERANCE_MS = 60_000;
const IDLE_RESTART_MS = 15_000; // cap leading silence kept in the recording
const MONITOR_INTERVAL_MS = 60;

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
    // Bumped on every start/stop so in-flight async work from a previous
    // session can tell it has been superseded and bail out.
    const generationRef = useRef(0);

    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const monitorRef = useRef<number | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<BlobPart[]>([]);
    const playbackRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);

    const vadRef = useRef({ speechStartedAt: 0, lastVoiceAt: 0, recorderStartedAt: 0, noiseFloor: BASE_SPEECH_THRESHOLD });
    const onUtteranceRef = useRef(onUtterance);
    onUtteranceRef.current = onUtterance;
    const onNotifyRef = useRef(onNotify);
    onNotifyRef.current = onNotify;

    const setStatusBoth = useCallback((next: VoiceChatStatus) => {
        statusRef.current = next;
        setStatus(next);
    }, []);

    const stopPlayback = useCallback(() => {
        const playback = playbackRef.current;
        if (!playback) return;
        playbackRef.current = null;
        try { playback.audio.pause(); } catch { /* already stopped */ }
        URL.revokeObjectURL(playback.url);
    }, []);

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
        setStatusBoth('idle');
    }, [stopRecorder, stopPlayback, setStatusBoth]);

    useEffect(() => () => stop(), [stop]);

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
    }, [stopRecorder]);

    const startListening = useCallback(() => {
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
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);

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
            if (!vad.speechStartedAt) vad.speechStartedAt = now;
        }
        if (vad.speechStartedAt) {
            const silenceMs = now - vad.lastVoiceAt;
            const speechMs = vad.lastVoiceAt - vad.speechStartedAt;
            if (silenceMs >= SILENCE_HANGOVER_MS) {
                if (speechMs >= MIN_SPEECH_MS) finalizeUtterance(generation);
                else beginRecorderSegment(); // a blip, not speech
            } else if (now - vad.speechStartedAt >= MAX_UTTERANCE_MS) {
                finalizeUtterance(generation);
            }
        } else if (now - vad.recorderStartedAt >= IDLE_RESTART_MS) {
            beginRecorderSegment();
        }
    }, [finalizeUtterance, beginRecorderSegment]);

    const start = useCallback(async () => {
        if (statusRef.current !== 'idle') return;
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            onNotifyRef.current?.('This browser does not support microphone recording.', true);
            return;
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true }
            });
        } catch {
            onNotifyRef.current?.('Microphone access was denied.', true);
            return;
        }
        generationRef.current += 1;
        const generation = generationRef.current;
        streamRef.current = stream;
        const AudioContextCtor = window.AudioContext
            || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextCtor) {
            const ctx = new AudioContextCtor();
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            audioContextRef.current = ctx;
            analyserRef.current = analyser;
        }
        vadRef.current.noiseFloor = BASE_SPEECH_THRESHOLD;
        monitorRef.current = window.setInterval(() => monitorTick(generation), MONITOR_INTERVAL_MS);
        startListening();
        onNotifyRef.current?.('Voice chat started — just talk, Goobster replies out loud.');
    }, [monitorTick, startListening]);

    /** Speak the assistant's reply, then go back to listening. */
    const speak = useCallback(async (text: string) => {
        if (statusRef.current === 'idle') return;
        const generation = generationRef.current;
        setStatusBoth('speaking');
        try {
            const blob = await fetchSpeech(text);
            if (generation !== generationRef.current) return;
            stopPlayback();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            playbackRef.current = { audio, url };
            const finish = () => {
                if (playbackRef.current?.audio === audio) {
                    playbackRef.current = null;
                    URL.revokeObjectURL(url);
                }
                if (generation === generationRef.current) startListening();
            };
            audio.addEventListener('ended', finish);
            audio.addEventListener('error', finish);
            await audio.play();
        } catch (error) {
            if (generation !== generationRef.current) return;
            onNotifyRef.current?.((error as Error).message || 'Read-aloud failed.', true);
            startListening();
        }
    }, [setStatusBoth, stopPlayback, startListening]);

    return {
        status,
        active: status !== 'idle',
        /** Reads the live status without waiting for a re-render (for use inside stream callbacks). */
        isActive: useCallback(() => statusRef.current !== 'idle', []),
        start,
        stop,
        speak,
        resume
    };
}
