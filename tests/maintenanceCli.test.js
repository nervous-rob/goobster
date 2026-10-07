/**
 * `goobster-manager backup`, `backup inspect` and `restore` (#337,
 * documentation/backup_and_restore.md): argument handling, the passphrase
 * sources (a file only its owner can read, GOOBSTER_BACKUP_PASSPHRASE_FILE,
 * the answers file, the hidden prompt) and the SECRET_ON_ARGV refusal, exit
 * codes, the confirmation, a restore that changes nothing on a wrong
 * passphrase, and "no secret in any output". The helper processes are real;
 * the installation is a seeded SQLite file over fake writers that
 * acknowledge the maintenance fence, so the journeys run on either engine
 * job (the CLI never reads GOOBSTER_DB_URL from the test process).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const Database = require('better-sqlite3');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-maintenance-cli-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const cli = require('@goobster/manager/cli');
const { newHarness, drive, tempDir } = require('./helpers/installFixture');
const { createSeededSqlite } = require('./helpers/migrationSeed');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { discover } = require('@goobster/manager/install/discover');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune, createBarrier } = require('@goobster/manager/maintenance/barrier');
const { createRestoreState } = require('@goobster/manager/backup/state');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');

const PASSPHRASE = 'cli-backup-passphrase-never-appears-9d3e';
const TOKEN_MARK = 'cli-config-token-never-appears-41ab';
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const cleanups = [];
const roots = [];

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

function startResponder({ fakes, settings }) {
    const env = { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir };
    const seen = new Map();
    const timer = setInterval(() => {
        for (const name of ['api', 'bot', 'sandbox']) {
            const proc = fakes.last(name);
            if (!proc || proc.exit) continue;
            const control = coreLifecycle.readControl(name, { env });
            const request = control && control.request;
            if (!request || seen.get(name) === request.id) continue;
            seen.set(name, request.id);
            const state = request.type === 'resume' ? 'resumed' : (request.type === 'maintenance' ? 'fenced' : null);
            if (state) coreMaintenance.writeFenceAck({ worker: name, fence: request.fence, state, pid: proc.pid, env });
        }
    }, 5);
    timer.unref();
    cleanups.push(() => clearInterval(timer));
}

async function setup() {
    const root = tempDir(roots, 'maintcli');
    const harness = await newHarness({
        root,
        env: { GOOBSTER_RUNTIME_MODE: 'standalone' },
        installDeps: { discover: opts => discover({ ...opts, exec: () => null }) }
    });
    const { settings, code } = harness;
    fs.mkdirSync(path.join(code, 'scripts'), { recursive: true });
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'goobster' }));
    fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true }, token: TOKEN_MARK }));
    fs.writeFileSync(path.join(code, 'scripts', 'auto-update.sh'), '#!/bin/bash\n# goobster-manager-guard\nexit 0\n');
    createSeededSqlite(settings.sqlitePath, { dataDir: settings.dataDir });
    fs.mkdirSync(path.join(settings.dataDir, 'web-uploads'), { recursive: true });
    fs.writeFileSync(path.join(settings.dataDir, 'web-uploads', 'keep.txt'), 'original upload\n');
    const found = discover({ fs, home: root, env: settings.env, exec: () => null });
    await drive(harness, 'adopt', { label: 'Rob', candidateId: found.candidates[0].id });

    tune(settings.storeDir, TUNING);
    const fakes = createFakeWorkers();
    const supervisor = createSupervisor({ manager: harness.manager, adapter: fakes.adapter, checkHealth: fakes.checkHealth, sandboxActive: () => false, logger: { info() {}, warn() {}, error() {} }, policy: { ...FAST_POLICY } });
    const unregister = registry.register(settings.storeDir, supervisor);
    await supervisor.start();
    await waitFor(async () => (await supervisor.status()).workers.every(worker => worker.ackedRevision === 0), { what: 'worker acks' });
    startResponder({ fakes, settings });
    cleanups.push(async () => {
        tune(settings.storeDir, null);
        await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
    });

    const installationId = () => harness.manager.store.readInstallation().doc.installationId;
    return { ...harness, installationId, env: { ...harness.settings.processEnv } };
}

function writeSecretFile(dir, name, text, mode = 0o600) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode });
    fs.chmodSync(file, mode);
    return file;
}

async function runCli(argv, { env, lines = [] } = {}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = [];
    const err = [];
    stdout.on('data', chunk => out.push(chunk));
    stderr.on('data', chunk => err.push(chunk));
    const exitCode = await cli.run(argv, {
        env,
        stdin: require('node:stream').Readable.from(lines.map(line => `${line}\n`)),
        stdout,
        stderr,
        installDeps: { home: env && env.HOME, readCrontab: () => null, writeCrontab: () => {}, exec: () => null }
    });
    return { exitCode, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

const all = result => result.stdout + result.stderr;

function countOf(file, table) {
    const conn = new Database(file, { readonly: true });
    try {
        return conn.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    } finally {
        conn.close();
    }
}

function emptyTable(file, tables) {
    const conn = new Database(file);
    try {
        conn.pragma('foreign_keys = OFF');
        for (const table of tables) conn.exec(`DELETE FROM ${table}`);
    } finally {
        conn.close();
    }
}

const ACCOUNT_TABLES = ['option_positions', 'short_positions', 'exchange_accounts'];

describe('arguments', () => {
    test('help lists the three commands and their flags; missing pieces and flags that do not apply exit 2', async () => {
        const { env, root } = await setup();
        const help = await runCli(['help'], { env });
        expect(help.exitCode).toBe(0);
        for (const word of ['backup inspect', '--passphrase-file', '--without-config', '--accept-schema-change', 'restore <dir>']) expect(help.stdout).toContain(word);
        const archive = path.join(root, 'archive');
        for (const argv of [
            ['backup'], ['backup', 'inspect'], ['restore'],
            ['backup', '--out', archive, '--without-config'], ['backup', '--out', archive, '--confirm', 'x'], ['backup', '--out', archive, '--release'],
            ['restore', archive, '--out', archive], ['restore', archive, '--include-config'],
            ['backup', 'inspect', archive, '--out', archive], ['install', '--out', archive], ['status', '--include-config'],
            ['restore', archive, '--without-config', '--passphrase-file', path.join(root, 'nope')], ['backup', '--out', archive, 'surplus']
        ]) {
            const result = await runCli(argv, { env });
            expect([argv.join(' '), result.exitCode]).toEqual([argv.join(' '), 2]);
        }
        expect(fs.existsSync(archive)).toBe(false);
    });

    test('a passphrase on the command line is refused as SECRET_ON_ARGV and never echoed; --passphrase-file is a path, not a secret', async () => {
        const { env, root } = await setup();
        const archive = path.join(root, 'archive');
        for (const argv of [
            ['backup', '--out', archive, '--include-config', '--passphrase', PASSPHRASE],
            ['backup', '--out', archive, `--passphrase=${PASSPHRASE}`],
            ['restore', archive, '--confirm', 'x', '--backup-passphrase', PASSPHRASE],
            ['restore', archive, '--token', TOKEN_MARK]
        ]) {
            const result = await runCli(argv, { env });
            expect(result.exitCode).toBe(2);
            expect(all(result)).toContain('SECRET_ON_ARGV');
            expect(all(result)).not.toContain(PASSPHRASE);
            expect(all(result)).not.toContain(TOKEN_MARK);
        }
        const accepted = await runCli(['backup', '--out', archive, '--include-config', '--passphrase-file', path.join(root, 'missing')], { env });
        expect(accepted.exitCode).toBe(2);
        expect(all(accepted)).toContain('PASSPHRASE_FILE_UNREADABLE');
        expect(all(accepted)).not.toContain('SECRET_ON_ARGV');
    });

    test('the answers schema carries the backup and restore definitions', async () => {
        const { env } = await setup();
        const schema = JSON.parse((await runCli(['schema'], { env })).stdout);
        expect(Object.keys(schema.definitions)).toEqual(expect.arrayContaining(['backup', 'restore']));
        expect(schema.definitions.restore.properties.passphrase.maxLength).toBe(1024);
    });
});

describe('backup', () => {
    test('without --include-config no passphrase is needed and the archive has no config.json', async () => {
        const { env, root, settings } = await setup();
        const archive = path.join(root, 'archives');
        const result = await runCli(['backup', '--out', archive, '--json'], { env });
        expect(result.exitCode).toBe(0);
        const doc = JSON.parse(result.stdout);
        expect(doc).toMatchObject({ ok: true, command: 'backup', result: { verified: true, engine: 'sqlite', config: { included: false }, archiveEncrypted: false } });
        expect(fs.existsSync(path.join(doc.result.dir, 'config.json.enc'))).toBe(false);
        expect(fs.existsSync(path.join(doc.result.dir, 'manifest.json'))).toBe(true);
        expect(all(result)).not.toContain(TOKEN_MARK);
        expect(fs.existsSync(settings.sqlitePath)).toBe(true);
    }, 120000);

    test('--include-config: a loose passphrase file is refused, an owner-only one works, and neither passphrase nor token reaches an output or the archive', async () => {
        const { env, root } = await setup();
        const archive = path.join(root, 'archives');
        const loose = writeSecretFile(root, 'loose.txt', `${PASSPHRASE}\n`, 0o644);
        const refused = await runCli(['backup', '--out', archive, '--include-config', '--passphrase-file', loose], { env });
        expect(refused.exitCode).toBe(2);
        expect(all(refused)).toContain('PASSPHRASE_FILE_PERMISSIONS');
        expect(all(refused)).not.toContain(PASSPHRASE);
        expect(fs.existsSync(archive)).toBe(false);

        const file = writeSecretFile(root, 'pass.txt', `${PASSPHRASE}\nsecond line ignored\n`);
        const text = await runCli(['backup', '--out', archive, '--include-config', '--passphrase-file', file], { env });
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain('backup.create: applied');
        expect(text.stdout).toContain('included, encrypted');
        expect(all(text)).not.toContain(PASSPHRASE);
        expect(all(text)).not.toContain(TOKEN_MARK);
        const made = fs.readdirSync(archive).filter(name => name.startsWith('goobster-backup-'));
        expect(made).toHaveLength(1);
        const enc = fs.readFileSync(path.join(archive, made[0], 'config.json.enc'), 'utf8');
        expect(enc).not.toContain(TOKEN_MARK);
        expect(enc).not.toContain(PASSPHRASE);
    }, 120000);

    test('the passphrase also comes from GOOBSTER_BACKUP_PASSPHRASE_FILE or the hidden prompt (asked twice); a missing one refuses', async () => {
        const { env, root } = await setup();
        const file = writeSecretFile(root, 'env-pass.txt', PASSPHRASE);
        const viaEnv = await runCli(['backup', '--out', path.join(root, 'a1'), '--include-config'], { env: { ...env, GOOBSTER_BACKUP_PASSPHRASE_FILE: file } });
        expect(viaEnv.exitCode).toBe(0);

        const prompted = await runCli(['backup', '--out', path.join(root, 'a2'), '--include-config'], { env, lines: [PASSPHRASE, PASSPHRASE] });
        expect(prompted.exitCode).toBe(0);
        expect(prompted.stderr).toContain('(hidden)');
        expect(all(prompted)).not.toContain(PASSPHRASE);

        const mismatch = await runCli(['backup', '--out', path.join(root, 'a3'), '--include-config'], { env, lines: [PASSPHRASE, 'something else'] });
        expect(mismatch.exitCode).toBe(2);
        expect(all(mismatch)).toContain('PASSPHRASE_MISMATCH');
        expect(fs.existsSync(path.join(root, 'a3'))).toBe(false);

        const none = await runCli(['backup', '--out', path.join(root, 'a4'), '--include-config'], { env, lines: [] });
        expect(none.exitCode).toBe(2);
        expect(fs.existsSync(path.join(root, 'a4'))).toBe(false);
    }, 180000);

    test('a destination inside the data it copies is refused', async () => {
        const { env, settings } = await setup();
        const result = await runCli(['backup', '--out', path.join(settings.dataDir, 'web-uploads', 'in'), '--json'], { env });
        expect(result.exitCode).toBe(3);
        expect(JSON.parse(result.stdout).error.code).toBe('BACKUP_DESTINATION_UNSAFE');
    });
});

describe('backup inspect and restore', () => {
    async function archived({ withConfig = true } = {}) {
        const world = await setup();
        const file = writeSecretFile(world.root, 'pass.txt', PASSPHRASE);
        const archive = path.join(world.root, 'archives');
        const result = await runCli(['backup', '--out', archive, ...(withConfig ? ['--include-config', '--passphrase-file', file] : []), '--json'], { env: world.env });
        expect(result.exitCode).toBe(0);
        return { ...world, passFile: file, dir: JSON.parse(result.stdout).result.dir };
    }

    test('inspect says what the archive holds and that it can be restored here; a directory that is not an archive exits 2', async () => {
        const { env, dir, root } = await archived();
        const text = await runCli(['backup', 'inspect', dir], { env });
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain('can be restored here');
        expect(text.stdout).toContain('only config.json is encrypted');
        const asJson = JSON.parse((await runCli(['backup', 'inspect', dir, '--json'], { env })).stdout);
        expect(asJson.archive).toMatchObject({ restorable: true, configIncluded: true, configEncrypted: true, engineMatches: true });
        expect(JSON.stringify(asJson)).not.toContain(PASSPHRASE);

        fs.mkdirSync(path.join(root, 'empty'));
        expect((await runCli(['backup', 'inspect', path.join(root, 'empty')], { env })).exitCode).toBe(2);
        expect((await runCli(['backup', 'inspect', path.join(root, 'missing')], { env })).exitCode).toBe(2);
    }, 180000);

    test('restore needs the installation id: none and a wrong one change nothing', async () => {
        const { env, dir, settings, passFile } = await archived();
        emptyTable(settings.sqlitePath, ACCOUNT_TABLES);
        const before = fs.readFileSync(settings.sqlitePath);
        const none = await runCli(['restore', dir, '--passphrase-file', passFile], { env });
        expect(none.exitCode).toBe(2);
        expect(all(none)).toContain('CONFIRMATION_REQUIRED');
        const wrong = await runCli(['restore', dir, '--passphrase-file', passFile, '--confirm', 'not-the-id'], { env });
        expect(wrong.exitCode).toBe(2);
        expect(all(wrong)).toContain('CONFIRMATION_REQUIRED');
        expect(Buffer.compare(fs.readFileSync(settings.sqlitePath), before)).toBe(0);
        expect(createBarrier({ settings, fs }).view().active).toBe(false);
        expect(createRestoreState({ storeDir: settings.storeDir }).read().doc).toBeNull();
    }, 180000);

    test('a wrong passphrase is refused before anything changes; no passphrase at all asks for one or for --without-config', async () => {
        const { env, dir, settings, installationId, root } = await archived();
        emptyTable(settings.sqlitePath, ACCOUNT_TABLES);
        const configBefore = fs.readFileSync(settings.configPath, 'utf8');
        const sqliteBefore = fs.readFileSync(settings.sqlitePath);
        const wrong = writeSecretFile(root, 'wrong.txt', 'not-the-passphrase');
        const refused = await runCli(['restore', dir, '--passphrase-file', wrong, '--confirm', installationId(), '--json'], { env });
        expect(refused.exitCode).toBe(2);
        expect(JSON.parse(refused.stdout).error.code).toBe('BAD_PASSPHRASE');
        expect(all(refused)).not.toContain('not-the-passphrase');

        const missing = await runCli(['restore', dir, '--confirm', installationId()], { env, lines: [] });
        expect(missing.exitCode).toBe(2);
        expect(all(missing)).toMatch(/INPUT_ENDED|PASSPHRASE_REQUIRED/);

        expect(fs.readFileSync(settings.configPath, 'utf8')).toBe(configBefore);
        expect(Buffer.compare(fs.readFileSync(settings.sqlitePath), sqliteBefore)).toBe(0);
        expect(countOf(settings.sqlitePath, 'exchange_accounts')).toBe(0);
        expect(createBarrier({ settings, fs }).view().active).toBe(false);
    }, 180000);

    test('a restore with the passphrase puts the database, files and config back, pauses, and holds the barrier until it is released', async () => {
        const { env, dir, settings, installationId, passFile } = await archived();
        const accounts = countOf(settings.sqlitePath, 'exchange_accounts');
        expect(accounts).toBeGreaterThan(0);
        emptyTable(settings.sqlitePath, ACCOUNT_TABLES);
        fs.writeFileSync(path.join(settings.dataDir, 'web-uploads', 'keep.txt'), 'changed after backup\n');
        fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true }, token: 'changed-after-backup' }));

        const result = await runCli(['restore', dir, '--passphrase-file', passFile, '--confirm', installationId()], { env });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('backup.restore: applied');
        expect(result.stdout).toContain('paused');
        expect(result.stdout).toContain('still held');
        expect(result.stdout).toContain('.pre-restore-');
        expect(all(result)).not.toContain(PASSPHRASE);
        expect(all(result)).not.toContain(TOKEN_MARK);
        expect(countOf(settings.sqlitePath, 'exchange_accounts')).toBe(accounts);
        expect(fs.readFileSync(path.join(settings.dataDir, 'web-uploads', 'keep.txt'), 'utf8')).toBe('original upload\n');
        expect(JSON.parse(fs.readFileSync(settings.configPath, 'utf8')).token).toBe(TOKEN_MARK);
        const view = createBarrier({ settings, fs }).view();
        expect(view.active).toBe(true);
        expect(createRestoreState({ storeDir: settings.storeDir }).read().doc).toMatchObject({ status: 'completed' });
        expect(fs.readdirSync(settings.dataDir).some(name => name.includes('.pre-restore-'))).toBe(true);

        const released = await runCli(['release'], { env });
        expect(released.exitCode).toBe(0);
        expect(createBarrier({ settings, fs }).view().active).toBe(false);
    }, 240000);

    test('--without-config leaves config.json alone, and --release lifts the barrier at the end', async () => {
        const { env, dir, settings, installationId } = await archived();
        emptyTable(settings.sqlitePath, ACCOUNT_TABLES);
        fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true }, token: 'local-config-stays' }));
        const result = await runCli(['restore', dir, '--without-config', '--confirm', installationId(), '--release', '--json'], { env });
        expect(result.exitCode).toBe(0);
        const doc = JSON.parse(result.stdout);
        expect(doc).toMatchObject({ ok: true, command: 'restore', result: { config: { restored: false }, maintenance: { held: false } } });
        expect(JSON.parse(fs.readFileSync(settings.configPath, 'utf8')).token).toBe('local-config-stays');
        expect(createBarrier({ settings, fs }).view().active).toBe(false);
        expect(countOf(settings.sqlitePath, 'exchange_accounts')).toBeGreaterThan(0);
    }, 240000);

    test('an archive without config.json restores with no passphrase question', async () => {
        const { env, dir, settings, installationId } = await archived({ withConfig: false });
        emptyTable(settings.sqlitePath, ACCOUNT_TABLES);
        const result = await runCli(['restore', dir, '--confirm', installationId(), '--release'], { env, lines: [] });
        expect(result.exitCode).toBe(0);
        expect(countOf(settings.sqlitePath, 'exchange_accounts')).toBeGreaterThan(0);
    }, 240000);

    test('the journal, the audit log and the restore state hold neither the passphrase nor the config token', async () => {
        const { env, dir, settings, installationId, passFile, manager } = await archived();
        emptyTable(settings.sqlitePath, ACCOUNT_TABLES);
        const result = await runCli(['restore', dir, '--passphrase-file', passFile, '--confirm', installationId(), '--release'], { env });
        expect(result.exitCode).toBe(0);
        const text = JSON.stringify(manager.journal.list()) + JSON.stringify(manager.journal.readAudit().entries) + JSON.stringify(createRestoreState({ storeDir: settings.storeDir }).read().doc);
        expect(text).not.toContain(PASSPHRASE);
        expect(text).not.toContain(TOKEN_MARK);
        expect(manager.journal.readAudit().entries.map(entry => entry.action)).toEqual(expect.arrayContaining(['manager.backup.create', 'manager.backup.restore']));
    }, 240000);
});
