---
title: Release acceptance matrix (P5.3)
kind: reference
summary: How the installer is accepted end to end - the matrix of platform, install mode, database and feature set; the thirteen lifecycle steps and nine failure injections each cell runs through the manager's own command line and loopback API, with what counts as a pass; the generated results table and its regenerating command; dated results of the runs actually done; the cells no hosted runner can give, and the findings acceptance made.
tags: [installer, acceptance, release, matrix, ci, recovery, failure-injection, arm64, raspberry-pi]
---

# Release acceptance matrix (P5.3)

This is the matrix half of installer plan item P5.3 (issue #343, epic #315):
run the whole lifecycle of a release, as an operator would, on every platform
a hosted runner can give, and record what happened. The operator recovery
runbooks are the other half and live in their own documents (see
`documentation/getting_started.md`, `documentation/host_operations.md`,
`documentation/data_reset.md`, `documentation/db_migration.md`,
`documentation/backup_and_restore.md` and `documentation/manager_update.md`).

Only a cell with evidence counts. A step the driver cannot run on a cell is
`n/a` with its reason; a cell no hosted runner can give is `deferred` with its
reason; a cell the workflow has not produced evidence for yet is `missing`.
Nothing here is a pass because it was expected to pass.

## How a cell runs

`scripts/acceptance/run.js` runs one cell on the host it is started on:

```bash
node scripts/package-runtime.js --target linux-x64 --out <payload dir> --report-dir <reports> --force --dev-sign --profile minimal
node scripts/acceptance/run.js --payload <payload dir> --install new|adopt --db sqlite|existing-pg|managed-pg \
    --features minimal|representative|full --out <evidence dir> [--work <scratch dir>] [--port-base 3701] [--keep]
```

`--features` selects what the payload carries (`minimal` is the
`--profile minimal` payload; `representative` is built with
`--features tavern,economy,exchange`; `full` is the full profile). The
existing-server database cell reads its server from
`GOOBSTER_ACCEPTANCE_PG_URL`; the managed-Postgres cell asks the manager to
provision a Docker container, so it needs Docker.

The driver is an operator, not a test harness inside the product. It uses
three doors and nothing else:

- the manager command line (`goobster-manager install | adopt | repair |
  backup | restore | update | migrate | reset | release | uninstall | status |
  database`), run as a child process, with its exit code and one-line result
  recorded;
- the manager process itself (started, killed by its process id and started
  again, the way an OS supervisor would), and the application's own worker
  processes through the manager;
- the manager's documented loopback API (`/manager/api`, a recovery session
  with a bearer token and a single-use nonce) and the portal's own HTTP API.

It never requires a module of the manager or of the application. Every
step's evidence entry carries each command, its exit code, its duration and a
one-line result; the file is validated and scanned for secrets, tokens, user
content and home directories before it is rendered or uploaded (a file that
fails is rejected, not published).

The first chat turn runs in standalone mode (no Discord) against a small fake
Ollama the driver serves on a loopback port, so a cell needs no provider key
and no network. The "update" step builds a second, signed fake release locally
(the same payload with a higher version, re-signed with the throwaway
development key the payload was built with), so a cell exercises the real
check, stage, apply and handoff path without a published release.

## Steps and what a pass means

Each step ends `pass`, `fail`, `n/a` (with its reason) or `deferred` (with its
reason). The order is install, owner, chat, features, defaults and keys, boot
recovery, update, repair, backup and restore, migrate, reset, uninstall keeping
data, full removal, with the injections interleaved where their state is
right. A step whose prerequisite (install, owner) failed is recorded `n/a` with
the reason `not run: the <step> step failed`; the failed step itself is a
`fail`, so the cell still fails and `report.js --strict` exits 1.

| Column | Step | Pass means |
|---|---|---|
| `install` | Install | `install` of the verified payload exits 0; `status` reports the release and its version; the declared workers are healthy. For `adopt` the driver then removes the manager's store (the installation is left exactly as a host the manager has never seen would have it), and the manager adopts it: `status` reports origin `adopt`, the same release and healthy workers, with the data untouched. A script-installed Raspberry Pi is the real case this stands in for (deferred below). |
| `owner` | First owner | The first operator is created through a recovery session; a second `owner.create` is refused (`ACCOUNT_EXISTS`). |
| `chat` | First chat turn | The owner signs in to the portal, sends one message, and the answer from the fake provider comes back; the conversation is kept. |
| `features` | Feature remove and add, with restart | The feature's route is gated when it is off (turned off first if the payload ships it on); adding it records it as pending until the restart, and after the restart its route reaches its handler; removing it and restarting makes the route answer the gated response (`FEATURE_UNAVAILABLE`) again; no conversation is lost across the two restarts. `n/a` on the minimal payload, which carries no optional feature package. |
| `keys` | Defaults and keys survive a restart | A provider key written through the config API is masked on read and stored in a mode 0600 file; an instance default survives a worker restart. |
| `crash` | Boot recovery | The manager is killed by its process id and started again (the OS supervisor's job). It claims the installation again, the workers are healthy, and the owner can still sign in with the conversation intact. |
| `update` | Staged update | With the update policy pointing at a local, signed 1.1.0: `update check`, `update stage`, `update apply --now`. The manager hands over (exit 76), the new manager verifies the new release, the workers are healthy, the downtime is measured (quiesce to release), and data, key, default and conversation are intact. |
| `repair` | Repair with a corrupted database | After a backup, the release file is damaged and the SQLite database header overwritten. `repair` refuses (`DB_INIT_FAILED`, exit 4) and leaves both exactly as they were; `restore` of the earlier backup brings the data back (row counts match the archive); `repair` then puts the release file back. It runs before the migration, so every cell does it on SQLite. |
| `restore` | Backup and restore | `backup --include-config` writes an archive that `backup inspect` can read; a later conversation, a removed key and a changed default are all undone by `restore`; a safety backup of the replaced state is written first; `config.json` comes back under the passphrase. |
| `migrate` | SQLite to Postgres migration | `migrate run` copies, verifies and switches; after a manager restart the engine is Postgres, every conversation reads back, a new one can be written, and the SQLite file is untouched. `n/a` on SQLite cells. |
| `reset` | Reset | A `--dry-run` changes nothing; `reset --scope instance` takes a verified backup first, empties the data (the owner can no longer sign in), leaves the manager store and `config.json`, and releases the maintenance barrier. |
| `keep` | Uninstall, keeping data | `uninstall` removes the release; database and `config.json` are left byte-size identical; `status` reports the tombstoned recovery; a reinstall over the kept data comes back healthy. For an adopted installation the release belongs to the adopted layout, not to the manager, so it is expected to stay. |
| `remove` | Confirmed full removal | `uninstall --delete-data` is refused without `--confirm` and with a wrong installation id (data intact); with the right id the database file, `config.json` and release are removed, leaving only the manager store and the tombstone. On a Postgres cell the server's database is the operator's and is not dropped. |

## Failure injections and negative authorization

Run in the same cell, each against the installation as the steps left it, and
each ending with the installation healthy or in the documented state.

| Column | Injection | Pass means |
|---|---|---|
| `token` | Stale setup token | A replaced credential, an expired one and a reused one are all refused (`BOOTSTRAP_INVALID`); a fresh one is claimed exactly once. |
| `store` | Lost or corrupted manager store | With the store directory gone the manager reports `MANAGER_STORE_MISSING` and `adopt` takes the installation back (the one that is also the adopt cells' install); with `installation.json` corrupted it reports `MANAGER_STORE_CORRUPT`, grants no session, performs no mutation and stays up. |
| `port` | Port in use | `install` with the API port held by another listener exits 2 with `PORT_IN_USE`; nothing is written beyond the refused operation's own journal entry. |
| `storage` | Full or read-only storage root | A read-only code root exits 2 `ROOT_NOT_WRITABLE`; a read-only data root exits 3 `STORE_UNUSABLE`; nothing is written either way. A full disk (`DISK_SPACE`) needs a size-limited mount the hosted runners do not give without root-level loop devices; it is **not exercised** (see the caveats). |
| `update-kill` | Update interrupted between activate and verify | The manager is killed by its process id with the handoff recorded as pending. The next start verifies and finishes the update, releases the barrier, the workers are healthy and the data is intact. |
| `restore-kill` | Restore interrupted | The restore is killed once its journal reaches `mutate`. The live database is still the pre-restore file; the first retry is refused (`STALE_MAINTENANCE`, exit 3); `release --force --acknowledge-mutation` clears the barrier; the same restore re-run with `--release` completes and the data matches the archive. |
| `gated` | Direct HTTP to a disabled feature's route | Signed out: a plain 404. Signed in: 404 `FEATURE_UNAVAILABLE` naming the feature. A write: 404. Nothing reaches the feature. |
| `no-session` | A manager mutation without a session | No session 401 `UNAUTHENTICATED`; a made-up token 401 `SESSION_INVALID`; a config read 401; a missing nonce 400 `NONCE_REQUIRED`; a foreign origin 403 `BAD_ORIGIN`. Nothing changed. |
| `proxy` | Recovery refused through a proxy | A request carrying a forwarding header gets 403 `LOCAL_ONLY`; a non-loopback host name gets 421 `BAD_HOST`; the same credential then works directly. |

## The matrix

Intended cells (`.github/workflows/release-acceptance.yml`, one job per cell):

- `ubuntu-24.04` and `ubuntu-24.04-arm` (linux-x64, linux-arm64): `new` and
  `adopt`, each on SQLite and managed Postgres (Docker), each with the
  minimal and the representative payload: 8 cells per architecture.
- `macos-15` (darwin-arm64), `macos-15-intel` (darwin-x64) and `windows-2022`
  (win32-x64): `new`, SQLite, minimal.

The table below is generated from the evidence files; the row values are
`pass`, `fail`, `n/a`, `deferred` and `missing`. Regenerate it after a
workflow run by downloading the `acceptance-*` artifacts into one directory
and running:

```bash
node scripts/acceptance/report.js <dir with the evidence directories> --matrix --doc documentation/release_acceptance.md
```

A cell that fails also keeps the processes' own output beside its evidence
(`logs-<cell id>/manager.log`, `scratch-<name>.log`: the manager's and the
scratch managers' stdout and stderr, what `--keep` would leave on the host),
every line through the cell's redactor and any log that still shows something
secret-like replaced by a note. The report reads only `evidence-*.json`.

<!-- acceptance-matrix:begin -->

| platform | install | database | features | install | owner | chat | features | keys | crash | update | repair | restore | migrate | reset | keep | remove | token | store | port | storage | update-kill | restore-kill | gated | no-session | proxy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| linux-x64 | new | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | new | sqlite | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | new | existing-pg | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | new | managed-pg | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | new | managed-pg | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | adopt | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | adopt | sqlite | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | adopt | managed-pg | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-x64 | adopt | managed-pg | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | new | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | new | sqlite | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | new | managed-pg | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | new | managed-pg | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | adopt | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | adopt | sqlite | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | adopt | managed-pg | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| linux-arm64 | adopt | managed-pg | representative | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| darwin-arm64 | new | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| darwin-x64 | new | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass |
| win32-x64 | new | sqlite | minimal | pass | pass | pass | n/a | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass | pass | n/a | pass | pass | pass | pass | pass |
| linux-x64 | major upgrade | sqlite | minimal | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred |
| linux-x64 | new | sqlite | full | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred |
| linux-x64 | new | existing-pg | representative | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred |
| linux-arm64 (Raspberry Pi 4B) | adopt | sqlite | representative | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred |
| darwin-arm64 | new | managed-pg | minimal | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred |
| win32-x64 | new | managed-pg | minimal | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred | deferred |

Columns: `install` = install; `owner` = first owner; `chat` = first chat turn; `features` = feature remove and add, with restart; `keys` = defaults and keys survive a restart; `crash` = boot recovery; `update` = staged update; `repair` = repair with a corrupted database; `restore` = backup and restore; `migrate` = SQLite to Postgres migration; `reset` = reset; `keep` = uninstall, keeping data; `remove` = confirmed full removal. Injections: `token` = stale setup token; `store` = lost manager store; `port` = port already in use; `storage` = read-only or full storage root; `update-kill` = update interrupted at the handoff; `restore-kill` = restore interrupted; `gated` = direct request to a disabled feature; `no-session` = manager mutation without a session; `proxy` = recovery refused through a proxy.

| cell | artifact | commit | runner image | date | steps pass/fail/n.a. | injections pass/fail/n.a. |
| --- | --- | --- | --- | --- | --- | --- |
| linux-x64/new/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 11/0/2 | 9/0/0 |
| linux-x64/new/sqlite/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-x64/new/existing-pg/minimal | 1.0.0 (minimal: core) | 8c84eaf3a4bc | local Linux 6.12.94+ | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-x64/new/managed-pg/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-x64/new/managed-pg/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 13/0/0 | 9/0/0 |
| linux-x64/adopt/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 11/0/2 | 9/0/0 |
| linux-x64/adopt/sqlite/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-x64/adopt/managed-pg/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-x64/adopt/managed-pg/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04 | 2026-10-08 | 13/0/0 | 9/0/0 |
| linux-arm64/new/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 11/0/2 | 9/0/0 |
| linux-arm64/new/sqlite/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-arm64/new/managed-pg/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-arm64/new/managed-pg/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 13/0/0 | 9/0/0 |
| linux-arm64/adopt/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 11/0/2 | 9/0/0 |
| linux-arm64/adopt/sqlite/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-arm64/adopt/managed-pg/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 12/0/1 | 9/0/0 |
| linux-arm64/adopt/managed-pg/representative | 1.0.0 (custom: core, economy, exchange, tavern) | db2da4a9f6f7 | ubuntu-24.04-arm | 2026-10-08 | 13/0/0 | 9/0/0 |
| darwin-arm64/new/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | macos-15 | 2026-10-08 | 11/0/2 | 9/0/0 |
| darwin-x64/new/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | macos-15-intel | 2026-10-08 | 11/0/2 | 9/0/0 |
| win32-x64/new/sqlite/minimal | 1.0.0 (minimal: core) | db2da4a9f6f7 | windows-2022 | 2026-10-08 | 11/0/2 | 8/0/1 |

Deferred cells:

- linux-arm64 (Raspberry Pi 4B), adopt, sqlite, representative: Pi hardware: no hosted runner is a Raspberry Pi. linux-arm64 itself is proven on the hosted arm runner; the Pi's memory, SD-card I/O and thermal limits are not.
- linux-x64, new, existing-pg, representative: A hosted Postgres service container has a superuser the application is never given; the existing-server path (a role without superuser, extensions pre-created by an administrator) needs a server that matches a real deployment. The driver runs this cell against any server named by GOOBSTER_ACCEPTANCE_PG_URL; it was run locally once (see the results).
- linux-x64, new, sqlite, full: The full profile with real provider keys: the keys are secrets this workflow never receives, and a full payload without them proves nothing the representative payload does not.
- darwin-arm64, new, managed-pg, minimal: Desktop PostgreSQL (Docker Desktop on macOS): hosted macOS runners have no container runtime.
- win32-x64, new, managed-pg, minimal: Desktop PostgreSQL (Docker Desktop on Windows): hosted Windows runners cannot run Linux containers.
- linux-x64, major upgrade, sqlite, minimal: Major upgrades (a release that changes the database schema, and the recovery decision that follows a failed one): the fake release in this driver changes only a version.

<!-- acceptance-matrix:end -->

## Results of the runs done so far

### Hosted run, 2026-10-08

The generated table above is from the `release-acceptance.yml` run on the
commit recorded in its `commit` column (the pull request merge commit of
driver `0c8ddef`, PR #377): **all nineteen hosted cells passed every step and
injection they can run** — linux-x64 and linux-arm64 (`ubuntu-24.04`,
`ubuntu-24.04-arm`) in `new` and `adopt` mode on SQLite and Docker-managed
Postgres with the minimal and representative payloads, macOS on arm64
(`macos-15`) and x64 (`macos-15-intel`), and Windows (`windows-2022`). The
`n/a` entries are the ones the step definitions call for: `features` on a
minimal payload, `migrate` on a cell that stays on SQLite, and the
storage-refusal injection on Windows (no POSIX directory modes). It took seven
runs to get there; findings 8 to 20 below are what the first six found, each
fixed with a regression test before the next run. From the evidence files:

- The staged update ran end to end (check, stage, apply, exit-76 handoff,
  the new manager's verification) in 40 to 59 seconds on the Linux and
  macOS arm64 runners, 55 seconds on Windows and 138 seconds on the Intel
  macOS runner; the downtime the manager measured, from quiesce to release,
  was 6.3 to 7.7 seconds everywhere but Windows (9.3 s) and Intel macOS
  (12.1 s). The interrupted update finished the same way on every cell.
- Boot recovery was back with healthy workers and the owner's conversation
  intact in 5 to 8 seconds.
- The SQLite to Postgres migration into the Docker-managed server took 18 to
  31 seconds for a database of one conversation, including provisioning.
- The managed-Postgres cells ran `migrate`, `reset` with the database URL, and
  the full lifecycle against the pinned `pgvector/pgvector:pg17` image with
  PostgreSQL 17 client tools (finding 11).

The local existing-Postgres row in the table is from the local run below (the
hosted matrix has no existing-server cell: see the deferred list).

### Local runs, 2026-10-08

Runs on the local development VM (Ubuntu 24.04 container, Linux 6.12, x64,
the driver on Node 22.14, the payload carrying its bundled Node 22.23.3), on
**2026-10-08**, against payloads built by `scripts/package-runtime.js --target
linux-x64 --dev-sign`. The artifact is version **1.0.0**, signed with a
throwaway development key (`UNSIGNED DEVELOPMENT BUILD`: the production key is
not in the repository), and the update step moves it to 1.1.0 and, in the
interruption, 1.2.0, both built locally by the driver. The `commit` column of
the table is the commit of the driver that ran. Evidence files are uploaded by
the workflow for hosted runs; the local files live outside the repository.

| Cell | Result | Notes |
|---|---|---|
| linux-x64, new, SQLite, minimal | 11 pass, 2 n/a; 9 of 9 injections pass | `features` n/a (the minimal payload has no optional feature package); `migrate` n/a (stays on SQLite). Update downtime 6.8 s. |
| linux-x64, new, SQLite, representative (core, economy, exchange, tavern) | 12 pass, 1 n/a; 9 of 9 injections pass | `migrate` n/a. `exchange` shipped on; turned off, added back (pending until the restart, then reaching its handler), removed (gated again). Update downtime 6.7 s. |
| linux-x64, new, existing Postgres server, minimal | 12 pass, 1 n/a; 9 of 9 injections pass | The server is a local PostgreSQL 17 with pgvector and citext pre-created, reached through a role that is not a superuser. `features` n/a. `migrate` ran: engine `postgres` after the manager restart (finding 4); `reset` ran refused, then with the URL (finding 3). Update downtime 6.9 s. |
| linux-x64, adopt, SQLite, minimal | 11 pass, 2 n/a; 9 of 9 injections pass | The driver installs, deletes the manager's store, and the manager adopts what is left (the adopted release then stays at keep-data uninstall: finding 7). `features`, `migrate` n/a. Update downtime 6.6 s. |
| linux-x64, new, managed Postgres (Docker) | n/a | `docker info` fails on this VM: the cell is `missing` in the table, not run. |
| linux-x64, new, SQLite, minimal, **linked payload layout** (`GOOBSTER_PAYLOAD_LAYOUT=linked`) | 11 pass, 2 n/a; 9 of 9 injections pass | The Windows layout (finding 20) run on Linux with symbolic links standing in for junctions: `current` and `previous` are links into `live/`, the update swaps them under the running manager, the manager hands over with exit 76, the interrupted update finishes on the next start, and both uninstalls remove the links with their payloads. Update downtime 6.8 s. |

What the runs measured, from the evidence files:

- The staged update (check, stage, apply, the exit-76 handoff and the new
  manager's verification) took between 52 and 58 seconds end to end on this VM and the
  downtime the manager measured, from quiesce to release, was 6.6 to 6.9 seconds across the four cells. The interrupted update finished the same way after the manager
  was killed with the handoff pending.
- Boot recovery (kill the manager by its process id, start it again) was back
  with healthy workers and the owner's conversation intact in about 6 seconds.
- A restore of a backup took about 7 seconds including the safety backup; the
  corrupted-database repair scenario (refusal, restore, repair) between 34 and 38
  seconds; the SQLite to Postgres migration about 10 seconds for a database of
  one conversation.

Not exercised by any local run: the managed-Postgres cells (Docker is not
usable on this VM), the macOS, Windows and linux-arm64 cells, and the `adopt`
mode with the representative payload — the hosted run above covers all of
them. The full profile and a real Raspberry Pi are `deferred` below.

## Findings

Acceptance found these. The first two were defects in the manager and are
fixed in this change with a regression test each; the rest are behaviours the
operator runbooks have to describe, or open items.

1. **Fixed: a CLI command waiting on a maintenance writer exited silently
   with code 1.** The barrier's wait used an unreferenced timer, so with
   nothing else keeping the process alive Node ended it in the middle of the
   wait. `restore`, `backup` and the other CLI commands that wait for the
   workers to acknowledge the barrier printed nothing and exited 1. The wait now
   keeps the process alive (`apps/manager/maintenance/barrier.js`, regression
   test in `tests/maintenanceBarrier.test.js`). Found by the backup and restore
   step.
2. **Fixed: `restore` over a SQLite file that is not a database failed in its
   own safety backup.** The safety backup probes the target database before
   copying it; for a file that SQLite refuses to open (the corrupted-database
   scenario of the repair step, the very case a restore is for) the probe
   helper failed with `SQLITE_NOTADB` and the restore stopped. The step now
   records the unreadable target, skips the safety backup of it and lets the
   restore's own database sub-step set the whole file aside
   (`apps/manager/engine/kinds/backup.js`, regression test in
   `tests/backupOperations.test.js`). Found by the repair step.
3. **Open: a CLI command on a Postgres installation reads the database from
   its own environment, not from the manager's environment overlay.** The
   manager keeps `GOOBSTER_DB_URL` in `<manager store>/environment.json` after
   a migration, for its workers. A CLI process started by an operator does not
   read that file. `reset` (and any command that opens the application
   database) run on a migrated installation without `GOOBSTER_DB_URL` in the
   shell refuses with `FOREIGN_TARGET` (exit 3) and changes nothing; with the
   URL set it runs. The refusal is the safe direction, but a runbook must tell
   the operator to export the URL (or the service's environment file) before
   running CLI commands. The driver exercises both halves in the Postgres
   cell. Observed on the existing-server cell; the managed-Postgres cell could
   not run here.
4. **Open: the switch to Postgres reaches the running manager only at its
   next start.** After `migrate run ... --release` the CLI reports the
   installation switched, but the manager process and its workers that were
   already running keep using SQLite until the manager is restarted (a running
   manager does not re-read an overlay another process wrote). The migration
   step restarts the manager and then checks `appDatabase.engine` is `postgres`
   and that the old SQLite file no longer changes; without the restart the
   owner could still sign in, against the old database. The CLI's reminder to restart the workers is printed only when the
   manager reports it did not restart them; a runbook should make the restart an
   explicit step.
5. **Behaviour: a restore killed mid-way leaves the barrier up.** The first
   retry is refused with `STALE_MAINTENANCE` (exit 3). The documented recovery
   is `release --force --acknowledge-mutation`, then the same restore again with
   `--release`. The live database is still the pre-restore file when the kill
   lands at the journal's `mutate` marker. The injection follows exactly this
   procedure.
6. **Behaviour: two different codes for an unwritable root.** A read-only
   code root refuses at preflight with exit 2 `ROOT_NOT_WRITABLE`; a read-only
   data root refuses with exit 3 `STORE_UNUSABLE`, because the manager cannot
   keep its own store there. Neither writes anything. A full disk
   (`DISK_SPACE`, a check in the install preflight) is not triggered by this
   driver or by any local run.
7. **Behaviour: an adopted installation's code is not the manager's to
   remove.** `uninstall` on an adopted installation leaves the adopted release
   in place (its `ownedFiles` omit the code root); the database and
   `config.json` follow the same keep and delete rules as a new installation.
   And `uninstall --delete-data` on a Postgres installation removes the
   SQLite file, `config.json` and the release but never drops the Postgres
   database: that belongs to the operator.
8. **No operator-facing command exists for some lifecycle steps; the driver
   uses the loopback API.** Creating the first owner, turning a feature on or
   off, setting a provider key or an instance default, and applying or
   restarting after a change are done in the portal's Host pages, which call the
   manager's `/manager/api` (recovery session, bearer plus single-use nonce).
   The CLI has no equivalent for them. The driver names these calls in its
   evidence instead of reaching into manager code; a headless operator on a
   host with no browser has to use that API directly. The runbooks should say
   so, and a CLI for them is a candidate for a later change.

The hosted matrix then found these, each fixed in the same change with a
regression test:

9. **Fixed: migrating into a database the installer had just provisioned was
   refused with `TARGET_NOT_EMPTY`.** `database docker provision` applies
   Goobster's schema; the migration preflight counted relations and blocked
   the documented SQLite-with-data → provision → `migrate` path on every
   managed-Postgres cell. The preflight now reads what the target schema
   holds (its tables and columns, other relations, which tables have rows,
   inside the same READ ONLY transaction) and judges it: nothing, Goobster's
   own schema with no rows (the warning `TARGET_SCHEMA_PRESENT`), or anything
   else (`TARGET_NOT_EMPTY`, naming what it found). The provision step records
   the tables it found, and a rollback empties them again instead of dropping
   them (`packages/core/db/migration/inspect.js`,
   `apps/manager/migration/childEntry.js`; `tests/dbMigrationInspect.test.js`,
   `tests/dbMigration.test.js`; [db_migration.md](db_migration.md)).
10. **Fixed: the driver started the Windows launcher with an unquoted path.**
    `cmd.exe` read `D:/a/_temp/...` (the runner spells `$RUNNER_TEMP` with a
    forward slash) as a command named `D:\a\_temp`. The driver normalizes and
    quotes a `.cmd` launcher and its arguments (`scripts/acceptance/lib/operator.js`,
    `launcherCommand`; `tests/releaseAcceptanceReport.test.js`).
11. **Fixed: the installed Windows payload launcher did not read
    `goobster.env`.** `current\bin\goobster-manager.cmd` took its roots from
    the environment or `%LOCALAPPDATA%\Goobster` only, unlike the POSIX
    launcher and the code-root launcher the bootstrapper writes, so `status`
    run from it looked at an empty data directory and reported `recovery`. It
    now reads the `GOOBSTER_*` lines of `<code root>\goobster.env` the same way
    (text, never run, environment first) when it runs from `current`
    (`scripts/package-runtime.js`; `tests/packagePayloadRules.test.js`;
    [windows_install.md](windows_install.md#repair-reconfigure-uninstall)).
12. **Fixed: the macOS payload smoke found its port taken.** The smoke probed
    a free port on loopback but the API binds the wildcard address, which
    macOS refuses while another account's `TIME_WAIT` connections sit on the
    port. The probe now makes the same wildcard bind and the smoke retries on
    another port when the first listen is refused for that reason
    (`scripts/package-smoke.js`).
13. **Fixed: the managed-Postgres `reset` failed `BACKUP_FAILED` on the hosted
    runner, with its cause hidden.** The pinned `pgvector/pgvector:pg17`
    server is newer than the runner's `pg_dump` (16); the backup refuses that
    (`TOOL_VERSION_MISMATCH`) and the reset wrapped the cause away. The reset
    now carries the wrapped error's short code as `reason` (the CLI prints
    `BACKUP_FAILED (TOOL_VERSION_MISMATCH)`), and the workflow installs the
    PostgreSQL 17 client tools for those cells **and puts them first on
    PATH** - installing the package alone changed nothing, because
    `/usr/bin/pg_dump` is Debian's `pg_wrapper` and kept choosing the runner's
    own 16 ([docker_postgres.md](docker_postgres.md) now tells an operator the
    same; `apps/manager/engine/kinds/reset.js`; `tests/dataReset.test.js`,
    `tests/releaseAcceptanceWorkflow.test.js`).
14. **Fixed: on Windows the driver ended only `cmd.exe`, not the manager.**
    A `.cmd` launcher runs through `cmd.exe`, so the process the driver held
    was the shell; signalling it left the manager's `node.exe` and its workers
    running, holding the driver's pipes open (the job sat until its timeout
    after the evidence was written) and the payload's native addons mapped
    (the work tree could not be removed, `EBUSY` under `current\app`). The
    driver now ends the whole tree on Windows (`taskkill /T /F`, as the
    service host does on stop) wherever it stops, crashes or interrupts a
    process; removing the work tree is best-effort and never fails a cell;
    and the driver leaves on its own once the evidence is written even if a
    stray process still holds a pipe (`scripts/acceptance/lib/operator.js`
    `killTree`, `scripts/acceptance/run.js`; `tests/releaseAcceptanceReport.test.js`).
15. **Fixed: no update could be downloaded on Windows.** `update stage`
    ended in `DOWNLOAD_FAILED` for the directory source (and would have for
    a URL or GitHub source alike): the landed file was synced through a
    handle opened read-only, and on Windows `FlushFileBuffers` needs write
    access, so the `fsync` failed with `EPERM` and the download was
    discarded. The handle is now opened for writing
    (`apps/manager/update/source.js`; `tests/updateStage.test.js` lands a
    file through a file system that refuses a read-only `fsync`, as Windows
    does). The other failures of that Windows run (`STALE_MAINTENANCE` at
    reset, the scratch managers that never answered, the restore that
    completed under the "kill", `EBUSY` on the WAL file) were the shadow of
    finding 14: the manager the driver believed stopped was still running.
16. **Fixed: on Windows the update read its archive with the wrong `tar`.**
    With the download landing (finding 15), `update stage` ended in
    `ARCHIVE_UNREADABLE` within three seconds, before anything was unpacked.
    The manager ran whatever `tar` PATH gave it; under Git Bash (the hosted
    job's shell, and an operator's terminal just as easily) that is the GNU
    tar Git for Windows puts first, which reads `D:\...` as a remote host
    (`Cannot connect to D`) and fails on every archive, while the system
    `tar.exe` in `System32` is bsdtar and takes the path. On Windows the
    manager now uses `%SystemRoot%\System32\tar.exe` when it is there and
    PATH only where it is not, and the error carries the call and cause as
    a short reason (`LIST_EXIT_1`, `EXTRACT_ENOENT`), never tar's output
    (`apps/manager/update/archive.js`; `tests/updateStage.test.js`).
17. **Fixed: the driver's Windows stop was a crash, and a restore then set
    aside a different file.** Finding 14 made the Windows stop a tree kill.
    The service host does not do that: it sends Ctrl+C and the manager drains
    and closes its workers before it leaves. A tree kill ends the workers
    mid-write and leaves SQLite with an un-checkpointed WAL; the next thing
    to open the database, the restore of `restore-kill`, folds the WAL into
    the main file first, so the file it set aside as `.pre-restore` no longer
    hashed as the file the driver had measured and the check "the previous
    database was set aside intact" failed. Because that check failed first,
    the injection never ran its own `release --force --acknowledge-mutation`,
    the interrupted restore's barrier stayed up, and the next `reset` was
    refused `STALE_MAINTENANCE`: one cause, two red cells. A Node parent
    cannot send Ctrl+C, so on Windows the driver now asks the manager for
    what that Ctrl+C runs inside it, the public `lifecycle.stop` operation
    (workers drained and closed through the control file), and ends the
    process tree afterwards (`scripts/acceptance/lib/cell.js` `stopDaemon`).
    `killTree` also reports true only when it ended the process, so a
    restore that finishes before the kill lands is `n/a`, not a false
    "killed" (`scripts/acceptance/lib/operator.js`).
18. **Fixed: on Windows the payload launcher failed with no argument.** The
    scratch managers of the `token` and `store` injections never answered
    while the cell's own manager did. Their logs (kept beside the evidence
    from the fifth run on) held one line, `The syntax of the command is
    incorrect.`, and the processes left with 255 within a quarter of a second:
    `cmd.exe` aborting the batch file before Node ran. The one difference
    from every working call was the argument list, which was empty: the
    launcher took a substring of its first argument (`%FIRST:~0,1%`) to tell a
    `--flag` from a CLI verb, and in a batch file a substring of an undefined
    variable is not empty: `cmd` drops `%FIRST:` and reads on to the next `%`,
    so the line it then parses is garbage. Every other door passes an
    argument (`--supervise` from the service, `--open-browser` from the
    installer, a verb from the CLI), which is why no Windows journey had run
    it bare. The variable now always holds a leading `x` before any substring
    is taken (`scripts/package-runtime.js`; `tests/packagePayloadRules.test.js`
    checks that no substring is taken of a variable that may be undefined).
19. **Fixed: on Windows the archive's manifest was "missing".** With the
    right `tar` (finding 16) `update stage` ended in `MANIFEST_MISSING`.
    bsdtar on Windows ends each line of its listing with CR LF; the manager
    split the listing on LF and compared `payload-manifest.json\r` with the
    name it wanted. Listings are now split on either line end
    (`apps/manager/update/archive.js`; `tests/updateStage.test.js` drives
    the listing and the member read through a tar that answers with CR LF).
20. **Fixed: no update could be applied on Windows.** With the archive read
    (findings 16 and 19) `update apply --now` reached the `activate` step
    and failed there: `EPERM ... rename '<code>\current' -> '<code>\previous'`.
    The staged-update design swaps `current` *before* the manager leaves
    with exit 76, while the manager still runs from it; that is fine on
    POSIX, where a rename moves an inode, and impossible on Windows, where a
    directory with any open handle beneath it (the manager's own `node.exe`,
    its native addons, the workers' working directory) cannot be renamed,
    whatever the handles' sharing mode. The payload layout on Windows is now
    the one Windows deployments use: every activated payload stays under
    `<code>\live\<name>` and `current` and `previous` are directory junctions
    to those, so an activation moves the staged directory under `live\`,
    renames the `current` junction to `previous` and creates a new junction —
    links hold nothing open, and the running manager keeps its handles on the
    old payload until it exits (`activationLayout` and the `linked` layout in
    `scripts/lib/payloadStage.js`; the installer's own links are the one kind
    of link the removal guard accepts, `isPayloadLink` in
    `apps/manager/install/paths.js`). POSIX keeps the rename layout the
    other eighteen cells proved. Two consequences for the apply machine:
    a manager that runs from a payload under `live\` is *self-replacing*
    whichever payload `current` names at the moment (the process's code
    location is resolved once, when the applier is made, so the swap it
    performs does not change the answer — without this the old manager
    verified the new release in-process, `handoffMode` `inline`, and the
    interrupted-update injection left the install in recovery), and a
    rollback performed by the manager running from the payload being put
    aside drops only the link and leaves that payload for the next
    activation's sweep (`removePayloadEntry(entry, { keepTarget })`), so a
    process never deletes its own code. The POSIX launcher judges
    "started from `current`" by the path it was reached by (`pwd -L`), not
    the physical path, so `goobster.env` is still read through a link.
    `GOOBSTER_PAYLOAD_LAYOUT=linked` runs the Windows layout on a POSIX host
    with symbolic links; the local linux-x64 cell was run that way end to
    end (results above). Specs: `tests/payloadStage.test.js` (the linked
    activation, its failure path, recovery, sweep, `keepTarget`),
    `tests/updateApply.test.js` (self-replacing under `live/` before and
    after the swap), `tests/installEngine.test.js` (an uninstall over the
    linked layout), `tests/packagePayloadRules.test.js` (the launcher through
    a link). Docs: `packaging.md`, `manager_update.md`, `windows_install.md`.

## Cells no hosted runner can give

These are `deferred` in the table, each with its reason. Nothing here is
claimed as passed.

- **linux-arm64 (Raspberry Pi 4B), adopt, SQLite, representative.** Pi hardware:
  no hosted runner is a Raspberry Pi. linux-arm64 itself is proven on the
  hosted arm runner; the Pi's memory, SD-card I/O and thermal limits are not.
- **linux-x64, new, existing Postgres server, representative.** A hosted
  Postgres service container has a superuser the application is never given;
  the existing-server path (a role without superuser, extensions created by an
  administrator) needs a server that matches a real deployment. The driver
  runs this cell against any server named by `GOOBSTER_ACCEPTANCE_PG_URL`; the
  minimal variant was run locally (results above).
- **linux-x64, new, SQLite, full profile.** The full profile with real
  provider keys: the keys are secrets this workflow never receives, and a full
  payload without them proves nothing the representative payload does not.
- **darwin-arm64, new, managed Postgres, minimal.** Desktop PostgreSQL (Docker
  Desktop on macOS): hosted macOS runners have no container runtime.
- **win32-x64, new, managed Postgres, minimal.** Desktop PostgreSQL (Docker
  Desktop on Windows): hosted Windows runners cannot run Linux containers.
- **linux-x64, major upgrade, SQLite, minimal.** Major upgrades (a release that
  changes the database schema, and the recovery decision that follows a failed
  one): the fake release in this driver changes only a version.

### Raspberry Pi and ARM64

linux-arm64 is proven on the hosted `ubuntu-24.04-arm` runner: all eight
arm64 cells passed in the hosted run above (the packaging proof,
`documentation/packaging_proof.md`, had already run the payload's smoke check
on that runner). **A Raspberry Pi 4B is not**: no hosted
runner has its memory limit, SD-card I/O or thermal behaviour, so the Pi cell
stays `deferred` and is the owner's to run by hand with the same driver
(`node scripts/acceptance/run.js --install adopt --db sqlite --features
representative`, against a payload built for `linux-arm64`).

### Native Postgres on Linux (PR #371)

The native Postgres provisioning of PR #371 is merged and has its own
real-distro proof, `.github/workflows/native-postgres.yml`: the full journey
(provision, port conflict, stop and start, repair, relocate, keep and remove
data, a foreign cluster left untouched, clean teardown) on Ubuntu 24.04 x64 and
arm64, Debian 12 and Rocky 9 ([native_postgres.md](native_postgres.md)). This
driver has no `native-pg` database choice yet: the cells above that use
Postgres take the Docker path (`managed-pg`) and an existing server
(`existing-pg`) only, and a native cell is a later addition to `matrix.js`.

## Caveats

- Only the local linux-x64 cells have run. The macOS and Windows cells, and the
  arm64 cell, are written and structurally tested (`tests/releaseAcceptanceWorkflow.test.js`)
  but not run; in particular the Windows launchers (`.cmd`), how a process is
  killed by its process id there, and the POSIX-mode half of the storage
  injection (which is `n/a` on Windows) are unverified.
- The full-disk half of the storage injection is not exercised.
- The update step moves between two versions of the same payload; a release
  that changes the database schema, and the recovery decision after a failed
  one, are covered by the manager's own tests and the local proof recorded in
  `documentation/installer_plan.md` (P5.2), not by this matrix.
- The fake provider proves the chat path end to end, not any real provider.
- The hosted workflow uses the development key; the production signing key is
  not in the repository, so the signed-release path is verified against the
  throwaway key only.

