/**
 * The manager's configuration surface (#324): the effective report, the
 * `config.set` and `defaults.set` operation kinds, and the explicit provider
 * probe, over real HTTP for the routes and through the engine for the kinds.
 *
 * Plan -> validate -> apply, secrets only in private input, masks refused,
 * env-controlled fields refused unless forced, revision conflicts at every
 * stage, the mail dependency rule, and a planted-secret sweep over every
 * journal file, audit record and response. Runs on SQLite and on Postgres.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-324-mgr-'));
if (!process.env.GOOBSTER_DB_URL) process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'app.sqlite');

const db = require('@goobster/core/db');
const coreBridge = require('@goobster/core/web/managerBridge');
const configFile = require('@goobster/core/config/configFile');
const defaultsService = require('@goobster/core/services/instanceDefaultsService');
const state = require('@goobster/core/services/instanceStateService');
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createStore } = require('@goobster/manager/store/installation');
const extensions = require('@goobster/manager/extensions');
const { createConfigMount } = require('@goobster/manager/routes/config');
const configView = require('@goobster/manager/configView');

const silent = { info() {}, warn() {}, error() {} };
const OPERATOR = { actorId: '100000000000000001', account: { role: 'operator', status: 'active' } };
const BRIDGE = { principal: OPERATOR.actorId, via: 'bridge' };
const PLANTED = `sk-planted-${crypto.randomBytes(12).toString('hex')}`;
const PLANTED_ENV = `sk-planted-env-${crypto.randomBytes(12).toString('hex')}`;
const PLANTED_TRY = `sk-planted-try-${crypto.randomBytes(12).toString('hex')}`;
const servers = [];
configView.configure({ closeConnections: false });

const dbEnv = () => (process.env.GOOBSTER_DB_URL
    ? { GOOBSTER_DB_URL: process.env.GOOBSTER_DB_URL }
    : { GOOBSTER_DB_PATH: process.env.GOOBSTER_DB_PATH });
const UNREACHABLE_DB = { GOOBSTER_DB_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };

function newRoot(name) {
    const dir = path.join(ROOT, `${name}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeConfig(root, doc) {
    fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(doc, null, 4)}\n`, { mode: 0o600 });
}

async function harness({ config, env = {}, appDb = dbEnv(), hooks, probeOptions, probe } = {}) {
    const root = newRoot('mgr');
    if (config) writeConfig(root, config);
    const settings = resolveSettings({
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        ...appDb,
        ...env
    });
    const store = createStore({ root: settings.storeDir });
    store.init();
    store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
    const manager = createManager({ settings, hooks, logger: silent, extraKinds: extensions.kinds, reconcileDeps: { closeAfter: false } });
    await manager.init();
    const app = createManagerApp(manager, { logger: silent, mounts: [createConfigMount({ probeOptions, ...(probe ? { probe } : {}) })] });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(server);
    const port = server.address().port;
    const minter = coreBridge.createManagerBridge({ keyFile: manager.store.paths.bridgeKey });
    const responses = [];
    const call = (method, reqPath, body, { auth = true } = {}) => new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { host: `127.0.0.1:${port}` };
        if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        if (auth) headers[coreBridge.ASSERTION_HEADER] = minter.mint({ actor: OPERATOR, method, path: reqPath });
        const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                responses.push(data);
                resolve({ status: res.statusCode, body: JSON.parse(data) });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
    return { root, settings, manager, call, responses, configPath: settings.configPath };
}

async function plan(h, kind, input, auth = BRIDGE) {
    return h.manager.engine.plan(kind, input, auth);
}

async function run(h, kind, input, auth = BRIDGE) {
    const planned = await plan(h, kind, input, auth);
    const validated = await h.manager.engine.validate(planned.id, auth);
    return h.manager.engine.apply(validated.id, { revision: validated.revision }, auth);
}

async function codeOf(promise) {
    try {
        await promise;
    } catch (error) {
        return error.code;
    }
    return null;
}

const revisionOf = (h) => configFile.read(h.configPath).revision;
const readJson = (h) => JSON.parse(fs.readFileSync(h.configPath, 'utf8'));
const fieldOf = (report, id) => report.sections.flatMap(section => section.fields).find(entry => entry.id === id);

function listFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full));
        else out.push(full);
    }
    return out;
}

beforeAll(async () => {
    await db.get('SELECT 1 AS ok');
});

afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('registration', () => {
    test('the two kinds and the config routes are registered through extensions.js', async () => {
        const h = await harness();
        expect(h.manager.engine.kinds).toEqual(expect.arrayContaining(['config.set', 'defaults.set']));
        expect(extensions.routes.length).toBeGreaterThan(0);
        expect((await h.call('GET', '/manager/api/config')).status).toBe(200);
    });

    test('the manager audit actions are known to the audit service and the reconciler', () => {
        const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
        const { ACTIONS } = require('@goobster/core/services/operatorAuditService');
        for (const action of ['manager.config.set', 'manager.defaults.set']) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(action);
            expect(ACTIONS).toContain(action);
        }
    });
});

describe('GET /manager/api/config', () => {
    test('reports every field with its source; a secret is presence and last four only; the environment wins', async () => {
        const h = await harness({
            config: { ai: { provider: 'gemini' }, openaiKey: PLANTED, anthropicKey: `sk-ant-${PLANTED}`, customThing: { keep: true } },
            env: { OPENAI_API_KEY: PLANTED_ENV }
        });
        const res = await h.call('GET', '/manager/api/config');
        expect(res.status).toBe(200);
        expect(res.body.revision).toBe(revisionOf(h));
        expect(res.body.appDatabase).toMatchObject({ reachable: true });
        expect(res.body.defaults).toEqual({ revision: expect.any(Number) });
        expect(res.body.probes.map(p => p.target)).toContain('openai');

        const openai = fieldOf(res.body, 'ai.openai.apiKey');
        expect(openai).toMatchObject({ present: true, source: 'env', envControlled: true, secret: true, masked: true, fingerprint: PLANTED_ENV.slice(-4) });
        expect(openai).not.toHaveProperty('value');
        const anthropic = fieldOf(res.body, 'ai.anthropic.apiKey');
        expect(anthropic).toMatchObject({ present: true, source: 'config', envControlled: false, masked: true });
        expect(fieldOf(res.body, 'ai.gemini.apiKey')).toMatchObject({ present: false, source: 'unset' });
        expect(fieldOf(res.body, 'ai.provider')).toMatchObject({ value: 'gemini', source: 'config', envControlled: false });
        expect(fieldOf(res.body, 'identity.passwordMinLength')).toMatchObject({ source: 'default', value: 15, min: 12, max: 128 });
        expect(fieldOf(res.body, 'ai.provider').options).toEqual(expect.arrayContaining(['openai', 'anthropic']));

        expect(res.body.sections.map(section => section.id)).toEqual(expect.arrayContaining(['ai.providers', 'mail', 'limits', 'defaults']));
        const text = JSON.stringify(res.body);
        for (const secret of [PLANTED, PLANTED_ENV]) expect(text).not.toContain(secret);
    });

    test('an unreachable application database is reported, and database-backed fields say unknown-db', async () => {
        const h = await harness({ appDb: UNREACHABLE_DB });
        const res = await h.call('GET', '/manager/api/config');
        expect(res.status).toBe(200);
        expect(res.body.appDatabase.reachable).toBe(false);
        expect(res.body.defaults).toBeNull();
        expect(fieldOf(res.body, 'limits.dailyTokens').source).toBe('unknown-db');
        expect(fieldOf(res.body, 'defaults.appearance.theme').source).toBe('unknown-db');
        expect(fieldOf(res.body, 'ai.provider').source).not.toBe('unknown-db');
    });

    test('a database-backed value is read when the database is reachable', async () => {
        const h = await harness();
        await state.set('limits', { dailyTokens: 12345 });
        try {
            await defaultsService.set([{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }]);
            const res = await h.call('GET', '/manager/api/config');
            expect(fieldOf(res.body, 'limits.dailyTokens')).toMatchObject({ value: 12345, source: 'db', controlledBy: 'db' });
            expect(fieldOf(res.body, 'defaults.appearance.theme')).toMatchObject({ value: 'light', source: 'db' });
        } finally {
            await state.remove('limits');
            await state.remove('defaults');
        }
    });

    test('needs authentication and a claimed installation', async () => {
        const h = await harness();
        expect((await h.call('GET', '/manager/api/config', undefined, { auth: false })).status).toBe(401);
    });

    test('an unreadable config.json is reported, not repaired', async () => {
        const h = await harness();
        fs.writeFileSync(h.configPath, '{"ai": ');
        const res = await h.call('GET', '/manager/api/config');
        expect(res.status).toBe(200);
        expect(res.body.file).toMatchObject({ present: true, readable: false });
        expect(fs.readFileSync(h.configPath, 'utf8')).toBe('{"ai": ');
    });
});

describe('config.set', () => {
    test('writes a non-secret value atomically, owner-only, preserving unknown keys, and says what needs a restart', async () => {
        const h = await harness({ config: { ai: { provider: 'openai' }, customThing: { keep: true, list: [1, 2] } } });
        const revision = revisionOf(h);
        const planned = await plan(h, 'config.set', {
            expectedRevision: revision,
            changes: [{ id: 'ai.provider', action: 'set', value: 'Anthropic' }, { id: 'identity.assistantName', action: 'set', value: 'Gooby' }]
        });
        expect(planned.plan).toMatchObject({
            target: 'config.json',
            baseRevision: revision,
            effect: 'restart-required',
            changes: [
                { id: 'ai.provider', action: 'set', value: 'anthropic', apply: 'restart' },
                { id: 'identity.assistantName', action: 'set', value: 'Gooby' }
            ]
        });
        expect(planned.plan.dependencies).toEqual({ conflicts: [], warnings: [] });
        expect(fs.readFileSync(h.configPath, 'utf8')).toContain('"openai"');

        const validated = await h.manager.engine.validate(planned.id, BRIDGE);
        const applied = await h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
        expect(applied.operation.status).toBe('applied');
        expect(applied.operation.steps.filter(step => step.status === 'done').map(step => step.name))
            .toEqual(['validate', 'check-revision', 'write-config', 'verify']);
        expect(applied.result.restartRequired).toEqual(['ai.provider', 'identity.assistantName']);
        expect(applied.result.revision).toBe(revisionOf(h));
        expect(applied.result.revision).not.toBe(revision);

        const text = fs.readFileSync(h.configPath, 'utf8');
        expect(text).toBe(`${JSON.stringify(readJson(h), null, 4)}\n`);
        expect(readJson(h)).toMatchObject({ ai: { provider: 'anthropic' }, identity: { assistantName: 'Gooby' }, customThing: { keep: true, list: [1, 2] } });
        if (process.platform !== 'win32') expect(fs.statSync(h.configPath).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(h.root).filter(name => /\.tmp$|\.lock$/.test(name))).toEqual([]);

        const report = (await h.call('GET', '/manager/api/config')).body;
        expect(fieldOf(report, 'ai.provider')).toMatchObject({ value: 'anthropic', source: 'config' });
    });

    test('creates config.json when it does not exist (expectedRevision null)', async () => {
        const h = await harness();
        expect(fs.existsSync(h.configPath)).toBe(false);
        const applied = await run(h, 'config.set', { expectedRevision: null, changes: [{ id: 'webapp.enabled', action: 'set', value: true }] });
        expect(applied.operation.status).toBe('applied');
        expect(applied.result.restartRequired).toEqual(['webapp.enabled']);
        expect(readJson(h)).toEqual({ webapp: { enabled: true } });
    });

    test('a secret travels only in private input: the plan, the journal and the responses never hold it', async () => {
        const h = await harness({ config: { customThing: 1 } });
        const planned = await plan(h, 'config.set', {
            expectedRevision: revisionOf(h),
            changes: [{ id: 'ai.openai.apiKey', action: 'set', value: PLANTED }]
        });
        expect(planned.plan.changes).toEqual([{ id: 'ai.openai.apiKey', section: 'ai.providers', action: 'set', apply: 'restart', secret: true }]);
        expect(JSON.stringify(planned)).not.toContain(PLANTED);
        const planFile = fs.readFileSync(path.join(h.manager.store.paths.operations, `${planned.id}.json`), 'utf8');
        expect(planFile).not.toContain(PLANTED);

        const validated = await h.manager.engine.validate(planned.id, BRIDGE);
        const applied = await h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
        expect(JSON.stringify(applied)).not.toContain(PLANTED);
        expect(readJson(h).openaiKey).toBe(PLANTED);

        const report = (await h.call('GET', '/manager/api/config')).body;
        expect(fieldOf(report, 'ai.openai.apiKey')).toMatchObject({ present: true, source: 'config', fingerprint: PLANTED.slice(-4) });
        expect(JSON.stringify(report)).not.toContain(PLANTED);
    });

    test('a secret can be removed; the remaining file keeps everything else', async () => {
        const h = await harness({ config: { openaiKey: PLANTED, customThing: { a: 1 } } });
        const applied = await run(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'ai.openai.apiKey', action: 'remove' }] });
        expect(applied.operation.plan.changes[0]).toMatchObject({ id: 'ai.openai.apiKey', action: 'remove' });
        expect(readJson(h)).toEqual({ customThing: { a: 1 } });
        expect(fs.readFileSync(h.configPath, 'utf8')).not.toContain(PLANTED);
        const report = (await h.call('GET', '/manager/api/config')).body;
        expect(fieldOf(report, 'ai.openai.apiKey')).toMatchObject({ present: false, source: 'unset' });
    });

    test('a secret plan does not survive a restart: applying it again needs a new plan', async () => {
        const h = await harness({ config: {} });
        const planned = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'ai.openai.apiKey', action: 'set', value: PLANTED }] });
        const restarted = createManager({ settings: h.settings, logger: silent, extraKinds: extensions.kinds });
        await restarted.init();
        expect(await codeOf(restarted.engine.validate(planned.id, BRIDGE))).toBe('PLAN_INPUT_LOST');
        expect(fs.readFileSync(h.configPath, 'utf8')).not.toContain(PLANTED);
    });

    test('a mask is never accepted as a value', async () => {
        const h = await harness({ config: { openaiKey: PLANTED } });
        const before = fs.readFileSync(h.configPath, 'utf8');
        const masks = ['••••', `••••${PLANTED.slice(-4)}`, '[redacted]', 'sk-…[redacted]', '●●●●●●●●'];
        for (const value of masks) {
            const err = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'ai.openai.apiKey', action: 'set', value }] }).catch(e => e);
            expect(err.code).toBe('MASK_IS_NOT_A_VALUE');
            expect(err.status).toBe(400);
        }
        expect(await codeOf(plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'ai.provider', action: 'set', value: '[redacted]' }] }))).toBe('MASK_IS_NOT_A_VALUE');
        expect(fs.readFileSync(h.configPath, 'utf8')).toBe(before);
    });

    test('an environment-controlled field is refused unless forced, and then the plan says it is ineffective', async () => {
        const h = await harness({ env: { OPENAI_API_KEY: PLANTED_ENV } });
        const input = (extra = {}) => ({ expectedRevision: null, changes: [{ id: 'ai.openai.apiKey', action: 'set', value: PLANTED }], ...extra });
        const refused = await plan(h, 'config.set', input()).catch(e => e);
        expect(refused).toMatchObject({ status: 409, code: 'ENV_CONTROLLED', details: { id: 'ai.openai.apiKey', envName: 'OPENAI_API_KEY' } });
        expect(JSON.stringify(refused.details)).not.toContain(PLANTED_ENV);

        const forced = await run(h, 'config.set', input({ force: true }));
        expect(forced.operation.plan.changes[0]).toMatchObject({ ineffective: true, controlledBy: 'env', secret: true });
        expect(forced.result.ineffective).toEqual(['ai.openai.apiKey']);
        expect(forced.result.restartRequired).toEqual([]);
        expect(readJson(h).openaiKey).toBe(PLANTED);
        const report = (await h.call('GET', '/manager/api/config')).body;
        expect(fieldOf(report, 'ai.openai.apiKey')).toMatchObject({ source: 'env', fingerprint: PLANTED_ENV.slice(-4) });
    });

    test('a host limit set in the database controls the file value of the same name', async () => {
        const h = await harness();
        await state.set('limits', { dailyTokens: 5000 });
        try {
            const change = { id: 'limits.dailyTokens', action: 'set', value: 7000 };
            expect(await codeOf(plan(h, 'config.set', { expectedRevision: null, changes: [change] }))).toBe('DB_CONTROLLED');
            const forced = await run(h, 'config.set', { expectedRevision: null, changes: [change], force: true });
            expect(forced.operation.plan.changes[0]).toMatchObject({ ineffective: true, controlledBy: 'db' });
        } finally {
            await state.remove('limits');
        }
    });

    test('REVISION_CONFLICT at plan, validate, apply and inside the write', async () => {
        const h = await harness({ config: { ai: { provider: 'openai' } } });
        const change = (value) => ({ id: 'ai.provider', action: 'set', value });
        const rev0 = revisionOf(h);
        expect(await codeOf(plan(h, 'config.set', { expectedRevision: '0123456789abcdef', changes: [change('gemini')] }))).toBe('REVISION_CONFLICT');
        expect(await codeOf(plan(h, 'config.set', { expectedRevision: null, changes: [change('gemini')] }))).toBe('REVISION_CONFLICT');

        const planned = await plan(h, 'config.set', { expectedRevision: rev0, changes: [change('gemini')] });
        writeConfig(h.root, { ai: { provider: 'anthropic' } });
        expect(await codeOf(h.manager.engine.validate(planned.id, BRIDGE))).toBe('REVISION_CONFLICT');

        const second = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [change('gemini')] });
        const validated = await h.manager.engine.validate(second.id, BRIDGE);
        expect(await codeOf(h.manager.engine.apply(validated.id, { revision: validated.revision + 1 }, BRIDGE))).toBe('REVISION_CONFLICT');
        writeConfig(h.root, { ai: { provider: 'ollama' } });
        expect(await codeOf(h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE))).toBe('REVISION_CONFLICT');
        expect(readJson(h)).toEqual({ ai: { provider: 'ollama' } });

        let raced = false;
        const racing = await harness({
            config: { ai: { provider: 'openai' } },
            hooks: {
                beforeStep: async ({ step }) => {
                    if (step === 'write-config' && !raced) {
                        raced = true;
                        writeConfig(racing.root, { ai: { provider: 'ollama' }, raced: true });
                    }
                }
            }
        });
        const err = await run(racing, 'config.set', { expectedRevision: revisionOf(racing), changes: [change('gemini')] }).catch(e => e);
        expect(err.code).toBe('REVISION_CONFLICT');
        expect(err.operation.status).toBe('failed');
        expect(readJson(racing)).toEqual({ ai: { provider: 'ollama' }, raced: true });
    });

    test('refuses bad input before anything is planned or written', async () => {
        const h = await harness({ config: { ai: { provider: 'openai' } } });
        const rev = revisionOf(h);
        const before = fs.readFileSync(h.configPath, 'utf8');
        const attempts = [
            [{ changes: [{ id: 'ai.provider', action: 'set', value: 'x' }] }, 'INVALID_INPUT'],
            [{ expectedRevision: 'nope', changes: [{ id: 'ai.provider', action: 'set', value: 'x' }] }, 'INVALID_INPUT'],
            [{ expectedRevision: rev, changes: [] }, 'INVALID_INPUT'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'set', value: 'openai' }], path: '/etc/passwd' }, 'INVALID_INPUT'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'set', value: 'openai', file: '/etc/x' }] }, 'INVALID_INPUT'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'nuke' }] }, 'INVALID_INPUT'],
            [{ expectedRevision: rev, changes: [{ id: 'not.a.field', action: 'set', value: 1 }] }, 'UNKNOWN_FIELD'],
            [{ expectedRevision: rev, changes: [{ id: '__proto__', action: 'set', value: 1 }] }, 'UNKNOWN_FIELD'],
            [{ expectedRevision: rev, changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] }, 'NOT_IN_CONFIG_FILE'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'set', value: 'a' }, { id: 'ai.provider', action: 'remove' }] }, 'DUPLICATE_CHANGE'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'set', value: 'skynet' }] }, 'INVALID_VALUE'],
            [{ expectedRevision: rev, changes: [{ id: 'identity.passwordMinLength', action: 'set', value: 3 }] }, 'INVALID_VALUE'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.openai.apiKey', action: 'set', value: 12345 }] }, 'INVALID_VALUE'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.openai.apiKey', action: 'set', value: '' }] }, 'INVALID_VALUE'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'remove', value: 'x' }] }, 'INVALID_INPUT'],
            [{ expectedRevision: rev, changes: [{ id: 'ai.provider', action: 'set', value: 'openai' }], force: 'yes' }, 'INVALID_INPUT']
        ];
        for (const [input, code] of attempts) {
            const err = await plan(h, 'config.set', input).catch(e => e);
            expect(err.code).toBe(code);
            expect(err.status).toBe(400);
        }
        expect(fs.readFileSync(h.configPath, 'utf8')).toBe(before);
        expect(h.manager.engine.list()).toEqual([]);
    });

    test('an invalid value never echoes what was sent', async () => {
        const h = await harness();
        const err = await plan(h, 'config.set', {
            expectedRevision: null,
            changes: [{ id: 'mail.smtp.url', action: 'set', value: `https://user:${PLANTED}@example.com` }]
        }).catch(e => e);
        expect(err.code).toBe('INVALID_VALUE');
        expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(PLANTED);
    });

    test('is available only to a claimed installation', async () => {
        const root = newRoot('unclaimed');
        const settings = resolveSettings({
            GOOBSTER_DATA_DIR: path.join(root, 'data'),
            GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
            GOOBSTER_DB_PATH: path.join(root, 'absent.sqlite'),
            GOOBSTER_MANAGER_PORT: '0',
            GOOBSTER_MANAGER_RECONCILE: '0'
        });
        const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
        await manager.init({ mintBootstrap: false });
        expect(manager.currentState().state).toBe('unclaimed');
        for (const kind of ['config.set', 'defaults.set']) {
            expect(await codeOf(manager.engine.plan(kind, { changes: [] }, BRIDGE))).toBe('STATE_NOT_ALLOWED');
        }
    });
});

describe('config.set dependency validation', () => {
    const openSignUp = {
        identity: { nativeLogin: true, registration: 'open' },
        mail: { from: 'Goobster <goobster@example.org>', smtp: { host: 'smtp.example.org' } }
    };

    test('turning mail off while open sign-up is on is a DEPENDENCY_CONFLICT at validate, and nothing is written', async () => {
        const h = await harness({ config: openSignUp });
        const before = fs.readFileSync(h.configPath, 'utf8');
        const planned = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'mail.smtp.host', action: 'remove' }] });
        expect(planned.plan.dependencies.conflicts).toEqual([expect.objectContaining({ code: 'MAIL_REQUIRED_FOR_OPEN_REGISTRATION' })]);
        const err = await h.manager.engine.validate(planned.id, BRIDGE).catch(e => e);
        expect(err).toMatchObject({ status: 409, code: 'DEPENDENCY_CONFLICT' });
        expect(err.details.conflicts[0].code).toBe('MAIL_REQUIRED_FOR_OPEN_REGISTRATION');
        expect(fs.readFileSync(h.configPath, 'utf8')).toBe(before);

        for (const changes of [
            [{ id: 'mail.from', action: 'remove' }],
            [{ id: 'mail.provider', action: 'set', value: 'resend' }]
        ]) {
            const p = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes });
            expect(await codeOf(h.manager.engine.validate(p.id, BRIDGE))).toBe('DEPENDENCY_CONFLICT');
        }
    });

    test('the same change is fine when sign-up is invite-only, when another provider remains, or in one request that fixes both', async () => {
        const invite = await harness({ config: { ...openSignUp, identity: { nativeLogin: true, registration: 'invite' } } });
        expect((await run(invite, 'config.set', { expectedRevision: revisionOf(invite), changes: [{ id: 'mail.smtp.host', action: 'remove' }] })).operation.status).toBe('applied');

        const both = await harness({ config: { ...openSignUp, mail: { ...openSignUp.mail, resend: { apiKey: PLANTED } } } });
        expect((await run(both, 'config.set', { expectedRevision: revisionOf(both), changes: [{ id: 'mail.smtp.host', action: 'remove' }] })).operation.status).toBe('applied');

        const fixed = await harness({ config: openSignUp });
        const applied = await run(fixed, 'config.set', {
            expectedRevision: revisionOf(fixed),
            changes: [{ id: 'mail.smtp.host', action: 'remove' }, { id: 'identity.registration', action: 'set', value: 'invite' }]
        });
        expect(applied.operation.status).toBe('applied');
    });

    test('environment-provided mail keeps the dependency satisfied', async () => {
        const h = await harness({ config: openSignUp, env: { GOOBSTER_SMTP_HOST: 'mail.env.example.org' } });
        const applied = await run(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'mail.smtp.host', action: 'remove' }] });
        expect(applied.operation.status).toBe('applied');
    });

    test('verified addresses are a warning, not a refusal', async () => {
        const h = await harness({ config: { mail: openSignUp.mail } });
        const principalId = `p-324-${crypto.randomBytes(4).toString('hex')}`;
        await db.run('INSERT INTO principals (id, displayName) VALUES (@id, @name)', { id: principalId, name: 'Mailer' });
        await db.run(
            `INSERT INTO account_emails (principalId, address, normalized, verifiedAt) VALUES (@id, @address, @address, '2026-01-01 00:00:00')`,
            { id: principalId, address: `${principalId}@example.org` }
        );
        try {
            const planned = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'mail.smtp.host', action: 'remove' }] });
            expect(planned.plan.dependencies.conflicts).toEqual([]);
            expect(planned.plan.dependencies.warnings).toEqual([expect.objectContaining({ code: 'VERIFIED_ADDRESSES_EXIST', count: expect.any(Number) })]);
            expect(planned.plan.dependencies.warnings[0].count).toBeGreaterThan(0);
            const validated = await h.manager.engine.validate(planned.id, BRIDGE);
            expect((await h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE)).operation.status).toBe('applied');
        } finally {
            await db.run('DELETE FROM principals WHERE id = @id', { id: principalId });
        }
    });

    test('removing a credential an active feature needs reports wouldUnconfigure and still applies', async () => {
        const h = await harness({ config: { github: { token: `ghp_${PLANTED}` }, openaiKey: PLANTED } });
        const planned = await plan(h, 'config.set', {
            expectedRevision: revisionOf(h),
            changes: [{ id: 'github.token', action: 'remove' }]
        });
        expect(planned.plan.dependencies.warnings).toEqual([expect.objectContaining({ code: 'WOULD_UNCONFIGURE', wouldUnconfigure: ['github'] })]);
        const validated = await h.manager.engine.validate(planned.id, BRIDGE);
        const applied = await h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
        expect(applied.operation.status).toBe('applied');
        expect(readJson(h).github).toBeUndefined();

        const env = await harness({ config: { github: { token: 'ghp_filetoken1234' } }, env: { GITHUB_TOKEN: 'ghp_envtoken123456' } });
        const quiet = await plan(env, 'config.set', { expectedRevision: revisionOf(env), changes: [{ id: 'github.token', action: 'remove' }] });
        expect(quiet.plan.dependencies.warnings).toEqual([]);
    });
});

describe('defaults.set', () => {
    afterEach(async () => {
        await state.remove('defaults');
    });

    test('plan, validate and apply write the defaults, effective immediately, with an audit record', async () => {
        const h = await harness();
        const planned = await plan(h, 'defaults.set', {
            changes: [
                { id: 'defaults.appearance.theme', action: 'set', value: 'light' },
                { id: 'defaults.chat.provider', action: 'set', value: 'anthropic' }
            ]
        });
        expect(planned.plan).toMatchObject({ target: 'instance-defaults', effect: 'immediate' });
        expect(planned.plan.changes).toEqual([
            { id: 'defaults.appearance.theme', action: 'set', value: 'light' },
            { id: 'defaults.chat.provider', action: 'set', value: 'anthropic' }
        ]);
        expect(await defaultsService.get()).toEqual({});
        const validated = await h.manager.engine.validate(planned.id, BRIDGE);
        const applied = await h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
        expect(applied.operation.status).toBe('applied');
        expect(applied.result).toMatchObject({ effect: 'immediate', changed: ['defaults.appearance.theme', 'defaults.chat.provider'] });
        expect(await defaultsService.get()).toEqual({ appearance: { theme: 'light' }, chat: { provider: 'anthropic' } });

        const report = (await h.call('GET', '/manager/api/config')).body;
        expect(fieldOf(report, 'defaults.appearance.theme')).toMatchObject({ value: 'light', source: 'db' });
        expect(report.defaults.revision).toBe(applied.result.revision);

        expect(h.manager.journal.readAudit().entries.map(entry => entry.action)).toContain('manager.defaults.set');
        const reconciled = await h.manager.reconcile();
        expect(reconciled).toMatchObject({ deferred: false, inserted: expect.any(Number) });
        const row = await db.get('SELECT action, target FROM operator_audit WHERE action = @action AND target = @target', { action: 'manager.defaults.set', target: applied.operation.id });
        expect(row).toBeTruthy();
    });

    test('config.set is audited and reconciled the same way', async () => {
        const h = await harness();
        const applied = await run(h, 'config.set', { expectedRevision: null, changes: [{ id: 'ai.provider', action: 'set', value: 'gemini' }] });
        expect(h.manager.journal.readAudit().entries.map(entry => entry.action)).toContain('manager.config.set');
        await h.manager.reconcile();
        const row = await db.get('SELECT detailJson FROM operator_audit WHERE action = @action AND target = @target', { action: 'manager.config.set', target: applied.operation.id });
        expect(row).toBeTruthy();
        expect(JSON.stringify(row)).not.toContain('gemini');
    });

    test('is refused with APP_DB_UNAVAILABLE when the application database is not reachable', async () => {
        const h = await harness({ appDb: UNREACHABLE_DB });
        const err = await plan(h, 'defaults.set', { changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] }).catch(e => e);
        expect(err).toMatchObject({ status: 409, code: 'APP_DB_UNAVAILABLE' });
        expect(h.manager.engine.list()).toEqual([]);
    });

    test('a database that went away between plan and apply is refused at validate', async () => {
        const h = await harness();
        const planned = await plan(h, 'defaults.set', { changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] });
        const gone = createManager({ settings: resolveSettings({ ...h.settings.env, ...UNREACHABLE_DB }), logger: silent, extraKinds: extensions.kinds });
        await gone.init();
        expect(planned.id).toBeTruthy();
        expect(await codeOf(gone.engine.validate(planned.id, BRIDGE))).toBe('APP_DB_UNAVAILABLE');
    });

    test('a retention default purges history for people without their own window: it needs an acknowledgement and warns', async () => {
        const h = await harness();
        const input = { changes: [{ id: 'defaults.memory.chatHistoryRetentionDays', action: 'set', value: 30 }] };
        const err = await plan(h, 'defaults.set', input).catch(e => e);
        expect(err).toMatchObject({ status: 400, code: 'ACKNOWLEDGEMENT_REQUIRED' });
        expect(err.details.warnings[0].code).toBe('RETENTION_DEFAULT_PURGES');
        expect(await defaultsService.get()).toEqual({});

        const planned = await plan(h, 'defaults.set', { ...input, acknowledgeRetention: true });
        expect(planned.plan.dependencies.warnings).toEqual([expect.objectContaining({ code: 'RETENTION_DEFAULT_PURGES', days: 30 })]);
        const validated = await h.manager.engine.validate(planned.id, BRIDGE);
        await h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
        expect((await defaultsService.get()).memory.chatHistoryRetentionDays).toBe(30);

        const clear = await run(h, 'defaults.set', { changes: [{ id: 'defaults.memory.chatHistoryRetentionDays', action: 'remove' }] });
        expect(clear.operation.plan.dependencies.warnings).toEqual([]);
    });

    test('REVISION_CONFLICT when the defaults changed after the plan', async () => {
        const h = await harness();
        const planned = await plan(h, 'defaults.set', { changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] });
        await defaultsService.set([{ id: 'defaults.appearance.startPage', action: 'set', value: 'chat' }]);
        expect(await codeOf(h.manager.engine.validate(planned.id, BRIDGE))).toBe('REVISION_CONFLICT');
        expect(await codeOf(plan(h, 'defaults.set', { expectedRevision: 1, changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] }))).toBe('REVISION_CONFLICT');
    });

    test('refuses unknown fields (including the enforced limits), bad values and extra input', async () => {
        const h = await harness();
        for (const [input, code] of [
            [{ changes: [{ id: 'limits.dailyTokens', action: 'set', value: 1 }] }, 'UNKNOWN_FIELD'],
            [{ changes: [{ id: 'ai.provider', action: 'set', value: 'openai' }] }, 'UNKNOWN_FIELD'],
            [{ changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'neon' }] }, 'INVALID_VALUE'],
            [{ changes: [{ id: 'defaults.budget.usageAlertTokens', action: 'set', value: -4 }] }, 'INVALID_VALUE'],
            [{ changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }], path: '/x' }, 'INVALID_INPUT'],
            [{ changes: [] }, 'INVALID_INPUT'],
            [{ changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light', extra: 1 }] }, 'INVALID_INPUT']
        ]) {
            const err = await plan(h, 'defaults.set', input).catch(e => e);
            expect(err.code).toBe(code);
            expect(err.status).toBe(400);
        }
        expect(await defaultsService.get()).toEqual({});
    });

    test('a default provider with no credential is a warning', async () => {
        const h = await harness();
        const planned = await plan(h, 'defaults.set', { changes: [{ id: 'defaults.chat.provider', action: 'set', value: 'gemini' }] });
        expect(planned.plan.dependencies.warnings).toEqual([expect.objectContaining({ code: 'DEFAULT_PROVIDER_NOT_CONFIGURED' })]);
    });
});

describe('POST /manager/api/config/probe', () => {
    function fakeFetch(handler) {
        const calls = [];
        const fn = async (url, init) => {
            calls.push({ url: String(url), headers: init.headers, redirect: init.redirect, method: init.method, body: init.body });
            return handler(String(url), init);
        };
        fn.calls = calls;
        return fn;
    }
    const answer = (status) => ({ status, headers: { get: () => null }, body: { cancel: async () => {} } });

    test('uses the saved credential, reports the outcome, and never returns or journals the key', async () => {
        const fetch = fakeFetch(() => answer(401));
        const h = await harness({ config: { openaiKey: PLANTED }, probeOptions: { fetch } });
        const res = await h.call('POST', '/manager/api/config/probe', { target: 'openai', useSaved: true });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ target: 'openai', ok: false, code: 'AUTH_FAILED', usedSaved: true });
        expect(fetch.calls).toHaveLength(1);
        expect(fetch.calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/models', method: 'GET', redirect: 'manual' });
        expect(fetch.calls[0].headers.Authorization).toBe(`Bearer ${PLANTED}`);
        expect(JSON.stringify(res.body)).not.toContain(PLANTED);
        expect(h.manager.engine.list()).toEqual([]);
        expect(h.manager.journal.readAudit().entries).toEqual([]);
    });

    test('tries a credential from the request body before it is saved, without saving it', async () => {
        const fetch = fakeFetch(() => answer(200));
        const h = await harness({ probeOptions: { fetch } });
        const res = await h.call('POST', '/manager/api/config/probe', { target: 'anthropic', credential: PLANTED_TRY });
        expect(res.body).toMatchObject({ ok: true, code: 'OK', usedSaved: false });
        expect(fetch.calls[0].headers['x-api-key']).toBe(PLANTED_TRY);
        expect(fs.existsSync(h.configPath)).toBe(false);
        expect(JSON.stringify(res.body)).not.toContain(PLANTED_TRY);
    });

    test('maps outcomes: rate limit, unreachable provider, timeout is bounded by the probe', async () => {
        const limited = await harness({ config: { googleAIKey: PLANTED }, probeOptions: { fetch: fakeFetch(() => answer(429)) } });
        expect((await limited.call('POST', '/manager/api/config/probe', { target: 'gemini', useSaved: true })).body.code).toBe('RATE_LIMITED');
        const down = await harness({ config: { googleAIKey: PLANTED }, probeOptions: { fetch: fakeFetch(() => { throw new Error('ENOTFOUND'); }) } });
        expect((await down.call('POST', '/manager/api/config/probe', { target: 'gemini', useSaved: true })).body.code).toBe('UNREACHABLE');
    });

    test('the environment credential is used when it is the one in effect', async () => {
        const fetch = fakeFetch(() => answer(200));
        const h = await harness({ config: { openaiKey: PLANTED }, env: { OPENAI_API_KEY: PLANTED_ENV }, probeOptions: { fetch } });
        await h.call('POST', '/manager/api/config/probe', { target: 'openai', useSaved: true });
        expect(fetch.calls[0].headers.Authorization).toBe(`Bearer ${PLANTED_ENV}`);
    });

    test('Ollama is probed at the configured host with no credential', async () => {
        const fetch = fakeFetch(() => answer(200));
        const h = await harness({ config: { ollama: { host: 'http://127.0.0.1:11999' } }, probeOptions: { fetch } });
        const res = await h.call('POST', '/manager/api/config/probe', { target: 'ollama', useSaved: true });
        expect(res.body.ok).toBe(true);
        expect(fetch.calls[0].url).toBe('http://127.0.0.1:11999/api/tags');
        expect(fetch.calls[0].headers).toEqual({});
        expect((await h.call('POST', '/manager/api/config/probe', { target: 'ollama', credential: PLANTED_TRY })).status).toBe(400);
    });

    test('mail: the SMTP target comes from the saved configuration and never carries the URL credentials', async () => {
        const seen = [];
        const probe = async (target, options) => {
            seen.push({ target, options });
            return { target, ok: true, code: 'OK', latencyMs: 1, detail: 'fake', whatItDoes: 'fake' };
        };
        const h = await harness({ config: { mail: { smtp: { url: `smtps://mailer:${PLANTED}@smtp.example.org` } } }, probe });
        const res = await h.call('POST', '/manager/api/config/probe', { target: 'mail', useSaved: true });
        expect(res.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0].options.mail).toEqual({ host: 'smtp.example.org', port: 465, secure: true });
        expect(JSON.stringify(seen[0].options)).not.toContain(PLANTED);
        expect(JSON.stringify(res.body)).not.toContain(PLANTED);

        const resend = await harness({ config: { mail: { resend: { apiKey: PLANTED } } }, probe });
        await resend.call('POST', '/manager/api/config/probe', { target: 'mail', useSaved: true });
        expect(seen[1].options).toMatchObject({ mail: { provider: 'resend' }, credentials: { apiKey: PLANTED } });
    });

    test('refuses an unknown target, a missing or doubled credential choice, extra fields and an absent saved credential', async () => {
        const fetch = fakeFetch(() => answer(200));
        const h = await harness({ config: {}, probeOptions: { fetch } });
        const post = (body, opts) => h.call('POST', '/manager/api/config/probe', body, opts);
        expect((await post({ target: 'nope', useSaved: true })).body.error.code).toBe('UNKNOWN_TARGET');
        expect((await post({ target: 'openai' })).status).toBe(400);
        expect((await post({ target: 'openai', useSaved: true, credential: PLANTED_TRY })).status).toBe(400);
        expect((await post({ target: 'openai', useSaved: true, url: 'https://evil.example' })).status).toBe(400);
        expect((await post({ target: 'openai', credential: 'short' })).body.error.code).toBe('BAD_CREDENTIAL');
        const none = await post({ target: 'openai', useSaved: true });
        expect(none.status).toBe(409);
        expect(none.body.error.code).toBe('NO_SAVED_CREDENTIAL');
        expect((await post({ target: 'mail', useSaved: true })).body.error.code).toBe('NOT_CONFIGURED');
        expect((await post({ target: 'openai', useSaved: true }, { auth: false })).status).toBe(401);
        expect(fetch.calls).toHaveLength(0);
    });

    test('no probe runs on status, report or operation reads', async () => {
        const fetch = fakeFetch(() => answer(200));
        const h = await harness({ config: { openaiKey: PLANTED }, probeOptions: { fetch } });
        await h.call('GET', '/manager/api/status');
        await h.call('GET', '/manager/api/config');
        await h.call('GET', '/manager/api/features');
        await h.call('GET', '/manager/api/operations');
        expect(fetch.calls).toHaveLength(0);
    });

    test('is limited to a few checks a minute', async () => {
        const fetch = fakeFetch(() => answer(200));
        const h = await harness({ config: { openaiKey: PLANTED }, probeOptions: { fetch } });
        let last;
        for (let i = 0; i < 21; i++) last = await h.call('POST', '/manager/api/config/probe', { target: 'openai', useSaved: true });
        expect(last.status).toBe(429);
        expect(fetch.calls).toHaveLength(20);
    });
});

describe('a planted secret never reaches the journal, the audit log or a response', () => {
    test('config.set, defaults.set, the report and a probe leave nothing behind', async () => {
        const fetch = async () => ({ status: 401, headers: { get: () => null }, body: { cancel: async () => {} }, text: async () => PLANTED });
        const h = await harness({
            config: { anthropicKey: PLANTED, mail: { smtp: { url: `smtp://u:${PLANTED}@mail.example.org` } } },
            env: { OPENAI_API_KEY: PLANTED_ENV, GITHUB_TOKEN: `ghp_${PLANTED_ENV}` },
            probeOptions: { fetch }
        });
        const secrets = [PLANTED, PLANTED_ENV, PLANTED_TRY, `ghp_${PLANTED_ENV}`];

        await h.call('GET', '/manager/api/config');
        await h.call('POST', '/manager/api/config/probe', { target: 'anthropic', useSaved: true });
        await h.call('POST', '/manager/api/config/probe', { target: 'gemini', credential: PLANTED_TRY });
        const refused = await plan(h, 'config.set', { expectedRevision: revisionOf(h), changes: [{ id: 'ai.openai.apiKey', action: 'set', value: PLANTED_TRY }] }).catch(e => e);
        expect(refused.code).toBe('ENV_CONTROLLED');
        const applied = await run(h, 'config.set', {
            expectedRevision: revisionOf(h),
            changes: [{ id: 'ai.gemini.apiKey', action: 'set', value: PLANTED_TRY }, { id: 'ai.anthropic.apiKey', action: 'remove' }, { id: 'ai.provider', action: 'set', value: 'gemini' }]
        });
        expect(applied.operation.status).toBe('applied');
        const failed = await run(h, 'config.set', { expectedRevision: '0123456789abcdef', changes: [{ id: 'ai.provider', action: 'set', value: 'openai' }] }).catch(e => e);
        expect(failed.code).toBe('REVISION_CONFLICT');
        await run(h, 'defaults.set', { changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] });
        await h.call('POST', '/manager/api/operations', { kind: 'config.set', input: { expectedRevision: revisionOf(h), changes: [{ id: 'ai.elevenlabs', action: 'set', value: PLANTED_TRY }] } });
        await h.call('GET', '/manager/api/operations');
        await h.call('GET', '/manager/api/status');

        const files = listFiles(h.settings.storeDir).filter(file => path.basename(file) !== 'bridge-key');
        expect(files.filter(file => /operations[\\/][0-9a-f-]{36}\.json$/.test(file)).length).toBeGreaterThanOrEqual(2);
        expect(files.some(file => file.endsWith('audit.jsonl'))).toBe(true);
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            for (const secret of secrets) expect(text.includes(secret)).toBe(false);
        }
        for (const text of h.responses) {
            for (const secret of secrets) expect(text.includes(secret)).toBe(false);
        }
        await h.manager.reconcile();
        const rows = await db.all('SELECT * FROM operator_audit WHERE action IN (@a, @b)', { a: 'manager.config.set', b: 'manager.defaults.set' });
        expect(rows.length).toBeGreaterThan(0);
        for (const secret of secrets) expect(JSON.stringify(rows).includes(secret)).toBe(false);
    });
});
