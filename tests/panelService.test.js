/**
 * Unit tests for the panel control service (services/panelService.js):
 * input validation, permission filtering, exact sends, draft-without-post,
 * the single-active-guild music model, and voice/music conflict handling.
 * All Discord and service collaborators are mocked.
 */
const { ChannelType } = require('discord.js');
const { createPanelService, PanelError } = require('@goobster/core/services/panelService');

const GUILD_A = '200000000000000001';
const GUILD_B = '200000000000000002';
const TEXT_CH = '300000000000000001';
const NOPERM_CH = '300000000000000002';
const VOICE_CH = '300000000000000003';

function makeTextChannel({ id, name, canSend = true, messages = [] }) {
    return {
        id,
        name,
        type: ChannelType.GuildText,
        rawPosition: 0,
        permissionsFor: () => ({ has: () => canSend }),
        send: jest.fn().mockResolvedValue({ id: 'sent-message-id' }),
        messages: {
            fetch: jest.fn().mockResolvedValue(new Map(messages.map((m, i) => [String(i), m])))
        }
    };
}

function makeVoiceChannel({ id, name, canSpeak = true }) {
    return {
        id,
        name,
        type: ChannelType.GuildVoice,
        rawPosition: 0,
        members: new Map(),
        permissionsFor: () => ({ has: () => canSpeak })
    };
}

function makeGuild({ id, name, channels = [] }) {
    return {
        id,
        name,
        memberCount: 5,
        iconURL: () => null,
        channels: { cache: new Map(channels.map(c => [c.id, c])) },
        members: { me: { id: 'bot-id' } }
    };
}

function makeClient(guilds) {
    return {
        isReady: () => true,
        user: { id: 'bot-id', tag: 'Goobster#0001' },
        ws: { ping: 42 },
        readyTimestamp: Date.now() - 60000,
        guilds: { cache: new Map(guilds.map(g => [g.id, g])) }
    };
}

function makeMusicService(overrides = {}) {
    return {
        connection: null,
        guildId: null,
        isPlaying: false,
        getState: jest.fn(() => ({ isPlaying: false, currentTrack: null, volume: 1, isPaused: false })),
        getQueue: jest.fn(() => []),
        getVolume: jest.fn(() => 100),
        addToQueue: jest.fn().mockResolvedValue(true),
        joinChannel: jest.fn().mockResolvedValue({}),
        playAudio: jest.fn().mockResolvedValue(undefined),
        playPlaylist: jest.fn().mockResolvedValue({ totalTracks: 3, currentTrack: { name: 'A - B.mp3' } }),
        playAllTracks: jest.fn().mockResolvedValue({ totalTracks: 3, currentTrack: { name: 'A - B.mp3' } }),
        shuffleAllTracks: jest.fn().mockResolvedValue({ totalTracks: 3, currentTrack: { name: 'A - B.mp3' } }),
        listPlaylists: jest.fn().mockResolvedValue(['chill']),
        pause: jest.fn().mockResolvedValue(true),
        resume: jest.fn().mockResolvedValue(true),
        skip: jest.fn().mockResolvedValue(true),
        stop: jest.fn().mockResolvedValue(true),
        setVolume: jest.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function build({ musicService, sessions = new Set(), aiReply = 'generated draft', sttConfigured = true, tts = {} } = {}) {
    const textChannel = makeTextChannel({ id: TEXT_CH, name: 'general' });
    const lockedChannel = makeTextChannel({ id: NOPERM_CH, name: 'secret', canSend: false });
    const voiceChannel = makeVoiceChannel({ id: VOICE_CH, name: 'Lounge' });
    const guildA = makeGuild({ id: GUILD_A, name: 'Alpha', channels: [textChannel, lockedChannel, voiceChannel] });
    const guildB = makeGuild({ id: GUILD_B, name: 'Beta' });
    const client = makeClient([guildA, guildB]);

    const ms = musicService || makeMusicService();
    const voiceSessionService = {
        hasSession: jest.fn(id => sessions.has(id)),
        getSession: jest.fn(() => null),
        startSession: jest.fn().mockResolvedValue({ mode: 'polite' }),
        stopSession: jest.fn(() => true)
    };
    const aiService = {
        getProvider: () => 'openai',
        getDefaultModel: () => 'gpt-5.4-mini',
        validateModelSelection: jest.fn((_current, patch) => patch),
        getThoughtfulPreset: (providerKey) => {
            const key = providerKey || 'openai';
            const models = { openai: 'gpt-5.5', anthropic: 'claude-thoughtful', gemini: 'gemini-thoughtful' };
            return models[key] ? { provider: key, model: models[key], reasoningEffort: 'high' } : null;
        },
        listProviders: jest.fn(() => [
            { key: 'openai', name: 'OpenAI', configured: true, isDefault: true, chatModel: 'gpt-5.4-mini', thoughtfulModel: 'gpt-5.5', reasoningEffort: true },
            { key: 'anthropic', name: 'Anthropic Claude', configured: true, isDefault: false, chatModel: 'claude-fast', thoughtfulModel: 'claude-thoughtful', reasoningEffort: true },
            { key: 'gemini', name: 'Google Gemini', configured: false, isDefault: false, chatModel: 'gemini-fast', thoughtfulModel: 'gemini-thoughtful', reasoningEffort: true },
            { key: 'ollama', name: 'Ollama (local)', configured: true, isDefault: false, chatModel: 'llama', thoughtfulModel: null, reasoningEffort: false }
        ]),
        describeModel: jest.fn((provider, model, effort) => ({ supported: true, effectiveEffort: effort || 'medium' })),
        listModelCatalog: jest.fn(async (provider) => ({
            version: 1,
            provider,
            workflow: 'chat',
            discovery: { status: 'live', checkedAt: '2026-09-29 00:00:00' },
            unregisteredCount: 0,
            models: [
                {
                    id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', description: 'Fast default', status: 'current',
                    availability: 'listed', selectable: true, reasoning: { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
                    capabilities: { tools: 'native' }, sampling: {}, aliases: []
                },
                {
                    id: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Thoughtful tier', status: 'current',
                    availability: 'not-listed', selectable: false, reasoning: { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
                    capabilities: { tools: 'native' }, sampling: {}, aliases: []
                }
            ]
        })),
        chatText: jest.fn().mockResolvedValue(aiReply)
    };
    const guildSettingsState = {
        ai: { provider: null, model: null, reasoningEffort: null },
        personalityDirective: null,
        proactiveMode: 'DISABLED',
        monologueMode: 'DISABLED',
        dynamicResponse: 'DISABLED',
        replyDetection: 'ENABLED',
        threadPreference: 'ALWAYS_CHANNEL',
        searchApproval: 'REQUIRED',
        botNickname: null,
        memoryRetentionDays: null,
        ttsVoice: { voiceId: null, voiceName: null, speed: null, accent: null }
    };
    // Memory, facts, follow-ups and activity are async through the DB
    // facade - the mocks must resolve, never return, so a service that
    // forgets to await fails here the way it would on Postgres.
    const deps = {
        voiceSessionService,
        aiService,
        memoryService: {
            recall: jest.fn().mockResolvedValue([]),
            formatForPrompt: jest.fn(() => null),
            getExcludedChannels: jest.fn(async () => []),
            getStats: jest.fn(async () => ({ enabled: true, count: 12, backend: 'test', model: 'test' })),
            excludeChannel: jest.fn(async () => 3),
            includeChannel: jest.fn(async () => 1),
            forgetGuild: jest.fn(async () => 12),
            applyRetention: jest.fn(async () => 2)
        },
        memeMode: { getPromptWithGuildPersonality: jest.fn().mockResolvedValue('You are Goobster.') },
        guildSettings: {
            getGuildAI: jest.fn(async () => ({ ...guildSettingsState.ai })),
            setGuildAI: jest.fn(async (guildId, updates) => {
                Object.assign(guildSettingsState.ai, updates);
                return { ...guildSettingsState.ai };
            }),
            getPersonalityDirective: jest.fn(async () => guildSettingsState.personalityDirective),
            setPersonalityDirective: jest.fn(async (guildId, value) => { guildSettingsState.personalityDirective = value; }),
            getProactiveMode: jest.fn(async () => guildSettingsState.proactiveMode),
            setProactiveMode: jest.fn(async (guildId, value) => { guildSettingsState.proactiveMode = value; }),
            getMonologueMode: jest.fn(async () => guildSettingsState.monologueMode),
            setMonologueMode: jest.fn(async (guildId, value) => { guildSettingsState.monologueMode = value; }),
            getDynamicResponse: jest.fn(async () => guildSettingsState.dynamicResponse),
            setDynamicResponse: jest.fn(async (guildId, value) => { guildSettingsState.dynamicResponse = value; }),
            getReplyDetection: jest.fn(async () => guildSettingsState.replyDetection),
            setReplyDetection: jest.fn(async (guildId, value) => { guildSettingsState.replyDetection = value; }),
            getThreadPreference: jest.fn(async () => guildSettingsState.threadPreference),
            setThreadPreference: jest.fn(async (guildId, value) => { guildSettingsState.threadPreference = value; }),
            getSearchApproval: jest.fn(async () => guildSettingsState.searchApproval),
            setSearchApproval: jest.fn(async (guildId, value) => { guildSettingsState.searchApproval = value; }),
            getBotNickname: jest.fn(async () => guildSettingsState.botNickname),
            setBotNickname: jest.fn(async (guildId, value) => { guildSettingsState.botNickname = value; }),
            getMemoryRetentionDays: jest.fn(async () => guildSettingsState.memoryRetentionDays),
            setMemoryRetentionDays: jest.fn(async (guildId, days) => {
                guildSettingsState.memoryRetentionDays = days && days > 0 ? days : null;
                return guildSettingsState.memoryRetentionDays;
            }),
            getTtsVoice: jest.fn(async () => ({ ...guildSettingsState.ttsVoice })),
            setTtsVoice: jest.fn(async (guildId, voice) => {
                Object.assign(guildSettingsState.ttsVoice, voice);
                return { ...guildSettingsState.ttsVoice };
            })
        },
        factsService: { getStats: jest.fn(async () => ({ userFacts: 4, guildFacts: 2 })) },
        followupService: { getPending: jest.fn(async () => [{ id: 1 }]) },
        activityService: { purgeChannel: jest.fn(async () => 5) },
        transcriptionService: { isConfigured: () => sttConfigured },
        db: { engine: 'sqlite', get: jest.fn(async () => ({ count: 7 })), getDb: () => ({ pragma: () => 4096 }) },
        dataDir: require('node:os').tmpdir(),
        spotdlService: {
            listTracks: jest.fn().mockResolvedValue([
                { name: 'Daft Punk - Around the World.mp3', url: '/music/a.mp3', lastModified: new Date() },
                { name: 'Queen - Bohemian Rhapsody.mp3', url: '/music/b.mp3', lastModified: new Date() }
            ]),
            getTrackUrl: jest.fn().mockResolvedValue('/music/a.mp3')
        }
    };

    const service = createPanelService({
        client,
        voiceService: { musicService: ms, tts },
        logger: { warn: () => {}, error: () => {} },
        deps
    });

    return { service, client, ms, deps, textChannel, lockedChannel, voiceChannel, guildSettingsState };
}

async function expectPanelError(promise, status, code) {
    let caught = null;
    try {
        await promise;
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(PanelError);
    expect(caught.status).toBe(status);
    expect(caught.code).toBe(code);
    return caught;
}

describe('panelService boundary validation', () => {
    test('rejects malformed guild ids', () => {
        const { service } = build();
        expect(() => service.listChannels('not-a-snowflake')).toThrow(PanelError);
        expect(() => service.listChannels("1; DROP TABLE users")).toThrow(PanelError);
    });

    test('404s for guilds the bot is not in', () => {
        const { service } = build();
        expect(() => service.listChannels('999999999999999999')).toThrow(
            expect.objectContaining({ status: 404, code: 'GUILD_NOT_FOUND' })
        );
    });

    test('rejects empty and oversized message content', async () => {
        const { service } = build();
        await expectPanelError(
            service.sendMessage({ guildId: GUILD_A, channelId: TEXT_CH, content: '   ' }),
            400, 'BAD_REQUEST'
        );
        await expectPanelError(
            service.sendMessage({ guildId: GUILD_A, channelId: TEXT_CH, content: 'x'.repeat(2001) }),
            400, 'BAD_REQUEST'
        );
    });
});

describe('panelService guild and channel listing', () => {
    test('lists guilds with activity flags', () => {
        const ms = makeMusicService({ connection: {}, guildId: GUILD_A });
        const { service } = build({ musicService: ms, sessions: new Set([GUILD_B]) });
        const guilds = service.listGuilds();
        expect(guilds.map(g => g.name)).toEqual(['Alpha', 'Beta']);
        expect(guilds.find(g => g.id === GUILD_A).musicActive).toBe(true);
        expect(guilds.find(g => g.id === GUILD_B).voiceChatActive).toBe(true);
        expect(guilds.find(g => g.id === GUILD_B).musicActive).toBe(false);
    });

    test('filters out channels the bot lacks permissions for', () => {
        const { service } = build();
        const { text, voice } = service.listChannels(GUILD_A);
        expect(text.map(c => c.id)).toEqual([TEXT_CH]);
        expect(voice.map(c => c.id)).toEqual([VOICE_CH]);
    });
});

describe('panelService exact message sends', () => {
    test('sends exact content to a permitted channel', async () => {
        const { service, textChannel } = build();
        const result = await service.sendMessage({ guildId: GUILD_A, channelId: TEXT_CH, content: 'Hello world' });
        expect(result.messageId).toBe('sent-message-id');
        expect(textChannel.send).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'Hello world' })
        );
    });

    test('refuses channels without SendMessages', async () => {
        const { service, lockedChannel } = build();
        await expectPanelError(
            service.sendMessage({ guildId: GUILD_A, channelId: NOPERM_CH, content: 'hi' }),
            403, 'MISSING_PERMISSIONS'
        );
        expect(lockedChannel.send).not.toHaveBeenCalled();
    });
});

describe('panelService AI drafts', () => {
    test('returns a draft without posting anything', async () => {
        const { service, textChannel, deps } = build();
        const { draft } = await service.draftMessage({
            guildId: GUILD_A, channelId: TEXT_CH, instruction: 'hype up movie night'
        });
        expect(draft).toBe('generated draft');
        expect(textChannel.send).not.toHaveBeenCalled();
        expect(deps.aiService.chatText).toHaveBeenCalledTimes(1);

        const [messages, options] = deps.aiService.chatText.mock.calls[0];
        expect(messages[0].role).toBe('system');
        expect(messages[messages.length - 1].content).toContain('hype up movie night');
        expect(options.usageContext).toEqual({ guildId: GUILD_A, userId: null });
    });

    test('applies per-guild AI overrides to draft generation', async () => {
        const { service, deps } = build();
        deps.guildSettings.getGuildAI.mockResolvedValue({ provider: 'gemini', model: 'gemini-3.5-flash', reasoningEffort: null });
        await service.draftMessage({ guildId: GUILD_A, channelId: TEXT_CH, instruction: 'say hi' });
        const [, options] = deps.aiService.chatText.mock.calls[0];
        expect(options.provider).toBe('gemini');
        expect(options.model).toBe('gemini-3.5-flash');
    });

    test('surfaces empty AI output as a draft failure', async () => {
        const { service } = build({ aiReply: '   ' });
        await expectPanelError(
            service.draftMessage({ guildId: GUILD_A, channelId: TEXT_CH, instruction: 'say hi' }),
            502, 'DRAFT_FAILED'
        );
    });
});

describe('panelService music single-active-guild model', () => {
    test('moving music to another guild requires confirmation', async () => {
        const ms = makeMusicService({ connection: {}, guildId: GUILD_B, isPlaying: true });
        const { service } = build({ musicService: ms });
        const error = await expectPanelError(
            service.playTrack({ guildId: GUILD_A, channelId: VOICE_CH, query: 'daft punk' }),
            409, 'MUSIC_ACTIVE_ELSEWHERE'
        );
        expect(error.details.requiresConfirmation).toBe(true);
        expect(error.details.activeGuildId).toBe(GUILD_B);
        expect(ms.joinChannel).not.toHaveBeenCalled();
    });

    test('confirmed move joins the new guild and plays', async () => {
        const ms = makeMusicService({ connection: {}, guildId: GUILD_B, isPlaying: true });
        const { service, voiceChannel } = build({ musicService: ms });
        const result = await service.playTrack({
            guildId: GUILD_A, channelId: VOICE_CH, query: 'daft punk', confirmMove: true
        });
        expect(ms.joinChannel).toHaveBeenCalledWith(voiceChannel);
        expect(ms.playAudio).toHaveBeenCalled();
        expect(result.queued).toBe(false);
        expect(result.track.artist).toBe('Daft Punk');
    });

    test('queues instead of restarting when already playing in the same guild', async () => {
        const ms = makeMusicService({ connection: {}, guildId: GUILD_A, isPlaying: true });
        const { service } = build({ musicService: ms });
        const result = await service.playTrack({ guildId: GUILD_A, channelId: VOICE_CH, query: 'queen' });
        expect(result.queued).toBe(true);
        expect(ms.addToQueue).toHaveBeenCalled();
        expect(ms.joinChannel).not.toHaveBeenCalled();
    });

    test('unknown track search returns 404', async () => {
        const { service } = build();
        await expectPanelError(
            service.playTrack({ guildId: GUILD_A, channelId: VOICE_CH, query: 'zzz-no-such-track' }),
            404, 'TRACK_NOT_FOUND'
        );
    });
});

describe('panelService voice/music conflicts', () => {
    test('music is blocked while a voice conversation is live in the guild', async () => {
        const { service } = build({ sessions: new Set([GUILD_A]) });
        await expectPanelError(
            service.playTrack({ guildId: GUILD_A, channelId: VOICE_CH, query: 'queen' }),
            409, 'VOICECHAT_ACTIVE'
        );
    });

    test('starting voice chat over active music requires confirmation, then stops music', async () => {
        const ms = makeMusicService({ connection: { destroy: jest.fn() }, guildId: GUILD_A, isPlaying: true });
        const { service, deps } = build({ musicService: ms });

        const error = await expectPanelError(
            service.startVoiceChat({ guildId: GUILD_A, voiceChannelId: VOICE_CH }),
            409, 'MUSIC_ACTIVE'
        );
        expect(error.details.requiresConfirmation).toBe(true);
        expect(deps.voiceSessionService.startSession).not.toHaveBeenCalled();

        const result = await service.startVoiceChat({ guildId: GUILD_A, voiceChannelId: VOICE_CH, confirm: true });
        expect(ms.stop).toHaveBeenCalled();
        expect(deps.voiceSessionService.startSession).toHaveBeenCalledWith(
            expect.objectContaining({ mode: 'polite' })
        );
        expect(result.active).toBe(true);
    });

    test('rejects invalid voice modes and duplicate sessions', async () => {
        const { service } = build({ sessions: new Set([GUILD_A]) });
        await expectPanelError(
            service.startVoiceChat({ guildId: GUILD_A, voiceChannelId: VOICE_CH, mode: 'loud' }),
            400, 'BAD_REQUEST'
        );
        await expectPanelError(
            service.startVoiceChat({ guildId: GUILD_A, voiceChannelId: VOICE_CH }),
            409, 'SESSION_EXISTS'
        );
    });
});

describe('panelService guild settings', () => {
    test('aggregates every per-guild setting with context', async () => {
        const { service, guildSettingsState } = build();
        guildSettingsState.personalityDirective = 'Be extra dramatic';
        guildSettingsState.proactiveMode = 'ENABLED';
        guildSettingsState.memoryRetentionDays = 90;

        const settings = await service.getGuildSettings(GUILD_A);
        expect(settings.personalityDirective).toBe('Be extra dramatic');
        expect(settings.proactiveMode).toBe(true);
        expect(settings.monologueMode).toBe(false);
        expect(settings.dynamicResponse).toBe(false);
        expect(settings.replyDetection).toBe(true);
        expect(settings.searchApproval).toBe(true);
        expect(settings.threadPreference).toBe('ALWAYS_CHANNEL');
        expect(settings.memory.retentionDays).toBe(90);
        expect(settings.memory.stats.count).toBe(12);
        expect(settings.memory.facts).toEqual({ userFacts: 4, guildFacts: 2 });
        expect(settings.memory.pendingFollowups).toBe(1);
        expect(settings.ai.thoughtful).toBe(false);
        expect(settings.ai.defaults.model).toBe('gpt-5.4-mini');
        expect(settings.global.ttsAvailable).toBe(true);
    });

    test('reports thoughtful mode when the preset matches', async () => {
        const { service, guildSettingsState } = build();
        guildSettingsState.ai = { provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' };
        const settings = await service.getGuildSettings(GUILD_A);
        expect(settings.ai.thoughtful).toBe(true);
    });

    test('applies partial updates and rejects unknown-only patches', async () => {
        const { service, deps, guildSettingsState } = build();
        const applied = await service.updateGuildSettings(GUILD_A, {
            proactiveMode: true,
            monologueMode: true,
            replyDetection: false,
            threadPreference: 'ALWAYS_THREAD',
            personalityDirective: 'Talk like a pirate'
        });
        expect(applied.proactiveMode).toBe(true);
        expect(applied.replyDetection).toBe(false);
        expect(guildSettingsState.replyDetection).toBe('DISABLED');
        expect(guildSettingsState.proactiveMode).toBe('ENABLED');
        expect(applied.monologueMode).toBe(true);
        expect(guildSettingsState.monologueMode).toBe('ENABLED');
        expect(guildSettingsState.threadPreference).toBe('ALWAYS_THREAD');
        expect(guildSettingsState.personalityDirective).toBe('Talk like a pirate');
        expect(deps.guildSettings.setDynamicResponse).not.toHaveBeenCalled();

        await expectPanelError(
            service.updateGuildSettings(GUILD_A, { bogusSetting: 1 }),
            400, 'BAD_REQUEST'
        );
    });

    test('validates enum and range inputs', async () => {
        const { service } = build();
        await expectPanelError(service.updateGuildSettings(GUILD_A, { aiProvider: 'skynet' }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { aiReasoningEffort: 'extreme' }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { threadPreference: 'SOMETIMES' }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { proactiveMode: 'yes' }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { monologueMode: 'yes' }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { replyDetection: 'yes' }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { memoryRetentionDays: 9999 }), 400, 'BAD_REQUEST');
        await expectPanelError(service.updateGuildSettings(GUILD_A, { botNickname: 'x'.repeat(33) }), 400, 'BAD_REQUEST');
    });

    test('thoughtful mode toggle sets and clears the AI preset', async () => {
        const { service, guildSettingsState } = build();
        await service.updateGuildSettings(GUILD_A, { thoughtfulMode: true });
        expect(guildSettingsState.ai).toEqual({ provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' });
        await service.updateGuildSettings(GUILD_A, { thoughtfulMode: false });
        expect(guildSettingsState.ai).toEqual({ provider: null, model: null, reasoningEffort: null });
    });

    test('thoughtful mode follows the guild provider override', async () => {
        const { service, guildSettingsState } = build();
        guildSettingsState.ai = { provider: 'anthropic', model: null, reasoningEffort: null };
        await service.updateGuildSettings(GUILD_A, { thoughtfulMode: true });
        expect(guildSettingsState.ai).toEqual({ provider: 'anthropic', model: 'claude-thoughtful', reasoningEffort: 'high' });

        const settings = await service.getGuildSettings(GUILD_A);
        expect(settings.ai.thoughtful).toBe(true);
        expect(settings.ai.defaults.thoughtfulModel).toBe('claude-thoughtful');
    });

    test('setting retention purges immediately; zero clears it', async () => {
        const { service, deps } = build();
        const applied = await service.updateGuildSettings(GUILD_A, { memoryRetentionDays: 30 });
        expect(applied.memoryRetentionDays).toBe(30);
        expect(applied.memoriesPurged).toBe(2);
        expect(deps.memoryService.applyRetention).toHaveBeenCalledWith(GUILD_A);

        const cleared = await service.updateGuildSettings(GUILD_A, { memoryRetentionDays: 0 });
        expect(cleared.memoryRetentionDays).toBeNull();
        expect(cleared.memoriesPurged).toBe(0);
    });

    test('channel exclusion purges memories and activity; inclusion restores', async () => {
        const { service, deps } = build();
        const excluded = await service.setChannelExclusion(GUILD_A, TEXT_CH, true);
        expect(excluded).toEqual({ excluded: true, removedMemories: 3, purgedActivity: 5 });
        expect(deps.activityService.purgeChannel).toHaveBeenCalledWith(GUILD_A, TEXT_CH);

        const included = await service.setChannelExclusion(GUILD_A, TEXT_CH, false);
        expect(included).toEqual({ excluded: false, changed: 1 });

        await expectPanelError(service.setChannelExclusion(GUILD_A, VOICE_CH, true), 404, 'CHANNEL_NOT_FOUND');
    });

    test('forget-all deletes guild memories', async () => {
        const { service, deps } = build();
        await expect(service.forgetGuildMemories(GUILD_A)).resolves.toEqual({ removed: 12 });
        expect(deps.memoryService.forgetGuild).toHaveBeenCalledWith(GUILD_A);
    });

    test('exposes the provider catalog and the effective model for the pickers', async () => {
        const { service, guildSettingsState } = build();
        guildSettingsState.ai = { provider: 'anthropic', model: null, reasoningEffort: 'low' };
        const settings = await service.getGuildSettings(GUILD_A);
        expect(settings.ai.providers.map(p => p.key)).toEqual(['openai', 'anthropic', 'gemini', 'ollama']);
        expect(settings.ai.providers.find(p => p.key === 'gemini').configured).toBe(false);
        expect(settings.ai.effective).toEqual({
            provider: 'anthropic',
            providerName: 'Anthropic Claude',
            model: 'claude-fast',
            modelSupported: true,
            reasoningEffort: 'low'
        });
        expect(settings.ai.thoughtfulAvailable).toBe(true);
    });

    test('a selection the model registry refuses is a 400 with its code, not a 500', async () => {
        const { service, deps } = build();
        deps.aiService.validateModelSelection.mockImplementation(() => {
            const error = new Error('Google Gemini is not configured on this host.');
            error.name = 'ModelPolicyError';
            error.code = 'PROVIDER_NOT_CONFIGURED';
            throw error;
        });
        const error = await expectPanelError(
            service.updateGuildSettings(GUILD_A, { aiProvider: 'gemini' }),
            400, 'PROVIDER_NOT_CONFIGURED'
        );
        expect(error.message).toContain('not configured');
        expect(deps.guildSettings.setGuildAI).not.toHaveBeenCalled();
    });

    test('per-server TTS voice resolves against the library, stores the id, and clears', async () => {
        const tts = {
            voiceId: 'globalVoiceId0000000',
            voiceName: 'Sarah',
            resolveVoice: jest.fn(async (query) => {
                if (query.toLowerCase() !== 'serena') throw new Error(`ElevenLabs voice "${query}" not found in your voice library`);
                return { id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena' };
            })
        };
        const { service, deps, guildSettingsState } = build({ tts });

        const applied = await service.updateGuildSettings(GUILD_A, { ttsVoice: 'serena' });
        expect(applied.ttsVoice).toEqual({ voiceId: 'pMsXgVXv3BLzUgSXRplE', voiceName: 'Serena' });
        expect(deps.guildSettings.setTtsVoice).toHaveBeenCalledWith(GUILD_A, { voiceId: 'pMsXgVXv3BLzUgSXRplE', voiceName: 'Serena' });

        const settings = await service.getGuildSettings(GUILD_A);
        expect(settings.voice).toEqual({ voiceId: 'pMsXgVXv3BLzUgSXRplE', voiceName: 'Serena' });
        expect(settings.global.ttsVoiceName).toBe('Sarah');

        await expectPanelError(service.updateGuildSettings(GUILD_A, { ttsVoice: 'nobody' }), 400, 'VOICE_NOT_FOUND');
        expect(guildSettingsState.ttsVoice.voiceId).toBe('pMsXgVXv3BLzUgSXRplE');

        const cleared = await service.updateGuildSettings(GUILD_A, { ttsVoice: null });
        expect(cleared.ttsVoice).toEqual({ voiceId: null, voiceName: null });
        expect(guildSettingsState.ttsVoice.voiceId).toBeNull();
    });

    test('per-server TTS voice needs ElevenLabs', async () => {
        const { service } = build({ tts: null });
        await expectPanelError(service.updateGuildSettings(GUILD_A, { ttsVoice: 'serena' }), 503, 'TTS_UNAVAILABLE');
    });
});

describe('panelService model catalog', () => {
    test('trims registry models to what the picker renders and marks the default', async () => {
        const { service, deps } = build();
        const catalog = await service.listModelCatalog('openai');
        expect(deps.aiService.listModelCatalog).toHaveBeenCalledWith('openai');
        expect(catalog.provider).toBe('openai');
        expect(catalog.providerName).toBe('OpenAI');
        expect(catalog.defaultModel).toBe('gpt-5.4-mini');
        expect(catalog.discovery.status).toBe('live');
        expect(catalog.models).toEqual([
            expect.objectContaining({
                id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', isDefault: true, selectable: true,
                availability: 'listed', reasoning: { levels: ['minimal', 'low', 'medium', 'high'], default: 'medium' }
            }),
            expect.objectContaining({ id: 'gpt-5.5', isDefault: false, selectable: false, availability: 'not-listed' })
        ]);
        // Registry internals do not leak to the client
        expect(catalog.models[0].capabilities).toBeUndefined();
    });

    test('defaults to the effective provider and rejects unknown ones', async () => {
        const { service, deps } = build();
        await service.listModelCatalog(undefined);
        expect(deps.aiService.listModelCatalog).toHaveBeenCalledWith('openai');
        await expectPanelError(service.listModelCatalog('skynet'), 400, 'BAD_REQUEST');
    });

    test('a discovery failure is a 502, not a crash', async () => {
        const { service, deps } = build();
        deps.aiService.listModelCatalog.mockRejectedValue(new Error('boom'));
        await expectPanelError(service.listModelCatalog('openai'), 502, 'CATALOG_FAILED');
    });
});

describe('panelService status and host health', () => {
    test('reports per-engine voice capability', () => {
        const withStt = build({ sttConfigured: true }).service.getStatus();
        expect(withStt.capabilities.voiceEngines).toEqual({ realtime: true, classic: true });
        expect(withStt.model).toBe('gpt-5.4-mini');

        const noStt = build({ sttConfigured: false }).service.getStatus();
        expect(noStt.capabilities.voiceEngines).toEqual({ realtime: true, classic: false });

        const noTts = build({ tts: null }).service.getStatus();
        expect(noTts.capabilities.tts).toBe(false);
        expect(noTts.capabilities.voiceEngines).toEqual({ realtime: false, classic: false });
    });

    test('the realtime engine starts without OpenAI STT; classic needs it', async () => {
        const { service, deps } = build({ sttConfigured: false });
        const started = await service.startVoiceChat({ guildId: GUILD_A, voiceChannelId: VOICE_CH, engine: 'realtime' });
        expect(started.active).toBe(true);
        expect(deps.voiceSessionService.startSession).toHaveBeenCalledWith(expect.objectContaining({ engine: 'realtime' }));
        await expectPanelError(
            service.startVoiceChat({ guildId: GUILD_B, voiceChannelId: VOICE_CH, engine: 'classic' }),
            503, 'STT_UNAVAILABLE'
        );
        await expectPanelError(
            service.startVoiceChat({ guildId: GUILD_B, voiceChannelId: VOICE_CH, engine: 'turbo' }),
            400, 'BAD_REQUEST'
        );
    });

    test('host health snapshot carries the sections the Overview renders', async () => {
        const { service } = build();
        const health = await service.getSystemHealth();
        expect(health.os).toEqual(expect.objectContaining({ type: expect.any(String), uptimeSeconds: expect.any(Number) }));
        expect(health.cpu.load).toHaveLength(3);
        expect(health.cpu.cores).toBeGreaterThan(0);
        expect(health.memory.totalBytes).toBeGreaterThan(health.memory.usedBytes);
        expect(health.database).toEqual({ engine: 'sqlite', bytes: 4096 * 4096, messageCount: 7 });
        expect(health.disk).toEqual(expect.objectContaining({ totalBytes: expect.any(Number), freeBytes: expect.any(Number) }));
        expect(health.process.nodeVersion).toBe(process.version);
    });
});

describe('panelService global TTS voice', () => {
    const os = require('node:os');
    const fsSync = require('node:fs');
    const pathMod = require('node:path');

    function buildVoicePanel({ configPath }) {
        const textChannel = makeTextChannel({ id: TEXT_CH, name: 'general' });
        const guild = makeGuild({ id: GUILD_A, name: 'Alpha', channels: [textChannel] });
        // Mirrors the real TTS service contract: resolveVoice validates
        // against the account's voice library and returns { id, name }.
        const library = [
            { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah - Mature, Reassuring, Confident', category: 'premade' },
            { id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena', category: 'premade' }
        ];
        const tts = {
            voiceId: 'Rachel',
            voiceName: null,
            listVoices: jest.fn(async () => library),
            resolveVoice: jest.fn(async (query) => {
                const q = String(query).toLowerCase();
                const match = library.find(v =>
                    v.name.toLowerCase() === q || v.name.toLowerCase().split(/\s+-\s+/)[0] === q);
                if (!match) throw new Error(`ElevenLabs voice "${query}" not found in your voice library`);
                return { id: match.id, name: match.name };
            })
        };
        const service = createPanelService({
            client: makeClient([guild]),
            voiceService: { musicService: makeMusicService(), tts, config: { elevenlabs: { voiceId: 'Rachel' } } },
            logger: { warn: () => {}, error: () => {} },
            deps: {
                configPath,
                voiceSessionService: { hasSession: () => false, getSession: () => null },
                aiService: { getProvider: () => 'openai', getDefaultModel: () => 'm', getThoughtfulPreset: () => null },
                memoryService: {}, memeMode: {}, guildSettings: {},
                factsService: {}, followupService: {}, activityService: {},
                transcriptionService: { isConfigured: () => true },
                spotdlService: { listTracks: async () => [] }
            }
        });
        return { service, tts };
    }

    test('resolves the voice against the library and persists the resolved ID', async () => {
        const configPath = pathMod.join(os.tmpdir(), `goobster-panel-voice-${process.pid}.json`);
        fsSync.writeFileSync(configPath, JSON.stringify({ token: 'x' }));
        try {
            const { service, tts } = buildVoicePanel({ configPath });

            await expectPanelError(service.setTtsVoice('bad;voice$id'), 400, 'BAD_REQUEST');

            // A voice that isn't in the library is rejected up front,
            // and nothing is persisted or applied.
            await expectPanelError(service.setTtsVoice('Rachel'), 400, 'VOICE_NOT_FOUND');
            expect(tts.voiceId).toBe('Rachel'); // unchanged
            expect(JSON.parse(fsSync.readFileSync(configPath, 'utf-8')).elevenlabs).toBeUndefined();

            // Full display names (as chosen from the panel's voice picker,
            // punctuation included) pass validation and resolve exactly
            const picked = await service.setTtsVoice('Sarah - Mature, Reassuring, Confident');
            expect(picked.voiceId).toBe('EXAVITQu4vr4xnSDxMaL');

            // Base-name matching: "sarah" resolves to the full display name
            const result = await service.setTtsVoice('sarah');
            expect(result).toEqual({
                voiceId: 'EXAVITQu4vr4xnSDxMaL',
                voiceName: 'Sarah - Mature, Reassuring, Confident'
            });
            expect(tts.voiceId).toBe('EXAVITQu4vr4xnSDxMaL');
            expect(tts.voiceName).toBe('Sarah - Mature, Reassuring, Confident');

            const written = JSON.parse(fsSync.readFileSync(configPath, 'utf-8'));
            expect(written.elevenlabs.voiceId).toBe('EXAVITQu4vr4xnSDxMaL');
            expect(written.elevenlabs.voiceName).toBe('Sarah - Mature, Reassuring, Confident');
        } finally {
            fsSync.unlinkSync(configPath);
        }
    });

    test('lists the voice library for the picker', async () => {
        const configPath = pathMod.join(os.tmpdir(), `goobster-panel-voices-${process.pid}.json`);
        fsSync.writeFileSync(configPath, JSON.stringify({ token: 'x' }));
        try {
            const { service } = buildVoicePanel({ configPath });
            const voices = await service.listTtsVoices();
            expect(voices).toHaveLength(2);
            expect(voices[0].name).toContain('Sarah');
        } finally {
            fsSync.unlinkSync(configPath);
        }
    });
});

describe('panelService transport and volume', () => {
    test('rejects unknown transport actions', async () => {
        const { service } = build();
        await expectPanelError(service.controlMusic('explode'), 400, 'BAD_REQUEST');
    });

    test('validates the volume range', async () => {
        const { service, ms } = build();
        await expectPanelError(service.setVolume(150), 400, 'BAD_REQUEST');
        await expectPanelError(service.setVolume('50'), 400, 'BAD_REQUEST');
        await service.setVolume(35);
        expect(ms.setVolume).toHaveBeenCalledWith(35);
    });
});
