---
title: Delegated runs (how queued work is carried out)
kind: reference
summary: When you start a proposed piece of work under a responsibility, a background runner carries it out - reading your notes, the linked project's files and the web - checks the responsibility before every step, and reports one finding on Home. It cannot change, send or run anything yet. Covers what a run may do, how it stops, how it recovers from a crash, its budgets and limits, what is stored and the routes.
when: Understanding what happens after pressing Start on proposed work; why a run is waiting, failed or needs review; what a run is allowed to use and spend; checking that pausing or revoking really stops work; knowing what a run stores about you.
tags: [assistant, responsibilities, delegation, runs, budgets, privacy, authority]
feature: assistant
---

# Delegated runs

A [responsibility](delegated_responsibilities.md) proposes work when
something it is linked to changes. **Nothing runs until you start it**: on
the Responsibilities page (`/assistant`) each proposed item has *Start* and
*Dismiss*. Start asks for confirmation and says what the run can and cannot
do.

## What a run can do

Today a run can **read and research, and report**. It cannot change a note,
edit a file, run code, push, send a message or schedule anything.

| It may | Needs this in the responsibility |
| --- | --- |
| Search the web (`searchWeb`) | `read` on `web` |
| Look up your notes, memories and saved files (`lookupNotes`) | `read` on `knowledge` |
| List and read text files in the linked project (`listProjectFiles`, `readProjectFile`) | `read` on that `project` (and within its `paths`, if any) |
| Search Goobster's public documentation (`consultDocs`) | nothing |
| Report its result (`finish`) | nothing |

These are the only tools a run is offered. Before each call the run asks
`authorize()` whether the responsibility covers it, as you, right now. A
call that is not covered is refused and recorded; the run carries on with
what it is allowed and says so in its report. Anything else the model asks
for is refused as `UNKNOWN_TOOL` and never runs.

## What you get back

- **A finding.** One update, shown under *What changed* on Home and in the
  Inbox, and under the work item on the Responsibilities page.
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

## Budgets and limits

| Limit | Value |
| --- | --- |
| Your account's token limit | Applies as always; a run reserves against it like chat does |
| Tokens per responsibility per day (UTC) | `budgets.modelTokens`, default 200,000 |
| Web searches per responsibility per day | `budgets.searches`, default 20 |
| Steps in one run | 8 tool rounds, 10 minutes |
| Running at once | 1 per person, 2 on the installation |

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
| needs review (`OPERATION_UNCERTAIN`) | A step that changes something may or may not have happened. No run can reach this today because none can write. |

**A crash or restart loses nothing and repeats nothing.** Every step is
written to a journal before and after it happens. The interrupted work goes
back to *queued* within about ten minutes and the next run replays finished
steps from the journal instead of doing them again.

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
  `{ id, status, stopCode, outcome, rounds, tokensUsed, searches, resultTitle, resultSummary, startedAt, endedAt }`.
- `GET /api/app/assistant/initiatives/:id` - adds `run.operations`
  (`{ tool, operation, resourceKind, status, refusalCode, at }`), never the
  retrieved text.
- `POST /api/app/assistant/initiatives/:id/actions` -
  `{ action: queue | cancel | retry, expectedRevision }` (unchanged).

Design and reasons: [ADR 0018](adr/0018-delegated-runs.md).

## Not built yet

Writing generated notes, editing project files, running code, repository
work, research expeditions, starting work automatically, and findings shared
with a project's members.
