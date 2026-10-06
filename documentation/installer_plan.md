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
| Feature state | `data/features.json`: per-feature `installed`, `configured`, `active`, `pending`. |
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

Optional features, each with its own switch:

| Feature | Notes |
|---|---|
| Music | Music Lab, downloads, the python venv (yt-dlp, spotdl). Depends on Voice. |
| Voice | Voice chat and TTS without Music. Needs ffmpeg. |
| Tavern | Adventure mode. |
| Exchange | Trading, margin, options, futures, the risk engine. Depends on Economy. |
| Economy | Games and point features. Shared accounting may stay infrastructure (see audit E1). |
| Projects | Project rooms, agents, mission-control threads. |
| MCP | The MCP access mechanism; exposes only installed features. |
| Knowledge (Spitball) | Knowledge editing and graph tools. |
| Expeditions | Autonomous research. Depends on Knowledge. |
| Sandbox | The code-execution runner and tools. |
| GitHub | Integration. |
| Cursor | Integration. Grouped with GitHub in the wizard, separate switch. |
| Screen Vision | |
| Observatory | |
| Activity (Discord Activity) | The embedded app and its workers. Inbox and notices stay. |
| Discord adapter | Independent adapter (`config/discordConfig.js`). |
| Push | Independent adapter. |
| Mail | Delivery integration. Disabling is refused while registration or account recovery requires it, with the reason shown. |

Memory recall and consolidation stay settings (`ai.memory.enabled`), not a
feature.

## Phases

### Phase 1: catalog and gating

Deliverable: a disabled feature cannot execute. Code may still load.

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
     short-circuits when Projects is off; the order of gates is unchanged);
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

### Phase 2: manager process, lifecycle and operator pages

Deliverable: an operator changes features from the portal, and the
installation restarts safely.

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
2. Payload builder: resolves the selected features to files and exclusive
   dependencies (ffmpeg for Voice, the python venv for Music, the sandbox
   runner), builds the frontend with only the selected rooms.
3. Wizard screens, each with an "about this" panel: mode (install,
   reconfigure, repair, uninstall); features with size, dependencies and
   cost; keys with links, live probes and restricted-permission writes to
   `config.json`; database (SQLite only in this phase); instance defaults;
   review and progress; first-run check.
4. Headless CLI running the same engine (answers file or prompts).
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
2. Reset rewritten for the whole current schema on both engines, with
   explicit scope (everything, or per feature's dormant data) and typed
   confirmation.
3. Migrator: true preflight, required verified backup, row-count
   verification, rollback point.
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

| Id | Question | Needed by |
|---|---|---|
| E1 | Which services read or write points outside Economy and Exchange? Decides whether accounting is infrastructure. | Phase 1 |
| T1 | Which AI tools belong to which feature; which are core. | Phase 1 |
| R1 | Every route under `packages/core/web/routes/` mapped to a feature or to core. | Phase 1 |
| S1 | Every `coreRuntime` step and every `index.js` startup side effect mapped to a feature. | Phase 1 |
| M1 | Mail's registration and account-recovery dependencies. | Phase 1 |
| L1 | Long-running work (expeditions, sandbox, voice sessions) and its current interruption behaviour. | Phase 2 |
| N1 | Prebuild availability for each native module on each target, pinned to the bundled Node ABI. | Phase 3 |

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
