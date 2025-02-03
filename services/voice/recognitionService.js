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
    constructor(config) {
        super();
        this.setupSpeechConfig(config);
        this.recognizers = new Map();
        this.activeRecognitions = new Map();
        this.restartDelayMs = 2000;
        this._connectionMonitorInterval = null;
        this._lastConnectionStatus = 'Unknown';
        this._unknownStatusCount = 0;
    }

    setupSpeechConfig(config) {
        if (!config?.azure?.speech?.key || !config?.azure?.speech?.region) {
            throw new Error('Missing Azure Speech configuration');
        }

        this.speechConfig = SpeechConfig.fromSubscription(
            config.azure.speech.key,
            config.azure.speech.region
        );

        // Configure speech settings
        this.speechConfig.speechRecognitionLanguage = config.azure.speech.language || 'en-US';
        this.speechConfig.setProperty('SpeechServiceConnection_InitialSilenceTimeoutMs', '5000');
        this.speechConfig.setProperty('SpeechServiceConnection_EndSilenceTimeoutMs', '1000');
        this.speechConfig.setProperty('SpeechServiceConnection_MaxRetryCountLowLatency', '2');
        this.speechConfig.setProperty('SpeechServiceConnection_ReconnectOnError', 'true');
        this.speechConfig.setProperty('SpeechServiceConnection_LogEvents', 'true');
        this.speechConfig.outputFormat = OutputFormat.Detailed;
    }

    setupRecognizerEvents(recognizer, userId) {
        recognizer.recognized = (s, e) => {
            if (e.result.text) {
                console.log('Speech recognized:', {
                    userId,
                    text: e.result.text,
                    confidence: e.result.confidence,
                    timestamp: new Date().toISOString()
                });
                this.emit('speechRecognized', {
                    userId,
                    text: e.result.text,
                    confidence: e.result.confidence,
                    duration: e.result.duration,
                    offset: e.result.offset
                });
            }
        };

        recognizer.recognizing = (s, e) => {
            if (e.result.text) {
                console.log('Speech recognizing:', {
                    userId,
                    text: e.result.text,
                    timestamp: new Date().toISOString()
                });
                this.emit('speechRecognizing', {
                    userId,
                    text: e.result.text,
                    confidence: e.result.confidence
                });
            }
        };

        recognizer.canceled = (s, e) => {
            const isFatal = e.reason === CancellationReason.Error && 
                          (e.errorDetails?.includes('End of stream') || 
                           e.errorDetails?.includes('Connection was closed'));
            
            console.log('Recognition canceled:', {
                userId,
                reason: e.reason,
                errorDetails: e.errorDetails,
                isFatal,
                timestamp: new Date().toISOString()
            });

            this.emit('recognitionCanceled', {
                userId,
                reason: e.reason,
                errorDetails: e.errorDetails,
                isFatal
            });

            // Handle stream end gracefully
            if (e.errorDetails?.includes('End of stream')) {
                this.handleStreamEnd(userId);
                return;
            }

            if (isFatal) {
                this.handleRecognitionError(userId).catch(error => {
                    console.error('Failed to handle fatal recognition error:', error);
                });
            }
        };

        recognizer.sessionStarted = (s, e) => {
            console.log('Recognition session started:', {
                userId,
                sessionId: e.sessionId,
                timestamp: new Date().toISOString()
            });
            this.emit('sessionStarted', {
                userId,
                sessionId: e.sessionId
            });
        };

        recognizer.sessionStopped = (s, e) => {
            console.log('Recognition session stopped:', {
                userId,
                sessionId: e.sessionId,
                timestamp: new Date().toISOString()
            });
            this.emit('sessionStopped', {
                userId,
                sessionId: e.sessionId
            });
        };
    }

    setupRecognizer(userId, audioConfig) {
        const recognizer = new SpeechRecognizer(this.speechConfig, audioConfig);
        this.setupRecognizerEvents(recognizer, userId);

        // Start continuous recognition immediately
        recognizer.startContinuousRecognitionAsync(
            () => {
                console.log('Continuous recognition started:', {
                    userId,
                    timestamp: new Date().toISOString()
                });
                this.activeRecognitions.set(userId, true);
            },
            (error) => {
                console.error('Error starting continuous recognition:', {
                    error: error.message,
                    userId,
                    timestamp: new Date().toISOString()
                });
                this.emit('error', {
                    userId,
                    error: error.message,
                    type: 'startRecognition'
                });
            }
        );

        this.recognizers.set(userId, recognizer);
        return recognizer;
    }

    async handleVoiceStart(userId) {
        const recognizer = this.recognizers.get(userId);
        if (!recognizer) {
            console.warn('No recognizer found for user:', userId);
            return;
        }

        if (!this.activeRecognitions.has(userId)) {
            try {
                await recognizer.startContinuousRecognitionAsync();
                this.activeRecognitions.set(userId, true);
                this.startConnectionMonitoring(userId, recognizer);
                console.log('Started continuous recognition for user:', userId);
            } catch (error) {
                console.error('Failed to start recognition:', error);
                this.emit('error', {
                    userId,
                    error: error.message,
                    type: 'startRecognition'
                });
            }
        }
    }

    async handleVoiceEnd(userId) {
        const recognizer = this.recognizers.get(userId);
        if (!recognizer) {
            return;
        }

        if (this.activeRecognitions.has(userId)) {
            try {
                await recognizer.stopContinuousRecognitionAsync();
                this.activeRecognitions.delete(userId);
                this.stopConnectionMonitoring();
                console.log('Stopped continuous recognition for user:', userId);
            } catch (error) {
                console.error('Failed to stop recognition:', error);
                this.emit('error', {
                    userId,
                    error: error.message,
                    type: 'stopRecognition'
                });
            }
        }
    }

    startConnectionMonitoring(userId, recognizer) {
        this.stopConnectionMonitoring(); // Clear any existing monitor

        this._connectionMonitorInterval = setInterval(() => {
            try {
                const currentStatus = recognizer.properties.getProperty("Connection_Status", "Unknown");
                const connectionId = recognizer.properties.getProperty("Connection_Id", "None");
                const lastError = recognizer.properties.getProperty("Connection_LastErrorDetails", "None");
                
                if (currentStatus !== this._lastConnectionStatus) {
                    console.log('Connection status changed:', {
                        from: this._lastConnectionStatus,
                        to: currentStatus,
                        userId,
                        connectionId,
                        lastError,
                        timestamp: new Date().toISOString()
                    });
                    
                    if (currentStatus === 'Disconnected') {
                        this.handleRecognitionError(userId).catch(error => {
                            console.error('Failed to handle disconnection:', error);
                        });
                    }
                    
                    this._lastConnectionStatus = currentStatus;
                }

                // Check for prolonged Unknown status
                if (currentStatus === 'Unknown') {
                    this._unknownStatusCount++;
                    if (this._unknownStatusCount >= 5) {
                        console.log('Connection stuck in Unknown state, forcing reconnection...');
                        this._unknownStatusCount = 0;
                        this.handleRecognitionError(userId).catch(error => {
                            console.error('Failed to handle unknown state:', error);
                        });
                    }
                } else {
                    this._unknownStatusCount = 0;
                }

            } catch (error) {
                console.error('Error in connection monitoring:', error);
            }
        }, 1000);
    }

    stopConnectionMonitoring() {
        if (this._connectionMonitorInterval) {
            clearInterval(this._connectionMonitorInterval);
            this._connectionMonitorInterval = null;
        }
    }

    async handleRecognitionError(userId) {
        console.log('Handling recognition error for user:', userId);
        const recognizer = this.recognizers.get(userId);
        if (!recognizer) {
            return;
        }

        try {
            // Stop and cleanup existing recognizer
            await recognizer.stopContinuousRecognitionAsync().catch(console.warn);
            recognizer.close();
            this.recognizers.delete(userId);
            this.activeRecognitions.delete(userId);
            
            // Wait before reconnecting
            await new Promise(resolve => setTimeout(resolve, this.restartDelayMs));
            
            // Create new recognizer with same audio config
            const audioConfig = recognizer.audioConfig;
            if (!audioConfig) {
                throw new Error('No valid audio config found');
            }
            
            const newRecognizer = await this.setupRecognizer(userId, audioConfig);
            await newRecognizer.startContinuousRecognitionAsync();
            this.activeRecognitions.set(userId, true);
            
            console.log('Recognition restarted successfully');
            this.emit('recognitionRestarted', { userId });
            
        } catch (error) {
            console.error('Failed to handle recognition error:', error);
            this.emit('error', { 
                userId, 
                error: error.message,
                type: 'reconnection',
                fatal: true
            });
            throw error;
        }
    }

    async cleanup(userId) {
        const recognizer = this.recognizers.get(userId);
        if (recognizer) {
            try {
                if (this.activeRecognitions.has(userId)) {
                    await recognizer.stopContinuousRecognitionAsync();
                    this.activeRecognitions.delete(userId);
                }
                recognizer.close();
                this.recognizers.delete(userId);
                console.log('Cleaned up recognition resources for user:', userId);
            } catch (error) {
                console.error('Error during recognition cleanup:', error);
            }
        }
    }

    async cleanupAll() {
        this.stopConnectionMonitoring();
        const cleanupPromises = Array.from(this.recognizers.keys()).map(userId => this.cleanup(userId));
        await Promise.all(cleanupPromises);
        this.recognizers.clear();
        this.activeRecognitions.clear();
    }

    isRecognizing(userId) {
        return this.activeRecognitions.has(userId);
    }

    async handleRecognitionCanceled(userId, reason, errorDetails) {
        // Only handle fatal errors or explicit cancellations
        if (reason === CancellationReason.Error && errorDetails) {
            console.error('Fatal recognition error:', {
                userId,
                error: errorDetails,
                timestamp: new Date().toISOString()
            });
            await this.cleanup(userId);
            return;
        }

        // For non-fatal cancellations, try to restart recognition
        if (this.recognizers.has(userId)) {
            try {
                const recognizer = this.recognizers.get(userId);
                const audioConfig = recognizer.audioConfig;

                // Close old recognizer
                if (this.activeRecognitions.has(userId)) {
                    await recognizer.stopContinuousRecognitionAsync();
                    this.activeRecognitions.delete(userId);
                }
                recognizer.close();
                this.recognizers.delete(userId);

                // Create new recognizer with same config
                const newRecognizer = new SpeechRecognizer(this.speechConfig, audioConfig);
                this.setupRecognizerEvents(newRecognizer, userId);
                this.recognizers.set(userId, newRecognizer);

                // Start recognition
                await newRecognizer.startContinuousRecognitionAsync();
                this.activeRecognitions.set(userId, true);
                
                console.log('Successfully restarted recognition after cancellation:', {
                    userId,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Failed to restart recognition:', {
                    userId,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
                await this.cleanup(userId);
            }
        }
    }

    async handleStreamEnd(userId) {
        try {
            const recognizer = this.recognizers.get(userId);
            if (!recognizer) return;

            // Stop current recognition
            if (this.activeRecognitions.has(userId)) {
                await recognizer.stopContinuousRecognitionAsync();
                this.activeRecognitions.delete(userId);
            }

            // Create new recognizer with same config
            const audioConfig = recognizer.audioConfig;
            recognizer.close();
            this.recognizers.delete(userId);

            // Create and start new recognizer
            const newRecognizer = new SpeechRecognizer(this.speechConfig, audioConfig);
            this.setupRecognizerEvents(newRecognizer, userId);
            this.recognizers.set(userId, newRecognizer);

            await newRecognizer.startContinuousRecognitionAsync();
            this.activeRecognitions.set(userId, true);

            console.log('Successfully restarted recognition after stream end:', {
                userId,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Failed to handle stream end:', {
                userId,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = RecognitionService; 