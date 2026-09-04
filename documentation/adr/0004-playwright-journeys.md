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
