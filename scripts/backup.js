#!/usr/bin/env node
/**
 * npm run backup -- [--out <dir>] [--skip-config] [--passphrase-file <path>]
 *
 * Writes a backup archive (a directory) of this installation: a consistent
 * database snapshot, the file sets, and config.json encrypted under a
 * passphrase typed now. Runbook: documentation/backup_and_restore.md.
 *
 * The database and the files are stored unencrypted - keep the archive on
 * protected storage. Environment secrets are not included; the manifest
 * lists which were set so a restore can say what to re-enter.
 */

const path = require('node:path');
const { readPassphrase } = require('./lib/passphrase');

function parseArgs(argv) {
    const args = { out: null, skipConfig: false, passphraseFile: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out' || arg === '-o') args.out = argv[++i];
        else if (arg === '--skip-config') args.skipConfig = true;
        else if (arg === '--passphrase-file') args.passphraseFile = argv[++i];
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function usage() {
    console.log(`Usage: npm run backup -- [--out <dir>] [--skip-config] [--passphrase-file <path>]

  --out <dir>               Parent directory for the archive (default: <data dir>/backups)
  --skip-config             Leave config.json out of the archive (no passphrase needed)
  --passphrase-file <path>  Read the passphrase from the first line of a file
                            (or set GOOBSTER_BACKUP_PASSPHRASE; otherwise you are prompted)

The database and files are stored unencrypted. Keep the archive on protected storage.`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        usage();
        return;
    }
    const runtimePaths = require('@goobster/core/runtimePaths');
    const backup = require('@goobster/core/services/backupService');
    const db = require('@goobster/core/db');

    const destDir = path.resolve(args.out || path.join(runtimePaths.dataDir, 'backups'));
    let passphrase = null;
    if (!args.skipConfig) {
        passphrase = await readPassphrase({
            file: args.passphraseFile,
            prompt: 'Passphrase to encrypt config.json (it is not stored anywhere): ',
            confirm: !args.passphraseFile && !process.env.GOOBSTER_BACKUP_PASSPHRASE
        });
        if (!passphrase) {
            console.error('config.json is only ever stored encrypted. Type a passphrase when prompted, pass --passphrase-file, set GOOBSTER_BACKUP_PASSPHRASE, or use --skip-config.');
            process.exit(64);
        }
    }

    console.log(`Engine: ${db.engine}`);
    console.log(`Destination: ${destDir}`);
    const { dir, manifest } = await backup.createBackup({
        destDir,
        passphrase,
        includeConfig: !args.skipConfig,
        logger: { info: console.log, warn: console.warn, error: console.error }
    });
    await db.closeConnection();

    const tables = Object.values(manifest.tables).reduce((sum, n) => sum + n, 0);
    console.log('');
    console.log(`Backup written: ${dir}`);
    console.log(`  database: ${manifest.engine}, ${Object.keys(manifest.tables).length} tables, ${tables} rows (schema ${manifest.schemaFingerprint})`);
    for (const set of manifest.files) {
        console.log(`  ${set.label}: ${set.files} file(s), ${(set.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    console.log(`  config.json: ${manifest.config.included ? 'encrypted with your passphrase' : 'not included'}`);
    if (manifest.envSecrets.present.length > 0) {
        console.log(`  environment secrets NOT in the archive (re-enter after a restore): ${manifest.envSecrets.present.join(', ')}`);
    }
    console.log('');
    console.log('The database and files in this archive are NOT encrypted. Keep it on protected storage');
    console.log('(an encrypted disk or a private off-box target). Only config.json is encrypted.');
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Backup failed${error.code ? ` (${error.code})` : ''}: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { main, parseArgs };
