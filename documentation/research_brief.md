---
title: Research brief
kind: guide
summary: A private brief written once from an Expedition's stored evidence - immutable generated text, a separate edit overlay, the owner's four-part review, explicit acceptance and use, Markdown export, and measurement that never invents a cost per accepted brief.
tags: [research, brief, expeditions, evidence, pilot, privacy, export]
---

# Research brief

[#254](https://github.com/nervous-rob/goobster/issues/254) gives the [private pilot](pilot_plan.md) its finished artifact: a brief written from one finished [Expedition](spitball_expeditions.md)'s stored sources and claims, kept exactly as generated, edited only through a separate overlay, judged by the owner against [#267's four-part bar](research_evaluation.md), and exported as Markdown that says what was generated, what was edited, what is uncertain and whether the owner accepted and used it.

A brief is **private to the person who created the expedition**. Nothing infers quality from an empty review, nothing infers acceptance from a finished generation, and nothing prices a brief.

## Where it lives

- Portal: **Knowledge → Research → an expedition → Briefs**. *Write brief* is available once the expedition has stopped (COMPLETED, PAUSED, FAILED or CANCELLED with evidence); the brief view opens in place of the expedition and *← Expedition* returns.
- Table: `expedition_briefs` in `packages/core/db/schema.sql`, one row per attempt, cascading with `spitball_expeditions`.
- Code: `packages/core/utils/expeditionBrief.js` (pure: evidence packet, prompt, parser, deterministic evidence notes, overlay rendering, quality status, Markdown), `packages/core/services/expeditionBriefService.js` (ownership, generation, storage, measurement, privacy), routes in `packages/core/web/routes/spitball.js`, client in `apps/web/src/components/ExpeditionBrief.tsx`.

The existing `utils/researchBrief.js` is a different thing: the expedition's *search plan* (`researchBriefJson`). This feature is the *written* brief.

## The generated text is written once

Generation reads the expedition's `research_sources`, `research_claims` and cycle coverage (conflicts, unresolved questions, search gaps) into an **evidence packet** - ids, text, confidence, publisher, publication and retrieval dates. No page body is fetched again. The model is asked for JSON: a summary, key findings each naming the claim ids it rests on, and limitations. Findings that cite no stored claim are kept but marked `cited: false`; claim ids the expedition does not hold are dropped.

Before storage the service adds what the evidence itself implies, without the model:

| Evidence note | When |
|---|---|
| `uncited` | a finding cites no stored claim |
| `weak_evidence` | every claim behind a finding has confidence ≤ 0.6 |
| `disagreement` | a cycle recorded a conflict |
| `missing_coverage` | unresolved questions, search gaps or uncovered units remain |
| `dated` | always: the retrieval date and the publication-date range of the cited sources, with how many carry none |

The result (`generatedJson`) is stored with a SHA-256 over its canonical form (`generatedHash`), the prompt version and the expedition's pinned model. The only write is the `GENERATING → READY` transition, guarded on status, so nothing can overwrite a READY brief. Every read recomputes the hash and reports `integrity: verified | mismatch`. To change the brief, write another one: a new row, the old one untouched.

Generation runs **inside the expedition's work reference** (`workContext.run({ kind: 'expedition', id, actor, payer })`), so its tokens settle into `usage_reservations` under the expedition's `(workKind, workId)` and [`costReportService`](work_ledger.md) needs no new column. The payer is the expedition's payer: the project owner for a project-scoped expedition, otherwise the creator (`spitballExpeditionService.payerFor`, also used by the runner).

A failed generation is kept: the row becomes `FAILED` with an `errorCode` (`BUDGET_EXCEEDED`, `CANCELLED`, `BUSY`, `ACCOUNT_DISABLED` and `BRIEF_FORMAT_INVALID` pass through; anything else is `BRIEF_GENERATION_FAILED`) and one `work_failures` row with phase `brief` - the code and a short reason, never the prompt or the answer. Failed attempts show in the list and count in the measurement.

## Edits are an overlay

The owner edits the summary, a finding or a limitation by target (`summary`, `finding:F2`, `limitation:L1`). Edits live in `overlayJson`, separate from the generated text, each with:

- `text` - the replacement passage;
- `type` - **`wording`** or **`factual`**, required (the fourth part of the quality bar reads this);
- `note` - optional, why;
- `editedAt`.

The rendered brief shows the effective text per block together with `generated` (the original), `edited` (the replacement or `null`), `editType` and `editNote`, so the client and the export can mark every edited passage and show the original beneath it. Removing an edit restores the generated text; the original never moved. Overlay writes carry `expectedRevision` against `overlayRevision` and a stale write is `409 EDIT_CONFLICT` ([`utils/editConflict.js`](../packages/core/utils/editConflict.js)), the same rule as notes.

## The owner's review

`reviewJson` records [#267's](research_evaluation.md) marks and gates, with its own `reviewRevision`:

- per finding: `supported`, `unsupported` or `missing a qualification` (unset = unreviewed), plus an optional rationale;
- three gates, each `true`, `false` or unset: *no unsupported claims*, *weak evidence labelled uncertain*, *both positions present where sources disagree*;
- the fourth part, *edits wording-only*, is **derived from the overlay**, not asked;
- free notes.

The quality status is computed on every read, never stored as a verdict:

| Status | Meaning |
|---|---|
| `unreviewed` | some finding unmarked or some gate unset. **Not a pass.** The default. |
| `not-ready` | a finding marked `unsupported` or `missing a qualification`, a gate judged `false`, or a factual edit on record |
| `ready-to-show` | every finding `supported`, every gate `true`, edits wording-only |

A finding marked `missing a qualification` stays `not-ready` until the owner has fixed it (an edit) **and** re-marked it. A factual edit is a factual correction: the brief may still be useful and accepted, but it fails the bar.

## Acceptance and use are separate records

`acceptedAt` and `usedAt` (+ `useNote`) are explicit actions in the brief view, each reversible. Neither is implied by a READY status, by a `ready-to-show` quality, or by each other. The pilot's *useful after verification* is acceptance; its *repeat use* is `usedAt`. An accepted brief is the divisor of the cost measurement below.

## Markdown export

`GET /api/app/spitball/briefs/:briefId/export.md` (`?download=1` for an attachment; `Cache-Control: private, no-store`) writes:

1. title, expedition, brief id, lens, generation time, model, intent;
2. **Review status**, **Accepted**, **Used**, **Edits** - stated explicitly, `unreviewed` spelled out as "not a quality pass";
3. summary and numbered findings with inline `[n]` citations, `_(no stored claim cited)_` where applicable and the owner's mark;
4. every edited passage marked `✎ Edited (wording|factual) — note` with the original generated text quoted beneath;
5. limitations (model-stated) and the evidence notes (derived);
6. sources `[n]`: claim text, claim id, confidence, title, publisher, publication date or "no publication date", retrieval date, URL;
7. the review table, the four parts as yes/no/unreviewed, notes;
8. the generated-text hash and the statement that edits live apart from it.

Share links, templates and scheduled briefs are deliberately not part of #254.

## Private artifact

Every read, generation, edit, review, acceptance, use, export and measurement resolves the expedition through the owner-only `spitballExpeditionService.getExpedition(id, { userId })` **and** re-checks `expedition_briefs.userId`. Anyone else - a stranger, the owner of the project the expedition was run in, another project member - gets `404 NOT_FOUND`; an id alone grants nothing. A project owner pays for a member's brief without gaining access to it.

Privacy paths ([`privacyService`](../packages/core/services/privacyService.js)):

- **erasure** (`/forget-me`): the person's briefs are deleted in the main transaction (they also cascade with their expeditions); briefs someone else owns that this person paid for keep the row with `payer` nulled, as `resource_events` do;
- **audit**: `expedition_briefs` counts rows where the person is owner or payer;
- **transparency report**: `spitball.briefs { total, accepted, used, failed, edited, paidForOthers }`.

## Measurement for the pilot

`GET /api/app/spitball/briefs/measure?days=30` (`expeditionBriefService.measure`) returns, for the caller's own briefs in the window:

- `briefs`: total, ready, failed, generating, **accepted**, **used**, acceptedAndUsed, edit type per brief (none / wording / factual) and quality status per brief;
- `cost`: expedition-level totals from `costReportService.workCosts({ workKind: 'expedition' })` restricted to the expeditions that have a brief in the window - settled `actualTokens`, held `estimatedTokens`, `resources` by kind, `failures` (research cycles and every brief attempt, failed ones included);
- `cost.status`: `settled`, `provisional` (a held reservation or a `reconcile = 1` settlement is in the join - the flag is kept, not smoothed) or `unavailable` (no reservation recorded);
- `cost.perAccepted`: totals divided by accepted briefs, **`null` when nothing was accepted or no cost was recorded** - never `0`; the `note` says which.

Tokens and resource quantities are separate units. There is no price anywhere in the response. The [pilot plan](pilot_plan.md) still records drafting-chat costs and time by hand; this covers the expedition and its briefs.

## API

| Method and path | Body | Result |
|---|---|---|
| `GET /api/app/spitball/expeditions/:id/briefs` | | `{ briefs: [summary] }` |
| `POST /api/app/spitball/expeditions/:id/briefs` | | the brief detail (READY or FAILED); `409 EXPEDITION_ACTIVE`, `409 NO_EVIDENCE` |
| `GET /api/app/spitball/briefs/:briefId` | | `{ brief, generated, overlay, review, rendered, quality, integrity }` |
| `PUT /api/app/spitball/briefs/:briefId/overlay` | `{ edits: [{ target, text, type, note? }], expectedRevision }` | detail; `409 EDIT_CONFLICT`, `409 NOT_READY`, `400 BAD_OVERLAY` |
| `PUT /api/app/spitball/briefs/:briefId/review` | `{ marks, rationale?, gates, notes?, expectedRevision }` | detail; `400 BAD_REVIEW` |
| `POST /api/app/spitball/briefs/:briefId/accept` | `{ accepted }` | detail |
| `POST /api/app/spitball/briefs/:briefId/use` | `{ used, note? }` | detail |
| `GET /api/app/spitball/briefs/:briefId/export.md` | `?download=1` | `text/markdown` |
| `GET /api/app/spitball/briefs/measure` | `?days=` | the measurement above |

Errors follow the Spitball contract (`{ error: { code, message } }`).

## Tests

- `tests/expeditionBrief.test.js` (group `knowledge`, both engines): normalization and quality rules; generation under the expedition work reference with the model pin and the stored claim ids in the prompt; phantom claim ids dropped and the evidence notes derived; overlay round-trip with wording/factual marking and the generated text and hash unchanged; `EDIT_CONFLICT`; the integrity mismatch on a tampered row; a second brief as a new row; the running/no-evidence refusals; unreviewed → not-ready → ready-to-show with `missing a qualification` kept not-ready; acceptance and use separate and reversible; the Markdown export's citations, limitations, edited markers with originals, and explicit status (and an unreviewed export saying so); the stranger, project owner and project member refused with 404 on every route while the creator reads; the project owner as payer; the FAILED row and the `work_failures` `brief` row without marker text, the passthrough codes and the format failure; the measurement's `null` per-accepted, failed attempts counted, provisional flag kept, no price; erasure, payer anonymization, report, audit and the expedition cascade.
- `e2e/researchBrief.spec.js`: the browser journey against the real routes with a fake model - write, read with citation and limitations, wording edit shown with the original, the four-part review, accept, export, the list, and a second account that gets nothing.

## What #254 does not claim

Implemented is not merged; a green CI is not the owner-judged research-quality baseline (#267) and not a pilot result (#265). The pilot's exit decision, the actual-host restore drill (#249) and the host isolation canary (#247) remain owner and host tasks.
