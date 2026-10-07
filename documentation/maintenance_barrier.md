---
title: Maintenance barrier - a durable, fenced state for restore, reset and migration (installer P4.1)
kind: reference
summary: The maintenance barrier is a manager-owned, durable state of the whole installation in which no application process writes to the database or the data tree. It is recorded in the manager store (maintenance.json) with a monotonic fencing token, entered only after every registered writer acknowledged the fence, refused outright when a writer cannot be fenced, and honoured (never auto-resumed) across a manager restart. This document holds the writer inventory (every process and path that writes, how it is stopped or refused, and the response the caller sees), the state machine with its cancel-safe and irreversible boundaries, the recovery rules, the maintenance.enter and maintenance.release operations and their API, and how each process enforces the fence. It is not the paused flag, not restore and not reset.
when: Adding anything that writes (a route, an event handler, a timer, a worker, a callback) and needing to know how it behaves under maintenance; building restore, reset or a migration on top of the barrier; debugging a maintenance entry that was refused or a worker that stays fenced; reasoning about what a caller sees during maintenance.
tags: [installer, manager, maintenance, barrier, fence, restore, reset, migration, 503, lifecycle, operations]
---

# Maintenance barrier

Restore, reset and migration (installer plan Phase 4.2 to 4.4) rewrite the
database and the data tree. They are only safe when nothing else is writing.
The maintenance barrier is the state in which that is true, and the proof
that it is true. It is built on the manager ([manager.md](manager.md)) and
the worker contract ([manager_lifecycle.md](manager_lifecycle.md)), and it
follows ADR 0013 decision 11: **maintenance is not paused**.

- It is **owned by the manager** and recorded in the manager store
  (`<store>/maintenance.json`), so the question "are we in maintenance?"
  needs no application database.
- It is **acquired** by one operation (`maintenance.enter`) that holds the
  per-installation manager lock while it applies, and it carries a
  **fencing token**: a monotonic integer persisted in the store. Every entry
  increments it; an inactive document keeps the last value, so a token is
  never reused, even across manager restarts.
- It is **entered only after every registered writer acknowledged** that it
  stopped taking work and drained. A writer that cannot be fenced blocks the
  entry. There is no best-effort mode.
- It **survives a manager restart**. A barrier that is up when the manager
  starts is honoured as it is; it is never lifted or resumed on its own.
- A banner in the UI is a symptom of the barrier, not the barrier. The
  refusal is the barrier: a `503 MAINTENANCE` at the edge and a refused
  database write behind it.

## The writer inventory

Every way the installation changes state, which process owns it, how
maintenance stops or refuses it, and what the caller sees. "Gate" is the
admission check (`runtime/maintenance.js` `isActive()`), which closes the
moment the process engages; "fence" is the database fence, set after the
process drained (see [The fence in processes](#the-fence-in-processes)).

Processes: **bot** (`apps/bot`, in lite also serves the portal and the
public HTTP server), **api** (`apps/api`, the web backend in the paired and
standalone layouts), **sandbox** (`apps/sandbox`, the code-execution runner).
The manager itself never serves application traffic.

| Writer | Process | How it is stopped or refused | What the caller sees |
| --- | --- | --- | --- |
| Portal and API routes with a mutating method (`POST`, `PUT`, `PATCH`, `DELETE`): chat, projects, settings, inbox, account, admin, and every other router mounted under `/api/app` | bot (lite), api | `maintenanceGate` runs before every router and before the body parser, so a refused request is never read. Requests admitted before the fence are tracked and drained within the bound | `503 { error: "MAINTENANCE", message, retryAfter }` with `Retry-After: 30` and `Cache-Control: no-store` |
| Portal and API routes with a safe method (`GET`, `HEAD`, `OPTIONS`) | bot, api | Admitted. The one write a read makes, the session's last-seen stamp, is skipped under the fence so a signed-in person is still recognised. Anything else a read writes is refused by the database fence | `200` as usual. A read that tries another write gets the database fence's `MaintenanceError` (503 semantics); a route that catches errors answers its own error, so a read path must not write (the fence is how one that does is found) |
| Public server mutating routes that are not the portal: Activity, the internal gateway API (`/internal/gateway/*`), MCP over HTTP and any other mutating route the bot's HTTP server carries | bot | `maintenanceGate()` installed on the whole public server (`apps/bot/web/server.js`) | `503 MAINTENANCE` as above |
| Health and status (`/health`, the manager status page) | bot, api | Safe methods; not gated | `200`. The health payload keeps reporting; it does not claim maintenance |
| Discord slash commands (core commands included) | bot | `refuseUnavailableCommand` answers before any handler or cooldown runs. Commands in flight are drained as interactions | An ephemeral reply: "Goobster is in maintenance right now. Try that again in a few minutes." |
| Discord autocomplete | bot | Answered with an empty list | No suggestions |
| Discord buttons, select menus and modals | bot | `gateComponentInteraction` answers with the same sentence | The same ephemeral reply |
| Discord messages (chat turns, replies, counters, dynamic-response scoring) | bot | `messageCreate` returns first; no tool call, memory write or counter write starts | No reply. The message is not queued or replayed |
| Portal WebSockets: Parlor Live, Study voice, Song Studio (`/api/app/*/live`) | bot (lite), api | A new upgrade is refused before origin, session or lease checks; open sockets are closed with code 1013 (`MAINTENANCE`) when the process engages | `HTTP 503` with `Retry-After` on the upgrade; code 1013 on a socket that was open |
| Activity, screen-vision and GBA WebSockets | bot | `guardUpgrades(server)` refuses every upgrade on the public server, whichever handler would have served it. Sockets already open are **not** closed on engage; each write they make is refused by the database fence | `HTTP 503` on a new upgrade. An open socket's writes fail with `MaintenanceError` |
| Discord voice sessions | bot | `voiceSessionService.endAllSessions` runs in the drain, within the `voiceSession` bound | The session ends as it does for a restart |
| Timers and `coreRuntime` steps: event bus, chat-history retention, account exports, self-docs seed, observatory resume, mission reconcile, project trigger catch-up, automation, follow-up delivery, personal heartbeat, expedition scheduler, memory consolidation, knowledge reflection, ledger retention, heartbeat, agent tracker, monologue, exchange risk engine | bot (lite), api (standalone) | `coreRuntime.enterMaintenance(boundMs)` drains and tears the runtime down in the running process; `resumeFromMaintenance()` starts it again as a start would. A process that **starts** under an active barrier starts none of them: every step reports `{ status: "skipped", reason: "maintenance" }` and the runtime is dormant until resume | No caller; scheduled work does not run. Nothing is replayed in a burst on resume beyond what each step's own catch-up does on a normal start |
| Spitball expeditions | bot, api | The expedition scheduler step stops with the runtime; a cycle in flight finishes or is interrupted inside the `expedition` bound, and resumes once on release (cycles run once across a stop; see [manager_lifecycle.md](manager_lifecycle.md) L1) | The expedition shows as running or queued; no cycle is lost or doubled |
| Observatory jobs and missions | bot, api | `observatoryResume` and `missionReconcile` do not run; a job in flight is part of the runtime's drain. Domain events that would start a watch fire into a stopped bus | No caller |
| Sandbox runs and their outputs on disk | bot, api (via `sandboxService`), sandbox runner | `sandboxService.pauseNewWork()` then `drainRuns()` / `interruptRunning()` inside the `sandboxRun` bound; the runner (`apps/sandbox`) answers its `/run` route with `503 MAINTENANCE` and drains its own runs | A tool call or portal run gets `503 MAINTENANCE` / a "try again" result. An interrupted run is reported `INTERRUPTED`, never as a result. A runner outside this machine (`GOOBSTER_SANDBOX_URL` not loopback) cannot be fenced from here, so entry is refused (`WRITER_UNFENCEABLE`) while the sandbox feature is active |
| Music downloads (`/spotdl`, `/play url:`) | bot | Started only by commands, which are refused. A download in flight belongs to its interaction and is drained within the `integrationAction` bound | The refused command's ephemeral reply |
| Integration callbacks: GitHub and Cursor webhooks (`/api/webhooks/github`, `/api/webhooks/cursor`) | bot (lite), api | `maintenanceGate()` on the integrations app, before the raw-body parser | `503` with `Retry-After`, so GitHub and Cursor redeliver once the installation is back, instead of a delivery being accepted and lost |
| Pending integration actions (a confirmed GitHub or Cursor action waiting on a person) | bot | They are started by a button, a command or a portal route, all refused. One already running is drained inside the `integrationAction` bound | The refusal of the route that would have confirmed it. The pending action stays pending |
| MCP | bot | Read-only today (the tool surface exposes no write). The HTTP transport is on the public server, so a mutating verb is refused by the gate anyway. **Rule for a future write:** a write tool must go through the database facade (so the fence refuses it) and must not hold work across the gate; do not add a write path that bypasses `db.run`/`db.insert`/`db.transaction` | Reads work; a mutating request is `503 MAINTENANCE` |
| Manager `reconcileAudit` (opens the application database to copy journaled audit rows into `operator_audit`) | manager | `manager.reconcile()` defers while the store is active or unreadable. The rows stay in the journal (the journal is the record) and are copied after release | Nothing visible; `GET /status` `audit.pending` rises, then falls after release |
| Inbox echo (`inboxService.deliver`, then the Discord DM) | bot, api | The Inbox row is a database write: refused by the fence. The Discord echo is a send from a process that is engaged, which no gated path reaches | A result that would have been delivered during maintenance is not delivered; its producer is already refused or stopped |
| Idempotent schema apply on database open | any process that opens the database | Not refused: it runs when a process **boots** while the barrier is up (a worker restarted by an operator mid-maintenance). The schema is idempotent and a restore or migration that follows owns the final schema | No caller; see Risks in the work that builds on this |

Anything not in the table must be added to it in the change that adds the
writer. The test `tests/maintenanceFence.test.js` is the executable form of
the table for the paths it can reach without Discord.

## The state machine

The barrier is a record in `<store>/maintenance.json`:

```json
{
  "version": 1,
  "active": true,
  "operationId": "op_...",
  "fence": 3,
  "phase": "quiesced",
  "revision": 7,
  "reason": "restore",
  "enteredAt": "2026-10-07 06:00:00",
  "owner": { "pid": 4242, "bootId": "..." },
  "mutateBegun": false,
  "writers": { "bot": { "acked": true, "at": "...", "pid": 4300 } },
  "journal": [ { "phase": "quiesce", "outcome": "ok", "action": "maintenance.enter", "actor": "...", "fence": 3 } ]
}
```

It is written atomically (temp file and rename through `store/files.js`),
bumps `revision` on every change, keeps the last 100 journal records, and
refuses to overwrite a file it cannot read (`409 MAINTENANCE_STATE_UNREADABLE`).
The journal holds only actor ids, action names, outcomes and codes: never a
path with user content, a secret, a row, or a reason that is not a plain
label (`reason` is `^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$`).

Phases, in order:

```
plan -> preflight -> backup -> quiesce -> mutate -> verify -> cutover -> release
```

| Phase | What it is | Implemented in 4.1 |
| --- | --- | --- |
| `plan` | The operation's plan is built: reason, timeout, the writers the layout will fence. Nothing is persisted | yes |
| `preflight` | Refuse early: a restart is pending (`RESTART_PENDING`), maintenance is already active (`MAINTENANCE_ACTIVE` or `STALE_MAINTENANCE`), the layout cannot be resolved (`LAYOUT_UNRESOLVED`), a writer cannot be fenced (`WRITER_UNFENCEABLE`). Still nothing persisted | yes |
| `backup` | A hook: a later kind (restore, reset) takes its backup here, with every writer already quiesced when it is reached through `quiesced` | hook only (`barrier.advance`) |
| `quiesce` | The fence is incremented and persisted with `active: true` **before** any writer is asked to stop; each writer is sent stop-new-work with the fence, and the entry waits for each writer's acknowledgement of that fence | yes |
| `mutate` | The change itself (restore, reset, migration) | hook only |
| `verify` | In 4.1: verify of quiescence (every acknowledged writer is still the one that acknowledged; no unknown process answers a worker's health URL). A later kind adds verification of the mutation | quiescence only |
| `cutover` | A hook for switching to the changed state | hook only |
| `release` | `maintenance.release` with the matching fence | yes |

The resting phase after a successful `maintenance.enter` is **`quiesced`**:
everything is stopped and the barrier waits for an operator or a later kind.
From `quiesced` the allowed forward moves are `backup` and `mutate`; from
`backup` back to `quiesced` or on to `mutate`; then `verify`, then
`cutover`.

**Boundaries.**

- **Cancel-safe through `quiesce`.** Until a `mutate` begins, a release puts
  everything back exactly as it was: no data was touched.
- **Irreversible from `mutate`.** When `barrier.advance` moves to `mutate`
  the document records `mutateBegun: true`. From then on a plain release is
  refused (`409 MUTATION_NOT_COMPLETE`) unless the caller passes
  `acknowledgeMutation: true`, which says the installation was inspected and
  may be half-changed; the kind that mutates records how its phase ended
  with `barrier.settle`. The barrier never resumes a `mutate` on its own.

Terminal outcomes in the journal: `released`, `refused` (entry failed and
rolled back: writers told to resume, `active: false`), `recovered`
(boot-time note), `forced` (see below).

## Entering and releasing

### `maintenance.enter`

Input `{ reason, timeoutSeconds?, expectedRevision? }`; `timeoutSeconds` is
an integer from 10 to 600 (default 120); `expectedRevision` is the document
revision the caller looked at (`409 REVISION_CONFLICT` if it moved).

Apply, under the manager lock:

1. Re-check enterability inside the lock (restart pending, already active,
   stale, layout).
2. Increment the fence and persist `active: true, phase: "quiesce"`.
3. For every worker of the layout, send stop-new-work with the fence: the
   control file (`maintenance` request carrying `fence`) for every adapter.
   The worker's lifecycle poll picks it up within one second.
4. Wait, up to `timeoutSeconds`, for each worker's acknowledgement **of this
   fence**: the worker writes `<store>/maintenance-ack/<worker>.json` (state
   `fenced`) and posts it to `POST /manager/api/maintenance/ack`, after its
   admission closed, its drain finished and its database fence is set. An
   acknowledgement for another fence is ignored.
5. Verify quiescence, then persist `phase: "quiesced"` and return
   `{ operationId, fence, phase, boundary, writers }`.

Failure at any step is a refusal and a rollback: writers are told to resume
(a `resume` request with the fence), `active: false` is persisted, the
journal records `refused` with a code, and the operation fails with:

| Code | Meaning |
| --- | --- |
| `WRITER_UNACKNOWLEDGED` | A worker did not acknowledge this fence in time |
| `UNKNOWN_WRITER` | A process answers a worker's health URL that is not one this manager started or that acknowledged (an orphan, a second copy). It could write, so the entry is refused |
| `WRITER_UNFENCEABLE` | A writer exists that this manager cannot reach (the sandbox runner on another host) |
| `LAYOUT_UNRESOLVED` | The worker set cannot be derived (a configuration the manager cannot read) |
| `CONTROL_WRITE_FAILED` | The control request could not be written |
| `QUIESCE_FAILED`, `QUIESCE_LOST` | Quiescence did not verify, or a fenced writer came back |
| `RESTART_PENDING` | `lifecycle.json` has a pending restart; resolve it first |
| `MAINTENANCE_ACTIVE` | Maintenance is already active; two operations never both mutate |
| `STALE_MAINTENANCE` | A barrier left by an earlier manager process is up; inspect it and release with force |
| `MAINTENANCE_STATE_UNREADABLE` | `maintenance.json` cannot be read; it is left as it is and treated as active |

A worker that is not running (stopped, or not started yet) is not a writer
and does not block the entry; it will find the barrier in the store when it
boots and fence itself (see below).

### `maintenance.release`

Input `{ operationId, fence, force?, acknowledgeMutation? }`. The fence must match the active
barrier (`409 FENCE_MISMATCH`), and the barrier must be active
(`409 MAINTENANCE_NOT_ACTIVE`). Apply: persist `active: false` **first**,
then send `resume` with the fence to every worker and wait briefly for the
`resumed` acknowledgements. A worker that did not confirm is reported as
`unconfirmed`; it resumes from the store on its next poll tick anyway,
because the store is the truth.

Releasing is **not** un-pausing. The instance's paused flag
(`instanceStateService`, restore's policy) is not touched by either
operation; a restore that leaves the instance paused after recovery keeps it
paused after the barrier is released.

`force: true` is for a barrier that cannot be released normally: a stale one
(its owner process is gone). It is accepted only from
`via: "bridge"` or `via: "recovery"` (an operator at the manager's own
authority; `FORCE_REQUIRES_OPERATOR` otherwise) and the audit record is
marked `forced: true`. Today `bridge.requireStrongAuth()` is always false
(#255), so the rule is implemented as "a bridge or recovery operator"; when
strong auth lands it is the check to tighten.

## Recovery rules

- **The manager restarts while the barrier is up.** `recoverOnStart` honours
  it: the barrier stays active, the manager does not resume workers, and it
  journals `maintenance.recover` once, with code `HONOURED` (before
  `mutate`) or `MUTATE_NOT_RESUMED` (a `mutate` had begun). `reconcile()` of
  the audit stays deferred. `apps/manager/index.js` logs a warning.
- **Stale.** A barrier is stale when its owner's boot id differs from the
  running manager's or its owner pid is dead. A stale barrier is never
  entered over (`409 STALE_MAINTENANCE`), and a plain release refuses with
  the same code; a forced release by a bridge or recovery operator clears it
  and is audited `forced`.
- **A worker restarts while the barrier is up.** The worker reads the store
  at boot; active, or unreadable, means it fences itself before it opens its
  server or starts any runtime step, then acknowledges. Under an unreadable
  file the worker assumes active.
- **The control file is lost or a signal is missed.** The worker's poll
  reconciles from the store every tick (every second): active and not
  fenced, it engages; inactive and fenced, it resumes. The control request
  is a nudge, the store is the truth.
- **The store file is deleted.** The fence resets to 0 and the workers see
  an inactive barrier. Do not delete it; this is an operator-only action
  with no protection.
- **Maintenance and lifecycle never overlap.** `lifecycle.apply` refuses
  `409 MAINTENANCE_ACTIVE` while the barrier is active or unreadable, and
  `maintenance.enter` refuses `409 RESTART_PENDING` while a restart is
  pending. `features.set` and `config.set` are not refused; they only record
  a change (and a restart they need is held back by the first rule).

## API

Under `/manager/api` (see [manager.md](manager.md) for the transport and
authentication):

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /maintenance` | read | The whole sanitized state: `{ active, phase, fence, since, stale, problem, operationId, reason, boundary, mutateBegun, revision, writers, journal, lastOutcome }`. Works with the application database offline |
| `POST /maintenance/ack` | loopback only, with the per-start `x-goobster-ack-token` header | A worker's fence acknowledgement `{ worker, fence, state, pid }` (`state` is `fenced` or `resumed`). Refused `403 ACK_REFUSED` unless it matches a worker this manager started |
| `POST /operations` `{ kind: "maintenance.enter", input }` | operator | The enter operation above (plan, validate, apply) |
| `POST /operations` `{ kind: "maintenance.release", input }` | operator | The release operation above |
| `GET /status` | read | `maintenance: { active, phase, fence, since, stale, problem }`, read from the store only |

Audit actions: `manager.maintenance.enter` and `manager.maintenance.release`
(in `operatorAuditService.ACTIONS` and `apps/manager/audit.js`). The audit
detail carries the outcome, the fence and the writer names, never the reason
text beyond its label; a forced release carries `forced: true`.

## The fence in processes

The contract for a worker is in `packages/core/runtime/lifecycle.js`:
`onMaintenance({ name, drain, interrupt, resume })` registers what the
process stops and starts, `enterMaintenance({ fence, drainSeconds })` runs
it, and `resumeMaintenance({ fence })` undoes it. The shared state is
`packages/core/runtime/maintenance.js`.

Engaging is **two stages**, in this order:

1. **Admission closes.** `isActive()` becomes true. Mutating HTTP routes
   answer `503`, Discord commands, buttons and messages are refused, no
   chat turn starts, WebSocket upgrades are refused, the sandbox admits no
   run.
2. **Drain, then the database fence.** The process drains what was already
   admitted (`maintenanceGate.drainRequests()`, interactions in flight,
   sandbox runs, voice sessions, the `coreRuntime` teardown), each inside
   its contract bound. Only then is the **database fence** set
   (`fenceDb(fence)`): the facade throws `MaintenanceError` (code
   `MAINTENANCE`, status 503) from `db.run`, `db.insert` and
   `db.transaction`, and the adapter goes engine-level read-only (SQLite
   `PRAGMA query_only`, Postgres `default_transaction_read_only` on every
   pooled connection as it is acquired). Then the worker acknowledges.

The ordering matters: fencing the database first would fail work that was
legitimately in flight; draining without the fence would leave a hole for
anything the table missed. The facade throw is the backstop for a writer
that was missed, and the engine setting is the backstop for code that holds
a raw handle (`db.getDb()` on SQLite, `db.rawQuery` on Postgres). Reads are
never refused.

Resuming reverses it: the database fence lifts, the engine goes read-write,
admission reopens, the runtime restarts. A resume for a different fence is a
no-op.

A worker acknowledges by writing `<store>/maintenance-ack/<worker>.json`
(`{ version, worker, fence, state, pid, at }`) and posting the same to the
ack route. The supervisor matches the pid against the process it started,
and a worker the manager did not start is matched by the pid in the file
(this is how an external worker, or an orphan, is told apart).

## What this is not

- **Not paused.** The instance's paused flag is an operator scheduling
  policy: it is written to the application database, applies on the next
  start, and does not stop admitted routes. Maintenance is in the manager
  store, stops every writer, and is proven by acknowledgements. Neither
  implies the other, and `maintenance.release` leaves the paused flag
  exactly as it was.
- **Not restore.** The barrier supplies the state in which a restore may
  run; it restores nothing. `backup`, `mutate` and `cutover` are phases an
  operation advances through. See
  [backup_and_restore.md](backup_and_restore.md).
- **Not migration.** The migration path (Phase 4.3) uses the same barrier;
  this change only supplies the barrier and its tests.
- **Reset is the first operation built on it.** `data.reset`
  ([data_reset.md](data_reset.md)) runs inside a barrier left at `quiesced`:
  it drives `backup`, `mutate`, `verify` and `cutover` itself, never releases
  the barrier, and is refused unless the barrier is held with its fence and
  every writer acknowledged. `maintenance.release` with `via: 'local'` is the
  CLI's `goobster-manager release`, including the forced release a reset that
  stopped after `mutate` began needs (`--force --acknowledge-mutation`).
- **Not a lock on the manager.** The manager keeps operating (status,
  journal, lifecycle reads, `maintenance.release`); only application
  writers are fenced.

## Tests

`tests/maintenanceBarrier.test.js` covers the store, the state machine and
its boundaries, boot recovery, failure injection (a crash at every write of
an entry and a release), enter and release over HTTP with fake workers,
concurrent entries, `UNKNOWN_WRITER`, `WRITER_UNFENCEABLE`,
`LAYOUT_UNRESOLVED`, the stale and forced release, input validation, the ack
route and the audit action lists. `tests/maintenanceFence.test.js` covers
the facade fence (both engines, including the raw handle), the portal gate,
the webhook gate, `coreRuntime` under maintenance, the Discord refusals, the
sandbox runner, the worker lifecycle contract, and two real `apps/api`
children fenced and released by the real barrier. Both run on SQLite and
Postgres.
