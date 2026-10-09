const db = require('@goobster/core/db');
const { PersonalAiService } = require('@goobster/core/services/personalAiService');
const { INVENTORY } = require('@goobster/core/services/accountExportData');

const A = '100000000000000001';
const B = '100000000000000002';
const URL = 'https://openrouter.ai/api/v1/chat/completions';
const oldKey = process.env.GOOBSTER_USER_AI_ENCRYPTION_KEY;
const modelRows = [
    { id: 'vendor/chat', name: 'Text model', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
    { id: 'vendor/image', architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] } },
    { id: 'vendor/audio', architecture: { input_modalities: ['text', 'audio'], output_modalities: ['text', 'audio'] } }
];
let service;
let request;
beforeAll(() => { process.env.GOOBSTER_USER_AI_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64'); });
beforeEach(async () => {
    await db.run('DELETE FROM user_ai_connections');
    request = jest.fn().mockResolvedValue({ data: modelRows });
    service = new PersonalAiService({ request });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
    if (oldKey === undefined) delete process.env.GOOBSTER_USER_AI_ENCRYPTION_KEY;
    else process.env.GOOBSTER_USER_AI_ENCRYPTION_KEY = oldKey;
});
const connect = (userId = A, apiKey = 'user-a-secret-key', models = { chat: 'vendor/chat' }) => service.save(userId, { apiKey, enabled: true, models });

test('stores a personal key encrypted, returns no secret, and preserves omitted fields', async () => {
    const saved = await connect();
    const row = await db.get('SELECT * FROM user_ai_connections WHERE userId = @userId', { userId: A });
    expect(row.encryptedKey).not.toContain('user-a-secret-key');
    expect(JSON.stringify(saved)).not.toMatch(/secret|encryptedKey|apiKey/);
    expect(saved).toMatchObject({ connected: true, enabled: true, completionUrl: URL, models: { chat: 'vendor/chat' } });
    await service.save(A, { models: { image: 'vendor/image' } });
    expect((await service.settings(A)).models).toMatchObject({ chat: 'vendor/chat', image: 'vendor/image' });
    const freshWorker = new PersonalAiService({ request });
    expect(await freshWorker.selection(A, 'chat')).toMatchObject({ apiKey: 'user-a-secret-key', model: 'vendor/chat' });
});

test('isolates credentials, settings and catalogs across accounts', async () => {
    await connect();
    request.mockResolvedValueOnce({ data: [{ id: 'other/chat' }] });
    await connect(B, 'user-b-secret-key', { chat: 'other/chat' });
    expect(await service.selection(A, 'chat')).toMatchObject({ apiKey: 'user-a-secret-key', model: 'vendor/chat' });
    expect(await service.selection(B, 'chat')).toMatchObject({ apiKey: 'user-b-secret-key', model: 'other/chat' });
    expect((await service.catalog(B)).models.map(m => m.id)).toEqual(['other/chat']);
    expect((await service.catalog(A)).models.map(m => m.id)).toContain('vendor/chat');
    expect((await service.settings('unconnected')).connected).toBe(false);
});

test('validates model assignments against advertised function capabilities', async () => {
    await connect();
    const catalog = await service.catalog(A);
    expect(catalog.models.find(m => m.id === 'vendor/chat').functions).not.toContain('image');
    expect(catalog.models.find(m => m.id === 'vendor/audio').functions).toEqual(expect.arrayContaining(['speech', 'transcription', 'voiceChat']));
    await expect(service.save(A, { models: { image: 'vendor/chat' } })).rejects.toMatchObject({ code: 'BAD_AI_MODEL' });
    await expect(service.save(A, { models: { unknown: 'vendor/chat' } })).rejects.toMatchObject({ code: 'BAD_AI_SETTINGS' });
    expect((await service.settings(A)).models.image).toBeNull();
});

test('failed connection and key replacement leave the existing connection intact', async () => {
    await connect();
    request.mockRejectedValue(new Error('credential must not escape'));
    await expect(service.save(A, { apiKey: 'invalid-new-key' })).rejects.toMatchObject({ code: 'AI_VERIFY_FAILED' });
    expect((await service.selection(A, 'chat')).apiKey).toBe('user-a-secret-key');
    await expect(service.save(B, { apiKey: 'invalid-other-key' })).rejects.toMatchObject({ code: 'AI_VERIFY_FAILED' });
    expect((await service.settings(B)).connected).toBe(false);
});

test.each([
    'http://openrouter.ai/api/v1/chat/completions',
    'https://127.0.0.1/chat/completions',
    'https://user:password@openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai:8443/api/v1/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions?key=secret',
    'https://unapproved.example/v1/chat/completions'
])('rejects unsafe or unapproved endpoint %s before sending credentials', async completionUrl => {
    await expect(service.save(A, { apiKey: 'user-secret', completionUrl })).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
});

test('approved compatible endpoints require an explicitly supplied key when changing origins', async () => {
    const config = require('@goobster/core/config/aiConfig');
    const hosts = config.personalEndpointHosts;
    config.personalEndpointHosts = ['compatible.example'];
    try {
        await connect();
        const completionUrl = 'https://compatible.example/v1/chat/completions';
        await expect(service.save(A, { completionUrl })).rejects.toMatchObject({ code: 'API_KEY_REQUIRED' });
        await service.save(A, { completionUrl, apiKey: 'new-endpoint-key' });
        expect((await service.settings(A)).models.chat).toBeNull();
        expect(request.mock.calls.at(-1)[1]).toBe('https://compatible.example/v1/models');
    } finally { config.personalEndpointHosts = hosts; }
});

test('refresh retains stale catalog and resets are possible during an outage', async () => {
    await connect();
    const prior = await service.catalog(A);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
    request.mockRejectedValue(new Error('private error'));
    const stale = await service.catalog(A, { refresh: true });
    expect(stale).toMatchObject({ status: 'stale', checkedAt: prior.checkedAt, models: prior.models });
    expect(JSON.stringify(stale)).not.toContain('private error');
    await service.save(A, { models: { chat: null }, enabled: false });
    expect(await service.selection(A, 'chat')).toBeNull();
    await service.disconnect(A);
    expect((await service.settings(A)).connected).toBe(false);
});

test('chat uses the selected personal model, key, tools and normalized tool history', async () => {
    await connect();
    request.mockResolvedValueOnce({ choices: [{ message: { content: 'Done', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    const onDelta = jest.fn();
    const connection = await service.selection(A, 'chat');
    const result = await service.chat(connection, [
        { role: 'assistant', toolCalls: [{ id: 'prior', name: 'lookup', arguments: {} }] },
        { role: 'tool', toolCallId: 'prior', content: 'result' }
    ], { functions: [{ name: 'lookup', parameters: { type: 'object' } }], onDelta });
    expect(request.mock.calls.at(-1)[0].apiKey).toBe('user-a-secret-key');
    expect(request.mock.calls.at(-1)[2]).toMatchObject({ model: 'vendor/chat', tools: [{ type: 'function', function: { name: 'lookup' } }],
        messages: [{ role: 'assistant', tool_calls: [{ id: 'prior', function: { arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'prior' }] });
    expect(result).toEqual({ content: 'Done', toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{}' }] });
    expect(onDelta).toHaveBeenCalledWith('Done');
});

test('image, speech and audio input use the completions modality contract', async () => {
    await connect(A, 'user-a-secret-key', { image: 'vendor/image', speech: 'vendor/audio', transcription: 'vendor/audio' });
    const png = await require('sharp')({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    request.mockResolvedValueOnce({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] } }] });
    expect((await service.image(await service.selection(A, 'image'), 'A red dot')).length).toBeGreaterThan(0);
    expect(request.mock.calls.at(-1)[2]).toMatchObject({ model: 'vendor/image', modalities: ['image', 'text'] });
    request.mockResolvedValueOnce({ choices: [{ message: { audio: { data: Buffer.from('wave').toString('base64') } } }] });
    expect((await service.speech(await service.selection(A, 'speech'), 'Hello')).contentType).toBe('audio/wav');
    request.mockResolvedValueOnce({ choices: [{ message: { content: 'hello' } }] });
    expect(await service.transcribe(await service.selection(A, 'transcription'), Buffer.from('wav'), 'audio/wav')).toEqual({ text: 'hello' });
    expect(request.mock.calls.at(-1)[2].messages[0].content[1]).toMatchObject({ type: 'input_audio', input_audio: { format: 'wav' } });
});

test('account export explicitly omits the encrypted credential', () => {
    const entry = INVENTORY.find(([table]) => table === 'user_ai_connections');
    expect(entry[2]).not.toContain('encryptedKey');
    expect(entry[2]).not.toBe('*');
});

test('router uses personal assignments only in the matching private scope and never falls back on failure', async () => {
    const router = require('@goobster/core/services/aiService');
    const personal = require('@goobster/core/services/personalAiService');
    const selection = { apiKey: 'private-key', model: 'vendor/chat', completionUrl: URL, userId: A };
    const select = jest.spyOn(personal, 'selection').mockResolvedValue(selection);
    const chat = jest.spyOn(personal, 'chat').mockResolvedValue({ content: 'Personal', toolCalls: [] });
    jest.spyOn(router, '_admit').mockImplementation(async (opts, work) => work());
    const host = jest.spyOn(router, '_resolveProvider').mockReturnValue({ chat: jest.fn().mockResolvedValue({ content: 'Host' }) });
    expect(await router.chat('Hi', { usageContext: { userId: A, guildId: `dm:${A}` } })).toMatchObject({ content: 'Personal' });
    expect(host).not.toHaveBeenCalled();
    expect(select).toHaveBeenLastCalledWith(A, 'chat');
    await router.chat('Hi', { workflow: 'research', usageContext: { userId: A, guildId: `dm:${A}` } });
    expect(select).toHaveBeenLastCalledWith(A, 'research');
    chat.mockRejectedValue(new Error('personal account exhausted'));
    await expect(router.chat('Hi', { usageContext: { userId: A, guildId: `dm:${A}` } })).rejects.toThrow('personal account exhausted');
    expect(host).not.toHaveBeenCalled();
    await router.chat('Guild', { usageContext: { userId: A, guildId: 'shared-guild' } });
    expect(host).toHaveBeenCalledTimes(1);
    await router.chat('Mismatched scope', { usageContext: { userId: B, guildId: `dm:${A}` } });
    expect(host).toHaveBeenCalledTimes(2);
});
