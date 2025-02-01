const { EventEmitter } = require('events');

class SessionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.sessions = new Map();
        this.cleanupTimeouts = new Map();
        this.CLEANUP_DELAY = 5000; // 5 seconds
        this.config = {
            speech: {
                key: config.azure?.speech?.key || config.azureSpeech?.key,
                region: config.azure?.speech?.region || config.azureSpeech?.region,
                language: config.azure?.speech?.language || config.azureSpeech?.language || 'en-US'
            }
        };
    }

    isUserInSession(userId) {
        return this.sessions.has(userId);
    }

    addSession(userId, session) {
        // Initialize session with current timestamp
        session.lastActivity = Date.now();
        
        // Set up activity tracking
        if (session.audioPipeline) {
            session.audioPipeline.on('activity', () => {
                this.updateSessionActivity(userId);
            });
            
            session.audioPipeline.on('audioLevel', ({ level }) => {
                if (level > -45) { // Update activity on significant audio
                    this.updateSessionActivity(userId);
                }
            });
        }
        
        this.sessions.set(userId, session);
        console.log('Session created:', {
            userId,
            timestamp: new Date().toISOString(),
            hasAudioPipeline: !!session.audioPipeline
        });
    }

    getSession(userId) {
        return this.sessions.get(userId);
    }

    async cleanupSession(userId, services = {}) {
        const session = this.sessions.get(userId);
        if (!session) return;

        console.log('Starting cleanup for user:', userId, {
            timestamp: new Date().toISOString()
        });
        
        // Clear any existing cleanup timeout
        if (this.cleanupTimeouts.has(userId)) {
            clearTimeout(this.cleanupTimeouts.get(userId));
            this.cleanupTimeouts.delete(userId);
        }

        const cleanup = async () => {
            try {
                // Stop recognition first to prevent new audio processing
                if (services.recognition) {
                    console.log('Stopping recognition service...');
                    await services.recognition.stopRecognition(userId);
                }

                // Clean up audio monitoring
                if (session.audioMonitorInterval) {
                    console.log('Clearing audio monitor interval...');
                    clearInterval(session.audioMonitorInterval);
                    session.audioMonitorInterval = null;
                }

                // Clean up audio pipeline
                if (session.audioPipeline) {
                    console.log('Destroying audio pipeline...');
                    try {
                        await session.audioPipeline.destroy();
                    } catch (error) {
                        console.error('Error destroying audio pipeline:', error);
                    }
                    session.audioPipeline = null;
                }

                // Clean up audio stream
                if (session.audioStream) {
                    console.log('Destroying audio stream...');
                    try {
                        session.audioStream.destroy();
                    } catch (error) {
                        console.error('Error destroying audio stream:', error);
                    }
                    session.audioStream = null;
                }

                // Clean up push stream
                if (session.pushStream) {
                    console.log('Closing push stream...');
                    try {
                        session.pushStream.close();
                    } catch (error) {
                        console.error('Error closing push stream:', error);
                    }
                    session.pushStream = null;
                }

                // Clean up voice connection
                if (session.connection) {
                    console.log('Destroying voice connection...');
                    try {
                        // Unsubscribe from user's audio
                        const receiver = session.connection.receiver;
                        if (receiver) {
                            receiver.subscriptions.forEach(sub => {
                                try {
                                    sub.unsubscribe();
                                } catch (error) {
                                    console.error('Error unsubscribing from audio:', error);
                                }
                            });
                        }
                        // Destroy the connection
                        session.connection.destroy();
                    } catch (connError) {
                        console.error('Error destroying connection:', connError);
                    }
                    session.connection = null;
                }

                // Remove session
                console.log('Removing session...');
                this.sessions.delete(userId);
                
                console.log('Cleanup completed for user:', userId, {
                    timestamp: new Date().toISOString()
                });
                
                this.emit('sessionCleaned', { userId });
            } catch (error) {
                console.error('Error during session cleanup:', error);
                // Even if there's an error, try to remove the session
                this.sessions.delete(userId);
                this.emit('cleanupError', { userId, error });
            }
        };

        // Set a timeout to ensure cleanup completes
        const timeoutId = setTimeout(() => {
            console.warn('Cleanup timeout reached, forcing cleanup...', {
                userId,
                timestamp: new Date().toISOString()
            });
            cleanup();
        }, this.CLEANUP_DELAY);

        this.cleanupTimeouts.set(userId, timeoutId);

        // Start cleanup
        await cleanup();
    }

    getActiveSessions() {
        return Array.from(this.sessions.values());
    }

    updateSessionActivity(userId) {
        const session = this.sessions.get(userId);
        if (session) {
            const now = Date.now();
            session.lastActivity = now;
            this.sessions.set(userId, session);
            console.log('Session activity updated:', {
                userId,
                timestamp: new Date().toISOString()
            });
        }
    }

    removeSession(userId) {
        const session = this.sessions.get(userId);
        if (session) {
            this.sessions.delete(userId);
            this.emit('sessionEnded', { userId, session });
        }
    }

    startSessionMonitoring(timeout = 300000) { // 5 minutes default
        const checkInterval = 30000; // Check every 30 seconds
        
        setInterval(() => {
            const now = Date.now();
            for (const [userId, session] of this.sessions) {
                if (!session.lastActivity || (now - session.lastActivity) > timeout) {
                    console.log('Session timeout detected:', {
                        userId,
                        lastActivity: session.lastActivity,
                        timeout,
                        timestamp: new Date().toISOString()
                    });
                    this.emit('sessionTimeout', { userId });
                }
            }
        }, checkInterval);
    }
}

module.exports = SessionManager; 