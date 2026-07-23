const aiService = require('../aiService');
const toolsRegistry = require('../../utils/toolsRegistry');
const { playToolCue, playErrorCue } = require('./notificationSounds');

// Conversation turns kept per session
const HISTORY_LIMIT = 12;
// In polite mode, a turn within this window after Goobster finished speaking
// is treated as a follow-up addressed to him (no name needed).
const FOLLOWUP_WINDOW_MS = 25000;
// Max chat rounds per turn: tool calls consume rounds, the last round must
// produce the spoken reply (mirrors the text-chat loop in chatHandler).
const MAX_CHAT_ROUNDS = 3;

// Tools exposed to the model during voice turns. Deliberately a subset of the
// full registry: playTrack would tear down the session's own voice connection,
// and speakMessage/echoMessage are redundant when every reply is already spoken.
const VOICE_TOOL_NAMES = [
    'performSearch', 'setNickname', 'rememberFact', 'forgetFact',
    // Economy: gambling and the stock trading game are fully voice-operable
    'checkPoints', 'gamblePoints', 'stockQuote', 'tradeStock', 'checkPortfolio'
];
// These tools post to / reference a text channel, so they are only offered
// when the session has a transcript text channel to deliver into.
const TEXT_CHANNEL_TOOL_NAMES = ['generateImage', 'scheduleFollowUp'];

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

/**
 * Execute the tool calls requested by the model and append their results
 * to the model conversation (same shape the text-chat loop uses).
 */
async function executeToolCalls(session, toolCalls, messagesForModel, toolContext) {
    // Audible cue: he's off doing something (searching, trading, ...) rather
    // than ignoring the channel. One cue per round, fire-and-forget.
    playToolCue(session.connection);
    let errorCuePlayed = false;

    for (const call of toolCalls) {
        let fnResult;
        try {
            const parsedArgs = JSON.parse(call.arguments || '{}');
            parsedArgs.interactionContext = toolContext.context;
            toolContext.captured.length = 0;
            fnResult = await toolsRegistry.execute(call.name, parsedArgs);

            if (fnResult && typeof fnResult === 'object' && fnResult._display && fnResult._data) {
                fnResult = fnResult._display;
            }
            // Wrapped commands report their real outcome via reply();
            // surface it so the model doesn't announce false successes.
            if (toolContext.captured.length > 0) {
                fnResult = `${typeof fnResult === 'string' ? fnResult : JSON.stringify(fnResult)}\n${toolContext.captured.join('\n')}`;
            }
            console.log(`[VoiceSession] Tool ${call.name} executed`);
        } catch (toolError) {
            console.error(`[VoiceSession] Tool ${call.name} failed:`, toolError.message);
            fnResult = `Error executing tool ${call.name}: ${toolError.message}`;
            // Audible cue: the action failed (once per round, fire-and-forget)
            if (!errorCuePlayed) {
                errorCuePlayed = true;
                playErrorCue(session.connection);
            }
        }

        messagesForModel.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: typeof fnResult === 'string' ? fnResult : JSON.stringify(fnResult)
        });
    }
}

module.exports = {
    HISTORY_LIMIT,
    FOLLOWUP_WINDOW_MS,
    MAX_CHAT_ROUNDS,
    VOICE_TOOL_NAMES,
    TEXT_CHANNEL_TOOL_NAMES,
    getVoiceToolNames,
    shouldRespond,
    buildToolContext,
    executeToolCalls
};
