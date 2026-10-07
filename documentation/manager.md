---
title: The manager (installer P2.1)
kind: reference
summary: apps/manager, the database-independent control process - its unclaimed, claimed and recovery states, the protected manager store (installation identity, operations journal, lock, one-time credentials, bridge key, pending audit), first-time setup with the expiring bootstrap credential, local recovery and explicit adoption of an existing installation, the setup engine (plan, validate, apply, status), the portal bridge assertion, loopback/LAN/TLS transport rules, the privileged-operation boundary and audit reconciliation into operator_audit.
when: Setting up, repairing or adopting an installation; changing features without the portal; reasoning about what the manager may do while the database is down.
tags: [installer, manager, setup, recovery, adoption, operations, security, audit]
---

# The manager

`apps/manager` is the control process of an installation (ADR 0013
decision 7, installer plan Phase 2 item 1, issue #323). It starts and
answers without the application database, Discord, provider keys,
`config.json` or any optional feature, so it can set up a new installation
and repair a broken one. It keeps what it must never lose - the
installation identity, the owner claim, operation progress, the recovery
credential - in its own store, outside the database a reset or a
corruption could take away.

It is not a feature: no switch turns it off, and the feature catalog does
not list it.

## Running it

```bash
node apps/manager/index.js                   # serve http://127.0.0.1:3400/manager/api/*
node apps/manager/index.js --status          # print the status document and exit
node apps/manager/index.js --mint-bootstrap  # new first-time setup credential (unclaimed only)
node apps/manager/index.js --mint-recovery   # one-time recovery credential (existing installations)
node apps/manager/index.js --help
```

| Variable | Meaning |
|---|---|
| `GOOBSTER_MANAGER_PORT` | Listen port, default `3400`. |
| `GOOBSTER_MANAGER_HOST` | Bind address, default `127.0.0.1`. Anything that is not loopback is refused unless LAN mode is on. |
| `GOOBSTER_MANAGER_LAN=1` | Explicit LAN access. Requires TLS and a LAN host name (see Transport). |
| `GOOBSTER_MANAGER_LAN_HOST` | The `host[:port]` browsers use on the LAN; the Host and Origin checks accept it. |
| `GOOBSTER_MANAGER_TLS_CERT`, `GOOBSTER_MANAGER_TLS_KEY` | PEM files; LAN mode serves HTTPS with them. |
| `GOOBSTER_MANAGER_STATE_DIR` | The manager store. Default `<dataDir>/manager`. |
| `GOOBSTER_MANAGER_RECONCILE=0` | Never open the application database to reconcile audit records. |
| `GOOBSTER_MANAGER_BRIDGE_KEY_FILE` | Read by the core API (not the manager): where the bridge key is, when the store is not at its default path. |
| `GOOBSTER_DATA_DIR`, `GOOBSTER_DB_PATH`, `GOOBSTER_DB_URL`, `GOOBSTER_CONFIG_PATH` | As for the app; the manager uses them to find (never to open at boot) the application database, `features.json` and `config.json`. |

Loading `apps/manager/index.js` starts nothing; `main()` runs only when it is
the entry script. At boot the manager loads Express, Node built-ins,
`runtimePaths` and the core bridge format module - not the database
facade, the web app, any service, the Discord gateway, a database driver or
a provider SDK (`tests/managerBoot.test.js` proves it in a child process).

## States

`GET /manager/api/status` answers in every state and never shows a
credential, a hash, the owner label, a path or a database URL.

| State | When | What works |
|---|---|---|
| `unclaimed` | No `installation.json` **and** no evidence of an existing installation (no SQLite file or `-wal`, no `GOOBSTER_DB_URL`, no `features.json`). | First-time setup: `POST /claim` with the bootstrap credential. |
| `claimed` | `installation.json` is present and valid. The application database may still be missing or unreachable: status reports `appDatabase: { reachable: false, reason }` and the manager keeps serving. | Operations through the portal bridge or a local session; local recovery. |
| `recovery` | `installation.json` is missing while an installation exists (`MANAGER_STORE_MISSING`), damaged (`MANAGER_STORE_CORRUPT`), from a newer version (`MANAGER_STORE_UNSUPPORTED`), or the store cannot be read or written (`MANAGER_STORE_UNREADABLE`). A damaged file puts the manager here even with no application database. | Local recovery only: unlock, then `adopt` or `features.set`. |

The rule the states encode: **first-time setup never opens on an existing
installation**. Losing, resetting or corrupting the application database
cannot reopen it, because the identity is not in the database; losing the
manager store next to an existing installation leads to recovery, not to
setup. Nothing is adopted, deleted, rewritten or repaired automatically.

`appDatabase` comes from a bounded probe that never opens the database:
SQLite by reading the 16-byte file header (`NOT_FOUND`, `SQLITE_EMPTY`,
`SQLITE_CORRUPT`, `SQLITE_UNREADABLE`, `SQLITE_NOT_A_FILE`), Postgres by a
TCP connect with a 1.5 s timeout (`POSTGRES_UNREACHABLE`,
`POSTGRES_URL_INVALID`; a Unix-socket URL is `NOT_PROBED`). Results are
cached for 10 s.

## The manager store

`<dataDir>/manager/` (or `GOOBSTER_MANAGER_STATE_DIR`). Directories are
created `0700` and files `0600` on POSIX; every file is replaced atomically
(temp file, fsync, rename, directory fsync). Each file carries a `version`;
an unknown version or an unreadable file is reported, never rewritten.

| Path | Contents |
|---|---|
| `installation.json` | `{ version: 1, installationId, createdAt, claimedAt, ownerPrincipalId, ownerLabel, revision, origin: 'claim' \| 'adopt' }`. Written once, with `wx`, at claim or adoption. |
| `bootstrap.json` | The pending first-time setup credential as a SHA-256 hash with `expiresAt`. |
| `bootstrap-credential` | Its plaintext, for the local operator to read. Removed when the credential is used. |
| `recovery.json`, `recovery-credential` | The same pair for a recovery credential. |
| `bridge-key` | `{ version, installationId, keyId, key, createdAt }`: the HMAC key for portal assertions. |
| `lock` | The single-owner mutation lock: `{ version, pid, operationId, token, acquiredAt, expiresAt }`. |
| `operations/<id>.json` | One journal record per operation (below). |
| `operations/audit.jsonl` | Pending audit records, one JSON line each, stamped `reconciledAt` once copied into `operator_audit`. |
| `installation.json.unreadable-<time>` | A damaged file an explicit adoption set aside. Kept for the operator. |

Nothing in the store except the two `*-credential` files and `bridge-key`
holds a secret, and those are owner-only. Journal records, audit lines and
status never contain a credential, a token, a key value, a label or a
setting's value (`tests/managerEngine.test.js` plants a secret in the
environment, `config.json`, every credential and every token, then searches
every store file and response).

## First-time setup

1. On a start in the `unclaimed` state the manager mints a bootstrap
   credential: 32 random bytes, base64url, valid **15 minutes**, replacing any
   earlier one. It writes the plaintext to `bootstrap-credential` (`0600`)
   and prints it on stdout when stdout is a terminal; under a service manager
   it prints the file path instead, so the credential does not land in a
   system journal. It is never logged again.
2. The operator sends it once:

   ```bash
   curl -s -X POST http://127.0.0.1:3400/manager/api/claim \
     -H 'content-type: application/json' \
     -d "{\"credential\":\"$(cat data/manager/bootstrap-credential)\",\"label\":\"Rob\"}"
   ```

   The credential is consumed atomically (a second use is
   `401 BOOTSTRAP_INVALID`), `installation.json` is created with a new
   `installationId`, the bridge key is generated, and the answer carries a
   15-minute **setup session** for the first operations.
3. An expired credential is `401 BOOTSTRAP_EXPIRED`. A new one is minted
   only by restarting the manager or running `--mint-bootstrap` (refused
   unless the installation is unclaimed). Ten failed attempts in a minute are
   `429 TOO_MANY_ATTEMPTS`.

## Local recovery

For the operator at the machine when the portal is gone, the owner is
locked out, the store is damaged or a feature keeps the app from starting:

```bash
node apps/manager/index.js --mint-recovery     # prints a one-time credential, valid 15 minutes
curl -s -X POST http://127.0.0.1:3400/manager/api/recovery/unlock \
  -H 'content-type: application/json' -d '{"credential":"<printed value>"}'
```

Being able to run the CLI as the installation's user is the local
authorisation: it writes the credential's hash to the store. Unlocking
consumes it (`401 RECOVERY_INVALID` on replay, `401 RECOVERY_EXPIRED` after
15 minutes) and returns a 15-minute **recovery session**. Recovery routes
and sessions refuse anything that is not local: the peer must be loopback,
the Host must be a loopback name, and any `X-Forwarded-*`, `Forwarded` or
`X-Real-IP` header is refused (`403 LOCAL_ONLY`), so a reverse proxy on the
same host cannot relay a remote request into recovery. With the session the
operator can run `features.set` (claimed or recovery state) and `adopt`
(recovery state).

Sessions live in the manager's memory only; a restart drops them. A
mutation with a session sends `Authorization: Bearer <token>` and a fresh
`X-Goobster-Nonce` (16-64 base64url characters) that is accepted once.

## Explicit adoption of an existing installation

An installation that predates the manager, or whose store was lost, has an
application database but no usable `installation.json`. The manager starts
in `recovery` (`MANAGER_STORE_MISSING`) and does nothing else until the
local operator asks:

```bash
# after recovery/unlock; S is the session token
curl -s -X POST http://127.0.0.1:3400/manager/api/operations \
  -H "authorization: Bearer $S" -H "x-goobster-nonce: $(openssl rand -hex 12)" \
  -H 'content-type: application/json' -d '{"kind":"adopt","input":{"label":"Rob"}}'
# then POST /operations/<id>/validate and /operations/<id>/apply with {"revision": null}
```

`adopt` creates a new `installation.json` (`origin: 'adopt'`) and bridge
key; it touches nothing in the application database. When an
`installation.json` exists but is damaged or from a newer version, the plan
is refused with `409 ADOPT_NEEDS_CONFIRMATION` until the input says
`"replaceUnreadable": true`; the old file is then renamed to
`installation.json.unreadable-<time>`, never deleted. A usable store is
`409 ALREADY_INSTALLED`.

## Operations: the setup engine

`apps/manager/engine/` is the one engine the wizard, the headless CLI and
the operator pages will share (ADR 0013 decision 8):

| Call | Effect |
|---|---|
| `plan(kind, input, auth)` | Validates `input` against the kind's allow-list and the current state, journals a `planned` record with a redacted plan and the target state's `revision`. |
| `validate(id, auth)` | Re-checks the preconditions (state, revision, dependency closure); `validated`. |
| `apply(id, { revision }, auth)` | `revision` must equal the plan's. Takes the lock, re-validates inside it, runs the steps, `applied` or `failed`, appends one audit record. |
| `status(id)`, `list()` | Journal records, newest first; an unreadable record is listed with its problem. |

A record: `{ version, id, kind, status, actor, via, plan, revision,
createdAt, updatedAt, steps: [{ name, status, at, detail? }], error? }`,
`status` one of `planned`, `validated`, `applying`, `applied`, `failed`,
`cancelled`. Only the planner can validate or apply its operation
(`403 OPERATION_NOT_OWNED`); a plan older than 15 minutes is cancelled
(`409 PLAN_EXPIRED`). An input value a plan must not show (a label, later a
key) stays in memory, so a restart between plan and apply means planning
again (`PLAN_INPUT_LOST`).

**Lock.** `<store>/lock` is created with `wx`: one mutation at a time across
processes. A second apply gets `409 OPERATION_IN_PROGRESS`. A lock whose
process is gone or whose ten-minute expiry passed is reclaimed; an
unparsable lock file is respected until it is older than that.

**Crash.** An operation left `applying` by a manager that stopped is marked
`failed` with `INTERRUPTED` on the next start (and audited as
`interrupted`). It is never re-run or rolled back automatically.

Kinds in this phase:

| Kind | Who | States | Effect |
|---|---|---|---|
| `features.set` | bridge, setup or recovery session | claimed; recovery (recovery session) | Input `{ changes: { <featureId>: true\|false }, expectedRevision? }`. Writes `data/features.json` through `featureState.write()` ([feature_state.md](feature_state.md)) as `pendingActive`: the change takes effect at the next restart. Refuses unknown ids (`UNKNOWN_FEATURE`), `core` (`CORE_IMMUTABLE`), activating a feature whose package is `installed: false` (`409 FEATURE_NOT_INSTALLED`) and unmet dependencies (`409 DEPENDENCY_CONFLICT`; a dependency is never enabled for you). A stale revision anywhere is `409 REVISION_CONFLICT`; a damaged `features.json` is `409 FEATURE_STATE_UNREADABLE` and left as it is. |
| `adopt` | recovery session | recovery | See above. |
| `claim` | bootstrap credential, `POST /claim` only | unclaimed | Creates the installation. |
| `recovery.unlock` | recovery credential, `POST /recovery/unlock` only | claimed, recovery | Issues the recovery session. |

There is no kind that runs a shell command or writes a caller-chosen path,
and the engine refuses to register a kind with a privileged operation's
name.

## HTTP API

Everything is under `/manager/api`, JSON only (`415` otherwise), bodies at
most 64 KB (`413 PAYLOAD_TOO_LARGE`). Errors are
`{ error: { code, message, details? } }` with no stack, path or value; a
failed apply also returns the `operation` record.

| Route | Authentication | States |
|---|---|---|
| `GET /status` | none | all |
| `POST /claim` | bootstrap credential | unclaimed |
| `POST /recovery/unlock` | recovery credential, local request | claimed, recovery |
| `GET /features` | assertion or session | claimed; recovery with a recovery session |
| `GET /operations`, `GET /operations/:id` | assertion or session | claimed; recovery with a recovery session |
| `POST /operations` | assertion or session | per kind |
| `POST /operations/:id/validate` | assertion or session | per kind |
| `POST /operations/:id/apply` | assertion or session | per kind |
| `POST /privileged/:name` | assertion or session | `501 NOT_IMPLEMENTED` for a declared name, `404` otherwise |

A body that names an actor (`actor`, `principalId`, `actorId`) different
from the authenticated one is refused with `403 ACTOR_MISMATCH`; the
journal's `actor` always comes from the authentication.

## The portal bridge

The portal never gives the browser a manager credential. A core route that
has passed `requireAuth` and `requireOperator` mints a per-request
assertion with `packages/core/web/managerBridge.js` and calls the manager
server-side:

```js
const { createManagerBridge } = require('@goobster/core/web/managerBridge');
const bridge = createManagerBridge();                    // reads the bridge-key file
const headers = bridge.headers({ actor: req.actor, method: 'POST', path: '/manager/api/operations' });
// fetch('http://127.0.0.1:3400/manager/api/operations', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })
```

The assertion, sent as `X-Goobster-Manager-Assertion`, is
`gma1.<base64url payload>.<base64url HMAC-SHA256>` with payload
`{ v: 1, purpose: 'manager', principalId, role: 'operator', installationId,
req: '<METHOD> <path>', iat, exp, nonce }`. It lives at most 300 seconds
(default 60). The minter refuses an actor that is not an active operator
(`403 FORBIDDEN`). The manager checks the signature with its `bridge-key`,
then purpose (`ASSERTION_PURPOSE`), installation (`ASSERTION_INSTALLATION`),
lifetime (`ASSERTION_EXPIRED`), the request binding (`ASSERTION_REQUEST`),
the role (`403 FORBIDDEN`) and the nonce, which it accepts once
(`ASSERTION_REPLAYED`). The core API finds the key at
`GOOBSTER_MANAGER_BRIDGE_KEY_FILE`, `GOOBSTER_MANAGER_STATE_DIR/bridge-key`
or `<dataDir>/manager/bridge-key`; a missing key is
`503 MANAGER_BRIDGE_UNAVAILABLE`, never an open door. Adoption rotates the
key. The bridge works only in the `claimed` state.

**Stronger authentication (#255).** The manager does not implement or
emulate #255's separate enrollment. `bridge.requireStrongAuth()` answers
`false` and `status.auth.strongAuthRequired` reports it; when #255 lands,
the portal adds a claim to the assertion only after the stronger factor and
the manager refuses mutations without it when `requireStrongAuth()` is
true.

## Transport

- **Loopback by default.** A non-loopback `GOOBSTER_MANAGER_HOST` without
  LAN mode refuses to start (`NON_LOOPBACK_REFUSED`). On a headless host,
  keep the default and tunnel: `ssh -L 3400:127.0.0.1:3400 <host>`, then open
  `http://127.0.0.1:3400/manager/api/status` locally.
- **LAN access is explicit and encrypted.** `GOOBSTER_MANAGER_LAN=1`
  requires `GOOBSTER_MANAGER_TLS_CERT` and `GOOBSTER_MANAGER_TLS_KEY` (the
  manager then serves HTTPS only) and `GOOBSTER_MANAGER_LAN_HOST`; without
  them it refuses to start (`LAN_REQUIRES_TLS`, `LAN_REQUIRES_HOST`). It
  never serves a non-loopback address over plain HTTP. Local sessions and
  recovery still work only from the machine itself; LAN clients use the
  portal bridge (or claim with the bootstrap credential).
- **Host and Origin.** Every request's Host must name the manager (a
  loopback name with the listening port, or the LAN host), which also
  defeats DNS rebinding (`421 BAD_HOST`). A mutation with an `Origin` must
  come from the manager's own origin, and a browser's
  `Sec-Fetch-Site: cross-site` is refused (`403 BAD_ORIGIN`).
- **Replay.** Every mutation carries a single-use secret: the bootstrap or
  recovery credential, the assertion nonce, or the session nonce.
- Responses are `Cache-Control: no-store`, `nosniff`, `X-Frame-Options:
  DENY` and a `default-src 'none'` CSP.

## Privilege boundary

The manager runs as the installation's ordinary user, like the bot and the
API. `apps/manager/privileged.js` is the closed list of operations that will
need more - `service.register`, `service.unregister`, `package.install` -
declared and validated there and nowhere else. In this phase
`POST /privileged/:name` answers `501 NOT_IMPLEMENTED` for those names and
`404` for anything else, operation kinds cannot take those names, and no
route runs a shell command. The bootstrappers (installer Phase 3) implement
them behind a narrowly scoped helper.

Between the manager and the app the split is: the manager owns the
installation identity, the owner claim, operation progress, recovery and
(later) the lifecycle; the app owns accounts, sessions, data and the
`operator_audit` table. The manager reaches core through `@goobster/core`;
core never imports the manager.

## Audit while the database is down

Every applied, failed or interrupted operation appends
`{ action: 'manager.<kind>', actor, operationId, outcome, via, at }` to
`operations/audit.jsonl` - no values, labels or credentials. `actor` is the
operator's principal id for the bridge and `local:setup` / `local:recovery`
for a local session (`null` for the credential routes).

`reconcileAudit()` (`apps/manager/audit.js`) copies pending lines into
`operator_audit` through `operatorAuditService.record()`, with
`target = operationId` and detail `{ source: 'manager', outcome, via, at }`:

- it runs only when the probe says the database exists and is reachable,
  so it never creates one;
- it is idempotent on the operation id: an existing row for the same action
  and target is never inserted twice, even if the `reconciledAt` stamps
  were lost;
- a failure leaves the lines pending for the next pass; the manager closes
  the connection after each pass.

The manager tries at boot, after every audited operation and once a minute
(a pass with nothing pending does nothing; `GOOBSTER_MANAGER_RECONCILE=0`
turns this off).
`status.audit.pending` counts what is waiting. Erasure (`privacyService`)
reaches the reconciled rows like any other `operator_audit` row.

## Seams for later work

Extensions register in `apps/manager/extensions.js`: a route family is one
module under `apps/manager/routes/` exporting `(api, helpers) => void`
(the helpers are the server's `route`, `authenticate`, `readAuth`,
`checkActor`, `throttle`, `noteFailure` and transport `guards`); an
operation-kind family is one module under `apps/manager/engine/kinds/`
exporting `({ settings, fs, now, logger }) => OperationKind[]`. A kind name
registered twice is a startup error, and the privileged names stay refused.

- **#324 (config, providers, defaults):** new kinds in `apps/manager/engine/kinds/`
  following `features.set`; secret values go in the kind's `privateInput`,
  never the plan (the journal scrubs any value under a key-shaped name to
  `"sk-…[redacted]"` as a backstop). A fresh-install preset
  (`featureState.freshPreset()`) is a defaults decision for #324; today the
  first `features.set` builds on the legacy seed.
- **#325 (supervisor, restart):** promoting `pendingActive` to `active` at
  restart, the restart operation itself, and `GOOBSTER_MANAGER_ALLOWED_HOSTS`
  style Host entries for container deployments.
- **#326 (operator pages):** call the manager from portal routes with
  `managerBridge.headers()` after `requireOperator`; the browser only talks
  to the core API.
- **#255 (stronger auth):** `bridge.requireStrongAuth()`.

## Tests

`tests/managerBoot.test.js` (boot matrix, module isolation, transport, CLI),
`tests/managerAuth.test.js` (credentials, recovery, Host/Origin, actors,
nonces, lock, bodies, privileged boundary), `tests/managerEngine.test.js`
(features.set, durability, secrets, adoption, reconciliation on SQLite and
Postgres) and `tests/managerBridge.test.js` (assertions). All run in the
`core` CI group.
