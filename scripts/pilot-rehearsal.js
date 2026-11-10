#!/usr/bin/env node
/**
 * The pilot rehearsal: the integrated delegated-work flow, end to end,
 * against a throwaway database (documentation/delegated_pilot.md).
 *
 *   npm run pilot:rehearsal              # run it and print each check
 *   npm run pilot:rehearsal -- --json    # the same record, machine-readable
 *   npm run pilot:rehearsal -- --keep    # leave the throwaway directory behind and print where it is
 *
 * It never touches this installation. Before any Goobster module loads it
 * points the database, the data directory, the logs and config.json at a
 * new temporary directory, and removes the Postgres address and every
 * provider key from its own environment: the database is a new SQLite
 * file, the model is a script, and nothing reaches a provider or the
 * network. The directory is removed afterwards.
 *
 * Exit code 0 when every check passed, 1 when one failed, 2 when the
 * rehearsal could not run.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter(arg => !['--json', '--keep'].includes(arg));
if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}. Use --json or --keep.`);
    process.exit(2);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-pilot-rehearsal-'));
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ ai: { provider: '' } }), { mode: 0o600 });
Object.assign(process.env, {
    GOOBSTER_DB_PATH: path.join(directory, 'rehearsal.sqlite'),
    GOOBSTER_DATA_DIR: path.join(directory, 'data'),
    GOOBSTER_CACHE_DIR: path.join(directory, 'cache'),
    GOOBSTER_LOG_DIR: path.join(directory, 'logs'),
    GOOBSTER_CONFIG_PATH: path.join(directory, 'config.json')
});
for (const name of [
    'GOOBSTER_DB_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY', 'ELEVENLABS_API_KEY', 'OPENROUTER_API_KEY'
]) {
    delete process.env[name];
}

// Standard output carries the record and nothing else: what a module logs on the way goes to standard error.
console.log = console.error.bind(console);

async function main() {
    const { rehearse, format } = require('./lib/assistantPilotRehearsal');
    let result;
    try {
        result = await rehearse();
    } finally {
        try { await require('@goobster/core/db').closeConnection(); } catch { /* never opened */ }
    }
    process.stdout.write(`${args.has('--json') ? JSON.stringify(result, null, 2) : format(result)}\n`);
    return result.ok ? 0 : 1;
}

main().then((code) => code, (error) => {
    console.error(`The rehearsal could not run: ${error?.code ? `${error.code}: ` : ''}${error?.message || error}`);
    return 2;
}).then((code) => {
    if (args.has('--keep')) console.error(`Kept ${directory}`);
    else fs.rmSync(directory, { recursive: true, force: true });
    process.exit(code);
});
