const { 
    SpeechConfig, 
    SpeechRecognizer,
    ResultReason,
    AudioConfig,
    CancellationReason,
    CancellationErrorCode,
    OutputFormat
} = require('microsoft-cognitiveservices-speech-sdk');
const { EventEmitter } = require('events');

class RecognitionService extends EventEmitter {
    constructor(config, parent) {
        super();
        // Check for both legacy and new config formats
        const speechKey = config.azure?.speech?.key || config.azureSpeech?.key;
        const speechRegion = config.azure?.speech?.region || config.azureSpeech?.region;
        
        if (!speechKey || !speechRegion) {
            throw new Error('Azure Speech credentials not found in config');
        }

        // Update key format validation to be less strict
        const key = speechKey;
        // Remove the length check since Azure keys can vary in length
        // Remove the AAAY check since it might be part of valid keys
        if (!key.match(/^[a-zA-Z0-9]+$/)) {
            throw new Error('Invalid Azure Speech key format. Please check your Azure portal for the correct key.');
        }

        try {
            this.speechConfig = SpeechConfig.fromSubscription(
                speechKey,
                speechRegion
            );

            // Configure core settings
            this.speechConfig.enableAudioLogging();
            this.speechConfig.outputFormat = OutputFormat.Detailed;

            // More lenient timeouts for continuous speech
            this.speechConfig.setProperty("SpeechServiceConnection_InitialSilenceTimeoutMs", "15000");
            this.speechConfig.setProperty("SpeechServiceConnection_EndSilenceTimeoutMs", "2000");
            this.speechConfig.setProperty("SpeechServiceConnection_ReconnectOnError", "true");
            this.speechConfig.setProperty("SpeechServiceConnection_LogEvents", "true");

            // More sensitive voice activity detection
            this.speechConfig.setProperty("SpeechServiceConnection_VadEnabled", "true");
            this.speechConfig.setProperty("SpeechServiceConnection_VadWindowMs", "2000");
            this.speechConfig.setProperty("SpeechServiceConnection_VadOffsetMs", "200");
            this.speechConfig.setProperty("SpeechServiceConnection_VadSensitivity", "1");

            console.log('Speech service configuration complete');
        } catch (error) {
            console.error('Failed to initialize speech config:', error);
            throw error;
        }

        this.activeRecognizers = new Map();
        this.recognitionQueue = new Map(); // Map of userId to queue status
        this.restartDelayMs = 2000; // Minimum time between restarts
        this._connectionMonitorInterval = null;
        this._lastConnectionStatus = 'Unknown';
        this._unknownStatusCount = 0;
        this._parent = parent;
    }

    getSpeechConfig() {
        return this.speechConfig;
    }

    async setupRecognizer(userId, audioConfig, messageCallback) {
        console.log('Setting up speech recognizer for user:', userId, {
            timestamp: new Date().toISOString(),
            hasAudioConfig: !!audioConfig,
            hasCallback: !!messageCallback
        });
        
        try {
            // Create the speech recognizer
            const recognizer = new SpeechRecognizer(this.speechConfig, audioConfig);
            
            // Configure recognition settings for better sensitivity
            recognizer.properties.setProperty(
                "Speech_SegmentationSilenceTimeoutMs", 
                "500"
            );
            
            recognizer.properties.setProperty(
                "SpeechServiceResponse_PostProcessingOption", 
                "TrueText"
            );

            // Set more lenient voice detection
            recognizer.properties.setProperty(
                "SpeechServiceConnection_EndSilenceTimeoutMs",
                "500"
            );

            recognizer.properties.setProperty(
                "SpeechServiceConnection_InitialSilenceTimeoutMs",
                "5000"
            );

            // Set up event handlers using the dedicated method
            this.setupRecognizerEvents(recognizer, userId, messageCallback);

            // Start continuous recognition
            await recognizer.startContinuousRecognitionAsync();
            console.log('Started continuous recognition for user:', userId, {
                timestamp: new Date().toISOString(),
                properties: {
                    segmentationTimeout: recognizer.properties.getProperty("Speech_SegmentationSilenceTimeoutMs"),
                    endSilenceTimeout: recognizer.properties.getProperty("SpeechServiceConnection_EndSilenceTimeoutMs"),
                    initialSilenceTimeout: recognizer.properties.getProperty("SpeechServiceConnection_InitialSilenceTimeoutMs")
                }
            });

            return recognizer;
        } catch (error) {
            console.error('Error setting up recognizer:', error);
            throw error;
        }
    }

    setupRecognizerEvents(recognizer, userId, messageCallback) {
        // Store the recognizer
        this.activeRecognizers.set(userId, recognizer);

        // Create audio monitor with more lenient thresholds
        const audioMonitor = {
            isProcessingVoice: false,
            lastVoiceActivity: Date.now(),
            voiceDetected: false,
            lastLevel: -60,
            samples: [],
            startTime: Date.now(),
            lastRestartTime: Date.now(),
            silenceStartTime: null,
            continuousSpeechStartTime: null
        };

        // Set up interim recognition handler with continuous speech tracking
        recognizer.recognizing = (s, e) => {
            try {
                if (e.result.text) {
                    audioMonitor.isProcessingVoice = true;
                    audioMonitor.lastVoiceActivity = Date.now();
                    audioMonitor.voiceDetected = true;
                    audioMonitor.silenceStartTime = null;
                    
                    // Track continuous speech
                    if (!audioMonitor.continuousSpeechStartTime) {
                        audioMonitor.continuousSpeechStartTime = Date.now();
                    }
                    
                    console.log('Interim recognition:', {
                        text: e.result.text,
                        userId,
                        timestamp: new Date().toISOString(),
                        speechDuration: audioMonitor.continuousSpeechStartTime ? 
                            (Date.now() - audioMonitor.continuousSpeechStartTime) / 1000 : 0
                    });
                }
            } catch (error) {
                console.error('Error in recognizing handler:', error);
            }
        };

        // Modified audio monitor interval with better silence detection
        const audioMonitorInterval = setInterval(() => {
            try {
                const currentLevel = parseFloat(recognizer.properties.getProperty("SPEECH-AudioLevel", "-60"));
                const status = recognizer.properties.getProperty("Connection_Status", "Unknown");
                
                if (!isNaN(currentLevel) && isFinite(currentLevel)) {
                    // More lenient threshold for voice detection
                    if (currentLevel > -40) {
                        audioMonitor.isProcessingVoice = true;
                        audioMonitor.lastVoiceActivity = Date.now();
                        audioMonitor.voiceDetected = true;
                        audioMonitor.silenceStartTime = null;
                        
                        if (!audioMonitor.continuousSpeechStartTime) {
                            audioMonitor.continuousSpeechStartTime = Date.now();
                        }
                    } else if (currentLevel <= -50 && !audioMonitor.silenceStartTime) {
                        // Start tracking silence period
                        audioMonitor.silenceStartTime = Date.now();
                    }

                    // Log significant level changes
                    if (Math.abs(currentLevel - audioMonitor.lastLevel) > 5) {
                        console.log('Audio level:', {
                            userId,
                            level: currentLevel.toFixed(1),
                            status,
                            isProcessingVoice: audioMonitor.isProcessingVoice,
                            timestamp: new Date().toISOString(),
                            speechDuration: audioMonitor.continuousSpeechStartTime ? 
                                (Date.now() - audioMonitor.continuousSpeechStartTime) / 1000 : 0
                        });
                        audioMonitor.lastLevel = currentLevel;
                    }

                    // Only restart if we have true silence for an extended period
                    const timeSinceLastRestart = Date.now() - audioMonitor.lastRestartTime;
                    const silenceDuration = audioMonitor.silenceStartTime ? 
                        Date.now() - audioMonitor.silenceStartTime : 0;

                    if (silenceDuration > 15000 && // 15 seconds of silence
                        timeSinceLastRestart > this.restartDelayMs &&
                        !this.recognitionQueue.get(userId)) {
                        
                        console.log('Extended silence detected - Scheduling restart:', {
                            silenceDuration: silenceDuration / 1000,
                            userId,
                            timestamp: new Date().toISOString()
                        });
                        
                        this.emit('noAudioWarning', { userId });
                        
                        // Reset tracking
                        audioMonitor.isProcessingVoice = false;
                        audioMonitor.voiceDetected = false;
                        audioMonitor.silenceStartTime = null;
                        audioMonitor.continuousSpeechStartTime = null;
                        
                        this.scheduleRecognitionRestart(userId);
                    }
                }
            } catch (error) {
                console.error('Error in audio monitoring:', error);
            }
        }, 1000);

        // Handle voice activity events from the pipeline
        this._parent?.on('voiceStart', ({ userId: eventUserId, level }) => {
            if (eventUserId === userId) {
                audioMonitor.isProcessingVoice = true;
                console.log('Voice activity started - Recognition active:', {
                    userId,
                    level,
                    timestamp: new Date().toISOString()
                });
            }
        });

        this._parent?.on('voiceEnd', ({ userId: eventUserId, level, silenceDuration }) => {
            if (eventUserId === userId) {
                audioMonitor.isProcessingVoice = false;
                console.log('Voice activity ended - Recognition paused:', {
                    userId,
                    level,
                    silenceDuration,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // Modified recognized handler (unchanged)
        recognizer.recognized = async (s, e) => {
            try {
                const status = recognizer.properties.getProperty("Connection_Status", "Unknown");
                // Accept any recognized speech, even if voice processing flag is false
                if (e.result.reason === ResultReason.RecognizedSpeech) {
                    const text = e.result.text.trim();
                    if (text) {
                        console.log('Recognition result:', {
                            text,
                            duration: e.result.duration,
                            offset: e.result.offset,
                            resultId: e.result.resultId,
                            status,
                            isProcessingVoice: audioMonitor.isProcessingVoice,
                            voiceDetected: audioMonitor.voiceDetected,
                            timestamp: new Date().toISOString()
                        });
                        
                        // Call the messageCallback with the recognized text
                        const response = await messageCallback(text);
                        // Only emit ttsResponse if there is a response
                        if (response) {
                            this.emit('ttsResponse', { userId, text: response });
                        }
                    }
                } else if (e.result.reason === ResultReason.NoMatch && audioMonitor.voiceDetected) {
                    console.log('Speech detected but no match:', {
                        userId,
                        details: e.result.noMatchDetails,
                        status,
                        isProcessingVoice: audioMonitor.isProcessingVoice,
                        voiceDetected: audioMonitor.voiceDetected,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (error) {
                console.error('Error in recognition handler:', {
                    error: error.message,
                    userId,
                    status: recognizer.properties.getProperty("Connection_Status", "Unknown"),
                    isProcessingVoice: audioMonitor.isProcessingVoice,
                    voiceDetected: audioMonitor.voiceDetected,
                    timestamp: new Date().toISOString(),
                    stack: error.stack
                });
                this.emit('recognitionError', { userId, error });
            }
        };

        // Modified canceled handler
        recognizer.canceled = async (s, e) => {
            console.log('Recognition canceled:', {
                reason: e.reason,
                errorDetails: e.errorDetails,
                userId,
                timestamp: new Date().toISOString()
            });

            try {
                // Only attempt restart if not already queued and enough time has passed
                if (!this.recognitionQueue.get(userId) && 
                    Date.now() - audioMonitor.lastRestartTime > this.restartDelayMs) {
                    await this.scheduleRecognitionRestart(userId);
                }
            } catch (error) {
                console.error('Error handling recognition cancellation:', {
                    error: error.message,
                    userId,
                    timestamp: new Date().toISOString()
                });
                this.emit('recognitionError', { userId, error });
            }
        };

        // Modified sessionStopped handler
        recognizer.sessionStopped = async (s, e) => {
            try {
                console.log('Recognition session stopped:', {
                    userId,
                    timestamp: new Date().toISOString()
                });
                
                // Only attempt restart if not already queued and enough time has passed
                if (!this.recognitionQueue.get(userId) && 
                    Date.now() - audioMonitor.lastRestartTime > this.restartDelayMs) {
                    await this.scheduleRecognitionRestart(userId);
                }
            } catch (error) {
                console.error('Error handling session stop:', {
                    error: error.message,
                    userId,
                    timestamp: new Date().toISOString()
                });
                this.emit('recognitionError', { userId, error });
            }
        };
    }

    async startRecognition(userId) {
        console.log('Starting recognition for user:', userId);
        const recognizer = this.activeRecognizers.get(userId);
        if (!recognizer) {
            throw new Error('No recognizer found for user');
        }

        // Enhanced connection monitoring
        this._connectionMonitorInterval = setInterval(async () => {
            try {
                const currentStatus = recognizer.properties.getProperty("Connection_Status", "Unknown");
                const connectionId = recognizer.properties.getProperty("Connection_Id", "None");
                const lastError = recognizer.properties.getProperty("Connection_LastErrorDetails", "None");
                const audioLevel = recognizer.properties.getProperty("SPEECH-AudioLevel", "0");
                
                console.log('Connection status check:', {
                    status: currentStatus,
                    connectionId,
                    lastError,
                    audioLevel,
                    userId,
                    timestamp: new Date().toISOString()
                });

                if (currentStatus !== this._lastConnectionStatus) {
                    console.log('Connection status changed:', {
                        from: this._lastConnectionStatus,
                        to: currentStatus,
                        userId,
                        timestamp: new Date().toISOString()
                    });
                    
                    if (currentStatus === 'Disconnected' || currentStatus === 'Unknown') {
                        console.log('Connection lost, attempting reconnection...');
                        
                        // First try simple restart
                        try {
                            await recognizer.stopContinuousRecognitionAsync().catch(console.error);
                            await new Promise(resolve => setTimeout(resolve, 500));
                            await recognizer.startContinuousRecognitionAsync();
                            console.log('Simple restart successful');
                        } catch (error) {
                            console.error('Simple restart failed, attempting full reconnection:', error);
                            
                            // If simple restart fails, do a full reconnect
                            try {
                                await this.handleRecognitionError(userId);
                                console.log('Full reconnection successful');
                            } catch (reconnectError) {
                                console.error('Full reconnection failed:', reconnectError);
                                this.emit('recognitionError', { userId, error: reconnectError });
                            }
                        }
                    }
                    
                    this._lastConnectionStatus = currentStatus;
                }

                // Check for prolonged Unknown status
                if (currentStatus === 'Unknown' && this._unknownStatusCount === undefined) {
                    this._unknownStatusCount = 1;
                } else if (currentStatus === 'Unknown') {
                    this._unknownStatusCount++;
                    if (this._unknownStatusCount >= 5) { // After 5 seconds of Unknown status
                        console.log('Connection stuck in Unknown state, forcing reconnection...');
                        this._unknownStatusCount = 0;
                        await this.handleRecognitionError(userId);
                    }
                } else {
                    this._unknownStatusCount = 0;
                }

            } catch (error) {
                console.error('Error in connection monitoring:', error);
            }
        }, 1000); // Check every second

        // More aggressive retry strategy
        let retryCount = 0;
        const maxRetries = 10;
        const retryDelay = 250;

        while (retryCount < maxRetries) {
            try {
                await recognizer.startContinuousRecognitionAsync();
                console.log('Recognition started successfully for user:', userId);
                return;
            } catch (error) {
                retryCount++;
                console.error(`Recognition start attempt ${retryCount} failed:`, error);
                
                if (retryCount < maxRetries) {
                    console.log(`Retrying in ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    console.error('Max retries reached, failing recognition start');
                    throw error;
                }
            }
        }
    }

    async stopRecognition(userId) {
        console.log('Stopping recognition for user:', userId);
        
        // Clear connection monitoring
        if (this._connectionMonitorInterval) {
            clearInterval(this._connectionMonitorInterval);
            this._connectionMonitorInterval = null;
        }
        
        const recognizer = this.activeRecognizers.get(userId);
        if (recognizer) {
            try {
                // Stop continuous recognition
                console.log('Stopping continuous recognition...');
                await recognizer.stopContinuousRecognitionAsync();
                
                // Clear any pending operations
                console.log('Clearing recognizer operations...');
                recognizer.recognized = null;
                recognizer.recognizing = null;
                recognizer.canceled = null;
                recognizer.sessionStarted = null;
                recognizer.sessionStopped = null;
                
                // Close and dispose the recognizer
                console.log('Closing recognizer...');
                recognizer.close();
                
                // Remove from active recognizers
                this.activeRecognizers.delete(userId);
                console.log('Recognition stopped and cleaned up for user:', userId);
            } catch (error) {
                if (error.message && error.message.includes('already disposed')) {
                    console.log('Recognizer was already disposed, continuing cleanup');
                    this.activeRecognizers.delete(userId);
                } else {
                    console.error('Error stopping recognition:', error);
                    // Still try to remove from active recognizers
                    this.activeRecognizers.delete(userId);
                    throw error;
                }
            }
        } else {
            console.log('No active recognizer found for user:', userId);
        }
    }

    async handleRecognitionError(userId) {
        console.log('Handling recognition error for user:', userId);
        const recognizer = this.activeRecognizers.get(userId);
        if (recognizer) {
            try {
                // Stop and cleanup existing recognizer
                console.log('Stopping existing recognizer...');
                await recognizer.stopContinuousRecognitionAsync().catch(err => {
                    console.warn('Error stopping recognition:', err);
                });
                
                console.log('Closing existing recognizer...');
                recognizer.close();
                this.activeRecognizers.delete(userId);
                
                // Wait before reconnecting
                console.log('Waiting before reconnection attempt...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Get session and verify audio config
                const session = this._parent?.sessionManager?.getSession(userId);
                if (!session?.audioConfig) {
                    throw new Error('No valid session or audio config found');
                }
                
                console.log('Creating new recognizer...');
                const newRecognizer = await this.setupRecognizer(
                    userId, 
                    session.audioConfig, 
                    session.messageCallback
                );
                
                // Wait for setup to complete
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                console.log('Starting new recognition...');
                await this.startRecognition(userId);
                
                console.log('Recognition restarted successfully');
                this.emit('recognitionRestarted', { userId });
                
            } catch (error) {
                console.error('Failed to handle recognition error:', error);
                this.emit('recognitionError', { 
                    userId, 
                    error,
                    fatal: true,
                    timestamp: new Date().toISOString()
                });
                throw error;
            }
        } else {
            console.warn('No active recognizer found for error handling');
        }
    }

    getSession(userId) {
        // Get session from the parent VoiceService's session manager
        if (this._parent?.sessionManager) {
            return this._parent.sessionManager.getSession(userId);
        }
        return null;
    }

    async processCurrentAudio(userId) {
        // Only process if not already queued
        if (this.recognitionQueue.get(userId)) {
            console.log('Audio processing already queued for user:', userId);
            return;
        }

        await this.scheduleRecognitionRestart(userId);
    }

    // New method to handle queued recognition restarts
    async scheduleRecognitionRestart(userId) {
        // If already queued, skip
        if (this.recognitionQueue.get(userId)) {
            console.log('Recognition restart already queued for user:', userId);
            return;
        }

        // Mark as queued
        this.recognitionQueue.set(userId, true);

        try {
            const recognizer = this.activeRecognizers.get(userId);
            if (!recognizer) {
                console.warn('No active recognizer found for restart');
                this.recognitionQueue.delete(userId);
                return;
            }

            // Stop current recognition
            await recognizer.stopContinuousRecognitionAsync();
            
            // Wait for the minimum delay
            await new Promise(resolve => setTimeout(resolve, this.restartDelayMs));
            
            // Start new recognition
            await recognizer.startContinuousRecognitionAsync();
            
            console.log('Recognition restarted successfully:', {
                userId,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('Error during recognition restart:', {
                error: error.message,
                userId,
                timestamp: new Date().toISOString()
            });
            this.emit('recognitionError', { userId, error });
        } finally {
            // Clear queue status
            this.recognitionQueue.delete(userId);
        }
    }
}

module.exports = RecognitionService; 