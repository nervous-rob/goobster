---
title: The assistant overview on Home, and Needs you
kind: reference
summary: Home opens with what Goobster is looking after for you - a status line derived from records, Needs you (requests still waiting on you), What changed (findings you have not reviewed), five component cards and your responsibilities. Needs you is a filter of the Inbox, not a second queue; reading never resolves a request; loading Home changes nothing. A friend request, a request to join and a mission plan can be decided from the same buttons on Home and in the Inbox (`POST /api/app/assistant/gates/:ref/decide`), and a card that changed is refused with the current state (`STALE_GATE`). Also covers the Inbox's All / Needs you / Updates / Snoozed filters, the Responsibilities page and the read-only projection behind them.
when: Understanding what Home shows and why a card is highlighted; telling an unread update from a request that still needs you; finding a snoozed or archived request; accepting, approving or declining a request from Home or the Inbox, and what a `STALE_GATE` refusal means; adding a decision for a new kind of request (`gateDecisions`); drafting, activating, pausing or revoking a responsibility in the portal; checking what `GET /api/app/home` returns under `assistant`.
tags: [assistant, home, inbox, needs-you, responsibilities, portal, updates]
---

# The assistant overview on Home, and Needs you

Home (`/`) opens with the assistant overview. Under it are the things Home
always had: New chat / note / project, recent conversations, your rooms,
Usage & limits and the privacy controls.

Everything in the overview is read from records. Nothing in it is generated
text, and **opening Home changes nothing**: it does not mark an item read,
start research, run a job, turn on Attention or activate a responsibility.

## What the overview shows

1. **Status line.** Derived from counts: "Looking after 2 responsibilities ·
   1 needs you", "Nothing delegated yet.", "Attention is off, so nothing is
   delegated and no new work starts." It never says more than the records do.
   *Ask Goobster* opens Chat. *Pause assistant work* pauses every active
   responsibility after you confirm; you resume each one on the
   Responsibilities page.
2. **Needs you.** Requests that are waiting on a decision or an answer from
   you, newest first, at most five, with *View all in Inbox*. A request with
   a concrete decision shows its buttons right there.
3. **What changed.** Findings and completed changes you have not reviewed.
   A request already shown under Needs you is not repeated here.
   *Mark reviewed* acknowledges exactly the revision shown; if the same
   finding changes later it is new again.
4. **Components**: Knowledge, Research, Projects, Processes, Conversations.
   Each card is a link to its room and states, in words:
   - *n needs you* - open requests that touch it;
   - *n blocked* - recurring processes whose latest recorded outcome in the
     last 7 days was a failure or a block;
   - *n new updates* - findings you have not reviewed;
   - *n working* - work running right now under a valid lease;
   - *Up to date*, *Status unknown* or *Unavailable here*.
   These are separate numbers and are never added into one "alerts" total.
   One finding that touches Research and Knowledge highlights both cards and
   still counts once at the top.
5. **Looking after.** Your active, paused and needs-review responsibilities
   with their open work, and a link to the Responsibilities page.

### Unknown is not zero

- A part of the overview that could not be read is shown as unknown ("Some of
  this could not be read just now"), never as a reassuring 0. The API lists
  those parts in `partial` and sends `null` for their counts.
- "Up to date" requires a recent steward pass (within 15 minutes). Otherwise
  a quiet card reads *Status unknown* and the overview says when it was last
  checked.
- With the Delegated assistant feature off the overview says so and still
  previews the Inbox's own requests (a friend request, someone asking to
  join). With Attention off it explains that nothing runs and links to
  Activity → Attention; turning Attention on starts nothing by itself.

## Needs you is a filter of the Inbox

There is one collection: the Inbox. **Needs you is the Inbox filtered to
requests that are still open for you.** Home previews that same filter.

The Inbox (`/activity/inbox`) has these filters over the same items:

| Filter | Shows |
| --- | --- |
| All | Open items (as before) |
| Needs you | Items whose request is still open for you and not snoozed |
| Updates | Informational items: nothing is asked of you |
| Unread | Unread items |
| Snoozed | Open requests you snoozed |
| Archive | Archived items |

An item needs you when the record it points at says so, never because it is
unread or because of its wording:

- an assistant update whose **gate** is open (a repair to review, a question,
  a responsibility to review, a project gate);
- the host's copy of a pending request to join;
- the addressee's copy of a pending friend request.

Rules that follow:

- **Reading does not resolve.** Opening or reading a request clears its
  unread dot; it stays under Needs you until it is decided. *Mark all read*
  resolves nothing.
- **Resolving clears it everywhere.** When the request is decided - from its
  buttons on Home or in the Inbox ([below](#deciding-a-request-where-it-is-shown)),
  or where it lives (approve the plan in the project, accept the friend
  request under People) - it leaves Needs you on Home and in the Inbox. The
  item stays in All, marked *resolved*; it does not move to Updates.
- **Snooze hides, it does not decide.** *Snooze 1 day* moves an assistant
  request to Snoozed until the time passes. It is still open.
- **Archive cannot hide a request.** An archived item whose request is still
  open keeps appearing under Needs you.
- **Two counts, never one.** The sidebar badge is unread Inbox items. "Needs
  you" is its own count. They are not added together.

### Project gates

A project's open gates appear in the same place: a plan to approve or start,
work to review, a blocked mission, a question to answer. `assistantGateService`
adopts each one into a canonical update for the **project's owner**, with one
Inbox item per gate occurrence and no Discord message (adoption does not
replay an old notification). The project still owns the gate: when it is
decided there, the adopted request is resolved within the steward pass (five
minutes at most, usually seconds through the `mission.*` hint). A gate that
opens again later (a mission blocked a second time) reopens the same item as
a new occurrence. Setup-audit findings are advice, not requests, and are not
adopted. Adoption runs only while the Delegated assistant and Projects
features are on.

## Deciding a request where it is shown

A request that has a concrete decision carries it. The same buttons appear on
the request under Needs you on Home and on its row in the Inbox, and one
press settles it in both.

| Request | Who sees the buttons | Choices |
| --- | --- | --- |
| A friend request | The person who was asked | *Accept*, *Decline* |
| Someone asking to join | A host (an operator) | *Approve*, *Decline* |
| A mission plan waiting for approval | A project member who may approve it | *Approve plan* |
| An approved mission waiting to start | A project member who may start it | *Start mission* |

Every other request (work to review, a blocked mission, a question, a repair
to review, a responsibility to review) keeps its *Open* link to the place
where it is decided.

What holds:

- **One operation, wherever you press.** Home and the Inbox post the same
  decision; it is carried out by the service that owns the request
  (`friendService.respond`, `accessRequestService.approve` / `decline`,
  `projectMissionService.approve` / `start`) with that service's own checks.
  Approving a plan still goes through the mission's human approval receipt
  for the plan revision you were shown.
- **The card is the decision.** Each card names the request's `occurrence`
  and a `revision` taken from the record (the plan revision of a mission,
  the time a friend or join request was made). The decision is applied only
  to that card.
- **A stale card is refused, with what the request is now.** If the request
  was answered, withdrawn, reopened or changed after the card was shown,
  nothing is decided and you are told its current state ("This request was
  already settled. They withdrew this request."); the page then shows it.
- **Reading and opening still decide nothing.** Only a button press does,
  and a model can never press one: the operation is not a chat tool.
- **Some refusals are the owner's.** A join request on an installation with
  an AI key and no daily spending limit is refused with that reason and
  stays open.

With the Delegated assistant feature off there are no cards: the Inbox keeps
its own *Accept* / *Decline* and *Approve* / *Decline* buttons for friend and
join requests, which call the friends and access-request routes directly, and
Home links to the Inbox.

### How a card is described

`assistantGateService` holds one registry, `gateDecisions`, with one
descriptor per kind of request (`services/assistantGateDescriptors.js`):

```text
gateDecisions[kind] = {
  describe(gate, viewer)  -> { state, title, detail, outcome, revision, options } | null
  decide(gate, viewer, optionId, { occurrence, revision, surface, gateway }) -> { message }
  settle(gate, viewer)    -> optional: bring the canonical update up to date
  staleCodes              -> the owning service's "already settled" error codes
}
```

`describe` returns `null` when the viewer may not decide the request, so a
card is never shown to someone who cannot act on it. `decide` calls the
owning service and writes no outcome itself: a project gate's update resolves
through `adoptProjectGates` and `resolveGate` exactly as when the plan is
approved inside the project. A new kind of request is added with
`assistantGateService.registerDecision(kind, descriptor)`; Home, the Inbox
and (later) the chat card need no change.

The card every surface renders:

```json
{
  "ref": "inbox-41",
  "kind": "friend_request",
  "state": "open",
  "title": "Ada wants to be friends",
  "detail": "Friends see when each other is in the portal and can message each other. Declining is not announced to them.",
  "outcome": null,
  "occurrence": 1,
  "revision": "2026-11-09 22:30:00",
  "options": [
    { "id": "accept", "label": "Accept", "effect": "You and Ada become friends.", "danger": false },
    { "id": "decline", "label": "Decline", "effect": "The request closes. They are not told.", "danger": false }
  ]
}
```

`ref` is the canonical update's id for a request that is an assistant update
(a project gate), and `inbox-<item id>` for a request that is its own Inbox
item (a friend request, a request to join). An option marked `danger` is
confirmed in the portal before it is sent.

## Responsibilities page

`/assistant` (linked from Home) lists your responsibilities and drafts new
ones. See [delegated_responsibilities.md](delegated_responsibilities.md) for
what a responsibility is and how each action is checked.

- **Draft** from plain choices: what to look after, what it may do (search
  and read the web, read your knowledge, add and amend generated notes, run
  a research expedition, and in one of your projects: read it, edit its
  files under folders you name, run code in the sandbox), when it ends, and
  whether proposed work starts automatically. A draft grants nothing.
- **Repository work.** When the chosen project has a repository cloned into
  it, the form also offers: commit there, push to GitHub, and open pull
  requests, on the branches you name (`goobster/*` to start with), with how
  many pushes and pull requests a day (2 to start with). The form, the
  responsibility's row and the activation dialog each say that a push or a
  pull request cannot be undone from here. While repository work is in the
  pilot this part of the form is shown only to the installation's owner
  (`GET /api/app/assistant/access`, `capabilities.reach`). See
  [delegated_runs.md](delegated_runs.md#repository-work).
- **Activate** shows exactly what will be granted, as you, and until when,
  and needs your confirmation. Activation requires Attention to be on.
- **Pause / Resume / Mark complete / Revoke / Archive** follow the lifecycle;
  each carries the revision you saw, so a stale page is refused rather than
  applied.

Under each responsibility is its work: proposed items with *Start* and
*Dismiss*, running and waiting items with *Cancel*, and finished items with
their result. See [delegated_runs.md](delegated_runs.md).

Grants the form cannot express yet (processes, the other budgets, more
than one repository) can be created through the API.

## API

- `GET /api/app/home` gains `assistant` (`assistantHomeService.project`):

  ```json
  {
    "schemaVersion": 1,
    "asOf": "2026-11-09T22:30:00.000Z",
    "availability": "ready",
    "freshness": { "state": "current", "lastPassAt": "2026-11-09T22:28:00.000Z" },
    "responsibilities": { "counts": { "active": 1, "paused": 0, "needsReview": 0, "draft": 0 }, "items": [] },
    "counts": { "unseen": 1, "needsAction": 1, "running": 0 },
    "components": [{ "id": "knowledge", "state": "updates", "unseen": 1, "needsAction": 0, "running": 0, "blocked": 0, "freshness": "current", "latestUpdateId": 7, "unavailable": null }],
    "needsYou": [],
    "brief": [],
    "partial": []
  }
  ```

  `availability` is `ready`, `paused`, `none_delegated`, `attention_off`,
  `unavailable` (feature off) or `unknown`. Component `state` is
  `needs_you`, `blocked`, `working`, `updates`, `quiet`, `unknown` or
  `unavailable`. `assistant` is `null` only if the projection itself failed;
  the rest of the Home payload is unaffected.
- `GET /api/app/inbox?view=all|needs_you|updates|snoozed` (with the existing
  `unread`, `archived`, `limit`, `cursor`). The response adds `view` and
  `needsYou`; each item adds `needsAction`, `update`
  (`{ id, revision, componentIds, actions, gate, gateOpen, snoozedUntil, unseen }`
  or `null`) and `decision` (the card above, or `null`).
  `GET /api/app/inbox/unread` adds `needsYou`. Each `needsYou` item of the
  Home projection carries the same `decision`.
- Acknowledging and snoozing use the existing
  `POST /api/app/assistant/updates/acknowledge` and
  `POST /api/app/assistant/updates/:id/snooze`.
- `POST /api/app/assistant/gates/:ref/decide` with
  `{ "option", "occurrence", "revision", "surface" }` decides the request
  the card describes. `:ref`, `occurrence` and `revision` are the card's;
  `surface` is `home`, `inbox` or `chat` and is recorded where the owning
  service keeps an audit (a join request's `operator_audit` row has
  `detail.via`). It answers
  `{ "decided": { "ref", "kind", "option", "message" }, "current": card | null }`.

  | Status | `error.code` | When |
  | --- | --- | --- |
  | 400 | `INVALID_DECISION` | A field is missing, or the option is not one the card offers |
  | 404 | `NOT_FOUND` | No such request for the signed-in person, or they may not decide it |
  | 409 | `NOT_DECIDABLE_HERE` | The request's kind has no decision card; it is decided where it lives |
  | 409 | `STALE_GATE` | The card changed after it was shown. `error.details.current` is the current card (`state: "resolved"` with `outcome` once settled), and nothing was decided |

  Any other refusal is the owning service's own, unchanged (for example
  `DAILY_CAP_REQUIRED`). The route belongs to the Delegated assistant
  feature and is refused with the rest of `/api/app/assistant` when it is
  off (404 `FEATURE_UNAVAILABLE`); `assistantGateService.decide` refuses
  the same way for a caller that is not a route.

None of the GET routes writes anything.

### Choices made where the plan left them open

- The plan names the route `/gates/:updateId/decide`. Friend and join
  requests are Inbox items, not assistant updates, so the path takes a
  reference: an update id, or `inbox-<item id>`.
- A card's `revision` comes from the record that owns the request, not from
  the update's display revision, so rewording a notice does not invalidate
  a card and changing the plan does.
- The caller names its `surface`. `chat` is accepted now so the chat
  confirmation card (planned) posts to the same route.
- A plan to approve and an approved plan to start share one kind
  (`project_approve`) with one choice each. Review, unblock and answer gates
  have no card yet.
- No option is marked `danger` yet: these buttons replace Inbox buttons
  that did not confirm either.

## Not built yet

- Feedback on a briefing item (useful, already knew, wrong time, ...).
- Deciding a request from a chat card or a notification, and decisions for
  the other request kinds (review, unblock, answer, repair, responsibility
  review): those still link to where the request is decided.
- Signals for the Conversations card beyond updates filed against it.
- Project Needs-you boards still read their own query; they show the same
  gates, and the adopted Inbox items resolve from the project's state.
- Live push of overview changes: Home refetches when opened and after an
  action taken on it.
