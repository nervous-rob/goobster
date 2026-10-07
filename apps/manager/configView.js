/**
 * What the configuration routes and operation kinds share: the manager's
 * view of the environment, config.json and (when it is reachable) the
 * application database, resolved through the field catalog.
 *
 * The manager never holds an application database connection. A read that
 * needs one goes through `withAppDatabase`, which serialises the access,
 * opens only a database the probe says exists and is reachable (the facade
 * would otherwise create and migrate one), and closes the connection again.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { probeAppDatabase } = require('./appDatabase');
const { lazy } = require('./lazy');

const configFile = lazy('@goobster/core/config/configFile');
const effective = lazy('@goobster/core/config/effectiveConfig');

let chain = Promise.resolve();
let closeConnections = true;

/** Test seam: an in-process test shares its database handle with the manager and must keep it open. */
function configure(options = {}) {
    if (typeof options.closeConnections === 'boolean') closeConnections = options.closeConnections;
}

/** Run `task` with the application database, one caller at a time, closing the connection after. */
function withAppDatabase(task) {
    const run = chain.then(async () => {
        const db = require('@goobster/core/db');
        try {
            return await task();
        } finally {
            if (closeConnections) {
                try { await db.closeConnection(); } catch { }
            }
        }
    });
    chain = run.catch(() => { });
    return run;
}

function usable(reachability) {
    return Boolean(reachability) && reachability.reachable === true && reachability.reason !== 'SQLITE_EMPTY';
}

/** `.env` next to config.json, read the way dotenv does: the process environment wins. */
function loadEnv(settings, fs = nodeFs) {
    const merged = {};
    try {
        const file = path.join(path.dirname(settings.configPath), '.env');
        const text = fs.readFileSync(file, 'utf8');
        Object.assign(merged, require('dotenv').parse(text));
    } catch { }
    return { ...merged, ...settings.env };
}

/** A small integer for the engine's revision check, derived from a content revision. */
function revisionInt(revision) {
    return revision ? Number.parseInt(String(revision).slice(0, 12), 16) : 0;
}

function defaultsRevision(doc) {
    return Number.parseInt(crypto.createHash('sha256').update(JSON.stringify(doc || {})).digest('hex').slice(0, 12), 16);
}

function readFile(settings, fs = nodeFs) {
    return configFile.read(settings.configPath, { fs });
}

/**
 * The database-backed values the catalog describes, or null when they cannot
 * be read (the report then says `unknown-db`).
 * @returns {Promise<{ overrides: Object|null, reachability: Object }>}
 */
async function readOverrides(settings, { fs = nodeFs, reachability = null } = {}) {
    const probed = reachability || await probeAppDatabase(settings, { fs });
    if (!usable(probed)) return { overrides: null, reachability: probed };
    try {
        const overrides = await withAppDatabase(async () => {
            const state = require('@goobster/core/services/instanceStateService');
            const defaults = require('@goobster/core/services/instanceDefaultsService');
            return {
                limits: await state.get('limits'),
                defaults: await defaults.get()
            };
        });
        return { overrides, reachability: probed };
    } catch {
        return { overrides: null, reachability: probed };
    }
}

/**
 * The effective report for the current environment, file and database.
 * @param {Object} params
 * @param {Object} params.settings
 * @param {Object} [params.fs]
 * @param {Object|null} [params.overrides] pass the result of readOverrides().overrides, or null for unknown
 * @param {Object|null} [params.features] feature id -> { active }
 * @param {Object|null} [params.fileDoc] a document to resolve instead of the file (what a change would produce)
 */
function resolve({ settings, fs = nodeFs, overrides, features = null, fileDoc }) {
    const file = fileDoc === undefined ? readFile(settings, fs) : { doc: fileDoc };
    return effective.resolveEffective({
        env: loadEnv(settings, fs),
        fileConfig: file.doc || {},
        overrides,
        features
    });
}

function featureStates(createFeatureState) {
    try {
        const status = createFeatureState().status();
        if (status.error || !status.features) return null;
        const out = {};
        for (const [id, entry] of Object.entries(status.features)) out[id] = { active: Boolean(entry.active) };
        return out;
    } catch {
        return null;
    }
}

module.exports = {
    configure,
    withAppDatabase,
    loadEnv,
    revisionInt,
    defaultsRevision,
    readFile,
    readOverrides,
    resolve,
    featureStates,
    usable
};
