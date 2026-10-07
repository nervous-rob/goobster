/**
 * The headless CLI (#329, documentation/manager_install.md): answers-file
 * mode (mode 0600 enforced, schema errors without echoing values), prompt
 * mode over scripted stdin (secrets read without echo), the exit codes,
 * secrets refused on argv, and redacted output. The CLI runs the same kinds
 * through the same engine as the engine spec; this spec checks the front.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const crypto = require('node:crypto');

const { makeRelease, freePort, snapshot, tempDir } = require('./helpers/installFixture');
const cli = require('@goobster/manager/cli');
const { discover } = require('@goobster/manager/install/discover');
const { createStore } = require('@goobster/manager/store/installation');

const cleanup = [];
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const PLANTED = `sk-planted-${crypto.randomBytes(10).toString('hex')}`;

async function environment(label = 'cli') {
    const root = tempDir(cleanup, label);
    const release = makeRelease(tempDir(cleanup, `${label}-src`));
    const code = path.join(root, 'app');
    fs.mkdirSync(code, { recursive: true });
    return {
        root,
        code,
        release,
        env: {
            PATH: process.env.PATH,
            HOME: root,
            GOOBSTER_WORKSPACE_ROOT: code,
            GOOBSTER_MANAGER_PORT: '0',
            GOOBSTER_MANAGER_RECONCILE: '0',
            PORT: String(await freePort()),
            GOOBSTER_API_PORT: String(await freePort())
        }
    };
}

function writeAnswers(dir, doc, mode = 0o600, name = 'answers.json') {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(doc), { mode });
    fs.chmodSync(file, mode);
    return file;
}

/** Run the CLI in-process; stdin lines are scripted. */
async function runCli(argv, { env, lines = [], installDeps = {} } = {}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = [];
    const err = [];
    stdout.on('data', chunk => out.push(chunk));
    stderr.on('data', chunk => err.push(chunk));
    const stdin = Readable.from(lines.map(line => `${line}\n`));
    const exitCode = await cli.run(argv, {
        env,
        stdin,
        stdout,
        stderr,
        installDeps: { home: env && env.HOME, readCrontab: () => null, writeCrontab: () => {}, exec: () => null, ...installDeps }
    });
    return { exitCode, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}

const json = (result) => JSON.parse(result.stdout);

describe('arguments', () => {
    test('help and the schema print and exit 0; an unknown command or option exits 2', async () => {
        const { env } = await environment();
        const help = await runCli(['help'], { env });
        expect(help.exitCode).toBe(0);
        expect(help.stdout).toContain('Exit codes');
        const schema = await runCli(['schema'], { env });
        expect(schema.exitCode).toBe(0);
        expect(JSON.parse(schema.stdout).definitions.install.required).toEqual(['source']);
        expect((await runCli(['frobnicate'], { env })).exitCode).toBe(2);
        expect((await runCli(['install', '--no-such-flag'], { env })).exitCode).toBe(2);
        expect((await runCli(['install', 'extra'], { env })).exitCode).toBe(2);
        expect((await runCli(['install', '--confirm', 'x'], { env })).exitCode).toBe(2);
        expect((await runCli(['repair', '--delete-data'], { env })).exitCode).toBe(2);
    });

    test.each([
        ['--token', 'abc'],
        ['--api-key=sk-live-secret-value'],
        ['--openai-key', 'sk-live-secret-value'],
        ['--password=hunter2hunter2'],
        ['--secret', 'x'],
        ['--passphrase', 'x']
    ])('a secret-like option (%s) is refused on argv with a pointer to the answers file, and the value is never echoed', async (...argv) => {
        const { env } = await environment();
        const result = await runCli(['install', ...argv], { env });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('answers file');
        expect(result.stdout + result.stderr).not.toMatch(/sk-live-secret-value|hunter2hunter2/);
    });
});

describe('answers-file mode', () => {
    test('a file other users can read is refused (0600 enforced), a link or a missing file too', async () => {
        const { env, root, release } = await environment();
        const loose = writeAnswers(root, { source: release.dir }, 0o644);
        const refused = await runCli(['install', '--answers', loose, '--dry-run'], { env });
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr).toContain('ANSWERS_PERMISSIONS');

        const tight = writeAnswers(root, { source: release.dir, release: { allowUnsigned: true } }, 0o600, 'tight.json');
        const link = path.join(root, 'link.json');
        fs.symlinkSync(tight, link);
        expect((await runCli(['install', '--answers', link, '--dry-run'], { env })).exitCode).toBe(2);
        expect((await runCli(['install', '--answers', path.join(root, 'nope.json'), '--dry-run'], { env })).exitCode).toBe(2);
        const broken = path.join(root, 'broken.json');
        fs.writeFileSync(broken, '{ not json', { mode: 0o600 });
        const parsed = await runCli(['install', '--answers', broken, '--dry-run'], { env });
        expect(parsed.exitCode).toBe(2);
        expect(parsed.stderr).toContain('ANSWERS_INVALID');
    });

    test('schema errors exit 2, name the pointer and rule, and never echo a value', async () => {
        const { env, root, release } = await environment();
        const file = writeAnswers(root, {
            source: release.dir,
            layout: 'sideways',
            surprise: PLANTED,
            config: [{ id: 'ai.openai.apiKey', value: PLANTED, extra: PLANTED }]
        });
        const result = await runCli(['install', '--answers', file, '--dry-run'], { env });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('/layout (enum)');
        expect(result.stderr).toContain('/surprise (additionalProperties)');
        expect(result.stderr).toContain('/config/0/extra (additionalProperties)');
        expect(result.stdout + result.stderr).not.toContain(PLANTED);

        const wrongCommand = writeAnswers(root, { command: 'repair' }, 0o600, 'wrong.json');
        expect((await runCli(['install', '--answers', wrongCommand, '--dry-run'], { env })).exitCode).toBe(2);
        expect((await runCli(['install', '--answers', writeAnswers(root, {}, 0o600, 'empty.json'), '--dry-run'], { env })).exitCode).toBe(2);
    });

    test('--dry-run plans and runs preflight, lists the target, services, retained data and privileged steps, and writes nothing', async () => {
        const { env, root, release } = await environment();
        const file = writeAnswers(root, { source: release.dir, features: ['tavern'], release: { allowUnsigned: true } });
        const before = snapshot(root);
        const result = await runCli(['install', '--answers', file, '--dry-run', '--json'], { env });
        expect(result.exitCode).toBe(0);
        const doc = json(result);
        expect(doc).toMatchObject({ ok: true, dryRun: true, command: 'install' });
        expect(doc.plan).toMatchObject({
            action: 'install-new',
            downloads: [],
            services: [{ action: 'register', privileged: 'service.register' }],
            privilegedSteps: [{ operation: 'service.register', status: 'deferred' }]
        });
        expect(snapshot(root)).toBe(before);

        const text = await runCli(['plan', 'install', '--answers', file], { env });
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain('dry run: nothing is written');
        expect(text.stdout).toContain('privileged');
        expect(snapshot(root)).toBe(before);
    });

    test('a dry run that preflight blocks exits 2 and lists the finding', async () => {
        const { env, root, release } = await environment();
        const net = require('node:net');
        const holder = net.createServer();
        await new Promise(resolve => holder.listen(Number(env.PORT), '127.0.0.1', resolve));
        try {
            const file = writeAnswers(root, { source: release.dir, release: { allowUnsigned: true } });
            const result = await runCli(['install', '--answers', file, '--dry-run'], { env });
            expect(result.exitCode).toBe(2);
            expect(result.stdout).toContain('PORT_IN_USE');
        } finally {
            holder.close();
        }
    });

    test('install applies: exit 5 while service registration is deferred (nothing registered), 0 when it is not asked for', async () => {
        const { env, root, code, release } = await environment();
        const file = writeAnswers(root, { source: release.dir, features: ['tavern'], release: { allowUnsigned: true } });
        const result = await runCli(['install', '--answers', file, '--json'], { env });
        expect(result.exitCode).toBe(5);
        const doc = json(result);
        expect(doc).toMatchObject({ ok: true, deferred: ['register-service'], operation: { kind: 'install.new', status: 'applied' } });
        expect(doc.steps.map(step => step.name)).toEqual(expect.arrayContaining(['stage', 'init-db', 'activate']));
        expect(fs.existsSync(path.join(code, 'current', 'payload-manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(code, 'data', 'goobster.sqlite'))).toBe(true);

        const again = await runCli(['install', '--answers', file, '--json'], { env });
        expect(json(again).operation.status).toBe('applied');
        expect(json(again).steps.find(step => step.name === 'stage').status).toBe('skipped');

        const second = await environment('cli-quiet');
        const quiet = writeAnswers(second.root, { source: second.release.dir, registerService: false, release: { allowUnsigned: true } });
        expect((await runCli(['install', '--answers', quiet], { env: second.env })).exitCode).toBe(0);
    });

    test('secrets in the answers file are written to config.json and appear in no output, journal or audit record', async () => {
        const { env, root, code, release } = await environment();
        const file = writeAnswers(root, {
            source: release.dir,
            registerService: false,
            release: { allowUnsigned: true },
            config: [{ id: 'ai.openai.apiKey', value: PLANTED }, { id: 'ai.provider', value: 'openai' }]
        });
        const result = await runCli(['install', '--answers', file], { env });
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(PLANTED);
        expect(fs.readFileSync(path.join(code, 'config.json'), 'utf8')).toContain(PLANTED);
        const store = path.join(code, 'data', 'manager');
        for (const entry of fs.readdirSync(path.join(store, 'operations'))) {
            expect(fs.readFileSync(path.join(store, 'operations', entry), 'utf8')).not.toContain(PLANTED);
        }
        const asJson = await runCli(['status', '--json'], { env });
        expect(asJson.stdout).not.toContain(PLANTED);

        const failing = writeAnswers(root, { source: path.join(root, 'missing-source'), config: [{ id: 'ai.openai.apiKey', value: PLANTED }] }, 0o600, 'failing.json');
        const failed = await runCli(['install', '--answers', failing, '--json'], { env });
        expect(failed.exitCode).not.toBe(0);
        expect(failed.stdout + failed.stderr).not.toContain(PLANTED);
    });
});

describe('prompt mode', () => {
    test('scripted stdin answers the questions; a secret is read without echo and lands in config.json only', async () => {
        const { env, code, release } = await environment();
        const lines = [release.dir, 'Prompt Owner', 'lite', 'tavern', 'y', 'ai.openai.apiKey', PLANTED, '', 'y'];
        const result = await runCli(['install'], { env, lines });
        expect(result.exitCode).toBe(5);
        expect(result.stderr).toContain('Release source');
        expect(result.stderr).toContain('Proceed?');
        expect(result.stdout + result.stderr).not.toContain(PLANTED);
        expect(fs.readFileSync(path.join(code, 'config.json'), 'utf8')).toContain(PLANTED);
        const doc = createStore({ root: path.join(code, 'data', 'manager') }).readInstallation().doc;
        expect(doc).toMatchObject({ ownerLabel: 'Prompt Owner', layout: 'lite', release: { features: ['core', 'tavern'] } });
    });

    test('answering no to "Proceed?" changes nothing and exits 0; --yes skips the question', async () => {
        const { env, code, release } = await environment();
        const declined = await runCli(['install'], { env, lines: [release.dir, '', '', 'tavern', 'y', '', 'n'] });
        expect(declined.exitCode).toBe(0);
        expect(declined.stderr).toContain('Cancelled');
        expect(fs.existsSync(path.join(code, 'current'))).toBe(false);

        const accepted = await runCli(['install', '--yes', '--json'], { env, lines: [release.dir, '', '', 'tavern', 'y', ''] });
        expect(accepted.exitCode).toBe(5);
        expect(fs.existsSync(path.join(code, 'current', 'payload-manifest.json'))).toBe(true);
    });

    test('input that ends early exits 2 without writing', async () => {
        const { env, code, release } = await environment();
        const result = await runCli(['install'], { env, lines: [release.dir] });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('INPUT_ENDED');
        expect(fs.existsSync(path.join(code, 'current'))).toBe(false);
    });

    test('adopt lists what discovery found and adopts the one picked', async () => {
        const { env, code } = await environment();
        fs.mkdirSync(path.join(code, 'data'), { recursive: true });
        fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'goobster' }));
        const db = Buffer.alloc(4096);
        db.write('SQLite format 3\u0000', 0, 'latin1');
        fs.writeFileSync(path.join(code, 'data', 'goobster.sqlite'), db);
        const result = await runCli(['adopt', '--yes', '--json'], { env, lines: ['1', 'Existing Owner'] });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('manual');
        const doc = createStore({ root: path.join(code, 'data', 'manager') }).readInstallation().doc;
        expect(doc).toMatchObject({ origin: 'adopt', ownerLabel: 'Existing Owner', roots: { code } });
        const listed = await runCli(['discover'], { env });
        expect(listed.stdout).toContain('manual');
    });
});

describe('exit codes', () => {
    test('3 for a refusal (tampered ownership, wrong state), 4 for an interrupted run that the next run resumes', async () => {
        const { env, root, code, release } = await environment();
        const file = writeAnswers(root, { source: release.dir, registerService: false, release: { allowUnsigned: true } });
        const broken = await runCli(['install', '--answers', file, '--json'], {
            env,
            installDeps: { initDatabase: async () => { throw Object.assign(new Error('x'), { status: 500, code: 'DB_INIT_FAILED' }); } }
        });
        expect(broken.exitCode).toBe(4);
        expect(json(broken).error.code).toBe('STEP_FAILED');
        expect(broken.stderr).toContain('Run the same command again to resume');
        expect(fs.existsSync(path.join(code, 'current'))).toBe(false);

        const resumed = await runCli(['install', '--answers', file, '--json'], { env });
        expect(resumed.exitCode).toBe(0);
        expect(json(resumed).steps.find(step => step.name === 'ownership').status).toBe('skipped');
        expect(fs.existsSync(path.join(code, 'current', 'payload-manifest.json'))).toBe(true);

        const status = await runCli(['status', '--json'], { env });
        expect(json(status).status).toMatchObject({ state: 'claimed', ownership: 'ok' });

        const other = writeAnswers(root, { source: release.dir, layout: 'standalone', registerService: false, release: { allowUnsigned: true } }, 0o600, 'other.json');
        const conflict = await runCli(['install', '--answers', other], { env });
        expect(conflict.exitCode).toBe(3);
        expect(conflict.stderr).toContain('ALREADY_INSTALLED');

        const doc = JSON.parse(fs.readFileSync(path.join(code, 'data', 'manager', 'installation.json'), 'utf8'));
        doc.roots.cache = path.join(root, 'elsewhere');
        fs.writeFileSync(path.join(code, 'data', 'manager', 'installation.json'), JSON.stringify(doc));
        const tampered = await runCli(['repair'], { env, lines: ['', 'y'] });
        expect(tampered.exitCode).toBe(3);
        expect(tampered.stderr).toContain('OWNERSHIP_TAMPERED');
    });

    test('uninstall: data is kept by default; --delete-data needs --confirm <id>, --yes does not stand in for it, a wrong id exits 2', async () => {
        const { env, root, code, release } = await environment();
        const file = writeAnswers(root, { source: release.dir, registerService: false, release: { allowUnsigned: true } });
        expect((await runCli(['install', '--answers', file], { env })).exitCode).toBe(0);
        const id = JSON.parse(fs.readFileSync(path.join(code, 'data', 'manager', 'installation.json'), 'utf8')).installationId;
        fs.writeFileSync(path.join(code, 'data', 'keep.txt'), 'mine');

        const noConfirm = await runCli(['uninstall', '--delete-data', '--yes'], { env });
        expect(noConfirm.exitCode).toBe(2);
        expect(noConfirm.stderr).toContain('CONFIRMATION_REQUIRED');
        const wrong = await runCli(['uninstall', '--delete-data', '--confirm', 'wrong-id'], { env });
        expect(wrong.exitCode).toBe(2);
        expect(fs.existsSync(path.join(code, 'data', 'keep.txt'))).toBe(true);
        const answerOnly = writeAnswers(root, { keepData: false }, 0o600, 'delete.json');
        expect((await runCli(['uninstall', '--answers', answerOnly, '--yes'], { env })).exitCode).toBe(2);

        const preview = await runCli(['uninstall', '--delete-data', '--confirm', id, '--dry-run', '--json'], { env });
        expect(preview.exitCode).toBe(0);
        expect(json(preview).plan.removes.map(item => item.role)).toEqual(expect.arrayContaining(['code', 'data']));
        expect(fs.existsSync(path.join(code, 'data', 'keep.txt'))).toBe(true);

        const done = await runCli(['uninstall', '--delete-data', '--confirm', id], { env });
        expect(done.exitCode).toBe(0);
        expect(fs.existsSync(path.join(code, 'data', 'keep.txt'))).toBe(false);
        expect(fs.existsSync(path.join(code, 'data', 'tombstone.json'))).toBe(true);
        const status = await runCli(['status', '--json'], { env });
        expect(json(status).status).toMatchObject({ state: 'recovery', tombstone: true });
    });

    test('keep-data uninstall by default, then the same CLI installs over the kept data', async () => {
        const { env, root, code, release } = await environment();
        const file = writeAnswers(root, { source: release.dir, registerService: false, release: { allowUnsigned: true } });
        await runCli(['install', '--answers', file], { env });
        fs.writeFileSync(path.join(code, 'data', 'keep.txt'), 'mine');
        const removed = await runCli(['uninstall', '--yes'], { env, lines: [] });
        expect(removed.exitCode).toBe(0);
        expect(fs.existsSync(path.join(code, 'current'))).toBe(false);
        expect(fs.readFileSync(path.join(code, 'data', 'keep.txt'), 'utf8')).toBe('mine');
        const back = await runCli(['install', '--answers', file], { env });
        expect(back.exitCode).toBe(0);
        expect(fs.readFileSync(path.join(code, 'data', 'keep.txt'), 'utf8')).toBe('mine');
    });

    test('status and discover write nothing', async () => {
        const { env, root, code } = await environment();
        fs.mkdirSync(path.join(code, 'data'), { recursive: true });
        const before = snapshot(root);
        const status = await runCli(['status'], { env });
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain('unclaimed');
        expect((await runCli(['discover'], { env })).exitCode).toBe(0);
        expect(snapshot(root)).toBe(before);
        void discover;
    });
});
