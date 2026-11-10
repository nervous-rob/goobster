---
title: Delegated work - the host's controls (stop all, caps, the pilot gate, the installation view)
kind: reference
summary: What the host of an installation can see and do about delegated work in Host → Delegated work - stop all of it at once and resume it, set how many runs work at the same time and what a responsibility may spend per day, record the pilot decision that opens later capabilities to everyone, and read counts, spend and failure codes across accounts without anyone's titles, prompts or results. Covers what a stop does to running work, the default numbers, who counts as the owner, the audit rows, the routes and what is stored.
when: Stopping delegated work for everyone and knowing what happens to work in progress; raising or lowering how many runs execute at once or the daily token, search and sandbox budgets; understanding why work shows "the host has stopped all delegated work" or a step was refused as PILOT_ONLY; recording the pilot decision; checking what the host can and cannot see about other people's delegated work.
tags: [assistant, responsibilities, delegation, host, operator, caps, budgets, audit, privacy, pilot]
feature: assistant
---

# Delegated work: the host's controls

People hand work to Goobster under a [responsibility](delegated_responsibilities.md)
and a background runner [carries it out](delegated_runs.md). Each person
controls their own. The **host** (an account with the operator role) has four
controls over all of it, in the Host room under **Delegated work**
(`/host/assistant`):

- [stop all of it](#stop-all), and resume it;
- [set the caps](#caps): how many runs work at once and what a
  responsibility may spend in a day;
- [record the pilot decision](#the-pilot-gate) that opens later capabilities
  to everyone;
- [read the installation view](#the-installation-view): counts, spend and
  failure codes.

The host cannot read, start, cancel or edit anyone's responsibility or work
from here, and the page never shows what the work is about.

## Stop all

**Stop all** stops delegated work for every account on the installation.

- **Nothing new starts.** The runner claims nothing, and a claim made by
  another process is refused (`ASSISTANT_PAUSED`). Queued work stays queued.
- **Running work halts at its next step.** Every run checks the stop before
  each tool call, after each step and before it settles, and
  `authorize()` refuses every dispatch with `ASSISTANT_PAUSED`. A step that
  was already in flight when you pressed the button finishes; no further
  step or model call starts.
- **Nothing is cancelled or lost.** Halted work shows as *waiting* with "The
  host has stopped all delegated work for now." It does not come back by
  itself, however long the stop lasts.
- **Work that had already reported is filed.** A run that recorded its result
  before the stop landed completes and its finding reaches its owner. A run
  that had not reported yet holds its report until the resume.
- **A research expedition a run already started finishes.** It was
  authorized when it started and is bounded on its own; the run that started
  it waits and reads the result after the resume.
- **People are told.** Home says the host has stopped delegated work. People
  can still draft, edit, pause and revoke their responsibilities, and
  Goobster still notices and *proposes* work (and queues it, for a
  responsibility set to start its work automatically); none of it runs.

**Resume** clears the stop. Work the stop halted goes back to the queue and
continues from its journal: finished steps are replayed from their recorded
results, not done again ([delegated_runs.md](delegated_runs.md#if-something-goes-wrong)).
Resume reports how many pieces of work it put back.

Stopping twice, or resuming when nothing is stopped, changes nothing and
writes no audit row.

This is separate from two other switches. **Pausing the instance** (what a
restore does; [backup_and_restore.md](backup_and_restore.md)) holds every
scheduler, delegated work included. Turning the **`assistant` feature off**
removes the rooms and routes as well ([host_operations.md](host_operations.md#features)).
Stop all leaves everything visible and editable and holds only the doing.

## Caps

Five numbers. Leave one unset and the default applies.

| Cap | Default | Allowed | Environment variable | `config.json` |
| --- | --- | --- | --- | --- |
| `installationRuns`: runs working at once on the installation | 2 | 1 to 20 | `GOOBSTER_ASSISTANT_INSTALLATION_RUNS` | `assistant.installationRuns` |
| `runsPerAccount`: runs one account may have working at once | 1 | 1 to 10 | `GOOBSTER_ASSISTANT_RUNS_PER_ACCOUNT` | `assistant.runsPerAccount` |
| `defaultModelTokens`: model tokens per responsibility per UTC day | 200,000 | 1,000 to 100,000,000 | `GOOBSTER_ASSISTANT_DEFAULT_MODEL_TOKENS` | `assistant.defaultModelTokens` |
| `defaultSearches`: web searches per responsibility per UTC day | 20 | 0 to 1,000 | `GOOBSTER_ASSISTANT_DEFAULT_SEARCHES` | `assistant.defaultSearches` |
| `defaultComputeSeconds`: sandbox seconds per responsibility per UTC day | 120 | 0 to 86,400 | `GOOBSTER_ASSISTANT_DEFAULT_COMPUTE_SECONDS` | `assistant.defaultComputeSeconds` |

- **What the host saved wins**, then the environment variable, then
  `config.json`, then the default. Emptying a box in the Host room removes
  the saved value. A stored or configured number outside the allowed range is
  ignored, not trusted.
- **The three daily numbers are both the default and the ceiling.** A
  responsibility that sets no budget gets the host's number. One that sets a
  lower number keeps its own. One that sets a higher number gets the host's:
  a person can spend less than the host allows, never more. An unset budget
  never means unlimited.
- **The run caps hold when claims race.** Every claim takes one database
  lock, re-reads the stop and both caps and counts the runs holding a live
  lease, in the same transaction that marks the work running. Two runner
  processes (the bot and the api service) cannot take the last slot between
  them. A run whose lease lapsed does not hold a slot.
- **A change applies to the next run that starts.** A run already working
  keeps the budget it started with; lowering a cap does not interrupt it.
  Lowering `installationRuns` below what is running stops new claims until
  enough runs finish.
- The account's own token limit (Host → Limits,
  [work_ledger.md](work_ledger.md#budgets)) still applies on top: a run
  reserves against it like chat does.

These defaults are the numbers delegated runs shipped with. The owner's
recorded pilot numbers replace them by being saved here; nothing else needs
to change.

## The pilot gate

The `assistant` feature is on or off for the whole installation. The
capabilities planned after the first pilot must not reach everyone the
moment they ship, so each is also checked per account: **until the host
records the pilot decision, only the owner has them.**

| Capability | Increment | What it covers |
| --- | --- | --- |
| `conversation` | DA-7 | Delegating, inspecting and stopping work by talking |
| `sources` | DA-8 | Work proposed from more kinds of source |
| `delivery` | DA-9 | Live overview, the interruption rule, the digest, push and Discord echoes |
| `feedback` | DA-10 | Feedback that changes selection, timing and authority |
| `reach` | DA-11 | Repository work, editing saved notes, connecting and archiving notes, outside connectors |

- **The owner** is any active account with the operator role. An
  installation with two operators has two owners; a disabled or demoted
  operator is not one.
- **What is gated today.** Of DA-7 through DA-11 only deciding a request
  where it is shown (DA-7a, [assistant_home.md](assistant_home.md#deciding-a-request-where-it-is-shown))
  has shipped. It shipped before this gate existed and does not check it:
  every person can answer their own requests on Home and in the Inbox. The
  grant vocabulary already contains the `reach` operations (`repo.commit`,
  `repo.push`, `pr.create`, `kg.saved.amend`, `kg.edge`, `kg.archive`,
  `external.write`), so those are gated now: for anyone but the owner,
  activating or resuming a responsibility that grants one is refused with
  `PILOT_ONLY` (naming the operation), and `authorize()` refuses the
  dispatch with `PILOT_ONLY` even if such a grant is already active.
  Everything delegated runs can do today (reading, generated notes, project
  files, sandbox runs, research) is not gated.
- **Recording the decision.** *Open to everyone* records the decision with
  its time and opens every gated capability to every account. *Limit to the
  host* closes them again; other people's responsibilities that use a gated
  operation stop being able to at their next step, and stay as they are.
- An increment that adds a gated capability calls
  `assistantAccessService.allows(userId, '<capability>')` where the
  capability is entered and where it is dispatched. A name that is not in
  the table is refused for everyone, so a misspelt check fails closed.
- A person reads their own state at `GET /api/app/assistant/access`.

## The installation view

`GET /api/app/admin/assistant` and the page built on it show:

- whether work is stopped and since when; the caps in force, their defaults
  and which the host set;
- responsibilities by status; work by state; how many runs are working now;
  how long the oldest queued and the oldest waiting work has been there; what
  waiting work is waiting for, by code;
- runs, model tokens, web searches and sandbox seconds per UTC day (14 days
  by default, up to 90);
- runs that failed or need review, by stop code, and refused steps, by
  refusal code;
- per account: active responsibilities, queued, running and waiting work,
  and today's runs and tokens;
- the pilot decision and the capabilities it covers.

It contains **no title, outcome, prompt, result, source text or journal
text**, and names accounts **by id only**. The page shows a name next to an
id from the host's own account list. Codes are the fixed machine codes
documented in [delegated_runs.md](delegated_runs.md) and
[delegated_responsibilities.md](delegated_responsibilities.md). At most 100
accounts are listed (busiest first); the response says how many were left
out.

## Audit rows

Each change writes one [`operator_audit`](work_ledger.md#operator_audit-what-the-operator-changed)
row after it succeeded, with the operator as `actor` and no `target`. A
refused request, and a request that changed nothing, write none.

| Action | `detail` |
| --- | --- |
| `assistant.pause_all` | none |
| `assistant.resume_all` | `{ requeued }`: how many halted pieces of work went back to the queue |
| `assistant.set_caps` | The caps that changed and their new numbers; `null` for one returned to its default |
| `assistant.pilot_decision` | `{ scope }`: `everyone` or `owner` |

## API

All under `/api/app/admin`, behind sign-in and the operator check; a member
gets `403`.

| Route | Purpose |
| --- | --- |
| `GET /assistant?days=14` | The installation view. `{ available: false }` when the `assistant` feature is off. |
| `POST /assistant/pause` | Stop all. |
| `POST /assistant/resume` | Resume; the response adds `requeued`. |
| `PATCH /assistant/caps` | `{ installationRuns?, runsPerAccount?, defaultModelTokens?, defaultSearches?, defaultComputeSeconds? }`: a whole number in range sets a cap, `null` restores its default. Anything else is `400 BAD_CAPS` and nothing changes. |
| `POST /assistant/pilot` | `{ scope: "everyone" \| "owner" }`. Anything else is `400 BAD_SCOPE`. |

Each change answers with the view and `changed`. With the feature off the
four changing routes answer `409 FEATURE_UNAVAILABLE`.

For a person: `GET /api/app/assistant/access` returns
`{ hostPaused, budgetDefaults: { modelTokens, searches, computeSeconds }, pilot, capabilities, gatedOperations }`,
and `GET /api/app/home` carries `assistant.hostPaused`
([assistant_home.md](assistant_home.md#api)).

## What is stored

Three keys in `instance_state`, none of which holds a person's id (who did
what is in `operator_audit`):

| Key | Value |
| --- | --- |
| `assistantPaused` | `{ since }` while work is stopped; absent otherwise |
| `assistantCaps` | Only the caps the host set |
| `assistantPilot` | `{ scope, decidedAt }` once a decision is recorded |

They are installation settings, not anyone's data: `/forget-me` and the
account export do not touch them. They travel with a backup. A full data
reset empties `instance_state`, which returns the caps to their defaults,
clears a stop and returns the pilot gate to the host only.

Code: `services/assistantControlService.js` (stop, caps, the view),
`services/assistantAccessService.js` (the gate),
`config/assistantConfig.js` (defaults and ranges), the routes in
`web/routes/admin.js`. Tests: `tests/assistantControlService.test.js` on
SQLite and Postgres, and the `e2e/hostAssistant.spec.js` journey.

How a real model behaves under these limits is measured by the optional
[evaluation set](delegated_evaluation.md), whose records carry the caps in
force.

## Not built yet

- Caps for one account that differ from everyone else's, and a ceiling
  separate from the default.
- Telling people in their Inbox that the host stopped or resumed their work
  (Home and the work item say so).
