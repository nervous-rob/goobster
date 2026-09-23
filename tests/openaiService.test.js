describe('OpenAIService request parameters', () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function createService(defaultModel = 'gpt-6-sol') {
        const response = {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
            usage: { input_tokens: 2, output_tokens: 3 }
        };
        const create = jest.fn().mockResolvedValue(response);
        jest.doMock('openai', () => ({
            OpenAI: jest.fn().mockImplementation(() => ({ responses: { create } }))
        }));
        jest.doMock('@goobster/core/config/aiConfig', () => ({
            openai: { apiKey: 'test-openai-key', chatModel: defaultModel }
        }));
        jest.doMock('@goobster/core/services/usageTracker', () => ({ log: jest.fn() }));
        return { service: require('@goobster/core/services/openaiService'), create, response };
    }

    test.each([
        'gpt-6-sol',
        'gpt-6-astra',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'o3'
    ])('%s omits explicit and preset sampling params and reserves default thinking headroom', async (model) => {
        const { service, create } = createService('gpt-4o');
        await service.chat('Hello', {
            model, preset: 'creative', temperature: 0.7, top_p: 0.9, max_tokens: 500
        });

        const request = create.mock.calls[0][0];
        expect(request.model).toBe(model);
        expect(request).not.toHaveProperty('temperature');
        expect(request).not.toHaveProperty('top_p');
        expect(request).not.toHaveProperty('reasoning');
        expect(request.max_output_tokens).toBe(500 + 8192);
        expect(create).toHaveBeenCalledTimes(1);
    });

    test('generateText uses the configured GPT-6 model with default thinking headroom', async () => {
        const { service, create } = createService();
        await expect(service.generateText('Hello')).resolves.toBe('Hello');
        const request = create.mock.calls[0][0];
        expect(request.model).toBe('gpt-6-sol');
        expect(request.max_output_tokens).toBe(1024 + 8192);
        expect(request).not.toHaveProperty('temperature');
        expect(request).not.toHaveProperty('top_p');
    });

    test.each([
        ['minimal', 'low', 4096],
        ['low', 'low', 4096],
        ['medium', 'medium', 8192],
        ['high', 'high', 24576]
    ])('GPT-6 Sol maps %s effort to %s and budgets for the effective effort', async (requested, effective, allowance) => {
        const { service, create } = createService();
        await service.chat('Hello', { reasoning_effort: requested, max_tokens: 500 });
        const request = create.mock.calls[0][0];
        expect(request.reasoning).toEqual({ effort: effective });
        expect(request.max_output_tokens).toBe(500 + allowance);
        expect(request).not.toHaveProperty('temperature');
        expect(request).not.toHaveProperty('top_p');
    });

    test('rejects an unreviewed model before sending an API request', async () => {
        const { service, create } = createService();
        await expect(service.chat('Hi', { model: 'gpt-6-sol-unreviewed' })).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
        expect(create).not.toHaveBeenCalled();
    });

    test('supports sampling when GPT-6 Sol reasoning is explicitly off', async () => {
        const { service, create } = createService();
        await service.chat('Hi', { reasoning_effort: 'none', temperature: 0.4, top_p: 0.8, max_tokens: 500 });
        expect(create.mock.calls[0][0]).toMatchObject({ reasoning: { effort: 'none' }, temperature: 0.4, top_p: 0.8, max_output_tokens: 500 });
    });

    test('normalizes a default minimal effort and lets per-call effort override it', async () => {
        const { service, create } = createService();
        service.setDefaultReasoningEffort('minimal');
        await service.chat('Quick answer', { max_tokens: 500 });
        await service.chat('Think harder', { reasoning_effort: 'high', max_tokens: 500 });

        expect(create.mock.calls[0][0]).toMatchObject({
            reasoning: { effort: 'low' }, max_output_tokens: 500 + 4096
        });
        expect(create.mock.calls[1][0]).toMatchObject({
            reasoning: { effort: 'high' }, max_output_tokens: 500 + 24576
        });
        expect(service.getDefaultReasoningEffort()).toBe('minimal');
    });

    test('preserves minimal effort handling for GPT-5', async () => {
        const { service, create } = createService('gpt-5');
        await service.chat('Hello', { reasoning_effort: 'minimal', max_tokens: 500 });
        expect(create.mock.calls[0][0]).toMatchObject({
            reasoning: { effort: 'minimal' }, max_output_tokens: 500 + 1024
        });
    });

    test.each([
        [{}, 0.7, 1, 1024],
        [{ preset: 'creative' }, 0.8, 0.95, 1024],
        [{ preset: 'creative', temperature: 0, top_p: 0.5, max_tokens: 500 }, 0, 0.5, 500]
    ])('preserves sampling and output budgets for GPT-4o with options %j', async (options, temperature, top_p, budget) => {
        const { service, create } = createService('gpt-4o');
        await service.chat('Hello', { ...options, reasoning_effort: 'high' });
        expect(create.mock.calls[0][0]).toMatchObject({
            temperature, top_p, max_output_tokens: budget
        });
        expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning');
    });

    test('streams GPT-6 tool responses with reasoning, cancellation, and usage intact', async () => {
        const { service, create, response } = createService();
        response.output.push({
            type: 'function_call', call_id: 'call-1', name: 'echo', arguments: '{"text":"hi"}'
        });
        create.mockResolvedValue((async function* () {
            yield { type: 'response.output_text.delta', delta: 'Hello' };
            yield { type: 'response.completed', response };
        })());
        const onDelta = jest.fn();
        const signal = new AbortController().signal;
        const result = await service.chat('Hello', {
            onDelta, signal, preset: 'creative', reasoning_effort: 'high', max_tokens: 500,
            functions: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object' } }],
            usageContext: { userId: 'user-1', guildId: 'dm:user-1' }
        });

        const request = create.mock.calls[0][0];
        expect(request).toMatchObject({
            model: 'gpt-6-sol', stream: true, store: false,
            reasoning: { effort: 'high' }, max_output_tokens: 500 + 24576,
            tools: [{ type: 'function', name: 'echo', description: 'Echo text', parameters: { type: 'object' } }]
        });
        expect(request).not.toHaveProperty('temperature');
        expect(request).not.toHaveProperty('top_p');
        expect(create.mock.calls[0][1]).toEqual({ signal, maxRetries: 0 });
        expect(onDelta).toHaveBeenCalledWith('Hello');
        expect(result).toEqual({
            content: 'Hello', toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' }]
        });
        expect(require('@goobster/core/services/usageTracker').log).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'openai', model: 'gpt-6-sol', inputTokens: 2, outputTokens: 3,
            userId: 'user-1', guildId: 'dm:user-1'
        }));
    });
});
