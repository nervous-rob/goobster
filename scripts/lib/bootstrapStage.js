'use strict';

/**
 * The self-extracting archive behind `goobster-<version>-linux-<arch>.run`
 * (documentation/linux_install.md). Node built-ins only, so the packaging
 * script and its tests share one implementation with nothing to install.
 *
 * A `.run` file is a POSIX shell header (bootstrap/linux/install.sh, with its
 * `@NAME@` placeholders filled in) followed, at a recorded byte offset, by a
 * gzip-compressed ustar/PAX archive of the payload directory. The header
 * carries the archive's SHA-256 and the payload's `payloadDigest`; the shell
 * verifies the first before it unpacks anything, and the manager's setup
 * engine verifies the payload itself (manifest, signature, every file hash)
 * before it activates a byte of it.
 *
 * The archive is deterministic: entries sorted bytewise, a fixed modification
 * time (SOURCE_DATE_EPOCH or the constant below), numeric owner 0, modes
 * reduced to 0755/0644, gzip level fixed. Two builds of one payload are
 * byte-identical.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { once } = require('node:events');

const BLOCK = 512;
const FIXED_MTIME = 1704067200; // 2024-01-01T00:00:00Z
const OFFSET_WIDTH = 10;
const GZIP_LEVEL = 9;
const HEADER_FIELD = /^GOOBSTER_BOOTSTRAP_([A-Z0-9_]+)='([^'\n]*)'$/gm;
const OFFSET_FIELD = /^GOOBSTER_ARCHIVE_OFFSET='(\d+)'$/m;

class BootstrapError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BootstrapError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new BootstrapError(code, message); };

function octal(value, width) {
    const text = value.toString(8);
    if (text.length > width - 1) fail('ARCHIVE_FIELD_OVERFLOW', 'a value does not fit a tar header field');
    return `${text.padStart(width - 1, '0')}\0`;
}

function writeField(buffer, value, offset, length) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > length) fail('ARCHIVE_FIELD_OVERFLOW', 'a name does not fit a tar header field');
    bytes.copy(buffer, offset);
}

function tarHeader({ name, mode, size, type, linkname = '', mtime }) {
    const header = Buffer.alloc(BLOCK);
    writeField(header, name, 0, 100);
    writeField(header, octal(mode, 8), 100, 8);
    writeField(header, octal(0, 8), 108, 8);
    writeField(header, octal(0, 8), 116, 8);
    writeField(header, octal(size, 12), 124, 12);
    writeField(header, octal(mtime, 12), 136, 12);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 'ascii');
    writeField(header, linkname, 157, 100);
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return header;
}

function paxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
    return `${length}${body}`;
}

function pad(size) {
    const rest = size % BLOCK;
    return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/** The entries of a directory tree, sorted bytewise by relative path; directories first within their parent's order. */
function listEntries(root) {
    const out = [];
    const walk = (dir, rel) => {
        const names = fs.readdirSync(dir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        for (const name of names) {
            const full = path.join(dir, name);
            const entryRel = rel ? `${rel}/${name}` : name;
            const stat = fs.lstatSync(full);
            if (stat.isSymbolicLink()) {
                out.push({ rel: entryRel, full, type: 'symlink', linkname: fs.readlinkSync(full) });
            } else if (stat.isDirectory()) {
                out.push({ rel: entryRel, full, type: 'directory' });
                walk(full, entryRel);
            } else if (stat.isFile()) {
                out.push({ rel: entryRel, full, type: 'file', size: stat.size, executable: (stat.mode & 0o111) !== 0 });
            } else {
                fail('ARCHIVE_SPECIAL_FILE', `the payload holds something that is not a file, directory or link: ${entryRel}`);
            }
        }
    };
    walk(root, '');
    return out;
}

function mtimeOf(env = process.env) {
    const raw = env.SOURCE_DATE_EPOCH;
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : FIXED_MTIME;
}

async function feed(stream, chunk) {
    if (chunk.length === 0) return;
    if (!stream.write(chunk)) await once(stream, 'drain');
}

/**
 * Write the payload directory as `<outFile>` (a gzip-compressed tar).
 * @returns {Promise<{ sha256: string, bytes: number, entries: number }>}
 */
async function writeArchive(payloadDir, outFile, { env = process.env } = {}) {
    const entries = listEntries(payloadDir);
    const mtime = mtimeOf(env);
    const gzip = zlib.createGzip({ level: GZIP_LEVEL });
    const hash = crypto.createHash('sha256');
    const sink = fs.createWriteStream(outFile, { mode: 0o600 });
    let bytes = 0;
    gzip.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; });
    const finished = new Promise((resolve, reject) => {
        sink.once('finish', resolve);
        sink.once('error', reject);
        gzip.once('error', reject);
    });
    gzip.pipe(sink);

    const extended = async (records) => {
        const body = Buffer.from(records.map(([key, value]) => paxRecord(key, value)).join(''), 'utf8');
        await feed(gzip, tarHeader({ name: 'PaxHeader/entry', mode: 0o644, size: body.length, type: 'x', mtime }));
        await feed(gzip, body);
        await feed(gzip, pad(body.length));
    };

    for (const entry of entries) {
        const isDirectory = entry.type === 'directory';
        const name = isDirectory ? `${entry.rel}/` : entry.rel;
        const records = [];
        const nameBytes = Buffer.byteLength(name);
        const linkBytes = entry.type === 'symlink' ? Buffer.byteLength(entry.linkname) : 0;
        if (nameBytes > 100) records.push(['path', name]);
        if (linkBytes > 100) records.push(['linkpath', entry.linkname]);
        if (records.length) await extended(records);
        const mode = isDirectory ? 0o755 : (entry.type === 'symlink' ? 0o777 : (entry.executable ? 0o755 : 0o644));
        await feed(gzip, tarHeader({
            name: nameBytes > 100 ? 'long-path-see-pax-header' : name,
            mode,
            size: entry.type === 'file' ? entry.size : 0,
            type: isDirectory ? '5' : (entry.type === 'symlink' ? '2' : '0'),
            linkname: linkBytes > 100 ? '' : (entry.linkname || ''),
            mtime
        }));
        if (entry.type === 'file') {
            const fd = fs.openSync(entry.full, 'r');
            let remaining = entry.size;
            try {
                const buffer = Buffer.allocUnsafe(1 << 20);
                while (remaining > 0) {
                    const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
                    if (read === 0) fail('ARCHIVE_FILE_CHANGED', `a payload file shrank while it was archived: ${entry.rel}`);
                    await feed(gzip, Buffer.from(buffer.subarray(0, read)));
                    remaining -= read;
                }
            } finally {
                fs.closeSync(fd);
            }
            await feed(gzip, pad(entry.size));
        }
    }
    await feed(gzip, Buffer.alloc(BLOCK * 2));
    gzip.end();
    await finished;
    return { sha256: hash.digest('hex'), bytes, entries: entries.length };
}

const FIELD_PATTERN = /@([A-Z0-9_]+)@/g;

/**
 * The header text with every `@NAME@` filled in. `ARCHIVE_OFFSET` is the
 * header's own byte length, written at a fixed width so filling it in does
 * not move it.
 */
function renderHeader(template, values) {
    const given = { ...values };
    const fill = (offset) => template.replace(FIELD_PATTERN, (match, key) => {
        if (key === 'ARCHIVE_OFFSET') return String(offset).padStart(OFFSET_WIDTH, '0');
        if (!Object.prototype.hasOwnProperty.call(given, key)) fail('HEADER_FIELD_MISSING', `the installer template needs a value for ${key}`);
        const value = String(given[key]);
        if (/['\n\\]/.test(value)) fail('HEADER_FIELD_INVALID', `the value for ${key} holds a character the shell header cannot carry`);
        return value;
    });
    const length = Buffer.byteLength(fill(0));
    return { text: fill(length), offset: length };
}

/**
 * Join the header and the archive into one executable file.
 * @returns {{ file: string, bytes: number, sha256: string, headerBytes: number }}
 */
function assembleRun({ template, values, archiveFile, outFile }) {
    const archiveBytes = fs.statSync(archiveFile).size;
    const header = renderHeader(template, { ...values, ARCHIVE_BYTES: archiveBytes });
    const out = fs.openSync(outFile, 'w', 0o755);
    const hash = crypto.createHash('sha256');
    let total = 0;
    try {
        const head = Buffer.from(header.text, 'utf8');
        fs.writeSync(out, head);
        hash.update(head);
        total += head.length;
        const input = fs.openSync(archiveFile, 'r');
        try {
            const buffer = Buffer.allocUnsafe(1 << 20);
            for (;;) {
                const read = fs.readSync(input, buffer, 0, buffer.length, null);
                if (read === 0) break;
                fs.writeSync(out, buffer, 0, read);
                hash.update(buffer.subarray(0, read));
                total += read;
            }
        } finally {
            fs.closeSync(input);
        }
    } finally {
        fs.closeSync(out);
    }
    fs.chmodSync(outFile, 0o755);
    return { file: outFile, bytes: total, sha256: hash.digest('hex'), headerBytes: header.offset };
}

/** The recorded header fields of a `.run` file: `{ VERSION, TARGET, ..., offset }`. */
function readHeader(file) {
    const fd = fs.openSync(file, 'r');
    let text;
    try {
        const buffer = Buffer.alloc(64 * 1024);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, read).toString('latin1');
    } finally {
        fs.closeSync(fd);
    }
    if (!text.startsWith('#!/bin/sh')) fail('NOT_A_RUN_FILE', 'the file does not start with a shell header');
    const offsetMatch = OFFSET_FIELD.exec(text);
    if (!offsetMatch) fail('NOT_A_RUN_FILE', 'the header records no archive offset');
    const fields = {};
    for (const match of text.matchAll(HEADER_FIELD)) fields[match[1]] = match[2];
    return { ...fields, offset: Number(offsetMatch[1]) };
}

/** Hash the archive part of a `.run` file the way the shell header does. */
function archiveDigest(file, offset) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    let bytes = 0;
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        let position = offset;
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, position);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
            position += read;
            bytes += read;
        }
    } finally {
        fs.closeSync(fd);
    }
    return { sha256: hash.digest('hex'), bytes };
}

/**
 * Verify a `.run` file's archive against its header. Never extracts.
 * @returns {{ ok: boolean, code: string|null, header: Object, sha256: string, bytes: number }}
 */
function verifyRun(file) {
    const header = readHeader(file);
    const actual = archiveDigest(file, header.offset);
    let code = null;
    if (actual.sha256 !== header.ARCHIVE_SHA256) code = 'ARCHIVE_DIGEST_MISMATCH';
    else if (String(actual.bytes) !== header.ARCHIVE_BYTES) code = 'ARCHIVE_SIZE_MISMATCH';
    return { ok: code === null, code, header, sha256: actual.sha256, bytes: actual.bytes };
}

/**
 * Verify, then unpack with the system `tar` into `destination` (created).
 * Refuses before extracting a single byte when the archive does not match.
 */
function extractRun(file, destination) {
    const verdict = verifyRun(file);
    if (!verdict.ok) fail(verdict.code, 'the archive does not match its header; nothing was unpacked');
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const tail = childProcess.spawnSync('sh', ['-c', 'tail -c +"$1" "$2" | tar -xzf - -C "$3"', 'goobster-extract', String(verdict.header.offset + 1), file, destination], { encoding: 'utf8' });
    if (tail.status !== 0) fail('EXTRACT_FAILED', `tar failed: ${String(tail.stderr || '').split('\n')[0]}`);
    return verdict;
}

/** The names and sizes of what an archive file holds, through the system `tar`. */
function listArchive(archiveFile) {
    const result = childProcess.spawnSync('tar', ['-tzvf', archiveFile], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) fail('LIST_FAILED', `tar failed: ${String(result.stderr || '').split('\n')[0]}`);
    return result.stdout.split('\n').filter(Boolean);
}

/** The `payloadDigest` and identity a payload directory declares. */
function readPayloadIdentity(payloadDir) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(payloadDir, 'payload-manifest.json'), 'utf8'));
    } catch {
        fail('PAYLOAD_MANIFEST_MISSING', 'the payload directory holds no readable payload-manifest.json');
    }
    const digest = manifest.payloadDigest;
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) fail('PAYLOAD_DIGEST_MISSING', 'the payload manifest records no payloadDigest');
    return {
        payloadDigest: digest,
        version: manifest.release && manifest.release.core,
        target: manifest.target && manifest.target.id,
        signing: manifest.signing || null,
        signaturePresent: fs.existsSync(path.join(payloadDir, 'payload-manifest.sig'))
    };
}

module.exports = {
    BootstrapError,
    FIXED_MTIME,
    OFFSET_WIDTH,
    writeArchive,
    renderHeader,
    assembleRun,
    readHeader,
    archiveDigest,
    verifyRun,
    extractRun,
    listArchive,
    readPayloadIdentity,
    listEntries
};
