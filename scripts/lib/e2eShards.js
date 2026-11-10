/**
 * Split the Playwright spec files into shards of roughly equal duration.
 *
 * `playwright test --shard=i/n` balances by test count in file order, which
 * puts the few long journeys (host operator, setup wizard, update) in the
 * same shard. This plans by measured seconds per file instead, from
 * `e2e/shard-durations.json`.
 *
 * The plan is a pure function of the spec files on disk, so every shard job
 * of one commit computes the same partition and each spec runs in exactly
 * one of them. A spec that has no recorded duration yet is still assigned
 * (at the median weight); nothing has to be registered for it to run.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const E2E_DIR = path.join(ROOT, 'e2e');
const DURATIONS_PATH = path.join(E2E_DIR, 'shard-durations.json');

function listSpecFiles(dir = E2E_DIR) {
    return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.spec.js'))
        .sort();
}

function loadDurations(file = DURATIONS_PATH) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

function median(values) {
    if (!values.length) return 1;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * @param {object} opts
 * @param {string[]} opts.files - spec file names (no directory)
 * @param {Record<string, number>} [opts.durations] - seconds per spec file
 * @param {number} opts.total - number of shards
 * @returns {{ files: string[], seconds: number }[]} one entry per shard
 */
function planShards({ files, durations = {}, total }) {
    if (!Number.isInteger(total) || total < 1) {
        throw new Error(`shard total must be a positive integer, got ${total}`);
    }
    const known = files
        .map((file) => durations[file])
        .filter((value) => typeof value === 'number' && value > 0);
    const fallback = median(known);
    const weighted = files
        .map((file) => ({
            file,
            seconds: typeof durations[file] === 'number' && durations[file] > 0 ? durations[file] : fallback
        }))
        .sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));

    const shards = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
    for (const entry of weighted) {
        let target = shards[0];
        for (const shard of shards) {
            if (shard.seconds < target.seconds) target = shard;
        }
        target.files.push(entry.file);
        target.seconds += entry.seconds;
    }
    for (const shard of shards) shard.files.sort();
    return shards;
}

/** Seconds per spec file from a Playwright JSON report (`--reporter=json`). */
function durationsFromReport(report) {
    const out = {};
    const visit = (suite, file) => {
        const owner = file || (suite.file ? path.basename(suite.file) : null);
        for (const spec of suite.specs || []) {
            for (const test of spec.tests || []) {
                for (const result of test.results || []) {
                    if (!owner || typeof result.duration !== 'number') continue;
                    out[owner] = (out[owner] || 0) + result.duration / 1000;
                }
            }
        }
        for (const child of suite.suites || []) visit(child, owner);
    };
    for (const suite of report.suites || []) visit(suite, null);
    for (const file of Object.keys(out)) out[file] = Math.max(1, Math.round(out[file]));
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

module.exports = {
    DURATIONS_PATH,
    E2E_DIR,
    durationsFromReport,
    listSpecFiles,
    loadDurations,
    planShards
};
