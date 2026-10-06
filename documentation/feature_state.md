---
title: Feature state and the feature catalog (installer P1.2)
kind: reference
summary: The `data/features.json` file contract, the installed/configured/active/pending states, the exact precedence that decides whether a feature is available, legacy behaviour when the file is absent, environment overrides (`GOOBSTER_FEATURE_<ID>`), structured unavailable reasons, atomic writes with revisions, state-transition examples and the rule that no secret value ever appears in status.
tags: [installer, features, catalog, feature-state, configuration, operations]
---

# Feature state and the feature catalog

Phase 1 of the installer plan (`documentation/installer_plan.md`, ADR 0013
decisions 1, 2 and 5) gives every execution surface one question to ask:
"is this feature available in this process?". This document is the contract
for the answer. The ownership of each surface (which feature a command, tool,
route or table belongs to) is `documentation/feature_inventory.md`; this
document is about the state of the features themselves.

Nothing in the command loader, the runtime, the tool registry or the routes
asks this question yet. Those surfaces adopt it in #318 (commands, runtime
steps, message routing), #319 (AI tools, MCP) and #320 (HTTP, WebSocket,
Activity). Until they do, no behaviour changes.

## Modules

| Module | Role |
|---|---|
| `packages/core/features/inventory.js` | Ownership of every surface and the dependency graph (#316). The only ownership source. |
| `packages/core/features/catalog.js` | One frozen descriptor per feature id: title, summary, `dependsOn`, `freshDefault`, `legacySwitch`, `apiKeys` (env var names), `configKeys`, `systemDependencies`, `docs`, `helpUrl`. Built from the inventory plus `descriptors/*.js`; `validateCatalog()` rejects unknown dependencies, cycles, `core` as a dependency and duplicate ids. |
| `packages/core/features/featureState.js` | `createFeatureState(...)` and the lazy default `features` singleton: load, resolve, `isActive`, `availability`, `status`, seed, preset and atomic `write`. |
| `packages/core/features/gate.js` | `surfaceActive`, `requireSurface` and `unavailableResult`: surface identifier to owner (through the inventory) to a yes or a structured refusal. |

```js
const { features } = require('@goobster/core/features/featureState');
const { requireSurface } = require('@goobster/core/features/gate');

features.isActive('music');                      // boolean, memoised for the process
features.availability('gambling');               // { id, active, reasons: [{ code, detail?, dependency? }] }
requireSurface('command', 'economy/wheel.js');   // null, or { ok: false, code: 'FEATURE_UNAVAILABLE', feature, reasons }
```

## The four states

| State | Meaning | Where it comes from |
|---|---|---|
| installed | The feature's payload is present. Always `true` in Phase 1 (there are no selective payloads yet), but a file may say `false` and it is honoured: an uninstalled feature is never active, whatever the operator or the environment says. | `features.<id>.installed` in the file; `true` without a file. |
| configured | The keys and dependencies the feature needs exist right now. Derived on every snapshot from env and `config.json`, never persisted, so it cannot go stale. | `apiKeys` marked `required` in the descriptor; the mail provider rule; the half-set VAPID pair; system dependencies when a probe is supplied. |
| active | The operator's requested enablement as of the last applied restart (the startup snapshot). | `features.<id>.active` in the file; without a file, the effective legacy switch. |
| pending | A requested change that has not been applied yet. Never affects the running process. | `features.<id>.pendingActive` in the file, when it differs from `active`. |

`configured` and `pending` are derived. Only `installed`, `active` and
`pendingActive` are stored.

## Precedence

A feature is available when every step below passes. `availability(id)` lists
one reason per failed step, in this order:

1. **installed**: otherwise `NOT_INSTALLED`.
2. **configured**: otherwise `NOT_CONFIGURED`, with the NAME of each missing key (never a value).
3. **requested**: `active` in the file (or the legacy value without one); otherwise `DISABLED`.
4. **environment**: `GOOBSTER_FEATURE_<ID>=0|false|no|off` forces it off; otherwise `ENV_OFF`.
5. **dependencies**: every feature in `dependsOn` must itself be available; otherwise one `DEPENDENCY_INACTIVE` per dependency, with `dependency` set.

Two more codes: `UNKNOWN_FEATURE` (an id the catalog does not know; never
thrown) and `STATE_ERROR` (added to an inactive feature while the state file
is unusable, see below). An available feature has no reasons and an
unavailable one always has at least one. `core` is always available and
cannot be disabled, uninstalled or listed in the file.

A surface owned by one feature that also lists `alsoRequires` (for example
the music playback commands: music, voice and discord) is available only when
all of them are; `requireSurface` reports the first one that is not.

## `data/features.json`

The path is `path.join(runtimePaths.dataDir, 'features.json')`
(`GOOBSTER_DATA_DIR` moves it). Version 1:

```json
{
  "version": 1,
  "revision": 3,
  "updatedAt": "2026-10-06 21:14:02",
  "origin": "legacy-seed",
  "features": {
    "music":    { "installed": true, "active": true },
    "gambling": { "installed": true, "active": false, "pendingActive": true }
  }
}
```

| Field | Rules |
|---|---|
| `version` | Must be `1`. Any other number is `UNSUPPORTED_VERSION`; a missing or non-numeric one is `CORRUPT_STATE`. |
| `revision` | Non-negative integer, incremented by one on every write. Used for conflict detection. |
| `updatedAt` | UTC `YYYY-MM-DD HH:MM:SS`, set by the writer. |
| `origin` | `legacy-seed` (written from the effective legacy switches), `fresh-preset` (the new-install preset) or `operator` (a later change). |
| `features` | Every catalog id except `core`. Unknown ids are `UNKNOWN_FEATURE`; `core` is `CORE_IMMUTABLE`. An id missing from an older file falls back to its legacy value, so a feature added later never breaks an existing file. |

### Invalid files

An unknown id, a wrong version, unparsable JSON, a malformed entry or an
unreadable file (`STATE_UNREADABLE`) is never ignored silently and never
deleted or rewritten. The resolver falls back to the legacy behaviour for
availability, and `status().error` carries `{ code, message, feature? }` so
core management can show it and the operator can fix or restore the file.
Writing refuses to replace a file it cannot read. The error never repeats the
contents of the file.

## Without a state file: legacy behaviour

With no `features.json` the installation behaves exactly as it did before the
catalog existed. `requested` is the effective legacy switch of the feature:

| Feature | Effective legacy switch | Source |
|---|---|---|
| `discord` | `GOOBSTER_DISCORD_ENABLED` / `discord.enabled` when set, else a non-empty `token` | `config/discordConfig.js` |
| `push` | `GOOBSTER_WEB_PUSH_ENABLED` / `webapp.push.enabled` (default on); off when only one half of the VAPID pair is set | `config/pushConfig.js` |
| `mail` | on when a provider (SMTP, then Resend) has credentials and a from address | `config/mailConfig.js` |
| `mcp` | `GOOBSTER_MCP_ENABLED` (any value but `0`/`false`/`no`/`off`), then `mcp.enabled`, default off | `config/mcpConfig.js` |
| `sandbox` | `GOOBSTER_SANDBOX_ENABLED` `1`/`true`, or `sandbox.enabled === true`, default off | `config/sandboxConfig.js` |
| `observatory` | `GOOBSTER_OBSERVATORY_ENABLED` `1`/`true`, or `observatory.enabled === true`, default off | `config/observatoryConfig.js` |
| `projects` | `GOOBSTER_PROJECTS_ENABLED` `0`/`false`/`1`/`true`, then `projects.enabled`, default on | `config/observatoryConfig.js` |
| `expeditions` | on unless `GOOBSTER_SPITBALL_ENABLED` is `0`/`false` or `spitball.enabled === false` | `config/spitballConfig.js` |
| `gba` | `gbaRun.enabled === true` | `config.json` only |
| `screenVision` | `screenVision.enabled === true` | `config.json` only |
| `discordActivity` | `activity.enabled === true` | `config.json` only |
| `github`, `cursor` | no flag: always requested, because `/github`, `/agent` and their tools exist whether or not a credential is set. `cursor` additionally needs `CURSOR_API_KEY` (a required key); `github` works keyless | `config/integrationsConfig.js` |
| everything else | no switch: always on (`music`, `voice`, `tavern`, `economy`, `exchange`, `gambling`, `knowledge`) | none |

The resolver reuses the config modules' own computed values for `discord`,
`mcp`, `sandbox`, `observatory`, `projects`, `expeditions` and `mail`, so
their `setEnabledForTests` and `_setForTests` seams keep working. `push` is
evaluated from its switch and key pair without calling `pushConfig.resolve()`
(that call generates a key file under `data/`, and a read must not write).
A plain config object can be injected instead of the modules (see
`createFeatureState({ config })`); `tests/featureState.test.js` proves both
sources agree with the real modules for every flag combination in its
fixture table.

Hard dependencies apply in legacy mode too: `observatory` enabled without
`sandbox` is unavailable (as its execution already was), and
`discordActivity` without the Discord adapter is unavailable.

### Seeding and the fresh preset

- `seedFromLegacy()` builds a document from those effective values
  (`installed: true`, `origin: "legacy-seed"`). `active` already respects
  dependencies, so the seed is always a valid document.
  The first explicit write of an existing installation uses it.
- `freshPreset()` is the #261 new-install preset from each descriptor's
  `freshDefault`: `economy`, `exchange` and `gambling` off, every other feature
  on. "On" is not "configured": `mcp`, `sandbox`, `observatory`,
  `screenVision`, `discordActivity`, `gba` and `cursor` still report
  `NOT_CONFIGURED` or `DEPENDENCY_INACTIVE` until their keys exist. (Whether GBA
  should be on in the preset is the open question recorded in
  `documentation/feature_inventory.md`.)
- Both are pure: they return a document and write nothing.

## Environment overrides

`GOOBSTER_FEATURE_<UPPER_SNAKE_ID>` (`GOOBSTER_FEATURE_MUSIC`,
`GOOBSTER_FEATURE_SCREEN_VISION`, `GOOBSTER_FEATURE_DISCORD_ACTIVITY`, ...)
set to `0`, `false`, `no` or `off` deactivates the feature in this process and
makes its dependents unavailable. Any other non-empty value cannot activate
anything: it is ignored and one warning naming only the variable is logged. An
override can never install a missing payload or satisfy a missing key.

## Status

`status()` is plain JSON and is safe to serve to an operator:

```json
{
  "source": "file",
  "version": 1,
  "revision": 3,
  "origin": "operator",
  "error": null,
  "features": {
    "gambling": {
      "installed": true, "configured": true, "active": false,
      "pending": true, "requested": false, "pendingActive": true,
      "reasons": [{ "code": "DISABLED", "detail": "features.json" }]
    }
  }
}
```

`source` is `none` when there is no usable file (including an invalid one,
which also sets `error`). `active` is the effective answer, `requested` the
operator's stored `active`, `pending` whether `pendingActive` differs from it.
`unavailable()` lists the `availability` of every inactive feature in catalog
order; #319 uses it for the one-line prompt summary.

### The secrets rule

Status, `availability`, `unavailable`, errors and logs carry the **names** of
env variables and config keys, never their values. `detail` is a variable name
(`CURSOR_API_KEY`), a switch name (`mcp.enabled`) or a state code, nothing
else. A missing key is reported by name; a present key is reported only as
`configured: true`. File contents are never copied into an error message. The
catalog's `apiKeys` entries describe a key (name, purpose, where to get it,
whether it is required) and have no value field.
`tests/featureState.test.js` serialises every output with fake secrets in
config and env and fails if any appears.

## Writing

`await state.write(doc, { expectedRevision })` is the only mutation, for the
later manager and operator pages (there is no mutation route yet).

1. The document is validated: known ids, `core` absent, an uninstalled
   feature not active, and the dependency closure. A feature requested active
   (now, or through `pendingActive`) whose hard dependency is requested
   inactive is `DEPENDENCY_CONFLICT` naming both ids and the missing
   dependency is **never** enabled for you. Missing entries are filled from
   the legacy seed.
2. The current file is read. `expectedRevision` must equal its revision, or
   `null`/`0` when no file exists; otherwise `StaleRevisionError` with
   `expected` and `actual`. A file that cannot be read stops the write.
3. The directory is created, `features.json.tmp` is written and renamed over
   `features.json`. A `.tmp` left by an interrupted write is ignored by reads
   and overwritten by the next write; a failed write removes its tmp file and
   leaves the target as it was.
4. The new revision is `expectedRevision + 1`. The running snapshot does not
   change; call `refresh()` deliberately (tests, and the manager after a
   restart).

Two processes can still race between the revision check and the rename; a
lock is a manager concern (Phase 2).

## State transitions

**No file, first write seeds.** An existing installation has `mcp.enabled:
true` and a bot token. Reads see no file and behave as today. The first
explicit write:

```js
const doc = features.seedFromLegacy();                 // origin "legacy-seed", mcp active, economy active, ...
await features.write(doc, { expectedRevision: null }); // revision 1
```

Nothing changes in the running process; after the next start the file decides,
and every answer equals what the legacy switches gave.

**Operator disables gambling: pending until restart.**

```json
{ "gambling": { "installed": true, "active": true, "pendingActive": false } }
```

(revision 2, written with `expectedRevision: 1`). The running process still
answers `isActive('gambling') === true`; `status()` shows `pending: true`.
After the restart the manager writes `active: false` and drops
`pendingActive`; from then on `gambling` is unavailable with `DISABLED`, and `/gamble`,
the wheel, predictions and the casino table games (all owned by `gambling`)
are unavailable; `exchange` is unaffected. Disabling `economy` while `exchange`
or `gambling` stay on is a `DEPENDENCY_CONFLICT`; the operator disables them
together.

**Environment off on top of an active feature.** The file says
`music.active: true` and the process starts with `GOOBSTER_FEATURE_MUSIC=off`:

```json
{ "id": "music", "active": false, "reasons": [{ "code": "ENV_OFF", "detail": "GOOBSTER_FEATURE_MUSIC" }] }
```

The file is untouched; unsetting the variable and restarting restores it.
`GOOBSTER_FEATURE_MUSIC=1` on a feature the file or legacy switch has off does
nothing but log the warning.

**Fresh install.** The installer writes `freshPreset()`; `economy`,
`exchange` and `gambling` are `DISABLED`, `gambling` would also report
`DEPENDENCY_INACTIVE` for `economy` while that is off, and `cursor` reports
`NOT_CONFIGURED` for `CURSOR_API_KEY` until a key is set.

**A damaged file.** `features.json` contains `{ "version": 2, ... }`: status
shows `source: "none"` and `error: { "code": "UNSUPPORTED_VERSION", ... }`,
availability is the legacy answer, and the file is left exactly as it was.

## System dependencies

The catalog records each feature's system dependencies from the inventory
(`ffmpeg` for voice, `bubblewrap` for the sandbox, and so on). The resolver
does not look for binaries on its own, so a host without `ffmpeg` is not
turned into a different installation by an upgrade. A manager can opt in:
`createFeatureState({ probes: { systemDependency: createPathProbe() } })`
makes a missing `requiredSystemDependencies` entry (currently `ffmpeg` for
voice) a `NOT_CONFIGURED` reason. `createPathProbe` only reads `PATH`
(and `FFMPEG_PATH` for ffmpeg), never spawns, and memoises.

## Testing

`createFeatureState` takes `fs`, `filePath`, `env`, `config`, `probes`, `now`
and `logger`, so every behaviour above runs in memory:

```js
const state = createFeatureState({ fs: memoryFs, filePath: '/x/features.json', env: {}, config: { mcp: { enabled: true } } });
features._resetForTests({ config: { token: 'x' }, env: {} });   // the singleton, for gate tests
```

`tests/featureCatalog.test.js` keeps the catalog in step with the inventory
and the repository (documentation paths, env var names and config sections
must exist). `tests/featureState.test.js` covers everything in this document.
