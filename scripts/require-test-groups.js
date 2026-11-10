#!/usr/bin/env node
/**
 * Fail unless every named group ran and passed on this job's engine.
 *
 * Usage: node scripts/require-test-groups.js <group-id> [<group-id> ...]
 *
 * An engine job is split into shards (the matrix in `.github/workflows/ci.yml`),
 * and each shard runs only its own groups as `continue-on-error` steps. This is
 * the step that turns those outcomes into the job result. It reads the summary
 * `run-test-group.js` wrote, so a group that was skipped, never started, or
 * crashed before writing a result fails the shard just as a failed test does.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GROUPS, groupById, resolveEngine } = require('../tests/ciGroups');

const ROOT = path.join(__dirname, '..');
const resultsDir = process.env.GOOBSTER_TEST_RESULTS_DIR
    || path.join(ROOT, 'test-results', 'groups');

const ids = process.argv.slice(2);
if (!ids.length) {
    console.error(`Usage: node scripts/require-test-groups.js <${GROUPS.map((g) => g.id).join('|')}> ...`);
    process.exit(2);
}

const engine = resolveEngine();
const problems = [];

for (const id of ids) {
    const group = groupById(id);
    if (!group) {
        problems.push(`unknown group "${id}"`);
        continue;
    }
    const file = path.join(resultsDir, `${engine}-${id}.summary.json`);
    let summary;
    try {
        summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        console.log(`${id}=missing`);
        problems.push(`${group.name} (${engine}) did not run: no result at ${path.relative(ROOT, file)}`);
        continue;
    }
    const ok = summary.success === true && summary.failed === 0 && summary.total > 0;
    console.log(`${id}=${ok ? 'success' : 'failure'}`);
    if (!ok) {
        problems.push(
            `${group.name} (${engine}) failed: passed=${summary.passed} failed=${summary.failed} total=${summary.total}`
        );
    }
}

if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
}
