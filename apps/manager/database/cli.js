/**
 * `goobster-manager database test|provision|schema|connect|status`
 * (documentation/database_connection.md). apps/manager/cli.js runs it.
 *
 *   database test        the read-only probe of an existing server (a plain
 *                        function call: no operation, nothing written)
 *   database provision   database.provision: create what the probe said is missing
 *   database schema      database.schema.apply
 *   database connect     database.connect: point this installation at the server
 *   database status      the connection in effect, the engine, whether SQLite is empty
 *
 * Secrets never come from argv (cli.js refuses any `--...password...` flag).
 * The application role's password comes from the answers file (mode 0600),
 * a hidden prompt, or - for `test` and the other subcommands -
 * GOOBSTER_DB_PASSWORD_FILE; the elevated credential of `provision` from the
 * answers file, a hidden prompt or GOOBSTER_DB_ELEVATED_PASSWORD_FILE. Every
 * secret is registered for redaction before anything is printed.
 */

const nodeFs = require('node:fs');
const { ManagerError } = require('../errors');
const { resolveSettings } = require('../settings');
const { createManager } = require('../manager');
const { scrub } = require('../engine/redact');
const { createProbe, redactDeep } = require('./probe');
const { databaseStatus } = require('./state');
const { createBarrier } = require('../maintenance/barrier');
const input = require('./input');

const SUBCOMMANDS = Object.freeze(['test', 'provision', 'schema', 'connect', 'status']);
const DEFINITION = Object.freeze({ test: 'database-test', provision: 'database-provision', schema: 'database-schema', connect: 'database-connect' });
const KIND = Object.freeze({ provision: 'database.provision', schema: 'database.schema.apply', connect: 'database.connect' });
const PASSWORD_FILE = 'GOOBSTER_DB_PASSWORD_FILE';
const ELEVATED_PASSWORD_FILE = 'GOOBSTER_DB_ELEVATED_PASSWORD_FILE';
const ACTION_LABEL = Object.freeze({
    'create-role': 'create the application role (LOGIN, no superuser, no CREATEDB)',
    'create-database': 'create the database',
    'create-extension.citext': 'create the citext extension',
    'create-extension.vector': 'create the vector (pgvector) extension',
    'create-schema': 'create the schema',
    'grant': 'grant CONNECT on the database and USAGE + CREATE on the schema to the role'
});

const yes = (answer) => /^(y|yes)$/i.test(String(answer).trim());

/** A secret read from a file named by the environment: a regular file, owner-only, one line. */
function readSecretFile(file, { fs, cli, name }) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch {
        throw new cli.CliError('ANSWERS_UNREADABLE', `${name} names a file that does not exist or cannot be read.`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new cli.CliError('ANSWERS_UNREADABLE', `${name} must name a regular file, not a link or directory.`);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new cli.CliError('ANSWERS_PERMISSIONS', `${name}'s file holds a secret and must be readable by its owner only (chmod 600); it is mode ${(stat.mode & 0o777).toString(8)}.`);
    }
    if (stat.size > 4096) throw new cli.CliError('ANSWERS_INVALID', `${name}'s file is too large.`);
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

async function promptConnection(prompter, { env, fs, cli }) {
    const connection = { host: await prompter.ask('Host: ') };
    const port = await prompter.ask('Port [5432]: ', { fallback: '5432' });
    connection.port = Number(port);
    connection.database = await prompter.ask('Database: ');
    connection.schema = await prompter.ask('Schema [public]: ', { fallback: 'public' });
    connection.user = await prompter.ask('User: ');
    if (env[PASSWORD_FILE]) connection.password = readSecretFile(env[PASSWORD_FILE], { fs, cli, name: PASSWORD_FILE });
    else connection.password = await prompter.ask('Password (hidden): ', { hidden: true });
    const mode = await prompter.ask('TLS mode (disable, prefer, require, verify-full) [default by host]: ');
    const caFile = await prompter.ask('CA file (absolute path, blank for none): ');
    if (mode || caFile) connection.tls = { ...(mode ? { mode } : {}), ...(caFile ? { caFile } : {}) };
    return connection;
}

async function promptElevated(prompter, { env, fs, cli }) {
    const elevated = { user: await prompter.ask('Administrative user (used for this operation only, never saved): ') };
    if (env[ELEVATED_PASSWORD_FILE]) elevated.password = readSecretFile(env[ELEVATED_PASSWORD_FILE], { fs, cli, name: ELEVATED_PASSWORD_FILE });
    else elevated.password = await prompter.ask('Administrative password (hidden): ', { hidden: true });
    return elevated;
}

async function promptActions(prompter) {
    const chosen = [];
    for (const action of Object.keys(ACTION_LABEL)) {
        if (yes(await prompter.ask(`Do you want to ${ACTION_LABEL[action]}? [y/N]: `))) chosen.push(action);
    }
    return chosen;
}

function place(target) {
    return target ? `${target.host}:${target.port}/${target.database}${target.schema ? ` schema ${target.schema}` : ''}` : 'unknown';
}

function describeReport(report) {
    const lines = ['database test (read only: nothing was written to the server or to the installation)'];
    lines.push(`  target      ${place(report.target)}${report.target.local ? ' (this host)' : ''}${report.active ? ' - the connection in use now' : ''}`);
    lines.push(`  reachable   ${report.reachable ? 'yes' : `no (${report.auth})`}`);
    if (report.server) lines.push(`  server      PostgreSQL ${report.server.text}${report.server.supported ? '' : ' (too old: 13 or newer is needed)'}; client pg ${report.client.pg || 'unknown'}`);
    lines.push(`  tls         ${report.tls.effective}${report.tls.encrypted === null ? '' : (report.tls.encrypted ? `, encrypted${report.tls.protocol ? ` (${report.tls.protocol})` : ''}${report.tls.verified ? ', certificate verified' : ', certificate not verified'}` : ', not encrypted')}`);
    if (report.role) lines.push(`  role        ${report.role.user}${report.role.superuser ? ' (superuser)' : ''}; connect ${report.privileges.connect ? 'yes' : 'no'}, create in database ${report.privileges.createInDatabase ? 'yes' : 'no'}, create in schema ${report.privileges.createInSchema ? 'yes' : 'no'}`);
    if (report.schema) lines.push(`  schema      ${report.schema.state}${report.schema.fingerprint ? ` (fingerprint ${report.schema.fingerprint})` : ''}; this release expects ${report.schema.expectedFingerprint}`);
    for (const [name, info] of Object.entries(report.extensions || {})) {
        lines.push(`  extension   ${name}: ${info.summary}${info.state === 'library-only' ? (info.canCreate ? '; this role can create it' : '; this role cannot create it') : ''}`);
    }
    const verdict = report.verdict;
    lines.push(`  verdict     ${verdict.ok ? 'USABLE' : `BLOCKED (${verdict.blocks.length})`}; next: ${verdict.next}`);
    for (const item of verdict.blocks) lines.push(`    block ${item.code}: ${item.detail}\n          ${item.remediation}`);
    for (const item of verdict.warnings) lines.push(`    warn  ${item.code}: ${item.detail}`);
    for (const item of verdict.notes) lines.push(`    note  ${item.code}: ${item.detail}`);
    if (verdict.provisioning.required.length > 0) {
        lines.push('  provisioning this server needs (database provision):');
        for (const item of verdict.provisioning.required) lines.push(`    ${item.action}: ${item.reason}`);
        lines.push('  or ask your database administrator to run (replace the placeholder):');
        for (const line of verdict.provisioning.dba) lines.push(`    ${line}`);
    }
    return lines;
}

function describePlan(kind, plan) {
    const lines = [`${kind}`];
    if (kind === 'database.provision') {
        lines.push(`  database   ${place(plan.database)}`);
        lines.push(`  elevated   ${plan.elevated.user} (used for this operation only; not saved)`);
        for (const item of plan.actions) {
            lines.push(`  ${item.permitted ? 'will do' : 'BLOCKED'} ${item.action}`);
            for (const statement of item.statements) lines.push(`      [${statement.scope}] ${statement.sql}`);
        }
        if (plan.blocked.length > 0) {
            lines.push('  The elevated role may not do the blocked actions. A database administrator must run:');
            for (const line of plan.dba) lines.push(`    ${line}`);
        }
    } else if (kind === 'database.schema.apply') {
        lines.push(`  database   ${place(plan.database)}`);
        lines.push(`  effect     ${plan.effect}${plan.noop ? ' (nothing to change)' : ''}; schema is ${plan.schema.state}`);
    } else if (kind === 'database.connect') {
        lines.push(`  from       ${plan.from.engine}${plan.from.target ? ` ${place(plan.from.target)}` : ''}`);
        lines.push(`  to         postgres ${place(plan.to)}; schema is ${plan.probe.schema ? plan.probe.schema.state : 'unknown'}`);
        lines.push(`  maintenance ${plan.maintenance.mode === 'held' ? 'barrier already held' : 'enters the maintenance barrier and leaves it up'}`);
        if (plan.leaves.sqliteFile) lines.push(`  the SQLite file is ${plan.leaves.sqliteFile}`);
    }
    return lines;
}

function refusal(error, cli) {
    if (!(error instanceof ManagerError)) return error;
    const exit = error.status === 409 ? cli.EXIT.REFUSED : (error.status >= 400 && error.status < 500 ? cli.EXIT.INVALID : cli.EXIT.UNEXPECTED);
    const converted = new cli.CliError(error.code, error.message, exit);
    if (error.details) converted.details = error.details;
    if (error.operation) converted.operation = error.operation;
    return converted;
}

async function run(c) {
    try {
        return await runInner({ ...c, fs: c.fs || nodeFs, env: c.baseEnv });
    } catch (error) {
        throw refusal(error, c.cli);
    }
}

async function runInner(c) {
    const { sub, flags, fs, io, env, out, progress, secrets, finish, json, makePrompter, cli } = c;

    if (sub === 'status') {
        const settings = resolveSettings(env, { fs });
        const manager = createManager({ settings, fs, logger: { info() {}, warn() {}, error() {} } });
        const read = manager.store.readInstallation();
        let barrier = null;
        try { barrier = createBarrier({ settings, fs, logger: { info() {}, warn() {}, error() {} } }).view(); } catch { }
        const view = await databaseStatus({ settings, fs, doc: read.status === 'ok' ? read.doc : null, deps: settings.databaseDeps || {}, barrier });
        if (!json) {
            out(`engine      ${view.engine}${view.connection ? ` (${place(view.connection)}, from the ${view.connection.source})` : ''}`);
            out(`record      ${view.record ? `${view.record.engine}${view.mismatch ? ' - DIFFERS from the connection in effect' : ''}` : 'none'}`);
            if (view.sqlite) out(`sqlite      ${view.sqlite.present ? (view.sqlite.empty ? 'empty' : `holds data (${view.sqlite.populated.join(', ')})`) : 'no file yet'}`);
            if (view.pairedRefusesSqlite) out('layout      paired needs Postgres; SQLite cannot be used with it');
        }
        return finish(cli.EXIT.OK, { database: view });
    }

    const prompter = flags.answers ? null : makePrompter();
    let given;
    if (flags.answers) {
        given = cli.answersInput(cli.loadAnswers(flags.answers, fs), 'database', fs, DEFINITION[sub]);
        if (given.connection && given.connection.password === undefined && env[PASSWORD_FILE]) {
            given = { ...given, connection: { ...given.connection, password: readSecretFile(env[PASSWORD_FILE], { fs, cli, name: PASSWORD_FILE }) } };
        }
        if (given.elevated && given.elevated.password === undefined && env[ELEVATED_PASSWORD_FILE]) {
            given = { ...given, elevated: { ...given.elevated, password: readSecretFile(env[ELEVATED_PASSWORD_FILE], { fs, cli, name: ELEVATED_PASSWORD_FILE }) } };
        }
    } else {
        given = { connection: await promptConnection(prompter, { env, fs, cli }) };
        if (sub === 'provision') {
            given.elevated = await promptElevated(prompter, { env, fs, cli });
            given.actions = await promptActions(prompter);
        }
    }
    if (flags.release) {
        if (sub !== 'connect') throw new cli.CliError('USAGE', '--release only applies to database connect.');
        given = { ...given, release: true };
    }
    secrets.push(...input.secretsOf(given));

    const settings = resolveSettings(env, { fs });
    settings.installDeps = io.installDeps || {};
    settings.reconcile = false;
    settings.databaseDeps = io.databaseDeps || {};
    settings.migrationDeps = io.migrationDeps || {};

    if (sub === 'test') {
        const connection = input.parseConnection(given.connection);
        const report = redactDeep(await createProbe(settings)(connection), [connection.password]);
        if (!json) for (const line of describeReport(report)) out(line);
        return finish(report.verdict.ok ? cli.EXIT.OK : cli.EXIT.INVALID, { probe: report });
    }

    const kindName = KIND[sub];
    const keepAlive = setInterval(() => { }, 1000);
    try {
        const manager = createManager({
            settings,
            fs,
            logger: { info() {}, warn() {}, error() {} },
            extraKinds: require('../extensions').kinds,
            ...(io.now ? { now: io.now } : {}),
            hooks: { beforeStep: ({ kind, step }) => progress(`[${kind}] ${step} ...`) }
        });
        if (!manager.storeReady) throw new cli.CliError('STORE_UNUSABLE', 'The manager store cannot be created or written here.', cli.EXIT.REFUSED);
        await manager.engine.recoverInterrupted();
        const planned = await manager.engine.plan(kindName, given, cli.LOCAL_AUTH, { internal: true });
        if (!json) for (const line of describePlan(kindName, planned.plan)) progress(line);
        if (!flags.yes && prompter) {
            if (!yes(await prompter.ask('Proceed? [y/N]: '))) {
                progress('Cancelled; nothing was changed.');
                return finish(cli.EXIT.OK, { cancelled: true });
            }
        }
        const validated = await manager.engine.validate(planned.id, cli.LOCAL_AUTH);
        const applied = await manager.engine.apply(validated.id, { revision: validated.revision }, cli.LOCAL_AUTH);
        const result = applied.result ? scrub(applied.result) : null;
        if (!json) {
            out(`${kindName}: ${applied.operation.status}`);
            if (sub === 'connect' && result) {
                out('The installation now uses that server. The maintenance barrier is still held and the application stays fenced; release it (maintenance.release in the portal, or run this command with --release next time) when you are ready.');
                if (result.workersRestarted === false) out('The manager does not supervise the workers: restart them so they use the new connection.');
            }
        }
        return finish(cli.EXIT.OK, { operation: { id: applied.operation.id, kind: kindName, status: applied.operation.status }, result });
    } finally {
        clearInterval(keepAlive);
    }
}

module.exports = { run, SUBCOMMANDS, DEFINITION, KIND, describeReport, describePlan, readSecretFile, PASSWORD_FILE, ELEVATED_PASSWORD_FILE };
