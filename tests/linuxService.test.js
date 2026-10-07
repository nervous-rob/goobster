/**
 * The Linux service lifecycle (#333, documentation/linux_install.md): the
 * unit the installer renders, the ownership record, discovery reading it,
 * and the install steps that register, fall back to a manual manager, and
 * unregister. The privileged helper is replaced by a recording stub; the
 * helper itself is covered by privilegedHelper.test.js. systemd-analyze
 * checks the rendered unit when the binary exists on the machine running
 * the suite.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const unitText = require('@goobster/manager/platform/systemdUnit');
const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const rootsEnv = require('@goobster/manager/platform/rootsEnv');
const { discover } = require('@goobster/manager/install/discover');
const { makeRelease, newHarness, drive, codeOf, tempDir } = require('./helpers/installFixture');

const REPO = path.resolve(__dirname, '..');
const cleanup = [];
const scratch = (label) => tempDir(cleanup, label);

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const analyze = (() => {
    try {
        const probe = childProcess.spawnSync('systemd-analyze', ['--version'], { stdio: 'pipe' });
        return probe.status === 0;
    } catch {
        return false;
    }
})();
const analyzeTest = analyze ? test : test.skip;

describe('the rendered unit', () => {
    test('deploy/goobster.service is the renderer output for the documented Raspberry Pi paths', () => {
        const checkedIn = fs.readFileSync(path.join(REPO, 'deploy', 'goobster.service'), 'utf8');
        expect(checkedIn).toBe(unitText.renderReferenceUnit());
        expect(checkedIn).toContain('User=pi');
        expect(checkedIn).toContain('WorkingDirectory=/home/pi/goobster\n');
        expect(checkedIn).toContain('ExecStart="/usr/bin/node" "/home/pi/goobster/apps/manager/index.js" --supervise');
        expect(checkedIn).toContain('ProtectSystem=strict');
        expect(checkedIn).toContain('KillMode=mixed');
        expect(checkedIn).toContain('TimeoutStopSec=120');
        expect(checkedIn).toContain('# Legacy: run the bot directly');
        expect(checkedIn).not.toMatch(/^X-Goobster-Installation=/m);
    });

    const roots = (base) => ({
        code: path.join(base, 'code root'),
        data: path.join(base, 'state dir', 'data'),
        config: path.join(base, 'state dir', 'config', 'config.json'),
        cache: path.join(base, 'state dir', 'cache'),
        logs: path.join(base, 'state dir', 'logs'),
        uploads: path.join(base, 'state dir', 'data', 'web-uploads'),
        managerStore: path.join(base, 'state dir', 'data', 'manager')
    });
    const ID = '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11';

    test('a payload unit carries the installation marker, one ReadWritePaths per mutable root and quoted paths with spaces', () => {
        const base = '/opt/goobster test';
        const text = unitText.renderUnit({ name: 'goobster', installationId: ID, runtimeUser: 'goobster', codeRoot: roots(base).code, roots: roots(base), layout: 'standalone', mode: 'payload' });
        expect(text).toContain(`X-Goobster-Installation=${ID}`);
        expect(text).toContain('User=goobster');
        expect(text).toContain('WorkingDirectory=/opt/goobster test/code root\n');
        expect(text).toContain('ExecStart="/opt/goobster test/code root/current/runtime/bin/node" "/opt/goobster test/code root/current/app/apps/manager/index.js" --supervise');
        const writable = text.split('\n').filter(line => line.startsWith('ReadWritePaths=')).sort();
        expect(writable).toEqual([
            'ReadWritePaths="/opt/goobster test/state dir/cache"',
            'ReadWritePaths="/opt/goobster test/state dir/config"',
            'ReadWritePaths="/opt/goobster test/state dir/data"',
            'ReadWritePaths="/opt/goobster test/state dir/logs"'
        ]);
        expect(text).toContain('NoNewPrivileges=true');
        expect(text).toContain('PrivateTmp=true');
        expect(text).toContain('Restart=on-failure');
        expect(text).not.toMatch(/(token|secret|password)/i);
        expect(unitText.parseUnit(text)).toMatchObject({ installationId: ID, user: 'goobster' });
    });

    test('a path a unit cannot carry is refused rather than escaped', () => {
        for (const bad of ['/opt/a"b', '/opt/a b/$HOME', '/opt/a%b', '/opt/a\nb', 'relative/path', '/opt/a/../b']) {
            expect(() => unitText.assertSafePath(bad, 'a root')).toThrow();
        }
    });

    analyzeTest('systemd-analyze verify accepts the payload unit and the checkout unit (roots with spaces)', () => {
        const base = scratch('unit');
        const layout = roots(path.join(base, 'with space'));
        const node = path.join(layout.code, 'current', 'runtime', 'bin', 'node');
        fs.mkdirSync(path.dirname(node), { recursive: true });
        fs.copyFileSync(process.execPath, node);
        fs.chmodSync(node, 0o755);
        const entry = path.join(layout.code, 'current', 'app', 'apps', 'manager', 'index.js');
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(entry, '');
        const payloadUnit = path.join(base, 'goobster.service');
        fs.writeFileSync(payloadUnit, unitText.renderUnit({ name: 'goobster', installationId: ID, runtimeUser: 'goobster', codeRoot: layout.code, roots: layout, layout: 'standalone', mode: 'payload' }));

        const checkout = path.join(base, 'checkout');
        fs.mkdirSync(path.join(checkout, 'apps', 'manager'), { recursive: true });
        fs.writeFileSync(path.join(checkout, 'apps', 'manager', 'index.js'), '');
        const checkoutUnit = path.join(base, 'goobster-checkout.service');
        const checkoutRoots = { code: checkout, data: path.join(checkout, 'data'), config: path.join(checkout, 'config.json'), cache: path.join(checkout, 'cache'), logs: path.join(checkout, 'logs'), uploads: path.join(checkout, 'data', 'web-uploads'), managerStore: path.join(checkout, 'data', 'manager') };
        fs.writeFileSync(checkoutUnit, unitText.renderUnit({ name: 'goobster-checkout', installationId: ID, runtimeUser: 'goobster', codeRoot: checkout, roots: checkoutRoots, layout: 'lite', mode: 'checkout', nodePath: process.execPath }));

        for (const file of [payloadUnit, checkoutUnit]) {
            const result = childProcess.spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
            const complaints = `${result.stdout}${result.stderr}`.split('\n').filter(line => /bad unit file|fatal|not absolute|Unknown key|Unknown section|Invalid/i.test(line));
            expect(complaints).toEqual([]);
        }
    });
});

describe('the ownership record and discovery', () => {
    const entry = (store, installationId = '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11') => serviceRecord.recordRegistered(store, {
        kind: 'systemd', name: 'goobster', unitPath: '/etc/systemd/system/goobster.service', installationId
    }, { now: () => new Date('2026-01-02T03:04:05.000Z') });

    test('round trip: record, read, keep the first registration time on re-record, remove', () => {
        const store = scratch('record');
        expect(serviceRecord.readRecord(store)).toEqual({ present: false, problem: null, services: [] });
        entry(store);
        const first = serviceRecord.readRecord(store);
        expect(first.services).toEqual([{ kind: 'systemd', name: 'goobster', unitPath: '/etc/systemd/system/goobster.service', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11', registeredBy: 'installer', registeredAt: '2026-01-02T03:04:05.000Z' }]);
        serviceRecord.recordRegistered(store, { kind: 'systemd', name: 'goobster', unitPath: '/etc/systemd/system/goobster.service', installationId: '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11' }, { now: () => new Date('2027-01-01T00:00:00.000Z') });
        expect(serviceRecord.readRecord(store).services).toHaveLength(1);
        expect(serviceRecord.readRecord(store).services[0].registeredAt).toBe('2026-01-02T03:04:05.000Z');
        expect(serviceRecord.recordUnregistered(store, { kind: 'systemd', name: 'goobster' })).toBe(true);
        expect(serviceRecord.recordUnregistered(store, { kind: 'systemd', name: 'goobster' })).toBe(false);
        expect(fs.existsSync(serviceRecord.recordPath(store))).toBe(false);
    });

    test('a damaged or hand-edited record names nothing', () => {
        const store = scratch('record-bad');
        fs.writeFileSync(serviceRecord.recordPath(store), '{"version":1,"services":[{"kind":"systemd","name":"../evil","unitPath":"/x","installationId":"a","registeredBy":"installer","registeredAt":"now"}]}');
        expect(serviceRecord.readRecord(store).services).toEqual([]);
        fs.writeFileSync(serviceRecord.recordPath(store), 'not json');
        expect(serviceRecord.readRecord(store)).toMatchObject({ present: true, problem: 'SERVICES_RECORD_INVALID', services: [] });
    });

    test('discover reports registeredBy "installer" for a unit the record names, and the roots the env file states', () => {
        const home = scratch('home');
        const code = path.join(home, 'goobster');
        fs.mkdirSync(path.join(code, 'current'), { recursive: true });
        fs.writeFileSync(path.join(code, 'current', 'payload-manifest.json'), '{}');
        entry(path.join(code, 'data', 'manager'));
        const found = discover({ home, env: {}, exec: () => null });
        const candidate = found.candidates.find(item => item.roots.code === code);
        expect(candidate).toBeDefined();
        expect(candidate.evidence).toContain('INSTALLER_SERVICE_RECORD');
        expect(candidate.services).toEqual([{ kind: 'systemd', name: 'goobster', registeredBy: 'installer' }]);

        const elsewhere = scratch('store-elsewhere');
        entry(elsewhere);
        fs.rmSync(path.join(code, 'data'), { recursive: true, force: true });
        rootsEnv.writeRootsEnv({ roots: { code, data: path.join(elsewhere, 'data'), config: path.join(elsewhere, 'config.json'), cache: path.join(elsewhere, 'cache'), logs: path.join(elsewhere, 'logs'), uploads: path.join(elsewhere, 'data', 'web-uploads'), managerStore: elsewhere }, layout: 'standalone', mode: 'payload' });
        const again = discover({ home, env: {}, exec: () => null }).candidates.find(item => item.roots.code === code);
        expect(again.services).toEqual([{ kind: 'systemd', name: 'goobster', registeredBy: 'installer' }]);
    });

    test('the same unit seen by systemd without a record stays registeredBy "system"', () => {
        const home = scratch('home-system');
        const code = path.join(home, 'goobster');
        fs.mkdirSync(path.join(code, 'current'), { recursive: true });
        fs.writeFileSync(path.join(code, 'current', 'payload-manifest.json'), '{}');
        const found = discover({ home, env: {}, exec: () => null });
        const candidate = found.candidates.find(item => item.roots.code === code);
        expect(candidate.services.every(item => item.registeredBy !== 'installer')).toBe(true);
    });
});

describe('the roots environment file', () => {
    test('is plain GOOBSTER_ lines with paths only, rewritten only when it changes', () => {
        const code = path.join(scratch('env'), 'code root');
        const roots = { code, data: '/srv/g d/data', config: '/srv/g d/config/config.json', cache: '/srv/g d/cache', logs: '/srv/g d/logs', uploads: '/srv/g d/data/web-uploads', managerStore: '/srv/g d/data/manager' };
        expect(rootsEnv.writeRootsEnv({ roots, layout: 'standalone', mode: 'payload' }).written).toBe(true);
        expect(rootsEnv.writeRootsEnv({ roots, layout: 'standalone', mode: 'payload' }).written).toBe(false);
        const parsed = rootsEnv.readRootsEnv(code);
        expect(parsed).toMatchObject({ GOOBSTER_DATA_DIR: '/srv/g d/data', GOOBSTER_CONFIG_PATH: '/srv/g d/config/config.json', GOOBSTER_MANAGER_STATE_DIR: '/srv/g d/data/manager' });
        expect(parsed.GOOBSTER_SUPERVISOR).toBeUndefined();
        expect(fs.statSync(rootsEnv.envFilePath(code)).mode & 0o777).toBe(0o644);
        expect(rootsEnv.removeRootsEnv(code)).toBeTruthy();
        expect(fs.existsSync(rootsEnv.envFilePath(code))).toBe(false);
    });
});

// -------------------------------------------------------- the install steps
function recordingRunner(replies = {}) {
    const calls = [];
    return {
        calls,
        isImplemented: () => true,
        async run(operation, input, options) {
            calls.push({ operation, input: JSON.parse(JSON.stringify(input)), options: Object.keys(options || {}) });
            const reply = replies[operation];
            const value = typeof reply === 'function' ? reply(calls.filter(call => call.operation === operation).length) : reply;
            return value || { status: 'done', outcome: 'applied', detail: {}, log: [] };
        }
    };
}

async function installWith(runner, { unitNames, extraInput = {}, harnessDeps = {} } = {}) {
    const root = scratch('svc');
    const release = makeRelease(scratch('svc-src'));
    const harness = await newHarness({ root, installDeps: { privileged: runner, ...(unitNames ? { unitNames } : { unitNames: () => [] }), ...harnessDeps } });
    const input = { source: release.dir, features: ['tavern'], release: { allowUnsigned: true }, ...extraInput };
    return { root, harness, input, release };
}

const auditRows = (harness) => {
    const file = path.join(harness.settings.storeDir, 'operations', 'audit.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};
const ledgerOf = (harness, applied) => Object.fromEntries(harness.manager.journal.read(applied.operation.id).record.progress.map(item => [item.name, item]));

describe('install.new registers the service through the privileged helper', () => {
    test('registers: the step is done, the record names the unit, and one names-only audit row is written', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'done', outcome: 'applied', detail: { active: 'active' }, log: ['systemctl enable --now goobster.service'] } });
        const { harness, input } = await installWith(runner);
        const { applied } = await drive(harness, 'install.new', input);
        expect(applied.operation.status).toBe('applied');
        expect(ledgerOf(harness, applied)['register-service'].status).toBe('done');

        const register = runner.calls.find(call => call.operation === 'service.register');
        expect(register.input).toMatchObject({ kind: 'systemd', name: 'goobster', codeRoot: harness.code, mode: 'payload' });
        expect(register.input.installationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(runner.calls.every(call => !call.options.includes('stdin'))).toBe(true);

        const record = serviceRecord.readRecord(harness.settings.storeDir);
        expect(record.services).toHaveLength(1);
        expect(record.services[0]).toMatchObject({ kind: 'systemd', name: 'goobster', registeredBy: 'installer', unitPath: '/etc/systemd/system/goobster.service' });
        expect(harness.manager.store.readInstallation().doc.owned.services).toEqual([{ kind: 'systemd', name: 'goobster', registeredBy: 'installer' }]);
        expect(rootsEnv.readRootsEnv(harness.code).GOOBSTER_DATA_DIR).toBe(harness.settings.dataDir);

        const rows = auditRows(harness).filter(row => row.action === 'manager.privileged.service.register');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'applied' });
        const text = JSON.stringify(rows[0]);
        expect(text).not.toContain(harness.code);
        expect(text).not.toContain('systemctl');
        expect(Object.keys(rows[0].detail || {}).every(key => /^[A-Za-z][A-Za-z0-9]*$/.test(key))).toBe(true);
    });

    test('systemd offline: the install completes, the step is skipped MANUAL_FALLBACK, the unit is written for the operator and the foreground command is exact', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'fallback', reason: 'SYSTEMD_NOT_INIT' } });
        const { harness, input } = await installWith(runner);
        const { applied } = await drive(harness, 'install.new', input);
        expect(applied.operation.status).toBe('applied');
        const step = ledgerOf(harness, applied)['register-service'];
        expect(step).toMatchObject({ status: 'skipped', code: 'MANUAL_FALLBACK' });

        const service = applied.result.service;
        expect(service).toMatchObject({ registered: false, fallback: true, reason: 'SYSTEMD_NOT_INIT' });
        expect(service.foreground).toBe(`${harness.code}/current/bin/goobster-manager --supervise`);
        expect(service.boot.join('\n')).toContain('systemctl enable --now goobster.service');
        const unitFile = path.join(harness.settings.storeDir, 'goobster.service');
        expect(fs.existsSync(unitFile)).toBe(true);
        const installationId = harness.manager.store.readInstallation().doc.installationId;
        expect(fs.readFileSync(unitFile, 'utf8')).toContain(`X-Goobster-Installation=${installationId}`);
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
        expect(harness.manager.store.readInstallation().doc.owned.services).toEqual([]);
        expect(rootsEnv.readRootsEnv(harness.code).GOOBSTER_WORKSPACE_ROOT).toBe(`${harness.code}/current/app`);
        expect(auditRows(harness).filter(row => row.action === 'manager.privileged.service.register')[0]).toMatchObject({ outcome: 'fallback' });
    });

    test('a path with spaces is quoted in the foreground command', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' } });
        const root = path.join(scratch('spaced'), 'with space');
        fs.mkdirSync(root, { recursive: true });
        const release = makeRelease(scratch('spaced-src'));
        const harness = await newHarness({ root, installDeps: { privileged: runner, unitNames: () => [] } });
        const { applied } = await drive(harness, 'install.new', { source: release.dir, features: ['tavern'], release: { allowUnsigned: true } });
        expect(applied.result.service.foreground).toBe(`'${harness.code}/current/bin/goobster-manager' --supervise`);
    });

    test('a refusing helper fails the step, takes the record back, and the same plan resumes to the same single entry', async () => {
        const runner = recordingRunner({
            'service.register': (n) => (n === 1
                ? { status: 'failed', code: 'SERVICE_FOREIGN', message: 'A unit with that name exists and is not this installation\'s.', log: [] }
                : { status: 'done', outcome: 'applied', detail: {}, log: [] })
        });
        const { harness, input } = await installWith(runner);
        const failure = await codeOf(drive(harness, 'install.new', input));
        expect(failure).toBe('SERVICE_FOREIGN');
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
        expect(harness.manager.store.readInstallation().doc.owned.services).toEqual([]);

        const { applied } = await drive(harness, 'install.new', input);
        expect(applied.operation.status).toBe('applied');
        expect(ledgerOf(harness, applied)['register-service'].status).toBe('done');
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toHaveLength(1);
        expect(harness.manager.store.readInstallation().doc.owned.services).toHaveLength(1);
        expect(runner.calls.filter(call => call.operation === 'service.register')).toHaveLength(2);
    });

    test('a helper killed half way keeps the record (the unit may exist); the resumed install finishes with one entry', async () => {
        const runner = recordingRunner({
            'service.register': (n) => (n === 1
                ? { status: 'failed', code: 'HELPER_PROTOCOL', message: 'The helper ended with status signal and no reply.', log: [] }
                : { status: 'done', outcome: 'noop', detail: {}, log: [] })
        });
        const { harness, input } = await installWith(runner);
        expect(await codeOf(drive(harness, 'install.new', input))).toBe('HELPER_PROTOCOL');
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toHaveLength(1);
        const { applied } = await drive(harness, 'install.new', input);
        expect(applied.operation.status).toBe('applied');
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toHaveLength(1);
        expect(harness.manager.store.readInstallation().doc.owned.services).toHaveLength(1);
    });

    test('a goobster unit already live for another installation blocks the plan (SERVICE_DUPLICATE) before anything is written', async () => {
        const runner = recordingRunner();
        const { harness, input } = await installWith(runner, { unitNames: () => ['goobster.service'] });
        const failure = await codeOf(drive(harness, 'install.new', input));
        expect(failure).toBe('PREFLIGHT_FAILED');
        const preview = await drive(harness, 'install.new', input, { apply: false }).catch(error => error);
        const text = JSON.stringify(preview.details || preview.planned || {});
        expect(text).toContain('SERVICE_DUPLICATE');
        expect(runner.calls).toEqual([]);
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
    });

    test('without registration requested nothing privileged runs and no unit is written', async () => {
        const runner = recordingRunner();
        const { harness, input } = await installWith(runner, { extraInput: { registerService: false } });
        const { applied } = await drive(harness, 'install.new', input);
        expect(ledgerOf(harness, applied)['register-service'].status).toBe('skipped');
        expect(runner.calls).toEqual([]);
        expect(fs.existsSync(path.join(harness.settings.storeDir, 'goobster.service'))).toBe(false);
    });
});

describe('uninstall removes only what the record names', () => {
    test('a registered service is unregistered through the helper by the recorded name, then the record and env file go', async () => {
        const runner = recordingRunner();
        const { harness, input } = await installWith(runner);
        await drive(harness, 'install.new', input);
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toHaveLength(1);

        const { applied } = await drive(harness, 'install.uninstall', { keepData: true });
        expect(applied.operation.status).toBe('applied');
        const unregister = runner.calls.find(call => call.operation === 'service.unregister');
        expect(unregister.input).toMatchObject({ kind: 'systemd', name: 'goobster', registeredBy: 'installer' });
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toEqual([]);
        expect(fs.existsSync(rootsEnv.envFilePath(harness.code))).toBe(false);
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(false);
        expect(fs.existsSync(harness.settings.sqlitePath)).toBe(true);
        expect(auditRows(harness).map(row => row.action)).toEqual(expect.arrayContaining(['manager.privileged.service.register', 'manager.privileged.service.unregister']));
    });

    test('when elevation is refused the uninstall stops with ELEVATION_REQUIRED and keeps the record, so nothing is orphaned', async () => {
        const runner = recordingRunner({ 'service.unregister': { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' } });
        const { harness, input } = await installWith(runner);
        await drive(harness, 'install.new', input);
        const failure = await codeOf(drive(harness, 'install.uninstall', { keepData: true }));
        expect(failure).toBe('ELEVATION_REQUIRED');
        expect(serviceRecord.readRecord(harness.settings.storeDir).services).toHaveLength(1);
        expect(fs.existsSync(path.join(harness.code, 'current'))).toBe(true);
    });

    test('a manual-fallback install has nothing registered: no helper call, and the roots env file is still removed', async () => {
        const runner = recordingRunner({ 'service.register': { status: 'fallback', reason: 'SYSTEMD_NOT_INIT' } });
        const { harness, input } = await installWith(runner);
        await drive(harness, 'install.new', input);
        runner.calls.length = 0;
        const { applied } = await drive(harness, 'install.uninstall', { keepData: true });
        expect(applied.operation.status).toBe('applied');
        expect(runner.calls.filter(call => call.operation === 'service.unregister')).toEqual([]);
        expect(fs.existsSync(rootsEnv.envFilePath(harness.code))).toBe(false);
    });
});
