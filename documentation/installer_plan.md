# Installer and feature manifest: implementation plan

Decisions are recorded in `documentation/adr/0013-installer-and-feature-manifest.md`.
This document is the working plan: phases, acceptance criteria, audits to
run before each phase, and open items. It is updated as phases land.

## Delivery status

Implementation PRs for all 28 initial-delivery issues are merged into `main`
(2026-10-07/08). Acceptance remains open for #331–#333 and #340–#343; a merged
implementation alone does not complete an issue. The two deferred issues,
#344 and #345, remain outside initial-release blockers. The per-phase
**Status** paragraphs below record what each change proved and what it left
out; this table records where it landed.

| Issue | PR | Merge |
|---|---|---|
| #316 inventory, #317 catalog and state, #319 tools and MCP, #320 routes and sockets, #318 commands and runtime, #321 portal, #322 conformance | #346, #347, #349, #350, #351, #352, #353 | `0e5b8ff` … `a27dd4d` |
| #328 payload selection, #323 manager foundation, #324 configuration, #325 lifecycle, #329 install engine and CLI | #356, #354, #355, #357, #358 | `62d3317` … `3fab11a` |
| #334 maintenance barrier, #335 data reset, #336 migration, #326 host pages, #330 wizard, #338 database chooser, #337 maintenance UI | #359, #361, #362, #360, #363, #365, #366 | `0782db3` … `5bd6a64` |
| #333 Linux bootstrapper, #339 Docker Postgres, #332 macOS with the service-kind seam, #331 Windows, #341 release pipeline, #342 staged updates | #367, #368, #369, #370, #372, #373 | `f873cfe`, `62dfd51`, `dc6a7c5`, `2e5590d`, `de6aacc`, `1bf0901` |
| #327 packaging proof (with the shared `config.json` loader, #364) | #348, #364 | `1ccb2fa` |
| #340 native Postgres | #371 | `707c3fc` |
| #343 operator runbooks and accessibility review | #375 | `991aced` |
| #343 acceptance matrix (driver, hosted workflow, report; findings 8 to 20 fixed) | #377 | `987b0ba` |
| Post-merge: duplicated list registrations from the stack merge; a Windows helper spec broken by the fixed package table | #374, #376 | `87fa25f`, `8845cc5` |

Verified on 2026-10-08: `main` `db2bdd9` passed
[CI run 37750418734](https://github.com/nervous-rob/goobster/actions/runs/37750418734),
including SQLite, Postgres and Playwright. The final #377 head `421540d`
passed the 19-cell acceptance matrix, packaging proof, all three platform
bootstrap workflows and native Postgres provisioning. Exact run links and
the distinction between PR-head evidence and current-main CI are in the
[release acceptance checkpoint](release_acceptance.md#ci-verification-checkpoint-2026-10-08).
These development-signed results do not establish production release
qualification, physical Pi acceptance or a second-operator recovery drill.

The last to land: #343's acceptance matrix (driver, hosted workflow, report;
PR #377, merged `987b0ba`, where the 19 hosted cells ran for the first time
and, on the seventh run, all passed; the eighth, on the final head, passed
again). Its first hosted run
found three defects that the same PR fixes: the documented SQLite-with-data →
`database docker provision` → `migrate` path was refused with
`TARGET_NOT_EMPTY` because the preflight counted relations and provisioning
had applied the schema (the preflight now judges what the schema holds; a
provisioned empty schema is the warning `TARGET_SCHEMA_PRESENT`, and a rollback
empties it rather than dropping it: [db_migration.md](db_migration.md#the-preflight));
the acceptance driver started a `.cmd` launcher through `cmd.exe` with an
unquoted path that `$RUNNER_TEMP` spells with a forward slash; and the payload
smoke probed the API's port on loopback only, which on macOS can pass a port
the API's wildcard bind is then refused. The second run passed the eleven
SQLite cells and found two more: the managed-Postgres cells' `reset` failed
`BACKUP_FAILED` because the runner's `pg_dump` (16) is older than the pinned
`pgvector/pgvector:pg17` server (the workflow installs the PostgreSQL 17 client
tools for those cells and puts them first on PATH, since Debian's `pg_wrapper`
otherwise keeps choosing the runner's own 16 - the third run proved that the
package alone is not enough, and [docker_postgres.md](docker_postgres.md) now
tells an operator the same; and `BACKUP_FAILED` names its cause as a short
code, `TOOL_VERSION_MISMATCH` here: [data_reset.md](data_reset.md)); and on Windows
the installed payload's `current\bin\goobster-manager.cmd` did not read
`<code root>\goobster.env` as its POSIX counterpart does, so `status` run from
it looked under `%LOCALAPPDATA%\Goobster` and reported `recovery` (it now reads
the file the same way: [windows_install.md](windows_install.md#repair-reconfigure-uninstall)).
The third run passed all eighteen Linux and macOS cells, every step and
injection, and the Windows cell reached the end of its steps for the first
time, finding two more: the driver ended only the `cmd.exe` that ran the
`.cmd` launcher, leaving the manager and its workers alive (the driver now
ends the process tree, as the service host does); and no update could be
downloaded on Windows, because the landed file was synced through a
read-only handle, which Windows refuses (`DOWNLOAD_FAILED` for every source
kind; fixed in `apps/manager/update/source.js`:
[manager_update.md](manager_update.md#how-this-was-verified)).
The fourth run, Windows only still red, found that `update stage` read the
landed archive with the GNU tar Git Bash puts first on PATH, which reads
`D:\...` as a remote host (`ARCHIVE_UNREADABLE`; the manager now uses the
system `tar.exe` in `System32`, and the code names the failing call as a
reason: [windows_install.md](windows_install.md#repair-reconfigure-uninstall)),
and that the driver's Windows stop was a tree kill where the service host
sends Ctrl+C, so the workers died mid-write and a restore then folded the
SQLite WAL into the file it set aside, which failed the `restore-kill` check
and left the barrier up for `reset` (`STALE_MAINTENANCE`); the driver now
drains the workers through the manager's `lifecycle.stop` first. The fifth
run (reset and the interrupted restore now pass on Windows) kept the
processes' logs beside the failed cell's evidence for the first time, and
they named the last two: the payload launcher `goobster-manager.cmd` failed
with no argument (a substring of an undefined variable makes `cmd.exe` abort
the batch file with "The syntax of the command is incorrect", exit 255; every
other door passes an argument, so no Windows journey had run it bare), and
the archive listing from Windows' bsdtar ends its lines with CR LF, which made
the manifest "missing". The sixth run, with the archive read and every other
Windows step and injection green, reached the one design defect under them
all: `update apply` swaps `current` while the manager still runs from it,
which POSIX allows (a rename moves an inode) and Windows never does (a
directory with an open handle beneath it cannot be renamed, whatever the
sharing mode), so the activation failed `EPERM`. On Windows the payload
layout is now the linked one Windows deployments use: activated payloads
live under `<code>\live\`, `current` and `previous` are junctions, and an
activation swaps links that hold nothing open
([packaging.md](packaging.md#staging-and-activation),
[windows_install.md](windows_install.md#default-roots)); POSIX keeps the
rename layout the other eighteen cells proved, and the acceptance driver ran
the linked layout on Linux end to end with `GOOBSTER_PAYLOAD_LAYOUT=linked`
([release_acceptance.md](release_acceptance.md#findings), findings 16 to 20).
**The seventh run passed all nineteen cells**, Windows included: every step
and injection a cell can run, on linux x64 and arm64 (new and adopt, SQLite
and managed Postgres, minimal and representative), macOS arm64 and x64, and
Windows; the matrix table in `release_acceptance.md` is generated from that
run's evidence
([release_acceptance.md](release_acceptance.md#results-of-the-runs-done-so-far)).
Also still open: the owner decisions
the runbooks name (#249, #255, #262, the signing material for #372), and the
deferred #344 and #345. The child issues of #315 are not closed here; each
carries its own acceptance evidence.

## Goal

An operator installs Goobster on Windows, macOS or Linux (desktop or
headless), chooses which features the installation has, enters and
validates keys with guidance, chooses SQLite or Postgres with the
trade-offs explained, sets instance defaults, and can later reconfigure,
repair, back up, restore, reset, migrate or uninstall from the same
management interface. A feature the operator did not enable never runs:
no commands, tools, routes, scheduled jobs, event handlers or navigation.

## Vocabulary

| Term | Meaning |
|---|---|
| Catalog | `packages/core/features/catalog.js`: the static description of every feature and API key. |
| Feature state | `data/features.json` (`documentation/feature_state.md`): per feature the stored `installed`, `active` and `pendingActive`; `configured` and `pending` are derived on read. Without the file, the effective legacy switches decide. |
| Manager | `apps/manager`: the management process (setup engine, API, supervisor, maintenance operations). |
| Wizard | The React setup and maintenance UI served by the manager, sharing components with the portal's operator pages. |
| Bootstrapper | The per-platform native installer that unpacks the payload and the Node runtime, registers the manager service and opens the wizard. |
| Payload | The files a given installation receives: core, apps, the features selected and their exclusive dependencies. |
| Maintenance state | An operation lock that blocks writes from every application process while restore, reset or migration runs. Not the paused state. |

## Feature boundaries

Always available (infrastructure, never a feature switch): chat, the
portal shell and operator pages, settings, utility commands, privacy
(`/forget-me`, `/what-do-you-know-about-me`, retention), memory storage,
export and erasure, Inbox and system notices, self-docs, the work ledger.

Optional features, each with its own switch. Ids are the catalog keys;
the full ownership inventory and the evidence for each dependency are in
`documentation/feature_inventory.md` (audit result of #316).

| Feature (id) | Notes |
|---|---|
| Music (`music`) | Music Lab / Song Studio, generation and ambience, library, downloads, the python venv (yt-dlp, spotdl). No dependency on Voice; only the Discord playback surfaces also require Voice and Discord. |
| Voice (`voice`) | Voice chat, TTS/STT, live voice. Owns ffmpeg. |
| Tavern (`tavern`) | Adventure mode. |
| Economy (`economy`) | Points and accounting (E1: accounting is the feature, not infrastructure). New-install default off (#261). |
| Exchange (`exchange`) | Trading (incl. the stock game), margin, options, futures, perps, the risk engine. Depends on Economy. New-install default off (#261). |
| Gambling (`gambling`) | `/gamble`, the wheel, predictions, casino table games. Depends on Economy; wheel and predictions also require Exchange. New-install default off with operator attestation (#261). |
| Projects (`projects`) | Project rooms, missions, triggers, applets promotion. |
| Observatory (`observatory`) | Runs, jobs, render. Depends on Projects and Sandbox. |
| Sandbox (`sandbox`) | The code-execution runner and tools. |
| MCP (`mcp`) | The MCP access mechanism; exposes only available features, requires none of them. |
| Knowledge (Spitball) (`knowledge`) | Knowledge editing: notes, transfers, attachments, the Knowledge room. No legacy switch. |
| Expeditions (`expeditions`) | Autonomous research and briefs. Depends on Knowledge. |
| GitHub (`github`) | Integration, webhook receiver, issue capture. |
| Cursor (`cursor`) | Integration, agent tracker and mission-control threads. Depends on GitHub. Grouped with GitHub in the wizard, separate switch. |
| Screen Vision (`screenVision`) | Companion page and WebSocket. |
| GBA (`gba`) | The GBA harness and `clients/gba-mcp`. Separate switch (#261). |
| Discord Activity (`discordActivity`) | The embedded Activity transport only. Depends on the Discord adapter. Inbox and notices stay. |
| Discord adapter (`discord`) | Independent adapter (`config/discordConfig.js`). |
| Push (`push`) | Independent adapter. |
| Mail (`mail`) | Delivery integration. Disabling is refused while native login is on and registration is open; a warning when verified addresses exist otherwise (M1). |

Memory recall and consolidation stay settings (`ai.memory.enabled`), not a
feature.

## Phases

### Phase 1: catalog and gating

Deliverable: a disabled feature cannot execute. Code may still load.

Implementation details (issues #316 - #322 under epic #315; all merged and
accepted, see the delivery table above):

| Issue | Scope | State |
|---|---|---|
| #316 | Audits E1/T1/R1/S1/M1, ownership inventory, ADR 0013 accepted | Inventory module `packages/core/features/inventory.js`, spec `tests/featureInventory.test.js`, `documentation/feature_inventory.md` |
| #317 | `catalog.js` + `featureState.js` contract | Catalog `packages/core/features/catalog.js` (+ `descriptors/`), resolver `featureState.js`, `legacyResolver.js` and `gate.js`; specs `tests/featureCatalog.test.js`, `tests/featureState.test.js`; contract in `documentation/feature_state.md`. |
| #318 | Command loader / deploy, `coreRuntime.step()`, `messageCreate` and interaction gating | One lister and one filter for command load and deploy (`commandDeployment.listCommandFiles` / `featureCommandFilter`; filtered files are never required; the deploy hash covers the served feature set). Stale slash commands, autocomplete, context menus, buttons, selects and modals of an enforced-off feature are refused ephemerally before any handler (`interactionCreate.gateComponentInteraction` / `refuseUnavailableCommand`; `collector:<id>` keys keep `clear_search_button` with its own collector; `intaction` resolves its owner from the pending action). `coreRuntime.step(name, fn, { feature })` skips an enforced-off step without invoking it and reports `skipped:feature` apart from `paused`; bundled steps drop their feature branches (`applyBundledFeatureGates`); `executeWheel` refuses at the top. `serviceManager.voiceService` is lazy (inert stand-in when voice is off); voice/music/issue-capture listeners and the command-backed tool adapters follow the snapshot; `messageCreate` gates `#06`/`#10` skip cleanly with the order unchanged. Enforcement rule shared with #319/#320 (`featureState.enforcedOff`): no file ⇒ identical to the unfiltered walk. Specs `tests/featureGatingCommands.test.js`, `tests/featureGatingRuntime.test.js`; `tests/independentRuntime.test.js` and `tests/backupRestore.test.js` pin the state they assume |
| #319 | AI tool registry, `runAgentLoop`, MCP gating | Discovery and dispatch are gated independently in `toolsRegistry` (`getDefinitions` filters by `surfaceActive('aiTool', name)`; `execute` refuses a stale or direct call with `FEATURE_UNAVAILABLE` before approvals, admission or side effects). `runAgentLoop` treats `FEATURE_UNAVAILABLE` as a terminal observation (repeat calls short-circuited, no implicit activation). `promptContext` adds one `UNAVAILABLE HERE:` line from `features.unavailable()`, omitted when nothing is off. MCP tool and resource listings, `tools/call` and `resources/read` are filtered per request, and the `mcp` feature off makes HTTP and stdio refuse to serve (`apps/mcp` refuses to start). Specs `tests/featureGatingTools.test.js` and `tests/featureGatingMcp.test.js`, plus adjusted `tests/mcpServer.test.js`, `tests/toolsRegistryRunCode.test.js` and `tests/toolsRegistryObservatory.test.js` |
| #320 | HTTP / WS / Activity / internal route gating | One network-edge gate in `packages/core/web/featureGate.js`: `routeGate` middleware resolves each request against the inventory's ordered `routeRules` and answers `404 { error: 'FEATURE_UNAVAILABLE', feature }` for an enforced-off owner (`ownerGate`/`mountable` for whole mounts, `guardOpenSocket`/`rejectUpgrade` for WebSocket paths). Mounted in `appApi.js` (first), `appWebsocket.js`, `apps/bot/web/server.js`, `activityApi.js`, `screenVisionApi.js`, `gbaRunApi.js` and `apps/api/server.js`. `GET /api/app/features` returns the sanitized status for clients. Enforcement rule unified here for all surfaces: `featureState.enforcedOff(id)` is true only with a usable `features.json`, a `GOOBSTER_FEATURE_<ID>` override off, or an enforced-off hard dependency, so with no file nothing new is refused; `gate.js` and the #319 tool/MCP gates consume the same predicate. MCP token-management routes (`/api/app/mcp*`) reassigned to `core` so revocation stays reachable. Specs `tests/featureGatingRoutes.test.js` (router-stack walk of every mounted route) and `tests/featureGatingWebsocket.test.js` |
| #321 | Portal rooms, tutorials, `consultDocs` availability | The portal fetches `GET /api/app/features` once per session beside `me` (legacy `me.features` kept as the fallback). Rooms and nested views declare `requires.feature` in `rooms.cjs`; navigation omits host-unavailable rooms and views, Tools shows an unavailable card (reason, dependency title, doc link) distinct from the user-hidden state, and a deep link renders a "not available on this installation" state inside the shell. Tutorial requirements corrected (`knowledge.research`, `projects.runs`, `trading.basics`); an unavailable tour is listed `available: false` with a reason and refused with `FEATURE_UNAVAILABLE` (`gate.requireSurface('tutorial', id)`), never completed, progress kept. `feature:<id>` front matter on the feature docs; `consultDocs` search/read/list annotate an inactive feature's docs at query time, never hidden. `documentation/features.md` is generated by `scripts/generate-features-doc.js` (`npm run docs:features`, `--check` inside `npm run docs:check`). Specs `tests/featureGatingPortal.test.js` and `e2e/featureAvailability.spec.js` |
| #322 | Cross-surface conformance and dormant-data tests | `tests/featureConformance.test.js` (35 profiles x every gated surface kind, bot boot, inventory negative checks, loaded-versus-executed report) and `tests/featureDormantData.test.js` (two accounts, every feature off: report, export, erasure, retention, vectors, off/on round trip, no feature work); shared fixtures in `tests/helpers/featureFixtures.js`. Closes the privacy and export reach gaps (`agent_runs`, `pending_integration_actions`, `integration_audit`, `repo_watches`, `screen_vision_clients`, `kg_reflection_runs`; the export now carries economy, exchange, Tavern, Song Studio, push, friends and DMs, integrations and sandbox) and gates Web Push delivery on `push`. Rooms, nested views, tutorial listing and launch refusal, and self-docs annotation are asserted per profile against #321's implementation |

Original pull-request stack, now merged: #346 (#316) -> #347 (#317) -> #349 (#319) -> #350 (#320) ->
#351 (#318, also carries the independent review's fixes) -> #352 (#321) ->
#353 (#322). The CI workflow (lint, smoke, typecheck, web build, every Jest
group on SQLite and on Postgres, Playwright) passed on the head of every PR
in the stack. The packaging proof for #327 is PR #348, independent of the
stack and also green on all five targets.

Work:

1. `packages/core/features/catalog.js` and `featureState.js` (read,
   validate, seed from legacy `enabled` flags, env overrides that can only
   deactivate).
2. One predicate `features.isActive(id)` used by:
   - the command loader in `apps/bot/index.js` and
     `utils/commandDeployment.collectCommandPayloads` (one filter);
   - `coreRuntime.step()` (steps declare their feature; a skipped step is
     recorded as skipped for the feature, not as a failure);
   - the AI tool registry used by `runAgentLoop`, plus one system-prompt
     line naming features that are not available;
   - HTTP routes (404 for a disabled feature's routes; the manager and
     operator routes are never gated);
   - `apps/bot/events/messageCreate.js` gates (the mission-control gate
     short-circuits when Cursor is off, the GBA advice gate when GBA is
     off; the order of gates is unchanged);
   - portal navigation and rooms;
   - `consultDocs` results, annotated (not hidden) for disabled features
     via a `feature:` front-matter key on the doc.
3. Tests: every command file, runtime step, tool and gated route is
   claimed by exactly one catalog entry (inventory test, same pattern as
   `tests/ciGroups.js`); for each feature, with it disabled, its commands
   are absent from the deploy payload and the loader, its steps never
   start, its tools are absent, its routes return 404; with no
   `features.json`, behaviour equals today's and legacy flags are honoured.
   Runs on both engines.
4. Docs: `documentation/features.md` generated or checked against the
   catalog; `configuration.md` and `commands.md` reference it.

Acceptance: `npm test`, `npm run lint`, `npm run smoke` green on both
engines; the inventory test fails when a new command or step is unclaimed;
the dormant-data rule holds (privacy tests pass with every feature off).

#### Phase 1 acceptance -> evidence

Each bullet is mapped to the spec and test that proves it. "Pending #321"
means the surface exists in the inventory but its assertions wait for #321.

| Acceptance (source) | Evidence |
|---|---|
| `npm test`, `npm run lint`, `npm run smoke` green on both engines (plan, Phase 1) | `ci.yml` runs both engines; `featureConformance` is in the `core` group and `featureDormantData` in `privacy` (`tests/ciGroups.js`) |
| The inventory test fails when a new command or step is unclaimed (plan, Phase 1) | `featureInventory.test.js` (every file, step, tool and route is claimed); `featureConformance.test.js` > "inventory negative checks: an unclaimed surface fails closed" (command file, step, tool, MCP tool, interaction, event gate, socket, route) |
| An invalid dependency declaration is rejected | `featureConformance.test.js` > "invalid dependency declarations are rejected"; `featureCatalog.test.js`, `featureState.test.js` |
| Core ownership is explicit, not by absence | `featureConformance.test.js` > "core ownership is explicit" |
| The dormant-data rule holds: privacy tests pass with every feature off (plan, Phase 1) | `featureDormantData.test.js` > "with every optional feature off the data is still reported, exported and prunable", "forgetUser while the features are off" |
| Off: command not registered, tool not offered, route refuses, worker does not run (#261) | `featureConformance.test.js`, every profile: "commands and context menus", "AI tools", "HTTP routes", "runtime steps", "WebSocket upgrades", "bot process boot" |
| All-optional-off: no optional worker starts, polls or provider calls while core chat, privacy and export stay usable (#322) | `featureConformance.test.js` profile `core-only` (steps, `fetch` and model-call spies; core routes 200); `featureDormantData.test.js` "no feature worker starts, no feature tool runs, no provider is called" |
| Data stays in place while off and returns unchanged when on (#261, #322) | `featureDormantData.test.js` "off -> on round trip" and "account B is byte-identical, and still is after the features come back on" |
| Cross-account isolation and vector cleanup (#322) | `featureDormantData.test.js` "forgetUser while the features are off" (B byte-identical, `memory_vec_*` has no orphan) |
| With no `features.json` behaviour equals today's, legacy flags honoured (plan, Phase 1) | `featureConformance.test.js` profile `legacy-no-file` (nothing refused, loader set equals the unfiltered walk) |
| A fresh install has economy and exchange off (#261) | `featureConformance.test.js` profile `fresh-install` (preset turns off `economy`, `exchange`, `gambling`); `featureState.test.js` |
| Dependency combinations (#322) | `featureConformance.test.js` combination profiles and `env-override-only` |
| Remaining module loading recorded separately from execution gating (#322) | `featureConformance.test.js` "module loading versus execution"; `feature_inventory.md` "Loaded but not executed when off" |
| Portal rooms, tutorials and `consultDocs` availability follow the state (plan, Phase 1; #261 tutorials) | `featureConformance.test.js` "#321" block: per profile, rooms/views (`rooms.cjs`), tutorial listing and launch refusal, self-docs annotation (141 tests) |
| The migration turns switches on only where rows exist (#261) | Not covered by #322 (row-presence seeding for existing installs is a state-seeding concern outside this gate) |
| Gambling cannot be enabled on a shared instance without the attestation, recorded in `operator_audit` (#261) | Not covered by #322: it is the Phase 2 Features page (#326): `tests/hostRoutes.test.js` (attestation required on a shared instance, remembered per operation, no `operator_audit` row without it) and `e2e/hostOperator.spec.js` |
| `documentation/features.md` generated or checked against the catalog (plan, Phase 1) | Not part of #322 |

### Phase 2: manager process, lifecycle and operator pages

Deliverable: an operator changes features from the portal, and the
installation restarts safely.

Status (issues #323 - #326 under epic #315):

| Issue | Scope | State |
|---|---|---|
| #323 | `apps/manager`: own store, setup engine, bootstrap and recovery credentials, portal bridge, transport, privilege boundary, audit reconciliation | Workspace `apps/manager`, bridge minter `packages/core/web/managerBridge.js`, specs `tests/managerBoot.test.js`, `tests/managerAuth.test.js`, `tests/managerEngine.test.js`, `tests/managerBridge.test.js`; `documentation/manager.md` (PR pending review) |
| #324 | Shared configuration: field catalog (`packages/core/config/fieldCatalog.js`), effective settings with sources, safe `config.json` writes (`configFile.js`), `config.set` and `defaults.set` kinds, `GET /manager/api/config`, explicit provider probes, instance defaults | `packages/core/config/{fieldCatalog,effectiveConfig,configFile}.js`, `providerProbeService.js`, `instanceDefaultsService.js`, `apps/manager/{configView.js,routes/config.js,engine/kinds/{config,defaults}.js}`, generator `scripts/generate-config-reference.js`, specs `tests/{configFieldCatalog,effectiveConfig,configFile,providerProbes,instanceDefaults,managerConfig}.test.js`; `documentation/manager_configuration.md`, `documentation/config_reference.md` (PR pending review) |
| #325 | Supervision of every layout, staged restart with a 60 s grace period, restart contracts for long-running work, per-target command deploy | `apps/manager/lifecycle/` (layouts, child and external adapters, supervisor, `lifecycle.json`), the `lifecycle.apply` / `lifecycle.restart` / `lifecycle.cancel` kinds and `/manager/api/lifecycle*` routes, `--supervise`; worker side `packages/core/runtime/{lifecycle,revisionAck}.js` (exit 75, stop new work, revision acks); `deploy/goobster.service` and `ecosystem.config.js` run the manager. Specs `tests/managerSupervisor.test.js`, `tests/managerLifecycle.test.js`, `tests/lifecycleAdapters.test.js`, `tests/commandDeployHash.test.js`, `tests/workInterruption.test.js`; `documentation/manager_lifecycle.md` (PR pending review) |
| #326 | Host room operator pages: Features, Connections and Instance Defaults previewed and applied through the manager over the authenticated portal bridge, a restart panel (countdown, Restart now, Cancel, per-worker acknowledgement, last outcome), `host.*` audit actions | `packages/core/web/routes/host.js`, `packages/core/web/hostManagerClient.js`, `packages/core/config/managerConfig.js` (`manager.baseUrl`), `apps/web/src/rooms/host/`, spec `tests/hostRoutes.test.js`, journeys `e2e/hostOperator.spec.js`; `documentation/host_operations.md` (PR pending review) |

Work:

1. `apps/manager`: starts with no database, no Discord, no keys. Own
   store (`data/manager/`) for installation state, operation progress and
   the one-time setup credential. Localhost bind; LAN access opt-in with
   token. Authenticated recovery flow for a broken database; first-time
   setup only when no installation state exists.
2. Supervisor adapters for the supported layouts: lite (one bot process),
   paired (bot + api), standalone (api only). Sentinel exit code for
   requested restart, signal forwarding, restart-loop limits, health
   checks, worker coordination. systemd, launchd and Windows service
   definitions run the manager; the OS recovers the manager.
3. `restartService.requestRestart({ reason, delaySeconds })`: validates
   configuration, stages downloads, announces, waits the grace period
   (default 60 s, "restart now" available), asks long-running work to
   checkpoint or cancel, exits with the sentinel; command redeploy only
   when the payload hash changed; one `operator_audit` row.
4. Setup engine API (read and write config and feature state, probe keys,
   probe a database) used by the operator Features and Keys pages behind
   the admin `guard`; feature changes become `pending` until the restart.
5. Expeditions and sandbox jobs declare checkpoint or cancellation on
   restart requests.

Acceptance: a feature toggle from the portal is audited, pending, applied
after restart, and the restart works under systemd, PM2, Docker and a bare
`node` start through the manager; the manager starts and serves recovery
with the database unreachable; an unauthenticated request never reaches
setup on an existing installation.

### Phase 3: packaging proof, wizard and bootstrappers

Deliverable: install, reconfigure, repair and uninstall on three platforms
with SQLite.

Work, in order:

1. **Packaging proof first**: a minimal bundled server (Node runtime,
   core, bot, prebuilt `better-sqlite3`, `sqlite-vec`, `sodium-native`,
   `sharp`) starts on Windows x64, macOS (arm64 and x64), Linux x64 and
   Linux arm64 in CI. Tests run against the reduced payload, not only the
   checkout.

   **Status (P3.1, #327): proof in progress.** The recipe
   (`scripts/package-runtime.js`), the in-payload smoke check
   (`scripts/package-smoke.js`) and the CI matrix
   (`.github/workflows/packaging-proof.yml`) exist. Proven locally on
   Linux x64 only: the payload builds with no compiler, every prebuilt
   binary loads (including `sqlite-vec`, with no fallback), and the
   standalone API starts and stops cleanly from a relocated path with
   spaces and non-ASCII characters. Linux arm64, Windows x64, macOS x64 and
   macOS arm64 are **unverified** until the matrix has run on a runner of
   each. Open findings that gate the release phase (B1 config roots,
   B2 glibc floors, B3 sqlite-vec macOS floor, B4 VC++ redistributable,
   B5 GPL declarations, B6 discord.js in the no-Discord path) are in
   `documentation/packaging_proof.md`. B1 has a fix open against `main`
   as PR [#364](https://github.com/nervous-rob/goobster/pull/364)
   (shared `config/configJson.js` loader).
2. Payload builder: resolves the selected features to files and exclusive
   dependencies (ffmpeg for Voice, the python venv for Music, the sandbox
   runner), builds the frontend with only the selected rooms.

   **Status (P3.2, #328): built; reduced payloads proven on Linux x64
   only.** These parts are done; `documentation/packaging.md` is the
   reference:
   - the signed release manifest (version 1) with an owner for every file
     and dependency;
   - `selectPayload` and the `--profile` / `--features` flags of
     `scripts/package-runtime.js`;
   - lazy seams (`requireOptional`, the `discord` accessor) so reduced
     trees load;
   - per-feature portal chunks with an unavailable state when one is
     missing;
   - `verifyPayload`, staging and atomic activation with rollback;
   - Ed25519 signing with a labelled development mode;
   - feature add/remove that never touches `data/`, `config.json`, logs,
     cache or the manager store, and only audits system dependencies.

   Finding B5 is closed at the source (`play-dl` is no longer declared, so
   neither GPL package is installed anywhere; the manifest still reports and
   excludes any unreferenced dependency) and B6 (`discord.js` is exclusive
   to the Discord adapter) is closed for the payload. The `reduced` job in `.github/workflows/packaging-proof.yml`
   builds minimal, voice and projects+sandbox payloads on `ubuntu-24.04`,
   and runs routes, dormant-data and tamper probes against them. Reduced
   payloads on the other four targets are unverified. Production signing
   keys are a release matter (`documentation/release.md`, #341). The wizard (#329) and the bootstrappers (#331) consume
   the seams listed in `documentation/packaging.md`, "The manager seam".
3. Wizard screens, each with an "about this" panel: mode (install,
   reconfigure, repair, uninstall); features with size, dependencies and
   cost; keys with links, live probes and restricted-permission writes to
   `config.json`; database (SQLite only in this phase); instance defaults;
   review and progress; first-run check.

   **Status (P3.3, #329): engine and CLI built; the wizard screens follow in P3.4.**
   `documentation/manager_install.md` is the reference. Done: the version 2
   installation record with explicit ownership; read-only discovery of
   payload, Raspberry Pi script, PM2, Docker and manual installs; preflight;
   the `install.new`, `install.reconfigure`, `install.repair` and
   `install.uninstall` kinds and the managed form of `adopt` (with updater
   reconcile); resume after interruption; uninstall that keeps data by
   default and writes a tombstone. Not done: network download and archive
   sources, and every privileged
   operation (`service.register`, `service.unregister`, `updater.disable`,
   `user.create` answered 501 at that point; the Linux implementation is P3.7
   below).
   **Status (P3.4, #330): the wizard screens are built** (PR
   [#363](https://github.com/nervous-rob/goobster/pull/363), stacked on #360:
   SQLite 265 suites / 5251 passed, Postgres `core` 1949 and `portal` 1116,
   Playwright 233 passed including 19 wizard journeys).
   `documentation/setup_wizard.md` is the reference. The manager serves a
   static client at `/manager/` (setup, recovery and maintenance pages, an
   `HttpOnly` cookie session) and the portal's Host room has an Installation
   page for Reconfigure, Repair and Uninstall through the bridge. Both run the
   same engine, kinds and field components as the CLI. New manager kinds:
   `owner.create`, `lifecycle.start`, `lifecycle.stop`. Postgres is shown
   disabled; OS service registration is not driven from the page (the Linux
   bootstrapper registers it, `documentation/linux_install.md`) and maintenance,
   reset and migration (#334-#336) are not wired in. Proven on Linux x64 in Playwright
   against throwaway directories and a fake Ollama.
4. Headless CLI running the same engine (answers file or prompts).

   **Status (P3.3, #329): built.** `apps/manager/cli.js` (`install`,
   `adopt`, `reconfigure`, `repair`, `uninstall`, `plan`, `status`,
   `discover`, `schema`) takes a mode 0600 answers file validated against
   `apps/manager/install/answers.schema.json` or prompts, supports
   `--dry-run` and `--json`, refuses secrets on the command line, and
   exits 0/2/3/4/5 as documented. Proven on Linux x64 against throwaway
   directories only. The wizard (item 3) drives the same engine and kinds, so
   an answers file and the browser journeys produce the same plans.
5. Bootstrappers: Windows NSIS, macOS pkg, Linux script and AppImage;
   privileged operations limited to service registration and package
   installation; the installation registry per user; repair keeps `data/`
   and `config.json`; uninstall keeps them unless the operator explicitly
   chooses to delete data, with the privacy consequence stated.

   **Status (P3.7, #333): the Linux bootstrapper is built; Windows (#331)
   and macOS (#332) are separate.** `documentation/linux_install.md` is the
   reference. The payload now carries the manager (`bin/goobster-manager`);
   `scripts/package-bootstrap.js` builds a deterministic self-extracting
   `.run` and an AppImage (appimagetool pinned by SHA-256) from it; both start
   the manager's `install.new` from the embedded payload, with the wizard on
   `127.0.0.1:3400` or headless from an answers file. The privileged helper
   (`apps/manager/privileged/`) implements `service.register`,
   `service.unregister`, `user.create` and `updater.disable` on Linux (one JSON
   document on stdin, `sudo -n` then `pkexec`, files hash-checked against the
   payload manifest before an elevated start); `package.install` stays
   `NOT_IMPLEMENTED` - system dependencies are reported, never installed.
   Registration writes a marker-bearing systemd unit and records it in the
   manager's store; without systemd or rights the install finishes in the manual
   manager fallback. Raspberry Pi installs are adopted with their updater
   disabled. Proven locally on Linux x64 without systemd (the same journey,
   `scripts/linux-bootstrap-proof.sh --no-systemd`, 29 checks) and by Jest
   (`tests/privilegedHelper.test.js`, `linuxService.test.js`,
   `bootstrapStage.test.js`, `bootstrapCli.test.js`). `systemctl enable --now`
   on a real systemd, on x64 and arm64, is proven only by
   `.github/workflows/linux-bootstrap.yml`. Unsigned development builds only
   (`-dev`); release signing keys: `documentation/release.md` (#341). PR
   [#367](https://github.com/nervous-rob/goobster/pull/367) (stacked on #366,
   merging the B1 loader #364): SQLite full suite 284 suites / 5751 passed;
   Postgres `core` 2377 and `portal` 1124 passed in isolated schemas; Playwright
   250 passed; lint, smoke, docs and group inventory green; the `--no-systemd`
   journey 29/29 against a payload rebuilt from the branch head; the rendered
   unit passes `systemd-analyze verify`. A checkout unit keeps
   `ProtectSystem=full` (the pre-installer Pi unit); a payload unit is `strict`
   with `XDG_CACHE_HOME` pointed at the cache root.

   **Status (P3.5, #331): the Windows bootstrapper is built, not yet run on
   Windows.** `documentation/windows_install.md` is the reference. An NSIS
   installer (`bootstrap/windows/installer.nsi`, built by
   `scripts/package-bootstrap-win32.js`; `RequestExecutionLevel user`) unpacks
   the payload and a WinSW 2.12.0 service host (pinned by SHA-256 in
   `scripts/bootstrap-pins.json`) and starts `apps/manager/bootstrap/win32.js`:
   the wizard in the browser, or `/S /ANSWERS=<file>`. The `windows-service`
   kind (`apps/manager/platform/windowsService.js`, `windowsServiceXml.js`)
   plugs into the kind-neutral register/unregister steps; the helper's Windows
   module (`privileged/win32.js`) implements `service.register` and
   `service.unregister` with `sc.exe` and `icacls.exe` for the virtual account
   `NT SERVICE\goobster`, elevating by an administrator session or a UAC prompt
   with a file transport. Proven on Linux x64 by Jest against injected
   exec/spawn/fs fakes (`tests/windowsHelper.test.js`, `windowsService.test.js`,
   `windowsBootstrapCli.test.js`, `packageBootstrapWin32.test.js`) and by two
   byte-identical `makensis` builds of one payload; the service, the UAC-free
   journey, graceful stop and crash restart are proven only by
   `.github/workflows/windows-bootstrap.yml` on `windows-2022`
   (`scripts/windows-bootstrap-proof.ps1`). Unsigned development builds only
   (`-dev`); the Authenticode hook is wired and off, signing is `documentation/release.md` (#341).

   **Status (P3.6, #332): the macOS bootstrapper is built and its journey is
   written; it has not run on a Mac.** `documentation/macos_install.md` is the
   reference. `scripts/package-bootstrap-darwin.js` builds a per-user
   `goobster-<version>-darwin-<arch>[-dev].tar.gz` (`install.command`) and, on a
   Mac, an installer `.pkg` (`pkgbuild`, `productbuild`, macOS 13 or newer) whose
   `postinstall` starts `apps/manager/bootstrap/darwin.js`: headless and
   machine-wide as root when `/etc/goobster-answers.json` is present (a
   LaunchDaemon `io.goobster.goobster` running as the hidden `_goobster`
   account), otherwise the wizard for the console user (a LaunchAgent). The
   privileged helper gains a macOS module (`service.register`,
   `service.unregister`, `user.create` through `launchctl` and `dscl`; root,
   `sudo -n`, then the `osascript` administrator prompt with a file
   transport); the `launchd` service kind is one definition with a machine and
   a user scope. The uninstall never deletes the `_goobster` account (the
   privileged protocol has no operation for it). Apple signing and
   notarization are wired and off by default (P5.1). Proven locally on Linux
   only by Jest through injected command runners and fake executables:
   `tests/launchdService.test.js`, `darwinHelper.test.js`,
   `darwinBootstrapCli.test.js` and `darwinBootstrapStage.test.js` (125 passed,
   1 skipped on SQLite and on Postgres); the packager built the tar.gz, the
   Distribution tree and the report from a foreign Linux payload and reported
   `PKG_SKIPPED`. `launchctl`, `dscl`, `pkgbuild`, `installer` and the restart
   after `SIGKILL` are proven only by `.github/workflows/macos-bootstrap.yml`
   (`macos-15` and `macos-15-intel`) running `scripts/macos-bootstrap-proof.sh`,
   which has not run yet.

Acceptance: selective-installation tests prove an excluded feature's
files, dependencies and frontend bundle are absent; Playwright journeys
cover install, reconfigure, repair and uninstall against the wizard;
unsigned builds are marked as such in the release notes.

### Phase 4: database section

Deliverable: Postgres choice and maintenance operations in the wizard and
operator pages.

Work:

1. Maintenance state: operation lock honoured by every application
   process, durable progress, cancellation rules, recovery after
   interruption.

   **Status (P4.1, #334): built.** The maintenance barrier is a
   manager-owned state in `<store>/maintenance.json` with a persisted
   monotonic fencing token, the phases `plan, preflight, backup, quiesce,
   mutate, verify, cutover, release`, a cancel-safe boundary (through
   `quiesce`) and an irreversible boundary (`mutate` begun). Kinds
   `maintenance.enter` and `maintenance.release` (audit actions
   `manager.maintenance.enter` and `manager.maintenance.release`) refuse
   unless every registered writer acknowledged the fence; an unknown,
   unacknowledging or unfenceable writer blocks entry. Each process closes
   admission (503 `MAINTENANCE` on mutating routes and webhooks, Discord
   refusals, refused WebSocket upgrades, a stopped runtime), drains, then
   sets a database fence that the facade and both engines enforce. A barrier
   that is up at manager start is honoured, never auto-resumed. Plan,
   preflight, quiesce, verify-of-quiescence and release are implemented;
   `backup`, `mutate` and `cutover` are hooks for P4.2 to P4.4. Maintenance
   is not the paused flag. The writer inventory, state machine and recovery
   rules are in [maintenance_barrier.md](maintenance_barrier.md).
2. Reset rewritten for the whole current schema on both engines, with
   explicit scope (everything, or per feature's dormant data) and typed
   confirmation.

   **Status (P4.2, #335): built.** The manager kind `data.reset` (audit
   action `manager.data.reset`) empties either every application table, the
   derived vector index and every owned file set (`instance`), or one
   non-active feature's tables, shared-table rows and files (`feature`),
   from an inventory derived from `schema.sql` and the feature inventory
   (`packages/core/db/resetInventory.js`, `reset.js`). It runs inside the
   maintenance barrier after a verified backup (`backupService.verifyBackup`)
   and a typed confirmation, keeps `operator_audit` and `data_migrations`,
   recreates `instance_state` (paused) and `self_docs`, and does not release
   the barrier. `goobster-manager reset` and `release` are the CLI;
   `GET /manager/api/reset/plan` is the preview. `scripts/initDb.js` no longer
   has a drop list and `--reset` is refused. Portal pages are #337 (done, see P4.4). See
   [data_reset.md](data_reset.md).
3. Migrator: true preflight, required verified backup, row-count
   verification, rollback point.

   **Status (P4.3, #336): built.** `db.migrate.preflight` (read only: reads
   the source and the target, writes nothing, bootstraps nothing),
   `db.migrate` (inside the maintenance barrier: verified backup, source
   snapshot hash, schema apply, per-table resumable copy, verification of
   counts, foreign keys, identities, five relationship checks, sampled
   content and attachment references, a start of the application on the
   target under the fence, then the connection switch through the manager's
   environment overlay) and `db.migrate.rollback` (possible until the first
   write reaches Postgres). CLI: `migrate preflight|run|rollback|status`;
   routes `GET /manager/api/migrate/status` and `POST
   /manager/api/migrate/preflight`; audit actions `manager.db.migrate.preflight`,
   `manager.db.migrate` and `manager.db.migrate.rollback`. Portal pages are
   not built here. `scripts/migrate-to-postgres.js` stays as a developer
   path with reduced guarantees. See [db_migration.md](db_migration.md).
   PR [#362](https://github.com/nervous-rob/goobster/pull/362) (stacked on
   #361): SQLite full suite 269 suites / 5353 passed; Postgres `core`
   2018 passed and `privacy` 325 passed in isolated schemas; lint, smoke,
   docs and group inventory green; CI green on both engines at `65ba14d`.
4. Backup and restore UI over `backupService` and `scripts/restore.js`.

   **Status (P4.4, #337): built, PR pending.** The manager kinds
   `backup.create` and `backup.restore` (audit actions
   `manager.backup.create` and `manager.backup.restore`), `GET
   /manager/api/backup/inspect?dir=` and `GET /manager/api/backup/status`,
   the CLI commands `backup`, `backup inspect` and `restore`, a file-set
   completeness audit (a table with a "since" column and a unit test that
   fails on an unclassified data folder), the Wizard's Backup, Restore,
   Reset and Migration journeys, and the Host room's Maintenance page with
   the audit actions `host.backup.apply` and `host.reset.apply`. Barrier
   release and instance resume stay separate controls. Only `config.json`
   is encrypted; the archive is not. This adds management, UI and
   regression evidence; it does **not** claim the owner's restore drill on
   a real host (#249), which remains a human check. Not in scope: a backup
   scheduler, a Postgres-to-SQLite conversion, a Postgres chooser (#338) and
   service registration. See [backup_and_restore.md](backup_and_restore.md),
   [setup_wizard.md](setup_wizard.md) and
   [host_operations.md](host_operations.md).
   PR [#366](https://github.com/nervous-rob/goobster/pull/366) (stacked on
   #365): SQLite full suite 279 suites / 5605 passed; Postgres `core` 2231,
   `portal` 1124 and `privacy` 325 passed in isolated schemas; Playwright
   250 passed; lint, smoke, docs and group inventory green.
5. Postgres: existing server (version and `vector` checks, create database
   and extension, host, port, bind), explicitly chosen Docker container
   (the compose pgvector image), managed native install on Linux (from
   `scripts/ensure-local-postgres.sh`), storage path for managed
   instances. The explainer and a recommendation from the selected
   features.

   **Status (P4.5, #338): existing server built (PR pending review).** The
   chooser (SQLite, an existing PostgreSQL server, and the Docker and native
   entries disabled with "Available in a later version of this installer"),
   workload guidance without user-count thresholds, the connection form and
   the read-only `database test` (route `POST /manager/api/database/test`,
   `database test` in the CLI), the kinds `database.provision` (an elevated
   credential used once, least-privilege role, ticked actions, DBA SQL for an
   unprivileged hosted server), `database.schema.apply` and
   `database.connect` (maintenance barrier, probe, validation on the target,
   overlay write, record update, barrier left up unless released), the
   Postgres `database` answer of `install.new`, the setup wizard step, the
   Database maintenance journey and the Host Database page. A SQLite
   database that holds data is routed to the migration (`MIGRATION_REQUIRED`).
   Not built here: native PostgreSQL provisioning, bind and
   storage edits for a server the manager owns, cluster tuning and
   PostgreSQL major upgrades. See
   [database_connection.md](database_connection.md).

   **Status (P4.6, #339): explicitly chosen Docker container built (stacked
   on #338).** The Docker entry of the chooser is enabled only after the
   daemon check passes (CLI, daemon, socket permission, Desktop or Engine,
   platform, the pinned image, the host `pg_dump` against the server major);
   the image is `pgvector/pgvector:pg17` by digest in
   `packages/core/db/docker/image.js` and a major upgrade is manual
   (`MAJOR_UPGRADE_IS_MANUAL`); the container, volume and network are named
   `goobster-pg-<id8>`, `goobster-pgdata-<id8>` and `goobster-<id8>` and carry
   `io.goobster.installation|role|manager` labels that every change checks
   (`RESOURCE_FOREIGN`); the kinds `database.docker.provision` (preflight,
   create, wait-healthy, provision through the #338 library, verify),
   `.start`, `.stop`, `.repair` and `.reconfigure` (backup first, inside a held
   barrier); generated passwords that never reach argv, the journal, the
   audit log or a state file (the application's URL lives only in the
   manager's overlay, `database.connect { owned: docker }` is the cutover);
   the `DATABASE_NOT_READY` gate before workers start; an uninstall that keeps
   the data unless `removeDockerData` is set; `GET /manager/api/docker/status`,
   `goobster-manager database docker ...`, the Database step option, the
   instance card on the Database page and the Host proxy. Unit and route tests
   run against a fake `docker` executable; the real-container block runs with
   `GOOBSTER_DOCKER_TESTS=1` in a CI job that has a daemon. Not built here:
   moving a Docker data directory, a remote Docker host and Windows
   containers (native PostgreSQL followed in #340). See [docker_postgres.md](docker_postgres.md).
   PR [#368](https://github.com/nervous-rob/goobster/pull/368) (stacked on
   #367): SQLite full suite 287 suites / 5853 passed; Postgres `core` 2466 and
   `portal` 1137 passed in isolated schemas; Playwright 254 passed; lint, smoke,
   docs and group inventory green; the `test (docker postgres)` CI job runs the
   gated real-daemon blocks. A delete-data uninstall that leaves the volume
   warns `DOCKER_DATA_RETAINED`.

   **Status (P4.7, #340): native PostgreSQL on supported Linux built (stacked
   on #339).** The native entry of the chooser is enabled only on Debian 12 /
   Raspberry Pi OS Bookworm, Ubuntu 22.04+ or AlmaLinux/Rocky 9 (x86-64 or arm64)
   with an elevation that needs no prompt; PostgreSQL 17 comes from the PostgreSQL
   project's apt or dnf repository, added by the privileged helper only after the
   signing key's fingerprint matches the one pinned in
   `packages/core/db/native/pgdg.js` (`PGDG_KEY_MISMATCH` otherwise); packages are
   installed only with `installPackages` and stay installed on uninstall. The
   kinds `database.native.provision` (preflight, packages, cluster, schema,
   verify-database), `.start`, `.stop`, `.repair` and `.relocate` (verified
   backup first, inside a held barrier, the original directory kept) run through
   five closed privileged operations (`package.install`,
   `postgres.cluster.create|control|remove|relocate`) that the helper re-checks
   against the manager's `native-postgres.json` and the data directory's marker;
   the cluster is `goobster` (or `goobster-<id8>`) beside any existing cluster,
   which is never touched; the application role is created `NOSUPERUSER` from a
   SCRAM-SHA-256 verifier so no password is on any command line, and its URL
   lives only in the manager's overlay (`GOOBSTER_NATIVE_DB_URL` until
   `database.connect { owned: native }`); the `DATABASE_NOT_READY` gate; an
   uninstall that keeps the cluster and data unless `removeNativeData` is
   confirmed with the installation id; `GET /manager/api/native/status`,
   `goobster-manager database native ...`, the Database step option, the
   instance card on the Database page and the Host proxy. Unit, route and
   Playwright tests run the real helper as an ordinary user inside a fake machine
   (`tests/helpers/fakeNative.js`); `.github/workflows/native-postgres.yml`
   runs `scripts/native-postgres-real-distro.js` on Ubuntu 24.04 (x86-64 and
   arm64) and in Debian 12 and Rocky Linux 9 containers, and nothing has run on
   a real distribution before that workflow's first run. Not built here: Windows and macOS native services,
   PostgreSQL major upgrades, backup scheduling, and moving the data directory
   from the wizard (it is a CLI journey). See
   [native_postgres.md](native_postgres.md).

   The P4.5 chooser below:
   PR [#365](https://github.com/nervous-rob/goobster/pull/365) (stacked on
   #363, merging #362): SQLite full suite 276 suites / 5551 passed; Postgres
   `core` 2186 and `portal` 1116 passed in isolated schemas, the real-server
   blocks 122 passed as a superuser; Playwright 239 passed; lint, smoke,
   docs and group inventory green.

Acceptance: every operation refuses to start while another holds the
lock; an interrupted restore or migration recovers to a stated state;
reset leaves no table with rows on either engine.

### Phase 5: release

Signing (certificates are an open dependency; design the release build
before this phase), auto-update through the manager, the GitHub Actions
release matrix, docs. Deferred items picked up here if wanted: native
Windows and macOS Postgres provisioning; major-version upgrades for
Postgres instances the manager owns, as a separate labelled workflow.

**Status (P5.1, #341): the signed release pipeline and the artifact
verification contract are built; nothing has been signed.**
`documentation/release.md` is the reference. `.github/workflows/release.yml`
runs for `v*` tags and manual dispatch (never a pull request): a `plan` job
derives the channel (`v1.4.0` stable, `-rc.N`/`-beta.N`/`-alpha.N` and every
dispatch prerelease) and the signing mode, stopping a stable tag with no active
key at `RELEASE_BLOCKED_UNSIGNED`; a five-target build matrix builds, signs and
scans each target; a `publish` job assembles and signs `release-index.json`
(`scripts/release-index.js`, `scripts/lib/releaseIndex.js`), verifies it under a
production and a development policy, and publishes a GitHub Release, leaving a
failed target out of the index and the notes. The index adds a second signed
layer over the per-payload manifest of #328 without changing it;
`scripts/release-verify-artifacts.js` refuses a release artifact carrying
config, keys, databases or a binary for the wrong platform; the manager's
install record reports `signed`, `keyId` and `channel`. `scripts/release-keys.json`
ships with **no active key** and the Windows, Apple and key secrets are the
owner's to supply, so every stable build is blocked today and every other build
is an `UNSIGNED DEVELOPMENT BUILD`. Proven on Linux x64 by Jest
(`tests/releaseIndex.test.js`, `releaseArtifacts.test.js`,
`releaseManagerTrust.test.js`, `releaseWorkflow.test.js`) and a local run
against a real payload; the Windows and macOS signing steps and the arm64,
macOS and Windows jobs are written and structurally tested but have not run.

**Status (P5.2, #342): staged manager updates with a health-checked apply and a
schema-gated rollback are built.** `documentation/manager_update.md` is the
reference. The installation record carries an explicit `update` policy
(`channel`, `mode` of `off`, `check`, `download` or `apply`, an optional
window and a source); it is `off` until somebody chooses, the setup wizard and
the adoption flow ask once, and `apply` is honoured only while the manager is
the updater, so an adopted Pi keeps its `auto-update.sh` timer until the
adoption turns it off through `updater.disable`. `update.check`,
`update.stage`, `update.apply`, `update.policy` and `update.recover` run in the
step ledger; the index is verified under the production policy with the
verifier the payload now carries, the artifact against the size and SHA-256 it
names, and a corrupted download is deleted and nothing is applied. Apply runs
inside the maintenance barrier (preflight, a verified backup, quiesce,
activate, verify with a restart, `/health`, the revision acknowledgement and
the running release id, cutover, release), and the downtime is the span from
quiesce to release. The manager's own code changes through an OS-supervised
handoff: it leaves with exit code 76 after a durable `handoff.json` and a
`watchdog.json`, the service manager restarts it from the new `current`, and
the new manager finishes the update; the crash matrix is documented. The
schema fingerprint (SHA-256 of `schema.sql` and the ordered
`COLUMN_MIGRATIONS`) decides the rollback: a failed update that cannot have
changed the database is put back automatically, and a schema-changing update
that fails after activation, even before `/health`, stays in `recovery` with the
barrier held until the operator chooses to restore the pre-update backup or
retry. `config.json`, `features.json` and the data roots are never touched,
and the service registration is re-rendered only when its template hash
changed. The portal Host card has an Updates panel and the CLI has
`goobster-manager update`. Proven on Linux x64 by Jest
(`tests/updateCheck.test.js`, `updateStage.test.js`, `updateApply.test.js`,
`updateHandoff.test.js`, `updateRoutes.test.js`, `updateHostRoutes.test.js`,
`updateService.test.js`), the provider-free Playwright journey
`e2e/update.spec.js`, and a local proof with a real minimal payload, real
workers and a restart loop standing in for the OS supervisor: a healthy
1.0.0 to 1.1.0 update through the exit-76 handoff (downtime 3.7 s, secrets,
layout, features and application data identical afterwards), a corrupted
archive refused at stage, an automatic rollback when the new workers die at
start, and a schema-changing release that failed after `/health` left in
`recovery` and restored from the backup. The October 8 hosted matrix also passed the Windows (WinSW-style restart)
and macOS handoffs using its simulated OS supervisor. The matrix is being
extended to assert custom-root, feature-selection and account-preference
preservation. Registered-service refresh remains a separate native acceptance
requirement; its unit tests verify the registration inputs and ownership record.
The pre-health failure policy now holds recovery after every schema-changing
activation. A real-DDL regression runs in the SQLite/Postgres test matrix;
first-attempt and watchdog failures are also covered. Hosted results for these
new assertions must be linked before marking the remaining acceptance complete.

**Status (P5.3, #343), operator runbooks: published, walked on Linux only.**
`documentation/operator_runbooks.md` gives a second operator numbered
procedures, with the commands, the expected result and the refusal code with its
remedy, for getting started on Linux, Windows and macOS (first owner without
Discord, first chat), the feature and configuration reference, service
ownership, network access, backup and recovery, migration and rollback, upgrade
and uninstall, each with a "what this cannot do" line. The Linux getting-started,
backup and restore, feature toggle and uninstall procedures were executed from
that document on a Linux x64 machine (no systemd, no Discord) and the document
was corrected where a step did not work as written; the Windows and macOS
procedures, systemd registration, adoption, SQLite to Postgres migration,
Docker-managed Postgres and `update apply` were not run. The walk found
problems that need a source change and are recorded in the document rather
than fixed there: a full uninstall leaves `config.json.pre-restore-<time>`,
and several manager operations have no command-line verb (the silent exit 1 of
a command-line `restore` waiting on the barrier, also found by the walk, is
fixed by the matrix half below). The accessibility
record is `documentation/accessibility_review.md`. Open owner decisions the
runbooks name and do not close: #249 (the restore drill on a real second host),
#255 (authentication policy), #262 (public listing) and the signing material
for #372.

**Status (P5.3 matrix half, #343): the acceptance driver, the workflow and the
generated matrix are built, and the hosted matrix passed on all nineteen
cells (2026-10-08, PR #377, seventh run).**
`documentation/release_acceptance.md` is the reference. `scripts/acceptance/run.js`
runs one cell (install new or adopt; SQLite, an existing Postgres server or
Docker-managed Postgres; minimal, representative or full features) through the
manager's own command line, the manager process and its loopback API, never a
manager module, and records thirteen lifecycle steps and nine failure and
negative-authorization injections as pass, fail, n/a or deferred, each with its
commands, exit codes and durations. `.github/workflows/release-acceptance.yml`
runs 19 hosted cells (linux x64 and arm64: new and adopt by SQLite and
managed Postgres by minimal and representative; macOS arm64 and x64 and
Windows: new, SQLite, minimal) with read-only permissions and no secrets,
uploading evidence from every cell; `scripts/acceptance/report.js` renders the
table. Local runs on 2026-10-08 (artifact 1.0.0, development-signed) passed
every step and injection that applies on four cells (SQLite minimal and
representative, an existing Postgres server, an adopted installation) and on
the Windows payload layout run under Linux; the hosted run of the same day
passed all nineteen cells — managed Postgres, macOS, Windows and linux-arm64
included — after six runs that each found defects the PR fixed (findings 8 to
20 in `release_acceptance.md`); a Raspberry Pi is deferred. The runs found and
fixed two manager defects locally (a silent exit of a CLI command waiting on
the maintenance barrier; a restore over a SQLite file that is not a database)
and thirteen more on the hosted runners (most of them Windows: the archive
download, the archive read, the launcher with no argument, the payload
activation under a running manager), and left two operator-visible behaviours
open (the CLI does not read the manager's database overlay; the switch to
Postgres reaches the running manager at its next start). The operator recovery
runbooks are the other half of P5.3. **Acceptance remains open:** physical Pi
validation, full-disk failure injection, a recorded second-operator recovery
drill, human accessibility validation and production-release qualification
are not established by the hosted matrix. The separate requirements in
#331–#333 and #340–#342 still apply. The updater now blocks pre-health
schema rollback; its new regression results and remaining native preservation
evidence must be recorded on #342. See [release acceptance caveats](release_acceptance.md#caveats).

## Audits before implementation

| Id | Question | Needed by | Result |
|---|---|---|---|
| E1 | Which services read or write points outside Economy and Exchange? Decides whether accounting is infrastructure. | Phase 1 | Done (#316). No caller outside Economy, Exchange, Gambling and the Activity except `privacyService` (core exception) and `automationService.executeWheel` (gated inside the core step). Accounting is the `economy` feature; `exchange` and `gambling` depend on it. `documentation/feature_inventory.md` § E1. |
| T1 | Which AI tools belong to which feature; which are core. | Phase 1 | Done (#316). 53 registry tools + `web_search` claimed in `inventory.js` `aiTools`; `execute()` gating gap recorded for #319. § T1. |
| R1 | Every route under `packages/core/web/routes/` mapped to a feature or to core. | Phase 1 | Done (#316). Every mounted route (core routers and bot-side mounts), WS path and static bundle claimed by the ordered `routeRules`; checked by the inventory spec. § R1. |
| S1 | Every `coreRuntime` step and every `index.js` startup side effect mapped to a feature. | Phase 1 | Done (#316). 20 steps (13 core, 7 single-owner), startup side effects, 26 listeners and 17 interaction families claimed; bundled core steps gate feature branches inside (#318). § S1. |
| M1 | Mail's registration and account-recovery dependencies. | Phase 1 | Done (#316). Refuse disabling while `identity.nativeLogin && registration === 'open'`; warn when verified addresses exist otherwise; operator recovery link never needs mail. § M1. |
| L1 | Long-running work (expeditions, sandbox, voice sessions) and its current interruption behaviour. | Phase 2 | Done (#325). Ten kinds of work, what SIGTERM did to each, where its durable state lives and the declared contract (`checkpoint`/`cancel`/`drain`/`none`) with its bound: `documentation/manager_lifecycle.md` § L1. |
| N1 | Prebuild availability for each native module on each target, pinned to the bundled Node ABI. | Phase 3 | Done (#327). Result in `documentation/packaging_proof.md`: Node 22.23.3 (ABI 127); every module has an upstream prebuild for all five targets, executed in CI on each; arm64 glibc 2.33 (B2) and macOS `sqlite-vec` minimum (B3) narrow the supported OS range. |

## Compatibility rules

- No `data/features.json`: behaviour is unchanged and legacy `enabled`
  flags are honoured. First write seeds the file from them.
- The schema stays universal. Dormant data is reachable by privacy,
  export and retention.
- Core must not import from apps; the manager is an app and reaches core
  through `@goobster/core`.
- SQL stays in the SQLite dialect; engine differences stay in
  `db/dialect.js`.
- Every new per-user store is reachable by `privacyService`.
- Ledger rows never carry prompts, replies, tokens, links or addresses.


### Acceptance and accessibility follow-up (#343)

The shared modal implements initial focus, topmost-dialog Tab containment,
accessible naming and opener restoration, with mandatory keyboard assertions.
Linux acceptance adds a bounded tmpfs capacity-refusal proof that observes
`ENOSPC` and then checks installer preflight without mutation. Typecheck/build
pass locally; hosted keyboard and bounded-volume results remain pending. Human
accessibility, mid-write disk exhaustion, full-disk behavior on other OSes and
independent second-operator recovery remain open.


### Release qualification follow-up (#341)

Mach-O signing and strict verification are now hooked before payload manifest
hashing. The macOS packaging proof exercises ad-hoc signing, and all payload
proofs run strict hygiene checks. Manual release dispatch defaults to verification
only; publication requires an explicit `publish` choice. Local signing-contract,
workflow and hygiene regressions pass; hosted hook evidence remains pending.
Production credentials, notarization/Gatekeeper checks and publication approval
remain outstanding. No production release was dispatched or published.


### Native PostgreSQL data-path follow-up (#340)

The real-distro workflow now includes matching-client backup/restore and
relocation through the manager engine with a real API worker, maintenance fence,
and verified backup. This replaces the direct relocation service call in the
proof. Local backup/restore and credential-argument tests pass on SQLite; native
PostgreSQL and distribution results remain pending the expanded hosted workflow.
No #340 acceptance checkbox is closed by adding an unrun proof.


### Native interruption qualification follow-up (#331–#333)

The native bootstrap jobs now include real service-helper interruption/retry and
browser-closure checks through `scripts/native-service-recovery-proof.js`.
Windows registration retries finish recovery-policy and service-SID setup even
when the previous helper stopped immediately after `sc create`. Local helper
regressions pass; the new native journeys still need hosted results. No platform
acceptance checkbox is closed by adding these checks. Toolchain-free hosts,
physical reboot/login behavior, macOS pkg reproducibility and signing remain
separate requirements.
