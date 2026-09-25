---
title: "Guided tutorials and onboarding"
kind: decision
summary: Per-account, per-room tutorials with safe demonstrations, independent skip/resume/reset, versioned progress, user documentation, accessibility, and a full service curriculum. F1 ships the framework (state machine, API, Settings, provider shell); F2 authors the demonstration tours.
tags: [tutorials, onboarding, settings, accessibility]
---

# Guided tutorials and onboarding

**Status: #266 adds the provider-free `home.first-task` practice workflow (observed sessions pending); F1 framework shipped; F2 demonstration tours shipped for `home.orientation`, `chat.basics`, `knowledge.basics`, and `projects.apps`.** This document is the contract for launch rules, the catalog, state and API, accessibility, and feedback. Increment F1 implements the state machine, endpoints, Settings list, and provider shell. Increment F2 authors the chat → note → project curriculum samples and those four tours; The #272 additions author Research, Projects basics, Plans, Runs, Inbox and Scheduled v2 with Back and fixed-signal feedback; unimplemented catalog entries stay empty until a later package.

Updated: 22 September 2026.

Parent plan: [shared-instance product design and rollout](shared_instance_product_spec.md).

All sample content must remain isolated from real user data and external actions. Tour events touch only the `tutorial_*` tables — they never spend a provider call, send an invitation, or write user knowledge.

## Launch, skip, and reset rules

- The first successful login opens a short Home orientation once. Use a nonblocking guide panel so the user can explore or dismiss it.
- Each room/service starts its own tutorial on first entry, once its permissions, feature flags, and UI are ready. Opening one room must not complete another room's tutorial.
- Show **Back**, **Next**, **Skip step**, **Skip this tutorial**, and **Pause** throughout. A final step has **Finish** instead of Next. (F2 ships Next / Skip step / Finish on authored tours; Back is now available on active authored tours. It reopens the previous available step without undoing notes or other explicit actions.)
- Skipping a step records a skip, not a completed exercise. The user can finish with skipped steps and revisit them later.
- Skipping an entire tutorial leaves other tutorials eligible. It does not silently disable all onboarding.
- Pause or Escape saves position. Returning shows a Resume affordance; it does not seize focus repeatedly.
- Settings → Tutorials lists each tour, its progress, and controls to Resume, Replay, or Reset. Offer Reset all and an account-level auto-start toggle. Resetting tutorials does not change user content, permissions, or `appearance.hiddenToolRooms`.
- Resetting one tour makes it eligible on its next entry. Reset all resets the orientation and all tours; it does not open all of them simultaneously.
- Existing users receive an unobtrusive offer to take the new tours. Do not classify every migration as a first-ever login and interrupt active work.
- Public read-only share pages do not start account tutorials or require registration to read an already authorized public share.

## Teach with a safe example

Use a small “Weekend field notebook” example: a question, two tagged notes, a source, a private project, one completed run, and an output. Reuse the same fictional content across Chat, Knowledge, and Projects so their relationship becomes visible.

**F2** supplies the fixtures (`packages/core/config/tutorialSamples.js`) and demonstration actions for the four authored tours. Tour examples are isolated from real knowledge retrieval, personal memory, usage accounting, notifications, and external side effects. Demo actions never send messages, make provider calls, run code, or schedule real work. A separate **Keep this example** action (`POST /api/app/tutorials/keep-example`) can copy selected material into the account after a clear preview; skipping or resetting does not create duplicate real data. Tour *events* only mutate `tutorial_progress` / `tutorial_events` — they never call Keep.

Each major feature needs a demonstrated action, a visible result, and an explanation of where the result lives. A tooltip that only describes a button does not satisfy the requirement. Optional live practice may follow the example, but real work must be explicitly initiated through the normal product controls.

## Tutorial catalog and coverage

Stable tutorial ids live in `packages/core/config/tutorialCatalog.js` and are listed on each room in `apps/web/src/lib/rooms.cjs`. Core never imports the web registry; `tests/portalRooms.test.js` and `tests/tutorialFramework.test.js` fail when the two lists drift. Clients cannot invent tutorial ids or step ids.

The steps below are the minimum authored curriculum. Every semicolon-separated action becomes a stable step or an explicit subordinate tour. Advanced topics link to user-facing help; the rightmost column identifies existing source material to adapt, not a claim that the future help route already exists. **F2 ships steps for `home.orientation`, `chat.basics`, `knowledge.basics`, and `projects.apps`**. #266 adds `home.first-task`; #272 adds `knowledge.research`, `projects.basics`, `projects.plans`, `projects.runs`, `activity.inbox` and `activity.scheduled`. Other ids keep an empty `steps` array so the Settings list and state machine still work. A tutorial with no applicable steps does not launch.

| Stable tutorial ID | Required demonstrations | Advanced overview and documentation source |
|---|---|---|
| `home.orientation` | Identify Chat/Knowledge/Projects; inspect Private audience; follow the example from chat to note to project; locate Activity; find personal settings and tutorials. | Hosting/provider boundary and optional tools. New `documentation/user-guide/getting-started.md`. |
| `chat.basics` | Send a sample prompt; inspect sources/tool activity; attach a sample file; stop and queue a reply; revisit/search history; save an answer as a note; add a result to a project; compare private sharing and an explicit public share; preview voice and incognito controls. | Branching/edit/regenerate; model/reasoning settings; retention semantics. `webapp_setup.md`, `user_settings.md`, `session_management.md`. |
| `knowledge.basics` | Create/edit a note; add shared tags and inspect the map; search/filter notes; inspect a source/claim/evidence chain; add selected knowledge to a project; open Research; locate Personal memory separately. | Tag hierarchies, conflicting evidence, reflection and provenance. `user_knowledge_graph.md`, `spitball_expeditions.md`. |
| `knowledge.research` | Set a sample question and destination; inspect a bounded research plan; advance a simulated run; pause/continue/cancel the example; inspect claims and sources; review the resulting notes and limits. | Recursive continuation, research lenses, evidence quality and budget policy. `spitball_expeditions.md`. |
| `projects.basics` | Create a sample goal; inspect project scope; add a note; open the project conversation; inspect files/apps; review the plan; view a run and output; preview inviting a collaborator and revoking access. | Checkpoints, output contracts, triggers and reproducibility. `projects.md`. |
| `projects.plans` | State a goal and success criteria; review proposed steps; distinguish human approvals from automatic steps; approve a simulated step; inspect evidence; handle a failed or blocked step; review the conclusion. | Decision records, mixed evidence, retry policy. `projects.md` sections on Missions. |
| `projects.runs` | Inspect a queued example; start its simulation; inspect logs/output; cancel a second simulated run; inspect resume/retry choices; verify a required output before accepting a result. | Resource limits, checkpoints, isolation, uncertain external outcomes. `projects.md`, `code_sandbox.md`. |
| `projects.apps` | Open an unfiled generated app; inspect its origin; add it to the sample project; inspect source/version; preview changes; inspect sharing audience. | App permissions, host bridge limits and embedded-content boundaries. `projects.md`, relevant applet implementation docs. |
| `discussions.basics` | Create a discussion; choose a sample persona; address a persona with a mention; compare human and AI participants; inspect the discussion's knowledge sources; preview an invitation; inspect/curate persona notes; preview text/voice mode. | Persona memory, project-linked membership, live voice, manual versus automatic speaking. New user guide based on Parlor services/UI. |
| `activity.inbox` | Open a sample result; follow it to its source; inspect why it appeared; acknowledge/snooze/dismiss; answer a sample approval; locate quiet hours and proactive controls. | Notice ranking and attention enrollment. `attention.md`, `user_settings.md`. |
| `activity.scheduled` | Create a sample one-time reminder; set timezone and preview delivery; configure a recurring AI task; inspect next run; pause/resume; inspect result and delivery failure; delete the sample task. | Cron, recurrence/DST behavior, retries and budgets. `commands.md`, `user_settings.md`; new scheduling user guide. |
| `tools.overview` | Discover an optional tool; inspect prerequisites; open its tutorial; hide or show a tool in navigation; return to the core workspace. | Per-account visibility versus host availability. New tools guide. |
| `music.overview` | Start/stop sample audio intentionally; adjust volume; discover eight modes; move a sample progression between compatible modes; save a sample preset; inspect which data stays on the device. | Imported samples and composition storage. New Music Lab guide. Mode tours below are independently skippable. |
| `music.intervals` | Choose two notes; hear ascending/descending intervals; compare a second interval. | Ear-training and interval interpretation. |
| `music.chords` | Select a chord/voicing; build a small progression; audition it. | Custom harmony and diatonic substitutions. |
| `music.rhythm` | Change meter and tempo; compare swing/polyrhythm; start and stop a pattern. | Euclidean patterns and tap timing. |
| `music.harmony` | Build a harmonic sequence; inspect its visual relationships; hear a resolution. | Harmonic organisms and training modes. |
| `music.space` | Select notes; switch spatial representation; audition an interval. | Modes and geometric views. |
| `music.melody` | Select a contour; change a melodic parameter; play and transfer the example. | Contour libraries and generative constraints. |
| `music.stage` | Select performers/instruments; assign sample parts; play and adjust the arrangement. | Performance orchestration and voice design. |
| `music.studio` | Create from a sample/template; inspect tracks and sections; edit a phrase; play and export a sample composition. | Song structure, sample management, and arrangement. |
| `trading.basics` | Identify the guild and game currency; inspect a sample portfolio; inspect a quote; simulate an order; inspect positions and ledger; cancel a simulated pending order. | Margin, shorts, options, futures, predictions, and rule differences. `jimbucks_exchange.md`. No real game trade occurs in a tour. |
| `decks.basics` | Import a sample deck; inspect unresolved cards; organize into a folder; inspect main/side/commander boards; rename and export. | Formats and collection integration. New user guide based on `DecksRoom.tsx` and MTGA service. |
| `usage.basics` | Change period; inspect model/operation usage; distinguish estimates from limits; inspect a queued/quota example; find a lower-cost or paused option. | Host resource policy and budget attribution. `user_settings.md`; new usage guide. |
| `settings.basics` | Change a sample display preference; preview model/voice choices; inspect memory and retention; set quiet hours; inspect connections/devices; find tutorial reset and replay. | Device/account/project/guild scope; export/delete distinctions. `user_settings.md`. |
| `memory.basics` | Compare transcript, personal fact and saved note; inspect why a memory exists; preview a correction/deletion; adjust future memory behavior; preview an export and account deletion scope. | Vector cleanup, retention and shared-copy semantics. `user_settings.md`, `user_knowledge_graph.md`. |
| `connections.basics` | Inspect an available integration; preview connection and permission scope; select a delivery destination; disconnect the sample integration without deleting account data. | Provider credentials and guild access. `webapp_setup.md`, integration-specific setup docs. |

Host-only administration gets a separate `admin.instance` tour: issue/revoke an invitation, disable a sample account, inspect aggregate capacity, set a quota, and review a failed integration. It cannot appear to ordinary accounts (F1 enforces this on the catalog and API).

## Detailed example: Knowledge tutorial

| Step ID | User action and visible result | If skipped |
|---|---|---|
| `create-note` | Save a provided observation about a field trip. A sample note appears with a title, body and Private label. | Load the same fixture for the next demonstration without writing real data. |
| `connect-tags` | Add `observation` to two notes. Switch to Map and show the shared tag connection. | Keep the sample tags; record this exercise as skipped. |
| `inspect-evidence` | Open a sample researched claim and its source. Clearly distinguish source text from the generated interpretation. | Continue with evidence inspection still available from Help. |
| `reuse-in-project` | Add a selected note to the sample private project; follow the reference. | Do not add a real project or grant access. |
| `research-run` | Open the Research tour entry point and inspect a short finished example. The full research tour can start now or later. | Research retains its own untouched tutorial state. |
| `memory-boundary` | Compare a saved note with the assistant's personal memory controls. Show that deleting one does not implicitly delete every representation. | Finish with this step recorded as skipped. |

## Tutorial state and API contract

Server state is authoritative across devices. A browser cache is only a performance aid.

```ts
type TutorialProgress = {
  accountId: string;
  tutorialId: string;           // stable across visible renames
  version: number;
  generation: number;          // incremented on reset
  revision: number;            // optimistic concurrency
  status: 'not_started' | 'in_progress' | 'paused' |
          'skipped' | 'completed' | 'finished_with_skips';
  currentStepId: string | null;
  completedStepIds: string[];
  skippedStepIds: string[];
  unavailableStepIds: string[];
  updatedAt: string;
};
```

Store one progress row per account/tutorial/version with explicit transitions (`packages/core/services/tutorialService.js`, tables `tutorial_progress`, `tutorial_events`, `tutorial_preferences`, `tutorial_feedback`). The catalog is versioned content in source control: tutorial ID, room ID, capability requirements, stable step IDs, anchor IDs, sample scenario, completion event, and user-help document ID. Clients cannot invent tutorial IDs or mark an arbitrary account complete.

Endpoints (account from the session):

- `GET /api/app/tutorials`: permitted catalog, progress, and auto-start preference.
- `POST /api/app/tutorials/:id/events`: event ID, generation, expected revision, step ID, and action (`start`, `complete_step`, `skip_step`, `pause`, `skip_tutorial`, `finish`).
- `POST /api/app/tutorials/:id/reset`: increment generation and clear progress for that tutorial.
- `POST /api/app/tutorials/reset`: reset all permitted tutorials atomically.
- `PATCH /api/app/tutorial-preferences`: change auto-start without mutating completion history.

Events are idempotent. A stale tab cannot resurrect progress from before a reset; reject mismatched generation/revision and reload. Capability-unavailable steps are recorded separately and do not falsely imply demonstrated skills. A tutorial with no applicable steps does not launch. Text-only edits retain version; material step changes create a new version with an explicit progress migration. Never replay all tutorials on every deployment.

Tutorial progress and feedback rows are per-user data: `privacyService.forgetUser` / `auditUser` / `buildUserReport` cover them.

## UI integration and accessibility

`TutorialProvider` and `TutorialPanel` mount inside the authenticated account scope (`apps/web/src/tutorials/`). Resolve room IDs from the route registry. Add stable `data-tour` anchors to actual controls rather than selectors based on translated labels or brittle CSS structure. F1 targets existing anchors; add an anchor only where a step has nowhere to point. Missing anchors explain themselves and offer skip or continue — never spin forever. A tutorial failure must not break the room.

The guide is nonmodal during exercises. When a real product dialog opens, the guide coordinates with it instead of adding a second focus trap. Use labeled controls, sensible focus restoration, keyboard operation, and a progress announcement after deliberate step changes. Escape pauses the tour; it does not delete content. Real modal dialogs should follow [WAI's dialog focus and keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

On mobile, use an in-flow guide card or a collapsible sheet that never covers the target control. Support reduced motion, zoom, narrow screens, and screen-reader-only traversal.

## Documentation and product quality feedback

Serve version-matched user guides from the app, including offline/self-hosted deployments. A manifest maps tutorial `docId` values to allowlisted user-facing pages. Build checks reject broken IDs and anchors. Existing operator/setup docs can supply material, but should not be linked indiscriminately into user tours or seeded into a public corpus.

Offer optional per-step feedback: “Unclear,” “Couldn't find it,” and “Didn't work,” plus free text. Record tutorial version, step, route, capabilities and error code; do not collect chat/note contents by default. The `tutorial_feedback` table exists for erasure/transparency; the three fixed-signal feedback controls now ship with authored tours. Free text and capability/error diagnostics remain deferred; the API deliberately accepts no content-bearing diagnostics. Record aggregated starts, completions, skips, pauses and failures. Skips alone do not prove bad design. Combine them with observed usability sessions and failed task completion.

Acceptance criterion for the redesign: a new person can explain what becomes a conversation, note, memory, project, and output, then perform one cross-feature task without the host narrating every click.

## Release acceptance

The [parent plan's validation matrix](shared_instance_product_spec.md#10-validation-plan) applies in addition to these tutorial-specific gates:

### F1 (framework) — shipped

- Every enabled user-facing room/service is mapped to a stable tutorial ID; capability-gated and host-only tours cannot launch for unauthorized users.
- First login and first room entry offer only the eligible guide; completing or skipping one never changes another tour's progress.
- Skip step, skip tutorial, pause/resume, reset one, reset all, and auto-start preferences work across reloads (API + Settings).
- A stale tab cannot overwrite a reset; retried events cannot advance a tour twice.
- Tour events do not call providers, send messages, create schedules, consume quotas, or contaminate memory/retrieval.
- Missing anchors, unavailable features, and tutorial-service failures leave the room usable.
- Tutorial progress and feedback rows are erased by `/forget-me` and listed by the transparency report.
- `tests/tutorialFramework.test.js` on SQLite and Postgres; `e2e/tutorials.spec.js` (no provider).

### F2 (authored tours) — shipped (sample subset)

- `home.orientation`, `chat.basics`, `knowledge.basics`, and `projects.apps` each have demonstrated actions and inspectable in-panel results (Weekend field notebook). Remaining curriculum rows stay empty until a later package.
- Demo fixtures stay out of retrieval; **Keep this example** is explicit and idempotent on note title.
- `tests/tutorialFramework.test.js` covers keep/skip/isolation; `e2e/tutorials.spec.js` covers demos, skip step, Keep, and Finish (no provider).
- Keyboard, screen-reader, narrow-screen, zoom, and reduced-motion journeys against every remaining room's authored steps are deferred with those tours.


## First research task (#266)

Home → **Start or resume first task**, or Settings → Tutorials → **Your first research task**,
launches `home.first-task` v1. This is a six-action practice task, using fictional Weekend
field notebook evidence: choose the sample question in Chat; run one prepared sample
pass in Research; inspect the source and distinguish an observation from a generalization;
preview and explicitly keep one private sample note in Notes; accept the sample brief;
download its Markdown output. Room links take the person to the relevant surface before
the task action is available. The brief is clearly marked fictional and is not a live
Expedition artifact or a research-quality baseline result.

There are no provider calls, paid reservations, notifications, execution or scheduling.
Only **Keep this example** writes Knowledge, through the existing account-scoped,
idempotent sample-copy API. Everything else writes existing tutorial progress/events.
The output download stays on the person's device. Memory learning, Attention enrollment,
permissions and sharing remain unchanged. Live research is a separate, explicit action:
Knowledge → Research → New expedition → Focused; inspect the displayed cycle/source/note
limits before starting. Live research and brief generation require a configured provider.
A missing provider or failed live run is never silently replaced with sample output.

Pause, Skip step, Skip this tutorial, Resume and Reset use the existing framework.
The task advances in order; a generic Finish event cannot bypass its actions, and an
export completion requires sample acceptance. Skipping acceptance leaves export available
only to skip. A reset starts a new generation, preserving notes explicitly kept earlier.
A download action records the browser's download request, not proof that the file was
opened or used. It does not imply completion without human help.

### Observed first sessions (human acceptance still pending)

Attach at least five observed sessions to #266. Obtain the participant's agreement;
use anonymous session labels and avoid copying personal research content into GitHub.
Record each session using this blank template (no sessions have been observed here):

| Field | Record |
|---|---|
| Session label and date | |
| Mode | Fictional practice / live topic |
| Prior familiarity | |
| Started at / first accepted output at | |
| Active elapsed time / pauses | |
| Completed without help? | Yes / no, and what help was needed |
| Step where they stopped or hesitated | |
| Output accepted, exported, actually used? | Separate answers |
| Returned to the same topic within seven days? | Date / no / not yet observed |
| Main obstacle and proposed change | |

Existing `tutorial_events` timestamps for `start` and `complete_step` on `accept` can
support elapsed-time measurement. Match account, tutorial ID, version and generation;
use the earliest start and first acceptance within that generation. Pauses inflate wall
time, so record active time separately. `currentStepId`, skipped steps and status locate
stopping points; they do not establish why a person stopped. Tutorial data is covered by
existing account report, audit and erasure. No new analytics store is introduced.

Keep #266 open until the five real observations are attached. Do not count this sample
task's acceptance toward #254/#265's live brief metrics or #267's owner quality baseline.


## Research tour and recovery controls (#272, first PR)

`knowledge.research` v2 authors six safe demonstrations: question/budget, progress/stop,
source/claim verification, explicit Keep, brief review/export, and failure recovery.
All demonstrations remain usable without a provider and never start a real Expedition.
The live prerequisites (host enablement, configured provider, remaining budget) are
explained, not bypassed. Missing live capabilities do not turn a sample into real work.
The next slice authors Projects basics, Plans, Runs, Inbox and Scheduled (below).
Memory, Settings, Usage and Host remain open in batch 1, followed by later batches.

**Back** is an idempotent `back` tutorial event guarded by generation/revision. It reopens
the previous currently available catalog step, removing that step's completion/skip mark;
it never undoes a kept note or external action. On the first available step it is disabled.
Pause/resume and reset keep their existing semantics. A stale tab cannot restore reset
progress. Changing the Research steps bumps that tour to v2; shared controls do not
rewrite the content versions of unchanged tours.

**Step feedback** uses the existing `POST /api/app/tutorials/:id/events` endpoint with
`action: "feedback"`, the current `stepId`, and `feedbackKind` of `unclear`, `couldnt_find`
or `didnt_work`. The authenticated account supplies ownership. The server validates the
current available step and tutorial permission under the same progress lock, inserts the
signal, advances the revision without completing the step, and records the idempotent
event in one transaction. Repeating the same event ID does not add another signal.
No free text, route, user content or provider error is accepted/stored in this release.
Existing report/audit/erasure cover `tutorial_feedback`; reset preserves feedback history.

Automated browser checks cover named regions/buttons/groups, keyboard activation,
375px width, a 640×400 viewport equivalent to 200% zoom from 1280×800, reduced motion,
Back, feedback, skip and resume. These checks do not substitute for human screen-reader
or usability sessions. The provider-free journeys use isolated accounts and do not Keep
notes, call providers, or schedule work.

## Projects and Activity tours (#272, second PR)

`projects.basics`, `projects.plans`, `projects.runs`, `activity.inbox`, and
`activity.scheduled` now have v2 authored steps in `workflowTutorials.js`. They use
a shared interactive preview: inspect the fictional starting state, activate a named
action, and read the prepared result. These previews never create projects, approvals,
runs, invitations, notices or schedules, and never call a provider. Only tutorial
progress and explicit step feedback persist; preview state resets on step changes.
The three Projects tours require the Projects room capability. Missing execution,
provider or scheduling support does not prevent the safe demonstrations.

Projects covers goals, private references versus published copies, conversations,
artifacts, plans, output inspection and collaboration/revocation. Plans covers criteria,
dependencies, approval, evidence, blocked work and conclusions. Runs covers queues,
logs, cancellation, uncertain external outcomes, recovery and output verification.
Inbox covers source/reason, notice actions, approval and quiet controls. Scheduled
covers reminders versus recurring AI work, timezone, delivery, pause/resume, failure
and deletion. Inbox contextual Chat remains a separate #273 follow-up.

The five tours have account-isolation, capability and domain-write checks in
`tests/tutorialFramework.test.js`. `e2e/workflowTutorials.spec.js` adds fifteen
journeys covering every tour with keyboard, narrow and zoom-equivalent viewports,
reduced motion, feedback, Back, pause/reload/resume and completion. The browser
checks reject non-tutorial application mutations. Human screen-reader and observed
first-task sessions remain separate evidence requirements.
