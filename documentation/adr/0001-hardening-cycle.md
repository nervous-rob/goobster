# ADR 0001: Hardening cycle after the PR #200 review

## Status

Accepted (second increment in progress). PR #201 merged the first
increment. Remaining work is release gates, quieter CI, real journey
transitions, and an honest ADR 0002.

## Context

A review of `main` through PR #200 described Goobster as a self-hosted AI
workspace whose distinctive product is the closed loop

`Study / Parlor → Observatory Projects → Spitball → Attention → conversation`

and recommended pausing large feature work for one hardening cycle. This
record evaluates each recommendation against the tree at `#200`
(`95018db`) and says what this cycle will and will not do.

## Decision

Treat the review as a product and architecture brief, not a punch list to
execute blindly. Accept the diagnosis (velocity is outrunning observability).
Sequence work so we can *see* the architecture before we add another wing.

## Recommendation audit

| Recommendation | Verdict | Why |
| --- | --- | --- |
| Gravity wells (`toolsRegistry` 3677, `appApi` 2623, `parlorService` 2845, `projectService` 2812) | **Confirmed.** Split by capability / route domain before the next subsystem. | Line counts match. These files are coordination bottlenecks for agents and humans. |
| Green CI is noisier than it should be (worker force-exit, late logs, PG teardown chatter) | **Plausible and worth fixing.** Reproduce on both engines; do not assume production defects. | Jest has no `forceExit` on the unit config. Leaked handles are consistent with LISTEN clients and module-level timers surviving `db.closeConnection()`. PG teardown warnings are consistent with leftover connections during `DROP SCHEMA`. |
| CI runs `npm test`, not `test:coverage`; 80% threshold excludes services / router / React | **Confirmed.** | `package.json` `collectCoverageFrom` is only `packages/core/utils/**` and `apps/bot/commands/**`. Expanding the threshold to the gravity wells in this cycle would fail CI without a coverage campaign. Keep the existing gate; do not pretend it covers the new architecture. |
| Require both DB jobs on `main`; verify production `GOOBSTER_REQUIRE_CI=true` | **Correct as an operator action.** Cannot be enforced from this repository alone. | Branch protection is a GitHub ruleset. Deploy gating already exists (`scripts/auto-update.sh`) and defaults to **off**. This cycle documents the required settings; a human must flip them. |
| `ProjectChatDock` duplicates Parlor message types / colors / glyphs / rendering | **Confirmed.** | Spec says the dock reuses Parlor components; the dock reimplements them. Extract a shared conversation view. |
| README undersells Projects / Attention / Expeditions; `package.json` is still “Discord bot with adventure capabilities” and ISC vs MIT | **Confirmed.** | `LICENSE` is MIT; every `package.json` says ISC. README leads with feature bullets and barely names the loop. |
| Playwright for three complete journeys | **Accepted as the destination; not the first proof.** | The three loops already have deep service/API coverage. Browser journeys need Playwright + Chromium in CI and the Cloud Agent environment. This cycle adds headless *API* journeys that stitch the same loops, and records the Playwright follow-up. |
| Convert remaining design questions into issues or short ADRs; tracker is empty | **Accepted as ADRs.** | This agent’s GitHub token is read-only, so issues cannot be filed from here. Open questions become ADRs in `documentation/adr/`. |

## What this cycle does

1. Quiet the Jest lifecycle on SQLite and Postgres (close LISTEN clients and
   event buses, unref module timers, stop warning on expected teardown).
2. Modularize the four gravity wells by capability / route domain. Public
   require paths (`@goobster/core/web/appApi`, `@goobster/core/utils/toolsRegistry`,
   the service singletons) stay stable.
3. Extract `ParlorConversationView` / shared parlor message rendering.
4. Rewrite the README around the cognitive loop; align licenses to MIT.
5. Add API-level journey tests for the three loops the review named.
6. Record operator actions (branch protection, `GOOBSTER_REQUIRE_CI`) and
   remaining design questions as ADRs.

## Second increment (after PR #201)

1. Stop exception-driven Postgres schema bootstrap (strip REFERENCES,
   create tables, ADD CONSTRAINT).
2. Log provider availability once at process start
   (`config/reportIntegrations.js`); constructors stay silent.
3. Drive the real expedition runner and Observatory settle path in the
   journey tests (fake AI / search / follow-up `run` only).
4. Add a `both engines` CI aggregator and a GitHub-remote WARN when
   `GOOBSTER_REQUIRE_CI` is still false. Mark ADR 0002 partially
   implemented. Record the remaining operator gates in ADR 0006.

## What this cycle does not do

- Expand coverage thresholds to services / `appApi` / the React client.
- Enable GitHub rulesets or change production deploy config.
- Add Playwright browsers to CI or the Cloud Agent environment (see
  `0004-playwright-journeys.md`).
- File GitHub issues (read-only token). ADRs are the durable record.

## Consequences

Agents and humans gain smaller edit surfaces and quieter CI logs. Operator
gates remain a human step. Playwright UI journeys remain the next
observability increment after this cycle’s API proofs.
