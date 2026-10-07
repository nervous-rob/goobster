---
title: Installing Goobster on Linux - the .run installer, the AppImage and the systemd service (installer P3.7)
kind: reference
summary: How to install, run, reconfigure, repair and remove Goobster on Linux with the self-extracting .run installer or the AppImage - the artifacts and why every build here is labelled -dev, the supported platform baseline, the setup wizard over an SSH tunnel and the headless answers-file install, the default roots, what the privileged helper runs as root (the four operations, how sudo or pkexec is chosen, the by-hand command when neither works), the systemd unit and the goobster account, logs, the manual-manager fallback, repair, reconfigure and uninstall, adopting a Raspberry Pi install, the result codes, how the artifacts are built and what the CI journey proves.
when: Installing Goobster on a Linux server, a Raspberry Pi or a desktop; running the installer without a browser; understanding what the installer does as root and what it never does; finding the service, its logs or its unit; removing an installation or moving its roots; adopting a Raspberry Pi install made with install-rpi.sh; building or auditing the Linux bootstrap artifacts.
tags: [installer, linux, systemd, bootstrapper, appimage, run, privileged-helper, service, headless, raspberry-pi, uninstall]
---

# Installing Goobster on Linux

Installer Phase 3 item 7 (issue #333, epic #315, ADR 0013 decision 9). Two
artifacts carry one release payload and start the installation manager's own
setup engine (`documentation/manager_install.md`):

- `goobster-<version>-linux-<arch>[-dev].run`, a self-extracting shell
  installer. It works on a server with no desktop.
- `Goobster-<version>-<arch>[-dev].AppImage`, the same payload behind an
  `AppRun` that opens the setup wizard in the default browser (or prints the
  address when there is no browser).

Neither one copies files into the installation by itself. They unpack the
payload into a private temporary directory, check it, and point the manager's
`install.new` operation (stage, verify, atomic activation, the `register-service`
step) at it. The result is the same installation a `goobster-manager install`
makes: `<code root>/current` holds the payload, the manager's store records
what was done, and an uninstall removes only what the record names.

## Development builds

Every artifact built from this repository today is an **unsigned development
build**. The payload's manifest is signed with a throwaway key
(`scripts/package-runtime.js --dev-sign`), so the file name carries `-dev`, the
`.run` prints a notice before it does anything, `--info` says so, and the
build report (`bootstrap-report-<target>.json`) records `"signed": false`. A
`-dev` build installs only into a machine you trust. A build is a release build
only when `payload-manifest.sig` verifies against the public key the builder
was given (`--public-key`), and production signing keys are not part of this
repository (#341).

## Supported platforms

The platform baseline is the one proven in `documentation/packaging_proof.md`:

| | Supported | Not supported |
|---|---|---|
| Distributions | Debian 12 and Raspberry Pi OS Bookworm (64-bit), Ubuntu 22.04 and newer, AlmaLinux and Rocky 9 | Alpine and any musl system, RHEL, AlmaLinux and Rocky 8, Debian 11 and Ubuntu 20.04 on arm64, 32-bit Raspberry Pi OS |
| Architectures | x64 (glibc 2.29 or newer), arm64 (glibc 2.33 or newer) | 32-bit ARM |

The `.run` checks the CPU and the C library before it unpacks anything and
exits with code 3 on an unsupported machine. systemd is needed only to
register the service; without it the install still finishes (see "Manual
manager").

System packages are the operator's job. The installer **reports** the system
dependencies the selected features use (`ffmpeg`, `bubblewrap`, `python3-venv`,
`mgba`, `spotdl`, `yt-dlp`, `ollama`) as `SYSTEM_DEPENDENCY_MISSING` warnings
and never installs them: the `package.install` privileged operation answers
`NOT_IMPLEMENTED` on Linux. For example:

```bash
sudo apt install ffmpeg bubblewrap python3-venv        # Debian, Ubuntu, Raspberry Pi OS
sudo dnf install ffmpeg bubblewrap python3             # AlmaLinux, Rocky (ffmpeg needs RPM Fusion or EPEL)
```

`documentation/raspberry_pi_guide.md` covers the music tools (`spotdl`,
`yt-dlp`).

## Choosing how to install

| You have | Use |
|---|---|
| A server you reach over SSH | `sh goobster-*.run`, then the wizard through an SSH tunnel, or `--headless` |
| A desktop | The AppImage (or the `.run`; it prints the same address) |
| A script, a provisioning tool, CI | `--headless --answers <file>` |

```bash
sh goobster-1.0.0-linux-x64-dev.run --info       # what it carries
sh goobster-1.0.0-linux-x64-dev.run --verify     # check the archive against the SHA-256 in its header
sh goobster-1.0.0-linux-x64-dev.run              # start the wizard
```

Options of the `.run` (the AppImage takes the same ones after its own name):

| Option | Meaning |
|---|---|
| `--headless --answers <file>` | Install without a browser. The file is the CLI's answers JSON (`apps/manager/install/answers.schema.json`), mode 0600, owned by the account that runs the installer. |
| `--base <dir>` | Put every root under `<dir>` (`code/`, `data/`, `config/`, `cache/`, `logs/`). |
| `--verify` | Verify the embedded archive against the header and stop. |
| `--info` | Print the release, target, digests and whether it is a development build. |
| `--keep` | Keep the unpacked temporary directory (debugging). |
| `--open-browser` | Also try `xdg-open` for the wizard (the AppImage does this by default). |
| `--yes --json --dry-run` | Forwarded to the install CLI in headless mode (`--dry-run` shows the plan and writes nothing). |

Exit codes. The shell header exits 3 on an unsupported machine, 4 on a damaged
or missing archive and 5 when the temporary directory or the unpack fails. Once
the payload is unpacked the bootstrap entry takes over: 0 done, 1 unexpected,
2 invalid input (bad answers file, unknown option), 3 refused (the wizard found
an existing installation, `ALREADY_INSTALLED`), 4 the payload is not the one the
header names, 5 the install finished but a step that needs a privileged helper
was deferred.

### The wizard

Without `--headless` the installer starts the manager from the unpacked
payload on `127.0.0.1:3400` and prints the address and the tunnel for a machine
with no screen:

```text
Open the Goobster install wizard: http://127.0.0.1:3400/manager/
On a machine without a screen, run this on your own computer first, then open the address there:
  ssh -L 3400:127.0.0.1:3400 <user>@<this machine>
Press Ctrl-C to leave; nothing already registered with the system is stopped.
```

The page is the setup wizard of `documentation/setup_wizard.md`. The manager
prints where it wrote the one-time setup credential
(`<manager store>/bootstrap-credential`, owner only, valid 15 minutes) and the
Welcome step asks for it. The installer waits for an applied `install.new`, prints the
outcome (the service, or the manual-manager command) and stops **its own**
manager. Ctrl-C leaves without touching any service. The wizard's manager holds
port 3400 until it stops, so the service's manager may take the port on its
first retry (`Restart=on-failure`, 10 seconds).

Nothing here binds to the network beyond the loopback address, opens a
firewall port or changes one. The standalone API of an installation listens on
port 3100 as it always has; put it behind your reverse proxy or firewall as you
would any Goobster installation.

### Headless

```bash
cat > answers.json <<'EOF'
{
  "ownerLabel": "my server",
  "features": ["core", "knowledge", "music"],
  "config": [{ "id": "webapp.publicUrl", "value": "https://goobster.example.org" }]
}
EOF
chmod 600 answers.json
sudo sh goobster-1.0.0-linux-x64-dev.run --headless --answers answers.json --yes
```

The installer fills in what the file leaves out: `source` is the embedded
payload (a different `source` is refused with `ANSWERS_SOURCE`), `layout` is
`standalone` (the payload carries no Discord bot), `roots` are the defaults
below, `release` accepts the payload's own signature (a `-dev` build allows an
unsigned payload; a release build requires its key). Running as root it also
asks for the `goobster` service account and for it to be created. Any field you
set wins. A second run with the same file finds nothing to change.

An answers file with secrets stays 0600; the installer copies the merged answers
to a 0600 file in a 0700 temporary directory, passes that to the CLI and deletes
it. A `kill -9` of the installer can leave that directory behind in `/tmp`; it
holds nothing the original answers file did not.

### Default roots

| Root | As root | As a person |
|---|---|---|
| code | `/opt/goobster` | `$GOOBSTER_HOME/code`, else `$XDG_DATA_HOME/goobster/code`, else `~/.local/share/goobster/code` |
| data | `/var/lib/goobster/data` | `<home>/data` |
| config | `/var/lib/goobster/config/config.json` | `<home>/config/config.json` |
| cache | `/var/lib/goobster/cache` | `<home>/cache` |
| logs | `/var/lib/goobster/logs` | `<home>/logs` |
| manager store | `/var/lib/goobster/data/manager` | `<home>/data/manager` |

The code root is the only one that is replaced on an update. Data, config and
the manager's store are never read, written or moved by a payload change, so
the data root may live on another disk, and every directory name may contain
spaces. The installer creates missing parent directories searchable
(`0755`) so the service account can reach the roots; the roots themselves are
`0750` or `0700` and owned by that account.

## What runs as root

The installer runs as you. It asks for administrator rights only for the
operations in a closed list, through a small **privileged helper**
(`apps/manager/privileged/`): one Node.js process that reads one JSON document
on its standard input and prints one JSON document. It takes no argument
that is a command, runs no shell, and puts no secret in its input or its log.

| Operation | What the helper does as root |
|---|---|
| `user.create` | `useradd --system --no-create-home --shell <nologin> --user-group goobster` when the account does not exist; creates missing mutable roots and hands each of them (`chown -R -h`) to that account. Refuses the superuser and system accounts, symbolic links in a root, and a root owned by someone else. |
| `service.register` | Writes `/etc/systemd/system/goobster.service`, runs `systemctl daemon-reload` and `systemctl enable --now goobster.service`. Refuses to overwrite a unit that is not this installation's (`SERVICE_FOREIGN`), to register a second unit for this installation (`SERVICE_DUPLICATE`), and to register one whose roots the service account cannot enter (`ROOT_NOT_REACHABLE`). |
| `service.unregister` | `systemctl disable --now`, deletes the unit file, `daemon-reload`, `reset-failed`. Acts only on a unit that carries this installation's marker. |
| `updater.disable` | Adoption only: disables the systemd timer, or comments out the line of a system cron file (`#goobster-manager-disabled: <line>`), that runs `auto-update.sh` for this code root. Acts on nothing else. |
| `package.install` | Not implemented on Linux (`NOT_IMPLEMENTED`). |

Every request names the installation id, and the helper checks it against the
installation record in the manager's store before it writes anything; the unit
carries an `X-Goobster-Installation=<id>` line that the helper checks again
before it overwrites or removes a unit.

### How it gets root

1. Already root: it runs the helper directly.
2. `sudo -n --` (never prompts; it needs passwordless sudo or credentials
   cached with `sudo -v` first).
3. `pkexec`, when a graphical session is present.
4. Neither works: the install does **not** fail. It records `ELEVATION_UNAVAILABLE`,
   finishes everything else, and prints the command that does the step by hand:

```bash
sudo '/opt/goobster/current/runtime/bin/node' '/opt/goobster/current/app/apps/manager/privileged/helper.js' < '<request file>'
```

Before an elevated start the manager checks the SHA-256 of the helper's files
and of the bundled Node against `payload-manifest.json`; a mismatch is
`HELPER_UNVERIFIED` and nothing is started. Each privileged operation writes a
`manager.privileged.<operation>` audit row (operation, outcome and names only;
never a path's contents, a secret or a command line).

## The service

After the payload is active the `register-service` step runs. With rights it:

1. creates the `goobster` account when you did not name another (`runtimeUser`
   in the answers file) and hands the mutable roots to it;
2. writes `<code root>/goobster.env`, the roots as plain `GOOBSTER_*` lines the
   launcher reads;
3. registers `goobster.service` and records it in `<manager store>/services.json`
   (`registeredBy: installer`).

The unit runs `<code>/current/bin/goobster-manager --supervise` as the service
account. The manager supervises the workers of the layout (standalone: the API),
restarts them, and performs staged restarts (`documentation/manager_lifecycle.md`).
The unit carries `ProtectSystem=strict` with one `ReadWritePaths=` per mutable
root (data, cache, logs, uploads, the manager store, the config directory),
`NoNewPrivileges=true`, `PrivateTmp=true`, `KillMode=mixed`,
`TimeoutStopSec=120` and `Restart=on-failure`. The code root is **not** writable
by the service: a payload is replaced by an operation run with rights, not by
the running service. `deploy/goobster.service` is the same unit for the
documented Raspberry Pi paths; `tests/linuxService.test.js` keeps it identical to
the renderer's output.

```bash
systemctl status goobster
journalctl -u goobster -f              # the service's output
ls /var/lib/goobster/logs              # the application's own log files (your logs root)
curl http://127.0.0.1:3100/health      # the standalone API
```

Installed as a person (not root), the service runs as **you** unless the answers
file names another `runtimeUser` that already exists (a warning,
`RUNS_AS_INVOKING_USER`, says so), and registering it needs `sudo` or `pkexec`.
Set `"registerService": false` in the answers file to install only the files; the
launcher still finds the roots (`goobster.env` is written either way).

If a unit named `goobster.service` exists that this installation did not write
(no marker), the installer leaves it alone and falls back to the manual manager.

## Manual manager

Where the service cannot be registered (no systemd, no administrator rights,
the installer was run as root without a runtime user, `registerService: false`)
the install is complete and exits 0, with the register-service step recorded as
`MANUAL_FALLBACK`. It prints:

```text
The service was not registered with the operating system (<reason>). The installation is complete; run the manager by hand:
  '<code root>/current/bin/goobster-manager' --supervise
To start it at boot, as an administrator:
  sudo install -m 0644 '<manager store>/goobster.service' /etc/systemd/system/goobster.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now goobster.service
```

`<manager store>/goobster.service` is the unit the installer would have
registered, already rendered for your paths. Unlike a registered unit it is not
recorded as the installer's: the installer will not remove it later. Running
`goobster-manager --supervise` from a terminal runs the workers as you.

## Repair, reconfigure, uninstall

Use the launcher inside the installation; it finds the roots from
`<code root>/goobster.env`:

```bash
sudo /opt/goobster/current/bin/goobster-manager status
sudo /opt/goobster/current/bin/goobster-manager repair      --answers repair.json      --yes
sudo /opt/goobster/current/bin/goobster-manager reconfigure --answers reconfigure.json --yes
sudo /opt/goobster/current/bin/goobster-manager uninstall   --answers uninstall.json   --yes
```

- `repair.json`: `{"source": "<an unpacked payload directory>", "release": {"allowUnsigned": true}}`.
  Repair re-stages the payload when the current one fails verification and
  re-applies the database schema; a healthy install reports `CURRENT_OK`.
- `reconfigure.json`: the layout, the roots or config values to change, for
  example `{"roots": {"logs": "/srv/goobster logs"}}`. When the roots change and
  the installer registered the service, the unit is rewritten and the service must
  be restarted (`sudo systemctl restart goobster`).
- `uninstall.json`: `{"keepData": true}` removes the service, the payload and
  the manager's ownership record and keeps the data, config, cache and logs.
  `{"keepData": false}` with `--delete-data --confirm <installation id>` also
  removes them. The installation id is `status`'s `installation` line.
  An uninstall leaves a `tombstone.json` in the data root so the host is not
  opened to a remote first claim; installing again over kept data works.

Run these as root for an installation whose code root is root-owned. Two things
follow from that: files the command creates in the service account's roots (a
tombstone, an operation record) are root-owned and the service cannot rewrite
them, so run `sudo chown -R goobster: '<manager store>'` after an operation
run as root on a registered installation; and uninstalling from the service's own
wizard page stops the service that is serving the page, so use the command
line for the uninstall of a registered service. An interrupted install (power
loss, `kill -9`) is finished by running the same command again.

## Adopting a Raspberry Pi install

An installation made by `scripts/install-rpi.sh` (a git checkout with `deploy/goobster.service`,
and usually the `auto-update.sh` timer or cron line) is adopted, not reinstalled:
`goobster-manager adopt` (`documentation/manager_install.md`, "The kinds"). The
installer registers nothing for a checkout; the existing unit is yours and stays
yours (it has no marker). Two updaters must not run at once, so adoption disables
the old one: a user cron line is commented out, and a systemd timer or a system
cron file is disabled with `updater.disable` (needs the helper). Where that is
not possible `scripts/auto-update.sh` exits on its own when the manager's store
says the manager is the updater (`goobster-manager-guard`); an old script without
that guard is `UPDATER_CONFLICT` and adoption refuses. `scripts/install-rpi.sh`
itself leaves an installation alone when the manager already owns it.

## Codes you may meet

| Code | Meaning and what to do |
|---|---|
| `MANUAL_FALLBACK` | Everything is installed; the service was not registered. Follow the printed commands. |
| `ELEVATION_UNAVAILABLE` | Neither sudo (without a prompt) nor pkexec was available. Run `sudo -v` and repeat, or run the printed by-hand command. |
| `ELEVATION_REFUSED` | The administrator declined the prompt. Same remedies. |
| `ELEVATION_REQUIRED` | An uninstall needs rights to remove the registered unit. Run the uninstall as root, or remove the unit by hand and run it again. |
| `HELPER_UNVERIFIED` | The helper files or the bundled Node do not match `payload-manifest.json`. Run `repair`. |
| `SERVICE_FOREIGN` | `goobster.service` exists and is not this installation's. Rename yours or remove it, then run `repair`. |
| `SERVICE_DUPLICATE` | Another unit of this installation is registered. Remove it first. |
| `SYSTEMD_UNAVAILABLE`, `SYSTEMD_NOT_INIT` | systemd is not the init system or is not running (a container, WSL). Use the manual manager. |
| `RUNTIME_USER_REQUIRED` | The installer would run the service as root. Name another account (`runtimeUser`) or run it as root with the default `goobster`. |
| `CREATE_USER_NEEDS_ROOT` | `createRuntimeUser` needs the installer to run as root. |
| `ROOT_NOT_REACHABLE` | The service account cannot enter a directory above a root (for example a root under a private home directory). `chmod o+x` the named directory, or choose roots elsewhere, then run again. |
| `ANSWERS_PERMISSIONS`, `ANSWERS_UNREADABLE`, `ANSWERS_INVALID`, `ANSWERS_SOURCE` | The answers file must be a regular file, mode 0600, owned by you, valid against the schema, with no foreign `source`. |
| `ALREADY_INSTALLED` | This host already has an installation. Use `repair`, `reconfigure` or `uninstall`. |
| `UPDATER_CONFLICT`, `UPDATER_NOT_OURS` | Adoption found a second updater it may not or cannot disable. |
| `SYSTEM_DEPENDENCY_MISSING` | A system package a selected feature uses is not installed; the feature reports itself unavailable until it is. |

## Building the artifacts

```bash
npm ci && npm run build:web
node scripts/package-runtime.js --target linux-x64 --out dist/payload --report-dir dist/reports --force --dev-sign
node scripts/package-bootstrap.js --target linux-x64 --payload dist/payload --out dist/bootstrap [--public-key <pem>] [--require-appimage]
```

`package-bootstrap.js` writes the `.run`, the AppImage (unless `--no-appimage`)
and `bootstrap-report-<target>.json`. The `.run` and the report are
deterministic: the same payload gives the same bytes (the archive times are
`SOURCE_DATE_EPOCH` or a fixed constant, entries are sorted, nothing carries a
timestamp or the build host). The AppImage is built by `appimagetool`, which is
**pinned by URL and SHA-256** (with its type 2 runtime) in `scripts/bootstrap-pins.json`;
nothing unpinned is ever executed. When the tool cannot be fetched or does not
match its hash the report says `APPIMAGE_SKIPPED` with a reason
(`NOT_REQUESTED`, `APPDIR_ONLY`, `HOST_ARCH_MISMATCH`, `TOOL_UNAVAILABLE`,
`TOOL_HASH_MISMATCH`, `APPIMAGETOOL_FAILED`), and `--require-appimage` turns a
skip into a failure. The runtime URL points at a rolling release, so its pin may
need refreshing when upstream publishes a new one. Run an AppImage on a machine
without FUSE with `APPIMAGE_EXTRACT_AND_RUN=1`.

The payload contains the manager (`bin/goobster-manager`, `apps/manager`); the
smoke check's `manager.launches` check proves the launcher starts from the
bundled Node with no system Node.

## What CI proves

`.github/workflows/linux-bootstrap.yml` builds the payload and both artifacts on
`ubuntu-24.04` and `ubuntu-24.04-arm`, checks the `.run` verifies and rebuilds
byte for byte, and runs `scripts/linux-bootstrap-proof.sh` as root on the
runner's real systemd:

- an install killed with `SIGKILL` during staging, then the same command
  finishing it;
- the roots contain spaces and the data root is a different tree from the code
  root; the service account owns the data and cannot write the code;
- `systemctl enable --now` leaves `goobster.service` active and enabled, the
  manager runs as `goobster`, `systemd-analyze verify` accepts the unit, `/health`
  answers, the manager listens on `127.0.0.1` only;
- running the install again changes nothing (one unit, still active);
- `repair`, `reconfigure` of the logs root (the unit is rewritten and the new root
  is in `ReadWritePaths`), a keep-data uninstall (unit gone, data kept), an install
  over the kept data, and a delete-data uninstall (nothing left);
- the AppImage prints its help and installs for a person (no root, no service),
  runs the manager from `<home>/code/current`, answers `/health` and uninstalls.

The same script runs with `--no-systemd` on a machine without a booted systemd
(a container, a Cloud Agent VM): the install then must end in the documented
manual fallback, the supervisor is started by hand as `goobster`, and every other
check runs. Only `systemctl enable --now` itself and the unit being managed by
systemd need the real workflow.

What is **not** proven: a signed release build (there is no release key yet),
an install through `pkexec`, `sudo` with a password prompt, SELinux enforcing
(AlmaLinux and Rocky run the same journey only through the packaging proof's
container smoke checks), distributions other than Ubuntu 24.04 for the service
journey, and the wizard's browser journey from the `.run` (the manager's
Playwright journeys cover the wizard itself).
