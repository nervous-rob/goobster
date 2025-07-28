const fetch = require('node-fetch');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const prism = require('prism-media');
const {
    createAudioResource,
    createAudioPlayer,
    StreamType,
    NoSubscriberBehavior
} = require('@discordjs/voice');
const path = require('path');
const fs = require('fs');

// Helper class similar to other TTS for buffer-stream conversion
class BufferToStream extends Readable {
    constructor(buffer) {
        super();
        this.buffer = buffer;
    }
    _read() {
        this.push(this.buffer);
        this.push(null);
    }
}

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
        this.voiceId = config.elevenlabs?.voiceId || 'Rachel'; // default female EN voice

        this.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
        });
        this.activeResources = new Set();
    }

    async textToSpeech(text, voiceChannel, connection) {
        if (this.disabled) return;
        try {
            const response = await this.fetchStream(text);
            // Input is MP3; decode & resample to 48 kHz stereo raw PCM for Discord
            const transcoder = new prism.FFmpeg({
                args: [
                    '-i', 'pipe:0',            // Input from stdin (mp3)
                    '-analyzeduration', '0',   // Faster start
                    '-loglevel', '0',
                    '-acodec', 'pcm_s16le',
                    '-f', 's16le',
                    '-ar', '48000',            // 48 kHz for Discord
                    '-ac', '2',                // Stereo
                    '-af', 'volume=1.5',
                ]
            });

            // Pipe ElevenLabs MP3 into FFmpeg
            response.body.pipe(transcoder);

            // Optional local debug: write raw PCM to file if DEBUG_PCM env is set
            if (process.env.DEBUG_PCM === '1') {
                try {
                    const dumpPath = 'eleven-debug.pcm';
                    const dumpStream = fs.createWriteStream(dumpPath);
                    transcoder.pipe(dumpStream);
                    dumpStream.on('finish', () => console.log('[DEBUG] PCM dump saved to', dumpPath));
                } catch {}
            }
            transcoder.stderr?.on('data', d => console.error('[FFMPEG]', d.toString()));
            transcoder.once('spawn', () => console.log('[FFMPEG] spawn OK'));
            transcoder.once('readable', () => console.log('[FFMPEG] ...info about read packets...'));
            transcoder.on('close', code => console.log('[FFMPEG] exited with code', code));

            // Explicitly mark the stream as raw PCM so discord.js skips container probing
            const resource = createAudioResource(transcoder, {
                inputType: StreamType.Raw,
                inlineVolume: true
            });
            this.activeResources.add(resource);

            // Ensure volume is at 100%
            resource.volume?.setVolume(1.0);

            await new Promise((res) => transcoder.once('readable', res)); // first packet in
            this.player.play(resource);
            connection.subscribe(this.player);
            console.log('ElevenLabs audio flowing…');
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
            console.log('Started ElevenLabs playback');
            });
        } catch (err) {
            console.error('ElevenLabs TTS error:', err);
        }
    }

    async fetchStream(text) {
        // Use MP3 streaming endpoint (works on all plans). We can add PCM later for Pro tiers.
        // 1. HTTP request – same URL pattern as the docs
        const url =
          `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream` +
          '?output_format=mp3_44100_128';              // <= safe on all tiers
        const body = {
            text,
            model_id: 'eleven_monolingual_v1',
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
            throw new Error(`ElevenLabs API error ${res.status}`);
        }
        return res; // return full response with body stream
    }
}

module.exports = ElevenLabsTTSService; 