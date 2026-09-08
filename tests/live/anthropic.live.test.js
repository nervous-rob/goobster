const { describeLive, PING } = require('./helpers');
const aiConfig = require('@goobster/core/config/aiConfig');

describeLive('anthropic', () => {
    test('generateText on the default chat model returns a non-empty reply', async () => {
        const anthropic = require('@goobster/core/services/anthropicService');
        expect(anthropic.isConfigured()).toBe(true);
        // Everyday path: no effort, no sampling override. Sonnet 5 rejects
        // temperature and thinks adaptively at high when none is requested.
        const text = await anthropic.generateText(PING, { max_tokens: 32 });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });

    test('thoughtful preset (thoughtfulModel + high effort) returns a non-empty reply', async () => {
        const anthropic = require('@goobster/core/services/anthropicService');
        const text = await anthropic.generateText(PING, {
            model: aiConfig.anthropic.thoughtfulModel,
            reasoning_effort: 'high',
            max_tokens: 32
        });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
