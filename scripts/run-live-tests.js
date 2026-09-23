#!/usr/bin/env node
/**
 * Run `tests/live/*.live.test.js` and write a per-provider summary for CI.
 *
 * Missing credentials skip that provider (Jest pending). An invalid key or
 * a failed provider call is a real failure.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inventory } = require('./lib/liveCredentials');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--research-evaluation')) throw new Error('Supported option: --research-evaluation');
const evaluationOnly = args.includes('--research-evaluation');
const liveEnv = evaluationOnly ? { ...process.env, GOOBSTER_RESEARCH_EVAL: '1' } : process.env;
const resultsDir = process.env.GOOBSTER_TEST_RESULTS_DIR
    || path.join(ROOT, 'test-results', 'groups');
fs.mkdirSync(resultsDir, { recursive: true });

const evaluation = require('./lib/researchEvaluation').evaluationOptions(liveEnv,
    require('../tests/live/research-evaluation/questions.v1.json'));
const outputFile = path.join(resultsDir, 'live-jest.json');
fs.rmSync(outputFile, { force: true });
const startedAt = Date.now();
const jestBin = require.resolve('jest/bin/jest');
const result = spawnSync(
    process.execPath,
    [jestBin, '--config', 'jest.live.config.js', ...(evaluationOnly
        ? ['--runTestsByPath', 'tests/live/researchEvaluation.live.test.js'] : []), '--json', `--outputFile=${outputFile}`],
    {
        cwd: ROOT,
        stdio: 'inherit',
        env: liveEnv
    }
);

const durationMs = Date.now() - startedAt;
let report = {
    success: result.status === 0,
    numPassedTests: 0,
    numFailedTests: result.status === 0 ? 0 : 1,
    numPendingTests: 0,
    numTotalTests: 0,
    testResults: []
};
try {
    report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
} catch { /* jest crashed before writing json */ }

const creds = inventory().filter(row => !evaluationOnly || row.id === evaluation.provider);
const skipReasons = creds
    .filter((row) => !row.present)
    .map((row) => row.skipReason);

if (evaluation.reason) skipReasons.push(`Research evaluation: ${evaluation.reason}`);

const record = {
    groupId: 'live',
    groupName: 'Live integrations',
    engine: 'live',
    success: result.status === 0 && report.success !== false,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
    total: report.numTotalTests,
    durationMs,
    skipReason: skipReasons.length ? skipReasons.join('; ') : null,
    jestStatus: result.status
};

fs.writeFileSync(
    path.join(resultsDir, 'live-live.summary.json'),
    JSON.stringify(record, null, 2)
);

const seconds = (durationMs / 1000).toFixed(1);
console.log(
    `[test-group] Live integrations (live) ` +
    `passed=${record.passed} failed=${record.failed} skipped=${record.skipped} ` +
    `duration=${seconds}s` +
    (record.skipReason ? ` skip=${record.skipReason}` : '')
);

process.exit(result.status === null ? 1 : result.status);
