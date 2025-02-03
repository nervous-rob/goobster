const { EventEmitter } = require('events');

/**
 * Constants for voice detection thresholds and timing
 */
const THRESHOLDS = {
    VOICE: -45,      // Voice activity threshold in dB
    SILENCE: -65,    // Silence threshold in dB
    PEAK: -35       // Peak threshold for strong voice
};

const TIMINGS = {
    MIN_VOICE_DURATION: 250,    // Minimum duration for valid voice activity (ms)
    SILENCE_DURATION: 500,      // Duration of silence to end voice activity (ms)
    WARNING_THRESHOLD: 3000,    // Duration before emitting silence warning (ms)
    MAX_SILENCE: 10000         // Maximum silence duration before cleanup (ms)
};

/**
 * Manages voice detection state and events
 * @class VoiceDetectionManager
 * @extends EventEmitter
 */
class VoiceDetectionManager extends EventEmitter {
    constructor() {
        super();
        this.states = new Map();
    }

    /**
     * Get or create state for a user
     * @private
     */
    _getState(userId) {
        if (!userId) {
            console.warn('No userId provided for voice detection');
            return null;
        }

        if (!this.states.has(userId)) {
            this.states.set(userId, {
                userId,
                isActive: false,
                voiceStart: null,
                silenceStart: null,
                lastActivity: Date.now(),
                lastLevel: null,
                warningEmitted: false
            });
        }
        return this.states.get(userId);
    }

    /**
     * Process incoming audio level and emit appropriate events
     * @param {number} level - The audio level in dB
     * @param {string} userId - The user ID associated with this audio
     */
    processAudioLevel(level, userId) {
        const state = this._getState(userId);
        if (!state) return;

        const now = Date.now();

        // Voice activity detection
        if (level > THRESHOLDS.VOICE) {
            state.lastActivity = now;
            
            if (!state.isActive) {
                state.isActive = true;
                state.voiceStart = now;
                state.silenceStart = null;
                state.warningEmitted = false;
                
                this.emit('voiceStart', { 
                    userId,
                    level 
                });
            }
            
            // Emit voice activity
            this.emit('voiceActivity', {
                userId,
                level,
                duration: now - state.voiceStart
            });
            
        } else if (level < THRESHOLDS.SILENCE) {
            if (!state.silenceStart) {
                state.silenceStart = now;
            }
            
            const silenceDuration = now - state.lastActivity;
            
            // Warning threshold
            if (silenceDuration > TIMINGS.WARNING_THRESHOLD && !state.warningEmitted) {
                state.warningEmitted = true;
                this.emit('silenceWarning', { 
                    duration: silenceDuration,
                    userId 
                });
            }
            
            // Voice end detection
            if (state.isActive && silenceDuration > TIMINGS.SILENCE_DURATION) {
                const voiceDuration = state.lastActivity - state.voiceStart;
                
                if (voiceDuration >= TIMINGS.MIN_VOICE_DURATION) {
                    this.emit('voiceEnd', { 
                        userId,
                        duration: voiceDuration,
                        level
                    });
                }
                
                state.isActive = false;
                state.voiceStart = null;
            }

            // Emit silence activity
            this.emit('silenceActivity', {
                userId,
                level,
                duration: silenceDuration
            });
        }

        state.lastLevel = level;
    }

    /**
     * Clean up state for a user
     * @param {string} userId - The user ID to clean up
     */
    cleanup(userId) {
        if (userId && this.states.has(userId)) {
            const state = this.states.get(userId);
            if (state.isActive) {
                this.emit('voiceEnd', {
                    userId,
                    duration: Date.now() - state.voiceStart,
                    level: state.lastLevel
                });
            }
            this.states.delete(userId);
        }
    }

    /**
     * Clean up all states
     */
    cleanupAll() {
        for (const userId of this.states.keys()) {
            this.cleanup(userId);
        }
        this.states.clear();
    }
}

module.exports = {
    VoiceDetectionManager,
    THRESHOLDS,
    TIMINGS
}; 