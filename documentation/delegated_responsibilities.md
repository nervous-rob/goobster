---
title: Delegated responsibilities
kind: reference
summary: What a responsibility is, how it is created, activated, paused and revoked, the operation vocabulary it grants, how authority is checked at dispatch, and the portal API. Nothing runs under a responsibility yet; this is the grant that later delegated work is checked against.
tags: [assistant, responsibilities, delegation, attention, authority, privacy]
feature: assistant
---

# Delegated responsibilities

A **responsibility** is something a person has asked Goobster to look after,
together with the exact authority he has while doing it. For example, "keep my
notes about the garden current: he may add and amend his own generated notes in
my personal knowledge, and nothing else". It is a versioned grant, not a
setting. It does nothing until its owner activates it.

**Status.** This is increment DA-1a of the
[delegated assistant plan](delegated_assistant_implementation.md). It ships the
grant record, its lifecycle, and the authority check. **No background work runs
under a responsibility yet.** Opportunities, durable runs, knowledge change
sets, process repair and the assistant-first Home are still planned (see the
[product spec](delegated_assistant_spec.md) and the
[architecture](delegated_assistant_architecture.md)). Budgets are recorded but
not yet enforced. The decisions behind the shape are in
[ADR 0016](adr/0016-delegated-responsibilities.md).

## What a responsibility holds

- **Title and outcome.** What Goobster is looking after, in the owner's words.
- **Links** to records that already exist: an Attention item
  (`attentionItemId`), a project (`projectId`), and a plan in that project
  (`planId`). A responsibility points at the goal or plan. It never copies it
  into another list.
- **Operations.** A list of `{ operation, resource }` entries, described in the
  next section. Anything not listed is unavailable.
- **Scopes.** Which sources the work may read (`personal_chat`, `knowledge`,
  `project`) and who sees its results (`private` or `project`). A project
  source or audience needs `projectId`. A purpose never grants access to a
  source the person could not otherwise reach.
- **Budgets.** Non-negative integer caps: `modelTokens`, `searches`,
  `computeSeconds`, `concurrentInitiatives`, `repairAttempts` and
  `externalOperations`. They are recorded now and enforced when delegated runs
  arrive. The account's usage cap always remains the outer limit.
- **Rules.** `interruption` (`immediate`, `digest` or `home`) and a free-text
  `stopCondition`.
- **Expiry** (`expiresAt`, UTC), optional.
- **Principals**: owner, authorizer, acting person and payer. Today all four are
  the signed-in person who creates the responsibility, whatever the request
  body says.

## Operations

Each granted operation names one resource. There is no blanket "write"
permission and no wildcard resource.

| Operation | What it would allow | Resource kinds |
| --- | --- | --- |
| `read` | Read the resource | `knowledge`, `web`, `project`, `process`, `repository` |
| `research` | Run bounded research | `knowledge`, `web`, `project` |
| `kg.generated.add` | Add generated notes | `knowledge` |
| `kg.generated.amend` | Amend generated notes | `knowledge` |
| `kg.saved.amend` | Amend notes the person saved | `knowledge` |
| `kg.edge` | Maintain relationships between notes | `knowledge` |
| `kg.archive` | Archive (not delete) notes | `knowledge` |
| `file.edit` | Edit project files | `project` |
| `sandbox.run` | Run code in the project sandbox | `project` |
| `process.repair` | Repair a recurring process | `process` |
| `process.pause` | Pause a process | `process` |
| `process.archive` | Archive a process | `process` |
| `cleanup.exact` | Remove an exact, owned set of artifacts | `process` |
| `repo.commit` | Commit in a project repository clone | `repository` |
| `repo.push` | Push a branch (never forced) | `repository` |
| `pr.create` | Open a pull request | `repository` |
| `external.write` | Another external write | `external` |

Resource shapes:

- `knowledge`: `{ "kind": "knowledge", "ids": ["personal"] }`. Only the
  person's own graph is supported for now.
- `web`: `{ "kind": "web" }`.
- `project`: `{ "kind": "project", "ids": ["12"], "paths": ["docs/"] }`. The
  `paths` entries are optional workspace-relative prefixes.
- `process`: `{ "kind": "process", "ids": ["automation:5"] }`. Supported
  reference kinds are `automation`, `project_trigger`, `attention_watch` and
  `followed_source`.
- `repository`: `{ "kind": "repository", "projectId": "12", "ids": ["owner/name"], "branches": ["goobster/*"] }`.
  The repository must be cloned in that project. A trailing `*` in `branches`
  matches a prefix.
- `external`: `{ "kind": "external", "ids": ["…"] }`.

Unknown operations, kinds or fields are rejected when the responsibility is
saved.

## Lifecycle

| Status | Meaning |
| --- | --- |
| `DRAFT` | Written, never active. Editable. |
| `ACTIVE` | Delegated work may run under it. Only the title can change. |
| `PAUSED` | Stopped by its owner. Editable; resumes only when the owner resumes it. |
| `NEEDS_REVIEW` | Delegated work asked for a human look. Editable; resumes only when the owner resumes it. |
| `COMPLETED` | The outcome was reached. Terminal. |
| `REVOKED` | Authority withdrawn permanently. Terminal. |
| `EXPIRED` | Past `expiresAt`. Terminal; it never renews itself. |
| `ARCHIVED` | A terminal record put away. Its final status is kept. |

Owner actions are `activate` (draft to active), `pause`, `resume` (from paused
or needs review), `complete`, `revoke` (from any non-terminal status, including
a draft) and `archive` (from completed, revoked or expired).

- **Activation re-checks everything.** The grant needs at least one operation.
  Every linked record and granted resource must still be reachable by the
  acting person, every feature the operations need must be available, and the
  owner's **Attention policy must be enabled**
  ([attention.md](attention.md); `/attention enable` or Settings). Resume
  re-checks the same things.
- **To change what a responsibility may do, pause it first.** Editing an active
  responsibility's operations, scopes, budgets, rules, links or expiry answers
  `PAUSE_REQUIRED`. An edit never changes the status, so editing a paused
  responsibility leaves it paused.
- **Revoked, expired and archived responsibilities never come back.** To
  delegate again, create a new one.
- **Expiry is applied lazily.** A responsibility past `expiresAt` reads as
  `EXPIRED` and is refused at once. The stored status changes on its next
  write.

Every change is a compare-and-swap on `revision` and appends one snapshot to
the revision history. A second counter, `authorityRevision`, moves only when
authority or status changes. A title edit does not invalidate work that is
already running. Any other edit, and any status change (including pause
followed by resume), does: that work has to re-plan under the current grant.

## How authority is checked

Delegated work calls
`assistantResponsibilityService.authorize({ responsibilityId, revision, operation, resource, actorUserId })`
immediately before each side effect. It returns `{ ok: true }` only when all of
these hold at that moment:

1. The `assistant` feature, and every feature the operation and resource need,
   is available. Projects are needed for `project` and `repository`, Knowledge
   for `kg.*`, Expeditions for `research`, Sandbox for `sandbox.run`, and
   GitHub for `repo.push` and `pr.create`.
2. The responsibility is `ACTIVE` and not past its expiry.
3. The presented `revision` is not older than `authorityRevision`.
4. The actor is the responsibility's acting person.
5. The operation and the concrete resource (id, path, branch) match a granted
   entry.
6. The acting person can still reach that resource today: they own or are a
   member of the project, or own the process.
7. The owner's Attention policy is enabled and allows the operation's action
   class in its category. `read` needs initiative `nudge` or above, compute
   operations need `assist`, and external writes need `delegate`. A category
   boundary of `confirm` means a human confirms each action, so it is refused
   as `CONFIRMATION_REQUIRED`.

Refusal codes: `FEATURE_UNAVAILABLE`, `RESPONSIBILITY_NOT_FOUND`,
`RESPONSIBILITY_INACTIVE`, `RESPONSIBILITY_REVOKED`, `RESPONSIBILITY_EXPIRED`,
`REVISION_CONFLICT`, `ACTOR_MISMATCH`, `OPERATION_OUT_OF_SCOPE`,
`RESOURCE_UNAVAILABLE`, `ATTENTION_NOT_ENROLLED`, `ATTENTION_BOUNDARY` and
`CONFIRMATION_REQUIRED`. An urgent finding changes how Goobster tells you, never
what he may do. Inside a piece of work, a refusal is also noted in the
[work ledger](work_ledger.md) (phase `responsibility_authorize`, code only).

The model cannot create, activate or widen a responsibility. There is no AI
tool or MCP tool for responsibilities; they change only through the
authenticated portal routes.

## Portal API

All routes act as the signed-in person. Another person's responsibility answers
404. When the feature is off, the whole prefix answers `FEATURE_UNAVAILABLE`.

| Route | Purpose |
| --- | --- |
| `GET /api/app/assistant/responsibilities` | Your responsibilities (`?status=` to filter) plus the vocabulary. |
| `POST /api/app/assistant/responsibilities` | Create a draft. Pass `activate: true` to create and activate in one step. An `Idempotency-Key` header (or `idempotencyKey` in the body) makes a retried create return the first one. |
| `GET /api/app/assistant/responsibilities/:id` | One responsibility and its revision history. |
| `PATCH /api/app/assistant/responsibilities/:id` | Edit. Requires `expectedRevision`. |
| `POST /api/app/assistant/responsibilities/:id/actions` | `{ action, expectedRevision }`, where `action` is `activate`, `pause`, `resume`, `complete`, `revoke` or `archive`. |

A stale `expectedRevision` answers 409 `REVISION_CONFLICT` with the current
revision. An action that the current status does not allow answers 409
`INVALID_TRANSITION`.

## Privacy

Responsibilities and their revision history are personal data:

- The transparency report (`/what-do-you-know-about-me`, Settings → Privacy)
  counts them.
- The account export includes them.
- `/forget-me` deletes the person's own responsibilities with their history. If
  the person is named on someone else's responsibility, `/forget-me` removes
  them from it and revokes it if it could still run.

All of this works when the feature is off.

## Turning it on and off

The feature id is `assistant`. Fresh installations start with it off; enable it
on the Host → Features page. Installations that existed before it, or that have
no `data/features.json`, see it as available. It is still inert there, because
nothing happens until a person enables Attention and activates a
responsibility. Turning the feature off refuses the routes and every
`authorize()` call, and keeps the data.
