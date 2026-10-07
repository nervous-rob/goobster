/**
 * Reading and writing config.json safely.
 *
 * `read()` returns the parsed document and a revision: the first 16 hex
 * characters of the SHA-256 of the file's bytes. The revision is the
 * concurrency token - `write()` takes the revision the caller read and refuses
 * with `STALE_REVISION` when the file has changed since, so two editors can
 * never silently clobber one another.
 *
 * `write()` validates first (configValidator plus the field catalog), then
 * serialises with four-space JSON and a trailing newline, writes a temporary
 * file in the same directory with mode 0600, fsyncs it, and renames it over
 * the target. Any failure - validation, a stale revision, a failed write or
 * rename - leaves the previous file exactly as it was and removes the
 * temporary file. Keys the catalog does not know are preserved: the caller
 * edits the parsed document and writes the whole of it back.
 *
 * Permissions: the file is created owner-only (0600) on POSIX. On Windows
 * Node can only toggle the read-only attribute through mode bits and cannot
 * set an ACL, so the file inherits the ACL of its directory; keep the
 * installation directory private (documentation/manager_configuration.md).
 *
 * Reads go through `configJson.load()` (documentation/packaging_proof.md,
 * finding B1); this module is the writer.
 *
 * Pure filesystem: no database, no app imports. Errors carry a stable `code`
 * and never a path or a value.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { validateConfig } = require('../utils/configValidator');
const catalog = require('./fieldCatalog');

const LOCK_STALE_MS = 30_000;
const MAX_BYTES = 2 * 1024 * 1024;

class ConfigFileError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'ConfigFileError';
        this.code = code;
        this.details = details;
    }
}

function revisionOf(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} file
 * @param {{ fs?: Object }} [options]
 * @returns {{ present: boolean, readable: boolean, doc: Object|null, revision: string|null, error: string|null }}
 *   `revision` is null only when the file does not exist; `doc` is null when it is missing or unusable.
 */
function read(file, { fs = nodeFs } = {}) {
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    } catch (error) {
        if (error && error.code === 'ENOENT') return { present: false, readable: true, doc: null, revision: null, error: null };
        return { present: true, readable: false, doc: null, revision: null, error: 'UNREADABLE' };
    }
    if (bytes.length > MAX_BYTES) return { present: true, readable: false, doc: null, revision: revisionOf(bytes), error: 'TOO_LARGE' };
    let parsed;
    try {
        parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
        return { present: true, readable: false, doc: null, revision: revisionOf(bytes), error: 'CORRUPT' };
    }
    if (!isPlainObject(parsed)) return { present: true, readable: false, doc: null, revision: revisionOf(bytes), error: 'NOT_AN_OBJECT' };
    return { present: true, readable: true, doc: parsed, revision: revisionOf(bytes), error: null };
}

/** Problems a document has, as `{ id, code, message }` entries that name settings and never values. */
function validate(doc) {
    const problems = [];
    if (!isPlainObject(doc)) {
        return [{ id: '', code: 'INVALID_TYPE', message: 'config.json must contain a JSON object.' }];
    }
    const base = validateConfig(doc, { requireDiscord: false });
    for (const message of base.errors) problems.push({ id: '', code: 'INVALID_CONFIG', message });
    for (const error of catalog.validateDocument(doc).errors) problems.push(error);
    return problems;
}

function serialize(doc) {
    return Buffer.from(`${JSON.stringify(doc, null, 4)}\n`, 'utf8');
}

function acquireLock(lockFile, fs) {
    const attempt = () => {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.closeSync(fd);
    };
    try {
        attempt();
    } catch (error) {
        if (!error || error.code !== 'EEXIST') throw new ConfigFileError('WRITE_FAILED', 'The configuration file could not be written.');
        let age = 0;
        try {
            age = Date.now() - fs.statSync(lockFile).mtimeMs;
        } catch { }
        if (age < LOCK_STALE_MS) throw new ConfigFileError('CONFIG_BUSY', 'Another process is writing the configuration file; try again.');
        try {
            fs.unlinkSync(lockFile);
            attempt();
        } catch {
            throw new ConfigFileError('CONFIG_BUSY', 'Another process is writing the configuration file; try again.');
        }
    }
    return () => {
        try { fs.unlinkSync(lockFile); } catch { }
    };
}

function fsyncDirectory(dir, fs) {
    if (process.platform === 'win32') return;
    let fd = null;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch {
        // best effort: the rename already happened
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { }
        }
    }
}

/**
 * @param {string} file
 * @param {Object} doc the whole document to write
 * @param {Object} options
 * @param {string|null} options.expectedRevision revision from `read()`; null when the file must not exist yet
 * @param {Object} [options.fs]
 * @returns {{ revision: string, previousRevision: string|null, bytes: number }}
 * @throws {ConfigFileError} REVISION_REQUIRED, INVALID_CONFIG, CONFIG_UNREADABLE, STALE_REVISION, CONFIG_BUSY, WRITE_FAILED
 */
function write(file, doc, options = {}) {
    const { fs = nodeFs } = options;
    if (!Object.prototype.hasOwnProperty.call(options, 'expectedRevision') || options.expectedRevision === undefined) {
        throw new ConfigFileError('REVISION_REQUIRED', 'A write names the revision it was computed from (null when the file is new).');
    }
    const expected = options.expectedRevision;
    const problems = validate(doc);
    if (problems.length > 0) {
        throw new ConfigFileError('INVALID_CONFIG', 'The configuration did not pass validation; nothing was written.', { problems });
    }
    const bytes = serialize(doc);
    if (bytes.length > MAX_BYTES) throw new ConfigFileError('INVALID_CONFIG', 'The configuration is too large; nothing was written.');

    const dir = nodePath.dirname(file);
    const lockFile = `${file}.lock`;
    const temp = nodePath.join(dir, `.${nodePath.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let release = null;
    try {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            throw new ConfigFileError('WRITE_FAILED', 'The configuration file could not be written.');
        }
        release = acquireLock(lockFile, fs);
        const current = read(file, { fs });
        if (current.present && !current.readable) {
            throw new ConfigFileError('CONFIG_UNREADABLE', 'The existing configuration file cannot be read; it was left as it is. Repair or restore it first.', { cause: current.error });
        }
        if ((current.revision ?? null) !== expected) {
            throw new ConfigFileError('STALE_REVISION', 'The configuration file changed since it was read; reload and try again.', { expected, actual: current.revision ?? null });
        }
        let fd = null;
        try {
            fd = fs.openSync(temp, 'wx', 0o600);
            fs.writeSync(fd, bytes, 0, bytes.length);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = null;
            try { fs.chmodSync(temp, 0o600); } catch { }
            fs.renameSync(temp, file);
        } catch {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { }
            }
            throw new ConfigFileError('WRITE_FAILED', 'The configuration file could not be written; the previous file was left as it was.');
        }
        fsyncDirectory(dir, fs);
        return { revision: revisionOf(bytes), previousRevision: current.revision ?? null, bytes: bytes.length };
    } finally {
        try { fs.unlinkSync(temp); } catch { }
        if (release) release();
    }
}

module.exports = { read, write, validate, serialize, revisionOf, ConfigFileError, MAX_BYTES };
