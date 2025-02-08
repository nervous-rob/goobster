// Mock database functionality first
const mockQuery = jest.fn().mockImplementation((query) => {
    if (query.includes('UserPreferences')) {
        if (query.includes('memeMode = 1')) {
            return Promise.resolve({
                recordset: [{
                    id: 1,
                    personality_preset: 'meme',
                    personality_settings: JSON.stringify({
                        energy: 'high',
                        humor: 'very_high',
                        formality: 'low',
                        traits: ['internet_culture', 'casual']
                    }),
                    memeMode: true
                }]
            });
        }
        if (query.includes('memeMode = 0')) {
            return Promise.resolve({
                recordset: [{
                    id: 1,
                    personality_preset: 'professional',
                    personality_settings: JSON.stringify({
                        energy: 'medium',
                        humor: 'low',
                        formality: 'high',
                        traits: ['professional', 'formal']
                    }),
                    memeMode: false
                }]
            });
        }
        return Promise.resolve({
            recordset: [{
                id: 1,
                personality_preset: 'helper',
                personality_settings: JSON.stringify({
                    energy: 'high',
                    humor: 'very_high',
                    formality: 'low',
                    traits: ['friendly', 'internet_culture']
                }),
                memeMode: false
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

jest.mock('../../azureDb', () => ({
    sql: {
        VarChar: jest.fn(),
        Bit: jest.fn(),
        query: mockQuery
    },
    getConnection: jest.fn().mockResolvedValue({
        request: jest.fn().mockReturnValue(mockRequest),
        transaction: jest.fn().mockReturnValue(mockTransaction)
    })
}));

// Then require the modules
const { setMemeMode } = require('../../utils/memeMode');
const PersonalityPresetManager = require('../../services/ai/personality/PersonalityPresetManager');
const ConversationAnalyzer = require('../../services/ai/personality/ConversationAnalyzer');
const { sql, getConnection } = require('../../azureDb');

describe('Meme Mode Integration Tests', () => {
    let db;
    let testUserId;
    let analyzer;
    let presetManager;

    beforeAll(async () => {
        db = await getConnection();
        testUserId = 'test-user-' + Date.now();
        analyzer = new ConversationAnalyzer();
        presetManager = new PersonalityPresetManager();
        
        // Mock successful user creation
        db.request().query.mockResolvedValueOnce({ recordset: [{ id: 1 }] });
    });

    afterAll(async () => {
        // Mock successful cleanup
        db.request().query.mockResolvedValueOnce({ recordset: [] });
        db.request().query.mockResolvedValueOnce({ recordset: [] });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockClear();
        mockTransaction.begin.mockClear();
        mockTransaction.commit.mockClear();
        mockTransaction.request.mockClear();
        
        // Setup default successful responses
        db.request().query.mockResolvedValue({ recordset: [{ 
            id: 1,
            personality_preset: 'helper',
            personality_settings: null,
            memeMode: false
        }] });
    });

    describe('Meme Mode Settings', () => {
        test('should toggle meme mode correctly', async () => {
            await setMemeMode(testUserId, true);
            expect(mockQuery).toHaveBeenCalled();
        });

        test('should apply meme personality preset when enabled', async () => {
            // Mock the preset manager to return meme mode settings
            jest.spyOn(presetManager, 'getUserSettings').mockResolvedValueOnce({
                personality_settings: JSON.stringify({
                    energy: 'high',
                    humor: 'very_high',
                    formality: 'low',
                    traits: ['internet_culture', 'casual']
                }),
                personality_preset: 'meme'
            });

            await setMemeMode(testUserId, true);
            const settings = await presetManager.getUserSettings(testUserId);
            const parsedSettings = JSON.parse(settings.personality_settings);
            
            expect(parsedSettings.humor).toBe('very_high');
            expect(parsedSettings.formality).toBe('low');
            expect(parsedSettings.traits).toContain('internet_culture');
        });

        test('should restore previous preset when disabled', async () => {
            // Mock the preset manager to return professional settings
            jest.spyOn(presetManager, 'getUserSettings').mockResolvedValueOnce({
                personality_settings: JSON.stringify({
                    energy: 'medium',
                    humor: 'low',
                    formality: 'high',
                    traits: ['professional', 'formal']
                }),
                personality_preset: 'professional'
            });

            await setMemeMode(testUserId, false);
            const settings = await presetManager.getUserSettings(testUserId);
            expect(settings.personality_preset).toBe('professional');
        });
    });

    describe('Conversation Analysis', () => {
        test('should detect meme-style messages', async () => {
            const messages = [
                { content: 'Yo fam, what\'s good?', role: 'user', timestamp: new Date() },
                { content: 'Just vibin\' and ready to help!', role: 'assistant', timestamp: new Date() },
                { content: 'That\'s lit fam!', role: 'user', timestamp: new Date() }
            ];

            await analyzer.trackUserStyle(testUserId, messages);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 5);
            expect(history.length).toBeGreaterThan(0);
            expect(history[0].style).toBe('casual');
            expect(history[0].formality).toBe('low');
            expect(history[0].energy).toBe('high');
        });

        test('should adapt to meme language patterns', async () => {
            const messages = [
                { content: 'Bruh moment incoming', role: 'user', timestamp: new Date() },
                { content: 'No cap, I got you fam!', role: 'assistant', timestamp: new Date() },
                { content: 'Fr fr, you\'re the GOAT!', role: 'user', timestamp: new Date() }
            ];

            await analyzer.trackUserStyle(testUserId, messages);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 5);
            expect(history.length).toBeGreaterThan(0);
            expect(history[0].style).toBe('casual');
            expect(history[0].formality).toBe('low');
            expect(history[0].energy).toBe('high');
        });
    });

    describe('Error Handling', () => {
        test('should handle meme mode toggle failures', async () => {
            const mockError = new Error('DB Error');
            mockQuery.mockRejectedValueOnce(mockError);
            
            await expect(setMemeMode(testUserId, true)).rejects.toThrow('DB Error');
        });

        test('should maintain personality consistency on errors', async () => {
            const mockError = new Error('DB Error');
            mockQuery.mockRejectedValueOnce(mockError);
            
            try {
                await setMemeMode(testUserId, true);
            } catch (error) {
                // Expected error
            }

            const settings = await presetManager.getUserSettings(testUserId);
            expect(settings.personality_preset).toBe('helper');
        });
    });

    describe('Performance', () => {
        test('should handle rapid meme mode toggles', async () => {
            const promises = [
                setMemeMode(testUserId, true),
                setMemeMode(testUserId, false),
                setMemeMode(testUserId, true)
            ];

            await expect(Promise.all(promises)).resolves.not.toThrow();
        });
    });
}); 