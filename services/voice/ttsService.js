// TODO: Add proper handling for TTS timeouts
// TODO: Add proper handling for voice selection
// TODO: Add proper handling for pronunciation errors
// TODO: Add proper handling for SSML validation
// TODO: Add proper handling for speech rate
// TODO: Add proper handling for voice switching
// TODO: Add proper handling for TTS caching
// TODO: Add proper handling for TTS errors
// TODO: Add proper handling for language support
// TODO: Add proper handling for TTS state

const { 
    SpeechConfig, 
    SpeechSynthesizer,
    AudioConfig,
    OutputFormat
} = require('microsoft-cognitiveservices-speech-sdk');
const { 
    createAudioPlayer,
    createAudioResource,
    StreamType,
    NoSubscriberBehavior
} = require('@discordjs/voice');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const prism = require('prism-media');
const AudioMixerService = require('./audioMixerService');

// Helper class to convert ArrayBuffer to Stream
class BufferToStream extends Readable {
    constructor(buffer) {
        super();
        this.buffer = Buffer.from(buffer); // Ensure we have a proper Buffer
        this.position = 0;
    }

    _read(size) {
        const chunk = this.buffer.slice(this.position, this.position + size);
        this.position += chunk.length;
        
        if (this.position >= this.buffer.length) {
            this.push(chunk.length > 0 ? chunk : null);
        } else {
            this.push(chunk);
        }
    }
}

class TTSService extends EventEmitter {
    constructor(config) {
        super();
        // Support both config formats
        const speechKey = config.azure?.speech?.key || config.azureSpeech?.key;
        const speechRegion = config.azure?.speech?.region || config.azureSpeech?.region;
        
        console.log('TTS Service Config:', {
            hasAzureConfig: !!config.azure,
            hasSpeechConfig: !!config.azure?.speech,
            hasKey: !!speechKey,
            hasRegion: !!speechRegion,
            configKeys: Object.keys(config.azure?.speech || {})
        });
        
        if (!speechKey || !speechRegion) {
            console.log('TTS service initialized without Azure Speech credentials - TTS features will be disabled');
            this.disabled = true;
            return;
        }

        this.speechConfig = SpeechConfig.fromSubscription(
            speechKey,
            speechRegion
        );

        // -------- Enhanced quality & customization --------
        const voiceName = config.azure?.speech?.voiceName || "en-US-JennyNeural";
        const outputFormat = config.azure?.speech?.outputFormat || OutputFormat.Raw48Khz16BitMonoPcm;
        const defaultStyle = config.azure?.speech?.style || null;

        this.voiceName = voiceName;
        this.voiceStyle = defaultStyle;

        // Configure TTS settings
        this.speechConfig.speechSynthesisVoiceName = voiceName;
        this.speechConfig.outputFormat = outputFormat;

        // Initialize audio player with enhanced settings
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                maxMissedFrames: 50
            }
        });

        // Save config for downstream mixers
        this.config = config;

        this.player.on('error', this.handlePlayerError.bind(this));
        this.activeResources = new Set();
    }

    async textToSpeech(text, voiceChannel, connection, backgroundMusicPath = null) {
        if (this.disabled) {
            console.log('TTS is disabled - skipping text to speech conversion');
            return;
        }

        let synthesizer = null;
        let resource = null;
        let audioStream = null;
        let transcoder = null;

        try {
            console.log('Starting text-to-speech for:', text, {
                timestamp: new Date().toISOString()
            });
            
            synthesizer = new SpeechSynthesizer(this.speechConfig);
            console.log('Created synthesizer');
            
            // Build SSML with optional style and prosody tweaks for more natural delivery
            const styleTagOpen = this.voiceStyle ? `<mstts:express-as style="${this.voiceStyle}">` : "";
            const styleTagClose = this.voiceStyle ? `</mstts:express-as>` : "";

            const ssml = `
                <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="en-US">
                    <voice name="${this.voiceName}">
                        ${styleTagOpen}
                        <prosody rate="0.95" pitch="+2%">
                            ${text}
                        </prosody>
                        ${styleTagClose}
                    </voice>
                </speak>`;

            console.log('Generating speech...');
            const result = await new Promise((resolve, reject) => {
                synthesizer.speakSsmlAsync(
                    ssml,
                    result => {
                        console.log('Speech generated successfully');
                        resolve(result);
                    },
                    error => {
                        console.error('Speech generation failed:', error);
                        reject(error);
                    }
                );
            });

            if (backgroundMusicPath) {
                // If background music is specified, use AudioMixerService
                const audioMixer = new AudioMixerService(this.config);
                resource = await audioMixer.createNarrationSegment(
                    result.audioData,
                    backgroundMusicPath,
                    {
                        backgroundVolume: 0.15,
                        fadeInDuration: 2,
                        fadeOutDuration: 2,
                        postNarrationVolume: 0.3,
                        narrationDuration: result.audioDuration
                    }
                );
            } else {
                // Original audio processing without background music
                console.log('Creating audio stream...');
                audioStream = new BufferToStream(result.audioData);
                
                console.log('Creating FFmpeg transcoder...');
                transcoder = new prism.FFmpeg({
                    args: [
                        '-i', '-',
                        '-analyzeduration', '0',
                        '-loglevel', '0',
                        '-acodec', 'pcm_s16le',
                        '-f', 's16le',
                        '-ar', '48000',
                        '-ac', '2',
                        '-af', 'volume=1.5',  // Slight volume boost
                    ],
                });

                transcoder.on('error', error => {
                    console.error('Transcoder error:', error);
                    this.emit('transcoderError', error);
                });

                console.log('Creating audio resource...');
                resource = createAudioResource(audioStream.pipe(transcoder), {
                    inputType: StreamType.Raw,
                    inlineVolume: true
                });
            }

            if (!resource) {
                throw new Error('Failed to create audio resource');
            }

            this.activeResources.add(resource);
            resource.volume?.setVolume(1.0);
            
            console.log('Playing audio...');
            this.player.play(resource);
            connection.subscribe(this.player);

            return new Promise((resolve) => {
                const cleanup = () => {
                    this.player.removeListener('stateChange', handleStateChange);
                    this.player.removeListener('error', handleError);
                    
                    // Cleanup resources
                    if (synthesizer) {
                        try {
                            synthesizer.close();
                        } catch (error) {
                            console.warn('Error closing synthesizer:', error);
                        }
                    }
                    
                    if (resource) {
                        this.activeResources.delete(resource);
                    }
                    
                    if (transcoder) {
                        try {
                            transcoder.destroy();
                        } catch (error) {
                            console.warn('Error destroying transcoder:', error);
                        }
                    }
                    
                    console.log('TTS cleanup completed');
                };

                const handleStateChange = (oldState, newState) => {
                    console.log(`Player state changed from ${oldState.status} to ${newState.status}`, {
                        timestamp: new Date().toISOString()
                    });
                    if (newState.status === 'idle') {
                        cleanup();
                        resolve();
                    }
                };

                const handleError = error => {
                    console.error('Player error during playback:', error);
                    cleanup();
                    this.emit('playbackError', error);
                    resolve();
                };

                this.player.on('stateChange', handleStateChange);
                this.player.on('error', handleError);
            });

        } catch (error) {
            console.error('Error in textToSpeech:', error);
            
            // Cleanup on error
            if (synthesizer) {
                try {
                    synthesizer.close();
                } catch (cleanupError) {
                    console.warn('Error closing synthesizer:', cleanupError);
                }
            }
            
            if (resource) {
                this.activeResources.delete(resource);
            }
            
            if (transcoder) {
                try {
                    transcoder.destroy();
                } catch (cleanupError) {
                    console.warn('Error destroying transcoder:', cleanupError);
                }
            }
            
            this.emit('ttsError', error);
            throw error;
        }
    }

    handlePlayerError(error) {
        console.error('Audio player error:', error);
        this.emit('playerError', error);
    }

    cleanup() {
        // Cleanup all active resources
        for (const resource of this.activeResources) {
            try {
                resource.volume?.setVolume(0);
                resource.playStream?.destroy();
            } catch (error) {
                console.warn('Error cleaning up resource:', error);
            }
        }
        this.activeResources.clear();
        
        // Stop the player
        try {
            this.player.stop();
        } catch (error) {
            console.warn('Error stopping player:', error);
        }
    }
}

module.exports = TTSService; 