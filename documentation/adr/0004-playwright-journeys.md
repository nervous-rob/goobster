# ADR 0004: Journey tests — API first, Playwright next

## Status

Accepted. Playwright increment landed.

## Context

The review asked for Playwright coverage of three complete loops:

1. Expedition → claims → notes → evidence
2. Collaborator → project Parlor → actor-bound tool → project knowledge
3. Project job → artifact → trigger → Attention notice

Those loops are the product. They already have deep Jest coverage at the
service and HTTP layers (`spitballResearchPipeline`, `projectParlor`,
`projectCollaboration`, `projectKnowledge`, `projectTriggerService`,
`attentionService`, `spitballAttention`). What was missing is a *stitched*
journey that reads like the review, and a browser-level proof that the
React rooms stay wired.

## Decision

**Service journeys** live in `tests/cognitiveLoopJourneys.test.js` and run
in the existing `npm test` matrix on both engines. Expedition and trigger
journeys drive the real runner / settle path with fake AI / search.

**Browser journeys** live in `e2e/` and run with `npm run test:e2e`
(Playwright + Chromium). They mount `createWebAppApp` /
`createWebAppContext` in `webapp.devMode` against a throwaway SQLite file
(`e2e/server.js`) and click the React rooms. They prove wiring, not
service internals: fixtures are seeded, then the specs log in through the
dev-session form and walk Spitball, Parlor, Observatory, and Noticed.

Jest is restricted to `tests/*.test.js` so `e2e/*.spec.js` never join
`npm test`. Chromium is installed in the `test (playwright)` CI job
(`npx playwright install --with-deps chromium`); it is not a merge
blocker on `both engines` (that aggregator remains the dual-DB gate —
see ADR 0006).

## Consequences

The distinctive loops are proven at both layers. Adding a room or
breaking a tab's fetch now fails a browser spec without re-running the
pipeline. Operators who want Playwright required on `main` can add
`test (playwright)` to the GitHub ruleset independently of the engine
gate.

Since ADR 0007's shard amendment the journeys run as parallel jobs
(`test (playwright, n/5)`), each with its own server and throwaway
database, and `test (playwright)` is the job that waits on all of them.
`npm run test:e2e` still runs everything in one process. A spec file must
not depend on state left by another spec file.

The journeys of one shard share one `e2e/server.js`. On the push that
merged #415 a journey timed out, its retry seeded the same project fixture
again, the fixture route rejected with `DUPLICATE_PROJECT`, the unhandled
rejection ended the server, and the 158 journeys after it failed with a
refused connection. Fixture routes now pass a rejection to Express and the
project fixtures reuse the project of an earlier attempt
(`e2e/harness.spec.js`).
