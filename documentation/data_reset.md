---
title: Data reset - emptying the whole instance or one dormant feature's data (installer P4.2)
kind: reference
summary: The data.reset manager operation empties either every application table, the derived vector index and the owned file sets (scope instance) or the data of one feature that is not active (scope feature), on SQLite and Postgres alike. It runs only inside the maintenance barrier with every writer acknowledged, only after a verified backup and a typed confirmation, never touches the manager's own state, config.json, the database itself or any other schema, and leaves the instance paused. This document holds the inventory (what the data is made of and who owns it), the deletion plan for each scope, the rows reset intentionally keeps or recreates, the steps and refusal codes, the goobster-manager reset and release commands, the preview route, and the recovery after an interruption. It replaces the old npm run db-init -- --reset. Disabling a feature is still not a reset.
when: Changing the schema (a new table, a new foreign key across feature lines, a new file set); adding or moving a feature's data; running or debugging goobster-manager reset or the data.reset operation; recovering from a reset that stopped part way; deciding what a reset may touch.
tags: [installer, manager, reset, purge, dormant-data, maintenance, backup, privacy, destructive, operations]
---

# Data reset

A reset removes data. It exists so an operator can start an installation over,
or take a feature they no longer use out of the database, without hand-written
SQL and without the old `npm run db-init -- --reset` (a hard-coded drop list
that fell behind the schema; the flag now exits with an explanation). It is one
manager operation, `data.reset`, run inside the
[maintenance barrier](maintenance_barrier.md) after a verified
[backup](backup_and_restore.md).

Two scopes:

| Scope | What it removes | Who may run it |
|---|---|---|
| `instance` | Every application table's rows, the derived vector index and every owned file set. | The recovery credential or the local CLI (`via` `recovery` or `local`). |
| `feature` (with a feature id) | The data of one feature that is **not active**: its tables, its rows in shared tables, its derived indexes and its files. | The same, or a bridge or setup session. |

Disabling a feature stays non-destructive ([feature_state.md](feature_state.md)):
its data is kept, and a purge is a separate, typed, backed-up act on a feature
that is already off.

## Never touched

Neither scope reaches any of these, and the preview lists them:

- `config.json` and every environment value;
- the manager store: identity, operations journal, audit log, maintenance and
  lifecycle state;
- the database file or schema itself, its extensions and its roles. The reset
  empties tables; it does not drop them, and it never reaches another schema,
  another database or another service on the same server;
- `features.json` (which features are on);
- the sandbox Python environment and package overlay
  (`data/sandbox/venv`, `data/sandbox/overlay`);
- operator-authored files (`data/self-docs`, `data/tavern/campaigns`);
- the code, the release payload and the logs.

## The inventory

`packages/core/db/resetInventory.js` derives what the data is made of. It reads
and opens nothing that touches the database.

- **Tables** come from `packages/core/db/schema.sql`, parsed with the
  dialect's own statement splitter and foreign-key extractor. Each table's
  owner is the feature that claims it in `features/inventory.js`, or `core`.
- **Derived indexes** are the per-dimension `memory_vec_<dims>` tables that
  `memoryService.cleanupVecIndex()` maintains.
- **File sets** are the sets a backup carries (`backupService.FILE_SETS`),
  the dormant workspace roots (`dormantDataService`) and the few sets a backup
  leaves out: sandbox run workspaces, account export archives, downloaded
  music, generated ambience and the generated music cache.

What cannot be derived is written down as data in the same module and pinned by
`tests/resetInventory.test.js`: a new table, a new foreign key across feature
lines or a new backup file set that has not been classified fails that test
until somebody decides what a reset does with it.

### Deletion order

Tables are emptied children first, by topological order of the foreign keys
(`INVENTORY_CYCLE` if the schema ever grows a cycle). A feature purge also
follows the references that cross feature lines. For every such foreign key
the module holds an explicit policy (`CROSS_OWNER_REFERENCES`):

| Reference | Policy |
|---|---|
| `followed_sources.projectId` | delete: a source bound to a project goes with the project |
| `followed_source_entries.expeditionId` | set null: the fetched entry stays, without the link |
| `observatory_jobs.projectId` | delete: jobs run inside a project |
| `project_trigger_deliveries.sourceJobId` | delete: the delivery record names the job; the trigger stays |

A reference the table does not cover is `UNPLANNED_REFERENCE`, a test failure,
never a surprise at reset time.

### Shared rows

Some tables hold one feature's rows beside everyone else's. A purge removes
only those rows, by a literal discriminator (`SHARED_ROWS`, no parameters):

- `projects`: the project knowledge scopes (`kg_nodes`, `kg_tags`,
  `kg_reflection_runs`, `kg_artifacts` where `scopeKey LIKE 'PROJECT:%'`) and
  the files `kg_artifacts` points at;
- `projects` also removes its project discussion (`parlor_conversations`),
  knowledge transfers into a project and project inbox notices;
- `observatory`, `expeditions`, `github`: job reminders and attention
  provenance that name a job, expedition provenance in `kg_provenance`,
  expedition inbox notices, and the personal GitHub tokens in
  `user_integrations` (other providers stay);
- every feature: its rows in the work ledgers by work kind (`work_failures`,
  `resource_events`, `usage_reservations`) and resource kind, and the tutorial
  progress, events and feedback of its tutorials.

Work kinds that belong to core (chat, automation, followup, delivery, watch,
reflection, followed_source) are never touched by a purge.

### Cascading tables

A purge may reach a table only through `ON DELETE CASCADE` (transitively) or
`ON DELETE SET NULL`. Those tables are named in the plan as `cascading` (with
the operation and the column), so the preview says what the database will do
rather than leaving it to a foreign key. Purging `projects` is the large case.

### Files

An instance reset removes every file set. A purge removes the sets its
feature owns (`music`: library, ambience, cache; `projects`: workspaces and
dashboards; `push`: the web push keys; `sandbox`: run workspaces; `tavern`:
assets) and the files of rows it deletes. Files linked from a row are removed
before the transaction and the owned file sets after it. Every set is
checked first: a set that is not inside the data,
cache or uploads root of this installation is refused (`FILE_SET_UNSAFE`),
as is a symlink or a path the installer's safe-removal rules refuse.

## What an instance reset keeps and recreates

| Table | Treatment | Why |
|---|---|---|
| `operator_audit` | **kept** | The required operation audit. A reset keeps it and adds its own rows. |
| `data_migrations` | **kept** | Markers of one-time backfills that already ran; keeping them stops a backfill from running again over an empty database. |
| `instance_state` | **recreated** | Emptied, then the paused flag is written again in the same transaction (reason `reset`). |
| `self_docs` | **recreated** | Emptied, then reseeded from `documentation/` on the next start (or `npm run docs:seed`). Public docs, not user data. |
| `data/tavern/campaigns` | **kept** (files) | Operator-authored campaign files. |

Because the pause goes through `instanceStateService.pause`, the reset adds one
`operator_audit` row with action `instance.pause` in addition to the manager's
own `manager.data.reset` row. The instance comes back **paused**, like a
restore ([backup_and_restore.md](backup_and_restore.md)): the Host room offers
Resume, and nothing scheduled fires until then. A feature purge does not change
the paused flag.

## Steps

`data.reset` is a manager engine kind with five steps. The barrier phases are
the ones in [maintenance_barrier.md](maintenance_barrier.md).

| Step | Barrier phase | What it does |
|---|---|---|
| `preflight` | quiesced | The barrier is held with this operation's fence and every writer acknowledged; the typed confirmation matches; the database is this installation's (another engine, another database or another data root is `FOREIGN_TARGET`; on Postgres every statement is unqualified, so only the schema the connection's `search_path` selects is reached); a purged feature is not active; the plan still matches the revision. |
| `backup` | backup | Writes a backup into `backup.dir` through `backupService`, then **verifies** it with `verifyBackup` (snapshot not empty, schema fingerprint, row counts per table, file counts per set). A backup that cannot be verified blocks the reset. |
| `mutate` | mutate (irreversible) | Runs the plan in one transaction on the open database (`db/reset.js`), then the vector cleanup and the storage compaction. |
| `verify` | verify | Re-reads what the plan promised: no rows left in cleared tables, no vectors or orphan vectors, the paused flag, no files left, no orphaned references. |
| `cutover` | cutover | Re-checks the pause and records the result. |

The operation does **not** release the barrier. The result says
`barrier: 'held'` and `next: 'maintenance.release'`. `goobster-manager reset`
releases it after a successful run; through the operations API the operator
runs `maintenance.release`.

Row deletion and the pause rewrite happen in one transaction, so a failure in
the transaction rolls the database back to what it was; the file removals
around it cannot be undone, and the backup covers them.

### Typed confirmation

The operator types the installation id for an instance reset, or
`<installationId>:<feature>` for a purge. The preview shows the exact text. The
confirmation, the backup directory and the passphrase stay in the manager's
memory; the journal and the audit never carry them.

### The backup

`backup.dir` is required and must be an absolute directory outside every path
the reset removes (`BACKUP_DESTINATION_UNSAFE`). The passphrase protects the
encrypted copy of `config.json` ([backup_and_restore.md](backup_and_restore.md)):
it comes from the answers file or a hidden prompt, never from the command
line. `backup.skipConfig` leaves `config.json` out and needs no passphrase.
When a `config.json` exists, no passphrase and no `skipConfig` is
`PASSPHRASE_REQUIRED`.

## Refusals

Nothing is written before a refusal.

| Code | When |
|---|---|
| `BACKUP_REQUIRED` | No absolute `backup.dir`. |
| `PASSPHRASE_REQUIRED` | A backup that includes an existing `config.json` and has no passphrase. |
| `CONFIRMATION_REQUIRED` | The typed text is missing or does not match. |
| `INSTANCE_RESET_REQUIRES_LOCAL` | An instance reset from a bridge or setup session. |
| `FEATURE_ACTIVE` | A purge of a feature that is active. Disable it (`features.set`), restart, then purge. |
| `FEATURE_STATE_UNREADABLE` | `features.json` cannot be read, so it is not known whether the feature is active. |
| `CORE_NOT_PURGEABLE`, `UNKNOWN_FEATURE` | Scope input that names no purgeable feature. |
| `MAINTENANCE_NOT_HELD`, `WRITER_UNACKNOWLEDGED` | The barrier is not up with this fence, or a writer did not acknowledge it. |
| `FOREIGN_TARGET` | The open database is not the one the installation record names. |
| `FILE_SET_UNSAFE`, `BACKUP_DESTINATION_UNSAFE` | A path a reset must not remove, or must not write into. |
| `REVISION_CONFLICT`, `PRIVATE_INPUT_LOST` | The plan is stale, or the in-memory input was lost across a manager restart. Plan again. |
| `BACKUP_FAILED`, `BACKUP_UNVERIFIED` | The backup could not be written, or did not verify. `BACKUP_FAILED` names its cause as a code beside it (`BACKUP_FAILED (TOOL_VERSION_MISMATCH)`: the host's `pg_dump` is older than the Postgres server; `ENOTDIR`, `EACCES`: the destination), never a message or a path. |
| `RESET_FAILED`, `VERIFY_FAILED` | `mutate` or `verify` failed after the barrier crossed its irreversible boundary. |

## The commands

```bash
goobster-manager reset --scope instance --dry-run
goobster-manager reset --scope feature --feature music --dry-run
goobster-manager reset --scope feature --feature music --backup-dir /srv/backups --confirm <installationId>:music
goobster-manager reset --answers reset.json
goobster-manager release [--force --acknowledge-mutation]
```

`reset` is one local session: it prints the preview, asks for what is missing
(scope, feature, backup directory, confirmation, passphrase; the passphrase
through a hidden prompt), enters the maintenance barrier, runs `data.reset`,
and releases the barrier when the reset completed. `--dry-run` prints the
preview and stops: nothing is entered, written or deleted. The answers file
takes the `reset` definition in
`apps/manager/install/answers.schema.json`; the passphrase may be written
there but is never accepted on the command line. `--yes` (or a non-interactive
stdin) never replaces the typed confirmation: without `--confirm` or an answers
file entry it fails with `CONFIRMATION_REQUIRED`.

Exit codes are the installer's ([manager_install.md](manager_install.md)):
`0` done, `2` the input is invalid (missing or wrong confirmation, a secret on
argv), `3` refused (feature active, writers not acknowledged, stale barrier),
`4` the operation stopped part way (a step failed after the backup; see
Recovery below). `5` is not used: the reset needs no privileged helper.

### The preview route

`GET /manager/api/reset/plan?scope=instance` and
`GET /manager/api/reset/plan?scope=feature&feature=<id>` return the same
preview as `--dry-run`: tables cleared, partly cleared (shared rows) and
cascading, what is kept and recreated, the derived vector index, the file sets
(with counts where the files can be read), what is never touched, the text to
type, and whether a purge is blocked because the feature is active. It reads
the manager store and the file system only; it opens no database and shows no
row counts. Portal pages that use it come with the operator pages (#337).

## Recovery after an interruption

The barrier is durable and is not resumed by a new manager process. If the
reset stopped before `mutate` began, the barrier is cancel-safe: release it
(`goobster-manager release`) and start again. If it stopped after `mutate`
began, the barrier stays up and the CLI says so:

1. Make sure no other `goobster-manager` process is running.
2. `goobster-manager release --force --acknowledge-mutation` lifts the stale
   barrier. This is deliberately awkward: the data may be half removed.
3. Run the same `reset` again. The plan is idempotent: it empties what is left
   and verifies. The backup taken before the first attempt stays valid; a
   second reset takes a new one, of the partly reset database.

Within the same manager process, running `data.reset` again under the same
barrier resumes from the barrier's phase and does not take a second backup it
does not need.

## What this is not

- **Not disable.** Disabling a feature keeps its data and is reversible.
- **Not uninstall.** `install.uninstall --delete-data` removes the data
  directory and the installation; a reset keeps the installation, the code and
  the database.
- **Not erasure.** `/forget-me` and `privacyService` remove one person's data;
  a reset removes everything of a scope. The archives made before it keep what
  they carried ([backup_and_restore.md](backup_and_restore.md) § Privacy).
- **Not restore.** Restoring an archive onto the reset instance is a separate
  operation.
- **Not a database drop.** Tables, extensions, roles and other schemas stay.

## Privacy and audit

The audit action is `manager.data.reset`. Its detail is
`{ scope, feature?, tables, files, vectors, backupVerified: true }`: counts and
names, never a path, a row or the passphrase. The journal carries step names,
barrier codes and counts. The audit is reconciled into `operator_audit` like
every other manager operation.

## Tests

`tests/resetInventory.test.js` pins the classification: every table and file
set has an owner, the foreign-key order, the cross-owner policies, the shared
row predicates (run against an empty schema on both engines), the scopes and
the confirmations. `tests/dataReset.test.js` seeds a row in every table
(`tests/helpers/resetSeed.js`), runs a full instance reset and every feature
purge through the real kind and barrier, and checks that the kept rows are
untouched, the other features' rows survive, and vectors and files are gone.
It also covers every refusal, failure injection and resume, `verifyBackup`,
the preview route, the CLI and `scripts/initDb.js`. Both run on SQLite and on
Postgres in an isolated schema.
