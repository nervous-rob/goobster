/**
 * Explicit provisioning of an existing Postgres server for Goobster
 * (documentation/database_connection.md): create the database, a
 * least-privilege application role, the schema, the two extensions, and the
 * grants - and nothing else.
 *
 * Boundaries this module enforces (the tests prove each):
 *
 *   - It acts only on the selected database, the selected schema and the
 *     application role by name. No other database, role or schema is read for
 *     writing, and every statement names exactly those objects.
 *   - The application role is created `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
 *     NOREPLICATION NOBYPASSRLS` with `CONNECT` on the database and `USAGE` +
 *     `CREATE` on the schema. An existing role is never altered (`ROLE_EXISTS`).
 *   - It refuses a schema that already holds anything that is not Goobster's
 *     (`SCHEMA_FOREIGN`) before changing anything.
 *   - The elevated credential lives in the arguments of one call. It is not
 *     returned, not persisted and not written into a statement: the new role's
 *     password is sent as a SCRAM-SHA-256 verifier, so even a server that logs
 *     DDL statements never sees it in the clear.
 *   - When the elevated role lacks a privilege the work needs, nothing runs:
 *     the refusal carries the statements a database administrator must run,
 *     with a placeholder where the password goes.
 *
 * Connection handling is injectable (`createClient`) so the manager and the
 * tests share one implementation; the default opens a short-lived `pg` client.
 */

const crypto = require('node:crypto');
const { ConnectionError } = require('./errors');
const { REQUIRED_EXTENSIONS } = require('../migration/inspect');
const { classifySchema } = require('./schemaState');
const { sslOptions } = require('./settings');

const ACTIONS = Object.freeze(['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant']);
const PASSWORD_PLACEHOLDER = '<APPLICATION_PASSWORD>';
const RESERVED_DATABASES = new Set(['postgres', 'template0', 'template1']);
const RESERVED_ROLES = new Set(['postgres', 'public', 'none', 'current_user', 'session_user', 'current_role']);
const CONNECT_TIMEOUT_MS = 10000;

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

function isExtensionAction(action) {
    return action.startsWith('create-extension.');
}

/**
 * The statements an action stands for, as display text with a placeholder where
 * the password goes. `scope` says where it runs: on the server (any database)
 * or inside the selected database.
 */
function statementsFor(action, application) {
    const db = quote(application.database);
    const role = quote(application.user);
    const schema = quote(application.schema);
    switch (action) {
    case 'create-role':
        return [{ scope: 'server', sql: `CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD_PLACEHOLDER}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;` }];
    case 'create-database':
        return [{ scope: 'server', sql: `CREATE DATABASE ${db};` }];
    case 'create-schema':
        return application.schema === 'public' ? [] : [{ scope: 'database', sql: `CREATE SCHEMA ${schema};` }];
    case 'grant':
        return [
            { scope: 'server', sql: `GRANT CONNECT ON DATABASE ${db} TO ${role};` },
            { scope: 'database', sql: `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role};` }
        ];
    default:
        if (isExtensionAction(action)) return [{ scope: 'database', sql: `CREATE EXTENSION IF NOT EXISTS ${action.slice('create-extension.'.length)} WITH SCHEMA public;` }];
        throw new ConnectionError('UNKNOWN_ACTION', 'That is not a provisioning action.');
    }
}

/** Display text for a set of actions, in a stable execution order, each tagged with where it runs. */
function displayPlan(actions, application) {
    const ordered = ACTIONS.filter(action => actions.includes(action));
    return ordered.map(action => ({ action, statements: statementsFor(action, application) }));
}

function dbaScript(actions, application) {
    const lines = [];
    let scope = null;
    for (const entry of displayPlan(actions, application)) {
        for (const statement of entry.statements) {
            if (statement.scope !== scope) {
                lines.push(statement.scope === 'database' ? `-- connected to the database ${quote(application.database)}:` : '-- connected to any database (the maintenance database):');
                scope = statement.scope;
            }
            lines.push(statement.sql);
        }
    }
    return lines;
}

function parseActions(list) {
    if (!Array.isArray(list) || list.length === 0 || list.length > ACTIONS.length) throw new ConnectionError('INVALID_ACTIONS', 'Tick at least one provisioning action.');
    const seen = new Set();
    for (const action of list) {
        if (typeof action !== 'string' || !ACTIONS.includes(action)) throw new ConnectionError('INVALID_ACTIONS', 'That is not a provisioning action this version knows.');
        seen.add(action);
    }
    return ACTIONS.filter(action => seen.has(action));
}

/** SCRAM-SHA-256 verifier for a plain ASCII password, in the format `CREATE ROLE ... PASSWORD` accepts as already hashed. */
function scramVerifier(password, { salt = crypto.randomBytes(16), iterations = 4096 } = {}) {
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const salted = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const serverKey = hmac(salted, 'Server Key');
    return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function defaultCreateClient({ application, credential, database, tlsMode }) {
    const { Client } = require('pg');
    return new Client({
        host: application.host,
        port: application.port,
        database,
        user: credential.user,
        password: credential.password || undefined,
        ssl: sslOptions(application, tlsMode),
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: 30000
    });
}

function checkNames(application, elevated) {
    if (RESERVED_DATABASES.has(application.database.toLowerCase())) throw new ConnectionError('RESERVED_NAME', 'The database name is one of the server\'s own databases; choose another.');
    if (RESERVED_ROLES.has(application.user.toLowerCase()) || /^pg_/i.test(application.user)) throw new ConnectionError('RESERVED_NAME', 'The application role name is reserved; choose another.');
    if (elevated.user === application.user) throw new ConnectionError('SAME_ROLE', 'The elevated user and the application user are the same role; give a separate administrative credential.');
    if (!elevated.user || typeof elevated.user !== 'string' || elevated.user.length > 63) throw new ConnectionError('INVALID_ELEVATED', 'The elevated user name is required.');
    if (typeof (elevated.password || '') !== 'string' || (elevated.password || '').length > 512) throw new ConnectionError('INVALID_ELEVATED', 'The elevated password must be text.');
}

async function openClient(createClient, params) {
    const client = createClient(params);
    client.on?.('error', () => { });
    try {
        await client.connect();
    } catch (error) {
        const code = String((error && error.code) || 'CONNECT_FAILED').slice(0, 40);
        throw new ConnectionError('ELEVATED_CONNECT_FAILED', 'The elevated credential could not connect.', { cause: code });
    }
    return client;
}

const closeQuietly = async (client) => { try { await client.end(); } catch { /* best effort */ } };

/**
 * Read-only look at what the actions need and whether the elevated role may do
 * it. Opens and closes its own connections; changes nothing.
 *
 * @returns {Promise<{ permitted: Record<string, boolean>, dba: string[], state: Object, capabilities: Object }>}
 */
async function checkProvisioning({ application, elevated, actions, tlsMode, createClient = defaultCreateClient }) {
    checkNames(application, elevated);
    const wanted = parseActions(actions);
    const maintenance = await openClient(createClient, { application, credential: elevated, database: elevated.database || 'postgres', tlsMode });
    const state = { roleExists: false, databaseExists: false, schemaExists: false, schemaState: null, extensions: {} };
    let capabilities;
    try {
        capabilities = (await maintenance.query(
            `SELECT rolsuper AS super, rolcreatedb AS createdb, rolcreaterole AS createrole FROM pg_roles WHERE rolname = current_user`
        )).rows[0] || { super: false, createdb: false, createrole: false };
        state.roleExists = (await maintenance.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [application.user])).rowCount > 0;
        const database = (await maintenance.query(
            `SELECT pg_has_role(current_user, datdba, 'USAGE') AS owner FROM pg_database WHERE datname = $1`, [application.database]
        )).rows[0];
        state.databaseExists = Boolean(database);
        state.databaseOwner = Boolean(database && database.owner);
        const available = (await maintenance.query(
            `SELECT a.name, COALESCE(v.trusted, false) AS trusted
             FROM pg_available_extensions a
             LEFT JOIN pg_available_extension_versions v ON v.name = a.name AND v.version = a.default_version
             WHERE a.name = ANY($1::text[])`, [REQUIRED_EXTENSIONS]
        )).rows;
        for (const name of REQUIRED_EXTENSIONS) {
            const row = available.find(item => item.name === name);
            state.extensions[name] = { available: Boolean(row), installed: false, trusted: Boolean(row && row.trusted) };
        }
    } finally {
        await closeQuietly(maintenance);
    }

    let canCreateInDatabase = false;
    let schemaOwner = false;
    if (state.databaseExists) {
        const target = await openClient(createClient, { application, credential: elevated, database: application.database, tlsMode });
        try {
            canCreateInDatabase = (await target.query(`SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok`)).rows[0].ok;
            const schema = (await target.query(`SELECT pg_has_role(current_user, nspowner, 'USAGE') AS owner FROM pg_namespace WHERE nspname = $1`, [application.schema])).rows[0];
            state.schemaExists = Boolean(schema);
            schemaOwner = Boolean(schema && schema.owner);
            if (state.schemaExists) {
                const found = (await target.query(
                    `SELECT c.relname AS name, c.relkind AS kind,
                            COALESCE(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped), '{}') AS columns
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid = c.oid
                     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') GROUP BY c.relname, c.relkind ORDER BY c.relname LIMIT 650`, [application.schema]
                )).rows;
                state.schemaState = classifySchema({
                    schemaExists: true,
                    tables: found.filter(row => row.kind === 'r' || row.kind === 'p').map(row => ({ name: row.name, columns: row.columns })),
                    otherRelations: found.filter(row => row.kind !== 'r' && row.kind !== 'p').map(row => ({ name: row.name, kind: row.kind }))
                });
            }
            const created = (await target.query('SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])', [REQUIRED_EXTENSIONS])).rows.map(row => row.extname);
            for (const name of created) if (state.extensions[name]) state.extensions[name].installed = true;
        } finally {
            await closeQuietly(target);
        }
    }

    if (state.schemaState && ['foreign', 'goobster-newer'].includes(state.schemaState.state)) {
        throw new ConnectionError('SCHEMA_FOREIGN', state.schemaState.state === 'foreign'
            ? 'The selected schema already holds tables that are not Goobster\'s; provisioning never touches it. Choose an empty schema.'
            : 'The selected schema was written by a newer release of Goobster; provisioning never touches it.', { foreign: state.schemaState.foreign.slice(0, 10) });
    }
    if (wanted.includes('create-role') && state.roleExists) {
        throw new ConnectionError('ROLE_EXISTS', 'A role with that name already exists. It is never altered: use it as it is (untick "create the application role"), or choose another name.');
    }
    const creatingDatabase = wanted.includes('create-database') && !state.databaseExists;
    const needsDatabase = wanted.some(action => action !== 'create-role' && action !== 'create-database');
    if (needsDatabase && !state.databaseExists && !creatingDatabase) {
        throw new ConnectionError('DATABASE_MISSING', 'The database does not exist: tick "create the database" too, or create it first.');
    }
    if ((wanted.includes('grant') || wanted.includes('create-schema')) && !state.roleExists && !wanted.includes('create-role')) {
        throw new ConnectionError('ROLE_MISSING', 'The application role does not exist: tick "create the application role" too.');
    }

    for (const action of wanted.filter(isExtensionAction)) {
        const known = state.extensions[action.slice('create-extension.'.length)];
        if (!known || !known.available) {
            throw new ConnectionError('EXTENSION_LIBRARY_MISSING', `The server does not have the ${action.slice('create-extension.'.length)} extension installed as a library; it must be added to the server itself (a package or a hosting setting). No SQL here can do that.`, { extension: action.slice('create-extension.'.length) });
        }
    }
    if (wanted.includes('grant') && state.databaseExists && !state.schemaExists && !wanted.includes('create-schema')) {
        throw new ConnectionError('SCHEMA_MISSING', 'The schema does not exist: tick "create the schema" too.');
    }

    const isSuper = Boolean(capabilities.super);
    const ownsDatabase = creatingDatabase || state.databaseOwner;
    const ownsSchema = creatingDatabase || schemaOwner || (!state.schemaExists && wanted.includes('create-schema'));
    const permitted = {};
    for (const action of wanted) {
        switch (action) {
        case 'create-role': permitted[action] = isSuper || Boolean(capabilities.createrole); break;
        case 'create-database': permitted[action] = state.databaseExists || isSuper || Boolean(capabilities.createdb); break;
        case 'create-schema': permitted[action] = state.schemaExists || application.schema === 'public' || isSuper || creatingDatabase || canCreateInDatabase; break;
        case 'grant': permitted[action] = isSuper || (ownsDatabase && ownsSchema); break;
        default: {
            const known = state.extensions[action.slice('create-extension.'.length)];
            permitted[action] = known.installed || isSuper || (known.trusted && (canCreateInDatabase || creatingDatabase));
        }
        }
    }
    const blocked = wanted.filter(action => !permitted[action]);
    return { permitted, dba: dbaScript(blocked, application), blocked, state, capabilities: { superuser: isSuper, createDatabase: Boolean(capabilities.createdb), createRole: Boolean(capabilities.createrole) } };
}

/**
 * Run the ticked actions, in a fixed order, on the selected database only.
 * `checkProvisioning` runs first and refuses before any change.
 *
 * @returns {Promise<{ results: Array<{ action: string, status: 'done'|'already' }> }>}
 */
async function runProvisioning({ application, elevated, actions, tlsMode, createClient = defaultCreateClient }) {
    const wanted = parseActions(actions);
    const check = await checkProvisioning({ application, elevated, actions: wanted, tlsMode, createClient });
    if (check.blocked.length > 0) {
        throw new ConnectionError('PROVISIONING_NOT_PERMITTED', 'The elevated credential does not have the privileges these actions need. Nothing was changed. Ask the database administrator to run the statements in "dba".', {
            blocked: check.blocked,
            dba: check.dba
        });
    }
    const results = [];
    const done = (action, status) => results.push({ action, status });
    const state = check.state;

    const server = await openClient(createClient, { application, credential: elevated, database: elevated.database || 'postgres', tlsMode });
    try {
        if (wanted.includes('create-role')) {
            const password = application.password || '';
            let secret;
            if (password && /^[\x20-\x7e]+$/.test(password)) secret = `'${scramVerifier(password)}'`;
            else secret = password ? server.escapeLiteral(password) : 'NULL';
            await server.query(`CREATE ROLE ${quote(application.user)} LOGIN PASSWORD ${secret} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
            done('create-role', 'done');
        }
        if (wanted.includes('create-database')) {
            if (state.databaseExists) done('create-database', 'already');
            else {
                await server.query(`CREATE DATABASE ${quote(application.database)}`);
                done('create-database', 'done');
            }
        }
        if (wanted.includes('grant')) {
            await server.query(`GRANT CONNECT ON DATABASE ${quote(application.database)} TO ${quote(application.user)}`);
        }
    } finally {
        await closeQuietly(server);
    }

    const insideDatabase = wanted.filter(action => action === 'create-schema' || action === 'grant' || isExtensionAction(action));
    if (insideDatabase.length > 0) {
        const target = await openClient(createClient, { application, credential: elevated, database: application.database, tlsMode });
        try {
            await target.query('BEGIN');
            try {
                for (const action of ACTIONS.filter(item => insideDatabase.includes(item))) {
                    if (isExtensionAction(action)) {
                        const name = action.slice('create-extension.'.length);
                        const known = state.extensions[name];
                        await target.query(`CREATE EXTENSION IF NOT EXISTS ${name} WITH SCHEMA public`);
                        done(action, known && known.installed ? 'already' : 'done');
                    } else if (action === 'create-schema') {
                        if (state.schemaExists || application.schema === 'public') done(action, 'already');
                        else {
                            await target.query(`CREATE SCHEMA ${quote(application.schema)}`);
                            done(action, 'done');
                        }
                    }
                }
                if (insideDatabase.includes('grant')) {
                    await target.query(`GRANT USAGE, CREATE ON SCHEMA ${quote(application.schema)} TO ${quote(application.user)}`);
                }
                await target.query('COMMIT');
            } catch (error) {
                await target.query('ROLLBACK').catch(() => { });
                throw error;
            }
        } catch (error) {
            if (error instanceof ConnectionError) throw error;
            throw new ConnectionError('PROVISIONING_FAILED', 'A provisioning statement failed; the statements before it in the same database transaction were rolled back.', {
                cause: String((error && error.code) || 'ERROR').slice(0, 40),
                completed: results.map(item => item.action)
            });
        } finally {
            await closeQuietly(target);
        }
    }
    if (wanted.includes('grant')) done('grant', 'done');
    return { results: ACTIONS.filter(action => results.some(item => item.action === action)).map(action => results.find(item => item.action === action)) };
}

module.exports = {
    ACTIONS,
    PASSWORD_PLACEHOLDER,
    statementsFor,
    displayPlan,
    dbaScript,
    parseActions,
    scramVerifier,
    checkProvisioning,
    runProvisioning,
    quote
};
