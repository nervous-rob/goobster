#!/usr/bin/env node
'use strict';

/**
 * Keep the third-party tools pinned in scripts/bootstrap-pins.json verified, mirrored and
 * current (documentation/bootstrap_tools.md).
 *
 *   node scripts/bootstrap-tools.js verify  [--require-mirror] [--staged <dir>] [--stage <dir>]
 *   node scripts/bootstrap-tools.js refresh [--write] [--stage <dir>] [--report <file>]
 *   node scripts/bootstrap-tools.js publish [--dry-run] [--staged <dir>] [--target <commit>]
 *
 * verify   downloads every pinned file from the mirror and from upstream, checks each copy
 *          against its SHA-256, and checks the signature and the embedded commit where the pin
 *          declares them. --require-mirror fails when the mirror lacks a file. --stage keeps
 *          the verified files, named as the mirror names them.
 * refresh  asks upstream for a newer build of each tool, verifies it, and prints what it
 *          found. --write rewrites the pins file with the verified build; nothing else changes.
 * publish  uploads the pinned files the mirror release lacks (creating the release first).
 *          It reads GH_TOKEN or GITHUB_TOKEN. --staged names verified copies to use when
 *          upstream no longer serves a pinned file. --dry-run uploads nothing.
 *
 * Exit status: 0 when everything checked out, 1 when a check failed, 2 on a usage error.
 * Node built-ins only, plus scripts/lib; signature checks need `gpg` on the PATH.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tools = require('./lib/bootstrapTools');

const COMMANDS = Object.freeze({
    verify: { flags: ['--require-mirror'], values: ['--staged', '--stage'] },
    refresh: { flags: ['--write'], values: ['--stage', '--report'] },
    publish: { flags: ['--dry-run'], values: ['--staged', '--target'] }
});

function usage() {
    return [
        'Usage: node scripts/bootstrap-tools.js verify  [--require-mirror] [--staged <dir>] [--stage <dir>]',
        '       node scripts/bootstrap-tools.js refresh [--write] [--stage <dir>] [--report <file>]',
        '       node scripts/bootstrap-tools.js publish [--dry-run] [--staged <dir>] [--target <commit>]'
    ].join('\n');
}

function camel(option) {
    return option.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
    const command = argv[0];
    if (command === '--help' || command === '-h') return { command: 'help' };
    const spec = COMMANDS[command];
    if (!spec) throw new Error(command ? `unknown command ${command}` : 'a command is required');
    const options = { command };
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') return { command: 'help' };
        if (spec.flags.includes(arg)) options[camel(arg)] = true;
        else if (spec.values.includes(arg)) {
            const value = argv[++i];
            if (value === undefined || value === '') throw new Error(`${arg} needs a value`);
            options[camel(arg)] = value;
        } else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

function setOutput(name, value, env = process.env) {
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function runVerify(options, io) {
    const result = await tools.verifyPins({
        pins: io.pins,
        workDir: io.workDir,
        stagedDir: options.staged ? path.resolve(options.staged) : null,
        stageTo: options.stage ? path.resolve(options.stage) : null,
        requireMirror: Boolean(options.requireMirror),
        doDownload: io.doDownload,
        keysDir: io.keysDir
    });
    for (const row of result.rows) {
        io.out(`${row.problems.length === 0 ? 'ok  ' : 'FAIL'} ${row.id.padEnd(22)} mirror: ${row.mirror.padEnd(11)} upstream: ${row.upstream.padEnd(11)}${row.staged ? ' staged copy used' : ''}${row.signed ? ' signature checked' : ''}`);
        for (const problem of row.problems) io.out(`     ${problem.code}: ${problem.detail}`);
    }
    if (result.rows.some(row => row.mirror === 'absent')) io.out('A file the mirror does not hold yet is published when its pin is merged.');
    if (result.rows.some(row => row.upstream === 'different')) io.out('Upstream serves a different build of at least one file; the refresh proposes it.');
    return result.ok ? 0 : 1;
}

async function runRefresh(options, io) {
    const result = await tools.refresh({ pins: io.pins, github: io.github, workDir: io.workDir, doDownload: io.doDownload, keysDir: io.keysDir, log: io.out });
    setOutput('changed', result.changed ? 'true' : 'false', io.env);
    if (!result.changed) {
        io.out('Every pinned tool is the build upstream serves for the release it follows.');
        return 0;
    }
    const report = tools.renderRefreshReport(result);
    if (options.report) fs.writeFileSync(path.resolve(options.report), report);
    else io.out(report);
    if (options.stage) {
        const dir = path.resolve(options.stage);
        fs.mkdirSync(dir, { recursive: true });
        for (const item of result.files) fs.copyFileSync(item.file, path.join(dir, item.name));
    }
    setOutput('summary', result.changes.map(change => `${change.tool} ${change.sameTag ? `rebuilt at ${change.to.commit.slice(0, 7)}` : change.to.tag}`).join(', '), io.env);
    if (options.write) {
        fs.writeFileSync(io.pinsFile, `${JSON.stringify(result.pins, null, 4)}\n`);
        io.out(`Rewrote ${path.relative(process.cwd(), io.pinsFile)}.`);
    } else {
        io.out('Nothing was written. Pass --write to update the pins file.');
    }
    return 0;
}

async function runPublish(options, io) {
    const result = await tools.publish({
        pins: io.pins,
        github: io.github,
        workDir: io.workDir,
        stagedDir: options.staged ? path.resolve(options.staged) : null,
        target: options.target || null,
        dryRun: Boolean(options.dryRun),
        doDownload: io.doDownload,
        keysDir: io.keysDir,
        log: io.out
    });
    const verb = result.dryRun ? 'to upload' : 'uploaded';
    io.out(`Mirror ${io.pins.mirror.repository}@${io.pins.mirror.tag}: ${result.present.length} file(s) already there, ${result.uploaded.length} ${verb}${result.created ? (result.dryRun ? ', the release does not exist yet' : ', the release was created') : ''}.`);
    return 0;
}

async function main(argv, { env = process.env, out = (line) => process.stdout.write(`${line}\n`), pinsFile = tools.PINS_FILE, github = null, doDownload = undefined } = {}) {
    let options;
    try {
        options = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${error.message}\n${usage()}\n`);
        return 2;
    }
    if (options.command === 'help') {
        out(usage());
        return 0;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-bootstrap-tools-'));
    try {
        // Key files are named relative to the pins file.
        const io = { env, out, pinsFile, keysDir: path.dirname(pinsFile), workDir, doDownload, pins: tools.readPins(pinsFile), github: github || tools.createGithub({ token: env.GH_TOKEN || env.GITHUB_TOKEN || '' }) };
        if (options.command === 'verify') return await runVerify(options, io);
        if (options.command === 'refresh') return await runRefresh(options, io);
        return await runPublish(options, io);
    } catch (error) {
        process.stderr.write(`${error && error.code ? `${error.code}: ` : ''}${error && error.message ? error.message : error}\n`);
        return 1;
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}

module.exports = { main, parseArgs, usage };
