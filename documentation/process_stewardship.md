---
title: Process stewardship (is recurring work working, and is it still needed)
kind: reference
summary: Goobster judges each of your recurring processes - scheduled tasks, project triggers, watches and followed sources - on two separate questions, whether it is working and whether it is still needed, from typed records of what each run did. Repeated failures become one incident per cause, with a recovery period so a flapping process is not announced twice. This stage only observes and reports - it never pauses, repairs or removes a process. Covers the states and what puts a process in each, contracts, incidents, what you are told and where, every default number, what is stored and the routes.
when: Understanding why a process shows as blocked, stalled, degraded or unknown; why Goobster says a process may no longer be needed, or says nothing about one you never open; how many failures open an incident and when it closes; why one outage produced one message; recording a purpose, cadence or dependency for a process; checking what process stewardship stores about you.
tags: [assistant, processes, schedules, health, incidents, attention, home, privacy]
feature: assistant
---

# Process stewardship

You set up recurring work: a scheduled task, a project trigger, a watch, a
followed source. Goobster keeps a record of what each run did, and from that
record answers two questions about each process:

1. **Is it working?**
2. **Is it still needed?**

The two answers are separate. A process can work perfectly and no longer be
needed. A process you depend on can be broken. Neither answer is ever folded
into one score.

**This stage observes and reports. It does not pause, repair, archive or
delete anything, and it does not run a model.** Those actions are planned
(see [What is not here yet](#what-is-not-here-yet)). A process is still
changed only where you made it.

It builds on the process catalog, contracts and typed observations described
in [delegated_responsibilities.md](delegated_responsibilities.md#processes).
The design decisions are in
[ADR 0020](adr/0020-process-assessment-and-incidents.md).

## Where you see it

- **Home.** The Processes card counts the processes that are *not working*
  and the ones *with a problem*. These counts come from the processes
  themselves, so they stay after you mark the message about them reviewed.
  The card opens the report below. See [assistant_home.md](assistant_home.md).
- **Responsibilities page, Processes.** Every process with both answers in
  words, the reason for each, and the incidents still open. Processes that
  are switched off with nothing to report (a watch that has fired, a paused
  task) are folded behind *Show switched off*. It is a report: it has no
  buttons that change a process.
- **What changed and the Inbox.** One message when an incident opens, one
  when it is over, and one when a process may no longer be needed. Each is
  informational and asks nothing of you.
- **Attention.** An open incident, a process that outlived its purpose and
  a review date you set can each be raised once, inside your Attention
  settings and contact budget ([attention.md](attention.md)).

## Is it working?

| State | Meaning |
| --- | --- |
| `healthy` | Its recent runs finished cleanly, and anything its contract expects is being met. |
| `degraded` | It runs, with a problem: a recent failure, a failed output check, or output older than its contract allows. |
| `blocked` | It is not doing its job: it failed three times running, its latest run was stopped, it shares an outage, or it waits on a process that is not working. |
| `stalled` | It did not run when it should have. |
| `unreachable` | It keeps failing because what it acts on could not be found. |
| `unknown` | There is not enough recorded to say. |

`blocked`, `stalled` and `unreachable` together are "not working".

**A run that finished without an error is not evidence of health.** A process
is `healthy` only when a typed observation says a run worked. With no such
record it is `unknown`, and Goobster says so instead of assuming the best.

The checks are applied in this order. The first that matches decides the
state, and its reason code is returned with it.

| Order | Reason code | State | When |
| --- | --- | --- | --- |
| 1 | `ENDED_IN_FAILURE` | `blocked` | The process is off because it ended in failure in the last 7 days (a watch whose turn failed). |
| 1 | `NOT_RUNNING` | `unknown` | The process is off for any other reason. |
| 2 | `TARGET_UNREACHABLE` | `unreachable` | 3 failures running, and the newest failure code ends in `NOT_FOUND`, `GONE`, `UNREACHABLE`, `MISSING` or `DELETED`. |
| 2 | `FAILING_REPEATEDLY` | `blocked` | 3 failures running, any other code. |
| 3 | `REPORTED_BLOCKED` | `blocked` | The newest run recorded `blocked`. |
| 4 | `SCHEDULE_OVERDUE` | `stalled` | Its next run time is more than 1 hour in the past (24 hours for a followed source). |
| 4 | `CADENCE_MISSED` | `stalled` | Its contract states a cadence and nothing has run for more than twice that long. |
| 5 | `RECENT_FAILURE` | `degraded` | The newest run failed (fewer than 3 running). |
| 6 | `RECOVERING` | `degraded` | It ran cleanly once after 3 or more failures. One more clean run counts as recovered. |
| 7 | `OUTPUT_FAILED` | `degraded` | The run worked and what it produced failed its check. |
| 8 | `OUTPUT_STALE` | `degraded` | Its contract states a freshness and it has produced nothing new for longer than that. |
| 9 | `NO_OBSERVATIONS`, `NO_VERDICT` | `unknown` | Nothing is recorded, or nothing recorded says whether a run worked. |
| 10 | `RUNNING_NORMALLY` | `healthy` | None of the above. |

Two more are applied after every process has been judged on its own:

| Reason code | State | When |
| --- | --- | --- |
| `SHARED_CAUSE` | `blocked` | Two or more of your processes failed with the same upstream cause in the last 24 hours ([One outage](#one-outage-one-incident)). |
| `DEPENDENCY_BLOCKED` | `blocked` | It depends on a process that is not working. This follows chains. |

What the rules mean in practice:

- **Idle is not stale.** A monthly job that last ran three weeks ago is
  `healthy`: its next run is still ahead. A process is `stalled` only when a
  scheduled time has passed, or when you stated a cadence and it was missed.
- **Quiet can be the right result.** A monitor that checks and finds nothing
  new is `healthy`. If its contract states a freshness and sets
  `quietResultOk`, a successful check counts as fresh even when nothing
  changed.
- **Working is not the same as producing.** A daily import that runs without
  error but has brought in nothing new for longer than its contract's
  freshness is `degraded` (`OUTPUT_STALE`). This check needs a contract; with
  none, the import is `healthy`.
- **Retries are one run.** A run is an *occurrence* (one scheduled fire time,
  one source job, one day of polls). An occurrence that failed and was then
  retried successfully counts once, by its final result.

## Is it still needed?

| State | Meaning |
| --- | --- |
| `active` | It has a stated purpose and nothing says that purpose is over. |
| `awaiting_event` | It waits for an event and has not fired in the last 7 days. This is normal for something that waits. |
| `retirement_candidate` | Its purpose is over and it is still switched on. |
| `satisfied` | Its purpose was met and it is off. |
| `superseded` | Its purpose went away and it is off. |
| `dormant` | It is off, and nothing says its purpose is over. |
| `unknown` | It has no stated purpose. |

**A process with no stated purpose is always `unknown`.** Goobster does not
guess why something exists, so it does not guess whether it is still useful.
Record a purpose in the process's contract to have this question answered.

A purpose is over when one of these typed facts is true:

| Reason code | Fact |
| --- | --- |
| `GOAL_RESOLVED`, `GOAL_ABANDONED` | The Attention item the process is linked to is resolved or abandoned. The link is the contract's `attentionItemId`, or the item a watch was registered for. |
| `FIRED_FOR_GOOD` | A watch has fired as many times as it was set to. |
| `TARGET_MERGED`, `TARGET_CLOSED`, `TARGET_DONE`, `TARGET_DELETED`, `TARGET_GONE`, `TARGET_SUPERSEDED` | The process's own newest observation carries this reason code. No process shipped today records these codes; they are the contract for adapters that can know their target ended, such as a watch on a branch. |

**Results you did not open are a weak signal and nothing more.** When a
process delivered 3 or more results to your Inbox in the last 30 days and you
opened none of them, the report notes it (`signals.resultsIgnored`). It does
not change the state, produces no message and no Attention candidate, and is
never a reason to retire the process. Unread is not the same as unwanted.

A review date you set on a contract (`reviewAt`) is reported as due once it
has passed (`signals.reviewDue`).

## Contracts

A contract records why a process exists and what to expect of it. It is
described in
[delegated_responsibilities.md](delegated_responsibilities.md#processes).
These fields change the assessment:

| Field | Effect |
| --- | --- |
| `purpose` | Required for any answer to "is it still needed". |
| `attentionItemId` | The goal it serves. When that goal is resolved or abandoned, the purpose is over. |
| `expectedCadenceSeconds` | Enables `CADENCE_MISSED`. |
| `freshnessSeconds` | Enables `OUTPUT_STALE`. |
| `quietResultOk` | With `freshnessSeconds`: a successful check that found nothing counts as fresh. |
| `criticality` | `low`, `normal` or `high`. Sets how strongly an incident may be raised through Attention. |
| `reviewAt` | Reported as due once it has passed. |
| `dependsOn` | Up to 8 references (`"automation:12"`) to your own processes that this one cannot work without. |

A project trigger that reacts to another trigger depends on it without
anything being recorded.

## What each kind of process records

| Kind | Occurrence | Phases recorded |
| --- | --- | --- |
| Scheduled task (`automation`) | The fire time it claimed | `outcome` |
| Project trigger (`project_trigger`) | The source job it reacted to, or its fire time | `dispatch` when it launches, then `execution` and, where the job has an output contract, `output` when the job settles |
| Watch (`attention_watch`) | Each fire | `execution`; `dispatch` when an event was dropped because too many turns were running |
| Followed source (`followed_source`) | One per UTC day | `execution` for the last check of the day, and `output`: a change found during the day is kept even when later checks find nothing |

A project job that finishes but fails its output contract is recorded as a
run that worked with an output that failed. The process is `degraded`, not
`blocked`.

A followed source is only checked while your Attention covers research. While
it does not, the source is treated as off, not as stalled.

Observations hold machine codes only. No prompt, reply, address, output or
error text is stored in them.

## Incidents

An **incident** is Goobster remembering that something is not working, so
that it tells you once and can tell you when it is over.

An incident opens when a process has:

- failed **3 times running**, or
- been stalled for **24 hours**.

One failure, or two, makes a process `degraded` on the report and opens
nothing.

### One outage, one incident

Some failure codes name a cause outside the process: a provider, a
credential, a quota, a network, a paused installation. They start with
`PROVIDER`, `UPSTREAM`, `NETWORK`, `DNS`, `CREDENTIAL`, `AUTH`, `QUOTA`,
`ACCOUNT`, `INSTANCE`, `GATEWAY` or `NO_PROVIDER`, or end with `_UNAVAILABLE`,
`_OUTAGE`, `_TIMEOUT`, `_RATE_LIMITED`, `_NOT_CONFIGURED`, `_EXHAUSTED`,
`_PAUSED` or `_BUDGET`.

When two or more of your processes fail with the same such code within 24
hours, and they have 3 failures between them, they share **one** incident and
you get one message. A process that later fails with the same code joins it.
Two processes failing with a code that is not upstream (for example each with
its own `RUN_FAILED`) are two incidents.

A process that depends on a failing one joins that incident as a dependent
("cannot run until it does"). It does not get an incident of its own.

### Recovery

1. **Open.** While any process in the incident is failing.
2. **One clean run is not recovery.** After 1 clean run the incident stays
   open. After **2 clean runs** from each failing process it moves to
   recovering. A process that had stalled, with no failures, starts
   recovering as soon as it runs again.
3. **Recovering, for 24 hours.** Nothing is announced. A failure during this
   time reopens the *same* incident without a new message, so a process that
   flaps is one incident and one message however often it flaps.
4. **Resolved.** After 24 hours without a failure. The incident's message is
   revised once to say it is over.

A failure streak after an incident is resolved is a new incident.

An incident whose processes were all deleted or switched off closes after the
same 24 hours without a "working again" message.

### After this installation was itself not running

A schedule that slipped while Goobster was stopped, paused or being restored
is not the process's fault. A stall counts toward its 24 hours only for time
in which this installation was itself running. Goobster's periodic pass runs
every five minutes; when more than 15 minutes separate two passes, the count
starts again from the later one. So after downtime, a process that is still
not running a full day later gets a stall incident, and one that catches up
gets none.

Failures are different: three failed runs are three failed runs, whenever
they happened.

### Who gets incidents

Incidents are opened and announced only for people who have **Attention
turned on**. With Attention off, the report still shows how each process is
doing, and no incident is opened and nothing is sent. An incident that was
already open when you turned Attention off still runs to its end, silently.

## What you are told

| Event | Message | Repeats |
| --- | --- | --- |
| An incident opens | "*Name* keeps failing", "*Name* has stopped running" or "*N* of your processes are blocked by the same problem" | Revised when another process joins. Not repeated otherwise. |
| An incident is resolved | The same message, revised: "*Name* is working again" | Once. |
| A process's purpose is over and it is still on | "*Name* may no longer be needed" | Once per contract revision and reason. |

Each message is one canonical update ([delegated_responsibilities.md](delegated_responsibilities.md#updates)),
filed in your Inbox with no Discord echo, and shown under What changed until
you review it. Every one ends with "Nothing was changed." because nothing
was.

Two Attention generators read the same records:

| Generator | Raises | Key |
| --- | --- | --- |
| `process_health` | One candidate per open incident. Not while it is recovering. | The incident, so a group of failures is one candidate and a reopened incident is not a second one. |
| `process_relevance` | A process whose purpose is over while it is still on; a review date that has passed. | The process, its contract revision and the reason; or the process and the review date. |

Whether a candidate interrupts you, waits in the Inbox or is dropped is
decided by your Attention policy, as for every other candidate.

## Defaults

These numbers were not fixed by the plan. Each is the conservative choice:
slower to alarm, slower to declare recovery, and never automatic. They are
constants in `packages/core/services/assistant/processes/assessment.js`
(`DEFAULTS`), not settings.

| Number | Default | Used for |
| --- | --- | --- |
| Failures before blocked and an incident | 3 running | `FAILING_REPEATEDLY`, opening an incident |
| Clean runs before recovered | 2 running | Leaving `RECOVERING`, starting the cooldown |
| Cooldown before an incident is resolved | 24 hours | A failure inside it reopens the same incident |
| Shared-cause window | 24 hours | Failures with one upstream code are one outage |
| Schedule grace, cron | 1 hour | `SCHEDULE_OVERDUE` |
| Schedule grace, followed source | 24 hours | `SCHEDULE_OVERDUE` |
| Stall before an incident | 24 hours | Opening a stall incident |
| Missed cadence | 2 x the contract's cadence | `CADENCE_MISSED` |
| Event process counts as active | Fired in the last 7 days | `active` or `awaiting_event` |
| One-shot failure stays blocked | 7 days | `ENDED_IN_FAILURE` |
| Ignored results | 3 delivered, none opened, in 30 days | The weak signal only |
| Evidence considered | The newest 80 observations per process, from the last 90 days | Every assessment |
| Processes assessed | The newest 200 of each kind per person | Every assessment |
| Downtime gap | 15 minutes between two passes | Restarting the 24-hour stall count |
| Resolved incidents kept | 180 days | Retention |

## What is not here yet

- **Pause, archive, restore and cleanup** of a process by Goobster (planned
  as DA-5b). The "may no longer be needed" message is information; it carries
  no proposal and no button.
- **Repair** (planned as DA-5c). An incident is reported, not fixed.
- **Target-ended codes.** No shipped process records `TARGET_MERGED` and its
  siblings yet. A watch becomes a retirement candidate today through its
  linked goal being resolved, or by having fired for good.
- **Other kinds of recurring work.** Reminders and recurring research are not
  in the process catalog. `services/scheduledWorkRegistry.js` records the
  reason for each kind that is left out
  ([operator_schedules.md](operator_schedules.md#adding-a-new-kind-of-scheduled-work)).

## What is stored

| Table | Holds |
| --- | --- |
| `assistant_process_observations` | Typed outcomes, codes only. Kept 90 days. |
| `assistant_process_contracts` | Your contracts, including `dependsOn`. |
| `assistant_process_incidents` | One row per incident: its key (`cause:<CODE>` or `process:<kind>:<id>`), occurrence number, status, cause code, criticality, when it opened, started recovering and resolved, and its message. |
| `assistant_process_incident_members` | The processes in each incident: reference, the process's name when it joined, role (`failing` or `dependent`) and state. |

The assessment itself is not stored. It is computed from these records each
time it is read, so it is never out of date and there is no state to repair.

Resolved incidents and their members are removed 180 days after they were
resolved. Open and recovering incidents are never pruned.

## Portal API

All routes act as the signed-in person and are reads unless noted. With the
feature off the prefix answers `FEATURE_UNAVAILABLE`.

| Route | Returns |
| --- | --- |
| `GET /api/app/assistant/processes` | `processes` (each with `assessment` and `incident`), `counts` per state (`notWorking`, `degraded`, `retirementCandidates`, `reviewDue` and one per execution state), and `incidents` that are open or recovering, with their members. |
| `GET /api/app/assistant/processes/:kind/:id` | One process with its contract, recent observations, `assessment` and `incident`. |
| `PUT /api/app/assistant/processes/:kind/:id/contract` | Writes the contract. `dependsOn` must name your own processes; a process cannot depend on itself. |

`assessment` has this shape:

```json
{
  "execution": "blocked",
  "relevance": "unknown",
  "purposeKnown": false,
  "reasons": { "execution": "FAILING_REPEATEDLY", "relevance": "PURPOSE_UNKNOWN" },
  "signals": { "reviewDue": false, "resultsIgnored": false },
  "health": {
    "causeCode": "RUN_FAILED", "upstream": false, "failRun": 3, "okRun": 0, "priorFailRun": 0,
    "overdueSeconds": null, "lastOkAt": "2026-11-09T03:00:04.000Z", "lastFailureAt": "2026-11-10T03:00:05.000Z",
    "lastFreshAt": null, "blockedBy": null, "sharedCause": null
  }
}
```

In `GET /api/app/home`, the `processes` component carries `blocked` (not
working) and `degraded` as separate counts, and its `state` can be
`degraded`.

## Privacy

Incidents and their members are personal data, like the observations and
contracts they are built from. The transparency report counts them, the
account export includes them, and `/forget-me` deletes them. This works when
the feature is off. An incident row holds codes, times and the names you
gave your processes; it holds no prompt, output, address or error text.

## Turning it off

Process stewardship is part of the `assistant` feature. With the feature off
nothing is observed, assessed, opened or announced, and the data is kept.
With the feature on and Attention off, the report works and nothing is
opened or sent.
