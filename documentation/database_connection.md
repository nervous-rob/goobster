---
title: Choosing SQLite or PostgreSQL and connecting to an existing server (installer P4.5)
kind: reference
summary: How the installer helps choose between SQLite and PostgreSQL by workload (no user-count thresholds), the connection form for an existing PostgreSQL server (host, port, database, schema, user, password, TLS mode, CA file), the read-only database test (reachability, server and driver versions, sign-in, privileges, extensions, schema compatibility, TLS outcome, verdict), the three operation kinds database.provision, database.schema.apply and database.connect, the cutover rules (a fresh install, an empty SQLite file, an existing PostgreSQL database, and why a SQLite database that holds data goes to the migration), where the connection is stored and what is never stored, the setup wizard step, the Database maintenance journey and Host page, the CLI, the audit actions, failure remediation, and how a Docker instance the installer owns plugs in (documentation/docker_postgres.md), and what is not done here (native PostgreSQL provisioning, server bind and storage edits, cluster tuning, server major upgrades, reverse migration).
when: Choosing a database engine for a new installation; connecting an installation to a PostgreSQL server you already run; testing a connection; preparing a server (role, database, schema, extensions) with an administrative credential; applying or updating Goobster's schema on a server; explaining why a connection change was refused; reading the Database page or the database CLI; changing the probe, the provisioning actions, the connect operation or the install answer.
tags: [installer, manager, postgres, sqlite, connection, wizard, provisioning, schema, tls, host-room, cli]
---

# Choosing SQLite or PostgreSQL, and connecting to an existing server

Installer Phase 4 item 5, existing-server part (issue #338). It is built on the
read-only inspector of the migration (`packages/core/db/migration/inspect.js`,
[db_migration.md](db_migration.md)), the manager's environment overlay
([manager.md](manager.md#the-environment-overlay)), the maintenance barrier
([maintenance_barrier.md](maintenance_barrier.md)) and the manager's operation
engine ([manager.md](manager.md)).

**What it is not.** It does not install, start or configure a PostgreSQL
server of its own: a PostgreSQL in Docker that the installer creates and owns
is [docker_postgres.md](docker_postgres.md) (#339, an explicit choice), and a
PostgreSQL 17 cluster the installer creates natively on a supported Linux host
is [native_postgres.md](native_postgres.md) (#340, an explicit choice). It does not edit anything about a server that belongs to
someone else: not its data directory, the address it listens on, its port, its
memory settings or its other databases. It never moves data between engines
(that is the migration), never upgrades a server to a newer PostgreSQL major
version, and there is no PostgreSQL to SQLite path.

## Which engine?

The setup wizard says this in words, not in numbers of people:

| Your situation | Choose |
|---|---|
| One machine and one process (the default **lite** layout, or the standalone portal) | **SQLite**. A single file in the data folder: nothing to run, back up by copying the folder. |
| The bot and the portal run apart (the **paired** layout, `deploy/docker-compose.yml`) | **PostgreSQL is required.** The processes share the data through a server; SQLite cannot be used (the CLI and the pages refuse). |
| Many Discord servers, or several of the heavy features (the exchange, long-term memory, research) used at once | **Consider PostgreSQL.** Several processes can write at the same time, and the database can live on its own machine. |
| You already run a PostgreSQL server you trust | **An existing PostgreSQL server.** |

No threshold of users or servers is stated because none was measured; the
guidance is about how the installation is run.

The chooser offers four choices: SQLite, an existing PostgreSQL server,
PostgreSQL in Docker managed by the installer
([docker_postgres.md](docker_postgres.md)) and PostgreSQL on this machine
managed by the installer ([native_postgres.md](native_postgres.md)). The last
two are enabled only when their check passes and say why when they are not.

## The connection

| Field | Meaning |
|---|---|
| Host | A name or an address, as this machine reaches it. Not a URL. |
| Port | Default 5432. |
| Database | The database Goobster uses. It is never created by a connection change. |
| Schema | Default `public`. Goobster creates its tables here and only here. It must hold nothing that is not Goobster's. |
| User | The role Goobster runs as. Use a role of its own, not a superuser. |
| Password | A secret. See [what is stored](#where-the-connection-is-stored). |
| TLS mode | `disable`, `prefer`, `require` or `verify-full`. Default: `prefer` for this machine, `require` for any other host. |
| CA file | Optional absolute path, on this machine, of the certificate authority file. Required by `verify-full`. |

TLS, as the application's driver (`pg`) does it: `disable` is no TLS;
`require` is TLS without checking the certificate (with a CA file the chain is
checked but the host name is not); `verify-full` checks the chain and the host
name against the CA file; `prefer` tries TLS without verification and falls
back to plain. The driver has no fallback of its own, so the test resolves
`prefer` once (`tls.effective`, `require` or `disable`) and the connection that
is saved holds that outcome. The test reports the outcome (`tls.encrypted`,
protocol, whether the certificate was verified) and warns when a connection to
another machine is not encrypted or its certificate is not checked.

Next to the form the pages show a read-only block, **Where the data is
stored**, with the server and database, and the sentence that the data
directory, listen address and port are set on the server. For a server the
manager owns the data directory can be moved
([native_postgres.md](native_postgres.md#databasenativerelocate)); for one it
merely connects to they never are.

## Test connection

`POST /manager/api/database/test` (and `POST /api/app/admin/host/database/test`
in the portal; `database test` on the command line) is read-only: it connects,
looks and disconnects. Nothing is created or changed on the server or in the
installation. The password is in that one request body, held for the request
and never echoed. At most 12 tests a minute are accepted, and the route needs a
session (it makes an outbound connection to the host and port you give it).

The report:

- **Reachability and sign-in** (`auth`): `ok`, `wrong-credentials` (28P01,
  28000), `database-missing` (3D000), `permission-denied` (42501), `tls-failed`
  or `unreachable` (08xxx, refused, timed out, name not found). Each has its
  own finding with a remediation.
- **Server and driver versions**: the server's version (13 or newer is needed)
  and the `pg` version Goobster uses.
- **Privileges**: whether the role may connect, create in the database and
  create in the schema, and whether it is a superuser or may create databases
  or roles.
- **Extensions**: for `vector` and `citext`, `{ available, installed, trusted }`.
  "Available on the server" is not "created in this database", and creating a
  trusted extension needs `CREATE` on the database; the report says which of
  these is the case.
- **Schema compatibility**: `missing-schema`, `empty`, `goobster-current`,
  `goobster-older`, `goobster-newer` (written by a newer release: this release
  will not write into it) or `foreign` (objects that are not Goobster's: never
  written into). The comparison is the migration's schema fingerprint.
- **TLS outcome** and a **verdict**: `ok`, the findings that block, the
  warnings, the notes, the next action (`provision`, `schema`, `connect`, or
  fix a finding) and, when something is missing, the provisioning it needs and
  the SQL a database administrator can run instead.

Finding codes include `SERVER_TOO_OLD`, `DATABASE_MISSING`, `ROLE_MISSING`,
`NO_CREATE_PRIVILEGE`, `EXTENSION_LIBRARY_MISSING`, `EXTENSION_NOT_CREATED`,
`EXTENSION_PRIVILEGE`, `SCHEMA_EMPTY`, `SCHEMA_OLDER`, `SCHEMA_CURRENT`,
`SCHEMA_NEWER`, `SCHEMA_FOREIGN`, `TLS_NOT_ENCRYPTED`, `TLS_NOT_VERIFIED` and
`TARGET_UNREACHABLE`.

## The operation kinds

All three go through the generic engine (plan, validate, apply, journal, audit
`manager.<kind>`), are allowed on an installed installation (a fresh install
uses the install answer below), and keep the password in the operation's
in-memory `privateInput`: it is never in the plan, the journal, the audit row,
the response or a log. A restart between plan and apply means planning again
(`PLAN_INPUT_LOST`).

### `database.provision`

Prepares an existing server with an **elevated credential used once** and not
kept. The input is the connection (what Goobster will use), `elevated`
(`{ user, password, database? }`, the maintenance database defaults to
`postgres`) and the **ticked actions**: `create-role`, `create-database`,
`create-schema`, `create-extension.citext`, `create-extension.vector`, `grant`.
The plan shows the exact SQL of each action and which of them the elevated role
may run.

- The application role is created `LOGIN` only: not a superuser, not
  `CREATEDB`, not `CREATEROLE`, no replication, no `BYPASSRLS`; its password is
  the one typed in the connection. The database is owned by it; the grant is
  `CONNECT` on the database and `USAGE, CREATE` on the schema, nothing more.
- It refuses to act outside the named database, schema and role: a name that
  is a system or reserved name (`RESERVED_NAME`), the elevated role being the
  application role (`SAME_ROLE`), a role that already exists
  (`ROLE_EXISTS`: it is not taken over) and **any schema that holds foreign
  tables** (`SCHEMA_FOREIGN`).
- When the elevated role cannot do an action (a hosted server that does not
  give you a superuser), the plan is refused with `PROVISIONING_NOT_PERMITTED`
  and carries the **SQL for a database administrator**, with the placeholder
  `<APPLICATION_PASSWORD>` where the password goes. Nothing in that SQL ever
  contains a password.
- A step is idempotent: running it again reports `already` for what exists.
  One caveat: if the role was created and the database step then failed, a
  rerun reports `ROLE_EXISTS` for the role; untick `create-role` and run the
  rest.

### `database.schema.apply`

Applies `schema.sql` to the schema, **only after the test says `empty` or an
older Goobster fingerprint** (`goobster-older`). It reuses the same child
process that `db-init` uses, given the URL in memory, and never runs on a
`foreign` or a `goobster-newer` schema. Steps: `probe`, `apply`, `verify`
(the fingerprint must match this release afterwards). A schema that is already
current is a no-op.

### `database.connect`

Points an installed installation at the server. Steps: `maintenance`, `probe`,
`validate`, `cutover`, `settle`, `release`.

1. The maintenance barrier is entered (or an already held one is used with
   `maintenance: { operationId, fence }`) and every writer is quiesced.
2. The server is probed again; a blocking finding stops here (`PROBE_BLOCKED`);
   the schema must hold Goobster's tables, current or older (an empty schema
   is `SCHEMA_NOT_APPLIED`: run `database.schema.apply` first; a missing one
   is `SCHEMA_MISSING`; a foreign or newer one is refused).
3. The application is **started against the target under the barrier** and
   must pass its checks (`validateOnTarget`) before anything is written; a
   failure leaves the old connection in place and the barrier is released.
4. The cutover writes the connection into the environment overlay, then
   updates the installation record, in that order. Both are done before the
   step reports; nothing else changes.
5. The barrier is left up unless `release: true` was asked (the CLI's
   `--release`, the page's checkbox, which is on by default in the browser).
   With the barrier up the application stays held until `release`
   (`node apps/manager/cli.js release`) lifts it.

Cancelling is safe until the cutover. If the manager stops in the short window
between the overlay write and the record update, the status page shows
**mismatch** (the record and the saved connection disagree); release the
barrier and run `database connect` again to finish.

## The cutover rules

| Starting point | What happens |
|---|---|
| A **fresh install** | The wizard's database answer (`{ engine: 'postgres', connection }`, or `{ engine: 'sqlite' }`) goes into the install answers. `install.new` probes the server in preflight (the plan shows it) and, in `init-db`, applies the schema to it through the same child process (never creating or dropping a database), then writes the connection into the overlay. The server is never deleted by an uninstall. |
| An installed installation on **empty SQLite** | `database.connect`: the SQLite file is kept in place and not deleted. |
| An installed installation on **SQLite that holds data** | **Refused** with `MIGRATION_REQUIRED`: pointing it at an empty server would start the application with nothing, leaving the data behind. The code names the migration (P4.3, [db_migration.md](db_migration.md), the `migrate` command); nothing is changed. |
| An installed installation on **PostgreSQL** (another database, a changed password, a moved server) | `database.connect` as above; the previous database is not touched. |
| The **paired** layout | PostgreSQL is required: the install preflight blocks it without a PostgreSQL connection (`PAIRED_REQUIRES_POSTGRES`), and `database status` reports that SQLite is refused. |

"Empty" is read-only and strict: a SQLite file with any row in a table of the
application, other than the bookkeeping rows a fresh install writes, counts as
data.

## Where the connection is stored

The connection URL, which carries the password, is stored in **one place**: the
manager's environment overlay, `<managerStore>/environment.json` (mode `0600`),
as `GOOBSTER_DB_URL`. The installation record holds only the engine and that it
is external. A `GOOBSTER_DB_URL` already in the process environment wins over
the overlay (`ENV_OVERRIDES_OVERLAY`; remove it from the service environment).

Never in a log, journal, audit row, operation record, API response, browser
storage or a command line: the page keeps the application password and the
elevated credential in memory only (an answer that was typed before a reload
must be typed again), the CLI takes the password from a hidden prompt, an
answers file of mode `0600`, or the file named by `GOOBSTER_DB_PASSWORD_FILE`
(the elevated one from `GOOBSTER_DB_ELEVATED_PASSWORD_FILE`), and refuses any
flag named like a password (`SECRET_ON_ARGV`).

The audit rows are `manager.database.provision`, `manager.database.schema.apply`
and `manager.database.connect`, with counts and names of things (the action
ids, the database and schema names, whether a barrier was held); the portal's
rows are `host.database.apply`. The tests are not audited because they change
nothing.

## The pages

### Setup wizard: the Database step

The step shows the guidance above, then the engine: SQLite (the data folder
facts as before), **An existing PostgreSQL server** (the form, **Test
connection**, the optional **Prepare the server** panel, the stored-where
block and who owns the storage) and the two disabled entries. For PostgreSQL,
Continue unlocks only when a test of exactly the current settings says the
server can be used (a changed field makes the earlier result stale). The
review shows the server (host, database, user; never the password) and the
install creates Goobster's tables in it.

### PostgreSQL in Docker (#339)

A third source next to "an existing server": **PostgreSQL in Docker (managed
by this installer)**. The chooser enables it only after the Docker check
passes (otherwise it is disabled with the reason and the remedy). The
`database` answer of `install.new` takes `docker: { port, bind, storage, ... }`
instead of `connection` (give one, not both) and the install gains a
`docker-postgres` step. The kinds `database.docker.provision|start|stop|
repair|reconfigure`, the generated passwords, the digest-pinned image, the
`io.goobster.*` labels and the uninstall scopes are in
[docker_postgres.md](docker_postgres.md). The connection of such an instance
is made with `database.connect` and `{ "connection": { "owned": "docker" } }`:
it reuses the staged application URL, so the connect, the cutover rules and the
barrier are exactly those of this page.

### PostgreSQL on this machine (#340)

A fourth source: **PostgreSQL on this machine (managed by this installer)**,
for a Debian 12, Ubuntu 22.04+ or AlmaLinux/Rocky 9 host where the manager can
obtain administrator rights without a password prompt. The `database` answer of
`install.new` takes `native: { port, bind, dataDirectory, installPackages, ... }`
instead of `connection` or `docker` (give one) and the install gains a
`native-postgres` step. The kinds `database.native.provision|start|stop|repair|
relocate`, the pinned PostgreSQL repositories, the cluster the installer
creates beside any cluster that already exists (never touched), the SCRAM
verifier that keeps the password away from every command line, the staged key
`GOOBSTER_NATIVE_DB_URL` and the uninstall scopes are in
[native_postgres.md](native_postgres.md). The connection is made with
`database.connect` and `{ "connection": { "owned": "native" } }`, reusing the
staged application URL.

### Maintenance: Database

The Installation page (manager's own page: **Installation → Database…**, test
id `action-database`; the portal: **Host → Database**, also a card on the
Overview) shows the engine, the connection in effect without the password,
whether the SQLite file is empty, a mismatch or a held barrier, and an
explanation of three different jobs: **Connection setup** (this page, never moves
data), **Schema update** (adds tables and columns to a database Goobster
already owns, safe to repeat) and **PostgreSQL server upgrade** (the server
itself moving to a newer major version: the administrator's job, outside
Goobster; see [postgres_setup.md](postgres_setup.md#upgrading-the-server)).
It also lists what to do for each way the database can fail.

When the installer owns a Docker database, the page also shows it (status,
health, image, storage, port, **Start**, **Stop**, **Repair**, **Use it for
this installation…**). A native cluster it owns is shown the same way (name and
state, port, data directory, **Start**, **Stop**, **Repair**, **Use it for this
installation…**).

**Connect to a PostgreSQL server…** runs the form, the test, the optional
preparation, the review (`database.connect`'s plan: from, to, what is left
behind, the steps) and the progress. **Update the schema…** does the same for
`database.schema.apply`.

### Command line

```bash
node apps/manager/cli.js database test --answers conn.json     # read only
node apps/manager/cli.js database provision --answers prov.json
node apps/manager/cli.js database schema --answers conn.json
node apps/manager/cli.js database connect --answers conn.json [--release]
node apps/manager/cli.js database status
node apps/manager/cli.js database docker status|provision|start|stop|repair|reconfigure   # docker_postgres.md
node apps/manager/cli.js database native status|provision|start|stop|repair|relocate      # native_postgres.md
```

`conn.json` is `{ "connection": { "host": "...", "port": 5432, "database":
"goobster", "schema": "public", "user": "goobster", "password": "...", "tls":
{ "mode": "require", "caFile": "/etc/ssl/ca.pem" } } }` with mode `0600`;
without `--answers` the CLI asks, and a password comes from the hidden prompt
or `GOOBSTER_DB_PASSWORD_FILE`. `provision` also takes `elevated` and
`actions`. `--dry-run` is refused for `database` (`database test` is the
read-only check). A fresh install takes the same `connection` object in the
`database` answer (`node apps/manager/cli.js schema` prints the JSON schema).

## When it fails

| You see | It means | Do |
|---|---|---|
| `unreachable` / `TARGET_UNREACHABLE` | The host or port is wrong, the server is down, or a firewall is in the way. | Check the host and port from this machine; start the server. |
| `wrong-credentials` | The server rejected the user or password (or the role does not exist). | Check both; create the role with **Prepare the server** if it is missing. |
| `database-missing` | The database does not exist. | Create it with **Prepare the server**, or ask the administrator. |
| `permission-denied` / `NO_CREATE_PRIVILEGE` | The role may not connect, or may not create tables in the schema. | Grant `CONNECT` and `USAGE, CREATE`, or run the grant action. |
| `EXTENSION_LIBRARY_MISSING` | The server does not have pgvector installed. | Install the server package for pgvector, then create the extension. |
| `SCHEMA_FOREIGN` | The schema holds other tables. | Use another schema or database; Goobster never writes into it. |
| `SCHEMA_NEWER` | A newer release wrote that database. | Update this installation. |
| `MIGRATION_REQUIRED` | The SQLite file holds data. | Use `migrate` (P4.3). |
| `ENV_OVERRIDES_OVERLAY` | The environment sets `GOOBSTER_DB_URL`. | Remove it from the service environment. |

The application itself never crashes because the server is down: it keeps
retrying and recovers when the server returns. A changed password is fixed by
connecting again with the new one; the old connection stays in use until then.

## Risks and limits

- The test route makes an outbound connection to a host and port you supply.
  It is authenticated, rate limited and read-only, and a portal operator
  could use it to probe addresses reachable from the manager.
- TLS against a certificate that a real certificate authority issued is
  covered by the driver and by the probe's reporting, but the automated tests
  use the local server's self-signed setup only.
- Hosted servers (a managed cloud PostgreSQL) usually do not give you a
  superuser, which is why `database.provision` can print SQL for the
  administrator instead of running it.

## Tests

`tests/dbConnectionProbe.test.js` (settings, the probe against a real server,
schema comparison, provisioning), `tests/databaseKinds.test.js` (the three
kinds and the install answer, engine parity), `tests/databaseRoutes.test.js`
(status and test routes, the Host proxies), and the browser journeys in
`e2e/databaseWizard.spec.js`. The Docker instance has its own specs
(`tests/dockerDaemon.test.js`, `tests/dockerPostgresKinds.test.js`,
`tests/dockerPostgresRoutes.test.js`, `e2e/dockerPostgres.spec.js`;
[docker_postgres.md](docker_postgres.md#tests)); so does the native one
(`tests/nativePostgresAdapters.test.js`, `tests/nativePostgresHelper.test.js`,
`tests/nativePostgresKinds.test.js`, `tests/nativePostgresRoutes.test.js`,
`e2e/nativePostgres.spec.js`; [native_postgres.md](native_postgres.md#tests)).
