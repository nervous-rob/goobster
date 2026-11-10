# ADR 0031: Seven typed answers, each with one effect in the system it belongs to; a learned rate that only scales a daily proposal cap

## Status

Accepted for DA-10 of the
[delegated assistant plan](../delegated_assistant_implementation.md). It
builds on [ADR 0016](0016-delegated-responsibilities.md) (the grant and its
lifecycle), [ADR 0017](0017-initiatives-updates-processes.md) (initiatives,
source adapters, canonical updates),
[ADR 0026](0026-wider-opportunity-sources.md) (the daily proposal cap),
[ADR 0027](0027-delegated-knowledge-work.md) (change sets on a person's
notes), the shared contact path of DA-9
([delegated_delivery.md](../delegated_delivery.md)) and the owner-only pilot
gate of DA-12a
([delegated_operations.md](../delegated_operations.md#the-pilot-gate)).
Behaviour is documented in
[delegated_feedback.md](../delegated_feedback.md).

The number 0031 was reserved for this increment.

The code, under `packages/core/services/`: `assistantFeedbackService.js`
(the kinds, what is offered, the one effect of each, weak signals),
`assistant/sourceWeights.js` (the learned rate),
`assistantInitiativeService.js` (`_capFor()`, the only reader of a rate),
`knowledgeChangeSetService.js` (`recordFeedback()`),
`attentionPolicyService.js` and `attentionService.js` (`avoidHours`,
`WRONG_TIME`).

## Context

Architecture 13.4 names seven kinds of feedback and two tables, and gives
the rules: one effect per kind, signals that are numbers and enums, a weight
that changes only how often an adapter may propose, ignoring that cannot
silence a source, and everything shown with a reset. The acceptance
scenarios add that "wrong time" changes timing and nothing about topics,
that "wrong" deletes no evidence, that "stop this responsibility" is the
ordinary confirmed action, and that no learned signal can widen a grant,
raise a budget or skip authorization.

Three things were open: what a weight is arithmetically, where "wrong
time" is stored without becoming a second calibration path beside
Attention's own, and what "opens a correction" means when no editor is
part of the feedback control.

## Decision

1. **Feedback is a kind, never text.** `assistant_feedback` stores the
   kind, the ids of the item, the responsibility and source it concerned,
   and an effect code with a small numeric detail. There is no comment
   field. Nothing in either table is ever read into a prompt, so feedback
   cannot become an instruction to a model.

2. **Each kind makes one change, in the service that owns the thing
   changed, inside one transaction with the feedback row.** The feedback
   service owns no state of its own beyond the record: counters and weights
   belong to `sourceWeights`, notes to the change-set service, hours to the
   Attention policy, the stop to the responsibility service. A kind that
   would change nothing for an item is not offered, and asking for it is
   refused, so a recorded answer always had its effect.

3. **A learned rate is one row per responsibility and adapter, read in one
   place.** `sourceWeights.capFor()` is called where the daily proposal cap
   is taken and nowhere else. It returns the adapter's cap or less, never
   more. That is the whole argument for "no learned signal widens
   anything": authorization, budgets and the run's tool table do not import
   the module.

4. **Explicit and weak signals are different parts of the row.** `weight`
   moves only on "less of this", down fixed steps (1, 0.5, 0.25, 0), and
   only a reset (deleting the row) raises it. `dismissals` and
   `acceptances` are the weak part: every five net dismissals take one off
   the cap, at most two, with a floor of one a day. So the only way to
   zero is an explicit answer given three times.

5. **Ignoring is recorded once, by the steward.** A proposal untouched, or
   a finding unopened, for seven days gets one `ignored` row (a stored kind
   nobody can give) and counts as one dismissal. A later dismissal of the
   same piece of work is not counted again.

6. **Only adapters that notice by themselves learn.** Each adapter declares
   `learns`. Work the person asked for (a conversation request, a plan
   step, a chat request by name) is never slowed by what they said about
   something else.

7. **"Wrong time" is a list of hours on the Attention policy, checked only
   for delegated contact.** `attention_policies.avoidHours` holds at most
   twelve hours. `contactAllowed()` returns `WRONG_TIME` for a caller whose
   reason is not `attention`. Attention's notices, score and calibration do
   not read it, so the plan's risk of "a second calibration path for the
   same signal" does not arise: it is a second quiet window for one
   producer, not a learned score.

8. **"Wrong" marks the run's own note disputed, as a change set.** The
   mark is a revision of the note; the change set (`direct_change`, policy
   `FEEDBACK_WRONG`) puts it under *Changes to your notes* with the
   existing Undo. Evidence, provenance and research claims are untouched.
   "Keep this wording" is the same shape with `FEEDBACK_KEEP`: the note
   becomes saved, which later runs must respect (ADR 0027).

9. **"Stop this responsibility" calls `responsibilities.act()`.** The
   client confirms with the same question as the row's own button and
   sends the revision it showed; the service refuses a stale one. There is
   no feedback-only way to pause or revoke.

10. **The gate covers giving, not seeing.** Capability `feedback` is
    required to give an answer and to have weak signals counted. Reading
    and resetting what was learned is never gated, because a learned
    reduction keeps applying after the pilot closes and must stay
    reversible. Giving feedback works during the host's stop-all, like any
    of the person's own narrowing actions; the ignored pass does not run
    then.

## Consequences

- A person can always see why a source proposes less (the row on the
  responsibility) and return it to its usual rate in one action.
- A rate is per responsibility, so disliking a source under one
  responsibility teaches nothing about it under another.
- Adding a source adapter means deciding `learns`. An adapter with no daily
  cap of its own gets the default cap once something lowered it.
- The two tables are per-person data: the account export, the transparency
  report, the privacy audit and `/forget-me` cover them; the steward prunes
  feedback whose items are gone, and rates of ended responsibilities, after
  180 days.
- Architecture 13.4 listed seven stored kinds and six weight columns. The
  tables carry a little more: the `ignored` kind, `responsibilityId`,
  `adapter` and the effect on a feedback row, and `ownerUserId` on a weight
  row (erasure by person without a join).

## Alternatives rejected

- **A continuous score per adapter** (decay, moving averages). Harder to
  show, harder to reset to a known state, and a person cannot predict what
  one more click does. Fixed steps can be stated in a sentence.
- **Letting acceptances raise a cap above the adapter's own.** It would
  make a learned signal a way to get more autonomous work than the adapter
  was reviewed for.
- **Moving the digest time on "wrong time".** It would change a setting the
  person chose, and says nothing for a contact. Holding the hour is the
  smaller change and is visible as what it is.
- **Feeding feedback history to the selection model.** Excluded by the
  architecture's rule; it would also make the effect uninspectable.
- **Using Attention's `attention_feedback` for delegated findings.** That
  table calibrates Attention's own notice categories; delegated findings
  have no score to calibrate.
