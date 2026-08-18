# Reactive Web Architecture

> Spec for splitting Goobster into a Discord pillar, an HTTP API, and a
> reactive house UI — without giving up SQLite, the chat pipeline, or the
> Raspberry Pi single-process path.
>
> Status: **accepted direction, not yet implemented.** The default deploy
> remains one Node process. This document is the contract for the port.

The house of rooms (`#home`, `#study`, `#parlor`, `#library`, …) already
wants to feel like a place you inhabit. The code behind it is strong —
`handleChatInteraction`, the exchange façade, parlor retrieve→generate→write-back,
privacy theater, the Observatory — but it all lives in one Node process that
also owns the Discord gateway, voice, FFmpeg, the heartbeat, and the risk
engine. That process is why the portal cannot feel as live as Discord, and
why two people cannot really *use the house at the same time* as the bot
is speaking in a voice channel.

This spec keeps every product invariant in
`documentation/development_standards_and_project_goals.md`. It changes
**process topology and the UI runtime**, not the brain.

## 1. Why now

Three pressures landed at once:

1. **The portal outgrew vanilla modules.** The client is ~10k lines of
   imperative DOM (`web/app/*.js`), with room routing, atmosphere, SSE
   chat, Parlor Live, the exchange terminal, and a PWA shell all
   hand-wired. The house metaphor (crossfades, time-of-day wash, Home as
   a live companion snapshot) is fighting the renderer, not using it.
2. **One event loop is the bottleneck, not SQLite.** `better-sqlite3` is
   synchronous. A heavy write, a long tool round, a voice pipeline, or an
   Observatory segment all stall Discord heartbeats *and* every browser
   tab. Parallel usage is not a product decision today — it is physically
   unavailable.
3. **Discord ↔ web is already one database, but not one live system.**
   A `/stocks` fill and a Study turn share `economy_wallets` and
   `dm:<userId>` memory. The browser only finds out if it polls or
   reloads. That is the opposite of a house that is supposed to be
   inhabited.

What we will not do: rewrite the services, introduce Postgres, or make
the web app a second Goobster.

## 2. Non-negotiables

These are locked. A phase that violates one is the wrong phase.

| Invariant | Meaning |
| --- | --- |
| Discord is a pillar | The bot is a first-class process, not a webhook sidecar. Slash commands, voice, tavern, heartbeat, and gateway events stay. |
| SQLite is the system of record | One `data/goobster.sqlite` (WAL). No Redis, no extra database server. Both processes open the same file. |
| One chat pipeline | Web turns still call `handleChatInteraction` via `webChatService`. Never a parallel agent loop. |
| Façades, not forks | Exchange, tasks, parlor, Observatory stay the services they are. HTTP adds auth and error translation only. |
| Privacy is complete | `/forget-me`, `auditUser`, and the transparency report cover every new table (event log, locks, membership cache). |
| Single-process still works | `GOOBSTER_ROLE=all` (default) is today's `index.js`. A Pi without Docker is a supported deploy forever. |
| Self-hosted first | Compose is optional. No cloud-only auth, no CDN, no SSR host. |
| Activity and panel stay vanilla | Discord's iframe and the 800×400 touch panel stay plain ES modules. Only the house (`/app`) moves to a framework. |

## 3. What one process is costing us

Today `index.js` starts the Discord client **and** `web/server.js`, which
mounts health, webhooks, the Activity, the house API, screen vision, GBA
pairing, and the loopback panel on the same event loop.

```
                    ┌──────────────────────────────────────┐
   Discord WS  ────▶│  one Node process                    │
   Browser SSE ────▶│   gateway + voice + FFmpeg           │
   Activity WS ────▶│   Express + SSE + WS                 │
   Cron / hb   ────▶│   sandbox / Observatory children     │
                    │   better-sqlite3 (sync, blocks loop) │
                    └──────────────────────────────────────┘
```

Concrete collisions already in the code:

- **Sync SQLite on the hot path.** `db/index.js` is explicit: WAL allows
  concurrent *reads*, but a write still blocks this process's event loop.
  Discord's gateway heartbeat and a Study token stream share that loop.
- **In-memory exclusivity.** `_activeTurns` in `webChatService` (one
  in-flight Study turn per user), parlor's per-conversation lock, sandbox
  concurrency, Activity sessions, the generated-file registry, Parlor
  Live sockets — all process-local. A second process cannot see them,
  and a restart forgets the ones that were allowed to be transient.
- **Live Discord client as an auth dependency.**
  `utils/webGuildAccess.requireGuildMember` reads `client.guilds.cache`.
  The house cannot answer "may this session trade on this guild?" unless
  the gateway is up in *this* process.
- **No push from Discord into the house.** Parlor invite buttons, risk
  engine liquidations, automation deliveries, and new memories land in
  SQLite. The Home snapshot is request/response. The Library does not
  shimmer when `/recall` writes a row.

The split is how those become independently schedulable. It is not a
rewrite of the product.

## 4. Target topology

Three containers, one volume, one origin in front:

```
                         ┌─────────────┐
            browsers ───▶│  proxy      │  same origin (cookies)
                         │  :3000      │
                         └──────┬──────┘
                     /app       │        /api  /activity  /health
                        ▼       │              ▼
               ┌────────────┐   │     ┌─────────────────┐
               │  web       │   │     │  api            │
               │  Svelte SPA│   │     │  Express        │
               │  nginx     │   │     │  SSE / WS       │
               └────────────┘   │     │  chat pipeline  │
                                │     │  façades        │
                                │     └────────┬────────┘
                                │              │ SQLite WAL
                                │              ▼
                                │     ┌─────────────────┐
                                │     │  data/          │
                                │     │  goobster.sqlite│
                                │     │  music, uploads │
                                │     └────────▲────────┘
                                │              │
                                │     ┌────────┴────────┐
                                └─────│  bot            │
                     internal RPC     │  discord.js     │
                     :3001            │  voice, jobs    │
                     (docker net      │  heartbeat      │
                      only)           │  panel :3400    │
                                      └─────────────────┘
```

| Process | Owns | Does not own |
| --- | --- | --- |
| **bot** | Gateway, slash commands, voice, heartbeat, monologue, automations, follow-ups, exchange risk engine, localhost panel, table-game bot player, `deploy-commands` | Browser sessions, SSE, the house static files |
| **api** | `/health`, `/api/app/*`, Activity HTTP/WS, screen vision, GBA pairing, integration webhooks, sandbox/Observatory *execution* | A Discord gateway connection (uses REST + bot RPC) |
| **web** | Built house UI (Svelte). No secrets, no SQLite, no bot token | Business logic |

`GOOBSTER_ROLE=all|bot|api` selects the process. `all` is today's binary.
The web container is a static file server, not a third Node runtime.

### 4.1 Why not more processes

- A second **api** replica needs a single SQLite writer and sticky WS.
  That is a later problem. Phase 1 is *isolation*, not horizontal scale.
- A **worker** process for Observatory/sandbox is allowed later if the
  API event loop still stalls on child I/O. Do not add it until measured.
- Redis / NATS / Postgres would violate self-hosted-first and the Pi
  story. SQLite plus a localhost RPC is the bus.

## 5. Data plane — one SQLite, two connections

WAL + `busy_timeout = 10000` already exist for this. Two Node processes
opening the same file is a supported `better-sqlite3` pattern.

Rules:

- Each process has its **own** `Database` instance. Never share the
  singleton across a process boundary (there is no boundary to share).
- `schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`). Both
  processes may `exec` it. Column migrations (`applyColumnMigrations`)
  take a SQLite advisory lock (`BEGIN IMMEDIATE` on a `schema_lock` row)
  so two boots cannot interleave `ALTER TABLE`.
- `sqlite-vec` loads in **every** process that recalls memory. The
  extension is per-connection.
- Writes serialize at the file. Design for that: the API does house
  writes; the bot does Discord and job writes. Occasional contention
  waits on `busy_timeout` — it must not become a retry storm.
- **Do not run two API processes** against one file until there is a
  measured reason. Two bots on one token is forbidden (duplicate
  heartbeats, duplicate automations, split gateway).

### 5.1 State that must leave process memory

The standards already say restart-safe state lives in SQLite. A split
makes the same rule apply *across processes*:

| Today's Map | After the split |
| --- | --- |
| `webChatService._activeTurns` | `web_turn_locks` (userId PK, conversationId, startedAt, abortRequested). Watchdog is a SQL age check, same 15-minute rule. |
| Parlor per-conversation lock | Same table or `parlor_turn_locks` keyed by conversation id + `startedBy`. |
| Sliding-window rate limits | SQLite rows *or* stay per-process (API-only). Per-process is fine if there is one API. |
| Activity sessions | Stay in-memory on the process that owns the Activity WS (API). Re-auth is the recovery path — already an allowed exception. |
| Generated-file registry | SQLite or disk index. Restart must not 404 a file the message metadata still points at. |
| Parlor Live / screen / GBA sockets | Stay in-memory on the API. Transient, re-derivable. |
| Guild settings TTL cache | Per-process cache is fine (read-through). |
| Reply-detection channel tail | Bot-only, already documented as transient. |

Incognito windows stay in-memory on the API — persistence is the thing
the user opted out of.

Every new lock/event table is a `/forget-me` + `auditUser` surface.

## 6. Control plane — Discord without a gateway in the API

The house needs Discord for three jobs, and only the first is frequent:

1. **Membership** — "is this session a member of guild X?" (exchange,
   Library graph, Activity join). Today: `client.guilds.cache`.
2. **Outbound actions** — parlor invite DMs, sandbox approval DMs,
   Observatory "job finished" follow-ups, automation delivery.
3. **Presence / lists** — Home's "servers you share", invite picker
   fallback, panel channel lists.

### 6.1 Membership: REST + a cache the bot writes

The API process holds the bot token and calls Discord REST:

```
GET /guilds/{guildId}/members/{userId}
Authorization: Bot <token>
```

No gateway required. Cache hits in `guild_member_cache`
`(guildId, userId, flags, cachedAt)` so a trade does not wait on HTTP
when the bot has recently seen the member.

The bot process keeps the cache warm from `guildMemberAdd` /
`guildMemberRemove` / `guildMembersChunk`. The API treats a miss as a
live REST fetch, then writes the cache. `requireGuildMember` becomes a
pure function over that helper — **no `client` argument**.

### 6.2 Outbound Discord: bot RPC, not a second gateway

DMs, channel posts, and "is voice connected?" stay on the bot. The API
does not open a gateway.

Internal HTTP, docker-network only, shared secret:

```
POST http://bot:3001/internal/dm
POST http://bot:3001/internal/channel-message
GET  http://bot:3001/internal/guilds/:id/channels
GET  http://bot:3001/internal/voice/:guildId
```

- Bind `127.0.0.1` on bare metal; bind the compose network alias in
  Docker. Never publish `:3001` to the host.
- `X-Goobster-Internal-Key` (env, not `config.json` committed).
- Timeouts are short. A down bot degrades: house chat still works
  (SQLite + providers); invite DMs return `dmSent: false` (already the
  parlor contract); automations wait in their existing claim loop.

The panel stays on the bot (`127.0.0.1:3400`). It already needs the live
client. Do not proxy it through the public origin.

### 6.3 Activity (casino)

The Activity is a Discord-embedded vanilla client. It stays vanilla.
Its HTTP/WS can move to the API (same membership helper). The bot
player (`BotPlayer`) needs the client for optional voice comments —
those calls go through the RPC or the bot player stays hosted on the
bot and the API forwards `invite-bot` / table events. Prefer **bot
player on the bot**, table engine + WS on the API, economy still
`economyService.adjust()` in the API process (one SQLite).

## 7. Event bus — Discord ↔ house, live

SQLite is the durable log. The API is the fan-out. No Redis.

```sql
CREATE TABLE IF NOT EXISTS runtime_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    topic     TEXT NOT NULL,          -- 'memory.wrote', 'parlor.invite', 'exchange.filled', ...
    scope     TEXT NOT NULL,          -- userId, guildId, or 'web:<userId>:<key>'
    payload   TEXT NOT NULL,          -- JSON, no secrets
    createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
```

- Both processes `INSERT` after a domain mutation (same transaction
  when the mutation is local).
- The API holds `EventSource /api/app/events` (cookie auth) and tails
  `WHERE id > :lastId AND scope IN (:userScopes)` on a short interval
  (250–500 ms) or on a `fs.watch` of the WAL as a wake-up, then SSE
  `event: <topic>`.
- Payloads are pointers and public fields (`conversationId`,
  `memoryId`, `orderId`) — never tokens, never raw member lists.
- Prune older than 24 h. `/forget-me` deletes by user-shaped scopes.
- The house Home store applies topics instead of refetching everything.
  Study already has per-turn SSE; the bus is for *cross-surface* live
  (Library updates while you sit in the Study; Home clock of "he just
  remembered something" after a Discord mention).

This is the feature the reactive UI is *for*. A framework without this
bus is a prettier single process.

## 8. Parallelism — what becomes possible

"Parallel usage" here means **overlapping work that today's loop
serializes**, not a Kubernetes farm.

| Work | After the split |
| --- | --- |
| Two house users in the Study | Concurrent SSE on the API. Turn locks in SQLite so a user's second tab still 409s. |
| House chat during `/voicechat` | Voice + FFmpeg on the bot; tokens on the API. Neither waits on the other's event loop. |
| Exchange tick vs. a parlor turn | Risk engine on the bot; parlor generate on the API; both commit through SQLite. |
| Observatory segment vs. Discord heartbeat | Child processes already isolate CPU; the *parent* event loop is no longer the gateway. |
| Automation fire vs. a browser Stop | Claim-before-run stays on the bot. AbortControllers live on the API. |

Still singleton (exactly one):

- The Discord gateway (one token).
- Heartbeat / monologue / follow-up / automation / risk-engine timers
  (bot).
- The SQLite writer lock (the file).
- Per-user Study turn and per-conversation parlor turn.

A phase that starts two bots "for parallelism" is a bug.

## 9. Frontend — Svelte 5 + Vite (SPA)

### 9.1 Why Svelte, and why not the others

The house is already HTML-first: rooms are panes, atmosphere is CSS
classes on `body`, renderers are pure functions. The port should
**compile that model**, not replace it with a virtual-DOM app that
re-implements chat.

| Option | Verdict |
| --- | --- |
| **Svelte 5 + Vite SPA** | **Choose this.** Compile-time reactivity, smallest runtime of the major frameworks, maps onto rooms/stores/SSE without ceremony. Close to the current "enhance HTML" taste. Fine on a Pi as static files. |
| SvelteKit SSR | Rejected for v1. The house is cookie-authenticated and already has an Express API. SSR would duplicate auth, enlarge the Node surface, and buy nothing for a signed-in PWA. Revisit only if we need unauthenticated marketing pages. |
| Vue 3 + Vite | Acceptable runner-up. Slightly heavier, more moving pieces (Pinia). Choose only if the implementer is already fluent and Svelte is a genuine block. |
| React + Vite | Rejected. Largest bundle, most ceremony, furthest from the current modules. |
| Next / Remix | Rejected. Extra Node process, cloud-host assumptions, SSR we do not want. |
| Stay vanilla | Rejected for the house. The house-of-rooms work is already asking for shared state, live Home, and room-local stores. Keep vanilla for the Activity and the panel. |

TypeScript is optional and off by default in `web-ui/` so the port
matches the rest of the repo. Existing renderer modules stay JS.

### 9.2 What the Svelte app is

A new tree, `web-ui/`, that **consumes `/api/app` unchanged**:

```
web-ui/
├── index.html
├── vite.config.js          # base: '/app/'
├── src/
│   ├── main.js
│   ├── App.svelte          # login vs house, hash rooms
│   ├── lib/
│   │   ├── api.js          # port of web/app/api.js
│   │   ├── markdown.js     # moved, not rewritten
│   │   ├── highlight.js
│   │   ├── math.js
│   │   ├── graph.js
│   │   ├── codeblocks.js
│   │   └── atmosphere.js
│   ├── rooms/
│   │   ├── Home.svelte
│   │   ├── Study.svelte
│   │   ├── Parlor.svelte
│   │   ├── Library.svelte
│   │   ├── Workshop.svelte
│   │   ├── Observatory.svelte
│   │   └── grounds/        # Exchange, Tasks, Decks, Usage
│   └── stores/
│       ├── session.js
│       ├── rooms.js
│       ├── events.js       # EventSource /api/app/events
│       └── turn.js
└── public/                 # icons, manifest, sw.js
```

Hash routes stay the house contract (`#home`, `#study`, `#library`,
`#workshop`, `#observatory`, …). Deep links and the PWA service worker
keep working. The service worker still **never** intercepts `/api/*`.

Stores are how the house becomes live:

- `events` is the runtime-event SSE. Home, Library, and the Study
  sidebar subscribe. A Discord-side memory write appears in the Library
  without a room change.
- `turn` is the durable lock's client face (`GET /api/app/chat/turn`
  already exists as `turnStatus`). Reload-in-flight stays.
- Room atmosphere (`room-*`, `tod-*`) is a store derived from the route
  and the clock — the same classes `atmosphere.js` already applies.

### 9.3 What we keep from the vanilla client

Do not rewrite these. Move them and import them:

- `markdown.js`, `highlight.js`, `math.js` (KaTeX, still served locally)
- `graph.js` (force layout)
- `codeblocks.js` (opaque-origin iframe sandbox — **never**
  `allow-same-origin`, never blob-URLs that inherit the app origin)
- Mini-app pin → Workshop
- Share viewer (`/app/share/<token>`) as a tiny separate entry
- Icon set and the berry mark

KaTeX cannot keep living at `/app/vendor/katex` out of `node_modules`
once nginx serves the SPA. Copy the vendor files into `web-ui/public/vendor/katex`
at build time (the same self-hosted-first rule).

### 9.4 Migration — strangler, one room at a time

Never a big-bang rewrite of 10k lines.

1. Stand up `web-ui/` with shell + Home talking to the existing API.
   Deploy it at `/app/` behind the proxy **or** at `/app-next/` until
   cutover (prefer `/app-next/` for one release so the vanilla house
   stays the default).
2. Port Study (SSE vocabulary must stay: `delta`, `tool`, `done`,
   `error`). This is the riskiest room and the one that proves the
   pipeline invariant.
3. Parlor (SSE + Live WS). Same `startTurn` / `startPersonaTurn`.
4. Library, Workshop, Observatory.
5. Grounds (Exchange, Tasks, Decks, Usage).
6. Delete the old room modules. Keep the renderers.

Acceptance for each room: the Jest service specs still pass; a manual
pass of the room's happy path; `/forget-me` still empties that room's
data. No new privacy surface.

## 10. Features the split actually unlocks

These are the reason to do the work, not "because frameworks":

- **A Home that breathes.** Runtime events update "what he knows" and
  "what he is watching" while you are in another room — including when
  the knowledge arrived from a Discord mention.
- **Study and Discord as two doors to one mind.** Already true in
  SQLite. The bus makes it *feel* true (sidebar title appears, memory
  chip ticks, Tasks badge increments when an automation the user
  created in a guild channel fires).
- **Overlapping inhabitants.** Two browsers, plus a voice session, plus
  an Observatory job, without the gateway hitching.
- **Room-local UI that vanilla keeps losing.** Optimistic pins in the
  Workshop, live job tails in the Observatory without a 3s poll,
  exchange marks that move when the risk engine ticks, parlor members
  seeing a turn without the 5s poll the current client uses.
- **Independent deploys.** A CSS/room bug no longer restarts the
  Discord process. A bot deploy no longer drops every SSE.

## 11. Docker and orchestration

Compose is the **optional** path for hosts that want the split. The
root `Dockerfile` + `docker-compose.yml` remain the one-container
Raspberry Pi / "just run it" path.

Target files (scaffolded in this change):

| File | Role |
| --- | --- |
| `deploy/split/docker-compose.yml` | **Works today:** `core` (current all-in-one image) + `web` (nginx on :3000 serving `web/app`, proxying `/api` `/activity` `/health` to `core`). Proves the front-door split before `GOOBSTER_ROLE` exists. |
| `deploy/split/docker-compose.split.yml` | **Target:** `bot` + `api` + `web`. Requires `GOOBSTER_ROLE`. Do not run until Phase 2. |
| `deploy/split/Dockerfile.web` | nginx Alpine. Today copies `web/app`; later copies `web-ui/dist`. |
| `deploy/split/nginx.conf` | `/app/` static, `/api/` `/activity` `/health` proxied, WebSocket upgrade. |
| `deploy/split/Caddyfile` | Alternative single-binary proxy for hosts that prefer Caddy. |

Shared volumes on every Node container: `./data`, `./cache`, `./logs`,
`./config.json:ro`. The SQLite file **must** be on a local POSIX
volume, not NFS, not a bind over a network share (WAL + `mmap` will
corrupt).

Resource sketch (not a promise — measure on the Pi):

- `bot`: 2 CPU shares, 512 MB — voice + gateway
- `api`: 2 CPU shares, 768 MB — models and sandbox are the hungry ones
- `web`: 32 MB
- `proxy`: 32 MB

Idle RSS of the **bot** should drop versus today's combined process
because it no longer holds SSE buffers and house JSON parsers. The
`< 500MB RSS at idle` budget applies to **bot + api + web** on a Pi
4B, not to each box independently. If a split host cannot meet it,
that host stays on `GOOBSTER_ROLE=all`.

### 11.1 Secrets and config

Unchanged: `config.json` is required for `token` / `clientId` /
`guildIds`. AI keys stay env-first. New env:

| Variable | Who | Purpose |
| --- | --- | --- |
| `GOOBSTER_ROLE` | bot, api | `all` (default), `bot`, `api` |
| `GOOBSTER_BOT_RPC` | api | `http://bot:3001` |
| `GOOBSTER_INTERNAL_KEY` | bot, api | RPC bearer |
| `GOOBSTER_DB_PATH` | bot, api | Must resolve to the **same** file |

`deploy-commands` runs **once**, from the bot container (or a oneshot),
never from the API.

## 12. Phased roadmap

Phases are sequential. Each one ships and stays useful if we stop.

### Phase 0 — this document and the proxy compose

Spec + `deploy/split/` topology. Root compose unchanged. No
`GOOBSTER_ROLE` behavior yet.

### Phase 1 — make the single process split-*ready*

Still one process. Land the tables and façades so a later process
boundary is boring:

- `web_turn_locks` + parlor lock rows; `_activeTurns` becomes a cache
  of the row.
- `runtime_events` + `/api/app/events`.
- `guild_member_cache` + REST `requireGuildMember` (client used only
  as a fast path when present).
- Generated-file registry on disk/SQLite.
- Advisory migration lock.

The vanilla house can already subscribe to `/api/app/events`. That is
a product win before Svelte exists.

### Phase 2 — `GOOBSTER_ROLE` and the internal RPC

Same image, two commands. Bot skips public `/app` and Activity. API
skips `client.login`. Compose `docker-compose.split.yml` becomes the
dev path. Single-process `all` still default.

Do not start this phase until Phase 1 locks are in SQLite — otherwise
the API and the bot will disagree about in-flight turns.

### Phase 3 — Svelte house (`web-ui/`)

Shell + Home behind `/app-next/`, then Study, then the rest of the
rooms. Cut `/app` over when Study + Home + auth are at parity.

### Phase 4 — retire the vanilla house

Delete room modules under `web/app/` that Svelte replaced. Keep
Activity (`web/activity/`) and the panel (`web/public/`). Renderers
live in `web-ui/src/lib/` (or a tiny `packages/web-renderers/` if the
share viewer needs them without bundling the house).

## 13. What we are not doing

- Replacing SQLite with Postgres "so we can scale."
- Running the API as Next.js / SvelteKit SSR.
- Putting the Discord token in the browser or in the web image.
- Forking `handleChatInteraction` for "web-native agents."
- Sharing one `better-sqlite3` Database handle via some clever RPC.
- Publishing the internal RPC port.
- Enabling `webapp.devMode` on the split proxy.
- Rewriting the Activity or the touch panel in Svelte.
- Kubernetes, service meshes, or a message broker.

## 14. First implementation tickets

When someone picks this up, this is the order:

1. `runtime_events` + `GET /api/app/events` + a vanilla Home listener.
2. `web_turn_locks` replacing `_activeTurns` (watchdog SQL, same
   AbortController plumbing).
3. REST `requireGuildMember` with `guild_member_cache`.
4. `GOOBSTER_ROLE` + internal DM/channel RPC.
5. `web-ui` scaffold (Svelte 5, Vite, `base: '/app/'`) and Home.
6. Study port, then cutover.

Tickets 1–3 are valuable even if the Svelte port waits a year. They
are also the tests: Jest can exercise locks and the event tail against
a throwaway `GOOBSTER_DB_PATH` with no Discord token.

## 15. Decision log

| Decision | Choice | Why |
| --- | --- | --- |
| Framework | Svelte 5 + Vite SPA | Smallest runtime, HTML-first, no SSR tax |
| Backend split | bot + api, same image | One artifact, two roles |
| Frontend hosting | nginx static | No third Node process |
| Cross-process bus | SQLite `runtime_events` + API SSE | Self-hosted, restart-safe |
| Discord in the API | REST + cache; RPC for sends | No second gateway |
| Default deploy | Still `all` | Pi and current hosts |
| Activity / panel | Stay vanilla | Different constraints |
