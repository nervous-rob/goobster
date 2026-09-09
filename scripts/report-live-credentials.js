#!/usr/bin/env node
/**
 * Print whether live-integration env vars are set (names only).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatInventory, inventory } = require('./lib/liveCredentials');

const ROOT = path.join(__dirname, '..');
const resultsDir = process.env.GOOBSTER_TEST_RESULTS_DIR
    || path.join(ROOT, 'test-results', 'groups');

const rows = inventory();
const text = formatInventory(rows);
console.log(text);

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(
    path.join(resultsDir, 'credentials.json'),
    JSON.stringify({ providers: rows }, null, 2)
);

if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
        '## Live credentials',
        '',
        'Names and status only — values are never printed. Fork PRs normally have no repository secrets.',
        '',
        '| Variable | Status |',
        '| --- | --- |',
        ...rows.map((row) => `| ${row.env} | ${row.present ? 'present' : 'absent'} |`),
        ''
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

for (const row of rows) {
    if (!row.present) {
        console.log(`::notice::Skipping ${row.label} live tests — ${row.skipReason}`);
    }
}
