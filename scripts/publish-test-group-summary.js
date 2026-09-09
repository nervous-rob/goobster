#!/usr/bin/env node
/**
 * Render a CI summary table from per-group JSON written by
 * `run-test-group.js` / `run-live-tests.js`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const resultsDir = process.env.GOOBSTER_TEST_RESULTS_DIR
    || path.join(ROOT, 'test-results', 'groups');

function loadSummaries() {
    if (!fs.existsSync(resultsDir)) return [];
    return fs.readdirSync(resultsDir)
        .filter((name) => name.endsWith('.summary.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')))
        .sort((a, b) => {
            const engine = String(a.engine).localeCompare(String(b.engine));
            if (engine !== 0) return engine;
            return String(a.groupId).localeCompare(String(b.groupId));
        });
}

function formatDuration(ms) {
    if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
    return `${(ms / 1000).toFixed(1)}s`;
}

function markdownTable(rows) {
    const header = '| Group | Engine | Passed | Failed | Skipped | Duration | Skip reason |';
    const sep = '| --- | --- | ---: | ---: | ---: | ---: | --- |';
    const body = rows.map((row) => {
        const reason = row.skipReason ? String(row.skipReason).replace(/\|/g, '\\|') : '';
        const name = row.success === false ? `**${row.groupName}**` : row.groupName;
        return `| ${name} | ${row.engine} | ${row.passed} | ${row.failed} | ${row.skipped} | ${formatDuration(row.durationMs)} | ${reason} |`;
    });
    return [header, sep, ...body].join('\n');
}

const rows = loadSummaries();
if (!rows.length) {
    const message = `No test group summaries in ${resultsDir}`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    }
    process.exit(0);
}

const failed = rows.filter((row) => row.success === false);
const title = failed.length
    ? `Test groups (${failed.length} failed)`
    : 'Test groups';

const markdown = `## ${title}\n\n${markdownTable(rows)}\n`;
process.stdout.write(`${markdown}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
