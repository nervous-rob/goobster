/**
 * The service registration after an update (#342, documentation/manager_update.md, "The service
 * registration"): left alone unless the service template's hash changed, re-registered through
 * `service.register` when it did, never able to undo a verified update. A fake privileged runner
 * stands in for the helper, so nothing is registered with the machine.
 */
const fs = require('node:fs');
const path = require('node:path');

const serviceRecord = require('@goobster/manager/platform/serviceRecord');
const serviceKinds = require('@goobster/manager/platform/serviceKinds');
const { createServiceRefresh, hashOf } = require('@goobster/manager/update/serviceTemplate');
const { drive, tempDir } = require('./helpers/installFixture');
const { newKey, makePayload, publish, installBase, supervise, fakeChild } = require('./helpers/updateFixture');

const roots = [];
const cleanups = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const STALE = '0'.repeat(64);

/** Answers `done` while the installation is made; `behaviour` (set after that) is what later calls get. */
function fakeRunner(behaviour = {}) {
    const calls = [];
    const runner = {
        calls,
        behaviour: {},
        isImplemented: () => true,
        async run(operation, input) {
            calls.push({ operation, input });
            if (runner.behaviour.throws) throw new Error('helper exploded with /secret/path');
            return runner.behaviour.result || { status: 'done', outcome: 'applied', detail: { active: 'active' } };
        }
    };
    runner.after = behaviour;
    return runner;
}

async function world({ registered = 'stale', runner = fakeRunner(), apply = false } = {}) {
    const key = newKey(roots, 'trusted');
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0' });
    const published = await publish(roots, key, second);
    const definition = serviceKinds.forKind(serviceKinds.kindForPlatform(process.platform)) || serviceKinds.forKind('systemd');
    const harness = await installBase({ roots, key, base, sourceDir: published.dir, installDeps: { privileged: runner }, updateDeps: { runChild: fakeChild(), verifyTimeoutMs: 1500, watchdogMs: 60_000 } });
    // The install registered the service through the fake runner and recorded the template hash.
    const installed = serviceRecord.readRecord(harness.settings.storeDir).services.find(item => item.name === definition.serviceName);
    expect(installed.templateHash).toBe(hashOf(definition));
    expect(runner.calls.map(call => call.operation)).toEqual(['service.register']);
    runner.calls.length = 0;
    runner.behaviour = runner.after;
    const recordFile = serviceRecord.recordPath(harness.settings.storeDir);
    if (!registered) {
        serviceRecord.recordUnregistered(harness.settings.storeDir, { kind: definition.kind, name: definition.serviceName });
    } else if (registered === 'stale') {
        serviceRecord.recordTemplate(harness.settings.storeDir, { kind: definition.kind, name: definition.serviceName, templateHash: STALE });
    } else if (registered === 'unhashed') {
        const doc = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
        for (const item of doc.services) delete item.templateHash;
        fs.writeFileSync(recordFile, JSON.stringify(doc));
    }
    const entry = () => serviceRecord.readRecord(harness.settings.storeDir).services.find(item => item.name === definition.serviceName);
    const refresher = () => {
        const core = require('@goobster/manager/install/engine').createInstallCore({ settings: harness.settings, logger: { info() {}, warn() {}, error() {} } });
        return createServiceRefresh({ core, settings: harness.settings, store: harness.manager.store, journal: harness.manager.journal });
    };
    let workers = null;
    if (apply) {
        await drive(harness, 'update.policy', { mode: 'apply' });
        fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ webapp: { enabled: true } }));
        workers = await supervise(harness, { cleanups });
        await drive(harness, 'update.stage', {});
    }
    return { harness, definition, entry, refresher, workers, runner };
}

describe('the service template hash', () => {
    test('is stable for a kind and different between kinds', () => {
        const systemd = serviceKinds.forKind('systemd');
        expect(hashOf(systemd)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashOf(systemd)).toBe(hashOf(systemd));
        const others = ['launchd', 'windows-service'].map(kind => serviceKinds.forKind(kind)).filter(Boolean);
        for (const other of others) expect(hashOf(other)).not.toBe(hashOf(systemd));
    });
});

describe('refreshing the registration', () => {
    test('nothing registered, or a registration with no recorded hash, is left alone (the hash becomes the baseline)', async () => {
        const none = await world({ registered: null });
        expect(await none.refresher().refresh({})).toEqual({ template: 'unregistered' });
        const unknown = await world({ registered: 'unhashed' });
        expect(await unknown.refresher().refresh({})).toEqual({ template: 'baseline' });
        expect(unknown.entry().templateHash).toBe(hashOf(unknown.definition));
        expect(unknown.runner.calls).toEqual([]);
        expect(none.runner.calls).toEqual([]);
    });

    test('an unchanged template does not touch the helper', async () => {
        const w = await world({ registered: 'current' });
        expect(await w.refresher().refresh({})).toEqual({ template: 'unchanged' });
        expect(w.runner.calls).toEqual([]);
    });

    test('a changed template is re-registered through service.register and the new hash is recorded', async () => {
        const w = await world({ registered: 'stale' });
        const out = await w.refresher().refresh({ operationId: 'op-1', actor: 'local:cli', via: 'local' });
        expect(out).toEqual({ template: 'refreshed' });
        expect(w.runner.calls.map(call => call.operation)).toEqual(['service.register']);
        expect(w.entry().templateHash).toBe(hashOf(w.definition));
        expect(w.harness.manager.journal.readAudit().entries.some(item => item.action === 'manager.privileged.service.register')).toBe(true);
    });

    test('a machine that cannot take it, or a helper that fails, is reported and never throws; the old hash stays so the next update tries again', async () => {
        const manual = await world({ runner: fakeRunner({ result: { status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' } }) });
        expect(await manual.refresher().refresh({})).toMatchObject({ template: 'manual', code: 'ELEVATION_UNAVAILABLE' });
        const failed = await world({ runner: fakeRunner({ throws: true }) });
        const out = await failed.refresher().refresh({});
        expect(out.template).toBe('failed');
        expect(JSON.stringify(out)).not.toContain('/secret/path');
        for (const w of [manual, failed]) {
            expect(w.entry().templateHash).toBe(STALE);
        }
    });
});

describe('an update with a changed template', () => {
    test('is applied, and the registration is refreshed after the barrier is released, outside the downtime', async () => {
        const w = await world({ registered: 'stale', apply: true });
        const { applied } = await drive(w.harness, 'update.apply', {});
        expect(applied.result).toMatchObject({ outcome: 'applied', service: { template: 'refreshed' } });
        expect(w.runner.calls.map(call => call.operation)).toEqual(['service.register']);
        const last = JSON.parse(fs.readFileSync(path.join(w.harness.settings.storeDir, 'update', 'last-apply.json'), 'utf8'));
        expect(last).toMatchObject({ outcome: 'applied', service: { template: 'refreshed' } });
        expect(JSON.stringify(last)).not.toContain(w.harness.root);
    });

    test('a failing registration does not fail or roll back the update', async () => {
        const w = await world({ registered: 'stale', apply: true, runner: fakeRunner({ throws: true }) });
        const { applied } = await drive(w.harness, 'update.apply', {});
        expect(applied.operation.status).toBe('applied');
        expect(applied.result).toMatchObject({ outcome: 'applied', service: { template: 'failed' } });
        expect(w.harness.manager.store.readInstallation().doc.release.version).toBe('2.5.0');
    });

    test('an update with an unchanged template does not report a service result', async () => {
        const w = await world({ registered: 'current', apply: true });
        const { applied } = await drive(w.harness, 'update.apply', {});
        expect(applied.result.service).toBeUndefined();
        expect(w.runner.calls).toEqual([]);
    });
});
