---
title: Pinned bootstrap build tools - the mirror release, taking a newer upstream build and rolling one back
kind: reference
summary: How the third-party tools the installer builds download (appimagetool, the AppImage type 2 runtime, WinSW) are pinned, served and kept current - the pins file (scripts/bootstrap-pins.json, version 2) and what each field records, Goobster's own copy of every pinned file on the bootstrap-tools release and the fetch order (cache, mirror, upstream) with the SHA-256 checked on every download, the Bootstrap tools workflow (verify on pull requests, mirror on main, refresh daily), what a refresh verifies before it opens a pull request (GitHub's digest, the uploader, upstream's signature under the pinned key, the commit named in the binary, upstream's own build run), how a person accepts or declines a proposed build, what a merge publishes, how to roll back, every refusal code, and the one-time repository settings.
when: A bootstrap build reports TOOL_HASH_MISMATCH, TOOL_UNAVAILABLE, WINSW_HASH_MISMATCH or WINSW_UNAVAILABLE; reviewing a pull request titled "newer upstream builds of pinned bootstrap tools"; deciding whether to take a new appimagetool, AppImage runtime or WinSW build; rolling a pinned tool back; adding a pinned tool or rotating an upstream signing key; the Bootstrap tools workflow failed; asking why a release called bootstrap-tools exists in the repository.
tags: [installer, supply-chain, pins, sha256, mirror, appimage, appimagetool, winsw, github-actions, bootstrapper, signing, provenance]
---

# Pinned bootstrap build tools

The installer builds download three third-party programs:

| Pin | What it is | Used by | Upstream |
| --- | --- | --- | --- |
| `appimagetool` (x64, arm64) | builds the AppImage | `scripts/package-bootstrap.js` | `AppImage/appimagetool`, its version releases |
| `appimageRuntime` (x64, arm64) | the type 2 runtime that is the first bytes of every AppImage | `scripts/package-bootstrap.js` | `AppImage/type2-runtime`, the rolling release `continuous` |
| `winsw` | the Windows service host carried in the installer | `scripts/package-bootstrap-win32.js` | `winsw/winsw`, its version releases |

The two AppImage tools run on the build machine or become part of the artifact;
WinSW is installed on the operator's machine. So each one is **pinned by
SHA-256** in `scripts/bootstrap-pins.json`, and a build uses a download only
when its hash equals the pin. That rule has no exception and no switch.

A pin alone has one weakness: when upstream replaces the file behind the URL,
every build fails until somebody notices. That happened on 2026-10-19, when the
AppImage project rebuilt its `continuous` runtime release. This page describes
the pattern that replaced the bare pins:

1. Goobster keeps **its own copy** of every pinned file at an address it
   controls, so an upstream rebuild or a moved URL no longer reaches a build.
2. A **scheduled job** notices a newer upstream build, verifies it and opens a
   pull request. A person decides.
3. **Nothing is published until that pull request is merged.**

The Node runtime is pinned separately (`scripts/package-node-pins.json`,
`documentation/packaging_proof.md`) and is not part of this.

## The pins file

`scripts/bootstrap-pins.json` (`"version": 2`) has three kinds of entry.

**`mirror`** names the release that holds Goobster's copies:
`nervous-rob/goobster`, tag `bootstrap-tools`.

**`keys`** lists the upstream signing keys Goobster checks against. Each has
the full `fingerprint` and the `file` under `scripts/` that holds the public
key (`scripts/bootstrap-keys/appimage-type2-runtime.asc`). The key file must
contain exactly the key with that fingerprint, or every signature check fails
with `KEY_MISMATCH`.

**Every other entry is a tool.** A tool has its pinned file or files (`url` and
`sha256`, directly or per architecture) and an `upstream` block that records
where the file came from:

| Field | Meaning |
| --- | --- |
| `repository` | the upstream GitHub repository |
| `track` | how newer builds are found: `tag` follows rebuilds of one tag (the runtime's `continuous`); `versions` follows the highest published version tag, ignoring drafts, pre-releases and tags that are not versions (appimagetool, WinSW) |
| `tag`, `commit` | the release the pinned files belong to and the commit that tag pointed at when the pin was taken |
| `uploader` | the account that must have uploaded the release file |
| `workflow`, `run` | upstream's own build workflow, and the run that produced the pinned files (only where the files are built by a workflow on the tagged commit) |
| `embedsCommit` | the binary names the commit it was built from, and that is checked |
| `signingKey` | upstream publishes a detached signature next to the file; it is checked against this key, and the signature is kept in the pin (`signature`, base64) |

`url` is always the upstream address. It is the provenance and the fallback,
not the first place a build looks.

What is declared today:

| Pin | Digest | Uploader | Signature | Commit in binary | Upstream build run |
| --- | --- | --- | --- | --- | --- |
| `appimageRuntime` | yes | yes | yes | yes | yes |
| `appimagetool` | when GitHub records one | yes | upstream does not sign | no | no |
| `winsw` | when GitHub records one | yes | upstream does not sign | no | no |

GitHub records a digest only for release files uploaded since mid-2025, so the
files first pinned here (appimagetool 1.9.0, WinSW v2.12.0) have none; a newer
release of either will. For those two tools the pinned hash is what protects a
build, and the review of the upstream change is what protects the choice of
hash. The versions and hashes in force are the ones in the pins file.

## Where a build gets a pinned file

`scripts/lib/bootstrapTools.js` (`fetchPinned`) tries, in order:

1. the copy in `--tools-dir`, when it still matches the pin;
2. **the mirror**:
   `https://github.com/nervous-rob/goobster/releases/download/bootstrap-tools/<upstream file name>.<sha256>`;
3. the upstream `url`.

Whatever answers, the download is kept only when its SHA-256 equals the pin; a
copy that does not match is deleted and the next source is tried. When none
gives the pinned bytes the artifact is skipped (`APPIMAGE_SKIPPED` with
`TOOL_HASH_MISMATCH` or `TOOL_UNAVAILABLE`; `INSTALLER_SKIPPED` with
`WINSW_HASH_MISMATCH` or `WINSW_UNAVAILABLE`), and `--require-appimage` or
`--require-installer` turns the skip into a failure, as before.

The name of a mirror file contains its hash, so an address never changes
meaning, and files are **never replaced or removed**. The files of earlier pins
stay, which is what makes a rollback a plain revert.

The mirror release is a pre-release that is never marked "latest", and it has no
`release-index.json`, so neither the companion download links
(`releases/latest/download/...`) nor the manager's update check
(`documentation/manager_update.md`) ever see it. Its tag triggers no workflow.

## The Bootstrap tools workflow

`.github/workflows/bootstrap-tools.yml` runs `scripts/bootstrap-tools.js`. Its
default token is read-only; only the two jobs that run on `main` can write.

| Job | Runs | Does |
| --- | --- | --- |
| `verify` | on a pull request that touches the pins, the keys or this code | Downloads every pinned file from the mirror and from upstream and checks each copy: hash, signature, embedded commit. Fails when no source has the pinned bytes or when the mirror serves different bytes. Shows what a merge would publish (`publish --dry-run`). Keeps the verified files as the artifact `bootstrap-tool-candidates` for 90 days. Publishes nothing. |
| `mirror` | on `main`: after a merge that touches the same paths, daily, and on demand | Uploads the pinned files the mirror lacks, reads each one back from its public address, then requires the mirror to hold every pinned file (`verify --require-mirror`). It publishes only what `main`'s pins name. |
| `refresh` | on `main`: daily, and on demand | Asks upstream for a newer build of every tool, verifies it, and opens a pull request that changes only `scripts/bootstrap-pins.json`. It never merges and never publishes. |

Drift is also caught by the builds themselves: `linux-bootstrap.yml` and
`windows-bootstrap.yml` run weekly on `main` as well as on pull requests, so a
pinned tool that stops resolving fails there, not on an unrelated pull request
weeks later. (The macOS bootstrap downloads nothing pinned here.)

## What a refresh verifies

For each tool the refresh finds the release it follows and compares it with the
pin. When a file differs, **every** check the pin declares must pass before
anything is proposed:

| Check | Refusal code |
| --- | --- |
| the release and the file still exist | `UPSTREAM_RELEASE_MISSING`, `UPSTREAM_ASSET_MISSING`, `UPSTREAM_TAG_UNRESOLVED` |
| the download equals the digest GitHub records for the release file | `UPSTREAM_DIGEST_MISMATCH` |
| the file was uploaded by the pinned account | `UPSTREAM_UPLOADER_CHANGED` |
| upstream's detached signature is a good signature by the pinned key | `UPSTREAM_SIGNATURE_MISSING`, `SIGNATURE_INVALID`, `KEY_MISMATCH`, `KEY_UNREADABLE`, `GPG_UNAVAILABLE` |
| the binary names the commit the release tag points at | `COMMIT_NOT_EMBEDDED` |
| upstream's own build workflow succeeded for that commit, on a push, and started before the file was uploaded | `UPSTREAM_BUILD_NOT_FOUND`, `UPSTREAM_ASSET_PREDATES_BUILD` |

A refusal fails the job and proposes nothing; the pins and the mirror stay as
they are and builds keep working from the mirror. Look at upstream before
running it again: a refusal means upstream published something that does not
look like its usual build.

The signature check runs the system `gpg` in an empty, throwaway keyring that
holds only the pinned key: no agent, no keyserver, no trust database.

What these checks do **not** prove: that upstream's source is harmless, or that
the binary is what that source compiles to (the runtime's build does not
reproduce bit for bit). They prove the file is the one upstream's own pipeline
published for a commit you can read. Reading that commit range is the reviewer's
part.

## Accepting a newer build

The refresh opens a pull request titled `chore(packaging): newer upstream builds
of pinned bootstrap tools (...)`, from a branch named
`bootstrap-tools/refresh-<digest of the proposed pins>`. Its description lists,
per tool, the old and new hashes, the upstream commit range with a compare
link, and the evidence for each check.

1. **Read what changed upstream** (the compare link). Decide whether Goobster
   should take it.
2. **Wait for the checks.** `Bootstrap tools / verify the pins` re-verifies the
   proposal independently, and the Linux and Windows bootstrap workflows build
   and install with the proposed files (they fall back to upstream for a file
   the mirror does not hold yet, hash-checked as always).
3. **A new WinSW version needs one more edit.** The helper refuses a service
   host that is not the pinned one, and its copy of the pin is
   `WINSW` in `apps/manager/platform/windowsServiceXml.js`. Change it to the
   new version and hash in the same pull request;
   `tests/windowsService.test.js` fails until the two agree.
4. **Merge.** The `mirror` job then uploads the new files and verifies the
   mirror. From that point builds take them from Goobster's copy.

To **decline** a build, close the pull request. The same proposal is not
opened again (a closed pull request for the same branch counts as an answer).
When upstream publishes something newer still, that is a different proposal and
a new pull request.

If upstream replaces its files again between the review and the merge, the
merged pin names bytes upstream no longer serves. The `mirror` job then
publishes the copy the `verify` or `refresh` run kept, after checking it against
the pin exactly like a download. If no kept copy exists either, the job fails
with `PIN_UNOBTAINABLE` and nothing is uploaded; revert the pin or wait for the
next refresh.

### By hand

The same steps from a checkout, for a look before the schedule or a repository
without Actions (`gpg` on the `PATH`; `GH_TOKEN` avoids GitHub's anonymous rate
limit and is required to publish):

```bash
node scripts/bootstrap-tools.js verify                 # every pin, every source
node scripts/bootstrap-tools.js refresh                # what upstream has now; writes nothing
node scripts/bootstrap-tools.js refresh --write        # rewrite the pins file with the verified build
node scripts/bootstrap-tools.js publish --dry-run      # what the mirror lacks
node scripts/bootstrap-tools.js publish                # upload it (after the pin is merged)
```

Never edit a hash by hand to make a build pass. A hash that no longer matches
means the bytes changed; `refresh` is how to find out what they changed to and
whether upstream's own pipeline made them.

## Rolling back

Revert the commit that changed `scripts/bootstrap-pins.json` (and, for WinSW,
the constant that went with it) through a pull request. Nothing else is needed:
the files of the earlier pin are still on the mirror under their own names, so
builds resolve them at once, even when upstream no longer serves them.

After a rollback the next refresh proposes the newer build again only if its
pins file differs from every proposal already made; the proposal you reverted
has a merged pull request for its branch, so it is not reopened. To take that
build later, revert the revert.

## Codes from `verify` and `publish`

| Code | Meaning | What to do |
| --- | --- | --- |
| `PIN_UNOBTAINABLE` | Neither the mirror, upstream nor a kept copy has the pinned bytes. | Run the refresh; it proposes what upstream serves now. |
| `MIRROR_MISSING` | On `main`, the mirror does not hold a pinned file. | Run the workflow on `main` (the `mirror` job), or `publish`. |
| `MIRROR_HASH_MISMATCH` | The mirror serves a file whose contents differ from the hash in its name, or an upload did not read back intact. | Someone changed the mirror release by hand. Delete that one asset and run the `mirror` job. |
| `MIRROR_IS_LATEST` | The mirror release became the repository's "latest" release. | Mark the proper release as latest in the GitHub UI. |
| `SIGNATURE_INVALID`, `COMMIT_NOT_EMBEDDED` | A copy has the pinned hash but fails a check the pin declares. | The pin and its `signature` or `commit` disagree; they must come from the same refresh. |
| `PINS_INVALID` | The pins file is malformed; the message names each problem. | Fix the file; `tests/bootstrapTools.test.js` checks the same rules. |

## Adding a tool, or a new upstream key

Add the tool to `scripts/bootstrap-pins.json` with its `upstream` block,
declaring every check upstream makes possible, and read it through
`bootstrapTools.fetchPinned` in the build script. `verify` on the pull request
proves the pin, and the merge publishes the copy.

If upstream rotates its signing key, the refresh refuses the new build with
`SIGNATURE_INVALID`. Confirm the new key through upstream's own channels, then
replace the key file and the fingerprint in one pull request; no automation
changes a pinned key.

## One-time setup

Merging the pull request that introduced this is the publish step: the `mirror`
job creates the `bootstrap-tools` release and uploads the five pinned files.
Until then, and on any fork, builds fall back to the upstream URLs with the
same hash check, which is why continuous integration passes before the mirror
exists.

Two repository settings matter:

- **Pull requests from Actions.** The refresh opens its pull request with the
  workflow token, which needs *Settings > Actions > General > Allow GitHub
  Actions to create and approve pull requests*. Without it the job pushes the
  branch, fails, and prints the link to open the pull request by hand.
- **Optional: `BOOTSTRAP_TOOLS_PR_TOKEN`.** A pull request opened with the
  workflow token does not start pull-request workflows by itself. The job
  therefore starts the Linux and Windows bootstrap workflows on the branch; to
  start the rest of CI, close and reopen the pull request. A repository secret
  `BOOTSTRAP_TOOLS_PR_TOKEN` (a fine-grained token for this repository with
  read and write access to contents and pull requests) makes the pull request
  start all of CI like any other.

The mirror release must stay editable: do not delete it, do not mark it
"latest", and do not turn on immutable releases for the repository without
moving the mirror first, because new files are added to the same release.
