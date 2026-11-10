---
title: "Planned: delegated assistant and assistant-first Home"
kind: decision
summary: Planned product contract for delegated responsibilities, proactive knowledge and project work, recurring-process stewardship, and a Home page that highlights meaningful assistant updates. This document specifies future work; these capabilities are not implemented by this document.
tags: [planning, assistant, initiative, responsibilities, home, knowledge, projects, automations]
---

# Planned: delegated assistant and assistant-first Home

**Status: planned; no feature implementation is claimed.** This is the product
contract for the next delegated-assistant work. Existing Attention, Knowledge,
Projects, Research, Inbox, and Home behavior remains governed by its shipped
documentation until an increment explicitly lands. What has landed is recorded
in the [implementation plan's status table](delegated_assistant_implementation.md#delivery-sequence);
the shipped behaviour guides are
[delegated_responsibilities.md](delegated_responsibilities.md),
[assistant_home.md](assistant_home.md), [delegated_runs.md](delegated_runs.md)
and, for section 7, [delegated_plan_steps.md](delegated_plan_steps.md) (plan
steps) and
[delegated_conversation_requests.md](delegated_conversation_requests.md)
(requests made in conversation and changes of direction; journey B for
explicit requests, and the project board of journey G) and
[delegated_project_findings.md](delegated_project_findings.md) (findings
shared with a project's members).

Updated: **2026-11-10**. Code baseline: `c3b773ee` (2026-10-27).
Recheck implementation seams against current main before starting each increment.

Read with [the architecture](delegated_assistant_architecture.md) and
[the implementation plan](delegated_assistant_implementation.md). This document
owns intended behavior and interaction semantics; the architecture owns technical
contracts; the implementation plan owns delivery order and acceptance gates.

## 1. Product outcome

Goobster should look after explicitly delegated responsibilities: keep important
understanding current, carry authorized project work forward, and keep recurring
processes healthy and useful. He notices a relevant change, retrieves what he
already knows, chooses whether investigation is worthwhile, executes within his
authority, verifies the result, and reports when the result matters.

The experience should feel continuous across ordinary Chat, Discussions/Parlor,
project conversations, knowledge, research, and automations. A conversation can
lead to useful work without the person having to remember every follow-up.
It must remain possible to inspect why work began, what authority it used,
what changed, what it cost, and how to stop it.

**Home becomes the main view of this assistant at work.** It answers:

1. What is Goobster looking after for me?
2. What meaningfully changed since I last reviewed it?
3. What needs my decision or help?
4. What is progressing quietly, and what is blocked?
5. Where can I inspect or continue the underlying work?

Goobster does not need to manufacture a finding or initiate contact to prove he
is active. “Existing knowledge was sufficient,” “the monitor is healthy,” and
“no useful action” are valid outcomes with compact records and recheck conditions.

## 2. Scope and decisions

### Settled product decisions

- A **responsibility** is the stable delegation contract. It can produce many
  initiatives and runs without inventing new permission on each occasion.
- Delegation is per responsibility and per action class. There is no universal
  aggressive/conservative switch that silently controls every kind of mutation.
- The first pilot serves one person, with account, actor, project membership,
  payer, and audience boundaries present from the first increment.
- Attention remains the opportunity and delivery policy. Knowledge, Research,
  Projects, and process services remain the systems of record for their work.
- Home presents those systems coherently; it is not another task store or a new
  sidebar room called “JARVIS.” The assistant uses the configured assistant name.
- Work selection, permission to act, and permission to interrupt are distinct.
- Important changes are reversible where the operation permits it. Permanent
  deletion and external effects require explicit authority for that action class.
- Meaningful updates highlight their assistant components. Routine polling,
  tool calls, enabled features, and heartbeat activity do not earn a highlight.

### Proposed pilot defaults

These are starting values for implementation review, not existing configuration
keys or promises about capacity:

- Begin with one selected project and three responsibilities: keep its important
  knowledge current, keep its approved work moving, and keep its processes useful.
- One background initiative actively using scarce model/compute capacity per
  person, with foreground requests taking priority.
- At most one consolidated nonurgent outbound digest per day; urgent contact
  remains constrained by Attention policy and user preferences.
- Show up to three briefing items and three Needs-you items before “View all.”
- Autonomous generated-note additions and revisions are offered as a delegation
  choice; direct saved-note editing is off until explicitly included.
- Repair attempts have a visible small finite cap; process retirement begins
  with pause/archive and leaves permanent cleanup separately configured.

Budget amounts, review intervals, and numeric relevance thresholds must be
chosen and recorded with the actual pilot. An unset autonomous spending limit
must not mean unlimited spending.

### Non-goals for the first release

- Broad desktop, browser-history, email, or calendar surveillance.
- An always-running model thinking over a complete personal-memory dump.
- A replacement knowledge graph, research engine, project manager, scheduler,
  notification center, or provider router.
- A decorative animated “brain” whose motion implies cognition or health.
- Automatically treating every conversational idea as a commitment.
- Multi-agent organization or a new cloud queue as a prerequisite.
- Silent publication of private context into shared projects.
- Automatic final human acceptance of a Project Plan.

## 3. Responsibility contract and lifecycle

A responsibility is a human-authorized outcome plus boundaries. “Keep this
project moving” can be the initial request, but activation requires concrete
scope and authority. A model can draft those details; deterministic services
validate and persist the authorization.

| Field | Required meaning |
|---|---|
| Objective | The outcome being looked after, linked to existing Attention goals or a Project Plan where available |
| Owner and actor | Who delegated it and which principal the work acts as; project ownership is not substituted for the speaker |
| Targets | Explicit projects, notes/collections, processes, repositories, branches, or other resources |
| Allowed context | Conversations, graph scopes, source follows, files, and connections it may consult |
| Audience | Where findings, artifacts, and changes may be delivered or published |
| Action grants | Research, generated knowledge maintenance, selected saved-note edits, local project work, plan-step execution, repair, pause, archive, cleanup, and individually scoped external effects |
| Boundaries | Actions requiring review, protected resources, excluded topics and sources |
| Limits | Spending, runtime, concurrency, attempts, changes, and external-operation caps |
| Verification | Evidence or output checks needed before progress/completion is reported |
| Stop/escalation | Completion, supersession, ambiguity, failure, expiry, no useful progress, or budget exhaustion |
| Reporting | Relevant chat mention, Inbox, digest, immediate contact, and quiet hours |
| Review | Version, review date, expiry, and how changes/revocation affect existing work |

Responsibility states are **draft, active, paused, needs review, completed,
revoked, expired, archived** (`DRAFT`, `ACTIVE`, `PAUSED`, `NEEDS_REVIEW`,
`COMPLETED`, `REVOKED`, `EXPIRED`, `ARCHIVED`). The architecture defines transitions.
Activation and scope expansion require the person's explicit authorization.
Pause blocks new work and offers a clear choice about currently running work;
revocation prevents subsequent side effects and cancels/reconciles active work
according to the run contract. Neither action promises to undo already-completed
external effects.

“Pause all assistant work” must be available from Home. It pauses delegated
initiative work, not unrelated host maintenance or every user-created schedule.
If responsibilities own a recurring schedule, the pause flow explains whether
that schedule is included. Resume never silently broadens grants.

Responsibility detail shows the current contract, its revision history, linked
work, accumulated outcomes/cost, latest usefulness review, and Pause/Edit/End
controls. Editing grants does not require reauthorizing unchanged permissions;
expanding them requires explicit approval of the change.

## 4. Assistant-first Home

### Page hierarchy

Home retains its route and the existing navigation system. The assistant overview
becomes its primary content; room shortcuts, recent conversations, creation
actions, usage, and privacy controls remain accessible as secondary content.

The intended hierarchy, in reading and keyboard order, is:

1. **Assistant status and quick conversation.** Configured assistant name,
   concise truthful overall state, “Ask Goobster,” and Pause/Resume controls.
   A status like “Looking after 3 responsibilities” is derived from records,
   not generated marketing text.
2. **Needs you.** A short queue of decisions, missing information, approval
   boundaries, failed verification, or blocked work requiring a person.
   Existing Project Needs-you gates appear here through their canonical records.
3. **What changed.** A concise briefing of important findings and completed
   authorized changes. Every item names why it matters and its next useful action.
4. **Assistant components.** A stable visual overview of Knowledge, Research,
   Projects, Processes, and Conversations. Meaningful updates highlight affected
   components; the cards are functional navigation, not ornamental anatomy.
5. **Responsibilities.** Active outcomes, progress, last material change,
   next action/recheck, and a link to the delegation contract. Running details
   expand on demand rather than dominate the brief.
6. **Continue and create.** Recent chats/discussions, selected projects,
   New chat/note/project, room links, Usage & limits, and Personal memory/privacy.

On a narrow screen this is one column in the same order. On a wide screen the
brief and Needs-you queue may sit alongside component/responsibility summaries.
Do not require a graph, canvas, hover, or animation to use the overview.

Example layout (content is fictional, not seeded personal data):

```text
Goobster                                      Ask…   Pause assistant work
Looking after 3 responsibilities · 1 needs you

NEEDS YOU
Nightly import: proposed repair would change its source URL. Review repair →

WHAT CHANGED
The selected library now supports your target platform.
I updated 2 generated notes; one plan assumption needs review. See evidence →

Knowledge [1 update]   Research [1 finding]  Projects [Needs review]
Processes [Blocked]   Conversations [Quiet]

LOOKING AFTER
Keep the notebook project moving — comparison ready; next step awaits review
Keep its important knowledge current — checked today; source follow healthy
Keep its automations useful — one blocked import; repair prepared

Continue a conversation · New chat · New note · New project · Everywhere else
```

### Components and their destinations

| Component | What it means | Highlight-worthy examples | Detail destination |
|---|---|---|---|
| Knowledge | What changed in retained understanding | Evidence-backed correction, new useful connection, retracted assumption, authorized note revision | Relevant note/change set or Knowledge view, with scope |
| Research | Questions investigated and important findings | Source-backed answer, consequential conflict, useful lead, investigation needing guidance | Existing expedition/brief or run evidence |
| Projects | Work carried forward toward outcomes | Verified artifact, eligible step completed, changed assumption, review/blocker | Owner-qualified project and its Plan/Runs/Conversation view |
| Processes | Health and usefulness of recurring work | Validated repair, recurring failure incident, retirement proposal, authorized pause/archive | Underlying process and its history/repair or retirement detail |
| Conversations | Threads worth resuming and conversational decisions | Unanswered human question or relevant thread with a concrete next step | Source Chat, Discussion, or project conversation |

Conversations is not a transcript-activity counter. Persona chatter and every new
assistant message do not create component updates. Personal memory remains
inspectable through Settings; Home must not restore a prominent list of inferred
private facts as a proxy for assistant usefulness.

### Component states and highlighting

The card presents separate signals rather than one ambiguous red/yellow/green:

| Signal | Semantics | Persistence/clearing rule |
|---|---|---|
| New updates | Material results the person has not acknowledged | Count canonical update IDs; clear by explicit acknowledgment or an explicit detail-view read action |
| Needs you | An unresolved gate requiring the person | Remains until resolved, cancelled, superseded, or snoozed; acknowledging the text does not resolve it |
| Working | An authorized run currently making progress | Derived from a valid run lease/progress; does not add an unread badge |
| Blocked/degraded | Work or a process cannot meet its contract | Derived from typed current observations; remains even after the incident is read |
| Quiet/up to date | No material unacknowledged update and checks are sufficiently fresh | Never inferred solely from absence of errors |
| Paused | The person or policy paused relevant work | States scope and how to resume; not a failure |
| Unavailable | A required feature/provider/connection is unavailable | Explain the missing capability and offer the authorized setup destination |
| Unknown/stale status | The projection or last assessment is no longer fresh | Show last checked/updated time; never present healthy/zero as a fallback |

Use the highest unresolved severity for the card's primary status text while
retaining separate update and working counts. A component can correctly say
“1 needs you · 2 new updates · 1 working.” It must not collapse those into
“4 alerts.” Theme accents and a static outline/badge supply the highlight;
errors/warnings use semantic tokens with readable labels. The existing `is-live`
styling must not continue to mean “a schedule exists.”

Loading Home, scrolling a card into view, receiving an SSE event, injecting a
notice into a model prompt, or hovering an item never marks it read or handled.
Opening a canonical detail may acknowledge the specific visible version through
an explicit server-side acknowledgment operation. If that detail cannot load,
no acknowledgment occurs. A delivered DM or chat mention records delivery, not
review, and does not clear the Home highlight. “Mark reviewed” and “Mark all reviewed” affect only
the listed authorized update versions, not unresolved approval gates or future
updates. A material revision to a previously reviewed result can become new
again with its own revision identity.

One canonical update may affect several components. The same source-change
investigation can highlight Research, Knowledge, and Projects, but appears once
in the briefing and once in the global unread total. Each component filter may
show it. Acknowledgment from any surface updates the same per-person record;
do not create copies of the notification for Home, Activity, and each component.
Each material update displayed here has one canonical Inbox envelope, referencing
the domain record rather than copying its lifecycle. Home and Activity use the
same per-person read/acknowledgment state. Component counts are filtered counts
of those items, not extra notifications added to the Inbox unread total.

### Inbox and Needs you: one collection, two views

**Inbox is the collection of delivered items. Needs you is its unresolved-action
view.** There is no second Needs-you notification store, independent read state,
or separate set of approvals. The Home queue is a small ranked preview of that
same filtered view; View all opens Inbox with the Needs-you filter selected.

The Inbox offers **All**, **Needs you**, and **Updates** filters on its existing
route. Needs you contains current requests for a human decision/input/action.
Updates contains informational items, not action requests; completed action
requests remain in All/history with their resolved outcome rather than moving
into Updates. Preserve
existing item-kind filters and social/reminder behavior. Suggested work and
ordinary unread findings do not become obligations merely because they exist.

| Example item | Inbox | Needs you | What clears it from Needs you? |
|---|---|---|---|
| Research result with no requested decision | Yes | No | Not applicable |
| Authorized generated-note change, reported afterward | Yes | No | Not applicable |
| Proposed saved-note edit outside the responsibility grant | Yes | Yes | Approve/apply, decline, cancel, or supersede the specific proposal |
| Project step needs the person's answer | Yes | Yes | Answer or otherwise resolve the underlying step gate |
| Repair running within an existing grant | Yes, if a material update was filed | No | The assistant is responsible for the next action |
| Repair exhausted its attempts and asks for direction | Yes | Yes | Decide the next action or close the incident's human gate |
| Invitation awaiting acceptance | Yes, using its existing item | Yes | Accept, decline, revoke, or expire the invitation |

The domain owns the gate: a Plan approval, repair proposal, invitation, or question
is authoritative in its existing/new domain service. One idempotent Inbox envelope
references that gate occurrence. Home, Inbox, and project Needs-you boards render
the same gate and dispatch to the same operation. A project board is the
project-filtered view; it is not another independently maintained task queue.
Existing gates are adopted/backfilled idempotently, not copied on every Home read.
The personal Needs-you filter includes only gates this person can act on.
Project work waiting on someone else is labeled accordingly in project status;
it is not assigned to every collaborator's personal Needs-you view.

An item may contain both a finding and its requested decision. Show one card with
the finding as context and the decision as the primary action, rather than two
Inbox items. Multiple genuinely independent gates have distinct identities; a
summary may group them but must not merge their authority or resolution.

**Read state and action state are independent.** Reading clears the new-update
highlight for that version; an unanswered request remains in Needs you, marked
read. Resolving it in any surface clears it from the active Needs-you view in all
surfaces. Delivery alone does neither. Snooze hides it from the active preview
until due and makes it reachable through Inbox's Snoozed view; it does not resolve
or approve it. A blocked dependency requiring only assistant recovery belongs in
Working/Blocked, not Needs you unless a specific human action is required.

Activity's existing unread badge remains the count of unread canonical Inbox
items. Home labels the unresolved-action count “Needs you”; these counts are never
added together into a combined alert number. Component cards may show their
filtered action/update counts with distinct labels. The same item can belong to
both counts without becoming two items. “Mark all read” never approves, declines,
pauses, or resolves a request.

### Briefing content and ranking

The default brief includes outcomes, justified decisions, and useful next steps,
not a stream of model reasoning or tool events. Each item includes:

- A specific result or change in one sentence.
- Why it matters to an active responsibility, goal, decision, or project.
- Source/destination scope and the acting principal when relevant.
- What was applied, what remains a proposal, and what verification passed.
- Evidence/artifact links, change/restore view, freshness, and cost detail.
- One primary action and secondary actions appropriate to current authority.

Needs-you gates rank by deadline, impact, and the work they block. Findings rank
by current relevance, material novelty, evidence quality, and actionability;
near-duplicates are grouped. Freshness and relevance are rechecked on read and
before delivery. A conclusion that became irrelevant while research ran remains
in history but does not demand a new interruption.

Long-lived unresolved gates must remain reachable through View all even when
they no longer lead the brief. Auto-expiry applies only to defined classes of
informational updates; it never silently declines an approval or abandons work.
Snoozing a finding is different from snoozing a responsibility or pausing a run.

### Actions and feedback

Home offers bounded actions through the underlying domain operation: inspect,
answer a question, review a diff, approve a specific action, continue, cancel,
snooze, pause, and restore when supported. A card click or deep link grants no
new authority. Approval must describe the concrete target, change, audience,
verification, and cost/action limit it authorizes. It cannot approve unseen
future scope by implication.

Feedback distinguishes **useful**, **already knew this**, **wrong inference**,
**less of this topic**, **wrong time**, **keep this wording**, and **stop this
responsibility**. Those meanings affect different systems: notification timing,
work selection, graph correction, or authority. “Wrong time” must not teach
Goobster that the topic is unimportant. Ignoring an item is weak feedback.

### Empty, disabled, and partial states

- **Fresh account:** explain responsibilities with three suggested examples and
  a draft/preview flow. No activity is collected or autonomous work started by
  visiting Home or a tutorial. Keep New chat accessible immediately.
- **No active delegation:** say “Nothing delegated yet.” Do not imply that the
  assistant is monitoring the person's life. Existing reminders and Inbox items
  remain visible in their normal surfaces and relevant Home summaries.
- **Attention disabled:** existing responsibility history is readable, and no
  new initiative starts; current delegated runs stop at the next safe effect
  boundary under the architecture's cancellation/reconciliation contract.
  Explain the actual policy gate before offering enable.
  Re-enabling Attention alone must not recreate revoked responsibilities.
- **Feature off:** display the relevant component's unavailable state without
  inviting an operation that cannot run. Installation-wide disabled features may
  be collapsed after explanation, not disguised as empty successful results.
- **No provider, no network, or no connection:** local records remain usable;
  distinguish tasks still possible from blocked investigation/execution.
- **Budget exhausted:** show waiting/paused with the applicable reset or review
  condition. Do not spend more to generate a decorative status summary.
- **Partial failure:** other components stay usable; the failing component shows
  unknown/unavailable and its last trustworthy timestamp.
- **Quiet day:** a short “No important changes” with last assessment time; no
  invented daily summary or compulsory model call merely to fill space.

### Accessibility and presentation

- Every state has text and an icon/shape in addition to color; counts have
  accessible names stating whether they are updates, gates, or active work.
- Component cards are normal keyboard-operable links/buttons with visible focus.
  Actions inside a card are not nested interactive elements inside a button.
- Announce significant asynchronous state transitions through a polite bounded
  live region; do not repeatedly announce polling or reorder focused elements.
- Honor reduced motion; no continuous pulsing, flashing, mandatory hover, or
  animation-dependent interpretation. Optional motion never signifies unread.
- Preserve stable component order and focus across refreshes. New ranked items
  can show a “New updates available” affordance rather than jumping under focus.
- Use existing palette, surface, layout, safe-area, and navigation tokens; support
  both sidebar and top navigation and light/dark/neutral/tinted surfaces.
- Small screens retain all actions and evidence links; a visual map, if added
  later, is an enhancement to the equivalent semantic list.

## 5. Opportunity selection and authority

Activity produces bounded candidates with original source references, speaker,
related goal/project, expected value, uncertainty, and a deduplication key.
Conversation batches settle before expensive analysis; foreground conversation
activity damps interruptions. A durable scan catches changes missed by transient
events. The complete personal memory is not sent to a model on each heartbeat.

Retrieve existing graph knowledge and current projects/research/processes before
commissioning work. Prefer completing useful existing work to proliferating
projects. A candidate needs a concrete expected result and a no-progress stop
rule. Repeat investigations require changed evidence or a declared recheck
condition, not merely a new model-generated summary.

Activation uses an explicit source-history baseline and a previewed bounded
lookback. Resuming observes that same authorized window; catch-up outside its
scope or effect limits needs a new preview/review. Old conversations do not
silently become new instructions. Stable deduplication survives pause/resume.

Intent uncertainty and factual uncertainty are different. Research can resolve
the latter. Only a human instruction or applicable responsibility resolves
authority. A persona's speculation is not a human commitment; repeated summaries
do not corroborate their own claims. Inferred interests decay independently of
truth confidence and may be corrected or excluded by the person.

Effective authority is the intersection of installation feature state, current
account/project/resource access, personal preferences, applicable responsibility
revision, action/target limits, and any required approval. Urgency may alter
delivery timing; it never increases action authority.

## 6. Knowledge stewardship

The sequence is existing knowledge → explicit gap/conflict → focused research →
persisted evidence → versioned change set → authorized application → impact
review. Existing Expedition sources/claims and the graph legalizer are extended;
there is no second knowledge store masquerading as a research backlog.

| Finding | Intended behavior |
|---|---|
| Confirmation of an existing claim | Attach independent evidence without duplicate note or repeat interruption |
| Useful new information | Add a sourced generated/provisional note in the authorized scope |
| Time-dependent change | Record validity and supersession rather than declaring historical knowledge false |
| Conflicting evidence | Preserve alternatives, confidence limits, and dispute; do not silently replace the person's wording |
| Invalid connection | Retract/revise the connection with evidence and history |
| Duplicate representation | Merge only with compatible identity/time/claim meaning and a restorable mapping |
| Irrelevant generated material | Archive according to delegation, retaining useful provenance |
| Permanent deletion | Require the explicit deletion grant, inspect dependencies/mirrors, and honor privacy erasure semantics |

`saved` continues to mean human-retained knowledge under [ADR 0008](adr/0008-knowledge-curation-contract.md).
Autonomous findings must declare their distinct generated/provisional intent.
Age or low retrieval frequency does not reduce truth confidence by itself.
Human edits and deliberate saves receive protection; selected direct edits can
be delegated explicitly with diff/history and revision checks.

All automated maintenance must pass one policy-aware mutation boundary. An
old background pruning path must not bypass those protections after an otherwise
non-destructive research write. Similarity alone is not proof that two claims
are identical. Edges require evidence/history as well as notes.

Personal notes, persona notes, and project knowledge retain their scopes.
Private-to-shared transfer uses explicit publication with audience preview;
reading private context does not authorize publishing it. Loss of a source or
its evidence prompts a dependent-claim review, not an unexamined cascade of
deletions. Ordinary undo cannot resurrect privacy-erased personal data.

## 7. Carrying project work forward

**Shipped in DA-4a:** delegated execution of the assistant steps of an
approved, started Plan, with its own authorization record, verification
before a step is done, and an explicit actor and payer
([delegated_plan_steps.md](delegated_plan_steps.md)). Initiatives that
originate from conversations, and the handoff back to the originating
conversation, are still planned.

Ordinary Chat, Parlor, and project conversations can originate an initiative.
It retains the original human statements and routes to an existing project,
plan, expedition, or process when possible. Unrelated suggestions stay candidates
rather than occupying the project's single open Plan slot.

An explicit instruction supplies bounded intent; a clear standing responsibility
can authorize subsequent eligible steps. Speculation may justify quiet research
but is not an approved implementation plan. Persona discussion is a source of
hypotheses, not a way to create user consent.

Current human-originated Plan approval/final acceptance and frozen revisions
remain valid contracts. Delegated execution may advance eligible steps in an
approved active Plan; a changed objective or materially changed approved plan
returns to review. If later work allows a responsibility to authorize new plan
classes, it must introduce a distinct explicit authorization contract rather
than fabricate the existing human receipt.

Agent runs are durable resources linked to plans and their child sandbox jobs,
expeditions, and watches. They checkpoint progress and reconcile uncertain
external actions before retrying. Background work must yield scarce capacity
to the person's foreground interaction and must not monopolize normal chat locks.

Project artifacts and decisions belong in the project, with deliberate result
visibility. The originating conversation receives a concise link/handoff rather
than an unrelated private conversation being created solely by matching title.
Source context may remain private while shareable results are published under
separate authority. Every run has an explicit actor and payer.

## 8. Recurring-process stewardship

Assess execution health and continued usefulness independently. A quiet monitor
can be valuable; a technically successful daily report can have outlived its
purpose. No output change and unread messages are not sufficient evidence of
failure or obsolescence.

Process adapters expose existing automations, project triggers, watches,
CI watches, source follows, and recurring research. Their original services keep
execution and permission authority. A purpose contract declares expected cadence,
freshness, useful outcomes, quiet behavior, dependencies, owned outputs, stop
conditions, criticality, and repair/retirement grants. Legacy unknown purpose
remains unknown until established.

| Observation | Interpretation and response |
|---|---|
| Daily import exits successfully but produces stale data | Degraded output; diagnose the failed freshness contract |
| Monthly report has not run for three weeks | Healthy if its next occurrence is not due |
| Monitor sees no changes for months | Healthy if silence is expected; review cadence separately |
| CI watch targets merged/deleted branch | Evidence for retirement under its purpose/retention policy |
| Credentials revoked | Blocked; request reconnection rather than rewriting credentials |
| Provider outage affects many tasks | One grouped incident with dependent blocked work |
| Person ignores reports | Weak relevance signal; offer review, do not infer deletion authority |

Repair is **diagnose → bounded patch → verify intended output → resume → observe**.
Verification includes freshness and declared outputs, not just successful tool
dispatch. Failed verification rolls back where possible and escalates at the
attempt cap. Permanent external effects must be described honestly.

Retirement is **candidate → pause → archive → optional cleanup**. A person may
authorize those stages independently. Pause stops new launches and fences pending
claims; active work follows explicit cancellation semantics. Archive retains
definition/history/restoration information. Cleanup names exact exclusively
owned resources and checks dependents first. Shared files, evidence, and useful
notes are protected by their own retention/authority contracts. Existing remove
APIs that immediately delete history are not the first retirement operation.
Restoring an archived process restores it paused. Recheck current access,
dependencies and grants before explicit resume, and disclose any artifacts that
permanent cleanup has made unavailable to restore.

**Available:** pause, resume, archive, restore and exact cleanup of a process
by its owner; pause and archive by the assistant under a responsibility that
names that process; and a request, answered on Home or in the Inbox, when
there is none
([process_stewardship.md](process_stewardship.md#retiring-a-process)). Repair
and cleanup by the assistant are planned.

## 9. Further capabilities in the same loop

- **Assumption monitoring:** track consequential assumptions behind active work;
  a changed source triggers a targeted review of affected decisions and steps.
- **Decision memory:** preserve rationale, alternatives, evidence, and “revisit
  when” conditions using the project's decision/evidence seams.
- **Direction changes:** new human steering supersedes queued work and identifies
  downstream assumptions to reassess; do not just append a conflicting note.
- **Preparation and resumption:** before a related conversation, assemble the
  useful changes, outstanding decisions, and next step under current access.
- **Duplicate/cost control:** consolidate overlapping work and reduce wasteful
  cadence without removing useful insurance tasks such as backups/monitors.
- **Responsibility review:** check whether delegation still serves its objective;
  it must not perpetuate itself through self-generated activity.

These are extensions of the same records and policies, not separate autonomous
agents with unrestricted shared memory.

## 10. Cross-cutting behavioral requirements

- Store source/run lineage and root cause. A generated note may cause an impact
  review but cannot become independent evidence of user interest or repeatedly
  trigger the same investigation.
- Check current authority before spending, reading private material, mutation,
  publication, and notification. Revoked membership cannot leak through cached
  summaries, counts, component badges, or existing browser streams.
- Budgets for work and interruption are separate. Muting contact does not grant
  work permission or imply all work should stop. Revoking work authority does.
- Record verified outcomes, accepted results, corrections, and uncertainty.
  Tool calls and generated notes are activity, not proof of progress.
- Settings/feature failures are visible truthful states; no provider-specific
  autonomous behavior that bypasses the common provider/tool contracts.
- Runs, evidence, findings, projections, and cached packs join transparency,
  retention, and erasure from the increment in which they are introduced.

## 11. End-to-end acceptance journeys

### A. Source change updates understanding and project work

A source followed for an active project changes. Goobster finds related graph
notes and a plan assumption, conducts a focused investigation, persists evidence,
and applies only authorized generated-note changes. A saved-note revision awaits
review if not delegated. Home highlights Knowledge, Research, and Projects from
one canonical update; the briefing shows it once. Opening the change detail
acknowledges that version but leaves the project review gate unresolved.

### B. Conversation becomes authorized progress

A human discusses a concrete next step in project chat. The applicable
responsibility allows research and eligible active-plan execution. Goobster
deduplicates against current work, starts a durable run, produces a verified
artifact, and links it to the step. A new human instruction changes direction;
queued downstream work is superseded and the run pauses at its next effect
boundary. Foreground chat remains responsive. Home shows the actual outcome,
not a completed-task claim based only on a successful tool response.

### C. Broken import is repaired or escalated

Three eligible import occurrences fail their output contract. A grouped incident
identifies the dependent dashboard. With an allowed repair grant, Goobster patches
the owned script, validates fresh output once, resumes, and observes the next
normal occurrence. Without that grant, Home offers the concrete repair for
approval. Failed validation retains the incident, rolls back if possible, and
stops at the attempt cap. Reading the incident does not make Processes healthy.

### D. Useful quiet process and obsolete process differ

A low-frequency monitor with no changes remains healthy and produces no badge
noise. A branch watch whose purpose is satisfied becomes a retirement candidate.
Within its grant it pauses and archives with an undo path; cleanup handles only
the declared owned temporary resources after dependent checks. Its historical
research evidence and saved notes remain available.

### E. Authority, concurrency, and partial availability

A user edits a note during investigation: the stale mutation refuses and is
reassessed. A collaborator loses project access: queued work and Home projections
recheck membership and reveal no old title/count/content. A provider becomes
unavailable: Home remains useful from local records, Research shows the blocker,
and Knowledge is not incorrectly marked empty or current.

### F. Review and delivery are consistent across surfaces

One update appears in Home and Activity, with several component associations.
Loading either surface changes no acknowledgment. A deliberate read acknowledges
the visible version across devices. A new material revision becomes new again.
An unresolved Needs-you gate remains. An unrelated chat does not consume a
pending conversational update merely because it was injected into a prompt.

### G. Inbox and Needs you do not become competing queues

An investigation produces a useful finding and a saved-note correction needing
approval. One Inbox item presents the finding and the specific decision. Home's
Needs-you preview and the relevant project board show that same gate. Reading
the item clears its component update highlight but leaves the action visible.
Approving from the project resolves the gate everywhere. Mark all read affects
neither the proposal nor other pending decisions. A read informational finding
never enters Needs you, and background-only recovery never asks for a human
unless an actual human action becomes necessary.

## 12. Evaluation and remaining design choices

Pilot quality is measured by verified project progress, useful knowledge
corrections, unwanted actions, rollback/correction rate, human orchestration
avoided, interruptions, total resource cost, and foreground responsiveness.
Record negative and no-action outcomes. Model/tool-call counts are diagnostic,
not success metrics.

Implementation review must still choose and record numerical budgets/caps,
review cadences, generated-knowledge storage representation, exact API/type
names, and visual treatment within the existing design system. Those choices
cannot weaken this document's authority, audience, acknowledgment, verification,
or quiet-default contracts. Cosmetic changes do not reopen settled delegation
boundaries.

## 13. Planned: talking to it and hearing from it

**Status: planned; four items are available** (answering a request on Home
and in the Inbox, repository work, findings shared with a project, and "For
the host" at the end of this section, each marked below); nothing else here
is. Increments DA-7 through
DA-12. The technical contracts are in
[architecture section 13](delegated_assistant_architecture.md#13-planned-extensions-beyond-the-first-pilot).

### Delegating and steering by conversation

- Saying what you want looked after, in chat or by voice, produces a
  **draft** shown back to you: what it would look after, exactly what it
  could do, until when, and whether it would start work by itself. Nothing
  is active until you confirm that card.
- The assistant asks for the narrowest authority that covers the request
  and says what it left out ("I have not asked to edit files").
- You can ask what it is working on, why it did something, what it changed,
  and what it was refused. Answers come from its records.
- You can stop a piece of work or pause a responsibility by saying so. The
  assistant can never start, resume or widen one by itself.
- A request can be answered where you see it: on Home, in the Inbox, in the
  notification or in chat. The choice shown is the concrete decision, with
  what it will change. **Available on Home and in the Inbox** for a friend
  request, a request to join, a mission plan to approve or start and a
  process that may no longer be needed
  ([assistant_home.md](assistant_home.md#deciding-a-request-where-it-is-shown));
  the notification and chat are planned.
- A spoken briefing tells you what needs you and what changed. Hearing it
  does not mark anything reviewed.

### Noticing more

- Work can be proposed from a request you made in conversation, something
  new in a source you follow, a run that failed, or a CI result, always
  inside a responsibility that covers it.
- An idea you merely mention is not a commitment and proposes nothing.
- Each source has a small daily limit; many changes become one proposal.

### Reaching you

- The overview updates while you look at it.
- Each responsibility has an interruption setting: quietly on Home, in one
  daily digest, or immediately for requests that block its work.
- Anything that reaches you outside the portal respects your Attention
  contact limit, cooldown and quiet hours. Findings never interrupt.
- At most one digest a day, and none on a day with nothing in it.

### Learning from you

- Each finding offers: useful, already knew this, wrong, less of this,
  wrong time, keep this wording, stop this responsibility.
- Each means one thing and changes one thing; "wrong time" never teaches
  the assistant that the topic is unimportant.
- What it has learned is shown per responsibility and can be reset. It
  changes how often work is proposed, never what the assistant may do.

### Doing more

- Repository work on named branches, never the default branch, never forced.
  **Available (DA-11a)** to the installation's owner while it is in the
  pilot: a responsibility can commit, push and open pull requests in a
  repository cloned into its project, at most a few times a day, and tells
  you that a push or a pull request cannot be undone
  ([delegated_runs.md](delegated_runs.md#repository-work)).
- Suggested edits to notes you saved, shown as a diff you apply; connecting
  and archiving notes, both restorable.
- Findings shared with a project's current members, with the author shown.
  **Available (DA-11c)** to the installation's owner while it is in the
  pilot ([delegated_project_findings.md](delegated_project_findings.md)).
- Outside services one named resource at a time, each with a plain list of
  what it reads and writes. There is no "watch everything" option.
  **The framework is available (DA-11d)** to the installation's owner while
  it is in the pilot, but no service is installed: the owner has not named
  one ([delegated_connectors.md](delegated_connectors.md)).

### For the host

**Available** (Host → Delegated work;
[delegated_operations.md](delegated_operations.md)):

- A view of delegated work across the installation without any private
  text, with caps and a stop-all control.
- Everything in this section that is not available yet starts with the
  host's own account only when it arrives. The host opens it to everyone by
  recording the pilot decision on the same page, and can close it again.
  Answering a request on Home and in the Inbox is already open to everyone.
- An optional evaluation the host can run against a real provider
  ([delegated_evaluation.md](delegated_evaluation.md)): fixed, fictional
  responsibilities, including a page and a file that tell the run to exceed
  its grant, recorded with the model and prompt version used. It spends
  real tokens and never runs by itself.

The [implementation plan](delegated_assistant_implementation.md) tracks which
increments actually land. Update shipped behavior documentation in the same
increment; this planned spec alone must never make Goobster claim a capability
is available.
