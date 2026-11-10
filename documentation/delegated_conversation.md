---
title: Delegating and steering by conversation
kind: reference
summary: In your own private chat you can ask Goobster to take something on, ask what he is working on and why, and tell him to stop. Asking produces a draft responsibility that grants nothing; only your own press on its card in portal chat, or on the Responsibilities page, turns it on, and that press is proved by a single-use confirmation receipt bound to exactly what you were shown. The model can never activate, resume, widen, start or decide anything. Covers the three chat tools (`proposeResponsibility`, `describeDelegatedWork`, `controlDelegatedWork`), where they refuse (guild channels, automations, incognito, accounts outside the pilot), the proposal and request cards, confirmation receipts (`POST /api/app/assistant/confirmations`), what is stored and for how long.
when: Asking Goobster in chat to look after something; understanding why a responsibility drafted in chat is not running; turning a drafted responsibility on, keeping it or discarding it; asking what delegated work is doing, why it stopped or what it was refused; stopping delegated work by saying so; deciding a friend request or plan approval from a chat card; understanding `HUMAN_ONLY`, `HUMAN_CONFIRMATION_REQUIRED`, `CONFIRMATION_INVALID` or `PILOT_ONLY`; checking that a model cannot grant itself authority.
tags: [assistant, responsibilities, delegation, chat, tools, confirmation, authority, privacy]
feature: assistant
---

# Delegating and steering by conversation

A [responsibility](delegated_responsibilities.md) can be asked for in
conversation. Three chat tools let Goobster draft one from what you said,
answer from his records what he is working on and why, and stop work when
you say so.

**The rule everything here follows: a model call is never a confirmation.**
What Goobster drafts grants nothing. Turning it on is your own press, in the
portal. No sequence of tool calls, in chat, in a delegated run or in an
automation, can activate, resume or widen a responsibility, start a piece of
work, or decide a request for you. The design and the reasons are in
[ADR 0023](adr/0023-conversational-delegation-and-receipts.md).

## The three tools

| Tool | What it does | What it cannot do |
| --- | --- | --- |
| `proposeResponsibility` | Writes a **draft** from a title, an outcome, the operations and resources it would need, and optionally a linked project, Attention item, end date and stop condition | Activate it. Turn on automatic start. Grant an operation the vocabulary does not have |
| `describeDelegatedWork` | Reads your own responsibilities, your open and recent work, one run's step-by-step record, or the requests waiting on you | Read another person's. Change anything |
| `controlDelegatedWork` | `cancel` one piece of work, or `pause` one responsibility | Start, queue, retry, resume, activate, edit or widen anything |

They are part of the `assistant` feature and are offered only when it is
available.

### Asking for something to be looked after

"Keep my garden notes current" makes Goobster call `proposeResponsibility`
with the narrowest grant that covers it. What happens:

- A `DRAFT` responsibility is created, marked as proposed in a conversation
  (`proposedBy: 'model'`, with the conversation it came from). It is checked
  by the same validator as a draft you write yourself: an unknown operation
  or a wildcard resource is refused, and the tool is told why.
- **Nothing is running and nothing is granted.** A draft is refused by every
  authority check.
- In portal chat a **proposal card** appears under the reply. The card reads
  the draft from the server with your session. It shows what was recorded:
  the title, each thing it would allow and on what, whether work would wait
  for *Start*, and when it ends. It does not show Goobster's description of
  it, so the card and the record cannot differ.
- Asking again for the same thing in the same conversation returns the same
  draft. At most 10 unanswered proposals are kept per person.

The card offers:

| Button | Effect |
| --- | --- |
| **Turn on** | Activates the draft as shown. This is the confirmation (see [receipts](#confirmation-receipts)). Attention must be on, as for any responsibility |
| **Keep as draft** | Leaves it on the Responsibilities page to review later. Still grants nothing |
| **Discard** | Deletes the draft and its history. Nothing was turned on |
| **Review or edit** | Opens it on the Responsibilities page, where you can change it before activating |

A proposal you neither turn on, keep nor edit is deleted after 7 days.
Reopening the conversation later shows the card in its current state: on,
paused, or gone.

In a Discord DM Goobster drafts the same way and tells you to confirm on
the Responsibilities page. There is no confirmation button in Discord.

### Asking what he is doing, and why

`describeDelegatedWork` answers from records, not from memory:

| `what` | Returns |
| --- | --- |
| `overview` (default) | Your responsibilities with status and grant, the work that is open, and the last few finished pieces |
| `responsibility` + `id` | One responsibility: status, exactly what it allows, its rules and end date, its recent work |
| `work` + `id` | One piece of work: what prompted it and why, its status and stop code, and the run's journal: each tool call, its status and any refusal code |
| `requests` | The requests waiting on you. In portal chat their decision cards are shown under the reply |

The journal lists what a run did and what it was refused (for example
`OPERATION_OUT_OF_SCOPE`). It does not include the text a step returned.
Another person's responsibility or work answers `NOT_FOUND`.

### Telling him to stop

`controlDelegatedWork` narrows and nothing else:

- `cancel` + an initiative id cancels that piece of work. The reply says
  what its run had already changed. Those changes are not undone.
- `pause` + a responsibility id pauses it. Nothing new starts under it
  until **you** resume it in the portal.

Any other action is refused by the tool. Resuming is yours.

## Where the tools answer

Only in your own private conversation: a portal chat of yours or a DM.

| Situation | What happens |
| --- | --- |
| A guild channel, or a shared table | Refused before anything is read. Goobster says delegation is managed privately and points to the Responsibilities page or a direct chat |
| An unattended turn (an automation, a scheduled follow-up) | Not offered, and refused if called: an unattended turn cannot draft, read or steer delegated work |
| Incognito | Not offered, and refused: none of the tools reads or writes delegated state |
| The `assistant` feature is off | Not offered; `FEATURE_UNAVAILABLE` |
| An account outside the pilot | Not offered; `PILOT_ONLY`. Until the host records the pilot decision, only the installation's owner (an operator account) can delegate by conversation. The Responsibilities page still works for everyone |

## What a model call can never do

Every place that executes a model's tool call marks it
(`utils/modelCallScope.js`): the chat tool registry, the agent loop (which
also runs delegated runs) and the MCP server. Inside one, these refuse with
403 `HUMAN_ONLY`, whatever the arguments, even holding a genuine receipt:

- activating or resuming a responsibility, or creating one already active;
- editing a responsibility (operations, resources, budgets, rules, expiry);
- keeping a proposal;
- starting, retrying or accepting a piece of work;
- deciding a request, on any surface;
- minting or spending a confirmation receipt.

Inside a model call these still work, because they only narrow: pause,
revoke, complete, archive, cancel, reject, and discarding a proposal.

## Confirmation receipts

A receipt is the proof that a signed-in person confirmed something they
were looking at.

1. When a confirmation is put in front of you, the portal asks
   `POST /api/app/assistant/confirmations` for a receipt. The server binds
   it to you, the subject, the action, the revision on the screen, a hash
   of the grant (or of the decision card) and the surface, and answers
   with the receipt and `shown`: exactly what it is bound to.
2. Your press sends the receipt with the action.
3. The action spends it in the same transaction, by a conditional update
   that succeeds only if it is unspent, unexpired and every bound value
   still matches the record.

A receipt is single use and lasts 15 minutes. Only its SHA-256 is stored.
If the responsibility was edited after the receipt was issued, if it was
already used, or if it is for something else, the answer is 403
`CONFIRMATION_INVALID` and nothing changes. An action that fails for
another reason (for example Attention is off) leaves the receipt unspent.

| Action | Needs a receipt |
| --- | --- |
| Activate or resume a responsibility from the portal | Yes (`surface: portal` on the Responsibilities page, `chat` on a proposal card) |
| Activate or resume a responsibility drafted in a conversation, by any caller | Yes: `HUMAN_CONFIRMATION_REQUIRED` without one |
| Decide a request from a chat card | Yes (`surface: chat`) |
| Decide a request on Home or in the Inbox | No. Those pages are not written by a model |
| Pause, revoke, complete, archive, cancel, discard | No. They only narrow |

### Deciding a request from chat

Asking "what needs me?" shows the open requests as cards under the reply.
Each is the same [decision card](assistant_home.md#deciding-a-request-where-it-is-shown)
Home and the Inbox show, read from the server, and its buttons post to the
same route with `surface: 'chat'` and a receipt for that card. The owning
service decides, and a card that changed is refused with `STALE_GATE` and
the current card, exactly as elsewhere.

## API

| Route | Purpose |
| --- | --- |
| `POST /api/app/assistant/confirmations` | `{ subject: 'responsibility', id, action: 'activate' \| 'resume', revision, surface: 'portal' \| 'chat' }` or `{ subject: 'gate', id: <gate ref>, action: 'decide', occurrence, revision, surface: 'chat' }`. Answers `{ receipt, expiresAt, surface, shown }`. A stale revision answers 409 `REVISION_CONFLICT`; a request that changed, 409 `STALE_GATE` |
| `POST /api/app/assistant/responsibilities/:id/actions` | `activate` and `resume` now require `receipt`; without one the answer is 403 `HUMAN_CONFIRMATION_REQUIRED` |
| `POST /api/app/assistant/responsibilities/:id/proposal` | `{ action: 'keep' \| 'discard', expectedRevision }` for a draft proposed in a conversation |
| `POST /api/app/assistant/responsibilities` | Always creates a draft. `activate: true` is refused with `HUMAN_CONFIRMATION_REQUIRED` |
| `GET /api/app/assistant/gates/:ref` | One request's decision card, for the chat card |
| `POST /api/app/assistant/gates/:ref/decide` | With `surface: 'chat'`, requires `receipt` |

A responsibility in API responses carries `proposedBy` (`'model'` or
`null`) and, for a proposal, `proposal: { conversation, keptAt }`.

## What is stored

| Record | Holds | Kept |
| --- | --- | --- |
| The draft (`assistant_responsibilities`) | The same fields as any responsibility, plus who proposed it, the conversation reference and when you kept it | Like any responsibility once kept, edited or activated; 7 days otherwise; deleted at once when discarded |
| A receipt (`assistant_confirmation_receipts`) | Your id, what it confirmed (kind, id, action, revision), the hash of what was shown, the surface, the hash of its secret, when it was issued, expires and was used | 30 days after it expires |

Receipts are personal data: the transparency report counts them, the
account export includes them (without the secret's hash), and `/forget-me`
deletes them. No prompt, reply or grant text is stored in a receipt.

## Not built yet

- The spoken briefing (DA-7c).
- Confirmation from Discord. A DM is told to use the portal.
- A receipt for *Start* on a piece of work and for an edit. Both are refused
  inside a model call and are reachable only from your signed-in session.
- A card for the repair proposal, review, unblock and answer requests.
