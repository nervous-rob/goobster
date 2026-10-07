---
title: Manager install, adoption, repair and uninstall (installer P3.3)
kind: reference
summary: How the manager installs a verified release payload, adopts an existing installation, reconfigures, repairs and uninstalls - the installation record (version 2) and what the manager owns, discovery and preflight, the install.new, install.reconfigure, install.repair, install.uninstall and adopt kinds with their steps, resume after a crash, updater reconcile, the tombstone and what an uninstall keeps, and the headless CLI (flags, answers-file schema, exit codes). Also what is not done yet - OS service registration and the privileged helper.
when: Installing, repairing, moving or removing a Goobster installation from a terminal or a script; adopting a Raspberry Pi, PM2, Docker or manual checkout under the manager; understanding what an uninstall deletes and what it never touches; scripting the manager CLI; building a bootstrapper that must call the install engine.
tags: [installer, manager, install, adopt, repair, uninstall, reconfigure, cli, preflight, tombstone, updater]
---

# Manager install, adoption, repair and uninstall

Installer Phase 3 item 3 (issue #329). The manager (`documentation/manager.md`)
already knew how to claim an installation and change settings. This adds the
operations that create, move, fix and remove the installation itself, and a
headless command line for them. The release payload comes from
`documentation/packaging.md` (verification, staging, atomic activation); this
document is about the manager around it.

Nothing here registers an operating-system service. The privileged operations
are named and shaped (see "Privileged steps") and answer `501`; the
bootstrappers (#331-#333) implement them. A fresh install therefore finishes
with exit code 5: everything is on disk and the one step that needs privilege
is recorded as deferred.

## The installation record

`installation.json` in the manager store is version 2 when the manager
installed or adopted the instance. A version 1 claim record (a claimed
instance with no install facts) is still read and stays version 1 until an
install operation attaches facts to it. The sealed record
(`installation.seal`) holds:

| Field | Meaning |
| --- | --- |
| `layout` | `lite`, `standalone` or `paired` (`documentation/independent_runtime.md`). |
| `roots` | Absolute paths: `code`, `data`, `config`, `cache`, `logs`, `uploads`, `managerStore`. |
| `runtimeUser` | The account the service runs as, or `null`. |
| `owned` | What the manager may remove: `files` (roots it created), `services` (units it registered, with `registeredBy`), `dependencies` (system packages it installed). |
| `updater` | `{kind: 'manager' \| 'script' \| 'none', unit?}` - who updates this install. |
| `release` | `{releaseId, version, target, features}` of the active payload, or `null` for an adopted checkout. |
| `database` | `{engine: 'sqlite' \| 'postgres', external}`. An external Postgres is never created or deleted by the manager. A successful `db.migrate` ([db_migration.md](db_migration.md)) flips it to `{engine: 'postgres', external: true}`; the connection itself lives in the manager's environment overlay (`<managerStore>/environment.json`, [manager.md](manager.md#the-environment-overlay)), never in the record. |

**Ownership is explicit.** Uninstall removes only what `owned` lists and
only paths that still resolve inside a recorded root. Anything the manager
did not create (a Postgres server, a service it did not register, files a
person put next to the code) is left alone. If the record or seal was edited
outside the manager, every install operation refuses with
`OWNERSHIP_TAMPERED`. The seal catches accidental and naive edits; it is not
a defence against someone who can write the manager store.

Roots are checked before use: absolute, no `..`, not `/` or the home
directory, no symlink in any component of a root the manager will write or
delete, the code root not nested in the data root or the reverse, and the
store owned by the running user.

## Discovery

`discover` (CLI: `goobster-manager discover`) is read-only. It runs a closed
list of read commands (`READS` in `apps/manager/install/discover.js`; no
shell, no writes) and reports candidates:

| Kind | Evidence |
| --- | --- |
| `payload` | `current/` with a release manifest under the code root. |
| `rpi` | `data/.install-origin` of kind `rpi-script` (written by `scripts/install-rpi.sh`), the `goobster` systemd unit, the update timer or a cron line. |
| `pm2` | A PM2 process for this code. |
| `docker` | A compose project or container for this image. |
| `manual` | A checkout with `config.json` or a database but no other marker. |

Each candidate has a stable `candidateId` (12 hex characters of a hash of its
roots) and the updaters found for it: `cron`, `systemd-timer`, `pm2-watch`.
No credential, token or config value is read into the report.

## Preflight

Every plan runs preflight and returns findings of severity `block` or `warn`;
a `block` makes the plan invalid (`PREFLIGHT_FAILED`, exit 2) and nothing is
written. Checks: roots (see above); writability; the store owner; target and
Node ABI against the payload manifest; the feature selection; free disk for
the payload; system dependencies of the selected features (warn only - the
manager audits them, it does not install them); Postgres settings for
`paired` or `postgres`; and ports. `PORT_IN_USE` blocks only `install.new`
(a repair or reconfigure expects its own service to hold the port). Preflight
also refuses an install over existing evidence (`EXISTING_INSTALLATION`)
unless a tombstone says a previous uninstall left it. Uninstall also
refuses `WORKERS_RUNNING` while the manager's lifecycle layer is supervising
the application workers, or while any of the layout's worker ports (bot,
api, sandbox) is in use - the CLI runs in its own process and cannot see a
manager daemon's supervisor, so a busy port is the cross-process signal that
the application is still running (stop it first). `ROOTS_MISMATCH` blocks
when the recorded store is not the one this manager runs on.

## The kinds

The install kinds are not public: they take filesystem paths, so they are
planned in-process (the CLI) and never over the manager HTTP API.
`adopt` is public and keeps its original label-only form. Each kind goes
through the generic engine (plan, validate, apply, journal, audit
`manager.<kind>`), so a plan is bound to the state it was made against and
expires if that state changes (`PLAN_EXPIRED`).

### `install.new`

Allowed when the manager is unclaimed or in recovery (local, or recovery
credential), or claimed and asked locally/over a session. Steps:
`preflight`, `stage`, `verify`, `ownership`, `init-db`, `write-config`,
`write-features`, `activate`, `register-service`, `finalize`.

- `stage` copies the verified selection into `<code>/staging` (`.partial`
  until the whole tree verifies) from a local payload directory (`source`).
  There is no network download in this version: the plan carries
  `downloads: []` and names the `release-download` hook that a bootstrapper
  will provide.
- `ownership` creates the sealed record before the database exists, so a
  crash cannot leave a database with no owner.
- `init-db` opens the database in a child process, applies the schema and
  counts tables; for Postgres it connects to an existing database and never
  creates or drops one. A Postgres install carries the connection in the
  `database` answer (`{ "engine": "postgres", "connection": { host, port,
  database, schema, user, password, tls } }`; the password only from the
  answers file, a prompt or `GOOBSTER_DB_PASSWORD_FILE`): preflight probes
  the server read only and blocks on anything the probe blocks on
  (including a schema that holds foreign tables), `init-db` applies the
  schema to an empty or older Goobster schema and writes the connection to
  the manager's environment overlay, and the plan shows the server without
  its password. See [database_connection.md](database_connection.md).
- `write-config` writes the supplied config fields through the field
  catalog (secrets by value, from the answers file or the prompt, never from
  argv); `write-features` writes `data/features.json` for the selection.
- `activate` is the atomic switch of `current/` with `previous/` kept.
- `register-service` records a privileged step (deferred).

### `install.reconfigure`

Claimed only. Changes the layout, the `code`, `cache`, `logs` and `uploads`
roots, the feature selection or settings. `data`, `config` and
`managerStore` do not move (`ROOT_NOT_MOVABLE`). A code move re-stages from
the old `current/` and retires the old payload directories after the record
points at the new ones; the manager must then be restarted with the new
`GOOBSTER_WORKSPACE_ROOT`. Steps: `preflight`, `stage`, `verify`,
`write-config`, `activate`, `record`, `retire-old`, `register-service`. An
input that changes nothing plans as a no-op.

### `install.repair`

Claimed only. Puts the recorded release back at the recorded roots without
touching `data`, `config` or the store. The source is the first of: an
explicit `source`, `previous/`, `releases/<releaseId>`; each is verified
before use, and with none, the plan says `REPAIR_SOURCE_REQUIRED`. A healthy
installation plans as a no-op. Steps: `preflight`, `stage`, `verify`,
`init-db`, `write-features`, `activate`, `register-service`.

### `install.uninstall`

Claimed only. Steps: `preflight`, `unregister-service`, `tombstone`,
`remove-code`, `remove-data`, `remove-ownership`.

- Default is **keep data**: the code and the other owned non-data roots go;
  `data/`, `config.json` and the database stay.
- Deleting data needs `keepData: false` and `confirm` equal to the
  installation id (CLI: `--delete-data --confirm <installationId>`); `--yes`
  never stands in for it.
- A registered service the manager does not recognise as its own is
  `UNKNOWN_SERVICE_OWNER` until the input says
  `acknowledgeUnknownServices`; it is then left in place.
- An external Postgres is never touched. Paths are re-checked against the
  recorded roots immediately before each removal.
- The **tombstone** (`tombstone.json`, in the parent of the store directory,
  with `dataRemoved`) is written before the record is removed. While it
  exists the manager is in `recovery` with reason `MANAGER_TOMBSTONED` and
  does not auto-claim; a local `install.new` over kept data is allowed, and
  `adopt` can take it over. A full removal keeps only the store directory
  (`operations/`, `lock`, the audit log) and the tombstone, so the history
  of what was removed survives it.

### `adopt` (managed form)

The original label-only plan is unchanged. With `candidateId` or `roots` the
plan adopts an existing instance in place: it moves no files and changes
nothing in the database. Steps: `preflight`, `set-aside`, `reconcile-updater`,
`create-installation`, `create-bridge-key`. The record has `release: null`
and `layout`/`database` as discovered or given.

**Updater reconcile.** An installation is updated by one thing. For each
updater found:

| Updater | Result |
| --- | --- |
| cron line for this code | Commented in place as `#goobster-manager-disabled: <line>` (reversible); the user crontab only. |
| systemd timer | Needs the privileged `updater.disable` (deferred), and the checkout's `scripts/auto-update.sh` must carry the `goobster-manager-guard` marker, else the plan is `UPDATER_CONFLICT`. |
| PM2 watch | `UPDATER_CONFLICT`: stop the watch yourself, then adopt. |
| `keepUpdater: true` | The record says `updater.kind: 'script'` and nothing is changed. |

`scripts/auto-update.sh` now exits without acting when the sealed record of
the manager store says `updater.kind` is `manager`, so a timer that survives
an adoption does no harm.

## Over HTTP

The browser wizard and the Host room run these kinds over the manager's
HTTP API (`POST /operations`, `/validate`, `/apply`). `install.new`,
`install.reconfigure`, `install.repair` and `install.uninstall` are
`public: true`: a setup or recovery session or a portal assertion may plan
them, and an anonymous caller is refused. A caller that is not the local
CLI (`via` other than `local`) must give roots under the allowed bases
(`GET /install/suggest` lists them with free space); anything else is the
preflight finding `ROOT_OUTSIDE_ALLOWED_BASES`. Read-only routes feed the
screens: `GET /install/suggest` (suggested roots, bases, detected layout,
release sources, ports), `GET /install/source?dir=` (the features, sizes
and system prerequisites a release directory carries, from its manifest
only), `GET /install/record` (the sanitised record) and
`GET /install/first-run` (the checklist). Three small kinds finish a setup:
`owner.create` (the first operator account, with no Discord; the password
travels only in private input), `lifecycle.start` (start supervising the
workers in a manager that was not started with `--supervise`) and
`lifecycle.stop` (what an uninstall needs, since it refuses to run beside
running workers).

## Resume

The engine does not re-apply a failed operation. Run the same command again:
it plans the same input, finds the interrupted operation by plan signature
and creates a new, linked one (`resumeOf` in the plan). Every step checks
what is already true (a verified staging tree, a written file with the right
content, a record with the right revision) and records `skipped`; the
journal keeps a per-step ledger (`pending`, `done`, `skipped`, `failed`,
`deferred`) beyond the engine's own step list. A `.partial` staging tree
from a crash is discarded and rebuilt. At the start of every apply the
manager runs `recoverInterrupted` for the payload layer first.

A crash between `record` and `retire-old` in reconfigure can leave the old
payload directories behind; `repair` or a later reconfigure removes them.

## Privileged steps

`apps/manager/privileged.js` declares `service.register`,
`service.unregister`, `package.install`, `updater.disable` and `user.create`
with the input each will take (`INPUT_SHAPES`). All answer `501
NOT_IMPLEMENTED`. When an install step needs one, the step is recorded
`deferred` with the operation name, never run, and the CLI exits 5. The
manager never executes a shell command for these.

## The CLI

```bash
node apps/manager/cli.js <command> [options]     # npm script: manager:cli
```

| Command | What it does |
| --- | --- |
| `install` | `install.new` from a local payload directory. |
| `adopt` | Adopt one discovered or named installation. |
| `reconfigure`, `repair`, `uninstall` | The matching kind. |
| `plan <command>` | Same as `<command> --dry-run`. |
| `status` | What the manager store says (read only). |
| `discover` | List installations on this host (read only). |
| `schema` | Print the answers-file JSON schema. |
| `migrate preflight\|run\|rollback\|status` | SQLite to Postgres ([db_migration.md](db_migration.md)). `--confirm <installationId>` and `--release` apply to `run` and `rollback`; the target URL and backup passphrase come only from the answers file or a hidden prompt. |

| Option | Meaning |
| --- | --- |
| `--answers <file>` | The operation's input as JSON. Without it the CLI asks (prompts go to stderr). |
| `--dry-run` | Plan and preflight; nothing is written - not the store, the journal or the audit log. |
| `--yes` / `-y` | Skip the "Proceed?" question. Never skips a deletion confirmation. |
| `--delete-data --confirm <id>` | Uninstall: also remove the owned data roots. |
| `--json` | One JSON document on stdout; progress stays on stderr. |

**Secrets are never accepted on the command line.** A flag whose name looks
like a secret (`--token`, `--password`, ...) is refused with
`SECRET_ON_ARGV`. Secret values come from the answers file (`config`
entries) or a hidden prompt. The answers file must be a regular file (not a
symlink), mode `0600`, owned by the running user, at most 256 KB; otherwise
`ANSWERS_PERMISSIONS`. Output, the journal, progress lines and the audit rows
never carry a secret value, a prompt or a path outside the roots; schema
errors report a JSON pointer and a rule, never the value.

The shipped schema is `apps/manager/install/answers.schema.json` (JSON Schema
2020-12, `additionalProperties: false`). One document per command:

```json
{
  "command": "install",
  "source": "/srv/release/goobster-linux-x64",
  "ownerLabel": "Rob",
  "features": ["discord", "tavern"],
  "layout": "lite",
  "roots": { "code": "/opt/goobster", "data": "/var/lib/goobster" },
  "release": { "publicKeyFiles": ["/etc/goobster/release.pub"] },
  "config": [{ "id": "discord.clientId", "value": "123456789012345678" }]
}
```

Other fields: `database.engine`, `runtimeUser`, `registerService` (install);
`candidateId`, `keepUpdater`, `replaceUnreadable` (adopt); `source`,
`release`, `config` (reconfigure/repair); `keepData`, `confirm`,
`acknowledgeUnknownServices` (uninstall); `target`, `backup`, `provision`,
`confirm`, `roots.data`, `release` (migrate run; the `migrate`,
`migrate-preflight` and `migrate-rollback` definitions).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. |
| 1 | Unexpected error. |
| 2 | Invalid input, bad answers file, or a preflight block. |
| 3 | Refused: another operation holds the lock, tampered ownership, wrong state, existing installation, unknown service owner. |
| 4 | Interrupted after at least one step; run the same command again to resume. |
| 5 | Applied, but a step is deferred for the privileged helper (not used by `migrate`). |

The CLI runs with `via: 'local'`: whoever can write the manager store can
run it, which is the same guarantee the recovery credential gives the
portal. It is audited as `manager.install.new`, `manager.install.reconfigure`,
`manager.install.repair` and `manager.install.uninstall` (and `manager.adopt`),
reconciled into `operator_audit` like every other manager operation.

## Reset

`goobster-manager reset` and `goobster-manager release` are the same local CLI
for the data reset ([data_reset.md](data_reset.md)): `reset --scope instance`
or `reset --scope feature --feature <id>` enters the maintenance barrier, runs
the `data.reset` operation (a verified backup first, a typed confirmation of
the installation id) and releases the barrier; `--dry-run` only prints the
preview. The answers file takes a `reset` section (`scope`, `feature`,
`backup.dir`, `backup.passphrase`, `confirm`), and the passphrase is never
accepted on the command line. The audit action is `manager.data.reset`.

## Not done here

- OS service registration, package installation, user creation and the
  systemd timer disable: privileged helper, #331-#333.
- Network download and archive sources: only a local payload directory.
  Production signing keys: #341.
- Lifecycle workers for a payload `current/app` layout (the lifecycle layer
  assumes `<root>/apps/...`).
- The browser wizard exists (`documentation/setup_wizard.md`, #330); what it
  does not do yet is listed there.

## Tests

`tests/installEngine.test.js` (install, rerun, resume, repair, reconfigure,
uninstall, tombstone, adoption and the refusals; also on Postgres),
`tests/installCli.test.js` (arguments, answers file, schema errors, dry run,
prompts, exit codes, redaction). Both build a synthetic unsigned payload in a
temp directory and never touch a real installation.
