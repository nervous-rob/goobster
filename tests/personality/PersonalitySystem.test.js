const { ConversationAnalyzer } = require('../../services/ai/personality/ConversationAnalyzer');
const { PersonalityPresetManager } = require('../../services/ai/personality/PersonalityPresetManager');
const { SentimentAnalyzer } = require('../../services/ai/personality/SentimentAnalyzer');
const { getConnection } = require('../../azureDb');

describe('Personality System Tests', () => {
    let db;
    let testUserId;

    beforeAll(async () => {
        db = await getConnection();
        // Create test user
        testUserId = 'test-user-' + Date.now();
        await db.query`
            INSERT INTO UserPreferences (userId, personality_preset)
            VALUES (${testUserId}, 'helper')
        `;
    });

    afterAll(async () => {
        // Cleanup test data
        await db.query`DELETE FROM conversation_analysis WHERE userId = ${testUserId}`;
        await db.query`DELETE FROM UserPreferences WHERE userId = ${testUserId}`;
    });

    describe('ConversationAnalyzer', () => {
        test('should analyze conversation style correctly', async () => {
            const messages = [
                { content: 'Hello, would you kindly assist me with this task?', role: 'user' },
                { content: 'Of course! I would be happy to help.', role: 'assistant' }
            ];

            const analysis = await ConversationAnalyzer._analyzeStyle(messages);
            expect(analysis).toHaveProperty('dominant', 'formal');
            expect(analysis).toHaveProperty('confidence');
            expect(analysis.confidence).toBeGreaterThan(0);
        });

        test('should analyze energy levels correctly', async () => {
            const messages = [
                { content: 'WOW! This is AMAZING!!!', role: 'user' },
                { content: 'That\'s incredible!', role: 'assistant' }
            ];

            const analysis = await ConversationAnalyzer._analyzeEnergy(messages);
            expect(analysis).toHaveProperty('level', 'high');
            expect(analysis).toHaveProperty('confidence');
            expect(analysis.confidence).toBeGreaterThan(0.5);
        });

        test('should store analysis results in database', async () => {
            const messages = [
                { content: 'Hello there!', role: 'user', timestamp: new Date() }
            ];

            await ConversationAnalyzer.trackUserStyle(testUserId, messages);

            const result = await db.query`
                SELECT TOP 1 * 
                FROM conversation_analysis 
                WHERE userId = ${testUserId}
                ORDER BY timestamp DESC
            `;

            expect(result.recordset).toHaveLength(1);
            expect(result.recordset[0]).toHaveProperty('sentiment');
            expect(result.recordset[0]).toHaveProperty('style');
            expect(result.recordset[0]).toHaveProperty('energy');
        });
    });

    describe('PersonalityPresetManager', () => {
        test('should get default preset for new user', async () => {
            const settings = await PersonalityPresetManager.getUserSettings(testUserId);
            expect(settings).toHaveProperty('energy', 'medium');
            expect(settings).toHaveProperty('humor', 'medium');
            expect(settings).toHaveProperty('formality', 'medium');
        });

        test('should validate personality settings', () => {
            const validSettings = {
                energy: 'high',
                humor: 'medium',
                formality: 'low',
                traits: ['friendly', 'helpful']
            };

            expect(() => {
                PersonalityPresetManager.validateSettings(validSettings);
            }).not.toThrow();

            const invalidSettings = {
                energy: 'invalid',
                humor: 'medium'
            };

            expect(() => {
                PersonalityPresetManager.validateSettings(invalidSettings);
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

            const mixed = PersonalityPresetManager.mixStyles(baseStyle, contextStyle);
            expect(mixed).toHaveProperty('energy');
            expect(mixed.traits).toContain('professional');
            expect(mixed.traits).toContain('casual');
        });
    });

    describe('SentimentAnalyzer', () => {
        test('should analyze sentiment with AI when available', async () => {
            const messages = [
                { content: 'This is absolutely wonderful!', role: 'user' }
            ];

            const analysis = await SentimentAnalyzer.analyzeSentiment(messages);
            expect(analysis).toHaveProperty('dominant');
            expect(analysis).toHaveProperty('emotions');
            expect(analysis).toHaveProperty('confidence');
            expect(analysis).toHaveProperty('source');
        });

        test('should fallback to pattern analysis when AI fails', async () => {
            // Mock AI failure
            jest.spyOn(SentimentAnalyzer, '_getAIAnalysis').mockRejectedValueOnce(new Error('AI unavailable'));

            const messages = [
                { content: 'This is great!', role: 'user' }
            ];

            const analysis = await SentimentAnalyzer.analyzeSentiment(messages);
            expect(analysis).toHaveProperty('source', 'pattern');
            expect(analysis).toHaveProperty('dominant', 'positive');
        });
    });

    describe('Integration Tests', () => {
        test('should adapt personality based on conversation analysis', async () => {
            const messages = [
                { content: 'LOL! This is hilarious! 😂', role: 'user', timestamp: new Date() },
                { content: 'ROFL! I know right?!', role: 'assistant', timestamp: new Date() }
            ];

            await ConversationAnalyzer.trackUserStyle(testUserId, messages);
            const updatedSettings = await PersonalityPresetManager.getUserSettings(testUserId);

            expect(updatedSettings).toHaveProperty('energy', 'high');
            expect(updatedSettings).toHaveProperty('humor', 'high');
        });

        test('should maintain analysis history', async () => {
            const history = await ConversationAnalyzer.getUserAnalysisHistory(testUserId);
            expect(Array.isArray(history)).toBe(true);
            expect(history.length).toBeGreaterThan(0);
        });
    });
}); 