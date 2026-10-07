/**
 * The launchd service kind (#332, documentation/macos_install.md): the plist
 * the installer renders for the LaunchDaemon and the LaunchAgent, the kind
 * definition the install steps follow, and the install lifecycle driven with
 * the macOS platform injected and a recording stand-in for the privileged
 * helper (the helper itself is tests/darwinHelper.test.js). `plutil -lint`
 * checks the rendered plist when the binary exists on the machine running the
 * suite (macOS); elsewhere that one test is skipped.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const plist = require('@goobster/manager/platform/launchdPlist');
const launchdService = require('@goobster/manager/platform/launchdService');
const serviceKinds = require('@goobster/manager/platform/serviceKinds');
const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const protocol = require('@goobster/manager/privileged/protocol');
const { makeRelease, newHarness, drive, tempDir } = require('./helpers/installFixture');

const cleanup = [];
const scratch = (label) => tempDir(cleanup, label);

afterEach(() => {
    jest.restoreAllMocks();
});
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const plutil = (() => {
    try {
        return childProcess.spawnSync('plutil', ['-help'], { stdio: 'pipe' }).status !== null && process.platform === 'darwin';
    } catch {
        return false;
    }
})();
const plutilTest = plutil ? test : test.skip;

const ID = '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11';
const rootsUnder = (base) => ({
    code: path.join(base, 'code'),
    data: path.join(base, 'data'),
    config: path.join(base, 'config', 'config.json'),
    cache: path.join(base, 'cache'),
    logs: path.join(base, 'logs'),
    uploads: path.join(base, 'data', 'web-uploads'),
    managerStore: path.join(base, 'data', 'manager')
});

function render(overrides = {}) {
    const base = overrides.base || '/opt/goobster';
    const roots = rootsUnder(base);
    return plist.renderPlist({ name: 'goobster', installationId: ID, runtimeUser: '_goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload', ...overrides });
}

describe('the rendered plist', () => {
    test('a machine job: label, marker, program, account, restart policy, drain time, environment and logs', () => {
        const text = render();
        expect(text).toContain('<key>Label</key>\n\t<string>io.goobster.goobster</string>');
        expect(text).toContain(`<key>X-Goobster-Installation</key>\n\t<string>${ID}</string>`);
        expect(text).toContain('<string>/opt/goobster/code/current/runtime/bin/node</string>');
        expect(text).toContain('<string>/opt/goobster/code/current/app/apps/manager/index.js</string>');
        expect(text).toContain('<string>--supervise</string>');
        expect(text).toContain('<key>WorkingDirectory</key>\n\t<string>/opt/goobster/code</string>');
        expect(text).toContain('<key>UserName</key>\n\t<string>_goobster</string>');
        expect(text).toContain('<key>RunAtLoad</key>\n\t<true/>');
        expect(text).toContain('<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>');
        expect(text).toContain('<key>ThrottleInterval</key>\n\t<integer>10</integer>');
        expect(text).toContain('<key>ExitTimeOut</key>\n\t<integer>120</integer>');
        expect(text).toContain('<key>GOOBSTER_SUPERVISOR</key>\n\t\t<string>launchd</string>');
        expect(text).toContain('<key>GOOBSTER_DATA_DIR</key>\n\t\t<string>/opt/goobster/data</string>');
        expect(text).toContain('<key>StandardOutPath</key>\n\t<string>/opt/goobster/logs/goobster-launchd.out.log</string>');
        expect(text).toContain('<key>StandardErrorPath</key>\n\t<string>/opt/goobster/logs/goobster-launchd.err.log</string>');
        expect(text).not.toContain('AbandonProcessGroup');
        expect(text).not.toContain('Sockets');
    });

    test('carries no address, no DOCTYPE, no secret and no unrelated path', () => {
        const text = render();
        expect(text).not.toMatch(/https?:|<!DOCTYPE|\/\/www\./);
        expect(text).not.toMatch(/(token|secret|password|api[_-]?key)/i);
        const paths = [...text.matchAll(/<string>(\/[^<]*)<\/string>/g)].map(match => match[1]);
        for (const value of paths) expect(value.startsWith('/opt/goobster')).toBe(true);
    });

    test('a user agent has no UserName (it runs as the person) and the same marker and program', () => {
        const text = render({ scope: 'user', runtimeUser: 'alice', base: '/Users/alice/Library/Application Support/Goobster' });
        expect(text).not.toContain('<key>UserName</key>');
        expect(text).toContain(`<key>X-Goobster-Installation</key>\n\t<string>${ID}</string>`);
        expect(text).toContain('<string>/Users/alice/Library/Application Support/Goobster/code/current/runtime/bin/node</string>');
        expect(plist.parsePlist(text)).toMatchObject({ label: 'io.goobster.goobster', installationId: ID, user: null });
    });

    test('a checkout job runs the given node against the checkout entry', () => {
        const base = '/srv/goobster';
        const roots = { ...rootsUnder(base), code: '/srv/goobster/checkout' };
        const text = plist.renderPlist({ name: 'goobster', installationId: ID, runtimeUser: 'alice', codeRoot: roots.code, roots, layout: 'lite', mode: 'checkout', nodePath: '/usr/local/bin/node' });
        expect(plist.parsePlist(text).programArguments).toEqual(['/usr/local/bin/node', '/srv/goobster/checkout/apps/manager/index.js', '--supervise']);
    });

    test('spaces, non-ASCII and XML metacharacters in a root survive render and parse unchanged', () => {
        const base = '/Users/zoë/Library/Application Support/Goobster & <Co>';
        const text = render({ base, scope: 'user', runtimeUser: 'zoe' });
        expect(text).toContain('Goobster &amp; &lt;Co&gt;');
        expect(text).not.toContain('Goobster & <Co>');
        const parsed = plist.parsePlist(text);
        expect(parsed.workingDirectory).toBe(`${base}/code`);
        expect(parsed.programArguments[0]).toBe(`${base}/code/current/runtime/bin/node`);
        expect(parsed.installationId).toBe(ID);
        expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
    });

    test('escapeXml and unescapeXml are inverses for every markup character', () => {
        const raw = `a&b<c>d"e'f &amp; é 日本`;
        expect(plist.escapeXml(raw)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f &amp;amp; é 日本');
        expect(plist.unescapeXml(plist.escapeXml(raw))).toBe(raw);
    });

    test('parsePlist reads only our shape: anything else names nothing', () => {
        for (const foreign of ['', 'not xml', '<plist><dict><key>Label</key><string>io.goobster.goobster</string></dict></plist>\n', '<html><body/></html>']) {
            const parsed = plist.parsePlist(foreign);
            expect(parsed.installationId).toBeNull();
        }
        const withoutMarker = render().replace(/\t<key>X-Goobster-Installation<\/key>\n\t<string>[^<]*<\/string>\n/, '');
        expect(plist.parsePlist(withoutMarker)).toMatchObject({ label: 'io.goobster.goobster', installationId: null });
        expect(plist.parsePlist(`${render()}<!-- tail -->`).installationId).toBe(ID);
    });

    test('a path a plist cannot carry safely is refused rather than escaped', () => {
        for (const bad of ['relative/path', '/opt/a\nb', '/opt/a"b', '/opt/a%b', '/opt/a$HOME']) {
            const roots = { ...rootsUnder('/opt/goobster'), code: bad };
            expect(() => plist.renderPlist({ name: 'goobster', installationId: ID, runtimeUser: '_goobster', codeRoot: bad, roots, layout: 'standalone', mode: 'payload' })).toThrow();
        }
    });

    test('names the daemon and agent files by label only', () => {
        expect(plist.labelFor('goobster')).toBe('io.goobster.goobster');
        expect(plist.plistFileName('goobster')).toBe('io.goobster.goobster.plist');
        expect(plist.daemonPath('goobster')).toBe('/Library/LaunchDaemons/io.goobster.goobster.plist');
        expect(plist.agentPath('goobster', '/Users/a b')).toBe('/Users/a b/Library/LaunchAgents/io.goobster.goobster.plist');
        expect(() => plist.labelFor('../evil')).toThrow();
    });

    plutilTest('plutil -lint accepts the machine, user and spaced-path plists', () => {
        const dir = scratch('plutil');
        const files = [
            render(),
            render({ scope: 'user', runtimeUser: 'alice' }),
            render({ base: '/Users/zoë/Library/Application Support/Goobster & <Co>', scope: 'user', runtimeUser: 'zoe' })
        ].map((text, index) => {
            const file = path.join(dir, `job-${index}.plist`);
            fs.writeFileSync(file, text);
            return file;
        });
        for (const file of files) {
            const result = childProcess.spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
            expect(`${result.stdout}${result.stderr}`).toContain('OK');
        }
    });
});

describe('the kind definition', () => {
    test('passes the seam\'s own check and is the registered launchd kind for darwin', () => {
        expect(() => serviceKinds.assertDefinition(launchdService)).not.toThrow();
        expect(serviceKinds.forKind('launchd')).toBe(launchdService);
        expect(serviceKinds.forPlatform('darwin')).toBe(launchdService);
        expect(launchdService).toMatchObject({ kind: 'launchd', platforms: ['darwin'], serviceName: 'goobster', fallbackFileName: 'io.goobster.goobster.plist' });
        expect(launchdService.installedFileName('goobster')).toBe('io.goobster.goobster.plist');
        expect(serviceRecord.KINDS).toContain('launchd');
    });

    test('the account rules: _goobster by default, any RUNTIME_USER-shaped name but root, the invoker as the default', () => {
        const { account } = launchdService;
        expect(account).toMatchObject({ creatable: true, fallbackName: '_goobster' });
        expect(account.accepts('_goobster')).toBe(true);
        expect(account.accepts('alice')).toBe(true);
        expect(account.accepts('root')).toBe(false);
        expect(account.accepts('')).toBe(false);
        expect(account.accepts('bad name')).toBe(false);
        expect(account.accepts('Alice;rm')).toBe(false);
        expect(account.defaultFor({ invoking: 'alice' })).toBe('alice');
    });

    test('the installed path follows the scope: the daemon for root, the home\'s LaunchAgents for a person', () => {
        expect(launchdService.installedPath('goobster', { elevated: true })).toBe('/Library/LaunchDaemons/io.goobster.goobster.plist');
        expect(launchdService.installedPath('goobster', { elevated: false, home: '/Users/a b' })).toBe('/Users/a b/Library/LaunchAgents/io.goobster.goobster.plist');
        expect(launchdService.scopeFor({ elevated: true })).toBe('machine');
        expect(launchdService.scopeFor({ elevated: false })).toBe('user');
        expect(launchdService.scopeFor({ elevated: null })).toBe('machine');
    });

    test('the register input names the scope and carries the node path only for a checkout; the unregister input is the standard shape', () => {
        const roots = rootsUnder('/opt/goobster');
        const params = { name: 'goobster', installationId: ID, runtimeUser: '_goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload', nodePath: '/usr/bin/node' };
        expect(launchdService.registerInput({ ...params, elevated: true })).toMatchObject({ kind: 'launchd', scope: 'machine', runtimeUser: '_goobster' });
        expect(launchdService.registerInput({ ...params, elevated: false })).toMatchObject({ kind: 'launchd', scope: 'user' });
        expect(launchdService.registerInput({ ...params, elevated: true })).not.toHaveProperty('nodePath');
        expect(launchdService.registerInput({ ...params, mode: 'checkout', elevated: true })).toMatchObject({ nodePath: '/usr/bin/node' });
        expect(launchdService.unregisterInput({ name: 'goobster', installationId: ID })).toEqual({ kind: 'launchd', name: 'goobster', registeredBy: 'installer', installationId: ID });
        for (const input of [launchdService.registerInput({ ...params, elevated: true }), launchdService.registerInput({ ...params, elevated: false })]) {
            expect(() => protocol.validateInput('service.register', input)).not.toThrow();
        }
    });

    test('the by-hand wording follows who asks: sudo and the system domain for root, the person\'s own domain otherwise', () => {
        const machine = launchdService.manualInstructions({ codeRoot: '/opt/goobster/code', mode: 'payload', nodePath: '/usr/bin/node', unitFile: '/opt/goobster/data/manager/io.goobster.goobster.plist', elevated: true });
        expect(machine.foreground).toBe('/opt/goobster/code/current/bin/goobster-manager --supervise');
        expect(machine.boot).toEqual([
            'sudo install -m 0644 -o root -g wheel /opt/goobster/data/manager/io.goobster.goobster.plist /Library/LaunchDaemons/io.goobster.goobster.plist',
            'sudo launchctl bootstrap system /Library/LaunchDaemons/io.goobster.goobster.plist'
        ]);
        const person = launchdService.manualInstructions({ codeRoot: '/Users/a/Library/Application Support/Goobster/code', mode: 'payload', nodePath: '/usr/bin/node', unitFile: '/tmp/x y.plist', elevated: false, home: '/Users/a' });
        expect(person.foreground).toBe("'/Users/a/Library/Application Support/Goobster/code/current/bin/goobster-manager' --supervise");
        expect(person.boot.join('\n')).toContain('launchctl bootstrap "gui/$(id -u)"');
        expect(person.boot.join('\n')).not.toContain('sudo');
        jest.spyOn(process, 'geteuid').mockReturnValue(0);
        expect(launchdService.statusCommand).toBe('launchctl print system/io.goobster.goobster');
        expect(launchdService.removeByHand).toContain('sudo launchctl bootout system/io.goobster.goobster');
        process.geteuid.mockReturnValue(501);
        expect(launchdService.statusCommand).toBe('launchctl print gui/$(id -u)/io.goobster.goobster');
    });
});

// ----------------------------------------------------- the install steps
function recordingRunner(replies = {}) {
    const calls = [];
    return {
        calls,
        isImplemented: () => true,
        async run(operation, input) {
            calls.push({ operation, input: JSON.parse(JSON.stringify(input)) });
            const reply = replies[operation];
            return reply || { status: 'done', outcome: 'applied', detail: operation === 'service.register' ? { active: 'running' } : {}, log: [] };
        }
    };
}

async function installOnMac(runner, { extraInput = {}, euid } = {}) {
    if (euid !== undefined) jest.spyOn(process, 'geteuid').mockReturnValue(euid);
    const root = scratch('mac');
    const release = makeRelease(scratch('mac-src'));
    const harness = await newHarness({ root, installDeps: { privileged: runner, unitNames: () => [], platform: 'darwin' } });
    const input = { source: release.dir, features: ['tavern'], release: { allowUnsigned: true }, ...extraInput };
    const { applied } = await drive(harness, 'install.new', input);
    const record = harness.manager.journal.read(applied.operation.id).record;
    const steps = Object.fromEntries(record.progress.map(item => [item.name, item]));
    return { harness, applied, steps };
}

describe('the install lifecycle on macOS (platform injected, helper recorded)', () => {
    test('as root: the account is created first, then the LaunchDaemon is registered at the machine scope and recorded', async () => {
        const runner = recordingRunner();
        const { harness, applied, steps } = await installOnMac(runner, { euid: 0, extraInput: { runtimeUser: '_goobster', createRuntimeUser: true } });
        expect(applied.operation.status).toBe('applied');
        expect(steps['register-service']).toMatchObject({ status: 'done' });
        expect(runner.calls.map(call => call.operation)).toEqual(['user.create', 'service.register']);
        expect(runner.calls[0].input).toMatchObject({ name: '_goobster', system: true });
        expect(runner.calls[1].input).toMatchObject({ kind: 'launchd', scope: 'machine', name: 'goobster', runtimeUser: '_goobster', codeRoot: harness.code, mode: 'payload' });
        const record = serviceRecord.readRecord(harness.settings.storeDir);
        expect(record.services).toEqual([expect.objectContaining({ kind: 'launchd', name: 'goobster', unitPath: '/Library/LaunchDaemons/io.goobster.goobster.plist', registeredBy: 'installer' })]);
        expect(applied.result.service).toMatchObject({ registered: true, kind: 'launchd', unit: 'io.goobster.goobster.plist', runtimeUser: '_goobster' });
    });

    test('as a person: no account is created, the agent is registered at the user scope for that person', async () => {
        const runner = recordingRunner();
        const { harness, applied, steps } = await installOnMac(runner, { euid: 501 });
        expect(applied.operation.status).toBe('applied');
        expect(steps['register-service']).toMatchObject({ status: 'done' });
        expect(runner.calls.map(call => call.operation)).toEqual(['service.register']);
        expect(runner.calls[0].input).toMatchObject({ kind: 'launchd', scope: 'user', name: 'goobster', runtimeUser: os.userInfo().username });
        const record = serviceRecord.readRecord(harness.settings.storeDir);
        expect(record.services[0].unitPath).toBe(path.join(os.userInfo().homedir, 'Library', 'LaunchAgents', 'io.goobster.goobster.plist'));
    });

    test('launchd offline: the install completes and the plist is written for the operator with launchctl wording', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'fallback', reason: 'LAUNCHD_UNAVAILABLE' } });
        const { harness, applied, steps } = await installOnMac(runner, { euid: 0, extraInput: { runtimeUser: '_goobster', createRuntimeUser: true } });
        expect(applied.operation.status).toBe('applied');
        expect(steps['register-service']).toMatchObject({ status: 'skipped', code: 'MANUAL_FALLBACK' });
        const service = applied.result.service;
        expect(service).toMatchObject({ registered: false, fallback: true, kind: 'launchd', reason: 'LAUNCHD_UNAVAILABLE' });
        expect(service.boot.join('\n')).toContain('sudo launchctl bootstrap system /Library/LaunchDaemons/io.goobster.goobster.plist');
        expect(service.boot.join('\n')).not.toContain('systemctl');
        expect(path.basename(service.unitFile)).toBe('io.goobster.goobster.plist');
        expect(plist.parsePlist(fs.readFileSync(service.unitFile, 'utf8'))).toMatchObject({ label: 'io.goobster.goobster', user: '_goobster' });
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
    });

    test('uninstall unregisters by the recorded name through the helper and takes the record back', async () => {
        const runner = recordingRunner();
        const { harness } = await installOnMac(runner, { euid: 0, extraInput: { runtimeUser: '_goobster', createRuntimeUser: true } });
        runner.calls.length = 0;
        const { applied } = await drive(harness, 'install.uninstall', { keepData: true });
        expect(applied.operation.status).toBe('applied');
        expect(runner.calls.map(call => call.operation)).toEqual(['service.unregister']);
        expect(runner.calls[0].input).toEqual({ kind: 'launchd', name: 'goobster', registeredBy: 'installer', installationId: expect.any(String) });
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
        expect(fs.existsSync(harness.settings.sqlitePath)).toBe(true);
    });
});
