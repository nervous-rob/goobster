# Projects

A **Project** is the per-user aggregate for one piece of work: a durable
workspace, versioned source assets (apps, scripts, notes), checkpointed
jobs, and project-scoped triggers. The Observatory *is* this feature —
grown until the Workshop inbox and the scheduling glue fit inside it.
The `observatory` tool, `observatory_*` tables, and `/api/app/observatory/*`
routes are unchanged; `projectService.js` is the service-layer name
(`observatoryService.js` is a thin re-export).

- Service: `services/projectService.js` (projects, workspace, jobs, quota)
- Assets: `services/projectAssetService.js`
- Triggers: `services/projectTriggerService.js`
- Config: `config/observatoryConfig.js` (env-first, then `config.json`, then defaults)
- Tool: `observatory` in `utils/toolsRegistry.js` (also registered as `project`)
- Tables: `observatory_projects`, `observatory_jobs`, `project_assets`,
  `project_asset_versions`, `project_triggers`, `project_members`,
  `project_invites` in `db/schema.sql`
- Portal: the 🔭 Observatory room (`apps/web/src/rooms/ObservatoryRoom.tsx`)
  with an Inbox for leftover Workshop pins and Study discoveries

The older [`observatory.md`](observatory.md) is a pointer here.

## Enabling it

Off by default, and it additionally requires the sandbox itself to be on —
a project grants **persistence, never new execution powers**:

```json
"sandbox":     { "enabled": true, "scope": "web" },
"observatory": { "enabled": true, "scope": "web" }
```

- `GOOBSTER_OBSERVATORY_ENABLED=1` — master switch (equivalent to `observatory.enabled`).
- `GOOBSTER_OBSERVATORY_SCOPE=web|everywhere` — where the tool is offered
  (`web`, the default, limits it to the authenticated web app chat).
- `GOOBSTER_OBSERVATORY_FFMPEG=/path/to/ffmpeg` — render-pipeline binary.

When disabled (or when the sandbox is disabled), the tool is **not registered
at all**. It is never added to the voice tool subset.

**Unattended automation runs count as a trusted surface** for the `web`
scope (both for the sandbox and the Observatory): an automation or
project trigger created to drive a project executes as a Discord-delivered
pseudo-interaction, and without this rule its runs could never touch the
very project they were created for.

## What a project owns

### Workspace

A named, per-user directory at `data/sandbox/projects/<userId>/<slug>/`
(mode `0700`, same posture as the per-run sandbox dirs). Portal writes
(`PUT`/`DELETE /api/app/projects/:slug/content/*`) land here too — same
quota, same `legalizeWorkspacePath` helper the reader uses (traversal +
symlink refusal, workspace-relative only). Every run belonging to the
project keeps its normal throwaway run directory as its working
directory, **plus** the workspace:

- In bwrap isolation the workspace is bind-mounted **read-write** — the only
  writable path beyond the run dir. In unshare/rlimits fallback modes the
  same path is reachable directly.
- The snippet finds it via **`$GOOBSTER_PROJECT_DIR`**. Anything written
  there survives between runs; anything written to the cwd is collected and
  attached to the chat like a normal `runCode` output, then pruned.

**Reading files from chat.** Prefer observatory action `read` (workspace-
relative `path`, optional 1-based `offset` + line `limit`) over `run` +
`cat`/`head`/`sed`. The result is a line window (default 400, max 800)
with a `nextOffset` when more remains — the same window `get_asset`,
`readGithubFile`, and `readNotionPage` use. Caps live in
`utils/toolResultWindow.js` and are shared with transcript storage and
`PRIOR TOOL RESULTS`, so a window the model just saw is not silently
recut on the next turn. `run` / `run_script` stdout and stderr are
clipped at 32k each (the sandbox still caps pipes at 64 KB); job
`status` still shows a short tail — write full logs into the workspace
and `read` them.

Isolation, rlimits, scrubbed environment, wall-clock timeout, byte-capped
output, concurrency slots, and per-user rate limits all come from the
sandbox. See [code_sandbox.md](code_sandbox.md) for the Python toolkit
(`npm run sandbox-python`) and [the fetch-data contract](#getting-real-data-in-fetch-data).

### Assets

Named, *versioned* source artifacts stored in the database (never the
workspace — the portal and the split-deployment `apps/api` can render
without touching the bot's disk, and snippet-writable files are never
served as trusted app source):

- `app` — frontend mini-app source (`html` / `svg`), rendered in the portal
  sandbox exactly like today's applets
- `script` — backend/data-engineering code (`python` / `javascript`),
  runnable as a foreground run or a checkpointed background job
- `note` — freeform markdown (README, run log, findings)

An asset is a stable identity (`dashboard`, `ingest`, `readme`); a version
is an immutable snapshot. Editing inserts a new version and moves the head
pointer; rollback moves the pointer back. Caps (clamped, `observatoryConfig`
pattern): source ≤ 200 KB/version, `maxAssetsPerProject` (default 20),
`maxVersionsPerAsset` (default 50 — oldest non-head versions pruned).
Identical-source saves are a no-op (content-hash vs head). Origins:
`chat`, `portal`, `agent`, `migration`.

### Jobs

The existing checkpointed background runs, with provenance: a job can
record *which asset version* it executed (`assetVersionId`) and what
started it (`startedBy`: `chat` | `portal` | `trigger` | `resume`). `code`
stays on the job row — resume needs it verbatim even if the asset is later
edited or pruned.

### Triggers

Project-scoped automations with first-class actions, so "run my ingest
script nightly" is deterministic — no agent turn, no prompt, no token
spend:

- **Cron** (5-field, UTC) joins the existing automation minute loop (same
  singleton lock, same atomic claim-by-advancing-`nextRun`, same
  disable-on-unparseable-schedule).
- **Event** (`job_completed` | `job_failed` | `job_settled`) evaluates
  from DB state on the job settle path; a startup sweep catches jobs
  settled while the process was down. Events are hints, never the source
  of truth.
- **Actions**: `run_script` (head version at fire time), `render`,
  `fetch_data` (allowlisted hosts only), `agent_prompt` (the Observatory-
  command machinery). Chain-depth and self-chain guards prevent runaway
  loops.

The guild/channel `automations` table is left alone — it still serves
scheduled conversational prompts in Discord scopes.

## Own-project reads (the applet bridge)

An `app` asset rendered from **inside** project X gets implicit read
access to X's workspace through the existing owner-only content route
(`GET /api/app/observatory/projects/:slug/content/*`). No
`goobster-observatory-read` meta tag and no grant dialog. The parent
bridge (`apps/web/src/renderers/appletBridge.js`) and the matching
core check (`isObservatoryReadAllowed` in `utils/appletCapabilities.js`)
short-circuit on the own-project slug.

Cross-project reads (asset in X reading Y) still require the meta tag
plus an approved grant, stored on the asset as `grantsJson`. Legacy
Workshop pins (non-project applets) omit `ownProject` and keep today's
declare+grant behavior.

Mini-apps still cannot fetch `/api/app` themselves: they call
`connectToGoobster()` / `request(port, { type: 'observatory.read', ... })`
and the trusted parent fetches with the signed-in session.

## Inbox (the former Workshop)

The Observatory room list view has an **Inbox**: unpinned html/svg fences
discovered in Study chats, plus leftover `web_applets` pins (marked
Migrated when the Phase 2 startup migration copied them into a `workshop`
project). Each item can be **promoted to a project** (new asset or new
version of an existing one). Pinning still works during this deprecation
window; `web_applets` and its routes stay until a later release. The
separate Workshop nav entry is gone; `/workshop` redirects here.

## The portal pane

Shown only when the feature is enabled, laid out master-detail:

- **The project list** — size, running/total job counts, share state, last
  activity — plus the Inbox.
- **The project view** — Overview (status chips, quota, latest render, job
  timeline, gallery), **Explorer** (repo-style tree), Apps (rendered applet
  with version picker + rollback; own-project reads implicit), Automations
  (trigger list: schedule/event, action, last outcome, enable/disable),
  **Knowledge** (project Spitball map + notes + expedition launch),
  ✨ Command.
- **Explorer** has two honest roots. `assets/` is the DB-backed, versioned
  source (apps / scripts / notes) with a version-history rail, client-side
  diffs (`diff`), rollback, and CodeMirror 6 editing. Save goes through
  `projectAssetService.save` with `origin='portal'` — same caps, hash
  dedupe, and pruning as the tool. `workspace/` is the on-disk tree,
  listed lazily via `listFiles({ path })`. Text files edit in CodeMirror;
  images and video play inline; binaries download through the owner-only
  content route. PUT/DELETE `/api/app/projects/:slug/content/*` write
  that same quota'd sandbox (multipart for binaries). A ▶ Run button on
  script assets calls `POST .../assets/:asset/run` with the head version
  and `startedBy='portal'`.
- **Project chat dock** is the Command seat grown up: a collapsible
  right-hand panel (bottom-sheet on narrow viewports) bound to the
  dedicated `🔭 <project>` conversation. Turns post to
  `POST /api/app/projects/:slug/chat` (the old `/api/app/observatory/command`
  route is an alias) — same startTurn lock, observatory tool, and chat SSE
  vocabulary. The preamble includes a compact, size-bounded project
  manifest (assets, triggers, latest job, workspace top-level, a top-K
  slice of project knowledge). The same
  conversation stays visible in the Chat pane. Mutations (asset save,
  trigger change, workspace write, job start/settle) publish
  `project-changed` on `eventBusService` so the open explorer and version
  rails refetch.

### Dashboard artifact and share links

Every run regenerates a self-contained HTML **results dashboard** (job
timeline, latest render, gallery, checkpoint, file table, quota) stored
**outside** the workspace at `data/sandbox/dashboards/<userId>/<slug>.html`.
The workspace is snippet-writable, so a run-authored `dashboard.html`
there is listed like any file and never served as the trusted page.
Media is inlined as base64 (extension-checked, size-capped). Every
dynamic string is HTML-escaped; a strict CSP meta tag pins what the
page may do.

- **Owner**: `GET /api/app/observatory/projects/:slug/dashboard`
  (`?fresh=1` forces). Control buttons appear only for the signed-in
  owner on the bot's origin.
- **Share link**: one revocable read-only URL per project
  (`/app/observatory/share/<token>`, `observatory_share_links`; the
  unguessable token is the capability). Revoking, deleting the project,
  disabling the feature, or `/forget-me` kills the URL.

Applet content reads (`GET /api/app/observatory/projects/:slug/content/*`,
`projectService.readWorkspaceFile`) are owner-only, authenticated, and
**not** share-link infrastructure. Traversal, escaping symlinks,
directories, oversized files, and unsupported types are refused.

## Getting real data in (`fetch-data`)

Sandbox runs have **no network** — that never changes. The `fetch-data`
action downloads a file *host-side* into the project workspace at
`data/<file>`. The model only proposes a URL; `utils/safeFetch` legalizes
the transfer (https only, DNS pinned to public addresses, byte-capped,
no overwrite). Hosts on `sandbox.fetchAllowedHosts` fetch immediately;
any other host becomes a pending `sandbox_requests` row for configured
approvers. Trigger `fetch_data` actions are allowlisted-hosts only.

## Background jobs and the checkpoint convention

`action: "run"` with `background: true` detaches the run into a job.
The engine runs the same snippet in *segments* — each a fully legalized
sandbox run. Resume is a documented convention, not magic:

1. Load `$GOOBSTER_PROJECT_DIR/checkpoint.json` when it exists.
2. Rewrite it as work progresses.
3. A segment killed at the timeout wall resumes only if the checkpoint
   advanced — up to `maxResumes` times.
4. Exit 0 completes; non-zero fails; timeout with no checkpoint progress
   is terminal.

Jobs found `RUNNING` with no live handle after a restart are reaped to
`INTERRUPTED` and auto-resumed when a checkpoint exists
(`projectService.autoResumeInterrupted`). A busy sandbox defers a
segment instead of failing the job. Completion files a follow-up in the
user's DM scope.

## Limits

Same clamping contract as the sandbox (`tests/observatoryConfig.test.js`):

| Knob | Default | Floor | Ceiling |
| --- | --- | --- | --- |
| `maxProjectsPerUser` | 5 | 1 | 200 |
| `maxProjectMb` (per-project disk quota) | 1,024 | 1 | 102,400 |
| `maxActiveJobsPerUser` | 1 | 1 | 50 |
| `maxResumes` | 12 | 0 | 500 |
| `maxAssetsPerProject` | 20 | 1 | 200 |
| `maxVersionsPerAsset` | 50 | 1 | 500 |
| `maxWorkspaceFiles` (per listing) | 50 | 1 | 5,000 |
| `maxWorkspaceReadMb` | 8 | 1 | 32 |
| `maxUploadMb` (one portal write) | 50 | 1 | 2,048 |
| `maxRenderFrames` | 2,000 | 2 | 100,000 |
| `renderFps` | 24 | 1 | 120 |
| `maxMembersPerProject` | 5 | 1 | 50 |

The disk quota is enforced **before** every run, segment, and portal
workspace write. `maxUploadMb` is a second ceiling on a single PUT.

## Collaboration

The owner invites collaborators from the project page (or the
`invite_user` tool action). Invitees get a Discord DM with Accept/Decline
buttons and a portal invitation entry — the same delivery shape as parlor
invites. Owners remove members; members can leave. There is no ownership
transfer.

Actor resolution is own-first (`resolveProjectForActor`): owned projects
win, then memberships. An optional `?owner=` / tool `owner` qualifier
disambiguates a slug the actor can see on more than one project. Portal
lists carry `ownerId` and owner display name on every row.

Owner-reserved: delete the project, invite/revoke/remove members, mint
or revoke share links. Everything else is member-accessible.
`agent_prompt` triggers are owner-only to create or edit (they execute as
the owner); deterministic trigger actions stay member-editable. Triggers
fire under the owner's identity and record `createdBy`. Version and job
`userId` is the actor; per-action limits charge the actor; per-project
quotas stay on the project; `maxProjectsPerUser` counts owned projects
only. The workspace path stays under the owner's directory.

Each member's chat dock binds to their own `🔭 <project>` conversation in
their own DM scope. Job-completion follow-ups go to the actor.

## Knowledge (the project Spitball)

Each project has its own knowledge graph in the existing `kg_*` tables
at `guildId = dm:<ownerId>`, `scopeKey = PROJECT:<projectId>` — the same
partitioning personas use (`PARLOR:<id>`). Every write goes through
`knowledgeGraphService.applyMutations`. Members may `note_knowledge` and
`recall_knowledge` on the observatory tool. Chat-dock turns in a
project's dedicated 🔭 conversation consolidate into the project scope
instead of the personal scope.

Expeditions can target a project (`spitball_expeditions.projectId`):
notes, tags, and edges land in the project scope with unchanged
provenance. Any member may launch one; budgets charge the launcher.
Launch from the Spitball room ("into project X") or the project's
Knowledge tab.

## Privacy

Projects, jobs, share links, assets, versions, triggers, memberships,
and invites are personal data. `/what-do-you-know-about-me` reports
owned and collaborated projects. Owner `/forget-me` deletes the whole
project (rows, workspace, dashboards, share links, memberships, invites,
and the `PROJECT:<id>` knowledge scope) and DMs members that it is gone.
Member `/forget-me` deletes their memberships, invites addressed to
them, authored asset versions (repairing each asset's head; deleting an
asset left with zero versions), and authored jobs — workspace files and
project-scope graph nodes stay (they are project data).
`privacyService.auditUser` counts memberships, invites, authored rows in
shared projects, and project-scope nodes under the owner. `web_applets`
stays on the erasure path until that table retires.

## Tests

`tests/observatoryConfig.test.js` (clamping),
`tests/observatoryService.test.js` / `tests/projectService.test.js`
(projects, quota, jobs, erasure, re-export parity),
`tests/projectAssetService.test.js` / `tests/projectAssetApi.test.js`
(versioning, pruning, rollback, dedupe, API auth),
`tests/projectTriggerService.test.js` / `tests/projectTriggerApi.test.js`
(cron claim, event fire, catch-up, chain-depth),
`tests/appletCapabilities.test.js` / `tests/appletCapabilityApi.test.js`
(own- vs cross-project grant resolution + content route),
`tests/workshopPinMigration.test.js` (pin → asset migration),
`tests/projectWorkspaceWrite.test.js` / `tests/projectWorkspaceApi.test.js`
(path legalization, quota, portal-origin versions, run-from-UI, erasure),
`tests/projectChat.test.js` (conversation binding, manifest truncation,
turn lock, refetch hints),
`tests/toolsRegistryObservatory.test.js` (tool gating, `read` windows),
`tests/toolResultWindow.test.js` (shared line-window / clip caps),
`tests/projectCollaboration.test.js` (actor resolution, invites, member
erasure),
`tests/projectKnowledge.test.js` (project graph scope, legalizer writes,
consolidation routing, expeditions, Knowledge-tab auth).
