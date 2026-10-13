# ADR 0014: Workspace history is a host-driven git repository beside the workspace; assets stay in the database

## Status

Accepted. Behaviour is documented in
[projects.md](../projects.md#workspace-history); the service is
`packages/core/services/projectHistoryService.js`.

## Context

A project keeps two kinds of files, and they were built with different
guarantees:

1. **Assets** (`project_assets`, `project_asset_versions`): apps, scripts
   and notes stored in the database with per-file versions, a head
   pointer, rollback and dedupe. They live in the database on purpose - the
   portal and the split-deployment `apps/api` render apps without touching
   the bot's disk, and files a sandbox snippet can write are never served
   as trusted app source.
2. **The workspace** (`data/sandbox/projects/<owner>/<slug>/`): the on-disk
   tree a run writes to, bind-mounted read-write into the sandbox, holding
   data, outputs, `scratch/` and uploads. It had **no history at all**. A
   run that overwrote `data/results.csv` lost the old bytes for good, a
   shared project had no record of who changed which file, and the only
   undo was whatever the person remembered.

The question raised was whether git should replace the whole file model.
Two facts decide it:

- The asset layer's reason to exist is **trust and locality**, not
  versioning. A git repository is on disk; in paired mode `apps/api` has no
  disk, so assets in Postgres are what make that mode work. Replacing them
  would be a large rewrite for no gain in that property.
- The sandbox runs **model-written code with no network and a scrubbed
  environment**, by design. A git binary and a push credential inside the
  sandbox would be an exfiltration path, and `documentation/code_sandbox.md`
  already promises that a request can never smuggle a git URL.

## Decision

1. **Git over the workspace, in addition to assets, never instead.** The
   asset layer is unchanged. The workspace gains a git repository that
   snapshots the on-disk tree.

2. **The host process drives git, never the sandbox.** Every `git` call is
   made by the bot (or `apps/api` in standalone mode) through
   `projectHistoryService`, with a sealed environment: explicit `GIT_DIR`
   and `GIT_WORK_TREE`, `HOME` inside the git directory, `GIT_CONFIG_NOSYSTEM`
   and a nonexistent global config, a nonexistent `core.hooksPath`, no
   pager, no terminal prompt, `core.symlinks=false`. The binary is probed
   once (`git --version`); when it is missing the feature is off with one
   warning, like ffmpeg for renders, and projects keep working.

3. **The git directory is a sibling of the workspace**,
   `data/sandbox/projects/<owner>/<slug>.git`, never inside it. The sandbox
   bind-mounts only the workspace, so a snippet can neither read nor corrupt
   history (in the `unshare` / rlimits fallback modes nothing on disk is
   hidden anyway, which is already the documented posture). Slugs cannot
   contain a dot, so `<slug>.git` can never collide with another project.
   Owner erasure removes `data/sandbox/projects/<owner>/` whole; project
   deletion removes the sibling explicitly.

4. **Snapshots are taken by the code paths that change a workspace**, not by
   a timer: a run or job settling (`run #12 completed`), a portal write or
   delete, a `fetch-data` landing, a moved chat's files, and both sides of a
   restore. `git add -A` plus a commit; an identical tree is a no-op. A
   `commit` action takes one on demand with a note. Commit messages name
   files, job ids and outcomes and never carry code, output, a prompt or a
   reply (the same rule as the work ledger).

5. **The author is a project-scoped pseudonym.** `sha256("goobster-project-
   history:<projectId>:<userId>")[0..16]` is the git author; names are
   resolved at read time against the current owner and members. An erased
   collaborator's snapshots read as *former collaborator*; nothing is
   rewritten, so `/forget-me` stays O(1) and history never holds a Discord
   id.

6. **Bounded like everything else.** `runs/*/frames/`, `frames/`,
   `renders/`, interpreter caches and files over `historyMaxFileMb`
   (default 8 MB, clamped 1-512) are excluded through a managed
   `info/exclude`. History does not count toward the workspace quota; it has
   its own `historyMaxMb` (default 256 MB, clamped 1-10240). Over budget: pack
   (`git gc --prune=now`), then squash to a single snapshot, then pause
   snapshots until the workspace's trackable bytes fit. The listing reports
   `paused`.

7. **Restore is reversible and quota-checked.** The current state is
   snapshotted before a restore, the result is snapshotted after it, and a
   restore that would exceed the workspace quota is reverted. One path
   restores with `git checkout <hash> -- <path>` (files under the path);
   the whole workspace restores with `git read-tree --reset -u <hash>`
   (files the snapshot does not have are removed; ignored files are left
   alone). Revisions are validated against `^(HEAD(~\d+)?|[0-9a-f]{4,40})$`
   and resolved with `rev-parse --verify`, paths go through
   `legalizeWorkspacePath`, and every path argument follows `--`.

8. **One serial queue per repository.** A run settling while the portal
   saves a file must not race `index.lock`; `projectHistoryService`
   chains work per git directory in memory (transient, re-derivable
   state, the allowed exception to the SQLite rule).

## Out of scope here: remotes

Cloning, fetching and pushing need a credential story. This ADR keeps
history local; [ADR 0015](0015-project-repositories.md) adds GitHub clones
driven by the host with the person's own connected account (a credential
helper reading the token from one call's environment, never a token in the
sandbox, the person's own repository allowlist). The full profile shares
the `goobster-data` volume between the bot and `apps/api`, so host-side git
works in both runtime modes without routing through the gateway.

## Consequences

- `git` becomes a system dependency of the `projects` feature
  (`packages/core/features/inventory.js`), installed by the Docker images
  and `scripts/install-rpi.sh`, reported as missing by the installer
  preflight, and optional at runtime.
- New config: `observatory.historyEnabled` (`GOOBSTER_PROJECT_HISTORY_ENABLED`),
  `observatory.historyMaxFileMb`, `observatory.historyMaxMb`,
  `observatory.gitCommand` (`GOOBSTER_OBSERVATORY_GIT`).
- New tool actions on `observatory`: `history`, `diff`, `restore`,
  `commit`, and `read` with `rev=`. `inspect` shows the latest snapshots.
- New routes under `/api/app/projects/:slug/history`; the portal Files
  view gains a Snapshots rail.
- `projects.md`'s earlier line that a project could "clone a repository
  once" is corrected: sandbox runs have no network, so a repository arrives
  through `fetch-data` or an upload.
