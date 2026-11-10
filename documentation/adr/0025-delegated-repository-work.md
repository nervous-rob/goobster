# ADR 0025: A delegated run commits, pushes and opens pull requests through the project-repository service, behind a guard, a private-read rule and a daily cap on what leaves

## Status

Accepted for DA-11a of the
[delegated assistant plan](../delegated_assistant_implementation.md):
repository work in a clone of the responsibility's linked project. It builds
on [ADR 0015](0015-project-repositories.md) (project repositories; amended
for this), [ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0018](0018-delegated-runs.md) (the run and its tool contract; amended
for this) and [ADR 0019](0019-delegated-plan-steps.md) (the private-context
rule). Behaviour is documented in
[delegated_runs.md](../delegated_runs.md#repository-work). The code is
`services/assistant/runTools/projectRepos.js`, the executor in
`services/assistantRunService.js` and four read methods plus two options in
`services/projectRepoService.js`, all under `packages/core/`.

Saved-note edits (DA-11b), findings for a project's members (DA-11c) and
outside connectors (DA-11d) are not part of this decision.

## Context

The grant vocabulary has carried `repo.commit`, `repo.push` and `pr.create`
since DA-1, with a repository resource that names branch patterns, and
`authorize()` has checked them since then. No run tool used them. A person
could already commit, push and open a pull request in a project clone from
chat and the portal ([ADR 0015](0015-project-repositories.md)): host-side
sealed git, their own GitHub token, never forced.

A push and a pull request are the first run effects that leave the
installation. They differ from everything a run could do before in three
ways. They cannot be undone from here. Whether a branch may be written is
partly known only to GitHub (the default branch, branch protection). And
their audience is whoever can read the repository on GitHub, which nothing
in this database knows.

## Decision

Three run tools, `commitProjectRepo`, `pushProjectRepo` and
`openPullRequest`, each a table entry in `runTools/projectRepos.js` and none
a chat tool. They call `projectRepoService` and nothing else, as the
responsibility's owner, in a clone of the linked project only. Every call
names its branch. A commit names its paths. A pull request opens as a draft
unless asked otherwise, into the branch the clone started from, and never
pushes on the way. A rejected push is a result the run reports; there is no
tool that pulls, merges, rebases, resets or deletes a branch.

The tool contract of ADR 0018 gained four things for this.

1. **`needs` may be async.** The repository a call means is found by the
   clone's folder name in the linked project (`project_repos`), so `needs`
   reads our own database. It still never reads the outside world.

2. **`guard(args, ctx)` runs after `authorize()` and before the call is
   journaled as dispatched.** Whether a branch is the default branch or is
   protected is known only to GitHub, and asking uses the person's token, so
   it must not be asked until the grant has allowed the call. A guard
   returns a refusal code or null; one that throws refuses. The repository
   guard also checks the pilot gate
   (`assistantAccessService.allows(owner, 'reach')`), so the capability is
   checked where it is dispatched as well as where it is granted. It fails
   closed: if GitHub cannot say whether a branch is protected the call is
   refused with `BRANCH_UNVERIFIED`. The alternative, checking inside `run`,
   would journal a refused call as a dispatched write.

3. **`publishes: 'external'` is refused after any private read.** ADR 0019
   lets a run that read private knowledge write into a project only the
   person reads. A repository on GitHub has an audience nobody here knows,
   so a push or a pull request after `lookupNotes` or `listGeneratedNotes`
   is refused with `PRIVATE_CONTEXT` whoever can read the project. A commit
   is `publishes: 'project'`: it stays in the clone. The rule is per run. It
   does not track text across runs or text a person put in the clone.

4. **`budget: 'externalOperations'` is counted from the journal.** The cap
   is per responsibility per UTC day: the grant's own number up to a fixed
   ceiling of 20, and 2 when unset. The count is rows of tools with this
   budget that are `PREPARED`, `DISPATCHED`, `UNCERTAIN` or `FAILED`, or
   `SUCCEEDED` with a result that does not begin "Not ". An attempt whose
   outcome is unknown counts; a refusal or a declined call does not. The
   check runs after the call's own `PREPARED` row is inserted and counts
   only rows with a smaller id, so two runs racing for the last one cannot
   both take it. No counter column was added: the journal already is the
   record, and a crash cannot lose a count. Over the cap is `EXTERNAL_BUDGET`,
   a refusal the run reports; it does not park the work.

5. **The offer follows the grant.** `available()` also receives the
   responsibility's granted operations and the owner's pilot capabilities.
   The repository tools are offered only when the grant names the operation
   on a repository of the linked project, so a run without such a grant
   gets the same tool list, and the same prompt, as before.

6. **Three branches are refused whatever the grant's patterns say:** the
   branch the clone started from (`BASE_BRANCH`, checked in `needs` from our
   own row), the repository's default branch (`DEFAULT_BRANCH`) and a
   protected branch (`PROTECTED_BRANCH`), both in the guard. Refusing the
   clone's base as well as the default is deliberate: a clone can be made
   from a non-default branch, and that branch is the base every pull request
   goes into. A commit is refused on them too, not only a push, so nothing
   is prepared locally that could not leave.

7. **After a crash the outside is asked before anything is tried again**
   (ADR 0018 decision 3), by tool:

| Tool | Asked | Done | Absent | Unknown (review) |
| --- | --- | --- | --- | --- |
| `commitProjectRepo` | The last 50 commits of the local branch | One carries the trailer `Goobster-Operation: <run>:<op>` | None does | The clone cannot be read |
| `pushProjectRepo` | `git ls-remote` for the branch, with the person's token | GitHub's head is the local commit | The branch is not on GitHub, or GitHub's head is an ancestor of the local commit | GitHub's head is some other commit, or no answer |
| `openPullRequest` | The open pull request whose head is the branch | One exists (adopted when its description carries the operation's marker, else reported as already open) | None exists | No answer |

   A commit carries the trailer so it can be found without trusting the
   working tree. A pull request carries the same marker in its description.
   "Unknown" stops the work for review (`OPERATION_UNCERTAIN`); it is never
   retried.

8. **Every result that reached GitHub says it cannot be undone from here**,
   and that sentence is the first line of the result, which is what the
   run's report lists under what it changed.

## What is deliberately not here

- A way to pull, merge or rebase a work branch. A rejected push is for the
  person to resolve.
- A host-wide cap on `externalOperations`. The ceiling is a constant.
- A report when a run stops before filing its result. The step is in the
  work item's journal and in `integration_audit`.
- A `resource_events` row for a push or pull request. The kinds are an
  enumerated list and the journal is the count of record.
- Tracking private text across runs, or text a person put in the clone.
- Watching a pull request's checks.

## Consequences

- No schema change. The budget is counted from `assistant_run_operations`.
- A run without a repository grant is offered the same tools as before, so
  its prompt, and its prompt fingerprint, do not change. A run with one has
  a new fingerprint; the live evaluation should be rerun.
- Each guarded call costs two GitHub reads (the repository and the branch)
  before it is dispatched, on the person's own rate limit.
- A branch protected only by a repository ruleset that GitHub's branch
  endpoint does not report as protected passes the guard; GitHub then
  rejects the push, which is reported as `PROTECTED_BRANCH` and counts as an
  attempt.
- DA-11d (connectors) should reuse `guard`, `publishes: 'external'` and the
  `externalOperations` budget for `external.write`.
