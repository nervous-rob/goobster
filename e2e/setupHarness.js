/**
 * The setup wizard's end-to-end harness (documentation/setup_wizard.md).
 *
 * One throwaway installation per call, entirely under a directory in the OS
 * temp folder: a code root that links the repository's apps and packages (so
 * the standalone `api` worker the manager starts is the real one), a
 * synthetic release payload for the installer to copy, the manager started
 * in-process through its real `main()` on a free port with its one-time
 * setup credential, and a fake Ollama server standing in for the AI provider
 * (the e2e portal has no other fake provider). Nothing here touches the
 * repository, the user's home directory or any real configuration.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { main } = require('../apps/manager/index.js');
const { makeRelease, freePort } = require('../tests/helpers/installFixture');

const REPLY = 'Hello from the fake model. The new installation answers.';

/** A stand-in for Ollama: /api/tags lists one model; /api/chat answers a fixed sentence, streamed or not. */
async function startFakeOllama({ port }) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push(`${req.method} ${req.url}`);
            if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }] }));
                return;
            }
            if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* ignore */ }
                const done = { model: 'llama3.2:3b', done: true, prompt_eval_count: 4, eval_count: 9 };
                if (parsed.stream) {
                    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                    for (const word of REPLY.split(/(?<= )/)) res.write(`${JSON.stringify({ model: 'llama3.2:3b', message: { role: 'assistant', content: word }, done: false })}\n`);
                    res.end(`${JSON.stringify({ ...done, message: { role: 'assistant', content: '' } })}\n`);
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ...done, message: { role: 'assistant', content: REPLY } }));
                }
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"error":"not found"}');
        });
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function waitFor(check, { timeout = 60_000, interval = 250, what = 'the condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

const lines = [];
const recording = {
    info: (...args) => lines.push(`info ${args.join(' ')}`),
    warn: (...args) => lines.push(`warn ${args.join(' ')}`),
    error: (...args) => lines.push(`error ${args.join(' ')}`)
};
const silent = { info() {}, warn() {}, error() {} };
const sink = { write() {}, isTTY: false };

/**
 * @param {Object} [options]
 * @param {boolean} [options.claim]   claim with the bootstrap credential before returning (the installation is "claimed" and empty)
 * @param {Object}  [options.installDeps] overrides for the install engine seams (a preflight probe, a failing database init, ...)
 * @param {Object}  [options.nativeDeps] overrides for the native Postgres seams (distribution facts, a transient data folder, ...)
 */
async function createSetupInstallation(options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-setup-e2e-'));
    const code = path.join(dir, 'app');
    const data = path.join(dir, 'data');
    const sourceParent = path.join(dir, 'sources');
    fs.mkdirSync(code, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(sourceParent, { recursive: true });
    // The workers the manager starts run from here: the real api, the real core.
    for (const name of ['apps', 'packages', 'node_modules', 'package.json']) {
        fs.symlinkSync(path.join(ROOT, name), path.join(code, name));
    }
    const release = makeRelease(sourceParent);
    const managerPort = await freePort();
    const apiPort = await freePort();
    const botPort = await freePort();
    const ollama = await startFakeOllama({ port: await freePort() });

    const env = {
        PATH: process.env.PATH,
        HOME: dir,
        NODE_ENV: 'test',
        GOOBSTER_WORKSPACE_ROOT: code,
        GOOBSTER_DATA_DIR: data,
        GOOBSTER_DB_PATH: path.join(data, 'goobster.sqlite'),
        GOOBSTER_CONFIG_PATH: path.join(data, 'config.json'),
        GOOBSTER_MANAGER_PORT: String(managerPort),
        GOOBSTER_MANAGER_HOST: '127.0.0.1',
        GOOBSTER_MANAGER_RECONCILE: '0',
        GOOBSTER_API_PORT: String(apiPort),
        PORT: String(botPort),
        GOOBSTER_RUNTIME_MODE: 'standalone',
        // The worker reads identity and AI settings from the repository's own config.json location, which a
        // throwaway installation must not write; the environment is the one input it shares with the manager.
        GOOBSTER_IDENTITY_NATIVE_LOGIN: '1',
        OLLAMA_HOST: ollama.url,
        OLLAMA_MODEL: 'llama3.2:3b',
        GOOBSTER_LIFECYCLE_DRAIN_SECONDS: '2',
        ...(options.env || {})
    };
    const installDeps = {
        home: dir,
        sourceCandidates: [release.dir],
        readCrontab: () => null,
        writeCrontab: () => {},
        ...(options.installDeps || {})
    };

    // The payload stage reads this from the process the manager runs in; the synthetic release is unsigned.
    const previousUnsigned = process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED;
    process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED = '1';

    let running = null;
    const url = `http://127.0.0.1:${managerPort}`;
    const portal = `http://127.0.0.1:${apiPort}`;
    const credentialFile = path.join(data, 'manager', 'bootstrap-credential');

    async function start() {
        running = await main([], { env, stdout: sink, logger: recording, installDeps, ...(options.nativeDeps ? { nativeDeps: options.nativeDeps } : {}) });
        if (!running.server) throw new Error(`the manager did not start (code ${running.code})`);
        await waitFor(async () => (await fetch(`${url}/manager/api/status`)).status === 200, { what: 'the manager to listen' });
        return running;
    }

    async function stop() {
        if (!running) return;
        const current = running;
        running = null;
        const pids = () => (current.supervisor ? current.supervisor.summary().workers.map((worker) => worker.pid).filter(Boolean) : []);
        const known = pids();
        const stopped = current.stop();
        const timer = new Promise((resolve) => setTimeout(resolve, 25_000, 'late'));
        if (await Promise.race([stopped.then(() => 'stopped'), timer]) === 'late') {
            // A worker that is still starting ignores the stop for a long while; end it by its process id.
            for (const pid of [...known, ...pids()]) {
                try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
            }
            await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 10_000))]);
        }
    }

    async function restart() {
        await stop();
        return start();
    }

    /** The one-time setup credential the manager wrote for this machine. */
    function setupCredential() {
        return fs.readFileSync(credentialFile, 'utf8').trim();
    }

    /** A new recovery credential, minted the way the documented command mints it. */
    async function mintRecovery() {
        let printed = '';
        const out = { write: (text) => { printed += text; }, isTTY: false };
        const outcome = await main(['--mint-recovery'], { env, stdout: out, logger: silent });
        if (outcome.code !== 0) throw new Error('could not mint a recovery credential');
        const match = /Recovery credential: (\S+)/.exec(printed);
        if (!match) throw new Error('no recovery credential was printed');
        return match[1];
    }

    /** A new setup credential: the documented command replaces the one before it. */
    async function mintBootstrap() {
        let printed = '';
        const out = { write: (text) => { printed += text; }, isTTY: false };
        const outcome = await main(['--mint-bootstrap'], { env, stdout: out, logger: silent });
        if (outcome.code !== 0) throw new Error('could not mint a setup credential');
        const match = /Setup credential: (\S+)/.exec(printed);
        if (!match) throw new Error('no setup credential was printed');
        return match[1];
    }

    async function claim(label = 'E2E host') {
        const response = await fetch(`${url}/manager/api/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential: setupCredential(), label })
        });
        if (response.status !== 200) throw new Error(`claim failed: ${response.status}`);
    }

    /**
     * Claim and install through the manager's own HTTP API, the way the wizard does, so a maintenance journey
     * starts from a real installation. Returns the session cookie for the browser, and a small client.
     */
    async function provision({ features = [], owner = true, start = false } = {}) {
        const claimed = await fetch(`${url}/manager/api/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential: setupCredential(), label: 'E2E host' })
        });
        if (claimed.status !== 200) throw new Error(`claim failed: ${claimed.status}`);
        const cookie = claimed.headers.get('set-cookie').split(';')[0];
        const call = async (method, route, body) => {
            const response = await fetch(`${url}/manager/api${route}`, {
                method,
                headers: { 'content-type': 'application/json', cookie, 'x-goobster-nonce': crypto.randomBytes(32).toString('base64url') },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            return { status: response.status, json: await response.json().catch(() => null) };
        };
        const run = async (kind, input) => {
            const planned = await call('POST', '/operations', { kind, input });
            if (planned.status !== 200) throw new Error(`${kind} plan failed: ${JSON.stringify(planned.json)}`);
            const id = planned.json.operation.id;
            const validated = await call('POST', `/operations/${id}/validate`, {});
            if (validated.status !== 200) throw new Error(`${kind} validate failed: ${JSON.stringify(validated.json)}`);
            const applied = await call('POST', `/operations/${id}/apply`, { revision: validated.json.operation.revision });
            if (applied.status !== 200) throw new Error(`${kind} apply failed: ${JSON.stringify(applied.json)}`);
            return applied.json;
        };
        await run('install.new', {
            source: release.dir, features, layout: 'standalone', roots: { code }, database: { engine: 'sqlite' },
            config: [{ id: 'webapp.enabled', value: true }], registerService: false
        });
        if (owner) await run('owner.create', { loginName: 'owner-one', password: 'plain-walnut-ladder-kettle-7' });
        if (start) {
            await run('lifecycle.start', undefined);
            await waitFor(async () => {
                const lifecycle = await call('GET', '/lifecycle');
                return lifecycle.json.workers.length > 0 && lifecycle.json.workers.every((worker) => worker.healthy === true);
            }, { what: 'the api worker to answer' });
        }
        const [name, value] = cookie.split('=');
        return { cookie, session: { name, value }, call, run };
    }

    async function destroy() {
        await stop().catch(() => {});
        await ollama.close().catch(() => {});
        if (previousUnsigned === undefined) delete process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED;
        else process.env.GOOBSTER_PAYLOAD_DEV_UNSIGNED = previousUnsigned;
        fs.rmSync(dir, { recursive: true, force: true });
    }

    await start();
    if (options.claim) await claim();

    return {
        dir, code, data, release, url, portal, ollama, env,
        managerPort, apiPort,
        get manager() { return running ? running.manager : null; },
        get supervisor() { return running ? running.supervisor : null; },
        get log() { return lines.join('\n'); },
        setupCredential, mintBootstrap, mintRecovery, claim, provision, start, stop, restart, destroy
    };
}

module.exports = { createSetupInstallation, startFakeOllama, waitFor, REPLY };
