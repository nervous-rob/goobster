#!/usr/bin/env node
'use strict';

/**
 * The artifact hygiene scan of the release pipeline (documentation/release.md, issue #341).
 *
 * Opens every release artifact it can and fails when one carries what must never ship: a repository or
 * user `config.json`, `features.json`, a `data/` or `logs/` directory, `.env*`, a private key or
 * certificate bundle, a SQLite database, `node_modules/.cache`, `.git/`, the repository's own `tests/`,
 * `e2e/` or `.github/`, a path that climbs out of the archive (`..`, absolute), a symlink that is absolute
 * or points outside the archive root, a device node, or a native binary built for another platform or CPU.
 *
 *   node scripts/release-verify-artifacts.js <artifact-or-directory>... [--target <id>] [--strict]
 *        [--no-extract-appimage] [--report <file>]
 *
 * A directory argument is scanned as a tree when it holds no artifact files itself and otherwise each
 * artifact in it is scanned: `.run` (the embedded payload archive), `.tar.gz`/`.tgz`, `.AppImage` (its own
 * `--appimage-extract`, which needs no FUSE), `.pkg` (`pkgutil --expand-full`, macOS only), `.exe` (`7z`,
 * when present) and `.zip` (`unzip -Z1`, names only). An artifact whose container cannot be opened on this
 * machine is reported as skipped with the reason; `--strict` turns a skip into a failure (CI uses it on
 * the containers each runner can open). Exit 0 clean, 2 a violation, 3 a strict skip, 1 usage.
 *
 * Tar archives are read by a small parser here (ustar, PAX and GNU long names), not the `tar` CLI, so the
 * same code reads them on every runner; nothing is ever extracted except individual native binaries, one
 * at a time, to inspect their headers. Node built-ins only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const childProcess = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const rules = require('./lib/packageRules');
const { inspectBinary, BINARY_NAME } = require('./lib/nativeBinaryInfo');

const BLOCK = 512;
const MAX_SNIFF = 1 << 20;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const KEY_NAMED = /\.(pem|key|crt|cer|p8)$/i;
const KEY_ALWAYS = /\.(p12|pfx|jks|keystore)$/i;
const TARGET_NAME = /(linux-x64|linux-arm64|win32-x64|darwin-x64|darwin-arm64)/;
const ARCH_NAME = /-(x64|arm64)\.AppImage$/i;
const SAMPLE = 8;

class HygieneError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HygieneError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// the rules, over a list of entries
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Entry
 * @property {string} path     POSIX path inside the archive
 * @property {'file'|'dir'|'symlink'|'hardlink'|'other'} type
 * @property {string} [linkTarget]
 */

function stripDot(name) {
    let out = String(name).replace(/\\/g, '/');
    while (out.startsWith('./')) out = out.slice(2);
    return out.replace(/\/+$/, '');
}

function isAbsolute(text) {
    return text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.startsWith('\\\\');
}

/** Where `target` lands when followed from `from` (both archive-relative); null when it climbs above the root. */
function resolveInside(from, target) {
    const stack = from.split('/').slice(0, -1);
    for (const part of target.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (!stack.length) return null;
            stack.pop();
        } else stack.push(part);
    }
    return stack.join('/');
}

/**
 * The violations of one entry. Pure: no file is read.
 * @param {Entry} entry
 * @returns {Array<{ rule: string, path: string }>}
 */
function checkEntry(entry) {
    const out = [];
    const raw = String(entry.path);
    const rel = stripDot(raw);
    const hit = (rule) => out.push({ rule, path: raw.replace(/[^\x20-\x7e]/g, '?').slice(0, 200) });
    const segments = rel.split('/');
    const base = segments[segments.length - 1];

    if (raw.includes('\0') || isAbsolute(raw.replace(/\\/g, '/')) || segments.includes('..') || /^[A-Za-z]:/.test(raw)) hit('path-traversal');
    if (entry.type === 'symlink' || entry.type === 'hardlink') {
        const target = String(entry.linkTarget || '').replace(/\\/g, '/');
        if (isAbsolute(target)) hit('symlink-absolute');
        else if ((entry.type === 'symlink' ? resolveInside(rel, target) : resolveInside('x', target)) === null) hit('symlink-escapes-root');
    }
    if (entry.type === 'other') hit('special-file');

    const insideModules = segments.includes('node_modules');
    if (entry.type !== 'dir') {
        if (rules.FORBIDDEN_FILES.some(pattern => pattern.test(base))) hit('secret-or-user-data-file');
        if (/^features\.json$/i.test(base)) hit('features-file');
        if (/\.sqlite/i.test(base) && !rules.FORBIDDEN_FILES.some(pattern => pattern.test(base))) hit('secret-or-user-data-file');
        if (KEY_ALWAYS.test(base)) hit('key-or-certificate-bundle');
        if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(base)) hit('private-key-file');
    }
    if (segments.includes('.git')) hit('forbidden-directory:.git');
    for (let i = 0; i + 1 < segments.length; i += 1) {
        if (segments[i] === 'node_modules' && segments[i + 1] === '.cache') {
            hit('node-modules-cache');
            break;
        }
    }
    if (!insideModules) {
        const dirs = entry.type === 'dir' ? segments : segments.slice(0, -1);
        const forbidden = dirs.find(segment => rules.FORBIDDEN_DIRS.has(segment) && segment !== '.git');
        if (forbidden) hit(`forbidden-directory:${forbidden}`);
    }
    return out;
}

/** Violations for a whole listing, plus the files worth sniffing for key material. */
function checkEntries(entries) {
    const violations = [];
    for (const entry of entries) violations.push(...checkEntry(entry));
    return violations;
}

/** Does the start of a file hold a private key block? */
function holdsPrivateKey(buffer) {
    return PRIVATE_KEY.test(buffer.toString('latin1'));
}

function binaryViolation(info, targetId, rel) {
    const target = rules.TARGETS[targetId];
    if (!target) return null;
    if (info.format === 'unknown') return null;
    if (info.format !== target.format) return { rule: `binary-format:${info.format}!=${target.format}`, path: rel };
    if (!info.arch.includes(target.arch)) return { rule: `binary-arch:${info.arch.join('+')}!=${target.arch}`, path: rel };
    return null;
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

function readExactly(fd, position, length) {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, position);
    return read === length ? buffer : buffer.subarray(0, read);
}

function parseOctal(field) {
    if (field[0] & 0x80) {
        let value = BigInt(field[0] & 0x7f);
        for (let i = 1; i < field.length; i += 1) value = (value << 8n) | BigInt(field[i]);
        return Number(value);
    }
    const text = field.toString('latin1').replace(/\0.*$/, '').trim();
    return text === '' ? 0 : parseInt(text, 8);
}

function cString(buffer) {
    const end = buffer.indexOf(0);
    return buffer.toString('utf8', 0, end === -1 ? buffer.length : end);
}

function parsePax(buffer) {
    const records = {};
    let at = 0;
    while (at < buffer.length) {
        const space = buffer.indexOf(0x20, at);
        if (space === -1) break;
        const length = Number(buffer.toString('latin1', at, space));
        if (!Number.isFinite(length) || length <= 0 || at + length > buffer.length) break;
        const record = buffer.toString('utf8', space + 1, at + length - 1);
        const eq = record.indexOf('=');
        if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
        at += length;
    }
    return records;
}

/**
 * The entries of an uncompressed tar file (ustar, PAX and GNU long-name extensions), without reading
 * file contents. `offset`/`size` locate each file's data.
 * @param {string} tarFile
 * @returns {Array<Entry & { offset: number, size: number }>}
 */
function readTarEntries(tarFile) {
    const fd = fs.openSync(tarFile, 'r');
    const total = fs.fstatSync(fd).size;
    const entries = [];
    try {
        let position = 0;
        let pending = {};
        for (;;) {
            if (position + BLOCK > total) break;
            const header = readExactly(fd, position, BLOCK);
            if (header.every(byte => byte === 0)) break;
            let sum = 0;
            for (let i = 0; i < BLOCK; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
            if (sum !== parseOctal(header.subarray(148, 156))) throw new HygieneError('ARCHIVE_CORRUPT', 'a tar header checksum does not match');
            const type = String.fromCharCode(header[156] || 0x30);
            let size = parseOctal(header.subarray(124, 136));
            const dataAt = position + BLOCK;
            const advance = (bytes) => dataAt + Math.ceil(bytes / BLOCK) * BLOCK;
            if (type === 'x' || type === 'g') {
                const records = parsePax(readExactly(fd, dataAt, size));
                if (type === 'x') pending = { ...pending, ...records };
                position = advance(size);
                continue;
            }
            if (type === 'L' || type === 'K') {
                const text = cString(readExactly(fd, dataAt, size));
                pending = { ...pending, [type === 'L' ? 'path' : 'linkpath']: text };
                position = advance(size);
                continue;
            }
            const isUstar = header.toString('latin1', 257, 262) === 'ustar';
            const prefix = isUstar ? cString(header.subarray(345, 500)) : '';
            const name = pending.path !== undefined ? pending.path : (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)));
            const linkTarget = pending.linkpath !== undefined ? pending.linkpath : cString(header.subarray(157, 257));
            if (pending.size !== undefined) size = Number(pending.size);
            pending = {};
            let kind;
            if (type === '0' || type === '\0' || type === '7') kind = 'file';
            else if (type === '5') kind = 'dir';
            else if (type === '2') kind = 'symlink';
            else if (type === '1') kind = 'hardlink';
            else kind = 'other';
            entries.push({ path: name, type: kind, linkTarget: kind === 'symlink' || kind === 'hardlink' ? linkTarget : undefined, offset: dataAt, size: kind === 'file' ? size : 0 });
            position = advance(kind === 'file' ? size : 0);
        }
    } finally {
        fs.closeSync(fd);
    }
    return entries;
}

async function gunzipTo(source, destination, start = 0) {
    await pipeline(fs.createReadStream(source, { start }), zlib.createGunzip(), fs.createWriteStream(destination, { mode: 0o600 }));
}

function copyRange(fromFd, offset, size, toFile) {
    const out = fs.openSync(toFile, 'w', 0o600);
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        let done = 0;
        while (done < size) {
            const read = fs.readSync(fromFd, buffer, 0, Math.min(buffer.length, size - done), offset + done);
            if (read === 0) break;
            fs.writeSync(out, buffer, 0, read);
            done += read;
        }
    } finally {
        fs.closeSync(out);
    }
}

/** Scan an uncompressed tar: the rules, key sniffing for key-named files, header checks for native binaries. */
function scanTarFile(tarFile, { target = null } = {}) {
    const entries = readTarEntries(tarFile);
    const violations = checkEntries(entries);
    const fd = fs.openSync(tarFile, 'r');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-hygiene-'));
    try {
        for (const entry of entries) {
            if (entry.type !== 'file') continue;
            const base = path.posix.basename(stripDot(entry.path));
            if (KEY_NAMED.test(base) && entry.size <= MAX_SNIFF && holdsPrivateKey(readExactly(fd, entry.offset, entry.size))) {
                violations.push({ rule: 'private-key', path: stripDot(entry.path).slice(0, 200) });
            }
            if (target && BINARY_NAME.test(base)) {
                const copy = path.join(work, 'binary');
                copyRange(fd, entry.offset, entry.size, copy);
                let info;
                try {
                    info = inspectBinary(copy);
                } catch {
                    info = { format: 'unknown', arch: ['unknown'] };
                }
                const problem = binaryViolation(info, target, stripDot(entry.path));
                if (problem) violations.push(problem);
                fs.rmSync(copy, { force: true });
            }
        }
    } finally {
        fs.closeSync(fd);
        fs.rmSync(work, { recursive: true, force: true });
    }
    return { entries: entries.length, violations };
}

// ---------------------------------------------------------------------------
// a directory tree
// ---------------------------------------------------------------------------

/** Scan a directory the way an archive is scanned (links are read, never followed). */
function scanTree(root, { target = null } = {}) {
    const entries = [];
    const files = [];
    const visit = (dir, rel) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const entryRel = rel ? `${rel}/${name}` : name;
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) entries.push({ path: entryRel, type: 'symlink', linkTarget: fs.readlinkSync(full) });
            else if (stat.isDirectory()) {
                entries.push({ path: entryRel, type: 'dir' });
                visit(full, entryRel);
            } else if (stat.isFile()) {
                entries.push({ path: entryRel, type: 'file' });
                files.push({ rel: entryRel, full, size: stat.size });
            } else entries.push({ path: entryRel, type: 'other' });
        }
    };
    visit(root, '');
    const violations = checkEntries(entries);
    for (const file of files) {
        const base = path.posix.basename(file.rel);
        if (KEY_NAMED.test(base) && file.size <= MAX_SNIFF && holdsPrivateKey(fs.readFileSync(file.full))) violations.push({ rule: 'private-key', path: file.rel.slice(0, 200) });
        if (target && BINARY_NAME.test(base)) {
            let info;
            try {
                info = inspectBinary(file.full);
            } catch {
                info = { format: 'unknown', arch: ['unknown'] };
            }
            const problem = binaryViolation(info, target, file.rel);
            if (problem) violations.push(problem);
        }
    }
    return { entries: entries.length, violations };
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

function findTool(names) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
    const extra = process.platform === 'win32' ? ['C:\\Program Files\\7-Zip', 'C:\\Program Files (x86)\\7-Zip'] : [];
    for (const dir of [...dirs, ...extra]) {
        for (const name of names) {
            for (const suffix of suffixes) {
                const candidate = path.join(dir, name + suffix);
                try {
                    if (fs.statSync(candidate).isFile()) return candidate;
                } catch { /* not here */ }
            }
        }
    }
    return null;
}

function targetOf(file, explicit) {
    if (explicit) return explicit;
    const base = path.basename(file);
    const named = TARGET_NAME.exec(base);
    if (named) return named[1];
    const arch = ARCH_NAME.exec(base);
    if (arch) return `linux-${arch[1].toLowerCase()}`;
    return null;
}

function kindOf(file) {
    const name = file.toLowerCase();
    if (name.endsWith('.run')) return 'run';
    if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'tar.gz';
    if (name.endsWith('.appimage')) return 'appimage';
    if (name.endsWith('.pkg')) return 'pkg';
    if (name.endsWith('.exe')) return 'exe';
    if (name.endsWith('.zip')) return 'zip';
    return null;
}

/** Where a `.run`'s archive starts, read from its own header (GOOBSTER_ARCHIVE_OFFSET). */
function runOffset(file) {
    const head = fs.readFileSync(file).subarray(0, 64 * 1024).toString('latin1');
    const match = /^GOOBSTER_ARCHIVE_OFFSET='(\d+)'$/m.exec(head);
    if (!match) throw new HygieneError('RUN_HEADER_MISSING', 'the .run has no GOOBSTER_ARCHIVE_OFFSET in its header');
    return Number(match[1]);
}

async function scanGzippedTar(file, { target, start = 0 }) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-hygiene-'));
    try {
        const tarFile = path.join(work, 'archive.tar');
        await gunzipTo(file, tarFile, start);
        return scanTarFile(tarFile, { target });
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

function run(command, args, options = {}) {
    return childProcess.spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
}

/**
 * Scan one artifact file. Never throws for a container this machine cannot open: the result says
 * `skipped` and why.
 * @returns {Promise<{ file: string, kind: string, target: string|null, entries: number, violations: Array, skipped?: { code: string, reason: string } }>}
 */
async function scanArtifact(file, options = {}) {
    const kind = kindOf(file);
    const target = targetOf(file, options.target);
    const base = { file: path.basename(file), kind, target, entries: 0, violations: [] };
    if (!kind) return { ...base, kind: 'unknown', skipped: { code: 'UNKNOWN_KIND', reason: 'not an artifact kind the scan opens' } };
    const skip = (code, reason) => ({ ...base, skipped: { code, reason } });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-hygiene-'));
    try {
        if (kind === 'run') return { ...base, ...(await scanGzippedTar(file, { target, start: runOffset(file) })) };
        if (kind === 'tar.gz') return { ...base, ...(await scanGzippedTar(file, { target })) };
        if (kind === 'appimage') {
            if (options.extractAppImage === false) return skip('APPIMAGE_NOT_EXTRACTED', '--no-extract-appimage');
            if (process.platform !== 'linux') return skip('APPIMAGE_NEEDS_LINUX', 'an AppImage is extracted on Linux');
            const result = run(path.resolve(file), ['--appimage-extract'], { cwd: work, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
            const root = path.join(work, 'squashfs-root');
            if (result.status !== 0 || !fs.existsSync(root)) return skip('APPIMAGE_EXTRACT_FAILED', `--appimage-extract exited ${result.status === null ? 'abnormally' : result.status}`);
            return { ...base, ...scanTree(root, { target }) };
        }
        if (kind === 'pkg') {
            if (process.platform !== 'darwin') return skip('PKG_NEEDS_MACOS', 'a .pkg is expanded with pkgutil on macOS');
            const expanded = path.join(work, 'expanded');
            const result = run('pkgutil', ['--expand-full', path.resolve(file), expanded]);
            if (result.status !== 0) return skip('PKG_EXPAND_FAILED', `pkgutil exited ${result.status === null ? 'abnormally' : result.status}`);
            return { ...base, ...scanTree(expanded, { target }) };
        }
        if (kind === 'exe') {
            const sevenZip = findTool(['7z', '7zz', '7za']);
            if (!sevenZip) return skip('EXE_NEEDS_7Z', 'no 7-Zip on PATH to open the NSIS installer');
            const out = path.join(work, 'unpacked');
            const result = run(sevenZip, ['x', '-y', `-o${out}`, path.resolve(file)]);
            if (result.status !== 0 || !fs.existsSync(out)) return skip('EXE_EXTRACT_FAILED', `7z exited ${result.status === null ? 'abnormally' : result.status}`);
            return { ...base, ...scanTree(out, { target }) };
        }
        const unzip = findTool(['unzip']);
        if (!unzip) return skip('ZIP_NEEDS_UNZIP', 'no unzip on PATH');
        const listing = run(unzip, ['-Z1', path.resolve(file)]);
        if (listing.status !== 0) return skip('ZIP_LIST_FAILED', `unzip exited ${listing.status === null ? 'abnormally' : listing.status}`);
        const entries = listing.stdout.split('\n').filter(Boolean).map(name => ({ path: name, type: name.endsWith('/') ? 'dir' : 'file' }));
        return { ...base, entries: entries.length, violations: checkEntries(entries) };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/**
 * Scan files and directories. A directory with artifact files in it is scanned file by file; any other
 * directory is scanned as a tree.
 * @param {string[]} inputs
 * @param {{ target?: string, strict?: boolean, extractAppImage?: boolean }} [options]
 */
async function scanAll(inputs, options = {}) {
    const results = [];
    for (const input of inputs) {
        const stat = fs.lstatSync(input);
        if (stat.isDirectory()) {
            const artifacts = fs.readdirSync(input).filter(name => kindOf(name) && fs.lstatSync(path.join(input, name)).isFile()).sort();
            if (artifacts.length) {
                for (const name of artifacts) results.push(await scanArtifact(path.join(input, name), options));
            } else {
                const tree = scanTree(input, { target: options.target || null });
                results.push({ file: path.basename(input) || input, kind: 'directory', target: options.target || null, ...tree });
            }
        } else {
            results.push(await scanArtifact(input, options));
        }
    }
    const violations = results.reduce((sum, item) => sum + item.violations.length, 0);
    const skipped = results.filter(item => item.skipped);
    let status = 'clean';
    if (violations) status = 'violations';
    else if (options.strict && skipped.length) status = 'skipped';
    return { ok: status === 'clean', status, violations, skipped: skipped.length, results };
}

function usage() {
    return 'Usage: node scripts/release-verify-artifacts.js <artifact-or-directory>... [--target <id>] [--strict] [--no-extract-appimage] [--report <file>]';
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
    const inputs = [];
    const options = { strict: false, extractAppImage: true };
    let report = null;
    try {
        for (let i = 0; i < argv.length; i += 1) {
            const arg = argv[i];
            const value = () => {
                i += 1;
                if (i >= argv.length) throw new Error(`${arg} needs a value`);
                return argv[i];
            };
            if (arg === '--target') options.target = value();
            else if (arg === '--strict') options.strict = true;
            else if (arg === '--no-extract-appimage') options.extractAppImage = false;
            else if (arg === '--report') report = path.resolve(value());
            else if (arg === '-h' || arg === '--help') {
                stdout.write(`${usage()}\n`);
                return 0;
            } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
            else inputs.push(arg);
        }
        if (!inputs.length) throw new Error('name at least one artifact or directory');
        if (options.target && !rules.TARGETS[options.target]) throw new Error(`--target must be one of ${Object.keys(rules.TARGETS).join(', ')}`);
        for (const input of inputs) if (!fs.existsSync(input)) throw new Error(`${input} does not exist`);
    } catch (error) {
        stderr.write(`${error.message}\n${usage()}\n`);
        return 1;
    }
    const outcome = await scanAll(inputs, options);
    for (const item of outcome.results) {
        const state = item.skipped ? `SKIPPED ${item.skipped.code} (${item.skipped.reason})` : (item.violations.length ? `${item.violations.length} VIOLATION(S)` : 'clean');
        stdout.write(`${item.file}  [${item.kind}${item.target ? `, ${item.target}` : ''}]  ${item.entries} entries  ${state}\n`);
        for (const violation of item.violations.slice(0, SAMPLE)) stdout.write(`    ${violation.rule}: ${violation.path}\n`);
        if (item.violations.length > SAMPLE) stdout.write(`    ... and ${item.violations.length - SAMPLE} more\n`);
    }
    stdout.write(`${JSON.stringify({ status: outcome.status, violations: outcome.violations, skipped: outcome.skipped })}\n`);
    if (report) fs.writeFileSync(report, `${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.status === 'clean' ? 0 : (outcome.status === 'violations' ? 2 : 3);
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code; }, (error) => {
        process.stderr.write(`release-verify-artifacts: ${error && error.message ? error.message : error}\n`);
        process.exitCode = 1;
    });
}

module.exports = { HygieneError, checkEntry, checkEntries, holdsPrivateKey, readTarEntries, scanTarFile, scanTree, scanArtifact, scanAll, kindOf, targetOf, resolveInside, main };
