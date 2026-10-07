/**
 * The manager's setup engine and store (#323): features.set through
 * featureState.write() (valid file, unknown ids, uninstalled packages,
 * dependency and revision conflicts), crash/restart durability (identity,
 * owner claim and operation status survive; an interrupted operation is
 * marked, never re-run), no planted secret in any journal file or response,
 * explicit adoption only, the lock, and audit reconciliation into
 * operator_audit exactly once. Runs on SQLite and on Postgres.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-323-engine-'));
if (!process.env.GOOBSTER_DB_URL) process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'app.sqlite');

const db = require('@goobster/core/db');
const { createFeatureState } = require('@goobster/core/features/featureState');
const coreBridge = require('@goobster/core/web/managerBridge');
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createStore } = require('@goobster/manager/store/installation');
const { createJournal } = require('@goobster/manager/store/journal');
const { createLock } = require('@goobster/manager/store/lock');
const { reconcileAudit } = require('@goobster/manager/audit');
const { probeAppDatabase } = require('@goobster/manager/appDatabase');
const { main } = require('@goobster/manager');

const silent = { info() {}, warn() {}, error() {} };
const OPERATOR = { actorId: '100000000000000001', account: { role: 'operator', status: 'active' } };
const BRIDGE = { principal: OPERATOR.actorId, via: 'bridge' };
const PLANTED = `sk-planted-${crypto.randomBytes(12).toString('hex')}`;
const servers = [];

function newRoot(name) {
    const dir = path.join(ROOT, `${name}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function envFor(root, extra = {}) {
    return {
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        ...extra
    };
}

function seedClaimed(settings, label = 'Rob') {
    const store = createStore({ root: settings.storeDir });
    store.init();
    return store.createInstallation({ origin: 'claim', ownerLabel: label });
}

async function claimedManager({ root = newRoot('claimed'), env = {}, hooks, isProcessAlive } = {}) {
    const settings = resolveSettings(envFor(root, env));
    const installation = seedClaimed(settings);
    const manager = createManager({ settings, hooks, isProcessAlive, logger: silent });
    await manager.init();
    return { root, settings, manager, installation };
}

async function applyFeatures(manager, changes, auth = BRIDGE, expectedRevision) {
    const input = expectedRevision === undefined ? { changes } : { changes, expectedRevision };
    const planned = await manager.engine.plan('features.set', input, auth);
    const validated = await manager.engine.validate(planned.id, auth);
    return manager.engine.apply(validated.id, { revision: validated.revision }, auth);
}

async function codeOf(promise) {
    try {
        await promise;
    } catch (error) {
        return error.code;
    }
    return null;
}

const freshStatus = (settings) => createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} }).status();

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

describe('features.set', () => {
    test('writes a valid features.json read back by a fresh resolver; changes are pending until restart', async () => {
        const { manager, settings } = await claimedManager();
        const first = await applyFeatures(manager, { gba: true, screenVision: true });
        expect(first.operation.status).toBe('applied');
        expect(first.result).toEqual({ revision: 1, pending: ['gba', 'screenVision'] });
        expect(first.operation.steps.filter(s => s.status === 'done').map(s => s.name))
            .toEqual(['validate', 'check-revision', 'write-features', 'verify']);

        const status = freshStatus(settings);
        expect(status).toMatchObject({ source: 'file', version: 1, revision: 1, origin: 'operator', error: null });
        expect(status.features.gba).toMatchObject({ active: false, pendingActive: true, pending: true });
        expect(status.features.screenVision).toMatchObject({ pendingActive: true, pending: true });
        const raw = JSON.parse(fs.readFileSync(settings.featuresPath, 'utf8'));
        expect(raw.features.gba).toEqual({ installed: true, active: false, pendingActive: true });

        const second = await applyFeatures(manager, { gba: false }, BRIDGE, 1);
        expect(second.result.revision).toBe(2);
        expect(freshStatus(settings).features.gba).toMatchObject({ pendingActive: null, pending: false });
    });

    test('refuses an unknown id, core, extra fields and non-boolean values', async () => {
        const { manager, settings } = await claimedManager();
        expect(await codeOf(manager.engine.plan('features.set', { changes: { warpDrive: true } }, BRIDGE))).toBe('UNKNOWN_FEATURE');
        expect(await codeOf(manager.engine.plan('features.set', { changes: { core: false } }, BRIDGE))).toBe('CORE_IMMUTABLE');
        expect(await codeOf(manager.engine.plan('features.set', { changes: { gba: 'yes' } }, BRIDGE))).toBe('INVALID_INPUT');
        expect(await codeOf(manager.engine.plan('features.set', { changes: { gba: true }, path: '/etc/passwd' }, BRIDGE))).toBe('INVALID_INPUT');
        expect(await codeOf(manager.engine.plan('features.set', { changes: {} }, BRIDGE))).toBe('INVALID_INPUT');
        expect(await codeOf(manager.engine.plan('shell.exec', { cmd: 'rm -rf /' }, BRIDGE))).toBe('UNKNOWN_KIND');
        expect(fs.existsSync(settings.featuresPath)).toBe(false);
    });

    test('never activates a feature whose package is not installed', async () => {
        const { manager, settings } = await claimedManager();
        const state = createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} });
        const seed = state.seedFromLegacy();
        seed.features.music = { installed: false, active: false };
        await state.write({ origin: 'operator', features: seed.features }, { expectedRevision: null });
        expect(await codeOf(manager.engine.plan('features.set', { changes: { music: true } }, BRIDGE))).toBe('FEATURE_NOT_INSTALLED');
        expect(JSON.parse(fs.readFileSync(settings.featuresPath, 'utf8')).revision).toBe(1);
    });

    test('a dependency is never enabled for the operator', async () => {
        const { manager } = await claimedManager();
        const err = await manager.engine.plan('features.set', { changes: { economy: false } }, BRIDGE).catch(e => e);
        expect(err.code).toBe('DEPENDENCY_CONFLICT');
        expect(err.details.conflicts.length).toBeGreaterThan(0);
    });

    test('REVISION_CONFLICT on a stale revision at plan, validate, apply and inside the write', async () => {
        const { manager, settings } = await claimedManager();
        await applyFeatures(manager, { gba: true });
        expect(await codeOf(manager.engine.plan('features.set', { changes: { gba: false }, expectedRevision: 0 }, BRIDGE))).toBe('REVISION_CONFLICT');

        const external = async () => {
            const state = createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} });
            const current = state.load().parsed;
            await state.write({ origin: 'operator', features: current.features }, { expectedRevision: current.revision });
        };

        const planned = await manager.engine.plan('features.set', { changes: { screenVision: true } }, BRIDGE);
        await external();
        expect(await codeOf(manager.engine.validate(planned.id, BRIDGE))).toBe('REVISION_CONFLICT');

        const p2 = await manager.engine.plan('features.set', { changes: { screenVision: true } }, BRIDGE);
        const v2 = await manager.engine.validate(p2.id, BRIDGE);
        expect(await codeOf(manager.engine.apply(v2.id, { revision: v2.revision + 7 }, BRIDGE))).toBe('REVISION_CONFLICT');
        expect(manager.engine.status(v2.id).status).toBe('validated');
        await external();
        expect(await codeOf(manager.engine.apply(v2.id, { revision: v2.revision }, BRIDGE))).toBe('REVISION_CONFLICT');
        expect(manager.engine.status(v2.id)).toMatchObject({ status: 'failed', error: { code: 'REVISION_CONFLICT' } });

        let raced = false;
        const racing = await claimedManager({
            hooks: {
                beforeStep: async ({ step }) => {
                    if (step === 'write-features' && !raced) {
                        raced = true;
                        const state = createFeatureState({ filePath: racing.settings.featuresPath, env: {}, config: {} });
                        await state.write(state.seedFromLegacy(), { expectedRevision: null });
                    }
                }
            }
        });
        const err = await applyFeatures(racing.manager, { gba: true }).catch(e => e);
        expect(err.code).toBe('REVISION_CONFLICT');
        expect(err.operation.status).toBe('failed');
        expect(err.operation.steps.find(s => s.name === 'write-features' && s.status === 'failed')).toBeTruthy();
    });

    test('a damaged features.json is left exactly as it was', async () => {
        const { manager, settings } = await claimedManager();
        fs.mkdirSync(path.dirname(settings.featuresPath), { recursive: true });
        fs.writeFileSync(settings.featuresPath, '{"version": 9');
        expect(await codeOf(manager.engine.plan('features.set', { changes: { gba: true } }, BRIDGE))).toBe('FEATURE_STATE_UNREADABLE');
        expect(fs.readFileSync(settings.featuresPath, 'utf8')).toBe('{"version": 9');
    });
});

describe('durability', () => {
    test('a failing step is recorded; a new manager on the same store keeps identity, owner and the failure', async () => {
        const root = newRoot('durable');
        const hooks = {
            beforeStep: ({ step }) => {
                if (step === 'write-features') throw new Error(`disk full at /tmp/secret ${PLANTED}`);
            }
        };
        const a = await claimedManager({ root, hooks });
        const err = await applyFeatures(a.manager, { gba: true }).catch(e => e);
        expect(err.code).toBe('STEP_FAILED');
        expect(err.message).not.toContain(PLANTED);
        const id = err.details.operationId;

        const settings = resolveSettings(envFor(root));
        const b = createManager({ settings, logger: silent });
        await b.init();
        const state = b.currentState();
        expect(state.state).toBe('claimed');
        expect(state.installation.installationId).toBe(a.installation.installationId);
        expect(state.installation.ownerLabel).toBe('Rob');
        const record = b.engine.status(id);
        expect(record).toMatchObject({ status: 'failed', error: { code: 'STEP_FAILED' } });
        expect(record.steps.map(s => `${s.name}:${s.status}`)).toEqual(expect.arrayContaining(['check-revision:done', 'write-features:failed']));
        expect(fs.existsSync(settings.featuresPath)).toBe(false);
        const journalText = fs.readFileSync(path.join(settings.storeDir, 'operations', `${id}.json`), 'utf8');
        expect(journalText).not.toContain(PLANTED);
        expect(journalText).not.toContain('/tmp/secret');
    });

    test('a crash mid-apply: the restarted manager marks the operation INTERRUPTED and reclaims the lock', async () => {
        const root = newRoot('crash');
        let reached;
        const atWrite = new Promise((resolve) => { reached = resolve; });
        const a = await claimedManager({
            root,
            hooks: { beforeStep: ({ step }) => (step === 'write-features' ? (reached(), new Promise(() => {})) : undefined) }
        });
        const planned = await a.manager.engine.plan('features.set', { changes: { gba: true } }, BRIDGE);
        await a.manager.engine.validate(planned.id, BRIDGE);
        a.manager.engine.apply(planned.id, { revision: 0 }, BRIDGE).catch(() => {});
        await atWrite;
        expect(a.manager.engine.status(planned.id).status).toBe('applying');
        expect(fs.existsSync(a.manager.store.paths.lock)).toBe(true);

        const settings = resolveSettings(envFor(root));
        const b = createManager({ settings, isProcessAlive: () => false, logger: silent });
        const booted = await b.init();
        expect(booted.recovered).toEqual([planned.id]);
        expect(b.currentState().installation.installationId).toBe(a.installation.installationId);
        expect(b.engine.status(planned.id)).toMatchObject({ status: 'failed', error: { code: 'INTERRUPTED' } });
        expect(b.journal.readAudit().entries.find(e => e.operationId === planned.id).outcome).toBe('interrupted');
        const next = await applyFeatures(b, { screenVision: true });
        expect(next.operation.status).toBe('applied');
    });

    test('the lock: one holder, stale holders reclaimed, an unreadable lock respected until it is old', () => {
        const root = newRoot('lock');
        const store = createStore({ root });
        store.init();
        let clock = Date.now();
        const now = () => new Date(clock);
        const lock = createLock({ store, now });
        const held = lock.acquire('op-a');
        expect(() => lock.acquire('op-b')).toThrow(expect.objectContaining({ code: 'OPERATION_IN_PROGRESS' }));
        held.release();
        lock.acquire('op-c');
        const fromDeadProcess = createLock({ store, now, isProcessAlive: () => false });
        fromDeadProcess.acquire('op-d').release();

        fs.writeFileSync(store.paths.lock, 'garbage');
        const fresh = createLock({ store, now });
        expect(() => fresh.acquire('op-e')).toThrow(expect.objectContaining({ code: 'OPERATION_IN_PROGRESS' }));
        clock += 11 * 60 * 1000;
        fresh.acquire('op-f').release();
        expect(fs.existsSync(store.paths.lock)).toBe(false);
    });

    test('store files are owner-only and journal writes are atomic (no temp files left)', async () => {
        const { manager } = await claimedManager();
        await applyFeatures(manager, { gba: true });
        if (process.platform === 'win32') return;
        for (const file of listFiles(manager.store.root)) {
            expect(path.basename(file)).not.toMatch(/\.tmp$/);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
        expect(fs.statSync(manager.store.root).mode & 0o777).toBe(0o700);
        expect(fs.statSync(manager.store.paths.operations).mode & 0o777).toBe(0o700);
    });
});

describe('secrets never reach the journal, the audit log or a response', () => {
    test('a full claim, setup, recovery, bridge and failure flow leaves no planted secret behind', async () => {
        const root = newRoot('secrets');
        fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ token: PLANTED, OPENAI_API_KEY: PLANTED, gbaRun: { enabled: false } }));
        const env = envFor(root, { OPENAI_API_KEY: PLANTED, DISCORD_BOT_TOKEN: PLANTED });
        const settings = resolveSettings(env);
        let failNext = false;
        const manager = createManager({
            settings,
            logger: silent,
            hooks: {
                beforeStep: ({ step }) => {
                    if (failNext && step === 'write-features') throw Object.assign(new Error(PLANTED), { code: PLANTED });
                }
            }
        });
        const booted = await manager.init();
        const app = createManagerApp(manager, { logger: silent });
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        servers.push(server);
        const port = server.address().port;
        const responses = [];
        const call = (method, reqPath, body, headers = {}) => new Promise((resolve, reject) => {
            const payload = body === undefined ? null : JSON.stringify(body);
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
                headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    responses.push({ reqPath, text: data });
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
        const nonce = () => crypto.randomBytes(12).toString('base64url');
        const secrets = [PLANTED, booted.bootstrap.credential];

        await call('GET', '/manager/api/status');
        const claimed = await call('POST', '/manager/api/claim', { credential: booted.bootstrap.credential, label: 'Rob' });
        expect(claimed.status).toBe(200);
        const setup = claimed.body.session.token;
        secrets.push(setup);
        responses.pop();
        const session = (token) => ({ authorization: `Bearer ${token}`, 'x-goobster-nonce': nonce() });
        const runOp = async (headersFor, changes) => {
            const p = await call('POST', '/manager/api/operations', { kind: 'features.set', input: { changes } }, headersFor('POST', '/manager/api/operations'));
            const id = p.body.operation.id;
            await call('POST', `/manager/api/operations/${id}/validate`, {}, headersFor('POST', `/manager/api/operations/${id}/validate`));
            return call('POST', `/manager/api/operations/${id}/apply`, { revision: p.body.operation.revision }, headersFor('POST', `/manager/api/operations/${id}/apply`));
        };
        expect((await runOp(() => session(setup), { gba: true })).status).toBe(200);

        const stdout = { text: '', write(t) { this.text += t; }, isTTY: false };
        expect((await main(['--mint-recovery'], { env, stdout, logger: silent })).code).toBe(0);
        const recoveryCredential = /Recovery credential: (\S+)/.exec(stdout.text)[1];
        secrets.push(recoveryCredential);
        const unlocked = await call('POST', '/manager/api/recovery/unlock', { credential: recoveryCredential });
        responses.pop();
        const recoveryToken = unlocked.body.session.token;
        secrets.push(recoveryToken);
        expect((await runOp(() => session(recoveryToken), { screenVision: true })).status).toBe(200);

        const minter = coreBridge.createManagerBridge({ keyFile: manager.store.paths.bridgeKey });
        const bridgeHeaders = (method, reqPath) => {
            const token = minter.mint({ actor: OPERATOR, method, path: reqPath });
            secrets.push(token);
            return { [coreBridge.ASSERTION_HEADER]: token };
        };
        expect((await runOp(bridgeHeaders, { gba: false })).status).toBe(200);
        failNext = true;
        const failed = await runOp(bridgeHeaders, { screenVision: false });
        expect(failed.status).toBe(500);
        expect(failed.body.error.code).toBe('STEP_FAILED');
        await call('GET', '/manager/api/operations', undefined, bridgeHeaders('GET', '/manager/api/operations'));
        await call('GET', '/manager/api/status');
        secrets.push(coreBridge.readBridgeKey(manager.store.paths.bridgeKey).key.toString('base64url'));

        const checked = listFiles(settings.storeDir).filter(file => path.basename(file) !== 'bridge-key');
        expect(checked.some(file => file.endsWith('audit.jsonl'))).toBe(true);
        expect(checked.filter(file => /operations[\\/][0-9a-f-]{36}\.json$/.test(file)).length).toBe(6);
        for (const file of checked) {
            const text = fs.readFileSync(file, 'utf8');
            for (const secret of secrets) expect(text.includes(secret)).toBe(false);
        }
        for (const res of responses) {
            for (const secret of secrets) expect(res.text.includes(secret)).toBe(false);
        }
    });

    test('a value under a secret-shaped key is redacted before it is journaled', () => {
        const store = createStore({ root: newRoot('scrub') });
        store.init();
        const journal = createJournal({ store });
        const record = journal.create({ kind: 'test', via: 'local', plan: { apiKey: PLANTED, nested: { OPENAI_API_KEY: PLANTED, name: 'OPENAI_API_KEY' } } });
        const text = fs.readFileSync(path.join(store.paths.operations, `${record.id}.json`), 'utf8');
        expect(text).not.toContain(PLANTED);
        expect(record.plan.apiKey).toBe('sk-…[redacted]');
        expect(record.plan.nested.name).toBe('OPENAI_API_KEY');
    });
});

describe('a missing or damaged store never adopts anything by itself', () => {
    function withAppDatabase(root) {
        const settings = resolveSettings(envFor(root));
        fs.mkdirSync(path.dirname(settings.sqlitePath), { recursive: true });
        fs.writeFileSync(settings.sqlitePath, Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.alloc(4080, 7)]));
        return settings;
    }

    test('store missing with an app database: recovery; nothing written; only recovery may adopt', async () => {
        const root = newRoot('missing');
        const settings = withAppDatabase(root);
        const before = fs.readFileSync(settings.sqlitePath);
        const manager = createManager({ settings, logger: silent });
        const booted = await manager.init();
        expect(booted.state).toMatchObject({ state: 'recovery', reason: 'MANAGER_STORE_MISSING' });
        expect(booted.bootstrap).toBeNull();
        expect(fs.existsSync(manager.store.paths.installation)).toBe(false);
        expect(fs.existsSync(manager.store.paths.bootstrap)).toBe(false);
        expect(await codeOf(manager.engine.plan('features.set', { changes: { gba: true } }, BRIDGE))).toBe('STATE_NOT_ALLOWED');
        expect(await codeOf(manager.engine.plan('adopt', { label: 'Rob' }, BRIDGE))).toBe('STATE_NOT_ALLOWED');
        expect(await codeOf(manager.engine.plan('adopt', { label: 'Rob' }, { principal: 'local:setup', via: 'setup' }))).toBe('STATE_NOT_ALLOWED');

        const recovery = { principal: 'local:recovery', via: 'recovery' };
        const planned = await manager.engine.plan('adopt', { label: 'Rob' }, recovery);
        expect(planned.plan).toMatchObject({ action: 'adopt-existing-installation', storeFile: 'missing', setAside: false, evidence: ['sqlite-file'] });
        expect(JSON.stringify(planned)).not.toContain('Rob');
        await manager.engine.validate(planned.id, recovery);
        const applied = await manager.engine.apply(planned.id, { revision: null }, recovery);
        expect(applied.operation.status).toBe('applied');
        expect(manager.currentState()).toMatchObject({ state: 'claimed' });
        expect(manager.currentState().installation).toMatchObject({ origin: 'adopt', ownerLabel: 'Rob' });
        expect(fs.existsSync(manager.store.paths.bridgeKey)).toBe(true);
        expect(fs.readFileSync(settings.sqlitePath).equals(before)).toBe(true);
    });

    test('a corrupt or unsupported installation.json: recovery; untouched until an explicit, confirmed adopt keeps it aside', async () => {
        for (const [content, reason] of [['{not json', 'MANAGER_STORE_CORRUPT'], [JSON.stringify({ version: 99 }), 'MANAGER_STORE_UNSUPPORTED']]) {
            const root = newRoot('corrupt');
            const settings = resolveSettings(envFor(root));
            fs.mkdirSync(settings.storeDir, { recursive: true });
            const file = path.join(settings.storeDir, 'installation.json');
            fs.writeFileSync(file, content);
            const manager = createManager({ settings, logger: silent });
            const booted = await manager.init();
            expect(booted.state).toMatchObject({ state: 'recovery', reason });
            expect(fs.readFileSync(file, 'utf8')).toBe(content);

            const recovery = { principal: 'local:recovery', via: 'recovery' };
            expect(await codeOf(manager.engine.plan('adopt', { label: 'Rob' }, recovery))).toBe('ADOPT_NEEDS_CONFIRMATION');
            expect(fs.readFileSync(file, 'utf8')).toBe(content);
            const planned = await manager.engine.plan('adopt', { label: 'Rob', replaceUnreadable: true }, recovery);
            await manager.engine.validate(planned.id, recovery);
            const applied = await manager.engine.apply(planned.id, { revision: null }, recovery);
            const keptAs = applied.operation.steps.find(s => s.name === 'set-aside' && s.status === 'done').detail.keptAs;
            expect(fs.readFileSync(path.join(settings.storeDir, keptAs), 'utf8')).toBe(content);
            expect(manager.currentState().state).toBe('claimed');
        }
    });
});

describe('audit reconciliation into operator_audit', () => {
    const probeDown = async () => ({ engine: db.engine, present: true, reachable: false, reason: 'APP_DB_DOWN_FOR_TEST' });

    test('never opens or creates a database that is not there', async () => {
        const root = newRoot('nodb');
        const settings = resolveSettings(envFor(root));
        const store = createStore({ root: settings.storeDir });
        store.init();
        const journal = createJournal({ store });
        await journal.appendAudit({ action: 'manager.features.set', actor: 'x', operationId: crypto.randomUUID(), outcome: 'applied' });
        const loadDb = jest.fn();
        const result = await reconcileAudit({ journal, probe: () => probeAppDatabase(settings), loadDb, loadAudit: loadDb });
        expect(result).toMatchObject({ pending: 1, inserted: 0, deferred: true, reason: 'NOT_FOUND' });
        expect(loadDb).not.toHaveBeenCalled();
        expect(fs.existsSync(settings.sqlitePath)).toBe(false);
    });

    test('records appended while the database is down are ingested exactly once', async () => {
        const dbEnv = process.env.GOOBSTER_DB_URL
            ? { GOOBSTER_DB_URL: process.env.GOOBSTER_DB_URL }
            : { GOOBSTER_DB_PATH: process.env.GOOBSTER_DB_PATH };
        const { manager, settings } = await claimedManager({ env: dbEnv });
        expect(db.engine).toBe(process.env.GOOBSTER_DB_URL ? 'postgres' : 'sqlite');
        const ops = [];
        ops.push((await applyFeatures(manager, { gba: true })).operation.id);
        ops.push((await applyFeatures(manager, { screenVision: true }, { principal: '100000000000000009', via: 'bridge' })).operation.id);

        const down = await reconcileAudit({ journal: manager.journal, probe: probeDown });
        expect(down).toMatchObject({ pending: 2, inserted: 0, deferred: true });
        const countRows = async () => (await db.all(
            `SELECT action, actor, target, detailJson FROM operator_audit WHERE target IN (${ops.map((_, i) => `@t${i}`).join(', ')})`,
            Object.fromEntries(ops.map((id, i) => [`t${i}`, id]))
        ));
        expect(await countRows()).toHaveLength(0);

        const probe = await probeAppDatabase(settings);
        expect(probe.reachable).toBe(true);
        const up = await manager.reconcile();
        expect(up).toMatchObject({ pending: 2, inserted: 2, existing: 0, deferred: false });
        const rows = await countRows();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.action).toBe('manager.features.set');
            expect(JSON.parse(row.detailJson)).toMatchObject({ source: 'manager', outcome: 'applied', via: 'bridge' });
            expect(JSON.stringify(row)).not.toContain(PLANTED);
        }
        expect(rows.map(r => r.actor).sort()).toEqual([OPERATOR.actorId, '100000000000000009'].sort());
        expect(manager.journal.readAudit().entries.every(e => typeof e.reconciledAt === 'string')).toBe(true);
        expect((await manager.status()).audit.pending).toBe(0);

        const again = await manager.reconcile();
        expect(again).toMatchObject({ pending: 0, inserted: 0 });

        const auditFile = manager.store.paths.audit;
        const stripped = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)
            .map(line => JSON.stringify({ ...JSON.parse(line), reconciledAt: null })).join('\n');
        fs.writeFileSync(auditFile, `${stripped}\n`);
        const replay = await manager.reconcile();
        expect(replay).toMatchObject({ pending: 2, inserted: 0, existing: 2 });
        expect(await countRows()).toHaveLength(2);
    });
});
