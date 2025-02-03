const { AudioInputStream, AudioStreamFormat, AudioConfig } = require('microsoft-cognitiveservices-speech-sdk');
const { EventEmitter } = require('events');
const { EndBehaviorType } = require('@discordjs/voice');
const RecognitionService = require('./recognitionService');
const AudioPipeline = require('./audioPipeline');
const TTSService = require('./ttsService');
const ConnectionService = require('./connectionService');
const SessionManager = require('./sessionManager');
const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const MusicService = require('./musicService');
const AmbientService = require('./ambientService');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { CancellationReason } = require('microsoft-cognitiveservices-speech-sdk');

class VoiceService extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.connections = new Map();
        this.audioPipeline = null;
        this.recognition = null;
        this.sessionManager = null;
        this.connectionService = null;
        this.tts = null;
        this.musicService = null;
        this.ambientService = null;
        this._isInitialized = false;
    }

    async initialize() {
        if (this._isInitialized) return;

        try {
            // Initialize core services
            this.audioPipeline = new AudioPipeline();
            this.recognition = new RecognitionService(this.config);
            this.sessionManager = new SessionManager(this.config);
            this.connectionService = new ConnectionService();
            this.tts = new TTSService(this.config);
            
            // Initialize optional services if configured
            if (this.config.replicate?.apiKey) {
                this.musicService = new MusicService(this.config);
                this.ambientService = new AmbientService(this.config);
            }
            
            // Start session monitoring with 5 minute timeout
            this.sessionManager.startSessionMonitoring(300000);
            
            // Set up event handlers
            this.setupEventHandlers();
            
            this._isInitialized = true;
            console.log('Voice service initialized successfully');
            
        } catch (error) {
            console.error('Failed to initialize voice service:', error);
            throw error;
        }
    }

    setupEventHandlers() {
        if (!this.audioPipeline || !this.recognition) {
            throw new Error('Services not initialized');
        }

        // Voice activity events
        this.audioPipeline.on('voiceStart', async ({ userId, level }) => {
            try {
                console.log('Voice activity started:', { userId, level });
                await this.recognition.handleVoiceStart(userId);
                this.emit('voiceActivity', { 
                    userId, 
                    level, 
                    type: 'start',
                    timestamp: Date.now()
                });
            } catch (error) {
                console.error('Error handling voice start:', error);
                this.emit('error', { userId, error, type: 'voiceStart' });
            }
        });

        this.audioPipeline.on('voiceEnd', async ({ userId, duration, level }) => {
            try {
                console.log('Voice activity ended:', { userId, duration });
                await this.recognition.handleVoiceEnd(userId);
                this.emit('voiceActivity', { 
                    userId, 
                    duration, 
                    level,
                    type: 'end',
                    timestamp: Date.now()
                });
            } catch (error) {
                console.error('Error handling voice end:', error);
                this.emit('error', { userId, error, type: 'voiceEnd' });
            }
        });

        this.audioPipeline.on('voiceActivity', ({ userId, level, duration }) => {
            this.emit('voiceActivity', { 
                userId, 
                level, 
                duration,
                type: 'ongoing',
                timestamp: Date.now()
            });
        });

        this.audioPipeline.on('silenceWarning', ({ userId, duration }) => {
            console.warn('Extended silence detected:', { userId, duration });
            this.emit('silenceWarning', { 
                userId, 
                duration,
                timestamp: Date.now()
            });
        });

        this.audioPipeline.on('silenceActivity', ({ userId, level, duration }) => {
            this.emit('silenceActivity', { 
                userId, 
                level, 
                duration,
                timestamp: Date.now()
            });
        });

        // Recognition events
        this.recognition.on('speechRecognized', ({ userId, text, confidence }) => {
            if (text && confidence > 0.5) {
                console.log('Speech recognized:', { userId, text, confidence });
                this.emit('messageReceived', { 
                    userId, 
                    text, 
                    confidence,
                    timestamp: Date.now()
                });
            }
        });

        this.recognition.on('recognitionCanceled', async ({ userId, reason, errorDetails }) => {
            console.log('Recognition canceled:', { 
                userId, 
                reason, 
                errorDetails,
                isFatal: reason === CancellationReason.Error,
                timestamp: new Date().toISOString()
            });

            // Let the recognition service handle the cancellation
            try {
                await this.recognition.handleRecognitionCanceled(userId, reason, errorDetails);
            } catch (error) {
                console.error('Error handling recognition cancellation:', {
                    userId,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                
                // Only emit error and cleanup for fatal errors
                if (reason === CancellationReason.Error) {
                    this.emit('recognitionError', { 
                        userId, 
                        error: errorDetails || error.message,
                        reason,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Try to recover the session
                    try {
                        await this.handleError(userId, error);
                    } catch (recoveryError) {
                        console.error('Failed to recover from recognition error:', {
                            userId,
                            error: recoveryError.message,
                            timestamp: new Date().toISOString()
                        });
                        await this.stopListening(userId);
                    }
                }
            }
        });

        this.recognition.on('error', ({ userId, error, type }) => {
            console.error('Recognition error:', { userId, error, type });
            this.emit('error', { 
                userId, 
                error, 
                type,
                timestamp: Date.now()
            });
        });

        // Pipeline cleanup
        this.audioPipeline.on('cleanup', () => {
            console.log('Audio pipeline cleaned up');
        });
    }

    async startListening(channel, userId) {
        try {
            // Join voice channel
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false // Ensure we're not muted
            });

            // Wait for connection to be ready
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                console.log('Voice connection ready:', {
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Failed to establish voice connection:', error);
                connection.destroy();
                throw error;
            }

            // Create audio pipeline
            const audioConfig = await this.audioPipeline.createAudioConfig();
            
            // Setup recognizer
            await this.recognition.setupRecognizer(userId, audioConfig);

            // Store session first to ensure proper cleanup
            this.sessionManager.addSession(userId, {
                connection,
                audioConfig,
                channel,
                audioPipeline: this.audioPipeline
            });

            // Setup voice connection last to ensure everything is ready
            await this.audioPipeline.setupVoiceConnection(connection, userId);

            // Set up connection state monitoring
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                } catch (error) {
                    console.error('Failed to reconnect:', error);
                    await this.handleError(userId, error);
                }
            });

            connection.on(VoiceConnectionStatus.Destroyed, async () => {
                console.log('Voice connection destroyed:', {
                    userId,
                    channelId: channel.id,
                    timestamp: new Date().toISOString()
                });
                await this.stopListening(userId);
            });

            // Add connection error handler
            connection.on('error', async (error) => {
                console.error('Voice connection error:', {
                    error: error.message,
                    userId,
                    channelId: channel.id,
                    timestamp: new Date().toISOString()
                });
                await this.handleError(userId, error);
            });

            console.log('Voice listening started:', {
                channelId: channel.id,
                guildId: channel.guild.id,
                userId
            });

            return connection;
        } catch (error) {
            console.error('Failed to start listening:', error);
            // Ensure cleanup on error
            try {
                await this.stopListening(userId);
            } catch (cleanupError) {
                console.error('Error during cleanup after failed start:', cleanupError);
            }
            throw error;
        }
    }

    // Helper method to calculate audio level in dB
    calculateAudioLevel(chunk) {
        if (!Buffer.isBuffer(chunk)) return -100;
        
        const samples = new Int16Array(chunk.buffer);
        let sum = 0;
        let peak = 0;
        
        for (let i = 0; i < samples.length; i++) {
            const absValue = Math.abs(samples[i]);
            sum += absValue;
            peak = Math.max(peak, absValue);
        }
        
        const average = sum / samples.length;
        // Convert to dB, using 32768 (2^15) as reference for 16-bit audio
        return average > 0 ? 20 * Math.log10(average / 32768) : -100;
    }

    async handleConnectionError(userId, error) {
        const session = this.sessionManager.getSession(userId);
        if (session && session.interaction) {
            try {
                await session.interaction.followUp({
                    content: 'Voice connection lost. Please try again.',
                    ephemeral: true
                });
            } catch (followUpError) {
                console.error('Error sending connection error followUp:', followUpError);
            }
        }
        await this.stopListening(userId);
    }

    async stopListening(userId) {
        if (!this._isInitialized) {
            throw new Error('Voice service not initialized');
        }

        if (!userId) {
            console.warn('Attempted to stop listening without userId');
            return;
        }

        console.log('Stopping voice recognition for user:', userId);
        try {
            // Get session before cleanup
            const session = this.sessionManager.getSession(userId);
            if (!session) {
                console.warn('No session found for user:', userId);
                return;
            }

            // Stop recognition first
            if (this.recognition) {
                await this.recognition.cleanup(userId);
            }

            // Then clean up the session
            await this.sessionManager.cleanupSession(userId, {
                recognition: this.recognition,
                tts: this.tts,
                connection: session.connection
            });
            
            console.log('Successfully stopped listening for user:', userId);
            this.emit('listeningStop', { userId });
        } catch (error) {
            console.error('Error stopping voice recognition:', {
                userId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            this.emit('stopError', { userId, error });
            throw error;
        }
    }

    async handleError(userId, error) {
        console.error('Handling error for user:', userId, error);
        try {
            // First attempt to recover the recognition
            if (error.name === 'RecognitionError' || error.errorDetails?.includes('recognition')) {
                try {
                    await this.recognition.handleRecognitionError(userId);
                    console.log('Successfully recovered from recognition error');
                    return;
                } catch (recoveryError) {
                    console.error('Failed to recover from recognition error:', recoveryError);
                }
            }

            // If recovery failed or it's a different type of error, clean up the session
            const session = this.sessionManager.getSession(userId);
            if (session) {
                let cleanupRetries = 0;
                const maxCleanupRetries = 3;
                
                while (cleanupRetries < maxCleanupRetries) {
                    try {
                        await this.sessionManager.cleanupSession(userId, {
                            recognition: this.recognition,
                            audio: this.audio,
                            tts: this.tts,
                            connection: this.connection
                        });
                        break;
                    } catch (cleanupError) {
                        cleanupRetries++;
                        console.error(`Cleanup attempt ${cleanupRetries} failed:`, cleanupError);
                        if (cleanupRetries < maxCleanupRetries) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                }
            }

            // Emit error event for external handling
            this.emit('voiceError', { userId, error });
        } catch (handlingError) {
            console.error('Error during error handling:', handlingError);
            // Attempt force cleanup as last resort
            try {
                await this.sessionManager.removeSession(userId);
            } catch (finalError) {
                console.error('Final cleanup attempt failed:', finalError);
            }
        }
    }

    findSessionByChannel(channelId) {
        const sessions = this.sessionManager.getActiveSessions();
        return sessions.find(session => session.channelId === channelId);
    }

    findSessionByStream(streamName) {
        const sessions = this.sessionManager.getActiveSessions();
        return sessions.find(session => {
            const sessionStreams = session.pipeline?.streams || [];
            return sessionStreams.some(stream => stream.name === streamName);
        });
    }

    async cleanup() {
        console.log('Starting voice service cleanup...');
        try {
            // Get all active sessions
            const sessions = this.sessionManager.getActiveSessions();
            
            // Clean up each session
            for (const session of sessions) {
                try {
                    console.log('Cleaning up session for user:', session.userId);
                    await this.stopListening(session.userId);
                } catch (error) {
                    console.error('Error cleaning up session:', {
                        userId: session.userId,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            
            console.log('Voice service cleanup completed');
        } catch (error) {
            console.error('Error during voice service cleanup:', error);
        }
    }
}

module.exports = VoiceService; 