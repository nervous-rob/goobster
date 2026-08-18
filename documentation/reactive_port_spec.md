# Porting Goobster to a Reactive, Multi-Service Architecture — Specification

Status: **proposal** (nothing in this document is adopted until it lands in
`development_standards_and_project_goals.md`; see [§14](#14-amendments-the-standards-document-needs-on-adoption)).

This spec describes how Goobster evolves from one Node process serving
everything into a small constellation of services — a reactive web front end,
an API backend, the Discord bot, and a real database server — without losing
what makes the codebase good: the service layer, the shared chat pipeline, the
trust boundaries, and the privacy machinery. The Discord bot remains a pillar,
all data stays shared in both directions (Discord ⇄ web), and self-hosting
stays first-class.

## Table of contents

1. [Recommendations at a glance](#1-recommendations-at-a-glance)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Where we are today](#3-where-we-are-today)
4. [Target topology](#4-target-topology)
5. [The monorepo](#5-the-monorepo)
6. [The seam: the Discord gateway interface](#6-the-seam-the-discord-gateway-interface)
7. [Database: the Postgres upgrade](#7-database-the-postgres-upgrade)
8. [The reactive front end](#8-the-reactive-front-end)
9. [Real-time contract](#9-real-time-contract)
10. [Singleton workers](#10-singleton-workers)
11. [Parallelism: what the split buys, and what still pins us](#11-parallelism-what-the-split-buys-and-what-still-pins-us)
12. [Orchestration: Docker Compose and Dockerfiles](#12-orchestration-docker-compose-and-dockerfiles)
13. [Migration roadmap](#13-migration-roadmap)
14. [Amendments the standards document needs on adoption](#14-amendments-the-standards-document-needs-on-adoption)
15. [Risks and mitigations](#15-risks-and-mitigations)
16. [Open questions](#16-open-questions)

---

## 1. Recommendations at a glance

| Decision | Recommendation | Why (short) |
| --- | --- | --- |
| Front-end framework | **React 19 + Vite + TypeScript**, SPA (no SSR), TanStack Query + TanStack Router | Largest ecosystem and longest support horizon; the portal is an authenticated app, so SSR/SEO buys nothing; TanStack Query matches our REST+SSE shape exactly |
| Backend framework | **Keep Express** in the new `api` service | The routes are already thin and clean; churning the HTTP framework is risk without reward. Fastify can be a later, isolated swap |
| Database | **Postgres 17 + pgvector** for split deployments; **SQLite stays supported** for the single-process "lite" install | Postgres enables multi-process access, real concurrency, and horizontal API scaling; SQLite remains the Pi-friendly zero-dependency default |
| DB access layer | Keep the `db/` facade, make it **async**, add a Postgres adapter beside the SQLite one | 893 call sites already funnel through 4 functions — the facade is the whole reason this migration is tractable |
| Inter-service communication | **Internal HTTP** (bot exposes a private gateway API) + **Postgres `LISTEN/NOTIFY`** for events | No new infrastructure; Redis only if/when we scale the API horizontally |
| Repo layout | **npm workspaces monorepo**: `packages/core`, `apps/bot`, `apps/api`, `apps/web` | One repo, one CI, atomic cross-service changes; core services stay a single source of truth |
| Orchestration | **Docker Compose** with two profiles: `lite` (today's single container + SQLite) and `full` (web + api + bot + postgres) | Self-hosted first: a Pi user keeps the one-container experience; a bigger host gets the full split |
| Migration strategy | **Strangler fig, five phases**, each independently shippable with CI green | The bot must never break; the legacy web client keeps working until the last room is ported |

## 2. Goals and non-goals

### Goals

- **The Discord bot remains a pillar.** Nothing about slash commands, chat,
  voice, the Activity, the tavern, or the economy regresses. The bot service
  is a peer of the web stack, not a legacy appendage.
- **One dataset, both directions.** Memory, facts, conversations, wallets,
  parlors, tasks — everything a user creates from Discord is visible on the
  web and vice versa, exactly as today. The database split makes this
  *stronger* (true concurrent access), not weaker.
- **A snappier web app.** Client-side routing with no full-page reloads,
  optimistic updates, cached queries, code-split rooms, and a backend that is
  no longer sharing an event loop with Opus encoding and Discord gateway
  traffic.
- **Real parallelism.** Web requests, chat turns, parlor generation, and
  Discord event handling stop competing for one process's event loop and one
  synchronous SQLite handle.
- **Best-practice orchestration.** Compose files and Dockerfiles that give
  each service its own lifecycle, healthcheck, and resource budget.
- **Self-hosted first survives.** A Raspberry Pi user can still run one
  container with zero external dependencies.

### Non-goals

- **Not a rewrite of the service layer.** `services/` is the good code this
  port exists to showcase. It moves into `packages/core` nearly verbatim.
- **No parallel chat pipeline.** The "never fork the pipeline for the web —
  extend the capability set" rule survives the split intact. Both the bot and
  the API call the same `chatHandler`.
- **No Kubernetes.** Compose is the ceiling for a self-hosted product. The
  split makes k8s *possible* later, but nothing here requires it.
- **No cloud dependencies.** Postgres runs as a local container. Every AI
  provider stays optional with graceful degradation.
- **Voice does not move.** Discord voice (UDP, Opus, `@discordjs/voice`) is
  inseparable from the gateway connection and stays in the bot service
  permanently.

## 3. Where we are today

A single Node process (`index.js`, ~700 lines of startup wiring) owns:

- The **discord.js client**: events, 60+ commands, the voice stack.
- The **public Express server** (port 3000): `/health`, the web portal
  (`web/appApi.js`, ~1,700 lines of routes), the Activity API + WS, screen
  vision WS, GBA-run WS, integration webhooks, Parlor Live WS.
- The **local panel server** (port 3400, loopback-only).
- **Six background singletons** started from `index.js`: automation service,
  heartbeat, monologue, memory consolidation, exchange risk engine, Cursor
  agent tracker (plus Observatory job auto-resume).
- **SQLite via better-sqlite3**: 83 tables, WAL mode, sqlite-vec for memory
  recall. All access goes through the `db/` facade (`get`/`all`/`run`/
  `transaction`) — **~893 call sites, all synchronous**, ~322 statements using
  SQLite-flavored constructs (`datetime('now')`, `ON CONFLICT`, `RETURNING`,
  `CURRENT_TIMESTAMP`).
- The **web client**: ~9,400 lines of dependency-free ES modules across 25
  files plus ~1,400 lines of CSS. Hash routing, hand-rolled fetch wrappers,
  full re-renders on state change. It is impressive for what it is, but every
  feature added (rooms, atmosphere, workshop, live voice) raises the cost of
  the next one — exactly the problem reactive frameworks exist to solve.

Two structural facts make this port tractable, and the spec leans on both:

1. **The `db/` facade is the only door to the database.** Nothing imports
   better-sqlite3 directly except `db/index.js`. Swapping the engine is a
   facade change plus a dialect pass, not a hunt through 61 services.
2. **The web API is already a clean boundary.** The client speaks REST + SSE +
   WS to `/api/app/*` and never reaches into bot internals. A new front end
   can be built against the existing API with zero backend changes, and the
   backend can be extracted behind the same API with zero client changes.

The coupling that actually blocks the split is narrower than it looks:
**15 files** in `services/`+`utils/` touch the Discord client directly, and on
the web-facing path they use it for a handful of things (membership checks, DM
delivery, member search, guild lists). That is the seam §6 formalizes.

## 4. Target topology

```mermaid
graph LR
    subgraph edge [Public edge]
        WEB["web<br/>(nginx: static React build,<br/>reverse proxy to api)"]
    end
    subgraph internal [Internal network]
        API["api<br/>(Express: REST + SSE + WS,<br/>chat turns, parlor, exchange UI,<br/>tasks, decks, usage)"]
        BOT["bot<br/>(discord.js gateway, voice,<br/>commands, Activity, panel,<br/>webhooks, singleton workers)"]
        PG[("postgres<br/>(+ pgvector)")]
    end
    Browser --> WEB
    WEB -->|"/api/*"| API
    API -->|"internal gateway HTTP"| BOT
    API --> PG
    BOT --> PG
    BOT -->|"LISTEN/NOTIFY"| PG
    Discord((Discord)) <--> BOT
```

Service responsibilities:

| Service | Owns | Explicitly does not own |
| --- | --- | --- |
| `bot` | Discord client, commands, events, voice stack, Activity API+WS¹, local panel, webhook receivers, screen-vision/GBA WS, all singleton workers (§10) | Web portal routes, web sessions |
| `api` | Web auth + sessions, all `/api/app/*` routes, SSE chat turns, Parlor (incl. Live WS), web voice (STT/TTS proxy), exchange terminal, tasks, decks, usage, share links, Observatory portal routes | Anything needing a live gateway connection |
| `web` | Static React build, TLS termination / tunnel target, reverse proxy `/api/*` → `api` | Application logic |
| `postgres` | The one shared dataset, pgvector index, `LISTEN/NOTIFY` event bus | — |

¹ The Activity stays in `bot` initially: its WS join verifies live guild
membership and its tables/bot-player integrate with voice table talk. Moving
it to `api` later is possible through the same gateway seam but is not part of
this port.

**Why the chat pipeline runs in `api` (not proxied to `bot`).** The pipeline
(`chatHandler` + `agentOrchestrator` + providers) needs the database, AI keys,
and tools — not a gateway socket. Running web turns inside `api` is what
delivers the parallelism goal: a long agent loop with six tool rounds no
longer steals cycles from voice encoding or Discord event handling, and later
lets `api` scale to N replicas while `bot` stays a singleton. The minority of
tools and checks that *do* need Discord go through the gateway interface (§6).

## 5. The monorepo

npm workspaces, one lockfile, one CI:

```
goobster/
├─ package.json                # workspaces root; shared scripts
├─ packages/
│  └─ core/                    # @goobster/core
│     ├─ db/                   # facade + sqlite adapter + postgres adapter + schema
│     ├─ services/             # everything in services/ today, verbatim
│     ├─ utils/                # chat pipeline, tools registry, helpers
│     └─ config/               # aiConfig, sandboxConfig, ... (env-first, unchanged)
├─ apps/
│  ├─ bot/                     # index.js, commands/, events/, deploy-commands.js,
│  │                           # web/server.js remnants (panel, activity, webhooks)
│  ├─ api/                     # Express app: appApi routes, sessions, SSE/WS
│  └─ web/                     # Vite + React client (replaces web/app/)
├─ deploy/
│  ├─ docker-compose.yml       # profiles: lite | full
│  ├─ bot.Dockerfile  api.Dockerfile  web.Dockerfile  lite.Dockerfile
│  └─ nginx.conf
└─ documentation/  tests/  campaigns/  ...
```

Rules that carry over unchanged into `packages/core`:

- Commands in `commands/<category>/`, business logic in `services/`, shared
  helpers in `utils/` — the layout inside `core` mirrors today's repo so
  `git log --follow` and muscle memory both survive.
- The model-proposes/code-legalizes trust boundary, the `PanelError`-style
  error contracts, `usageContext` attribution, and every privacy path
  (`forgetUser`, `auditUser`, `buildUserReport`) stay in core and are invoked
  identically from both apps.
- Jest specs move with their subjects; `npm test` at the root runs every
  workspace. The smoke test gains a per-app variant (each app's modules must
  `require()`/`import` cleanly with a minimal config).

`apps/bot` and `apps/api` both depend on `@goobster/core`. Nothing in `core`
may import from an app (enforced with an ESLint `no-restricted-imports` rule),
and nothing in `core` may `require('discord.js')` for *web-reachable* code
paths except through the gateway interface — that is the next section.

## 6. The seam: the Discord gateway interface

The crux of the split. Today, web-facing services call the live client
directly (`client.guilds.fetch(...)`, `member.permissions.has(...)`,
`user.send(...)`). In the target, core code depends on a small interface, and
each app supplies its implementation:

```js
// packages/core/gateway/DiscordGateway.js (interface shape)
// Implementations: LocalGateway (apps/bot, wraps the live client)
//                  RemoteGateway (apps/api, HTTP client → bot's internal API)
{
  botUserId(): Promise<string>,
  getGuildMember(guildId, userId): Promise<{ id, displayName, permissions } | null>,
  memberHasPermission(guildId, userId, permission): Promise<boolean>,
  listMutualGuilds(userId): Promise<Array<{ id, name, icon }>>,
  searchGuildMembers(guildId, query, limit): Promise<Array<{ id, displayName }>>,
  sendDm(userId, payload): Promise<{ ok, messageId? }>,
  sendToChannel(channelId, payload): Promise<{ ok, messageId? }>,
  resolveDmChannelId(userId): Promise<string | null>,
  guildMeta(guildId): Promise<{ id, name, memberCount } | null>
}
```

This list is derived from the actual call sites on the web path:
`webGuildAccess.requireGuildMember` (exchange terminal, memory dashboard,
knowledge graph), `webDashboardService` (scope listing = mutual guilds),
`webTaskService`/`automationService.executeDmAutomation` (DM delivery),
`friendService.listInvitable` (member search), parlor invites (DM with
buttons), Observatory notifications (follow-up rows resolved to a DM channel),
and the tool layer's confirmation-gated actions (channel sends).

**The bot exposes these as an internal HTTP API** (`/internal/gateway/*`),
bound to the Compose-internal network only, authenticated with a shared secret
header (`GOOBSTER_INTERNAL_TOKEN`, injected into both containers; requests
without it are 401 — defense in depth on top of network isolation). Responses
are plain JSON snapshots, never live discord.js objects.

Design rules for the seam:

- **Membership checks stay live, with a short TTL cache.** The security
  property "guild-scope routes verify real membership through the bot" is
  load-bearing (standards doc, web app section). `RemoteGateway` may cache
  positive membership for ≤60s to keep the dashboard snappy; permission
  checks that gate *writes* (Manage Server for the knowledge graph, retention)
  are never served from cache.
- **Graceful degradation, as everywhere.** If the bot is down, `api` keeps
  serving everything DM-scoped (chat, parlor, library, tasks CRUD, decks,
  usage) — only guild-scoped panes degrade to a "Goobster is offline" state.
  The web app must never hard-crash because the gateway is restarting.
- **DM delivery is fire-and-report**, matching today's `dmSent: false`
  convention — a failed DM is reported, never an error.
- **Pseudo-interactions stay in core.** `createPseudoInteraction`,
  `sendFullResponse`, `onStreamDelta`, `shouldAbort` — the web capability set
  is already client-free; the only change is that the pseudo-channel's
  outbound sends resolve through the gateway instead of a captured client.

**Events flow the other way through Postgres `LISTEN/NOTIFY`.** The bot
notifies (`NOTIFY goobster_events, '{"kind":"followup-delivered", ...}'`) when
something web-visible happens Discord-side (a follow-up delivered, an
automation run finished, an agent run status change), and `api` fans matching
events into any open SSE/WS subscriptions. This replaces nothing today (the
current client polls) — it is the mechanism that lets the reactive client
*stop* polling. No Redis, no message broker, until horizontal scaling
demands one (§11).

## 7. Database: the Postgres upgrade

### 7.1 Why Postgres, honestly

better-sqlite3 is a superb fit for one process. It is a poor fit for two:
WAL-mode multi-process access works on a shared local volume, but it revives
`SQLITE_BUSY` coordination, breaks down over any network filesystem, gives no
`LISTEN/NOTIFY`, and permanently caps us at "every service on one host."
Postgres gives true concurrent access, an event bus for free, `pgvector` to
replace sqlite-vec, online backups, and a path to N API replicas.

The honest cost: better-sqlite3's *synchronousness* is load-bearing. All ~893
call sites call `db.get(...)` without `await`, and `db.transaction(fn)` takes
a **synchronous** callback (better-sqlite3 forbids awaiting inside). Postgres
drivers are async. This is the single most invasive change in the entire port
— more than the service split, more than the front end — which is why it gets
its own phase with its own exit criteria.

### 7.2 The async facade

The facade keeps its exact shape and goes async:

```js
await db.get(sql, params)        // first row or undefined
await db.all(sql, params)        // array of rows
await db.run(sql, params)        // { changes, lastInsertRowid }
await db.transaction(async tx => {   // tx has the same get/all/run
    await tx.run(...); await tx.get(...);
})
```

- **The conversion is a codemod, not a judgment call**: every
  `db.get/all/run/transaction` call site gains `await`, and every function on
  the call path becomes `async`. Jest + the smoke test catch the stragglers
  (a forgotten `await` yields a Promise where a row was expected, which fails
  loudly).
- **Transactions change semantics deliberately.** The SQLite adapter
  implements `transaction` as `BEGIN IMMEDIATE`/`COMMIT` statements guarded by
  a per-process async mutex (one writer at a time — which is what SQLite
  enforces anyway). The Postgres adapter checks a client out of the pool,
  runs `BEGIN`/`COMMIT`, and hands the *same client* to the callback via `tx`
  — the callback must use `tx`, never `db`, inside a transaction (ESLint rule
  to enforce it). Callbacks may now await, which several services
  (tableManager, economy transfers) will appreciate.
- **Named parameters survive.** The facade keeps `@name` params; the Postgres
  adapter translates `@name` → `$1..$n` at prepare time (with a statement
  cache). Value normalization (booleans, Dates, JSON) stays in the facade,
  identical for both adapters.

### 7.3 The dialect pass

~322 statements use constructs that differ. The inventory:

| SQLite construct | Postgres equivalent | Strategy |
| --- | --- | --- |
| `datetime('now')`, `datetime('now', '-7 days')` | `now()`, `now() - interval '7 days'` | Facade-level `sqlNow()`/`sqlAgo(n, unit)` helpers; statements rewritten once to use them |
| `CURRENT_TIMESTAMP` | identical | none |
| `ON CONFLICT ... DO UPDATE` | identical | none |
| `RETURNING` | identical | none |
| `INTEGER PRIMARY KEY AUTOINCREMENT` / rowid | `BIGINT GENERATED ALWAYS AS IDENTITY` | schema translation only |
| `lastInsertRowid` | `RETURNING id` under the hood | Postgres adapter appends `RETURNING id` when the caller reads `lastInsertRowid` is not detectable — instead the facade adds `db.insert(sql, params)` returning the new id, and call sites that use `lastInsertRowid` (~40) migrate to it |
| Booleans as 0/1 | native `boolean`, but 0/1 comparisons work on `smallint` | keep 0/1 `smallint` columns — zero call-site churn |
| `pragma table_info` migrations (`applyColumnMigrations`) | `information_schema.columns` | adapter-specific `ensureColumn` implementation behind one helper |
| sqlite-vec `memory_vec_<dims>` virtual tables | pgvector `vector(<dims>)` column + HNSW index, partitioned by the same `guildId\|model` key | `memoryService` already abstracts index-vs-brute-force; the pgvector path becomes a third strategy and the brute-force fallback stays for SQLite-without-vec |
| `LIKE` (case-insensitive on ASCII by default) | `ILIKE` for the search paths that rely on it | dialect helper |

Two schemas ship (`schema.sqlite.sql`, `schema.postgres.sql`) generated from
one annotated source of truth to prevent drift, plus a **one-shot migrator**
(`npm run migrate-to-postgres`): opens the SQLite file, streams all 83 tables
into Postgres inside one transaction, re-embeds nothing (vectors copy as-is
into pgvector), verifies row counts per table, and prints a report. The
migrator is idempotent onto an empty database and refuses a non-empty one.

### 7.4 SQLite stays

The standards doc's "local SQLite, no external database server" principle is
*amended*, not repealed: **`lite` profile installs (single container, Pi 4B)
keep SQLite as the default**, and the CI matrix runs the full Jest suite
against both adapters so neither dialect rots. Split (`full` profile)
deployments require Postgres — we deliberately do not support two processes
sharing one SQLite file (the vec-index sync, column migrations, and backup
story all get subtle there, and the payoff is nil once Postgres is a
`docker compose --profile full up` away).

## 8. The reactive front end

### 8.1 Framework choice

Requirements the framework must serve: streaming SSE token rendering, WS
audio (Parlor Live: AudioWorklet up, MediaSource down), canvas force-layout
graphs, KaTeX, a PWA shell, heavy mobile use, and a maintainer who values
longevity and self-hosting over novelty.

- **React 19 + Vite + TypeScript** — *recommended.* Biggest ecosystem and
  hiring/help surface, first-class TanStack Query (which is precisely shaped
  for our REST API + SSE invalidation), stable for a decade. Vite dev server
  proxies `/api` to a running `api` service, so the dev loop is hot-reload
  against real data.
- SvelteKit — genuinely attractive (less boilerplate, smaller bundles) and a
  reasonable choice if the maintainer prefers it; loses on ecosystem depth
  for the long tail (query caching, virtualized lists, headless UI).
- SolidJS — best raw reactivity, smallest community; wrong risk profile for a
  hobby-scale team.
- Next.js — rejected: SSR/RSC solve problems an authenticated self-hosted
  portal does not have, and the server runtime complicates the nginx-static
  deployment story.

State model: **TanStack Query owns all server state** (conversations, home
snapshot, tasks, decks, exchange positions), with SSE/WS handlers writing
into the query cache (`setQueryData`) so streamed deltas and gateway events
update the UI without refetching. Component state stays local; no Redux, no
global store beyond a thin session/theme context. Router: TanStack Router
with routes mirroring today's hash routes (`/app/study`, `/app/library`, …)
plus redirects from the old `#study` forms so existing bookmarks keep working.

### 8.2 What carries over (a lot)

- **The dependency-free renderer modules are the crown jewels and port
  nearly as-is**: `markdown.js` (escape-first), `highlight.js`, `math.js`
  (KaTeX lazy-load), `graph.js` (canvas force layout), `codeblocks.js` (the
  applet sandbox rules — `allow-scripts` and never `allow-same-origin` — are
  security decisions, not framework code). Each gets a thin React wrapper
  (`<Markdown source={...}/>`) around the existing pure functions.
- **The design system**: `style.css` custom properties (room washes,
  time-of-day classes, berry glow, reduced-motion guards) become the token
  layer; components consume the same variables. The house metaphor, hash
  deep-links, and the atmosphere layer are product decisions that survive
  intact.
- **The API client**: `api.js`'s endpoints become typed TanStack Query hooks
  (`useHome()`, `useConversations()`, `useTurnStream()`); the SSE parsing in
  `chat.js` becomes a `useChatTurn` hook emitting the same event vocabulary
  (`delta`, `tool`, `persona_*`, `learned`).
- **The service worker/PWA shell** keeps the same rules: network-first for
  static, never intercept `/api/*` (Vite's build output slots into the same
  `sw.js` strategy with a build-hash cache name).

### 8.3 Migration: room by room, both clients live

The API does not change for the front-end port (that independence is the
point of §3's second structural fact). During the transition:

- The legacy client stays served at `/app` exactly as today.
- The React client mounts at `/app/next` (dev flag: `webapp.nextClient`) and
  ports **one room at a time**, in order of value: Study (chat — hardest,
  most-used) → Home → Library → Tasks/Usage/Decks (form-heavy, easy wins) →
  Workshop → Exchange → Parlor (incl. Live audio — last, hardest WS surface)
  → Observatory.
- A room ports when it reaches feature parity with its legacy counterpart
  (checklist per room derived from the standards doc's web-app section), then
  `/app` flips to the new build and the legacy files are deleted. No long
  cohabitation: the flip happens once, when the last room lands.

## 9. Real-time contract

The wire protocols are the compatibility line between backend and frontend
work, so they are frozen for the duration of the port:

- **Chat turns**: `POST /api/app/chat/...` responding with SSE (`delta`,
  `tool`, `error`, terminal message event). Streaming stays SSE — it
  traverses the nginx proxy and tunnels with `X-Accel-Buffering: no`/
  `proxy_buffering off`, and needs no upgrade handshake.
- **Parlor group turns**: the existing multi-persona SSE vocabulary
  (`persona_start`/`persona_pass`/`delta`/`persona_tool`/`persona_message`/
  `learned`) unchanged.
- **Parlor Live**: WS with the same auth-before-upgrade rule (session cookie
  + Origin guard), now terminating in `api`.
- **New in this port — one portal event stream**: `GET /api/app/events`
  (SSE) multiplexing gateway-originated events (§6: follow-up delivered,
  automation ran, agent run updated) plus server-side invalidation hints
  (`{"invalidate": ["home"]}`). The reactive client subscribes once and maps
  events to query invalidations — this is what replaces the legacy client's
  polling and makes the app feel alive.

## 10. Singleton workers

The six background loops (automation, heartbeat, monologue, memory
consolidation, risk engine, agent tracker) plus Observatory auto-resume are
**at-most-once** processes. They all live in the `bot` service, for two
reasons: every one of them delivers through Discord, and `bot` is inherently
a singleton (one gateway identity).

Multi-process safety notes, so nothing regresses when `api` starts writing to
the same tables concurrently:

- `automationService.claimDueRun` is already an atomic claim — safe by
  design, and the pattern to copy for anything new.
- `followupService.recordDelivery` is already guarded on status + exact
  `dueAt` — safe.
- The risk engine, monologue, heartbeat, and consolidation are singletons by
  deployment (only `bot` runs them). On Postgres, each wraps its tick in
  `pg_try_advisory_lock` as a belt-and-suspenders guard against accidental
  double-deployment; on SQLite the question cannot arise (lite = one
  process).
- A future dedicated `worker` service (splitting the loops out of `bot`) is
  left as an explicitly-supported evolution: the loops already live in core
  and take a client/gateway, so the move is deployment-only. Not part of
  this port.

## 11. Parallelism: what the split buys, and what still pins us

**Immediately** (one replica of each service):

- Web chat turns, parlor generation, embedding recall, and exchange audits
  run on a different core than voice encoding, Discord event handling, and
  the six background loops. Today a heavy web turn visibly degrades voice
  and vice versa; after the split they cannot.
- Postgres serves concurrent readers/writers from both processes; today's
  one-writer WAL bottleneck (and the 10s `busy_timeout`) disappears.
- The web tier restarts and deploys independently of the bot — front-end
  iteration stops costing Discord reconnects.

**Not yet, and stated honestly** — `api` starts at exactly one replica
because these are in-memory today (each is fine single-replica, and each has
a named path to shared state when N>1 is wanted):

| In-memory state in `api` | Path to N replicas |
| --- | --- |
| `_liveTurn` per-user turn lock + watchdog | Postgres advisory lock keyed on userId |
| Sliding-window rate limits (chat, parlor, voice) | Postgres counter table or Redis, whichever lands first |
| Incognito context windows | Deliberately ephemeral — sticky sessions, or accept per-replica windows |
| Generated-file registry (owner-bound `/api/app/files`) | Persist the registry rows (small table), files already on the shared volume |
| Parlor Live sessions (WS) | Sticky sessions at nginx (`ip_hash` or cookie), which WS wants anyway |

When N>1 becomes real, that is also the moment to add Redis (pub/sub +
rate-limit counters) — not before.

## 12. Orchestration: Docker Compose and Dockerfiles

### 12.1 Profiles

- **`lite`** (default; the Pi 4B path): today's single container — bot + web
  portal in one process, SQLite on a volume. This profile is the current
  `docker-compose.yml` essentially unchanged and remains the README's
  quick-start. The <500MB idle RSS target continues to apply to it.
- **`full`**: the four-service split below. Target hardware: any amd64/arm64
  box with ≥4GB RAM. The RSS target applies per-service (bot ≤500MB; api
  ≤300MB; postgres tuned small: `shared_buffers=128MB`).

### 12.2 Compose sketch (`deploy/docker-compose.yml`)

```yaml
name: goobster

services:
  postgres:
    image: pgvector/pgvector:pg17
    profiles: ["full"]
    environment:
      POSTGRES_DB: goobster
      POSTGRES_USER: goobster
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set in .env}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U goobster -d goobster"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  bot:
    build: { context: .., dockerfile: deploy/bot.Dockerfile }
    profiles: ["full"]
    environment:
      GOOBSTER_DB_URL: postgres://goobster:${POSTGRES_PASSWORD}@postgres:5432/goobster
      GOOBSTER_INTERNAL_TOKEN: ${GOOBSTER_INTERNAL_TOKEN:?set in .env}
      # AI/integration keys as today (env-first via config/aiConfig.js)
    volumes:
      - ./config.json:/app/config.json:ro
      - goobster-data:/app/data          # music, images, sandbox, uploads
      - goobster-cache:/app/cache
    networks: [internal]
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
    restart: unless-stopped

  api:
    build: { context: .., dockerfile: deploy/api.Dockerfile }
    profiles: ["full"]
    environment:
      GOOBSTER_DB_URL: postgres://goobster:${POSTGRES_PASSWORD}@postgres:5432/goobster
      GOOBSTER_GATEWAY_URL: http://bot:3000
      GOOBSTER_INTERNAL_TOKEN: ${GOOBSTER_INTERNAL_TOKEN}
    volumes:
      - ./config.json:/app/config.json:ro
      - goobster-data:/app/data          # shared: uploads, sandbox, observatory
    networks: [internal]
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3100/health"]
    restart: unless-stopped

  web:
    build: { context: .., dockerfile: deploy/web.Dockerfile }   # multi-stage: vite build → nginx
    profiles: ["full"]
    ports: ["3000:80"]                   # the tunnel/edge target
    networks: [internal, edge]
    depends_on: [api]
    restart: unless-stopped

  goobster-lite:
    build: { context: .., dockerfile: deploy/lite.Dockerfile }  # today's Dockerfile
    profiles: ["lite"]
    ports: ["3000:3000"]
    volumes:
      - ./config.json:/app/config.json:ro
      - goobster-data:/app/data
      - goobster-cache:/app/cache
    restart: unless-stopped

networks:
  internal: { internal: true }   # postgres/bot/api are unreachable from outside
  edge: {}

volumes:
  pgdata:
  goobster-data:
  goobster-cache:
```

Notes:

- **Only `web` is published.** nginx serves the static build and proxies
  `/api/*` → `api` (SSE-safe: `proxy_buffering off`, long read timeouts, WS
  upgrade headers) and the bot-owned public surfaces (`/api/activity`,
  webhooks, screen-vision/GBA pairing + WS) → `bot`. One published port keeps
  the cloudflared-tunnel story identical to today: the tunnel points at
  `web`, full stop.
- **`bot` and `api` share the `goobster-data` volume** deliberately: web
  uploads, sandbox workspaces, Observatory projects, generated music — and
  `privacyService.forgetUser` deletes files from whichever process runs it.
  Same-host volume sharing is safe (these are per-user directories with
  content-hash names, not contended files).
- **The sandbox needs one privilege note**: bubblewrap inside a container
  requires `--security-opt seccomp=unconfined` or falls back to `unshare -rn`
  (documented today in `code_sandbox.md`); this is unchanged, but now applies
  to *both* `bot` and `api` since both can execute chat turns. A dedicated
  locked-down `sandbox-runner` service is the natural hardening follow-up,
  explicitly out of scope here.
- **Secrets**: `POSTGRES_PASSWORD` and `GOOBSTER_INTERNAL_TOKEN` live in
  `.env` next to the compose file (gitignored), everything else keeps the
  env-first `config/aiConfig.js` convention.

### 12.3 Dockerfiles

- `bot.Dockerfile`: today's Dockerfile minus the web client; keeps ffmpeg,
  python venv (spotdl/yt-dlp), native-module build deps, ARM64 NEON flag.
- `api.Dockerfile`: `node:22-bookworm-slim` + core; needs ffmpeg (Observatory
  renders) and the sandbox python setup when enabled, but no opus/sodium
  voice deps — measurably smaller image.
- `web.Dockerfile`: multi-stage — `node:22` builds the Vite bundle, final
  stage is `nginx:alpine` + `deploy/nginx.conf` + static files. No Node at
  runtime.
- `lite.Dockerfile`: today's Dockerfile, renamed. Runs `apps/bot` with
  `webapp.enabled` mounting the API routes in-process exactly as now — the
  monorepo keeps this wiring working because `api`'s route modules live in
  core-adjacent code both apps can mount.

## 13. Migration roadmap

Each phase ships to `main` independently with CI green (lint + smoke + Jest,
now matrixed over both DB adapters from Phase 2 on), and the bot never
breaks. Order matters: the database phases precede the service split because
the split *requires* concurrent DB access; the front end is last because it
depends on nothing but the frozen API contract (§9) and can even proceed in
parallel with Phases 3–4 if desired.

**Phase 0 — monorepo + core extraction.** Workspaces, move `services/`,
`utils/`, `db/`, `config/` into `packages/core`, apps import from it. Pure
mechanical moves, zero behavior change. Exit: CI green, `lite` container
builds and connects, `git log --follow` traces every moved file.

**Phase 1 — async DB facade (still SQLite).** The codemod (§7.2): `await` at
~893 call sites, async-mutex transactions, the `db.insert()` helper, the
`sqlNow()`/`sqlAgo()` dialect helpers, the ESLint rules (`tx` inside
transactions; no raw `datetime('now')` outside `db/`). Exit: full Jest suite
green on SQLite, a soak run of the real bot (heartbeat + automations + a
voice session + web chat) shows no transaction regressions.

**Phase 2 — Postgres adapter + migrator.** The `pg` adapter, the dual schema
build, pgvector recall strategy in `memoryService`, `migrate-to-postgres`,
CI matrix (every DB-backed spec runs on both adapters; Postgres via a CI
service container). Exit: both matrices green; a migrated production copy
passes `auditService.reconcile` (all nine exchange invariants) and spot
`auditUser` checks byte-for-byte against the SQLite source.

**Phase 3 — the gateway seam + api extraction.** `DiscordGateway` interface,
`LocalGateway`, the bot's `/internal/gateway/*` routes, `RemoteGateway`,
then `apps/api` hosting the existing `/api/app/*` routes + sessions + SSE/WS
against Postgres. The `full` compose profile lands here, with nginx serving
the *legacy* client from `api` (unchanged) until Phase 4. Exit: every web
Jest spec passes in the api app; a full manual pass of the portal (chat with
tools, parlor incl. Live, exchange trade, tasks, forget-me) against the
4-service compose; bot-down degradation behaves per §6.

**Phase 4 — the reactive client.** Vite + React shell at `/app/next`, port
rooms in the §8.3 order, add the `/api/app/events` stream, flip `/app`, and
delete `web/app/`. Exit: per-room parity checklists complete; Lighthouse
mobile pass on Study and Home; PWA install + offline shell verified;
the flip.

**Phase 5 — hardening (optional, on demand).** Advisory-lock guards on the
singleton loops, persisted file registry, sticky-session config, Redis
when/if N>1 API replicas, `sandbox-runner` isolation service, moving the
Activity behind the gateway. Each item independent.

## 14. Amendments the standards document needs on adoption

`development_standards_and_project_goals.md` stays authoritative; adopting
this spec means editing it, minimally:

1. **"Self-hosted first"** — "Local SQLite database — no external database
   server" becomes "SQLite (lite profile) or a local Postgres container
   (full profile); all schema in `db/`, applied/verified on open."
2. **"Database access"** — the facade contract gains `await`, `tx` inside
   transactions, `db.insert()`, and the dialect-helper rule ("never write
   `datetime('now')` or engine-specific SQL outside `db/`").
3. **"Code organization"** — the monorepo layout, the core-never-imports-apps
   rule, and the gateway-interface rule ("web-reachable core code never
   touches discord.js directly; it takes a `DiscordGateway`").
4. **"State that must survive a restart lives in SQLite"** becomes "…in the
   database"; the in-memory exceptions list gains the §11 table with each
   entry's N-replica path.
5. **"Performance (Raspberry Pi constraints)"** — targets become per-profile
   (§12.1).
6. **The web app section** — the client is React/Vite; the renderer-module
   security rules (escape-first markdown, applet sandbox flags) are restated
   as framework-independent invariants.
7. **Testing** — the DB adapter matrix and per-app smoke tests.

## 15. Risks and mitigations

- **The async codemod is the big one.** ~893 call sites and every function
  up-stack. Mitigations: it is mechanical (scripted transform + typecheck
  pass), Phase-1-isolated (still SQLite, so behavior diffs are pure
  concurrency), and heavily covered (the whole Jest suite exercises the DB
  paths). Known sharp edge: code that relied on synchronous read-modify-write
  atomicity without a transaction can now interleave — the Phase 1 review
  specifically hunts for those (the exchange and economy paths already use
  transactions correctly).
- **Two SQL dialects forever.** Bounded by the facade + helpers + CI matrix;
  the 322-statement inventory (§7.3) is mostly three patterns. If the burden
  proves real, the escape hatch is deprecating the SQLite adapter — but that
  decision belongs to evidence, not this spec.
- **Pi footprint.** The `full` profile will not fit a Pi 4B's comfort zone
  and does not need to — `lite` remains first-class and CI-built. The risk is
  `lite` rotting; the mitigation is that `lite` is the same code (apps
  mounted in one process), not a fork.
- **Security surface of the internal gateway.** Mitigated by the internal
  Docker network (not published), the shared-secret header, JSON-snapshot
  responses (no live objects), and keeping *write*-gating permission checks
  uncached.
- **WS/SSE through the proxy.** nginx SSE/WS misconfiguration is a classic
  time sink; the nginx.conf ships in-repo, and Phase 3's exit criteria
  include streaming + Parlor Live through the full proxy chain.
- **Scope creep in Phase 4.** The room-parity checklists are the contract;
  new features land after a room flips, not during its port.

## 16. Open questions

1. **Postgres as the lite default too?** This spec keeps SQLite for lite. If
   operating one engine matters more than zero-dependency installs, lite
   could ship a bundled Postgres container instead — larger footprint,
   simpler matrix. Current recommendation stands: keep SQLite.
2. **TypeScript in core?** The apps are new code (api mostly moves, web is
   TS by default). Core could migrate opportunistically (JSDoc types already
   exist); a wholesale conversion is deliberately not scheduled.
3. **Where does the panel go long-term?** It manages the bot and is
   loopback-bound, so it stays in `bot`. If the reactive portal eventually
   absorbs its features (guild settings already overlap), the panel could
   retire — separate decision.
4. **Activity migration timing.** Left in `bot` (§4 note). Revisit after
   Phase 5 if Activity load ever competes with voice.
