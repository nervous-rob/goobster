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
        
        if (!speechKey || !speechRegion) {
            throw new Error('Azure Speech credentials not found in config');
        }

        this.speechConfig = SpeechConfig.fromSubscription(
            speechKey,
            speechRegion
        );

        // Configure TTS settings
        this.speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
        this.speechConfig.outputFormat = OutputFormat.Raw16Khz16BitMonoPcm;

        // Initialize audio player with enhanced settings
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                maxMissedFrames: 50
            }
        });

        this.player.on('error', this.handlePlayerError.bind(this));
        this.activeResources = new Set();
    }

    async textToSpeech(text, voiceChannel, connection, backgroundMusicPath = null) {
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
            
            const ssml = `
                <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
                    <voice name="${this.speechConfig.speechSynthesisVoiceName}">
                        <prosody rate="0.9" pitch="+0%">
                            <break time="300ms"/>
                            ${text}
                            <break time="300ms"/>
                        </prosody>
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