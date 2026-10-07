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
`/exchange/*`, `/voice/*`, `/studio/*` (music), `/push*`, `/mcp*`, the
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
`musicTrackStarted`/`musicTrackEnded` are music; the 📋 issue-capture
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
| `GET /api/activity/music/casino` | activity / music / gambling | discordActivity (transport asset) |
| `/app/liveAudioWorklet.js` | core / voice | core (shared) |
| Table games (`TableManager`, `BotPlayer`, `table_games`, `activity/games/*`) | activity / gambling | gambling, `alsoRequires: discordActivity` |
| `sharp` | core / exchange | core |
| `ffmpeg` | voice / music / observatory | voice owns it; observatory render is a soft consumer (`FFMPEG_MISSING`) |
| GBA fresh default | #261 on / legacy off | #261 preset recorded; flagged for the owner |

## Known gaps carried to later issues

Recorded as `knownGaps` in `inventory.js` so they are not lost:

- #318: `toolsRegistry`-independent command gating does not exist; the
  command loader (`apps/bot/index.js`) and `collectCommandPayloads`
  filter nothing but `config*`; `serviceManager.js` constructs
  `VoiceService` at require time; `clear_search_button` router collision.
- #319: `toolsRegistry.execute()` has no feature gate; MCP enablement is
  boot-time only and the briefs tools/resource are unguarded by
  Expeditions.
- #321 (closed): the tutorial catalog now declares `knowledge.research`
  (expeditions), `projects.runs` (projects and observatory) and
  `trading.basics` (exchange and discord), and an unmet tutorial is
  reported unavailable instead of omitted. See
  [portal_navigation.md](portal_navigation.md#feature-availability).
- #322: `screen_vision_clients`, `agent_runs`, `repo_watches`,
  `integration_audit` and `pending_integration_actions` are not reached by
  `privacyService.forgetUser`; account export omits economy, exchange,
  tavern, studio, gba, push, friends DMs, `user_integrations` and sandbox
  data.
