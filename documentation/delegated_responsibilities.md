---
title: Delegated responsibilities
kind: reference
summary: What a responsibility is, how it is created, activated, paused and revoked, the operation vocabulary it grants, how authority is checked at dispatch, the initiatives derived from its linked sources, canonical updates and their read receipts, the process catalog with typed observations, retention, and the portal API. How queued work is carried out is in delegated_runs.md and delegated_plan_steps.md.
tags: [assistant, responsibilities, delegation, attention, authority, privacy, initiatives, updates, processes]
feature: assistant
---

# Delegated responsibilities

A **responsibility** is something a person has asked Goobster to look after,
together with the exact authority he has while doing it. For example, "keep my
notes about the garden current: he may add and amend his own generated notes in
my personal knowledge, and nothing else". It is a versioned grant, not a
setting. It does nothing until its owner activates it.

**Status.** This is increment DA-1 of the
[delegated assistant plan](delegated_assistant_implementation.md). It ships the
grant record, its lifecycle and the authority check (DA-1a), the
[initiatives](#initiatives) derived from a grant's linked sources (DA-1b),
[canonical updates](#updates) with per-person read receipts (DA-1c), and the
[process catalog](#processes) with typed observations (DA-1d). Queued
initiatives are carried out by the runner DA-3 added
([delegated_runs.md](delegated_runs.md)), which also enforces the token,
search and compute budgets; DA-4a added the assistant steps of a project plan
([delegated_plan_steps.md](delegated_plan_steps.md)). Process repair and work
proposed from conversations are still planned (see the
[product spec](delegated_assistant_spec.md) and the
[architecture](delegated_assistant_architecture.md)). The decisions behind the
shape are in [ADR 0016](adr/0016-delegated-responsibilities.md) and
[ADR 0017](adr/0017-initiatives-updates-processes.md).

## What a responsibility holds

- **Title and outcome.** What Goobster is looking after, in the owner's words.
- **Links** to records that already exist: an Attention item
  (`attentionItemId`), a project (`projectId`), and a plan in that project
  (`planId`). A responsibility points at the goal or plan. It never copies it
  into another list.
- **Operations.** A list of `{ operation, resource }` entries, described in the
  next section. Anything not listed is unavailable.
- **Scopes.** Which sources the work may read (`personal_chat`, `knowledge`,
  `project`, `project_chat`, `parlor`) and who sees its results (`private`
  or `project`). A project source or audience needs `projectId`. The `project` audience shares what
  the work finds with the project's members and is limited to the pilot
  (`PILOT_ONLY`); see [delegated_project_findings.md](delegated_project_findings.md).
  `project_chat` and `parlor` say where it takes requests you address to
  Goobster ([delegated_conversation_requests.md](delegated_conversation_requests.md));
  `personal_chat`, `followed_source`, `job_failure` and `ci_verdict` (DA-8) say
  which wider sources it notices work from, and are pilot capabilities
  ([delegated_opportunity_sources.md](delegated_opportunity_sources.md)). A purpose never grants access to a
  source the person could not otherwise reach.
- **Budgets.** Non-negative integer caps: `modelTokens`, `searches`,
  `computeSeconds`, `concurrentInitiatives`, `repairAttempts` and
  `externalOperations`. `concurrentInitiatives` caps how many initiatives can
  be running at once. `modelTokens`, `searches` and `computeSeconds` are
  daily caps on the responsibility's [runs](delegated_runs.md), with
  conservative defaults when unset; the host sets those defaults, and a
  number above the host's is treated as the host's
  ([delegated_operations.md](delegated_operations.md#caps)). `externalOperations`
  caps pushes and pull requests a day (default 2 when unset, never more than
  20; see [delegated_runs.md](delegated_runs.md#repository-work)).
  `repairAttempts` is recorded for a later increment. The account's usage cap always remains
  the outer limit.
- **Rules.** `interruption` (`immediate`, `digest` or `home`), a free-text
  `stopCondition`, and `autoStart` (`true` queues proposed work without
  waiting for Start; off by default). `interruption` decides whether the
  responsibility's updates also reach you outside the portal: `home` (the
  default) never does, `digest` adds one digest a day, `immediate` adds one
  contact per request that needs your decision. `digest` and `immediate`
  are refused at activation with `PILOT_ONLY` for an account without the
  delivery capability. See [delegated_delivery.md](delegated_delivery.md).
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
| `plan.step.execute` | Carry out the assistant steps of the project's plan, only in a plan revision a person approved and started. Never approves, starts or completes a plan. Takes no `paths` | `project` |
| `process.repair` | Repair a recurring process (not used yet) | `process` |
| `process.pause` | Pause a process whose purpose is over | `process` |
| `process.archive` | Archive a process Goobster paused that way, after 7 days | `process` |
| `cleanup.exact` | Remove an exact, owned set of artifacts (not used yet: only you can clean up a process) | `process` |
| `repo.commit` | Commit in a project repository clone, on a work branch | `repository` |
| `repo.push` | Push a work branch (never forced) | `repository` |
| `pr.create` | Open a pull request from a work branch | `repository` |
| `external.write` | Write to a named resource of an outside connector (DA-11d) | `external` |

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
  matches a prefix. `repo.push` and `pr.create` must name at least one branch
  pattern: an empty list would match every branch, the default one included,
  so it is rejected when the responsibility is saved. Whatever the patterns
  say, a delegated run never works on the branch the clone started from, the
  repository's default branch or a protected branch
  ([delegated_runs.md](delegated_runs.md#repository-work)).
- `external`: `{ "kind": "external", "ids": ["<connector>:<resource>"] }`. Each id
  names one resource of an installed outside connector, in the shape the
  connector accepts (no wildcard, no whole service); `read` and
  `external.write` take it and nothing else does. With no connector installed
  there is nothing to grant, and a grant naming an unknown connector is refused
  as `INVALID_RESOURCE`. Reaching it also needs your own credential for the
  connector's service: activating without it is refused as `RESOURCE_UNAVAILABLE`,
  and so is a call after the credential is revoked
  ([delegated_connectors.md](delegated_connectors.md)).

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

- **Turning authority on is confirmed.** Through the portal, `activate` and
  `resume` take a single-use confirmation receipt for the revision and grant
  you were shown. A draft proposed in a conversation (`proposedBy: 'model'`)
  needs one from any caller, and can also be kept or discarded
  ([delegated_conversation.md](delegated_conversation.md#confirmation-receipts)).

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

Two installation-wide checks sit around those. Before any of them, if the
host has [stopped all delegated work](delegated_operations.md#stop-all) the
answer is `ASSISTANT_PAUSED`. After step 5, an operation that is still in
the pilot (`repo.commit`, `repo.push`, `pr.create`, `kg.saved.amend`,
`kg.edge`, `kg.archive`, `external.write`, and `read` on an `external` resource) is refused as `PILOT_ONLY` unless
the responsibility's owner is the installation's owner or the host has
recorded the [pilot decision](delegated_operations.md#the-pilot-gate);
activating or resuming a responsibility that grants one is refused the same
way.

Refusal codes: `FEATURE_UNAVAILABLE`, `ASSISTANT_PAUSED`,
`RESPONSIBILITY_NOT_FOUND`,
`RESPONSIBILITY_INACTIVE`, `RESPONSIBILITY_REVOKED`, `RESPONSIBILITY_EXPIRED`,
`REVISION_CONFLICT`, `ACTOR_MISMATCH`, `OPERATION_OUT_OF_SCOPE`, `PILOT_ONLY`,
`RESOURCE_UNAVAILABLE`, `ATTENTION_NOT_ENROLLED`, `ATTENTION_BOUNDARY` and
`CONFIRMATION_REQUIRED`. An urgent finding changes how Goobster tells you, never
what he may do. Inside a piece of work, a refusal is also noted in the
[work ledger](work_ledger.md) (phase `responsibility_authorize`, code only).

The model cannot activate, resume or widen a responsibility. In your own
private chat it can **draft** one (`proposeResponsibility`), read yours and
pause one or cancel a piece of work; a draft grants nothing, and turning
one on is your own confirmed press in the portal. Every service call that
would turn authority on refuses inside a model tool call (`HUMAN_ONLY`).
See [delegated_conversation.md](delegated_conversation.md) and
[ADR 0023](adr/0023-conversational-delegation-and-receipts.md).

## Initiatives

An **initiative** is one attempt at advancing an active responsibility. It is
an attempt, not another goal list. It points at the change that prompted it.

**Where they come from.** For each active responsibility, Goobster keeps a
cursor per linked source: its Attention item (`attentionItemId`) and its
project plan (`planId`, when Projects is available). The cursor holds the last
material revision he saw.

- The first look after activation records a baseline and proposes nothing.
  What happened before you delegated is evidence, not a new instruction.
- When a linked source changes materially, he proposes one `CANDIDATE`
  initiative and moves the cursor forward in the same transaction. For an
  Attention item, a material change is to its state, goal, unresolved threads
  or deadline. For a plan, it is to its plan revision or status.
- Noticing the same change again never proposes a second initiative. A newer
  change supersedes an open older attempt (`SUPERSEDED`,
  `NEWER_SOURCE_REVISION`).
- Attention and plan events only make him look sooner. A periodic pass, every
  5 minutes, finds any change an event missed, including across a restart.
- Nothing is derived for a draft, paused, reviewed or ended grant, or when the
  owner's Attention policy is off.
- An initiative's title names the kind of change ("Linked goal changed"). It
  never copies the goal's text.
- One source is **standing** instead: the ready assistant steps of the linked
  project's plan (`project_plan_step`, for a grant with `plan.step.execute`).
  A step that is ready is waiting work, not history, so it is proposed on the
  first look too, once per approved plan revision and retry. Its title is
  "Plan step ready: " and the step's title, which the project's people wrote
  for the plan. See [delegated_plan_steps.md](delegated_plan_steps.md).
  Its proposed and queued work is withdrawn on any look that finds the plan
  has moved on.
- One source is a **stream**: requests you address to Goobster in the
  conversations the grant covers (`conversation_request`, for a grant whose
  scopes name `project_chat` or `parlor`). It has one cursor, the last
  message examined. The first look proposes nothing; after that each request
  of yours is one proposal, titled "Asked in" and the conversation's name,
  and a change of direction supersedes your unfinished work from that
  conversation (`SUPERSEDED`, `STEERED`). See
  [delegated_conversation_requests.md](delegated_conversation_requests.md).

**Statuses.** `CANDIDATE`, `QUEUED`, `RUNNING`, `WAITING`, `REVIEW`, then one
of the terminal statuses `COMPLETED`, `FAILED`, `CANCELLED` or `SUPERSEDED`.
`WAITING` carries a `waitReason`: `dependency`, `budget`, `user_question`,
`access` or `responsibility`.

**What the owner can do:**

- `queue` approves a candidate or waiting attempt under the grant as it is now.
- `cancel` stops an open attempt.
- `retry` opens a new attempt of a failed or cancelled one (or a superseded
  plan-step or conversation-request attempt), unless another attempt at it is already open
  (`ALREADY_OPEN`).
- `accept` and `reject` close an attempt that is in `REVIEW`.

Every action is a compare-and-swap on `revision`.

**What it learns from you.** Each source of a responsibility that notices
things by itself has a learned rate: "less of this" lowers how many pieces
of work that source may propose in a day (three steps, down to nothing),
and starting, dismissing or ignoring its work moves it slowly, never below
one a day. The row on the Assistant page shows each source that learned
something, with what it may propose now, what it usually may, and **Reset**.
A learned rate changes only how often work is proposed: it is never read
when authority is checked, a budget is reserved or a run's tools are chosen.
See [delegated_feedback.md](delegated_feedback.md).

**What the grant does to its initiatives:**

- Revoking, completing, archiving or expiring the responsibility cancels its
  open initiatives in the same change (`RESPONSIBILITY_REVOKED` and so on).
- Pausing it, or moving it to review, parks queued and running initiatives as
  `WAITING` with reason `responsibility`.
- After a resume, a parked initiative stays parked until its owner queues it
  again.

**Claiming (for the runner).**
`assistantInitiativeService.claim({ id })` takes a queued attempt. It refuses:

- `RESPONSIBILITY_INACTIVE` when the grant is no longer live.
- `REVISION_CONFLICT` when the attempt was queued under an older authority
  revision. The attempt moves to `WAITING` with `REPLAN_REQUIRED`.
- `BUDGET_LIMIT` when the grant's `concurrentInitiatives` are already running.

On success it returns a lease token that lasts 10 minutes. `settle()` must
present that token. Once a lease expires, the attempt returns to `QUEUED` and
the old token no longer works (`LEASE_LOST`). A lease does not replace
`authorize()`: every side effect is still checked against the grant.

## Updates

An **update** is one durable fact Goobster wants you to know: a finding,
progress on an initiative, a process problem, a question, or a change to a
responsibility. Each update has one identity per audience. The audience is
you, or a project's current members.

- **One identity, many components.** An update lists every component it
  touches: `knowledge`, `research`, `projects`, `processes`, `conversations`
  or `responsibilities`. The unseen count counts it once, and each component
  it touches counts it once.
- **Revisions.** Publishing the same fact again changes nothing. A material
  change (title, summary, components, evidence, actions, gate) creates a new
  revision that is unseen again.
- **Seen is per person and per revision.** Acknowledging names an exact
  revision. Acknowledging an older revision never clears a newer one, and
  someone else's acknowledgment never affects yours. Delivering an update to
  you (a mention in conversation, an Inbox envelope, a browser notification,
  a Discord message, a digest) is recorded separately from acknowledging it.
- **Needs you.** An update with an open gate, such as a question or a review,
  needs action until whatever raised it is resolved. Acknowledging it does not
  resolve it. Snoozing hides it until a time you choose, and the gate stays
  open.
- **Inbox.** A personal update can file one Inbox item. That item is the
  update's envelope, not a second record. Filing it sends no browser
  notification and no Discord message; the responsibility's interruption
  rule decides that ([delegated_delivery.md](delegated_delivery.md)).
  - A new revision refreshes the same item and makes it unread again.
  - Reading the item in the Inbox acknowledges exactly the revision it showed.
  - Acknowledging the update in the portal marks the item read when the item
    shows that revision.
  - Project updates file no personal Inbox items.
- **Responsibility updates.** Goobster publishes an update when a
  responsibility expires, or moves to review. A review opens a gate, and
  resuming, revoking, completing or archiving the responsibility resolves it.

Listing updates is a read. It never acknowledges, delivers or resolves
anything.

## Processes

The **process catalog** lists your recurring processes without copying them:

- scheduled tasks (`automation`)
- project triggers (`project_trigger`, when Projects is available)
- Attention watches (`attention_watch`)
- followed sources (`followed_source`)

The references are the same `kind:id` pairs a `process` resource uses. A
followed source shows its label, never its URL. Only a process's owner can see
it.

**Contracts.** You can record why a process exists. A contract holds:

- `purpose`
- `expectedCadenceSeconds` and `freshnessSeconds` (at least 60 each)
- `quietResultOk`
- `criticality` (`low`, `normal` or `high`)
- an optional `attentionItemId` or `projectId`
- `reviewAt`
- `stopCondition`
- `dependsOn`: up to 8 references to your own processes that this one
  cannot work without

Replacing a contract needs its `expectedRevision`.

**Observations.** Each run of a process records what happened as a typed
observation with:

- a stable occurrence key, such as the scheduled fire time an automation
  claimed or the source job a trigger reacted to
- a phase: `schedule`, `dispatch`, `execution`, `output`, `delivery` or
  `outcome`
- an outcome: `ok`, `skipped`, `blocked`, `deferred`, `failed` or `unknown`
- a machine `reasonCode`, such as `NO_DISCORD_CLIENT`, `CHANNEL_NOT_FOUND` or
  `DISPATCH_DELIVERED`. Anything that is not a short code is stored as
  `UNCLASSIFIED`.

Reporting the same occurrence again updates it and counts the attempt.
Every cataloged kind records observations: scheduled tasks their outcome,
project triggers their dispatch and how the job they started settled,
watches each fire, and followed sources each day of checks. A trigger's own
delivery ledger (`project_trigger_deliveries`) is shown alongside as history.

**Assessment and incidents.** From these records each process is judged on
two separate questions: whether it is working (`healthy`, `degraded`,
`blocked`, `stalled`, `unreachable` or `unknown`) and whether it is still
needed (`active`, `awaiting_event`, `satisfied`, `superseded`, `dormant`,
`retirement_candidate` or `unknown`). A process with no stated purpose is
always `unknown` on the second. Repeated failures become one incident per
cause, announced once and closed after a recovery period. The rules, the
defaults and what you are told are in
[process_stewardship.md](process_stewardship.md).

**Retirement.** A process can be paused, archived, restored and cleaned up in
separate steps. You can do each from the Processes list. Goobster pauses a
process whose purpose is over only when an active responsibility grants
`process.pause` on exactly that process and your Attention boundaries allow
him to act on schedules; otherwise he asks. He archives only what he paused
that way, under `process.archive`, after 7 days. Archiving never deletes, and
a cleanup removes only the exact rows it previewed. Nothing is repaired yet.
See [Retiring a process](process_stewardship.md#retiring-a-process).

## Retention

The assistant's periodic pass applies these windows:

| Records | Kept for |
| --- | --- |
| Process observations | 90 days, and removed at once when their process is deleted |
| Process contracts | Until removed, or their process is deleted |
| Process incidents and their members | 180 days after the incident was resolved. Open and recovering incidents are kept |
| Process retirement records | As long as the process is paused or archived; 180 days after their last change once it is running again; removed when the process is deleted |
| Cleanup previews | 7 days after they expired if never applied; 180 days once applied |
| Finished initiatives (`COMPLETED`, `FAILED`, `CANCELLED`, `SUPERSEDED`) | 180 days after their last change |
| Runs and their operation journals ([delegated_runs.md](delegated_runs.md)) | 180 days after the run finished, and with their initiative |
| Updates and their receipts | 180 days after their last change, unless they still have an open gate |
| Source cursors | As long as their responsibility |
| A draft proposed in a conversation that was never kept, edited or activated | 7 days |
| Feedback ([delegated_feedback.md](delegated_feedback.md)) | 180 days after both the update and the work it answered are gone |
| What a source learned from feedback | Until reset; 180 days after its responsibility ended; removed with the responsibility |
| Confirmation receipts | 30 days after they expire |

## Portal API

All routes act as the signed-in person. Another person's responsibility answers
404. When the feature is off, the whole prefix answers `FEATURE_UNAVAILABLE`.

| Route | Purpose |
| --- | --- |
| `GET /api/app/assistant/responsibilities` | Your responsibilities (`?status=` to filter) plus the vocabulary, and `learned`: what feedback taught each source of each responsibility. |
| `POST /api/app/assistant/responsibilities` | Create a draft. It is always a draft: `activate: true` is refused (`HUMAN_CONFIRMATION_REQUIRED`). An `Idempotency-Key` header (or `idempotencyKey` in the body) makes a retried create return the first one. |
| `GET /api/app/assistant/responsibilities/:id` | One responsibility and its revision history. |
| `PATCH /api/app/assistant/responsibilities/:id` | Edit. Requires `expectedRevision`. |
| `POST /api/app/assistant/responsibilities/:id/actions` | `{ action, expectedRevision, receipt? }`, where `action` is `activate`, `pause`, `resume`, `complete`, `revoke` or `archive`. `activate` and `resume` require `receipt`. |
| `POST /api/app/assistant/responsibilities/:id/proposal` | `{ action: 'keep' \| 'discard', expectedRevision }` for a draft proposed in a conversation. |
| `POST /api/app/assistant/confirmations` | Issue the single-use receipt for what you are confirming. See [delegated_conversation.md](delegated_conversation.md#api). |
| `POST /api/app/assistant/responsibilities/:id/sources/:adapter/reset` | Forget what feedback taught one source of this responsibility, so it proposes at its usual rate again. See [delegated_feedback.md](delegated_feedback.md). |

| `GET /api/app/assistant/initiatives` | Your initiatives (`?responsibilityId=`, `?status=`, `?limit=` up to 100), each with `feedback`: the answers you may give about it and the ones you gave. |
| `GET /api/app/assistant/initiatives/:id` | One initiative. |
| `POST /api/app/assistant/initiatives/:id/actions` | `{ action, expectedRevision }`, where `action` is `queue`, `cancel`, `retry`, `accept` or `reject`. |
| `GET /api/app/assistant/updates` | Updates you can see, newest first (`?component=`, `?responsibilityId=`, `?limit=` up to 50, `?cursor=`). The first page also returns `counts` (`unseen`, `needsAction`, `complete`) and per-component counts. A cursor belongs to the person it was issued to. |
| `POST /api/app/assistant/updates/acknowledge` | `{ items: [{ id, revision }] }`, up to 100 items. Each result is `acknowledged`, `older_revision` or `not_found`. |
| `POST /api/app/assistant/updates/:id/snooze` | `{ until }`: hide an open gate from Needs you until then. |
| `POST /api/app/assistant/updates/:id/feedback`, `POST /api/app/assistant/initiatives/:id/feedback` | `{ kind, stop?, expectedRevision? }`: one typed answer about a finding or a piece of work of your own. An account outside the pilot gate answers 403 `PILOT_ONLY`. See [delegated_feedback.md](delegated_feedback.md). |
| `GET /api/app/assistant/gates/:ref` | One request's decision card. |
| `POST /api/app/assistant/gates/:ref/decide` | `{ option, occurrence, revision, surface, receipt? }` (`receipt` is required when `surface` is `chat`): decide the request a decision card describes, through the service that owns it. A card that changed answers 409 `STALE_GATE` with the current card; an account outside the pilot gate answers 403 `PILOT_ONLY`. See [assistant_home.md](assistant_home.md#deciding-a-request-where-it-is-shown). |
| `GET /api/app/assistant/processes` | Your recurring processes, each with whether it has a contract, its assessment, the incident it is part of, its retirement stage (`lifecycle`) and the actions you may take (`controls`); counts per state; and the incidents still open. |
| `GET /api/app/assistant/processes/:kind/:id` | One process: its description, contract, recent observations, existing delivery history, assessment, incident, retirement stage, the processes that depend on it and its newest cleanup preview. |
| `POST /api/app/assistant/processes/:kind/:id/actions` | `{ action, expectedRevision?, cleanupId?, manifestHash? }`: `pause`, `resume`, `archive`, `restore`, `keep`, `preview_cleanup` or `cleanup` one of your processes. See [process_stewardship.md](process_stewardship.md#retiring-a-process). |
| `PUT /api/app/assistant/processes/:kind/:id/contract` | Create or replace its contract (`expectedRevision` to replace). |
| `DELETE /api/app/assistant/processes/:kind/:id/contract` | Remove its contract. |

A stale `expectedRevision` answers 409 `REVISION_CONFLICT` with the current
revision. An action that the current status does not allow answers 409
`INVALID_TRANSITION`.

## Privacy

Responsibilities, their revision history, source cursors, initiatives,
personal updates, update receipts, confirmation receipts, feedback and what
each source learned from it, process contracts, process observations,
process incidents, process retirement records and cleanup previews are
personal data:

- The transparency report (`/what-do-you-know-about-me`, Settings → Privacy)
  counts them.
- The account export includes them.
- `/forget-me` deletes all of the person's own records of these kinds,
  including their receipts on project updates.
  - On a project's shared update, it removes the person as producer and drops
    links to their deleted responsibilities and initiatives.
  - If the person is named on someone else's responsibility, it removes them
    from it, revokes it if it could still run, and cancels its open
    initiatives (`PRINCIPAL_ERASED`).

All of this works when the feature is off.

## Turning it on and off

The feature id is `assistant`. Fresh installations start with it off; enable it
on the Host → Features page. Installations that existed before it, or that have
no `data/features.json`, see it as available. It is still inert there, because
nothing happens until a person enables Attention and activates a
responsibility. Turning the feature off refuses the routes and every
`authorize()` call, stops the periodic pass (the `assistantSteward` runtime
step), stops recording process observations, and keeps the data.
