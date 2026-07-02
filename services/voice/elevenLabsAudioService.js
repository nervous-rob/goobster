const fetch = require('node-fetch');

const API_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Shared ElevenLabs audio-generation helpers for music and sound effects.
 * TTS lives in elevenLabsTTSService.js; this module covers the Music API
 * (mood music) and the Sound Effects API (ambient loops).
 */

function resolveApiKey(config = {}) {
    return config.elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY || null;
}

async function postForAudio(url, body, apiKey) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        let detail = '';
        try { detail = ` – ${await res.text()}`; } catch {}
        if (res.status === 401) {
            throw new Error(`Authentication failed: invalid ElevenLabs API key${detail}`);
        }
        if (res.status === 429) {
            throw new Error(`Rate limit exceeded on ElevenLabs API${detail}`);
        }
        throw new Error(`ElevenLabs API error ${res.status}${detail}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Generate an instrumental music track from a text prompt.
 * Returns an MP3 buffer. Requires a paid ElevenLabs plan (Music API).
 *
 * @param {string} prompt - Description of the desired music
 * @param {object} config - Bot config (for the API key and model override)
 * @param {number} lengthMs - Track length in milliseconds (3,000–600,000)
 */
async function generateMusic(prompt, config = {}, lengthMs = 30000) {
    const apiKey = resolveApiKey(config);
    if (!apiKey) {
        throw new Error('ElevenLabs API key not configured - music generation disabled');
    }
    return postForAudio(`${API_BASE}/music`, {
        prompt,
        music_length_ms: lengthMs,
        model_id: config.elevenlabs?.musicModelId || 'music_v2',
        force_instrumental: true
    }, apiKey);
}

/**
 * Generate a sound effect / ambience from a text prompt.
 * Returns an MP3 buffer. `loop: true` produces a seamlessly looping sound.
 *
 * @param {string} prompt - Description of the desired sound
 * @param {object} config - Bot config (for the API key)
 * @param {object} options - { durationSeconds (0.5–30), loop (boolean) }
 */
async function generateSoundEffect(prompt, config = {}, { durationSeconds = 30, loop = true } = {}) {
    const apiKey = resolveApiKey(config);
    if (!apiKey) {
        throw new Error('ElevenLabs API key not configured - sound effect generation disabled');
    }
    return postForAudio(`${API_BASE}/sound-generation`, {
        text: prompt,
        duration_seconds: durationSeconds,
        loop,
        prompt_influence: 0.5
    }, apiKey);
}

module.exports = {
    resolveApiKey,
    generateMusic,
    generateSoundEffect
};
