# ADR 0009: Projects are addressed by owner and slug, organized without execution, and named Plan / Run

## Status

Accepted (shared-instance Increment E, package E3). Behaviour is documented in
[projects.md](../projects.md) (the portal section) and
[portal_navigation.md](../portal_navigation.md) (the registered views).

## Context

The portal's Projects room (`/projects`, formerly the Observatory) is one
component holding the list, the selected project and six tabs. Four things
about it were found at the audited baseline (handoff §4.3):

1. **Selection is browser state.** `ObservatoryRoom.tsx` keeps the selected
   project in React state (`{ slug, ownerId, tab }`). A refresh, the Back
   button, a bookmark or an Inbox link cannot land on a project or a tab; every
   server-written link says `/projects` and stops at the list.
2. **A slug is not an identity.** `observatory_projects` is
   `UNIQUE (userId, slug)`: two owners may both have `emergence-study`, and a
   collaborator on both sees two projects with one slug. The service already
   disambiguates with an `owner` qualifier; a URL must carry it too or one
   project silently opens instead of another.
3. **Organization is coupled to execution.** `ObservatoryService.enabled` is
   `observatory.enabled && sandbox.enabled`, and `_requireEnabled()` guards
   *everything*: listing, creating, members, knowledge, files, plans, share
   links, job history - not just running code. `me.features.observatory` hides
   the whole room, so on the default installation (both switches off) Projects,
   a core destination since E1, does not exist.
4. **Internal names are visible names.** The room says Mission, Job, Explorer;
   the parent spec's object model says Plan, Run, Files. The Workshop inbox
   organizes generated apps only, and the Home card already says *Unfiled apps*.

Two hidden dependencies are recorded in the handoff: creation goes through a
model call (the ✨ Command turn creates a project with the `observatory`
tool), and `projectService.resolveKnowledgeScopeForChannel` recognizes a
project's conversation by its `🔭 <name>` title prefix.

## Decision

### 1. A project URL names the owner

Canonical detail path: **`/projects/:ownerId/:slug/:view`**, where `ownerId`
is the owner's principal id (a Discord snowflake or a `usr_…` id), `slug` is
the per-owner slug and `view` is one of the registered views below. The bare
`/projects/:ownerId/:slug` redirects to the default view (`overview`) with
search and hash kept. `/projects` is the list.

`/projects/:slug` (one segment) is a **resolver**, never a guess: it looks the
slug up across the projects the caller can see; a unique match redirects to
the canonical path, several matches show a chooser that names each owner, and
no match says so with a link back to the list. Server-written links may use
either form; they resolve through the same rules.

Selection and the active tab live only in the URL. The list, the resolver
and every tab read the owner and slug from route params, so refresh, Back /
Forward, bookmarks and Inbox links all return to the same place.

### 2. Views are registered, not invented per component

The room registry (`apps/web/src/lib/rooms.cjs`) gains a `detail` pattern
for rooms whose views live under a per-item path, and Projects registers:

| View | Path segment | What it shows |
|---|---|---|
| Overview | `overview` (default) | Goal, the open plan and its next action, latest runs, outputs. |
| Plan | `plan` | The open plan (internal: mission) - criteria, steps, approvals, evidence. |
| Conversation | `conversation` | The project's shared discussion (the project parlor). |
| Knowledge | `knowledge` | The project's Spitball: map, notes, research. |
| Files | `files` | The workspace tree and versioned source assets (was Explorer). |
| Apps | `apps` | Rendered generated apps with version picker. |
| Runs | `runs` | Every run (internal: job), its status, provenance, output verdict, cancel / resume. |
| People | `people` | Owner, collaborators, invitations. |
| Automations | `automations` | Triggers and their deliveries. |

`resolveRoomView('projects', pathname)` returns the view for a detail path
(the default when the segment is absent) and `null` on the list;
`roomDisplayName` therefore says "Projects · Runs". The conversation dock
and the People modal stay as secondary presentations of the same data.

### 3. Vocabulary: Plan, Run, Files, Unfiled apps

Visible labels change; **identifiers do not**. `project_missions`,
`observatory_jobs`, `MissionTab`, `keys.projectMission`,
`/api/app/projects/:slug/mission…`, the `observatory` tool and its
`mission` / `run` actions keep their names. The UI says **Plan** for a
mission, **Run** for a job, **Files** for the explorer, and **Unfiled apps**
for the Workshop inbox - the narrower name, because `WorkshopInbox` lists
generated apps and nothing else. A typed output listing and a transfer
contract are E4 work; "Unfiled outputs" waits for them.

### 4. Organization is separate from execution

`ObservatoryService` exposes two gates:

- **`organizationEnabled`** - `projects.enabled` (default **on**;
  `GOOBSTER_PROJECTS_ENABLED=0` or `"projects": { "enabled": false }` turns it
  off). Creating, listing, opening, deleting; members and invitations;
  workspace files and assets; plans; knowledge; automations (defining them);
  run history; dashboards and share links; the project parlor.
- **`executionEnabled`** - the old `enabled`: `observatory.enabled &&
  sandbox.enabled`. Starting or resuming a run, rendering, fetching data,
  the ✨ Command / project-chat agent turn (it exists to drive the
  `observatory` tool), and the trigger runner's dispatch. `enabled` remains
  as an alias of `executionEnabled` so the tool registry, the agent tool and
  existing tests keep their meaning.

`_requireEnabled()` keeps guarding execution; organization methods call
`_requireOrganization()` instead (same orphan reap, no execution check).
`/me` reports both: `features.projects` (organization) and
`features.observatory` (execution). The Projects room requires
`features.projects`; with execution off it stays fully usable for organizing
and explains locally, on the controls that need it, that code execution is
off on this installation. Nothing enables the sandbox to make navigation
work.

### 5. Direct creation without a model call

`POST /api/app/projects { name, goal? }` calls the same authorized
`createProject` (owner = caller, per-user cap, slug uniqueness, owner-only
workspace) and stores the goal in the existing `observatory_projects.description`
column. The list and detail payloads carry `description`; the Overview shows
it as the project's goal. The natural-language ✨ Command flow stays for
richer setup and remains execution-gated.

### 6. Title-based conversation routing is preserved

`resolveKnowledgeScopeForChannel` still recognizes a project conversation by
its `🔭 <name>` title, and the Conversation view and Command turn keep writing
that title. Renaming the visible room does not touch conversation titles, so
retrieval scope is unchanged. Replacing the convention with an explicit
conversation-to-project identity (a column plus a safe backfill) is recorded
as follow-up work, not done here.

## Consequences

- Existing rows are untouched: no schema change, no rescoping, no slug
  rewrite. `description` was already a column.
- Operators who deliberately left `observatory.enabled` off now see a
  Projects room that organizes without running code. Those who want no
  Projects at all set `projects.enabled = false`.
- Two projects with one slug are distinguishable in every URL, and a
  slug-only link asks instead of guessing.
- Tests must cover: organization with execution off (and refusal of run /
  render / command), the resolver's three outcomes, refresh / Back on a
  detail view, and direct creation with a goal. The registry test keeps the
  view list and the tutorial ids in step.
