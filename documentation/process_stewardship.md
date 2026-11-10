---
title: Process stewardship (is recurring work working, and is it still needed)
kind: reference
summary: Goobster judges each of your recurring processes - scheduled tasks, project triggers, watches and followed sources - on two separate questions, whether it is working and whether it is still needed, from typed records of what each run did. Repeated failures become one incident per cause, with a recovery period so a flapping process is not announced twice. A process can be paused, archived, restored and cleaned up in separate steps - by you, or by Goobster only where a responsibility you activated names that process. Archiving never deletes, and a cleanup removes only the exact rows it showed you first. A process that keeps failing can be repaired with one of two typed actions - run it once more, or point a followed source at the address it now redirects to - which you approve, or which Goobster applies only under a responsibility that names that process; the repair is checked against what the next run records, undone if it fails, and stops at a small number of attempts. Covers the states and what puts a process in each, contracts, incidents, retiring a process, repair, what you are told and where, every default number, what is stored and the routes.
when: Understanding why a process shows as blocked, stalled, degraded or unknown; why Goobster says a process may no longer be needed, or says nothing about one you never open; how many failures open an incident and when it closes; why one outage produced one message; recording a purpose, cadence or dependency for a process; pausing, archiving, restoring or cleaning up a process and knowing what each step keeps; why Goobster paused a process, or asked instead of pausing it; why an archived task cannot be switched on; why Goobster offered to run a failing process once more, what approving that does, how a repair is checked and undone, why it stopped trying, or why it asked before following a redirect to another site; checking what process stewardship stores about you.
tags: [assistant, processes, schedules, health, incidents, retirement, archive, cleanup, repair, attention, home, privacy]
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

A process that is no longer needed can be **retired in steps**: paused, then
archived, then cleaned up. Each step is a separate decision, each can be
undone except the last, and none of them deletes the process itself
([Retiring a process](#retiring-a-process)).

A process that keeps failing can be **repaired**, in one of two fixed ways:
run it once more, or point a followed source at the address its server now
redirects to. A repair is checked against what the process itself records
afterwards, undone if it fails, and tried a small number of times
([Repairing a process](#repairing-a-process)).

**Judging a process, opening an incident, retiring a process and checking a
repair never run a model.** A model is involved in one place only: a
delegated run, under a responsibility that names the process, chooses which
of the two repairs to apply. What a process does is still edited where you
made it.

It builds on the process catalog, contracts and typed observations described
in [delegated_responsibilities.md](delegated_responsibilities.md#processes).
The design decisions are in
[ADR 0020](adr/0020-process-assessment-and-incidents.md) (assessment and
incidents) and [ADR 0022](adr/0022-process-retirement.md) (pause, archive,
restore and cleanup) and [ADR 0029](adr/0029-process-repair.md) (repair).

## Where you see it

- **Home.** The Processes card counts the processes that are *not working*
  and the ones *with a problem*. These counts come from the processes
  themselves, so they stay after you mark the message about them reviewed.
  The card opens the report below. See [assistant_home.md](assistant_home.md).
- **Responsibilities page, Processes.** Every process with both answers in
  words, the reason for each, and the incidents still open. Each row has the
  actions that apply to it now: *Pause*, *Resume*, *Archive*, *Restore*,
  *Keep it running* and *Clean up…*. A paused process says who paused it and
  when. A process with a repair says where the repair stands, and carries
  its question when it has one. Processes that were switched off where you made them, with nothing to
  report (a watch that has fired, a task you turned off), are folded behind
  *Show switched off*. Archived processes are behind *Show archived* and are
  not counted with the rest.
- **What changed and the Inbox.** One message when an incident opens and one
  when it is over; these are informational. One message when Goobster paused
  or archived a process for you, and one, revised as it goes, about a repair.
- **Needs you.** When a process may no longer be needed and Goobster may not
  pause it, it asks you, once. The request has two buttons on Home and in the
  Inbox, *Pause it* and *Keep it running*
  ([assistant_home.md](assistant_home.md#deciding-a-request-where-it-is-shown)).
  The same two actions are on the Processes list, and either place answers
  it. A repair that waits for you, and a repair that has used up its
  attempts, are asked the same way
  ([Repairing a process](#repairing-a-process)).
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
| 1 | `ARCHIVED` | `unknown` | The process is archived. It is not judged, counted or part of an incident. |
| 1 | `PAUSED` | `unknown` | The process was paused through stewardship. |
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
| `dormant` | It is off, and nothing says its purpose is over. The reason code says how: `PAUSED`, `ARCHIVED` or `NOT_RUNNING`. |
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

## Retiring a process

Retirement has four stages. Each transition is its own decision.

```text
running  ->  paused  ->  archived  ->  cleaned up
               |             |
               v             v
            resumed       restored (comes back paused)
```

| Step | What it does | What it never does |
| --- | --- | --- |
| **Pause** | Stops the process from starting anything new. | Stop work that had already started (see below). Delete anything. |
| **Resume** | Switches a paused process back on, after checking it still can run. | Replay what happened while it was paused. |
| **Archive** | Puts a paused or switched-off process away. It cannot be switched on, here or where you made it, until it is restored. | Delete the process, its settings, its purpose, its history or its results. |
| **Restore** | Brings an archived process back, **paused**. | Switch it on. Resume is a separate step. Bring back what a cleanup removed. |
| **Clean up** | Removes what the archived process recorded for itself, from an exact list you are shown first. | Remove the process, its purpose, anything you kept, or anything delivered to you. |

A process must be paused or already off before it can be archived, and
archived before it can be cleaned up. The stages cannot be skipped.

### What pause does to work already under way

Pausing changes the process in the same write that its scheduler uses to
claim a run, so a run cannot start behind the pause. Work that had already
started is treated in a fixed way per kind, and the pause tells you how much
there was:

| Kind | Work already started | What happens to it |
| --- | --- | --- |
| Scheduled task | A run that has started and not finished (counted from its own start and finish records, for up to an hour) | It **finishes**, delivers its result and is recorded. |
| Project trigger | A project job it launched that is still running, or a launch being dispatched | It **finishes**. Events that were waiting to be retried are **dropped** and recorded as skipped. |
| Watch | A turn in progress | It **finishes**. The watch does not re-arm while paused. |
| Followed source | A check that is fetching | It is **dropped**: whatever it fetches is not stored. |

A paused watch keeps its expiry. If it expires or reaches its fire limit
while paused, there is nothing left to resume, and it can only be archived.

### What resume checks

Resume is checked at the moment you press it, not when the process was
paused:

- You must still have access to the project it belongs to
  (`RESOURCE_UNAVAILABLE` otherwise).
- Every process it depends on must be switched on (`DEPENDENCY_BLOCKED`
  otherwise, naming them).
- A process that was switched off where you made it, and not paused here, is
  switched back on there (`NOT_PAUSED_HERE`).

**Events that settled while a project trigger was paused are not replayed.**
On resume each is recorded as a skipped delivery ("settled while the trigger
was paused") and the trigger starts with the next event. A scheduled task
resumes at its next scheduled time; missed times are not made up.

If you switch a paused process back on where you made it, the record here
follows: it shows as running again and nothing fights the change.

### What archive keeps

Archive keeps the definition row in the table it has always lived in, with
its settings, its contract, its observations, its Inbox results and, for a
project trigger, its delivery history and the jobs it started. It also records
how the process stood when it was archived: its two states, their reason
codes and the times of its last run, last clean run and last failure. No
output or text is recorded.

An archived process cannot be switched on from anywhere: the portal,
`/automation`, the tools Goobster uses in chat and the followed-sources page
all answer that it is archived and must be restored first. You can still
delete it where you made it; that is your own delete and is not undone by
anything here.

Other processes that depend on it are named when you pause or archive it.
They are not changed.

### What cleanup removes

Cleanup applies only to an archived process, and only what that one process
derived for itself:

| Removed | For |
| --- | --- |
| Its recorded observations (the typed outcome rows) | Every kind |
| Fetched entries that you did not keep and that no research run was started from | Followed source |
| The stored copy of the page and its cache markers. The source starts from a fresh baseline if it is ever restored and checked again. | Followed source |

| Never removed | |
| --- | --- |
| The process itself and its settings | |
| Its contract (purpose, cadence, dependencies) | |
| Results delivered to your Inbox | |
| Entries you kept, and entries a research run was started from | |
| A project trigger's delivery history and the project jobs it started | |
| Anything in a project workspace, your knowledge, or another process | |

It works in two steps, and the second cannot do more than the first showed:

1. **Preview.** Goobster freezes the exact row ids it would remove into a
   manifest, counts what it will leave, and shows you both. Nothing is
   removed. The manifest is good for **1 hour**.
2. **Apply.** You confirm that manifest. Goobster removes exactly the rows it
   names. Each delete repeats the ownership test, so a row that is no longer
   yours, was kept since the preview or belongs to a process that was restored
   is skipped, and the result says how many were skipped.

The apply is refused, and you are asked to preview again, when:

| Code | Why |
| --- | --- |
| `MANIFEST_REQUIRED` | No previewed manifest was named. |
| `MANIFEST_NOT_FOUND` | No preview with that id or hash exists for this process. |
| `MANIFEST_MISMATCH` | The hash sent is not the one that was previewed. |
| `MANIFEST_EXPIRED` | More than an hour has passed. |
| `MANIFEST_STALE` | The process, its contract or its stage changed since the preview (it was restored, renamed, rescheduled or had its purpose edited). |
| `DEPENDENTS_EXIST` | Another process of yours that is not archived depends on this one. Archive it or remove the dependency first. |
| `ARCHIVE_FIRST` | The process is not archived. |

One manifest names at most 5,000 rows of each type. When there are more, the
preview says so and a second cleanup takes the rest. Applying the same
manifest twice removes nothing the second time.

What a cleanup removed is gone. Restoring the process afterwards brings back
the definition, paused, and says what was not restored.

### When Goobster does it for you

On its periodic pass, with no model involved, Goobster looks at each process
whose purpose is over while it is still switched on (a
`retirement_candidate`). What it does depends on what you have granted.

**With no grant, it asks and changes nothing.** You get one request under
Needs you: "*Name* may no longer be needed", with *Pause it* and *Keep it
running*. It is answered when you pause the process, there or on the
Processes list, or when you choose *Keep it running*. *Keep it running* is
remembered for that purpose and that reason, so you are not asked again
unless the contract changes. A request you answer in one tab is refused as
changed (`STALE_GATE`) if you press it again in another.

**It pauses the process itself only when all of these hold:**

1. A responsibility of yours is `ACTIVE` and grants `process.pause` on
   exactly this process (`{ "kind": "process", "ids": ["automation:5"] }`).
   There is no wildcard.
2. Your Attention boundaries allow Goobster to act on schedules ahead of
   time: in Settings, *Boundaries by category*, *Compute ahead* is ticked for
   *Schedule & tasks*. By default it is not, so a grant alone changes
   nothing until you tick it. The refusal code is `ATTENTION_BOUNDARY`.
3. No other process of yours that is switched on depends on it.
4. You have not said *Keep it running* for this purpose and reason.
5. The grant is checked again immediately before the pause
   ([how authority is checked](delegated_responsibilities.md#how-authority-is-checked)).
6. The host has not stopped delegated work
   ([Stop all](delegated_operations.md#stop-all)). While it is stopped
   Goobster pauses and archives nothing and asks you instead; what you do
   yourself on the Processes list is not held. After the host resumes, a
   grant that still covers the process applies on the next pass.

When it pauses, it tells you once under What changed: what ended, which
responsibility it acted under, how many runs were left to finish, that
nothing was deleted, and that you can resume it from Processes. If you resume
it, that is your answer and it is not paused again for the same reason.

**It archives only what it paused itself as a retirement**, and only when the
process has stayed paused for **7 days**, its purpose is still over, and a
responsibility grants `process.archive` on exactly that process (checked
the same way). A pause grant never archives. A process you paused yourself is
never archived for you.

**It never** resumes, restores or cleans up a process, never deletes one, and
never treats results you did not open as a reason to pause anything. Requests
and automatic pauses, like incidents, happen only for people with Attention
turned on.

## Repairing a process

A repair is an attempt to make a process that keeps failing work again. It
is deliberately small.

### What a repair can be

There are two repairs, and no others:

| Repair | What it does | For |
| --- | --- | --- |
| `rerun` | Runs the process once now, with nothing about it changed. | Scheduled tasks and followed sources |
| `follow_redirect` | Points a followed source at the address its own server now redirects to. | A followed source failing with `REDIRECT_REFUSED` |

A repair never edits a prompt, a schedule, a script or a contract, never
touches a credential or a connection, never changes a grant, and never
switches anything on: a process that is switched off, paused or archived is
not repaired. The new address of a followed source is read by Goobster from
the redirect itself. It is never text a model supplied.

`rerun` is not offered when running it again cannot change the answer: when
the failure code says the other side refuses, the thing is gone, a limit was
reached or a setting is missing (codes ending in `_REFUSED`, `_DENIED`,
`_FORBIDDEN`, `_NOT_FOUND`, `_GONE`, `_MISSING`, `_DELETED`, `_TOO_LARGE`,
`_LIMIT`, `_BUDGET`, `_QUOTA`, `_EXHAUSTED`, `_PAUSED`, `_NOT_CONFIGURED`,
`_DISABLED`, `_INVALID`, or starting `NO_PROVIDER` or `TARGET_`). For those
the incident is reported and what to do is yours.

### What can be repaired

A process can be repaired only while all of these hold:

- it is a scheduled task or a followed source;
- it is switched on;
- it is the failing process of an **open** incident of its own
  (`process:<kind>:<id>`), and its newest run failed.

So these are reported and not repaired: project triggers (the fix is in the
script), watches (they fire on an event and cannot be run on demand), a
process that has **stopped running** (`SCHEDULE_OVERDUE`, `CADENCE_MISSED`:
that is the scheduler's problem, not the process's), and processes blocked by
**one shared cause** (an upstream outage is not fixed by running each of them
again). A process whose incident is recovering is left to recover.

### Who may repair

**You.** With no grant, Goobster's periodic pass offers the one repair that
needs no judgement, `rerun`, once per incident, as a request under Needs you:
"*Name* keeps failing: run it once more?" with *Run it once now* and *Leave
it*. Nothing is run or changed until you approve. Approving applies the
repair as your own act; *Leave it* means it is not offered again for that
incident. The request is on Home, in the Inbox and on the process's row in
Processes, and answering it in one place answers it everywhere. It is
withdrawn without a message if the process stops failing that way first.

**Goobster, under a responsibility you activated.** It applies a repair
itself only when all of these hold:

1. A responsibility of yours is `ACTIVE` and grants `process.repair` on
   exactly this process (`{ "kind": "process", "ids": ["followed_source:12"] }`).
   There is no wildcard.
2. Its `repairAttempts` budget is at least 1 (the default; see
   [Attempts](#attempts)).
3. Your Attention boundaries allow Goobster to act on schedules ahead of
   time (*Compute ahead* for *Schedule & tasks*), as for pausing. The
   refusal code is `ATTENTION_BOUNDARY`.
4. The host has not stopped delegated work, and repair is available to your
   account ([Stop all and the pilot](#stop-all-and-the-pilot)).

Then the open incident becomes a piece of work for that responsibility
([delegated_responsibilities.md](delegated_responsibilities.md#initiatives)),
and a delegated run ([delegated_runs.md](delegated_runs.md#repairing-a-process))
is given the typed record of the failure - states, codes, times, the
process's name and purpose - and one tool, `repairProcess`, with which it
picks one of the repairs that apply and writes a short diagnosis. The grant
is checked again at that call. The run cannot name a different process, a
different address or a different kind of change: the process comes from the
incident, and the tool accepts only the action and the diagnosis.

**Another site is always your decision.** When a redirect leads to a
different host, Goobster does not follow it, whatever it was granted. It
files the request "*Name* has moved: use its new address?", showing the
address, with *Use the new address* and *Leave it*. Approving points the
source at the address you were shown. A redirect within the same host is
followed under a grant.

### How a repair is checked

Before anything is touched, the repair is recorded: what it changes, what it
replaces (the rollback plan), the processes it affects (itself and the ones
that depend on it), which attempt it is and how many are allowed, and what
will count as proof. Then the run is started: a scheduled task is made due
now and runs through its normal scheduler; a followed source is checked
once, under the same one-per-minute limit as your own *Check now*.

**Proof is read from the typed observations the process records after the
repair. It is never a model's opinion, and never the exit status alone:**

- a run that failed or was blocked fails the repair, with that run's code;
- a run whose output failed fails the repair;
- a clean run is required;
- where the process's contract asks for fresh output (`freshnessSeconds`
  set, `quietResultOk` not set, and the kind reports output), the output must
  be fresh: a clean run that produced nothing new is not yet proof;
- every process that was blocked by this one when the repair was applied must
  no longer be blocked by it (`DEPENDENTS_STILL_BLOCKED` otherwise).

A repair waits for that proof for **60 minutes**, or where fresh output is
required for the contract's freshness period, at least an hour and at most a
day. After that it has failed with `VERIFY_TIMEOUT`.

**Then it is watched.** A repair that was proved once is "Repaired", and
stays watched until the process's next run on its own schedule. If that run
works, the repair held. If it fails, the repair failed (`RELAPSED`) and is
undone like any other failure. If no run comes within 30 days the record is
closed without a verdict.

### What happens when a repair fails

What it changed is put back, where that is still safe:

| Rollback | Meaning |
| --- | --- |
| `none` | Nothing was changed (`rerun`), or the change never landed. |
| `restored` | The followed source has its previous address again. |
| `kept` | You changed the address again after the repair, so your choice stands and nothing is put back. |

You are told what was tried, why it failed and what was put back. A source
pointed at a new address starts from a new baseline: its first check there
records a starting point and raises nothing.

If the process is switched off before a repair could be proved, the repair
is closed and its change put back.

Everything a repair files (the offer, what was done, how it went, the
question at the attempt limit) is on Home and in the Inbox. What a repair
under a responsibility files also follows that responsibility's
[interruption rule](delegated_delivery.md#the-interruption-rule): it can go
in the day's digest, and under `immediate` an open question can contact you
once. An offer made with no grant belongs to no responsibility and never
leaves the portal.

### Attempts

Each incident has a small number of repair attempts, counting every repair
that was applied, yours and Goobster's alike.

- A grant allows `repairAttempts` attempts per incident: **1** when the
  responsibility does not say, **5** at most. `0` means Goobster never
  applies a repair under that responsibility and offers `rerun` to you
  instead.
- With no grant, one attempt, yours to approve.

When the attempts are used up and the process is still failing, Goobster
stops and asks you once, under Needs you: "*Name* still fails after *N*
repair attempts", with *Pause it* and *Leave it running*. *Pause it* is the
ordinary pause ([Retiring a process](#retiring-a-process)): nothing new
starts, nothing is deleted, and you can resume it. *Leave it running* leaves
it failing as it is. Either way nothing more is tried for that incident. The
question goes away by itself if the process starts working again. A new
incident, later, has its own attempts.

### Stop all and the pilot

- **Repair is a pilot capability** (`repair`,
  [delegated_operations.md](delegated_operations.md#the-pilot-gate)). Until
  the host records the pilot decision, only the installation's owner is
  offered repairs, has repair work proposed, or can have one applied; a
  `process.repair` grant cannot be activated by anyone else (`PILOT_ONLY`).
  Incidents are still reported to everyone.
- **While the host has stopped delegated work**
  ([Stop all](delegated_operations.md#stop-all)), Goobster applies no repair,
  and a repair it had already applied waits exactly where it is: it is not
  run again, judged or undone until the host resumes. What you approve
  yourself is your own act and is not held, and requests are still filed.
- A repair is not started while the whole installation is paused for
  maintenance (`INSTANCE_PAUSED`).

## What you are told

| Event | Message | Repeats |
| --- | --- | --- |
| An incident opens | "*Name* keeps failing", "*Name* has stopped running" or "*N* of your processes are blocked by the same problem" | Revised when another process joins. Not repeated otherwise. |
| An incident is resolved | The same message, revised: "*Name* is working again" | Once. |
| A process's purpose is over, it is still on, and Goobster may not pause it | A request under Needs you: "*Name* may no longer be needed" | Once per contract revision and reason. Asked again, as a new request, only after the contract changes. |
| Goobster paused a process under a responsibility | "Paused *Name*" | Once. |
| Goobster archived a process it had paused | "Archived *Name*" | Once. |
| A process keeps failing, running it again could help and no grant covers it | A request under Needs you: "*Name* keeps failing: run it once more?" | Once per incident. |
| A redirect leads to another site | A request under Needs you: "*Name* has moved: use its new address?" | Once per run that found it; a newer request replaces an older one. |
| A repair was applied | "Repairing *Name*", in What changed only | Once. Not sent to the Inbox: whoever applied it was just told. |
| The run after a repair worked | "Repaired *Name*" | Once. |
| The next scheduled run worked too | "The repair of *Name* held", in What changed only | Once. |
| A repair failed and attempts remain | "A repair of *Name* did not work" | Once per attempt. |
| A repair failed and no attempts remain | A request under Needs you: "*Name* still fails after *N* repair attempts" | Once per incident. |

Each message is one canonical update ([delegated_responsibilities.md](delegated_responsibilities.md#updates)),
filed in your Inbox with no Discord echo, and shown under What changed until
you review it. An incident message and a request both end with "Nothing was
changed." because nothing was. A pause or archive message says what was
changed and how to undo it.

Everything about repairing one process is one update too
(`process_repair:<kind>:<id>`), revised as the repair moves on, so a repair
that was proposed, applied and proved is one line under What changed, not
three.

The request, the pause message and the archive message for one process are
the same update, revised. A request is closed without a message when its
reason goes away: you paused or archived the process, said to keep it, or the
goal it was linked to was reopened.

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

Retirement has its own, in
`packages/core/services/assistantProcessLifecycleService.js`:

| Number | Default | Used for |
| --- | --- | --- |
| Paused before Goobster may archive | 7 days | Only for what it paused itself, with an archive grant |
| Cleanup preview valid | 1 hour | After that it must be previewed again |
| Rows per cleanup | 5,000 of each type | More takes another cleanup |
| A started run counts as running | 1 hour | Counting scheduled-task runs under way at a pause |
| Stewardship record of a running process kept | 180 days after its last change | Retention |
| Applied cleanup record kept | 180 days | Retention |
| Unapplied cleanup preview kept | 7 days after it expired | Retention |

Repair has its own, in
`packages/core/services/assistantProcessRepairService.js`. The plan fixed
none of them; each is the smallest or slowest choice that still works:

| Number | Default | Used for |
| --- | --- | --- |
| Repair attempts per incident | 1 | When a responsibility's `repairAttempts` is not stated, and for a repair you approve with no grant |
| Most attempts a grant may allow | 5 | A larger `repairAttempts` is treated as 5 |
| Time to prove a repair | 60 minutes | `VERIFY_TIMEOUT` |
| Time to prove one that needs fresh output | The contract's freshness period, at least 1 hour, at most 24 hours | `VERIFY_TIMEOUT` |
| Watching for the next scheduled run | 30 days | Closed as `NOT_OBSERVED` after that |
| Diagnosis kept | 400 characters | What a run wrote about why |
| Ended repair kept | 180 days | Retention |

## What is not here yet

- **More kinds of repair.** A project trigger's script, a watch, a process
  that has stopped running and a group of processes blocked by one shared
  cause are reported and not repaired. Nothing rewrites a prompt, a
  schedule or a script.
- **Granting repair from the form.** The responsibility form has no control
  for `process.repair` yet; the grant is written through the API
  ([delegated_responsibilities.md](delegated_responsibilities.md#portal-api)).
- **Cleanup by Goobster.** The `cleanup.exact` operation can be granted and
  is not used: only you can clean up a process.
- **Files and knowledge a process produced.** A process does not declare
  which files or notes it owns, so cleanup never touches a project workspace
  or your knowledge.
- **Target-ended codes for watches.** One target-ended code is recorded
  today: a followed source whose address answers 410 Gone records
  `TARGET_GONE`, so with a stated purpose it becomes a retirement candidate
  (and is never offered a repair). No watch records `TARGET_MERGED` and its
  siblings yet; a watch becomes a retirement candidate through its linked
  goal being resolved, or by having fired for good.
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
| `assistant_process_lifecycle` | One row per process that was paused, archived, cleaned up or kept: its stage, who did it (you or Goobster) and under which responsibility, a reason code, the times, how many runs were under way at the pause, how it stood when archived, what a cleanup removed (counts), and your "keep it running" answer. |
| `assistant_process_cleanups` | Each cleanup preview: the exact row ids, counts of what is kept, its hash, when it expires and, once applied, what was removed and skipped. |
| `assistant_process_repairs` | One row per repair, proposed or applied: the process and its name, the incident, which attempt it was, its status, the action, the failure code it answers, the diagnosis a run wrote (400 characters at most), who applied it (you or Goobster) and under which responsibility and piece of work, what it changed and what it replaced (for a followed source, the new and the previous address), what was to count as proof, what was observed, what was put back, the code it stopped with, and your answer when you were asked what to do. |

The four process tables each gained an `archivedAt` column (`automations`,
`project_triggers`, `followed_sources`, `attention_watches`), and
`attention_watches` a `pausedAt` column. Whether a process can run is decided
by its own row: a paused or archived process is switched off there, and
every write that would switch it back on refuses an archived row. So an
archived or paused process cannot run even if the stewardship tables were
lost.

The assessment itself is not stored. It is computed from these records each
time it is read, so it is never out of date and there is no state to repair.

Resolved incidents and their members are removed 180 days after they were
resolved. Open and recovering incidents are never pruned.

A stewardship record is removed when its process is deleted, or 180 days
after its last change once the process is running again. The record of a
paused or archived process is kept as long as the process is. Cleanup
previews that were never applied are removed 7 days after they expired, and
applied ones after 180 days.

A repair is removed 180 days after it ended, or when its process is deleted.
One that still waits for your answer is kept until it is answered.

## Portal API

All routes act as the signed-in person and are reads unless noted. With the
feature off the prefix answers `FEATURE_UNAVAILABLE`.

| Route | Returns |
| --- | --- |
| `GET /api/app/assistant/processes` | `processes` (each with `assessment`, `incident`, `archived`, `lifecycle`, `controls` and `repair`), `counts` per state (`notWorking`, `degraded`, `retirementCandidates`, `reviewDue`, `paused`, `archived` and one per execution state; archived processes are counted only in `archived`), and `incidents` that are open or recovering, with their members. |
| `GET /api/app/assistant/processes/:kind/:id` | One process with its contract, recent observations, `assessment`, `incident`, `lifecycle`, `controls`, the processes that depend on it (`dependents`), its newest cleanup preview or result (`cleanup`) and its repairs, newest first (`repairs`). |
| `PUT /api/app/assistant/processes/:kind/:id/contract` | Writes the contract. `dependsOn` must name your own processes; a process cannot depend on itself. |
| `POST /api/app/assistant/processes/:kind/:id/actions` | A write. Body `{ "action", "expectedRevision"?, "cleanupId"?, "manifestHash"? }`. `action` is `pause`, `resume`, `archive`, `restore`, `keep`, `preview_cleanup` or `cleanup`. Returns `{ action, changed, process, lifecycle, controls }` and, by action, `started`, `dropped`, `skipped`, `dependents`, `notRestored` or `cleanup`. |

`controls` lists the actions that would be accepted now, so a client shows
only those. `expectedRevision` is the `lifecycle.revision` you were shown
(0 when `lifecycle` is null); if the process has changed since, the answer is
`409 REVISION_CONFLICT` with the current revision. Repeating `pause` on a
paused process, `archive` on an archived one, or `cleanup` with a manifest
that was already applied changes nothing and answers `changed: false`.

`lifecycle` is null until a process has been paused, archived or kept:

```json
{
  "stage": "paused",
  "revision": 1,
  "actor": "assistant",
  "responsibilityId": 4,
  "reasonCode": "RETIRE_GOAL_RESOLVED",
  "pausedAt": "2026-11-10 03:10:00",
  "archivedAt": null, "cleanedAt": null, "resumedAt": null,
  "started": { "count": 1, "policy": "finish" },
  "final": null, "cleaned": null, "kept": null
}
```

`stage` is `active`, `paused`, `archived` or `cleaned`. `actor` is `person`
or `assistant`. `reasonCode` is `PERSON`, `RESTORED`, `RESUMED_ELSEWHERE` or
`RETIRE_` followed by the reason the purpose is over. `started.policy` is
`finish` or `abandon`.

`repair` is the newest repair of that process, or null:

```json
{
  "id": 9, "status": "verifying", "action": "rerun", "attempt": 1, "allowed": 1,
  "actor": "person", "proposedBy": "steward", "responsibilityId": null, "incidentId": 3,
  "diagnosisCode": "RUN_FAILED", "diagnosis": null, "address": null,
  "verification": { "run": "ok", "output": "not_failed", "withinSeconds": 3600 },
  "affected": ["automation:5"], "rollback": null, "stopCode": null, "direction": null,
  "appliedAt": "2026-11-10 03:10:00", "verifiedAt": null, "endedAt": null,
  "createdAt": "2026-11-10 03:05:00", "revision": 2, "ask": null
}
```

`status` is `proposed`, `declined`, `withdrawn`, `verifying`, `observing`
(proved once, watching the next scheduled run), `succeeded`, `failed` or
`closed`. `actor` is `person` or `assistant`, null until it is applied.
`proposedBy` is `steward` (the periodic pass) or `run`. `address` is where a
followed source was or would be pointed. `rollback` is `none`, `restored` or
`kept` once it is known. `direction` is `asked`, `pause` or `leave`. `ask`
is the decision card of a repair that waits for you
([assistant_home.md](assistant_home.md#deciding-a-request-where-it-is-shown)),
on the list only.

There is no repair route. A repair is approved, declined, or answered with
*Pause it* or *Leave it running* through
`POST /api/app/assistant/gates/:ref/decide` like any other request, with
`surface` `home`, `inbox` or `processes`; Goobster's own repairs are applied
by delegated runs. A repair stops or is refused with one of these codes:
`NO_INCIDENT`, `PROCESS_OFF`, `PROCESS_GONE`, `KIND_NOT_REPAIRABLE`,
`NOT_A_FAILURE` (it has stopped running), `REPAIR_IN_PROGRESS`,
`AWAITING_PERSON`, `ATTEMPTS_EXHAUSTED`, `NO_REPAIR_KNOWN`,
`ACTION_NOT_AVAILABLE`, `NEEDS_APPROVAL`, `PILOT_ONLY`, `INSTANCE_PAUSED`,
`NO_REDIRECT`, `REDIRECT_UNUSABLE`, `PROBE_DEFERRED`, `DUPLICATE_SOURCE`,
`CHANGED`, `VERIFY_TIMEOUT`, `RELAPSED`, `DEPENDENTS_STILL_BLOCKED`,
`NOT_OBSERVED`, or the failure code of the run that disproved it.

A cleanup preview:

```json
{
  "id": 7, "status": "PREVIEWED", "manifestHash": "9f2c…", "expiresAt": "2026-11-10 04:10:00",
  "removes": { "observations": 42, "sourceEntries": 0, "sourceCache": false },
  "keeps": { "definition": true, "contract": true, "inboxResults": 12 },
  "more": false, "result": null, "appliedAt": null
}
```

Refusals use these codes, all `409` unless noted: `ARCHIVED`, `NOT_RUNNING`,
`PAUSE_FIRST`, `RESTORE_FIRST`, `NOT_ARCHIVED`, `NOT_PAUSED_HERE`, `ENDED`,
`RESOURCE_UNAVAILABLE`, `DEPENDENCY_BLOCKED`, `NOT_A_CANDIDATE`, `CHANGED`,
`REVISION_CONFLICT`, the cleanup codes above, `INVALID_ACTION` (400),
`MANIFEST_REQUIRED` (400), `MANIFEST_NOT_FOUND` (404) and `NOT_FOUND` (404).

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
contracts they are built from. So are the stewardship records, cleanup
previews and repairs. The transparency report counts them, the account export
includes them, and `/forget-me` deletes them. This works when the feature is
off. These rows hold codes, times, counts, row ids and the names you gave
your processes; they hold no prompt, output or error text. A repair
additionally holds two things the others do not: the address a followed
source was pointed at and the one it had before (both already yours, in the
source itself), and the short diagnosis a delegated run wrote. Neither is
copied into the work ledger, which records codes only.

An archived process is still your data and is still exported and erased with
the rest: archiving hides nothing from the privacy commands.

## Turning it off

Process stewardship is part of the `assistant` feature. With the feature off
nothing is observed, assessed, opened, announced, paused, archived or
repaired, the routes answer `FEATURE_UNAVAILABLE`, and the data is kept. A process that was
paused or archived stays that way: the processes' own tables hold that, so
turning the feature off does not switch anything back on.

With the feature on and Attention off, the report and your own actions work,
and Goobster opens nothing, asks nothing, pauses nothing and offers no
repair. A repair that was already applied is still checked and, if it fails,
undone.
