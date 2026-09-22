---
title: "Portal navigation: rooms, canonical routes, and legacy aliases"
kind: reference
summary: The web portal's navigation contract - seven primary destinations (Home, Chat, Knowledge, Projects, Discussions, Activity, Tools) plus the account area, the room registry that drives the sidebar and active-room matching, registered room views (Activity's Inbox/Attention/Scheduled, Knowledge's Notes/Map/Research, Projects' per-project views under /projects/:owner/:slug/:view), canonical URLs, the older paths that still resolve, what a redirect preserves, the start-page preference, and how server-written links should address the portal. Shipped behaviour (shared-instance Increment E, packages E1, E2 and E3).
tags: [portal, navigation, routes, rooms, web, shared-instance, aliases, tutorials]
---

# Portal navigation

The portal is organised around what a person is doing, with the house room
names kept as secondary labels: **Chat** (the Study), **Knowledge**
(Spitball), **Projects** (the Observatory), **Discussions** (the Parlor),
**Activity** (Inbox, Attention, Scheduled) and **Tools** (Music Lab, Trading
game, Card decks), with **Home** as the front door. Usage & limits, Settings
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
| `requires` | `{ feature: 'projects' }` (Projects: organization, on by default), `{ feature: 'observatory' }` (code execution), `{ discord: true }` or `{ operator: true }`. A hidden room is not a forbidden one - a direct URL still resolves and explains itself. |
| `legacyIds` | Older room names (`study`, `noticed`, `mtga`, …) accepted by the `#room/id` hash scheme and the start-page preference. |
| `count` | Which badge the entry shows (`inbox` = Inbox unread count). |
| `tutorials` | The stable tutorial ids from [the guided-tutorial spec](guided_tutorials_spec.md) that belong to this room - all 28, each listed exactly once. |
| `views` | Rooms with several views: Activity (Inbox, Attention, Scheduled) and Knowledge (Notes, Map, Research), each with its own path, optional secondary name and legacy ids; Projects' nine views (below), each with a path `segment` under a per-project detail path. `resolveRoomView(roomId, path)` names the view a path points at; `resolveActivityView` / `resolveKnowledgeView` / `resolveProjectView` are the typed shorthands. |
| `detail` | Rooms whose views live under a per-item path: Projects declares `{ params: ['owner', 'slug'], defaultView: 'overview' }`. `resolveRoomDetail(roomId, path)` returns the item's params and view (the default when the segment is absent, `null` for an unknown segment); `detailPath(roomId, params, view)` - `projectPath()` in the typed façade - is the only way the client builds a project link. |

The sidebar (`shell/AppShell.tsx`), the active-room highlight, the body
atmosphere, Home's doors, the Tools cards (`rooms/ToolsRoom.tsx`), the
Activity strip (`rooms/ActivityRoom.tsx`), the Settings "Back to …" link,
the Knowledge strip (`rooms/knowledge/KnowledgeRoom.tsx`), the Appearance
start-page select and the legacy hash redirect all read from the registry. TanStack route definitions stay explicitly typed in
`apps/web/src/main.tsx`: the registry decides names and path equivalences,
never route parameters. `rooms.ts` is the typed ESM façade; the `.cjs` file
exists so `tests/portalRooms.test.js` can `require()` it.

## Canonical routes and aliases

| Destination | Canonical | Older paths that still work |
|---|---|---|
| Home | `/` | - |
| Chat | `/chat`, `/chat/:conversationId` | `/study`, `/study/:conversationId` |
| Knowledge | `/knowledge/notes`, `/knowledge/map`, `/knowledge/research` (`/knowledge` → Notes, keeping query and hash) | `/spitball`, `/library`, and `/spitball/<view>`, `/library/<view>` |
| Projects | `/projects` (list); `/projects/:ownerId/:slug/:view` (one project on one view; `/projects/:ownerId/:slug` → Overview, keeping query and hash); `/projects/:slug` (resolver, see below) | `/observatory`, `/workshop`, and the old `/observatory/{graph,search,people,events}` sub-pages (they rendered the same landing page); the view segments `mission`, `explorer` and `jobs` open Plan, Files and Runs; an unknown segment opens Overview |
| Discussions | `/discussions`, `/discussions/:conversationId` | `/parlor`, `/parlor/:conversationId` |
| Activity | `/activity/inbox`, `/activity/attention`, `/activity/scheduled` (`/activity` → Inbox) | `/inbox`, `/noticed`, `/attention`, `/tasks` |
| Tools | `/tools` | - |
| Music Lab | `/conservatory`, `/conservatory/<mode>` | unchanged |
| Trading game | `/exchange` | unchanged |
| Card decks | `/decks` | unchanged |
| Usage & limits, Settings, Host | `/usage`, `/settings`, `/settings/:section`, `/host` | unchanged |
| Shared conversation | `/share/:token` | unchanged (public, renders inside the shell without a session) |
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
is [knowledge_and_memory.md](knowledge_and_memory.md) (package E2).

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

## Activity

Activity is one destination with three views, not one merged list. The
Inbox is durable delivery (read/unread, archive, attachments, the Discord
echo status); Attention is proactive notices (why it exists, acknowledge,
snooze, dismiss, watches, the opt-in policy); Scheduled is reminders and
recurring AI tasks. The existing rooms render unchanged under the view
strip. The sidebar badge is the Inbox unread count **alone**: an attention
notice that was also delivered to the Inbox is the same item and is never
counted twice. Merging the underlying stores or correlating duplicates
across the views is package E5 of the plan, not this contract.

## Tools

`/tools` is a landing page of cards for the specialist rooms. Each card
separates host availability, account permission and connection state from
personal preference: when a tool cannot open here (the Trading game on an
installation with no Discord adapter, for instance) the card says why and
is not a link, instead of opening a room that fails. Per-account show/hide
of tools is a validated setting that does not exist yet (E5).

## Start page

`appearance.startPage` accepts the room ids `home`, `chat`, `knowledge`,
`projects`, `discussions`, `activity`, `tools` **and** every value people
saved before the consolidation (`study`, `noticed`, `inbox`, `spitball`,
`parlor`, `exchange`, `conservatory`). `packages/core/config/userSettingsSchema.js`
and the registry hold the same list; `tests/portalRooms.test.js` fails if
they drift. The client maps an older value onto its current destination
(`noticed` → `/activity/attention`) and the Appearance select shows the
matching new option (`exchange` → Tools).

## Links written by the server

Inbox items, notices and invitations carry a portal path in `link`. New
rows should use canonical paths (`/activity/scheduled`, `/activity/attention`,
`/projects/<ownerId>/<slug>/<view>` or the list `/projects`, `/discussions`);
a project link that has only the slug (`/projects/<slug>`) resolves through
the chooser described above. Rows written earlier keep their older path and
still open correctly through the aliases. Core cannot import the registry
(it lives in the web app), so these strings are plain - keep them in the
table above when adding one. `/attention`, which some notices used before
this contract, had no route at all; it is now an alias of
`/activity/attention`.

## What this contract does not do

It does not add the explicit answer → note → project actions (E4),
duplicate-notice correlation or tool visibility preferences (E5), or any
tutorial behaviour (F). The room ids and tutorial ids it fixes are what
those packages build on. The saved knowledge versus personal memory
boundary (E2) is its own contract in
[knowledge_and_memory.md](knowledge_and_memory.md), and the project
organization contract (E3) is [ADR 0009](adr/0009-project-organization-contract.md);
this document only registers the views they need.

## Tests

- `tests/portalRooms.test.js` - the registry: seven primary rooms, unique
  ids/paths, all 28 tutorial ids once, the Knowledge views and their
  resolution, the Projects detail pattern (`resolveRoomDetail`,
  `detailPath`, legacy segments, list and resolver paths returning no view),
  alias rewriting (ids kept, server share excluded, lookalike
  prefixes ignored), room resolution for every canonical and legacy path,
  display names (including `Knowledge · Map`), availability rules,
  start-page parity and mapping, legacy hash targets.
- `e2e/navigation.spec.js` - the real router: the legacy → canonical
  matrix with query and hash preserved and the right sidebar entry active,
  the `#room/id` hash, the seven-entry sidebar with Host hidden from a
  member, the Activity views and Back/Forward, the Tools cards with a
  locally explained unavailable tool, Home's creation choices and the
  Personal memory shortcut, a settings return link from a legacy path, a
  start page saved as `study`, an Inbox row stored with a `/tasks` link, and
  both public share families without a session.
- `e2e/knowledge.spec.js` - the Knowledge views, the Notes landing for
  `/knowledge` and its aliases, and the rest of the E2 behaviour.
- `e2e/projects.spec.js` - the Projects list linking to owner-qualified
  addresses, tabs / refresh / Back / deep links agreeing on the view, two
  owners with one slug and the slug-only chooser, direct creation with a
  goal, Conversation and People as views, Unfiled apps on the list.
