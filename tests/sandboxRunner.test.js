/**
 * Sandbox-runner HTTP layer (apps/sandbox/server.js, Phase 5d) and the
 * sandboxService remote-proxy path.
 */
const express = require('express');
const { createSandboxApp } = require('../apps/sandbox/server');
const { SandboxService, SandboxError } = require('@goobster/core/services/sandboxService');

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
    return fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

describe('createSandboxApp', () => {
    const sandbox = {
        enabled: true,
        run: jest.fn(async ({ language, code }) => ({
            ok: true, language, stdout: code, files: []
        }))
    };

    let server;
    let url;
    const prevToken = process.env.GOOBSTER_INTERNAL_TOKEN;

    beforeAll(async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'sandbox-test-token';
        ({ server, url } = await listen(createSandboxApp({ sandbox })));
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        if (prevToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
        else process.env.GOOBSTER_INTERNAL_TOKEN = prevToken;
    });

    test('health does not require the internal token', async () => {
        const res = await request(`${url}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'healthy', service: 'sandbox' });
    });

    test('POST /run rejects a missing token', async () => {
        const res = await request(`${url}/run`, { method: 'POST', body: { language: 'python', code: 'print(1)' } });
        expect(res.status).toBe(401);
    });

    test('POST /run proxies a successful run', async () => {
        const res = await request(`${url}/run`, {
            method: 'POST',
            headers: { 'x-goobster-internal-token': 'sandbox-test-token' },
            body: { language: 'python', code: 'print(1)', userId: '1' }
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, language: 'python', stdout: 'print(1)' });
        expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({
            language: 'python', userId: '1', signal: expect.any(AbortSignal)
        }));
    });

    test('POST /cancel aborts the in-flight run and /run acknowledges the stop', async () => {
        const live = {
            enabled: true,
            run: jest.fn(({ signal }) => new Promise((resolve) => {
                const done = () => resolve({
                    ok: false, aborted: true, stdout: '', stderr: '', files: []
                });
                if (signal?.aborted) {
                    done();
                    return;
                }
                signal?.addEventListener('abort', done, { once: true });
            }))
        };
        const listening = await listen(createSandboxApp({ sandbox: live }));
        try {
            const pending = request(`${listening.url}/run`, {
                method: 'POST',
                headers: { 'x-goobster-internal-token': 'sandbox-test-token' },
                body: { language: 'python', code: 'print(1)', runId: 'run-cancel-1' }
            });
            await new Promise(resolve => setTimeout(resolve, 80));
            const cancelRes = await request(`${listening.url}/cancel`, {
                method: 'POST',
                headers: { 'x-goobster-internal-token': 'sandbox-test-token' },
                body: { runId: 'run-cancel-1' }
            });
            expect(cancelRes.status).toBe(200);
            expect(await cancelRes.json()).toEqual({ ok: true, found: true });
            const runRes = await pending;
            expect(runRes.status).toBe(200);
            expect(await runRes.json()).toMatchObject({ aborted: true, runId: 'run-cancel-1' });
        } finally {
            await new Promise(resolve => listening.server.close(resolve));
        }
    });
});

describe('sandboxService remote proxy', () => {
    const prevUrl = process.env.GOOBSTER_SANDBOX_URL;
    const prevToken = process.env.GOOBSTER_INTERNAL_TOKEN;
    let server;

    afterEach(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        server = null;
        if (prevUrl === undefined) delete process.env.GOOBSTER_SANDBOX_URL;
        else process.env.GOOBSTER_SANDBOX_URL = prevUrl;
        if (prevToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
        else process.env.GOOBSTER_INTERNAL_TOKEN = prevToken;
    });

    test('run() POSTs to GOOBSTER_SANDBOX_URL and returns the runner payload', async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'proxy-token';
        const app = express();
        app.use(express.json());
        app.post('/run', (req, res) => {
            expect(req.headers['x-goobster-internal-token']).toBe('proxy-token');
            res.json({ ok: true, stdout: 'from-runner', language: req.body.language, files: [] });
        });
        const listening = await listen(app);
        server = listening.server;
        process.env.GOOBSTER_SANDBOX_URL = listening.url;

        const service = new SandboxService({ enabled: true, timeoutMs: 5_000 });
        const result = await service.run({ language: 'python', code: 'print(1)', userId: 'u' });
        expect(result).toMatchObject({ ok: true, stdout: 'from-runner', language: 'python' });
    });

    test('aborting a remote run POSTs /cancel and waits for the runner ack', async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'proxy-token';
        let runResolve;
        const runGate = new Promise((resolve) => { runResolve = resolve; });
        let cancelled = false;
        const app = express();
        app.use(express.json());
        app.post('/run', async (req, res) => {
            await runGate;
            res.json({ ok: false, aborted: cancelled, runId: req.body.runId, files: [] });
        });
        app.post('/cancel', (req, res) => {
            cancelled = true;
            runResolve();
            res.json({ ok: true, found: true });
        });
        const listening = await listen(app);
        server = listening.server;
        process.env.GOOBSTER_SANDBOX_URL = listening.url;

        const service = new SandboxService({ enabled: true, timeoutMs: 5_000 });
        const ac = new AbortController();
        const pending = service.run({ language: 'python', code: 'print(1)', signal: ac.signal });
        await new Promise(resolve => setTimeout(resolve, 50));
        ac.abort();
        await expect(pending).resolves.toMatchObject({ aborted: true });
    });

    test('run() maps a down runner to SANDBOX_UNAVAILABLE', async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'proxy-token';
        process.env.GOOBSTER_SANDBOX_URL = 'http://127.0.0.1:1';
        const service = new SandboxService({ enabled: true, timeoutMs: 1_000 });
        await expect(service.run({ language: 'python', code: 'print(1)' }))
            .rejects.toMatchObject({ status: 503, code: 'SANDBOX_UNAVAILABLE' });
        expect(SandboxError).toBeDefined();
    });
});

describe('HTTP runner stops a real child before acknowledging cancel', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const prevToken = process.env.GOOBSTER_INTERNAL_TOKEN;
    const prevUrl = process.env.GOOBSTER_SANDBOX_URL;
    let server;
    let url;
    let projectDir;
    let runsDir;

    beforeAll(async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'real-runner-token';
        delete process.env.GOOBSTER_SANDBOX_URL;
        runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-http-runs-'));
        projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-http-proj-'));
        const sandbox = new SandboxService({
            enabled: true,
            requireStrongIsolation: false,
            forceLocal: true,
            timeoutMs: 15_000,
            maxCpuSeconds: 15,
            maxMemoryMb: 512,
            maxWriteMb: 16,
            maxOutputBytes: 64 * 1024,
            maxOutputFiles: 4,
            runsPerWindow: 100,
            maxConcurrent: 4,
            allowNetwork: false,
            pythonCommand: 'python3',
            extraBinds: [],
            runsDir
        });
        ({ server, url } = await listen(createSandboxApp({ sandbox })));
    });

    afterAll(async () => {
        if (prevUrl === undefined) delete process.env.GOOBSTER_SANDBOX_URL;
        else process.env.GOOBSTER_SANDBOX_URL = prevUrl;
        if (prevToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
        else process.env.GOOBSTER_INTERNAL_TOKEN = prevToken;
        if (server) await new Promise(resolve => server.close(resolve));
        try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('POST /cancel stops writes; a second /run starts only after ack', async () => {
        const out = path.join(projectDir, 'out.txt');
        const pending = request(`${url}/run`, {
            method: 'POST',
            headers: { 'x-goobster-internal-token': 'real-runner-token' },
            body: {
                language: 'bash',
                runId: 'real-1',
                projectDir,
                code: 'while true; do echo tick >> "$GOOBSTER_PROJECT_DIR/out.txt"; sleep 0.15; done'
            }
        });
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(out) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!fs.existsSync(out)) {
            const early = await pending;
            throw new Error(`run never wrote ${out}: ${early.status} ${await early.text()}`);
        }
        const cancelRes = await request(`${url}/cancel`, {
            method: 'POST',
            headers: { 'x-goobster-internal-token': 'real-runner-token' },
            body: { runId: 'real-1' }
        });
        expect(cancelRes.status).toBe(200);
        expect(await cancelRes.json()).toEqual({ ok: true, found: true });
        const runRes = await pending;
        expect(runRes.status).toBe(200);
        expect(await runRes.json()).toMatchObject({ aborted: true });
        const size = fs.statSync(out).size;
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(fs.statSync(out).size).toBe(size);

        const second = await request(`${url}/run`, {
            method: 'POST',
            headers: { 'x-goobster-internal-token': 'real-runner-token' },
            body: {
                language: 'bash',
                projectDir,
                code: 'echo second >> "$GOOBSTER_PROJECT_DIR/out.txt"; echo ok'
            }
        });
        expect(second.status).toBe(200);
        expect((await second.json()).ok).toBe(true);
    }, 20_000);
});
