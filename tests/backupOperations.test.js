/**
 * Backup and restore as manager operations (#337,
 * documentation/backup_and_restore.md): the `backup.create` and
 * `backup.restore` kinds over a claimed, managed installation whose
 * maintenance barrier is entered by the operation itself (fake writers
 * acknowledge it), the archive inspection route's view, the file-set
 * completeness audit, and the failure of each durable sub-step.
 *
 * The helper operations run in this process (tests/helpers/backupFixture.js)
 * so the same specs run on SQLite and on an isolated Postgres schema; one
 * SQLite journey runs the real helper processes. Everything lives under one
 * throwaway directory.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-backup-ops-'));
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DB_PATH = path.join(DATA_DIR, 'goobster.sqlite');
process.env.GOOBSTER_DB_PATH = DB_PATH;
process.env.GOOBSTER_DATA_DIR = DATA_DIR;
process.env.GOOBSTER_CONFIG_PATH = CONFIG_PATH;
process.env.GOOBSTER_CACHE_DIR = path.join(ROOT, 'cache');
for (const name of ['GOOBSTER_UPLOADS_DIR', 'GOOBSTER_KG_ARTIFACTS_DIR', 'GOOBSTER_TAVERN_CAMPAIGNS_DIR', 'GOOBSTER_SELF_DOCS_OPERATOR_DIR', 'ELEVENLABS_API_KEY']) {
    delete process.env[name];
}

const db = require('@goobster/core/db');
const backupService = require('@goobster/core/services/backupService');
const archiveLib = require('@goobster/core/services/backupArchive');
const instanceState = require('@goobster/core/services/instanceStateService');
const workFailures = require('@goobster/core/services/workFailureService');
const inventoryModule = require('@goobster/core/db/resetInventory');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const runtimePaths = require('@goobster/core/runtimePaths');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const { createRestoreState } = require('@goobster/manager/backup/state');
const { inspectArchive, backupStatus } = require('@goobster/manager/backup/view');
const { createInProcessRunner } = require('@goobster/manager/backup/ops');
const { createBackupHarness, LOCAL, codeOf } = require('./helpers/backupFixture');

const PG = Boolean(process.env.GOOBSTER_DB_URL);
const PASSPHRASE = 'passphrase-never-appears-77c1';
const OTHER_PASSPHRASE = 'some-other-passphrase-0d42';
const TOKEN_MARK = 'discord-token-never-appears-5e1b';
const USER = '100000000000000042';
const GUILD = '200000000000000001';

const cleanups = [];
let counter = 0;
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});
afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------- the world */

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function writeFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** Every file under `dir`, relative, with its digest; a single file counts as itself. */
function digestTree(target) {
    const out = {};
    if (!fs.existsSync(target)) return out;
    if (fs.statSync(target).isFile()) return { '.': sha(fs.readFileSync(target)) };
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = path.join(prefix, entry.name);
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
            else out[rel] = sha(fs.readFileSync(path.join(dir, entry.name)));
        }
    };
    walk(target, '');
    return out;
}

function fileSetDigests() {
    const out = {};
    for (const set of archiveLib.FILE_SETS) out[set.id] = digestTree(set.resolve(DATA_DIR, process.env));
    return out;
}

const countOf = async (table) => Number((await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).c);

async function emptyDatabase() {
    const inventory = inventoryModule.buildInventory({ dataDir: DATA_DIR, cacheDir: process.env.GOOBSTER_CACHE_DIR });
    for (const table of inventory.order) await db.run(`DELETE FROM ${table}`);
}

function wipeData() {
    for (const name of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
        if (name.startsWith('goobster.sqlite')) continue;
        fs.rmSync(path.join(DATA_DIR, name), { recursive: true, force: true });
    }
}

/** What an operator would back up: rows (some in flight), files in several sets, config. */
async function seedWorld(label = 'one') {
    await emptyDatabase();
    wipeData();
    const project = await db.insert('INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @name)', { userId: USER, slug: `demo-${label}`, name: `Demo ${label}` });
    await db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, runnerId, leaseToken)
         VALUES (@projectId, @userId, 'python', 'while True: pass', 'RUNNING', 'runner-1', 'lease-1')`,
        { projectId: project, userId: USER }
    );
    await db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, finishedAt)
         VALUES (@projectId, @userId, 'python', 'print(1)', 'COMPLETED', @finishedAt)`,
        { projectId: project, userId: USER, finishedAt: '2026-10-01 10:00:00' }
    );
    await db.insert(
        `INSERT INTO followups (guildId, channelId, userId, note, dueAt, status)
         VALUES (@guildId, '300000000000000001', @userId, @note, '2030-01-01 00:00:00', 'PENDING')`,
        { guildId: GUILD, userId: USER, note: `remember ${label}` }
    );
    writeFile(path.join(DATA_DIR, 'sandbox', 'projects', 'demo', 'main.py'), `print("${label}")\n`);
    writeFile(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), `uploaded ${label}\n`);
    writeFile(path.join(DATA_DIR, 'images', 'a.png'), `png ${label}`);
    writeFile(path.join(DATA_DIR, 'self-docs', 'house-rules.md'), `# Rules ${label}\n`);
    writeFile(path.join(DATA_DIR, 'tavern', 'campaigns', 'override.yaml'), `id: ${label}\n`);
    writeFile(path.join(DATA_DIR, 'web-push-keys.json'), `{"label":"${label}"}`);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ clientId: '1', guildIds: [GUILD], token: TOKEN_MARK, label, webapp: { enabled: true } }, null, 2));
}

async function snapshotWorld() {
    return {
        rows: {
            jobs: await countOf('observatory_jobs'),
            followups: await countOf('followups'),
            projects: await countOf('observatory_projects')
        },
        files: fileSetDigests(),
        config: fs.existsSync(CONFIG_PATH) ? sha(fs.readFileSync(CONFIG_PATH)) : null
    };
}

async function dbFingerprint() {
    const rows = await db.all('SELECT id, status, runnerId FROM observatory_jobs ORDER BY id');
    return sha(JSON.stringify(rows));
}

async function makeHarness(options = {}) {
    counter += 1;
    const root = path.join(ROOT, `h${counter}`);
    fs.mkdirSync(root, { recursive: true });
    return createBackupHarness({
        root,
        dataDir: DATA_DIR,
        configPath: CONFIG_PATH,
        sqlitePath: DB_PATH,
        dbUrl: process.env.GOOBSTER_DB_URL || null,
        cleanups,
        ...options
    });
}

const archivesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.startsWith('goobster-backup-')).map(name => path.join(dir, name)) : []);

function restoreInput(h, dir, extra = {}) {
    return { dir, confirm: h.installationId(), passphrase: PASSPHRASE, ...extra };
}

/** Make an archive of the current world through the kind, outside the data tree. */
async function backupViaKind(h, extra = {}) {
    const dest = path.join(h.root, `archives-${++counter}`);
    const { applied } = await h.drive('backup.create', { dir: dest, passphrase: PASSPHRASE, ...extra });
    return { dir: applied.result.dir, result: applied.result, dest };
}

const sub = (state, name) => state.mutate[name];
const lastStep = (run, name) => run.operation.steps.filter(step => step.name === name).slice(-1)[0];

/* ===================================================== registration */

describe('registration', () => {
    test('both audit actions are registered on the manager and the portal side, and the kinds are public', async () => {
        for (const action of ['manager.backup.create', 'manager.backup.restore']) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(action);
            expect(operatorAudit.ACTIONS.has(action)).toBe(true);
        }
        for (const action of ['host.backup.apply', 'host.reset.apply']) expect(operatorAudit.ACTIONS.has(action)).toBe(true);
        await seedWorld();
        const h = await makeHarness();
        expect(h.manager.engine.kinds).toEqual(expect.arrayContaining(['backup.create', 'backup.restore']));
    });
});

/* ===================================================== backup.create */

describe('backup.create', () => {
    test('the plan says what is archived, that only config.json is encrypted and which secrets are omitted; the apply verifies and answers with counts', async () => {
        await seedWorld();
        process.env.OPENAI_API_KEY = 'sk-env-secret-never-appears';
        try {
            const h = await makeHarness({ env: { OPENAI_API_KEY: 'sk-env-secret-never-appears' } });
            const dest = path.join(h.root, 'archives');
            const { planned, applied } = await h.drive('backup.create', { dir: dest, passphrase: PASSPHRASE });
            const plan = planned.plan;
            expect(plan).toMatchObject({
                effect: 'backup-create',
                boundary: 'read-only',
                destination: dest,
                database: { included: true, encrypted: false },
                config: { included: true, encrypted: true },
                archiveEncrypted: false,
                maintenance: { held: false, comparedWith: 'archive-structure' }
            });
            expect(plan.fileSets.map(set => set.id)).toEqual(expect.arrayContaining(['projects', 'uploads', 'images', 'self-docs', 'tavern-campaigns', 'web-push-keys']));
            expect(plan.omittedSecrets.join(' ')).toContain('OPENAI_API_KEY');
            expect(plan.notes.join(' ')).toMatch(/Only config\.json is encrypted/);
            expect(JSON.stringify(plan)).not.toContain('sk-env-secret-never-appears');

            expect(applied.operation.status).toBe('applied');
            expect(applied.operation.steps.map(step => step.name)).toEqual(expect.arrayContaining(['preflight', 'archive', 'verify']));
            expect(applied.result).toMatchObject({
                verified: true,
                verifiedAgainst: 'archive-structure',
                engine: db.engine,
                config: { included: true, encrypted: true },
                archiveEncrypted: false
            });
            expect(applied.result.rows).toBeGreaterThan(0);
            expect(applied.result.omittedSecrets.join(' ')).toContain('OPENAI_API_KEY');
            expect(archivesIn(dest)).toHaveLength(1);
            const manifest = archiveLib.inspectBackup(applied.result.dir);
            expect(manifest.quiesced).toBe(false);
            expect(manifest.fileSetsKnown).toEqual(archiveLib.FILE_SETS.map(set => set.id));
            expect(manifest.files.map(set => set.id)).toEqual(expect.arrayContaining(['self-docs', 'web-push-keys']));
            expect(fs.readFileSync(path.join(applied.result.dir, 'config.json.enc'), 'utf8')).not.toContain(TOKEN_MARK);
        } finally {
            delete process.env.OPENAI_API_KEY;
        }
    }, 60000);

    test('inside a held barrier the backup is compared with the live counts and recorded as quiesced', async () => {
        await seedWorld();
        const h = await makeHarness();
        const ref = await h.enter('backup');
        const { applied } = await h.drive('backup.create', { dir: path.join(h.root, 'archives'), passphrase: PASSPHRASE });
        expect(applied.result.verifiedAgainst).toBe('live-counts');
        expect(archiveLib.inspectBackup(applied.result.dir).quiesced).toBe(true);
        expect(lastStep(applied, 'preflight').detail).toMatchObject({ quiesced: true });
        await h.release(ref);
    }, 60000);

    test('refusals: no passphrase while config.json is included, a destination inside the data it copies, unknown fields, a relative path', async () => {
        await seedWorld();
        const h = await makeHarness();
        const dest = path.join(h.root, 'archives');
        expect(await codeOf(h.drive('backup.create', { dir: dest }))).toBe('PASSPHRASE_REQUIRED');
        expect(await codeOf(h.drive('backup.create', { dir: path.join(DATA_DIR, 'images', 'sub') , passphrase: PASSPHRASE }))).toBe('BACKUP_DESTINATION_UNSAFE');
        expect(await codeOf(h.drive('backup.create', { dir: h.settings.storeDir, passphrase: PASSPHRASE }))).toBe('BACKUP_DESTINATION_UNSAFE');
        expect(await codeOf(h.drive('backup.create', { dir: dest, passphrase: PASSPHRASE, extra: 1 }))).toBe('INVALID_INPUT');
        expect(await codeOf(h.drive('backup.create', { dir: 'relative/path', passphrase: PASSPHRASE }))).toBe('INVALID_INPUT');
        expect(await codeOf(h.drive('backup.create', { dir: dest, passphrase: PASSPHRASE, includeConfig: 'yes' }))).toBe('INVALID_INPUT');
        expect(archivesIn(dest)).toHaveLength(0);
    }, 60000);

    test('config.json can be left out on purpose: no passphrase is needed and no config is in the archive', async () => {
        await seedWorld();
        const h = await makeHarness();
        const { planned, applied } = await h.drive('backup.create', { dir: path.join(h.root, 'archives'), includeConfig: false });
        expect(planned.plan.config).toMatchObject({ included: false, encrypted: false, reason: 'left out on purpose' });
        expect(applied.result.config).toEqual({ included: false, encrypted: false });
        expect(fs.existsSync(path.join(applied.result.dir, 'config.json.enc'))).toBe(false);
    }, 60000);

    test('the passphrase and the config are in no journal record, audit entry or result; the audit entry is numbers and flags', async () => {
        await seedWorld();
        const h = await makeHarness();
        const { applied } = await h.drive('backup.create', { dir: path.join(h.root, 'archives'), passphrase: PASSPHRASE });
        const text = h.journalText() + JSON.stringify(applied);
        expect(text).not.toContain(PASSPHRASE);
        expect(text).not.toContain(TOKEN_MARK);
        const entry = h.manager.journal.readAudit().entries.find(item => item.action === 'manager.backup.create');
        expect(entry).toMatchObject({ outcome: 'applied', via: 'bridge' });
        expect(Object.values(entry.detail).every(value => typeof value === 'number' || typeof value === 'boolean')).toBe(true);
        expect(JSON.stringify(entry)).not.toContain(h.root);
    }, 60000);

    test('a backup that cannot be verified is reported as BACKUP_UNVERIFIED and says where it was left', async () => {
        await seedWorld();
        const h = await makeHarness();
        const real = createInProcessRunner();
        h.settings.backupDeps.runChild = async (op, request) => {
            const out = await real(op, request);
            return op === 'backup' ? { ...out, verified: false, problems: ['SNAPSHOT_EMPTY'] } : out;
        };
        const error = await h.drive('backup.create', { dir: path.join(h.root, 'archives'), passphrase: PASSPHRASE }).then(() => null, e => e);
        expect(error.code).toBe('BACKUP_UNVERIFIED');
        expect(error.details.problems).toEqual(['SNAPSHOT_EMPTY']);
    }, 60000);
});

/* ===================================================== inspect */

describe('the archive inspection view', () => {
    test('counts, file sets, config handling, the engine and schema verdicts, and no path but the one asked for', async () => {
        await seedWorld();
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const view = inspectArchive({ settings: h.settings, dir });
        expect(view).toMatchObject({
            dir,
            engine: db.engine,
            engineMatches: true,
            fingerprintMatches: true,
            configIncluded: true,
            configEncrypted: true,
            archiveEncrypted: false,
            restorable: true,
            blocks: [],
            integrity: { ok: true, problems: [] },
            target: { engine: db.engine, installationRecorded: true, dataRootMatches: true }
        });
        expect(view.fileSets.map(set => set.id)).toEqual(expect.arrayContaining(['projects', 'uploads', 'self-docs']));
        expect(view.rows).toBeGreaterThan(0);
        const text = JSON.stringify(view);
        expect(text).not.toContain(TOKEN_MARK);
        expect(text.split(h.root).length - 1).toBe(1);
    }, 60000);

    test('another engine or schema, a truncated archive and a directory that is not an archive are named', async () => {
        await seedWorld();
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const manifestFile = path.join(dir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, engine: db.engine === 'sqlite' ? 'postgres' : 'sqlite' }));
        expect(inspectArchive({ settings: h.settings, dir })).toMatchObject({ engineMatches: false, restorable: false, blocks: expect.arrayContaining(['ENGINE_MISMATCH']) });

        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, schemaFingerprint: '0000000000000000' }));
        const changed = inspectArchive({ settings: h.settings, dir });
        expect(changed).toMatchObject({ fingerprintMatches: false, schemaChangeNeedsAcceptance: true, warnings: expect.arrayContaining(['SCHEMA_CHANGED']) });

        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        fs.rmSync(path.join(dir, 'files', 'uploads'), { recursive: true });
        const broken = inspectArchive({ settings: h.settings, dir });
        expect(broken.integrity.ok).toBe(false);
        expect(broken.integrity.problems).toContain('FILES_MISSING:uploads');
        expect(broken.blocks).toContain('ARCHIVE_INCOMPLETE');

        expect(() => inspectArchive({ settings: h.settings, dir: h.root })).toThrow(expect.objectContaining({ code: 'NOT_AN_ARCHIVE' }));
        expect(() => inspectArchive({ settings: h.settings, dir: path.join(h.root, 'missing') })).toThrow(expect.objectContaining({ code: 'NOT_AN_ARCHIVE' }));
        expect(() => inspectArchive({ settings: h.settings, dir: 'relative' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }, 60000);

    test('an archive stored inside a file set a restore replaces is flagged', async () => {
        await seedWorld();
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const inside = path.join(DATA_DIR, 'images', 'stored');
        fs.cpSync(dir, inside, { recursive: true });
        expect(inspectArchive({ settings: h.settings, dir: inside }).blocks).toContain('ARCHIVE_INSIDE_DATA');
    }, 60000);

    test('the status names a suggested destination from the record and no restore before the first', async () => {
        await seedWorld();
        const h = await makeHarness();
        const status = backupStatus({ settings: h.settings });
        expect(status).toMatchObject({ engine: db.engine, installation: { recorded: true }, suggestedDir: path.join(DATA_DIR, 'backups'), restore: null });
    });
});

/* ===================================================== restore */

describe('backup.restore', () => {
    test('the plan names what is replaced, that only config.json is encrypted, the paused-versus-maintenance difference and the confirmation', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const { planned } = await h.drive('backup.restore', restoreInput(h, dir), { apply: false });
        const plan = planned.plan;
        expect(plan).toMatchObject({
            effect: 'restore-backup',
            boundary: 'irreversible-after-mutate',
            archive: { dir, engine: db.engine, archiveEncrypted: false },
            compatibility: { engineMatches: true, fingerprintMatches: true, schemaChanged: false },
            config: { included: true, encrypted: true, restore: true, passphraseVerified: true },
            database: { engine: db.engine, occupied: true, replaced: true },
            safetyBackup: { required: true },
            maintenance: { mode: 'enter' },
            afterwards: { instancePaused: true, maintenance: 'held' },
            confirmation: { required: true, satisfied: true }
        });
        expect(plan.replaces.fileSets).toEqual(expect.arrayContaining(['projects', 'uploads', 'images', 'self-docs']));
        expect(plan.afterwards.resume).toMatch(/maintenance\.release lifts the barrier and does not resume/);
        expect(plan.notes.join(' ')).toMatch(/config\.json is stored encrypted/);
        expect(plan.steps.map(step => step.name)).toEqual(['preflight', 'maintenance', 'backup', 'mutate', 'verify', 'cutover', 'release']);
        expect(JSON.stringify(planned)).not.toContain(PASSPHRASE);
    }, 60000);

    test('the whole restore: safety backup, database, file sets and config back; paused; in-flight work interrupted; barrier held; locations retained', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const before = await snapshotWorld();
        expect(before.rows.jobs).toBe(2);

        // The installation moves on after the backup.
        await db.run('DELETE FROM observatory_jobs');
        await db.run('DELETE FROM followups');
        writeFile(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), 'changed after the backup\n');
        writeFile(path.join(DATA_DIR, 'web-uploads', 'new.txt'), 'new after the backup\n');
        fs.rmSync(path.join(DATA_DIR, 'images'), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ token: 'changed-after-backup', webapp: { enabled: true } }));
        const moved = await snapshotWorld();
        expect(moved.rows.jobs).toBe(0);

        const { applied } = await h.drive('backup.restore', restoreInput(h, dir));
        expect(applied.operation.status).toBe('applied');
        expect(applied.operation.steps.map(step => step.name)).toEqual(expect.arrayContaining(['preflight', 'maintenance', 'backup', 'mutate', 'verify', 'cutover', 'release']));
        const result = applied.result;
        expect(result).toMatchObject({
            engine: db.engine,
            database: { restored: true },
            config: { restored: true, skipped: null },
            instancePaused: true,
            rowCounts: { matchesArchive: true },
            maintenance: { held: true, enteredByRestore: true, phase: 'cutover' },
            workersRestarted: true
        });
        expect(result.safetyBackup.archive).toMatch(/^goobster-backup-/);
        expect(result.interrupted).toMatchObject({ job: 1 });
        expect(result.interruptedTotal).toBe(1);
        expect(result.files.map(item => item.id)).toEqual(expect.arrayContaining(['projects', 'uploads', 'images', 'self-docs']));
        expect(result.next.join(' ')).toMatch(/maintenance\.release/);
        expect(result.next.join(' ')).toMatch(/Resume/);
        expect(h.restarts).toEqual(['restart']);

        // The data is the archive's.
        const after = await snapshotWorld();
        expect(after.rows).toEqual(before.rows);
        expect(after.files).toEqual(before.files);
        expect(after.config).toBe(before.config);
        const interrupted = await db.get("SELECT status, error FROM observatory_jobs WHERE runnerId IS NULL AND status = 'FAILED'");
        expect(interrupted).toMatchObject({ status: 'FAILED', error: backupService.INTERRUPTED_REASON });
        expect(Number((await db.get('SELECT COUNT(*) AS c FROM work_failures')).c)).toBe(1);

        // Paused, and the barrier is a separate thing that is still up.
        expect(await instanceState.getPause()).toMatchObject({ reason: 'restore' });
        const barrier = h.barrierDoc();
        expect(barrier.active).toBe(true);
        expect(barrier.phase).toBe('cutover');

        // What was replaced is kept, with its locations in the result and the status.
        const retained = result.retained;
        expect(retained.map(item => item.kind)).toEqual(expect.arrayContaining(['files', 'config', 'safety-backup']));
        const configAside = retained.find(item => item.kind === 'config');
        expect(fs.readFileSync(configAside.path, 'utf8')).toContain('changed-after-backup');
        const uploadsAside = retained.find(item => item.kind === 'files' && item.id === 'uploads');
        expect(fs.readFileSync(path.join(uploadsAside.path, 'new.txt'), 'utf8')).toContain('new after the backup');
        expect(archivesIn(path.join(DATA_DIR, 'backups'))).toHaveLength(1);
        if (!PG) expect(retained.some(item => item.kind === 'database' && fs.existsSync(item.path))).toBe(true);
        const status = backupStatus({ settings: h.settings });
        expect(status.restore).toMatchObject({ status: 'completed', archive: path.basename(dir) });
        expect(status.restore.retained.length).toBe(retained.length);

        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
        expect(h.barrierDoc().active).toBe(false);
        expect(await instanceState.getPause()).toMatchObject({ reason: 'restore' });
    }, 120000);

    test('the audit entry is numbers and flags; no passphrase, config value or path is in the journal, the audit log or the state file', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const { applied } = await h.drive('backup.restore', restoreInput(h, dir));
        const text = h.journalText() + JSON.stringify(applied.operation);
        expect(text).not.toContain(PASSPHRASE);
        expect(text).not.toContain(TOKEN_MARK);
        const entry = h.manager.journal.readAudit().entries.find(item => item.action === 'manager.backup.restore');
        expect(entry).toMatchObject({ outcome: 'applied' });
        expect(entry.detail).toMatchObject({ configRestored: true, safetyBackup: true, schemaChanged: false, mismatches: 0 });
        expect(Object.values(entry.detail).every(value => typeof value === 'number' || typeof value === 'boolean')).toBe(true);
        expect(JSON.stringify(entry)).not.toContain(DATA_DIR);
        const stateFile = fs.readFileSync(path.join(h.settings.storeDir, 'restore.json'), 'utf8');
        expect(stateFile).not.toContain(PASSPHRASE);
        expect(stateFile).not.toContain(TOKEN_MARK);
        const operations = fs.readdirSync(path.join(h.settings.storeDir, 'operations')).map(name => fs.readFileSync(path.join(h.settings.storeDir, 'operations', name), 'utf8')).join('\n');
        expect(operations).not.toContain(PASSPHRASE);
        const barrier = h.barrierDoc();
        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
    }, 120000);

    test('a wrong passphrase is refused before anything changes: the database, every file set, the config and the barrier are as they were', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const files = fileSetDigests();
        const config = sha(fs.readFileSync(CONFIG_PATH));
        const jobs = await dbFingerprint();
        const error = await h.drive('backup.restore', restoreInput(h, dir, { passphrase: OTHER_PASSPHRASE }), { apply: false }).then(() => null, e => e);
        expect(error.code).toBe('BAD_PASSPHRASE');
        expect(fileSetDigests()).toEqual(files);
        expect(sha(fs.readFileSync(CONFIG_PATH))).toBe(config);
        expect(await dbFingerprint()).toBe(jobs);
        expect(h.barrierDoc().active).toBe(false);
        expect(fs.existsSync(path.join(h.settings.storeDir, 'restore.json'))).toBe(false);
        expect(archivesIn(path.join(DATA_DIR, 'backups'))).toHaveLength(0);
        expect(await instanceState.getPause()).toBeFalsy();
    }, 60000);

    test('without a passphrase, or with withoutConfig, config.json is left exactly as it is and the plan says why', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ token: 'local-config-stays', webapp: { enabled: true } }));
        const config = sha(fs.readFileSync(CONFIG_PATH));

        const noPass = await h.drive('backup.restore', { dir, confirm: h.installationId() }, { apply: false });
        expect(noPass.planned.plan.config).toMatchObject({ included: true, restore: false, skipped: 'no passphrase was given', passphraseVerified: false });
        expect(noPass.planned.plan.secretsToReenter.join(' ')).toMatch(/config\.json: recreate it/);

        const { planned, applied } = await h.drive('backup.restore', restoreInput(h, dir, { withoutConfig: true }));
        expect(planned.plan.config).toMatchObject({ restore: false, skipped: 'excluded on purpose (without config)', passphraseVerified: false });
        expect(applied.result.config).toMatchObject({ restored: false, skipped: 'excluded by --without-config' });
        expect(applied.result.secretsToReenter.join(' ')).toMatch(/config\.json: recreate it/);
        expect(sha(fs.readFileSync(CONFIG_PATH))).toBe(config);
        expect(applied.result.retained.some(item => item.kind === 'config')).toBe(false);
        const barrier = h.barrierDoc();
        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
    }, 120000);

    test('another engine and another schema are refused with their own codes; an accepted schema change restores and is recorded', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const manifestFile = path.join(dir, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const jobs = await dbFingerprint();

        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, engine: db.engine === 'sqlite' ? 'postgres' : 'sqlite' }));
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, dir), { apply: false }))).toBe('ENGINE_MISMATCH');

        fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, schemaFingerprint: '0000000000000000' }));
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, dir), { apply: false }))).toBe('SCHEMA_MISMATCH');
        expect(await dbFingerprint()).toBe(jobs);
        expect(h.barrierDoc().active).toBe(false);

        const { planned, applied } = await h.drive('backup.restore', restoreInput(h, dir, { acceptSchemaChange: true }));
        expect(planned.plan.compatibility).toMatchObject({ fingerprintMatches: false, schemaChanged: true, acceptSchemaChange: true });
        expect(applied.result.schemaChanged).toBe(true);
        const barrier = h.barrierDoc();
        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
    }, 120000);

    test('refusals: no confirmation, a wrong one, a foreign data root, an unknown field, an archive that is not complete, an unsafe source', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        expect(await codeOf(h.drive('backup.restore', { dir, passphrase: PASSPHRASE }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, dir, { confirm: 'not-the-id' })))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, dir, { surprise: true }), { apply: false }))).toBe('INVALID_INPUT');
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, path.join(h.root, 'nothing')), { apply: false }))).toBe('NOT_AN_ARCHIVE');

        const inside = path.join(DATA_DIR, 'self-docs', 'archive');
        fs.cpSync(dir, inside, { recursive: true });
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, inside), { apply: false }))).toBe('ARCHIVE_INSIDE_DATA');

        fs.rmSync(path.join(dir, 'files', 'projects'), { recursive: true });
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, dir)))).toBe('ARCHIVE_INCOMPLETE');
        expect(h.barrierDoc().active).toBe(false);

        h.manager.store.updateInstallation(draft => ({ ...draft, roots: { ...draft.roots, data: path.join(h.root, 'elsewhere') } }));
        expect(await codeOf(h.drive('backup.restore', restoreInput(h, dir), { apply: false }))).toBe('FOREIGN_TARGET');
    }, 120000);

    test('only a claimed manager with a bridge, setup, recovery or local session may restore; an unclaimed one refuses', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const planned = await h.manager.engine.plan('backup.restore', restoreInput(h, dir), LOCAL);
        expect(planned.plan.effect).toBe('restore-backup');
        expect(await codeOf(h.manager.engine.plan('backup.restore', restoreInput(h, dir), { principal: 'x', via: 'bootstrap' }))).toBe('STATE_NOT_ALLOWED');
    }, 60000);
});

/* ===================================================== file-set audit */

describe('the file-set completeness audit', () => {
    const REPO = path.join(__dirname, '..');

    /** Everything the installation keeps under data/ (or next to it), found by reading the source. */
    function dataPathsInSource() {
        const found = new Set();
        const roots = ['packages/core', 'apps/bot', 'apps/api', 'apps/manager', 'apps/sandbox', 'scripts'];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                const rel = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(rel);
                else if (entry.name.endsWith('.js') && !rel.endsWith('backupArchive.js')) {
                    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
                    for (const match of text.matchAll(/(?:dataDir|DATA_DIR|dataRoot)\s*,\s*((?:'[A-Za-z0-9_.-]+'\s*,?\s*)+)\)/g)) {
                        found.add(match[1].split(',').map(part => part.trim().replace(/'/g, '')).filter(Boolean).join('/'));
                    }
                    for (const match of text.matchAll(/'data'\s*,\s*((?:'[A-Za-z0-9_.-]+'\s*,?\s*)+)\)/g)) {
                        found.add(`@cwd/${match[1].split(',').map(part => part.trim().replace(/'/g, '')).filter(Boolean).join('/')}`);
                    }
                }
            }
        };
        for (const root of roots) walk(root);
        return found;
    }

    test('every classification names an archived set that exists or says why it is left out', () => {
        const setIds = new Set(archiveLib.FILE_SETS.map(set => set.id));
        const seen = new Set();
        for (const item of archiveLib.DATA_CLASSIFICATION) {
            expect(seen.has(item.path)).toBe(false);
            seen.add(item.path);
            if (item.disposition === 'archived') {
                expect(item.archivedAs === 'database' || setIds.has(item.archivedAs)).toBe(true);
                expect(item.since).toMatch(/^#\d+$/);
            } else {
                expect(item.disposition).toBe('excluded');
                expect(item.reason.length).toBeGreaterThan(10);
            }
        }
        for (const id of setIds) {
            expect(archiveLib.DATA_CLASSIFICATION.some(item => item.archivedAs === id)).toBe(true);
        }
    });

    test('every file set resolves to the path its classification names', () => {
        for (const set of archiveLib.FILE_SETS) {
            const item = archiveLib.DATA_CLASSIFICATION.find(entry => entry.archivedAs === set.id);
            const expected = path.join(DATA_DIR, ...item.path.split('/'));
            expect(set.resolve(DATA_DIR, {})).toBe(expected);
        }
    });

    test('a directory the source keeps under data/ that no classification mentions fails the build', () => {
        const classified = new Set(archiveLib.DATA_CLASSIFICATION.map(item => item.path));
        const covered = (candidate) => [...classified].some(known => candidate === known || candidate.startsWith(`${known}/`) || known.startsWith(`${candidate}/`));
        const unclassified = [...dataPathsInSource()]
            .map(item => item.replace(/^@cwd\//, ''))
            .filter(item => !covered(item));
        expect(unclassified).toEqual([]);
    });

    test('the paths runtimePaths and the config resolve under data/ are all classified', () => {
        const tops = new Set(archiveLib.DATA_CLASSIFICATION.map(item => item.path.split('/')[0]));
        for (const name of ['manager', 'backups', 'features.json']) expect(tops.has(name)).toBe(true);
        expect(runtimePaths.dataDir).toBe(DATA_DIR);
    });

    test('a backup copies every archived set that exists and records what it knows and what it leaves out', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const manifest = archiveLib.inspectBackup(dir);
        const present = archiveLib.FILE_SETS.filter(set => fs.existsSync(set.resolve(DATA_DIR, {}))).map(set => set.id);
        expect(manifest.files.map(set => set.id).sort()).toEqual(present.sort());
        expect(manifest.excluded).toEqual(expect.arrayContaining(['manager', 'features.json', 'sandbox/venv']));
        for (const id of present) {
            const set = archiveLib.FILE_SETS.find(item => item.id === id);
            expect(digestTree(path.join(dir, 'files', id))).toEqual(digestTree(set.resolve(DATA_DIR, {})));
        }
    }, 60000);
});

/* ===================================================== failure injection */

describe('a restore that stops part way', () => {
    async function failing({ at, sub: substep = null, code = 'INJECTED' }) {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        await db.run('DELETE FROM followups');
        writeFile(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), 'changed after the backup\n');
        const real = createInProcessRunner();
        let armed = true;
        h.settings.backupDeps.runChild = async (op, request) => {
            const matches = at === op && (!substep || (substep === `files:${(request.only || [])[0]}`));
            if (armed && matches) {
                armed = false;
                const { ManagerError } = require('@goobster/manager/errors');
                throw new ManagerError(409, code, 'injected');
            }
            return real(op, request);
        };
        const error = await h.drive('backup.restore', restoreInput(h, dir)).then(() => null, e => e);
        return { h, dir, error, rearm: () => { armed = false; }, real };
    }

    test('the database sub-step: failed, barrier held and marked failed, nothing else touched, the set-aside and safety backup retained, status names it', async () => {
        const { h, error } = await failing({ at: 'restoreDatabase' });
        expect(error.code).toBe('INJECTED');
        expect(error.operation.status).toBe('failed');
        const state = createRestoreState({ storeDir: h.settings.storeDir }).read().doc;
        expect(state.status).toBe('failed');
        expect(state.failure).toMatchObject({ step: 'mutate', substep: 'database', code: 'INJECTED' });
        expect(sub(state, 'database')).toMatchObject({ done: false });
        expect(state.steps.backup).toMatchObject({ hadData: true, verified: true });
        const barrier = h.barrierDoc();
        expect(barrier.active).toBe(true);
        expect(barrier.mutateBegun).toBe(true);
        expect(barrier.journal.some(entry => entry.outcome === 'failed' && entry.code === 'INJECTED')).toBe(true);
        expect(fs.readFileSync(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), 'utf8')).toContain('changed after the backup');
        expect(archivesIn(path.join(DATA_DIR, 'backups'))).toHaveLength(1);
        const status = backupStatus({ settings: h.settings });
        expect(status.restore).toMatchObject({ status: 'failed', failure: { substep: 'database' } });
        expect(status.restore.advice).toMatch(/Nothing was rolled back/);
        expect(status.restore.retained.map(item => item.kind)).toContain('safety-backup');
    }, 120000);

    test('a file-set sub-step: the database is already the archive\'s, the sets before it are done, the set-aside is kept, and running it again finishes', async () => {
        const { h, dir, error, rearm } = await failing({ at: 'restoreFiles', sub: 'files:uploads' });
        expect(error.code).toBe('INJECTED');
        const state = createRestoreState({ storeDir: h.settings.storeDir }).read().doc;
        expect(state.failure).toMatchObject({ step: 'mutate', substep: 'files:uploads' });
        expect(sub(state, 'database')).toMatchObject({ done: true });
        expect(sub(state, 'files:projects')).toMatchObject({ done: true });
        expect(sub(state, 'files:uploads')).toMatchObject({ done: false });
        expect(Number((await db.get('SELECT COUNT(*) AS c FROM followups')).c)).toBe(1);
        expect(h.barrierDoc().active).toBe(true);
        expect(fs.readFileSync(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), 'utf8')).toContain('changed after the backup');

        rearm();
        const { planned, applied } = await h.drive('backup.restore', restoreInput(h, dir));
        expect(planned.plan.resumeOf).toMatchObject({ status: 'failed', done: expect.arrayContaining(['database', 'files:projects']) });
        expect(applied.result.resumed).toBe(true);
        expect(lastStep(applied, 'mutate').detail.alreadyDone).toEqual(expect.arrayContaining(['database', 'files:projects']));
        expect(lastStep(applied, 'backup').status).toBe('skipped');
        expect(fs.readFileSync(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), 'utf8')).toContain('uploaded one');
        expect(applied.result.safetyBackup).not.toBeNull();
        expect(archivesIn(path.join(DATA_DIR, 'backups'))).toHaveLength(1);
        expect(createRestoreState({ storeDir: h.settings.storeDir }).read().doc.status).toBe('completed');
    }, 180000);

    test('the config sub-step, then the verify step: each names itself, and the instance is paused only once the verify step ran', async () => {
        const first = await failing({ at: 'restoreConfig' });
        expect(first.error.code).toBe('INJECTED');
        const state = createRestoreState({ storeDir: first.h.settings.storeDir }).read().doc;
        expect(state.failure).toMatchObject({ substep: 'config' });
        expect(sub(state, 'database')).toMatchObject({ done: true });
        expect(await instanceState.getPause()).toBeFalsy();
        await first.h.release({ operationId: first.h.barrierDoc().operationId, fence: first.h.barrierDoc().fence }, { acknowledgeMutation: true });

        const second = await failing({ at: 'finish' });
        expect(second.error.code).toBe('INJECTED');
        const verify = createRestoreState({ storeDir: second.h.settings.storeDir }).read().doc;
        expect(verify.failure).toMatchObject({ step: 'verify', code: 'INJECTED' });
        expect(sub(verify, 'config')).toMatchObject({ done: true });
        expect(second.h.barrierDoc().active).toBe(true);
    }, 240000);

    test('a safety backup that cannot be verified stops everything and gives the barrier back: the target is untouched', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        const jobs = await dbFingerprint();
        const files = fileSetDigests();
        const real = createInProcessRunner();
        h.settings.backupDeps.runChild = async (op, request) => {
            const out = await real(op, request);
            return op === 'backup' ? { ...out, verified: false, problems: ['SNAPSHOT_EMPTY'], mismatchedTables: ['followups'] } : out;
        };
        const error = await h.drive('backup.restore', restoreInput(h, dir)).then(() => null, e => e);
        expect(error.code).toBe('BACKUP_UNVERIFIED');
        expect(h.barrierDoc().active).toBe(false);
        expect(await dbFingerprint()).toBe(jobs);
        expect(fileSetDigests()).toEqual(files);
        expect(createRestoreState({ storeDir: h.settings.storeDir }).read().doc).toMatchObject({ status: 'failed', failure: { step: 'backup', code: 'BACKUP_UNVERIFIED' } });
    }, 120000);

    test('a different archive cannot be restored while an earlier restore holds its barrier part way', async () => {
        const { h } = await failing({ at: 'restoreFiles', sub: 'files:projects' });
        const before = createRestoreState({ storeDir: h.settings.storeDir }).read().doc;
        await new Promise(resolve => setTimeout(resolve, 1100));
        const other = await backupViaKind(h);
        expect(other.dir).toBeTruthy();
        const refused = await h.drive('backup.restore', restoreInput(h, other.dir)).then(() => null, error => error);
        expect(refused && refused.code).toBe('RESTORE_IN_PROGRESS');
        expect(createRestoreState({ storeDir: h.settings.storeDir }).read().doc).toEqual(before);
        expect(h.barrierDoc().active).toBe(true);
    }, 120000);
});

describe('an empty target', () => {
    test('needs no safety backup: the step is skipped and nothing is written to data/backups', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        await emptyDatabase();
        if (!PG) {
            await db.closeConnection();
            fs.rmSync(DB_PATH, { force: true });
            fs.rmSync(`${DB_PATH}-wal`, { force: true });
            fs.rmSync(`${DB_PATH}-shm`, { force: true });
        }
        wipeData();
        fs.rmSync(CONFIG_PATH, { force: true });
        const { applied } = await h.drive('backup.restore', restoreInput(h, dir));
        expect(lastStep(applied, 'backup')).toMatchObject({ status: 'skipped' });
        expect(applied.result.safetyBackup).toBeNull();
        expect(applied.result.config.restored).toBe(true);
        expect(archivesIn(path.join(DATA_DIR, 'backups'))).toHaveLength(0);
        expect(await countOf('observatory_jobs')).toBe(2);
        const barrier = h.barrierDoc();
        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
    }, 120000);
});

describe('workFailures after a restore', () => {
    test('the interrupted work has its ledger rows with the fixed reason and code', async () => {
        await seedWorld('one');
        const h = await makeHarness();
        const { dir } = await backupViaKind(h);
        await h.drive('backup.restore', restoreInput(h, dir));
        const row = await db.get('SELECT kind, code, reason FROM work_failures ORDER BY id DESC LIMIT 1');
        expect(row).toMatchObject({ kind: 'job', code: backupService.INTERRUPTED_CODE, reason: backupService.INTERRUPTED_REASON });
        expect(typeof workFailures.record).toBe('function');
        const barrier = h.barrierDoc();
        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
    }, 120000);
});

/* ===================================================== real helper processes */

(PG ? describe.skip : describe)('the helper processes (SQLite)', () => {
    test('backup.create and backup.restore run through spawned helpers against a separate installation', async () => {
        const Database = require('better-sqlite3');
        const { createSeededSqlite } = require('./helpers/migrationSeed');
        const root = path.join(ROOT, 'real');
        const dataDir = path.join(root, 'data');
        const sqlitePath = path.join(dataDir, 'goobster.sqlite');
        const configPath = path.join(root, 'config.json');
        const seeded = createSeededSqlite(sqlitePath, { dataDir });
        fs.writeFileSync(configPath, JSON.stringify({ webapp: { enabled: true }, token: TOKEN_MARK }));
        writeFile(path.join(dataDir, 'web-uploads', 'keep.txt'), 'real upload\n');

        const h = await createBackupHarness({
            root: path.join(root, 'manager'),
            dataDir,
            configPath,
            sqlitePath,
            inProcess: false,
            cleanups
        });
        const countRows = (file) => {
            const conn = new Database(file, { readonly: true });
            try {
                return conn.prepare('SELECT COUNT(*) AS c FROM exchange_accounts').get().c;
            } finally {
                conn.close();
            }
        };
        const before = countRows(sqlitePath);
        expect(before).toBeGreaterThan(0);

        const dest = path.join(root, 'archives');
        const { applied: backup } = await h.drive('backup.create', { dir: dest, passphrase: PASSPHRASE });
        expect(backup.result).toMatchObject({ verified: true, engine: 'sqlite', config: { included: true, encrypted: true } });
        expect(backup.result.rows).toBeGreaterThan(100);
        expect(seeded.rows).toBeGreaterThan(100);

        const conn = new Database(sqlitePath);
        conn.pragma('foreign_keys = OFF');
        conn.exec('DELETE FROM option_positions; DELETE FROM short_positions; DELETE FROM exchange_accounts');
        conn.close();
        fs.writeFileSync(path.join(dataDir, 'web-uploads', 'keep.txt'), 'changed\n');
        expect(countRows(sqlitePath)).toBe(0);

        const { applied: restored } = await h.drive('backup.restore', { dir: backup.result.dir, confirm: h.installationId(), passphrase: PASSPHRASE });
        expect(restored.operation.status).toBe('applied');
        expect(restored.result.safetyBackup).not.toBeNull();
        expect(countRows(sqlitePath)).toBe(before);
        expect(fs.readFileSync(path.join(dataDir, 'web-uploads', 'keep.txt'), 'utf8')).toBe('real upload\n');
        expect(h.restarts.length).toBeGreaterThan(0);
        expect(h.journalText()).not.toContain(PASSPHRASE);
        expect(h.journalText()).not.toContain(TOKEN_MARK);
        const barrier = h.barrierDoc();
        await h.release({ operationId: barrier.operationId, fence: barrier.fence });
    }, 240000);
});
