---
title: The setup and maintenance wizard (installer P3.4)
kind: reference
summary: The browser journey for first-time setup and for later reconfigure, repair and uninstall of a SQLite installation - the eleven setup steps (welcome, where, features, connections, database location, defaults, access, review, progress, first-run check, open Goobster), how the manager serves it at /manager/ and how the portal Host room reaches the same screens through the bridge, local-only versus network access, the HttpOnly cookie session and what a manager restart does to it, how secrets are typed once and never echoed, kept or stored by the page, the first-run check, the recovery page, the headless alternative, and the Backup, Restore, Reset and Migration journeys and the maintenance-barrier panel, and what is not here yet (Postgres, service registration).
when: Installing Goobster from a browser; reconfiguring, repairing or removing an installation without a terminal; explaining why a secret field came back empty; reaching the wizard on a headless machine; understanding what the wizard does when the manager restarts or the database is broken; building another front end on the manager's install routes.
tags: [installer, wizard, setup, manager, reconfigure, repair, uninstall, recovery, secrets, first-run, sqlite, headless]
---

# The setup and maintenance wizard

Installer Phase 3 item 3 (issue #330). The wizard is a static React client
that drives the installation manager (`documentation/manager.md`). It adds no
rules of its own: every screen builds the input of an operation kind the
manager already has (`install.new`, `install.reconfigure`, `install.repair`,
`install.uninstall`, plus `owner.create`, `lifecycle.start` and
`lifecycle.stop`), shows the manager's own plan, and applies it. The
command line (`documentation/manager_install.md`) runs the same engine;
the Host pages (`documentation/host_operations.md`) share the same field
catalog, field controls and plan components.

## Where it lives

| Entry | What you get |
|---|---|
| `http://127.0.0.1:3400/manager/` (also `/manager/setup` and `/manager/recovery`) | The wizard, served by the manager itself from `apps/web/dist/setup/` (built by `npm run build:web`). One page for all three paths; the page decides what to show from the manager's state. |
| Portal, Host room, **Installation** (`/host/installation`), and the Installation card on the Host overview | Reconfigure, Repair and Uninstall for an operator, through the portal's Host routes and the authenticated bridge. The browser holds no manager credential. |
| Portal, Host room, **Maintenance** (`/host/maintenance`), and the Maintenance card on the Host overview | Backup, Restore, Reset and Migration with the same journeys as the manager page, over the portal's Host proxies. See the limits in the section below. |

If the client is not built the manager answers a plain page that says so
and names the command; the manager's API and the command line keep working.
The pages carry their own headers: `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and a policy
that allows this origin only (no inline script, no frames, no outside
forms).

## What the page shows in each state

| State of the manager | The page |
|---|---|
| `unclaimed`, no files | Welcome: ask for the setup credential and a name for the installation, then the setup steps. |
| `claimed`, no installation recorded yet | The setup steps, from where you left off (the answers are kept in this tab). |
| `claimed`, installed | The maintenance page: what is installed, the first-run checks, the maintenance-barrier panel when a barrier is held, and **Reconfigure**, **Repair**, **Backup...**, **Restore...**, **Reset...**, **Migration...**, **Uninstall**. |
| `claimed`, installed, database cannot be opened | The same page, with **Repair** recommended and the reason. |
| `recovery`, files exist but no record | A plain explanation and the one command that fixes it (`node apps/manager/cli.js adopt`). The wizard never installs over files it did not install. |
| Opened at `/manager/recovery` with a recovery credential | "Recover this installation": the maintenance page with Repair first. |

## The setup journey

The stepper names the eleven steps; Back and Forward in the browser walk
them and each step keeps its answers. Everything before Install is local to
the page; nothing on the machine changes until the review.

1. **Welcome**: the setup credential (see Credentials below).
2. **Where**: the release to install (one found on the machine, or a
   folder you type) and the program, cache, logs and uploads folders. The
   suggested place for this platform is preselected; any other folder must be
   under an allowed base (`ROOT_OUTSIDE_ALLOWED_BASES`), listed with free
   space.
3. **Features**: the optional parts of the release with size, what each
   needs and what it costs. Choosing one chooses what it requires.
4. **Connections**: the owner account (login name and password, no Discord
   needed), then every integration key and the optional local Ollama, with
   its own **Test connection**. Every one is optional.
5. **Database**: which engine, with guidance by workload and no user-count
   thresholds (one machine: SQLite; the bot and portal apart: PostgreSQL is
   required; many servers or several heavy features: consider PostgreSQL).
   SQLite shows where the file lives (the data folder, the settings file and
   the manager records belong to the running manager and are shown, not
   edited). **An existing PostgreSQL server** shows the connection form (host,
   port, database, schema, user, password, TLS mode, CA file), a read-only
   **Test connection**, an optional **Prepare the server** panel (an
   administrator's credential used once; the ticked actions only) and a
   read-only note of where the data is stored. Continue unlocks when a test of
   exactly the current settings says the server can be used. **PostgreSQL in Docker
   (managed by this installer)** is enabled only after the Docker check
   passes; otherwise it is disabled and the reason is shown next to it.
   Choosing it shows the check, the port, listen address and storage form and
   a preview of the container, volume and network names that will be created;
   passwords are generated and never shown. A server the installer would set
   up as a native package is listed and disabled with the sentence "Available
   in a later version of this installer". See
   [database_connection.md](database_connection.md) and
   [docker_postgres.md](docker_postgres.md).
6. **Defaults**: the installation's and the assistant's names, and what a
   new person inherits. The defaults are saved right after the database is
   created.
7. **Access**: the addresses - this machine only or the network - and the
   public address people will use.
8. **Review**: every answer in words. Secrets appear as "will be set",
   never as a value.
9. **Install**: the plan applied step by step with per-step state. A reload
   returns to the same operation and keeps polling it.
10. **Check**: the first-run check (below).
11. **Open Goobster**: enabled only when every worker is healthy and the
    portal's `/health` answers. It shows each worker's state and the address
    of the portal.

The layout is chosen for you: `standalone` when no Discord token is given,
`lite` when there is one.

## Reconfigure, repair and uninstall

- **Reconfigure** edits connections, names, the layout and the movable
  folders (cache, logs, uploads). The review shows the exact difference per
  setting and what waits for a restart; **Restart now** appears after
  Apply and the page waits for every worker to acknowledge the new revision.
  The program and data folders cannot be moved here.
- **Repair** verifies the program files against the release they came from,
  restores damaged ones, opens the database again and rewrites the feature
  choice. Data and settings are never touched. When the files are too
  damaged to repair in place the page asks for a copy of the same release
  (found on the machine or typed) - `REPAIR_SOURCE_REQUIRED`.
- **Uninstall** keeps your data by default. Deleting it needs the
  installation id typed exactly as shown. The manager refuses to remove
  files while its workers run, so from the manager's own page there is a
  **Stop Goobster** button first. From the portal the page explains that the
  portal is one of those programs and cannot remove itself; finish from the
  manager with a recovery credential.

- **Database** (`#/database/status`, **Installation → Database…**, test id
  `action-database`; in the portal **Host → Database**) shows the engine and
  the connection in effect (never the password) and offers **Connect to a
  PostgreSQL server…** and **Update the schema…**. It names the three
  different jobs - connection setup, schema update and PostgreSQL server
  upgrade - and says that a SQLite database that holds data moves with the
  migration, not here. See [database_connection.md](database_connection.md).

Every journey shows the plan before anything changes and a per-step
progress afterwards. A failure says which step stopped, what was kept, and
that running it again picks up where it stopped.

## Backup, restore, reset and migration

Installer P4.4 (issue #337). Four more buttons on the maintenance page,
each a journey over an operation kind that already exists
(`backup.create`, `backup.restore`, `data.reset`) or over the migration
status and preflight routes. The journeys add no rules: the manager plans,
validates and applies, and the page shows the plan before anything changes.
The full rules are in `documentation/backup_and_restore.md` (Through the
manager).

- **Backup...** (form, review, progress). Choose a destination folder (the
  page suggests one; the backup goes in a new dated folder inside it, never
  into the manager's own store), whether to include `config.json`, and, if
  so, a passphrase typed twice. The review states which file sets are
  copied and which are left out. Only `config.json` is encrypted - the
  archive itself is not - and the review and the result both say so. The
  result names the archive folder and the counts.
- **Restore...** (source, options, review, progress). Type the backup folder
  and **Inspect backup**: the page reads the manifest and shows what it
  holds, what it would block (another engine or schema, an archive inside a
  folder the restore replaces, no safety-backup destination) and warns
  about. Options: the passphrase for the encrypted config or **Restore
  without config**, accepting an older schema, and whether to release the
  barrier at the end. The review needs the installation id typed exactly
  before **Restore now** is enabled. A wrong passphrase fails during
  planning and nothing has changed. The result lists the safety backup, the
  set-aside folders, interrupted operations (marked, not resumed), the
  secrets to enter again, and the three separate steps to come back
  (release the barrier, check, resume).
- **Reset...** (scope, backup, confirm, run). Scope is one feature, a
  scope of data or the instance; the page shows the preview from
  `GET /manager/api/reset/plan`. The run enters a maintenance window
  (`maintenance.enter`), runs `data.reset` with the held barrier and, if it
  fails, releases the barrier it took and says why. The instance scope needs
  a local or recovery session (`INSTANCE_RESET_REQUIRES_LOCAL`); otherwise
  the page prints `node apps/manager/cli.js reset --scope instance`.
- **Migration...** shows the migration state and rollback limit, and on the
  manager page a preflight form. The target URL is typed into a password
  field, sent once to `POST /manager/api/migrate/preflight`, cleared from
  the page and never kept in the manager's records. The copy and cutover are
  the CLI commands the page prints.

A **barrier panel** appears on the maintenance page whenever a maintenance
barrier is held, and on the result of a restore or reset. It says plainly
that **releasing the barrier does not resume the instance**: resuming is a
separate, explicit step. If the barrier recorded that changes had begun
(`mutateBegun`), the **Release** button stays disabled until the
acknowledgement box is ticked. A stale barrier is never released by the page
on its own; it prints the CLI commands (`node apps/manager/cli.js release`,
or `release --force --acknowledge-mutation`).

**From the portal.** The Host room's **Maintenance** page shows the same
journeys, with limits: a restore ends the browser's connection (the portal
refuses changes while a restore runs and is restarted at the end), so the
page says where to continue - the manager page - before it starts; Reset
and the Migration preflight are shown as command-line or manager-page only,
because the maintenance barrier would stop the portal that is serving them.

Secrets: a passphrase and a database URL live in the page's state only.
They are never in the URL, `sessionStorage`, `localStorage`, a plan, a
journal line, an audit row or an operation record, and the page clears them
when you leave the step.

## Credentials, sessions and restarts

- The setup credential is printed by the manager on its first start
  (`data/manager/bootstrap-credential`) and expires in 15 minutes. A stale
  one is refused and the page shows the command that mints another:
  `node apps/manager/index.js --mint-bootstrap`.
- Claiming or unlocking sets an **HttpOnly, SameSite=Strict cookie**
  (`goobster-manager-session`, path `/manager`, `Secure` over HTTPS). Script
  in the page cannot read it, and it is accepted only when the request has no
  `Authorization` header. Each change carries a fresh single-use nonce the
  page generates. **End this setup session** on the last step
  (`POST /manager/api/session/logout`) clears it and the page's answers.
- A session lasts 15 minutes and lives in the manager's memory. **A manager
  restart ends it.** The page shows "The manager is not answering. It may be
  restarting", keeps trying, and when the manager is back asks for a recovery
  credential with the exact command
  (`node apps/manager/index.js --mint-recovery`). Unlocking returns to the
  step you were on; non-secret answers are still there.
- Recovery credentials work only from the machine itself. A **network**
  visitor can claim with the setup credential, then use the session cookie;
  the manager listens on loopback unless LAN mode with TLS is configured
  (`documentation/manager.md`, Transport). On a machine with no screen,
  forward the port (`ssh -L 3400:127.0.0.1:3400 <host>`) and open
  `http://127.0.0.1:3400/manager/` locally; the Welcome step has this under
  "This machine has no screen".

## Secrets

- A secret (an API key, the Discord token, the owner's password) is typed
  once into a field that never shows it again. It is sent once, to the same
  origin, in the operation's private input, and the manager writes it to the
  settings file with restricted permissions.
- It is never in the URL, the browser's history state, `localStorage`,
  `sessionStorage` or a cookie (the non-secret answers are kept in the
  tab's `sessionStorage` so Back, Forward and a reload keep them), never in a plan, a journal line or an audit
  row, and never echoed back: after a key is saved the page shows only that it
  is set and, for keys that have one, the last characters.
- When a plan fails validation the non-secret answers stay filled and the
  secret fields are empty with a visible "enter it again" note, because the
  page drops a secret as soon as it has been sent.
- In the portal the same fields call the Host routes; the password of the
  owner account is created only by the manager, in a child process, from its
  own input.

## The first-run check

Starting a program is not the same as it working. The check lists, with a
pass or fail and a hint for each: the settings file, the feature
selection, the database (it opens), the owner account (an operator exists),
the application processes (each healthy and running the current revision),
and the web portal (its health check answers). **Open Goobster** stays
disabled until the last two pass.

## Headless alternative

Everything the wizard does is available without a browser:
`node apps/manager/cli.js install --answers <file>`
(`documentation/manager_install.md`, The CLI), plus `reconfigure`, `repair`
and `uninstall`. The wizard's answers map one for one to that file.

## Audit

Applying an installation operation from the portal writes one
`operator_audit` row, `host.install.apply`, with the operation, layout,
feature ids and whether data was kept - never a path, a value or a secret.
From the manager's own page the manager's operation journal is the record;
starting, stopping and creating the owner are journaled as
`manager.lifecycle.start`, `manager.lifecycle.stop` and
`manager.owner.create` and reconciled into `operator_audit` like any other
manager operation.

## What is not here yet

- **A PostgreSQL server the installer installs as a native package**: shown,
  disabled, with "Available in a later version of this installer". An
  existing server ([database_connection.md](database_connection.md)) and a
  Docker container the installer manages
  ([docker_postgres.md](docker_postgres.md)) are supported.
- **Registering Goobster as a service** from the page. On Linux the
  bootstrapper registers a systemd service as part of the install
  ([linux_install.md](linux_install.md)) and the finished page says whether it did
  or shows the command that starts the manager by hand; elsewhere (#331, #332)
  the plan still says "Starts at boot: No" and the first-run page starts the
  workers from the manager, so after a reboot start the manager again.
- **A backup scheduler.** Backups are taken on demand from the Backup
  journey or `goobster-manager backup`.
- Moving the program or data folder, network download and archive
  sources, and production signing keys (#341).
- The wizard reads provider and identity settings the way each service does
  today; a payload layout in which the application reads its settings from a
  different folder than the manager is a packaging decision for #331 onward.

## Tests

`tests/managerStatic.test.js`, `tests/installRoutes.test.js`,
`tests/managerServer.test.js`, `tests/hostRoutes.test.js` and
`tests/frontendChunks.test.js` cover the server side and the bundle's labels.
`e2e/setupWizard.spec.js` (harness `e2e/setupHarness.js`) drives a real
manager, the real standalone worker and a fake Ollama through every journey
in a browser: a new install through a first chat, stale credentials, a
manager restart, reload and Back/Forward during an install, failed probes
and plans that keep non-secret answers, reconfigure, repair, both uninstall
choices, the portal entry points (a member is refused), a 360 px screen, and
each starting state above. `e2e/maintenance.spec.js` covers the four
journeys on the manager page and the Host Maintenance page: a backup whose
archive and records never contain the passphrase, inspecting and restoring
with a wrong passphrase, the confirmation, the barrier release with
acknowledgement and a restore without config, a reset that is refused with
the barrier released again, the instance scope pointing at the command line,
the migration status and a preflight whose URL is not retained, and a member
refused by the Host proxies. `e2e/databaseWizard.spec.js` drives the Database
step, the Database journeys and the Host Database page (the PostgreSQL parts
only when a server is configured). `e2e/dockerPostgres.spec.js` drives the
Docker choice (disabled with the reason, enabled with the form and preview)
and the Host card against a fake `docker` executable.
