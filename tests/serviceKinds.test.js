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
        installedPath: (name) => `/ProgramData/Goobster/${name}.xml`,
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
        expect(record.services).toEqual([expect.objectContaining({ kind: 'windows-service', name: 'goobster', unitPath: '/ProgramData/Goobster/goobster.xml', registeredBy: 'installer' })]);
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

    test('the helper\'s sandbox shape comes from the platform module', () => {
        const dir = scratch('sandbox');
        expect(helper.sandboxDeps({ GOOBSTER_HELPER_SANDBOX: dir })).toEqual(linux.sandboxDeps(dir));
        expect(helper.sandboxDeps({ GOOBSTER_HELPER_SANDBOX: dir }, { sandboxDeps: (root) => ({ sandbox: true, root }) })).toEqual({ sandbox: true, root: dir });
        expect(helper.sandboxDeps({})).toEqual({});
    });
});
