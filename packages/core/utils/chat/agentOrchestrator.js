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
 *   1. The loop stops requesting tools when the model answers, when it
 *      stalls (MAX_STALLED_ROUNDS consecutive rounds of nothing but cached
 *      duplicates - it is looping, not working), when the caller's
 *      wall-clock deadline passes, or when the round budget is exhausted.
 *      Duplicate calls (same tool + same arguments within one turn) are
 *      served from a cache instead of re-executing, so a looping model
 *      burns no budget.
 *   2. Whenever the loop stops while the model still wanted tools, a
 *      finalization round runs: a system nudge orders the model to hand
 *      off - what is done, what remains, how to continue - from the results
 *      it already has, and any further tool requests are ignored rather
 *      than executed.
 *   3. If the final content is still empty but tools did run, the transcript
 *      itself is rendered into a readable digest - never the generic
 *      "I executed your request successfully..." apology.
 *   4. An abort (Stop button, turn watchdog) that surfaces as a rejected
 *      provider call is returned as an aborted result carrying the
 *      transcript, so the caller can still tell the user what ran.
 *
 * Tool failures become observations (the error text is fed back to the
 * model) so a failed step can be retried or worked around mid-turn instead
 * of aborting the whole reply. Older tool results are compacted once the
 * tool history outgrows TOOL_HISTORY_BUDGET_CHARS, so a long project turn
 * does not die of context overflow halfway through.
 */
const aiService = require('../../services/aiService');
const toolsRegistry = require('../toolsRegistry');
const { PRIOR_RESULT_CHARS, PRIOR_BLOCK_CHARS } = require('../toolResultWindow');

// Model rounds that may request tools within a single conversational reply.
// Each round can contain several parallel tool calls, so this bounds
// *sequential depth* (plan steps), not the total number of tool invocations.
const MAX_TOOL_ROUNDS = 6;

// Project work (the Observatory tool is on the table): a real task - create
// the project, save scripts, run them, read results, wire triggers, audit -
// is easily 10-20 sequential steps, and a turn cut off in the middle leaves
// the goal undone. The loop is bounded by progress (stall detection) and
// the caller's deadline; this ceiling is a safety net, not a plan size.
const PROJECT_MAX_TOOL_ROUNDS = 40;

// A round whose every tool call was a cached duplicate made no progress.
// This many in a row means the model is looping, and the turn hands off.
const MAX_STALLED_ROUNDS = 2;

// Tool results kept verbatim in the model's context. Above this, the
// oldest results are replaced with a short stub (the newest
// COMPACT_KEEP_RECENT always stay intact). Per-result windows are already
// capped by toolResultWindow; this caps their sum across a long turn.
const TOOL_HISTORY_BUDGET_CHARS = 200_000;
const COMPACT_KEEP_RECENT = 4;
const COMPACT_STUB_CHARS = 400;

// Per-result cap when rendering the last-resort digest for the user.
const DIGEST_RESULT_CHARS = 300;

// Caps for the step timeline (persisted with the reply and streamed to the
// web client as tool-chip context - kept small on purpose).
const STEP_ARGS_PREVIEW_CHARS = 200;
const STEP_RESULT_PREVIEW_CHARS = 500;
const STEP_TEXT_CHARS = 4000;

// PRIOR_RESULT_CHARS / PRIOR_BLOCK_CHARS come from toolResultWindow so a
// file window the model just saw is not recut to a few thousand characters
// on the next turn.

const HANDOFF_INSTRUCTIONS =
    'Do NOT request any more tools. Write your reply for the user now, in plain conversational ' +
    'language, from the tool results already gathered above. Be explicit: (1) what has been ' +
    'completed, (2) what is still left to reach their goal, and (3) that they can say "continue" ' +
    'to pick up from here. Never claim the goal is finished if it is not.';

const FINALIZE_NUDGES = {
    rounds: `TOOL BUDGET EXHAUSTED: You have used all tool rounds available for this reply. ${HANDOFF_INSTRUCTIONS}`,
    deadline: `TIME LIMIT REACHED: This reply has run as long as one turn may. ${HANDOFF_INSTRUCTIONS}`,
    stalled: 'NO PROGRESS: Your last tool requests only repeated calls you had already made this turn, ' +
        `with identical arguments, so nothing new was learned. ${HANDOFF_INSTRUCTIONS}`
};

const EMPTY_REPLY_NUDGE =
    'Your previous reply was empty. Write the final answer for the user now, in plain ' +
    'conversational language, summarizing the tool results gathered above. Do NOT request ' +
    'any more tools.';

/** Compact one-line preview of a JSON arguments string for chips/steps. */
function previewText(text, cap) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    return clean.length > cap ? `${clean.slice(0, cap)}…` : clean;
}

/**
 * Keep the model's tool history within TOOL_HISTORY_BUDGET_CHARS by
 * replacing the oldest tool results with a stub. The assistant/tool
 * message pairing providers require is untouched - only the content of
 * old `tool` messages shrinks. The newest `keepRecent` results are never
 * compacted (they are what the next step is about to use), and a result
 * is compacted at most once.
 * @returns {number} how many results were compacted in this pass
 */
function compactToolHistory(messagesForModel, {
    budgetChars = TOOL_HISTORY_BUDGET_CHARS,
    keepRecent = COMPACT_KEEP_RECENT
} = {}) {
    const toolIndexes = [];
    let total = 0;
    for (let i = 0; i < messagesForModel.length; i++) {
        const message = messagesForModel[i];
        if (message.role !== 'tool') continue;
        toolIndexes.push(i);
        total += String(message.content || '').length;
    }
    if (total <= budgetChars) return 0;

    let compacted = 0;
    const candidates = toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent));
    for (const index of candidates) {
        if (total <= budgetChars) break;
        const message = messagesForModel[index];
        if (message.compacted) continue;
        const original = String(message.content || '');
        if (original.length <= COMPACT_STUB_CHARS * 2) continue;
        const stub = `[Earlier result from ${message.name} (${original.length} chars) was trimmed to save context. ` +
            `It began:\n${original.slice(0, COMPACT_STUB_CHARS)}…\nCall the tool again if you need the full result.]`;
        messagesForModel[index] = { ...message, content: stub, compacted: true };
        total -= original.length - stub.length;
        compacted += 1;
    }
    return compacted;
}

/**
 * Reply of last resort for a turn the system (not the user) cut off while
 * tools were running: the watchdog evicted it, or the caller's deadline
 * passed before finalization could run. Names what ran so the goal is not
 * silently dropped and "continue" has something to continue from.
 * @param {{ transcript: Array, roundTexts?: string[], elapsedMs?: number|null, reason?: string|null }} params
 * @returns {string}
 */
function buildAbortedHandoff({ transcript = [], roundTexts = [], elapsedMs = null, reason = null }) {
    const ranFor = elapsedMs != null ? ` after ${formatDuration(elapsedMs)}` : '';
    const why = reason === 'watchdog'
        ? 'the turn watchdog stopped this reply'
        : reason === 'deadline'
            ? 'this reply hit its time limit'
            : 'this reply was stopped';
    const head = `⚠️ I could not finish: ${why}${ranFor}, in the middle of a sequence of steps. ` +
        'Nothing below was lost - say "continue" and I will pick up from here.';
    const narration = roundTexts.filter(Boolean).join('\n\n').trim();
    const stepLines = transcript.map(entry => {
        const result = entry.result.length > DIGEST_RESULT_CHARS
            ? `${entry.result.slice(0, DIGEST_RESULT_CHARS)}…`
            : entry.result;
        return `${entry.isError ? '❌' : '✅'} **${entry.name}**\n${result}`;
    });
    const parts = [head];
    if (narration) parts.push(narration);
    if (stepLines.length > 0) {
        parts.push(`Steps completed before the stop (${stepLines.length}):\n\n${stepLines.join('\n\n')}`);
    }
    return parts.join('\n\n');
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Execute one round of tool calls sequentially, appending each result to
 * messagesForModel before the next call executes. Polls shouldAbort between
 * calls so a Stop (or watchdog eviction) lands mid-round instead of after
 * every remaining tool has run to completion - a single round can contain
 * several long sandbox runs.
 * @returns {Promise<boolean>} whether the round was cut short by an abort
 */
async function executeToolRound({ toolCalls, messagesForModel, transcript, steps, resultCache, interactionContext, executeTool, onToolEvent, shouldAbort }) {
    const emit = (payload) => {
        if (typeof onToolEvent !== 'function') return;
        try { onToolEvent(payload); } catch { /* cosmetic hooks never break the loop */ }
    };

    for (const call of toolCalls) {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
            return true;
        }
        const cacheKey = `${call.name}:${call.arguments || '{}'}`;
        let fnResult;
        let isError = false;
        const cached = resultCache.has(cacheKey);
        // Stable per-turn id so the client can pair start/result events even
        // when the same tool runs twice in one reply.
        const id = transcript.length;
        const argsPreview = previewText(call.arguments || '{}', STEP_ARGS_PREVIEW_CHARS);
        const startedAt = Date.now();

        emit({ phase: 'start', id, name: call.name, cached, argsPreview });

        if (cached) {
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
        const resultPreview = previewText(resultText, STEP_RESULT_PREVIEW_CHARS);
        const durationMs = Date.now() - startedAt;

        emit({ phase: 'result', id, name: call.name, isError, cached, resultPreview, durationMs });

        if (!isError && !resultCache.has(cacheKey)) {
            resultCache.set(cacheKey, resultText);
        }

        transcript.push({
            name: call.name,
            arguments: call.arguments || '{}',
            result: resultText,
            isError
        });

        steps.push({
            type: 'tool',
            id,
            name: call.name,
            argsPreview,
            resultPreview,
            isError,
            cached,
            durationMs
        });

        messagesForModel.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: resultText
        });
    }
    return false;
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
        `writing a proper summary. Here's what each step returned:\n\n${lines.join('\n\n')}`;
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
 * @param {function(Object):void} [params.onToolEvent] - per-tool progress hook:
 *   { phase: 'start'|'result', name, cached, isError? }. The web portal streams
 *   these as SSE `tool` events ("Searching the web…" activity chips)
 * @param {function():boolean} [params.shouldAbort] - polled around each model round;
 *   when true the loop stops immediately without finalization (e.g. voice barge-in)
 * @param {number} [params.maxToolRounds] - sequential round budget; MAX_TOOL_ROUNDS
 *   for conversation, PROJECT_MAX_TOOL_ROUNDS when project tools are offered
 * @param {number|null} [params.deadlineAt] - epoch ms; once passed, no further
 *   tool rounds start and the turn finalizes with a handoff (never a silent stop)
 * @param {function(string, Object):Promise<*>} [params.executeTool] - injectable tool
 *   executor (defaults to toolsRegistry.execute); exists for tests and reuse.
 * @returns {Promise<{content: string, toolTranscript: Array, steps: Array, roundsUsed: number,
 *   finalized: boolean, aborted: boolean, stopReason: null|'rounds'|'deadline'|'stalled',
 *   roundTexts: string[], compactedResults: number}>}
 *   `steps` is the ordered turn timeline: interstitial text the model wrote
 *   before requesting tools ({type:'text', content}) interleaved with tool
 *   executions ({type:'tool', id, name, argsPreview, resultPreview, isError,
 *   cached, durationMs}). It is persisted with the reply so the web client
 *   can render a "Thinking" trail, live and after reloads. `stopReason` is
 *   set when the loop ended while the model still wanted tools.
 */
async function runAgentLoop({
    messages,
    chatOptions = {},
    functionDefs = [],
    interactionContext = null,
    onDelta = null,
    onRoundStart = null,
    onToolRound = null,
    onToolEvent = null,
    shouldAbort = null,
    maxToolRounds = MAX_TOOL_ROUNDS,
    deadlineAt = null,
    executeTool = async (name, args) => await toolsRegistry.execute(name, args)
}) {
    const messagesForModel = [...messages];
    const transcript = [];
    const steps = [];
    const resultCache = new Map();
    let roundsUsed = 0;
    let finalized = false;
    let aborted = false;
    let content = null;
    let stopReason = null;
    let stalledRounds = 0;
    let compactedResults = 0;

    // Interstitial text the model wrote in the same rounds as its tool
    // requests. It reached the user as streamed deltas, so it must survive:
    // it feeds the steps timeline and doubles as the reply of last resort
    // when finalization produces nothing.
    const roundTexts = [];

    const isAborting = () => typeof shouldAbort === 'function' && shouldAbort();
    const pastDeadline = () => Number.isFinite(deadlineAt) && deadlineAt > 0 && Date.now() >= deadlineAt;
    const abortedResult = () => ({
        content: content || '', toolTranscript: transcript, steps, roundsUsed, finalized,
        aborted: true, stopReason, roundTexts, compactedResults
    });

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
        options.onAdmission = waiting => onToolEvent?.({
            phase: 'admission', name: 'model',
            resultPreview: waiting ? 'Waiting for model capacity. You can stop this request while it is queued.' : ''
        });
        return await aiService.chat(messagesForModel, options);
    };

    for (let round = 0; round < maxToolRounds; round++) {
        // A Stop that landed while the previous round's tools were running
        // must not buy another model call.
        if (isAborting()) {
            aborted = true;
            break;
        }
        // Out of time before this round: hand off instead of starting more
        // work the watchdog would cut short.
        if (round > 0 && pastDeadline()) {
            stopReason = 'deadline';
            break;
        }
        compactedResults += compactToolHistory(messagesForModel);

        let response;
        try {
            response = await callModel(round);
        } catch (modelErr) {
            // An abort hard-cancels the in-flight provider request, which
            // surfaces as a rejection. That is the requested outcome, and
            // the caller still needs the transcript to tell the user what ran.
            if (isAborting()) {
                aborted = true;
                break;
            }
            throw modelErr;
        }
        roundsUsed = round + 1;

        const toolCalls = response.toolCalls;
        if (!toolCalls || toolCalls.length === 0 || functionDefs.length === 0) {
            content = response.content || '';
            break;
        }

        // Abort check between the model's tool request and its execution
        // (e.g. a voice barge-in while the round was generating).
        if (isAborting()) {
            aborted = true;
            content = response.content || '';
            break;
        }

        messagesForModel.push({ role: 'assistant', content: response.content, toolCalls });
        if (typeof onToolRound === 'function') {
            try { onToolRound(round, toolCalls, response.content || ''); } catch { /* cosmetic hooks never break the loop */ }
        }
        const roundText = String(response.content || '').trim();
        if (roundText) {
            roundTexts.push(roundText);
            steps.push({ type: 'text', content: roundText.slice(0, STEP_TEXT_CHARS) });
        }
        // Progress check: a round made of nothing but repeats of calls
        // already made this turn learned nothing new.
        const allRepeats = toolCalls.every(call => resultCache.has(`${call.name}:${call.arguments || '{}'}`));
        const cutShort = await executeToolRound({
            toolCalls, messagesForModel, transcript, steps, resultCache, interactionContext, executeTool, onToolEvent, shouldAbort
        });
        if (cutShort) {
            aborted = true;
            content = response.content || '';
            // The cut-short round's text becomes the delivered partial reply;
            // drop its duplicate from the timeline.
            if (roundText && steps[steps.length - 1]?.type === 'text') steps.pop();
            break;
        }
        stalledRounds = allRepeats ? stalledRounds + 1 : 0;
        if (stalledRounds >= MAX_STALLED_ROUNDS) {
            stopReason = 'stalled';
            break;
        }
        if (round === maxToolRounds - 1) {
            stopReason = 'rounds';
        }
    }

    if (aborted || isAborting()) {
        return abortedResult();
    }

    // Finalization: the loop stopped while the model still wanted tools
    // (budget, deadline, stall), or the model answered with empty text
    // after using tools.
    if (content === null || (content.trim() === '' && transcript.length > 0)) {
        finalized = true;
        if (content === null && !stopReason) stopReason = 'rounds';
        messagesForModel.push({
            role: 'system',
            content: content === null ? FINALIZE_NUDGES[stopReason] : EMPTY_REPLY_NUDGE
        });

        // One transient provider error must not cost the user their answer -
        // retry the finalization call once before falling back.
        content = '';
        for (let attempt = 0; attempt < 2 && content.trim() === ''; attempt++) {
            if (attempt > 0) {
                // A second model call for the same answer is a cost the
                // ledger counts (documentation/work_ledger.md).
                await require('../../services/resourceEventService').record({ kind: 'retry', provider: 'finalize' });
            }
            try {
                const response = await callModel(roundsUsed);
                roundsUsed += 1;
                // Any further tool requests are deliberately ignored, not executed.
                content = response.content || '';
            } catch (finalizeErr) {
                console.error(`Finalization round failed (attempt ${attempt + 1}):`, finalizeErr.message);
                content = '';
                if (isAborting()) break;
            }
        }
        if (isAborting()) {
            return abortedResult();
        }

        if (content.trim() === '' && roundTexts.length > 0) {
            // The model narrated its work mid-turn ("Let me check that…",
            // often the substance of the answer) - that beats a raw dump.
            content = roundTexts.join('\n\n');
        }
        if (content.trim() === '' && transcript.length > 0) {
            content = buildTranscriptDigest(transcript);
        }
    }

    return {
        content, toolTranscript: transcript, steps, roundsUsed, finalized, aborted,
        stopReason, roundTexts, compactedResults
    };
}

module.exports = {
    MAX_TOOL_ROUNDS,
    PROJECT_MAX_TOOL_ROUNDS,
    MAX_STALLED_ROUNDS,
    TOOL_HISTORY_BUDGET_CHARS,
    PRIOR_RESULT_CHARS,
    PRIOR_BLOCK_CHARS,
    runAgentLoop,
    compactToolHistory,
    buildTranscriptDigest,
    buildAbortedHandoff,
    buildPriorToolContext
};
