/**
 * Voice tool calling (services/voice/voiceSessionService.js): a spoken turn
 * runs the same aiService.chat + toolsRegistry loop as text chat, so users
 * can trigger web searches and other server functions from a voice channel.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-voice-tools-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));

jest.mock('../services/perplexityService', () => ({
    isConfigured: jest.fn().mockReturnValue(true),
    search: jest.fn().mockResolvedValue('Sunny, 24 degrees in Tokyo today.')
}));

jest.mock('../utils/memeMode', () => ({
    getPromptWithGuildPersonality: jest.fn().mockResolvedValue('You are Goobster.')
}));

// Notification cues play real PCM through an audio player; stub them out
// and assert on invocation instead.
jest.mock('../services/voice/notificationSounds', () => ({
    playResponseCue: jest.fn().mockResolvedValue(true),
    playToolCue: jest.fn().mockResolvedValue(true)
}));

// These wrapped commands hard-require the gitignored config.json at load
// time; the voice loop only needs their tool definitions to exist.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

const aiService = require('../services/aiService');
const perplexityService = require('../services/perplexityService');
const { playResponseCue, playToolCue } = require('../services/voice/notificationSounds');
const toolsRegistry = require('../utils/toolsRegistry');
const voiceSessionService = require('../services/voice/voiceSessionService');
const db = require('../db');

const GUILD_ID = '500000000000000001';
const USER_ID = '500000000000000002';

function makeMember() {
    return {
        user: { id: USER_ID, username: 'rob', bot: false },
        displayName: 'Rob'
    };
}

function makeSession({ textChannel = { id: '500000000000000003', send: jest.fn().mockResolvedValue(undefined) } } = {}) {
    return {
        guildId: GUILD_ID,
        voiceChannel: { name: 'General', guild: { id: GUILD_ID } },
        textChannel,
        connection: {},
        ttsService: { textToSpeech: jest.fn().mockResolvedValue(undefined) },
        client: { user: { id: 'bot', username: 'Goobster' } },
        mode: 'open',
        lastBotSpokeAt: 0,
        botNames: ['goobster'],
        history: [],
        turnBuffer: [{
            speakerName: 'Rob',
            text: 'Hey Goobster, search the web for the weather in Tokyo',
            at: Date.now(),
            userId: USER_ID,
            member: makeMember()
        }],
        turnTimer: null,
        responding: false,
        staleDiscards: 0,
        activeCaptures: new Set(),
        speakers: new Map(),
        stopped: false
    };
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    aiService.supportsNativeWebSearch.mockReturnValue(false);
});

describe('voice turn tool calling', () => {
    test('executes a performSearch tool call and speaks the outcome', async () => {
        aiService.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 'call-1', name: 'performSearch', arguments: '{"query":"weather in Tokyo"}' }]
            })
            .mockResolvedValueOnce({ content: 'It is sunny and 24 degrees in Tokyo right now.', toolCalls: [] });

        const session = makeSession();
        await voiceSessionService._respondToTurn(session);

        expect(perplexityService.search).toHaveBeenCalledWith('weather in Tokyo');
        expect(aiService.chat).toHaveBeenCalledTimes(2);

        // First round offers the voice tool subset
        const firstOpts = aiService.chat.mock.calls[0][1];
        const offered = firstOpts.functions.map(f => f.name);
        expect(offered).toEqual(expect.arrayContaining(['performSearch', 'rememberFact', 'forgetFact', 'setNickname', 'generateImage', 'scheduleFollowUp']));
        expect(offered).not.toContain('playTrack');
        expect(offered).not.toContain('speakMessage');

        // Second round sees the tool result
        const secondMessages = aiService.chat.mock.calls[1][0];
        const toolMessage = secondMessages.find(m => m.role === 'tool');
        expect(toolMessage).toMatchObject({
            toolCallId: 'call-1',
            name: 'performSearch',
            content: 'Sunny, 24 degrees in Tokyo today.'
        });

        // The final reply is spoken and recorded in history
        expect(session.ttsService.textToSpeech).toHaveBeenCalledWith(
            'It is sunny and 24 degrees in Tokyo right now.',
            session.voiceChannel,
            session.connection
        );
        expect(session.history.at(-1)).toEqual({
            role: 'assistant',
            content: 'It is sunny and 24 degrees in Tokyo right now.'
        });
        expect(session.turnBuffer).toHaveLength(0);

        // Cues: one ack when the turn was accepted, one for the tool round
        expect(playResponseCue).toHaveBeenCalledTimes(1);
        expect(playResponseCue).toHaveBeenCalledWith(session.connection);
        expect(playToolCue).toHaveBeenCalledTimes(1);
        expect(playToolCue).toHaveBeenCalledWith(session.connection);
    });

    test('tools receive a voice interaction context attributed to the speaker', async () => {
        const executeSpy = jest.spyOn(toolsRegistry, 'execute');
        aiService.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 'call-2', name: 'performSearch', arguments: '{"query":"latest node lts"}' }]
            })
            .mockResolvedValueOnce({ content: 'Done.', toolCalls: [] });

        const session = makeSession();
        await voiceSessionService._respondToTurn(session);

        const [name, args] = executeSpy.mock.calls[0];
        expect(name).toBe('performSearch');
        expect(args.interactionContext).toMatchObject({
            guildId: GUILD_ID,
            channelId: session.textChannel.id,
            isVoiceInteraction: true
        });
        expect(args.interactionContext.user.id).toBe(USER_ID);
        expect(args.interactionContext.member.displayName).toBe('Rob');
        executeSpy.mockRestore();
    });

    test('text-channel tools are withheld when the session has no transcript channel', async () => {
        aiService.chat.mockResolvedValueOnce({ content: 'Just chatting.', toolCalls: [] });

        const session = makeSession({ textChannel: null });
        await voiceSessionService._respondToTurn(session);

        const offered = aiService.chat.mock.calls[0][1].functions.map(f => f.name);
        expect(offered).toEqual(expect.arrayContaining(['performSearch', 'rememberFact', 'forgetFact', 'setNickname']));
        expect(offered).not.toContain('generateImage');
        expect(offered).not.toContain('scheduleFollowUp');
    });

    test('a failing tool surfaces the error to the model instead of crashing the turn', async () => {
        perplexityService.search.mockRejectedValueOnce(new Error('Perplexity is down'));
        aiService.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 'call-3', name: 'performSearch', arguments: '{"query":"anything"}' }]
            })
            .mockResolvedValueOnce({ content: 'Sorry, my search is not working right now.', toolCalls: [] });

        const session = makeSession();
        await voiceSessionService._respondToTurn(session);

        const secondMessages = aiService.chat.mock.calls[1][0];
        const toolMessage = secondMessages.find(m => m.role === 'tool');
        expect(toolMessage.content).toContain('Error executing tool performSearch');
        expect(toolMessage.content).toContain('Perplexity is down');
        expect(session.ttsService.textToSpeech).toHaveBeenCalledWith(
            'Sorry, my search is not working right now.',
            session.voiceChannel,
            session.connection
        );
    });

    test('plain conversational turns still work without any tool call', async () => {
        aiService.chat.mockResolvedValueOnce({ content: 'Hey Rob, not much, just vibing.', toolCalls: [] });

        const session = makeSession();
        session.turnBuffer[0].text = 'Hey Goobster, what is up?';
        await voiceSessionService._respondToTurn(session);

        expect(aiService.chat).toHaveBeenCalledTimes(1);
        expect(session.ttsService.textToSpeech).toHaveBeenCalledWith(
            'Hey Rob, not much, just vibing.',
            session.voiceChannel,
            session.connection
        );
        // No tool ran, so only the response cue played
        expect(playResponseCue).toHaveBeenCalledTimes(1);
        expect(playToolCue).not.toHaveBeenCalled();
    });

    test('the tool loop is capped: the last round must produce the spoken reply', async () => {
        aiService.chat.mockResolvedValue({
            content: 'fallback text',
            toolCalls: [{ id: 'loop', name: 'performSearch', arguments: '{"query":"again"}' }]
        });

        const session = makeSession();
        await voiceSessionService._respondToTurn(session);

        // 3 rounds max: two tool rounds, then the final round's content is used
        expect(aiService.chat).toHaveBeenCalledTimes(3);
        expect(perplexityService.search).toHaveBeenCalledTimes(2);
        expect(session.ttsService.textToSpeech).toHaveBeenCalledWith(
            'fallback text',
            session.voiceChannel,
            session.connection
        );
    });
});
