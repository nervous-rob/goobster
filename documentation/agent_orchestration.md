# Agent Orchestration in the Chat Pipeline

How Goobster turns one user message into a multi-step, tool-using reply — and why
the orchestration layer is built natively (`utils/chat/agentOrchestrator.js`)
rather than on LangChain.

## The problem it solves

The original chat handler ran an inline loop that allowed at most three model
rounds and had no termination story:

- If the model still wanted tools on the last round, the loop fell through with
  a `null` reply. Tools had executed (the repo search *did* run), but no answer
  was ever generated, so the user got the generic
  *"I executed your request successfully, but I'm having trouble generating a
  proper response..."* fallback. Any goal needing three or more sequential tool
  steps was structurally impossible.
- An empty model reply after tool execution went straight to the same fallback —
  no retry, no use of the gathered results.
- Tool results lived only inside that one turn. The context window for the next
  turn is rebuilt from the visible Discord messages, so a follow-up question had
  no access to what the tools had just returned.

## The design

`runAgentLoop` implements the same pattern as LangChain's `AgentExecutor` over
the repo's existing provider contract (`aiService.chat` returning
`{ content, toolCalls }`):

1. **Sequential planning by the model.** Up to `MAX_TOOL_ROUNDS` (6) rounds per
   reply may request tools. Each round's results are appended to the
   conversation before the next model call, so step N can use step N-1's output
   — "find the file, then read it, then compare it with that other file" works
   without any bespoke planner. A round may contain several parallel calls;
   the budget bounds sequential depth, not total invocations.
2. **Guaranteed answer.** When the budget runs out while the model still wants
   tools (or its reply after tool use is empty), a finalization round runs: a
   system nudge orders the model to answer from the results already gathered,
   and any further tool requests are ignored rather than executed. If even that
   yields no text, the tool transcript itself is rendered into a readable
   digest. The generic apology can no longer be reached on a tool-using turn.
3. **Loop protection.** Identical calls (same tool + same arguments within one
   turn) are served from a per-turn cache with a "you already called this"
   note, so a looping model burns no budget and no external quota.
4. **Errors are observations.** A failing tool feeds its error text back to the
   model (LangChain's "observation" pattern), which can retry with corrected
   arguments, pick another tool, or explain the failure — instead of aborting
   the whole reply.
5. **Cross-turn continuity.** The transcript of every tool-using reply is
   persisted in the bot message's `metadata` column (`messages` table). The
   next turns re-inject recent transcripts (45-minute window) into the system
   prompt as a `PRIOR TOOL RESULTS` block via
   `chatDb.getRecentToolTranscripts` + `buildPriorToolContext`, so follow-up
   questions are answered from data already fetched.

## Why not LangChain (the dependency)?

LangChain.js was evaluated and deliberately not adopted:

- **It would replace, not wrap, the provider layer.** LangChain agents drive
  their own model clients. Goobster's router (`services/aiService.js`) carries
  per-guild provider/model/reasoning overrides, usage tracking with
  guild/user attribution, thinking-token budgeting (`utils/aiTokenBudget.js`),
  native web-search flags, and the Ollama prompt-based tool protocol — all of
  which would have to be re-implemented as custom LangChain wrappers, at which
  point the framework provides only the loop this module implements in ~200
  lines.
- **Self-hosted-first constraints.** The bot targets a Raspberry Pi 4B
  (< 500MB RSS). LangChain plus its ecosystem is a heavy dependency tree for
  one control-flow pattern.
- **The valuable part is the pattern, not the package**: bounded iterations,
  a scratchpad of intermediate steps, forced final answers, and tool-error
  observations — all captured here and unit-tested
  (`tests/agentOrchestrator.test.js`).

If hosted tracing/evaluation (LangSmith-style) is ever wanted, the clean
migration path is to expose `toolsRegistry` entries as LangChain `DynamicTool`s
and wrap `aiService` in a custom `BaseChatModel` — the tool and provider
contracts here already match those shapes.

## Extension points

- **Tools**: add entries to `utils/toolsRegistry.js`; the orchestrator picks
  them up automatically. Keep results text-shaped and windowed
  (`utils/toolResultWindow.js`: line windows for file reads, shared
  `TOOL_RESULT_CHARS` so storage and prior-turn re-injection do not recut
  what the model just saw).
- **Budgets**: `MAX_TOOL_ROUNDS` lives at the top of
  `utils/chat/agentOrchestrator.js`. File-result and prior-turn caps live
  in `utils/toolResultWindow.js`.
- **Other loops**: `runAgentLoop` accepts injectable hooks, which is how the
  voice pipeline uses it — both voice engines run the same loop with
  `createVoiceToolRunner` from `services/voice/voiceTurnShared.js` supplying
  the tool executor (audible cues, captured `reply()` output), `onToolRound` /
  `onDelta` / `onRoundStart` driving speech, and `shouldAbort` stopping the
  loop on barge-in (an interrupted turn is never finalized or digested).
  Voice uses a smaller budget (`VOICE_MAX_TOOL_ROUNDS` = 3): every extra round
  is silence the listener sits through.
