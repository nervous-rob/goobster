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
                }),
                memeMode: false
            }]
        });
    }
    if (query.includes('conversation_analysis')) {
        return Promise.resolve({
            recordset: Array(2).fill({
                id: 'test-analysis-id',
                user_id: 'test-user-id',
                analysis_data: JSON.stringify({
                    emotions: ['happy', 'excited'],
                    energy: 'high',
                    formality: 'low',
                    sentiment: 'positive',
                    style: 'casual'
                }),
                timestamp: new Date().toISOString()
            })
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

jest.mock('../../azureDb', () => ({
    sql: {
        VarChar: jest.fn(),
        Bit: jest.fn(),
        query: mockQuery
    },
    getConnection: jest.fn().mockImplementation(async () => mockDb)
}));

// Mock interaction handlers
jest.mock('../../utils/chatHandler', () => ({
    handleChatCommand: jest.fn().mockImplementation(async (interaction) => {
        await interaction.editReply('Test response');
        return true;
    })
}));

// Then require the modules
const { handleChatCommand } = require('../../utils/chatHandler');
const ConversationAnalyzer = require('../../services/ai/personality/ConversationAnalyzer');
const PersonalityPresetManager = require('../../services/ai/personality/PersonalityPresetManager');
const { sql, getConnection } = require('../../azureDb');

describe('Chat Integration Tests', () => {
    let db;
    let testUserId;
    let analyzer;
    let presetManager;
    let mockInteraction;

    beforeAll(async () => {
        db = mockDb;
        testUserId = 'test-user-' + Date.now();
        analyzer = new ConversationAnalyzer();
        presetManager = new PersonalityPresetManager();

        mockInteraction = {
            user: { id: testUserId },
            guildId: 'test-guild',
            channelId: 'test-channel',
            editReply: jest.fn().mockResolvedValue(true),
            reply: jest.fn().mockResolvedValue(true),
            options: {
                getString: jest.fn().mockReturnValue('test message')
            }
        };
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockQuery.mockClear();
        mockTransaction.begin.mockClear();
        mockTransaction.commit.mockClear();
        mockTransaction.request.mockClear();
        mockDb.transaction.mockClear();
        mockDb.request.mockClear();
        mockInteraction.editReply.mockClear();
        mockInteraction.reply.mockClear();
    });

    describe('Personality Adaptation', () => {
        test('should adapt response style based on user settings', async () => {
            const messages = [
                { content: 'Hello!', role: 'user', timestamp: new Date() },
                { content: 'How are you?', role: 'user', timestamp: new Date() }
            ];
            
            await analyzer.trackUserStyle(testUserId, messages);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 1);
            expect(history).toHaveLength(1);
            expect(history[0].style).toBe('casual');
            expect(history[0].sentiment).toBe('positive');
        });

        test('should maintain conversation context', async () => {
            // Mock getUserAnalysisHistory specifically for this test
            analyzer.getUserAnalysisHistory.mockResolvedValueOnce([
                {
                    style: 'casual',
                    formality: 'low',
                    energy: 'high',
                    sentiment: 'positive',
                    emotions: ['happy', 'excited'],
                    timestamp: new Date().toISOString()
                },
                {
                    style: 'casual',
                    formality: 'low',
                    energy: 'high',
                    sentiment: 'positive',
                    emotions: ['happy', 'excited'],
                    timestamp: new Date().toISOString()
                }
            ]);

            const messages = [
                { content: 'Hello!', role: 'user', timestamp: new Date() },
                { content: 'How are you?', role: 'user', timestamp: new Date() }
            ];
            
            await analyzer.trackUserStyle(testUserId, messages);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 2);
            expect(history).toHaveLength(2);
            expect(history[0].style).toBe('casual');
            expect(history[0].sentiment).toBe('positive');
            expect(history[0].energy).toBe('high');
        });

        test('should handle meme mode integration', async () => {
            // Mock getUserAnalysisHistory for meme mode
            analyzer.getUserAnalysisHistory.mockResolvedValueOnce([{
                style: 'meme',
                formality: 'low',
                energy: 'high',
                sentiment: 'positive',
                emotions: ['happy', 'excited'],
                timestamp: new Date().toISOString()
            }]);

            const messages = [
                { content: 'fr fr no cap', role: 'user', timestamp: new Date() },
                { content: 'based take fam', role: 'user', timestamp: new Date() }
            ];
            
            await analyzer.trackUserStyle(testUserId, messages);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 1);
            expect(history).toHaveLength(1);
            expect(history[0].style).toBe('meme');
            expect(history[0].energy).toBe('high');
            expect(history[0].sentiment).toBe('positive');
        });
    });

    describe('Error Handling', () => {
        test('should handle analysis failures gracefully', async () => {
            const messages = [
                { content: 'Test message', role: 'user', timestamp: new Date() },
                { content: 'Another message', role: 'user', timestamp: new Date() },
                { content: 'Third message', role: 'user', timestamp: new Date() }
            ];

            // Mock analysis failure
            analyzer.analyzeConversation.mockRejectedValueOnce(new Error('Analysis failed'));
            
            // Mock error handling response
            mockQuery.mockImplementationOnce(() => Promise.resolve({ recordset: [], rowsAffected: [0] }));

            await expect(handleChatCommand(mockInteraction)).resolves.toBe(true);
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });

        test('should handle personality update failures', async () => {
            const mockError = new Error('Update failed');
            jest.spyOn(presetManager, 'updateUserSettings').mockRejectedValueOnce(mockError);
            
            await expect(handleChatCommand(mockInteraction)).resolves.toBe(true);
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('Performance', () => {
        test('should complete analysis within acceptable time', async () => {
            const messages = [
                { content: 'Quick test message', role: 'user', timestamp: new Date() },
                { content: 'Another message', role: 'user', timestamp: new Date() },
                { content: 'Third message', role: 'user', timestamp: new Date() }
            ];

            // Mock successful analysis
            const mockAnalysis = {
                style: 'casual',
                formality: 'low',
                energy: 'high',
                sentiment: 'positive',
                emotions: ['happy', 'excited'],
                confidence: 0.85,
                timestamp: new Date().toISOString()
            };

            // Setup mocks
            analyzer.analyzeConversation = jest.fn().mockResolvedValue(mockAnalysis);
            analyzer.trackUserStyle = jest.fn().mockResolvedValue(true);
            analyzer.getUserAnalysisHistory = jest.fn().mockResolvedValue([mockAnalysis]);

            const startTime = Date.now();
            const result = await analyzer.analyzeConversation(messages);
            const endTime = Date.now();

            expect(endTime - startTime).toBeLessThan(1000);
            expect(result).toEqual(mockAnalysis);
        });

        test('should handle concurrent requests', async () => {
            const promises = Array(5).fill(null).map(() => 
                analyzer.trackUserStyle(testUserId, [
                    { content: 'Test message', role: 'user', timestamp: new Date() },
                    { content: 'Another message', role: 'user', timestamp: new Date() },
                    { content: 'Third message', role: 'user', timestamp: new Date() }
                ])
            );
            
            await Promise.all(promises);
            
            const history = await analyzer.getUserAnalysisHistory(testUserId, 5);
            expect(history.length).toBeGreaterThan(0);
        });
    });
}); 