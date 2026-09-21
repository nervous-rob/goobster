# Independent runtime and delivery

Goobster runs without Discord. This document describes what that means
mechanically: the Discord adapter switch, the assistant identity that
exists with it off, the in-app **Inbox** that unattended work lands in, how
the schedulers start in every process shape, how people find each other on
an installation with no Discord friends list, and what a Discord-specific
feature says when Discord is not there. It is Increment C of the
[shared-instance plan](shared_instance_product_spec.md#9-implementation-sequence)
(spec §6, *Operation without Discord*).

The one-sentence version: **Discord is a transport, not a prerequisite.**
The portal, chat, memory, tasks, projects, attention, and delivery all work
with the adapter switched off; only Discord-specific actions (server scopes,
the Exchange, "Connect Discord") report the integration as unavailable, and
they say so specifically.

## The Discord adapter switch

`packages/core/config/discordConfig.js` answers one question for the whole
process: *is Discord part of this installation?*

| Setting | Meaning |
|---|---|
| `GOOBSTER_DISCORD_ENABLED` (env) / `discord.enabled` (`config.json`) | Explicit switch. `0`/`false`/`off` turns the adapter off even when a token is present. |
| neither set | Inferred: on when `config.json` has a non-empty `token`, off otherwise. |

`discordConfig.enabled` is read wherever a surface is Discord-specific;
`discordConfig.disabledReason` is the sentence the host sees
("No Discord bot token is configured." / "Discord is switched off for this
installation (discord.enabled = false)."). Nothing else in core forks on
"do we have Discord" - it asks this module or, at a call site that already
holds a gateway, checks `gateway.kind`.

### Two gateway states, two error codes

The gateway seam (`packages/core/gateway/`) distinguishes *unreachable* from
*absent*:

| Gateway | When | Reads | `sendDm` / `sendToChannel` | Error |
|---|---|---|---|---|
| `LocalGateway` / `RemoteGateway` with the bot down | Adapter on, bot offline or the internal API unreachable | throw `GatewayUnavailableError` | `{ ok: false }` | `503 BOT_OFFLINE` - transient, "try again" |
| `DisabledGateway` (`kind: 'disabled'`) | Adapter off | throw `GatewayDisabledError` (a subclass) | `{ ok: false, error: 'DISCORD_DISABLED' }` | `503 DISCORD_DISABLED` - permanent, "this installation is not connected to Discord" |

`isGatewayUnavailable(error)` is true for both (existing degrade paths keep
working unchanged); `isGatewayDisabled(error)` picks out the permanent
case. `utils/webGuildAccess.requireGuildMember` maps them to `BOT_OFFLINE`
and `DISCORD_DISABLED` respectively, and answers `403 NO_DISCORD_IDENTITY`
for a principal that has no Discord subject before it ever asks the
gateway. The client treats the three differently: offline is a retry,
disabled is an explanation, no-identity is a pointer to Settings → Account.

`RemoteGateway.botUser()` and `DisabledGateway.botUser()` both fall back to
the assistant identity below, so nothing that only needs *an author id for
Goobster* ever blocks on Discord.

## The assistant identity

`services/assistantIdentity.js` gives the assistant a stable identity that
is scoped to the installation, not to a Discord bot account:

- `assistantUser()` → `{ id: 'asst_<installationId>', username: identity.assistantName, bot: true }`.
- `resolveAssistantUser({ client, gateway })` → the connected bot's Discord
  user when there is one, the installation identity otherwise. Web chat
  (`webChatService.startTurn`) authors every turn with whatever this
  returns; it no longer throws `BOT_OFFLINE`.
- `isAssistantId(id)` recognises the synthetic id. The migration report
  (`identityService._inventory`) skips it - it is not a person and never
  gets a principal.

`identity.assistantName` (`GOOBSTER_ASSISTANT_NAME`, default `Goobster`) is
the name on every surface with Discord off; with Discord on, the bot
account's username still wins for that transport. `GET /api/app/me` always
carries `assistant: { id, name }`; `bot` is kept for compatibility and is
`null` when Discord is not connected.

## The Inbox

`inbox_items` (`db/schema.sql`) and `services/inboxService.js` are where
the result of anything Goobster does *for* one person while they are not
looking ends up: a due reminder, a scheduled task's reply, a watch that
fired, an attention notice, an invitation, a project or expedition
completion.

### The delivery contract

Producers call `inboxService.deliver({ userId, kind, title, body, source,
link, attachments, dedupeKey, discord })` **once per result**:

- The row is written first, durably, and is the source of truth. A closed
  DM, a bot that is down, or an installation with no Discord adapter
  changes what the person sees in Discord, not whether the result exists.
- `discord` is the optional echo: `{ gateway, payload }` (or `{ client }`)
  sends the same result to the person's Discord DMs **when they have a
  Discord subject** (`identityService.discordSubjectFor`) and the adapter is
  on. The outcome is bookkeeping on the item - `discordStatus` is
  `skipped` | `sent` | `failed`, with `discordError` / `discordSentAt` -
  never a reason to re-run the work or to throw at the caller.
- `dedupeKey` (unique per user) makes re-derivation idempotent: a producer
  that may compute the same result twice gets `{ created: false }` and no
  second echo. One-shot events (invitations) pass none.
- `deliver()` never throws for a delivery problem; it publishes an `inbox`
  portal event so an open tab pings and its badge updates.

`kind` is one of `reminder`, `task`, `watch`, `notice`, `invite`,
`project`, `expedition`, `system`. `link` is a portal path (`/tasks`,
`/parlor`, `/observatory`) the **Open →** button follows. `attachments` are
`{ url, name }` pairs re-served by the existing file route.

### Where deliveries go now

The channel id `inbox:<userId>` (`inboxService.inboxChannelId`) marks a
follow-up, automation, or watch whose destination is the inbox rather than
a Discord channel. `webTaskService`, the `manageAutomations` / `watchFor`
tools on web turns, and `observatoryService`'s job notifications all file
their rows under it.

| Producer | Path | Inbox item | Discord echo |
|---|---|---|---|
| Due follow-up, personal scope | `followupDeliveryService.deliverDue` (runs from the core runtime in every process; the bot's heartbeat delegates to it) | `reminder`, body phrased from the note (model call when a provider exists, the note itself otherwise) | DM when the person has a Discord subject |
| Due follow-up, guild channel | same service | none | posts to the channel; needs the live client, otherwise waits |
| DM-scope automation / web-created task | `automationService.executeInboxAutomation` → `unattendedTurnService.run` | `task`, the turn's reply plus attachments | DM |
| Personal watch fired | `attentionWatchService._runInboxTurn` → `unattendedTurnService.run` | `watch`, with the evidence in the body | DM |
| Attention contact (nudge, notice) | `attentionService._contact` | `notice` | DM |
| Project / Parlor invitation | `projectService.invite` / `parlorService.invite` | `invite`, link to the pane with Accept/Decline | DM with buttons |
| Observatory job finished | `observatoryService` files a follow-up under the inbox channel | `reminder` via the follow-up path | DM |

`services/unattendedTurnService.js` is the one way to run an agent turn
whose answer is addressed to a person rather than a channel: it builds the
pseudo-interaction with `sourceDescription`, runs the normal
`handleChatInteraction` pipeline (full tool registry, bounded agent loop),
collects the reply and attachments, and calls `deliver()`. Automations and
watches both use it, so their behaviour cannot drift apart.

### The portal side

- `GET /api/app/inbox` (`?unread=1`, `?archived=1`), `GET /api/app/inbox/:id`,
  `POST /api/app/inbox/:id/read` (`{ read: false }` puts it back),
  `POST /api/app/inbox/read-all`, `POST /api/app/inbox/:id/archive`. Items
  are the signed-in person's own; the routes never cross users.
- The **Inbox** room (`apps/web/src/rooms/InboxRoom.tsx`): Open / Unread /
  Archived views, expand to read, Open →, mark read/unread, archive. The
  sidebar badge and the Home card come from `me.inbox.unread` and the home
  overview; an `inbox` portal event pings the tab (unless it is already on
  the Inbox) with a toast that opens it.
- Tasks show each row's destination (`→ Inbox`, `→ Discord DM`,
  `→ server channel`) from `webTaskService.listTasks().delivery`.

### Privacy

Inbox items are per-user data. `/forget-me` deletes them
(`inboxService.forgetUser`, called from `privacyService.forgetUser`),
`auditUser` counts `inbox_items`, and `/what-do-you-know-about-me` reports
the count and how many are unread.

## The core runtime

`packages/core/runtime/coreRuntime.js` is the one startup order for
everything that ticks, sweeps, or listens, whichever process hosts it:

```js
const runtime = await startCoreRuntime({ client, gateway, logger, schedulers });
// ... later
await runtime.stop();
```

- **Always:** event bus, chat-history retention, self-docs seeding, workshop
  pin migration, Observatory resume, mission reconcile, project-trigger
  catch-up.
- **Schedulers** (`schedulers: true`): automations, follow-up delivery,
  personal heartbeat (attention), Spitball expeditions, memory
  consolidation, knowledge reflection. Every pass that must not double up
  across processes takes `db.withSingletonLock(...)`.
- **Discord-bound workers** only with a live client: the guild heartbeat,
  the agent tracker, the monologue, the exchange risk engine. Without one
  they are logged as *skipped*, not failed.

`apps/bot/index.js` calls it on `ClientReady` with the discord.js client;
`apps/api/index.js` calls it with `client: null` and the gateway for its
mode. The log line `[runtime] Started: … | Skipped: …` says what this
process is running.

### `apps/api` modes

`GOOBSTER_RUNTIME_MODE` selects the mode; unset, it follows the adapter
switch.

| Mode | When | Gateway | Database | Schedulers |
|---|---|---|---|---|
| `paired` | Adapter on: the split deployment's web backend next to a running bot | `RemoteGateway` → the bot's `/internal/gateway/*` (`GOOBSTER_GATEWAY_URL`, `GOOBSTER_INTERNAL_TOKEN` required) | Postgres required (`GOOBSTER_DB_URL`); SQLite refused | Off - the bot runs them (`GOOBSTER_RUNTIME_SCHEDULERS=1` to run them here too) |
| `standalone` | Adapter off: the whole assistant with no Discord | `DisabledGateway` | SQLite or Postgres - it is the only process | On (`GOOBSTER_RUNTIME_SCHEDULERS=0` to disable) |

`GET /health` reports `mode` and `discord: connected | unreachable |
disabled`. To run the assistant on a Raspberry Pi with no Discord at all:

```bash
# config.json: "webapp": { "enabled": true, "publicUrl": "https://…" }, no "token"
GOOBSTER_API_PORT=3100 node apps/api
```

The `lite` profile (`apps/bot` serving the portal in-process) is unchanged
and still needs a bot token, because that process *is* the Discord adapter.

## Native people discovery

An installation with no Discord has no friends list and no shared servers,
so `friendService.listInvitable` gained a third source that exists
everywhere: **members of this installation**.

- `identityService.searchPeople({ actorId, q, exclude, limit })` matches the
  start of a display name or login name among *active* accounts, excluding
  the caller, and answers nothing at all to a caller whose own account is
  not active. It is **query-only** - there is no way to browse the roster -
  and returns `{ id, name }` only (the display name; the login name stands
  in only for an account that never set one): no email, no role, no linked
  providers, no presence. Discovery is a separate permission from presence
  and from profile detail; this returns neither.
- `identityService.describeMember(principalId)` resolves an exact principal
  id to `{ id, name }` for the invite confirmation.
- The People picker (Observatory and Parlor) shows members with a
  `member` badge and "member of `<installationName>`"; Discord friends and
  server mates still appear when Discord is connected. Pasting an id works
  for any principal shape.
- `GET /api/app/people?q=` is the same picker for the web client.

Invitations (`projectService.invite`, `parlorService.invite`) accept any
principal id (`identityService.isPrincipalId`), resolve the name through
Discord for snowflakes and through `describeMember` for native ids, and
deliver through the inbox with the Discord DM as the echo.

## What degrades, and how it says so

| Surface | With Discord off |
|---|---|
| Chat (Study), memory, Library, Workshop, Tasks, Projects, Parlor, Spitball, Noticed, Inbox | Work. Authored by the assistant identity; results reach the Inbox. |
| Server (guild) scopes | Not offered (`me.scopes` has the private scope only). |
| Exchange | Nav entry hidden; the room explains it is a Discord-server game (`DISCORD_DISABLED`). A native account on a Discord-connected installation gets `NO_DISCORD_IDENTITY` and a pointer to Connect Discord. |
| Settings → Account → Sign-in methods | "Connect Discord" hidden with the note *This installation is not connected to Discord.* |
| Login, Home, Study hints | Copy drops the "same brain as Discord" framing. |
| Music, voice, Activity, slash commands | Discord features; not present in the standalone process. |

The rule for new code: a Discord-specific action reports **which**
integration is missing and **what to do** (`DISCORD_DISABLED` with the
host's reason, or `NO_DISCORD_IDENTITY` with the Settings pointer). It
never makes Chat or Projects say "bot offline", and it never fabricates a
Discord id for a native principal.

## Configuration summary

| Key | Default | Meaning |
|---|---|---|
| `discord.enabled` [`GOOBSTER_DISCORD_ENABLED`] | inferred from `token` | Whether the Discord adapter is part of this installation. |
| `identity.assistantName` [`GOOBSTER_ASSISTANT_NAME`] | `Goobster` | The assistant's name where no bot account supplies one. |
| `GOOBSTER_RUNTIME_MODE` | inferred | `paired` or `standalone` for `apps/api`. |
| `GOOBSTER_RUNTIME_SCHEDULERS` | on in standalone, off in paired | Run the core schedulers in the api process. |
| `GOOBSTER_API_PORT` | `3100` | The api process's listen port. |

## Exercising it headless

`tests/independentRuntime.test.js` is the spec in executable form, on both
engines: the disabled gateway's two error codes, the assistant identity,
`deliver()` (echo statuses, dedupe, list/read/archive, erasure), a due
follow-up landing in the inbox with no client, native people search and the
`member` source, an invitation by native principal id, the `/me` and inbox
routes, `DISCORD_DISABLED` / `NO_DISCORD_IDENTITY` on the Exchange and guild
scopes, task creation targeting the inbox, `startCoreRuntime` with and
without a client, and the api's mode resolution and `/health`.

For a live look without a token: `GOOBSTER_DISCORD_ENABLED=0
GOOBSTER_DB_PATH=/tmp/demo.sqlite GOOBSTER_API_PORT=3100 node apps/api`
with `webapp.devMode: true`, then open `http://localhost:3100/app/`. Insert
a `followups` row under `inbox:<userId>` with a past `dueAt`; the ticker
delivers it within a minute and it appears in the Inbox.
