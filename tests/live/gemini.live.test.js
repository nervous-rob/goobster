const { describeLive, PING } = require('./helpers');

describeLive('gemini', () => {
    test('generateText returns a non-empty reply', async () => {
        const gemini = require('@goobster/core/services/geminiService');
        expect(gemini.isConfigured()).toBe(true);
        const text = await gemini.generateText(PING, { max_tokens: 32 });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
