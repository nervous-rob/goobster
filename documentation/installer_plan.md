# Installer and feature manifest: implementation plan

Decisions are recorded in `documentation/adr/0013-installer-and-feature-manifest.md`.
This document is the working plan: phases, acceptance criteria, audits to
run before each phase, and open items. It is updated as phases land.

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

Status (issues #316 - #322 under epic #315):

| Issue | Scope | State |
|---|---|---|
| #316 | Audits E1/T1/R1/S1/M1, ownership inventory, ADR 0013 accepted | Inventory module `packages/core/features/inventory.js`, spec `tests/featureInventory.test.js`, `documentation/feature_inventory.md` (PR pending review) |
| #317 | `catalog.js` + `featureState.js` contract | Catalog `packages/core/features/catalog.js` (+ `descriptors/`), resolver `featureState.js`, `legacyResolver.js` and `gate.js`; specs `tests/featureCatalog.test.js`, `tests/featureState.test.js`; contract in `documentation/feature_state.md`. Nothing consumes the predicate yet (PR pending review) |
| #318 | Command loader / deploy, `coreRuntime.step()`, `messageCreate` and interaction gating | One lister and one filter for command load and deploy (`commandDeployment.listCommandFiles` / `featureCommandFilter`; filtered files are never required; the deploy hash covers the served feature set). Stale slash commands, autocomplete, context menus, buttons, selects and modals of an enforced-off feature are refused ephemerally before any handler (`interactionCreate.gateComponentInteraction` / `refuseUnavailableCommand`; `collector:<id>` keys keep `clear_search_button` with its own collector; `intaction` resolves its owner from the pending action). `coreRuntime.step(name, fn, { feature })` skips an enforced-off step without invoking it and reports `skipped:feature` apart from `paused`; bundled steps drop their feature branches (`applyBundledFeatureGates`); `executeWheel` refuses at the top. `serviceManager.voiceService` is lazy (inert stand-in when voice is off); voice/music/issue-capture listeners and the command-backed tool adapters follow the snapshot; `messageCreate` gates `#06`/`#10` skip cleanly with the order unchanged. Enforcement rule shared with #319/#320 (`featureState.enforcedOff`): no file ⇒ identical to the unfiltered walk. Specs `tests/featureGatingCommands.test.js`, `tests/featureGatingRuntime.test.js`; `tests/independentRuntime.test.js` and `tests/backupRestore.test.js` pin the state they assume (PR pending review) |
| #319 | AI tool registry, `runAgentLoop`, MCP gating | Discovery and dispatch are gated independently in `toolsRegistry` (`getDefinitions` filters by `surfaceActive('aiTool', name)`; `execute` refuses a stale or direct call with `FEATURE_UNAVAILABLE` before approvals, admission or side effects). `runAgentLoop` treats `FEATURE_UNAVAILABLE` as a terminal observation (repeat calls short-circuited, no implicit activation). `promptContext` adds one `UNAVAILABLE HERE:` line from `features.unavailable()`, omitted when nothing is off. MCP tool and resource listings, `tools/call` and `resources/read` are filtered per request, and the `mcp` feature off makes HTTP and stdio refuse to serve (`apps/mcp` refuses to start). Specs `tests/featureGatingTools.test.js` and `tests/featureGatingMcp.test.js`, plus adjusted `tests/mcpServer.test.js`, `tests/toolsRegistryRunCode.test.js` and `tests/toolsRegistryObservatory.test.js` (PR pending review) |
| #320 | HTTP / WS / Activity / internal route gating | One network-edge gate in `packages/core/web/featureGate.js`: `routeGate` middleware resolves each request against the inventory's ordered `routeRules` and answers `404 { error: 'FEATURE_UNAVAILABLE', feature }` for an enforced-off owner (`ownerGate`/`mountable` for whole mounts, `guardOpenSocket`/`rejectUpgrade` for WebSocket paths). Mounted in `appApi.js` (first), `appWebsocket.js`, `apps/bot/web/server.js`, `activityApi.js`, `screenVisionApi.js`, `gbaRunApi.js` and `apps/api/server.js`. `GET /api/app/features` returns the sanitized status for clients. Enforcement rule unified here for all surfaces: `featureState.enforcedOff(id)` is true only with a usable `features.json`, a `GOOBSTER_FEATURE_<ID>` override off, or an enforced-off hard dependency, so with no file nothing new is refused; `gate.js` and the #319 tool/MCP gates consume the same predicate. MCP token-management routes (`/api/app/mcp*`) reassigned to `core` so revocation stays reachable. Specs `tests/featureGatingRoutes.test.js` (router-stack walk of every mounted route) and `tests/featureGatingWebsocket.test.js` (PR pending review) |
| #321 | Portal rooms, tutorials, `consultDocs` availability | The portal fetches `GET /api/app/features` once per session beside `me` (legacy `me.features` kept as the fallback). Rooms and nested views declare `requires.feature` in `rooms.cjs`; navigation omits host-unavailable rooms and views, Tools shows an unavailable card (reason, dependency title, doc link) distinct from the user-hidden state, and a deep link renders a "not available on this installation" state inside the shell. Tutorial requirements corrected (`knowledge.research`, `projects.runs`, `trading.basics`); an unavailable tour is listed `available: false` with a reason and refused with `FEATURE_UNAVAILABLE` (`gate.requireSurface('tutorial', id)`), never completed, progress kept. `feature:<id>` front matter on the feature docs; `consultDocs` search/read/list annotate an inactive feature's docs at query time, never hidden. `documentation/features.md` is generated by `scripts/generate-features-doc.js` (`npm run docs:features`, `--check` inside `npm run docs:check`). Specs `tests/featureGatingPortal.test.js` and `e2e/featureAvailability.spec.js` (PR pending review) |
| #322 | Cross-surface conformance and dormant-data tests | `tests/featureConformance.test.js` (35 profiles x every gated surface kind, bot boot, inventory negative checks, loaded-versus-executed report) and `tests/featureDormantData.test.js` (two accounts, every feature off: report, export, erasure, retention, vectors, off/on round trip, no feature work); shared fixtures in `tests/helpers/featureFixtures.js`. Closes the privacy and export reach gaps (`agent_runs`, `pending_integration_actions`, `integration_audit`, `repo_watches`, `screen_vision_clients`, `kg_reflection_runs`; the export now carries economy, exchange, Tavern, Song Studio, push, friends and DMs, integrations and sandbox) and gates Web Push delivery on `push`. Rooms, nested views, tutorial listing and launch refusal, and self-docs annotation are asserted per profile against #321's implementation (PR pending review) |

Pull requests, as one stack in dependency order (each base is the previous
PR's branch; none merged yet, so no Phase 1 issue is complete until the
stack lands): #346 (#316) -> #347 (#317) -> #349 (#319) -> #350 (#320) ->
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
| Gambling cannot be enabled on a shared instance without the attestation, recorded in `operator_audit` (#261) | Not covered by #322: it is a Phase 2 operator action (no toggle surface exists yet) |
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
   `documentation/packaging_proof.md`.
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
   keys are #341. The wizard (#329) and the bootstrappers (#331) consume
   the seams listed in `documentation/packaging.md`, "The manager seam".
3. Wizard screens, each with an "about this" panel: mode (install,
   reconfigure, repair, uninstall); features with size, dependencies and
   cost; keys with links, live probes and restricted-permission writes to
   `config.json`; database (SQLite only in this phase); instance defaults;
   review and progress; first-run check.

   **Status (P3.3, #329): engine and CLI built, no wizard screens yet.**
   `documentation/manager_install.md` is the reference. Done: the version 2
   installation record with explicit ownership; read-only discovery of
   payload, Raspberry Pi script, PM2, Docker and manual installs; preflight;
   the `install.new`, `install.reconfigure`, `install.repair` and
   `install.uninstall` kinds and the managed form of `adopt` (with updater
   reconcile); resume after interruption; uninstall that keeps data by
   default and writes a tombstone. Not done: the wizard screens (item 3
   itself), network download and archive sources, and every privileged
   operation (`service.register`, `service.unregister`, `updater.disable`,
   `user.create` answer 501, so no OS service registration has been tested).
4. Headless CLI running the same engine (answers file or prompts).

   **Status (P3.3, #329): built.** `apps/manager/cli.js` (`install`,
   `adopt`, `reconfigure`, `repair`, `uninstall`, `plan`, `status`,
   `discover`, `schema`) takes a mode 0600 answers file validated against
   `apps/manager/install/answers.schema.json` or prompts, supports
   `--dry-run` and `--json`, refuses secrets on the command line, and
   exits 0/2/3/4/5 as documented. Proven on Linux x64 against throwaway
   directories only.
5. Bootstrappers: Windows NSIS, macOS pkg, Linux script and AppImage;
   privileged operations limited to service registration and package
   installation; the installation registry per user; repair keeps `data/`
   and `config.json`; uninstall keeps them unless the operator explicitly
   chooses to delete data, with the privacy consequence stated.

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
4. Backup and restore UI over `backupService` and `scripts/restore.js`.
5. Postgres: existing server (version and `vector` checks, create database
   and extension, host, port, bind), explicitly chosen Docker container
   (the compose pgvector image), managed native install on Linux (from
   `scripts/ensure-local-postgres.sh`), storage path for managed
   instances. The explainer and a recommendation from the selected
   features.

Acceptance: every operation refuses to start while another holds the
lock; an interrupted restore or migration recovers to a stated state;
reset leaves no table with rows on either engine.

### Phase 5: release

Signing (certificates are an open dependency; design the release build
before this phase), auto-update through the manager, the GitHub Actions
release matrix, docs. Deferred items picked up here if wanted: native
Windows and macOS Postgres provisioning; major-version upgrades for
Postgres instances the manager owns, as a separate labelled workflow.

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
