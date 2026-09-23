---
title: Owner-judged research evaluation
kind: guide
summary: The versioned 30-question fixed-evidence baseline, explicit live-run opt-in, isolated cost ledger, generated artifacts and owner review procedure. A successful test run is not a research-quality pass.
tags: [research, evaluation, pilot, evidence, cost, testing]
---

# Owner-judged research evaluation

[#267](https://github.com/nervous-rob/goobster/issues/267) supports the [private pilot](pilot_plan.md) and [research brief](https://github.com/nervous-rob/goobster/issues/254). The harness and question set are implemented; **no owner-judged live baseline has been recorded**.

## What this baseline measures

`tests/live/research-evaluation/questions.v1.json` contains 30 distinct questions: five each for well-supported evidence, weak evidence, conflicting sources, changing facts, inadequate evidence, and claims needing a qualification. Each question has a small, author-created **fictional evidence packet** and separate owner-review criteria. No packet is a factual claim about a real product, study or organization.

The model receives the question and evidence, never the category or expected answer criteria. It produces a structured short brief with a summary, claim-level source ids and limitations. The normal `aiService.chat` route supplies provider handling, admission, token reservations and settlement.

This tests **synthesis from fixed evidence**. It does not run an Expedition, discover sources, verify live URLs, exercise retrieval ranking, test the future brief UI, or establish performance on the owner's real pilot topic. The deterministic corpus makes an unsupported claim or missed qualification inspectable without depending on a changing website. Later, add a separately labelled live-retrieval baseline against real Expeditions; do not combine its scores with this one.

## Run it deliberately

Normal `npm test` runs only mocked harness checks. Normal `npm run test:live` keeps the evaluation skipped even if provider keys are present. Select the evaluation explicitly:

```bash
# Set OPENAI_API_KEY in your environment using your normal secret mechanism.
# Run one case first to inspect the output and measured cost.
GOOBSTER_RESEARCH_EVAL_PROVIDER=openai \
GOOBSTER_RESEARCH_EVAL_CASES=supported-01 \
npm run test:live -- --research-evaluation

# Omit the case filter for the full 30-question corpus.
GOOBSTER_RESEARCH_EVAL_PROVIDER=openai \
npm run test:live -- --research-evaluation
```

Supported choices are `openai`, `anthropic` and `gemini`, with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` respectively. The selected provider's key must be present in the environment; a key only in `config.json` does not enable the suite. Missing keys skip with a named reason. Invalid keys fail. There is no fallback to another provider. Model ids come from the existing provider configuration/registry; no benchmark model is hardcoded. `GOOBSTER_RESEARCH_EVAL=1` also enables the suite in an ordinary live run, but the flag above selects only this suite and avoids unrelated provider probes.

A full run makes up to 30 sequential model calls, requesting up to 1,800 visible output tokens each; normal reasoning headroom and input tokens are additional. Each call has a 60-second abort signal. A provider error, timeout, account refusal or cap refusal stops further cases. A malformed brief is preserved as a format failure and the remaining cases can run. The harness does not retry paid requests. Inspect actual token usage; this is not a dollar budget. Existing configured token limits still apply in the isolated ledger.

The live setup always selects a unique temporary SQLite database, including when the shell inherits `GOOBSTER_DB_URL` from a Postgres deployment. It creates a synthetic native account there and does not write evaluation content or costs into the production database. Only the cloud provider receives the fictional question/evidence. Unit tests of the harness use the regular SQLite/Postgres CI matrix with mocked providers.

## Outputs and cost interpretation

Each invocation creates a new directory under `test-results/research-evaluation/run-*` (gitignored). Files use owner-only permissions on systems that support them. The console prints the directory, never credentials. Copy a baseline you want to retain to protected storage; these test outputs and temporary databases are not part of the application's backup sets.

| File | Meaning |
|---|---|
| `manifest.json` | Corpus version/hash, prompt version, selected ids, provider/model, code commit when available, run id and requested visible output allowance. `fullCorpusSelected` describes selection, not success. |
| `<id>.started.json` | Attempt checkpoint written before the provider call; work reference and prompt hash. An existing checkpoint refuses another call for that attempt. |
| `<id>.json` | Original response, parsed brief when valid, exact evidence snapshot, execution status, work reference, joined cost and reservation uncertainty flags. The harness creates it once; preserve it unchanged. |
| `<id>.review.json` | Editable owner record: claim marks, added claims, rationales, edits, quality gates, acceptance and actual use. All judgments start unset. |
| `<id>.review.md` | Readable worksheet with the model's claims and owner-only criteria; use the JSON review as the decision record. |
| `summary.json` | Completed/failed/not-completed cases, settled token total, uncertainty flag, and deliberately unset acceptance/cost-per-accepted fields. Written at teardown; a killed process may leave only checkpoints and partial outputs. |

Evaluation requests use `workKind: 'chat'` with unique `research-eval:<run>:<case>` ids, not fabricated Expedition ids. Costs come from the same `costReportService.workCosts` join used by the application. `reconcile = 1` means a settlement contains an estimate; `costStatus: provisional` is not confirmed provider usage. Missing reservations are labelled unavailable. Resource quantities remain separate units; this fixed-evidence run performs no search or sandbox work.

A failed/uncertain attempt still contributes its incurred cost. Zero accepted results means cost per accepted result is **N/A**, never zero. After judging, divide total attempt costs by briefs actually accepted and used; report uncertain amounts separately. Do not equate a benchmark answer passing the quality bar with an accepted useful pilot brief. Compare runs only with their corpus, prompt, model and code versions stated.

## Owner review

1. Open the original output and source packet. Read **every material assertion**, including those in the summary and limitations. The model may omit assertions from its claim list; add them to `additionalClaims` and do not set `allMaterialClaimsChecked` until checked.
2. For each claim, set `mark` to `supported`, `unsupported`, or `missing a qualification`. Record the source ids and your rationale. An existing source id proves only that the citation resolves, not that it supports the claim.
3. Record edits in the review file, with original claim id, replacement text, reason and `type: wording` or `factual`. Set the overall `editType` to `none`, `wording` or `factual`. The generated response stays separate. This is a file-based review overlay, not #254's pending application artifact/overlay.
4. Apply the four-part bar for showing the brief to another person: no unsupported claims on well-supported questions; weak evidence labelled uncertain; both positions represented where sources disagree; edits wording-only (or none), with no factual correction needed. A missing scope/date/population qualification needs correction and fails the wording-only condition. Record each gate and `readyToShow` explicitly. An honest evidence-gap statement can pass when no adequate answer exists.
5. Separately record `acceptedAndUsed` and `use`. A factually corrected brief may be useful while failing the quality bar. Add reviewer, review date and notes. A blank field is unreviewed, not a pass. Do not ask another model to fill these judgments for the baseline.
6. In #267, record the run id, code commit, corpus hash, provider/model, whether all 30 cases completed, reviewed counts by category, claim-mark counts, factual-edit count and four-part-bar pass count. Include failures, incomplete cases and provisional costs. Link only artifacts you intend to make public; keep private notes elsewhere. State the resulting decision and follow-up work.

A green Jest result means the responses were returned and structurally valid. The parser detects malformed output, duplicate claim ids and unknown source ids; it does **not** verify factual support or grade research quality. The baseline remains outstanding until the owner records the review. #254 must preserve these distinctions when the brief artifact, edit overlay and export arrive.
