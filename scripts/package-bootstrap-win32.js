#!/usr/bin/env node
'use strict';

/**
 * Build the Windows installer from a built win32-x64 payload
 * (documentation/windows_install.md, issue #331).
 *
 *   node scripts/package-bootstrap-win32.js --target win32-x64 --payload <dir> --out <dir>
 *        [--public-key <pem>] [--makensis <path>] [--tools-dir <dir>] [--winsw-file <path>]
 *        [--require-installer] [--signtool <path> --sign-thumbprint <sha1> --sign-timestamp-url <https url>]
 *
 * Outputs in <dir>:
 *   goobster-<version>-win32-x64[-dev].exe       NSIS installer: the payload and the pinned service host, unpacked
 *                                                under the person's profile, then the manager's own Windows entry
 *   bootstrap-report-win32-x64.json              inputs, digests, sizes, what was skipped
 *
 * The installer is an UNSIGNED DEVELOPMENT BUILD (the `-dev` suffix, the version resource, the
 * report) unless the payload carries a payload-manifest.sig that verifies against --public-key.
 * It is also not Authenticode-signed unless --signtool is given; the hook is wired and off.
 * The build is deterministic where the toolchain allows: the file list is sorted bytewise, file
 * dates are not stored (SetDateSave off), the icon and the version resource derive from the
 * manifest, and nothing records the build time, so the same payload, host and makensis give the
 * same bytes. The service host (WinSW) is pinned by URL and SHA-256 in scripts/bootstrap-pins.json;
 * when it cannot be fetched or does not match, or makensis is missing, the report says
 * INSTALLER_SKIPPED with the reason and nothing unpinned is ever embedded. --require-installer
 * turns a skip into a failure (CI).
 *
 * Node built-ins only, plus scripts/lib (no dependency of the application).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const stage = require('./lib/bootstrapStage');
const { download } = require('./lib/download');
const { signingState, PINS_FILE } = require('./package-bootstrap');

const REPO = path.resolve(__dirname, '..');
const TARGETS = Object.freeze({ 'win32-x64': { arch: 'x64' } });
const TEMPLATE = path.join(REPO, 'bootstrap', 'windows', 'installer.nsi');
const HOST_NAME = 'goobster-service.exe';
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const FORBIDDEN_NAME = /[\u0000-\u001f"*?$<>|]/;

class PackageError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PackageError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new PackageError(code, message); };

function usage() {
    return 'Usage: node scripts/package-bootstrap-win32.js --target win32-x64 --payload <dir> --out <dir> '
        + '[--public-key <pem>] [--makensis <path>] [--tools-dir <dir>] [--winsw-file <path>] [--require-installer] '
        + '[--signtool <path> --sign-thumbprint <sha1> --sign-timestamp-url <https url>]';
}

function parseArgs(argv) {
    const options = {
        target: null, payload: null, out: null, publicKey: null, makensis: null, toolsDir: null, winswFile: null,
        requireInstaller: false, signtool: null, signThumbprint: null, signTimestampUrl: null, help: false
    };
    const VALUES = {
        '--target': 'target', '--payload': 'payload', '--out': 'out', '--public-key': 'publicKey', '--makensis': 'makensis',
        '--tools-dir': 'toolsDir', '--winsw-file': 'winswFile', '--signtool': 'signtool', '--sign-thumbprint': 'signThumbprint',
        '--sign-timestamp-url': 'signTimestampUrl'
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (VALUES[arg]) {
            const next = argv[++i];
            if (next === undefined || next === '') throw new Error(`${arg} needs a value`);
            options[VALUES[arg]] = next;
        } else if (arg === '--require-installer') options.requireInstaller = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`unknown option ${arg}`);
    }
    if (options.signtool && !(options.signThumbprint && options.signTimestampUrl)) {
        throw new Error('--signtool needs --sign-thumbprint and --sign-timestamp-url');
    }
    if (options.signThumbprint && !/^[0-9a-fA-F]{40}$/.test(options.signThumbprint)) throw new Error('--sign-thumbprint must be a 40-hex SHA-1 thumbprint');
    if (options.signTimestampUrl && !/^https:\/\/[^\s"]+$/.test(options.signTimestampUrl)) throw new Error('--sign-timestamp-url must be an https URL');
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

// ---------------------------------------------------------------- the icon
/** A flat rounded badge as a classic .ico (BMP entries: every makensis reads them). Same bytes every build. */
function iconIco(sizes = [16, 32, 48]) {
    const images = sizes.map((size) => {
        const header = Buffer.alloc(40);
        header.writeUInt32LE(40, 0);
        header.writeInt32LE(size, 4);
        header.writeInt32LE(size * 2, 8);
        header.writeUInt16LE(1, 12);
        header.writeUInt16LE(32, 14);
        header.writeUInt32LE(size * size * 4, 20);
        const pixels = Buffer.alloc(size * size * 4);
        const centre = (size - 1) / 2;
        const half = size * 0.3125;
        const corner = size * 0.172;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = Math.max(Math.abs(x - centre) - half, 0);
                const dy = Math.max(Math.abs(y - centre) - half, 0);
                const inside = Math.hypot(dx, dy) <= corner;
                const radius = Math.hypot(x - centre, y - centre);
                const ring = radius < size * 0.203 && radius > size * 0.125;
                const row = size - 1 - y;
                const offset = (row * size + x) * 4;
                if (!inside) continue;
                const [b, g, r] = ring ? [0xff, 0xff, 0xff] : [0xdb, 0x6f, 0x2f];
                pixels[offset] = b;
                pixels[offset + 1] = g;
                pixels[offset + 2] = r;
                pixels[offset + 3] = 0xff;
            }
        }
        const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
        return Buffer.concat([header, pixels, mask]);
    });
    const directory = Buffer.alloc(6 + sizes.length * 16);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(sizes.length, 4);
    let offset = directory.length;
    sizes.forEach((size, index) => {
        const at = 6 + index * 16;
        directory[at] = size;
        directory[at + 1] = size;
        directory.writeUInt16LE(1, at + 4);
        directory.writeUInt16LE(32, at + 6);
        directory.writeUInt32LE(images[index].length, at + 8);
        directory.writeUInt32LE(offset, at + 12);
        offset += images[index].length;
    });
    return Buffer.concat([directory, ...images]);
}

// ------------------------------------------------------- the build header
function versionNumeric(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match) fail('VERSION_UNSUPPORTED', `the release version "${version}" does not start with major.minor.patch`);
    const part = value => Math.min(Number(value), 65535);
    return `${part(match[1])}.${part(match[2])}.${part(match[3])}.0`;
}

/**
 * The payload's files and directories, in one deterministic order: a directory's files
 * (bytewise by name), then its subdirectories. Symbolic links and names NSIS would read as
 * something else are refused, never skipped.
 * @returns {Array<{ dir: string, files: string[] }>} `dir` is '/'-separated, relative, '' for the root
 */
function listPayload(payloadDir) {
    const out = [];
    const walk = (relative) => {
        const absolute = relative ? path.join(payloadDir, ...relative.split('/')) : payloadDir;
        const entries = fs.readdirSync(absolute, { withFileTypes: true })
            .sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
        const files = [];
        const dirs = [];
        for (const entry of entries) {
            if (FORBIDDEN_NAME.test(entry.name)) fail('PAYLOAD_NAME_UNSUPPORTED', `a payload file name holds a character the installer script cannot carry (${JSON.stringify(entry.name.slice(0, 60))})`);
            if (entry.isSymbolicLink()) fail('PAYLOAD_SYMLINK', `the payload holds a symbolic link (${entry.name.slice(0, 60)}); a Windows payload has none`);
            if (entry.isDirectory()) dirs.push(entry.name);
            else if (entry.isFile()) files.push(entry.name);
            else fail('PAYLOAD_ENTRY_UNSUPPORTED', `the payload holds an entry that is neither a file nor a directory (${entry.name.slice(0, 60)})`);
        }
        out.push({ dir: relative, files });
        for (const name of dirs) walk(relative ? `${relative}/${name}` : name);
    };
    walk('');
    return out;
}

const nsisString = value => `"${String(value)}"`;
const nsisTarget = relative => relative.split('/').join('\\');

/**
 * @param {Object} input
 * @param {Array<{ dir: string, files: string[] }>} input.listing
 */
function renderHeader({ version, payloadDigest, build, signed, label, outFile, iconFile, payloadDir, hostFile, scriptDir, listing }) {
    if (!VERSION_PATTERN.test(version)) fail('VERSION_UNSUPPORTED', 'the release version holds characters an installer name cannot carry');
    if (!/^[0-9a-f]{64}$/.test(payloadDigest)) fail('PAYLOAD_DIGEST_MISSING', 'the payload digest is not a SHA-256');
    const lines = [
        '; Written by scripts/package-bootstrap-win32.js. Do not edit.',
        `!define VERSION ${nsisString(version)}`,
        `!define VERSION_NUMERIC ${nsisString(versionNumeric(version))}`,
        `!define PAYLOAD_DIGEST ${nsisString(payloadDigest)}`,
        `!define BUILD ${nsisString(build)}`,
        `!define SIGNED ${nsisString(signed ? '1' : '0')}`,
        `!define LABEL ${nsisString(label)}`,
        `!define OUTFILE ${nsisString(outFile)}`,
        `!define ICON_FILE ${nsisString(iconFile)}`,
        '!macro BUILD_PAYLOAD_FILES',
        `    !cd ${nsisString(payloadDir)}`
    ];
    for (const { dir, files } of listing) {
        lines.push(`    SetOutPath ${nsisString(dir ? `$Stage\\payload\\${nsisTarget(dir)}` : '$Stage\\payload')}`);
        for (const name of files) {
            const relative = dir ? `${dir}/${name}` : name;
            lines.push(`    File ${nsisString(relative.split('/').join(path.sep))}`);
        }
    }
    lines.push(`    !cd ${nsisString(path.dirname(hostFile))}`);
    lines.push(`    SetOutPath ${nsisString('$Stage\\service-host')}`);
    lines.push(`    File /oname=${HOST_NAME} ${nsisString(path.basename(hostFile))}`);
    lines.push(`    !cd ${nsisString(scriptDir)}`);
    lines.push('!macroend', '');
    return lines.join('\n');
}

// ------------------------------------------------------------- the tools
async function fetchPinned({ pin, destination, doDownload = download }) {
    if (fs.existsSync(destination) && sha256File(destination) === pin.sha256) return { ok: true, cached: true };
    try {
        await doDownload(pin.url, destination);
    } catch (error) {
        fs.rmSync(destination, { force: true });
        return { ok: false, reason: 'WINSW_UNAVAILABLE', detail: error && error.message ? String(error.message).slice(0, 160) : 'download failed' };
    }
    if (sha256File(destination) !== pin.sha256) {
        fs.rmSync(destination, { force: true });
        return { ok: false, reason: 'WINSW_HASH_MISMATCH', detail: `the download of ${path.basename(pin.url)} does not match its pinned SHA-256` };
    }
    return { ok: true, cached: false };
}

/** The service host the installer carries: a local file checked against the pin, else the pinned download. */
async function resolveHost({ options, pin, toolsDir, doDownload }) {
    if (options.winswFile) {
        const file = path.resolve(options.winswFile);
        if (!fs.existsSync(file)) return { ok: false, reason: 'WINSW_UNAVAILABLE', detail: '--winsw-file does not name a readable file' };
        if (sha256File(file) !== pin.sha256) return { ok: false, reason: 'WINSW_HASH_MISMATCH', detail: '--winsw-file does not match the pinned SHA-256' };
        return { ok: true, file };
    }
    fs.mkdirSync(toolsDir, { recursive: true });
    const file = path.join(toolsDir, `winsw-${pin.version}-${pin.file}`);
    const got = await fetchPinned({ pin, destination: file, doDownload });
    return got.ok ? { ok: true, file } : got;
}

function findMakensis({ options, env, platform = process.platform, exists = fs.existsSync }) {
    const explicit = options.makensis || env.MAKENSIS;
    if (explicit) return exists(explicit) ? path.resolve(explicit) : null;
    const names = platform === 'win32' ? ['makensis.exe'] : ['makensis'];
    const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    if (platform === 'win32') {
        for (const root of [env['ProgramFiles(x86)'], env.ProgramFiles, env.ChocolateyInstall && path.join(env.ChocolateyInstall, 'bin')].filter(Boolean)) {
            dirs.push(path.join(root, 'NSIS'), root);
        }
    }
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (exists(candidate)) return candidate;
        }
    }
    return null;
}

function makensisVersion(makensis, run = childProcess.spawnSync) {
    const result = run(makensis, ['-VERSION'], { encoding: 'utf8' });
    const text = String(result.stdout || '').trim();
    return result.status === 0 && /^v?[0-9][0-9A-Za-z.\-+]{0,30}$/.test(text) ? text.replace(/^v/, '') : 'unknown';
}

// ------------------------------------------------------------------ driver
/**
 * @param {Object} options parsed options
 * @param {{ env?: Object, log?: (line: string) => void, run?: Function, doDownload?: Function, pins?: Object }} [io]
 * @returns {Promise<{ report: Object, reportFile: string, exeFile: string|null }>}
 */
async function build(options, { env = process.env, log = () => {}, run = childProcess.spawnSync, doDownload = download, pins = null } = {}) {
    const target = options.target;
    if (!TARGETS[target]) throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
    if (!options.payload || !options.out) throw new Error('--payload and --out are required');
    const payloadDir = fs.realpathSync(path.resolve(options.payload));
    const outDir = path.resolve(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const identity = stage.readPayloadIdentity(payloadDir);
    if (identity.target !== target) throw new Error(`the payload was built for ${identity.target}, not ${target}`);
    if (!identity.version) throw new Error('the payload manifest records no release version');
    if (!fs.existsSync(path.join(payloadDir, 'runtime', 'node.exe'))) throw new Error('the payload holds no runtime/node.exe: build it on Windows with scripts/package-runtime.js');
    const publicKeyFile = options.publicKey ? path.resolve(options.publicKey) : null;
    if (publicKeyFile && !fs.existsSync(publicKeyFile)) throw new Error('--public-key does not name a readable file');

    const signing = signingState(payloadDir, publicKeyFile);
    const buildKind = signing.signed ? 'release' : 'dev';
    const suffix = signing.signed ? '' : '-dev';
    const label = signing.signed ? 'release' : 'UNSIGNED DEVELOPMENT BUILD';
    const exeName = `goobster-${identity.version}-${target}${suffix}.exe`;
    const exeFile = path.join(outDir, exeName);
    const reportFile = path.join(outDir, `bootstrap-report-${target}.json`);

    const pin = (pins || JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'))).winsw;
    if (!pin || !pin.sha256 || !pin.url) throw new Error('scripts/bootstrap-pins.json has no winsw pin');

    const skipped = [];
    const artifacts = [];
    let installer = null;
    let builtFile = null;
    const skip = (reason, detail) => {
        skipped.push({ code: 'INSTALLER_SKIPPED', reason, detail });
        log(`INSTALLER_SKIPPED: ${reason} (${detail})`);
    };

    const makensis = findMakensis({ options, env });
    const toolsDir = options.toolsDir ? path.resolve(options.toolsDir) : path.join(os.tmpdir(), 'goobster-bootstrap-tools');
    const host = await resolveHost({ options, pin, toolsDir, doDownload });
    if (!makensis) skip('MAKENSIS_UNAVAILABLE', 'makensis was not found (install NSIS, or pass --makensis)');
    else if (!host.ok) skip(host.reason, host.detail);
    else {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-bootstrap-win32-'));
        try {
            const iconFile = path.join(work, 'goobster.ico');
            fs.writeFileSync(iconFile, iconIco());
            const listing = listPayload(payloadDir);
            const headerFile = path.join(work, 'build.nsh');
            fs.writeFileSync(headerFile, renderHeader({
                version: identity.version,
                payloadDigest: identity.payloadDigest,
                build: buildKind,
                signed: signing.signed,
                label,
                outFile: exeFile,
                iconFile,
                payloadDir,
                hostFile: host.file,
                scriptDir: path.dirname(TEMPLATE),
                listing
            }));
            fs.rmSync(exeFile, { force: true });
            log(`building ${exeName} (${listing.reduce((sum, item) => sum + item.files.length, 0)} files)`);
            const result = run(makensis, ['-NOCONFIG', '-INPUTCHARSET', 'UTF8', '-V2', `-DBUILD_HEADER=${headerFile}`, TEMPLATE], {
                cwd: path.dirname(TEMPLATE), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
            });
            if (result.status !== 0 || !fs.existsSync(exeFile)) {
                fs.rmSync(exeFile, { force: true });
                const tail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 240);
                skip('MAKENSIS_FAILED', `makensis exited ${result.status === null ? 'abnormally' : result.status}: ${tail}`);
            } else {
                builtFile = exeFile;
                installer = { tool: { name: 'makensis', version: makensisVersion(makensis, run) }, host: { name: pin.file, version: pin.version, sha256: pin.sha256 }, authenticode: { signed: false, tool: null } };
                if (options.signtool) {
                    const signed = run(options.signtool, ['sign', '/fd', 'SHA256', '/sha1', options.signThumbprint, '/tr', options.signTimestampUrl, '/td', 'SHA256', exeFile], { encoding: 'utf8' });
                    if (signed.status !== 0) {
                        fs.rmSync(exeFile, { force: true });
                        throw new Error(`signtool exited ${signed.status === null ? 'abnormally' : signed.status}; the installer was not kept`);
                    }
                    installer.authenticode = { signed: true, tool: 'signtool' };
                }
                artifacts.push({ kind: 'installer', name: exeName, bytes: fs.statSync(exeFile).size, sha256: sha256File(exeFile) });
            }
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }

    const report = {
        schema: 1,
        target,
        version: identity.version,
        build: buildKind,
        signed: signing.signed,
        signing: { keyId: signing.keyId, unsignedReason: signing.signed ? null : signing.reason },
        label,
        payloadDigest: identity.payloadDigest,
        installer,
        artifacts,
        skipped
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    return { report, reportFile, exeFile: builtFile };
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
        const outcome = await build(options, { log: line => process.stderr.write(`[bootstrap-win32] ${line}\n`) });
        process.stdout.write(`${outcome.report.label}\n`);
        for (const item of outcome.report.artifacts) process.stdout.write(`${item.kind.padEnd(9)} ${item.name}  ${item.bytes} bytes  sha256 ${item.sha256}\n`);
        for (const item of outcome.report.skipped) process.stdout.write(`${item.code}: ${item.reason} (${item.detail})\n`);
        process.stdout.write(`report    ${path.basename(outcome.reportFile)}\n`);
        if (options.requireInstaller && !outcome.exeFile) {
            process.stderr.write('The installer was required but was not built.\n');
            return 1;
        }
        return 0;
    } catch (error) {
        process.stderr.write(`package-bootstrap-win32: ${error && error.message ? error.message : error}\n`);
        return 1;
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, build, iconIco, listPayload, renderHeader, versionNumeric, findMakensis, resolveHost, fetchPinned, signingState, TARGETS, PackageError };
