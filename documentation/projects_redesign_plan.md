# Projects: unifying the Observatory, Workshop, and Automations

**Status: proposal / planning document.** Nothing here is implemented yet.
This is the design for collapsing three loosely-coupled features —
Observatory workspaces, Workshop mini-apps, and (project-scoped)
automations — into one aggregate: the **Project**, an all-in-one place for
app assets (frontend mini-app code, backend data-engineering scripts,
fetched/processed data) and the automations that operate on them.

## 1. The problems with the current model

Three separate systems grew independently and the seams show:

1. **Driving a project on a schedule is clunky.** The only way to run an
   Observatory job periodically is a guild/channel-scoped `automations` row
   whose prompt fires a *full agent turn* that hopefully calls the
   `observatory` tool with the right project. The schedule lives in one
   table, the project in another, the code in neither — every scheduled run
   re-generates (or re-pastes) the snippet through an LLM round-trip, with
   all the nondeterminism and token cost that implies.

2. **Mini-app ↔ data plumbing is a bolt-on.** An applet that wants project
   data must declare `<meta name="goobster-observatory-read">` tags, the
   owner must approve a grant, and the iframe bridge mediates every read —
   machinery that exists only because the app and the data have no shared
   parent. The app *belongs to nothing*; it just happens to point at a
   project.

3. **Mini-apps have no identity, so they have no versions.** A Workshop
   applet's identity is its content hash. Editing the HTML in chat produces
   a brand-new row (or an unpinned discovery), the old pin lingers, grants
   don't carry over, and the actual development history is buried in chat
   scrollback in the Study. There is no "this is v7 of my dashboard",
   no rollback, no provenance.

The common root cause: **there is no aggregate that owns all the artifacts
of one piece of work.** The Observatory owns files and jobs; the Workshop
owns HTML blobs; automations own prompts. The Project is that aggregate.

## 2. What a Project is

A Project is a named, per-user unit of work that owns:

- **A workspace** — the existing durable directory at
  `data/sandbox/projects/<userId>/<slug>/` (quota, `$GOOBSTER_PROJECT_DIR`,
  `fetch-data`, the checkpoint convention — all unchanged). This is where
  **data** lives: fetched inputs, processed outputs, frames, renders.
- **Assets** — named, *versioned* source artifacts stored in the database:
  - `app` — frontend mini-app source (html/svg), rendered in the portal
    sandbox exactly like today's applets;
  - `script` — backend/data-engineering code (python/javascript) runnable
    as a foreground run or a checkpointed background job;
  - `note` — freeform markdown (README, run log, findings). Cheap to add
    and gives a project a front page.
- **Jobs** — the existing checkpointed background runs, now with provenance:
  a job can record *which asset version* it executed.
- **Triggers** — project-scoped automations: cron or domain-event triggers
  whose actions are **deterministic** (run this script asset, render,
  re-fetch a data URL) or **agentic** (a prompt, the existing
  Observatory-command machinery) — the operator picks per trigger.

The Observatory doesn't disappear — the Project *is* the Observatory
project, grown until the Workshop and the scheduling glue fit inside it.
Everything the sandbox enforces (isolation ladder, quotas, rate limits,
fetch consent, "persistence, never new execution powers") is untouched.

## 3. Data model

Per the repo's migration machinery (column adds + `CREATE TABLE IF NOT
EXISTS`, no renames), the existing tables are **kept and grown**; new
concepts get new tables. Physical names keep the `observatory_` prefix
where they already exist — the service/API layer owns the "Project" naming
(precedent: `UserPreferences`). All SQL in SQLite dialect; snowflakes as
TEXT; UTC text timestamps; works on both engines.

### 3.1 `observatory_projects` (the Project registry — grown)

New columns via `COLUMN_MIGRATIONS`:

```sql
['observatory_projects', 'description', 'description TEXT'],
-- Emoji or short label for the portal card; purely cosmetic
['observatory_projects', 'icon', 'icon TEXT'],
```

Slug, name, per-user uniqueness, quota, and the workspace directory
contract stay exactly as they are.

### 3.2 `project_assets` + `project_asset_versions` (new)

The fix for problem 3. An asset is a **stable identity**; a version is an
immutable snapshot. "Editing" an app = inserting a new version and moving
the head pointer. Rollback = moving the pointer back.

```sql
CREATE TABLE IF NOT EXISTS project_assets (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    -- Denormalized owner so erasure and audits never need a join
    userId TEXT NOT NULL,
    -- Asset identity within the project ("dashboard", "ingest", "readme")
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('app', 'script', 'note')),
    -- Head pointer; NULL only transiently during creation
    currentVersionId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (projectId, slug)
);

CREATE TABLE IF NOT EXISTS project_asset_versions (
    id INTEGER PRIMARY KEY,
    assetId INTEGER NOT NULL REFERENCES project_assets(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    -- Monotonic per-asset sequence (1, 2, 3, ...) - the user-facing "v7"
    version INTEGER NOT NULL,
    -- app: 'html' | 'svg'; script: 'python' | 'javascript'; note: 'markdown'
    language TEXT NOT NULL,
    source TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    -- One-line commit-message-style note ("added error bars")
    note TEXT,
    -- Where this version came from: 'chat' (saved from a Study fence),
    -- 'portal' (edited in the project pane), 'agent' (tool call),
    -- 'migration' (imported from web_applets)
    origin TEXT NOT NULL DEFAULT 'chat'
        CHECK (origin IN ('chat', 'portal', 'agent', 'migration')),
    -- Chat provenance when saved from a conversation (soft links, like
    -- web_applets today)
    conversationId INTEGER,
    messageId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (assetId, version)
);

CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets(projectId, kind);
CREATE INDEX IF NOT EXISTS idx_project_assets_user ON project_assets(userId);
CREATE INDEX IF NOT EXISTS idx_project_asset_versions_asset
    ON project_asset_versions(assetId, version);
CREATE INDEX IF NOT EXISTS idx_project_asset_versions_user ON project_asset_versions(userId);
```

Design decisions:

- **Source lives in the DB, not the workspace.** Matches the `web_applets`
  precedent, keeps the portal (and the split-deployment `apps/api`, which
  reads Postgres) able to render apps without touching the bot's disk,
  keeps assets restart-safe and erasable, and keeps snippet-writable
  workspace files from ever being served as trusted app source. Scripts
  are *copied into* the sandbox run like today's `code` parameter — the
  workspace never becomes an execution source of truth.
- **Same caps as applets**: source ≤ 200 KB/version. New clamped knobs
  (observatoryConfig pattern, floor/ceiling): `maxAssetsPerProject`
  (default 20), `maxVersionsPerAsset` (default 50 — oldest non-head
  versions pruned past the cap).
- **Identical-source saves are a no-op** (compare `contentHash` against
  the head) so re-running "save" never manufactures empty versions.
- **Deduplicate storage later if it matters**: 50 × 200 KB per asset is
  the worst case; acceptable for a Pi, and pruning bounds it.

### 3.3 `project_jobs` — provenance on `observatory_jobs` (grown)

```sql
-- Which stored asset version this job executed (NULL for ad-hoc code
-- passed inline, exactly like today)
['observatory_jobs', 'assetVersionId', 'assetVersionId INTEGER'],
-- What started it: 'chat' | 'portal' | 'trigger' | 'resume'
['observatory_jobs', 'startedBy', 'startedBy TEXT'],
['observatory_jobs', 'triggerId', 'triggerId INTEGER'],
```

`code` stays on the job row (resume needs it verbatim even if the asset is
later edited or pruned); `assetVersionId` is provenance, not a reference
the runner chases.

### 3.4 `project_triggers` (new) — the fix for problem 1

Project-scoped automations with **first-class actions**, so the common case
("run my ingest script nightly") is deterministic — no agent turn, no
prompt, no token spend, no nondeterminism:

```sql
CREATE TABLE IF NOT EXISTS project_triggers (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    -- When it fires
    kind TEXT NOT NULL CHECK (kind IN ('cron', 'event')),
    -- kind='cron': 5-field cron, evaluated in UTC (the automations contract)
    schedule TEXT,
    nextRun TEXT,
    -- kind='event': a project-scoped domain event on THIS project.
    -- 'job_completed' | 'job_failed' | 'job_settled' (any terminal state)
    eventTopic TEXT,
    -- What it does
    action TEXT NOT NULL CHECK (action IN ('run_script', 'render', 'fetch_data', 'agent_prompt')),
    -- run_script: the asset to run (head version at fire time)
    actionAssetId INTEGER REFERENCES project_assets(id) ON DELETE SET NULL,
    -- JSON knobs: { background, fps, url, filename, prompt, ... } - validated
    -- per-action at write time, re-validated at fire time
    actionParams TEXT,
    isEnabled INTEGER NOT NULL DEFAULT 1 CHECK (isEnabled IN (0, 1)),
    lastRun TEXT,
    -- 'ok' | 'failed' | 'skipped' + short detail, for the portal list
    lastOutcome TEXT,
    -- Chaining guard: an event trigger never fires on a job it started
    -- itself unless allowSelfChain=1 (JSON in actionParams), and never
    -- more than maxChainDepth times per root job.
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_triggers_project ON project_triggers(projectId);
CREATE INDEX IF NOT EXISTS idx_project_triggers_next_run ON project_triggers(nextRun);
CREATE INDEX IF NOT EXISTS idx_project_triggers_user ON project_triggers(userId);
```

Runner semantics:

- **Cron triggers** join the existing automation minute loop (same
  singleton lock, same atomic claim-by-advancing-`nextRun`, same
  disable-on-unparseable-schedule) — a second poller would just race the
  first. Deterministic actions call `projectService.run` /
  `render` / `fetchData` directly under the owner's identity and limits
  (rate limits, quotas, active-job caps all apply; a busy sandbox defers
  like a resume segment does). `agent_prompt` actions reuse the
  Observatory-command machinery verbatim (pseudo-interaction, trusted
  surface for the `web` scope, transcript filed into the project's 🔭
  conversation) — that rule already exists for automations and transfers
  as-is.
- **Event triggers** follow the repo's "events are hints, never the source
  of truth" doctrine: the settle path (`_settleJob`) evaluates matching
  triggers *from DB state* in the same flow that already publishes
  `observatory.job_*` on the domain bus and files the completion follow-up;
  the bus makes nothing happen sooner here because settle is local. A
  startup sweep re-evaluates jobs settled while the process was down
  (compare `finishedAt` against `lastRun`) so restarts never drop a fire.
- **Chain example** (the whole point): cron trigger runs `ingest` nightly →
  `job_settled` event trigger runs `process` → its completion refreshes the
  dashboard artifact; the `dashboard` app asset reads the processed files
  from the workspace. Zero agent turns, fully restart-safe, with the
  chain-depth guard preventing runaway loops.

The guild/channel `automations` table is **left alone** — it serves a
different job (scheduled *conversational* prompts in Discord scopes) and
still works, including for projects, via `agent_prompt`-style prompts. No
migration, no breakage; the docs stop *recommending* it for project work.

### 3.5 Grants: own-project reads become implicit

An `app` asset rendered from inside project X gets **implicit read access
to project X's workspace** through the existing owner-only content route —
the parent page knows which project the asset belongs to, so no meta tag
and no grant dialog for the common case. The
`goobster-observatory-read` meta-tag + grant flow survives *only* for
cross-project reads (asset in project X reading project Y), same parser,
same legalization, with grants stored on the asset row:

```sql
-- (on project_assets)
grantsJson TEXT   -- { observatoryRead: ["other-project-slug"] }
```

The iframe bridge in `apps/web` is unchanged mechanically; only the
grant-resolution rule in the parent gains the "own project ⇒ allowed"
short-circuit.

## 4. Service layer (`packages/core`)

- **`services/projectService.js`** — new name, absorbs
  `observatoryService` (which becomes a thin re-export during a deprecation
  window so nothing breaks mid-transition). Owns projects, workspace,
  jobs, quota — everything it owns today — plus the new
  `description`/`icon` fields.
- **`services/projectAssetService.js`** — new: asset CRUD, version
  append/prune/rollback, hash dedupe, grant legalization (reusing
  `utils/appletCapabilities.js`), the caps above.
- **`services/projectTriggerService.js`** — new: trigger CRUD +
  validation; fire logic invoked by the automation loop (cron) and the job
  settle path (events); the startup catch-up sweep.
- **`services/webAppletService.js`** — shrinks to the *discovery* half
  (scanning chat fences) plus a deprecation shim for existing pins; see
  migration below.

Boundary rule holds: all of this is core; `apps/bot` and `apps/api` only
mount routes over it.

## 5. Tool surface (chat)

The `observatory` tool grows into a `project` tool (registered under both
names for a release; same gating: sandbox on, observatory on, scope
honored). New actions on top of the existing set:

- `save_app` / `save_script` / `save_note` — create a version (new asset or
  new version of an existing one) from source the model just wrote or the
  user pasted. This is how a Study conversation stops burying applets:
  "save that as the dashboard app in neurogene-lab" is one tool call, and
  the next edit is *v2 of the same asset*, not a new orphan.
- `list_assets`, `get_asset` (head or `version: n`), `rollback_asset`.
- `run_script` — run a stored script asset (foreground or `background`),
  recording `assetVersionId` on the job.
- `set_trigger` / `list_triggers` / `delete_trigger` — manage project
  triggers conversationally.

`runCode`-style ad-hoc runs keep working; assets are for code worth
keeping.

## 6. API and portal

Routes (new, alongside the existing `/api/app/observatory/*` which keep
working):

```
GET/POST/PATCH/DELETE /api/app/projects/:slug/assets[...]
GET                   /api/app/projects/:slug/assets/:asset/versions[/:n]
POST                  /api/app/projects/:slug/assets/:asset/rollback
GET/POST/PATCH/DELETE /api/app/projects/:slug/triggers[...]
```

Portal (`apps/web`):

- **ObservatoryRoom becomes the Projects room** — same master-detail
  shell, project view grows tabs: **Overview** (today's live dashboard
  view), **Apps** (rendered in the existing applet sandbox, with a version
  dropdown + rollback), **Scripts & Jobs** (assets on the left, the
  existing job timeline on the right), **Data** (today's workspace file
  table + fetch-data), **Automations** (trigger list: schedule/event,
  action, last outcome, enable/disable), and the ✨ Command seat as-is.
- **Study**: rendered `html`/`svg` fences gain a **"Save to project…"**
  button (project picker → new asset or new-version-of-existing). Pinning
  stays during the deprecation window.
- **WorkshopRoom** becomes the *inbox*: discovered (unpinned) fences from
  chat plus legacy pins, each with **"Promote to project"**. Once pins are
  migrated and promotion covers discovery, the room can fold into the
  Projects room as an "Inbox" section and retire.

## 7. Migration of existing Workshop pins

One-time, on startup (idempotent, keyed on a marker):

1. For each user with `web_applets` rows, ensure a default project
   (slug `workshop`, name "Workshop", created only if pins exist —
   never counted against `maxProjectsPerUser` during migration).
2. Each pin becomes an `app` asset (slug from a slugified title,
   de-duplicated) with one version, `origin='migration'`, provenance
   columns copied; `grantsJson` carries over as cross-project grants.
3. `web_applets` rows are left in place for one release (the Workshop
   room still lists them, now marked "migrated"); the table and its
   routes retire in the following release, at which point `/forget-me`
   coverage for it hands off to the project erasure path.

## 8. Privacy

All three new tables are per-user data. In the same release that creates
them:

- `privacyService.auditUser` counts `project_assets`,
  `project_asset_versions`, `project_triggers`.
- `/forget-me` deletes them (CASCADE from the project covers most of it;
  the erasure path still deletes by `userId` directly so orphans can't
  survive a broken FK) alongside the existing project/job/share-link/
  workspace/dashboard erasure.
- `/what-do-you-know-about-me` reports asset and trigger counts with the
  existing Observatory section.

No embeddings are involved, so no vec-index cleanup applies.

## 9. Phasing

Each phase lands green on both engines (`npm test` SQLite + Postgres,
lint, smoke) and is independently shippable.

**Phase 1 — Assets and versions (fixes problem 3).**
Schema + `projectAssetService` + caps/config + API + `save_*`/`list`/
`get`/`rollback` tool actions + Apps tab with version picker + Study
"Save to project…" + privacy coverage.
Tests: asset CRUD/versioning/pruning/rollback/dedupe, cap clamping,
erasure, tool actions, API auth.

**Phase 2 — Pin migration + Workshop-as-inbox.**
Startup migration, promote-to-project UI, deprecation marks.
Tests: migration idempotence, grant carry-over, slug collision handling.

**Phase 3 — Triggers (fixes problem 1).**
Schema + `projectTriggerService` + cron integration into the automation
loop + event evaluation in the settle path + startup catch-up + Automations
tab + trigger tool actions.
Tests: claim semantics, deterministic `run_script` end-to-end (fake
sandbox), event fire on settle, catch-up after simulated restart,
chain-depth guard, disable-on-bad-cron.

**Phase 4 — Bridge simplification + renames (fixes problem 2).**
Implicit own-project reads in the parent bridge; `observatoryService` →
`projectService` re-export flip; docs (`observatory.md` → `projects.md`);
Workshop room folds in; `web_applets` retirement scheduled.
Tests: bridge grant resolution (own vs cross-project), route parity.

**Phase 5 — User parity: the browsable, editable project (§10).**
The explorer tree, file viewer, asset editor with version history/diffs,
workspace uploads/deletes, and run-from-UI — the user can do by hand
everything Goobster can do by tool.
Tests: path legalization for writes, quota enforcement on upload/edit,
portal-origin versioning, run-from-UI provenance, erasure still complete.

**Phase 6 — The project chat dock (§11).**
A persistent chat panel docked in the project page, bound to the project's
dedicated conversation, streaming full agent turns with live pane refresh.
Tests: conversation binding, project-scoped preamble, turn lock, refetch
hints on asset/workspace mutation.

**Phase 7 — Collaborative projects (§12).**
Membership + invites on the parlor pattern; every service entry point
resolves the acting member instead of assuming the owner; owner-reserved
actions; actor attribution on versions and jobs.
Tests: actor resolution (owned vs shared vs stranger), owner-only guards,
slug disambiguation, invite lifecycle, member erasure repairs asset heads,
caps charged to the actor.

**Phase 8 — The project Spitball (§13).**
A per-project knowledge graph scope (`PROJECT:<projectId>`, the persona
precedent), written only through the legalizer; a Knowledge tab with the
Map; expeditions and chat-dock retrieval targeting the project scope.
Tests: scope isolation, legalizer-only writes, expedition targeting,
manifest retrieval, erasure with the project.

**Phase 9 — The project parlor (§14).**
Project chat becomes a group table: an auto-managed parlor conversation
linked to the project, membership synced from project membership, a
built-in Goobster seat whose workspace is the project Spitball and whose
addressed replies run agent turns as the addressing member, rendered as
a slim parlor view in the dock.
Tests: lazy creation + membership sync (accept/leave/remove), linked-
conversation guards (no direct member management, cap exemption),
Goobster-seat scope routing, actor-bound agent turns refusing
owner-reserved actions, per-conversation turn lock, cascade on project
delete, member message erasure.

## 10. User parity: the project as a browsable repo (Phase 5)

Everything Goobster can do through the `project` tool, the owner can do by
hand in the portal. The project view gains a repo-style **Explorer** that
replaces the flat file table:

### 10.1 The explorer tree

One tree, two roots — honest to the storage model rather than pretending
it is one filesystem:

- **`assets/`** — the DB-backed, versioned sources (`app`, `script`,
  `note`), shown like tracked files. Selecting one opens the viewer with
  a **version history rail** (a mini `git log`: version number, note,
  origin, date, who/what created it), version-to-version **diffs**
  (client-side, `diff` npm package — no server work), **rollback**, and
  **Edit**.
- **`workspace/`** — the on-disk directory tree (`data/`, `frames/`,
  `renders/`, `checkpoint.json`, …), served through the existing
  owner-only content route. Directories expand lazily
  (`listFiles` grows a `path` parameter + per-directory listing); files
  open in the viewer (text with syntax highlighting, images/video inline,
  binaries as download cards via `/api/app/files/:id`).

Viewer/editor is **CodeMirror 6** (light enough for the Pi-served portal;
Monaco is explicitly out). Breadcrumbs, file size/mtime, and a download
button round out the repo feel.

### 10.2 Editing and writing

- **Assets**: Edit opens CodeMirror on the head source; Save appends a
  version with `origin='portal'` and an optional note — the same service
  path as `save_app`/`save_script`, so caps, dedupe-no-op, and pruning all
  apply identically. Users and Goobster produce indistinguishable rows,
  which is the parity guarantee.
- **Workspace files**: new owner-only write routes beside the reader —
  `PUT /api/app/projects/:slug/content/*` (text save + upload;
  multipart for binaries), `DELETE .../content/*`, directories created
  implicitly by path. Guards, all shared with the reader via one
  extracted `legalizeWorkspacePath` helper: traversal and symlink
  refusal, workspace-relative paths only, the **disk quota checked
  before every accepted byte** (same contract as fetch-data), and a
  clamped `maxUploadMb` knob (default 50). Writes work in both
  deployment profiles because the workspace lives on the shared data
  volume the api container already mounts.
- **Run from the UI**: a ▶ Run button on `script` assets
  (`POST .../assets/:asset/run`, `{ background }`) calls
  `projectService.run` with the head version, recording
  `assetVersionId` + `startedBy='portal'` — jobs land in the existing
  timeline with full provenance. Foreground output streams back like a
  chat-run attachment; background runs behave exactly like tool-started
  jobs.

Nothing here widens execution powers: portal writes land in the same
snippet-writable workspace sandbox runs already write to, under the same
quota, and asset edits only run when something (user, tool, or trigger)
explicitly runs them.

## 11. The project chat dock (Phase 6)

The ✨ Command seat grows into a **docked chat panel** on the project page
— a persistent, scoped conversation with Goobster about *this* project,
not a one-shot command box.

- **One conversation per project**: the dock binds to the existing
  dedicated `🔭 <project>` web conversation (the
  `observatoryConversationId` pattern), rendering its full transcript with
  the Study's message components. History persists across visits, and the
  same conversation stays browsable/continuable from the Chat pane —
  the dock is a second window onto it, not a fork.
- **Turns are full agent turns**: the composer posts through the
  project-command endpoint (generalized to
  `POST /api/app/projects/:slug/chat`), which keeps the project-scoped
  preamble, the `project` tool, the trusted-surface rule, the chat SSE
  streaming vocabulary, tool-activity rendering, and the per-user turn
  lock with ◼ Stop. No second chat pipeline — the dock is a differently
  scoped Study composer.
- **Context beyond the preamble**: the preamble grows a compact project
  manifest (asset slugs/kinds/head versions, trigger names, workspace
  top-level listing, latest job status) so "why did last night's run fail?"
  or "bump the dashboard to show the new column" resolves without the
  model spending tool rounds rediscovering state.
- **Live pane refresh**: when a turn (or a trigger, or a portal edit)
  mutates assets, jobs, or workspace files, the portal event bus
  (`eventBusService`, the existing user-scoped SSE refetch-hint feed)
  tells the open project page to refetch — the explorer and version rails
  update while Goobster narrates, without manual reloads. This is the
  refetch-hint bus doing exactly what it exists for; no new transport.
- **Layout**: desktop shows the dock as a right-hand sidebar
  (collapsible); narrow viewports get a bottom-sheet toggle. The explorer
  and the dock share the page so "look at `assets/dashboard` v3 and fix
  the legend" is one screen.

## 12. Collaborative projects (Phase 7)

Projects stop being single-player: the owner invites other users, and an
accepted member gets **most of the owner's access** — browse, edit assets,
run scripts, manage triggers, use the chat dock. The design leans entirely
on the multi-user parlor precedent (`parlor_members` / `parlor_invites`,
DM Accept/Decline buttons, the portal invitation list, and the
`parlor_messages.userId` erasure rule).

### 12.1 Data model

```sql
-- Accepted collaborators. The owner is observatory_projects.userId and
-- never has a row here; role exists for forward-compat (all rows are
-- 'collaborator' until a 'viewer' tier is ever wanted).
CREATE TABLE IF NOT EXISTS project_members (
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    userName TEXT,                    -- snapshotted at accept, parlor rule
    role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('collaborator')),
    invitedBy TEXT NOT NULL,
    joinedAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (projectId, userId)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(userId);

-- Only the owner invites; invitee accepts/declines from a Discord DM
-- button or the portal invitation list. Mirrors parlor_invites exactly
-- (status lifecycle, name snapshots, /forget-me deletes rows addressed
-- to the forgotten user).
CREATE TABLE IF NOT EXISTS project_invites (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    inviterId TEXT NOT NULL,
    inviterName TEXT,
    inviteeId TEXT NOT NULL,
    inviteeName TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    respondedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_invites_project ON project_invites(projectId, status);
CREATE INDEX IF NOT EXISTS idx_project_invites_invitee ON project_invites(inviteeId, status);
```

New clamped knob: `maxMembersPerProject` (default 5, floor 1, ceiling 50).

### 12.2 Actor resolution — the one structural change

Today every service entry point takes `{ userId, project }` and looks the
project up with `WHERE userId = @userId`. Phase 7 replaces that lookup with
**one** resolver, `projectService.resolveProjectForActor`, which returns
the project row plus the actor's role (`owner` | `collaborator`) — owned
projects first, then memberships. Every read/write path (assets, versions,
workspace reads *and* writes, jobs, triggers, renders, the dashboard, the
chat endpoint, the applet content bridge) goes through it; nothing else
changes its signature. Rules:

- **Owner-reserved actions**: delete project, invite/revoke/remove members,
  mint/revoke the share link. Everything else is member-accessible —
  that's the "most of the same access" contract. No ownership transfer.
- **Slug disambiguation**: slugs are unique per *owner*, so a member may
  see two projects with the same slug (their own + a shared one).
  Resolution order is own-first; API routes and the tool accept an
  optional `owner` qualifier (`:slug?owner=<userId>`, tool param
  `owner`), and portal lists always carry `ownerId` + owner display name
  on each row so the UI links unambiguously.
- **Actor attribution, already in the schema**: `project_asset_versions.userId`
  and `observatory_jobs.userId` shift meaning from "the owner" to "the
  actor" — no migration needed, single-player rows already satisfy it.
  The version rail and job timeline show who did what.
- **Whose limits**: per-action costs (sandbox rate limits, active-job
  caps, version caps) are charged to the **actor**; per-project costs
  (disk quota, asset count) stay on the project; `maxProjectsPerUser`
  counts **owned** projects only. Triggers keep executing under the
  **owner's** identity (they are the project's standing authority — a
  schedule must not die because the member who created it left), but
  `project_triggers` gains a `createdBy` column for attribution.
- **Workspace path unchanged**: `data/sandbox/projects/<ownerId>/<slug>/`
  — the owner's directory is the project's home regardless of who acts.
- **Chat stays per-member** *(superseded by §14 / Phase 9)*: in Phase 7
  alone, each member's dock binds to their *own* `🔭 <project>`
  conversation in their own `dm:<userId>` scope. Phase 9 replaces the
  dock's surface with the shared project parlor; the per-member
  conversations remain readable in the Chat pane as history.
- **Notifications and refresh**: job-completion follow-ups go to the
  actor who started the run; portal refetch hints fan out to every
  member's event-bus feed so all open project pages update.

### 12.3 Privacy

The parlor precedent transfers directly:

- **Member `/forget-me`**: deletes their membership rows, invites
  addressed to them, and rows they authored — their asset versions
  (repairing each asset's head to the latest surviving version, and
  deleting an asset left with zero versions) and their job rows.
  Workspace files are project data under the owner's tree (like
  fetch-data downloads) and stay. `auditUser` counts memberships,
  invites, authored versions, and authored jobs in shared projects.
- **Owner `/forget-me`**: unchanged — the whole project dies (rows,
  workspace, dashboards, share links, now memberships and invites via
  CASCADE); members are notified by DM that the project is gone.
- `/what-do-you-know-about-me` reports both directions: projects owned
  and projects collaborated on.

## 13. The project Spitball (Phase 8)

Each project gets its own knowledge graph — technical and functional
notes, researched topics, project attributes, decisions — living in the
**existing** `kg_*` tables under a new scope partition, exactly as parlor
personas already do:

- **Scope**: `guildId = dm:<ownerId>`, `scopeKey = 'PROJECT:<projectId>'`.
  Unique node identity, tag caps, and legalizer scope enforcement all come
  for free. The "one personal Spitball" rule in
  `documentation/spitball_expeditions.md` is **amended, not violated**:
  personas taught the system that a workspace can be a first-class graph
  scope; projects are the second such workspace. Cross-links between a
  project graph and a personal graph are not supported (scopes stay
  isolated, the existing rule).
- **Writes only through the legalizer**: every mutation goes through
  `knowledgeGraphService.applyMutations` with the project scope — model
  proposals, tool calls, and expeditions alike. No new write path.
- **Feeding it**:
  - The `project` tool gains `note_knowledge` (rememberFact-style: store
    a distilled note/edge/tags into the project scope) and
    `recall_knowledge` (scoped retrieval), available wherever the tool is.
  - **Chat-dock turns consolidate into the project scope**: the existing
    consolidation pipeline routes turns from a project's dedicated
    conversation to `PROJECT:<projectId>` instead of the personal scope —
    what you discuss with Goobster *about the project* becomes project
    knowledge, not personal memory.
  - **Expeditions can target a project**: `spitball_expeditions` gains a
    nullable `projectId`; a project-targeted expedition writes its notes,
    tags, and connections into the project scope (provenance rows
    unchanged). Launchable from the Spitball room ("into project X") and
    from the project's Knowledge tab; budgets are charged to the user who
    launched it.
- **Reading it**: a **Knowledge tab** in the project view reuses the
  Spitball Map components (`GraphCanvas`, notes list) against the project
  scope; the chat-dock manifest (§11) gains a top-K retrieval slice
  (salient nodes + tag summary) so project knowledge grounds every dock
  turn without tool rounds.
- **Collaboration interplay** (with Phase 7): members read and write the
  project graph like the owner; graph content is *project* data, not any
  member's personal data — a member's `/forget-me` does not carve nodes
  out of it (nodes are distilled, not authored rows), while the owner's
  erasure (or project deletion) drops the whole scope: delete
  `kg_nodes`/`kg_tags` (cascading edges/tags/provenance) where
  `scopeKey = 'PROJECT:<id>'`, wired into the same deletion path that
  removes the workspace. `privacyService.auditUser` counts project-scope
  nodes under the owner.
- **Ordering**: Phase 8 does not depend on Phase 7 — a single-owner
  project graph is complete on its own, and Phase 7 only widens who may
  touch it. The two can land in either order.

## 14. The project parlor: group chat for projects (Phase 9)

Supersedes the per-member chat rule in §12.2. Project chat becomes a
**group discussion with every member at the table plus a built-in Goobster
seat** — implemented by linking each project to an auto-managed Parlor
conversation and rendering a slim parlor view in the chat dock. The Parlor
already has the hard parts: multi-user membership with snapshot
attribution, persona seats, a reply workflow grounded in a knowledge-graph
scope, and tool attachments on messages.

### 14.1 Linkage and lifecycle

- `parlor_conversations` gains a nullable `projectId` (column migration;
  one linked conversation per project, enforced in the service). The
  conversation's owner is the project owner; its title tracks
  `🔭 <project name>`.
- **Created lazily** — first open of the project chat tab (or first
  accepted member invite) creates it, seats the Goobster persona, and
  adds every current member. Solo projects get one too (owner + Goobster
  seat): one chat model for every project, not two.
- **Membership syncs one way**: project membership is the source of
  truth. Accepting a project invite adds the parlor member row; leave or
  removal deletes it. Direct parlor member management is disabled on
  linked conversations, and they are exempt from
  `MAX_MEMBERS_PER_CONVERSATION` — they follow `maxMembersPerProject`.
- Deleting the project (or owner `/forget-me`) cascades the conversation;
  member `/forget-me` deletes their authored messages and membership (the
  existing parlor erasure rules, unchanged).

### 14.2 The Goobster seat

- A per-owner **built-in persona** (`parlor_personas` gains a `builtin`
  flag): auto-created, undeletable, excluded from the persona cap, the
  standard Goobster identity/voice.
- **In a linked conversation its knowledge workspace IS the project
  Spitball**: retrieval and write-back target
  `scopeKey = 'PROJECT:<projectId>'` instead of a `PARLOR:<personaId>`
  workspace — the Phase 8 graph and the parlor's retrieve → generate →
  write-back workflow are the same machinery meeting in the middle.
  Discussion at the table becomes project knowledge; project knowledge
  grounds the discussion.
- **Tool powers**: when a message addresses the Goobster seat with
  actionable instructions, its reply runs the full agent loop with the
  `observatory` tool (the dock's existing pipeline) — **acting as the
  member who addressed it** (Phase 7 actor resolution), so a member can
  never make Goobster perform owner-reserved actions. Tool activity and
  produced files land on the reply via the existing
  `parlor_messages.attachments` column. One Goobster turn at a time per
  conversation (a per-conversation lock alongside the per-user lock).
- **Custom personas still welcome**: the owner may seat their own
  personas (up to the participant cap) — an architect or critic persona
  joins project chat; their workspaces remain their own.

### 14.3 The dock and knowledge routing

- `ProjectChatDock` renders the **slim parlor view**: the transcript with
  member and persona attribution, the composer, and persona nudges —
  reusing the Parlor room's components, not duplicating them. Existing
  per-member `🔭` conversations stay readable in the Chat pane as
  history; new project chat happens at the table.
- Phase 8's consolidation routing extends here: project-parlor turns
  consolidate into the project scope (the Goobster seat's write-back
  already does most of this; consolidation stays the safety net).
- Live updates ride the existing parlor refresh machinery plus the portal
  event-bus fan-out to all members (§12.2).

## 15. Open questions

1. **Room naming**: keep the 🔭 Observatory identity for the merged room,
   or rename to "Projects"? (Cosmetic, but it decides the docs' voice.)
2. **`fetch_data` as a trigger action**: recurring host-side downloads are
   the one action with standing network consent implications. Proposal:
   allow it only for hosts on `sandbox.fetchAllowedHosts` (standing
   operator consent); off-list hosts can't be automated, period.
3. **Sharing apps**: should the per-project share link ever serve an `app`
   asset (a public URL for a mini-app)? Deliberately out of scope here —
   the snapshot-dashboard share model stays — but worth a follow-up design
   if wanted.
4. **Note assets**: worth shipping in Phase 1 for near-zero cost, or cut
   `kind='note'` until asked for?
5. **Member-erasure depth (Phase 7)**: the spec follows the parlor
   precedent (delete authored versions/jobs on `/forget-me`, repairing
   heads). The softer alternative — keep the rows, null the attribution —
   preserves shared work but weakens the erasure story. Decide before
   Phase 7 ships.
6. **Trigger `agent_prompt` in shared projects (Phase 7)**: agent turns
   fired by a trigger run under the owner's identity today. Fine while
   the owner writes the prompts — but a member-authored `agent_prompt`
   runs *as the owner*. Restrict `agent_prompt` creation/editing to the
   owner, or run it under the creating member? (Spec default until
   decided: owner-only for `agent_prompt`; deterministic actions stay
   member-editable.)
7. **Expedition scope guard (Phase 8)**: should a project-targeted
   expedition be launchable by any member or only the owner? (Spec
   default: any member — it writes project data through the legalizer,
   same as any other member write; budgets charge the launcher.)
8. **Goobster-seat trigger rule (Phase 9)**: run an agent turn on every
   user message, or only when explicitly addressed/nudged? (Spec
   default: explicit address or nudge — a group chat where every message
   fires an agent turn is noisy and expensive; plain discussion still
   gets the grounded persona reply via the normal should-respond gate.)
9. **Per-member dock conversations after Phase 9**: keep them creatable
   (a private aside with Goobster about the project) or freeze them as
   history? (Spec default: freeze — one chat surface per project; private
   questions belong in the member's normal Study chat.)
10. **Project parlor voice**: Parlor Live for the project table is
    attractive but out of scope until the text table proves itself.
