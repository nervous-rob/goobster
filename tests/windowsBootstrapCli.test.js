/**
 * What the Windows installer runs after NSIS unpacked the payload
 * (apps/manager/bootstrap/win32.js): argument handling, the roots a person
 * or an administrator gets, the headless and wizard flows against the
 * manager's own install engine (the Windows service kind with a stubbed
 * helper), the launcher it leaves in the code root and the HKCU entry for
 * Programs and Features. This is a Linux machine, so Windows programs are
 * injected fakes and the roots are throwaway POSIX directories; the
 * `windows-bootstrap` workflow runs the real thing on windows-2022.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');

const win32 = require('@goobster/manager/bootstrap/win32');
const paths = require('@goobster/manager/install/paths');
const payloadStage = require('../scripts/lib/payloadStage');
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
    const release = makeRelease(scratch('win-payload'));
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
            return replies[operation] || { status: 'done', outcome: 'done', detail: { active: 'running' }, log: [] };
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

const installDeps = (runner) => ({ privileged: runner, unitNames: () => [], platform: 'win32', discover: () => ({ candidates: [], searched: 0 }) });

function writeAnswers(dir, doc) {
    const file = path.join(dir, 'answers.json');
    fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
}

describe('argument handling', () => {
    test('help names the silent switches; version and the digest check need nothing else', async () => {
        const out = sink();
        expect(await win32.run(['--help'], { stdout: out, stderr: sink() })).toBe(0);
        expect(out.text()).toContain('/S /ANSWERS=');
        expect(out.text()).toContain('Run as administrator');
        const version = sink();
        expect(await win32.run(['--payload', payload(), '--version'], { stdout: version, stderr: sink() })).toBe(0);
        expect(version.text().trim()).toBe('2.4.0');
        const err = sink();
        expect(await win32.run(['--payload', payload(), '--payload-digest', 'c'.repeat(64)], { stdout: sink(), stderr: err, elevated: false })).toBe(4);
        expect(err.text()).toContain('PAYLOAD_DIGEST_MISMATCH');
    });

    test('--uninstaller is this entry\'s own flag; the shared flags still parse, an unknown one is a usage error (exit 2)', async () => {
        const parsed = win32.parseArgs(['--payload', 'C:\\p', '--uninstaller', 'C:\\u\\uninstall.exe', '--headless', '--answers', 'a.json', '--build', 'dev', '--signed', '0']);
        expect(parsed).toMatchObject({ payload: 'C:\\p', uninstaller: 'C:\\u\\uninstall.exe', headless: true, answers: 'a.json', build: 'dev', signed: false });
        expect(() => win32.parseArgs(['--uninstaller'])).toThrow(/needs a value/);
        const err = sink();
        expect(await win32.run(['--payload', payload(), '--frobnicate'], { stdout: sink(), stderr: err })).toBe(2);
        expect(err.text()).toContain('USAGE');
        expect(await win32.run([], { stdout: sink(), stderr: sink() })).toBe(2);
        expect(await win32.run(['--payload', payload(), '--headless'], { stdout: sink(), stderr: sink() })).toBe(2);
    });
});

describe('default roots', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', ProgramData: 'C:\\ProgramData', SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\alice' };

    test('a person gets %LOCALAPPDATA%\\Goobster, an administrator %ProgramData%\\Goobster, --base wins; config sits in its own folder', () => {
        const person = win32.rootsFor({ env, elevated: false, base: null, platform: 'win32' });
        const admin = win32.rootsFor({ env, elevated: true, base: null, platform: 'win32' });
        const named = win32.rootsFor({ env, elevated: false, base: 'D:\\Games\\Goobster', platform: 'win32' });
        expect(person).toEqual({
            code: 'C:\\Users\\alice\\AppData\\Local\\Goobster\\code',
            data: 'C:\\Users\\alice\\AppData\\Local\\Goobster\\data',
            config: 'C:\\Users\\alice\\AppData\\Local\\Goobster\\config\\config.json',
            cache: 'C:\\Users\\alice\\AppData\\Local\\Goobster\\cache',
            logs: 'C:\\Users\\alice\\AppData\\Local\\Goobster\\logs',
            managerStore: 'C:\\Users\\alice\\AppData\\Local\\Goobster\\data\\manager'
        });
        expect(admin.code).toBe('C:\\ProgramData\\Goobster\\code');
        expect(admin.managerStore).toBe('C:\\ProgramData\\Goobster\\data\\manager');
        expect(named.config).toBe('D:\\Games\\Goobster\\config\\config.json');
        for (const roots of [person, admin]) {
            const bases = paths.allowedBases({ home: 'C:\\Users\\alice', platform: 'win32', env });
            for (const value of Object.values(roots)) expect(paths.isUnderAllowedBase(value, bases, { platform: 'win32' })).toBe(true);
        }
    });
});

describe('the launcher left in the code root', () => {
    const text = win32.launcherText();
    const lines = text.split('\r\n').map(line => line.trim());

    test('is one fixed batch text with Windows line endings, interpolating nothing of the installation', () => {
        expect(text.endsWith('\r\n')).toBe(true);
        expect(text.replace(/\r\n/g, '')).not.toContain('\n');
        expect(win32.launcherText()).toBe(text);
        expect(text).not.toMatch(/[A-Za-z]:\\(?!\w*%)/);
        expect(text).not.toMatch(/HKLM|netsh|powershell|http/i);
    });

    test('reads GOOBSTER_* lines of goobster.env as text, never overriding the caller, then hands over to the payload launcher', () => {
        expect(lines).toContain('for /f "usebackq eol=# tokens=1* delims==" %%A in ("%CODE%\\goobster.env") do (');
        expect(text).toContain('findstr /b /c:"GOOBSTER_"');
        expect(text).toContain('if not defined %%A set "%%A=%%B"');
        expect(lines).toContain('call "%CODE%\\current\\bin\\goobster-manager.cmd" %*');
        expect(lines.indexOf('call "%CODE%\\current\\bin\\goobster-manager.cmd" %*')).toBeGreaterThan(lines.indexOf('if /i "%~1"=="uninstall" goto :uninstall'));
    });

    test('an uninstall runs the CLI from a copy of Node outside the code root, then removes the copy', () => {
        const at = lines.indexOf(':uninstall');
        const block = lines.slice(at).join('\n');
        expect(block).toContain('copy /y "%CODE%\\current\\runtime\\node.exe" "%RUNNER%\\node.exe"');
        expect(block).toContain('"%RUNNER%\\node.exe" "%CODE%\\current\\app\\apps\\manager\\cli.js" %*');
        expect(block).toContain('rmdir /s /q "%RUNNER%"');
        expect(block.indexOf('cli.js')).toBeLessThan(block.indexOf('rmdir /s /q'));
        expect(block).toContain('set "RUNNER=%TEMP%\\goobster-uninstall-');
        expect(block).toContain('exit /b %RC%');
    });
});

describe('Programs and Features', () => {
    const roots = { code: 'C:\\Users\\a b\\AppData\\Local\\Goobster\\code' };

    test('one HKCU Uninstall entry named Goobster, written with reg.exe argument vectors, never HKLM', () => {
        const commands = win32.registryCommands({ roots, version: '2.4.0', uninstaller: 'C:\\Users\\a b\\AppData\\Local\\Goobster\\uninstall\\uninstall.exe' });
        for (const argv of commands) {
            expect(argv.slice(0, 2)).toEqual(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Goobster']);
            expect(argv[argv.length - 1]).toBe('/f');
            expect(argv.join(' ')).not.toMatch(/HKLM|HKEY_LOCAL_MACHINE/);
        }
        const byName = Object.fromEntries(commands.map(argv => [argv[3], argv[7]]));
        expect(byName).toEqual({
            DisplayName: 'Goobster',
            DisplayVersion: '2.4.0',
            Publisher: 'Goobster',
            InstallLocation: roots.code,
            UninstallString: '"C:\\Users\\a b\\AppData\\Local\\Goobster\\uninstall\\uninstall.exe"',
            QuietUninstallString: '"C:\\Users\\a b\\AppData\\Local\\Goobster\\uninstall\\uninstall.exe" /S',
            NoModify: '1',
            NoRepair: '1'
        });
    });

    test('finishInstall writes the launcher once the install activated a payload, and registers only when NSIS named an uninstaller', () => {
        const code = scratch('finish');
        fs.mkdirSync(path.join(code, 'current', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(code, 'current', 'bin', 'goobster-manager.cmd'), '@echo off\r\n');
        const calls = [];
        const exec = (file, argv) => { calls.push({ file, argv }); return { status: 0 }; };
        const none = win32.finishInstall({ roots: { code }, identity: { version: '2.4.0' }, args: { uninstaller: null }, exec, env: {} });
        expect(none).toEqual({ launcher: true, registered: false });
        expect(fs.readFileSync(path.join(code, 'goobster-manager.cmd'), 'utf8')).toBe(win32.launcherText());
        expect(calls).toEqual([]);

        const both = win32.finishInstall({ roots: { code }, identity: { version: '2.4.0' }, args: { uninstaller: 'C:\\u\\uninstall.exe' }, exec, env: { SystemRoot: 'C:\\Windows' } });
        expect(both).toEqual({ launcher: true, registered: true });
        expect(calls).toHaveLength(8);
        for (const call of calls) expect(call.file).toBe('C:\\Windows\\System32\\reg.exe');
    });

    test('no activated payload: no launcher; a failing reg.exe never throws', () => {
        const code = scratch('finish-none');
        expect(win32.finishInstall({ roots: { code }, identity: {}, args: { uninstaller: null }, exec: () => ({ status: 1 }), env: {} })).toEqual({ launcher: false, registered: false });
        expect(fs.existsSync(path.join(code, 'goobster-manager.cmd'))).toBe(false);
        expect(win32.finishInstall({ roots: { code }, identity: {}, args: { uninstaller: 'C:\\u.exe' }, exec: () => ({ status: 1 }), env: {} }).registered).toBe(false);
        expect(win32.finishInstall({ roots: { code }, identity: {}, args: { uninstaller: 'C:\\u.exe' }, exec: () => { throw new Error('boom'); }, env: {} }).registered).toBe(false);
    });
});

describe('--headless --answers (silent install)', () => {
    async function headless({ answers = {}, runner = runnerStub(), extraArgs = [], finish = jest.fn(), cli = null, elevated = false } = {}) {
        const base = scratch('win-headless');
        const file = writeAnswers(scratch('win-answers'), answers);
        const out = sink();
        const err = sink();
        const dir = payload();
        const target = path.join(base, 'with space');
        const code = await win32.run(['--payload', dir, '--payload-digest', DIGEST, '--build', 'dev', '--uninstaller', 'C:\\u\\uninstall.exe', '--headless', '--answers', file, '--base', target, ...extraArgs], {
            env: await environment(base),
            stdout: out,
            stderr: err,
            platform: 'linux',
            elevated,
            finish,
            installDeps: installDeps(runner),
            ...(cli ? { cli } : {})
        });
        return { code, out: out.text(), err: err.text(), base: target, runner, finish, payload: dir };
    }

    test('drives install.new into roots with spaces, registers the Windows service kind with no account to create, and finishes the install', async () => {
        const result = await headless();
        expect(result.code).toBe(0);
        expect(result.out).toContain('install.new: applied');
        const code = path.join(result.base, 'code');
        expect(fs.existsSync(path.join(code, 'current', 'payload-manifest.json'))).toBe(true);
        expect(result.runner.calls.map(call => call.operation)).toEqual(['service.register']);
        expect(result.runner.calls[0].input).toMatchObject({ kind: 'windows-service', name: 'goobster', runtimeUser: 'goobster', mode: 'payload', codeRoot: code });
        expect(rootsEnvFile.readRootsEnv(code).GOOBSTER_DATA_DIR).toBe(path.join(result.base, 'data'));
        expect(result.finish).toHaveBeenCalledTimes(1);
        expect(result.finish.mock.calls[0][0].roots).toMatchObject({ code, data: path.join(result.base, 'data'), managerStore: path.join(result.base, 'data', 'manager') });
        expect(result.out + result.err).toContain('UNSIGNED DEVELOPMENT BUILD');
    });

    test('the merged answers never ask for a runtime account (Windows assigns the virtual account itself)', async () => {
        let seen = null;
        const real = require('@goobster/manager/cli');
        const cli = {
            loadAnswers: real.loadAnswers,
            run: async (argv) => {
                seen = JSON.parse(fs.readFileSync(argv[argv.indexOf('--answers') + 1], 'utf8'));
                return 0;
            }
        };
        const result = await headless({ cli, elevated: true });
        expect(result.code).toBe(0);
        expect(seen).toMatchObject({ layout: 'standalone', release: { allowUnsigned: true } });
        expect(seen.runtimeUser).toBeUndefined();
        expect(seen.createRuntimeUser).toBeUndefined();
    });

    test('--log appends everything printed to the file, creating its folder, and a log that cannot be written never stops the install', async () => {
        const logs = path.join(scratch('win-log'), 'nested dir', 'install.log');
        const result = await headless({ extraArgs: ['--log', logs] });
        expect(result.code).toBe(0);
        const text = fs.readFileSync(logs, 'utf8');
        expect(text).toContain('install.new: applied');
        expect(text).toContain('UNSIGNED DEVELOPMENT BUILD');
        const blocked = path.join(scratch('win-blocked'), 'file');
        fs.writeFileSync(blocked, 'x');
        expect((await headless({ extraArgs: ['--log', path.join(blocked, 'install.log')] })).code).toBe(0);
        expect(() => win32.parseArgs(['--log'])).toThrow(/needs a value/);
    });

    test('--dry-run writes nothing and finishes nothing; a failed install finishes nothing', async () => {
        const dry = await headless({ extraArgs: ['--dry-run'] });
        expect(dry.code).toBe(0);
        expect(dry.finish).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dry.base, 'code', 'current'))).toBe(false);

        const failing = await headless({ cli: { loadAnswers: require('@goobster/manager/cli').loadAnswers, run: async () => 1 } });
        expect(failing.code).toBe(1);
        expect(failing.finish).not.toHaveBeenCalled();
    });

    test('answers that name another payload are refused (exit 2), and an answers file the schema rejects stops the install', async () => {
        const other = await headless({ answers: { source: 'C:\\some\\other\\release' } });
        expect(other.code).toBe(2);
        expect(other.err).toContain('ANSWERS_SOURCE');
        const bad = await headless({ answers: { layout: 'sideways' } });
        expect(bad.code).toBe(2);
        expect(fs.existsSync(path.join(bad.base, 'code', 'current'))).toBe(false);
    });

    test('a service that was not registered (UAC declined) still completes the install and names the by-hand route', async () => {
        const runner = runnerStub({ 'service.register': { status: 'fallback', reason: 'ELEVATION_DECLINED' } });
        const result = await headless({ runner });
        expect(result.code).toBe(0);
        expect(result.out).toMatch(/skipped\s+register-service \(MANUAL_FALLBACK\)/);
        expect(result.finish).toHaveBeenCalledTimes(1);
    });
});

describe('the wizard', () => {
    async function startWizard({ runner = runnerStub(), spawn, args = [] } = {}) {
        const base = scratch('win-wizard');
        const out = sink();
        const err = sink();
        const controller = new AbortController();
        let ready;
        const readyPromise = new Promise((resolve) => { ready = resolve; });
        const dir = payload();
        const finish = jest.fn();
        const done = win32.run(['--payload', dir, '--payload-digest', DIGEST, '--build', 'dev', '--base', path.join(base, 'w s'), ...args], {
            env: await environment(base),
            stdout: out,
            stderr: err,
            platform: 'linux',
            elevated: false,
            signal: controller.signal,
            pollMs: 30,
            onReady: ready,
            spawn,
            finish,
            installDeps: installDeps(runner)
        });
        const info = await readyPromise;
        return { base: path.join(base, 'w s'), out, err, controller, done, info, runner, dir, finish };
    }

    test('serves the manager on loopback and prints the address; Ctrl-C leaves without finishing or touching any service', async () => {
        const runner = runnerStub();
        const wizard = await startWizard({ runner });
        expect(wizard.info.url).toBe(`http://127.0.0.1:${wizard.info.port}/manager/`);
        expect(wizard.out.text()).toContain(wizard.info.url);
        expect(wizard.out.text()).not.toContain('ssh -L');
        wizard.controller.abort();
        expect(await wizard.done).toBe(0);
        expect(wizard.out.text()).toContain('untouched');
        expect(runner.calls).toEqual([]);
        expect(wizard.finish).not.toHaveBeenCalled();
    });

    test('--open-browser hands the address to explorer.exe, detached, and nothing else', async () => {
        const calls = [];
        const spawn = (file, argv, options) => {
            calls.push({ file, argv, options });
            return { on() {}, unref() {} };
        };
        const wizard = await startWizard({ spawn, args: ['--open-browser'] });
        try {
            expect(calls).toEqual([{ file: 'C:\\Windows\\explorer.exe', argv: [wizard.info.url], options: { stdio: 'ignore', detached: true } }]);
        } finally {
            wizard.controller.abort();
            await wizard.done;
        }
    });

    test('a finished install finishes the Windows part, stops its own manager so the service can take the address, and names the service', async () => {
        const wizard = await startWizard();
        await drive({ manager: wizard.info.manager }, 'install.new', { source: wizard.dir, release: { allowUnsigned: true }, layout: 'standalone' });
        expect(await wizard.done).toBe(0);
        const text = wizard.out.text();
        expect(text).toContain('The install finished (applied)');
        expect(text).toContain('The service "goobster" is registered and starts with Windows. Check it with: sc.exe query goobster');
        expect(wizard.finish).toHaveBeenCalledTimes(1);
        expect(wizard.runner.calls.map(call => call.operation)).toEqual(['service.register']);
    });

    test('without a registered service the finish message gives the foreground line and the administrator commands', async () => {
        const wizard = await startWizard({ runner: runnerStub({ 'service.register': { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' } }) });
        await drive({ manager: wizard.info.manager }, 'install.new', { source: wizard.dir, release: { allowUnsigned: true }, layout: 'standalone' });
        expect(await wizard.done).toBe(0);
        const text = wizard.out.text();
        expect(text).toContain('no service was registered');
        expect(text).toContain('goobster-manager.cmd" --supervise');
        expect(text).toContain('from an administrator Command Prompt');
        expect(text).toContain('goobster-service.exe" install');
    });
});
