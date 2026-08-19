# Reactive Port — Status and Next Phases

Companion to `documentation/reactive_port_spec.md` (the authoritative plan).
This is the handoff note: what has shipped, what was learned doing it, and
exactly where the next session picks up.

**Last updated:** 2026-08-19 (Phase 4 `/app` flip)

## Where things stand

| Phase | Spec § | Status |
| --- | --- | --- |
| Spec | — | Merged (#139) |
| 0 — monorepo split | §5, §13 | **Done** (#141) |
| 1 — async DB facade | §7.2 | **Done** (#141) |
| 2 — Postgres adapter | §7.3 | **Done** (#142) |
| 3 — gateway seam + api service | §6, §13 | **Done** (#144) |
| 4 — reactive client | §8 | **Done** (#144 + #147 follow-ups + `/app` flip) |
| 5 — hardening | §11, §13 | **Pending, on demand** |
| **Flip `/app` → React** | §8.3 | **Done** — React is `/app` when `apps/web/dist` exists |

Production state: the maintainer's Pi ("bigpi") runs the bot on **Postgres 17
+ pgvector**, cluster on a USB drive at `/mnt/ssd` (guide:
`documentation/postgres_setup.md`). The SQLite file remains on disk as the
pre-Postgres snapshot. `GOOBSTER_DB_URL` is injected via a systemd drop-in
(`/etc/systemd/system/goobster.service.d/override.conf`), which survives
auto-updates and `GOOBSTER_SYNC_UNIT` re-renders. Phase 3's split compose
is additive: systemd lite/Postgres-one-process stays valid; `deploy/docker-compose.yml`
is the optional four-service path.

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

### 5a. Singleton worker advisory locks (Postgres)

**Why:** Heartbeat, monologue, consolidation, risk engine, automation poll,
agent tracker, Observatory auto-resume run only in `bot`. On Postgres, wrap
each tick in `pg_try_advisory_lock(key)` so accidental double-deployment
cannot double-run. Pattern already described in spec §10.

**Where to look:** `heartbeatService.js`, `monologueService.js`,
`memoryConsolidationService.js`, `exchange/riskEngine.js`,
`automationService.js`, `observatoryService.autoResumeInterrupted`.

**Exit:** Two-bot integration test or manual: second process skips tick when
lock held.

### 5b. Persist generated-file registry

**Why:** `webChatService` file attachments use an in-memory owner→path map.
Fine for one `api` replica; breaks with N>1.

**What:** Small table (file id, owner id, path, created_at). Files already on
shared volume. See spec §11 table.

**Exit:** File served correctly after api restart; `/forget-me` cleans rows.

### 5c. Multi-replica api (when N>1 is real)

Only when horizontal scaling is needed:

| In-memory today | Migration path |
| --- | --- |
| `_liveTurn` per-user lock | Postgres advisory lock on userId |
| Rate limits (chat, parlor, voice) | Counter table or Redis |
| Incognito windows | Sticky sessions or accept per-replica |
| Parlor Live WS | nginx sticky sessions (`ip_hash` or cookie) |
| Event bus | Redis pub/sub **only when** N>1 api (Postgres NOTIFY enough for bot↔api today) |

**Do not add Redis prematurely** — spec says pub/sub + rate limits only when
replicas > 1.

### 5d. Sandbox-runner service

**Why:** Strongest isolation (bubblewrap) in Docker needs
`security_opt: [seccomp:unconfined]`. Optional dedicated container for
`runCode` / Observatory segments.

**Where:** `services/sandboxService.js`, `deploy/docker-compose.yml`.

### 5e. Activity API behind gateway

**Why:** Activity WS still verifies guild membership through live bot client
in `apps/bot`. Deliberately deferred — revisit if Activity load competes with
voice (spec §16.4).

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

1. Advisory locks on singleton workers (5a).
2. Persist file registry (5b).
3. Manual pass of full compose profile on a Docker host (not Cloud Agent VM).
4. nginx WS/SSE through proxy — verify Parlor Live + chat SSE on `full` profile.

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
| Pi install / deploy | `scripts/install-rpi.sh` |
| Cloud agent caveats | `AGENTS.md` |
