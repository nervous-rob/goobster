#!/usr/bin/env node
'use strict';

/**
 * Build the Linux bootstrap artifacts from a built payload
 * (documentation/linux_install.md, issue #333).
 *
 *   node scripts/package-bootstrap.js --target linux-x64|linux-arm64 --payload <dir> --out <dir>
 *        [--public-key <pem>] [--no-appimage | --require-appimage] [--appdir-only] [--tools-dir <dir>]
 *
 * Outputs in <dir>:
 *   goobster-<version>-linux-<arch>[-dev].run       POSIX sh header + gzip tar of the payload
 *   Goobster-<version>-<arch>[-dev].AppImage         the same payload behind AppRun (xdg-open the wizard)
 *   bootstrap-report-<target>.json                   inputs, digests, sizes, what was skipped
 *
 * Both artifacts are UNSIGNED DEVELOPMENT BUILDS (the `-dev` suffix, the header banner, the
 * report) unless the payload carries a payload-manifest.sig that verifies against --public-key.
 * The `.run` and the report are deterministic: building the same payload twice gives the same
 * bytes (no timestamps; SOURCE_DATE_EPOCH, or a fixed constant, for archive times). The
 * AppImage is built by appimagetool, pinned by URL and SHA-256 in scripts/bootstrap-pins.json;
 * when the tool cannot be fetched or verified the report says APPIMAGE_SKIPPED with the reason.
 * Nothing unpinned is ever executed. --require-appimage turns a skip into a failure (CI).
 *
 * Node built-ins only, plus scripts/lib (no dependency of the application).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const stage = require('./lib/bootstrapStage');
const { download } = require('./lib/download');

const REPO = path.resolve(__dirname, '..');
const TARGETS = Object.freeze({ 'linux-x64': { arch: 'x64', machine: 'x86_64' }, 'linux-arm64': { arch: 'arm64', machine: 'aarch64' } });
const PINS_FILE = path.join(__dirname, 'bootstrap-pins.json');
const RUN_TEMPLATE = path.join(REPO, 'bootstrap', 'linux', 'install.sh');
const APPRUN_TEMPLATE = path.join(REPO, 'bootstrap', 'linux', 'appimage', 'AppRun');
const DESKTOP_FILE = path.join(REPO, 'bootstrap', 'linux', 'appimage', 'goobster.desktop');

function usage() {
    return 'Usage: node scripts/package-bootstrap.js --target linux-x64|linux-arm64 --payload <dir> --out <dir> '
        + '[--public-key <pem>] [--no-appimage | --require-appimage] [--appdir-only] [--tools-dir <dir>]';
}

function parseArgs(argv) {
    const options = { target: null, payload: null, out: null, publicKey: null, appimage: true, requireAppimage: false, appdirOnly: false, toolsDir: null, help: false };
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
        else if (arg === '--tools-dir') options.toolsDir = value();
        else if (arg === '--no-appimage') options.appimage = false;
        else if (arg === '--require-appimage') options.requireAppimage = true;
        else if (arg === '--appdir-only') options.appdirOnly = true;
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

/** Is the payload's signature valid under the supplied key? A missing key or signature is simply "not signed". */
function signingState(payloadDir, publicKeyFile) {
    const sigFile = path.join(payloadDir, 'payload-manifest.sig');
    if (!fs.existsSync(sigFile)) return { signed: false, reason: 'NO_SIGNATURE', keyId: null };
    if (!publicKeyFile) return { signed: false, reason: 'NO_PUBLIC_KEY', keyId: null };
    const { verifyPayload } = require('./lib/payloadStage');
    try {
        const result = verifyPayload(payloadDir, { publicKey: fs.readFileSync(publicKeyFile, 'utf8'), devMode: false, hash: false });
        return { signed: Boolean(result.signed), reason: result.signed ? null : 'NOT_VERIFIED', keyId: result.keyId || null };
    } catch (error) {
        return { signed: false, reason: error && error.code ? String(error.code) : 'SIGNATURE_UNVERIFIED', keyId: null };
    }
}

// ---------------------------------------------------------------- the icon
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** A flat 128x128 rounded badge: the same bytes every build (the AppImage needs an icon, not a brand). */
function iconPng() {
    const size = 128;
    const rows = [];
    for (let y = 0; y < size; y++) {
        const row = Buffer.alloc(1 + size * 4);
        for (let x = 0; x < size; x++) {
            const dx = Math.max(Math.abs(x - 63.5) - 40, 0);
            const dy = Math.max(Math.abs(y - 63.5) - 40, 0);
            const inside = Math.hypot(dx, dy) <= 22;
            const ring = Math.hypot(x - 63.5, y - 63.5) < 26 && Math.hypot(x - 63.5, y - 63.5) > 16;
            const offset = 1 + x * 4;
            if (!inside) row.writeUInt32BE(0x00000000, offset);
            else if (ring) row.writeUInt32BE(0xffffffff, offset);
            else row.writeUInt32BE(0x2f6fdbff, offset);
        }
        rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// ------------------------------------------------------------- the AppImage
function copyTree(from, to) {
    const result = childProcess.spawnSync('cp', ['-a', '--', from, to], { stdio: 'pipe' });
    if (result.status !== 0) throw new Error(`could not copy the payload into the AppDir: ${String(result.stderr).slice(0, 200)}`);
}

function buildAppDir({ payloadDir, appDir, identity, build, signed, publicKeyFile, env = process.env }) {
    fs.rmSync(appDir, { recursive: true, force: true });
    const share = path.join(appDir, 'usr', 'share', 'goobster');
    fs.mkdirSync(share, { recursive: true });
    copyTree(payloadDir, path.join(share, 'payload'));
    if (signed && publicKeyFile) fs.copyFileSync(publicKeyFile, path.join(share, 'release-key.pem'));
    const appRun = fs.readFileSync(APPRUN_TEMPLATE, 'utf8')
        .replace(/@PAYLOAD_DIGEST@/g, identity.payloadDigest)
        .replace(/@BUILD@/g, build)
        .replace(/@SIGNED@/g, signed ? '1' : '0');
    fs.writeFileSync(path.join(appDir, 'AppRun'), appRun, { mode: 0o755 });
    fs.chmodSync(path.join(appDir, 'AppRun'), 0o755);
    fs.copyFileSync(DESKTOP_FILE, path.join(appDir, 'goobster.desktop'));
    fs.writeFileSync(path.join(appDir, 'goobster.png'), iconPng());
    fs.writeFileSync(path.join(appDir, '.DirIcon'), iconPng());
    const epoch = String(env.SOURCE_DATE_EPOCH || stage.FIXED_MTIME);
    const touched = childProcess.spawnSync('find', [appDir, '-exec', 'touch', '-h', '-d', `@${epoch}`, '{}', '+'], { stdio: 'pipe' });
    if (touched.status !== 0) throw new Error('could not normalise the AppDir timestamps');
}

async function fetchPinned({ pin, destination, executable }) {
    if (fs.existsSync(destination) && sha256File(destination) === pin.sha256) {
        if (executable) fs.chmodSync(destination, 0o755);
        return { ok: true, cached: true };
    }
    try {
        await download(pin.url, destination);
    } catch (error) {
        fs.rmSync(destination, { force: true });
        return { ok: false, reason: 'TOOL_UNAVAILABLE', detail: error && error.message ? String(error.message).slice(0, 160) : 'download failed' };
    }
    if (sha256File(destination) !== pin.sha256) {
        fs.rmSync(destination, { force: true });
        return { ok: false, reason: 'TOOL_HASH_MISMATCH', detail: `the download of ${path.basename(pin.url)} does not match its pinned SHA-256` };
    }
    if (executable) fs.chmodSync(destination, 0o755);
    return { ok: true, cached: false };
}

/**
 * @returns {Promise<{ built: boolean, file?: string, reason?: string, detail?: string, tool?: Object }>}
 */
async function buildAppImage({ options, target, identity, build, signed, publicKeyFile, outFile, appDir, env }) {
    const hostMachine = os.arch() === 'arm64' ? 'arm64' : (os.arch() === 'x64' ? 'x64' : os.arch());
    if (process.platform !== 'linux') return { built: false, reason: 'HOST_NOT_LINUX', detail: 'appimagetool only runs on Linux' };
    if (hostMachine !== TARGETS[target].arch) {
        return { built: false, reason: 'HOST_ARCH_MISMATCH', detail: `building the ${TARGETS[target].arch} AppImage needs a ${TARGETS[target].arch} host` };
    }
    const pins = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
    const arch = TARGETS[target].arch;
    const toolPin = pins.appimagetool && pins.appimagetool[arch];
    const runtimePin = pins.appimageRuntime && pins.appimageRuntime[arch];
    if (!toolPin || !runtimePin) return { built: false, reason: 'NO_PIN', detail: `scripts/bootstrap-pins.json has no pin for ${arch}` };
    const toolsDir = options.toolsDir ? path.resolve(options.toolsDir) : path.join(os.tmpdir(), 'goobster-bootstrap-tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    const tool = path.join(toolsDir, `appimagetool-${pins.appimagetool.version}-${arch}`);
    const runtime = path.join(toolsDir, `type2-runtime-${arch}-${runtimePin.sha256.slice(0, 12)}`);
    const gotTool = await fetchPinned({ pin: toolPin, destination: tool, executable: true });
    if (!gotTool.ok) return { built: false, reason: gotTool.reason, detail: gotTool.detail };
    const gotRuntime = await fetchPinned({ pin: runtimePin, destination: runtime, executable: false });
    if (!gotRuntime.ok) return { built: false, reason: gotRuntime.reason, detail: gotRuntime.detail };

    buildAppDir({ payloadDir: options.payloadDir, appDir, identity, build, signed, publicKeyFile, env });
    fs.rmSync(outFile, { force: true });
    // appimagetool stamps mksquashfs itself and mksquashfs refuses SOURCE_DATE_EPOCH on top of that.
    const toolEnv = { ...env, ARCH: TARGETS[target].machine, APPIMAGE_EXTRACT_AND_RUN: '1' };
    delete toolEnv.SOURCE_DATE_EPOCH;
    const result = childProcess.spawnSync(tool, ['--runtime-file', runtime, appDir, outFile], {
        env: toolEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0 || !fs.existsSync(outFile)) {
        fs.rmSync(outFile, { force: true });
        return { built: false, reason: 'APPIMAGETOOL_FAILED', detail: `appimagetool exited ${result.status === null ? 'abnormally' : result.status}: ${String(result.stderr || result.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}` };
    }
    fs.chmodSync(outFile, 0o755);
    return { built: true, file: outFile, tool: { name: 'appimagetool', version: pins.appimagetool.version, sha256: toolPin.sha256, runtimeSha256: runtimePin.sha256 } };
}

// ------------------------------------------------------------------ driver
/**
 * @param {Object} options parsed options
 * @param {{ env?: Object, log?: (line: string) => void }} [io]
 * @returns {Promise<{ report: Object, reportFile: string, runFile: string, appImageFile: string|null }>}
 */
async function build(options, { env = process.env, log = () => {} } = {}) {
    const target = options.target;
    if (!TARGETS[target]) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
    if (!options.payload || !options.out) throw new Error('--payload and --out are required');
    const payloadDir = fs.realpathSync(path.resolve(options.payload));
    const outDir = path.resolve(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const identity = stage.readPayloadIdentity(payloadDir);
    if (identity.target !== target) throw new Error(`the payload was built for ${identity.target}, not ${target}`);
    if (!identity.version) throw new Error('the payload manifest records no release version');
    const publicKeyFile = options.publicKey ? path.resolve(options.publicKey) : null;
    if (publicKeyFile && !fs.existsSync(publicKeyFile)) throw new Error('--public-key does not name a readable file');

    const signing = signingState(payloadDir, publicKeyFile);
    const buildKind = signing.signed ? 'release' : 'dev';
    const suffix = signing.signed ? '' : '-dev';
    const arch = TARGETS[target].arch;
    const runName = `goobster-${identity.version}-linux-${arch}${suffix}.run`;
    const appImageName = `Goobster-${identity.version}-${arch}${suffix}.AppImage`;
    const runFile = path.join(outDir, runName);
    const reportFile = path.join(outDir, `bootstrap-report-${target}.json`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-bootstrap-build-'));
    const skipped = [];
    const artifacts = [];
    let archive;
    let runInfo;
    let appImageFile = null;
    let appImageInfo = null;
    try {
        log(`archiving ${identity.payloadDigest.slice(0, 12)} (${target})`);
        const archiveFile = path.join(work, 'payload.tar.gz');
        archive = await stage.writeArchive(payloadDir, archiveFile, { env });
        const template = fs.readFileSync(RUN_TEMPLATE, 'utf8');
        runInfo = stage.assembleRun({
            template,
            archiveFile,
            outFile: runFile,
            values: {
                VERSION: identity.version,
                TARGET: target,
                ARCH: arch,
                PAYLOAD_DIGEST: identity.payloadDigest,
                ARCHIVE_SHA256: archive.sha256,
                SIGNED: signing.signed ? '1' : '0',
                BUILD: buildKind,
                PUBLIC_KEY_B64: signing.signed && publicKeyFile ? fs.readFileSync(publicKeyFile).toString('base64') : ''
            }
        });
        artifacts.push({ kind: 'run', name: runName, bytes: runInfo.bytes, sha256: runInfo.sha256 });

        if (options.appimage) {
            const appDir = options.appdirOnly ? path.join(outDir, `Goobster-${arch}.AppDir`) : path.join(work, 'AppDir');
            if (options.appdirOnly) {
                buildAppDir({ payloadDir, appDir, identity, build: buildKind, signed: signing.signed, publicKeyFile, env });
                skipped.push({ code: 'APPIMAGE_SKIPPED', reason: 'APPDIR_ONLY', detail: 'only the AppDir was assembled' });
            } else {
                const outFile = path.join(outDir, appImageName);
                const result = await buildAppImage({ options: { ...options, payloadDir }, target, identity, build: buildKind, signed: signing.signed, publicKeyFile, outFile, appDir, env });
                if (result.built) {
                    appImageFile = outFile;
                    appImageInfo = result.tool;
                    artifacts.push({ kind: 'appimage', name: appImageName, bytes: fs.statSync(outFile).size, sha256: sha256File(outFile) });
                } else {
                    skipped.push({ code: 'APPIMAGE_SKIPPED', reason: result.reason, detail: result.detail });
                    log(`APPIMAGE_SKIPPED: ${result.reason} (${result.detail})`);
                }
            }
        } else {
            skipped.push({ code: 'APPIMAGE_SKIPPED', reason: 'NOT_REQUESTED', detail: '--no-appimage' });
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }

    const report = {
        schema: 1,
        target,
        version: identity.version,
        build: buildKind,
        signed: signing.signed,
        signing: { keyId: signing.keyId, unsignedReason: signing.signed ? null : signing.reason },
        label: signing.signed ? 'release' : 'UNSIGNED DEVELOPMENT BUILD',
        payloadDigest: identity.payloadDigest,
        archive: { sha256: archive.sha256, bytes: archive.bytes, entries: archive.entries },
        header: { bytes: runInfo.headerBytes },
        artifacts,
        appimage: appImageInfo ? { tool: appImageInfo } : null,
        skipped
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    return { report, reportFile, runFile, appImageFile };
}

async function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${error.message}\n${usage()}\n`);
        return 2;
    }
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return 0;
    }
    try {
        const outcome = await build(options, { log: line => process.stderr.write(`[bootstrap] ${line}\n`) });
        process.stdout.write(`${outcome.report.label}\n`);
        for (const item of outcome.report.artifacts) process.stdout.write(`${item.kind.padEnd(9)} ${item.name}  ${item.bytes} bytes  sha256 ${item.sha256}\n`);
        for (const item of outcome.report.skipped) process.stdout.write(`${item.code}: ${item.reason} (${item.detail})\n`);
        process.stdout.write(`report    ${path.basename(outcome.reportFile)}\n`);
        if (options.requireAppimage && !outcome.appImageFile) {
            process.stderr.write('The AppImage was required but was not built.\n');
            return 1;
        }
        return 0;
    } catch (error) {
        process.stderr.write(`package-bootstrap: ${error && error.message ? error.message : error}\n`);
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, build, iconPng, signingState, TARGETS, PINS_FILE };
