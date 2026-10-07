/**
 * The manager's environment overlay (#336, documentation/manager.md "The
 * environment overlay"): `<managerStore>/environment.json` carries the
 * database connection a migration switches to. Precedence beneath the
 * process environment, mode 0600, atomic replace, the allow-list, the worker
 * environment the supervisor builds, secrecy (never in a status, journal,
 * audit log, or backup archive), removal by a full uninstall, and the
 * additive `verifyBackup` helper that shares this change.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-overlay-'));

const environment = require('@goobster/manager/environment');
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createStore } = require('@goobster/manager/store/installation');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const extensions = require('@goobster/manager/extensions');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { newHarness, drive, makeRelease, codeOf, tempDir } = require('./helpers/installFixture');

const SECRET_URL = 'postgres://overlay-user:overlay-pw-8841@db.example.test:5432/overlay_db';
const OTHER_URL = 'postgres://other-user:other-pw-2210@elsewhere.example.test:5432/other_db';
const silent = { info() {}, warn() {}, error() {} };
const live = [];
const cleanup = [];
let counter = 0;

function newDir(label) {
    const dir = path.join(ROOT, `${label}-${counter++}-${crypto.randomBytes(2).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function everyFileText(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...everyFileText(full));
        else out.push(`${full}\n${fs.readFileSync(full, 'latin1')}`);
    }
    return out;
}

afterEach(async () => {
    while (live.length) {
        const { supervisor, unregister, fakes } = live.pop();
        await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
    }
});

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the overlay file', () => {
    test('is written with mode 0600 by one atomic rename and leaves no temporary file behind', () => {
        const store = newDir('store');
        const written = environment.write(store, { GOOBSTER_DB_URL: SECRET_URL });
        expect(written).toEqual(['GOOBSTER_DB_URL']);
        const file = environment.fileFor(store);
        expect(path.basename(file)).toBe('environment.json');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(store)).toEqual(['environment.json']);
        expect(environment.read(store)).toEqual({ present: true, values: { GOOBSTER_DB_URL: SECRET_URL }, problem: null });

        environment.write(store, { GOOBSTER_DB_URL: OTHER_URL });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(store)).toEqual(['environment.json']);
        expect(environment.read(store).values.GOOBSTER_DB_URL).toBe(OTHER_URL);
    });

    test('a write that fails part way leaves the previous overlay intact', () => {
        const store = newDir('store');
        environment.write(store, { GOOBSTER_DB_URL: SECRET_URL });
        const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
        expect(() => environment.write(store, { GOOBSTER_DB_URL: OTHER_URL }, { fs: failing })).toThrow('disk full');
        expect(environment.read(store).values.GOOBSTER_DB_URL).toBe(SECRET_URL);
        expect(fs.readdirSync(store).filter(name => name !== 'environment.json')).toEqual([]);
    });

    test('only allow-listed keys with sane string values are kept; the list is exported', () => {
        expect(environment.ALLOWED_KEYS).toEqual(['GOOBSTER_DB_URL']);
        const store = newDir('store');
        const written = environment.write(store, {
            GOOBSTER_DB_URL: SECRET_URL, OPENAI_API_KEY: 'sk-never', PATH: '/evil', GOOBSTER_INTERNAL_TOKEN: 'nope'
        });
        expect(written).toEqual(['GOOBSTER_DB_URL']);
        expect(Object.keys(environment.read(store).values)).toEqual(['GOOBSTER_DB_URL']);
        expect(fs.readFileSync(environment.fileFor(store), 'utf8')).not.toContain('sk-never');

        expect(environment.write(newDir('store'), { GOOBSTER_DB_URL: '' })).toEqual([]);
        expect(environment.write(newDir('store'), { GOOBSTER_DB_URL: 'a\0b' })).toEqual([]);
        expect(environment.write(newDir('store'), { GOOBSTER_DB_URL: 12 })).toEqual([]);
        expect(environment.write(newDir('store'), null)).toEqual([]);
    });

    test('a missing, unreadable or foreign file reads as no values and never throws', () => {
        const store = newDir('store');
        expect(environment.read(store)).toEqual({ present: false, values: {}, problem: null });
        fs.writeFileSync(environment.fileFor(store), '{not json');
        expect(environment.read(store)).toMatchObject({ present: true, values: {}, problem: expect.any(String) });
        fs.writeFileSync(environment.fileFor(store), JSON.stringify({ version: 99, values: { GOOBSTER_DB_URL: SECRET_URL } }));
        expect(environment.read(store)).toEqual({ present: true, values: {}, problem: 'INVALID' });
        fs.writeFileSync(environment.fileFor(store), JSON.stringify({ version: 1, values: { GOOBSTER_DB_URL: SECRET_URL, EXTRA: 'x' } }));
        expect(environment.read(store).values).toEqual({ GOOBSTER_DB_URL: SECRET_URL });
    });

    test('remove deletes the file and reports whether there was one', () => {
        const store = newDir('store');
        environment.write(store, { GOOBSTER_DB_URL: SECRET_URL });
        expect(environment.remove(store)).toBe(true);
        expect(environment.remove(store)).toBe(false);
        expect(fs.existsSync(environment.fileFor(store))).toBe(false);
    });
});

describe('precedence beneath the process environment', () => {
    test('merge adds the overlay only where the environment has no value and returns the same object when nothing is added', () => {
        const env = { A: '1' };
        expect(environment.merge(env, {})).toBe(env);
        expect(environment.merge(env, { GOOBSTER_DB_URL: SECRET_URL })).toEqual({ A: '1', GOOBSTER_DB_URL: SECRET_URL });
        expect(environment.merge({ GOOBSTER_DB_URL: '' }, { GOOBSTER_DB_URL: SECRET_URL }).GOOBSTER_DB_URL).toBe(SECRET_URL);
        const set = { GOOBSTER_DB_URL: OTHER_URL };
        expect(environment.merge(set, { GOOBSTER_DB_URL: SECRET_URL })).toBe(set);
        expect(environment.overridden(set, { GOOBSTER_DB_URL: SECRET_URL })).toEqual(['GOOBSTER_DB_URL']);
        expect(environment.overridden({ GOOBSTER_DB_URL: SECRET_URL }, { GOOBSTER_DB_URL: SECRET_URL })).toEqual([]);
        expect(environment.overridden({}, { GOOBSTER_DB_URL: SECRET_URL })).toEqual([]);
    });

    function settingsFor(root, extra = {}) {
        return resolveSettings({
            GOOBSTER_DATA_DIR: path.join(root, 'data'),
            GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
            GOOBSTER_MANAGER_PORT: '0',
            GOOBSTER_MANAGER_RECONCILE: '0',
            ...extra
        });
    }

    test('resolveSettings: the overlay supplies GOOBSTER_DB_URL when the environment does not', () => {
        const root = newDir('settings');
        environment.write(path.join(root, 'data', 'manager'), { GOOBSTER_DB_URL: SECRET_URL });
        const settings = settingsFor(root);
        expect(settings.dbUrl).toBe(SECRET_URL);
        expect(settings.env.GOOBSTER_DB_URL).toBe(SECRET_URL);
        expect(settings.processEnv.GOOBSTER_DB_URL).toBeUndefined();
        expect(settings.environment).toEqual({ overlayKeys: ['GOOBSTER_DB_URL'], overridden: [], problem: null });
    });

    test('resolveSettings: a process-environment value wins and the difference is reported by key name only', () => {
        const root = newDir('settings');
        environment.write(path.join(root, 'data', 'manager'), { GOOBSTER_DB_URL: SECRET_URL });
        const settings = settingsFor(root, { GOOBSTER_DB_URL: OTHER_URL });
        expect(settings.dbUrl).toBe(OTHER_URL);
        expect(settings.env.GOOBSTER_DB_URL).toBe(OTHER_URL);
        expect(settings.environment).toMatchObject({ overlayKeys: ['GOOBSTER_DB_URL'], overridden: ['GOOBSTER_DB_URL'] });
        expect(JSON.stringify(settings.environment)).not.toContain('overlay-pw-8841');
        expect(JSON.stringify(settings.environment)).not.toContain('other-pw-2210');
    });

    test('resolveSettings without an overlay changes nothing (no file is created)', () => {
        const root = newDir('settings');
        const settings = settingsFor(root);
        expect(settings.dbUrl).toBeNull();
        expect(settings.environment).toEqual({ overlayKeys: [], overridden: [], problem: null });
        expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
    });

    test('apply makes a running manager see a new overlay, still beneath the process environment', () => {
        const root = newDir('settings');
        const settings = settingsFor(root);
        environment.apply(settings, { GOOBSTER_DB_URL: SECRET_URL });
        expect(settings.dbUrl).toBe(SECRET_URL);
        expect(settings.env.GOOBSTER_DB_URL).toBe(SECRET_URL);
        expect(settings.processEnv.GOOBSTER_DB_URL).toBeUndefined();
        expect(settings.environment).toEqual({ overlayKeys: ['GOOBSTER_DB_URL'], overridden: [] });

        const pinned = settingsFor(newDir('settings'), { GOOBSTER_DB_URL: OTHER_URL });
        environment.apply(pinned, { GOOBSTER_DB_URL: SECRET_URL });
        expect(pinned.dbUrl).toBe(OTHER_URL);
        expect(pinned.environment.overridden).toEqual(['GOOBSTER_DB_URL']);
    });
});

describe('what the workers and the manager expose', () => {
    async function supervised(overlay) {
        const root = newDir('sup');
        fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ webapp: { enabled: true } }));
        const settings = resolveSettings({
            GOOBSTER_DATA_DIR: path.join(root, 'data'),
            GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
            GOOBSTER_MANAGER_PORT: '0',
            GOOBSTER_MANAGER_RECONCILE: '0',
            GOOBSTER_RUNTIME_MODE: 'standalone'
        });
        if (overlay) environment.write(settings.storeDir, overlay);
        const resolved = overlay ? resolveSettings({
            GOOBSTER_DATA_DIR: path.join(root, 'data'),
            GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
            GOOBSTER_MANAGER_PORT: '0',
            GOOBSTER_MANAGER_RECONCILE: '0',
            GOOBSTER_RUNTIME_MODE: 'standalone'
        }) : settings;
        const store = createStore({ root: resolved.storeDir });
        store.init();
        store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
        const manager = createManager({ settings: resolved, logger: silent, extraKinds: extensions.kinds });
        await manager.init();
        const fakes = createFakeWorkers();
        const supervisor = createSupervisor({ manager, adapter: fakes.adapter, checkHealth: fakes.checkHealth, sandboxActive: () => false, logger: silent, policy: FAST_POLICY });
        const unregister = registry.register(resolved.storeDir, supervisor);
        live.push({ supervisor, unregister, fakes });
        return { root, settings: resolved, manager, supervisor, fakes };
    }

    test('the supervisor starts workers with the overlay value in their environment, and shows neither it nor the store path', async () => {
        const { supervisor, fakes, settings } = await supervised({ GOOBSTER_DB_URL: SECRET_URL });
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'api ack' });
        expect(fakes.last('api').env.GOOBSTER_DB_URL).toBe(SECRET_URL);
        const status = JSON.stringify(await supervisor.status());
        expect(status).not.toContain('overlay-pw-8841');
        expect(status).not.toContain(settings.storeDir);
    });

    test('without an overlay the workers get no database URL from the manager', async () => {
        const { supervisor, fakes } = await supervised(null);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'api ack' });
        expect(fakes.last('api').env.GOOBSTER_DB_URL).toBeUndefined();
    });

    test('operations that run with an overlay never put its value in the journal, the audit log or the installation record', async () => {
        const { manager, settings, root } = await supervised({ GOOBSTER_DB_URL: SECRET_URL });
        const bridge = { principal: '100000000000000001', via: 'bridge' };
        const planned = await manager.engine.plan('features.set', { changes: { tavern: true } }, bridge);
        const validated = await manager.engine.validate(planned.id, bridge);
        await manager.engine.apply(validated.id, { revision: validated.revision }, bridge);

        const texts = everyFileText(settings.storeDir).filter(entry => !entry.startsWith(environment.fileFor(settings.storeDir)));
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) {
            expect(text).not.toContain('overlay-pw-8841');
            expect(text).not.toContain(SECRET_URL);
        }
        expect(everyFileText(root).some(entry => entry.startsWith(environment.fileFor(settings.storeDir)))).toBe(true);
    });
});

describe('the backup archive', () => {
    const sqliteOnly = process.env.GOOBSTER_DB_URL ? test.skip : test;

    sqliteOnly('does not carry the overlay (the manager store is not a backup file set) and passes verifyBackup', async () => {
        const backupService = require('@goobster/core/services/backupService');
        const dataDir = newDir('data');
        environment.write(path.join(dataDir, 'manager'), { GOOBSTER_DB_URL: SECRET_URL });
        fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'images', 'a.png'), 'png-bytes');
        const dest = newDir('archives');
        const { dir, manifest } = await backupService.createBackup({
            destDir: dest, includeConfig: false, dataDir, configPath: path.join(dataDir, 'none.json'), logger: silent
        });
        expect(manifest.files.map(item => item.id)).toEqual(['images']);
        for (const text of everyFileText(dir)) {
            expect(text).not.toContain('overlay-pw-8841');
            expect(text).not.toContain('environment.json');
        }

        const problemsOf = (run) => {
            try {
                run();
            } catch (error) {
                expect(error.code).toBe('UNVERIFIED');
                return error.problems;
            }
            throw new Error('expected the backup to be refused');
        };
        expect(backupService.verifyBackup(dir, { expectCounts: manifest.tables })).toMatchObject({ files: 1 });

        expect(problemsOf(() => backupService.verifyBackup(dir, { expectCounts: { ...manifest.tables, users: 3 } }))).toEqual(['COUNT_MISMATCH:users']);
        expect(problemsOf(() => backupService.verifyBackup(dir, { expectCounts: { no_such_table: 1 } }))).toEqual(['COUNT_MISMATCH:no_such_table']);

        const manifestFile = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, schemaFingerprint: 'stale' }));
        expect(problemsOf(() => backupService.verifyBackup(dir, { expectCounts: manifest.tables }))).toEqual(['FINGERPRINT_MISMATCH']);

        fs.writeFileSync(manifestFile, '{broken');
        expect(() => backupService.verifyBackup(dir, { expectCounts: {} })).toThrow();
    });
});

describe('verifyBackup on a pg-dump archive', () => {
    test('compares the live counts with the recorded ones without opening the dump, on either engine', () => {
        const backupService = require('@goobster/core/services/backupService');
        const dir = newDir('pgarchive');
        fs.mkdirSync(path.join(dir, 'database'));
        fs.writeFileSync(path.join(dir, 'database', 'goobster.dump'), 'not a real dump');
        const base = {
            format: 1, engine: 'postgres', schemaFingerprint: 'x',
            database: { kind: 'pg-dump', file: path.join('database', 'goobster.dump') },
            tables: { users: 2, messages: 5 }, files: [], config: { included: false }
        };
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(base));
        let problems = null;
        try {
            backupService.verifyBackup(dir, { expectCounts: { users: 2, messages: 6, absent: 1 } });
        } catch (error) {
            expect(error.code).toBe('UNVERIFIED');
            problems = error.problems;
        }
        expect(problems).toEqual(['FINGERPRINT_MISMATCH', 'COUNT_MISMATCH:messages', 'COUNT_MISMATCH:absent']);
    });
});

describe('install.uninstall', () => {
    async function installed() {
        const root = tempDir(cleanup, 'overlay-install');
        const releaseDir = tempDir(cleanup, 'overlay-src');
        const release = makeRelease(releaseDir);
        const harness = await newHarness({ root });
        await drive(harness, 'install.new', { source: release.dir, features: ['tavern'], release: { allowUnsigned: true } });
        environment.write(harness.settings.storeDir, { GOOBSTER_DB_URL: SECRET_URL });
        return harness;
    }

    test('a full removal deletes the overlay with the data it points at; the store itself stays for the tombstone', async () => {
        const harness = await installed();
        const doc = harness.manager.store.readInstallation().doc;
        expect(await codeOf(drive(harness, 'install.uninstall', { keepData: false }))).toBe('CONFIRMATION_REQUIRED');
        expect(fs.existsSync(environment.fileFor(harness.settings.storeDir))).toBe(true);

        await drive(harness, 'install.uninstall', { keepData: false, confirm: doc.installationId });
        expect(fs.existsSync(environment.fileFor(harness.settings.storeDir))).toBe(false);
        expect(fs.existsSync(harness.settings.storeDir)).toBe(true);
    });

    test('a keep-data uninstall keeps it: it is the only pointer to the retained database', async () => {
        const harness = await installed();
        await drive(harness, 'install.uninstall', {});
        expect(environment.read(harness.settings.storeDir).values.GOOBSTER_DB_URL).toBe(SECRET_URL);
    });
});
