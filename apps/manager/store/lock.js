/**
 * The single-owner mutation lock (`<store>/lock`). Created with `wx`, so
 * exactly one holder exists; a lock whose process is gone or whose expiry
 * has passed is reclaimed. A lock file that cannot be parsed is treated as
 * held until it is older than the expiry window.
 */

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const files = require('./files');
const { ManagerError } = require('../errors');

const LOCK_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function defaultIsProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return Boolean(error && error.code === 'EPERM');
    }
}

/**
 * @param {Object} params
 * @param {{ paths: { lock: string } }} params.store
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 * @param {(pid: number) => boolean} [params.isProcessAlive]
 * @param {number} [params.ttlMs]
 */
function createLock({ store, fs = nodeFs, now = () => new Date(), isProcessAlive = defaultIsProcessAlive, ttlMs = DEFAULT_TTL_MS }) {
    const file = store.paths.lock;

    function inspect() {
        const read = files.readJson(file, fs);
        if (!read.exists) return { held: false };
        const value = read.value;
        if (read.problem || !files.isPlainObject(value) || value.version !== LOCK_VERSION) {
            let ageMs = 0;
            try { ageMs = now().getTime() - fs.statSync(file).mtimeMs; } catch { }
            return { held: true, unreadable: true, stale: ageMs > ttlMs };
        }
        const expired = Date.parse(value.expiresAt) <= now().getTime();
        const dead = !isProcessAlive(value.pid);
        return {
            held: true,
            operationId: value.operationId,
            pid: value.pid,
            expiresAt: value.expiresAt,
            stale: expired || dead
        };
    }

    /**
     * @param {string} operationId
     * @returns {{ token: string, release: () => void }}
     * @throws {ManagerError} 409 OPERATION_IN_PROGRESS
     */
    function acquire(operationId) {
        const token = crypto.randomBytes(16).toString('hex');
        const body = () => JSON.stringify({
            version: LOCK_VERSION,
            pid: process.pid,
            operationId,
            token,
            acquiredAt: now().toISOString(),
            expiresAt: new Date(now().getTime() + ttlMs).toISOString()
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                files.writeExclusive(file, body(), fs);
                return { token, release: () => release(token) };
            } catch (error) {
                if (!error || error.code !== 'EEXIST') throw error;
            }
            const current = inspect();
            if (!current.stale) {
                throw new ManagerError(409, 'OPERATION_IN_PROGRESS', 'Another manager operation is in progress; retry when it finishes.');
            }
            try { fs.unlinkSync(file); } catch { }
        }
        throw new ManagerError(409, 'OPERATION_IN_PROGRESS', 'Another manager operation is in progress; retry when it finishes.');
    }

    function release(token) {
        const read = files.readJson(file, fs);
        if (read.exists && files.isPlainObject(read.value) && read.value.token === token) {
            try { fs.unlinkSync(file); } catch { }
        }
    }

    /** Status view: never the token. */
    function describe() {
        const current = inspect();
        if (!current.held) return { held: false };
        return { held: !current.stale, stale: current.stale, operationId: current.operationId || null };
    }

    return { acquire, inspect, describe };
}

module.exports = { createLock, LOCK_VERSION, DEFAULT_TTL_MS };
