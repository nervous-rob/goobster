/** Discovery supplies availability; new chat models use provider defaults. */
const realFetch = global.fetch;
let aiService;
const jsonResponse = body => Promise.resolve({ ok: true, json: async () => body });

beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    jest.doMock('@goobster/core/config/aiConfig', () => ({
        provider: 'openai', customModels: [],
        openai: { apiKey: 'test-openai-key', chatModel: 'gpt-6-sol', thoughtfulModel: 'gpt-6-astra' },
        anthropic: { apiKey: 'test-anthropic-key', chatModel: 'claude-sonnet-5' },
        gemini: { apiKey: 'test-gemini-key', chatModel: 'gemini-3.5-flash' },
        ollama: { host: 'http://ollama.test', model: 'llama3.2:3b' }
    }));
    jest.doMock('@goobster/core/services/usageTracker', () => ({ log: jest.fn() }));
    aiService = require('@goobster/core/services/aiService');
});
afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

const selectable = catalog => catalog.models.filter(m => m.selectable).map(m => m.id).sort();

test('new API chat models are selectable while specialized models stay excluded', async () => {
    global.fetch.mockImplementation(() => jsonResponse({ data: ['gpt-6-sol', 'gpt-4o-mini', 'gpt-7', 'gpt-4o-realtime-preview', 'gpt-image-2'].map(id => ({ id })) }));
    const catalog = await aiService.listModelCatalog('openai');
    expect(selectable(catalog)).toEqual(['gpt-4o-mini', 'gpt-6-sol', 'gpt-7']);
    expect(catalog.unregisteredCount).toBe(2);
    expect(catalog.models.find(m => m.id === 'gpt-6-sol')).toMatchObject({ availability: 'listed', reasoning: { default: 'medium' } });
    expect(await aiService.listModels('openai')).toEqual(['gpt-4o-mini', 'gpt-6-sol', 'gpt-7']);
    expect(catalog.models.find(m => m.id === 'gpt-7')).toMatchObject({ status: 'discovered', contextWindow: null, reasoning: { levels: [] }, sampling: { mode: 'never' } });
    expect(aiService.validateModelSelection({ provider: 'openai' }, { model: 'gpt-7' })).toEqual({ model: 'gpt-7', reasoningEffort: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('coalesces simultaneous listings for different workflows and preserves capability metadata', async () => {
    global.fetch.mockImplementation(() => jsonResponse({ data: [{ id: 'gpt-6-sol' }] }));
    const [chat, research] = await Promise.all([aiService.listModelCatalog('openai'), aiService.listModelCatalog('openai', 'research')]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(chat.workflow).toBe('chat');
    expect(research.workflow).toBe('research');
    expect(selectable(chat)).toEqual(selectable(research));
});

test('paginates Anthropic listings and matches explicitly reviewed aliases', async () => {
    global.fetch.mockImplementationOnce(() => jsonResponse({ data: [{ id: 'claude-sonnet-5' }], has_more: true, last_id: 'claude-sonnet-5' }))
        .mockImplementationOnce(() => jsonResponse({ data: [{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-sonnet-6' }], has_more: false }));
    expect(selectable(await aiService.listModelCatalog('anthropic'))).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-6']);
    expect(global.fetch.mock.calls[1][0]).toContain('after_id=claude-sonnet-5');
    expect(global.fetch.mock.calls[0][1].headers['x-api-key']).toBe('test-anthropic-key');
});

test('paginates Gemini, uses a header key, and does not confuse generation with chat compatibility', async () => {
    global.fetch.mockImplementationOnce(() => jsonResponse({ models: [{ name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page2' }))
        .mockImplementationOnce(() => jsonResponse({ models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-image-future', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }] }));
    expect(selectable(await aiService.listModelCatalog('gemini'))).toEqual(['gemini-3.5-flash', 'gemini-flash-latest']);
    expect(global.fetch.mock.calls[1][0]).toContain('pageToken=page2');
    expect(global.fetch.mock.calls[0][0]).not.toContain('key=');
    expect(global.fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('test-gemini-key');
});

test('an outage keeps known choices available with unknown availability and backs off retries', async () => {
    global.fetch.mockRejectedValue(new Error('secret key must not reach client'));
    const catalog = await aiService.listModelCatalog('openai');
    expect(catalog.discovery.status).toBe('unavailable');
    expect(catalog.models.every(m => m.availability === 'unknown')).toBe(true);
    expect(selectable(catalog)).toContain('gpt-6-sol');
    expect(JSON.stringify(catalog)).not.toContain('secret');
    await aiService.listModelCatalog('openai');
    expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('a refresh failure retains the last successful snapshot without asserting current availability', async () => {
    global.fetch.mockImplementationOnce(() => jsonResponse({ data: [{ id: 'gpt-6-sol' }] }));
    const prior = await aiService.listModelCatalog('openai');
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    global.fetch.mockRejectedValue(new Error('offline'));
    const stale = await aiService.listModelCatalog('openai');
    expect(stale.discovery).toEqual({ status: 'stale', checkedAt: prior.discovery.checkedAt });
    expect(stale.models.find(m => m.id === 'gpt-6-sol')).toMatchObject({ availability: 'unknown', selectable: true });
});

test('an empty success differs from a failure and a malformed page is never accepted as empty', async () => {
    global.fetch.mockImplementationOnce(() => jsonResponse({ data: [] }));
    const empty = await aiService.listModelCatalog('openai');
    expect(empty.discovery.status).toBe('live');
    expect(selectable(empty)).toEqual([]);
    global.fetch.mockImplementationOnce(() => jsonResponse({}));
    expect((await aiService.listModelCatalog('anthropic')).discovery.status).toBe('unavailable');
});

test('missing credentials and invalid providers cannot silently select a different provider', async () => {
    require('@goobster/core/config/aiConfig').anthropic.apiKey = null;
    jest.spyOn(require('@goobster/core/services/anthropicService'), 'isConfigured').mockReturnValue(false);
    expect((await aiService.listModelCatalog('anthropic')).discovery.status).toBe('not-configured');
    expect(selectable(await aiService.listModelCatalog('anthropic'))).toEqual([]);
    await expect(aiService.listModelCatalog('typo')).rejects.toMatchObject({ code: 'BAD_PROVIDER' });
    expect(global.fetch).not.toHaveBeenCalled();
    await expect(aiService.chat('Hi', { provider: 'typo', model: 'gpt-6-sol' })).rejects.toMatchObject({ code: 'BAD_PROVIDER' });
    await expect(aiService.chat('Hi', { provider: 'anthropic', model: 'claude-sonnet-5' }))
        .rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(global.fetch).not.toHaveBeenCalled();
});

test('selection validation merges partial edits and clears settings inherited from a different model', () => {
    expect(aiService.validateModelSelection({ provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'max' }, { provider: 'anthropic' }))
        .toEqual({ provider: 'anthropic', model: null, reasoningEffort: null });
    expect(aiService.validateModelSelection({ provider: 'openai', model: 'gpt-6-sol', reasoningEffort: 'high' }, { model: 'gpt-4o' }))
        .toEqual({ model: 'gpt-4o', reasoningEffort: null });
    expect(() => aiService.validateModelSelection({ provider: 'openai', model: 'gpt-6-astra' }, { reasoningEffort: 'none' }))
        .toThrow(expect.objectContaining({ code: 'BAD_REASONING' }));
    expect(() => aiService.validateModelSelection({ provider: 'openai' }, { model: 'gpt-future' }))
        .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL' }));
    expect(aiService.validateModelSelection({}, { provider: null, model: null, reasoningEffort: null }))
        .toEqual({ provider: null, model: null, reasoningEffort: null });
});


test('manual refresh bypasses the TTL, coalesces requests and observes its cooldown', async () => {
    global.fetch.mockImplementationOnce(() => jsonResponse({ data: [{ id: 'gpt-6-sol' }] }));
    await aiService.listModelCatalog('openai');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
    global.fetch.mockImplementationOnce(() => jsonResponse({ data: [{ id: 'gpt-6-sol' }, { id: 'gpt-7' }] }));
    const [chat, research] = await Promise.all([
        aiService.listModelCatalog('openai', 'chat', { refresh: true }),
        aiService.listModelCatalog('openai', 'research', { refresh: true })
    ]);
    expect(selectable(chat)).toContain('gpt-7');
    expect(selectable(research)).toContain('gpt-7');
    await aiService.listModelCatalog('openai', 'chat', { refresh: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(Date.now() + 31000);
    global.fetch.mockRejectedValue(new Error('offline'));
    expect(selectable(await aiService.listModelCatalog('openai', 'chat', { refresh: true }))).toContain('gpt-7');
});

test.each([
    ['anthropic', { data: [{ id: 'claude-sonnet-6' }] }, 'claude-sonnet-6'],
    ['gemini', { models: [{ name: 'models/gemini-4-flash', supportedGenerationMethods: ['generateContent'] }] }, 'gemini-4-flash'],
    ['ollama', { models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] }, 'qwen3:8b']
])('%s includes new chat models with provider defaults', async (provider, body, id) => {
    global.fetch.mockImplementation(() => jsonResponse(body));
    const catalog = await aiService.listModelCatalog(provider);
    expect(selectable(catalog)).toEqual([id]);
    expect(catalog.models.find(m => m.id === id)).toMatchObject({ status: 'discovered', availability: 'listed' });
});
