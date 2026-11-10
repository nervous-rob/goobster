#!/usr/bin/env node
/**
 * Run (or print) one duration-balanced shard of the Playwright journeys.
 *
 *   node scripts/e2e-shard.js <index> <total>            run shard <index> of <total>
 *   node scripts/e2e-shard.js <index> <total> --list     print its spec files
 *   node scripts/e2e-shard.js --plan <total>             print every shard and its weight
 *   node scripts/e2e-shard.js --record <report.json>     rewrite e2e/shard-durations.json
 *                                                        from `playwright test --reporter=json`
 *
 * CI runs the shards as parallel jobs, each with its own server and throwaway
 * database (`.github/workflows/ci.yml`). `npm run test:e2e` is unchanged and
 * still runs everything in one process.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    DURATIONS_PATH,
    durationsFromReport,
    listSpecFiles,
    loadDurations,
    planShards
} = require('./lib/e2eShards');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);

function usage(code) {
    console.error('Usage: node scripts/e2e-shard.js <index> <total> [--list] | --plan <total> | --record <report.json>');
    process.exit(code);
}

function positiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

if (args[0] === '--record') {
    if (!args[1]) usage(2);
    const report = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
    const durations = durationsFromReport(report);
    if (!Object.keys(durations).length) {
        console.error(`No test durations found in ${args[1]}`);
        process.exit(1);
    }
    fs.writeFileSync(DURATIONS_PATH, `${JSON.stringify(durations, null, 4)}\n`);
    console.log(`Recorded ${Object.keys(durations).length} spec files in ${path.relative(ROOT, DURATIONS_PATH)}`);
    process.exit(0);
}

if (args[0] === '--plan') {
    const total = positiveInt(args[1]);
    if (!total) usage(2);
    const shards = planShards({ files: listSpecFiles(), durations: loadDurations(), total });
    shards.forEach((shard, i) => {
        console.log(`shard ${i + 1}/${total}: ${shard.files.length} files, ~${Math.round(shard.seconds)}s`);
        for (const file of shard.files) console.log(`  ${file}`);
    });
    process.exit(0);
}

const index = positiveInt(args[0]);
const total = positiveInt(args[1]);
if (!index || !total || index > total) usage(2);

const shard = planShards({ files: listSpecFiles(), durations: loadDurations(), total })[index - 1];
const targets = shard.files.map((file) => `e2e/${file}`);

if (args.includes('--list')) {
    for (const target of targets) console.log(target);
    process.exit(0);
}

console.log(`[e2e-shard] ${index}/${total}: ${targets.length} spec files, ~${Math.round(shard.seconds)}s recorded`);
if (!targets.length) {
    // More shards than spec files. Passing no paths would run the whole suite.
    console.log('[e2e-shard] nothing assigned to this shard');
    process.exit(0);
}

const cli = require.resolve('@playwright/test/cli');
const startedAt = Date.now();
const result = spawnSync(process.execPath, [cli, 'test', ...targets], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
});
const elapsed = Math.round((Date.now() - startedAt) / 1000);
const status = result.status === null ? 1 : result.status;
console.log(`[e2e-shard] ${index}/${total}: journeys took ${elapsed}s (recorded ~${Math.round(shard.seconds)}s), exit ${status}`);

// Say so while there is still room, not when the job limit cancels the run.
const warnAfter = Number(process.env.E2E_SHARD_WARN_SECONDS) || 0;
if (warnAfter > 0 && elapsed > warnAfter) {
    console.log(`::warning title=Playwright shard ${index}/${total} is getting long::Journeys took ${elapsed}s, over the ${warnAfter}s mark. `
        + 'Add a shard to the test-e2e matrix in .github/workflows/ci.yml, or refresh e2e/shard-durations.json (documentation/testing_guide.md).');
}
if (process.env.GITHUB_STEP_SUMMARY) {
    try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `Playwright shard ${index}/${total}: ${targets.length} spec files, journeys ${elapsed}s (recorded ~${Math.round(shard.seconds)}s), ${status === 0 ? 'passed' : 'failed'}\n`);
    } catch {}
}
process.exit(status);
