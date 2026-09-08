#!/usr/bin/env node
/**
 * Fail if the CI group manifest drifts from Jest's discovered unit specs.
 *
 * Discovers files the same way `npm test` does (`jest --listTests`), then
 * compares against `tests/ciGroups.js`. Also checks that both engine jobs
 * in `.github/workflows/ci.yml` list every group as an ordinary step.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const {
    GROUPS,
    auditTestGroups,
    toRepoPosix
} = require('../tests/ciGroups');

function listJestTests() {
    const jestBin = require.resolve('jest/bin/jest');
    const result = spawnSync(process.execPath, [jestBin, '--listTests'], {
        cwd: ROOT,
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`jest --listTests failed (exit ${result.status}): ${detail}`);
    }
    return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((filePath) => toRepoPosix(filePath, ROOT));
}

const workflowPath = path.join(ROOT, '.github/workflows/ci.yml');
const workflowSource = fs.existsSync(workflowPath)
    ? fs.readFileSync(workflowPath, 'utf8')
    : '';

const discovered = listJestTests();
const errors = auditTestGroups({ discovered, groups: GROUPS, workflowSource });

if (!workflowSource) {
    errors.push('missing .github/workflows/ci.yml');
}

if (errors.length) {
    console.error('Test group inventory failed:');
    for (const error of errors) {
        console.error(`  ${error}`);
    }
    console.error(
        `\nAdd new specs to exactly one group in tests/ciGroups.js ` +
        `(${GROUPS.map((g) => g.id).join(', ')}).`
    );
    process.exit(1);
}

const counts = GROUPS.map((g) => `${g.id}=${g.files.length}`).join(', ');
console.log(`Test group inventory ok: ${discovered.length} files in ${GROUPS.length} groups (${counts}).`);
