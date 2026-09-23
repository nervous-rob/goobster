#!/usr/bin/env node
/**
 * npm run restore -- <archive dir> [--force] [--accept-schema-change]
 *                                  [--without-config] [--passphrase-file <path>]
 *
 * Restores a backup archive into THIS installation. Stop the bot and the
 * api first. Runbook: documentation/backup_and_restore.md.
 *
 * What happens: the archive's engine and schema fingerprint are checked
 * against this installation; the passphrase (if any) is checked before a
 * byte is written; the database and file sets are replaced; config.json
 * comes back if the passphrase opened it; every piece of in-flight work is
 * marked "interrupted by restore" (never retried); the instance is left
 * paused, so nothing that came due in the meantime fires until the
 * operator resumes from the Host room.
 */

const path = require('node:path');
const { readPassphrase } = require('./lib/passphrase');

function parseArgs(argv) {
    const args = { dir: null, force: false, acceptSchemaChange: false, withoutConfig: false, passphraseFile: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--force') args.force = true;
        else if (arg === '--accept-schema-change') args.acceptSchemaChange = true;
        else if (arg === '--without-config') args.withoutConfig = true;
        else if (arg === '--passphrase-file') args.passphraseFile = argv[++i];
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        else if (!args.dir) args.dir = arg;
        else throw new Error(`Unexpected argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`Usage: npm run restore -- <archive dir> [options]

  --force                   Replace an installation that already has data
                            (SQLite keeps a .pre-restore copy of the old file)
  --accept-schema-change    Restore an archive made by a different code version;
                            opening the database then migrates it forward
  --without-config          Do not restore config.json even if a passphrase is available
  --passphrase-file <path>  Read the passphrase from the first line of a file
                            (or set GOOBSTER_BACKUP_PASSPHRASE; otherwise you are prompted)

Stop the bot and the api before restoring. The instance comes back paused.`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.dir) {
        usage();
        if (!args.help) process.exit(64);
        return;
    }
    const backup = require('@goobster/core/services/backupService');
    const db = require('@goobster/core/db');

    const dir = path.resolve(args.dir);
    const manifest = backup.inspectBackup(dir);
    console.log(`Archive: ${dir}`);
    console.log(`  made ${manifest.createdAt} UTC on ${manifest.engine}, schema ${manifest.schemaFingerprint}`);
    console.log(`  this installation: ${db.engine}, schema ${backup.schemaFingerprint()}`);

    let passphrase = null;
    if (manifest.config?.included && !args.withoutConfig) {
        passphrase = await readPassphrase({
            file: args.passphraseFile,
            prompt: 'Passphrase for config.json (leave empty to restore without it): '
        });
        if (!passphrase) console.log('No passphrase: config.json will not be restored.');
    }

    const report = await backup.restoreBackup({
        dir,
        passphrase,
        withConfig: !args.withoutConfig,
        acceptSchemaChange: args.acceptSchemaChange,
        force: args.force,
        logger: { info: console.log, warn: console.warn, error: console.error }
    });
    await db.closeConnection();

    console.log('');
    console.log('Restore complete.');
    if (report.setAside.length > 0) {
        console.log(`  set aside: ${report.setAside.join(', ')}`);
    }
    for (const set of report.files) {
        console.log(`  ${set.label}: ${set.files} file(s) → ${set.to}`);
    }
    console.log(`  config.json: ${report.config.restored ? `restored to ${report.config.path}` : `not restored (${report.config.skipped})`}`);
    const interrupted = Object.entries(report.interrupted);
    if (interrupted.length > 0) {
        console.log(`  in-flight work marked "${backup.INTERRUPTED_REASON}" (not retried): `
            + interrupted.map(([kind, n]) => `${n} ${kind}`).join(', '));
    } else {
        console.log('  no in-flight work to interrupt');
    }
    if (report.counts.mismatches.length === 0) {
        console.log(`  row counts match the manifest (${Object.keys(report.counts.expected).length} tables)`);
    } else {
        console.log('  ROW COUNT MISMATCHES:');
        for (const m of report.counts.mismatches) {
            console.log(`    ${m.table}: expected ${m.expected}, got ${m.actual ?? 'missing table'}`);
        }
    }
    if (report.schemaChanged) {
        console.log('  the database was migrated forward to this code version on open');
    }
    console.log('');
    console.log('The instance is PAUSED. Start it, sign in, check your data, then resume from the Host room.');
    console.log('Missed automations, triggers and follow-ups will not fire; they resume from their next scheduled time.');
    if (report.secretsToReenter.length > 0) {
        console.log('');
        console.log('Re-enter before starting:');
        for (const item of report.secretsToReenter) console.log(`  - ${item}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Restore failed${error.code ? ` (${error.code})` : ''}: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { main, parseArgs };
