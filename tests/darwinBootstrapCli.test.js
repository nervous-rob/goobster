/**
 * What the macOS installers run after unpacking (#332,
 * apps/manager/bootstrap/darwin.js, documentation/macos_install.md): the
 * argument handling and refusals (wizard as root, a payload that is not the
 * one the header names, a busy wizard port), the macOS default roots, the
 * machine account the headless root install asks for, `open` instead of
 * `xdg-open`, and the headless and wizard journeys with the macOS platform
 * injected into the install engine and a recording stand-in for the
 * privileged helper.
 *
 * This suite runs on Linux. What it cannot run: launchd, `dscl`, the
 * administrator prompt, `open`, and a real pkg `postinstall`. The macOS
 * workflow (.github/workflows/macos-bootstrap.yml) proves those.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Writable } = require('node:stream');

const bootstrap = require('@goobster/manager/bootstrap/darwin');
const linuxBootstrap = require('@goobster/manager/bootstrap');
const { defaultRoots } = require('@goobster/manager/bootstrap/roots');
const payloadStage = require('../scripts/lib/payloadStage');
const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const plist = require('@goobster/manager/platform/launchdPlist');
const { makeRelease, freePort, tempDir } = require('./helpers/installFixture');

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
            return replies[operation] || { status: 'done', outcome: 'applied', detail: { active: 'running' }, log: [] };
        }
    };
}

async function environment(base, extra = {}) {
    return {
        PATH: process.env.PATH,
        HOME: base,
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        PORT: String(await freePort()),
        GOOBSTER_API_PORT: String(await freePort()),
        ...extra
    };
}

function writeAnswers(dir, doc, mode = 0o600) {
    const file = path.join(dir, 'answers.json');
    fs.writeFileSync(file, JSON.stringify(doc), { mode });
    fs.chmodSync(file, mode);
    return file;
}

const macDeps = (runner) => ({ privileged: runner, platform: 'darwin', unitNames: () => [], discover: () => ({ candidates: [], searched: 0 }) });

/** A fake install CLI that keeps what it was handed instead of installing. */
function capturingCli() {
    const real = require('@goobster/manager/cli');
    const seen = { answers: null, argv: null, env: null };
    return {
        seen,
        loadAnswers: real.loadAnswers,
        run: async (argv, io) => {
            seen.argv = argv;
            seen.env = io.env;
            seen.answers = JSON.parse(fs.readFileSync(argv[argv.indexOf('--answers') + 1], 'utf8'));
            return 0;
        }
    };
}

describe('argument handling', () => {
    test('--help prints the macOS usage, needs no payload and names the machine account', async () => {
        const out = sink();
        expect(await bootstrap.run(['--help'], { stdout: out, stderr: sink() })).toBe(0);
        expect(out.text()).toContain('--per-user');
        expect(out.text()).toContain('_goobster');
        expect(out.text()).toContain('--open-browser');
        expect(bootstrap.HELP).toContain('127.0.0.1:3400');
    });

    test('the macOS flags are taken out before the shared entry sees the rest', () => {
        expect(bootstrap.ownArguments(['--payload', '/p', '--per-user', '--open-browser', '--headless'])).toEqual({ perUser: true, openBrowser: true, help: false, rest: ['--payload', '/p', '--headless'] });
        expect(bootstrap.ownArguments(['-h']).help).toBe(true);
    });

    test('--version prints the payload version; an unknown flag, a missing payload and headless without answers are usage errors (exit 2)', async () => {
        const out = sink();
        expect(await bootstrap.run(['--payload', payload(), '--version'], { stdout: out, stderr: sink(), euid: 501 })).toBe(0);
        expect(out.text().trim()).toBe('2.4.0');
        const err = sink();
        expect(await bootstrap.run(['--payload', payload(), '--frobnicate'], { stdout: sink(), stderr: err, euid: 501, env: { HOME: '/Users/a' } })).toBe(2);
        expect(err.text()).toContain('USAGE');
        expect(await bootstrap.run([], { stdout: sink(), stderr: sink(), euid: 501, env: { HOME: '/Users/a' }, probePort: async () => 'free' })).toBe(2);
        expect(await bootstrap.run(['--payload', payload(), '--headless'], { stdout: sink(), stderr: sink(), euid: 501, env: { HOME: '/Users/a' } })).toBe(2);
    });

    test('a payload that is not the one the header names is refused first, exit 4, even as root or with the port busy', async () => {
        for (const euid of [501, 0]) {
            const err = sink();
            const code = await bootstrap.run(['--payload', payload(), '--payload-digest', 'c'.repeat(64)], { stdout: sink(), stderr: err, euid, probePort: async () => 'busy', env: { HOME: '/Users/a' } });
            expect(code).toBe(4);
            expect(err.text()).toContain('PAYLOAD_DIGEST_MISMATCH');
        }
    });

    test('the wizard is never run as root (exit 3), and --per-user is not a root option (exit 2)', async () => {
        const err = sink();
        expect(await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST], { stdout: sink(), stderr: err, euid: 0, env: { HOME: '/var/root' } })).toBe(3);
        expect(err.text()).toContain('WIZARD_AS_ROOT');
        const second = sink();
        expect(await bootstrap.run(['--payload', payload(), '--per-user', '--headless', '--answers', '/x'], { stdout: sink(), stderr: second, euid: 0 })).toBe(2);
        expect(second.text()).toContain('--per-user');
    });

    test('a busy wizard port is reported (exit 3) before anything is started, and port 0 skips the check', async () => {
        const err = sink();
        const probe = jest.fn(async () => 'busy');
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST], { stdout: sink(), stderr: err, euid: 501, env: { HOME: '/Users/a' }, probePort: probe });
        expect(code).toBe(3);
        expect(err.text()).toContain('PORT_BUSY');
        expect(probe).toHaveBeenCalledWith(3400);
        const probeZero = jest.fn(async () => 'busy');
        const base = scratch('port-zero');
        const seenPort = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--headless', '--answers', writeAnswers(scratch('pz'), {})], { stdout: sink(), stderr: sink(), euid: 501, env: await environment(base), probePort: probeZero, cli: capturingCli() });
        expect(seenPort).toBe(0);
        expect(probeZero).not.toHaveBeenCalled();
    });
});

describe('default roots', () => {
    test('the machine (root) is /opt/goobster for everything; a person is under ~/Library/Application Support/Goobster, spaces and all', () => {
        expect(defaultRoots({ env: {}, euid: 0, platform: 'darwin' })).toEqual({
            code: '/opt/goobster/code',
            data: '/opt/goobster/data',
            config: '/opt/goobster/config/config.json',
            cache: '/opt/goobster/cache',
            logs: '/opt/goobster/logs',
            managerStore: '/opt/goobster/data/manager'
        });
        const person = defaultRoots({ env: {}, euid: 501, home: '/Users/Zoë Q', platform: 'darwin' });
        expect(person.code).toBe('/Users/Zoë Q/Library/Application Support/Goobster/code');
        expect(person.managerStore).toBe('/Users/Zoë Q/Library/Application Support/Goobster/data/manager');
    });

    async function rootsHandedToTheCli({ euid, extra = [], home }) {
        const base = scratch('roots');
        const cli = capturingCli();
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--headless', '--answers', writeAnswers(scratch('roots-a'), {}), '--dry-run', ...extra], {
            env: await environment(base), home, euid, cli, stdout: sink(), stderr: sink()
        });
        expect(code).toBe(0);
        return cli.seen;
    }

    test('as root the headless install uses the machine roots', async () => {
        const seen = await rootsHandedToTheCli({ euid: 0, home: '/var/root' });
        expect(seen.answers.roots).toEqual({ code: '/opt/goobster/code', data: '/opt/goobster/data', config: '/opt/goobster/config/config.json', cache: '/opt/goobster/cache', logs: '/opt/goobster/logs', managerStore: '/opt/goobster/data/manager' });
        expect(seen.env.GOOBSTER_INSTALL_ROOT).toBe('/opt/goobster/code');
        expect(seen.env.GOOBSTER_MANAGER_STATE_DIR).toBe('/opt/goobster/data/manager');
    });

    test('as a person the roots are in their Library; --per-user says the same thing; --base wins', async () => {
        const home = '/Users/Zoë Q';
        const plain = await rootsHandedToTheCli({ euid: 501, home });
        expect(plain.answers.roots.code).toBe(`${home}/Library/Application Support/Goobster/code`);
        expect(plain.answers.roots.config).toBe(`${home}/Library/Application Support/Goobster/config/config.json`);
        const perUser = await rootsHandedToTheCli({ euid: 501, home, extra: ['--per-user'] });
        expect(perUser.answers.roots).toEqual(plain.answers.roots);
        const based = await rootsHandedToTheCli({ euid: 501, home, extra: ['--base', '/Volumes/Data/g h'] });
        expect(based.answers.roots.data).toBe('/Volumes/Data/g h/data');
        for (const value of Object.values(plain.answers.roots)) expect(value.startsWith(`${home}/`)).toBe(true);
    });
});

describe('the answers a headless run hands the CLI', () => {
    async function answersFor({ given = {}, euid = 0, mode = 0o600 }) {
        const base = scratch('answers');
        const dir = scratch('answers-file');
        const file = writeAnswers(dir, given, mode);
        const cli = capturingCli();
        const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('goobster-answers-'));
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--headless', '--answers', file, '--dry-run'], {
            env: await environment(base), euid, home: '/var/root', cli, stdout: sink(), stderr: sink()
        });
        const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('goobster-answers-'));
        return { code, seen: cli.seen, file, dir, leftBehind: after.filter(name => !before.includes(name)) };
    }

    test('as root the service account is _goobster and it is created; the operator\'s file is not rewritten and no copy is left behind', async () => {
        const result = await answersFor({ given: { ownerLabel: 'me' } });
        expect(result.code).toBe(0);
        expect(result.seen.answers).toMatchObject({ ownerLabel: 'me', runtimeUser: '_goobster', createRuntimeUser: true, layout: 'standalone' });
        expect(JSON.parse(fs.readFileSync(result.file, 'utf8'))).toEqual({ ownerLabel: 'me' });
        expect(result.leftBehind).toEqual([]);
        expect(result.seen.argv[result.seen.argv.indexOf('--answers') + 1]).not.toBe(result.file);
    });

    test('an account the operator named is theirs; as a person nothing about accounts is added', async () => {
        const named = await answersFor({ given: { runtimeUser: 'svc-goobster' } });
        expect(named.seen.answers.runtimeUser).toBe('svc-goobster');
        expect(named.seen.answers.createRuntimeUser).toBeUndefined();
        const person = await answersFor({ given: {}, euid: 501 });
        expect(person.seen.answers.runtimeUser).toBeUndefined();
        expect(person.seen.answers.createRuntimeUser).toBeUndefined();
    });

    test('an answers file other users can read is refused (exit 2) as root too, and nothing is installed', async () => {
        const result = await answersFor({ given: {}, mode: 0o644 });
        expect(result.code).toBe(2);
        expect(result.seen.answers).toBeNull();
    });

    test('after a root install the roots are handed to _goobster through the helper', async () => {
        const base = scratch('hand-over');
        const real = require('@goobster/manager/cli');
        const calls = [];
        const cli = { loadAnswers: real.loadAnswers, run: async () => 0 };
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--headless', '--answers', writeAnswers(scratch('ho-a'), {}), '--base', base], {
            env: await environment(base),
            stdout: sink(),
            stderr: sink(),
            euid: 0,
            cli,
            createStore: () => ({ readInstallation: () => ({ status: 'ok', doc: { installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11' } }) }),
            privileged: { run: async (operation, input) => { calls.push({ operation, input }); return { status: 'done' }; } }
        });
        expect(code).toBe(0);
        expect(calls.map(call => call.operation)).toEqual(['user.create']);
        expect(calls[0].input).toMatchObject({ name: '_goobster', system: true, mode: 'payload', home: base });
    });
});

describe('the per-user headless journey (macOS platform injected, helper recorded)', () => {
    async function perUser({ runner = runnerStub(), answers = {}, base = scratch('mac-headless') } = {}) {
        const root = path.join(base, 'Library with space é');
        const out = sink();
        const err = sink();
        const dir = payload();
        const code = await bootstrap.run(['--payload', dir, '--payload-digest', DIGEST, '--build', 'dev', '--per-user', '--headless', '--answers', writeAnswers(scratch('mac-answers'), answers), '--base', root], {
            env: await environment(base), euid: 501, stdout: out, stderr: err, installDeps: macDeps(runner)
        });
        return { code, out: out.text(), err: err.text(), root, runner, dir, base };
    }

    test('installs into roots with spaces, registers the person\'s LaunchAgent through the helper, and prints the unsigned notice', async () => {
        const result = await perUser();
        expect(result.code).toBe(0);
        expect(result.out).toContain('install.new: applied');
        expect(result.out).toMatch(/done\s+register-service/);
        expect(result.out + result.err).toContain('UNSIGNED DEVELOPMENT BUILD');
        expect(result.runner.calls.map(call => call.operation)).toEqual(['service.register']);
        expect(result.runner.calls[0].input).toMatchObject({ kind: 'launchd', scope: 'user', name: 'goobster', mode: 'payload', codeRoot: path.join(result.root, 'code') });
        expect(fs.existsSync(path.join(result.root, 'code', 'current', 'payload-manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(result.root, 'data', 'manager', 'installation.json'))).toBe(true);
        expect(fs.readdirSync(path.join(result.root, 'code', 'staging'))).toEqual([]);
        const record = serviceRecord.readRecord(path.join(result.root, 'data', 'manager'));
        expect(record.services).toEqual([expect.objectContaining({ kind: 'launchd', name: 'goobster', registeredBy: 'installer' })]);
        expect(record.services[0].unitPath.endsWith('/Library/LaunchAgents/io.goobster.goobster.plist')).toBe(true);
    });

    test('launchd not there: the install completes, the plist is written next to the manager state, and the exact launchctl commands are printed', async () => {
        const runner = runnerStub({ 'service.register': { status: 'fallback', reason: 'LAUNCHD_UNAVAILABLE' } });
        const result = await perUser({ runner });
        expect(result.code).toBe(0);
        expect(result.out).toMatch(/skipped\s+register-service \(MANUAL_FALLBACK\)/);
        expect(result.out).toContain('launchctl bootstrap "gui/$(id -u)"');
        expect(result.out).not.toContain('systemctl');
        const unit = path.join(result.root, 'data', 'manager', 'io.goobster.goobster.plist');
        expect(plist.parsePlist(fs.readFileSync(unit, 'utf8'))).toMatchObject({ label: 'io.goobster.goobster', workingDirectory: path.join(result.root, 'code') });
        expect(serviceRecord.readRecord(path.join(result.root, 'data', 'manager')).services).toEqual([]);
    });

    test('a second run changes nothing, and the wizard then refuses to start over the installation (exit 3)', async () => {
        const first = await perUser();
        expect(first.code).toBe(0);
        const again = sink();
        const code = await bootstrap.run(['--payload', first.dir, '--payload-digest', DIGEST, '--build', 'dev', '--per-user', '--headless', '--answers', writeAnswers(scratch('mac-again'), {}), '--base', first.root], {
            env: await environment(first.base), euid: 501, stdout: again, stderr: sink(), installDeps: macDeps(runnerStub())
        });
        expect(code).toBe(0);
        expect(again.text()).toMatch(/nothing to change|applied/);

        const err = sink();
        const wizard = await bootstrap.run(['--payload', first.dir, '--payload-digest', DIGEST, '--build', 'dev', '--per-user', '--base', first.root], {
            env: await environment(first.base), euid: 501, stdout: sink(), stderr: err, installDeps: macDeps(runnerStub())
        });
        expect(wizard).toBe(3);
        expect(err.text()).toContain('ALREADY_INSTALLED');
    });

    test('--dry-run plans and writes nothing', async () => {
        const base = scratch('mac-dry');
        const root = path.join(base, 'dry run');
        const runner = runnerStub();
        const code = await bootstrap.run(['--payload', payload(), '--payload-digest', DIGEST, '--build', 'dev', '--per-user', '--headless', '--answers', writeAnswers(scratch('mac-dry-a'), {}), '--base', root, '--dry-run'], {
            env: await environment(base), euid: 501, stdout: sink(), stderr: sink(), installDeps: macDeps(runner)
        });
        expect(code).toBe(0);
        expect(fs.existsSync(path.join(root, 'code', 'current'))).toBe(false);
        expect(runner.calls).toEqual([]);
    });
});

describe('the wizard on macOS', () => {
    function get(port, urlPath) {
        return new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: urlPath }, (response) => {
                let body = '';
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve({ status: response.statusCode, body }));
            }).on('error', reject);
        });
    }

    async function startWizard({ spawn, extraArgs = ['--open-browser'], runner = runnerStub() } = {}) {
        const base = scratch('mac-wizard');
        const out = sink();
        const err = sink();
        const controller = new AbortController();
        let ready;
        const readyPromise = new Promise((resolve) => { ready = resolve; });
        const dir = payload();
        const done = bootstrap.run(['--payload', dir, '--payload-digest', DIGEST, '--build', 'dev', '--per-user', '--base', path.join(base, 'w s'), ...extraArgs], {
            env: await environment(base),
            stdout: out,
            stderr: err,
            euid: 501,
            signal: controller.signal,
            pollMs: 30,
            onReady: ready,
            spawn,
            installDeps: macDeps(runner)
        });
        const info = await readyPromise;
        return { out, err, controller, done, info, runner };
    }

    test('serves the manager on loopback, opens it with /usr/bin/open (not xdg-open), and Ctrl-C leaves without touching any service', async () => {
        const spawned = [];
        const spawn = (file, args, options) => {
            spawned.push({ file, args, options });
            return { on() {}, unref() {} };
        };
        const wizard = await startWizard({ spawn });
        const { port, url } = wizard.info;
        expect(spawned).toHaveLength(1);
        expect(spawned[0].file).toBe('/usr/bin/open');
        expect(spawned[0].args).toEqual([url]);
        expect(url).toBe(`http://127.0.0.1:${port}/manager/`);
        expect(wizard.out.text()).toContain(url);
        const status = await get(port, '/manager/api/status');
        expect(JSON.parse(status.body)).toMatchObject({ service: 'goobster-manager', state: 'unclaimed' });
        wizard.controller.abort();
        expect(await wizard.done).toBe(0);
        expect(wizard.out.text()).toContain('untouched');
        expect(wizard.runner.calls).toEqual([]);
        await expect(get(port, '/manager/api/status')).rejects.toBeTruthy();
    });

    test('without --open-browser nothing is opened; a browser that cannot be opened is said, not fatal', async () => {
        const spawn = jest.fn();
        const quiet = await startWizard({ spawn, extraArgs: [] });
        expect(spawn).not.toHaveBeenCalled();
        quiet.controller.abort();
        expect(await quiet.done).toBe(0);

        const broken = await startWizard({ spawn: () => { throw new Error('no open'); } });
        expect(broken.out.text()).toContain('could not be opened');
        broken.controller.abort();
        expect(await broken.done).toBe(0);
    });
});

describe('the shared entry is unchanged for Linux', () => {
    test('the Linux entry still exports what the macOS entry builds on', () => {
        for (const name of ['run', 'parseArgs', 'buildInstallAnswers', 'readIdentity', 'HELP', 'BootstrapUsage']) expect(linuxBootstrap[name]).toBeDefined();
        expect(linuxBootstrap.HELP).not.toContain('_goobster');
    });
});
