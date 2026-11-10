# ADR 0029: A process is repaired by a closed list of typed actions, proved by what it records afterwards, and never by what a model says

## Status

Accepted for DA-5c of the
[delegated assistant plan](../delegated_assistant_implementation.md): repair
of a recurring process that keeps failing. It builds on
[ADR 0020](0020-process-assessment-and-incidents.md) (the assessment and the
incident a repair answers), [ADR 0022](0022-process-retirement.md) (pause,
which the direction request reuses), [ADR 0016](0016-delegated-responsibilities.md)
(`authorize()`, `process.repair`, `repairAttempts`),
[ADR 0017](0017-initiatives-updates-processes.md) (canonical updates and
gates) and [ADR 0018](0018-delegated-runs.md) (the run tool table and the
operation journal). Behaviour is documented in
[process_stewardship.md](../process_stewardship.md#repairing-a-process). The
code is `packages/core/services/assistantProcessRepairService.js`, the source
adapter `assistant/sources/processIncident.js`, the run tool
`assistant/runTools/processRepair.js`, the origin module
`assistant/processRepairRun.js`, the `process_repair` descriptor in
`assistantGateDescriptors.js`, and the `repairs.steward()` step at the end of
`assistantIncidentService.reconcile()`.

## Context

DA-5a could say "this process keeps failing" and DA-5b could stop a process
that is no longer needed. Neither could make a failing process work again.
The plan asks for repair as *diagnose, bounded change, outcome validation,
resume and observation*, stopping at a permitted number of attempts with
rollback information, and says that no repair may enable a feature, expand
permissions or rewrite credentials by implication. The exit scenario is that
repair "verifies output freshness and dependent recovery, not just exit
status".

Three things make that harder than it reads:

- **A model's patch is unbounded.** If a run may write "the fix", the fix
  can be a new prompt, a new address, a new schedule or a new script, and
  every one of those is also a way to make the process do something else.
  The grant says *repair*, not *edit*.
- **A model's report is not evidence.** A run that says "fixed" has shown
  that a tool call returned. Whether the process works is a fact about its
  next run.
- **What the plan describes in journey C does not exist.** "Patches the
  owned script" needs a declared set of artifacts a process owns. Contracts
  cannot declare one yet (ADR 0022, "What is deliberately not here").

## Decision

1. **A repair is one of a closed list of typed actions, applied by code.**
   `rerun` runs the process once now with nothing changed. `follow_redirect`
   points a followed source at the address its own server redirects to. A
   model never supplies a value: the address is read from the redirect by
   `followedSourceService.redirectTarget()`, which follows nothing and
   stores nothing. Anything else about a process is not repairable.
2. **Only what can be run on demand and judged afterwards is repairable.**
   Scheduled tasks and followed sources. A watch fires on its event; a
   project trigger's fix is its script; a stalled process is the
   scheduler's problem; a shared-cause incident is an outage that
   re-running each member does not fix. Those stay reported.
3. **A repair answers an incident.** Only the failing member of an open
   `process:<ref>` incident whose newest run failed, on a process that is
   switched on. A repair never switches anything on, so it cannot enable a
   feature or revive what retirement stopped.
4. **`rerun` is not offered for a cause that cannot pass.** A closed pattern
   of code endings (`_REFUSED`, `_FORBIDDEN`, `_NOT_FOUND`, `_GONE`,
   `_LIMIT`, `_NOT_CONFIGURED` and their siblings, `NO_PROVIDER*`,
   `TARGET_*`) removes it. A revoked credential is therefore reported and
   never "repaired", which is how the rule about credentials is kept.
5. **Recorded before it is applied.** One row in
   `assistant_process_repairs` carries the diagnosis code and note, the
   patch, the snapshot it replaces, the processes it affects, the attempt
   number and allowance, the verification contract and the rollback plan,
   and is written before the change and before the launch. A crash between
   them leaves a repair to verify, never an unrecorded change.
6. **Proof is the process's own typed observations after the repair.** A
   marker (the newest observation id, and the newest rows' attempt counts
   and times, with no clock in it) is taken at apply. Verification reads
   what was recorded or re-recorded since: any failed or blocked run fails
   it with that run's code; failed output fails it; a clean run is
   required; fresh output is required where the contract asks for
   freshness and the kind reports output; and every process that was
   blocked by this one at apply must no longer be. No model takes part.
7. **Proved once is not fixed.** A verified repair is `OBSERVING` until the
   next run on the process's own schedule. That run failing fails the
   repair (`RELAPSED`) and rolls it back like any other failure.
8. **Rollback is a compare-and-swap, and the person's later choice wins.**
   The previous address is put back only while the source still has the
   address the repair gave it (`restored`). If the person changed it since,
   it is left (`kept`). `rerun` has nothing to undo (`none`).
9. **Attempts are counted per incident and belong to the grant.** Every
   applied repair counts, whoever applied it. A grant allows
   `budgets.repairAttempts`; unset is 1, the ceiling is 5, and 0 means the
   assistant never applies one. Exhausting them files one request for
   direction (pause it, or leave it running) and nothing more is tried for
   that incident.
10. **The assistant applies a repair only from a delegated run.** A standing
    source adapter, `process_incident`, proposes one initiative per incident
    and attempt for each process the responsibility's `process.repair`
    grants name. The run is offered `repairProcess({ action, diagnosis })`
    and nothing else that writes to a process. `authorize()` checks
    `process.repair` on the exact process at dispatch, with the same
    Attention boundary as pausing. The process comes from the initiative's
    origin, never from an argument.
11. **The run is told typed state only.** Codes, counts, times, the repairs
    available and what will count as proof. The process's name and purpose
    are the person's words and are marked as evidence. Nothing a failing
    process fetched or produced reaches the prompt, so a failing page cannot
    instruct its own repair.
12. **The run does not decide the outcome and is told so.** The tool's
    result says what is known; the instructions forbid calling a process
    fixed unless that result says the run after it worked. The verdict, the
    rollback and the person's update come from the deterministic pass.
13. **Another host is always the person's decision.** A redirect that leaves
    the host is filed as a request showing the address, whatever the grant.
    Approving applies the address that was shown, with no second probe.
14. **Without a grant the steward offers `rerun` once per incident and
    changes nothing.** The offer is a `process_repair` request decided in
    place on Home, in the Inbox and on the Processes list. Approving applies
    it as the person's own act, with one attempt. Declining is remembered
    for the incident.
15. **One update per process.** Proposal, "repairing", "repaired", "held",
    "did not work" and the direction request revise one canonical update
    (`process_repair:<ref>`). The gate's occurrence is the repair row id
    doubled (plus one for the direction request), so each question is a new
    occurrence and a stale card is refused.
16. **A crashed tool call is not applied twice.** The repair row carries the
    run operation's identity under a unique index; the tool's `reconcile`
    finds it.
17. **Behind the pilot gate, and held by stop-all.** The capability is
    `repair`: no offer, no proposal and no dispatch for anyone but the owner
    until the host records the pilot decision. While the host's stop-all is
    on, no repair work is proposed for a run or dispatched, and a repair the
    assistant applied is neither relaunched, judged nor rolled back until it
    is lifted. The steward's offer to the person is still filed, and a
    person's own approval is their act and is not held.

## Defaults taken

The plan fixed none of these. Each is the conservative reading.

| Question | Default | Why |
| --- | --- | --- |
| What a repair may change | Nothing (`rerun`), or one address to where the same server redirects | The smallest set that fixes a real failure without becoming "edit" |
| Redirect to another host | Never applied by the assistant | A different site is a different source |
| Attempts when the grant is silent | 1 | SPEC: "a visible small finite cap" |
| Most attempts a grant may state | 5 | A larger number is read as 5, not refused, so existing grants keep working |
| Time to prove a repair | 60 minutes; with fresh output required, the contract's freshness period between 1 and 24 hours | Long enough for the owning scheduler's next pass, short enough to report the same day |
| Watching for the next normal run | 30 days, then closed without a verdict | Covers a monthly process |
| What the steward offers with no grant | `rerun` only | The one repair that needs no judgement |
| Who is asked at the cap | The owner, once, with *Pause it* / *Leave it running* | SPEC: "asks for direction" |
| Delivery | Requests, a verified repair and a failed one reach the Inbox; "repairing" and "held" are on Home only | The person was just told, or nothing needs them |
| Attention off | Nothing is offered; an applied repair is still checked and undone | Same gate as incidents (ADR 0020), and a change must not be left unproved |
| Ended repairs | Pruned after 180 days; one awaiting an answer is kept | Matches incidents and retirement records |
| "Budget" in the repair record | The attempt allowance. Tokens, searches and compute are the run's (ADR 0018) | One place for each number |

## What is deliberately not here

- **Patching a script, prompt or schedule**, including journey C's "patches
  the owned script". It waits for declared owned artifacts and a decision
  on what a repair grant may edit.
- **Declared `ownedArtifacts` and cleanup under `cleanup.exact`.** Left by
  DA-5b and still open; they need an owner decision on what a process may
  claim to own.
- **Repair of project triggers, watches, stalled processes and
  shared-cause incidents.**
- **A producer of target-ended codes for watches.** A followed source now
  records `TARGET_GONE` for 410; watches still record none.
- **A control for `process.repair` in the responsibility form.** The grant
  is written through the API.
- **A cap on repairs set by the host.** The host's stop-all and the pilot
  gate apply; a number does not exist yet.

## Consequences

- A process kind becomes repairable by adding an entry to `KINDS` with a
  `launch` that asks its owning service for one run, and by recording typed
  observations precise enough to judge. Without both it stays reported.
- A new repair action is a code change with its own patch, snapshot and
  rollback, never a prompt change.
- Followed sources now record `SOURCE_FORBIDDEN`, `SOURCE_NOT_FOUND`,
  `TARGET_GONE` and `SOURCE_UNAVAILABLE` instead of one generic code, and a
  refused redirect carries where it pointed. Health assessment is unchanged
  except that a 410 with a stated purpose makes a retirement candidate.
- `repairProcess` is in the run tool table, so the prompt fingerprint
  changed and the live evaluation was rerun with a repair case
  ([delegated_evaluation.md](../delegated_evaluation.md)). The fingerprint
  now also covers the instructions a repair run is given.
- The first instructions told a repair run to apply a repair "only when the
  cause code makes it likely to help". Against a real model that meant no
  rerun was ever applied: work only reaches a repair run after a run of
  failures, and the model took the run of failures as proof a rerun was
  pointless. Which causes a rerun cannot fix is decided by code
  (`RERUN_POINTLESS`), so the instructions now say so and say that repeated
  failure is expected. The run still declines when the evidence shows only
  the person can fix it, and never repeats a repair that already failed.
- A proposed repair has no route of its own: it is answered through the
  gate, so it is behind the `conversation` pilot capability as well as
  `repair` (ADR 0023). Both are opened by the same pilot decision, so nobody
  is offered a repair they cannot answer; if the capabilities are ever
  decided separately, repair needs a route on the Processes list the way
  pausing has one. `approve` and `direct` also refuse inside a model's tool
  call (`HUMAN_ONLY`).
- `assistantGateService` accepts the surface `processes`, and a run tool's
  `available()` and context now see the initiative's `origin`.
- `assistant_process_repairs` is per-person data and is in the transparency
  report, the account export, erasure and the dormant-data inventory. It
  holds an address and a short model-written diagnosis, which the other
  stewardship tables do not; neither goes to the work ledger.
