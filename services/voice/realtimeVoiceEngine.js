const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const aiService = require('../aiService');
const transcriptionService = require('../transcriptionService');
const toolsRegistry = require('../../utils/toolsRegistry');
const usageTracker = require('../usageTracker');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');
const { ScribeRealtimeConnection } = require('./scribeRealtimeService');
const { MultiContextTTSService } = require('./multiContextTTSService');
const { stereo48kToMono16k, pcmRms } = require('./pcmUtils');
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

// Segments end faster than in the classic engine: transcription already
// happened during speech, so a shorter pause costs nothing extra.
const SEGMENT_SILENCE_MS = 700;
// The channel must be quiet this long after the last committed transcript
// before Goobster replies. Short by design - barge-in makes early replies
// cheap to correct.
const TURN_END_SILENCE_MS = 900;
// Hard cap per segment to bound memory (~60s of PCM ≈ 11.5MB)
const MAX_SEGMENT_MS = 60000;
// Segments quieter than this RMS (16-bit scale) are treated as mic noise:
// audio is buffered but never streamed to the STT API until a chunk crosses
// the gate.
const NOISE_RMS_THRESHOLD = 250;
// After this many consecutive word-less segments, a user is flagged as
// "noisy mic": their speech no longer barges in or blocks turn-taking
// until they produce words again.
const MAX_EMPTY_STREAK = 2;
// Barge-in requires this much cumulative above-the-noise-gate audio in a
// segment before an in-flight reply is cut off. Discord's speaking-start
// event alone fires on any mic blip (coughs, breaths, chair squeaks), which
// made interruptions far too aggressive; a wordful STT partial still barges
// in immediately regardless of this window.
const BARGE_IN_SUSTAINED_MS = 350;
// 48kHz stereo 16-bit = 192 bytes per millisecond of audio
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000;
const WORDS_REGEX = /[\p{L}\p{N}]{2,}/u;

/**
 * The realtime voice engine: GPT-Voice-style low-latency conversations.
 *
 * Pipeline per turn:
 *   Discord opus -> PCM -> (energy gate) -> Scribe v2 Realtime WebSocket
 *   (partials while speaking, committed text ~instantly at segment end)
 *   -> short quiet window -> LLM with onDelta streaming
 *   -> multi-context TTS WebSocket (audio starts on the first sentence)
 *   -> Discord playback.
 *
 * Barge-in: when a known-wordful speaker talks over Goobster (or over a
 * reply being generated) with sustained voice energy - not just a mic blip -
 * or the realtime STT hears actual words, the TTS context is closed
 * server-side, playback stops immediately, and the interrupted reply is
 * recorded as such. The new speech becomes the next turn.
 *
 * The engine drives the shared session object owned by voiceSessionService;
 * turn-buffer/history semantics match the classic engine.
 */
class RealtimeVoiceEngine {
    /**
     * @param {Object} session - the session object from voiceSessionService
     */
    constructor(session) {
        this.session = session;
        this.tts = null;            // MultiContextTTSService
        this.currentReply = null;   // active speak() handle
        this.interrupted = false;   // barge-in flag for the in-flight reply
        this.sttFailures = 0;       // consecutive realtime STT failures
    }

    /**
     * Connect the TTS WebSocket and start listening. Throws when the
     * connection cannot be established (caller falls back to classic).
     */
    async start() {
        const session = this.session;
        const ttsService = session.ttsService;
        const voiceId = await ttsService.resolveVoiceId(ttsService.voiceId);

        this.tts = new MultiContextTTSService({
            apiKey: ttsService.apiKey,
            voiceId,
            modelId: ttsService.modelId
        });
        this.tts.on('error', (error) => {
            console.error('[RealtimeVoice] TTS socket error:', error.message);
        });
        await this.tts.connect();

        session.connection.receiver.speaking.on('start', (userId) => {
            this._onSpeakingStart(userId);
        });
    }

    stop() {
        try { this.currentReply?.abort(); } catch { /* already gone */ }
        this.currentReply = null;
        try { this.tts?.destroy(); } catch { /* already gone */ }
    }

    _isNoisySpeaker(userId) {
        return (this.session.speakers.get(userId)?.emptyStreak || 0) >= MAX_EMPTY_STREAK;
    }

    _cancelTurnTimer() {
        if (this.session.turnTimer) {
            clearTimeout(this.session.turnTimer);
            this.session.turnTimer = null;
        }
    }

    /**
     * Barge-in: kill the in-flight reply (generation and/or playback).
     */
    _bargeIn(reason) {
        if (!this.session.responding && !this.currentReply) return;
        this.interrupted = true;
        if (this.currentReply) {
            console.log(`[RealtimeVoice] Barge-in (${reason}): stopping playback`);
            try { this.currentReply.abort(); } catch { /* already gone */ }
            this.currentReply = null;
        }
    }

    _onSpeakingStart(userId) {
        const session = this.session;
        if (session.stopped) return;
        const member = session.voiceChannel.guild.members.cache.get(userId);
        if (!member || member.user.bot) return;

        // Hold off a pending reply, but do NOT interrupt an in-flight one
        // yet: Discord's speaking event fires on any mic blip. Barge-in
        // happens once the segment shows sustained energy or real words.
        if (!this._isNoisySpeaker(userId)) {
            this._cancelTurnTimer();
        }

        this._captureSegment(userId, member).catch(err => {
            console.error('[RealtimeVoice] Capture error:', err.message);
        });
    }

    /**
     * Per-segment tracker: feed it decoded PCM chunks and it triggers ONE
     * barge-in after BARGE_IN_SUSTAINED_MS of cumulative above-the-gate
     * audio from a speaker not currently flagged as a noisy mic. Coughs and
     * short blips never accumulate enough hot audio to interrupt.
     * @param {string} userId
     * @returns {(chunk: Buffer) => void}
     */
    _createBargeInTracker(userId) {
        let hotMs = 0;
        let fired = false;
        return (chunk) => {
            if (fired || this.session.stopped) return;
            if (pcmRms(chunk, 4) < NOISE_RMS_THRESHOLD) return;
            hotMs += chunk.length / BYTES_PER_MS;
            if (hotMs >= BARGE_IN_SUSTAINED_MS && !this._isNoisySpeaker(userId)) {
                fired = true;
                this._cancelTurnTimer();
                this._bargeIn('sustained speech');
            }
        };
    }

    _blockingCaptures() {
        let blocking = 0;
        for (const userId of this.session.activeCaptures) {
            if (!this._isNoisySpeaker(userId)) blocking++;
        }
        return blocking;
    }

    _maybeScheduleTurnEnd() {
        const session = this.session;
        if (session.stopped || session.turnBuffer.length === 0) return;
        if (this._blockingCaptures() > 0) return;
        if (session.responding) return;

        this._cancelTurnTimer();
        session.turnTimer = setTimeout(() => {
            session.turnTimer = null;
            this._respondToTurn().catch(err => {
                console.error('[RealtimeVoice] Turn response error:', err.message);
                session.responding = false;
            });
        }, TURN_END_SILENCE_MS);
    }

    /**
     * Capture one utterance and stream it to the realtime STT API while the
     * user is still speaking.
     *
     * Cost control: audio is buffered locally until one chunk crosses the
     * RMS energy gate; pure mic noise never opens an STT connection at all.
     * Reliability: the raw PCM is also kept (bounded) so that when the
     * realtime STT fails mid-segment, the segment falls back to the classic
     * batch transcription path (OpenAI) when configured.
     */
    async _captureSegment(userId, member) {
        const session = this.session;
        if (session.stopped) return;
        if (session.activeCaptures.has(userId)) return;

        session.activeCaptures.add(userId);

        const maxBytes = (MAX_SEGMENT_MS / 1000) * SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        const pcmChunks = [];          // raw 48k stereo, for STT fallback
        let totalBytes = 0;
        let hot = false;               // RMS gate crossed - streaming to STT
        let scribe = null;
        let scribeReady = null;        // promise resolving when connected
        let scribeFailed = false;
        const preBuffer = [];          // 16k mono chunks awaiting connection
        const speakerName = member.displayName || member.user.username;

        const speakerInfo = session.speakers.get(userId) || { emptyStreak: 0 };
        const markEmpty = () => {
            speakerInfo.emptyStreak++;
            session.speakers.set(userId, speakerInfo);
        };
        const markWordful = () => {
            speakerInfo.emptyStreak = 0;
            session.speakers.set(userId, speakerInfo);
        };

        const openScribe = () => {
            scribe = new ScribeRealtimeConnection({
                apiKey: session.ttsService.apiKey,
                keyterms: session.botNames || []
            });
            scribe.on('partial', (text) => {
                if (session.stopped) return;
                if (WORDS_REGEX.test(text)) {
                    markWordful();
                    // The STT heard actual words mid-reply: interrupt right
                    // away without waiting for the sustained-energy window.
                    this._cancelTurnTimer();
                    this._bargeIn('speech detected');
                }
            });
            scribe.on('error', (error) => {
                scribeFailed = true;
                console.warn('[RealtimeVoice] Realtime STT error:', error.message);
            });
            scribeReady = scribe.connect().then(() => {
                for (const chunk of preBuffer.splice(0)) scribe.sendAudio(chunk);
            }).catch((error) => {
                scribeFailed = true;
                console.warn('[RealtimeVoice] Realtime STT connect failed:', error.message);
            });
        };

        const trackBargeIn = this._createBargeInTracker(userId);

        const opusStream = session.connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: SEGMENT_SILENCE_MS }
        });
        const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });

        const cutoff = setTimeout(() => {
            try { opusStream.destroy(); } catch { /* already gone */ }
        }, MAX_SEGMENT_MS);

        try {
            await new Promise((resolve, reject) => {
                opusStream.pipe(decoder);
                decoder.on('data', (chunk) => {
                    if (totalBytes >= maxBytes) return;
                    pcmChunks.push(chunk);
                    totalBytes += chunk.length;
                    trackBargeIn(chunk);

                    if (!hot && pcmRms(chunk, 4) >= NOISE_RMS_THRESHOLD) {
                        hot = true;
                        openScribe();
                        // Stream everything captured so far (context helps accuracy)
                        for (const buffered of pcmChunks) {
                            const mono = stereo48kToMono16k(buffered);
                            if (scribe.ready) scribe.sendAudio(mono);
                            else preBuffer.push(mono);
                        }
                        return;
                    }
                    if (hot) {
                        const mono = stereo48kToMono16k(chunk);
                        if (scribe.ready) scribe.sendAudio(mono);
                        else preBuffer.push(mono);
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

        if (session.stopped) {
            scribe?.close();
            return;
        }

        if (!hot) {
            // Never crossed the energy gate: open mic noise
            markEmpty();
            this._maybeScheduleTurnEnd();
            return;
        }

        let transcript = '';
        try {
            await scribeReady;
            if (!scribeFailed) {
                transcript = await scribe.commit();
                usageTracker.log({
                    provider: 'elevenlabs',
                    model: scribe.modelId,
                    operation: 'transcription-realtime',
                    guildId: session.guildId,
                    userId
                });
                this.sttFailures = 0;
            }
        } catch (error) {
            scribeFailed = true;
            console.warn('[RealtimeVoice] Realtime STT commit failed:', error.message);
        } finally {
            scribe?.close();
        }

        // Fallback: batch-transcribe the buffered PCM when realtime STT
        // produced nothing because of an error (not because of silence).
        if (scribeFailed && !transcript && transcriptionService.isConfigured()) {
            this.sttFailures++;
            try {
                const pcm = Buffer.concat(pcmChunks, totalBytes);
                transcript = await transcriptionService.transcribe(this._buildWav(pcm), {
                    usageContext: { guildId: session.guildId, userId }
                });
            } catch (error) {
                console.error('[RealtimeVoice] Fallback transcription failed:', error.message);
            }
        }

        const hasWords = transcript && WORDS_REGEX.test(transcript);
        if (hasWords) {
            markWordful();
            session.turnBuffer.push({ speakerName, text: transcript.trim(), at: Date.now(), userId, member });
            console.log(`[RealtimeVoice] Segment (${speakerName}): ${transcript.trim()}`);
        } else {
            markEmpty();
        }

        this._maybeScheduleTurnEnd();
    }

    _buildWav(pcmBuffer) {
        const header = Buffer.alloc(44);
        const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcmBuffer.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(CHANNELS, 22);
        header.writeUInt32LE(SAMPLE_RATE, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcmBuffer.length, 40);
        return Buffer.concat([header, pcmBuffer]);
    }

    /**
     * Generate and speak ONE reply for the buffered turn, streaming LLM
     * deltas straight into the TTS WebSocket so audio starts on the first
     * sentence rather than after the full response.
     */
    async _respondToTurn() {
        const session = this.session;
        if (session.stopped || session.responding || session.turnBuffer.length === 0) return;

        session.responding = true;
        this.interrupted = false;
        const turnText = session.turnBuffer
            .map(s => `${s.speakerName}: ${s.text}`)
            .join('\n');

        let replyHandle = null;
        let spoken = '';

        try {
            const gate = await shouldRespond(session, turnText);
            if (!gate.respond) {
                const overheard = session.turnBuffer.splice(0, session.turnBuffer.length);
                const overheardText = overheard.map(s => `${s.speakerName}: ${s.text}`).join('\n');
                session.history.push({ role: 'user', content: `(not addressed to you) ${overheardText}` });
                while (session.history.length > HISTORY_LIMIT) session.history.shift();
                console.log(`[RealtimeVoice] Staying silent (${gate.reason})`);
                return;
            }
            if (this.interrupted) return; // barged in during the gate check

            const basePrompt = await getPromptWithGuildPersonality(null, session.guildId).catch(() => null);
            const systemPrompt = `${basePrompt || 'You are Goobster, a quirky and clever Discord bot.'}

VOICE CONVERSATION MODE:
You are in a live voice conversation in the Discord voice channel "${session.voiceChannel.name}". Your reply is spoken aloud with text-to-speech as you write it, and users can interrupt you.
- The user's turn may contain several sentences or speakers; respond to the whole thought, not just the last sentence.
- Keep replies short and conversational (1-3 sentences unless asked for detail).
- No markdown, emojis, bullet points, links, or code - plain speakable text only.
- You can take actions: search the web for current information, remember or forget facts about people${session.textChannel ? ', generate images (posted to the text channel), schedule follow-ups' : ''}, change nicknames, and run the server's point economy - check balances, take gambling bets (coin flips, d20 rolls, poker hands), quote stock prices, buy or sell stocks, and report portfolios. When someone asks you to look something up or do something, use the matching tool, then tell them the outcome out loud in plain speakable words - never read out URLs, lists, or raw results.`;

            const functionDefs = toolsRegistry.getDefinitions(getVoiceToolNames(session));
            const snapshot = session.turnBuffer.slice(0, session.turnBuffer.length);
            const toolContext = buildToolContext(session, snapshot);

            const messagesForModel = [
                { role: 'system', content: systemPrompt },
                ...session.history,
                { role: 'user', content: turnText }
            ];

            // Stream deltas into a TTS context created lazily on first text.
            // The same context spans tool rounds, so "let me check" filler
            // and the post-tool answer flow as one utterance.
            const speakDelta = (delta) => {
                if (!delta || this.interrupted || session.stopped) return;
                if (!replyHandle) {
                    if (!this.tts.isConnected()) return; // audio lost; text still recorded
                    replyHandle = this.tts.speak(session.connection);
                    this.currentReply = replyHandle;
                }
                replyHandle.appendText(delta);
                spoken += delta;
            };

            for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
                let deltaSeen = false;
                const chatOptions = {
                    preset: 'chat',
                    max_tokens: 220,
                    usageContext: { guildId: session.guildId },
                    onDelta: (delta) => {
                        deltaSeen = true;
                        speakDelta(delta);
                    }
                };
                if (functionDefs.length > 0) {
                    chatOptions.functions = functionDefs;
                }
                if (aiService.supportsNativeWebSearch()) {
                    chatOptions.webSearch = true;
                }

                const { content, toolCalls } = await aiService.chat(messagesForModel, chatOptions);

                // Providers that don't stream in tool mode (Ollama) still
                // deliver the full content here - speak it in one piece.
                if (content && !deltaSeen) {
                    speakDelta(content);
                }

                if (this.interrupted || session.stopped) break;

                if (toolCalls && toolCalls.length > 0 && round < MAX_CHAT_ROUNDS - 1) {
                    messagesForModel.push({ role: 'assistant', content, toolCalls });
                    await executeToolCalls(session, toolCalls, messagesForModel, toolContext);
                    continue;
                }
                break;
            }

            // Only the segments this reply answered leave the buffer; anything
            // committed while we were generating (e.g. after a barge-in)
            // stays queued for the next turn.
            const answered = session.turnBuffer.splice(0, snapshot.length);
            const answeredText = answered.map(s => `${s.speakerName}: ${s.text}`).join('\n');

            if (!spoken) return;

            const wasInterrupted = this.interrupted;
            const historyReply = wasInterrupted ? `${spoken} [interrupted by a user mid-reply]` : spoken;
            session.history.push({ role: 'user', content: answeredText });
            session.history.push({ role: 'assistant', content: historyReply });
            while (session.history.length > HISTORY_LIMIT) session.history.shift();

            console.log(`[RealtimeVoice] Goobster${wasInterrupted ? ' (interrupted)' : ''}: ${spoken}`);

            if (session.textChannel) {
                const lines = answered.map(s => `🎙️ **${s.speakerName}:** ${s.text}`).join('\n');
                session.textChannel.send({
                    content: `${lines}\n🤖 **Goobster:** ${spoken}${wasInterrupted ? ' *(interrupted)*' : ''}`.slice(0, 2000),
                    allowedMentions: { users: [], roles: [] }
                }).catch(() => {});
            }

            if (replyHandle && !wasInterrupted && !session.stopped) {
                await replyHandle.finish(); // resolves when playback is done
                session.lastBotSpokeAt = Date.now();
            }
        } finally {
            if (this.currentReply === replyHandle) this.currentReply = null;
            session.responding = false;
            this._maybeScheduleTurnEnd();
        }
    }
}

module.exports = RealtimeVoiceEngine;
