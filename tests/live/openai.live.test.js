const { describeLive, PING } = require('./helpers');

describeLive('openai', () => {
    test('generateText returns a non-empty reply', async () => {
        const openai = require('@goobster/core/services/openaiService');
        expect(openai.isConfigured()).toBe(true);
        const text = await openai.generateText(PING, { max_tokens: 32 });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
