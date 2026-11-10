# ADR 0019: Process health and relevance are computed on read from typed observations; only incidents are stored

## Status

Accepted for DA-5a of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
assessment of recurring processes, incidents, the two Attention generators
and the Home Processes card. It builds on
[ADR 0017](0017-initiatives-updates-processes.md) (typed observations,
contracts and canonical updates). Behaviour is documented in
[process_stewardship.md](../process_stewardship.md). The code is
`packages/core/services/assistant/processes/assessment.js` (pure rules),
`assistantProcessService.assess()` (loads their inputs),
`assistantIncidentService.js` (incidents and announcements) and the
`incidents` step of `assistantStewardService.sweep()`.

Nothing in this ADR changes a process. Pause, archive, restore and cleanup
(DA-5b) and repair through runs (DA-5c) are later increments.

## Context

DA-1d left a process catalog whose health and relevance were a hard-coded
`unknown`, and a Home card that counted processes whose latest observation
was a failure. Three things were wrong with stopping there:

- The latest observation is not a judgment. One failed run and a job that
  has failed for a week looked the same, and a job that had silently stopped
  running looked fine because nothing new was recorded.
- "Is it working" and "is it still needed" are different questions with
  different evidence. A single state would have to let one hide the other.
- A message per failure, or per state change, turns one provider outage
  into a dozen notices and a flapping job into a stream of them.

## Decision

1. **Two axes, never one score.** Execution is `healthy`, `degraded`,
   `blocked`, `stalled`, `unreachable` or `unknown`. Relevance is `active`,
   `awaiting_event`, `satisfied`, `superseded`, `dormant`,
   `retirement_candidate` or `unknown`. Every surface carries both, each
   with a machine reason code. Nothing sums or ranks them together.

2. **The rules are pure functions.** `assessProcess()` takes the adapter's
   description, the contract, recent observations, the linked goal's state,
   delivered-result counts and a clock. It reads no database and no model,
   so the same inputs give the same answer and every acceptance scenario is
   a unit test with no fixture.

3. **The assessment is computed on read and stored nowhere.**
   `assess()` runs a bounded number of queries whatever the number of
   processes (one per kind, then contracts, a windowed read of
   observations, linked goals, delivered results, open incidents). There
   is no assessment table to go stale, to migrate or to erase. The cost is
   that every read pays for the computation; the window (80 newest
   observations per process, 90 days) bounds it.

4. **Absence of evidence is `unknown`, not `healthy`.** Health needs a
   typed `ok` verdict. A process with no observations, or with observations
   that carry no verdict, is `unknown`. Relevance needs a stated purpose; a
   process with none is `unknown` whatever else is known.

5. **A run is an occurrence.** Observations are grouped by occurrence key
   before anything is counted, and each occurrence gets one verdict (failed
   over blocked over ok). A retried fire is one run. Output is a separate
   phase, so a run that worked and produced something invalid is `degraded`
   (`OUTPUT_FAILED`), not a failed run.

6. **Stalled comes from a missed time, not from idleness.** A process is
   stalled when its own next-run time has passed by a grace period, or when
   its contract states a cadence and twice that has elapsed. A future next
   run is never overdue. This is what keeps a monthly job healthy in week
   three.

7. **Staleness needs a contract.** `OUTPUT_STALE` applies only when the
   contract states `freshnessSeconds`. With `quietResultOk`, a successful
   check that found nothing counts as fresh. Without a contract there is no
   expectation to miss.

8. **Relevance ends only on a typed fact.** The linked Attention item is
   resolved or abandoned; a watch fired for good; or the process's newest
   observation carries one of the `TARGET_*` codes. A result nobody opened
   is exposed as `signals.resultsIgnored` and changes nothing: it is never
   retirement authority.

9. **Only incidents are stored.** An incident is the one piece of memory
   the assessment cannot recompute: that a problem was already announced,
   and that a recovery is still on probation. `assistant_process_incidents`
   holds one row per cause and occurrence; `..._incident_members` holds the
   processes in it.

10. **One incident per cause.** The key is `cause:<CODE>` when two or more
    processes fail with the same upstream code inside the window, otherwise
    `process:<kind>:<id>`. "Upstream" is decided by the shape of the reason
    code (`PROVIDER_*`, `*_UNAVAILABLE`, `*_RATE_LIMITED` and so on), not by
    a list of providers. A process that depends on a failing one joins that
    incident as a dependent and gets none of its own.

11. **Hysteresis in both directions.** Three failures running open an
    incident. Two clean runs running start a cooldown. A failure inside the
    cooldown reopens the same incident and announces nothing. Only a full
    cooldown resolves it. A later streak is the next occurrence of the same
    key.

12. **One canonical update per incident.** Its identity is
    `process_incident:<id>`. Its wording depends only on who is in the
    incident and whether it is over, so the update service's fingerprint
    makes an unchanged pass publish nothing. A process joining is a
    revision; the resolution is the last revision. Relevance uses
    `process_relevance:<kind>:<id>` with the contract revision and reason as
    its source revision.

13. **Attention reads the stored incident, not the assessment.**
    `process_health` raises one candidate per `OPEN` incident, keyed on the
    incident id. `process_relevance` is keyed on the process, contract
    revision and reason. Both dedupe through `attention_notices` like every
    other generator, and both leave the decision to interrupt to the
    Attention policy.

14. **Downtime is not the process's failure.** The steward's heartbeat
    records since when its passes have followed each other without a gap
    longer than the Home staleness window (15 minutes). A stall counts
    toward an incident for no longer than that, so a schedule that slipped
    while the installation was stopped, paused or being restored opens
    nothing until the process has failed to run through a full day of
    uptime. Failure streaks are not limited this way.

15. **Attention gates memory, not sight.** Incidents are opened and
    announced only for a person with Attention on. The assessment is shown
    to anyone who asks. An incident already open when Attention is turned
    off still runs to resolution, silently, so no row is left open forever.

16. **Home counts processes, not messages.** The Processes card reads
    `counts.notWorking` and `counts.degraded` from the assessment.
    Acknowledging the update about an incident changes the unseen count and
    leaves the health counts alone.

## Defaults taken

The plan left these numbers open. Each is the conservative choice and is a
constant in `assessment.DEFAULTS`:

| Number | Value |
| --- | --- |
| Failures running before blocked and an incident | 3 |
| Clean runs running before recovered | 2 |
| Cooldown before an incident resolves | 24 hours |
| Shared-cause window | 24 hours |
| Schedule grace: cron / poll | 1 hour / 24 hours |
| Stall duration before an incident | 24 hours |
| Missed cadence | 2 x the contract's cadence |
| Event process counts as active | 7 days since it fired |
| One-shot failure stays blocked | 7 days |
| Ignored-results signal | 3 delivered and none opened in 30 days |
| Evidence window | 80 newest observations per process, 90 days |
| Processes assessed | 200 newest of each kind per person |
| Resolved incidents kept | 180 days |

They are constants, not settings, until the DA-6 pilot gives a reason to
vary one.

## What is deliberately not here

- **Any action on a process.** No pause, archive, restore, cleanup or
  repair. The relevance update carries no gate; DA-5b adds the proposal to
  it. A repair attempt (DA-5c) refers to an incident by id.
- **Producers of `TARGET_*` codes.** The codes are defined and assessed; no
  shipped process records one yet.
- **A stored assessment history.** Trends are read from observations.
- **A per-person or per-process override of the defaults.**

## Consequences

- Every list of processes costs the assessment. It is a handful of queries
  per person, and Home, the report and the steward all pay it.
- The classification of a failure as upstream rests on reason-code naming.
  A producer that invents an unconventional code for an outage gets
  per-process incidents instead of one group. New codes should follow the
  prefixes and suffixes listed in the behaviour guide.
- A process with no contract can only ever be `healthy`, `degraded`,
  `blocked`, `stalled`, `unreachable` or `unknown` on execution, and
  `unknown` on relevance. Usefulness judgments need the person to state a
  purpose once.
- Incidents exist only for people with Attention on, so the report and the
  incident list can differ for someone without it: a `blocked` process with
  no incident.
