/**
 * HTTP-level tests for the panel server (web/server.js + web/panelApi.js):
 * local-only Host/Origin protections and PanelError -> JSON translation.
 * Uses a real listener on an ephemeral loopback port; the panel service
 * is injected as a mock.
 */
const http = require('node:http');
const { createPanelApp } = require('@goobster/bot/web/server');
const { PanelError } = require('@goobster/core/services/panelService');

let server;
let port;

const panelService = {
    getStatus: jest.fn(() => ({ ready: true, botTag: 'Goobster#0001' })),
    getSystemHealth: jest.fn(async () => ({ cpu: { load: [0.1, 0.2, 0.3], cores: 4, temperatureC: 51.2 } })),
    listModelCatalog: jest.fn(async (provider) => ({ provider, models: [] })),
    listGuilds: jest.fn(() => [{ id: '1', name: 'Alpha' }]),
    sendMessage: jest.fn().mockResolvedValue({ messageId: 'm1', channelId: 'c1' }),
    updateGuildSettings: jest.fn(),
    setChannelExclusion: jest.fn(async () => ({ excluded: true, removedMemories: 2, purgedActivity: 1 })),
    forgetGuildMemories: jest.fn(async () => ({ removed: 9 })),
    playTrack: jest.fn()
};

function request({ method = 'GET', path = '/', headers = {}, body = null, overrideHost = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(overrideHost ? { Host: overrideHost } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON body */ }
                resolve({ status: res.statusCode, json, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

beforeAll((done) => {
    const app = createPanelApp({
        client: null,
        voiceService: null,
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { panelService }
    });
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll((done) => {
    server.close(done);
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('local-only protections', () => {
    test('serves API requests with a loopback Host', async () => {
        const res = await request({ path: '/api/status' });
        expect(res.status).toBe(200);
        expect(res.json.ready).toBe(true);
    });

    test('rejects non-local Host headers (DNS rebinding guard)', async () => {
        const res = await request({ path: '/api/status', overrideHost: 'evil.example.com' });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('FORBIDDEN');
        expect(panelService.getStatus).not.toHaveBeenCalled();
    });

    test('rejects cross-origin state-changing requests', async () => {
        const res = await request({
            method: 'POST',
            path: '/api/guilds/200000000000000001/messages',
            headers: { Origin: 'http://evil.example.com' },
            body: { channelId: '1', content: 'hi' }
        });
        expect(res.status).toBe(403);
        expect(panelService.sendMessage).not.toHaveBeenCalled();
    });

    test('allows same-origin state-changing requests', async () => {
        const res = await request({
            method: 'POST',
            path: '/api/guilds/200000000000000001/messages',
            headers: { Origin: `http://127.0.0.1:${port}` },
            body: { channelId: '300000000000000001', content: 'hi' }
        });
        expect(res.status).toBe(200);
        expect(res.json.messageId).toBe('m1');
        expect(panelService.sendMessage).toHaveBeenCalledWith({
            guildId: '200000000000000001',
            channelId: '300000000000000001',
            content: 'hi'
        });
    });
});

describe('error translation', () => {
    test('PanelError becomes a structured JSON error with its status', async () => {
        panelService.playTrack.mockRejectedValue(new PanelError(409, 'MUSIC_ACTIVE_ELSEWHERE', 'Music is playing elsewhere.', {
            requiresConfirmation: true,
            activeGuildId: '2'
        }));
        const res = await request({
            method: 'POST',
            path: '/api/music/play',
            body: { guildId: '200000000000000001', channelId: '300000000000000003', query: 'queen' }
        });
        expect(res.status).toBe(409);
        expect(res.json.error).toEqual(expect.objectContaining({
            code: 'MUSIC_ACTIVE_ELSEWHERE',
            requiresConfirmation: true,
            activeGuildId: '2'
        }));
    });

    test('a ModelPolicyError that escapes the service is a 400 with its code', async () => {
        const error = new Error('OpenAI is not configured on this host.');
        error.name = 'ModelPolicyError';
        error.code = 'PROVIDER_NOT_CONFIGURED';
        panelService.updateGuildSettings.mockRejectedValue(error);
        const res = await request({
            method: 'PATCH',
            path: '/api/guilds/200000000000000001/settings',
            body: { aiProvider: 'openai' }
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toEqual({ code: 'PROVIDER_NOT_CONFIGURED', message: 'OpenAI is not configured on this host.' });
    });

    test('unexpected errors return a sanitized 500', async () => {
        panelService.listGuilds.mockImplementation(() => { throw new Error('secret internals'); });
        const res = await request({ path: '/api/guilds' });
        expect(res.status).toBe(500);
        expect(res.json.error.code).toBe('INTERNAL');
        expect(res.raw).not.toContain('secret internals');
    });

    test('malformed JSON bodies return 400', async () => {
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: '/api/music/play',
                headers: { 'Content-Type': 'application/json' }
            }, (r) => {
                let data = '';
                r.on('data', chunk => { data += chunk; });
                r.on('end', () => resolve({ status: r.statusCode, raw: data }));
            });
            req.on('error', reject);
            req.write('{not json');
            req.end();
        });
        expect(res.status).toBe(400);
    });

    test('unknown API routes return 404 JSON', async () => {
        const res = await request({ path: '/api/definitely-not-a-route' });
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('NOT_FOUND');
    });
});

describe('async service routes', () => {
    test('host health and the model catalog are awaited and forwarded', async () => {
        const health = await request({ path: '/api/system' });
        expect(health.status).toBe(200);
        expect(health.json.cpu.temperatureC).toBe(51.2);

        const catalog = await request({ path: '/api/ai/models?provider=anthropic' });
        expect(catalog.status).toBe(200);
        expect(panelService.listModelCatalog).toHaveBeenCalledWith('anthropic');
        expect(catalog.json.provider).toBe('anthropic');
    });

    test('memory exclusion and forget-all resolve before responding', async () => {
        const excluded = await request({
            method: 'POST',
            path: '/api/guilds/200000000000000001/memory/exclusions',
            body: { channelId: '300000000000000001', exclude: true }
        });
        expect(excluded.status).toBe(200);
        expect(excluded.json).toEqual({ excluded: true, removedMemories: 2, purgedActivity: 1 });

        const forgot = await request({ method: 'POST', path: '/api/guilds/200000000000000001/memory/forget', body: {} });
        expect(forgot.status).toBe(200);
        expect(forgot.json).toEqual({ removed: 9 });
    });
});

describe('static UI', () => {
    test('serves the panel index page', async () => {
        const res = await request({ path: '/' });
        expect(res.status).toBe(200);
        expect(res.raw).toContain('Goobster Control Panel');
    });
});
