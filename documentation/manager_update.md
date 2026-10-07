---
title: Manager updates - staged apply, health checks and compatible rollback (installer P5.2)
kind: reference
summary: How the manager checks a release source, stages a signed release without touching the running one, applies it inside the maintenance barrier, hands over to its own new code through the operating system's supervisor (exit code 76), verifies it (restart, /health, revision acknowledgement, running release id), cuts over, and rolls back when it does not verify. Holds the update policy (channel, mode, window, source), the schema fingerprint rule that decides whether an automatic rollback is safe, the rollback table, the recovery decision after a schema-changing failure, the crash matrix of the handoff, how the manager becomes the only updater, the CLI, the HTTP routes, the ledger step names and every error code.
when: Turning updates on or off, choosing a channel or an update window, applying or staging a release by hand, understanding why an update rolled back or is waiting for a decision, deciding between restoring a backup and retrying, reasoning about what survives an update (config.json, features.json, the service registration), changing the update machinery, or debugging a handoff that did not finish.
tags: [installer, manager, update, upgrade, rollback, recovery, schema, fingerprint, handoff, maintenance, health, channel, window, release, policy]
---

# Manager updates

Issue #342, installer plan Phase 5 item 2. #341 made releases that can be
trusted (`documentation/release.md`); this is the part that installs one over
another. The rule of the whole feature is the same as the rest of the manager:
nothing happens to a running installation until a verified release is on disk
next to it, nothing is replaced without the maintenance barrier
(`documentation/maintenance_barrier.md`) holding the application still, and a
failure never loses data silently.

An update changes the **code** (`<code root>/releases/<id>`, the `current`
pointer) and nothing else. `config.json`, `features.json`, the data roots and
the database are not part of a release and are never rewritten by one (see
[What an update keeps](#what-an-update-keeps)).

## The policy

An installation records one explicit policy in its installation record. The
default is off: an installation that never chose does not check, download or
apply anything.

```json
{
  "update": {
    "channel": "stable",
    "mode": "check",
    "window": { "days": [0, 6], "startHour": 2, "endHour": 4, "tz": "UTC" },
    "source": { "kind": "github-release", "owner": "nervous-rob", "repo": "goobster" }
  }
}
```

- `channel`: `stable` (default) or `prerelease`. A stable installation never
  stages a prerelease (`CHANNEL_MISMATCH`).
- `mode`, what happens without anyone asking:
  - `off` (default): nothing. A manual check, stage or apply still works.
  - `check`: look for a newer release every six hours and record it.
  - `download`: check, then stage the release (download, verify, lay out next
    to the running one). Nothing running changes.
  - `apply`: check, stage, then apply inside the window. Honoured **only
    while the manager is the updater** (`updater.kind === 'manager'`, see
    [One updater](#one-updater)); otherwise the effective mode is capped at
    `download` and the policy plan says so.
- `window` (optional): the days (0 is Sunday), start and end hour and time
  zone (`UTC`, `local` or an IANA name) in which an automatic apply may begin.
  An end hour before the start hour wraps past midnight. A manual
  `update apply --now` ignores the window; `update apply --window` waits for
  it.
- `source`: where releases come from.
  - `github-release` (`owner`, `repo`): the GitHub Releases API of one
    repository. The default is this project's repository.
  - `url` (`base`): an address that serves `release-index.json`,
    `release-index.sig` and the artifacts it names.
  - `directory` (`dir`): a local directory laid out the same way (an
    air-gapped copy, a USB stick, the proof and the tests).

The policy is shown to the portal and in operation records by **kind only**
(`github-release`, `directory`, `url`); a directory or an address never leaves
the manager's own store.

The setup wizard asks once, on a fresh install (the default shown is
`check`), and an adoption of an instance that has an `auto-update.sh` timer
asks at adoption. On a terminal the install and adopt commands ask the same
question; a scripted run puts `update` in the answers file (`mode` and
optionally `channel`; the window and the source are set afterwards with
`update policy`).

## What an update does

Five operation kinds carry the work, all of them in the step ledger of
`documentation/manager.md` (a plan, a confirmation, one audit entry):

| Kind | What it does | Ledger steps |
|---|---|---|
| `update.check` | Fetch the signed index, verify it under the production trust policy, compare it with the installed release. Writes `last-check.json` only. | `fetch-index`, `verify-index`, `compare`, `record` |
| `update.stage` | Check, then download the payload archive, verify its digest against the index, extract it safely, verify the payload manifest, compute the schema fingerprint, lay it out as `<code>/releases/<id>` without moving `current`. | `preflight`, `fetch-index`, `verify-index`, `space`, `download`, `stage`, `record` |
| `update.apply` | The apply below. | `preflight`, `maintenance`, `backup`, `activate`, `handoff`, `verify`, `cutover`, `release` |
| `update.policy` | Change the policy. | `record` |
| `update.recover` | The operator's decision after a failed schema-changing update. | `restore-data`, `put-back`, `verify`, `release` |

### Trust

The index is verified exactly as `documentation/release.md` describes for the
production policy: the signature over the canonical index bytes, the signing
key against the trusted key list (`scripts/release-keys.json`, plus the file
named by `GOOBSTER_RELEASE_PUBLIC_KEY_FILE` for a private mirror), the target,
the minimum manager version, the ABI. The artifact is then checked against
the size and SHA-256 the verified index names, before and after it is
extracted, and the extracted payload's own signed manifest is verified by the
install engine's payload verifier. A downloaded file that fails any of these
is deleted and **nothing is applied** (`ARTIFACT_DIGEST_MISMATCH`,
`INDEX_BAD_SIGNATURE`, ...). Installed payloads carry
`scripts/lib/payloadStage.js`, `scripts/lib/releaseIndex.js` and
`scripts/release-keys.json` for this reason.

A release that is not newer than the installed one is `DOWNGRADE`, and there
is no flag that overrides it: moving back is the recovery decision, not an
update.

### Staging

`update.stage` needs the free space of the archive, its extraction, a backup
estimate and a margin (`INSUFFICIENT_SPACE`), keeps at most three older
release directories, and records `staged.json`. A staged release is only
valid for the installed release it was prepared against (`STAGE_STALE`
otherwise). Staging does not stop, pause or change anything that runs.

### Apply

`update.apply` plans first (the plan names the versions, whether the schema
changes, how the handoff will go and the window), then runs inside the
maintenance barrier. With `--window` (or a policy `apply` run) outside the
window the apply is **scheduled**: `scheduled.json` records when the window
opens and the ledger steps are `skipped` with `SCHEDULED`; the manager's own
timer applies it when the window opens.

1. `preflight`: the staged release is present and current, the policy allows
   it, the handoff mode is known.
2. `maintenance`: the barrier is begun with a fencing token and every writer
   is quiesced and verified (the countdown the maintenance barrier shows
   applies). **The clock for downtime starts here.**
3. `backup`: a verified backup of the database is written under
   `<dataDir>/backups` (the data only, `includeConfig: false`: `config.json`
   is never copied) and compared against the live database inside the
   barrier. An unverified backup stops the update before anything changed
   (`BACKUP_UNVERIFIED`). An installation with no data yet skips it
   (`TARGET_EMPTY`).
4. `activate`: the barrier moves to its `mutate` phase, `watchdog.json` and
   `handoff.json` are written (phase `activating`), the new release is
   swapped in atomically (`current` points at it), and the handoff becomes
   `pending`.
5. `handoff`: see [The handoff](#the-handoff).
6. `verify`: the workers restart, are verified and then watched for the
   settle window (below).
7. `cutover`: the installation record is updated to the new release (the
   release id, version, features) in one write.
8. `release`: the barrier is released, the service registration is
   refreshed if its template changed, and `last-apply.json` records how it
   ended and the downtime.

**Downtime** is the span from the end of quiesce (step 2) to the release of
the barrier (step 8): everything between, including the backup, the swap, the
restart, the verification and the settle window, is time the application does
not write. The barrier stays held through the window (the update is not done
until the release is stable), so the window is part of the downtime: with the
default 30 s window the downtime is the restart plus 30 s.

*Measured* (Linux x64, minimal payload on a small VM, a three-second drain, the
exit-76 handoff under a restart loop): 3.7 s from quiesce to release without a
window and 11.7 s with `GOOBSTER_UPDATE_SETTLE_MS=8000`. An external probe
polling `/health` every 200 ms saw the portal's API unavailable for 415 ms
(the worker restart); the rest of the span is the application held quiet by
the barrier. A rolled-back update that fails at start measured 14.4 s end to
end (two handoffs and the failed start included). It is
reported in the result, in `last-apply.json`, in the audit entry and in the
status. The portal and the bot are read-only or paused for that span.

### Verification

A new release has verified when, after restarting the workers:

- every worker process is up and answers `/health` with a 200;
- every worker acknowledged the maintenance **revision** it was started
  with (it reads the barrier state at start);
- the release id each worker launched from (`<code>/current` read at launch)
  is the release the update installed.

Nothing is verified by inspecting the database. A failing check at any point
is a failed verification.

### The settle window

Answering `/health` once is not proof a release is stable: a release can come
up, acknowledge, and die seconds later. So after every worker is ready the
update keeps watching for the **settle window**, with the barrier still held.
A worker that exits, crashes, is replaced by the supervisor, or conflicts
inside the window fails the verification with **`EXITED_AFTER_READY`**
(`EXITED_BEFORE_READY` stays the code for a worker that never got ready). That
failure takes the same road as any other failed verification, by the
[rollback table](#schema-compatibility): an automatic rollback when the update
did not change the schema, `recovery` when it did (the database was in use, so
the cause is recorded as `EXITED_AFTER_READY` and the code is
`SCHEMA_CHANGED_DATABASE_IN_USE`).

| Setting | Default | Meaning |
|---|---|---|
| `GOOBSTER_UPDATE_SETTLE_MS` (manager environment) | `30000` | the window in whole milliseconds, 0 to 600000; `0` turns the window off; anything else is ignored |

The window applies to both halves of a handoff: the manager that comes back
on the new release (`resume`) is the one that watches. While it runs,
`update status` shows `verifying (settling, N s left)` and the Host card shows
the same on its in-progress row; the window's end is kept in `handoff.json`
(`settleUntil`) and cleared when verification finishes. There is no new route:
the status route carries it (`handoff.settling`).

**Where the update's responsibility ends.** The window is the boundary. A
failure after it closes and the barrier is released is an ordinary operational
crash: the supervisor's restart policy and its crash-loop rule handle it, the
update stays `applied`, and nothing is rolled back (see the crash matrix).

## The handoff

The manager that starts an apply is the old release's code. If the new
release replaces the manager's own files (`selfReplacing`), the new code must
be the one that verifies, so the apply hands over through the operating
system's supervisor instead of verifying in the old process:

| Mode | When | What happens |
|---|---|---|
| `inline` | the running manager's code is not inside the payload an update replaces (a checkout, a test) | the old manager restarts the workers, verifies and releases in the same process |
| `exit` | the manager runs from the payload and the OS restarts it on failure (systemd, launchd, the Windows service, or `GOOBSTER_MANAGER_OS_SUPERVISED=1`) | the manager exits with **`EXIT_SELF_UPDATE` = 76** about 1.2 seconds after the apply responds; the OS service restarts it from the new `current`; the new manager finds `handoff.json` and finishes (`resume`) |
| `unavailable` | the manager runs from the payload and nothing would restart it | the apply is refused up front (`HANDOFF_UNAVAILABLE`); nothing changed |
| `offline` | no manager daemon, the command line applied it | the new release is in place and the apply completes the next time a manager starts |

(75 is the exit code of the *workers'* restart request; 76 is the manager's.)

The handoff is durable. `handoff.json` carries a phase, which is written
before the step it announces: `activating` (swap in progress), `pending`
(swapped, waiting for the new manager to verify), `verified`, `recorded`
(cutover done, barrier not yet released), `rollback`, `recovery`. A
`watchdog.json` holds the release to put back and a deadline (ten minutes):
a new manager that never starts is rolled back by the old code on the next
start (or by the operator), and an operator can always read the state with
`update status`.

### Crash matrix

`resume` is idempotent per phase and run at every manager start before
anything else.

| Where it stopped | State on disk | What the next start does |
|---|---|---|
| Before the swap (`activating`, `current` is the old release) | handoff `activating`, barrier held | clears the handoff, releases the barrier, records `abandoned` (`FLIP_NOT_REACHED`); the old release is running unchanged |
| After the swap, before the exit (`activating` or `pending`, `current` is the new release) | handoff `pending` | verifies the new release and goes on |
| After the exit, before verification (`pending`) | handoff `pending`, watchdog | verifies; on failure, applies the rollback table; past the watchdog deadline, rolls back |
| After verification, before cutover (`verified`) | handoff `verified` | cuts over, releases |
| After cutover, before release (`recorded`) | handoff `recorded` | releases |
| A rollback in flight (`rollback`) | handoff `rollback` | swaps the previous release back if needed, restarts and verifies it, releases |
| Waiting for a decision (`recovery`) | `recovery.json`, barrier held | nothing: it waits (`update status` shows the decision) |
| `current` is neither release | | enters recovery (`RELEASE_UNEXPECTED`) rather than guess |
| A worker leaves inside the settle window (`pending`, verification running) | handoff `pending` (`settleUntil` set), barrier held | the verification fails with `EXITED_AFTER_READY`; the rollback table decides (rollback, or `recovery` for a schema-changing release). If the manager itself dies in the window the handoff is still `pending`, so the next start verifies again (a second attempt), and if that fails a schema-changing update is treated as "database in use" and goes to `recovery` rather than a rollback |
| A worker leaves after the window closed and the barrier was released | `last-apply.json` says `applied` | **nothing from the update**: an ordinary crash the supervisor restarts (and, after five in five minutes, declares `CRASH_LOOP`); not the update's business |

The barrier is **held across** every one of these: a restart never lifts it
by itself (`documentation/maintenance_barrier.md`).

## Schema compatibility

Whether an automatic rollback is safe depends on whether the new release
could have changed the database.

**The fingerprint** is the SHA-256 of the release's `db/schema.sql` (line
endings normalised) and its ordered `COLUMN_MIGRATIONS` (from
`db/migrations.js`, read as text and evaluated in an empty context; the
payload's code is never loaded into the manager). It is computed at stage
time from the staged files and is read from the installed release for the
comparison. Two releases with the same fingerprint have the same schema. A
fingerprint that cannot be read counts as **schema-changing**: the safe
answer. An update is *schema-changing* when the two fingerprints differ.

The application applies its schema when it opens the database, so a
schema-changing release can alter the database on its first start. After
that, the previous release is no longer guaranteed to read it. The manager
never drops a column and never silently discards writes to make a downgrade
fit, so:

| Update | Failed before any worker got past `/health` | Failed after a worker got past `/health`, up to the end of the settle window (the database was in use) | Failed after the window closed |
|---|---|---|---|
| **Not** schema-changing | automatic rollback (`EXITED_BEFORE_READY`, `HEALTH_TIMEOUT`, ...) | automatic rollback (`EXITED_AFTER_READY`, `ACK_TIMEOUT`, ...) | not the update's: an ordinary crash |
| Schema-changing | automatic rollback (no process opened the database with the new schema) | **`recovery`**: the previous release is *not* put back automatically; the barrier is held and the operator decides | not the update's: an ordinary crash |

An automatic rollback puts the previous release back (`current` swapped back
atomically), restarts the workers on it, verifies it exactly as above,
releases the barrier and records `rolled_back` with the cause. It restores
the **code**; the backup is not restored, because nothing the new release did
to the database could be unsafe for the previous one in these rows. If the
previous release does not verify either, the update is in `recovery`
(`ROLLBACK_VERIFY_FAILED`).

A second failure of a retried schema-changing update (more than one attempt)
is treated as "in use" too.

## Recovery

When an update lands in `recovery`, the barrier stays held, the application
stays fenced, and `update status` (CLI, `GET /manager/api/update/status`, the
Host card in the portal) shows what happened, the backup that was taken
before the update, and the two decisions:

- **`restore`**: put the previous release back, restore the data from the
  backup taken before the update (a safety backup of the data *as it is now*
  is taken first, because every write since the backup is lost), restart on
  the previous release, verify, release. The warning is shown first and the
  command line asks for `--yes`.
- **`retry`**: try the new release again (restart and verify it). Used when
  the failure was transient (a port, a slow disk).

```bash
goobster-manager update status
goobster-manager update recovery --decision restore --yes
goobster-manager update recovery --decision retry
```

The decision is made on this machine (the command line) or with a recovery
credential; the portal shows the state but cannot decide. A decision that
does not verify leaves the update in `recovery` (`UPDATE_RECOVERY_REQUIRED`)
and the barrier held; it can be decided again. Everything written during
recovery is on the work ledger and the operator audit, without a path or a
secret.

## One updater

An installation has one updater. When the manager owns the installation
(`updater.kind === 'manager'`) it is the manager; an installation adopted from
the old Raspberry Pi layout may still have the `auto-update.sh` timer. The
two must not both act:

- At adoption, the existing `updater.disable` step turns the timer off and
  marks the installation as manager-updated. The wizard and the adopt command
  ask once whether to take over (`mode` in the same question).
- `auto-update.sh` carries a guard: while a manager owns the installation
  (the `goobster-manager-guard` marker), it exits without doing anything. It
  keeps working, unchanged, for installs the manager does not own
  (`documentation/raspberry_pi_guide.md`, `documentation/continuous_deployment.md`).
- Policy `apply` is honoured only while the manager is the updater.

## What an update keeps

- **`config.json`** and **`features.json`** are never opened for writing, and
  the backup never copies `config.json`. A secret in `config.json` is
  byte-identical afterwards; so is a non-default feature set and a custom
  root layout.
- **The service registration** (systemd unit, launchd plist, Windows
  service) is re-rendered only when the rendered template changed between
  releases (a recorded template hash compared with the new one) and then
  through the same `service.register` the installer uses. A registration with
  no recorded hash is baselined and left alone. This happens **after** the
  barrier is released (outside the downtime) and is reported as `service` in
  the apply result: `unchanged`, `refreshed` or the code that stopped it.
- The previous release stays on disk (up to three) so a rollback is a
  pointer swap, not a download.

## State files

Under `<store>/update/` (owner-only, atomic writes; versions, ids, codes and
times only, never a URL, a path or a token):

| File | Holds |
|---|---|
| `last-check.json` | when the last check ran and what it found |
| `staged.json` | the release staged and ready |
| `handoff.json` | an apply that exited the manager and is not finished (phase, versions, attempts, the end of the settle window while it runs) |
| `watchdog.json` | the release to put back and the deadline |
| `recovery.json` | the pending decision |
| `scheduled.json` | an apply waiting for its window |
| `last-apply.json` | how the last apply ended: `applied`, `rolled_back`, `recovery` or `abandoned`; downtime |

## Command line

```bash
goobster-manager update status
goobster-manager update check
goobster-manager update stage
goobster-manager update apply [--now | --window]
goobster-manager update policy [--mode off|check|download|apply] [--channel stable|prerelease]
    [--source-dir <dir> | --github <owner/repo> | --source-url <base>]
    [--window <days>/<startHour>-<endHour>/<tz> | --no-window]
goobster-manager update recovery --decision restore|retry [--yes]
```

`--window sun,sat/2-4/UTC` is the weekdays (`sun`..`sat`, or `*`), the hours
and the zone. With a manager running on this machine the command goes to it
over loopback with a recovery session minted from the store (the command runs
on the machine); the running manager's own workers do the restart and
verification. Without one it runs in the process and the next manager start
finishes any handoff. Exit codes follow the other manager commands; an
update that rolled back exits non-zero with `UPDATE_ROLLED_BACK`.

## HTTP

Under `/manager/api` (the same authentication, nonce and audit as every
mutating route):

| Route | Does |
|---|---|
| `GET /update/status` | installed release, policy (source by kind), last check, staged release, handoff, watchdog, recovery, last apply |
| `POST /update/check` | `update.check` |
| `POST /update/stage` | `update.stage` |
| `POST /update/apply` | `update.apply`, body `{ when?: "now" \| "window" }` |
| `POST /update/policy` | `update.policy`, body `{ channel?, mode?, window?, source? }` |
| `POST /update/recovery` | the decision, body `{ decision }`; local operator or recovery session only |

The portal reaches the same kinds through its Host layer
(`/api/app/admin/host/operations`, `GET /api/app/admin/host/update/status`),
audited as `host.update.apply` with versions and the outcome only (the
portal does not decide a recovery). The Host card has an Updates panel: the
installed and staged versions, the policy, check, stage and apply buttons, the
last apply and its downtime, and the recovery state.

## Error codes

| Code | Meaning |
|---|---|
| `UPDATER_NOT_MANAGER` | an apply was asked on an installation another updater owns |
| `SOURCE_UNREACHABLE` | the source did not answer |
| `INDEX_INVALID`, `INDEX_UNSIGNED`, `INDEX_BAD_SIGNATURE`, `UNTRUSTED_KEY`, `KEY_LIST_INVALID` | the index failed the production trust policy |
| `TARGET_MISMATCH`, `ABI_MISMATCH`, `VERSION_INCOMPATIBLE`, `DOWNGRADE`, `CHANNEL_MISMATCH`, `FEATURES_UNAVAILABLE` | the index offers something this installation cannot or must not take |
| `NO_UPDATE_AVAILABLE`, `NOTHING_STAGED`, `STAGE_STALE` | nothing to do, nothing staged, or the stage is for another installed release |
| `ARTIFACT_MISSING`, `ARTIFACT_DIGEST_MISMATCH`, `ARCHIVE_UNREADABLE`, `ARCHIVE_UNSAFE` | the download is not the signed artifact; deleted, nothing applied |
| `INSUFFICIENT_SPACE` | not enough disk for stage plus backup |
| `SCHEMA_FINGERPRINT_UNAVAILABLE` | the staged release carries no readable schema |
| `UPDATE_IN_PROGRESS`, `RECOVERY_PENDING` | an update or an undecided recovery already exists |
| `HANDOFF_UNAVAILABLE`, `HANDOFF_LOST` | the manager cannot be restarted by the OS to hand over; or the handoff record is gone |
| `BACKUP_UNVERIFIED`, `NO_BACKUP` | the pre-update backup is not verified (nothing changed), or recovery has no backup to restore |
| `EXITED_AFTER_READY`, `EXITED_BEFORE_READY` | the cause recorded when a worker left inside the settle window, or before it was ready |
| `UPDATE_ROLLED_BACK` | the new release did not verify; the previous one was put back |
| `UPDATE_RECOVERY_REQUIRED` | a schema-changing release failed in use; decide with `update recovery` |
| `NO_RECOVERY_PENDING`, `RESTORE_FIRST`, `PREVIOUS_UNAVAILABLE` | the decision is not applicable, needs the data restored first, or the previous release is gone |

## What this does not do

- It does not update the operating system, Node.js, PostgreSQL or any
  service the manager does not own.
- It does not roll a database back across a schema change except by
  restoring the backup in the `restore` decision, and it never says that is
  free: the writes since the backup are lost, and the warning says so.
- It does not downgrade: `DOWNGRADE` stands, whatever the policy.
- Updates through the Windows service (WinSW) and macOS launchd handoff are
  specified here and unit-tested through the injected supervisor seam; they
  were not executed on those systems for this issue.
- The legacy `auto-update.sh` timer is not removed; it stays for installs
  the manager does not own.
