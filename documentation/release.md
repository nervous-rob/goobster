---
title: Releasing Goobster - the signed release pipeline, the release index and how artifacts are verified (installer P5.1)
kind: reference
summary: How a Goobster release is built, signed, verified and published - the release workflow (v* tags and manual dispatch, never a pull request), the five targets and their runner images, the stable and prerelease channels and how a tag picks one, the release index (release-index.json, version 1) and its detached Ed25519 signature, every verification code, the production and development trust policies and what each accepts, the trusted key list (scripts/release-keys.json - active, retired, revoked) and how a compromised key is recovered from, platform signing (Authenticode for the Windows installer, Developer ID and notarization for the macOS package), the secrets the owner must supply and which role owns each certificate, the artifact hygiene scan, the release checklist, reproducibility (inputs recorded, not byte-identical output), dependency redistribution notices, the platform support statement, and what is not done (no key or certificate exists yet, no download or update code, no public store listing).
when: Cutting a release or a prerelease; deciding whether a downloaded artifact can be trusted; adding or rotating the release signing key; supplying the Windows or Apple signing certificates; investigating why a stable tag was blocked or an artifact was refused; reading the release index; recovering from a compromised signing key; writing release notes or a support statement.
tags: [release, signing, release-index, verification, channels, authenticode, notarization, ed25519, key-rotation, github-actions, installer, supply-chain]
---

# Releasing Goobster

Installer Phase 5 item P5.1 (issue #341, epic #315, ADR 0013). Everything before
this built **unsigned development artifacts** (`-dev`, labelled
`UNSIGNED DEVELOPMENT BUILD`). This is the pipeline that produces the real ones
and the contract an installer uses to decide whether to believe an artifact.

**State today.** The pipeline, the index format, the verifier and the policies
exist and are tested. **No production key and no platform certificate exists.**
`scripts/release-keys.json` ships with no keys, so a stable tag stops in the
first job with `RELEASE_BLOCKED_UNSIGNED`. Prereleases and manual runs build,
publish and say plainly that they are unsigned development builds. Nothing in
this repository signs anything with a key it holds; certificates are the
owner's to supply (see "Certificates and who owns them").

## Two layers of verification

| Layer | What is signed | By | Checked by |
| --- | --- | --- | --- |
| 1. The payload | `payload-manifest.json` (every file's SHA-256), detached `payload-manifest.sig` | the release key (Ed25519) | `verifyPayload` in `scripts/lib/payloadStage.js` ([packaging.md](packaging.md)), on every install, repair and update |
| 2. The release | `release-index.json` (every artifact's SHA-256, size, target and signing state), detached `release-index.sig` | the same key | `verifyIndex` in `scripts/lib/releaseIndex.js`, before an installer trusts a download |

Both use the same canonical-bytes rule and the same key id (the first 16 hex
characters of the SHA-256 of the SPKI DER of the public key). The payload layer
is unchanged by this issue: the version-1 manifest fields and `verifyPayload`'s
codes are exactly as documented in [packaging.md](packaging.md). The index is the
new layer: it covers what the payload manifest cannot, namely the bootstrapper
artifacts around a payload (`.run`, AppImage, `.pkg`, `.exe`, the tarball) and
the release as a whole (channel, minimum upgrade version, Node ABI).

Platform signatures are a third thing: Authenticode on the Windows installer and
Developer ID plus notarization on the macOS package satisfy the operating
system, not Goobster's verifier. The index records whether they were done and
verified (`signing.method`).

## Targets and runners

| Target | Runner image | Artifacts | Platform signing |
| --- | --- | --- | --- |
| `linux-x64` | `ubuntu-24.04` | `.run`, AppImage, payload archive | none (Ed25519 only) |
| `linux-arm64` | `ubuntu-24.04-arm` (dispatch can opt out) | `.run`, AppImage, payload archive | none |
| `win32-x64` | `windows-2022` | NSIS `.exe`, payload archive | Authenticode (`signtool`, RFC 3161 timestamp) |
| `darwin-arm64` | `macos-15` | `.pkg`, per-user `.tar.gz`, payload archive | Developer ID Installer, `notarytool`, `stapler` |
| `darwin-x64` | `macos-15-intel` | `.pkg`, per-user `.tar.gz`, payload archive | Developer ID Installer, `notarytool`, `stapler` |

The target id is `win32-x64` (Node's platform and arch), not `win-x64`. Every
release also carries `dependency-inventory-<target>.json` (every dependency's name, version,
licence, exclusivity and owning features, with the licence totals and the non-permissive
licences, read from that target's payload manifest), `release-index.json`, `release-index.sig` (when signed), `SHA256SUMS`.
Linux has no platform gate: the `.run` and AppImage rely on the Ed25519
signatures and the published sums.

## The release workflow

`.github/workflows/release.yml`. It runs for a `v*` tag push and a manual
dispatch. It **never** runs for a pull request (it holds signing material and a
write token), and a test (`tests/releaseWorkflow.test.js`) fails if the file
ever names a pull-request event. The default token is read-only; only the
`publish` job has `contents: write`.

1. **plan** (environment `release`). `node scripts/release-index.js plan`
   derives the channel from the tag, checks the tag's version against
   `packages/core` and `apps/manager`, and decides the signing mode:
   `release` (an active key from `scripts/release-keys.json` is available),
   `dev` (no key; prerelease only) or `blocked` (stable with no active key: the
   job exits with `RELEASE_BLOCKED_UNSIGNED` and nothing is built). It also
   writes the target matrix.
2. **build**, one job per target, `fail-fast: false`. Builds the web client,
   builds the payload (signed with the release key in `release` mode, with a
   throwaway development key in `dev` mode), verifies it, runs the in-payload
   smoke check with only the bundled Node, builds the bootstrappers, runs the
   secret-gated platform signing, writes one index entry per artifact, packs the
   payload archive and the dependency inventory, runs the hygiene scan with
   `--strict`, and uploads. A throwaway development key is never passed to the
   bootstrapper builds as trusted, so a development release cannot label itself
   signed.
3. **publish** (environment `release`, the only write token). Downloads whatever
   the targets uploaded, assembles the index, signs it (`release` mode),
   verifies the release under both policies, scans everything once more, writes
   `SHA256SUMS` and the release notes, and creates the GitHub Release (or edits
   and uploads to it on a re-run). A target that failed uploaded nothing and is
   **absent from the index and the release**; the notes name it
   (`PARTIAL RELEASE`). A stable release also **withdraws any target whose
   artifacts are not all `signed`**: a missing Windows or Apple certificate
   holds back that target, never the others.

The signing key is written to a `0600` file inside a `0700` directory under the
runner's temp area, used by the one step that needs it, and deleted by an
`always()` step. Secrets reach a step only through its `env`. Nothing in the
workflow prints the environment or enables shell tracing, and the keychain
password the macOS step derives is masked. A dispatch from a branch that is
neither protected nor a tag cannot read the signing key at all; it builds a
development release. The `release` environment should also restrict which refs
can deploy to it and may require a reviewer.

**What was and was not executed.** The `plan` logic, the index, the verifier, the
artifact scan and the publish-stage shell steps were run on Linux x64 against a
real payload (the transcript is described under "How this was verified"). The
**Windows and macOS signing steps, and the arm64, macOS and Windows jobs, were
not executed by the author**: they need real certificates and the hosted runners.
They follow the documented behaviour of `signtool`, `productsign`,
`xcrun notarytool`, `stapler`, `security` and `Import-PfxCertificate`, and they
are structurally tested (syntax, secrets handling, ordering) but not run.

## Channels and tags

| Tag | Channel | Notes |
| --- | --- | --- |
| `v1.4.0` | `stable` | The version must equal `packages/core` and `apps/manager`. Needs an active key. |
| `v1.4.0-rc.1`, `-beta.2`, `-alpha.3` | `prerelease` | Same version check. Allowed without a key (development build). |
| manual dispatch | `prerelease` | Tagged `v<core>-dev.<run number>`. Always a prerelease, whatever the branch. |
| anything else (`v1.4.0-final`, `1.4.0`) | refused | `TAG_INVALID`, so a typo can never publish to the stable channel. |

A GitHub Release is `latest` only on the stable channel. Prerelease versions
order before their release (`1.4.0-rc.1 < 1.4.0`), which the downgrade check
uses.

## The release index (version 1)

`release-index.json`, canonical JSON (sorted keys), written beside the
artifacts. Artifact names are **bare file names** (no directory part); a
release is a flat directory.

```json
{
  "version": 1,
  "release": {
    "core": "1.4.0", "manager": "1.4.0", "channel": "stable", "tag": "v1.4.0",
    "sourceRevision": "<git sha>", "lockfileSha256": "<sha256 of package-lock.json>",
    "builtAt": "2026-10-01T00:00:00Z"
  },
  "node": { "version": "22.23.3", "abi": "127" },
  "compatibility": { "minUpgradeFrom": "1.0.0", "compatibleCore": ">=1.4.0 <2.0.0" },
  "artifacts": [
    {
      "target": "linux-x64", "kind": "bootstrap",
      "file": "goobster-1.4.0-linux-x64.run", "sha256": "<hex>", "size": 87419384,
      "signing": { "status": "signed", "method": "ed25519-only", "identity": "<key id>" },
      "payloadKeyId": "<key id>"
    }
  ],
  "provenance": { "nodePin": {}, "tools": {}, "build": { "repository": "", "runId": "", "runAttempt": "", "workflow": "" } },
  "inventories": [{ "target": "linux-x64", "file": "dependency-inventory-linux-x64.json", "sha256": "<hex>" }],
  "signing": { "algorithm": "ed25519", "keyId": "<key id>" }
}
```

- `kind` is `bootstrap` (the `.run`), `payload` (the payload archive),
  `appimage`, `pkg`, `tarball`, `exe` or `msi`. Artifacts sort by target, kind, file.
- `signing.status` is `signed` or `unsigned-dev`. A `signed` artifact has a
  `method`: `ed25519-only` (Linux, and every payload archive), `authenticode`
  (the Windows installer) or `apple-notarized` (the macOS package), and an
  `identity` that is a key id, a certificate thumbprint or an Apple team id.
  An `unsigned-dev` artifact has a `reason`: `DEV_PAYLOAD` (the payload inside is
  not signed by a real key), `NO_AUTHENTICODE` or `NOT_NOTARIZED`.
- An artifact is `signed` only when its payload is signed by a real key **and**,
  where the platform asks for it, the platform signature was done and checked
  (`Get-AuthenticodeSignature` is `Valid` with a timestamp; `pkgutil
  --check-signature`, `stapler validate` and `spctl --assess` pass).
- `provenance` records the Node pin (version, line, checksum source) and the
  checksums of the pinned build tools, plus the workflow run that built it.
  `signing` is part of the signed bytes; `release-index.sig` is the base64
  signature over the canonical bytes.
- Nothing in an index may be a secret: a PEM private key, certificate or public
  key block anywhere in any string makes the index invalid (`INDEX_INVALID`).

### Codes

`scripts/release-index.js` and `verifyIndex` refuse with exactly these codes. The
manager maps them one to one onto a `ManagerError` (HTTP 409).

| Code | Meaning |
| --- | --- |
| `INDEX_INVALID` | Missing, not JSON, wrong version, or fails the schema (a bad target, kind, digest, name, or a key block in a string). |
| `INDEX_UNSIGNED` | No `release-index.sig` and the policy is production. |
| `INDEX_BAD_SIGNATURE` | The signature does not match the index, is not base64, or the index names no signing key. Refused under **both** policies when a trusted key is supplied. |
| `UNTRUSTED_KEY` | Signed by a key that is not trusted, is revoked, or production was given no trusted key at all. A revoked key is refused under both policies. |
| `ARTIFACT_UNSIGNED` | Production policy and an in-scope artifact is `unsigned-dev`. |
| `TARGET_MISMATCH` | The release has no artifact for the expected target. |
| `ABI_MISMATCH` | The release's Node ABI is not the one expected. |
| `DOWNGRADE` | The release is older than the installed version and no explicit allow was given. |
| `VERSION_INCOMPATIBLE` | The installed version is older than `compatibility.minUpgradeFrom`. |
| `ARTIFACT_DIGEST_MISMATCH` | A file beside the index differs from the recorded size or SHA-256 (also what `build` raises if an artifact changed after its entry was written). |
| `ARTIFACT_MISSING` | A required in-scope file is not beside the index. |
| `KEY_LIST_INVALID` | `release-keys.json` is not a valid version-1 list (including a private key block, a duplicate key id, a key id that is not the id of its key, or a non-Ed25519 key). |
| `TAG_INVALID` | The tag is not a release tag, or its version is not the repository's. |
| `BAD_OPTION` | A caller option was malformed (an unknown policy, a trusted key that is not Ed25519, a bad version). |

Verification order: signature, shape, target, ABI, version policy, artifact
signing state, artifact digests. `plan` exits 2 with `RELEASE_BLOCKED_UNSIGNED`
(a workflow code, not an index code) for a stable run with no active key.

## Trust policies

`node scripts/release-index.js verify <dir> [--policy production|development]`
(default production). The manager picks the policy for an install from the
install input and the environment: `production` unless the input says
`allowUnsigned: true`, or `GOOBSTER_PAYLOAD_DEV_UNSIGNED=1` is set and the input
does not say `allowUnsigned: false` (an explicit false wins).

| Index signature | Artifacts | Production | Development |
| --- | --- | --- | --- |
| absent | any | `INDEX_UNSIGNED` | accepted, `signed: false`, labelled `UNSIGNED DEVELOPMENT BUILD` |
| present, no trusted key supplied | any | `UNTRUSTED_KEY` | accepted unverified, labelled `UNSIGNED DEVELOPMENT BUILD` |
| present, key trusted, valid | all `signed` | accepted, `signed: true` | accepted, `signed: true` |
| present, key trusted, valid | some `unsigned-dev` | `ARTIFACT_UNSIGNED` | accepted, labelled `UNSIGNED DEVELOPMENT BUILD` |
| present, key trusted, does not verify | any | `INDEX_BAD_SIGNATURE` | `INDEX_BAD_SIGNATURE` |
| present, key not among the trusted keys | any | `UNTRUSTED_KEY` | `UNTRUSTED_KEY` |
| present, key revoked in the key list | any | `UNTRUSTED_KEY` | `UNTRUSTED_KEY` |

Development mode is for builds you made yourself. It never turns a failed
signature into a pass, and it always says what it accepted: the result carries
`devMode: true` and the label, and the installed record shows `signed: false`.

Trusted keys come from the caller (`--public-key`, the install's
`release.publicKeyFiles`, `GOOBSTER_RELEASE_PUBLIC_KEY_FILE`) and from the key
list. `verify` reads the repository's `scripts/release-keys.json` unless told not
to (`--no-key-list`). The installed payload ships the index verifier, so an installed
manager checks an index it downloaded (`documentation/manager_update.md`).

### The installed record

`GET /manager/api/install/record` now returns `release.signed`,
`release.keyId` and `release.channel`, read from the installed payload's own
manifest and signature file (`signed` means a signature is present, not that it
verified: install and repair verify). They are `null` when there is no readable
manifest. The channel comes from the core version (a prerelease suffix is the
prerelease channel); the index is the authority.

## The trusted key list

`scripts/release-keys.json`:

```json
{ "version": 1, "keys": [
  { "keyId": "<16 hex>", "publicKeyPem": "-----BEGIN PUBLIC KEY-----...", "status": "active", "since": "2026-10-01", "note": "..." }
] }
```

| Status | May sign a new release | Verifies old releases it signed |
| --- | --- | --- |
| `active` | yes | yes |
| `retired` | no | yes |
| `revoked` | no | no (refused everywhere) |

Only **public** keys belong in this file; a private key block makes the list
invalid and a test fails the build. The file ships with `"keys": []`: there is no
active key in this repository, and none may be added except by the owner.
Ed25519 keys have no expiry; custody and rotation are the control.

### Creating the key (owner)

```bash
node scripts/package-sign.js --gen-dev-key <dir outside the repository>   # prints the key id
```

Despite its name this writes an ordinary Ed25519 pair. For a production key,
generate it on a machine you trust, keep the private PEM in a password manager or
hardware-backed store, copy the **public** PEM into `scripts/release-keys.json`
as an `active` entry in a pull request, and store the **private** PEM as the
`GOOBSTER_RELEASE_SIGNING_KEY_PEM` secret of the `release` environment. The plan
job refuses a signing secret whose key id is not an `active` entry in the file
committed at the tag.

### Rotation and recovery

- **Planned rotation.** Add the new key as `active`, change the old one to
  `retired`, rotate the secret, and cut a release. Old releases keep verifying.
- **Compromised or leaked key.** Mark it `revoked` in `release-keys.json` and
  ship that file. Cut a **new** key, make it `active`, and **re-sign the current
  release** (rebuild and publish; releases signed only by the revoked key must
  be treated as untrusted). Publish an advisory naming the key id and the
  releases it signed. A manager that has the updated key list refuses the
  revoked key at its next verification; **nothing uninstalls an installation
  automatically**, and an already installed payload keeps running.
- **Lost key.** Not recoverable as a signer: retire it, create a new one, as
  above. Old releases still verify while the retired key stays in the list.
- If a key list is itself tampered with, `KEY_LIST_INVALID` or the repository's
  history shows it; the list is only trusted at the commit a release is built from.

## Certificates and who owns them

Certificates are the owner's to buy and renew; nothing here buys or requests one.
Owner decision tracked in #262.

| Material | Used for | Secret(s) in the `release` environment | Role that holds it |
| --- | --- | --- | --- |
| Release signing key (Ed25519) | Payload manifests and the release index | `GOOBSTER_RELEASE_SIGNING_KEY_PEM` | Release owner |
| Authenticode certificate (OV or EV; an Azure Trusted Signing setup would need a different step) | The Windows installer | `WINDOWS_SIGNING_CERT_PFX_BASE64`, `WINDOWS_SIGNING_CERT_PASSWORD` | Release owner / Windows publisher identity |
| Developer ID Installer certificate | The macOS `.pkg` | `APPLE_DEVELOPER_ID_INSTALLER_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_TEAM_ID` | Apple developer account holder |
| App Store Connect API key | Notarization | `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`, `APPLE_NOTARY_KEY_P8_BASE64` | Apple developer account holder |
| Developer ID Application certificate | Signs the payload's Mach-O runtime and addons before manifest hashing | `APPLE_DEVELOPER_ID_APPLICATION_CERT_P12_BASE64` | Apple developer account holder |

Every secret is optional. A missing one turns its step off with a warning; the
artifact is then `unsigned-dev` (`NO_AUTHENTICODE` or `NOT_NOTARIZED`), and a
stable release withdraws that target. Optional repository variables:
`WINDOWS_TIMESTAMP_URL` (default `https://timestamp.digicert.com`; the installer
build requires an https URL) and `RELEASE_MIN_UPGRADE_FROM` (the oldest version
the release upgrades; default `0.0.0`).

**Renewal.** Code-signing certificates are typically valid for one to three
years, Developer ID certificates for five. The build checks the certificate it
imports: it warns when fewer than 60 days remain and stops when it has expired.
Put the renewal date in the owner's calendar rather than relying on a failed
release; a renewed certificate is a new secret value, with no change to the
repository. After renewal, run a dispatch build and check that the Windows
installer shows the new publisher and `Get-AuthenticodeSignature` is `Valid`.

Windows SmartScreen reputation is not something this pipeline can grant: a
newly signed standard certificate may still warn until it accrues reputation.

## The artifact hygiene scan

`node scripts/release-verify-artifacts.js <artifact-or-directory>... [--target <id>] [--strict]`
opens every artifact it can and fails (exit 2) on anything that must never ship:
a `config.json`, `features.json`, `.env*`, SQLite database, `data/` or `logs/`
directory, private key or certificate bundle (`.p12`, `.pfx`, `.jks`, or a PEM
with a private key block), `node_modules/.cache`, `.git/`, the repository's own
`tests/`, `e2e/` or `.github/`, a path that climbs out of the archive, a symlink
that is absolute or leaves the root, a device node, or a native binary built for
another platform or CPU. It reads `.run` (the embedded archive), `.tar.gz`,
AppImage (its own `--appimage-extract`), `.pkg` (`pkgutil --expand-full`, macOS
only), NSIS `.exe` (needs `7z`) and `.zip` (names only). `--strict` makes an
artifact whose container this machine cannot open a failure (exit 3); the
workflow uses it on what each runner can open and runs a non-strict pass over
the whole release at publish time. Tar archives are read by an in-Node parser
(ustar, PAX, GNU long names), so the same code runs on every runner.

## Release checklist

1. Land everything on `main`; CI (both engines, Playwright) is green.
2. Bump the version in `packages/core/package.json` **and** `apps/manager/package.json`
   (they must agree with the tag). Update `RELEASE_MIN_UPGRADE_FROM` if upgrades from
   older versions are not supported.
3. Check the certificates' expiry dates and that `release-keys.json` has the `active`
   key whose private half is the current secret.
4. Run a **dispatch** build first. Read the job summary: every target present, the
   hygiene scan clean, and the release notes' `UNSIGNED DEVELOPMENT BUILD` or
   `PARTIAL RELEASE` lines as expected.
5. Tag `vX.Y.Z-rc.1` for a candidate, then `vX.Y.Z` for stable. A stable tag with
   no active key stops with `RELEASE_BLOCKED_UNSIGNED`.
6. After publish: download the release, run
   `node scripts/release-index.js verify <dir> --policy production --public-key <trusted-key.pem> --require-files`
   and check `SHA256SUMS`. On a clean Windows and macOS machine, run the signed
   installer and confirm there is no "unknown publisher" or Gatekeeper block.
7. Write the advisory first if the release replaces a revoked key (see above).

## Reproducibility

The index records the **inputs** of a build: the source revision, the SHA-256 of
`package-lock.json`, the Node version, ABI and checksum source, the pinned build
tools' checksums, and the workflow run. The `.run`, the per-user tarball and the
payload archive are deterministic functions of their payload; the payload
itself, the AppImage, the macOS `.pkg` and a signed installer are **not
byte-identical across builds** (timestamps, `pkgbuild`, signature timestamps).
This is provenance, not a reproducible-build proof, and nothing here claims one.

## Dependency redistribution notices

Findings, not legal advice; the authoritative list is
`dependency-inventory-<target>.json` in each release (every dependency's name,
version, licence, exclusivity and owners, the licence totals and the non-permissive
licences, from the payload manifest). The facts established by the
packaging proof ([packaging_proof.md](packaging_proof.md), finding B5):

- `play-dl` and `play-audio` (GPL-3.0) are no longer declared anywhere and ship in
  no payload; the packaging gate fails a payload that carries a production
  dependency no source file imports.
- libvips and the libraries `sharp` bundles with it are LGPL-3.0 and similar. They ship
  as separate shared libraries under `sharp/vendor`, which keeps them replaceable;
  `sharp`'s own `THIRD-PARTY-NOTICES.md` is in the payload and must not be removed.
- `sqlite-vec` is dual licensed (`MIT OR Apache`); `rc` and `expand-template` offer MIT as
  one option. Node's own `LICENSE` ships in `runtime/`.
- FFmpeg is a system prerequisite the installer reports; **no artifact bundles it**, so
  its (L)GPL build terms do not arise from these artifacts. A bundled FFmpeg would need
  its build configuration and licence added here first.
- PostgreSQL and pgvector are not bundled: the Docker path pulls a digest-pinned
  `pgvector/pgvector:pg17` image on the operator's machine
  ([docker_postgres.md](docker_postgres.md)). If a native Postgres client or server is
  ever bundled, its licence notice belongs in the inventory and in this list before that
  release; it is not guessed here.
- A single third-party-notices file for the whole payload, generated from the manifest at
  release time, is still not produced; the per-target inventory is the interim source.

## Platform support statement

What is **claimed**, for a release that has been published and verified:

| Platform | Baseline | Exercised in CI |
| --- | --- | --- |
| Linux x64 | glibc 2.29 or newer: Debian 12, Ubuntu 22.04+, AlmaLinux/Rocky 9; not RHEL 8, not musl | `ubuntu-24.04` |
| Linux arm64 | glibc 2.33 or newer: Debian 12 / Raspberry Pi OS Bookworm 64-bit, Ubuntu 22.04+ | `ubuntu-24.04-arm`; the floor is header analysis only |
| Windows x64 | Windows 10 1809+, Windows 11, Server 2019+ | `windows-2022` |
| macOS | macOS 13 or newer, Apple silicon and Intel; `sqlite-vec` declares 14.0 (arm64) and 15.0 (x64) and falls back to a slower scan below that | `macos-15`, `macos-15-intel` |

See [linux_install.md](linux_install.md), [windows_install.md](windows_install.md) and
[macos_install.md](macos_install.md) for each platform's detail and for what the CI
journeys do and do not prove. Windows on Arm, 32-bit systems and musl are out of scope.

## What this does not claim

- **No public store listing, trademark search or distribution channel is claimed.**
  The ADR 0012 / #262 prerequisite for a public listing stays an owner decision.
  Technically, signed artifacts can exist once the owner supplies the key and the
  certificates; today none exists.
- **The pipeline is not an updater.** The release pipeline produces and verifies releases;
  it contains no code that downloads one or replaces an installed payload. That is the
  manager's update machinery (`documentation/manager_update.md`), which verifies the
  index and the artifact with the rules in this document.
- No release has been published by this pipeline, and no certificate has been exercised.

## Known gaps

- **Production Mach-O signing evidence.** The payload builder now signs and strictly
  verifies Mach-O files before recording their final sizes and hashes. CI exercises
  the hook with ad-hoc development signatures; real Developer ID Application
  signing, notarization and clean-host Gatekeeper acceptance still need owner
  credentials and a production qualification run.
- **Key expiry.** Ed25519 keys have no notion of expiry. Only certificates are
  checked for it (the workflow's 60-day warning); a signing key is controlled by
  custody and revocation.
- **`signed` on the install record** means a signature file is present, not that it
  verified.
- **Production Windows and macOS signing is still unverified.** Hosted development acceptance across all five targets is recorded in [release_acceptance.md](release_acceptance.md); that evidence does not establish production signing.
- **Post-build journeys are not part of the release workflow.** The service journeys
  (`scripts/linux-bootstrap-proof.sh`, `windows-bootstrap-proof.ps1`,
  `macos-bootstrap-proof.sh`) run in the three bootstrap workflows against development
  builds. The release workflow smoke-checks the payload and scans the artifacts but does
  not install them on a clean machine; the checklist's last manual step does.
- A release is not reproducible byte for byte (above).

## Updating an installation

An installed manager verifies and applies a release from this pipeline with the
index verifier the payload carries (`scripts/lib/releaseIndex.js`,
`scripts/lib/payloadStage.js`, `scripts/release-keys.json`). The trust policy,
the key list and the artifact digests are the ones described above;
`documentation/manager_update.md` describes the staged apply, the handoff and the
rollback.

## Commands

| Command | Purpose |
| --- | --- |
| `node scripts/release-index.js plan --tag <tag> [--dispatch --run-number <n>] [--github-output <file>]` | Channel, tag, version and signing mode; exit 2 when a stable run is blocked. |
| `node scripts/release-index.js materialize-key --env <NAME> --out <file>` | Write a key the environment holds to a `0600` file; prints only the key id. |
| `node scripts/release-index.js export-public --key <private.pem> --out <public.pem>` | The public half. |
| `node scripts/release-index.js pack-payload --payload <dir> --out <dir> [--public-key <pem>]` | The payload as one deterministic archive. |
| `node scripts/release-index.js inventory --payload <dir> --out <dir>` | `dependency-inventory-<target>.json`. |
| `node scripts/release-index.js entry --payload <dir> --artifact <file> --kind <kind> --out <file> [--public-key <pem>] [--platform-method authenticode\|apple-notarized --platform-identity <id>]` | One index entry. |
| `node scripts/release-index.js build --dir <dir> --entries <file>... --tag <tag> [--drop-unsigned-targets]` | Assemble `release-index.json` (checks every artifact against its entry). |
| `node scripts/release-index.js sign --dir <dir> --key <private.pem>` | Write `release-index.sig`. |
| `node scripts/release-index.js verify <dir> [--policy ...] [--public-key <pem>]... [--target <id>] [--abi <n>] [--current-version <v>] [--allow-downgrade] [--require-files]` | Verify a release. |
| `node scripts/release-index.js sums --dir <dir>` / `notes --dir <dir> --out <file>` | `SHA256SUMS` and the release notes. |
| `node scripts/release-verify-artifacts.js <path>... [--target <id>] [--strict]` | The hygiene scan. |

Exit codes: 0 ok, 2 refused (a code is printed), 1 usage or an unexpected failure.
No command prints a key: a private key is read from a file or one environment
variable and goes nowhere but the signing call.

## How this was verified

- Jest: `tests/releaseIndex.test.js` (channels, schema, signing, both policies, every
  code, the key list, per-artifact signing decisions, the command line, the stable
  block), `tests/releaseArtifacts.test.js` (the hygiene scan, with archives and
  containers built in the test), `tests/releaseManagerTrust.test.js` (the manager's
  policy, error mapping and install-record fields), `tests/releaseWorkflow.test.js`
  (the workflow's triggers, permissions, secrets handling and ordering). Keys are
  generated into the temp directory at test time; no key is committed.
- A local Linux x64 run against a real payload: build, sign with a throwaway key,
  verify under both policies, flip a byte, check target, ABI and downgrade, scan the
  artifacts, inject a `config.json` and confirm the scan refuses it.
- Not verified: anything on Windows or macOS, anything on arm64, anything with a real
  certificate.


### Verification-only dispatch and payload codesigning

Manual `Release` workflow dispatches now default to **build and verify only**.
Leave `publish` unchecked: the run uses development signing, assembles and scans
the artifacts, verifies the index, and retains a `release-verification` workflow
artifact without creating or changing a GitHub Release. Tag-triggered publication
keeps its existing behavior. Explicitly checking `publish` opts a manual run into
the existing development prerelease publication path.

On macOS, `package-runtime.js --codesign-identity <identity>` signs every inspected
Mach-O runtime/addon/library and runs `codesign --verify --strict` before computing
the manifest hashes. Only Node receives JIT/executable-memory entitlements; release
signing retains library validation. The release workflow imports Developer ID
Application and Installer identities before building the payload. The packaging
proof uses `--codesign-identity - --dev-sign` on macOS, with an additional
library-validation exception because ad-hoc signatures have no Team ID. This
mode cannot be requested without explicit development signing and never proves
production identity, notarization, or Gatekeeper acceptance.

The packaging workflow also performs a strict hygiene scan of each built payload.
The new signing and verification changes require hosted results before being
claimed as acceptance evidence; the actual publication workflow was not run as
part of this change.
