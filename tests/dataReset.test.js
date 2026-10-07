/**
 * The shared data reset (#335, documentation/data_reset.md), end to end on
 * the live engine (a throwaway SQLite file, or an isolated Postgres schema
 * when GOOBSTER_DB_URL is set): `data.reset` against a claimed manager with
 * the maintenance barrier held and a fake writer that acknowledged it, the
 * deletion plans of every feature, the refusals, failure injection at each
 * durable boundary, the audit, the CLI and the preview route.
 *
 * Every table schema.sql creates is seeded (tests/helpers/resetSeed.js), so a
 * table nobody thought about is covered by the same assertions. Everything
 * the specs delete lives under one throwaway directory; the code root and the
 * home directory are only ever passed to a guard that throws before it
 * removes anything.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { PassThrough, Readable } = require('node:stream');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-data-reset-'));
const DB_FILE = path.join(ROOT, 'test.sqlite');
process.env.GOOBSTER_DB_PATH = DB_FILE;
process.env.GOOBSTER_CACHE_DIR = path.join(ROOT, 'cache');
process.env.GOOBSTER_DATA_DIR = path.join(ROOT, 'data-unused');
delete process.env.GOOBSTER_UPLOADS_DIR;
delete process.env.GOOBSTER_KG_ARTIFACTS_DIR;
delete process.env.GOOBSTER_TAVERN_CAMPAIGNS_DIR;

const db = require('@goobster/core/db');
const featureInventory = require('@goobster/core/features/inventory');
const memoryService = require('@goobster/core/services/memoryService');
const backupService = require('@goobster/core/services/backupService');
const instanceState = require('@goobster/core/services/instanceStateService');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const inventoryModule = require('@goobster/core/db/resetInventory');
const resetModule = require('@goobster/core/db/reset');
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const extensions = require('@goobster/manager/extensions');
const resetKind = require('@goobster/manager/engine/kinds/reset');
const { createBarrier, tune } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore } = require('@goobster/manager/maintenance/store');
const paths = require('@goobster/manager/install/paths');
const cli = require('@goobster/manager/cli');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const { stateDoc } = require('./helpers/featureFixtures');
const { seedEveryTable } = require('./helpers/resetSeed');

const IS_PG = Boolean(process.env.GOOBSTER_DB_URL);
const silent = { info() {}, warn() {}, error() {} };
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const LOCAL = { principal: 'local:cli', via: 'local' };
const BRIDGE = { principal: 'owner-1', via: 'bridge' };
const PASSPHRASE = 'correct horse battery staple fixture';
const CONFIG_TEXT = JSON.stringify({ token: 'fixture-not-a-token', webapp: { enabled: true } });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const API = { name: 'api', healthUrl: 'http://127.0.0.1:9/health', external: true, pid: null, running: true, state: 'external', fenceAck: null };

const cleanups = [];
let counter = 0;
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});
afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the world */

function write(file, text = 'fixture') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

async function emptyDatabase() {
    for (const table of inventoryModule.buildInventory({ dataDir: ROOT, cacheDir: ROOT }).order) await db.run(`DELETE FROM ${table}`);
    await memoryService.cleanupVecIndex();
}

const projectOf = async d => (await d.get('SELECT id FROM observatory_projects ORDER BY id LIMIT 1')).id;
const projectNode = async d => (await d.get("SELECT id FROM kg_nodes WHERE scopeKey = 'PROJECT:1' ORDER BY id LIMIT 1")).id;
const anyNode = async d => (await d.get("SELECT id FROM kg_nodes WHERE scopeKey <> 'PROJECT:1' ORDER BY id LIMIT 1")).id;

const PLAIN_OVERRIDES = {
    memory_embeddings: { dims: 4, embedding: Buffer.from(Float32Array.from([1, 0, 0, 0.05]).buffer) },
    followed_sources: { projectId: projectOf, topicNodeId: null },
    conversation_contexts: { webConversationId: async d => (await d.get('SELECT id FROM web_conversations ORDER BY id LIMIT 1')).id, parlorConversationId: null },
    parlor_conversations: { projectId: null },
    user_integrations: { provider: 'notion' }
};

/** The second row of each shared table: the one a feature purge is meant to take. */
const MATCHING_ROWS = [
    ['kg_nodes', 'm', { scopeKey: 'PROJECT:1' }],
    ['kg_tags', 'm', { scopeKey: 'PROJECT:1' }],
    ['kg_reflection_runs', 'm', { scopeKey: 'PROJECT:1' }],
    ['kg_artifacts', 'm', { scopeKey: 'PROJECT:1', relativePath: 'kg-artifacts/project-file.bin', nodeId: projectNode }],
    ['parlor_conversations', 'm', { projectId: projectOf }],
    ['knowledge_transfers', 'm', { targetKind: 'project' }],
    ['inbox_items', 'm', { kind: 'project' }],
    ['inbox_items', 'm2', { kind: 'expedition' }],
    ['followups', 'm', { jobId: 1 }],
    ['attention_provenance', 'm', { sourceKind: 'observatory_job' }],
    ['kg_provenance', 'm', { sourceKind: 'research_claim' }],
    ['user_integrations', 'm', { provider: 'github' }],
    ['followed_sources', 'topic', { projectId: null, topicNodeId: anyNode }]
];

/** Ledger and tutorial rows that belong to a feature, one per kind. */
function ledgerRows() {
    const rows = [];
    for (const kind of Object.keys(inventoryModule.WORK_KIND_OWNER)) {
        rows.push(['work_failures', `w-${kind}`, { kind }]);
        rows.push(['resource_events', `r-${kind}`, { workKind: kind }]);
        rows.push(['usage_reservations', `u-${kind}`, { workKind: kind }]);
    }
    for (const kind of Object.keys(inventoryModule.RESOURCE_KIND_OWNER)) rows.push(['resource_events', `k-${kind}`, { kind }]);
    for (const [id, entry] of Object.entries(featureInventory.tutorials)) {
        if (entry.owner === 'core') continue;
        for (const table of ['tutorial_progress', 'tutorial_events', 'tutorial_feedback']) rows.push([table, `t-${id}`, { tutorialId: id }]);
    }
    return rows;
}

async function seedWorld(inventory) {
    const plain = await seedEveryTable(db, inventory.order, { overrides: PLAIN_OVERRIDES });
    expect(plain.failed).toEqual({});
    expect(plain.seeded).toHaveLength(inventory.order.length);
    for (const [table, variant, values] of [...MATCHING_ROWS, ...ledgerRows()]) {
        const out = await seedEveryTable(db, inventory.order, { only: [table], variant, overrides: { [table]: values } });
        expect(out.failed).toEqual({});
        expect(out.seeded).toEqual([table]);
    }
    await memoryService.syncVecIndex();
}

function seedFiles(inventory, dataDir) {
    for (const set of inventory.fileSets) {
        if (set.kind === 'file') write(set.path, '{"fixture":true}');
        else {
            write(path.join(set.path, 'seed.txt'));
            write(path.join(set.path, 'nested', 'deep.bin'));
        }
    }
    write(path.join(dataDir, 'kg-artifacts', 'project-file.bin'), 'project');
    write(path.join(dataDir, 'kg-artifacts', 'unrelated.bin'), 'unrelated');
    for (const kept of inventory.keptFileSets) write(path.join(dataDir, 'tavern', 'campaigns', `${kept.id}.yaml`), 'name: kept');
    write(path.join(dataDir, 'self-docs', 'keep.md'));
    write(path.join(dataDir, 'sandbox', 'venv', 'keep'));
    write(path.join(dataDir, 'sandbox', 'overlay', 'keep'));
}

const KEPT_FILES = (dataDir) => [
    path.join(dataDir, 'tavern', 'campaigns', 'tavern-campaigns.yaml'),
    path.join(dataDir, 'self-docs', 'keep.md'),
    path.join(dataDir, 'sandbox', 'venv', 'keep'),
    path.join(dataDir, 'sandbox', 'overlay', 'keep')
];

async function snapshotTables(names) {
    const out = {};
    for (const table of names) {
        const rows = await db.all(`SELECT * FROM ${table}`);
        out[table] = rows.map(row => JSON.stringify(row, Object.keys(row).sort())).sort();
    }
    return out;
}

const countOf = async (table, where = null) => Number((await db.get(`SELECT COUNT(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ''}`)).c);

/* ------------------------------------------------------------ the manager */

/**
 * A manager over a fresh root (claimed unless said otherwise), with the
 * reset kind wired to seams the specs can replace, and an `api` worker that
 * acknowledged the barrier.
 */
async function harness({ off = null, hooks = {}, now = () => new Date(), env = {}, claimed = true, recorded = null } = {}) {
    counter += 1;
    const root = path.join(ROOT, `h${counter}`);
    const dataDir = path.join(root, 'data');
    const configPath = path.join(root, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, CONFIG_TEXT);
    const settings = resolveSettings({
        GOOBSTER_DATA_DIR: dataDir,
        GOOBSTER_CONFIG_PATH: configPath,
        GOOBSTER_CACHE_DIR: process.env.GOOBSTER_CACHE_DIR,
        GOOBSTER_DB_PATH: DB_FILE,
        ...(process.env.GOOBSTER_DB_URL ? { GOOBSTER_DB_URL: process.env.GOOBSTER_DB_URL } : {}),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        GOOBSTER_RUNTIME_MODE: 'standalone',
        GOOBSTER_API_PORT: '9',
        ...env
    });
    tune(settings.storeDir, TUNING);
    const seams = {};
    const kindMakers = extensions.kinds.filter(make => make !== resetKind.createKinds);
    kindMakers.push(deps => resetKind.createKinds({
        ...deps,
        deps: {
            runReset: params => (seams.runReset || resetModule.runReset)(params),
            backupService: () => seams.backupService || backupService,
            db: () => seams.db || db
        }
    }));
    const manager = createManager({ settings, logger: silent, extraKinds: kindMakers, reconcileDeps: { loadDb: () => ({ get: db.get, all: db.all, run: db.run, insert: db.insert, transaction: db.transaction, engine: db.engine }) }, hooks: { beforeStep: async info => { if (hooks.beforeStep) await hooks.beforeStep(info); } }, now });
    const booted = await manager.init();
    if (recorded) {
        manager.store.createInstallation({
            origin: 'install',
            ownerLabel: 'Rob',
            install: {
                layout: 'standalone',
                roots: {
                    code: settings.root,
                    data: recorded.data || dataDir,
                    config: root,
                    cache: process.env.GOOBSTER_CACHE_DIR,
                    logs: path.join(root, 'logs'),
                    uploads: path.join(root, 'uploads'),
                    managerStore: settings.storeDir
                },
                runtimeUser: null,
                owned: { files: [], services: [], dependencies: [] },
                updater: { kind: 'none' },
                release: null,
                database: { engine: recorded.engine || (IS_PG ? 'postgres' : 'sqlite'), external: recorded.external !== false }
            }
        });
    } else if (claimed) {
        manager.store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
    }
    if (off) fs.writeFileSync(settings.featuresPath, stateDoc(off));
    cleanups.push(() => tune(settings.storeDir, null));

    const inventory = inventoryModule.buildInventory({ dataDir, cacheDir: process.env.GOOBSTER_CACHE_DIR });
    const installationId = claimed || recorded ? manager.store.readInstallation().doc.installationId : null;
    const backupDir = path.join(root, 'backups');
    const barrier = createBarrier({ settings, logger: silent, timing: TUNING });

    async function enter(operationId = `op-reset-${counter}`) {
        const { fence } = barrier.begin({ operationId, actor: 'owner-1', via: 'local', reason: 'data-reset' });
        coreMaintenance.writeFenceAck({ worker: 'api', fence, state: 'fenced', pid: 4242, env: { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir } });
        const resolved = { layout: 'standalone', targets: [API], refresh: () => [API] };
        const { writers, sent } = await barrier.quiesce({ operationId, fence, resolved, timeoutSeconds: 10, actor: 'owner-1' });
        await barrier.verify({ operationId, fence, resolved, writers, sent, actor: 'owner-1' });
        return { operationId, fence };
    }

    const doc = () => createMaintenanceStore({ storeDir: settings.storeDir }).read().doc;
    const input = (ref, extra = {}) => ({
        scope: 'instance',
        backup: { dir: backupDir, passphrase: PASSPHRASE },
        confirm: installationId,
        maintenance: ref,
        ...extra
    });
    async function plan(ref, extra = {}, auth = LOCAL) {
        return manager.engine.plan('data.reset', input(ref, extra), auth, { internal: true });
    }
    async function runKind(ref, extra = {}, auth = LOCAL) {
        const planned = await plan(ref, extra, auth);
        const validated = await manager.engine.validate(planned.id, auth);
        return manager.engine.apply(validated.id, { revision: validated.revision }, auth);
    }
    const archives = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(name => name.startsWith('goobster-backup-')) : []);
    const configHash = () => sha256(fs.readFileSync(configPath));

    return { booted, root, dataDir, configPath, settings, manager, seams, inventory, installationId, backupDir, barrier, enter, doc, input, plan, runKind, archives, configHash };
}

async function world(options) {
    await emptyDatabase();
    const h = await harness(options);
    await seedWorld(h.inventory);
    seedFiles(h.inventory, h.dataDir);
    return h;
}

function fail(promise) {
    return promise.then(() => { throw new Error('expected a refusal'); }, error => error);
}

function expectCode(error, code) {
    expect(error && error.code).toBe(code);
}

async function untouchedRows(h) {
    for (const table of h.inventory.order) expect([table, await countOf(table)]).not.toEqual([table, 0]);
}

/* ===================================================== the full instance */

describe('a full-instance reset through data.reset', () => {
    test('empties every table, the vector index and every owned file set; keeps what it says it keeps', async () => {
        const h = await world();
        const { inventory } = h;
        const keptNames = Object.keys(inventoryModule.INSTANCE_KEPT);
        expect(await resetModule.countVectors()).toBeGreaterThan(0);
        await untouchedRows(h);
        const keptBefore = await snapshotTables(keptNames);
        const auditBefore = Number((await db.get('SELECT MAX(id) AS m FROM operator_audit')).m);
        const configBefore = h.configHash();
        const storeBefore = fs.readFileSync(path.join(h.settings.storeDir, 'installation.json'), 'utf8');

        const ref = await h.enter();
        const applied = await h.runKind(ref);
        expect(applied.operation.status).toBe('applied');
        expect(applied.operation.steps.map(step => step.name)).toEqual(expect.arrayContaining(['preflight', 'backup', 'mutate', 'verify', 'cutover']));
        expect(applied.result).toMatchObject({ scope: 'instance', resumed: false, backup: { verified: true }, paused: true, barrier: 'held', next: 'maintenance.release' });

        for (const table of inventory.order) {
            if (keptNames.includes(table)) continue;
            if (table === 'instance_state') {
                expect(await countOf(table)).toBe(1);
                expect(await countOf(table, "key = 'paused'")).toBe(1);
            } else {
                expect([table, await countOf(table)]).toEqual([table, 0]);
            }
        }
        expect(await resetModule.countVectors()).toBe(0);
        expect(await resetModule.vectorOrphans()).toBe(0);
        const keptAfter = await snapshotTables(keptNames);
        expect(keptAfter.data_migrations).toEqual(keptBefore.data_migrations);
        expect(keptAfter.operator_audit).toEqual(expect.arrayContaining(keptBefore.operator_audit));
        const added = await db.all('SELECT action, detailJson FROM operator_audit WHERE id > @id', { id: auditBefore });
        expect(added.map(row => row.action)).toEqual(['instance.pause']);
        expect(JSON.parse(added[0].detailJson)).toMatchObject({ reason: 'reset' });
        expect(await instanceState.getPause()).toBeTruthy();

        for (const set of inventory.fileSets) expect([set.id, inventoryModule.countTree(set.path).files]).toEqual([set.id, 0]);
        expect(fs.existsSync(path.join(h.dataDir, 'kg-artifacts', 'project-file.bin'))).toBe(false);
        for (const kept of KEPT_FILES(h.dataDir)) expect(fs.existsSync(kept)).toBe(true);

        expect(h.configHash()).toBe(configBefore);
        expect(fs.readFileSync(path.join(h.settings.storeDir, 'installation.json'), 'utf8')).toBe(storeBefore);
        expect(h.archives()).toHaveLength(1);
        expect(h.doc()).toMatchObject({ active: true, phase: 'cutover', mutateBegun: true });
        expect(h.doc().journal.map(entry => entry.code).filter(Boolean)).toEqual(expect.arrayContaining(['BACKUP_VERIFIED', 'MUTATE_DONE', 'VERIFY_DONE', 'RESET_COMPLETE']));
    });

    test('maintenance.release then ends the barrier as completed, and the counts the result reports match what was removed', async () => {
        const h = await world();
        const before = {};
        for (const table of h.inventory.order) before[table] = await countOf(table);
        const ref = await h.enter();
        const applied = await h.runKind(ref);
        const outcome = applied.result.outcome;
        expect(outcome.vectors.before).toBeGreaterThan(0);
        expect(outcome.vectors.after).toBe(0);
        expect(outcome.files.total).toBeGreaterThan(0);
        expect([...outcome.kept].sort()).toEqual(['data_migrations', 'operator_audit']);
        for (const [table, entry] of Object.entries(outcome.tables)) expect([table, entry.before]).toEqual([table, before[table]]);
        expect(outcome.rows).toBe(Object.values(outcome.tables).reduce((sum, entry) => sum + entry.removed, 0));
        const released = await h.manager.engine.run('maintenance.release', ref, LOCAL);
        expect(released.result.outcome).toBe('completed');
        expect(h.doc().active).toBe(false);
    });

    test('the backup it took is a verified archive of the data as it was before the reset', async () => {
        const h = await world();
        const counts = await backupService.tableCounts();
        const ref = await h.enter();
        await h.runKind(ref);
        const [archive] = h.archives();
        const dir = path.join(h.backupDir, archive);
        const verified = backupService.verifyBackup(dir, { expectCounts: counts });
        for (const [table, count] of Object.entries(counts)) {
            if (backupService.COUNT_EXEMPT.has(table)) continue;
            expect([table, verified.manifest.tables[table]]).toEqual([table, count]);
        }
        expect(verified.manifest.config).toMatchObject({ included: true, encrypted: true });
        expect(fs.readFileSync(path.join(dir, verified.manifest.config.file), 'utf8')).not.toContain('fixture-not-a-token');
        expect(verified.files).toBeGreaterThan(0);
    });

    test('running the same reset again removes nothing and reports zeros (every step is idempotent)', async () => {
        const h = await world();
        const params = { inventory: h.inventory, scope: { scope: 'instance' }, removeOwned: target => paths.removeOwned(target, { codeRoot: h.settings.root }), protectedPaths: [h.settings.storeDir, h.configPath] };
        const first = await resetModule.runReset(params);
        expect(first.rows).toBeGreaterThan(0);
        const second = await resetModule.runReset(params);
        expect(second).toMatchObject({ vectors: { before: 0, after: 0 }, files: { total: 0, linked: 0 } });
        expect(await resetModule.verifyReset({ inventory: h.inventory, scope: { scope: 'instance' } })).toEqual({ ok: true, findings: [] });
    });

    test('the audit entry carries the scope and counts only, and reconciles into operator_audit', async () => {
        const h = await world();
        const ref = await h.enter();
        await h.runKind(ref);
        await h.manager.engine.run('maintenance.release', ref, LOCAL);
        const entries = h.manager.journal.readAudit().entries.filter(entry => entry.action === 'manager.data.reset');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ outcome: 'applied', via: 'local', detail: { scope: 'instance', backupVerified: true } });
        expect(Object.keys(entries[0].detail).sort()).toEqual(['backupVerified', 'files', 'scope', 'tables', 'vectors']);
        expect(entries[0].detail.tables).toBeGreaterThan(100);
        const text = JSON.stringify(entries[0]);
        for (const secret of [PASSPHRASE, h.dataDir, h.backupDir, h.root, h.installationId, 'seed-']) expect(text).not.toContain(secret);
        expect(MANAGER_AUDIT_ACTIONS).toContain('manager.data.reset');
        expect(operatorAudit.ACTIONS).toContain('manager.data.reset');

        await h.manager.reconcile();
        const row = await db.get("SELECT action, target, detailJson FROM operator_audit WHERE action = 'manager.data.reset'");
        expect(row).toMatchObject({ action: 'manager.data.reset' });
        expect(JSON.stringify(row)).not.toContain(h.dataDir);
    });

    (IS_PG ? test : test.skip)('Postgres: a sibling schema in the same database is untouched', async () => {
        const { Client } = require('pg');
        const sibling = `sibling_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        const client = new Client({ connectionString: process.env.GOOBSTER_DB_URL });
        await client.connect();
        cleanups.push(async () => { await client.query(`DROP SCHEMA IF EXISTS ${sibling} CASCADE`); await client.end(); });
        await client.query(`CREATE SCHEMA ${sibling}`);
        await client.query(`CREATE TABLE ${sibling}.users (id integer, note text)`);
        await client.query(`INSERT INTO ${sibling}.users VALUES (1, 'sibling-row')`);
        const h = await world();
        const ref = await h.enter();
        await h.runKind(ref);
        expect((await client.query(`SELECT COUNT(*)::int AS c FROM ${sibling}.users`)).rows[0].c).toBe(1);
        expect((await db.describeStorage()).schema).not.toBe(sibling);
    });
});

/* ==================================================== feature purges */

describe('a feature purge', () => {
    const FEATURES = featureInventory.FEATURE_IDS.filter(id => id !== 'core');
    const remover = h => target => paths.removeOwned(target, { codeRoot: h.settings.root });

    test.each(FEATURES)('%s: only that feature\'s data goes, foreign keys stay valid, nothing else changes', async (feature) => {
        const h = await world();
        const plan = inventoryModule.planScope(h.inventory, { scope: 'feature', feature });
        const touched = new Set([...plan.steps.map(step => step.table), ...plan.tables.cascading.map(entry => entry.table)]);
        const untouched = h.inventory.order.filter(table => !touched.has(table));
        const before = await snapshotTables(untouched);
        const partial = [];
        for (const step of plan.steps) {
            if (step.op === 'delete-where') partial.push({ step, matching: await countOf(step.table, step.where), others: await countOf(step.table, `NOT (${step.where})`) });
        }
        const setNull = plan.steps.filter(step => step.op === 'set-null');
        const setNullRows = {};
        for (const step of setNull) setNullRows[step.table] = await countOf(step.table);
        const otherFiles = h.inventory.fileSets.filter(set => set.owner !== feature).map(set => [set.id, inventoryModule.countTree(set.path).files]);

        const outcome = await resetModule.runReset({ inventory: h.inventory, scope: { scope: 'feature', feature }, removeOwned: remover(h), protectedPaths: [h.settings.storeDir, h.configPath] });
        expect(outcome).toMatchObject({ scope: 'feature', feature });

        for (const table of plan.tables.cleared) expect([table, await countOf(table)]).toEqual([table, 0]);
        for (const entry of partial) {
            expect([entry.step.table, entry.step.where, entry.matching > 0]).toEqual([entry.step.table, entry.step.where, true]);
            expect(await countOf(entry.step.table, entry.step.where)).toBe(0);
        }
        for (const step of setNull) {
            expect(await countOf(step.table, `${step.column} IS NOT NULL`)).toBe(0);
            expect(await countOf(step.table)).toBe(setNullRows[step.table]);
        }
        expect(await snapshotTables(untouched)).toEqual(before);
        expect(await resetModule.referenceViolations(h.inventory)).toEqual([]);
        expect(await resetModule.vectorOrphans()).toBe(0);
        expect(await resetModule.verifyReset({ inventory: h.inventory, scope: { scope: 'feature', feature } })).toEqual({ ok: true, findings: [] });
        for (const set of plan.files) expect(inventoryModule.countTree(set.path).files).toBe(0);
        for (const [id, files] of otherFiles) {
            const linked = feature === 'projects' && id === 'artifacts' ? 1 : 0;
            expect([id, inventoryModule.countTree(h.inventory.fileSets.find(set => set.id === id).path).files]).toEqual([id, files - linked]);
        }
        for (const kept of KEPT_FILES(h.dataDir)) expect(fs.existsSync(kept)).toBe(true);
        expect(await instanceState.getPause()).toBeFalsy();
    });

    test('the projects purge also takes the rows and the files that live in shared tables, and nothing beside them', async () => {
        const h = await world();
        await resetModule.runReset({ inventory: h.inventory, scope: { scope: 'feature', feature: 'projects' }, removeOwned: remover(h), protectedPaths: [h.settings.storeDir] });
        expect(await countOf('kg_nodes', "scopeKey LIKE 'PROJECT:%'")).toBe(0);
        expect(await countOf('kg_nodes', "scopeKey NOT LIKE 'PROJECT:%'")).toBeGreaterThan(0);
        expect(await countOf('kg_artifacts', "scopeKey LIKE 'PROJECT:%'")).toBe(0);
        expect(fs.existsSync(path.join(h.dataDir, 'kg-artifacts', 'project-file.bin'))).toBe(false);
        expect(fs.existsSync(path.join(h.dataDir, 'kg-artifacts', 'unrelated.bin'))).toBe(true);
        expect(await countOf('followed_sources', 'projectId IS NOT NULL')).toBe(0);
        expect(await countOf('followed_sources', 'topicNodeId IS NOT NULL')).toBe(1);
        expect(await countOf('observatory_jobs')).toBe(0);
        expect(await countOf('inbox_items', "kind = 'expedition'")).toBe(1);
        expect(await countOf('user_integrations', "provider = 'github'")).toBe(1);
    });

    test('the expeditions purge keeps a followed source\'s entries and only clears their expedition link', async () => {
        const h = await world();
        expect(await countOf('followed_source_entries', 'expeditionId IS NOT NULL')).toBe(1);
        await resetModule.runReset({ inventory: h.inventory, scope: { scope: 'feature', feature: 'expeditions' }, removeOwned: remover(h), protectedPaths: [] });
        expect(await countOf('followed_source_entries')).toBe(1);
        expect(await countOf('followed_source_entries', 'expeditionId IS NOT NULL')).toBe(0);
        expect(await countOf('kg_provenance', "sourceKind IN ('research_claim', 'research_source', 'expedition')")).toBe(0);
        expect(await countOf('kg_provenance', "sourceKind = 'memory'")).toBe(1);
    });

    test('through the kind: a dormant feature is purged after a verified backup, the barrier is left at cutover, and the instance is not paused', async () => {
        const h = await world({ off: ['tavern'] });
        const others = h.inventory.order.filter(table => h.inventory.byName.get(table).owner !== 'tavern');
        const before = await snapshotTables(others);
        const ref = await h.enter();
        const applied = await h.runKind(ref, { scope: 'feature', feature: 'tavern', confirm: `${h.installationId}:tavern` }, BRIDGE);
        expect(applied.result).toMatchObject({ scope: 'feature', feature: 'tavern', backup: { verified: true }, paused: false });
        const tavern = h.inventory.tables.filter(table => table.owner === 'tavern').map(table => table.name);
        for (const table of tavern) expect([table, await countOf(table)]).toEqual([table, 0]);
        expect(await snapshotTables(others)).toEqual(before);
        expect(inventoryModule.countTree(h.inventory.fileSets.find(set => set.id === 'tavern-assets').path).files).toBe(0);
        expect(inventoryModule.countTree(h.inventory.fileSets.find(set => set.id === 'uploads').path).files).toBeGreaterThan(0);
        expect(await instanceState.getPause()).toBeFalsy();
        expect(h.doc()).toMatchObject({ phase: 'cutover' });
        const entry = h.manager.journal.readAudit().entries.find(item => item.action === 'manager.data.reset');
        expect(entry.detail).toMatchObject({ scope: 'feature', feature: 'tavern', backupVerified: true });
        await h.manager.engine.run('maintenance.release', ref, BRIDGE);
    });

    test('re-enabling a purged feature works: its tables accept data again and the feature reads as active', async () => {
        const h = await world({ off: ['tavern'] });
        const ref = await h.enter();
        await h.runKind(ref, { scope: 'feature', feature: 'tavern', confirm: `${h.installationId}:tavern` }, BRIDGE);
        await h.manager.engine.run('maintenance.release', ref, BRIDGE);
        fs.writeFileSync(h.settings.featuresPath, stateDoc([]));
        expect(h.manager.createFeatureState().isActive('tavern')).toBe(true);
        const tavern = h.inventory.tables.filter(table => table.owner === 'tavern').map(table => table.name);
        const out = await seedEveryTable(db, h.inventory.order, { only: tavern, variant: 'again', overrides: PLAIN_OVERRIDES });
        expect(out.failed).toEqual({});
        expect([...out.seeded].sort()).toEqual([...tavern].sort());
    });
});

/* ================================================================ refusals */

describe('refusals', () => {
    async function untouched(h) {
        await untouchedRows(h);
        expect(await resetModule.countVectors()).toBeGreaterThan(0);
        expect(inventoryModule.countTree(h.inventory.fileSets.find(set => set.id === 'uploads').path).files).toBeGreaterThan(0);
    }

    test('no backup, or one that cannot be located, is refused before anything is read or changed', async () => {
        const h = await world();
        const ref = await h.enter();
        for (const backup of [undefined, null, {}, { dir: 'relative/dir' }, { dir: '/tmp/../etc' }]) {
            const error = await fail(h.plan(ref, { backup }));
            expect(['BACKUP_REQUIRED', 'INVALID_INPUT']).toContain(error.code);
        }
        expectCode(await fail(h.plan(ref, { backup: { dir: h.backupDir } }).then(async planned => h.manager.engine.validate(planned.id, LOCAL))), 'PASSPHRASE_REQUIRED');
        expect(h.archives()).toEqual([]);
        await untouched(h);
        expect(h.doc().phase).toBe('quiesced');
    });

    test('a backup that cannot be verified stops the reset: nothing changes and the barrier is still releasable', async () => {
        const h = await world();
        const ref = await h.enter();
        h.seams.backupService = {
            createBackup: async (params) => {
                const created = await backupService.createBackup(params);
                const file = path.join(created.dir, 'manifest.json');
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                manifest.tables.users += 1;
                fs.writeFileSync(file, JSON.stringify(manifest));
                return created;
            },
            verifyBackup: backupService.verifyBackup,
            tableCounts: backupService.tableCounts
        };
        expectCode(await fail(h.runKind(ref)), 'BACKUP_UNVERIFIED');
        await untouched(h);
        expect(h.doc()).toMatchObject({ phase: 'backup', mutateBegun: false });
        expect(h.doc().journal.map(entry => entry.code)).not.toContain('BACKUP_VERIFIED');
        expect((await h.manager.engine.run('maintenance.release', ref, LOCAL)).result.outcome).toBe('released');
    });

    test('a backup that cannot be written (unwritable destination) stops the reset the same way', async () => {
        const h = await world();
        const ref = await h.enter();
        write(path.join(h.root, 'not-a-dir'), 'file');
        expectCode(await fail(h.runKind(ref, { backup: { dir: path.join(h.root, 'not-a-dir', 'inside'), passphrase: PASSPHRASE } })), 'BACKUP_FAILED');
        await untouched(h);
        expect(h.doc().mutateBegun).toBe(false);
    });

    test('a backup destination inside the data being removed, or inside the manager store, is refused', async () => {
        const h = await world();
        const ref = await h.enter();
        for (const dir of [path.join(h.dataDir, 'web-uploads', 'backups'), path.join(h.settings.storeDir, 'backups')]) {
            expectCode(await fail(h.plan(ref, { backup: { dir, passphrase: PASSPHRASE } })), 'BACKUP_DESTINATION_UNSAFE');
        }
        await untouched(h);
    });

    test('the wrong confirmation, or none, is refused; so is another feature\'s confirmation', async () => {
        const h = await world({ off: ['tavern'] });
        const ref = await h.enter();
        for (const confirm of ['', 'wrong', h.installationId.toUpperCase(), `${h.installationId} `]) {
            const planned = await h.plan(ref, { confirm });
            expectCode(await fail(h.manager.engine.validate(planned.id, LOCAL)), 'CONFIRMATION_REQUIRED');
        }
        const feature = await h.plan(ref, { scope: 'feature', feature: 'tavern', confirm: h.installationId }, BRIDGE);
        expectCode(await fail(h.manager.engine.validate(feature.id, BRIDGE)), 'CONFIRMATION_REQUIRED');
        const other = await h.plan(ref, { scope: 'feature', feature: 'tavern', confirm: `${h.installationId}:economy` }, BRIDGE);
        expectCode(await fail(h.manager.engine.validate(other.id, BRIDGE)), 'CONFIRMATION_REQUIRED');
        await untouched(h);
        expect(h.archives()).toEqual([]);
    });

    test('a stale plan (older than its time to live) and a changed barrier are refused at apply', async () => {
        let clock = Date.now();
        const h = await world({ now: () => new Date(clock) });
        const ref = await h.enter();
        const planned = await h.plan(ref);
        const validated = await h.manager.engine.validate(planned.id, LOCAL);
        clock += 16 * 60 * 1000;
        expectCode(await fail(h.manager.engine.apply(validated.id, { revision: validated.revision }, LOCAL)), 'PLAN_EXPIRED');
        clock = Date.now();

        const second = await h.plan(ref);
        const checked = await h.manager.engine.validate(second.id, LOCAL);
        h.barrier.advance({ operationId: ref.operationId, fence: ref.fence, to: 'backup' });
        h.barrier.advance({ operationId: ref.operationId, fence: ref.fence, to: 'quiesced' });
        expectCode(await fail(h.manager.engine.apply(checked.id, { revision: checked.revision }, LOCAL)), 'REVISION_CONFLICT');
        expectCode(await fail(h.plan(ref, { expectedRevision: 0 })), 'REVISION_CONFLICT');
        await untouched(h);
    });

    test('a foreign database is refused: another sqlite path or database url, another engine', async () => {
        const h = await world({ env: { GOOBSTER_DB_PATH: path.join(ROOT, 'some-other.sqlite'), ...(IS_PG ? { GOOBSTER_DB_URL: 'postgres://u:p@elsewhere.invalid:5432/other' } : {}) } });
        const ref = await h.enter();
        const error = await fail(h.plan(ref));
        expectCode(error, 'FOREIGN_TARGET');
        expect(JSON.stringify(error)).not.toContain('elsewhere.invalid');
        await untouched(h);

        const wrongEngine = await world();
        wrongEngine.seams.db = { ...db, engine: IS_PG ? 'sqlite' : 'postgres', describeStorage: db.describeStorage };
        const ref2 = await wrongEngine.enter();
        expectCode(await fail(wrongEngine.plan(ref2)), 'FOREIGN_TARGET');
        await untouched(wrongEngine);
    });

    test('an installation record that names another data root or another engine is refused; one that matches is accepted', async () => {
        const otherRoot = await world({ recorded: { data: path.join(ROOT, 'another-installation') } });
        expectCode(await fail(otherRoot.plan(await otherRoot.enter())), 'FOREIGN_TARGET');
        await untouched(otherRoot);

        const otherEngine = await world({ recorded: { engine: IS_PG ? 'sqlite' : 'postgres' } });
        expectCode(await fail(otherEngine.plan(await otherEngine.enter())), 'FOREIGN_TARGET');
        await untouched(otherEngine);

        const matching = await world({ recorded: {} });
        const ref = await matching.enter();
        const applied = await matching.runKind(ref);
        expect(applied.result).toMatchObject({ scope: 'instance', backup: { verified: true } });
        expect(await countOf('users')).toBe(0);

        if (!IS_PG) {
            const outside = await world({ recorded: { external: false } });
            expectCode(await fail(outside.plan(await outside.enter())), 'FOREIGN_TARGET');
            await untouched(outside);
        }
    });

    test('maintenance not held, held by someone else, or without every writer acknowledged, is refused', async () => {
        const h = await world();
        expectCode(await fail(h.plan({ operationId: 'nobody', fence: 1 })), 'MAINTENANCE_NOT_HELD');

        const ref = await h.enter();
        expectCode(await fail(h.plan({ ...ref, fence: ref.fence + 1 })), 'MAINTENANCE_NOT_HELD');
        expectCode(await fail(h.plan({ operationId: 'someone-else', fence: ref.fence })), 'MAINTENANCE_NOT_HELD');

        const file = path.join(h.settings.storeDir, 'maintenance.json');
        const original = fs.readFileSync(file, 'utf8');
        const edited = JSON.parse(original);
        edited.writers.api.acked = false;
        fs.writeFileSync(file, JSON.stringify(edited));
        const error = await fail(h.plan(ref));
        expectCode(error, 'WRITER_UNACKNOWLEDGED');
        expect(error.details).toMatchObject({ writers: ['api'] });
        delete edited.writers.api;
        fs.writeFileSync(file, JSON.stringify(edited));
        expectCode(await fail(h.plan(ref)), 'WRITER_UNACKNOWLEDGED');

        const stale = JSON.parse(original);
        stale.owner = { pid: stale.owner.pid, bootId: 'a-previous-manager-boot' };
        fs.writeFileSync(file, JSON.stringify(stale));
        expectCode(await fail(h.plan(ref)), 'MAINTENANCE_NOT_HELD');
        await untouched(h);
    });

    test('a barrier that is only begun (not yet quiesced) does not count as held', async () => {
        const h = await world();
        const { fence } = h.barrier.begin({ operationId: 'op-early', actor: 'owner-1', via: 'local', reason: 'data-reset' });
        expectCode(await fail(h.plan({ operationId: 'op-early', fence })), 'MAINTENANCE_NOT_HELD');
        await untouched(h);
    });

    test('an active feature is refused, and so are core, an unknown feature and a malformed scope', async () => {
        const h = await world({ off: [] });
        const ref = await h.enter();
        expectCode(await fail(h.plan(ref, { scope: 'feature', feature: 'tavern', confirm: `${h.installationId}:tavern` }, BRIDGE)), 'FEATURE_ACTIVE');
        expectCode(await fail(h.plan(ref, { scope: 'feature', feature: 'core' }, BRIDGE)), 'CORE_NOT_PURGEABLE');
        expectCode(await fail(h.plan(ref, { scope: 'feature', feature: 'nonesuch' }, BRIDGE)), 'UNKNOWN_FEATURE');
        for (const extra of [{ scope: 'schema' }, { scope: 'feature' }, { scope: 'instance', feature: 'tavern' }, { surprise: true }, { scope: 'feature', feature: '../x' }]) {
            expectCode(await fail(h.plan(ref, extra, BRIDGE)), 'INVALID_INPUT');
        }
        await untouched(h);
    });

    test('a feature that turned active between plan and apply is refused at apply', async () => {
        const h = await world({ off: ['tavern'] });
        const ref = await h.enter();
        const planned = await h.plan(ref, { scope: 'feature', feature: 'tavern', confirm: `${h.installationId}:tavern` }, BRIDGE);
        const validated = await h.manager.engine.validate(planned.id, BRIDGE);
        fs.writeFileSync(h.settings.featuresPath, stateDoc([]));
        expectCode(await fail(h.manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE)), 'FEATURE_ACTIVE');
        await untouched(h);
        expect(h.archives()).toEqual([]);
    });

    test('a full-instance reset needs the local CLI or the recovery credential; a bridge session may only purge a dormant feature', async () => {
        const h = await world({ off: ['tavern'] });
        const ref = await h.enter();
        const planned = await h.plan(ref, {}, BRIDGE);
        expectCode(await fail(h.manager.engine.validate(planned.id, BRIDGE)), 'INSTANCE_RESET_REQUIRES_LOCAL');
        const recovery = { principal: 'owner-1', via: 'recovery' };
        const allowed = await h.plan(ref, {}, recovery);
        await expect(h.manager.engine.validate(allowed.id, recovery)).resolves.toBeTruthy();
        await untouched(h);
    });

    test('an unclaimed installation does not run a reset', async () => {
        const h = await world({ claimed: false });
        const error = await fail(h.plan({ operationId: 'x', fence: 1 }));
        expect(error.status === 403 || error.status === 409).toBe(true);
        await untouched(h);
    });

    test('a file set outside the installation roots is refused rather than removed', async () => {
        const h = await world();
        const stray = path.join(ROOT, 'stray-set');
        write(path.join(stray, 'precious.txt'));
        const inventory = { ...h.inventory, fileSets: [...h.inventory.fileSets, { id: 'stray', owner: 'core', label: 'stray', path: stray, kind: 'dir', inBackup: false }] };
        await expect(resetModule.runReset({ inventory, scope: { scope: 'instance' }, removeOwned: () => true, protectedPaths: [] }))
            .rejects.toMatchObject({ code: 'FILE_SET_UNSAFE' });
        expect(fs.existsSync(path.join(stray, 'precious.txt'))).toBe(true);
        await untouched(h);
    });

    test('the removal guard refuses a root, the home directory, the code root itself, a parent of it and a symbolic link (it only checks: nothing is removed)', () => {
        const codeRoot = path.join(ROOT, 'guard', 'code');
        const target = path.join(ROOT, 'guard', 'link-target');
        write(path.join(target, 'keep.txt'));
        fs.mkdirSync(codeRoot, { recursive: true });
        const link = path.join(ROOT, 'guard', 'link');
        fs.symlinkSync(target, link);
        for (const refused of [path.parse(ROOT).root, path.dirname(ROOT).split(path.sep).slice(0, 2).join(path.sep) || '/x', os.homedir(), codeRoot, path.dirname(codeRoot), link]) {
            expect(() => paths.assertRemovable(refused, { codeRoot })).toThrow(expect.objectContaining({ code: 'PATH_ESCAPE' }));
        }
        expect(() => paths.removeOwned(link, { codeRoot })).toThrow(expect.objectContaining({ code: 'PATH_ESCAPE' }));
        expect(() => paths.removeOwned(codeRoot, { codeRoot })).toThrow(expect.objectContaining({ code: 'PATH_ESCAPE' }));
        expect(fs.existsSync(codeRoot)).toBe(true);
        expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
    });

    test('the kind never lets a file set contain the code root, the manager store, the config or the database file', async () => {
        const h = await world();
        const hold = { ...h.inventory, allowedRoots: [...h.inventory.allowedRoots, path.dirname(h.settings.root)] };
        for (const protectedPath of [h.settings.root, h.settings.storeDir, h.configPath]) {
            const set = { id: 'bad', owner: 'core', label: 'bad', path: path.dirname(protectedPath), kind: 'dir', inBackup: false };
            expect(() => inventoryModule.assertFileSetsSafe([set], [protectedPath], hold.allowedRoots)).toThrow(expect.objectContaining({ code: 'FILE_SET_UNSAFE' }));
        }
    });
});

/* ======================================================== failure injection */

describe('failure injection and resume', () => {
    function failAt(step, error = new Error('injected')) {
        const state = { armed: true };
        return { state, hook: async (info) => { if (state.armed && info.step === step && info.kind === 'data.reset') { state.armed = false; throw error; } } };
    }

    test('between backup and mutate: nothing was changed, the verified backup is recorded, the barrier is releasable', async () => {
        const injection = failAt('mutate');
        const h = await world({ hooks: { beforeStep: injection.hook } });
        const before = await snapshotTables(h.inventory.order.filter(table => table !== 'instance_state'));
        const ref = await h.enter();
        await fail(h.runKind(ref));
        expect(await snapshotTables(Object.keys(before))).toEqual(before);
        expect(h.doc()).toMatchObject({ phase: 'backup', mutateBegun: false });
        expect(h.doc().journal.map(entry => entry.code)).toContain('BACKUP_VERIFIED');
        expect(h.archives()).toHaveLength(1);
        expect((await h.manager.engine.run('maintenance.release', ref, LOCAL)).result.outcome).toBe('released');
    });

    test('a run again after that failure takes a second backup (the barrier never reached mutate) and completes', async () => {
        const injection = failAt('mutate');
        const h = await world({ hooks: { beforeStep: injection.hook } });
        const ref = await h.enter();
        await fail(h.runKind(ref));
        const again = await h.runKind(ref, { backup: { dir: path.join(h.root, 'backups-2'), passphrase: PASSPHRASE } });
        expect(again.result).toMatchObject({ resumed: false, backup: { verified: true } });
        expect(await countOf('users')).toBe(0);
        expect((await h.manager.engine.run('maintenance.release', ref, LOCAL)).result.outcome).toBe('completed');
    });

    test.each([
        ['verify', 'mutate'],
        ['cutover', 'verify']
    ])('between mutate and %s: the data is reset, the barrier stays at %s, and running again resumes without a second backup', async (step, phase) => {
        const injection = failAt(step);
        const h = await world({ hooks: { beforeStep: injection.hook } });
        const ref = await h.enter();
        await fail(h.runKind(ref));
        expect(h.doc()).toMatchObject({ phase, mutateBegun: true, active: true });
        expect(await countOf('users')).toBe(0);
        await expect(h.manager.engine.run('maintenance.release', ref, LOCAL)).rejects.toMatchObject({ code: 'MUTATION_NOT_COMPLETE' });
        expect(h.archives()).toHaveLength(1);

        const resumed = await h.runKind(ref);
        expect(resumed.result).toMatchObject({ resumed: true, backup: { verified: true }, paused: true });
        expect(h.archives()).toHaveLength(1);
        expect(h.doc()).toMatchObject({ phase: 'cutover' });
        expect((await h.manager.engine.run('maintenance.release', ref, LOCAL)).result.outcome).toBe('completed');
        expect(await resetModule.verifyReset({ inventory: h.inventory, scope: { scope: 'instance' } })).toEqual({ ok: true, findings: [] });
    });

    test('after verify: a failure at cutover is audited as failed and still carries the verified backup', async () => {
        const injection = failAt('cutover');
        const h = await world({ hooks: { beforeStep: injection.hook } });
        const ref = await h.enter();
        await fail(h.runKind(ref));
        const failed = h.manager.journal.readAudit().entries.filter(entry => entry.action === 'manager.data.reset').at(-1);
        expect(failed.outcome).toBe('failed');
        expect(failed.detail).toMatchObject({ scope: 'instance', backupVerified: true });
    });

    test('a reset that throws part way (after files and rows began to go) stays under the barrier and finishes on the next run', async () => {
        const h = await world();
        const real = resetModule.runReset;
        h.seams.runReset = async (params) => {
            await real({ ...params, scope: { scope: 'feature', feature: 'tavern' } });
            throw new Error('disk went away');
        };
        const ref = await h.enter();
        const error = await fail(h.runKind(ref));
        expectCode(error, 'RESET_FAILED');
        expect(JSON.stringify(error)).not.toContain('disk went away');
        expect(h.doc()).toMatchObject({ phase: 'mutate', mutateBegun: true });
        expect(h.doc().journal.map(entry => entry.code)).toContain('MUTATE_FAILED');
        expect(await countOf('users')).toBeGreaterThan(0);

        h.seams.runReset = null;
        const resumed = await h.runKind(ref);
        expect(resumed.result).toMatchObject({ resumed: true });
        expect(await countOf('users')).toBe(0);
        expect(h.archives()).toHaveLength(1);
    });

    test('a verification that finds leftovers fails the reset and keeps the barrier up', async () => {
        const h = await world();
        const real = resetModule.runReset;
        h.seams.runReset = async (params) => {
            const out = await real(params);
            await db.run("INSERT INTO users (discordUsername, discordId, username) VALUES ('late', '720000000000000001', 'late')");
            return out;
        };
        const ref = await h.enter();
        const error = await fail(h.runKind(ref));
        expectCode(error, 'VERIFY_FAILED');
        expect(error.details.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ROWS_REMAINING', table: 'users' })]));
        expect(JSON.stringify(error)).not.toContain('late');
        expect(h.doc()).toMatchObject({ phase: 'verify', mutateBegun: true });
    });

    test('a manager that restarted after the mutate began leaves a stale barrier: only a forced, acknowledged release lifts it, and a second reset then runs clean', async () => {
        const injection = failAt('verify');
        const h = await world({ hooks: { beforeStep: injection.hook } });
        const ref = await h.enter();
        await fail(h.runKind(ref));
        const file = path.join(h.settings.storeDir, 'maintenance.json');
        const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
        stale.owner = { pid: stale.owner.pid, bootId: 'the-previous-manager' };
        fs.writeFileSync(file, JSON.stringify(stale));
        expectCode(await fail(h.plan(ref)), 'MAINTENANCE_NOT_HELD');
        expectCode(await fail(h.manager.engine.run('maintenance.release', ref, LOCAL)), 'STALE_MAINTENANCE');
        const released = await h.manager.engine.run('maintenance.release', { ...ref, force: true, acknowledgeMutation: true }, LOCAL);
        expect(released.result.outcome).toBe('abandoned');
        expect(h.doc().active).toBe(false);

        const second = await h.enter('op-second');
        const done = await h.runKind(second, { backup: { dir: path.join(h.root, 'backups-2'), passphrase: PASSPHRASE } });
        expect(done.result).toMatchObject({ resumed: false, backup: { verified: true } });
        expect((await h.manager.engine.run('maintenance.release', second, LOCAL)).result.outcome).toBe('completed');
    });
});

/* ================================================================ verifyBackup */

describe('verifyBackup', () => {
    const problemsOf = (run) => {
        try {
            run();
        } catch (error) {
            expect(error.code).toBe('UNVERIFIED');
            return error.problems;
        }
        throw new Error('expected the backup to be refused');
    };

    test('accepts what createBackup wrote, and names what is wrong when a count, the fingerprint, a file set or the snapshot does not match', async () => {
        await emptyDatabase();
        counter += 1;
        const data = path.join(ROOT, `verify-data-${counter}`);
        write(path.join(data, 'images', 'one.png'));
        const created = await backupService.createBackup({ destDir: path.join(ROOT, `verify-${counter}`), includeConfig: false, dataDir: data, logger: silent });
        const live = await backupService.tableCounts();
        expect(backupService.verifyBackup(created.dir, { expectCounts: live })).toMatchObject({ files: 1 });
        expect(backupService.verifyBackup(created.dir).tables).toBeGreaterThan(100);

        expect(problemsOf(() => backupService.verifyBackup(created.dir, { expectCounts: { ...live, users: live.users + 1 } }))).toEqual(['COUNT_MISMATCH:users']);
        expect(backupService.verifyBackup(created.dir, { expectCounts: { ...live, operator_audit: 99 } })).toBeTruthy();
        expect(problemsOf(() => backupService.verifyBackup(created.dir, { expectFingerprint: 'not-this-schema' }))).toEqual(['FINGERPRINT_MISMATCH']);

        fs.writeFileSync(path.join(created.dir, 'files', 'images', 'two.png'), 'extra');
        expect(problemsOf(() => backupService.verifyBackup(created.dir))).toEqual(['FILES_COUNT:images']);
        fs.rmSync(path.join(created.dir, 'files', 'images'), { recursive: true, force: true });
        expect(problemsOf(() => backupService.verifyBackup(created.dir))).toEqual(['FILES_MISSING:images']);

        const manifest = JSON.parse(fs.readFileSync(path.join(created.dir, 'manifest.json'), 'utf8'));
        fs.rmSync(path.join(created.dir, manifest.database.file));
        expect(() => backupService.verifyBackup(created.dir)).toThrow(expect.objectContaining({ code: 'BAD_MANIFEST' }));
        expect(() => backupService.verifyBackup(path.join(ROOT, 'no-such-archive'))).toThrow(expect.objectContaining({ code: 'NOT_AN_ARCHIVE' }));
    });
});

/* =============================================================== the route */

function request(port, reqPath, { method = 'GET', headers = {}, body } = {}) {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            agent: false,
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { }
                resolve({ status: res.statusCode, body: json, text: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('GET /manager/api/reset/plan', () => {
    test('shows the plan for a scope with names and counts and the text to type, needs a session, and changes nothing', async () => {
        const h = await world({ off: ['tavern'], claimed: false });
        const app = createManagerApp(h.manager, { logger: silent, mounts: extensions.routes });
        const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
        const { port } = server.address();
        const installation = h.manager.store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
        const installationId = installation.installationId;
        const auth = { authorization: `Bearer ${h.manager.sessions.issue({ kind: 'recovery' }).token}` };

        expect((await request(port, '/manager/api/reset/plan?scope=instance')).status).toBe(401);

        const instance = await request(port, '/manager/api/reset/plan?scope=instance', { headers: auth });
        expect(instance.status).toBe(200);
        expect(instance.body).toMatchObject({ scope: 'instance', confirm: installationId, derived: { vectorIndex: true }, steps: ['preflight', 'backup', 'mutate', 'verify', 'cutover'] });
        expect(instance.body.tables.kept.map(item => item.table).sort()).toEqual(['data_migrations', 'operator_audit']);
        expect(instance.body.tables.recreated.map(item => item.table).sort()).toEqual(['instance_state', 'self_docs']);
        expect(instance.body.files.map(set => set.id)).toEqual(expect.arrayContaining(['projects', 'uploads', 'tavern-assets']));
        expect(instance.text).not.toContain(h.dataDir);
        expect(instance.text).not.toContain(ROOT);

        const feature = await request(port, '/manager/api/reset/plan?scope=feature&feature=tavern', { headers: auth });
        expect(feature.body).toMatchObject({ scope: 'feature', feature: 'tavern', confirm: `${installationId}:tavern`, featureActive: false });
        const active = await request(port, '/manager/api/reset/plan?scope=feature&feature=economy', { headers: auth });
        expect(active.body).toMatchObject({ feature: 'economy', featureActive: true });

        expect((await request(port, '/manager/api/reset/plan?scope=feature&feature=core', { headers: auth })).status).toBe(400);
        expect((await request(port, '/manager/api/reset/plan?scope=feature', { headers: auth })).status).toBe(400);
        expect((await request(port, '/manager/api/reset/plan?scope=instance&extra=1', { headers: auth })).status).toBe(400);
        await untouchedRows(h);
    });
});

/* ================================================================ the CLI */

async function runCli(argv, { env, lines = [] } = {}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = [];
    const err = [];
    stdout.on('data', chunk => out.push(chunk));
    stderr.on('data', chunk => err.push(chunk));
    const stdin = Readable.from(lines.map(line => `${line}\n`));
    const exitCode = await cli.run(argv, { env, stdin, stdout, stderr });
    return { exitCode, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

function cliEnv(h) {
    return {
        PATH: process.env.PATH,
        HOME: h.root,
        GOOBSTER_DATA_DIR: h.dataDir,
        GOOBSTER_CONFIG_PATH: h.configPath,
        GOOBSTER_CACHE_DIR: process.env.GOOBSTER_CACHE_DIR,
        GOOBSTER_DB_PATH: DB_FILE,
        ...(process.env.GOOBSTER_DB_URL ? { GOOBSTER_DB_URL: process.env.GOOBSTER_DB_URL } : {}),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        GOOBSTER_RUNTIME_MODE: 'standalone',
        GOOBSTER_API_PORT: '9'
    };
}

function answers(h, doc, mode = 0o600) {
    const file = path.join(h.root, 'answers.json');
    fs.writeFileSync(file, JSON.stringify(doc), { mode });
    fs.chmodSync(file, mode);
    return file;
}

describe('the command line', () => {
    test('--dry-run prints the plan and the text to type, and changes nothing (no database, no barrier)', async () => {
        const h = await world({ off: ['tavern'] });
        const result = await runCli(['reset', '--scope', 'feature', '--feature', 'tavern', '--dry-run', '--json'], { env: cliEnv(h) });
        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({ command: 'reset', dryRun: true, plan: { scope: 'feature', feature: 'tavern', confirm: `${h.installationId}:tavern` } });
        expect(result.stdout).not.toContain(h.dataDir);
        expect(h.doc().active).toBe(false);
        const text = await runCli(['reset', '--scope', 'instance', '--dry-run'], { env: cliEnv(h) });
        expect(text.stdout).toContain(`confirm    type ${h.installationId}`);
        await untouchedRows(h);
    });

    test('an answers file with the passphrase and a typed confirmation resets the instance, enters and releases the barrier, and never prints the passphrase', async () => {
        const h = await world();
        const file = answers(h, { command: 'reset', scope: 'instance', backup: { dir: h.backupDir, passphrase: PASSPHRASE }, confirm: h.installationId });
        const result = await runCli(['reset', '--answers', file, '--json'], { env: cliEnv(h) });
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(PASSPHRASE);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'reset', operation: { kind: 'data.reset', status: 'applied' }, result: { scope: 'instance', paused: true, backup: { verified: true } } });
        expect(await countOf('users')).toBe(0);
        expect(h.doc()).toMatchObject({ active: false, lastOutcome: { outcome: 'completed' } });
        expect(h.archives()).toHaveLength(1);
        expect(h.configHash()).toBe(sha256(CONFIG_TEXT));
    });

    test('a wrong confirmation exits 2 with nothing changed, the barrier released and no archive written', async () => {
        const h = await world();
        const file = answers(h, { command: 'reset', scope: 'instance', backup: { dir: h.backupDir, passphrase: PASSPHRASE }, confirm: 'not-the-installation' });
        const result = await runCli(['reset', '--answers', file], { env: cliEnv(h) });
        expect(result.exitCode).toBe(2);
        expect(result.stdout + result.stderr).not.toContain(PASSPHRASE);
        expect(result.stderr).toContain('CONFIRMATION_REQUIRED');
        await untouchedRows(h);
        expect(h.doc().active).toBe(false);
        expect(h.archives()).toEqual([]);
    });

    test('no typed confirmation without a terminal is refused, and a passphrase on the command line is not accepted', async () => {
        const h = await world();
        const file = answers(h, { command: 'reset', scope: 'instance', backup: { dir: h.backupDir, passphrase: PASSPHRASE } });
        const missing = await runCli(['reset', '--answers', file, '--yes'], { env: cliEnv(h) });
        expect(missing.exitCode).toBe(2);
        expect(missing.stderr).toContain('CONFIRMATION_REQUIRED');
        const onArgv = await runCli(['reset', '--scope', 'instance', '--passphrase', 'hunter2-fixture'], { env: cliEnv(h) });
        expect(onArgv.exitCode).toBe(2);
        expect(onArgv.stdout + onArgv.stderr).not.toContain('hunter2-fixture');
        const loose = answers(h, { command: 'reset', scope: 'instance' }, 0o644);
        expect((await runCli(['reset', '--answers', loose], { env: cliEnv(h) })).exitCode).toBe(2);
        await untouchedRows(h);
        expect(h.doc().active).toBe(false);
    });

    test('an active feature is refused by the CLI before any barrier is entered', async () => {
        const h = await world({ off: [] });
        const file = answers(h, { command: 'reset', scope: 'feature', feature: 'tavern', backup: { dir: h.backupDir, passphrase: PASSPHRASE }, confirm: `${h.installationId}:tavern` });
        const result = await runCli(['reset', '--answers', file], { env: cliEnv(h) });
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain('FEATURE_ACTIVE');
        expect(h.doc().active).toBe(false);
        expect(h.doc().fence).toBe(0);
        await untouchedRows(h);
    });

    test('a dormant feature is purged from the CLI and the other features keep their data', async () => {
        const h = await world({ off: ['tavern'] });
        const file = answers(h, { command: 'reset', scope: 'feature', feature: 'tavern', backup: { dir: h.backupDir, passphrase: PASSPHRASE }, confirm: `${h.installationId}:tavern` });
        const result = await runCli(['reset', '--answers', file], { env: cliEnv(h) });
        expect(result.exitCode).toBe(0);
        expect(await countOf('tavern_characters')).toBe(0);
        expect(await countOf('economy_wallets')).toBeGreaterThan(0);
        expect(await instanceState.getPause()).toBeFalsy();
        expect(h.doc().active).toBe(false);
    });

    test('release reports nothing to do when no barrier is up, and lifts a stale barrier only with --force and --acknowledge-mutation', async () => {
        const h = await world();
        const none = await runCli(['release', '--json'], { env: cliEnv(h) });
        expect(none.exitCode).toBe(0);
        expect(JSON.parse(none.stdout)).toMatchObject({ released: false });

        const ref = await h.enter();
        h.barrier.advance({ operationId: ref.operationId, fence: ref.fence, to: 'mutate' });
        const file = path.join(h.settings.storeDir, 'maintenance.json');
        const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
        stale.owner = { pid: stale.owner.pid, bootId: 'the-previous-manager' };
        fs.writeFileSync(file, JSON.stringify(stale));
        const plain = await runCli(['release'], { env: cliEnv(h) });
        expect(plain.exitCode).toBe(3);
        expect(plain.stderr).toContain('STALE_MAINTENANCE');
        expect(h.doc().active).toBe(true);
        const forced = await runCli(['release', '--force', '--acknowledge-mutation', '--json'], { env: cliEnv(h) });
        expect(forced.exitCode).toBe(0);
        expect(JSON.parse(forced.stdout)).toMatchObject({ released: true, outcome: 'abandoned' });
        expect(h.doc().active).toBe(false);
    });

    test('the answers schema describes a reset document, and an unknown field is refused without echoing its value', async () => {
        const schema = JSON.parse(fs.readFileSync(cli.SCHEMA_FILE, 'utf8'));
        expect(schema.definitions.reset.properties).toHaveProperty('scope');
        expect(schema.definitions.reset.properties.backup.properties).toHaveProperty('passphrase');
        const h = await world();
        const file = answers(h, { command: 'reset', scope: 'instance', surprise: 'SECRET_VALUE_IN_ANSWERS' });
        const result = await runCli(['reset', '--answers', file], { env: cliEnv(h) });
        expect(result.exitCode).toBe(2);
        expect(result.stdout + result.stderr).not.toContain('SECRET_VALUE_IN_ANSWERS');
    });
});

/* ============================================================ db-init */

describe('scripts/initDb.js', () => {
    test('no longer drops anything: --reset is refused with exit code 2 and creates no database', () => {
        const { spawnSync } = require('node:child_process');
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'initDb.js'), '--reset'], {
            env: { ...process.env, GOOBSTER_DB_PATH: path.join(ROOT, 'never-created.sqlite'), GOOBSTER_DB_URL: '' },
            encoding: 'utf8'
        });
        expect(result.status).toBe(2);
        expect(result.stdout + result.stderr).toMatch(/data\.reset|goobster-manager reset/);
        expect(fs.existsSync(path.join(ROOT, 'never-created.sqlite'))).toBe(false);
    });

    test('the source holds no drop statement and no table list of its own', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'initDb.js'), 'utf8');
        expect(source).not.toMatch(/DROP\s+TABLE/i);
        expect(source).not.toContain('DROP_ORDER');
    });
});
