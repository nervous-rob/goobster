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
        expect(sandbox.run).toHaveBeenCalledWith(expect.objectContaining({ language: 'python', userId: '1' }));
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

    test('run() maps a down runner to SANDBOX_UNAVAILABLE', async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'proxy-token';
        process.env.GOOBSTER_SANDBOX_URL = 'http://127.0.0.1:1';
        const service = new SandboxService({ enabled: true, timeoutMs: 1_000 });
        await expect(service.run({ language: 'python', code: 'print(1)' }))
            .rejects.toMatchObject({ status: 503, code: 'SANDBOX_UNAVAILABLE' });
        expect(SandboxError).toBeDefined();
    });
});
