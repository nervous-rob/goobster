---
title: Private single-user pilot plan
kind: guide
summary: A proposed six-week experiment for the owner to follow one topic, verify changes and use a brief, with weekly measurements, an acceptance bar and an explicit exit decision. No pilot results have been recorded yet.
tags: [pilot, research, evaluation, cost, operations]
---

# Private single-user pilot

Roadmap [#265](https://github.com/nervous-rob/goobster/issues/265), increment G of the [product spec](shared_instance_product_spec.md). The instance owner is both the user and the buyer. This plan is written; the pilot has **not started**. Dates, the topic and the thresholds below are proposed choices to confirm before cycle 1, not observed results.

## Task and duration

For **six weekly cycles**, follow one bounded topic, identify what changed since the previous brief, check the evidence, and produce a short brief used for a real decision or action. Keep the same topic throughout; record a missed week rather than replacing it with an extra run later.

An optional starting topic is **changes in one data-engineering tool that could affect a pipeline you maintain**. Name the tool, the pipeline decision and the sources before starting. Another topic is equally valid if it leads to a concrete use for the brief.

| Owner's setup record | Fill before cycle 1 |
|---|---|
| Topic and boundary | One topic; what is excluded |
| Intended use | The decision or action this brief should inform |
| Evidence sources | A small starting set of primary sources; additional sources may be discovered |
| Start and weekly review time | Date, time and timezone; six review dates |
| Baseline | Minutes spent producing and checking a comparable brief manually; date and method |
| Host record | Deployed commit, database engine, model/provider choices, backup rotation and dated recovery-test result |
| Review thresholds | Adopt the defaults below or record replacements before starting |

The [actual-host recovery test](backup_and_restore.md#the-recovery-test) is the launch gate. CI is not that test. Keep the existing single account and leave the token cap unset unless deliberately opting in. Do not create a second account for the experiment.

## Weekly procedure

1. Revisit last week's brief and write the specific question for this week. In cycle 1, establish the baseline facts instead of claiming a change.
2. In **Knowledge → Research**, run a private Expedition with the topic, date window and question in its intent. Keep all attempt ids, including failed or abandoned runs. Review its sources, claims and notes. Expeditions build knowledge; they do not yet produce #254's finished brief artifact.
3. Use **Chat** to draft from that evidence, or write the brief yourself from the research. Ask for: dated changes, evidence for each material claim, uncertainty or disagreement, and the implication for the named decision. A well-evidenced “no material change” can be useful; inventing novelty cannot.
4. Open the cited sources and mark each claim `supported`, `unsupported`, or `missing a qualification`. Preserve the original draft and your final version in private notes or project files. Record whether edits were wording-only or factual. Until #254 ships, this is a manual record, with no implied Accept button or immutable artifact store.
5. Mark the brief accepted only after verification **and actual use**. Record what it informed. Rejection, no useful output and a missed week are valid outcomes. Record verification, editing and troubleshooting time as well as research time.
6. Save the weekly measurements while the ledgers are available, and answer: “Would I pay for this as it stands? What would have to change?” Compare the next cycle with this one.

## Quality and acceptance

Use [#267](https://github.com/nervous-rob/goobster/issues/267)'s owner-judged four-part bar: no unsupported claims on well-supported questions; weak evidence labelled uncertain; both positions represented where sources disagree; wording-only edits, with no factual correction needed. Date changing facts and add missing scope qualifications.

Track **useful after verification** separately from **ready to show a second person**. A corrected brief may still be useful and accepted, but it fails the latter bar. A claim marked `missing a qualification` needs correction and cannot count as wording-only. The [30-question evaluation harness](research_evaluation.md) now exists, but this manual pilot rubric does not complete its owner-judged baseline. Record “evaluation set not run” until that evidence exists.

| Measure | Weekly record | Proposed exit evidence |
|---|---|---|
| Repeat use | Topic revisited, briefs produced and briefs actually used | Revisited in at least 4 of 6 weeks; at least 3 accepted briefs |
| Time saved after verification | Baseline minutes minus all active research, verification, editing and recovery minutes; report machine wait separately | Positive net saving in at least 3 comparable cycles; label an estimated baseline as estimated |
| Quality | Per-claim marks, factual versus wording edits, four-part bar pass/fail | No unresolved unsupported claim in a shared brief; report factual corrections rather than hiding them in acceptance |
| Cost per accepted result | Settled tokens and separate resource quantities for every attempt, divided by accepted briefs | Report observed totals and a range; no invented dollar price or budget threshold |
| Failures and support effort | Failure codes, affected step, recovery, time lost; include missed outputs without ledger rows | No unresolved data-loss or scope-isolation failure; name the main repeated obstacle |
| Willingness to pay | Yes/no/unsure, reason, and an amount only if the owner chooses one | An explicit owner decision; this is not independent customer-demand evidence |

## Recording costs without overstating precision

Use the existing [work ledger](work_ledger.md). Its key is `(workKind, workId)`; SQL fields are camelCase (`actualTokens`, `workId`). Tokens, search calls, sandbox seconds and retries stay separate units. There is no dollar-pricing policy.

At the end of a cycle, with its work finished, run this from the repository root against the deployment's database. Fill in the account's principal id (Host → Accounts), the UTC interval **[from, to)** and the accepted Expedition ids. Do not put private ids or results into this public documentation.

```js
const db = require('@goobster/core/db');
const costs = require('@goobster/core/services/costReportService');
const support = require('@goobster/core/services/accountSupportService');
const payer = 'REPLACE_WITH_PRINCIPAL_ID';
const from = '2026-10-01 00:00:00'; // example UTC start; replace
const to = '2026-10-08 00:00:00';   // example UTC end; replace
const accepted = [];              // distinct ids, checked against the cycle record

(async () => {
    const report = await costs.costPerResult({ workKind: 'expedition', payer, from, to, accepted });
    const pending = await db.get(
        `SELECT COUNT(*) AS flagged FROM usage_reservations
         WHERE payer = @payer AND workKind = 'expedition'
           AND createdAt >= @from AND createdAt < @to
           AND (status = 'held' OR reconcile = 1)`, { payer, from, to });
    console.log(JSON.stringify({ report, pending, support: await support.view({ principalId: payer, days: 7 }) }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.closeConnection());
```

This gives the **Expedition component**, not the whole brief's cost. Include all failed and rejected attempts in the numerator. `accepted` supplies a denominator; the service does not validate membership or acceptance. Check the ids yourself, and do not count one brief twice if it needed several Expeditions. For a brief spanning multiple runs, sum their costs and divide by the number of accepted briefs manually.

Record any drafting chat or project-job work separately using its `workKind` and `workId` from the corresponding `workCosts` rows. Select the cycle's attempt ids before adding them; exclude unrelated account activity. If the time-window report contains other Expeditions, select the cycle's rows and recompute its totals. No accepted briefs means **N/A**, not zero cost. Calls crossing a boundary are grouped by reservation creation time; record a carryover rather than calling a partial week a complete run.

Treat costs as provisional while holds or `reconcile = 1` rows remain: uncertain settlements contain an estimate in `actualTokens`. The service's joined failure count is lifetime-per-work, while the support view is a rolling seven-day account summary. Use dated failure rows in **Usage → What went wrong** for the cycle's failure record, including failures with no reservation. Neither report is a complete provider invoice; embeddings, other unjoined work and host/support effort need separate accounting.

Capture each week promptly: failures are retained for 30 days; resource events and terminal reservations default to 90 days, with reservation retention host-editable. Waiting until the end of six weeks loses early failure details. Record any retention, model or configuration change that affects comparability.

## Cycle record and exit decision

Keep detailed results, original drafts, sources, accepted ids and the completed setup record in a **private note or private project file**. These are covered by the corresponding database/file backup sets. `documentation/` is public, is seeded into Goobster's shared self-documentation, and is not the place for private research. Add only an owner-approved, non-sensitive summary here.

| Cycle | Review date | Revisited / produced / accepted | Net minutes saved | Quality / factual edits | Tokens and resource units per accepted brief | Failures / recovery minutes | Pay? / actual use |
|---|---|---|---|---|---|---|---|
| 1–6 | Not run | — | — | — | — | — | — |

**Exit decision: not made.** After six scheduled cycles, choose one:

- **Continue single-user:** repeat use and verified benefit justify another bounded experiment. Name its duration and the one obstacle to address.
- **Open a second account:** useful repeat use is demonstrated and the owner wants to test another person's workflow. First record the #247 canary on the actual host, set #248's daily cap, and implement/enable #255 phase 1 (operator TOTP and recovery codes). The cap gate alone does not satisfy all three requirements.
- **Change direction or stop:** the task was not worth repeating, verification erased the benefit, quality remained poor, or operating effort/cost was unacceptable. Record the evidence and the next hypothesis, if any.

Update increment G in the product spec at the exit decision. Keep #265 open while its results and decision are outstanding. Next engineering work is the stage-3 research-brief experiment (#267, #254, #266, #272, #273); stage 4 or 5 only follows demonstrated repeat use.
