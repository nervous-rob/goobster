---
title: Operator runbooks - install, run, recover, update and remove Goobster
kind: guide
summary: Step-by-step procedures for a second operator who has never read the source - getting started on Linux, Windows and macOS (first owner, first chat), reading the feature and configuration reference and turning a feature on or off, who owns the OS service, which ports are open, backup and restore with the paused-after-restore state and the recovery session, SQLite to Postgres migration and what rollback cannot recover, the update policy and the recovery decision, and uninstall with and without the data - each with the exact commands, the expected result, the refusal code and its remedy, and what the procedure cannot do. Also lists the owner decisions that are still open and the issues found by walking the Linux procedures.
when: Installing Goobster on a host you operate; creating the first owner without Discord; turning a feature off; finding out who owns the service or what is listening; backing up, restoring or moving the database; updating or rolling back; removing an installation; or checking what an operator may and may not expect before a pilot.
tags: [operations, runbook, installer, manager, install, backup, restore, migration, rollback, update, uninstall, network, service, features, getting-started, linux, windows, macos]
---

# Operator runbooks

These are the procedures an operator follows on a host that runs the installer's manager. They sit on top of the reference documents and link to them instead of repeating them: the reference says what every field and code means, a runbook says what to type, what you should see, and what to do when you do not.

**Conventions.** Every `bash` block is runnable as written once the variables of [Before you start](#before-you-start) are set; a block fenced `sh`, `text` or `bat` is shown, not run here. Secrets are never typed on a command line: passwords, passphrases and keys go in a file only you can read (mode 0600) or a hidden prompt, and the examples use obvious placeholders (`<...>`). Exit codes of the manager command line: 0 done, 1 unexpected, 2 invalid input or a preflight block, 3 refused, 4 interrupted (run the same command again), 5 applied but a step needs the privileged helper ([manager_install.md](manager_install.md#exit-codes)).

**What was walked.** The Linux getting-started, backup and restore, and uninstall procedures were executed from this document on a Linux x64 machine (a throwaway install in a temporary directory, standalone, no Discord, no systemd). The transcript is `/tmp/run343/walkthrough.log` on the machine that ran it and its commands are the blocks of this page; [How this was verified](#how-this-was-verified) lists what was and was not run. Windows, macOS, systemd registration, Docker and native Postgres, and an update apply were **not** walked; those procedures are taken from the reference documents and marked.

## Contents

1. [Before you start](#before-you-start)
2. [Getting started](#getting-started)
3. [Feature and configuration reference](#feature-and-configuration-reference)
4. [Service ownership](#service-ownership)
5. [Network access](#network-access)
6. [Backup and recovery](#backup-and-recovery)
7. [Migration and rollback](#migration-and-rollback)
8. [Upgrade](#upgrade)
9. [Uninstall](#uninstall)
10. [Owner decisions still open](#owner-decisions-still-open)
11. [Known issues found by the walk-through](#known-issues-found-by-the-walk-through)
12. [How this was verified](#how-this-was-verified)

## Before you start

You need: a machine that meets the platform baseline ([linux_install.md](linux_install.md#supported-platforms), [windows_install.md](windows_install.md#supported-platforms), [macos_install.md](macos_install.md#supported-platforms)), the installer artifact for it (`goobster-<version>-linux-<arch>[-dev].run`, `goobster-<version>-win32-x64[-dev].exe`, or the macOS package or archive), and `curl`, `jq` and `openssl` for the headless steps. Every artifact built from this repository is an unsigned development build (`-dev`); install it only on a machine you trust ([release.md](release.md)).

The Linux procedures use these variables. Change them before you run anything; the defaults put the whole installation under your home directory.

```bash
BASE=${BASE:-$HOME/goobster}                       # every root of the installation lives under here
RUN=${RUN:-$PWD/goobster-1.0.0-linux-x64-dev.run}  # the installer you downloaded
ANSWERS=${ANSWERS:-$HOME/goobster-answers.json}    # the answers file (mode 0600)
CODE=$BASE/code
MGR=$CODE/current/bin/goobster-manager             # the manager's command line and launcher
API_PORT=${GOOBSTER_API_PORT:-3100}                # the portal and API
MGR_PORT=${GOOBSTER_MANAGER_PORT:-3400}            # the manager (always loopback)
```

Keep the two ports in the environment of every command that starts the manager, so the workers and the manager agree. Nothing else uses them: 3100 is the standalone API, 3400 the manager ([network access](#network-access)).

## Getting started

### Linux, headless

This is the path for a server you reach over SSH and for a script. It installs for your own account, starts the manager by hand, creates the first owner without Discord and sends the first chat message. To register the OS service instead, see [With the service](#with-the-service).

1. **Check the installer.** Both commands read only the file.

   ```bash
   sh "$RUN" --info
   sh "$RUN" --verify
   ```

   `--info` prints the release, the target, the digests and `development build: yes` for a `-dev` build; `--verify` ends with the digest check passing. Exit 3 (unsupported CPU or C library) or 4 (damaged archive) stops here: download the right artifact again ([linux_install.md](linux_install.md#choosing-how-to-install)).

2. **Write the answers file.** `registerService` is false so no administrator rights are needed; `identity.nativeLogin` is what lets the first owner sign in without Discord (the wizard sets it for you when you create an owner; a headless install must say so).

   ```bash
   mkdir -p "$BASE"
   (umask 077; cat > "$ANSWERS" <<'EOF'
   {
     "ownerLabel": "my server",
     "registerService": false,
     "features": ["core", "knowledge"],
     "config": [{ "id": "identity.nativeLogin", "value": true }]
   }
   EOF
   )
   chmod 600 "$ANSWERS"
   ```

   Refusal `ANSWERS_PERMISSIONS` means the file is not a regular file of mode 0600 owned by you; `ANSWERS_INVALID` names the field that fails `apps/manager/install/answers.schema.json` (`node apps/manager/cli.js schema` prints it); `ANSWERS_SOURCE` means you set a `source` the installer did not embed ([linux_install.md](linux_install.md#codes-you-may-meet)).

3. **Preview, then install.** `--dry-run` writes nothing.

   ```bash
   sh "$RUN" --headless --answers "$ANSWERS" --base "$BASE" --yes --dry-run
   sh "$RUN" --headless --answers "$ANSWERS" --base "$BASE" --yes
   ```

   The preview ends `preflight  ok`. The install ends with `The service was not registered with the operating system (...)` and the command to run the manager by hand, and exits 0. The payload is in `$CODE/current`, the data in `$BASE/data`, the settings file in `$BASE/config/config.json`. Failures: `ALREADY_INSTALLED` (exit 3: this account already has an installation; use `repair`, `reconfigure` or `uninstall`), `PORT_IN_USE` (the manager's port is taken; set `GOOBSTER_MANAGER_PORT`), `ROOT_IS_HOME` or `ROOT_NOT_REACHABLE` (choose a `--base` directory of its own).

4. **Start the manager.** `--supervise` makes it start and watch the application (in the standalone layout, the API). Keep its process id; you stop it by that id, never by name.

   ```bash
   mkdir -p "$BASE/logs"
   GOOBSTER_API_PORT=$API_PORT GOOBSTER_MANAGER_PORT=$MGR_PORT \
       nohup "$MGR" --supervise > "$BASE/logs/manager.log" 2>&1 &
   echo $! > "$BASE/manager.pid"
   for i in $(seq 1 45); do curl -fs "http://127.0.0.1:$API_PORT/health" && break; sleep 2; done
   ```

   Expected: `{"status":"healthy","service":"api","mode":"standalone","discord":"disabled",...}`. If nothing answers in 90 seconds read `$BASE/logs/manager.log`: `NON_LOOPBACK_REFUSED` or `BAD_PORT` are settings errors ([manager.md](manager.md#transport)); `WEBAPP_DISABLED` means `webapp.enabled` is not true in `config.json`.

5. **Define the manager helper.** The manager API is on loopback only and a mutation needs a session and a one-time nonce. A **recovery credential** minted on the machine buys a 15-minute session; this is the headless way in ([manager.md](manager.md#local-recovery)). The functions below mint one, run an operation through plan, validate and apply, and never put a secret on a command line.

   ```bash
   W=$(mktemp -d); chmod 700 "$W"          # private scratch for passwords and request bodies
   export GOOBSTER_MANAGER_PORT=$MGR_PORT
   mgr_session() {
       local cred
       cred=$("$MGR" --mint-recovery | sed -n 's/^Recovery credential: //p')
       S=$(jq -n --arg c "$cred" '{credential:$c}' \
           | curl -fsS -X POST "http://127.0.0.1:$MGR_PORT/manager/api/recovery/unlock" \
                 -H 'content-type: application/json' --data-binary @- | jq -r .session.token)
   }
   mgr() {   # mgr METHOD PATH [BODYFILE]
       curl -sS -X "$1" "http://127.0.0.1:$MGR_PORT/manager/api$2" \
           -H "authorization: Bearer $S" -H "x-goobster-nonce: $(openssl rand -hex 12)" \
           -H 'content-type: application/json' ${3:+--data-binary @"$3"}
       echo
   }
   mgr_op() {   # mgr_op KIND INPUTFILE  - plan, validate, apply
       local id rev plan
       jq --arg k "$1" '{kind:$k,input:.}' "$2" > "$W/op.json"
       plan=$(mgr POST /operations "$W/op.json")
       id=$(jq -r '.operation.id // empty' <<<"$plan")
       [ -n "$id" ] || { echo "the plan was refused:"; jq -c .error <<<"$plan"; return 1; }
       OP_ID=$id
       mgr POST "/operations/$id/validate" | jq -c '{validated: .operation.status, error}'
       rev=$(mgr GET "/operations/$id" | jq .revision)
       jq -n --argjson r "$rev" '{revision:$r}' > "$W/apply.json"
       mgr POST "/operations/$id/apply" "$W/apply.json" | jq -c '{status: .operation.status, result, error}'
   }
   mgr_session
   mgr GET /status | jq -c '{state, lifecycle}'
   ```

   Expected: `{"state":"claimed","lifecycle":{"supervising":true,"layout":"standalone","workers":[{"name":"api","state":"running",...}]}}`. `401 RECOVERY_INVALID` or `RECOVERY_EXPIRED` means the credential was used or is older than 15 minutes: mint another. `403 LOCAL_ONLY` means the request came through a proxy or from another machine; recovery works from the host itself only.

6. **Create the first owner.** The owner is a native account: a login name and a password, no Discord, no email. Put the password in a file; type one, or generate one and read it once with `cat "$W/pw"` and keep it in your password manager.

   ```bash
   (umask 077; openssl rand -base64 24 > "$W/pw")
   jq -n --rawfile p "$W/pw" '{loginName:"owner", password:($p|rtrimstr("\n")), displayName:"Owner"}' > "$W/owner.json"
   mgr_op owner.create "$W/owner.json"
   ```

   Expected: `{"validated":"validated",...}` then `{"status":"applied","result":{...}}`. Refusals: `BAD_LOGIN_NAME` (3 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit), `WEAK_PASSWORD` (too short, too common, or contains the login name), `LOGIN_NAME_TAKEN`, `ACCOUNT_EXISTS` (the installation already has an account: sign in with it, or invite another person from the Host room). The apply is `failed` with `OWNER_FAILED` when the database could not be opened; read `$BASE/logs`.

7. **Add a model provider.** Chat needs one. Without a key the portal works, the Study room answers with a clear message, and nothing crashes ([getting_started.md](getting_started.md)). Put your key in a file only you can read, then set it as a configuration change; the plan and the journal record that a secret was set, never its value. A provider key is read when the application starts, so restart the workers once (the API goes down for a few seconds).

   ```bash
   # KEYFILE holds one provider key (mode 0600). Create it with:  (umask 077; cat > "$KEYFILE")  then paste the key and press Ctrl-D.
   KEYFILE=${KEYFILE:-$HOME/goobster-provider.key}
   REV=$(mgr GET /config | jq -r .revision)
   jq -n --arg r "$REV" --rawfile k "$KEYFILE" \
       '{expectedRevision:$r, changes:[{id:"ai.openai.apiKey", action:"set", value:($k|rtrimstr("\n"))}]}' > "$W/provider.json"
   mgr_op config.set "$W/provider.json"
   mgr POST /lifecycle/restart | jq -c '.operation | {kind, status}'
   for i in $(seq 1 45); do curl -fs "http://127.0.0.1:$API_PORT/health" >/dev/null && break; sleep 2; done
   ```

   The result reports `"restartRequired":["ai.openai.apiKey"]` and the restart reports `"status":"applied"`. `REVISION_CONFLICT` means `config.json` changed since you read it: read `/config` again and repeat. `MASK_IS_NOT_A_VALUE` means the file holds a masked value. Another provider (`ai.anthropic.apiKey`, `ai.gemini.apiKey`) works the same way; see [config_reference.md](config_reference.md).

8. **Sign in and send the first chat message.** In a browser: open `http://127.0.0.1:<API_PORT>/app/` (through an SSH tunnel on a machine with no screen: `ssh -L 3100:127.0.0.1:3100 <user>@<host>`), sign in with the login name and password, open Study, type a message. Without a browser, the same journey over HTTP:

   ```bash
   jq -n --rawfile p "$W/pw" '{loginName:"owner", password:($p|rtrimstr("\n"))}' \
       | curl -fsS -c "$W/cookies" -X POST "http://127.0.0.1:$API_PORT/api/app/auth/native-login" \
             -H 'content-type: application/json' --data-binary @- | jq -c '.user | {name, loginName}'
   curl -sS -N -b "$W/cookies" -X POST "http://127.0.0.1:$API_PORT/api/app/chat" \
       -H 'content-type: application/json' -d '{"message":"Reply with the single word: ready."}' \
       | grep -E '^event: ' | sort | uniq -c
   ```

   Expected: the sign-in prints the owner's name; the chat stream contains `event: start`, one or more `event: delta` and `event: message`, and ends with `event: done`. `503 NATIVE_LOGIN_DISABLED` means `identity.nativeLogin` is not true in `config.json` (set it with `config.set` and restart the workers); `401 BAD_CREDENTIALS` is a wrong name or password. An `event: error` instead of `done` means the provider refused or is unreachable: the application log in `$BASE/logs` names the provider and status, never the key.

   **What this cannot do.** It does not register a service, so nothing starts after a reboot; it does not open the portal to other machines or give it TLS ([network access](#network-access)); and it makes no Discord connection (a Discord bot is a different layout, [discord_setup.md](discord_setup.md)).

### With the service

Run the same `.run` as root (or as a person with `sudo`) without `"registerService": false`. The installer creates the `goobster` account, writes `/etc/systemd/system/goobster.service`, enables it, and the manager then supervises the application as that account. Use the launcher with `sudo`, and after an operation run as root hand the store back (`sudo chown -R goobster: '<manager store>'`). The steps, the unit's hardening, what the privileged helper does and the by-hand command when neither `sudo` nor `pkexec` works are in [linux_install.md](linux_install.md#what-runs-as-root). If systemd is not the init system the installer ends in the manual manager above and exits 0 (`SYSTEMD_UNAVAILABLE`, `SYSTEMD_NOT_INIT`). **Not walked:** this path needs a booted systemd; the packaging proof exercises it in CI ([linux_install.md](linux_install.md#what-ci-proves)).

### Linux with a browser (the wizard)

```sh
sh "$RUN"
```

prints `http://127.0.0.1:3400/manager/` and an SSH tunnel command for a machine with no screen. The Welcome step asks for the one-time setup credential the manager wrote to `<manager store>/bootstrap-credential` (valid 15 minutes; `--mint-bootstrap` makes another). The Connections step creates the owner and the optional provider keys; the last step opens the portal. **Not walked** (the wizard has its own browser journeys in CI, [setup_wizard.md](setup_wizard.md#tests)).

### Windows

1. Double-click `goobster-<version>-win32-x64[-dev].exe`; the wizard opens in your browser on `127.0.0.1:3400` and follows the same steps as above. For a script:

   ```bat
   start /wait "" goobster-1.0.0-win32-x64-dev.exe /S /ANSWERS="C:\provision\answers.json" /BASE="D:\Goobster"
   echo %ERRORLEVEL%
   ```

   0 is done; 2 is a bad switch or answers file; 3 is `ALREADY_INSTALLED`; 4 is `PAYLOAD_DIGEST_MISMATCH` (download again); 5 means a step needs administrator rights. `ELEVATION_UNAVAILABLE` or `ELEVATION_DECLINED` leave a complete install and print the by-hand commands ([windows_install.md](windows_install.md#codes-you-may-meet)).
2. The manager's launcher is `goobster-manager.cmd` in the code root. Create the first owner and the first chat message exactly as steps 5 to 8 above, with the API on `http://127.0.0.1:3100/app/`; the PowerShell or `cmd` equivalent of the helper functions is not provided, so on Windows use the wizard's Connections step for the owner.

### macOS

1. Per user: `tar -xzf goobster-<version>-darwin-<arch>[-dev].tar.gz`, then `./install.command` (the wizard) or `./install.command --headless --answers answers.json --yes`. Machine-wide: put `/etc/goobster-answers.json` (root-owned, mode 0600) in place, then `sudo installer -pkg goobster-<version>.pkg -target /`. The wizard and the manager never run as root (`WIZARD_AS_ROOT`, exit 3) ([macos_install.md](macos_install.md#choosing-how-to-install)).
2. First owner and first chat: the wizard's Connections step creates the owner; open `http://127.0.0.1:3100/app/`, sign in, open Study. Development archives downloaded with a browser need `xattr -dr com.apple.quarantine <folder>` first.

### Raspberry Pi and Docker

A Raspberry Pi installed with `scripts/install-rpi.sh` is adopted, not reinstalled ([service ownership](#service-ownership)); the full Docker profile is [docker_deployment.md](docker_deployment.md). Neither is walked here.

## Feature and configuration reference

Goobster is one program made of optional features. Two generated pages are the reference; do not edit them by hand (`npm run docs:check` fails when they are stale).

- [features.md](features.md): one section per feature id (`core`, `music`, `economy`, ...): what it depends on, how many commands, chat tools, rooms and tours it owns, which keys and system tools it needs.
- [config_reference.md](config_reference.md): every setting with its environment variable, its `config.json` path, its default, whether a change is `hot` or needs a `restart`, and which feature needs it.

Availability is a fact about one installation, never about those pages. A feature is available when it is **installed** (the payload carries it), **requested** (`active` in `data/features.json`), not switched off by the environment (`GOOBSTER_FEATURE_<ID>=off`), and every feature it depends on is available. The reasons you will see are `NOT_INSTALLED`, `DISABLED`, `ENV_OFF` and `DEPENDENCY_INACTIVE` ([feature_state.md](feature_state.md#precedence)).

### Read what this installation does

In the portal, open the Host room, then **Features** (`/app/host/features`): one row per feature with its state and, when it is off, the reason. Headless:

```bash
mgr GET /features | jq -r '.features | to_entries[] | select(.value.active|not) | "\(.key)\t\([.value.reasons[].code] | join(","))"'
```

Each unavailable feature prints with its reason codes. A missing key never hides a feature: it appears under `warnings` as `NOT_CONFIGURED` with the key's name, and the feature answers with its own guidance ([feature_state.md](feature_state.md#precedence)).

### Turn a feature off or on

1. Plan and apply the change. Disabling a feature other features need is refused: `economy` cannot go off while `exchange` or `gambling` stay on (`DEPENDENCY_CONFLICT`), and a dependency is never switched on for you. A feature the payload does not carry is `FEATURE_NOT_INSTALLED`; `core` is `CORE_IMMUTABLE`.

   ```bash
   jq -n '{changes:{knowledge:false}}' > "$W/features.json"
   mgr_op features.set "$W/features.json"
   ```

   Expected `"status":"applied"`. The change is **pending**: the file records `pendingActive`, and the running process keeps its current answer until the workers restart. `REVISION_CONFLICT` means someone changed `features.json` since you planned; plan again.

2. Restart so the change becomes real. The Host room offers a countdown (60 seconds by default); headless, schedule the same staged restart with `lifecycle.apply`, which names the operation you just applied (`OP_ID`, set by `mgr_op`). The minimum grace period is 10 seconds; the supervisor stops new work, restarts the workers, verifies each acknowledged the new revision, and only then promotes the change ([manager_lifecycle.md](manager_lifecycle.md)).

   ```bash
   jq -n --arg c "$OP_ID" '{changeRef:$c, graceSeconds:10}' > "$W/restart.json"
   mgr_op lifecycle.apply "$W/restart.json"
   for i in $(seq 1 60); do [ "$(mgr GET /features | jq '.features.knowledge.pending')" = false ] && break; sleep 2; done
   mgr GET /features | jq -c '.features.knowledge | {active, pending, reasons}'
   ```

   Expected: `{"active":false,"pending":false,"reasons":[{"code":"DISABLED","detail":"features.json"}]}`. `MAINTENANCE_ACTIVE` means the maintenance barrier is held (a backup, restore or update is running or left one behind); `409 NOT_SUPERVISING` means the manager was not started with `--supervise`, so nothing can restart the workers. To turn it on, repeat with `{changes:{knowledge:true}}`. (`POST /lifecycle/restart` restarts the workers at the **current** revision, which is right for a changed secret or setting but does not promote a pending feature change.)

### What "disabled" means

| Surface | When the feature is off |
|---|---|
| Portal routes and sockets | The edge answers `404` with `FEATURE_UNAVAILABLE` ("That feature is not available on this installation."); the room leaves the navigation. |
| Slash commands | Not loaded or deployed; a stale click on an old command is refused. |
| Chat tools and MCP | Not offered to the model; a direct call returns `FEATURE_UNAVAILABLE`; the model's prompt gains an `UNAVAILABLE HERE:` line. |
| Schedules and startup steps | Skipped and reported as `skipped:feature`. |
| Documentation | Never hidden: Goobster can still explain how to turn it on, and notes that it is off ([self_knowledge.md](self_knowledge.md)). |
| Your data | **Kept.** Turning a feature off never deletes its tables or files, and turning it on finds them unchanged. Removing a dormant feature's data is a separate, typed, backed-up operation, `reset --scope feature` ([data_reset.md](data_reset.md)). |

Where `features.json` does not exist (an installation older than the catalog), nothing new is refused; the first write adopts explicit feature state ([feature_state.md](feature_state.md#reported-versus-enforced)).

### Change a setting

Settings that are `restart` apply when the workers restart; `hot` ones apply per request. The Host room's **Connections** and **Instance Defaults** pages preview, apply and offer the restart; headless it is `config.set` as in Getting started step 7 (`expectedRevision` from `GET /config`). A setting the environment controls is `ENV_CONTROLLED` and a masked value is `MASK_IS_NOT_A_VALUE` ([manager_configuration.md](manager_configuration.md#configset)).

**What this cannot do.** It cannot add a feature the payload was built without (`FEATURE_NOT_INSTALLED`; the payload selection is [packaging.md](packaging.md)), it never changes a feature you did not name, and `GOOBSTER_FEATURE_<ID>=1` cannot turn on something the file or the legacy switch has off.

## Service ownership

The manager records what it created, and only that is ever changed or removed. Know which of these you have.

| How it was installed | Who registered the OS service | How you can tell |
|---|---|---|
| `.run`, `.exe` or package as an administrator | The installer, through the privileged helper: `goobster.service` (Linux), the `goobster` Windows service, a LaunchDaemon `io.goobster.goobster` or a per-user LaunchAgent (macOS) | `status --json` lists it under `installation.services` with `registeredBy: installer` |
| `"registerService": false`, or no rights, or no systemd | Nobody. You run `goobster-manager --supervise` yourself, or install the rendered unit by hand (`<manager store>/goobster.service`) | `installation.services` is empty; a unit you installed by hand has no marker and the installer will never remove it |
| `scripts/install-rpi.sh` (a git checkout) | You or the old script; the unit is yours | `discover` reports the candidate as `rpi`; `adopt` records it without moving anything |

1. **See what the manager owns.**

   ```bash
   "$MGR" status --json | jq '.status.installation | {installationId, origin, layout, updater, services}'
   ```

   `updater.kind` is `manager` when the manager is the one updater of this installation, `script` when `scripts/auto-update.sh` still is. `services` is the list the manager will unregister at uninstall, each with `registeredBy: installer`. On a registered Linux service the unit also carries an `X-Goobster-Installation=<id>` line that the helper checks before it overwrites or removes the file:

   ```sh
   grep X-Goobster-Installation /etc/systemd/system/goobster.service
   ```

2. **Adopt an installation that is already running** (a Raspberry Pi script install, a manual checkout, PM2, Docker). The plan moves no files and changes nothing in the database:

   ```sh
   goobster-manager discover
   goobster-manager adopt --dry-run
   goobster-manager adopt --yes
   ```

   Adoption reconciles the updater so two updaters never run: a user cron line is commented out in place (`#goobster-manager-disabled: <line>`), a systemd timer is disabled through the helper (needs `sudo` or `pkexec`), and a PM2 watch must be stopped by you first. `UPDATER_CONFLICT` means a second updater cannot be disabled (an `auto-update.sh` without the `goobster-manager-guard` marker, or a PM2 watch); `UPDATER_NOT_OURS` means the timer or cron line is not for this code root. `keepUpdater: true` in the answers keeps the old updater and records `updater.kind: script` ([manager_install.md](manager_install.md#adopt-managed-form)).

3. **Know what the manager refuses.**

   | Code | Meaning and remedy |
   |---|---|
   | `SERVICE_FOREIGN` | A unit or service named `goobster` exists and is not this installation's. It is left alone; rename or remove yours, then run `repair`. |
   | `SERVICE_DUPLICATE` | Another unit of this installation is registered. Remove it first. |
   | `UNKNOWN_SERVICE_OWNER` | An uninstall found a registered service it does not recognise. It is left in place unless the answers say `acknowledgeUnknownServices`. |
   | `DOCKER_RESOURCE_FOREIGN` | A Docker container, volume or network has the installer's name but not its label; it is never touched. |
   | `UPDATER_NOT_MANAGER` | An update was asked on an installation another updater owns. |

   Nothing the installer does changes another launchd job, systemd unit or Windows service whose marker is not its own, and an external Postgres is never touched.

**What this cannot do.** The manager does not install system packages (`ffmpeg`, `bubblewrap`, ... are reported as `SYSTEM_DEPENDENCY_MISSING`, never installed), does not remove the `goobster` or `_goobster` account (the helper has no operation for it), and cannot take over a service it did not register. Not walked: registration, adoption and the helper need systemd and a real second updater.

## Network access

| What | Where it listens | Reachable from |
|---|---|---|
| The manager (wizard, `/manager/api`) | `127.0.0.1:3400` (`GOOBSTER_MANAGER_PORT`) | This machine only. A non-loopback `GOOBSTER_MANAGER_HOST` refuses to start (`NON_LOOPBACK_REFUSED`). `GOOBSTER_MANAGER_LAN=1` also needs `GOOBSTER_MANAGER_TLS_CERT`, `GOOBSTER_MANAGER_TLS_KEY` and `GOOBSTER_MANAGER_LAN_HOST` (`LAN_REQUIRES_TLS`, `LAN_REQUIRES_HOST`) and then serves HTTPS only. Recovery routes are loopback in every case (`403 LOCAL_ONLY`). |
| The portal and API, standalone layout | Port `3100` (`GOOBSTER_API_PORT`), **all interfaces** | Every machine that can reach the host. Put it behind a reverse proxy or a firewall. |
| The bot's health endpoint, lite layout | Port `3000` (`PORT`), all interfaces, `GET /health` only | The same. |
| The bot's panel, lite layout | `127.0.0.1` on `GOOBSTER_PANEL_PORT` (3400 unless set, 3401 under the supervisor; off with `panel.enabled: false`) | This machine only. The supervisor gives a bot it starts `GOOBSTER_PANEL_PORT=3401` when the manager is on 3400 ([manager_lifecycle.md](manager_lifecycle.md#layouts)); a bot you run yourself needs its own port. |
| The sandbox runner | `3200` (`GOOBSTER_SANDBOX_PORT`), shared-secret auth | Keep it on a private network. |

1. **Check what is actually listening.**

   ```bash
   ss -ltn | awk 'NR==1 || /:('"$API_PORT"'|'"$MGR_PORT"')[[:space:]]/'
   ```

   Expected: the manager's port on `127.0.0.1`, the API's on `*` or `0.0.0.0`. If the manager is on anything else, something set `GOOBSTER_MANAGER_HOST`.

2. **Reach the manager from your own computer.** Never open it to the network; tunnel instead:

   ```sh
   ssh -L 3400:127.0.0.1:3400 <user>@<host>
   ```

   then open `http://127.0.0.1:3400/manager/`. The manager checks that the `Host` header names itself (`421 BAD_HOST`), so a tunnel on another local port needs the same port number on both sides.

3. **Publish the portal.** Terminate TLS in front of port 3100 (the full profile's `deploy/nginx.conf` is a working example: it proxies the portal and its event stream and answers `404` for everything under `/internal/`), then tell Goobster its public address so sign-in links, cookies and OAuth redirects match:

   ```sh
   jq -n --arg r "$(mgr GET /config | jq -r .revision)" \
       '{expectedRevision:$r, changes:[{id:"webapp.publicUrl", action:"set", value:"https://goobster.example.org"}]}' > "$W/url.json"
   mgr_op config.set "$W/url.json"
   ```

   With an `https` public URL the session cookie is `Secure`. Real Discord sign-in additionally needs `<publicUrl>/api/app/auth/callback` registered in the Discord Developer Portal ([webapp_setup.md](webapp_setup.md)).

**Never exposed:** the manager's API and recovery routes, the bot's `/internal/gateway/*` API (the proxy answers `404`; the manager-bridge key stays in the manager store), the maintenance and operator mutation routes without a session, and any secret (status documents carry names, never values).

**What this cannot do.** Goobster does not open a firewall port, request a certificate, or terminate TLS for the portal itself; the manager never serves a non-loopback address over plain HTTP.

## Backup and recovery

A backup is a directory archive of the database, the file sets and (optionally) `config.json` encrypted under a passphrase. **Only `config.json` is encrypted; the archive is not.** What is in it, which file sets are covered and what you must re-enter after a restore is [backup_and_restore.md](backup_and_restore.md#what-an-archive-contains). The manager's backup and restore are the supported path for an installation it looks after.

### Take a backup

There is no built-in scheduler ([setup_wizard.md](setup_wizard.md#what-is-not-here-yet)); run the command from `cron` or a systemd timer if you want a schedule. A backup only reads the application and works while it runs. Paths must be absolute.

1. **Write the passphrase file** (first line is the passphrase; mode 0600) and take the backup.

   ```bash
   mkdir -p "$BASE/backups"
   (umask 077; openssl rand -base64 24 > "$BASE/backup.pass")
   "$MGR" backup --out "$BASE/backups" --include-config --passphrase-file "$BASE/backup.pass"
   ```

   Expected: progress on stderr and a result ending with the archive directory, `goobster-backup-<UTC stamp>`, `integrity complete` and the table and row counts. Refusals: `INVALID_INPUT: "dir" must be an absolute path` (use `$BASE`, not `~` or a relative path), `PASSPHRASE_REQUIRED` (`--include-config` with no passphrase: `config.json` is never archived in plaintext), `SECRET_ON_ARGV` (you passed a secret as a flag), and a passphrase file that is not mode 0600.

2. **Look inside it, read-only.**

   ```bash
   ARCHIVE=$(ls -d "$BASE"/backups/goobster-backup-* | tail -n 1)
   "$MGR" backup inspect "$ARCHIVE"
   ```

   Expected `verdict   can be restored here`. `TAKEN_WHILE_RUNNING` is a warning, not a block. A different engine or schema is named and refused at restore (`--accept-schema-change` overrides only a schema difference).

3. **Put a copy somewhere else, and keep the passphrase apart from it.** A backup on the same disk is not a backup. The passphrase is not recoverable: without it `config.json` cannot be restored (the rest of the archive can, with `--without-config`).

### Restore

Restore replaces the database, the file sets and (with the passphrase) `config.json`. What it replaces is moved aside (`.pre-restore-<time>`), never deleted, and a verified safety backup of the current data is taken first. In-flight work is failed with the reason `interrupted by restore` and never retried. **The instance comes back paused.**

1. **Restore through the running manager.** This is the route to use: the manager fences the workers, restores, restarts them and releases the barrier itself. The archive path and the installation id (the typed confirmation) must be exact.

   ```bash
   INSTALLATION_ID=$("$MGR" status --json | jq -r '.status.installation.installationId')
   mgr_session
   jq -n --arg d "$ARCHIVE" --arg c "$INSTALLATION_ID" --rawfile p "$BASE/backup.pass" \
       '{dir:$d, confirm:$c, passphrase:($p|rtrimstr("\n")), release:true}' > "$W/restore.json"
   mgr_op backup.restore "$W/restore.json"
   ```

   Expected: `"status":"applied"` and a result with `"database":{"restored":true}`, `"config":{"restored":true}`, `"instancePaused":true`, `"workersRestarted":true`, `"maintenance":{"held":false,...}`, `"rowCounts":{"matchesArchive":true}`, the `retained` locations of what was set aside, and the secrets to enter again. Refusals: `CONFIRMATION_REQUIRED` (the typed installation id is missing or wrong), `ENGINE_MISMATCH` and `SCHEMA_MISMATCH` (the archive is from another engine or schema; `backup inspect` says so first, and only the schema difference can be accepted, with `acceptSchemaChange`), `FOREIGN_TARGET` (the archive belongs to another installation's layout), `BAD_PASSPHRASE` (nothing is restored; run again with the right one) `PLAN_INPUT_LOST` (the manager restarted between plan and apply; plan again).

2. **Check the paused state, then resume.** The portal shows a strip saying the instance is paused; scheduled work (reminders, schedules, expeditions, watches) is on hold and nothing that came due while it was down fires late. Check your data first, then resume: Host room, Overview, Instance panel, **Resume**. Headless, with an owner session:

   ```bash
   for i in $(seq 1 45); do curl -fs "http://127.0.0.1:$API_PORT/health" >/dev/null && break; sleep 2; done
   jq -n --rawfile p "$W/pw" '{loginName:"owner", password:($p|rtrimstr("\n"))}' \
       | curl -fsS -c "$W/cookies" -X POST "http://127.0.0.1:$API_PORT/api/app/auth/native-login" \
             -H 'content-type: application/json' --data-binary @- >/dev/null
   curl -sS -b "$W/cookies" "http://127.0.0.1:$API_PORT/api/app/admin/instance" | jq -c .
   curl -sS -b "$W/cookies" -X POST "http://127.0.0.1:$API_PORT/api/app/admin/instance/resume" | jq -c .
   ```

   Missed reminders are cancelled and the owner is told in the Inbox; missed schedules move to their next future time ([backup_and_restore.md](backup_and_restore.md#the-instance-comes-back-paused)). Releasing maintenance does **not** resume a paused instance, and there is deliberately no "resume everything" control.

3. **Restore with the manager stopped.** For a machine where the manager is not running (it was stopped, or never started). The command line runs its own manager for the duration, so stop the supervising one first, by the process id you kept.

   ```bash
   kill -INT "$(cat "$BASE/manager.pid")"
   for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 || break; sleep 1; done
   "$MGR" restore "$ARCHIVE" --confirm "$INSTALLATION_ID" --passphrase-file "$BASE/backup.pass" --release
   ```

   Expected: the archive and the restore plan (`replaces the database, config.json`, `afterwards the instance is paused; the maintenance barrier is released`), the progress lines, then the result: `workers    not restarted by this command: restart the application workers`, `paused     yes; maintenance barrier released`, the `kept aside` locations, one `enter again` line for each environment secret the archive records as set, and `next       Host room -> Instance -> Resume`. Exit 0. If a command waiting on the barrier ever ends early and leaves a `quiesce` barrier held ([known issue 1](#known-issues-found-by-the-walk-through), fixed), lift it with `"$MGR" release --force --acknowledge-mutation` and use step 1 instead. Start the manager again to use the instance (Getting started step 4), then resume as in step 2.

### Recover when something is lost

| You lost | Do this |
|---|---|
| The owner's password | Another operator resets it from the Host room; with no operator left, mint a recovery credential on the machine (`"$MGR" --mint-recovery`) and create a new owner with `owner.create` as in Getting started step 6 (`ACCOUNT_EXISTS` means an account already exists: sign in or ask the owner). |
| The portal (it will not start) | `"$MGR" status` shows the installation and the last operations; `repair` re-stages the payload when it fails verification and re-applies the schema (`CURRENT_OK` when healthy). |
| The manager's store (`<data>/manager`) | The manager starts in `recovery` (`MANAGER_STORE_MISSING`) and does nothing until a local operator unlocks it with a recovery credential and runs `adopt`. First-time setup never reopens on an existing installation ([manager.md](manager.md#explicit-adoption-of-an-existing-installation)). |
| A maintenance barrier a dead process left | `"$MGR" status` and the wizard show it; `"$MGR" release --force --acknowledge-mutation` lifts it. It never resumes a restore on its own. |
| The host | Restore the archive on a new host with a fresh install, then [Restore](#restore). The documented drill on a second real host is [owner decision #249](#owner-decisions-still-open). |

**What this cannot do.** A backup is a point in time: everything written after it is lost on restore. The archive's database and files are not encrypted. A restore never re-creates environment secrets (provider keys, OAuth secrets), and it refuses another database engine. A passphrase cannot be recovered.

## Migration and rollback

### SQLite to Postgres

Use this when one machine is no longer enough or the bot and portal are on different hosts. Read [db_migration.md](db_migration.md) once; the order is preflight, then run.

1. **Have a Postgres to move to.** An existing server you own ([database_connection.md](database_connection.md); `database test` is read-only, `database provision` prepares an empty database with an administrator credential used once), or the installer's own Docker container ([docker_postgres.md](docker_postgres.md): `database docker provision`, then `database connect`). On a supported Linux host the installer can also install PostgreSQL itself as a native package and create a cluster it owns ([native_postgres.md](native_postgres.md): `database native provision`, then `database connect`; not walked here); for a hand-made server follow [postgres_setup.md](postgres_setup.md). The connection URL and passwords never go on a command line: they live in an answers file (mode 0600) or a hidden prompt.

2. **Preflight (read-only, safe while the application runs).**

   ```sh
   goobster-manager migrate preflight --answers pre.json
   ```

   with `{"command":"migrate-preflight","target":{"url":"postgres://<role>@<host>:5432/<database>?options=-c%20search_path%3Dgoobster"}}` in `pre.json`. Exit 0 is ready; exit 2 lists blocking findings (`PREFLIGHT_FAILED` with the finding codes, for example a non-empty target schema or a missing extension).

3. **Run it.** The command backs up (verified before the first write), copies, verifies beyond row counts, starts the application on the target, then switches. `--release` lifts the maintenance barrier after the cutover.

   ```sh
   goobster-manager migrate run --answers run.json --confirm <installationId> --release
   ```

   Expected: one progress line per step and per table, then the result with the rollback-limit sentence. Exit 4 means a step failed or it was interrupted: run the same command to resume, or roll back. Refusals: `ALREADY_POSTGRES`, `ALREADY_MIGRATED`, `MIGRATION_IN_PROGRESS`, `BACKUP_UNVERIFIED`, `VERIFY_FAILED`, `VALIDATION_FAILED`, `CONFIRMATION_REQUIRED` ([db_migration.md](db_migration.md#refusal-and-error-codes)).

4. **Check where you are.**

   ```sh
   goobster-manager migrate status
   ```

### Rollback - and what it cannot recover

```sh
goobster-manager migrate rollback --confirm <installationId> --release
```

> Rollback to the SQLite source is possible until the first write reaches Postgres. After the maintenance barrier is released and a worker starts on Postgres, the SQLite file is a backup, not a fallback: switching back is a separate restore decision, never automatic.

Before that boundary rollback reverts the switch, drops exactly the tables the migration created, and records `rolled-back`; the SQLite file was never changed after the backup. After it the command is refused with `POSTGRES_HAS_WRITES`; other refusals are `NOTHING_TO_ROLL_BACK`, `TARGET_MISMATCH` and `ROLLBACK_FOREIGN_OBJECTS` (something you added to the schema; nothing is dropped). Going back after the boundary means restoring a SQLite archive made before it, and everything written on Postgres since is lost. **The tested restore drill on a second host is owner decision #249.** The CLI creates the barrier itself and the barrier belongs to its process; `--release` is how you lift it, and the operator pages' `maintenance.release` lifts a stale one.

### Docker-managed Postgres

The installer owns one labelled container, volume and network; it never touches a resource without its label. The operations are `database docker status|provision|start|stop|repair|reconfigure` ([docker_postgres.md](docker_postgres.md#the-operation-kinds)). `stop` while the installation is connected is refused (`DATABASE_IN_USE`); `repair` recreates a missing container over the same storage and refuses a missing volume (`DATA_MISSING`) because a new container would start an empty database; `reconfigure` needs the maintenance barrier and a verified backup first (`MAINTENANCE_REQUIRED`, `BACKUP_REQUIRED`). Moving the data elsewhere is `STORAGE_MOVE_UNSUPPORTED`. **Not walked:** Docker is not available on the walked machine.

**What this cannot do.** There is no Postgres-to-SQLite path, the migration does not move the data root or any file, does not create a server, and does not delete the SQLite file. A backup taken on one engine cannot be restored onto the other.

## Upgrade

The manager is the updater when `updater.kind` is `manager` ([service ownership](#service-ownership)). The default policy is **off**: nothing checks, downloads or applies until you choose. Read [manager_update.md](manager_update.md) once; this is the procedure.

1. **Set the policy.** Modes: `off`, `check` (look every six hours and record it), `download` (also stage), `apply` (also apply inside the window; honoured only while the manager is the updater). Channels: `stable` (default) or `prerelease`; a stable installation never stages a prerelease (`CHANNEL_MISMATCH`).

   ```bash
   "$MGR" update policy --mode check --channel stable
   "$MGR" update status
   ```

   Expected: the policy lines, `installed 1.0.0` and the last check. A source is `--github <owner/repo>`, `--source-url <base>` or `--source-dir <dir>` (an air-gapped copy or a USB stick); `--window sun,sat/2-4/UTC` limits when an automatic apply may begin.

2. **Check, stage, apply.**

   ```sh
   goobster-manager update check
   goobster-manager update stage
   goobster-manager update apply --now      # or --window to wait for the window
   ```

   `check` reports a newer release or `NO_UPDATE_AVAILABLE`; `stage` downloads, verifies the signed index and artifact and lays the release out next to the running one without changing anything running (`INDEX_UNSIGNED`, `UNTRUSTED_KEY`, `ARTIFACT_DIGEST_MISMATCH`, `DOWNGRADE`, `INSUFFICIENT_SPACE` stop here, with nothing applied). `apply` plans, holds the maintenance barrier, takes a verified backup of the data (`BACKUP_UNVERIFIED` stops before anything changes), swaps the release atomically, restarts the workers, and watches them for the **settle window** (30 seconds by default, `GOOBSTER_UPDATE_SETTLE_MS`). A worker that exits inside the window fails the update (`EXITED_AFTER_READY`).

3. **Read the outcome.** `update status` ends `applied`, `rolled_back` (the previous release is back; exit non-zero with `UPDATE_ROLLED_BACK`) or `recovery`. Whether a failure rolls back by itself or waits for you depends on whether the new release changed the database schema: see the table in [manager_update.md](manager_update.md#schema-compatibility) (not restated here).

4. **Decide a recovery** (a schema-changing update failed after the database was in use; the barrier stays held and the application stays fenced):

   ```sh
   goobster-manager update status
   goobster-manager update recovery --decision restore --yes     # previous release + the pre-update backup; every write since is lost
   goobster-manager update recovery --decision retry             # try the new release again; for a transient failure
   ```

   `restore` takes a safety backup of the data as it is now first. The portal shows the state but cannot decide; the decision is made on the machine. `RESTORE_FIRST`, `NO_BACKUP` and `PREVIOUS_UNAVAILABLE` say why a decision does not apply; a decision that does not verify leaves `UPDATE_RECOVERY_REQUIRED` and the barrier held, and can be decided again.

**What this cannot do.** It does not update the operating system, Node.js, Postgres or any service the manager does not own; it never downgrades (`DOWNGRADE`); it cannot roll the database back across a schema change except by restoring the backup in the `restore` decision. The Windows (WinSW) and macOS (launchd) handoffs are specified and unit-tested, not executed on those systems ([manager_update.md](manager_update.md#what-this-does-not-do)). **Not walked:** there is no published release to update to (the signing material is [owner decision #372](#owner-decisions-still-open)); `update status` and `update policy` were walked, `update apply` was not.

## Uninstall

The default keeps your data. Stop the application first: an uninstall refuses `WORKERS_RUNNING` while the manager supervises workers or any worker port is in use.

### Keep the data

1. **Stop what is running.** Stop the supervising manager by the process id you kept (a registered service: `sudo systemctl stop goobster`). It is harmless to repeat when it is already stopped.

   ```bash
   kill -INT "$(cat "$BASE/manager.pid")" 2>/dev/null || echo "the manager was already stopped"
   for i in $(seq 1 30); do curl -fs "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 || break; sleep 1; done
   ```

   Expected: the health check stops answering within a few seconds.

2. **Preview, then uninstall.**

   ```bash
   "$MGR" uninstall --dry-run
   "$MGR" uninstall --yes
   ```

   The preview lists `retained   data, config, cache, logs`, `removes    code: ...`, the tombstone and `services   none`. The uninstall exits 0 and prints the result. Refusals: `WORKERS_RUNNING` (stop the application, step 1), `PREFLIGHT_FAILED` with the blocking finding, `ELEVATION_REQUIRED` (a registered service needs rights to be removed: run it with `sudo`, or remove the unit by hand and run it again), `UNKNOWN_SERVICE_OWNER`.

3. **What is left, on purpose.** The data root (database, `features.json`, uploads, backups), the settings file, the cache and the logs stay. A `tombstone.json` in the data root keeps the host from being opened to a remote first claim, and the manager's store keeps its journal and audit log. `$BASE/manager.pid`, your answers file and any archive you wrote outside the roots are yours. The `goobster` account of a registered install stays. An external Postgres, and a Docker database unless you chose to remove it, are never touched. Installing again over kept data works: the database, `config.json` and `features.json` are kept (`write-config` and `write-features` report `ALREADY_DONE`), and the manager records a new installation id, so read it again with `status`.

   ```bash
   sh "$RUN" --headless --answers "$ANSWERS" --base "$BASE" --yes
   ```

### Remove everything

Deleting data is typed and cannot be pre-approved: `--yes` never stands in for it, and the confirmation is the installation id, read from `status`.

1. **Stop the application** as above, then read the id and preview.

   ```bash
   INSTALLATION_ID=$("$MGR" status --json | jq -r '.status.installation.installationId')
   "$MGR" uninstall --dry-run --delete-data --confirm "$INSTALLATION_ID"
   ```

   The preview names the data roots it will remove and, for a Docker database, warns `DOCKER_DATA_RETAINED` until you also choose `removeDockerData`.

2. **Uninstall and delete the data.**

   ```bash
   "$MGR" uninstall --yes --delete-data --confirm "$INSTALLATION_ID"
   ls -A "$BASE"
   ```

   Expected: the steps end `remove-data` and `remove-ownership` as `done`, exit 0, and the listing is what [What is left](#remove-everything) describes. A missing or wrong confirmation exits 2 with `CONFIRMATION_REQUIRED` and `nothing was removed`.

**What is left.** On the walked machine, after a full removal: `$BASE/data/tombstone.json` and the manager's store (`data/manager`: the operation journal, `audit.jsonl`, the lifecycle and maintenance records), the now-empty `code` directory, `$BASE/manager.pid`, `$BASE/backup.pass`, your `$BASE/backups`, and `config/config.json.pre-restore-<time>` because a restore had run there ([Known issues](#known-issues-found-by-the-walk-through) 5). The database, `config.json`, `features.json`, uploads, cache and logs are gone.

**What this cannot do.** It cannot be undone; take a backup first if you might want the data. It does not remove a Docker volume unless you asked (`removeDockerData` with the id typed), an external Postgres, the service account, system packages, or files you created outside the recorded roots. Uninstalling from the wizard page of a registered service stops the service that serves the page, so use the command line for that case. Windows removal is also in Programs and Features (keep-data only) and macOS has the same commands with the launcher under `<base>/code/current/bin/` ([windows_install.md](windows_install.md#repair-reconfigure-uninstall), [macos_install.md](macos_install.md#repair-reconfigure-uninstall)); not walked.

## Owner decisions still open

These are decisions or evidence that belong to the project owner. This document does not make them and nothing here claims them done.

| Open item | What it blocks | What an operator does meanwhile |
|---|---|---|
| [#249](https://github.com/nervous-rob/goobster/issues/249) - actual-host recovery | The dated drill: a restore of a real archive onto a real second host. Automated tests prove the restore on throwaway databases only. | Take backups ([above](#take-a-backup)), keep a copy off the host, and run the restore drill on a spare machine before you invite anyone; record the date yourself. |
| [#255](https://github.com/nervous-rob/goobster/issues/255) - authentication policy | A decided rule for who may register and how accounts recover. | Keep `identity.registration` on invitation only (the default for a standalone install), create accounts from the Host room, and do not enable open sign-up. |
| [#262](https://github.com/nervous-rob/goobster/issues/262) - public listing | Whether and how an instance is listed or advertised publicly. | Treat the instance as private: do not publish its address beyond the people you invite. |
| Signing material for [#372](https://github.com/nervous-rob/goobster/issues/372) | A release build: every artifact today is an unsigned `-dev` build, and an update source needs a signed index. | Install `-dev` builds only on machines you trust; use `update policy --mode off` or `check`, and apply updates from a `--source-dir` you built yourself. |

## Known issues found by the walk-through

Each of these was met while following this page. Item 1 has since been fixed in the manager by the release-acceptance work; the others are unchanged and each has a workaround that uses only what is documented here.

1. **Fixed: `goobster-manager restore` run as its own command could exit 1 with no message** after `[backup.restore] maintenance ...`, leaving a held `quiesce` barrier. The command line waited for the barrier with a timer that did not keep the process alive (`sleep()` in `apps/manager/maintenance/barrier.js` called `unref()`), and when nothing else held the process the CLI's exit guard (`process.on('exit')` in `apps/manager/cli.js`) turned the early exit into code 1. It reproduced three times on the walked machine; with the timer made to count, the same restore finished with exit 0 in about five seconds. A restore through the running manager was never affected because the manager's server keeps the process alive. The release-acceptance work (`documentation/release_acceptance.md`) met the same defect from `restore`, `reset` and `migrate` and removed the `unref()`, with a regression test in `tests/maintenanceBarrier.test.js`; [Restore](#restore) step 3 no longer needs a workaround. If an older build leaves a barrier held, lift it with `release --force --acknowledge-mutation`.
2. **A headless install does not enable native sign-in.** `identity.nativeLogin` is set by the wizard when it creates an owner, not by `owner.create` or by the install, so the first sign-in is `503 NATIVE_LOGIN_DISABLED` until the answers file (or `config.set`) sets it. [Getting started](#linux-headless) step 2 puts it in the answers file.
3. **The manager's own documentation says to apply with `{"revision": null}`** ([manager.md](manager.md#explicit-adoption-of-an-existing-installation)); that is right for `adopt` and `lifecycle.*`, but `config.set`, `features.set`, `owner.create` and `backup.restore` need the plan's integer `revision`, and `validate` takes no body. The helper in Getting started step 5 reads the revision from the operation instead of assuming one.
4. **Every manager step above needs an HTTP client and `jq`.** There is no command-line verb for `owner.create`, `features.set`, `config.set`, `lifecycle.restart`, `backup.restore` through a running manager, or the instance resume. The helper functions are the documented way until the command line gains them; the setup wizard and the Host room are the other way.
5. **A full removal leaves a secret-bearing file when a restore ever ran.** A restore sets the previous `config.json` aside as `<config dir>/config.json.pre-restore-<time>`; `uninstall --delete-data` removes the data root and `config.json` itself but not that file, which still holds the previous settings, provider keys included. The walked machine showed it after a full removal. Delete it by hand (`rm` the file) after a full removal, and the same for any other `*.pre-restore-*` you kept outside the data root. Source fix needed: include set-aside config files in the uninstall's removal list.
6. **The standalone API listens on all interfaces** (`apps/api/index.js` calls `listen(port)` with no host) while the manager and the bot's panel are loopback only. A host with a public address exposes port 3100 unless a firewall or proxy stops it ([network access](#network-access)).

## How this was verified

- **Walked on Linux (x64, no systemd, no Discord):** Getting started steps 1 to 8 (install from a development `.run`, supervised manager, owner creation, provider key, sign-in and a chat turn), Backup and Restore (manual backup with `--include-config`, `backup inspect`, restore through the running manager, the paused state and resume), Feature toggle, and Uninstall (keep data, install again over it, remove everything). Transcript: `/tmp/run343/walkthrough.log` on the machine that ran it; it holds no password, key, passphrase or credential.
- **Not walked:** Windows, macOS, Raspberry Pi, the wizard in a browser, systemd registration and the privileged helper, adoption of a second updater, SQLite to Postgres migration and rollback, Docker-managed Postgres, `update apply`, a recovery decision, and a real second-host restore (#249).
- **Names:** every command, flag, path, port, environment variable and code on this page was checked against the tree at the commit that carries this page.
- **Self-knowledge:** the page is in the `consultDocs` corpus; `tests/operatorRunbooksDocs.test.js` seeds the corpus on a throwaway database and checks the page and its headings are found, ([self_knowledge.md](self_knowledge.md)).
- **Accessibility of the setup and operator pages:** [accessibility_review.md](accessibility_review.md).
