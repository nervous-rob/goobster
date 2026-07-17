/**
 * Unit tests for the panel control service (services/panelService.js):
 * input validation, permission filtering, exact sends, draft-without-post,
 * the single-active-guild music model, and voice/music conflict handling.
 * All Discord and service collaborators are mocked.
 */
const { ChannelType } = require('discord.js');
const { createPanelService, PanelError } = require('../services/panelService');

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

function build({ musicService, sessions = new Set(), aiReply = 'generated draft' } = {}) {
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
        chatText: jest.fn().mockResolvedValue(aiReply)
    };
    const deps = {
        voiceSessionService,
        aiService,
        memoryService: {
            recall: jest.fn().mockResolvedValue([]),
            formatForPrompt: jest.fn(() => null)
        },
        memeMode: { getPromptWithGuildPersonality: jest.fn().mockResolvedValue('You are Goobster.') },
        guildSettings: { getGuildAI: jest.fn().mockResolvedValue({ provider: null, model: null, reasoningEffort: null }) },
        transcriptionService: { isConfigured: () => true },
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
        voiceService: { musicService: ms, tts: {} },
        logger: { warn: () => {}, error: () => {} },
        deps
    });

    return { service, client, ms, deps, textChannel, lockedChannel, voiceChannel };
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
