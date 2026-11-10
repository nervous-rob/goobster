---
title: The assistant overview on Home, and Needs you
kind: reference
summary: Home opens with what Goobster is looking after for you - a status line derived from records, Needs you (requests still waiting on you), What changed (findings you have not reviewed), five component cards and your responsibilities. Needs you is a filter of the Inbox, not a second queue; reading never resolves a request; loading Home changes nothing. Also covers the Inbox's All / Needs you / Updates / Snoozed filters, the Responsibilities page and the read-only projection behind them.
when: Understanding what Home shows and why a card is highlighted; telling an unread update from a request that still needs you; finding a snoozed or archived request; drafting, activating, pausing or revoking a responsibility in the portal; checking what `GET /api/app/home` returns under `assistant`.
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
   you, newest first, at most five, with *View all in Inbox*.
3. **What changed.** Findings and completed changes you have not reviewed.
   A request already shown under Needs you is not repeated here.
   *Mark reviewed* acknowledges exactly the revision shown; if the same
   finding changes later it is new again.
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
- **Resolving clears it everywhere.** When the request is decided where it
  lives (approve the plan in the project, accept the friend request), it
  leaves Needs you on Home and in the Inbox. The item stays in All, marked
  *resolved*; it does not move to Updates.
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

## Responsibilities page

`/assistant` (linked from Home) lists your responsibilities and drafts new
ones. See [delegated_responsibilities.md](delegated_responsibilities.md) for
what a responsibility is and how each action is checked.

- **Draft** from plain choices: what to look after, what it may do (search
  and read the web, read your knowledge, add and amend generated notes, run
  a research expedition, and in one of your projects: read it, edit its
  files under folders you name, run code in the sandbox), when it ends, and
  whether proposed work starts automatically. A draft grants nothing.
- **Activate** shows exactly what will be granted, as you, and until when,
  and needs your confirmation. Activation requires Attention to be on.
- **Pause / Resume / Mark complete / Revoke / Archive** follow the lifecycle;
  each carries the revision you saw, so a stale page is refused rather than
  applied.

Under each responsibility is its work: proposed items with *Start* and
*Dismiss*, running and waiting items with *Cancel*, and finished items with
their result. See [delegated_runs.md](delegated_runs.md).

Grants the form cannot express yet (repositories, processes, budgets) can be
created through the API.

Below the responsibilities, **Processes** reports on the recurring work you
have set up (scheduled tasks, project triggers, watches, followed sources).
Each process shows two separate answers in words, whether it is working and
whether it is still needed, with the reason for each, and the incidents still
open are listed above them. The Home Processes card opens this section. It
is a report with no controls: a process is still changed where you made it.
See [process_stewardship.md](process_stewardship.md).

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
    "components": [{ "id": "knowledge", "state": "updates", "unseen": 1, "needsAction": 0, "running": 0, "blocked": 0, "degraded": 0, "freshness": "current", "latestUpdateId": 7, "unavailable": null }],
    "needsYou": [],
    "brief": [],
    "partial": []
  }
  ```

  `availability` is `ready`, `paused`, `none_delegated`, `attention_off`,
  `unavailable` (feature off) or `unknown`. Component `state` is
  `needs_you`, `blocked`, `degraded`, `working`, `updates`, `quiet`,
  `unknown` or `unavailable`, in that order of precedence. `blocked` and
  `degraded` are counts of processes (not working, and running with a
  problem); only the Processes component has them above zero. `assistant` is
  `null` only if the projection itself failed; the rest of the Home payload
  is unaffected.
- `GET /api/app/inbox?view=all|needs_you|updates|snoozed` (with the existing
  `unread`, `archived`, `limit`, `cursor`). The response adds `view` and
  `needsYou`; each item adds `needsAction` and `update`
  (`{ id, revision, componentIds, actions, gate, gateOpen, snoozedUntil, unseen }`
  or `null`). `GET /api/app/inbox/unread` adds `needsYou`.
- Acknowledging and snoozing use the existing
  `POST /api/app/assistant/updates/acknowledge` and
  `POST /api/app/assistant/updates/:id/snooze`.

None of the GET routes writes anything.

## Not built yet

- Feedback on a briefing item (useful, already knew, wrong time, ...).
- Approving a request from Home itself: Home links to where the request is
  decided.
- Signals for the Conversations card beyond updates filed against it.
- Project Needs-you boards still read their own query; they show the same
  gates, and the adopted Inbox items resolve from the project's state.
- Live push of overview changes: Home refetches when opened and after an
  action taken on it.
