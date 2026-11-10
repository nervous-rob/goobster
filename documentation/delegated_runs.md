---
title: Delegated runs (how queued work is carried out)
kind: reference
summary: When a proposed piece of work under a responsibility is started, a background runner carries it out - reading your notes, the linked project's files and the web, and, only where the responsibility grants it, writing generated notes, editing project files, running project code in the sandbox or starting one research expedition. It checks the responsibility before every step and reports what it found and what it changed on Home. Covers what a run may do, how it stops, how it recovers from a crash, its budgets and limits, what is stored and the routes.
when: Understanding what happens after pressing Start on proposed work; why a run is waiting, failed or needs review; what a run is allowed to use and spend; checking that pausing or revoking really stops work; knowing what a run stores about you.
tags: [assistant, responsibilities, delegation, runs, budgets, privacy, authority]
feature: assistant
---

# Delegated runs

A [responsibility](delegated_responsibilities.md) proposes work when
something it is linked to changes. By default **nothing runs until you start
it**: on the Responsibilities page (`/assistant`) each proposed item has
*Start* and *Dismiss*. A responsibility drafted with *Start proposed work
automatically* (`rules.autoStart`) queues its work by itself instead. That
choice is part of the grant: it is shown when you activate, and changing it
later requires pausing first.

## What a run can do

A run is offered a fixed list of tools. Each needs something specific in
the responsibility:

| It may | Needs this in the responsibility |
| --- | --- |
| Search the web (`searchWeb`) | `read` on `web` |
| Look up your notes, memories and saved files (`lookupNotes`) | `read` on `knowledge` |
| List the notes it generated earlier (`listGeneratedNotes`) | `read` on `knowledge` |
| Add a generated note (`addGeneratedNote`) | `kg.generated.add` on `knowledge` |
| Amend a note it generated (`amendGeneratedNote`) | `kg.generated.amend` on `knowledge` |
| List and read text files in the linked project (`listProjectFiles`, `readProjectFile`) | `read` on that `project` (within its `paths`, if any) |
| Create or replace a text file in the linked project (`writeProjectFile`) | `file.edit` on that `project` (within its `paths`) |
| Run a `.py`, `.js` or `.sh` file of the project in the sandbox (`runProjectFile`) | `sandbox.run` on that `project` |
| Start one research expedition (`startResearch`) | `research` on `web` **and** `kg.generated.add` on `knowledge` |
| Search Goobster's public documentation (`consultDocs`) | nothing |
| Report its result (`finish`) | nothing |
| Report the result of a plan step (`reportStepResult`, only in a run that carries out a plan step, where it replaces `finish`) | `plan.step.execute` on that `project` |

Before each call the run asks `authorize()` whether the responsibility
covers it, as you, right now. A call that is not covered is refused and
recorded; the run carries on with what it is allowed and says so in its
report. Anything that is not in this table is refused as `UNKNOWN_TOOL` and
never runs. A run cannot send a message, schedule anything, delete
anything, push to a repository or change a note you wrote.

### Your notes stay yours

- A note a run writes is marked **generated** and is not "saved". It shows
  in Knowledge like any other note.
- A run never replaces an existing note: a title that already exists is
  refused. Similarity is not treated as identity.
- A run can amend only a note that is still generated, and only at the
  revision it read. The previous text stays in the note's history.
- The moment you edit or save a generated note it is yours: it stops being
  generated and no run can amend it again.
- **Saved notes are never deleted to make room.** Capacity pruning and the
  low-confidence clean-up both skip notes you saved. When your knowledge is
  full a run's addition is refused instead.
- A research expedition a run starts writes through the same rule
  (`generatedOnly`): it can create and amend generated notes, and cannot
  merge into, retag, link, demote or delete notes that are yours.

### Project files

- To change an existing file the run must read it first in the same piece
  of work; if the file changed since it was read, the write is refused.
- Every write goes through the same path as the Files view (quota, the
  project lock, workspace history), as you. The previous version is in the
  project's history.
- A sandbox run is an ordinary project job (no network), visible under the
  project's Runs with `startedBy = assistant`.

- **Private knowledge does not flow into a shared project.** Once a run
  has read your private knowledge (`lookupNotes`, `listGeneratedNotes`), a
  call that writes into the project (`writeProjectFile`, `runProjectFile`)
  is refused with `PRIVATE_CONTEXT`, unless the project is yours alone (you
  own it, it has no members and no share link).

### Plan steps

A responsibility that grants `plan.step.execute` on its project carries out
the *assistant* steps of that project's plan, once a person has approved and
started the plan. Such a run is told the plan and the one step, ends with
`reportStepResult`, and the step is marked done only after the files it had
to produce were checked. It never approves, starts or completes a plan. See
[delegated_plan_steps.md](delegated_plan_steps.md).

### Research expeditions

`startResearch` starts one *focused* expedition (one per piece of work). The
run then **waits** without using the model, and continues with the
expedition's result when it ends (usually within seconds of it finishing,
at most five minutes later). Cancelling the work cancels its expedition.
The expedition's tokens count once, against the same daily budget.

## What you get back

- **A finding.** One update, shown under *What changed* on Home and in the
  Inbox, and under the work item on the Responsibilities page. If the run
  changed anything, the update ends with "Changed: ..." listing each change.
  That list is read from the run's own journal, not from what the model
  says it did, and a run that changed something always files an update.
- **"Nothing needs your attention."** The work completes with no update,
  and is eligible to be looked at again after a day.
- The work item also shows what the run used (tokens, web searches).

## Stopping

- **Cancel** on the work item, or **pausing**, **revoking**, **completing**
  or the **expiry** of the responsibility, stops a run at its next step.
  A stopped run files no result.
- Pausing parks the work as *waiting*; resuming the responsibility lets it
  continue. Revoking cancels it.
- Turning Attention off, or the host turning the feature off, stops it the
  same way.
- The host can **stop all delegated work** on the installation. Running work
  halts at its next step and shows *waiting* ("The host has stopped all
  delegated work for now"); queued work stays queued; nothing is cancelled.
  When the host resumes, halted work goes back to the queue and continues
  from its journal ([delegated_operations.md](delegated_operations.md#stop-all)).

## Budgets and limits

| Limit | Value |
| --- | --- |
| Your account's token limit | Applies as always; a run reserves against it like chat does |
| Tokens per responsibility per day (UTC) | `budgets.modelTokens`, default 200,000 |
| Web searches per responsibility per day | `budgets.searches`, default 20 |
| Sandbox seconds per responsibility per day | `budgets.computeSeconds`, default 120 |
| Research expeditions | 1 per piece of work |
| Steps in one run | 8 tool rounds, 10 minutes |
| Running at once | 1 per person, 2 on the installation |

The three daily defaults and the two "running at once" numbers are the
host's [caps](delegated_operations.md#caps): the values above apply until
the host sets others in Host → Delegated work. A responsibility's own budget
can be lower than the host's number, never higher: a higher one is treated
as the host's. `GET /api/app/assistant/access` returns the numbers in force
(`budgetDefaults`).

An unset budget means the default, never unlimited. When a budget is used
up the work shows *waiting* with the reason and continues after the day
resets; it does not keep retrying. Chat has priority over background runs
for model capacity.

## If something goes wrong

| Shown as | Meaning |
| --- | --- |
| waiting, token budget | The day's budget is spent. It resumes by itself. |
| waiting, no provider | No AI provider answered. It retries in an hour. |
| failed (`PROVIDER_ERROR`, `NO_RESULT`) | *Try again* starts a new attempt. |
| waiting (`CHILD_PENDING`) | Its research expedition is still working. |
| waiting (`ASSISTANT_PAUSED`) | The host stopped all delegated work. It continues when they resume it. |
| needs review (`OPERATION_UNCERTAIN`) | After an interruption, a file write or sandbox run may or may not have happened and the run could not tell. Check the project, then *Try again* or dismiss. |
| failed (`INTERRUPTED_BY_RESTORE`) | The installation was restored from a backup while the run was working. It is not resumed. A step in progress may or may not have happened: check, then *Try again* starts a new attempt. |

**A crash or restart does not repeat work.** Every step is written to a
journal before and after it happens. The interrupted work goes back to
*queued* within about ten minutes and the next run replays finished steps
from the journal instead of doing them again. For a step that was in flight:

- a read is simply done again;
- a note write commits in the same database transaction as its journal row,
  so "in flight" means it did not happen and it is done again;
- a file write is checked by content: if the file holds exactly what was
  being written it counts as done, otherwise the run stops for your review;
- a sandbox run and an expedition carry the step's id: if a job or
  expedition with that id exists it is adopted, never started twice.

**A restore from a backup is different: it never resumes work.** A run that
was working when the backup was taken comes back *failed* with
`INTERRUPTED_BY_RESTORE`, together with its piece of work, and gets one
failure record in the work ledger (`assistant_run`, code only). That covers
a run in flight, a run waiting to resume after a restart, and work a runner
had claimed but not yet opened. Nothing requeues it: the lease is cleared,
and only your own *Try again* starts a new attempt with a new journal. Work
that was queued, proposed or waiting (on a budget, an expedition, the host's
stop or you) was not in flight and is left as it was; it continues once the
host resumes the paused installation
([backup_and_restore.md](backup_and_restore.md)) and, for work the host's
stop-all had halted, delegated work
([delegated_operations.md](delegated_operations.md)).

## What is stored

- `assistant_runs`: which responsibility revision the run used, as whom,
  what it spent, and its result title and summary.
- `assistant_run_operations`: each step, its status and the text it
  retrieved.

Both are yours: they are in your account export, counted in the privacy
report, deleted by `/forget-me`, and pruned 180 days after the work
finished. Failure records in the work ledger hold a code only.

## Routes

- `GET /api/app/assistant/initiatives` - each item carries `run` (or `null`):
  `{ id, status, stopCode, outcome, rounds, tokensUsed, searches, computeSeconds, resultTitle, resultSummary, startedAt, endedAt }`.
- `GET /api/app/assistant/initiatives/:id` - adds `run.operations`
  (`{ tool, operation, resourceKind, status, refusalCode, at }`), never the
  retrieved text.
- `POST /api/app/assistant/initiatives/:id/actions` -
  `{ action: queue | cancel | retry, expectedRevision }` (unchanged).

Design and reasons: [ADR 0018](adr/0018-delegated-runs.md); for plan steps,
[ADR 0019](adr/0019-delegated-plan-steps.md).

## Not built yet

Editing notes you saved, connecting or archiving notes, repository work
(commit, push, pull requests), acting on processes, findings shared with a
project's members, and work recognized by a model from what was said in a
conversation. Requests you address to Goobster in a conversation are built:
see [delegated_conversation_requests.md](delegated_conversation_requests.md).
When repository work, saved-note edits and outside connectors arrive they
start with the installation's owner only
([the pilot gate](delegated_operations.md#the-pilot-gate)).
