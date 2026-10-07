/**
 * The shared parts of the update kinds (documentation/manager_update.md): what the installation
 * is running, the trust the release index is checked under, fetching and verifying the index,
 * and comparing it with the install record. Nothing here applies a release.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ManagerError } = require('../errors');
const release = require('../install/release');
const policyModule = require('./policy');
const { createUpdateState } = require('./state');
const { createSource } = require('./source');
const fingerprints = require('./schemaFingerprint');

const BLOCK_CODES = new Set(['INDEX_INVALID', 'INDEX_UNSIGNED', 'INDEX_BAD_SIGNATURE', 'UNTRUSTED_KEY', 'ARTIFACT_UNSIGNED', 'TARGET_MISMATCH',
    'ABI_MISMATCH', 'DOWNGRADE', 'VERSION_INCOMPATIBLE', 'ARTIFACT_DIGEST_MISMATCH', 'ARTIFACT_MISSING', 'KEY_LIST_INVALID', 'CHANNEL_MISMATCH',
    'NO_PAYLOAD_FOR_TARGET', 'NO_RELEASE', 'SOURCE_UNREACHABLE', 'SOURCE_BAD_RESPONSE', 'SOURCE_REDIRECTED', 'DOWNLOAD_FAILED']);

function createUpdateCore({ settings, fs = nodeFs, now = () => new Date(), logger = console, install }) {
    const deps = settings.updateDeps || {};
    const env = settings.env || process.env;
    const state = createUpdateState({ storeDir: settings.storeDir, fs, now });
    const stamp = () => now().toISOString();

    /** The installation record, owned and managed, with the roots it names. */
    function ownedRecord(ctx) {
        const doc = install.ownedInstall(ctx);
        install.assertRecordPaths(doc);
        if (!doc.release) throw new ManagerError(409, 'NO_RELEASE_RECORDED', 'This installation records no release, so there is nothing to update from.');
        return doc;
    }

    const policyOf = (doc) => policyModule.current(doc);

    function sourceFor(doc) {
        const policy = policyOf(doc);
        return createSource({ source: policyModule.sourceOf(policy), channel: policy.channel, fetchImpl: deps.fetch || globalThis.fetch, fs });
    }

    function trust() {
        const policy = release.trustPolicy(null, env);
        return { policy, devMode: policy === 'development' };
    }

    function payloadVerifyOptions() {
        const keys = release.verifyOptions({}, fs, env).publicKey;
        return { ...(keys ? { publicKey: keys } : {}), devMode: trust().devMode };
    }

    function keyList() {
        try {
            return release.releaseIndex().loadKeyList();
        } catch {
            return undefined;
        }
    }

    /** What `<code>/current` carries: its manifest, the runtime question, the schema fingerprint. */
    function runningRelease(doc) {
        const codeRoot = doc.roots.code;
        let manifest = null;
        try {
            manifest = release.loadManifest(path.join(codeRoot, 'current'), fs).manifest;
        } catch { }
        return {
            releaseId: doc.release.releaseId,
            version: doc.release.version,
            target: doc.release.target,
            features: doc.release.features,
            abi: manifest ? String(manifest.node.abi) : null,
            carriesRuntime: manifest ? release.carriesRuntime(manifest) : false,
            schemaFingerprint: doc.release.schemaFingerprint || fingerprints.currentFingerprint(codeRoot, { fs })
        };
    }

    function tempDir() {
        const dir = path.join(state.dir, `tmp-${crypto.randomBytes(5).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    function removeTree(dir) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { }
    }

    /** Sweep what an interrupted run left in the update state directory. */
    function sweepTemp() {
        try {
            for (const name of fs.readdirSync(state.dir)) if (name.startsWith('tmp-')) removeTree(path.join(state.dir, name));
        } catch { }
    }

    /** Fetch the index and its signature into a fresh temporary directory (the caller removes it). */
    async function fetchIndexFiles(doc, { source = sourceFor(doc) } = {}) {
        const dir = tempDir();
        try {
            await source.fetchIndex(dir);
        } catch (error) {
            removeTree(dir);
            throw error;
        }
        return { dir, source };
    }

    /**
     * Verify the fetched index under the install's trust policy and its own target and version
     * rules. A refusal is a ManagerError carrying the index's own code.
     */
    function verifyIndexFiles(doc, dir) {
        const running = runningRelease(doc);
        const options = {
            env,
            fs,
            expectedTarget: running.target,
            currentVersion: running.version,
            ...(running.carriesRuntime || !running.abi ? {} : { nodeAbi: running.abi }),
            ...(keyList() ? { keyList: keyList() } : {})
        };
        const verdict = release.verifyReleaseIndex(dir, options);
        const { index } = release.releaseIndex().readIndex(dir);
        if (policyOf(doc).channel === 'stable' && index.release.channel !== 'stable') {
            throw new ManagerError(409, 'CHANNEL_MISMATCH', 'The newest release is a prerelease and this installation follows the stable channel.');
        }
        const artifact = index.artifacts.find(item => item.kind === 'payload' && item.target === running.target);
        return { index, verdict, running, artifact: artifact || null };
    }

    /** `{ outcome, code?, ... }` for what the index offers against what is installed. */
    function compare(doc, fetched) {
        const { index, running, artifact } = fetched;
        const rel = release.releaseIndex();
        const newer = rel.compareVersions(index.release.core, running.version) > 0;
        const latest = {
            version: index.release.core,
            manager: index.release.manager,
            channel: index.release.channel,
            tag: index.release.tag,
            minUpgradeFrom: index.compatibility.minUpgradeFrom,
            signed: fetched.verdict.signed,
            keyId: fetched.verdict.keyId || null
        };
        if (!artifact) return { outcome: 'blocked', code: 'NO_PAYLOAD_FOR_TARGET', latest };
        return { outcome: newer ? 'available' : 'up-to-date', latest, artifact: { file: artifact.file, size: artifact.size, sha256: artifact.sha256 } };
    }

    /** A check's failure as a recordable outcome, or the error rethrown when it is not the index's refusal. */
    function blockedOf(error) {
        if (error instanceof ManagerError && BLOCK_CODES.has(error.code)) return { outcome: 'blocked', code: error.code };
        throw error;
    }

    function recordCheck(result) {
        state.write('last-check', {
            at: stamp(),
            outcome: result.outcome,
            ...(result.code ? { code: result.code } : {}),
            ...(result.latest ? { latest: { version: result.latest.version, channel: result.latest.channel, tag: result.latest.tag } } : {}),
            installed: result.installed || null
        });
    }

    return {
        settings,
        fs,
        now,
        logger,
        deps,
        env,
        install,
        state,
        stamp,
        ownedRecord,
        policyOf,
        sourceFor,
        trust,
        payloadVerifyOptions,
        keyList,
        runningRelease,
        tempDir,
        removeTree,
        sweepTemp,
        fetchIndexFiles,
        verifyIndexFiles,
        compare,
        blockedOf,
        recordCheck
    };
}

module.exports = { createUpdateCore, BLOCK_CODES };
