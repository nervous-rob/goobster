const { VoiceDetectionManager, THRESHOLDS, TIMINGS } = require('../../services/voice/VoiceDetectionManager');

describe('VoiceDetectionManager', () => {
    let manager;
    const userId = 'test-user-123';

    beforeEach(() => {
        manager = new VoiceDetectionManager();
    });

    describe('Voice Detection', () => {
        it('should emit voiceStart when voice detected', (done) => {
            manager.on('voiceStart', (data) => {
                expect(data.level).toBe(THRESHOLDS.VOICE_START);
                expect(data.userId).toBe(userId);
                expect(data.timestamp).toBeDefined();
                done();
            });

            manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
        });

        it('should maintain voice detection with hysteresis', () => {
            const events = [];
            manager.on('voiceStart', (data) => events.push({ type: 'start', data }));
            manager.on('voiceEnd', (data) => events.push({ type: 'end', data }));

            // Initial voice detection
            manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
            
            // Level drops but stays above VOICE_MAINTAIN
            manager.processAudioLevel(THRESHOLDS.VOICE_MAINTAIN + 1, userId);
            
            // Should still be considered voice
            expect(manager.getState().isActive).toBe(true);
            expect(events.length).toBe(1); // Only the initial voiceStart
        });

        it('should emit voiceEnd after silence duration', (done) => {
            const events = [];
            manager.on('voiceEnd', (data) => {
                expect(data.userId).toBe(userId);
                expect(data.duration).toBeGreaterThanOrEqual(TIMINGS.MIN_VOICE_DURATION);
                done();
            });

            // Start voice activity
            manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
            
            // Wait for minimum voice duration
            setTimeout(() => {
                // Introduce silence
                manager.processAudioLevel(THRESHOLDS.SILENCE - 1, userId);
                
                // Wait for silence duration
                setTimeout(() => {
                    manager.processAudioLevel(THRESHOLDS.SILENCE - 1, userId);
                }, TIMINGS.SILENCE_DURATION + 100);
            }, TIMINGS.MIN_VOICE_DURATION + 100);
        });
    });

    describe('Silence Detection', () => {
        it('should emit silenceWarning after warning threshold', (done) => {
            manager.on('silenceWarning', (data) => {
                expect(data.userId).toBe(userId);
                expect(data.duration).toBeGreaterThanOrEqual(TIMINGS.WARNING_THRESHOLD);
                done();
            });

            // Start with voice
            manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
            
            // Wait for warning threshold
            setTimeout(() => {
                manager.processAudioLevel(THRESHOLDS.SILENCE - 1, userId);
            }, TIMINGS.WARNING_THRESHOLD + 100);
        });

        it('should track silence duration correctly', () => {
            const state = manager.getState();
            expect(state.silenceStart).toBeNull();

            // Introduce silence
            manager.processAudioLevel(THRESHOLDS.SILENCE - 1, userId);
            
            const updatedState = manager.getState();
            expect(updatedState.silenceStart).toBeDefined();
            expect(updatedState.silenceStart).toBeInstanceOf(Date);
        });
    });

    describe('State Management', () => {
        it('should initialize with correct default state', () => {
            const state = manager.getState();
            expect(state).toEqual({
                isActive: false,
                lastLevel: THRESHOLDS.ABSOLUTE_SILENCE,
                lastActivity: expect.any(Number),
                silenceStart: null,
                voiceStart: null,
                warningEmitted: false,
                userId: null
            });
        });

        it('should reset state correctly', () => {
            // Set up some activity
            manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
            
            // Reset
            manager.reset();
            
            const state = manager.getState();
            expect(state).toEqual({
                isActive: false,
                lastLevel: THRESHOLDS.ABSOLUTE_SILENCE,
                lastActivity: expect.any(Number),
                silenceStart: null,
                voiceStart: null,
                warningEmitted: false,
                userId: userId // Should preserve userId
            });
        });
    });

    describe('Event Emission', () => {
        it('should emit voiceActivity during active voice', (done) => {
            manager.on('voiceActivity', (data) => {
                expect(data.level).toBe(THRESHOLDS.VOICE_START);
                expect(data.userId).toBe(userId);
                expect(data.duration).toBeGreaterThan(0);
                done();
            });

            manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
            setTimeout(() => {
                manager.processAudioLevel(THRESHOLDS.VOICE_START, userId);
            }, 100);
        });

        it('should emit silenceActivity during silence', (done) => {
            manager.on('silenceActivity', (data) => {
                expect(data.level).toBeLessThan(THRESHOLDS.SILENCE);
                expect(data.userId).toBe(userId);
                expect(data.duration).toBeGreaterThan(0);
                done();
            });

            manager.processAudioLevel(THRESHOLDS.SILENCE - 1, userId);
            setTimeout(() => {
                manager.processAudioLevel(THRESHOLDS.SILENCE - 1, userId);
            }, 100);
        });
    });
}); 