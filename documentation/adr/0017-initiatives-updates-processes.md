# ADR 0017: Opportunities come from durable cursors, updates have one identity per audience, and process outcomes are typed observations

## Status

Accepted for increments DA-1b, DA-1c and DA-1d of the
[delegated assistant plan](../delegated_assistant_implementation.md).
It builds on [ADR 0016](0016-delegated-responsibilities.md) and uses the
table names that ADR reserved. Behaviour is documented in
[delegated_responsibilities.md](../delegated_responsibilities.md). The
services are `assistantInitiativeService.js`, `assistantUpdateService.js`,
`assistantProcessService.js` and `assistantStewardService.js` under
`packages/core/services/`.

Nothing in this ADR runs delegated work. A runner that claims queued
initiatives arrives with DA-3, and process health and repair arrive with
DA-5. This ADR fixes the records those increments write to.

## Context

DA-1a made the grant exact. Three more contracts have to exist before any
work runs under a grant:

1. **Where work comes from.** The architecture (section 4) says the event
   bus accelerates work but must not be its source of truth. Events are
   in-memory and are lost across a restart or on a crash, and
   `domainEventBus` delivers at most once.
2. **How a result reaches a person.** One finding can touch Research,
   Knowledge and Projects. Counting it once per component, or filing a new
   Inbox item for every rescan, would make Home noisy and the counts wrong
   (section 9.1). Inbox already has a per-user `dedupeKey` and a read state.
3. **What a recurring process did.** Automations, project triggers,
   Attention watches and followed sources each keep a different amount of
   history. `project_trigger_deliveries` is a real delivery ledger, while
   automations keep only `lastRun`. Process stewardship (DA-5) needs a typed
   history to judge, and it needs that history to start accumulating now.

## Decision

1. **Opportunities are derived from source cursors, not from events.**
   - `assistant_source_cursors` has one row per (responsibility, source
     kind, source id) and stores the last material revision seen. A source
     adapter turns the current state of a linked record into a revision
     fingerprint. The adapters are the Attention item (state, goal,
     unresolved threads, deadline) and the project plan (plan revision and
     status).
   - The first scan after activation writes a baseline and proposes
     nothing. Existing history is evidence, not a new instruction.
   - A changed revision proposes one `assistant_initiatives` row and
     advances the cursor in the same transaction. The cursor update is a
     compare-and-swap on the previous revision. Proposals are idempotent on
     UNIQUE (responsibilityId, dedupeKey, sourceRevision, attempt), so a
     crash between the two writes, or a rescan, never yields a second
     candidate. A newer revision supersedes an open older attempt at the
     same opportunity.
   - `attention.*` and `mission.*` events only schedule an early reconcile
     for the owner they name. A periodic steward pass recovers anything a
     missed event would have delivered. It runs a minute after start and
     then every 5 minutes, under `withSingletonLock('assistant_steward')`.
     The first pass waits so it does not compete with the other startup
     sweeps, each of which holds a pooled connection for its lock.
   - Derivation happens only for an ACTIVE, unexpired grant whose owner has
     Attention enabled.

2. **An initiative is an attempt, not a goal.** Statuses are `CANDIDATE`,
   `QUEUED`, `RUNNING`, `WAITING`, `REVIEW`, `COMPLETED`, `FAILED`,
   `CANCELLED` and `SUPERSEDED`. Every write is a compare-and-swap on
   `revision`.
   - The owner can `queue`, `cancel`, `retry`, `accept` and `reject`.
     Queuing records the grant revision current at that moment, so the
     owner re-approves the attempt under the grant as it is now.
   - `claim()` is the runner's entry point. It re-checks the grant, refuses
     an attempt planned under an older `authorityRevision`
     (`REVISION_CONFLICT`, which moves it to WAITING with `REPLAN_REQUIRED`),
     enforces the grant's `concurrentInitiatives` budget, and returns a
     lease token that lasts 10 minutes. `settle()` must present that token.
     Once a lease expires the attempt returns to QUEUED, and the old
     holder's token no longer works.
   - Ending a grant (revoke, expire, complete, archive) cancels its open
     attempts in the same transaction as the status change. Pausing it, or
     moving it to review, parks queued and running attempts as WAITING.

3. **One canonical update per (audience, identity).**
   - `assistant_updates` is UNIQUE (audienceKey, identityKey). The audience
     is a person (`audienceKey` = their user id) or a project
     (`project:<id>`). `identityKey` is stable and set by the producer, for
     example `responsibility:12:status`.
   - The material fields (kind, title, summary, components, source,
     evidence, actions and gate) are fingerprinted. Republishing an
     unchanged fingerprint changes nothing. A changed fingerprint bumps
     `materialRevision`, takes a new global `sequence` and becomes unseen
     again.
   - `componentsJson` lists every component the update touches. Counts are
     taken over distinct update ids: the overall unseen count counts each
     update once, and each component counts it once.
   - `assistant_update_receipts` stores `deliveredRevision` and
     `acknowledgedRevision` per (update, person). The two are separate:
     mentioning an update in conversation delivers it but does not
     acknowledge it. Acknowledging names an exact revision. It is
     idempotent, never lowers an existing receipt, is capped at the current
     revision, and reports `older_revision` when a newer one exists.
   - Project updates are visible to current members only. Losing
     membership hides them, and each member keeps their own receipt.
   - An open `gate` (a question, a review) makes an update "needs action"
     until the producer resolves it. Acknowledging an update does not
     resolve its gate. Snoozing hides the gate until a set time and leaves
     it open.

4. **The Inbox item is an envelope, not a second record.** A personal
   update asks for one Inbox item (`kind: 'notice'`, source type
   `assistant_update`, `dedupeKey` `assistant_update:<id>`).
   - The envelope's `sourceId` is `<updateId>:<revision>`. A new revision
     refreshes the same Inbox item and marks it unread again.
   - Reading the envelope acknowledges exactly the revision it shows. If
     the update has moved on, the newer revision stays unseen.
     Acknowledging the update in the portal marks the envelope read only
     when the envelope already shows that revision.
   - Filing the envelope can reach the network, so it never runs inside a
     database transaction. A producer inside a transaction publishes with
     `deliverNow: false`, and the envelope is filed after commit or by the
     next steward pass (`envelopeRequested`, `envelopeRevision`).
   - Project updates do not file personal envelopes.

5. **Processes are a read model plus typed observations.**
   - The catalog reads existing rows through adapters (`automation`,
     `project_trigger`, `attention_watch` and `followed_source`), using the
     same reference kinds as the grant's `process` resource. It does not
     copy them. A followed source's URL is not part of the read model.
   - `assistant_process_contracts` (UNIQUE per process) records why a
     process exists: its purpose, cadence, freshness, whether a quiet
     result is fine, its criticality, an optional link to an Attention item
     or project, a review date and a stop condition. Writes are owner-only
     compare-and-swap.
   - `assistant_process_observations` is UNIQUE (processKind, processId,
     occurrenceKey, phase). The phase is one of `schedule`, `dispatch`,
     `execution`, `output`, `delivery` or `outcome`. The outcome is one of
     `ok`, `skipped`, `blocked`, `deferred`, `failed` or `unknown`.
     `reasonCode` must match `[A-Za-z0-9_.:-]{1,64}`, and anything else is
     stored as `UNCLASSIFIED`, so free text such as an error message, URL or
     token can never land there. Reporting the same occurrence again
     updates its row and counts the attempt.
   - The occurrence key is the identity that the process's own claim
     consumed. For an automation that is the fire time it advanced past
     (`fire:<nextRun>`). For a project trigger it is the source job
     (`job:<id>`), or the fire time for a cron trigger.
   - Automations record their `outcome`, and project triggers record their
     `dispatch`. `project_trigger_deliveries` stays the trigger's delivery
     ledger, and the catalog reads it as history instead of duplicating it.
   - `record()` never throws and records nothing while the feature is off.
   - Health and relevance stay `unknown` until DA-5 judges them.

6. **Retention.** The steward applies it every 6 hours:
   - Process observations: 90 days, plus any contract or observation whose
     process no longer exists.
   - Terminal initiatives: 180 days.
   - Updates: 180 days, but only once they have no open gate. Their
     receipts go with them.

   Cursors live as long as their responsibility.

7. **Privacy.** Every new table is personal data and is covered by the
   transparency report, the account export and `/forget-me`. The erasure
   SQL lives in `dormantDataService`, so it works with the feature off.
   - Erasure deletes the person's cursors, initiatives, personal updates,
     receipts, contracts and observations.
   - On a project's shared update, erasure nulls the person as producer and
     drops links to their deleted records.
   - Erasure ends any open attempt on someone else's grant that named them
     (`PRINCIPAL_ERASED`), along with the revocation ADR 0016 already
     specifies.

8. **Runtime.** The `assistantSteward` runtime step is owned by the
   `assistant` feature. It runs in whichever process runs the core
   schedulers (the bot, or `apps/api` standalone), is stopped on instance
   pause, and drains inside the runtime-step bound.

## Consequences

- A missed or duplicated event can delay an opportunity by up to one
  steward interval. It cannot lose one or create two.
- Home (DA-2) can be a pure projection. It reads `GET
  /api/app/assistant/updates`, which never acknowledges, delivers or
  resolves anything.
- The runner (DA-3) has one entry point (`claim`) and a fenced exit
  (`settle`). It must still call `authorize()` before each side effect,
  because the lease proves who holds the attempt, not that the grant still
  allows the action.
- Producers must choose stable identity keys. A key that includes
  volatile text would defeat deduplication.
- Process history starts now for automations and project triggers.
  Attention watches and followed sources show up in the catalog, and they
  get observations when DA-5 instruments them.
