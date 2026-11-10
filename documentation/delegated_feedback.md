---
title: Delegated feedback (seven typed answers, learned source rates, hours to avoid)
kind: reference
summary: How you tell delegated work what you thought of it, and what it learns. A finding or a piece of proposed work takes one of seven typed answers - useful, already knew this, this is wrong, less of this, wrong time, keep this wording, stop this responsibility. Each changes exactly one thing in the system it belongs to - a counter or the daily proposal rate of one source of one responsibility (`assistant_source_weights`), the note the finding wrote (marked disputed or kept, as an undoable change), the hours delegated work will not contact you in (`attention_policies.avoidHours`), or the ordinary confirmed pause or revoke. Dismissing or ignoring is weak feedback that can slow a source to one proposal a day and never silence it. What was learned is shown on the responsibility with a reset. No feedback is text, none reaches a model, and nothing learned can widen a grant, raise a budget or skip authorization. Covers the routes, what is stored, privacy, the pilot gate and the defaults chosen.
when: Understanding what a feedback button on Home or the Assistant page will change; why a source proposes less than it used to and how to reset it; why a digest or contact was held with WRONG_TIME; removing an hour marked as a wrong time; why a kind is not offered on an item (NOT_OFFERED); why feedback is refused (PILOT_ONLY); what `assistant_feedback` and `assistant_source_weights` hold and how they are exported, erased and pruned; adding a source adapter that should or should not learn.
tags: [assistant, responsibilities, feedback, learning, sources, attention, knowledge, privacy, portal]
feature: assistant
---

# Delegated feedback

A finding on [Home](assistant_home.md) and a piece of work on the Assistant
page each have a **Feedback** control. It offers up to seven answers. Each
answer changes one thing, says what it changed, and the change is shown
where it lives and can be put back there.

Until the host records the pilot decision
([delegated_operations.md](delegated_operations.md), "The pilot gate"),
giving feedback is available to the installation's owner only.

## The seven answers

| You say | It changes | Where you see it and undo it |
| --- | --- | --- |
| **Useful** (`useful`) | One count in favour of the source this came from, for this responsibility | The responsibility's "Learned from your feedback" lines; Reset |
| **Already knew** (`already_knew`) | One count against that source, for this responsibility | The same lines; Reset |
| **This is wrong** (`wrong`) | The note the finding wrote is marked **disputed**. Nothing is deleted | Assistant page → *Changes to your notes*; Undo |
| **Less of this** (`less_of_this`) | That source may propose less often for this responsibility | The responsibility's "Learned from your feedback" lines; Reset |
| **Wrong time** (`wrong_time`) | The hour it was sent is added to the hours delegated work will not contact you in | Settings → Initiative → *Hours marked as a wrong time*; Allow again |
| **Keep this wording** (`keep_wording`) | The note the finding wrote becomes a saved note of yours, which the assistant no longer rewrites | *Changes to your notes*; Undo |
| **Stop this responsibility** (`stop_responsibility`) | The responsibility is paused or revoked, after you confirm | The responsibility's row; Resume (after a pause) |

What each answer does **not** do:

- **Wrong time changes timing only.** It touches no source, no counter and
  no note, so it teaches nothing about the topic.
- **This is wrong deletes nothing.** The note, its history, the sources it
  cites and any research claims stay. The note is marked disputed through an
  ordinary revision, so it stops being presented as current until you
  correct it or undo the mark.
- **Useful and already knew move a counter only.** They never change a
  note, a time or a grant.
- **Less of this changes how often one source proposes.** The responsibility
  keeps its grant, its budgets and its other sources.
- **Stop this responsibility is the ordinary action.** It is the same pause
  or revoke as the buttons on the responsibility's row, with the same
  confirmation, the same revision check and the same record. Feedback has no
  way to stop anything of its own.

No answer is free text. `assistant_feedback` holds a kind, ids and a short
effect code. Nothing recorded as feedback, and nothing learned from it, is
ever put in a prompt or given to a model.

## Which answers are offered

An answer is offered only where it would change something:

| Answer | Offered when |
| --- | --- |
| Useful, already knew | On a finding whose source learns (below) |
| Less of this | On a finding or a proposal whose source learns, until that source is already at "proposes nothing" |
| This is wrong | On a finding whose run wrote a note that is still current |
| Keep this wording | On a finding whose run wrote a note that is still a generated note |
| Wrong time | On a finding that was sent to you outside the portal (a contact or a digest) |
| Stop this responsibility | When the responsibility is active (pause or revoke), or paused or awaiting review (revoke) |

- A **proposal** has found nothing, written nothing and sent nothing, so it
  offers only "less of this" and "stop this responsibility".
- A **request waiting for your decision** takes no feedback: decide it.
- A **finding shared with a project** takes no feedback on the shared copy.
  The person whose responsibility found it answers on their own notice.
- A note a run only confirmed was written by other work; it is not that
  finding's note, and "this is wrong" on the finding does not touch it.
- Each answer can be given **once per item**. Saying it again (a second
  click, a second tab) changes nothing and reports "You already said that".
  Asking for an answer that is not offered is refused with `NOT_OFFERED`
  (409) and changes nothing.
- Giving feedback does not mark a finding reviewed.

The portal shows work items the control for proposed work, work waiting for
review and finished work.

## What a source learns

A **source** is one opportunity adapter of one responsibility
([delegated_opportunity_sources.md](delegated_opportunity_sources.md)).
What is learned is one row per responsibility and source in
`assistant_source_weights`, and it changes exactly one number: **how many
pieces of work that source may propose in a day under that responsibility**.

It is read in one place, where the daily proposal cap is taken. It is never
read when a grant is checked, when a budget is reserved or when a run's
tools are chosen.

**Sources that learn** are the ones that notice things by themselves:
`attention_item`, `project_plan`, `followed_source`, `job_failure`,
`ci_verdict`, and `chat_request` for an implied request or a commitment.
**Sources that never learn** are work you asked for: `conversation_request`,
`project_plan_step` (a step you put on the plan), a `chat_request` you made
by name, and `process_incident` (the repair of a process you named in the
grant, [process_stewardship.md](process_stewardship.md)). Those are always
taken, whatever you said about earlier ones.

### Less of this

Each "less of this" moves the source's weight one step down:
**1 → 0.5 → 0.25 → 0**. The daily cap is the source's usual cap times the
weight, rounded, and at least 1 while the weight is above 0.

| Usual cap 3 | Weight | May propose |
| --- | --- | --- |
| Nothing learned | 1 | up to 3 a day |
| Said once | 0.5 | up to 2 a day |
| Said twice | 0.25 | up to 1 a day |
| Said three times | 0 | nothing |

A source without a daily cap of its own (`attention_item`, `project_plan`)
stays uncapped until something lowered it, and is then treated as having
the default cap of 3.

Only "less of this" reaches zero, and only **Reset** raises a rate. Nothing
learned ever gives a source more than its usual cap.

### Weak feedback

What you do without answering also counts, slowly:

| Counts in favour (`acceptances`) | Counts against (`dismissals`) |
| --- | --- |
| Starting a proposal | Dismissing a proposal |
| Accepting a result | Rejecting a result |
| "Useful" | "Already knew this" |
| | A proposal left untouched, or a finding left unopened, for 7 days (recorded once as `ignored`) |

Every **5** counts against that are not offset by a count in favour take
one proposal a day off the cap, **at most two, and never below one a day**.
The lead of one counter over the other stops at 10, so a long run of
dismissals can always be worked back. Ignoring and dismissing alone cannot
silence a source.

A proposal that was left alone for a week and dismissed afterwards is one
count, not two. The steward records ignored items on its pass; it does not
do so while the host has stopped delegated work.

### Seeing and resetting it

The responsibility's row on the Assistant page shows one line per source
that learned something, for example:

> **Items you kept from followed sources**: may propose up to 2 a day now
> (usually up to 3 a day) · you said "less of this" once · **Reset**

Reset asks for confirmation and deletes the row, so the source proposes at
its usual rate again from the next look. The feedback you gave stays on
record. The "Today" line of the responsibility's sources shows the cap in
force ("2 of 2 proposed").

Seeing and resetting what was learned is **never gated**: if the pilot
decision is taken back, what was learned still applies (it only ever
narrows) and you can still reset it.

## Wrong time

"Wrong time" on a finding that reached you outside the portal marks **the
hour it was sent**, on the clock your quiet hours use (your timezone when
quiet hours are local, otherwise UTC).

- A digest or a contact about delegated work is held in a marked hour with
  `WRONG_TIME` and goes out on a later pass, exactly like quiet hours
  ([delegated_delivery.md](delegated_delivery.md)).
- **Attention's own notices are not affected**, and its scoring and
  calibration never see the mark ([attention.md](attention.md)).
- At most **12** hours can be marked. Asking for a thirteenth is refused
  with `AVOID_HOURS_FULL`: set quiet hours instead.
- Settings → Initiative → *Hours marked as a wrong time* lists them
  ("14:00–15:00") with a button to allow each again; the change applies
  when you save ([user_settings.md](user_settings.md)). Stored as
  `attention_policies.avoidHours`.

## This is wrong, and keep this wording

Both act on the notes the finding's run **wrote** (up to 10), through the
change record every delegated change to your notes uses
([delegated_knowledge.md](delegated_knowledge.md)):

- **This is wrong** marks each note disputed with a revision, and records
  a change "You said this was wrong" (`FEEDBACK_WRONG`).
- **Keep this wording** turns each generated note into a saved note of
  yours (`FEEDBACK_KEEP`), which later runs may not rewrite.

Each is listed under *Changes to your notes* with **Undo**, which puts the
note back as it was. Correcting the note is the ordinary edit.

## Stop this responsibility

The control shows **Pause** or **Revoke** (what the responsibility's state
allows) and the portal asks the same confirmation question as the
row's own button. The server then runs the ordinary lifecycle action with
the revision you were shown; if the responsibility changed in between, it
answers `REVISION_CONFLICT` and nothing happens. Pausing and revoking only
narrow, so they need no confirmation receipt
([delegated_conversation.md](delegated_conversation.md)).

## Nothing learned widens anything

- A learned rate can only be at or below the source's usual cap.
- No feedback, counter or weight is read by grant checks, budgets, the
  run's tool table or the confirmation of an activation.
- "Useful", however often, never raises a cap above the usual one, never
  lifts a daily limit and never starts work.
- Reset returns a source to its usual rate, not above it.

## The pilot gate and stop-all

- Capability **`feedback`**: giving any answer, and having weak feedback
  counted, needs it. Without it the control is not shown, the routes answer
  `PILOT_ONLY` (403), and starting or dismissing work counts nothing.
- Seeing and resetting learned rates and removing a marked hour are not
  gated.
- Giving feedback is your own action, like pausing, so it works while the
  host's stop-all is on. The pass that records ignored items does not run
  during a stop.

## Routes

| Route | Does |
| --- | --- |
| `POST /api/app/assistant/updates/:id/feedback` | `{ kind, stop?, expectedRevision? }` on one of your own findings |
| `POST /api/app/assistant/initiatives/:id/feedback` | The same on a piece of your own work |
| `POST /api/app/assistant/responsibilities/:id/sources/:adapter/reset` | Forget what one source learned |
| `GET /api/app/assistant/responsibilities` | Also returns `learned`: every learned rate |
| `GET /api/app/home`, `GET /api/app/assistant/initiatives` | Each item carries `feedback`: `{ offered, given, stop, adapter }` |

A feedback call answers `{ feedback, existing, message, state }`; `message`
is the sentence the portal shows. Someone else's item, a shared finding and
an unknown id are all `NOT_FOUND` (404).

## What is stored

| Table | Holds | Kept |
| --- | --- | --- |
| `assistant_feedback` | `userId`, the update and/or the work, the responsibility, the source, `kind` (the seven, or `ignored`), an effect code and small effect detail (an hour, a from/to weight, change ids) | 180 days after both the update and the work are gone |
| `assistant_source_weights` | `responsibilityId`, `ownerUserId`, `adapter`, `weight`, `dismissals`, `acceptances` | Until reset; 180 days after the responsibility ended; deleted with the responsibility |
| `attention_policies.avoidHours` | The marked hours | With the policy |

The [outcome summary](delegated_pilot.md#the-outcome-summary) on the
Assistant page counts the answers you gave, per responsibility and kind,
and the items you left untouched for a week; it derives no score from them.

No title, summary, note text or message is in either table. `/forget-me`
deletes both, the privacy audit counts them, the account export includes
them, and the transparency report shows the number of answers given, the
number of sources with something learned and how many were lowered.

## Code

- `services/assistantFeedbackService.js` - `give()`, the offer rules,
  `noteDecision()`, `sweepIgnored()`, `learned()`, `resetRate()`, `prune()`.
- `services/assistant/sourceWeights.js` - `scale()`, `capFor()`, `lower()`,
  `count()`, `describe()`, `reset()`.
- `services/assistantInitiativeService.js` - `_capFor()` (the one reader of
  a learned rate) and the weak signals in `act()`.
- `services/knowledgeChangeSetService.js` - `recordFeedback()`.
- `services/attentionPolicyService.js` - `addAvoidHour()`,
  `setAvoidHours()`, `avoidsHour()`; `services/attentionService.js` -
  `contactAllowed()` (`WRONG_TIME`).
- `services/assistantStewardService.js` - the ignored pass and retention.
- Portal: `components/AssistantFeedback.tsx`,
  `rooms/assistant/ResponsibilityRow.tsx`,
  `rooms/settings/InitiativeSection.tsx`.

Tests: `tests/assistantFeedbackService.test.js`,
`tests/assistantDeliveryService.test.js` (CI group `privacy`, both engines)
and `e2e/assistantFeedback.spec.js`. Reasons: ADR 0031.

## Defaults chosen where the plan left them open

- **Weight steps 1, 0.5, 0.25, 0**; three "less of this" silence a source.
- **Weak feedback: 5 net counts against per proposal a day, at most two
  off, floor one a day; counters stop at a lead of 10.**
- **Ignored after 7 days**, recorded once per piece of work as `ignored`
  (an eighth stored kind that nobody can give).
- **Wrong time marks whole hours, at most 12**, and holds delegated
  contacts and digests only.
- **"This is wrong" marks the note disputed** rather than opening an editor:
  the correction itself is the ordinary note edit, and the mark is the
  undoable record that one is due. Research claims are left alone.
- A source that learned keeps its lowered rate if the pilot closes.
- Work you asked for never learns and is never slowed.

## Not built yet

- Feedback from a notification or a Discord message (portal only).
- Feedback on a finding shared with a project by its other members.
- Ranking: a learned rate limits how many are proposed, not which.
- Moving the digest time from "wrong time" (it holds the hour instead; the
  digest goes out when the hour ends).
