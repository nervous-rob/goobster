describe('AnthropicService', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        global.fetch = originalFetch;
    });

    function createService() {
        jest.doMock('../config/aiConfig', () => ({
            anthropic: {
                apiKey: 'test-anthropic-key',
                chatModel: 'claude-test-model'
            }
        }));
        jest.doMock('../services/usageTracker', () => ({
            log: jest.fn()
        }));

        const { AnthropicService } = require('../services/anthropicService');
        const service = new AnthropicService();
        service.baseUrl = 'https://anthropic.test/v1';
        return service;
    }

    test('posts chat requests to the Messages API and normalizes text responses', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'Hello from Claude' }],
                usage: { input_tokens: 2, output_tokens: 3 }
            })
        });

        const service = createService();
        const result = await service.chat([
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Say hello.' }
        ], {
            temperature: 0.4,
            max_tokens: 64,
            usageContext: { guildId: 'guild-1', userId: 'user-1' }
        });

        expect(result).toEqual({ content: 'Hello from Claude', toolCalls: [] });
        expect(global.fetch).toHaveBeenCalledWith(
            'https://anthropic.test/v1/messages',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'test-anthropic-key',
                    'anthropic-version': '2023-06-01'
                }
            })
        );

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.model).toBe('claude-test-model');
        expect(body.system).toBe('Be concise.');
        expect(body.max_tokens).toBe(64);
        expect(body.temperature).toBe(0.4);
        expect(body.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }
        ]);
    });

    test('sends native tool definitions and normalizes tool_use blocks', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [{
                    type: 'tool_use',
                    id: 'toolu_123',
                    name: 'echoMessage',
                    input: { text: 'hello' }
                }],
                usage: { input_tokens: 5, output_tokens: 7 }
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
        expect(result.toolCalls).toEqual([{
            id: 'toolu_123',
            name: 'echoMessage',
            arguments: JSON.stringify({ text: 'hello' })
        }]);

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.tools).toEqual([
            {
                name: 'echoMessage',
                description: 'Echoes text',
                input_schema: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' }
                    },
                    required: ['text']
                }
            },
            { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
        ]);
    });

    test('translates tool results and assistant tool calls into content blocks', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'Done.' }],
                usage: { input_tokens: 1, output_tokens: 1 }
            })
        });

        const service = createService();
        await service.chat([
            { role: 'user', content: 'Echo hi.' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'toolu_1', name: 'echoMessage', arguments: '{"text":"hi"}' }]
            },
            { role: 'tool', toolCallId: 'toolu_1', name: 'echoMessage', content: 'hi' }
        ]);

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'Echo hi.' }] },
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'echoMessage', input: { text: 'hi' } }]
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }]
            }
        ]);
    });

    test('omits sampling params for adaptive-thinking models', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'ok' }],
                usage: {}
            })
        });

        const service = createService();
        await service.chat('hi', { model: 'claude-fable-5', temperature: 0.9, top_p: 0.5 });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.temperature).toBeUndefined();
        expect(body.top_p).toBeUndefined();
    });

    test('maps reasoning effort to output_config.effort on supported models', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'ok' }],
                usage: {}
            })
        });

        const service = createService();
        await service.chat('think hard', { model: 'claude-fable-5', reasoning_effort: 'high', max_tokens: 500 });
        let body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.output_config).toEqual({ effort: 'high' });
        // Thinking shares max_tokens with the reply: visible budget + high allowance
        expect(body.max_tokens).toBe(500 + 24576);

        // 'minimal' has no Claude equivalent: map to 'low'
        await service.chat('quick', { model: 'claude-sonnet-5', reasoning_effort: 'minimal', max_tokens: 500 });
        body = JSON.parse(global.fetch.mock.calls[1][1].body);
        expect(body.output_config).toEqual({ effort: 'low' });
        expect(body.max_tokens).toBe(500 + 4096);
        // Effortful (thinking) requests must not carry sampling params
        expect(body.temperature).toBeUndefined();

        // Haiku models don't support the effort parameter at all
        await service.chat('cheap', { model: 'claude-haiku-4-5', reasoning_effort: 'high', max_tokens: 500 });
        body = JSON.parse(global.fetch.mock.calls[2][1].body);
        expect(body.output_config).toBeUndefined();
        expect(body.max_tokens).toBe(500);

        // Adaptive-thinking models think even without a requested effort
        await service.chat('hi', { model: 'claude-fable-5', max_tokens: 500 });
        body = JSON.parse(global.fetch.mock.calls[3][1].body);
        expect(body.output_config).toBeUndefined();
        expect(body.max_tokens).toBe(500 + 24576);
    });

    test('streams SSE events, reports deltas, and assembles tool inputs', async () => {
        const encoder = new TextEncoder();
        const events = [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"echoMessage"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"text\\":"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"hi\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ];
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            body: new ReadableStream({
                start(controller) {
                    for (const event of events) {
                        controller.enqueue(encoder.encode(event));
                    }
                    controller.close();
                }
            })
        });

        const service = createService();
        const onDelta = jest.fn();
        const result = await service.chat('Stream please.', { onDelta });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.stream).toBe(true);
        expect(result.content).toBe('Hello');
        expect(result.toolCalls).toEqual([{ id: 'toolu_9', name: 'echoMessage', arguments: '{"text":"hi"}' }]);
        expect(onDelta).toHaveBeenNthCalledWith(1, 'Hel');
        expect(onDelta).toHaveBeenNthCalledWith(2, 'lo');
    });

    test('surfaces API errors with status and message', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'invalid x-api-key' } })
        });

        const service = createService();
        await expect(service.chat('hi')).rejects.toThrow('Anthropic API error 401: invalid x-api-key');
    });
});
