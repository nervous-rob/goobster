#!/usr/bin/env node
'use strict';

/**
 * Release acceptance driver: runs one cell of the matrix on this host and writes one evidence file
 * (documentation/release_acceptance.md, issue #343).
 *
 *   node scripts/acceptance/run.js --payload <dir> --out <dir>
 *        [--install new|adopt] [--db sqlite|existing-pg|managed-pg] [--features minimal|representative|full]
 *        [--work <dir>] [--port-base 3701] [--runner-image <name>] [--commit <sha>] [--keep]
 *
 * `--payload` is a directory made by `node scripts/package-runtime.js --dev-sign` (its profile decides
 * what `--features` means: `minimal` is --profile minimal, `representative` is `--features tavern,exchange`,
 * `full` is the full profile). The driver only talks to the installation as an operator can: the manager's
 * command line (`goobster-manager install|status|backup|restore|update|reset|uninstall ...`), the manager
 * process, and its documented loopback HTTP API. It never requires a module of the manager or of the
 * application. The existing-pg cell takes its server from GOOBSTER_ACCEPTANCE_PG_URL.
 *
 * Exit code: 0 when no step or injection failed, 1 when one did, 2 for a usage error.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const E = require('./lib/evidence');
const { Cell } = require('./lib/cell');
const { runLifecycle } = require('./lib/lifecycle');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function usage(message) {
    if (message) process.stderr.write(`${message}\n\n`);
    const source = fs.readFileSync(__filename, 'utf8');
    process.stderr.write(`${source.match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ ?\* ?/gm, '').trim()}\n`);
    process.exit(2);
}

function parseArgs(argv) {
    const o = { install: 'new', db: 'sqlite', features: 'minimal', portBase: 3701, keep: false, runnerImage: null, commit: null, work: null, out: null, payload: null, pgUrlEnv: 'GOOBSTER_ACCEPTANCE_PG_URL' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            i += 1;
            if (i >= argv.length) usage(`${arg} needs a value`);
            return argv[i];
        };
        if (arg === '--install') o.install = value();
        else if (arg === '--db') o.db = value();
        else if (arg === '--features') o.features = value();
        else if (arg === '--payload') o.payload = path.resolve(value());
        else if (arg === '--out') o.out = path.resolve(value());
        else if (arg === '--work') o.work = path.resolve(value());
        else if (arg === '--port-base') o.portBase = Number(value());
        else if (arg === '--runner-image') o.runnerImage = value();
        else if (arg === '--commit') o.commit = value();
        else if (arg === '--pg-url-env') o.pgUrlEnv = value();
        else if (arg === '--keep') o.keep = true;
        else if (arg === '-h' || arg === '--help') usage();
        else usage(`unknown option ${arg}`);
    }
    if (!E.INSTALLS.includes(o.install)) usage(`--install is one of ${E.INSTALLS.join(', ')}`);
    if (!E.DATABASES.includes(o.db)) usage(`--db is one of ${E.DATABASES.join(', ')}`);
    if (!E.FEATURE_SETS.includes(o.features)) usage(`--features is one of ${E.FEATURE_SETS.join(', ')}`);
    if (!o.payload || !fs.existsSync(path.join(o.payload, 'payload-manifest.json'))) usage('--payload must be a payload directory (payload-manifest.json inside)');
    if (!o.out) usage('--out is required');
    if (!Number.isInteger(o.portBase) || o.portBase < 1024 || o.portBase > 65000 - 10) usage('--port-base is a port number');
    return o;
}

function gitCommit() {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
    try {
        return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

function runnerImage(o) {
    if (o.runnerImage) return o.runnerImage;
    if (process.env.ImageOS && process.env.ImageVersion) return `${process.env.ImageOS} ${process.env.ImageVersion}`;
    return `local ${os.type()} ${os.release().split('-')[0]}`;
}

function artifactOf(payload) {
    const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'payload-manifest.json'), 'utf8'));
    let selection = { features: [], profile: 'full' };
    try { selection = JSON.parse(fs.readFileSync(path.join(payload, 'payload-selection.json'), 'utf8')); } catch { /* a full payload may carry none */ }
    return {
        version: manifest.release.core,
        target: manifest.target.id,
        profile: selection.profile || 'full',
        features: selection.features || [],
        node: manifest.node.version,
        signing: 'development key (throwaway)'
    };
}

async function main(argv) {
    const o = parseArgs(argv);
    o.work = o.work || fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-acceptance-'));
    fs.mkdirSync(o.out, { recursive: true });
    const redactor = E.hostRedactor();
    const recorder = new E.Recorder({ redactor });
    const cell = new Cell(o, recorder, redactor);
    const startedAt = new Date();
    const artifact = artifactOf(o.payload);
    let fatal = null;
    try {
        await cell.setup();
        await runLifecycle(cell);
    } catch (error) {
        fatal = error;
    } finally {
        await cell.teardown().catch(() => {});
    }
    if (fatal) process.stderr.write(`driver error: ${redactor.text(fatal.stack || fatal.message).split('\n').slice(0, 6).join('\n')}\n`);
    const { steps, injections } = recorder.ordered();
    const doc = {
        schema: E.SCHEMA_VERSION,
        cell: { id: E.cellId({ platform: process.platform, arch: process.arch, install: o.install, db: o.db, features: o.features }), platform: process.platform, arch: process.arch, install: o.install, db: o.db, features: o.features, runnerImage: redactor.text(runnerImage(o)) },
        artifact,
        commit: o.commit || gitCommit() || 'unknown',
        date: startedAt.toISOString().slice(0, 10),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        node: process.version,
        driverError: fatal ? redactor.text(fatal.message).slice(0, 240) : null,
        steps,
        injections,
        summary: { steps: E.summarize(steps), injections: E.summarize(injections) }
    };
    const problems = E.validate(doc);
    const leaks = E.findLeaks(doc);
    const file = path.join(o.out, E.fileNameFor(doc.cell));
    if (leaks.length) {
        process.stderr.write(`evidence NOT written: ${leaks.length} possible leak(s): ${leaks.slice(0, 5).map((item) => `${item.where} (${item.kind})`).join('; ')}\n`);
        return 1;
    }
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    for (const entry of [...steps, ...injections]) process.stdout.write(`${entry.status.padEnd(14)} ${entry.id.padEnd(24)} ${entry.result}\n`);
    process.stdout.write(`evidence: ${path.basename(file)}${problems.length ? ` (INVALID: ${problems.join('; ')})` : ''}\n`);
    const failed = [...steps, ...injections].some((entry) => entry.status === 'fail') || fatal || problems.length;
    if (failed) {
        const kept = keepLogs(path.join(o.work, 'logs'), path.join(o.out, `logs-${doc.cell.id}`), redactor);
        if (kept.length) process.stdout.write(`process logs: ${kept.join(', ')}\n`);
    }
    if (!o.keep) {
        const left = await removeWorkTree(o.work);
        if (left) process.stderr.write(`work directory kept: ${redactor.text(left)}\n`);
    }
    return failed ? 1 : 0;
}

/**
 * When a cell fails, the processes' own output (the manager's and the scratch managers' stdout and
 * stderr, what `--keep` would leave on the host) goes beside the evidence so a hosted failure can be
 * read without re-running it. Every line goes through the cell's redactor (secrets it minted, home,
 * user name), and a log that still shows something secret-like is replaced by a note saying so.
 * @returns {string[]} the file names written
 */
function keepLogs(from, to, redactor) {
    let names;
    try { names = fs.readdirSync(from).filter((name) => name.endsWith('.log')).sort(); } catch { return []; }
    if (!names.length) return [];
    fs.mkdirSync(to, { recursive: true });
    const kept = [];
    for (const name of names) {
        let text;
        try { text = redactor.text(fs.readFileSync(path.join(from, name), 'utf8')); } catch { continue; }
        const leaks = E.findLeaks({ text });
        const body = leaks.length ? `(not kept: ${leaks.length} possible leak(s): ${[...new Set(leaks.map((item) => item.kind))].join('; ')})\n` : text;
        fs.writeFileSync(path.join(to, name), body);
        kept.push(name);
    }
    return kept;
}

/**
 * The work tree is scratch: failing to remove it is never a failed cell. On Windows a file a process
 * has still mapped (a native addon of a worker that is still leaving) makes the remove fail with
 * EBUSY, ENOTEMPTY or EPERM for a moment, so it is tried a few times.
 * @returns {Promise<string|null>} the reason the tree was left, or null when it is gone
 */
async function removeWorkTree(dir) {
    let reason = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
            return null;
        } catch (error) {
            reason = `${error.code || 'error'}: ${error.message}`;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    return reason;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
        process.stderr.write(`acceptance driver failed: ${error && error.message}\n`);
        process.exitCode = 1;
    }).finally(() => {
        // A process the driver could not end (an orphan still holding the driver's pipes) must not keep
        // the driver alive until the job's timeout: the evidence is written, so leave with the code.
        setTimeout(() => process.exit(process.exitCode ?? 1), 15_000).unref();
    });
}

module.exports = { main, parseArgs, artifactOf, keepLogs };
