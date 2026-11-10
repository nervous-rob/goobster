# ADR 0018: A delegated run is the shared agent loop behind an explicit tool table, an operation journal and hard budgets

## Status

Accepted for DA-3 of the
[delegated assistant plan](../delegated_assistant_implementation.md):
recoverable runs that read and research, write generated notes, edit and
run files in a linked project, and start a research expedition as child
work. It builds on [ADR 0016](0016-delegated-responsibilities.md) (the
grant) and [ADR 0017](0017-initiatives-updates-processes.md) (initiatives
and updates). Behaviour is documented in
[delegated_runs.md](../delegated_runs.md). The services are
`assistantRunService.js` and `assistantRunnerService.js` under
`packages/core/services/`. The entries of the tool table live one module per
capability under `packages/core/services/assistant/runTools/`.

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
   of adding a chat tool. The table is assembled in
   `services/assistant/runTools/index.js` from one module per capability
   (`searchWeb`, `lookupNotes`, `projectFiles`, `runProjectFile`,
   `startResearch`, `generatedNotes`, `consultDocs`, `finish`); a new
   capability is a new module and one line in that index. An entry may also
   say when it is on offer (`available({ project, features })`: a linked
   project, a feature that is on).

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

3. **A write in flight is never retried blindly.** A journal row left
   `DISPATCHED` for a `write` tool is resolved by the tool's own identity:
   - *atomic* tools (note writes) commit the change and the `SUCCEEDED`
     journal row in one database transaction, so an in-flight row means the
     change did not happen and it is done again;
   - `writeProjectFile` reconciles by content (the file holding exactly the
     intended bytes means done);
   - `runProjectFile` and `startResearch` pass `assistant_run:<run>:<op>` as
     the child's `executionAttemptId`; a job or expedition carrying it is
     adopted, an absent one is started;
   - anything else, or a reconciliation that cannot tell, becomes
     `UNCERTAIN` and the run settles as `REVIEW` (`OPERATION_UNCERTAIN`).

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
   - On top of that the responsibility's `modelTokens`, `searches` and
     `computeSeconds` budgets are per-UTC-day caps across its runs. Unset
     means the defaults (200,000 tokens, 20 searches, 120 sandbox seconds),
     never unlimited.
   - An exhausted budget settles the initiative as `WAITING` (`budget`) with
     `recheckAfter` at the next day; the steward requeues it then. Nothing
     polls a model to rediscover the refusal.
   - A run is at most 8 tool rounds and 10 minutes.

6. **Only queued work runs.** The runner claims `QUEUED` initiatives. A
   proposed one (`CANDIDATE`) waits for its owner to start it (see 12). One
   running initiative per person, two across the installation.

7. **It never takes `web_live_turns`.** The run does not go through
   `webChatService`; chat stays usable while a run works.

8. **Runs are private user data.** `assistant_runs` (result title and
   summary) and `assistant_run_operations` (retrieved text) are in the
   account export, the transparency audit and `/forget-me`, and are pruned
   with finished initiatives at 180 days. The work ledger gets codes only
   (`assistant_run` failures: `PROVIDER_ERROR`, `UPDATE_FAILED`), never a
   provider's message.

9. **Knowledge is hardened before it is written to.**
   - Capacity pruning (`_pruneNodes`) and the low-confidence orphan prune
     (`_pruneOrphans`) never delete a note with curation `saved`. A scope
     full of saved notes stays over its cap; automated additions are refused
     (`CAPACITY`) instead of evicting.
   - `kg_nodes.generated` marks a note written by delegated work. It is a
     column, not a new curation value: curation stays the person's intent
     (ADR 0008) and a generated note is `unclassified` until they save it.
     A human edit clears `generated` and sets `saved`.
   - `addGeneratedNote` never upserts: an existing title is refused and no
     semantic match is treated as the same note. `amendGeneratedNote` is a
     compare-and-swap on the revision read and only matches a note that is
     still generated.
   - `applyMutations({ generatedOnly })` is the same rule for the research
     pipeline, used when an expedition's `executionAttemptId` names a run:
     new notes are generated, existing notes that are the person's are
     skipped, and no merge, delete, contradiction demotion, tag or link
     touches a note that is not generated.

10. **A child expedition is waited for, not polled with a model.**
    `startResearch` starts one focused expedition and halts the run
    (`WAITING`, `dependency`, `CHILD_PENDING`). The steward and the
    `research.expedition_*` events requeue it when the expedition ends; the
    resumed run's replayed call returns the expedition's outcome. Cancelled
    or failed work cancels its expedition. The expedition's reservations
    are added to the run's token count, once.

11. **What changed is read from the journal.** The update a run files lists
    each successful write from `assistant_run_operations`, and a run that
    wrote anything always files one, whatever the model reported.

12. **Starting automatically is part of the grant.** `rules.autoStart`
    makes proposed initiatives `QUEUED` instead of `CANDIDATE`. It is off by
    default, shown at activation, and an authority change like any other
    rule (pause to edit).

## What is deliberately not here

- **Editing saved notes, edges and archiving** (`kg.saved.amend`, `kg.edge`,
  `kg.archive`): edges have no evidence or retraction history yet.
- **Repository operations** (`repo.commit`, `repo.push`, `pr.create`).
- **Process actions** (DA-5) and **plan-driven project work** (DA-4).
- **Project audiences.** A run's finding goes to the owner only.

## Consequences

- A resumed run re-asks the model. It can take a different path the second
  time; already-finished calls are still not repeated, and calls it no
  longer makes stay in the journal as history.
- The delegated tool table is small on purpose and will lag the chat tools.
- Token accounting reads `usage_reservations` for the run, so a provider
  that reports no usage is counted at its reserved estimate.
