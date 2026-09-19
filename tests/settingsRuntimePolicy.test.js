const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const TEST_DB = path.join(os.tmpdir(), `goobster-settings-runtime-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({}));
const db = require('@goobster/core/db');
const settings = require('@goobster/core/services/userSettingsService');
const policy = require('@goobster/core/services/personalPolicyService');
const integrations = require('@goobster/core/utils/tools/integrations');
const notion = require('@goobster/core/services/notionService');
const userIntegration = require('@goobster/core/services/userIntegrationService');
const USER = '910000000000000001';
const PAGE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const context = { user: { id: USER } };
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
});

test('Notion enforces canonical IDs on search and read, including forged slugs and legacy titles', async () => {
    jest.spyOn(userIntegration, 'getToken').mockResolvedValue('fake-token');
    const read = jest.spyOn(notion, 'getPageText').mockResolvedValue({ title: 'Allowed', content: 'body' });
    jest.spyOn(notion, 'search').mockResolvedValue([
        { id: PAGE, title: 'Allowed' }, { id: OTHER, title: 'Allowed but unrelated' }
    ]);
    await expect(settings.updateSection({ userId: USER, section: 'connections', changes: { notionAllowlist: ['Allowed'] } }))
        .rejects.toMatchObject({ code: 'BAD_ALLOWLIST' });
    await settings.updateSection({ userId: USER, section: 'connections', changes: { notionAllowlist: [`https://www.notion.so/Allowed-${PAGE.replaceAll('-', '')}`] } });
    const result = await integrations.searchNotion.execute({ query: 'Allowed', interactionContext: context });
    expect(result).toContain(PAGE);
    expect(result).not.toContain(OTHER);
    await integrations.readNotionPage.execute({ page: PAGE, interactionContext: context });
    expect(read).toHaveBeenCalledWith('fake-token', PAGE);
    read.mockClear();
    await integrations.readNotionPage.execute({ page: `https://www.notion.so/${PAGE}/${OTHER}`, interactionContext: context });
    expect(read).not.toHaveBeenCalled();
    await db.run('UPDATE user_settings SET preferencesJson = @prefs WHERE userId = @userId', {
        userId: USER, prefs: JSON.stringify({ notionAllowlist: ['Allowed'] })
    });
    await integrations.readNotionPage.execute({ page: `https://www.notion.so/Allowed-${OTHER}`, interactionContext: context });
    expect(read).not.toHaveBeenCalled();
    jest.spyOn(settings, 'getPreference').mockRejectedValue(new Error('DB unavailable'));
    await integrations.readNotionPage.execute({ page: PAGE, interactionContext: context });
    expect(read).not.toHaveBeenCalled();
});

test('memory and tool policy applies to private work and fails closed; guilds retain their policy', async () => {
    await settings.updateSection({ userId: USER, section: 'memory', changes: { learnMemories: false, useMemories: false } });
    await settings.updateSection({ userId: USER, section: 'chat', changes: { disabledTools: ['performSearch'] } });
    const personal = await policy.toolPolicy(context);
    expect(personal.webSearch).toBe(false);
    for (const tool of ['rememberFact', 'saveArtifact', 'findImages', 'fetchWebFile', 'lookupNotes', 'showSavedFiles']) {
        expect(personal.allows(tool)).toBe(false);
    }
    const guild = await policy.toolPolicy({ ...context, guildId: '920000000000000001' });
    expect(guild.webSearch).toBe(true);
    expect(guild.allows('rememberFact')).toBe(true);
    expect(policy.privateActor({ ...context, guildId: '920000000000000001' })).toBeNull();
    expect(await policy.memoryAllowed(`dm:${USER}`, 'learnMemories')).toBe(false);
    expect(await policy.memoryAllowed('920000000000000001', 'learnMemories')).toBe(true);
    const facts = require('@goobster/core/services/factsService');
    expect(await facts.addFact({ guildId: `dm:${USER}`, subjectType: 'USER', subjectId: USER, content: 'Should not persist' })).toBeNull();
    const kg = require('@goobster/core/services/knowledgeGraphService');
    const graph = jest.spyOn(kg, 'describeForPrompt');
    const { retrieveNotes } = require('@goobster/core/utils/chat/promptContext');
    expect(await retrieveNotes({ guildId: `dm:${USER}`, userId: USER, query: 'What do you know about my projects?', depth: 'rich' }))
        .toMatchObject({ graph: null, artifacts: [], memories: [] });
    expect(graph).not.toHaveBeenCalled();
    const consolidation = require('@goobster/core/services/memoryConsolidationService');
    const rows = jest.spyOn(db, 'all');
    expect(await consolidation.consolidateGuild(`dm:${USER}`)).toBe(0);
    expect(rows).not.toHaveBeenCalled();
});

test('execution refuses stale disabled calls before invoking an integration', async () => {
    await settings.updateSection({ userId: USER, section: 'chat', changes: { disabledTools: ['readNotionPage'] } });
    const read = jest.spyOn(notion, 'getPageText');
    const registry = require('@goobster/core/utils/toolsRegistry');
    expect(await registry.execute('readNotionPage', { page: PAGE, interactionContext: context })).toContain('disabled');
    expect(read).not.toHaveBeenCalled();
});

test('research snapshots survive preference edits and project runs do not inherit personal models', async () => {
    const svc = require('@goobster/core/services/spitballExpeditionService');
    const { SpitballResearchPipeline } = require('@goobster/core/services/spitballResearchPipeline');
    await settings.updateSection({ userId: USER, section: 'chat', changes: { researchProvider: 'openai', researchModel: 'original-model' } });
    const expedition = await svc.createExpedition({ userId: USER, seed: 'Policy fixtures', autoStart: false });
    await settings.updateSection({ userId: USER, section: 'chat', changes: { researchModel: 'replacement-model' } });
    const saved = await svc.getById(expedition.id);
    expect(saved.modelConfig).toEqual({ provider: 'openai', model: 'original-model' });
    const generateText = jest.fn().mockResolvedValue('ok');
    const pipeline = new SpitballResearchPipeline({ ai: { generateText } });
    await pipeline._generate('test', { modelConfig: saved.modelConfig, usageContext: { userId: USER } });
    expect(generateText).toHaveBeenCalledWith('test', expect.objectContaining({ model: 'original-model' }));
    expect(generateText.mock.calls[0][1]).not.toHaveProperty('modelConfig');
    const shared = await policy.snapshotModel(USER, 'research', { personal: false });
    expect(shared.model).not.toBe('replacement-model');
});

test('starting the event service listens and invalidates bot caches without an SSE subscriber', async () => {
    const vm = require('node:vm');
    let receive;
    const listen = jest.fn((channel, callback) => { receive = callback; return jest.fn(); });
    const clearGuild = jest.fn();
    const clearMeme = jest.fn();
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('@goobster/core/services/eventBusService'), 'utf8'), {
        module, exports: module.exports, console,
        require: name => {
            if (name.startsWith('node:')) return require(name);
            if (name === '../db') return { engine: 'postgres', notificationChannel: x => x, listenNotifications: listen };
            if (name === '../utils/dmScope') return { dmScopeId: id => `dm:${id}` };
            if (name === '../utils/guildSettings') return { clearGuildSettingsCache: clearGuild };
            if (name === '../utils/memeMode') return { clearMemeModeCache: clearMeme };
            return {};
        }
    });
    module.exports.start();
    module.exports.start();
    expect(listen).toHaveBeenCalledTimes(1);
    receive(JSON.stringify({ kind: 'settings-changed', src: 'another-process', payload: { userId: USER } }));
    expect(clearGuild).toHaveBeenCalledWith(`dm:${USER}`);
    expect(clearMeme).toHaveBeenCalledWith(USER);
    await module.exports.close();
});

test('reset never broadens connected-resource restrictions', async () => {
    await settings.updateSection({ userId: USER, section: 'connections', changes: { notionAllowlist: [PAGE], githubAllowlist: ['acme/private'] } });
    const preview = await settings.resetPreview({ userId: USER, section: 'connections' });
    expect(preview.changes).not.toHaveProperty('notionAllowlist');
    expect(preview.changes).not.toHaveProperty('githubAllowlist');
});
