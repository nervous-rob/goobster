/**
 * Parlor Live client: the browser side of real-time voice sessions.
 *
 * One WebSocket per live session (/api/app/parlor/live, cookie auth).
 * Microphone audio is captured with an AudioWorklet (resampled to 16kHz
 * mono Int16 PCM in liveAudioWorklet.js), gated by a local RMS
 * voice-activity check (an utterance starts on speech energy with a short
 * pre-roll and commits after ~900ms of silence - the silence-gate
 * precedent from the voice engines), and streamed up as base64 chunks.
 *
 * Persona speech streams down as MP3 chunks tagged with the personaId.
 * Playback goes through a sequential queue: MediaSource streaming when the
 * browser supports it (audio starts while the reply is still downloading),
 * a Blob fallback otherwise. Turn events (user_message / persona_start /
 * delta / persona_message / ...) are handed to parlor.js for rendering -
 * the transcript UX is identical to typed turns.
 */

const VAD_RMS_THRESHOLD = 300;   // int16 scale; speech sits well above
const VAD_SILENCE_MS = 900;      // quiet this long ends the utterance
const MAX_UTTERANCE_MS = 55000;  // commit before the server's 60s cap
const PREROLL_CHUNKS = 2;        // ~0.5s of audio kept before speech starts

let ws = null;
let joinedConversationId = null;
let hooks = {};                  // { onTurnEvent, onSpeaking, onListeners, onEnded, toast }
let micStream = null;
let audioCtx = null;
let workletNode = null;
let muted = false;

// Voice-activity state
let utteranceActive = false;
let lastVoiceAt = 0;
let utteranceStartedAt = 0;
let preroll = [];

// UI elements (the live bar in index.html)
const bar = () => document.getElementById('parlor-live-bar');
const statusEl = () => document.getElementById('live-status');
const captionEl = () => document.getElementById('live-caption');
const muteBtn = () => document.getElementById('live-mute');

export function liveActive() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN && joinedConversationId !== null);
}

export function liveConversationId() {
    return joinedConversationId;
}

/* ---------- outgoing messages ---------- */

function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

/** Send a typed message through the live session (voiced like speech). */
export function liveSay(text) {
    if (!liveActive()) return false;
    wsSend({ type: 'say', text });
    return true;
}

/** Nudge one seated persona through the live session. */
export function liveNudge(personaId) {
    if (!liveActive()) return false;
    wsSend({ type: 'nudge', personaId });
    return true;
}

/* ---------- microphone capture ---------- */

function int16Rms(samples) {
    let sum = 0;
    let counted = 0;
    for (let i = 0; i < samples.length; i += 8) {
        sum += samples[i] * samples[i];
        counted++;
    }
    return counted === 0 ? 0 : Math.sqrt(sum / counted);
}

function int16ToBase64(samples) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function sendAudioChunk(samples) {
    wsSend({ type: 'audio', data: int16ToBase64(samples) });
}

function endUtterance() {
    if (!utteranceActive) return;
    utteranceActive = false;
    bar()?.classList.remove('talking');
    setCaption('');
    wsSend({ type: 'utterance-end' });
}

function handleMicChunk(samples) {
    if (!liveActive()) return;
    const rms = int16Rms(samples);
    const now = performance.now();

    if (!utteranceActive) {
        preroll.push(samples);
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
        if (rms >= VAD_RMS_THRESHOLD) {
            utteranceActive = true;
            lastVoiceAt = now;
            utteranceStartedAt = now;
            bar()?.classList.add('talking');
            for (const chunk of preroll.splice(0)) sendAudioChunk(chunk);
        }
        return;
    }

    sendAudioChunk(samples);
    if (rms >= VAD_RMS_THRESHOLD) lastVoiceAt = now;
    if (now - lastVoiceAt > VAD_SILENCE_MS || now - utteranceStartedAt > MAX_UTTERANCE_MS) {
        endUtterance();
    }
}

async function startMicrophone() {
    micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.audioWorklet.addModule('/app/liveAudioWorklet.js');
    const source = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, 'live-mic', { numberOfOutputs: 0 });
    workletNode.port.onmessage = (event) => handleMicChunk(new Int16Array(event.data));
    source.connect(workletNode);
}

function stopMicrophone() {
    utteranceActive = false;
    preroll = [];
    try { workletNode?.port.close(); } catch { /* already gone */ }
    try { workletNode?.disconnect(); } catch { /* already gone */ }
    workletNode = null;
    try { micStream?.getTracks().forEach(track => track.stop()); } catch { /* already gone */ }
    micStream = null;
    try { audioCtx?.close(); } catch { /* already gone */ }
    audioCtx = null;
}

/* ---------- persona speech playback ---------- */

const canStreamMp3 = typeof window.MediaSource === 'function'
    && MediaSource.isTypeSupported?.('audio/mpeg');

const speechEntries = new Map(); // streamId -> entry
let playQueue = [];              // streamIds in arrival order
let playingEntry = null;

function base64ToBytes(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function onSpeechStart(data) {
    speechEntries.set(data.streamId, {
        id: data.streamId,
        personaId: data.personaId,
        chunks: [],
        appended: 0,
        ended: false,
        audio: null,
        mediaSource: null,
        sourceBuffer: null,
        objectUrl: null
    });
    playQueue.push(data.streamId);
    playNext();
}

function onSpeechChunk(data) {
    const entry = speechEntries.get(data.streamId);
    if (!entry) return;
    entry.chunks.push(base64ToBytes(data.data));
    if (playingEntry === entry && entry.sourceBuffer) appendMore(entry);
}

function onSpeechEnd(data) {
    const entry = speechEntries.get(data.streamId);
    if (!entry) return;
    entry.ended = true;
    if (data.interrupted || data.error) {
        if (playingEntry === entry) finishPlayback(entry);
        else dropEntry(entry);
        return;
    }
    if (playingEntry === entry) {
        if (entry.sourceBuffer) appendMore(entry);
        else if (entry.pendingBlobPlayback) playAsBlob(entry);
    }
}

function appendMore(entry) {
    const { sourceBuffer, mediaSource } = entry;
    if (!sourceBuffer || sourceBuffer.updating) return;
    try {
        if (entry.appended < entry.chunks.length) {
            sourceBuffer.appendBuffer(entry.chunks[entry.appended++]);
        } else if (entry.ended && mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
        }
    } catch {
        // MSE hiccup (quota, decode) - restart this entry as a plain blob
        playAsBlob(entry);
    }
}

function playNext() {
    if (playingEntry || playQueue.length === 0) return;
    const entry = speechEntries.get(playQueue.shift());
    if (!entry) {
        playNext();
        return;
    }
    playingEntry = entry;
    hooks.onSpeaking?.(entry.personaId);

    if (canStreamMp3) {
        const mediaSource = new MediaSource();
        const audio = new Audio();
        entry.mediaSource = mediaSource;
        entry.audio = audio;
        entry.objectUrl = URL.createObjectURL(mediaSource);
        audio.src = entry.objectUrl;
        audio.muted = muted;
        mediaSource.addEventListener('sourceopen', () => {
            if (playingEntry !== entry) return;
            try {
                entry.sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                entry.sourceBuffer.addEventListener('updateend', () => appendMore(entry));
                appendMore(entry);
            } catch {
                playAsBlob(entry);
            }
        });
        audio.addEventListener('ended', () => finishPlayback(entry));
        audio.addEventListener('error', () => finishPlayback(entry));
        audio.play().catch(() => finishPlayback(entry));
    } else if (entry.ended) {
        playAsBlob(entry);
    } else {
        entry.pendingBlobPlayback = true; // wait for speech_end, then play
    }
}

function playAsBlob(entry) {
    cleanupAudio(entry);
    entry.pendingBlobPlayback = false;
    const blob = new Blob(entry.chunks, { type: 'audio/mpeg' });
    const audio = new Audio();
    entry.audio = audio;
    entry.objectUrl = URL.createObjectURL(blob);
    audio.src = entry.objectUrl;
    audio.muted = muted;
    audio.addEventListener('ended', () => finishPlayback(entry));
    audio.addEventListener('error', () => finishPlayback(entry));
    audio.play().catch(() => finishPlayback(entry));
}

function cleanupAudio(entry) {
    try { entry.audio?.pause(); } catch { /* already gone */ }
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    entry.audio = null;
    entry.mediaSource = null;
    entry.sourceBuffer = null;
    entry.objectUrl = null;
}

function dropEntry(entry) {
    cleanupAudio(entry);
    speechEntries.delete(entry.id);
    playQueue = playQueue.filter(id => id !== entry.id);
}

function finishPlayback(entry) {
    if (playingEntry !== entry) return;
    playingEntry = null;
    dropEntry(entry);
    hooks.onSpeaking?.(null);
    playNext();
}

function stopAllPlayback() {
    if (playingEntry) {
        const entry = playingEntry;
        playingEntry = null;
        dropEntry(entry);
    }
    for (const entry of [...speechEntries.values()]) dropEntry(entry);
    playQueue = [];
    hooks.onSpeaking?.(null);
}

/* ---------- the live bar UI ---------- */

function setCaption(text) {
    const el = captionEl();
    if (el) el.textContent = text || '';
}

function setStatus(text) {
    const el = statusEl();
    if (el) el.textContent = text;
}

function setMuted(next) {
    muted = next;
    if (playingEntry?.audio) playingEntry.audio.muted = muted;
    const btn = muteBtn();
    if (btn) {
        btn.textContent = muted ? '🔇' : '🔊';
        btn.title = muted ? 'Unmute persona audio' : 'Mute persona audio';
        btn.setAttribute('aria-label', btn.title);
    }
}

let uiWired = false;

function wireUi() {
    if (uiWired) return;
    uiWired = true;
    muteBtn()?.addEventListener('click', () => setMuted(!muted));
    document.getElementById('live-stop-speech')?.addEventListener('click', () => {
        // Server-side barge-in in solo sessions; local stop either way
        wsSend({ type: 'stop-speech' });
        stopAllPlayback();
    });
    document.getElementById('live-leave')?.addEventListener('click', () => leaveLive());
}

/* ---------- session lifecycle ---------- */

/**
 * Join a live session for one discussion. Resolves once joined (mic
 * running, socket open); rejects when the mic or the join fails.
 * @param {number} conversationId
 * @param {Object} sessionHooks - { onTurnEvent(event, data), onSpeaking(personaId|null),
 *   onListeners(list), onEnded(reason), toast }
 */
export async function startLive(conversationId, sessionHooks) {
    if (liveActive()) leaveLive();
    hooks = sessionHooks || {};
    wireUi();

    // The mic prompt comes first: no point opening a socket the user
    // refuses audio for.
    await startMicrophone();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/app/parlor/live`);
    ws = socket;

    await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message) => {
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
            if (ws === socket) teardown('connection closed');
        });
        socket.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            if (!settled) {
                if (message.type === 'joined') {
                    settled = true;
                    joinedConversationId = message.conversationId;
                    bar()?.classList.remove('hidden');
                    setStatus('Live - just start talking');
                    hooks.onListeners?.(message.listeners || []);
                    resolve();
                    return;
                }
                if (message.type === 'error') {
                    fail(message.message || 'Could not join the live session.');
                    try { socket.close(); } catch { /* already gone */ }
                    return;
                }
            }
            handleServerMessage(message);
        });
    }).catch((error) => {
        stopMicrophone();
        if (ws === socket) ws = null;
        joinedConversationId = null;
        throw error;
    });
}

const TURN_EVENTS = new Set([
    'user_message', 'persona_start', 'persona_pass', 'delta',
    'persona_tool', 'persona_message', 'learned', 'turn_done', 'turn_error'
]);

function handleServerMessage(message) {
    if (TURN_EVENTS.has(message.type)) {
        hooks.onTurnEvent?.(message.type, message);
        return;
    }
    switch (message.type) {
        case 'stt_partial':
            setCaption(`🎤 ${message.text || ''}`);
            break;
        case 'utterance':
            setCaption('');
            if (message.queued) setStatus('Heard - queued behind the current turn');
            else setStatus('Live - just start talking');
            break;
        case 'utterance_empty':
            setCaption('');
            break;
        case 'speech_start':
            onSpeechStart(message);
            break;
        case 'speech_chunk':
            onSpeechChunk(message);
            break;
        case 'speech_end':
            onSpeechEnd(message);
            break;
        case 'listener_join':
        case 'listener_leave':
            hooks.onListenerChange?.(message);
            break;
        case 'session_replaced':
            hooks.toast?.('This live session moved to another tab.', true);
            leaveLive('replaced');
            break;
        case 'session_ended':
            hooks.toast?.(message.reason === 'time-limit'
                ? 'The live session reached its time limit.'
                : 'The live session ended.');
            teardown(message.reason);
            break;
        case 'error':
            hooks.toast?.(message.message || 'Live session error.', true);
            break;
        default:
            break;
    }
}

function teardown(reason) {
    stopMicrophone();
    stopAllPlayback();
    bar()?.classList.add('hidden');
    setCaption('');
    joinedConversationId = null;
    ws = null;
    hooks.onEnded?.(reason);
}

/** Leave the live session (button, pane switch, discussion switch). */
export function leaveLive(reason = 'left') {
    const socket = ws;
    ws = null;
    if (socket) {
        try { socket.send(JSON.stringify({ type: 'leave' })); } catch { /* closing */ }
        try { socket.close(); } catch { /* already gone */ }
    }
    if (joinedConversationId !== null || micStream) teardown(reason);
}
