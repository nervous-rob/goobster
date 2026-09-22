const registry = require('@goobster/core/models/registry');
const { MODELS } = require('@goobster/core/models/catalog');
const aiConfig = require('@goobster/core/config/aiConfig');

const resolve = (id, opts = {}) => registry.resolveRequest('openai', id, { max_tokens: 500, ...opts });

test('catalog contracts cover configured defaults and contain usable, immutable metadata', () => {
    for (const provider of ['openai', 'anthropic', 'gemini', 'ollama']) {
        const config = aiConfig[provider];
        for (const id of [config.chatModel || config.model, config.thoughtfulModel].filter(Boolean)) {
            expect(registry.get(provider, id)).not.toBeNull();
        }
    }
    for (const entry of MODELS) {
        const model = registry.requireModel(entry.provider, entry.id);
        expect(model.sources.length).toBeGreaterThan(0);
        expect(model.output).toContain('text');
        expect(model.capabilities.tools).toBeTruthy();
        expect(Object.isFrozen(model.reasoning.levels)).toBe(true);
        if (model.reasoning.levels.length) expect(model.reasoning.levels).toContain(model.reasoning.default);
        const policy = registry.resolveRequest(model.provider, model.id, { max_tokens: 500 });
        expect(policy.maxOutputTokens).toBeGreaterThanOrEqual(500);
        if (model.maxOutputTokens) expect(policy.maxOutputTokens).toBeLessThanOrEqual(model.maxOutputTokens);
    }
});

test('only explicit aliases resolve; model names never imply support', () => {
    expect(registry.get('openai', 'gpt-5.6').canonicalId).toBe('gpt-5.6-sol');
    expect(registry.get('anthropic', 'claude-haiku-4-5-20251001').canonicalId).toBe('claude-haiku-4-5');
    expect(registry.get('gemini', 'models/gemini-3.5-flash').id).toBe('gemini-3.5-flash');
    for (const id of ['gpt-6-sol-future', 'gpt-7', 'gpt-image-2', 'gpt-4o-realtime-preview']) {
        expect(() => resolve(id)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL' }));
    }
    expect(registry.get('anthropic', 'gpt-6-sol')).toBeNull();
});

test('GPT-6 policies distinguish effort, sampling and output limits', () => {
    expect(resolve('gpt-6-sol', { temperature: 0.9 }).sampling).toEqual({});
    expect(resolve('gpt-6-sol', { reasoning_effort: 'minimal' })).toMatchObject({ effort: 'low', maxOutputTokens: 4596 });
    expect(resolve('gpt-6-sol', { reasoning_effort: 'none', temperature: 0.4 })).toMatchObject({ effort: 'none', maxOutputTokens: 500, sampling: { temperature: 0.4 } });
    expect(() => resolve('gpt-6-astra', { reasoning_effort: 'none' })).toThrow(expect.objectContaining({ code: 'BAD_REASONING' }));
    expect(resolve('gpt-6-sol', { reasoning_effort: 'xhigh' }).maxOutputTokens).toBe(49652);
    expect(resolve('gpt-6-sol', { reasoning_effort: 'max', max_tokens: 100000 }).maxOutputTokens).toBe(128000);
    expect(resolve('gpt-4o', { max_tokens: 100000 }).maxOutputTokens).toBe(16384);
});

test('model and effort requirements protect tool and image calls', () => {
    expect(() => resolve('gpt-5', { reasoning_effort: 'minimal', webSearch: true })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SEARCH' }));
    expect(() => resolve('o3-mini', { webSearch: true })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SEARCH' }));
    expect(() => registry.resolveRequest('ollama', 'llama3.2:3b', {}, [{ role: 'user', images: ['https://example.test/image.png'] }]))
        .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_IMAGES' }));
});

test('provider contracts preserve conditional sampling and effective reasoning defaults', () => {
    const haiku = registry.resolveRequest('anthropic', 'claude-haiku-4-5', { temperature: 1.7, top_p: 0.9 });
    expect(haiku.sampling).toEqual({ temperature: 1 });
    const opus = registry.resolveRequest('anthropic', 'claude-opus-5-5', { max_tokens: 500 });
    expect(opus).toMatchObject({ effectiveEffort: 'medium', maxOutputTokens: 8692, sampling: {} });
    const pro = registry.resolveRequest('gemini', 'gemini-3.1-pro-preview', { reasoning_effort: 'minimal', max_tokens: 500 });
    expect(pro).toMatchObject({ effort: 'low', maxOutputTokens: 4596, sampling: {} });
    expect(() => registry.resolveEffort(registry.get('openai', 'gpt-4o'), 'high', { strict: true })).toThrow();
    expect(resolve('gpt-4o', { reasoning_effort: 'high' }).effort).toBeNull();
});

test('custom models require an explicit matching profile and cannot replace built-ins', () => {
    const custom = registry.createRegistry([{ provider: 'ollama', id: 'my-local:latest', profile: 'ollama-text', maxOutputTokens: 2048 }]);
    expect(custom.resolveRequest('ollama', 'my-local:latest', { max_tokens: 5000 })).toMatchObject({ maxOutputTokens: 2048 });
    expect(custom.get('ollama', 'my-local:latest').status).toBe('custom');
    expect(custom.get('ollama', 'my-local:latest').checkedAt).toBeNull();
    expect(() => registry.createRegistry([{ provider: 'ollama', id: 'my-local', profile: 'openai-chat' }])).toThrow('Invalid provider/profile');
    expect(() => registry.createRegistry([{ provider: 'openai', id: 'gpt-6-sol', profile: 'openai-chat' }])).toThrow('Duplicate model');
    expect(() => registry.createRegistry([{ provider: 'openai', id: 'custom', profile: 'openai-chat', maxOutputTokens: -1 }])).toThrow('Invalid maxOutputTokens');
});
