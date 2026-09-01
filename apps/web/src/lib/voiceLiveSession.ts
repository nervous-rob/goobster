/**
 * Voice-chat live transcription session: one WebSocket to
 * /api/app/voice/live, one mic worklet (16kHz mono PCM - the Parlor Live
 * capture pipeline), and the client-side utterance gate. Transcription
 * only: committed utterances come back as text and the caller sends them
 * through the normal chat SSE route.
 *
 * Two send modes:
 *  - auto:   the VAD gate segments speech; a pause commits the utterance.
 *  - manual: everything is streamed while unmuted; the user commits
 *            explicitly ("press to send").
 */

import { int16Rms, int16ToBase64, UtteranceGate } from './parlorLiveAudio.js';

const WORKLET_URL = '/app/liveAudioWorklet.js';
// Int16 RMS that maps to a "full" level meter (speech peaks ~6000-12000)
const LEVEL_FULL_RMS = 9000;

export type VoiceSendMode = 'auto' | 'manual';

export type VoiceLiveHooks = {
    /** Streaming partial transcript of the current utterance. */
    onPartial?: (text: string) => void;
    /** The committed utterance text (send it as a chat message). */
    onUtterance?: (text: string) => void;
    /** The utterance contained no recognizable words. */
    onUtteranceEmpty?: () => void;
    /** Microphone level 0..1 (for the visualizer). */
    onLevel?: (level: number) => void;
    /** Speech started/stopped crossing the VAD gate (auto mode). */
    onTalking?: (talking: boolean) => void;
    /** An utterance was committed for transcription (auto pause or send). */
    onCommit?: () => void;
    onError?: (message: string) => void;
    /** The socket closed (server shutdown, network loss). */
    onClosed?: () => void;
};

export class VoiceLiveSession {
    private hooks: VoiceLiveHooks = {};
    private ws: WebSocket | null = null;
    private micStream: MediaStream | null = null;
    private audioCtx: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private gate: UtteranceGate;
    private mode: VoiceSendMode = 'auto';
    private muted = false;
    /** True while the caller is processing a turn (mic input is dropped). */
    private paused = false;
    /** Manual mode: whether any audio was streamed since the last commit. */
    private manualStreaming = false;

    constructor() {
        this.gate = new UtteranceGate({
            onStartChunks: (chunks: Int16Array[]) => {
                this.hooks.onTalking?.(true);
                for (const chunk of chunks) this.sendAudioChunk(chunk);
            },
            onChunk: (samples: Int16Array) => this.sendAudioChunk(samples),
            onEnd: () => {
                this.hooks.onTalking?.(false);
                this.wsSend({ type: 'utterance-end' });
                this.hooks.onCommit?.();
            }
        });
    }

    get active(): boolean {
        return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
    }

    get sendMode(): VoiceSendMode {
        return this.mode;
    }

    async start(hooks: VoiceLiveHooks = {}, { mode = 'auto' as VoiceSendMode } = {}): Promise<void> {
        this.hooks = hooks;
        this.mode = mode;
        this.muted = false;
        this.paused = false;

        await this.startMicrophone();

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/api/app/voice/live`);
        this.ws = socket;

        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const fail = (message: string) => {
                    if (settled) return;
                    settled = true;
                    reject(new Error(message));
                };
                socket.addEventListener('error', () => fail('Could not reach the live transcription endpoint.'));
                socket.addEventListener('close', () => {
                    if (!settled) fail('The live connection closed before it was ready.');
                    if (this.ws === socket) this.teardown();
                });
                socket.addEventListener('message', (event) => {
                    let message: Record<string, unknown>;
                    try {
                        message = JSON.parse(String(event.data)) as Record<string, unknown>;
                    } catch {
                        return;
                    }
                    if (!settled) {
                        if (message.type === 'ready') {
                            settled = true;
                            resolve();
                            return;
                        }
                        if (message.type === 'error') {
                            fail(String(message.message || 'Could not start live transcription.'));
                            try { socket.close(); } catch { /* already gone */ }
                            return;
                        }
                    }
                    this.handleServerMessage(message);
                });
            });
        } catch (error) {
            this.stopMicrophone();
            if (this.ws === socket) this.ws = null;
            throw error;
        }
    }

    setMode(mode: VoiceSendMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        // A half-heard utterance from the previous mode would commit under
        // the wrong rules - drop it and start clean.
        this.cancelUtterance();
    }

    setMuted(muted: boolean): void {
        if (this.muted === muted) return;
        this.muted = muted;
        for (const track of this.micStream?.getAudioTracks() || []) track.enabled = !muted;
        if (muted) this.cancelUtterance();
    }

    get isMuted(): boolean {
        return this.muted;
    }

    /** Pause/resume capture while a turn or reply is in flight. */
    setPaused(paused: boolean): void {
        if (this.paused === paused) return;
        this.paused = paused;
        if (paused) this.cancelUtterance();
    }

    /** Manual mode: commit whatever has been streamed so far. */
    sendNow(): boolean {
        if (!this.active || this.mode !== 'manual' || !this.manualStreaming) return false;
        this.manualStreaming = false;
        this.hooks.onTalking?.(false);
        this.wsSend({ type: 'utterance-end' });
        this.hooks.onCommit?.();
        return true;
    }

    /** Drop the in-flight utterance without transcribing it. */
    cancelUtterance(): void {
        const hadAudio = this.gate.active || this.manualStreaming;
        this.gate.reset();
        this.manualStreaming = false;
        if (hadAudio) {
            this.hooks.onTalking?.(false);
            this.wsSend({ type: 'cancel' });
        }
    }

    stop(): void {
        const socket = this.ws;
        this.ws = null;
        if (socket) {
            try { socket.close(); } catch { /* already gone */ }
        }
        this.stopMicrophone();
    }

    private wsSend(payload: Record<string, unknown>): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }

    private sendAudioChunk(samples: Int16Array): void {
        this.wsSend({ type: 'audio', data: int16ToBase64(samples) });
    }

    private onMicChunk(samples: Int16Array): void {
        if (!this.active || this.muted || this.paused) {
            this.hooks.onLevel?.(0);
            return;
        }
        this.hooks.onLevel?.(Math.min(1, int16Rms(samples) / LEVEL_FULL_RMS));
        if (this.mode === 'manual') {
            if (!this.manualStreaming) {
                this.manualStreaming = true;
                this.hooks.onTalking?.(true);
            }
            this.sendAudioChunk(samples);
            return;
        }
        this.gate.push(samples, performance.now());
    }

    private async startMicrophone(): Promise<void> {
        this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        const Ctx = window.AudioContext
            || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new Ctx();
        await this.audioCtx.audioWorklet.addModule(WORKLET_URL);
        const source = this.audioCtx.createMediaStreamSource(this.micStream);
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'live-mic', { numberOfOutputs: 0 });
        this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            this.onMicChunk(new Int16Array(event.data));
        };
        source.connect(this.workletNode);
    }

    private stopMicrophone(): void {
        this.gate.reset();
        this.manualStreaming = false;
        try { this.workletNode?.port.close(); } catch { /* already gone */ }
        try { this.workletNode?.disconnect(); } catch { /* already gone */ }
        this.workletNode = null;
        try { this.micStream?.getTracks().forEach((track) => track.stop()); } catch { /* already gone */ }
        this.micStream = null;
        try { void this.audioCtx?.close(); } catch { /* already gone */ }
        this.audioCtx = null;
    }

    private handleServerMessage(message: Record<string, unknown>): void {
        switch (String(message.type || '')) {
            case 'stt_partial':
                this.hooks.onPartial?.(String(message.text || ''));
                break;
            case 'utterance':
                this.hooks.onUtterance?.(String(message.text || ''));
                break;
            case 'utterance_empty':
                this.hooks.onUtteranceEmpty?.();
                break;
            case 'error':
                this.hooks.onError?.(String(message.message || 'Live transcription error.'));
                break;
            default:
                break;
        }
    }

    private teardown(): void {
        this.stopMicrophone();
        this.ws = null;
        this.hooks.onClosed?.();
    }
}
