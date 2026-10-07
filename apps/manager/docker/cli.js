/**
 * `goobster-manager database docker status|provision|start|stop|repair|reconfigure`
 * (documentation/docker_postgres.md). apps/manager/database/cli.js delegates here for
 * the `docker` subcommand; this is the one `database` subcommand with a second word,
 * so the Docker database stays a part of `database` and no new top-level command exists.
 *
 *   status       the daemon check and what this manager owns (a plain function call, read only)
 *   provision    database.docker.provision: create the container, role and schema
 *   start|stop   database.docker.start / .stop
 *   repair       database.docker.repair: recreate a missing container over the same storage
 *   reconfigure  database.docker.reconfigure: port, bind address or memory limit (backup first)
 *
 * No password is ever asked or printed: both are generated. The only secret an answers
 * file can carry is `backup.passphrase` (reconfigure), registered for redaction first.
 */

const { resolveSettings } = require('../settings');
const { createManager } = require('../manager');
const { scrub } = require('../engine/redact');
const { createDockerService } = require('./service');

const SUBCOMMANDS = Object.freeze(['status', 'provision', 'start', 'stop', 'repair', 'reconfigure']);
const KIND = Object.freeze({
    provision: 'database.docker.provision',
    start: 'database.docker.start',
    stop: 'database.docker.stop',
    repair: 'database.docker.repair',
    reconfigure: 'database.docker.reconfigure'
});
const DEFINITION = Object.freeze({
    status: 'database-docker-status',
    provision: 'database-docker-provision',
    start: 'database-docker-start',
    stop: 'database-docker-stop',
    repair: 'database-docker-repair',
    reconfigure: 'database-docker-reconfigure'
});

const yes = (answer) => /^(y|yes)$/i.test(String(answer).trim());
const quiet = { info() {}, warn() {}, error() {} };

function describeStatus(view) {
    const d = view.daemon;
    const lines = ['database docker status (read only: nothing was pulled, created or started)'];
    lines.push(`  docker cli   ${d.cli.present ? `present${d.cli.version ? ` (${d.cli.version})` : ''}` : 'not found'}`);
    lines.push(`  daemon       ${d.daemon.reachable ? `reachable, ${d.daemon.flavor === 'desktop' ? 'Docker Desktop' : 'Docker Engine'} ${d.daemon.serverVersion || ''}${d.daemon.rootless ? ' (rootless)' : ''}` : `not usable (${d.daemon.code || 'unknown'})`}`);
    if (d.daemon.socket) lines.push(`  socket       ${d.daemon.socket.path}: ${d.daemon.socket.exists ? (d.daemon.socket.usable ? 'usable by this user' : 'exists, this user may not use it') : 'missing'}`);
    lines.push(`  platform     ${d.platform.platform || `${d.platform.os}/${d.platform.arch}`}${d.platform.supported ? '' : ' (not supported)'}`);
    lines.push(`  image        ${d.image.humanReference} (PostgreSQL ${d.image.postgresMajor}), ${d.image.pulled === null ? 'unknown' : (d.image.pulled ? 'already pulled' : `not pulled (about ${Math.round((d.image.pullBytes || 0) / 1e6)} MB)`)}`);
    lines.push(`  pinned       ${d.image.digest}`);
    if (d.backupTools) lines.push(`  backup tools ${d.backupTools.ok ? 'compatible' : d.backupTools.code}${d.backupTools.version ? ` (${d.backupTools.version})` : ''}`);
    for (const item of d.verdict.blocks) lines.push(`    block ${item.code}: ${item.detail}\n          ${item.remedy}`);
    for (const item of d.verdict.warnings) lines.push(`    warn  ${item.code}: ${item.detail}\n          ${item.remedy}`);
    for (const item of d.verdict.notes) lines.push(`    note  ${item.code}: ${item.detail}`);
    lines.push(`  verdict      ${d.verdict.ok ? 'USABLE' : `BLOCKED (${d.verdict.blocks.length})`}`);
    if (view.record) {
        lines.push(`  instance     ${view.names.container}: step ${view.record.step}${view.record.complete ? ' (complete)' : ' (interrupted: provision again to resume)'}`);
        lines.push(`  storage      ${view.record.request.storage.kind === 'path' ? view.record.request.storage.path : view.names.volume}; port ${view.record.request.port} on ${view.record.request.bind}`);
        if (view.owned && view.owned.container) lines.push(`  container    ${view.owned.container.exists ? `${view.owned.container.status}, health ${view.owned.container.health}` : 'missing (repair recreates it over the same storage)'}`);
        lines.push(`  connected    ${view.connected ? 'this installation uses it' : 'no'}`);
    } else {
        lines.push('  instance     none owned by this manager');
    }
    return lines;
}

function describePlan(kind, plan) {
    const lines = [kind];
    if (plan.names) lines.push(`  names      container ${plan.names.container}, volume ${plan.names.volume}, network ${plan.names.network}`);
    if (kind === 'database.docker.provision') {
        lines.push(`  image      ${plan.image.reference}${plan.image.pulled ? ' (already pulled)' : (plan.image.willPull ? ' (will be pulled)' : ' (not pulled)')}`);
        lines.push(`  listens    ${plan.request.bind}:${plan.request.port}${plan.request.lan ? ' (reachable from other machines)' : ' (this machine only)'}`);
        lines.push(`  storage    ${plan.storage.kind === 'path' ? plan.storage.path : 'a Docker volume'}`);
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
    const storage = await prompter.ask('Storage: "volume" or an absolute directory [volume]: ', { fallback: 'volume' });
    if (storage !== 'volume') input.storage = { kind: 'path', path: storage };
    input.pull = yes(await prompter.ask('Pull the database image if it is not on this machine? [y/N]: '));
    return input;
}

/**
 * @param {Object} c the context database/cli.js received, plus `flags.dockerSub`
 */
async function run(c) {
    const { flags, fs, io, env, out, progress, secrets, finish, json, makePrompter, cli } = c;
    const sub = flags.dockerSub;
    if (!SUBCOMMANDS.includes(sub)) throw new cli.CliError('USAGE', 'database docker needs a command: status, provision, start, stop, repair or reconfigure.');

    const settings = resolveSettings(env, { fs });
    settings.installDeps = io.installDeps || {};
    settings.reconcile = false;
    settings.databaseDeps = io.databaseDeps || {};
    settings.migrationDeps = io.migrationDeps || {};
    settings.dockerDeps = io.dockerDeps || {};

    if (sub === 'status') {
        const manager = createManager({ settings, fs, logger: quiet });
        const read = manager.store.readInstallation();
        const view = await createDockerService({ settings, fs, logger: quiet }).status({ installationId: read.status === 'ok' ? read.doc.installationId : null });
        if (!json) for (const line of describeStatus(view)) out(line);
        return finish(view.daemon.verdict.ok ? cli.EXIT.OK : cli.EXIT.INVALID, { docker: view });
    }

    const prompter = flags.answers ? null : makePrompter();
    let given = {};
    if (flags.answers) given = cli.answersInput(cli.loadAnswers(flags.answers, fs), 'database', fs, DEFINITION[sub]);
    else if (sub === 'provision') given = await promptProvision(prompter);
    else if (sub === 'reconfigure') throw new cli.CliError('USAGE', 'database docker reconfigure needs --answers: the maintenance barrier and the backup destination go in the file.');
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
            if (sub === 'provision') out('The database is ready but the installation does not use it yet: run "goobster-manager database connect" with { "connection": { "owned": "docker" } } in the answers file (a SQLite installation with data is "migrate").');
        }
        return finish(cli.EXIT.OK, { operation: { id: applied.operation.id, kind: kindName, status: applied.operation.status }, result });
    } finally {
        clearInterval(keepAlive);
    }
}

module.exports = { run, SUBCOMMANDS, KIND, DEFINITION, describeStatus, describePlan };
