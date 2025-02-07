const { PersonalityPresetManager } = require('../../services/ai/personality/PersonalityPresetManager');
const { ConversationAnalyzer } = require('../../services/ai/personality/ConversationAnalyzer');
const { isMemeModeEnabled, setMemeMode } = require('../../utils/memeMode');
const { getConnection } = require('../../azureDb');

describe('Meme Mode Integration Tests', () => {
    let db;
    let testUserId;

    beforeAll(async () => {
        db = await getConnection();
        testUserId = 'test-user-' + Date.now();
        
        // Create test user
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

    describe('Meme Mode Settings', () => {
        test('should toggle meme mode correctly', async () => {
            await setMemeMode(testUserId, true);
            let enabled = await isMemeModeEnabled(testUserId);
            expect(enabled).toBe(true);

            await setMemeMode(testUserId, false);
            enabled = await isMemeModeEnabled(testUserId);
            expect(enabled).toBe(false);
        });

        test('should apply meme personality preset when enabled', async () => {
            await setMemeMode(testUserId, true);
            const settings = await PersonalityPresetManager.getUserSettings(testUserId);
            
            expect(settings.energy).toBe('high');
            expect(settings.humor).toBe('very_high');
            expect(settings.formality).toBe('low');
            expect(settings.traits).toContain('internet_culture');
        });

        test('should restore previous preset when disabled', async () => {
            // Set initial preset
            await PersonalityPresetManager.setUserPreset(testUserId, 'professional');
            
            // Enable and then disable meme mode
            await setMemeMode(testUserId, true);
            await setMemeMode(testUserId, false);
            
            const settings = await PersonalityPresetManager.getUserSettings(testUserId);
            expect(settings.preset).toBe('professional');
        });
    });

    describe('Conversation Analysis', () => {
        test('should detect meme-style messages', async () => {
            const messages = [
                { content: 'bruh moment 💀', role: 'user', timestamp: new Date() }
            ];

            await ConversationAnalyzer.trackUserStyle(testUserId, messages);
            
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

        test('should adapt to meme language patterns', async () => {
            await setMemeMode(testUserId, true);
            
            const messages = [
                { content: 'no cap fr fr 😤', role: 'user', timestamp: new Date() },
                { content: 'based take ngl', role: 'user', timestamp: new Date() }
            ];

            await ConversationAnalyzer.trackUserStyle(testUserId, messages);
            
            const history = await ConversationAnalyzer.getUserAnalysisHistory(testUserId, 1);
            expect(history[0].style).toContain('casual');
            expect(history[0].energy).toContain('high');
        });
    });

    describe('Error Handling', () => {
        test('should handle meme mode toggle failures', async () => {
            // Simulate database error
            jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('DB Error'));
            
            await expect(setMemeMode(testUserId, true))
                .rejects
                .toThrow();
            
            // Verify user preferences weren't corrupted
            const settings = await PersonalityPresetManager.getUserSettings(testUserId);
            expect(settings).toBeDefined();
        });

        test('should maintain personality consistency on errors', async () => {
            // Set initial state
            await PersonalityPresetManager.setUserPreset(testUserId, 'helper');
            
            // Simulate failed meme mode toggle
            jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('DB Error'));
            try {
                await setMemeMode(testUserId, true);
            } catch (error) {
                // Expected error
            }
            
            // Verify personality settings remained intact
            const settings = await PersonalityPresetManager.getUserSettings(testUserId);
            expect(settings.preset).toBe('helper');
        });
    });

    describe('Performance', () => {
        test('should handle rapid meme mode toggles', async () => {
            const toggles = [];
            for (let i = 0; i < 5; i++) {
                toggles.push(setMemeMode(testUserId, i % 2 === 0));
            }
            
            await Promise.all(toggles);
            
            // Verify final state is consistent
            const enabled = await isMemeModeEnabled(testUserId);
            expect(typeof enabled).toBe('boolean');
        });
    });
}); 