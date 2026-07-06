describe('GeminiService', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        global.fetch = originalFetch;
    });

    function createService() {
        jest.doMock('../config/aiConfig', () => ({
            gemini: {
                apiKey: 'test-gemini-key',
                model: 'gemini-test-model'
            }
        }));
        jest.doMock('../services/usageTracker', () => ({
            log: jest.fn()
        }));

        const { GeminiService } = require('../services/geminiService');
        const service = new GeminiService();
        service.baseUrl = 'https://gemini.test/v1beta';
        return service;
    }

    test('posts chat requests to Gemini REST and normalizes text responses', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{ text: 'Hello from Gemini' }]
                    }
                }],
                usageMetadata: {
                    promptTokenCount: 2,
                    candidatesTokenCount: 3
                }
            })
        });

        const service = createService();
        const result = await service.chat([
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Say hello.' }
        ], {
            top_p: 0.8,
            max_tokens: 64,
            usageContext: { guildId: 'guild-1', userId: 'user-1' }
        });

        expect(result).toEqual({ content: 'Hello from Gemini', toolCalls: [] });
        expect(global.fetch).toHaveBeenCalledWith(
            'https://gemini.test/v1beta/models/gemini-test-model:generateContent',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': 'test-gemini-key'
                }
            })
        );

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.systemInstruction.parts[0].text).toBe('Be concise.');
        expect(body.generationConfig).toEqual({
            temperature: 0.7,
            topP: 0.8,
            maxOutputTokens: 64
        });
    });

    test('sends native function declarations and normalizes tool calls', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: {
                                name: 'echoMessage',
                                args: { text: 'hello' }
                            }
                        }]
                    }
                }]
            })
        });

        const service = createService();
        const result = await service.chat('Call a tool.', {
            functions: [{
                name: 'echoMessage',
                description: 'Echoes text',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' }
                    },
                    required: ['text']
                }
            }],
            webSearch: true
        });

        expect(result.content).toBe('');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toEqual(expect.objectContaining({
            name: 'echoMessage',
            arguments: JSON.stringify({ text: 'hello' })
        }));

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.tools).toEqual([
            {
                functionDeclarations: [{
                    name: 'echoMessage',
                    description: 'Echoes text',
                    parametersJsonSchema: {
                        type: 'object',
                        properties: {
                            text: { type: 'string' }
                        },
                        required: ['text']
                    }
                }]
            },
            { googleSearch: {} }
        ]);
    });

    test('streams SSE chunks and reports deltas', async () => {
        const encoder = new TextEncoder();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n'));
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n'));
                    controller.close();
                }
            })
        });

        const service = createService();
        const onDelta = jest.fn();
        const result = await service.chat('Stream please.', { onDelta });

        expect(global.fetch.mock.calls[0][0]).toBe('https://gemini.test/v1beta/models/gemini-test-model:streamGenerateContent?alt=sse');
        expect(result).toEqual({ content: 'Hello', toolCalls: [] });
        expect(onDelta).toHaveBeenNthCalledWith(1, 'Hel');
        expect(onDelta).toHaveBeenNthCalledWith(2, 'lo');
    });
});
