# Reactive Port — Status and Next Phases

Companion to `documentation/reactive_port_spec.md` (the authoritative plan).
This is the handoff note: what has shipped, what was learned doing it, and
exactly where the next session picks up.

## Where things stand (2026-08-19)

| Phase | Spec § | Status |
| --- | --- | --- |
| Spec | — | Merged (#139) |
| 0 — monorepo split | §5, §13 | **Done** (#141): `packages/core` + `apps/bot`, ~880 specifiers rewritten, `runtimePaths`, core-never-imports-apps ESLint rule |
| 1 — async DB facade | §7.2 | **Done** (#141): async `get/all/run/insert/transaction`, ALS-routed transactions with savepoints, ~5,600 await sites |
| 2 — Postgres adapter | §7.3 | **Done** (#142): `GOOBSTER_DB_URL`-selected pg adapter, per-statement dialect translation, pgvector recall, `npm run migrate-to-postgres`, two-engine CI matrix |
| 3 — gateway seam + api service | §6, §13 | **Done**: `DiscordGateway` (`LocalGateway` / `RemoteGateway`), bot `/internal/gateway/*`, `apps/api`, `GET /api/app/events` + Postgres `LISTEN/NOTIFY`, compose `full` profile, standards-doc §14 amendments |
| 4 — reactive client | §8 | **Done** (this PR): React 19 + Vite + TS SPA at `apps/web`, served at `/app/next` behind `webapp.nextClient`. Legacy `/app` unchanged |
| 5 — hardening | §11, §13 | Pending, on demand |

Production state: the maintainer's Pi ("bigpi") runs the bot on **Postgres 17
+ pgvector**, cluster on a USB drive at `/mnt/ssd` (guide:
`documentation/postgres_setup.md`). The SQLite file remains on disk as the
pre-Postgres snapshot. `GOOBSTER_DB_URL` is injected via a systemd drop-in
(`/etc/systemd/system/goobster.service.d/override.conf`), which survives
auto-updates and `GOOBSTER_SYNC_UNIT` re-renders. Phase 3's split compose
is additive: systemd lite/Postgres-one-process stays valid; `deploy/docker-compose.yml`
is the optional four-service path.

Verification commands:

```bash
npm test                       # SQLite matrix
GOOBSTER_DB_URL=postgres://... GOOBSTER_PG_TEST_ISOLATE=1 npm test   # Postgres matrix
npm run lint && npm run smoke  # 0 errors / all modules load
npm run build:web              # tsc + Vite → apps/web/dist (opt-in /app/next)
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
- **Gateway permission checks use `member.permissions.has(name)`**, not
  `toArray().includes()` — test fakes (and some partial discord.js members)
  only implement `has()`. `sendDm` goes through `user.send(payload)`, not
  `createDM().send()` (parlor invite tests stub `user.send`).
- **No `setClient` / `getClient` in core.** Call sites take `{ gateway, client }`
  and `toGateway(gateway || client)` wraps a live client once (WeakMap).
- **Membership may cache ≤60s; write-gating permission checks never cache.**
  `RemoteGateway.botUser` falls back to `config.clientId` when the bot is
  down so DM-scoped chat still works.
- **Postgres is required for the split.** `apps/api/index.js` exits if
  `db.engine !== 'postgres'`. Lite stays one process + SQLite (or one
  process + Postgres).
- **Docker is not available in the Cloud Agent VM** (`docker: command not
  found`). Compose + Dockerfiles are config-only until a host with Docker
  builds them.

## Phase 3 — what shipped

Spec §4, §6, §12, §13, §14.

1. **`DiscordGateway` in `packages/core/gateway`**: `available`, `botUser`,
   `getGuildMember`, `memberHasPermission` (never cached), `listMutualGuilds`,
   `getGuildMembers`, `searchGuildMembers`, `getUser`, `sendDm`,
   `sendToChannel`, `resolveDmChannelId`, `guildMeta`. JSON snapshots only.
2. **`LocalGateway`** wrapping the live client; web-reachable services
   (`webGuildAccess`, dashboard/exchange/tasks, friends, parlor, observatory,
   sandbox requests, web chat, tools registry) go through the seam.
3. **Bot internal API** (`apps/bot/web/internalGatewayApi.js`):
   `/internal/gateway/*`, mounted only when `GOOBSTER_INTERNAL_TOKEN` is set,
   constant-time header compare, 503 when `!client.user`.
4. **`RemoteGateway`** + **`apps/api`**: hosts `/api/app/*`, sessions, SSE
   turns, Parlor Live WS, and `GET /api/app/events`. Health at `:3100/health`.
5. **Events**: in-process EventEmitter always; on Postgres, `pg_notify` +
   `LISTEN goobster_events` (skip own process id). Publishers: follow-up
   delivered, automation ran, agent run updated — ids/hints only.
6. **Compose `full` profile** at `deploy/docker-compose.yml` (postgres, bot,
   api, nginx). Root `docker-compose.yml` remains the lite default. Only
   nginx is published; `/internal/*` is never proxied.
7. **Degraded mode**: `GatewayUnavailableError` → 503 `BOT_OFFLINE` on guild
   panes; `listScopes` still returns the DM scope; `/me` uses the fallback
   bot id.
8. **Standards-doc amendments** (spec §14) landed in
   `documentation/development_standards_and_project_goals.md`.

## Phase 4 — what shipped

Spec §8. React 19 + Vite + TypeScript SPA at `apps/web`, base `/app/next/`.

1. **Stack**: TanStack Query (server state) + TanStack Router (path routes
   plus hash redirects from `#study/123`). EventSource on
   `GET /api/app/events` invalidates `home` / `tasks` query keys. Chat and
   parlor turns stay **POST + fetch body reader** (EventSource cannot POST);
   the frame parser is `apps/web/src/lib/parseSse.js` (ESM; Jest loads it
   with dynamic `import()`).
2. **Renderers ported as-is** behind thin wrappers (`Markdown`,
   `GraphCanvas`). `codeblocks.js` still sandboxes without `allow-same-origin`.
   `GraphView.stop()` (there is no `destroy()`). KaTeX still comes from
   `/app/vendor/katex`.
3. **Rooms**: Study, Home, Library, Tasks, Usage, Decks, Workshop, Exchange,
   Parlor (join/leave/status Live WS; AudioWorklet module is copied to
   `public/`), Observatory. The wire contract is the same `/api/app/*` as
   `packages/core/web/app/api.js`.
4. **Serving**: `webapp.nextClient` + `apps/web/dist` → Express serves
   `/app/next` with an SPA fallback. Missing dist → 404 `NEXT_CLIENT_UNBUILT`.
   **`/app` is still the legacy client.** `npm run build:web` / `dev:web`.
   Lite and api Dockerfiles multi-stage the Vite build; nginx still proxies
   `/app` (including `/app/next`) to api so the flag stays the switch.
5. **Tests**: `tests/webNextClient.test.js` (parser + flag on/off + unbuilt).

Flip `/app` and delete `packages/core/web/app/` only when the last room
reaches its parity checklist. That flip is **not** this phase.

## Phase 4 leftovers (parity, not blockers)

- Parlor Live in the React client is join/leave/status; the AudioWorklet
  playback path still lives in the legacy `parlorLive.js`.
- Share viewers (`/app/share/:token`, Observatory snapshot pages) stay on
  the legacy static files — they are not the SPA.
- Do not claim Vite/React is the default `/app` client.

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
