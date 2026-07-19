const fetch = require('node-fetch');
const { EventEmitter } = require('events');
const prism = require('prism-media');
const {
    createAudioResource,
    createAudioPlayer,
    StreamType,
    NoSubscriberBehavior
} = require('@discordjs/voice');

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel (premade voice)
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';    // low latency, 32 languages

// ElevenLabs voice IDs are ~20-char alphanumeric tokens; anything else is
// treated as a human-friendly voice name that needs lookup via /v1/voices.
const VOICE_ID_PATTERN = /^[a-zA-Z0-9]{16,}$/;

class ElevenLabsTTSService extends EventEmitter {
    constructor(config = {}) {
        super();
        const apiKey = config.elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            console.warn('ElevenLabs API key not found – TTS disabled');
            this.disabled = true;
            return;
        }
        this.apiKey = apiKey;
        this.voiceId = config.elevenlabs?.voiceId
            || process.env.ELEVENLABS_VOICE_ID
            || DEFAULT_VOICE_ID;
        // Friendly display name for the configured voice (when known)
        this.voiceName = config.elevenlabs?.voiceName || null;
        this.modelId = config.elevenlabs?.modelId
            || process.env.ELEVENLABS_MODEL_ID
            || DEFAULT_MODEL_ID;

        this.voiceNameCache = new Map(); // lowercased name -> { id, name, category }

        this.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
        });
        this.activeResources = new Set();
    }

    async textToSpeech(text, voiceChannel, connection) {
        if (this.disabled) return;

        const response = await this.fetchStream(text);

        // Input is MP3; decode & resample to 48 kHz stereo raw PCM for Discord
        const transcoder = new prism.FFmpeg({
            args: [
                '-i', 'pipe:0',
                '-analyzeduration', '0',
                '-loglevel', '0',
                '-acodec', 'pcm_s16le',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-af', 'volume=1.5',
            ]
        });

        response.body.pipe(transcoder);
        transcoder.stderr?.on('data', d => console.error('[FFMPEG]', d.toString()));

        // Mark the stream as raw PCM so discord.js skips container probing
        const resource = createAudioResource(transcoder, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });
        this.activeResources.add(resource);
        resource.volume?.setVolume(1.0);

        await new Promise((res) => transcoder.once('readable', res)); // wait for first packet
        this.player.play(resource);
        connection.subscribe(this.player);

        return new Promise((resolve) => {
            const cleanup = () => {
                this.activeResources.delete(resource);
                try { transcoder.destroy(); } catch {}
                this.player.removeListener('stateChange', handler);
                resolve();
            };
            const handler = (oldState, newState) => {
                if (newState.status === 'idle') cleanup();
            };
            this.player.on('stateChange', handler);
        });
    }

    /**
     * Fetch the account's voice library: [{ id, name, category }].
     * Results also refresh the name-resolution cache.
     */
    async listVoices() {
        const res = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': this.apiKey }
        });
        if (!res.ok) {
            throw new Error(`ElevenLabs voices API error ${res.status}`);
        }
        const data = await res.json();
        const voices = (data.voices || []).map(v => ({
            id: v.voice_id,
            name: v.name,
            category: v.category || null
        }));
        this.voiceNameCache.clear();
        for (const voice of voices) {
            this.voiceNameCache.set(voice.name.toLowerCase(), voice);
        }
        return voices;
    }

    /**
     * Resolve a voice name or ID to a { id, name } pair against the account's
     * voice library. Matching is case-insensitive and tolerant of the display
     * suffixes ElevenLabs appends to premade voices ("Sarah" matches
     * "Sarah - Mature, Reassuring, Confident"). Throws (listing the available
     * names) when nothing matches.
     */
    async resolveVoice(nameOrId) {
        const query = String(nameOrId || '').trim();
        if (!query) {
            return { id: DEFAULT_VOICE_ID, name: null };
        }

        const voices = await this.listVoices();

        if (VOICE_ID_PATTERN.test(query)) {
            const byId = voices.find(v => v.id === query);
            if (byId) return { id: byId.id, name: byId.name };
            // IDs of voices not in the library (e.g. premade defaults) still
            // work with the TTS endpoint, so let them through unnamed.
            return { id: query, name: null };
        }

        const key = query.toLowerCase();
        const exact = voices.find(v => v.name.toLowerCase() === key);
        if (exact) return { id: exact.id, name: exact.name };

        // Prefix match on the base name before any " - description" suffix
        const prefix = voices.filter(v => {
            const base = v.name.toLowerCase().split(/\s+-\s+/)[0].trim();
            return base === key || v.name.toLowerCase().startsWith(key);
        });
        if (prefix.length === 1) {
            // Cache the alias so per-request resolution stays off the network
            this.voiceNameCache.set(key, prefix[0]);
            return { id: prefix[0].id, name: prefix[0].name };
        }
        if (prefix.length > 1) {
            throw new Error(`ElevenLabs voice "${nameOrId}" is ambiguous: ${prefix.map(v => v.name).join(', ')}`);
        }

        const available = voices.map(v => v.name).slice(0, 25).join(', ');
        throw new Error(`ElevenLabs voice "${nameOrId}" not found in your voice library. Available: ${available}`);
    }

    /**
     * Resolve to just the voice ID, using the name cache to avoid a network
     * round trip on every TTS request. IDs pass through as-is.
     */
    async resolveVoiceId(nameOrId) {
        if (!nameOrId || VOICE_ID_PATTERN.test(nameOrId)) {
            return nameOrId || DEFAULT_VOICE_ID;
        }
        const cached = this.voiceNameCache.get(String(nameOrId).trim().toLowerCase());
        if (cached) return cached.id;
        const { id } = await this.resolveVoice(nameOrId);
        return id;
    }

    async fetchStream(text) {
        // A stale/misspelled configured voice must not silence TTS entirely:
        // fall back to the default voice and keep speaking.
        let voiceId;
        try {
            voiceId = await this.resolveVoiceId(this.voiceId);
        } catch (error) {
            console.warn(`[TTS] Configured voice "${this.voiceId}" could not be resolved (${error.message}); falling back to the default voice`);
            voiceId = DEFAULT_VOICE_ID;
        }
        // MP3 streaming endpoint – available on all plans (PCM requires Pro+)
        const url =
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
            '?output_format=mp3_44100_128';
        const body = {
            text,
            model_id: this.modelId,
            voice_settings: { stability: 0.35, similarity_boost: 0.85 }
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': this.apiKey,
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
        return res; // full response with body stream
    }

    cleanup() {
        try { this.player.stop(); } catch {}
        this.activeResources.clear();
    }
}

module.exports = ElevenLabsTTSService;
