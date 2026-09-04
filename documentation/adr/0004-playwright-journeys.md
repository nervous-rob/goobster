# ADR 0004: Journey tests — API first, Playwright next

## Status

Accepted.

## Context

The review asked for Playwright coverage of three complete loops:

1. Expedition → claims → notes → evidence
2. Collaborator → project Parlor → actor-bound tool → project knowledge
3. Project job → artifact → trigger → Attention notice

Those loops are the product. They already have deep Jest coverage at the
service and HTTP layers (`spitballResearchPipeline`, `projectParlor`,
`projectCollaboration`, `projectKnowledge`, `projectTriggerService`,
`attentionService`, `spitballAttention`). What is missing is a *stitched*
journey that reads like the review, and a browser-level proof that the
React rooms stay wired.

Adding Playwright now also means Chromium in GitHub Actions and in the
Cursor Cloud Agent environment. That is a real environment change, not
a test file.

## Decision

**This cycle:** three headless journeys in `tests/cognitiveLoopJourneys.test.js`
against a throwaway database (no network, no Discord token). They run in
the existing `npm test` matrix on both engines.

The second increment drives the real transitions instead of seeding them:

1. Expedition → claims → notes → evidence — `SpitballExpeditionRunner` +
   `SpitballResearchPipeline` with injected fake AI / search / embeddings.
2. Collaborator → project Parlor → actor-bound tool → project knowledge —
   real parlor turn (unchanged; already used the service).
3. Project job → artifact → trigger → Attention notice — a real sandbox
   job that fails, then the Observatory `_finishJob` settle path on the
   singleton trigger service. The follow-up `run_script` hop uses a fake
   `observatory.run` so the action is the real `_runScript` without a
   second sandbox job.

**Next increment:** Playwright against `createWebAppApp` in
`webapp.devMode`, with Chromium installed in CI and the Cloud Agent
image. The three journeys above become the first specs. Do not block
hardening on browsers.

## Consequences

The distinctive loops are proven in CI today without a new runtime
dependency. Playwright remains an explicit follow-up that will require
an environment snapshot update (`npx playwright install --with-deps chromium`)
and a CI step.
