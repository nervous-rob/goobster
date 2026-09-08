const { describeLive, PING } = require('./helpers');

describeLive('anthropic', () => {
    test('generateText returns a non-empty reply', async () => {
        const anthropic = require('@goobster/core/services/anthropicService');
        expect(anthropic.isConfigured()).toBe(true);
        // Sonnet 5 rejects sampling params; an explicit effort omits temperature.
        const text = await anthropic.generateText(PING, {
            max_tokens: 32,
            reasoning_effort: 'low'
        });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
