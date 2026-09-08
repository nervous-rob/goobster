const { describeLive, PING } = require('./helpers');
const aiConfig = require('@goobster/core/config/aiConfig');

describeLive('gemini', () => {
    test('generateText on the default chat model returns a non-empty reply', async () => {
        const gemini = require('@goobster/core/services/geminiService');
        expect(gemini.isConfigured()).toBe(true);
        // Everyday path: no effort, no sampling override. Gemini 3 omits
        // temperature (API default 1.0) and thinks at the model default.
        const text = await gemini.generateText(PING, { max_tokens: 32 });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });

    test('thoughtful preset (thoughtfulModel + high effort) returns a non-empty reply', async () => {
        const gemini = require('@goobster/core/services/geminiService');
        const text = await gemini.generateText(PING, {
            model: aiConfig.gemini.thoughtfulModel,
            reasoning_effort: 'high',
            max_tokens: 32
        });
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
    });
});
