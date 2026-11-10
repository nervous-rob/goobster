# ADR 0019: A responsibility carries out `agent` steps of a plan people approved and started, under its own authorization record, and never forges a human receipt

## Status

Accepted for DA-4a of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
`agent` plan step, delegated execution of it, and deterministic verification.
It builds on [ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0017](0017-initiatives-updates-processes.md) (initiatives and source
adapters) and [ADR 0018](0018-delegated-runs.md) (the run). Behaviour is
documented in [delegated_plan_steps.md](../delegated_plan_steps.md). The
code is `services/projectMissionService.js` (the step protocol),
`services/assistant/sources/projectPlanStep.js` (where the work comes from),
`services/assistant/planStepRun.js` (dispatch, prompt, verification) and
`services/assistant/runTools/planStep.js` (the `reportStepResult` tool),
all under `packages/core/`.

DA-4b (opportunities derived from conversations, supersession when a person
steers, project boards reading the canonical gates) is not part of this
decision.

## Context

A project Plan (`project_missions`) is approved, started and completed by a
person. Each of those three consumes a confirmation receipt
(`project_mission_approval_receipts`) minted by the portal for a human, bound
to a frozen `planRevision`. Changing an approved plan returns it to `DRAFT`.
Steps of kind `expedition`, `job` and `watch` are started by a person and
follow `READY -> STARTING -> RUNNING` with an attempt key written onto the
child so a crash can adopt it.

DA-3 gave a responsibility a recoverable run with a fixed tool table and a
per-call authority check. It could edit files in a linked project, but it
had no relation to the project's Plan: nothing said which work the people on
the project had agreed to, and a run could not advance a step.

The owner's decision for this increment: a responsibility may carry out
`agent` steps **only inside a plan revision a human approved and started**.
It never approves, starts or finally accepts a plan.

## Decision

1. **A fifth step kind, `agent`.** It names what to do
   (`actionParams.instructions`) and the workspace files it must produce
   (`actionParams.artifacts`). A person cannot press Start on it
   (`AGENT_STEP_DELEGATED`); a person can still complete, skip or retry it.
   Its child is an `assistant_runs` row, linked by `agentRunId` and by the
   attempt key `assistant_run:<runId>` in `executionAttemptId`, so the
   existing `STARTING` adoption and `RUNNING` reconciliation cover it.

2. **A new operation, `plan.step.execute`, on a `project` resource.** It is
   the only thing that lets a run touch a plan. It takes no `paths`. It does
   not include writing files: the step's files are written through
   `file.edit` like any other delegated write, inside that grant's `paths`.
   There is no operation, and no run tool, that approves, starts, edits,
   reviews or completes a plan.

3. **The delegation has its own authorization record.** When a run takes a
   step, `beginDelegatedStep` writes on the step row
   `authorizationKind = 'delegated'`, `grantResponsibilityId`,
   `grantRevision`, `agentRunId` and `startedByUserId` (the acting person),
   and appends a `step_started` timeline event carrying the same ids. A step
   a person started carries `authorizationKind = 'human'`.
   **`project_mission_approval_receipts` is never read, written or consumed
   by delegated execution.** The receipt a person spent to approve and start
   the plan is what makes the step eligible; it is not reused as the
   authority for the run.

4. **Eligibility is checked twice, at proposal and at dispatch, and only the
   second counts.**
   - The source adapter `project_plan_step` proposes one initiative per
     `READY` `agent` step of a plan that is `ACTIVE`, has `approvedAt`, and
     whose `approvedRevision` equals its `planRevision`, for a responsibility
     that is linked to the project and grants `plan.step.execute` on it. The
     initiative records `planStepId` and the approved `planRevision`.
   - At dispatch the run calls `authorize()` for `plan.step.execute`, then
     `beginDelegatedStep` under the project write lock: the acting person is
     still the owner or a member, the plan is `ACTIVE`, its approved and
     current revision both equal the revision the initiative was proposed
     for, the step is still `READY`, and the plan's `maxAgentRuns` budget is
     not spent. A plan that was edited, re-approved at a newer revision,
     cancelled or completed voids the queued work (`PLAN_REVISION_STALE`,
     `PLAN_NOT_ACTIVE`, `STEP_NOT_ELIGIBLE`): the initiative ends
     `SUPERSEDED` and no model is called.
   - Authority that changed on the grant side is already handled by
     ADR 0017 (`REPLAN_REQUIRED` at claim) and ADR 0018 (a paused or revoked
     grant fails `authorize()` and the lease renewal).

5. **A step advances once.** Taking the step is a conditional update on
   `status = 'READY'` inside the project write lock, so two responsibilities
   (the owner's and a collaborator's) cannot both hold it. A resumed run
   that already holds the step continues; a resumed run whose step was
   already settled closes its initiative to match and does no work again.

6. **The model's report is a claim. Code decides.** A plan-step run ends
   with `reportStepResult` (which replaces `finish` for these runs). The
   step is marked `DONE` only if all of these hold, checked without a model:
   - the run reported `done`;
   - `plan.step.execute` is still authorized for the acting person;
   - every file the step requires and every file the report names was
     written by **this run** (read from its operation journal, not from the
     report), is in the workspace now, and is not empty. A report that names
     no file at all fails.

   On success one `agent_run` evidence link is written per success criterion
   the report named (or one unassigned link), with polarity `neutral` and
   provenance `{ stepId, authorization, responsibilityId, grantRevision,
   artifacts: [{ path, bytes, sha256 }] }`.

7. **A failed check is a blocker.** The step becomes `FAILED`, the plan
   becomes `BLOCKED` through the existing path, the initiative ends `FAILED`
   (`VERIFICATION_FAILED`, `STEP_BLOCKED` or `NO_STEP_REPORT`), a
   `work_failures` row records the code, and the person gets a
   "Plan step blocked" update. Nothing is marked completed.

8. **Evidence from a delegated run never counts for a criterion by itself.**
   `neutral` evidence does not move the automatic `supported` / `contested`
   rollup. A person decides what the file shows by linking it `for` or
   `against`, and a person completes the plan with their own receipt. When
   the last step finishes the plan moves to `REVIEW` as it does for any
   step; `REVIEW -> COMPLETED` stays human-only.

9. **Runs as the collaborator, paid by the collaborator.** A responsibility
   is one person's. A project member delegates with their own
   responsibility; the run's actor, owner and payer are that member, the
   files are written as that member, and the step records them. Shared
   responsibilities (one grant acting for several people) are not built.

10. **Private context does not flow into a shared project.**
    - A plan-step run in a project that has members or a share link is not
      offered the tools that read the person's private knowledge
      (`lookupNotes`, `listGeneratedNotes`).
    - For any run, a tool that publishes into a project (`writeProjectFile`,
      `runProjectFile`) is refused with `PRIVATE_CONTEXT` once the run has
      read private knowledge, unless the project is the person's alone
      (`knowledgeTransferService.privateContextAllowed`: they own it, it has
      no members and no share link).
    - The run's own title and summary go only to the person it acted for.
      The project's timeline and evidence hold the step title, file paths,
      sizes, hashes and codes.

11. **Losing access stops the work.** Every project tool call and the
    settle path resolve the project as the acting person. A queued run whose
    person left the project is parked at dispatch (`RESOURCE_UNAVAILABLE`,
    waiting on `access`); a running one halts at its next project call, and
    its step is released to `READY`. Nothing is published for it.

12. **A stopped run gives the step back.** Cancel, pause, revoke, a lost
    lease and a provider failure release the step to `READY` with a
    `step_released` event; they are not blockers. `reconcileRunningSteps`
    is the backstop: a `RUNNING` agent step whose attempt will not continue
    by itself is released, and one whose attempt failed is failed.

## Defaults chosen

These were not settled by an owner decision. Each is the most conservative
reading and can be changed without a schema change.

| Question | Default |
| --- | --- |
| How many agent runs one plan allows | `budget.maxAgentRuns` 3, at most 12 |
| Polarity of evidence a run links | `neutral` |
| What proves a step's result | Files written by this run, present and not empty |
| May a person start an agent step by hand | No. They may complete, skip or retry it |
| Private knowledge in a shared project's plan-step run | Not offered at all |
| Work voided by a plan change | Ends `SUPERSEDED`; proposed again only for the new approved revision |
| A plan that is `BLOCKED` when the run is dispatched | The work waits and looks again after 30 minutes |
| A provider failure during the step | The step is released, not failed |

## What is deliberately not here

- **Opportunities from conversations and supersession on steering** (DA-4b).
- **A project-wide update** for a finished step. The project's people see
  the timeline, the evidence and the files; a shared canonical update
  arrives with project audiences (DA-11).
- **Agent steps that run code or research as their proof.** Verification
  covers files. A step may still use `runProjectFile` when the grant has
  `sandbox.run`; its job is not the evidence.
- **Shared responsibilities.**

## Consequences

- A person on the project still has to look at what was written. The check
  proves that the files exist and came from this run, not that they are
  right.
- A step with no responsibility to carry it out stays `READY`. The Plan view
  says so.
- A collaborator's id is recorded on the owner's plan step while the step is
  held and after it is done. `/forget-me` removes it, deletes that person's
  `agent_run` evidence links and returns a step they still held to `READY`.
