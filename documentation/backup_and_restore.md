---
title: Backup and tested restore
kind: guide
summary: What npm run backup archives, how npm run restore brings an installation back paused, what a restore refuses, and the recovery test that must pass on both engines before a pilot.
tags: [operations, backup, restore, deployment, privacy]
---

# Backup and tested restore

Roadmap [#249](https://github.com/nervous-rob/goobster/issues/249). A backup that has never been restored is a hope, not a backup: this runbook defines the archive, the restore, what the restore refuses, what it does to work that was in flight, and the recovery test an operator runs before inviting anyone.

Two commands, both run from the repository root of the installation:

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
| `config.json.enc` | `config.json`, encrypted. Present only when a passphrase was given. |

File sets are resolved against the data directory of the installation doing the backup or the restore, never against a path recorded by the other side, so an archive moves between machines and layouts.

Not in the archive, on purpose:

- **Environment secrets.** `GOOBSTER_DB_URL`, `GOOBSTER_INTERNAL_TOKEN`, `DISCORD_CLIENT_SECRET`, the provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `ELEVENLABS_API_KEY`), `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `CURSOR_API_KEY`, `CURSOR_WEBHOOK_SECRET`, `SPOTIFY_CLIENT_SECRET`. The manifest records which of these were set (`envSecrets.present`) so a restore can list what to re-enter; their values are never written anywhere.
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

### Moving between engines

An archive restores only onto the engine that made it. To move SQLite data to Postgres: restore onto a SQLite installation, then run `npm run migrate-to-postgres` ([postgres_setup.md](postgres_setup.md)). There is no Postgres → SQLite path.

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
| CLI | `scripts/backup.js`, `scripts/restore.js`, `scripts/lib/passphrase.js` |
| Tests | `tests/backupRestore.test.js` (CI group `core`, both engines) |

Error codes a restore can stop with: `NOT_AN_ARCHIVE`, `BAD_MANIFEST`, `BAD_FORMAT`, `ENGINE_MISMATCH`, `SCHEMA_MISMATCH`, `BAD_PASSPHRASE`, `TARGET_NOT_EMPTY`, `TOOL_MISSING` (no `pg_dump`/`pg_restore` on PATH or under `GOOBSTER_PG_BIN`), `TOOL_VERSION_MISMATCH` (client tools older than the server), `TOOL_FAILED`. A backup can stop with `PASSPHRASE_REQUIRED`, `EXISTS`, or the same three tool codes.
