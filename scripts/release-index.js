#!/usr/bin/env node
'use strict';

/**
 * The release index command line (documentation/release.md, issue #341). Every command prints JSON or a
 * short line and never prints a key: a private key is read from a file or an environment variable and
 * goes nowhere but the signing call.
 *
 *   plan       --tag <tag> [--dispatch] [--run-number <n>] [--key-env <NAME>] [--github-output <file>]
 *                  channel, tag, version and signing mode (release | dev | blocked) of this run; exit 2 with
 *                  RELEASE_BLOCKED_UNSIGNED when a stable run has no active key
 *   materialize-key --env <NAME> --out <file>        write a key the environment holds to a 0600 file
 *   export-public   --key <private.pem> --out <public.pem>
 *   pack-payload    --payload <dir> --out <dir> [--public-key <pem>]
 *                  the payload as one deterministic archive artifact; prints its path
 *   inventory       --payload <dir> --out <dir>      dependency-inventory-<target>.json from the manifest
 *   entry           --payload <dir> --artifact <file> --kind <kind> [--public-key <pem>]
 *                   [--platform-method authenticode|apple-notarized --platform-identity <id>] --out <file>
 *                  append one index entry (target, size, SHA-256, signing state) to a JSON list
 *   build           --dir <release-dir> --entries <file>... --tag <tag> [--dispatch] [--source-revision <sha>]
 *                   [--built-at <iso>] [--min-upgrade-from <version>] [--lockfile <package-lock.json>]
 *                  assemble release-index.json beside the artifacts (and check each against its entry)
 *   sign            --dir <release-dir> --key <private.pem>
 *   verify          <dir> [--policy production|development] [--public-key <pem>]... [--key-list <file>]
 *                   [--no-key-list] [--target <id>] [--abi <n>] [--current-version <v>] [--allow-downgrade]
 *                   [--require-files]
 *   sums            --dir <release-dir>              write SHA256SUMS
 *   notes           --dir <release-dir> [--expected <target,target>] --out <file>
 *                  the GitHub release body: channel, signing state, absent targets
 *
 * Exit 0 ok, 2 refused (a code is printed), 1 usage or an unexpected failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stage = require('./lib/payloadStage');
const index = require('./lib/releaseIndex');
const bootstrapStage = require('./lib/bootstrapStage');

const REPO_ROOT = path.resolve(__dirname, '..');
const SUMS_FILE = 'SHA256SUMS';
const DEFAULT_KEY_ENV = 'GOOBSTER_RELEASE_SIGNING_KEY_PEM';

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function repoVersion(rel) {
    return readJson(path.join(REPO_ROOT, rel, 'package.json')).version;
}

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = { command, positional: [], lists: {} };
    const LIST = new Set(['--public-key', '--entries']);
    const FLAGS = new Set(['--dispatch', '--allow-downgrade', '--require-files', '--no-key-list']);
    const camel = (flag) => flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (!arg.startsWith('--')) {
            options.positional.push(arg);
            continue;
        }
        if (FLAGS.has(arg)) {
            options[camel(arg)] = true;
            continue;
        }
        i += 1;
        if (i >= rest.length || rest[i] === '') throw new Error(`${arg} needs a value`);
        if (LIST.has(arg)) {
            const key = camel(arg);
            (options.lists[key] = options.lists[key] || []).push(rest[i]);
        } else options[camel(arg)] = rest[i];
    }
    return options;
}

function need(options, ...names) {
    for (const name of names) if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required`);
}

/** Does `keyId` stand as an active key in the repository's key list? */
function activeKeyIds(keyListFile) {
    return index.signingKeys(index.loadKeyList(keyListFile)).map(entry => entry.keyId);
}

/** The signing mode of a run, from what the environment holds. Never returns key material. */
function planSigning({ channel, env = process.env, keyEnv = DEFAULT_KEY_ENV, keyListFile } = {}) {
    const pem = env[keyEnv];
    let keyId = null;
    let problem = null;
    if (pem && pem.trim()) {
        try {
            const key = crypto.createPrivateKey(pem);
            if (key.asymmetricKeyType !== 'ed25519') problem = 'the signing secret is not an Ed25519 key';
            else keyId = stage.keyIdOf(crypto.createPublicKey(key));
        } catch {
            problem = 'the signing secret is not a readable private key';
        }
    }
    const active = keyId ? activeKeyIds(keyListFile).includes(keyId) : false;
    if (keyId && active) return { mode: 'release', keyId, reason: null };
    const reason = problem || (keyId ? `key ${keyId} is not an active key in scripts/release-keys.json` : 'no signing key is available (the repository ships no active key and the signing secret is empty)');
    if (channel === 'stable') return { mode: 'blocked', keyId, reason };
    return { mode: 'dev', keyId, reason };
}

function appendOutput(file, values) {
    if (!file) return;
    fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${value === null || value === undefined ? '' : value}`).join('\n')}\n`);
}

function payloadSignState(payloadDir, publicKeyFile) {
    const { signingState } = require('./package-bootstrap');
    return signingState(payloadDir, publicKeyFile || null);
}

function payloadManifest(payloadDir) {
    return stage.validateManifest(readJson(path.join(payloadDir, stage.MANIFEST_FILE)));
}

function buildMetadata(env = process.env) {
    if (!env.GITHUB_RUN_ID) return undefined;
    return { repository: env.GITHUB_REPOSITORY || null, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT || '1', workflow: env.GITHUB_WORKFLOW || null };
}

function provenance() {
    const nodePins = readJson(path.join(__dirname, 'package-node-pins.json'));
    const tools = readJson(path.join(__dirname, 'bootstrap-pins.json'));
    const arch = (pin) => ({ x64: pin.x64 && { sha256: pin.x64.sha256 }, arm64: pin.arm64 && { sha256: pin.arm64.sha256 } });
    return {
        nodePin: { version: nodePins.nodeVersion, line: nodePins.line, moduleVersion: nodePins.moduleVersion, checksumSource: nodePins.checksumSource, sha256: nodePins.sha256 },
        tools: {
            appimagetool: { version: tools.appimagetool.version, ...arch(tools.appimagetool) },
            appimageRuntime: { source: tools.appimageRuntime.source, ...arch(tools.appimageRuntime) },
            winsw: { version: tools.winsw.version, file: tools.winsw.file, sha256: tools.winsw.sha256 }
        },
        build: buildMetadata()
    };
}

function sha256Of(file) {
    return stage.sha256File(file);
}

function listFiles(dir) {
    return fs.readdirSync(dir).filter(name => fs.lstatSync(path.join(dir, name)).isFile()).sort();
}

const COMMANDS = {
    plan(options) {
        const tag = options.tag || '';
        const dispatch = options.dispatch === true;
        const core = repoVersion('packages/core');
        let derived;
        let releaseTag = tag;
        if (dispatch) {
            releaseTag = `v${core}-dev.${options.runNumber || '0'}`;
            derived = index.deriveChannel(releaseTag, { dispatch: true });
        } else {
            derived = index.deriveChannel(tag);
            if (derived.version !== core) throw Object.assign(new Error(`tag ${tag} says ${derived.version} but packages/core is ${core}; bump the version before tagging`), { code: index.CODES.TAG_INVALID });
            const manager = repoVersion('apps/manager');
            if (manager !== core) throw Object.assign(new Error(`apps/manager is ${manager} but packages/core is ${core}`), { code: index.CODES.TAG_INVALID });
        }
        const keyListFile = options.keyList || index.KEY_LIST_FILE;
        const signing = planSigning({ channel: derived.channel, keyEnv: options.keyEnv || DEFAULT_KEY_ENV, keyListFile });
        const result = { channel: derived.channel, tag: releaseTag, version: derived.version, core, mode: signing.mode, keyId: signing.keyId, reason: signing.reason, code: signing.mode === 'blocked' ? 'RELEASE_BLOCKED_UNSIGNED' : null };
        appendOutput(options.githubOutput, { channel: result.channel, tag: result.tag, version: result.core, mode: result.mode, key_id: result.keyId || '' });
        return { status: signing.mode === 'blocked' ? 2 : 0, result };
    },

    'materialize-key'(options) {
        need(options, 'env', 'out');
        const pem = process.env[options.env];
        if (!pem || !pem.trim()) throw new Error(`${options.env} is empty`);
        crypto.createPrivateKey(pem);
        fs.writeFileSync(options.out, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o600, flag: 'w' });
        fs.chmodSync(options.out, 0o600);
        return { status: 0, result: { written: path.basename(options.out), keyId: stage.keyIdOf(crypto.createPublicKey(crypto.createPrivateKey(pem))) } };
    },

    'export-public'(options) {
        need(options, 'key', 'out');
        const publicKey = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(options.key, 'utf8')));
        fs.writeFileSync(options.out, publicKey.export({ type: 'spki', format: 'pem' }));
        return { status: 0, result: { keyId: stage.keyIdOf(publicKey), publicKey: path.basename(options.out) } };
    },

    async 'pack-payload'(options) {
        need(options, 'payload', 'out');
        const manifest = payloadManifest(options.payload);
        const signed = payloadSignState(options.payload, options.lists.publicKey && options.lists.publicKey[0]).signed;
        fs.mkdirSync(options.out, { recursive: true });
        const name = `goobster-payload-${manifest.release.core}-${manifest.target.id}${signed ? '' : '-dev'}.tar.gz`;
        const file = path.join(options.out, name);
        const written = await bootstrapStage.writeArchive(path.resolve(options.payload), file, {});
        fs.chmodSync(file, 0o644);
        return { status: 0, result: { file, name, sha256: written.sha256, bytes: written.bytes, signed } };
    },

    inventory(options) {
        need(options, 'payload', 'out');
        const manifest = payloadManifest(options.payload);
        fs.mkdirSync(options.out, { recursive: true });
        const file = path.join(options.out, `${index.INVENTORY_PREFIX}${manifest.target.id}.json`);
        fs.writeFileSync(file, stage.canonicalJson(index.dependencyInventory(manifest)));
        return { status: 0, result: { file: path.basename(file), dependencies: manifest.dependencies.length } };
    },

    entry(options) {
        need(options, 'payload', 'artifact', 'kind', 'out');
        if (!index.KINDS.includes(options.kind)) throw new Error(`--kind must be one of ${index.KINDS.join(', ')}`);
        const manifest = payloadManifest(options.payload);
        const state = payloadSignState(options.payload, options.lists.publicKey && options.lists.publicKey[0]);
        let platform = null;
        if (options.platformMethod) {
            if (!['authenticode', 'apple-notarized'].includes(options.platformMethod)) throw new Error('--platform-method must be authenticode or apple-notarized');
            platform = { method: options.platformMethod, identity: options.platformIdentity };
        }
        const target = manifest.target.id;
        const signing = index.decideSigning({ target, kind: options.kind, payloadSigned: state.signed, payloadKeyId: state.keyId, platform });
        const entry = index.artifactEntry({ file: options.artifact, kind: options.kind, target, signing, payloadKeyId: state.signed ? state.keyId : null });
        const list = fs.existsSync(options.out) ? readJson(options.out) : [];
        list.push(entry);
        fs.writeFileSync(options.out, `${JSON.stringify(list, null, 2)}\n`);
        return { status: 0, result: entry };
    },

    build(options) {
        need(options, 'dir', 'tag');
        const files = options.lists.entries || [];
        if (!files.length) throw new Error('--entries needs at least one artifact-entry file');
        const dir = path.resolve(options.dir);
        const dispatch = options.dispatch === true;
        const derived = index.deriveChannel(options.tag, { dispatch });
        const core = repoVersion('packages/core');
        const major = Number(core.split('.')[0]) || 0;
        const artifacts = [];
        for (const file of files) {
            const parsed = readJson(file);
            artifacts.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        }
        for (const artifact of artifacts) {
            const full = path.join(dir, artifact.file);
            if (!index.bareFileName(artifact.file) || !fs.existsSync(full)) throw Object.assign(new Error(`${artifact.file} is not in ${dir}`), { code: index.CODES.ARTIFACT_MISSING });
            if (fs.statSync(full).size !== artifact.size || sha256Of(full) !== artifact.sha256) {
                throw Object.assign(new Error(`${artifact.file} no longer matches the entry its build wrote`), { code: index.CODES.ARTIFACT_DIGEST_MISMATCH });
            }
        }
        const inventories = listFiles(dir).filter(name => name.startsWith(index.INVENTORY_PREFIX) && name.endsWith('.json')).map((name) => {
            const target = name.slice(index.INVENTORY_PREFIX.length, -'.json'.length);
            return { target, file: name, sha256: sha256Of(path.join(dir, name)) };
        });
        const lockfile = options.lockfile ? path.resolve(options.lockfile) : path.join(REPO_ROOT, 'package-lock.json');
        const pins = provenance();
        const built = index.buildIndex({
            release: {
                core,
                manager: repoVersion('apps/manager'),
                channel: derived.channel,
                tag: options.tag,
                sourceRevision: options.sourceRevision || process.env.GITHUB_SHA || '',
                lockfileSha256: sha256Of(lockfile),
                builtAt: options.builtAt || new Date().toISOString()
            },
            node: { version: pins.nodePin.version, abi: pins.nodePin.moduleVersion },
            compatibility: { minUpgradeFrom: options.minUpgradeFrom || '0.0.0', compatibleCore: `>=${core} <${major + 1}.0.0` },
            artifacts,
            provenance: pins,
            inventories
        });
        index.writeIndex(dir, built, null);
        return { status: 0, result: { index: index.INDEX_FILE, channel: derived.channel, artifacts: built.artifacts.length, targets: [...new Set(built.artifacts.map(item => item.target))] } };
    },

    sign(options) {
        need(options, 'dir', 'key');
        const dir = path.resolve(options.dir);
        const { index: current } = index.readIndex(dir);
        if (process.platform !== 'win32' && (fs.statSync(options.key).mode & 0o077)) process.stderr.write('[release-index] warning: the private key file is readable by other accounts; chmod 600 it\n');
        const signed = index.signIndex(index.validateIndex(current), fs.readFileSync(options.key, 'utf8'));
        index.writeIndex(dir, signed.index, signed.signature);
        return { status: 0, result: { keyId: signed.index.signing.keyId, signature: index.SIGNATURE_FILE } };
    },

    verify(options) {
        const dir = options.positional[0];
        if (!dir) throw new Error('verify needs a release directory');
        const verifyOptions = { policy: options.policy || 'production' };
        const keys = options.lists.publicKey || [];
        if (keys.length) verifyOptions.publicKey = keys.map(file => fs.readFileSync(file, 'utf8'));
        if (options.keyList) verifyOptions.keyList = index.loadKeyList(options.keyList);
        else if (options.noKeyList !== true) verifyOptions.keyList = index.loadKeyList();
        if (options.target) verifyOptions.expectedTarget = options.target;
        if (options.abi) verifyOptions.nodeAbi = options.abi;
        if (options.currentVersion) verifyOptions.currentVersion = options.currentVersion;
        if (options.allowDowngrade) verifyOptions.allowDowngrade = true;
        if (options.requireFiles) verifyOptions.requireFiles = true;
        const result = index.verifyIndex(path.resolve(dir), verifyOptions);
        return { status: 0, result: { ok: true, code: null, message: 'verified', ...result } };
    },

    sums(options) {
        need(options, 'dir');
        const dir = path.resolve(options.dir);
        const lines = listFiles(dir).filter(name => name !== SUMS_FILE).map(name => `${sha256Of(path.join(dir, name))}  ${name}\n`);
        fs.writeFileSync(path.join(dir, SUMS_FILE), lines.join(''));
        return { status: 0, result: { file: SUMS_FILE, files: lines.length } };
    },

    notes(options) {
        need(options, 'dir', 'out');
        const dir = path.resolve(options.dir);
        const { index: current, signature } = index.readIndex(dir);
        index.validateIndex(current);
        const text = releaseNotes(current, { signed: Boolean(signature), expected: options.expected ? options.expected.split(',').filter(Boolean) : [] });
        fs.writeFileSync(options.out, text);
        return { status: 0, result: { notes: path.basename(options.out), partial: /\bPARTIAL RELEASE\b/.test(text), unsigned: /UNSIGNED DEVELOPMENT BUILD/.test(text) } };
    }
};

/** The GitHub release body (markdown). Says plainly when the release is partial or unsigned. */
function releaseNotes(current, { signed, expected = [] }) {
    const present = [...new Set(current.artifacts.map(artifact => artifact.target))].sort();
    const absent = expected.filter(target => !present.includes(target)).sort();
    const unsigned = current.artifacts.filter(artifact => artifact.signing.status !== 'signed');
    const lines = [];
    lines.push(`Goobster ${current.release.core} (${current.release.channel}), built from \`${current.release.sourceRevision.slice(0, 12)}\`.`);
    lines.push('');
    if (!signed || unsigned.length) {
        lines.push(`**${index.LABEL_UNSIGNED}.** ${unsigned.length} of ${current.artifacts.length} artifacts are not signed for production, ${signed ? 'the release index is signed' : 'the release index is not signed'}. A production verification (the default) refuses them; this is a prerelease for testing, not for people who install software they rely on.`);
        lines.push('');
    }
    if (absent.length) {
        lines.push(`**PARTIAL RELEASE.** No artifact was published for: ${absent.map(target => `\`${target}\``).join(', ')}. A failed target blocks publication of that target only.`);
        lines.push('');
    }
    lines.push('| Target | Artifact | Kind | Signing |');
    lines.push('| --- | --- | --- | --- |');
    for (const artifact of current.artifacts) {
        const state = artifact.signing.status === 'signed' ? `signed (${artifact.signing.method})` : `unsigned development build${artifact.signing.reason ? ` (${artifact.signing.reason})` : ''}`;
        lines.push(`| \`${artifact.target}\` | \`${artifact.file}\` | ${artifact.kind} | ${state} |`);
    }
    lines.push('');
    lines.push(`Verify: \`node scripts/release-index.js verify <dir> --policy production --public-key <trusted-key.pem>\`; \`SHA256SUMS\` covers every file. See documentation/release.md.`);
    return `${lines.join('\n')}\n`;
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
    let options;
    try {
        options = parseArgs(argv);
        if (!options.command || options.command === '-h' || options.command === '--help' || !COMMANDS[options.command]) {
            const source = fs.readFileSync(__filename, 'utf8');
            stdout.write(`${source.match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ ?\* ?/gm, '').trim()}\n`);
            return options.command && !['-h', '--help'].includes(options.command) ? 1 : 0;
        }
    } catch (error) {
        stderr.write(`release-index: ${error.message}\n`);
        return 1;
    }
    try {
        const { status, result } = await COMMANDS[options.command](options);
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (options.command === 'plan' && result.mode === 'blocked') stderr.write(`::error::RELEASE_BLOCKED_UNSIGNED: ${result.reason}\n`);
        return status;
    } catch (error) {
        const code = error && error.code && /^[A-Z][A-Z0-9_]+$/.test(String(error.code)) && (error.name === 'ReleaseIndexError' || error.name === 'PayloadError' || Object.values(index.CODES).includes(error.code)) ? error.code : null;
        if (code) {
            stdout.write(`${JSON.stringify({ ok: false, code, message: error.message }, null, 2)}\n`);
            return 2;
        }
        stderr.write(`release-index: ${error && error.message ? error.message : error}\n`);
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, planSigning, releaseNotes, main, COMMANDS, SUMS_FILE };
