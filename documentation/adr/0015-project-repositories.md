# ADR 0015: Project repositories are GitHub clones driven by the host with the person's own connection

## Status

Accepted. Behaviour is documented in
[projects.md](../projects.md#repositories); the service is
`packages/core/services/projectRepoService.js`. This is the "remotes"
decision [ADR 0014](0014-workspace-history.md) left open.

## Context

ADR 0014 gave every workspace a git history and deliberately stopped at
the remote: cloning, fetching and pushing need a credential, and the
sandbox runs model-written code with no network and a scrubbed
environment, so a token could never go in there. Three facts shape the
rest:

1. **People already connect their own GitHub account.** `user_integrations`
   holds a personal fine-grained token per person (Settings → Connections),
   verified live at connect time, with a personal repository allowlist
   (`githubAllowlist`) that the GitHub chat tools already enforce. There is
   no need for the operator's `GITHUB_TOKEN` to act for anyone.
2. **The host has the disk.** In the lite profile the bot owns
   `data/`; in the full profile `goobster-data` is one volume shared by the
   bot, `apps/api` and the sandbox runner (which mounts only `data/sandbox`).
   Host-side git works in both.
3. **Workspace history must keep covering the files.** A `.git` directory
   inside the workspace would make history record a gitlink instead of the
   files, and would be visible to (and corruptible by) a snippet.

## Decision

1. **The acting person's own GitHub connection, or nothing.** Every
   remote operation (clone, fetch, pull, push, ls-remote) uses the token of
   the person asking, read from `user_integrations` for that call. No
   connection means a clear `NO_GITHUB` refusal; nothing is ever done under
   the operator's identity, and the person's `githubAllowlist` applies to
   clones and pushes exactly as it does to the GitHub chat tools.

2. **The token reaches git through a credential helper that reads the
   environment of that one call**, never through a URL, a command line or a
   file: `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` set `credential.helper` to a
   shell function that echoes `username=x-access-token` and
   `password=$GOOBSTER_GIT_TOKEN`. The stored remote is always
   `https://github.com/<owner>/<name>.git`. `GIT_ALLOW_PROTOCOL=https` pins
   the transport so a remote can never be a local path, ssh or an `ext::`
   command. Everything else about the environment is the sealed one of
   ADR 0014 (`packages/core/utils/sealedGit.js`).

3. **The clone's git directory is a sibling of the workspace**,
   `data/sandbox/projects/<owner>/<slug>.repos/<name>.git`, and its work tree
   is `<workspace>/repos/<name>`. To the sandbox and to workspace history
   the clone is plain files: snapshots cover them, `restore` can bring back
   what a `reset` discarded, and nothing in the workspace names a git
   directory. Git's own `.gitignore` inside the clone is honoured by
   workspace history too, since history runs `git add -A` over the work
   tree.

4. **Commits in a clone carry the person's GitHub identity**
   (`<id>+<login>@users.noreply.github.com`, from `GET /user` on their
   token), because they are theirs to push. Workspace history keeps its
   project-scoped pseudonyms; the two repositories have different
   audiences.

5. **Pushes are never forced, and the remote is never merged into locally.**
   `pull` is fetch plus `--ff-only`; a diverged branch is reported
   (`DIVERGED`) with the two honest ways out (push the local commits, or
   `reset` to origin). A rejected push says to pull first (`REJECTED`); a
   protected branch says to push elsewhere and open a pull request
   (`PROTECTED_BRANCH`). Pushing a branch other than the one cloned returns
   the GitHub compare URL so a pull request is one click away.

6. **Destructive local operations snapshot first.** `reset`, `checkout` and
   `remove` take a workspace-history snapshot before touching files, so
   everything they discard is one `restore` away.

7. **Bounded.** Clones are shallow (`repoCloneDepth`, default 50 commits),
   one branch at a time, capped per project (`maxReposPerProject`, default 3)
   and in size (`repoMaxMb`, default 512 MB, checked against GitHub's
   reported size before cloning and against the git directory after). The
   work tree counts toward the project quota like any other file; a clone
   that breaks it is undone. One serial queue per clone, as for history.

8. **Attributable.** Every clone and push writes an `integration_audit`
   row under the person's DM scope (`dm:<userId>`): the project, repository
   and branch, never the token. `project_repos.createdBy` is nulled by the
   person's erasure; the clone itself is project data and stays with the
   project.

## Out of scope

Pull-request creation, reviews and GitHub Actions stay with the existing
`github` tools and the Cursor integration. Non-GitHub hosts need their own
connection story and are not accepted as remotes. Merging on the person's
behalf (rebases, conflict resolution) is deliberately absent: the clone
exposes the state and the honest ways out, and a run in the project can do
the rest as plain file edits.

## Consequences

- New table `project_repos`; new config `observatory.reposEnabled`
  (`GOOBSTER_PROJECT_REPOS_ENABLED`), `maxReposPerProject`, `repoCloneDepth`,
  `repoMaxMb`.
- New tool actions on `observatory`: `repo_clone`, `repo_list`,
  `repo_status`, `repo_pull`, `repo_commit`, `repo_push`, `repo_branch`,
  `repo_reset`, `repo_remove`.
- New routes under `/api/app/projects/:slug/repos`; the portal Files view
  gains a `repos/` panel with clone, pull, commit, push, branch, reset and
  remove.
- The `projects` feature needs the `github` feature for identity lookups;
  with it off, repositories report `GITHUB_OFF` and everything else about
  projects keeps working.
- Git 2.31 or newer on the host (for `GIT_CONFIG_COUNT`); Debian bookworm,
  Raspberry Pi OS and the Docker images all qualify.
