# ADR 0026: Four more opportunity sources, each a pilot capability, each under a daily cap, with one narrow model label for personal chat

## Status

Accepted for DA-8 of the
[delegated assistant plan](../delegated_assistant_implementation.md). It
builds on [ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0017](0017-initiatives-updates-processes.md) (initiatives, source
adapters and cursors), [ADR 0018](0018-delegated-runs.md) (the run),
[ADR 0021](0021-conversation-requests-and-steering.md) (the stream adapter
shape, explicit conversation requests) and on the owner-only pilot gate of
DA-12a (`assistantAccessService`; see
[delegated_operations.md](../delegated_operations.md#the-pilot-gate)).
Behaviour is documented in
[delegated_opportunity_sources.md](../delegated_opportunity_sources.md).

The number 0026 is the next free one in the ADR register.

The code, under `packages/core/services/`:
`assistant/sources/{chatRequest,followedSource,jobFailure,ciVerdict}.js`
(the adapters), `assistant/sources/access.js` (scope and grant checks),
`assistant/proposalCaps.js` (the daily cap),
`assistant/messageClassification.js` (the one model label),
`assistant/opportunityRun.js` and `assistant/originRuns.js` (the run side and
origins), `assistantInitiativeService.js` (the generalized engine and
`sourcesOverview`) and `assistantResponsibilityService.js` (`permits()` and
the activation check).

## Context

DA-4b let a person ask for work by name in a conversation, by fixed rules.
What was left by the plan for DA-8: noticing work the person did not ask for
by name - in their own chat, in an item they kept, in a project run that
failed, in a CI verdict - without turning every message, retry and red
build into a task. The acceptance scenarios are: a restart loses nothing and
a replay adds nothing; a passing mention proposes nothing and "can you look
into that for me" proposes one item citing the message; a source that can no
longer be read stops proposing at once; a failed run proposes one
investigation per cause; skipped CI is not passing; a flood cannot exceed the
cap or the budgets; deleting a conversation removes what came from it.

Three things make this riskier than DA-4b. A model now reads a person's
private chat. The sources are noisy (retries, flaky CI, a feed that changes
hourly). And the owner has not yet decided who may use any of it: every
capability added by DA-7 to DA-11 sits behind the pilot gate.

## Decision

1. **Four adapters, one per source, none inferred.** `chat_request`
   (scope `personal_chat`), `followed_source`, `job_failure`, `ci_verdict`
   (scope = name). Each needs its scope in `scopes.sources` and, where it
   reads a record the grant can name, a `read` grant that `permits()` (the
   same code `authorize()` runs at dispatch) accepts: the process
   `followed_source:<id>`, the project, the repository with its project.
   Personal chat needs no extra grant; the owner's choice of scope is the
   consent, and the learn-from-chats preference and memory exclusions still
   apply.

2. **The pilot gate, at five points.** Adapters declare `capability:
   'sources'`. (a) Activation refuses a responsibility that names a gated
   scope unless `assistantAccessService.allows(owner, 'sources')`
   (`PILOT_ONLY`). (b) The engine, before every pass, skips a gated adapter
   for an owner who lost the capability and supersedes what it proposed.
   (c) The same check skips it while the host's stop-all is on, without
   withdrawing anything. (d) At dispatch, a run for work that came from one of
   these sources asks again before any model call and ends `PILOT_ONLY` when
   the capability has been closed since it was proposed. (e) The portal offers
   the choices only when `GET /assistant/access` says the capability is open.
   Recording the pilot decision opens all five with no migration.

3. **History is not an order, for every adapter.** The first look records
   where the source stands and proposes nothing. For record adapters whose
   change can be observed without being an opportunity, a source may be
   `observe`d: the cursor moves, nothing is proposed. That one mechanism
   carries both "an entry nobody kept" and "CI pending, skipped, incomplete".

4. **Cause, not retry.** `job_failure` defines a failure cause as
   `hash(status, exit code, exception class, last own-file frame)` (or the
   language and asset version when the output names neither). A cause is new
   when no failure of the acting person's in the project within 30 days has
   it; each cause is proposed once per responsibility. Only the acting
   person's own jobs count; assistant-run jobs and plan-step children never
   do; the cursor never passes a running job.

5. **Skipped is not passing.** `ci_verdict` reads the CI watch's stored
   verdict (never GitHub), proposes `failure` and a `success` that follows a
   settled `failure`, and only observes everything else. It remembers the
   last *settled* state in its cursor so a skipped or pending interlude does
   not erase that the branch was red. The run re-reads the exact commit
   through the person's own connection and is told the counts and what was
   skipped.

6. **A model label for personal chat, and nothing else.** Fixed rules come
   first: a request by name is explicit and uncapped; the same wording
   without the name is implied. Only a message with a request-like cue and no
   rule match is shown to a model, once, for one of four labels. The message
   is data in the prompt; the answer is parsed to one word; anything else is
   `none`; the label never widens authority. The label (not the text) is
   cached per message and responsibility revision. The call is charged to the
   responsibility's token budget under work kind `assistant_classification`,
   limited to 10 percent of the day's budget, limited to 5 judgements per
   pass, and off during the host's stop-all. When a message cannot be judged
   the reading position waits before it. Shared conversations (Parlor,
   project) stay explicit-by-name: no model reads another person's words.

7. **A cap that is a counter, not a queue.** Each adapter's implied or
   self-noticed proposals take a slot from `assistant_proposal_counters`
   (responsibility, source kind, UTC day) with one conditional UPDATE inside
   the transaction that inserts the proposal. Past 3 the change is counted as
   not proposed and the cursor moves on. Explicit requests by name keep the
   DA-4b open limit of 10 and no daily cap. The default is a constant for
   DA-10 to scale.

8. **One origin model.** Every source stores a reference as `origin` and never
   text. The run loads it again as the person, under the adapter's own
   `locate()`, before any model call; the same `locate()` is the adapter's
   `stale()` test, so "can no longer be read" ends the proposal on the next
   pass. A run's evidence (a chat line, a page, a stack trace, a CI summary)
   is between markers and cannot widen the grant.

9. **A preview, not a promise.** `GET .../responsibilities/:id/sources` shows
   the cutoff, how much existing history a source would ignore, examples,
   and today's counts. It calls no model.

## Consequences

- A gated capability can be closed again by the host: responsibilities that
  name a source keep their grants and stop noticing; their open work is
  withdrawn, not their history.
- Classification is the first model call on the steward path. It is bounded
  by pass, by day and by budget, but it is the reason a message can wait: with
  no provider the reading position stalls at that message until it ages out
  (7 days) or a provider appears.
- Pausing and resuming does not take a new baseline (as in DA-4b); the
  bounded windows and the cap limit what a resume can propose. A catch-up
  preview is not built.
- A run is still offered every tool and refused at dispatch what the grant
  does not name. Offering only granted tools was considered and left out: it
  would turn every refusal test (the proof that the dispatch gate holds) into
  a test of the offer instead.
- `fix`-mode CI watches are not noticed; the watch owns them.
- The number of adapters is now six. `SOURCES` stays one object, one line per
  adapter; the engine learned `capability`, `dailyCap`, `observe`,
  `cursorRevision`, `propose`, `alreadyWork`, `locate` and `lookback` as
  optional parts of the contract.
