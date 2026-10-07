/**
 * Backup, restore, reset and migration through the manager's HTTP API and the
 * Host room's proxies (#337, documentation/host_operations.md and
 * documentation/backup_and_restore.md): the archive inspection and status
 * routes, the read-only maintenance reads (`/host/maintenance`,
 * `/host/reset/plan`, `/host/migrate/status`), the `backup.create`,
 * `backup.restore` and `data.reset` kinds behind `POST /host/operations`,
 * authorization (anonymous 401, member 403, nothing journaled or audited),
 * and the audit rows (`host.backup.apply`, `host.reset.apply`) that carry
 * numbers and flags and never a passphrase, a value or a path.
 *
 * A real manager runs over HTTP on loopback with the extension routes, the
 * portal is the real router with devMode sessions and the real bridge key.
 * The helper operations run in this process (`settings.backupDeps`) so the
 * same file runs on SQLite and on an isolated Postgres schema.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-maintenance-routes-'));
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DB_PATH = path.join(DATA_DIR, 'goobster.sqlite');
process.env.GOOBSTER_DB_PATH = DB_PATH;
process.env.GOOBSTER_DATA_DIR = DATA_DIR;
process.env.GOOBSTER_CONFIG_PATH = CONFIG_PATH;
process.env.GOOBSTER_CACHE_DIR = path.join(ROOT, 'cache');
for (const name of ['GOOBSTER_UPLOADS_DIR', 'GOOBSTER_KG_ARTIFACTS_DIR', 'GOOBSTER_TAVERN_CAMPAIGNS_DIR', 'GOOBSTER_SELF_DOCS_OPERATOR_DIR']) delete process.env[name];

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const eventBusService = require('@goobster/core/services/eventBusService');
const coreBridge = require('@goobster/core/web/managerBridge');
const { createFeatureState } = require('@goobster/core/features/featureState');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { createHostManagerClient } = require('@goobster/core/web/hostManagerClient');
const host = require('@goobster/core/web/routes/host');
const { ROLLBACK_LIMIT } = require('@goobster/core/db/migration');
const { createManagerApp } = require('@goobster/manager/server');
const extensions = require('@goobster/manager/extensions');
const { createBackupHarness } = require('./helpers/backupFixture');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const OPERATOR = '100000000000000001';
const MEMBER = '100000000000000003';
const BASE = host.BASE;
const PASSPHRASE = 'routes-passphrase-never-appears-3fa9';
const TOKEN_MARK = 'routes-config-token-never-appears-8c21';
const TABLES = ['operator_audit', 'account_emails', 'web_sessions', 'auth_identities', 'app_accounts', 'principals', 'users'];
const cleanups = [];
let counter = 0;

function listen(app) {
    return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

function closeServer(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

async function harness() {
    counter += 1;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ webapp: { enabled: true }, token: TOKEN_MARK }));
    const base = await createBackupHarness({
        root: path.join(ROOT, `h${counter}`),
        dataDir: DATA_DIR,
        configPath: CONFIG_PATH,
        sqlitePath: DB_PATH,
        dbUrl: process.env.GOOBSTER_DB_URL || null,
        cleanups
    });
    const { manager } = base;
    const managerServer = await listen(createManagerApp(manager, { logger: silent, mounts: extensions.routes }));
    cleanups.push(() => closeServer(managerServer));
    const managerPort = managerServer.address().port;

    const bridge = coreBridge.createManagerBridge({ keyFile: manager.store.paths.bridgeKey });
    const client = createHostManagerClient({ baseUrl: () => `http://127.0.0.1:${managerPort}`, bridge });
    const gateway = { sendDm: async () => ({}), sendToChannel: async () => ({}), listMutualGuilds: async () => [] };
    const ctx = createWebAppContext({
        gateway,
        config: { clientId: '123', guildIds: ['900000000000000001'], webapp: { enabled: true, devMode: true } },
        logger: silent,
        deps: { hostManager: client, features: createFeatureState({ filePath: base.settings.featuresPath, env: {}, config: {} }) }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    const portal = await listen(app);
    cleanups.push(() => closeServer(portal));
    const portalPort = portal.address().port;

    function request({ method = 'GET', reqPath, body, cookie, port = portalPort, headers = {} }) {
        const payload = body === undefined ? null : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request({
                agent: false, host: '127.0.0.1', port, method, path: reqPath,
                headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}), ...headers }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* not JSON */ }
                    resolve({ status: res.statusCode, headers: res.headers, json, text: data });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    const texts = [];
    async function api(cookie, method, route, body) {
        const res = await request({ method, reqPath: `${BASE}${route}`, body, cookie });
        texts.push(res.text);
        return res;
    }

    async function managerCall(method, reqPath, { body, signed = true } = {}) {
        const headers = signed ? bridge.headers({ actor: { actorId: OPERATOR, account: { role: 'operator', status: 'active' } }, method, path: reqPath.split('?')[0] }) : {};
        const res = await fetch(`http://127.0.0.1:${managerPort}${reqPath}`, {
            method,
            headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text };
    }

    return { ...base, request, api, managerCall, texts, client };
}

async function signIn(request, userId, name, role) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: name });
    if (role) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role });
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

async function auditRows(action) {
    const rows = await db.all('SELECT action, actor, target, detailJson FROM operator_audit WHERE action = @action ORDER BY id', { action });
    return rows.map(row => ({ ...row, detail: row.detailJson ? JSON.parse(row.detailJson) : null }));
}

async function seedWorld() {
    await db.run('DELETE FROM followups');
    for (const note of ['first', 'second']) {
        await db.insert(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt, status)
             VALUES ('200000000000000001', '300000000000000001', @userId, @note, '2030-01-01 00:00:00', 'PENDING')`,
            { userId: OPERATOR, note }
        );
    }
    fs.mkdirSync(path.join(DATA_DIR, 'web-uploads'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'web-uploads', 'keep.txt'), 'original\n');
}

const followups = async () => Number((await db.get('SELECT COUNT(*) AS c FROM followups')).c);

beforeAll(async () => {
    await db.get('SELECT 1 AS ok');
});

beforeEach(async () => {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
});

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

afterAll(async () => {
    await eventBusService.close();
    await db.closeConnection();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

const NEW_GETS = ['/backup/inspect?dir=%2Ftmp', '/backup/status', '/maintenance', '/reset/plan?scope=instance', '/migrate/status'];
const NEW_POSTS = [
    ['POST', '/operations', { kind: 'backup.create', input: { dir: '/tmp/x', includeConfig: false } }],
    ['POST', '/operations', { kind: 'backup.restore', input: { dir: '/tmp/x', confirm: 'x' } }],
    ['POST', '/operations', { kind: 'data.reset', input: { scope: 'instance' } }]
];

describe('authorization', () => {
    test('anonymous callers get 401 and members 403 on every new route; nothing is journaled, audited or revealed', async () => {
        const h = await harness();
        const member = await signIn(h.request, MEMBER, 'Sam');
        const before = h.manager.journal.readAudit().entries.length;
        const operations = h.manager.journal.list().length;
        for (const [method, route, body] of [...NEW_GETS.map(route => ['GET', route]), ...NEW_POSTS]) {
            const anonymous = await h.api(null, method, route, body);
            expect({ route, status: anonymous.status }).toEqual({ route, status: 401 });
            const denied = await h.api(member, method, route, body);
            expect({ route, status: denied.status, code: denied.json.error.code }).toEqual({ route, status: 403, code: 'FORBIDDEN' });
            expect(denied.text).not.toMatch(/manager|127\.0\.0\.1|bridge|backup_destination/i);
        }
        expect(h.manager.journal.readAudit().entries.length).toBe(before);
        expect(h.manager.journal.list().length).toBe(operations);
        expect(await db.all('SELECT action FROM operator_audit')).toEqual([]);
    }, 60000);
});

describe('the manager routes', () => {
    test('inspect and status need a signed read; an unknown query parameter, a missing or relative dir and a non-archive are refused with a code', async () => {
        await seedWorld();
        const h = await harness();
        const dest = path.join(h.root, 'archives');
        const { applied } = await h.drive('backup.create', { dir: dest, passphrase: PASSPHRASE });
        const dir = applied.result.dir;

        expect((await h.managerCall('GET', `/manager/api/backup/inspect?dir=${encodeURIComponent(dir)}`, { signed: false })).status).toBe(401);
        expect((await h.managerCall('GET', '/manager/api/backup/status', { signed: false })).status).toBe(401);

        const view = await h.managerCall('GET', `/manager/api/backup/inspect?dir=${encodeURIComponent(dir)}`);
        expect(view.status).toBe(200);
        expect(view.json).toMatchObject({ restorable: true, configIncluded: true, configEncrypted: true, engineMatches: true, blocks: [], integrity: { ok: true } });
        expect(view.text).not.toContain(PASSPHRASE);
        expect(view.text).not.toContain(TOKEN_MARK);

        for (const query of ['', '?dir=relative%2Fpath', `?dir=${encodeURIComponent(dir)}&extra=1`, `?dir=${encodeURIComponent(path.join(dir, '..', '..'))}`]) {
            const refused = await h.managerCall('GET', `/manager/api/backup/inspect${query}`);
            expect([query, refused.status]).toEqual([query, expect.any(Number)]);
            expect(refused.status).toBeGreaterThanOrEqual(400);
            expect(refused.status).toBeLessThan(500);
        }
        fs.mkdirSync(path.join(h.root, 'not-an-archive'));
        const notArchive = await h.managerCall('GET', `/manager/api/backup/inspect?dir=${encodeURIComponent(path.join(h.root, 'not-an-archive'))}`);
        expect(notArchive.status).toBe(409);
        expect(notArchive.json.error.code).toBe('NOT_AN_ARCHIVE');

        const status = await h.managerCall('GET', '/manager/api/backup/status');
        expect(status.json).toMatchObject({ engine: db.engine, installation: { recorded: true }, restore: null });
        expect(status.json.suggestedDir).toBe(path.join(DATA_DIR, 'backups'));
    }, 120000);
});

describe('the Host reads', () => {
    test('inspect, status, maintenance, reset plan and migration status answer an operator', async () => {
        await seedWorld();
        const h = await harness();
        const cookie = await signIn(h.request, OPERATOR, 'Rob', 'operator');
        const { applied } = await h.drive('backup.create', { dir: path.join(h.root, 'archives'), passphrase: PASSPHRASE });

        const inspect = await h.api(cookie, 'GET', `/backup/inspect?dir=${encodeURIComponent(applied.result.dir)}`);
        expect(inspect.status).toBe(200);
        expect(inspect.json).toMatchObject({ restorable: true, configIncluded: true, blocks: [] });
        expect((await h.api(cookie, 'GET', '/backup/inspect')).status).toBe(400);
        expect((await h.api(cookie, 'GET', `/backup/inspect?dir=${encodeURIComponent(path.join(h.root, 'missing'))}`)).status).toBeGreaterThanOrEqual(400);

        const status = await h.api(cookie, 'GET', '/backup/status');
        expect(status.json).toMatchObject({ installation: { recorded: true }, restore: null });

        const maintenance = await h.api(cookie, 'GET', '/maintenance');
        expect(maintenance.status).toBe(200);
        expect(maintenance.json).toMatchObject({ active: false });

        const plan = await h.api(cookie, 'GET', '/reset/plan?scope=instance');
        expect(plan.status).toBe(200);
        expect(plan.json).toMatchObject({ scope: 'instance' });
        expect(plan.json.confirm).toEqual(expect.any(String));
        for (const query of ['', '?scope=everything', '?scope=feature', '?scope=feature&feature=NOPE', '?scope=instance&extra=1']) {
            const bad = await h.api(cookie, 'GET', `/reset/plan${query}`);
            expect([query, bad.status === 400 || bad.status === 409]).toEqual([query, true]);
        }

        const migrate = await h.api(cookie, 'GET', '/migrate/status');
        expect(migrate.status).toBe(200);
        expect(migrate.json).toMatchObject({ state: 'none', rollback: { possible: false }, rollbackLimit: ROLLBACK_LIMIT });
        for (const text of h.texts) {
            expect(text).not.toContain(PASSPHRASE);
            expect(text).not.toContain(TOKEN_MARK);
        }
    }, 120000);
});

describe('backup.create through the Host', () => {
    test('plan, validate, apply: the manager keeps its record, the portal audits numbers and flags, and the passphrase is nowhere', async () => {
        await seedWorld();
        const h = await harness();
        const cookie = await signIn(h.request, OPERATOR, 'Rob', 'operator');
        const dest = path.join(h.root, 'archives');
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'backup.create', input: { dir: dest, includeConfig: true, passphrase: PASSPHRASE } });
        expect(preview.status).toBe(200);
        expect(preview.json.operation).toMatchObject({ kind: 'backup.create', status: 'validated' });
        expect(preview.json.operation.plan).toMatchObject({ effect: 'backup-create', boundary: 'read-only', archiveEncrypted: false, config: { included: true, encrypted: true } });
        expect(preview.text).not.toContain(PASSPHRASE);

        const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        expect(applied.json.result).toMatchObject({ verified: true, config: { included: true, encrypted: true }, archiveEncrypted: false });
        expect(applied.text).not.toContain(PASSPHRASE);
        expect(fs.readdirSync(dest).filter(name => name.startsWith('goobster-backup-'))).toHaveLength(1);

        const rows = await auditRows('host.backup.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: OPERATOR, target: preview.json.operation.id });
        expect(rows[0].detail).toMatchObject({ operation: 'create', configIncluded: true, verified: true });
        expect(rows[0].detail.rows).toBeGreaterThan(0);
        const stored = JSON.stringify(await db.all('SELECT * FROM operator_audit'));
        expect(stored).not.toContain(PASSPHRASE);
        expect(stored).not.toContain(TOKEN_MARK);
        expect(stored).not.toContain(h.root);

        const entries = h.manager.journal.readAudit().entries;
        expect(entries.map(entry => entry.action)).toContain('manager.backup.create');
        const journal = JSON.stringify(h.manager.journal.list()) + JSON.stringify(entries);
        expect(journal).not.toContain(PASSPHRASE);
        expect(journal).not.toContain(TOKEN_MARK);
        for (const text of h.texts) expect(text).not.toContain(PASSPHRASE);
    }, 120000);

    test('refusals pass through with the manager\'s code and write no audit row: a destination inside the data, a missing passphrase', async () => {
        await seedWorld();
        const h = await harness();
        const cookie = await signIn(h.request, OPERATOR, 'Rob', 'operator');
        const inside = await h.api(cookie, 'POST', '/operations', { kind: 'backup.create', input: { dir: path.join(DATA_DIR, 'web-uploads', 'in'), includeConfig: false } });
        expect(inside.status).toBe(409);
        expect(inside.json.error.code).toBe('BACKUP_DESTINATION_UNSAFE');
        const noPassphrase = await h.api(cookie, 'POST', '/operations', { kind: 'backup.create', input: { dir: path.join(h.root, 'archives'), includeConfig: true } });
        expect(noPassphrase.status).toBeGreaterThanOrEqual(400);
        expect(noPassphrase.status).toBeLessThan(500);
        expect(noPassphrase.json.error.code).toBe('PASSPHRASE_REQUIRED');
        expect(await auditRows('host.backup.apply')).toEqual([]);
    }, 60000);
});

describe('backup.restore through the Host', () => {
    test('a wrong passphrase is refused with nothing changed and no audit row; the right one restores, pauses, audits and says what was kept', async () => {
        await seedWorld();
        const h = await harness();
        const cookie = await signIn(h.request, OPERATOR, 'Rob', 'operator');
        const dest = path.join(h.root, 'archives');
        const made = await h.api(cookie, 'POST', '/operations', { kind: 'backup.create', input: { dir: dest, includeConfig: true, passphrase: PASSPHRASE } });
        const created = await h.api(cookie, 'POST', `/operations/${made.json.operation.id}/apply`, {});
        const dir = created.json.result.dir;

        await db.run('DELETE FROM followups');
        fs.writeFileSync(path.join(DATA_DIR, 'web-uploads', 'keep.txt'), 'changed\n');
        const configBefore = fs.readFileSync(CONFIG_PATH, 'utf8');
        const installationId = h.installationId();

        const wrong = await h.api(cookie, 'POST', '/operations', { kind: 'backup.restore', input: { dir, confirm: installationId, passphrase: 'not-the-passphrase', release: true } });
        expect(wrong.status).toBe(409);
        expect(wrong.json.error.code).toBe('BAD_PASSPHRASE');
        expect(wrong.text).not.toContain('not-the-passphrase');
        expect(await followups()).toBe(0);
        expect(fs.readFileSync(CONFIG_PATH, 'utf8')).toBe(configBefore);
        expect(fs.readFileSync(path.join(DATA_DIR, 'web-uploads', 'keep.txt'), 'utf8')).toBe('changed\n');
        expect(await auditRows('host.backup.apply')).toHaveLength(1);

        const unconfirmed = await h.api(cookie, 'POST', '/operations', { kind: 'backup.restore', input: { dir, confirm: 'not-the-id', passphrase: PASSPHRASE, release: true } });
        expect(unconfirmed.status).toBeGreaterThanOrEqual(400);
        expect(unconfirmed.status).toBeLessThan(500);
        expect(unconfirmed.json.error.code).toBe('CONFIRMATION_REQUIRED');

        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'backup.restore', input: { dir, confirm: installationId, passphrase: PASSPHRASE, release: true } });
        expect(preview.status).toBe(200);
        expect(preview.json.operation.plan).toMatchObject({
            effect: 'restore-backup',
            boundary: 'irreversible-after-mutate',
            confirmation: { required: true, satisfied: true },
            config: { restore: true },
            afterwards: { instancePaused: true, maintenance: 'released' }
        });
        expect(preview.text).not.toContain(PASSPHRASE);

        const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        expect(applied.json.result).toMatchObject({ config: { restored: true }, maintenance: { held: false } });
        expect(applied.json.result.retained.length).toBeGreaterThan(0);
        expect(applied.text).not.toContain(PASSPHRASE);
        expect(await followups()).toBe(2);
        expect(fs.readFileSync(path.join(DATA_DIR, 'web-uploads', 'keep.txt'), 'utf8')).toBe('original\n');
        expect(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).token).toBe(TOKEN_MARK);

        const rows = await auditRows('host.backup.apply');
        const restoreRow = rows.find(row => row.detail && row.detail.operation === 'restore');
        expect(restoreRow).toMatchObject({ actor: OPERATOR, target: preview.json.operation.id });
        expect(restoreRow.detail).toMatchObject({ configRestored: true, safetyBackup: true, schemaChanged: false });
        const stored = JSON.stringify(await db.all('SELECT * FROM operator_audit'));
        expect(stored).not.toContain(PASSPHRASE);
        expect(stored).not.toContain(TOKEN_MARK);
        expect(stored).not.toContain(h.root);

        const entries = h.manager.journal.readAudit().entries;
        expect(entries.map(entry => entry.action)).toContain('manager.backup.restore');
        const journal = JSON.stringify(h.manager.journal.list()) + JSON.stringify(entries);
        expect(journal).not.toContain(PASSPHRASE);
        expect(journal).not.toContain(TOKEN_MARK);

        const status = await h.api(cookie, 'GET', '/backup/status');
        expect(status.json.restore).toMatchObject({ status: 'completed' });
    }, 240000);
});

describe('data.reset through the Host', () => {
    test('a reset is not driven from the portal without a held maintenance barrier: the manager\'s code passes through and nothing is audited', async () => {
        await seedWorld();
        const h = await harness();
        const cookie = await signIn(h.request, OPERATOR, 'Rob', 'operator');
        const res = await h.api(cookie, 'POST', '/operations', {
            kind: 'data.reset',
            input: { scope: 'feature', feature: 'gba', backup: { dir: path.join(h.root, 'reset-backup'), skipConfig: true }, confirm: `${h.installationId()}:gba`, maintenance: { operationId: 'abcdef012345', fence: 1 } }
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.json.error.code).toMatch(/MAINTENANCE_NOT_HELD|FEATURE_ACTIVE|INVALID_INPUT/);
        expect(await auditRows('host.reset.apply')).toEqual([]);
        expect(await followups()).toBe(2);
        const full = await h.api(cookie, 'POST', '/operations', { kind: 'data.reset', input: { scope: 'instance', backup: { dir: path.join(h.root, 'reset-backup'), skipConfig: true }, confirm: h.installationId(), maintenance: { operationId: 'abcdef012345', fence: 1 } } });
        expect(full.status).toBeGreaterThanOrEqual(400);
        expect(await followups()).toBe(2);
    }, 60000);

    test('the proxy knows the kind and maps it to host.reset.apply, and the backup kinds to host.backup.apply', () => {
        expect(host.KINDS).toEqual(expect.arrayContaining(['backup.create', 'backup.restore', 'data.reset']));
        expect(host.MAINTENANCE_KINDS).toEqual(['backup.create', 'backup.restore', 'data.reset']);
        const operatorAudit = require('@goobster/core/services/operatorAuditService');
        expect(operatorAudit.ACTIONS.has('host.reset.apply')).toBe(true);
        expect(operatorAudit.ACTIONS.has('host.backup.apply')).toBe(true);
    });
});
