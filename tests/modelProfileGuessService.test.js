/**
 * Goobster's written best guess about an unreviewed model (ADR 0011, "Best
 * guesses for unreviewed models"): the provider's documentation page is
 * read first; its text and the controls it states are stored once per
 * provider/model; the text decorates later listings; the controls overlay
 * the registry's name guess (clamped to the adapter, under the live
 * listing) in this and other processes; a page that cannot be read means a
 * name-only description with no control claims; failures back off; nothing
 * beyond the validated fields is persisted. Runs on both engines.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-model-guesses-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const registry = require('@goobster/core/models/registry');
const providerDefaults = require('@goobster/core/models/providerDefaults');
const { ModelProfileGuessService, LIMITS, docUrls, excerpt, parseControls } = require('@goobster/core/services/modelProfileGuessService');

const PROMPT_MARK = 'Reply with ONLY a JSON object';
const PAGE_MARK = 'PAGE-TEXT-that-must-never-be-stored';
const SONNET_PAGE = `# Claude Sonnet 6\n\n${PAGE_MARK}\n\n| Claude API ID | \`claude-sonnet-6\` |\n| Context window | 1M tokens |\n| Max output | 128K tokens |\n| Default effort | high |\n\nSupports the effort parameter at low, medium, high, xhigh and max. Text and image input. Web search tool supported.`;

function catalogFor(provider, ids, { availability = 'listed' } = {}) {
    return {
        version: 1, provider, workflow: 'chat',
        models: ids.map(id => ({ ...registry.get(provider, id), availability, selectable: true })),
        discovery: { status: 'live', checkedAt: '2026-10-10T00:00:00Z' }, unregisteredCount: 0
    };
}

const noDocs = async () => null;

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM model_profile_guesses');
    for (const provider of ['openai', 'anthropic', 'gemini', 'ollama']) {
        providerDefaults.replaceStoredControls(provider, {});
        providerDefaults.setListingEvidence(provider, {});
    }
});

test('documentation pages are looked up most-specific first and only passages naming the model are kept', () => {
    expect(docUrls('anthropic', 'claude-sonnet-6-20270101')[0]).toBe('https://platform.claude.com/docs/en/models/sonnet-6/overview.md');
    expect(docUrls('openai', 'gpt-7')[0]).toBe('https://developers.openai.com/api/docs/models/gpt-7');
    expect(docUrls('gemini', 'gemini-4-flash')[0]).toBe('https://ai.google.dev/gemini-api/docs/models/gemini-4-flash');
    expect(docUrls('ollama', 'qwen3:8b')).toEqual(['https://ollama.com/library/qwen3']);
    expect(docUrls('nope', 'x')).toEqual([]);
    const text = `${'a'.repeat(2000)} The gpt-7 model is here. ${'b'.repeat(2000)} Also GPT-7 again. ${'c'.repeat(2000)}`;
    const passages = excerpt(text, ['gpt-7', 'GPT-7']);
    expect(passages).toContain('The gpt-7 model is here.');
    expect(passages).toContain('Also GPT-7 again.');
    expect(passages.length).toBeLessThan(text.length);
    expect(excerpt(text, ['claude'])).toBeNull();
});

test('controls read from a page are clamped to the adapter and dropped when confidence is low', () => {
    const model = registry.get('anthropic', 'claude-sonnet-6');
    const read = { controls: { contextWindow: 1000000, maxOutputTokens: 128000, imageInput: true, webSearch: true,
        reasoning: { supported: true, levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'xhigh' }, sampling: 'unsupported', confidence: 'high' } };
    expect(parseControls('anthropic', read, model)).toEqual({
        contextWindow: 1000000, maxOutputTokens: 128000, imageInput: true, nativeSearch: true,
        reasoning: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'xhigh' }, sampling: 'never'
    });
    expect(parseControls('anthropic', { controls: { ...read.controls, confidence: 'low' } }, model)).toBeNull();
    expect(parseControls('openai', { controls: { contextWindow: 12, reasoning: { supported: false }, sampling: 'supported' } }, model))
        .toEqual({ reasoning: { levels: [], default: null }, sampling: 'always' });
    expect(parseControls('openai', { controls: { reasoning: { supported: true, levels: ['ultra'] } } }, model)).toBeNull();
    expect(parseControls('openai', { description: 'no controls' }, model)).toBeNull();
});

test('reads the documentation, stores text and controls, and the registry applies them under the live listing', async () => {
    const calls = [];
    const service = new ModelProfileGuessService({
        enabled: true,
        fetchDoc: async url => (url.includes('/models/sonnet-6/') ? SONNET_PAGE : null),
        generateText: async (prompt, { model, docs }) => {
            calls.push({ prompt, id: model.id, docs });
            return `{"description": "A newer Claude Sonnet generation for everyday conversation and tool use.",
                "bestFor": "General chat, writing and coding help", "caveat": "Read from the documentation; verify on your account.",
                "controls": {"contextWindow": 1000000, "maxOutputTokens": 128000, "imageInput": true, "webSearch": true,
                  "reasoning": {"supported": true, "levels": ["low", "medium", "high", "xhigh", "max"], "default": "high"},
                  "sampling": "unsupported", "confidence": "high"}}`;
        }
    });
    const first = await service.decorate(catalogFor('anthropic', ['claude-sonnet-5', 'claude-sonnet-6']));
    expect(first.pendingGuesses).toBe(1);
    expect(first.models.find(m => m.id === 'claude-sonnet-6')).toMatchObject({ guess: { source: 'heuristic' }, contextWindow: null });
    await service.settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].docs.url).toContain('/models/sonnet-6/overview.md');
    expect(calls[0].prompt).toContain(PROMPT_MARK);
    expect(calls[0].prompt).toContain('Max output | 128K tokens');
    expect(calls[0].prompt).toContain('"controls"');

    const rows = await db.all('SELECT * FROM model_profile_guesses');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'anthropic', modelId: 'claude-sonnet-6', evidence: 'docs', sourceUrl: expect.stringContaining('sonnet-6') });
    expect(JSON.parse(rows[0].controlsJson)).toEqual({
        contextWindow: 1000000, maxOutputTokens: 128000, imageInput: true, nativeSearch: true,
        reasoning: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' }, sampling: 'never'
    });
    expect(JSON.stringify(rows)).not.toContain(PROMPT_MARK);
    expect(JSON.stringify(rows)).not.toContain(PAGE_MARK);

    // This process: the registry fallback now carries the documented limits.
    const model = registry.get('anthropic', 'claude-sonnet-6');
    expect(model).toMatchObject({ status: 'discovered', contextWindow: 1000000, maxOutputTokens: 128000, guess: { controls: expect.arrayContaining(['contextWindow', 'reasoning']) } });
    expect(registry.resolveRequest('anthropic', 'claude-sonnet-6', { max_tokens: 200000, reasoning_effort: 'high' }).maxOutputTokens).toBe(128000);

    const second = await service.decorate(catalogFor('anthropic', ['claude-sonnet-5', 'claude-sonnet-6']));
    expect(second.pendingGuesses).toBe(0);
    const sonnet = second.models.find(m => m.id === 'claude-sonnet-6');
    expect(sonnet.description).toBe('A newer Claude Sonnet generation for everyday conversation and tool use.');
    expect(sonnet.guess).toMatchObject({
        source: 'ai', evidence: 'docs', basis: 'claude-sonnet-5', bestFor: 'General chat, writing and coding help',
        caveat: 'Read from the documentation; verify on your account.', sourceUrl: expect.stringContaining('sonnet-6')
    });
    expect(sonnet.guess.writtenAt).toBeTruthy();
    expect(second.models.find(m => m.id === 'claude-sonnet-5')).toMatchObject({ description: registry.get('anthropic', 'claude-sonnet-5').description });
    expect(second.models.find(m => m.id === 'claude-sonnet-5').guess).toBeUndefined();

    // Another process: a fresh service loads the stored controls into its registry.
    providerDefaults.replaceStoredControls('anthropic', {});
    expect(registry.get('anthropic', 'claude-sonnet-6').contextWindow).toBeNull();
    const other = new ModelProfileGuessService({ enabled: true, fetchDoc: noDocs, generateText: async () => '{}' });
    await other.ensureLoaded();
    expect(registry.get('anthropic', 'claude-sonnet-6').contextWindow).toBe(1000000);

    // The live listing remains the stronger evidence.
    providerDefaults.setListingEvidence('anthropic', { 'claude-sonnet-6': { maxOutputTokens: 64000, nativeSearch: false } });
    expect(registry.get('anthropic', 'claude-sonnet-6')).toMatchObject({ maxOutputTokens: 64000, contextWindow: 1000000, capabilities: { nativeSearch: false } });
});

test('without a readable page the description is name-only and no control is claimed', async () => {
    const generateText = jest.fn(async () => `{"description": "A GPT-7 generation model for reasoning and tools.", "bestFor": "Hard problems",
        "controls": {"contextWindow": 4000000, "reasoning": {"supported": false}, "confidence": "high"}}`);
    const service = new ModelProfileGuessService({ enabled: true, fetchDoc: noDocs, generateText });
    await service.decorate(catalogFor('openai', ['gpt-7']));
    await service.settle();
    expect(generateText.mock.calls[0][0]).toContain('No documentation page could be read');
    expect(generateText.mock.calls[0][0]).not.toContain('"controls"');
    const [row] = await db.all('SELECT * FROM model_profile_guesses');
    expect(row).toMatchObject({ evidence: 'name', sourceUrl: null, controlsJson: null });
    const catalog = await service.decorate(catalogFor('openai', ['gpt-7']));
    expect(catalog.models[0]).toMatchObject({ contextWindow: null, reasoning: { levels: registry.get('openai', 'gpt-6-sol').reasoning.levels }, guess: { source: 'ai', evidence: 'name' } });
});

test('an unusable or failed answer leaves the heuristic text, backs off, and is retried after the window', async () => {
    let answer = () => { throw new Error('offline'); };
    const generateText = jest.fn(async () => answer());
    const service = new ModelProfileGuessService({ enabled: true, fetchDoc: noDocs, generateText });
    await service.decorate(catalogFor('openai', ['gpt-7']));
    await service.settle();
    expect(generateText).toHaveBeenCalledTimes(1);
    let catalog = await service.decorate(catalogFor('openai', ['gpt-7']));
    await service.settle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(catalog.pendingGuesses).toBe(0);
    expect(catalog.models[0]).toMatchObject({ guess: { source: 'heuristic' } });
    expect(catalog.models[0].description).toContain('Best guess from the name');

    answer = () => 'not json at all';
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
    await service.decorate(catalogFor('openai', ['gpt-7']));
    await service.settle();
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(await db.all('SELECT * FROM model_profile_guesses')).toEqual([]);

    answer = () => `{"description": "${'x'.repeat(400)}", "bestFor": "see https://example.test", "caveat": 7}`;
    clock.mockReturnValue(Date.now() + 2 * 61 * 60 * 1000);
    await service.decorate(catalogFor('openai', ['gpt-7']));
    await service.settle();
    catalog = await service.decorate(catalogFor('openai', ['gpt-7']));
    expect(catalog.models[0].description).toHaveLength(LIMITS.description);
    expect(catalog.models[0].guess).toMatchObject({ source: 'ai', bestFor: null, caveat: null });
    clock.mockRestore();
});

test('nothing is written when the feature is off, no provider can answer, or the model is not listed', async () => {
    const generateText = jest.fn();
    const fetchPage = jest.fn(noDocs);
    const off = new ModelProfileGuessService({ enabled: false, fetchDoc: fetchPage, generateText });
    expect((await off.decorate(catalogFor('openai', ['gpt-7']))).pendingGuesses).toBe(0);
    const unlisted = new ModelProfileGuessService({ enabled: true, fetchDoc: fetchPage, generateText });
    expect((await unlisted.decorate(catalogFor('openai', ['gpt-7'], { availability: 'unknown' }))).pendingGuesses).toBe(0);
    const keyless = new ModelProfileGuessService({ enabled: true, fetchDoc: fetchPage });
    jest.spyOn(keyless, 'canWrite').mockReturnValue(false);
    expect((await keyless.decorate(catalogFor('openai', ['gpt-7']))).pendingGuesses).toBe(0);
    await Promise.all([off.settle(), unlisted.settle(), keyless.settle()]);
    expect(generateText).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(await db.all('SELECT * FROM model_profile_guesses')).toEqual([]);
    expect(await off.decorate(null)).toBeNull();
});

test('forget drops stored text and controls so they are written again', async () => {
    const generateText = jest.fn(async () => '{"description": "A local Qwen model for quick text chat on this machine.", "controls": {"imageInput": true, "confidence": "high"}}');
    const service = new ModelProfileGuessService({ enabled: true, fetchDoc: async () => 'qwen3 is a model family. qwen3:8b has vision.', generateText });
    await service.decorate(catalogFor('ollama', ['qwen3:8b']));
    await service.settle();
    expect(registry.get('ollama', 'qwen3:8b')).toMatchObject({ capabilities: { imageInput: true }, input: ['text', 'image'] });
    expect((await service.decorate(catalogFor('ollama', ['qwen3:8b']))).models[0].guess).toMatchObject({ source: 'ai', evidence: 'docs' });
    await service.forget('ollama', 'qwen3:8b');
    expect(registry.get('ollama', 'qwen3:8b').capabilities.imageInput).toBe(false);
    await service.decorate(catalogFor('ollama', ['qwen3:8b']));
    await service.settle();
    expect(generateText).toHaveBeenCalledTimes(2);
    await service.forget('ollama');
    expect(await db.all('SELECT * FROM model_profile_guesses')).toEqual([]);
});
