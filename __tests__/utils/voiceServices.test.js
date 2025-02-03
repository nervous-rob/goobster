const { Transform } = require('stream');

// Mock dependencies
jest.mock('@discordjs/voice', () => ({
    createAudioPlayer: jest.fn().mockReturnValue({
        play: jest.fn(),
        on: jest.fn((event, callback) => {
            if (event === 'stateChange') {
                callback({}, { status: 'idle' }); // Call immediately instead of setTimeout
            }
        }),
        state: { status: 'idle' }
    }),
    createAudioResource: jest.fn().mockReturnValue({
        volume: {
            setVolume: jest.fn()
        }
    }),
    joinVoiceChannel: jest.fn().mockReturnValue({
        destroy: jest.fn(),
        on: jest.fn(),
        subscribe: jest.fn(),
        receiver: {
            subscribe: jest.fn().mockReturnValue({
                pipe: jest.fn(),
                destroy: jest.fn()
            })
        }
    }),
    VoiceConnectionStatus: {
        Disconnected: 'disconnected'
    },
    EndBehaviorType: {
        AfterSilence: 'afterSilence'
    },
    StreamType: {
        Arbitrary: 'arbitrary'
    },
    opus: {
        Encoder: {
            decode: jest.fn()
        }
    }
}));

jest.mock('microsoft-cognitiveservices-speech-sdk', () => {
    const mockSpeechSynthesizer = jest.fn().mockReturnValue({
        speakTextAsync: jest.fn().mockImplementation((text, resolve, reject) => {
            resolve({ audioData: Buffer.from('test') });
        }),
        close: jest.fn()
    });

    return {
        AudioConfig: {
            fromStreamInput: jest.fn().mockReturnValue({
                close: jest.fn()
            })
        },
        SpeechConfig: {
            fromSubscription: jest.fn().mockReturnValue({
                speechSynthesisVoiceName: '',
                speechRecognitionLanguage: 'en-US',
                volume: 1.0
            })
        },
        SpeechSynthesizer: mockSpeechSynthesizer,
        SpeechRecognizer: jest.fn().mockReturnValue({
            recognizing: jest.fn(),
            recognized: jest.fn(),
            canceled: jest.fn(),
            sessionStopped: jest.fn(),
            startContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
            stopContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
            close: jest.fn()
        }),
        CancellationReason: {
            Error: 'Error'
        },
        ResultReason: {
            RecognizedSpeech: 'RecognizedSpeech'
        }
    };
});

const { SpeechSynthesizer, SpeechRecognizer } = require('microsoft-cognitiveservices-speech-sdk');

// Get the mocked VoiceService
const VoiceService = require('../../services/voice');

describe('VoiceService', () => {
    let voiceChannel;
    let user;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();
        
        // Reset VoiceService state
        VoiceService.activeConnections = new Map();
        VoiceService.activeRecognizers = new Map();
        VoiceService.activeStreams = new Map();
        
        // Mock voice channel
        voiceChannel = {
            id: 'channel-123',
            guild: {
                id: 'guild-123',
                voiceAdapterCreator: {}
            }
        };

        // Mock user
        user = {
            id: 'user-123'
        };
    });

    afterEach(async () => {
        // Cleanup after each test
        await VoiceService.disconnectAll();
    });

    describe('textToSpeech', () => {
        it('should successfully synthesize and play speech', async () => {
            const text = 'Hello, world!';
            const mockSynthesizer = {
                speakTextAsync: jest.fn((text, resolve) => {
                    resolve({ audioData: Buffer.from('test') });
                }),
                close: jest.fn()
            };
            SpeechSynthesizer.mockReturnValueOnce(mockSynthesizer);

            await VoiceService.textToSpeech(text, voiceChannel);
            
            expect(mockSynthesizer.speakTextAsync).toHaveBeenCalled();
            expect(mockSynthesizer.close).toHaveBeenCalled();
        }, 15000);

        it('should clean up resources on error', async () => {
            const mockSynthesizer = {
                speakTextAsync: jest.fn((text, resolve, reject) => {
                    reject(new Error('Synthesis failed'));
                }),
                close: jest.fn()
            };
            SpeechSynthesizer.mockReturnValueOnce(mockSynthesizer);

            await expect(VoiceService.textToSpeech('test', voiceChannel))
                .rejects.toThrow('Synthesis failed');

            expect(mockSynthesizer.close).toHaveBeenCalled();
        }, 15000);
    });

    describe('startListening', () => {
        it('should start voice recognition', async () => {
            const callback = jest.fn();
            const recognizer = await VoiceService.startListening(voiceChannel, user, callback);
            
            expect(recognizer).toBeDefined();
            expect(VoiceService.activeRecognizers.has(user.id)).toBe(true);
            expect(VoiceService.activeStreams.has(user.id)).toBe(true);
        });

        it('should handle recognition events', async () => {
            const callback = jest.fn();
            await VoiceService.startListening(voiceChannel, user, callback);
            
            const recognizer = VoiceService.activeRecognizers.get(user.id);
            await recognizer.recognized({}, { result: { text: 'Test message' } });
            
            expect(callback).toHaveBeenCalledWith('Test message');
        });

        it('should handle recognition errors', async () => {
            const callback = jest.fn();
            await VoiceService.startListening(voiceChannel, user, callback);
            
            const recognizer = VoiceService.activeRecognizers.get(user.id);
            await recognizer.canceled({}, { 
                reason: 'Error',
                errorCode: 123,
                errorDetails: 'Test error'
            });
            
            expect(VoiceService.activeRecognizers.has(user.id)).toBe(false);
        });
    });

    describe('stopListening', () => {
        it('should cleanup all resources', async () => {
            const recognizer = await VoiceService.startListening(voiceChannel, user, jest.fn());
            await VoiceService.stopListening(user.id);
            
            expect(VoiceService.activeRecognizers.has(user.id)).toBe(false);
            expect(VoiceService.activeStreams.has(user.id)).toBe(false);
        });

        it('should handle cleanup errors gracefully', async () => {
            const mockRecognizer = {
                recognizing: jest.fn(),
                recognized: jest.fn(),
                canceled: jest.fn(),
                sessionStopped: jest.fn(),
                startContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
                stopContinuousRecognitionAsync: jest.fn().mockRejectedValue(new Error('Cleanup failed')),
                close: jest.fn()
            };

            // Add mock stream
            const mockStream = {
                audio: { destroy: jest.fn() },
                decoder: { destroy: jest.fn() }
            };

            // Set up the mocks
            VoiceService.activeStreams.set(user.id, mockStream);
            VoiceService.activeRecognizers.set(user.id, mockRecognizer);

            // Call stopListening and verify cleanup
            await VoiceService.stopListening(user.id);

            // Verify cleanup was attempted even though stopContinuousRecognitionAsync failed
            expect(mockRecognizer.stopContinuousRecognitionAsync).toHaveBeenCalled();
            expect(mockRecognizer.close).toHaveBeenCalled();
            expect(mockStream.audio.destroy).toHaveBeenCalled();
            expect(mockStream.decoder.destroy).toHaveBeenCalled();

            // Verify cleanup was successful
            expect(VoiceService.activeRecognizers.has(user.id)).toBe(false);
            expect(VoiceService.activeStreams.has(user.id)).toBe(false);
        });
    });

    describe('disconnectAll', () => {
        it('should cleanup all connections and sessions', async () => {
            // Setup mock recognizer and connection
            const recognizer = {
                stopContinuousRecognitionAsync: jest.fn().mockResolvedValue(),
                close: jest.fn()
            };
            const connection = {
                destroy: jest.fn()
            };

            // Add mock session
            VoiceService.activeRecognizers.set('test-user', recognizer);
            VoiceService.activeConnections.set('test-guild', connection);

            // Call disconnectAll
            await VoiceService.disconnectAll();

            // Verify cleanup
            expect(recognizer.stopContinuousRecognitionAsync).toHaveBeenCalled();
            expect(recognizer.close).toHaveBeenCalled();
            expect(connection.destroy).toHaveBeenCalled();
            expect(VoiceService.activeRecognizers.size).toBe(0);
            expect(VoiceService.activeConnections.size).toBe(0);
        });
    });
}); 