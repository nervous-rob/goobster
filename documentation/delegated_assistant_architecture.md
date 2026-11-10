---
title: "Planned: delegated assistant architecture"
kind: decision
summary: "Planned responsibility grants, durable agent runs, evidence-backed knowledge maintenance, process health, and the assistant-first Home projection. These contracts are not implemented by this document."
tags: [planning, assistant, attention, delegation, projects, knowledge, home]
---

# Planned: delegated assistant architecture

**Status: design specification. Sections 3, 4, 5, 6 (generated notes) and 9
are implemented as recorded in ADR 0016, 0017 and 0018, the `agent` plan
step of section 7 as recorded in ADR 0019, and the rest of section 7 for
explicit requests (requests addressed to Goobster in a conversation,
supersession when a person changes direction) together with the project
board of section 9.2 as recorded in ADR 0021; the rest, and all of section
13 except "Deciding a request in place" (13.1), the explicit-request part
of the `conversation_request` adapter (13.2), delivery and interruption
(13.3) and the host's controls (13.6), is planned.** Updated 2026-11-10.
Source baseline: `c3b773ee` (2026-10-27). Revalidate the observations below
against the implementation branch before each increment. Table names, service
names, fields, routes, events, and errors explicitly described as proposed are
contracts for implementation, not available APIs or configuration switches.

The [product specification](delegated_assistant_spec.md) defines the experience,
including assistant-first Home. The [implementation plan](delegated_assistant_implementation.md)
defines delivery order, acceptance scenarios, and status. This document defines
the technical boundaries those increments must preserve.

## 1. Architecture decision

Extend the existing platform with a small delegation and durable execution
layer. A **responsibility** grants bounded authority to pursue an outcome;
an **initiative** is one candidate or attempt to advance it; an **agent run**
is recoverable execution. Attention goals/open loops and Project Plans remain
the canonical goals and plans. Responsibilities link to them rather than
creating another project-management hierarchy.

Existing domain services continue owning their data and transitions:

| Existing seam | Extension |
| --- | --- |
| `attentionLedgerService`, `attentionService`, `personalHeartbeatService` | Derive and rank initiative candidates; retain separate notification scoring. |
| `knowledgeGraphService`, `knowledgeGraphLegalizer`, `knowledgeReflectionService` | Retrieve before research and apply authorized, revision-checked change sets. |
| `spitballExpeditionService`, runner, research pipeline | Evidence-first bounded research under a responsibility. |
| `projectMissionService`, `projectService`, assets/history/repositories | Own plans, working files, child jobs, evidence, and project outcomes. |
| Automations, project triggers, watches, source follows, CI watches | Expose process contracts and observations through adapters; keep their schedulers. |
| `resourceAdmissionService`, `usageBudgetService`, `workContext` | Admit, attribute, cap, and reconcile background spending. |
| `inboxService`, Attention delivery, conversation context | Deliver one account-addressed result, with optional Discord echo. |
| `webDashboardService.getHome`, `HomeRoom.tsx` | Read a bounded assistant overview with component updates and responsibility controls. |

Core remains CommonJS under `packages/core`; React/TypeScript stays in
`apps/web`. Core never imports an app. Use the async DB facade and common
SQLite-dialect schema/migrations on both SQLite and PostgreSQL. A scheduler
starts through `runtime/coreRuntime.js`, obeys runtime mode/feature state and
the maintenance barrier, and uses existing singleton/lease patterns. No new
Redis service or always-running model session is required.

## 2. Observed gaps that gate autonomous actions

These observations are from the baseline, not claims that every current
writer is unsafe or that a remedy has shipped.

| Observation | Consequence for this feature |
| --- | --- |
| `projectTriggerService.runAgentPrompt` calls an unattended `webChatService.runTurn`; `webChatService.startTurn` uses a per-person `web_live_turns` claim. | Do not run long background initiatives through the foreground claim. Extract/reuse shared execution capabilities behind separate run claims. |
| Agent transcripts support follow-up context; sandbox jobs checkpoint code state. Neither establishes round-by-round agent crash recovery. | Add durable agent state and tool-operation reconciliation. |
| `startTurn` skips foreground `assertAvailable` for `isAutomation`; provider budget handling exists separately. | Explicitly test every new background path through reservations; a foreground preflight is not the spending authority. |
| Mission approval/start/complete are human-only, bound to a frozen plan revision; changed plans return to draft. | Preserve the contract and add an explicit delegation authorization path where required. Never fabricate a human confirmation receipt. |
| `knowledgeGraphLegalizer.applyMutations` calls `pruneScope` even when the research delete cap is zero. Capacity pruning lacks saved-note protection. | Fix pruning before enabling generated additions at scale; an addition must not silently evict deliberate knowledge. |
| General graph upserts do not compare the revision read during planning; semantic matching and longer-content merge heuristics can replace content. | Add operation-specific identity checks and compare-and-swap; similarity alone is a suggestion. |
| Notes have revisions; graph edges lack equivalent evidence/retraction history. | Add edge evidence and reversible mutation records before autonomous relationship maintenance. |
| ADR 0008 defines `saved` as deliberate user curation; user-launched research currently defaults to saved. | Autonomous research needs an explicit generated/provisional curation value, independent of source. |
| Some process types have delivery history; generic automations mainly retain last/next run and failures. | Add typed occurrence outcomes before claiming reliable health or usefulness trends. |
| Attention conversational mentions are marked delivered when selected for prompt context. | Record actual presentation separately; injection alone must not consume an update. |
| Existing Home mostly reads counts, recent content, scheduled work, and Inbox summaries. | Add a material-update projection; timestamps and activity counts are insufficient highlight semantics. |

References: [agent orchestration](agent_orchestration.md),
[Projects](projects.md), [curation contract](adr/0008-knowledge-curation-contract.md),
[work ledger](work_ledger.md), [independent runtime](independent_runtime.md).

## 3. Authority and source boundaries

### 3.1 Responsibility grant

**Shipped in DA-1a:** the grant record, lifecycle, operation vocabulary and
dispatch-time `authorize()` check described in this section are implemented.
See [delegated_responsibilities.md](delegated_responsibilities.md) and
[ADR 0016](adr/0016-delegated-responsibilities.md). Budgets are stored but not
yet enforced, and nothing calls `authorize()` until later increments add
delegated work. Every other section of this document is still planned.

`assistant_responsibilities` is a versioned grant containing:

- `id`, owning principal, authorizing principal, acting principal, payer,
  installation identity, revision, status, creation/review/expiry timestamps;
- outcome and links to existing attention items, project, and optional plan;
- allowed source scopes/resources, destination audience, and explicit
  publication rules; purpose does not grant access to an otherwise private source;
- allow-listed operations and resource/path/repository/branch constraints;
- budgets for model tokens, searches, compute/runtime, concurrent initiatives,
  repair attempts, and externally visible operations;
- verification, review, rollback, interruption, and stop/escalation rules.

Stored lifecycle vocabulary: `DRAFT`, `ACTIVE`, `PAUSED`, `NEEDS_REVIEW`,
`COMPLETED`, `REVOKED`, `EXPIRED`, `ARCHIVED` (the product labels use ordinary sentence
case). `DRAFT -> ACTIVE` requires activation; `ACTIVE -> PAUSED | NEEDS_REVIEW |
COMPLETED | REVOKED | EXPIRED`; `PAUSED | NEEDS_REVIEW -> ACTIVE` requires the appropriate
resume/review action and valid grants. Expiry also applies to paused/review
records before they can dispatch again. Terminal completed/revoked/expired records may
be archived, preserving their terminal outcome. Expiry sets `EXPIRED` and blocks
execution; it does not create authority to renew. Revoked, expired, or archived
records never resume; create a new authorized grant
if the person later delegates the responsibility again.
The user creates/activates a concrete grant through an authenticated action.
The model may draft it but cannot activate, broaden, or extend its own grant.
Pause is reversible; revocation invalidates authority permanently. Renewal or
expanded authority is a new authorized revision. A cosmetic title edit must not
silently reactivate paused work.

Operations must distinguish read, research, generated-note add/amend,
saved-note amend, edge maintenance, semantic archive, local file edit, sandbox
execution, process repair/pause/archive, exact cleanup, repository commit/push,
pull-request creation, and other external writes. Do not infer all operations
from a single `write` boolean. Operations absent from a grant are unavailable.
Examples in the product spec are templates, not shipped default grants.

Effective authority is the intersection of:

`active account + current resource access + feature availability + personal
data/tool policy + Attention category boundary + active responsibility revision
+ operation-specific domain rules + available budget`.

An urgent finding changes delivery priority, never authority. Current project
membership is checked as the acting principal, not the project owner. A
connected external account is the acting person's connection with its normal
allowlist. The assistant identity is a message author, not an administrator.

### 3.2 Enforcement and revocation

Check authority when deriving a candidate, acquiring a run, retrieving private
context, admitting expensive work, dispatching each side effect, applying a
change set, and publishing/delivering a result. Snapshotting a grant permits
auditing; it is not permission to use an obsolete revision.

Local mutations recheck grant revision, account/resource membership, and
expected target revision under the same transaction/immutable-resource lock
used by removal. Run leases carry fencing tokens; a stale worker cannot commit
after another worker adopts its run. Do not hold database transactions during
model, network, git, or sandbox execution. Long I/O stages recheck before
persisting or publishing results.

Pause/revoke stops new dispatch, wakes cooperative cancellation, and prevents
new local commits. It cannot recall a request already accepted by an external
service. Reconcile that operation and disclose any completed effect; never
claim cancellation reversed an external write. Adoption after grant changes
requires replanning under the current grant or a waiting/review state.

Control effects are deliberately distinct. Disabling Attention blocks candidate
creation, new initiative starts, and further autonomous tool dispatch for this
feature. Queued delegated runs wait on that policy gate; running runs reach a
safe checkpoint, reconcile in-flight effects, then wait without further
autonomous dispatch. Already-launched sandbox children follow their documented
cancel/finish contract; the UI reports which may still finish. Existing unrelated
user schedules and host recovery remain governed by their own services.
`notifyOutbound: false`, quiet hours, and notification snooze change delivery,
not research/execution authority. Home's Pause all suspends delegated work using
the same safe-boundary behavior, while retaining explicit grant statuses and
enough state to resume only still-active grants. Neither re-enabling Attention
nor Resume all recreates revoked/expired authority.

### 3.3 Input is evidence, not authority

Record source message id, actual speaker, surface, scope, original timestamp,
and whether content was human-authored, model-generated, quoted, or retrieved.
Persona suggestions and web pages cannot authorize actions. Repeated summaries
of one statement share a root lineage and do not corroborate each other.

Honor incognito, memory read/learn preferences, channel exclusions, and
explicitly excluded conversations. Permission to read one account's private
context is not permission to copy it to a shared project. Reuse
`knowledgeTransferService` copy/reference/publication semantics. Project
results must be supported by evidence authorized for that destination; private
reasoning can instead yield a private proposal asking to publish selected
context. Ordinary persona scopes stay distinct from the project Goobster seat.

## 4. Opportunity selection and durable initiative state

**Shipped in DA-1b:** source cursors, initiatives, their lifecycle, `claim`
leases and periodic recovery. See
[delegated_responsibilities.md](delegated_responsibilities.md#initiatives)
and [ADR 0017](adr/0017-initiatives-updates-processes.md). Scoring and
selection, and the runner that executes initiatives, are still planned.

Proposed `assistant_initiatives` records responsibility id/revision, principal,
audience/scope, source references, relevant existing goal/plan, question or next
outcome, reason now, expected value, dedupe identity, dependencies, evidence
revision, expiry/recheck condition, budget envelope, run id, and outcome.
It stores attempts, not another authoritative goal list.

Lifecycle: `CANDIDATE -> QUEUED -> RUNNING -> WAITING | REVIEW | COMPLETED |
FAILED | CANCELLED | SUPERSEDED`. `WAITING` includes a typed dependency,
budget, user-question, or access reason. A terminal initiative may produce a
new attempt only under a meaningful new input revision or explicit retry.
Successful outcomes include `NO_ACTION`, `ALREADY_KNOWN`, and `NO_CHANGE`.

The existing domain bus remains a transient hint transport. Publishers store
domain state first. Durable cursors and periodic bounded state reconciliation
derive missed opportunities after restart; adding a listener alone is not
delivery reliability. Events carry ids/scalars, never private prose. Candidate
selection reads authorized state before ranking and deduplicates against
existing initiatives, expeditions, jobs, plans, and automations.

Activation previews a bounded historical lookback: source scopes, cutoff,
maximum records, and examples of eligible candidate work. Old conversations
are evidence, not newly issued orders. Persist a stable activation/cursor
boundary and source revision identity so replay cannot turn the same text into
new tasks. After pause or downtime, preview a bounded catch-up when its scope
or proposed effects exceed the already authorized review window; never run an
unbounded backlog because a responsibility resumed. Normal within-window
reconciliation remains idempotent and subject to current grant/policy checks.

Deterministic generators identify bounded changes and gaps. An incremental
model synthesis may propose connections across the supplied, authorized
activity window; it cannot invent source references. Keep fact uncertainty
separate from intent uncertainty. Research may resolve the former; a grant or
human instruction resolves the latter.

Work ranking considers relevance to a responsibility, expected decision value
and information gain, novelty, confidence in the intent match, existing
coverage, cost, and time sensitivity. Notification scoring remains Attention's
interruption decision. Low factual certainty may justify investigation but not
an unsupported action. No model call occurs per raw event or Home page view.

Store `originRunId`, root evidence ids, and input/configuration revisions.
Agent-generated notes or results cannot by themselves create a fresh interest,
an independent corroboration, or another identical initiative. Bound lineage
depth, children per initiative, concurrent attempts, and repeated repair/recheck
cycles. A no-progress outcome sets a concrete new-evidence/recheck condition.

## 5. Recoverable agent execution

### 5.1 Run record and checkpoints

Proposed `assistant_runs` links the initiative, responsibility revision, actor,
payer, project/plan revision, initiating conversation, allowed audience,
execution attempt, lease owner/expiry/fence, cancellation generation,
timestamps, verified-progress marker, and final outcome. Related protected
records hold provider-neutral messages, context references, model/tool rounds,
tool intents/results, child-resource references, artifact hashes, usage, waiting
question, and checkpoint version. These records are private user data, not
operational-ledger prose.

Run lifecycle: `QUEUED -> RUNNING -> WAITING | REVIEW | COMPLETED | FAILED |
CANCELLED`. `WAITING -> QUEUED` requires its dependency or question to resolve.
A crash expires a renewable lease; it does not imply failure or successful
completion. Reconciliation adopts existing children and unresolved operations
before continuing. Version checkpoint formats and reject unsupported versions
with a recoverable review/export path rather than interpreting arbitrary state.

Persist enough to resume the execution protocol; hidden model reasoning is
neither required nor stored as a recoverable planning artifact. Rehydrate
context through current access checks. Do not serialize live clients,
credentials, request objects, or environment snapshots. Context compaction
retains evidence/operation references and does not turn a summary into new
independent evidence.

### 5.2 Tool-operation protocol

1. Validate the proposed operation against current policy and target revision.
2. Persist an intent with a stable operation id, argument hash, permitted
   destination, and applicable idempotency/reconciliation strategy.
3. Dispatch through the existing tool/domain service with current actor context.
4. Persist its receipt, result references, and observed effects.
5. Verify the intended outcome before marking the step complete.

Operation states distinguish `PREPARED`, `DISPATCHED`, `SUCCEEDED`, `FAILED`,
and `UNCERTAIN`. After a lost acknowledgment, read back by operation id or
resource identity before retrying. Tools without safe reconciliation must
pause for review on an uncertain write. An error string or missing reply is
not proof that the external action failed. No exactly-once external-effects
claim is made.

Local database effects should bind operation id to the mutation transaction.
Workspace changes use existing snapshots and project mutation controls;
rollback refuses to overwrite intervening human edits. Git remains host-side
through sealed git, normal personal credentials, protected branches, no force
push, and existing allowlists. Do not make sandbox networking or host access
more permissive for autonomous work.

### 5.3 Scheduling, budgets, and foreground priority

The runner is a bounded core-runtime worker, initially one background run per
person with an installation-wide cap. Exact limits are proposed defaults in
the product/implementation plan. Use database claims across replicas, and
fair admission across principals. Do not hold `web_live_turns`; reuse the
provider-neutral `runAgentLoop`, tool registry, prompt builders, and domain
services behind the new run lifecycle. Foreground work takes priority at
admission and checkpoint boundaries. Project writes still serialize; two runs
must not concurrently mutate the same workspace or plan.

Every model call and expensive adapter operation is attributed using the
existing `workContext` and ledger contracts. Responsibility and initiative
envelopes are additional caps, not replacements for the payer's account cap.
Reserve atomically before admission and settle actual usage afterward. Do not
double-charge child work: preserve parent linkage while retaining child
identities and an explicit accounting owner. Unknown usage remains flagged.
Token reservations alone do not cap searches, compute, or paid external tools;
their adapters need the matching reservation/cap checks.

Pause for exhausted budgets, unavailable dependencies, and revoked access;
do not repeatedly poll a model to rediscover the same refusal. Never increase
a budget, enable a disabled feature, switch to a costly provider, or rewrite
credentials merely to finish. Preserve provider parity through `aiService`.

## 6. Knowledge change sets and epistemic state

Reuse Expedition source/claim persistence before notes and reuse scoped
retrieval (`searchNodes`, neighborhoods, prompt packs). Retrieve again before
applying findings so concurrent knowledge additions can eliminate duplicates.

Proposed `kg_change_sets` and mutation records retain initiating run and actor,
responsibility revision, source/destination scope, root evidence ids,
target ids and expected revisions, proposed operations, rationale, policy
decision, before/after references, and apply/verification/rollback receipts.
Lifecycle: `PROPOSED -> APPLIED | REJECTED | STALE`, with `APPLIED -> REVERTED`
only through a new revision-checked compensating change. A relevant saved-note
edit outside authority waits for review without blocking permitted independent
additions; atomic groups identify changes that must succeed together.

Supported semantic operations are `add`, `amend`, `support`, `dispute`,
`supersede`, `retract`, `merge`, `archive`, `unlink`, and `delete`. Expand the
legalizer's closed schema and validators; never execute a model-supplied
validator or raw SQL. The policy layer checks every operation after the
legalizer's field/confidence limits and before mutation.

Separate these concepts:

- source/author provenance;
- deliberate curation (`saved`, `memory`, and a proposed generated/provisional
  state; never overload `unclassified`, which means legacy/unknown intent);
- claim status (`current`, `disputed`, `superseded`, `retracted`);
- valid time and last verification time;
- evidence quality/independence;
- salience/retrieval usefulness and retention eligibility.

Do not decrease truth confidence solely because of age or infrequent access.
Temporal succession is not necessarily contradiction. Preserve a human note's
preferred representation unless its responsibility explicitly allows amendment;
otherwise attach a machine evidence/correction overlay or proposed diff.
Semantic similarity alone cannot merge distinct entities, opposing claims, or
different historical states. The current longer-content heuristic must not
be the authority for autonomous edits.

Edges need evidence, originating operation/run, revision, retraction status,
and replacement/undo records. Node merges retain aliases/tombstones and the
dropped representation's history so references remain explainable. Archiving
removes material from normal retrieval but preserves review/restore access.
Retrieval normally favors current claims and can include disputed/historical
claims with explicit labels; it never presents retracted content as current.

Capacity enforcement must protect deliberate saves and active dependencies.
Archive eligible generated material, refuse an addition, or ask for a storage
choice instead of silently deleting saved knowledge. Mirror-aware retirement
must prevent a deleted fact from reappearing through legacy fact sync.

When evidence changes, retracts, disappears, or is erased, identify dependent
claims and active project assumptions for bounded reassessment. A missing
source means unverifiable, not automatically false. Dependency tracking begins
with active decisions/criteria and directly used claims, not a speculative
dependency graph over every stored sentence.

## 7. Project continuity and plan authorization

**Shipped in DA-4a:** the `agent` step kind, its link to a durable run
through the `READY -> STARTING -> RUNNING` protocol, the delegation's own
authorization kind and grant revision on the step, dispatch-time
invalidation when the approved plan revision moved, deterministic
verification, and the rule that keeps private context out of a shared
project. See [delegated_plan_steps.md](delegated_plan_steps.md) and
[ADR 0019](adr/0019-delegated-plan-steps.md). Source references from
conversations, matching existing work before drafting, and supersession when
the user changes direction (the first and last paragraphs below) are still
planned.

Preserve source conversation/message references from Study, ordinary Parlor,
and project discussions. Match existing work before drafting more. A private
trigger conversation and a shared project discussion are distinct destinations;
never infer audience from matching titles. Project work stores its publishable
artifacts/evidence in the project and sends a private account summary as needed.

Existing Plan approval binds `planRevision`. Add a proposed `agent` step kind
only when it can link a durable agent run and participate in the same
`READY -> STARTING -> RUNNING` child-adoption/reconciliation protocol as other
step kinds. A starting child is not a verified completed step.

An authorized responsibility may advance eligible steps in the approved scope.
New delegation paths must record their own authorization kind and grant
revision; existing human-only approve/start/complete behavior remains intact
until deliberately extended with equivalent validation and tests. Do not mint
or reuse a fake human receipt. Material changes to the objective, criteria,
steps, audience, or budget invalidate approval as today unless an explicitly
defined grant authorizes that precise revision path. Final human acceptance
remains distinct from the model's evidence-based review.

When the user changes direction, supersede affected initiatives, invalidate
queued work based on outdated plan versions, signal active runs to stop at safe
boundaries, and reassess dependent assumptions. A new note alone does not
cancel executable work. The reason and remaining external effects stay visible.

*Implemented (DA-4b, ADR 0021):* a steering message a person addresses to
Goobster in a conversation supersedes that person's unfinished initiatives
from the same conversation (`SUPERSEDED`, `STEERED`, `supersededBy`), a
running one by clearing its lease so the run stops at its next tool call;
one update names what was stopped, the changes already applied and left in
place, child research, and earlier results worth another look. Plan-step
initiatives are superseded on every reconcile once their plan revision, plan
status or step no longer match. See
[delegated_conversation_requests.md](delegated_conversation_requests.md).

## 8. Process catalog, repair, and retirement

**Shipped in DA-1d:** the catalog read model, contracts and typed
observations for automations and project triggers. See
[delegated_responsibilities.md](delegated_responsibilities.md#processes).
Health, relevance, repair and retirement are still planned.

Introduce a read model through adapters for existing process types. Proposed
`process_contracts` attach purpose, owning/acting principal, related goal/project,
expected cadence/runtime/output freshness, quiet-result semantics, dependencies,
owned artifacts, review/expiry/stop condition, criticality, and permitted
repair/retirement rules to a typed existing resource reference. The catalog is
not a scheduler and does not assume every process uses cron.

Proposed occurrence/observation records distinguish scheduled occurrence,
attempt/lease, dispatch status, execution status, output-contract validity,
freshness/fingerprint, delivery status, and useful/accepted outcome. Use
machine reason codes with private evidence references. Reuse trigger delivery
and child-job history where sufficient; instrument missing success/skip/block
outcomes rather than infer success from an absence of error rows.

Assess two independent axes:

| Execution | Relevance |
| --- | --- |
| healthy, degraded, blocked, stalled, unreachable, unknown | active, awaiting event, satisfied, superseded, dormant, retirement candidate, unknown |

Evaluate against eligible occurrences and explicit contracts. A monthly job is
not stale after three weeks; unchanged output may be the expected successful
result of a monitor. Unopened notifications are weak feedback, not proof of
obsolescence. Legacy processes start with unknown purpose until evidenced or
reviewed. Schedule checks use the scheduler's timezone contract and due times;
display uses the account's chosen timezone without changing schedules.

New Attention generators derive `process_health` and `process_relevance`
candidates with incident/configuration-version dedupe keys, recovery states,
hysteresis, and cooldowns. Group one upstream outage into one incident with
dependent processes marked blocked. Assessments explain observations and
uncertainty; the model can diagnose and propose work within the grant.

Repair records the diagnosis, patch, affected resources, snapshot, budget,
verification contract, allowed attempt count, and rollback plan. Apply under
current authority, validate the expected output/freshness as well as exit code,
then resume and observe a normal occurrence. Failed validation rolls back only
where safe and escalates after bounded attempts. Use existing deterministic
recovery before inventing an agent repair.

Retirement is `CANDIDATE -> PAUSED -> ARCHIVED -> CLEANED`, with explicit
authority for each transition. Pause invalidates pending launch claims and
defines whether running children finish or cancel; it is not an immediate
delete call. Archive preserves configuration, history, final outcome, and
restore metadata. Cleanup freezes an exact manifest, checks dependents and
ownership again, and deletes only authorized exclusively owned artifacts.
Shared files, human work, sources/claims, and useful knowledge are separate
resources. Existing delete APIs that cascade history must not implement archive.
Permanent deletion requires an explicit grant class or targeted approval and
retention rule; ordinary undo must not restore privacy-erased data.
Restoring an archived process restores its definition in a paused state.
Explicit resume rechecks current membership, dependencies, source/target
revisions, grants, and budgets. Restoration discloses cleaned artifacts that
cannot be reconstructed and does not claim that restoring a definition restores
deleted evidence, files, credentials, or externally removed resources.

## 9. Home and component update projection

### 9.1 Canonical material updates

**Shipped in DA-1c:** `assistant_updates`, per-revision receipts and the Inbox
envelope. See [delegated_responsibilities.md](delegated_responsibilities.md#updates).
The Home projection is still planned.

Extend the existing authenticated Home read additively. Proposed
`assistant_updates` represent material outcomes or decisions, not every tool
call or heartbeat: a finding changes understanding, authorized work advances,
a process changes health/relevance, a question needs an answer, or a
responsibility pauses/stops. Each update has stable identity, material revision,
source resource/revision, responsibility/initiative/run links, audience/scope,
reason/summary, evidence and action references, happened-at timestamp, and a
monotonic sequence. Summary generation happens in the producing workflow,
with a deterministic fallback, never during a Home GET.

The product-owned page hierarchy is assistant status/quick conversation,
Needs you, What changed, components, responsibilities, then Continue/create.
The projection returns enough stable ordering/grouping metadata for that layout
without requiring the browser to synthesize relevance or authority.

One update may belong to several component groups such as Knowledge, Research,
Projects, Processes, and Conversations. The product spec owns visible group
names/order. Membership does not duplicate the update, action, Inbox item, or
overall count. A research finding saved to a project can highlight multiple
components but remains one item. Repeated identical state does not increment
its material revision. Progress/lease telemetry updates running status without
manufacturing unread events.

Proposed per-account update receipts track delivered material revision and
acknowledged material revision separately, with optional snooze/dismiss
metadata. Read state is personal even for shared
project updates. `unseen`, `needsAction`, `running`, `health`, and data freshness
are independent properties. Acknowledging a finding does not resolve its
approval gate, mark a plan accepted, stop a process, or hide an incident.

Opening Home, rendering a component, receiving SSE, scrolling a row into view,
or injecting a finding into model context is not acknowledgment. Explicit
acknowledgment records the exact update revision. Delivery, including a
conversational mention, updates `deliveredRevision` only and never clears
unacknowledged component highlights. Acknowledge-all is an explicit bounded action over returned
ids/revisions or a server-issued snapshot token; it never clears newer changes
arriving concurrently. Viewing a detail may acknowledge the displayed revision
if the product makes that behavior explicit; mere navigation preload does not.

Correlate existing Inbox and Attention references using their current source
links. Home and an Inbox presentation of the same canonical update acknowledge
the same per-account material-revision receipt. Extend that Inbox item's source
metadata to include canonical update id and the rendered material revision;
its read operation acknowledges only that exact revision. A legacy boolean
`read` on the Inbox row cannot acknowledge a later canonical revision. Home
acknowledgment may mark the corresponding Inbox presentation read only when
the rendered revision matches; it does not mark unrelated Inbox rows read.
Legacy rows without a canonical mapping keep their current read behavior and
are not guessed into update receipts. Attention dismiss/snooze and unresolved
action gates retain their own meanings. No second sidebar badge is based on
summing overlapping stores. A result delivered through Inbox uses the existing
dedupe/delivery contract, and a failed Discord echo never re-executes work.

### 9.2 Inbox and Needs you are one collection with different views

Inbox is the canonical collection of delivered items. **Needs you is an
action-required filtered view of those same Inbox items**, not a second store,
queue, route hierarchy, or unread lifecycle. Proposed Inbox filters are All,
Needs you, and Updates on `/activity/inbox`; Home's Needs you uses the same
query. Existing Project Needs-you shows the project-filtered view of the same
source gates (implemented in DA-4b as `assistantGateService.projectBoard`,
a read that attaches the viewer's canonical gate and decision card to the
project's own list; ADR 0021). The domain service owns whether an approval/question/review gate
is open, resolved, cancelled, or superseded; projections do not copy that state
into independently mutable booleans.

All recipient-visible material assistant updates, including informational
findings below the outbound-contact threshold, have one canonical Inbox
envelope/mapping for that recipient and update occurrence. Filing that item
does not force a Discord echo or immediate interruption. `assistant_updates`
holds material revision/evidence/component metadata; it is not a second
notification collection with its own read lifecycle. Home's briefing and
component filters project these same items and per-revision receipts.

Every assistant action gate idempotently references one Inbox envelope per
recipient and gate/incident occurrence. Use a uniqueness/dedupe identity over
recipient, gate kind/id, and occurrence generation. A changed description or
material revision updates the envelope/mapping rather than delivering another
action request. A genuinely reopened incident has a new occurrence. Backfill
existing Project gate mappings without replaying old outbound notifications.
Only accounts allowed to know about and act on a gate receive its actionable
presentation; reading a shared project does not grant approval authority.

Action-required classification is derived from a typed live gate reference,
not unread status, model language, or execution failure alone. A transient wait
for an automatic budget reset is not Needs you unless a human decision is
required. A combined finding and decision uses one Inbox item with one primary
action, linked evidence, and the same canonical material update id. Purely
informational updates never enter Needs you just because they are unread.
The Updates filter selects informational items, not resolved action requests;
those remain in All/history with their outcomes. Project gates assigned to a
different authorized person appear as waiting-on-that-person status, not as
personal Needs-you items for every collaborator.
Home's What changed avoids repeating cards already shown in its Needs-you
section; component filters may reference the same underlying item.

Reading/acknowledging, delivery, gate resolution, and snooze are independent.
Reading clears the displayed update revision's unread/highlight state but does
not approve or close the gate. Resolving the domain gate clears it from all
Needs-you views while retaining its Inbox history. Snooze temporarily removes
it from the default action-required view until its deadline, without resolving
it or affecting other recipients' preferences. Inbox archive cannot silently
resolve an open gate; the UI preserves a way to find the unresolved action.

Keep the existing sidebar Inbox unread badge. Do not add unresolved-gate counts
to unread counts or sum Inbox and Needs-you totals. Home may separately label
“unread updates” and “needs your decision”; neither promises a disjoint total.
Per-recipient per-revision receipts are the authority for changed canonical
assistant content, so an old Inbox `read = true` never hides a new revision.
Home GETs, Inbox filter changes, and SSE have no read/resolution side effects.

### 9.3 Query and event contract

Home reads authorized canonical state before filtering, ranking, counting, or
summarizing. Project membership loss immediately excludes its content and
counts. Scope/audience checks apply to derived summaries and deep links, not
only source fetches. Native ids are principals; no Discord connection is needed.

Suggested additive response shape for `GET /api/app/home`:

```json
{
  "assistant": {
    "schemaVersion": 1,
    "asOf": "2026-11-08T18:00:00Z",
    "availability": "ready",
    "responsibilities": { "active": 2, "paused": 1, "needsReview": 0 },
    "counts": { "unseen": 2, "needsAction": 1, "running": 1 },
    "components": [
      { "id": "knowledge", "unseen": 2, "needsAction": 1,
        "running": 0, "freshness": "current", "latestUpdateId": "u_43" },
      { "id": "projects", "unseen": 1, "needsAction": 1,
        "running": 1, "freshness": "current", "latestUpdateId": "u_42" },
      { "id": "research", "unseen": 1, "needsAction": 0,
        "running": 0, "freshness": "current", "latestUpdateId": "u_43" }
    ],
    "needsYou": [{ "id": "u_42", "revision": 2, "title": "A project assumption changed",
      "componentIds": ["knowledge", "projects"], "unseen": true,
      "needsAction": true, "inboxItemId": 17,
      "gate": { "kind": "project_review", "id": "r_3", "occurrence": 1 },
      "source": { "kind": "initiative", "id": "i_8" },
      "actions": [{ "kind": "open_review", "targetId": "r_3" }] }],
    "brief": [{ "id": "u_43", "revision": 1, "title": "A generated note was verified",
      "componentIds": ["knowledge", "research"], "unseen": true,
      "needsAction": false, "inboxItemId": 18,
      "source": { "kind": "initiative", "id": "i_9" },
      "actions": [{ "kind": "open_evidence", "targetId": "i_9" }] }],
    "nextCursor": null
  }
}
```

This example is a proposed contract, not a working response. Keep existing
Home sections compatible during rollout. Component counts overlap; top-level
counts use distinct canonical ids. Actions are typed server-derived descriptors,
not executable model-generated URLs, JavaScript, or authority tokens. Navigation
does not grant access; mutation endpoints reauthorize independently.

Use bounded pages with opaque actor-bound cursors over `(sequence, id)` and a
fixed upper snapshot sequence; timestamps alone cannot paginate equal-time
changes safely. A revision change after acknowledgment becomes unseen again.
Use ETag/revision or equivalent conditional reads. Cache only within the
authenticated installation/account/session partition, and clear on account
transition. API responses follow existing no-browser-cache policy.

The portal SSE bus publishes refetch hints/ids only, coalesces rapid progress,
and rechecks session/account/resource access while streaming. Reconnection
refetches canonical state; transient SSE is not an update ledger. Counts are
computed on demand or maintained through a rebuildable projection. Unknown,
partial, unavailable, stale, and truly quiet states are explicit; an error
must not display a reassuring zero. Opening Home does not enable Attention,
activate grants, start research, or execute a repair.

## 10. Proposed endpoints and mutation rules

These names are proposed implementation targets, not existing routes:

| Route | Contract |
| --- | --- |
| `GET /api/app/assistant/responsibilities` | Bounded actor-authorized list with revision, status, scope, limits, and last verified outcome. |
| `POST /api/app/assistant/responsibilities` | Create draft or explicitly activate a reviewed grant; authenticated human action, idempotency key. |
| `PATCH /api/app/assistant/responsibilities/:id` | Expected revision; privileged fields require explicit authorization, never model self-expansion. |
| `POST /api/app/assistant/responsibilities/:id/actions` | Typed pause/resume/revoke/renew; revision checked; pause/revoke invalidate runnable claims. |
| `GET /api/app/assistant/initiatives/:id` | Authorized rationale, source references, plan/run, evidence, costs, and stop reason. |
| `POST /api/app/assistant/initiatives/:id/actions` | Cancel/retry/answer/review as applicable; expected revision and typed payload. |
| `GET /api/app/assistant/updates` | Material-update pages filtered by component/responsibility; same counts and authorization as Home. |
| `POST /api/app/assistant/updates/acknowledge` | Explicit ids/material revisions or issued snapshot token; idempotent per account. |
| Existing Inbox list/read/actions, extended additively | All/Needs-you/Updates filters; exact canonical revision read receipts; gate references and account-specific snooze. Home uses the same Needs-you query. |
| `GET /api/app/assistant/processes/:kind/:id` | Adapter-derived contract, observations, incident, dependencies, and permitted controls. |
| `POST /api/app/assistant/processes/:kind/:id/actions` | Typed repair/pause/archive/restore/cleanup request; authority, configuration revision, manifest, and idempotency checked. |

Human approval actions use existing confirmation patterns or an explicit new
receipt bound to the concrete operation, resource/manifest hash, and revision.
An Ask Goobster action can preload context without sending or authorizing a
request. Return ordinary auth/resource failures without leaking inaccessible
resource names; use conflict responses for stale state and return a refresh
path. Proposed machine codes include `RESPONSIBILITY_REVOKED`,
`RESPONSIBILITY_EXPIRED`, `OPERATION_OUT_OF_SCOPE`, `REVISION_CONFLICT`,
`OPERATION_UNCERTAIN`, `DEPENDENCY_BLOCKED`, and `VERIFICATION_FAILED`.
Reuse existing account/feature/budget codes where they already express the
failure. Machine codes are implementation choices to finalize with their tests.

## 11. Privacy, retention, operation, and degradation

Every new personal table/file joins `privacyService.forgetUser`, `auditUser`,
and `buildUserReport` in its introducing change. Erasure cancels queued/active
work, fences late writes, removes checkpoints/context packs/generated evidence
as required by their ownership, clears per-account receipts/caches, and cleans
derived vectors. Shared project erasure follows the existing ownership and
former-collaborator contracts; never promise that erasing personal copies
removes already published shared material or external-provider copies.

Ordinary semantic archive/undo history differs from privacy erasure. A tombstone
must not retain erased personal content, and ordinary restore cannot resurrect
it. Follow the existing backup privacy contract; this feature cannot erase
historical archives automatically.

Define bounded retention for run transcripts/checkpoints, unaccepted findings,
updates/receipts, process observations, and mutation history. Preserve retained
domain evidence and references needed for saved knowledge or accepted work;
report missing historical evidence honestly. Cleanup decisions use ownership
and retention metadata, not arbitrary filesystem sweeps. The implementation
plan must record chosen numerical windows before enabling retention jobs.

Operational ledgers keep only approved machine metadata and work references,
never prompts, replies, bodies, output, authentication tokens, URLs, or addresses.
Numeric token usage remains permitted through the existing budget/usage schema.
Content lives
in authorized domain records. Register any necessary operator action in its
audit vocabulary; a normal account does not gain Host controls through a grant.

Missing providers/features yield typed unavailable states and keep read-only
Home/status/history useful. No-network/local-provider operation uses existing
retrieval and provider capabilities; unsupported research/actions wait or
explain the limitation. Feature descriptors, packaging dependencies, discovery
and dispatch gates must be added together when implementing the feature.
The paired API cannot start a duplicate worker; the standalone API must work
without Discord. Maintenance pause prevents background mutation, and restore
does not reactivate grants or pending actions without reconciliation. Built
for runs: a restore marks every run that was in flight, and its initiative,
failed (`INTERRUPTED_BY_RESTORE`) and nothing resumes it
([delegated_runs.md](delegated_runs.md), ADR 0018 decision 13).

## 12. Invariants and verification targets

Implementation must demonstrate these invariants on both supported databases
and the relevant portal journeys:

1. No delegated side effect without current, operation-specific authority;
   activation, urgency, retries, and model output cannot widen it.
2. Actor, payer, source scope, and destination audience are explicit across
   initiations from every conversation surface.
3. Duplicate events/claims do not create duplicate children or knowingly repeat
   external effects; uncertain writes enter reconciliation/review.
4. Concurrent human edits and revocations defeat stale worker commits.
5. Generated research never silently becomes deliberate saved knowledge or
   evicts protected knowledge through capacity pruning.
6. Root evidence lineage prevents self-corroboration and self-sustaining loops.
7. Quiet healthy processes remain quiet; failure, delivery, freshness, and
   continued usefulness remain distinguishable.
8. A Home GET and its SSE connection cause no model work, enrollment,
   acknowledgment, approval, or process mutation.
9. Component membership never multiplies overall update counts; acknowledgment
   of one revision cannot clear a later revision or resolve an outstanding gate.
10. Background work does not claim the foreground turn lock and cannot starve
    interactive requests indefinitely.
11. No action completion is claimed from successful dispatch alone; verification
    and human acceptance are represented separately.
12. Account switch, membership loss, pause, and erasure clear/fence derived state
    and prevent subsequent private content delivery or resurrection.

13. Conversation, voice, feedback and learned signals can propose, inform and
    narrow; none of them can activate, resume, widen or spend beyond a grant.
14. Every outbound contact about delegated work passes the Attention contact
    budget, cooldown and quiet hours; delivery never implies review.
15. A new delegated capability exists only as an explicit entry in the run's
    tool table with a declared operation, resource, effect and reconciliation.

## 13. Planned extensions beyond the first pilot

**Status: planned, with three parts implemented: "Deciding a request in place"
in 13.1 (DA-7a), delivery and interruption in 13.3 (DA-9) and the host's
controls in 13.6 (DA-12a). Nothing else in
this section is implemented.** These are the
contracts for increments DA-7 through DA-12 of the
[implementation plan](delegated_assistant_implementation.md). They are
written now so DA-3 through DA-6 do not close off the seams they need. Names
below are proposals. Each subsection lists what already exists that it
builds on, the new records, and the rules that must hold.

### 13.1 Conversation and voice as the control surface (DA-7)

Builds on: the tool registry (`utils/toolsRegistry.js`), incognito tool
blocking (`utils/toolPrivacy.js`), `personalPolicyService.toolPolicy`,
`assistantResponsibilityService` (create is already idempotent and drafts
grant nothing), `assistantRunService.forInitiative`, the Home projection
(`assistantHomeService.project`) and the voice turn loop
(`services/voice/realtimeVoiceEngine.js`, `voiceSessionService`).

Proposed chat tools, all in a new `utils/tools/assistant.js`:

| Tool | Does | Authority |
| --- | --- | --- |
| `proposeResponsibility` | Creates a **draft** from structured arguments (title, outcome, operations, linked project, expiry, rules) and returns a confirmation card | None is granted. The draft carries `proposedBy: 'model'` and the conversation reference |
| `describeDelegatedWork` | Reads responsibilities, open initiatives, run summaries and journals (tool, status, refusal code) | Read of the speaker's own records only |
| `controlDelegatedWork` | `cancel` an initiative, `pause` a responsibility | Narrowing only. It cannot queue, resume, activate or edit |

Rules:

- **A model call is never a confirmation.** Activation, resume, queueing a
  proposed item and any authority edit need a human confirmation receipt:
  a single-use token minted when the portal or a chat confirmation card is
  rendered to the authenticated person, bound to the responsibility id, its
  revision and a hash of the grant shown, and consumed by the existing
  action route. Tool arguments cannot contain or forge it. This is the same
  rule missions follow for plan approval (section 7).
- The draft a model proposes is normalized by the same validator as a human
  draft; unknown operations and wildcard resources are rejected, and the
  card shows the normalized grant, not the model's description of it.
- All three tools are added to the incognito block list and are refused for
  `isAutomation` turns: an unattended turn cannot draft or steer delegation.
- `describeDelegatedWork` answers "why" from records: the initiative's
  source and reason, the run's journal and its refusals. It returns no
  retrieved text from another person's records.
- Tools act only in the speaker's personal scope. In a guild channel they
  answer that delegation is managed privately and link to the portal.

**Deciding a request in place.** *Implemented for Home and the Inbox
(DA-7a); the chat card and the repair-proposal descriptor are planned.* The
shipped behaviour and API are in
[assistant_home.md](assistant_home.md#deciding-a-request-where-it-is-shown).
Each gate kind registers a descriptor once
(`assistantGateService.gateDecisions`, descriptors in
`services/assistantGateDescriptors.js`):

```text
gateDecisions[kind] = {
  describe(gate, viewer)  -> { state, title, detail, outcome, revision,
                               options: [{ id, label, effect, danger }] } | null
  decide(gate, viewer, optionId, { occurrence, revision, surface, gateway }) -> { message }
  settle(gate, viewer)    -> optional; reconciles the canonical update
  staleCodes              -> the domain's own "already settled" error codes
}
```

`POST /api/app/assistant/gates/:ref/decide { option, occurrence, revision,
surface }` resolves the gate reference, checks the viewer may act on it
(`describe` returns `null` otherwise), and calls the owning domain service:
mission approval and start, friend request, access request. It never writes
the outcome itself; an update's gate resolves through `resolveGate` as it
does today. A stale occurrence or revision, a settled request, or a domain
"already settled" refusal answers 409 `STALE_GATE` with the current card in
`error.details.current`, and nothing is decided. Home and the Inbox render
the same card.

As built, three things differ from the proposal above them:

- `:ref` is an update id **or** `inbox-<item id>`. Friend and access
  requests are Inbox items with their own needs-you predicate (section 4),
  not canonical updates, so they have no update id.
- `revision` is derived from the owning record (`plan:<planRevision>`, the
  request's creation time), not the update's `materialRevision`. The
  update's `occurrence` is still checked.
- `surface` (`home`, `inbox`, `chat`) is required. `chat` is accepted so the
  DA-7b confirmation card posts to the same route; `decide` is deliberately
  not a model tool, and a test fails if a chat tool (`utils/tools/`) or a
  run tool (`services/assistant/runTools/`) calls it.

Mission approval still mints the mission's own human approval receipt
(section 7) inside the descriptor, bound to the plan revision on the card.

**Spoken briefing.** A voice intent reads `assistantHomeService.project`
and speaks counts, the Needs-you titles and up to three findings. It calls
no acknowledgment route. Speaking a private finding requires the voice
session to be the person's own (never a shared guild voice channel).

### 13.2 Opportunity sources (DA-8)

Builds on: `assistant_source_cursors` and `SOURCES` in
`assistantInitiativeService` (one module per adapter under
`services/assistant/sources/`; one cursor per source, proposals idempotent on
`(responsibility, dedupeKey, sourceRevision, attempt)`), `domainEventBus`
topics as hints only, `followed_sources`, `observatory_jobs`,
`project_ci_watches` and the corrected `summarizeChecks` verdicts.

New adapters, each `{ read(responsibility) -> [{ sourceId, revision, title,
reason }] }`:

| Adapter | Durable source | Material change | Requires in the grant |
| --- | --- | --- | --- |
| `conversation_request` | The person's own chat messages in conversations the responsibility names, or their personal scope | A new message classified as a request or commitment within the responsibility's outcome | `scopes.sources` includes `personal_chat`; `read` on what the work will need |
| `followed_source` | `followed_sources` entries the person keeps | A kept entry newer than the cursor | The followed source named as a `process` resource |
| `job_failure` | `observatory_jobs` of the linked project | A new failure cause (error code and file), not each retry | `read` on the project |
| `ci_verdict` | `project_ci_watches.lastState` | A settled verdict change on a watched branch | `read` on the repository |

*Implemented (DA-4b, ADR 0021):* `conversation_request` exists for explicit
requests only. It reads the person's own messages in the linked project's
conversations (`scopes.sources` includes `project_chat`) and in their own
discussions (`parlor`), recognizes a request or a change of direction by
fixed text rules with no model, keeps one stream cursor per responsibility,
stores a reference to the message and never its text, and caps open
conversation attempts at 10 per responsibility. DA-8 adds `personal_chat`,
model classification, `maxProposalsPerDay` and the other adapters; the
explicit rule stays the floor.

Rules:

- Classification of a conversation message is a bounded, cached decision
  keyed by message id and responsibility revision. It runs on the steward's
  pass under the responsibility's token budget, never on a Home read, and
  its output is a label plus the message reference, never a new instruction.
- **Text is evidence, not authority** (section 3.3) for every adapter: a
  fetched page, a file or a message that says "also push this" changes the
  opportunity's description at most. Authorization is unaffected.
- Each adapter has `maxProposalsPerDay` per responsibility (proposed default
  3). Excess changes coalesce into the newest revision; they are not queued.
- Cursors record the highest source revision seen. A deleted conversation or
  an unfollowed source removes its cursor and its open opportunities
  (erasure and membership loss use the same path).
- New kinds join `scheduledWorkRegistry` where they keep a next-time, and
  the process catalog where they are recurring.

### 13.3 Delivery and interruption (DA-9)

*Implemented; the behaviour, the stored records and the defaults chosen are
in [delegated_delivery.md](delegated_delivery.md). Where the built contract
differs from the proposal below, it is stated in place.*

Builds on: the portal SSE channel (`web/liveAuthorization.createSseChannel`),
`inboxService.deliver` (Inbox first, Discord DM as a tracked echo),
`pushService.notify`, and Attention's contact path
(`attentionService._contact`, `attentionPolicyService` daily cap, cooldown
and quiet hours), and `rules.interruption` already stored on the grant.

- **Live overview.** `assistantUpdateService`, `assistantInitiativeService`,
  `assistantRunService` and `assistantResponsibilityService` publish
  `assistant.changed` on the domain bus (through
  `assistantLiveService.changed`) with
  `{ userId, kinds: ['update' | 'initiative' | 'run' | 'gate'] }`. The
  portal stream forwards it as an `assistant` event to that person's
  sessions only. The client refetches; the event carries no title, text or
  id. A reconnect refetches. Each stream gets at most one event per five
  seconds (the first after a 300 ms settle delay, then the union of what
  changed), and run progress is published at most once per run in the same
  window.
- **Interruption rule.** Read from the live responsibility when the
  contact or digest is decided (first when the envelope is filed, then on
  each steward pass), so a change to `home`, a pause or a revoke applies to
  what is still waiting:

  | `rules.interruption` | Finding | Open request |
  | --- | --- | --- |
  | `home` (default) | Inbox only | Inbox only |
  | `digest` | Inbox, and the day's digest | Inbox, and the day's digest |
  | `immediate` | Inbox, and the day's digest | Inbox, plus one contact per gate occurrence |

  A finding never contacts by itself. `immediate` applies to requests that
  block delegated work. `assistant_updates.outboundRevision`,
  `outboundOccurrence`, `outboundKind` and `outboundAt` record the one time
  a revision (or a gate occurrence) left the portal, claimed before anything
  is sent.
- **One contact path.** A contact is requested through
  `attentionService.requestContact({ userId, reason: 'assistant', updateId,
  urgent, inboxItemId | item })`, which applies the same daily cap, cooldown
  and quiet hours as Attention's own contacts. Attention's notices are their
  own ledger; every other reason is recorded in `attention_contacts`
  (reason, reference, delivery status; no text), and both are counted
  together for the cap and the cooldown. The contact is reserved in a
  transaction on the person's `attention_state` row before it is sent. Push
  and the Discord echo are its channels (`inboxService.echo`). Delegated
  work has no channel of its own, so it cannot exceed the person's contact
  budget.
- **Digest.** `assistant_digests (userId, day, updateIdsJson, inboxItemId,
  sentAt)`, unique per person and day. Built once per day after the person's
  digest time (`attention_policies.digestMinute`, default 09:00 on the
  quiet-hours clock) from unseen updates that were waiting at that time; an
  empty set sends nothing and records nothing. An update already contacted
  about is left out of the digest, so the same update never arrives both
  ways.
- Receipts keep `deliveredRevision` separate from `acknowledgedRevision`
  (ADR 0017): a push, a DM, a digest and a spoken briefing all record
  delivery only.
- Until the pilot decision is recorded the capability (`delivery` in
  `assistantAccessService`) is the owner's: other accounts get no
  `assistant` events, cannot activate a `digest` or `immediate` rule
  (`PILOT_ONLY`), and nothing is sent for them.

### 13.4 Feedback and learned signals (DA-10)

New records:

```text
assistant_feedback (id, userId, updateId NULL, initiativeId NULL, kind, createdAt)
  kind IN ('useful','already_knew','wrong','less_of_this','wrong_time',
           'keep_wording','stop_responsibility')
assistant_source_weights (responsibilityId, adapter, weight, dismissals,
                          acceptances, updatedAt)   -- one row per adapter
```

Each kind has exactly one effect:

| Kind | Effect | Where |
| --- | --- | --- |
| `useful` / `already_knew` | Adjusts the adapter's acceptance counters | `assistant_source_weights` |
| `wrong` | Opens a correction on the generated note or claim the finding cites; the evidence stays | Knowledge (a revision, not a delete) |
| `less_of_this` | Lowers the adapter's `weight` (which scales its daily proposal cap, floor 0) | `assistant_source_weights` |
| `wrong_time` | Adds the hour to the person's digest/contact preferences | Attention policy |
| `keep_wording` | Marks the note saved (it leaves `generated`) | Knowledge |
| `stop_responsibility` | Opens the ordinary pause or revoke confirmation | Responsibility lifecycle |

Rules:

- Signals are numbers and enums. No feedback text and no history is fed to a
  model as instructions.
- A weight changes how often an adapter may **propose**. It never changes
  authorization, budgets or which tools a run has.
- Ignoring or dismissing lowers a weight slowly and cannot reach zero by
  itself; only explicit `less_of_this` or removing the source can.
- The current weights are shown on the responsibility with a reset. Both
  tables are per-person data: export, report, erasure, 180-day retention for
  feedback rows whose update is gone.

### 13.5 Extended reach (DA-11)

Every capability below is a new entry in `assistantRunService.TOOLS`
(ADR 0018; one module per capability under `services/assistant/runTools/`)
with `needs`, `effect`, and either `atomic` or `reconcile`.

**Repository work.** Through `projectRepoService` and `utils/sealedGit.js`
only, with the acting person's own connected GitHub token.

| Tool | Operation | Reconciliation after a crash |
| --- | --- | --- |
| `commitProjectRepo` | `repo.commit` | The clone's HEAD carries a trailer `Goobster-Operation: <run>:<op>`; present means done |
| `pushProjectRepo` | `repo.push` | Compare the remote branch head with the local commit; equal means done. Never forced; a rejected push is a result, not a retry |
| `openPullRequest` | `pr.create` | Look up an open pull request for the head branch; found means done |

The grant must name branch patterns (already enforced when saved). A run
additionally refuses the repository's default branch and any branch GitHub
reports as protected, whatever the pattern says.

**Knowledge beyond generated notes.** Preconditions, in order:
`kg_edges` gains `revision`, an evidence reference and a retraction record;
`mergeNodes` and archive become reversible (an archived note keeps its
edges and is restorable); `kg.archive` is distinct from privacy deletion.
Then: `proposeSavedNoteEdit` files a request (a gate with a diff) the person
applies; `kg.saved.amend` granted explicitly allows a direct edit as a
compare-and-swap on the revision read; `linkNotes` and `archiveNote` follow
the same compare-and-swap rule.

**Project audiences.** A run whose initiative has `audience = 'project'`
publishes with `audience: { projectId }`. Visibility already follows current
membership (`assistant_updates` visibility). Additional rules: the producer
is shown; private sources are not quoted into a project finding unless the
grant's `scopes.audience` is `project` and the source is the project's own;
a member's receipt is deleted when they leave.

**Outside connectors.** A connector is a typed adapter:

```text
connector = {
  id, feature,                       // gated like any optional feature
  reads:  [{ operation, describe }], // exactly what it can read
  writes: [{ operation, describe, reconcile }],
  credentials: per-person, in user_integrations, never the operator's
}
```

A responsibility grants a connector resource by id and named sub-resource
(one calendar, one mailbox label), never a provider wholesale. Reads are
`read`; writes are `external.write`, count against `externalOperations`,
and must provide `reconcile` or they stop for review after any uncertainty.
Each connector ships with a recorded owner decision and a manifest shown at
activation. Broad surveillance remains a product non-goal: there is no
"watch everything" connector and no background ingestion outside a named
responsibility.

### 13.6 Operator controls and evaluation (DA-12)

**Status: the host view, the controls, caps as configuration, the pilot
gate and the pilot record are implemented (DA-12a); the behaviour is in
[delegated_operations.md](delegated_operations.md). The evaluation set is
planned (DA-12b).**

- **Host view (implemented).** `GET /api/app/admin/assistant` returns counts
  by state, runs, tokens, searches and sandbox seconds per day, failures and
  refusals by code and the oldest queued and waiting age. It returns no
  title, prompt, result or journal text, and names accounts by id only (the
  host already sees account ids).
- **Controls (implemented)**, each writing one `operator_audit` row:
  `assistant.pause_all` / `assistant.resume_all` (the flag
  `instance_state.assistantPaused`, read by the runner, the claim, every
  run's heartbeat and `authorize()`, so running work halts at its next
  call and waits as `ASSISTANT_PAUSED` until the resume requeues it),
  `assistant.set_caps` (`installationRuns`, `runsPerAccount`,
  `defaultModelTokens`, `defaultSearches`, `defaultComputeSeconds`) and
  `assistant.pilot_decision`.
- **Caps as configuration (implemented).** The numbers that were hard-coded
  (`INSTALLATION_CAP`, `PER_PERSON`, `DEFAULT_BUDGETS`) are a stored policy
  (`instance_state.assistantCaps` over `config/assistantConfig.js`) with
  those values as defaults. A responsibility's own budget may be lower than
  the host's number, never higher: the host's default is also the ceiling.
  Both run caps are enforced inside the claim transaction under one lock
  (`assistantControlService.admit`), so they hold when claims race across
  processes.
- **Pilot gate (implemented).** `assistantAccessService.allows(userId,
  capability)` is the per-account check every increment from DA-7 through
  DA-11 makes (`conversation`, `sources`, `delivery`, `feedback`, `reach`).
  Until `instance_state.assistantPilot` records `everyone`, only an active
  operator account passes. The DA-11 grant operations already in the
  vocabulary are gated at activation and in `authorize()` (`PILOT_ONLY`).
  "Deciding a request in place" (13.1) shipped before the gate and does not
  call it yet.
- **Evaluation set (planned).** `tests/live/assistant.live.test.js` (skipped
  without keys, never in required CI): fixed fictional responsibilities and
  seeded sources, run against a real provider. It records, per model and
  prompt version: refused calls, writes attempted outside the grant, injected
  instructions followed (must be zero by authorization, measured anyway),
  tokens per useful result, and runs ending with no result.
- **Pilot record (implemented).** The DA-6 template has the model and prompt
  version and the caps in force, so a result can be compared across changes.

See the [implementation plan](delegated_assistant_implementation.md) for the
increment-specific acceptance matrix and rollout gates. CI establishes these
mechanics; it does not establish that autonomous work is useful. The personal
pilot must also measure verified progress, corrections/rollbacks, unwanted
actions, interruption rate, cost, and foreground responsiveness.
