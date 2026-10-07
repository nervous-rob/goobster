/**
 * The Windows service kind and its definition: the WinSW XML the installer
 * registers (apps/manager/platform/windowsServiceXml.js), the kind
 * definition the install steps read (windowsService.js), and the pin of the
 * service host. Pure text and registry shape; the elevated helper that acts
 * on it is tests/windowsHelper.test.js.
 */
const fs = require('node:fs');
const path = require('node:path');

const xml = require('@goobster/manager/platform/windowsServiceXml');
const windowsService = require('@goobster/manager/platform/windowsService');
const serviceKinds = require('@goobster/manager/platform/serviceKinds');
const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const unitText = require('@goobster/manager/platform/systemdUnit');
const protocol = require('@goobster/manager/privileged/protocol');
const { makeRelease, newHarness, drive, tempDir } = require('./helpers/installFixture');

const ID = '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11';
const roots = (base = 'C:\\Goobster') => ({
    code: `${base}\\code`,
    data: `${base}\\data`,
    config: `${base}\\config\\config.json`,
    cache: `${base}\\cache`,
    logs: `${base}\\logs`,
    uploads: `${base}\\data\\web-uploads`,
    managerStore: `${base}\\data\\manager`
});
const params = (over = {}) => ({ name: 'goobster', installationId: ID, runtimeUser: 'goobster', codeRoot: 'C:\\Goobster\\code', roots: roots(), layout: 'standalone', mode: 'payload', ...over });

const cleanup = [];
afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the service definition', () => {
    const text = xml.renderXml(params());

    test('the marker is the first line, and the definition names this installation', () => {
        expect(text.split('\n')[0]).toBe(`<!-- X-Goobster-Installation: ${ID} -->`);
        expect(text).toContain(`<description>Goobster Discord bot, installation ${ID}</description>`);
        expect(xml.parseDefinition(text)).toEqual({ installationId: ID, executable: 'C:\\Goobster\\code\\current\\runtime\\node.exe', serviceId: 'goobster' });
    });

    test('runs the bundled Node on the manager in supervise mode, from the code root, with automatic start', () => {
        expect(text).toContain('<id>goobster</id>');
        expect(text).toContain('<executable>C:\\Goobster\\code\\current\\runtime\\node.exe</executable>');
        expect(text).toContain('<arguments>"C:\\Goobster\\code\\current\\app\\apps\\manager\\index.js" --supervise</arguments>');
        expect(text).toContain('<workingdirectory>C:\\Goobster\\code</workingdirectory>');
        expect(text).toContain('<startmode>Automatic</startmode>');
        expect(text).toContain('<serviceaccount>\n        <domain>NT SERVICE</domain>\n        <user>goobster</user>\n    </serviceaccount>');
    });

    test('restarts after a failure in ten seconds and has a bounded, graceful stop', () => {
        expect(text).toContain('<onfailure action="restart" delay="10 sec"/>');
        expect(text).toContain('<stoptimeout>120 sec</stoptimeout>');
        expect(text).toContain('<stopparentprocessfirst>true</stopparentprocessfirst>');
        expect(text).toContain('<hidewindow>true</hidewindow>');
        expect(text).not.toContain('<stoparguments>');
    });

    test('logs roll into the installation\'s logs root', () => {
        expect(text).toContain('<logpath>C:\\Goobster\\logs</logpath>');
        expect(text).toContain('<log mode="roll"/>');
    });

    test('carries the same GOOBSTER_* roots as the systemd unit, with Windows paths and its own supervisor name', () => {
        const env = Object.fromEntries(xml.serviceEnvironment({ roots: roots(), layout: 'standalone' }));
        const systemd = Object.fromEntries(unitText.serviceEnvironment({ roots: { code: '/o', data: '/d', config: '/c/config.json', cache: '/ca', logs: '/l', uploads: '/u', managerStore: '/m' }, layout: 'standalone', mode: 'payload' }));
        expect(Object.keys(env).sort()).toEqual(Object.keys(systemd).filter(name => name !== 'XDG_CACHE_HOME').sort());
        expect(env).toMatchObject({
            GOOBSTER_SUPERVISOR: 'windows-service',
            GOOBSTER_RUNTIME_MODE: 'standalone',
            GOOBSTER_WORKSPACE_ROOT: 'C:\\Goobster\\code\\current\\app',
            GOOBSTER_DATA_DIR: 'C:\\Goobster\\data',
            GOOBSTER_CONFIG_PATH: 'C:\\Goobster\\config\\config.json',
            GOOBSTER_CACHE_DIR: 'C:\\Goobster\\cache',
            GOOBSTER_LOG_DIR: 'C:\\Goobster\\logs',
            GOOBSTER_MANAGER_STATE_DIR: 'C:\\Goobster\\data\\manager',
            NODE_ENV: 'production'
        });
        for (const [name, value] of Object.entries(env)) expect(text).toContain(`<env name="${name}" value="${value}"/>`);
    });

    test('holds no secret, URL or password and no expandable %VAR%', () => {
        expect(text).not.toMatch(/password|token|secret|https?:|%/i);
        expect(text).not.toContain('<stoppassword');
    });

    test('is deterministic and survives spaces, non-ASCII letters and ampersands in the roots', () => {
        expect(xml.renderXml(params())).toBe(text);
        const odd = roots('D:\\Goobster & Söhne');
        const rendered = xml.renderXml(params({ codeRoot: odd.code, roots: odd }));
        expect(rendered).toContain('<executable>D:\\Goobster &amp; Söhne\\code\\current\\runtime\\node.exe</executable>');
        expect(rendered).toContain('<env name="GOOBSTER_DATA_DIR" value="D:\\Goobster &amp; Söhne\\data"/>');
        expect(xml.parseDefinition(rendered).executable).toBe('D:\\Goobster & Söhne\\code\\current\\runtime\\node.exe');
    });

    test('the hand-copied definition (no installation id) has no marker', () => {
        const bare = xml.renderXml(params({ installationId: null }));
        expect(bare).not.toContain('X-Goobster-Installation');
        expect(xml.parseDefinition(bare).installationId).toBeNull();
    });

    test('refuses what a service definition must not carry', () => {
        const bad = (over) => expect(() => xml.renderXml(params(over))).toThrow();
        bad({ installationId: 'not-a-uuid' });
        bad({ name: 'other' });
        bad({ runtimeUser: 'alice' });
        bad({ codeRoot: 'relative\\code' });
        bad({ codeRoot: '\\\\server\\share\\code' });
        bad({ codeRoot: 'C:\\Goobster\\%APPDATA%\\code' });
        bad({ codeRoot: 'C:\\Goobster\\a"b' });
        bad({ codeRoot: 'C:\\Goobster\\..\\x' });
        bad({ codeRoot: 'C:\\Goobster\\code\\' });
        bad({ roots: { ...roots(), logs: 'C:\\Goobster\\<logs>' } });
        bad({ layout: 'lite; calc' });
    });

    test('parseDefinition tolerates a byte-order mark and Windows line endings, and reads nothing from another marker spelling', () => {
        expect(xml.parseDefinition(`\uFEFF${text.replace(/\n/g, '\r\n')}`).installationId).toBe(ID);
        expect(xml.parseDefinition('<service><id>goobster</id></service>')).toEqual({ installationId: null, executable: null, serviceId: 'goobster' });
        expect(xml.parseDefinition('<!-- X-Goobster-Installation: nope -->').installationId).toBeNull();
        expect(xml.parseDefinition('').installationId).toBeNull();
    });

    test('the access paths: the mutable roots without repeats, the code root never among them', () => {
        expect(xml.mutablePaths({ roots: roots() })).toEqual(['C:\\Goobster\\data', 'C:\\Goobster\\logs', 'C:\\Goobster\\cache', 'C:\\Goobster\\config']);
        const inside = { ...roots(), config: 'C:\\Goobster\\code\\config.json' };
        const paths = xml.mutablePaths({ roots: inside });
        expect(paths).toContain('C:\\Goobster\\code\\config.json');
        expect(paths).not.toContain('C:\\Goobster\\code');
        expect(xml.servicePaths(roots())).toEqual({ dir: 'C:\\Goobster\\data\\manager\\service', exe: 'C:\\Goobster\\data\\manager\\service\\goobster-service.exe', xml: 'C:\\Goobster\\data\\manager\\service\\goobster-service.xml' });
    });
});

describe('the service host pin', () => {
    test('the helper\'s constant is the pin in scripts/bootstrap-pins.json', () => {
        const pins = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'bootstrap-pins.json'), 'utf8'));
        expect(pins.winsw).toMatchObject({ version: xml.WINSW.version, file: xml.WINSW.file, url: xml.WINSW.url, sha256: xml.WINSW.sha256 });
        expect(xml.WINSW.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(xml.WINSW.url).toBe(`https://github.com/winsw/winsw/releases/download/v${xml.WINSW.version}/${xml.WINSW.file}`);
        expect(xml.WINSW.version).toMatch(/^2\./);
    });
});

describe('the kind definition', () => {
    test('is complete, registered for win32, and recorded under the kind the service record knows', () => {
        expect(() => serviceKinds.assertDefinition(windowsService)).not.toThrow();
        expect(serviceKinds.forKind('windows-service')).toBe(windowsService);
        expect(serviceKinds.forPlatform('win32')).toBe(windowsService);
        expect(serviceRecord.KINDS).toContain('windows-service');
        expect(windowsService).toMatchObject({ kind: 'windows-service', platforms: ['win32'], serviceName: 'goobster', fallbackFileName: 'goobster-service.xml', statusCommand: 'sc.exe query goobster' });
        expect(windowsService.installedFileName('goobster')).toBe('goobster-service.xml');
        expect(windowsService.installedPath('goobster', { roots: roots() })).toBe(path.join(roots().managerStore, 'service', 'goobster-service.xml'));
    });

    test('the identity is the virtual account NT SERVICE\\goobster: nothing to create, one name accepted', () => {
        expect(windowsService.account.creatable).toBe(false);
        expect(windowsService.account.accepts('goobster')).toBe(true);
        for (const name of ['', 'alice', 'root', 'Goobster', 'NT SERVICE\\goobster', null, undefined]) expect(windowsService.account.accepts(name)).toBe(false);
        expect(windowsService.account.defaultFor({ invoking: 'alice' })).toBe('goobster');
        expect(windowsService.account.fallbackName).toBe('goobster');
    });

    test('render is the WinSW definition; the request bodies are the windows-service ones and pass the helper\'s validation', () => {
        expect(windowsService.render(params())).toBe(xml.renderXml(params()));
        const input = windowsService.registerInput({ ...params(), nodePath: 'C:\\ignored\\node.exe', invoking: 'alice', elevated: false });
        expect(input).toEqual({ kind: 'windows-service', name: 'goobster', layout: 'standalone', codeRoot: 'C:\\Goobster\\code', runtimeUser: 'goobster', installationId: ID, roots: roots(), mode: 'payload' });
        expect(protocol.validateInput('service.register', input)).toMatchObject({ kind: 'windows-service', scope: 'machine' });
        const out = windowsService.unregisterInput({ name: 'goobster', installationId: ID });
        expect(out).toEqual({ kind: 'windows-service', name: 'goobster', registeredBy: 'installer', installationId: ID });
        expect(protocol.validateInput('service.unregister', out)).toEqual(out);
    });

    test('the by-hand wording: a foreground wrapper line and the commands that register the saved definition from an administrator prompt', () => {
        const manual = windowsService.manualInstructions({ codeRoot: 'C:\\Goobster\\code', mode: 'payload', nodePath: 'C:\\x\\node.exe', unitFile: 'C:\\Goobster\\data\\manager\\goobster-service.xml' });
        expect(manual.foreground).toBe('"C:\\Goobster\\code\\goobster-manager.cmd" --supervise');
        expect(manual.unitFile).toBe('C:\\Goobster\\data\\manager\\goobster-service.xml');
        expect(manual.boot).toEqual([
            'mkdir "C:\\Goobster\\data\\manager\\service"',
            'copy "<path to WinSW.NET4.exe v2.12.0>" "C:\\Goobster\\data\\manager\\service\\goobster-service.exe"',
            'copy "C:\\Goobster\\data\\manager\\goobster-service.xml" "C:\\Goobster\\data\\manager\\service\\goobster-service.xml"',
            '"C:\\Goobster\\data\\manager\\service\\goobster-service.exe" install',
            '"C:\\Goobster\\data\\manager\\service\\goobster-service.exe" start'
        ]);
        expect(JSON.stringify(manual)).not.toMatch(/https?:/);
        expect(windowsService.removeByHand).toContain('sc.exe delete goobster');
    });
});

describe('the install steps with the real Windows kind', () => {
    const recordingRunner = (replies = {}) => {
        const calls = [];
        return {
            calls,
            isImplemented: () => true,
            async run(operation, input) {
                calls.push({ operation, input: JSON.parse(JSON.stringify(input)) });
                return replies[operation] || { status: 'done', outcome: 'applied', detail: {}, log: [] };
            }
        };
    };

    async function installOnWindows(runner, extraInput = {}) {
        const root = tempDir(cleanup, 'win-kind');
        const release = makeRelease(tempDir(cleanup, 'win-kind-src'));
        const harness = await newHarness({ root, installDeps: { privileged: runner, unitNames: () => [], platform: 'win32' } });
        const { applied } = await drive(harness, 'install.new', { source: release.dir, features: ['tavern'], release: { allowUnsigned: true }, ...extraInput });
        return { harness, applied };
    }

    test('register-service asks for the windows-service kind, creates no account, and records the definition in the manager store', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'done', outcome: 'done', detail: { active: 'running' }, log: [] } });
        const { harness, applied } = await installOnWindows(runner, { runtimeUser: 'goobster', createRuntimeUser: true });
        expect(applied.operation.status).toBe('applied');
        expect(runner.calls.map(call => call.operation)).toEqual(['service.register']);
        expect(runner.calls[0].input).toMatchObject({ kind: 'windows-service', name: 'goobster', runtimeUser: 'goobster', mode: 'payload' });
        expect(runner.calls[0].input).not.toHaveProperty('scope');
        const record = serviceRecord.readRecord(harness.settings.storeDir);
        expect(record.services).toEqual([expect.objectContaining({ kind: 'windows-service', name: 'goobster', registeredBy: 'installer', unitPath: windowsService.installedPath('goobster', { roots: harness.manager.store.readInstallation().doc.roots }) })]);
        expect(applied.result.service).toMatchObject({ registered: true, kind: 'windows-service', unit: 'goobster-service.xml', runtimeUser: 'goobster' });
    });

    test('an install with no runtime user given runs as the virtual account', async () => {
        const runner = recordingRunner();
        const { applied } = await installOnWindows(runner);
        expect(applied.operation.status).toBe('applied');
        expect(runner.calls[0].input.runtimeUser).toBe('goobster');
    });

    test('uninstall unregisters through the same kind, and names the by-hand removal when it cannot elevate', async () => {
        const runner = recordingRunner();
        const { harness } = await installOnWindows(runner);
        runner.calls.length = 0;
        const { applied } = await drive(harness, 'install.uninstall', { keepData: true });
        expect(applied.operation.status).toBe('applied');
        expect(runner.calls[0]).toMatchObject({ operation: 'service.unregister', input: { kind: 'windows-service', name: 'goobster', registeredBy: 'installer' } });

        const stuck = recordingRunner({ 'service.unregister': { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' } });
        const second = await installOnWindows(stuck);
        await expect(drive(second.harness, 'install.uninstall', { keepData: true })).rejects.toMatchObject({ code: 'ELEVATION_REQUIRED', message: expect.stringContaining('sc.exe delete goobster') });
    });
});
