#!/usr/bin/env node
/**
 * Run one named unit-test group with Jest `--runTestsByPath`.
 *
 * Usage: node scripts/run-test-group.js <group-id>
 *
 * Writes a JSON result next to the other groups so the CI summary can
 * show counts even when a later group still needs to run.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GROUPS, groupById, resolveEngine } = require('../tests/ciGroups');

const ROOT = path.join(__dirname, '..');
// Lines of a failure message kept in the summary (the rest is in the Jest output).
const FAILURE_MESSAGE_LINES = 12;
const groupId = process.argv[2];

if (!groupId) {
    console.error(`Usage: node scripts/run-test-group.js <${GROUPS.map((g) => g.id).join('|')}>`);
    process.exit(2);
}

const group = groupById(groupId);
if (!group) {
    console.error(`Unknown test group "${groupId}". Known: ${GROUPS.map((g) => g.id).join(', ')}`);
    process.exit(2);
}

const resultsDir = process.env.GOOBSTER_TEST_RESULTS_DIR
    || path.join(ROOT, 'test-results', 'groups');
fs.mkdirSync(resultsDir, { recursive: true });

const engine = resolveEngine();
const outputFile = path.join(resultsDir, `${engine}-${group.id}.json`);
const startedAt = Date.now();

const jestBin = require.resolve('jest/bin/jest');
const result = spawnSync(
    process.execPath,
    [jestBin, '--json', `--outputFile=${outputFile}`, '--runTestsByPath', ...group.files],
    {
        cwd: ROOT,
        stdio: 'inherit',
        env: process.env
    }
);

const durationMs = Date.now() - startedAt;
const summary = readJestJson(outputFile, {
    success: result.status === 0,
    numPassedTests: 0,
    numFailedTests: result.status === 0 ? 0 : 1,
    numPendingTests: 0,
    numTotalTests: 0
});

const record = {
    groupId: group.id,
    groupName: group.name,
    engine,
    success: result.status === 0 && summary.success !== false,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
    skipped: summary.numPendingTests,
    total: summary.numTotalTests,
    durationMs,
    skipReason: null,
    jestStatus: result.status,
    // Named failures, so the CI summary (and the tail of a long job log)
    // says which test failed, not just how many.
    failures: collectFailures(summary)
};

fs.writeFileSync(
    path.join(resultsDir, `${engine}-${group.id}.summary.json`),
    JSON.stringify(record, null, 2)
);

const seconds = (durationMs / 1000).toFixed(1);
console.log(
    `[test-group] ${group.name} (${engine}) ` +
    `passed=${record.passed} failed=${record.failed} skipped=${record.skipped} ` +
    `duration=${seconds}s`
);
for (const failure of record.failures) {
    console.log(`[test-group]   FAILED ${failure.file} › ${failure.name}`);
    for (const line of failure.message.split('\n')) console.log(`[test-group]     ${line}`);
}

process.exit(result.status === null ? 1 : result.status);

/** `[{ file, name, message }]` for every failed assertion and suite-level error in a Jest JSON report. */
function collectFailures(report) {
    const out = [];
    for (const suite of report.testResults || []) {
        const file = path.relative(ROOT, suite.name || '').split(path.sep).join('/');
        for (const test of suite.assertionResults || []) {
            if (test.status !== 'failed') continue;
            out.push({ file, name: test.fullName || test.title || '(unnamed)', message: trimMessage(test.failureMessages) });
        }
        if (suite.status === 'failed' && !(suite.assertionResults || []).some((t) => t.status === 'failed')) {
            out.push({ file, name: '(suite failed to run)', message: trimMessage([suite.message || suite.failureMessage || '']) });
        }
    }
    return out;
}

function trimMessage(messages) {
    const text = (Array.isArray(messages) ? messages : [messages]).filter(Boolean).join('\n')
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
    const lines = text.split('\n').filter((line) => line.trim() && !/^\s+at /.test(line));
    return lines.slice(0, FAILURE_MESSAGE_LINES).join('\n');
}

function readJestJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}
