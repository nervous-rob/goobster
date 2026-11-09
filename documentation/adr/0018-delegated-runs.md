# ADR 0018: A delegated run is the shared agent loop behind an explicit tool table, an operation journal and hard budgets

## Status

Accepted for the first increment of DA-3 in the
[delegated assistant plan](../delegated_assistant_implementation.md): runs
that **read and research**. It builds on
[ADR 0016](0016-delegated-responsibilities.md) (the grant) and
[ADR 0017](0017-initiatives-updates-processes.md) (initiatives and updates).
Behaviour is documented in [delegated_runs.md](../delegated_runs.md). The
services are `assistantRunService.js` and `assistantRunnerService.js` under
`packages/core/services/`.

Knowledge writes, file edits, sandbox runs, repository operations and
research expeditions are **not** enabled by this ADR. Each needs its own
safety work first (section "What is deliberately not here").

## Context

DA-1 left initiatives that are proposed and can be queued, a `claim()` /
`settle()` pair with a fenced lease, and an `authorize()` check that nothing
called. The architecture (section 5) asks for a run that survives a crash
without repeating or losing work, never holds the foreground chat claim,
checks authority at each effect, and treats budgets as caps.

Two observations shaped the design:

- `runAgentLoop` is the one bounded tool loop in the product (provider
  parity, round budget, finalization). It is a closed loop: it takes an
  `executeTool` function and returns when the turn ends. It has no
  mid-loop checkpoint to serialize.
- The general tool registry offers about sixty tools. Most write, and their
  authority model is "whatever the person in the conversation may do".
  Filtering that list by name would make every new tool delegated by default.

## Decision

1. **A run is `runAgentLoop` with its own tool table.**
   `assistantRunService.TOOLS` is the complete list of what a run can do.
   Each entry declares the operation and resource it needs
   (`needs(args, ctx)`) and whether it reads or writes (`effect`). The
   executor calls `authorize()` with the run's responsibility, the revision
   it was planned under and the acting person before every call. A name that
   is not in the table is refused and never reaches the registry. Adding a
   delegated capability is therefore an explicit entry, never a side effect
   of adding a chat tool.

2. **The checkpoint is an operation journal, not a transcript.**
   `assistant_run_operations` records each call before dispatch (`PREPARED`,
   `DISPATCHED`) and after (`SUCCEEDED`, `FAILED`), keyed by
   `(run, tool, argsHash, seq)` where `seq` is the n-th identical call.
   A crashed worker's lease lapses, the steward returns the initiative to
   `QUEUED`, and the next worker runs the loop again from the start with the
   same executor: a call that already `SUCCEEDED` returns its recorded
   result without being made again. The model's reasoning is not stored and
   is not needed. This is less than the architecture's "messages per round"
   sketch and it stores less private data; it gives the same guarantee for
   the effects, which is what recovery is for.

3. **A write in flight is never retried.** A journal row left `DISPATCHED`
   for a `write` tool becomes `UNCERTAIN` and the run settles as `REVIEW`
   (`OPERATION_UNCERTAIN`). A read is safe to repeat and is repeated. No
   tool in this increment writes; the rule is in place before one does.

4. **The lease is the stop signal.** The run renews the initiative's lease
   before each tool call. Cancelling, pausing, revoking, expiring or erasing
   clears or parks the lease (ADR 0017), renewal fails, the run stops, and
   **no result is published**. A result is published only after `settle()`
   succeeds, so work that lost its lease cannot file a finding.

5. **Budgets are hard caps with defaults.**
   - Each model call goes through `aiService` with `background: true` and the
     acting person's `usageContext`, inside
     `workContext.run({ kind: 'assistant_run', id })`. The existing
     reservation against the payer's account cap applies unchanged, and
     background admission yields to foreground chat.
   - On top of that the responsibility's `modelTokens` and `searches` budgets
     are per-UTC-day caps across its runs. Unset means the defaults
     (200,000 tokens, 20 searches), never unlimited.
   - An exhausted budget settles the initiative as `WAITING` (`budget`) with
     `recheckAfter` at the next day; the steward requeues it then. Nothing
     polls a model to rediscover the refusal.
   - A run is at most 8 tool rounds and 10 minutes.

6. **Only queued work runs.** The runner claims `QUEUED` initiatives. A
   proposed one (`CANDIDATE`) waits for its owner to start it. One running
   initiative per person, two across the installation.

7. **It never takes `web_live_turns`.** The run does not go through
   `webChatService`; chat stays usable while a run works.

8. **Runs are private user data.** `assistant_runs` (result title and
   summary) and `assistant_run_operations` (retrieved text) are in the
   account export, the transparency audit and `/forget-me`, and are pruned
   with finished initiatives at 180 days. The work ledger gets codes only
   (`assistant_run` failures: `PROVIDER_ERROR`, `UPDATE_FAILED`), never a
   provider's message.

## What is deliberately not here

- **Knowledge writes.** Capacity pruning can still evict saved notes and
  graph upserts are not compare-and-swap (architecture section 2). Those are
  fixed first.
- **File edits, sandbox runs, repository operations.** They need workspace
  snapshots and the write half of the journal exercised end to end.
- **Research expeditions as child work.** A child that outlives the run
  needs adoption and a wake-up; this increment's research is web search.
- **Starting work automatically.** A per-responsibility opt-in comes later.
- **Project audiences.** A run's finding goes to the owner only.

## Consequences

- A resumed run re-asks the model. It can take a different path the second
  time; already-finished calls are still not repeated, and calls it no
  longer makes stay in the journal as history.
- The delegated tool table is small on purpose and will lag the chat tools.
- Token accounting reads `usage_reservations` for the run, so a provider
  that reports no usage is counted at its reserved estimate.
