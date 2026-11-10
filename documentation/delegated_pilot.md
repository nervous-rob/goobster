---
title: Delegated work - the personal pilot (runbook, rehearsal, outcome summary)
kind: guide
summary: How the owner of an installation runs the first personal pilot of delegated work - what to set up first (Attention, the feature, a provider, optionally Notion and process grants), rehearsing the whole flow against a throwaway database with npm run pilot:rehearsal, recording thresholds before judging, the one project and three responsibilities, the conservative starting policy, the daily routine and how requests reach Needs you, recording each cycle, reading the outcome summary on the Responsibilities page (checked results apart from reported ones, cost per checked result, the prompt and model each run was given), stopping everything, and recording the exit decision in Host → Delegated work.
when: Starting, running or ending the personal pilot of delegated work; checking that the integrated flow works before trusting it with real resources; finding where a pilot number comes from; understanding what the outcome summary counts and what it cannot know; creating a responsibility the draft form cannot express (process repair or pause, daily budgets); deciding whether to open the pilot capabilities to everyone.
tags: [assistant, responsibilities, delegation, pilot, runbook, rehearsal, outcomes, cost, evaluation, host]
feature: assistant
---

# Delegated work: the personal pilot

The pilot is one person, the owner of the installation, using delegated work
on one real project for long enough to decide whether it is useful, what it
may do, and whether anybody else should have it. This page is the runbook.
The record you fill in as you go is
[delegated_pilot_record.md](delegated_pilot_record.md). Why the summary
counts what it counts is in
[ADR 0032](adr/0032-pilot-outcome-measures.md).

Nothing here is switched on for you. The examples below are fictional; the
project, the resources, the dates and the limits are yours to choose.

The pilot is judged by what was achieved and what it cost you: progress that
was checked, findings you accepted, corrections and rollbacks, anything
unwanted, cost per useful result, interruptions, and whether chat stayed
responsive. It is **not** judged by notes created, tool calls made or time
spent, and nothing in the product counts those as success.

## In short

1. [Rehearse](#rehearse-first) the whole flow on a throwaway database:
   `npm run pilot:rehearsal`.
2. [Set up](#before-you-start) the installation and your own account.
3. [Record your thresholds](#record-your-thresholds-first) before you look at
   any result.
4. Draft and activate [three responsibilities](#one-project-three-responsibilities)
   on one project, with the [starting policy](#the-starting-policy).
5. Follow the [routine](#the-routine), and [record each cycle](#recording-a-cycle)
   from the [outcome summary](#the-outcome-summary).
6. [Stop](#stopping) whenever you need to. Record the
   [exit decision](#the-exit-decision) when you are done.

## Rehearse first

```bash
npm run pilot:rehearsal              # run it and print each check
npm run pilot:rehearsal -- --json    # the same record, machine-readable
npm run pilot:rehearsal -- --keep    # keep the throwaway directory and print where it is
```

The rehearsal drives the real services through the integrated flow and
checks what they did. It takes a few seconds, needs no key and no network,
and **never touches this installation**: before anything loads it points the
database, the data directory, the logs and `config.json` at a new temporary
directory, removes the Postgres address and every provider key from its own
environment, and deletes the directory afterwards. The model is a script,
and project files, Notion, the followed source and Discord are in-memory
stand-ins. It refuses to run in a database that already holds a
responsibility (`NOT_EMPTY`) or with the `assistant`, `projects` or
`knowledge` feature turned off (`FEATURE_OFF`).

It exits 0 when every check passed, 1 when a check failed and 2 when it could
not run. A failed check is printed with what was found.

It needs a checkout of the repository. The Notion step uses the stand-in
under `tests/helpers/`; where that file is missing the step is skipped, and
the record lists it under `skip` and in `notCovered`.

| Journey | What it proves |
| --- | --- |
| A. A source change improves knowledge and project state | History before activation and items you did not keep propose nothing. A kept item becomes one piece of work; the run adds a generated note, suggests a change to a saved note without making it, and writes one project file. The suggestion waits under Needs you, reading it does not answer it, applying it changes the note once, and a second press is refused as changed. |
| B. A conversation becomes authorized progress | An unapproved plan and a request made before delegation propose nothing. Approving a plan needs a person. A started plan's assistant step is carried out, its file is checked, the step is marked done and the plan waits for your review. A remark proposes nothing, the same request is proposed once, and "never mind" withdraws unfinished work and says so. |
| C. A broken import is repaired or escalated | Outside any grant a repair is offered and nothing changes until you approve. Under a `process.repair` grant the assistant repairs the process itself and the next check decides whether it worked. When the attempts are used up you are asked once whether to pause it. A repair counts as succeeded only after the next scheduled run works. |
| D. A quiet process is told apart from an obsolete one | A healthy process nobody opens is left alone. One whose purpose ended is asked about; under `process.pause` it is paused and you are told. *Keep it running* is remembered, your resume is respected, and archive and restore keep the definition and leave it paused. |
| E. Authority, concurrency and partial availability | A call outside the grant is refused and the run goes on. A suggestion against a note that changed is not made. Two runner passes start a piece of work once. With no provider the work waits and Home still loads, and it is picked up again later. A model call cannot activate a responsibility. A collaborator who lost access gets no model call and no file. |
| F. Review and delivery stay consistent | The same update published again is one update at a new revision and one Inbox item. Reading an old revision leaves the new one unread. Home and the Inbox count the same things. At most one digest a day goes out, at the digest time. |
| G. The Inbox is told apart from Needs you | The Inbox holds more than Needs you. Marking everything read answers nothing. Dismissing the suggestion settles it and leaves the note as it was. |
| H. The host's controls, the pilot gate and the record | Stop all holds queued work and Home says so; resume runs it. Pilot capabilities are the owner's until the decision is recorded and close again when it is reversed. One write to a granted Notion page lands with its reference; a write elsewhere and a write over the daily limit are refused. Every run records the prompt version, provider and model it was given, and the outcome summary counts a checked result apart from a reported one. |

What the rehearsal does **not** show: whether a real model makes good use of
the tools (that is the [evaluation set](delegated_evaluation.md), which costs
money and is run on purpose), whether the results are useful to you, and
anything about your own data. Those are what the pilot is for.

The same rehearsal runs in CI as `tests/assistantPilotRehearsal.test.js`, on
SQLite and on Postgres.

## Before you start

On the installation (you are the host):

1. **The features are available.** Host → Features: *Delegated assistant*
   (`assistant`), with projects and knowledge. A fresh installation starts
   with `assistant` off ([delegated_responsibilities.md](delegated_responsibilities.md#turning-it-on-and-off)).
2. **A model provider works in chat.** Delegated runs use the same route as
   your own chat, your personal connection first if you have one. With no
   provider, work waits and is retried about an hour later; nothing fails.
3. **The process that runs schedulers is running.** The periodic pass (every
   five minutes) and the runner live in the bot process, or in the api
   service in a standalone deployment. Home says "Up to date" only when a
   pass ran in the last 15 minutes; otherwise a quiet card reads *Status
   unknown* and the overview says when it was last checked.
4. **You are the owner.** The pilot capabilities (conversation, wider
   sources, delivery, reach, repair) are open only to an active operator
   account until you record the decision
   ([the pilot gate](delegated_operations.md#the-pilot-gate)). Leave it at
   *Host only* for the whole pilot.
5. **Look at the caps** in Host → Delegated work
   ([Caps](delegated_operations.md#caps)) and write the five numbers in your
   record. The defaults are 2 runs at once on the installation, 1 per
   account, and per responsibility per day 200,000 tokens, 20 searches and
   120 sandbox seconds. A responsibility can spend less, never more.

On your own account:

6. **Turn Attention on** (Settings → *Paying attention*) with *Initiative
   level* at **Assist** or higher. Nothing delegated runs without it.
7. **Set your limits there too**: quiet hours, DMs per day, minutes between
   DMs, and the daily digest time (default 09:00). Delegated contacts share
   these with Attention's own notices; they are ceilings, not targets.
8. Only if a responsibility will write outside Goobster (Notion, a push, a
   pull request): *Initiative level* **Delegate**, and under *Boundaries by
   category* allow *External writes* for *General* (Notion) or *GitHub*.
9. Only if a responsibility will pause or repair a process: under
   *Boundaries by category*, tick *Compute ahead* for *Schedule & tasks*.
   Without it the grant is refused with `ATTENTION_BOUNDARY` and you are
   asked instead.

### Notion, if the pilot uses it

Notion is the one outside connector on `main`
([delegated_notion.md](delegated_notion.md)). All of these are needed before
a grant on a Notion page can be activated:

1. Create an internal integration at <https://www.notion.so/profile/integrations>
   and give it *Read content*, and for writing *Update content* and *Insert
   content*.
2. In Notion, share the one page or database with that integration (page
   menu → Connections).
3. In Goobster, Settings → Connections: connect Notion with the
   integration's secret. It is your token; the host's is never used. If you
   keep a list of *Notion pages Goobster may use*, the page must be on it.
4. Step 8 above (Delegate, and *External writes* for *General*), for writing.
5. In the draft form, under *Outside services*, choose Notion, paste the
   page's link, choose reading, writing or both, and set *At most this many
   outside writes a day*.

One grant is one page or one database. A run that has read your private
notes, or another outside resource, cannot then write to Notion; if writing
there is the point, do not also give that responsibility *Read your
knowledge*. Moving anything to the trash is never granted: a run asks, and
you approve that one request under Needs you.

## Record your thresholds first

Before you look at a single result, write down in
[the record](delegated_pilot_record.md#thresholds) what would make you keep
it, narrow it or stop: for example how many checked results in two weeks
make it worth having, how many unwanted actions end it (one is a reasonable
number), the most you will spend per useful result, and how many
interruptions a day are too many. The product does not hold these numbers
and does not judge the pilot for you. Thresholds chosen after the results
are in are not thresholds.

## One project, three responsibilities

Choose one project you are really working on. Give it three
responsibilities, each with its own grant, limits and end date. Draft them
on the **Responsibilities** page (Home → Responsibilities) or by asking in
chat; either way nothing runs until you press **Activate** yourself.

| Responsibility | What to grant | Where |
| --- | --- | --- |
| Keep important knowledge current | *Read your knowledge*; *Add and amend generated notes*; *Suggest changes to notes you saved* (a suggestion, never an edit); optionally *Search and read the web* and a followed source under the wider sources | The draft form |
| Advance approved work | The project; *Edit its files* under the folders you name; *Carry out the assistant steps of its approved plan*; optionally *Take requests you address to Goobster in this project's conversations* | The draft form |
| Keep its processes healthy and useful | `process.repair` and/or `process.pause` on each exact process, with `repairAttempts` | The API (below): the form has no control for process grants yet |

What each one can then do, and what it can never do, is in
[delegated_knowledge.md](delegated_knowledge.md),
[delegated_plan_steps.md](delegated_plan_steps.md),
[delegated_conversation_requests.md](delegated_conversation_requests.md) and
[process_stewardship.md](process_stewardship.md#repairing-a-process).

### A grant the form cannot express

Process grants and the daily token, search and compute budgets are not in
the draft form. Create that draft through the portal's own API, signed in as
yourself, then activate it on the page like any other. In the browser's
developer console on the portal:

```js
// The reference of each of your processes, to copy into the grant.
(await (await fetch('/api/app/assistant/processes')).json())
    .processes.map((p) => `${p.ref}  ${p.name}`);

// A draft. It is always a draft: activating it is your own press on the page.
await (await fetch('/api/app/assistant/responsibilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        title: 'Keep my recurring work running',
        outcome: 'What I rely on keeps running, and what no longer matters is paused.',
        operations: [
            { operation: 'process.repair', resource: { kind: 'process', ids: ['automation:5'] } },
            { operation: 'process.pause', resource: { kind: 'process', ids: ['automation:5'] } }
        ],
        budgets: { repairAttempts: 1, modelTokens: 50000, searches: 5, computeSeconds: 60 },
        rules: { interruption: 'home' }
    })
})).json();
```

There is no wildcard: a process is named exactly, by the reference the first
call prints. The same `budgets` object can be sent for the other two
responsibilities with `PATCH /api/app/assistant/responsibilities/:id` and
the draft's `expectedRevision`
([Portal API](delegated_responsibilities.md#portal-api)). Without it a
responsibility gets the host's daily numbers.

A process is only asked about, or paused for you, when it has a stated
purpose ([Contracts](process_stewardship.md#contracts)); repair needs none.

## The starting policy

A conservative start, to widen one step at a time once you have seen it work.
Every line is a setting on the responsibility or in your own Settings.

- **One piece of work at a time.** Leave the caps at 1 run per account.
  Chat always takes priority over background work.
- **Explicit limits on each responsibility**: its own daily tokens,
  searches and compute, an end date (*Ends: in 30 days*), and for a process
  responsibility `repairAttempts: 1`. Do not rely on the host's numbers as
  the responsibility's budget.
- **Leave *Start proposed work automatically* off** at first. Each proposed
  piece of work then waits for your **Start**, so you see what it would do
  before it does it. Turn it on per responsibility when the proposals are
  ones you would always start.
- **Generated notes and reversible changes are allowed; edits to notes you
  saved are suggestions.** Do not tick *Edit notes you saved directly*,
  *Archive notes it generated*, outside writes or process pausing because
  another one is ticked:
  choose each on its own, when you want it.
- **Updates stay on Home** (*Keep them on Home and in my Inbox*), or go in
  the daily digest. Use *Tell me when it needs my decision* only for a
  responsibility whose requests are time-sensitive.
- **No outside writes in the first week** unless Notion is the point of the
  pilot. If it is: one page, one write a day.

## The routine

Once a day is enough.

1. **Home.** The assistant overview shows what is waiting for you, what
   changed, and what is working. An unknown count is shown as unknown, not
   as zero ([assistant_home.md](assistant_home.md)).
2. **Needs you** (Home, or the Inbox filter). Answer each request where it
   is shown: a suggested note change (*Apply change* or *Dismiss*, with the
   diff), a
   plan waiting for review, a repair or a process that may no longer be
   needed, a request to do something outside. A request a run made appears
   here **after the next periodic pass, within about five minutes**, not the
   instant the run ends. Reading an item does not answer it.
3. **What changed.** Read the findings. Each says which responsibility
   produced it and what it rests on. Delivery is not review: an update you
   were told about is still unread until you open it.
4. **Responsibilities page.** Proposed work waits here for **Start** or
   **Dismiss** when automatic start is off. *Changes to your notes* lists
   what was suggested, applied and archived, with **Undo**. *Processes* shows
   whether each process is working and whether it is still needed, with
   **Pause**, **Resume**, **Archive** and **Restore**.
5. **Tell it when it is wrong.** "Goobster, stop" or "Goobster, actually ..."
   in the conversation where you asked withdraws what was asked for there.
   **Pause** on a responsibility holds everything under it.

Things that look like faults and are not:

- **Work shows as waiting with no provider.** It is retried about an hour
  later. Nothing was lost.
- **A proposal did not appear.** History before activation is never acted
  on; an item of a followed source has to be kept *after* the
  responsibility first saw the source; and each responsibility takes at
  most 3 proposals a day from each wider source, coalescing the rest
  ([the daily cap](delegated_opportunity_sources.md#the-daily-cap)).
  Requests you address to Goobster in a conversation are not capped that
  way.
- **A repair shows as under way for a day.** It is confirmed by the
  process's own next scheduled run, not by the check straight after it.
- **A digest was not sent.** One a day, at your digest time or as soon after
  it as quiet hours and your contact limits allow, and only if there is a
  channel to reach you on (a browser notification or a Discord message).
  Everything is on Home regardless.

## Recording a cycle

A cycle is one stretch you judge as a whole: a week is a good length. At the
end of each, copy the [cycle record](delegated_pilot_record.md#cycle-record)
and fill it in. Where each line comes from:

| Line | Where to read it |
| --- | --- |
| Responsibility and policy version | The responsibility's row: its grant, limits and revision number |
| Trigger and authority | Each piece of work on the Responsibilities page says what it came from |
| Expected and actual useful result | The outcome summary's checked results and reported findings, and **your own judgement of each finding** |
| Actions and consequences | *Changes to your notes*, the project's files and history, *Processes*, and the outcome summary's changes, undone changes and outside writes |
| Human effort | The outcome summary's requests asked and answered, plus what you had to correct or start by hand |
| Delivery | The outcome summary's updates, digests and contacts, plus what you noticed as duplicate or irrelevant |
| Resources | The outcome summary's tokens, searches and compute |
| Model and prompt version | The outcome summary's "Ran on" line |
| Caps in force | Host → Delegated work |
| Reliability | The outcome summary's refused calls, stopped runs and writes left for you to check; Host → Delegated work for failure codes |
| Decision | Yours |

## The outcome summary

At the bottom of the Responsibilities page, **What your responsibilities
did** shows, for the last 7, 14, 30 or 90 days, one entry per responsibility
and a total. It is a read: there is nothing to press but the period. It
appears once a responsibility has been activated.

- **Checked results** are the ones the system verified itself: a plan step
  whose required files were found, and a repair by the assistant whose check
  afterwards was clean. Nothing else is counted as checked.
- **Reported findings** are what a run told you and nothing checked. Whether
  one was useful is yours to judge, and yours to write in the record. A run
  that found nothing needing you is counted apart from a finding.
- **What it asked of you**: requests filed and how many are still waiting,
  and note suggestions with how many you applied and dismissed.
- **What it changed**: changes made, how many of them outside Goobster, and
  changes undone (a note change you undid, a repair that was rolled back).
- **What went wrong or was held back**: calls refused (by code in the API),
  runs that stopped before a result, work that was withdrawn, and writes
  left for you to check after a crash.
- **Cost**: tokens, searches and sandbox seconds, and **tokens per checked
  result**. Where a responsibility has no checked result the figure is
  tokens per result instead, and where it has no result at all there is no
  figure: never a zero that reads as free.
- **Ran on**: the provider, the model and the prompt version of its runs.
  Every run records the three when it starts (`assistant_runs.promptVersion`,
  `provider`, `model`); they are names, never content. Runs from before
  this was recorded show the prompt as not recorded and the provider and
  model as unknown. The prompt version is the label
  the [evaluation set](delegated_evaluation.md#the-prompt-version) prints,
  so a pilot cycle and an evaluation run can be compared.

Tokens come from the work ledger ([work_ledger.md](work_ledger.md)): what
each run settled, plus its research expeditions and, for personal chat, the
label that classified a request. Tokens reserved by work still under way are
shown as held, and the summary says the figures are not final. An
installation without the research feature has no ledger report; there the
runs' own counts are used and the summary says so (`costSource: "runs"`).

**What it cannot tell you**, and says so on the page: whether a result was
useful to you, whether anything it did was unwanted, and how responsive
chat stayed while it worked. Record those yourself.

The summary is your own data and is not behind the pilot gate. It holds
counts, codes and names (provider, model, prompt label, your
responsibilities' titles) and no title or text of any piece of work, update
or result.

```
GET /api/app/assistant/outcomes?days=14
```

`days` is 1 to 90 (default 14); anything else answers 400 `BAD_PERIOD`. The
answer is `{ outcomes: { period, prompt, responsibilities, totals,
costSource, notMeasured } }`. Each entry of `responsibilities`, and `totals`,
carries `work`, `runs`, `verified`, `reported`, `changes`, `notes`,
`repairs`, `requests`, `refusals`, `stopped`, `review`, `delivery`, `cost`,
`tokensPerVerified` and `tokensPerResult`; an entry also carries its
`limits` and `models`. A responsibility that is active, paused or waiting
for review is always listed; one that has ended is listed only if it did
something in the period.

## Stopping

From the smallest to the largest:

| To stop | Do this | What happens |
| --- | --- | --- |
| One piece of work | **Cancel** on it, or "Goobster, stop" where you asked | It ends; nothing it already did is undone |
| One responsibility for now | **Pause** | Nothing new is proposed or started under it; **Resume** needs your confirmation |
| One responsibility for good | **Revoke** | Its open work is cancelled now and it cannot be turned back on |
| Everything, for everyone | Host → Delegated work → **Stop all** | Nothing new starts, running work halts at its next step, nothing is cancelled or lost, and what you do yourself is not held ([Stop all](delegated_operations.md#stop-all)) |
| The feature | Host → Features → turn off *Delegated assistant* | Routes and every authority check refuse; the data stays |

Undo is separate from stopping: a note change is undone from *Changes to
your notes*, a paused process is resumed from *Processes*, a project file
from the project's history. An outside write cannot be undone from here.

## The exit decision

When the cycles you planned are recorded, write the decision in
[the record](delegated_pilot_record.md#exit-decision): keep the policy as it
is, narrow or widen it explicitly, repair the machinery first, or stop. Then
make the installation match it:

- **Caps.** Save the numbers you settled on in Host → Delegated work. They
  replace the defaults for the next run that starts.
- **Other people.** The pilot capabilities stay with the owner until you
  press **Open to everyone** in Host → Delegated work, which records the
  decision with its time. **Limit to the host** reverses it. Do not open
  them before the decision is written down; account isolation is tested in
  CI, but the judgement that this is useful to other people is yours.
- **Your own responsibilities.** Revoke what you are not keeping. An end
  date you set at the start ends the rest by itself.

The existing gates for running on a real host and for a second account
remain in force; this pilot does not replace them.

## Defaults chosen here

- The summary's period defaults to 14 days and goes up to 90.
- A checked result is a verified plan step or an assistant's repair whose
  check was clean; nothing a run only says is counted as checked.
- The summary is the person's own and open to every account with the
  feature, like the rest of the Responsibilities page.
- The rehearsal always uses a new SQLite database and a scripted model.

## Not built

- **Usefulness in the summary.** The summary does not read feedback on
  findings; whether a finding was accepted is recorded by hand.
- **Foreground responsiveness.** Nothing measures how long chat took while
  background work ran.
- **A rehearsal with a real model.** The real-model check is the
  [evaluation set](delegated_evaluation.md), which has its own fixed cases.
- **The record in the product.** Thresholds, cycles and the exit decision
  are a document you keep, not rows in the database. Only the decision to
  open the capabilities to everyone is recorded by the installation.
- **Process grants and daily budgets in the draft form.** They go through
  the API, as above.

## Code

- `packages/core/services/assistantOutcomeService.js`: the summary.
- `packages/core/web/routes/assistant.js`: `GET /api/app/assistant/outcomes`.
- `apps/web/src/rooms/assistant/OutcomeSummary.tsx`: the page section.
- `packages/core/services/assistantRunService.js`: what a run records about
  the prompt, provider and model (`_given`); `aiService.routeFor()` names
  the route without calling a model.
- `scripts/pilot-rehearsal.js`, `scripts/lib/assistantPilotRehearsal.js`:
  the rehearsal.
- Tests: `tests/assistantOutcomeService.test.js`,
  `tests/assistantPilotRehearsal.test.js`, `e2e/assistantOutcomes.spec.js`.
