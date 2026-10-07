---
title: Selective payloads - the release manifest, selection, frontend chunks, staging, verification and signing
kind: reference
summary: How a Goobster payload carries only the features an operator selects. Covers file and dependency ownership, the signed release manifest (version 1), payload selection and profiles, lazy seams so reduced payloads load, per-feature portal chunks, staging and atomic activation, verification codes, Ed25519 signing and development mode, adding and removing features without touching data, the manager's payload.* seam, and what is verified where.
tags: [installer, packaging, payload, manifest, signing, features, selection, frontend]
---

# Selective payloads

Phase 3 item 2 of the installer plan (`documentation/installer_plan.md`,
issue #328, epic #315) turns the single standalone payload of the packaging
proof (`documentation/packaging_proof.md`, #327) into payloads that carry
only the features the operator picked. An excluded feature's code, its
exclusive npm dependencies and its portal bundle are **physically absent**.
Everything that remains still loads and answers, and data the feature wrote
earlier stays reachable by the privacy path.

This is the payload layer. Whether an *installed* feature is on or off is
still decided by the Phase 1 feature state (`documentation/feature_state.md`).
Those gates are unchanged and never consult the manifest. Whoever installs a
reduced payload (the wizard, the manager, or the smoke check's `--routes`
mode) writes `installed: false` into `data/features.json` for every feature
the selection leaves out, and those features are then refused like any
other unavailable one. Without that file the legacy rule still reports them
installed, but their routes answer 404 anyway, because the seams below find
nothing to load or mount. `tests/payloadReduced.test.js` covers
both cases.

Words used below:

| Term | Meaning |
|---|---|
| release | One build of one version for one target (`linux-x64`, ...). |
| catalogue | The signed **release manifest**. It lists every file the release has, with its owner, whether or not a given copy carries it. |
| group | The files and dependencies owned by one catalog feature (`core` included). |
| selection | The features one copy of the release carries (`payload-selection.json`). |
| payload | A directory tree: the selected files, the catalogue, its signature and the selection. |
| exclusive | A dependency with exactly one owner, and that owner is not `core`. |
| shared | A dependency with more than one owner, or owned by `core`. |
| unreferenced | A production dependency that no source file imports. |

## Ownership

`scripts/lib/payloadManifest.js` (`computeOwnership`) decides who owns what.
It is pure and deterministic and has no timestamps.

- **Source files.** Every feature descriptor in
  `packages/core/features/descriptors/` declares `payload.files` globs
  (plus `payload.frontend` and `payload.system`). Any tracked file that
  matches no feature glob belongs to `core`. A file matched by two features
  is a conflict and fails the build. So does a glob that matches nothing.
- **npm packages.** `scripts/lib/requireGraph.js` reads every `require()`,
  `requireOptional()` and ESM import in the source files. A package belongs
  to the features whose files import it. Its own transitive dependencies
  from `package-lock.json` inherit those owners, as does a package that
  another package loads by a literal probe (an optional codec or crypto
  backend). A package that only one non-core feature reaches is exclusive.
  Anything reached by core, or by two features, is shared and stays while
  any owner is selected.
- **Unreferenced packages** are reported and **left out of every payload**.
  Today there are none: `play-dl` and `play-audio` (finding B5) were the
  only ones and are no longer declared. `tests/payloadManifest.test.js`
  fails if a new one appears.
- **System dependencies** (ffmpeg, the music Python venv, bubblewrap,
  Ollama) are listed per group with their kind. They are never shipped
  inside the payload and never uninstalled by it. See "Adding and removing
  features".

The real output for six features, from the linux-x64 release built from
this tree:

| Feature | Source globs | Exclusive dependencies | Notable shared dependencies | System |
|---|---|---|---|---|
| `discord` | `apps/bot/**`, `packages/core/utils/commandDeployment.js` | 16: `discord.js`, `@discordjs/{builders,collection,formatters,rest,util,ws}`, `@sapphire/{async-queue,shapeshift,snowflake}`, `@vladfrangu/async_event_emitter`, `fast-deep-equal`, `lodash`, `lodash.snakecase`, `magic-bytes.js`, `ts-mixer` | the voice stack (`@discordjs/voice`, `@snazzah/davey`, `libsodium-wrappers`, `opusscript`, `prism-media`, `sodium-native`), `express`, `axios`, `ws` | - |
| `music` | the music commands, `services/spotdl/**`, `services/ytdlp/**`, the music and ambience voice services, `web/routes/studio.js`, `apps/web/src/music-lab/**` and more | none | the voice stack, `node-fetch`, `dotenv` | `spotdl`, `yt-dlp` (python), `python3-venv` |
| `voice` | the voice commands, `services/voice/**`, `webVoiceService`, `voiceLiveService`, `transcriptionService`, `speechStyles` | none | the voice stack, `openai`, `uuid` | `ffmpeg` |
| `tavern` | the tavern commands, `services/tavern/**`, `tavernViews`, `tools/tavern.js`, `campaigns/**` | none | `yaml` | - |
| `mcp` | `apps/mcp/**`, `packages/core/mcp/**` | none | `express` and its tree | - |
| `sandbox` | `apps/sandbox/**`, `sandboxService`, `sandboxRequestService`, `sandboxPackagesStore`, `tools/sandbox.js` | none | `express`, `axios` | `bubblewrap`, `python3-venv` |

The voice stack is shared by `discord`, `gambling`, `music` and `voice`, so
it ships while any of them is selected. `sharp` is shared by `core` and
`exchange`, and `better-sqlite3`, `sqlite-vec`, `pg`, `katex` and
`@napi-rs/canvas` are core. Across the release there are 260 dependency
entries, 20 of them exclusive: the 16 above, three nested copies of
`@discordjs/collection` and `@sapphire/snowflake`, and `nodemailer` for
`mail`. Print the table for any feature with
`ownershipTable(manifest, id)` from `scripts/lib/payloadManifest.js`.

## The release manifest (version 1)

`payload-manifest.json` sits at the payload root. It is written in
canonical form: keys sorted, two-space indent, trailing newline.

```
{
  "version": 1,
  "release":  { "core": "1.0.0", "compatibleCore": ">=1.0.0 <2.0.0" },
  "target":   { "id": "linux-x64", "platform": "linux", "arch": "x64" },
  "node":     { "version": "22.23.3", "abi": "127", "moduleVersion": "127", ... },
  "groups": {
    "core":  { "globs": [], "files": [...], "dependencies": [...], "system": [...] },
    "<id>":  { "globs": [...], "files": [...], "dependencies": [...],
               "frontend": [...], "system": [{ "name", "kind" }], "requires": [...] }
  },
  "files":        [{ "path", "sha256", "size", "owner", "dependency"? }],
  "dependencies": [{ "name", "version", "path", "owners": [...], "exclusive",
                     "native": { "installScript", "binaries": [...] } | null, "license" }],
  "frontend":     { "chunks": [{ "file", "feature", "sha256", "size" }] },
  "unreferenced": [{ "name", "reason" }],
  "signing":      { "algorithm": "ed25519", "keyId": "<16 hex>" }
}
```

Field notes:

- `files` lists **every file of the full release** under its payload path,
  sorted. A file inside a dependency directory carries `dependency` and
  follows that dependency's selection. Its owner is the dependency's only
  owner when the dependency is exclusive, otherwise `core`. Portal files
  take the feature of their chunk.
- `groups.<id>.files` lists the non-dependency files of that group. Every
  file appears in exactly one group. `requires` is the feature's
  `dependsOn` from the catalog.
- `release.compatibleCore` is the core range this release's feature groups
  run against (same major, this version or later).
- `signing` is present only on a signed manifest. The signature covers it,
  so the key id cannot be swapped.
- A lockfile package with no file in the built tree, such as another
  platform's optional binary, is not listed.

The packaging-proof fields from #327 are kept in the same file, because
`scripts/package-smoke.js` and the CI summary read them: `schema`,
`goobsterVersion`, `commit`, `lockfileSha256`, `workspaces`, `layout`,
`payloadDigest`, `prebuiltBinariesFetched`, `libvips`, `baselines`,
`nativeBinaries`, `licenses`, and the extra `node` fields (`moduleVersion`,
`archive`, `archiveSha256`, `source`, `runtimeVerified`).

The JSDoc typedef `ReleaseManifest` in `scripts/lib/payloadStage.js` is
the machine-readable form of this section.

## Selection

`selectPayload(manifest, { features })` in `scripts/lib/payloadStage.js`
returns:

```
{ features, files, dependencies, chunks,
  excluded: { features, files, dependencies, chunks } }
```

Rules:

- `core` is always selected. The requested features are closed over
  `requires`: `exchange` brings `economy`, and `observatory` brings
  `projects` and `sandbox`. Every subset closed under `requires` is
  supported.
- A dependency directory is kept when **any** of its owners is selected.
  Files inside a dependency follow it, and every other file follows its
  owner. Selecting `voice` therefore keeps the voice stack and drops every
  music module.
- Feature lists are ordered with `core` first, then alphabetically.

A payload records its selection in `payload-selection.json`
(`{ "version": 1, "profile": "minimal" | "full" | "custom", "features": [...] }`).
This file is **local and unsigned**, but it can only name groups the
signed catalogue defines. Verification then expects exactly those groups'
files, so a selection cannot bring in anything the release did not sign.
Without the file, the payload carries every group.

The portal also gets `app/apps/web/dist/installed-features.json`
(`{ "version": 1, "features": [...] }`, the selection minus core), and
verification checks that it agrees with the selection. The four local
files (manifest, signature, selection, installed-features) are the only
files a payload may carry beyond the catalogue.

## Reduced payloads must load

Once files are missing, any core-owned module that `require`s a
feature-owned module at load time is a defect. The fix is at the seams,
not with scattered `try`/`catch`:

- `packages/core/utils/optionalModule.js`:
  `requireOptional(spec, { feature })` returns the module, or `null` **only**
  when that exact module cannot be found. Any other failure rethrows,
  including a dependency missing *inside* a present module, because a
  broken install is not an uninstalled feature. The first absence is
  recorded for diagnostics (`absentModules()`), and no path ever reaches a
  user-facing message. Keep both arguments literal: `requireGraph.js`
  reads that form to know the edge is optional.
- Core modules that reach into feature code go through it, or through a
  lazy `require` inside the function that needs it:
  - the service manager
  - the bundled steps of `coreRuntime.js`
  - the tool registry and tool adapters
  - the MCP tools and resources
  - the route mounts in `web/appApi.js`
  - `web/appContext.js` and `web/appWebsocket.js`
  - the bot's web server, Activity API and event listeners
  - `apps/api/server.js`
  - and the services that used to import another feature at the top
- **`discord.js` (finding B6)** is no longer loaded by the portal or API
  path. Core code that builds embeds, buttons or permission checks reads
  them from the `discord` accessor exported by `optionalModule.js`
  (`discord.EmbedBuilder`). The accessor loads the library on first
  property access and throws `GatewayDisabledError` (`DISCORD_DISABLED`)
  when it is absent, which every Discord delivery path already treats as
  "not connected". The catalogue therefore shows `discord.js` and its tree
  as exclusive to `discord`.
- The economy, gambling and sandbox chat tools live in their own modules
  (`packages/core/utils/tools/{economy,gambling,sandbox}.js`). The tool
  registry skips a tool module that is absent.
- A route whose service is absent (expeditions, voice tasks, the exchange
  workspace) answers 404 `FEATURE_UNAVAILABLE`, like a disabled feature.

**Dormant data.** The schema, `privacyService`, the account export, the
retention pruners, `inboxService` and `operatorAuditService` are core. They
must not load feature modules to do their job. Per-user erasure and
counting for the projects, expeditions and sandbox stores lives in
`packages/core/services/dormantDataService.js`, which the feature services
delegate to. `/forget-me`, the data report and the export therefore reach
rows a removed feature left behind.

## Frontend chunks

The portal is built once and pruned per payload
(`scripts/lib/frontendChunks.js`).

- `apps/web/src/lib/rooms.cjs` names, for each feature room or view, the
  lazy route modules that open it (`chunk: { feature, modules }`).
  `main.tsx` imports those modules only through `React.lazy`.
- At build time `apps/web/vite.config.ts` labels the module graph:
  - Whatever the entry reaches without passing a feature route module is
    `core`.
  - A module reached only through one feature's routes (or through a
    feature and the features it requires) belongs to that feature.
  - A chunk whose modules all belong to one feature is emitted as
    `assets/feature-<id>-<name>-<hash>.js`, and so is its stylesheet.
- After the build, the closure is checked and the build fails if it is
  broken. A core chunk never statically imports a feature chunk, and a
  feature chunk imports only core chunks, its own and those of the
  features it requires. The labels are written to `dist/feature-chunks.json`.
- `pruneDist(dist, { installed })` deletes the chunks and sourcemaps of
  every feature left out and writes `installed-features.json`.
  `package-runtime.js` treats any file it would delete beyond the
  catalogue's chunk list as a build failure.
- At runtime, `apps/web/src/shell/FeatureChunk.tsx` wraps each lazy room.
  When its import fails, it asks `/api/app/features`. A feature that is not
  installed renders the "not available on this installation" state, with no
  reload loop and no page error. Any other failure goes to the existing
  stale-chunk recovery.

Chunk map of the current build:

| Feature | Chunks |
|---|---|
| core | 5 |
| knowledge | 5 |
| expeditions | 1 |
| projects | 4 |
| music | 34 |
| exchange | 1 |

Tavern has no portal room of its own today, so it has no chunk.

## Verification

`verifyPayload(dir, options)` in `scripts/lib/payloadStage.js` uses Node
built-ins only. It ships inside every payload next to
`scripts/package-smoke.js`. Options:

- `expectedTarget` (e.g. `linux-x64`)
- `nodeAbi`
- `coreVersion`
- `publicKey`: one PEM or `KeyObject`, or a list of them
- `devMode`
- `hash` (default `true`)

On success it returns
`{ ok, releaseId, signed, devMode, keyId, target, abi, core, features, profile, files, bytes }`.
On failure it throws a `PayloadError` with a stable `code`. The checks run
in this order:

| Order | Code | Meaning |
|---|---|---|
| 1 | `MANIFEST_MISSING` | no directory, or no `payload-manifest.json` |
| 2 | `MANIFEST_INVALID` | unparsable, wrong `version`, a field of the wrong shape, a duplicate path, or an owner that is not a group |
| 2 | `PATH_TRAVERSAL` | a listed path is absolute, has `..`, a drive letter, a backslash or a NUL |
| 3 | `SIGNATURE_MISSING` | the manifest names a signing key but there is no `.sig` |
| 3 | `SIGNATURE_INVALID` | a signature that does not verify, a key id that is not trusted, or (outside development mode) a signed payload checked with no trusted key |
| 3 | `UNSIGNED_DEV_ONLY` | an unsigned payload outside development mode |
| 4 | `MANIFEST_INVALID` | `payload-selection.json` is malformed or names a group the catalogue lacks |
| 5 | `TARGET_MISMATCH`, `ABI_MISMATCH`, `VERSION_INCOMPATIBLE` | built for another target or Node ABI, or the core version is outside `compatibleCore` |
| 6 | `LINK_ESCAPES_ROOT` | a symlink resolves outside the payload |
| 7 | `INCOMPLETE` | a selected file is missing or differs in size or SHA-256 (a flipped byte, a truncated download) |
| 8 | `EXTRA_FILE` | a file outside the selection, including an excluded feature's file put back, an in-tree symlink, or a special file |
| 9 | `MANIFEST_INVALID` | `installed-features.json` disagrees with the selection |

`node app/scripts/lib/payloadStage.js verify <dir> [--target <id>] [--abi <n>] [--core <version>] [--public-key <pem>] [--dev]`
prints `{ ok, code, message }` and the summary as JSON. It exits 0 when the
payload verifies, 2 when it is refused and 1 on a usage error. CI's tamper
probes use it; from a source checkout the same command is
`npm run package:verify -- <dir> [options]`.

## Staging and activation

- `stageSelection(sources, stagingRoot, selection, options)` copies the
  selected files from one or more verified sources into
  `<stagingRoot>/<releaseId>-<8 hex>.partial/`. Each file is checked
  against its hash while it is copied and fsynced, file modes are kept,
  and the stage writes the selection and installed-features files. It then
  verifies the staged tree and renames it to drop `.partial`. Sources that
  are copies of different releases are refused (`MANIFEST_INVALID`), a
  selected file found in none of them is `SELECTION_UNAVAILABLE`, and a
  source file that changes while it is copied is `INCOMPLETE`. `releaseId`
  is `<core>-<target>-<first 12 hex of the canonical manifest's SHA-256>`.
- An interrupted stage leaves a `.partial` directory (named in the error)
  and never touches the running install. `listStaging` reports ready and
  partial stages, and `cleanStaging` removes the partial ones.
- `activate(stagingDir, installRoot, options)` re-verifies the staged tree
  (unless `verify: false`) and refuses a `.partial` directory. It then:
  1. retires the old `previous/`;
  2. renames `current/` to `previous/`;
  3. renames the staged tree to `current/`.

  If the last rename fails, it puts `previous/` back and throws
  `ACTIVATE_FAILED`.
- `recoverInstall(installRoot)` runs first in every activation. It repairs
  a crash between the two renames by restoring `previous/` when `current/`
  is missing, and returns `ok`, `restored-previous` or `empty`.

On Windows a directory with running code cannot be renamed. The manager
must stop the service before activating and start it afterwards.

## Signing and development mode

- The signature is Ed25519 over the canonical manifest bytes, `signing`
  included, stored base64 in `payload-manifest.sig`. The key id is the
  first 16 hex characters of the SHA-256 of the public key's SPKI DER.
- `scripts/package-sign.js --gen-dev-key <dir>` writes a throwaway key
  pair: the private key with mode 0600, refusing to overwrite and refusing
  a directory inside the repository.
- `scripts/package-sign.js --key <pem> <payload>` signs a payload in place,
  replacing an earlier signature and key id. Neither command prints key
  material.
- `scripts/package-runtime.js --dev-sign` generates a key in a temp
  directory, signs, keeps only the public key in the report directory
  (`payload-dev-key-<target>.pub.pem`) and deletes the private key.
- **Development mode** (`devMode: true`, or `GOOBSTER_PAYLOAD_DEV_UNSIGNED=1`
  when the option is not given) accepts an unsigned payload and labels it:
  the result says `signed: false, devMode: true`, and the smoke check
  prints "UNSIGNED DEVELOPMENT PAYLOAD".
- When a trusted key is supplied, an **invalid signature is refused even
  in development mode**, so editing a signed manifest (to retarget it, for
  example) is caught. Development mode *without* a key accepts a signed
  payload as unverified and labels it the same way (`signed: false`),
  which is why only a key, never development mode, may stand behind a
  release.
- There are no production keys yet. Key custody, rotation and the trusted
  key list a release build embeds are #341. Until then every payload is a
  development payload, and release notes must say so.

## Adding and removing features

`scripts/lib/payloadApply.js` changes an installed payload's selection.
The JSDoc typedefs `ChangePlan` and `SystemAudit` describe its shapes.

- `planChange(installRoot, manifest, { add, remove, source, profile })` is
  pure. It returns:
  - the features before and after;
  - the files, dependencies and chunks to add and remove;
  - whether a verified `source` payload is needed (adding needs one,
    removing does not);
  - `keeps`: shared dependencies that stay, and which feature needs them;
  - `system`: one audit entry per system dependency, marked `needed`,
    `still-needed` (with who still needs it) or `no-longer-needed`, with
    `action: 'audit'`;
  - the protected paths.

  It refuses with these codes:
  - `UNKNOWN_FEATURE`
  - `CORE_REQUIRED`
  - `REQUIRED_BY` (removing a feature another selected feature requires)
  - `RELEASE_MISMATCH` (the manifest is not the one `current/` was installed from; an upgrade is a new release, not an add/remove)
  - `NOT_INSTALLED` (there is no `current/` payload to change)
- `applyChange(plan, options)` never edits `current/` in place. It checks
  that the plan is not stale (`PLAN_STALE`) and that a needed source is
  given (`SOURCE_REQUIRED`). It then stages the new selection from
  `current/` plus the source and activates it, as in "Staging and
  activation". It returns what was added, removed and audited.
- `data/`, `config.json`, `config/`, `logs/`, `cache/` and the manager store
  (`data/manager/`) are never read, written or moved. Instance roots are
  separate from the payload anyway. The tests plant a sentinel in each and
  compare content and mtime.
- Exclusive dependencies of a removed feature go with it, and shared ones
  stay while any selected feature needs them.
- Nothing outside the payload is uninstalled: no ffmpeg, no Python venv, no
  bubblewrap. The audit entries tell the operator what is no longer needed.
- Removing a feature leaves its rows in the database. Re-adding it
  restages its files from a verified payload of the same release, and the
  rows are still there.
- `previous/` keeps the files of the last selection for rollback until the
  next activation retires it.

## The manager seam

The manager (`apps/manager`, #323/#324) will drive this through a
`payload.*` operation kind. The calls:

- `verifyPayload(dir, { expectedTarget, nodeAbi, coreVersion, publicKey })`
  before trusting a downloaded or staged payload. Show `code` and `message`;
  both are free of secrets and paths outside the payload.
- `planChange(...)` for the review screen. It is pure, so it is safe to call
  on every change of the feature checkboxes. Show `features`, the size
  delta from `files`, `keeps` and `system`.
- `applyChange(plan, { stagingRoot, publicKey, ... })` once the service is
  stopped. Then update the Phase 1 feature state for the features that
  changed, and start the service.
- `listStaging` and `cleanStaging` for the repair screen, and
  `recoverInstall` at manager start.

`scripts/lib/payloadStage.js` and `scripts/lib/payloadApply.js` use Node
built-ins only. They never import `packages/core`, the manager or an app,
and `packages/core` never imports them.

The manager's install engine (#329, `documentation/manager_install.md`)
calls `verifyPayload`, `stageSelection`, `activate` and `recoverInstall`
through `apps/manager/install/release.js` (lazy, so a manager without a
payload layer still starts) for `install.new`, `install.reconfigure` and
`install.repair`, and refuses a payload that does not verify before it
writes anything. It reads only a local payload directory; the network
download is a named hook for the bootstrappers. The bootstrappers (#331) carry the payload, call `verifyPayload` before
the first start, and register the service. Production signing keys are
#341.

## Building

```
node scripts/package-runtime.js [--profile minimal|full | --features <csv>] [--dev-sign] \
    [--with-sandbox] --out <dir> --report-dir <dir> [--force]
```

- No selection flag builds the full payload, as before.
- `--profile minimal` is core only.
- `--features a,b` is that set closed over `requires`. A selection that
  includes `sandbox` also carries `apps/sandbox`.

The build:

1. installs and prunes the whole release;
2. hashes it into the catalogue;
3. signs if asked;
4. deletes what the selection leaves out (emptied directories included)
   and prunes the portal chunks;
5. writes the selection;
6. runs `verifyPayload` on the result.

Any failure fails the build. The report
(`package-build-<target>.json`) adds:

- `profile`, `features`, `excluded`
- `unreferencedDependencies`, `unreferencedRemoved`
- `signed`, `keyId`, `devPublicKey`, `releaseId`
- `catalogueFileCount` next to `fileCount`

`scripts/package-smoke.js` adds these checks to the #327 list:

- `payload.verify`: `verifyPayload`, labelled when unsigned.
- `payload.exclusive-absence`: every excluded file, dependency directory
  and chunk is absent, every selected one is present, and no unreferenced
  dependency ships.
- With `--routes`: the standalone API is booted with a `features.json`
  written from the selection. `/api/app/features` must agree with the
  selection, a selected feature's route must answer, and an excluded one
  must return 404.
- With `--dormant-probe <dir>`: dormant rows for two accounts are seeded
  in optional-feature tables. The data report, export and `/forget-me`
  then run inside the payload, and the probe asserts that no file outside
  the payload or an excluded feature's file was loaded.

The native checks for `sodium-native`, `@snazzah/davey` and the
libsodium/opus wasm are reported `skip` when the selection leaves those
packages out.

## What is verified where

| Claim | Where | Engines / targets |
|---|---|---|
| Ownership is total, conflict-free and deterministic; the privacy closure is feature-free; selection rules for minimal, full, voice without music, projects without mcp, knowledge without expeditions and discord excluded | `tests/payloadManifest.test.js` | Node only |
| A reduced source tree boots `apps/api` with no `MODULE_NOT_FOUND`, loads no excluded file, reports `installed: false` and answers 404 for excluded routes and non-404 for selected ones; dormant export and erasure work with the modules absent | `tests/payloadReduced.test.js` (core-only, core-only without a `features.json`, voice without music, projects without mcp, full) | Linux; SQLite and Postgres |
| Every verification code; signatures and development mode; staging, interruption, activation, rollback and recovery; the sign and verify CLIs | `tests/payloadStage.test.js` | Node only |
| Add and remove never touch protected paths or data; exclusive dependencies go, shared ones stay; system dependencies are only audited; rows survive remove and re-add | `tests/payloadApply.test.js` | SQLite and Postgres |
| Chunk declarations, labelling, the built closure and pruning | `tests/frontendChunks.test.js` | after `build:web` |
| A pruned portal renders, hides absent rooms, shows the unavailable state on deep links and survives a chunk 404 without a reload loop | `e2e/reducedPayload.spec.js` | Chromium |
| Real payloads (minimal dev-signed, voice, projects+sandbox) build, verify and smoke in place and relocated, read-only, with only the bundled Node; routes, dormant data and tamper probes | packaging-proof `reduced` job | **linux-x64 only** |

Not verified: reduced payloads on the other four targets (the #327 matrix
there still builds the full payload only), and signing with a production
key (#341).

A note for anyone booting a whole runtime under `GOOBSTER_PG_TEST_ISOLATE=1`
(as `tests/payloadReduced.test.js` does on the Postgres job; the smoke
check's `--routes` mode boots on SQLite): the isolation default of three pooled Postgres clients is sized for a
Jest worker, not a runtime. `db.withSingletonLock` pins one client for the
life of the lock while its body queries through the same pool, and a
standalone boot takes three such locks at once (self-docs seed, retention,
account exports), so with a pool of three the boot can deadlock before it
listens and then hang on SIGTERM. The spawned children set
`GOOBSTER_PG_POOL_SIZE=10` (the production default); the same variable is
the knob for any other harness.
