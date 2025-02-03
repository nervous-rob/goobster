const { Client, GuildChannel, ThreadChannel } = require('discord.js');
const VoiceService = require('../../services/voice');
const AudioPipeline = require('../../services/voice/audioPipeline');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Mock audio data generator
class MockAudioStream extends Readable {
    constructor(options = {}) {
        super(options);
        this.frameSize = 960; // Standard Opus frame size
        this.sampleRate = 48000;
        this.isReading = true;
        this.destroyed = false;
    }

    _read() {
        if (this.isReading && !this.destroyed) {
            // Generate mock audio data (silence)
            const buffer = Buffer.alloc(this.frameSize * 2); // 16-bit samples
            this.push(buffer);
        }
    }

    // Helper method to simulate stream end
    end() {
        this.isReading = false;
        this.push(null);
        // Wait for internal buffer to clear before destroying
        process.nextTick(() => {
            this.destroy();
        });
    }

    // Helper method to simulate error
    simulateError(error) {
        this.isReading = false;
        this.destroy(error);
    }

    destroy(error) {
        if (!this.destroyed) {
            this.destroyed = true;
            this.isReading = false;
            if (error) {
                this.emit('error', error);
            }
            super.destroy(error);
        }
    }
}

// Mock the AudioPipeline class
jest.mock('../../services/voice/audioPipeline', () => {
    return jest.fn().mockImplementation(() => {
        const transform = new (require('stream').Transform)({
            transform(chunk, encoding, callback) {
                callback(null, chunk);
            }
        });

        transform.start = jest.fn().mockImplementation(async (inputStream, pushStream) => {
            if (!inputStream || !pushStream) {
                throw new Error('Invalid stream arguments');
            }

            // Set up error handler for input stream
            inputStream.on('error', (error) => {
                console.log('Input stream error detected');
                pushStream.close();
                transform.destroy(error);
            });

            // Set up pipe and error handling
            inputStream.pipe(transform);
            transform.on('error', (error) => {
                console.log('Transform error detected');
                pushStream.close();
                inputStream.destroy();
            });

            // Return cleanup function
            return () => {
                inputStream.destroy();
                pushStream.close();
                transform.destroy();
            };
        });

        transform.destroy = jest.fn().mockImplementation(function(error) {
            if (error) {
                console.log('Transform destroy called with error');
                this.emit('error', error);
            }
            require('stream').Transform.prototype.destroy.call(this, error);
        });

        return transform;
    });
});

describe('Voice Transcription Integration', () => {
    let voiceService;
    let mockVoiceChannel;
    let mockTextChannel;
    let mockThread;
    let mockUser;
    let mockClient;
    let mockConnection;
    let mockReceiver;
    let audioStream;

    beforeAll(() => {
        // Ensure environment variables are set from jest config
        expect(process.env.AZURE_SPEECH_KEY).toBeDefined();
        expect(process.env.AZURE_SPEECH_REGION).toBeDefined();
        
        // Create config object with required properties
        const config = {
            azureSpeech: {
                key: process.env.AZURE_SPEECH_KEY,
                region: process.env.AZURE_SPEECH_REGION
            }
        };
        
        voiceService = new VoiceService(config);
    });

    beforeEach(() => {
        // Mock Discord.js client
        mockClient = new Client({ intents: [] });
        
        // Mock user
        mockUser = {
            id: 'test-user-123',
            username: 'TestUser'
        };

        // Mock voice channel
        mockVoiceChannel = {
            id: 'voice-channel-123',
            guild: {
                id: 'guild-123',
                voiceAdapterCreator: jest.fn()
            },
            permissionsFor: jest.fn().mockReturnValue({
                has: jest.fn().mockReturnValue(true)
            }),
            parent: {
                type: 0, // GUILD_CATEGORY
                children: {
                    cache: new Map()
                }
            }
        };

        // Mock text channel
        mockTextChannel = {
            id: 'text-channel-123',
            isTextBased: jest.fn().mockReturnValue(true),
            isVoiceBased: jest.fn().mockReturnValue(false),
            type: 0, // GUILD_TEXT
            threads: {
                cache: new Map(),
                fetch: jest.fn().mockResolvedValue({ size: 0 }),
                create: jest.fn()
            },
            permissionsFor: jest.fn().mockReturnValue({
                has: jest.fn().mockReturnValue(true)
            })
        };

        // Link text channel to voice channel's parent
        mockVoiceChannel.parent.children.cache.set(mockTextChannel.id, mockTextChannel);

        // Mock thread
        mockThread = {
            id: 'thread-123',
            name: `transcription-${mockUser.id}`,
            send: jest.fn().mockResolvedValue({}),
            members: {
                add: jest.fn().mockResolvedValue({})
            },
            archived: false,
            setArchived: jest.fn().mockResolvedValue({})
        };

        // Update audio stream mock
        audioStream = new MockAudioStream();
        
        // Mock the Azure Speech SDK push stream with proper event emitter
        const mockPushStream = new (require('events').EventEmitter)();
        mockPushStream.write = jest.fn().mockReturnValue(true);
        mockPushStream.close = jest.fn();

        // Mock AudioInputStream.createPushStream
        const mockAudioInputStream = require('microsoft-cognitiveservices-speech-sdk').AudioInputStream;
        mockAudioInputStream.createPushStream.mockReturnValue(mockPushStream);

        // Mock recognition service
        const mockRecognizer = {
            recognizing: jest.fn(),
            recognized: jest.fn(),
            canceled: jest.fn(),
            sessionStopped: jest.fn(),
            startContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
            stopContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
            close: jest.fn()
        };

        // Mock the recognition service setup
        voiceService.recognition.setupRecognizer = jest.fn().mockImplementation((userId, audioConfig, callback) => {
            const recognizer = mockRecognizer;
            voiceService.recognition.activeRecognizers = voiceService.recognition.activeRecognizers || new Map();
            voiceService.recognition.activeRecognizers.set(userId, recognizer);
            return recognizer;
        });

        // Mock voice connection and receiver
        mockReceiver = {
            subscribe: jest.fn().mockReturnValue(audioStream)
        };
        
        mockConnection = {
            receiver: mockReceiver,
            destroy: jest.fn(),
            state: { status: 'ready' }
        };

        // Mock connection creation
        voiceService.connection.createConnection = jest.fn().mockResolvedValue(mockConnection);

        // Mock thread service
        const mockThreadService = {
            getOrCreateThread: jest.fn().mockImplementation(async (textChannel, userId) => {
                const existingThread = textChannel.threads.cache.get(`transcription-${userId}`);
                if (existingThread) {
                    if (existingThread.archived) {
                        await existingThread.setArchived(false);
                    }
                    return existingThread;
                }
                return mockThread;
            })
        };

        // Attach thread service to voice service
        voiceService.threadService = mockThreadService;
    });

    afterEach(() => {
        jest.clearAllMocks();
        if (audioStream) {
            audioStream.destroy();
        }
    });

    describe('Full Pipeline Tests', () => {
        it('should process voice input and create transcription', async () => {
            // Mock thread creation
            mockTextChannel.threads.create.mockResolvedValue(mockThread);

            // Setup test data
            const testAudioData = Buffer.from('test audio data');
            const expectedTranscription = 'Hello, world!';

            // Start transcription
            const messageCallback = jest.fn();
            const connection = await voiceService.startListening(mockVoiceChannel, mockUser, messageCallback);

            // Push some test audio data
            audioStream.push(testAudioData);
            
            // Properly end the stream
            audioStream.end();
            
            // Wait for processing with longer timeout
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify pipeline setup
            expect(voiceService.connection.createConnection).toHaveBeenCalledWith(mockVoiceChannel);
            expect(mockReceiver.subscribe).toHaveBeenCalledWith(mockUser.id, expect.any(Object));
            
            // Cleanup
            await voiceService.stopListening(mockUser.id);
            expect(connection.destroy).toHaveBeenCalled();
        });

        it('should handle recognition service errors gracefully', async () => {
            // Mock recognition error first
            const mockRecognizer = {
                recognizing: jest.fn(),
                recognized: jest.fn(),
                canceled: jest.fn(),
                sessionStopped: jest.fn(),
                startContinuousRecognitionAsync: jest.fn().mockRejectedValue(new Error('Recognition failed')),
                stopContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
                close: jest.fn()
            };

            // Mock the recognition service setup to simulate error
            voiceService.recognition.setupRecognizer = jest.fn().mockImplementation((userId, audioConfig, callback) => {
                const recognizer = mockRecognizer;
                voiceService.recognition.activeRecognizers = voiceService.recognition.activeRecognizers || new Map();
                voiceService.recognition.activeRecognizers.set(userId, recognizer);
                return recognizer;
            });

            // Start transcription and expect it to fail
            const messageCallback = jest.fn();
            await expect(
                voiceService.startListening(mockVoiceChannel, mockUser, messageCallback)
            ).rejects.toThrow('Recognition failed');

            // Verify cleanup
            expect(mockConnection.destroy).toHaveBeenCalled();
            expect(mockRecognizer.close).toHaveBeenCalled();
        });

        it('should handle audio pipeline errors gracefully', async () => {
            const messageCallback = jest.fn();
            
            // Create promises to track error events
            const errorPromise = new Promise(resolve => {
                voiceService.once('voiceError', resolve);
            });
            
            const startListeningPromise = voiceService.startListening(mockVoiceChannel, mockUser, messageCallback);
            
            // Wait for the pipeline to be set up
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Simulate error after pipeline is set up
            const error = new Error('Audio processing failed');
            audioStream.destroy(error);

            // Wait for error to be handled by voice service
            await errorPromise;
            
            // Verify cleanup occurred
            expect(mockConnection.destroy).toHaveBeenCalled();
        });
    });

    describe('Thread Management', () => {
        it('should reuse existing thread if available', async () => {
            // Mock existing thread
            const existingThread = { ...mockThread };
            mockTextChannel.threads.cache.set(existingThread.id, existingThread);
            mockTextChannel.threads.fetch.mockResolvedValue({
                size: 1,
                find: () => existingThread
            });

            const messageCallback = jest.fn();
            await voiceService.startListening(mockVoiceChannel, mockUser, messageCallback);

            expect(mockTextChannel.threads.create).not.toHaveBeenCalled();
            expect(existingThread.setArchived).not.toHaveBeenCalled();

            // Cleanup
            await voiceService.stopListening(mockUser.id);
        });

        it('should unarchive existing archived thread', async () => {
            // Mock archived thread with proper mock functions
            const archivedThread = { 
                ...mockThread, 
                id: `transcription-${mockUser.id}`,
                archived: true,
                setArchived: jest.fn().mockResolvedValue(true)
            };
            archivedThread.setArchived.mockImplementation(async (archived) => {
                archivedThread.archived = archived;
                return archivedThread;
            });

            // Set up thread cache and fetch mock
            mockTextChannel.threads.cache.set(archivedThread.id, archivedThread);
            mockTextChannel.threads.fetch.mockResolvedValue({
                size: 1,
                find: () => archivedThread
            });

            // Start listening with text channel
            const messageCallback = jest.fn();
            await voiceService.startListening(mockVoiceChannel, mockUser, messageCallback);

            // Wait for thread operations to complete
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify thread was unarchived
            expect(archivedThread.setArchived).toHaveBeenCalledWith(false);
            expect(archivedThread.archived).toBe(false);

            // Cleanup
            await voiceService.stopListening(mockUser.id);
        });
    });
}); 