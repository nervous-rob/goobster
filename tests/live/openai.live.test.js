const { describeLive, PING } = require('./helpers');
const aiConfig = require('@goobster/core/config/aiConfig');

describeLive('openai', () => {
    test('generateText on the default chat model returns a non-empty reply', async () => {
        const openai = require('@goobster/core/services/openaiService');
        expect(openai.isConfigured()).toBe(true);
        const text = await openai.generateText(PING, { max_tokens: 32 });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });

    test('thoughtful preset (thoughtfulModel + high effort) returns a non-empty reply', async () => {
        const openai = require('@goobster/core/services/openaiService');
        const text = await openai.generateText(PING, {
            model: aiConfig.openai.thoughtfulModel,
            reasoning_effort: 'high',
            max_tokens: 32
        });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
