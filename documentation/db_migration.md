---
title: SQLite to Postgres migration - preflight, verified copy, cutover and rollback (installer P4.3)
kind: reference
summary: How an installation moves from SQLite to Postgres through the manager. The read-only preflight (what it reads, what it never touches, blocks versus provisioning versus warnings), the db.migrate operation (maintenance barrier, verified backup, source snapshot hash, schema apply, per-table copy, verifications beyond row counts, validation by starting the application on the target, then the connection switch through the manager environment overlay), what happens at every crash point and how resume works, the exact rollback boundary and its one-sentence statement, the refusal and exit codes, the CLI (migrate preflight, run, rollback, status), and the developer script's reduced guarantees. It is not a Postgres to SQLite path, not restore, not reset and not a way to move the data root.
when: Moving an installation from SQLite to Postgres; reading a preflight report; resuming or rolling back an interrupted migration; deciding whether rollback is still possible; reviewing what a migration verifies; building the portal pages that show migration progress; changing the copy, the verification or the cutover.
tags: [installer, manager, migration, postgres, sqlite, preflight, verification, rollback, cutover, maintenance, overlay, cli]
---

# SQLite to Postgres migration

Installer Phase 4 item 3 (issue #336). The older script
(`npm run migrate-to-postgres`) copied every table and compared row counts.
This operation adds what a person moving their only copy of the data needs:
a preflight that proves the move can work before anything is touched, a
backup that is verified before the first write, checks that go beyond row
counts, a start of the application on the new database before the switch, a
durable record of how far it got, and a rollback with a stated limit.

It is built on the maintenance barrier ([maintenance_barrier.md](maintenance_barrier.md)),
the manager's operation engine ([manager.md](manager.md)), the backup service
([backup_and_restore.md](backup_and_restore.md)) and the environment overlay
([manager.md](manager.md#the-environment-overlay)).

**What it is not.** It only goes from SQLite to Postgres; there is no reverse
path (a restore is a separate decision, see the rollback limit below). It
never moves the data root or any file. It does not create a Postgres server,
a database or a role: the target is a schema in a database you already have,
and the only things it may create there are the tables of `schema.sql` and,
if you allow it, the `vector` and `citext` extensions. It does not delete or
change the SQLite file after the backup step.

## The rollback limit

This sentence is printed by the preflight, the CLI, the status route and the
rollback refusal, and is exported as `ROLLBACK_LIMIT`
(`packages/core/db/migration/rollbackLimit.js`):

> Rollback to the SQLite source is possible until the first write reaches Postgres. After the maintenance barrier is released and a worker starts on Postgres, the SQLite file is a backup, not a fallback: switching back is a separate restore decision, never automatic.

The boundary is derived, not remembered by a person. `migration.json` holds
`postgresAcceptedWritesAt` once a supervised worker starts after the switch
with the barrier released (`source: worker-start`), and the boundary is also
treated as passed when the migration's barrier was released after the cutover
(`source: barrier-release`). `db.migrate.rollback` after that is refused with
`POSTGRES_HAS_WRITES` and the sentence above as its message.

## The preflight

`db.migrate.preflight` (`manager.db.migrate.preflight` in the audit log) is
read only and holds no barrier, so it may run while the application is up. It
opens the source with SQLite `readonly` and the target with a raw `pg` client
inside `BEGIN READ ONLY ... ROLLBACK`; it never opens the application's
database facade, because that bootstraps the schema and extensions on first
use. A test proves the source's bytes and mtimes and the target's catalog are
unchanged afterwards and that a second empty schema stays at zero tables and
without a `vector` extension.

**Read:** the source file (size, whether a WAL holds data, `quick_check`, the
table list and counts, the columns against the expected schema); the target
(reachability, server version, whether the named schema exists and is empty,
`CREATE` privilege on the schema and database, which of `vector` and `citext`
are installed or available and whether the role may create them, and free space
when the manager can `statfs` the server's data directory: a remote or unreadable
data directory reports free space as unknown and the two space checks are not made).

The report sorts findings into three groups:

| Group | Code | Meaning |
| --- | --- | --- |
| Block | `SOURCE_MISSING`, `SOURCE_UNREADABLE`, `SOURCE_INTEGRITY` | The SQLite file is absent, cannot be opened read-only, or fails `quick_check`. |
| Block | `SOURCE_SCHEMA_AHEAD` | The source has columns this version does not know; copying would drop data. |
| Block | `SOURCE_SCHEMA_BEHIND` | The source lacks a required column (not null, no default); open the application once on this version first. |
| Block | `ALREADY_POSTGRES` | The installation already uses Postgres. |
| Block | `TARGET_UNREACHABLE`, `SERVER_TOO_OLD` | No connection, or the server is older than 13. |
| Block | `TARGET_SCHEMA_MISSING` | The URL names a schema (`options=-c search_path=...`) that does not exist; it is never silently replaced by `public`. |
| Block | `TARGET_NOT_EMPTY` | The schema already holds relations. |
| Block | `TARGET_NO_CREATE_PRIVILEGE` | The role cannot create tables in the schema. |
| Block | `EXTENSION_UNAVAILABLE`, `EXTENSION_PRIVILEGE` | `vector` or `citext` is not available on the server, or is not installed and the role may not create it. |
| Block | `INSUFFICIENT_SPACE` | Free space under 1.5 times the source size. |
| Provisioning | `EXTENSION_NOT_INSTALLED` | The extension is available and the role may create it. Reported as provisioning, not a block; `db.migrate` turns it into the block `PROVISIONING_NOT_ALLOWED` unless `provision.extensions` is true. |
| Warning | `SOURCE_SCHEMA_BEHIND` | An optional column is missing; the target default is used. |
| Warning | `UNCOPIED_TABLE` | The source has a table the schema does not (never copied). |
| Warning | `SOURCE_EMPTY` | The source holds no rows. |
| Warning | `LOW_SPACE` | Free space under 3 times the source size. |
| Warning | `ENV_OVERRIDES_OVERLAY` | `GOOBSTER_DB_URL` is set in the process environment and differs from the overlay; the workers see the environment value. |

The full integrity check (`PRAGMA integrity_check`) runs in the `snapshot`
step, inside the barrier; the preflight uses the quick one so it stays cheap
while the application runs.

## The operation

`db.migrate` runs only for `recovery` or `local` principals (the CLI is
`local`): it takes a connection secret and a passphrase and rewrites the
installation's connection, so no HTTP route plans it. Its input is
`privateInput` (memory only): the target URL and the backup passphrase are
never in the plan, the journal, the audit log, a log line or CLI output.
`confirm` must be the installation id. The installation record must be
managed (version 2); an adopted installation without roots is refused with
`NOT_MANAGED`.

When no `maintenance` is passed, the operation enters the barrier itself
(preflight, begin, quiesce, verify of quiescence) and reuses its own barrier
when resumed. Passing `maintenance: { operationId, fence }` uses a barrier
you hold (`maintenance.enter`); it must be quiesced with every writer
acknowledged. The manager process never opens the application database:
every step that does runs in a child process
(`apps/manager/migration/childEntry.js`) that answers with names, counts and
booleans only.

| Step | Source (SQLite) | Target (Postgres) | If it crashes here | Resume |
| --- | --- | --- | --- | --- |
| `preflight` | read only | read only | Nothing was written. | Run again. |
| `maintenance` | untouched | untouched | The barrier is released if this operation entered it and the phase is cancel-safe. | Run again. |
| `backup` | opened through the application adapter to take the archive (this applies pending app data migrations, so the file's bytes may change here and nowhere later) | untouched | The archive may be partial; it is never used until `verified`. | Runs again; skipped once recorded. |
| `snapshot` | full `integrity_check`, sha256 of the file and any non-empty `-wal` | untouched | Nothing changed. | Skipped when done; a different hash is `SOURCE_CHANGED`. |
| `provision` | untouched | creates missing extensions if allowed, applies `schema.sql` | Extensions and tables created so far are recorded in `migration.json`, so rollback drops exactly those. | Skipped when done. |
| `copy` | one pinned read transaction | one transaction per table, then identity sequences re-seated | A table is either complete or empty; the progress file says which. | Finished tables are re-counted and skipped; an incomplete one is cleared with `DELETE FROM` (never `TRUNCATE ... CASCADE`) and copied again. |
| `verify` | read only, hash re-checked | read only | Nothing changed. | Runs again. |
| `validate` | untouched | read only (counts compared before and after) | The validation workers are stopped. | Runs again. |
| `cutover` | untouched | marks the instance paused | See the cutover order below. | `reconcileMigration` completes it at manager start. |
| `settle` | untouched | untouched | The barrier is left held in `cutover`. | Run again. |
| `release` | untouched | untouched | The barrier stays held. | Only with `release: true` (`--release`). |

A failed step marks the operation `failed` and the migration state `failed`
with the step and a code (never a message that could carry a value). Running
the same command again plans the same signature (installation id plus target
fingerprint) and resumes; a different target while a partial state exists is
refused with `MIGRATION_IN_PROGRESS` until it is rolled back. Before `mutate`
begins a failure releases a barrier the operation entered; after it, the
barrier is only `settle`d as failed and stays up for an operator. A barrier
the operation entered belongs to the process that entered it, so after a
restart it is stale; resuming over it needs the forced release described in
[maintenance_barrier.md](maintenance_barrier.md).

### The backup is verified before anything is written

`backupService.createBackup` writes the archive (SQLite file through the
online backup API, files, `config.json` encrypted under the passphrase or
left out with `skipConfig`). `backupService.verifyBackup(dir, { expectCounts })`
then checks that the manifest parses, its schema fingerprint is this code's
and, for a SQLite archive, that the snapshot file opens read-only and holds
the live row count of every table. Anything else is `BACKUP_UNVERIFIED` and
nothing was changed. The passphrase is only in `privateInput`.

### What is verified beyond row counts

All run against the copy in the `verify` child, with the same SQL on both
sides, and report only names, counts and booleans:

1. **Row counts** per table, source against target.
2. **Foreign keys.** Every foreign key in `schema.sql`: no orphan row on the
   target.
3. **Identities.** `MAX(id)` of every identity column equals the source's and
   the sequence's next value is `MAX + 1` (the next insert cannot collide).
4. **Five relationship checks** (join counts must agree):
   `user-memories` (`memory_embeddings.authorId` = `users.discordId`);
   `project-files` (`project_assets` joined to `observatory_projects` on id and
   user and to `project_asset_versions` through `currentVersionId` and
   `assetId`); `inbox-person` (`inbox_items.userId` is a `users.discordId` or
   a `principals.id`); `exchange-positions-accounts` (`short_positions` and
   `option_positions` against `exchange_accounts` on guild and user);
   `graph-edges-nodes` (`kg_edges` against `kg_nodes` at both ends).
5. **Content sampling.** Per table the first, last and three interior rows by
   primary key (positions 0, n/4, n/2, 3n/4 and n-1, deduplicated). The keys
   are chosen on the **source** and fetched on the target by primary-key
   equality, so a different collation (SQLite `NOCASE`, Postgres `CITEXT` or
   locale order) cannot make the two sides pick different rows. A table
   without a primary key is skipped and listed. Each column is compared after
   normalisation:

   - `null` and `undefined` are both null;
   - booleans become 0 and 1;
   - integers, bigints and numbers compare as numbers; a number against a
     numeric string compares by value;
   - binary values compare by bytes;
   - dates become UTC `YYYY-MM-DD HH:MM:SS`; a timestamp-shaped string has `T`
     replaced by a space and a trailing `Z` or zero fraction dropped;
   - JSON text that differs as a string is parsed and compared deeply;
   - every other string must be identical (a `CITEXT` column keeps its case).

6. **Attachments.** The columns that name a file on disk
   (`kg_artifacts.relativePath`, `web_generated_files.path`,
   `observatory_jobs.renderPath`) still resolve to a file under the same data
   roots the backup uses. Nothing is moved and a path is never reported.
7. **Vectors.** The derived `memory_vec_*` index is never copied; it is
   rebuilt from `memory_embeddings`, and the count indexed is reported.

In the same step the source's hash must still equal the snapshot's.

### Validation: the application is started on the target before the switch

`validate` starts the layout's real worker scripts against the target with
the maintenance fence still up, on different ports, without the sandbox
runner and with a private state directory holding a copy of the active
`maintenance.json`, so they boot fenced (no write reaches the target) and
acknowledge into the private directory. Each worker must report healthy
within the bound (`VALIDATION_FAILED` otherwise); then they are stopped.
Target row counts are read before and after (ignoring derived vector
tables); a change is `VALIDATION_WROTE`: the fence did not hold, and the
configuration was not switched. In a lite installation this starts a second,
fenced bot process (a second Discord session for a moment).

### The cutover

The order is the whole point; each line is one durable fact:

1. A `finalize` child pauses the instance (`instance_state`) and records
   `lastMigration` on the target. The instance comes up paused and an
   operator resumes it, as after a restore.
2. `migration.json` records `cutover.phase = 'switching'`.
3. The overlay is written: one atomic rename of
   `<managerStore>/environment.json` (mode `0600`) holding `GOOBSTER_DB_URL`.
4. The installation record gets `database: { engine: 'postgres', external: true }`.
5. The running manager's settings take the overlay (`environment.apply`).
6. `migration.json` becomes `switched`.
7. The supervised workers are restarted; they boot fenced because the
   barrier is still up. The barrier is then `settle`d `ok` and stays held in
   `cutover` unless `release` was requested.

A crash between 3 and 6 is completed from the overlay by
`reconcileMigration` when the manager next starts (the overlay is the truth
for what the workers will read); a crash before 3 is recorded as `failed`
with `INTERRUPTED` and the source configuration stands.

The overlay is merged **beneath** the process environment: a
`GOOBSTER_DB_URL` set in a unit file or a shell still wins, and the
preflight and status say so by key name only. Workers the manager does not
supervise (`GOOBSTER_MANAGER_WORKERS=external`, or a manager that is not
supervising) do not read the overlay; restart them yourself with
`GOOBSTER_DB_URL` set.

## Rollback

`db.migrate.rollback` (`manager.db.migrate.rollback`) is refused after the
boundary above (`POSTGRES_HAS_WRITES`). Before it: it reverts the switch (if
one happened: the overlay value is removed, the record's `database` is put
back, workers restart), then drops exactly the tables and extensions that
`migration.json` says this migration created (a foreign object in the schema
is `ROLLBACK_FOREIGN_OBJECTS` and nothing is dropped), then records
`rolled-back`. It needs `confirm` (the installation id) and, when the
migration provisioned the target, the same target URL (its fingerprint must
match, else `TARGET_MISMATCH`). `releaseMaintenance` (`--release`) also
releases the barrier, forcing it if it is stale. Nothing after the backup
step changes the SQLite file, so it is the fallback.

## Refusal and error codes

`INVALID_INPUT`, `ROOT_NOT_MOVABLE` (the data root differs from the recorded
one), `NOT_MANAGED`, `ALREADY_POSTGRES`, `ALREADY_MIGRATED`,
`MIGRATION_IN_PROGRESS`, `MIGRATION_STATE_UNREADABLE`, `REVISION_CONFLICT`,
`CONFIRMATION_REQUIRED`, `MAINTENANCE_NOT_HELD`, `WRITER_UNACKNOWLEDGED`,
`STALE_MAINTENANCE`, `PHASE_NOT_ALLOWED`, `PREFLIGHT_FAILED` (with the finding
codes), `PROVISIONING_NOT_ALLOWED`, `BACKUP_UNVERIFIED`, `SOURCE_CHANGED`,
`VERIFY_FAILED`, `VALIDATION_FAILED`, `VALIDATION_WROTE`,
`NOTHING_TO_ROLL_BACK`, `POSTGRES_HAS_WRITES`, `TARGET_MISMATCH`,
`ROLLBACK_FOREIGN_OBJECTS`, `PLAN_INPUT_LOST` (the manager restarted between
plan and apply; plan again).

## The CLI

```bash
node apps/manager/cli.js migrate preflight --answers pre.json [--json]
node apps/manager/cli.js migrate run --answers run.json --confirm <installationId> [--release] [--yes] [--json]
node apps/manager/cli.js migrate rollback [--answers undo.json] --confirm <installationId> [--release] [--yes] [--json]
node apps/manager/cli.js migrate status [--json]
```

The target URL and the backup passphrase come **only** from the answers file
(mode `0600`, owned by you, not a link) or a hidden prompt; a flag named like
a secret is refused. Both values, and the overlay's values, are masked
verbatim in every line the CLI prints. `migrate status` reads the manager
store only. There is no `--dry-run`: `migrate preflight` is the read-only
check.

```json
{
  "command": "migrate",
  "target": { "url": "postgres://goobster@db.internal:5432/goobster?options=-c%20search_path%3Dgoobster" },
  "backup": { "dir": "/var/backups/goobster", "passphrase": "..." },
  "provision": { "extensions": true }
}
```

The definitions are `migrate-preflight` (`target`), `migrate` (`target`,
`backup.dir`, `backup.passphrase` or `backup.skipConfig`,
`provision.extensions`, `confirm`, `roots.data`, `release`) and
`migrate-rollback` (`target`, `confirm`, `releaseMaintenance`) in
`apps/manager/install/answers.schema.json` (`node apps/manager/cli.js schema`).

Progress goes to stderr: one line per step (`[db.migrate] copy ...`) and, in
the copy, one line per table when it starts and when it is done with its row
count. The result goes to stdout (or one JSON document with `--json`) and
includes the rollback limit sentence.

| Exit | Meaning for `migrate` |
| --- | --- |
| 0 | Done (preflight: ready). |
| 1 | Unexpected error. |
| 2 | Invalid input, a missing or wrong confirmation, or a preflight block. |
| 3 | Refused: wrong state, already migrated or Postgres, barrier problems, rollback after the boundary, nothing to roll back. |
| 4 | A step failed or the run was interrupted; run the same command to resume, or roll back. |
| 5 | Not used by `migrate`. |

The CLI enters the barrier itself, and the barrier belongs to the process
that entered it: when the CLI exits the barrier is stale. Pass `--release` to
`migrate run` to release it after the cutover, or release it from the
operator pages (`maintenance.release`, forced when stale) when you are ready
to accept writes. Releasing it closes the rollback window as described above.

## The developer script

`npm run migrate-to-postgres` (`scripts/migrate-to-postgres.js`) is kept as a
developer path built on the same modules (`packages/core/db/migration`). It
requires an empty target, runs the copy and the same verification, and
prints that it provides reduced guarantees: no maintenance barrier, no
backup, no consistent hold on the source, no validation start, no overlay or
configuration switch and no resume. Stop the application before using it and
use the manager CLI for an installation.

## Where the pieces live

| Piece | File |
| --- | --- |
| Inspection, classification | `packages/core/db/migration/inspect.js`, `target.js`, `schemaModel.js` |
| Source snapshot and hash | `packages/core/db/migration/source.js` |
| Copy, verification, attachments | `copy.js`, `verify.js`, `attachments.js` in the same directory |
| Operation kinds | `apps/manager/engine/kinds/migrate.js` |
| State, progress, reconcile, status | `apps/manager/migration/` |
| Environment overlay | `apps/manager/environment.js` |
| Routes | `GET /manager/api/migrate/status`, `POST /manager/api/migrate/preflight` (`apps/manager/routes/migrate.js`) |
| Audit actions | `manager.db.migrate.preflight`, `manager.db.migrate`, `manager.db.migrate.rollback` |

The migrate audit row carries only `tables`, `rows`, `vectors`, `provisioned`
and `backupVerified` (rollback: `tables`, `switchReverted`); never a URL, a
passphrase, a path or a row. Audit rows wait in the manager journal until
the manager runs on the new connection and reconciles them into
`operator_audit`.

## Tests

`tests/dbMigrationInspect.test.js` (read-only inspection, classification),
`tests/dbMigration.test.js` (the operation end to end, refusals, resume,
cutover reconcile, rollback boundary, audit), `tests/dbMigrationCli.test.js`
(the CLI) and `tests/managerEnvironmentOverlay.test.js` (overlay,
`verifyBackup`). The Postgres journeys need `GOOBSTER_DB_URL` and an isolated
schema.
