/**
 * The probe as the manager runs it: the core library's read-only inspector,
 * told which database is in use now (so the report can say "this is the
 * connection already in effect") and with the test seam
 * `settings.databaseDeps.probe` / `.probeDeps`.
 */

const { lazy } = require('../lazy');
const { mapped, connectionLib } = require('./input');

const targetLib = lazy('@goobster/core/db/migration/target');

function activeFingerprint(settings) {
    if (!settings.dbUrl) return null;
    try {
        return targetLib.describeTarget(settings.dbUrl).fingerprint;
    } catch {
        return null;
    }
}

/** @returns {(connection: Object) => Promise<Object>} the report; throws a ManagerError for input the library refuses */
function createProbe(settings) {
    return function probe(connection) {
        const deps = settings.databaseDeps || {};
        const run = deps.probe || connectionLib.probeConnection;
        return mapped(() => run(connection, { activeFingerprint: activeFingerprint(settings), ...(deps.probeDeps || {}) }));
    };
}

/** A deep copy of `value` with every occurrence of each secret removed from its strings (defence in depth; the report carries none). */
function redactDeep(value, secrets) {
    const list = secrets.filter(secret => typeof secret === 'string' && secret.length >= 3);
    if (list.length === 0) return value;
    const walk = (item, depth) => {
        if (depth > 12) return '[truncated]';
        if (typeof item === 'string') return list.reduce((text, secret) => text.split(secret).join('***'), item);
        if (Array.isArray(item)) return item.map(inner => walk(inner, depth + 1));
        if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner, depth + 1)]));
        return item;
    };
    return walk(value, 0);
}

module.exports = { createProbe, activeFingerprint, redactDeep };
