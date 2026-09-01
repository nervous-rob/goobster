/**
 * Parlor Live: real-time voice sessions in the web portal's Parlor.
 *
 * A live session is a WebSocket room per parlor discussion. Humans stream
 * microphone audio up (16kHz mono s16le PCM, resampled in the browser);
 * the server runs an RMS energy gate (open-mic noise never reaches paid
 * STT), streams hot audio into ElevenLabs Scribe v2 Realtime while the
 * user is still talking, and commits the utterance on the client's
 * silence gate. Committed utterances become NORMAL parlor turns through
 * parlorService.startTurn - never a parallel generation path - so the
 * should-respond gate, retrieval, tools, and write-back all apply, and the
 * per-conversation turn lock is the arbiter when several humans talk.
 *
 * Persona speech goes the other way: each completed persona reply is
 * reduced to speakable text (webVoiceService.speechTextFromMarkdown - the
 * voice-stack rule: code/math/URLs never reach audio, capped length) and
 * synthesized through the shared ElevenLabs TTS service with that
 * PERSONA'S voice (parlor_personas.voiceId, defaulting to a premade-voice
 * pool keyed by persona id so casts sound distinct out of the box). MP3
 * chunks are fanned out to every connected member tagged with the
 * personaId, and replies play in order through a per-session speech queue.
 *
 * Turns started outside the session (a member typing through the normal
 * SSE route) are tapped in via observeTurn(), so typed turns are voiced
 * and rendered live too - one pipeline, two transports.
 *
 * Barge-in: in a SOLO session (one connected human), real words from the
 * speaker abort the in-flight persona speech and drop the queued rest -
 * the realtime engine's behavior. Shared sessions keep it simple: no
 * server-side barge-in (clients can pause playback locally).
 *
 * All session state is in-memory and re-derivable (the Activity-session
 * exception to the SQLite rule): a restart just ends the live layer, the
 * discussion itself is untouched. Nothing here persists, so there is no
 * new privacy surface; STT/TTS usage is logged to the OWNER's DM scope
 * (the host pays for their salon, like every other parlor AI call).
 */

const { pcmRms } = require('./voice/pcmUtils');
const { dmScopeId } = require('../utils/dmScope');

// Live audio arrives as 16kHz mono s16le PCM (32 bytes/ms)
const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
// Segments quieter than this RMS are treated as mic noise: buffered but
// never streamed to the STT API (the realtime engine's gate).
const NOISE_RMS_THRESHOLD = 250;
// Hard cap per utterance (60s of PCM ≈ 1.9MB); longer speech auto-commits.
const MAX_UTTERANCE_MS = 60000;
const MAX_UTTERANCE_BYTES = MAX_UTTERANCE_MS * BYTES_PER_MS;
// One WS audio message may carry at most ~6s of PCM (base64)
const MAX_AUDIO_CHUNK_BASE64 = 256 * 1024;
// Cost guardrails: sessions end themselves after this long, and one user
// may only start so many sessions per window (transient in-memory state).
const SESSION_MAX_MS = 45 * 60 * 1000;
const JOIN_RATE_LIMIT = 8;
const JOIN_RATE_WINDOW_MS = 10 * 60 * 1000;
// Utterances queued while a turn is running (the turn lock is the arbiter)
const MAX_PENDING_TURNS = 4;
const TURN_RETRY_MS = 2000;

const WORDS_REGEX = /[\p{L}\p{N}]{2,}/u;

// Personas without an explicit voice get one from this premade-voice pool
// (stable ElevenLabs premade voice ids, available on every account),
// picked by persona id - distinct voices are the point of the feature.
const DEFAULT_VOICE_POOL = [
    '21m00Tcm4TlvDq8ikWAM', // Rachel
    'pNInz6obpgDQGcFmaJgB', // Adam
    'EXAVITQu4vr4xnSDxMaL', // Sarah
    'ErXwobaYiN019PkySvjV', // Antoni
    'AZnzlk1XvdvUeBnXmlld', // Domi
    'TxGEqnHWrfWFTfGW9XjX'  // Josh
];

/** Machine-readable web app error (the PanelError status+code contract). */
class ParlorLiveError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ParlorLiveError';
        this.status = status;
        this.code = code;
    }
}

class ParlorLiveService {
    /**
     * @param {Object} [deps] - injectable for tests:
     *   { parlor, tts: () => service|null, elevenLabsKey: () => string|null,
     *     createScribe: (opts) => connection, webVoice, usageTracker, logger }
     */
    constructor(deps = {}) {
        this._deps = deps;
        /** @type {Map<number, Object>} conversationId -> live session */
        this._sessions = new Map();
        /** @type {Map<string, Object>} userId -> live socket (one per user; newest wins) */
        this._socketsByUser = new Map();
        this._directTts = null;
    }

    _parlor() {
        return this._deps.parlor || require('./parlorService');
    }

    _webVoice() {
        return this._deps.webVoice || require('./webVoiceService');
    }

    _usage() {
        return this._deps.usageTracker || require('./usageTracker');
    }

    _logger() {
        return this._deps.logger || console;
    }

    _elevenLabsKey() {
        if (this._deps.elevenLabsKey) return this._deps.elevenLabsKey();
        if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
        try {
            return require('../../../config.json').elevenlabs?.apiKey || null;
        } catch {
            return null;
        }
    }

    /**
     * The TTS service live sessions synthesize through: the shared
     * /setvoice-configured instance when the voice stack is up, else a
     * direct instance built from the key (webVoiceService's ladder).
     */
    _tts() {
        if (this._deps.tts) return this._deps.tts();
        try {
            const { voiceService } = require('./serviceManager');
            const tts = voiceService?.tts;
            if (tts && !tts.disabled) return tts;
        } catch { /* voice stack unavailable */ }
        const key = this._elevenLabsKey();
        if (!key) return null;
        if (!this._directTts) {
            const ElevenLabsTTSService = require('./voice/elevenLabsTTSService');
            const direct = new ElevenLabsTTSService({ elevenlabs: { apiKey: key } });
            this._directTts = direct.disabled ? null : direct;
        }
        return this._directTts;
    }

    _createScribe(opts) {
        if (this._deps.createScribe) return this._deps.createScribe(opts);
        const { ScribeRealtimeConnection } = require('./voice/scribeRealtimeService');
        return new ScribeRealtimeConnection(opts);
    }

    /**
     * Whether live sessions are possible on this server. The whole feature
     * needs ElevenLabs (realtime STT + per-persona TTS); without the key
     * the client never shows the button - graceful degradation, never an
     * error.
     * @returns {{ live: boolean }}
     */
    capabilities() {
        return { live: Boolean(this._elevenLabsKey()) };
    }

    /**
     * The ElevenLabs voice library for the persona voice picker.
     * @returns {Promise<Array<{id, name, category}>>}
     */
    async listVoices() {
        const tts = this._tts();
        if (!tts) {
            throw new ParlorLiveError(503, 'TTS_UNAVAILABLE',
                'Persona voices need an ElevenLabs API key on this server.');
        }
        try {
            return await tts.listVoices();
        } catch (error) {
            throw new ParlorLiveError(502, 'VOICES_FAILED',
                `Could not fetch the voice library (${error.message}).`);
        }
    }

    /** The voice a persona speaks with when none is configured. */
    _defaultVoiceFor(personaId) {
        return DEFAULT_VOICE_POOL[Math.abs(Number(personaId) || 0) % DEFAULT_VOICE_POOL.length];
    }

    // --- Connection handling -------------------------------------------------

    /**
     * Drive one authenticated live WebSocket. The web layer has already
     * resolved the session cookie; membership in the discussion is checked
     * here on 'join' (parlorService.requireConversationAccess - strangers
     * get the same NO_SUCH_CONVERSATION a missing discussion gives).
     * @param {Object} socket - a ws socket
     * @param {Object} identity - { userId, userName, gateway? } (the gateway
     *   rides along so live turns can deliver @-mention DMs like typed ones)
     */
    handleConnection(socket, { userId, userName = null, gateway = null }) {
        let session = null; // the joined live session
        let client = null;

        const send = (type, data = {}) => {
            if (socket.readyState === socket.OPEN) {
                try { socket.send(JSON.stringify({ type, ...data })); } catch { /* closing */ }
            }
        };
        const sendError = (code, message) => send('error', { code, message });

        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                sendError('BAD_JSON', 'Messages must be JSON.');
                return;
            }
            try {
                if (message.type === 'join') {
                    if (session) {
                        sendError('ALREADY_JOINED', 'This connection already joined a session.');
                        return;
                    }
                    ({ session, client } = await this._handleJoin(socket, send, {
                        userId, userName, gateway, conversationId: message.conversationId
                    }));
                } else if (!session || session.destroyed) {
                    sendError('NOT_JOINED', 'Join a live session first.');
                } else if (message.type === 'audio') {
                    this._handleAudio(session, client, message.data);
                } else if (message.type === 'utterance-end') {
                    await this._commitUtterance(session, client);
                } else if (message.type === 'say') {
                    this._handleSay(session, client, message.text);
                } else if (message.type === 'nudge') {
                    this._handleNudge(session, client, message.personaId);
                } else if (message.type === 'stop-speech') {
                    // Explicit stop = solo barge-in; in shared sessions the
                    // client pauses locally instead of silencing the room.
                    if (session.clients.size === 1) this._bargeIn(session, 'stop requested');
                } else if (message.type === 'leave') {
                    this._leave(session, client);
                    session = null;
                    client = null;
                } else {
                    sendError('BAD_TYPE', 'Unknown message type.');
                }
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(error.code, error.message);
                } else {
                    this._logger().error?.('[ParlorLive] WS error:', error.message);
                    sendError('INTERNAL', 'Something went wrong.');
                }
            }
        });

        socket.on('close', () => {
            if (session && client) this._leave(session, client);
            session = null;
            client = null;
        });
    }

    /** Sliding-window session-join rate limit; throws 429 when exceeded. */
    async _checkJoinRateLimit(userId) {
        const { consumeWindow } = require('../utils/slidingWindowLimit');
        const ok = await consumeWindow({
            scope: 'parlor_live_join',
            subject: userId,
            max: JOIN_RATE_LIMIT,
            windowMs: JOIN_RATE_WINDOW_MS
        });
        if (!ok) {
            throw new ParlorLiveError(429, 'RATE_LIMITED',
                'Slow down - too many live sessions started; try again in a few minutes.');
        }
    }

    async _handleJoin(socket, send, { userId, userName, gateway = null, conversationId }) {
        if (!this.capabilities().live) {
            throw new ParlorLiveError(503, 'LIVE_UNAVAILABLE',
                'Live voice sessions need an ElevenLabs API key on this server.');
        }
        await this._checkJoinRateLimit(userId);
        // Owner OR member; strangers get the same 404 as a missing discussion
        const conversation = await this._parlor().requireConversationAccess(userId, conversationId);

        // One live connection per user - the newest wins (pairing-code rule)
        const previous = this._socketsByUser.get(userId);
        if (previous && previous !== socket) {
            try {
                previous.send(JSON.stringify({ type: 'session_replaced' }));
                previous.close();
            } catch { /* already gone */ }
        }
        this._socketsByUser.set(userId, socket);

        const session = await this._getOrCreateSession(conversation);
        if (gateway && !session.gateway) session.gateway = gateway;
        const client = { socket, send, userId, userName, utterance: null };
        session.clients.set(userId, client);

        this._broadcast(session, 'listener_join', { userId, userName }, { except: userId });
        send('joined', {
            conversationId: session.conversationId,
            role: conversation.role,
            listeners: [...session.clients.values()].map(c => ({ userId: c.userId, userName: c.userName })),
            maxSessionMs: SESSION_MAX_MS
        });
        return { session, client };
    }

    async _getOrCreateSession(conversation) {
        let session = this._sessions.get(conversation.id);
        if (session) return session;

        session = {
            conversationId: conversation.id,
            ownerId: conversation.ownerId,
            /** Discord gateway from the web layer (mention DM delivery) */
            gateway: null,
            clients: new Map(),
            /** Persona voices, refreshed from persona_start events mid-turn */
            voiceById: new Map(),
            /** Persona names as STT keyterms (recognition help) */
            keyterms: [],
            pendingTurns: [],
            turnRunning: false,
            retryTimer: null,
            speechQueue: [],
            speaking: null,
            speechCounter: 0,
            destroyed: false,
            createdAt: Date.now(),
            ttlTimer: null
        };
        try {
            for (const participant of await this._parlor().listParticipants(conversation.id)) {
                session.keyterms.push(participant.name);
                session.voiceById.set(participant.id, participant.voiceId ?? null);
            }
        } catch { /* roster is a nicety - the session works without it */ }

        // Cost guardrail: sessions end themselves
        session.ttlTimer = setTimeout(() => this._endSession(session, 'time-limit'), SESSION_MAX_MS);
        session.ttlTimer.unref?.();
        this._sessions.set(conversation.id, session);
        return session;
    }

    _leave(session, client) {
        if (session.clients.get(client.userId) === client) {
            session.clients.delete(client.userId);
        }
        if (this._socketsByUser.get(client.userId) === client.socket) {
            this._socketsByUser.delete(client.userId);
        }
        this._closeUtterance(client);
        this._broadcast(session, 'listener_leave', { userId: client.userId, userName: client.userName });
        if (session.clients.size === 0) this._destroySession(session);
    }

    /** Time limit / shutdown: tell everyone, close sockets, tear down. */
    _endSession(session, reason) {
        this._broadcast(session, 'session_ended', { reason });
        for (const client of session.clients.values()) {
            try { client.socket.close(); } catch { /* already gone */ }
        }
        this._destroySession(session);
    }

    _destroySession(session) {
        if (session.destroyed) return;
        session.destroyed = true;
        clearTimeout(session.ttlTimer);
        clearTimeout(session.retryTimer);
        session.pendingTurns.length = 0;
        session.speechQueue.length = 0;
        if (session.speaking) {
            session.speaking.aborted = true;
            try { session.speaking.upstream?.destroy(); } catch { /* already gone */ }
            session.speaking = null;
        }
        for (const client of session.clients.values()) {
            this._closeUtterance(client);
        }
        session.clients.clear();
        this._sessions.delete(session.conversationId);
    }

    /** Tear down every live session (tests / shutdown). */
    stopAll() {
        for (const session of [...this._sessions.values()]) {
            this._endSession(session, 'shutdown');
        }
    }

    _broadcast(session, type, data = {}, { except = null } = {}) {
        for (const client of session.clients.values()) {
            if (except && client.userId === except) continue;
            client.send(type, data);
        }
    }

    // --- Microphone audio in -> realtime STT ---------------------------------

    /**
     * One chunk of the speaker's microphone PCM. Audio is buffered locally
     * until a chunk crosses the RMS energy gate; only then does an STT
     * connection open (pure mic noise never costs a cent - the realtime
     * engine's rule). The raw PCM is kept (bounded) for the batch fallback.
     */
    _handleAudio(session, client, data) {
        if (typeof data !== 'string' || data.length === 0 || data.length > MAX_AUDIO_CHUNK_BASE64) {
            throw new ParlorLiveError(400, 'BAD_AUDIO', 'Audio chunks must be small base64 PCM strings.');
        }
        let chunk;
        try {
            chunk = Buffer.from(data, 'base64');
        } catch {
            throw new ParlorLiveError(400, 'BAD_AUDIO', 'The audio payload could not be decoded.');
        }
        if (chunk.length === 0) return;

        let utterance = client.utterance;
        if (!utterance) {
            utterance = client.utterance = {
                chunks: [],
                totalBytes: 0,
                hot: false,
                scribe: null,
                scribeReady: null,
                scribeFailed: false,
                preBuffer: [],
                startedAt: Date.now(),
                committing: false
            };
        }
        if (utterance.committing) return; // late chunks after auto-commit

        utterance.chunks.push(chunk);
        utterance.totalBytes += chunk.length;

        if (!utterance.hot && pcmRms(chunk, 4) >= NOISE_RMS_THRESHOLD) {
            utterance.hot = true;
            this._openScribe(session, client, utterance);
            // Stream everything captured so far (context helps accuracy)
            for (const buffered of utterance.chunks) {
                this._feedScribe(utterance, buffered);
            }
        } else if (utterance.hot) {
            this._feedScribe(utterance, chunk);
        }

        // Runaway utterance: commit rather than buffer forever
        if (utterance.totalBytes >= MAX_UTTERANCE_BYTES) {
            utterance.committing = true;
            this._commitUtterance(session, client).catch(error => {
                this._logger().warn?.('[ParlorLive] Auto-commit failed:', error.message);
            });
        }
    }

    _feedScribe(utterance, chunk) {
        if (!utterance.scribe || utterance.scribeFailed) return;
        if (utterance.scribe.ready) utterance.scribe.sendAudio(chunk);
        else utterance.preBuffer.push(chunk);
    }

    _openScribe(session, client, utterance) {
        const tts = this._tts();
        const apiKey = tts?.apiKey || this._elevenLabsKey();
        if (!apiKey) {
            utterance.scribeFailed = true;
            return;
        }
        const scribe = this._createScribe({ apiKey, keyterms: session.keyterms });
        utterance.scribe = scribe;
        scribe.on('partial', (text) => {
            if (session.destroyed) return;
            client.send('stt_partial', { text });
            // Barge-in (solo sessions only): the STT heard actual words
            // while a persona was speaking - stop the speech immediately.
            if (WORDS_REGEX.test(text) && session.clients.size === 1) {
                this._bargeIn(session, 'speech detected');
            }
        });
        scribe.on('error', (error) => {
            utterance.scribeFailed = true;
            this._logger().warn?.('[ParlorLive] Realtime STT error:', error.message);
        });
        utterance.scribeReady = scribe.connect().then(() => {
            for (const chunk of utterance.preBuffer.splice(0)) scribe.sendAudio(chunk);
        }).catch((error) => {
            utterance.scribeFailed = true;
            this._logger().warn?.('[ParlorLive] Realtime STT connect failed:', error.message);
        });
    }

    _closeUtterance(client) {
        try { client.utterance?.scribe?.close(); } catch { /* already gone */ }
        client.utterance = null;
    }

    /**
     * End-of-speech (the client's silence gate, or the 60s cap): commit
     * the realtime transcript, falling back to per-utterance batch STT
     * (webVoiceService.transcribe - the same ladder classic /voicechat
     * uses) when the realtime API failed. A wordful transcript becomes a
     * queued parlor turn.
     */
    async _commitUtterance(session, client) {
        const utterance = client.utterance;
        if (!utterance) return;
        client.utterance = null;

        if (!utterance.hot) {
            // Never crossed the energy gate: open mic noise
            client.send('utterance_empty', {});
            return;
        }

        let transcript = '';
        try {
            await utterance.scribeReady;
            if (!utterance.scribeFailed && utterance.scribe) {
                transcript = await utterance.scribe.commit();
                this._usage().log({
                    provider: 'elevenlabs',
                    model: utterance.scribe.modelId,
                    operation: 'transcription-realtime',
                    guildId: dmScopeId(session.ownerId),
                    userId: session.ownerId
                });
            }
        } catch (error) {
            utterance.scribeFailed = true;
            this._logger().warn?.('[ParlorLive] Realtime STT commit failed:', error.message);
        } finally {
            try { utterance.scribe?.close(); } catch { /* already gone */ }
        }

        // Fallback: batch-transcribe the buffered PCM when realtime STT
        // produced nothing because of an ERROR (not because of silence).
        if (utterance.scribeFailed && !transcript) {
            try {
                const wav = this._buildWav(Buffer.concat(utterance.chunks, utterance.totalBytes));
                const result = await this._webVoice().transcribe({
                    userId: client.userId,
                    audioBase64: wav.toString('base64'),
                    mimeType: 'audio/wav'
                });
                transcript = result.text;
            } catch (error) {
                this._logger().warn?.('[ParlorLive] Fallback transcription failed:', error.message);
            }
        }

        const text = String(transcript || '').trim();
        if (!text || !WORDS_REGEX.test(text)) {
            client.send('utterance_empty', {});
            return;
        }
        this._queueTurn(session, client, { text });
    }

    /** RIFF/WAV header for the batch STT fallback (16kHz mono s16le). */
    _buildWav(pcmBuffer) {
        const header = Buffer.alloc(44);
        const byteRate = SAMPLE_RATE * 2;
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcmBuffer.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(SAMPLE_RATE, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcmBuffer.length, 40);
        return Buffer.concat([header, pcmBuffer]);
    }

    // --- Turns ----------------------------------------------------------------

    /** A typed message sent through the live socket (voiced like speech). */
    _handleSay(session, client, text) {
        const clean = String(text ?? '').trim();
        if (!clean) throw new ParlorLiveError(400, 'EMPTY_MESSAGE', 'Say something first.');
        if (clean.length > this._parlor().maxInputLength) {
            throw new ParlorLiveError(400, 'MESSAGE_TOO_LONG', 'Message is too long.');
        }
        this._queueTurn(session, client, { text: clean });
    }

    /** A participant-chip nudge sent through the live socket. */
    _handleNudge(session, client, personaId) {
        const id = Number(personaId);
        if (!Number.isInteger(id) || id <= 0) {
            throw new ParlorLiveError(400, 'BAD_PERSONA', 'nudge needs a personaId.');
        }
        this._queueTurn(session, client, { nudgePersonaId: id });
    }

    /**
     * Queue one turn (an utterance, a typed 'say', or a persona nudge).
     * While a turn is running, later utterances wait - the existing
     * per-conversation turn lock stays the arbiter.
     */
    _queueTurn(session, client, { text = null, nudgePersonaId = null }) {
        if (session.pendingTurns.length >= MAX_PENDING_TURNS) {
            client.send('error', {
                code: 'QUEUE_FULL',
                message: 'Too many utterances queued - let the personas answer first.'
            });
            return;
        }
        const queued = session.turnRunning || session.pendingTurns.length > 0;
        if (text) {
            this._broadcast(session, 'utterance', {
                userId: client.userId, userName: client.userName, text, queued
            });
        }
        session.pendingTurns.push({
            userId: client.userId, userName: client.userName, text, nudgePersonaId
        });
        this._pumpTurns(session);
    }

    async _pumpTurns(session) {
        if (session.destroyed || session.turnRunning || session.pendingTurns.length === 0) return;
        clearTimeout(session.retryTimer);
        session.retryTimer = null;

        const item = session.pendingTurns[0];
        session.turnRunning = true;
        let turn;
        try {
            const parlor = this._parlor();
            turn = item.nudgePersonaId
                ? await parlor.startPersonaTurn({
                    userId: item.userId, userName: item.userName,
                    conversationId: session.conversationId, personaId: item.nudgePersonaId
                })
                : await parlor.startTurn({
                    gateway: session.gateway,
                    userId: item.userId, userName: item.userName,
                    conversationId: session.conversationId, message: item.text
                });
        } catch (error) {
            session.turnRunning = false;
            if (error?.code === 'TURN_IN_FLIGHT') {
                // A turn from outside the session (e.g. the SSE route) holds
                // the lock - retry shortly instead of dropping the utterance.
                session.retryTimer = setTimeout(() => this._pumpTurns(session), TURN_RETRY_MS);
                session.retryTimer.unref?.();
                return;
            }
            session.pendingTurns.shift();
            const client = session.clients.get(item.userId);
            client?.send('error', {
                code: error?.code || 'INTERNAL',
                message: error?.message || 'The turn could not start.'
            });
            this._pumpTurns(session);
            return;
        }

        session.pendingTurns.shift();
        turn.run(this._turnEvents(session))
            .then(() => this._broadcast(session, 'turn_done', {}))
            .catch((error) => {
                this._logger().error?.('[ParlorLive] Turn failed:', error.message);
                this._broadcast(session, 'turn_error', {
                    code: 'INTERNAL', message: 'Something went wrong generating the replies.'
                });
            })
            .finally(() => {
                session.turnRunning = false;
                this._pumpTurns(session);
            });
    }

    /** The parlor turn event handlers: broadcast everything, voice replies. */
    _turnEvents(session) {
        return {
            onUserMessage: (message) => this._broadcast(session, 'user_message', message),
            onPersonaStart: (persona) => {
                if (persona?.id) session.voiceById.set(persona.id, persona.voiceId ?? null);
                this._broadcast(session, 'persona_start', persona);
            },
            onPersonaPass: (payload) => this._broadcast(session, 'persona_pass', payload),
            onDelta: (text) => this._broadcast(session, 'delta', { text }),
            onPersonaTool: (payload) => this._broadcast(session, 'persona_tool', payload),
            onPersonaMessage: async (message) => {
                this._broadcast(session, 'persona_message', message);
                if (message?.content && !message.isError && message.personaId) {
                    await this._enqueueSpeech(session, message);
                }
            },
            onLearned: (payload) => this._broadcast(session, 'learned', payload)
        };
    }

    /**
     * Tap for turns started OUTSIDE the live session (the normal SSE
     * routes): when the conversation has a live session, forward the turn's
     * events into it so typed turns render live and get voiced too. Purely
     * cosmetic - wrapped so it can never break the SSE turn.
     * @param {number} conversationId
     * @param {string} event - the SSE event name
     * @param {*} data
     */
    observeTurn(conversationId, event, data) {
        try {
            const session = this._sessions.get(Number(conversationId));
            if (!session || session.destroyed) return;
            const events = this._turnEvents(session);
            if (event === 'user_message') events.onUserMessage(data);
            else if (event === 'persona_start') events.onPersonaStart(data);
            else if (event === 'persona_pass') events.onPersonaPass(data);
            else if (event === 'delta') events.onDelta(data?.text || '');
            else if (event === 'persona_tool') events.onPersonaTool(data);
            else if (event === 'persona_message') events.onPersonaMessage(data);
            else if (event === 'learned') events.onLearned(data);
            else if (event === 'done') this._broadcast(session, 'turn_done', {});
            else if (event === 'error') this._broadcast(session, 'turn_error', data || {});
        } catch { /* hooks are cosmetic - never break the turn */ }
    }

    // --- Persona speech out ----------------------------------------------------

    /**
     * Queue one persona reply for synthesis. Personas "hear" each other by
     * reading the transcript - the reply is already text - so speech is
     * pure output: markdown-to-speech cleanup (code/math/URLs never reach
     * audio, 4000-char cap), then the persona's own voice.
     */
    async _enqueueSpeech(session, { personaId, personaName, content }) {
        if (session.destroyed) return;
        const { speechTextFromMarkdown } = require('./webVoiceService');
        const speakable = speechTextFromMarkdown(content);
        if (!speakable) return;
        session.speechQueue.push({ personaId, personaName, text: speakable });
        await this._pumpSpeech(session);
    }

    async _pumpSpeech(session) {
        if (session.destroyed || session.speaking || session.speechQueue.length === 0) return;
        const job = session.speechQueue.shift();
        const streamId = ++session.speechCounter;
        const voiceId = session.voiceById.get(job.personaId) || this._defaultVoiceFor(job.personaId);
        const speaking = { streamId, upstream: null, aborted: false };
        session.speaking = speaking;

        this._broadcast(session, 'speech_start', {
            streamId, personaId: job.personaId, personaName: job.personaName
        });
        try {
            const tts = this._tts();
            if (!tts) throw new Error('TTS unavailable');
            const response = await tts.fetchStream(job.text, { voiceId });
            if (speaking.aborted) {
                try { response.body.destroy(); } catch { /* already gone */ }
                return;
            }
            speaking.upstream = response.body;
            await new Promise((resolve, reject) => {
                response.body.on('data', (chunk) => {
                    this._broadcast(session, 'speech_chunk', {
                        streamId, data: chunk.toString('base64')
                    });
                });
                response.body.on('end', resolve);
                response.body.on('close', resolve);
                response.body.on('error', reject);
            });
            this._usage().log({
                provider: 'elevenlabs',
                model: tts.modelId,
                operation: 'tts-live',
                guildId: dmScopeId(session.ownerId),
                userId: session.ownerId
            });
            if (!speaking.aborted) this._broadcast(session, 'speech_end', { streamId });
        } catch (error) {
            this._logger().warn?.('[ParlorLive] Speech synthesis failed:', error.message);
            if (!speaking.aborted) {
                this._broadcast(session, 'speech_end', { streamId, error: true });
            }
        } finally {
            if (session.speaking === speaking) session.speaking = null;
            await this._pumpSpeech(session);
        }
    }

    /**
     * Barge-in: kill the in-flight persona speech and drop the queued
     * rest. The turn's TEXT keeps generating and landing in the transcript
     * - only the audio is interrupted (the realtime engine's rule).
     */
    _bargeIn(session, reason) {
        if (!session.speaking && session.speechQueue.length === 0) return;
        session.speechQueue.length = 0;
        const speaking = session.speaking;
        if (speaking) {
            speaking.aborted = true;
            session.speaking = null;
            try { speaking.upstream?.destroy(); } catch { /* already gone */ }
            this._broadcast(session, 'speech_end', { streamId: speaking.streamId, interrupted: true });
            this._logger().log?.(`[ParlorLive] Barge-in (${reason}): stopping persona speech`);
        }
    }
}

module.exports = new ParlorLiveService();
module.exports.ParlorLiveService = ParlorLiveService;
module.exports.ParlorLiveError = ParlorLiveError;
