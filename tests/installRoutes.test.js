/**
 * The install routes and the operation kinds the setup wizard drives over
 * HTTP (#330): GET /install/suggest, /install/source, /install/record and
 * /install/first-run (session or assertion only; sanitised), the
 * `owner.create` kind (first operator through the existing native sign-in
 * path, nothing secret journaled), and `lifecycle.start` / `lifecycle.stop`
 * (the workers of a manager that was not started with --supervise).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const extensions = require('@goobster/manager/extensions');
const registry = require('@goobster/manager/lifecycle/registry');
const { main } = require('@goobster/manager');
const { initDatabase } = require('@goobster/manager/install/dbInit');
const { makeRelease, newHarness, drive, tempDir } = require('./helpers/installFixture');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');

const silent = { info() {}, warn() {}, error() {} };
const cleanup = [];
const servers = [];
const stops = [];

afterAll(async () => {
    for (const stop of stops) await stop().catch(() => {});
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const scratch = (label) => tempDir(cleanup, label);
const nonce = () => crypto.randomBytes(24).toString('base64url');

function client(port, getHeaders = () => ({})) {
    const call = ({ method = 'GET', reqPath, body, headers = {} }) => new Promise((resolve, reject) => {
        const payload = body !== undefined ? JSON.stringify(body) : null;
        const req = http.request({
            agent: false,
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                host: `127.0.0.1:${port}`,
                ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { }
                resolve({ status: res.statusCode, body: json, text: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
    const authed = (method, reqPath, body) => call({ method, reqPath, body, headers: { ...getHeaders(), ...(method === 'GET' ? {} : { 'x-goobster-nonce': nonce() }) } });
    async function run(kind, input) {
        const planned = await authed('POST', '/manager/api/operations', { kind, input });
        if (planned.status !== 200) return { stage: 'plan', res: planned };
        const id = planned.body.operation ? planned.body.operation.id : planned.body.id;
        const validated = await authed('POST', `/manager/api/operations/${id}/validate`);
        if (validated.status !== 200) return { stage: 'validate', res: validated };
        const revision = (validated.body.operation || validated.body).revision;
        const applied = await authed('POST', `/manager/api/operations/${id}/apply`, { revision });
        return { stage: 'apply', res: applied, id, planned };
    }
    return { call, get: (reqPath) => authed('GET', reqPath), post: (reqPath, body) => authed('POST', reqPath, body), run };
}

async function serve(manager) {
    const app = createManagerApp(manager, { logger: silent, mounts: extensions.routes });
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    return server.address().port;
}

async function installedHarness({ installDeps = {}, config = null } = {}) {
    const root = scratch('routes');
    const release = makeRelease(scratch('routes-src'));
    const harness = await newHarness({ root, installDeps: { sourceCandidates: [release.dir], ...installDeps } });
    if (config) fs.writeFileSync(harness.settings.configPath, JSON.stringify(config));
    const claim = await harness.manager.engine.run('claim', { label: 'Rob Browning' }, { principal: null, via: 'bootstrap' });
    const token = claim.result.session.token;
    const port = await serve(harness.manager);
    const api = client(port, () => ({ authorization: `Bearer ${token}` }));
    return { ...harness, release, token, port, api, anonymous: client(port) };
}

describe('authentication and state', () => {
    test('every install route refuses an anonymous caller (401) and an unclaimed manager (409)', async () => {
        const h = await installedHarness();
        for (const route of ['/install/suggest', '/install/record', '/install/first-run', '/install/source?dir=/tmp']) {
            const res = await h.anonymous.call({ reqPath: `/manager/api${route}` });
            expect(res.status).toBe(401);
            expect(res.body.error.code).toBe('UNAUTHENTICATED');
        }
        const fresh = await newHarness({ root: scratch('unclaimed') });
        const port = await serve(fresh.manager);
        const session = fresh.manager.sessions.issue({ kind: 'setup' });
        const api = client(port, () => ({ authorization: `Bearer ${session.token}` }));
        for (const route of ['/install/suggest', '/install/record', '/install/first-run']) {
            const res = await api.get(`/manager/api${route}`);
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('STATE_NOT_ALLOWED');
        }
    });

    test('a bridge assertion for the right path is accepted, one for another path is not', async () => {
        const h = await installedHarness();
        const coreBridge = require('@goobster/core/web/managerBridge');
        const minter = coreBridge.createManagerBridge({ keyFile: h.manager.store.paths.bridgeKey });
        const actor = { actorId: '100000000000000001', account: { role: 'operator', status: 'active' } };
        const good = await h.anonymous.call({ reqPath: '/manager/api/install/record', headers: { [coreBridge.ASSERTION_HEADER]: minter.mint({ actor, method: 'GET', path: '/manager/api/install/record' }) } });
        expect(good.status).toBe(200);
        const wrong = await h.anonymous.call({ reqPath: '/manager/api/install/record', headers: { [coreBridge.ASSERTION_HEADER]: minter.mint({ actor, method: 'GET', path: '/manager/api/install/suggest' }) } });
        expect(wrong.status).toBeGreaterThanOrEqual(400);
    });
});

describe('GET /install/suggest', () => {
    test('suggests the real roots, the allowed bases with free space, the layout, the ports, the sources and no secret', async () => {
        const h = await installedHarness({ installDeps: { discover: () => ({ candidates: [{ id: 'abc', kind: 'manual', layout: 'lite', dbEngine: 'sqlite', roots: { code: '/srv/goobster' }, evidence: ['SOURCE_CHECKOUT'], services: [], updater: { kind: 'none' } }], searched: 1 }) } });
        const res = await h.api.get('/manager/api/install/suggest');
        expect(res.status).toBe(200);
        const body = res.body;
        expect(body.platform).toBe(process.platform);
        expect(body.bases.length).toBeGreaterThan(0);
        expect(body.bases[0].path).toBe(h.root);
        expect(typeof body.bases[0].freeBytes).toBe('number');
        expect(body.roots.code).toMatchObject({ path: h.code, fixed: false, allowed: true });
        expect(typeof body.roots.code.freeBytes).toBe('number');
        expect(body.roots.data).toMatchObject({ path: h.settings.dataDir, fixed: true, allowed: true });
        expect(body.roots.config.fixed).toBe(true);
        expect(body.roots.managerStore.fixed).toBe(true);
        expect(body.roots.cache.fixed).toBe(false);
        expect(body.layout).toMatchObject({ available: ['lite', 'standalone', 'paired'] });
        expect(body.database.engines).toEqual([{ engine: 'sqlite', available: true }, { engine: 'postgres', available: false }]);
        expect(body.ports.workers.map(entry => entry.name)).toEqual(['api']);
        expect(body.candidates).toEqual([{ id: 'abc', kind: 'manual', layout: 'lite', dbEngine: 'sqlite', code: '/srv/goobster', evidence: ['SOURCE_CHECKOUT'] }]);
        expect(body.sources).toHaveLength(1);
        expect(body.sources[0]).toMatchObject({ dir: fs.realpathSync(h.release.dir), version: '2.4.0' });
        expect(body.sources[0].features.map(feature => feature.id)).toEqual(['core', 'discord', 'economy', 'exchange', 'music', 'tavern']);
        const music = body.sources[0].features.find(feature => feature.id === 'music');
        expect(music.system).toEqual([{ name: 'goobster-test-missing-tool', kind: 'binary' }]);
        expect(music.bytes).toBeGreaterThan(0);
        expect(body.sources[0].features.find(feature => feature.id === 'exchange').requires).toEqual(['economy']);
        expect(res.text).not.toContain(h.token);
        expect(res.text).not.toContain('Rob Browning');
    });

    test('a discovery failure and a missing source are an empty list, not an error', async () => {
        const h = await installedHarness({ installDeps: { discover: () => { throw new Error('boom'); }, sourceCandidates: [path.join(os.tmpdir(), 'no-such-release-dir')] } });
        const res = await h.api.get('/manager/api/install/suggest');
        expect(res.status).toBe(200);
        expect(res.body.candidates).toEqual([]);
        expect(res.body.sources).toEqual([]);
    });

    test('a root outside the allowed bases says so', async () => {
        const root = scratch('outside');
        const harness = await newHarness({ root, installDeps: { home: scratch('elsewhere-home') } });
        await harness.manager.engine.run('claim', { label: 'Rob' }, { principal: null, via: 'bootstrap' });
        const session = harness.manager.sessions.issue({ kind: 'setup' });
        const api = client(await serve(harness.manager), () => ({ authorization: `Bearer ${session.token}` }));
        const res = await api.get('/manager/api/install/suggest');
        expect(res.body.roots.code.allowed).toBe(false);
    });
});

describe('GET /install/source', () => {
    test('summarises a release directory by manifest only, and refuses what is not one', async () => {
        const h = await installedHarness();
        const ok = await h.api.get(`/manager/api/install/source?dir=${encodeURIComponent(h.release.dir)}`);
        expect(ok.status).toBe(200);
        expect(ok.body.totalBytes).toBeGreaterThan(0);
        expect(ok.body.target).toBe(`${process.platform}-${process.arch}`);
        const relative = await h.api.get('/manager/api/install/source?dir=relative/path');
        expect(relative.status).toBe(400);
        const none = await h.api.get('/manager/api/install/source');
        expect(none.status).toBe(400);
        const empty = scratch('empty-source');
        const missing = await h.api.get(`/manager/api/install/source?dir=${encodeURIComponent(empty)}`);
        expect(missing.status).toBe(400);
        expect(missing.body.error.code).toBe('MANIFEST_MISSING');
        const nowhere = await h.api.get(`/manager/api/install/source?dir=${encodeURIComponent(path.join(empty, 'x'))}`);
        expect(nowhere.body.error.code).toBe('SOURCE_MISSING');
    });
});

describe('GET /install/record', () => {
    test('says not installed before an install and a sanitised record after', async () => {
        const h = await installedHarness();
        const before = await h.api.get('/manager/api/install/record');
        expect(before.body).toMatchObject({ installed: false, status: 'ok' });

        await drive(h, 'install.new', { source: h.release.dir, features: ['tavern'], release: { allowUnsigned: true } });
        const after = await h.api.get('/manager/api/install/record');
        expect(after.body.installed).toBe(true);
        expect(after.body.record).toMatchObject({
            origin: 'claim',
            layout: 'lite',
            database: { engine: 'sqlite', external: false },
            release: { version: '2.4.0', features: ['core', 'tavern'] },
            roots: { code: h.code, data: h.settings.dataDir },
            updater: { kind: 'manager' }
        });
        expect(after.body.record.installationId).toMatch(/\S/);
        expect(after.text).not.toContain('Rob Browning');
        expect(after.text).not.toContain(h.token);
        expect(after.text).not.toMatch(/credential|password|secret|seal/i);
    });
});

describe('GET /install/first-run', () => {
    test('before anything runs every item that depends on it fails with a recovery hint and nothing is created', async () => {
        const h = await installedHarness({ installDeps: { checkHealth: async () => false }, config: { token: 'x'.repeat(30) } });
        const res = await h.api.get('/manager/api/install/first-run');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(false);
        const byId = Object.fromEntries(res.body.checks.map(item => [item.id, item]));
        expect(Object.keys(byId)).toEqual(['config', 'features', 'database', 'owner', 'workers', 'portal']);
        expect(byId.config.ok).toBe(true);
        expect(byId.database).toMatchObject({ ok: false, detail: 'there is no database yet' });
        expect(byId.workers.ok).toBe(false);
        expect(byId.portal.ok).toBe(false);
        for (const item of res.body.checks.filter(entry => entry.ok !== true)) expect(item.hint).toMatch(/\S/);
        expect(fs.existsSync(h.settings.sqlitePath)).toBe(false);
    });

    test('passes when the database opens, an operator exists and the workers answer', async () => {
        const h = await installedHarness({
            installDeps: { checkHealth: async () => true, checkOwner: async () => ({ ok: true, accounts: 1, operators: 1 }) },
            config: { token: 'x'.repeat(30) }
        });
        fs.writeFileSync(h.settings.sqlitePath, Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(100)]));
        const res = await h.api.get('/manager/api/install/first-run');
        expect(res.body.checks.map(item => [item.id, item.ok])).toEqual([
            ['config', true], ['features', true], ['database', true], ['owner', true], ['workers', true], ['portal', true]
        ]);
        expect(res.body.ok).toBe(true);
    });

    test('an owner that does not exist yet fails only that item', async () => {
        const h = await installedHarness({
            installDeps: { checkHealth: async () => true, checkOwner: async () => ({ ok: true, accounts: 0, operators: 0 }) },
            config: { token: 'x'.repeat(30) }
        });
        fs.writeFileSync(h.settings.sqlitePath, Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(100)]));
        const res = await h.api.get('/manager/api/install/first-run');
        expect(res.body.checks.filter(item => !item.ok).map(item => item.id)).toEqual(['owner']);
    });
});

describe('owner.create', () => {
    const PASSWORD = 'plain-walnut-ladder-kettle-7';

    test('plans and applies through the engine; the journal and audit log name neither the login nor the password', async () => {
        const created = [];
        const h = await installedHarness({ installDeps: { createOwner: async ({ input }) => { created.push(input); return { loginName: input.loginName }; } } });
        const out = await h.api.run('owner.create', { loginName: 'Rob', password: PASSWORD, displayName: 'Rob B' });
        expect(out.stage).toBe('apply');
        expect(out.res.status).toBe(200);
        expect(created).toEqual([{ loginName: 'rob', password: PASSWORD, displayName: 'Rob B' }]);
        expect(out.res.body.result).toEqual({ created: true });
        const files = [];
        const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files.push(full); } };
        walk(h.settings.storeDir);
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            expect(text).not.toContain(PASSWORD);
        }
        const journal = files.filter(file => /operations/.test(file)).map(file => fs.readFileSync(file, 'utf8')).join('\n');
        expect(journal).toContain('owner.create');
        expect(journal).not.toMatch(/"loginName"|"rob"|Rob B/);
    });

    test('refuses a bad login name, a weak password and unknown fields at plan time, without calling anything', async () => {
        const created = [];
        const h = await installedHarness({ installDeps: { createOwner: async ({ input }) => { created.push(input); return { loginName: input.loginName }; } } });
        const bad = await h.api.run('owner.create', { loginName: '1', password: PASSWORD });
        expect(bad.stage).toBe('plan');
        expect(bad.res.body.error.code).toBe('BAD_LOGIN_NAME');
        const short = await h.api.run('owner.create', { loginName: 'rob', password: 'short' });
        expect(short.res.body.error.code).toBe('WEAK_PASSWORD');
        const contains = await h.api.run('owner.create', { loginName: 'rob', password: 'my rob password 123' });
        expect(contains.res.body.error.code).toBe('WEAK_PASSWORD');
        const extra = await h.api.run('owner.create', { loginName: 'rob', password: PASSWORD, role: 'operator' });
        expect(extra.res.body.error.code).toBe('INVALID_INPUT');
        expect(created).toEqual([]);
    });

    test('a failure never echoes the password, and an anonymous caller is refused', async () => {
        const h = await installedHarness({ installDeps: { createOwner: async () => { throw new (require('@goobster/manager/errors').ManagerError)(409, 'ACCOUNT_EXISTS', 'This installation already has an account.'); } } });
        const failed = await h.api.run('owner.create', { loginName: 'rob', password: PASSWORD });
        expect(failed.res.status).toBe(409);
        expect(failed.res.body.error.code).toBe('ACCOUNT_EXISTS');
        expect(failed.res.text).not.toContain(PASSWORD);
        const anonymous = await h.anonymous.call({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'owner.create', input: { loginName: 'rob', password: PASSWORD } } });
        expect(anonymous.status).toBe(401);
    });

    test('the real child creates the first operator in the installation database exactly once', async () => {
        const root = scratch('owner-real');
        const settings = resolveSettings({ GOOBSTER_DATA_DIR: path.join(root, 'data'), GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'), GOOBSTER_MANAGER_PORT: '0', GOOBSTER_MANAGER_RECONCILE: '0', PATH: process.env.PATH });
        const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
        await manager.init({ mintBootstrap: false });
        const claim = await manager.engine.run('claim', { label: 'Rob' }, { principal: null, via: 'bootstrap' });
        await initDatabase({ roots: { code: root, data: settings.dataDir }, settings, database: { engine: 'sqlite' } });
        const api = client(await serve(manager), () => ({ authorization: `Bearer ${claim.result.session.token}` }));

        const weak = await api.run('owner.create', { loginName: 'rob', password: 'passwordpassword' });
        expect(weak.res.status).toBe(400);
        expect(weak.res.body.error.code).toBe('WEAK_PASSWORD');
        expect(weak.res.text).not.toContain('passwordpassword');

        const first = await api.run('owner.create', { loginName: 'rob', password: PASSWORD });
        expect(first.res.body).not.toHaveProperty('error', expect.anything());
        expect(first.res.status).toBe(200);
        const { checkOwner } = require('@goobster/manager/install/owner');
        const state = await checkOwner({ roots: { code: root, data: settings.dataDir }, settings, database: { engine: 'sqlite' } });
        expect(state).toMatchObject({ ok: true, accounts: 1, operators: 1 });

        const second = await api.run('owner.create', { loginName: 'other', password: PASSWORD });
        expect(second.res.status).toBe(409);
        expect(second.res.body.error.code).toBe('ACCOUNT_EXISTS');

        const nativeAuth = require('@goobster/core/services/nativeAuthService');
        expect(typeof nativeAuth.register).toBe('function');
    }, 30_000);
});

describe('lifecycle.start and lifecycle.stop', () => {
    async function supervised() {
        const root = scratch('lifecycle');
        fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ webapp: { enabled: true } }));
        const fakes = createFakeWorkers();
        const outcome = await main([], {
            env: { GOOBSTER_DATA_DIR: path.join(root, 'data'), GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'), GOOBSTER_MANAGER_PORT: '0', GOOBSTER_MANAGER_RECONCILE: '0', GOOBSTER_RUNTIME_MODE: 'standalone', PATH: process.env.PATH },
            stdout: { write() {}, isTTY: false },
            logger: silent,
            supervisorOptions: { adapter: fakes.adapter, checkHealth: fakes.checkHealth, policy: FAST_POLICY, sandboxActive: () => false }
        });
        stops.push(() => outcome.stop());
        const credential = fs.readFileSync(path.join(root, 'data', 'manager', 'bootstrap-credential'), 'utf8').trim();
        const port = outcome.server.address().port;
        const anonymous = client(port);
        const claim = await anonymous.call({ method: 'POST', reqPath: '/manager/api/claim', body: { credential, label: 'Rob' } });
        const api = client(port, () => ({ cookie: claim.headers['set-cookie'][0].split(';')[0] }));
        return { root, fakes, outcome, api, port };
    }

    test('start launches the workers of the layout, health and the acknowledgement follow, a second start is refused', async () => {
        const h = await supervised();
        expect(h.outcome.supervisor).toBeNull();
        const started = await h.api.run('lifecycle.start', undefined);
        expect(started.res.status).toBe(200);
        expect(started.res.body.result).toEqual({ layout: 'standalone', workers: ['api'] });
        expect(h.outcome.supervisor).not.toBeNull();
        await waitFor(async () => {
            const view = await h.api.get('/manager/api/lifecycle');
            return view.body.workers[0] && view.body.workers[0].healthy && view.body.workers[0].ackedRevision === 0;
        }, { what: 'worker healthy and acknowledged', timeoutMs: 5000 });
        const again = await h.api.run('lifecycle.start', undefined);
        expect(again.stage).toBe('plan');
        expect(again.res.body.error.code).toBe('ALREADY_SUPERVISING');
    });

    test('stop reaps the workers and keeps the manager serving; a second stop is refused; start works again', async () => {
        const h = await supervised();
        await h.api.run('lifecycle.start', undefined);
        await waitFor(() => h.fakes.alive().length === 1, { what: 'worker alive' });
        const stopped = await h.api.run('lifecycle.stop', undefined);
        expect(stopped.res.status).toBe(200);
        expect(stopped.res.body.result).toMatchObject({ stopped: true });
        expect(h.fakes.alive()).toHaveLength(0);
        expect(h.outcome.supervisor).toBeNull();
        expect((await h.api.get('/manager/api/lifecycle')).body.supervising).toBe(false);
        const twice = await h.api.run('lifecycle.stop', undefined);
        expect(twice.res.body.error.code).toBe('NOT_SUPERVISING');
        const restarted = await h.api.run('lifecycle.start', undefined);
        expect(restarted.res.status).toBe(200);
    });

    test('a layout that cannot run yet is LAYOUT_NOT_READY with the reason, and nothing starts', async () => {
        const h = await supervised();
        fs.writeFileSync(path.join(h.root, 'config.json'), JSON.stringify({}));
        const refused = await h.api.run('lifecycle.start', undefined);
        expect(refused.res.body.error.code).toBe('LAYOUT_NOT_READY');
        expect(refused.res.body.error.details.code).toBe('WEBAPP_DISABLED');
        expect(h.fakes.procs).toHaveLength(0);
    });

    test('a manager with no starter (the CLI, a test harness) answers NOT_AVAILABLE; an anonymous caller is refused', async () => {
        const h = await installedHarness();
        expect(registry.getStarter(h.settings.storeDir)).toBeNull();
        const out = await h.api.run('lifecycle.start', undefined);
        expect(out.res.body.error.code).toBe('NOT_AVAILABLE');
        const anonymous = await h.anonymous.call({ method: 'POST', reqPath: '/manager/api/operations', body: { kind: 'lifecycle.start' } });
        expect(anonymous.status).toBe(401);
    });

    test('stopping the manager removes its starter', async () => {
        const h = await supervised();
        const storeDir = h.outcome.manager.settings.storeDir;
        expect(registry.getStarter(storeDir)).not.toBeNull();
        await h.outcome.stop();
        expect(registry.getStarter(storeDir)).toBeNull();
    });
});
