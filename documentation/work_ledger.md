---
title: The work ledger (failures, resource events, operator audit)
kind: guide
summary: The three diagnostics and cost tables - work_failures, resource_events and operator_audit - what each row holds and never holds, who can read them, how long they live, what erasure does, and the cost-per-accepted-result join with usage_reservations.
tags: [operations, diagnostics, cost, privacy, audit, shared-instance]
---

# The work ledger

Roadmap [#256](https://github.com/nervous-rob/goobster/issues/256). A shared installation needs three records it did not have: what went wrong with someone's work (without reading their prompts), what that work cost beyond tokens, and what the operator changed. This guide covers the three tables that hold those records, the read models built on them, and the rules every writer follows.

The one rule that makes the rest safe: **the ledger never holds a prompt, a reply, a message body, a query string, a code snippet, program output, a token or an address.** A row is a kind, an id, a phase, a machine code, a short reason and a time. If you need the text, it is somewhere with its own privacy path; the ledger only points at it by id.

## The three tables

All three live in `packages/core/db/schema.sql` and are keyed by the same *work reference*, `(workKind, workId)`, so a failure, a resource event and a token reservation for the same expedition cycle line up in one join.

| Table | One row per | Retention | Erasure | Who reads it |
|---|---|---|---|---|
| `work_failures` | a piece of work that failed: `kind`, `workId`, `phase`, `code`, `reason` (clipped to 300 characters), `actor`, `createdAt` | 30 days | `actor` nulled, row kept | the person (own rows), the operator (every account) |
| `resource_events` | a non-token cost: `kind`, `quantity`, `provider`, `workKind`, `workId`, `actor`, `payer`, `createdAt` | 90 days | `actor` and `payer` nulled, row kept | the person (own totals), the operator (per account), the cost report |
| `operator_audit` | an operator action: `action`, `actor`, `target`, `detailJson`, `createdAt` | one year | `actor` and `target` nulled, row kept | operators, in the Host room |

`usage_reservations` (decided in [#248](https://github.com/nervous-rob/goobster/issues/248)) is created by the same schema so the cost join has its other half: `actor`, `payer`, `workKind`, `workId`, `estimatedTokens`, `actualTokens`, `status` (`held` / `settled` / `released`). **#256 creates the table and reads it; the code that writes reservations lands with #248.** Until then `actualTokens` in the cost report is zero for live work, and the join is exercised by seeded rows in `tests/workLedger.test.js`.

Rows are kept on erasure rather than deleted so the operator's counts stay whole: "twelve failed turns last week" is still true after one of those people leaves, it just no longer says who.

## Work references and the work context

Writers do not thread ids by hand. `packages/core/utils/workContext.js` carries the *current work* on `AsyncLocalStorage`:

```js
const workContext = require('@goobster/core/utils/workContext');
await workContext.run({ kind: 'expedition', id: 41, actor: userId }, () => runCycles());
```

Inside that callback `workContext.current()` is `{ kind, id, actor, payer }`, and both `workFailureService.note()` and `resourceEventService.record()` default their kind, work id, actor and payer from it. An inner `run()` **keeps the outer work** unless it passes `{ replace: true }`: a turn started by an automation stays the automation's work, so a search it makes is billed to the schedule that woke it, but a background project job started from a turn replaces the context because the job outlives the turn.

The places that open a work context:

| Kind | Opened by | Id |
|---|---|---|
| `chat` | `utils/chatHandler.handleChatInteraction` (Discord, web and unattended turns) | the web turn id when there is one, else the interaction id |
| `expedition` | `services/spitballExpeditionRunner` around the cycle loop | the expedition id |
| `job` | `services/projectService._startJobLoop` (replaces) | the Observatory job id |
| `automation` | `services/automationService._executeClaimedAutomation` (replaces) | the automation id |
| `watch` | `services/attentionWatchService._fire` (replaces) | the watch id |

Work that has no outer context - a sandbox run from a slash command, a delivery - records against its own id (`sandbox` + run id, `delivery` + inbox item id).

## `work_failures`: what went wrong

`services/workFailureService.js`. Kinds: `chat`, `expedition`, `job`, `sandbox`, `automation`, `trigger`, `delivery`, `mission_step`, `watch`, `followup`, `integration_action`, `reflection`.

Two writers:

- `note(params)` - best-effort, for the `catch` blocks of running work. Fills kind / work id / actor from the context, never throws (a ledger problem is logged, not propagated into a failure path that is already being handled). Returns the row id or `null`.
- `notify({ ...failure, userId, title, body, link, dedupeKey, discord })` - `note()` plus an Inbox item (`kind` `system`, `sourceType` `work_failure`, `sourceId` the row id) through `inboxService.deliver()`. Use it where the person should hear about the failure: an expedition that stopped, a scheduled task that failed.

`record()` is the strict form (throws on an unknown kind or a missing code); the restore path uses it.

Where each kind is written:

| Kind | Phase | Written by | Code |
|---|---|---|---|
| `chat` | `generate`, `handler` | `chatHandler` when the AI call or the turn throws | the error's `code` or `name`, else `TURN_FAILED` |
| `expedition` | `cycle` | `spitballExpeditionService.failExpedition` (+ Inbox notice, link `/knowledge/research`) | `CYCLE_FAILED` |
| `job` | `run` | `projectService._finishJob` when a job ends `FAILED` / `TIMED_OUT` | the job's error code (`TIMED_OUT`, `EXIT_NONZERO`, ...) |
| `sandbox` | `sandbox` | `sandboxService.run` when a run exits non-zero, times out or cannot start (outside a job) | `TIMED_OUT`, `EXIT_<n>`, or the `SandboxError` code |
| `automation` | `run` | `automationService._notifyRunFailure` on every failed run (+ Inbox notice once per streak, link `/activity/scheduled`) | the error's `code`, else `RUN_FAILED` |
| `trigger` | `delivery` | `projectTriggerService._finishDelivery` when a relay is given up or refused | `DELIVERY_EXHAUSTED`, `DISPATCH_FAILED` |
| `delivery` | `discord_echo` | `inboxService._echoToDiscord` when Discord refuses the echo (a missing adapter is a skip, not a failure) | `DISCORD_ECHO_FAILED` |
| `followup` | `delivery` | `followupDeliveryService` when a due reminder cannot be delivered | the error's `code`, else `DELIVERY_FAILED` |
| `watch` | `fire` | `attentionWatchService._fire` when a watch's turn throws | the error's `code`, else `FIRE_FAILED` |
| every long-running kind | `restore` | `backupService.interruptInFlightWork` | `INTERRUPTED_BY_RESTORE` |

The `reason` is the error's message or a phrase derived from the code. It is never stdout, stderr, a note, a seed, the prompt or the reply. A job's stderr tail stays on the job row (program output has its own path); the ledger says `the code exited with code 2`.

### Reading it

- **The person**: Usage room → *What went wrong* (`GET /api/app/usage/diagnostics?days=`), own rows only (`listForUser`, `summarize({ userId })`). An Inbox item that reports a failure carries `item.failure` (`{ id, kind, code, phase, reason, workId, createdAt }`) resolved through `getManyForUser(ids, userId)`, so a forged `sourceId` cannot read someone else's row; an item whose row has been pruned keeps its text and shows no detail.
- **The operator**: Host room → Accounts → *Support* on any row (`GET /api/app/admin/accounts/:principalId/support?days=`), which is `services/accountSupportService.view()`: token usage from `usage_log`, resource totals, and the failure summary and recent rows for that account. The roster (`GET /api/app/admin/accounts`) carries a `failures` count per account for the window.

## `resource_events`: what work cost beyond tokens

`services/resourceEventService.js`. Kinds and units: `search_call` (calls), `sandbox_seconds` (seconds), `retry` (retries), `image_generation` (images), `speech_seconds` (seconds), `embedding_call` (calls). `record({ kind, quantity, provider, work?, actor?, payer? })` never throws; the work, actor and payer default from the context, and `payer` defaults to the actor until #248 sets it from the budget owner.

| Kind | Recorded by | Under |
|---|---|---|
| `search_call` | `spitballSearchService.search` once per provider call (adapters that record themselves set `recordsOwnCalls`); `perplexityService.searchDetailed` / `searchImages` | the expedition or the turn |
| `sandbox_seconds` | `sandboxService.run`, the run's wall time, `provider` = isolation (`bwrap`, `unshare`, `none`) or `remote` | the job, the turn, or the run itself; the dedicated runner (`apps/sandbox`) passes `record: false` because the calling process records |
| `retry` | `utils/chat/agentOrchestrator` when finalisation has to run again | the turn |

`totals({ userId, days })` is the per-person and per-account read (Usage room → *Other resources*; the operator's support view). Tokens are **not** here: `usage_log` (reports) and `usage_reservations` (limits) hold them.

## Cost per accepted result

`services/costReportService.js` is the join and nothing else - no new table.

- `workCosts({ workKind, payer, days, from, to })` → one row per `(workKind, workId)` in scope: `actualTokens` (sum of `settled` reservations), `estimatedTokens` (sum of `held`), `reservations`, `resources` by kind, and the `work_failures` count.
- `costPerResult({ accepted, ...filter })` → the totals divided by the accepted results. `accepted` is the consumer's word - the ids of the briefs someone marked accepted, or a count - so the number that #265 measures (cost per accepted research result) is one call:

```js
const report = await costReportService.costPerResult({ workKind: 'expedition', days: 30, accepted: acceptedIds });
report.perAccepted // { actualTokens, resources: { search_call, sandbox_seconds, retry } }
```

`usage_log` is deliberately outside this join: it has no work id and no payer, and erasure nulls its `userId`.

## `operator_audit`: what the operator changed

`services/operatorAuditService.js`. Actions: `invite.create`, `invite.revoke`, `account.grant`, `account.status`, `account.role`, `account.recovery`, `signup.mail_test`, `instance.pause`, `instance.restore`, `instance.resume`, `limits.change` (reserved for #248). Every mutating route in `packages/core/web/routes/admin.js` writes one row **after** it succeeded, with the operator as `actor` and the affected principal or invitation id as `target`; a refused action (a self-lockout, an unknown principal) writes nothing. `instanceStateService` writes the pause, restore and resume rows itself, so the CLI restore is audited too (`actor` null, `detail.via` naming the command).

`detail` is small structured context (`{ role, hasNote }`, `{ status }`, `{ skipped: {...} }`). The service strips `token`, `url`, `password`, `secret`, `email`, `to`, `address` and `loginName` before storing, so a route cannot leak a link or an address by accident. Adding an operator route means adding its action here and writing the row in the same change.

The Host room → *Operator audit* lists it newest first (`GET /api/app/admin/audit?limit&before&target&action`, keyset-paged by id); names are resolved from the roster, an erased actor shows as "someone erased".

## Retention and erasure

`services/ledgerRetentionService.js` sweeps all three tables every six hours under `db.withSingletonLock('ledger_retention')`, started by `runtime/coreRuntime.js` with the other schedulers (`ledgerRetention`). Windows: `work_failures` 30 days, `resource_events` 90 days, `operator_audit` 365 days. `sweep()` can be called directly and returns the counts removed.

`/forget-me` (`privacyService.forgetUser`):

- `work_failures`: `actor` → NULL, row kept.
- `resource_events`: `actor` and `payer` → NULL, row kept.
- `operator_audit`: `actor` and `target` → NULL, row kept.
- `usage_reservations`: rows the person **pays for** are deleted (no cap applies to an account that no longer exists) along with their `admission_locks` budget row; rows where they are the actor but someone else pays keep the row with `actor` → NULL.

`auditUser` counts all four tables afterwards; `buildUserReport` includes the person's resource events, reservations and the audit rows that name them (as actor or target).

## Adding a writer

1. Open a work context if the work does not have one, or rely on the one it runs under.
2. In the failure path call `workFailureService.note({ phase, code, reason })` - kind, id and actor come from the context. Use `notify()` if the person should hear about it in their Inbox.
3. For a cost, call `resourceEventService.record({ kind, quantity, provider })`; add the kind to `KINDS` with its unit if it is new.
4. Never pass a prompt, a reply, a body, output, a token or an address as `reason` or `detail`. The test suite greps the tables for a marker string; keep it that way.
5. Update the tables above.

## Tests

`tests/workLedger.test.js` on SQLite and Postgres: every kind writes a row and none holds the marker text; a failed expedition, a failed scheduled task, a non-zero sandbox run, a failed job and a refused Discord echo each write through their real path (the expedition and the automation with an Inbox item that links to the row); the search service records per provider under the expedition; totals per person and per kind; the seeded cost-per-result join; own rows only and the operator's per-account view; the 30 / 90 / 365-day sweeps and the runtime registration; erasure nulls and keeps; every operator action in the Host room writes one audit row and no token or link is stored; audit paging and filters; secret keys stripped from `detail`.
