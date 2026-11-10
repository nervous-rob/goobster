---
title: Outside connectors for delegated work (calendars, notebooks and other services you connect)
kind: reference
summary: How a responsibility can be granted one named resource on an outside connector so a run can read from it and write to it as you. Notion is the one connector installed. Covers the grant shape, the owner's decision each connector needs, the pilot gate, the per-person credential, the shared outside-write budget, writing back to the resource a run read and nowhere else, actions a run can only ask you to approve, what a failed or lost write does, revocation, what is stored and the routes.
when: Granting work access to an outside service; understanding a refusal such as NO_CREDENTIAL, NO_SUCH_CONNECTOR, PRIVATE_CONTEXT, ASK_LIMIT or PILOT_ONLY on a connector step; approving or refusing something a run asked for on an outside service; revoking a connector; adding a connector to an installation.
tags: [assistant, responsibilities, delegation, connectors, notion, authority, privacy, budgets, approval]
feature: assistant
---

# Outside connectors for delegated work

A responsibility can be granted one named resource on an **outside
connector**, such as a calendar or a notebook, and a run can then read from
it and write to it as you. This page is what that means today. The decisions
behind it are [ADR 0028](adr/0028-delegated-outside-connectors.md) (the
framework) and
[ADR 0030](adr/0030-notion-connector-and-per-action-approval.md) (Notion,
writing back, and asking first); the
grant, runs and pilot it builds on are in
[delegated_responsibilities.md](delegated_responsibilities.md),
[delegated_runs.md](delegated_runs.md) and
[delegated_operations.md](delegated_operations.md).

**One connector is installed: Notion**, reading and writing one page or
one database you name ([delegated_notion.md](delegated_notion.md)). A
connector ships only with the owner's recorded decision for it; Notion's is
owner decision 12 of 2026-11-09. On an installation with no connector
registered, the Outside connectors card on the Responsibilities page, the
connector choices in the draft form and the run tools below are all absent,
and a grant on an outside resource is refused when it is saved.

## What a connector is

A typed adapter to one outside service. Its manifest says:

- its name, a one-line description and, optionally, the feature that must
  be on for it to work;
- the owner's recorded decision for it (who, when, a reference). A
  connector without one is refused when it is registered;
- which of your credentials it uses (a provider in Settings →
  Connections). Your own, never the host's;
- what a named resource is (a calendar id, a notebook name, a Notion page);
- exactly what it can **read** and exactly what it can **write**, each
  operation with a plain description;
- for each write, whether Goobster can check with the service afterwards
  that it happened;
- what it can **only ask you for**: actions no grant allows, each needing
  your approval every time (see [Asking first](#asking-first)).

You see the manifest on the Responsibilities page before you grant
anything. There is no option to let a responsibility watch a whole service,
and nothing reads a connector except a run under a responsibility you
activated.

## Granting one

In the draft form, under *Outside services*, you name the one resource the
responsibility may use, and choose reading, writing or both. A grant is
`{ "kind": "external", "ids": ["<connector>:<resource>"] }` on `read` and/or
`external.write`. The resource must be a name the connector accepts: no
wildcard, no whole service. Where a connector knows other spellings of the
same resource (for Notion, a pasted link or a dashed id), what you enter is
stored in the one form the connector keeps. Every write the manifest lists
is allowed on a resource you grant it for; what it lists as ask-only is
never allowed by a grant.

The responsibility's row and the activation dialog say, in so many words,
that a write is made as you, cannot be undone from here, and how many a day
are allowed.

Activating needs:

- **The pilot.** Connectors are the `reach` capability: only the
  installation's owner can grant, activate or use them until the host
  records the [pilot decision](delegated_operations.md#the-pilot-gate). For
  anyone else the card and the form's choices are not shown, the tools are
  not offered, and a grant is refused with `PILOT_ONLY`. That includes
  *reading*: reads from a connector are gated, not only writes.
- **Your credential.** The service must be connected in your Settings.
  Without it the grant is refused with `RESOURCE_UNAVAILABLE`.
- **Attention.** A write is an external write in the *general* category:
  Attention must be at *delegate* with general external writes allowed in
  Settings (the shipped setting is *confirm*, which refuses the call as
  `CONFIRMATION_REQUIRED`). A read needs *nudge* or above.

## What a run can do

| Tool | Needs | What it does |
| --- | --- | --- |
| `listConnectors` | A grant on an outside resource | Names the connector resources the run may use and what each can read and write. Reads only the grant and the manifests; calls nothing outside |
| `readConnector` | `read` on that resource | Runs one of the connector's reads and returns its text |
| `writeConnector` | `external.write` on that resource | Runs one of the connector's writes and returns its text |
| `askConnector` | `external.write` on that resource, on a connector that has ask-only actions | Files a request for you to approve one such action. Changes nothing outside |

A call names `connector`, `resource`, `operation` and an `input` object.
Each tool is offered only when the grant names the operation on an outside
resource, a connector is installed and you have the pilot capability. A
call is refused before anything is sent when the connector, the operation
or the resource does not exist, when the resource is not exactly one the
grant names (`OPERATION_OUT_OF_SCOPE`), or when the input is not accepted
(`BAD_INPUT`, or the connector's own code).

What holds for every connector:

- **Your credential, for the one call.** It is read from
  `user_integrations`, handed to the connector and never appears in a
  result, a journal row, a report or a log. A call is refused with
  `NO_CREDENTIAL` if it is not there.
- **Your own restriction on the service.** Where you already keep one
  (the Notion page allowlist in Settings → Connections), a granted resource
  that is not on it is refused (`NOT_ON_ALLOWLIST`), and so is any call
  while the restriction cannot be read.
- **A write cannot be undone from here.** Each result that reached the
  service is one line ending "That cannot be undone from here.", and it is
  in the "Changed:" list of the run's report. Undoing it is yours to do in
  the service.
- **A daily cap.** Writes count against `budgets.externalOperations`, the
  same cap as pushes and pull requests (default 2 a day per responsibility,
  at most 20), counted from the run's journal. A write whose outcome is
  unknown counts; a refused call or one the service declined does not.
  Reads are not counted.
- **Nothing private goes somewhere new.** A read from a connector returns
  your own data. A run may write back into the *same* resource it read:
  that text is already there. Any other combination is refused with
  `PRIVATE_CONTEXT`: writing to a connector after reading your notes,
  writing to one resource after reading another, writing to either after
  reading two, and pushing or opening a pull request after reading a
  connector. A run that shares findings with a project's members is not
  offered connector reads at all. A resumed run remembers what it had read.
- **Declined is not failed.** If the connector knows nothing changed, the
  answer is "Not written (CODE): ..." and the run reports it; it does not
  try another way.
- **After a crash the service is asked first.** The write that was in
  flight is looked up in the service by its operation id (`<run>:<step>`,
  which the connector can put in whatever the service allows). Found means
  it is reported as done and not repeated; absent means it is made once;
  anything else, or a write whose manifest cannot be asked, stops the work
  for review (`OPERATION_UNCERTAIN`) and is never retried.
- **The host's stop-all, the caps and the Attention budget** apply to a
  connector call as to any other.

## Asking first

Some actions are too much for a standing grant. A connector lists them as
ask-only, and a run can never take one: `askConnector` only files a
request. Notion has one, moving a page or block to the trash.

- The request appears under **Needs you** on Home and in the Inbox, saying
  what would be done, to what, and what follows.
- **Approving** does that one action then, as you, with your credential.
  Before it does, Goobster checks again that you are in the pilot, the host
  has not stopped delegated work, the connector is installed and on, the
  responsibility is still live and still grants writing to that resource,
  your credential is there, and the thing is still inside the resource.
  If a check fails in a way that can change (no credential, the host's
  stop, the service not answering) the request keeps waiting and says why.
  If it can never be carried out (the grant is gone, the thing has left
  the resource) it is withdrawn.
- **Refusing** changes nothing. The work is not asked to try again.
- The run that asked is told "Not done: the person has been asked", so the
  request is not in its "Changed:" list and does not count against the
  daily cap. It does not wait for your answer.
- At most five requests can wait per responsibility (`ASK_LIMIT`). Asking
  again for the same thing returns the request already waiting.
- Only you can answer, on a signed-in page. There is no route or tool by
  which a run, another person or the host can approve one. A request is
  one action: nothing is approved in advance or in bulk.
- A waiting request is withdrawn when the responsibility ends or stops
  granting writing there, when you revoke the connector, or when the
  connector is no longer installed.

Requests are stored in `assistant_connector_requests` with the name of the
thing they are about, which is your content: they are in your export,
deleted by erasure, and removed 180 days after they were answered.

## Revoking

*Revoke* on a connector's row deletes your credential for it. The next
call of any responsibility that may use it is refused at once
(`RESOURCE_UNAVAILABLE`), without anything being sent, and requests
waiting for your approval on it are withdrawn. The response lists
the live responsibilities that held a grant on it. The grant stays on the
responsibility until you revoke or pause that; connect the service again
and it works again. Anyone may revoke their own connector at any time; it
does not need the pilot. If the connector shares a provider with another
integration, revoking it removes that token for both: revoking Notion here
also disconnects Notion in conversations.

## The connector card

`GET /api/app/assistant/connectors` returns, for the pilot, each installed
connector's manifest (no function and no token; reads, writes and
ask-only actions), whether you have connected
it and whether its feature is on. It returns `{ "allowed": false,
"connectors": [] }` for someone outside the pilot. `POST
/api/app/assistant/connectors/:id/revoke` is the revocation above. A
request is answered through the same decision route as every other card
under Needs you ([assistant_home.md](assistant_home.md)); its gate kind is
`connector_request`.

## Adding a connector

A pull request adds a module exporting a manifest and requires it from
`packages/core/services/assistant/connectors/shipped.js`. It needs the
owner's recorded decision in the manifest, a credential provider, a
`validate` and a `run` for every operation, and a `reconcile` for every
write that can be checked. Optional: `resource.canonical` (other spellings
of a resource, reduced to the one a grant keeps), `permits` (the person's
own standing restriction on the service; a throw refuses), and `asks`,
each with `action` and `consequence` (the words on the approval card),
`prepare` (reads only: the target and its name), `run` (called only when
the person approves) and `voids` (the refusal codes that mean the request
can never be carried out). `notion.js` is the worked example. A connector with its own credential adds its
provider to `userIntegrationService`'s catalog and widens the CHECK on
`user_integrations.provider` in the same change. The Jest suite
`tests/assistantConnectors.test.js` and the browser journey
`e2e/assistantConnectors.spec.js` run the framework against a test double
(`tests/helpers/connectorDouble.js`), a fake in-memory notebook that can
lose the answer to a write; `tests/assistantConnectorRequests.test.js` does
the same for asking and approving. A new connector gets its own adapter
tests, as Notion has (`tests/notionConnector.test.js`,
`e2e/assistantNotion.spec.js`).

## Not built yet

A second connector. A public-read marker, so a connector's reads that are
not private could be followed by a write elsewhere. Writing to a connector
from your notes. A grant on single operations of a connector rather than on
a resource. Moving a responsibility to review
when its connector is revoked. A host switch per connector (the `feature`
field is the only one).
