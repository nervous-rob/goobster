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

1. **Sequential planning by the model.** Rounds may request tools up to a
   budget sized by the work (see *Budgets are sized by the work* below). Each
   round's results are appended to the conversation before the next model
   call, so step N can use step N-1's output — "find the file, then read it,
   then compare it with that other file" works without any bespoke planner. A
   round may contain several parallel calls; the budget bounds sequential
   depth, not total invocations.
2. **Guaranteed answer, as a handoff.** When the loop stops while the model
   still wants tools — budget exhausted, the caller's deadline passed, or the
   model stalled — a finalization round runs: a system nudge orders the model
   to hand off from the results already gathered (what is done, what remains,
   and that "continue" picks up from here; never claim completion), and any
   further tool requests are ignored rather than executed. The same happens
   when the reply after tool use is empty. If even that yields no text, the
   tool transcript itself is rendered into a readable digest. The generic
   apology can no longer be reached on a tool-using turn. The result carries
   `stopReason` (`rounds` / `deadline` / `stalled` / `null`) so callers can
   log why a turn handed off.
3. **Loop protection, in two layers.** Identical calls (same tool + same
   arguments within one turn) are served from a per-turn cache with a "you
   already called this" note, so a looping model burns no external quota.
   And a round made of *nothing but* cached repeats counts as a stalled
   round; `MAX_STALLED_ROUNDS` (2) of them in a row ends the turn with a
   `stalled` handoff instead of spending the whole budget on a model that is
   going in circles. A repeat interleaved with a fresh call (re-check status
   while doing the next step) is progress, not a stall.
4. **Errors are observations.** A failing tool feeds its error text back to the
   model (LangChain's "observation" pattern), which can retry with corrected
   arguments, pick another tool, or explain the failure — instead of aborting
   the whole reply.
5. **Cross-turn continuity.** The transcript of every tool-using reply is
   persisted in the bot message's `metadata` column (`messages` table). The
   next turns re-inject recent transcripts (45-minute window) into the system
   prompt as a `PRIOR TOOL RESULTS` block via
   `chatDb.getRecentToolTranscripts` + `buildPriorToolContext`, so follow-up
   questions are answered from data already fetched — and so "continue" after
   a handoff has the previous steps in front of it.
6. **Context compaction for long turns.** Tool results are individually
   windowed (`utils/toolResultWindow.js`), but forty of them still overflow a
   context window. Before each model round, once the tool history exceeds
   `TOOL_HISTORY_BUDGET_CHARS` (200k), the oldest tool results are replaced
   in the model's view with a short stub (what tool, how long it was, its
   first few hundred characters, "call again if you need it"). The newest
   `COMPACT_KEEP_RECENT` (4) always stay verbatim, the assistant/tool
   message pairing providers require is untouched, and the persisted
   transcript keeps the full text.
7. **Aborts return, they do not throw.** A Stop or watchdog eviction
   hard-cancels the in-flight provider request, which surfaces as a
   rejection. The loop recognises it (`shouldAbort()` is true) and returns an
   aborted result *with* the transcript and the model's interstitial text
   (`roundTexts`), so the caller can still tell the user what ran.

## Budgets are sized by the work

The visible failure this guards against: the user watches tool chips appear
for a project task, then the reply never comes and the goal is left half-done,
because the loop stopped at an arbitrary step count or a watchdog killed a
turn that was still working.

- **Conversation** (`MAX_TOOL_ROUNDS` = 6): "find the file, read it, compare"
  is three steps; six is generous.
- **Project work** (`PROJECT_MAX_TOOL_ROUNDS` = 40): whenever the
  `observatory` tool is offered — the Study, the built-in Goobster seat in a
  project parlor, automations, Discord when the Observatory scope is
  `everywhere` — `chatHandler` and `parlorService` pass this budget. Creating
  a project, saving two scripts, wiring a cron stage with an output contract,
  a filtered event stage, a foreground run, `list_triggers`, `audit`,
  `inspect` is nine sequential steps before the first word of the reply
  (`tests/agentLoopObservatory.test.js` runs exactly that plan through the
  real registry). The ceiling is a safety net; the loop is bounded by progress
  (stall detection) and by the surface's deadline.
- **Deadline, not death.** The web chat hands the loop `deadlineAt`
  (`interaction.turnDeadlineAt` = the turn's absolute watchdog ceiling minus a
  margin). Once passed, no new tool round starts and the turn finalizes with
  a time-limit handoff. The watchdog itself (`webChatService._liveTurn`) is
  **idle-based**: it evicts a turn that has shown no progress for
  `TURN_IDLE_MAX_MS`, never a turn that is merely old. If the system does
  stop a turn after tools ran, `chatHandler` delivers `buildAbortedHandoff`
  (what ran, elapsed time, "say continue"); only a *user* Stop ends quietly.
- **Voice** (`VOICE_MAX_TOOL_ROUNDS` = 3) and **personas**
  (`PERSONA_MAX_TOOL_ROUNDS` = 3) stay small on purpose: every extra round is
  silence the listener sits through.

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
- **Budgets**: `MAX_TOOL_ROUNDS`, `PROJECT_MAX_TOOL_ROUNDS`,
  `MAX_STALLED_ROUNDS`, and `TOOL_HISTORY_BUDGET_CHARS` live at the top of
  `utils/chat/agentOrchestrator.js`. Callers pick the budget from the tools
  they offer (project tools ⇒ project budget) and pass their surface's
  `deadlineAt`. File-result and prior-turn caps live in
  `utils/toolResultWindow.js`.
- **Other loops**: `runAgentLoop` accepts injectable hooks, which is how the
  voice pipeline uses it — both voice engines run the same loop with
  `createVoiceToolRunner` from `services/voice/voiceTurnShared.js` supplying
  the tool executor (audible cues, captured `reply()` output), `onToolRound` /
  `onDelta` / `onRoundStart` driving speech, and `shouldAbort` stopping the
  loop on barge-in (an interrupted turn is never finalized or digested).
  Voice uses a smaller budget (`VOICE_MAX_TOOL_ROUNDS` = 3): every extra round
  is silence the listener sits through.
