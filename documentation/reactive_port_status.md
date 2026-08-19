# Reactive Port — Status and Next Phases

Companion to `documentation/reactive_port_spec.md` (the authoritative plan).
This is the handoff note: what has shipped, what was learned doing it, and
exactly where the next session picks up.

**Last updated:** 2026-08-19 (post-PR #147 merge)

## Where things stand

| Phase | Spec § | Status |
| --- | --- | --- |
| Spec | — | Merged (#139) |
| 0 — monorepo split | §5, §13 | **Done** (#141) |
| 1 — async DB facade | §7.2 | **Done** (#141) |
| 2 — Postgres adapter | §7.3 | **Done** (#142) |
| 3 — gateway seam + api service | §6, §13 | **Done** (#144) |
| 4 — reactive client | §8 | **Done** (#144 + #147 follow-ups) |
| 5 — hardening | §11, §13 | **Pending, on demand** |
| **Flip `/app` → React** | §8.3 | **Blocked on parity** (see below) |

Production state: the maintainer's Pi ("bigpi") runs the bot on **Postgres 17
+ pgvector**, cluster on a USB drive at `/mnt/ssd` (guide:
`documentation/postgres_setup.md`). The SQLite file remains on disk as the
pre-Postgres snapshot. `GOOBSTER_DB_URL` is injected via a systemd drop-in
(`/etc/systemd/system/goobster.service.d/override.conf`), which survives
auto-updates and `GOOBSTER_SYNC_UNIT` re-renders. Phase 3's split compose
is additive: systemd lite/Postgres-one-process stays valid; `deploy/docker-compose.yml`
is the optional four-service path.

### How to enable the React client today

In `config.json`:

```json
"webapp": { "enabled": true, "nextClient": true }
```

Then build and restart:

```bash
npm ci && npm run build:web && npm prune --omit=dev
sudo systemctl restart goobster
```

Served at **`/app/next`**. Legacy **`/app`** is unchanged until the flip.

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

Spec §8. React 19 + Vite + TypeScript SPA at `apps/web`, base `/app/next/`.

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
| Parlor | `ParlorRoom.tsx` | Persona styling fixed (#147); Live partial |
| Observatory | `ObservatoryRoom.tsx` | Cards fixed (#147) |

**Stack:** TanStack Query + TanStack Router. `GET /api/app/events` → query
invalidation. Chat/parlor turns: POST + fetch body reader (`parseSse.cjs`).
Renderers reused from legacy (`markdown.js`, `graph.js`, `codeblocks.js`, …).

**Tests:** `tests/webNextClient.test.js` (11 tests — parser, CSS guards, serving).

---

## Before flipping `/app` (NOT Phase 5 — still Phase 4 exit criteria)

Spec §8.3: flip only when **every room hits parity** with legacy. Do **not**
delete `packages/core/web/app/` until then.

### Known parity gaps (prioritized)

1. **Parlor Live audio (highest gap)** — React has join/leave/status WS only.
   Full mic capture, AudioWorklet uplink, and persona TTS playback still live in
   legacy `packages/core/web/app/parlorLive.js` + `liveAudioWorklet.js`.
   `ParlorRoom.tsx` wires WS but does not port the audio pipeline.
   **Next agent task:** port `parlorLive.js` into `apps/web` (likely a hook +
   worklet module under `public/`), verify barge-in and multi-human sessions.

2. **Share viewers** — `/app/share/:token` and Observatory snapshot pages stay
   on legacy static HTML. Acceptable to leave on legacy indefinitely, or port
   as thin read-only routes later.

3. **Room-by-room audit** — No formal checklist file exists; derive from
   `documentation/development_standards_and_project_goals.md` web-app section
   and manual side-by-side at `/app` vs `/app/next`. Suspect areas:
   - Study: edit/resend, branch, share, stop, incognito, file attachments
   - Parlor: workspace graph, persona CRUD modals, shared discussions, invites
   - Library: guild graph (Manage Server), inner-life cards
   - PWA: install, offline shell, service worker behavior on `/app/next`

4. **Lighthouse mobile** on Study + Home (spec Phase 4 exit).

5. **Production deploy on bigpi** after merge:
   ```bash
   git pull && npm ci && npm run build:web && npm prune --omit=dev
   sudo systemctl restart goobster
   ```
   Host: `activity.nervouslabs.com` — set `nextClient: true` when ready.

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

**If the goal is "React becomes default `/app`":**

1. Port Parlor Live audio (`parlorLive.js` → React hook + worklet).
2. Run room parity audit (legacy vs `/app/next`); file gaps as issues.
3. Lighthouse + PWA pass on Study/Home.
4. Flip: serve React at `/app`, redirect or remove legacy (one commit, big delete of `packages/core/web/app/`).

**If the goal is "production hardening / split deploy":**

1. Advisory locks on singleton workers (5a).
2. Persist file registry (5b).
3. Manual pass of full compose profile on a Docker host (not Cloud Agent VM).
4. nginx WS/SSE through proxy — verify Parlor Live + chat SSE on `full` profile.

**If the goal is "keep shipping features on `/app/next`":**

- Fix parity bugs as users report them (pattern: element type + CSS).
- Do not flip `/app` until Parlor Live and audit complete.

---

## Key paths (quick reference)

| What | Where |
| --- | --- |
| Authoritative spec | `documentation/reactive_port_spec.md` |
| Standards / web-app contracts | `documentation/development_standards_and_project_goals.md` |
| React client | `apps/web/src/` |
| Legacy client (until flip) | `packages/core/web/app/` |
| Portal API | `packages/core/web/appApi.js` |
| Gateway | `packages/core/gateway/` |
| Bot internal API | `apps/bot/web/internalGatewayApi.js` |
| Split api service | `apps/api/` |
| Compose full profile | `deploy/docker-compose.yml` |
| Pi install / deploy | `scripts/install-rpi.sh` |
| Cloud agent caveats | `AGENTS.md` |
