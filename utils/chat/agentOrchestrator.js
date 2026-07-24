/**
 * Agent orchestration loop for the chat pipeline.
 *
 * Implements the same pattern as LangChain's AgentExecutor natively over the
 * provider contract (see documentation/agent_orchestration.md for the design
 * rationale): the model plans its own steps by requesting tool calls, each
 * round's results are appended to the conversation before the next model
 * call (so step N can use the output of step N-1), and the loop is bounded.
 *
 * The termination rules guarantee the user always gets a real answer:
 *   1. Up to MAX_TOOL_ROUNDS rounds may request tools. Duplicate calls
 *      (same tool + same arguments within one turn) are served from a cache
 *      instead of re-executing, so a looping model burns no budget.
 *   2. When the budget is exhausted while the model still wants tools, a
 *      finalization round runs: a system nudge orders the model to answer
 *      from the results it already has, and any further tool requests are
 *      ignored rather than executed.
 *   3. If the final content is still empty but tools did run, the transcript
 *      itself is rendered into a readable digest - never the generic
 *      "I executed your request successfully..." apology.
 *
 * Tool failures become observations (the error text is fed back to the
 * model) so a failed step can be retried or worked around mid-turn instead
 * of aborting the whole reply.
 */
const aiService = require('../../services/aiService');
const toolsRegistry = require('../toolsRegistry');

// Model rounds that may request tools within a single reply. Each round can
// contain several parallel tool calls, so this bounds *sequential depth*
// (plan steps), not the total number of tool invocations.
const MAX_TOOL_ROUNDS = 6;

// Per-result cap when rendering the last-resort digest for the user.
const DIGEST_RESULT_CHARS = 700;

// Caps for the PRIOR TOOL RESULTS prompt block (per result / whole block).
const PRIOR_RESULT_CHARS = 1200;
const PRIOR_BLOCK_CHARS = 6000;

const FINALIZE_NUDGE =
    'TOOL BUDGET EXHAUSTED: You have used all tool calls available for this reply. ' +
    'Do NOT request any more tools. Write your final answer for the user now, in plain ' +
    'conversational language, using the tool results already gathered above. If some ' +
    'steps could not be completed, say what you found and what is still missing.';

const EMPTY_REPLY_NUDGE =
    'Your previous reply was empty. Write the final answer for the user now, in plain ' +
    'conversational language, summarizing the tool results gathered above. Do NOT request ' +
    'any more tools.';

/**
 * Execute one round of tool calls sequentially, appending each result to
 * messagesForModel before the next call executes.
 * @returns {Promise<void>}
 */
async function executeToolRound({ toolCalls, messagesForModel, transcript, resultCache, interactionContext, executeTool }) {
    for (const call of toolCalls) {
        const cacheKey = `${call.name}:${call.arguments || '{}'}`;
        let fnResult;
        let isError = false;

        if (resultCache.has(cacheKey)) {
            fnResult = `(cached) You already called ${call.name} with these arguments this turn. ` +
                `Previous result:\n${resultCache.get(cacheKey)}`;
        } else {
            try {
                const parsedArgs = JSON.parse(call.arguments || '{}');
                parsedArgs.interactionContext = interactionContext;
                fnResult = await executeTool(call.name, parsedArgs);

                // Some tools return { _display, _data }; the display form is
                // what belongs in the conversation.
                if (fnResult && typeof fnResult === 'object' && fnResult._display && fnResult._data) {
                    fnResult = fnResult._display;
                }
            } catch (toolErr) {
                console.error(`Tool execution error for ${call.name}:`, toolErr);
                isError = true;
                fnResult = `Error executing tool ${call.name}: ${toolErr.message}. ` +
                    'You may retry with corrected arguments, try a different tool, or explain the problem to the user.';
            }
        }

        const resultText = typeof fnResult === 'string' ? fnResult : JSON.stringify(fnResult);
        if (!isError && !resultCache.has(cacheKey)) {
            resultCache.set(cacheKey, resultText);
        }

        transcript.push({
            name: call.name,
            arguments: call.arguments || '{}',
            result: resultText,
            isError
        });

        messagesForModel.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: resultText
        });
    }
}

/**
 * Render the tool transcript into a readable reply. Last resort, used only
 * when the model produced no text even after the finalization nudge.
 * @param {Array<{name: string, result: string, isError: boolean}>} transcript
 * @returns {string}
 */
function buildTranscriptDigest(transcript) {
    const lines = transcript.map(entry => {
        const result = entry.result.length > DIGEST_RESULT_CHARS
            ? `${entry.result.slice(0, DIGEST_RESULT_CHARS)}…`
            : entry.result;
        return `${entry.isError ? '❌' : '✅'} **${entry.name}**\n${result}`;
    });
    return `I ran ${transcript.length} tool step${transcript.length === 1 ? '' : 's'} for you but had trouble ` +
        `writing a summary, so here are the raw results:\n\n${lines.join('\n\n')}`;
}

/**
 * Render transcripts from previous turns (chatDb.getRecentToolTranscripts)
 * into a system-prompt block, so follow-up questions can be answered from
 * data fetched a turn or two ago without re-running the tools.
 * @param {Array<{createdAt: string, tools: Array}>} transcripts - oldest first
 * @returns {string|null}
 */
function buildPriorToolContext(transcripts) {
    if (!Array.isArray(transcripts) || transcripts.length === 0) return null;

    const sections = [];
    let used = 0;
    // Newest transcripts are most relevant - fill the budget from the end.
    for (const transcript of [...transcripts].reverse()) {
        const lines = transcript.tools.map(tool => {
            const result = tool.result.length > PRIOR_RESULT_CHARS
                ? `${tool.result.slice(0, PRIOR_RESULT_CHARS)}…(truncated)`
                : tool.result;
            return `- ${tool.name}(${tool.arguments})${tool.isError ? ' [failed]' : ''}:\n${result}`;
        });
        const section = `From your reply at ${transcript.createdAt} UTC:\n${lines.join('\n')}`;
        if (used + section.length > PRIOR_BLOCK_CHARS && sections.length > 0) break;
        sections.unshift(section);
        used += section.length;
    }

    return 'PRIOR TOOL RESULTS (data you already retrieved earlier in this conversation):\n' +
        `${sections.join('\n\n')}\n` +
        'Use this data to answer follow-up questions. Only call the same tool again if the user needs fresher or different data.';
}

/**
 * Run the bounded agent loop until the model produces a user-facing reply.
 *
 * @param {Object} params
 * @param {Array} params.messages - initial conversation (system + history + user turn)
 * @param {Object} params.chatOptions - base aiService.chat options (preset, model,
 *   provider, max_tokens, webSearch, usageContext, ...). functions/onDelta are managed here.
 * @param {Array} params.functionDefs - tool definitions to offer ([] disables tools)
 * @param {Object} [params.interactionContext] - Discord interaction handed to tools
 * @param {function(string):void} [params.onDelta] - streaming text callback
 * @param {function(number):void} [params.onRoundStart] - called before each model round
 *   (reset stream buffers, refresh typing indicators)
 * @param {function(number, Array, string):void} [params.onToolRound] - called when the
 *   model requests tools, before they execute (round, toolCalls, roundContent); voice
 *   plays its tool cue here and speaks unstreamed filler text
 * @param {function():boolean} [params.shouldAbort] - polled around each model round;
 *   when true the loop stops immediately without finalization (e.g. voice barge-in)
 * @param {number} [params.maxToolRounds]
 * @param {function(string, Object):Promise<*>} [params.executeTool] - injectable tool
 *   executor (defaults to toolsRegistry.execute); exists for tests and reuse.
 * @returns {Promise<{content: string, toolTranscript: Array, roundsUsed: number, finalized: boolean, aborted: boolean}>}
 */
async function runAgentLoop({
    messages,
    chatOptions = {},
    functionDefs = [],
    interactionContext = null,
    onDelta = null,
    onRoundStart = null,
    onToolRound = null,
    shouldAbort = null,
    maxToolRounds = MAX_TOOL_ROUNDS,
    executeTool = (name, args) => toolsRegistry.execute(name, args)
}) {
    const messagesForModel = [...messages];
    const transcript = [];
    const resultCache = new Map();
    let roundsUsed = 0;
    let finalized = false;
    let aborted = false;
    let content = null;

    const callModel = async (round) => {
        if (typeof onRoundStart === 'function') {
            try { onRoundStart(round); } catch { /* cosmetic hooks never break the loop */ }
        }
        const options = { ...chatOptions };
        // Providers require the tool definitions whenever the history contains
        // tool calls (Anthropic rejects tool blocks without them), so they are
        // always declared; the finalization nudge stops further use instead.
        if (functionDefs.length > 0) {
            options.functions = functionDefs;
        }
        if (typeof onDelta === 'function') {
            options.onDelta = onDelta;
        }
        return aiService.chat(messagesForModel, options);
    };

    for (let round = 0; round < maxToolRounds; round++) {
        const response = await callModel(round);
        roundsUsed = round + 1;

        const toolCalls = response.toolCalls;
        if (!toolCalls || toolCalls.length === 0 || functionDefs.length === 0) {
            content = response.content || '';
            break;
        }

        // Abort check between the model's tool request and its execution
        // (e.g. a voice barge-in while the round was generating).
        if (typeof shouldAbort === 'function' && shouldAbort()) {
            aborted = true;
            content = response.content || '';
            break;
        }

        messagesForModel.push({ role: 'assistant', content: response.content, toolCalls });
        if (typeof onToolRound === 'function') {
            try { onToolRound(round, toolCalls, response.content || ''); } catch { /* cosmetic hooks never break the loop */ }
        }
        await executeToolRound({
            toolCalls, messagesForModel, transcript, resultCache, interactionContext, executeTool
        });
    }

    if (aborted || (typeof shouldAbort === 'function' && shouldAbort())) {
        return { content: content || '', toolTranscript: transcript, roundsUsed, finalized, aborted: true };
    }

    // Finalization: the tool budget ran out while the model still wanted
    // tools, or the model answered with empty text after using tools.
    if (content === null || (content.trim() === '' && transcript.length > 0)) {
        finalized = true;
        messagesForModel.push({
            role: 'system',
            content: content === null ? FINALIZE_NUDGE : EMPTY_REPLY_NUDGE
        });

        try {
            const response = await callModel(roundsUsed);
            roundsUsed += 1;
            // Any further tool requests are deliberately ignored, not executed.
            content = response.content || '';
        } catch (finalizeErr) {
            console.error('Finalization round failed:', finalizeErr.message);
            content = '';
        }

        if (content.trim() === '' && transcript.length > 0) {
            content = buildTranscriptDigest(transcript);
        }
    }

    return { content, toolTranscript: transcript, roundsUsed, finalized, aborted };
}

module.exports = {
    MAX_TOOL_ROUNDS,
    runAgentLoop,
    buildTranscriptDigest,
    buildPriorToolContext
};
