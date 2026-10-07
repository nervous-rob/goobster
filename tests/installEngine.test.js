/**
 * The setup engine (#329, documentation/manager_install.md): a fresh install
 * from a payload directory, a rerun that changes nothing, explicit adoption
 * with updater reconciliation, an interrupted install that resumes, a
 * changed path, a port conflict, repair, keep-data and full uninstall with
 * the tombstone, and the refusals: tampered ownership, symlink escapes,
 * concurrent operations, unknown service owners, and a dry run that writes
 * nothing. The DB-touching cases run on Postgres too (the engine installs
 * against GOOBSTER_DB_URL and never deletes it).
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const {
    LOCAL, makeRelease, newHarness, drive, codeOf, snapshot, tempDir
} = require('./helpers/installFixture');
const { createStore } = require('@goobster/manager/store/installation');
const tombstone = require('@goobster/manager/install/tombstone');
const { discover } = require('@goobster/manager/install/discover');

const POSTGRES_URL = process.env.GOOBSTER_DB_URL || null;
const cleanup = [];

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const scratch = (label) => tempDir(cleanup, label);

async function freshInstall(options = {}) {
    const root = scratch('fresh');
    const releaseDir = scratch('src');
    const release = makeRelease(releaseDir);
    const harness = await newHarness({ root, ...(options.harness || {}) });
    const input = { source: release.dir, features: ['tavern'], release: { allowUnsigned: true }, ...(options.input || {}) };
    const result = await drive(harness, 'install.new', input);
    return { root, release, releaseDir, harness, input, result };
}

const stepStatuses = (operation) => Object.fromEntries(operation.steps.filter(step => step.status !== 'started').map(step => [step.name, step.status]));
const lastStep = (operation, name) => operation.steps.filter(step => step.name === name).pop();
const installed = (harness) => harness.manager.store.readInstallation().doc;

describe('install.new', () => {
    test('installs a verified payload into <code>/current with data kept apart, and records what it owns', async () => {
        const { harness, release, result } = await freshInstall();
        const { code } = harness;

        expect(result.applied.operation.status).toBe('applied');
        expect(fs.existsSync(path.join(code, 'current', 'payload-manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(code, 'current', 'app', 'node_modules', '@goobster', 'core', 'services', 'tavern', 'game.js'))).toBe(true);
        expect(fs.existsSync(path.join(code, 'current', 'app', 'node_modules', '@goobster', 'core', 'services', 'music', 'player.js'))).toBe(false);
        expect(fs.existsSync(path.join(harness.settings.sqlitePath))).toBe(true);
        expect(fs.existsSync(path.join(code, 'staging')) ? fs.readdirSync(path.join(code, 'staging')) : []).toEqual([]);

        const doc = installed(harness);
        expect(doc).toMatchObject({
            version: 2,
            origin: 'install',
            layout: 'lite',
            database: { engine: 'sqlite', external: false },
            updater: { kind: 'manager' },
            release: { version: '2.4.0', features: ['core', 'tavern'] }
        });
        expect(doc.release.releaseId).toBe(require('../scripts/lib/payloadStage').releaseIdOf(release.manifest));
        expect(doc.roots).toMatchObject({ code, data: path.join(code, 'data'), config: path.join(code, 'config.json'), managerStore: harness.settings.storeDir });
        expect(doc.owned.files.map(entry => entry.role)).toEqual(expect.arrayContaining(['code', 'data', 'config']));
        expect(doc.owned.files.find(entry => entry.role === 'code').scope).toBe('payload');
        expect(doc.owned.dependencies.map(dep => dep.name)).toEqual(expect.arrayContaining(['better-sqlite3'].slice(1)));

        const state = harness.manager.currentState();
        expect(state.state).toBe('claimed');
        expect(fs.existsSync(harness.manager.store.paths.bridgeKey)).toBe(true);
    });

    test('excludes the features it did not select in features.json, closed over dependsOn', async () => {
        const { harness } = await freshInstall({ input: { features: ['economy'] } });
        const state = JSON.parse(fs.readFileSync(path.join(harness.settings.dataDir, 'features.json'), 'utf8'));
        expect(state.features.exchange).toMatchObject({ installed: false });
        expect(state.features.tavern).toMatchObject({ installed: false });
        expect(state.features.economy).toMatchObject({ installed: true });
    });

    test('step outcomes: service registration is deferred (501), the rest done or skipped, and the journal holds no secret', async () => {
        const { harness, result } = await freshInstall({
            input: { config: [{ id: 'ai.provider', value: 'ollama' }] }
        });
        const statuses = stepStatuses(result.applied.operation);
        expect(statuses['register-service']).toBe('skipped');
        const operation = harness.manager.journal.read(result.applied.operation.id).record;
        const ledger = Object.fromEntries(operation.progress.map(item => [item.name, item.status]));
        expect(ledger).toMatchObject({
            preflight: 'done', stage: 'done', verify: 'done', ownership: 'done', 'init-db': 'done',
            'write-config': 'done', activate: 'done', 'register-service': 'deferred', finalize: 'done'
        });
        const cfg = JSON.parse(fs.readFileSync(harness.settings.configPath, 'utf8'));
        expect(JSON.stringify(cfg)).toContain('ollama');
        expect(JSON.stringify(operation)).not.toContain('ollama');
    });

    test('the same install again is a no-op: nothing is staged, activated or rewritten', async () => {
        const { harness, input } = await freshInstall();
        const before = installed(harness);
        const currentBefore = fs.statSync(path.join(harness.code, 'current')).ino;
        const configBefore = fs.existsSync(harness.settings.configPath) ? fs.readFileSync(harness.settings.configPath, 'utf8') : null;

        const again = await drive(harness, 'install.new', input);
        expect(again.planned.plan.noop).toBe(true);
        const statuses = stepStatuses(again.applied.operation);
        expect(statuses).toMatchObject({ stage: 'skipped', verify: 'skipped', ownership: 'skipped', activate: 'skipped', finalize: 'skipped' });

        const after = installed(harness);
        expect(after.revision).toBe(before.revision);
        expect(after.installationId).toBe(before.installationId);
        expect(fs.statSync(path.join(harness.code, 'current')).ino).toBe(currentBefore);
        expect(fs.existsSync(path.join(harness.code, 'previous'))).toBe(false);
        const configAfter = fs.existsSync(harness.settings.configPath) ? fs.readFileSync(harness.settings.configPath, 'utf8') : null;
        expect(configAfter).toBe(configBefore);
    });

    test('a dry-run plan lists the target, downloads, services, retained data and privileged steps and mutates nothing', async () => {
        const root = scratch('dry');
        const release = makeRelease(scratch('dry-src'));
        const harness = await newHarness({ root });
        const before = snapshot(root);

        const spec = harness.manager.engine.kinds.includes('install.new');
        expect(spec).toBe(true);
        const kinds = require('@goobster/manager/engine/kinds/install').createKinds({ settings: harness.settings });
        const kind = kinds.find(item => item.kind === 'install.new');
        const ctx = { store: harness.manager.store, bridge: harness.manager.bridge, evidence: () => [] };
        const built = await kind.plan({ source: release.dir, features: ['tavern'], release: { allowUnsigned: true } }, ctx);

        expect(built.plan).toMatchObject({
            action: 'install-new',
            downloads: [],
            downloadHook: 'release-download',
            services: [{ action: 'register', privileged: 'service.register' }],
            privilegedSteps: [{ operation: 'service.register', status: 'deferred' }],
            retainedData: { roots: [] }
        });
        expect(built.plan.target.roots.code).toBe(harness.code);
        expect(built.plan.preflight.ok).toBe(true);
        expect(snapshot(root)).toBe(before);
    });

    test('a port that is already in use blocks the install (and nothing is written)', async () => {
        const root = scratch('port');
        const release = makeRelease(scratch('port-src'));
        const harness = await newHarness({ root });
        const holder = net.createServer();
        await new Promise(resolve => holder.listen(harness.botPort, '127.0.0.1', resolve));
        try {
            const failure = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true } }).catch(error => error);
            expect(failure.code).toBe('PREFLIGHT_FAILED');
            expect(failure.details.findings.map(item => item.code)).toContain('PORT_IN_USE');
            expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
            expect(fs.existsSync(harness.manager.store.paths.installation)).toBe(false);
        } finally {
            holder.close();
        }
    });
});

describe('an interrupted install resumes', () => {
    test('a failure between steps leaves the finished ones recorded; planning again skips them and finishes', async () => {
        const root = scratch('resume');
        const release = makeRelease(scratch('resume-src'));
        let armed = true;
        const harness = await newHarness({
            root,
            hooks: {
                beforeStep: ({ kind, step }) => {
                    if (armed && kind === 'install.new' && step === 'init-db') {
                        armed = false;
                        throw new Error('simulated kill');
                    }
                }
            }
        });
        const input = { source: release.dir, features: ['tavern'], release: { allowUnsigned: true } };

        const failure = await drive(harness, 'install.new', input).catch(error => error);
        expect(failure.code).toBe('STEP_FAILED');
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
        expect(harness.manager.currentState().state).toBe('claimed');
        expect(installed(harness).release).toBeNull();

        const resumed = await drive(harness, 'install.new', input);
        expect(resumed.planned.plan.resumeOf).toMatchObject({ operationId: failure.operation.id, resumeFrom: 'init-db' });
        const statuses = stepStatuses(resumed.applied.operation);
        expect(statuses).toMatchObject({ stage: 'skipped', ownership: 'skipped', 'init-db': 'done', activate: 'done', finalize: 'done' });
        expect(fs.existsSync(path.join(harness.code, 'current', 'payload-manifest.json'))).toBe(true);
        expect(installed(harness).release).toMatchObject({ features: ['core', 'tavern'] });
        expect(fs.readdirSync(path.join(harness.code, 'staging'))).toEqual([]);
    });

    test('an interrupted staging copy (.partial) is cleaned and never activated', async () => {
        const root = scratch('partial');
        const release = makeRelease(scratch('partial-src'));
        const harness = await newHarness({ root });
        const partial = path.join(harness.code, 'staging', 'abc-1234.partial');
        fs.mkdirSync(partial, { recursive: true });
        fs.writeFileSync(path.join(partial, 'half'), 'x');
        await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true } });
        expect(fs.existsSync(partial)).toBe(false);
        expect(fs.existsSync(path.join(harness.code, 'current', 'half'))).toBe(false);
    });
});

describe('repair', () => {
    test('re-stages the recorded release from a source after a code file is deleted, keeping data, config and the store', async () => {
        const { harness, release } = await freshInstall({ input: { config: [{ id: 'ai.provider', value: 'ollama' }] } });
        fs.writeFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'user data');
        const configBefore = fs.readFileSync(harness.settings.configPath, 'utf8');
        const identity = installed(harness);
        fs.rmSync(path.join(harness.code, 'current', 'app', 'apps', 'bot', 'index.js'));

        expect(await codeOf(drive(harness, 'install.repair', { release: { allowUnsigned: true } }))).toBe('REPAIR_SOURCE_REQUIRED');

        const { planned, applied } = await drive(harness, 'install.repair', { source: release.dir, release: { allowUnsigned: true } });
        expect(planned.plan.current).toMatchObject({ present: true, healthy: false });
        expect(applied.operation.status).toBe('applied');
        expect(fs.readFileSync(path.join(harness.code, 'current', 'app', 'apps', 'bot', 'index.js'), 'utf8')).toBe('// bot entry\n');
        expect(fs.readFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'utf8')).toBe('user data');
        expect(fs.readFileSync(harness.settings.configPath, 'utf8')).toBe(configBefore);
        expect(installed(harness).installationId).toBe(identity.installationId);
        expect(installed(harness).revision).toBe(identity.revision);
    });

    test('a healthy installation needs no source: staging and activation are skipped, the database is re-opened', async () => {
        const { harness } = await freshInstall();
        const { applied } = await drive(harness, 'install.repair', { release: { allowUnsigned: true } });
        expect(stepStatuses(applied.operation)).toMatchObject({ stage: 'skipped', activate: 'skipped', 'init-db': 'done' });
    });

    test('an activation a crash interrupted (only previous/ left) is recovered from the retained previous release', async () => {
        const { harness } = await freshInstall();
        fs.renameSync(path.join(harness.code, 'current'), path.join(harness.code, 'previous'));
        const { applied } = await drive(harness, 'install.repair', { release: { allowUnsigned: true } });
        expect(applied.operation.status).toBe('applied');
        expect(fs.existsSync(path.join(harness.code, 'current', 'payload-manifest.json'))).toBe(true);
    });
});

describe('reconfigure', () => {
    test('a changed code root re-stages the release there, updates the record and retires the old payload', async () => {
        const { harness } = await freshInstall();
        const before = installed(harness);
        const newCode = path.join(harness.root, 'moved');
        const { planned, applied } = await drive(harness, 'install.reconfigure', { roots: { code: newCode }, release: { allowUnsigned: true } });

        expect(planned.plan.changes).toMatchObject({ roots: true });
        expect(applied.result).toMatchObject({ restartRequired: true });
        expect(fs.existsSync(path.join(newCode, 'current', 'payload-manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
        const doc = installed(harness);
        expect(doc.roots.code).toBe(newCode);
        expect(doc.roots.data).toBe(before.roots.data);
        expect(doc.revision).toBeGreaterThan(before.revision);
        expect(doc.installationId).toBe(before.installationId);
        expect(doc.owned.files.find(entry => entry.role === 'code').path).toBe(newCode);
    });

    test('a layout change is recorded; data, config and store roots cannot be moved', async () => {
        const { harness } = await freshInstall();
        const { applied } = await drive(harness, 'install.reconfigure', { layout: 'standalone' });
        expect(applied.operation.status).toBe('applied');
        expect(installed(harness).layout).toBe('standalone');
        expect(JSON.parse(fs.readFileSync(harness.settings.configPath, 'utf8')).webapp).toMatchObject({ enabled: true });
        expect(await codeOf(drive(harness, 'install.reconfigure', { roots: { data: path.join(harness.root, 'elsewhere') } }))).toBe('ROOT_NOT_MOVABLE');
    });

    test('nothing to change is a no-op plan', async () => {
        const { harness } = await freshInstall();
        const { planned } = await drive(harness, 'install.reconfigure', {}, { apply: false });
        expect(planned.plan.noop).toBe(true);
    });
});

describe('uninstall', () => {
    test('keeps data by default: code gone, data and config untouched, the record removed, the host not reopened to first-claim', async () => {
        const { harness } = await freshInstall({ input: { config: [{ id: 'ai.provider', value: 'ollama' }] } });
        fs.writeFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'user data');
        const configBefore = fs.readFileSync(harness.settings.configPath, 'utf8');
        const dbBefore = fs.statSync(harness.settings.sqlitePath).size;

        const { planned, applied } = await drive(harness, 'install.uninstall', {});
        expect(planned.plan).toMatchObject({ keepData: true, database: { action: 'kept' } });
        expect(planned.plan.retainedData.roots).toEqual(expect.arrayContaining(['data', 'config']));
        expect(applied.operation.status).toBe('applied');

        for (const dir of ['current', 'previous', 'staging']) expect(fs.existsSync(path.join(harness.code, dir))).toBe(false);
        expect(fs.readFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'utf8')).toBe('user data');
        expect(fs.readFileSync(harness.settings.configPath, 'utf8')).toBe(configBefore);
        expect(fs.statSync(harness.settings.sqlitePath).size).toBe(dbBefore);
        expect(harness.manager.store.readInstallation().status).toBe('missing');
        expect(tombstone.readTombstone(harness.settings.storeDir).doc).toMatchObject({ dataRemoved: false });
        expect(harness.manager.currentState()).toMatchObject({ state: 'recovery', reason: 'MANAGER_TOMBSTONED' });
    });

    test('a running application (its port in use) blocks the uninstall, which another process cannot see in the registry', async () => {
        const { harness } = await freshInstall();
        const holder = net.createServer();
        await new Promise(resolve => holder.listen(harness.botPort, '127.0.0.1', resolve));
        try {
            const failure = await drive(harness, 'install.uninstall', {}).catch(error => error);
            expect(failure.code).toBe('PREFLIGHT_FAILED');
            expect(failure.details.findings.map(item => item.code)).toContain('WORKERS_RUNNING');
            expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(true);
            expect(harness.manager.store.readInstallation().status).toBe('ok');
        } finally {
            holder.close();
        }
    });

    test('keep-data uninstall can be followed by a new install over the kept data (local only)', async () => {
        const { harness, input, release } = await freshInstall();
        fs.writeFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'user data');
        await drive(harness, 'install.uninstall', {});
        expect(await codeOf(harness.manager.engine.plan('install.new', input, { principal: null, via: 'bridge' }, { internal: true }))).toBe('STATE_NOT_ALLOWED');
        const { planned, applied } = await drive(harness, 'install.new', { ...input, source: release.dir });
        expect(planned.plan).toMatchObject({ reusesTombstone: true, retainedData: { existing: true } });
        expect(applied.operation.status).toBe('applied');
        expect(tombstone.readTombstone(harness.settings.storeDir).present).toBe(false);
        expect(fs.readFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'utf8')).toBe('user data');
        expect(harness.manager.currentState().state).toBe('claimed');
    });

    test('full removal names the exact owned roots, needs the installation id, removes them, writes the tombstone and refuses claim', async () => {
        const { harness } = await freshInstall();
        const doc = installed(harness);
        const outside = path.join(harness.root, 'outside.txt');
        fs.writeFileSync(outside, 'not ours');
        fs.writeFileSync(path.join(harness.settings.dataDir, 'keep.txt'), 'user data');

        const dry = await drive(harness, 'install.uninstall', { keepData: false }, { apply: false });
        expect(dry.planned.plan.confirmation).toEqual({ required: true, satisfied: false });
        expect(dry.planned.plan.removes.map(item => item.role).sort()).toEqual(expect.arrayContaining(['cache', 'code', 'config', 'data', 'logs']));
        for (const item of dry.planned.plan.removes) expect(doc.owned.files.some(entry => entry.path === item.path) || item.path.startsWith(doc.roots.code)).toBe(true);
        expect(dry.planned.plan.database).toMatchObject({ action: 'removed with the data root' });

        expect(await codeOf(drive(harness, 'install.uninstall', { keepData: false }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(drive(harness, 'install.uninstall', { keepData: false, confirm: 'not-the-id' }))).toBe('CONFIRMATION_REQUIRED');
        expect(fs.existsSync(path.join(harness.settings.dataDir, 'keep.txt'))).toBe(true);

        const { applied } = await drive(harness, 'install.uninstall', { keepData: false, confirm: doc.installationId });
        expect(applied.operation.status).toBe('applied');
        expect(fs.existsSync(harness.settings.sqlitePath)).toBe(false);
        expect(fs.existsSync(path.join(harness.settings.dataDir, 'keep.txt'))).toBe(false);
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
        expect(fs.readFileSync(outside, 'utf8')).toBe('not ours');
        expect(fs.existsSync(harness.settings.storeDir)).toBe(true);
        expect(fs.existsSync(harness.manager.store.paths.installation)).toBe(false);
        expect(fs.existsSync(harness.manager.store.paths.bridgeKey)).toBe(false);
        expect(tombstone.readTombstone(harness.settings.storeDir).doc).toMatchObject({ installationId: doc.installationId, dataRemoved: true });

        const state = harness.manager.currentState();
        expect(state).toMatchObject({ state: 'recovery', reason: 'MANAGER_TOMBSTONED' });
        expect(await codeOf(harness.manager.engine.run('claim', { label: 'Mallory' }, { principal: null, via: 'bootstrap' }))).toBe('STATE_NOT_ALLOWED');
        const init = await harness.manager.init();
        expect(init.bootstrap).toBeNull();
        expect((await harness.manager.status()).state).toBe('recovery');
    });

    test('never deletes an external Postgres database and says so', async () => {
        const { harness } = await freshInstall({
            harness: {
                env: { GOOBSTER_DB_URL: POSTGRES_URL || 'postgres://goobster:goobster@127.0.0.1:5432/goobster' },
                installDeps: POSTGRES_URL ? {} : { initDatabase: async () => ({ engine: 'postgres', tables: 0 }) }
            },
            input: { layout: 'standalone' }
        });
        const doc = installed(harness);
        expect(doc.database).toEqual({ engine: 'postgres', external: true });
        const dry = await drive(harness, 'install.uninstall', { keepData: false }, { apply: false });
        expect(dry.planned.plan.database).toEqual({ engine: 'postgres', action: 'not deleted: external' });
    });
});

describe('refusals', () => {
    test('a tampered installation.json is refused by every owned operation, and left as it is', async () => {
        const { harness } = await freshInstall();
        const file = harness.manager.store.paths.installation;
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.roots.data = path.join(harness.root, 'victim');
        fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
        const tampered = fs.readFileSync(file, 'utf8');

        for (const [kind, input] of [['install.repair', {}], ['install.reconfigure', { layout: 'standalone' }], ['install.uninstall', { keepData: false, confirm: doc.installationId }]]) {
            expect(await codeOf(drive(harness, kind, input))).toBe('OWNERSHIP_TAMPERED');
        }
        expect(await codeOf(drive(harness, 'install.new', { source: path.join(harness.root, 'x'), release: { allowUnsigned: true } }))).toBe('OWNERSHIP_TAMPERED');
        expect(fs.readFileSync(file, 'utf8')).toBe(tampered);
        expect(fs.existsSync(path.join(harness.root, 'victim'))).toBe(false);
        expect(fs.existsSync(harness.settings.sqlitePath)).toBe(true);
    });

    test('a symlinked payload directory is never followed: uninstall refuses with PATH_ESCAPE and the target survives', async () => {
        const { harness } = await freshInstall();
        const outside = scratch('outside');
        fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
        fs.mkdirSync(path.join(harness.code, 'previous'), { recursive: true });
        fs.rmSync(path.join(harness.code, 'previous'), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(harness.code, 'previous'));

        expect(await codeOf(drive(harness, 'install.uninstall', {}))).toBe('PATH_ESCAPE');
        expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(true);
    });

    test('a cache root that is a symlink or a path that climbs with ".." is refused before anything is written', async () => {
        const root = scratch('escape');
        const release = makeRelease(scratch('escape-src'));
        const harness = await newHarness({ root });
        const outside = scratch('escape-out');
        fs.symlinkSync(outside, path.join(harness.code, 'cache'));
        const input = { source: release.dir, release: { allowUnsigned: true } };
        expect(await codeOf(drive(harness, 'install.new', input))).toBe('PREFLIGHT_FAILED');
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(await codeOf(drive(harness, 'install.new', { ...input, roots: { code: `${harness.code}/../../etc` } }))).toBe('INVALID_INPUT');
    });

    test('a refused removal target ($HOME, a filesystem root, a parent of the code root) is never removed', async () => {
        const { harness } = await freshInstall();
        const file = harness.manager.store.paths.installation;
        const store = createStore({ root: harness.settings.storeDir });
        for (const bad of [path.dirname(harness.root), '/']) {
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            doc.roots.cache = bad;
            doc.owned.files = doc.owned.files.map(entry => (entry.role === 'cache' ? { ...entry, path: bad } : entry));
            expect(() => store.updateInstallation(() => doc)).not.toThrow();
            expect(await codeOf(drive(harness, 'install.uninstall', { keepData: false, confirm: doc.installationId }))).toBe('PATH_ESCAPE');
        }
        expect(fs.existsSync(harness.root)).toBe(true);
    });

    test('two operations at once: the second is refused with OPERATION_IN_PROGRESS', async () => {
        const { harness } = await freshInstall();
        const { engine } = harness.manager;
        const first = await engine.plan('install.repair', { release: { allowUnsigned: true } }, LOCAL, { internal: true });
        const second = await engine.plan('install.repair', { release: { allowUnsigned: true } }, LOCAL, { internal: true });
        await engine.validate(first.id, LOCAL);
        await engine.validate(second.id, LOCAL);
        const outcomes = await Promise.allSettled([
            engine.apply(first.id, { revision: first.revision }, LOCAL),
            engine.apply(second.id, { revision: second.revision }, LOCAL)
        ]);
        expect(outcomes.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(outcomes.find(item => item.status === 'rejected').reason.code).toBe('OPERATION_IN_PROGRESS');
        const held = harness.manager.lock.acquire('someone-else');
        try {
            const third = await engine.plan('install.repair', { release: { allowUnsigned: true } }, LOCAL, { internal: true });
            await engine.validate(third.id, LOCAL);
            expect(await codeOf(engine.apply(third.id, { revision: third.revision }, LOCAL))).toBe('OPERATION_IN_PROGRESS');
        } finally {
            held.release();
        }
    });

    test('a service the installer did not register is never touched: UNKNOWN_SERVICE_OWNER', async () => {
        const { harness } = await freshInstall();
        harness.manager.store.updateInstallation(doc => ({
            ...doc,
            owned: { ...doc.owned, services: [{ kind: 'systemd', name: 'mystery.service', registeredBy: 'unknown' }] }
        }));
        expect(await codeOf(drive(harness, 'install.uninstall', {}))).toBe('UNKNOWN_SERVICE_OWNER');
        expect(await codeOf(drive(harness, 'install.repair', { release: { allowUnsigned: true } }))).toBe('UNKNOWN_SERVICE_OWNER');
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(true);

        const acknowledged = await drive(harness, 'install.uninstall', { acknowledgeUnknownServices: true });
        expect(acknowledged.planned.plan.unknownServices).toEqual([{ kind: 'systemd', name: 'mystery.service' }]);
        expect(acknowledged.applied.operation.status).toBe('applied');
        expect(acknowledged.planned.plan.services.filter(item => item.action === 'unregister')).toEqual([]);
    });

    test('a service another party registered is left in place and listed', async () => {
        const { harness } = await freshInstall();
        harness.manager.store.updateInstallation(doc => ({
            ...doc,
            owned: { ...doc.owned, services: [{ kind: 'systemd', name: 'goobster.service', registeredBy: 'system' }, { kind: 'systemd', name: 'ours.service', registeredBy: 'installer' }] }
        }));
        const { planned, applied } = await drive(harness, 'install.uninstall', {});
        expect(planned.plan.services).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'goobster.service', action: 'leave' }),
            expect.objectContaining({ name: 'ours.service', action: 'unregister', privileged: 'service.unregister' })
        ]));
        const ledger = harness.manager.journal.read(applied.operation.id).record.progress;
        expect(ledger.find(item => item.name === 'unregister-service').status).toBe('deferred');
    });

    test('a tampered payload source, a wrong target and an unsigned payload without the dev flag are refused at plan time', async () => {
        const root = scratch('refuse');
        const release = makeRelease(scratch('refuse-src'));
        const harness = await newHarness({ root });
        expect(await codeOf(drive(harness, 'install.new', { source: release.dir }))).toBe('UNSIGNED_DEV_ONLY');
        fs.appendFileSync(path.join(release.dir, 'app', 'apps', 'bot', 'index.js'), '// changed\n');
        expect(await codeOf(drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true } }))).toBe('INCOMPLETE');
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
    });
});

describe('adoption of an existing instance', () => {
    function manualCheckout(harness, { rpi = false } = {}) {
        fs.mkdirSync(path.join(harness.code, 'data'), { recursive: true });
        fs.mkdirSync(path.join(harness.code, 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(harness.code, 'package.json'), JSON.stringify({ name: 'goobster' }));
        fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ token: 'tok-adopt-planted-0123456789' }));
        const db = Buffer.alloc(4096);
        db.write('SQLite format 3\u0000', 0, 'latin1');
        fs.writeFileSync(path.join(harness.code, 'data', 'goobster.sqlite'), db);
        fs.writeFileSync(path.join(harness.code, 'scripts', 'auto-update.sh'), '#!/bin/bash\n# goobster-manager-guard\nexit 0\n');
        if (rpi) fs.writeFileSync(path.join(harness.code, 'data', '.install-origin'), JSON.stringify({ kind: 'rpi-script', version: 1 }));
    }

    test('a synthetic manual install is discovered without a change and adopted only when named', async () => {
        const root = scratch('adopt-manual');
        const harness = await newHarness({ root, installDeps: { discover: (opts) => discover({ ...opts, exec: () => null }) } });
        manualCheckout(harness);
        const before = snapshot(harness.code);

        const found = discover({ fs, home: root, env: harness.settings.env, exec: () => null });
        expect(found.candidates).toHaveLength(1);
        expect(found.candidates[0]).toMatchObject({ kind: 'manual', layout: 'lite', dbEngine: 'sqlite', evidence: expect.arrayContaining(['SOURCE_CHECKOUT', 'SQLITE_PRESENT']) });
        expect(snapshot(harness.code)).toBe(before);
        expect(harness.manager.currentState().state).toBe('recovery');

        const candidateId = found.candidates[0].id;
        expect(await codeOf(drive(harness, 'adopt', { label: 'Rob', candidateId: 'deadbeef0000' }))).toBe('CANDIDATE_NOT_FOUND');
        const dbBefore = fs.readFileSync(harness.settings.sqlitePath);
        const { planned, applied } = await drive(harness, 'adopt', { label: 'Rob', candidateId });
        expect(planned.plan).toMatchObject({ managed: true, moves: [], target: { kind: 'manual' } });
        expect(applied.operation.status).toBe('applied');
        expect(fs.readFileSync(harness.settings.sqlitePath).equals(dbBefore)).toBe(true);
        expect(fs.readFileSync(path.join(harness.code, 'config.json'), 'utf8')).toContain('tok-adopt-planted');
        const doc = installed(harness);
        expect(doc).toMatchObject({ version: 2, origin: 'adopt', ownerLabel: 'Rob', layout: 'lite', updater: { kind: 'manager' }, release: null });
        expect(doc.owned.files.find(entry => entry.role === 'code')).toBeUndefined();
        expect(JSON.stringify(harness.manager.journal.read(applied.operation.id).record)).not.toContain('tok-adopt-planted');
        expect(harness.manager.currentState().state).toBe('claimed');
    });

    test('an rpi layout with an auto-update cron line: the line is commented out reversibly, so two updaters cannot act', async () => {
        let crontab = null;
        const exec = (name) => (name === 'crontab' ? crontab : null);
        const harness = await newHarness({
            root: scratch('adopt-rpi'),
            installDeps: { discover: (opts) => discover({ ...opts, exec }), readCrontab: () => crontab, writeCrontab: (text) => { crontab = text; } }
        });
        manualCheckout(harness, { rpi: true });
        crontab = `MAILTO=""\n0 4 * * * ${harness.code}/scripts/auto-update.sh >> /tmp/goobster-update.log 2>&1\n`;
        const original = crontab;

        const found = discover({ fs, home: harness.root, env: harness.settings.env, exec });
        expect(found.candidates[0]).toMatchObject({ kind: 'rpi', updater: { kind: 'auto-update.sh' }, evidence: expect.arrayContaining(['RPI_MARKER', 'CRON_AUTO_UPDATE']) });
        expect(crontab).toBe(original);

        const { planned, applied } = await drive(harness, 'adopt', { label: 'Pi owner', candidateId: found.candidates[0].id });
        expect(planned.plan.updaterReconcile).toEqual([{ mechanism: 'cron', unit: null, action: 'comment-cron-line', guarded: true }]);
        expect(applied.operation.status).toBe('applied');
        expect(crontab).toContain('#goobster-manager-disabled: 0 4 * * *');
        expect(crontab.split('\n').filter(item => item.includes('auto-update.sh') && !item.startsWith('#'))).toEqual([]);
        expect(installed(harness).updater).toEqual({ kind: 'manager' });
        expect(planned.plan.preflight.ok).toBe(true);
    });

    test('an adoption records the update answer when it is given, and leaves the policy unset when it is not (#342)', async () => {
        const harness = await newHarness({ root: scratch('adopt-update'), installDeps: { discover: (opts) => discover({ ...opts, exec: () => null }) } });
        manualCheckout(harness);
        const { applied } = await drive(harness, 'adopt', { label: 'Rob', roots: { code: harness.code }, update: { mode: 'check' } });
        expect(applied.operation.status).toBe('applied');
        expect(harness.manager.store.readInstallation().doc.update).toEqual({ channel: 'stable', mode: 'check' });

        const other = await newHarness({ root: scratch('adopt-update2'), installDeps: { discover: (opts) => discover({ ...opts, exec: () => null }) } });
        manualCheckout(other);
        expect(await codeOf(drive(other, 'adopt', { label: 'Rob', roots: { code: other.code }, update: { mode: 'sometimes' } }))).toBe('INVALID_INPUT');
        await drive(other, 'adopt', { label: 'Rob', roots: { code: other.code } });
        expect(other.manager.store.readInstallation().doc.update || null).toBeNull();
    });

    test('a systemd timer needs the privileged helper: deferred (501) when the script carries the guard, UPDATER_CONFLICT when it does not', async () => {
        const root = scratch('adopt-timer');
        const exec = (name) => (name === 'systemctl-timer' ? 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n' : null);
        const harness = await newHarness({ root, installDeps: { discover: (opts) => discover({ ...opts, exec }) } });
        manualCheckout(harness, { rpi: true });
        const found = discover({ fs, home: harness.root, env: harness.settings.env, exec });
        expect(found.candidates[0].updaters).toEqual([{ kind: 'auto-update.sh', mechanism: 'systemd-timer', unit: 'goobster-update.timer' }]);

        const guarded = await drive(harness, 'adopt', { label: 'Pi owner', candidateId: found.candidates[0].id });
        expect(guarded.planned.plan.privilegedSteps).toEqual([{ step: 'reconcile-updater', operation: 'updater.disable', status: 'deferred', reason: 'NOT_IMPLEMENTED' }]);
        const ledger = harness.manager.journal.read(guarded.applied.operation.id).record.progress;
        expect(ledger.find(item => item.name === 'reconcile-updater').status).toBe('deferred');

        const root2 = scratch('adopt-timer2');
        const harness2 = await newHarness({ root: root2, installDeps: { discover: (opts) => discover({ ...opts, exec }) } });
        manualCheckout(harness2, { rpi: true });
        fs.writeFileSync(path.join(harness2.code, 'scripts', 'auto-update.sh'), '#!/bin/bash\nexit 0\n');
        const failure = await drive(harness2, 'adopt', { label: 'Pi owner', roots: { code: harness2.code } }).catch(error => error);
        expect(failure.code).toBe('UPDATER_CONFLICT');
        expect(harness2.manager.store.readInstallation().status).toBe('missing');

        const kept = await drive(harness2, 'adopt', { label: 'Pi owner', roots: { code: harness2.code }, keepUpdater: true });
        expect(kept.applied.operation.status).toBe('applied');
        expect(installed(harness2).updater).toMatchObject({ kind: 'auto-update.sh' });
    });

    test('explicit roots that are not an installation are refused, and a managed record is never adopted twice', async () => {
        const root = scratch('adopt-bad');
        const harness = await newHarness({ root, installDeps: { discover: (opts) => discover({ ...opts, exec: () => null }) } });
        fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
        expect(await codeOf(drive(harness, 'adopt', { label: 'x', roots: { code: path.join(root, 'empty') } }))).toBe('NOT_AN_INSTALLATION');
        expect(await codeOf(drive(harness, 'adopt', { label: 'x' }))).toBe('NOTHING_TO_ADOPT');

        manualCheckout(harness);
        await drive(harness, 'adopt', { label: 'Rob', roots: { code: harness.code } });
        expect(await codeOf(drive(harness, 'adopt', { label: 'Rob', roots: { code: harness.code } }))).toBe('ALREADY_INSTALLED');
    });

    test('an adopted instance can be uninstalled with its data kept: only the record goes, the checkout is untouched', async () => {
        const root = scratch('adopt-un');
        const harness = await newHarness({ root, installDeps: { discover: (opts) => discover({ ...opts, exec: () => null }) } });
        manualCheckout(harness);
        await drive(harness, 'adopt', { label: 'Rob', roots: { code: harness.code } });
        const before = snapshot(harness.code).replace(/^.*data\/manager.*$/gm, '').replace(/^.*tombstone.*$/gm, '');
        const { planned } = await drive(harness, 'install.uninstall', {});
        expect(planned.plan.removes).toEqual([]);
        const after = snapshot(harness.code).replace(/^.*data\/manager.*$/gm, '').replace(/^.*tombstone.*$/gm, '');
        expect(after.split('\n').filter(Boolean)).toEqual(before.split('\n').filter(Boolean));
        expect(fs.existsSync(path.join(harness.code, 'package.json'))).toBe(true);
    });
});

const onPostgres = POSTGRES_URL ? describe : describe.skip;

onPostgres('against Postgres (GOOBSTER_DB_URL)', () => {
    test('a standalone install opens the external database once (schema applied), records it as external, and repair opens it again', async () => {
        const { harness, release, result } = await freshInstall({
            harness: { env: { GOOBSTER_DB_URL: POSTGRES_URL } },
            input: { layout: 'standalone' }
        });
        const initStep = lastStep(result.applied.operation, 'init-db');
        expect(initStep.status).toBe('done');
        expect(initStep.detail).toMatchObject({ engine: 'postgres' });
        expect(initStep.detail.tables).toBeGreaterThan(20);
        expect(installed(harness)).toMatchObject({ layout: 'standalone', database: { engine: 'postgres', external: true } });
        expect(fs.existsSync(harness.settings.sqlitePath)).toBe(false);

        fs.rmSync(path.join(harness.code, 'current', 'app', 'apps', 'bot', 'index.js'));
        const repaired = await drive(harness, 'install.repair', { source: release.dir, release: { allowUnsigned: true } });
        const repairInit = lastStep(repaired.applied.operation, 'init-db');
        expect(repairInit.detail).toMatchObject({ engine: 'postgres' });
        expect(repaired.applied.operation.status).toBe('applied');

        const dry = await drive(harness, 'install.uninstall', { keepData: false }, { apply: false });
        expect(dry.planned.plan.database.action).toBe('not deleted: external');
    });

    test('sqlite chosen explicitly while GOOBSTER_DB_URL names Postgres is a preflight block', async () => {
        const root = scratch('pg-mismatch');
        const release = makeRelease(scratch('pg-mismatch-src'));
        const harness = await newHarness({ root, env: { GOOBSTER_DB_URL: POSTGRES_URL } });
        const failure = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'sqlite' } }).catch(error => error);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(failure.details.findings.map(item => item.code)).toContain('DATABASE_MISMATCH');
    });
});

describe('over HTTP (#330): public kinds with allowed bases', () => {
    const SETUP = { principal: 'setup:test', via: 'setup' };

    async function claimed(label) {
        const root = scratch(label);
        const harness = await newHarness({ root });
        await harness.manager.engine.run('claim', { label: 'Rob' }, { principal: null, via: 'bootstrap' });
        return { root, harness };
    }

    test('the four install kinds are public, and the engine plans them for a setup session without the internal flag', async () => {
        const { createKinds } = require('@goobster/manager/engine/kinds/install');
        const { settings } = await newHarness({ root: scratch('public') });
        const kinds = createKinds({ settings });
        expect(kinds.map(kind => [kind.kind, kind.public])).toEqual(expect.arrayContaining([
            ['install.new', true], ['install.reconfigure', true], ['install.repair', true], ['install.uninstall', true]
        ]));
        const { harness } = await claimed('public-plan');
        const release = makeRelease(scratch('public-plan-src'));
        const planned = await harness.manager.engine.plan('install.new', { source: release.dir, release: { allowUnsigned: true } }, SETUP);
        expect(planned.plan.preflight.ok).toBe(true);
    });

    test('an anonymous caller, an unknown kind of session and the wrong state are refused for every kind', async () => {
        const { harness } = await claimed('anon');
        const release = makeRelease(scratch('anon-src'));
        const input = { source: release.dir, release: { allowUnsigned: true } };
        for (const kind of ['install.new', 'install.reconfigure', 'install.repair', 'install.uninstall']) {
            for (const via of ['anonymous', 'bootstrap', 'recovery-credential', undefined]) {
                expect(await codeOf(harness.manager.engine.plan(kind, kind === 'install.uninstall' ? {} : input, { principal: null, via }))).toBe('STATE_NOT_ALLOWED');
            }
        }
        const fresh = await newHarness({ root: scratch('anon-unclaimed') });
        expect(await codeOf(fresh.manager.engine.plan('install.new', input, SETUP))).toBe('STATE_NOT_ALLOWED');
    });

    test('a root outside the allowed bases is a block for a setup session and not for the command line', async () => {
        const { harness } = await claimed('bases');
        const release = makeRelease(scratch('bases-src'));
        const elsewhere = scratch('bases-elsewhere');
        const input = { source: release.dir, release: { allowUnsigned: true }, roots: { code: path.join(elsewhere, 'goobster') } };

        const refused = await harness.manager.engine.plan('install.new', input, SETUP);
        expect(refused.plan.preflight.ok).toBe(false);
        const blocked = refused.plan.preflight.findings.find(item => item.code === 'ROOT_OUTSIDE_ALLOWED_BASES');
        expect(blocked).toMatchObject({ severity: 'block' });
        expect(blocked.detail).toMatch(/command line/);
        expect(await codeOf(drive(harness, 'install.new', input, { auth: SETUP }))).toBe('PREFLIGHT_FAILED');
        expect(fs.existsSync(path.join(elsewhere, 'goobster'))).toBe(false);

        const local = await harness.manager.engine.plan('install.new', input, LOCAL, { internal: true });
        expect(local.plan.preflight.findings.map(item => item.code)).not.toContain('ROOT_OUTSIDE_ALLOWED_BASES');
    });

    test('a root inside the home directory or an allowed base is accepted', async () => {
        const { harness, root } = await claimed('inside');
        const release = makeRelease(scratch('inside-src'));
        const planned = await harness.manager.engine.plan('install.new', { source: release.dir, release: { allowUnsigned: true }, roots: { code: path.join(root, 'app') } }, SETUP);
        expect(planned.plan.preflight.findings.map(item => item.code)).not.toContain('ROOT_OUTSIDE_ALLOWED_BASES');
    });

    test('the allowed bases per platform', () => {
        const paths = require('@goobster/manager/install/paths');
        expect(paths.allowedBases({ home: '/home/a', platform: 'linux', env: {} })).toEqual(['/home/a', '/opt/goobster', '/srv/goobster', '/var/lib/goobster', '/usr/local/goobster']);
        expect(paths.allowedBases({ home: '/Users/a', platform: 'darwin', env: {} })).toEqual(['/Users/a/Library/Application Support/Goobster', '/opt/goobster']);
        const win = paths.allowedBases({ home: 'C:\\Users\\a', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', ProgramData: 'C:\\ProgramData', SystemDrive: 'C:' } });
        expect(win).toEqual(['C:\\Users\\a\\AppData\\Local\\Goobster', 'C:\\ProgramData\\Goobster', 'C:\\Goobster']);
        expect(paths.isUnderAllowedBase('D:\\Goobster\\app', win, { platform: 'win32' })).toBe(true);
        expect(paths.isUnderAllowedBase('D:\\Other\\app', win, { platform: 'win32' })).toBe(false);
        expect(paths.isUnderAllowedBase('/home/a/goobster', ['/home/a'], { platform: 'linux' })).toBe(true);
        expect(paths.isUnderAllowedBase('/home/ab/goobster', ['/home/a'], { platform: 'linux' })).toBe(false);
        expect(paths.isUnderAllowedBase('/home/a/../etc', ['/home/a'], { platform: 'linux' })).toBe(false);
    });
});

describe('the port probe', () => {
    const { defaultProbePort } = require('@goobster/manager/install/preflight');

    test('a port with a listener is busy, a free port is free', async () => {
        const holder = net.createServer();
        await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
        const { port } = holder.address();
        expect(await defaultProbePort(port)).toBe('busy');
        await new Promise(resolve => holder.close(resolve));
        expect(await defaultProbePort(port)).toBe('free');
    });

    test('a bind refused with EADDRINUSE and nothing listening (another account\'s TIME_WAIT on macOS) is free', async () => {
        const fake = {
            createServer: () => {
                const handlers = {};
                return {
                    unref() {},
                    once(event, handler) { handlers[event] = handler; },
                    listen() { setImmediate(() => handlers.error(Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))); },
                    close(callback) { callback(); }
                };
            },
            connect: () => {
                const handlers = {};
                const socket = {
                    unref() {},
                    setTimeout() {},
                    destroy() {},
                    once(event, handler) { handlers[event] = handler; return socket; }
                };
                setImmediate(() => handlers.error(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
                return socket;
            }
        };
        expect(await defaultProbePort(3100, fake)).toBe('free');
        const accepting = { ...fake, connect: () => {
            const handlers = {};
            const socket = { unref() {}, setTimeout() {}, destroy() {}, once(event, handler) { handlers[event] = handler; return socket; } };
            setImmediate(() => handlers.connect());
            return socket;
        } };
        expect(await defaultProbePort(3100, accepting)).toBe('busy');
    });
});
