// Mock dependencies before requiring the module
jest.mock('@discordjs/voice', () => ({
    createAudioPlayer: jest.fn(),
    createAudioResource: jest.fn(),
    joinVoiceChannel: jest.fn(),
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

jest.mock('microsoft-cognitiveservices-speech-sdk', () => ({
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
    SpeechSynthesizer: jest.fn(),
    SpeechRecognizer: jest.fn(),
    CancellationReason: {
        Error: 'Error'
    }
}));

// Mock modules
const mockRateLimiter = {
    canUseVoice: jest.fn(),
    getRemainingVoiceTime: jest.fn(),
    formatTimeRemaining: jest.fn(),
    trackVoiceUsage: jest.fn()
};

const mockVoiceService = {
    startListening: jest.fn(),
    stopListening: jest.fn(),
    textToSpeech: jest.fn(),
    disconnectAll: jest.fn()
};

jest.mock('../../services/voice', () => mockVoiceService);
jest.mock('../../utils/rateLimit', () => mockRateLimiter);
jest.mock('../../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn()
}));

// Now require the modules
const voice = require('../../commands/chat/voice');
const voiceService = require('../../utils/voiceServices');
const rateLimiter = require('../../utils/rateLimit');
const { handleChatInteraction } = require('../../utils/chatHandler');

describe('Voice Command', () => {
    let interaction;
    const userId = 'user-123';
    const guildId = 'guild-123';
    const channelId = 'channel-123';

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();
        jest.resetAllMocks();

        // Mock interaction
        interaction = {
            options: {
                getSubcommand: jest.fn(),
            },
            member: {
                voice: {
                    channel: {
                        id: channelId,
                        guild: {
                            id: guildId,
                            voiceAdapterCreator: {}
                        }
                    }
                }
            },
            guildId,
            user: { id: userId },
            reply: jest.fn().mockResolvedValue(undefined),
            editReply: jest.fn().mockResolvedValue(undefined),
            deferReply: jest.fn().mockResolvedValue(undefined),
            client: {
                on: jest.fn(),
                off: jest.fn(),
                user: { id: 'bot-123' }
            }
        };

        // Mock rate limiter responses
        mockRateLimiter.canUseVoice.mockResolvedValue(true);
        mockRateLimiter.getRemainingVoiceTime.mockResolvedValue(300000);
        mockRateLimiter.formatTimeRemaining.mockReturnValue('5m 0s');

        // Mock voice service
        mockVoiceService.startListening.mockResolvedValue({});
        mockVoiceService.stopListening.mockResolvedValue();
        mockVoiceService.textToSpeech.mockResolvedValue();
    });

    afterEach(async () => {
        // Cleanup
        await voice.cleanup(userId, interaction.client);
    });

    describe('Start Command', () => {
        beforeEach(() => {
            interaction.options.getSubcommand.mockReturnValue('start');
        });

        it('should start voice session', async () => {
            await voice.execute(interaction);
            expect(mockVoiceService.startListening).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Voice interaction started')
                })
            );
        });

        it('should handle rate limit exceeded', async () => {
            interaction.options.getSubcommand.mockReturnValue('start');
            mockRateLimiter.canUseVoice.mockResolvedValue(false);
            mockRateLimiter.getRemainingVoiceTime.mockResolvedValue(0);
            mockRateLimiter.formatTimeRemaining.mockReturnValue('1h 0m');

            await voice.execute(interaction);
            
            expect(interaction.deferReply).not.toHaveBeenCalled();
            expect(interaction.reply).toHaveBeenCalledWith({
                content: expect.stringContaining('voice chat limit'),
                ephemeral: true
            });
        });

        it('should prevent multiple sessions', async () => {
            // Mock active session check
            mockVoiceService.startListening.mockRejectedValueOnce(new Error('Session already active'));
            
            await voice.execute(interaction);
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Failed to start voice interaction'),
                    ephemeral: true
                })
            );
        });

        it('should handle voice processing', async () => {
            const mockCallback = jest.fn();
            mockVoiceService.startListening.mockImplementation((channel, user, callback) => {
                // Store callback for later use
                mockCallback.mockImplementation(callback);
                return Promise.resolve({});
            });

            await voice.execute(interaction);
            expect(mockCallback).toBeDefined();

            // Simulate voice input
            const mockResponse = 'AI response';
            const { handleChatInteraction } = require('../../utils/chatHandler');
            handleChatInteraction.mockResolvedValueOnce(mockResponse);
            
            await mockCallback('test message');
            expect(handleChatInteraction).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({
                    getString: expect.any(Function)
                })
            }));
            expect(mockVoiceService.textToSpeech).toHaveBeenCalledWith(
                mockResponse,
                interaction.member.voice.channel
            );
        });
    });

    describe('Stop Command', () => {
        beforeEach(() => {
            interaction.options.getSubcommand.mockReturnValue('stop');
        });

        it('should stop voice session', async () => {
            interaction.options.getSubcommand.mockReturnValue('stop');
            mockVoiceService.stopListening.mockResolvedValue();
            
            await voice.execute(interaction);
            
            expect(mockVoiceService.stopListening).toHaveBeenCalledWith(userId);
            expect(interaction.reply).toHaveBeenCalledWith({
                content: 'Voice interaction stopped.',
                ephemeral: true
            });
        });
    });

    describe('Error Handling', () => {
        it('should handle voice service errors', async () => {
            interaction.options.getSubcommand.mockReturnValue('start');
            mockVoiceService.startListening.mockRejectedValueOnce(new Error('Test error'));
            
            await voice.execute(interaction);
            expect(interaction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Failed to start voice interaction'),
                    ephemeral: true
                })
            );
        });

        it('should handle voice processing errors', async () => {
            interaction.options.getSubcommand.mockReturnValue('start');
            const mockCallback = jest.fn();
            mockVoiceService.startListening.mockImplementation((channel, user, callback) => {
                mockCallback.mockImplementation(callback);
                return Promise.resolve({});
            });

            await voice.execute(interaction);
            expect(mockCallback).toBeDefined();

            // Simulate error during voice processing
            const { handleChatInteraction } = require('../../utils/chatHandler');
            handleChatInteraction.mockRejectedValueOnce(new Error('Processing error'));
            
            await mockCallback('test message');
            
            expect(mockVoiceService.textToSpeech).toHaveBeenCalledWith(
                'I encountered an error processing your request. Please try again.',
                interaction.member.voice.channel
            );
        });
    });
}); 