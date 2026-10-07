---
title: Installing Goobster on macOS - the .pkg, the per-user archive and the launchd service (installer P3.6)
kind: reference
summary: How to install, run, reconfigure, repair and remove Goobster on macOS (Apple silicon and Intel, macOS 13 or newer) with the installer package or the per-user archive - the artifacts and why every build here is labelled -dev, machine-wide versus per-user installs, the setup wizard and the headless answers-file install, the default roots, what the privileged helper runs as root (the three operations, how root is reached through sudo or the administrator prompt, the by-hand command when neither works), the LaunchDaemon, the LaunchAgent and the hidden _goobster account, logs, stop semantics, the manual-manager fallback, repair, reconfigure and uninstall, the result codes, how the artifacts are built, what the macOS CI journey proves and what signing and notarization are not yet done.
when: Installing Goobster on a Mac or a Mac mini server; running the installer without a browser; understanding what the installer does as root and what it never does; finding the launchd job, its logs or the _goobster account; removing an installation or moving its roots; building or auditing the macOS bootstrap artifacts.
tags: [installer, macos, launchd, bootstrapper, pkg, privileged-helper, service, headless, uninstall]
---

# Installing Goobster on macOS

Installer Phase 3 item 6 (issue #332, epic #315, ADR 0013 decision 9). Two
artifacts carry one release payload and start the installation manager's own
setup engine (`documentation/manager_install.md`):

- `goobster-<version>-darwin-<arch>[-dev].pkg`, the installer package. It lays
  the payload down under `/opt/goobster/stage/<version>`; its `postinstall`
  script starts the bootstrap entry (`apps/manager/bootstrap/darwin.js`), which
  installs through the setup engine. It targets a Mac that runs Goobster for
  everyone (a Mac mini server), or for one person who double-clicks it.
- `goobster-<version>-darwin-<arch>[-dev].tar.gz`, the per-user archive. Its
  `install.command` installs for your account only, with no administrator
  password.

Neither one copies files into the installation by itself. The bootstrap entry
checks the payload and points the manager's `install.new` operation (stage,
verify, atomic activation, the `register-service` step) at it. The result is the
same installation a `goobster-manager install` makes: `<code root>/current`
holds the payload, the manager's store records what was done, and an uninstall
removes only what the record names.

## Development builds

Every artifact built from this repository today is an **unsigned development
build**. The payload's manifest is signed with a throwaway key
(`scripts/package-runtime.js --dev-sign`), so the file name carries `-dev`, the
`postinstall` and `install.command` print a notice before they do anything, the
installer's welcome page says so, and the build report
(`bootstrap-report-darwin-<arch>.json`) records `"signed": false`. A `-dev` build
installs only into a machine you trust. A build is a release build only when
`payload-manifest.sig` verifies against the public key the builder was given
(`--public-key`), and production signing keys are not part of this repository
(#341).

The package itself is **not signed with a Developer ID and not notarized**, and
the binaries inside the payload are not code-signed. Gatekeeper therefore
refuses to open a downloaded `.pkg` or `install.command` by double-click; see
"Signing and notarization".

## Supported platforms

| | Supported | Not supported |
|---|---|---|
| macOS | 13 (Ventura) and newer; the package checks it (`allowed-os-versions` in its Distribution file) and `install.command` checks it too | 12 and older |
| Architectures | Apple silicon (`darwin-arm64`), Intel (`darwin-x64`) | A universal build; one package per architecture |

The package refuses to install on the other architecture
(`hostArchitectures`). An Intel build on Apple silicon runs through Rosetta 2
when it is installed; `install.command` says so.

System packages are the operator's job. The installer **reports** the system
dependencies the selected features use (`ffmpeg`, `python3`, `spotdl`, `yt-dlp`,
`ollama`) as `SYSTEM_DEPENDENCY_MISSING` warnings and never installs them: the
`package.install` privileged operation answers `NOT_IMPLEMENTED` on macOS.
For example `brew install ffmpeg yt-dlp`.

## Choosing how to install

| You have | Use |
|---|---|
| A Mac that runs Goobster for the whole machine (starts at boot, no login needed) | The `.pkg`, with `/etc/goobster-answers.json` in place first (headless, machine-wide) |
| A Mac you use yourself | The `.pkg` with no answers file (the wizard, per user), or `install.command` |
| A script, a provisioning tool, CI | `sudo installer -pkg ... -target /` with the answers file, or `install.command --headless --answers <file>` |

**Machine versus per user.** There are exactly two shapes.

| | Machine | Per user |
|---|---|---|
| Who installs it | root, headless only | the person, wizard or headless |
| Service | a LaunchDaemon, started at boot | a LaunchAgent, running while the person is logged in |
| Runs as | the hidden `_goobster` account | the person |
| Roots | `/opt/goobster` (or your own, in the answers file) | `~/Library/Application Support/Goobster` |
| Creates an account | yes, `_goobster` (only a root-run installer can) | no |

The setup wizard and the manager **never run as root**. Run as root, the
bootstrap entry refuses the wizard (`WIZARD_AS_ROOT`, exit 3) and `--per-user`
(`USAGE`, exit 2).

### Installing with the package

Double-click the `.pkg` (or `sudo installer -pkg goobster-*.pkg -target /`).
What happens next depends on one file:

1. `/etc/goobster-answers.json` exists: the **machine-wide headless install**,
   run once, as root, inside the package's `postinstall`. The file must be a
   regular file (not a link), owned by root, mode 0600; anything else stops the
   install before it starts and nothing is changed.
2. No such file: the `postinstall` starts the **wizard for the person at the
   console** (`launchctl asuser <uid> sudo -u <user> ...`), per user, and opens
   it in their browser. With nobody logged in it writes the command to start it
   later to `/var/log/goobster-install.log` and ends.

The package leaves an unpacked copy of the release under
`/opt/goobster/stage/<version>` (root-owned, not writable by anyone else). A
successful headless install removes it; the wizard path keeps it until the
wizard has finished with it. The installer's log is
`/var/log/goobster-install.log`; the wizard's output goes to
`/var/log/goobster-wizard.log`. Neither holds a password, token or answer value.

### The per-user archive

```bash
tar -xzf goobster-1.0.0-darwin-arm64-dev.tar.gz
cd goobster-1.0.0-darwin-arm64-dev
./install.command                                   # the wizard, per user
./install.command --headless --answers answers.json --yes
```

`install.command` refuses to run as root or on another operating system or
architecture, checks the macOS version, and starts the bundled Node with
`bootstrap/darwin.js ... --per-user`. A development archive downloaded with a
browser carries the quarantine mark and Gatekeeper refuses its programs; clear
it for this folder first: `xattr -dr com.apple.quarantine <folder>`.

Options (the `postinstall` and `install.command` take the same ones after the
entry's own):

| Option | Meaning |
|---|---|
| `--headless --answers <file>` | Install without a browser. The file is the CLI's answers JSON (`apps/manager/install/answers.schema.json`), mode 0600, owned by the account that runs the installer. |
| `--base <dir>` | Put every root under `<dir>` (`code/`, `data/`, `config/`, `cache/`, `logs/`). |
| `--per-user` | Install for the person who runs it (never with root). Implied by `install.command`. |
| `--open-browser` | Open the wizard with `/usr/bin/open` (`install.command` does this unless you pass `--no-open`). |
| `--yes --json --dry-run` | Forwarded to the install CLI in headless mode (`--dry-run` shows the plan and writes nothing). |
| `--help` | Print the usage and stop. |

Exit codes of the bootstrap entry: 0 done, 1 unexpected, 2 invalid input (bad
answers file, `--per-user` as root), 3 refused (the wizard found an existing
installation, `ALREADY_INSTALLED`; port 3400 is busy, `PORT_BUSY`; the wizard as
root, `WIZARD_AS_ROOT`), 4 the payload is not the one the installer was built
with (`PAYLOAD_DIGEST_MISMATCH`), 5 the install finished but a step that needs
a privileged helper was deferred. `install.command` itself exits 3 on a wrong
system, root or an old macOS and 4 when the folder is incomplete.

### The wizard

The entry starts the manager from the unpacked payload on `127.0.0.1:3400`,
opens it, and prints the address. The page is the setup wizard of
`documentation/setup_wizard.md`; the manager prints where it wrote the one-time
setup credential (`<manager store>/bootstrap-credential`, owner only, valid 15
minutes) and the Welcome step asks for it. The entry waits for an applied
`install.new`, prints the outcome and stops **its own** manager. Closing the
terminal or pressing Ctrl-C leaves without touching any service. Nothing here
binds beyond the loopback address, opens a firewall port or changes one; there
is no firewall rule and no LAN bind. The standalone API of an installation
listens on port 3100 as it always has; put it behind your reverse proxy or the
macOS firewall as you would any Goobster installation.

A wizard already holding port 3400 (or an installed manager running there) is
reported as `PORT_BUSY` before anything is written.

### Headless

```bash
sudo tee /etc/goobster-answers.json > /dev/null <<'EOF'
{
  "ownerLabel": "my mac mini",
  "features": ["core", "knowledge", "music"],
  "config": [{ "id": "webapp.publicUrl", "value": "https://goobster.example.org" }]
}
EOF
sudo chown root:wheel /etc/goobster-answers.json
sudo chmod 600 /etc/goobster-answers.json
sudo installer -pkg goobster-1.0.0-darwin-arm64-dev.pkg -target /
```

The installer fills in what the file leaves out: `source` is the embedded
payload (a different `source` is refused with `ANSWERS_SOURCE`), `layout` is
`standalone`, `roots` are the defaults below, `release` accepts the payload's
own signature (a `-dev` build allows an unsigned payload; a release build
requires its key). Run as root it also names the service account
(`runtimeUser: _goobster`) and asks for it to be created; any field you set
wins. A second run with the same file finds nothing to change.

Remove `/etc/goobster-answers.json` afterwards if it holds anything you would
rather not keep on disk; the installer does not delete it (a re-run needs it).

The installer copies the merged answers to a 0600 file in a 0700 temporary
directory, passes that to the CLI and deletes it.

### Default roots

| Root | Machine (root) | Per user |
|---|---|---|
| code | `/opt/goobster/code` | `~/Library/Application Support/Goobster/code` |
| data | `/opt/goobster/data` | `<base>/data` |
| config | `/opt/goobster/config/config.json` | `<base>/config/config.json` |
| cache | `/opt/goobster/cache` | `<base>/cache` |
| logs | `/opt/goobster/logs` | `<base>/logs` |
| manager store | `/opt/goobster/data/manager` | `<base>/data/manager` |

The code root is the only one that is replaced on an update. Data, config and
the manager's store are never read, written or moved by a payload change, so
the data root may live on another volume, and every directory name may contain
spaces and non-ASCII letters (the CI journey installs into a path that has
both). Mutable roots are outside the signed files: the payload is read-only to
the service. The installer creates missing parent directories searchable
(`0755`) so the service account can reach the roots; the roots themselves are
`0750` or `0700` and owned by that account. A machine install with roots under a
person's home folder is refused (`ROOT_NOT_REACHABLE` when the account cannot
enter it, `ROOT_IS_HOME` when it holds the home of whoever asked); put the roots
under `/opt`, `/Users/Shared` or a volume.

## What runs as root

The installer runs as you (or, in the package, as root for the one headless
run). It asks for administrator rights only for the operations in a closed
list, through a small **privileged helper** (`apps/manager/privileged/`): one
Node.js process that reads one JSON document and prints one JSON document. It
takes no argument that is a command, runs no shell, and puts no secret in its
input or its log.

| Operation | What the helper does as root |
|---|---|
| `user.create` | Creates the hidden `_goobster` account and group with `dscl` when it does not exist: the first free UniqueID in 200-400 (also the group's), shell `/usr/bin/false`, `IsHidden 1`, no password. Creates missing mutable roots and hands each of them (`chown -R -h`) to that account. Refuses the superuser and system accounts, symbolic links in a root, a root owned by someone else, a root that is (or holds) the home directory of the person who asked (`ROOT_IS_HOME`), and a full UniqueID range (`ACCOUNT_ID_EXHAUSTED`). |
| `service.register` | Machine scope: writes `/Library/LaunchDaemons/io.goobster.goobster.plist` (root:wheel, 0644) and runs `launchctl bootstrap system <plist>` and `launchctl enable system/io.goobster.goobster`. User scope: the same for `~/Library/LaunchAgents/io.goobster.goobster.plist` in `gui/<uid>`, run by the person with no elevation. Refuses a plist that is not this installation's (`SERVICE_FOREIGN`), a second job of this installation (`SERVICE_DUPLICATE`), roots the account cannot enter (`ROOT_NOT_REACHABLE`) and a code root that someone other than root could write (`CODE_ROOT_NOT_SEALED`). |
| `service.unregister` | `launchctl bootout` of the job, waits for it to stop, deletes the plist. Acts only on a plist that carries this installation's marker (`X-Goobster-Installation`), in either scope. |
| `updater.disable`, `package.install` | Not implemented on macOS (`NOT_IMPLEMENTED`). |

Every request names the installation id, and the helper checks it against the
installation record in the manager's store before it writes anything. The
plist carries a top-level `X-Goobster-Installation` string (launchd ignores
keys it does not know) that the helper checks again before it overwrites or
removes a plist. It never touches any other job.

### How it gets root

1. Already root (the package's `postinstall`, `sudo goobster-manager ...`): it
   runs the helper directly.
2. `sudo -n --` (never prompts; it needs passwordless sudo or credentials
   cached with `sudo -v` first).
3. The administrator prompt of the logged-in graphical session: the manager
   runs `/usr/bin/osascript -e 'do shell script "<node> <helper> --request <file>" with administrator privileges'`.
   That is the one fixed command the manager builds as a string; its only
   variable parts are validated absolute paths, quoted, and one integer. The
   request and the reply travel in files (`osascript` cannot pass a pipe): the
   request is written 0600 under `<manager store>/requests/`, the reply file is
   created 0600 by you before the prompt, so root writes into a file you can
   read back.
4. None of these works: the install does **not** fail. It records
   `ELEVATION_UNAVAILABLE` (the reason it carries is `NO_ELEVATION_TOOL`), finishes everything else and prints the command that
   does the step by hand:

```bash
sudo '/opt/goobster/code/current/runtime/bin/node' '/opt/goobster/code/current/app/apps/manager/privileged/helper.js' < '<request file>'
```

A per-user registration needs none of this: the helper runs as you. Before an
elevated start the manager checks the SHA-256 of the helper's files and of the
bundled Node against `payload-manifest.json`; a mismatch is `HELPER_UNVERIFIED`
and nothing is started. Each privileged operation writes a
`manager.privileged.<operation>` audit row (operation, outcome and names only;
never a path's contents, a secret or a command line).

## The service

After the payload is active the `register-service` step runs. With rights it:

1. creates the `_goobster` account (machine install) and hands the mutable roots
   to it;
2. writes `<code root>/goobster.env`, the roots as plain `GOOBSTER_*` lines the
   launcher reads;
3. registers the job `io.goobster.goobster` and records it in
   `<manager store>/services.json` (`registeredBy: installer`).

The job runs `<code>/current/bin/goobster-manager --supervise`. The manager
supervises the workers of the layout (standalone: the API), restarts them, and
performs staged restarts (`documentation/manager_lifecycle.md`).

| Key of the plist | Value |
|---|---|
| `Label` | `io.goobster.goobster` |
| `X-Goobster-Installation` | the installation id |
| `UserName` | `_goobster` (machine scope only; an agent runs as the person) |
| `RunAtLoad` | true |
| `KeepAlive` | `{ SuccessfulExit = false }`: launchd restarts the manager when it exits with a failure or is killed, and leaves it stopped after a clean exit |
| `ThrottleInterval` | 10 seconds between starts |
| `ExitTimeOut` | 120 seconds: how long launchd waits after `SIGTERM` before it sends `SIGKILL` |
| `WorkingDirectory`, `EnvironmentVariables` | the code root and the roots, as `goobster.env` |
| `StandardOutPath`, `StandardErrorPath` | `<logs root>/goobster-launchd.out.log` and `.err.log` |

The plist is written by hand (no DOCTYPE, so nothing in the file names a URL)
and every value is escaped. The code root is **not** writable by the service: a
payload is replaced by an operation run with rights, not by the running service.

```bash
sudo launchctl print system/io.goobster.goobster         # state, pid, the account (machine)
launchctl print gui/$(id -u)/io.goobster.goobster        # per-user
ls /opt/goobster/logs                                    # your logs root: launchd's two files and the application's own
curl http://127.0.0.1:3100/health                        # the standalone API
```

**Stop semantics.** launchd sends `SIGTERM` to the manager only (not to a whole
process group); the manager drains its workers and stops them itself. launchd
waits `ExitTimeOut` (120 s) before `SIGKILL`. `launchctl bootout` (the
uninstall, a reconfigure) waits for that, so the helper allows up to 100
seconds and then reports `SERVICE_STILL_ACTIVE` rather than delete a plist of
a job that is still running.

**The `_goobster` account.** It is a hidden role account: UniqueID between 200
and 400, shell `/usr/bin/false`, no password, no home folder (its
`NFSHomeDirectory` is the data root's parent), not shown at the login window.
The uninstall **never deletes it**, not even with `--delete-data`: removing an
account is a separate decision (files elsewhere may still belong to it), and
the privileged protocol has no operation for it. By default the account stays;
to remove it, by hand and after the uninstall:

```bash
sudo dscl . -delete /Users/_goobster
sudo dscl . -delete /Groups/_goobster
```

Installed as a person, the job runs as **you** and needs no account. A machine
install run by a person with `sudo -n` or the administrator prompt uses the
account named by `runtimeUser` in the answers file (or `_goobster` when it
asks for it to be created).

Set `"registerService": false` in the answers file to install only the files;
the launcher still finds the roots (`goobster.env` is written either way).

If a plist named `io.goobster.goobster.plist` exists that this installation did
not write (no marker), the installer leaves it alone and falls back to the
manual manager (`SERVICE_FOREIGN`).

The register and unregister steps are not launchd's own: `serviceLifecycle.js`
registers and unregisters whatever **service kind** the platform names
(`serviceKinds.kindForPlatform()`). `launchdService.js` is the macOS
definition (kind `launchd`, platform `darwin`, one definition for both scopes:
`registerInput` carries `scope: machine|user`, chosen by whether the installer
is root), built on `launchdPlist.js` (the pure text builder); on the helper's
side `privileged/darwin.js` is the platform module (`IMPLEMENTED.darwin` is
`service.register`, `service.unregister`, `user.create`).

## Manual manager

Where the service cannot be registered (no launchd for the scope, no
administrator rights, `registerService: false`) the install is complete and
exits 0, with the register-service step recorded as `MANUAL_FALLBACK`. It
prints the command to run the manager by hand and, for a machine job:

```text
  sudo install -m 0644 -o root -g wheel '<manager store>/io.goobster.goobster.plist' '/Library/LaunchDaemons/io.goobster.goobster.plist'
  sudo launchctl bootstrap system '/Library/LaunchDaemons/io.goobster.goobster.plist'
```

(for an agent: `install -m 0644 ... ~/Library/LaunchAgents/...` and
`launchctl bootstrap "gui/$(id -u)" ...`). `<manager store>/io.goobster.goobster.plist`
is the plist the installer would have registered, already rendered for your
paths. Unlike a registered job it is not recorded as the installer's: the
installer will not remove it later. Running `goobster-manager --supervise` from
a terminal runs the workers as you.

## Repair, reconfigure, uninstall

Use the launcher inside the installation; it finds the roots from
`<code root>/goobster.env`:

```bash
sudo /opt/goobster/code/current/bin/goobster-manager status
sudo /opt/goobster/code/current/bin/goobster-manager repair      --answers repair.json      --yes
sudo /opt/goobster/code/current/bin/goobster-manager reconfigure --answers reconfigure.json --yes
sudo /opt/goobster/code/current/bin/goobster-manager uninstall   --answers uninstall.json   --yes
```

For a per-user install run the launcher in `<base>/code/current/bin/` as
yourself, without `sudo`.

- `repair.json`: `{"source": "<an unpacked payload directory>", "release": {"allowUnsigned": true}}`.
  Repair re-stages the payload when the current one fails verification and
  re-applies the database schema; a healthy install reports `CURRENT_OK`.
- `reconfigure.json`: the layout, the roots or config values to change, for
  example `{"roots": {"logs": "/opt/goobster/logs moved"}}`. When the roots
  change and the installer registered the job, the plist is rewritten and the
  daemon is restarted (`sudo launchctl kickstart -k system/io.goobster.goobster`
  if it does not restart by itself); the privileged helper creates the new root
  and hands it to the service account.
- `uninstall.json`: `{"keepData": true}` removes the job, the payload and the
  manager's ownership record and keeps the data, config, cache and logs.
  `{"keepData": false}` with `--delete-data --confirm <installation id>` also
  removes them. The installation id is `status`'s `installation` line. An
  uninstall leaves a `tombstone.json` in the data root so the host is not
  opened to a remote first claim; installing again over kept data works. The
  `_goobster` account stays either way (see "The service").

Run the machine commands as root. Two things follow: files the command creates
in the service account's roots (a tombstone, an operation record) are
root-owned, so run `sudo chown -R _goobster '<manager store>'` after an operation
run as root on a registered installation; and uninstalling from the service's
own wizard page stops the service that is serving the page, so use the command
line for the uninstall of a registered service. An interrupted install (power
loss, `kill -9`) is finished by running the same command again.

Nothing the installer does changes any other launchd job: it never lists,
loads or removes a job whose plist lacks its marker.

## Codes you may meet

| Code | Meaning and what to do |
|---|---|
| `MANUAL_FALLBACK` | Everything is installed; the service was not registered. Follow the printed commands. |
| `ELEVATION_UNAVAILABLE` | Neither `sudo -n` nor a graphical session was available (`NO_ELEVATION_TOOL`). Run `sudo -v` and repeat, or run the printed by-hand command. |
| `ELEVATION_DECLINED`, `ELEVATION_REFUSED` | The administrator cancelled the prompt, or the password or the account was refused. Same remedies. |
| `ELEVATION_REQUIRED` | An uninstall needs rights to remove the registered job. Run it as root, or remove the plist by hand (`removeByHand`) and run it again. |
| `HELPER_UNVERIFIED` | The helper files or the bundled Node do not match `payload-manifest.json`. Run `repair`. |
| `SERVICE_FOREIGN` | `io.goobster.goobster.plist` exists and is not this installation's. Rename yours or remove it, then run `repair`. |
| `SERVICE_DUPLICATE` | Another job of this installation is registered. Remove it first. |
| `SERVICE_STILL_ACTIVE` | The job did not stop within the wait after `bootout`; nothing was deleted. Run the uninstall again. |
| `LAUNCHD_UNAVAILABLE` | `launchctl` or the target domain is not reachable (an SSH session with no GUI login for a per-user job). Use the manual manager. |
| `COMMAND_FAILED` | A fixed system command (`launchctl`, `dscl`) exited non-zero; the reason names the program, never its arguments' values. |
| `RUNTIME_USER_REQUIRED` | The installer would run the service as root. Name another account (`runtimeUser`) or run it as root with the default `_goobster`. |
| `CREATE_USER_NEEDS_ROOT` | `createRuntimeUser` needs the installer to run as root. |
| `RUNTIME_USER_MISSING`, `RUNTIME_USER_MISMATCH`, `USER_INCOMPLETE`, `USER_REFUSED` | The account the request names does not exist, is not the one the plist names, is half created, or is one the helper refuses to touch (root, a system account, a real person's account). |
| `ACCOUNT_ID_EXHAUSTED` | Every UniqueID from 200 to 400 is taken. |
| `ROOT_NOT_REACHABLE` | The service account cannot enter a directory above a root (a root under a private home folder). `chmod o+x` the named directory, or choose roots elsewhere, then run again. |
| `ROOT_IS_HOME`, `ROOT_IS_SYMLINK`, `ROOT_NOT_OWNED` | A root is your home folder or lies above it; is, or holds, a symbolic link; or belongs to someone else. Choose roots under a directory of their own (`--base <dir>`). |
| `CODE_ROOT_NOT_SEALED` | The code root (or a parent) can be written by someone other than root, which the daemon would execute. Fix the owner and mode, or use a per-user install. |
| `AGENT_AS_ROOT`, `NOT_ELEVATED`, `INSTALLATION_MISMATCH`, `PAYLOAD_MISSING` | The helper refused: a user-scope job asked of root, a machine operation without root, an installation id that is not the recorded one, or a payload that is not at the code root. |
| `WIZARD_AS_ROOT`, `PORT_BUSY`, `PAYLOAD_DIGEST_MISMATCH` | The bootstrap entry's refusals; see "Exit codes". |
| `ANSWERS_PERMISSIONS`, `ANSWERS_UNREADABLE`, `ANSWERS_INVALID`, `ANSWERS_SOURCE` | The answers file must be a regular file, mode 0600, owned by you (root for `/etc/goobster-answers.json`), valid against the schema, with no foreign `source`. |
| `ALREADY_INSTALLED` | This host already has an installation. Use `repair`, `reconfigure` or `uninstall`. |
| `SYSTEM_DEPENDENCY_MISSING` | A system package a selected feature uses is not installed; the feature reports itself unavailable until it is. |

## Building the artifacts

The payload must be built on a Mac of the same architecture:
`package-runtime.js` does not cross-build, and `pkgbuild`/`productbuild` exist
only on macOS.

```bash
npm ci && npm run build:web
node scripts/package-runtime.js --target darwin-arm64 --out dist/payload --report-dir dist/reports --force --dev-sign
node scripts/package-bootstrap-darwin.js --target darwin-arm64 --payload dist/payload --out dist/bootstrap [--public-key <pem>] [--require-pkg]
```

`package-bootstrap-darwin.js` writes the tar.gz, the tree the package is built
from (`macos-pkg-<arch>/`: `Distribution.xml`, `scripts/postinstall`,
`resources/`, the staged payload), `bootstrap-report-darwin-<arch>.json`
and, on a Mac, the `.pkg`. The tar.gz, the tree and the report are
deterministic: the same payload gives the same bytes. The `.pkg` is not
(`pkgbuild` stamps it). Where `pkgbuild` or `productbuild` is missing the
report says `PKG_SKIPPED` with a reason (`TOOL_MISSING`, `NOT_REQUESTED`,
`FOREIGN_PAYLOAD`, `PKGBUILD_FAILED`, `PRODUCTBUILD_FAILED`, `PRODUCTSIGN_FAILED`,
`NOTARIZATION_FAILED`, `STAPLE_FAILED`) and
`--require-pkg` turns the skip into a failure. The tools are looked up only in
absolute directories of `PATH`.

`--allow-foreign-payload` lets the packager's own tests use a payload built for
another target (a Linux payload on a Linux machine); the output is labelled
`FOREIGN PAYLOAD`, never reports a signature and never builds the package.

The package is made with `pkgbuild --root <stage> --identifier io.goobster.pkg --version <version> --install-location / --ownership recommended --scripts <scripts>` and
`productbuild --distribution Distribution.xml --resources resources --package-path <dir>`.
The Distribution file requires macOS 13, names the one architecture
(`hostArchitectures`) and installs for the local system only.

## Signing and notarization

Not done. The wiring exists and is **off by default**; it is installer plan
item P5.1 (#341) and needs a Developer ID Installer identity, which this
repository does not hold:

- `--product-sign <identity>` runs `productsign --sign <identity>` on the
  package.
- `--notary-profile <name>` runs `xcrun notarytool submit --keychain-profile <name> --wait`
  and `xcrun stapler staple`.
- Neither signs the payload's own files. Code-signing the Node binary and native
  addons (hardened runtime, entitlements) happens in the payload build,
  before the manifest is signed.

Until then every artifact is a `-dev` build and macOS Gatekeeper will refuse to
open a downloaded one: right-click and choose Open, run
`sudo installer -pkg ... -target /` (which does not apply Gatekeeper), or clear
the quarantine mark with `xattr -dr com.apple.quarantine <file>`.

## What CI proves

`.github/workflows/macos-bootstrap.yml` builds the payload and both artifacts
on `macos-15` (Apple silicon) and `macos-15-intel` (the Intel leg is skipped
when the repository variable `PACKAGING_PROOF_DARWIN_X64` is `false` or the
manual run unticks it), checks the package expands and the archive rebuilds
byte for byte, and runs `scripts/macos-bootstrap-proof.sh` as root on the
runner's real launchd:

- a busy port 3400 is reported (`PORT_BUSY`) and the wizard as root is refused;
  a world-readable `/etc/goobster-answers.json` stops the package before
  anything is installed;
- `sudo installer -pkg ... -target /` with the answers file, the roots in a
  path that has a space and a non-ASCII letter and a data root that is a
  different tree from the code root: the daemon is bootstrapped and
  `launchctl print` shows it running as `_goobster`; the plist is root:wheel
  0644 and `plutil -lint` accepts it; the manager answers on `127.0.0.1:3400`
  (loopback only) and `/health` answers from the standalone API; the account
  owns the data and cannot write the code;
- running the install again changes nothing (one plist, the same account, still
  running);
- `SIGKILL` of the manager: launchd restarts it and the API answers again;
- `repair`; `reconfigure` of the logs root (the plist is rewritten and still
  valid); a keep-data uninstall (daemon and plist gone, data kept, the
  `_goobster` account stays); an install over the kept data; a delete-data
  uninstall (nothing left, the account still stays); the two `dscl` commands
  above remove the account;
- the per-user archive: `install.command` refuses root, installs for the
  runner account (a LaunchAgent in `gui/<uid>`, no daemon, no `_goobster`),
  `/health` answers, a second wizard is refused (`ALREADY_INSTALLED`), and the
  uninstall removes the agent and its data;
- the labels `launchctl print system` shows (Apple's and ours aside) and the
  files in `/Library/LaunchDaemons` and `/Library/LaunchAgents` are identical
  before and after.

The unit tests (`tests/launchdService.test.js`, `tests/darwinHelper.test.js`,
`tests/darwinBootstrapCli.test.js`, `tests/darwinBootstrapStage.test.js`) drive
the same code on any machine through injected command runners and fake
executables; they cannot prove `launchctl`, `dscl`, `pkgbuild` or `installer`
themselves, which is what the workflow is for.

What is **not** proven: a signed or notarized build (see above), an install
through the administrator prompt (`osascript`, which needs a person to type a
password), `sudo` with a password prompt, macOS 13 and 14 (the runners are
macOS 15), a Mac with a managed or MDM-restricted configuration, the wizard's
browser journey from the package (the manager's Playwright journeys cover the
wizard itself), and a per-user install while the person is logged out.
