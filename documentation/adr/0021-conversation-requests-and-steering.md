# ADR 0021: Requests addressed to Goobster in a conversation become proposed work by fixed rules, a change of direction supersedes what has not finished, and project boards read the canonical gates

## Status

Accepted for DA-4b of the
[delegated assistant plan](../delegated_assistant_implementation.md). It
completes DA-4 together with
[ADR 0019](0019-delegated-plan-steps.md) (DA-4a, the `agent` plan step) and
builds on [ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0017](0017-initiatives-updates-processes.md) (initiatives, source
adapters, canonical updates and gates) and
[ADR 0018](0018-delegated-runs.md) (the run). Behaviour is documented in
[delegated_conversation_requests.md](../delegated_conversation_requests.md)
and, for boards, in [assistant_home.md](../assistant_home.md#project-boards).

The code, under `packages/core/services/`:
`assistant/conversationRequests.js` (what counts as a request),
`assistant/sources/conversationRequest.js` (the source adapter),
`assistant/steering.js` (a change of direction),
`assistant/conversationRequestRun.js` (what a run is given, and the link
back), `assistant/sources/projectPlanStep.js` (`stale()`),
`assistantInitiativeService.js` (stream sources) and
`assistantGateService.js` (`projectBoard()`).

The number 0020 is left free: another stage in flight uses 0019 as well and
will be renumbered when it lands.

## Context

Three things were left for the second half of DA-4:

1. Work that starts from what a person says in a project conversation or a
   discussion (journey B: "a discussed library comparison is researched under
   a grant without inventing a commitment to migrate").
2. A change of direction ("new steering supersedes queued work and names the
   downstream assumptions"). Until now a superseding source revision replaced
   one open attempt; nothing reacted to a person saying "stop".
3. Project Needs-you boards that are a project-filtered view of the same
   gates Home and the Inbox show (journey G), instead of a second list.

The owner's decision for this stage (decision 4): **DA-4 owns project and
Parlor conversations and acts only on explicit requests addressed to
Goobster.** Reading conversations with a model for what people might want,
and one-to-one chat, belong to DA-8. Decision 3 still holds: a
responsibility never approves, starts or finally accepts a plan. Decision 5:
a responsibility is one person's; shared responsibilities are deferred.

Conversations are shared spaces. A project conversation is read by every
member; a private run acts for one person. The design has to keep other
people's words out of that person's run, and keep the run's output out of
the shared space, until a shared audience exists (DA-11c).

## Decision

### Requests

1. **Opt-in per responsibility, by source scope.** `scopes.sources` gains
   `project_chat` (the conversations of the linked project) and `parlor`
   (the person's own discussions outside any project). `personal_chat`
   stays reserved. A source says where requests are read; operations still
   say what a run may do.

2. **A request is recognized by fixed text rules, with no model.** A message
   is a request when it addresses the assistant by name (the name opens or
   closes the message, or it is @-mentioned) and what is left is an optional
   polite form followed by a verb from a fixed list of work verbs. The name
   is the installation's `identity.assistantName`. A rule a person can read
   is one they can predict, and it cannot be talked into anything.

3. **Only the acting person's own messages.** The adapter reads messages
   with `role = 'user'` and `userId` = the person the responsibility acts
   for, in conversations that person can read now (the same predicate
   `parlorService` applies before it shows a conversation). Copied-in
   history (a moved chat, a shared answer) is excluded.

4. **A stream source adapter.** Existing adapters fingerprint one record.
   `conversation_request` walks the message log from one cursor per
   responsibility (`sourceId = "messages"`, revision = last message id
   examined). The first look records where the log ends and proposes
   nothing. The cursor, the proposals and any supersession from one pass
   commit in one transaction. The cursor is held 2 seconds behind the newest
   message so an id committed late on Postgres is not skipped; a message is
   proposed once whatever the cursor says, because the attempt's dedupe key
   is the message.

5. **References, not text.** An attempt stores `originJson`
   (`{ kind: 'parlor_message', surface, conversationId, messageId,
   speakerUserId, audience }`) and a title that names the conversation. The
   message is read again, under the person's current access, when it is
   shown (`origins()`) and when the run starts (`load()`). A message that is
   gone or unreadable ends the attempt `SUPERSEDED` (`SOURCE_GONE`); a
   conversation the responsibility no longer covers,
   `SOURCE_NOT_COVERED`. Neither calls a model.

6. **One message into the run.** The run is given the request's text and
   nothing else from the conversation. Its prompt says the request grants no
   permission, that looking into something is not deciding it, and that the
   report goes only to the asker. Tool authority is unchanged: every call
   passes `authorize()` against the responsibility.

7. **The result is a private update with a link back.** It adds the
   `conversations` component and an `open_conversation` action. Nothing is
   posted into the conversation, no decision is recorded, and there is no
   run tool that writes to a plan.

8. **Bounded volume.** One message is one attempt. The same words while an
   attempt from that conversation is open are the same request. The oldest
   active responsibility of a person that covers a conversation takes its
   requests. A responsibility holds at most 10 open conversation attempts;
   a request past that is recorded `CANCELLED` (`OPEN_LIMIT`) so it is
   visible and retryable and the cursor keeps moving (stalling the cursor
   would also stall a later "stop").

### Steering

9. **Steering is recognized by the same kind of rule**: an addressed message
   whose remainder opens with a fixed change-of-direction phrase or a
   negation, or a request ending in "instead". It may carry a replacement
   request; the clause a negation opens is never the replacement.

10. **It supersedes the same person's unfinished attempts from the same
    conversation.** `CANDIDATE`, `QUEUED` and `WAITING` attempts end
    `SUPERSEDED` (`STEERED`); a `RUNNING` attempt is also set `SUPERSEDED`
    and loses its lease, so its run stops at the next tool call through the
    existing lease fence, writes no result, and its children are cancelled
    by the steward. `supersededBy` records the steering message.

11. **One update names what rested on the earlier direction**: how many
    attempts had not started, how many were stopped mid-work, the changes a
    stopped run had already applied (from its journal; left as they are),
    research it had started, and results finished under the earlier
    direction in the last 7 days. It is rewritten once the stopped run has
    actually ended. It names the conversation and counts, never a message.

12. **Nothing is undone, and finished results are not withdrawn.** The
    owner can retry a superseded attempt.

13. **Plan work is superseded by the plan, not by chat.** The
    `project_plan_step` adapter gains `stale()`: on every look, proposed,
    queued and waiting plan-step attempts whose plan revision, plan status
    or step no longer match are ended `SUPERSEDED` with the existing codes
    and `supersededBy = plan:<id>`. Before, they sat until someone started
    them.

### Project boards

14. **The board is a read over the canonical gates.**
    `assistantGateService.projectBoard()` takes the project's own list of
    what is open (`projectMissionService.listNeedsYou`, which stays the
    source of truth for whether a gate is open) and, for each gate card,
    attaches the viewer's canonical update for that gate
    (`project_gate:<card id>`): its reference, Inbox item, seen and snooze
    state, and the decision card from the DA-7a registry. The board, Home
    and the Inbox therefore show one request with one reference.

15. **A decision on the board is the same decision.** The portal posts it
    to `POST /api/app/assistant/gates/:ref/decide` with
    `surface: "project"`. `decide()` checks the card and calls the owning
    service; the board writes nothing.

16. **A gate is its owner's.** Project gates are adopted for the project's
    owner. A member sees the owner's gate as `mine: false`,
    `waitingOn: "owner"`, with no reference and no decision, and cannot
    decide it (`404`).

17. **Reading the board changes nothing.** It adopts no gate, files no Inbox
    item and acknowledges nothing; adoption stays with the steward pass and
    the hint.

18. **Assistant plan steps that wait on a person are listed** in their own
    column: a ready step proposed to the viewer (`proposed`), work on it
    parked on the viewer (`waiting`), and, for the project's owner only, a
    ready step no responsibility of theirs carries out (`undelegated`).

## Consequences

- A person can predict what Goobster picks up, and can stop it in the same
  place they asked for it.
- Phrasings outside the verb list are missed. That is the intended failure:
  a missed request costs a rephrase; a misread remark would start work
  nobody asked for. DA-8 widens recognition with a model and must keep the
  explicit rule as the floor.
- "Actually" and "instead" are read as steering even where a person meant a
  refinement. Unfinished work from that conversation is withdrawn and can be
  retried.
- The run does not see the discussion around a request. A request that only
  makes sense in context ("Goobster, compare those two") produces a run that
  reports it lacks the context.
- Members of a project do not see a result somebody asked for in the shared
  conversation until that person shares it.
- Two new columns on `assistant_initiatives` (`originJson`, `supersededBy`).
  Both are added by column migration and are null for existing rows.
- The run prompt for conversation requests is new, so the prompt
  fingerprint changes; the live evaluation should be rerun once it is on
  `main`.

## Left for later stages

- **DA-8**: one-to-one chat (`personal_chat`); model classification of
  conversations; reading conversation context into a run under an audience
  check; matching a request to existing work or plan steps by meaning; a
  daily proposal cap; a preview of what would have been picked up.
- **DA-11c**: findings for a project audience, a reply or hand-off posted
  into the conversation, shared responsibilities.
- **DA-6**: the pilot rehearsal of journeys B and G on a real installation.
- Decision cards for review, unblock and answer gates (they have no
  descriptor yet; the board links to the Plan for them).
