/**
 * The Postgres part of a fresh install (documentation/database_connection.md,
 * documentation/manager_install.md): the `database` answer grows a
 * `connection`, the plan keeps only `{ engine, external }` and the public
 * view of the target, the application role's password stays in the operation's
 * private input, and the `init-db` step applies the schema to that server and
 * only then writes the manager overlay - the one place a connection URL is
 * persisted (apps/manager/environment.js).
 */

const { ManagerError } = require('../errors');
const environment = require('../environment');
const input = require('./input');
const { createProbe } = require('./probe');

const ENGINES = ['sqlite', 'postgres'];
const USABLE = new Set(['empty', 'goobster-older', 'goobster-current']);

/**
 * @param {*} value the raw `database` answer
 * @param {Object} settings
 * @param {(value: *, settings: Object) => { engine: string, external: boolean }} fallback the engine-only parser (install/engine.js parseDatabase)
 * @returns {{ database: { engine: string, external: boolean }, connection: Object|null, target: Object|null }}
 */
function parseNewDatabase(value, settings, fallback) {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value) || value.connection === undefined) {
        return { database: fallback(value, settings), connection: null, target: null };
    }
    for (const key of Object.keys(value)) {
        if (key !== 'engine' && key !== 'connection') throw new ManagerError(400, 'INVALID_INPUT', '"database" has a field this operation does not accept.');
    }
    if (!ENGINES.includes(value.engine)) throw new ManagerError(400, 'INVALID_INPUT', '"database.engine" must be sqlite or postgres.');
    if (value.engine !== 'postgres') throw new ManagerError(400, 'INVALID_INPUT', '"database.connection" only applies to the postgres engine.');
    const connection = input.parseConnection(value.connection, 'database.connection');
    return { database: { engine: 'postgres', external: true }, connection, target: input.publicView(connection) };
}

/** An environment variable that names another database wins over the overlay this install would write. */
function overrideFinding(settings, url) {
    const env = settings.processEnv || {};
    if (env.GOOBSTER_DB_URL && (url === null || env.GOOBSTER_DB_URL !== url)) {
        return { code: 'ENV_OVERRIDES_OVERLAY', severity: 'block', detail: 'GOOBSTER_DB_URL is set in the process environment and the environment wins over the manager overlay; unset it or install without a connection answer' };
    }
    return null;
}

/**
 * Probe the connection the install was asked to use and turn the verdict into
 * preflight findings. An empty schema is fine here (the install's `init-db`
 * step applies it); a foreign or newer one, an unreachable server and missing
 * privileges are blocks. Returns the connection URL with the TLS mode the
 * probe resolved, held in memory by the caller.
 */
async function probeForInstall({ settings, connection }) {
    const report = await createProbe(settings)(connection);
    const findings = [];
    for (const item of report.verdict.blocks) findings.push({ code: `DATABASE_${item.code}`, severity: 'block', detail: item.detail });
    if (report.reachable && report.schema && !USABLE.has(report.schema.state) && !report.verdict.blocks.some(item => item.code.startsWith('SCHEMA_'))) {
        findings.push({ code: 'DATABASE_SCHEMA_UNUSABLE', severity: 'block', detail: `the schema is ${report.schema.state}` });
    }
    for (const item of report.verdict.warnings) findings.push({ code: `DATABASE_${item.code}`, severity: 'warn', detail: item.detail });
    const url = findings.some(item => item.severity === 'block') ? null : input.connectionLib.connectionUrl(connection, { tlsMode: report.tls.effective });
    const override = overrideFinding(settings, url);
    if (override) findings.push(override);
    return { findings, url, report };
}

/** After the schema is in place: the overlay holds the application role's URL, and this manager's settings see it. */
function persistOverlay({ settings, fs, now, url }) {
    const existing = environment.read(settings.storeDir, fs).values;
    const values = { ...existing, GOOBSTER_DB_URL: url };
    environment.write(settings.storeDir, values, { fs, now });
    environment.apply(settings, values);
}

module.exports = { parseNewDatabase, probeForInstall, persistOverlay, overrideFinding };
