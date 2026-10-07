/**
 * Parsing and error mapping for the database operations
 * (documentation/database_connection.md). The core connection library does
 * the validation (`@goobster/core/db/connection`); this file turns its
 * `ConnectionError` into the manager's `ManagerError` and keeps every
 * password out of what comes back: plans, results and errors carry the
 * public view of a connection only.
 */

const { ManagerError } = require('../errors');
const { exactKeys, textField } = require('../install/engine');
const { lazy } = require('../lazy');

const connectionLib = lazy('@goobster/core/db/connection');

const HEX_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE = /^[A-Za-z0-9_][A-Za-z0-9_$.@-]{0,62}$/;
const DATABASE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;

const REFUSAL = new Set([
    'ELEVATED_CONNECT_FAILED', 'PROVISIONING_NOT_PERMITTED', 'PROVISIONING_FAILED', 'SCHEMA_FOREIGN', 'ROLE_EXISTS', 'ROLE_MISSING', 'DATABASE_MISSING',
    'SCHEMA_MISSING', 'EXTENSION_LIBRARY_MISSING', 'RESERVED_NAME', 'SAME_ROLE'
]);

function isConnectionError(error) {
    return Boolean(error && error.name === 'ConnectionError');
}

/** A `ConnectionError` as the `ManagerError` the HTTP layer and the CLI understand; anything else is returned unchanged. */
function managerError(error) {
    if (!isConnectionError(error)) return error;
    const status = REFUSAL.has(error.code) ? 409 : 400;
    return new ManagerError(status, error.code, error.message, error.details && Object.keys(error.details).length ? error.details : null);
}

/** Run a core call and map its `ConnectionError`. */
async function mapped(call) {
    try {
        return await call();
    } catch (error) {
        throw managerError(error);
    }
}

function parseConnection(value, what = 'connection') {
    if (value === undefined) throw new ManagerError(400, 'INVALID_INPUT', `"${what}" is required.`);
    try {
        return connectionLib.parseConnection(value);
    } catch (error) {
        throw managerError(error);
    }
}

/** Host, port, database, schema, user and TLS, never the password or the CA file's path. */
function publicView(connection) {
    return {
        host: connection.host,
        port: connection.port,
        database: connection.database,
        schema: connection.schema,
        user: connection.user,
        tls: { mode: connection.tls.mode, ca: Boolean(connection.tls.caFile) },
        local: connectionLib.isLoopback(connection.host)
    };
}

function parseElevated(value) {
    exactKeys(value, new Set(['user', 'password', 'database']), '"elevated"');
    const user = textField(value.user, 'elevated.user', { max: 63 });
    if (!ROLE.test(user)) throw new ManagerError(400, 'INVALID_INPUT', '"elevated.user" is not a valid role name.');
    let password = '';
    if (value.password !== undefined && value.password !== null) {
        if (typeof value.password !== 'string' || value.password.length > 512 || value.password.includes('\0')) throw new ManagerError(400, 'INVALID_INPUT', '"elevated.password" must be text of at most 512 characters.');
        password = value.password;
    }
    let database;
    if (value.database !== undefined && value.database !== null && value.database !== '') {
        if (typeof value.database !== 'string' || !DATABASE.test(value.database)) throw new ManagerError(400, 'INVALID_INPUT', '"elevated.database" is not a valid database name.');
        database = value.database;
    }
    return { user, password, ...(database ? { database } : {}) };
}

function parseActions(value) {
    try {
        return connectionLib.parseActions(value);
    } catch (error) {
        throw managerError(error);
    }
}

function parseMaintenance(value) {
    if (value === undefined) return null;
    exactKeys(value, new Set(['operationId', 'fence']), '"maintenance"');
    if (typeof value.operationId !== 'string' || !HEX_ID.test(value.operationId)) throw new ManagerError(400, 'INVALID_INPUT', '"maintenance.operationId" must be the id maintenance.enter returned.');
    if (!Number.isInteger(value.fence) || value.fence < 1) throw new ManagerError(400, 'INVALID_INPUT', '"maintenance.fence" must be the fence maintenance.enter returned.');
    return { operationId: value.operationId, fence: value.fence };
}

/** Every string of a database input that must never appear in output, for the CLI's redaction. */
function secretsOf(input) {
    const out = [];
    const add = (value) => { if (typeof value === 'string' && value.length >= 4) out.push(value); };
    if (input && input.connection) add(input.connection.password);
    if (input && input.elevated) add(input.elevated.password);
    return out;
}

module.exports = {
    connectionLib,
    managerError,
    mapped,
    parseConnection,
    parseElevated,
    parseActions,
    parseMaintenance,
    publicView,
    secretsOf,
    isConnectionError
};
