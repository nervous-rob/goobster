/**
 * The manager's side of the privileged protocol: decide whether the helper
 * can run at all, start it elevated with the one JSON request on stdin, and
 * turn its one JSON reply into a result the setup engine records.
 *
 * Results (never thrown, except for an input the shape rules refuse):
 *   { status: 'done', outcome, detail, log }
 *   { status: 'fallback', reason, manual? }   the service manager is absent or offline, no
 *                                             elevation is available, or the operator declined
 *                                             it: the install completes, the step is skipped
 *   { status: 'failed', code, message, log }  the helper refused or failed; the step fails
 *
 * Before an elevated start the manager hashes the helper's own files and the
 * bundled Node against the payload's release manifest, so a root process
 * never runs code the manifest does not vouch for. From a source checkout
 * (no manifest beside the code) that check does not apply and is reported.
 *
 * The platform module (`./linux.js`, and its siblings for the other platforms)
 * supplies what differs per platform: `elevation()` (how to start the helper
 * with rights: `{ kind, prefix, reason? }`, `kind` 'root' when already there,
 * 'none' when there is no way), `manualCommand()`, `serviceFacts()` (is the
 * service manager there and running), `HELPER_FILES` (the files the elevated
 * process runs, for the manifest check), and optionally `transport()` (when
 * the elevation tool cannot pass stdin/stdout: the request and the reply go
 * through files under the request directory; `helper.js --request <file>
 * --reply <file>` reads and writes them) and `refusal()` (how that tool says
 * the operator declined). The defaults below are the Linux ones.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const protocol = require('./protocol');

const HELPER_FILES = Object.freeze([
    'app/apps/manager/privileged/helper.js',
    'app/apps/manager/privileged/protocol.js',
    'app/apps/manager/privileged/linux.js',
    'app/apps/manager/platform/systemdUnit.js'
]);

/** The service-manager facts a platform module reports before `service.register` is attempted. */
function serviceFactsOf(implementation, { fs, env }) {
    if (typeof implementation.serviceFacts === 'function') return implementation.serviceFacts({ fs, env });
    if (typeof implementation.systemdFacts === 'function') return implementation.systemdFacts({ fs, env });
    return { available: true };
}
const HELPER_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 256 * 1024;

function sha256File(file, fs = nodeFs) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

/**
 * @param {Object} params
 * @param {string[]} [params.files]  the helper's files, payload-relative (the platform module's HELPER_FILES)
 * @returns {{ checked: boolean, ok: boolean, reason?: string, files?: number }}
 */
function verifyHelperFiles({ payloadRoot, nodePath, fs = nodeFs, files = HELPER_FILES }) {
    const manifestFile = path.join(payloadRoot, 'payload-manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch {
        return { checked: false, ok: true, reason: 'NO_MANIFEST' };
    }
    const byPath = new Map((manifest.files || []).map(entry => [entry.path, entry.sha256]));
    const wanted = [...files];
    const runtimeRel = path.relative(payloadRoot, nodePath).split(path.sep).join('/');
    if (!runtimeRel.startsWith('..') && byPath.has(runtimeRel)) wanted.push(runtimeRel);
    for (const rel of wanted) {
        const expected = byPath.get(rel);
        if (!expected) return { checked: true, ok: false, reason: 'NOT_IN_MANIFEST' };
        let actual;
        try {
            actual = sha256File(path.join(payloadRoot, ...rel.split('/')), fs);
        } catch {
            return { checked: true, ok: false, reason: 'UNREADABLE' };
        }
        if (actual !== expected) return { checked: true, ok: false, reason: 'HASH_MISMATCH' };
    }
    return { checked: true, ok: true, files: wanted.length };
}

/** Keep a helper's output to words and the paths the request named. */
function scrubLines(lines, allowedPaths) {
    const allowed = new Set(allowedPaths);
    return (lines || []).slice(0, 40).map((line) => {
        const words = String(line).split(/(\s+)/).map((word) => {
            if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) return '<value>';
            if (word.startsWith('/') && word.length > 1 && !allowed.has(word)) return '<path>';
            return word;
        });
        return words.join('').slice(0, 200);
    });
}

function collect(stream, limit) {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
        if (size < limit) chunks.push(chunk);
        size += chunk.length;
    });
    return () => Buffer.concat(chunks).toString('utf8');
}

function spawnHelper({ argv, request, spawn = childProcess.spawn, timeoutMs = HELPER_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } });
        } catch (error) {
            resolve({ spawnError: error && error.code ? error.code : 'EXEC', status: null, stdout: '', stderr: '' });
            return;
        }
        const out = collect(child.stdout, MAX_OUTPUT);
        const err = collect(child.stderr, MAX_OUTPUT);
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            resolve({ spawnError: error && error.code ? error.code : 'EXEC', status: null, stdout: out(), stderr: err() });
        });
        child.once('close', (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, stdout: out(), stderr: err() });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(request);
    });
}

function allowedPathsOf(input) {
    const out = [];
    const visit = (value) => {
        if (typeof value === 'string' && value.startsWith('/')) out.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(input);
    return out;
}

/**
 * @param {Object} params
 * @param {string} params.operation
 * @param {Object} params.input        validated here (a refusal throws a HelperError)
 * @param {Object} params.implementation  the platform module (./linux.js)
 * @param {string} [params.requestDir] where the by-hand request file goes
 */
async function runHelper({ operation, input, implementation, env = process.env, fs = nodeFs, nodePath = process.execPath, helperPath = path.join(__dirname, 'helper.js'), requestDir = null, spawn, elevation = null, facts = null, timeoutMs }) {
    const checked = protocol.validateInput(operation, input);
    if (operation === 'service.register') {
        const state = facts || serviceFactsOf(implementation, { fs, env });
        if (!state.available) return { status: 'fallback', reason: state.reason || 'SERVICE_MANAGER_UNAVAILABLE', detail: { serviceManager: state.state || null, systemd: state.state || null } };
    }
    const plan = elevation || implementation.elevation({ env, fs });
    const request = protocol.buildRequest(operation, checked);
    if (plan.kind === 'none') {
        let manual = null;
        if (requestDir) {
            try {
                fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
                const requestFile = path.join(requestDir, `${operation}.request.json`);
                fs.writeFileSync(requestFile, `${request}\n`, { mode: 0o600 });
                manual = implementation.manualCommand({ nodePath, helperPath, requestFile });
            } catch { }
        }
        return { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE', detail: { why: plan.reason || null }, manual };
    }
    if (plan.kind !== 'root') {
        const payloadRoot = path.resolve(__dirname, '..', '..', '..', '..');
        const verdict = verifyHelperFiles({ payloadRoot, nodePath, fs, files: Array.isArray(implementation.HELPER_FILES) ? implementation.HELPER_FILES : HELPER_FILES });
        if (!verdict.ok) return { status: 'failed', code: 'HELPER_UNVERIFIED', message: 'The helper or the runtime does not match the release manifest; it was not started.', log: [] };
    }
    // The transport: stdin/stdout by default; a platform whose elevation cannot pass a pipe
    // (UAC, an administrator prompt) supplies `transport()` and carries the request and the
    // reply in files under the request directory instead.
    const result = typeof implementation.transport === 'function'
        ? await implementation.transport({ plan, request, nodePath, helperPath, requestDir, spawn, fs, env, timeoutMs: timeoutMs || HELPER_TIMEOUT_MS })
        : await spawnHelper({ argv: [...plan.prefix, nodePath, helperPath], request, spawn, timeoutMs });
    const reply = protocol.parseReply(result.stdout, operation);
    const allowed = allowedPathsOf(checked);
    if (reply && reply.ok) {
        return { status: 'done', outcome: reply.outcome, detail: reply.detail, log: scrubLines(reply.log, allowed), via: plan.kind };
    }
    if (reply) {
        return { status: 'failed', code: reply.code, message: scrubLines([reply.message], allowed)[0], log: scrubLines(reply.log, allowed), via: plan.kind };
    }
    if (result.spawnError) return { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE', detail: { why: result.spawnError } };
    if (typeof implementation.refusal === 'function') {
        // The platform reads its own elevation tool's way of saying no (a dismissed prompt, a policy).
        const refused = implementation.refusal({ plan, status: result.status, stderr: result.stderr || '' });
        if (refused) return { status: 'fallback', reason: refused.reason || 'ELEVATION_REFUSED', detail: { via: plan.kind, ...(refused.detail || {}) } };
    } else if (plan.kind === 'sudo' || plan.kind === 'pkexec') {
        const refused = plan.kind === 'pkexec' ? [126, 127].includes(result.status) : /password is required|not allowed|may not run|no tty present/i.test(result.stderr);
        if (refused) return { status: 'fallback', reason: 'ELEVATION_REFUSED', detail: { via: plan.kind } };
    }
    return { status: 'failed', code: 'HELPER_PROTOCOL', message: `The helper ended with status ${result.status === null ? 'signal' : result.status} and no reply.`, log: [], via: plan.kind };
}

module.exports = { HELPER_FILES, verifyHelperFiles, serviceFactsOf, scrubLines, spawnHelper, runHelper, sha256File };
