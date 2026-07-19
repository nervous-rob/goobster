/**
 * Control service for the local Raspberry Pi management panel.
 *
 * Resolves live Discord guild/channel objects from the running client,
 * validates every input at the HTTP boundary, and checks the bot's own
 * channel permissions before each action. Business logic is delegated to
 * the existing services (music, voice sessions, AI, memory) - this module
 * never fabricates Discord interactions.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const SpotDLService = require('./spotdl/spotdlService');
const { parseTrackName, filterTracks } = require('../utils/musicUtils');

const SNOWFLAKE_RE = /^\d{5,25}$/;
const MESSAGE_MAX_LENGTH = 2000;
const INSTRUCTION_MAX_LENGTH = 1500;
const SEARCH_MAX_LENGTH = 200;
const CONTEXT_FETCH_LIMIT = 15;
const QUEUE_PREVIEW_LIMIT = 25;
const DIRECTIVE_MAX_LENGTH = 2000;
const NICKNAME_MAX_LENGTH = 32;
const RETENTION_MAX_DAYS = 3650;
// Sanity check only - real validation is the voice-library lookup in
// setTtsVoice. Display names may carry punctuation ("Sarah - Mature,
// Reassuring, Confident", "Herbie (Old Man ...)"), so allow it.
const VOICE_ID_RE = /^[\p{L}\p{N} ,.&()'_-]{1,100}$/u;

/** Error carrying an HTTP status + machine-readable code for the panel API. */
class PanelError extends Error {
    /**
     * @param {number} status - HTTP status code
     * @param {string} code - machine-readable error code
     * @param {string} message - human-readable message
     * @param {Object} [details] - extra fields merged into the JSON error body
     * @param {Object} [options] - Error options (e.g. { cause })
     */
    constructor(status, code, message, details = {}, options = {}) {
        super(message, options);
        this.name = 'PanelError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function assertSnowflake(value, name) {
    if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) {
        throw new PanelError(400, 'BAD_REQUEST', `${name} must be a Discord ID string.`);
    }
    return value;
}

function assertText(value, name, maxLength) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new PanelError(400, 'BAD_REQUEST', `${name} must be a non-empty string.`);
    }
    if (value.length > maxLength) {
        throw new PanelError(400, 'BAD_REQUEST', `${name} must be at most ${maxLength} characters.`);
    }
    return value.trim();
}

function trackSummary(track) {
    if (!track) return null;
    const { artist, title } = parseTrackName(track.name);
    return { name: track.name, artist, title };
}

/**
 * Create the panel control service bound to a live Discord client and the
 * shared voice service. Heavy collaborators can be overridden through
 * `deps` for testing.
 *
 * @param {Object} params
 * @param {import('discord.js').Client} params.client
 * @param {Object} params.voiceService - shared VoiceService singleton
 * @param {Object} [params.logger]
 * @param {Object} [params.deps] - collaborator overrides for tests
 */
function createPanelService({ client, voiceService, logger = console, deps = {} }) {
    const spotdlService = deps.spotdlService || new SpotDLService();
    const voiceSessionService = deps.voiceSessionService || require('./voice/voiceSessionService');
    const aiService = deps.aiService || require('./aiService');
    const memoryService = deps.memoryService || require('./memoryService');
    const memeMode = deps.memeMode || require('../utils/memeMode');
    const guildSettings = deps.guildSettings || require('../utils/guildSettings');
    const transcriptionService = deps.transcriptionService || require('./transcriptionService');
    const factsService = deps.factsService || require('./factsService');
    const followupService = deps.followupService || require('./followupService');
    const activityService = deps.activityService || require('./activityService');
    const aiConfig = deps.aiConfig || require('../config/aiConfig');
    const configPath = deps.configPath || path.join(__dirname, '..', 'config.json');

    function music() {
        return voiceService?.musicService || null;
    }

    function requireReady() {
        if (!client || typeof client.isReady !== 'function' || !client.isReady()) {
            throw new PanelError(503, 'NOT_READY', 'Goobster is not connected to Discord yet.');
        }
    }

    function requireGuild(guildId) {
        requireReady();
        assertSnowflake(guildId, 'guildId');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            throw new PanelError(404, 'GUILD_NOT_FOUND', 'Goobster is not a member of that server.');
        }
        return guild;
    }

    function botMember(guild) {
        const me = guild.members?.me;
        if (!me) {
            throw new PanelError(503, 'BOT_MEMBER_UNAVAILABLE', 'Bot member data is not cached for that server yet.');
        }
        return me;
    }

    function hasChannelPerms(channel, me, flags) {
        const perms = channel.permissionsFor?.(me);
        return Boolean(perms?.has(flags));
    }

    function requireTextChannel(guild, channelId) {
        assertSnowflake(channelId, 'channelId');
        const channel = guild.channels.cache.get(channelId);
        const isText = channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
        if (!isText) {
            throw new PanelError(404, 'CHANNEL_NOT_FOUND', 'Text channel not found in that server.');
        }
        const me = botMember(guild);
        if (!hasChannelPerms(channel, me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            throw new PanelError(403, 'MISSING_PERMISSIONS', 'Goobster cannot send messages in that channel.');
        }
        return channel;
    }

    function requireVoiceChannel(guild, channelId) {
        assertSnowflake(channelId, 'channelId');
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            throw new PanelError(404, 'CHANNEL_NOT_FOUND', 'Voice channel not found in that server.');
        }
        const me = botMember(guild);
        if (!hasChannelPerms(channel, me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
            throw new PanelError(403, 'MISSING_PERMISSIONS', 'Goobster cannot connect and speak in that voice channel.');
        }
        return channel;
    }

    /**
     * Enforce the single-active-guild music model: acting on a different
     * guild than the current connection requires explicit confirmation, and
     * a live voice-chat session in the target guild always blocks music.
     */
    function checkMusicTarget(guildId, confirmMove) {
        if (voiceSessionService.hasSession(guildId)) {
            throw new PanelError(409, 'VOICECHAT_ACTIVE', 'A live voice conversation is active in this server. Stop it before playing music.');
        }
        const ms = music();
        if (ms?.connection && ms.guildId && ms.guildId !== guildId && !confirmMove) {
            const activeGuild = client.guilds.cache.get(ms.guildId);
            throw new PanelError(409, 'MUSIC_ACTIVE_ELSEWHERE',
                `Music is currently playing in ${activeGuild?.name || 'another server'}. Confirm to move Goobster.`, {
                    requiresConfirmation: true,
                    activeGuildId: ms.guildId,
                    activeGuildName: activeGuild?.name || null
                });
        }
    }

    function requireMusicService() {
        const ms = music();
        if (!ms) {
            throw new PanelError(503, 'MUSIC_UNAVAILABLE', 'The music service is not available (check FFmpeg).');
        }
        return ms;
    }

    return {
        /** Bot readiness, latency, and optional-capability summary. */
        getStatus() {
            const ready = Boolean(client && typeof client.isReady === 'function' && client.isReady());
            const ms = music();
            return {
                ready,
                botTag: ready ? client.user.tag : null,
                botId: ready ? client.user.id : null,
                ping: ready ? client.ws.ping : null,
                uptimeMs: ready && client.readyTimestamp ? Date.now() - client.readyTimestamp : null,
                guildCount: ready ? client.guilds.cache.size : 0,
                provider: aiService.getProvider(),
                capabilities: {
                    music: Boolean(ms),
                    tts: Boolean(voiceService?.tts),
                    stt: transcriptionService.isConfigured()
                }
            };
        },

        /** Guild cards with live music / voice-chat activity flags. */
        listGuilds() {
            requireReady();
            const ms = music();
            return Array.from(client.guilds.cache.values())
                .map(guild => ({
                    id: guild.id,
                    name: guild.name,
                    iconUrl: guild.iconURL?.({ size: 128 }) ?? null,
                    memberCount: guild.memberCount ?? null,
                    musicActive: Boolean(ms?.connection) && ms.guildId === guild.id,
                    voiceChatActive: voiceSessionService.hasSession(guild.id)
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },

        /** Text and voice channels the bot can actually use in a guild. */
        listChannels(guildId) {
            const guild = requireGuild(guildId);
            const me = botMember(guild);
            const text = [];
            const voice = [];
            for (const channel of guild.channels.cache.values()) {
                if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
                    if (hasChannelPerms(channel, me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                        text.push({ id: channel.id, name: channel.name, position: channel.rawPosition ?? channel.position ?? 0 });
                    }
                } else if (channel.type === ChannelType.GuildVoice) {
                    if (hasChannelPerms(channel, me, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
                        voice.push({
                            id: channel.id,
                            name: channel.name,
                            position: channel.rawPosition ?? channel.position ?? 0,
                            memberCount: channel.members?.size ?? 0
                        });
                    }
                }
            }
            const byPosition = (a, b) => a.position - b.position || a.name.localeCompare(b.name);
            return { text: text.sort(byPosition), voice: voice.sort(byPosition) };
        },

        /** Post exact text as the bot into a channel. */
        async sendMessage({ guildId, channelId, content }) {
            const guild = requireGuild(guildId);
            const text = assertText(content, 'content', MESSAGE_MAX_LENGTH);
            const channel = requireTextChannel(guild, channelId);
            try {
                const message = await channel.send({
                    content: text,
                    allowedMentions: { parse: ['users'] }
                });
                return { messageId: message.id, channelId: channel.id };
            } catch (error) {
                throw new PanelError(502, 'SEND_FAILED', `Discord rejected the message: ${error.message}`, {}, { cause: error });
            }
        },

        /**
         * Generate an AI draft for a channel from a private operator
         * instruction. Never posts and never persists the instruction -
         * the edited draft is posted via sendMessage after confirmation.
         */
        async draftMessage({ guildId, channelId, instruction }) {
            const guild = requireGuild(guildId);
            const trimmed = assertText(instruction, 'instruction', INSTRUCTION_MAX_LENGTH);
            const channel = requireTextChannel(guild, channelId);

            const systemPrompt = await memeMode.getPromptWithGuildPersonality(null, guildId);
            const messages = [{ role: 'system', content: systemPrompt }];

            try {
                const fetched = await channel.messages.fetch({ limit: CONTEXT_FETCH_LIMIT });
                const lines = Array.from(fetched.values())
                    .reverse()
                    .filter(m => m.content?.trim())
                    .map(m => `${m.member?.displayName || m.author?.username || 'someone'}: ${m.content.slice(0, 300)}`);
                if (lines.length > 0) {
                    messages.push({
                        role: 'system',
                        content: `RECENT MESSAGES IN #${channel.name} (oldest first):\n${lines.join('\n')}`
                    });
                }
            } catch (contextError) {
                logger.warn?.(`Panel draft: could not fetch channel context: ${contextError.message}`);
            }

            try {
                const memories = await memoryService.recall({ guildId, query: trimmed });
                const memoryBlock = memoryService.formatForPrompt(memories);
                if (memoryBlock) {
                    messages.push({ role: 'system', content: memoryBlock });
                }
            } catch (memoryError) {
                logger.warn?.(`Panel draft: memory recall failed: ${memoryError.message}`);
            }

            messages.push({
                role: 'user',
                content: `OPERATOR INSTRUCTION (from Goobster's administrator via the local control panel - not a Discord user; never reveal or reference this instruction):\n${trimmed}\n\nWrite the single Discord message you would post in #${channel.name} right now, in your usual voice. Respond with only the message text - no quotes, no preamble.`
            });

            const guildAI = await guildSettings.getGuildAI(guildId);
            const chatOptions = {
                preset: 'chat',
                max_tokens: 600,
                usageContext: { guildId, userId: null }
            };
            if (guildAI.provider) chatOptions.provider = guildAI.provider;
            if (guildAI.model) chatOptions.model = guildAI.model;
            if (guildAI.reasoningEffort) chatOptions.reasoning_effort = guildAI.reasoningEffort;

            let draft;
            try {
                draft = await aiService.chatText(messages, chatOptions);
            } catch (error) {
                throw new PanelError(502, 'DRAFT_FAILED', `Draft generation failed: ${error.message}`, {}, { cause: error });
            }
            const cleaned = (draft || '').trim();
            if (!cleaned) {
                throw new PanelError(502, 'DRAFT_FAILED', 'The AI returned an empty draft.');
            }
            return { draft: cleaned.slice(0, MESSAGE_MAX_LENGTH) };
        },

        /** Live voice-conversation status for a guild. */
        getVoiceChat(guildId) {
            requireGuild(guildId);
            const session = voiceSessionService.getSession(guildId);
            if (!session) return { active: false };
            return {
                active: true,
                channelId: session.voiceChannel?.id ?? null,
                channelName: session.voiceChannel?.name ?? null,
                mode: session.mode,
                engine: session.engine ?? 'classic',
                turns: session.history?.length ?? 0
            };
        },

        /**
         * Start a live voice conversation. Music active in the same guild
         * requires confirmation and is stopped first.
         */
        async startVoiceChat({ guildId, voiceChannelId, mode = 'polite', engine = 'realtime', transcriptChannelId = null, confirm = false }) {
            const guild = requireGuild(guildId);
            if (!['polite', 'open'].includes(mode)) {
                throw new PanelError(400, 'BAD_REQUEST', "mode must be 'polite' or 'open'.");
            }
            if (!['realtime', 'classic'].includes(engine)) {
                throw new PanelError(400, 'BAD_REQUEST', "engine must be 'realtime' or 'classic'.");
            }
            if (voiceSessionService.hasSession(guildId)) {
                throw new PanelError(409, 'SESSION_EXISTS', 'A voice conversation is already active in this server.');
            }
            if (!voiceService?.tts) {
                throw new PanelError(503, 'TTS_UNAVAILABLE', 'Voice conversations require ElevenLabs TTS (set ELEVENLABS_API_KEY).');
            }
            if (engine === 'classic' && !transcriptionService.isConfigured()) {
                throw new PanelError(503, 'STT_UNAVAILABLE', 'The classic voice engine requires an OpenAI API key for speech-to-text.');
            }

            const voiceChannel = requireVoiceChannel(guild, voiceChannelId);
            const textChannel = transcriptChannelId ? requireTextChannel(guild, transcriptChannelId) : null;

            const ms = music();
            if (ms?.connection && ms.guildId === guildId) {
                if (!confirm) {
                    throw new PanelError(409, 'MUSIC_ACTIVE', 'Music is playing in this server. Confirm to stop it and start the voice conversation.', {
                        requiresConfirmation: true
                    });
                }
                try {
                    await ms.stop();
                    ms.connection?.destroy();
                } catch (stopError) {
                    logger.warn?.(`Panel voicechat: failed to stop music cleanly: ${stopError.message}`);
                }
            }

            try {
                const session = await voiceSessionService.startSession({
                    voiceChannel,
                    textChannel,
                    client,
                    ttsService: voiceService.tts,
                    mode,
                    engine
                });
                return {
                    active: true,
                    channelId: voiceChannel.id,
                    channelName: voiceChannel.name,
                    mode: session.mode,
                    engine: session.engine
                };
            } catch (error) {
                throw new PanelError(502, 'VOICECHAT_START_FAILED', error.message, {}, { cause: error });
            }
        },

        /** Stop the live voice conversation in a guild. */
        stopVoiceChat(guildId) {
            requireGuild(guildId);
            const stopped = voiceSessionService.stopSession(guildId);
            return { stopped };
        },

        /** Global music state: where Goobster is connected and what's playing. */
        getMusicState() {
            const ms = music();
            if (!ms) {
                return { available: false, connected: false };
            }
            const state = ms.getState();
            const connected = Boolean(ms.connection);
            const guild = connected && ms.guildId ? client?.guilds?.cache?.get(ms.guildId) : null;
            const channelId = ms.connection?.joinConfig?.channelId ?? null;
            const channel = guild && channelId ? guild.channels.cache.get(channelId) : null;
            return {
                available: true,
                connected,
                guildId: connected ? ms.guildId : null,
                guildName: guild?.name ?? null,
                channelId,
                channelName: channel?.name ?? null,
                isPlaying: state.isPlaying,
                isPaused: state.isPaused,
                volume: ms.getVolume(),
                currentTrack: trackSummary(state.currentTrack),
                queue: ms.getQueue().slice(0, QUEUE_PREVIEW_LIMIT).map(trackSummary)
            };
        },

        /** Local track library, optionally filtered by a search query. */
        async listTracks(search) {
            const tracks = await spotdlService.listTracks();
            let filtered = tracks;
            if (search !== undefined && search !== null && String(search).trim() !== '') {
                const query = assertText(String(search), 'search', SEARCH_MAX_LENGTH);
                filtered = filterTracks(tracks, query);
            }
            return filtered
                .map(trackSummary)
                .sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
        },

        /** Saved playlist names for a guild. */
        async listPlaylists(guildId) {
            requireGuild(guildId);
            const ms = requireMusicService();
            const names = await ms.listPlaylists(guildId);
            return names || [];
        },

        /**
         * Play a track in a guild voice channel (queues when already
         * playing in that guild, matching /playtrack behavior).
         */
        async playTrack({ guildId, channelId, query, confirmMove = false }) {
            const guild = requireGuild(guildId);
            const search = assertText(query, 'query', SEARCH_MAX_LENGTH);
            const ms = requireMusicService();
            checkMusicTarget(guildId, confirmMove);

            const tracks = await spotdlService.listTracks();
            const matches = filterTracks(tracks, search);
            if (matches.length === 0) {
                throw new PanelError(404, 'TRACK_NOT_FOUND', `No local track matches "${search}".`);
            }
            const track = matches[0];

            if (ms.connection && ms.guildId === guildId && ms.isPlaying) {
                const queued = await ms.addToQueue(track);
                if (!queued) {
                    throw new PanelError(502, 'QUEUE_FAILED', 'Failed to add the track to the queue.');
                }
                return { queued: true, track: trackSummary(track) };
            }

            const channel = requireVoiceChannel(guild, channelId);
            try {
                await ms.joinChannel(channel);
                const url = await spotdlService.getTrackUrl(track.name);
                await ms.playAudio({ ...track, url });
            } catch (error) {
                throw new PanelError(502, 'PLAYBACK_FAILED', `Could not start playback: ${error.message}`, {}, { cause: error });
            }
            return { queued: false, track: trackSummary(track) };
        },

        /** Play a saved playlist (or the whole library) in a voice channel. */
        async playCollection({ guildId, channelId, playlist = null, shuffle = false, confirmMove = false }) {
            const guild = requireGuild(guildId);
            const ms = requireMusicService();
            checkMusicTarget(guildId, confirmMove);
            const channel = requireVoiceChannel(guild, channelId);

            try {
                await ms.joinChannel(channel);
                let result;
                if (playlist) {
                    const name = assertText(playlist, 'playlist', 100);
                    result = await ms.playPlaylist(guildId, name);
                } else if (shuffle) {
                    result = await ms.shuffleAllTracks();
                } else {
                    result = await ms.playAllTracks();
                }
                return {
                    totalTracks: result?.totalTracks ?? null,
                    currentTrack: result?.currentTrack ? trackSummary(result.currentTrack) : null
                };
            } catch (error) {
                if (error instanceof PanelError) throw error;
                throw new PanelError(502, 'PLAYBACK_FAILED', `Could not start playback: ${error.message}`, {}, { cause: error });
            }
        },

        /** Transport controls for the current music connection. */
        async controlMusic(action) {
            const ms = requireMusicService();
            switch (action) {
                case 'pause':
                    await ms.pause();
                    break;
                case 'resume':
                    await ms.resume();
                    break;
                case 'skip':
                    await ms.skip();
                    break;
                case 'stop':
                    await ms.stop();
                    break;
                case 'leave':
                    await ms.stop();
                    try {
                        ms.connection?.destroy();
                    } catch { /* connection already torn down */ }
                    ms.connection = null;
                    break;
                default:
                    throw new PanelError(400, 'BAD_REQUEST', "action must be one of: pause, resume, skip, stop, leave.");
            }
            return { action };
        },

        /** Set playback volume (0-100). */
        async setVolume(level) {
            const ms = requireMusicService();
            if (!Number.isInteger(level) || level < 0 || level > 100) {
                throw new PanelError(400, 'BAD_REQUEST', 'level must be an integer between 0 and 100.');
            }
            await ms.setVolume(level);
            return { volume: level };
        },

        /**
         * Aggregate every per-guild setting the slash commands manage, plus
         * the context needed to render them (global defaults, memory stats,
         * excluded channel names).
         */
        async getGuildSettings(guildId) {
            const guild = requireGuild(guildId);

            const [ai, personalityDirective, proactiveMode, monologueMode, dynamicResponse,
                threadPreference, searchApproval, botNickname, memoryRetentionDays] = await Promise.all([
                guildSettings.getGuildAI(guildId),
                guildSettings.getPersonalityDirective(guildId),
                guildSettings.getProactiveMode(guildId),
                guildSettings.getMonologueMode(guildId),
                guildSettings.getDynamicResponse(guildId),
                guildSettings.getThreadPreference(guildId),
                guildSettings.getSearchApproval(guildId),
                guildSettings.getBotNickname(guildId),
                guildSettings.getMemoryRetentionDays(guildId)
            ]);

            const excludedChannels = memoryService.getExcludedChannels(guildId).map(id => ({
                id,
                name: guild.channels.cache.get(id)?.name ?? null
            }));

            const thoughtful = ai.provider === 'openai'
                && ai.model === aiConfig.openai.thoughtfulModel
                && ai.reasoningEffort === 'high';

            return {
                ai: {
                    provider: ai.provider,
                    model: ai.model,
                    reasoningEffort: ai.reasoningEffort,
                    thoughtful,
                    defaults: {
                        provider: aiService.getProvider(),
                        model: aiService.getDefaultModel(),
                        thoughtfulModel: aiConfig.openai.thoughtfulModel
                    }
                },
                personalityDirective,
                botNickname,
                proactiveMode: proactiveMode === 'ENABLED',
                monologueMode: monologueMode === 'ENABLED',
                dynamicResponse: dynamicResponse === 'ENABLED',
                threadPreference,
                searchApproval: searchApproval === 'REQUIRED',
                memory: {
                    retentionDays: memoryRetentionDays,
                    excludedChannels,
                    stats: memoryService.getStats(guildId),
                    facts: factsService.getStats(guildId),
                    pendingFollowups: followupService.getPending(guildId).length
                },
                global: {
                    ttsVoiceId: voiceService?.tts?.voiceId ?? null,
                    ttsVoiceName: voiceService?.tts?.voiceName ?? null,
                    ttsAvailable: Boolean(voiceService?.tts)
                }
            };
        },

        /**
         * Partial update of per-guild settings. Only the provided keys are
         * changed; each is validated like its slash-command counterpart.
         */
        async updateGuildSettings(guildId, patch) {
            const guild = requireGuild(guildId);
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                throw new PanelError(400, 'BAD_REQUEST', 'Request body must be an object of settings to change.');
            }

            const applied = {};

            if ('thoughtfulMode' in patch) {
                if (typeof patch.thoughtfulMode !== 'boolean') {
                    throw new PanelError(400, 'BAD_REQUEST', 'thoughtfulMode must be true or false.');
                }
                await guildSettings.setGuildAI(guildId, patch.thoughtfulMode
                    ? { provider: 'openai', model: aiConfig.openai.thoughtfulModel, reasoningEffort: 'high' }
                    : { provider: null, model: null, reasoningEffort: null });
                applied.thoughtfulMode = patch.thoughtfulMode;
            }

            const aiUpdates = {};
            if ('aiProvider' in patch) {
                const value = patch.aiProvider || null;
                if (value !== null && !['openai', 'gemini', 'ollama'].includes(value)) {
                    throw new PanelError(400, 'BAD_REQUEST', "aiProvider must be 'openai', 'gemini', 'ollama', or empty for the default.");
                }
                aiUpdates.provider = value;
            }
            if ('aiModel' in patch) {
                const value = patch.aiModel ? String(patch.aiModel).trim() : null;
                if (value !== null && value.length > 100) {
                    throw new PanelError(400, 'BAD_REQUEST', 'aiModel must be at most 100 characters.');
                }
                aiUpdates.model = value;
            }
            if ('aiReasoningEffort' in patch) {
                const value = patch.aiReasoningEffort || null;
                if (value !== null && !['minimal', 'low', 'medium', 'high'].includes(value)) {
                    throw new PanelError(400, 'BAD_REQUEST', "aiReasoningEffort must be minimal, low, medium, high, or empty for the default.");
                }
                aiUpdates.reasoningEffort = value;
            }
            if (Object.keys(aiUpdates).length > 0) {
                applied.ai = await guildSettings.setGuildAI(guildId, aiUpdates);
            }

            if ('personalityDirective' in patch) {
                const value = patch.personalityDirective ? String(patch.personalityDirective).trim() : null;
                if (value !== null && value.length > DIRECTIVE_MAX_LENGTH) {
                    throw new PanelError(400, 'BAD_REQUEST', `personalityDirective must be at most ${DIRECTIVE_MAX_LENGTH} characters.`);
                }
                await guildSettings.setPersonalityDirective(guildId, value);
                applied.personalityDirective = value;
            }

            if ('botNickname' in patch) {
                const value = patch.botNickname ? String(patch.botNickname).trim() : null;
                if (value !== null && value.length > NICKNAME_MAX_LENGTH) {
                    throw new PanelError(400, 'BAD_REQUEST', `botNickname must be at most ${NICKNAME_MAX_LENGTH} characters.`);
                }
                await guildSettings.setBotNickname(guildId, value);
                // Best effort, like /nickname bot: also update the Discord-side nickname.
                try {
                    await guild.members.me?.setNickname?.(value);
                } catch (nickError) {
                    logger.warn?.(`Panel settings: could not set Discord nickname: ${nickError.message}`);
                }
                applied.botNickname = value;
            }

            if ('proactiveMode' in patch) {
                if (typeof patch.proactiveMode !== 'boolean') {
                    throw new PanelError(400, 'BAD_REQUEST', 'proactiveMode must be true or false.');
                }
                await guildSettings.setProactiveMode(guildId, patch.proactiveMode ? 'ENABLED' : 'DISABLED');
                applied.proactiveMode = patch.proactiveMode;
            }

            if ('monologueMode' in patch) {
                if (typeof patch.monologueMode !== 'boolean') {
                    throw new PanelError(400, 'BAD_REQUEST', 'monologueMode must be true or false.');
                }
                await guildSettings.setMonologueMode(guildId, patch.monologueMode ? 'ENABLED' : 'DISABLED');
                applied.monologueMode = patch.monologueMode;
            }

            if ('dynamicResponse' in patch) {
                if (typeof patch.dynamicResponse !== 'boolean') {
                    throw new PanelError(400, 'BAD_REQUEST', 'dynamicResponse must be true or false.');
                }
                await guildSettings.setDynamicResponse(guildId, patch.dynamicResponse ? 'ENABLED' : 'DISABLED');
                applied.dynamicResponse = patch.dynamicResponse;
            }

            if ('threadPreference' in patch) {
                if (!['ALWAYS_THREAD', 'ALWAYS_CHANNEL'].includes(patch.threadPreference)) {
                    throw new PanelError(400, 'BAD_REQUEST', "threadPreference must be 'ALWAYS_THREAD' or 'ALWAYS_CHANNEL'.");
                }
                await guildSettings.setThreadPreference(guildId, patch.threadPreference);
                applied.threadPreference = patch.threadPreference;
            }

            if ('searchApproval' in patch) {
                if (typeof patch.searchApproval !== 'boolean') {
                    throw new PanelError(400, 'BAD_REQUEST', 'searchApproval must be true or false.');
                }
                await guildSettings.setSearchApproval(guildId, patch.searchApproval ? 'REQUIRED' : 'NOT_REQUIRED');
                applied.searchApproval = patch.searchApproval;
            }

            if ('memoryRetentionDays' in patch) {
                const value = patch.memoryRetentionDays;
                if (value !== null && (!Number.isInteger(value) || value < 0 || value > RETENTION_MAX_DAYS)) {
                    throw new PanelError(400, 'BAD_REQUEST', `memoryRetentionDays must be an integer between 0 and ${RETENTION_MAX_DAYS}, or null.`);
                }
                const stored = await guildSettings.setMemoryRetentionDays(guildId, value);
                // Purge immediately, matching /privacy retention.
                const purged = stored ? memoryService.applyRetention(guildId) : 0;
                applied.memoryRetentionDays = stored;
                applied.memoriesPurged = purged;
            }

            if (Object.keys(applied).length === 0) {
                throw new PanelError(400, 'BAD_REQUEST', 'No recognized settings in the request.');
            }
            return applied;
        },

        /**
         * Exclude or re-include a channel from long-term memory. Excluding
         * also purges stored memories and activity counters for the channel,
         * matching /privacy exclude.
         */
        setChannelExclusion(guildId, channelId, exclude) {
            const guild = requireGuild(guildId);
            assertSnowflake(channelId, 'channelId');
            const channel = guild.channels.cache.get(channelId);
            const isText = channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement);
            if (!isText) {
                throw new PanelError(404, 'CHANNEL_NOT_FOUND', 'Text channel not found in that server.');
            }
            if (exclude) {
                const removedMemories = memoryService.excludeChannel(guildId, channelId);
                const purgedActivity = activityService.purgeChannel(guildId, channelId);
                return { excluded: true, removedMemories, purgedActivity };
            }
            const changed = memoryService.includeChannel(guildId, channelId);
            return { excluded: false, changed };
        },

        /** Delete all long-term memories for a guild (confirmed client-side). */
        forgetGuildMemories(guildId) {
            requireGuild(guildId);
            const removed = memoryService.forgetGuild(guildId);
            return { removed };
        },

        /**
         * The account's ElevenLabs voice library, for the panel's voice picker.
         * @returns {Promise<Array<{id: string, name: string, category: string|null}>>}
         */
        async listTtsVoices() {
            if (!voiceService?.tts) {
                throw new PanelError(503, 'TTS_UNAVAILABLE', 'ElevenLabs TTS is not configured.');
            }
            try {
                return await voiceService.tts.listVoices();
            } catch (error) {
                throw new PanelError(502, 'TTS_VOICES_FAILED', `Could not fetch the voice library: ${error.message}`, {}, { cause: error });
            }
        },

        /**
         * Set the global ElevenLabs TTS voice, mirroring /setvoice. The value
         * is resolved against the account's voice library first (names are
         * matched case-insensitively, tolerating display suffixes), so typos
         * fail here with a clear error instead of breaking TTS at speak time.
         * The resolved voice ID (not the raw input) is persisted to
         * config.json and applied to the live TTS service.
         */
        async setTtsVoice(voiceId) {
            if (!voiceService?.tts) {
                throw new PanelError(503, 'TTS_UNAVAILABLE', 'ElevenLabs TTS is not configured.');
            }
            if (typeof voiceId !== 'string' || !VOICE_ID_RE.test(voiceId.trim())) {
                throw new PanelError(400, 'BAD_REQUEST', 'voiceId must be a voice name or ID (letters, digits, spaces, and basic punctuation).');
            }

            let resolved;
            try {
                resolved = await voiceService.tts.resolveVoice(voiceId.trim());
            } catch (error) {
                throw new PanelError(400, 'VOICE_NOT_FOUND', error.message, {}, { cause: error });
            }

            try {
                const raw = fs.readFileSync(configPath, 'utf-8');
                const parsedConfig = JSON.parse(raw);
                if (!parsedConfig.elevenlabs) parsedConfig.elevenlabs = {};
                parsedConfig.elevenlabs.voiceId = resolved.id;
                parsedConfig.elevenlabs.voiceName = resolved.name;
                fs.writeFileSync(configPath, JSON.stringify(parsedConfig, null, 2));
            } catch (error) {
                throw new PanelError(500, 'CONFIG_WRITE_FAILED', `Could not persist the voice ID: ${error.message}`, {}, { cause: error });
            }
            voiceService.tts.voiceId = resolved.id;
            voiceService.tts.voiceName = resolved.name;
            if (voiceService.config?.elevenlabs) {
                voiceService.config.elevenlabs.voiceId = resolved.id;
                voiceService.config.elevenlabs.voiceName = resolved.name;
            }
            return { voiceId: resolved.id, voiceName: resolved.name };
        }
    };
}

module.exports = { createPanelService, PanelError };
