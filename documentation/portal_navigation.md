---
title: "Portal navigation: rooms, canonical routes, and legacy aliases"
kind: reference
summary: The web portal's navigation contract - eight primary destinations (Home, Chat, Knowledge, Projects, Discussions, People, Activity, Tools) plus the account area, the room registry that drives the sidebar (or the top bar, a per-account layout choice) and active-room matching, registered room views (Activity's Inbox/Attention/Scheduled, Knowledge's Notes/Map/Research, People's Friends/Messages, Projects' per-project views under /projects/:owner/:slug/:view), canonical URLs, the older paths that still resolve, what a redirect preserves, the start-page preference, how a delivered attention notice is named from both Activity views, the per-account hidden-tool preference, and how server-written links should address the portal. Shipped behaviour (shared-instance Increment E, packages E1 through E5).
tags: [portal, navigation, routes, rooms, web, shared-instance, aliases, tutorials]
---

# Portal navigation

The portal is organised around what a person is doing, with the house room
names kept as secondary labels: **Chat** (the Study), **Knowledge**
(Spitball), **Projects** (the Observatory), **Discussions** (the Parlor),
**People** (Friends, Messages), **Activity** (Inbox, Attention, Scheduled)
and **Tools** (Music Lab, Trading game, Card decks), with **Home** as the
front door. Usage & limits, Settings
and the operator-only Host room form the account area in the sidebar footer.

Only the visible organisation changed. Internal ids (`observatory`,
`spitball`, `parlor`, `mission`), API paths under `/api/app/*`, SSE topics,
tool names, database tables and stored chat text are unchanged and must stay
that way - see the naming rule in
[the shared-instance plan](shared_instance_product_spec.md#3-information-architecture-and-vocabulary).

## The room registry

`apps/web/src/lib/rooms.cjs` is the single source of truth for rooms. Each
entry declares:

| Field | Meaning |
|---|---|
| `id` | Stable room id (`chat`, `knowledge`, `projects`, …). Tutorials, anchors and tests key on it, never on the visible name. |
| `name` / `secondaryName` | Descriptive label first, house name second ("Knowledge · Spitball"). |
| `path` | Canonical destination, relative to the `/app` base. |
| `group` | `primary` (sidebar), `tools` (cards under Tools), `account` (footer), `public` (share viewer). |
| `parent` | For specialist rooms: the primary entry that lights up (`tools`). |
| `atmosphere` | The `room-*` body class the stylesheet paints. |
| `requires` | The catalog feature ids the destination needs: `{ feature: 'projects' }`, `{ feature: ['exchange', 'discord'] }` (one id or a list), the older `{ discord: true }` (the `discord` feature), or `{ operator: true }` (the host role). A view (Knowledge → Research needs `expeditions`) declares its own. Availability is per installation: see [Feature availability](#feature-availability). A hidden room is not a forbidden one - a direct URL still resolves and explains itself. |
| `legacyIds` | Older room names (`study`, `noticed`, `mtga`, …) accepted by the `#room/id` hash scheme and the start-page preference. |
| `count` | Which badge the entry shows (`inbox` = Inbox unread count; `people` = pending friend requests plus unread direct messages, `me.people`). `roomBadgeCount(room, me)` in the typed façade is the one place that reads it. |
| `tutorials` | The stable tutorial ids from [the guided-tutorial spec](guided_tutorials_spec.md) that belong to this room - all 28, each listed exactly once. |
| `views` | Rooms with several views: Activity (Inbox, Attention, Scheduled), Knowledge (Notes, Map, Research) and People (Friends, Messages), each with its own path, optional secondary name and legacy ids; Projects' nine views (below), each with a path `segment` under a per-project detail path. `resolveRoomView(roomId, path)` names the view a path points at; `resolveActivityView` / `resolveKnowledgeView` / `resolvePeopleView` / `resolveProjectView` are the typed shorthands. |
| `detail` | Rooms whose views live under a per-item path: Projects declares `{ params: ['owner', 'slug'], defaultView: 'overview' }`. `resolveRoomDetail(roomId, path)` returns the item's params and view (the default when the segment is absent, `null` for an unknown segment); `detailPath(roomId, params, view)` - `projectPath()` in the typed façade - is the only way the client builds a project link. |

The sidebar (`shell/AppShell.tsx`), the active-room highlight, the body
atmosphere, Home's doors, the Tools cards (`rooms/ToolsRoom.tsx`), the
Activity strip (`rooms/ActivityRoom.tsx`), the Settings "Back to …" link,
the Knowledge strip (`rooms/knowledge/KnowledgeRoom.tsx`), the Appearance
start-page select and the legacy hash redirect all read from the registry. TanStack route definitions stay explicitly typed in
`apps/web/src/main.tsx`: the registry decides names and path equivalences,
never route parameters. `rooms.ts` is the typed ESM façade; the `.cjs` file
exists so `tests/portalRooms.test.js` can `require()` it.

## Feature availability

Which features an installation has is a fact about the installation, not
the person ([feature_state.md](feature_state.md); every feature and what it
owns is in [features.md](features.md)). The portal reads it once per session
from `GET /api/app/features` (the sanitized status: `active` and structured
`reasons` per feature, never a path, key or value) beside `me`, and keeps the
legacy `me.features` / `me.discord` booleans as a fallback when that request
fails, so navigation never blanks. With no `data/features.json` the reported
value equals those legacy switches, so a default installation renders as it
always has.

Rooms, nested views and tutorials declare the features they need as data
(`requires.feature`); `tests/featureGatingPortal.test.js` fails when a
declaration drifts from the feature inventory or the catalog. The helpers
live in `rooms.cjs` (backed by `featureStatus.cjs`) so Jest covers them:

| Surface | When a required feature is not active |
|---|---|
| Sidebar and Home doors | `isRoomAvailable` omits the room. |
| Nested views | `availableViews` omits the tab (Knowledge → Research needs `expeditions`). |
| Tools cards | `toolCards` keeps the card, marks it unavailable, says why in one sentence from the server's reason code (a dependency is named by its catalog title) and links to the docs page that explains it. |
| A deep link or old bookmark | `routeUnavailability` resolves the address to a "Not available on this installation" state **inside the shell** (the room name, the reason, a way back and the docs link). It is not a blank page, a redirect or an error toast; nothing failed. |
| Guided tours | Listed as unavailable with the reason, never launched, never marked complete; saved progress stays. See [guided_tutorials_spec.md](guided_tutorials_spec.md#availability). |
| Goobster's own docs | `consultDocs` annotates a doc about an inactive feature; see [self_knowledge.md](self_knowledge.md#feature-availability). |

Three states are never conflated: **available**, **unavailable on this
installation** (the host's state, above) and **hidden by this account**
(`appearance.hiddenToolRooms`, a preference that changes nothing about
availability and is not described as unavailable). Disabled is not deleted:
projects, notes, tour progress and settings stay in place and return when the
host turns the feature back on. A feature that was just switched off is
picked up on the next load (the status is cached for the session for a few
minutes); the server refuses its routes whenever the installation enforces
the state, so a stale client cannot reach a disabled feature.

## Canonical routes and aliases

| Destination | Canonical | Older paths that still work |
|---|---|---|
| Home | `/` | - |
| Chat | `/chat`, `/chat/:conversationId` | `/study`, `/study/:conversationId` |
| Knowledge | `/knowledge/notes`, `/knowledge/map`, `/knowledge/research` (`/knowledge` → Notes, keeping query and hash) | `/spitball`, `/library`, and `/spitball/<view>`, `/library/<view>` |
| Projects | `/projects` (list); `/projects/:ownerId/:slug/:view` (one project on one view; `/projects/:ownerId/:slug` → Overview, keeping query and hash); `/projects/:slug` (resolver, see below) | `/observatory`, `/workshop`, and the old `/observatory/{graph,search,people,events}` sub-pages (they rendered the same landing page); the view segments `mission`, `explorer` and `jobs` open Plan, Files and Runs; an unknown segment opens Overview |
| Discussions | `/discussions`, `/discussions/:conversationId` | `/parlor`, `/parlor/:conversationId` |
| People | `/people/friends`, `/people/messages`, `/people/messages/:threadId` (`/people` → Friends) | - (new room; the ids `friends` and `messages` are accepted by the hash scheme and the start-page preference) |
| Activity | `/activity/inbox`, `/activity/attention`, `/activity/scheduled` (`/activity` → Inbox) | `/inbox`, `/noticed`, `/attention`, `/tasks` |
| Tools | `/tools` | - |
| Music Lab | `/conservatory`, `/conservatory/<mode>` | unchanged |
| Trading game | `/exchange` | unchanged |
| Card decks | `/decks` | unchanged |
| Usage & limits, Settings, Host | `/usage`, `/settings`, `/settings/:section`, `/host`, `/host/features`, `/host/connections`, `/host/defaults`, `/host/installation` | unchanged; the Host pages (operators only) are described in `host_operations.md`; `/host/installation` hosts the Reconfigure, Repair and Uninstall journeys of `setup_wizard.md` |
| Shared conversation | `/share/:token` | unchanged (public, renders inside the shell without a session) |
| Documentation | `/docs` → `/docs/getting-started`, `/docs/:slug#section` | public, linked from the sidebar footer; generated from selected repository Markdown |
| Shared project dashboard | `/app/observatory/share/:token` | **server-handled**, never a SPA route - the registry excludes it so a public share is never swallowed by the Projects route |

Every alias is its own typed route whose only component redirects through
`canonicalPath()` with `replace`, so Back does not bounce. A redirect keeps:

- the resource id (`/study/42` → `/chat/42`);
- the query string and the hash (`/noticed?x=1#frag` → `/activity/attention?x=1#frag`);
- the settings return location - a shortcut opened from `/study` says
  "Back to Chat", one opened from `/noticed` says "Back to Activity ·
  Attention".

The pre-router `#room/id` hash scheme (`/app/#study/42`, `/app/#mtga`,
`/app/#expeditions`) still resolves through `legacyHashTarget()`.

## Knowledge

Knowledge opens on **Notes**. **Map** draws the same notes as a graph and
**Research** (Expeditions) is a nested view because a research run has
state a list does not. The scope select and the **Personal memory**
shortcut (to Settings → Memory & privacy) sit in the room header and apply
to every view. The About you / Facts / Memories views that used to be tabs
here moved to Settings, where retention, learning and deletion already
lived. What each view shows, and the saved-knowledge boundary behind it,
is [knowledge_and_memory.md](knowledge_and_memory.md) (package E2). A note
leaves this room by **Add to project…** / **Use in discussion…** on its
row, and an answer arrives from Chat by **Save as note**
([knowledge_and_memory.md](knowledge_and_memory.md#moving-a-note-into-shared-work),
package E4).

## Projects

`/projects` is the list. One project is addressed by **its owner and its
slug** - `/projects/:ownerId/:slug/:view` - because `observatory_projects`
is unique per owner, not globally: two people may both have
`emergence-study`, and a collaborator on both sees two projects with one
slug. The owner id is the principal id (a Discord snowflake or a `usr_…`
id). Selection and the active view live only in the URL, so refresh, Back
and Forward, bookmarks and Inbox links land on the same project and view.

The registered views, in tab order:

| View | Segment | Shows |
|---|---|---|
| Overview | `overview` (default) | The goal, the open plan and its next action, latest runs, outputs, owner actions. |
| Plan | `plan` (was `mission`) | The open plan - criteria, steps, approvals, evidence - and earlier plans. |
| Conversation | `conversation` | The project's shared discussion (the project parlor), also available docked beside any other view. |
| Knowledge | `knowledge` | The project's Spitball: map, notes, research. |
| Files | `files` (was `explorer`) | The workspace tree and versioned source assets. |
| Apps | `apps` | Rendered generated apps with the version picker. |
| Runs | `runs` (was `jobs`) | Every run, its status and provenance, cancel / resume. |
| People | `people` | Owner, collaborators, invitations (also a modal from the header). |
| Automations | `automations` | Triggers and their deliveries. |

`/projects/:slug` with one segment is a **resolver**, never a guess. It
looks the slug up across the projects the caller can see: a unique match
redirects to the canonical address, several show a chooser that names each
owner, and no match says so with a link back to the list. Server-written
links may use either form.

The room requires `features.projects` (organizing projects, on by default).
Running code - the ✨ Command turn, starting or resuming a run, rendering -
requires `features.observatory` and is explained locally, on the control
that needs it, when it is off. Visible labels say Plan, Run, Files, Outputs
and Unfiled apps; identifiers keep their names. The contract is
[ADR 0009](adr/0009-project-organization-contract.md) and the behaviour is
in [projects.md](projects.md#the-portal-pane) (package E3).

## People

People is where a person manages who they know on this installation:
**Friends** (`/people/friends` - find someone, answer or withdraw
requests, the friend list with presence) and **Messages**
(`/people/messages`, `/people/messages/:threadId` - direct-message
threads with friends). A friend request also arrives as an Inbox row with
its own Accept / Decline, and the Discussions drawer's Friends section and
the sidebar's Friends online menu are views onto the same list that link
here. The People entry's badge is `me.people.pending + me.people.unread`
(incoming requests plus unread direct messages); it is never added to the
Activity badge. The model, the routes and the privacy path are in
[friends_and_messages.md](friends_and_messages.md).

## Activity

Activity is one destination with three views, not one merged list. The
Inbox is durable delivery (read/unread, archive, attachments, the Discord
echo status); Attention is proactive notices (why it exists, acknowledge,
snooze, dismiss, watches, the opt-in policy); Scheduled is reminders and
recurring AI tasks. The existing rooms render unchanged under the view
strip. Refresh and Back stay on the view the address names
(`/activity/inbox`, `/activity/attention`, `/activity/scheduled`).

The sidebar badge, and the badge on the Inbox tab of this strip, are the
Inbox unread count **alone** (`me.inbox.unread`). Notice counts are never
added. A delivered notice is not a second unread item.

An attention notice that `attentionService._contact` also filed in the
Inbox is one delivery. The inbox row (`kind` `notice`, `sourceType`
`attention`, `sourceId` the notice ids, comma-joined, `link`
`/activity/attention`) and the notices stay in their own stores.
`services/activityCorrelation.js` reads that link when either view is
loaded. The Inbox row says it is the delivery of the notice or notices and
links to each one on Attention. Each notice says it was delivered to the
Inbox and links to that row. One row can name several notices (the
`(+N more)` title `_contact` already writes). Acknowledge, snooze and
dismiss stay `attentionService.actOnNotice` and stay on the Attention
view. Read and archive stay inbox actions and stay on the Inbox view.
Archiving the row shows on the notice; dismissing, snoozing or acting on
the notice shows on the row. Neither action moves to the other view.

## Tools

`/tools` is a landing page of cards for the specialist rooms. Three states
stay visually distinct:

- **Host-unavailable.** `toolCards` / `roomUnavailability` (`requires.feature`
  against the reported feature status, `requires.operator`; the legacy
  `me.discord.enabled` is the fallback).
  The card is not a link, is marked "Not available on this installation",
  says why in one sentence (the Trading game on an installation with no
  Discord adapter, Exchange waiting on Economy, Music turned off by a host
  setting) and links to the docs page that explains how a host turns it on.
  Hiding a tool does not change this reason, and this reason does not hide
  the tool.
- **Hidden by this account.** `appearance.hiddenToolRooms` is the set of
  tool-room ids (`music`, `trading`, `decks`) the person has hidden.
  `userSettingsSchema.TOOL_ROOM_IDS` is the allow-list; the registry's
  `TOOL_ROOMS` is the same list, and `tests/portalRooms.test.js` fails if
  they drift. An unknown id is rejected (`BAD_TOOL_ROOMS`). A hidden tool
  leaves the Tools grid and is not offered in navigation. The page lists
  it under "Hidden by you" with an unhide control. That list is not the
  unavailable-card treatment. The same checkboxes live in Settings →
  Appearance.
- **A direct URL still opens a hidden tool.** A preference is not a
  permission. `/conservatory`, `/exchange` and `/decks` do not consult
  `hiddenToolRooms`. The room itself still explains a host limit (the
  Exchange still says Discord is off).

`catalogTools(hiddenIds)` is what the grid and any navigation over the
catalog use. `isRoomAvailable` is unchanged.

## Start page

`appearance.startPage` accepts the room ids `home`, `chat`, `knowledge`,
`projects`, `discussions`, `people`, `activity`, `tools` **and** every value people
saved before the consolidation (`study`, `noticed`, `inbox`, `spitball`,
`parlor`, `exchange`, `conservatory`). `packages/core/config/userSettingsSchema.js`
and the registry hold the same list; `tests/portalRooms.test.js` fails if
they drift. The client maps an older value onto its current destination
(`noticed` → `/activity/attention`) and the Appearance select shows the
matching new option (`exchange` → Tools).

## Navigation layout

Settings → Appearance → **Navigation** (`appearance.navLayout`, see
[user_settings.md](user_settings.md)) chooses where the same registry is
drawn:

- **Sidebar** (`sidebar`, the default): the left column - brand, the
  primary rooms, "Your account" (Usage & limits, Host), friends online,
  and a footer with Documentation, the theme toggle, Settings, the account
  chip and Log out. Below 720px it is the slide-in drawer behind the room
  headers' ☰.
- **Across the top** (`top`): a bar along the top of the page
  (`shell/TopBar.tsx`, `#topbar`) - brand on the left, the primary rooms as
  pills, then the theme toggle, Settings (the `nav-settings` tutorial anchor
  travels with it) and an **account menu** behind the avatar that holds what
  the footer held (the account chip, Usage & limits, Host, Documentation,
  friends online, Log out). The stage takes the full width beneath. Below
  720px the pill row scrolls sideways; the room headers' ☰ hides because
  there is no drawer to open.

With the bar on top and a window at least 1100px wide, every room centres
on one **page column** instead of hugging the left edge. Backgrounds,
borders and scroll areas stay full-bleed; room headers, view tabs and room
bodies pad in so their content lines up down the page. Reading rooms
(Home, Knowledge's Notes and Research, Projects, Activity, Tools, Usage,
Host, the Exchange, Decks) use a 1200px column, and the sidebar-era caps
of about 900px are lifted so lists and card grids fill it; the Notes list
stays a reading width (880px) inside it. Workspaces with their own side
column (Chat, Discussions, Settings, Documentation, and the Knowledge map)
centre as a wider 1480px frame, with a hairline on each outer edge once
the window is wider than the frame, and the bar's brand and account icons
line up with that frame. The Music Lab keeps its own 1320px panel and its
toolbar follows it. Below 1100px, and in the sidebar layout, rooms keep
their usual padding. The column is CSS only (`styles.css`, "navigation
layout: the page column"), driven by `--page-max`, `--page-wide` and
`--page-gutter` on `.app.nav-top`.

Settings → Appearance → **Page width** (`appearance.pageWidth`, `centered`
by default) decides whether that column exists at all. **Full width**
(`full`, painted as `html[data-page-width="full"]`, device copy
`goobster-page-width`) collapses the page column, the workspace frame and
the Music Lab's 1320px panel to the window, so every room reaches the
edges with only its usual inset and the bar's brand and account icons sit
at the corners; the hairlines on the frame's outer edges go with it. The
reading columns inside a room (People's 780px, the Notes list's 880px) are
a measure rather than a page cap and stay. In either navigation layout,
full width also widens the Chat and Discussions threads from their 780px
measure to 1120px and Settings forms from 760px to 1040px; the
Documentation article keeps its 880px reading column. It previews live
and saves with the rest of Appearance.

The room, view and section icons the registry carries as emoji are drawn
through `<RoomIcon>` / `<ViewIcon>` / `<SectionIcon>` (`src/icons/Icon.tsx`),
which render the person's chosen icon language (Settings → Appearance →
Icon style, emoji by default); see [portal_icons.md](portal_icons.md).

Both layouts render the same `nav[aria-label="Rooms"]` landmark, the same
`a.nav-btn[data-room]` entries with the same active-room rule
(`parentRoom(resolveRoom(path))`), the same feature gating
(`isRoomAvailable`) and the same Inbox unread badge, so tutorials, tests
and deep links address navigation identically. The layout previews live
in Appearance, saves to the account, and keeps a device copy
(`goobster-nav-layout`) that `index.html` paints before the app mounts.

`e2e/appearance.spec.js` covers the live preview, Discard, Save,
reload, the account menu, the hidden ☰, the scrolling bar on a phone, the
centred page column and workspace frame on a wide window, and full width
reaching the edges.

## Links written by the server

Inbox items, notices and invitations carry a portal path in `link`. New
rows should use canonical paths (`/activity/scheduled`, `/activity/attention`,
`/projects/<ownerId>/<slug>/<view>` or the list `/projects`, `/discussions`,
`/people/friends` for a friend request);
a project link that has only the slug (`/projects/<slug>`) resolves through
the chooser described above. Rows written earlier keep their older path and
still open correctly through the aliases. Core cannot import the registry
(it lives in the web app), so these strings are plain - keep them in the
table above when adding one. `/attention`, which some notices used before
this contract, had no route at all; it is now an alias of
`/activity/attention`.

## What this contract does not do

It does not author guided-tour steps (F2). The room ids and tutorial
ids it fixes are what the tutorial framework (F1) and the authored tours
(F2) build on — see [guided_tutorials_spec.md](guided_tutorials_spec.md).
F1 ships the state machine, API, Settings list and provider shell with
empty step lists; F2 fills the chat → note → project curriculum. The
saved knowledge versus personal memory boundary (E2) is its own contract in
[knowledge_and_memory.md](knowledge_and_memory.md), the project
organization contract (E3) is [ADR 0009](adr/0009-project-organization-contract.md),
and the explicit answer → note → project / discussion transfers (E4) are
[ADR 0010](adr/0010-explicit-transfers.md) - buttons on the selected object
that open the destination at its canonical address (`/knowledge/notes`,
`/projects/:ownerId/:slug/knowledge`, `/discussions/:id`); this document
only registers the routes they land on.

## Tests

- `tests/portalRooms.test.js` - the registry: eight primary rooms, unique
  ids/paths, all 28 tutorial ids once, the Knowledge and People views and
  their resolution, the Projects detail pattern (`resolveRoomDetail`,
  `detailPath`, legacy segments, list and resolver paths returning no view),
  alias rewriting (ids kept, server share excluded, lookalike
  prefixes ignored), room resolution for every canonical and legacy path,
  display names (including `Knowledge · Map`), availability rules,
  start-page parity and mapping, legacy hash targets, tool-room id parity
  with `userSettingsSchema.TOOL_ROOM_IDS`, and `catalogTools` (hiding
  drops a card and leaves `isRoomAvailable` / `unavailableReason` alone).
- `tests/featureGatingPortal.test.js` - #321: room, view and tutorial
  feature ids against the feature inventory and catalog; the availability
  helpers (navigation, nested views, Tools cards, deep links, user-hidden
  versus unavailable, the legacy fallback); unavailable tours; the self-docs
  annotation; and `documentation/features.md` freshness.
- `e2e/featureAvailability.spec.js` - a second portal instance with a
  `features.json` (and a `GOOBSTER_FEATURE_MUSIC=0` instance) proves the
  enabled, host-disabled, user-hidden, unavailable-tour and re-enable
  journeys without touching the shared server.
- `tests/activityCorrelation.test.js` - one `_contact` is one unread inbox
  row that names every notice, and each notice names that row; archive
  stays an inbox action and shows on the notice; dismiss, snooze and act
  stay attention actions and show on the row; a forged source id cannot
  read another person's notice; `hiddenToolRooms` rejects an unknown id
  and a non-list, collapses duplicates, is on the transparency report,
  and leaves with `forgetUser`; resetting appearance clears it without
  touching `chat.disabledTools`. SQLite and Postgres.
- `e2e/navigation.spec.js` - the real router: the legacy → canonical
  matrix with query and hash preserved and the right sidebar entry active,
  the `#room/id` hash, the eight-entry sidebar with Host hidden from a
  member, the Activity views and Back/Forward, the People views, the Tools cards with a
  locally explained unavailable tool, Home's creation choices and the
  Personal memory shortcut, a settings return link from a legacy path, a
  start page saved as `study`, an Inbox row stored with a `/tasks` link, and
  both public share families without a session.
- `e2e/activityTools.spec.js` - a seeded `_contact` delivery: the Inbox
  row and the Attention notices point at each other, the sidebar badge
  matches `me.inbox.unread` on both views, refresh and Back keep the
  view, archive shows on the notice, and dismiss / snooze / act show on
  the archived row without moving those buttons. Hiding Music Lab removes
  it from the Tools grid without the unavailable treatment while Trading
  still explains Discord; `/conservatory` and `/exchange` still open;
  unhiding restores the host reason; Settings → Appearance can hide
  Card decks the same way.
- `e2e/knowledge.spec.js` - the Knowledge views, the Notes landing for
  `/knowledge` and its aliases, and the rest of the E2 behaviour.
- `e2e/projects.spec.js` - the Projects list linking to owner-qualified
  addresses, tabs / refresh / Back / deep links agreeing on the view, two
  owners with one slug and the slug-only chooser, direct creation with a
  goal, Conversation and People as views, Unfiled apps on the list.


## Ask Goobster from Inbox

Open an Inbox item and choose **Ask Goobster**. This opens a saved private
Chat with a removable context chip and a suggested question you can edit.
The compact row action does the same; on narrow screens, expand the item.
The question stays in this browser tab until **Send**. Opening the draft
makes no provider request and reserves no tokens. It marks the item read;
**Asked in …** links back to conversations that still reference the item.
Refresh keeps the conversation and chip. Back returns to the open Inbox item.

An item linked to a project also offers **Ask in the project** when you are
an owner or member. It opens that project's **Conversation**. Its reply and
any context quoted in the reply are visible to project members. Private Chat
is the default. Each member has their own chip; another member's sends do not
silently reuse your personal Inbox item. Selecting another item for that
project replaces your previous chip. The same chip appears in Discussions.

The conversation stores only the item reference in `conversation_contexts`.
On each send, the server reloads the current title, body, kind, timestamp,
source link, owner-scoped Attention notice and failure detail, and available
project/job/task/Expedition ids. It checks item ownership and current project
membership again. The snapshot is reference data in the system instructions
slot, before the question. Normal agent tools, token budgets and privacy rules
still apply, including with Discord off. This action never enables incognito.

Remove the chip to stop including the item in future sends. This does not
retract earlier messages, replies or learned information. Deleted or inaccessible
items fail closed with a removable unavailable chip. Archiving an item does not
remove its context. Deleting a conversation removes its references; account
erasure removes all references belonging to that account, including project
chips. Read-only chat shares expose the existing transcript, not the live chip
or its source. Drafts are account-scoped tab storage and disappear when the tab
is closed; ordinary and incognito drafts keep their existing behavior.

When no chat provider is configured, expanded details explain why Ask is
unavailable. Explicit local Ollama configuration also enables it; availability
here does not probe the model server. Old job reminders without a structured
job reference still support private Chat, but cannot infer a project from prose.
New job-completion reminders retain that reference for project navigation and
failure correlation.

API: `POST /api/app/inbox/:itemId/ask` accepts only `{ inProject?: boolean }`.
`GET /api/app/conversation-context/{chat|project}/:conversationId` lists your
chip; `DELETE …/:contextId` removes it. Client-supplied snapshots are ignored.
The `activity.inbox` tutorial v3 demonstrates the draft and audience choice
with fictional content and no domain writes.

Validation: `tests/inboxAsk.test.js`, the instructions-slot regression in
`tests/chatHandlerAgentTurn.test.js`, and `e2e/inboxAsk.spec.js`.

### Follow a research source

On a personal Knowledge note, use **Follow sources…**. In a Project's Knowledge view, expand **Follow sources for this project**. Follows are private to you. Add an RSS/Atom feed or public HTTPS page, then enable research Attention explicitly in Settings if it is off. The first check saves a quiet baseline. Later meaningful changes appear through Attention's normal policy; the source panel retains provenance and supports keeping a change, pausing, unfollowing, and preparing a private research draft. Review and explicitly start that draft in Knowledge → Research. See `attention.md` for detection, fetching and retention limits.
