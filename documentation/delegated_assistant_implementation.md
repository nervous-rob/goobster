---
title: "Planned: delegated assistant implementation and acceptance plan"
kind: decision
summary: Planned delivery sequence, implementation seams, dependency gates, acceptance scenarios, and personal pilot for delegated responsibilities and assistant-first Home. No runtime feature is implemented by this document.
tags: [planning, assistant, responsibilities, home, initiative, implementation, acceptance]
---

# Planned: delegated assistant implementation and acceptance plan

**Status: in progress. DA-0 and DA-1a (responsibility grants) are implemented;
everything else in this document is still planned.** Updated 2026-11-08.
Code baseline: `c3b773ee835de82df8744eb33d274c94b2e9593c`.
Revalidate the observations against the implementation checkout before each increment.

Read the [product and Home specification](delegated_assistant_spec.md) for
behavior and the [architecture specification](delegated_assistant_architecture.md)
for data, policy, recovery, API, and projection contracts. This document owns
delivery order and acceptance gates. It is not an operator setup guide.

## Agreed direction and boundaries

- Delegated responsibilities are the central feature: people authorize outcomes
  with per-responsibility limits on knowledge edits, project work, repairs,
  process retirement, and external actions. Proposal-only is an available policy,
  not the chosen product ceiling.
- Home becomes the main assistant overview. It explains what Goobster is looking
  after, what materially changed, and what needs the person. Components highlight
  meaningful unacknowledged changes; routine activity is not an update.
- Start with one person and one project; use real account, actor, payer, scope,
  and audience boundaries from the first migration. Personal-first is not a
  bypass for access checks.
- Extend Attention, Knowledge, Expeditions, Plans, existing schedulers, Inbox,
  and the native agent loop. Do not create a second knowledge store, competing
  task hierarchy, provider router, scheduler, or mandatory queue service.
- This documentation authorizes planning work, not enrollment of accounts,
  activation of responsibilities, execution of repairs, or publishing changes.

Numeric pilot defaults are proposals until the owner records them. Feature ids,
API names, table names and service boundaries described as proposed in the
architecture are implementation targets, not callable capabilities today.

## Implementation inventory

| Concern | Current entry points | Required work |
| --- | --- | --- |
| Home | `apps/web/src/rooms/HomeRoom.tsx`; `webDashboardService.getHome`; `web/routes/workspace.js`; `apps/web/src/lib/api.ts`, `query.ts` | Bounded assistant projection, canonical changes, component states, acknowledgment, accessible primary layout |
| Goals and initiative | `attentionLedgerService`, `attentionService.registerGenerator`, `attentionPolicyService`, `personalHeartbeatService` | Responsibility contracts, durable opportunities/attempts, separate work selection from contact scoring |
| Conversation sources | `memoryService`, `knowledgeReflectionService`, `parlorService`, `webChatService`, `domainEventBus` | Incremental evidence references, speaker attribution, source cursors, permissions and privacy filtering |
| Execution | `utils/chat/agentOrchestrator.js`, `toolsRegistry`, `projectTriggerService.runAgentPrompt` | Recoverable agent runs, per-tool action checks, frozen delegation revisions, run leases and reconciliation |
| Resource controls | `usageBudgetService`, `resourceAdmissionService`, `utils/workContext`, work/resource/cost services | Background sub-budgets, payer attribution, foreground priority, cost per useful outcome |
| Knowledge | `knowledgeGraphService`, `knowledgeGraphLegalizer`, `knowledgeReflectionService`, `knowledgeTransferService`, `spitballResearchPipeline` | Protected curation, revision-aware change sets, edge evidence/history, reversible retirement, source impact |
| Projects | `projectMissionService`, `projectService`, `projectTriggerService`, `projectCiWatchService`, `projectHistoryService` | Explicit delegated execution, agent step support, verified artifacts, existing approval/acceptance boundaries |
| Processes | `automationService`, `projectTriggerService`, `attentionWatchService`, `followedSourceService`, `spitballExpeditionService` | Purpose contracts, adapter read model, structured occurrence outcomes, health/relevance, reversible retirement |
| Delivery | `inboxService`, `conversationContextService`, `attentionService.buildChatContext`, portal SSE | Canonical cross-surface identity, delivery receipts, relevance checks, no duplicate interruptions |
| Lifecycle | `features/catalog.js`, `features/inventory.js`, `runtime/coreRuntime.js`, privacy and retention services | Capability/runtime registration, explicit enrollment, erasure, report/audit coverage, installation pause |

Paths without a prefix above are under `packages/core/services/`, except the
explicit `web/`, `utils/`, `features/`, and `runtime/` paths under `packages/core/`.
The list is a starting inventory, not a claim that these files are the only
required edits. Core must never import an app.

## Delivery sequence

Every increment must ship its relevant behavior documentation alongside code.
Keep this table current with PR/commit references and evidence; do not mark an
increment done because its proposal exists.

| Increment | Status | Dependencies | Exit deliverable |
| --- | --- | --- | --- |
| DA-0: baseline and decisions | Done: [ADR 0016](adr/0016-delegated-responsibilities.md) (pilot numbers still to be recorded by the owner) | None | Revalidated source inventory; exact schema/API/feature choices and recorded pilot policy |
| DA-1: responsibility and change contracts | In progress: DA-1a responsibility grants shipped ([delegated_responsibilities.md](delegated_responsibilities.md)); DA-1b opportunities, DA-1c canonical updates and DA-1d process observations planned | DA-0 | Explicit delegated authority, canonical update identity, typed observations, lifecycle/privacy coverage |
| DA-2: assistant-first Home | Planned | DA-1 | Useful read-only Home over actual domain state with reliable component highlighting and acknowledgment |
| DA-3: durable research and knowledge | Planned | DA-1; DA-2 for pilot visibility | Recoverable bounded runs and authorized, reversible knowledge maintenance |
| DA-4: project continuity | Planned | DA-3 | Conversation-derived opportunities advancing approved/delegated project work with verified outcomes |
| DA-5: process stewardship | Planned | DA-1 observations; DA-3 runner | Purpose-aware health/relevance, bounded repair, pause/archive and dependent-aware cleanup |
| DA-6: integrated personal pilot | Planned | DA-2 through DA-5 | Observed repeat use and an owner-recorded decision about broader scope |

DA-2 does not wait for every autonomous capability. It initially projects real
existing state and explicit empty states. DA-5 observation adapters can be built
before repair is enabled. Autonomous graph mutation waits for its DA-3 safety
gates; autonomous repair waits for the runner and verification gates.

### DA-0: revalidate and freeze the first contracts

1. Confirm code baseline, available features, current Home payload, real actor
   propagation, execution locks, and budget paths. Keep legacy approval and
   publication behavior visible in the review.
2. Record final schema/API names, migration approach, feature/dependency choices,
   and the proposed defaults adopted for the pilot. Add an ADR if implementing
   a change to curation or approval semantics; the planned documents do not
   silently supersede ADR 0008 or existing human-only mission actions.
3. Trace one example through source message, responsibility, opportunity, run,
   evidence, graph/project/process change, canonical update, and acknowledgment.
4. Define output contracts and failure/stop codes before adding UI promises.

Exit: a reviewer can identify the authority and source of every proposed side
effect. There is no open permission ambiguity hidden behind a model prompt.

### DA-1: authority, observations, and canonical changes

Implement versioned responsibilities, explicit activation/revocation and
resource-scoped action grants. Connect responsibilities to existing Attention
goals/Project Plans rather than duplicating them. Materially widening authority
requires an authenticated human decision. A model can propose the change.

Implement durable source cursors/opportunities and canonical update identity;
the event bus accelerates work but missed hints must be recovered by scanning
durable source state. Do not make every assistant write a new human-interest
signal. Model/persona claims must remain distinguishable from human statements.

Define adapter observations with typed phase/outcome/reason and stable occurrence
identity. Preserve existing delivery ledgers and process ownership. Start
instrumenting recurrence outcomes now so later relevance judgments have history.

All new per-person rows, checkpoints, change records and derived caches join
transparency, erasure, retention, and account-switch/revocation behavior in this
increment. Ledger rows contain identifiers and safe scalars; private evidence
belongs in authorized content stores.

Exit scenarios:

- No responsibility activates merely because a user visits Home or a feature ships.
- Repeated hints produce one opportunity; a restart recovers a missed source change.
- A grant cannot authorize a disabled feature or access the actor no longer has.
- Revocation during work stops new dispatch/side effects, not merely the next sweep.
- Work attributable to one human never silently gains project-owner authority.
- One finding affecting Research, Knowledge and Projects has one canonical identity.
- Privacy erasure removes source-derived opportunities and prevents resurrection.

### DA-2: make Home useful before making it busy

Replace Home's primary hierarchy with the assistant briefing, Needs you,
responsibilities and stable component overview specified in the product spec.
Keep normal chat entry, resume links, room navigation and account controls easy
to reach. Preserve configured start-page behavior and room registry contracts.

Build a bounded server-side projection from current domain records and canonical
changes. Home reads must not run a model, fetch research sources, start a job,
grant authority, or mark content read. State includes component availability,
freshness, meaningful updates, required decisions, and running/blocked work as
separate dimensions. Partial failure is unavailable/unknown, not fabricated calm.

Acknowledgment is per person and versioned. Reading/acknowledging a finding is
distinct from approving a change or resolving an incident. When a new update
arrives during an acknowledgment, the new version stays unacknowledged. Reuse
the canonical Inbox read state when an update represents that Inbox item;
do not create competing counters for the same item.

Needs you is the unresolved-human-action filter of Inbox, not another queue.
Home previews that exact filter; project Needs-you boards apply a project filter
to the same canonical gates. Add Inbox All/Needs you/Updates filtering on the
existing route, preserve existing kind filters, and adopt/backfill domain gates
into one idempotent Inbox envelope per occurrence before exposing them in Home.
Domain services own approval/resolution; Inbox owns the shared envelope/read
state. One finding plus one related decision is one card, not two notifications.
Keep delivered revision separate from acknowledged revision, and unresolved
actions separate from both. Sidebar unread counts and Home action counts must
never be summed into an ambiguous alert total.

Exit scenarios:

- Loading Home changes no read state; card navigation alone is not approval.
- Repeated healthy polls/runs do not keep components highlighted forever.
- One cross-component finding shows one briefing item and one global update count.
- Acknowledging a finding clears its highlights on the other surfaces after refetch.
- An unresolved human gate stays in Needs you after its update has been read.
- Resolving a gate from Inbox, Home or a project updates every view; Mark all read
   resolves nothing. Informational unread updates are not Needs-you items.
- A mixed finding/decision appears as one Inbox item, with the gate as its primary
   action. Routine assistant-only recovery does not appear as a human obligation.
- Disabled, paused, no-responsibility, caught-up, loading, stale, partial-error,
   and deleted-target states are distinct and truthful.
- Account switch or membership loss cannot expose the prior account/project's data.
- Desktop and narrow screens preserve ranking, ordinary links, keyboard access,
   textual status, focus, adequate contrast, and reduced-motion behavior.
- Existing Home tutorials, creation actions and start-page preferences still work.

### DA-3: durable investigation and safe knowledge maintenance

Add a database-backed agent-run lifecycle, renewable leases, durable checkpoints,
tool intent/result records, stable execution attempt ids, and child adoption.
Reuse the existing orchestrator/provider contract; checkpoint execution state,
not hidden model reasoning. Rehydrate context only after current authorization
checks. Uncertain external writes need reconciliation, not blind retries.

Background runs must have separate claims from `web_live_turns`, explicit
background budget reservation and foreground-friendly resource admission.
Waiting for budget, a child, approval or the user holds no model slot or open
database transaction. Run cancellation, responsibility pause, installation
maintenance and account deletion must propagate to children according to the
documented boundary; cancellation cannot undo a completed remote action.

Use existing KG retrieval and Expedition source/claim persistence. Harden graph
mutation first: saved-note protection under capacity pressure, explicit generated
curation, expected revisions, edge provenance/history, reversible merge/archive,
and a distinction between semantic retirement and privacy deletion. A research
delete cap of zero is insufficient while unconditional capacity pruning can
still delete saved notes. Do not retain a longer text merely because it is longer
or treat embedding similarity alone as proof of identity.

Exit scenarios:

- A provider timeout, worker restart or duplicate claim does not duplicate child work.
- A crash after an external write enters reconciliation before a retry.
- Foreground chat remains usable during a background investigation.
- Repeated confirmation strengthens evidence without duplicate notes or notices.
- Conflicting evidence preserves the claim history and protected human wording.
- A concurrent human edit rejects/replans a stale graph change set.
- Saved knowledge survives capacity limits; new work defers/fails/archives eligible
   generated material rather than silently evicting it.
- Retracting a source identifies affected active assumptions without cascading deletion.
- Generated findings cannot corroborate themselves or start an endless research loop.
- An investigation can finish successfully with no change and a bounded recheck condition.

### DA-4: carry project work forward

Unify opportunity extraction across authorized personal chat, ordinary Parlor
and project discussions. Match existing work before creating a new draft. Keep
original human speaker, message and audience references. Persona proposals do
not become human commitments; an inferred useful idea does not create authority.

Add a durable agent execution resource/step to Plans using the existing
READY/STARTING/RUNNING child-link and reconciliation pattern. Make delegated
execution an explicit supported path. Preserve frozen plan revisions and existing
human approval/final-acceptance semantics unless a separately reviewed change
defines an additional delegation route; never forge confirmation receipts.

Leave artifacts and evidence in the project, link back to the initiating
conversation, and route private findings separately from shared updates. Reuse
knowledge transfer/publication checks for private material. Project mutation
locks/revision checks must protect human work across multiple conversations.

Exit scenarios:

- A discussion proposes a library comparison; Goobster researches it under a grant
   without inventing a commitment to migrate.
- An eligible step advances once, produces the required artifacts, and links evidence.
- Editing approved scope invalidates stale dispatch authority before execution.
- User steering supersedes queued work and identifies downstream assumptions.
- A collaborator's request runs as that collaborator, with an explicit payer.
- Private chat evidence is not copied into a shared project by a helpful summary.
- Lost membership stops queued and running work from reading or publishing project data.
- Failed verification reports a blocker rather than marking the objective completed.

### DA-5: keep processes healthy and useful

Expose existing process types through adapters. Extend occurrence records where
only lastRun/display text exists. Assess execution health and relevance separately
against purpose, cadence, output contracts, dependency state and stopping rules.
Missing purpose remains unknown. Group shared upstream outages; apply cooldowns
and recovery hysteresis so state flapping does not create repeated notices.

Implement repair as diagnosis, bounded change, outcome validation, resume and
observation. Stop after the permitted attempts and preserve rollback information.
Repairs use the same run/grant/action checks as other work. No repair is allowed
to enable a feature, expand permissions, or rewrite credentials by implication.

Implement reversible pause/archive before destructive cleanup. Stop future
launches and invalidate pending claims; define separately what happens to an
already-running action. Cleanup previews/executes only exact owned resources,
checks dependencies at apply time, and preserves shared/user-authored artifacts
and evidence. Changed plans/targets invalidate the old cleanup authorization.

Exit scenarios:

- A successful daily import with stale output is diagnosed as degraded.
- A healthy monthly process is not stale because it has been idle for three weeks.
- An unchanged website monitor remains healthy when quiet is expected.
- An ignored result is not sufficient authority to retire its process.
- One provider outage creates one incident group, with affected dependents blocked.
- A merged-branch watch becomes a retirement candidate and follows its explicit policy.
- Repair verifies output freshness and dependent recovery, not just exit status.
- Pausing during dispatch fences future launches and accounts for already-started work.
- Archive restores the definition; permanent cleanup cannot remove shared evidence.
- Process health remains visible after its announcement is acknowledged.
- Restoring an archived process leaves it paused until an explicit resume checks
   current authority/dependencies; cleanup-discarded artifacts are not promised back.

### DA-6: observed personal pilot

Use one chosen project with three explicit responsibilities: keep important
knowledge current, advance approved work, and keep its processes healthy/useful.
The owner chooses actual resources, external permissions, dates and budgets.
Fictional examples in these documents are not active delegations.

Proposed conservative starting policy, editable per responsibility:

- One background initiative executing at a time for the pilot account; foreground
  takes priority. Research only a small bounded shortlist after material changes.
- Explicit token/search/runtime/repair caps recorded at activation; do not rely
  on an unlimited single-user account cap as the responsibility budget.
- Generated-note additions and reversible maintenance allowed; human-note editing,
  external writes and process retirement individually chosen rather than inherited
  from a global autonomy label.
- Immediate contact only for time-sensitive actionable findings; other changes
  stay in Home/a digest or wait for relevant conversation. Existing contact limits
  are ceilings, not a target number of messages.

Record each pilot cycle using this template:

| Measure | Record |
| --- | --- |
| Responsibility and policy version | Resources, allowed actions, limits, review boundaries |
| Trigger and authority | Human instruction/source change; why the work was eligible |
| Expected and actual useful result | Evidence, artifact, corrected assumption or justified no-op |
| Actions and consequences | Graph/project/process changes, remote effects, rollback availability |
| Human effort | Questions, approvals, corrections and orchestration still required |
| Delivery | Home/component updates, actual interruptions, duplicates and relevance |
| Resources | Tokens/search/compute/storage; missing or estimated accounting noted |
| Reliability | Failures, revoked access, concurrent edits, retries, unwanted actions |
| Decision | Keep policy, narrow/widen it explicitly, repair machinery, or stop |

Do not use notes created, tool calls or time spent as success measures. Track
verified progress, accepted useful findings, corrections/rollbacks, unwanted
actions, cost per useful outcome, interruptions and foreground responsiveness.
Existing fixed-evidence research evaluation and the earlier personal research
pilot are inputs, not proof that delegated actions or Home are useful.

The owner must record thresholds before judging the pilot and an exit decision
before broadening autonomy or enabling it for other users. Test account isolation
from DA-1 onward even while rollout stays personal. Existing actual-host and
second-account gates remain in force; this plan does not supersede them.

## Validation and review requirements

For this documentation-only change, run `npm run docs:check`, the existing
self-docs/wiki corpus tests where applicable, relative-link/anchor checks, and
`git diff --check`. Do not add tests that merely mirror prose. Do not run live
providers, enroll anyone, or seed a production database to validate a plan.

For implementation, follow [development standards](development_standards_and_project_goals.md)
and [AGENTS.md](../AGENTS.md). In particular:

- SQLite and PostgreSQL parity for migrations, claims, revision races, recovery,
  authorization, retention and erasure. New Jest specs join exactly one CI group.
- `npm run lint`, `npm run smoke`, `npm run typecheck:web`, `npm run build:web`,
  `npm run docs:check`, `npm run test:groups:check`, and relevant unit groups on
  both engines; broaden only for affected integration concerns.
- Provider-independent deterministic fixtures for intent/fact distinction,
  selection/stop outcomes, graph mutation and process health. Keep optional live
  evaluation separate from required tests and human acceptance.
- Browser journeys for Home/acknowledgment, responsibility review and activation,
  pause/revoke, readable changes/undo, account switch, conflict handling,
  narrow screens, keyboard and reduced motion. Preserve existing tutorials.
- Extend existing privacy/audit/report coverage in every migration PR. Erasure
  must not leave undo records/checkpoints that can restore erased material.
- Exercise crash-after-claim, crash-after-write, concurrent dispatch, lease expiry,
  uncertain remote effects, changed authorization and interrupted delivery.
- Evaluate authority/policy at tool dispatch, not solely in the planner or prompt.

Current useful test seams include `tests/webPortalHome.test.js`,
`tests/attentionService.test.js`, `tests/attentionLedger.test.js`,
`tests/projectMissionService.test.js`, `tests/projectTriggerService.test.js`,
`tests/knowledgeGraphService.test.js`, `tests/privacyService.test.js`,
`tests/selfDocs.test.js`, `tests/documentationWiki.test.js`, and existing portal
journeys. These names identify existing files, not a promise that their current
assertions cover the proposed behavior.

## Documentation and handoff rules

- Keep these three planned documents as the authority for the proposal until
  increments ship; link shipped behavior guides from the status table as they do.
- Mark planned content unmistakably: the self-docs corpus includes repository
  Markdown. Goobster must not describe proposed APIs/settings as available.
- Do not add these drafts to the public wiki manifest as shipped user guides.
  Publish behavior documentation deliberately with each implemented increment.
- Keep product semantics in the product spec, lifecycle/data/policy contracts in
  the architecture, and delivery/evidence in this plan. Resolve disagreements
  across all three documents in the same change.
- Update Home, Attention, Knowledge, Projects, privacy, feature/config references,
  and authored tutorials when their behavior changes. Generated documentation is
  regenerated through the repository scripts, never hand-edited.
- The first engineering task is DA-0/DA-1. A visual Home prototype may use labeled
  fictional fixtures, but must not claim live work or create real delegations.

## Decisions still requiring implementation-time resolution

The scope and direction above are settled for planning. The following need an
explicit recorded decision, rather than blocking the documentation work:

1. Exact feature/dependency split and final schema/API/service names, including
   whether long-lived generation/provisional status uses a curation value or an
   independent acceptance field. Preserve `saved`'s human-intent semantics.
2. Final notification defaults, retention windows, component ordering details,
   and numerical work budgets after the first prototype/observed pilot.
3. Which human-note edits, external actions and retirement stages the first
   responsibility templates offer. All require resource-specific explicit grants.
4. Supported rollback depth for each adapter and the exact cleanup ownership
   manifest. Do not imply remote publication can always be undone.
5. How later collaboration allocates payer/authority and shared responsibility
   ownership. The personal rollout must preserve these fields and enforce current
   membership; shared activation awaits a separately reviewed behavior contract.
