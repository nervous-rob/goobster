/**
 * Realtime voice engine (services/voice/realtimeVoiceEngine.js): LLM deltas
 * stream into the TTS context as they arrive, tool calling works across
 * rounds on a single context, and barge-in interrupts cleanly.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-realtime-voice-test-${process.pid}.sqlite`);
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

// These wrapped commands hard-require the gitignored config.json at load
// time; the voice loop only needs their tool definitions to exist.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

const aiService = require('../services/aiService');
const RealtimeVoiceEngine = require('../services/voice/realtimeVoiceEngine');
const db = require('../db');

const GUILD_ID = '600000000000000001';
const USER_ID = '600000000000000002';

function makeMember() {
    return {
        user: { id: USER_ID, username: 'rob', bot: false },
        displayName: 'Rob'
    };
}

const liveSessions = [];

function makeSession() {
    const session = {
        guildId: GUILD_ID,
        voiceChannel: { name: 'General', guild: { id: GUILD_ID } },
        textChannel: { id: '600000000000000003', send: jest.fn().mockResolvedValue(undefined) },
        connection: { subscribe: jest.fn() },
        ttsService: { apiKey: 'k', voiceId: 'v', modelId: 'm' },
        client: { user: { id: 'bot', username: 'Goobster' } },
        engine: 'realtime',
        mode: 'open',
        lastBotSpokeAt: 0,
        botNames: ['goobster'],
        history: [],
        turnBuffer: [{
            speakerName: 'Rob',
            text: 'Hey Goobster, how are you?',
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
    liveSessions.push(session);
    return session;
}

/** A fake multi-context TTS service capturing the streamed text. */
function makeFakeTTS() {
    const handles = [];
    return {
        handles,
        isConnected: () => true,
        speak: jest.fn(() => {
            const handle = {
                contextId: `ctx-${handles.length + 1}`,
                appended: [],
                finished: false,
                aborted: false,
                appendText(text) { this.appended.push(text); },
                finish: jest.fn(async function () { this.finished = true; }),
                abort: jest.fn(function () { this.aborted = true; })
            };
            handle.finish = handle.finish.bind(handle);
            handle.abort = handle.abort.bind(handle);
            handles.push(handle);
            return handle;
        }),
        destroy: jest.fn()
    };
}

function makeEngine(session) {
    const engine = new RealtimeVoiceEngine(session);
    engine.tts = makeFakeTTS();
    return engine;
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

afterEach(() => {
    // Stop any turn-end timers scheduled during the test
    for (const session of liveSessions.splice(0)) {
        session.stopped = true;
        if (session.turnTimer) clearTimeout(session.turnTimer);
    }
});

describe('realtime voice turns', () => {
    test('streams LLM deltas into the TTS context and finishes playback', async () => {
        aiService.chat.mockImplementationOnce(async (messages, opts) => {
            opts.onDelta('Doing ');
            opts.onDelta('great, Rob!');
            return { content: 'Doing great, Rob!', toolCalls: [] };
        });

        const session = makeSession();
        const engine = makeEngine(session);
        await engine._respondToTurn(session);

        const handle = engine.tts.handles[0];
        expect(handle.appended).toEqual(['Doing ', 'great, Rob!']);
        expect(handle.finished).toBe(true);
        expect(session.history.at(-1)).toEqual({ role: 'assistant', content: 'Doing great, Rob!' });
        expect(session.turnBuffer).toHaveLength(0);
        expect(session.lastBotSpokeAt).toBeGreaterThan(0);
    });

    test('tool rounds and the final answer share one TTS context', async () => {
        aiService.chat
            .mockImplementationOnce(async (messages, opts) => {
                opts.onDelta('Let me check. ');
                return {
                    content: 'Let me check. ',
                    toolCalls: [{ id: 'call-1', name: 'performSearch', arguments: '{"query":"weather in Tokyo"}' }]
                };
            })
            .mockImplementationOnce(async (messages, opts) => {
                opts.onDelta('It is sunny and 24 degrees.');
                return { content: 'It is sunny and 24 degrees.', toolCalls: [] };
            });

        const session = makeSession();
        session.turnBuffer[0].text = 'Goobster, what is the weather in Tokyo?';
        const engine = makeEngine(session);
        await engine._respondToTurn(session);

        expect(aiService.chat).toHaveBeenCalledTimes(2);
        expect(engine.tts.speak).toHaveBeenCalledTimes(1); // one context for the whole turn
        const handle = engine.tts.handles[0];
        expect(handle.appended.join('')).toBe('Let me check. It is sunny and 24 degrees.');

        // The tool result reached round two
        const secondMessages = aiService.chat.mock.calls[1][0];
        const toolMessage = secondMessages.find(m => m.role === 'tool');
        expect(toolMessage).toMatchObject({ toolCallId: 'call-1', name: 'performSearch' });
    });

    test('non-streaming providers (tool-mode Ollama) still get spoken', async () => {
        // No onDelta invocation; full content arrives at once
        aiService.chat.mockResolvedValueOnce({ content: 'All at once.', toolCalls: [] });

        const session = makeSession();
        const engine = makeEngine(session);
        await engine._respondToTurn(session);

        expect(engine.tts.handles[0].appended).toEqual(['All at once.']);
        expect(engine.tts.handles[0].finished).toBe(true);
    });

    test('barge-in mid-generation aborts the reply and marks history', async () => {
        const session = makeSession();
        const engine = makeEngine(session);

        aiService.chat.mockImplementationOnce(async (messages, opts) => {
            opts.onDelta('I was saying something long ');
            // User starts talking mid-stream
            session.responding = true;
            engine._bargeIn('test');
            opts.onDelta('that nobody will hear');
            return { content: 'I was saying something long that nobody will hear', toolCalls: [] };
        });

        await engine._respondToTurn(session);

        const handle = engine.tts.handles[0];
        expect(handle.aborted).toBe(true);
        expect(handle.finished).toBe(false);
        // Post-interrupt deltas were not streamed
        expect(handle.appended).toEqual(['I was saying something long ']);
        expect(session.history.at(-1).content).toContain('[interrupted by a user mid-reply]');
        expect(session.lastBotSpokeAt).toBe(0);
    });

    test('polite-mode unaddressed turns stay silent but are remembered', async () => {
        aiService.generateText.mockResolvedValueOnce('silent');

        const session = makeSession();
        session.mode = 'polite';
        session.turnBuffer[0].text = 'So anyway I told Dave about the fish';
        const engine = makeEngine(session);
        await engine._respondToTurn(session);

        expect(aiService.chat).not.toHaveBeenCalled();
        expect(engine.tts.speak).not.toHaveBeenCalled();
        expect(session.history.at(-1).content).toContain('(not addressed to you)');
        expect(session.turnBuffer).toHaveLength(0);
    });

    test('segments committed during generation stay queued for the next turn', async () => {
        const session = makeSession();
        const engine = makeEngine(session);

        aiService.chat.mockImplementationOnce(async (messages, opts) => {
            // Someone else finishes a segment while the reply is generating
            session.turnBuffer.push({
                speakerName: 'Ana', text: 'Wait, one more thing', at: Date.now(), userId: 'u2', member: null
            });
            opts.onDelta('Answering the first thing.');
            return { content: 'Answering the first thing.', toolCalls: [] };
        });

        await engine._respondToTurn(session);

        expect(session.turnBuffer).toHaveLength(1);
        expect(session.turnBuffer[0].text).toBe('Wait, one more thing');
    });

    test('speaking-start from a wordful speaker cancels playback via _onSpeakingStart', async () => {
        const session = makeSession();
        session.voiceChannel.guild.members = { cache: new Map([[USER_ID, makeMember()]]) };
        const engine = makeEngine(session);
        engine._captureSegment = jest.fn().mockResolvedValue(undefined); // no real audio here

        // Simulate an in-flight reply
        session.responding = true;
        engine.currentReply = engine.tts.speak(session.connection);
        const handle = engine.tts.handles[0];

        engine._onSpeakingStart(USER_ID);

        expect(handle.aborted).toBe(true);
        expect(engine.interrupted).toBe(true);
        expect(engine.currentReply).toBeNull();
    });

    test('noisy speakers do not barge in', async () => {
        const session = makeSession();
        session.voiceChannel.guild.members = { cache: new Map([[USER_ID, makeMember()]]) };
        session.speakers.set(USER_ID, { emptyStreak: 5 }); // flagged as noise
        const engine = makeEngine(session);
        engine._captureSegment = jest.fn().mockResolvedValue(undefined);

        session.responding = true;
        engine.currentReply = engine.tts.speak(session.connection);
        const handle = engine.tts.handles[0];

        engine._onSpeakingStart(USER_ID);

        expect(handle.aborted).toBe(false);
        expect(engine.interrupted).toBe(false);
    });
});
