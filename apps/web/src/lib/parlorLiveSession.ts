/**
 * Parlor Live session: one WebSocket, one mic worklet, sequential persona TTS.
 * Ported from the pre-React client's parlorLive.js — no DOM, hook-friendly.
 */

import { int16ToBase64, UtteranceGate } from './parlorLiveAudio.js';

const WORKLET_URL = '/app/liveAudioWorklet.js';
const TURN_EVENTS = new Set([
    'user_message', 'persona_start', 'persona_pass', 'delta',
    'persona_tool', 'persona_message', 'learned', 'turn_done', 'turn_error'
]);

export type LiveTurnEvent = string;
export type LiveListener = { userId?: string; userName?: string; name?: string };

export type ParlorLiveHooks = {
    onTurnEvent?: (event: LiveTurnEvent, data: Record<string, unknown>) => void;
    onSpeaking?: (personaId: number | null) => void;
    onListeners?: (list: LiveListener[]) => void;
    onListenerChange?: (message: Record<string, unknown>) => void;
    onStatus?: (text: string) => void;
    onCaption?: (text: string) => void;
    onTalking?: (talking: boolean) => void;
    onEnded?: (reason?: string) => void;
    toast?: (message: string, isError?: boolean) => void;
};

type SpeechEntry = {
    id: string;
    personaId: number | null;
    chunks: Uint8Array[];
    appended: number;
    ended: boolean;
    audio: HTMLAudioElement | null;
    mediaSource: MediaSource | null;
    sourceBuffer: SourceBuffer | null;
    objectUrl: string | null;
    pendingBlobPlayback?: boolean;
};

const canStreamMp3 = typeof window !== 'undefined'
    && typeof window.MediaSource === 'function'
    && Boolean(window.MediaSource.isTypeSupported?.('audio/mpeg'));

function base64ToBytes(data: string): Uint8Array {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export class ParlorLiveSession {
    private hooks: ParlorLiveHooks = {};
    private ws: WebSocket | null = null;
    private joinedConversationId: number | null = null;
    private micStream: MediaStream | null = null;
    private audioCtx: AudioContext | null = null;
    private workletNode: AudioWorkletNode | null = null;
    private muted = false;
    private gate: UtteranceGate;
    private speechEntries = new Map<string, SpeechEntry>();
    private playQueue: string[] = [];
    private playingEntry: SpeechEntry | null = null;

    constructor() {
        this.gate = new UtteranceGate({
            onStartChunks: (chunks) => {
                this.hooks.onTalking?.(true);
                for (const chunk of chunks) this.sendAudioChunk(chunk);
            },
            onChunk: (samples) => this.sendAudioChunk(samples),
            onEnd: () => {
                this.hooks.onTalking?.(false);
                this.hooks.onCaption?.('');
                this.wsSend({ type: 'utterance-end' });
            }
        });
    }

    get active(): boolean {
        return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.joinedConversationId !== null);
    }

    get conversationId(): number | null {
        return this.joinedConversationId;
    }

    get isMuted(): boolean {
        return this.muted;
    }

    say(text: string): boolean {
        if (!this.active) return false;
        this.wsSend({ type: 'say', text });
        return true;
    }

    nudge(personaId: number): boolean {
        if (!this.active) return false;
        this.wsSend({ type: 'nudge', personaId });
        return true;
    }

    stopSpeech(): void {
        this.wsSend({ type: 'stop-speech' });
        this.stopAllPlayback();
    }

    setMuted(next: boolean): void {
        this.muted = next;
        if (this.playingEntry?.audio) this.playingEntry.audio.muted = next;
    }

    async start(conversationId: number, hooks: ParlorLiveHooks = {}): Promise<void> {
        if (this.active) this.leave();
        this.hooks = hooks;

        await this.startMicrophone();

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/api/app/parlor/live`);
        this.ws = socket;

        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const fail = (message: string) => {
                    if (settled) return;
                    settled = true;
                    reject(new Error(message));
                };
                socket.addEventListener('open', () => {
                    socket.send(JSON.stringify({ type: 'join', conversationId }));
                });
                socket.addEventListener('error', () => fail('Could not reach the live session endpoint.'));
                socket.addEventListener('close', () => {
                    if (!settled) fail('The live connection closed before joining.');
                    if (this.ws === socket) this.teardown('connection closed');
                });
                socket.addEventListener('message', (event) => {
                    let message: Record<string, unknown>;
                    try {
                        message = JSON.parse(String(event.data)) as Record<string, unknown>;
                    } catch {
                        return;
                    }
                    if (!settled) {
                        if (message.type === 'joined') {
                            settled = true;
                            this.joinedConversationId = Number(message.conversationId);
                            this.hooks.onStatus?.('Live - just start talking');
                            this.hooks.onListeners?.((message.listeners as LiveListener[]) || []);
                            resolve();
                            return;
                        }
                        if (message.type === 'error') {
                            fail(String(message.message || 'Could not join the live session.'));
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
            this.joinedConversationId = null;
            throw error;
        }
    }

    leave(reason = 'left'): void {
        const socket = this.ws;
        this.ws = null;
        if (socket) {
            try { socket.send(JSON.stringify({ type: 'leave' })); } catch { /* closing */ }
            try { socket.close(); } catch { /* already gone */ }
        }
        if (this.joinedConversationId !== null || this.micStream) this.teardown(reason);
    }

    private wsSend(payload: Record<string, unknown>): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }

    private sendAudioChunk(samples: Int16Array): void {
        this.wsSend({ type: 'audio', data: int16ToBase64(samples) });
    }

    private async startMicrophone(): Promise<void> {
        this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new Ctx();
        await this.audioCtx.audioWorklet.addModule(WORKLET_URL);
        const source = this.audioCtx.createMediaStreamSource(this.micStream);
        this.workletNode = new AudioWorkletNode(this.audioCtx, 'live-mic', { numberOfOutputs: 0 });
        this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
            if (!this.active) return;
            this.gate.push(new Int16Array(event.data), performance.now());
        };
        source.connect(this.workletNode);
    }

    private stopMicrophone(): void {
        this.gate.end();
        this.gate.reset();
        this.hooks.onTalking?.(false);
        try { this.workletNode?.port.close(); } catch { /* already gone */ }
        try { this.workletNode?.disconnect(); } catch { /* already gone */ }
        this.workletNode = null;
        try { this.micStream?.getTracks().forEach((track) => track.stop()); } catch { /* already gone */ }
        this.micStream = null;
        try { void this.audioCtx?.close(); } catch { /* already gone */ }
        this.audioCtx = null;
    }

    private handleServerMessage(message: Record<string, unknown>): void {
        const type = String(message.type || '');
        if (TURN_EVENTS.has(type)) {
            this.hooks.onTurnEvent?.(type, message);
            return;
        }
        switch (type) {
            case 'stt_partial':
                this.hooks.onCaption?.(`🎤 ${String(message.text || '')}`);
                break;
            case 'utterance':
                this.hooks.onCaption?.('');
                this.hooks.onStatus?.(message.queued
                    ? 'Heard - queued behind the current turn'
                    : 'Live - just start talking');
                break;
            case 'utterance_empty':
                this.hooks.onCaption?.('');
                break;
            case 'speech_start':
                this.onSpeechStart(message);
                break;
            case 'speech_chunk':
                this.onSpeechChunk(message);
                break;
            case 'speech_end':
                this.onSpeechEnd(message);
                break;
            case 'listener_join':
            case 'listener_leave':
                this.hooks.onListenerChange?.(message);
                break;
            case 'session_replaced':
                this.hooks.toast?.('This live session moved to another tab.', true);
                this.leave('replaced');
                break;
            case 'session_ended':
                this.hooks.toast?.(message.reason === 'time-limit'
                    ? 'The live session reached its time limit.'
                    : 'The live session ended.');
                this.teardown(String(message.reason || 'ended'));
                break;
            case 'error':
                this.hooks.toast?.(String(message.message || 'Live session error.'), true);
                break;
            default:
                break;
        }
    }

    private onSpeechStart(data: Record<string, unknown>): void {
        const streamId = String(data.streamId);
        this.speechEntries.set(streamId, {
            id: streamId,
            personaId: data.personaId == null ? null : Number(data.personaId),
            chunks: [],
            appended: 0,
            ended: false,
            audio: null,
            mediaSource: null,
            sourceBuffer: null,
            objectUrl: null
        });
        this.playQueue.push(streamId);
        this.playNext();
    }

    private onSpeechChunk(data: Record<string, unknown>): void {
        const entry = this.speechEntries.get(String(data.streamId));
        if (!entry) return;
        entry.chunks.push(base64ToBytes(String(data.data || '')));
        if (this.playingEntry === entry && entry.sourceBuffer) this.appendMore(entry);
    }

    private onSpeechEnd(data: Record<string, unknown>): void {
        const entry = this.speechEntries.get(String(data.streamId));
        if (!entry) return;
        entry.ended = true;
        if (data.interrupted || data.error) {
            if (this.playingEntry === entry) this.finishPlayback(entry);
            else this.dropEntry(entry);
            return;
        }
        if (this.playingEntry === entry) {
            if (entry.sourceBuffer) this.appendMore(entry);
            else if (entry.pendingBlobPlayback) this.playAsBlob(entry);
        }
    }

    private appendMore(entry: SpeechEntry): void {
        const { sourceBuffer, mediaSource } = entry;
        if (!sourceBuffer || sourceBuffer.updating) return;
        try {
            if (entry.appended < entry.chunks.length) {
                const chunk = entry.chunks[entry.appended++];
                sourceBuffer.appendBuffer(chunk.slice());
            } else if (entry.ended && mediaSource?.readyState === 'open') {
                mediaSource.endOfStream();
            }
        } catch {
            this.playAsBlob(entry);
        }
    }

    private playNext(): void {
        if (this.playingEntry || this.playQueue.length === 0) return;
        const entry = this.speechEntries.get(this.playQueue.shift() as string);
        if (!entry) {
            this.playNext();
            return;
        }
        this.playingEntry = entry;
        this.hooks.onSpeaking?.(entry.personaId);

        if (canStreamMp3) {
            const mediaSource = new MediaSource();
            const audio = new Audio();
            entry.mediaSource = mediaSource;
            entry.audio = audio;
            entry.objectUrl = URL.createObjectURL(mediaSource);
            audio.src = entry.objectUrl;
            audio.muted = this.muted;
            mediaSource.addEventListener('sourceopen', () => {
                if (this.playingEntry !== entry) return;
                try {
                    entry.sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                    entry.sourceBuffer.addEventListener('updateend', () => this.appendMore(entry));
                    this.appendMore(entry);
                } catch {
                    this.playAsBlob(entry);
                }
            });
            audio.addEventListener('ended', () => this.finishPlayback(entry));
            audio.addEventListener('error', () => this.finishPlayback(entry));
            audio.play().catch(() => this.finishPlayback(entry));
        } else if (entry.ended) {
            this.playAsBlob(entry);
        } else {
            entry.pendingBlobPlayback = true;
        }
    }

    private playAsBlob(entry: SpeechEntry): void {
        this.cleanupAudio(entry);
        entry.pendingBlobPlayback = false;
        const blob = new Blob(entry.chunks as BlobPart[], { type: 'audio/mpeg' });
        const audio = new Audio();
        entry.audio = audio;
        entry.objectUrl = URL.createObjectURL(blob);
        audio.src = entry.objectUrl;
        audio.muted = this.muted;
        audio.addEventListener('ended', () => this.finishPlayback(entry));
        audio.addEventListener('error', () => this.finishPlayback(entry));
        audio.play().catch(() => this.finishPlayback(entry));
    }

    private cleanupAudio(entry: SpeechEntry): void {
        try { entry.audio?.pause(); } catch { /* already gone */ }
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
        entry.audio = null;
        entry.mediaSource = null;
        entry.sourceBuffer = null;
        entry.objectUrl = null;
    }

    private dropEntry(entry: SpeechEntry): void {
        this.cleanupAudio(entry);
        this.speechEntries.delete(entry.id);
        this.playQueue = this.playQueue.filter((id) => id !== entry.id);
    }

    private finishPlayback(entry: SpeechEntry): void {
        if (this.playingEntry !== entry) return;
        this.playingEntry = null;
        this.dropEntry(entry);
        this.hooks.onSpeaking?.(null);
        this.playNext();
    }

    private stopAllPlayback(): void {
        if (this.playingEntry) {
            const entry = this.playingEntry;
            this.playingEntry = null;
            this.dropEntry(entry);
        }
        for (const entry of [...this.speechEntries.values()]) this.dropEntry(entry);
        this.playQueue = [];
        this.hooks.onSpeaking?.(null);
    }

    private teardown(reason?: string): void {
        this.stopMicrophone();
        this.stopAllPlayback();
        this.hooks.onCaption?.('');
        this.joinedConversationId = null;
        this.ws = null;
        this.hooks.onEnded?.(reason);
    }
}
