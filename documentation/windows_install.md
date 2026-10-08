---
title: Installing Goobster on Windows - the NSIS installer and the Windows service (installer P3.5)
kind: reference
summary: How to install, run, reconfigure, repair and remove Goobster on Windows x64 with the NSIS installer - the artifact and why every build here is labelled -dev and unsigned, the platform baseline, the setup wizard in the browser and the silent answers-file install (/S /ANSWERS=), the default roots, what runs elevated (only service registration and removal, through UAC or an administrator session, with a file transport and hash-checked helper files), the Windows service (WinSW host, the NT SERVICE\goobster virtual account, ACLs, restart on failure, graceful stop, logs, no firewall changes), the manual-manager fallback, repair, reconfigure and uninstall from Programs and Features, the result codes, how the installer is built and what the windows-2022 CI journey proves and does not.
when: Installing Goobster on a Windows PC or server; running the installer without a window; understanding what the installer does as administrator and what it never does; finding the service, its logs or its definition; removing an installation or moving its roots; building or auditing the Windows installer.
tags: [installer, windows, nsis, winsw, windows-service, uac, privileged-helper, headless, uninstall, bootstrapper]
---

# Installing Goobster on Windows

Installer Phase 3 item 5, Windows part (issue #331, epic #315, ADR 0013
decision 9). One artifact carries one release payload and starts the
installation manager's own setup engine (`documentation/manager_install.md`):

- `goobster-<version>-win32-x64[-dev].exe`, an NSIS installer. It runs as you
  (`RequestExecutionLevel user`), needs no administrator rights to start, and
  opens the setup wizard in your browser. Run with `/S /ANSWERS=<file>` it
  installs without any window.

The `.exe` does not copy files into the installation itself. It unpacks the
embedded payload and the pinned service host into
`%LOCALAPPDATA%\Goobster\stage\<version>`, checks the payload, and points the
manager's `install.new` operation (stage, verify, atomic activation, the
`register-service` step) at it. The result is the installation a
`goobster-manager install` makes: `<code root>\current` holds the payload, the
manager's store records what was done, and an uninstall removes only what the
record names. The Windows service is the only thing that needs an
administrator.

## Development builds

Every artifact built from this repository today is an **unsigned development
build**. The payload's manifest is signed with a throwaway key
(`scripts/package-runtime.js --dev-sign`) and the `.exe` itself is not
Authenticode-signed, so the file name carries `-dev`, the installer's version
resource says `UNSIGNED DEVELOPMENT BUILD`, Windows SmartScreen will warn when
you start it, and `bootstrap-report-win32-x64.json` records `"signed": false`.
A `-dev` build installs only on a machine you trust. A build is a release build
only when `payload-manifest.sig` verifies against the public key the builder
was given (`--public-key`); production keys and a code-signing certificate are
not part of this repository ([release.md](release.md), #341). The signing hook exists and is off (see
"Building the installer").

## Supported platforms

| | Supported | Not supported |
|---|---|---|
| Windows | Windows 10 (1809 or newer), Windows 11, Windows Server 2019 and newer, x64 | 32-bit Windows, Windows on Arm (build for it separately), Windows 8.1 and older |

The baseline is the bundled Node.js 22's own. What is **exercised** is Windows
Server 2022 on GitHub's `windows-2022` runner (see "What CI proves"); the other
versions are expected to work and are not tested here.

System programs the selected features use (`ffmpeg`, `python`, `yt-dlp`,
`ollama`) are the operator's job: the installer reports them as
`SYSTEM_DEPENDENCY_MISSING` warnings and never installs them (`package.install`
is `NOT_IMPLEMENTED` on Windows).

## Choosing how to install

| You have | Use |
|---|---|
| A PC at which you sit | Double-click the `.exe`: the wizard opens in your browser |
| A server you reach over RDP | The same; the wizard is on `127.0.0.1:3400` of that machine |
| A script, a provisioning tool, CI | `goobster-*.exe /S /ANSWERS=<file>` |

Switches of the `.exe` (NSIS syntax; quote every path, as below):

| Switch | Meaning |
|---|---|
| `/S` | Silent: no window, no browser. Needs `/ANSWERS=`. |
| `/ANSWERS="<file>"` | The CLI's answers JSON (`apps/manager/install/answers.schema.json`). |
| `/BASE="<dir>"` | Put every root under `<dir>` (`code\`, `data\`, `config\`, `cache\`, `logs\`) and keep the installer's own files (`stage\`, `uninstall\`, `install.log`) there too. Must be a full drive path. |
| `/LOG="<file>"` | Where an unattended install writes what it prints (default `<base>\install.log`; the `.exe` has no console). |

The `.exe` refuses a switch value that holds `"`, `%`, `&`, `|`, `<`, `>`, `^`
or `!` (exit 2) because those would change how a command line is read. Always
put the value in double quotes: NSIS reads an unquoted value up to the next
space, and a bare `'` or backtick in it starts a quote the parser never closes.

A silent `.exe` returns to the prompt at once unless you wait for it:

```bat
start /wait "" goobster-1.0.0-win32-x64-dev.exe /S /ANSWERS="C:\provision\answers.json" /BASE="D:\Goobster"
echo %ERRORLEVEL%
```

```powershell
$p = Start-Process .\goobster-1.0.0-win32-x64-dev.exe -ArgumentList '/S /ANSWERS="C:\provision\answers.json"' -Wait -PassThru
$p.ExitCode
```

Exit codes of a silent install are the manager's: 0 done, 1 unexpected (or the
payload could not be unpacked), 2 invalid input (bad switch, bad answers file),
3 refused (an installation already exists), 4 the payload is not the one the
installer was built with (`PAYLOAD_DIGEST_MISMATCH`, nothing was installed), 5
the install finished but a step needs the privileged helper. A normal
(wizard) start returns 0 once the wizard is on its way.

### The wizard

Without `/S` the `.exe` shows its unpacking progress, then starts the manager
from the unpacked payload on `127.0.0.1:3400` in a console window that prints
the address and opens it in your browser:

```text
Open the Goobster install wizard: http://127.0.0.1:3400/manager/
Press Ctrl-C (or close this window) to leave; nothing already registered with Windows is stopped.
```

The page is the setup wizard of `documentation/setup_wizard.md`. The manager
prints where it wrote the one-time setup credential
(`<manager store>\bootstrap-credential`, valid 15 minutes) and the Welcome step
asks for it. The installer waits for an applied `install.new`, prints the
outcome (the service, or the manual-manager commands) and stops **its own**
manager. Closing the window leaves without touching any service. The wizard's
manager holds port 3400 until it stops, so the service's manager takes the port
on its first retry (the service restarts it after 10 seconds).

Nothing here binds beyond the loopback address, opens a firewall port or
changes the firewall (`netsh advfirewall` is never run). The standalone API
listens on port 3100 as it always has; put it behind your reverse proxy or
firewall as you would any Goobster installation. Another program on port 3400
shows up as the manager's `PORT_IN_USE` preflight result.

### Headless

```json
{
  "ownerLabel": "my server",
  "features": ["core", "knowledge", "music"],
  "roots": {
    "code": "D:\\Goobster apps\\code",
    "data": "E:\\Goobster data\\data",
    "config": "E:\\Goobster data\\config\\config.json",
    "cache": "E:\\Goobster data\\cache",
    "logs": "E:\\Goobster data\\logs",
    "managerStore": "E:\\Goobster data\\data\\manager"
  }
}
```

The installer fills in what the file leaves out: `source` is the embedded
payload (a different `source` is refused with `ANSWERS_SOURCE`), `layout` is
`standalone` (the payload carries no Discord bot), `roots` are the defaults
below, `release` accepts the payload's own signature (a `-dev` build allows an
unsigned payload; a release build requires its key). It never asks for an
account: Windows gives the service its own (see "The service"). Any field you
set wins. A second run with the same file finds nothing to change.

Windows does not check the answers file's permissions the way the Linux
installer does (mode 0600): keep it in a folder only you and administrators can
read. The installer copies the merged answers to a private file under
`%TEMP%` and deletes it afterwards.

### Default roots

| Root | Started normally (your account) | Started with "Run as administrator" |
|---|---|---|
| base | `%LOCALAPPDATA%\Goobster` | `%ProgramData%\Goobster` |
| code | `<base>\code` | `<base>\code` |
| data | `<base>\data` | `<base>\data` |
| config | `<base>\config\config.json` | `<base>\config\config.json` |
| cache | `<base>\cache` | `<base>\cache` |
| logs | `<base>\logs` | `<base>\logs` |
| manager store | `<base>\data\manager` | `<base>\data\manager` |

`/BASE=` or `roots` in the answers file override these. The code root is the
only one replaced on an update; data, config and the manager's store are never
read, written or moved by a payload change, so the data root may live on
another drive and every folder name may contain spaces.

Inside the code root, `current` and `previous` are **directory junctions**
on Windows, not folders: each activated payload lives under `<code>\live\`,
and an install, update or rollback swaps the junction rather than renaming
the folder the running manager and its workers hold open (Windows refuses
to rename a directory with an open handle beneath it; a junction holds
nothing open, and the running program keeps its handles on the old payload
until it exits). `dir <code>` shows them as `<JUNCTION>`; every path through
`current\...` works as on the other platforms, and `goobster-manager
uninstall` removes the junctions with the payloads they name. On Linux and
macOS `current` is the payload directory itself.

A root the **service** will use must be a full drive path (`D:\...`), at least
two folders deep, without `<>"|?*%`, control characters, `..`, a UNC name, a
reserved device name (`CON`, `NUL`, `COM1`...) or a trailing dot or space, and
not inside `\Windows`, `\Program Files`, `\Program Files (x86)`,
`\Recovery`, `\System Volume Information` or the `$Recycle.Bin`, and not
a profile root such as `C:\Users\alice`. The same check runs in the manager and
again in the elevated helper (`INVALID_PATH`, `PATH_NOT_ALLOWED`).

## What runs elevated

The installer runs as you. It asks for administrator rights only for the
operations in a closed list, through the same small **privileged helper** as on
Linux (`apps/manager/privileged/`): one Node.js process that reads one JSON
request and writes one JSON reply. It takes no argument that is a command and
puts no secret, password, token or address in its input, its log or its reply.

| Operation | What the helper does as administrator |
|---|---|
| `service.register` | Copies the pinned service host and writes the service definition into `<manager store>\service\`, locks that folder down, registers the Windows service `goobster` with `sc.exe`, grants the virtual account its rights on the roots, and starts it. Refuses a service named `goobster` that is not this installation's (`SERVICE_FOREIGN`). |
| `service.unregister` | Stops the service (bounded), deletes it with `sc.exe delete`, removes the definition and the host. Acts only on a service whose definition carries this installation's marker. |
| `user.create`, `updater.disable`, `package.install` | Not implemented on Windows (`NOT_IMPLEMENTED`): the virtual account needs no creating, and there is no old updater to disable. |

The helper runs four fixed programs from `%SystemRoot%\System32` with fixed
argument shapes and a minimal environment: `sc.exe`, `icacls.exe`, `whoami.exe`
and `powershell.exe` (for one fixed registry read, `-EncodedCommand`, no input
interpolated). It never runs a shell, `netsh`, `reg.exe`, or the service host
itself. Every request names the installation id, and the helper checks it
against the installation record in the manager's store before it changes
anything.

### How it gets administrator rights

1. The session is already an administrator (an elevated prompt, a CI runner, a
   service session running as one): it starts the helper directly.
2. Otherwise, in an interactive desktop session, it asks Windows to elevate the
   helper: a UAC prompt (`Start-Process -Verb RunAs`, started from a fixed
   PowerShell command). Declining the prompt is `ELEVATION_DECLINED` and the
   install finishes in the manual manager (below).
3. Neither (no desktop: an SSH session, a service, a scheduled task): the install
   does **not** fail. It records `ELEVATION_UNAVAILABLE`, finishes everything
   else, and prints the command that does the step by hand.

An elevation tool that cannot pass a pipe needs files, so the request and the
reply travel as `<manager store>\requests\<operation>.request.json` and a reply
file beside it. The request file is created with an ACL that grants only your
account and the Administrators group (`icacls /inheritance:r`), the helper is
started as `helper.js --request <file> --reply <file>` (paths only on the
command line, values in the files), and both files are deleted once the reply
has been read. The wait for the prompt is at least seven minutes.

Before an elevated start the manager checks the SHA-256 of the helper's files
(`privileged\helper.js`, `protocol.js`, `win32.js`, `platform\windowsServiceXml.js`
and `platform\systemdUnit.js`, which the protocol module loads) and of the
bundled `node.exe` against `payload-manifest.json`; a mismatch is
`HELPER_UNVERIFIED` and nothing is started. The service host is checked against
its pin by SHA-256 immediately before it is copied (`SERVICE_HOST_UNVERIFIED`;
`SERVICE_HOST_MISSING` when the installer's copy cannot be found). Each
privileged operation writes a `manager.privileged.<operation>` audit row
(operation, outcome and names only).

## The service

After the payload is active the `register-service` step runs. With rights it:

1. writes `<code root>\goobster.env`, the roots as plain `GOOBSTER_*` lines the
   launcher reads;
2. copies the service host to `<manager store>\service\goobster-service.exe`,
   writes its definition `goobster-service.xml` beside it, registers the service
   `goobster` (`sc.exe create`) and records it in `<manager store>\services.json`
   (`registeredBy: installer`);
3. starts it. It starts automatically with Windows.

**The host.** Windows services have to speak the service control protocol, which
Node does not. The service is [WinSW](https://github.com/winsw/winsw) 2.12.0
(`WinSW.NET4.exe`, needs the .NET Framework 4 that ships with Windows 10 and
Server 2019), pinned by URL and SHA-256 in `scripts/bootstrap-pins.json`
(`winsw`). The installer carries it; the helper checks the hash again before it
copies it. The definition is rendered by `apps/manager/platform/windowsServiceXml.js`.
It runs `<code>\current\runtime\node.exe "<code>\current\app\apps\manager\index.js" --supervise`
with the installation's roots as environment, so the manager supervises the
workers of the layout (standalone: the API), restarts them, and performs staged
restarts (`documentation/manager_lifecycle.md`). The first line of the
definition is `<!-- X-Goobster-Installation: <installation id> -->`; the helper
registers, replaces and removes only a service whose definition carries it.

**The account.** The service runs as the virtual account `NT SERVICE\goobster`.
Windows creates and owns it with the service; it has no password, cannot log on
interactively, and the installer creates no account. The helper sets the
service's SID type to unrestricted and grants it with `icacls`:

| Where | Right for `NT SERVICE\goobster` |
|---|---|
| the code root and the `service\` folder | read and execute (`RX`); **not** writable - a payload is replaced by an operation run with rights, not by the running service |
| data, cache, logs, uploads, the manager store, the config file's folder (or only the config file when it sits inside the code root) | modify (`M`), inherited |

The `service\` folder itself is owned by Administrators with inheritance removed
and `SYSTEM` and `Administrators` full, `Users` read and execute, so the service
cannot rewrite its own definition or host. A person's own roots (`%LOCALAPPDATA%`)
are granted the same way, which means the service of a per-user install still
runs as `NT SERVICE\goobster`, not as you.

**Failure and restart.** The service is configured to restart after a failure,
10 seconds each time, with the failure count reset after an hour. The restart
is what lets the service's manager take port 3400 from the wizard's.

**Stop.** `sc.exe stop goobster` (or Services, or a shutdown) makes the host
send Ctrl+C to the manager's process tree and wait up to 120 seconds
(`<stoptimeout>`, longer than the drain bound plus margin in
`manager_lifecycle.md`). The manager stops its workers through the control file
(`apps/manager/lifecycle/adapters/child.js`) and exits 0, which Windows records
as a clean stop - so no failure action fires. After the bound the process tree
is terminated (`taskkill /T /F` semantics), so a stop never leaves `node.exe`
processes of the installation behind. A manager that **crashes** exits non-zero:
Windows then runs the restart action. The CI journey proves both.

```bat
sc.exe query goobster
sc.exe qc goobster
sc.exe stop goobster
sc.exe start goobster
curl http://127.0.0.1:3100/health
```

**Logs.** The service host writes `goobster-service.out.log`,
`goobster-service.err.log` and `goobster-service.wrapper.log` (rolling) into your
logs root, next to the application's own log files, and its events to the
Application event log with source `goobster` (Event Viewer, or
`Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='goobster'}`).

If a service named `goobster` exists that this installation did not register
(different host file, no marker), the install stops with `SERVICE_FOREIGN` and
changes nothing: the other service is not touched, and once the name is free
the same install command finishes the job.

Set `"registerService": false` in the answers file to install only the files;
the launcher still finds the roots (`goobster.env` is written either way).

## Manual manager

Where the service cannot be registered (no administrator rights, no desktop to
show a UAC prompt, a declined prompt, `registerService: false`) the install is
complete and exits 0, with the register-service step recorded as
`MANUAL_FALLBACK`. It prints:

```text
The installation is complete, but no service was registered (<reason>). Run it by hand:
  "<code root>\goobster-manager.cmd" --supervise
To start it with Windows, from an administrator Command Prompt:
  mkdir "<manager store>\service"
  copy "<path to WinSW.NET4.exe v2.12.0>" "<manager store>\service\goobster-service.exe"
  copy "<manager store>\goobster-service.xml" "<manager store>\service\goobster-service.xml"
  "<manager store>\service\goobster-service.exe" install
  "<manager store>\service\goobster-service.exe" start
```

`<manager store>\goobster-service.xml` is the definition the installer would
have registered, already rendered for your paths. The WinSW executable is the
one carried in the installer's `service-host` folder; its SHA-256 is in
`scripts/bootstrap-pins.json`. A service registered this way runs as the
account the definition names and is not recorded as the installer's, so the
installer will not remove it later. Running `goobster-manager.cmd --supervise` in a
terminal runs the workers as you.

## Repair, reconfigure, uninstall

The installer leaves `goobster-manager.cmd` in the code root. It reads the
installation's roots from `goobster.env` beside it (only `GOOBSTER_*` lines, as
text), so it works from any prompt. The payload's own launcher,
`<code root>\current\bin\goobster-manager.cmd`, reads the same file the same
way when it runs from `current` (as its POSIX counterpart does), so either
door finds this installation rather than the `%LOCALAPPDATA%\Goobster`
defaults; `uninstall` still belongs to the code-root launcher, which runs it
from a copy of Node outside the code root.

Either launcher also runs bare (`goobster-manager.cmd` with no argument
serves the manager in the foreground, as `--supervise` does for the service);
the payload launcher once failed that way with "The syntax of the command is
incorrect" (exit 255), because a batch file's substring of an undefined
variable is not empty, which the acceptance matrix found and fixed.

Either launcher works from Git Bash too. The one place the shell used to
matter was `update stage`: it reads the downloaded payload archive with the
system `tar`, and Git Bash puts Git's GNU tar first on PATH, which reads a
`D:\...` path as a remote host and fails on every archive
(`ARCHIVE_UNREADABLE`). The manager now uses `%SystemRoot%\System32\tar.exe`
(bsdtar, present on Windows 10 1803 and later) whenever it is there and falls
back to PATH only where it is not ([manager_update.md](manager_update.md)).

```bat
"C:\Users\you\AppData\Local\Goobster\code\goobster-manager.cmd" status
"C:\...\goobster-manager.cmd" repair      --answers repair.json      --yes
"C:\...\goobster-manager.cmd" reconfigure --answers reconfigure.json --yes
"C:\...\goobster-manager.cmd" uninstall   --answers uninstall.json   --yes
```

- `repair.json`: `{"source": "<an unpacked payload folder>", "release": {"allowUnsigned": true}}`.
  Repair re-stages the payload when the current one fails verification and
  re-applies the database schema; a healthy install reports `CURRENT_OK`.
- `reconfigure.json`: the layout, roots or config values to change, for example
  `{"roots": {"logs": "D:\\Goobster logs"}}`. When the roots change and the
  installer registered the service, the helper stops it, rewrites the
  definition, grants the new root, and starts it again.
- `uninstall.json`: `{"keepData": true}` removes the service, the payload and the
  manager's ownership record and keeps data, config, cache and logs.
  `{"keepData": false}` with `--delete-data --confirm <installation id>` also
  removes them. The installation id is `status`'s `installation` line. An
  uninstall leaves a `tombstone.json` in the data root; installing again over
  kept data works. Removing the service needs administrator rights the same way
  registering it did (`ELEVATION_REQUIRED` names `sc.exe delete goobster` when
  they cannot be had).

Programs and Features (Settings > Apps) lists **Goobster** for your account (one
`HKCU` entry; nothing is written under `HKLM`). Its Uninstall button runs
`goobster-manager.cmd uninstall` with `{"keepData": true}`: the service and the
code go, **your data stays**, then the launcher, the entry and the installer's
files are removed. Deleting the data is deliberate and typed:
`goobster-manager.cmd uninstall --answers ... --delete-data --confirm <id>`.
Run the Programs and Features uninstaller afterwards to clear the launcher and
the entry. For scripts the quiet form is `uninstall.exe /S _?=<folder of uninstall.exe>`
(the `_?=` makes it wait; without it NSIS copies itself and returns at once, and
the file stays behind). The `uninstall` command runs the CLI from a copy of
`node.exe` in `%TEMP%`, because the `node.exe` in the code root cannot be
deleted while it runs.

An interrupted install (power loss, `taskkill /F`) is finished by running the
same command again; the stage folder is replaced.

## Codes you may meet

| Code | Meaning and what to do |
|---|---|
| `MANUAL_FALLBACK` | Everything is installed; the service was not registered. Follow the printed commands. |
| `ELEVATION_UNAVAILABLE` | No administrator session and no desktop for a UAC prompt (`NO_INTERACTIVE_SESSION`), or the elevated process could not be started. Run the installer from an administrator prompt, or use the by-hand commands. |
| `ELEVATION_DECLINED` | The UAC prompt was cancelled. Repeat, or use the by-hand commands. |
| `ELEVATION_REQUIRED` | An uninstall needs rights to remove the registered service. Run it from an administrator prompt, or run the printed `sc.exe stop` / `sc.exe delete` yourself and repeat. |
| `NOT_ELEVATED` | The helper started without administrator rights. |
| `HELPER_UNVERIFIED` | The helper files or the bundled `node.exe` do not match `payload-manifest.json`. Run `repair`. |
| `SERVICE_FOREIGN` | A service named `goobster` exists and is not this installation's. Rename or remove it, then run the install again. |
| `SERVICE_HOST_MISSING`, `SERVICE_HOST_UNVERIFIED` | The pinned service host was not found beside the unpacked payload, or does not match its SHA-256. Use a freshly built installer. |
| `SERVICE_STILL_ACTIVE` | The service did not stop within its bound while it was being replaced or removed. Stop it with `sc.exe stop goobster` and repeat. |
| `SCM_UNAVAILABLE`, `SERVICE_QUERY_FAILED` | The service control manager could not be queried. |
| `COMMAND_FAILED`, `ACL_FAILED` | `sc.exe` or `icacls.exe` failed (the message carries the program label and the status only), or the request file could not be locked down. |
| `INSTALLATION_MISMATCH` | The request does not match the installation record in the manager's store. |
| `INVALID_PATH`, `PATH_NOT_ALLOWED`, `UNSAFE_PATH` | A root fails the Windows path rules above, or a path is unsafe to pass on a command line. |
| `PAYLOAD_MISSING` | The installed payload lacks a file the service needs. Run `repair`. |
| `ANSWERS_UNREADABLE`, `ANSWERS_INVALID`, `ANSWERS_SOURCE` | The answers file is not a readable regular file, is invalid against the schema, or names a foreign `source`. |
| `ALREADY_INSTALLED` | This account already has an installation registered with the manager. Use `repair`, `reconfigure` or `uninstall` through the launcher. |
| `PAYLOAD_DIGEST_MISMATCH` | The unpacked payload is not the one this installer was built with (exit 4). Download it again. |
| `PORT_IN_USE` | Another program holds the manager's port (3400). |
| `SYSTEM_DEPENDENCY_MISSING` | A program a selected feature uses is not installed; the feature reports itself unavailable until it is. |

## Building the installer

The payload must be built **on Windows**: `package-runtime.js` fetches native
modules for the machine that runs npm and refuses to cross-assemble.

```bat
npm ci && npm run build:web
node scripts\package-runtime.js --target win32-x64 --out dist\payload --report-dir dist\reports --force --dev-sign
node scripts\package-bootstrap-win32.js --target win32-x64 --payload dist\payload --out dist\bootstrap [--public-key <pem>] [--require-installer]
```

`package-bootstrap-win32.js` needs `makensis` ([NSIS](https://nsis.sourceforge.io/)
3.x; found on `PATH`, in `%ProgramFiles(x86)%\NSIS`, from `MAKENSIS` or
`--makensis`) and writes `goobster-<version>-win32-x64[-dev].exe` and
`bootstrap-report-win32-x64.json`. It also builds on Linux with a Windows
payload and `makensis` installed (that is how the script is tested). The build
header it generates lists the payload's files in one bytewise order, file dates
are not stored, and the icon and version resource derive from the manifest, so
the same payload, host and `makensis` give the same bytes (the Linux build is
checked twice in `tests/packageBootstrapWin32.test.js`; the CI workflow
reports, but does not enforce, the same on Windows).

The service host (WinSW) is **pinned by URL and SHA-256** in
`scripts/bootstrap-pins.json`; `--tools-dir` caches it, `--winsw-file` supplies a
local copy that must match the pin. Nothing unpinned is ever embedded. When
`makensis` or the host is not available the report says `INSTALLER_SKIPPED`
with a reason (`MAKENSIS_UNAVAILABLE`, `WINSW_UNAVAILABLE`, `WINSW_HASH_MISMATCH`,
`MAKENSIS_FAILED`), and `--require-installer` turns a skip into a failure.
Authenticode signing is wired and off: `--signtool <signtool.exe>
--sign-thumbprint <sha1> --sign-timestamp-url <https url>` signs the finished
`.exe` (not the uninstaller NSIS embeds) and the report records
`installer.authenticode.signed`; a failed signing run deletes the installer.

## What CI proves

`.github/workflows/windows-bootstrap.yml` builds the payload and the installer
on `windows-2022`, checks the version resource carries the unsigned-build
notice, that the `.exe` is not Authenticode-signed and that the report names the
pinned host, then runs `scripts/windows-bootstrap-proof.ps1` as an
administrator on the runner's real service control manager:

- an install killed with `taskkill /T /F` during staging, then the same command
  finishing it;
- the roots contain spaces and the data root is a different tree from the code
  root; the service account can read but not write the code root and can modify
  the data root;
- the `goobster` service is registered automatic, as `NT SERVICE\goobster`,
  with a restart-on-failure action, its host and marker-bearing definition in the
  manager store; the manager runs as the virtual account; `/health` answers; the
  manager listens on `127.0.0.1` only; no firewall rule was added; one `HKCU`
  entry and no `HKLM` entry;
- running the install again changes nothing;
- `repair`, and `reconfigure` of the logs root (the definition is rewritten, the
  new root is granted, the service host logs there);
- **stop semantics**: `sc.exe stop` finishes inside the stop timeout with exit
  code 0, leaves no `node.exe` of the installation and no forced worker kill
  in the logs, and the service starts again;
- **crash recovery**: killing the manager makes Windows restart the service, and
  `/health` answers again (an orphaned API worker left by the killed manager is
  reported, not enforced);
- uninstall from Programs and Features keeping the data (service, code and entry
  gone, database kept), an install over the kept data, and a delete-data
  uninstall;
- a stand-in service named `goobster` that is not ours is refused with
  `SERVICE_FOREIGN`, left untouched, and the same command finishes once the name
  is free.

What is **not** proven: a signed release build (there is no release key or
certificate yet), the UAC prompt (a GitHub runner is an administrator session, so
the `Start-Process -Verb RunAs` branch is covered by unit tests with a fake
spawn only), Windows 10, Windows 11 and Windows Server versions other than 2022,
Windows on Arm, a per-user install whose service is registered later from a
standard account, antivirus and SmartScreen behaviour, and the wizard's browser
journey from the `.exe` (the manager's Playwright journeys cover the wizard
itself).

Known limits: in a per-user install the code root under `%LOCALAPPDATA%` belongs
to the person, so the person can change the code the machine service runs as
`NT SERVICE\goobster` (unlike the `service\` folder, which Administrators own).
The virtual account holds nothing the person does not already hold except the
right to run without a login, so this is a persistence concern rather than an
escalation; an installation whose operator is not trusted with that belongs
under `%ProgramData%` from an administrator session, where Administrators own
the code root. The virtual account's grants on a data root stay when the service
is removed with the data kept (the unregister request carries no roots), harmless
because only that service can use the account; machine-wide roots under
`%ProgramData%` get no extra hardening beyond the grants above; a crash between
`sc.exe delete` and the removal of the service folder can leave a folder that
the next registration replaces.
