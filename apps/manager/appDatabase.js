/**
 * What the manager knows about the application database without opening
 * it: whether one exists (the evidence that this is an existing
 * installation) and a bounded reachability probe. SQLite is checked by
 * reading the 16-byte file header; Postgres by a TCP connect with a short
 * timeout. Neither creates, migrates or writes anything, and nothing here
 * returns a path, a URL, a host or a credential.
 */

const nodeFs = require('node:fs');
const nodeNet = require('node:net');

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');
const DEFAULT_PROBE_TIMEOUT_MS = 1500;

function exists(fs, file) {
    try {
        fs.statSync(file);
        return true;
    } catch (error) {
        return Boolean(error && error.code && error.code !== 'ENOENT' && error.code !== 'ENOTDIR');
    }
}

/**
 * Evidence that an application installation already exists. Any item means
 * first-time setup must never open again.
 * @returns {string[]} subset of 'postgres-url', 'sqlite-file', 'features-file'
 */
function existingInstallEvidence(settings, fs = nodeFs) {
    const evidence = [];
    if (settings.dbUrl) evidence.push('postgres-url');
    if (exists(fs, settings.sqlitePath) || exists(fs, `${settings.sqlitePath}-wal`)) evidence.push('sqlite-file');
    if (exists(fs, settings.featuresPath)) evidence.push('features-file');
    return evidence;
}

function probeSqlite(settings, fs) {
    const base = { engine: 'sqlite', present: false, reachable: false, reason: null };
    let fd = null;
    try {
        const stat = fs.statSync(settings.sqlitePath);
        base.present = true;
        if (!stat.isFile()) return { ...base, reason: 'SQLITE_NOT_A_FILE' };
        if (stat.size === 0) return { ...base, reachable: true, reason: 'SQLITE_EMPTY' };
        fd = fs.openSync(settings.sqlitePath, 'r');
        const header = Buffer.alloc(SQLITE_HEADER.length);
        const read = fs.readSync(fd, header, 0, header.length, 0);
        if (read < header.length || !header.equals(SQLITE_HEADER)) return { ...base, reason: 'SQLITE_CORRUPT' };
        return { ...base, reachable: true };
    } catch (error) {
        if (error && error.code === 'ENOENT') return { ...base, reason: 'NOT_FOUND' };
        return { ...base, reason: 'SQLITE_UNREADABLE' };
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { }
        }
    }
}

function probePostgres(settings, { net, timeoutMs }) {
    const base = { engine: 'postgres', present: true, reachable: false, reason: null };
    let url;
    try {
        url = new URL(settings.dbUrl);
    } catch {
        return Promise.resolve({ ...base, reason: 'POSTGRES_URL_INVALID' });
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
        return Promise.resolve({ ...base, reason: 'POSTGRES_URL_INVALID' });
    }
    const host = url.hostname ? url.hostname.replace(/^\[|\]$/g, '') : 'localhost';
    const port = url.port ? Number(url.port) : 5432;
    if (host.startsWith('/') || host.startsWith('%2f') || host.startsWith('%2F')) {
        return Promise.resolve({ ...base, reachable: null, reason: 'NOT_PROBED' });
    }
    return new Promise((resolve) => {
        let settled = false;
        const socket = net.connect({ host, port });
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => finish({ ...base, reason: 'POSTGRES_UNREACHABLE' }), timeoutMs);
        socket.once('connect', () => finish({ ...base, reachable: true }));
        socket.once('error', () => finish({ ...base, reason: 'POSTGRES_UNREACHABLE' }));
    });
}

/**
 * @param {Object} settings resolveSettings() output
 * @param {{ fs?: Object, net?: Object, timeoutMs?: number }} [options]
 * @returns {Promise<{ engine: 'sqlite'|'postgres', present: boolean, reachable: boolean|null, reason: string|null }>}
 */
async function probeAppDatabase(settings, { fs = nodeFs, net = nodeNet, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
    if (settings.dbUrl) return probePostgres(settings, { net, timeoutMs });
    return probeSqlite(settings, fs);
}

module.exports = { existingInstallEvidence, probeAppDatabase, SQLITE_HEADER, DEFAULT_PROBE_TIMEOUT_MS };
