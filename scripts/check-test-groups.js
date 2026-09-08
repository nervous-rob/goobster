#!/usr/bin/env node
/**
 * Fail if the CI group manifest drifts from Jest's discovered unit specs.
 *
 * Discovers files the same way `npm test` does (`jest --listTests`), then
 * compares against `tests/ciGroups.js`. Also checks that the composite
 * action lists every group id.
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

const actionPath = path.join(ROOT, '.github/actions/run-test-groups/action.yml');
const actionSource = fs.existsSync(actionPath)
    ? fs.readFileSync(actionPath, 'utf8')
    : '';

const discovered = listJestTests();
const errors = auditTestGroups({ discovered, groups: GROUPS, actionSource });

if (!actionSource) {
    errors.push('missing .github/actions/run-test-groups/action.yml');
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
