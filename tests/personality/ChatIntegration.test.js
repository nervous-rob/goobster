const { ConversationAnalyzer } = require('../../services/ai/personality/ConversationAnalyzer');
const { PersonalityPresetManager } = require('../../services/ai/personality/PersonalityPresetManager');
const { handleChatInteraction } = require('../../utils/chatHandler');
const { getConnection } = require('../../azureDb');

describe('Chat Integration Tests', () => {
    let db;
    let testUserId;
    let mockInteraction;

    beforeAll(async () => {
        db = await getConnection();
        testUserId = 'test-user-' + Date.now();
        
        // Create test user with default settings
        await db.query`
            INSERT INTO UserPreferences (userId, personality_preset)
            VALUES (${testUserId}, 'helper')
        `;
    });

    beforeEach(() => {
        // Mock Discord interaction
        mockInteraction = {
            user: { id: testUserId },
            options: {
                getString: jest.fn()
            },
            deferReply: jest.fn().mockResolvedValue(true),
            editReply: jest.fn().mockResolvedValue(true),
            channel: {
                sendTyping: jest.fn().mockResolvedValue(true),
                send: jest.fn().mockResolvedValue(true)
            }
        };
    });

    afterAll(async () => {
        // Cleanup test data
        await db.query`DELETE FROM conversation_analysis WHERE userId = ${testUserId}`;
        await db.query`DELETE FROM UserPreferences WHERE userId = ${testUserId}`;
    });

    describe('Personality Adaptation', () => {
        test('should adapt response style based on user settings', async () => {
            // Set user to casual preset
            await PersonalityPresetManager.setUserPreset(testUserId, 'casual');
            
            mockInteraction.options.getString.mockReturnValue('Hello there!');
            
            await handleChatInteraction(mockInteraction);
            
            // Verify analysis was stored
            const analysis = await db.query`
                SELECT TOP 1 * 
                FROM conversation_analysis 
                WHERE userId = ${testUserId}
                ORDER BY timestamp DESC
            `;
            
            expect(analysis.recordset).toHaveLength(1);
            expect(analysis.recordset[0].style).toContain('casual');
        });

        test('should maintain conversation context', async () => {
            const messages = [
                { content: 'Tell me a joke!', role: 'user', timestamp: new Date() }
            ];

            await ConversationAnalyzer.trackUserStyle(testUserId, messages);
            
            mockInteraction.options.getString.mockReturnValue('That was funny!');
            
            await handleChatInteraction(mockInteraction);
            
            const history = await ConversationAnalyzer.getUserAnalysisHistory(testUserId, 2);
            expect(history).toHaveLength(2);
            expect(history[0].sentiment).toContain('positive');
        });

        test('should handle meme mode integration', async () => {
            // Enable meme mode
            await db.query`
                UPDATE UserPreferences 
                SET memeMode = 1 
                WHERE userId = ${testUserId}
            `;
            
            mockInteraction.options.getString.mockReturnValue('What up fam?');
            
            await handleChatInteraction(mockInteraction);
            
            const analysis = await db.query`
                SELECT TOP 1 * 
                FROM conversation_analysis 
                WHERE userId = ${testUserId}
                ORDER BY timestamp DESC
            `;
            
            const style = JSON.parse(analysis.recordset[0].style);
            expect(style.formality).toBe('low');
            expect(style.energy).toBe('high');
        });
    });

    describe('Error Handling', () => {
        test('should handle analysis failures gracefully', async () => {
            // Mock analysis failure
            jest.spyOn(ConversationAnalyzer, 'analyzeConversation')
                .mockRejectedValueOnce(new Error('Analysis failed'));
            
            mockInteraction.options.getString.mockReturnValue('Hello!');
            
            await handleChatInteraction(mockInteraction);
            
            // Should still respond to user
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });

        test('should handle personality update failures', async () => {
            // Mock update failure
            jest.spyOn(PersonalityPresetManager, 'updateUserSettings')
                .mockRejectedValueOnce(new Error('Update failed'));
            
            mockInteraction.options.getString.mockReturnValue('Hi there!');
            
            await handleChatInteraction(mockInteraction);
            
            // Should still respond to user
            expect(mockInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('Performance', () => {
        test('should complete analysis within acceptable time', async () => {
            const start = Date.now();
            
            mockInteraction.options.getString.mockReturnValue('Quick test message');
            
            await handleChatInteraction(mockInteraction);
            
            const duration = Date.now() - start;
            expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
        });

        test('should handle concurrent requests', async () => {
            const promises = [];
            for (let i = 0; i < 5; i++) {
                const interaction = { ...mockInteraction };
                interaction.options.getString.mockReturnValue(`Test message ${i}`);
                promises.push(handleChatInteraction(interaction));
            }
            
            await Promise.all(promises);
            
            const analyses = await db.query`
                SELECT * 
                FROM conversation_analysis 
                WHERE userId = ${testUserId}
                ORDER BY timestamp DESC
            `;
            
            expect(analyses.recordset.length).toBeGreaterThanOrEqual(5);
        });
    });
}); 