/**
 * Filesystem primitives for the manager store: restrictive permissions,
 * atomic durable replacement (temp file, fsync, rename, directory fsync)
 * and reads that report a problem instead of throwing or repairing it.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const IS_POSIX = process.platform !== 'win32';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureDir(dir, fs = nodeFs) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    if (IS_POSIX) {
        const mode = fs.statSync(dir).mode & 0o777;
        if (mode !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
    }
}

function fsyncDir(dir, fs = nodeFs) {
    if (!IS_POSIX) return;
    let fd = null;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch {
        // Some filesystems refuse a directory fsync; the rename already happened.
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { }
        }
    }
}

/** Replace `file` with `text` so a reader sees the old or the new content, never a mix. */
function writeAtomic(file, text, fs = nodeFs) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let fd = null;
    try {
        fd = fs.openSync(tmp, 'wx', FILE_MODE);
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, file);
    } catch (error) {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { }
        }
        try { fs.unlinkSync(tmp); } catch { }
        throw error;
    }
    fsyncDir(dir, fs);
}

function writeJsonAtomic(file, value, fs = nodeFs) {
    writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, fs);
}

/** Create `file` only if it does not exist. Throws EEXIST otherwise. */
function writeExclusive(file, text, fs = nodeFs) {
    const fd = fs.openSync(file, 'wx', FILE_MODE);
    try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fsyncDir(path.dirname(file), fs);
}

/**
 * @returns {{ exists: boolean, value: any, problem: null|'UNREADABLE'|'CORRUPT' }}
 */
function readJson(file, fs = nodeFs) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return { exists: false, value: null, problem: null };
        return { exists: true, value: null, problem: 'UNREADABLE' };
    }
    try {
        return { exists: true, value: JSON.parse(text), problem: null };
    } catch {
        return { exists: true, value: null, problem: 'CORRUPT' };
    }
}

function removeIfPresent(file, fs = nodeFs) {
    try {
        fs.unlinkSync(file);
        return true;
    } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utcNow(now = new Date()) {
    return now.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
    IS_POSIX,
    DIR_MODE,
    FILE_MODE,
    ensureDir,
    fsyncDir,
    writeAtomic,
    writeJsonAtomic,
    writeExclusive,
    readJson,
    removeIfPresent,
    isPlainObject,
    utcNow
};
