# Reactive Port — Status and Next Phases

Companion to `documentation/reactive_port_spec.md` (the authoritative plan).
This is the handoff note: what has shipped, what was learned doing it, and
exactly where the next session picks up.

**Last updated:** 2026-08-19 (Phase 5a–5e + Phase 4 `/app` flip)

## Where things stand

| Phase | Spec § | Status |
| --- | --- | --- |
| Spec | — | Merged (#139) |
| 0 — monorepo split | §5, §13 | **Done** (#141) |
| 1 — async DB facade | §7.2 | **Done** (#141) |
| 2 — Postgres adapter | §7.3 | **Done** (#142) |
| 3 — gateway seam + api service | §6, §13 | **Done** (#144) |
| 4 — reactive client | §8 | **Done** (#144 + #147 follow-ups + `/app` flip) |
| 5 — hardening | §11, §13 | **5a–5e done** (Redis still not added) |
| **Flip `/app` → React** | §8.3 | **Done** — React is `/app` when `apps/web/dist` exists |

Production state: the maintainer's Pi ("bigpi") runs the bot on **Postgres 17
+ pgvector**, cluster on a USB drive at `/mnt/ssd` (guide:
`documentation/postgres_setup.md`). The SQLite file remains on disk as the
pre-Postgres snapshot. `GOOBSTER_DB_URL` is injected via a systemd drop-in
(`/etc/systemd/system/goobster.service.d/override.conf`), which survives
auto-updates and `GOOBSTER_SYNC_UNIT` re-renders. Phase 3's split compose
is additive: systemd lite/Postgres-one-process stays valid; `deploy/docker-compose.yml`
is the optional five-service path (postgres + bot + api + sandbox + nginx).

### How `/app` is served today

React is the portal at `/app` when `apps/web/dist` exists. `webapp.nextClient`
defaults on — do **not** set `"nextClient": true` (that 404s if the Vite
build is missing). Set `"nextClient": false` only to roll back to leftover
HTML. `/app/next` 302s to `/app`.

```bash
npm ci && npm run build:web && npm prune --omit=dev
sudo systemctl restart goobster
```

Verification commands:

```bash
npm test                       # SQLite matrix
GOOBSTER_DB_URL=postgres://... GOOBSTER_PG_TEST_ISOLATE=1 npm test   # Postgres matrix
npm run lint && npm run smoke  # 0 errors / all modules load
npm run typecheck:web && npm run build:web
```

---

## What just landed (PR #147, merged)

Follow-up fixes on top of Phase 4 (#144). All CI green (sqlite + postgres).

| Area | Root cause | Fix |
| --- | --- | --- |
| Library map blank on `/app/next` | React used `class="graph-canvas"` but CSS only sized `#graph-canvas`; map tab missing `mtab-graph` flex layout | Style `.graph-canvas`, add `mtab-graph` on Library map tab, label guard in `graph.js` |
| Observatory project cards janky | `<button class="list-row">` → browser white button chrome | `<div role="button">` like legacy; global `button.list-row` reset |
| Parlor persona colors off theme | `<button class="persona-item">` etc. — CSS written for `<div>`/`<span>` | Match legacy markup (`div`/`span` + `role="button"`) + `button.persona-*` CSS resets |
| Postgres CI flakes | `setImmediate` / 25ms settle too short for async pg I/O | Poll in `webChatService` auto-title test; longer settle + poll in `botPlayer` |

**Recurring React port pattern:** legacy classes were authored for `<div>`/`<span>`.
When porting clickable rows, either use the same element types or add explicit
`button.*` CSS resets. Already fixed for: `list-row`, `persona-item`,
`participant-chip`, `persona-pick`.

Earlier on this branch (also merged): stable `/app/next/style.css` URL, pane
chrome in `styles.css`, service workers skip caching SPA HTML, Pi `build:web`
fix (#146 — `install-rpi.sh` runs full `npm ci`, builds web, then prunes dev).

---

## Phase 4 — shipped inventory

Spec §8. React 19 + Vite + TypeScript SPA at `apps/web`, base `/app/`.

| Room | React file | Notes |
| --- | --- | --- |
| Study (chat) | `StudyRoom.tsx` | SSE turn stream, sidebar, tools, vision |
| Home | `HomeRoom.tsx` | EventSource invalidation |
| Library | `LibraryRoom.tsx` | Map graph fixed (#147) |
| Tasks | `TasksRoom.tsx` | Automations + follow-ups |
| Usage | `UsageRoom.tsx` | Token chart |
| Decks | `DecksRoom.tsx` | MTGA import |
| Workshop | `WorkshopRoom.tsx` | Pinned applets |
| Exchange | `ExchangeRoom.tsx` | Full terminal |
| Parlor | `ParlorRoom.tsx` | Live audio ported (`useParlorLive` + worklet) |
| Observatory | `ObservatoryRoom.tsx` | Cards fixed (#147) |

**Stack:** TanStack Query + TanStack Router. `GET /api/app/events` → query
invalidation. Chat/parlor turns: POST + fetch body reader (`parseSse.cjs`).
Renderers reused from legacy (`markdown.js`, `graph.js`, `codeblocks.js`, …).

**Tests:** `tests/webNextClient.test.js` (SSE parser, `/app` serving, PWA
shell) and `tests/parlorLiveAudio.test.js` (VAD + PCM helpers).

---

## `/app` flip — **done**

React is the portal at `/app` when `apps/web/dist` exists. `webapp.nextClient`
defaults on; set it to `false` to serve the leftover ES-module client.
`/app/next/*` 302s onto `/app/*`.

**Parlor Live audio** lives in `apps/web/src/lib/parlorLiveSession.ts` +
`useParlorLive` + `public/liveAudioWorklet.js` (same VAD, worklet uplink,
MSE/blob TTS queue, barge-in `stop-speech` as legacy).

**Share viewers** stay on leftover HTML (`/app/share/:token`, Observatory
snapshots). `packages/core/web/app/` is not deleted — rollback + share
pages still need it.

**PWA:** `apps/web/public/manifest.webmanifest` + `sw.js` scoped to `/app/`.
Network-first static, never `/api/*`, never share URLs. Cache name
`goobster-app-v1`.

**Production deploy on bigpi** after merge:
```bash
git pull && npm ci && npm run build:web && npm prune --omit=dev
sudo systemctl restart goobster
```
Host: `activity.nervouslabs.com`. Do **not** set `nextClient: false`.

---

## Phase 5 — hardening backlog (independent items, on demand)

Spec §11, §13. **Each item stands alone** — pick based on deployment pain,
not a mandatory sequence.

### 5a. Singleton worker advisory locks (Postgres) — **done**

`db.withSingletonLock(name, fn)` on the facade. Postgres adapter checks
out a dedicated pool connection and `pg_try_advisory_lock(int, int)`
(keys hashed from test-isolation schema + name so parallel Jest workers
do not collide; production shares keys). SQLite always acquires.

Wrapped ticks: heartbeat, heartbeat follow-ups, monologue, memory
consolidation, risk engine, automation poll, agent tracker, Observatory
auto-resume. A skipped tick logs a warning and returns `{ skipped: true }`.

**Exit:** `tests/singletonLock.test.js` — nested same-name lock is skipped
on Postgres; heartbeat.tick reports skipped while the lock is held.

### 5b. Persist generated-file registry — **done**

Table `web_generated_files` (id, userId, path, name, createdAt; unique
owner+path). `webChatService.registerFile` / `getFile` are async and
read/write the table (6-hour TTL prune). `/forget-me` deletes the user's
rows (`counts.webGeneratedFiles`); `auditUser` counts leftovers.

**Exit:** History/register tests assert the row survives a memory wipe;
privacy suite asserts forget-me cleans USER and leaves OTHER.

### 5c. Multi-replica api — **done** (no Redis)

Shared sliding-window budget in `web_rate_events` via
`utils/slidingWindowLimit.consumeWindow` (web chat, parlor turns, parlor
Live joins, web voice STT/TTS). `/forget-me` deletes the user's rows.

In-flight Study turns are a `web_live_turns` row (`userId` PK). The replica
that claimed the turn keeps the `AbortController` in `_activeTurns`; other
replicas 409 / `turnStatus` / `stopTurn` from the row. `release()` awaits
`DELETE` by `turnId` so a late watchdog eviction cannot free a successor.
A 1s poller copies remote `aborted=1` onto the local controller.

nginx `ip_hash` on `goobster_api` sticks a browser to one replica so Parlor
Live WS and incognito windows (still in-memory on purpose) stay coherent.
One replica keeps `ip_hash` a no-op.

Event bus stays Postgres `NOTIFY`. Redis was not added (spec §11).

**Exit:** `tests/slidingWindowLimit.test.js`; web-chat remote-row 409 +
stop; privacy forget-me covers both new tables.

### 5d. Sandbox-runner service — **done**

`apps/sandbox` is an Express runner (`GET /health`, `POST /run` with
`GOOBSTER_INTERNAL_TOKEN`). Compose `full` runs it as `sandbox` with
`security_opt: [seccomp:unconfined]` (bubblewrap). bot and api set
`GOOBSTER_SANDBOX_URL=http://sandbox:3200` and **drop** unconfined
seccomp; `sandboxService.run()` HTTP-proxies. The runner must not set
that URL (it would loop). Lite / systemd leave the URL unset and execute
in-process.

**Exit:** `tests/sandboxRunner.test.js` (HTTP app + remote proxy).

### 5e. Activity membership via gateway — **done**

`assertActivityGuildAccess` uses `DiscordGateway.getGuildMember` — never
discord.js cache/fetch — so the same check works from `LocalGateway` or
`RemoteGateway`. Activity HTTP/WS **stays on bot** (tableManager +
BotPlayer/voice). nginx `/api/activity` still routes to bot.

**Exit:** `tests/activityGatewayAccess.test.js`.

---

## Operational learnings (do not re-learn)

- **Deploys:** `/etc/goobster-update.conf` needs `GOOBSTER_SYNC_UNIT=true`
  when `deploy/goobster.service` changes. Rollback failure →
  `sudo chown -R <user>:<user> ~/goobster && npm ci --omit=dev`.
- **Postgres tests:** `GOOBSTER_PG_TEST_ISOLATE=1` per suite; pools close in
  `tests/setup/perSuite.js`. **Never** fake timers around real pg I/O.
- **Postgres-only test failures:** suspect (1) fire-and-forget `db.run()` race,
  (2) insufficient async waits — use poll/`waitUntil`, not single `setImmediate`.
- **Dialect:** only in `packages/core/db/dialect.js`. Services write SQLite SQL.
- **Gateway:** `member.permissions.has(name)`, not `toArray()`. `sendDm` →
  `user.send()`. No `setClient`/`getClient` — use `toGateway(gateway || client)`.
- **React + legacy CSS:** design-system classes assume div/span; reset `button.*`
  or match legacy element types.
- **Cloud Agent VM:** no Docker, no real Discord OAuth (use `webapp.devMode`),
  Ollama segfaults (use cloud AI keys). See root `AGENTS.md`.
- **Config:** `config.json` gitignored; Discord creds from secrets only.

---

## Suggested next-agent priorities

**If the goal is "production hardening / split deploy":**

1. ~~Advisory locks on singleton workers (5a).~~ Done.
2. ~~Persist file registry (5b).~~ Done.
3. ~~Shared rate-limit + live-turn rows + nginx `ip_hash` (5c).~~ Done.
4. ~~Sandbox-runner service (5d).~~ Done.
5. ~~Activity membership via gateway (5e).~~ Done.
6. Manual pass of full compose profile on a Docker host (not Cloud Agent VM).
7. nginx WS/SSE through proxy — verify Parlor Live + chat SSE on `full` profile.

**If the goal is "keep shipping portal features":**

- Fix parity bugs as users report them (pattern: element type + CSS).
- Port share viewers (`/app/share/:token`) to React when wanted.
- Delete `packages/core/web/app/` only after rollback is unused.

---

## Key paths (quick reference)

| What | Where |
| --- | --- |
| Authoritative spec | `documentation/reactive_port_spec.md` |
| Standards / web-app contracts | `documentation/development_standards_and_project_goals.md` |
| React portal (`/app`) | `apps/web/` (served from `apps/web/dist`) |
| Leftover client (rollback + share) | `packages/core/web/app/` |
| Portal API | `packages/core/web/appApi.js` |
| Gateway | `packages/core/gateway/` |
| Bot internal API | `apps/bot/web/internalGatewayApi.js` |
| Split api service | `apps/api/` |
| Compose full profile | `deploy/docker-compose.yml` |
| Sliding-window rate limit | `packages/core/utils/slidingWindowLimit.js` |
| Sandbox-runner | `apps/sandbox/` |
| Activity membership gate | `apps/bot/web/activityApi.js` (`assertActivityGuildAccess`) |
| Pi install / deploy | `scripts/install-rpi.sh` |
| Cloud agent caveats | `AGENTS.md` |
