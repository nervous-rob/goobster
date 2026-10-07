/**
 * The service-kind seam (apps/manager/platform/serviceKinds.js): the install
 * steps that register and unregister the operating-system service are the
 * same for every service manager and take everything specific to one from
 * its kind definition. systemd is the only definition in this version; a
 * fake kind stands in for the Windows and macOS ones to prove that the
 * steps, the ownership record, the manual fallback and the bootstrap's
 * closing message follow a definition and nothing else, and that a platform
 * without a definition still answers `deferred`.
 */
const fs = require('node:fs');
const path = require('node:path');

const serviceKinds = require('@goobster/manager/platform/serviceKinds');
const systemdService = require('@goobster/manager/platform/systemdService');
const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const unitText = require('@goobster/manager/platform/systemdUnit');
const lifecycle = require('@goobster/manager/platform/serviceLifecycle');
const elevate = require('@goobster/manager/privileged/elevate');
const linux = require('@goobster/manager/privileged/linux');
const helper = require('@goobster/manager/privileged/helper');
const { makeRelease, newHarness, drive, tempDir } = require('./helpers/installFixture');

const cleanup = [];
const scratch = (label) => tempDir(cleanup, label);

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

/** A service manager that assigns the identity itself (no account to create), with its own file names and wording. */
function fakeWindowsKind() {
    return Object.freeze({
        kind: 'windows-service',
        platforms: ['win32'],
        serviceName: 'goobster',
        fallbackFileName: 'goobster-service.xml',
        installedFileName: (name) => `${name}.xml`,
        installedPath: (name, { roots }) => `${roots.managerStore}/service/${name}.xml`,
        render: ({ name, installationId, runtimeUser, codeRoot, mode }) => `<service id="${name}" marker="${installationId}" account="${runtimeUser}" code="${codeRoot}" mode="${mode}"/>\n`,
        manualInstructions: ({ codeRoot, unitFile }) => ({ foreground: `"${codeRoot}\\current\\bin\\goobster-manager" --supervise`, boot: [`sc.exe create goobster from ${unitFile}`], unitFile }),
        statusCommand: 'sc.exe query goobster',
        removeByHand: 'sc.exe delete goobster',
        account: Object.freeze({
            creatable: false,
            accepts: (name) => name === 'goobster',
            defaultFor: () => 'goobster',
            fallbackName: 'goobster'
        }),
        registerInput: ({ name, layout, codeRoot, runtimeUser, installationId, roots, mode }) => ({ kind: 'windows-service', name, layout, codeRoot, runtimeUser, installationId, roots, mode }),
        unregisterInput: ({ name, installationId }) => ({ kind: 'windows-service', name, registeredBy: 'installer', installationId })
    });
}

const registryWith = (...definitions) => {
    const byKind = Object.fromEntries(definitions.map(def => [def.kind, def]));
    return { forKind: (kind) => byKind[kind] || null, forPlatform: () => null, kindForPlatform: serviceKinds.kindForPlatform };
};

function recordingRunner(replies = {}) {
    const calls = [];
    return {
        calls,
        isImplemented: () => true,
        async run(operation, input) {
            calls.push({ operation, input: JSON.parse(JSON.stringify(input)) });
            return replies[operation] || { status: 'done', outcome: 'applied', detail: {}, log: [] };
        }
    };
}

async function installOn(platform, runner, { kinds, extraInput = {} } = {}) {
    const root = scratch('kind');
    const release = makeRelease(scratch('kind-src'));
    const harness = await newHarness({ root, installDeps: { privileged: runner, unitNames: () => [], platform, ...(kinds ? { serviceKinds: kinds } : {}) } });
    const input = { source: release.dir, features: ['tavern'], release: { allowUnsigned: true }, ...extraInput };
    const { applied } = await drive(harness, 'install.new', input);
    const record = harness.manager.journal.read(applied.operation.id).record;
    // `progress` is the ledger (name, status, code); `steps` keeps what each step body returned.
    const steps = Object.fromEntries(record.progress.map(item => [item.name, item]));
    const results = Object.fromEntries(record.steps.map(item => [item.name, item.detail || null])); // the step body's detail, flattened
    return { harness, applied, steps, results };
}

describe('the registry', () => {
    test('names a kind per platform whether or not this version defines it, and defines systemd only', () => {
        expect(serviceKinds.kindForPlatform('linux')).toBe('systemd');
        expect(serviceKinds.kindForPlatform('win32')).toBe('windows-service');
        expect(serviceKinds.kindForPlatform('darwin')).toBe('launchd');
        expect(serviceKinds.forKind('systemd')).toBe(systemdService);
        expect(serviceKinds.forKind('windows-service')).toBeNull();
        expect(serviceKinds.forKind('launchd')).toBeNull();
        expect(serviceKinds.forPlatform('linux')).toBe(systemdService);
        expect(Object.keys(serviceKinds.DEFINITIONS)).toEqual(['systemd']);
    });

    test('every kind the record knows is a kind the registry may hold, and a definition must be complete', () => {
        for (const kind of Object.keys(serviceKinds.DEFINITIONS)) expect(serviceRecord.KINDS).toContain(kind);
        expect(() => serviceKinds.assertDefinition(fakeWindowsKind())).not.toThrow();
        expect(() => serviceKinds.assertDefinition({ ...fakeWindowsKind(), kind: 'pm2' })).toThrow(/not a service kind/);
        const { render, ...withoutRender } = fakeWindowsKind();
        void render;
        expect(() => serviceKinds.assertDefinition(withoutRender)).toThrow(/lacks render/);
        expect(() => serviceKinds.assertDefinition({ ...fakeWindowsKind(), account: { creatable: 'yes' } })).toThrow(/account rules/);
    });

    test('the systemd definition is the systemd unit: same text, installed path and account rules as before', () => {
        const roots = { code: '/opt/g', data: '/var/lib/g', config: '/etc/g/config.json', cache: '/var/cache/g', logs: '/var/log/g', uploads: '/var/lib/g/web-uploads', managerStore: '/var/lib/g/manager' };
        const params = { name: 'goobster', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11', runtimeUser: 'goobster', codeRoot: '/opt/g', roots, layout: 'standalone', mode: 'payload', nodePath: process.execPath };
        expect(systemdService.render(params)).toBe(unitText.renderUnit(params));
        expect(systemdService.installedPath('goobster')).toBe('/etc/systemd/system/goobster.service');
        expect(systemdService.installedFileName('goobster')).toBe('goobster.service');
        expect(systemdService.fallbackFileName).toBe(lifecycle.FALLBACK_UNIT);
        expect(systemdService.account.accepts('root')).toBe(false);
        expect(systemdService.account.accepts('')).toBe(false);
        expect(systemdService.account.accepts('alice')).toBe(true);
        expect(systemdService.account.defaultFor({ invoking: 'alice' })).toBe('alice');
        expect(systemdService.registerInput({ ...params, mode: 'checkout' })).toMatchObject({ kind: 'systemd', nodePath: process.execPath });
        expect(systemdService.registerInput(params)).not.toHaveProperty('nodePath');
        expect(systemdService.unregisterInput({ name: 'goobster', installationId: params.installationId })).toEqual({ kind: 'systemd', name: 'goobster', registeredBy: 'installer', installationId: params.installationId });
        expect(systemdService.manualInstructions({ codeRoot: '/opt/g', mode: 'payload', nodePath: process.execPath, unitFile: '/var/lib/g/manager/goobster.service' }))
            .toEqual(lifecycle.manualInstructions({ codeRoot: '/opt/g', mode: 'payload', nodePath: process.execPath, unitFile: '/var/lib/g/manager/goobster.service' }));
    });
});

describe('the install steps follow the kind definition', () => {
    test('a platform whose kind has no definition registers nothing: register-service is deferred, no record, no helper call', async () => {
        const runner = recordingRunner();
        const { harness, applied, steps } = await installOn('win32', runner);
        expect(applied.operation.status).toBe('applied');
        expect(steps['register-service']).toMatchObject({ status: 'deferred', code: 'NOT_IMPLEMENTED' });
        expect(runner.calls).toEqual([]);
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
        expect(harness.manager.store.readInstallation().doc.owned.services).toEqual([]);
    });

    test('with a definition the step registers through it: its request body, its installed path in the record, and no user.create for a kind that does not create accounts', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'done', outcome: 'applied', detail: { active: 'running' }, log: [] } });
        const { harness, applied, steps, results } = await installOn('win32', runner, { kinds: registryWith(fakeWindowsKind()), extraInput: { runtimeUser: 'goobster', createRuntimeUser: true } });
        expect(applied.operation.status).toBe('applied');
        expect(steps['register-service']).toMatchObject({ status: 'done' });
        expect(results['register-service']).toMatchObject({ kind: 'windows-service', runtimeUser: 'goobster', userCreated: false, active: 'running', warnings: [], privileged: 'service.register' });
        expect(runner.calls.map(call => call.operation)).toEqual(['service.register']);
        expect(runner.calls[0].input).toMatchObject({ kind: 'windows-service', name: 'goobster', runtimeUser: 'goobster', codeRoot: harness.code, mode: 'payload' });
        expect(runner.calls[0].input).not.toHaveProperty('nodePath');
        const record = serviceRecord.readRecord(harness.settings.storeDir);
        expect(record.services).toEqual([expect.objectContaining({ kind: 'windows-service', name: 'goobster', unitPath: `${harness.settings.storeDir}/service/goobster.xml`, registeredBy: 'installer' })]);
        expect(harness.manager.store.readInstallation().doc.owned.services).toEqual([{ kind: 'windows-service', name: 'goobster', registeredBy: 'installer' }]);
        expect(applied.result.service).toMatchObject({ registered: true, kind: 'windows-service', unit: 'goobster.xml', runtimeUser: 'goobster' });
    });

    test('a kind-specific account rule: a name the kind does not accept falls back before any helper call, with the kind\'s file and wording', async () => {
        const runner = recordingRunner();
        const { harness, steps, results } = await installOn('win32', runner, { kinds: registryWith(fakeWindowsKind()), extraInput: { runtimeUser: 'alice' } });
        expect(steps['register-service']).toMatchObject({ status: 'skipped', code: 'MANUAL_FALLBACK' });
        expect(results['register-service']).toMatchObject({ code: 'MANUAL_FALLBACK', reason: 'RUNTIME_USER_REQUIRED', unitFile: true });
        expect(runner.calls).toEqual([]);
        const file = path.join(harness.settings.storeDir, 'goobster-service.xml');
        expect(fs.readFileSync(file, 'utf8')).toContain('account="goobster"');
        expect(fs.existsSync(path.join(harness.settings.storeDir, 'goobster.service'))).toBe(false);
    });

    test('when the service manager is not there the fallback writes the kind\'s file, names its commands, and the record is taken back', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'fallback', reason: 'SERVICE_MANAGER_UNAVAILABLE' } });
        const { harness, applied, steps, results } = await installOn('win32', runner, { kinds: registryWith(fakeWindowsKind()) });
        expect(steps['register-service']).toMatchObject({ status: 'skipped', code: 'MANUAL_FALLBACK' });
        expect(results['register-service']).toMatchObject({ code: 'MANUAL_FALLBACK', kind: 'windows-service', reason: 'SERVICE_MANAGER_UNAVAILABLE', unitFile: true, warnings: [] });
        const service = applied.result.service;
        expect(service).toMatchObject({ registered: false, fallback: true, kind: 'windows-service', reason: 'SERVICE_MANAGER_UNAVAILABLE' });
        expect(service.boot).toEqual([`sc.exe create goobster from ${path.join(harness.settings.storeDir, 'goobster-service.xml')}`]);
        expect(service.foreground).toContain('goobster-manager" --supervise');
        expect(fs.readFileSync(service.unitFile, 'utf8')).toContain('<service id="goobster"');
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
        expect(harness.manager.store.readInstallation().doc.owned.services).toEqual([]);
    });

    test('uninstall unregisters through the kind\'s request body and its by-hand wording when rights are missing', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'done', outcome: 'applied', detail: {}, log: [] } });
        const { harness } = await installOn('win32', runner, { kinds: registryWith(fakeWindowsKind()) });
        runner.calls.length = 0;
        const { applied } = await drive(harness, 'install.uninstall', { keepData: true });
        expect(applied.operation.status).toBe('applied');
        expect(runner.calls.map(call => call.operation)).toEqual(['service.unregister']);
        expect(runner.calls[0].input).toEqual({ kind: 'windows-service', name: 'goobster', registeredBy: 'installer', installationId: expect.any(String) });
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
    });

    test('an uninstall that cannot elevate names the kind\'s by-hand removal', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'done', outcome: 'applied', detail: {}, log: [] }, 'service.unregister': { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' } });
        const { harness } = await installOn('win32', runner, { kinds: registryWith(fakeWindowsKind()) });
        let error = null;
        try {
            await drive(harness, 'install.uninstall', { keepData: true });
        } catch (caught) {
            error = caught;
        }
        expect(error).toMatchObject({ code: 'ELEVATION_REQUIRED' });
        expect(error.message).toContain('sc.exe delete goobster');
        expect(error.message).not.toContain('systemctl');
    });
});

describe('the bootstrap default roots per platform sit under the bases the setup pages accept', () => {
    const { defaultRoots } = require('@goobster/manager/bootstrap/roots');
    const paths = require('@goobster/manager/install/paths');

    test('Linux keeps its roots', () => {
        expect(defaultRoots({ env: {}, euid: 0, platform: 'linux' }).code).toBe('/opt/goobster');
        expect(defaultRoots({ env: {}, euid: 1000, home: '/home/x', platform: 'linux' }).code).toBe('/home/x/.local/share/goobster/code');
    });

    test('macOS: /opt/goobster for the machine, ~/Library/Application Support/Goobster per user', () => {
        const machine = defaultRoots({ env: {}, euid: 0, platform: 'darwin' });
        const person = defaultRoots({ env: {}, euid: 501, home: '/Users/a', platform: 'darwin' });
        expect(machine).toMatchObject({ code: '/opt/goobster/code', config: '/opt/goobster/config/config.json', managerStore: '/opt/goobster/data/manager' });
        expect(person).toMatchObject({ code: '/Users/a/Library/Application Support/Goobster/code', logs: '/Users/a/Library/Application Support/Goobster/logs' });
        const bases = paths.allowedBases({ home: '/Users/a', platform: 'darwin', env: {} });
        for (const roots of [machine, person]) for (const value of Object.values(roots)) expect(bases.some(base => value === base || value.startsWith(`${base}/`))).toBe(true);
        expect(defaultRoots({ env: {}, euid: 501, base: '/Volumes/Data/g', platform: 'darwin' }).data).toBe('/Volumes/Data/g/data');
    });

    test('Windows: %ProgramData%\\Goobster when elevated, %LOCALAPPDATA%\\Goobster per user, drive-letter fallbacks', () => {
        const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', ProgramData: 'C:\\ProgramData', SystemDrive: 'C:' };
        const machine = defaultRoots({ env, euid: null, elevated: true, platform: 'win32' });
        const person = defaultRoots({ env, euid: null, elevated: false, platform: 'win32' });
        expect(machine).toEqual({
            code: 'C:\\ProgramData\\Goobster\\code',
            data: 'C:\\ProgramData\\Goobster\\data',
            config: 'C:\\ProgramData\\Goobster\\config\\config.json',
            cache: 'C:\\ProgramData\\Goobster\\cache',
            logs: 'C:\\ProgramData\\Goobster\\logs',
            managerStore: 'C:\\ProgramData\\Goobster\\data\\manager'
        });
        expect(person.code).toBe('C:\\Users\\a\\AppData\\Local\\Goobster\\code');
        const bases = paths.allowedBases({ home: 'C:\\Users\\a', platform: 'win32', env });
        for (const roots of [machine, person]) for (const value of Object.values(roots)) expect(paths.isUnderAllowedBase(value, bases, { platform: 'win32' })).toBe(true);
        expect(defaultRoots({ env: {}, elevated: true, platform: 'win32' }).code).toBe('C:\\ProgramData\\Goobster\\code');
        expect(defaultRoots({ env: { SystemDrive: 'D:' }, elevated: false, home: 'D:\\Users\\b', platform: 'win32' }).code).toBe('D:\\Users\\b\\AppData\\Local\\Goobster\\code');
        expect(defaultRoots({ env, elevated: false, base: 'D:\\Goobster', platform: 'win32' }).config).toBe('D:\\Goobster\\config\\config.json');
    });
});

describe('the protocol carries the service scope', () => {
    const protocol = require('@goobster/manager/privileged/protocol');
    const roots = { code: '/srv/g/code', data: '/srv/g/data', config: '/srv/g/config/config.json', cache: '/srv/g/cache', logs: '/srv/g/logs', uploads: '/srv/g/data/web-uploads', managerStore: '/srv/g/data/manager' };
    const input = { kind: 'systemd', name: 'goobster', layout: 'standalone', codeRoot: roots.code, runtimeUser: 'goobster', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11', roots, mode: 'payload' };

    test('scope defaults to machine, accepts user, refuses anything else', () => {
        expect(protocol.validateInput('service.register', input).scope).toBe('machine');
        expect(protocol.validateInput('service.register', { ...input, kind: 'launchd', scope: 'user' }).scope).toBe('user');
        expect(() => protocol.validateInput('service.register', { ...input, scope: 'session' })).toThrow(/scope/);
    });

    test('the Linux helper registers machine services only', () => {
        const handler = linux.createHandler({ sandbox: true, fs, exec: () => ({ status: 0, stdout: '', stderr: '', error: null }) });
        expect(() => handler.handle('service.register', { ...input, scope: 'user' })).toThrow(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }));
    });
});

describe('the elevation runner takes what differs per platform from the platform module', () => {
    test('serviceFacts is asked before service.register (systemdFacts still answers for the Linux module)', () => {
        expect(elevate.serviceFactsOf({ serviceFacts: () => ({ available: false, reason: 'SCM_UNAVAILABLE', state: 'stopped' }) }, {})).toMatchObject({ available: false, reason: 'SCM_UNAVAILABLE' });
        expect(elevate.serviceFactsOf({ systemdFacts: () => ({ available: true }) }, {})).toEqual({ available: true });
        expect(elevate.serviceFactsOf({}, {})).toEqual({ available: true });
        expect(linux.serviceFacts).toBe(linux.systemdFacts);
    });

    test('a module\'s HELPER_FILES is what the manifest check covers; the Linux list is the default', () => {
        expect(linux.HELPER_FILES).toEqual(elevate.HELPER_FILES);
        const dir = scratch('helper-files');
        const files = ['app/x/one.js', 'app/x/two.js'];
        const entries = [];
        for (const rel of files) {
            const file = path.join(dir, ...rel.split('/'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `// ${rel}\n`);
            entries.push({ path: rel, sha256: elevate.sha256File(file) });
        }
        fs.writeFileSync(path.join(dir, 'payload-manifest.json'), JSON.stringify({ files: entries }));
        expect(elevate.verifyHelperFiles({ payloadRoot: dir, nodePath: '/usr/bin/node', files })).toMatchObject({ checked: true, ok: true, files: 2 });
        expect(elevate.verifyHelperFiles({ payloadRoot: dir, nodePath: '/usr/bin/node' })).toMatchObject({ checked: true, ok: false, reason: 'NOT_IN_MANIFEST' });
    });

    const registerInput = (roots) => ({ kind: 'systemd', name: 'goobster', layout: 'standalone', codeRoot: roots.code, runtimeUser: 'goobster', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11', roots, mode: 'payload' });
    const rootsAt = (base) => ({ code: `${base}/code`, data: `${base}/data`, config: `${base}/config/config.json`, cache: `${base}/cache`, logs: `${base}/logs`, uploads: `${base}/data/web-uploads`, managerStore: `${base}/data/manager` });

    test('a platform module\'s transport() carries the request and reads the reply instead of a pipe; spawn is never used', async () => {
        const protocol = require('@goobster/manager/privileged/protocol');
        const seen = {};
        const spawn = jest.fn();
        const implementation = {
            ...linux,
            transport: async ({ plan, request, nodePath, helperPath, requestDir }) => {
                Object.assign(seen, { plan, request, nodePath, helperPath, requestDir });
                return { status: 0, signal: null, stdout: `${JSON.stringify(protocol.okReply('service.register', 'done', { active: 'running' }, ['sc.exe create -> 0']))}\n`, stderr: '' };
            }
        };
        const result = await elevate.runHelper({
            operation: 'service.register',
            input: registerInput(rootsAt('/srv/g')),
            implementation,
            spawn,
            elevation: { kind: 'root', prefix: [] },
            facts: { available: true },
            requestDir: '/srv/g/data/manager/requests',
            nodePath: '/srv/g/code/current/runtime/node.exe',
            helperPath: '/srv/g/code/current/app/apps/manager/privileged/helper.js'
        });
        expect(result).toMatchObject({ status: 'done', outcome: 'done', detail: { active: 'running' }, via: 'root' });
        expect(spawn).not.toHaveBeenCalled();
        expect(seen.plan).toEqual({ kind: 'root', prefix: [] });
        expect(JSON.parse(seen.request)).toMatchObject({ v: 1, operation: 'service.register', input: { runtimeUser: 'goobster' } });
        expect(seen).toMatchObject({ nodePath: '/srv/g/code/current/runtime/node.exe', requestDir: '/srv/g/data/manager/requests' });
    });

    test('a platform module\'s refusal() turns its elevation tool\'s "no" into a fallback; without one the sudo/pkexec rules apply', async () => {
        const noReply = { status: 1, signal: null, stdout: '', stderr: 'The operation was canceled by the user.' };
        const uac = { ...linux, transport: async () => noReply, refusal: ({ plan, stderr }) => (plan.kind === 'uac' && /canceled/.test(stderr) ? { reason: 'ELEVATION_DECLINED', detail: { prompt: 'uac' } } : null) };
        const declined = await elevate.runHelper({ operation: 'service.register', input: registerInput(rootsAt('/srv/g')), implementation: uac, elevation: { kind: 'uac', prefix: [] }, facts: { available: true } });
        expect(declined).toMatchObject({ status: 'fallback', reason: 'ELEVATION_DECLINED', detail: { via: 'uac', prompt: 'uac' } });
        const other = await elevate.runHelper({ operation: 'service.register', input: registerInput(rootsAt('/srv/g')), implementation: { ...uac, refusal: () => null }, elevation: { kind: 'uac', prefix: [] }, facts: { available: true } });
        expect(other).toMatchObject({ status: 'failed', code: 'HELPER_PROTOCOL' });
    });

    test('helper.js --request/--reply: the request is read from a file and the reply written to one, with no value on argv', () => {
        const childProcess = require('node:child_process');
        const protocol = require('@goobster/manager/privileged/protocol');
        const dir = scratch('transport');
        const requestFile = path.join(dir, 'service.register.request.json');
        const replyFile = path.join(dir, 'service.register.reply.json');
        // Unregistering a unit the sandbox does not hold is a noop: the helper answers without any system command.
        fs.writeFileSync(requestFile, `${protocol.buildRequest('service.unregister', { kind: 'systemd', name: 'goobster', registeredBy: 'installer', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11' })}\n`);
        const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'apps', 'manager', 'privileged', 'helper.js'), '--request', requestFile, '--reply', replyFile], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GOOBSTER_HELPER_SANDBOX: dir } });
        expect(result.stdout).toBe('');
        const reply = JSON.parse(fs.readFileSync(replyFile, 'utf8'));
        expect(reply).toMatchObject({ v: 1, ok: true, operation: 'service.unregister', outcome: 'noop' });
        expect(result.status).toBe(0);
        expect(fs.statSync(replyFile).mode & 0o777).toBe(0o600);
        expect(helper.parseArgs(['--request', '/a', '--reply', '/b'])).toEqual({ requestFile: '/a', replyFile: '/b' });
        expect(helper.parseArgs([])).toEqual({ requestFile: null, replyFile: null });
        expect(helper.readRequest(path.join(dir, 'missing.json'))).toBe('');
    });

    test('the helper\'s sandbox shape comes from the platform module', () => {
        const dir = scratch('sandbox');
        expect(helper.sandboxDeps({ GOOBSTER_HELPER_SANDBOX: dir })).toEqual(linux.sandboxDeps(dir));
        expect(helper.sandboxDeps({ GOOBSTER_HELPER_SANDBOX: dir }, { sandboxDeps: (root) => ({ sandbox: true, root }) })).toEqual({ sandbox: true, root: dir });
        expect(helper.sandboxDeps({})).toEqual({});
    });
});
