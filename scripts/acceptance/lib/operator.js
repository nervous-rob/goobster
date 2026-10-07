'use strict';

/**
 * What an operator has on a host: the manager's command line, the manager as a long-running process,
 * and the manager's documented loopback HTTP API. Nothing here requires a module of the manager or of
 * the application; the driver reaches the installation only through these three doors.
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const PASS_THROUGH = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 60_000, intervalMs = 250, what = 'the condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
        await sleep(intervalMs);
    }
}

/** The one JSON document the CLI prints with --json; the database layer may print lines before it. */
function extractJson(text) {
    const lines = String(text).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index] !== '{') continue;
        const body = lines.slice(index).join('\n').trim();
        try {
            return JSON.parse(body);
        } catch { /* a stray brace line; keep looking */ }
    }
    return null;
}

function baseEnv(extra = {}) {
    const env = {};
    for (const key of PASS_THROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
    return { ...env, ...extra };
}

/** Is something listening on 127.0.0.1:port? */
function portInUse(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
    });
}

/** Occupy a loopback port for the duration of a check. */
function occupyPort(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => socket.destroy());
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({ close: () => new Promise((done) => server.close(done)) }));
    });
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

/**
 * @param {string} launcher  the goobster-manager launcher of a payload or of an installed release
 * @param {string[]} args
 * @param {Object} options
 * @param {Object} options.env
 * @param {number} [options.timeoutMs]
 * @param {string} [options.input] written to stdin
 */
function runLauncher(launcher, args, { env, timeoutMs = 300_000, input = '' } = {}) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = childProcess.spawn(launcher, args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WINDOWS && /\.cmd$/i.test(launcher), windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* gone */ }
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => { stderr += `\nspawn failed: ${error.code || error.message}`; });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code: timedOut ? null : code, signal, timedOut, stdout, stderr, durationMs: Date.now() - started, pid: child.pid });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

/** A spawned CLI whose process the caller may signal before it ends. */
function startLauncher(launcher, args, { env }) {
    const started = Date.now();
    const child = childProcess.spawn(launcher, args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: IS_WINDOWS && /\.cmd$/i.test(launcher), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end('');
    const done = new Promise((resolve) => {
        child.on('error', (error) => { stderr += `\nspawn failed: ${error.code || error.message}`; });
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started, pid: child.pid }));
    });
    return { child, pid: child.pid, done, output: () => ({ stdout, stderr }) };
}

/**
 * The manager as a process: started the way a service unit would start it, restarted when it leaves
 * with the handoff exit code (76) because the operating system's supervisor would do that, and stopped
 * or killed by the process id this object owns.
 */
class Daemon {
    constructor({ launcher, env, logFile, onEvent = () => {}, restartOnHandoff = true }) {
        this.launcher = launcher;
        this.env = env;
        this.logFile = logFile;
        this.onEvent = onEvent;
        this.restartOnHandoff = restartOnHandoff;
        this.child = null;
        this.pid = null;
        this.exits = [];
        this.tail = [];
        this.stopping = false;
        this.handoffs = 0;
    }

    _spawn() {
        const out = fs.openSync(this.logFile, 'a');
        const child = childProcess.spawn(this.launcher, ['--supervise'], {
            env: this.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: IS_WINDOWS && /\.cmd$/i.test(this.launcher),
            windowsHide: true
        });
        const keep = (chunk) => {
            fs.writeSync(out, chunk);
            for (const line of String(chunk).split(/\r?\n/)) {
                if (!line) continue;
                this.tail.push(line);
                if (this.tail.length > 400) this.tail.shift();
            }
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', (error) => this.tail.push(`spawn failed: ${error.code || error.message}`));
        child.on('close', (code, signal) => {
            try { fs.closeSync(out); } catch { /* closed */ }
            this.exits.push({ pid: child.pid, code, signal, at: Date.now() });
            this.onEvent({ type: 'exit', pid: child.pid, code, signal });
            if (this.child === child) {
                this.child = null;
                this.pid = null;
            }
            if (!this.stopping && code === 76 && this.restartOnHandoff) {
                this.handoffs += 1;
                this.onEvent({ type: 'handoff-restart' });
                this._spawn();
            }
        });
        this.child = child;
        this.pid = child.pid;
        this.onEvent({ type: 'start', pid: child.pid });
    }

    start() {
        if (this.child) throw new Error('the manager process is already running');
        this.stopping = false;
        this._spawn();
        return this.pid;
    }

    running() {
        return Boolean(this.child) && alive(this.child.pid);
    }

    /** The process, ended by the signal and awaited. */
    async signal(signal, { timeoutMs = 60_000 } = {}) {
        const child = this.child;
        if (!child) return null;
        this.stopping = true;
        const closed = new Promise((resolve) => child.once('close', resolve));
        try { child.kill(signal); } catch { /* already gone */ }
        const outcome = await Promise.race([closed.then(() => 'closed'), sleep(timeoutMs).then(() => 'late')]);
        if (outcome === 'late') {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
            await Promise.race([closed, sleep(10_000)]);
        }
        return this.exits[this.exits.length - 1] || null;
    }

    stop() {
        return this.signal(IS_WINDOWS ? 'SIGKILL' : 'SIGTERM');
    }

    kill() {
        return this.signal('SIGKILL');
    }

    /** Leave the process to its own exit handling (the handoff restart stays on). */
    release() {
        this.stopping = false;
    }
}

/**
 * The manager's loopback HTTP API as the wizard, `curl` and the CLI use it: a recovery session from a
 * credential minted on this machine, a single-use nonce on every mutation.
 */
class ManagerApi {
    constructor({ port, mint, redactor }) {
        this.port = port;
        this.mint = mint;
        this.redactor = redactor;
        this.token = null;
    }

    url(route) {
        return `http://127.0.0.1:${this.port}/manager/api${route}`;
    }

    async raw(method, route, { body, headers = {}, auth = true, nonce = method !== 'GET' } = {}) {
        const response = await fetch(this.url(route), {
            method,
            headers: {
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
                ...(nonce ? { 'x-goobster-nonce': crypto.randomBytes(18).toString('base64url') } : {}),
                ...headers
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(120_000)
        });
        let json = null;
        try { json = await response.json(); } catch { /* no body */ }
        return { status: response.status, json, headers: response.headers };
    }

    async unlock() {
        const credential = await this.mint();
        this.redactor.secret(credential);
        const unlocked = await this.raw('POST', '/recovery/unlock', { body: { credential }, auth: false });
        if (unlocked.status !== 200 || !unlocked.json || !unlocked.json.session) throw new Error(`recovery unlock answered ${unlocked.status}${unlocked.json && unlocked.json.error ? ` ${unlocked.json.error.code}` : ''}`);
        this.token = unlocked.json.session.token;
        this.redactor.secret(this.token);
        return this.token;
    }

    async call(method, route, body) {
        if (!this.token) await this.unlock();
        let answer = await this.raw(method, route, { body });
        if (answer.status === 401) {
            await this.unlock();
            answer = await this.raw(method, route, { body });
        }
        return answer;
    }

    /** plan, validate, apply one operation kind; throws with the manager's code when it refuses. */
    async operation(kind, input) {
        const planned = await this.call('POST', '/operations', { kind, input });
        if (planned.status !== 200) throw new Error(`${kind} plan refused: ${planned.status} ${planned.json && planned.json.error ? planned.json.error.code : ''}`.trim());
        const id = planned.json.operation.id;
        const validated = await this.call('POST', `/operations/${id}/validate`, {});
        if (validated.status !== 200) throw new Error(`${kind} validate refused: ${validated.status} ${validated.json && validated.json.error ? validated.json.error.code : ''}`.trim());
        const applied = await this.call('POST', `/operations/${id}/apply`, { revision: validated.json.operation.revision });
        if (applied.status !== 200) throw new Error(`${kind} apply refused: ${applied.status} ${applied.json && applied.json.error ? applied.json.error.code : ''}`.trim());
        return { id, operation: applied.json.operation, result: applied.json.result || null };
    }
}

function tempWorkDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `goobster-acceptance-${label}-`));
}

module.exports = {
    IS_WINDOWS,
    sleep,
    waitFor,
    extractJson,
    baseEnv,
    portInUse,
    occupyPort,
    alive,
    runLauncher,
    startLauncher,
    Daemon,
    ManagerApi,
    tempWorkDir
};
