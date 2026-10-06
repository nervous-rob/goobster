---
title: Native runtime packaging proof (audit N1)
kind: reference
summary: The N1 audit for the installer - every native dependency of the standalone no-Discord payload, where its prebuilt binary comes from, the OS, architecture and ABI matrix for the pinned Node 22 LTS, runtime library baselines, redistribution and licence notes, signing requirements, what is proven on which target, and the findings (B1 to B6) that gate the release phase.
tags: [installer, packaging, native-dependencies, prebuilds, node, signing, ci]
---

# Native runtime packaging proof (audit N1)

This is the output of installer plan Phase 3 item 1 (issue #327, epic #315,
ADR 0013 decisions 9 and 13) and of audit N1 in
`documentation/installer_plan.md`: can Goobster ship as a bundled Node
runtime plus installed production dependencies, with **no `npm install`, no
compiler and no system Node on the operator's machine**, on Windows x64,
macOS x64 and arm64, and Linux x64 and arm64?

The proof is a build recipe, a smoke check that runs inside the result, and a
CI matrix that runs both on a runner of each target. Only a target with an
executed smoke run counts as proven. Everything else in this document is
labelled **unverified**.

## Status at a glance

| Target | Runner label | Executed smoke run | Status |
|---|---|---|---|
| linux-x64 | `ubuntu-24.04` | yes, local VM (Ubuntu 24.04, glibc 2.39) | **passed with known gap B1** |
| linux-arm64 | `ubuntu-24.04-arm` | no | **unverified** (needs CI; arm64 runner availability for this repository is unknown) |
| win32-x64 | `windows-2022` | no | **unverified** (needs CI) |
| darwin-x64 | `macos-15-intel` | no | **unverified** (needs CI) |
| darwin-arm64 | `macos-15` | no | **unverified** (needs CI) |

For all five targets the upstream prebuilt asset of every native module
exists for the pinned ABI; that was read (headers only, never executed) by
`scripts/package-audit-upstream.js`. Downloading or inspecting another
platform's binaries is **not** execution evidence and is not counted above.

"Passed" for linux-x64 means: the payload built with the compile guard on,
every native binary matches the target architecture, SQLite plus sqlite-vec,
sharp, sodium-native and the standalone API all run with only the bundled
Node on `PATH`, the payload is byte-identical after the run, and the
configuration-root check reports the known gap B1 (below). The verdict the
smoke script prints is `PASS_WITH_KNOWN_GAPS`, never plain `PASS`, while B1
is open.

## What is packaged

The payload is the **standalone no-Discord portal and API**
(`apps/api` in standalone mode, `GOOBSTER_RUNTIME_MODE=standalone`; see
`documentation/independent_runtime.md`). It is deliberately the smallest
server that still exercises every native module the installer will
promise. It is not the full bot payload; the selective payload builder is
Phase 3 item 2 (#328).

Layout, produced by `scripts/package-runtime.js`:

```
<payload>/
  bin/goobster-api[.cmd]     launcher (sets the roots below, runs the bundled node)
  runtime/bin/node[.exe]     official Node build from nodejs.org, SHA-256 verified
  app/                       code root (GOOBSTER_WORKSPACE_ROOT), treated as read-only
    node_modules/            production dependencies with their prebuilt natives
    apps/api, apps/web/dist, documentation/, campaigns/, clients/
    scripts/package-smoke.js, scripts/lib/nativeBinaryInfo.js
  payload-manifest.json      SHA-256 of every file, native binary facts, licences,
                             a deterministic payloadDigest (no timestamps)
```

Separate roots, set by the launcher: code is `app/` (read-only);
mutable state lives under `GOOBSTER_HOME` (default per OS; `data/`, `cache/`,
`logs/`, `config/config.json`) with the overrides `GOOBSTER_DATA_DIR`,
`GOOBSTER_CACHE_DIR`, `GOOBSTER_LOG_DIR` and `GOOBSTER_CONFIG_PATH`. The
payload never contains `config.json`, `.env*`, `data/`, `logs/`, `cache/`,
databases, tests, `e2e/`, `.git` or a symlink; the build fails if any of
them appear, and CI re-checks that independently of the script.

### How it is built

`scripts/package-runtime.js` is host-only: it refuses to build a target
other than the machine it runs on, because cross-building would mean the
natives were never exercised. It:

1. Downloads the pinned Node archive (`scripts/package-node-pins.json`)
   and refuses it unless its SHA-256 matches the pin.
2. Runs `npm ci --omit=dev --foreground-scripts` for the `@goobster/core`
   and `@goobster/api` workspaces against the repository lockfile, with a
   cold npm cache so every prebuilt binary is really downloaded.
3. Guards against compiling: Python and the C and C++ compilers are
   pointed at a path that does not exist, so a fallback to `node-gyp
   rebuild` fails the build instead of quietly succeeding on a developer
   machine. The npm log is parsed for compile output, and the finished
   payload is searched for compile leftovers (`build/Makefile`,
   `config.gypi`, object directories, `.vcxproj`).
4. Replaces npm's workspace symlinks with real directories, deletes npm's
   `.bin` links, prunes other platforms' `sodium-native` prebuilds and
   source-only parts of the native packages, and confirms the `sodium-native`
   prebuild for the target is present.
5. Reads the header of every native binary (`scripts/lib/nativeBinaryInfo.js`,
   pure JavaScript; ELF, Mach-O thin and fat, PE) and fails if any is for
   another architecture or format.

### How it is smoked

`scripts/package-smoke.js` runs **inside the payload with its bundled Node**
(it refuses a system Node unless `--allow-system-node`). It scrubs secret-like
environment variables, uses an allow-listed child environment, puts the
instance in a path containing spaces and non-ASCII characters by default,
and writes a JSON report that contains no secrets. Checks, in order:

- `payload.manifest`: every file matches `payload-manifest.json`.
- `runtime.bundled`, `host.facts`, `binaries.targetArch`.
- `paths.separateRoots`, `paths.dataDirWritable`.
- `db.sqliteOpenWriteRead`: the schema applies (159 tables on the current
  schema), a row is written and read, WAL is on.
- `db.sqliteVecLoadedAndQueries`: **sqlite-vec must load**; the brute-force
  fallback counts as a failure here, because the point is to prove the
  prebuilt extension works.
- `db.closeCleanly`.
- `native.sharp` (png, webp, jpeg round trip), `native.sodium-native`
  (BLAKE2b-256 test vector), `native.napi-rs-canvas`, `native.snazzah-davey`,
  `wasm.libsodium-and-opus`.
- `api.standalone.direct`: starts `apps/api` on a free port with
  `webapp.enabled`, requests `/health` (expects `mode: standalone`,
  `discord: disabled`), the portal client and a static asset, stops it with
  SIGTERM (Windows: a stdin-triggered shutdown, because Windows has no graceful
  child signal), expects exit code 0 and the port released.
- `db.persistsAcrossProcesses`.
- `api.standalone.launcher`: the same through `bin/goobster-api[.cmd]`
  (`--no-launcher` skips it).
- `config.relocatable`: an empirical probe; reports `known-gap` B1 today.
- `payload.unmodifiedAfterRun`: manifest re-verified after the run, proving
  the code root was never written to.

`--read-only-data` runs the same with a read-only data directory and expects
a clear, actionable failure rather than a stack trace.

## Node pin

**Node 22.23.3 (Jod, LTS), ABI (`NODE_MODULE_VERSION`) 127, Node-API 10.**

- The repository declares Node >= 20 and CI runs Node 22; bundling the line
  CI already tests keeps the proof honest.
- `better-sqlite3` 11.10.0 (the lockfile version) ships prebuilds for ABI
  115 (Node 20) and 127 (Node 22) and has **none** for ABI 137 or 141
  (Node 24 and 25); the download returns 404. Node 24 is therefore not an
  option until `better-sqlite3` is upgraded, and the upgrade is a runtime
  change outside this proof.
- Node 20 is end-of-life; Node 22 is in maintenance LTS and its end of life
  is expected around April 2027 (verify before the release phase). The pin
  must be revisited with the first release cut and again before that date.
- The pin file records the SHA-256 of all five archives, copied from the
  `SHASUMS256.txt` published beside the downloads. The GPG signature of
  that file was **not** verified; a stronger release build should verify it.

## Native dependency inventory

Versions are the lockfile versions at the time of the audit
(`package-lock.json`). "Prebuild source" is where `npm ci` obtains the
binary; the audit asset URLs are in
`327-n1-upstream-binary-audit.json` (attached to the issue) and are
regenerated with `node scripts/package-audit-upstream.js`.

| Module | Version | How it loads natives | Prebuild source | ABI binding | Licence |
|---|---|---|---|---|---|
| `better-sqlite3` | 11.10.0 | `prebuild-install` runs at install | GitHub release asset `better-sqlite3-v11.10.0-node-v127-<platform>-<arch>.tar.gz` (not npm) | **Node ABI specific** (127) | MIT |
| `sqlite-vec` | 0.1.9 | optional npm platform package (`sqlite-vec-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`, `-windows-x64`) | npm (integrity checked by npm) | plain SQLite extension, not tied to Node ABI | MIT OR Apache-2.0 |
| `sharp` | 0.32.6 | `prebuild-install` for the addon, plus a download of the libvips bundle at install | GitHub release assets `sharp-v0.32.6-napi-v7-*` and `sharp-libvips` 8.14.5 (not npm) | Node-API v7 (any Node 22) | Apache-2.0; libvips and its dependencies LGPL-3.0 and others, see below |
| `sodium-native` | 4.3.1 | prebuilds inside the package, found by `node-gyp-build` | npm tarball (all platforms inside; the build keeps one) | Node-API | MIT |
| `@napi-rs/canvas` | 0.1.80 | optional npm platform package (`-linux-x64-gnu`, `-linux-arm64-gnu`, `-darwin-*`, `-win32-x64-msvc`) | npm | Node-API | MIT |
| `@snazzah/davey` | 0.1.12 | optional npm platform package (same naming) | npm | Node-API | MIT |
| `libsodium-wrappers`, `opusscript` | - | WebAssembly, no native binary | npm | none | ISC, MIT |
| `pdf-parse` / `pdfjs-dist` | - | JavaScript | npm | none | Apache-2.0 |

Packaging consequences:

- Two modules (`better-sqlite3`, `sharp`) download from **GitHub release
  assets at install time**, not from npm. The payload build therefore needs
  network access to `github.com` and has no npm integrity record for those
  two assets. The audit reports `integrityChecked: false` for them. Before
  release, the build should pin and verify their checksums or mirror them.
- `sharp` 0.32.6 is the version that downloads libvips at install. Later
  versions ship it as npm packages, which would be integrity-checked.
- `sqlite-vec`, `@napi-rs/canvas` and `@snazzah/davey` select the right
  package through npm `optionalDependencies`. `npm ci` on the target host
  installs the matching one; a payload built on one OS can **not** be
  reused for another, which is why the build is host-only and CI builds
  per target.
- `-musl` variants of the optional packages are pruned on glibc Linux.

## Matrix: OS, architecture and ABI

All five targets have an upstream asset for every module at the pinned ABI.
The "minimum" columns are what the headers of the *prebuilt binaries*
declare (static analysis of the exact assets, by
`scripts/lib/nativeBinaryInfo.js`). They are necessary conditions, not a
guarantee: a binary can also fail at run time for a reason no header
shows.

| Target | Node asset | Highest glibc symbol needed | Highest GLIBCXX | macOS `minos` | Windows imports of note |
|---|---|---|---|---|---|
| linux-x64 | `node-v22.23.3-linux-x64.tar.gz` | 2.29 (`better-sqlite3`) | 3.4.21 (node) | - | - |
| linux-arm64 | `node-v22.23.3-linux-arm64.tar.gz` | **2.33 (`sodium-native`)** | 3.4.21 (node) | - | - |
| darwin-x64 | `node-v22.23.3-darwin-x64.tar.gz` | - | - | **15.0 (`sqlite-vec`)**, node 11.0, sodium 11.0, others 10.7 to 10.13 | - |
| darwin-arm64 | `node-v22.23.3-darwin-arm64.tar.gz` | - | - | **14.0 (`sqlite-vec`)**, everything else 11.0 | - |
| win32-x64 | `node-v22.23.3-win-x64.zip` | - | - | - | `sodium-native` imports `vcruntime140.dll`; UCRT (`api-ms-win-crt-*`) for `sharp`'s libvips and `sodium-native` |

Detail for the Linux baselines (read from the binaries):

| Binary | glibc | GLIBCXX | CXXABI |
|---|---|---|---|
| `node` (runtime, x64 and arm64) | 2.28 | 3.4.21 | - |
| `better_sqlite3.node` (x64 and arm64) | 2.29 | 3.4.20 | 1.3.9 |
| `sharp-linux-*.node` and `libvips-cpp.so.42` | 2.17 | 3.4.18 | - |
| `vec0.so`, `@napi-rs/canvas`, `@snazzah/davey` | 2.14 to 2.17 | - | - |
| `sodium-native.node` linux-x64 | 2.14 | - | - |
| `sodium-native.node` linux-arm64 | **2.33** | - | - |

## Runtime library needs

Linux (glibc only):

- **x64 floor: glibc 2.29**, set by `better-sqlite3`. That admits Debian 11
  and 12, Ubuntu 20.04 and later, Fedora, and RHEL-family 9 and later. It
  **excludes** RHEL, Alma and Rocky 8 (glibc 2.28) and Ubuntu 18.04.
- **arm64 floor: glibc 2.33**, set by the `sodium-native` arm64 prebuild.
  That admits Debian 12 (Bookworm, including Raspberry Pi OS Bookworm
  64-bit) and Ubuntu 22.04 and later, and **excludes Debian 11 Bullseye
  (glibc 2.31) and Ubuntu 20.04**, which are still common on Raspberry
  Pi 4B installs. See B2.
- Alpine and other musl systems are unsupported (the build prunes the musl
  variants and the Node asset is the glibc build). 32-bit ARM (Raspberry Pi
  OS 32-bit) is unsupported: there is no Node 22 `linux-armv7l` entry in
  the pin and the natives have no armv7 prebuilds in this lockfile.
- No system package is needed at run time: libvips ships inside the sharp
  vendor directory; SQLite is compiled into `better-sqlite3`; FFmpeg is not
  part of this payload (it belongs to the Voice feature in #328).

macOS:

- The binaries declare minimum versions between 10.7 and 15.0, but the
  Node 22 build itself requires **macOS 11 (Big Sur)** or later, and that
  is the practical floor except for sqlite-vec (B3).
- No Homebrew or other library is required: libvips and its dependencies
  are inside the sharp vendor directory and the other natives link only
  against system libraries.

Windows:

- Windows 10 or later, x64 (Node 22's own floor; the exact build number
  was not checked). ARM64 Windows is not a target of this proof.
- `sodium-native`'s Windows binary imports `vcruntime140.dll`, so the
  **Microsoft Visual C++ 2015 to 2022 x64 redistributable** must be present
  on a clean machine, or the installer must carry it (B4). The other
  natives import only the Universal C Runtime and OS DLLs.
- GitHub-hosted Windows runners already have the redistributable, so CI
  cannot prove that a clean machine works. That is a manual check or a
  clean-VM check (below).

## Local proof (Linux x64)

Environment: the Cloud Agent VM, Ubuntu 24.04, glibc 2.39, host Node
v22.14.0 (used only to run the build; the smoke run uses the bundled
22.23.3). Commands, from the repository root:

```bash
npm ci
npm run build:web
node scripts/package-runtime.js --target linux-x64 --force
dist/payload/linux-x64/runtime/bin/node \
    dist/payload/linux-x64/app/scripts/package-smoke.js \
    --report dist/reports/package-smoke-linux-x64.json
```

Results:

- Build: about 6 seconds with a warm Node download cache; payload
  334 MB (Node runtime 125 MB, `node_modules` 193 MB, web client 14 MB,
  documentation 1.6 MB), 11,174 files, **0 symlinks**, 8 native binaries.
  The log shows the two prebuilt downloads
  (`better-sqlite3-v11.10.0-node-v127-linux-x64.tar.gz`,
  `sharp-v0.32.6-napi-v7-linux-x64.tar.gz`) and **0 lines of compiler
  output**.
- Independent checks on the finished payload: no `config.json`, `.env*`,
  `*.sqlite`, `*.db`, `data/`, `logs/`, `cache/`, `tests/`, `e2e/` or
  `.git`; no `build/Makefile`, `config.gypi` or object directories; no
  `node` on the smoke run's `PATH` (`/usr/bin:/bin`).
- Smoke: 18 checks passed, 0 failed, 0 skipped, 1 known gap (B1). SQLite
  3.49.2 in WAL mode, sqlite-vec v0.1.9 answered a vec0 nearest-neighbour
  query, sharp 0.32.6 with libvips 8.14.5, the standalone API reported
  `healthy`, `standalone`, `discord: disabled`, stopped on SIGTERM with exit
  code 0 in under 50 ms and released its port, both directly and through
  `bin/goobster-api`. The payload manifest verified again after the run.
- Relocation: the same payload copied to `/tmp/Goobster däta é/` (spaces and
  non-ASCII), with the instance directory also in such a path, gives the same
  result.
- Read-only data directory: the run stops at `paths.dataDirWritable` with a
  message naming the directory and the fix, and the dependent checks are
  skipped rather than reported as separate failures.

The reports are attached to the issue as
`327-linux-x64-package-smoke.json`, `327-linux-x64-package-build.log`,
`327-linux-x64-package-build-report.json`,
`327-linux-x64-package-smoke-relocated.json`,
`327-linux-x64-package-smoke-read-only-data.json`,
`327-linux-x64-payload-verification.txt` and
`327-n1-upstream-binary-audit.json`.

Not exercised locally: any other OS or architecture, any older glibc
(the VM has only 2.39; the container jobs below cover it), a clean
machine without build tools, and Raspberry Pi hardware.

## CI recipe

`.github/workflows/packaging-proof.yml` runs on `workflow_dispatch` and on
pull requests that touch the packaging scripts, the workflow, the
manifests or the database layer. It does not run on ordinary pushes and
does not publish anything.

Matrix, one job per target on a runner of that target:

| Target | Runner | Notes |
|---|---|---|
| linux-x64 | `ubuntu-24.04` | also the distro container checks below |
| linux-arm64 | `ubuntu-24.04-arm` | optional input `linux_arm64`; GitHub-hosted arm64 runners are free for public repositories and need an arm64 runner plan for private ones, and `gh` could not tell us which this repository is (it returned HTTP 401), so availability is **unknown** |
| win32-x64 | `windows-2022` | |
| darwin-x64 | `macos-15-intel` | `macos-13`, the old Intel label, is retired; `macos-15-intel` is the only Intel macOS runner and is expected to be the last, so this target may need a new home (self-hosted Intel Mac, or an arm64 build under Rosetta, which is *not* equivalent evidence) |
| darwin-arm64 | `macos-15` | `macos-14` is deprecated |

Each job: check out, set up Node 22 (to run the *build* only), `npm ci`,
`npm run build:web`, build the payload, check for symlinks and
configuration files independently of the script, then run the smoke script
**in place with the bundled Node and a restricted `PATH`**, then again from
a relocated copy in a path with spaces and non-ASCII characters, then (POSIX)
the read-only-data negative control. Reports, the build log and the payload
manifest are uploaded as artifacts. Nothing echoes `secrets.*`; the
workflow uses no secrets.

Additional jobs on linux-x64 run the payload's smoke inside distro
containers with no Node installed, to check the glibc baselines
empirically:

- required: Debian 11 (bullseye-slim), Debian 12 (bookworm-slim), Ubuntu
  20.04, Ubuntu 24.04, AlmaLinux 9;
- expected to fail and **allowed** to: AlmaLinux 8 (glibc 2.28) and Alpine
  3.20 (musl). These document the floor; a surprise pass would be a
  finding too.

macOS and Windows jobs also print `codesign` / `spctl` and Authenticode
information as informational steps. They do not gate, because nothing is
signed yet.

What CI **cannot** show, and must be checked by other means before a
release: a clean Windows machine without the VC++ redistributable;
Gatekeeper and SmartScreen behaviour (a payload built in place on a runner
has no quarantine flag or Mark-of-the-Web, so neither check fires); older
macOS than the runner; Raspberry Pi hardware and Raspberry Pi OS; read-only
and ACL behaviour on Windows; antivirus interference.

## Findings

These are release-blocker candidates or decisions for the coordinator. None
was fixed in the packaging proof except where stated; the proof changes no
application runtime code.

### B1

**Core configuration modules ignore `GOOBSTER_CONFIG_PATH`.** The
relocatable-roots design needs `config.json` in a configuration root outside
the read-only code root. `packages/core/runtimePaths.js` resolves that path,
but 37 call sites load `config.json` with a hard-coded relative
`require('../../../config.json')` (24 in `packages/core`, of which 13 are
the `packages/core/config/*.js` modules, and 13 in `apps/bot`). The
consequence, shown by the smoke probe: a `config.json` placed in the
configuration root is ignored by those modules, so for example a Discord
token there leaves `discordConfig.enabled` false; and
`serviceManager.js` throws `MODULE_NOT_FOUND` when loaded in a payload that
has no `config.json` next to the code. It is not a tiny fix, because
tests mock the file with `jest.doMock('../config.json')`, so replacing the
`require` changes how those tests inject configuration. Recommendation: a
shared loader in `runtimePaths` used by all 37 sites, delivered with the
configuration-root work (P2.2, #324) or as its own prerequisite issue, with
the smoke check `config.relocatable` turned from `known-gap` into `pass`.
The smoke script reports this as `known-gap`, not as a pass, and the
verdict stays `PASS_WITH_KNOWN_GAPS` until it is closed.

### B2

**glibc baselines: x64 2.29, arm64 2.33.** The `sodium-native` linux-arm64
prebuild needs glibc 2.33, so an arm64 install on Raspberry Pi OS Bullseye
(glibc 2.31) or Ubuntu 20.04 fails to load `sodium-native`. Today's Pi installs
(`scripts/install-rpi.sh`) are not bound by this because they install on
the machine itself; the bundled payload is. Decision
needed: state Debian 12 / Raspberry Pi OS Bookworm 64-bit and Ubuntu 22.04
as the arm64 floor, or rebuild `sodium-native` on an older glibc. On x64,
RHEL-family 8 is excluded by `better-sqlite3`. musl and 32-bit ARM are out
of scope. The container jobs measure these on x64; arm64 containers are
not in the matrix, so the arm64 floor is **unverified** beyond the header
analysis.

### B3

**sqlite-vec macOS minimum.** The `sqlite-vec` dylib declares `minos` 15.0
on x64 and 14.0 on arm64, higher than Node's own 11.0 and than the other
natives. On an older macOS, extension load may fail and memory recall falls
back to the brute-force scan (functional, slower, and the smoke check
treats that as a failure). Whether `dlopen` actually refuses on macOS 11 to
13 was **not verified**. Decision: rebuild the extension with a lower
deployment target, raise the stated macOS floor, or accept the fallback and
say so.

### B4

**Windows needs the VC++ 2015 to 2022 x64 redistributable** for
`sodium-native` (`vcruntime140.dll`). The bootstrapper should carry or
check for it, and the release smoke should run on a clean VM without it.
Hosted runners cannot prove this.

### B5

**Licences.** The payload manifest lists every dependency licence.
Findings, not legal advice:

- `play-dl` (1.9.7) and `play-audio` (0.5.2) are **GPL-3.0** and are
  declared in `package.json` but referenced by no source file, so they can
  be removed from the manifests instead of redistributed. They ship in the
  payload today because they are production dependencies.
- libvips and the libraries sharp bundles with it are LGPL-3.0 and similar.
  They are shipped as separate shared libraries in `sharp/vendor`, which
  keeps them replaceable; sharp's own `THIRD-PARTY-NOTICES.md` is shipped in
  the payload and the installer must preserve it and the attributions.
- `sqlite-vec` is dual licensed (npm reports `MIT OR Apache`), `rc` and
  `expand-template` offer MIT as one option, Node itself ships its
  `LICENSE`, which the payload carries in `runtime/`.
- A third-party-notices file for the whole payload should be generated from
  the manifest at release time.

### B6

**`discord.js` is loaded by the "no-Discord" path.** The portal application
code (`packages/core/web/appApi.js` and its imports) still requires
`discord.js`, so the standalone payload ships it and its dependency tree
even though no Discord connection is made. It matters for #328 (selective
packaging): excluding the Discord adapter needs that import made lazy, or
`discord.js` stays in the base payload.

### Other observations

- Root `package.json` `dependencies` include development tooling; the
  payload builds from the `@goobster/core` and `@goobster/api` workspaces,
  so these are not shipped, but it widens what a future "install the root"
  path would pull.
- When the database cannot be opened the error does not name the path,
  which is the first thing an operator needs; a one-line improvement for
  the manager's recovery screen (P2).
- Windows has no graceful signal to a child, so a service wrapper (#331)
  needs an explicit control channel (stdin message or a named pipe), which
  the smoke script already imitates.
- A payload built in place has no quarantine attribute or Mark-of-the-Web;
  the SmartScreen and Gatekeeper behaviour of a *downloaded* payload is not
  covered.
- macOS hardened runtime refuses to load third-party native libraries
  unless the app has the `com.apple.security.cs.disable-library-validation`
  entitlement or every `.node` and `.dylib` is signed with the same team
  identity; the signing step must handle all 8 or more native files, not
  only the launcher.
- Raspberry Pi 4B hardware is unverified. The `linux-arm64` CI job runs on
  a server-class arm64 CPU with a recent distribution, which says nothing
  about memory use or the Pi's SD card write behaviour.
- The SHA-256 pins for Node were copied from `SHASUMS256.txt`; the GPG
  signature of that file was not verified.

## Signing and notarization

Nothing in the proof is signed. The requirements below are for the release
phase (installer plan Phase 5 and the bootstrapper work in Phase 3 item 5),
and certificates remain an open dependency (ADR 0013, owner decision
tracked in #262; no certificate was bought or requested here).

- **Windows.** An unsigned `.exe`, `.msi` or NSIS installer triggers
  Microsoft Defender SmartScreen ("Windows protected your PC"). An
  Authenticode certificate removes the "unknown publisher" text; an
  EV certificate (or a cloud signing service such as Azure Trusted Signing)
  gives immediate reputation, and a standard certificate builds it up with
  downloads. The installer, `runtime\bin\node.exe` (already signed by the
  Node project) and the launcher should be signed; native `.node` addons
  need not be but can be. Files downloaded from the internet carry the
  Mark-of-the-Web, which a Zip extraction may or may not propagate.
- **macOS.** Gatekeeper requires a Developer ID Application certificate and
  **notarization** for anything downloaded and opened; unsigned or
  un-notarized builds show "cannot be opened because the developer cannot
  be verified" and, on current macOS, cannot be opened by double-click at all
  without an explicit user override. The pkg needs a Developer ID Installer
  certificate. The hardened runtime is required for notarization; see the
  entitlement note under the findings. `spctl --assess` and `codesign
  --verify --deep` are the checks to add once there is something signed.
- **Linux.** No platform gate. Publish SHA-256 sums, and a detached
  signature for the script and AppImage.
- Unsigned builds are marked as such in the release notes (Phase 3
  acceptance).

## Reproducing and extending the proof

- Rebuild and smoke for the host: the three commands under "Local proof".
- Audit upstream assets for all five targets without executing them:
  `node scripts/package-audit-upstream.js --out audit.json`.
- Unit-tested rules (payload content rules, binary targets, install-log
  analysis, ELF, Mach-O and PE readers):
  `npx jest tests/packagePayloadRules.test.js`.
- To change the Node pin, edit `scripts/package-node-pins.json` with the
  new version and the five SHA-256 values from the published
  `SHASUMS256.txt`, re-run the audit, and re-run the CI matrix.
- When a new native dependency enters `package.json`, add it to the
  inventory above, to the smoke script's native checks and to the audit
  script's module list in the same change.
