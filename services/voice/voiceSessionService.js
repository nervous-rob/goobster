const {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    EndBehaviorType
} = require('@discordjs/voice');
const prism = require('prism-media');
const transcriptionService = require('../transcriptionService');
const aiService = require('../aiService');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');

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
// Conversation turns kept per session
const HISTORY_LIMIT = 12;

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
 * Instead of replying to every pause, the session continuously captures and
 * transcribes speech SEGMENTS into a turn buffer, and only generates one
 * reply once the channel has been quiet for a real turn-ending silence.
 * If anyone resumes speaking while a reply is being generated, the stale
 * reply is discarded and their new speech is folded into the next turn -
 * the same wait-until-actually-done behavior as ChatGPT/Gemini voice modes.
 *
 * One session per guild.
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
     * @param {Object} params - { voiceChannel, textChannel, client, ttsService }
     */
    async startSession({ voiceChannel, textChannel, client, ttsService }) {
        const guildId = voiceChannel.guild.id;
        if (this.sessions.has(guildId)) {
            throw new Error('A voice conversation is already active in this server. Use /voicechat stop first.');
        }
        if (!transcriptionService.isConfigured()) {
            throw new Error('Voice conversations require an OpenAI API key for speech-to-text.');
        }
        if (!ttsService || ttsService.disabled) {
            throw new Error('Voice conversations require ElevenLabs TTS to be configured.');
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
            throw new Error('Could not connect to the voice channel in time.');
        }

        const session = {
            guildId,
            voiceChannel,
            textChannel,
            connection,
            ttsService,
            client,
            history: [],            // { role, content } conversation turns
            turnBuffer: [],         // { speakerName, text, at } transcribed segments awaiting a reply
            turnTimer: null,        // pending turn-end timeout
            responding: false,      // a reply is being generated/spoken
            staleDiscards: 0,       // consecutive replies discarded as stale
            activeCaptures: new Set(), // userIds currently being recorded
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

        connection.receiver.speaking.on('start', (userId) => {
            // Someone is talking: never respond mid-speech
            this._cancelTurnTimer(session);
            this._captureSegment(session, userId).catch(err => {
                console.error('[VoiceSession] Capture error:', err.message);
            });
        });

        console.log(`[VoiceSession] Started in guild ${guildId}, channel ${voiceChannel.name}`);
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
     * Schedule the turn-end response once the channel is quiet: no one is
     * being recorded and there is transcribed speech waiting for a reply.
     */
    _maybeScheduleTurnEnd(session) {
        if (session.stopped || session.turnBuffer.length === 0) return;
        if (session.activeCaptures.size > 0) return; // someone is still talking
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
     */
    async _captureSegment(session, userId) {
        if (session.stopped) return;
        if (session.activeCaptures.has(userId)) return;

        const member = session.voiceChannel.guild.members.cache.get(userId);
        if (!member || member.user.bot) return;

        session.activeCaptures.add(userId);

        const maxBytes = (MAX_SEGMENT_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        const chunks = [];
        let totalBytes = 0;

        const opusStream = session.connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: SEGMENT_SILENCE_MS }
        });
        const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });

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
                decoder.on('error', reject);
                opusStream.on('error', reject);
            });
        } finally {
            session.activeCaptures.delete(userId);
            opusStream.destroy();
            decoder.destroy();
        }

        if (session.stopped) return;

        const minBytes = (MIN_SEGMENT_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        if (totalBytes < minBytes) {
            // Too short to transcribe, but a longer pending buffer may now be ready
            this._maybeScheduleTurnEnd(session);
            return;
        }

        const pcm = Buffer.concat(chunks, totalBytes);
        const speakerName = member.displayName || member.user.username;

        try {
            const transcript = await transcriptionService.transcribe(buildWavBuffer(pcm), {
                usageContext: { guildId: session.guildId, userId }
            });
            if (transcript && transcript.length >= 2) {
                session.turnBuffer.push({ speakerName, text: transcript, at: Date.now() });
                console.log(`[VoiceSession] Segment (${speakerName}): ${transcript}`);
            }
        } catch (error) {
            console.error('[VoiceSession] Transcription failed:', error.message);
        }

        this._maybeScheduleTurnEnd(session);
    }

    /**
     * Generate and speak ONE reply for everything said during the turn.
     * If new speech arrives while generating, the reply is discarded as
     * stale and the new speech joins the still-unanswered buffer.
     */
    async _respondToTurn(session) {
        if (session.stopped || session.responding || session.turnBuffer.length === 0) return;

        session.responding = true;
        const snapshotLength = session.turnBuffer.length;
        const turnText = session.turnBuffer
            .map(s => `${s.speakerName}: ${s.text}`)
            .join('\n');

        try {
            const basePrompt = await getPromptWithGuildPersonality(null, session.guildId).catch(() => null);
            const systemPrompt = `${basePrompt || 'You are Goobster, a quirky and clever Discord bot.'}

VOICE CONVERSATION MODE:
You are in a live voice conversation in the Discord voice channel "${session.voiceChannel.name}". Your reply will be spoken aloud with text-to-speech.
- The user's turn may contain several sentences or speakers; respond to the whole thought, not just the last sentence.
- Keep replies short and conversational (1-3 sentences unless asked for detail).
- No markdown, emojis, bullet points, links, or code - plain speakable text only.`;

            const reply = await aiService.chatText([
                { role: 'system', content: systemPrompt },
                ...session.history,
                { role: 'user', content: turnText }
            ], {
                preset: 'chat',
                max_tokens: 220,
                usageContext: { guildId: session.guildId }
            });

            // Staleness check: did anyone speak while we were thinking?
            const grewStale = session.turnBuffer.length !== snapshotLength || session.activeCaptures.size > 0;
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
            }
        } finally {
            session.responding = false;
            // Anything said during generation/TTS is still waiting for a reply
            this._maybeScheduleTurnEnd(session);
        }
    }
}

module.exports = new VoiceSessionService();
