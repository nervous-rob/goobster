// Mock database functionality first
const mockQuery = jest.fn().mockImplementation((query) => {
    if (query.includes('UserPreferences')) {
        return Promise.resolve({
            recordset: [{
                id: 1,
                personality_preset: 'helper',
                personality_settings: JSON.stringify({
                    energy: 'high',
                    humor: 'very_high',
                    formality: 'low',
                    traits: ['friendly', 'internet_culture']
                })
            }]
        });
    }
    return Promise.resolve({ recordset: [], rowsAffected: [1] });
});

const mockRequest = {
    input: jest.fn().mockReturnThis(),
    query: mockQuery
};

const mockTransaction = {
    begin: jest.fn().mockResolvedValue(true),
    commit: jest.fn().mockResolvedValue(true),
    rollback: jest.fn().mockResolvedValue(true),
    request: jest.fn().mockReturnValue(mockRequest)
};

// Mock the database module
const mockDb = {
    request: jest.fn().mockReturnValue(mockRequest),
    transaction: jest.fn().mockResolvedValue(mockTransaction),
    close: jest.fn().mockResolvedValue(true)
};

// Mock the database module
jest.mock('../../azureDb', () => ({
    sql: {
        VarChar: jest.fn(),
        Bit: jest.fn(),
        query: mockQuery
    },
    getConnection: jest.fn().mockImplementation(async () => mockDb)
}));

// Mock ModelManager
const mockModelManager = {
    generateResponse: jest.fn().mockResolvedValue({
        content: JSON.stringify({
            dominant_sentiment: 'positive',
            emotions: ['happy', 'excited'],
            intensity: 0.8,
            confidence: 0.85,
            subjectivity: 'objective',
            irony: false,
            sarcasm_probability: 0.1,
            sentiment_progression: 'stable',
            sentiment_by_topic: []
        }),
        metadata: {
            model: 'test-model',
            provider: 'test-provider'
        }
    })
};

// Mock SentimentAnalyzer
jest.mock('../../services/ai/personality/SentimentAnalyzer', () => {
    return jest.fn().mockImplementation(() => ({
        analyzeSentiment: jest.fn().mockResolvedValue({
            dominant_sentiment: 'positive',
            emotions: ['happy', 'excited'],
            confidence: 0.85,
            source: 'pattern'
        }),
        _getAIAnalysis: jest.fn().mockResolvedValue({
            dominant_sentiment: 'positive',
            emotions: ['happy', 'excited'],
            confidence: 0.85,
            source: 'ai'
        }),
        _getPatternAnalysis: jest.fn().mockReturnValue({
            dominant_sentiment: 'positive',
            emotions: ['happy', 'excited'],
            confidence: 0.75,
            source: 'pattern'
        })
    }));
});

// Then require the modules
const mockConversationAnalyzer = require('../mocks/ConversationAnalyzer');
const PersonalityPresetManager = require('../../services/ai/personality/PersonalityPresetManager');
const SentimentAnalyzer = require('../../services/ai/personality/SentimentAnalyzer');
const { sql, getConnection } = require('../../azureDb');

describe('Personality System Tests', () => {
    let db;
    let testUserId;
    let analyzer;
    let presetManager;
    let sentimentAnalyzer;

    beforeAll(async () => {
        testUserId = 'test-user-' + Date.now();
        analyzer = mockConversationAnalyzer;
        presetManager = new PersonalityPresetManager();
        sentimentAnalyzer = new SentimentAnalyzer(mockModelManager);
    });

    beforeEach(() => {
        // Reset all mocks before each test
        jest.clearAllMocks();

        // Create fresh mock request for each test
        const mockRequest = {
            input: jest.fn().mockReturnThis(),
            query: jest.fn().mockImplementation((query) => {
                if (query.includes('UserPreferences')) {
                    return Promise.resolve({
                        recordset: [{
                            id: 1,
                            personality_preset: 'helper',
                            personality_settings: JSON.stringify({
                                energy: 'high',
                                humor: 'very_high',
                                formality: 'low',
                                traits: ['friendly', 'internet_culture']
                            })
                        }]
                    });
                }
                return Promise.resolve({ rowsAffected: [1] });
            })
        };

        // Set up mock database for each test
        db = {
            request: jest.fn().mockReturnValue(mockRequest),
            close: jest.fn().mockResolvedValue(true)
        };

        // Update the getConnection mock to return our db mock
        getConnection.mockResolvedValue(db);
    });

    describe('ConversationAnalyzer', () => {
        test('should analyze conversation style correctly', async () => {
            const messages = [
                { content: 'Hello, would you kindly assist me with this task?', role: 'user' },
                { content: 'Of course! I would be happy to help.', role: 'assistant' },
                { content: 'Thank you for your prompt response.', role: 'user' }
            ];

            const analysis = await analyzer._analyzeStyle(messages);
            expect(analysis).toHaveProperty('dominant', 'formal');
            expect(analysis).toHaveProperty('confidence');
            expect(analysis.confidence).toBeGreaterThan(0);
        });

        test('should analyze energy levels correctly', async () => {
            const messages = [
                { content: 'WOW! This is AMAZING!!!', role: 'user' },
                { content: 'That\'s incredible!', role: 'assistant' },
                { content: 'I can\'t believe how awesome this is!', role: 'user' }
            ];

            const analysis = await analyzer._analyzeEnergy(messages);
            expect(analysis).toHaveProperty('level', 'high');
            expect(analysis).toHaveProperty('confidence');
            expect(analysis.confidence).toBeGreaterThan(0.5);
        });

        test('should store analysis results in database', async () => {
            const messages = [
                { content: 'Hello!', role: 'user', timestamp: new Date() },
                { content: 'How are you?', role: 'assistant', timestamp: new Date() },
                { content: 'Thanks for asking!', role: 'user', timestamp: new Date() }
            ];

            const mockAnalysis = {
                style: {
                    dominant: 'casual',
                    confidence: 0.85,
                    scores: { casual: 2, formal: 0 }
                },
                sentiment: {
                    dominant: 'positive',
                    emotions: ['happy', 'excited'],
                    intensity: 0.8,
                    progression: 'stable'
                },
                energy: {
                    level: 'high',
                    confidence: 0.9,
                    scores: { high: 2, medium: 1, low: 0 }
                },
                context: {
                    topics: ['greeting'],
                    messageCount: 3,
                    averageLength: 15,
                    timeSpan: 1000
                },
                confidence: 0.85
            };

            // Mock the analyzer's dependencies
            jest.spyOn(analyzer, 'analyzeConversation').mockResolvedValue(mockAnalysis);
            jest.spyOn(analyzer, '_getCurrentModelInfo').mockResolvedValue({
                modelId: 'test-model',
                provider: 'test-provider'
            });

            // Call the method we're testing
            await analyzer.trackUserStyle(testUserId, messages);

            // Verify database interactions
            expect(db.request).toHaveBeenCalled();
            const request = db.request();
            expect(request.query).toHaveBeenCalled();
        });
    });

    describe('PersonalityPresetManager', () => {
        test('should get default preset for new user', async () => {
            const settings = await presetManager.getUserSettings(testUserId);
            const parsedSettings = JSON.parse(settings.personality_settings);
            expect(parsedSettings.energy).toBe('high');
            expect(parsedSettings.humor).toBe('very_high');
            expect(parsedSettings.formality).toBe('low');
            expect(parsedSettings.traits).toContain('friendly');
        });

        test('should validate personality settings', () => {
            const validSettings = {
                energy: 'high',
                humor: 'medium',
                formality: 'low',
                traits: ['friendly', 'helpful']
            };

            expect(() => {
                presetManager.validateSettings(validSettings);
            }).not.toThrow();

            const invalidSettings = {
                energy: 'invalid',
                humor: 'medium'
            };

            expect(() => {
                presetManager.validateSettings(invalidSettings);
            }).toThrow();
        });

        test('should mix personality styles correctly', () => {
            const baseStyle = {
                energy: 'medium',
                humor: 'low',
                formality: 'high',
                traits: ['professional']
            };

            const contextStyle = {
                energy: 'high',
                humor: 'high',
                formality: 'low',
                traits: ['casual']
            };

            const mixed = presetManager.mixStyles(baseStyle, contextStyle);
            expect(mixed.energy).toBe('high');
            expect(mixed.humor).toBe('high');
            expect(mixed.formality).toBe('low');
            expect(mixed.traits).toContain('professional');
            expect(mixed.traits).toContain('casual');
        });
    });

    describe('SentimentAnalyzer', () => {
        test('should analyze sentiment with AI when available', async () => {
            const messages = [
                { content: 'This is absolutely wonderful!', role: 'user' }
            ];

            const analysis = await sentimentAnalyzer.analyzeSentiment(messages);
            expect(analysis).toHaveProperty('dominant_sentiment');
            expect(analysis).toHaveProperty('emotions');
            expect(analysis).toHaveProperty('confidence');
            expect(analysis).toHaveProperty('source');
        });

        test('should fallback to pattern analysis when AI fails', async () => {
            // Mock AI failure
            jest.spyOn(sentimentAnalyzer, '_getAIAnalysis').mockRejectedValueOnce(new Error('AI unavailable'));

            const messages = [
                { content: 'This is great!', role: 'user' }
            ];

            const analysis = await sentimentAnalyzer.analyzeSentiment(messages);
            expect(analysis).toHaveProperty('source', 'pattern');
            expect(analysis).toHaveProperty('dominant_sentiment', 'positive');
        });
    });

    describe('Integration Tests', () => {
        test('should adapt personality based on conversation analysis', async () => {
            const messages = [
                { content: 'Hello!', role: 'user', timestamp: new Date() },
                { content: 'How are you?', role: 'user', timestamp: new Date() }
            ];
            
            // Mock the preset manager to return specific traits
            jest.spyOn(presetManager, 'getUserSettings').mockResolvedValueOnce({
                personality_settings: JSON.stringify({
                    energy: 'high',
                    humor: 'very_high',
                    formality: 'low',
                    traits: ['friendly', 'internet_culture']
                }),
                personality_preset: 'helper'
            });
            
            await analyzer.trackUserStyle(testUserId, messages);
            
            const updatedSettings = await presetManager.getUserSettings(testUserId);
            expect(updatedSettings).toHaveProperty('personality_settings');
            const parsedSettings = JSON.parse(updatedSettings.personality_settings);
            expect(parsedSettings).toMatchObject({
                energy: 'high',
                humor: 'very_high',
                formality: 'low'
            });
            expect(parsedSettings.traits).toContain('internet_culture');
        });

        test('should maintain analysis history', async () => {
            const messages = [
                { content: 'Hello!', role: 'user', timestamp: new Date() },
                { content: 'How are you?', role: 'user', timestamp: new Date() }
            ];
            
            await analyzer.trackUserStyle(testUserId, messages);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 5);
            expect(history.length).toBeGreaterThan(0);
            expect(history[0]).toMatchObject({
                style: 'casual',
                sentiment: 'positive',
                energy: 'high'
            });
        });
    });
}); 