const { Readable } = require('stream');
const {
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior,
    AudioPlayerStatus
} = require('@discordjs/voice');

// Discord voice wants 48kHz stereo 16-bit PCM
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
// Safety net: a cue that never reaches idle must not hold the connection's
// subscription away from the TTS player for more than this.
const CUE_TIMEOUT_MS = 3000;

/**
 * In-voice notification cues, synthesized in code (no audio assets, no
 * FFmpeg, no cloud API - same philosophy as the Activity's WebAudio
 * sounds). Two cues:
 *
 * - response cue: a soft rising two-note chime, played the moment Goobster
 *   accepts a turn and starts preparing a reply.
 * - tool cue: a quick bright double-blip, played whenever he executes a
 *   tool/command mid-conversation (web search, economy, nicknames, ...).
 * - error cue: a low descending pair, played when something goes wrong -
 *   a tool call fails or a turn errors out before it could be spoken.
 *
 * Playback borrows the voice connection: a Discord connection plays one
 * audio player at a time, so the cue subscribes its own short-lived player
 * and re-subscribes whichever player was active before once it finishes.
 * Session TTS players pause while unsubscribed (NoSubscriberBehavior.Pause),
 * so in-flight speech resumes seamlessly after a cue.
 */

function silence(ms) {
    return Buffer.alloc(Math.round((ms / 1000) * SAMPLE_RATE) * CHANNELS * BYTES_PER_SAMPLE);
}

/**
 * One enveloped sine note as 48kHz stereo s16le PCM.
 */
function tone(frequency, ms, { volume = 0.22, attackMs = 6, releaseMs = 45 } = {}) {
    const samples = Math.round((ms / 1000) * SAMPLE_RATE);
    const buf = Buffer.alloc(samples * CHANNELS * BYTES_PER_SAMPLE);
    const attack = Math.max(1, Math.round((attackMs / 1000) * SAMPLE_RATE));
    const release = Math.max(1, Math.round((releaseMs / 1000) * SAMPLE_RATE));

    for (let i = 0; i < samples; i++) {
        let envelope = 1;
        if (i < attack) envelope = i / attack;
        const remaining = samples - i;
        if (remaining < release) envelope = Math.min(envelope, remaining / release);

        const value = Math.round(
            Math.sin(2 * Math.PI * frequency * (i / SAMPLE_RATE)) * volume * 32767 * envelope
        );
        const offset = i * CHANNELS * BYTES_PER_SAMPLE;
        buf.writeInt16LE(value, offset);     // left
        buf.writeInt16LE(value, offset + 2); // right
    }
    return buf;
}

// "Goobster heard you and is thinking": gentle rising chime (C5 -> G5)
const RESPONSE_CUE_PCM = Buffer.concat([
    silence(20),
    tone(523.25, 95),
    silence(40),
    tone(783.99, 150, { releaseMs: 70 }),
    silence(30)
]);

// "Goobster is running a tool": faster, brighter double-blip (B5 -> E6)
const TOOL_CUE_PCM = Buffer.concat([
    silence(20),
    tone(987.77, 55, { volume: 0.2, releaseMs: 25 }),
    silence(45),
    tone(1318.51, 55, { volume: 0.2, releaseMs: 25 }),
    silence(30)
]);

// "Something went wrong": low descending pair (G4 -> C4), gentler "womp"
const ERROR_CUE_PCM = Buffer.concat([
    silence(20),
    tone(392.0, 110, { volume: 0.24, releaseMs: 50 }),
    silence(35),
    tone(261.63, 190, { volume: 0.24, releaseMs: 90 }),
    silence(30)
]);

/**
 * Play a PCM cue into a voice connection. Never throws and never rejects -
 * cues are best-effort decoration and must not break a voice turn.
 * @returns {Promise<boolean>} whether the cue actually played
 */
function playCue(connection, pcm) {
    if (!connection || typeof connection.subscribe !== 'function') {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        let settled = false;
        let player = null;
        let timeout = null;
        const previous = connection.state?.subscription?.player || null;

        const done = (played) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            try {
                // Hand the connection back - unless something else (e.g. a
                // starting TTS reply) already claimed it mid-cue.
                if (connection.state?.subscription?.player === player) {
                    if (previous) connection.subscribe(previous);
                    else connection.state.subscription.unsubscribe();
                }
            } catch { /* connection already torn down */ }
            try { player?.stop(true); } catch { /* already stopped */ }
            resolve(played);
        };

        try {
            player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });
            const resource = createAudioResource(Readable.from([pcm]), {
                inputType: StreamType.Raw
            });
            timeout = setTimeout(() => done(true), CUE_TIMEOUT_MS);
            timeout.unref?.();
            player.on('stateChange', (oldState, newState) => {
                if (newState.status === AudioPlayerStatus.Idle) done(true);
            });
            player.on('error', () => done(false));
            player.play(resource);
            connection.subscribe(player);
        } catch {
            done(false);
        }
    });
}

/**
 * Cue: Goobster received the turn and is preparing a spoken reply.
 */
function playResponseCue(connection) {
    return playCue(connection, RESPONSE_CUE_PCM);
}

/**
 * Cue: Goobster is executing a tool/command mid-conversation.
 */
function playToolCue(connection) {
    return playCue(connection, TOOL_CUE_PCM);
}

/**
 * Cue: something failed (a tool call errored, or the turn itself died).
 */
function playErrorCue(connection) {
    return playCue(connection, ERROR_CUE_PCM);
}

module.exports = {
    playResponseCue,
    playToolCue,
    playErrorCue,
    // Exported for tests and offline rendering
    RESPONSE_CUE_PCM,
    TOOL_CUE_PCM,
    ERROR_CUE_PCM,
    SAMPLE_RATE,
    CHANNELS
};
