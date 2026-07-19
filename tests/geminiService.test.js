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
                chatModel: 'gemini-test-model'
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

    test('captures and replays thought signatures on function calls', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{
                            functionCall: { name: 'echoMessage', args: { text: 'hi' } },
                            thoughtSignature: 'sig-abc'
                        }]
                    }
                }]
            })
        });

        const service = createService();
        const result = await service.chat('Call a tool.', {
            functions: [{ name: 'echoMessage', description: 'Echoes', parameters: { type: 'object', properties: {} } }]
        });
        expect(result.toolCalls[0].thoughtSignature).toBe('sig-abc');

        // Replaying the assistant turn must carry the signature back
        // (Gemini 3 models return 400 without it).
        await service.chat([
            { role: 'user', content: 'Echo hi.' },
            { role: 'assistant', content: '', toolCalls: result.toolCalls },
            { role: 'tool', toolCallId: result.toolCalls[0].id, name: 'echoMessage', content: 'hi' }
        ]);
        const body = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantParts = body.contents.find(c => c.role === 'model').parts;
        expect(assistantParts[0].thoughtSignature).toBe('sig-abc');
    });

    test('maps reasoning effort to thinkingLevel on Gemini 3.x models only', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'ok' }] } }]
            })
        });

        const service = createService();
        await service.chat('think hard', { model: 'gemini-3.5-flash', reasoning_effort: 'high' });
        let body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });

        // Pro models have no 'minimal' level: clamp to 'low'
        await service.chat('quick one', { model: 'gemini-3.1-pro-preview', reasoning_effort: 'minimal' });
        body = JSON.parse(global.fetch.mock.calls[1][1].body);
        expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });

        // 2.5-era models don't accept thinkingLevel at all
        await service.chat('legacy', { model: 'gemini-2.5-flash', reasoning_effort: 'high' });
        body = JSON.parse(global.fetch.mock.calls[2][1].body);
        expect(body.generationConfig.thinkingConfig).toBeUndefined();
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
