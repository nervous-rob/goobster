/**
 * `goobster-manager migrate preflight|run|rollback|status` (#336,
 * documentation/db_migration.md): argument handling, the answers file and
 * the hidden prompt as the only places a connection URL or passphrase can
 * come from, exit codes, the rollback-limit sentence, progress per step and
 * per table on stderr, and "no secret in any output". The Postgres journey
 * (preflight, run, status, rollback) needs GOOBSTER_DB_URL and is skipped
 * without it; everything else runs on SQLite alone.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { Client } = require('pg');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-db-migration-cli-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const cli = require('@goobster/manager/cli');
const { newHarness, drive, tempDir } = require('./helpers/installFixture');
const { createSeededSqlite } = require('./helpers/migrationSeed');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { discover } = require('@goobster/manager/install/discover');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const environment = require('@goobster/manager/environment');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { ROLLBACK_LIMIT } = require('@goobster/core/db/migration');

const BASE_URL = process.env.GOOBSTER_DB_URL ? process.env.GOOBSTER_DB_URL.split('?')[0] : null;
const withPostgres = BASE_URL ? describe : describe.skip;
const PASSWORD = 'cli-pw-never-appears-5c19';
const PASSPHRASE = 'cli-passphrase-never-appears-b402';
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const UNREACHABLE = `postgres://goobster:${PASSWORD}@127.0.0.1:1/goobster`;
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

/** A claimed, adopted installation over a seeded SQLite file, with fake writers that acknowledge the maintenance fence. */
async function setup({ supervised = false } = {}) {
    const root = tempDir(roots, 'migcli');
    const harness = await newHarness({
        root,
        env: { GOOBSTER_RUNTIME_MODE: 'standalone' },
        installDeps: { discover: opts => discover({ ...opts, exec: () => null }) }
    });
    const { settings, code } = harness;
    fs.mkdirSync(path.join(code, 'scripts'), { recursive: true });
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'goobster' }));
    fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true } }));
    fs.writeFileSync(path.join(code, 'scripts', 'auto-update.sh'), '#!/bin/bash\n# goobster-manager-guard\nexit 0\n');
    createSeededSqlite(settings.sqlitePath, { dataDir: settings.dataDir });
    const found = discover({ fs, home: root, env: settings.env, exec: () => null });
    await drive(harness, 'adopt', { label: 'Rob', candidateId: found.candidates[0].id });

    if (supervised) {
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
    }
    const installationId = () => harness.manager.store.readInstallation().doc.installationId;
    return { ...harness, installationId, env: { ...harness.settings.processEnv } };
}

function writeAnswers(dir, doc, mode = 0o600, name = 'answers.json') {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(doc), { mode });
    fs.chmodSync(file, mode);
    return file;
}

async function runCli(argv, { env, lines = [], migrationDeps } = {}) {
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
        installDeps: { home: env && env.HOME, readCrontab: () => null, writeCrontab: () => {}, exec: () => null },
        ...(migrationDeps ? { migrationDeps } : {})
    });
    return { exitCode, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

const all = result => result.stdout + result.stderr;
const fakeValidate = { validate: async () => ({ workers: [{ name: 'api', healthy: true }], layout: 'standalone' }) };

describe('arguments', () => {
    test('help lists the migrate commands; a missing or unknown subcommand and the flags that do not apply exit 2', async () => {
        const { env } = await setup();
        const help = await runCli(['help'], { env });
        expect(help.exitCode).toBe(0);
        for (const word of ['migrate preflight', 'migrate run', 'migrate rollback', 'migrate status']) expect(help.stdout).toContain(word);
        for (const argv of [
            ['migrate'], ['migrate', 'sideways'], ['migrate', 'run', '--dry-run'], ['migrate', 'preflight', '--confirm', 'x'],
            ['migrate', 'status', '--release'], ['install', '--release'], ['migrate', 'status', '--answers', '/nope'], ['uninstall', '--delete-data', '--release']
        ]) {
            expect((await runCli(argv, { env })).exitCode).toBe(2);
        }
    });

    test('a secret-like option is refused on argv and never echoed', async () => {
        const { env } = await setup();
        for (const argv of [['migrate', 'run', '--passphrase', PASSPHRASE], ['migrate', 'preflight', `--password=${PASSWORD}`], ['migrate', 'run', '--token', PASSWORD]]) {
            const result = await runCli(argv, { env });
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('answers file');
            expect(all(result)).not.toContain(PASSWORD);
            expect(all(result)).not.toContain(PASSPHRASE);
        }
    });

    test('the answers schema carries the three migrate definitions', async () => {
        const { env } = await setup();
        const schema = JSON.parse((await runCli(['schema'], { env })).stdout);
        expect(Object.keys(schema.definitions)).toEqual(expect.arrayContaining(['migrate', 'migrate-preflight', 'migrate-rollback']));
        expect(schema.definitions.migrate.required).toEqual(['target', 'backup']);
    });
});

describe('the answers file is the only home of the URL and the passphrase', () => {
    test('a world-readable answers file is refused, and a schema error names the pointer without echoing the value', async () => {
        const { env, root } = await setup();
        const loose = writeAnswers(root, { target: { url: UNREACHABLE } }, 0o644);
        const refused = await runCli(['migrate', 'preflight', '--answers', loose], { env });
        expect(refused.exitCode).toBe(2);
        expect(all(refused)).toContain('ANSWERS_PERMISSIONS');
        expect(all(refused)).not.toContain(PASSWORD);

        const bad = writeAnswers(root, { target: { url: `mysql://u:${PASSWORD}@h/d` } }, 0o600, 'bad.json');
        const invalid = await runCli(['migrate', 'preflight', '--answers', bad], { env });
        expect(invalid.exitCode).toBe(2);
        expect(all(invalid)).toContain('/target/url');
        expect(all(invalid)).not.toContain(PASSWORD);

        const extra = writeAnswers(root, { target: { url: UNREACHABLE }, rows: 3 }, 0o600, 'extra.json');
        expect((await runCli(['migrate', 'preflight', '--answers', extra], { env })).exitCode).toBe(2);
    });

    test('the interactive prompt reads the URL hidden: it is not echoed anywhere', async () => {
        const { env } = await setup();
        const result = await runCli(['migrate', 'preflight'], { env, lines: [UNREACHABLE] });
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toContain('TARGET_UNREACHABLE');
        expect(all(result)).not.toContain(PASSWORD);
        expect(result.stderr).toContain('Postgres connection URL (hidden)');
    });
});

describe('without a Postgres target', () => {
    test('preflight against an unreachable target exits 2, prints the block and the rollback limit, writes nothing, and leaks nothing', async () => {
        const { env, root, settings } = await setup();
        const file = writeAnswers(root, { target: { url: UNREACHABLE } });
        const sqliteBefore = crypto.createHash('sha256').update(fs.readFileSync(settings.sqlitePath)).digest('hex');
        const text = await runCli(['migrate', 'preflight', '--answers', file], { env });
        expect(text.exitCode).toBe(2);
        expect(text.stdout).toContain('BLOCKED');
        expect(text.stdout).toContain('TARGET_UNREACHABLE');
        expect(text.stdout).toContain(ROLLBACK_LIMIT);
        expect(all(text)).not.toContain(PASSWORD);

        const asJson = await runCli(['migrate', 'preflight', '--answers', file, '--json'], { env });
        expect(asJson.exitCode).toBe(2);
        const doc = JSON.parse(asJson.stdout);
        expect(doc).toMatchObject({ ok: false, exitCode: 2, command: 'migrate', preflight: { ready: false, rollbackLimit: ROLLBACK_LIMIT } });
        expect(doc.preflight.blocks.map(item => item.code)).toContain('TARGET_UNREACHABLE');
        expect(all(asJson)).not.toContain(PASSWORD);
        expect(crypto.createHash('sha256').update(fs.readFileSync(settings.sqlitePath)).digest('hex')).toBe(sqliteBefore);
        expect(environment.read(settings.storeDir).present).toBe(false);
    }, 60000);

    test('run needs the installation id: without --confirm nothing is planned; a wrong one is refused after planning with exit 2', async () => {
        const { env, root, installationId, settings } = await setup();
        const file = writeAnswers(root, { target: { url: UNREACHABLE }, backup: { dir: path.join(root, 'backups'), passphrase: PASSPHRASE } });
        const none = await runCli(['migrate', 'run', '--answers', file, '--yes'], { env });
        expect(none.exitCode).toBe(2);
        expect(all(none)).toContain('CONFIRMATION_REQUIRED');
        expect(all(none)).not.toContain(PASSWORD);
        expect(all(none)).not.toContain(PASSPHRASE);

        const wrong = await runCli(['migrate', 'run', '--answers', file, '--confirm', 'not-the-id', '--yes'], { env });
        expect(wrong.exitCode).toBe(2);
        expect(all(wrong)).toContain('CONFIRMATION_REQUIRED');
        expect(wrong.stderr).toContain(ROLLBACK_LIMIT);
        expect(installationId()).toEqual(expect.any(String));
        expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
        expect(fs.existsSync(path.join(settings.storeDir, 'migration.json'))).toBe(false);
    }, 60000);

    test('run against an unreachable target stops at the preflight (exit 2) with the finding code, before any barrier or backup', async () => {
        const { env, root, installationId, settings } = await setup();
        const file = writeAnswers(root, { target: { url: UNREACHABLE }, backup: { dir: path.join(root, 'backups'), passphrase: PASSPHRASE } });
        const result = await runCli(['migrate', 'run', '--answers', file, '--confirm', installationId(), '--yes'], { env });
        expect(result.exitCode).toBe(2);
        expect(all(result)).toContain('PREFLIGHT_FAILED');
        expect(all(result)).toContain('TARGET_UNREACHABLE');
        expect(all(result)).not.toContain(PASSWORD);
        expect(all(result)).not.toContain(PASSPHRASE);
        expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
        expect(environment.read(settings.storeDir).present).toBe(false);
    }, 60000);

    test('status before any migration says so, prints the rollback limit and is read only; rollback has nothing to undo (exit 3)', async () => {
        const { env, root, installationId } = await setup();
        const status = await runCli(['migrate', 'status'], { env });
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain('migration   none');
        expect(status.stdout).toContain(ROLLBACK_LIMIT);
        const asJson = JSON.parse((await runCli(['migrate', 'status', '--json'], { env })).stdout);
        expect(asJson).toMatchObject({ ok: true, migration: { state: 'none', rollback: { possible: false }, rollbackLimit: ROLLBACK_LIMIT } });

        const file = writeAnswers(root, {});
        const rollback = await runCli(['migrate', 'rollback', '--answers', file, '--confirm', installationId(), '--yes'], { env });
        expect(rollback.exitCode).toBe(3);
        expect(all(rollback)).toContain('NOTHING_TO_ROLL_BACK');
    }, 60000);
});

withPostgres('against a throwaway Postgres schema', () => {
    async function targetSchema() {
        const name = `mig336cli_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        const admin = new Client({ connectionString: BASE_URL });
        await admin.connect();
        await admin.query(`CREATE SCHEMA ${name}`);
        const url = `${BASE_URL}?options=${encodeURIComponent(`-c search_path=${name},public`)}`;
        cleanups.push(async () => {
            try { await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); } finally { await admin.end().catch(() => { }); }
        });
        const tables = async () => (await admin.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [name])).rows.length;
        return { name, url, tables };
    }

    test('preflight ready (exit 0), run with progress (exit 0), status, then rollback restores SQLite and drops the schema contents', async () => {
        const target = await targetSchema();
        const harness = await setup({ supervised: true });
        const { env, root, settings } = harness;
        const answers = writeAnswers(root, {
            target: { url: target.url },
            backup: { dir: path.join(root, 'backups'), passphrase: PASSPHRASE },
            provision: { extensions: true },
            release: false
        });
        const noLeak = (result) => {
            for (const secret of [PASSPHRASE, target.url]) expect(all(result)).not.toContain(secret);
        };

        const preflight = await runCli(['migrate', 'preflight', '--answers', writeAnswers(root, { target: { url: target.url } }, 0o600, 'pre.json')], { env });
        expect(preflight.exitCode).toBe(0);
        expect(preflight.stdout).toContain('READY');
        expect(preflight.stdout).toContain(ROLLBACK_LIMIT);
        expect(await target.tables()).toBe(0);
        noLeak(preflight);

        const run = await runCli(['migrate', 'run', '--answers', answers, '--confirm', harness.installationId(), '--yes'], { env, migrationDeps: fakeValidate });
        expect(run.exitCode).toBe(0);
        for (const step of ['preflight', 'backup', 'snapshot', 'provision', 'copy', 'verify', 'validate', 'cutover']) expect(run.stderr).toContain(`[db.migrate] ${step} ...`);
        expect(run.stderr).toMatch(/copy \w+ started \(\d+ rows\)/);
        expect(run.stderr).toMatch(/copy \w+ done \(\d+ rows\)/);
        expect(run.stdout).toContain('db.migrate: applied');
        expect(run.stdout).toContain(ROLLBACK_LIMIT);
        expect(run.stdout).toContain('still held');
        noLeak(run);
        expect(await target.tables()).toBeGreaterThan(100);
        expect(environment.read(settings.storeDir).values.GOOBSTER_DB_URL).toBe(target.url);

        const status = await runCli(['migrate', 'status'], { env });
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain('migration   switched');
        expect(status.stdout).toContain('rollback    possible');
        noLeak(status);
        const statusJson = JSON.parse((await runCli(['migrate', 'status', '--json'], { env })).stdout);
        expect(statusJson.migration).toMatchObject({ state: 'switched', rollback: { possible: true }, rollbackLimit: ROLLBACK_LIMIT });

        const again = await runCli(['migrate', 'run', '--answers', answers, '--confirm', harness.installationId(), '--yes'], { env, migrationDeps: fakeValidate });
        expect(again.exitCode).toBe(3);
        expect(all(again)).toContain('ALREADY_');

        const undo = writeAnswers(root, { target: { url: target.url } }, 0o600, 'undo.json');
        const needsTarget = await runCli(['migrate', 'rollback', '--answers', writeAnswers(root, {}, 0o600, 'empty.json'), '--confirm', harness.installationId(), '--yes'], { env, migrationDeps: fakeValidate });
        expect(needsTarget.exitCode).toBe(2);
        const rolled = await runCli(['migrate', 'rollback', '--answers', undo, '--confirm', harness.installationId(), '--release', '--yes'], { env, migrationDeps: fakeValidate });
        expect(rolled.exitCode).toBe(0);
        expect(rolled.stdout).toContain('The installation is back on SQLite.');
        expect(rolled.stdout).toContain(ROLLBACK_LIMIT);
        noLeak(rolled);
        expect(await target.tables()).toBe(0);
        expect(environment.read(settings.storeDir).values.GOOBSTER_DB_URL).toBeUndefined();
        const after = JSON.parse((await runCli(['migrate', 'status', '--json'], { env })).stdout);
        expect(after.migration.state).toBe('rolled-back');
    }, 240000);
});
