---
title: The assistant overview on Home, and Needs you
kind: reference
summary: Home opens with what Goobster is looking after for you - a status line derived from records, Needs you (requests still waiting on you), What changed (findings you have not reviewed), five component cards and your responsibilities. Needs you is a filter of the Inbox, not a second queue; reading never resolves a request; loading Home changes nothing. A friend request, a request to join, a mission plan and a process that may no longer be needed can be decided from the same buttons on Home, in the Inbox and on a project's Needs-you board (`POST /api/app/assistant/gates/:ref/decide`), and a card that changed is refused with the current state (`STALE_GATE`). Also covers the Inbox's All / Needs you / Updates / Snoozed filters, project boards as a view of the same requests, the Responsibilities page and the read-only projection behind them.
when: Understanding what Home shows and why a card is highlighted; telling an unread update from a request that still needs you; finding a snoozed or archived request; accepting, approving or declining a request from Home or the Inbox, and what a `STALE_GATE` refusal means; why a project board card has or lacks a button, or says it is waiting on the owner; adding a decision for a new kind of request (`gateDecisions`); drafting, activating, pausing or revoking a responsibility in the portal; checking what `GET /api/app/home` returns under `assistant`.
tags: [assistant, home, inbox, needs-you, responsibilities, portal, updates]
---

# The assistant overview on Home, and Needs you

Home (`/`) opens with the assistant overview. Under it are the things Home
always had: New chat / note / project, recent conversations, your rooms,
Usage & limits and the privacy controls.

Everything in the overview is read from records. Nothing in it is generated
text, and **opening Home changes nothing**: it does not mark an item read,
start research, run a job, turn on Attention or activate a responsibility.

The same overview can be heard. In your own voice chat in the portal, ask
what needs you and Goobster reads a
[spoken briefing](delegated_conversation.md#hearing-a-briefing) with the
counts shown here. Hearing it marks nothing reviewed either.

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
   finding changes later it is new again. *Feedback* on a finding of your
   own offers the answers that would change something for it (useful,
   already knew, this is wrong, less of this, wrong time, keep this wording,
   stop this responsibility), each with the one thing it changes; giving one
   does not mark the finding reviewed
   ([delegated_feedback.md](delegated_feedback.md)).
4. **Components**: Knowledge, Research, Projects, Processes, Conversations.
   Each card is a link to its room and states, in words:
   - *n needs you* - open requests that touch it;
   - *n not working* - recurring processes that are blocked, stalled or
     cannot reach what they act on;
   - *n with a problem* - recurring processes that run but are degraded.
     Both come from the processes' own records
     ([process_stewardship.md](process_stewardship.md)), so they stay on the
     Processes card after you mark the message about them reviewed;
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

## A suggested note change, and a source review

A responsibility's proposal to change a note you saved, and a review of what
rests on a withdrawn source, are requests like the others: the same card on
Home and in the Inbox, decided with the same buttons. The card shows the
change as a diff (added and removed text, unchanged passages folded) and
offers Apply and Dismiss. An applied change can be undone from the Assistant
room's "Changes to your notes" list. See
[delegated_knowledge.md](delegated_knowledge.md).

## A request to do something on an outside service

When a responsibility's work wants an action it may never take itself on
an outside connector (moving a Notion page or block to the trash), it asks.
The request is the same card on Home and in the Inbox: what would be done,
to what, and what follows, with a button that does it and *Leave it*.
Approving does that one action then, as you; nothing is approved in
advance, and a model can never press the button. See
[delegated_connectors.md](delegated_connectors.md#asking-first) (gate kind
`connector_request`).

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

### Project boards

The **Needs you** board on the Projects page, and the needs-you lines of a
project's **Now** panel (the same board filtered to that project), are a
view of those same requests. They are not a second list.

- **The project says what is open; the request says which one it is.** The
  board takes the project's own list of open gates and attaches, for each
  one, your canonical request for it: the same reference Home and the Inbox
  use, whether you have seen it, whether you snoozed it, and its decision
  card. A gate that was just decided is off the board at once, because the
  project no longer lists it.
- **Decide on the card.** A plan waiting for approval and an approved plan
  waiting to start carry the same *Approve plan* / *Start mission* button as
  on Home and in the Inbox. Pressing it on the board is the same decision
  (it is recorded with the surface `project`) and settles the request
  everywhere. Other gates link to the Plan, where they are decided. The
  button is offered to whoever the [pilot gate](#who-is-offered-a-card-the-pilot-gate)
  includes; for anyone else the card is the same request without it, and
  links to the Plan and to the Inbox.
- **A request is its owner's.** A project's gates are addressed to the
  project's owner. If you are a member, the card is shown as *Waiting on the
  owner*, without buttons, and is not counted as yours.
- **A snoozed request stays on its project's board**, marked *Snoozed*. It
  left Needs you; the project still needs it.
- **Goobster's steps.** A ready assistant step of a running plan is listed
  in its own column when it waits on you: Goobster proposed to carry it out
  and you have not pressed *Start*; the work on it is parked on you; or, if
  you own the project, no responsibility of yours carries out plan steps
  there ([delegated_plan_steps.md](delegated_plan_steps.md)). A step that is
  queued or being worked on is not listed: it is not waiting on anyone.
- **Opening the board changes nothing.** It files nothing in the Inbox and
  marks nothing read. A gate that opened in the last moments may show
  without its button until the next steward pass has filed it (seconds,
  through the `mission.*` hint).

With the Delegated assistant feature off, the board is the project's own
list, as before.

## Deciding a request where it is shown

A request that has a concrete decision carries it. The same buttons appear on
the request under Needs you on Home, on its row in the Inbox, for a
project's requests on its card on the [project board](#project-boards) and,
when you ask in chat what needs you, on a card under the reply. One press
settles it in all of them.

| Request | Who sees the buttons | Choices |
| --- | --- | --- |
| A friend request | The person who was asked | *Accept*, *Decline* |
| Someone asking to join | A host (an operator) | *Approve*, *Decline* |
| A mission plan waiting for approval | A project member who may approve it | *Approve plan* |
| An approved mission waiting to start | A project member who may start it | *Start mission* |
| A process that may no longer be needed | The person who owns the process | *Pause it*, *Keep it running* |

Every other request (work to review, a blocked mission, a question, a repair
to review, a responsibility to review) keeps its *Open* link to the place
where it is decided.

What holds:

- **One operation, wherever you press.** Home, the Inbox, a project board
  and a chat card post the same decision; it is carried out by the service
  that owns the request
  (`friendService.respond`, `accessRequestService.approve` / `decline`,
  `projectMissionService.approve` / `start`,
  `assistantProcessLifecycleService.act`) with that service's own checks.
  Approving a plan still goes through the mission's human approval receipt
  for the plan revision you were shown.
- **The card is the decision.** Each card names the request's `occurrence`
  and a `revision` taken from the record (the plan revision of a mission,
  the time a friend or join request was made, the contract and retirement
  stage of a process). The decision is applied only to that card.
- **A stale card is refused, with what the request is now.** If the request
  was answered, withdrawn, reopened or changed after the card was shown,
  nothing is decided and you are told its current state ("This request was
  already settled. They withdrew this request."); the page then shows it.
- **Reading and opening still decide nothing.** Only a button press does,
  and a model can never press one: the operation is not a chat tool, and it
  refuses inside any model tool call (`HUMAN_ONLY`).
- **A press in chat is proved.** A chat card's decision carries a single-use
  confirmation receipt for that card
  ([delegated_conversation.md](delegated_conversation.md#confirmation-receipts)).
  Home and the Inbox need none.
- **A repeated friend request has one notice.** When someone withdraws a
  friend request and asks again, only the newest notice asks for an answer.
  The earlier one stays in the Inbox as a record with no buttons.
- **Some refusals are the owner's.** A join request on an installation with
  an AI key and no daily spending limit is refused with that reason and
  stays open.

With the Delegated assistant feature off there are no cards: the Inbox keeps
its own *Accept* / *Decline* and *Approve* / *Decline* buttons for friend and
join requests, which call the friends and access-request routes directly, and
Home links to the Inbox.

### Who is offered a card: the pilot gate

Deciding a request from its card is part of the Delegated assistant's
conversational increment, so it is behind the pilot gate
([delegated_operations.md](delegated_operations.md), capability
`conversation`). Until the host records the pilot decision, only the
installation's owner (an account with the operator role) is offered a card
or can decide through one, on Home, in the Inbox, on a project board and
in chat alike. The surface is named by the caller, so the gate is the same
for all four: none of them is a way around it.

For everyone else nothing about the request itself changes: it is still
listed under Needs you and counted, on Home and in the Inbox. What differs
is where it is answered:

- a friend request keeps the Inbox's own *Accept* / *Decline* buttons, and
  Home's row links to it (*In Inbox*);
- a mission plan to approve or start keeps its *Open* link to the project,
  where it is approved or started as before, and its card on the project
  board links to the Plan and to the Inbox;
- a process that may no longer be needed is answered in the Processes list
  on the Responsibilities page, with its own *Pause* and *Keep it running*
  ([process_stewardship.md](process_stewardship.md#retiring-a-process));
  answering there settles the request;
- a suggested change to a saved note, or a review of a withdrawn source
  ([delegated_knowledge.md](delegated_knowledge.md#the-pilot-gate)), is only
  filed for someone inside the pilot. A person who has since left it still
  sees it listed, cannot apply it, and it lapses after a month; their notes
  are not changed;
- a request to join is only ever shown to a host, who is an owner.

The decide route answers 403 `PILOT_ONLY` for an account the gate does not
include, whatever reference it names, and the card read answers 404. When
the host opens the pilot to everyone, the same requests carry their cards
with nothing else to change; closing it again removes them, and a card
shown earlier then decides nothing.

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
(a project gate, a process that may no longer be needed), and
`inbox-<item id>` for a request that is its own Inbox item (a friend request,
a request to join). An option marked `danger` is
confirmed in the portal before it is sent.

## Responsibilities page

`/assistant` (linked from Home) lists your responsibilities and drafts new
ones. See [delegated_responsibilities.md](delegated_responsibilities.md) for
what a responsibility is and how each action is checked.

- **Draft** from plain choices: what to look after, what it may do (search
  and read the web, read your knowledge, add and amend generated notes, run
  a research expedition, and in one of your projects: read it, edit its
  files under folders you name, run code in the sandbox, carry out the
  assistant steps of its approved plan), where it takes requests you address
  to Goobster (that project's conversations, your discussions; see
  [delegated_conversation_requests.md](delegated_conversation_requests.md)),
  when it ends, whether proposed work starts automatically, and how its
  updates reach you (kept on Home, one digest a day, or a contact when it
  needs your decision; see [delegated_delivery.md](delegated_delivery.md)).
  A draft grants nothing.
- **Repository work.** When the chosen project has a repository cloned into
  it, the form also offers: commit there, push to GitHub, and open pull
  requests, on the branches you name (`goobster/*` to start with), with how
  many pushes and pull requests a day (2 to start with). The form, the
  responsibility's row and the activation dialog each say that a push or a
  pull request cannot be undone from here. While repository work is in the
  pilot this part of the form is shown only to the installation's owner
  (`GET /api/app/assistant/access`, `capabilities.reach`). See
  [delegated_runs.md](delegated_runs.md#repository-work).
- **Activate** shows exactly what will be granted, as you, where it will
  take requests from, and until when, and needs your confirmation. The
  question is built from what the server says this revision allows, and
  your yes spends a single-use confirmation receipt for it. Activation
  requires Attention to be on. **Resume** is confirmed the same way.
- A draft Goobster proposed in a conversation is marked *proposed in a
  conversation*. *Discard* deletes it
  ([delegated_conversation.md](delegated_conversation.md)).
- **Pause / Resume / Mark complete / Revoke / Archive** follow the lifecycle;
  each carries the revision you saw, so a stale page is refused rather than
  applied.

Under each responsibility is its work: proposed items with *Start* and
*Dismiss*, running and waiting items with *Cancel*, and finished items with
their result. See [delegated_runs.md](delegated_runs.md). Work you asked for
in a conversation quotes your message and links back to the conversation;
if you changed direction there, the withdrawn work stays listed with *Try
again*.

Home and this page change while they are open: a finding, a request, a
piece of work or a run that changes sends the portal a reason to read
again, never the content
([delegated_delivery.md](delegated_delivery.md#live-updates)).

Grants the form cannot express yet (processes, the other budgets, more
than one repository) can be created through the API.

Below the responsibilities, **Processes** reports on the recurring work you
have set up (scheduled tasks, project triggers, watches, followed sources).
Each process shows two separate answers in words, whether it is working and
whether it is still needed, with the reason for each, and the incidents still
open are listed above them. The Home Processes card opens this section. Each
row has the actions that apply to it: *Pause*, *Resume*, *Archive*,
*Restore*, *Keep it running* and *Clean up…*. None of them deletes a process,
and a cleanup shows exactly what it would remove before you confirm it.
Archived processes are behind *Show archived*. What a process does is still
edited where you made it.
See [process_stewardship.md](process_stewardship.md#retiring-a-process).

## API

- `GET /api/app/home` gains `assistant` (`assistantHomeService.project`):

  ```json
  {
    "schemaVersion": 1,
    "asOf": "2026-11-09T22:30:00.000Z",
    "availability": "ready",
    "hostPaused": false,
    "freshness": { "state": "current", "lastPassAt": "2026-11-09T22:28:00.000Z" },
    "responsibilities": { "counts": { "active": 1, "paused": 0, "needsReview": 0, "draft": 0 }, "items": [] },
    "counts": { "unseen": 1, "needsAction": 1, "running": 0 },
    "components": [{ "id": "knowledge", "state": "updates", "unseen": 1, "needsAction": 0, "running": 0, "blocked": 0, "degraded": 0, "freshness": "current", "latestUpdateId": 7, "unavailable": null }],
    "needsYou": [],
    "brief": [],
    "partial": []
  }
  ```

  `availability` is `ready`, `paused`, `none_delegated`, `attention_off`,
  `unavailable` (feature off) or `unknown`. `hostPaused` is `true` while the
  host has [stopped all delegated work](delegated_operations.md#stop-all)
  (Home then says so in place of the status line), `false` otherwise, and
  `null` when it could not be read or the feature is off. Component `state` is
  `needs_you`, `blocked`, `degraded`, `working`, `updates`, `quiet`,
  `unknown` or `unavailable`, in that order of precedence. `blocked` and
  `degraded` are counts of processes (not working, and running with a
  problem); only the Processes component has them above zero. `assistant` is
  `null` only if the projection itself failed; the rest of the Home payload
  is unaffected.
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
  `surface` is `home`, `inbox`, `chat` or `project` and is recorded where the owning
  service keeps an audit (a join request's `operator_audit` row has
  `detail.via`). It answers
  `{ "decided": { "ref", "kind", "option", "message" }, "current": card | null }`.

  | Status | `error.code` | When |
  | --- | --- | --- |
  | 400 | `INVALID_DECISION` | A field is missing, or the option is not one the card offers |
  | 403 | `PILOT_ONLY` | The pilot gate does not include this account (`error.details.capability` is `conversation`). Checked before the request is looked up |
  | 404 | `NOT_FOUND` | No such request for the signed-in person, or they may not decide it |
  | 409 | `NOT_DECIDABLE_HERE` | The request's kind has no decision card; it is decided where it lives |
  | 409 | `STALE_GATE` | The card changed after it was shown. `error.details.current` is the current card (`state: "resolved"` with `outcome` once settled), and nothing was decided |

  Any other refusal is the owning service's own, unchanged (for example
  `DAILY_CAP_REQUIRED`). The route belongs to the Delegated assistant
  feature and is refused with the rest of `/api/app/assistant` when it is
  off (404 `FEATURE_UNAVAILABLE`); `assistantGateService.decide` refuses
  the same way for a caller that is not a route.

- `GET /api/app/projects/needs-you?project=&owner=` returns the project
  board (`assistantGateService.projectBoard`):
  `{ cards, text, canonical: true }`. Each card keeps the fields it had
  (`id`, `column`, `title`, `detail`, `projectSlug`, `projectName`,
  `ownerId`, `missionId`, `choices` ...) and adds `mine` (boolean),
  `waitingOn` (`"owner"` or `null`), `gate`
  (`{ ref, inboxItemId, unseen, snoozedUntil }` or `null` until the request
  is filed) and `decision` (the card above, or `null`). Column `assistant`
  holds assistant plan steps: `id` is `agent:<plan id>:<step id>`, with
  `state` (`proposed`, `waiting` or `undelegated`) and `initiativeId`.
  `GET /api/app/projects/:slug/now` carries the same fields on
  `needsYou.cards`. With the feature off the route returns the project's
  own list and no `canonical` flag.

None of the GET routes writes anything.

### Choices made where the plan left them open

- The plan names the route `/gates/:updateId/decide`. Friend and join
  requests are Inbox items, not assistant updates, so the path takes a
  reference: an update id, or `inbox-<item id>`.
- A card's `revision` comes from the record that owns the request, not from
  the update's display revision, so rewording a notice does not invalidate
  a card and changing the plan does.
- A project board shows a gate as the viewer's own only for the project's
  owner, because that is who it is adopted for. Members see it as waiting on
  the owner rather than getting a request of their own.
- The board does not adopt a gate when it is read. A read that filed Inbox
  items would break "opening changes nothing".
- The chat tool action `needs-you` still returns the project's own list.
- The caller names its `surface`. The chat card posts to the same route
  with `surface: 'chat'` and a confirmation receipt.
- A plan to approve and an approved plan to start share one kind
  (`project_approve`) with one choice each. Review, unblock and answer gates
  have no card yet.
- No option is marked `danger` yet: these buttons replace Inbox buttons
  that did not confirm either.
- The pilot gate covers deciding in place on every surface, not only the
  chat card (owner decision 9, read conservatively): DA-7a shipped before
  the gate existed and was open to every account until DA-7b added the
  check. An account outside the pilot gets the same fallback as an
  installation with the feature off.

A brief item that was shared with a project says so: its `audience` is
`{ kind: 'project', projectId }` and `producer` names whose assistant found it
(`you: true` on the producer's own view), shown on Home as *Shared with this
project by Ada's assistant*. The other member sees no link into the
producer's responsibility
([delegated_project_findings.md](delegated_project_findings.md)).

## Not built yet

- Feedback on a request, on a finding shared with a project, or from a
  notification ([delegated_feedback.md](delegated_feedback.md) covers what
  is built).
- Deciding a request from a notification, and decisions for
  the other request kinds (review, unblock, answer, repair, responsibility
  review): those still link to where the request is decided.
- Signals for the Conversations card beyond updates filed against it.
- Live changes for every account: the overview changes while it is open
  for accounts with the delivery capability
  ([delegated_delivery.md](delegated_delivery.md)); until the pilot decision
  is recorded, other accounts' Home refetches when opened and after an
  action taken on it.
