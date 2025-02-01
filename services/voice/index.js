const { AudioInputStream, AudioStreamFormat, AudioConfig } = require('microsoft-cognitiveservices-speech-sdk');
const { EventEmitter } = require('events');
const { EndBehaviorType } = require('@discordjs/voice');
const RecognitionService = require('./recognitionService');
const AudioPipeline = require('./audioPipeline');
const TTSService = require('./ttsService');
const ConnectionService = require('./connectionService');
const SessionManager = require('./sessionManager');
const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');

class VoiceService extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            ...config,
            // Ensure backward compatibility
            azure: {
                speech: {
                    key: config.azure?.speech?.key || config.azureSpeech?.key,
                    region: config.azure?.speech?.region || config.azureSpeech?.region,
                    language: config.azure?.speech?.language || config.azureSpeech?.language || 'en-US'
                },
                // ... other azure config
            }
        };
        this.isInitialized = false;

        try {
            // Initialize all services
            this.recognition = new RecognitionService(config, this);
            this.connection = new ConnectionService();
            this.tts = new TTSService(config);
            this.sessionManager = new SessionManager();
            
            // Start session monitoring with 5 minute timeout
            this.sessionManager.startSessionMonitoring(300000);

            // Set up event handlers
            this.setupEventHandlers();
            
            this.isInitialized = true;
            console.log('Voice service initialized successfully');
        } catch (error) {
            console.error('Failed to initialize voice service:', error);
            throw error;
        }
    }

    setupEventHandlers() {
        // Recognition events
        this.recognition.on('ttsResponse', async (response) => {
            try {
                const session = this.sessionManager.getSession(response.userId);
                if (session) {
                    await this.tts.textToSpeech(response.text, session.voiceChannel, session.connection);
                }
            } catch (error) {
                console.error('Error handling TTS response:', error);
                this.emit('ttsError', { userId: response.userId, error });
            }
        });

        this.recognition.on('recognitionError', async ({ userId, error }) => {
            console.error('Recognition error:', error);
            await this.handleError(userId, error);
        });

        this.recognition.on('noAudioWarning', ({ userId }) => {
            console.warn('No audio detected for user:', userId);
            this.emit('noAudioWarning', { userId });
        });

        // Connection events
        this.connection.on('connectionError', async ({ channelId, error }) => {
            console.error('Connection error:', error);
            const affectedSession = this.findSessionByChannel(channelId);
            if (affectedSession) {
                await this.handleError(affectedSession.userId, error);
            }
        });

        this.connection.on('connectionLost', async (channelId) => {
            const affectedSession = this.findSessionByChannel(channelId);
            if (affectedSession) {
                console.log('Connection lost, cleaning up session...');
                await this.sessionManager.cleanupSession(affectedSession.userId, {
                    recognition: this.recognition,
                    tts: this.tts,
                    connection: this.connection
                });
            }
        });

        // Session events
        this.sessionManager.on('sessionTimeout', async ({ userId }) => {
            console.log('Session timeout, stopping listening...');
            await this.stopListening(userId);
        });

        this.sessionManager.on('cleanupError', async ({ userId, error }) => {
            console.error('Session cleanup error:', error);
            this.emit('cleanupError', { userId, error });
        });

        // TTS events
        this.tts.on('ttsError', (error) => {
            console.error('TTS error:', error);
            this.emit('ttsError', { error });
        });

        // Forward recognition events
        this.recognition.on('recognized', (data) => this.emit('recognized', data));
        this.recognition.on('recognizing', (data) => this.emit('recognizing', data));
        this.recognition.on('error', (error) => this.emit('recognitionError', error));

        this.on('voiceStart', ({ userId, level }) => {
            console.log('Voice activity started:', {
                userId,
                level,
                timestamp: new Date().toISOString()
            });
            // Start recognition if not already started
            if (this.recognition) {
                this.recognition.startRecognition(userId);
            }
        });

        this.on('voiceEnd', ({ userId, duration }) => {
            console.log('Voice activity ended:', {
                userId,
                duration,
                timestamp: new Date().toISOString()
            });
            // Trigger recognition processing
            if (this.recognition) {
                this.recognition.processCurrentAudio(userId);
            }
        });
    }

    async startListening(voiceChannel, user, messageCallback, textChannel) {
        try {
            // Create voice connection with proper settings
            const connection = await joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            // Wait for ready state
            await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

            // Set up audio pipeline
            const audioPipeline = new AudioPipeline(this.config);
            await audioPipeline.setupVoiceConnection(connection, user.id);

            // Store session info
            this.sessionManager.addSession(user.id, {
                connection,
                audioPipeline,
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                messageCallback,
                textChannel,
                audioConfig: audioPipeline.createAudioConfig()
            });

            // Set up recognition with message callback
            await this.recognition.setupRecognizer(
                user.id, 
                audioPipeline.createAudioConfig(),
                messageCallback
            );

            return connection;
        } catch (error) {
            console.error('Failed to start listening:', {
                error: error.message,
                userId: user.id,
                timestamp: new Date().toISOString()
            });
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
        if (!this.isInitialized) {
            throw new Error('Voice service not initialized');
        }

        console.log('Stopping voice recognition for user:', userId);
        try {
            await this.sessionManager.cleanupSession(userId, {
                recognition: this.recognition,
                tts: this.tts,
                connection: this.connection
            });
            
            console.log('Successfully stopped listening for user:', userId);
            this.emit('listeningStop', { userId });
        } catch (error) {
            console.error('Error stopping voice recognition:', error);
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
                    await this.stopListening(session.userId);
                } catch (error) {
                    console.error('Error cleaning up session:', error);
                }
            }

            // Clean up TTS resources
            try {
                await this.tts.cleanup();
            } catch (error) {
                console.error('Error cleaning up TTS:', error);
            }

            this.isInitialized = false;
            console.log('Voice service cleanup completed');
        } catch (error) {
            console.error('Error during voice service cleanup:', error);
            throw error;
        }
    }
}

module.exports = VoiceService; 