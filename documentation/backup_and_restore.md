---
title: Backup and tested restore
kind: guide
summary: What a backup archives (every file set, with the issue that added it), what is encrypted (only config.json, never the archive), how the manager's backup and restore operations, the Host Maintenance page, the wizard and the CLI write and restore one, which secrets you re-enter, where set-aside data lives, how to resume safely, what a restore refuses, and the recovery test that must pass on both engines before a pilot.
tags: [operations, backup, restore, deployment, privacy, manager, wizard, maintenance, encryption, passphrase]
---

# Backup and tested restore

Roadmap [#249](https://github.com/nervous-rob/goobster/issues/249). A backup that has never been restored is a hope, not a backup: this runbook defines the archive, the restore, what the restore refuses, what it does to work that was in flight, and the recovery test an operator runs before inviting anyone.

**What this document claims, and what it does not.** Installer P4.4 ([#337](https://github.com/nervous-rob/goobster/issues/337)) puts backup and restore behind the manager's operations, the setup wizard, the Host room's Maintenance page and the manager CLI ([Through the manager](#through-the-manager)), audits which file sets the archive covers ([Which files are archived](#which-files-are-archived)), and adds regression evidence for all of it. It does **not** claim the owner's drill: a restore of a real archive onto a real second host, with the dated entry in the deployment log that [the recovery test](#the-recovery-test) requires (#249), is human evidence, and nothing automated stands in for it.

There are two ways in. The manager's operations (`goobster-manager backup`, `goobster-manager restore`, the wizard and the Host room) are the supported path for an installation the manager looks after; they fence the application, hold the maintenance barrier and keep a durable record. The developer scripts below remain for a repository checkout:

```bash
npm run backup   -- [--out <dir>] [--skip-config] [--passphrase-file <path>]
npm run restore  -- <archive dir> [--force] [--accept-schema-change] [--without-config] [--passphrase-file <path>]
```

The bot and the api may keep running during a backup (SQLite uses the online-backup API; Postgres uses `pg_dump`). **Stop them before a restore.**

On Postgres the client tools must be **at least the server's major version**: `pg_dump` refuses a newer server (`TOOL_VERSION_MISMATCH`, which names both versions). Install the matching `postgresql-client-<major>` and either put its bin directory first on PATH or set `GOOBSTER_PG_BIN=/usr/lib/postgresql/17/bin` (any directory holding `pg_dump` and `pg_restore`); Debian's `pg_wrapper` otherwise picks the version of the local cluster, not the newest installed. CI installs `postgresql-client-17` for the same reason.

## What an archive contains

An archive is a directory, `goobster-backup-<UTC stamp>/`, written under `<data dir>/backups/` unless `--out` says otherwise:

| Path | Contents |
|---|---|
| `manifest.json` | Format version, when and by which Goobster version it was made, the database engine, the **schema fingerprint**, a row count for every application table, the file sets included, whether `config.json` is inside, and the **names** of the environment secrets that were set. |
| `database/goobster.sqlite` | SQLite: a consistent copy taken with better-sqlite3's online backup while the bot runs. |
| `database/goobster.dump` | Postgres: `pg_dump --format=custom`, limited to the schema the installation uses. |
| `files/projects/`, `files/dashboards/` | Project files and dashboards (`data/sandbox/projects`, `data/sandbox/dashboards`). |
| `files/uploads/` | Portal uploads (`GOOBSTER_UPLOADS_DIR` or `data/web-uploads`). |
| `files/artifacts/` | Saved knowledge files (`GOOBSTER_KG_ARTIFACTS_DIR` or `data/kg-artifacts`). |
| `files/images/` | Generated images (`data/images`). |
| `files/tavern-campaigns/`, `files/tavern-assets/` | Tavern campaign overrides (`GOOBSTER_TAVERN_CAMPAIGNS_DIR` or `data/tavern/campaigns`) and assets. |
| `files/web-push-keys` | The self-generated Web Push (VAPID) key pair (`data/web-push-keys.json`, `pwa.md`); without it every browser push subscription is stranded. |
| `config.json.enc` | `config.json`, encrypted. Present only when a passphrase was given. |

File sets are resolved against the data directory of the installation doing the backup or the restore, never against a path recorded by the other side, so an archive moves between machines and layouts.

### Which files are archived

Every directory the application writes under its data directory is classified, in `DATA_CLASSIFICATION` in `packages/core/services/backupArchive.js`: either archived (a file set, or the database) or left out with a reason. `tests/backupOperations.test.js` fails when the source keeps a path under `data/` that no entry names, so a new store cannot silently miss the backup. A set added after the first release says so in the "Since" column, and a restore of an older archive simply has no files for it (the restore plan lists the sets the archive lacks, `fileSetsAbsentInArchive`).

| Path under the data directory | Disposition | Archive name | Since | Why |
|---|---|---|---|---|
| `goobster.sqlite` | archived | `database/goobster.sqlite` (Postgres: `database/goobster.dump`) | #249 | The application database. |
| `sandbox/projects` | archived | `files/projects/` | #249 | Project files. |
| `sandbox/dashboards` | archived | `files/dashboards/` | #249 | Dashboards. |
| `web-uploads` | archived | `files/uploads/` | #249 | Portal uploads, including notes and chat attachments (#313). |
| `kg-artifacts` | archived | `files/artifacts/` | #249 | Attachments saved as knowledge entities. |
| `images` | archived | `files/images/` | #249 | Generated images. |
| `tavern/campaigns` | archived | `files/tavern-campaigns/` | #249 | Campaign overrides. |
| `tavern/assets` | archived | `files/tavern-assets/` | #249 | Campaign assets. |
| `web-push-keys.json` | archived | `files/web-push-keys` | #249 | Without it every browser push subscription is stranded. |
| `user-ai.key` | left out | | Personal AI | Encryption key for personal API credentials; back up separately as a secret. |
| `self-docs` | archived | `files/self-docs/` | #337 | Operator documents added to Goobster's own knowledge (`selfDocs.operatorDir` pointing elsewhere is not followed). |
| `manager` | left out | | | The manager store: installation identity, the operation journal, the audit log, maintenance state. Installation state, not user data. |
| `features.json` | left out | | | The feature choice belongs to the installed payload and is set again through the Features page or the manager. |
| `command-deploy.json`, `.command-deploy-hash` | left out | | | Derived: the last slash-command deployment. |
| `account-exports` | left out | | | Temporary account export archives; a restore deletes them on purpose. |
| `sandbox/runs`, `sandbox/venv`, `sandbox/overlay` | left out | | | Temporary workspaces and the derived Python toolkit (`npm run sandbox-python`). |
| `backups` | left out | | | The default destination of backups: an archive never contains archives. |
| `music`, `ambience`, `playlists`, `voiceLimits.json` (relative to the working directory) | left out | | | Downloaded media, generated clips, in-memory playlists and transient counters. |

The manifest records the sets it knows (`fileSetsKnown`) and the paths it leaves out (`excluded`), and whether the backup was taken `quiesced` (inside the maintenance barrier, with every writer fenced) or live.

Not in the archive, on purpose:

- **Environment secrets.** `GOOBSTER_USER_AI_ENCRYPTION_KEY`, `GOOBSTER_DB_URL`, `GOOBSTER_INTERNAL_TOKEN`, `DISCORD_CLIENT_SECRET`, the provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `ELEVENLABS_API_KEY`), `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `CURSOR_API_KEY`, `CURSOR_WEBHOOK_SECRET`, `SPOTIFY_CLIENT_SECRET`. The manifest records which of these were set (`envSecrets.present`) so a restore can list what to re-enter; their values are never written anywhere.
- **Re-derivable state**: the self-docs corpus (reseeded on the next start), admission leases, live turns, the chat queue, and the per-dimension vector index tables (rebuilt from `memory_embeddings`).
- **Logs** and the sandbox Python toolkit (`data/sandbox/venv`, rebuilt with `npm run sandbox-python`).

### Protected storage

Only `config.json` is encrypted. **The database and the files are stored as they are** - memories, notes, conversations, uploads. Treat the archive like the live data directory: protected storage, restricted permissions, and a rotation so erased data does not linger (see [Privacy](#privacy)).

### The passphrase

`config.json` can hold the Discord token and provider keys, so it is only ever stored encrypted: AES-256-GCM under a key derived with scrypt from a passphrase you type when the backup is made (`packages/core/utils/passphraseCrypto.js`). Nothing about the passphrase is stored; the parameters travel in the envelope so they can be raised later without breaking older archives.

The passphrase comes from, in order: `--passphrase-file <path>` (first line), the `GOOBSTER_BACKUP_PASSPHRASE` environment variable (for unattended runs - keep it in the scheduler's secret store, not in a shell history), or a hidden terminal prompt. Cases:

| Situation | Backup | Restore |
|---|---|---|
| Passphrase given | `config.json.enc` is written. | `config.json` is decrypted into place; an existing one is moved to `config.json.pre-restore-<stamp>`. |
| No passphrase, `config.json` exists | **Refused** (exit 64) unless `--skip-config` - configuration is never stored in plaintext and never silently left out. | `config.json` is not restored; the report says so and tells you to recreate it from `config.example.json`. |
| Wrong passphrase | - | **Nothing is restored.** GCM authentication fails before a single byte of plaintext exists, so a wrong key can never produce a corrupt `config.json`. Run again with the right one. |
| `--skip-config` / `--without-config` | The archive has no configuration. | Configuration in the archive is left alone. |

## Restore

```bash
# stop the bot (and the api in the split deployment) first
npm run restore -- data/backups/goobster-backup-2026-09-23T01-41-15Z
```

The restore runs these steps in order and stops at the first that fails; the gates in the first step cost nothing and change nothing.

1. **Gates.** The archive must be for **the same database engine** (`ENGINE_MISMATCH`, see [Moving between engines](#moving-between-engines)) and **the same schema fingerprint** (`SCHEMA_MISMATCH`, unless `--accept-schema-change`); the passphrase, if given, must open the archive (`BAD_PASSPHRASE`). The fingerprint is a hash of `db/schema.sql` and `db/migrations.js`, so two checkouts running the same code agree on it. Accepting a change means: restore the older database and let the next open apply the column migrations and `schema.sql` forward - the normal upgrade path, just with a restored file.
2. **A target with data is protected.** If any application table already has rows the restore refuses (`TARGET_NOT_EMPTY`) unless `--force`. On SQLite, `--force` moves the current file (and its `-wal`/`-shm`) to `goobster.sqlite.pre-restore-<stamp>` first; on Postgres the tables in the schema are dropped and recreated by `pg_restore --single-transaction`.
3. **Database**, then **file sets** (copied over the installation's directories), then **`config.json`**.
4. **In-flight work is failed, never resumed.** Anything that was running when the backup was taken - Observatory jobs (`RUNNING` or `INTERRUPTED`), expeditions and their open cycle, mission steps, sandbox and integration requests, firing watches, started trigger deliveries, knowledge-reflection runs, and streaming web turns - is set to its failed state with one fixed reason, **`interrupted by restore`**, and gets one `work_failures` row (`code INTERRUPTED_BY_RESTORE`, the owner as `actor`). Process-bound leases and queues (`execution_admissions`, `web_live_turns`, `web_chat_queue`) are cleared. Nothing retries them: the Observatory's auto-resume takes only `INTERRUPTED` jobs and the expedition runner only `QUEUED` ones, and none of these are either any more.
5. **The instance is paused** (`instance_state.paused`, with the archive name and what was interrupted) and the restore is recorded (`instance_state.lastRestore`) - and audited (`operator_audit` rows `instance.restore` and, on resume, `instance.resume`; [work_ledger.md](work_ledger.md)).
6. **Verification.** Every table count in the manifest is compared with the restored database; mismatches are printed. Tables the restore itself writes or clears (`instance_state`, `work_failures`, `operator_audit`, leases, queues, `self_docs`) are exempt.

The report ends with the **secrets to re-enter**: `config.json` when it was not restored, and every environment secret the manifest says was set.

### The instance comes back paused

A restored installation starts with **scheduled work on hold**: `runtime/coreRuntime.js` starts only the event bus and history retention while `instance_state.paused` is set, and every process polls the flag (`PAUSE_POLL_MS`, 10 s) so the bot and the api agree without a restart. Sign-in, chat, the rooms, and everything interactive work normally; every room shows one strip saying the instance is paused, and operators get a link to the Host room.

**Nothing that came due while the box was down fires late.** Resuming (Host room → Instance → **Resume**, or `POST /api/app/admin/instance/resume`) first moves every missed schedule to its next future occurrence, then clears the flag:

| Missed while paused | On resume |
|---|---|
| Automations with `nextRun` in the past | `nextRun` moves to the next cron occurrence; the automation runs then, once. |
| Cron project triggers | Same. |
| Event project triggers whose source job settled during the downtime (including the jobs the restore itself failed) | A `SKIPPED` delivery row is written so the startup catch-up cannot replay them. |
| Recurring reminders | `dueAt` advances to the next occurrence after now. |
| One-shot reminders | **Cancelled**, and the owner is told through the Inbox (`kind: system`, "A reminder was missed while the instance was paused", with the note and its due time). Never silently. |

The Host room shows the pause (since when, from which archive, what was interrupted), the last restore, and the last resume with what it skipped. Resume is idempotent: calling it on a running instance skips nothing new.

### Restore and the maintenance barrier

The manager's restore runs inside the maintenance barrier ([maintenance_barrier.md](maintenance_barrier.md); [Through the manager](#through-the-manager)), and the paused-after-recovery policy above is separate from releasing that barrier: releasing maintenance does not resume a paused instance.

## Through the manager

The manager ([manager.md](manager.md)) exposes both as operation kinds, so the same plan, validate, apply and journal discipline as every other change applies, and the same code runs from four places:

| Surface | Backup | Restore |
|---|---|---|
| Operation kinds | `backup.create` | `backup.restore` |
| Manager page (wizard) | Installation → **Backup…** | Installation → **Restore…** |
| Host room | Maintenance page → **Backup…** (and the Overview card) | Maintenance page → **Restore…** |
| CLI | `goobster-manager backup --out <dir>` | `goobster-manager restore <dir> --confirm <installationId>` |
| Read routes | `GET /manager/api/backup/status`, `GET /manager/api/backup/inspect?dir=<absolute path>`, `GET /manager/api/maintenance` | the same |

The Host room reaches them through its own proxies (`POST /api/app/admin/host/operations` with the kinds `backup.create`, `backup.restore` and `data.reset`; `GET /api/app/admin/host/backup/status`, `/backup/inspect?dir=`, `/maintenance`, `/reset/plan`, `/migrate/status`), which add the bridge assertion and one `operator_audit` row per successful mutation (`host.backup.apply`, `host.reset.apply`). The browser never holds a manager credential there.

Input, exactly:

```text
backup.create   { dir, includeConfig?, passphrase?, expectedRevision? }
backup.restore  { dir, confirm, withoutConfig?, passphrase?, acceptSchemaChange?,
                  safetyDir?, maintenance?: { operationId, fence }, release?, expectedRevision? }
```

`dir` for a backup is the **parent**: the archive is written to a dated folder inside it (`goobster-backup-<UTC stamp>/`), which the result names. `dir` for a restore is that archive folder.

### What is encrypted

**Only `config.json` is encrypted, with the passphrase you give. The archive is not.** The database and the file sets are stored as they are, so the archive needs the same protection as the live data directory. "Config encrypted" is not "archive encrypted", and every surface says so: the backup plan (`config.encrypted: true`, `archiveEncrypted: false`, and a note), the wizard (before you type the passphrase and on the review page), the inspection of an archive and the CLI output.

### Passphrase and secrets

| Rule | Where it holds |
|---|---|
| A backup that includes `config.json` needs a passphrase; leaving it out is explicit (`includeConfig: false`, `--include-config` absent). It is never silently dropped. | `PASSPHRASE_REQUIRED` at plan time. |
| A wrong passphrase changes nothing. The archive is opened in memory during the restore's preflight, before the barrier is entered. | `BAD_PASSPHRASE` at plan time. |
| `withoutConfig` is explicit; with it the passphrase is not asked for and the current `config.json` is left as it is. | The plan says `config.restore: false` and lists `config.json` among the secrets to re-enter. |
| The passphrase is held in memory (`privateInput`) between plan and apply, so a manager restart between them is `PLAN_INPUT_LOST` and the operation is planned again. It is never written to the journal, the audit row, the operation record, the plan, the result, a log line or argv. | Tested: `tests/backupOperations.test.js`. |
| The wizard keeps it in React state only: not in `sessionStorage`, not in the URL, cleared when the plan is made and on leaving the page. The Host room keeps it the same way. | `e2e/maintenance.spec.js` checks storage and the manager store. |
| The CLI never takes it from a flag (`--passphrase`, or any secret-named flag, is refused as `SECRET_ON_ARGV` before anything is read). It comes from `--passphrase-file <file>` (a regular file only its owner can read; first line), `GOOBSTER_BACKUP_PASSPHRASE_FILE`, the answers file, or a hidden prompt. The CLI does **not** read `GOOBSTER_BACKUP_PASSPHRASE` (an environment variable is visible to every process of the user); the developer script still does. | `tests/maintenanceCli.test.js`. |

### The CLI

```bash
node apps/manager/cli.js backup --out <dir> [--include-config] [--passphrase-file <file>] [--json]
node apps/manager/cli.js backup inspect <dir> [--json]
node apps/manager/cli.js restore <dir> --confirm <installationId> [--without-config | --passphrase-file <file>] [--accept-schema-change] [--release] [--json]
```

`backup` only reads the application and works while it runs. `restore` enters the maintenance barrier itself, replaces the data and leaves the instance paused; with `--release` it also lifts the barrier. Exit codes: 0 done, 2 invalid input or a block, 3 refused (a held barrier, a foreign target, a wrong passphrase, a stale archive), 4 interrupted (run the same command again to carry on), 5 applied but a step needs the privileged helper, 1 unexpected. The progress goes to stderr, redacted; the result to stdout (or one JSON document with `--json`).

### Inspecting an archive

`GET /manager/api/backup/inspect?dir=` (and `backup inspect`, and the **Inspect this backup** button) reads the archive and answers without changing anything: when and by which version it was made, the engine and whether it matches this installation, the schema verdict (`schemaChangeNeedsAcceptance`), table and row counts, the file sets with file counts, whether `config.json` is included and encrypted, whether the archive itself is encrypted (never), the names of the environment secrets to re-enter, whether it was taken `quiesced`, and the integrity check. `restorable` is false, with the reasons in `blocks`, for: `ENGINE_MISMATCH`, `ARCHIVE_INCOMPLETE`, `ARCHIVE_INSIDE_DATA` (an archive stored inside the manager store or a copied data folder would be moved aside with them) and `NOT_INSTALLED`. `warnings` carries `SCHEMA_CHANGED` and `TAKEN_WHILE_RUNNING`. It echoes only the path it was given and never a passphrase, a value out of `config.json` or a row.

### What a backup does

Steps: `preflight`, `archive`, `verify`. The archive and the checks run in a helper process (`apps/manager/backup/childEntry.js`), because the manager itself never opens the application database. A backup takes no barrier. When a maintenance barrier is already held with every writer fenced, the archive is **compared with the live row counts** and its manifest says `quiesced: true`; otherwise it is checked for completeness and structure only (the database and the files are copied at slightly different instants while the application runs). A backup that cannot be verified is reported as `BACKUP_UNVERIFIED` and left where it was written; do not rely on it.

Result: the archive folder, the creation time, the engine, whether it was verified and against what (`live-counts` or `archive-structure`), table, row and file counts, the file sets, whether `config.json` is in and encrypted, `archiveEncrypted: false`, and **`omittedSecrets`**: the names (with a short description) of the environment secrets that were set and are deliberately not in the archive.

### What a restore does

Steps: `preflight`, `maintenance`, `backup`, `mutate`, `verify`, `cutover`, `release`.

1. **preflight.** The archive is whole, made by this engine, at this schema (or `acceptSchemaChange`), the target is this installation's (`FOREIGN_TARGET` otherwise), the passphrase opens `config.json` in memory, and the typed `confirm` equals this installation's id (`CONFIRMATION_REQUIRED`). Nothing has changed.
2. **maintenance.** The manager enters the barrier (or uses one you pass as `maintenance: { operationId, fence }`) and every writer acknowledges it. The portal refuses every change with a 503 while the barrier holds, and the cutover restarts it onto the restored data, so **the browser loses its connection**: continue on the manager page (`http://127.0.0.1:<manager port>/manager/`), which keeps answering.
3. **backup.** A target that holds data gets a safety backup of what is there now into `safetyDir` (default `<data dir>/backups`), verified against the live counts. If it cannot be verified, nothing is replaced and the barrier is given back.
4. **mutate** (irreversible from here). Sub-steps, each recorded durably in `restore.json` in the manager store: the database, then each file set, then `config.json`. What is replaced is moved aside, never deleted. A failure leaves the operation failed, the barrier held, the set-aside material in place and the failing sub-step named; **nothing is rolled back automatically**. Planning the same restore again carries on from the first sub-step that is not done.
5. **verify.** The restored database is opened, in-flight work is marked "interrupted by restore" and never retried, the instance is paused, and the row counts are compared with the archive.
6. **cutover.** The workers the manager supervises are restarted onto the restored data (a SQLite restore replaces the file, so a running process would otherwise keep the old one open). The barrier stays up unless `release` was asked for.

The result: whether the database, each file set and `config.json` were restored (and why `config.json` was skipped), the safety backup, how many in-flight items were interrupted and of what kind, whether the row counts match the archive, that the instance is **paused**, whether maintenance is still held (with its operation id and fence), whether the workers were restarted, the **retained** locations, and the **secrets to re-enter**.

A restore of one archive while an earlier restore of **another** archive stopped part way and still holds its barrier is refused (`RESTORE_IN_PROGRESS`); finish the first, or release the barrier deliberately.

### Where set-aside and retained data lives

| What | Where | Removed by |
|---|---|---|
| The database that was replaced | next to it, `goobster.sqlite.pre-restore-<stamp>` (with its `-wal`/`-shm`); Postgres has none, its tables are dropped in one `pg_restore --single-transaction` and the safety backup is the way back | you |
| A file set that was replaced | next to it, `<directory>.pre-restore-<stamp>` | you |
| `config.json` that was replaced | `config.json.pre-restore-<stamp>` | you |
| The safety backup of the target | `safetyDir` (default `<data dir>/backups/goobster-backup-<stamp>`), a normal archive | you |
| The restore's own record | `restore.json` in the manager store: sub-step progress, set-aside paths, the failing step; no passphrase, no row | the next restore of another archive replaces it |

`GET /manager/api/backup/status`, the wizard and the Host room list these as **retained**. They are copies of data you chose to replace: they carry the privacy obligations of any backup ([Privacy](#privacy)), so delete them once you are sure.

### Coming back safely

Three states are separate, and none implies another:

1. **Maintenance is held.** The application is fenced. Release it with the wizard's **Release maintenance** button, `restore --release`, `node apps/manager/cli.js release` (or `release --force --acknowledge-mutation` for a barrier a dead manager left), or the `maintenance.release` kind. After a restore the barrier's `mutateBegun` is set, so releasing needs the explicit acknowledgement that releasing does not undo the replacement. A stale barrier is never resumed automatically.
2. **The instance is paused.** Scheduled work is on hold ([The instance comes back paused](#the-instance-comes-back-paused)). Releasing maintenance does **not** resume it.
3. **Resume.** Host room → Instance → **Resume** (`POST /api/app/admin/instance/resume`), after you have checked the data. There is deliberately no "resume everything" control.

Environment secrets from the result's `secretsToReenter` are entered again in the environment (the manager's environment overlay or your service definition), and `config.json` is recreated from `config.example.json` when it was not restored.

### Limits

- **A Postgres restore is not atomic across the database and the files.** The database goes in one transaction, but the file sets and `config.json` follow it as separate steps; a failure between them leaves a restored database with some old files. That is what the sub-step record, the set-aside material and "run the same restore again" are for; the safety backup is the rollback material.
- With the Host room's restore, the portal is in the barrier it asked for: the apply request is in flight while the portal drains, so the page may not see the final response. The manager page, `backup/status` and the CLI show where it ended.
- An external worker the manager does not supervise (a bot started by hand) must be restarted by you so it reopens the restored database; the CLI cannot reach the supervisor and says so.

### Reset takes a verified backup first

`data.reset` ([data_reset.md](data_reset.md)) never empties anything before it
has written an archive with this same service and checked it with
`backupService.verifyBackup(dir, { expectCounts, expectFingerprint })`: the
snapshot is not empty, the schema fingerprint matches, every table's row count
matches what was read, and each file set holds the files that were counted. A
failed check throws `BackupError('UNVERIFIED')` with the list of problems, and
the reset does not start. The archive keeps what the reset removes, so the
privacy note below applies to it.

### Moving between engines

An archive restores only onto the engine that made it. To move SQLite data to Postgres: restore onto a SQLite installation, then migrate it with the manager (`migrate preflight`, `migrate run`; [db_migration.md](db_migration.md)), which takes and verifies its own backup first. `npm run migrate-to-postgres` remains as a developer script with reduced guarantees. There is no Postgres → SQLite path.

## The recovery test

Run this before the invited pilot ([#265](https://github.com/nervous-rob/goobster/issues/265)) and after any change to the database layer, on **each engine the deployment uses**. It takes a few minutes and a scratch directory.

1. On the running installation, `npm run backup -- --out /tmp/recovery` with a passphrase. Note the archive path.
2. Prepare an empty target: a second checkout at the same commit with `GOOBSTER_DATA_DIR`, `GOOBSTER_CONFIG_PATH` and either `GOOBSTER_DB_PATH` (SQLite) or `GOOBSTER_DB_URL` (an empty Postgres database with `vector` and `citext`) pointing at scratch locations.
3. `npm run restore -- /tmp/recovery/goobster-backup-…` with the same passphrase. Confirm: no count mismatches in the report; `config.json` restored; the secrets list matches what the source has in its environment.
4. Set the listed environment secrets, start the target, sign in with a session that existed before the backup (or a fresh one), open the Host room: the instance is **paused**, the Instance panel names the archive. Open Chat and send one message. Open Activity → Scheduled and confirm the reminders you expect.
5. **Resume.** Confirm the toast lists what was skipped, that no missed automation or reminder fires afterwards, and that a one-shot reminder that was due during the downtime shows up as an Inbox notice, not as a late delivery.
6. Record the date, the archive name, the engine, and the outcome in the deployment log. A pilot does not open without a dated entry.

`tests/backupRestore.test.js` automates the same journey against a throwaway database on both engines in CI (backup, gates, restore into a fresh target, counts, failed work, `work_failures`, paused runtime picking its workers up on resume, skipped schedules, Host room routes, both CLIs). It is not a substitute for step 6 on the real host.

## Privacy

- **A backup is a copy of the data it was taken from.** Rows erased later with `/forget-me` still exist in archives made before the erasure. The CLI does not expire or rotate archives automatically: the host must choose, enforce and disclose the retention window. Without rotation, erased data can remain in an archive indefinitely. Keep archives on protected storage; an example policy is daily for 14 days, then weekly for 8 weeks, not a built-in default. Nothing in the archive is encrypted except `config.json`.
- `work_failures` rows carry a kind, a phase, a machine code, a short reason (clipped to 300 characters) and the actor - **never** a prompt, a reply, a message body or a stack trace. Erasure (`privacyService.forgetUser`) nulls the actor and keeps the row, the same treatment `usage_log` gets; the audit counts them and the transparency report lists a person's own failures. `workFailureService.prune()` drops rows older than 30 days.
- `instance_state` holds installation-wide flags only (pause, last restore, last resume) - no per-user data.

## Reference

| Piece | Where |
|---|---|
| Archive, inspect, restore, interrupt in-flight work | `packages/core/services/backupService.js` |
| Pause flag, resume, skipped schedules | `packages/core/services/instanceStateService.js` (`instance_state` table) |
| Failure ledger and operator audit ([work_ledger.md](work_ledger.md), #256) | `packages/core/services/workFailureService.js` (`work_failures`), `packages/core/services/operatorAuditService.js` (`operator_audit`) |
| Passphrase encryption | `packages/core/utils/passphraseCrypto.js` |
| Storage description and table listing across engines | `db.describeStorage()`, `db.listTables()` in `packages/core/db/index.js` |
| Runtime gate | `packages/core/runtime/coreRuntime.js` (`pausedAtStart`, `PAUSE_POLL_MS`) |
| Operator API | `GET /api/app/admin/instance`, `POST /api/app/admin/instance/resume`; `/me` carries `instance.paused` |
| Host room | `apps/web/src/rooms/HostRoom.tsx` (Instance panel); the paused strip in `apps/web/src/shell/AppShell.tsx` |
| CLI (developer scripts) | `scripts/backup.js`, `scripts/restore.js`, `scripts/lib/passphrase.js` |
| Manager kinds and routes | `apps/manager/engine/kinds/backup.js`, `apps/manager/routes/backup.js`, `apps/manager/backup/` (paths, restore state, helper process), `apps/manager/cliBackup.js` |
| Archive format, the file-set audit | `packages/core/services/backupArchive.js` (`FILE_SETS`, `DATA_CLASSIFICATION`), `packages/core/services/backupService.js` |
| Wizard journeys and the Host Maintenance page | `apps/web/src/setup/journeys/{Backup,Restore,Reset,Migration}.tsx`, `apps/web/src/rooms/host/MaintenancePage.tsx` |
| Tests | `tests/backupRestore.test.js`, `tests/backupOperations.test.js`, `tests/maintenanceRoutes.test.js`, `tests/maintenanceCli.test.js` (both engines), `e2e/maintenance.spec.js` (Playwright) |

Error codes a restore can stop with: `NOT_AN_ARCHIVE`, `BAD_MANIFEST`, `BAD_FORMAT`, `ENGINE_MISMATCH`, `SCHEMA_MISMATCH`, `BAD_PASSPHRASE`, `TARGET_NOT_EMPTY`, `TOOL_MISSING` (no `pg_dump`/`pg_restore` on PATH or under `GOOBSTER_PG_BIN`), `TOOL_VERSION_MISMATCH` (client tools older than the server), `TOOL_FAILED`. A backup can stop with `PASSPHRASE_REQUIRED`, `EXISTS`, or the same three tool codes.

The manager's kinds add: `BACKUP_DESTINATION_UNSAFE`, `BACKUP_UNVERIFIED`, `BACKUP_FAILED`, `ARCHIVE_INSIDE_DATA`, `ARCHIVE_INCOMPLETE`, `ARCHIVE_CHANGED` (the archive changed between plan and apply), `FOREIGN_TARGET`, `CONFIRMATION_REQUIRED`, `RESTORE_IN_PROGRESS`, `MAINTENANCE_NOT_HELD`, `STALE_MAINTENANCE`, `WRITER_UNACKNOWLEDGED`, `PHASE_NOT_ALLOWED`, `PLAN_INPUT_LOST`, `REVISION_CONFLICT`. The CLI adds `SECRET_ON_ARGV` and `USAGE`.


PostgreSQL backup tools receive connection passwords through their child
`PGPASSWORD` environment, with passwords removed from URI authority and query
arguments. This keeps credentials out of ordinary process argument listings and
command strings in execution errors. The application's environment is unchanged.
