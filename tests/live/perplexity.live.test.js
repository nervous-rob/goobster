const { describeLive } = require('./helpers');

describeLive('perplexity', () => {
    test('search returns a non-empty answer', async () => {
        const perplexity = require('@goobster/core/services/perplexityService');
        expect(perplexity.isConfigured()).toBe(true);
        const text = await perplexity.search('What is 2+2? Answer in one short sentence.');
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
