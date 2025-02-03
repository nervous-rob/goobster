// TODO: Add proper handling for mix transitions
// TODO: Add proper handling for channel management
// TODO: Add proper handling for volume balancing
// TODO: Add proper handling for effect processing
// TODO: Add proper handling for mix synchronization
// TODO: Add proper handling for mix state
// TODO: Add proper handling for mix errors
// TODO: Add proper handling for mix cleanup
// TODO: Add proper handling for mix persistence
// TODO: Add proper handling for mix recovery

const { EventEmitter } = require('events');
const prism = require('prism-media');
const { Readable } = require('stream');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const path = require('path');
const fs = require('fs').promises;

class AudioMixerService extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
    }

    async mixNarrationWithBackground(narrationBuffer, backgroundPath, options = {}) {
        const {
            backgroundVolume = 0.15,  // 15% volume during narration
            fadeInDuration = 2,       // 2 seconds fade in
            fadeOutDuration = 2,      // 2 seconds fade out
            postNarrationVolume = 0.3, // 30% volume after narration
            crossfadeDuration = 1      // 1 second crossfade between segments
        } = options;

        try {
            // Create a temporary stream for the narration audio
            const narrationStream = new Readable();
            narrationStream.push(narrationBuffer);
            narrationStream.push(null);

            // Create FFmpeg command for mixing
            const transcoder = new prism.FFmpeg({
                args: [
                    // Input 1: Background music
                    '-i', backgroundPath,
                    // Input 2: Narration
                    '-i', '-',
                    // Output format settings
                    '-filter_complex', [
                        // Trim and loop background music to match narration length
                        `[0:a]aloop=loop=-1:size=2e8[bg]`,
                        // Apply volume automation to background music
                        `[bg]volume=${backgroundVolume},afade=t=in:st=0:d=${fadeInDuration}[bgfaded]`,
                        // Mix narration and background
                        `[bgfaded][1:a]amix=inputs=2:duration=first:weights=${backgroundVolume} ${1.0}[mixed]`,
                        // Final volume adjustments and fades
                        `[mixed]afade=t=in:st=0:d=${fadeInDuration},afade=t=out:st=${options.narrationDuration - fadeOutDuration}:d=${fadeOutDuration}[out]`
                    ].join(';'),
                    // Output format
                    '-map', '[out]',
                    '-acodec', 'pcm_s16le',
                    '-f', 's16le',
                    '-ar', '48000',
                    '-ac', '2',
                    'pipe:1'
                ]
            });

            // Handle transcoder errors
            transcoder.on('error', error => {
                console.error('Transcoder error:', error);
                this.emit('transcoderError', error);
            });

            // Create the mixed audio resource
            const resource = createAudioResource(narrationStream.pipe(transcoder), {
                inputType: StreamType.Raw,
                inlineVolume: true
            });

            if (!resource) {
                throw new Error('Failed to create mixed audio resource');
            }

            return resource;

        } catch (error) {
            console.error('Error mixing audio:', error);
            throw error;
        }
    }

    async createNarrationSegment(narrationBuffer, backgroundPath, options = {}) {
        try {
            // Get background music duration
            const musicDuration = await this.getAudioDuration(backgroundPath);
            
            // Create mixed audio resource
            const resource = await this.mixNarrationWithBackground(narrationBuffer, backgroundPath, {
                ...options,
                musicDuration
            });

            return resource;
        } catch (error) {
            console.error('Error creating narration segment:', error);
            throw error;
        }
    }

    async getAudioDuration(filePath) {
        return new Promise((resolve, reject) => {
            const ffmpeg = new prism.FFmpeg({
                args: [
                    '-i', filePath,
                    '-f', 'null',
                    '-'
                ]
            });

            let output = '';
            ffmpeg.on('error', (error) => {
                // FFmpeg outputs duration info to stderr
                const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}.\d{2})/);
                if (durationMatch) {
                    const [, hours, minutes, seconds] = durationMatch;
                    const duration = (parseFloat(hours) * 3600) +
                                   (parseFloat(minutes) * 60) +
                                   parseFloat(seconds);
                    resolve(duration);
                } else {
                    reject(new Error('Could not determine audio duration'));
                }
            });

            ffmpeg.on('data', (chunk) => {
                output += chunk.toString();
            });
        });
    }
}

module.exports = AudioMixerService; 