# ADR 0032: The pilot is measured by results the system checked, read from records that already exist, and judged by the owner

## Status

Accepted for DA-6 of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
integrated personal pilot kit. It builds on
[ADR 0016](0016-delegated-responsibilities.md) (responsibilities and the
pilot decision), [ADR 0018](0018-delegated-runs.md) (runs and the operation
journal), [ADR 0019](0019-delegated-plan-steps.md) (verified plan steps) and
[ADR 0029](0029-process-repair.md) (verified repairs). Behaviour is
documented in [delegated_pilot.md](../delegated_pilot.md) and
[delegated_pilot_record.md](../delegated_pilot_record.md). The code is
`packages/core/services/assistantOutcomeService.js`, the route
`GET /api/app/assistant/outcomes`, `apps/web/src/rooms/assistant/OutcomeSummary.tsx`,
`assistantRunService._given()` with `aiService.routeFor()`, and the rehearsal
in `scripts/pilot-rehearsal.js` and `scripts/lib/assistantPilotRehearsal.js`.

## Context

The plan asks the owner to run one project with three responsibilities, to
record thresholds before judging and an exit decision afterwards, and to
measure verified progress, accepted findings, corrections, unwanted actions,
cost per useful outcome, interruptions and foreground responsiveness. It
forbids notes created, tool calls and time spent as measures of success.

Before this increment each of those facts was in a different place (runs,
the operation journal, note change sets, repairs, updates, the work ledger),
no page added them up per responsibility, a production run did not record
which instructions or model it was given, and the only way to see the
integrated flow work was to try it on real data.

## Decision

1. **A summary is a read model, not a table.** `assistantOutcomeService`
   counts, per responsibility and period, from rows the other increments
   already write. It stores nothing, so there is nothing new to export,
   erase or prune, and it cannot drift from what it summarizes.
2. **"Checked" means code verified it.** Exactly two things count: a plan
   step whose run completed (a plan-step run completes only when its
   required files are verified, ADR 0019), and a repair applied by the
   assistant whose check afterwards was clean (ADR 0029). A finding a run
   reported is counted separately as reported. Nothing a model says moves a
   result from one count to the other.
3. **What cannot be known is named, not estimated.** Whether a finding was
   useful, whether an action was unwanted and whether chat stayed responsive
   are returned as `notMeasured` and shown on the page. The owner records
   them in the pilot record. The typed answers a person gave
   ([ADR 0031](0031-delegated-feedback-and-learned-rates.md)) are counted as
   given, per responsibility and kind; a finding with no answer is counted
   neither way, and no score or "cost per useful result" is derived, because
   work a person asked for offers no *useful* answer and silence is not a
   verdict. The undoable change that records *this is wrong* or *keep this
   wording* is counted as the person's answer, not as a change the
   responsibility made. Notes created and tool calls appear nowhere as
   a measure; writes are reported as changes made, changes undone and
   outside writes.
4. **Cost comes from the work ledger, and says when it does not.** Tokens
   are what the ledger settled for each run, its research expeditions and
   request classification; reservations still held are shown apart and mark
   the figures provisional. An installation without the research payload
   has no ledger report, so the runs' own counts are used and the answer
   says `costSource: "runs"`. A ratio with no result in it is `null`, never
   zero.
5. **Every run records what it was given.** `assistant_runs` gains
   `promptVersion`, `provider` and `model`, written when an attempt opens
   and again when it is resumed. `aiService.routeFor()` names the route a
   call would take (the person's own connection first) without calling a
   model and never throws; a route that cannot be read is recorded as
   unknown. These are names, never content, so the columns follow the run
   through export, erasure and pruning with no new path.
6. **The summary is the person's own and is not behind the pilot gate.** It
   reads only their rows and exposes counts, codes and names. Gating a
   read of one's own activity would hide the evidence the pilot decision
   needs from the very accounts it is later opened to.
7. **Thresholds, cycles and the exit decision are a document.** The product
   does not hold the owner's thresholds and does not judge the pilot. The
   one decision the installation records remains the existing one: opening
   the pilot capabilities to everyone (ADR 0016, DA-12a).
8. **The rehearsal drives the real services with a scripted model, in a
   database of its own.** `npm run pilot:rehearsal` points every path at a
   new temporary directory before any module loads, removes the Postgres
   address and provider keys from its own environment, refuses a database
   that already holds a responsibility, and stands in only for what is
   outside the process (the model, workspace files, Notion, the followed
   source, Discord). It runs the same periodic pass the installation runs,
   on a clock it advances. The same code is a Jest spec, so journeys A to G,
   the feedback flow and the host's controls are checked on both engines in
   CI.

## Consequences

- A pilot cycle can be compared with an evaluation run: both carry the
  prompt label and the model.
- The summary is only as good as the two verifications behind it. A
  responsibility that only researches has no checked results, and its cost
  is shown per reported finding instead; that is a statement about what was
  verified, not about its worth.
- Runs from before this increment have no recorded prompt or model and are
  shown as not recorded.
- The rehearsal proves the mechanics hold together. It says nothing about a
  real model's judgement (the evaluation set) or about usefulness (the
  pilot).

## Not decided here

A usefulness score or a cost per useful result derived from feedback,
measuring foreground responsiveness, and keeping the pilot record in the
product.
