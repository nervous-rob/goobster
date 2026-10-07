/**
 * Staging a release (documentation/manager_update.md, `update.stage`): download the payload
 * archive the signed index names, check its size and digest, unpack it, verify the payload, and
 * stage the installed feature selection from it into `<code>/staging`. Nothing about `current`
 * changes. A refusal at any step leaves the previous staged release as it was or removes what
 * this run wrote; a half-downloaded file never reaches the verified directory.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../errors');
const release = require('../install/release');
const preflight = require('../install/preflight');
const archive = require('./archive');
const fingerprints = require('./schemaFingerprint');

const SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const MAX_KEPT_RELEASES = 3;
const MIN_BACKUP_ESTIMATE = 8 * 1024 * 1024;

function createStageHelpers({ core }) {
    const { fs = nodeFs } = core;

    /** What a backup before the update will need (the SQLite file and its sidecars; Postgres is the operator's estimate). */
    function backupEstimate() {
        if (core.deps.backupEstimate !== undefined) return core.deps.backupEstimate;
        const { settings } = core;
        if (settings.dbUrl) return MIN_BACKUP_ESTIMATE;
        let total = 0;
        for (const suffix of ['', '-wal', '-shm']) {
            try { total += fs.statSync(`${settings.sqlitePath}${suffix}`).size; } catch { }
        }
        return Math.max(MIN_BACKUP_ESTIMATE, total);
    }

    function checkSpace({ doc, artifactSize }) {
        const codeNeed = artifactSize * 2 + SPACE_MARGIN_BYTES;
        const backupNeed = backupEstimate();
        const backupRoot = path.join(core.settings.dataDir, 'backups');
        const free = (dir) => {
            if (core.deps.freeBytes) return core.deps.freeBytes(dir);
            const existing = preflight.ancestorExists(dir, fs);
            return existing ? preflight.freeBytes(existing, fs) : null;
        };
        const codeFree = free(doc.roots.code);
        const backupFree = free(backupRoot);
        const problems = [];
        if (codeFree !== null && codeFree !== undefined && codeFree < codeNeed) problems.push({ root: 'code', need: codeNeed, free: codeFree });
        if (backupFree !== null && backupFree !== undefined && backupFree < backupNeed) problems.push({ root: 'backup', need: backupNeed, free: backupFree });
        if (problems.length) {
            throw new ManagerError(409, 'INSUFFICIENT_SPACE', `There is not enough free space to stage this update (${problems.map(item => `${item.root}: ${item.need} needed, ${item.free} free`).join('; ')}); nothing was downloaded.`, { problems });
        }
        return { codeNeed, backupNeed };
    }

    const releasesDir = (doc) => path.join(doc.roots.code, 'releases');

    /** Remove `.partial` downloads an interrupted run left, and any directory of a release that is not kept. */
    function sweep(doc, { keep = [] } = {}) {
        const dir = releasesDir(doc);
        let names;
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) if (name.endsWith('.partial')) core.removeTree(path.join(dir, name));
        const live = new Set(keep.filter(Boolean));
        const entries = names.filter(name => !name.endsWith('.partial') && !live.has(name));
        const dated = entries.map((name) => {
            let at = 0;
            try { at = fs.statSync(path.join(dir, name)).mtimeMs; } catch { }
            return { name, at };
        }).sort((a, b) => b.at - a.at);
        for (const item of dated.slice(Math.max(0, MAX_KEPT_RELEASES - live.size))) core.removeTree(path.join(dir, item.name));
    }

    /** Step `download`: the archive lands in a `.partial` directory with its size and digest checked. */
    async function download({ doc, source, artifact, index, running }) {
        const dir = releasesDir(doc);
        fs.mkdirSync(dir, { recursive: true });
        const provisional = path.join(dir, `${index.release.core}-${running.target}.partial`);
        core.removeTree(provisional);
        fs.mkdirSync(provisional, { recursive: true, mode: 0o700 });
        const archiveFile = path.join(provisional, artifact.file);
        try {
            await source.fetchArtifact(artifact.file, archiveFile, { size: artifact.size, sha256: artifact.sha256 });
        } catch (error) {
            core.removeTree(provisional);
            throw error;
        }
        return { provisional, archiveFile };
    }

    /** Step `verify-artifact`: the archive is safe to read and is the release and platform the signed index names. */
    function verifyArtifact({ landed, index, running }) {
        const stage = release.payloadStage();
        let manifest;
        try {
            manifest = JSON.parse(archive.readManifestText(landed.archiveFile));
            archive.listMembers(landed.archiveFile);
        } catch (error) {
            if (error instanceof ManagerError) throw error;
            throw new ManagerError(409, 'MANIFEST_INVALID', 'The payload archive holds a manifest that cannot be read.');
        }
        if (!manifest || !manifest.release || manifest.release.core !== index.release.core || !manifest.target || manifest.target.id !== running.target) {
            throw new ManagerError(409, 'TARGET_MISMATCH', 'The payload archive is not the release and platform the signed index names.');
        }
        return { manifest, releaseId: stage.releaseIdOf(manifest) };
    }

    /** Step `verify-payload`: unpack, verify every file and the signature, and keep the verified tree under `releases/`. */
    function verifyPayload({ doc, landed, releaseId }) {
        const stage = release.payloadStage();
        const unpacked = path.join(landed.provisional, 'payload');
        archive.extract(landed.archiveFile, unpacked, { fs });
        let verified;
        try {
            verified = stage.verifyPayload(unpacked, { ...core.payloadVerifyOptions(), hash: true });
        } catch (error) {
            throw release.mapPayloadError(error) || error;
        }
        const fingerprint = fingerprints.fingerprintOf(unpacked, { fs });
        const final = path.join(releasesDir(doc), releaseId);
        core.removeTree(final);
        fs.renameSync(unpacked, final);
        core.removeTree(landed.provisional);
        return { dir: final, releaseId, verified, fingerprint };
    }

    /** The staged selection must be satisfiable from the new payload with the installed features. */
    function stageFromRelease({ doc, payloadDir, ctx = {} }) {
        const stage = release.payloadStage();
        const features = doc.release.features;
        const options = core.payloadVerifyOptions();
        const codeRoot = doc.roots.code;
        let staged;
        try {
            staged = core.install.stageSelectionInto({ sources: payloadDir, codeRoot, features, profile: null, options, ctx });
        } catch (error) {
            const mapped = release.mapPayloadError(error) || error;
            if (mapped instanceof ManagerError && (mapped.code === 'SELECTION_UNAVAILABLE' || mapped.code === 'UNKNOWN_FEATURE')) {
                throw new ManagerError(409, 'FEATURES_UNAVAILABLE', 'The new release cannot provide every feature this installation has installed; nothing was staged.');
            }
            throw mapped;
        }
        void stage;
        return staged;
    }

    return { backupEstimate, checkSpace, sweep, download, verifyArtifact, verifyPayload, stageFromRelease, releasesDir };
}

module.exports = { createStageHelpers, SPACE_MARGIN_BYTES, MAX_KEPT_RELEASES };
