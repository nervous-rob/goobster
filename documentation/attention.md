# The attention system

Goobster has three ways of doing things for you.

```text
You want something                    You anticipate wanting something
        ↓                                       ↓
   you ask him                          you create an automation
        ↓                                       ↓
he reasons and acts                     the time arrives
                                                ↓
                                        he reasons and acts
```

Both start with you. This document describes the third path, which does not:

```text
something changes
        ↓
he notices
        ↓
compares it against what matters to you
        ↓
recognizes an opportunity, a problem, or an unfinished thread
        ↓
decides whether intervention is worthwhile
        ↓
acts, asks, nudges, or stays silent
```

The last line is the important one. **An assistant that cannot decide to stay
quiet is not an assistant.** Nearly every mechanism here exists to make
silence the default and speaking up expensive.

---

## The layers

```text
                             EVENTS
                                │
        ┌───────────────────────┼───────────────────────┐
        ↓                       ↓                       ↓
 conversation             Observatory              knowledge
 messages                 job change               reflection
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                ↓
                       domainEventBus (hints)
                                ↓
                       personalHeartbeatService
                                ↓
                   ┌────────────────────────────┐
                   │   deterministic candidates │
                   └────────────────────────────┘
                                ↓
                    P = U × I × C × A − K
                                ↓
                      model triage (narrow)
                                ↓
                   initiative policy + budget
                                ↓
      discard  │  inbox  │  mention  │  DM  │  urgent
```

| Piece | File | What it owns |
|---|---|---|
| Attention ledger | `services/attentionLedgerService.js` | The working set of open loops |
| Scoring | `utils/attentionScore.js` | Pure math: the interruption policy |
| Config | `config/attentionConfig.js` | Vocabulary, bands, budgets, caps |
| Event bus | `services/domainEventBus.js` | Internal topic pub/sub |
| The brain | `services/attentionService.js` | Candidates, triage, notices, feedback |
| Agency boundary | `services/attentionPolicyService.js` | Initiative level, category boundaries |
| Watches | `services/attentionWatchService.js` | Condition-triggered agent turns |
| The loop | `services/personalHeartbeatService.js` | Scheduling, nothing else |
| Portal facade | `services/webAttentionService.js` | The Assistant Inbox API |

---

## The attention ledger

The knowledge graph (`documentation/user_knowledge_graph.md`) answers **what
does Goobster know?**. The ledger answers a different question: **what
currently matters?** Those are not the same, and conflating them was the gap
this system fills. A graph node about a project stays true forever. A ledger
item about that project stops mattering the moment the presentation happens.

An **attention item** is one open loop:

```text
{
  kind: "commitment",
  subject: "dbt demo",
  state: "corroborated",

  goal: "give the presentation Thursday",
  unresolved: ["choose lineage example", "finish demo code"],

  importance: 0.82,
  confidence: 0.91,

  deadlineAt:     "2026-08-27 09:00:00",
  lastActivityAt: "2026-08-21 18:14:00",

  category: "schedule",
  allowedInitiative: "nudge"
}
```

Kinds: `goal`, `commitment`, `deadline`, `open_question`, `waiting_for`,
`opportunity`, `concern`.

It is called a *ledger* rather than a task list deliberately: entries are
Goobster's **beliefs**, not your commitments. An item is allowed to be wrong,
to sit at low confidence forever, or to expire without anyone doing anything.
Nothing in it obliges you.

### Items have to earn belief

```text
candidate ──▶ corroborated ──▶ active ──▶ resolved / abandoned
```

A loop mined out of an offhand remark starts as a `candidate`: capped
confidence, at least one provenance row, and **unable to interrupt anyone** no
matter how it scores. Seeing independent evidence for the same loop promotes
it. This is what makes it safe for the mining pass to guess.

Identity is `(guildId, userId, kind, subject)`, so re-observing a loop
corroborates it instead of duplicating it. `subject` is case-insensitive.

### Bounded on purpose

An unbounded ledger is just a second knowledge graph. Items expire by their
own `expiresAt`, terminal rows are deleted after a fortnight, and the live set
is capped per person (`MAX_ITEMS_PER_USER`), weakest first by
`importance × confidence`.

### Writes are legalized

`applyMutations()` follows the graph's rule — **the model proposes,
deterministic code decides**. Unknown kinds and states are dropped, mined
confidence is capped, per-run caps bound how much one model response can
change, and `resolve`/`touch` may only target loops that already exist. A
model can never invent a loop through a resolve.

---

## Candidates come from state, never from imagination

The trap worth naming, because it is the obvious design and it is wrong:

```text
EVERY 20 MINUTES:
  send a memory dump to the model
  → "anything Rob might need?"
```

That buys unpredictable nagging, a large token bill, and hallucinated
relevance. Instead, **known state produces a bounded candidate list**, and the
model is only asked the narrow question it is actually good at.

Generators live in `attentionService` and are registered, so a new sensory
organ becomes proactive by adding one — not by teaching a model about it:

| Generator | Fires when |
|---|---|
| `deadline` | A tracked deadline is inside the horizon (72h) |
| `stale_loop` | A tracked loop has not moved in ~4 days |
| `waiting_for` | Something being waited on has gone quiet for ~5 days |
| `observatory_job` | A background run went wrong, or a *tracked* run finished |
| `project_mission` | A Project Mission is blocked, ready for review, or nearing its deadline |
| `contradiction` | The personal graph gained a `contradicts` edge |
| `unconfirmed_loop` | A mined guess is worth confirming |

Two details worth knowing:

- **A loop you are visibly working on has its urgency damped** (×0.45 if
  touched in the last day). Reminding somebody of the thing they are currently
  doing is the most annoying possible intervention.
- **`observatory_job` deliberately ignores plain completions.**
  `observatoryService` already sends a "your job finished" follow-up; a second
  ping saying the same thing is noise. It fires for runs that went *wrong*, or
  for runs attached to a loop Goobster is tracking — where the interesting
  part is the result, not the completion.
- **`project_mission` ignores drafts, approvals, step completions, and
  completed missions.** Those are loops the person is already in. It speaks
  only for `BLOCKED`, `REVIEW`, and an approaching deadline.

### Idempotence without a durable event log

Every candidate carries a stable `dedupeKey`. Raising a notice writes that key
with a unique constraint, so a candidate re-derived on the next sweep finds its
own notice and does nothing. Keys that should be able to recur include a coarse
time bucket (`stale:item:12:2026W33`).

This is why the event bus does not need to be durable: **a missed event delays
a notice, it never loses one.**

---

## Scoring

`utils/attentionScore.js` is pure math — no I/O, no model, no database — the
same separation `optionsMath`/`marginMath` get in the exchange.

```text
P = U × I × C × A − K

U  urgency        how time-pressured this is right now
I  importance     how much it matters to this person
C  confidence     how sure Goobster is he understands correctly
A  actionability  whether there is anything useful to do
K  interruption   what speaking up costs, right now
```

The **product** is the design. One weak factor disqualifies the whole
intervention, which is what we want: something urgent that Goobster only half
understands should stay quiet, and so should something well understood that
nobody can act on.

Consequently the score lives in a much narrower range than `[0, 1]`. Four high
factors multiplied still only reach ~0.7, so the bands are calibrated to the
reachable range, not spread across the unit interval:

| Band | Score | Meaning |
|---|---|---|
| discard | < 0.12 | dropped without a trace |
| inbox | 0.12 – 0.28 | accumulates in the Assistant Inbox |
| mention | 0.28 – 0.45 | raised next time you are already talking |
| DM | 0.45 – 0.75 | a proactive direct message |
| urgent | > 0.75 | interrupt |

`K` (`INTERRUPTION`) grows with notices already raised today, whether the
contact cooldown is running, and whether you are inside quiet hours. It is
capped so a genuinely urgent thing is never mathematically impossible.

One subtlety: interruption pressure can silence Goobster but should not make
him *forget*. A candidate pushed under the discard floor by `K` alone, whose
pre-cost value still clears it, is recorded in the inbox anyway — which costs
nothing.

---

## Model triage

When candidates survive scoring, one cheap model call asks exactly this: *of
these few candidates, which — if any — is worth interrupting for, and how would
you say them together in one breath?* It sees at most `maxTriaged` (6)
candidates with their scores.

Code keeps control:

- The model may nudge a score by ±0.2, no more.
- It can never raise something above the disposition scoring already assigned.
- It can never introduce a candidate it was not shown.
- **A veto demotes to the inbox; it never erases.** Scoring decides whether an
  observation is recorded, triage decides only how loudly it lands. Letting the
  model delete observations would put it back in charge of relevance, which is
  what the deterministic generators exist to prevent.
- A failed, unavailable, or unparseable response degrades to the deterministic
  scores and a templated digest. Triage is an improvement, never a dependency.

---

## The initiative spectrum

Two separate levers, because "proactive mode: on/off" cannot express the
difference between reading a repo and pushing to it.

**Initiative level** caps how loudly anything may land:

| Level | Goobster may |
|---|---|
| `observe` | notice and remember; never initiate contact |
| `nudge` | surface likely-useful observations |
| `assist` | also perform reversible/read-only work and report it |
| `delegate` | also initiate pre-authorized classes of action |

`observe` still fills the inbox — you asked to be able to look — it just never
reaches out.

**Category boundaries** say what is allowed within a domain:

```text
research:     proactiveRead yes · proactiveCompute yes · externalWrite confirm
schedule:     proactiveRead yes · proactiveCompute no  · externalWrite confirm
github:       proactiveRead yes · proactiveCompute yes · externalWrite never
```

Both gates apply. `proactiveRead: false` on a category means Goobster will not
bring that domain up proactively at all, whatever the level. Individual items
can also carry their own `allowedInitiative` ceiling.

**Enrollment is explicit.** No `attention_policies` row means none of this runs
for that person — the same opt-in shape as `/proactive` and `/monologue`.
Nobody gets proactively messaged because a feature shipped.

### Budget

Per person: `maxContactsPerDay` (default 3), `contactCooldownMinutes` (default
180), and optional quiet hours. Quiet hours hold *contact* only; the inbox
keeps filling.

---

## The two heartbeats

The guild heartbeat (`heartbeatService`) watches **channels**: its unit of
attention is recent conversation and its question is "should I say something in
here?". The personal heartbeat (`personalHeartbeatService`) watches **people**:
its unit is their open loops and its question is "has anything changed that Rob
would want to know about?".

They are separate because the guardrails genuinely differ — server opt-in and
channel activity versus personal enrollment, a contact budget, quiet hours, and
an initiative ceiling. Merging them would mean one set of thresholds pretending
to serve both.

The personal loop is deliberately dumb: it wakes every 10 minutes under
`withSingletonLock('personal_attention')`, picks the people who are due, and
hands each to `attentionService.sweepUser`. All judgement lives there; all
scheduling lives here. A person is swept every 45 minutes on the plain
rotation, or sooner if an event dirtied them — but never inside a 10-minute
floor, so a busy channel cannot sweep on every message.

---

## Watches: the third scheduling primitive

```text
Follow-up    "Remind me Friday."                  → waits for a TIME
Automation   "Every Friday, check the experiment." → repeats on a CRON
Watch        "When the experiment finishes, look." → waits for a CONDITION
```

A watch arms against a domain event topic (optionally with a payload
predicate) and fires **one** unattended agent turn when the condition occurs —
the same `handleChatInteraction` pipeline an automation uses, with the same
tools and guardrails. Then it is spent.

This is what makes long-running work feel attended rather than polled:

> Run this overnight and see whether the bifurcation persists.

1. Goobster launches the Observatory job.
2. He arms a watch on `observatory.job_completed` for that job id.
3. He goes away. **Nothing polls.**
4. The job finishes. `observatoryService._finishJob` publishes the event.
5. The watch claims itself atomically and runs a turn, handed the job's
   status, resume count, and output tails as opening context.
6. He DMs you what he makes of it.

Firing is claimed before the turn runs (the automation rule), so a restart or a
duplicated event can never double-run a watch. A watch with no explicit expiry
disarms itself after two weeks.

Watchable topics are the observable ones: `observatory.job_completed`,
`observatory.job_failed`, `observatory.job_interrupted`,
`observatory.job_started`, `reflection.completed`,
`knowledge.contradiction_detected`, `attention.item_resolved`,
`automation.ran`, plus `observatory.*` and `knowledge.*` wildcards.

---

## The internal event bus

`domainEventBus` is service-to-service; `eventBusService` is the portal's SSE
feed. They are separate because everything on the portal bus reaches a browser,
and domain events carry topics rather than refetch hints.

Transport mirrors the portal bus, so there is no new infrastructure: an
in-process `EventEmitter` always, plus `pg_notify` on a dedicated channel when
running on Postgres so events cross the bot/api boundary. Subscriptions accept
an exact topic, a namespace wildcard (`observatory.*`), or `*`.

**Nothing here is durable, by design.** Publishers use a fixed topic
vocabulary; payloads are ids and small scalars. Never put a decision on this
bus that cannot be recomputed from the database.

Current publishers: `memoryService.remember` (every conversational surface
converges there), `observatoryService` on every job transition,
`knowledgeReflectionService` on run completion,
`knowledgeGraphLegalizer` on a new contradiction, and the attention services
themselves.

---

## Reflection learns to attend

`knowledgeReflectionService` gained an `attend` pass. The other passes ask
"what can be distilled, woven, or tidied?"; this one asks **what latent open
loops are sitting in what this person said?**

```text
"I'll finish that this weekend."          → possible commitment
"We're waiting to hear whether CI passed." → waiting-for condition
"I really need to revisit that."           → low-confidence intention
"I still haven't figured out why..."       → open question
"Thursday's presentation..."               → future relevance
```

Crucially it does not turn every hint into a task. Everything lands as a
`candidate` with capped confidence and provenance back to the memories it came
from. It no-ops cheaply on scopes whose owner has not enrolled, and it only
runs on personal scopes — a server has nobody to attend to.

---

## Surfaces

### `/attention` (works in DMs, because attention is per-person)

| Subcommand | Does |
|---|---|
| `enable [initiative]` | Opt in and set the level |
| `disable` | Stop; ledger and settings are kept |
| `status` | Level, budget, quiet hours, loop counts, what he is tracking |
| `inbox` | Everything noticed but not interrupted about |
| `dismiss id:<n>` | Dismiss a notice (and teach him to raise that kind less) |
| `quiet [start] [end]` | Do-not-disturb hours in UTC, or clear them |
| `budget [per-day] [cooldown]` | Cap how often he may reach out |
| `watches` | Conditions he is currently waiting on |

### Tools

- **`trackAttention`** — record, review, or close an open loop. Records that
  something matters; schedules nothing.
- **`watchFor`** — arm, list, or cancel a watch.

The shared scheduling guidance in `toolPromptBuilder` routes requests: recurring
work to automations, timed reminders to follow-ups, **outcomes to watches**, and
unfinished business to `trackAttention`.

### In conversation

Notices with the `mention` disposition ride the next non-light chat turn as a
prompt block, then mark themselves delivered — the cheapest possible
interruption, because it isn't one. Skipped on `light` turns (an "ok" is not an
opening) and on unattended turns (a scheduled task is not a conversation).

### The Assistant Inbox (portal → Noticed)

Notices, the ledger behind them, armed watches, and the initiative dials. Each
notice has a **why?** view showing the five score inputs and how they combined:
a system that decides when to bother you should be able to explain itself.

Two deliberate absences:

- **The pane cannot create an open loop.** Loops come from evidence, so each
  traces back to why he believes it. A ledger you could type into would just be
  a task list.
- **There is no plain delete on a notice.** Dismissing *is* the feedback.

---

## Learning intervention preferences

Every notice records outcomes in `attention_feedback`: `surfaced`, `opened`,
`dismissed`, `acted_on`, `snoozed`, `useful`, `annoying`. Per category, over a
30-day window, that shifts the bands:

```text
observatory, no history:        dm bar 0.75
observatory, 5 dismissals:      dm bar 0.95   (harder to reach you)
schedule,    5 acted on:        dm bar 0.55   (easier)
```

Bounded (`maxShift` 0.2), symmetric, and requiring `minSamples` before it
applies. This is calibration, not a learned policy — dismissing runs must never
silence deadlines.

---

## Storage

| Table | Holds |
|---|---|
| `attention_items` | The ledger of open loops |
| `attention_provenance` | Why each loop is believed |
| `attention_notices` | The Assistant Inbox, with score inputs and `dedupeKey` |
| `attention_feedback` | Intervention outcomes, per category |
| `attention_watches` | Armed conditions |
| `attention_policies` | Initiative level, boundaries, budget, quiet hours |
| `attention_state` | Per-person sweep/contact anchors and the dirty flag |

All DDL is in `db/schema.sql`; new columns on existing tables go in
`db/migrations.js`.

---

## Privacy

`/forget-me` erases the whole attention footprint in the same transaction as
everything else: items (provenance cascades), notices, feedback, policy, state,
and **any armed watch** — a watch left behind would run an agent turn for a user
who asked to be forgotten.

`/what-do-you-know-about-me` reports the initiative level, the loop and notice
counts, armed watches, and the loops themselves. These are the beliefs that
decide whether Goobster interrupts you, so they are the most important thing to
be transparent about.

---

## Extending it

- **A new sensory organ** (calendar, email, CI): publish a domain event, add a
  candidate generator, and give the domain a category boundary. Do not teach a
  model about it.
- **A new watchable condition**: add the topic to `domainEventBus.TOPICS`,
  publish it, and list it in `WATCHABLE_TOPICS`.
- **Richer opening context for a watch**: extend
  `attentionWatchService._describeEvent`.
- **A different mining strategy**: register another reflection pass; `attend` is
  not special.

The invariant to preserve through all of it: **candidates are derived from
durable state, and the model only ever judges a short list it was handed.**
