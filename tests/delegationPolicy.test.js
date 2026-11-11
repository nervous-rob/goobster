const aiConfig = require('@goobster/core/config/aiConfig');
const workContext = require('@goobster/core/utils/workContext');
const { applyDelegationPolicy } = require('@goobster/core/utils/delegationPolicy');
const registry = require('@goobster/core/models/registry');
const original = aiConfig.delegation;
afterEach(() => { aiConfig.delegation = original; jest.restoreAllMocks(); });

test('interactive chat retains its model and output settings', () => {
    aiConfig.delegation = { provider: 'anthropic', model: 'claude-sonnet-5', maxOutputTokens: 512 };
    const opts = { provider: 'openai', model: 'gpt-6-sol', max_tokens: 8000 };
    expect(workContext.run({ kind: 'chat' }, () => applyDelegationPolicy(opts))).toBe(opts);
});

test.each(['assistant_run', 'assistant_classification', 'automation', 'watch', 'job', 'expedition'])('%s cannot override the host route or output cap', kind => {
    aiConfig.delegation = { provider: 'anthropic', model: 'claude-sonnet-5', maxOutputTokens: 512 };
    const opts = workContext.run({ kind }, () => applyDelegationPolicy({ provider: 'openai', model: 'gpt-6-sol', max_tokens: 9000, personalAiDisabled: false }));
    expect(opts).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', max_tokens: 512, personalAiDisabled: true });
    expect(registry.resolveRequest(opts.provider, opts.model, { ...opts, reasoning_effort: 'high' }).maxOutputTokens).toBe(512);
});

test('background requests inherit routing by default and respect a smaller request budget', () => {
    aiConfig.delegation = { provider: '', model: '', maxOutputTokens: 4096 };
    const result = applyDelegationPolicy({ background: true, provider: 'openai', model: 'gpt-4o', max_tokens: 100 });
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-4o', max_tokens: 100, personalAiDisabled: false });
});

test('a stricter output ceiling survives host policy and reasoning headroom', () => {
    aiConfig.delegation = { provider: '', model: '', maxOutputTokens: 4096 };
    const opts = applyDelegationPolicy({ background: true, provider: 'openai', model: 'gpt-6-sol', max_tokens: 1200, max_output_tokens_limit: 256 });
    expect(opts).toMatchObject({ max_tokens: 256, max_output_tokens_limit: 256 });
    expect(registry.resolveRequest(opts.provider, opts.model, { ...opts, reasoning_effort: 'high' }).maxOutputTokens).toBe(256);
});

test('classification keeps its smaller visible budget', () => {
    aiConfig.delegation = { provider: '', model: '', maxOutputTokens: 4096 };
    const opts = workContext.run({ kind: 'assistant_classification' }, () => applyDelegationPolicy({ max_tokens: 8 }));
    expect(opts.max_tokens).toBe(8);
});

test('reported delegated routes obey the same host pin as model requests', async () => {
    const aiService = require('@goobster/core/services/aiService');
    const personal = require('@goobster/core/services/personalAiService');
    const selection = jest.spyOn(personal, 'selection').mockResolvedValue({ model: 'personal/model' });
    aiConfig.delegation = { provider: 'anthropic', model: 'claude-sonnet-5', maxOutputTokens: 512 };
    const opts = { background: true, provider: 'openai', model: 'gpt-6-sol', usageContext: { userId: '123', guildId: 'dm:123' } };
    expect(await aiService.routeFor(opts)).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', personal: false });
    expect(selection).not.toHaveBeenCalled();
    expect(await aiService.routeFor({ ...opts, background: false })).toEqual({ provider: 'openrouter', model: 'personal/model', personal: true });
});

test.each(['chat', 'generateText'])('%s applies the policy before provider selection and admission', async method => {
    const aiService = require('@goobster/core/services/aiService');
    const personal = require('@goobster/core/services/personalAiService');
    const selection = jest.spyOn(personal, 'selection').mockResolvedValue({ model: 'personal/model' });
    const provider = { [method]: jest.fn().mockResolvedValue(method === 'chat' ? { content: 'done', toolCalls: [] } : 'done') };
    const resolve = jest.spyOn(aiService, '_resolveProvider').mockReturnValue(provider);
    const admit = jest.spyOn(aiService, '_admit').mockImplementation((_opts, work) => work());
    aiConfig.delegation = { provider: 'anthropic', model: 'claude-sonnet-5', maxOutputTokens: 512 };
    await workContext.run({ kind: 'assistant_run', id: '1' }, () => aiService[method]('task', {
        provider: 'openai', model: 'gpt-6-sol', max_tokens: 1200, usageContext: { userId: '123', guildId: 'dm:123' }
    }));
    expect(selection).not.toHaveBeenCalled();
    const expected = { provider: 'anthropic', model: 'claude-sonnet-5', max_tokens: 512, max_output_tokens_limit: 512, personalAiDisabled: true };
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining(expected));
    expect(admit.mock.calls[0][0]).toMatchObject(expected);
    expect(provider[method]).toHaveBeenCalledWith('task', expect.objectContaining(expected));
});

test('pinning just the provider clears a model from another provider', () => {
    aiConfig.delegation = { provider: 'gemini', model: '', maxOutputTokens: 1024 };
    expect(applyDelegationPolicy({ background: true, model: 'gpt-6-sol' }).model).toBeUndefined();
});

test.each([0, -1, NaN, 1.5, 200000])('malformed host cap %s fails closed', maxOutputTokens => {
    aiConfig.delegation = { provider: '', model: '', maxOutputTokens };
    expect(() => applyDelegationPolicy({ background: true })).toThrow('maxOutputTokens');
});
