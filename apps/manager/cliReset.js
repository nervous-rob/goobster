/**
 * `goobster-manager reset` and `goobster-manager release` (documentation/data_reset.md).
 *
 *   reset --scope instance | --scope feature --feature <id>
 *         [--backup-dir <dir>] [--answers <file>] [--confirm <text>] [--dry-run] [--yes] [--json]
 *   release [--force] [--acknowledge-mutation]
 *
 * `reset` is one local session: it enters the maintenance barrier, runs the
 * `data.reset` operation under it, and releases the barrier when the reset
 * completed. When the irreversible phase began and the reset did not finish,
 * the barrier stays up (the manager process that holds it exits, which makes
 * it stale); `release --force --acknowledge-mutation` lifts it, after which
 * `reset` runs again. The backup passphrase comes from the answers file or a
 * hidden prompt, never from the command line.
 */

const { ManagerError } = require('./errors');
const { resolveSettings } = require('./settings');
const { createManager } = require('./manager');
const { createBarrier } = require('./maintenance/barrier');
const { previewReset } = require('./engine/kinds/reset');

const quiet = { info() {}, warn() {}, error() {} };

function describePreview(preview) {
    const lines = [`reset ${preview.scope}${preview.feature ? ` ${preview.feature}` : ''}`];
    lines.push(`  scope      ${preview.scope === 'instance' ? 'every application table, the vector index and every owned file set' : `the data of the dormant feature "${preview.feature}"`}`);
    lines.push(`  tables     ${preview.tables.cleared.length} emptied${preview.tables.partial.length ? `, ${preview.tables.partial.length} partly (shared rows)` : ''}`);
    for (const item of preview.tables.partial) lines.push(`    ${item.op} ${item.table}${item.where ? ` where ${item.where}` : ''}${item.column ? ` (${item.column})` : ''}`);
    if (preview.tables.cascading.length) lines.push(`  cascades   ${preview.tables.cascading.map(item => `${item.table}${item.op === 'set-null' ? ' (link cleared)' : ''}`).join(', ')}`);
    if (preview.tables.kept.length) lines.push(`  kept       ${preview.tables.kept.map(item => item.table).join(', ')}`);
    if (preview.tables.recreated.length) lines.push(`  recreated  ${preview.tables.recreated.map(item => item.table).join(', ')}`);
    lines.push(`  vectors    ${preview.derived.vectorIndex ? 'the whole vector index' : 'orphans only'}`);
    if (preview.files.length) {
        lines.push(`  files      ${preview.files.map(set => `${set.id}${set.files !== undefined ? ` (${set.files})` : ''}`).join(', ')}`);
    } else {
        lines.push('  files      none');
    }
    if (preview.keptFiles.length) lines.push(`  kept files ${preview.keptFiles.map(item => item.id).join(', ')}`);
    lines.push('  never      the manager store, config.json, the database itself, features.json, other schemas and services');
    lines.push(`  backup     verified before anything changes; ${preview.backup.includesConfig ? 'config.json encrypted into it' : 'no config.json'}`);
    if (preview.confirm) lines.push(`  confirm    type ${preview.confirm}`);
    if (preview.empty) lines.push('  nothing to remove for this scope');
    if (preview.featureActive === true) lines.push('  BLOCKED    the feature is active: disable it first (features.set), restart, then purge');
    return lines;
}

async function ensure(c, value, question, options = {}) {
    if (value !== undefined && value !== null && value !== '') return value;
    if (!c.prompter) {
        c.prompter = c.cli.createPrompter({ input: c.stdin, output: c.stderr });
        c.setPrompter(c.prompter);
    }
    return c.prompter.ask(question, options);
}

async function resetCommand(c, settings) {
    const { flags, fs } = c;
    const { CliError, EXIT } = c.cli;
    const input = flags.answers ? c.cli.answersInput(c.cli.loadAnswers(flags.answers, fs), 'reset', fs) : {};
    if (input.backup && input.backup.passphrase) c.secrets.push(input.backup.passphrase);
    if (flags.scope) input.scope = flags.scope;
    if (flags.feature) input.feature = flags.feature;
    if (flags.backupDir) input.backup = { ...(input.backup || {}), dir: flags.backupDir };
    if (flags.confirm) input.confirm = flags.confirm;

    if (flags.dryRun) {
        if (!input.scope) throw new CliError('USAGE', 'reset needs --scope instance, or --scope feature --feature <id> (or an answers file).');
        const preview = previewReset({ settings, fs, scope: { scope: input.scope, ...(input.feature ? { feature: input.feature } : {}) } });
        c.report.plan = preview;
        if (!c.json) for (const line of describePreview(preview)) c.out(line);
        return c.finish(preview.featureActive === true ? EXIT.INVALID : EXIT.OK, { plan: preview, dryRun: true });
    }

    input.scope = await ensure(c, input.scope, 'Scope (instance, feature): ');
    if (input.scope === 'feature') input.feature = await ensure(c, input.feature, 'Feature id to purge: ');
    const preview = previewReset({ settings, fs, scope: { scope: input.scope, ...(input.feature ? { feature: input.feature } : {}) } });
    c.report.plan = preview;
    if (!c.json) for (const line of describePreview(preview)) c.progress(line);
    if (preview.featureActive === true) {
        throw new CliError('FEATURE_ACTIVE', 'That feature is active. Disable it first (features.set), restart, then purge its data; nothing was changed.', EXIT.REFUSED);
    }

    const backup = { ...(input.backup || {}) };
    backup.dir = await ensure(c, backup.dir, 'Directory to write the backup into (outside the data being removed): ');
    if (!backup.skipConfig && !backup.passphrase && preview.backup.includesConfig) {
        backup.passphrase = await ensure(c, backup.passphrase, 'Passphrase to encrypt config.json in the backup (hidden): ', { hidden: true });
        c.secrets.push(backup.passphrase);
    }
    if (!input.confirm) {
        if (flags.yes || !c.stdinIsInteractive) {
            throw new CliError('CONFIRMATION_REQUIRED', `A reset needs the typed confirmation: --confirm ${input.scope === 'feature' ? '<installationId>:<feature>' : '<installationId>'}. Nothing was changed.`);
        }
        input.confirm = await ensure(c, input.confirm, input.scope === 'feature'
            ? 'Type the installation id, a colon and the feature id to confirm: '
            : 'Type the installation id to confirm: ');
    }

    const manager = createManager({
        settings,
        fs,
        logger: quiet,
        extraKinds: require('./extensions').kinds,
        ...(c.io.now ? { now: c.io.now } : {}),
        hooks: { beforeStep: ({ kind, step }) => c.progress(`[${kind}] ${step} ...`) }
    });
    if (!manager.storeReady) throw new CliError('STORE_UNUSABLE', 'The manager store cannot be created or written here.', EXIT.REFUSED);
    await manager.engine.recoverInterrupted();

    const auth = c.cli.LOCAL_AUTH;
    const entered = await manager.engine.run('maintenance.enter', { reason: 'data-reset', timeoutSeconds: input.timeoutSeconds || 120 }, auth);
    const ref = { operationId: entered.result.operationId, fence: entered.result.fence };
    const barrier = createBarrier({ settings, fs });
    let applied;
    try {
        const planned = await manager.engine.plan('data.reset', {
            scope: input.scope,
            ...(input.feature ? { feature: input.feature } : {}),
            backup,
            confirm: input.confirm,
            maintenance: ref
        }, auth, { internal: true });
        const validated = await manager.engine.validate(planned.id, auth);
        applied = await manager.engine.apply(validated.id, { revision: validated.revision }, auth);
    } catch (error) {
        if (barrier.view().mutateBegun) {
            error.barrierHeld = true;
        } else {
            try {
                await manager.engine.run('maintenance.release', ref, auth);
            } catch (releaseError) {
                error.barrierHeld = releaseError && releaseError.code !== 'MAINTENANCE_NOT_ACTIVE';
            }
        }
        throw error;
    }
    const released = await manager.engine.run('maintenance.release', ref, auth);
    const outcome = applied.result.outcome || {};
    if (!c.json) {
        c.out(`data.reset: ${applied.operation.status}`);
        c.out(`  scope      ${applied.result.scope}${applied.result.feature ? ` ${applied.result.feature}` : ''}`);
        c.out(`  removed    ${outcome.rows || 0} rows from ${Object.keys(outcome.tables || {}).length} tables, ${outcome.files ? outcome.files.total : 0} files, ${outcome.vectors ? outcome.vectors.before - outcome.vectors.after : 0} vectors`);
        c.out(`  backup     verified${applied.result.backup.archive ? `: ${applied.result.backup.archive}` : ''}`);
        c.out(applied.result.paused
            ? '  The instance is paused. Resume it from the Host room when you are ready; the self-documentation reseeds on the next start.'
            : '  Other features keep their data.');
        c.out(`  maintenance released (${released.result ? released.result.outcome : 'completed'})`);
    }
    return c.finish(EXIT.OK, {
        operation: { id: applied.operation.id, kind: 'data.reset', status: applied.operation.status },
        result: { ...applied.result, backup: { verified: applied.result.backup.verified } }
    });
}

async function releaseCommand(c, settings) {
    const { flags, fs } = c;
    const { CliError, EXIT } = c.cli;
    const manager = createManager({ settings, fs, logger: quiet, extraKinds: require('./extensions').kinds });
    if (!manager.storeReady) throw new CliError('STORE_UNUSABLE', 'The manager store cannot be created or written here.', EXIT.REFUSED);
    const view = createBarrier({ settings, fs }).view();
    if (!view.active) {
        if (!c.json) c.out('Maintenance is not active; nothing to release.');
        return c.finish(EXIT.OK, { released: false });
    }
    const result = await manager.engine.run('maintenance.release', {
        operationId: view.operationId,
        fence: view.fence,
        force: flags.force,
        acknowledgeMutation: flags.acknowledgeMutation
    }, c.cli.LOCAL_AUTH);
    if (!c.json) c.out(`maintenance released (${result.result ? result.result.outcome : 'released'}${flags.force ? ', forced' : ''})`);
    return c.finish(EXIT.OK, { released: true, outcome: result.result ? result.result.outcome : null });
}

/**
 * @param {Object} c the CLI context cli.js passes in
 * @returns {Promise<number>} the exit code
 */
async function run(c) {
    const settings = resolveSettings(c.baseEnv);
    if (c.command === 'release') return releaseCommand(c, settings);
    return resetCommand(c, settings);
}

function failureNotice(error) {
    if (!(error instanceof ManagerError) && !(error && error.operation)) return null;
    if (error.barrierHeld) {
        return [
            'The reset stopped after its irreversible step began, and the maintenance barrier is still up.',
            'Your backup was verified before anything changed. To finish: run "goobster-manager release --force --acknowledge-mutation", then run the same reset again;',
            'or restore the backup (documentation/backup_and_restore.md).'
        ].join(' ');
    }
    return null;
}

module.exports = { run, describePreview, failureNotice };
