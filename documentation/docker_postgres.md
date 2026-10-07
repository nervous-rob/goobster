---
title: PostgreSQL in Docker, managed by the installer (installer P4.6)
kind: reference
summary: How the installer creates and looks after one PostgreSQL container for an installation when you explicitly choose it - the Docker daemon check (CLI, daemon, socket permission, Docker Desktop or Engine, platform, the pinned image, the host pg_dump), the digest-pinned pgvector/pgvector:pg17 image and why a major upgrade is manual, the three owned resources and their labels (container goobster-pg-<id8>, volume goobster-pgdata-<id8>, network goobster-<id8>), the operation kinds database.docker.provision, start, stop, repair and reconfigure, how passwords are generated and where they are and are not kept, the cutover through database.connect, the readiness gate (DATABASE_NOT_READY), uninstall scopes (data kept by default), the route GET /manager/api/docker/status, the CLI, the wizard and Host pages, failure codes with remedies, the real-Docker tests and the limits.
when: Choosing PostgreSQL in Docker in the setup wizard or on the Database page; running goobster-manager database docker; explaining DOCKER_* or RESOURCE_FOREIGN or DATABASE_NOT_READY or BACKUP_TOOLS_MISMATCH; deciding what an uninstall removes; moving the pinned image; changing the provision, repair or reconfigure operation; reasoning about where the database passwords live.
tags: [installer, manager, postgres, docker, container, pgvector, provisioning, lifecycle, wizard, host-room, cli, secrets]
---

# PostgreSQL in Docker, managed by the installer

Installer Phase 4 item 5, Docker part (issue #339). It extends
[database_connection.md](database_connection.md) (the probe, the provisioning
library, `database.connect`, the chooser) and uses the manager's operation
engine ([manager.md](manager.md)), the maintenance barrier
([maintenance_barrier.md](maintenance_barrier.md)) and the backup service
([backup_and_restore.md](backup_and_restore.md)).

**It is opt-in.** Nothing here runs unless you choose **PostgreSQL in Docker
(managed by this installer)** in the Database step, or run `goobster-manager
database docker provision`. The installer never starts a container because it
found Docker, and it never touches a container it did not create. This is
different from [docker_deployment.md](docker_deployment.md), which is the
hand-run compose profile (Postgres, bot, api and nginx together): the managed
instance is one container for the database only, started and checked by the
manager, while Goobster itself still runs as the manager's own workers.

**What it is not.** It is not a native PostgreSQL install (listed in the
chooser as "Available in a later version of this installer"), not a
PostgreSQL server upgrade (a major upgrade is manual, below), not a way to
manage a container somebody else made, not Docker Desktop's remote contexts
and not the Windows-containers mode.

## The check

`GET /manager/api/docker/status` and `goobster-manager database docker
status` run the same read-only check. It never pulls an image and never
creates, starts or stops anything. It reports:

| Fact | Notes |
|---|---|
| Docker CLI | present and its version, or `DOCKER_CLI_MISSING` |
| Daemon | reachable (`docker info`), the server version, Engine or Docker Desktop, rootless or not; otherwise `DOCKER_DAEMON_UNREACHABLE`, `DOCKER_PERMISSION_DENIED` or `DOCKER_DAEMON_TIMEOUT` |
| Socket | the path, whether it exists and whether this user may use it |
| Platform | the daemon's OS and architecture against the published image (`linux/amd64`, `linux/arm64`); a Windows-containers daemon is `CONTAINER_OS_UNSUPPORTED`, another architecture `ARCH_UNSUPPORTED`, an Engine older than the minimum `DOCKER_ENGINE_TOO_OLD` |
| Image | the pinned reference, whether it is already on this machine and, if not, how many bytes a pull downloads |
| Backup tools | the host's `pg_dump` against the container's server major (below) |
| Storage | with `?storage=<absolute path>`: whether that folder exists or can be created, and its free space |
| Verdict | `blocks` (stop), `warnings` (read them) and `notes`, each with the next thing to do |

A remote daemon (`DOCKER_HOST` set to `tcp://` or `ssh://`) is refused
(`DOCKER_HOST_REMOTE`): a bind mount or a published port would mean something
different on another machine, and the manager cannot check it. Docker Desktop
is accepted with a note that a host folder must be shared with it. Rootless
Docker is accepted with a note that binding a port below 1024 needs setup.
`GOOBSTER_DOCKER_BIN` selects another `docker` executable; `DOCKER_HOST`,
`DOCKER_CONTEXT` and `DOCKER_CONFIG` are honoured as the CLI honours them.

**Permission denied is never fixed with `sudo`.** The remedy the page gives is
to add the manager's user to the `docker` group (and sign in again) or to use
rootless Docker.

## The image pin

`packages/core/db/docker/image.js` is the one place the image is named:
`pgvector/pgvector:pg17`, referenced **by digest**
(`pgvector/pgvector@sha256:ac08…a75d`, the multi-platform index for
`linux/amd64` and `linux/arm64`), resolved on 2026-10-07 to PostgreSQL 17.11.
The tag is shown to people and recorded for them; only the digest is passed to
`docker run`, so a tag that moves tomorrow cannot change what the installer
starts. The image carries `vector` (pgvector) and `citext` (PostgreSQL
contrib), the two extensions Goobster requires, and the server major (17) is
above the minimum Goobster supports (13).

To move the pin to a newer minor of the same major, resolve the tag again
(`docker buildx imagetools inspect pgvector/pgvector:pg17`), change `DIGEST`
and `POSTGRES_MINOR`, and run the Docker CI job. A **different major** is
`MAJOR_UPGRADE_IS_MANUAL`: a PostgreSQL data directory written by one major
cannot be started by another, so `reconfigure` with a `major` is refused, and
`repair` refuses to recreate a container over data that an instance of
another major wrote (the record keeps the major the data was created with).
The upgrade is a dump and restore or `pg_upgrade`, the administrator's job
([postgres_setup.md](postgres_setup.md#upgrading-the-server)).

**Backup tools.** `pg_dump` refuses a server newer than itself. The check
compares the host's `pg_dump` with the pinned server: an equal or newer client
is fine, an older one is `BACKUP_TOOLS_MISMATCH` and a missing one
`BACKUP_TOOLS_MISSING`. Neither blocks creating the database, but a backup of
it would fail, so the page asks you to fix it or to tick an acknowledgement
(`acknowledgeBackupTools`) first, and the Docker operations that need a backup
(`reconfigure`) refuse until it works.

## What is created, and what is never touched

For installation id `aa7e9443-…` the manager uses exactly these names:

| Resource | Name | Role label |
|---|---|---|
| Network | `goobster-aa7e9443` | `postgres-network` |
| Volume | `goobster-pgdata-aa7e9443` (or a host folder you choose) | `postgres-data` |
| Container | `goobster-pg-aa7e9443` | `postgres` |

Every resource carries `io.goobster.installation=<the whole installation id>`,
`io.goobster.role=<role>` and `io.goobster.manager=1`. A command that changes
a resource names it exactly and reads its labels first; a resource that has
the name but not the labels is somebody else's and the operation stops with
`RESOURCE_FOREIGN` without touching it. The runner refuses `prune`, `--all`,
`-a` and `--filter` on any command that changes something, so nothing the
installer runs can reach a resource it does not name. The list of resources
the installer owns is read from labels only.

The container publishes `<bind>:<port>` to the database's port. The default is
`127.0.0.1:5432`: reachable from this machine only. If the port is taken, the
check names it (`PORT_IN_USE`) and proposes the next free port. Any other
bind address (the machine's LAN address or `0.0.0.0`) needs an explicit
acknowledgement (`acknowledgeLanBind`) because the database would be reachable
from other machines; the plan says so. The container restarts unless stopped
(`--restart unless-stopped`), has a `pg_isready` health check and an optional
memory limit (`memoryMb`).

**Storage.** The default is a Docker volume (`goobster-pgdata-<id8>`). You may
instead give an absolute folder: it is created if missing, its free space is
checked, and on Docker Desktop the check notes that the folder must be shared.
The installer **never deletes** a folder you chose. A folder that already holds
a PostgreSQL data directory is refused (`STORAGE_HAS_DATA`) at provision: the
installer will not adopt data whose password it does not know.

## The operation kinds

All five are public kinds, available to the setup credential, a local or
bridge session and the recovery credential; the Host room runs them through
its Host proxies as `host.database.apply`.

### `database.docker.provision`

Steps: **preflight → create → wait-healthy → provision → verify**.

1. *preflight*: runs the check again; any block stops here. A pull needs your
   approval (`pull: true`; `IMAGE_PULL_NOT_APPROVED` otherwise) because it
   downloads about 160 MB.
2. *create*: the network, the volume (or the folder), then `docker run`. The
   record in `docker-postgres.json` advances to `container` **before**
   `docker run`, so an interruption leaves a state a second run can read.
3. *wait-healthy*: polls the container's health until `healthy`
   (`HEALTH_TIMEOUT`, `CONTAINER_EXITED` and `CONTAINER_UNHEALTHY` are the
   failures; the message names the container so you can read `docker logs`
   yourself, and no log text is copied into a record).
4. *provision*: creates the application's role and database, the `citext` and
   `vector` extensions, the schema and the grants through the #338 library
   (`database.provision`'s actions), as the superuser, once.
5. *verify*: connects as the application role with the generated password,
   checks the extensions and applies Goobster's schema.

Input: `port` (default 5432), `bind` (default `127.0.0.1`),
`acknowledgeLanBind`, `storage` (`{ kind: "volume" }` or `{ kind: "path",
path }`), `role` and `database` (default `goobster`), `memoryMb`, `pull`,
`acknowledgeBackupTools`. No password is an input.

Provisioning **does not connect the installation**. It stages the
application's URL and stops; the connection changes in one place, the
cutover:

```bash
# answers: { "command": "database", "connection": { "owned": "docker" }, "release": true }
goobster-manager database connect --answers connect.json
```

`database.connect` with `{ owned: "docker" }` takes the maintenance barrier,
reuses the staged URL (so nothing about the database is typed again), validates
the application on the target, writes `GOOBSTER_DB_URL`, updates the
installation record and removes the staged key. A SQLite installation that
holds data is routed to the migration (`MIGRATION_REQUIRED`), exactly as for an
existing server ([database_connection.md](database_connection.md#the-cutover-rules)).
A fresh installation that chose Docker in the wizard does all of it in one
`install.new`: the install gains a `docker-postgres` step after `ownership`
and uses the new database from its first start.

Provision is resumable. Run it again after an interruption and it reads the
record (`planned → network → volume → container → healthy → provisioned →
schema → verified`) and the labelled resources, reuses what is yours and
recreates what the interruption left half done. A Docker volume that the
interrupted run initialised is removed and made again (only that labelled
volume, and only before anything else could have used it). A folder you chose
that holds the initialised data directory is refused (`STORAGE_INITIALISED`)
because the superuser password it was started with was lost with the
interrupted run and the installer never deletes your folder: empty its
`pgdata` yourself or choose another path.

### `database.docker.start`, `.stop`

Start or stop the container by name. Stopping while the installation is
connected to it is refused (`DATABASE_IN_USE`) unless `acknowledgeInUse` is
set, because the workers would lose their database. Neither changes data.

### `database.docker.repair`

Plans exactly what is wrong and does only that: start a stopped container, or
recreate a **missing** container (or one that drifted: not on the pinned image
digest `IMAGE_DRIFT`, the wrong restart policy, no health check, another
published port or bind address) **over the same storage**. The data is never
recreated and no role or password changes; a recreate with the storage missing
is `DATA_MISSING` and stops, since a new container would start an empty
database.

### `database.docker.reconfigure`

Changes the port, the bind address or the memory limit. Because it recreates
the container it is a data-affecting change and follows the same pattern as the
maintenance journeys ([maintenance_barrier.md](maintenance_barrier.md)):

- the maintenance barrier must be held (`maintenance.enter` first; pass its
  `maintenance: { operationId, fence }`, otherwise `MAINTENANCE_REQUIRED` or
  `MAINTENANCE_NOT_HELD`) and the workers fenced;
- a **verified backup** is taken first (`backup: { dir, passphrase }`), and a
  failed or unverified backup stops the change (`BACKUP_FAILED`,
  `BACKUP_UNVERIFIED`; `BACKUP_REQUIRED` if none is given); the passphrase is
  a secret and is never recorded;
- *update-url* rewrites `GOOBSTER_DB_URL` for the new port; the barrier stays
  up and the result says the next step is `maintenance.release`.

Moving the data to another storage is not supported (`STORAGE_MOVE_UNSUPPORTED`).

## Passwords

Two passwords exist, and both are generated (24 random bytes, URL-safe), never
typed, never shown and never put on a command line.

- The **superuser** password is created for the provision, handed to the
  container through the child process **environment**
  (`docker run ... -e POSTGRES_PASSWORD`, which names the variable and carries
  no value in argv), used once by the provisioning step and then dropped.
  It is not stored anywhere. It exists in the operation's in-memory
  `privateInput` only; if the manager restarts mid-operation the plan is lost
  (`PLAN_INPUT_LOST`) and the operation is planned again.
- The **application** password belongs to the application role. It is stored
  in one place, the manager's environment overlay
  (`apps/manager/environment.js`, mode `0600`), as part of `GOOBSTER_DB_URL`
  after the cutover and, between provision and cutover, as the staged key
  `GOOBSTER_DOCKER_DB_URL`. The staged key is read by the cutover and is never
  merged into the environment a worker sees; the cutover removes it.

Nothing else holds either one: not `docker-postgres.json` (mode `0600`, which
holds names, the port, the bind address, the storage choice, the image
reference and the progress step), not the operation record, the journal or the
audit log, not a plan or result, not the CLI's output and not any `docker`
argument. The audit row carries action names, the kind and counts, never a
host, a port, a user or a URL. This is checked by the tests (the fake `docker`
records every argv and the secret environment values it carried, and the
suites search the store, the journal, the audit log and the output for both
passwords).

Because the application URL stays in the overlay, a later migration or
reconfigure never asks for it again, and removing the overlay key removes the
installation's access to the database (the container and its data stay).

## The readiness gate

A workers' start must not race a database that is still starting. When an
installation is connected to the Docker database it owns, the supervisor asks
`apps/manager/docker/readiness.js` before it starts the workers: it asks Docker
for the container's health (and, when the daemon does not answer, whether the
published port accepts a connection), for up to a minute. If the database is
not ready the worker is not started: its slot shows the state `conflict`
with the code `DATABASE_NOT_READY` (in the lifecycle status), the manager logs why, and it tries again after the usual
conflict delay until the container answers. With no Docker record, or an
installation that is not connected to the owned container, the check is
inert and answers ready without running any command.

## Uninstall

The default keeps your data, as for every other database. Uninstalling with
the defaults **leaves the container, the volume and the network exactly as they
are** and says so in the plan; the container keeps running. That is true of a
delete-data uninstall too: "delete my data" removes the data root and the
manager's overlay (the only copy of the application password), not the Docker
volume, so the plan carries the warning `DOCKER_DATA_RETAINED` naming the volume
until you also choose `removeDockerData`.

`removeDockerData: true` (the "Also remove the Docker database" choice, with
the installation id typed as the confirmation) removes **exactly the resources
labelled with this installation**: the container, then the volume, then the
network, each re-checked first. A foreign resource with one of our names stops
the plan (`DOCKER_RESOURCE_FOREIGN`) and is not touched; if Docker cannot be
reached the plan says so (`DOCKER_UNAVAILABLE`) and nothing is removed. A
folder you chose is never deleted, even then: the plan lists it as retained.

## Where it shows

- **Setup wizard, Database step.** The chooser offers SQLite, an existing
  server, **PostgreSQL in Docker (managed by this installer)** and the native
  entry (disabled, "Available in a later version of this installer"). The
  Docker entry is enabled only after the daemon check passes; otherwise it is
  disabled and the reason follows it. Choosing it shows the check (each
  failure with its remedy, the image and whether it is downloaded, the backup
  tools verdict), the form (port, listen address, a volume or a folder, the
  pull approval, the acknowledgements) and a preview of the names that will be
  created. Continue unlocks when the check passes and what it asks for is
  ticked.
- **Maintenance and Host: Database.** The Database page shows the owned
  instance (container name and state, health, image, port, storage, whether
  the installation uses it) with **Start**, **Stop**, **Repair** and **Use it
  for this installation…**, and **Set up PostgreSQL in Docker…** when there
  is none. The Host room's page is the same journey through the Host proxy
  (`GET /api/app/admin/host/docker/status`, status only; changes are
  operations, audited as `host.database.apply`).
- **CLI.**

```bash
goobster-manager database docker status                        # read only
goobster-manager database docker provision [--answers a.json] [--yes]
goobster-manager database docker start
goobster-manager database docker stop [--answers a.json]       # { "acknowledgeInUse": true }
goobster-manager database docker repair
goobster-manager database docker reconfigure --answers r.json  # port, bind, memoryMb, backup
```

With no `--answers`, `provision` asks for the port, the bind address, the
storage and the pull approval, shows the plan and asks to proceed. No
password is asked. Exit codes are those of the other `database` commands.

## When it fails

| You see | It means | Do |
|---|---|---|
| `DOCKER_CLI_MISSING` | No `docker` command on the manager's PATH. | Install Docker Engine or Docker Desktop, or set `GOOBSTER_DOCKER_BIN`. |
| `DOCKER_DAEMON_UNREACHABLE` | The CLI cannot reach the daemon. | Start Docker (`systemctl start docker`, or open Docker Desktop). |
| `DOCKER_PERMISSION_DENIED` | This user may not use the socket. | Add the user to the `docker` group and sign in again, or use rootless Docker. Not `sudo`. |
| `DOCKER_HOST_REMOTE` | `DOCKER_HOST` points at another machine. | Unset it for the manager, or use an existing server instead. |
| `DOCKER_ENGINE_TOO_OLD`, `ARCH_UNSUPPORTED`, `CONTAINER_OS_UNSUPPORTED` | The daemon cannot run the image. | Update Docker; use a Linux-containers daemon on amd64 or arm64. |
| `IMAGE_PULL_NOT_APPROVED`, `IMAGE_PULL_FAILED` | The image is not on this machine, or the pull failed. | Approve the download; check the network and the registry. |
| `PORT_IN_USE` | Something listens on the port. | Use the proposed free port. |
| `LAN_BIND_NOT_ACKNOWLEDGED` | A non-loopback bind address was given. | Keep `127.0.0.1`, or acknowledge. |
| `STORAGE_*` | The chosen folder is missing, not a directory, unreadable, full, already holds data, or is not shared with Docker Desktop. | Pick another folder, or fix its permissions or sharing. |
| `RESOURCE_FOREIGN` | A container, volume or network of this name exists without this installation's labels. | Rename or remove it yourself; the installer will not. |
| `HEALTH_TIMEOUT`, `CONTAINER_EXITED` | The container did not become healthy. | `docker logs goobster-pg-<id8>`; check memory and the storage's permissions. |
| `BACKUP_TOOLS_MISMATCH`, `BACKUP_TOOLS_MISSING` | The host's `pg_dump` is older than the server, or absent. | Install the PostgreSQL 17 client tools (`postgresql-client-17`), or acknowledge the limit. |
| `DATABASE_NOT_READY` | The workers were not started because the database is not up yet. | Wait; start it from the Database page (**Start** or **Repair**). |
| `DATABASE_IN_USE` | The installation uses the container you are stopping. | Stop the workers first, or acknowledge. |
| `MAJOR_UPGRADE_IS_MANUAL` | A different PostgreSQL major was asked for. | Dump and restore into a new instance, the administrator's job. |

## Moving the data

The installer does not move a database's storage (`STORAGE_MOVE_UNSUPPORTED`).
To use another volume or folder: take a backup
([backup_and_restore.md](backup_and_restore.md)), uninstall the database with
`removeDockerData` (or remove the container and volume by hand), provision with
the new storage and restore into it.

## Risks and limits

- Access to the Docker socket is access to the machine: a user in the `docker`
  group can start a privileged container. The page says so when it explains the
  permission remedy; the installer only uses the daemon the manager's user
  already may use and never starts one.
- A bind address other than loopback exposes the database on the network with
  a generated password and no TLS; that is why it needs an acknowledgement.
- The fake-`docker` tests prove what the installer asks Docker to do and what it
  does with the answers; they do not prove Docker's behaviour. The real-container
  block (below) does, and runs in CI only.
- Docker Desktop's file sharing and rootless port rules differ from Engine's;
  the check explains them but the installer cannot verify them before the
  container starts.
- The container's data is only as safe as the volume. A backup is
  [backup_and_restore.md](backup_and_restore.md)'s job; the installer does not
  schedule one.

## Tests

- `tests/dockerDaemon.test.js`: the check against the fake `docker` (every
  failure and its remedy), the image pin, resource naming and the runner's
  refusals.
- `tests/dockerPostgresKinds.test.js`: the five kinds, the install answer, the
  uninstall scopes, the readiness gate and discovery, and the secret search of
  every store. Its last block drives a real container and runs only with
  `GOOBSTER_DOCKER_TESTS=1` and a daemon that answers `docker info`; it skips
  with its reason otherwise.
- `tests/dockerPostgresRoutes.test.js`: `GET /manager/api/docker/status` and
  the Host proxy.
- `e2e/dockerPostgres.spec.js`: the chooser with a daemon that does not answer
  and with a healthy one, the form and the preview, and the Host page card,
  against the fake `docker`.
- The fake is `tests/helpers/fakeDocker.js` (and `fakeDockerCli.js`): a
  `docker` executable first on PATH that answers canned JSON and records every
  argv and the secret environment values it carried.
