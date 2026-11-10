---
title: Delegated plan steps (the assistant step of a project plan)
kind: reference
summary: A project plan can hold assistant steps (kind agent). Nobody starts one by hand - a responsibility that grants plan.step.execute on the project carries it out as its owner, only inside a plan revision a person approved and started. The step is marked done only after the files it had to produce were checked; a failed check blocks the plan. Covers how to add a step and delegate it, what makes a step eligible, how a plan or grant change stops queued work, what is checked, what the project's people see, private knowledge and shared projects, lost membership, limits, codes and routes.
when: Adding an assistant step to a plan; delegating a project's plan steps; understanding why an assistant step is still ready, was not started, failed or blocked the plan; checking what a collaborator's assistant can do in a shared project; checking that a plan can never be approved or completed by the assistant.
tags: [assistant, responsibilities, delegation, projects, plans, missions, runs, authority, privacy, verification]
feature: assistant
---

# Delegated plan steps

A project [Plan](projects.md#missions-shown-as-plans) can hold **assistant
steps** (API kind `agent`). An assistant step is a piece of the plan that a
[delegated run](delegated_runs.md) carries out under a
[responsibility](delegated_responsibilities.md): it writes the files the step
names into the project, and the step is marked done only after those files
were checked.

The rule that makes this safe: **Goobster carries out steps; people decide
plans.** A responsibility never approves, starts, edits, reviews or completes
a plan, and it works only inside the plan revision a person approved and
started. Design and reasons: [ADR 0019](adr/0019-delegated-plan-steps.md).

Needs the `assistant` and `projects` features and Attention turned on, like
all delegated work.

## Using it

1. **Add the step.** In the project's Plan view, while the plan is a draft,
   choose the step kind *assistant*, give it a title, the files it must
   produce (workspace-relative, comma-separated, for example
   `docs/comparison.md`) and, optionally, what the assistant should do. In
   project chat the observatory tool does the same
   (`missionAction=add_step`, `stepKind=agent`, `artifacts=`).
2. **Approve and start the plan** yourself, as for any plan.
3. **Delegate.** On the Responsibilities page (`/assistant`) draft a
   responsibility, pick the project and tick *Carry out the assistant steps
   of its approved plan*. That also ticks *Edit its files*, which the step
   needs to write its result; you can limit it to folders. Activate it.
4. **Start the work.** Each ready assistant step appears under the
   responsibility as proposed work, "Plan step ready: ...". It waits for
   *Start* unless the responsibility starts proposed work automatically.

An assistant step has no Start button in the Plan view. Until a
responsibility takes it, the step says it is waiting for an assistant. You
can always do it yourself and press *Mark done* (which stops a run that was
working on it), skip it, or retry it after a failure.

## What makes a step eligible

A step is taken only when all of these hold:

- the step is of kind `agent` and `READY` (its dependencies are done);
- the plan is `ACTIVE`, a person approved it, and the revision they approved
  is the plan's current revision;
- the responsibility is active, is linked to this project and grants
  `plan.step.execute` on it;
- the person the responsibility acts as is still the project's owner or a
  member;
- the plan has assistant runs left (`budget.maxAgentRuns`, default 3, at
  most 12).

All but the last are checked when the work is proposed, and all of them
**again when the run starts**, inside the project's write lock. The second
check is the one that counts.

A step is taken by exactly one run. If the owner and a collaborator both
delegate the same project, one of them gets the step; the other's work ends
*superseded* without calling a model.

## When the plan or the grant changes

| What changed | What happens to queued or running work |
| --- | --- |
| The plan was edited (it returns to draft) or re-approved at a newer revision | The work ends *superseded* (`PLAN_REVISION_STALE`) before any model call. When the new revision is approved and started, its ready steps are proposed again. |
| The plan was cancelled or completed | *superseded* (`PLAN_NOT_ACTIVE`). |
| Someone completed or skipped the step, or another run took it | *superseded* (`STEP_NOT_ELIGIBLE`). A run that was already working is stopped (`PLAN_STEP_CLOSED`) and publishes nothing. |
| The plan is blocked by another failed step | The work waits and looks again after 30 minutes (`PLAN_BLOCKED`). |
| The plan's assistant runs are used up | *failed* (`PLAN_BUDGET`). |
| The responsibility's authority was edited | The work waits with `REPLAN_REQUIRED` until you start it again, as for all delegated work. |
| The responsibility was paused, revoked, completed or expired, or the work was cancelled | A running step stops at its next call and goes back to *ready*. Nothing is published. |
| The person lost access to the project | See [Losing access](#losing-access). |

A superseded attempt is not proposed again by itself for the same plan
revision. *Try again* on it opens a new attempt, which is checked the same
way.

## What is checked before a step is done

A plan-step run ends by calling `reportStepResult` with `done` or `blocked`,
the files it wrote and the success criteria the result bears on. That report
is a claim. The step becomes `DONE` only if, without asking a model:

- the report says `done`;
- the responsibility still grants `plan.step.execute` for that person;
- every file the step requires, and every file the report names, was written
  **by this run** (read from the run's own journal), is in the workspace now
  and is not empty. A report that names no file fails.

| Result | Step | Plan | Work item |
| --- | --- | --- | --- |
| The check passes | `DONE` | continues; `REVIEW` when it was the last step | *done* |
| A file is missing, empty, or was not written by this run (`VERIFICATION_FAILED`) | `FAILED` | `BLOCKED` | *failed* |
| The run reported `blocked` (`STEP_BLOCKED`) | `FAILED` | `BLOCKED` | *failed* |
| The run ended without reporting (`NO_STEP_REPORT`) | `FAILED` | `BLOCKED` | *failed* |
| After an interruption a file write or sandbox run may or may not have happened (`OPERATION_UNCERTAIN`) | `FAILED` | `BLOCKED` | *needs review* |
| The AI provider failed | back to `READY` | unchanged | *failed* (`PROVIDER_ERROR`); *Try again* |
| The day's token budget ran out, or no provider is available | stays `RUNNING`, held for this run | unchanged | *waiting*; it continues by itself |

A failed step is retried or skipped from the Plan view, as for any step.
Retrying makes it ready again and it is proposed as new work.

**The check proves the files exist and came from this run. It does not prove
they are right.** That is why:

- the evidence a run links is `neutral`: it does not move a criterion to
  *supported* by itself. A person links it `for` or `against` after reading
  it;
- finishing the last step moves the plan to `REVIEW`, never to `COMPLETED`.
  Completing a plan needs a person and their own confirmation.

## What is recorded, and who sees it

In the project (visible to its owner and members):

- the step: who it ran for (`delegation.actingUserId`), the run, the
  responsibility and its revision, and `authorization: "delegated"`;
- timeline events `step_started`, `step_done`, `step_failed`,
  `step_released`, holding ids, file paths and codes;
- one evidence link of kind `agent_run` per criterion the report named (or
  one unassigned link), labelled with the step title, with the files' paths,
  sizes and SHA-256 hashes;
- the files themselves, written through the same path as the Files view
  (quota, project lock, workspace history).

To the person the responsibility belongs to, and nobody else:

- one update on Home and in the Inbox, "Plan step done: ..." or "Plan step
  blocked: ...". The headline is written by code from what was checked; the
  run's own words follow it, then the files (or, when it was blocked, why
  and what the run changed);
- the work item on the Responsibilities page, with what the run used.

**No confirmation receipt is created, read or consumed** by any of this. The
delegation is recorded on the step and in the timeline; the receipts table
holds only what people confirmed.

## Collaborators

A responsibility belongs to one person. A project member who wants their
assistant to carry out plan steps drafts their own responsibility on the
project. That run acts as them, is paid by them (their account budget and
their responsibility's daily budgets), writes files as them, and the step
records them. The update goes to them, not to the project owner. A person
who is not on the project cannot link a responsibility to it.

Shared responsibilities, where one grant acts for several people, are not
built.

## Private knowledge and shared projects

A project is *shared* when it has members or a share link.

- A plan-step run in a shared project is not offered the tools that read
  your private knowledge (`lookupNotes`, `listGeneratedNotes`), whatever the
  responsibility grants.
- For every delegated run: once it has read your private knowledge, a call
  that writes into a shared project (`writeProjectFile`, `runProjectFile`)
  is refused with `PRIVATE_CONTEXT`. In a project that is yours alone the
  write is allowed.
- The run's summary is never copied into the project. The project gets file
  names, sizes, hashes and codes.

## Losing access

If the person the responsibility acts as stops being a member of the
project:

- work that is queued is parked when it is dispatched (`RESOURCE_UNAVAILABLE`,
  waiting on *access*) without calling a model;
- work that is running stops at its next project call, the step goes back to
  *ready* and nothing is published;
- a result that was ready to be recorded is not recorded.

`/forget-me` for that person deletes their runs and work items, removes
their `agent_run` evidence links from other people's plans, clears their id,
run and grant from the steps they carried out, and returns a step they still
held to *ready*.

## Limits

| Limit | Value |
| --- | --- |
| Assistant runs per plan | `budget.maxAgentRuns`, default 3, at most 12 |
| Files a step can require | 8, each a workspace-relative path of at most 300 characters |
| Instructions on a step | 1,500 characters |
| Evidence links on a plan | 40 in total; a step whose links would exceed it fails (`EVIDENCE_LIMIT`) |
| Everything else | The [run limits](delegated_runs.md#budgets-and-limits): 8 tool rounds, 10 minutes, the responsibility's daily budgets |

## Codes

| Code | Where | Meaning |
| --- | --- | --- |
| `AGENT_STEP_DELEGATED` | starting a step by hand (409) | An assistant step is started by a responsibility, not by a person |
| `BAD_STEP_PARAMS` | adding a step (400) | A required file is not a workspace-relative path, or there are too many |
| `PLAN_REVISION_STALE`, `PLAN_NOT_ACTIVE`, `STEP_NOT_ELIGIBLE` | work item, *superseded* | The opportunity is gone |
| `PLAN_STEP_CLOSED` | work item, *cancelled* or *superseded* | A person completed or skipped the step, or the plan ended, while the run worked |
| `PLAN_BLOCKED` | work item, *waiting* | The plan is blocked by another step |
| `PLAN_BUDGET` | work item, *failed* | The plan's assistant runs are used up |
| `VERIFICATION_FAILED`, `STEP_BLOCKED`, `NO_STEP_REPORT`, `STEP_FAILED` | work item, *failed* | The step failed and the plan is blocked |
| `RESOURCE_UNAVAILABLE` | work item, *waiting* | The person no longer has the project |
| `PRIVATE_CONTEXT` | a refused tool call | Private knowledge was read before a write into a shared project |
| `NO_PLAN_STEP` | a refused tool call | `reportStepResult` outside a plan-step run |

Failures are recorded in the work ledger as `assistant_run` with phase
`dispatch` or `verify` and a code only (for a failed check the code is the
detail: `NO_ARTIFACT`, `ARTIFACT_NOT_WRITTEN`, `ARTIFACT_MISSING`,
`ARTIFACT_EMPTY` or `EVIDENCE_LIMIT`).

## Routes and shapes

- Granting: an operation
  `{ "operation": "plan.step.execute", "resource": { "kind": "project", "ids": ["12"] } }`
  on a responsibility whose `projectId` is that project. `paths` is not
  accepted for it.
- `POST /api/app/projects/:slug/mission/steps` accepts `kind: "agent"` with
  `actionParams: { instructions?, artifacts: string[] }`.
- `GET /api/app/projects/:slug/mission`: each step carries
  `authorization` (`human`, `delegated` or `null`), `delegation`
  (`{ actingUserId, runId, responsibilityId, grantRevision }` or `null`) and
  `retryCount`.
- `GET /api/app/assistant/initiatives`: an item for a plan step carries
  `planStep: { id, planRevision }` and `source.kind = "project_plan_step"`.

## Not built yet

Work proposed from what was said in a conversation, stopping queued work
when you change direction in chat, and project boards that read the same
requests as Home (DA-4b); an update shared with everyone on the project;
responsibilities shared between people.
