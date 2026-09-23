---
title: Shared-instance roadmap - handoff and next steps
kind: reference
summary: Where roadmap #246 stands after #249 and #256 shipped, the seams the next steps build on, and a step-by-step brief for each of them - token budgets (#248), the pilot plan (#265), the two actual-host gates (#247, #249), the deployment promise (#268) and what the second account unlocks.
tags: [roadmap, handoff, shared-instance, limits, pilot, operations]
---

# Shared-instance roadmap: handoff and next steps

Companion to [shared_instance_product_spec.md](shared_instance_product_spec.md) (the plan) and roadmap [#246](https://github.com/nervous-rob/goobster/issues/246) (the sequence and the decisions). This is the handoff note: what has shipped, which seams the next steps hook into, and exactly where the next session picks up. Update the **Where things stand** table and the date as items land; delete a step's brief once its issue closes.

**Last updated:** 2026-09-23, after [PR #277](https://github.com/nervous-rob/goobster/pull/277) (#256) merged on top of [PR #276](https://github.com/nervous-rob/goobster/pull/276) (#249) and [PR #275](https://github.com/nervous-rob/goobster/pull/275) (#262).

## Where things stand

| Roadmap item | Status | What is left |
|---|---|---|
| #262 Name and license | **Shipped** ([ADR 0012](adr/0012-name-and-license.md), PR #275) | Trademark and domain search before any public listing (#259 depends on it). |
| #249 Backup and tested restore | **Shipped** (PR #276, [backup_and_restore.md](backup_and_restore.md)) | The **dated recovery test on the actual host** (runbook §"The recovery test"). Record the date and result on #249. |
| #256 work_failures, resource_events, operator_audit | **Shipped** (PR #277, [work_ledger.md](work_ledger.md)) | Nothing. `usage_reservations` exists as a table; its writer is #248. |
| #247 Shared-instance safety | **Shipped** (PR #274, [shared_instance_safety.md](shared_instance_safety.md)) | The **strong-isolation canary on the actual host**, run as the production execution service. Required before a second account. |
| #248 Token budgets | **Not started.** Table and erasure path exist (from #256). | The reservation writer, the cap policy, the Host-room limit controls, `limits.change` audit rows. Brief below. |
| #265 Private single-user pilot | **Not started.** The measurements it needs exist (cost join, failures, support view). | The pilot plan document and the G row in the spec. Brief below. |
| #268 Deployment and privacy promise | **First pass merged** (PR #271) | The no-Discord first-operator path in the README, and the backup-retention wording now that #249 is real. |
| #255 Operator second factor, phase 1 | Specified, **required at the second account** | TOTP + recovery codes for operators; host policy gate on account creation. |
| #267 / #254 Evaluation set and research brief | Not started | Both consume the `work_id` cost join from #256; #254's "accepted" marker is what `costPerResult({ accepted })` divides by. |
| #266, #272, #273 | Not started | First-use task, tutorials batch 1, Ask Goobster on Inbox items. |

Order per #246: finish the two actual-host gates and #268's remainder while building #248's ledger writer (caps stay unset while single-user), then write the #265 pilot plan and start the brief experiment. **Nothing in stage 4 or 5 starts before the pilot has produced repeat use.**

## Seams the next steps build on

Everything below exists on `main` today. The next steps extend these; they do not add parallel mechanisms.

| Seam | Where | Used by |
|---|---|---|
| Work reference on `AsyncLocalStorage`: `{ kind, id, actor, payer }` | `packages/core/utils/workContext.js` - `run(work, fn, { replace })`, `current()` | #248 reads `payer` and `(kind, id)` for a reservation without threading ids; today `payer` defaults to the actor. Set it from the budget owner (a project's owner for project work) when #248 defines payers. |
| Model admission (concurrency, fairness, waiting) | `packages/core/services/resourceAdmissionService.js` (`run`, `acquire`), called from `aiService._admit()` around every `chat()` / `generateText()` | #248 wraps this: reserve budget → admit → call → settle → release. `_admit` is the one place to do it. |
| Per-payer serialization rows | `admission_locks` (`resource TEXT PRIMARY KEY`); `resourceAdmissionService` already takes a row lock with `INSERT ... ON CONFLICT DO NOTHING` then `UPDATE ... SET resource = resource` | #248 uses resource `budget:<payer>` (build the string in JS). `privacyService.forgetUser` already deletes that row. |
| Token counts from the provider | Each provider's `_logUsage(response, model, usageContext)` → `services/usageTracker.log({ inputTokens, outputTokens, ... })` → `usage_log` | #248's settlement needs the same numbers; return them from the provider call (or have `usageTracker.log` also settle the open reservation on the current work) rather than re-deriving. |
| The reservation table | `usage_reservations` in `db/schema.sql` (`actor`, `payer`, `workKind`, `workId`, `admissionId`, `estimatedTokens`, `actualTokens`, `status` held/settled/released, `idempotencyKey` UNIQUE, `expiresAt`, `createdAt`; indexes on `(payer, createdAt)` and `(workKind, workId)`) | #248 writes it. `costReportService` already reads it (settled → `actualTokens`, held → `estimatedTokens`). |
| Cost per accepted result | `packages/core/services/costReportService.js` - `workCosts(filter)`, `costPerResult({ workKind, payer, days, accepted })` | #265 measures with it; #254's accepted briefs are its divisor. Returns zeros for tokens until #248 writes reservations. |
| Failures and resources per person / per account | `workFailureService`, `resourceEventService`, `accountSupportService.view()`; routes `GET /api/app/usage/diagnostics`, `GET /api/app/admin/accounts/:id/support` | #265's "failures you hit"; #248's Host-room limit panel sits next to the support view. |
| Operator audit | `packages/core/services/operatorAuditService.js`; `ACTIONS` already reserves **`limits.change`**; Host room *Operator audit* panel | #248's cap changes and #255's factor resets write here. Add new actions to `ACTIONS` in the same change. |
| Ledger retention | `packages/core/services/ledgerRetentionService.js` (coreRuntime step `ledgerRetention`, lock `ledger_retention`; 30 / 90 / 365 days) | #248 adds its own prune of `usage_reservations` here (expired `held` rows; settled rows past the window - 90 days proposed, the open point on #246). |
| Instance pause and resume | `services/instanceStateService.js`, Host room *Instance* panel | Unchanged; the recovery test exercises it. |
| Host room | `apps/web/src/rooms/HostRoom.tsx` (panels: Instance, Sign-up & mail, Invitations, Accounts + Support, Operator audit, Migration report); admin routes in `packages/core/web/routes/admin.js` behind `[requireAuth, requireOperator]` | #248 adds a *Limits* panel and route; #255 adds the second-factor policy switch. Every mutating route writes an audit row after success. |

## Step 1 - #248 Token budgets on `usage_reservations`

Design is decided on the issue; this is the implementation map against the code as it stands.

**Build now, cap unset.** A missing cap skips the count and inserts directly (single-user unlimited). The daily cap becomes required when a second account is created (#265).

1. **Service** `packages/core/services/usageBudgetService.js` (new):
   - `reserve({ payer, actor, work, estimatedTokens, admissionId, idempotencyKey, windowStart, cap })` → row id or throws `BudgetError(429, 'BUDGET_EXCEEDED')`. Inside one `db.transaction`: lock `budget:<payer>` via `admission_locks` exactly as `resourceAdmissionService` does; `SELECT COALESCE(SUM(CASE status WHEN 'held' THEN estimatedTokens WHEN 'settled' THEN actualTokens ELSE 0 END), 0)` over `payer = @payer AND createdAt >= @windowStart`; refuse or insert. **Never hold the transaction across a model call or network I/O.** Compute `windowStart` as UTC text in JS and bind it (the dialect rewrites only literal `datetime('now', ...)` modifiers).
   - `settle(id, { actualTokens })`, `release(id)`; both conditional updates on `status = 'held'`.
   - `usedInWindow(payer, windowStart)` for the panel and `/me`.
   - `prune({ now })`: drop `held` rows past `expiresAt` (release, do not settle) and settled rows past the retention window. Register it in `ledgerRetentionService.sweep()`.
   - Uncertain outcome (abort after the request was sent, timeout) settles **at the estimate** and sets a reconciliation flag - #274's rule that uncertain paid outcomes are never auto-retried. Column to add: `reconcile INTEGER NOT NULL DEFAULT 0` (or a `status` value; pick one and document it in work_ledger.md).
2. **Hook** in `aiService._admit()`: reserve (estimate from the prompt token count, `utils/aiTokenBudget.js` already sizes visible-reply budgets) → `resourceAdmissionService.run` → provider call → settle from the provider's usage → release admission. Admission refused / timed out / cancelled → `release()`. Streaming turns settle when the stream ends. Payer comes from `workContext.current()?.payer` with the actor as fallback; a project's work should set `payer` to the project owner when the context is opened (`projectService._startJobLoop`, `spitballExpeditionRunner`).
3. **Config** `packages/core/config/limitsConfig.js` (new): `limits.dailyTokens` per account (null = unset), `limits.windowHours` (24). Read env → `config.json` → default like the other config modules. Host-editable value lives in `instance_state` (key `limits`) so the Host room can change it without a restart; the config value is the floor for a fresh install.
4. **Routes** in `routes/admin.js`: `GET /api/app/admin/limits` (cap, window, per-account used totals) and `PATCH /api/app/admin/limits` → `audit(req, 'limits.change', null, { dailyTokens, windowHours })`. Refuse creating a second account (`POST /api/app/admin/accounts`, invitation redemption in `nativeAuthService`) while `identity.requireAccount` is on, more than one account would exist and no cap is set - that is the #265 trigger. Expose the person's own usage against the cap on `GET /api/app/me` (`me.limits`) and in the Usage room next to *Other resources*.
5. **Errors surface, never crash:** `BUDGET_EXCEEDED` is a `429` on the web routes with the reset time; in chat it is a normal reply through `guaranteedResponse`, and it writes a `work_failures` row (`code BUDGET_EXCEEDED`, phase `reserve`) so the support view shows who is hitting the cap.
6. **Erasure** is already done for the table (`privacyService.forgetUser` deletes the person's paid rows and the `budget:` lock, nulls them as actor elsewhere). Extend `buildUserReport` if you add columns.
7. **Tests** `tests/usageBudgets.test.js` (group `core` in `tests/ciGroups.js`), both engines: two concurrent reservations for one payer serialize and the second sees the first (spawn with `Promise.all`); different payers do not block; an unset cap inserts without counting; the idempotency key refuses a double hold; settle writes `actualTokens` and the window sum switches from estimate to actual; release on admission refusal; uncertain outcome settles at the estimate and flags; expired holds are pruned; the cost join now returns real `actualTokens` for a seeded turn; the audit row for a cap change; the second-account refusal without a cap; `/me` shows the cap. Run with `GOOBSTER_DB_URL=... GOOBSTER_PG_TEST_ISOLATE=1 npx jest tests/usageBudgets.test.js` as well as on SQLite.
8. **Docs:** a "Budgets" section in `work_ledger.md` (replace the "writer lands with #248" sentences), the *Limits and cost* bullets in `development_standards_and_project_goals.md` (§ The work ledger), the spec's status table, `configuration_guide.md` for the new keys. Close the open point on #246 (settled-row retention) by writing the number down.

## Step 2 - #265 The pilot plan

The issue asks for a short plan in `documentation/`. Suggested file: `documentation/pilot_plan.md` (`kind: guide`). Everything it measures already has a source; fill in the owner's choices.

| Section | Content | Source today |
|---|---|---|
| The task | One topic to follow weekly; see what changed; check the evidence; produce a brief you use. | Owner's choice. |
| Duration and cadence | e.g. six weekly cycles, with a dated entry per cycle. | Owner's choice. |
| Criteria | Repeat use (briefs produced, topics revisited); time saved after verification; brief quality against #267's bar; cost per accepted result; failures hit; would you pay. | — |
| Cost per accepted result | `costReportService.costPerResult({ workKind: 'expedition', days: 7, accepted: [...ids] })` per cycle. | Tokens are zero until #248 writes reservations; resource events (search calls, retries) are real now. Until #254 exists, "accepted" is a list of expedition ids the owner writes into the plan by hand. |
| Failures | Usage room → *What went wrong*, or `accountSupportService.view({ principalId })`. | Live now. |
| Exit decision | Continue single-user / open a second account (then #247 host canary, #248 daily cap, #255 phase 1 become required) / change direction. | — |

Record each cycle in the same file and update the G row in the spec's implementation-status table when the plan is written and again at the exit decision. A tiny script under `scripts/` that prints the week's `costPerResult` and failure summary for the owner's account would remove most of the friction; it is optional.

## Step 3 - The two actual-host gates

Both are runbook steps, not code. Neither can be satisfied from CI or a developer VM.

- **#249 recovery test.** On the host: `npm run backup -- --out <protected dir>`, then restore into a fresh installation per [backup_and_restore.md](backup_and_restore.md) §"The recovery test", confirm the counts, sign in with a pre-backup session, resume from the Host room, and record the date, the archive name and the result on #249. Note that the restore now writes `operator_audit` rows (`instance.restore`, then `instance.resume` by the operator) - check they appear in Host → *Operator audit*.
- **#247 isolation canary.** On the host, as the production execution service user with its real mounts: `node scripts/sandbox-isolation-smoke.js`; require `bwrap blocked secret, neighbor, and host network`; verify an invited account's run still refuses a deliberately unavailable strong-isolation backend; confirm `webapp.devMode` is off and account admission is on. Record on #247 and flip D's status in the spec from "pending host verification".

Cloud/dev VMs need `bubblewrap` installed for the strong-isolation path; a shared instance (more than one `app_accounts` row) refuses the weak fallback by design.

## Step 4 - #268 The remaining promise

Two edits: lead the README setup with the standalone path (`apps/api`, `GOOBSTER_RUNTIME_MODE=standalone`, no token) and present Discord as an optional adapter; and state the backup retention window once in the privacy section (archives hold erased rows until they rotate out; only `config.json` in them is encrypted - the sentence already exists in the standards doc and `backup_and_restore.md`). `npm run docs:check` must pass; README, `independent_runtime.md` and `differentiation_strategy.md` must agree.

## What the second account unlocks (do not start early)

Creating a second account is the trigger, not a milestone to aim for. When the pilot's exit decision says "open it":

1. #247 host canary recorded (Step 3).
2. #248 daily cap set in the Host room (writes `limits.change`), and the creation refusal lifted by the cap being present.
3. #255 phase 1: TOTP + single-use recovery codes for operators, enrollment behind `REAUTH_REQUIRED`, removal bumps the session version, operator-assisted recovery written to `operator_audit` (add actions such as `account.factor_reset` to `ACTIONS`), tests in the style of `tests/nativeAuth.test.js` on both engines.

## Then: the research-brief experiment (#267, #254, #266, #272, #273)

- #254 stores the brief immutable with an edit overlay as a private Expedition artifact. Its **accept** action is the `accepted` input to `costPerResult`; give the brief the expedition's `workId` so the join needs no new column.
- #267 records per-claim marks and the edit type; the question set lives next to `tests/live/` and runs under `npm run test:live` only.
- #273 loads the Inbox item server-side into the custom-instructions slot; Inbox items already carry `source`, `link` and (for failures) `failure`.

## Working conventions the next session must keep

- Every change passes on **both engines**: `npm test` (SQLite) and `npm run test:postgres` after `bash scripts/ensure-local-postgres.sh`; a new `tests/*.test.js` goes into exactly one group in `tests/ciGroups.js` (`npm run test:groups:check`).
- `npm run lint` (0 errors), `npm run smoke`, `npm run typecheck:web`, `npm run build:web`, `npm run docs:check` before a PR.
- SQL in the SQLite dialect; engine forks only in `db/dialect.js`; `db.insert()` for ids; never fire-and-forget a write a later read depends on; bind UTC text, never `datetime('now', @param)`.
- A new per-user table joins `privacyService.forgetUser` / `auditUser` / `buildUserReport` in the same PR; a new scheduler registers in `coreRuntime` under `withSingletonLock`; a new operator route adds its `ACTIONS` entry and writes its audit row.
- Nothing in a ledger row is ever a prompt, reply, body, output, token, link or address.
- Ship the doc with the feature (`documentation/**`, allowed kinds: guide, reference, standards, decision, skill) and keep the spec's implementation-status table current.

## Rough edges noticed while shipping #256

- `ledgerRetentionService` starts with the other schedulers, so it does not sweep while the instance is paused after a restore. Harmless for a short pause; move the step next to `chatHistoryRetention` in `coreRuntime.js` if always-on retention is wanted.
- `operator_audit` action `limits.change` is reserved and unused until #248.
- `costReportService` reports `actualTokens: 0` for live work until #248; `resource_events` are real.
- The unit suites print a "worker failed to exit gracefully" warning from `musicService`'s memory-usage timer; pre-existing, not a failure.
- `sandboxService` refuses the weak isolation fallback as soon as a second `app_accounts` row exists; demos and tests that run the sandbox after creating accounts need `bwrap`.
