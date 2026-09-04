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

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));

jest.mock('@goobster/core/services/perplexityService', () => ({
    isConfigured: jest.fn().mockReturnValue(true),
    search: jest.fn().mockResolvedValue('Sunny, 24 degrees in Tokyo today.')
}));

jest.mock('@goobster/core/utils/memeMode', () => ({
    getPromptWithGuildPersonality: jest.fn().mockResolvedValue('You are Goobster.')
}));

// Notification cues play real PCM through an audio player; stub them out
// and assert on invocation instead.
jest.mock('@goobster/core/services/voice/notificationSounds', () => ({
    playResponseCue: jest.fn().mockResolvedValue(true),
    playToolCue: jest.fn().mockResolvedValue(true),
    playErrorCue: jest.fn().mockResolvedValue(true)
}));

const aiService = require('@goobster/core/services/aiService');
const perplexityService = require('@goobster/core/services/perplexityService');
const { playResponseCue, playToolCue, playErrorCue } = require('@goobster/core/services/voice/notificationSounds');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const voiceSessionService = require('@goobster/core/services/voice/voiceSessionService');
const db = require('@goobster/core/db');

const GUILD_ID = '500000000000000001';
const USER_ID = '500000000000000002';

function makeMember() {
    return {
        user: { id: USER_ID, username: 'rob', bot: false },
        displayName: 'Rob'
    };
}

function makeSession({ textChannel = { id: '500000000000000003', send: jest.fn().mockResolvedValue(undefined) } } = {}) {
    const session = {
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
    lastSession = session;
    return session;
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

let lastSession = null;

beforeEach(() => {
    jest.clearAllMocks();
    aiService.supportsNativeWebSearch.mockReturnValue(false);
    lastSession = null;
});

afterEach(() => {
    // A failed turn reschedules itself after TURN_END_SILENCE_MS. Cancel
    // that silence window so the suite does not log after Jest tears down.
    if (lastSession) voiceSessionService._cancelTurnTimer(lastSession);
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
        expect(offered).toEqual(expect.arrayContaining(['performSearch', 'rememberFact', 'forgetFact', 'lookupNotes', 'setNickname', 'generateImage', 'scheduleFollowUp', 'manageAutomations']));
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
            session.connection,
            { voiceId: null }
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
        expect(playErrorCue).not.toHaveBeenCalled();
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
        expect(offered).toEqual(expect.arrayContaining(['performSearch', 'rememberFact', 'forgetFact', 'lookupNotes', 'setNickname']));
        expect(offered).not.toContain('generateImage');
        expect(offered).not.toContain('scheduleFollowUp');
        expect(offered).not.toContain('manageAutomations');
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
            session.connection,
            { voiceId: null }
        );
        // The failed tool announced itself with the error cue
        expect(playErrorCue).toHaveBeenCalledTimes(1);
        expect(playErrorCue).toHaveBeenCalledWith(session.connection);
    });

    test('a turn that dies (LLM failure) plays the error cue and rethrows', async () => {
        aiService.chat.mockRejectedValueOnce(new Error('provider exploded'));

        const session = makeSession();
        await expect(voiceSessionService._respondToTurn(session)).rejects.toThrow('provider exploded');

        expect(playErrorCue).toHaveBeenCalledTimes(1);
        expect(playErrorCue).toHaveBeenCalledWith(session.connection);
        expect(session.ttsService.textToSpeech).not.toHaveBeenCalled();
        expect(session.responding).toBe(false); // finally still ran
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
            session.connection,
            { voiceId: null }
        );
        // No tool ran, so only the response cue played
        expect(playResponseCue).toHaveBeenCalledTimes(1);
        expect(playToolCue).not.toHaveBeenCalled();
    });

    test('the tool budget is bounded and exhaustion forces a spoken answer', async () => {
        // The model wants a (different) search every round until the
        // finalization nudge orders it to answer with what it has.
        aiService.chat.mockImplementation(async (messages) => {
            const hasNudge = messages.some(m => m.role === 'system' && m.content.startsWith('TOOL BUDGET EXHAUSTED'));
            if (hasNudge) {
                return { content: 'Here is what I found, Rob.', toolCalls: [] };
            }
            const n = messages.filter(m => m.role === 'tool').length;
            return {
                content: '',
                toolCalls: [{ id: `loop-${n}`, name: 'performSearch', arguments: `{"query":"again ${n}"}` }]
            };
        });

        const session = makeSession();
        await voiceSessionService._respondToTurn(session);

        // 3 tool rounds + the finalization round that must produce the reply
        expect(aiService.chat).toHaveBeenCalledTimes(4);
        expect(perplexityService.search).toHaveBeenCalledTimes(3);
        expect(session.ttsService.textToSpeech).toHaveBeenCalledWith(
            'Here is what I found, Rob.',
            session.voiceChannel,
            session.connection,
            { voiceId: null }
        );
    });

    test('identical repeated tool calls within a turn are served from cache', async () => {
        aiService.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 'dup-1', name: 'performSearch', arguments: '{"query":"same thing"}' }]
            })
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 'dup-2', name: 'performSearch', arguments: '{"query":"same thing"}' }]
            })
            .mockResolvedValueOnce({ content: 'Asked and answered.', toolCalls: [] });

        const session = makeSession();
        await voiceSessionService._respondToTurn(session);

        expect(perplexityService.search).toHaveBeenCalledTimes(1);
        expect(session.ttsService.textToSpeech).toHaveBeenCalledWith(
            'Asked and answered.',
            session.voiceChannel,
            session.connection,
            { voiceId: null }
        );
    });
});
