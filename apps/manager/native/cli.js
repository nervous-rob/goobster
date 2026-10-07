/**
 * `goobster-manager database native status|provision|start|stop|repair|relocate`
 * (documentation/native_postgres.md). apps/manager/database/cli.js delegates here
 * for the `native` subcommand, the sibling of `database docker`, so the native
 * database stays a part of `database` and no new top-level command exists.
 *
 *   status      the host check and what this manager owns (a plain function call, read only)
 *   provision   database.native.provision: install the packages when approved, create the
 *               cluster, role and schema, verify it
 *   start|stop  database.native.start / .stop
 *   repair      database.native.repair: converge the cluster's configuration over the same data
 *   relocate    database.native.relocate: move the data directory (verified backup first)
 *
 * No password is ever asked or printed: it is generated. The only secret an answers
 * file can carry is `backup.passphrase` (relocate), registered for redaction first.
 */

const { resolveSettings } = require('../settings');
const { createManager } = require('../manager');
const { scrub } = require('../engine/redact');
const { createNativeService } = require('./service');

const SUBCOMMANDS = Object.freeze(['status', 'provision', 'start', 'stop', 'repair', 'relocate']);
const KIND = Object.freeze({
    provision: 'database.native.provision',
    start: 'database.native.start',
    stop: 'database.native.stop',
    repair: 'database.native.repair',
    relocate: 'database.native.relocate'
});
const DEFINITION = Object.freeze({
    status: 'database-native-status',
    provision: 'database-native-provision',
    start: 'database-native-start',
    stop: 'database-native-stop',
    repair: 'database-native-repair',
    relocate: 'database-native-relocate'
});

const yes = (answer) => /^(y|yes)$/i.test(String(answer).trim());
const quiet = { info() {}, warn() {}, error() {} };
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

function describeStatus(view) {
    const h = view.host;
    const lines = ['database native status (read only: nothing was installed, created or started)'];
    lines.push(`  host         ${h.distro ? (h.distro.label || h.distro.id || 'unknown') : 'unknown'}${h.supported ? '' : ` (not supported: ${h.reason})`}`);
    if (!h.supported) {
        lines.push(`               ${h.remedy || ''}`);
        lines.push('  verdict      NOT AVAILABLE on this host');
        return lines;
    }
    lines.push(`  packages     ${h.packageManager}: server ${h.packages.server.installed ? `installed (${h.packages.server.version || 'unknown'})` : h.packages.server.availability}, client ${h.packages.client.installed ? 'installed' : h.packages.client.availability}, pgvector ${h.packages.pgvector.installed ? 'installed' : h.packages.pgvector.availability}`);
    lines.push(`  systemd      ${h.systemd.available ? `available (${h.systemd.state})` : `not running (${h.systemd.state || 'unknown'})`}`);
    if (h.selinux && h.selinux.present) lines.push(`  selinux      ${h.selinux.mode || 'present'}`);
    lines.push(`  clusters     ${h.clusters.length === 0 ? 'none' : h.clusters.map(item => `${item.name}${item.owned ? ' (ours)' : ''} on ${item.port === null ? '?' : item.port}, ${item.online ? 'online' : 'down'}`).join('; ')}`);
    if (h.backupTools) lines.push(`  backup tools ${h.backupTools.ok ? 'compatible' : h.backupTools.code}${h.backupTools.version ? ` (${h.backupTools.version})` : ''}`);
    if (h.storage) {
        lines.push(`  storage      ${h.storage.path}: ${h.storage.freeBytes === null ? 'free space unknown' : `${mb(h.storage.freeBytes)} free`}${h.storage.reachableByPostgres === false ? ', not reachable by the postgres account' : ''}`);
        for (const issue of h.storage.mountIssues) lines.push(`    ${issue.severity === 'block' ? 'block' : 'note '} ${issue.code}`);
    }
    lines.push(`  elevation    ${view.elevation.available ? `available (${view.elevation.kind})` : `not available (${view.elevation.reason})`}`);
    if (view.record) {
        lines.push(`  instance     ${view.names.cluster}: step ${view.record.step}${view.record.complete ? ' (complete)' : ' (interrupted: provision again to resume)'}`);
        lines.push(`  location     ${view.record.cluster.dataDirectory}; port ${view.record.cluster.port} on ${view.record.cluster.bind}`);
        if (view.owned) lines.push(`  cluster      ${view.owned.exists ? (view.owned.online ? 'online' : 'stopped') : 'missing'}`);
        if (view.record.relocation) lines.push(`  relocation   ${view.record.relocation.step}: ${view.record.relocation.from} -> ${view.record.relocation.to}`);
        lines.push(`  connected    ${view.connected ? 'this installation uses it' : 'no'}`);
    } else {
        lines.push('  instance     none owned by this manager');
    }
    return lines;
}

function describePlan(kind, plan) {
    const lines = [kind];
    if (kind === 'database.native.provision') {
        lines.push(`  cluster    ${plan.names.cluster}${plan.cluster && plan.cluster.reason === 'name-taken' ? ' (the name "goobster" is taken by another cluster)' : ''}`);
        lines.push(`  listens    ${plan.request.bind}:${plan.port.chosen}${plan.request.lan ? ' (reachable from other machines)' : ' (this machine only)'}`);
        lines.push(`  data       ${plan.storage.path}`);
        lines.push(`  packages   ${plan.packages.install.length === 0 ? 'already installed' : `${plan.packages.install.join(', ')}${plan.packages.repository ? ` (from the ${plan.packages.repository} repository)` : ''}`}`);
        lines.push(`  mode       ${plan.mode}`);
        for (const item of plan.findings.filter(entry => entry.severity !== 'note')) lines.push(`  ${item.severity === 'block' ? 'BLOCK' : 'warn '} ${item.code}: ${item.detail}${item.remedy ? ` ${item.remedy}` : ''}`);
    } else if (plan.effect) {
        lines.push(`  effect     ${plan.effect}${plan.action ? ` (${plan.action})` : ''}`);
        for (const item of plan.blocks || []) lines.push(`  BLOCK ${item.code}: ${item.detail}${item.remedy ? ` ${item.remedy}` : ''}`);
    }
    return lines;
}

async function promptProvision(prompter) {
    const input = {};
    const port = await prompter.ask('Port [5432]: ', { fallback: '5432' });
    input.port = Number(port);
    const bind = await prompter.ask('Bind address [127.0.0.1]: ', { fallback: '127.0.0.1' });
    if (bind !== '127.0.0.1') {
        input.bind = bind;
        input.acknowledgeLanBind = yes(await prompter.ask(`Binding ${bind} may expose the database to other machines. Accept? [y/N]: `));
    }
    const directory = await prompter.ask('Data directory [the distribution\'s default for this cluster]: ', { fallback: '' });
    if (directory) input.dataDirectory = directory;
    input.installPackages = yes(await prompter.ask('Install the PostgreSQL packages if they are missing? [y/N]: '));
    return input;
}

/**
 * @param {Object} c the context database/cli.js received, plus `flags.nativeSub`
 */
async function run(c) {
    const { flags, fs, io, env, out, progress, secrets, finish, json, makePrompter, cli } = c;
    const sub = flags.nativeSub;
    if (!SUBCOMMANDS.includes(sub)) throw new cli.CliError('USAGE', 'database native needs a command: status, provision, start, stop, repair or relocate.');

    const settings = resolveSettings(env, { fs });
    settings.installDeps = io.installDeps || {};
    settings.reconcile = false;
    settings.databaseDeps = io.databaseDeps || {};
    settings.migrationDeps = io.migrationDeps || {};
    settings.nativeDeps = io.nativeDeps || {};

    if (sub === 'status') {
        const manager = createManager({ settings, fs, logger: quiet });
        const read = manager.store.readInstallation();
        const view = await createNativeService({ settings, fs, logger: quiet }).status({ installationId: read.status === 'ok' ? read.doc.installationId : null });
        if (!json) for (const line of describeStatus(view)) out(line);
        return finish(view.host.supported ? cli.EXIT.OK : cli.EXIT.INVALID, { native: view });
    }

    const prompter = flags.answers ? null : makePrompter();
    let given = {};
    if (flags.answers) given = cli.answersInput(cli.loadAnswers(flags.answers, fs), 'database', fs, DEFINITION[sub]);
    else if (sub === 'provision') given = await promptProvision(prompter);
    else if (sub === 'relocate') throw new cli.CliError('USAGE', 'database native relocate needs --answers: the target directory, the maintenance barrier and the backup destination go in the file.');
    if (given.backup && given.backup.passphrase) secrets.push(given.backup.passphrase);

    const kindName = KIND[sub];
    const keepAlive = setInterval(() => { }, 1000);
    try {
        const manager = createManager({
            settings,
            fs,
            logger: quiet,
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
            if (sub === 'provision') out('The database is ready but the installation does not use it yet: run "goobster-manager database connect" with { "connection": { "owned": "native" } } in the answers file (a SQLite installation with data is "migrate").');
        }
        return finish(cli.EXIT.OK, { operation: { id: applied.operation.id, kind: kindName, status: applied.operation.status }, result });
    } finally {
        clearInterval(keepAlive);
    }
}

module.exports = { run, SUBCOMMANDS, KIND, DEFINITION, describeStatus, describePlan };
