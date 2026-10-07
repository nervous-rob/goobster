/**
 * The connection probe (documentation/database_connection.md): everything an
 * operator needs to know about an existing Postgres server before choosing it,
 * read without changing anything.
 *
 * It is built on the migration preflight's read-only inspector
 * (`migration/inspect.inspectPostgres`: one short-lived `pg` client inside
 * `BEGIN READ ONLY ... ROLLBACK`; no facade, no schema bootstrap, no CREATE) and adds what
 * a chooser needs on top: the client library version, the TLS outcome, the
 * SQLSTATE of a failed connection told apart (wrong credentials, missing
 * database, no privilege, unreachable), the schema compared with this release,
 * each required extension as library-available / created-in-this-database /
 * creatable, and a verdict with findings that name their remediation and, when
 * something must be provisioned, the statements for it.
 *
 * Nothing here returns a password or a URL. The report carries the public
 * target (host, port, database, user, schema, fingerprint, TLS), names,
 * counts and booleans.
 */

const { inspectPostgres, REQUIRED_EXTENSIONS, MIN_SERVER_VERSION } = require('../migration/inspect');
const { publicTarget, describeTarget } = require('../migration/target');
const { parseConnection, connectionUrl, publicConnection, sslOptions } = require('./settings');
const { classifySchema } = require('./schemaState');
const { dbaScript, displayPlan } = require('./provisioning');

const CONNECT_TIMEOUT_MS = 8000;
const TLS_FALLBACK = new Set(['SSL_NOT_SUPPORTED', '28000', 'ECONNRESET']);
const NETWORK = {
    ENOTFOUND: 'HOST_NOT_FOUND', EAI_AGAIN: 'HOST_NOT_FOUND',
    ECONNREFUSED: 'CONNECTION_REFUSED',
    ETIMEDOUT: 'CONNECTION_TIMEOUT', EHOSTUNREACH: 'CONNECTION_TIMEOUT', ENETUNREACH: 'CONNECTION_TIMEOUT', ECONNRESET: 'CONNECTION_RESET'
};
const CERTIFICATE = /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_[A-Z_0-9]+|HOSTNAME_MISMATCH)$/;

/** What a remediation says for each finding; the UI shows it next to the finding. */
const REMEDIATION = Object.freeze({
    HOST_NOT_FOUND: 'The host name did not resolve. Check the spelling and that this machine can resolve it (DNS, /etc/hosts, a VPN).',
    CONNECTION_REFUSED: 'Nothing is listening on that host and port, or a firewall refused it. Check the port and that the server accepts connections from this machine (listen_addresses, pg_hba.conf).',
    CONNECTION_TIMEOUT: 'The server did not answer in time. Check the address, the port and any firewall or security group between this machine and the server.',
    CONNECTION_RESET: 'The connection was dropped while it was being set up. Check TLS settings and that the port is a Postgres port.',
    CONNECTION_ERROR: 'The server reported a connection error. Check that it is running and not at its connection limit.',
    TARGET_UNREACHABLE: 'The server could not be reached. Check the host, the port and the network between this machine and the server.',
    AUTH_FAILED: 'The server rejected the user name or password. Check both. If the application role does not exist yet, tick "create the application role" below and run the provisioning with an administrative credential. If the password is right, pg_hba.conf may not allow this user from this address.',
    DATABASE_MISSING: 'The database does not exist on this server. Create it with the provisioning step below (it needs an administrative credential), or ask your database administrator.',
    PERMISSION_DENIED: 'The role may not connect to this database. Grant it CONNECT, or use the provisioning step below.',
    TLS_UNSUPPORTED: 'The server does not offer TLS. Use "disable" only on a network you trust, or enable TLS on the server.',
    TLS_CERTIFICATE: 'The server\'s certificate could not be verified. Give the CA file that signed it (and use the host name the certificate names), or choose "require" to encrypt without verifying.',
    SERVER_TOO_OLD: 'Goobster needs PostgreSQL 13 or newer. Upgrading the server is a separate job (see postgres_setup.md); this installer never upgrades a server.',
    SCHEMA_MISSING: 'The schema does not exist in this database. Tick "create the schema" in the provisioning step, or name a schema that exists.',
    NO_CREATE_PRIVILEGE: 'The role may not create tables in this schema. Grant USAGE and CREATE on the schema, or use the provisioning step below.',
    EXTENSION_LIBRARY_MISSING: 'The server does not have this extension installed as a library. It must be added to the server itself (a package such as postgresql-<version>-pgvector, or a setting in your hosting panel); no SQL can add it.',
    EXTENSION_PRIVILEGE: 'The extension is installed on the server but not created in this database, and this role may not create it. Run CREATE EXTENSION as an administrator (the provisioning step does it).',
    EXTENSION_NOT_CREATED: 'The extension library is on the server but has not been created in this database yet. Applying the schema (or the provisioning step) creates it.',
    SCHEMA_FOREIGN: 'The schema already holds tables or other objects that are not Goobster\'s. Goobster never writes into it: choose an empty schema or database.',
    SCHEMA_NEWER: 'The schema was written by a newer release of Goobster. Update this installation instead of pointing it at that database.',
    SCHEMA_OLDER: 'The schema is from an older release of Goobster. It will be brought up to date when the application starts; nothing is lost.',
    SCHEMA_EMPTY: 'The schema is empty. Apply the schema to prepare it.',
    SCHEMA_CURRENT: 'The schema matches this release.',
    TLS_NOT_VERIFIED: 'The traffic is encrypted but the server\'s identity is not checked, so someone in the middle could pose as the server. Use verify-full with the CA file for a server across an untrusted network.',
    TLS_NOT_ENCRYPTED: 'The connection is not encrypted. Anyone on the network path can read the traffic, including the password exchange.'
});

const find = (code, detail, extra = {}) => ({ code, detail, remediation: REMEDIATION[code] || '', ...extra });

function clientVersion() {
    try {
        return require('pg/package.json').version;
    } catch {
        try {
            return JSON.parse(require('node:fs').readFileSync(require.resolve('pg/package.json'), 'utf8')).version;
        } catch {
            return null;
        }
    }
}

function defaultCreateClient(config) {
    const { Client } = require('pg');
    return new Client(config);
}

function failureCode(code) {
    if (code === '28P01' || code === '28000') return 'AUTH_FAILED';
    if (code === '3D000') return 'DATABASE_MISSING';
    if (code === '42501') return 'PERMISSION_DENIED';
    if (code === 'SSL_NOT_SUPPORTED') return 'TLS_UNSUPPORTED';
    if (code && CERTIFICATE.test(code)) return 'TLS_CERTIFICATE';
    if (code && NETWORK[code]) return NETWORK[code];
    if (code && /^08/.test(code)) return 'CONNECTION_ERROR';
    return 'TARGET_UNREACHABLE';
}

function versionText(number) {
    const major = Math.floor(number / 10000);
    const minor = number % 10000;
    return major >= 10 ? `${major}.${minor}` : `${major}.${Math.floor(minor / 100)}.${minor % 100}`;
}

function extensionState(info, { superuser, canCreateInDatabase }) {
    const canCreate = Boolean(info.installed || (info.available && (superuser || (info.trusted && canCreateInDatabase))));
    const state = info.installed ? 'created' : (info.available ? 'library-only' : 'library-missing');
    const summary = state === 'created'
        ? 'created in this database'
        : (state === 'library-only' ? 'library installed on the server, not created in this database' : 'library not installed on the server');
    return { ...info, canCreate, state, summary };
}

/** One attempt: build the `pg` client for a TLS mode and run the read-only inspection through it. */
async function attempt(connection, mode, { createClient, inspect }) {
    const url = connectionUrl(connection, { tlsMode: mode });
    const config = {
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password: connection.password || undefined,
        ssl: sslOptions(connection, mode),
        options: `-c search_path=${connection.schema === 'public' ? 'public' : `${connection.schema},public`}`,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: 15000
    };
    return inspect(url, { connect: () => createClient(config) });
}

/**
 * @param {Object} input the connection settings (`settings.parseConnection` shape)
 * @param {{ createClient?: Function, inspect?: Function, activeFingerprint?: string|null }} [deps]
 */
async function probeConnection(input, { createClient = defaultCreateClient, inspect = inspectPostgres, activeFingerprint = null } = {}) {
    const connection = parseConnection(input);
    const requested = connection.tls.mode;
    const modes = requested === 'prefer' ? ['require', 'disable'] : [requested];
    let inspected = null;
    let effective = null;
    for (const mode of modes) {
        inspected = await attempt(connection, mode, { createClient, inspect });
        effective = mode;
        if (inspected.reachable || !(requested === 'prefer' && mode === 'require' && TLS_FALLBACK.has(inspected.code))) break;
    }

    let maintenance = null;
    if (!inspected.reachable && inspected.code === '3D000') {
        try {
            const sibling = await attempt({ ...connection, database: 'postgres', schema: 'public' }, effective, { createClient, inspect });
            if (sibling.reachable) maintenance = sibling;
        } catch { /* the database is missing and the maintenance database could not be read either */ }
    }
    return buildReport({ connection, requested, effective, inspected, maintenance, activeFingerprint });
}

function buildReport({ connection, requested, effective, inspected, maintenance, activeFingerprint }) {
    const description = describeTarget(connectionUrl(connection, { tlsMode: effective, password: '' }));
    const target = { ...publicTarget(description), schema: connection.schema };
    const blocks = [];
    const warnings = [];
    const notes = [];
    const certifies = effective === 'verify-full' || (effective === 'require' && Boolean(connection.tls.caFile));
    const source = inspected.reachable ? inspected : (maintenance || null);
    const superuser = Boolean(source && source.isSuperuser);
    const canCreateInDatabase = Boolean(inspected.reachable && inspected.canCreateInDatabase);

    const report = {
        target: { ...target, tls: { mode: effective, ca: Boolean(connection.tls.caFile) } },
        reachable: Boolean(inspected.reachable),
        auth: 'ok',
        code: null,
        server: source ? { version: source.serverVersion, text: source.serverVersionText || versionText(source.serverVersion), supported: source.serverVersion >= MIN_SERVER_VERSION, minimum: MIN_SERVER_VERSION } : null,
        client: { pg: clientVersion() },
        tls: {
            requested,
            effective,
            encrypted: inspected.reachable ? inspected.tls && inspected.tls.encrypted : null,
            protocol: inspected.reachable ? (inspected.tls && inspected.tls.protocol) || null : null,
            verified: Boolean(inspected.reachable && certifies)
        },
        role: source ? { user: source.user, superuser, createDatabase: Boolean(source.canCreateDatabase), createRole: Boolean(source.canCreateRole) } : null,
        privileges: { connect: Boolean(inspected.reachable), createInDatabase: canCreateInDatabase, createInSchema: Boolean(inspected.reachable && inspected.canCreateInSchema) },
        schema: null,
        extensions: null,
        active: Boolean(activeFingerprint && target.fingerprint === activeFingerprint)
    };

    if (!inspected.reachable) {
        const code = inspected.code || 'CONNECT_FAILED';
        const finding = failureCode(code);
        report.code = code;
        report.auth = ({ AUTH_FAILED: 'wrong-credentials', DATABASE_MISSING: 'database-missing', PERMISSION_DENIED: 'permission-denied', TLS_UNSUPPORTED: 'tls-failed', TLS_CERTIFICATE: 'tls-failed' })[finding] || 'unreachable';
        blocks.push(find(finding, `The server answered with ${code}.`, { sqlstate: /^[0-9A-Z]{5}$/.test(code) ? code : undefined }));
        if (report.server && !report.server.supported) blocks.push(find('SERVER_TOO_OLD', `The server is ${report.server.text}; Goobster needs PostgreSQL 13 or newer.`));
    } else {
        if (!report.server.supported) blocks.push(find('SERVER_TOO_OLD', `The server is ${report.server.text}; Goobster needs PostgreSQL 13 or newer.`));
        if (report.tls.encrypted === false && !target.local) warnings.push(find('TLS_NOT_ENCRYPTED', 'This connection to a remote server is not encrypted.'));
        else if (report.tls.encrypted === true && !report.tls.verified && !target.local) warnings.push(find('TLS_NOT_VERIFIED', 'This connection is encrypted but the server\'s certificate was not checked.'));
        const found = classifySchema({ schemaExists: inspected.schemaExists, tables: inspected.tables || [], otherRelations: inspected.otherRelations || [] });
        report.schema = { name: connection.schema, exists: inspected.schemaExists, ...found };
        if (!inspected.schemaExists) blocks.push(find('SCHEMA_MISSING', `The schema "${connection.schema}" does not exist in the database "${connection.database}".`));
        else if (!report.privileges.createInSchema) blocks.push(find('NO_CREATE_PRIVILEGE', `The role "${inspected.user}" cannot create tables in the schema "${connection.schema}".`));
        if (found.state === 'foreign') blocks.push(find('SCHEMA_FOREIGN', `The schema holds objects that are not Goobster's (${found.foreign.slice(0, 5).join(', ')}).`, { objects: found.foreign.slice(0, 10) }));
        else if (found.state === 'goobster-newer') blocks.push(find('SCHEMA_NEWER', `The schema has columns this release does not know (${found.extraColumns.slice(0, 5).join(', ')}).`));
        else if (found.state === 'goobster-older') warnings.push(find('SCHEMA_OLDER', `${found.missingTables.length} table(s) and ${found.missingColumns.length} column(s) of this release are missing.`));
        else if (found.state === 'empty') notes.push(find('SCHEMA_EMPTY', 'The schema holds nothing yet.'));
        else if (found.state === 'goobster-current') notes.push(find('SCHEMA_CURRENT', `The schema matches this release (fingerprint ${found.fingerprint}).`));

        report.extensions = {};
        for (const name of REQUIRED_EXTENSIONS) {
            const info = extensionState(inspected.extensions[name], { superuser, canCreateInDatabase });
            report.extensions[name] = info;
            if (info.state === 'library-missing') blocks.push(find('EXTENSION_LIBRARY_MISSING', `The ${name} extension is not installed on the server.`, { extension: name }));
            else if (info.state === 'library-only' && !info.canCreate) blocks.push(find('EXTENSION_PRIVILEGE', `The ${name} extension is installed on the server but not created in "${connection.database}", and the role may not create it.`, { extension: name }));
            else if (info.state === 'library-only') warnings.push(find('EXTENSION_NOT_CREATED', `The ${name} extension is installed on the server but not created in "${connection.database}" yet.`, { extension: name }));
        }
    }

    if (maintenance) {
        report.server = { version: maintenance.serverVersion, text: maintenance.serverVersionText || versionText(maintenance.serverVersion), supported: maintenance.serverVersion >= MIN_SERVER_VERSION, minimum: MIN_SERVER_VERSION };
    }

    const provisioning = requiredProvisioning({ connection, report, blocks, warnings, maintenance });
    const next = nextStep({ blocks, report, provisioning });
    report.verdict = {
        ok: blocks.length === 0,
        next,
        blocks,
        warnings,
        notes,
        provisioning: {
            required: provisioning,
            dba: dbaScript(provisioning.map(item => item.action), { ...connection, password: '' })
        }
    };
    return report;
}

const PROVISIONABLE = new Set(['AUTH_FAILED', 'DATABASE_MISSING', 'PERMISSION_DENIED', 'SCHEMA_MISSING', 'NO_CREATE_PRIVILEGE', 'EXTENSION_PRIVILEGE']);

/** The provisioning actions the findings call for, with the reason each is needed and the statements it stands for. */
function requiredProvisioning({ connection, report, blocks, warnings }) {
    const wanted = new Map();
    const need = (action, reason) => { if (!wanted.has(action)) wanted.set(action, reason); };
    const all = [...blocks, ...warnings];
    const codes = new Set(all.map(item => item.code));
    if (blocks.some(item => !PROVISIONABLE.has(item.code))) return [];
    if (codes.has('DATABASE_MISSING')) {
        need('create-database', `The database "${connection.database}" does not exist.`);
        need('create-role', `The role "${connection.user}" is created with the database if it does not exist yet.`);
        if (connection.schema !== 'public') need('create-schema', `The schema "${connection.schema}" is created in the new database.`);
        need('grant', 'The role needs CONNECT on the database and USAGE and CREATE on the schema.');
        for (const name of REQUIRED_EXTENSIONS) need(`create-extension.${name}`, `The ${name} extension is created in the new database.`);
    }
    if (codes.has('AUTH_FAILED')) need('create-role', `If the role "${connection.user}" does not exist, it is created with the password you entered.`);
    if (codes.has('PERMISSION_DENIED')) need('grant', `The role "${connection.user}" needs CONNECT on the database.`);
    if (codes.has('SCHEMA_MISSING')) {
        need('create-schema', `The schema "${connection.schema}" does not exist.`);
        need('grant', 'The role needs USAGE and CREATE on the schema.');
    }
    if (codes.has('NO_CREATE_PRIVILEGE')) need('grant', `The role needs USAGE and CREATE on the schema "${connection.schema}".`);
    for (const item of all) {
        if ((item.code === 'EXTENSION_PRIVILEGE' || item.code === 'EXTENSION_NOT_CREATED') && item.extension) need(`create-extension.${item.extension}`, `The ${item.extension} extension is not created in the database.`);
    }
    void report;
    const actions = [...wanted.keys()];
    return displayPlan(actions, { ...connection, password: '' }).map(entry => ({
        action: entry.action,
        reason: wanted.get(entry.action),
        statements: entry.statements.map(statement => statement.sql)
    }));
}

function nextStep({ blocks, report, provisioning }) {
    if (blocks.length > 0) return provisioning.length > 0 ? 'provision' : 'fix';
    if (!report.schema) return 'fix';
    if (report.schema.state === 'empty') return 'apply-schema';
    return 'connect';
}

module.exports = { probeConnection, buildReport, REMEDIATION, failureCode, clientVersion, versionText, publicConnection };
