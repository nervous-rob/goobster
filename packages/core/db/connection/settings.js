/**
 * The connection settings an operator types for an existing Postgres server,
 * and the one place they become a connection URL (documentation/database_connection.md).
 *
 * Fields: host, port, database, schema (default `public`), user, password and
 * a TLS mode with an optional CA file. Server bind address and storage path
 * are deliberately not here: those belong to a server the manager owns, never
 * to one the operator merely connects to.
 *
 * TLS modes, and what the application's driver (`pg`) does with each:
 *
 *   disable      no TLS.
 *   prefer       try TLS without verification, fall back to plain. The driver
 *                has no fallback of its own, so the probe resolves it once
 *                (`tls.effective`) and the URL that is saved holds the
 *                outcome (`require` or `disable`).
 *   require      TLS, certificate not checked (libpq's `require`). With a CA
 *                file the chain is verified but the host name is not.
 *   verify-full  TLS, certificate chain and host name checked against the CA
 *                file, which is mandatory.
 *
 * The URL carries the password and is a secret: it is built here, held in
 * memory, and persisted only in the manager's environment overlay.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describeTarget, publicTarget } = require('../migration/target');
const { ConnectionError } = require('./errors');

const TLS_MODES = Object.freeze(['disable', 'prefer', 'require', 'verify-full']);
const FIELDS = new Set(['host', 'port', 'database', 'schema', 'user', 'password', 'tls']);
const TLS_FIELDS = new Set(['mode', 'caFile']);
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^\[?[0-9A-Fa-f:.]{2,45}\]?$/;
const DATABASE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const ROLE = /^[A-Za-z0-9_][A-Za-z0-9_$.@-]{0,62}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const MAX_PASSWORD = 512;

function invalid(code, message, field) {
    return new ConnectionError(code, message, field ? { field } : {});
}

function isLoopback(host) {
    return LOOPBACK.has(String(host).replace(/^\[|\]$/g, '').toLowerCase());
}

/**
 * Validate and normalize the settings. `password` may be empty (a server that
 * trusts the connection); everything else is required except `schema`, `port`
 * and the TLS block.
 *
 * @param {Object} input
 * @returns {{ host: string, port: number, database: string, schema: string, user: string, password: string, tls: { mode: string, caFile: string|null } }}
 */
function parseConnection(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('INVALID_CONNECTION', 'The connection must be an object.');
    for (const key of Object.keys(input)) {
        if (!FIELDS.has(key)) throw invalid('INVALID_CONNECTION', 'The connection has a field this version does not accept.', key);
    }
    const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
    if (!host || host.length > 253 || !(HOST.test(host) || IPV6.test(host))) {
        throw invalid('INVALID_HOST', 'The host must be a DNS name or an IP address (no scheme, port or path).', 'host');
    }
    let port = 5432;
    if (input.port !== undefined && input.port !== null && input.port !== '') {
        port = Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('INVALID_PORT', 'The port must be a whole number from 1 to 65535.', 'port');
    }
    const database = typeof input.database === 'string' ? input.database.trim() : '';
    if (!DATABASE.test(database)) throw invalid('INVALID_DATABASE', 'The database name is 1 to 63 letters, digits, underscores, dashes or dollar signs.', 'database');
    const schema = input.schema === undefined || input.schema === null || input.schema === '' ? 'public' : String(input.schema).trim();
    if (!SCHEMA.test(schema) || /^pg_/i.test(schema) || schema.toLowerCase() === 'information_schema') {
        throw invalid('INVALID_SCHEMA', 'The schema name is 1 to 63 letters, digits, underscores or dollar signs, starting with a letter or underscore, and is not a system schema.', 'schema');
    }
    const user = typeof input.user === 'string' ? input.user.trim() : '';
    if (!ROLE.test(user)) throw invalid('INVALID_USER', 'The user name is 1 to 63 letters, digits, underscores, dots, dashes or @ signs.', 'user');
    const password = input.password === undefined || input.password === null ? '' : input.password;
    if (typeof password !== 'string' || password.length > MAX_PASSWORD || password.includes('\0')) throw invalid('INVALID_PASSWORD', 'The password must be text of at most 512 characters.', 'password');

    const rawTls = input.tls === undefined || input.tls === null ? {} : input.tls;
    if (typeof rawTls !== 'object' || Array.isArray(rawTls)) throw invalid('INVALID_TLS', 'The TLS settings must be an object.', 'tls');
    for (const key of Object.keys(rawTls)) {
        if (!TLS_FIELDS.has(key)) throw invalid('INVALID_TLS', 'The TLS settings have a field this version does not accept.', `tls.${key}`);
    }
    const mode = rawTls.mode === undefined || rawTls.mode === '' ? (isLoopback(host) ? 'prefer' : 'require') : rawTls.mode;
    if (!TLS_MODES.includes(mode)) throw invalid('INVALID_TLS_MODE', `The TLS mode must be one of ${TLS_MODES.join(', ')}.`, 'tls.mode');
    let caFile = null;
    if (rawTls.caFile !== undefined && rawTls.caFile !== null && rawTls.caFile !== '') {
        if (typeof rawTls.caFile !== 'string' || rawTls.caFile.length > 4096 || rawTls.caFile.includes('\0') || !path.isAbsolute(rawTls.caFile)) {
            throw invalid('INVALID_TLS_CA', 'The CA file must be an absolute path.', 'tls.caFile');
        }
        caFile = path.resolve(rawTls.caFile);
    }
    if (mode === 'verify-full' && !caFile) {
        throw invalid('TLS_CA_REQUIRED', 'verify-full needs the CA file that signed the server certificate (a system bundle such as /etc/ssl/certs/ca-certificates.crt works for a public CA).', 'tls.caFile');
    }
    if (mode === 'disable' && caFile) throw invalid('INVALID_TLS', 'A CA file does nothing with TLS disabled.', 'tls.caFile');
    return { host, port, database, schema, user, password, tls: { mode, caFile } };
}

/** The same settings without the password: safe for a plan, a record, a log or a response. */
function publicConnection(connection) {
    const { password: _password, ...rest } = connection;
    return { ...rest, tls: { ...connection.tls }, local: isLoopback(connection.host) };
}

/** The `-c search_path=` startup option for a schema: the schema first, then `public` for the extension types. */
function searchPathOption(schema) {
    return schema === 'public' ? '-c search_path=public' : `-c search_path=${schema},public`;
}

function tlsParams(mode, caFile) {
    switch (mode) {
    case 'disable': return [['sslmode', 'disable']];
    case 'require': return [['sslmode', 'require'], ['uselibpqcompat', 'true'], ...(caFile ? [['sslrootcert', caFile]] : [])];
    case 'verify-full': return [['sslmode', 'verify-full'], ['uselibpqcompat', 'true'], ['sslrootcert', caFile]];
    default: throw invalid('TLS_UNRESOLVED', '"prefer" is resolved by the probe first; build the URL with the effective mode.', 'tls.mode');
    }
}

/**
 * The connection URL. `tlsMode` overrides the requested mode (the probe's
 * `effective`); `prefer` itself cannot be turned into a URL.
 */
function connectionUrl(connection, { tlsMode = connection.tls.mode, database = connection.database, user = connection.user, password = connection.password, schema = connection.schema } = {}) {
    const host = /^[0-9a-f:]*:[0-9a-f:.]*$/i.test(connection.host) && !connection.host.startsWith('[') ? `[${connection.host}]` : connection.host;
    const credentials = `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@`;
    const params = [['options', searchPathOption(schema)], ...tlsParams(tlsMode, connection.tls.caFile)];
    const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    return `postgres://${credentials}${host}:${connection.port}/${encodeURIComponent(database)}?${query}`;
}

/** The TLS settings a saved URL carries, as a mode and whether a CA file is named. */
function tlsOfUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        return { mode: 'prefer', ca: false };
    }
    const mode = parsed.searchParams.get('sslmode');
    const ca = Boolean(parsed.searchParams.get('sslrootcert'));
    if (!mode) return { mode: 'prefer', ca };
    if (mode === 'disable') return { mode: 'disable', ca: false };
    if (mode === 'verify-full' || mode === 'verify-ca') return { mode: 'verify-full', ca };
    return { mode: 'require', ca };
}

/** The non-secret view of a saved connection URL: host, port, database, user, schema, TLS. Throws `INVALID_TARGET` on junk. */
function describeUrl(url) {
    const description = describeTarget(url);
    return { ...publicTarget(description), tls: tlsOfUrl(url) };
}

/** The settings behind a URL as `parseConnection` input without the password (for pre-filling a form). */
function connectionOfUrl(url) {
    const description = describeTarget(url);
    const tls = tlsOfUrl(url);
    let caFile = null;
    try { caFile = new URL(String(url)).searchParams.get('sslrootcert') || null; } catch { /* described above */ }
    return {
        host: description.host,
        port: description.port,
        database: description.database,
        schema: description.schema || 'public',
        user: description.user || '',
        tls: { mode: tls.mode, caFile }
    };
}

/** Read a CA file; a missing or unreadable file is a refusal that names no path content. */
function readCa(caFile) {
    try {
        const stat = fs.statSync(caFile);
        if (!stat.isFile() || stat.size === 0 || stat.size > 1 << 20) throw new Error('shape');
        return fs.readFileSync(caFile, 'utf8');
    } catch {
        throw invalid('TLS_CA_UNREADABLE', 'The CA file cannot be read: it must be an existing regular file under 1 MB that the manager may read.', 'tls.caFile');
    }
}

/**
 * The options `pg` is given for a mode, built by hand so the probe's behaviour
 * does not depend on how a driver release parses a URL. A unit test checks that
 * the URL `connectionUrl` writes means the same thing to the driver.
 * @returns {false | Object} the `ssl` client option
 */
function sslOptions(connection, mode = connection.tls.mode) {
    switch (mode) {
    case 'disable': return false;
    case 'require':
        return connection.tls.caFile
            ? { ca: readCa(connection.tls.caFile), rejectUnauthorized: true, checkServerIdentity: () => undefined }
            : { rejectUnauthorized: false };
    case 'verify-full':
        return { ca: readCa(connection.tls.caFile), rejectUnauthorized: true };
    default: throw invalid('TLS_UNRESOLVED', '"prefer" is resolved by the probe first.', 'tls.mode');
    }
}

module.exports = {
    TLS_MODES,
    parseConnection,
    publicConnection,
    connectionUrl,
    searchPathOption,
    describeUrl,
    connectionOfUrl,
    tlsOfUrl,
    sslOptions,
    readCa,
    isLoopback
};
