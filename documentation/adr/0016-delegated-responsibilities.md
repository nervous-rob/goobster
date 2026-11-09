# ADR 0016: Delegated responsibilities are versioned, human-activated grants checked per operation at dispatch

## Status

Accepted for increment DA-1a of the
[delegated assistant plan](../delegated_assistant_implementation.md).
Behaviour is documented in
[delegated_responsibilities.md](../delegated_responsibilities.md); the
service is `packages/core/services/assistantResponsibilityService.js`.
Names reserved below for later increments are decisions about naming
only. Nothing beyond the grant record and its authority check is
implemented by this ADR.

This ADR does not change the knowledge curation contract of
[ADR 0008](0008-knowledge-curation-contract.md) or the human-only mission
approve/start/complete actions. Generated/provisional curation (DA-3) and a
delegated plan-execution route (DA-4) need their own reviewed decisions.

## Context

The [architecture](../delegated_assistant_architecture.md) asks for a
**responsibility**: bounded authority to pursue an outcome, separate from
Attention's interruption scoring and from Project Plans. Before any
autonomous work exists, the grant itself has to be exact. If a later runner
could read "Goobster may help with my project" as permission to push a
branch, every downstream safety property would depend on a prompt.

The baseline (`80872bc6`, after #411) gives these seams:

1. **Attention is opt-in per person.** No `attention_policies` row means the
   attention system does nothing for that person. The policy already has
   an initiative level (observe, nudge, assist, delegate) and per-category
   boundaries (read, compute, external write, with `confirm`).
2. **Features are gated by the inventory.** `features/inventory.js` owns
   every table prefix and route rule. The portal gate refuses a disabled
   feature's routes before any router runs. Services ask
   `features.enforcedOff(id)` themselves.
3. **Erasure must reach dormant data.** A reduced payload can leave a
   feature's modules out while its rows remain, so per-person erasure and
   counting SQL lives in `services/dormantDataService.js` (core).
4. **There is no general idempotency-key convention** on portal routes.
   Inbox uses a per-user `dedupeKey`.

## Decision

1. **A new optional feature, `assistant`** (title "Delegated assistant").
   It has no dependencies and no legacy switch. Its fresh-install default
   is **off**. An installation with no `data/features.json`, or with a
   state file written before the feature existed, sees it as active, the
   same as other features without a legacy switch. This is safe because a
   responsibility is inert until its owner activates it, and activation
   requires an enabled Attention policy. The feature owns the
   `assistant_` table prefix and the `/api/app/assistant` routes. Its
   payload is the service and the route module. The route module is
   mounted optionally, and the erasure SQL stays in core.

2. **Tables (DA-1a).** New tables live in `db/schema.sql`. There are no
   column migrations.
   - `assistant_responsibilities` is the current grant. Integer `id`.
     Principals are stored as TEXT: `ownerUserId`, `authorizedBy`,
     `actingUserId` and `payerUserId`. It has two counters. `revision` is
     the compare-and-swap counter and changes on every edit.
     `authorityRevision` changes only when authority or status changes.
     It also holds `status`, the outcome links (`attentionItemId`,
     `projectId`, `planId`), the JSON grant fields
     (`scopesJson`, `operationsJson`, `budgetsJson`, `rulesJson`), the
     UTC text timestamps, and a per-owner unique `idempotencyKey`.
   - `assistant_responsibility_revisions` is an append-only snapshot of
     every revision, UNIQUE (`responsibilityId`, `revision`). It is the
     audit trail and the frozen revision a worker can be checked against.

3. **Reserved names for later increments.** These were not created by
   DA-1a. The DA-1b, DA-1c and DA-1d tables now exist; see
   [ADR 0017](0017-initiatives-updates-processes.md):
   `assistant_source_cursors` and `assistant_initiatives` (DA-1b),
   `assistant_updates` and `assistant_update_receipts` (DA-1c),
   `assistant_process_contracts` and `assistant_process_observations` (DA-1d;
   prefixed `assistant_` so the feature owns them, instead of the
   architecture's unprefixed `process_*` placeholder), and `assistant_runs`
   (DA-3).

4. **Lifecycle** is exactly the architecture's section 3.1:
   - `DRAFT` goes to `ACTIVE` only through an explicit activation.
   - `ACTIVE` goes to `PAUSED`, `NEEDS_REVIEW`, `COMPLETED`, `REVOKED` or
     `EXPIRED`.
   - `PAUSED` and `NEEDS_REVIEW` go back to `ACTIVE` only through
     resume, after re-validation. They can also go to `REVOKED` or
     `EXPIRED`.
   - `COMPLETED`, `REVOKED` and `EXPIRED` go to `ARCHIVED`.
   - A draft may be revoked (discarded).
   - Revoked, expired and archived grants never resume.
   - Expiry is evaluated lazily. Reads report an overdue grant as
     `EXPIRED`, authorization refuses it, and the next mutation persists
     the transition. `expireDue()` is exported for a later scheduler.
   - While a grant is `ACTIVE`, only the title may change. Authority
     fields can change only in `DRAFT`, `PAUSED` or `NEEDS_REVIEW`, and an
     edit never changes the status.

5. **Operations are a closed vocabulary.** Each granted operation is
   bound to a typed resource:

   | Operation | Resource kinds |
   | --- | --- |
   | `read` | `knowledge`, `web`, `project`, `process`, `repository` |
   | `research` | `knowledge`, `web`, `project` |
   | `kg.generated.add`, `kg.generated.amend`, `kg.saved.amend`, `kg.edge`, `kg.archive` | `knowledge` |
   | `file.edit`, `sandbox.run` | `project` |
   | `process.repair`, `process.pause`, `process.archive`, `cleanup.exact` | `process` |
   | `repo.commit`, `repo.push`, `pr.create` | `repository` |
   | `external.write` | `external` |

   Resource constraints:
   - `project`, `process`, `repository` and `external` grants name
     explicit ids.
   - `knowledge` names the scope; DA-1a supports only `personal`.
   - `repository` also names its project.
   - Path prefixes (`project`) and branch patterns (`repository`) narrow
     a grant further.
   - There is no blanket `write` and no wildcard resource.
   - Unknown operations, kinds or fields are rejected when the grant is
     saved.

6. **Effective authority is an intersection**, evaluated by
   `authorize({ responsibilityId, revision, operation, resource, actorUserId })`
   at dispatch time. All of the following must hold:
   - the `assistant` feature, and every feature the operation or resource
     needs, is available;
   - the grant is `ACTIVE`, not expired, and the presented revision is
     not older than `authorityRevision`;
   - the actor is the grant's acting principal;
   - the operation and resource match a granted entry;
   - the actor still has access to the resource today;
   - the owner's Attention policy is enabled and allows the operation's
     action class in its category. `confirm` means a human confirms each
     action, so it is refused as `CONFIRMATION_REQUIRED` rather than
     treated as granted.

   Refusals carry a machine code: `FEATURE_UNAVAILABLE`,
   `RESPONSIBILITY_NOT_FOUND`, `RESPONSIBILITY_INACTIVE`,
   `RESPONSIBILITY_REVOKED`, `RESPONSIBILITY_EXPIRED`, `REVISION_CONFLICT`,
   `ACTOR_MISMATCH`, `OPERATION_OUT_OF_SCOPE`, `RESOURCE_UNAVAILABLE`,
   `ATTENTION_NOT_ENROLLED`, `ATTENTION_BOUNDARY` or
   `CONFIRMATION_REQUIRED`. Inside a work context a refusal is noted in
   `work_failures` with phase `responsibility_authorize` and no prose.

7. **Only an authenticated human activates or widens a grant.** The routes
   take the owner, authorizer, actor and payer from the session and ignore
   any such fields in the body. In this personal-first increment all four
   are the caller. The columns stay separate so that collaboration can
   later fill them without a migration. There is no AI tool and no MCP
   tool for responsibilities, so a model cannot draft, activate or extend
   one in this increment.

8. **Budgets are recorded, not enforced, in DA-1a.** These keys are
   validated as non-negative integers: `modelTokens`, `searches`,
   `computeSeconds`, `concurrentInitiatives`, `repairAttempts` and
   `externalOperations`. Enforcement arrives with the runner (DA-3), where
   reservations and settlement belong. The payer's account cap remains
   the outer limit.

9. **Privacy.** Erasure deletes a person's own responsibilities and their
   revisions. On someone else's grant, it nulls the person's principal
   fields and revokes the grant. Both tables appear in the transparency
   report, the post-erasure audit and the account export.

## Pilot defaults

The implementation plan proposes conservative pilot defaults: one
background initiative at a time, explicit token, search, runtime and
repair caps, generated-note additions only, and immediate contact only for
time-sensitive findings. They are **proposed, not yet recorded by the
owner**. DA-1a ships no default grant and no template values. The owner
records the pilot's numbers when the first responsibility is activated
(DA-6).

## Consequences

- Later increments (initiatives, runs, change sets, process repair) call
  `authorize()` immediately before each side effect, and again after any
  long I/O stage before committing. Snapshotting a revision allows
  auditing, not continued use of an obsolete revision.
- A title edit never invalidates in-flight work. Any authority or status
  change does. Pause followed by resume also counts, so adopted work
  replans under the current grant.
- Adding an operation, resource kind or budget key is a reviewed change
  to the vocabulary, the docs and the tests together.
