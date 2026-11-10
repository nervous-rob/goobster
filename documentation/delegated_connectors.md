---
title: Outside connectors for delegated work (calendars, notebooks and other services you connect)
kind: reference
summary: How a responsibility can be granted one named resource on an outside connector so a run can read from it and write to it as you. Covers the grant shape, why no connector ships yet, the pilot gate, the per-person credential, the shared outside-write budget, what a failed or lost write does, revocation, what is stored and the routes.
when: Granting work access to an outside service; understanding a refusal such as NO_CREDENTIAL, NO_SUCH_CONNECTOR or PILOT_ONLY on a connector step; revoking a connector; adding a connector to an installation.
tags: [assistant, responsibilities, delegation, connectors, authority, privacy, budgets]
feature: assistant
---

# Outside connectors for delegated work

A responsibility can be granted one named resource on an **outside
connector**, such as a calendar or a notebook, and a run can then read from
it and write to it as you. This page is what that means today. The decision
behind it is [ADR 0028](adr/0028-delegated-outside-connectors.md); the
grant, runs and pilot it builds on are in
[delegated_responsibilities.md](delegated_responsibilities.md),
[delegated_runs.md](delegated_runs.md) and
[delegated_operations.md](delegated_operations.md).

**No connector is installed in Goobster.** The framework is built and
tested; the owner has not named a service, and a connector ships only with
the owner's recorded decision for it. Until one is added, the Outside
connectors card on the Responsibilities page, the connector choices in the
draft form and the three run tools below are all absent, and a grant on an
outside resource is refused when it is saved.

## What a connector is

A typed adapter to one outside service. Its manifest says:

- its name, a one-line description and, optionally, the feature that must
  be on for it to work;
- the owner's recorded decision for it (who, when, a reference). A
  connector without one is refused when it is registered;
- which of your credentials it uses (a provider in Settings →
  Integrations). Your own, never the host's;
- what a named resource is (a calendar id, a notebook name);
- exactly what it can **read** and exactly what it can **write**, each
  operation with a plain description;
- for each write, whether Goobster can check with the service afterwards
  that it happened.

You see the manifest on the Responsibilities page before you grant
anything. There is no option to let a responsibility watch a whole service,
and nothing reads a connector except a run under a responsibility you
activated.

## Granting one

In the draft form, under *Outside services*, you name the one resource the
responsibility may use, and choose reading, writing or both. A grant is
`{ "kind": "external", "ids": ["<connector>:<resource>"] }` on `read` and/or
`external.write`. The resource must be a name the connector accepts: no
wildcard, no whole service. Every write the manifest lists is allowed on a
resource you grant it for.

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
- **A write cannot be undone from here.** Each result that reached the
  service is one line ending "That cannot be undone from here.", and it is
  in the "Changed:" list of the run's report. Undoing it is yours to do in
  the service.
- **A daily cap.** Writes count against `budgets.externalOperations`, the
  same cap as pushes and pull requests (default 2 a day per responsibility,
  at most 20), counted from the run's journal. A write whose outcome is
  unknown counts; a refused call or one the service declined does not.
  Reads are not counted.
- **Nothing private leaves.** A read from a connector returns your own
  data, so once a run has read from one (or read your private knowledge) a
  write is refused with `PRIVATE_CONTEXT`. A run that shares findings with
  a project's members is not offered connector reads at all.
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

## Revoking

*Revoke* on a connector's row deletes your credential for it. The next
call of any responsibility that may use it is refused at once
(`RESOURCE_UNAVAILABLE`), without anything being sent. The response lists
the live responsibilities that held a grant on it. The grant stays on the
responsibility until you revoke or pause that; connect the service again
and it works again. Anyone may revoke their own connector at any time; it
does not need the pilot. If the connector shares a provider with another
integration (see below), revoking it removes that token for both.

## The connector card

`GET /api/app/assistant/connectors` returns, for the pilot, each installed
connector's manifest (no function and no token), whether you have connected
it and whether its feature is on. It returns `{ "allowed": false,
"connectors": [] }` for someone outside the pilot. `POST
/api/app/assistant/connectors/:id/revoke` is the revocation above.

## Adding a connector

A pull request adds a module exporting a manifest and requires it from
`packages/core/services/assistant/connectors/shipped.js`. It needs the
owner's recorded decision in the manifest, a credential provider, a
`validate` and a `run` for every operation, and a `reconcile` for every
write that can be checked. A connector with its own credential adds its
provider to `userIntegrationService`'s catalog and widens the CHECK on
`user_integrations.provider` in the same change. The Jest suite
`tests/assistantConnectors.test.js` and the browser journey
`e2e/assistantConnectors.spec.js` run the framework against a test double
(`tests/helpers/connectorDouble.js`), a fake in-memory notebook that can
lose the answer to a write; a new connector gets its own adapter tests.

## Not built yet

A connector. A public-read marker, so a connector's reads that are not
private could be followed by a write. A grant on single operations of a
connector rather than on a resource. Moving a responsibility to review
when its connector is revoked. A host switch per connector (the `feature`
field is the only one).
