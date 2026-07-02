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

// Utterances shorter than this are ignored (coughs, key clicks, etc.)
const MIN_UTTERANCE_MS = 600;
// Hard cap per utterance to bound memory (~60s of PCM ≈ 11.5MB)
const MAX_UTTERANCE_MS = 60000;
// Silence gap that ends an utterance
const SILENCE_DURATION_MS = 1200;
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
 * Live voice conversations: listens to users in a voice channel, transcribes
 * their speech (OpenAI STT), generates a reply through the normal AI provider
 * stack, and speaks it back with ElevenLabs TTS.
 *
 * One session per guild. Utterances are processed sequentially per session
 * so the bot never talks over itself.
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
            history: [],           // { role, content } conversation turns
            activeCaptures: new Set(), // userIds currently being recorded
            queue: Promise.resolve(),  // serializes utterance processing
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
            this._captureUtterance(session, userId).catch(err => {
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

    /**
     * Record one utterance from a user, then queue it for processing.
     */
    async _captureUtterance(session, userId) {
        if (session.stopped) return;
        if (session.activeCaptures.has(userId)) return;

        const member = session.voiceChannel.guild.members.cache.get(userId);
        if (!member || member.user.bot) return;

        session.activeCaptures.add(userId);

        const maxBytes = (MAX_UTTERANCE_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        const chunks = [];
        let totalBytes = 0;

        const opusStream = session.connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS }
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

        const minBytes = (MIN_UTTERANCE_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        if (session.stopped || totalBytes < minBytes) return;

        const pcm = Buffer.concat(chunks, totalBytes);
        const speakerName = member.displayName || member.user.username;

        // Serialize processing so replies don't overlap
        session.queue = session.queue
            .then(() => this._processUtterance(session, pcm, speakerName))
            .catch(err => console.error('[VoiceSession] Processing error:', err.message));
    }

    /**
     * Transcribe an utterance, generate a reply, and speak it.
     */
    async _processUtterance(session, pcm, speakerName) {
        if (session.stopped) return;

        const wav = buildWavBuffer(pcm);
        const transcript = await transcriptionService.transcribe(wav);

        // Ignore empty or junk transcriptions
        if (!transcript || transcript.length < 2) return;

        console.log(`[VoiceSession] ${speakerName}: ${transcript}`);
        session.history.push({ role: 'user', content: `${speakerName}: ${transcript}` });
        while (session.history.length > HISTORY_LIMIT) session.history.shift();

        const basePrompt = await getPromptWithGuildPersonality(null, session.guildId).catch(() => null);
        const systemPrompt = `${basePrompt || 'You are Goobster, a quirky and clever Discord bot.'}

VOICE CONVERSATION MODE:
You are in a live voice conversation in the Discord voice channel "${session.voiceChannel.name}". Your reply will be spoken aloud with text-to-speech.
- Keep replies short and conversational (1-3 sentences unless asked for detail).
- No markdown, emojis, bullet points, links, or code - plain speakable text only.
- Multiple people may be talking; the current speaker's name prefixes their message.`;

        const reply = await aiService.chatText([
            { role: 'system', content: systemPrompt },
            ...session.history
        ], {
            preset: 'chat',
            max_tokens: 220
        });

        if (session.stopped || !reply) return;

        session.history.push({ role: 'assistant', content: reply });
        while (session.history.length > HISTORY_LIMIT) session.history.shift();

        console.log(`[VoiceSession] Goobster: ${reply}`);

        // Optional live transcript in the invoking text channel
        if (session.textChannel) {
            session.textChannel.send({
                content: `🎙️ **${speakerName}:** ${transcript}\n🤖 **Goobster:** ${reply}`,
                allowedMentions: { users: [], roles: [] }
            }).catch(() => {});
        }

        await session.ttsService.textToSpeech(reply, session.voiceChannel, session.connection);
    }
}

module.exports = new VoiceSessionService();
