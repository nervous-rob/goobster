/**
 * Best-guess profiles for unreviewed chat models (ADR 0011, "Best guesses
 * for unreviewed models"): a recognizable family borrows the nearest
 * reviewed sibling's controls, gets a readable name and a description that
 * says it is a guess; limits are never guessed; an unrecognizable id keeps
 * the minimal provider-default contract.
 */
const inference = require('@goobster/core/models/inference');
const { MODELS, PROFILES } = require('@goobster/core/models/catalog');
const registry = require('@goobster/core/models/registry');

const reviewed = id => MODELS.find(model => model.id === id);

test.each([
    ['anthropic', 'claude-sonnet-6-20270101', 'claude-sonnet-5', 'Claude Sonnet 6 (2027-01-01)'],
    ['anthropic', 'claude-opus-6', 'claude-opus-5-5', 'Claude Opus 6'],
    ['anthropic', 'claude-mythos-5-2', 'claude-fable-5-1', 'Claude Mythos 5.2'],
    ['anthropic', 'claude-haiku-5', 'claude-haiku-4-5', 'Claude Haiku 5'],
    ['anthropic', 'claude-3-5-sonnet-20241022', 'claude-haiku-4-5', 'Claude Sonnet 3.5 (2024-10-22)'],
    ['openai', 'gpt-7', 'gpt-6-sol', 'GPT-7'],
    ['openai', 'gpt-6-astra-2027-01-01', 'gpt-6-astra', 'GPT-6 Astra (2027-01-01)'],
    ['openai', 'gpt-5.8', 'gpt-5.6-sol', 'GPT-5.8'],
    ['openai', 'gpt-5-mini-2026-01-01', 'gpt-5-mini', 'GPT-5 Mini (2026-01-01)'],
    ['openai', 'gpt-5-chat-latest', 'gpt-4.1', 'GPT-5 Chat Latest'],
    ['openai', 'gpt-4o-2024-11-20', 'gpt-4o', 'GPT-4o (2024-11-20)'],
    ['openai', 'o4-mini', 'o3-mini', 'o4 mini'],
    ['gemini', 'gemini-4-flash-lite-preview', 'gemini-3.5-flash', 'Gemini 4 Flash Lite Preview'],
    ['gemini', 'gemini-3.5-pro', 'gemini-3.1-pro-preview', 'Gemini 3.5 Pro'],
    ['gemini', 'gemini-2.0-flash', 'gemini-2.5-flash', 'Gemini 2.0 Flash'],
    ['gemini', 'gemini-flash-latest', 'gemini-3.5-flash', 'Gemini Flash Latest'],
    ['ollama', 'qwen3:8b', 'llama3.2:3b', 'Qwen3 8B (local)'],
    ['ollama', 'mistral', 'llama3.2:3b', 'Mistral (local)']
])('%s %s borrows %s and reads as "%s"', (provider, id, basisId, name) => {
    const guess = inference.infer(provider, id);
    const basis = reviewed(basisId);
    expect(guess).toMatchObject({ basis: basisId, basisName: basis.displayName, profile: basis.profile, displayName: name });
    expect(guess.description).toContain('Best guess');
    expect(guess.description).toContain(basis.displayName);
    expect(guess.reasoning).toEqual({ ...PROFILES[basis.profile].reasoning, ...basis.reasoning });
    expect(guess.sampling).toEqual({ ...PROFILES[basis.profile].sampling, ...basis.sampling });
    expect(guess.capabilities).toMatchObject({ ...PROFILES[basis.profile].capabilities, ...basis.capabilities });
    const model = registry.get(provider, id);
    expect(model).toMatchObject({ status: 'discovered', displayName: name, contextWindow: null, maxOutputTokens: null, guess: { source: 'heuristic', basis: basisId } });
    expect(model.reasoning.levels).toEqual(guess.reasoning.levels);
});

test('a reviewed id is never re-guessed and an unrecognizable id keeps minimal provider defaults', () => {
    expect(registry.get('anthropic', 'claude-opus-5-5').status).toBe('supported');
    expect(registry.get('anthropic', 'claude-opus-5-5').guess).toBeUndefined();
    for (const [provider, id] of [['anthropic', 'claude-x'], ['gemini', 'gemini-exp-1206']]) {
        expect(inference.infer(provider, id)).toBeNull();
        expect(registry.get(provider, id)).toMatchObject({
            status: 'discovered', guess: null, reasoning: { levels: [] }, sampling: { mode: 'never' },
            capabilities: { imageInput: false, nativeSearch: false }, input: ['text']
        });
    }
    expect(registry.get('anthropic', 'claude-x').displayName).toBe('Claude X');
    expect(inference.infer('openai', '')).toBeNull();
    expect(inference.infer('nope', 'gpt-7')).toBeNull();
});

test('a guessed profile validates requests like its basis, with unknown limits', () => {
    const sonnet = registry.resolveRequest('anthropic', 'claude-sonnet-6', { max_tokens: 500, reasoning_effort: 'low' });
    expect(sonnet).toMatchObject({ effort: 'low', maxOutputTokens: 4596, sampling: {} });
    // The borrowed Sonnet 5 contract carries Anthropic's full effort range; OpenAI-only levels still fail.
    expect(registry.resolveRequest('anthropic', 'claude-sonnet-6', { max_tokens: 500, reasoning_effort: 'max' })).toMatchObject({ effort: 'max', maxOutputTokens: 66036 });
    expect(() => registry.resolveRequest('anthropic', 'claude-sonnet-6', { reasoning_effort: 'none' })).toThrow(expect.objectContaining({ code: 'BAD_REASONING' }));
    const chat = registry.resolveRequest('openai', 'gpt-5-chat-latest', { max_tokens: 500, temperature: 0.4 });
    expect(chat.sampling).toEqual({ temperature: 0.4, top_p: 1 });
    expect(registry.resolveRequest('openai', 'gpt-7', { max_tokens: 100000, reasoning_effort: 'max' }).maxOutputTokens).toBe(165536);
    expect(() => registry.resolveRequest('openai', 'o4-mini', { webSearch: true })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SEARCH' }));
    expect(registry.get('ollama', 'llama3.2-vision:11b').capabilities.imageInput).toBe(true);
    expect(registry.get('ollama', 'qwen3:8b').capabilities.imageInput).toBe(false);
});
