# ADR 0013: Feature manifest, management process and installer

## Status

Proposed. Implementation plan: `documentation/installer_plan.md`.

## Context

Every command folder under `apps/bot/commands/` is loaded and deployed,
every `coreRuntime` worker starts, and every AI tool is exposed, whatever
the operator wants. About fifteen `enabled` flags are scattered across
`packages/core/config/*` with no registry, so there is no way to say
"this installation does not have Music Lab" and have the server honour it
everywhere: commands, tools, routes, schedulers, message routing and the
portal.

Installation is a shell script for Raspberry Pi (`scripts/install-rpi.sh`),
Docker Compose for the full profile, and hand editing of `config.json`
elsewhere. There is no Windows or macOS path, no guided configuration, and
no operator-facing way to back up, restore, reset or migrate the database.
Restart is entirely external (systemd, PM2, Docker); the process has no
self-restart contract.

`scripts/initDb.js --reset` drops a short legacy table list through
SQLite-only APIs. `instanceStateService`'s paused state stops workers but
leaves interactive requests served. `scripts/migrate-to-postgres.js`
creates the target schema on its normal run and has no preflight.

## Decision

1. **One feature catalog.** `packages/core/features/catalog.js` declares
   every optional feature: the command files, runtime steps, AI tools,
   routes, event hooks, config keys, API keys, system dependencies and
   feature dependencies it owns. Every API key is described once (purpose,
   where to obtain it, which features need it, how to probe it). The
   wizard, the operator pages, the CLI and the docs render from the
   catalog; a test keeps the docs and the catalog in step.
2. **Feature state is per installation**, in `data/features.json`, with
   four separate states per feature: **installed** (payload present),
   **configured** (required keys and dependencies satisfied),
   **active** (enabled by the operator) and **pending** (a change awaits
   restart). An environment override can deactivate a feature; it cannot
   activate one that is not installed.
3. **Gating is enforced at every execution surface** from the same
   predicate: command loading and deployment (one filter so what Discord
   shows matches what the process answers), `coreRuntime` steps, the AI
   tool registry, HTTP routes, `messageCreate` gates, portal navigation
   and the system prompt. Phase 1 promises "a disabled feature cannot
   execute", not "its code is not loaded".
4. **Disabling is non-destructive.** The schema stays universal; data of a
   disabled feature is dormant and still reachable by privacy, export and
   retention paths. Deletion is a separate, explicitly confirmed purge.
5. **Compatibility.** An installation without `data/features.json` keeps
   today's behaviour and its existing `enabled` flags, which seed the
   file on first write.
6. **Feature boundaries** follow what a feature is, not where its code
   lives: Music and Voice are separate; Projects and MCP are separate (MCP
   exposes only installed features); Spitball knowledge tools and
   Expeditions are separate with an explicit dependency; GitHub and Cursor
   are separate; Discord and Push are independent adapters; Mail is a
   delivery integration whose registration and account-recovery
   requirements are checked before it can be disabled. Memory storage,
   export and erasure are infrastructure; recall and consolidation are
   settings. The Inbox and system notices are always available. Economy's
   shared accounting is audited before it is split from games and trading.
7. **A management process** (`apps/manager`) owns setup, repair, restart,
   backup, restore, reset and migration. It starts without the
   application database, Discord, provider keys or optional features, and
   keeps installation state and operation progress in its own store. It
   binds to localhost; headless access is an SSH tunnel by default, with
   token-protected LAN access as an explicit option. First-time setup uses
   a one-time local credential. A broken database on an existing
   installation enters an authenticated recovery flow and never reopens
   first-time setup. The management interface stays reachable when the
   portal or any feature is disabled. Privileged work (service
   registration, package installation) goes through narrowly defined
   operations; the regular servers run unprivileged.
8. **One setup engine, three fronts.** The wizard (React, sharing
   components with the operator pages), the headless CLI and the operator
   pages call the same engine through the manager's API.
9. **Installer shape: web wizard plus native bootstrappers.** A thin
   bootstrapper per platform (Windows NSIS, macOS pkg, Linux script and
   AppImage) unpacks a bundled Node runtime and the payload, registers the
   manager service, then opens the wizard. Native modules are prebuilt for
   the bundled Node ABI. Selective installation ("an excluded feature is
   not installed, nor its exclusive dependencies or frontend bundles") is
   a packaging deliverable with its own acceptance tests against the
   reduced payload, separate from gating.
10. **Lifecycle contract.** The manager supervises the bot and API
    workers for every deployment layout through adapters: sentinel exit
    code for a requested restart, signal forwarding, restart-loop limits,
    health checks and worker coordination. The operating system still
    supplies boot start and recovery of the manager itself. Applying a
    feature change validates configuration, stages any downloads, then
    schedules a restart with a 60-second grace period and a "restart now"
    option. Long-running work (expeditions, sandbox jobs) declares its own
    checkpoint or cancellation behaviour; the grace period does not
    promise completion.
11. **Database maintenance is a maintenance state, not the paused state.**
    Restore, reset and migration take an operation lock that blocks writes
    from every application process, record durable progress, define
    cancellation and recovery after interruption, and state their scope.
    Reset is rewritten to cover the whole current schema on both engines.
    The SQLite-to-Postgres migrator gains a true preflight that touches
    nothing.
12. **Postgres scope.** Supported first: an existing server (version and
    `vector` extension checks, create database and extension), a Docker
    container the operator explicitly chooses, and a managed native
    install on Linux. Native Windows and macOS provisioning is deferred.
    Major-version upgrades of Postgres instances the manager owns are a
    separate, later workflow labelled as such; a schema update is never
    called an upgrade. Shared servers get compatibility checks and a
    guided migration path instead.
13. **Packaging validation starts early.** Before the full wizard exists,
    a minimal bundled server must start on Windows, macOS, Linux x64 and
    Linux arm64 with its native dependencies, and tests run against the
    actual reduced payloads, not only the full source checkout.

## Consequences

Phase 1 (catalog and gating) is useful on its own and touches the riskiest
invariants (routing order in `messageCreate.js`, both database engines), so
it lands and stabilises before the manager or installer exist.

Operators gain one management interface for desktop and headless
installations. The project gains a new workspace (`apps/manager`), a
release pipeline that builds three bootstrappers and prebuilt native
modules, and an open dependency on code-signing certificates that must be
resolved before the release phase; unsigned builds trip SmartScreen and
Gatekeeper.

Every feature ships with its catalog entry and its doc, and the catalog
becomes the source for the configuration and commands references, which
keeps what Goobster knows about himself (`consultDocs`) accurate.
