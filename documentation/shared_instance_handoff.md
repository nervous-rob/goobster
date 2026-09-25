---
title: Shared-instance roadmap - handoff and next steps
kind: reference
summary: Where roadmap #246 stands after token budgets shipped in PR 279, the proposed private pilot, the remaining actual-host gates, and the next research-quality and brief work.
tags: [roadmap, handoff, shared-instance, limits, pilot, operations]
---

# Shared-instance roadmap: handoff and next steps

Companion to [shared_instance_product_spec.md](shared_instance_product_spec.md) (the plan) and roadmap [#246](https://github.com/nervous-rob/goobster/issues/246) (the sequence and the decisions). This is the handoff note: what has shipped, which seams the next steps hook into, and exactly where the next session picks up. Update the **Where things stand** table and the date as items land; delete a step's brief once its issue closes.

**Last updated:** 2026-09-23, after [PR #279](https://github.com/nervous-rob/goobster/pull/279) shipped #248 with both-engine and browser CI green, PR #280 shipped the #265 pilot plan and #268 setup/privacy documentation, and [PR #281](https://github.com/nervous-rob/goobster/pull/281) merged the #267 fixed-evidence evaluation harness (the owner-judged baseline is still outstanding). This continuation implements **#254's research brief** on a branch; it is implemented, not merged, and CI is not the quality baseline. The pilot and actual-host checks have not been run here.

## Where things stand

| Roadmap item | Status | What is left |
|---|---|---|
| #262 Name and license | **Shipped** ([ADR 0012](adr/0012-name-and-license.md), PR #275) | Trademark and domain search before any public listing (#259 depends on it). |
| #249 Backup and tested restore | **Shipped** (PR #276, [backup_and_restore.md](backup_and_restore.md)) | The **dated recovery test on the actual host** (runbook §"The recovery test"). Record the date and result on #249. |
| #256 work_failures, resource_events, operator_audit | **Shipped** (PR #277, [work_ledger.md](work_ledger.md)) | Nothing. #248 now supplies the reservation writer. |
| #247 Shared-instance safety | **Shipped** (PR #274, [shared_instance_safety.md](shared_instance_safety.md)) | The **strong-isolation canary on the actual host**, run as the production execution service. Required before a second account. |
| #248 Token budgets | **Shipped** (PR #279, [work_ledger.md](work_ledger.md#budgets)). | Retention is 90 days by default, host-editable. Caps stay unset while single-user unless deliberately enabled. |
| #265 Private single-user pilot | **Plan written; execution not started.** [pilot_plan.md](pilot_plan.md), with proposed six weekly cycles. | Owner chooses the topic, dates and thresholds, records the host restore drill, then records cycles and an exit decision. Keep the issue open. |
| #268 Deployment and privacy promise | **Shipped** (PR #280). | README leads with standalone/native-operator setup; runtime and strategy agree. Backup rotation is explicitly host-managed, with no automatic expiry. |
| #255 Operator second factor, phase 1 | Specified, **required at the second account** | TOTP + recovery codes for operators; host policy gate on account creation. |
| #267 Evaluation set | **Harness merged (PR #281); owner baseline not run.** [research_evaluation.md](research_evaluation.md): 30 fictional fixed-evidence questions, opt-in live generation, separate owner review and work-ledger costs. | Run the selected provider and have the owner judge all 30 cases. This does not measure live source discovery. |
| #254 Research brief | **Implemented on a branch; PR open, not merged.** [research_brief.md](research_brief.md): `expedition_briefs` (write-once generated text + hash, edit overlay, review, acceptance, use), Briefs section and brief view under Knowledge → Research, Markdown export, the pilot measurement read, both-engine and browser specs. | Review and merge after CI. Then the pilot writes real briefs; an unreviewed brief is never a quality pass, and CI proves machinery only. Share links, templates and scheduled briefs deliberately deferred. |
| #266 | Implemented; human acceptance pending | Provider-free first research task, explicit Keep, sample acceptance/export, pause/resume/reset. Five observed first sessions still required. |
| #272 | First two slices implemented | Back, fixed-signal feedback and Research v2 in #285; next slice adds Projects basics, Plans, Runs, Inbox and Scheduled v2 previews. Memory, Settings, Usage and Host remain in batch 1; later batches pending. |
| #273 | Not started | Ask Goobster on Inbox items. |

Order per #246: confirm the pilot choices and record the actual-host restore drill before cycle 1. The evaluation harness is merged and #254's brief artifact is implemented awaiting review; the owner runs and judges #267's baseline and then uses the brief in pilot cycles. The next engineering candidates are #266, #272 and #273. The host-isolation check and #255 remain required before a second account. **Nothing in stage 4 or 5 starts before the pilot has produced repeat use.**

## Seams the next steps build on

Everything below exists on `main` today. The next steps extend these; they do not add parallel mechanisms.

| Seam | Where | Used by |
|---|---|---|
| Work reference on `AsyncLocalStorage`: `{ kind, id, actor, payer }` | `packages/core/utils/workContext.js` - `run(work, fn, { replace })`, `current()` | #248 reads the work and payer directly. Jobs and project expeditions use the project owner; other work defaults to its actor. |
| Model admission (concurrency, fairness, waiting) | `packages/core/services/resourceAdmissionService.js` (`run`, `acquire`), called from `aiService._admit()` around every `chat()` / `generateText()` | #248 wraps this: reserve budget → admit → call → settle → release. `_admit` is the single hook. |
| Per-payer serialization rows | `admission_locks` (`resource TEXT PRIMARY KEY`); `resourceAdmissionService` already takes a row lock with `INSERT ... ON CONFLICT DO NOTHING` then `UPDATE ... SET resource = resource` | #248 uses resource `budget:<payer>` (build the string in JS). `privacyService.forgetUser` already deletes that row. |
| Token counts from the provider | Each provider's `_logUsage(response, model, usageContext)` → `services/usageTracker.log({ inputTokens, outputTokens, ... })` → `usage_log` | `usageTracker.log` captures normalized usage in the active provider-call scope; the budget wrapper settles when that call ends. |
| The reservation table | `usage_reservations` in `db/schema.sql` (`actor`, `payer`, `workKind`, `workId`, `admissionId`, `estimatedTokens`, `actualTokens`, `status` held/settled/released, `idempotencyKey` UNIQUE, `expiresAt`, `createdAt`; indexes on `(payer, createdAt)` and `(workKind, workId)`) | #248 writes it. `costReportService` already reads it (settled → `actualTokens`, held → `estimatedTokens`). |
| Cost per accepted result | `packages/core/services/costReportService.js` - `workCosts(filter)`, `costPerResult({ workKind, payer, days, accepted })` | #265 measures with it; #254's accepted briefs are its divisor (`expeditionBriefService.measure`, `GET /api/app/spitball/briefs/measure`, `perAccepted: null` with nothing accepted). Settled rows now carry tokens; flagged settlements remain provisional estimates. |
| Failures and resources per person / per account | `workFailureService`, `resourceEventService`, `accountSupportService.view()`; routes `GET /api/app/usage/diagnostics`, `GET /api/app/admin/accounts/:id/support` | #265's "failures you hit"; #248's Host-room limit panel sits next to the support view. |
| Operator audit | `packages/core/services/operatorAuditService.js`; `ACTIONS` already reserves **`limits.change`**; Host room *Operator audit* panel | #248's cap changes and #255's factor resets write here. Add new actions to `ACTIONS` in the same change. |
| Ledger retention | `packages/core/services/ledgerRetentionService.js` (coreRuntime step `ledgerRetention`, lock `ledger_retention`; 30 / 90 / 365 days) | #248 now releases expired holds and removes terminal reservations after 90 days by default (host-editable). |
| Instance pause and resume | `services/instanceStateService.js`, Host room *Instance* panel | Unchanged; the recovery test exercises it. |
| Host room | `apps/web/src/rooms/HostRoom.tsx` (panels: Instance, Sign-up & mail, Invitations, Accounts + Support, Operator audit, Migration report); admin routes in `packages/core/web/routes/admin.js` behind `[requireAuth, requireOperator]` | #248 adds a *Limits* panel and route; #255 adds the second-factor policy switch. Every mutating route writes an audit row after success. |

## Step 1 - Run the #265 plan; build the evaluation set

The [pilot plan](pilot_plan.md) now defines the proposed task, six weekly cycles, owner-judged quality bar, time/cost/failure measurements, a cycle record and the exit decision. Its topic, dates and numerical thresholds are proposals. No results or owner acceptance are implied.

Keep private drafts, sources and ids in private notes or project files; only publish a non-sensitive summary in the plan. Capture failures weekly because their retention is 30 days. Expedition costs are only one component: include drafting chat and other attempts, preserve uncertainty flags, and use accepted briefs as the denominator.

#267 now has the [fixed-evidence evaluation harness](research_evaluation.md): 30 questions across six categories, optional credential-gated generation through `npm run test:live -- --research-evaluation`, owner worksheets and cost snapshots. Unit/CI success checks machinery only. Run and judge the full baseline before claiming a research-quality result; source discovery and real Expedition retrieval remain outside this first baseline.

**#254 is implemented** ([research_brief.md](research_brief.md)): the original generated brief is a private Expedition artifact written once and hash-verified, edits are a separate overlay marked wording/factual, citations and evidence-derived limitations are shown, Markdown export marks edited text and states the review, acceptance and use status, and the measurement read supplies #265's accepted-brief divisor. It reuses #267's marks and four-part bar and never infers quality from an empty review. Until the PR merges, the pilot can keep manual drafts.

Update the G row again when the owner records the exit decision. No stage 4 or 5 work before repeat use.

## Step 2 - The two actual-host gates

Both are runbook steps, not code. Neither can be satisfied from CI or a developer VM.

- **#249 recovery test.** On the host: `npm run backup -- --out <protected dir>`, then restore into a fresh installation per [backup_and_restore.md](backup_and_restore.md) §"The recovery test", confirm the counts, sign in with a pre-backup session, resume from the Host room, and record the date, the archive name and the result on #249. Note that the restore now writes `operator_audit` rows (`instance.restore`, then `instance.resume` by the operator) - check they appear in Host → *Operator audit*.
- **#247 isolation canary.** On the host, as the production execution service user with its real mounts: `node scripts/sandbox-isolation-smoke.js`; require `bwrap blocked secret, neighbor, and host network`; verify an invited account's run still refuses a deliberately unavailable strong-isolation backend; confirm `webapp.devMode` is off and account admission is on. Record on #247 and flip D's status in the spec from "pending host verification".

Cloud/dev VMs need `bubblewrap` installed for the strong-isolation path; a shared instance (more than one `app_accounts` row) refuses the weak fallback by design.

## What the second account unlocks (do not start early)

Creating a second account is the trigger, not a milestone to aim for. When the pilot's exit decision says "open it":

1. #247 host canary recorded (Step 2).
2. #248 daily cap set in the Host room (writes `limits.change`), and the creation refusal lifted by the cap being present.
3. #255 phase 1: TOTP + single-use recovery codes for operators, enrollment behind `REAUTH_REQUIRED`, removal bumps the session version, operator-assisted recovery written to `operator_audit` (add actions such as `account.factor_reset` to `ACTIONS`), tests in the style of `tests/nativeAuth.test.js` on both engines.

## Then: the research-brief experiment (#267, #254, #266, #272, #273)

- #254 (implemented, pending merge) stores the brief immutable with an edit overlay as a private Expedition artifact. Its **accept** action is the `accepted` input to the cost join; generation runs inside the expedition's work reference, so the join needed no new column.
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
- `operator_audit` action `limits.change` now records successful Host limit changes.
- `costReportService` now reads settled token reservations for live model work; uncertain counts carry `reconcile = 1`.
- The unit suites print a "worker failed to exit gracefully" warning from `musicService`'s memory-usage timer; pre-existing, not a failure.
- `sandboxService` refuses the weak isolation fallback as soon as a second `app_accounts` row exists; demos and tests that run the sandbox after creating accounts need `bwrap`.
