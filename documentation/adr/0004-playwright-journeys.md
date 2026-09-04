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

**This cycle:** add three headless API/service journeys under
`tests/journeys/` that drive the same loops against a throwaway database
with injected fakes (no network, no Discord token). They run in the
existing `npm test` matrix on both engines.

**Next increment:** add Playwright against `createWebAppApp` in
`webapp.devMode`, with Chromium installed in CI and the Cloud Agent
image. The three journeys above become the first specs. Do not block
this hardening PR on browsers.

## Consequences

The distinctive loops are proven in CI today without a new runtime
dependency. Playwright remains an explicit follow-up that will require
an environment snapshot update (`npx playwright install --with-deps chromium`)
and a CI step.
