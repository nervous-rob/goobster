# Reactive Port — Status and Next Phases

Companion to `documentation/reactive_port_spec.md` (the authoritative plan).
This is the handoff note: what has shipped, what was learned doing it, and
exactly where the next session picks up.

## Where things stand (2026-08-18)

| Phase | Spec § | Status |
| --- | --- | --- |
| Spec | — | Merged (#139) |
| 0 — monorepo split | §5, §13 | **Done** (#141): `packages/core` + `apps/bot`, ~880 specifiers rewritten, `runtimePaths`, core-never-imports-apps ESLint rule |
| 1 — async DB facade | §7.2 | **Done** (#141): async `get/all/run/insert/transaction`, ALS-routed transactions with savepoints, ~5,600 await sites |
| 2 — Postgres adapter | §7.3 | **Done** (#142): `GOOBSTER_DB_URL`-selected pg adapter, per-statement dialect translation, pgvector recall, `npm run migrate-to-postgres`, two-engine CI matrix |
| 3 — gateway seam + api service | §6, §13 | **Next** |
| 4 — reactive client | §8 | Pending |
| 5 — hardening | §11, §13 | Pending, on demand |

Production state: the maintainer's Pi ("bigpi") runs the bot on **Postgres 17
+ pgvector**, cluster on a USB drive at `/mnt/ssd` (guide:
`documentation/postgres_setup.md`), 47,289 rows migrated with verified
counts. The SQLite file remains on disk as the pre-Postgres snapshot.
`GOOBSTER_DB_URL` is injected via a systemd drop-in
(`/etc/systemd/system/goobster.service.d/override.conf`), which survives
auto-updates and `GOOBSTER_SYNC_UNIT` re-renders.

Verification commands the next session will want:

```bash
npm test                       # SQLite matrix (1702 tests)
GOOBSTER_DB_URL=postgres://... GOOBSTER_PG_TEST_ISOLATE=1 npm test   # Postgres matrix
npm run lint && npm run smoke  # 0 errors / all modules load
```

## Operational learnings (so nobody re-learns them)

- **Deploys**: `/etc/goobster-update.conf` needs `GOOBSTER_SYNC_UNIT=true`
  whenever a release changes `deploy/goobster.service`. A failed deploy
  auto-rolls back; "rollback install failed" has so far always meant
  root-owned files in `node_modules` — fix is
  `sudo chown -R <user>:<user> ~/goobster && npm ci --omit=dev`.
- **Postgres test isolation**: each jest suite gets a throwaway schema
  (`GOOBSTER_PG_TEST_ISOLATE=1`); pools close per suite
  (`tests/setup/perSuite.js`) or the matrix exhausts `max_connections`.
  Never fake timers around real pg I/O — drive timer callbacks directly
  (see the tableManager timers test).
- **The async facade's ordering guarantee**: un-awaited `db.run()` executes
  synchronously on SQLite but NOT on Postgres. Fire-and-forget writes that
  a later read depends on are bugs; three were found (`tracker?.track()`).
  Suspect this class first when a Postgres-only test failure appears.
- **Dialect rules live in `packages/core/db/dialect.js`** and nowhere else.
  New SQL keeps being written in SQLite dialect; if Postgres rejects a
  construct, extend the translator (or make the call site portable), never
  fork per-engine SQL in services.

## Phase 3 — the gateway seam + api service extraction (next)

Spec §4, §6, §12, §13. The step that actually splits the process. Suggested
order:

1. **`DiscordGateway` interface in core** (spec §6 has the method list).
   Derive it from the real call sites: `utils/webGuildAccess.js`
   (`requireGuildMember` — exchange terminal, memory dashboard, knowledge
   graph), `webDashboardService` (mutual-guild scope listing),
   `webTaskService` / `automationService.executeDmAutomation` (DM
   delivery), `friendService.listInvitable` (member search), parlor
   invites (DM with buttons), Observatory notifications (DM channel
   resolution), and the pseudo-interaction channel sends.
2. **`LocalGateway`** wrapping the live client; refactor those call sites
   onto the interface with zero behavior change (bot still one process —
   ship this as its own reviewable PR if it gets large).
3. **Bot's internal gateway API** (`/internal/gateway/*`): compose-internal
   network only, `GOOBSTER_INTERNAL_TOKEN` shared-secret header, JSON
   snapshots only, never live discord.js objects. Membership checks may
   cache ≤60s; permission checks gating writes are never cached.
4. **`RemoteGateway`** (HTTP client) + **`apps/api`**: host the existing
   `/api/app/*` routes, web sessions, SSE turns, and the Parlor Live WS in
   a new app entry point. Postgres required for the split (two processes,
   one database — the reason Phase 2 exists). The `lite` single-process
   mode keeps mounting the same routes in-process and must keep working.
5. **Events**: Postgres `LISTEN/NOTIFY` (`goobster_events` channel) from
   bot-side happenings (follow-up delivered, automation ran, agent run
   updated) fanned into a new `GET /api/app/events` SSE stream — this is
   what Phase 4's client uses instead of polling.
6. **Compose `full` profile** (spec §12.2 has the sketch): nginx serving
   `/api/*` → api and the bot-owned public surfaces (Activity, webhooks,
   pairing WS) → bot; only nginx published; shared `goobster-data` volume.
7. **Degraded mode**: with the bot down, everything DM-scoped keeps
   working; guild-scoped panes return a clear "Goobster is offline" state,
   never a crash.

Exit criteria (spec §13 Phase 3): web jest specs pass in the api app; a full
manual portal pass (chat with tools, parlor incl. Live, exchange trade,
tasks, forget-me) against the 4-service compose; bot-down degradation
behaves; both single-process and split modes green in CI.

Also due with Phase 3: the standards-doc amendments (spec §14) — the port is
now real enough that `development_standards_and_project_goals.md` should
reflect the monorepo, the async facade contract, the two-engine rule, and
the gateway boundary.

## Phase 4 — the reactive client (after 3)

Spec §8. React 19 + Vite + TypeScript SPA at `apps/web`, mounted at
`/app/next` behind a `webapp.nextClient` flag while the legacy client keeps
serving `/app`. Port rooms in value order: Study (chat) → Home → Library →
Tasks/Usage/Decks → Workshop → Exchange → Parlor (incl. Live audio) →
Observatory. The wire contracts are frozen (SSE turn events, parlor
multi-persona vocabulary, WS auth-before-upgrade) plus the new
`/api/app/events` stream from Phase 3. The dependency-free renderer modules
(`markdown.js`, `highlight.js`, `math.js`, `graph.js`, `codeblocks.js` with
its sandbox rules) port as-is behind thin wrappers — they are security
surface, not framework code. Flip `/app` and delete `web/app/` only when the
last room reaches its parity checklist.

## Phase 5 — hardening backlog (independent items, on demand)

- Advisory-lock guards on the singleton workers (belt-and-suspenders
  against double deployment).
- Persist the generated-file registry (small table; files already on the
  shared volume).
- Sticky sessions for WS when api replicas > 1; Redis for pub/sub +
  rate-limit counters only when that day comes.
- A locked-down `sandbox-runner` service (bubblewrap needs
  `security_opt: [seccomp:unconfined]` in containers today).
- Moving the Activity API behind the gateway (deliberately left in the bot).
