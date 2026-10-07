/**
 * What the bootstrap artifacts run after unpacking (#333,
 * apps/manager/bootstrap): the headless path drives the manager's own
 * `install` CLI against a payload in a throwaway root (systemd is replaced by
 * the manual-fallback reply), the wizard path starts the manager, notices a
 * finished install and leaves a registered service alone, and the refusals:
 * a payload that is not the one the header names, answers that would install
 * something else, an answers file others can read.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Writable } = require('node:stream');

const bootstrap = require('@goobster/manager/bootstrap');
const { defaultRoots, rootsEnvironment } = require('@goobster/manager/bootstrap/roots');
const payloadStage = require('../scripts/lib/payloadStage');
const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const rootsEnvFile = require('@goobster/manager/platform/rootsEnv');
const { makeRelease, drive, freePort, tempDir } = require('./helpers/installFixture');

const DIGEST = 'b'.repeat(64);
const cleanup = [];
const scratch = (label) => tempDir(cleanup, label);
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function sink() {
    const chunks = [];
    const stream = new Writable({ write(chunk, _enc, done) { chunks.push(chunk.toString()); done(); } });
    stream.text = () => chunks.join('');
    return stream;
}

function payload() {
    const release = makeRelease(scratch('payload'));
    payloadStage.writeManifest(release.dir, { ...release.manifest, payloadDigest: DIGEST });
    return release.dir;
}

function runnerStub(replies = {}) {
    const calls = [];
    return {
        calls,
        isImplemented: () => true,
        async run(operation, input) {
            calls.push({ operation, input: JSON.parse(JSON.stringify(input)) });
            return replies[operation] || { status: 'fallback', reason: 'SYSTEMD_NOT_INIT' };
        }
    };
}

async function environment(base) {
    return {
        PATH: process.env.PATH,
        HOME: base,
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        PORT: String(await freePort()),
        GOOBSTER_API_PORT: String(await freePort())
    };
}

function writeAnswers(dir, doc, mode = 0o600) {
    const file = path.join(dir, 'answers.json');
    fs.writeFileSync(file, JSON.stringify(doc), { mode });
    fs.chmodSync(file, mode);
    return file;
}

const installDeps = (runner) => ({ privileged: runner, unitNames: () => [], readCrontab: () => null, writeCrontab: () => {}, discover: () => ({ candidates: [], searched: 0 }) });

describe('argument handling', () => {
    test('help and version need no payload digest, an unknown flag is a usage error, headless needs answers', async () => {
        const out = sink();
        expect(await bootstrap.run(['--help'], { stdout: out, stderr: sink() })).toBe(0);
        expect(out.text()).toContain('--headless');
        const err = sink();
        expect(await bootstrap.run(['--payload', payload(), '--frobnicate'], { stdout: sink(), stderr: err })).toBe(2);
        expect(err.text()).toContain('USAGE');
        expect(await bootstrap.run(['--payload', payload(), '--headless'], { stdout: sink(), stderr: sink() })).toBe(2);
        expect(await bootstrap.run([], { stdout: sink(), stderr: sink() })).toBe(2);
    });

    test('--version prints the payload release version', async () => {
        const out = sink();
        expect(await bootstrap.run(['--payload', payload(), '--version'], { stdout: out, stderr: sink() })).toBe(0);
        expect(out.text().trim()).toBe('2.4.0');
    });

    test('a payload that is not the one the header names is refused before anything else (exit 4)', async () => {
        const err = sink();
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', 'c'.repeat(64)], { stdout: sink(), stderr: err });
        expect(code).toBe(4);
        expect(err.text()).toContain('PAYLOAD_DIGEST_MISMATCH');
    });
});

describe('default roots', () => {
    test('root: /opt/goobster for code and /var/lib/goobster for state, config in its own directory', () => {
        expect(defaultRoots({ env: {}, euid: 0 })).toEqual({
            code: '/opt/goobster',
            data: '/var/lib/goobster/data',
            config: '/var/lib/goobster/config/config.json',
            cache: '/var/lib/goobster/cache',
            logs: '/var/lib/goobster/logs',
            managerStore: '/var/lib/goobster/data/manager'
        });
    });

    test('a person: under GOOBSTER_HOME, else XDG_DATA_HOME, else ~/.local/share; --base overrides both', () => {
        expect(defaultRoots({ env: { GOOBSTER_HOME: '/h/g' }, euid: 1000, home: '/home/x' }).code).toBe('/h/g/code');
        expect(defaultRoots({ env: { XDG_DATA_HOME: '/h/xdg' }, euid: 1000, home: '/home/x' }).data).toBe('/h/xdg/goobster/data');
        expect(defaultRoots({ env: {}, euid: 1000, home: '/home/x' }).config).toBe('/home/x/.local/share/goobster/config/config.json');
        expect(defaultRoots({ env: {}, euid: 0, base: '/srv/a b' }).managerStore).toBe('/srv/a b/data/manager');
    });

    test('the environment the manager reads agrees with the roots', () => {
        const roots = defaultRoots({ env: {}, euid: 1000, home: '/home/x' });
        expect(rootsEnvironment(roots)).toMatchObject({
            GOOBSTER_INSTALL_ROOT: roots.code,
            GOOBSTER_DATA_DIR: roots.data,
            GOOBSTER_CONFIG_PATH: roots.config,
            GOOBSTER_MANAGER_STATE_DIR: roots.managerStore
        });
    });
});

describe('the answers a headless run hands the CLI', () => {
    const roots = defaultRoots({ env: {}, euid: 1000, home: '/home/x' });
    const args = { build: 'dev', publicKey: null };

    test('complete the operator\'s document with the payload, the standalone layout, default roots and an unsigned-dev release', () => {
        const merged = bootstrap.buildInstallAnswers({ ownerLabel: 'me' }, { payload: '/p', args, roots, euid: 1000 });
        expect(merged).toMatchObject({ ownerLabel: 'me', source: '/p', layout: 'standalone', release: { allowUnsigned: true } });
        expect(merged.roots).toMatchObject({ code: roots.code, data: roots.data, managerStore: roots.managerStore });
        expect(merged.runtimeUser).toBeUndefined();
    });

    test('the operator\'s own roots and layout win key by key', () => {
        const merged = bootstrap.buildInstallAnswers({ layout: 'lite', roots: { data: '/elsewhere/data' } }, { payload: '/p', args, roots, euid: 1000 });
        expect(merged.layout).toBe('lite');
        expect(merged.roots).toMatchObject({ code: roots.code, data: '/elsewhere/data' });
    });

    test('a release build trusts only the embedded key; as root the service account is goobster and is created', () => {
        const merged = bootstrap.buildInstallAnswers({}, { payload: '/p', args: { build: 'release', publicKey: '/k/release-key.pem' }, roots, euid: 0 });
        expect(merged.release).toEqual({ publicKeyFiles: ['/k/release-key.pem'], allowUnsigned: false });
        expect(merged).toMatchObject({ runtimeUser: 'goobster', createRuntimeUser: true });
        const own = bootstrap.buildInstallAnswers({ runtimeUser: 'svc' }, { payload: '/p', args, roots, euid: 0 });
        expect(own.runtimeUser).toBe('svc');
        expect(own.createRuntimeUser).toBeUndefined();
    });

    test('an answers file that names another source is refused, not obeyed', () => {
        expect(() => bootstrap.buildInstallAnswers({ source: '/somewhere/else' }, { payload: '/p', args, roots, euid: 1000 })).toThrow(/installs its own payload/);
        expect(() => bootstrap.buildInstallAnswers([], { payload: '/p', args, roots, euid: 1000 })).toThrow(/one JSON object/);
    });
});

describe('--headless --answers', () => {
    async function headless({ answers = {}, mode = 0o600, runner = runnerStub(), extraArgs = [], euid = 1000 } = {}) {
        const base = scratch('headless');
        const dir = scratch('answers');
        const file = writeAnswers(dir, answers, mode);
        const out = sink();
        const err = sink();
        const dirPayload = payload();
        const code = await bootstrap.run(['--payload', dirPayload, '--payload-digest', DIGEST, '--build', 'dev', '--headless', '--answers', file, '--base', path.join(base, 'with space'), ...extraArgs], {
            env: await environment(base),
            stdout: out,
            stderr: err,
            euid,
            installDeps: installDeps(runner)
        });
        return { code, out: out.text(), err: err.text(), base: path.join(base, 'with space'), runner, dir, payload: dirPayload };
    }

    test('drives install.new end to end into roots with spaces; with no systemd the service step is skipped MANUAL_FALLBACK and the exact command is printed', async () => {
        const result = await headless();
        expect(result.code).toBe(0);
        expect(result.out).toContain('install.new: applied');
        expect(result.out).toMatch(/skipped\s+register-service \(MANUAL_FALLBACK\)/);
        const code = path.join(result.base, 'code');
        expect(result.out).toContain(`'${code}/current/bin/goobster-manager' --supervise`);
        expect(result.out).toContain('sudo systemctl enable --now goobster.service');
        expect(fs.existsSync(path.join(code, 'current', 'payload-manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(result.base, 'data', 'manager', 'installation.json'))).toBe(true);
        expect(fs.existsSync(path.join(result.base, 'data', 'manager', 'goobster.service'))).toBe(true);
        expect(fs.existsSync(path.join(result.base, 'data', 'goobster.sqlite'))).toBe(true);
        expect(fs.readdirSync(path.join(code, 'staging'))).toEqual([]);
        expect(result.out + result.err).toContain('UNSIGNED DEVELOPMENT BUILD');
        expect(rootsEnvFile.readRootsEnv(code).GOOBSTER_DATA_DIR).toBe(path.join(result.base, 'data'));
        expect(serviceRecord.readRecord(path.join(result.base, 'data', 'manager')).services).toEqual([]);
        expect(result.runner.calls.map(call => call.operation)).toEqual(['service.register']);
    });

    test('the merged answers live in a private temporary directory that is gone afterwards, and the run prints no secret it was given', async () => {
        const before = fs.readdirSync(require('node:os').tmpdir()).filter(name => name.startsWith('goobster-answers-'));
        const result = await headless({ answers: { config: [{ id: 'ai.provider', value: 'ollama' }] } });
        expect(result.code).toBe(0);
        const after = fs.readdirSync(require('node:os').tmpdir()).filter(name => name.startsWith('goobster-answers-'));
        expect(after.sort()).toEqual(before.sort());
    });

    test('an answers file other users can read is refused (exit 2) and nothing is installed', async () => {
        const result = await headless({ mode: 0o644 });
        expect(result.code).toBe(2);
        expect(result.err).toContain('ANSWERS_PERMISSIONS');
        expect(fs.existsSync(path.join(result.base, 'code', 'current'))).toBe(false);
    });

    test('answers that name another payload are refused (exit 2)', async () => {
        const result = await headless({ answers: { source: '/tmp/some-other-release' } });
        expect(result.code).toBe(2);
        expect(result.err).toContain('ANSWERS_SOURCE');
    });

    test('an answers file the schema rejects stops the install with exit 2', async () => {
        const result = await headless({ answers: { layout: 'sideways' } });
        expect(result.code).toBe(2);
        expect(result.err).toMatch(/ANSWERS_INVALID|INVALID/);
        expect(fs.existsSync(path.join(result.base, 'code', 'current'))).toBe(false);
    });

    test('--dry-run plans and writes nothing', async () => {
        const result = await headless({ extraArgs: ['--dry-run'] });
        expect(result.code).toBe(0);
        expect(result.out).toContain('install.new');
        expect(fs.existsSync(path.join(result.base, 'code', 'current'))).toBe(false);
        expect(result.runner.calls).toEqual([]);
    });

    test('running it again changes nothing and still succeeds (idempotent)', async () => {
        const first = await headless();
        expect(first.code).toBe(0);
        const dir = scratch('answers-again');
        const file = writeAnswers(dir, {});
        const out = sink();
        const code = await bootstrap.run(['--payload', first.payload, '--payload-digest', DIGEST, '--build', 'dev', '--headless', '--answers', file, '--base', first.base], {
            env: await environment(path.dirname(first.base)),
            stdout: out,
            stderr: sink(),
            euid: 1000,
            installDeps: installDeps(runnerStub())
        });
        expect(code).toBe(0);
        expect(out.text()).toMatch(/nothing to change|applied/);
    });

    test('as root the answers ask for the goobster account, and once the install is recorded the roots are handed over to it again', async () => {
        const base = scratch('as-root');
        const file = writeAnswers(scratch('as-root-answers'), {});
        const real = require('@goobster/manager/cli');
        let seen = null;
        const cli = {
            loadAnswers: real.loadAnswers,
            run: async (argv) => {
                seen = JSON.parse(fs.readFileSync(argv[argv.indexOf('--answers') + 1], 'utf8'));
                return 0;
            }
        };
        const calls = [];
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--build', 'dev', '--headless', '--answers', file, '--base', base], {
            env: await environment(base),
            stdout: sink(),
            stderr: sink(),
            euid: 0,
            cli,
            createStore: () => ({ readInstallation: () => ({ status: 'ok', doc: { installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11' } }) }),
            privileged: { run: async (operation, input) => { calls.push({ operation, input }); return { status: 'done' }; } }
        });
        expect(code).toBe(0);
        expect(seen).toMatchObject({ runtimeUser: 'goobster', createRuntimeUser: true, layout: 'standalone' });
        expect(calls).toHaveLength(1);
        expect(calls[0].operation).toBe('user.create');
        expect(calls[0].input).toMatchObject({ name: 'goobster', system: true, mode: 'payload', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11' });
        expect(calls[0].input.roots).toMatchObject({ code: path.join(base, 'code'), data: path.join(base, 'data'), managerStore: path.join(base, 'data', 'manager') });
    });
});

describe('roots under directories that do not exist yet', () => {
    test('as root the missing parents are created searchable, so the service account can reach the roots', async () => {
        const base = scratch('as-root-nested');
        const file = writeAnswers(scratch('as-root-nested-answers'), { roots: { data: path.join(base, 'a b', 'deep', 'data'), managerStore: path.join(base, 'a b', 'deep', 'data', 'manager') } });
        const real = require('@goobster/manager/cli');
        const cli = { loadAnswers: real.loadAnswers, run: async () => 1 };
        process.umask(0o077);
        try {
            await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--build', 'dev', '--headless', '--answers', file, '--base', base], {
                env: await environment(base), stdout: sink(), stderr: sink(), euid: 0, cli
            });
        } finally {
            process.umask(0o022);
        }
        for (const dir of [path.join(base, 'a b'), path.join(base, 'a b', 'deep')]) {
            expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
        }
    });
});

describe('the wizard', () => {
    function get(port, urlPath) {
        return new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: urlPath }, (response) => {
                let body = '';
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve({ status: response.statusCode, body }));
            }).on('error', reject);
        });
    }

    async function startWizard({ runner = runnerStub(), pollMs = 30 } = {}) {
        const base = scratch('wizard');
        const out = sink();
        const err = sink();
        const controller = new AbortController();
        let ready;
        const readyPromise = new Promise((resolve) => { ready = resolve; });
        const dir = payload();
        const done = bootstrap.run(['--payload', dir, '--payload-digest', DIGEST, '--build', 'dev', '--base', path.join(base, 'w s')], {
            env: await environment(base),
            stdout: out,
            stderr: err,
            euid: 1000,
            signal: controller.signal,
            pollMs,
            onReady: ready,
            installDeps: installDeps(runner)
        });
        const info = await readyPromise;
        return { base: path.join(base, 'w s'), out, err, controller, done, info, runner, dir };
    }

    test('serves the manager on loopback, prints the address and the SSH tunnel line, and Ctrl-C leaves without touching any service', async () => {
        const runner = runnerStub();
        const wizard = await startWizard({ runner });
        const { port, url } = wizard.info;
        expect(url).toBe(`http://127.0.0.1:${port}/manager/`);
        expect(wizard.out.text()).toContain(url);
        expect(wizard.out.text()).toMatch(new RegExp(`ssh -L ${port}:127\\.0\\.0\\.1:${port} \\S+@\\S+`));
        const status = await get(port, '/manager/api/status');
        expect(status.status).toBe(200);
        expect(JSON.parse(status.body)).toMatchObject({ service: 'goobster-manager', state: 'unclaimed' });
        expect(wizard.info.manager).toBeDefined();

        wizard.controller.abort();
        expect(await wizard.done).toBe(0);
        expect(wizard.out.text()).toContain('untouched');
        expect(runner.calls).toEqual([]);
        await expect(get(port, '/manager/api/status')).rejects.toBeTruthy();
    });

    test('notices a finished install, stops its own manager so the service can take the address, and prints the manual command when no service was registered', async () => {
        const runner = runnerStub();
        const wizard = await startWizard({ runner });
        const harness = { manager: wizard.info.manager };
        await drive(harness, 'install.new', { source: wizard.dir, release: { allowUnsigned: true }, layout: 'standalone', roots: undefined });
        expect(await wizard.done).toBe(0);
        const text = wizard.out.text();
        expect(text).toContain('The install finished (applied)');
        expect(text).toContain('no service was registered');
        expect(text).toContain('goobster-manager');
        expect(text).toContain('--supervise');
        await expect(get(wizard.info.port, '/manager/api/status')).rejects.toBeTruthy();
        expect(runner.calls.map(call => call.operation)).toEqual(['service.register']);
    });

    test('with a registered service the finish message names it and nothing is stopped or unregistered', async () => {
        const runner = runnerStub({ 'service.register': { status: 'done', outcome: 'applied', detail: { active: 'active' }, log: [] } });
        const wizard = await startWizard({ runner });
        await drive({ manager: wizard.info.manager }, 'install.new', { source: wizard.dir, release: { allowUnsigned: true }, layout: 'standalone' });
        expect(await wizard.done).toBe(0);
        expect(wizard.out.text()).toContain('The service "goobster" is registered');
        expect(runner.calls.map(call => call.operation)).toEqual(['service.register']);
    });

    test('refuses to start over an existing installation (exit 3) and says how to repair it', async () => {
        const base = scratch('wizard-existing');
        const root = path.join(base, 'w s');
        const dir = payload();
        const env = await environment(base);
        const roots = defaultRoots({ env, euid: 1000, base: root });
        const err = sink();
        const settingsEnv = { ...env, ...rootsEnvironment(roots) };
        const { createManager } = require('@goobster/manager/manager');
        const { resolveSettings } = require('@goobster/manager/settings');
        const settings = resolveSettings({ ...settingsEnv, GOOBSTER_WORKSPACE_ROOT: path.join(dir, 'app') });
        settings.installDeps = installDeps(runnerStub());
        const manager = createManager({ settings, logger: { info() {}, warn() {}, error() {} }, extraKinds: require('@goobster/manager/extensions').kinds });
        await manager.init({ mintBootstrap: false });
        await drive({ manager }, 'install.new', { source: dir, release: { allowUnsigned: true }, layout: 'standalone' });

        const code = await bootstrap.run(['--payload', dir, '--payload-digest', DIGEST, '--build', 'dev', '--base', root], { env, stdout: sink(), stderr: err, euid: 1000, installDeps: installDeps(runnerStub()) });
        expect(code).toBe(3);
        expect(err.text()).toContain('ALREADY_INSTALLED');
        expect(err.text()).toContain(`${roots.code}/current/bin/goobster-manager`);
    });
});
