const { Transform } = require('stream');
const prism = require('prism-media');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');
const { EndBehaviorType } = require('@discordjs/voice');
const { AudioInputStream, AudioConfig, AudioStreamFormat } = require('microsoft-cognitiveservices-speech-sdk');
const { VoiceDetectionManager } = require('./VoiceDetectionManager');

// Constants for audio processing
const MIN_DB = -70;
const MIN_VALID_SAMPLES = 480;
const MIN_VALID_CHUNK_SIZE = 1920;
const TARGET_SAMPLE_RATE = 16000;

class AudioPipeline extends Transform {
    constructor(config = {}) {
        // Initialize Transform with object mode for flexibility
        super({ 
            objectMode: false,
            transform(chunk, encoding, callback) {
                try {
                    if (this._isDestroyed) {
                        callback();
                        return;
                    }

                    // Process audio for voice detection with user ID
                    if (this._currentUserId) {
                        const level = this.calculateAudioLevel(chunk);
                        if (level !== MIN_DB) {
                            this.voiceDetector.processAudioLevel(level, this._currentUserId);
                        }
                    }

                    // Ensure proper buffer format for Azure
                    let azureBuffer;
                    try {
                        if (Buffer.isBuffer(chunk)) {
                            azureBuffer = chunk;
                        } else if (chunk instanceof Uint8Array) {
                            azureBuffer = Buffer.from(chunk);
                        } else if (chunk?.buffer instanceof ArrayBuffer) {
                            azureBuffer = Buffer.from(chunk.buffer);
                        } else if (typeof chunk === 'object') {
                            console.debug('Converting non-standard chunk:', {
                                type: typeof chunk,
                                hasBuffer: 'buffer' in chunk,
                                hasArrayBuffer: chunk instanceof ArrayBuffer,
                                byteLength: chunk?.buffer?.byteLength
                            });
                            azureBuffer = Buffer.from(chunk.buffer || chunk);
                        } else {
                            console.warn('Invalid chunk type:', typeof chunk);
                            callback();
                            return;
                        }
                    } catch (error) {
                        console.error('Buffer conversion error:', {
                            error: error.message,
                            chunkType: typeof chunk,
                            timestamp: new Date().toISOString()
                        });
                        callback();
                        return;
                    }

                    // Verify audio format
                    if (!this.verifyAudioFormat(azureBuffer)) {
                        callback();
                        return;
                    }

                    // Forward audio to Azure with proper error handling
                    if (this._pushStream && !this._isDestroyed) {
                        try {
                            // Write to Azure push stream without waiting for drain
                            const writeSuccess = this._pushStream.write(azureBuffer);
                            
                            // Log audio stats periodically
                            if (this._currentUserId && Math.random() < 0.01) { // Log ~1% of chunks
                                const stats = {
                                    chunkSize: azureBuffer.length,
                                    sampleCount: azureBuffer.length / 2, // 16-bit samples
                                    level: this.calculateAudioLevel(azureBuffer),
                                    timestamp: new Date().toISOString(),
                                    writeSuccess
                                };
                                console.debug('Audio stats:', stats);
                            }
                            
                            // Pass the chunk through the pipeline
                            callback(null, chunk);
                        } catch (error) {
                            console.error('Error writing to Azure push stream:', {
                                error: error.message,
                                timestamp: new Date().toISOString()
                            });
                            // Continue the pipeline even if Azure write fails
                            callback(null, chunk);
                        }
                    } else {
                        // Pass through if no push stream
                        callback(null, chunk);
                    }
                } catch (error) {
                    console.error('Error in transform:', {
                        error: error.message,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    // Don't stop the pipeline on transform errors
                    callback(null, chunk);
                }
            }
        });
        
        // Add initialization state tracking
        this._initialized = false;
        this._initializationError = null;
        this._currentUserId = null;
        
        // Constants for audio processing
        this.SAMPLE_RATE = 48000;
        this.CHANNELS = 2;
        this.FRAME_SIZE = 960;
        this.TARGET_SAMPLE_RATE = TARGET_SAMPLE_RATE;
        this.MIN_DB = MIN_DB;
        
        // Add state tracking
        this._isDestroyed = false;
        this._pushStream = null;
        
        // Discord voice receive stream settings
        this.DISCORD_SAMPLE_RATE = 48000;
        this.DISCORD_STEREO = true;
        this.DISCORD_FRAME_SIZE = 960;
        
        // Azure Speech settings
        this.AZURE_SAMPLE_RATE = 16000;
        this.AZURE_CHANNELS = 1;
        
        // Initialize voice detection manager
        this.voiceDetector = new VoiceDetectionManager();
        this.setupVoiceDetection();
        
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
                    'pan=mono|c0=0.5*c0+0.5*c1',  // Proper stereo to mono conversion
                    'volume=2.0',                  // Initial volume boost
                    'highpass=f=100:width_type=q:width=0.707',   // More aggressive high-pass to reduce rumble
                    'lowpass=f=7500:width_type=q:width=0.707',   // Tighter low-pass for speech focus
                    'aresample=async=1000:min_hard_comp=0.1:first_pts=0',  // Responsive resampling
                    'asetrate=48000,aresample=16000:filter_size=256:phase_shift=128:cutoff=0.975', // High quality resampling
                    'dynaudnorm=p=0.95:m=10:s=5:g=15',  // Less aggressive normalization
                    'volume=2.0',                  // Moderate final boost
                    'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-50dB:detection=peak,aformat=sample_fmts=s16:channel_layouts=mono', // Add silence removal
                    'asetnsamples=n=1024:p=0'     // Consistent frame size
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
    }

    setupVoiceDetection() {
        // Forward voice detection events with user ID
        this.voiceDetector.on('voiceStart', (data) => this.emit('voiceStart', data));
        this.voiceDetector.on('voiceEnd', (data) => this.emit('voiceEnd', data));
        this.voiceDetector.on('voiceActivity', (data) => this.emit('voiceActivity', data));
        this.voiceDetector.on('silenceWarning', (data) => this.emit('silenceWarning', data));
        this.voiceDetector.on('silenceActivity', (data) => this.emit('silenceActivity', data));
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
            console.debug('Audio chunk is null or undefined');
            return false;
        }
        
        if (!Buffer.isBuffer(chunk)) {
            console.debug('Audio chunk is not a Buffer:', typeof chunk);
            return false;
        }
        
        if (chunk.length === 0) {
            console.debug('Empty audio chunk received');
            return false;
        }
        
        if (chunk.length < MIN_VALID_CHUNK_SIZE) {
            console.debug('Small chunk received:', {
                size: chunk.length,
                minSize: MIN_VALID_CHUNK_SIZE,
                timestamp: new Date().toISOString()
            });
            return true; // Still process small chunks
        }
        
        try {
            const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
            let validSamples = 0;
            let maxAbs = 0;
            let rmsValue = 0;
            
            for (let i = 0; i < samples.length; i++) {
                const absValue = Math.abs(samples[i]);
                maxAbs = Math.max(maxAbs, absValue);
                rmsValue += samples[i] * samples[i];
                
                if (absValue > 0 && absValue <= 32767) {
                    validSamples++;
                }
            }

            // Calculate RMS and dB values
            rmsValue = Math.sqrt(rmsValue / samples.length);
            const dbFS = 20 * Math.log10(Math.max(rmsValue, 1) / 32767);
            
            // More lenient validation
            if (validSamples < MIN_VALID_SAMPLES) {
                console.debug('Low valid sample count:', {
                    validSamples,
                    minRequired: MIN_VALID_SAMPLES,
                    timestamp: new Date().toISOString()
                });
                return true; // Still process chunks with few valid samples
            }
            
            return true;
        } catch (error) {
            console.error('Error verifying audio format:', {
                error: error.message,
                chunkLength: chunk?.length,
                timestamp: new Date().toISOString()
            });
            return false;
        }
    }

    calculateAudioLevel(chunk) {
        if (!chunk || chunk.length < MIN_VALID_CHUNK_SIZE) {
            return this.MIN_DB;
        }

        // Convert buffer to 16-bit PCM samples
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        
        if (samples.length < MIN_VALID_SAMPLES) {
            return this.MIN_DB;
        }

        // Calculate RMS value
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i];
        }
        const rms = Math.sqrt(sum / samples.length);
        
        // Convert to dB
        const db = 20 * Math.log10(rms / 32768);
        
        return Math.max(db, this.MIN_DB);
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
            this._currentUserId = userId;
            
            const receiver = connection.receiver;
            
            // Subscribe to the user's audio with proper settings
            const opusStream = receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.Manual
                },
                data: {
                    type: 'opus'
                }
            });

            console.log('Created opus stream for user:', userId);

            // Create opus decoder with proper settings
            this.opusDecoder = new prism.opus.Decoder({
                rate: 48000,
                channels: 2,
                frameSize: 960
            });

            // Set up error handlers with proper cleanup
            opusStream.on('error', (error) => {
                console.error('Opus stream error:', {
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                this.emit('error', { userId, error });
            });

            this.opusDecoder.on('error', (error) => {
                console.error('Opus decoder error:', {
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                this.emit('error', { userId, error });
            });

            // Create push stream for Azure if not exists
            if (!this._pushStream) {
                const format = AudioStreamFormat.getWaveFormatPCM(
                    this.TARGET_SAMPLE_RATE,
                    16,
                    1
                );
                this._pushStream = AudioInputStream.createPushStream(format);
                console.log('Created Azure push stream');
            }

            // Store streams for cleanup
            this._currentStreams = {
                opusStream,
                opusDecoder: this.opusDecoder,
                resampler: this.resampler
            };

            // Set appropriate max listeners
            opusStream.setMaxListeners(15);
            this.opusDecoder.setMaxListeners(15);
            this.setMaxListeners(15);

            // Add data monitoring
            let hasReceivedData = false;
            const dataTimeout = setTimeout(() => {
                if (!hasReceivedData && !this._isDestroyed) {
                    console.warn('No audio data received in first 5 seconds for user:', userId);
                }
            }, 5000);

            opusStream.on('data', () => {
                if (!hasReceivedData) {
                    hasReceivedData = true;
                    clearTimeout(dataTimeout);
                    console.log('Receiving audio data for user:', userId);
                }
            });

            // Connect the pipeline using pipeline()
            console.log('Connecting audio pipeline...');
            await pipeline(
                opusStream,
                this.opusDecoder,
                this.resampler,
                this
            ).catch(error => {
                if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                    console.log('Pipeline ended naturally');
                    return;
                }
                console.error('Pipeline error:', {
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                throw error;
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

    cleanup() {
        if (this._isDestroyed) return;
        
        console.log('Cleaning up audio pipeline');
        this._isDestroyed = true;

        // Clean up voice detection for current user
        if (this._currentUserId) {
            try {
                this.voiceDetector.cleanup(this._currentUserId);
            } catch (error) {
                console.error('Voice detector cleanup error:', error.message);
            }
            this._currentUserId = null;
        }

        // Clean up streams with proper error handling
        if (this._currentStreams) {
            const cleanupPromises = Object.entries(this._currentStreams).map(([type, stream]) => {
                return new Promise(resolve => {
                    try {
                        if (!stream) {
                            resolve();
                            return;
                        }

                        const cleanup = () => {
                            try {
                                stream.removeAllListeners();
                                resolve();
                            } catch (error) {
                                console.error(`Error removing listeners (${type}):`, error.message);
                                resolve();
                            }
                        };

                        // Add event listeners for cleanup completion
                        stream.once('close', cleanup);
                        stream.once('end', cleanup);
                        stream.once('error', cleanup);

                        // Set a timeout in case the events don't fire
                        const timeoutId = setTimeout(() => {
                            cleanup();
                        }, 1000);

                        // Attempt to end the stream gracefully
                        if (typeof stream.end === 'function' && !stream.destroyed) {
                            stream.end();
                        }
                        
                        // Then destroy it
                        if (typeof stream.destroy === 'function' && !stream.destroyed) {
                            stream.destroy();
                        }
                    } catch (error) {
                        console.error(`Stream cleanup error (${type}):`, error.message);
                        resolve();
                    }
                });
            });

            // Wait for all streams to be cleaned up
            Promise.all(cleanupPromises)
                .then(() => {
                    this._currentStreams = null;
                    console.log('All streams cleaned up successfully');
                })
                .catch(error => {
                    console.error('Error during stream cleanup:', error.message);
                    this._currentStreams = null;
                });
        }

        // Clean up Azure push stream
        if (this._pushStream) {
            try {
                // End any ongoing writes
                this._pushStream.end();
                // Close the stream
                this._pushStream.close();
            } catch (error) {
                console.error('Push stream cleanup error:', error.message);
            }
            this._pushStream = null;
        }

        this.emit('cleanup');
    }

    async setupPipeline() {
        try {
            const pushStream = AudioInputStream.createPushStream({
                endBehavior: EndBehaviorType.Manual
            });

            this.opusStream = new OpusStream();
            this.opusStream.on('error', (error) => {
                // Log but don't cleanup on EOF errors
                if (error.message.includes('EOF')) {
                    console.log('Opus stream EOF:', {
                        userId: this.userId,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                    return;
                }
                
                console.error('Opus stream error:', {
                    userId: this.userId,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                this.cleanup();
            });

            // Connect opus stream to push stream with error handling
            this.opusStream.pipe(pushStream).on('error', (error) => {
                console.error('Push stream error:', {
                    userId: this.userId,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                this.cleanup();
            });

            const audioConfig = AudioConfig.fromStreamInput(pushStream);
            this.audioConfig = audioConfig;

            console.log('Audio pipeline setup complete:', {
                userId: this.userId,
                timestamp: new Date().toISOString()
            });

            return audioConfig;
        } catch (error) {
            console.error('Failed to setup audio pipeline:', {
                userId: this.userId,
                error: error.message,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async writeAudioData(data) {
        try {
            if (!this.opusStream || this.opusStream.destroyed) {
                console.warn('Opus stream not available:', {
                    userId: this.userId,
                    timestamp: new Date().toISOString()
                });
                return;
            }

            await new Promise((resolve, reject) => {
                this.opusStream.write(data, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (error) {
            console.error('Failed to write audio data:', {
                userId: this.userId,
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            // Only cleanup on non-EOF errors
            if (!error.message.includes('EOF')) {
                this.cleanup();
            }
        }
    }
}

module.exports = AudioPipeline; 