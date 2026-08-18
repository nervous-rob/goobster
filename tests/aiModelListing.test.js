/**
 * Live model listing for the web portal's model dropdown
 * (aiService.listModels): per-provider endpoints, chat-model filtering,
 * caching, and graceful failure.
 */
process.env.OPENAI_API_KEY = 'sk-test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.GEMINI_API_KEY = 'g-test';

const aiService = require('@goobster/core/services/aiService');

const realFetch = global.fetch;

afterAll(() => {
    global.fetch = realFetch;
});

function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: async () => body });
}

beforeEach(() => {
    // The cache is module-level; use unique-per-test providers or clear via
    // fresh fetch mocks + distinct assertions on call counts.
    global.fetch = jest.fn();
});

describe('aiService.listModels', () => {
    test('openai: filters the mixed catalog down to chat-capable ids', async () => {
        global.fetch.mockImplementation(() => jsonResponse({
            data: [
                { id: 'gpt-4.1' },
                { id: 'gpt-4o-mini' },
                { id: 'o3-mini' },
                { id: 'chatgpt-4o-latest' },
                { id: 'text-embedding-3-small' },
                { id: 'whisper-1' },
                { id: 'gpt-4o-mini-tts' },
                { id: 'gpt-4o-realtime-preview' },
                { id: 'dall-e-3' },
                { id: 'gpt-image-1' },
                { id: 'omni-moderation-latest' },
                { id: 'davinci-002' }
            ]
        }));

        const models = await aiService.listModels('openai');
        expect(models).toEqual(['chatgpt-4o-latest', 'gpt-4.1', 'gpt-4o-mini', 'o3-mini']);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/models');
        expect(opts.headers.Authorization).toBe('Bearer sk-test');
    });

    test('openai: serves the second call from cache', async () => {
        // First call happened in the previous test and was cached
        global.fetch.mockImplementation(() => { throw new Error('must not be called'); });
        const models = await aiService.listModels('openai');
        expect(models).toContain('gpt-4.1');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('anthropic: returns every listed model with auth headers', async () => {
        global.fetch.mockImplementation(() => jsonResponse({
            data: [{ id: 'claude-b' }, { id: 'claude-a' }]
        }));
        const models = await aiService.listModels('anthropic');
        expect(models).toEqual(['claude-a', 'claude-b']);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toContain('api.anthropic.com/v1/models');
        expect(opts.headers['x-api-key']).toBe('sk-ant-test');
        expect(opts.headers['anthropic-version']).toBeTruthy();
    });

    test('gemini: keeps generateContent models, strips the models/ prefix, drops embeddings', async () => {
        global.fetch.mockImplementation(() => jsonResponse({
            models: [
                { name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['generateContent', 'embedContent'] },
                { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] }
            ]
        }));
        const models = await aiService.listModels('gemini');
        expect(models).toEqual(['gemini-flash', 'gemini-pro']);
        // The key rides as a query param, never a header
        expect(global.fetch.mock.calls[0][0]).toContain('key=g-test');
    });

    test('a failed listing returns [] instead of throwing (UI falls back to catalog defaults)', async () => {
        global.fetch.mockImplementation(() => jsonResponse({}, false, 401));
        expect(await aiService.listModels('ollama')).toEqual([]);
    });
});
