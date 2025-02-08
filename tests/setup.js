// Mock ModelManager first
jest.mock('../services/ai/ModelManager', () => {
    class MockModelManager {
        constructor() {
            this.providers = new Map();
            this.fallbackOrder = ['openai', 'anthropic', 'google'];
            this.rateLimits = new Map();
        }

        async initialize() {
            return Promise.resolve();
        }

        async generateResponse({ prompt, capability = 'chat', options = {} }) {
            return {
                content: 'Test response',
                metadata: {
                    model: 'test-model',
                    provider: 'test-provider',
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 20,
                        total_tokens: 30
                    }
                }
            };
        }

        getRateLimitStatus() {
            return {
                openai: {
                    isLimited: false,
                    currentRequests: 0,
                    currentTokens: 0,
                    maxRequestsPerMinute: 60,
                    maxTokensPerMinute: 90000,
                    timeUntilReset: 0
                }
            };
        }
    }

    const instance = new MockModelManager();
    return instance;
});

// Mock SQL functionality
const mockQuery = jest.fn().mockImplementation(function() {
    // Handle both template literals and regular function calls
    let query = '';
    if (arguments[0] && arguments[0].raw) {
        // Template literal
        const strings = arguments[0];
        const values = Array.prototype.slice.call(arguments, 1);
        query = strings.reduce((acc, str, i) => 
            acc + str + (values[i] ? values[i].toString() : ''), '');
    } else {
        // Regular function call
        query = arguments[0];
    }
    
    // Return mock data based on the query
    if (query.includes('SELECT') && query.includes('UserPreferences')) {
        return Promise.resolve({
            recordset: [{
                id: 1,
                userId: 'test-user',
                personality_preset: 'helper',
                personality_settings: JSON.stringify({
                    energy: 'medium',
                    humor: 'medium',
                    formality: 'medium',
                    traits: ['helpful', 'friendly']
                }),
                memeMode: false
            }]
        });
    } else if (query.includes('SELECT') && query.includes('conversation_analysis')) {
        return Promise.resolve({
            recordset: Array(2).fill({
                id: 'test-analysis-id',
                user_id: 'test-user-id',
                analysis_data: JSON.stringify({
                    style: query.includes('memeMode = 1') ? 'meme' : 'casual',
                    formality: 'low',
                    energy: 'high',
                    sentiment: 'positive',
                    emotions: ['happy', 'excited']
                }),
                created_at: new Date().toISOString()
            })
        });
    } else if (query.includes('INSERT') || query.includes('UPDATE')) {
        return Promise.resolve({ rowsAffected: [1] });
    }
    return Promise.resolve({ recordset: [] });
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

const mockPool = {
    request: jest.fn().mockReturnValue(mockRequest),
    transaction: jest.fn().mockResolvedValue(mockTransaction),
    close: jest.fn().mockResolvedValue(true)
};

jest.mock('../azureDb', () => ({
    sql: {
        VarChar: jest.fn(),
        Bit: jest.fn(),
        query: mockQuery
    },
    getConnection: jest.fn().mockResolvedValue(mockPool)
}));

// Mock PersonalityAdapter
const mockPersonalityAdapter = {
    analyzer: {
        analyzeConversation: jest.fn().mockResolvedValue({
            style: 'casual',
            formality: 'low',
            energy: 'high',
            sentiment: 'positive',
            emotions: ['happy', 'excited']
        }),
        trackUserStyle: jest.fn().mockResolvedValue(true),
        getUserAnalysisHistory: jest.fn().mockResolvedValue([{
            timestamp: new Date().toISOString(),
            style: 'casual',
            formality: 'low',
            energy: 'high',
            sentiment: 'positive',
            emotions: ['happy', 'excited']
        }])
    },
    enhancePrompt: jest.fn().mockImplementation((prompt, userId) => {
        return Promise.resolve({
            enhancedPrompt: prompt,
            traits: ['friendly', 'casual', 'energetic'],
            style: 'casual'
        });
    }),
    getUserPersonality: jest.fn().mockResolvedValue({
        traits: ['friendly', 'casual', 'energetic'],
        style: 'casual',
        formality: 'low',
        energy: 'high'
    })
};

jest.mock('../services/ai/PersonalityAdapter', () => ({
    PersonalityAdapter: jest.fn().mockImplementation(() => mockPersonalityAdapter)
}));

// Mock PromptManager
jest.mock('../services/ai/PromptManager', () => {
    return class MockPromptManager {
        constructor() {
            this.getPrompt = jest.fn().mockResolvedValue('Test prompt');
            this.getEnhancedPrompt = jest.fn().mockResolvedValue({
                prompt: 'Enhanced test prompt',
                personality: {
                    energy: 'medium',
                    humor: 'medium',
                    formality: 'medium'
                }
            });
            this.isMemeModeEnabled = jest.fn().mockResolvedValue(false);
            this.enhancePromptWithPersonality = jest.fn().mockResolvedValue({
                prompt: 'Enhanced test prompt',
                personality: {
                    energy: 'medium',
                    humor: 'medium',
                    formality: 'medium'
                }
            });
        }
    };
});

// Mock other dependencies
jest.mock('@anthropic-ai/sdk');
jest.mock('@google/generative-ai');
jest.mock('openai');

jest.mock('../config.json', () => ({
    openaiKey: 'test-openai-key',
    anthropicKey: 'test-anthropic-key',
    googleAIKey: 'test-google-key',
    perplexity: {
        apiKey: 'test-perplexity-key'
    }
}));

const mockPersonalityPresetManager = {
    getUserSettings: jest.fn().mockImplementation((userId) => {
        return Promise.resolve({
            personality_settings: JSON.stringify({
                energy: 'high',
                humor: 'very_high',
                formality: 'low',
                traits: ['friendly', 'casual', 'energetic']
            }),
            personality_preset: 'helper',
            preset: 'helper',
            userId: userId || 'test-user'
        });
    }),
    setUserPreset: jest.fn().mockImplementation((userId, preset) => {
        return Promise.resolve({
            personality_settings: JSON.stringify({
                energy: preset === 'meme' ? 'high' : 'medium',
                humor: preset === 'meme' ? 'very_high' : 'medium',
                formality: preset === 'meme' ? 'low' : 'medium',
                traits: preset === 'meme' ? ['internet_culture', 'casual'] : ['helpful', 'friendly']
            }),
            personality_preset: preset,
            preset: preset,
            userId: userId
        });
    }),
    validateSettings: jest.fn().mockImplementation((settings) => {
        if (!settings.energy || !settings.humor || !settings.formality) {
            throw new Error('Invalid settings');
        }
        return true;
    }),
    mixStyles: jest.fn().mockImplementation((baseStyle, contextStyle) => {
        return {
            energy: contextStyle.energy || baseStyle.energy,
            humor: contextStyle.humor || baseStyle.humor,
            formality: contextStyle.formality || baseStyle.formality,
            traits: [...new Set([...(baseStyle.traits || []), ...(contextStyle.traits || [])])]
        };
    }),
    updateUserSettings: jest.fn().mockImplementation((userId, settings) => {
        return Promise.resolve({
            personality_settings: JSON.stringify(settings),
            personality_preset: 'custom',
            preset: 'custom',
            userId: userId
        });
    })
};

jest.mock('../services/ai/personality/PersonalityPresetManager', () => {
    return jest.fn().mockImplementation(() => mockPersonalityPresetManager);
});

const mockConversationAnalyzer = {
    analyzeConversation: jest.fn().mockResolvedValue({
        style: 'casual',
        formality: 'low',
        energy: 'high',
        sentiment: 'positive',
        emotions: ['happy', 'excited'],
        confidence: 0.85
    }),
    trackUserStyle: jest.fn().mockResolvedValue(true),
    getUserAnalysisHistory: jest.fn().mockResolvedValue([{
        timestamp: new Date().toISOString(),
        style: 'casual',
        formality: 'low',
        energy: 'high',
        sentiment: 'positive',
        emotions: ['happy', 'excited']
    }]),
    _validateMessages: jest.fn().mockReturnValue(true),
    _updateUserPersonality: jest.fn().mockResolvedValue(true),
    _analyzeStyle: jest.fn().mockResolvedValue({
        dominant: 'formal',
        confidence: 0.85,
        formality: 'high',
        energy: 'medium'
    }),
    _analyzeEnergy: jest.fn().mockResolvedValue({
        level: 'high',
        confidence: 0.85
    }),
    _getPatternAnalysis: jest.fn().mockReturnValue({
        style: 'casual',
        formality: 'low',
        energy: 'high',
        sentiment: 'positive',
        emotions: ['happy', 'excited'],
        confidence: 0.75
    })
};

jest.mock('../services/ai/personality/ConversationAnalyzer', () => {
    return jest.fn().mockImplementation(() => mockConversationAnalyzer);
});

const mockSentimentAnalyzer = {
    analyzeSentiment: jest.fn().mockImplementation((messages) => {
        return Promise.resolve({
            sentiment: 'positive',
            emotions: ['happy', 'excited'],
            confidence: 0.85
        });
    }),
    _getAIAnalysis: jest.fn().mockResolvedValue({
        sentiment: 'positive',
        emotions: ['happy', 'excited'],
        confidence: 0.85
    }),
    _getPatternAnalysis: jest.fn().mockReturnValue({
        sentiment: 'positive',
        emotions: ['happy', 'excited'],
        confidence: 0.75
    })
};

jest.mock('../services/ai/personality/SentimentAnalyzer', () => {
    return jest.fn().mockImplementation(() => mockSentimentAnalyzer);
});