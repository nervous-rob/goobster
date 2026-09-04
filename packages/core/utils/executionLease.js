/**
 * Shared runner-lease helpers for multi-process work (Observatory jobs,
 * and the same shape Expeditions already use).
 *
 * Ownership is durable: `runnerId` plus `lastHeartbeatAt`. A RUNNING row
 * with a fresh heartbeat is assumed to be owned by another process. A
 * stale or missing heartbeat is reclaimable. Never infer ownership from
 * an in-process Map alone.
 */

const crypto = require('node:crypto');

/** Lease TTL. Heartbeats should refresh well inside this window. */
const DEFAULT_TTL_MS = 90_000;
/** How often a live loop should touch lastHeartbeatAt. */
const HEARTBEAT_MS = 15_000;

function makeRunnerId() {
    const fromEnv = String(process.env.GOOBSTER_RUNNER_ID || '').trim();
    if (fromEnv) return fromEnv.slice(0, 64);
    return crypto.randomUUID();
}

/** 'YYYY-MM-DD HH:MM:SS' UTC text (the timestamp format the tables use). */
function toUtcText(date) {
    return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function staleCutoffUtc(ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
    return toUtcText(new Date(now - ttlMs));
}

/**
 * True when `lastHeartbeatAt` is missing, unparseable, or older than ttl.
 * Accepts the UTC text the tables store (`YYYY-MM-DD HH:MM:SS`).
 */
function isLeaseStale(lastHeartbeatAt, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
    if (!lastHeartbeatAt) return true;
    const raw = String(lastHeartbeatAt).trim();
    const iso = /Z$/i.test(raw) ? raw.replace(' ', 'T') : `${raw.replace(' ', 'T')}Z`;
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return true;
    return now - then > ttlMs;
}

module.exports = {
    DEFAULT_TTL_MS,
    HEARTBEAT_MS,
    makeRunnerId,
    toUtcText,
    staleCutoffUtc,
    isLeaseStale
};
