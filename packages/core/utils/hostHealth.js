/**
 * Host health readers shared by /systemstatus and the local management
 * panel. Everything here is best effort: on a platform without the
 * Raspberry Pi sysfs nodes (or without statfs) a reader returns null and
 * the caller leaves that field out.
 */

const fs = require('node:fs');
const os = require('node:os');

/** Raspberry Pi firmware throttle bits (see `vcgencmd get_throttled`). */
const THROTTLE_FLAGS = [
    [0x1, 'under-voltage'],
    [0x2, 'frequency capped'],
    [0x4, 'throttled'],
    [0x8, 'soft temp limit']
];

/**
 * Read the SoC temperature via /sys/class/thermal (Raspberry Pi and most
 * Linux SBCs).
 * @returns {number|null} Temperature in °C, one decimal
 */
function readCpuTemperature() {
    try {
        const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        const value = Math.round(parseInt(raw, 10) / 100) / 10;
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Current Raspberry Pi firmware throttle flags.
 * @returns {{ value: number, flags: string[] }|null} null when the sysfs
 *   node is missing (not a Pi)
 */
function readThrottleFlags() {
    try {
        const raw = fs.readFileSync('/sys/devices/platform/soc/soc:firmware/get_throttled', 'utf8').trim();
        const value = parseInt(raw, 16);
        if (Number.isNaN(value)) return null;
        return {
            value,
            flags: THROTTLE_FLAGS.filter(([bit]) => value & bit).map(([, label]) => label)
        };
    } catch {
        return null;
    }
}

/**
 * Human-readable throttle summary, as /systemstatus has always shown it.
 * @param {{ flags: string[] }|null} state
 * @returns {string|null}
 */
function describeThrottle(state) {
    if (!state) return null;
    return state.flags.length ? `⚠️ ${state.flags.join(', ')}` : 'No throttling';
}

/**
 * Format seconds as a compact duration (`2d 4h 13m`).
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

/**
 * Format bytes as MB/GB.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Disk usage of the filesystem holding `dir`.
 * @param {string} dir
 * @returns {{ totalBytes: number, freeBytes: number, usedBytes: number }|null}
 */
function readDiskUsage(dir) {
    try {
        const stats = fs.statfsSync(dir);
        const totalBytes = stats.blocks * stats.bsize;
        const freeBytes = stats.bavail * stats.bsize;
        return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
    } catch {
        return null;
    }
}

/**
 * Database size and message count through the facade. There is no
 * dialect-neutral size query, so this guards on `db.engine` the way the
 * facade documents for `getDb()`.
 * @param {Object} db - the database facade
 * @returns {Promise<{ engine: string, bytes: number|null, messageCount: number }|null>}
 */
async function readDatabaseStats(db) {
    try {
        const messageCount = (await db.get('SELECT COUNT(*) AS count FROM messages'))?.count ?? 0;
        let bytes = null;
        if (db.engine === 'postgres') {
            const size = await db.get('SELECT pg_database_size(current_database()) AS bytes');
            bytes = Number(size?.bytes) || null;
        } else {
            const handle = db.getDb();
            const pageCount = handle.pragma('page_count', { simple: true });
            const pageSize = handle.pragma('page_size', { simple: true });
            bytes = pageCount * pageSize;
        }
        return { engine: db.engine, bytes, messageCount: Number(messageCount) || 0 };
    } catch {
        return null;
    }
}

/**
 * One snapshot of everything a status surface shows: OS, CPU load and
 * temperature, Pi throttle flags, memory, disk under the data directory,
 * and database size. Cheap enough to poll every few seconds.
 * @param {Object} params
 * @param {Object} params.db - the database facade
 * @param {string} params.dataDir - directory whose filesystem to measure
 */
async function collectHostHealth({ db, dataDir }) {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const processMemory = process.memoryUsage();
    return {
        os: {
            type: os.type(),
            release: os.release(),
            arch: os.arch(),
            uptimeSeconds: Math.floor(os.uptime())
        },
        cpu: {
            load: os.loadavg().map(value => Math.round(value * 100) / 100),
            cores: os.cpus().length,
            temperatureC: readCpuTemperature(),
            throttle: readThrottleFlags()
        },
        memory: {
            totalBytes,
            usedBytes: totalBytes - freeBytes,
            processRssBytes: processMemory.rss,
            heapUsedBytes: processMemory.heapUsed,
            heapTotalBytes: processMemory.heapTotal
        },
        disk: readDiskUsage(dataDir),
        database: await readDatabaseStats(db),
        process: {
            uptimeSeconds: Math.floor(process.uptime()),
            nodeVersion: process.version
        }
    };
}

module.exports = {
    readCpuTemperature,
    readThrottleFlags,
    describeThrottle,
    formatDuration,
    formatBytes,
    readDiskUsage,
    readDatabaseStats,
    collectHostHealth
};
