const { Transform } = require('stream');
const { OpusEncoder } = require('@discordjs/opus');
const prism = require('prism-media');
const ffmpeg = require('ffmpeg-static');
const { EventEmitter } = require('events');

class AudioService extends EventEmitter {
    constructor() {
        super();
        console.log('FFmpeg path:', ffmpeg);
        
        // Initialize state tracking
        this.audioBuffers = new Map();
        this.processingStates = new Map();
        this.silenceStartTimes = new Map();
        this.lastVoiceActivities = new Map();
    }

    createAudioStream(userId) {
        const FRAME_SIZE = 960;
        const SAMPLE_RATE = 48000;
        const CHANNELS = 2;
        const TARGET_SAMPLE_RATE = 16000;
        const SILENCE_THRESHOLD = 500;  // Increased from 150 for better voice detection
        const MIN_VOICE_DURATION = 300; // Increased from 200ms
        const MAX_SILENCE_DURATION = 1000; // Reduced from 1500ms
        const MIN_PACKET_SIZE = 32;  // Increased from 16
        const MAX_SILENT_PACKETS = 25; // Reduced from 35
        const VOICE_THRESHOLD = -40;    // Less sensitive (was -35)
        const SILENCE_DURATION = 700;   // Longer silence duration (was 500)

        let consecutiveSilentPackets = 0;
        let isProcessing = false;
        let lastProcessedTime = Date.now();
        let voiceDetected = false;
        let voiceStartTime = null;
        let silenceStartTime = null;

        // Create PCM transformer with enhanced silence detection
        const pcmTransformer = new Transform({
            transform(chunk, encoding, callback) {
                try {
                    const currentTime = Date.now();
                    
                    // Log processing latency if significant
                    const processingLatency = currentTime - lastProcessedTime;
                    if (processingLatency > 100) {
                        console.warn('High audio processing latency:', {
                            latency: processingLatency,
                            timestamp: new Date().toISOString()
                        });
                    }
                    lastProcessedTime = currentTime;

                    if (!Buffer.isBuffer(chunk)) {
                        console.warn('Non-buffer chunk received:', {
                            type: typeof chunk,
                            timestamp: new Date().toISOString()
                        });
                        return callback();
                    }

                    if (chunk.length < MIN_PACKET_SIZE) {
                        console.debug('Small packet received:', {
                            size: chunk.length,
                            threshold: MIN_PACKET_SIZE,
                            timestamp: new Date().toISOString()
                        });
                        consecutiveSilentPackets++;
                        if (consecutiveSilentPackets >= MAX_SILENT_PACKETS) {
                            this.emit('maxSilenceReached');
                            consecutiveSilentPackets = 0;
                        }
                        return callback();
                    }

                    const audioStats = this.analyzeAudioChunk(chunk);
                    const isSilent = audioStats.average < SILENCE_THRESHOLD && audioStats.peak < SILENCE_THRESHOLD * 2;

                    if (!this.service.audioBuffers.has(userId)) {
                        this.service.audioBuffers.set(userId, Buffer.alloc(0));
                        this.service.processingStates.set(userId, false);
                        this.service.silenceStartTimes.set(userId, currentTime);
                        this.service.lastVoiceActivities.set(userId, currentTime);
                    }

                    const level = calculateAudioLevel(chunk);
                    
                    // Voice detection state machine
                    if (!voiceDetected && level > VOICE_THRESHOLD) {
                        voiceDetected = true;
                        voiceStartTime = Date.now();
                        silenceStartTime = null;
                        this.emit('voiceStart', { userId, level });
                    } else if (voiceDetected && level < SILENCE_THRESHOLD) {
                        if (!silenceStartTime) {
                            silenceStartTime = Date.now();
                        } else if (Date.now() - silenceStartTime > SILENCE_DURATION) {
                            voiceDetected = false;
                            this.emit('voiceEnd', { 
                                userId, 
                                duration: Date.now() - voiceStartTime 
                            });
                        }
                    } else if (voiceDetected) {
                        // Reset silence timer if we detect voice again
                        silenceStartTime = null;
                    }

                    // Always emit level for monitoring
                    this.emit('audioLevel', { userId, level });
                    
                    if (!isSilent) {
                        consecutiveSilentPackets = 0;
                        this.service.lastVoiceActivities.set(userId, currentTime);
                        
                        if (!isProcessing) {
                            isProcessing = true;
                            console.log('Voice activity detected:', {
                                stats: audioStats,
                                timestamp: new Date().toISOString()
                            });
                            this.emit('voiceActivityDetected');
                        }
                        
                        // Concatenate the chunk to the user's buffer
                        const currentBuffer = this.service.audioBuffers.get(userId);
                        this.service.audioBuffers.set(userId, Buffer.concat([currentBuffer, chunk]));
                    } else {
                        consecutiveSilentPackets++;
                        
                        if (isProcessing) {
                            const silenceDuration = currentTime - this.service.lastVoiceActivities.get(userId);
                            
                            if (silenceDuration > MAX_SILENCE_DURATION) {
                                const audioBuffer = this.service.audioBuffers.get(userId);
                                
                                if (audioBuffer.length > 0) {
                                    console.log('Processing accumulated audio:', {
                                        size: audioBuffer.length,
                                        duration: silenceDuration,
                                        timestamp: new Date().toISOString()
                                    });
                                    this.emit('audioComplete', audioBuffer);
                                    this.service.audioBuffers.set(userId, Buffer.alloc(0));
                                    isProcessing = false;
                                    this.emit('silenceDetected');
                                }
                            }
                        }

                        if (consecutiveSilentPackets >= MAX_SILENT_PACKETS) {
                            console.log('Maximum silence duration reached:', {
                                packets: consecutiveSilentPackets,
                                threshold: MAX_SILENT_PACKETS,
                                timestamp: new Date().toISOString()
                            });
                            this.emit('maxSilenceReached');
                            consecutiveSilentPackets = 0;
                        }
                    }
                    
                    callback(null, chunk);
                } catch (error) {
                    console.error('PCM Transform error:', {
                        error: error.message,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    callback(error);
                }
            }
        });

        // Add reference to service and methods
        pcmTransformer.service = this;
        
        // Add audio analysis method to pcmTransformer
        pcmTransformer.analyzeAudioChunk = function(chunk) {
            const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
            let sum = 0;
            let peak = 0;
            let rms = 0;
            
            for (let i = 0; i < samples.length; i++) {
                const absValue = Math.abs(samples[i]);
                sum += absValue;
                peak = Math.max(peak, absValue);
                rms += samples[i] * samples[i];
            }

            const average = sum / samples.length;
            rms = Math.sqrt(rms / samples.length);

            const stats = {
                average: Math.round(average),
                peak: Math.round(peak),
                rms: Math.round(rms),
                sampleCount: samples.length,
                duration: (samples.length / SAMPLE_RATE * 1000).toFixed(2) + 'ms'
            };

            if (peak > SILENCE_THRESHOLD || average > SILENCE_THRESHOLD / 2) {
                console.debug('Audio analysis:', {
                    ...stats,
                    timestamp: new Date().toISOString()
                });
            }

            return stats;
        };

        // Create Opus decoder with explicit error handling
        const opusDecoder = new prism.opus.Decoder({
            frameSize: FRAME_SIZE,
            channels: CHANNELS,
            rate: SAMPLE_RATE,
            samplesPerFrame: FRAME_SIZE
        });

        // Create resampler with enhanced configuration
        const resampler = new prism.FFmpeg({
            args: [
                '-hide_banner',
                '-loglevel', 'error',
                '-f', 's16le',           // Input format
                '-ar', '48000',          // Input sample rate
                '-ac', '2',              // Input channels
                '-i', 'pipe:0',          // Input from pipe
                '-f', 's16le',           // Output format (changed from wav)
                '-acodec', 'pcm_s16le',  // Output codec
                '-ar', '16000',          // Output sample rate
                '-ac', '1',              // Output channels (mono)
                '-b:a', '256k',          // Audio bitrate
                '-flags', '+bitexact',   // Ensure exact format
                '-fflags', '+bitexact',  // More exact format flags
                '-filter:a', [
                    'volume=1.5',        // Reduced volume boost
                    'pan=mono|c0=0.5*c0+0.5*c1',  // Proper stereo to mono downmix
                    'aresample=async=1000:min_comp=0.001:first_pts=0',  // More precise resampling
                    'highpass=f=100',     // Adjusted high-pass filter
                    'lowpass=f=8000',    // Adjusted low-pass filter
                    'apad=pad_dur=0.01',  // Increased padding
                    'dynaudnorm=p=0.99:m=50:s=5:g=10',  // Less aggressive normalization
                    'silencedetect=n=-35dB:d=0.5'  // More lenient silence detection
                ].join(','),
                'pipe:1'
            ]
        });

        // Set FFmpeg path and add enhanced error handling
        resampler.process.ffmpegPath = ffmpeg;
        
        // Add enhanced error handlers
        opusDecoder.on('error', this.handleStreamError('opusDecoder'));
        pcmTransformer.on('error', this.handleStreamError('pcmTransformer'));
        resampler.on('error', this.handleStreamError('resampler'));

        return {
            opusDecoder,
            pcmTransformer,
            resampler
        };
    }

    handleStreamError(streamName) {
        return (error) => {
            console.error(`${streamName} error:`, error);
            this.emit('streamError', { streamName, error });
        };
    }

    isValidWavHeader(data) {
        try {
            // Check minimum WAV header size
            if (data.length < 44) return false;
            
            // Check RIFF header
            if (data.toString('ascii', 0, 4) !== 'RIFF') return false;
            
            // Check WAVE format
            if (data.toString('ascii', 8, 12) !== 'WAVE') return false;
            
            // Check fmt chunk
            if (data.toString('ascii', 12, 16) !== 'fmt ') return false;
            
            // Get audio format (should be 1 for PCM)
            const audioFormat = data.readUInt16LE(20);
            
            // Get number of channels
            const numChannels = data.readUInt16LE(22);
            
            // Get sample rate
            const sampleRate = data.readUInt32LE(24);
            
            console.log('WAV header details:', {
                audioFormat,
                numChannels,
                sampleRate
            });
            
            return audioFormat === 1 && numChannels === 1 && sampleRate === 16000;
        } catch (error) {
            console.error('Error checking WAV header:', error);
            return false;
        }
    }

    cleanupUserAudio(userId) {
        this.audioBuffers.delete(userId);
        this.processingStates.delete(userId);
        this.silenceStartTimes.delete(userId);
        this.lastVoiceActivities.delete(userId);
    }
}

module.exports = AudioService; 