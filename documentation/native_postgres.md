---
title: Native PostgreSQL on this machine, managed by the installer (installer P4.7)
kind: reference
summary: How the installer installs the PostgreSQL 17 packages and creates one PostgreSQL cluster of its own on a supported Linux host when you explicitly choose it - the supported distributions and architectures, the host check (GET /manager/api/native/status, goobster-manager database native status), the PostgreSQL project's apt and dnf repositories pinned by signing-key fingerprint, the cluster, service and data directory it creates beside any cluster that already exists (which is never touched), the operation kinds database.native.provision, start, stop, repair and relocate, the closed privileged operations package.install and postgres.cluster.create, control, remove and relocate, how the application role is created from a SCRAM-SHA-256 verifier so no password is ever on a command line, the staged key GOOBSTER_NATIVE_DB_URL and the cutover through database.connect, the readiness gate, uninstall scopes (cluster and data kept by default, packages always kept), failure codes with remedies, the real-distro CI matrix and the limits.
when: Choosing PostgreSQL on this machine in the setup wizard or on the Database page; running goobster-manager database native; explaining DISTRO_UNSUPPORTED or PACKAGES_NOT_APPROVED or PORT_IN_USE or DATA_DIRECTORY_IN_USE or RECORD_MISMATCH or BACKUP_TOOLS_MISMATCH or MAJOR_UPGRADE_IS_MANUAL or DATABASE_NOT_READY; deciding what an uninstall removes; moving the data directory; changing the privileged helper's postgres operations; reasoning about where the database password lives and why the helper never sees it.
tags: [installer, manager, postgres, native, apt, dnf, pgdg, systemd, privileged-helper, pgvector, provisioning, lifecycle, wizard, host-room, cli, secrets]
---

# Native PostgreSQL on this machine, managed by the installer

Installer Phase 4 item 5, native part (issue #340). It is the counterpart of
[docker_postgres.md](docker_postgres.md) for a machine where you would rather
run PostgreSQL as an ordinary system service than in a container. It extends
[database_connection.md](database_connection.md) (the probe, the provisioning
library, `database.connect`, the chooser) and uses the manager's operation
engine ([manager.md](manager.md)), the privileged helper
([linux_install.md](linux_install.md)), the maintenance barrier
([maintenance_barrier.md](maintenance_barrier.md)) and the backup service
([backup_and_restore.md](backup_and_restore.md)).

**It is opt-in and it needs administrator rights.** Nothing here runs unless you
choose **PostgreSQL on this machine (managed by this installer)** in the
Database step, or run `goobster-manager database native provision`. The
installer never installs a database because it found a package manager, and it
never changes a PostgreSQL cluster it did not create. Installing packages and
creating a cluster are done by the privileged helper, which the manager reaches
with `sudo -n` (or `pkexec` when a display is present), or directly when the
manager runs as root. When none of those can work without a password prompt the
option is shown disabled with the reason (`ELEVATION_UNAVAILABLE`).

**What it is not.** It is not a replacement for an existing server (use
[database_connection.md](database_connection.md)), not the distribution's own
`main` cluster (never adopted, never changed), not a PostgreSQL major upgrade
(manual, below), not backup scheduling, not a Windows or macOS service and not a
way to manage a cluster somebody else made.

## Supported hosts

| Distribution | Versions | Architectures | Package manager |
|---|---|---|---|
| Debian, Raspberry Pi OS (64-bit) | 12 (bookworm) | x86-64, arm64 | `apt` |
| Ubuntu | 22.04 and later (24.04 tested) | x86-64, arm64 | `apt` |
| AlmaLinux, Rocky Linux | 9 | x86-64, arm64 | `dnf` |

Everything else is refused before anything changes, with a reason that names the
way out: `DISTRO_UNSUPPORTED`, `DISTRO_VERSION_UNSUPPORTED`, `ARCH_UNSUPPORTED`
(32-bit Raspberry Pi OS cannot install PostgreSQL's packages) or
`OS_UNSUPPORTED` (Windows and macOS). The way out is an existing server, the
Docker option or SQLite. On a Red Hat family host systemd must be running
(`SYSTEMD_UNAVAILABLE`); on Debian family hosts without systemd (a container)
the cluster is created and started through `pg_ctlcluster` and a note says it
will not start at boot.

PostgreSQL **17** is the one major the installer manages (`packages/core/db/native/pgdg.js`,
`MAJOR`). It is in none of those distributions' own repositories, so the packages
come from the PostgreSQL project's repository (below).

## The check

`GET /manager/api/native/status` and `goobster-manager database native status`
run the same read-only check. It never installs, creates, starts or elevates
anything and runs only read commands (`pg_lsclusters`, `dpkg-query`, `rpm`,
`apt-cache policy`, `systemctl`, `findmnt`, `df`, `ss`, `pg_dump --version`,
`getenforce`). It reports:

| Fact | Notes |
|---|---|
| Host | distribution, version, architecture, whether the option is supported here and, if not, the code and remedy |
| Packages | server, client, pgvector and contrib: installed (and the version) or where they would come from (`via-pgdg`) |
| Clusters | every PostgreSQL cluster on the machine with its port and state, and which of them this manager owns |
| systemd | whether it is running; on a Red Hat host a block when it is not |
| SELinux | enforcing or permissive; the installer labels the data directory and port when it is on |
| Backup tools | the host's `pg_dump` against the server major (below) |
| Storage | with `?storage=<absolute path>`: whether that folder exists or can be created, its free space, its mount, whether the `postgres` account can reach it |
| Elevation | whether a privileged helper can run here (root, `sudo -n`, `pkexec`) |
| Names | the cluster, service and data directory this installation would use |
| Record | what this manager owns once provisioned: step, port, bind, role, database, data directory |

The Host room proxies it as `GET /api/app/admin/host/native/status`. No password,
URL or environment value is in any of these answers.

## Packages: the PostgreSQL project's repository, pinned

`packages/core/db/native/packages.js` is the one table of package names:

| Family | Packages the installer may install |
|---|---|
| Debian, Ubuntu | `postgresql-17`, `postgresql-common`, `postgresql-client-17`, `postgresql-17-pgvector` (plus `ca-certificates`, `curl`, `gnupg` to add the repository on a bare host) |
| AlmaLinux, Rocky | `postgresql17-server`, `postgresql17`, `postgresql17-contrib`, `pgvector_17` (plus `gnupg2`, and `policycoreutils-python-utils` when SELinux is on) |

The helper accepts only these names (`PACKAGE_NOT_ALLOWED` for anything else).
Installing them is a download from the network, so it needs your approval:
`installPackages: true` (the "install the packages" tick). Without it the plan
says what would be installed and from where and stops with
`PACKAGES_NOT_APPROVED`. Packages that are already installed are not installed
again, and a host with all of them present installs nothing.

**The repository is added only from what is pinned in code.** `pgdg.js` holds, for
each family and architecture, the signing key's URL **and its full
fingerprint**, checked on 2026-10-07 against the repository metadata's
signatures. The helper downloads the key, refuses it unless `gpg` reports
exactly the pinned fingerprint and only then writes the repository definition
(`/etc/apt/sources.list.d/goobster-pgdg.sources` with
`/etc/apt/keyrings/goobster-pgdg.asc`, or `/etc/yum.repos.d/goobster-pgdg17.repo`
with `/etc/pki/rpm-gpg/goobster-PGDG-RPM-GPG-KEY`) with that key as its only
trusted signer. A key that changed upstream is a refusal, not silent trust
(`PGDG_KEY_MISMATCH`). On a Red Hat host the distribution's `postgresql`
module is disabled so the packages resolve to PGDG's. Moving a pin means
repeating the fingerprint check.

**Packages stay installed** when the database is later removed. The installer
does not remove software it added, and the repository file stays.

## What is created, and what is never touched

For installation id `aa7e9443-…`, with no other cluster named `goobster`:

| Resource | Debian family | Red Hat family |
|---|---|---|
| Cluster | `17/goobster` | `goobster` |
| Service | `postgresql@17-goobster.service` (the distribution's template, a drop-in adds the mount dependency) | `postgresql17-goobster.service` (a unit the installer writes) |
| Configuration | `/etc/postgresql/17/goobster/` (`conf.d/goobster.conf`, `pg_hba.conf`) | `<data directory>/conf.d/goobster.conf`, `pg_hba.conf` |
| Data directory | `/var/lib/postgresql/17/goobster` (or the folder you choose) | `/var/lib/pgsql/17/goobster` (or the folder you choose) |

If a cluster called `goobster` already exists and is not this installation's,
the name becomes `goobster-<id8>` (the first eight hex digits of the
installation id) and the plan notes why (`CLUSTER_NAME_CHOSEN`). A cluster
cannot have two names, and nothing else the installer could produce collides
with those two shapes.

Ownership is checked on both ends. The manager writes
`native-postgres.json` in its store **before** it asks for anything, and the
helper reads that record and refuses unless it names the same installation,
cluster and data directory (`RECORD_MISMATCH`, `INSTALLATION_MISMATCH`). The data
directory carries a marker file, `goobster-installation`, holding the
installation id; the helper changes or removes only a directory with that
marker, and a directory that holds another database is refused
(`DATA_DIRECTORY_NOT_EMPTY`, `DATA_DIRECTORY_IN_USE`). The helper never runs
`ALTER SYSTEM`, never edits `postgresql.conf` or `pg_hba.conf` of a cluster that
is not ours, never touches a distribution `main` cluster and never reaches a
cluster by a name it did not derive itself. **A cluster that is not ours is left
byte for byte as it was**; the tests check this through provision, start, stop,
repair, relocate and uninstall.

**Listen address and port.** The default is `127.0.0.1:5432`. If the port is
taken, by another cluster or by anything that listens, the plan names it
(`PORT_IN_USE`) and proposes the next free port; the distribution's own `main`
cluster usually holds 5432, so the new cluster typically lands on 5433. A bind
address other than loopback exposes the database to the network with a generated
password and no TLS: it needs `acknowledgeLanBind` (otherwise
`LAN_BIND_NOT_ACKNOWLEDGED`), `pg_hba.conf` then allows the role from the same
subnet only, and the installer opens no firewall port.

**Storage.** The data directory is an absolute path of at most 200 characters
with letters, digits and `. _ + - /` only. The operating system's own trees
(`/etc`, `/usr`, `/var/lib/dpkg`, …) and places the system cleans (`/tmp`, `/run`,
`/var/cache`, …) are refused (`PATH_NOT_ALLOWED`), as is the distribution's own
data directory (`DATA_DIRECTORY_IS_DISTRIBUTION`) and anything overlapping
another cluster's (`DATA_DIRECTORY_OVERLAPS`). An existing non-empty directory
is `STORAGE_NOT_EMPTY`: the installer builds a new database and never adopts
files whose password it does not know. The check also needs 1 GiB free
(`STORAGE_FULL`), a local writable file system (`FILESYSTEM_*`; an overlay file
system is noted, since its data lives only as long as the container), a mount
that is listed in `/etc/fstab` (`MOUNT_NOT_IN_FSTAB`, accepted with
`acknowledgeMount`) and a path the `postgres` account can enter
(`STORAGE_UNREACHABLE`).

## The operation kinds

All five are public kinds, available to the setup credential, a local or bridge
session and the recovery credential; the Host room runs them through its Host
proxies as `host.database.apply` (the apply timeout for these kinds is 30
minutes, since a package download is not quick).

### `database.native.provision`

Steps: **preflight → packages → cluster → schema → verify-database**.

1. *preflight*: runs the host check again; any block stops here.
2. *packages* (`package.install`): adds the PGDG repository when a package comes
   from it and installs what is missing, only when `installPackages` is set.
3. *cluster* (`postgres.cluster.create`): creates the cluster (Debian:
   `pg_createcluster`; Red Hat: `initdb` and the unit), writes the managed
   configuration, creates the application role and its database, the `citext` and
   `vector` extensions and the grants through `psql` as the `postgres` operating
   system user over the local socket, and starts the cluster.
4. *schema*: connects as the application role with the generated password and
   applies Goobster's schema.
5. *verify-database*: probes the application connection (the extensions, the
   schema and the role's rights).

Input: `port` (default 5432), `bind` (default `127.0.0.1`), `acknowledgeLanBind`,
`dataDirectory`, `role` and `database` (default `goobster`), `installPackages`,
`acknowledgeBackupTools`, `acknowledgeMount`. No password is an input. The
application role is created `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`; it owns
its database and nothing else, and the `postgres` superuser's password is never
set or known (the helper reaches it by peer authentication on the local socket).

Provisioning **does not connect the installation**. It stages the application's
URL and stops. The connection changes in one place:

```bash
# answers: { "command": "database", "connection": { "owned": "native" }, "release": true }
goobster-manager database connect --answers connect.json
```

`database.connect` with `{ owned: "native" }` takes the maintenance barrier,
reuses the staged URL, validates the application on the target, writes
`GOOBSTER_DB_URL`, updates the installation record and removes the staged key. A
SQLite installation that holds data is routed to the migration
(`MIGRATION_REQUIRED`), exactly as for an existing server. A fresh installation
that chose this option in the wizard does all of it in one `install.new`: the
install gains a `native-postgres` step after `ownership` and uses the new
database from its first start. Without a provisioned database the answer is
`NO_NATIVE_DATABASE`. A second provision over a verified database is refused
(`ALREADY_PROVISIONED`).

Provision is resumable. The record advances through `planned → packages →
cluster → provisioned → schema → verified`; run it again after an interruption
and it continues with its own cluster (the plan says `RESUME`), skipping what is
done. Packages are not downloaded twice and the cluster is not created twice.
Every helper operation is idempotent: a second `postgres.cluster.create` for the
same installation resumes (`resumed`), a repeat of a finished one is a `noop`.

### `database.native.start`, `.stop`

Start or stop the cluster's service by name (`pg_ctlcluster` on Debian family,
`systemctl` on Red Hat). Both are idempotent: starting a running cluster or
stopping a stopped one succeeds and reports `changed: false`. Stopping while the
installation is connected to it is refused (`DATABASE_IN_USE`) unless
`acknowledgeInUse` is set, because the workers would lose their database. Neither
changes data.

### `database.native.repair`

Plans exactly what is wrong and does only that: if the cluster is stopped or has
drifted (its port differs from the record, or on Red Hat its unit is missing) it
converges the managed configuration over the **same data** and starts it; if
nothing is wrong it does nothing (`action: none`). The data directory is never
recreated and no role or password changes. It refuses, with a block, when:

- the PostgreSQL server package is gone (`SERVER_PACKAGE_MISSING`);
- on a Debian family host the cluster's configuration has vanished
  (`CLUSTER_MISSING`): the installer does not re-adopt a data directory it can
  no longer describe, so restore from a backup or remove the record by
  uninstalling with `removeNativeData`;
- on a Red Hat family host the data directory is gone (`DATA_MISSING`): a new
  cluster would start empty;
- the recorded major no longer matches the pin (`MAJOR_UPGRADE_IS_MANUAL`);
- the distribution family changed (`DISTRO_CHANGED`).

### `database.native.relocate`

Moves the data directory. It is a data-affecting change and follows the same
pattern as the maintenance journeys
([maintenance_barrier.md](maintenance_barrier.md)):

- the maintenance barrier must be held (`maintenance.enter` first; pass its
  `maintenance: { operationId, fence }`, otherwise `MAINTENANCE_REQUIRED` or
  `MAINTENANCE_NOT_HELD`) and every writer must have acknowledged the fence;
- a **verified backup** is taken first (`backup: { dir, passphrase, skipConfig }`;
  the backup service's `createBackup` then `verifyBackup` against the table
  counts), and a failed or unverified backup stops the move with nothing changed
  (`BACKUP_FAILED`, `BACKUP_UNVERIFIED`; `BACKUP_REQUIRED` if none is given); the
  passphrase is a secret and is never recorded;
- *relocate* (`postgres.cluster.relocate`) stops the cluster, copies the data
  directory to `target`, checks the copy, points the cluster at it and starts it;
  *verify-database* waits for it to accept connections. The barrier stays up and
  the result says the next step is `maintenance.release`.

**The original directory is kept.** The move copies, it does not delete. If the
copy is interrupted, the original is still the cluster's data directory and still
serves; repeating the operation completes it (a finished move is a `noop`). Remove
the old directory yourself once you are satisfied. The target obeys the storage
rules above (`ALREADY_THERE` and `DATA_DIRECTORY_OVERLAPS` for the same or a
containing directory).

## The privileged operations

The manager never runs `apt-get`, `dnf` or `pg_createcluster` itself. It sends one
of five operations to the helper (`apps/manager/privileged/protocol.js`, the
closed list of the helper's protocol version 1), each validated field by field
before anything runs and implemented in `privileged/linux.js`:

| Operation | Does |
|---|---|
| `package.install` | installs names from the closed table, adding the pinned PGDG repository when asked |
| `postgres.cluster.create` | creates or converges (`mode: converge`) the cluster, its configuration, the role (from a SCRAM verifier), database, extensions and grants, and starts it |
| `postgres.cluster.control` | `start` or `stop` of this installation's cluster |
| `postgres.cluster.remove` | stops the cluster; with `removeData` drops it and deletes its marked data directory |
| `postgres.cluster.relocate` | copies to a new directory and switches the cluster to it |

Their audit rows are `manager.privileged.postgres.cluster.create|control|remove|relocate`
(and the existing package action); a row carries the operation name, the
installation and the outcome, never a path with a secret, a password, a URL or an
address. The helper may load only its own hashed files, so it cannot import the
manager's libraries; `linux.js` therefore carries its own copies of the package
table, the PGDG pins and the path rules, and `tests/nativePostgresAdapters.test.js`
fails when a copy drifts from `packages/core/db/native/`.

Installing packages and building a cluster can run long; the manager passes a
per-operation timeout through to the helper (30 minutes for packages, 15 for a
cluster, 60 for a relocation) in place of the helper's 120 second default.

## Passwords

One password exists, the application role's. It is generated (24 random bytes,
URL-safe) by the manager and held in the operation's in-memory `privateInput`
(so a manager restart mid-operation is `PLAN_INPUT_LOST` and the operation is
planned again).

- **The helper never receives it.** The manager computes a **SCRAM-SHA-256
  verifier** (RFC 5802/7677, a random salt, 4096 iterations) and sends only that.
  The role statement `CREATE ROLE … PASSWORD 'SCRAM-SHA-256$…'` reaches `psql`
  on **stdin**; a verifier cannot be used to log in, and nothing sent to `psql`
  or any other program carries the password or a URL containing it.
- **It is stored in one place**, the manager's environment overlay
  (`apps/manager/environment.js`, mode `0600`), as part of `GOOBSTER_DB_URL`
  after the cutover and, between provision and cutover, as the staged key
  `GOOBSTER_NATIVE_DB_URL`. The staged key is read by the cutover and is never
  merged into the environment a worker sees; the cutover removes it.
- **Nowhere else**: not `native-postgres.json` (mode `0600`, names, port, bind,
  data directory, role, database, step), not the operation record, the journal or
  the audit log, not a plan, a result or the CLI's output and not any program's
  argument. The audit row carries the cluster and service names, the major, the
  mode and counts, never a host, port, user, path or URL. The tests search every
  recorded argv and stdin, the store, the journal, the audit log and the
  responses for the password and the URL.

Because the application URL stays in the overlay, a later migration or
relocation never asks for it again.

## The readiness gate

A workers' start must not race a database that is still starting after a reboot.
When the installation is connected to the native database it owns, the supervisor
asks `apps/manager/native/readiness.js` before it starts the workers: it asks
`pg_isready` about the recorded loopback port (or opens a TCP connection when
that program is absent) for up to a minute. If the database is not ready the
worker is not started: its slot shows the state `conflict` with the code
`DATABASE_NOT_READY` and the reason (`NOT_LISTENING`, `STARTING`), and the manager
tries again after the usual conflict delay. With no native record, or an
installation that is not connected to the owned port, the check is inert and
runs no command.

## Backup tools

`pg_dump` refuses a server newer than itself, and Goobster's backups run the
host's `pg_dump`. The check compares it with the server major: an equal or newer
client is fine, an older one is `BACKUP_TOOLS_MISMATCH`, a missing one
`BACKUP_TOOLS_MISSING`. When the client package is about to be installed with
the rest the plan only notes it (`BACKUP_TOOLS_WILL_BE_INSTALLED`). Otherwise the
page asks you to fix it or tick `acknowledgeBackupTools` first, because a backup of
the new database would fail. `GOOBSTER_PG_BIN` selects another directory of
PostgreSQL client tools.

## Major upgrades are manual

PostgreSQL 17's data directory cannot be started by another major. The record keeps
the major the data was created with, and `repair` refuses a record whose major no
longer matches the pin (`MAJOR_UPGRADE_IS_MANUAL`). The upgrade is a dump and
restore or `pg_upgrade` into a new cluster, the administrator's job
([postgres_setup.md](postgres_setup.md#upgrading-the-server)).

## Uninstall

The default keeps your data, as for every other database. Uninstalling with the
defaults **leaves the cluster, its data directory and its service exactly as they
are**, says so in the plan and runs no command on the machine. A delete-data
uninstall removes the data root and the manager's overlay (the only copy of the
application password), not the cluster, so the plan carries the warning
`NATIVE_DATA_RETAINED` naming the data directory until you also choose
`removeNativeData`. The packages and the repository are never removed.

`removeNativeData: true` (an `install.uninstall` input, with the installation id as
`confirm`, otherwise `CONFIRMATION_REQUIRED`; there is no wizard control for it) runs
`postgres.cluster.remove` with `removeData`: it stops and drops **this
installation's cluster only**, deletes its marked data directory and its
configuration, and removes the record. A record that belongs to another
installation (`NATIVE_RECORD_OF_ANOTHER_INSTALLATION`), an unreadable one
(`NATIVE_RECORD_UNREADABLE`) or a missing elevation (`NATIVE_ELEVATION_UNAVAILABLE`)
stops the plan. A directory without the marker is never deleted. A cluster
somebody else made is not touched. Removing the cluster does not remove the old
directory a `relocate` left behind.

## Where it shows

- **Setup wizard, Database step.** The chooser offers SQLite, an existing server,
  PostgreSQL in Docker and **PostgreSQL on this machine (managed by this
  installer)**. The native entry is enabled only when the host is supported and an
  elevation is available; otherwise it is disabled and the reason follows it.
  Choosing it shows the host check (the distribution, the packages and which would
  be installed, the clusters that already exist and that they are left alone, the
  backup tools), a form (port, listen address, data directory, the package
  approval, the acknowledgements) with live problems, and a preview of the names
  that will be created. Continue unlocks when the check passes and what it asks
  for is ticked.
- **Maintenance and Host: Database.** The Database page shows the owned cluster
  (name and state, port, data directory, whether the installation uses it) with
  **Start**, **Stop**, **Repair** and **Use it for this installation…**, and
  **Set up PostgreSQL on this machine…** when there is none. Moving the data
  directory is a command-line job (`database native relocate`).
  The Host room's page is the same journey through the Host proxy
  (`GET /api/app/admin/host/native/status`, status only; changes are operations,
  audited as `host.database.apply`).
- **CLI.**

```bash
goobster-manager database native status                         # read only
goobster-manager database native provision [--answers a.json] [--yes]
goobster-manager database native start
goobster-manager database native stop [--answers a.json]        # { "acknowledgeInUse": true }
goobster-manager database native repair
goobster-manager database native relocate --answers r.json      # target, backup, maintenance
```

With no `--answers`, `provision` asks for the port, the bind address, the data
directory and the package approval, shows the plan and asks to proceed. No
password is asked or printed. Exit codes are those of the other `database`
commands. `status` prints a summary of the check and the verdict (it exits non-zero when the
host is not supported), and works with no installation (it then says what would be
created). `relocate` needs `--answers`.

The same choice is available headlessly in `install.new`:

```json
{ "database": { "engine": "postgres", "native": { "installPackages": true, "dataDirectory": "/srv/goobster-pg" } } }
```

`database.native`, `database.docker` and `database.connection` are mutually
exclusive (`INVALID_INPUT`), and `native` applies to the `postgres` engine only.

## When it fails

| You see | It means | Do |
|---|---|---|
| `DISTRO_UNSUPPORTED`, `DISTRO_VERSION_UNSUPPORTED`, `ARCH_UNSUPPORTED`, `OS_UNSUPPORTED` | This host is not one the option supports. | Use an existing server, the Docker option or SQLite. |
| `ELEVATION_UNAVAILABLE` | No privileged helper can run without a password prompt. | Run the manager as root, or allow it passwordless `sudo` (`sudo -n`), or use another option. |
| `SYSTEMD_UNAVAILABLE` | A Red Hat host without a running systemd. | Run on a host with systemd, or use the Docker option. |
| `PACKAGES_NOT_APPROVED` | Packages would be installed and you have not agreed. | Tick "install the packages", or install them yourself first. |
| `PACKAGE_NOT_ALLOWED`, `PGDG_KEY_MISMATCH`, `PACKAGE_INSTALL_INCOMPLETE` | The helper refused a name or a key, or the package manager did not finish. | Read the message; the repository key is never trusted when it differs from the pin. |
| `PORT_IN_USE` | Another cluster or a process listens on the port. | Use the proposed free port. |
| `LAN_BIND_NOT_ACKNOWLEDGED` | A non-loopback bind address was given. | Keep `127.0.0.1`, or acknowledge. |
| `INVALID_PATH`, `PATH_NOT_ALLOWED`, `DATA_DIRECTORY_IS_DISTRIBUTION`, `DATA_DIRECTORY_OVERLAPS` | The data directory is not a place the installer builds in. | Choose a folder of its own on a local disk. |
| `STORAGE_NOT_EMPTY`, `STORAGE_FULL`, `STORAGE_UNREACHABLE`, `MOUNT_NOT_IN_FSTAB` | The chosen folder is not empty, full, not enterable by `postgres` or on an unlisted mount. | Choose another folder, free space, fix its permissions, or acknowledge the mount. |
| `DATA_DIRECTORY_NOT_EMPTY`, `DATA_DIRECTORY_IN_USE` | The helper found files or a running database in the directory that are not this installation's. | The installer will not build on them; choose another directory. |
| `RECORD_MISMATCH`, `INSTALLATION_MISMATCH`, `RECORD_OF_ANOTHER_INSTALLATION` | The record or marker belongs to a different installation. | Remove the old cluster yourself (`pg_dropcluster` or the unit file named in `native-postgres.json`), then try again. |
| `ALREADY_PROVISIONED`, `NO_NATIVE_DATABASE` | There is one already, or none. | Use start, stop, repair or relocate; or provision first. |
| `BACKUP_TOOLS_MISMATCH`, `BACKUP_TOOLS_MISSING` | The host's `pg_dump` is older than the server, or absent. | Install `postgresql-client-17` (or `postgresql17`), or acknowledge the limit. |
| `DATABASE_NOT_READY` | The workers were not started because the database is not up. | Wait; **Start** or **Repair** it from the Database page. |
| `DATABASE_IN_USE` | The installation uses the cluster you are stopping. | Stop the workers first, or acknowledge. |
| `CLUSTER_MISSING`, `DATA_MISSING`, `SERVER_PACKAGE_MISSING` | Repair cannot rebuild what is gone. | Restore from a backup, or remove the record with `removeNativeData`. |
| `MAJOR_UPGRADE_IS_MANUAL` | A different PostgreSQL major than the pinned one. | Dump and restore into a new cluster, the administrator's job. |
| `MAINTENANCE_REQUIRED`, `MAINTENANCE_NOT_HELD`, `BACKUP_REQUIRED`, `BACKUP_FAILED` | A relocation's guards. | Enter maintenance, give a backup folder, and fix the backup failure. |

## Real-distro verification

The unit tests drive the real helper as an ordinary user inside a throwaway
"machine" of fake programs (`apt-get`, `dnf`, `pg_createcluster`, `pg_ctlcluster`,
`pg_lsclusters`, `psql`, `systemctl`, …; `tests/helpers/fakeNative.js`), so they
prove what the installer asks the system to do and what it does with the answers.
They do not prove the distribution's behaviour. A real-distro job belongs in CI
(Ubuntu 24.04 on x86-64 and arm64, a Debian 12 container and a Rocky Linux 9
container) and checks, for each: a fresh provision beside an existing `main`
cluster, a custom data directory, a port conflict resolved by the next port, stop
and start, repair, a relocation, removal keeping the data and then removing it, and
that the pre-existing cluster is unchanged byte for byte.

## Risks and limits

- Installing packages as root and creating a database is a privileged act. It is
  confined to the closed operations above, re-checked by the helper against the
  manager's record and the directory's marker, and nothing is run through a shell.
- A bind address other than loopback exposes the database on the network with a
  generated password and no TLS; that is why it needs an acknowledgement.
- On a Debian family host the server package may create the distribution's own
  `main` cluster while it installs, and that cluster can take port 5432 after
  the plan checked it free. Creating the new cluster is then refused with
  `PORT_IN_USE` before anything is written; the packages stay installed, the
  `main` cluster is left as it is, and a new plan proposes the next port.
- A Debian family cluster whose configuration directory was deleted cannot be
  re-adopted; restore from a backup.
- A relocation keeps the original directory (a second copy of the data on disk)
  until you remove it.
- A host that is only partly like the supported ones (a derivative distribution)
  is refused rather than guessed at.
- The installer does not schedule backups; that is
  [backup_and_restore.md](backup_and_restore.md)'s job.

## Tests

- `tests/nativePostgresAdapters.test.js`: the distribution table, package and
  repository pins, names, path and storage rules, the SCRAM verifier, the
  inventory parsers and that the helper's copies equal the library's.
- `tests/nativePostgresHelper.test.js`: the real helper against the fake machine
  for every operation, its refusals (`PACKAGE_NOT_ALLOWED`, `RECORD_MISMATCH`,
  `PATH_NOT_ALLOWED`, `DATA_DIRECTORY_IN_USE`, …) and its idempotence.
- `tests/nativePostgresKinds.test.js`: the five kinds, the install answer, the
  uninstall scopes, the readiness gate, discovery, the secret search of every
  store and the untouched foreign cluster.
- `tests/nativePostgresRoutes.test.js`: `GET /manager/api/native/status` and the
  Host proxy over HTTP.
- `e2e/nativePostgres.spec.js`: the chooser, the form and the preview, the
  journey and the Host card, against the fake machine.
- The fake machine is `tests/helpers/fakeNative.js` (and `fakeNativeCli.js`).
