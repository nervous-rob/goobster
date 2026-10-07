# Running Goobster on Postgres

Postgres is **optional**. Without `GOOBSTER_DB_URL` set, Goobster runs on its
embedded SQLite database exactly as always (the "lite" path, zero external
dependencies). Set `GOOBSTER_DB_URL` and the same code runs on Postgres +
pgvector instead — the foundation for the multi-service split (reactive port
spec, Phase 3), true concurrent access, and standard backup tooling.

This guide covers the common case: **the same Raspberry Pi runs both the bot
and the database.** For the four-service compose path (postgres + bot + api +
nginx) see `deploy/docker-compose.yml` and `documentation/docker_deployment.md`
— that profile injects `GOOBSTER_DB_URL` for you.

## 1. Storage first

Postgres commits are fsync-heavy. Run the database from a **USB 3 SSD**, not
an SD card — an SD card gives you latency spikes and a shortened card life.

**If the Pi boots from the USB SSD** (whole OS on the drive — check with
`findmnt /`), there is nothing to do: the default data directory
(`/var/lib/postgresql`) is already on it. Skip to step 2.

**If the OS is on the SD card and the SSD is extra storage**, mount the
drive permanently and put the Postgres cluster on it:

```bash
# Identify the drive; format it ext4 ONLY if it's new/empty
lsblk
sudo umount /dev/sda1                     # the desktop automounter grabs USB drives
sudo mkfs.ext4 -L pgdata /dev/sda1        # DESTROYS the partition's contents

# Mount it at boot, by UUID (survives /dev/sda -> /dev/sdb renames).
# nofail: an unplugged drive fails Postgres, not the whole boot.
sudo mkdir -p /mnt/ssd
sudo blkid /dev/sda1                      # copy the UUID
echo 'UUID=<paste-uuid> /mnt/ssd ext4 defaults,noatime,nofail 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
```

A USB flash thumbdrive works too — better than the SD card, short of a real
SSD. For Goobster's write volume it is fine; treat a proper USB SSD as the
eventual upgrade (moving the cluster later is the rsync recipe below).

The filesystem must be a native Linux one (**ext4**). exFAT/NTFS/FAT cannot
hold Postgres's permissions or fsync semantics.

Then, **after installing the packages in step 2 but before step 3**, recreate
the cluster on the drive (Debian's native way — clean because nothing exists
yet):

```bash
sudo pg_dropcluster --stop 17 main
sudo mkdir -p /mnt/ssd/postgresql && sudo chown postgres:postgres /mnt/ssd/postgresql
sudo pg_createcluster -d /mnt/ssd/postgresql/17/main --start 17 main
sudo -u postgres psql -c 'SHOW data_directory;'   # confirms the SSD path
```

(Already have data in a cluster on the SD card? Move instead of recreate:
`sudo systemctl stop postgresql`, `sudo rsync -a /var/lib/postgresql/ /mnt/ssd/postgresql/`,
point `data_directory` in `/etc/postgresql/17/main/postgresql.conf` at
`/mnt/ssd/postgresql/17/main`, start, and verify with `SHOW data_directory;`.)

If you truly must stay on SD, take the deal Postgres offers for it:

```sql
-- as the postgres superuser: lose at most ~1s of commits on power cut,
-- in exchange for SD-tolerable write behavior
ALTER SYSTEM SET synchronous_commit = off;
SELECT pg_reload_conf();
```

## 2. Install Postgres + pgvector

Raspberry Pi OS (Bookworm) doesn't ship pgvector, so use the official
PostgreSQL apt repository (arm64 builds included):

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17 postgresql-17-pgvector
```

Postgres starts automatically and listens on localhost only — exactly right
for a single-Pi setup.

## 3. Create the role, database, and extensions

```bash
sudo -u postgres psql -c "CREATE ROLE goobster LOGIN PASSWORD 'change-me'"
sudo -u postgres createdb -O goobster goobster
sudo -u postgres psql -d goobster -c \
  "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS citext;"
```

(Both extensions are "trusted", so the adapter can also create them itself on
first connect; pre-creating them as superuser just removes a variable.)

The manager can do this step from the browser or the command line, with an
administrator's credential it uses once and does not keep: the role it
creates can log in and nothing else (no superuser, no database or role
creation). See [database_connection.md](database_connection.md).

Pi-friendly memory settings (optional but recommended on 4GB):

```sql
ALTER SYSTEM SET shared_buffers = '128MB';
ALTER SYSTEM SET max_connections = 40;
```

then `sudo systemctl restart postgresql`.

## 4. Migrate your existing data

(Starting a new installation on a server you already run, or connecting an
installation that has no data yet? That is not a migration: use the wizard's
**An existing PostgreSQL server** or **Database** page, see
[database_connection.md](database_connection.md). It tests the server read
only, can create the role, database, schema and extensions with an
administrator's credential that is used once, and refuses to point an
installation whose SQLite file holds data at an empty server.)

For an installation managed by the manager, use the supported path
([db_migration.md](db_migration.md)): a read-only preflight, a verified
backup, the copy and verification, a start of the application on Postgres,
and the connection switch, with a rollback until the first write reaches
Postgres:

```bash
node apps/manager/cli.js migrate preflight --answers pre.json
node apps/manager/cli.js migrate run --answers run.json --confirm <installationId> --release
```

The URL and the backup passphrase go in the answers file (mode `0600`),
never on the command line. The rest of this section is the developer
script, which has none of those guarantees.

Stop the bot, copy everything across, verify:

```bash
sudo systemctl stop goobster
cd ~/goobster   # your install directory

GOOBSTER_DB_URL='postgres://goobster:change-me@127.0.0.1:5432/goobster' \
  npm run migrate-to-postgres
```

The migrator refuses a non-empty target, copies every table (one transaction
per table), re-seats the id sequences, and verifies row counts, foreign keys,
identities, five relationship checks, sampled content and attachment
references. It takes no backup and holds no maintenance barrier. It finishes
with a verified summary or exits non-zero. Your SQLite
file at `data/goobster.sqlite` is opened read-only and left untouched (it is
your rollback).

The memory vector index is derived data and is not copied; it rebuilds itself
from `memory_embeddings` on the first recall.

## 5. Point the bot at Postgres

The adapter is selected by the `GOOBSTER_DB_URL` environment variable (not
config.json). For the systemd install, use a **drop-in** so the setting
survives auto-updates and unit re-renders (`GOOBSTER_SYNC_UNIT`):

```bash
sudo systemctl edit goobster
```

```ini
[Service]
Environment=GOOBSTER_DB_URL=postgres://goobster:change-me@127.0.0.1:5432/goobster
```

```bash
sudo systemctl start goobster
curl -s http://127.0.0.1:3000/health
```

Other run styles:

- **Manual / `npm run dev`**: put the same line in a `.env` file at the repo
  root (already gitignored; `dotenv` loads it).
- **PM2**: add `GOOBSTER_DB_URL` to the `env` block in `ecosystem.config.js`.
- **Docker**: pass `-e GOOBSTER_DB_URL=...` (with `host.docker.internal` or
  the compose service name as the host).

## 6. Verify, and how to roll back

Everything should look identical — same conversations, memories, wallets,
settings. `/systemstatus` in Discord now reports the database as Postgres
with its on-disk size.

Rolling back is removing the environment variable and restarting: the SQLite
file was never modified. (Anything written *after* the switch lives only in
Postgres, so treat the rollback window accordingly.) With the manager's
migration the same limit is enforced: `migrate rollback` is possible until the
first write reaches Postgres, then refused (`POSTGRES_HAS_WRITES`).

## Upgrading the server

Moving the PostgreSQL server itself to a newer major version (say 16 to 17) is
the administrator's job and happens outside Goobster; the manager does not do
it in this version. It is not the same as updating Goobster's schema (adding
tables and columns to a database Goobster already owns, which is safe to
repeat) and not the same as changing the connection (telling Goobster where
the server is; see [database_connection.md](database_connection.md)).

For a server you run: take a backup of the database (`pg_dump`, plus the
Goobster backup of the installation), stop the application, upgrade the
cluster with your distribution's tool (`pg_upgradecluster` on Debian, or a
dump and restore), install the matching pgvector package for the new major
version, start the server, and connect again if its address changed. Goobster
needs PostgreSQL 13 or newer and the `vector` and `citext` extensions; the
Database page's **Test connection** reports the server version and the
extensions before anything is changed.

## Troubleshooting

- **`type "citext" does not exist` / vector warnings** — the extensions
  aren't installed in *this* database; re-run the `CREATE EXTENSION` line
  from step 3 against the right database.
- **`password authentication failed`** — Debian's default `pg_hba.conf`
  authenticates TCP connections with `scram-sha-256`; make sure the URL
  password matches the role and you're connecting via `127.0.0.1`, not the
  unix socket.
- **Memory recall falls back to brute-force scan** — pgvector isn't
  installed for the server major version you're running (`\dx` in psql to
  check). Harmless functionally; install `postgresql-17-pgvector` and
  `CREATE EXTENSION vector`.
- **Slow on SD card** — see step 1.
