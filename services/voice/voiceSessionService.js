const {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    EndBehaviorType
} = require('@discordjs/voice');
const prism = require('prism-media');
const transcriptionService = require('../transcriptionService');
const aiService = require('../aiService');
const toolsRegistry = require('../../utils/toolsRegistry');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');
const { getBotPreferredName } = require('../../utils/guildContext');
const { pcmRms } = require('./pcmUtils');
const {
    HISTORY_LIMIT,
    MAX_CHAT_ROUNDS,
    getVoiceToolNames,
    shouldRespond,
    buildToolContext,
    executeToolCalls
} = require('./voiceTurnShared');

// Discord voice delivers 48kHz stereo 16-bit PCM after opus decoding
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

// A pause this long ends a SEGMENT (not the turn) - segments are transcribed
// eagerly while the speaker may still be mid-thought.
const SEGMENT_SILENCE_MS = 900;
// The turn ends - and Goobster responds - only after the channel has been
// quiet this long following the last transcribed segment.
const TURN_END_SILENCE_MS = 2200;
// Segments shorter than this are ignored (coughs, key clicks, etc.)
const MIN_SEGMENT_MS = 400;
// Hard cap per segment to bound memory (~60s of PCM ≈ 11.5MB)
const MAX_SEGMENT_MS = 60000;
// After this many stale discards, respond anyway so a busy channel can't
// defer Goobster forever.
const MAX_STALE_DISCARDS = 2;
// Segments quieter than this RMS (16-bit scale) are treated as mic noise:
// no transcription, and they never block or delay a reply.
const NOISE_RMS_THRESHOLD = 250;
// After this many consecutive word-less segments, a user is flagged as
// "noisy mic": their audio still gets captured (they may start talking),
// but it no longer cancels or blocks turn-taking until they produce words.
const MAX_EMPTY_STREAK = 2;

/**
 * Build a RIFF/WAVE header for raw s16le PCM.
 */
function buildWavBuffer(pcmBuffer) {
    const header = Buffer.alloc(44);
    const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                          // fmt chunk size
    header.writeUInt16LE(1, 20);                           // PCM format
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
    header.writeUInt16LE(16, 34);                          // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([header, pcmBuffer]);
}

/**
 * Live voice conversations with turn-based buffering.
 *
 * Two engines share this manager (one session per guild either way):
 *
 * - 'classic': capture a whole speech segment, batch-transcribe it (OpenAI),
 *   generate the full reply, then speak it (ElevenLabs HTTP streaming TTS).
 * - 'realtime': stream audio into ElevenLabs Scribe v2 Realtime while the
 *   user is still talking, stream LLM deltas straight into a multi-context
 *   TTS WebSocket, and support true barge-in. See realtimeVoiceEngine.js.
 *
 * Instead of replying to every pause, the session continuously captures and
 * transcribes speech SEGMENTS into a turn buffer, and only generates one
 * reply once the channel has been quiet for a real turn-ending silence.
 */
class VoiceSessionService {
    constructor() {
        this.sessions = new Map(); // guildId -> session
    }

    hasSession(guildId) {
        return this.sessions.has(guildId);
    }

    getSession(guildId) {
        return this.sessions.get(guildId) || null;
    }

    /**
     * Start a voice conversation session in a channel.
     * @param {Object} params - { voiceChannel, textChannel, client, ttsService, mode, engine }
     *   mode: 'polite' (default) - only reply when addressed by name, in a
     *         follow-up window, or when a cheap classifier says a response
     *         is genuinely needed. 'open' - reply to every turn.
     *   engine: 'realtime' (default) - streaming STT + streaming TTS with
     *           barge-in. 'classic' - the original batch pipeline.
     */
    async startSession({ voiceChannel, textChannel, client, ttsService, mode = 'polite', engine = 'realtime' }) {
        const guildId = voiceChannel.guild.id;
        if (this.sessions.has(guildId)) {
            throw new Error('A voice conversation is already active in this server. Use /voicechat stop first.');
        }
        if (!ttsService || ttsService.disabled) {
            throw new Error('Voice conversations require ElevenLabs TTS to be configured.');
        }
        if (engine === 'classic' && !transcriptionService.isConfigured()) {
            throw new Error('The classic voice engine requires an OpenAI API key for speech-to-text.');
        }

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch (error) {
            connection.destroy();
            throw new Error('Could not connect to the voice channel in time.', { cause: error });
        }

        const session = {
            guildId,
            voiceChannel,
            textChannel,
            connection,
            ttsService,
            client,
            engine,                 // 'realtime' | 'classic'
            engineImpl: null,       // set for realtime sessions
            mode,                   // 'polite' | 'open'
            lastBotSpokeAt: 0,      // epoch ms when Goobster last finished speaking
            botNames: null,         // lowercase names that count as addressing him
            history: [],            // { role, content } conversation turns
            turnBuffer: [],         // { speakerName, text, at } transcribed segments awaiting a reply
            turnTimer: null,        // pending turn-end timeout
            responding: false,      // a reply is being generated/spoken
            staleDiscards: 0,       // consecutive replies discarded as stale
            activeCaptures: new Set(), // userIds currently being recorded
            speakers: new Map(),    // userId -> { emptyStreak } noise tracking
            stopped: false
        };
        this.sessions.set(guildId, session);

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                ]);
            } catch {
                this.stopSession(guildId);
            }
        });

        // Names that count as "directly talked to" (checked lowercase)
        const names = new Set(['goobster', client.user.username.toLowerCase()]);
        try {
            const nickname = await getBotPreferredName(guildId, voiceChannel.guild.members.me);
            if (nickname) names.add(nickname.toLowerCase());
        } catch { /* nickname lookup is best-effort */ }
        session.botNames = [...names];

        if (engine === 'realtime') {
            // Loaded lazily so the classic pipeline works even if the
            // realtime module (or its deps) ever fails to load.
            const RealtimeVoiceEngine = require('./realtimeVoiceEngine');
            const engineImpl = new RealtimeVoiceEngine(session);
            try {
                await engineImpl.start();
            } catch (error) {
                this.sessions.delete(guildId);
                try { connection.destroy(); } catch { /* already gone */ }
                throw new Error(
                    `Could not start the realtime voice engine (${error.message}). ` +
                    'Try `/voicechat start engine:classic` instead.',
                    { cause: error }
                );
            }
            session.engineImpl = engineImpl;
        } else {
            connection.receiver.speaking.on('start', (userId) => {
                this._onSpeakingStart(session, userId);
            });
        }

        console.log(`[VoiceSession] Started in guild ${guildId}, channel ${voiceChannel.name} (mode: ${mode}, engine: ${engine})`);
        return session;
    }

    /**
     * Stop and clean up a session.
     */
    stopSession(guildId) {
        const session = this.sessions.get(guildId);
        if (!session) return false;

        session.stopped = true;
        this._cancelTurnTimer(session);
        this.sessions.delete(guildId);
        try {
            session.engineImpl?.stop();
        } catch { /* engine already stopped */ }
        try {
            session.connection.receiver?.speaking?.removeAllListeners('start');
        } catch { /* already torn down */ }
        try {
            session.connection.destroy();
        } catch { /* already destroyed */ }

        console.log(`[VoiceSession] Stopped in guild ${guildId}`);
        return true;
    }

    _cancelTurnTimer(session) {
        if (session.turnTimer) {
            clearTimeout(session.turnTimer);
            session.turnTimer = null;
        }
    }

    /**
     * Whether this user's mic is currently flagged as noise (consecutive
     * word-less segments). Noisy mics never cancel or block turn-taking.
     */
    _isNoisySpeaker(session, userId) {
        return (session.speakers.get(userId)?.emptyStreak || 0) >= MAX_EMPTY_STREAK;
    }

    /**
     * Speaking-start gate: bots never trigger anything, and only speakers
     * who have been producing actual words cancel a pending reply.
     */
    _onSpeakingStart(session, userId) {
        if (session.stopped) return;
        const member = session.voiceChannel.guild.members.cache.get(userId);
        if (!member || member.user.bot) return;

        if (!this._isNoisySpeaker(session, userId)) {
            // Someone with a real voice track record is talking: hold the reply
            this._cancelTurnTimer(session);
        }

        this._captureSegment(session, userId, member).catch(err => {
            console.error('[VoiceSession] Capture error:', err.message);
        });
    }

    /**
     * Captures that block turn-end: only from speakers not flagged as noise.
     */
    _blockingCaptures(session) {
        let blocking = 0;
        for (const userId of session.activeCaptures) {
            if (!this._isNoisySpeaker(session, userId)) blocking++;
        }
        return blocking;
    }

    /**
     * Schedule the turn-end response once the channel is quiet: no one with
     * a wordful mic is being recorded and there is transcribed speech
     * waiting for a reply.
     */
    _maybeScheduleTurnEnd(session) {
        if (session.stopped || session.turnBuffer.length === 0) return;
        if (this._blockingCaptures(session) > 0) return; // someone is still talking
        if (session.responding) return; // reschedule happens after the reply settles

        this._cancelTurnTimer(session);
        session.turnTimer = setTimeout(() => {
            session.turnTimer = null;
            this._respondToTurn(session).catch(err => {
                console.error('[VoiceSession] Turn response error:', err.message);
                session.responding = false;
            });
        }, TURN_END_SILENCE_MS);
    }

    /**
     * Record one speech segment from a user, transcribe it eagerly, and add
     * it to the turn buffer. Transcription runs while others may still be
     * speaking, so the turn-end reply only pays LLM + TTS latency.
     *
     * Noise handling: segments below the RMS energy gate or that transcribe
     * to no words bump the user's emptyStreak; noisy users stop influencing
     * turn-taking until they produce actual words again.
     */
    async _captureSegment(session, userId, member) {
        if (session.stopped) return;
        if (session.activeCaptures.has(userId)) return;

        session.activeCaptures.add(userId);

        const maxBytes = (MAX_SEGMENT_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        const chunks = [];
        let totalBytes = 0;

        const opusStream = session.connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: SEGMENT_SILENCE_MS }
        });
        const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });

        // Hard cutoff: a hot mic that never goes silent must not hold the
        // capture (and with it, turn-taking) open indefinitely.
        const cutoff = setTimeout(() => {
            try { opusStream.destroy(); } catch { /* already gone */ }
        }, MAX_SEGMENT_MS);

        try {
            await new Promise((resolve, reject) => {
                opusStream.pipe(decoder);
                decoder.on('data', (chunk) => {
                    if (totalBytes < maxBytes) {
                        chunks.push(chunk);
                        totalBytes += chunk.length;
                    }
                });
                decoder.on('end', resolve);
                decoder.on('close', resolve);
                decoder.on('error', reject);
                opusStream.on('error', reject);
            });
        } finally {
            clearTimeout(cutoff);
            session.activeCaptures.delete(userId);
            opusStream.destroy();
            decoder.destroy();
        }

        if (session.stopped) return;

        const speakerInfo = session.speakers.get(userId) || { emptyStreak: 0 };
        const markEmpty = () => {
            speakerInfo.emptyStreak++;
            session.speakers.set(userId, speakerInfo);
        };

        const minBytes = (MIN_SEGMENT_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        if (totalBytes < minBytes) {
            // Too short to transcribe, but a longer pending buffer may now be ready
            this._maybeScheduleTurnEnd(session);
            return;
        }

        const pcm = Buffer.concat(chunks, totalBytes);

        // Energy gate: open-mic noise (breathing, hum, keyboard bleed) never
        // reaches the transcription API at all.
        const rms = pcmRms(pcm);
        if (rms < NOISE_RMS_THRESHOLD) {
            markEmpty();
            this._maybeScheduleTurnEnd(session);
            return;
        }

        const speakerName = member.displayName || member.user.username;

        try {
            const transcript = await transcriptionService.transcribe(buildWavBuffer(pcm), {
                usageContext: { guildId: session.guildId, userId }
            });
            const hasWords = transcript && /[\p{L}\p{N}]{2,}/u.test(transcript);
            if (hasWords) {
                speakerInfo.emptyStreak = 0;
                session.speakers.set(userId, speakerInfo);
                session.turnBuffer.push({ speakerName, text: transcript, at: Date.now(), userId, member });
                console.log(`[VoiceSession] Segment (${speakerName}): ${transcript}`);
            } else {
                markEmpty();
            }
        } catch (error) {
            console.error('[VoiceSession] Transcription failed:', error.message);
        }

        this._maybeScheduleTurnEnd(session);
    }

    /**
     * Generate and speak ONE reply for everything said during the turn.
     * The model may call server tools (web search, facts, nicknames, images,
     * follow-ups) before producing the spoken reply. If new speech arrives
     * while generating, the reply is discarded as stale and the new speech
     * joins the still-unanswered buffer.
     */
    async _respondToTurn(session) {
        if (session.stopped || session.responding || session.turnBuffer.length === 0) return;

        session.responding = true;
        const snapshotLength = session.turnBuffer.length;
        const turnText = session.turnBuffer
            .map(s => `${s.speakerName}: ${s.text}`)
            .join('\n');

        try {
            // Polite mode: check the address gate before paying for a reply
            const gate = await shouldRespond(session, turnText);
            if (!gate.respond) {
                // Keep the unaddressed turn as context so he's caught up
                // whenever he IS addressed, but say nothing.
                const overheard = session.turnBuffer.splice(0, session.turnBuffer.length);
                const overheardText = overheard.map(s => `${s.speakerName}: ${s.text}`).join('\n');
                session.history.push({ role: 'user', content: `(not addressed to you) ${overheardText}` });
                while (session.history.length > HISTORY_LIMIT) session.history.shift();
                session.staleDiscards = 0;
                console.log(`[VoiceSession] Staying silent (${gate.reason})`);
                return;
            }

            const basePrompt = await getPromptWithGuildPersonality(null, session.guildId).catch(() => null);
            const systemPrompt = `${basePrompt || 'You are Goobster, a quirky and clever Discord bot.'}

VOICE CONVERSATION MODE:
You are in a live voice conversation in the Discord voice channel "${session.voiceChannel.name}". Your reply will be spoken aloud with text-to-speech.
- The user's turn may contain several sentences or speakers; respond to the whole thought, not just the last sentence.
- Keep replies short and conversational (1-3 sentences unless asked for detail).
- No markdown, emojis, bullet points, links, or code - plain speakable text only.
- You can take actions: search the web for current information, remember or forget facts about people${session.textChannel ? ', generate images (posted to the text channel), schedule follow-ups' : ''}, and change nicknames. When someone asks you to look something up or do something, use the matching tool, then tell them the outcome out loud in plain speakable words - never read out URLs, lists, or raw results.`;

            const functionDefs = toolsRegistry.getDefinitions(getVoiceToolNames(session));
            const toolContext = buildToolContext(session, session.turnBuffer.slice(0, snapshotLength));

            const messagesForModel = [
                { role: 'system', content: systemPrompt },
                ...session.history,
                { role: 'user', content: turnText }
            ];

            let reply = null;
            for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
                const chatOptions = {
                    preset: 'chat',
                    max_tokens: 220,
                    usageContext: { guildId: session.guildId }
                };
                if (functionDefs.length > 0) {
                    chatOptions.functions = functionDefs;
                }
                // Providers with native web search can also answer live
                // questions without the performSearch round-trip.
                if (aiService.supportsNativeWebSearch()) {
                    chatOptions.webSearch = true;
                }

                const { content, toolCalls } = await aiService.chat(messagesForModel, chatOptions);

                if (toolCalls && toolCalls.length > 0 && round < MAX_CHAT_ROUNDS - 1) {
                    messagesForModel.push({ role: 'assistant', content, toolCalls });
                    await executeToolCalls(session, toolCalls, messagesForModel, toolContext);
                    continue; // next round voices the outcome
                }

                reply = content || '';
                break;
            }

            // Staleness check: did anyone say actual words while we were thinking?
            const grewStale = session.turnBuffer.length !== snapshotLength || this._blockingCaptures(session) > 0;
            if (grewStale && session.staleDiscards < MAX_STALE_DISCARDS) {
                session.staleDiscards++;
                console.log(`[VoiceSession] Reply discarded as stale (${session.staleDiscards}); waiting for the turn to really end`);
                return; // buffer keeps old + new segments for the next turn-end
            }

            session.staleDiscards = 0;
            const answered = session.turnBuffer.splice(0, session.turnBuffer.length);
            const answeredText = answered.map(s => `${s.speakerName}: ${s.text}`).join('\n');

            if (!reply) return;

            session.history.push({ role: 'user', content: answeredText });
            session.history.push({ role: 'assistant', content: reply });
            while (session.history.length > HISTORY_LIMIT) session.history.shift();

            console.log(`[VoiceSession] Goobster: ${reply}`);

            // Optional live transcript in the invoking text channel
            if (session.textChannel) {
                const lines = answered.map(s => `🎙️ **${s.speakerName}:** ${s.text}`).join('\n');
                session.textChannel.send({
                    content: `${lines}\n🤖 **Goobster:** ${reply}`.slice(0, 2000),
                    allowedMentions: { users: [], roles: [] }
                }).catch(() => {});
            }

            if (!session.stopped) {
                await session.ttsService.textToSpeech(reply, session.voiceChannel, session.connection);
                session.lastBotSpokeAt = Date.now();
            }
        } finally {
            session.responding = false;
            // Anything said during generation/TTS is still waiting for a reply
            this._maybeScheduleTurnEnd(session);
        }
    }
}

module.exports = new VoiceSessionService();
