#!/usr/bin/env node
'use strict';

/**
 * Build the macOS bootstrap artifacts from a built payload
 * (documentation/macos_install.md, issue #332).
 *
 *   node scripts/package-bootstrap-darwin.js --target darwin-arm64|darwin-x64 --payload <dir> --out <dir>
 *        [--public-key <pem>] [--no-pkg | --require-pkg] [--allow-foreign-payload]
 *        [--product-sign <identity>] [--notary-profile <name>]
 *
 * Outputs in <dir>:
 *   goobster-<version>-darwin-<arch>[-dev].tar.gz   the per-user installer: install.command + the payload
 *   goobster-<version>-darwin-<arch>[-dev].pkg      the machine installer (macOS hosts only: pkgbuild, productbuild)
 *   macos-pkg-<arch>/                               the Distribution.xml, scripts/postinstall and resources the pkg is built from
 *   bootstrap-report-darwin-<arch>.json             inputs, digests, sizes, what was skipped
 *
 * Both artifacts are UNSIGNED DEVELOPMENT BUILDS (the `-dev` suffix, the notices, the report) unless the
 * payload carries a payload-manifest.sig that verifies against --public-key. The tar.gz, the tree and the
 * report are deterministic: the same payload gives the same bytes. The pkg is not (pkgbuild stamps it).
 *
 * `pkgbuild` and `productbuild` exist only on macOS; elsewhere the report says PKG_SKIPPED with the reason and
 * the tar.gz and the tree are still produced. --require-pkg turns a skip into a failure (CI).
 *
 * Apple signing is wired and off by default (installer plan P5.1): --product-sign <identity> runs
 * `productsign`, --notary-profile <name> runs `xcrun notarytool submit --wait` and `stapler`. Neither signs
 * the payload's own files: codesigning the Node binary and native addons happens before the payload manifest is
 * signed, in the payload build, not here.
 *
 * --allow-foreign-payload accepts a payload built for another target (a Linux payload on a Linux machine) so the
 * archive, the tree and the report can be exercised without a macOS payload. It is for the packager's own tests:
 * the result is labelled foreign in the report, never reports a signature and never builds the pkg.
 *
 * Node built-ins only, plus scripts/lib (no dependency of the application).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const stage = require('./lib/bootstrapStage');
const darwin = require('./lib/bootstrap/darwin');

const REPO = path.resolve(__dirname, '..');
const TARGETS = Object.freeze({ 'darwin-x64': { arch: 'x64', machine: 'x86_64' }, 'darwin-arm64': { arch: 'arm64', machine: 'arm64' } });

function usage() {
    return 'Usage: node scripts/package-bootstrap-darwin.js --target darwin-arm64|darwin-x64 --payload <dir> --out <dir> '
        + '[--public-key <pem>] [--no-pkg | --require-pkg] [--allow-foreign-payload] [--product-sign <identity>] [--notary-profile <name>]';
}

function parseArgs(argv) {
    const options = { target: null, payload: null, out: null, publicKey: null, pkg: true, requirePkg: false, allowForeignPayload: false, productSign: null, notaryProfile: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (next === undefined || next === '') throw new Error(`${arg} needs a value`);
            return next;
        };
        if (arg === '--target') options.target = value();
        else if (arg === '--payload') options.payload = value();
        else if (arg === '--out') options.out = value();
        else if (arg === '--public-key') options.publicKey = value();
        else if (arg === '--product-sign') options.productSign = value();
        else if (arg === '--notary-profile') options.notaryProfile = value();
        else if (arg === '--no-pkg') options.pkg = false;
        else if (arg === '--require-pkg') options.requirePkg = true;
        else if (arg === '--allow-foreign-payload') options.allowForeignPayload = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

/**
 * @param {Object} options parsed options
 * @param {{ env?: Object, log?: (line: string) => void }} [io]
 * @returns {Promise<{ report: Object, reportFile: string, tarFile: string, pkgFile: string|null, treeDir: string }>}
 */
async function build(options, { env = process.env, log = () => {} } = {}) {
    const target = options.target;
    if (!TARGETS[target]) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
    if (!options.payload || !options.out) throw new Error('--payload and --out are required');
    const payloadDir = fs.realpathSync(path.resolve(options.payload));
    const outDir = path.resolve(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const identity = stage.readPayloadIdentity(payloadDir);
    const foreign = identity.target !== target;
    if (foreign && !options.allowForeignPayload) throw new Error(`the payload was built for ${identity.target}, not ${target}`);
    if (!identity.version) throw new Error('the payload manifest records no release version');
    darwin.assertVersion(identity.version);
    const publicKeyFile = options.publicKey ? path.resolve(options.publicKey) : null;
    if (publicKeyFile && !fs.existsSync(publicKeyFile)) throw new Error('--public-key does not name a readable file');

    const { signingState } = require('./package-bootstrap');
    const signing = foreign ? { signed: false, reason: 'FOREIGN_PAYLOAD', keyId: null } : signingState(payloadDir, publicKeyFile);
    const buildKind = signing.signed ? 'release' : 'dev';
    const suffix = signing.signed ? '' : '-dev';
    const arch = TARGETS[target].arch;
    const base = `goobster-${identity.version}-darwin-${arch}${suffix}`;
    const tarFile = path.join(outDir, `${base}.tar.gz`);
    const pkgName = `${base}.pkg`;
    const pkgFile = path.join(outDir, pkgName);
    const treeName = `macos-pkg-${arch}`;
    const treeDir = path.join(outDir, treeName);
    const reportFile = path.join(outDir, `bootstrap-report-${target}.json`);
    const publicKeyPem = signing.signed && publicKeyFile ? fs.readFileSync(publicKeyFile, 'utf8') : null;

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-bootstrap-darwin-'));
    const skipped = [];
    const artifacts = [];
    let archive;
    let pkgInfo = null;
    let treeInfo;
    try {
        log(`archiving ${identity.payloadDigest.slice(0, 12)} (${target})`);
        const folderName = base;
        const folder = path.join(work, 'tar', folderName);
        darwin.writeTarFolder({ dir: folder, identity, arch, build: buildKind, signed: signing.signed, payloadDir, publicKeyPem });
        archive = await stage.writeArchive(path.join(work, 'tar'), tarFile, { env });
        fs.chmodSync(tarFile, 0o644);
        artifacts.push({ kind: 'tar.gz', name: path.basename(tarFile), bytes: archive.bytes, sha256: archive.sha256 });

        const licenseFile = path.join(REPO, 'LICENSE');
        const tree = darwin.writePkgTree({
            dir: treeDir,
            identity,
            arch,
            build: buildKind,
            signed: signing.signed,
            publicKeyB64: publicKeyPem ? Buffer.from(publicKeyPem).toString('base64') : '',
            licenseFile
        });
        treeInfo = {
            name: treeName,
            files: tree.files.map(item => ({ path: item.path.split(path.sep).join('/'), mode: item.mode.toString(8), sha256: sha256File(path.join(treeDir, item.path)) }))
        };

        if (!options.pkg) {
            skipped.push({ code: 'PKG_SKIPPED', reason: 'NOT_REQUESTED', detail: '--no-pkg' });
        } else if (foreign) {
            skipped.push({ code: 'PKG_SKIPPED', reason: 'FOREIGN_PAYLOAD', detail: `the payload is for ${identity.target}, not ${target}` });
        } else {
            const result = darwin.buildPkg({
                treeDir,
                payloadDir,
                identity,
                outFile: pkgFile,
                workDir: work,
                env,
                productSignIdentity: options.productSign,
                notaryProfile: options.notaryProfile
            });
            if (result.built) {
                pkgInfo = { tools: result.tools, signing: result.signing };
                artifacts.push({ kind: 'pkg', name: pkgName, bytes: fs.statSync(pkgFile).size, sha256: sha256File(pkgFile) });
            } else {
                skipped.push({ code: 'PKG_SKIPPED', reason: result.reason, detail: result.detail });
                log(`PKG_SKIPPED: ${result.reason} (${result.detail})`);
            }
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }

    const label = foreign
        ? `UNSIGNED DEVELOPMENT BUILD (FOREIGN PAYLOAD: ${identity.target})`
        : (signing.signed ? 'release' : 'UNSIGNED DEVELOPMENT BUILD');
    const report = {
        schema: 1,
        target,
        version: identity.version,
        build: buildKind,
        signed: signing.signed,
        signing: { keyId: signing.keyId, unsignedReason: signing.signed ? null : signing.reason },
        label,
        foreignPayload: foreign ? { payloadTarget: identity.target } : null,
        payloadDigest: identity.payloadDigest,
        archive: { sha256: archive.sha256, bytes: archive.bytes, entries: archive.entries },
        artifacts,
        pkgTree: treeInfo,
        pkg: pkgInfo,
        appleSigning: {
            productsign: { requested: Boolean(options.productSign), done: Boolean(pkgInfo && pkgInfo.signing.productsign.done) },
            notarization: { requested: Boolean(options.notaryProfile), done: Boolean(pkgInfo && pkgInfo.signing.notarization.done) }
        },
        skipped
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    return { report, reportFile, tarFile, pkgFile: pkgInfo ? pkgFile : null, treeDir };
}

async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        stderr.write(`${error.message}\n${usage()}\n`);
        return 2;
    }
    if (options.help) {
        stdout.write(`${usage()}\n`);
        return 0;
    }
    try {
        const outcome = await build(options, { env, log: line => stderr.write(`[bootstrap] ${line}\n`) });
        stdout.write(`${outcome.report.label}\n`);
        for (const item of outcome.report.artifacts) stdout.write(`${item.kind.padEnd(9)} ${item.name}  ${item.bytes} bytes  sha256 ${item.sha256}\n`);
        stdout.write(`tree      ${outcome.report.pkgTree.name}/ (${outcome.report.pkgTree.files.length} files)\n`);
        for (const item of outcome.report.skipped) stdout.write(`${item.code}: ${item.reason} (${item.detail})\n`);
        stdout.write(`report    ${path.basename(outcome.reportFile)}\n`);
        if (options.requirePkg && !outcome.pkgFile) {
            stderr.write('The pkg was required but was not built.\n');
            return 1;
        }
        return 0;
    } catch (error) {
        stderr.write(`package-bootstrap-darwin: ${error && error.message ? error.message : error}\n`);
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, build, main, TARGETS };
