---
title: Feature ownership inventory (installer P1.1)
kind: reference
summary: Which feature or core owns every command, runtime step, startup side effect, event gate, interaction, AI tool, MCP tool, HTTP/WS route, portal room, tutorial, table and system dependency; the audit results E1/T1/R1/S1/M1; the dependency graph; legacy switches versus fresh-install defaults; and the ambiguities with their resolution.
tags: [installer, features, catalog, architecture, operations]
---

# Feature ownership inventory

This is the reviewed result of the Phase 1 audits from
`documentation/installer_plan.md` (E1, T1, R1, S1, M1) for the feature
manifest decided in ADR 0013. It names the feature ids the catalog uses,
assigns every optional execution surface one owner, records the evidence
behind each dependency, and lists the ambiguities with the resolution that
was taken.

The machine-readable form is `packages/core/features/inventory.js`. It is a
plain data module (it requires nothing) and `tests/featureInventory.test.js`
enumerates the real code - command files on disk, `coreRuntime` steps, the
interaction router, the tool registry, the MCP tool list, every mounted
Express route, the WebSocket paths, `schema.sql`, the portal rooms and the
tutorial catalogs - and fails when a surface is unclaimed, when the
inventory names something that no longer exists, or when a route rule
matches nothing. Adding a command, step, tool or route without claiming it
breaks `npm test`; nothing here depends on a hand-maintained count.

This document and the inventory module change **no runtime behaviour**.
Gating lands in P1.3 - P1.5 (#318 - #320) on top of the catalog from P1.2
(#317).

## Feature ids

Twenty optional features plus the `core` pseudo-owner. Ids are stable and
camelCase; they are the keys of `features.json` from #317 onwards.

| Id | Kind | Depends on | Owns (summary) |
|---|---|---|---|
| `core` | pseudo-owner | - | Chat, portal shell, settings, privacy, export, retention, Inbox, memory, self-docs, work ledger, Parlor, Workshop applets, MTGA, followed sources, image generation, search, Wrapped, integration linking |
| `discord` | adapter | - | The gateway (`config/discordConfig.js`), guild/DM delivery, `setNickname` |
| `push` | adapter | - | Web push subscriptions and delivery |
| `mail` | adapter | - | SMTP delivery for sign-up verification, recovery and address changes |
| `music` | feature | - | Music Lab / Song Studio, generation and ambience, library, downloads, AI DJ, Discord playback commands |
| `voice` | feature | - | TTS/STT, voice chat, live voice sessions, `/speak`, `/voicechat`, `/setvoice`, `voiceStateUpdate` |
| `tavern` | feature | - | Adventure mode commands, tools, buttons and tables |
| `economy` | feature | - | Points and accounting (`/points`, `checkPoints`, `economy_*`) |
| `exchange` | feature | `economy` | Margin, options, futures, perps, spreads, the risk engine step, the stock game, portal Trading |
| `gambling` | feature | `economy` | `/gamble`, the wheel, predictions, casino table games |
| `gba` | feature | - | GBA harness (`/gbarun`, `/api/gba-run/*`, the advice inbox gate, `clients/gba-mcp`) |
| `projects` | feature | - | Workshop projects, missions, triggers, project invites, `workshopPinMigration` |
| `observatory` | feature | `projects`, `sandbox` | Runs, jobs, render, the `observatory` tool, `observatoryResume` |
| `sandbox` | feature | - | The code runner, `runCode`, `requestPythonPackages`, sandbox approval buttons |
| `mcp` | feature | - | The Goobster MCP server mount (tools and resources are owned by the features they expose) |
| `knowledge` | feature | - | Spitball editing: notes, transfers, note attachments, the Knowledge room, `search_knowledge` |
| `expeditions` | feature | `knowledge` | Autonomous research, briefs, the `spitballExpeditions` step |
| `github` | feature | - | `/github`, GitHub tools, webhook receiver, issue capture reaction, `repo_watches`, `integration_audit`, `pending_integration_actions` |
| `cursor` | feature | `github` | `/agent`, `launchCursorAgent`, the agent tracker step and mission-control thread gate |
| `screenVision` | feature | - | `/screenvision`, the companion page, `/api/screen/*` and its WebSocket |
| `discordActivity` | feature | `discord` | The embedded Activity transport (`/activity/*`, `/api/activity/*`, its WebSocket) |

Soft requirements are recorded per surface as `alsoRequires` and never
promoted to a feature dependency. Examples: the music playback commands
also require `voice` and `discord`; `/wheel`, `/predict`, `eventContracts`
and `goblinWheel` also require `exchange`; the table games also require
`discordActivity`. The hard edges above are the whole graph and it is
acyclic.

### Boundary amendments to ADR 0013

Two rows of the ADR's boundary table changed on evidence:

- **Music does not depend on Voice.** Music Lab, Song Studio, generation
  and the library run in the browser and the portal without ffmpeg,
  `@discordjs/voice` or the python venv (`packages/core/web/routes/studio.js`,
  `services/studioSongService.js`, `apps/web/src/music-lab/`). Only the
  Discord voice-channel surfaces (`/play`, `/playtrack`, `/playmusic`,
  `/stopmusic`, `/music`, `/aidj`, `/playambience`, `/stopambience`, the
  play-control buttons and context menu, the `playTrack` tool) need Voice,
  Discord and ffmpeg; they carry `alsoRequires: ['voice', 'discord']`.
  Downloads (`/spotdl`) and generation stay plain `music`.
- **The "mission-control threads" gate in `messageCreate.js` belongs to
  Cursor, not Projects.** It is `agentTrackerService.handleThreadMessage`
  keyed on `agent_runs.threadId` (`apps/bot/events/messageCreate.js`,
  `services/agentTrackerService.js`). Projects owns project rooms,
  missions and triggers; the Cursor feature owns the tracker and its
  thread gate.

Two further clarifications that the ADR left open:

- **Discord Activity is `discordActivity`.** The id `activity` would
  collide with the portal room `activity` in `apps/web/src/lib/rooms.cjs`.
  The feature owns only the transport; the table games it hosts are
  Gambling's.
- **Trading is Exchange.** The stock game (`/stocks`, `stockQuote`,
  `tradeStock`, `checkPortfolio`, `/api/app/exchange/{quote,history,search,trade,leaderboard}`,
  `stock_*` tables) is owned by `exchange`, matching the ADR's "Trading,
  margin, options, futures" wording, so Economy is only points and
  accounting.

## Audit results

### E1 - points and accounting callers

Question: which services read or write points outside Economy and Exchange?
Decides whether accounting is infrastructure.

Result: accounting is **not** infrastructure; it is the `economy` feature.
Twenty-two callers of `economyService` were found. All of them are owned by
`exchange` (account, short, options, perps, corporate actions, risk engine,
spread, audit, group play, stock portfolio, `webExchangeService`, the
exchange AI tools), `gambling` (`gamblingService`, wheel, predictions,
`tableManager`, `botPlayer`), `economy` (`/points`, `checkPoints`) or
`discordActivity` (balances shown in the Activity). The two callers
outside those are core by rule: `privacyService` (erasure and the
"what do you know about me" report read `economy_*` and must keep doing so
with Economy off) and `automationService.executeWheel` (a bundled core
step whose wheel branch will be gated on Gambling and Exchange in #318).
Nothing in chat, memory, Inbox or the portal shell reads points.

Consequences carried into the catalog: `exchange` and `gambling` both
depend on `economy`; nothing depends on `exchange` except through
`alsoRequires` on the wheel and prediction surfaces. Per-guild
`exchange_settings.*Enabled` columns remain data, not host switches.

### T1 - AI tools

Fifty-three tools in `packages/core/utils/toolsRegistry.js` plus the
provider-native `web_search`. Owners: core 19 (search, images, files,
memory, notes, docs, Parlor, Notion, automations, follow-ups, attention,
watches, `executePlan`) plus `web_search`, exchange 12 (`optionChain`, `tradeOption`,
`shortStock`, `marginAccount`, `exchangeOrder`, `tradeSpread`,
`tradePerp`, `auditAccount`, `auditExchange`, `stockQuote`, `tradeStock`,
`checkPortfolio`), tavern 7, gambling 3 (`gamblePoints`, `goblinWheel`,
`eventContracts`), sandbox 2 (`runCode`, `requestPythonPackages`),
github 3, voice 2, music 1, economy 1, observatory 1, cursor 1, discord 1
(`setNickname`).

Findings for #319: `runCode` and `observatory` already hide themselves
when their service is disabled (`toolsRegistry.js`, `utils/tools/observatory.js`),
but `toolsRegistry.execute()` has no gate, so a stale tool call from a
client or a cached definition still executes. `getDefinitions` is the only
filter today and only for those two tools.

### R1 - HTTP, WebSocket and static routes

Three hundred and ninety-eight routes on ten HTTP surfaces were
enumerated by building every router in-process: the portal
(`packages/core/web/routes/*.js` through `createWebAppApp`), the bot-side
mounts in `apps/bot/web/server.js` (health, panel, webhooks, internal
gateway, Activity, MCP, Screen Vision, GBA run) and the sandbox runner
(`apps/sandbox/server.js`, which the first pass of the audit had missed).
Forty-five ordered rules claim them. Core owns everything under
`/api/app/parlor`, `/mtga`, `/applets`, `/followed-sources`,
`/integrations`, `/admin`, `/auth`, `/account`, `/inbox`, `/privacy`, the
health endpoints and the portal shell; the panel's `/api/guilds/**` is
`discord` except its voicechat (voice), playlist (music) and memory
(core) routes. Feature-owned groups: projects, expeditions, music
(`/api/app/studio/*`), knowledge (`/api/app/spitball/notes*`, transfers,
`/api/app/note-attachments*`), exchange (`/api/app/exchange/*`),
observatory (the run/render/job routes inside `routes/projects.js` and
`/api/app/observatory/*`), voice (`/api/app/voice/*`), discordActivity
(`/api/activity/*`), screenVision (`/api/screen/*`), push, mcp
(`/mcp`), github and cursor (webhook receivers), gba (`/api/gba-run/*`)
and sandbox (the runner's `POST /run`, `POST /cancel`).

Six WebSocket paths: `/api/app/parlor/live` core, `/api/app/voice/live`
voice, `/api/app/studio/live` music, `/api/activity/ws` discordActivity,
`/api/screen/ws` screenVision, `/api/gba-run/ws` gba. Fifteen static
bundles and assets:
`/app/*` core (including `liveAudioWorklet.js`, shared by Parlor and Voice
live), `/activity/*` discordActivity, `/companion*` screenVision, the
GBA harness client gba.

Route ownership is expressed as an ordered rule list in `inventory.js`
(first match wins) so that the observatory rows inside `routes/projects.js`
and the knowledge rows inside the Spitball router are claimed without
splitting the router files. The test asserts every mounted route matches a
rule and every rule matches a route.

#### How the rules are enforced (#320)

`packages/core/web/featureGate.js` is the one enforcement point; it reads
`routeRules` (and `wsPaths`, and `staticAssets` for a GET no rule claims),
never a list of its own.

- Portal: one middleware, first in `createWebAppApp`, before the body parser
  and every router. A request whose owner (or an `alsoRequires` feature) is
  off answers 404 before any handler body runs. A signed-in caller gets
  `{ "error": { "code": "FEATURE_UNAVAILABLE", ... }, "feature": "<id>" }`
  (the portal's own error shape); everyone else gets the answer a missing
  `/api/app` route gives, so availability cannot be probed without a session.
  Matching mirrors Express: HEAD answers as GET, case and a trailing slash
  do not matter.
- Bot public server and api app (`/api/activity`, `/activity`, `/`,
  `/api/webhooks/*`, `/api/screen/*`, `/companion*`, `/api/gba-run/*`,
  `/internal/gateway/*`, the MCP path): the same rules in front of every
  mount, answering `404 { "error": "FEATURE_UNAVAILABLE", "feature": "<id>" }`
  with no reasons. A feature that is off at startup is also not built at all:
  no `TableManager`/`BotPlayer`, no screen-vision or GBA session manager
  enabled, no MCP app, no webhook, internal-gateway or Activity router.
- WebSockets: an upgrade on an off owner's path is a plain 404 before the
  Origin rule, session lookup or connection lease, for everyone. An open
  socket whose owner goes off after `refresh()` gets one
  `{ "type": "error", "code": "FEATURE_UNAVAILABLE", "feature": "<id>" }`
  frame and a 1008 close on its next message (the portal sockets also on
  their next idle recheck); the message never reaches the feature.
- `GET /api/app/features` (signed-in, core) returns `features.status()`
  with reason and warning codes only, for the portal UI.

Enforcement follows the state file. With no usable `data/features.json`
(or an unusable one) the installation behaves as before the catalog: a
feature whose legacy switch is off is inactive in the resolver, but its
routes keep the answer the existing code gives (an unmounted router, the
MCP token routes that stay open so a token can be revoked, Discord login's
`LOGIN_UNAVAILABLE`). A refusal is enforced when the state file is in force,
when `GOOBSTER_FEATURE_<ID>` forces the owner off, or when a dependency is
enforced off. The rule is `featureState.enforcedOff`, shared with the tool,
MCP, command and step gates through `features/gate.js` (see
`documentation/feature_state.md`, "Reported versus enforced").

Ownership change made while wiring this: the portal's MCP token management
(`GET /api/app/mcp`, `POST /api/app/mcp/tokens`, `DELETE
/api/app/mcp/tokens/:id`) is `core`, not `mcp`. Revoking a token is a
management action that must stay reachable when the MCP transport is off;
the transport itself (`/mcp` on the bot and api servers, stdio) is `mcp`.

#### Routes reachable with everything off

With every optional feature off the following still answer, because their
rules are owned by `core` (or they are not claimed because they are not
routes of a feature):

- The portal shell and its files: `/app`, `/app/assets/*`,
  `/app/vendor/katex/*`, `/app/sw.js`, `/app/manifest.webmanifest`,
  `/app/offline.html`, `/app/liveAudioWorklet.js`, `/app/icons/*`,
  `/app/screenshots/*`, `/app/share-target`. The client bundle is not split
  per feature in this phase (physical exclusion is P3.2): feature rooms are
  hidden by the UI from `/api/app/features`, and their static files are only
  gated where a mount is feature-owned (`/activity/*`, `/` as the Activity
  client, `/companion*`).
- `/api/app/config`, `/me`, `/features`, `/auth/*` except the three Discord
  OAuth routes (`login`, `link/discord`, `callback`, owned by `discord`),
  `/account/*`, `/admin/*` (limits, invites, accounts, installation, audit,
  instance state), `/settings/*` including account export and erasure,
  `/privacy/*`, `/memory/*`, `/inbox/*`, `/usage`, `/home`, `/graph`, `/chat`,
  `/share`, `/files`, `/tasks`, `/integrations/*` (credential routes),
  `/attention`, `/applets`, `/mtga`, `/parlor/*` (and its WebSocket
  `/api/app/parlor/live`), `/conversation-context`, `/people`, `/friends`,
  `/dm`, `/followed-sources`, `/tutorials`, `/tutorial-preferences` and the
  `/api/app/events` stream.
- `GET /health` (bot and api) and the panel's `/api/status`, `/system`,
  `/ai/models`, `/api/guilds/:id/memory/*`. The panel runs on its own
  loopback server and is not gated by this layer.

Everything else is refused while its owner is off: `/api/app/projects*` and
`/observatory*` (projects, with the run/render/job routes owned by
observatory), `/spitball/*` (knowledge; lenses, expeditions, briefs and
note evidence are expeditions), `/note-attachments*` (knowledge),
`/exchange/*`, `/voice/*`, `/studio/*` (music), `/push*` (except
`DELETE /push/subscriptions`, which is core so a subscription can always be
removed), `/mcp*`, the
Discord OAuth routes, public Observatory share links
(`/app/observatory/share/*`), `/api/activity/*`, `/api/webhooks/github`,
`/api/webhooks/cursor`, `/api/screen/*`, `/companion*`, `/api/gba-run/*`,
`/internal/gateway/*` and `/mcp`. The sandbox runner (`POST /run`,
`/cancel`) is a separate process and is not gated here.

### S1 - runtime steps, startup side effects, events and interactions

`packages/core/runtime/coreRuntime.js` has twenty `step()` calls. Thirteen
are core: `eventBus`, `chatHistoryRetention`, `accountExports`, `selfDocs`,
`automation`, `followupDelivery`, `personalHeartbeat`, `memoryConsolidation`,
`knowledgeReflection`, `ledgerRetention`, `heartbeat`, `monologue` and the
`paused` handling. Seven are owned by one feature each: `workshopPinMigration`,
`missionReconcile` and `projectTriggerCatchUp` (projects),
`observatoryResume` (observatory), `spitballExpeditions` (expeditions),
`agentTracker` (cursor), `exchangeRiskEngine` (exchange).

The bundled core steps (`automation`, `heartbeat`, `personalHeartbeat`,
`memoryConsolidation`) always start; the feature-specific branches inside
them (automation wheels, expedition heartbeats, attention generators that
read feature tables) are gated inside the step in #318. A skipped
single-owner step is recorded as `skipped:feature`, distinct from the
`paused` skip.

Forty-five startup side effects outside `coreRuntime` were listed in the
audit (eager `require`s in `apps/bot/index.js`, `serviceManager.js`
constructing `VoiceService` at require time, `MusicService` probing ffmpeg
in its constructor, the command deploy hash in `data/.command-deploy-hash`,
the Activity's `TableManager`/`BotPlayer`, the MCP mount, webhook
receivers). They are claimed in `inventory.js` under their feature so that
#318 can make construction lazy where the feature is off.

Thirty-two event gates and listeners (the twelve `messageCreate` gates,
the discord.js client listeners in `apps/bot/index.js` including the
diagnostic ones - `error`, `warn`, `debug`, `invalidated`, `rateLimit`,
`cacheSweep`, `shardError` - and the `domainEventBus`/`eventBusService`
subscribers). The `messageCreate` gates keep their order, which the spec
asserts; owners are core except `#06 agent mission-control threads`
(cursor) and `#10 GBA advice inbox` (gba). `voiceStateUpdate` is voice;
`musicTrackStarted`/`musicTrackEnded` are music with
`alsoRequires: ['voice']` (they are registered only where the shared voice
stack is served); the 📋 issue-capture
reaction is github.

Seventeen interaction families in `apps/bot/events/interactionCreate.js`,
keyed by the second `_`-separated token of the customId: `tavern` and
`tavernretire` → tavern, `projectinvite` → projects, `sbxreq` → sandbox,
`intaction` → core dispatch with the owner resolved per `pending.type`
(github or cursor) at runtime, the music play/queue/library controls →
music, everything else (`parlorinvite`, `accessreq`, `friendreq`,
`search`, `forgetme`) core. Defect for #318: the music library's
`clear_search_button` collides with the `search` approval family under
that router.

#### How the gates are enforced (#318)

Every gate below asks `features/gate.js` (`surfaceActive` /
`requireSurface`), which applies the enforcement rule from
`documentation/feature_state.md` ("Reported versus enforced"): with no
usable `data/features.json` and no `GOOBSTER_FEATURE_<ID>` override nothing
is refused, so a default install loads, deploys, starts and answers exactly
as before. The state is read once when the bot process starts; listeners and
the command set change on restart, interactions are refused live.

- Commands and context menus: `commandDeployment.listCommandFiles` is the
  one lister, `featureCommandFilter` the one filter. `apps/bot/index.js`
  (load) and `apps/bot/deploy-commands.js` (deploy) both use it, so what
  Discord shows and what the process answers cannot disagree. A filtered
  file is never `require()`d (its top-level imports do not run). A command
  file the inventory does not claim (a self-hoster's own command) keeps
  loading and deploying while no usable `data/features.json` is in force,
  with a log warning that names the file and says it is **not claimed by the
  feature inventory**; once a state file is in force it fails closed and the
  log gives that same accurate reason. The inventory spec still fails CI for
  an unclaimed command file inside the repository. The
  deploy hash (`data/.command-deploy-hash`) covers the payload, the targets
  and the served feature set (`activeFeatureIds`, enforcement view), so
  turning a feature on or off re-syncs Discord even when the payload is
  unchanged; because the served feature set is part of the hash, every
  installation redeploys its slash commands once after upgrading to the
  release that introduces it (accepted). The Activity's Entry Point
  ("Launch") command is deliberately *not* removed when `discordActivity`
  is off: Discord only accepts that as a separate delete the deploy script
  cannot undo on re-enable (the operator would have to recreate it in the
  developer portal), and disabling is non-destructive. The button stays and
  the Activity it opens answers with the gated 404. A slash command, autocomplete or context menu Discord still
  holds for a filtered file is answered ephemerally with "That feature is
  not available on this installation." (autocomplete gets an empty list)
  before any handler runs.
- Components and modals: `interactionCreate.gateComponentInteraction`
  resolves the customId to its inventory row - the full id first through
  the `collector:<id>` keys (so `clear_search_button` is left to the music
  paginator's own collector and never parsed as the `search` router token),
  then the second `_` token - and refuses an off owner before any handler
  or write. `intaction` buttons resolve their owner from the pending
  action's `type` (`github-issue` → github, `agent-launch` → cursor), and
  that read is skipped when neither owner is enforced off. Deny / Cancel on
  a sandbox request (`sbxreq`) or an integration action (`intaction`) is
  let through whatever is off, because it only resolves the pending row and
  executes nothing, so those rows can always be cleared (a table of
  resolve-only actions in `interactionCreate.js`, one mechanism for both
  tokens); Approve / Confirm is refused.
- Runtime steps: `coreRuntime.step(name, fn, { feature })` never invokes
  the callback of an enforced-off owner and records
  `{ status: 'skipped', reason: 'feature', feature }` in `runtime.report`
  (also `runtime.featureSkipped`), distinct from `paused`, `declined` and
  `failed`. The bundled core steps always start; `applyBundledFeatureGates`
  switches off their feature branches on the instance (automation's project
  trigger poll, heartbeat's agent proposals, the attention generators that
  read `observatory_jobs`, `spitball_expeditions` and `project_missions`).
  `automationService.executeWheel` refuses at the top when the wheel command
  is off. An unclaimed step fails closed without taking the process down.
- Startup side effects: `serviceManager.voiceService` is a lazy getter; with
  voice enforced off it returns an inert `InactiveVoiceService` and the
  voice stack (MusicService, ffmpeg probe, memory monitor, SpotDL,
  ElevenLabs) is never built. In `apps/bot/index.js` voice initialisation,
  the `voiceStateUpdate` listener, the `musicTrackStarted`/`musicTrackEnded`
  presence listeners, the 📋 issue-capture reaction and the
  `playTrack`/`nickname`/`speak` tool adapters follow the same snapshot.
- The `discord` adapter (Phase 1 behaviour): `apps/bot` is the Discord
  client, so with `discord` off in `features.json` it still logs in and
  builds `LocalGateway`; only the internal gateway API (`/internal/gateway/*`,
  not mounted) and the surfaces that list `discord` as an owner or
  `alsoRequires` honour it. What stops Discord outright is the adapter
  switch (`discord.enabled` / `GOOBSTER_DISCORD_ENABLED`, read by
  `config/discordConfig.js`), which selects the standalone `apps/api`
  runtime with `DisabledGateway` instead of the bot. Making the bot
  process refuse to log in is not a one-line change that keeps legacy
  parity, so it is not done in Phase 1.
- `messageCreate`: gates `#06` (cursor) and `#10` (gba) are skipped when
  their owner is off; the other ten and their order are untouched
  (`// messageCreate#NN` markers, asserted by the spec).
- The Activity casino: the Activity transport is `discordActivity`, but
  everything it carries over its socket is the table-game protocol
  (`join`, `sit`, `action`, the bot invite, balances) and its one content
  route is the casino lounge music, so those two claims carry
  `alsoRequires: ['gambling']` (`/api/activity/ws` in `wsPaths`, `GET
  /api/activity/music/casino` in `routeRules`; `economy` off blocks them
  through `gambling`'s hard dependency). The auth and client-file routes
  stay `discordActivity` alone. `apps/bot/web/server.js` builds
  `TableManager` and `BotPlayer` and replays the escrow journal
  (`recoverFromJournal`) only when the `table_games` table claim is
  available (owner `gambling`, also `discordActivity`); otherwise no wager
  can move points, the socket is never attached (its upgrade is a plain
  404) and the handler refuses any table message with the standard
  `FEATURE_UNAVAILABLE` frame.

- Service seams: a door can be bypassed by a caller that reaches a service
  through a route or loop owned by another feature, so the work itself
  refuses with `features.enforcedOff` (a no-op without a state file or
  override). `observatoryService` (`executionEnabled` and `_requireEnabled`,
  so run, resume, render and fetch data) refuses with `FEATURE_UNAVAILABLE`
  and inherits a sandbox or projects that is off through the dependency
  rule; `sandboxService.enabled` and `run` follow `sandbox`;
  `spitballExpeditionService` (`enabled`, `createExpedition`, so no orphan
  row) and `spitballExpeditionRunner` (`kick`, `_runLoop`) follow
  `expeditions`. Mission `job` and `expedition` steps refuse before they are
  claimed (the step stays `READY`) and project trigger `run_script`, `render`
  and `fetch_data` fail with `FEATURE_UNAVAILABLE`; both write one
  `work_failures` row carrying the code and the step or trigger id, never the
  script. A refused cron trigger fire or wheel automation is claimed so it
  waits for its next time, but `lastRun` and `automation-ran` are not
  written; the wheel claim order is decided before `markRan`. The personal
  heartbeat reconciles mission steps only while `missionReconcile` is
  available, and a reconcile never re-queues or kicks an expedition while
  `expeditions` is off. The exchange risk sweep skips prediction settlement
  while `gambling` is off (`marketsSkipped: 'gambling'`). `pushService`
  and `mailService` read `enabled` as legacy AND not enforced off; nothing is
  pushed or mailed while off, stored subscriptions stay and
  `pushService.unsubscribe` keeps working. `VoiceService.initialize` builds
  `MusicService` (which probes ffmpeg) and `AmbientService` only while
  `music` is available. `followedSourceService.prepareResearch` refuses
  before it creates an expedition.

Specs: `tests/featureGatingCommands.test.js`,
`tests/featureGatingRuntime.test.js` and `tests/featureGatingServices.test.js`
(the service seams, on the live config modules; no-file baseline equals the
unfiltered walk, env-override-only filtering, one-feature-off loops over
every manageable feature, standalone/paired/paused→resume shapes, a boot
harness that spies on listeners, the loader and the adapters).

### M1 - Mail

Mail is consumed only by identity (`nativeAuthService.js`, `appContext.js`);
it imports no identity code itself. `emailEnabled()` is
`identity.nativeLogin && mailService.enabled && Boolean(baseUrl)`, and
`registrationMode()` downgrades `identity.registration === 'open'` to
`invite` with a warning when mail is unavailable. Mail-dependent routes:
`POST /api/app/auth/signup`, `/verify-email`, `/forgot`, the
already-registered notice, `PUT/DELETE /api/app/account/email` and
`/resend`, `POST /api/app/admin/mail/test`. Not mail-dependent: operator
invitations (`createInvite`), the operator-issued recovery link
(`POST /api/app/admin/accounts/:id/recovery`), Inbox, push, friends.

Rule for the manager (#324): refuse disabling `mail` while
`identity.nativeLogin && identity.registration === 'open'` (sign-up needs
verification); when verified addresses exist but registration is `invite`,
**warn** rather than refuse, because the operator recovery link stays
available. Mail is never a hard dependency of another feature.

## Legacy switches and fresh-install defaults

Today's effective switches, per feature, as `legacySwitches` records them
(no behaviour changes here; this is what "no `features.json`" preserves):

| Feature | Switch today | Default |
|---|---|---|
| `discord` | `discord.enabled` / `GOOBSTER_DISCORD_ENABLED`, else `token` present | on when a token is configured |
| `push` | `webapp.push.enabled` / `GOOBSTER_WEB_PUSH_ENABLED`, VAPID keys | on; unavailable without keys |
| `mail` | derived from provider presence (SMTP config), no `mail.enabled` | on when configured |
| `music`, `voice`, `tavern`, `economy`, `exchange`, `gambling`, `knowledge` | none | always on |
| `gba` | `gbaRun.enabled === true` | off |
| `projects` | `projects.enabled` / `GOOBSTER_PROJECTS_ENABLED` | on |
| `observatory` | `observatory.enabled` / `GOOBSTER_OBSERVATORY_ENABLED` (needs sandbox) | off |
| `sandbox` | `sandbox.enabled` / `GOOBSTER_SANDBOX_ENABLED` | off |
| `mcp` | `mcp.enabled` / `GOOBSTER_MCP_ENABLED` | off |
| `expeditions` | `spitball.enabled` / `GOOBSTER_SPITBALL_ENABLED` | on |
| `github` | `GITHUB_WEBHOOK_SECRET` / `github.webhookSecret` present (receiver); token for API | on when configured |
| `cursor` | `CURSOR_WEBHOOK_SECRET` / `cursor.webhookSecret` present; API key | on when configured |
| `screenVision` | `screenVision.enabled === true` | off |
| `discordActivity` | `activity.enabled === true` | off |

Reconciliation with #261: its row-presence migration rule ("disable a
feature whose tables are empty") is **replaced** by ADR 0013's rule. An
installation without `data/features.json` behaves exactly as today and the
switches above decide. The first explicit write seeds `features.json` from
those effective values. An empty table never disables anything.

Explicit new installations use the #261 preset: `economy`, `exchange` and
`gambling` **off**; everything else active. Enabling `gambling` records an
operator attestation row in `operator_audit`. "Active" in the preset does
not mean "configured": `mcp`, `sandbox`, `observatory`, `screenVision`,
`discordActivity` and `gba` stay unconfigured until their config or keys
exist, and the status API reports the structured reason (#317).

Flagged for the owner, not resolved here: #261 lists GBA as default **on**
for new installs while `gbaRun.enabled` defaults off today and is absent
from `config.example.json`. The inventory records the #261 preset and this
note; if the intended fresh default is off, change one value in the preset
in #317.

## Core exceptions

These are always available and are never gated, whatever is disabled, by
decision 4 of ADR 0013:

- Privacy: `privacyService` erasure, `/forget-me`,
  `/what-do-you-know-about-me`, the `*_accessreq_*` and `forgetme_*`
  buttons, `/api/app/privacy/*`.
- Export: the `accountExports` step and `/api/app/account/export*`.
- Retention: `chatHistoryRetention`, `ledgerRetention`, memory retention
  windows.
- Inbox and notices: `inboxService`, `/api/app/inbox*`, the MCP
  `list_inbox`/`get_inbox_item` tools.
- Operator management: `/api/app/admin/*`, status, audit, backup and
  restore, pause and resume, the health endpoint.
- The feature-state read path itself (#317).

They read dormant tables of disabled features by design.

## Ambiguities and resolutions

| Surface | Candidates | Resolution |
|---|---|---|
| `messageCreate` mission-control gate | projects / cursor | cursor (it is the agent tracker) |
| `/generate`, `/search`, `/wrapped`, `/integrations`, reply-to-edit, `performSearch`, `generateImage`, `saveArtifact`, `searchNotion`, `readNotionPage`, `web_search` | core / a new feature | core; no new ids for image generation, Perplexity search, Notion or Wrapped |
| Ambience commands | music / voice | music (generated audio products) |
| Stock game command, tools, routes, tables | economy / exchange | exchange |
| `/speak`, `/voicechat`, `/setvoice`, `voiceStateUpdate` | voice / core | voice, `alsoRequires: discord` |
| Bundled steps `automation`, `heartbeat`, `personalHeartbeat`, `memoryConsolidation` | core / several | core, feature branches gated inside (#318) |
| `workshopPinMigration` | core / projects | projects |
| `knowledgeReflection`, `kg_*` tables | core / knowledge | core (memory graph) |
| `*_intaction_*` buttons | github / cursor | core dispatch, owner by `pending.type` |
| `clear_search_button` | music | music; collides with the `search` router token (defect, #318) |
| `observatory` tool | observatory / sandbox | observatory; action-aware reduced definition in #319 |
| `rollDice` | tavern / core | tavern |
| `eventContracts` | gambling / exchange | gambling, `alsoRequires: exchange` |
| `setNickname` | core / discord | discord |
| `search_knowledge` MCP tool | core / knowledge | knowledge |
| `/api/app/parlor/live`, `/api/app/parlor/*`, `manageParlor` | core / new Parlor feature | core |
| `/api/app/voice/*` | voice / core | voice |
| `/api/app/note-attachments*` | core / knowledge | knowledge (Spitball note images) |
| `GET /api/app/projects/:slug/parlor` | projects / core | projects |
| Run/render/job routes inside `routes/projects.js` | projects / observatory | observatory |
| `/api/app/mtga/*`, `/api/app/applets/*`, `/api/app/followed-sources/*` | core / projects / expeditions | core |
| `GET /api/activity/music/casino` | activity / music / gambling | discordActivity, `alsoRequires: gambling` (the lounge music is casino content) |
| `/app/liveAudioWorklet.js` | core / voice | core (shared) |
| Table games (`TableManager`, `BotPlayer`, `table_games`, `activity/games/*`) | activity / gambling | gambling, `alsoRequires: discordActivity` |
| `sharp` | core / exchange | core |
| `ffmpeg` | voice / music / observatory | voice owns it; observatory render is a soft consumer (`FFMPEG_MISSING`) |
| GBA fresh default | #261 on / legacy off | #261 preset recorded; flagged for the owner |

## Conformance and dormant data (#322)

Two specs are the Phase 1 merge gate. Both run on SQLite and Postgres (the
conformance spec is in the `core` CI group, the dormant-data spec in
`privacy`); fixtures shared with the per-surface specs live in
`tests/helpers/featureFixtures.js`.

### `tests/featureConformance.test.js`

Per-surface specs prove one gate with one feature at a time. This spec proves
the gates agree. For every profile the expected set is derived from the
inventory graph, never a hand list, and independently of `featureState.js`:

`served(claim) = claim.owner and every claim.alsoRequires are served`, where
a feature is served unless it is enforced off or one of its hard
dependencies is (the enforcement rule in `feature_state.md`).

| Profile | What it is | What it proves |
|---|---|---|
| `legacy-no-file` | No `features.json`, default config | Nothing is refused anywhere, even where a legacy switch reports a feature off. The loader set equals the unfiltered walk; every route is served. |
| `fresh-install` | `features.freshPreset()` written to the state file | The preset turns off `economy`, `exchange` and `gambling` only, and every other surface follows. |
| `core-only` | Every manageable feature `active: false` | Zero optional commands, steps, tools, MCP tools, routes and sockets; core chat, Inbox, privacy, export, settings, admin and MCP token revocation stay reachable. |
| `one-feature-off` x 20 | One profile per manageable id | The same invariant, one feature at a time, including the dependents the graph takes down with it. |
| Dependency combinations | `sandbox` off takes `observatory`; `knowledge` takes `expeditions`; `economy` takes `exchange` and `gambling`; `discord` takes `discordActivity` and every Discord-bound `alsoRequires` claim; `github` takes `cursor`; `economy` + `knowledge` together | Hard dependents and `alsoRequires` surfaces go off together. |
| `env-override-only` | `GOOBSTER_FEATURE_<ID>=0`, no file (sandbox, knowledge, economy, discord, github, gba + screenVision) | An override alone enforces, with the same results as the file. |

Each profile is checked at every surface kind the gates implement:

| Surface | Assertion |
|---|---|
| Central rule | `gate.requireSurface(kind, id)` agrees with the derived set for every claimed command, context menu, runtime step, event gate, interaction type, AI tool, MCP tool and socket path (blocker named). |
| Commands and context menus | `listCommandFiles` with `featureCommandFilter` returns exactly the served keys; unclaimed files are failed closed. |
| Runtime steps | `startCoreRuntime` reports exactly the served steps; a skipped step's marker never appears; no `fetch` and no model call. |
| Bot boot | `apps/bot/index.js` booted with fakes: `client.commands`, voice/music/issue-capture listeners, command-backed adapters and `startCoreRuntime` follow the profile. |
| AI tools | Discovery offers only served tools; `toolsRegistry.execute` refuses the rest with `FEATURE_UNAVAILABLE` and no database write, `fetch` or model call. |
| MCP | Tool and resource listings, `tools/call` and `resources/read` follow the claims; the `/mcp` mount answers 404 `FEATURE_UNAVAILABLE` for an enforced-off `mcp`; revoking a token works in every profile. |
| HTTP routes | `routeBlock` agrees with every mounted portal route (walked from the Express router stack); a real request to each refused route is 404 `FEATURE_UNAVAILABLE` with no handler, write or outbound call. Core operator, privacy, Inbox, export, settings and status routes answer 200 in every profile. |
| WebSocket upgrades | A real upgrade is 404 exactly for the unserved paths and never reaches a handler. |

Inventory negative checks, in the same spec:

- `requireSurface` throws `UNCLAIMED_SURFACE` for an unclaimed id of every gated kind.
- An unclaimed command file added to a copy of the commands directory is neither loaded nor deployed (the lister fails it closed) and is found by the claim check.
- With a claim removed (by replacing `inventory.ownerOf` inside the test; the real inventory is never touched) a runtime step, AI tool, MCP tool, interaction type, event gate and WebSocket path is found unclaimed and refused.
- An unclaimed route is found by the inventory check. The network edge deliberately never gates a path it does not recognise, so for routes this check, not the edge, is the safety net.
- `catalog.validateCatalog` rejects an unknown dependency, a cycle, `core` with dependencies, `core` as a dependency, a self dependency, a duplicate id and an unlisted descriptor; `features.write` rejects an unknown id, a `core` entry and a dependent without its dependency.
- Core ownership is explicit: every mounted core route is matched by a `core` entry in `routeRules`, and every core step, tool, command, MCP tool, socket path and static prefix is listed by name.

Mutation check: with the `toolsRegistry` refusal removed, or the `routeGate`
mount removed from `appApi.js`, the spec fails (AI tools in every refusing
profile; HTTP routes in every refusing profile).

### `tests/featureDormantData.test.js`

Two accounts (A and B) are seeded across 39 tables owned by economy,
exchange, gambling, Tavern, music (Song Studio), push, sandbox, Cursor,
GitHub, integrations, Screen Vision, MCP, projects, Observatory and
expeditions, plus memories with vectors and old and new ledger rows. Every
manageable feature is then turned off through a state file, and the real
services run:

- the state really refuses every optional feature, the runtime starts with none of their steps, and no feature worker, tool, `fetch`, model call, sandbox run, expedition start or Web Push send happens;
- `privacyService.auditUser` and `buildUserReport` list both accounts' dormant rows;
- `AccountExportService` builds a real archive that carries A's rows only;
- retention sweeps still prune what retention owns (old `resource_events`) and leave the dormant rows byte-identical;
- an off then on round trip with no privacy or retention action leaves every row unchanged;
- `forgetUser(A)` with the features off erases A everywhere, anonymises (keeps) guild-wide rows, leaves no vector orphan, keeps the ledger rows with the actor nulled, and leaves B byte-identical, before and after the features come back on.

A seeded-table consistency test fails when a feature-owned table with a
person-shaped column is neither seeded nor explained in the spec's
`NOT_SEEDED` map.

### Reach gaps closed

| Table | Service | How |
|---|---|---|
| `agent_runs` | `privacyService`, export | Deleted on erasure (they hold the person's prompt); counted in `auditUser` and the report; exported. |
| `pending_integration_actions` | `privacyService`, export | Rows the person requested are deleted; `resolvedBy` is cleared where they resolved someone else's; counted; exported. |
| `integration_audit` | `privacyService`, export | Guild audit record: the row stays and `userId` is nulled; counted; exported. |
| `repo_watches` | `privacyService`, export | Guild record: `createdBy` nulled; counted; exported. |
| `screen_vision_clients` | `privacyService`, export | Pairing deleted (a bearer credential) and the live session and pairing codes dropped; exported without the token hash. |
| `kg_reflection_runs.requestedBy` | `privacyService` | Nulled on erasure (found by the dormant-data table check); counted. |
| `prediction_markets.createdBy`, `tavern_adventures.createdBy` | `auditUser` | Attribution was already nulled on erasure; it is now counted too. |
| Economy, exchange, Tavern, Song Studio, push, friends and DMs, `user_integrations`, sandbox | account export (`accountExportData.js`) | The person's own rows are exported whether or not the feature is on; secrets (push keys, integration tokens, token hashes) never are. See `user_settings.md`. |
| Push delivery | `pushService.notify` | With `push` enforced off nothing is sent (an Inbox delivery used to attempt Web Push and bump `failCount`); stored devices stay. |

Left open, with the reason:

- GBA has no per-person table. `gba_run_clients` is one pairing per guild channel and `gba_run_milestones` is guild-level text, reached only by the `/forget-me` name-mention review pass. There is nothing person-keyed to export or erase.
- The MTGA deck library is core (not feature-gated) and is erased by `/forget-me`; the export keeps excluding it (the existing archive policy: decks copy out verbatim from the Decks room).
- `sandbox_packages` is shared host state (a hash-pinned overlay every user's runs rely on). The export lists only rows the person requested, and erasure nulls `requestedBy`/`approvedBy` attribution; deleting the package would change other people's sandbox.
- `prediction_markets`, `tavern_adventures` and `tavern_adventure_log` are guild-wide game state: erasure nulls the person and keeps the row. They are not exported as the person's data, apart from their own adventure-log lines.
- `observatory_share_links` tokens are a bearer credential and are never exported (the project they open is).

### Loaded but not executed when off

"Code may still load" is the Phase 1 rule: the gates stop execution, not
`require()`. The spec records, per feature module, the first entry point that
still requires it, once with every optional feature off and once in the legacy
(nothing off) walk, by running `tests/helpers/loadProbe.js` in a child process
so Jest's module registry does not hide anything. It reports and does not
fail, except that with everything off nothing may be reached through the
command loader or the runtime. The table is printed in the test output:

```
Loaded but not executed when off (entry point that first required the module; "-" = not loaded)
feature       module                                  all off         legacy (nothing off)
economy       services/economyService.js              portal          toolsRegistry
exchange      services/exchange/index.js              -               -
exchange      services/exchange/riskEngine.js         -               commands
exchange      services/stockPortfolioService.js       portal          commands
gambling      services/exchange/wheelService.js       -               commands
gambling      services/exchange/predictionService.js  portal          commands
tavern        services/tavern/tavernService.js        -               commands
tavern        services/tavern/interactionHandler.js   -               commands
music         services/voice/musicService.js          -               commands
music         services/studioSongService.js           portal          portal
voice         services/voice/index.js                 -               commands
voice         services/voice/elevenLabsTTSService.js  -               commands
sandbox       services/sandboxService.js              toolsRegistry   toolsRegistry
observatory   services/observatoryService.js          toolsRegistry   toolsRegistry
projects      services/projectService.js              toolsRegistry   toolsRegistry
projects      services/projectTriggerService.js       toolsRegistry   toolsRegistry
expeditions   services/spitballExpeditionRunner.js    portal          portal
knowledge     services/knowledgeGraphService.js       toolsRegistry   toolsRegistry
github        services/githubService.js               -               commands
cursor        services/cursorAgentService.js          -               commands
screenVision  services/screenVisionService.js         -               commands
gba           services/gbaRunService.js               -               commands
push          services/pushService.js                 portal          portal
mcp           mcp/http.js                             -               -
```

Reading it: with every feature off the command loader and the runtime load
none of these modules (the point of #318). What is still loaded is the
module graph the AI tool registry (`toolsRegistry` requires sandbox,
observatory, project and knowledge services) and the portal context
(`createWebAppContext` requires economy, stock portfolio, prediction, Song
Studio, expedition runner and push services) import at the top. Those are
what reduced-payload packaging (Phase 3) must make lazy before an excluded
feature's files can be absent; `scripts/smoke-require.js` stays a full-source
smoke.

### Rooms, tutorials and self-docs (#321)

The same 35 profiles check the portal surfaces, which act on the *reported*
state (`features.isActive`) and so show with no state file exactly what the
legacy flags showed: a room or nested view is available in `rooms.cjs` (and a
deep link is explained by `routeUnavailability`) exactly when every feature
it requires is reported active, and its `requires` names the same features
as the inventory claim; a tour is listed available by
`tutorialService.tutorialAvailability` on the same rule, while
`gate.requireSurface('tutorial', id)` refuses exactly the tours whose claim
is not served (the enforcement rule, like every other surface); and the
self-docs corpus is never hidden - every seeded doc is listed in every
profile, and a doc tagged `feature:<id>` carries an availability note
exactly when that feature is reported inactive.

## Known gaps carried to later issues

Recorded as `knownGaps` in `inventory.js` so they are not lost:

- #318: the `intaction` router token serves both github and cursor
  actions, so its owner is resolved from `pending.type` at runtime.
  (Fixed since the first audit: command gating, lazy `VoiceService`, the
  `step()` feature parameter and the `clear_search_button` collision.)
- #319: MCP enablement is boot-time only and the `observatory` tool needs
  an action-aware reduced definition. (`toolsRegistry.execute()` and the
  MCP brief tools and resource are gated.)
- #321 (closed): the tutorial catalog now declares `knowledge.research`
  (expeditions), `projects.runs` (projects and observatory) and
  `trading.basics` (exchange and discord), and an unmet tutorial is
  reported unavailable instead of omitted. See
  [portal_navigation.md](portal_navigation.md#feature-availability).
- #322: closed. The reach gaps (`screen_vision_clients`, `agent_runs`,
  `repo_watches`, `integration_audit`, `pending_integration_actions` for
  erasure; economy, exchange, tavern, studio, push, friends and DMs,
  `user_integrations` and sandbox for export) are fixed and pinned by
  `tests/featureDormantData.test.js`; what is deliberately not per-person
  (GBA, the MTGA deck library, `sandbox_packages`) is explained under
  "Conformance and dormant data (#322)".
