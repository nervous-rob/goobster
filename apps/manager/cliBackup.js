/**
 * `goobster-manager backup`, `backup inspect` and `restore`
 * (documentation/backup_and_restore.md).
 *
 *   backup --out <dir> [--include-config] [--passphrase-file <file>] [--answers <file>] [--json]
 *   backup inspect <dir> [--json]
 *   restore <dir> --confirm <installationId> [--without-config] [--passphrase-file <file>]
 *           [--accept-schema-change] [--release] [--answers <file>] [--json]
 *
 * Both run the `backup.create` and `backup.restore` kinds in this process
 * with `via: 'local'`. `backup` is read-only (it works while the instance
 * runs). `restore` enters the maintenance barrier itself, replaces the
 * database, the file sets and (with the passphrase) config.json, and leaves
 * the instance paused; with `--release` it also lifts the barrier.
 *
 * The passphrase for config.json comes from `--passphrase-file` (a regular
 * file only its owner can read; the first line), the file named by
 * GOOBSTER_BACKUP_PASSPHRASE_FILE, the answers file, or a hidden prompt -
 * never from the command line (a secret there is refused as SECRET_ON_ARGV
 * before anything is read). Only config.json is encrypted; the archive is not.
 */

const { ManagerError } = require('./errors');
const { resolveSettings } = require('./settings');
const { createManager } = require('./manager');
const { inspectArchive } = require('./backup/view');

const quiet = { info() {}, warn() {}, error() {} };

const SUBCOMMANDS = Object.freeze(['inspect']);

/** Flags and positionals of `backup` and `restore`, validated; sets `flags.sub` and `flags.dir`. */
function checkArgs(command, flags, positional, CliError) {
    if (command === 'backup') {
        if (positional[0] === 'inspect') {
            flags.sub = positional.shift();
            if (!positional.length) throw new CliError('USAGE', 'backup inspect needs the archive directory.');
            flags.dir = positional.shift();
            for (const [name, value] of [['--out', flags.out], ['--include-config', flags.includeConfig], ['--passphrase-file', flags.passphraseFile], ['--answers', flags.answers], ['--confirm', flags.confirm]]) {
                if (value) throw new CliError('USAGE', `${name} does not apply to backup inspect.`);
            }
        } else if (!flags.out) {
            throw new CliError('USAGE', 'backup needs --out <directory> (where the archive is written), or "backup inspect <directory>".');
        }
        if (flags.withoutConfig || flags.acceptSchemaChange || flags.confirm) throw new CliError('USAGE', '--without-config, --accept-schema-change and --confirm belong to restore.');
        if (flags.release) throw new CliError('USAGE', '--release belongs to restore and migrate.');
        if (flags.includeConfig && flags.sub === 'inspect') throw new CliError('USAGE', '--include-config does not apply to backup inspect.');
        return;
    }
    if (!positional.length) throw new CliError('USAGE', 'restore needs the archive directory: restore <directory> --confirm <installationId>.');
    flags.dir = positional.shift();
    if (flags.out || flags.includeConfig) throw new CliError('USAGE', '--out and --include-config belong to backup.');
    if (flags.withoutConfig && flags.passphraseFile) throw new CliError('USAGE', '--without-config and --passphrase-file contradict each other.');
}

/** The passphrase file: a regular file, not a link, readable by its owner only. First line. */
function readPassphraseFile(file, fs, { CliError, EXIT }) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch {
        throw new CliError('PASSPHRASE_FILE_UNREADABLE', 'The passphrase file does not exist or cannot be read.', EXIT.INVALID);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CliError('PASSPHRASE_FILE_UNREADABLE', 'The passphrase path must be a regular file, not a link or directory.', EXIT.INVALID);
    if (process.platform !== 'win32') {
        if ((stat.mode & 0o077) !== 0) {
            throw new CliError('PASSPHRASE_FILE_PERMISSIONS', `The passphrase file must be readable by its owner only (chmod 600); it is mode ${(stat.mode & 0o777).toString(8)}.`, EXIT.INVALID);
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new CliError('PASSPHRASE_FILE_PERMISSIONS', 'The passphrase file belongs to another user.', EXIT.INVALID);
        }
    }
    if (stat.size > 4096) throw new CliError('PASSPHRASE_FILE_UNREADABLE', 'The passphrase file is too large.', EXIT.INVALID);
    const first = String(fs.readFileSync(file, 'utf8')).split(/\r?\n/)[0];
    if (!first) throw new CliError('PASSPHRASE_FILE_UNREADABLE', 'The passphrase file is empty.', EXIT.INVALID);
    return first;
}

/**
 * @returns {Promise<string|null>} the passphrase, or null when the person at the prompt gave none
 */
async function obtainPassphrase(c, { fromAnswers, question, confirmTwice }) {
    const { flags, fs, baseEnv } = c;
    const file = flags.passphraseFile || baseEnv.GOOBSTER_BACKUP_PASSPHRASE_FILE || null;
    let value = null;
    if (file) value = readPassphraseFile(file, fs, c.cli);
    else if (fromAnswers) value = fromAnswers;
    else if (c.stdinIsInteractive || c.io.stdin) {
        if (!c.prompter) {
            c.prompter = c.cli.createPrompter({ input: c.stdin, output: c.stderr });
            c.setPrompter(c.prompter);
        }
        value = (await c.prompter.ask(question, { hidden: true })) || null;
        if (value && confirmTwice) {
            const again = await c.prompter.ask('Repeat the passphrase: ', { hidden: true });
            if (again !== value) throw new c.cli.CliError('PASSPHRASE_MISMATCH', 'The two passphrases did not match; nothing was written.', c.cli.EXIT.INVALID);
        }
    }
    if (value) c.secrets.push(value);
    return value;
}

function newManager(c, settings) {
    const manager = createManager({
        settings,
        fs: c.fs,
        logger: quiet,
        extraKinds: require('./extensions').kinds,
        ...(c.io.now ? { now: c.io.now } : {}),
        hooks: { beforeStep: ({ kind, step }) => c.progress(`[${kind}] ${step} ...`) }
    });
    if (!manager.storeReady) throw new c.cli.CliError('STORE_UNUSABLE', 'The manager store cannot be created or written here.', c.cli.EXIT.REFUSED);
    return manager;
}

function describeArchive(view) {
    const lines = [`archive ${view.dir}`];
    lines.push(`  made      ${view.createdAt} (${view.engine}, format ${view.version})${view.quiesced === true ? ', taken with the instance quiesced' : view.quiesced === false ? ', taken while the instance was running' : ''}`);
    lines.push(`  database  ${view.tables} tables, ${view.rows} rows`);
    lines.push(`  files     ${view.fileSets.length ? view.fileSets.map(set => `${set.id} (${set.files})`).join(', ') : 'none'}`);
    lines.push(`  config    ${view.configIncluded ? (view.configEncrypted ? 'config.json, encrypted with the passphrase from backup time' : 'config.json') : 'not in the archive'}`);
    lines.push('  note      only config.json is encrypted; the database and the files are not');
    lines.push(`  integrity ${view.integrity.ok ? 'complete' : `INCOMPLETE (${view.integrity.problems.join(', ')})`}`);
    lines.push(`  engine    ${view.engineMatches ? `matches this installation (${view.target.engine})` : `DOES NOT MATCH this installation (${view.target.engine}); a restore refuses`}`);
    lines.push(`  schema    ${view.fingerprintMatches ? 'same as this code' : 'differs from this code (restoring needs --accept-schema-change)'}`);
    lines.push(`  verdict   ${view.restorable ? 'can be restored here' : `cannot be restored here: ${view.blocks.join(', ')}`}`);
    for (const warning of view.warnings) lines.push(`  warning   ${warning}`);
    return lines;
}

async function inspectCommand(c, settings) {
    const { EXIT } = c.cli;
    const view = inspectArchive({ settings, dir: c.flags.dir, fs: c.fs });
    if (!c.json) for (const line of describeArchive(view)) c.out(line);
    return c.finish(view.restorable ? EXIT.OK : EXIT.REFUSED, { archive: view });
}

async function backupCommand(c, settings) {
    const { flags, fs } = c;
    const { CliError, EXIT } = c.cli;
    const answers = flags.answers ? c.cli.answersInput(c.cli.loadAnswers(flags.answers, fs), 'backup', fs, 'backup') : {};
    if (answers.passphrase) c.secrets.push(answers.passphrase);
    const dir = flags.out || answers.dir;
    if (!dir) throw new CliError('USAGE', 'backup needs --out <directory>.');
    const includeConfig = flags.includeConfig || answers.includeConfig === true;
    const input = { dir, includeConfig };
    if (includeConfig && fs.existsSync(settings.configPath)) {
        const passphrase = await obtainPassphrase(c, { fromAnswers: answers.passphrase, question: 'Passphrase to encrypt config.json in the archive (hidden): ', confirmTwice: true });
        if (!passphrase) {
            throw new CliError('PASSPHRASE_REQUIRED', 'config.json goes into the archive only under a passphrase: use --passphrase-file, set GOOBSTER_BACKUP_PASSPHRASE_FILE, or answer the prompt. Without --include-config the archive has no config.json.', EXIT.INVALID);
        }
        input.passphrase = passphrase;
    }

    const manager = newManager(c, settings);
    await manager.engine.recoverInterrupted();
    const planned = await manager.engine.plan('backup.create', input, c.cli.LOCAL_AUTH, { internal: true });
    c.report.plan = planned.plan;
    if (!c.json) {
        c.progress(`backup -> ${planned.plan.destination}`);
        c.progress(`  config     ${planned.plan.config.included ? 'included, encrypted with your passphrase' : (planned.plan.config.reason || 'left out')}`);
        c.progress('  encryption only config.json; the database and the files in the archive are not encrypted - keep it on protected storage');
    }
    const validated = await manager.engine.validate(planned.id, c.cli.LOCAL_AUTH);
    const applied = await manager.engine.apply(validated.id, { revision: validated.revision }, c.cli.LOCAL_AUTH);
    const result = applied.result;
    if (!c.json) {
        c.out(`backup.create: ${applied.operation.status}`);
        c.out(`  archive    ${result.dir}`);
        c.out(`  verified   ${result.verified ? `yes (${result.verifiedAgainst})` : 'NO'}`);
        c.out(`  database   ${result.engine}, ${result.tables} tables, ${result.rows} rows`);
        c.out(`  files      ${result.files}`);
        c.out(`  config     ${result.config.included ? 'included, encrypted' : 'not included'}`);
        if (result.omittedSecrets.length) c.out(`  omitted    ${result.omittedSecrets.join('; ')} (enter again after a restore)`);
        c.out(`  ${result.next}`);
    }
    return c.finish(EXIT.OK, {
        operation: { id: applied.operation.id, kind: 'backup.create', status: applied.operation.status },
        result
    });
}

async function restoreCommand(c, settings) {
    const { flags, fs } = c;
    const { CliError, EXIT } = c.cli;
    const answers = flags.answers ? c.cli.answersInput(c.cli.loadAnswers(flags.answers, fs), 'restore', fs, 'restore') : {};
    if (answers.passphrase) c.secrets.push(answers.passphrase);
    const dir = flags.dir || answers.dir;
    const confirm = flags.confirm || answers.confirm;
    const withoutConfig = flags.withoutConfig || answers.withoutConfig === true;

    const view = inspectArchive({ settings, dir, fs });
    if (!c.json) for (const line of describeArchive(view)) c.progress(line);
    if (!view.restorable) {
        throw new CliError(view.blocks[0], `This archive cannot be restored here (${view.blocks.join(', ')}); nothing was changed.`, EXIT.REFUSED);
    }
    if (view.schemaChangeNeedsAcceptance && !(flags.acceptSchemaChange || answers.acceptSchemaChange === true)) {
        throw new CliError('SCHEMA_MISMATCH', 'The archive was written by a different version of the schema. Run again with --accept-schema-change to restore it and migrate it forward; nothing was changed.', EXIT.REFUSED);
    }
    if (!confirm) {
        throw new CliError('CONFIRMATION_REQUIRED', 'A restore replaces the database and the files; it needs --confirm <installationId>. Nothing was changed.', EXIT.INVALID);
    }

    const input = { dir, confirm, withoutConfig, release: flags.release || answers.release === true };
    if (flags.acceptSchemaChange || answers.acceptSchemaChange === true) input.acceptSchemaChange = true;
    if (view.configIncluded && !withoutConfig) {
        const passphrase = await obtainPassphrase(c, { fromAnswers: answers.passphrase, question: 'Passphrase of the archive\'s config.json (hidden): ', confirmTwice: false });
        if (!passphrase) {
            throw new CliError('PASSPHRASE_REQUIRED', 'The archive holds an encrypted config.json. Give its passphrase (--passphrase-file, GOOBSTER_BACKUP_PASSPHRASE_FILE or the prompt), or say --without-config to leave config.json as it is; nothing was changed.', EXIT.INVALID);
        }
        input.passphrase = passphrase;
    }

    const manager = newManager(c, settings);
    await manager.engine.recoverInterrupted();
    const planned = await manager.engine.plan('backup.restore', input, c.cli.LOCAL_AUTH, { internal: true });
    c.report.plan = planned.plan;
    const plan = planned.plan;
    if (!c.json) {
        c.progress(`restore ${plan.archive.createdAt} (${plan.archive.engine})`);
        c.progress(`  replaces   the database${plan.replaces.fileSets.length ? `, the file sets ${plan.replaces.fileSets.join(', ')}` : ''}${plan.replaces.configJson ? ', config.json' : ''}`);
        c.progress(`  config     ${plan.config.restore ? 'restored (passphrase verified before anything changes)' : `left as it is (${plan.config.skipped || 'not restored'})`}`);
        c.progress(`  safety     ${plan.safetyBackup.required ? `a verified backup of what is there now goes to ${plan.safetyBackup.dir}` : plan.safetyBackup.reason}`);
        c.progress('  kept aside everything replaced is moved aside (.pre-restore-<time>), never deleted');
        c.progress('  afterwards the instance is paused; the maintenance barrier is ' + (plan.release ? 'released' : 'held until you release it'));
        if (plan.resumeOf) c.progress(`  resuming   an earlier restore of this archive stopped part way (${plan.resumeOf.done.length} step(s) done)`);
    }

    let applied;
    try {
        const validated = await manager.engine.validate(planned.id, c.cli.LOCAL_AUTH);
        applied = await manager.engine.apply(validated.id, { revision: validated.revision }, c.cli.LOCAL_AUTH);
    } catch (error) {
        if (error && error.operation) error.restoreStopped = true;
        throw error;
    }
    const result = applied.result;
    if (!c.json) {
        c.out(`backup.restore: ${applied.operation.status}${result.resumed ? ' (resumed)' : ''}`);
        c.out(`  database   restored (${result.engine})`);
        c.out(`  files      ${result.files.length ? result.files.map(set => `${set.id} (${set.files})`).join(', ') : 'none'}`);
        c.out(`  config     ${result.config.restored ? 'restored' : `left as it was${result.config.skipped ? ` (${result.config.skipped})` : ''}`}`);
        c.out(`  safety     ${result.safetyBackup ? `verified backup of the previous state: ${result.safetyBackup.dir}` : 'none (the target held no data)'}`);
        c.out(`  interrupted ${result.interruptedTotal} piece(s) of in-flight work, marked failed`);
        c.out(`  counts     ${result.rowCounts.matchesArchive ? 'match the archive' : `${result.rowCounts.mismatches.length} table(s) differ from the archive`}`);
        c.out(`  workers    ${result.workersRestarted ? 'restarted' : 'not restarted by this command: restart the application workers'}`);
        c.out(`  paused     yes; maintenance barrier ${result.maintenance.held ? 'still held' : 'released'}`);
        for (const item of result.retained || []) c.out(`  kept aside ${item.kind}: ${item.path}`);
        for (const item of result.secretsToReenter || []) c.out(`  enter again ${item}`);
        for (const line of result.next) c.out(`  next       ${line}`);
    }
    return c.finish(EXIT.OK, {
        operation: { id: applied.operation.id, kind: 'backup.restore', status: applied.operation.status },
        result
    });
}

/**
 * @param {Object} c the CLI context cli.js passes in
 * @returns {Promise<number>} the exit code
 */
async function run(c) {
    const settings = resolveSettings(c.baseEnv);
    if (c.command === 'restore') return restoreCommand(c, settings);
    if (c.flags.sub === 'inspect') return inspectCommand(c, settings);
    return backupCommand(c, settings);
}

function failureNotice(error, command) {
    if (command !== 'restore' || !(error instanceof ManagerError) && !(error && error.operation)) return null;
    if (error.restoreStopped) {
        return [
            'The restore stopped part way. Nothing was rolled back: what it replaced is kept aside (a name ending .pre-restore-<time>) and the maintenance barrier is still up.',
            'Run "goobster-manager release --force --acknowledge-mutation", then run the same restore again to carry on; finished sub-steps are skipped.',
            '"goobster-manager status" and the Host room show where it stopped.'
        ].join(' ');
    }
    return null;
}

module.exports = { run, checkArgs, failureNotice, describeArchive, readPassphraseFile, SUBCOMMANDS };
