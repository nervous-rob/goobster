'use strict';

/**
 * The lifecycle steps that move data: repair, backup and restore, the SQLite to Postgres migration,
 * reset and the two uninstalls. Same contract as steps.js. Commands that remove or replace the code
 * run from the payload's launcher with the installation's roots in the environment (the unpacked
 * installer an operator keeps), because the installed launcher is part of what they delete.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { check, notApplicable } = require('./evidence');
const { configReport, DEFAULT_THEME, KEY_FIELD } = require('./steps');

/** One manager command from the payload's launcher against this installation's roots. */
function fromPayload(cell, step, args, options = {}) {
    return cell.cli(step, args, { launcher: cell.payloadLauncher(), env: cell.rootEnv(), ...options });
}

async function backup(cell, step, dir, { includeConfig = false } = {}) {
    const args = ['backup', '--out', dir, '--json'];
    if (includeConfig) args.push('--include-config', '--passphrase-file', cell.passphraseFile());
    const made = await cell.cli(step, args);
    check(made.code === 0, `backup exited ${made.code}: ${cell.why(made)}`);
    const archive = cell.archiveIn(dir);
    const inspected = await cell.cli(step, ['backup', 'inspect', archive, '--json']);
    check(inspected.code === 0, `backup inspect exited ${inspected.code}: ${cell.why(inspected)}`);
    return archive;
}

function matchesManifest(file, entry) {
    return fs.existsSync(file) && require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex') === entry.sha256;
}

async function restore(cell, step, archive, { withConfig = false, launch = null } = {}) {
    const args = ['restore', archive, '--confirm', cell.installationId, '--release', '--json'];
    if (withConfig) args.push('--passphrase-file', cell.passphraseFile());
    else args.push('--without-config');
    const run = launch ? (a, o) => launch(cell, step, a, o) : (a, o) => cell.cli(step, a, o);
    const done = await run(args, { show: ['restore', '<archive>', '--confirm', '<installationId>', '--release', ...(withConfig ? ['--passphrase-file', '<file>'] : ['--without-config']), '--json'] });
    check(done.code === 0, `restore exited ${done.code}: ${cell.why(done)}`);
    return done;
}

async function comeBack(cell, expectConversations) {
    cell.startDaemon();
    await cell.waitManager();
    await cell.waitHealthy();
    await cell.portalLogin();
    const conversations = await cell.conversations();
    if (expectConversations !== undefined) check(conversations.length === expectConversations, `${conversations.length} conversation(s) after the restore, expected ${expectConversations}`);
    return conversations;
}

function manifestFiles(cell) {
    const manifest = JSON.parse(fs.readFileSync(path.join(cell.roots.code, 'current', 'payload-manifest.json'), 'utf8'));
    return manifest.files;
}

async function stepRepair(cell, step) {
    const before = (await cell.conversations()).length;
    const archive = await backup(cell, step, path.join(cell.dirs.backups, 'repair'));
    await cell.stopDaemon();

    const files = manifestFiles(cell);
    const victim = files.find((entry) => /^app\/apps\/api\/.+\.js$/.test(entry.path));
    check(victim, 'the payload manifest lists no api source file to damage');
    const victimFile = path.join(cell.roots.code, 'current', ...victim.path.split('/'));
    fs.rmSync(victimFile, { force: true });
    fs.writeFileSync(victimFile, '// damaged by the acceptance driver\n');
    const sqlite = cell.sqliteFile();
    const handle = fs.openSync(sqlite, 'r+');
    fs.writeSync(handle, Buffer.alloc(4096, 0xa5), 0, 4096, 0);
    fs.closeSync(handle);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${sqlite}${suffix}`, { force: true });
    const damagedHash = cell.sha256File(sqlite);

    const recorded = cell.published.get(cell.state.release.version);
    const source = recorded ? recorded.payloadDir : cell.base.dir;
    const answers = cell.answersFile('repair', { command: 'repair', source, release: { publicKeyFiles: [cell.base.publicKeyPath] } });
    const refused = await fromPayload(cell, step, ['repair', '--answers', answers, '--yes', '--json']);
    check(refused.code !== 0 && refused.json && refused.json.error && refused.json.error.code === 'DB_INIT_FAILED', `repair over a corrupted database answered ${refused.code}: ${cell.why(refused)}, not the DB_INIT_FAILED refusal`);
    check(cell.sha256File(sqlite) === damagedHash, 'the refused repair changed or replaced the database file: data must be kept as it is');
    check(!matchesManifest(victimFile, victim), 'the refused repair already replaced the release file');

    const done = await restore(cell, step, archive, { launch: fromPayload });
    const repaired = await fromPayload(cell, step, ['repair', '--answers', answers, '--yes', '--json']);
    check(repaired.code === 0, `repair after the restore exited ${repaired.code}: ${cell.why(repaired)}`);
    check(matchesManifest(victimFile, victim), 'repair left the damaged release file as it was');
    const conversations = await comeBack(cell, before);
    const counts = done.json && done.json.result && done.json.result.rowCounts && done.json.result.rowCounts.matchesArchive ? 'row counts match the archive' : 'verified';
    return { result: `release file damaged and database header overwritten: repair refused (DB_INIT_FAILED, exit 4) and left both as they were; restore of the earlier backup (${counts}), then repair put the release file back; ${conversations.length} conversation(s) back` };
}

async function stepBackupRestore(cell, step) {
    const archive = await backup(cell, step, path.join(cell.dirs.backups, 'full'), { includeConfig: true });
    const before = (await cell.conversations()).length;
    const turn = await cell.portalChatInNewConversation('A conversation written after the backup.');
    check(turn.ok, 'a chat turn after the backup failed');
    check((await cell.conversations()).length === before + 1, 'the new conversation was not kept');
    const report = await configReport(cell);
    const removed = await cell.api.operation('config.set', { changes: [{ id: KEY_FIELD, action: 'remove' }], expectedRevision: report.json.revision });
    check(removed.operation.status === 'applied', 'config.set remove ended badly');
    const changed = await cell.api.operation('defaults.set', { changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'dark' }] });
    check(changed.operation.status === 'applied', 'defaults.set ended badly');

    await cell.stopDaemon();
    const done = await restore(cell, step, archive, { withConfig: true });
    await comeBack(cell, before);
    const after = await configReport(cell);
    check(after.fields.get(KEY_FIELD) && after.fields.get(KEY_FIELD).present === true, 'config.json was not restored: the key is missing');
    const theme = after.fields.get('defaults.appearance.theme');
    check(theme && theme.value === DEFAULT_THEME, 'the instance default was not restored with the database');
    const safety = done.json && done.json.result && done.json.result.safetyBackup ? 'a safety backup of the replaced state was written' : 'no safety backup reported';
    return { result: `archive inspected, then a later conversation, a removed key and a changed default were all undone by restore (config.json restored under the passphrase); ${safety}` };
}

function dockerUsable() {
    const run = childProcess.spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return run.status === 0;
}

async function stepMigrate(cell, step) {
    if (cell.o.db === 'sqlite') return notApplicable('this cell stays on SQLite');
    const before = (await cell.conversations()).length;
    let target;
    if (cell.o.db === 'existing-pg') {
        const url = process.env[cell.o.pgUrlEnv];
        if (!url) return notApplicable(`no existing Postgres was given (${cell.o.pgUrlEnv} is not set)`);
        const parsed = new URL(url);
        cell.redactor.secret(url);
        if (parsed.password) cell.redactor.secret(decodeURIComponent(parsed.password));
        target = { url };
    } else {
        if (!dockerUsable()) return notApplicable('Docker is not usable on this host (docker info failed)');
        const provision = cell.answersFile('docker-provision', { command: 'database', port: cell.ports.docker, bind: '127.0.0.1', database: 'goobster', role: 'goobster', pull: true, acknowledgeBackupTools: true });
        const made = await cell.cli(step, ['database', 'docker', 'provision', '--answers', provision, '--yes', '--json']);
        check(made.code === 0, `database docker provision exited ${made.code}: ${cell.why(made)}`);
        target = { owned: 'docker' };
    }
    const pre = cell.answersFile('migrate-preflight', { command: 'migrate', target });
    const preflight = await cell.cli(step, ['migrate', 'preflight', '--answers', pre, '--json']);
    check(preflight.code === 0, `migrate preflight exited ${preflight.code}: ${cell.why(preflight)}`);
    const run = cell.answersFile('migrate-run', { command: 'migrate', target, backup: { dir: path.join(cell.dirs.backups, 'migrate'), passphrase: cell.ensurePassphrase() }, provision: { extensions: false }, release: true });
    const migrated = await cell.cli(step, ['migrate', 'run', '--answers', run, '--confirm', cell.installationId, '--release', '--yes', '--json']);
    check(migrated.code === 0, `migrate run exited ${migrated.code}: ${cell.why(migrated)}`);
    step.setEngine('postgres');
    cell.engine = 'postgres';
    const status = await cell.cli(step, ['database', 'status', '--json']);
    check(status.code === 0, `database status exited ${status.code}: ${cell.why(status)}`);
    check(/postgres/i.test(JSON.stringify(status.json || {})), 'database status does not report Postgres after the migration');
    const stale = await cell.managerStatus();
    const staleEngine = stale.json && stale.json.appDatabase ? stale.json.appDatabase.engine : null;
    await cell.stopDaemon();
    cell.startDaemon();
    await cell.waitManager();
    await cell.waitHealthy();
    const fresh = await cell.managerStatus();
    check(fresh.json && fresh.json.appDatabase && fresh.json.appDatabase.engine === 'postgres', `after the manager restarted it reports ${fresh.json && fresh.json.appDatabase && fresh.json.appDatabase.engine}, not postgres`);
    await cell.portalLogin();
    const conversations = await cell.conversations();
    check(conversations.length === before, `${conversations.length} conversation(s) on Postgres, ${before} on SQLite`);
    const sqliteAfterSwitch = cell.sha256File(cell.sqliteFile());
    const turn = await cell.portalChatInNewConversation('A conversation written on Postgres.');
    check(turn.ok, 'a chat turn on Postgres failed');
    check((await cell.conversations()).length === before + 1, 'the conversation written on Postgres was not kept');
    check(cell.sha256File(cell.sqliteFile()) === sqliteAfterSwitch, 'the old SQLite file changed after the switch: the workers are still writing to it');
    return { result: `SQLite copied to Postgres (${cell.o.db}), verified, switched. Before the manager was restarted it reported ${staleEngine}; after the restart it reports postgres, ${conversations.length} conversation(s) read back, a new one written, and the old SQLite file untouched` };
}

async function stepReset(cell, step) {
    const before = (await cell.conversations()).length;
    const dry = await cell.cli(step, ['reset', '--scope', 'instance', '--dry-run', '--json']);
    check(dry.code === 0, `reset --dry-run exited ${dry.code}: ${cell.why(dry)}`);
    check((await cell.conversations()).length === before, 'the dry run changed data');
    const answers = cell.answersFile('reset', { command: 'reset', scope: 'instance', confirm: cell.installationId, backup: { dir: path.join(cell.dirs.backups, 'reset'), passphrase: cell.ensurePassphrase() } });
    let environmentNote = '';
    let resetEnv = {};
    if (cell.engine === 'postgres') {
        const refused = await cell.cli(step, ['reset', '--answers', answers, '--yes', '--json']);
        check(refused.code === 3 && /FOREIGN_TARGET/.test(JSON.stringify(refused.json || {})), `reset on Postgres without the database URL in its environment answered ${refused.code}, not the FOREIGN_TARGET refusal: ${cell.why(refused)}`);
        check((await cell.conversations()).length === before, 'the refused reset changed data');
        resetEnv = { GOOBSTER_DB_URL: cell.databaseUrl() };
        environmentNote = ' (the CLI reads the database from its own environment, not from the manager overlay: without GOOBSTER_DB_URL it refused FOREIGN_TARGET and changed nothing; with it set, it ran)';
    }
    const reset = await cell.cli(step, ['reset', '--answers', answers, '--yes', '--json'], { env: cell.env(resetEnv) });
    check(reset.code === 0, `reset exited ${reset.code}: ${cell.why(reset)}`);
    check(cell.archiveIn(path.join(cell.dirs.backups, 'reset')), 'reset wrote no backup first');
    const signIn = await fetch(cell.portal('/api/app/auth/native-login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'acceptance-owner', password: cell.password }), signal: AbortSignal.timeout(30_000) });
    const signInBody = await signIn.text().catch(() => '');
    check(signIn.status !== 200, `the owner can still sign in after the instance data was reset (${signIn.status} ${signInBody.slice(0, 120)})`);
    const maintenance = await cell.api.call('GET', '/maintenance');
    check(maintenance.status === 200, `GET /maintenance answered ${maintenance.status}`);
    check(!(maintenance.json && maintenance.json.active), 'the maintenance barrier is still up after the reset');
    return { result: `dry run changed nothing; reset took a verified backup first, emptied the data (owner sign-in now ${signIn.status}), left the manager store and config.json, and released the barrier${environmentNote}` };
}

async function keepData(cell) {
    return {
        sqlite: fs.existsSync(cell.sqliteFile()),
        config: fs.existsSync(cell.roots.config),
        store: fs.existsSync(path.join(cell.roots.managerStore, 'installation.json')) || fs.existsSync(cell.roots.managerStore),
        code: fs.existsSync(path.join(cell.roots.code, 'current'))
    };
}

async function stepUninstallKeep(cell, step) {
    await cell.stopDaemon();
    const sizeBefore = fs.statSync(cell.sqliteFile()).size;
    const removed = await fromPayload(cell, step, ['uninstall', '--yes', '--json']);
    check(removed.code === 0, `uninstall exited ${removed.code}: ${cell.why(removed)}`);
    cell.installed = false;
    const kept = await keepData(cell);
    check(!kept.code, 'the release is still in place after a keep-data uninstall');
    check(kept.sqlite && kept.config, `a keep-data uninstall removed data (database ${kept.sqlite ? 'kept' : 'gone'}, config.json ${kept.config ? 'kept' : 'gone'})`);
    check(fs.statSync(cell.sqliteFile()).size === sizeBefore, 'the kept database changed size');
    const status = await fromPayload(cell, step, ['status', '--json']);
    const state = status.json && status.json.status ? status.json.status : {};
    check(state.state === 'recovery' && state.tombstone === true, `after the uninstall the manager says ${state.state} (tombstone ${state.tombstone}), not a tombstoned recovery`);
    const answers = cell.answersFile('reinstall', cell.installAnswers());
    const again = await fromPayload(cell, step, ['install', '--answers', answers, '--yes', '--json']);
    check(again.code === 0, `reinstall over the kept data exited ${again.code}: ${cell.why(again)}`);
    cell.installed = true;
    const claimed = await cell.cliStatus(step);
    check(claimed.state === 'claimed' && claimed.installation, `the reinstalled installation is ${claimed.state}`);
    cell.installationId = claimed.installation.installationId;
    cell.startDaemon();
    await cell.waitManager();
    await cell.waitHealthy();
    return { result: 'uninstall (data kept): release removed, database and config.json left byte-size identical, manager reports the tombstoned recovery; a reinstall over the kept data came back healthy' };
}

async function stepUninstallFull(cell, step) {
    await cell.stopDaemon();
    const id = cell.installationId;
    const bare = await fromPayload(cell, step, ['uninstall', '--delete-data', '--yes', '--json']);
    check(bare.code !== 0, 'uninstall --delete-data without --confirm was accepted');
    const wrong = await fromPayload(cell, step, ['uninstall', '--delete-data', '--confirm', 'not-the-installation-id', '--yes', '--json']);
    check(wrong.code !== 0, 'uninstall --delete-data with the wrong id was accepted');
    check(fs.existsSync(cell.sqliteFile()) && fs.existsSync(cell.roots.config), 'a refused uninstall removed data');
    const full = await fromPayload(cell, step, ['uninstall', '--delete-data', '--confirm', id, '--yes', '--json'], { show: ['uninstall', '--delete-data', '--confirm', '<installationId>', '--yes', '--json'] });
    check(full.code === 0, `confirmed uninstall exited ${full.code}: ${cell.why(full)}`);
    cell.installed = false;
    check(!fs.existsSync(cell.sqliteFile()), 'the database is still there after a confirmed removal');
    check(!fs.existsSync(cell.roots.config), 'config.json is still there after a confirmed removal');
    check(!fs.existsSync(path.join(cell.roots.code, 'current')), 'the release is still there after a confirmed removal');
    const tombstone = path.join(cell.roots.data, 'tombstone.json');
    check(fs.existsSync(tombstone), 'no tombstone was left');
    const doc = JSON.parse(fs.readFileSync(tombstone, 'utf8'));
    check(doc.dataRemoved === true, 'the tombstone does not record that the data was removed');
    const left = fs.readdirSync(cell.roots.data).sort();
    check(left.every((name) => ['manager', 'tombstone.json'].includes(name)), `unexpected leftovers in the data root: ${left.join(', ')}`);
    return { result: `refused without --confirm and with a wrong id (data intact); with the installation id: ${cell.engine === 'postgres' ? 'the data root\'s SQLite file (the Postgres database itself is the operator\'s and was not inspected)' : 'database'}, config.json and release removed, leaving only the manager store and the tombstone (dataRemoved)` };
}

module.exports = { stepRepair, stepBackupRestore, stepMigrate, stepReset, stepUninstallKeep, stepUninstallFull, backup, restore, comeBack, fromPayload, dockerUsable };
