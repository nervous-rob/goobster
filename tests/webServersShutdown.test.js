/**
 * Regression: systemd SIGTERM (install-rpi.sh --service) called
 * webServers.close() on the Promise returned by async startWebServers,
 * which is not a function. closeWebServers() awaits that Promise first.
 */
const http = require('node:http');
const { startWebServers, closeWebServers } = require('@goobster/bot/web/server');

const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

const savedEnv = {
    PORT: process.env.PORT,
    GOOBSTER_PANEL_PORT: process.env.GOOBSTER_PANEL_PORT
};

function restoreEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

function whenListening(server) {
    if (!server) return Promise.resolve();
    if (server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
}

function get(port, path = '/health') {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', reject);
    });
}

function expectRefused(port) {
    return expect(get(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
}

beforeEach(() => {
    process.env.PORT = '0';
    process.env.GOOBSTER_PANEL_PORT = '0';
});

afterEach(restoreEnv);

describe('startWebServers shutdown handle', () => {
    test('the raw return value has no close — that was the SIGTERM TypeError', async () => {
        const started = startWebServers({
            client: {},
            voiceService: {},
            config: { panel: { enabled: true } },
            logger: silentLogger
        });
        try {
            expect(typeof started.then).toBe('function');
            expect(started.close).toBeUndefined();
            expect(() => started.close()).toThrow(TypeError);
            expect(() => started.close()).toThrow(/is not a function/);
        } finally {
            await closeWebServers(started);
        }
    });

    test('closeWebServers awaits the start Promise and unbinds both listeners', async () => {
        const started = startWebServers({
            client: {},
            voiceService: {},
            config: { panel: { enabled: true } },
            logger: silentLogger
        });

        const handles = await started;
        await whenListening(handles.healthServer);
        await whenListening(handles.panelServer);

        const healthPort = handles.healthServer.address().port;
        const panelPort = handles.panelServer.address().port;
        expect(healthPort).toBeGreaterThan(0);
        expect(panelPort).toBeGreaterThan(0);

        const health = await get(healthPort, '/health');
        expect(health.status).toBe(200);
        expect(JSON.parse(health.data).status).toBe('healthy');

        await closeWebServers(started);

        await expectRefused(healthPort);
        await expectRefused(panelPort);
    });

    test('closeWebServers is a no-op when startup never completed', async () => {
        await expect(closeWebServers(null)).resolves.toBeUndefined();
        await expect(closeWebServers(Promise.reject(new Error('bind failed')))).resolves.toBeUndefined();
        await expect(closeWebServers(Promise.resolve({}))).resolves.toBeUndefined();
    });
});
