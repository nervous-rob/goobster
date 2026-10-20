---
feature: projects
---

# Projects

A **Project** is the per-user aggregate for one piece of work: a durable
workspace with git-backed history, GitHub repositories cloned beside it,
versioned source assets (apps, scripts, notes), checkpointed jobs, and
project-scoped triggers. The Observatory *is* this feature —
grown until the Workshop inbox and the scheduling glue fit inside it.
The `observatory` tool, `observatory_*` tables, and `/api/app/observatory/*`
routes are unchanged; `projectService.js` is the service-layer name
(`observatoryService.js` is a thin re-export).

- Service: `services/projectService.js` (projects, workspace, jobs, quota)
- Assets: `services/projectAssetService.js`
- Workspace history: `services/projectHistoryService.js` (ADR 0014)
- Repositories: `services/projectRepoService.js` (ADR 0015); both on
  `utils/sealedGit.js`, host-side git only
- Triggers: `services/projectTriggerService.js`
- Config: `config/observatoryConfig.js` (env-first, then `config.json`, then defaults)
- Tool: `observatory` in `utils/toolsRegistry.js` (also registered as `project`)
- Tables: `observatory_projects`, `observatory_jobs`, `project_assets`,
  `project_asset_versions`, `project_triggers`, `project_members`,
  `project_invites`, `project_missions` (+ steps/evidence/events),
  `project_decisions`, `project_repos` in `db/schema.sql`; workspace
  history lives on disk beside the workspace, not in a table
- Portal: the **Projects** room (`/projects`, secondary name "the
  Observatory"; `apps/web/src/rooms/projects/*`) - the list with a direct
  create form, one project per owner-qualified address, eleven registered
  views, and **Unfiled apps** for leftover Workshop pins and Study discoveries

The older [`observatory.md`](observatory.md) is a pointer here.

## Enabling it

Projects have two switches, decided in
[ADR 0009](adr/0009-project-organization-contract.md):

**Organizing projects** (`projects.enabled`, **on by default**) - creating,
listing, opening and deleting; members and invitations; workspace files and
assets; plans; knowledge; automations (defining them); run history;
dashboards and share links; the project conversation. This is what the
Projects room needs, and it is reported to the portal as
`me.features.projects`. Turn it off with `GOOBSTER_PROJECTS_ENABLED=0` or
`"projects": { "enabled": false }` to have no Projects room at all.

**Running code in projects** (`observatory.enabled`, off by default, and it
additionally requires the sandbox itself to be on - a project grants
**persistence, never new execution powers**):

```json
"sandbox":     { "enabled": true, "scope": "web" },
"observatory": { "enabled": true, "scope": "web" }
```

- `GOOBSTER_OBSERVATORY_ENABLED=1` — execution switch (equivalent to `observatory.enabled`).
- `GOOBSTER_OBSERVATORY_SCOPE=web|everywhere` — where the tool is offered
  (`web`, the default, limits it to the authenticated web app chat).
- `GOOBSTER_OBSERVATORY_FFMPEG=/path/to/ffmpeg` — render-pipeline binary.

Execution covers starting or resuming a run, rendering, `fetch-data`, the
✨ Command / project-chat agent turn (it exists to drive the `observatory`
tool) and the trigger runner's dispatch. It is reported as
`me.features.observatory`. When it is off (or the sandbox is), the tool is
**not registered at all** and those controls explain locally, on the
control itself, that code execution is off on this installation; everything
else in the room keeps working. It is never added to the voice tool subset.

In code: `ObservatoryService.organizationEnabled` and
`ObservatoryService.executionEnabled` (`enabled` stays as an alias of the
latter for the tool registry and the agent tool). Organization methods call
`_requireOrganization()`; execution methods keep `_requireEnabled()`, which
checks both.

**Unattended automation runs count as a trusted surface** for the `web`
scope (both for the sandbox and the Observatory): an automation or
project trigger created to drive a project executes as a Discord-delivered
pseudo-interaction, and without this rule its runs could never touch the
very project they were created for.

## What a project owns

### Project instructions (GOOBSTER.md)

A `GOOBSTER.md` at the workspace root is the project's standing
instructions for Goobster: how to run and test it, conventions, what not
to touch. It is an ordinary workspace file (edited in Files, versioned by
workspace history, visible to every member) and is read into **every
agent turn on the project**: the ✨ Command preamble (`buildChatManifest`),
the built-in Goobster seat in the project's conversations, trigger
`agent_prompt` turns and CI-watch fix turns (`projectTriggerService.runAgentPrompt`).
At most 6,000 characters are carried (the rest is noted as cut). The block
says that the person asking still decides and that the file never
overrides safety rules, and it points the model at a clone's own
`AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`. The Overview offers *Add
GOOBSTER.md* (a short template) when there is none.
`GET /api/app/projects/:slug/instructions` returns it for any member.

### Workspace search

The Files view has a search box, and the observatory tool a `search` action
(`query=`, optional `path=` for a folder or file):
`GET /api/app/projects/:slug/search?q=&path=`. Case-insensitive literal
text, host-side, bounded: at most 3,000 files scanned, 200 hits (20 per
file), files over 1 MB and binary files skipped, `node_modules`,
`__pycache__`, virtualenvs, `.git`, `dist`, `build`, `target` and caches
not entered, symlinks never followed. It also lists files whose names
match. Queries are 2-200 characters.

### Workspace

A named, per-user directory at `data/sandbox/projects/<userId>/<slug>/`
(mode `0700`, same posture as the per-run sandbox dirs). Portal writes
(`PUT`/`DELETE /api/app/projects/:slug/content/*`) land here too — same
quota, same `legalizeWorkspacePath` helper the reader uses (traversal +
symlink refusal, workspace-relative only). Every run belonging to the
project — foreground runs and background job segments alike — works in
the workspace:

- In bwrap isolation the workspace is bind-mounted **read-write** — the only
  writable path. In unshare/rlimits fallback modes the same path is
  reachable directly.
- The snippet finds it via **`$GOOBSTER_PROJECT_DIR`**. Anything written
  there survives between runs.
- **The working directory is the project's `scratch/` folder**
  (`SCRATCH_DIR` in `utils/projectSetupContract.js`), and it is also `HOME`,
  `TMPDIR`, and — under bwrap — `/tmp`. It persists across runs, jobs, and
  every conversation working on the project, for as long as the project
  exists: build an environment or unpack a dataset once and every later
  run, from any chat or collaborator, starts where the last one stopped
  (sandbox runs have no network; a repository arrives through
  [Repositories](#repositories), a `fetch-data` download or a portal
  upload, never a `git clone` inside a run). It is never pruned on
  a timer; it counts toward the project's disk quota, shows in the file
  explorer, and goes when the project is deleted (or by `/forget-me` for
  the owner). Files a run creates or changes in it are
  still attached to the chat like a normal `runCode` output, from a
  per-run copy. One run at a time per project, as before.

**Orienting from chat.** Prefer observatory action `inspect` (project slug)
for a one-call overview — mission, assets, triggers, recent jobs with
tails, workspace, checkpoint, knowledge, and members — before chaining
`status` / `files` / `list_assets` / `list_triggers` / `mission get`.
Deep dives still use those actions. `inspect` restates the setup contract
from `utils/projectSetupContract.js` (`$GOOBSTER_PROJECT_DIR` vs
`$GOOBSTER_RUN_DIR`).

**Auditing legacy projects.** Action `audit` (one project, or omit
`project` to audit all) recomputes setup-contract findings: root
`checkpoint.json` / `frames/`, scripts that still write under
`$GOOBSTER_PROJECT_DIR`, and `legacyWorkspace` jobs. Findings are not
stored — they are derived from disk + assets. Portal:
`GET /api/app/projects/:slug/setup-audit`.

**Needs you (review board).** Cross-project queue of human gates —
approve a draft mission, answer multiple-choice human steps, unblock
failed steps, complete a review, and setup findings. Portal Observatory
list shows a **Needs you** board (filterable); tool action `needs-you`
returns the same cards. Human steps may carry
`actionParams.choices` (portal radios / `selectedId` on complete). This
stays on Missions + Observatory — not a new room.

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

### Workspace history

The workspace has **history**: a git repository the host process keeps
**beside** it, at `data/sandbox/projects/<owner>/<slug>.git`, decided in
[ADR 0014](adr/0014-workspace-history.md). It fills the one hole the asset
layer leaves - a run that overwrote `data/results.csv` used to lose the old
bytes for good - without touching how assets work.

- **Snapshots are automatic.** One is taken after every run and background
  job settles (`run #12 completed`, `job #14 failed (exit 1)`), after every
  portal save, upload or delete (`wrote data/a.csv`, `deleted old.txt`),
  after `fetch-data` lands a file, after a chat's files move into
  `scratch/`, and around every restore. Identical trees are a no-op. The
  tool's `commit` action (and 📸 **Snapshot now** in the portal) takes one
  on demand with a note.
- **Reading it.** Tool actions `history` (newest first, optional `path=`
  to see only snapshots touching a file; `inspect` shows the latest
  three), `diff` (no `rev`: the workspace against the latest snapshot;
  `rev`: what that snapshot changed; `rev` + `to`: between two snapshots,
  `to=workspace` for the current files), and `read` with `rev=` for a file
  as it was. The portal Files view has a **Snapshots** rail on every
  workspace file and directory with the same diff, a download at that
  snapshot, and a restore. API: `GET /api/app/projects/:slug/history`
  (`?path=&limit=`; always answers, with `enabled: false` and a `reason`
  when history is off), `GET .../history/diff?rev=&to=&path=`,
  `GET .../history/:rev/content/*`, `POST .../history/:rev/restore
  { path? }`, `POST .../history/commit { message }`.
- **Restore is reversible.** `restore rev=<hash> [path=]` puts one path
  (or, with no path, the whole workspace) back as it was. The current
  state is snapshotted first (`before restoring …`), the result is
  recorded as a new snapshot (`restored … from <hash>`), so a restore can
  itself be restored. A whole-workspace restore removes files the snapshot
  did not have; a path restore only writes the files under that path.
  A restore that would put the workspace over its quota is rolled back
  with `QUOTA_EXCEEDED`.
- **Never the sandbox.** Every git call is made by the bot (or `apps/api`
  in standalone mode) with a sealed environment: explicit `GIT_DIR` and
  `GIT_WORK_TREE`, `HOME` inside the git dir, no system or global config,
  no hooks, no pager, no prompts, `core.symlinks=false` so a snapshot can
  never plant a symlink on restore. The sandbox bind-mounts only the
  workspace, so a snippet can neither read nor damage history. There is
  **no remote, no credential and no network**: cloning and pushing are a
  separate decision (ADR 0014 §"Out of scope"). Revisions are a short hash
  or `HEAD` (never a flag or a ref name) and paths go through the same
  legalizer as every other workspace read.
- **What stays out.** `runs/*/frames/`, `frames/`, `renders/`, interpreter
  caches (`__pycache__/`, `*.pyc`, `node_modules/`, `.venv/`), the
  sandbox's hidden run sources, and any file over
  `observatory.historyMaxFileMb` (default 8 MB). The exclude list is
  rewritten by Goobster before every snapshot.
- **Budget.** History does not count toward the workspace quota; it has
  its own `observatory.historyMaxMb` (default 256 MB). Past it, the
  repository is packed, then **squashed to one snapshot**; if even one
  snapshot is over budget, snapshots **pause** (the listing says so) until
  the workspace shrinks.
- **Who.** A snapshot's author is a project-scoped pseudonym (a hash of
  the project id and the user id), never a Discord id or a name. Names are
  resolved when history is read, against the current owner and members,
  so a collaborator erased by `/forget-me` reads as *former collaborator*
  with nothing rewritten. Commit messages name files, job ids and
  outcomes - never code, output, prompts or replies.
- **Switches.** On by default. `GOOBSTER_PROJECT_HISTORY_ENABLED=0` or
  `"observatory": { "historyEnabled": false }` turns it off;
  `observatory.gitCommand` (`GOOBSTER_OBSERVATORY_GIT`) names the binary.
  Without git on the host the feature is off with one startup warning,
  the listing answers `reason: "GIT_MISSING"`, and the tool and portal say
  so - projects keep working. `git` is a system dependency of the
  `projects` feature in the catalog (`documentation/features.md`) and is
  installed by the Docker images and `scripts/install-rpi.sh`.
- **Erasure.** Deleting the project removes its history directory; owner
  `/forget-me` removes the whole `data/sandbox/projects/<owner>/` tree,
  history included.

### Repositories

A project can hold **GitHub clones** at `repos/<name>`, decided in
[ADR 0015](adr/0015-project-repositories.md). They are driven by the host
with the **person's own connected GitHub account** (Settings →
Connections), never the server's token and never from the sandbox.

- **Your account, your allowlist.** Clone, pull, push and the branch
  lookup use the token of the person asking, handed to git through a
  credential helper that reads it from the environment of that one call
  (never a URL, a command line or a file). No connected account is a
  clear `NO_GITHUB` refusal. The personal repository allowlist from
  Settings → Connections applies to clones and pushes the way it applies
  to the GitHub chat tools.
- **Where it lives.** The clone's git directory is a sibling of the
  workspace (`data/sandbox/projects/<owner>/<slug>.repos/<name>.git`); its
  work tree is `workspace/repos/<name>`, plain files to runs (reachable at
  `$GOOBSTER_PROJECT_DIR/repos/<name>`), to the portal and to
  [workspace history](#workspace-history), which snapshots them like any
  other file (honouring the clone's own `.gitignore`). There is never a
  `.git` inside the workspace.
- **Actions.** Tool: `repo_clone` (`repo=owner/name` or a github.com URL,
  optional `branch=` and `name=`), `repo_list`, `repo_status` (branch,
  upstream, ahead/behind, uncommitted changes, recent commits),
  `repo_pull` (fetch + fast-forward only), `repo_commit` (stage everything
  in the clone, `note=` is the message, authored as the person's GitHub
  identity `<id>+<login>@users.noreply.github.com`), `repo_push` (the
  current branch, or HEAD to `branch=`; never forced; pushing a branch
  other than the cloned one returns the compare URL for a pull request),
  `repo_branch` (switch, creating the branch when it exists nowhere),
  `repo_reset` (back to origin, discarding local commits and changes),
  `repo_remove`. Branch management and review: `repo_branches` (local and
  GitHub branches, which is active, ahead/behind the base), `repo_compare`
  (`branch=` head, `base=`: commits, files, counts and a capped diff),
  `repo_prs` (the repository's open pull requests with CI verdicts),
  `repo_pr` (open a pull request: `branch=` head, `base=`, `note=` title,
  `content=` body, `enabled=false` for a draft, `background=true` to push
  the branch first), `repo_ci` (check runs and statuses for `branch=` or the
  current branch: passed, pending, and each failure with its summary and
  link), `repo_watch` / `repo_unwatch` (see [CI watches](#ci-watches)).
  Combining branches: `repo_merge` and `repo_rebase` (`branch=`, the
  default is the branch the clone started from), `repo_continue` and
  `repo_abort`. Portal: the Code view (`/projects/:owner/:slug/code`) with the same
  buttons, a clone form and a "Branches · PRs · CI" detail view per clone
  (switch branch, compare two branches with a diff, open a pull request,
  see CI failures). API: `GET`/`POST /api/app/projects/:slug/repos`,
  `GET`/`DELETE .../repos/:name`, `POST .../repos/:name/{pull,commit,push,
  branch,merge,rebase,continue,abort,reset}`, `GET .../repos/:name/{branches,
  compare?base=&head=,ci?ref=,pulls}` and `POST .../repos/:name/pulls`.
  Pull-request and CI calls use the person's own GitHub token (needs
  "Pull requests: write" and "Checks: read" on the repository); when GitHub
  cannot be reached the branch list falls back to the local branches.
- **Honest about conflicts.** `repo_pull` only fast-forwards: a diverged
  branch is reported (`DIVERGED`), and the answer is `repo_merge` (or
  `repo_rebase` for commits that are still local). A merge or rebase that
  hits conflicts is left in progress: `repo_status` shows `operation` and
  the `conflicts` files, which are edited like any workspace file (remove the
  `<<<<<<<` markers), then `repo_continue` (refused with `UNRESOLVED` while
  markers remain) or `repo_abort` to put the branch back. While one is open,
  pull, commit, merge, rebase and branch switches are refused
  (`IN_PROGRESS`); `repo_reset` abandons it. A rebase is refused once its
  commits are on origin (`REBASE_PUBLISHED`): pushes are never forced, so
  merge instead. A rejected push says to pull first (`REJECTED`); a
  protected branch says to push elsewhere and open a pull request
  (`PROTECTED_BRANCH`, then `repo_pr`).
- **Reversible.** `repo_reset`, `repo_branch`, `repo_merge`, `repo_rebase` and `repo_remove` take a
  workspace snapshot first, so what they discard is one `restore` away
  (`restore rev=<hash> path=repos/<name>`).
- **Bounded.** Shallow clones (`observatory.repoCloneDepth`, default 50
  commits), one branch at a time, at most `observatory.maxReposPerProject`
  (default 3) per project, at most `observatory.repoMaxMb` (default 512 MB)
  of history per clone (checked against GitHub's reported size before the
  clone and against the git directory after). The work tree counts toward
  the project quota; a clone that would break it is undone.
- **Attributable.** Every clone and push writes an `integration_audit` row
  under the person's DM scope (project, repository, branch; never a token).
- **Switches.** On by default; needs git and the `github` feature.
  `GOOBSTER_PROJECT_REPOS_ENABLED=0` or `"observatory": { "reposEnabled":
  false }` turns it off; `repo_list` and the portal panel say why
  (`DISABLED`, `GIT_MISSING`, `GITHUB_OFF`). Git 2.31 or newer.
- **Erasure.** Deleting the project removes its clones; owner `/forget-me`
  removes the whole owner tree. A collaborator's erasure nulls
  `project_repos.createdBy`; the clone is project data and stays.
- **The Code view.** `/projects/:owner/:slug/code` lists the clones, each
  with a GitHub strip read from `GET .../repos/:name/summary` (local status
  plus, best effort, CI on the current branch and that branch's open pull
  request), the CI watch control, and the Branches · PRs · CI detail.
- **Result cards in chat.** `repo_ci`, `repo_compare`, `repo_pr` and
  `repo_merge` / `repo_rebase` / `repo_continue` return a card beside their
  text (the orchestrator's `{ _display, _card }`: the model reads only the
  text; the card rides the step and the live `tool` event, at most 16,000
  JSON characters). Study, Parlor and the project chat render it under the
  reply: a CI verdict with each failure and "Ask Goobster to fix", a merge
  or rebase stopped on conflicts with the files, Continue, Abort and "Ask
  Goobster to resolve", a comparison with its diff, an opened pull request.
  The "Ask Goobster to ..." buttons only put a request in the composer
  (`hooks/useCompose.ts`); nothing is sent for the person.

#### CI watches

`repo_watch` (or the Code view's *Watch CI* control) watches a branch of a
clone for **one person**, with **their** GitHub connection and allowlist
(`project_ci_watches`, `services/projectCiWatchService.js`). The automation
minute loop checks a few due watches per tick: the branch's head commit
from GitHub, then its check runs and statuses. When a commit's CI settles
(green or red) and that is news (a new commit, or a new verdict), the
person gets an Inbox item linking to the Code view; pending is rechecked
after two minutes, everything else after five.

- **`notify`** (default): the Inbox item only.
- **`fix`**: a red build also starts an unattended agent turn on the
  project as that person (the same runner as a trigger's `agent_prompt`,
  in their "🔭 <project>" conversation) with the failing checks and the
  steps: get the clone onto the branch and up to date, read the failure,
  fix it, run what it can, `repo_commit` and `repo_push`, never forcing,
  and say so plainly when it cannot. At most `maxFixes` (default 2, at
  most 5) attempts until the branch goes green, which resets the count; the
  Inbox item says when it has stopped trying.
- **Limits and lifecycle.** Ten watches per person per project. A watch is
  deleted with its clone or project, and on its next check when the person
  has lost access to the project; a missing GitHub connection pauses it for
  an hour. `/forget-me` deletes the person's watches. Stop one with
  `repo_unwatch` (`branch=` for one branch, else all) or the control.
- **API.** `GET`/`POST`/`DELETE /api/app/projects/:slug/repos/:name/watches`
  (`POST` body `{ branch, mode, maxFixes }`, `DELETE ?branch=`).

#### The repository editor

**Open editor** on a clone in the Code view replaces the panel with an
editor for that clone (`RepoIde`), git-aware throughout:

- **Files** is the clone's tree, loaded a folder at a time, with a status
  letter on each changed file (M modified, A added, D deleted, U untracked,
  R renamed, ! conflicted) and changed folders tinted.
- **Tabs** open files (up to 1 MB of text; binary files are refused), mark
  unsaved ones with ●, and save with Ctrl/Cmd+S into the workspace (the
  same write the Files editor uses). Leaving the page or the editor with
  unsaved tabs asks first.
- **A gutter against HEAD** marks added (green), modified (amber) and
  deleted (red) lines as you type; **Diff vs HEAD** shows the file's diff.
- **Changes** lists every uncommitted file. Clicking one opens it with its
  diff; ↺ discards it (back to HEAD, or deleted when it is new), after a
  workspace snapshot so the discard is one `restore` away. Untick files to
  commit only some of them ("Commit k file(s)"); the toolbar has Pull and
  Push and the branch with ahead/behind.
- **Ask about a selection.** Select lines and press *Ask Goobster about
  lines a–b*: the chat dock opens with a request naming the file and lines
  and quoting the selection (at most 6,000 characters, noting an unsaved
  edit). Nothing is sent until you send it. The Files editor has the same
  button for workspace files.
- **API.** `GET .../repos/:name/changes` (every changed path with its kind,
  plus branch, upstream, ahead/behind and any operation in progress),
  `GET .../repos/:name/file?path=&ref=` (a file at a revision, HEAD by
  default), `GET .../repos/:name/diff?path=` (the diff against HEAD,
  untracked files included; no path for the whole clone) and
  `POST .../repos/:name/discard { path }`. `POST .../repos/:name/commit`
  takes an optional `paths` array to commit only those files. Paths are
  relative to the clone; absolute paths, `..` and `.git` are refused
  (`BAD_PATH`).
- **Review a pull request.** The **Review** pane lists the repository's
  open pull requests (with their CI); pick one to see its reviews
  (approved, changes requested, with their summaries) and its files with
  `+/−` counts and a 💬 count per file. When the clone is on the pull
  request's branch, a file opens in the editor with every review comment
  thread marked by a 💬 in the gutter (hover for the comments, click to
  jump to the thread); otherwise the pane offers **Switch to `<branch>`**
  (refused while tabs have unsaved edits) and shows the pull request's own
  diff. A pull request from a fork can be read but not switched to. Under
  the editor the file's threads are listed (outdated ones say which line
  they were on) with **Ask Goobster to address this**, which fills the
  chat with the pull request, the place, the quoted thread and the ask to
  fix it on the branch and push (never forced). API:
  `GET .../repos/:name/pulls/:number/review` (`projectRepoService.pullRequestReview`,
  the viewer's GitHub token: files with patches capped like a comparison,
  up to 100 files and 100 inline comments, review and description texts
  capped at 4,000 characters).

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

Any member can **pin** an app to the project's Overview
(`PATCH .../assets/:asset { pinned: true|false }`, `project_assets.pinnedAt`;
apps only, `NOT_AN_APP` otherwise; at most four per project, `PIN_LIMIT`);
the pin is shared by everyone on the project and survives new versions.

### Jobs

The existing checkpointed background runs, with provenance: a job can
record *which asset version* it executed (`assetVersionId`) and what
started it (`startedBy`: `chat` | `portal` | `trigger` | `resume`). `code`
stays on the job row — resume needs it verbatim even if the asset is later
edited or pruned.

Three more columns make a settled job explain itself:

- `parentJobId` — the settled job whose event trigger started this one.
  Cron, chat, portal, and other root jobs are `NULL`. This is the *only*
  ancestry the chain-depth guard reads; it never infers a parent from
  timestamps or nearby ids.
- `errorCode` — a stable machine reason behind a terminal status:
  `EXIT_NONZERO`, `TIMED_OUT`, `CANCELLED`, `OUTPUT_CONTRACT_FAILED`,
  `RUN_ERROR`, `QUOTA_EXCEEDED`, `PROJECT_DELETED`. `NULL` for `COMPLETED`
  and for rows that predate the column.
- `outputContractJson` / `outputContractResultJson` — the declared output
  contract frozen when the job started, and the per-check verdict written
  at settlement (see [Multi-stage pipelines](#multi-stage-pipelines)).

`parentJobId`, `errorCode`, and the contract verdict appear in job detail
(`observatory status` / `inspect`, `getJob`, and the `jobs` list on
`GET /api/app/observatory/projects/:slug`); the public dashboard renders
only status, exit code, and tails.

**A failed run** (`FAILED` or `TIMED_OUT`) offers three things in Runs and
on the Overview:

- **Run again**: `POST /api/app/observatory/jobs/:jobId/rerun` starts the
  same language and code (and asset version) as a new background job
  (`startedBy: portal`); refused while the original is still running, and
  needs code execution like any run.
- **Ask Goobster why**: opens the project chat with a request naming the run
  pre-filled in the composer (it is not sent for you).
- **Changes since the last good run**: `GET /api/app/observatory/jobs/:jobId/changes`
  finds the latest earlier run of the project that completed and the
  workspace snapshots taken after it and after the failed run (their
  messages are `job #N completed` / `run #N failed (exit 1)`), and the view
  shows the snapshot diff between them. Nothing to compare when no earlier
  run completed or history is off.

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
  of truth. An event trigger is project-wide by default, or narrowed with
  the optional **source filters** `sourceAssetId` (fire only when the
  settled job executed a version of that script asset) and
  `sourceTriggerId` (fire only when that trigger started the settled
  job); both present means both must match. Filters are validated against
  the same project at write time and are meaningless on cron triggers.
- **Actions**: `run_script` (head version at fire time), `render`,
  `fetch_data` (allowlisted hosts only), `agent_prompt` (the Observatory-
  command machinery). Chain-depth and self-chain guards prevent runaway
  loops. `run_script` may also declare `requiredOutputs` — the workspace
  files the job must leave behind before it counts as completed.

The guild/channel `automations` table is left alone — it still serves
scheduled conversational prompts in Discord scopes.

### Live run output

A running run shows what it is printing. While a segment runs, the sandbox
hands each chunk of stdout/stderr to `utils/liveOutput.js`, which keeps a
display-ready tail per stream (UTF-8 decoded across chunk boundaries, ANSI
escape codes removed, a carriage-return progress line collapsed to its last
state, at most 16 KB each) and writes it to the job row
(`observatory_jobs.liveStdout` / `liveStderr` / `liveBytes` / `liveAt`) at
most every two seconds. Writing it to the database rather than over the
event bus (which carries ids only, never content) makes it readable by
whichever process serves the portal, in every deployment. The columns are
cleared when the segment ends; the settled `stdoutTail` / `stderrTail` are
the record after that.

- **Portal:** Runs (and the Overview's latest runs) show a *Live output*
  panel under a running run, refreshed every two seconds, that follows the
  end unless you scroll up. `GET /api/app/observatory/jobs/:jobId/live?since=`
  (any member) answers the live tails while it streams, `{ unchanged: true }`
  when nothing new arrived since `since` (the last `at`), and the recorded
  tails between segments and once settled.
- **Goobster:** the observatory `status` action for a running job includes
  the last 30 lines of the live output.
- **Remote runner:** with `GOOBSTER_SANDBOX_URL` the runner answers once, at
  the end of a segment, so there is no live output (the panel and `status`
  say so); the tails still arrive when each segment ends.

### Timeline

`/projects/:owner/:slug/timeline` (and the observatory `timeline` action)
is one feed of what happened on the project and who did it, newest first,
grouped by day. Nothing new is stored; `services/projectTimelineService.js`
merges, at read time:

| Kind | From | Actor |
|---|---|---|
| `snapshot` | workspace history commits, minus the `before ...` safety snapshots and the per-run ones | the member who caused it, or Goobster |
| `run` | `observatory_jobs`, one entry at settle (or start while running) | the person; "Goobster (for <person>)" when started from chat; the trigger's name when a trigger started it |
| `repo` | `integration_audit` rows of the project's clones: clone, push, merge, rebase, pull request | the person |
| `plan` | `project_mission_events` (drafted, approved, step added / started / finished / linked to code, ...) | the person, or Goobster |

`GET /api/app/projects/:slug/timeline?before=&limit=&kinds=snapshot,run,repo,plan`
returns `{ entries, nextBefore }`; `before` is the oldest `at` of the last
page. Each source reads at most `limit + 1` entries and finishes the second
it stopped in, and a page never reaches past the newest second a source
stopped at, so paging never skips or repeats an entry. Repository rows
carry the project id since this change; older rows are matched by slug and
the project's members. CI-watch verdicts are not stored and do not appear.

### Plan steps linked to code

A plan step can name a clone and a branch (`project_mission_steps.repoName`,
`branch`, `requireGreenCi`): the Plan view's *Link code* on a step, the
mission tool's `link_code` (`stepId=`, `branch=`, `repo=` - the clone name
or owner/name, optional with a single clone - and `requireGreenCi=true`),
or `POST /api/app/projects/:slug/mission/steps/:stepId/code`
(`{ missionId, repoName, branch, requireGreenCi }`; an empty branch clears
it). The branch need not exist yet. The step then shows its branch (linked
to GitHub), the open pull request and the CI verdict, read with the viewer's
own GitHub connection (`GET /api/app/projects/:slug/mission/code`, best
effort per step). With `requireGreenCi`, marking the step done is refused
until that branch's CI is green right now (`CI_NOT_GREEN`, naming what
fails), and also when CI cannot be checked (`CI_UNKNOWN`), so "needs green
CI" never passes by default. Linking is recorded on the plan's timeline
(`step_code_linked`).

## Multi-stage pipelines

A pipeline is a chain of `run_script` stages where each stage consumes
what the previous one wrote. Three things make that chain trustworthy;
none of them is a workflow language.

### Exit 0 is necessary, not sufficient

A script that exits 0 without writing its handoff file used to settle
`COMPLETED` and fire `job_completed`, so the next stage ran against
missing input. A `run_script` trigger can now declare what the job must
produce:

```json
{
  "background": true,
  "requiredOutputs": [
    { "path": "pipeline/fetch_manifest_{utc_date}.json", "type": "json", "minBytes": 2 }
  ]
}
```

Each entry is a workspace-relative `path` (a bare string is shorthand
for `{ "path": ... }`), an optional `type` — `file` (exists, regular
file, size) or `json` (must also parse) — and an optional `minBytes`.
The only template variable is `{utc_date}` (`YYYY-MM-DD`, UTC, captured
when the trigger fires). Paths go through the Observatory workspace
legalizer: absolute paths, traversal, symlinks (including a symlinked
parent directory), and directories are refused — at write time where the
shape allows it, and again at settlement, where they fail the check.
There are no validator commands and no user-supplied code; the check
list is deliberately closed.

The resolved contract is **frozen onto the job row** when it starts.
Editing the trigger while the job runs does not change what that job is
judged against.

Settlement order:

1. The sandbox runs as before (segments, checkpoints, resumes).
2. Execution failure (non-zero exit, timeout, cancel) settles as before
   with the matching `errorCode`; the contract is not consulted.
3. Otherwise the frozen contract is evaluated against the workspace.
   Every check must pass for the job to settle `COMPLETED`.
4. A failed check settles `FAILED` with `errorCode =
   OUTPUT_CONTRACT_FAILED`, a one-line `error` naming the first few
   offenders (`output contract failed — missing
   pipeline/fetch_manifest_2026-09-18.json`), and the full per-check
   verdict in `outputContractResultJson`.
5. Only then are event triggers evaluated: `job_completed` does **not**
   fire; `job_failed` and `job_settled` do.

Foreground trigger runs apply the same verdict before recording the
trigger's `lastOutcome`, so a missing output is `failed: fetch v3 exit 0;
output contract failed — …`, never `ok: exit 0`. A validated run reads
`ok: fetch v3 exit 0, 1 required output(s) validated`. Triggers without
`requiredOutputs` keep the legacy exit-code-only behaviour.

In the portal, a job with an error code, a parent, a trigger, or a
contract gets an expandable detail row: the code, who started it, the
source job it reacted to, and every required output with its per-check
verdict (missing / too small / invalid JSON / …).

### Filtered events instead of staggered cron

Two cron triggers at 02:00 and 02:30 encode an assumption ("stage 2 is
done by 02:30") that breaks the first slow night, and an unfiltered
`job_completed` trigger fans out from *every* successful job in the
project — a quick chat-started run, a render, an unrelated experiment.
Filter the downstream trigger to its upstream stage instead:

```text
Stage 2 — cron run_script "fetch" (asset #12)
    actionParams: { background: true,
                    requiredOutputs: ["pipeline/fetch_manifest_{utc_date}.json"] }
    → COMPLETED only after the manifest exists and parses

Stage 3 — event run_script "build-atlas"
    eventTopic: job_completed
    sourceAssetId: 12          (or sourceTrigger: "Stage 2")
    → fires exactly for a validated Stage 2 run, never for other jobs
```

Through the tool: `set_trigger` with `sourceAsset: "fetch"` or
`sourceTrigger: "Stage 2"` (slug/name or id; empty string clears), and
`requiredOutputs: [...]`. Through the API: `sourceAssetId` /
`sourceAsset`, `sourceTriggerId` / `sourceTrigger`, and
`actionParams.requiredOutputs` on `POST`/`PATCH
/projects/:slug/triggers`; `null` clears a filter. The portal's
Automations editor exposes the same three fields.

The settle path and the startup catch-up sweep share one matcher
(`matchesEventTrigger`), so a job either fires a trigger in both or in
neither. A non-matching job never advances the trigger's `lastRun`, so
an unrelated job settling after a matching one cannot make catch-up
skip the match.

### Event delivery records

An event is the pair **(trigger, settled source job)**, and each one has
a durable row in `project_trigger_deliveries` with a unique constraint
on that pair. The claim is the `INSERT`: the settle path and the catch-up
sweep (or two bot replicas) race for the same row and exactly one wins.
That replaces the old "advance `lastRun` past `finishedAt`" cursor, which
collapsed two jobs finishing in the same second into one event and
treated an older job examined after a newer one as already consumed.
`lastRun` is still written (newest finish seen) but only as a display
cursor and the lower bound of the catch-up scan.

A delivery moves through explicit states:

| status      | meaning                                                                                     |
|-------------|---------------------------------------------------------------------------------------------|
| `STARTED`   | claimed, dispatch in flight (a row a crash left here is retried after a 10-minute lease)    |
| `DELIVERED` | the action ran; for `run_script` the child job row exists (`childJobId`)                    |
| `RETRYABLE` | the project or sandbox was busy or the active-job cap was hit — re-dispatched after backoff |
| `FAILED`    | permanent: gone project, script with no head, bad contract shape, or retries exhausted      |
| `SKIPPED`   | the chain guard (self-chain / max depth) or the fetch allowlist declined it                 |

"Delivered" is only recorded once the downstream job has actually been
created. A transient refusal — `PROJECT_BUSY`, sandbox `BUSY`,
`TOO_MANY_JOBS` — leaves the row `RETRYABLE` with exponential backoff
(1, 2, 4 … capped at 15 minutes); `retryEventDeliveries` re-dispatches
due rows from the same automation minute loop as cron. After ten
attempts the row becomes `FAILED`, the trigger's `lastOutcome` reads
`failed: gave up after 10 attempts: …`, and the owner is told — a
validated Stage 2 whose Stage 3 never started is never silent.

Triggers that predate the table are back-filled once on the first
catch-up: every matching job with `finishedAt <= lastRun` is recorded as
`DELIVERED` (`legacy: …`), so upgrading does not replay history.

Inspect deliveries with the tool (`list_deliveries` with the trigger
name), the API (`GET /projects/:slug/triggers/:trigger/deliveries`), or
the **deliveries** expander on an event trigger in the portal.

### Recovering an event-trigger dispatch

Each event-fired `run_script` passes a stable execution-attempt ID derived
from the trigger and source-job IDs. A partial unique index on event job
attempts prevents a second child even when two dispatchers race after a
lease expires. Before retrying, the trigger service adopts any existing
child, including a running, failed, or completed job. Legacy children
without an attempt ID are matched by their project, owner, trigger, and
parent-job provenance. Code and output-contract edits do not rerun an
already-created child. `DELIVERED` means that the child was created; its
stage status remains separate. A late dispatcher cannot downgrade an
already-delivered record.

This prevents duplicate child creation after a lost dispatch acknowledgement.
It does not promise exactly-once external effects inside a script or for
other trigger actions (`render`, `fetch_data`, `agent_prompt`).

### Dispatch is not completion

A background `run_script` action records `started: job #123 (fetch v3),
awaiting settlement` — the job was launched, nothing more. When that job
settles, the trigger that started it gets a separate `lastJobOutcome`:
`ok: job #123 completed, 1 required output(s) validated`, or `failed:
job #123 exit 0; output contract failed — missing …`, or `failed: job
#123 timed out`. The portal shows both lines (`dispatch:` / `stage:`),
the tool's `list_triggers` labels them the same way, and neither ever
says `ok` for a stage that has not finished.

### Explicit parentage

When an event trigger starts a `run_script` job, the settled source job
becomes the child's `parentJobId` (same project enforced). The
chain-depth guard walks that pointer — stopping at a missing parent and
refusing to loop on a cycle — so `maxChainDepth` counts real hops and
`allowSelfChain` gates real self-fires, regardless of how many
unrelated jobs settled in between.

### What the audit adds

`auditSetup` / the Needs-you board now flag, per trigger: a source
filter pointing at a deleted asset or trigger (warn — the trigger can
never fire), an invalid `requiredOutputs` shape or path (warn), and an
unfiltered `job_completed` `run_script` trigger (info — the fan-out
footgun above, without failing the audit). It does not infer a DAG from
filenames.

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

## Apps with project access

An app opened from its own project's **Apps** tab can do more than read:
it can list, read, write and delete the project's workspace files and its
notes and scripts, and run workspace files and script assets. That makes
real tools possible: a data editor that saves back to `data/*.json`, a
control panel that runs `sim/run.py --days 30` and shows the output, a
notebook that keeps its pages as project notes.

**The API.** The bridge script in every app defines `window.goobster`
(no project argument; it is always the project the app was opened from):

| Call | Does | Needs |
|---|---|---|
| `goobster.list(dir)` | entries `{ path, name, kind, size, modifiedAt }` of one folder (`''` is the root) | — |
| `goobster.read(path, responseType)` | a workspace file as `json`, `text`, `dataurl` or `bytes` (base64); any type | — |
| `goobster.write(path, content, { encoding })` | create or replace a file; `encoding` is `utf8` (default for strings), `json` (default for objects, pretty-printed), `base64` or `dataurl` | `write` |
| `goobster.remove(path)` | delete a file or folder | `delete` |
| `goobster.run(path, { args, stdin, background })` | run a `.py`, `.js` / `.cjs` / `.mjs` or `.sh` workspace file from its own folder with `args` as argv; foreground returns `{ jobId, result: { ok, stdout, stderr, exitCode } }`, background returns `{ jobId }` | `run` |
| `goobster.job(jobId, since)` | a run's live output and status (poll a background run) | `run` |
| `goobster.watch(jobId, onUpdate)` | live output pushed to the app: `onUpdate({ status, running, stdout, stderr, done })` about every second until the run ends; returns `{ stop(), done }` (`done` resolves with the last update). At most 4 at once; a reload of the app ends them | `run` |
| `goobster.assets.list(kind)` / `.read(slug, version)` | the project's assets and their source | — |
| `goobster.assets.write(slug, source, { kind, name, language, note })` | save a new version of a **note** (default) or **script** | `write` |
| `goobster.assets.remove(slug)` / `.run(slug, { background })` | delete a note or script; run a script asset | `delete` / `run` |
| `goobster.context` / `await goobster.ready()` | `{ project, owner, access }` once connected | — |

Every call returns a promise; a refusal rejects with an `Error` whose
`code` says why (`ACCESS_DENIED`, `UNDECLARED_CAPABILITY`,
`APP_PROTECTED`, `NO_PROJECT`, or the server's own code such as
`NOT_FOUND`, `QUOTA_EXCEEDED`, `NOT_RUNNABLE`).

**Declared, then approved.** Reading needs nothing. `write`, `delete` and
`run` must be declared in the app's source, only the ones it needs:

```html
<meta name="goobster-project-access" content="write run">
```

The first time the app uses one, the viewer is asked ("“Ledger” wants to
create and change files and notes in project lab, as you. Allow it for
this version of the app?"). An approval is remembered in that browser for
that exact source, so a new version of the app asks again; a refusal lasts
for the session. Above the app, the Apps tab shows what it can do (read,
plus each declared capability: allowed ✓, refused ✕ or asks first) with
**Reset approvals**, and under it an **App activity** log of every call it
made, refused ones in red.

**As the viewer, never more.** The portal makes each call with the
signed-in person's own session, through the same routes and checks as the
Files view and Runs (membership, quota, the project lock, history
snapshots, job records), so an app can never do more than the person
looking at it. Runs it starts are recorded with `startedBy = 'app'`.
Apps may not write or delete app assets, themselves included
(`APP_PROTECTED`): changing an app stays with `save_app` and the portal.
An html fence in chat or a Workshop pin has no project, so every
`goobster.*` call there fails with `NO_PROJECT`; only the
[read bridge](#own-project-reads-the-applet-bridge) applies.

**Running a file** is also an API of its own:
`POST /api/app/projects/:slug/run-file { path, args, stdin, background }`
(`projectService.runFile`). It runs a launcher that changes to the file's
folder, sets argv and hands over to the file (Python through `runpy` with
the folder on `sys.path`; `.js` / `.cjs` / `.mjs` with `exec node` and
`.sh` with `exec bash`, so the file is its own main module), so relative
paths and sibling imports work; the job's code is
that launcher, headed `# goobster: run workspace/<path>`. Paths and args
are passed as JSON or shell-quoted, never spliced in raw; at most 64 args
of 4,096 characters.

### App templates

**+ New app from template** in the Apps view (and `save_app template=` for
Goobster, with `name`, `path` and, for the console, `template_args`)
builds a ready app and saves it as an ordinary, versioned html app that can
be edited like any other (`services/appTemplates.js`). Each declares only
the access it uses and keeps its settings in a
`<script id="goobster-app-config" type="application/json">` block:

- **Data table editor** (`data-table`, declares `write`): edit a `.json`
  array of objects or a `.csv` file as a table (add, rename and delete
  columns; add and delete rows), then Save writes it back (numbers and
  booleans keep their type in JSON). A missing file starts empty and is
  created on the first save.
- **Run console** (`run-console`, declares `run`): run a `.py`, `.js` or
  `.sh` workspace file with arguments (shell-style quoting) in the
  background and watch its output live; keeps the session's runs, and a
  click puts a past run's arguments back.
- **Chart** (`chart`, read only): plot a `.json` or `.csv` file as lines;
  pick the x column and the series; reload, or refresh every 10 seconds
  while runs update it.

API: `GET /api/app/projects/app-templates` (the catalog: name,
description, access, parameters) and
`POST /api/app/projects/:slug/apps/from-template { template, title, path, args, slug? }`.
Paths must stay inside the workspace (`BAD_PATH`); an unknown template is
`NO_SUCH_TEMPLATE`. Templates use no form element (app frames have no
`allow-forms`).

### Pinned apps and app addresses

The Apps view's address names the app: `/projects/:owner/:slug/apps?app=<slug>`,
and `&full=1` shows it alone at full height (**⤢ Full page** / **⤡ Exit
full page**), so an app can be bookmarked and linked. **📌 Pin to
Overview** puts it on the project's Overview, live (same bridge,
approvals and activity as in the Apps view), with **Open** and **⤢**.

## Unfiled apps (the former Workshop inbox)

The Projects list has an **Unfiled apps** section: unpinned html/svg fences
discovered in Chat, plus leftover `web_applets` pins (marked Migrated when
the Phase 2 startup migration copied them into a `workshop` project). It
lists **generated apps only** - not files, notes or reports - which is why
the narrower name. Each item can be **added to a project** (new asset or
new version of an existing one). Pinning still works during this
deprecation window; `web_applets` and its routes stay until a later
release. The separate Workshop nav entry is gone; `/workshop` redirects
here. This section is the **one place** outputs without a project are
listed; there is no second inbox. [ADR 0010 §5](adr/0010-explicit-transfers.md)
keeps the label: an *output* is a result with a home (asset, workspace
file, render, generated app), and the generated app is the only kind that
exists without a project today. "Unfiled outputs" is allowed only once the
same section also lists files and reports. **Open in Projects** on a
migrated pin links to the project's owner-qualified Apps view. Adding an
app needs only `me.features.projects` (organizing) - it works when the
host cannot run code.

## The portal pane

Shown when organizing projects is on (`me.features.projects`; see
[Enabling it](#enabling-it)). The contract is
[ADR 0009](adr/0009-project-organization-contract.md); the registered views
are in [portal_navigation.md](portal_navigation.md#projects).

**Addresses.** `/projects` is the list. One project lives at
`/projects/:ownerId/:slug/:view` - the owner is part of the address because
slugs are unique per owner, not globally, and a collaborator on two
`emergence-study` projects must be able to tell them apart. The bare
`/projects/:ownerId/:slug` opens Overview. `/projects/:slug` alone is a
resolver: a unique match among the projects you can see redirects to the
canonical address, several show a chooser naming each owner ("yours" for
your own), and no match says so with a way back. Selection and the active
view live only in the URL, so refresh, Back / Forward, bookmarks and Inbox
links land where they say.

**Vocabulary.** The room says **Plan** for a mission, **Run** for a job,
**Files** for the explorer, **Outputs** for the render gallery and
**Unfiled apps** for the old inbox. Only the visible words changed:
`project_missions`, `observatory_jobs`, `/api/app/projects/:slug/mission…`,
the `observatory` tool's `mission` and `run` actions, `MissionTab` and the
`project-changed` events keep their names.

- **The project list** (`ProjectListView`) — each card links to its
  owner-qualified address and shows the goal, role (owner / collaborator
  and who owns it), running / total runs, size and last activity; above it
  the **Needs you** board and invitations; below it Unfiled apps.
  **+ New project** opens a form: a name and an optional **goal**, sent to
  `POST /api/app/projects { name, goal? }` - the same authorized
  `createProject` the tool uses (per-user cap, slug uniqueness, owner-only
  workspace), with the goal stored in `observatory_projects.description`
  and returned on the list and detail payloads. No model call is involved;
  ✨ Command stays for richer, instruction-driven setup and is
  execution-gated.
- **The project shell** (`ProjectShell`) — the header (title, ← Projects,
  Chat dock toggle, ✨ Command, People, Refresh) and a tab strip of the
  eleven registered views: **Overview** (goal, status line, the **Now** panel,
  open plan and its next action, latest runs, outputs, owner actions:
  render, snapshot, share, delete), **Plan** (one open outcome, criteria, steps, evidence,
  timeline, earlier plans), **Conversation** (the project parlor as a full
  view), **Knowledge** (project Spitball map + notes + expedition launch),
  **Files** (repo-style tree with workspace search), **Code** (GitHub
  clones; see [Repositories](#repositories)), **Apps** (rendered applet with version
  picker + rollback; own-project reads implicit), **Runs** (every run,
  status, provenance, output verdict, cancel / resume), **Timeline** (see
  [Timeline](#timeline)), **People** (owner,
  collaborators, invitations), **Automations** (trigger list:
  schedule/event, action, last outcome, enable/disable). The chat dock and
  the People modal remain as secondary presentations of the Conversation
  and People views.
- **Now** (Overview, `GET /api/app/projects/:slug/now`) gathers what is
  happening and what needs a person in one read: running runs, the latest
  settled run when it failed (with its stderr tail, Ask Goobster why and
  Run again), needs-you items for this project, each clone's branch, sync,
  any merge or rebase stopped on conflicts, CI and open pull request (a few
  seconds at most per clone, best effort), whether `GOOBSTER.md` exists,
  and the last thing Goobster said in the project's conversations. Each
  part is independent; one that fails leaves its line out. It refreshes
  every 15 s while a run is going, else every minute. "Ask Goobster ..."
  buttons open the chat dock with the request pre-filled.
- **Files** has two honest roots. `assets/` is the DB-backed, versioned
  source (apps / scripts / notes) with a version-history rail, client-side
  diffs (`diff`), rollback, and CodeMirror 6 editing. Save goes through
  `projectAssetService.save` with `origin='portal'` — same caps, hash
  dedupe, and pruning as the tool. `workspace/` is the on-disk tree,
  listed lazily via `listFiles({ path })`. Text files edit in CodeMirror;
  images and video play inline; binaries download through the owner-only
  content route. Every workspace file and directory carries a
  **Snapshots** rail ([Workspace history](#workspace-history)): pick a
  snapshot to see what changed since it, download the file as it was, or
  restore it; the workspace root adds **Snapshot now**. Clones under
  `repos/` are managed (and edited with git status) in the Code view
  ([The repository editor](#the-repository-editor)). PUT/DELETE `/api/app/projects/:slug/content/*` write
  that same quota'd sandbox (multipart for binaries). A ▶ Run button on
  script assets calls `POST .../assets/:asset/run` with the head version
  and `startedBy='portal'`.

  The tree is laid out for busy projects. A toolbar holds one box: typing
  **filters names** in both roots at once (folders already opened show
  their matching files; Esc clears) and Enter runs the full-text
  [workspace search](#workspace-search) for what is inside files. Both
  roots fold, with counts (`workspace/` first; `assets/` starts folded
  above 12 assets) and assets are grouped into Apps, Scripts and Notes,
  each foldable. Every row is one line: long names are shortened in the
  middle so their endings (dates, versions, extensions) still show, the
  full path is the tooltip, sizes and versions sit right-aligned, and a
  script's ▶ appears on hover. Dotfiles are folded into a "+ N hidden"
  row. Drag the tree's edge (or focus it and use ← / →; double-click
  resets) to resize it. Width, folded sections and hidden-file choice are
  remembered in this browser only.
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
- **What Goobster will see.** Above the dock's composer, chips show what
  is open beside the chat: the file in the Files or repository editor
  (with its branch, and whether it has unsaved edits), the selected lines,
  and the app open in the Apps view. ✕ leaves one out (it comes back when
  you open something else); what is kept goes at the top of your message,
  as `(Context: Open file: …)` and the selected lines quoted (at most 4,000
  characters), so everyone on the project sees it in the transcript. A
  selection your message already quotes ("Ask Goobster about lines") is
  not repeated. Nothing is stored (`hooks/useViewContext.ts`).
- **Go to (Ctrl/Cmd+K).** The palette jumps to a view, an app, a workspace
  file by name (through the workspace search; the Files view opens
  `?file=<path>` with its folders unfolded), a recent run, or a plan step;
  or puts the typed text in the chat as a request for Goobster (never
  sent). Arrow keys and Enter, Esc to close; the header's **🔎 Go to**
  opens it too.

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
sandbox run. Resume is a documented convention, not magic. The layout
contract (tool description, create-project reply, and starter examples)
is generated from `utils/projectSetupContract.js` so guidance cannot
drift from runtime:

1. Load `$GOOBSTER_RUN_DIR/checkpoint.json` when it exists (legacy only:
   `$GOOBSTER_PROJECT_DIR/checkpoint.json`).
2. Rewrite it as work progresses.
3. A segment killed at the timeout wall resumes only if the checkpoint
   advanced — up to `maxResumes` times.
4. Exit 0 completes — unless the job carries an output contract, in
   which case every declared file must also validate (see [Multi-stage
   pipelines](#multi-stage-pipelines)); non-zero fails; timeout with no
   checkpoint progress is terminal.

`$GOOBSTER_PROJECT_DIR` is the shared project root (inputs and published
artifacts). Each job owns `runs/<jobId>/`, exposed as `$GOOBSTER_RUN_DIR`
— put `checkpoint.json` and `frames/` there. New jobs do **not** resume
from a project-root checkpoint.

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

Job-completion follow-ups go to the actor. Project chat is the shared
**project parlor** below; the per-member `🔭 <project>` conversations
from earlier phases stay readable in the Chat pane as history.

## The project parlor (project chat)

Every project has shared group discussions — Parlor conversations
linked to the project (`parlor_conversations.projectId`), rendered as
the chat dock on the project page and equally usable from the Parlor
room. The first one is the project's **main conversation**; any member
starts more from the dock's **New** button and switches between them with
its picker (the dock header keeps the title and ✕ on one row and the
picker, **+ New**, Delete and Stop on the next). Both surfaces render the transcript through the shared
`ParlorConversationView` (`apps/web/src/components/ParlorConversationView.tsx`)
so persona colors, glyphs, grounding chips, and attachments cannot
drift. The rules (spec §14):

- **Created lazily** on first open (`GET /api/app/projects/:slug/parlor`,
  any member), owned by the project owner, titled `🔭 <project name>`.
  Solo projects get one too — one chat model for every project.
- **More conversations**: `GET /api/app/projects/:slug/conversations`
  lists every one (any member; `primary` marks the main one) and
  `POST` with an optional `title` starts another (any member, at most 100
  per project; untitled ones are auto-titled from the first message).
  Each is owned by the project owner, seats Goobster and the whole
  roster, so **every collaborator sees every conversation** in the
  project. The owner may rename or delete the extra ones through the
  normal Parlor routes; the main one goes only with the project.
- **Membership follows the project**, one way: accepting a project invite
  seats you, leaving or removal unseats you. Direct parlor invites,
  member removal, and deletion are refused on linked discussions
  (`PROJECT_LINKED`), and the roster follows `maxMembersPerProject`
  rather than the standalone-parlor member cap. Membership changes reach
  every conversation in the project. Deleting the project deletes every
  one of its conversations.
- **The Goobster seat**: a per-owner built-in persona
  (`parlor_personas.builtin` — auto-created, undeletable, outside the
  persona cap) holds a permanent seat. At a project table its knowledge
  workspace **is the project Spitball** (`PROJECT:<projectId>`):
  retrieval grounds replies in project knowledge and write-back files
  distilled notes there through the legalizer — table talk becomes
  project knowledge.
- **Tool powers, actor-bound**: the seat's replies run the shared agent
  loop with the persona toolset **plus the observatory tool**, acting as
  the member who spoke (never the owner) — so owner-reserved project
  actions stay refused by actor resolution. The seat's `runCode` runs
  **in the project** (`projectService.run`, as the speaker: access check,
  quota, a job record, the project lock), so its working directory and
  `/tmp` are the project's persistent `scratch/` — what one conversation
  built, the next one finds. Generated files land on the reply as
  attachments. One turn per discussion at a time (the existing
  per-conversation lock).
- The owner may seat their own personas alongside Goobster (an architect
  or critic joins project chat); those keep their own workspaces.

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
Launch from Knowledge → Research ("into project X") or the project's
Knowledge tab.

### Moving a chat into a project

A private web chat moves into a project through the chat header's
**Move to project…** (`POST /api/app/projects/:slug/conversations/from-chat`
with `{ conversationId, keepOriginal, requestId }`;
`knowledgeTransferService.moveChatToProject`). It is an explicit transfer
under [ADR 0010](adr/0010-explicit-transfers.md): nothing routes through a
model, the dialog names who will read the chat before anything moves, and
the move is one `knowledge_transfers` row (`chat_message → discussion`,
`copy`, audience and imported folder in `audienceJson`).

- The transcript becomes a **new conversation in the project**, titled
  after the chat: the mover's messages stay theirs, the assistant's
  replies become the project's Goobster seat, timestamps and attached files
  are kept. Every collaborator reads it, like every project conversation.
- The chat's sandbox workspace (its `runCode` files) is copied into the
  project's `scratch/<chat-title>/` - regular files and folders only;
  symlinks and other special files are skipped, never followed - after a
  quota check against what would be copied (`QUOTA_EXCEEDED` leaves
  nothing behind). Goobster finds it there from any project conversation.
- The private chat is then **deleted** (with its workspace), unless the
  person ticks *Keep my private copy*. Files the moved transcript still
  points at are not unlinked with it.
- Retrying with the same `requestId` returns the first result; reusing it
  for another chat is `REQUEST_CONFLICT`. Refusals: `NO_SUCH_CONVERSATION`
  (not the caller's chat), `NO_SUCH_PROJECT` (not a member),
  `EMPTY_CONVERSATION`, `CONVERSATION_TOO_LONG` (over 2,000 messages).
  Incognito chats are never saved, so they have nothing to move.
- Privacy: the transparency report counts moves as `movedChats`. Erasing
  the mover deletes their ledger rows; the moved conversation is project
  data and goes with the project.

### Moving knowledge into a project

A note a person kept in their own space enters a project through
**Knowledge → Notes → Add to project…** ([ADR 0010](adr/0010-explicit-transfers.md);
the personal side is [knowledge_and_memory.md](knowledge_and_memory.md#moving-a-note-into-shared-work)).
Nothing routes through a model; the project's audience **now** decides how
the note travels, and the server enforces it:

- **Reference** - only into a private project the caller owns (no accepted
  member, no share link). No row is written to the `PROJECT:` scope; the
  Knowledge view (*Referenced from your private notes*, badge *reference ·
  only you*) resolves the note at read time
  for the person who referenced it. Sharing the project later does not
  expose it - a collaborator sees neither the note nor a count - and every
  reader that runs *as the project* (graph, `recall_knowledge`,
  expeditions, dashboards) reads only the `PROJECT:` scope, so it never
  sees a reference. Project chat also excludes references: its transcript may
  later become shared project knowledge. Publish a copy to use the note there.
  **Stop referencing** (✕) drops it; the note stays.
- **Publish a copy** - the only mode for a project with members or a share
  link. The dialog shows the title, text and tags that will be copied and
  names the readers (owner, members, "plus anyone holding the project share
  link") before anything is sent. The copy is a new `kg_nodes` row in
  `PROJECT:<id>` (`source = 'user'`, `curation = 'saved'`, tags copied),
  badged *copy · published by \<name\>* in the Knowledge view. It is a
  snapshot: editing the original does not change it; publishing the same
  note again updates the copy in place. The owner or the publisher may
  **remove** it from the project (`DELETE
  /api/app/projects/:slug/knowledge/notes/:nodeId`); the publisher's
  original is untouched either way.

Deleting the original note drops its references and keeps its copies; the
deletion dialog names each project the note reached and offers to remove
the copies the person may ([ADR 0010 §4](adr/0010-explicit-transfers.md)).
Deleting the project takes its copies with it.

`GET /api/app/projects/:slug/knowledge/notes?owner=…` returns `notes`
(copies carry `publishedBy`, `publishedByName`, `publishedFrom`,
`publishedAt`, `canRemove`), `references` (the caller's own, or `[]`),
`audience` and `role`; `GET /api/app/projects/:slug/audience` returns the
audience alone (`ownerId`, `ownerName`, `members`, `memberIds`, `shared`,
`private`). Server-written links to a project use
`/projects/:ownerId/:slug/:view`. Transfers need only `me.features.projects`;
running anything in the project stays behind `me.features.observatory`.

## Missions (shown as Plans)

A **Mission** - **Plan** in the portal, per [ADR 0009](adr/0009-project-organization-contract.md) -
is the durable intent and evaluation layer for one project:
what outcome we are pursuing, how we will know it worked, and what should
change afterward. It sits on the existing project — not a new room. The
identifier stays `mission` everywhere below; only the visible word is Plan.

- Service: `services/projectMissionService.js`
- Tables: `project_missions`, `project_mission_steps`,
  `project_mission_evidence`, `project_mission_events`, `project_decisions`
- Tool: observatory action `mission` (`missionAction`: propose / get /
  update / add_step / start_step / complete_step / add_evidence /
  review / cancel). Approval, start, and complete are human-only.
- Portal: the **Plan** view on a project (`/projects/:owner/:slug/plan`;
  the older `mission` segment still opens it), plus the open plan and its
  next action on Overview
- Routes: `/api/app/projects/:slug/mission*`

The model proposes a plan and evaluates evidence. Code owns permissions,
budgets, transitions, and what counts as completed.

**State machine** (deterministic):
`DRAFT → APPROVED → ACTIVE → BLOCKED|REVIEW → COMPLETED`
(any open status may `CANCELLED`). One open mission per project
(DRAFT/APPROVED/ACTIVE/BLOCKED/REVIEW). Completing or cancelling frees
the slot.

**MVP contract:**

- Objective plus measurable success criteria, optional deadline and budget
- Manual approval before any step runs. Approval consumes a
  human-originated confirmation receipt (portal-minted) bound to a
  frozen `planRevision`. Plan mutations increment the revision
  atomically (`planRevision = planRevision + 1` with a status
  predicate); a zero-row update throws so `addStep` cannot race
  `start()`. Adding or editing steps after approval clears the
  approval and returns the mission to `DRAFT`.
- Steps of four kinds: `expedition`, `job`, `watch`, `human`. Execution
  is `READY → STARTING → RUNNING` with an attempt key written onto the
  child job / expedition / watch. Expeditions are created as `DRAFT`,
  linked, then dispatched. `reconcileStartingSteps` runs on bot/api
  startup and on the personal heartbeat; an unlinked stale claim
  fails and blocks the mission. A `FAILED` step is resolved by
  retry (`FAILED → READY`) or skip (`FAILED → SKIPPED`); `resume()`
  refuses while any step is still `FAILED`. Job/watch steps cannot
  start without required parameters. Cancel and skip cancel the
  linked child as its launching owner (project membership already
  authorized the mission action).
- Evidence links to claims, project notes, jobs, and assets (`for` /
  `against` / `neutral`, optionally tied to a criterion). Automatic
  rollup is `supported` / `contested` / `unassessed` (deduped links;
  claims must be on this project unless explicitly imported).
  `met` / `unmet` / `mixed` are reserved for the human review.
- Append-only timeline (`project_mission_events`)
- Attention notices only for `BLOCKED`, `REVIEW`, and an approaching
  deadline — never "step done". Deadline candidates are selected by
  deadline, not `updatedAt`.
- Final review compares linked evidence against the original criteria.
  The model may propose a verdict via `review`; a human completes
  with a confirmation receipt. Completing writes exactly one thin
  `project_decisions` row (the Learn seed — full Decision Records,
  Living Claims, and Protocols come later). Existing installs
  normalize NULL `criterionId` and deduplicate evidence/decisions
  before the unique indexes are created.

Starting an `expedition` / `job` / `watch` step kicks the existing
subsystem (focused expedition into the project graph, background script
job, or an armed watch). Those settle paths call back into the mission
so a missed domain event cannot leave a step running forever.

The conversational test: can someone draft a useful plan in project
chat, approve it in under a minute, and then do less orchestration than
before? If the view feels like project-management bureaucracy, it is too
heavy.

## Privacy

Projects, jobs, share links, assets, versions, triggers, memberships,
missions, decisions, and invites are personal data. `/what-do-you-know-about-me` reports
owned and collaborated projects. Owner `/forget-me` deletes the whole
project (rows, workspace, workspace history, dashboards, share links,
memberships, invites, and the `PROJECT:<id>` knowledge scope) and DMs
members that it is gone. Workspace history never stores a user id: its
authors are project-scoped pseudonyms resolved at read time, so an erased
collaborator's snapshots read as *former collaborator* and nothing is
rewritten.
Member `/forget-me` deletes their memberships, invites addressed to
them, authored asset versions (repairing each asset's head; deleting an
asset left with zero versions), and authored jobs — workspace files and
project-scope graph nodes stay (they are project data).
`privacyService.auditUser` counts memberships, invites, authored rows in
shared projects, and project-scope nodes under the owner. `web_applets`
stays on the erasure path until that table retires. The transfer ledger
(`knowledge_transfers`, [ADR 0010](adr/0010-explicit-transfers.md)) is
keyed on the actor: `/forget-me` deletes every transfer they made,
`auditUser` counts them, and the report lists them under
`knowledgeGraph.transfers`. Copies they published into someone else's
project are project data and stay.

## Tests

`tests/observatoryConfig.test.js` (clamping),
`tests/observatoryService.test.js` / `tests/projectService.test.js`
(projects, quota, jobs, erasure, re-export parity),
`tests/projectHistoryService.test.js` / `tests/projectHistoryApi.test.js`
(workspace history: sibling git dir, excludes, budget squash and pause,
pseudonymous authors, restore, erasure, missing-git degradation, route
contract), `tests/projectRepoService.test.js` / `tests/projectRepoApi.test.js`
(repositories against a local bare remote: clone, identity-authored
commits, push, fast-forward pull, branches, rejected push, diverged pull,
reset, caps, quota, erasure, route contract),
`tests/projectAssetService.test.js` / `tests/projectAssetApi.test.js`
(versioning, pruning, rollback, dedupe, API auth),
`tests/projectTriggerService.test.js` / `tests/projectTriggerApi.test.js`
(cron claim, event fire, catch-up, source filters and their shared
matcher, explicit parentage and chain-depth, foreground contract
outcomes, contract-failure topics, frozen contracts, per-event delivery
records — same-second and out-of-order settles, RETRYABLE busy
dispatch and its retry, give-up after max attempts, crash-lease reaping,
legacy back-fill, `lastJobOutcome` — and the two-stage scenario:
missing manifest never relays, valid manifest relays exactly one child,
a busy project retries instead of dropping the event),
`tests/outputContract.test.js` (contract normalization, `{utc_date}`
resolution, path refusals, per-check reasons, summaries),
`tests/observatoryService.test.js` (exit-0 contract verdicts on real
background runs, symlink escapes, `errorCode` per failure kind),
`tests/projectSetupAudit.test.js` (dangling filters, invalid contracts,
unfiltered fan-out info),
`tests/appletCapabilities.test.js` / `tests/appletCapabilityApi.test.js`
(own- vs cross-project grant resolution + content route),
`tests/workshopPinMigration.test.js` (pin → asset migration),
`tests/projectWorkspaceWrite.test.js` / `tests/projectWorkspaceApi.test.js`
(path legalization, quota, portal-origin versions, run-from-UI, erasure),
`tests/projectChat.test.js` (conversation binding, manifest truncation,
turn lock, refetch hints),
`tests/toolsRegistryObservatory.test.js` (tool gating, `read` windows),
`tests/agentLoopObservatory.test.js` (the real agent loop driving a
nine-step pipeline setup — filtered event stage, output contract,
foreground run, list/audit/inspect — through the real registry under the
project budget, the conversational budget's handoff, and a bad filter
recovered as an observation; see `documentation/agent_orchestration.md`),
`tests/toolResultWindow.test.js` (shared line-window / clip caps),
`tests/projectParlor.test.js` (the built-in seat, linked-discussion
lifecycle and guards, PROJECT-scope routing, actor-bound tool context),
`tests/projectCollaboration.test.js` (actor resolution, invites, member
erasure),
`tests/projectKnowledge.test.js` (project graph scope, legalizer writes,
consolidation routing, expeditions, Knowledge-tab auth),
`tests/projectMissionService.test.js` / `tests/projectMissionApi.test.js`
(state machine, one-open rule, human-only approval and completion,
approval invalidation, atomic plan revisions, FAILED retry/skip,
STARTING reconcile + block, concurrent starts, propagated cancellation,
old-mission deadlines, one decision per completion, evidence assessment,
settle hooks, attention, erasure, route auth),
`tests/dbSchemaUpgrade.test.js` (mission unique-index and pre-pipeline
Observatory upgrade fixtures, both engines),
`tests/projectOrganization.test.js` (ADR 0009 through the real routes with
execution off: `/me` reports `projects` and `observatory` separately;
direct creation with a goal and its validation; members, share links and
listing work while render, Command and the conversation turn are refused
with `DISABLED`; two owners with one slug are both listed with their
`ownerId` and named from their principal; a bare slug prefers the caller's
own project and is `AMBIGUOUS_PROJECT` only between memberships),
`tests/knowledgeTransfers.test.js` (ADR 0010 with execution off: a
reference only into a private owned project and invisible to a later
collaborator; a copy in the `PROJECT:` scope naming its audience,
removable by owner or publisher, republished in place; Add to project
succeeds while Command is still refused with `DISABLED`; deleting the
original keeps copies; report, audit, erasure),
`tests/portalRooms.test.js` (the Projects detail pattern and view
segments),
`e2e/projects.spec.js` (owner-qualified list links, tabs / refresh / Back /
deep links agreeing on the view, the slug-only chooser and a missing slug,
the create form, Plan / Run vocabulary, Conversation and People as views,
Unfiled apps), `e2e/transfers.spec.js` (answer → note → reference into the
private project, published copy into the shared one with the audience
named, refresh and Back on the project the transfer opened, the
collaborator's view, the delete dialog) and `e2e/journeys.spec.js` (Plan:
draft → approve → review → complete; run → output → Attention notice;
conversation → knowledge).
