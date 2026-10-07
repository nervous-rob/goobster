---
title: Manager lifecycle - supervision and staged restarts (installer P2.3)
kind: reference
summary: How the installation manager runs the workers of every layout (lite, standalone, paired) through the child or external adapter, restarts them (exit code 75, backoff, CRASH_LOOP), and applies a feature or configuration change with a staged restart behind a 60-second countdown that promotes the change only after every worker acknowledged the new revision; the worker contract (stop new work, drain bound, revision acks), the L1 table of long-running work and its restart contracts, per-target slash-command deploy hashes, the lifecycle API and the systemd, PM2 and Docker units.
when: Running Goobster under systemd, PM2 or Docker; changing features and restarting safely; reasoning about what a restart does to an expedition, a sandbox run or a voice session; debugging a worker that will not come back or a restart that rolled back.
tags: [installer, manager, supervisor, restart, lifecycle, systemd, pm2, docker, deployment, commands]
---

# Manager lifecycle

The installation manager ([manager.md](manager.md)) owns the lifecycle of
the application workers in every deployment layout (installer plan Phase
2 item 2-3, issue #325). It does it through **adapters**, not by becoming a
process manager: under systemd or PM2 the manager is the unit the OS
restarts, and the workers are its children. Two supervisors are never
stacked on one process.

A feature or configuration change becomes real through one **apply
flow**: validate, stage, persist the pending change in the manager store,
announce a countdown (60 s by default, "restart now", cancel), stop new
work, let in-flight work reach its declared contract, restart the
workers, verify health and the **revision acknowledgement** from every
worker, then promote. Until the last step the previous revision is what
runs; nothing is promoted on hope.

## Running it

```bash
node apps/manager/index.js --supervise           # serve the manager API and run the layout's workers
GOOBSTER_MANAGER_SUPERVISE=1 node apps/manager/index.js   # the same
```

Without `--supervise` the manager behaves exactly as described in
[manager.md](manager.md): it supervises nothing, and `lifecycle.apply`
answers `409 NOT_SUPERVISING`. The supervision modules load only when
supervising, so the plain boot path stays free of them
(`tests/managerBoot.test.js`). On an **unclaimed** installation the
workers start only once first-time setup claimed it: a worker would create
the application database, and a manager that sees one is no longer
unclaimed ([manager.md](manager.md) § States), so the bootstrap credential
would stop working.

| Variable | Meaning |
|---|---|
| `GOOBSTER_MANAGER_SUPERVISE=1` | Same as `--supervise`. |
| `GOOBSTER_MANAGER_WORKERS` | `child` (default): the manager spawns the workers. `external`: an OS unit runs each worker (Docker); the manager only asks and verifies. |
| `GOOBSTER_RUNTIME_MODE` | `lite`, `standalone` or `paired`; unset, the layout follows the Discord adapter switch. |
| `GOOBSTER_SUPERVISOR` | Set by the unit files: `systemd`, `pm2`, `docker`; the manager sets `manager` for its children. |
| `GOOBSTER_LIFECYCLE_DRAIN_SECONDS` | How long a worker's shutdown waits for in-flight work (default 45, the longest contract bound). |

The manager listens on `127.0.0.1:3400` only. On a headless machine reach
it with an SSH tunnel and use the API from your own computer:

```bash
ssh -L 3400:127.0.0.1:3400 pi@<host>
curl -s http://127.0.0.1:3400/manager/api/lifecycle -H "authorization: Bearer $S"
```

`GET /manager/api/status` gains `lifecycle: { supervising, layout,
workers: [{ name, state, ackedRevision }] }` (worker names, never argv or
environment); without `--supervise` it is `{ supervising: false, layout:
null, workers: [] }`.

## Layouts

`apps/manager/lifecycle/layouts.js` resolves the layout from the same
rule `apps/api` uses: `GOOBSTER_RUNTIME_MODE` when set, otherwise a
Discord adapter (`GOOBSTER_DISCORD_ENABLED`, `config.json` `discord.enabled`,
else a bot token) means `lite` and none means `standalone`.
`tests/lifecycleAdapters.test.js` pins the switch against core
`discordConfig.enabled` and the api mode against `apps/api`'s
`resolveRuntimeMode()`.

| Layout | Workers | Refused when |
|---|---|---|
| `lite` | `bot` (`apps/bot/index.js`, after `deploy-commands.js`; serves the portal in-process) | no bot token (`DISCORD_TOKEN_MISSING`) |
| `standalone` | `api` (`apps/api/index.js`, `GOOBSTER_RUNTIME_MODE=standalone`) | `webapp.enabled` is not true (`WEBAPP_DISABLED`) |
| `paired` | `bot` + `api` (`paired` mode), plus `sandbox` (`apps/sandbox/index.js`) when the `sandbox` feature is active and its runner is local (no `GOOBSTER_SANDBOX_URL`, or a loopback one) | no `GOOBSTER_DB_URL` (`PAIRED_REQUIRES_POSTGRES`) or no `GOOBSTER_INTERNAL_TOKEN` (`PAIRED_REQUIRES_INTERNAL_TOKEN`) |

Each worker record is `{ name, script, args, env, healthUrl, ackFile,
stopSignal: 'SIGTERM', stopTimeoutMs, restartBackoff }`; the bot also has
`preStart: deploy-commands.js` (bounded at 75 s; a failure is logged and
the bot starts anyway). Health is `GET /health` on the bot (`PORT`, 3000),
the api (`GOOBSTER_API_PORT`, 3100) and the sandbox runner (3200). When the
manager runs on 3400 and the bot's control panel would default to the same
port, the bot gets `GOOBSTER_PANEL_PORT=3401`.

A refused layout is reported in `GET /lifecycle` as `layoutError` and no
worker starts; the manager keeps serving.

## Adapters

**Child** (`adapters/child.js`, the default). Spawns `node <script>` with
`stdio: ['ignore', 'inherit', 'inherit']`, so a worker's logger writes
where it always did (journald, PM2, a terminal). On POSIX each worker
leads its own **process group** (`detached: true`), so ffmpeg, yt-dlp or a
sandbox child die with it. A stop sends the worker's `stopSignal` to the
leader (its shutdown runs the work contracts and stops its own children),
then `SIGKILL` to the whole group after `stopTimeoutMs` (drain + 15 s = 60
s by default), and a last `SIGKILL` sweep of the group after the leader
exited. Every spawned process is waited for. On Windows there are no POSIX
signals: the graceful request goes through the worker's control file, then
`taskkill /T /F` after the bound.

**External** (`adapters/external.js`, `GOOBSTER_MANAGER_WORKERS=external`).
An OS unit runs each worker directly and restarts it when it exits, so the
manager does not spawn, signal or stop anything (`supervised: false`).
Requests travel through `<store>/control/<worker>.json`: `stop-new-work`,
then `restart` with `boot = { revision, staged }`; the worker drains,
exits 75, its unit starts it again, and the new process reads `boot` and
acknowledges that revision. The supervisor still verifies health and an
acknowledgement newer than the request.

**Never nest.** The child adapter refuses a worker marked external
(`NESTED_SUPERVISOR_REFUSED`), and before every spawn the supervisor
probes the worker's health URL: if something already answers (a legacy
unit still running the bot directly), the slot goes to `conflict`
(`WORKER_ALREADY_RUNNING`) and nothing is started; it retries every 5 s.

## Supervision

Per worker the supervisor keeps a slot: `starting` (spawned, waiting for
`/health`), `running`, `backoff`, `crash-loop`, `conflict`, `stopping`,
`stopped`, `external`.

- **Requested restart.** A worker that was healthy and exits with code
  **75** (`EX_TEMPFAIL`) is restarted at once at the current revision and
  not counted as a crash.
- **Crash.** Any other unexpected exit (or a spawn error, or exit before
  `/health` answered) restarts after a backoff of 1, 2, 5, 10, then 30 s;
  60 s of health resets the step. Five crashes inside five minutes put the
  worker in `CRASH_LOOP`: it is not restarted until an operator
  `POST /lifecycle/restart`.
- **Health.** A start that does not answer `/health` within 60 s is
  stopped and counted as a crash (`HEALTH_TIMEOUT`). Probes are bounded
  HTTP GETs on loopback.
- **Manager stop.** SIGTERM or SIGINT to the manager stops every worker
  (bounded as above) and the manager exits only after each child is reaped
  or its bound passed (`forced-stop` is recorded).

All durable state is in `<store>/lifecycle.json`, written atomically:

| Field | Content |
|---|---|
| `current` | The revision every required worker acknowledged last. |
| `pending` | The scheduled change: `{ revision, operationId, changeRef, changeKind, selection, actor, via, announcedAt, deadline, graceSeconds, onExpired, phase: 'countdown'\|'committing', committedAt?, restartOperationId? }`, or null. |
| `lastOutcome` | `{ revision, outcome: 'applied'\|'failed'\|'rolled_back'\|'cancelled', code, at, restartOperationId?, worker?, configRecovery?, previousRevisionReady? }`. |
| `workers` | Per worker: `{ lastExit, crashes, crashLoop, backoffMs, ackedRevision, restarts }`. |
| `events` | The last 50 `{ at, type, revision?, worker?, code? }`. |

Names, revisions, codes and times only: never a path, an argument, an
environment value or a token. A `lifecycle.json` that cannot be read is
left alone; the workers run at revision 0 and staged restarts are refused
(`LIFECYCLE_STATE_UNREADABLE`) until it is fixed or removed.

## The worker contract

The worker side lives in `packages/core/runtime/lifecycle.js` and
`revisionAck.js`; `apps/bot`, `apps/api` and `apps/sandbox` call them, and
the manager reads the same constants and file formats.

| Signal | Meaning |
|---|---|
| exit code `75` | "Restart me." `lifecycle.requestRestart(reason)` runs the normal bounded shutdown and exits 75. Refused when nothing supervises the process. Under systemd (`Restart=on-failure`), PM2 and Docker (`unless-stopped`) 75 also restarts a worker run directly. |
| `SIGUSR2` (POSIX child of the manager) | Stop new work: the restart is committed. The worker answers feature commands with the restarting notice and its schedulers stop opening new passes. |
| `<store>/control/<worker>.json` | The same requests for workers the manager did not spawn (systemd, PM2, Docker units) and for children on Windows: `{ version, worker, boot: { revision, staged }, request: { id, type: 'stop-new-work'\|'restart', revision, drainSeconds, at } }`. Polled every second; a request older than the process start is ignored. |
| `SIGTERM` / `SIGINT` | Normal shutdown: stop new work (not announced), drain within the bound, exit 0. |
| manager gone | A child whose manager process disappeared shuts itself down rather than run unsupervised. |

**Revision acknowledgement.** Every start carries `GOOBSTER_REVISION=<n>`
(and `GOOBSTER_FEATURES_STAGED=1` when it should run a staged feature
document). Once ready - the bot on `ClientReady`, the api and the sandbox
runner once listening - the worker writes `<store>/ack/<worker>.json` =
`{ version, worker, revision, pid, at }` atomically, and, when the manager
gave it `GOOBSTER_MANAGER_URL`, also posts `{ worker, revision, pid }` to
`POST /manager/api/lifecycle/ack` with its per-start token in
`x-goobster-ack-token`. The supervisor accepts a file ack only from the pid
it started (or, for an external worker, newer than its request), and a
POST only with the matching pid and token. In LAN mode the manager does
not hand out a URL and the file is the only path.

**Stop new work** is not the operator *paused* flag
(`instanceStateService`, ADR 0013 decision 11). Pausing is a durable
operator decision every process shares; stopping new work is one process
getting ready to exit, and nothing durable changes. `coreRuntime`'s
`pauseNewWork()` stops the schedulers and step passes (a step that would
start reports `skipped: restarting`), `settleInFlight(ms)` waits for what
is running, and `sandboxService.pauseNewWork()` refuses new runs.

**Staged features.** A start at revision `n` with
`GOOBSTER_FEATURES_STAGED=1` reads `<store>/lifecycle/staged-features.json`
tagged with revision `n` and adopts it instead of `data/features.json`
through `features.configure({ filePath })`, which works only before the
first read (`lifecycle.boot()` is the first line of each worker; a later
call is refused with `ALREADY_RESOLVED`). A missing or mismatched document,
or a refused configure, falls back to `data/features.json` - and such a
start **acknowledges nothing** (`STAGED_NOT_ADOPTED` in its log), so the
supervisor's ack timeout rolls the change back rather than promoting a
revision no worker runs.

## The apply flow

Plan it like any operation (`POST /manager/api/operations`, then
`validate` and `apply`; [manager.md](manager.md) § Operations):

```json
{ "kind": "lifecycle.apply", "input": { "changeRef": "<operation id>", "graceSeconds": 60, "onExpired": "apply" } }
```

- `changeRef` is the operation id of an **applied** `features.set` that
  left a pending change (`features.json` `pendingActive` differing from
  `active`), or of a `config.set` (#324) whose record says
  `restartRequired: true`.
- `graceSeconds` is 10-600, default 60. `onExpired` (`apply` or `cancel`,
  default `apply`) decides what happens when a manager that was down
  comes back after the deadline.
- Refusals: `404 CHANGE_NOT_FOUND`, `409 CHANGE_NOT_APPLIED`,
  `409 NOTHING_PENDING`, `409 NO_RESTART_REQUIRED`,
  `409 FEATURE_NOT_INSTALLED` (activating a feature whose package is not
  installed), `409 FEATURE_STATE_UNREADABLE`, `409 RESTART_PENDING` (one
  at a time), `409 REVISION_CONFLICT`, `409 NOT_SUPERVISING`,
  `409 LIFECYCLE_STATE_UNREADABLE`.

The apply steps are `check-change`, `stage` (`stagePayload(selection)` -
a no-op until selective packaging, #328 - then the staged feature document
for revision `n+1`) and `announce` (`pending` in `lifecycle.json`, an
`announced` event, and an Inbox notice). Then it **returns**: the
countdown runs in the supervisor.

| Phase | Entered by | Durable | What runs |
|---|---|---|---|
| idle | - | `current = n`, `pending = null` | revision `n` |
| `countdown` | `lifecycle.apply` (operator) | `pending { revision: n+1, deadline, phase: 'countdown' }`, the staged document | revision `n`; a crash restarts the worker at `n`, unstaged |
| cancelled | `POST /lifecycle/cancel` (operator), or `onExpired: 'cancel'` after a manager outage past the deadline | `pending = null`, `lastOutcome.outcome = 'cancelled'` (`CANCELLED` / `DEADLINE_PASSED`) | revision `n`; `features.json` keeps `pendingActive` |
| `committing` | the deadline, or `POST /lifecycle/restart-now` (supervisor, holding the manager lock) | `phase: 'committing'`, `committedAt`, a `lifecycle.restart` journal record | stop new work everywhere, drain, stop, start every worker at `n+1` staged, wait for health and ack from all |
| promoted | the supervisor, after every worker acked `n+1` | `features.json` `pendingActive` moved into `active` (through `featureState.write()` and its revision rule), then `current = n+1`, `pending = null`, `lastOutcome.outcome = 'applied'` | revision `n+1` |
| rolled back | the supervisor, on any failure after the workers were touched | `pending = null`, `lastOutcome.outcome = 'rolled_back'` with the code (and `worker`, `configRecovery`, `previousRevisionReady`) | every worker restarted at `n`, unstaged; `features.json` untouched so the operator still sees `pendingActive` |
| failed | the supervisor, on a failure before any worker was touched (staging, the lock held for 30 s) | `lastOutcome.outcome = 'failed'` | revision `n` |

A manager that stops mid-countdown keeps `pending` on disk; the next
manager restores it and honours the deadline (or applies or cancels an
expired one per `onExpired`). A manager that stops while `committing`
resumes the commit on its next start instead of starting the old revision.
A crash during the countdown never promotes anything: the worker comes
back at the previous revision.

**Failure codes** in `lastOutcome.code`: `HEALTH_TIMEOUT`, `ACK_TIMEOUT`
(no acknowledgement of `n+1` within 120 s of the start),
`EXITED_BEFORE_READY`, `WORKER_ALREADY_RUNNING`, `STAGE_FAILED`,
`PROMOTE_FAILED`, `OPERATION_IN_PROGRESS`, `INTERRUPTED` (the manager
stopped mid-commit), the layout codes above.

**Configuration rollback.** For a `config.set` change only, the rollback
restores the previous `config.json` from
`<store>/operations/<changeRef>.previous-config.json` when the config kind
saved it there (`configRecovery: 'RESTORED'`; `'RESTORE_FAILED'` when the
write failed). Without that file it reports `NO_PREVIOUS_CONFIG` and
leaves `config.json` alone. The database is never touched by a rollback.

**Paired.** One revision for the whole installation: the change is
promoted only when the bot **and** the api (and the sandbox runner, when
it is part of the layout) acknowledged `n+1`.

### The countdown, and what "60 seconds" does not promise

The grace period is notice, not a guarantee of completion. During the
countdown everything keeps working at revision `n` and the operator can
cancel. At the deadline the restart is **committed** (`ALREADY_COMMITTED`
for a cancel from then on): every worker stops new work, then in-flight
work gets its contract's bound (the longest is 45 s), then 15 s to exit,
then `SIGKILL`. So:

- the restart begins at the deadline, but the workers are back some
  seconds to a couple of minutes later (drain, exit, deploy-commands for
  the bot, startup, ack);
- work still running when its bound passes is checkpointed, cancelled or
  cut, per the table below - it is not finished;
- the bot's "restarting" notice appears only while it drains (after the
  deadline), not during the countdown;
- a crash during the countdown restarts the worker at the old revision
  and does not move the deadline.

## L1: long-running work and its restart contract

What a SIGTERM did to each kind of work before #325, where its durable
state lives, and the declared contract (`packages/core/runtime/lifecycle.js`
`CONTRACTS`). `checkpoint`: finish the current unit, record where it
stopped, resume after the restart. `cancel`: stop now, record
`INTERRUPTED`, never replay. `drain`: let the in-flight unit finish inside
the bound; nothing new starts. `none`: nothing in flight survives a
process; durable rows carry the state. A bound never exceeds the drain
window (`GOOBSTER_LIFECYCLE_DRAIN_SECONDS`, default 45 s).

| Work | SIGTERM before #325 | Durable state | Contract (bound) | Implementation |
|---|---|---|---|---|
| Spitball expeditions (`spitballExpeditionRunner`) | Process exit cut the live cycle; the next start's `reapOrphans()` parked the expedition `PAUSED` and the cycle `CANCELLED` once its lease went stale, so research waited for the owner and the cut cycle's spend was lost. | `spitball_expeditions` (status, `runnerId`, `lastHeartbeatAt`, `stopReason`), `spitball_expedition_cycles` | `checkpoint` (45 s) | `requestCheckpoint()`: the loop finishes the current cycle and stops at its cooperative stop point; `_checkpointForRestart()` re-queues the row (`status = 'QUEUED'`, `runnerId = NULL`, `stopReason = 'RESTART_CHECKPOINT'`) and the next process's `start()` picks it up without repeating a recorded cycle. Past the bound `interruptLive()` parks it `PAUSED` and notes `INTERRUPTED`. Wired through `coreRuntime` (`settleInFlight`). |
| Sandbox runs (`sandboxService.run`) | The run leads its own process group (`detached: true`), so unless the service manager killed the whole cgroup it outlived the bot until its `timeout` wrapper fired; the caller got no answer; the admission lease expired after `timeoutMs + 30 s`. | none for the output; `resourceAdmissionService` leases; `work_failures` | `cancel` (35 s) | `pauseNewWork()` refuses new runs with `RESTARTING`; running ones keep their existing timeout (`drainRuns()`); past the bound `interruptRunning()` aborts them (group `SIGKILL`) and notes `INTERRUPTED` with phase `shutdown` (no output in the ledger). Never replayed. The runner process (`apps/sandbox/server.js`) answers `503 RESTARTING` / `503 INTERRUPTED` the same way. |
| Voice sessions (`voiceSessionService`) | The connection dropped with the process; nothing told the channel; nothing durable. | none (in memory) | `cancel` (5 s) | `endAllSessions({ gateway })` posts a short notice to the session's text channel through the gateway seam, stops the session and notes `INTERRUPTED` (kind `chat`, work id `voice:<guildId>`). No replay. |
| Music playback (`voice/musicService.js`) | `dispose()` in the bot's shutdown stopped the player; the in-memory queue was lost. | playlists in the database; the queue is in memory | `cancel` (5 s) | Unchanged: `dispose()` in the bot's shutdown after the drain; ffmpeg and yt-dlp die with the worker's process group. |
| GBA sessions (`gbaRunService`) | The harness WebSocket dropped with the process (`handleConnection`'s cleanup marks the live embed paused when a close is seen); the harness reconnects. | `gba_run_clients` (pairing, status message) | `none` (0 s) | Nothing to wait for: the harness reconnects to the next process. |
| Observatory / project runs (`projectService`) | The segment loop was cut; the lease stopped heartbeating. | `observatory_jobs` (lease `runnerId`/`lastHeartbeatAt`/`leaseToken`, checkpoint convention) | `checkpoint` (0 s in process) | Unchanged and already restart-safe: the next start's `_ensureReaped()` parks a stale lease `INTERRUPTED`, and `autoResumeInterrupted()` resumes jobs that left a checkpoint (after the lease's stale cutoff). |
| Mission steps (`projectMissionService`) | Nothing in process; a step links a job or expedition. | `project_missions`, `project_mission_steps` | `none` (0 s) | Unchanged: `reconcileStartingSteps()` and `reconcileRunningSteps()` repair steps at startup (a `coreRuntime` step) and on the personal heartbeat. |
| Pending integration actions (`integrationActionService.handleButton`) | A confirmed action mid-`_execute` was cut; the claim stayed `EXECUTING`, and a stored receipt let `finishStoredReceipt()` recover it. | `pending_integration_actions` (claim, receipt) | `drain` (15 s) | The bot tracks every interaction handler (commands and buttons) and its shutdown waits for them inside the bound before it exits. |
| Attention sweeps (`personalHeartbeatService` → `attentionService.sweepUser`) | A sweep in progress was cut mid-user; the next tick re-evaluated. | `attention_policies`, `attention_items`, `attention_notices`, `attention_state` | `drain` (15 s) | `personal.stop()` on stop-new-work; the runtime waits while `ticking`. |
| Scheduled `coreRuntime` steps (automations, follow-ups, consolidation, reflection, ledger retention, heartbeat, tracker, monologue, risk engine) | Timers kept firing until `coreRuntime.stop()`; a pass in progress was cut by `process.exit`. | each service's own rows | `drain` (15 s) | `pauseNewWork()` stops the schedulers; `settleInFlight()` polls the in-flight flags (`ticking`, `running`) and the reflection's stop promise, each inside its own bound. |

## Slash-command deployment

`apps/bot/deploy-commands.js` (the bot's `preStart` under the manager,
`npm start` and `npm run deploy-commands` otherwise) deploys per **target**
and only when that target's hash changed:

- targets are `guild:<clientId>:<guildId>` for each configured guild and
  `global:<clientId>` for the global (DM-capable) set; each hash is
  SHA-256 over `{ scope, commands, activeFeatures }`, so a guild list, a
  payload or a feature change redeploys exactly the targets it affects;
- the acknowledged hashes are in `<dataDir>/command-deploy.json`
  (`{ version, targets: { <key>: { hash, at } } }`); a target's hash is
  written only after its PUT succeeded, so a failed deploy stores nothing
  and the next start retries it; targets of this application that are no
  longer configured are pruned;
- the global target merges with the application's existing entry point
  commands (GET, then PUT);
- `--force` redeploys every target; the legacy `.command-deploy-hash` is
  migrated once when it matches the current combined hash.

Interactions for commands that no longer exist (or whose feature is off)
are answered by the Phase 1 refusal path,
`interactionCreate.refuseUnavailableCommand`, never a second path. The
same function answers a feature command with
`Goobster is restarting in N s. Try that again in a minute.` while an
announced restart drains the bot; core commands keep working.

## API

Everything is under `/manager/api`, with the manager's rules for bodies,
errors, Host/Origin, actors and nonces ([manager.md](manager.md) § HTTP API).

| Route | Authentication | Effect |
|---|---|---|
| `POST /operations` `{ kind: 'lifecycle.apply', input }` (then `validate`, `apply`) | assertion or session, nonce | Schedules the staged restart. Audit `manager.lifecycle.apply`, outcome `applied` = the countdown was accepted. |
| `GET /lifecycle` | assertion or session | `{ supervising, mode: 'child'\|'external', layout, layoutError, stateProblem, current, pending: { …, secondsLeft }, committing, lastOutcome, acked: { <worker>: n }, workers: [{ name, state, supervised, pid, revision, staged, healthy, ackedRevision, restarts, crashes, crashLoop, backoffMs, code, lastExit }], events }`. Health is probed on request. |
| `POST /lifecycle/restart-now` | assertion or session, nonce, no body | Moves the deadline to now (`lifecycle.restart`, scope `pending`). `409 NOTHING_PENDING`, `409 ALREADY_COMMITTED`. |
| `POST /lifecycle/cancel` | assertion or session, nonce, no body | Only during the countdown (`lifecycle.cancel`); answers `{ revision }`. `409 ALREADY_COMMITTED` once the workers were told to stop new work. |
| `POST /lifecycle/restart` | assertion or session, nonce, no body | Restarts every worker at the current revision and clears `CRASH_LOOP` (`lifecycle.restart`, scope `workers`). `409 ALREADY_COMMITTED` during a commit. |
| `POST /lifecycle/ack` | loopback only, `x-goobster-ack-token`, throttled | `{ worker, revision, pid }` from a worker the manager started; `403 ACK_REFUSED` otherwise. |

**Audit** (`apps/manager/audit.js`, mirrored in `operatorAuditService.ACTIONS`):
`manager.lifecycle.apply` when the countdown was accepted;
`manager.lifecycle.restart` for each staged restart the supervisor
performs (one journal record each: `applied` = promoted, `failed` = rolled
back or failed, with the code), for restart-now and for an operator worker
restart; `manager.lifecycle.cancel` for a cancel. No record carries an
environment value, a token or a path.

The Inbox notice of a scheduled restart goes through
`inboxService.deliver()` to the operator who scheduled it, only when the
application database is there and reachable and the actor is a portal
operator; the countdown never depends on it.

## Deployment units

**systemd** (`deploy/goobster.service`): `ExecStart=… node
apps/manager/index.js --supervise`, `Environment=GOOBSTER_SUPERVISOR=systemd`,
`KillMode=mixed` (SIGTERM to the manager only, which stops its workers;
whatever is left in the cgroup is killed at the timeout),
`TimeoutStopSec=120` (45 s drain + 15 s exit, with room). `ExecStartPre`
is gone: the manager runs `deploy-commands.js` before each bot start. A
commented legacy block keeps the old "run the bot directly" lines for
installs that have not moved over. `scripts/auto-update.sh` stops and
starts the unit and probes `/health` as before; set `GOOBSTER_HEALTH_URL`
for a `standalone` install, and `GOOBSTER_SYNC_UNIT=true` (or copy the
file) to replace an installed unit from before the manager.

**PM2** (`ecosystem.config.js`): the app is the manager (`args:
'--supervise'`), `kill_timeout: 120000`, `treekill: false` (PM2 signals
the manager only), `GOOBSTER_SUPERVISOR: 'pm2'`. A commented legacy app
runs the bot directly.

**Docker** (`deploy/docker-compose.yml`): the compose services are
external workers. Docker starts and restarts them (`restart:
unless-stopped` also restarts a worker that exits 75); a manager run with
`GOOBSTER_MANAGER_WORKERS=external` against the same data volume asks for
restarts through the control files and verifies health and acks. Docker
kills 10 s after SIGTERM, so the services set
`GOOBSTER_LIFECYCLE_DRAIN_SECONDS=8`; a longer drain needs a matching
`stop_grace_period`. The sandbox container sees only the sandbox subtree,
so it has no control file and Docker's SIGTERM is its only stop request.

**Bare `node`.** `node apps/manager/index.js --supervise` in a terminal
does the same as the units; Ctrl-C stops the workers first.

## Seams for later work

- **#324 (configuration):** a `config.set` record that needs a restart
  says so with `restartRequired: true` in its plan or a step's detail;
  `lifecycle.apply` accepts it as `changeRef`. To make rollback restore
  `config.json`, save the previous bytes as
  `<store>/operations/<operationId>.previous-config.json` (a JSON object)
  before writing; without it rollback reports `NO_PREVIOUS_CONFIG`.
- **#326 (operator pages):** `GET /lifecycle` is the page's model
  (countdown with `secondsLeft`, per-worker state, crash loop, last
  outcome, recent events); restart-now, cancel and restart are the
  buttons; `GET /status` `lifecycle` is the summary. Call them through the
  bridge like the other manager routes.
- **#328 (selective packaging):** `stage.stagePayload(selection)` is
  called with `[{ id, to }]` at apply and again at commit and returns
  `{ staged: [] }`; payload staging for newly activated features plugs in
  there, and a throw fails the restart before any worker is touched.
- **#331 (OS service registration):** the units above are the shapes to
  register: the manager is the service, `--supervise`, the supervisor env
  value, a stop timeout of at least drain + 15 s + margin, and the manager
  alone receives the stop signal.
- **#334 (maintenance barrier):** build on the worker's
  `lifecycle.pauseNewWork()` / `onPauseNewWork()` and `coreRuntime`'s
  `pauseNewWork()` / `settleInFlight()` - not on the *paused* flag.

## Tests

`tests/managerSupervisor.test.js` (fake processes: exit 75, normal stop,
bounded stop, backoff and `CRASH_LOOP`, failed starts, health timeout,
manager interruption mid-countdown, a crash during a pending change,
paired acks), `tests/managerLifecycle.test.js` (the apply flow over HTTP:
countdown, restart-now, cancel and `ALREADY_COMMITTED`, promotion,
rollback, the ack route, the `config.set` seam, the Inbox notice),
`tests/lifecycleAdapters.test.js` (layout rule, worker sets,
`detectSupervisor`, the worker side, acks, staged adoption, the external
adapter, a real `node` process group on Linux, the restarting notice),
`tests/commandDeployHash.test.js` (per-target hashes, failed deploys
store nothing) and `tests/workInterruption.test.js` (expedition cycles run
once across a restart, sandbox `RESTARTING`/`INTERRUPTED`, the voice
notice, runtime drain and per-contract bounds, on SQLite and Postgres).
All run in the `core` CI group.
