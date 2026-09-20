---
title: "Planned: guided tutorials and onboarding"
kind: decision
summary: Planned per-account, per-room tutorials with safe demonstrations, independent skip/resume/reset, versioned progress, user documentation, accessibility, and a full service curriculum. This subsystem is not implemented yet.
tags: [planning, tutorials, onboarding, settings, accessibility]
---

# Planned: guided tutorials and onboarding

**Status: implementation specification; not implemented.** This document defines future tutorial behavior. It does not describe an existing onboarding system or working tutorial API.

Updated: 20 September 2026.

Parent plan: [shared-instance product design and rollout](shared_instance_product_spec.md).

Implement this as increment F of the parent plan, after establishing canonical account identity and the relevant access boundaries. A representative preview may inform UI design before production integration. All sample content must remain isolated from real user data and external actions.

## Launch, skip, and reset rules

- The first successful login opens a short Home orientation once. Use a nonblocking guide panel so the user can explore or dismiss it.
- Each room/service starts its own tutorial on first entry, once its permissions, feature flags, and UI are ready. Opening one room must not complete another room's tutorial.
- Show **Back**, **Next**, **Skip step**, **Skip this tutorial**, and **Pause** throughout. A final step has **Finish** instead of Next.
- Skipping a step records a skip, not a completed exercise. The user can finish with skipped steps and revisit them later.
- Skipping an entire tutorial leaves other tutorials eligible. It does not silently disable all onboarding.
- Pause or Escape saves position. Returning shows a Resume affordance; it does not seize focus repeatedly.
- Settings → Tutorials lists each tour, its progress, and controls to Resume, Replay, or Reset. Offer Reset all and an account-level auto-start toggle. Resetting tutorials does not change user content or permissions.
- Resetting one tour makes it eligible on its next entry. Reset all resets the orientation and all tours; it does not open all of them simultaneously.
- Existing users receive an unobtrusive offer to take the new tours. Do not classify every migration as a first-ever login and interrupt active work.
- Public read-only share pages do not start account tutorials or require registration to read an already authorized public share.

## Teach with a safe example

Use a small “Weekend field notebook” example: a question, two tagged notes, a source, a private project, one completed run, and an output. Reuse the same fictional content across Chat, Knowledge, and Projects so their relationship becomes visible.

Tour examples are isolated from real knowledge retrieval, personal memory, usage accounting, notifications, and external side effects. Demo actions never send messages, make provider calls, run code, or schedule real work. A separate **Keep this example** action can copy selected material into the account after a clear preview; skipping or resetting does not create duplicate real data.

Each major feature needs a demonstrated action, a visible result, and an explanation of where the result lives. A tooltip that only describes a button does not satisfy the requirement. Optional live practice may follow the example, but real work must be explicitly initiated through the normal product controls.

## Tutorial catalog and coverage

The steps below are the minimum authored curriculum. Every semicolon-separated action becomes a stable step or an explicit subordinate tour. Advanced topics link to user-facing help; the rightmost column identifies existing source material to adapt, not a claim that the future help route already exists.

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

Host-only administration gets a separate `admin.instance` tour: issue/revoke an invitation, disable a sample account, inspect aggregate capacity, set a quota, and review a failed integration. It cannot appear to ordinary accounts.

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

Store one progress row per account/tutorial/version with explicit transitions. The catalog is versioned content in source control: tutorial ID, room ID, capability requirements, stable step IDs, anchor IDs, sample scenario, completion event, and user-help document ID. Clients cannot invent tutorial IDs or mark an arbitrary account complete.

Proposed endpoints:

- `GET /api/app/tutorials`: permitted catalog, progress, and auto-start preference.
- `POST /api/app/tutorials/:id/events`: event ID, generation, expected revision, step ID, and action (`start`, `complete_step`, `skip_step`, `pause`, `skip_tutorial`, `finish`). Derive account from the session.
- `POST /api/app/tutorials/:id/reset`: increment generation and clear progress for that tutorial.
- `POST /api/app/tutorials/reset`: reset all permitted tutorials atomically or return explicit per-item outcomes.
- `PATCH /api/app/tutorial-preferences`: change auto-start without mutating completion history.

Events are idempotent. A stale tab cannot resurrect progress from before a reset; reject mismatched generation/revision and reload. Capability-unavailable steps are recorded separately and do not falsely imply demonstrated skills. A tutorial with no applicable steps does not launch. Text-only edits retain version; material step changes create a new version with an explicit progress migration. Never replay all tutorials on every deployment.

## UI integration and accessibility

Create a centralized `TutorialProvider`, `TutorialPanel`, catalog, progress hook, and Settings section. Mount the provider inside the authenticated account scope. Resolve room IDs from the route registry. Add stable `data-tour` anchors to actual controls rather than selectors based on translated labels or brittle CSS structure.

The guide is nonmodal during exercises. When a real product dialog opens, the guide coordinates with it instead of adding a second focus trap. Use labeled controls, sensible focus restoration, keyboard operation, and a progress announcement after deliberate step changes. Escape pauses the tour; it does not delete content. Real modal dialogs should follow [WAI's dialog focus and keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

On mobile, use an in-flow guide card or a collapsible sheet that never covers the target control. Support reduced motion, zoom, narrow screens, and screen-reader-only traversal. Missing anchors or disabled features show a useful explanation and skip/continue controls. Never spin forever waiting for an element. A tutorial failure must not break the room.

## Documentation and product quality feedback

Serve version-matched user guides from the app, including offline/self-hosted deployments. A manifest maps tutorial `docId` values to allowlisted user-facing pages. Build checks reject broken IDs and anchors. Existing operator/setup docs can supply material, but should not be linked indiscriminately into user tours or seeded into a public corpus.

Offer optional per-step feedback: “Unclear,” “Couldn't find it,” and “Didn't work,” plus free text. Record tutorial version, step, route, capabilities and error code; do not collect chat/note contents by default. Record aggregated starts, completions, skips, pauses and failures. Skips alone do not prove bad design. Combine them with observed usability sessions and failed task completion.

Acceptance criterion for the redesign: a new person can explain what becomes a conversation, note, memory, project, and output, then perform one cross-feature task without the host narrating every click.

## Release acceptance

The [parent plan's validation matrix](shared_instance_product_spec.md#10-validation-plan) applies in addition to these tutorial-specific gates:

- Every enabled user-facing room/service is mapped to a stable tutorial ID; capability-gated and host-only tours cannot launch for unauthorized users.
- Every major feature has a demonstrated action and inspectable result. Advanced documentation links resolve to the matching deployed user-guide version.
- First login and first room entry start only the eligible guide; completing or skipping one never changes another tour's progress.
- Skip step, skip tutorial, pause/resume, reset one, reset all, and auto-start preferences work across reloads and devices.
- A stale tab cannot overwrite a reset; retried events cannot advance a tour twice.
- Demo actions do not call providers, send messages, create schedules, consume quotas, or contaminate memory/retrieval.
- Missing anchors, unavailable features, and tutorial-service failures leave the room usable.
- Keyboard, screen-reader, narrow-screen, zoom, and reduced-motion journeys pass against the real components.
