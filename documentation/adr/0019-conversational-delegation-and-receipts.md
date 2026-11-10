# ADR 0019: A model may draft a responsibility; only a person's confirmation receipt turns authority on

## Status

Accepted for DA-7b of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
chat tools for delegated work, the human confirmation receipt and the
confirmation cards in portal chat. It builds on
[ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0017](0017-initiatives-updates-processes.md) (initiatives and updates)
and [ADR 0018](0018-delegated-runs.md) (runs). Behaviour is documented in
[delegated_conversation.md](../delegated_conversation.md). The code is
`packages/core/utils/tools/assistant.js`,
`packages/core/utils/modelCallScope.js` and
`packages/core/services/assistantConfirmationService.js`.

**This ADR relaxes a rule ADR 0016 stated.** ADR 0016 and
`delegated_responsibilities.md` said: "The model cannot create, activate or
widen a responsibility. There is no AI tool or MCP tool for
responsibilities." From DA-7b the model can create one thing: a **draft**.
The rest of the rule is kept and made structural.

## Context

The plan makes conversation the main way to delegate: a person says what
they want looked after and gets a draft back. That needs a tool that writes
a responsibility row, which is exactly what ADR 0016 forbade.

The risk is not the draft. A draft grants nothing: `authorize()` refuses
anything that is not `ACTIVE`. The risk is every path from a draft to
authority. Before this ADR those paths were safe only because no tool
called them. Three things made that too weak to build on:

- The delegated run, chat, automations, plan steps and the MCP server all
  execute model tool calls in the same process as the services. A future
  tool, or a mistake in one, could call `act({ action: 'activate' })`.
- The portal's action route took `{ action, expectedRevision }`. Nothing
  bound the action to what the person had been shown.
- A model writes the text of a reply. A confirmation that depended on the
  reply's wording would let the model describe one grant and record another.

## Decision

### 1. The model may create a draft, marked as its own

`proposeResponsibility` calls `assistantResponsibilityService.propose()`,
which creates a `DRAFT` with `proposedBy: 'model'` and
`proposedConversation` (the conversation it was said in). The draft is
normalized by the same validator as a person's draft: unknown operations
and wildcard resources are rejected, `autoStart` is not accepted from a
model, and the row is never activated by that call.

A proposal the person neither keeps, edits nor turns on is deleted after 7
days. Discarding it deletes it at once, with its history: declining leaves
no draft.

### 2. Nothing that turns authority on can run inside a model tool call

`utils/modelCallScope.js` is an `AsyncLocalStorage` scope. Every place that
executes a model's tool call enters it:

| Dispatcher | Covers |
| --- | --- |
| `toolsRegistry.execute` | Chat turns, automation turns, voice turns, plan steps |
| `agentOrchestrator.executeToolRound` | Any loop with its own executor: a delegated run, a persona |
| `mcp/protocol.js` `tools/call` | The MCP server |

Inside the scope these refuse with 403 `HUMAN_ONLY`, whatever the arguments:

- `assistantResponsibilityService`: `create` with `activate: true`, `act`
  with `activate` or `resume`, `update` (any authority edit), `keepProposal`.
- `assistantInitiativeService.act`: everything except `cancel` and `reject`.
- `assistantGateService.decide`, on every surface.
- `assistantConfirmationService.mint` and `redeem`.

What stays allowed inside the scope only narrows: `pause`, `revoke`,
`complete`, `archive`, `cancel`, `reject`, and discarding a proposal.

The check is in the service, not in the tool. A tool that does not exist
yet is covered when it is written.

### 3. A person's confirmation is a single-use receipt

`assistant_confirmation_receipts` follows `project_mission_approval_receipts`
and adds a hash of what was shown.

- **Minted** by `POST /api/app/assistant/confirmations`, for the session's
  person, when a confirmation is put in front of them. It is bound to the
  subject (a responsibility id or a gate reference), the action, the
  revision on the screen, a SHA-256 of the normalized grant (or of the
  decision card) and the surface (`portal` or `chat`). The response carries
  `shown`: what the receipt is bound to, which the caller displays.
- **Stored** as the SHA-256 of a 32-byte random secret. A database read
  does not yield a usable receipt.
- **Spent** by one conditional `UPDATE ... WHERE consumedAt IS NULL AND
  expiresAt >= now AND <every bound value>` inside the transaction that
  performs the action. A failed action rolls the spend back; two
  simultaneous uses have one winner.
- **Lives 15 minutes.** A refusal is always `CONFIRMATION_INVALID` and does
  not say which part failed.

Where it is required:

| Action | Receipt |
| --- | --- |
| Activate or resume through the portal route | Always |
| Activate or resume a draft the model proposed, by any caller | Always (`HUMAN_CONFIRMATION_REQUIRED` without one) |
| Decide a request with `surface: 'chat'` | Always |
| Decide a request from Home or the Inbox | None: the press is on a page the model cannot write |

The route no longer accepts `activate: true` on create. A responsibility is
created as a draft and turned on by a second, confirmed request.

### 4. The card reads the record

A chat reply carries only a reference: `{ kind: 'assistant-proposal', id }`
or `{ kind: 'assistant-requests', refs }`. The portal reads the draft or
the request with the person's session and renders that. The model's words
are beside the card, never in it. *Turn on* asks for a receipt for the
revision on the card and spends it.

### 5. Where the tools answer

Only in the speaker's own private conversation. They refuse, without
reading anything, in a guild channel or a shared table (answering that
delegation is managed privately), on an unattended turn (`isAutomation`),
in incognito, with the feature off, and for an account outside the pilot
(`assistantAccessService.allows(userId, 'conversation')`, DA-12a). They are
not offered to an unattended turn or to a person who could only be refused.

### 6. Confirmation happens in the portal only

A Discord DM gets the draft and is told to confirm it in the portal. No
confirmation button is sent to Discord: a DM message cannot show the
normalized grant from the record at the moment of the press, and a button
interaction is not the portal session the receipt is minted for.

## Consequences

- The invariant "no sequence of model tool calls can activate, resume or
  widen a responsibility, in chat, in a run or in an automation" holds
  because the services refuse inside the scope. For the draft a model
  proposed there is a second, independent check: the receipt, which a
  model cannot mint and which is required even outside the scope. A
  person's own draft and an authority edit have the scope only; no tool
  calls them, and a test over the tool sources fails if one starts to.
  `tests/assistantConversation.test.js` covers each: every refused call
  inside the scope (holding a real receipt), a scripted model that tries
  every tool with every argument in a chat turn, an automation turn and a
  guild channel, and a delegated run whose tool tries everything.
- Every activation and resume in the portal costs one more request (the
  mint). The Responsibilities page builds its confirmation question from
  `shown`, so it describes what the server will activate.
- A service that needs to activate or resume a model-proposed draft on a
  person's behalf cannot. That is intended.
- Editing a proposal in the portal is a person's edit: the grant hash
  changes, an outstanding receipt stops matching, and the next confirmation
  is for the edited grant.
- A new dispatcher of model tool calls must enter `modelCallScope.run`. A
  test asserts that the three that exist do. Nothing detects a new one that
  forgets: that is a review rule. Today every tool call goes through one of
  the three (voice, plan steps and the run's borrowed tools call
  `toolsRegistry.execute`).

## Differences from the plan

- Architecture 13.1 says queueing a proposed item and any authority edit
  also need a receipt. As built they are refused inside a model tool call
  by the scope and are reachable only through session-authenticated routes;
  they do not take a receipt. The receipt is required for the two actions
  that turn authority on, and for a chat decision. Extending it to queueing
  is a change to the Start button and its route.
- The plan left the confirmation surface open (portal chat only, or also a
  Discord DM). This takes the conservative answer: portal only.

## Alternatives considered

- **Keep the rule; have the tool return a prefilled link to the draft form.**
  Nothing is stored until the person saves. Rejected: it cannot show the
  normalized grant (normalization happens on save), and the person retypes
  or trusts a URL the model wrote.
- **Trust the tool list.** Keep activation out of `utils/tools/` and test
  for it. This is the DA-7a rule for `decide`, and it is kept as a second
  test. On its own it protects only the tools that exist today.
- **A confirmation token in the tool result.** The model would hold it.
  Rejected outright.
- **Reuse the mission approval receipt table.** Its key is a mission and a
  plan revision and it has no content hash; widening it would change a
  shipped contract for an unrelated feature.
