'use strict';

/**
 * Locally built, signed fake releases for the update step (the approach of the #342 proof): the payload
 * `scripts/package-runtime.js` made is copied (hard links where the file system allows), re-signed with
 * a throwaway key, and a derived copy with a newer core version is published as a release source
 * directory (`release-index.json`, `release-index.sig` and the artifact it names), signed with the
 * same key. The key never leaves the work directory and the private half is deleted when the run ends.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const stage = require('../../lib/payloadStage');
const releaseIndex = require('../../lib/releaseIndex');
const bootstrapStage = require('../../lib/bootstrapStage');

function readManifest(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, stage.MANIFEST_FILE), 'utf8'));
}

/**
 * Copy a payload tree. Files below the top level are hard-linked (the payload is hundreds of MiB and
 * is never written to); the top-level manifest, signature and selection are real copies because the
 * workshop rewrites them and a rewrite through a link would change the payload they came from.
 */
function copyTree(from, to, depth = 0) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyTree(source, target, depth + 1);
        } else if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(source), target);
        } else {
            try {
                if (depth === 0) throw new Error('copy');
                fs.linkSync(source, target);
            } catch {
                fs.copyFileSync(source, target);
            }
        }
    }
}

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

/** Replace a file without writing through a hard link into the original payload. */
function replaceFile(file, content) {
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, content);
}

class ReleaseWorkshop {
    /**
     * @param {Object} options
     * @param {string} options.payload  a payload directory made by scripts/package-runtime.js
     * @param {string} options.dir      scratch directory for keys, copies and sources
     */
    constructor({ payload, dir }) {
        this.payload = path.resolve(payload);
        this.dir = path.resolve(dir);
        this.key = null;
        this.base = null;
    }

    /** The throwaway key and a copy of the payload signed with it: the release the installation is made from. */
    prepareBase() {
        fs.mkdirSync(this.dir, { recursive: true });
        this.key = stage.generateDevKeyPair(path.join(this.dir, 'key'));
        this.key.privatePem = fs.readFileSync(this.key.privateKeyPath, 'utf8');
        this.base = path.join(this.dir, 'base');
        copyTree(this.payload, this.base);
        const manifest = readManifest(this.base);
        const signed = stage.signManifest(manifest, this.key.privatePem);
        stage.writeManifest(this.base, signed.manifest, signed.signature);
        this.baseManifest = signed.manifest;
        return { dir: this.base, publicKeyPath: this.key.publicKeyPath, keyId: this.key.keyId, version: signed.manifest.release.core, releaseId: stage.releaseIdOf(signed.manifest), target: signed.manifest.target.id };
    }

    /** Remove the private half of the key; nothing can be signed afterwards. */
    discardPrivateKey() {
        if (this.key) fs.rmSync(this.key.privateKeyPath, { force: true });
        if (this.key) this.key.privatePem = null;
    }

    /**
     * A release source directory offering `version`: the derived payload's archive and a signed index.
     * @param {string} version
     * @returns {Promise<{dir:string, payloadDir:string, version:string, releaseId:string}>} `payloadDir` is the unpacked payload the archive was made from (what `repair --answers {source}` wants)
     */
    async publish(version) {
        if (!this.base || !this.key || !this.key.privatePem) throw new Error('prepareBase() first');
        const derived = path.join(this.dir, `derived-${version}`);
        copyTree(this.base, derived);
        const manifest = readManifest(derived);
        const rel = 'app/node_modules/@goobster/core/package.json';
        const file = path.join(derived, ...rel.split('/'));
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.version = version;
        const content = `${JSON.stringify(doc, null, 2)}\n`;
        replaceFile(file, content);
        const entry = manifest.files.find((item) => item.path === rel);
        if (!entry) throw new Error('the payload manifest does not list the core package.json');
        entry.size = Buffer.byteLength(content);
        entry.sha256 = sha256(content);
        manifest.release.core = version;
        if (manifest.goobsterVersion) manifest.goobsterVersion = version;
        const signed = stage.signManifest(manifest, this.key.privatePem);
        stage.writeManifest(derived, signed.manifest, signed.signature);

        const source = path.join(this.dir, `source-${version}`);
        fs.rmSync(source, { recursive: true, force: true });
        fs.mkdirSync(source, { recursive: true });
        const target = signed.manifest.target.id;
        const archive = path.join(source, `goobster-payload-${version}-${target}.tar.gz`);
        await bootstrapStage.writeArchive(derived, archive, {});
        const artifact = releaseIndex.artifactEntry({
            file: archive,
            kind: 'payload',
            target,
            signing: { status: 'signed', method: 'ed25519-only', identity: this.key.keyId },
            payloadKeyId: this.key.keyId
        });
        const built = releaseIndex.buildIndex({
            release: {
                core: version,
                manager: version,
                channel: 'stable',
                tag: `v${version}`,
                sourceRevision: 'a'.repeat(40),
                lockfileSha256: 'b'.repeat(64),
                builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
            },
            node: { version: signed.manifest.node.version, abi: String(signed.manifest.node.abi) },
            compatibility: { minUpgradeFrom: '1.0.0', compatibleCore: signed.manifest.release.compatibleCore },
            artifacts: [artifact]
        });
        const index = releaseIndex.signIndex(built, this.key.privatePem);
        releaseIndex.writeIndex(source, index.index, index.signature);
        return { dir: source, payloadDir: derived, version, releaseId: stage.releaseIdOf(signed.manifest) };
    }
}

module.exports = { ReleaseWorkshop, copyTree };
