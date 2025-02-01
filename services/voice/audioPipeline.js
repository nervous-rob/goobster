const { Transform } = require('stream');
const prism = require('prism-media');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');
const { EndBehaviorType } = require('@discordjs/voice');
const { AudioInputStream, AudioConfig, AudioStreamFormat } = require('microsoft-cognitiveservices-speech-sdk');

// Update these constants for more reliable detection
const VOICE_THRESHOLD = -40;    // Less sensitive (was -35)
const SILENCE_THRESHOLD = -45;  // Closer to voice threshold (was -50)
const VOICE_RELEASE_THRESHOLD = -42; // New threshold between voice and silence
const SILENCE_DURATION = 700;   // Longer silence duration (was 500)
const MIN_VOICE_DURATION = 250; // Minimum duration to consider as voice
const MIN_DB = -60;            // Minimum dB level

class AudioPipeline extends EventEmitter {
    constructor(config = {}) {
        super();
        
        // Add initialization state tracking
        this._initialized = false;
        this._initializationError = null;
        
        // Constants for audio processing
        this.SAMPLE_RATE = 48000;
        this.CHANNELS = 2;
        this.FRAME_SIZE = 960;
        this.TARGET_SAMPLE_RATE = 16000;
        this.MIN_DB = MIN_DB;
        this.VOICE_THRESHOLD = VOICE_THRESHOLD;
        this.SILENCE_THRESHOLD = SILENCE_THRESHOLD;
        
        // Add voice activity tracking with proper initialization
        this.lastVoiceActivity = Date.now();
        this.consecutiveSilentFrames = 0;
        this.isProcessingVoice = false;
        this.lastLoggedLevel = this.MIN_DB;
        this.silenceStartTime = null;
        this.lastLevel = this.MIN_DB;
        
        // Add debug counters
        this._voiceStartCount = 0;
        this._voiceEndCount = 0;
        this._sampleCount = 0;
        this._lastVoiceStartTime = null;

        // Add state tracking
        this._isDestroyed = false;
        this._pushStream = null;
        this._activeVoiceDetection = false;
        
        // Discord voice receive stream settings
        this.DISCORD_SAMPLE_RATE = 48000;
        this.DISCORD_STEREO = true;
        this.DISCORD_FRAME_SIZE = 960;
        
        // Azure Speech settings
        this.AZURE_SAMPLE_RATE = 16000;
        this.AZURE_CHANNELS = 1;
        
        // Initialize voice state
        this.voiceState = {
            isActive: false,
            startTime: null,
            silenceStartTime: null,
            lastLevel: -60
        };
        
        try {
            // Update config access with fallback values
            this.speechConfig = {
                key: config?.azure?.speech?.key || config?.azureSpeech?.key || '',
                region: config?.azure?.speech?.region || config?.azureSpeech?.region || '',
                language: config?.azure?.speech?.language || config?.azureSpeech?.language || 'en-US'
            };
            
            // Create opus decoder with explicit configuration
            this.opusDecoder = new prism.opus.Decoder({
                rate: this.SAMPLE_RATE,
                channels: this.CHANNELS,
                frameSize: this.FRAME_SIZE
            });

            // Validate opus decoder initialization
            if (!this.opusDecoder) {
                throw new Error('Failed to initialize Opus decoder');
            }

            // Store opus configuration for monitoring
            this.opusConfig = {
                rate: this.SAMPLE_RATE,
                channels: this.CHANNELS,
                frameSize: this.FRAME_SIZE
            };

            // Create resampler with enhanced configuration
            const resamplerArgs = [
                '-hide_banner',
                '-loglevel', 'warning',
                '-i', 'pipe:0',
                '-acodec', 'pcm_s16le',
                '-ac', '1',
                '-ar', this.TARGET_SAMPLE_RATE.toString(),
                '-f', 's16le',
                '-sample_fmt', 's16',
                '-flags', '+bitexact',
                '-fflags', '+nobuffer+fastseek',
                '-flush_packets', '1',
                '-af', [
                    'pan=mono|c0=0.5*c0+0.5*c1',
                    'volume=1.5',
                    'aresample=async=1:first_pts=0:min_comp=0.1:min_hard_comp=0.1',
                    `asetrate=${this.SAMPLE_RATE},aresample=${this.TARGET_SAMPLE_RATE}:filter_size=128:phase_shift=90:cutoff=1.0`,
                    'highpass=f=50:width_type=q:width=0.707',
                    'lowpass=f=7500:width_type=q:width=0.707',
                    'dynaudnorm=p=0.95:m=100:s=12:g=15',
                    'aformat=sample_fmts=s16:channel_layouts=mono',
                    'asetnsamples=n=320:p=0'
                ].join(','),
                'pipe:1'
            ];

            this.resampler = new prism.FFmpeg({ args: resamplerArgs });

            // Store resampler configuration for monitoring
            this.resamplerConfig = {
                inputFormat: 'opus',
                outputFormat: 'pcm_s16le',
                inputRate: this.SAMPLE_RATE,
                outputRate: this.TARGET_SAMPLE_RATE,
                inputChannels: this.CHANNELS,
                outputChannels: 1,
                args: resamplerArgs
            };

            // Validate resampler initialization
            if (!this.resampler) {
                throw new Error('Failed to initialize FFmpeg resampler');
            }

            // Add enhanced error handlers
            this.resampler.on('error', (error) => {
                if (error.code === 'EPIPE') {
                    console.log('FFmpeg resampler EPIPE - this is normal when stream ends');
                    return;
                }
                console.error('FFmpeg resampler error:', {
                    message: error.message,
                    code: error.code,
                    timestamp: new Date().toISOString(),
                    stack: error.stack,
                    config: this.resamplerConfig
                });
                this.emit('error', error);
            });

            this.resampler.once('spawn', () => {
                console.log('FFmpeg resampler started with configuration:', {
                    args: this.resampler.process.spawnargs,
                    pid: this.resampler.process.pid,
                    config: this.resamplerConfig,
                    timestamp: new Date().toISOString()
                });
            });

            // Add detailed audio format logging
            this.resampler.on('stderr', (data) => {
                const line = data.toString().trim();
                if (line) {
                    console.log('FFmpeg:', {
                        message: line,
                        config: this.resamplerConfig,
                        timestamp: new Date().toISOString()
                    });
                }
            });

            this._initialized = true;
        } catch (error) {
            this._initializationError = error;
            console.error('Failed to initialize audio pipeline:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }

        this._isDestroyed = false;
        this._pushStream = null;
        
        // Add voice activity detection with enhanced logging
        this.on('data', (chunk) => {
            if (!this._initialized) {
                console.error('Audio pipeline not properly initialized');
                return;
            }

            const level = this.calculateAudioLevel(chunk);
            
            if (level > VOICE_THRESHOLD) {
                this.consecutiveSilentFrames = 0;
                this.lastVoiceActivity = Date.now();
                this.emit('voiceActivity', { 
                    level,
                    config: {
                        opus: this.opusConfig,
                        resampler: this.resamplerConfig
                    }
                });
            } else if (level < SILENCE_THRESHOLD) {
                this.consecutiveSilentFrames++;
                
                const silenceDuration = Date.now() - this.lastVoiceActivity;
                if (silenceDuration > SILENCE_DURATION) {
                    this.emit('silenceDetected', {
                        duration: silenceDuration,
                        level,
                        config: {
                            opus: this.opusConfig,
                            resampler: this.resamplerConfig
                        }
                    });
                }
            }
        });
    }

    _transform(chunk, encoding, callback) {
        if (this._isDestroyed) {
            callback();
            return;
        }

        try {
            // Calculate audio level with smoothing
            const level = this.calculateAudioLevel(chunk);
            this._sampleCount++;
            
            // Smooth the level changes
            this.lastLevel = this.lastLevel * 0.8 + level * 0.2;
            
            // Voice activity detection with proper state management
            const hasVoice = this.lastLevel > this.VOICE_THRESHOLD;
            const isSilent = this.lastLevel < this.SILENCE_THRESHOLD;
            
            // Track voice state transitions with proper event emission
            if (hasVoice && !this.isProcessingVoice) {
                // Prevent rapid voice start triggers
                const now = Date.now();
                if (!this._lastVoiceStartTime || (now - this._lastVoiceStartTime) > 100) {
                    this._voiceStartCount++;
                    this.isProcessingVoice = true;
                    this.consecutiveSilentFrames = 0;
                    this.lastVoiceActivity = now;
                    this.silenceStartTime = null;
                    this._lastVoiceStartTime = now;
                    this._activeVoiceDetection = true;
                    
                    console.log('Voice activity detected:', {
                        level: this.lastLevel,
                        rawLevel: level,
                        threshold: this.VOICE_THRESHOLD,
                        timestamp: new Date().toISOString(),
                        voiceStartCount: this._voiceStartCount,
                        sampleCount: this._sampleCount
                    });
                    
                    this.emit('voiceStart', { 
                        level: this.lastLevel,
                        timestamp: new Date().toISOString()
                    });
                }
            } else if (hasVoice && this.isProcessingVoice) {
                // Reset silence tracking on any voice activity
                this.consecutiveSilentFrames = 0;
                this.lastVoiceActivity = Date.now();
                this.silenceStartTime = null;
            }
            
            // Handle silence detection
            if (isSilent && this.isProcessingVoice) {
                if (!this.silenceStartTime) {
                    this.silenceStartTime = Date.now();
                }
                
                const silenceDuration = Date.now() - this.silenceStartTime;
                
                // End voice processing after sufficient silence
                if (silenceDuration > SILENCE_DURATION) {
                    this._voiceEndCount++;
                    this.isProcessingVoice = false;
                    this._activeVoiceDetection = false;
                    
                    console.log('Voice activity ended:', {
                        level: this.lastLevel,
                        rawLevel: level,
                        silenceDuration,
                        consecutiveSilentFrames: this.consecutiveSilentFrames,
                        timestamp: new Date().toISOString(),
                        voiceEndCount: this._voiceEndCount,
                        sampleCount: this._sampleCount
                    });
                    
                    this.emit('voiceEnd', { 
                        level: this.lastLevel, 
                        silenceDuration,
                        timestamp: new Date().toISOString()
                    });
                }
            } else {
                // Reset silence tracking if we get any non-silent audio
                this.silenceStartTime = null;
            }

            // Enhanced logging with state information
            if (this.isProcessingVoice || Math.abs(level - this.lastLoggedLevel) > 5) {
                console.log('Audio processing:', {
                    level: this.lastLevel,
                    rawLevel: level,
                    chunkSize: chunk.length,
                    timestamp: new Date().toISOString(),
                    hasVoice,
                    isSilent,
                    isProcessingVoice: this.isProcessingVoice,
                    activeVoiceDetection: this._activeVoiceDetection,
                    silenceDuration: this.silenceStartTime ? Date.now() - this.silenceStartTime : 0,
                    voiceStartCount: this._voiceStartCount,
                    voiceEndCount: this._voiceEndCount,
                    sampleCount: this._sampleCount,
                    format: {
                        sampleRate: this.SAMPLE_RATE,
                        channels: this.CHANNELS,
                        frameSize: this.FRAME_SIZE
                    }
                });
                this.lastLoggedLevel = level;
            }

            // Write to push stream with proper error handling
            if (this._pushStream) {
                const canContinue = this._pushStream.write(chunk);
                if (!canContinue) {
                    this._pushStream.once('drain', () => callback());
                } else {
                    callback();
                }
            } else {
                callback(new Error('Push stream not initialized'));
            }
        } catch (error) {
            console.error('Error in _transform:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            callback(error);
        }
    }

    _flush(callback) {
        if (this._pushStream && !this._isDestroyed) {
            try {
                console.log('Flushing audio pipeline');
                this._pushStream.close();
                callback();
            } catch (error) {
                console.error('Error in _flush:', error.message);
                callback(error);
            }
        } else {
            callback();
        }
    }

    // Helper method to verify audio format
    verifyAudioFormat(chunk) {
        if (!chunk) {
            console.warn('Audio chunk is null or undefined');
            return false;
        }
        
        if (!Buffer.isBuffer(chunk)) {
            console.warn('Audio chunk is not a Buffer:', typeof chunk);
            return false;
        }
        
        if (chunk.length === 0) {
            console.warn('Empty audio chunk received');
            return false;
        }
        
        // Check if chunk length is multiple of 2 (16-bit samples)
        if (chunk.length % 2 !== 0) {
            console.warn('Invalid chunk length - not aligned to 16-bit samples:', chunk.length);
            return false;
        }
        
        // Verify minimum chunk size (at least 20ms of audio at 16kHz)
        const MIN_CHUNK_SIZE = 640; // 16000 Hz * 16 bits * 1 channel * 0.02 seconds / 8 bits per byte
        if (chunk.length < MIN_CHUNK_SIZE) {
            console.debug('Chunk size smaller than optimal:', {
                size: chunk.length,
                minSize: MIN_CHUNK_SIZE,
                timestamp: new Date().toISOString()
            });
            // Don't reject small chunks, just log them
        }
        
        try {
            // Verify sample values are within 16-bit range and check for all zeros
            const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
            let allZeros = true;
            let hasValidSamples = false;
            let maxAbsValue = 0;
            let rmsValue = 0;
            let sampleCount = 0;
            
            for (let i = 0; i < samples.length; i++) {
                const absValue = Math.abs(samples[i]);
                maxAbsValue = Math.max(maxAbsValue, absValue);
                rmsValue += samples[i] * samples[i];
                sampleCount++;
                
                if (samples[i] !== 0) {
                    allZeros = false;
                }
                if (absValue > 0 && absValue <= 32767) {
                    hasValidSamples = true;
                }
            }

            // Calculate RMS value
            rmsValue = Math.sqrt(rmsValue / sampleCount);
            
            // Calculate audio level in dB
            const audioLevel = this.calculateAudioLevel(chunk);
            
            // Log audio stats with enhanced metrics
            const stats = {
                size: chunk.length,
                sampleCount,
                maxAbsValue,
                rmsValue,
                audioLevel,
                hasValidSamples,
                isAllZeros: allZeros,
                timestamp: new Date().toISOString()
            };

            if (!hasValidSamples && !allZeros) {
                console.warn('No valid samples found in audio chunk:', stats);
                return false;
            }

            if (maxAbsValue > 32767) {
                console.warn('Sample values exceed 16-bit range:', stats);
                return false;
            }

            // Log stats only if we have actual audio content
            if (!allZeros) {
                console.debug('Audio chunk stats:', stats);
            }
            
            return true;
        } catch (error) {
            console.error('Error verifying audio format:', {
                error: error.message,
                chunkLength: chunk.length,
                timestamp: new Date().toISOString()
            });
            return false;
        }
    }

    async start(audioStream, pushStream) {
        if (!this._initialized) {
            throw new Error('Audio pipeline not properly initialized');
        }

        if (this._isDestroyed) {
            throw new Error('Cannot start destroyed pipeline');
        }

        if (!audioStream) {
            throw new Error('No audio stream provided');
        }

        if (!pushStream) {
            throw new Error('No push stream provided');
        }

        this._pushStream = pushStream;
        
        try {
            console.log('Starting audio pipeline with configuration:', {
                opus: this.opusConfig,
                resampler: this.resamplerConfig,
                initialized: this._initialized,
                timestamp: new Date().toISOString()
            });

            // Wait for the stream to be ready, but don't require audio data
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for audio stream setup'));
                }, 5000);

                // Check if the stream is readable
                if (audioStream.readable) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    const checkReadable = () => {
                        if (audioStream.readable) {
                            clearTimeout(timeout);
                            audioStream.removeListener('readable', checkReadable);
                            resolve();
                        }
                    };
                    audioStream.on('readable', checkReadable);
                }

                // Also resolve on first data (in case readable event isn't fired)
                const dataHandler = () => {
                    clearTimeout(timeout);
                    audioStream.removeListener('data', dataHandler);
                    resolve();
                };
                audioStream.on('data', dataHandler);

                // Handle stream errors
                audioStream.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

            console.log('Audio stream setup complete, starting pipeline');

            // Create transform stream for monitoring
            const monitor = new Transform({
                transform: (chunk, encoding, callback) => {
                    try {
                        // Enhanced buffer conversion with type checking
                        let buffer;
                        if (Buffer.isBuffer(chunk)) {
                            buffer = chunk;
                        } else if (chunk instanceof Uint8Array) {
                            buffer = Buffer.from(chunk);
                        } else if (chunk.buffer instanceof ArrayBuffer) {
                            buffer = Buffer.from(chunk.buffer);
                        } else if (typeof chunk === 'object') {
                            console.debug('Converting non-standard chunk:', {
                                type: typeof chunk,
                                hasBuffer: 'buffer' in chunk,
                                hasArrayBuffer: chunk instanceof ArrayBuffer,
                                byteLength: chunk.buffer?.byteLength
                            });
                            buffer = Buffer.from(chunk.buffer || chunk);
                        } else {
                            console.warn('Invalid chunk type:', typeof chunk);
                            return callback();
                        }
                        
                        // Skip empty chunks
                        if (!buffer || buffer.length === 0) {
                            console.debug('Skipping empty audio chunk');
                            return callback();
                        }

                        // Validate buffer alignment
                        if (buffer.length % 2 !== 0) {
                            console.warn('Misaligned audio chunk:', buffer.length);
                            return callback();
                        }

                        const level = this.calculateAudioLevel(buffer);
                        
                        // Enhanced debug logging
                        console.debug('Audio processing:', {
                            level,
                            chunkSize: buffer.length,
                            timestamp: new Date().toISOString(),
                            hasAudio: level > VOICE_THRESHOLD,
                            format: {
                                sampleRate: this.SAMPLE_RATE,
                                channels: this.CHANNELS,
                                frameSize: this.FRAME_SIZE
                            }
                        });
                        
                        if (level > VOICE_THRESHOLD) {
                            this.emit('voiceActivity', { 
                                level,
                                chunkSize: buffer.length,
                                timestamp: new Date().toISOString(),
                                format: {
                                    sampleRate: this.SAMPLE_RATE,
                                    channels: this.CHANNELS
                                }
                            });
                        } else if (level < SILENCE_THRESHOLD) {
                            this.emit('silence', { 
                                level,
                                chunkSize: buffer.length
                            });
                        }
                        
                        callback(null, buffer);
                    } catch (error) {
                        console.error('Error in monitor transform:', {
                            error: error.message,
                            stack: error.stack,
                            chunkType: typeof chunk,
                            hasBuffer: chunk && 'buffer' in chunk,
                            timestamp: new Date().toISOString()
                        });
                        callback(error);
                    }
                }
            });

            // Create a custom write function that handles backpressure
            const writeToStream = async (chunk) => {
                try {
                    if (!chunk) {
                        return;
                    }

                    // Ensure chunk is a proper buffer
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : chunk.buffer || chunk);
                    
                    if (buffer.length === 0) {
                        return;
                    }

                    if (this._pushStream && !this._isDestroyed) {
                        // Verify audio format before writing
                        if (!this.verifyAudioFormat(buffer)) {
                            return;
                        }

                        const canContinue = this._pushStream.write(buffer);
                        if (!canContinue) {
                            await new Promise(resolve => setTimeout(resolve, 10));
                        }
                    }
                } catch (error) {
                    console.error('Error in writeToStream:', {
                        error: error.message,
                        chunkType: typeof chunk,
                        isBuffer: Buffer.isBuffer(chunk),
                        hasBuffer: chunk && 'buffer' in chunk,
                        timestamp: new Date().toISOString()
                    });
                    this.emit('error', error);
                }
            };

            // Create a transform stream to handle FFmpeg output
            const ffmpegOutput = new Transform({
                transform(chunk, encoding, callback) {
                    // FFmpeg outputs raw audio data, so we can pass it directly
                    callback(null, chunk);
                }
            });

            // Set up the pipeline with proper error handling
            await pipeline(
                audioStream,
                this.opusDecoder,
                monitor,
                this.resampler,
                ffmpegOutput,
                async (chunk) => {
                    if (Buffer.isBuffer(chunk)) {
                        await writeToStream(chunk);
                    } else {
                        console.debug('Skipping non-buffer chunk:', {
                            type: typeof chunk,
                            hasBuffer: chunk && 'buffer' in chunk
                        });
                    }
                }
            );
        } catch (error) {
            console.error('Pipeline error:', error);
            this.emit('error', error);
            throw error;
        }
    }

    cleanup() {
        if (this._isDestroyed) {
            return;
        }

        this._isDestroyed = true;
        console.log('Cleaning up audio pipeline');

        try {
            if (this.opusDecoder) {
                this.opusDecoder.destroy();
            }
            if (this.resampler) {
                this.resampler.destroy();
            }
            if (this._pushStream) {
                this._pushStream.close();
                this._pushStream = null;
            }
        } catch (error) {
            console.error('Error during cleanup:', error.message);
        }
    }

    destroy(error) {
        this.cleanup();
        super.destroy(error);
    }

    // Add validation helper
    validateAudioValue(value, context) {
        if (isNaN(value)) {
            const error = new Error(`Invalid audio value (NaN) detected in ${context}`);
            error.details = {
                value,
                context,
                timestamp: new Date().toISOString(),
                stack: new Error().stack
            };
            throw error;
        }
        return value;
    }

    calculateAudioLevel(chunk) {
        if (!chunk || chunk.length === 0) {
            return this.MIN_DB;
        }
        
        try {
            // For Opus packets, we expect chunks of 3840 bytes (960 samples * 2 channels * 2 bytes)
            // We need to process these as 16-bit PCM samples
            const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
            
            let sumSquares = 0;
            let maxAbs = 0;
            let validSamples = 0;
            const maxPossibleValue = 32767; // Max value for 16-bit audio

            // Process samples in stereo pairs
            for (let i = 0; i < samples.length; i += 2) {
                // Get left and right channel samples
                const left = samples[i];
                const right = samples[i + 1];
                
                // Skip invalid samples
                if (isNaN(left) || !isFinite(left) || isNaN(right) || !isFinite(right)) {
                    continue;
                }

                // Mix stereo to mono and process
                const mono = (left + right) / 2;
                const abs = Math.abs(mono);
                
                if (abs <= maxPossibleValue) {
                    maxAbs = Math.max(maxAbs, abs);
                    sumSquares += mono * mono;
                    validSamples++;
                }
            }

            // For silence or no valid samples, return minimum level
            if (validSamples < 10 || maxAbs === 0) {
                return this.MIN_DB;
            }

            // Calculate RMS (Root Mean Square)
            const rms = Math.sqrt(sumSquares / validSamples);
            
            // Use peak normalization with RMS for better dynamics
            const amplitude = Math.max(rms, maxAbs / Math.sqrt(2));
            
            // Ensure non-zero amplitude with proper scaling
            const minAmplitude = maxPossibleValue / 1000000; // -120 dB minimum
            const safeAmplitude = Math.max(amplitude, minAmplitude);
            
            // Calculate dB with bounds checking
            let dbFS = 20 * Math.log10(safeAmplitude / maxPossibleValue);
            
            if (isNaN(dbFS) || !isFinite(dbFS)) {
                return this.MIN_DB;
            }
            
            // Clamp the result between MIN_DB and 0
            return Math.max(Math.min(dbFS, 0), this.MIN_DB);

        } catch (error) {
            console.error('Audio level calculation error:', {
                error: error.message,
                chunkType: typeof chunk,
                chunkLength: chunk?.length,
                stack: error.stack
            });
            return this.MIN_DB;
        }
    }

    // Create a transform stream for voice detection
    createVoiceDetectionTransform() {
        let lastVoiceTime = Date.now();
        let isCurrentlyVoice = false;
        let voiceStartTime = null;
        let lastLevel = MIN_DB;
        let lastActivityTime = Date.now();

        return new Transform({
            transform: async (chunk, encoding, callback) => {
                try {
                    // Calculate audio level
                    const level = this.calculateAudioLevel(chunk);
                    lastLevel = level;
                    
                    // Voice activity detection logic with hysteresis
                    const now = Date.now();
                    
                    // Emit activity events on regular intervals when audio is detected
                    if (level > SILENCE_THRESHOLD && (now - lastActivityTime) > 1000) {
                        this.emit('activity');
                        lastActivityTime = now;
                    }

                    // Voice detection logic
                    if (level > VOICE_THRESHOLD || (isCurrentlyVoice && level > VOICE_RELEASE_THRESHOLD)) {
                        lastVoiceTime = now;
                        if (!isCurrentlyVoice) {
                            voiceStartTime = now;
                            isCurrentlyVoice = true;
                            this.emit('voiceStart', { timestamp: now, level });
                        }
                    } else if (level < SILENCE_THRESHOLD) {
                        if (isCurrentlyVoice && (now - lastVoiceTime) > SILENCE_DURATION) {
                            isCurrentlyVoice = false;
                            if (voiceStartTime && (now - voiceStartTime) > MIN_VOICE_DURATION) {
                                this.emit('voiceEnd', { 
                                    timestamp: now,
                                    duration: now - voiceStartTime 
                                });
                            }
                            voiceStartTime = null;
                        }
                    }
                    
                    // Always emit audio level for monitoring
                    this.emit('audioLevel', { level, timestamp: now });
                    
                    // Write to push stream with direct write
                    if (this._pushStream) {
                        try {
                            // Azure PushStream only has write() method
                            this._pushStream.write(chunk);
                        } catch (error) {
                            console.error('Error writing to Azure push stream:', {
                                error: error.message,
                                timestamp: new Date().toISOString()
                            });
                            // Don't throw here, just log the error and continue
                        }
                    }
                    
                    // Pass the chunk through
                    callback(null, chunk);
                } catch (error) {
                    console.error('Error in voice detection transform:', {
                        error: error.message,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    callback(error);
                }
            }
        });
    }

    // Create audio configuration for Azure Speech SDK
    createAudioConfig() {
        try {
            if (!this._pushStream) {
                // Create push stream with proper format for Azure Speech
                const format = AudioStreamFormat.getWaveFormatPCM(
                    this.TARGET_SAMPLE_RATE, // 16kHz
                    16,  // 16 bits
                    1    // mono
                );
                this._pushStream = AudioInputStream.createPushStream(format);
                
                console.log('Created Azure push stream with format:', {
                    sampleRate: this.TARGET_SAMPLE_RATE,
                    bitsPerSample: 16,
                    channels: 1,
                    timestamp: new Date().toISOString()
                });
            }

            return AudioConfig.fromStreamInput(this._pushStream);
        } catch (error) {
            console.error('Error creating audio config:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    // Add proper Discord voice subscription
    async setupVoiceConnection(connection, userId) {
        try {
            console.log('Setting up voice connection for user:', userId);
            const receiver = connection.receiver;
            
            // Subscribe to the user's audio with proper settings
            const opusStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.AfterSilence,
                    duration: 100
                }
            });

            console.log('Created opus stream for user:', userId);

            // Create opus decoder with proper settings
            this.opusDecoder = new prism.opus.Decoder({
                rate: 48000,  // Discord uses 48kHz
                channels: 2,  // Discord sends stereo
                frameSize: 960 // Standard Discord frame size
            });

            console.log('Created opus decoder');

            // Create voice detection transform
            const voiceDetectionTransform = this.createVoiceDetectionTransform();
            console.log('Created voice detection transform');

            // Set up error handlers before pipeline
            opusStream.on('error', (error) => {
                console.error('Opus stream error:', error);
                this.emit('error', error);
            });

            this.opusDecoder.on('error', (error) => {
                console.error('Opus decoder error:', error);
                this.emit('error', error);
            });

            voiceDetectionTransform.on('error', (error) => {
                console.error('Voice detection error:', error);
                this.emit('error', error);
            });

            // Create push stream for Azure if not exists
            if (!this._pushStream) {
                this._pushStream = AudioInputStream.createPushStream();
                console.log('Created Azure push stream');
            }

            // Store streams for cleanup
            this._currentStreams = {
                opusStream,
                opusDecoder: this.opusDecoder,
                voiceDetectionTransform
            };

            // Set up the pipeline with proper event handling
            voiceDetectionTransform.on('data', (chunk) => {
                try {
                    if (this._pushStream) {
                        this._pushStream.write(chunk);
                    }
                } catch (error) {
                    console.error('Error writing to push stream:', error);
                }
            });

            // Debug logging for voice activity
            voiceDetectionTransform.on('voiceStart', ({ timestamp, level }) => {
                console.log('Voice activity started:', { userId, level, timestamp });
            });

            voiceDetectionTransform.on('voiceEnd', ({ timestamp, duration }) => {
                console.log('Voice activity ended:', { userId, duration, timestamp });
            });

            // Connect the pipeline
            console.log('Connecting audio pipeline...');
            opusStream
                .pipe(this.opusDecoder)
                .pipe(voiceDetectionTransform);

            // Verify stream is receiving data
            let dataReceived = false;
            const dataCheckTimeout = setTimeout(() => {
                if (!dataReceived) {
                    console.warn('No audio data received in first 5 seconds for user:', userId);
                }
            }, 5000);

            opusStream.once('data', () => {
                dataReceived = true;
                console.log('Receiving audio data for user:', userId);
                clearTimeout(dataCheckTimeout);
            });

            console.log('Audio pipeline setup complete for user:', userId);
            return true;

        } catch (error) {
            console.error('Error setting up voice connection:', {
                error: error.message,
                stack: error.stack,
                userId
            });
            throw error;
        }
    }

    // Cleanup method
    destroy() {
        try {
            if (this._currentStreams) {
                const { opusStream, opusDecoder, voiceDetectionTransform } = this._currentStreams;
                
                // Close the Azure push stream if it exists
                if (this._pushStream) {
                    try {
                        // Azure PushStream only has close()
                        this._pushStream.close();
                        this._pushStream = null;
                    } catch (error) {
                        console.warn('Error closing Azure push stream:', error);
                    }
                }

                // Properly end all streams in sequence
                const cleanupPromise = new Promise((resolve) => {
                    opusStream?.once('end', () => {
                        opusDecoder?.once('end', () => {
                            voiceDetectionTransform?.once('end', resolve);
                            voiceDetectionTransform?.end();
                        });
                        opusDecoder?.end();
                    });
                    opusStream?.end();
                });

                // Set a timeout for cleanup
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Stream cleanup timeout')), 5000);
                });

                // Wait for cleanup or timeout
                Promise.race([cleanupPromise, timeoutPromise])
                    .catch(error => {
                        console.warn('Stream cleanup error:', error);
                        // Force destroy on timeout
                        opusStream?.destroy();
                        opusDecoder?.destroy();
                        voiceDetectionTransform?.destroy();
                    })
                    .finally(() => {
                        this._currentStreams = null;
                        this.emit('destroyed');
                    });
            }
        } catch (error) {
            console.error('Error during audio pipeline cleanup:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = AudioPipeline; 