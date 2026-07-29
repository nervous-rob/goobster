const aiService = require('../aiService');
const toolsRegistry = require('../../utils/toolsRegistry');
const { playToolCue, playErrorCue } = require('./notificationSounds');

// Conversation turns kept per session
const HISTORY_LIMIT = 12;
// In polite mode, a turn within this window after Goobster finished speaking
// is treated as a follow-up addressed to him (no name needed).
const FOLLOWUP_WINDOW_MS = 25000;
// Tool rounds allowed per spoken turn (runAgentLoop budget). Smaller than the
// text-chat budget: every extra round is silence the listener sits through.
const VOICE_MAX_TOOL_ROUNDS = 3;

// Tools exposed to the model during voice turns. Deliberately a subset of the
// full registry: playTrack would tear down the session's own voice connection,
// and speakMessage/echoMessage are redundant when every reply is already spoken.
const VOICE_TOOL_NAMES = [
    'performSearch', 'setNickname', 'rememberFact', 'forgetFact',
    // Economy: gambling and the stock trading game are fully voice-operable
    'checkPoints', 'gamblePoints', 'stockQuote', 'tradeStock', 'checkPortfolio',
    // The exchange: the whole risk desk is operable by speaking, and the two
    // audit tools are read-only, so "how bad is my account" always has an answer
    'optionChain', 'tradeOption', 'shortStock', 'marginAccount', 'exchangeOrder',
    'eventContracts', 'auditAccount', 'auditExchange',
    // Tavern: read-only info and dice work anywhere by voice
    'tavernInfo', 'rollDice'
];
// These tools post to / reference a text channel, so they are only offered
// when the session has a transcript text channel to deliver into. The two
// integration tools post confirmation buttons there (never execute directly),
// so "launch an agent to fix that bug" works by voice with the same guardrails.
// The tavern play tools post party cards / scene outcomes into that channel.
const TEXT_CHANNEL_TOOL_NAMES = [
    'generateImage', 'scheduleFollowUp', 'launchCursorAgent', 'createGithubIssue',
    'tavernParty', 'tavernAct', 'tavernAttack', 'tavernTwist', 'tavernRecap'
];

/**
 * Tool names offered for a session (text-channel tools only with a transcript
 * channel to deliver into).
 */
function getVoiceToolNames(session) {
    return session.textChannel
        ? [...VOICE_TOOL_NAMES, ...TEXT_CHANNEL_TOOL_NAMES]
        : VOICE_TOOL_NAMES;
}

/**
 * The polite-mode address gate. Three tiers, cheapest first:
 * 1. Named: the turn mentions one of the bot's names.
 * 2. Follow-up: Goobster spoke recently, so this is likely a reply to him.
 * 3. Classifier: a tiny deterministic model call decides whether an
 *    unaddressed turn genuinely needs him (unanswered question, request
 *    he can fulfill). Errs on the side of silence.
 * @returns {Promise<{respond: boolean, reason: string}>}
 */
async function shouldRespond(session, turnText) {
    if (session.mode !== 'polite') {
        return { respond: true, reason: 'open mode' };
    }

    const lowered = turnText.toLowerCase();
    if (session.botNames?.some(name => lowered.includes(name))) {
        return { respond: true, reason: 'addressed by name' };
    }

    if (Date.now() - session.lastBotSpokeAt < FOLLOWUP_WINDOW_MS) {
        return { respond: true, reason: 'follow-up window' };
    }

    try {
        const recentHistory = session.history.slice(-4)
            .map(h => `${h.role === 'assistant' ? 'Goobster' : 'Users'}: ${h.content}`)
            .join('\n');

        const verdict = (await aiService.generateText(
            `Goobster is a voice assistant sitting in a Discord voice channel. He was NOT addressed by name in the latest turn, so he should usually stay silent - people are just talking to each other.

He should ONLY respond if the latest turn clearly needs him: a question asked to the room that nobody answered, an explicit request for something an assistant can do, or someone obviously trying to get his attention without using his name.

${recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : ''}Latest turn:\n${turnText}

Answer with ONLY one word: "respond" or "silent".`,
            {
                temperature: 0,
                max_tokens: 5,
                usageContext: { guildId: session.guildId }
            }
        )).trim().toLowerCase();

        if (verdict.startsWith('respond')) {
            return { respond: true, reason: 'classifier' };
        }
    } catch (error) {
        console.warn('[VoiceSession] Address classifier failed, staying silent:', error.message);
    }

    return { respond: false, reason: 'not addressed' };
}

/**
 * Build the interaction-like context handed to tools during a voice turn.
 * Tools written for slash commands expect a Discord interaction; this
 * stands in for one, attributing the turn to its most recent speaker and
 * capturing any reply() output (e.g. permission denials from wrapped
 * commands) so the model can voice the real outcome.
 * @returns {{context: object, captured: string[]}}
 */
function buildToolContext(session, segments) {
    const lastSpeaker = [...segments].reverse().find(s => s.member) || null;
    const member = lastSpeaker?.member || null;
    const captured = [];
    const record = (response) => {
        const content = typeof response === 'string' ? response : response?.content;
        if (content) captured.push(content);
    };

    return {
        captured,
        context: {
            guild: session.voiceChannel.guild,
            guildId: session.guildId,
            channel: session.textChannel || null,
            channelId: session.textChannel?.id || null,
            client: session.client,
            user: member?.user || null,
            member,
            isVoiceInteraction: true,
            deferReply: async () => {},
            reply: record,
            editReply: record,
            followUp: record
        }
    };
}

// At most this many live screen frames ride along on one voice turn (several
// paired speakers may have spoken; each frame is a full vision input).
const MAX_SCREEN_FRAMES_PER_TURN = 2;

/**
 * Screen context for a voice turn: for every distinct speaker in the turn,
 * pull a live frame from their screen-vision companion app (when paired and
 * connected) plus their Discord presence game metadata. Returns null when
 * there is nothing to add, otherwise:
 *   { images: [dataUrl], lines: [string], captures: [{ userId, userName, meta, presenceGame }] }
 * Never throws - screen context is always best-effort.
 */
async function buildScreenTurnContext(session, segments) {
    const screenVisionService = require('../screenVisionService');
    if (!screenVisionService.isEnabled()) return null;

    const images = [];
    const lines = [];
    const captures = [];
    const seen = new Set();

    for (const segment of segments) {
        if (!segment.userId || seen.has(segment.userId)) continue;
        seen.add(segment.userId);
        if (images.length >= MAX_SCREEN_FRAMES_PER_TURN
            && !screenVisionService.getPresenceGame(segment.member)) continue;
        try {
            const context = await screenVisionService.buildUserScreenContext({
                userId: segment.userId,
                userName: segment.speakerName,
                member: segment.member
            });
            if (!context) continue;
            if (context.frame && images.length < MAX_SCREEN_FRAMES_PER_TURN) {
                images.push(context.frame.dataUrl);
                captures.push({
                    userId: segment.userId,
                    userName: segment.speakerName,
                    meta: context.frame.meta,
                    presenceGame: context.presenceGame
                });
            }
            lines.push(context.line);
        } catch (error) {
            console.warn('[VoiceSession] Screen context failed:', error.message);
        }
    }

    if (lines.length === 0) return null;
    return { images, lines, captures };
}

/**
 * Prompt block for a turn's screen context, appended to the voice system
 * prompt so the model knows what the attached frames are and whose screens
 * they show.
 */
function formatScreenContextBlock(screenContext) {
    if (!screenContext) return '';
    return `\n\nLIVE SCREEN CONTEXT:\n${screenContext.lines.join('\n')}\nWhen the question relates to what's on screen, ground your answer in the attached screenshot and game metadata (combined with web search for game knowledge when useful).`;
}

/**
 * Persist small text summaries of screen-assisted turns to long-term memory
 * (fire-and-forget) so Goobster can refer back to them in later sessions.
 * Only turns where a frame was actually captured are recorded.
 */
function recordScreenMemories(session, screenContext, turnText) {
    if (!screenContext || screenContext.captures.length === 0) return;
    const screenVisionService = require('../screenVisionService');
    for (const capture of screenContext.captures) {
        screenVisionService.recordSessionMemory({
            guildId: session.guildId,
            channelId: session.textChannel?.id || null,
            userId: capture.userId,
            userName: capture.userName,
            meta: capture.meta,
            presenceGame: capture.presenceGame,
            question: turnText
        });
    }
}

/**
 * Build the voice-specific hooks for runAgentLoop (utils/chat/agentOrchestrator):
 * an executeTool wrapper that captures wrapped-command reply() output and
 * plays the audible cues, plus an onToolRound hook for the per-round
 * double-blip. Voice turns get the same guarantees as text chat (sequential
 * multi-step tool use, forced final answer) with voice ears.
 * @returns {{executeTool: function, onToolRound: function}}
 */
function createVoiceToolRunner(session, toolContext) {
    let errorCuePlayedThisRound = false;

    return {
        // Audible cue: he's off doing something (searching, trading, ...)
        // rather than ignoring the channel. One cue per round, fire-and-forget.
        onToolRound: () => {
            errorCuePlayedThisRound = false;
            playToolCue(session.connection);
        },

        executeTool: async (name, args) => {
            toolContext.captured.length = 0;
            try {
                let result = await toolsRegistry.execute(name, args);

                if (result && typeof result === 'object' && result._display && result._data) {
                    result = result._display;
                }
                // Wrapped commands report their real outcome via reply();
                // surface it so the model doesn't announce false successes.
                if (toolContext.captured.length > 0) {
                    result = `${typeof result === 'string' ? result : JSON.stringify(result)}\n${toolContext.captured.join('\n')}`;
                }
                console.log(`[VoiceSession] Tool ${name} executed`);
                return result;
            } catch (toolError) {
                console.error(`[VoiceSession] Tool ${name} failed:`, toolError.message);
                // Audible cue: the action failed (once per round); the error
                // itself goes back to the model as an observation to recover from.
                if (!errorCuePlayedThisRound) {
                    errorCuePlayedThisRound = true;
                    playErrorCue(session.connection);
                }
                throw toolError;
            }
        }
    };
}

module.exports = {
    HISTORY_LIMIT,
    FOLLOWUP_WINDOW_MS,
    VOICE_MAX_TOOL_ROUNDS,
    VOICE_TOOL_NAMES,
    TEXT_CHANNEL_TOOL_NAMES,
    getVoiceToolNames,
    shouldRespond,
    buildToolContext,
    buildScreenTurnContext,
    formatScreenContextBlock,
    recordScreenMemories,
    createVoiceToolRunner
};
