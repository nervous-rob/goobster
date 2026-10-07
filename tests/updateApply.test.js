/**
 * `update.apply` (#342, documentation/manager_update.md): a staged release applied inside the
 * maintenance barrier against supervised fake workers - the required backup, the activation, the
 * restart and verification, the cutover that records the release, the compatible rollback, and
 * what a schema-changing failure leaves behind (the barrier held and a decision to take).
 */
const fs = require('node:fs');
const path = require('node:path');

const wiring = require('@goobster/manager/update/wiring');
const { drive, codeOf, snapshot, tempDir } = require('./helpers/installFixture');
const { newKey, makePayload, publish, installBase, supervise, fakeChild, waitFor } = require('./helpers/updateFixture');

const roots = [];
const cleanups = [];
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function world({ next = {}, child = {}, updateDeps = {}, stageIt = true } = {}) {
    const key = newKey(roots, 'trusted');
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0', ...next });
    const published = await publish(roots, key, second);
    const runChild = fakeChild(child);
    const harness = await installBase({
        roots,
        key,
        base,
        sourceDir: published.dir,
        updateDeps: { runChild, verifyTimeoutMs: 1500, watchdogMs: 60_000, ...updateDeps }
    });
    await drive(harness, 'update.policy', { mode: 'apply' });
    fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ token: 'tok-apply-secret-0123456789', webapp: { enabled: true } }));
    const workers = await supervise(harness, { cleanups });
    if (stageIt) await drive(harness, 'update.stage', {});
    return { key, base, second, published, harness, runChild, ...workers };
}

const update = (harness, name) => {
    const file = path.join(harness.settings.storeDir, 'update', `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const ledger = (harness, id) => Object.fromEntries(harness.manager.journal.read(id).record.progress.map(item => [item.name, item.status]));
const currentId = (harness) => JSON.parse(fs.readFileSync(path.join(harness.code, 'current', 'payload-manifest.json'), 'utf8')).release.core;
const record = (harness) => harness.manager.store.readInstallation().doc;
const barrierOf = (harness) => require('@goobster/manager/maintenance/barrier').createBarrier({ settings: harness.settings, fs, now: () => new Date(), logger: console }).view();
const apply = (harness, input = {}) => drive(harness, 'update.apply', input);

describe('update.apply, the manager and its workers in one process', () => {
    test('quiesces, takes a verified backup, activates, restarts, verifies, records the release and releases', async () => {
        const w = await world();
        const { harness } = w;
        const config = fs.readFileSync(path.join(harness.code, 'config.json'));
        const features = fs.existsSync(path.join(harness.settings.dataDir, 'features.json')) ? fs.readFileSync(path.join(harness.settings.dataDir, 'features.json')) : null;
        const before = record(harness);
        const { applied } = await apply(harness);

        expect(applied.operation.status).toBe('applied');
        expect(applied.result).toMatchObject({ outcome: 'applied', from: '2.4.0', to: '2.5.0', schemaChanging: false, backup: { verified: true } });
        expect(applied.result.downtimeMs).toBeGreaterThanOrEqual(0);
        expect(ledger(harness, applied.operation.id)).toMatchObject({
            preflight: 'done', maintenance: 'done', backup: 'done', activate: 'done', verify: 'done', cutover: 'done', release: 'done'
        });
        expect(ledger(harness, applied.operation.id).handoff).toBe('skipped');

        expect(currentId(harness)).toBe('2.5.0');
        expect(JSON.parse(fs.readFileSync(path.join(harness.code, 'previous', 'payload-manifest.json'), 'utf8')).release.core).toBe('2.4.0');
        const after = record(harness);
        expect(after.release).toMatchObject({ releaseId: w.second.releaseId, version: '2.5.0', features: before.release.features });
        expect(after.release.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(after.roots).toEqual(before.roots);
        expect(after.updater).toEqual(before.updater);
        expect(after.layout).toBe(before.layout);

        expect(fs.readFileSync(path.join(harness.code, 'config.json'))).toEqual(config);
        if (features) expect(fs.readFileSync(path.join(harness.settings.dataDir, 'features.json'))).toEqual(features);

        expect(w.runChild.calls.map(call => call.op)).toEqual(['probeTarget', 'backup']);
        expect(w.runChild.calls[1].input).toMatchObject({ includeConfig: false, quiesced: true });
        for (const name of w.names) expect(w.fakes.of(name).length).toBe(2);
        expect(barrierOf(harness).active).toBe(false);
        expect(update(harness, 'handoff')).toBeNull();
        expect(update(harness, 'watchdog')).toBeNull();
        expect(update(harness, 'staged')).toBeNull();
        expect(update(harness, 'last-apply')).toMatchObject({ outcome: 'applied', from: { version: '2.4.0' }, to: { version: '2.5.0' }, backup: { verified: true } });
        expect(update(harness, 'last-apply').downtimeMs).toBeGreaterThanOrEqual(0);
    });

    test('writes one audit entry and nothing in the operation, the audit log or the state files names a secret, path or address', async () => {
        const w = await world();
        const { harness } = w;
        const { applied } = await apply(harness);
        const audit = fs.readFileSync(path.join(harness.settings.storeDir, 'operations', 'audit.jsonl'), 'utf8');
        const entries = audit.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.action === 'manager.update.apply');
        expect(entries).toHaveLength(1);
        expect(entries[0].detail).toMatchObject({ outcome: 'applied', schemaChanging: false });
        const everything = [
            audit,
            JSON.stringify(harness.manager.journal.read(applied.operation.id).record),
            ...fs.readdirSync(path.join(harness.settings.storeDir, 'update')).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(harness.settings.storeDir, 'update', name), 'utf8'))
        ].join('\n');
        expect(everything).not.toContain('tok-apply-secret');
        expect(everything).not.toContain(harness.root);
        expect(everything).not.toContain(path.dirname(harness.root));
    });

    test('an unverified backup stops the update before anything changes, and the workers go back to work', async () => {
        const w = await world({ child: { verified: false } });
        const { harness } = w;
        const before = snapshot(path.join(harness.code, 'current'));
        expect(await codeOf(apply(harness))).toBe('BACKUP_UNVERIFIED');
        expect(snapshot(path.join(harness.code, 'current'))).toBe(before);
        expect(barrierOf(harness).active).toBe(false);
        expect(record(harness).release.version).toBe('2.4.0');
        expect(update(harness, 'staged')).not.toBeNull();
        expect(update(harness, 'handoff')).toBeNull();
        for (const name of w.names) expect(w.fakes.of(name).length).toBe(1);
        expect(w.responder.requests.some(request => request.type === 'resume')).toBe(true);
    });

    test('with no data in the database there is no backup to take and the step says so', async () => {
        const w = await world({ child: { hasData: false } });
        const { applied } = await apply(w.harness);
        expect(applied.result.outcome).toBe('applied');
        expect(ledger(w.harness, applied.operation.id).backup).toBe('skipped');
        expect(w.runChild.calls.map(call => call.op)).toEqual(['probeTarget']);
    });

    test('plans nothing when nothing is staged, when another updater owns the install, or while a decision is pending', async () => {
        const none = await world({ stageIt: false });
        expect(await codeOf(drive(none.harness, 'update.apply', {}))).toBe('NOTHING_STAGED');

        const timer = await world();
        timer.harness.manager.store.updateInstallation(draft => ({ ...draft, updater: { kind: 'auto-update.sh' } }));
        expect(await codeOf(drive(timer.harness, 'update.apply', {}))).toBe('UPDATER_NOT_MANAGER');
    });

    test('is a plan first: it names the backup, the rollback rule and the downtime, and changes nothing', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        const before = snapshot(path.join(w.harness.code, 'current'));
        const { planned } = await drive(w.harness, 'update.apply', {}, { apply: false });
        expect(planned.plan).toMatchObject({ from: { version: '2.4.0' }, to: { version: '2.5.0' }, schemaChanging: true, backup: { required: true, verified: true }, handoff: { mode: 'inline' } });
        expect(planned.plan.rollback).toMatch(/restore the backup/);
        expect(planned.plan.downtime).toMatch(/quiesced/);
        expect(planned.plan.steps.map(step => step.name)).toEqual(['preflight', 'maintenance', 'backup', 'activate', 'handoff', 'verify', 'cutover', 'release']);
        expect(snapshot(path.join(w.harness.code, 'current'))).toBe(before);
        expect(barrierOf(w.harness).active).toBe(false);
    });

    test('when "window" is asked outside the window it only schedules and changes nothing', async () => {
        const w = await world();
        const now = new Date();
        const hour = (now.getUTCHours() + 12) % 24;
        await drive(w.harness, 'update.policy', { window: { days: [0, 1, 2, 3, 4, 5, 6], startHour: hour, endHour: (hour + 1) % 24, tz: 'UTC' } });
        const { applied } = await drive(w.harness, 'update.apply', { when: 'window' });
        expect(applied.result).toEqual({ outcome: 'scheduled' });
        expect(update(w.harness, 'scheduled')).toMatchObject({ release: '2.5.0' });
        expect(currentId(w.harness)).toBe('2.4.0');
        expect(barrierOf(w.harness).active).toBe(false);
        expect(w.runChild.calls).toEqual([]);
    });
});

describe('a failure after the new release is active', () => {
    test('a release that never answers /health is rolled back automatically when the schema is unchanged', async () => {
        const w = await world();
        const { harness } = w;
        for (const name of w.names) w.fakes.behave(name, { healthy: false });
        const before = record(harness);
        const failure = await apply(harness).catch(error => error);
        expect(failure.code).toBe('UPDATE_ROLLED_BACK');
        expect(currentId(harness)).toBe('2.4.0');
        expect(record(harness)).toEqual(before);
        expect(barrierOf(harness).active).toBe(false);
        expect(update(harness, 'handoff')).toBeNull();
        expect(update(harness, 'recovery')).toBeNull();
        expect(update(harness, 'last-apply')).toMatchObject({ outcome: 'rolled_back', from: { version: '2.4.0' }, to: { version: '2.5.0' } });
        const alive = w.fakes.alive();
        expect(alive.length).toBe(w.names.length);
        expect(ledger(harness, failure.operation.id).verify).toBe('failed');
        await expect(drive(harness, 'update.stage', {})).resolves.toBeDefined();
    });

    test('a schema-changing release that fails before any worker got past /health is also rolled back', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        for (const name of w.names) w.fakes.behave(name, { healthy: false });
        const failure = await apply(w.harness).catch(error => error);
        expect(failure.code).toBe('UPDATE_ROLLED_BACK');
        expect(currentId(w.harness)).toBe('2.4.0');
        expect(barrierOf(w.harness).active).toBe(false);
    });

    test('a schema-changing release that got past /health and then failed holds the barrier and waits for a decision', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        const { harness } = w;
        for (const name of w.names) w.fakes.behave(name, { ack: false });
        const failure = await apply(harness).catch(error => error);
        expect(failure.code).toBe('UPDATE_RECOVERY_REQUIRED');

        expect(barrierOf(harness).active).toBe(true);
        expect(currentId(harness)).toBe('2.5.0');
        expect(record(harness).release.version).toBe('2.4.0');
        expect(update(harness, 'recovery')).toMatchObject({ code: 'SCHEMA_CHANGED_DATABASE_IN_USE', schemaChanging: true, backup: { name: expect.any(String) } });
        expect(update(harness, 'handoff')).toMatchObject({ phase: 'recovery' });

        expect(await codeOf(drive(harness, 'update.stage', {}))).toBe('RECOVERY_PENDING');
        expect(await codeOf(drive(harness, 'update.apply', {}))).toBe('RECOVERY_PENDING');

        const status = require('@goobster/manager/update/status');
        expect(status).toBeDefined();
        const applier = wiring.applier(harness.settings.storeDir);
        expect(applier.recoveryView()).toMatchObject({ decisions: ['restore', 'retry'], restored: false });
        expect(applier.recoveryView().warning).toMatch(/every write since then is lost/);
    });

    test('the decision "retry" starts the new release again and, when it verifies, finishes the update', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        const { harness } = w;
        for (const name of w.names) w.fakes.behave(name, { ack: false });
        await apply(harness).catch(() => null);
        expect(update(harness, 'recovery')).not.toBeNull();

        const decide = wiring.decider(harness.settings.storeDir);
        const out = await decide({ decision: 'retry', auth: { principal: 'local:cli', via: 'local' } });
        expect(out.result).toMatchObject({ outcome: 'applied' });
        expect(record(harness).release).toMatchObject({ version: '2.5.0' });
        expect(barrierOf(harness).active).toBe(false);
        expect(update(harness, 'recovery')).toBeNull();
        expect(update(harness, 'handoff')).toBeNull();
        expect(update(harness, 'last-apply')).toMatchObject({ outcome: 'applied', schemaChanging: true });
    });

    test('the decision "retry" that still fails keeps the barrier held and asks again', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        const { harness } = w;
        for (const name of w.names) w.fakes.behave(name, { ack: false });
        await apply(harness).catch(() => null);
        for (const name of w.names) w.fakes.behave(name, { ack: false });
        const decide = wiring.decider(harness.settings.storeDir);
        const failure = await decide({ decision: 'retry', auth: { principal: 'local:cli', via: 'local' } }).catch(error => error);
        expect(failure.code).toBe('UPDATE_RECOVERY_REQUIRED');
        expect(barrierOf(harness).active).toBe(true);
        expect(update(harness, 'recovery')).not.toBeNull();
    });

    test('the decision "restore" puts the previous release back, restores the pre-update backup inside the held barrier and verifies', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        const { harness } = w;
        for (const name of w.names) w.fakes.behave(name, { ack: false });
        await apply(harness).catch(() => null);
        const recovery = update(harness, 'recovery');

        const restoreCalls = [];
        const run = harness.manager.engine.run.bind(harness.manager.engine);
        harness.manager.engine.run = async (kind, input, auth) => {
            if (kind !== 'backup.restore') return run(kind, input, auth);
            restoreCalls.push({ input, currentWhenCalled: currentId(harness) });
            return { operation: { status: 'applied' } };
        };
        const decide = wiring.decider(harness.settings.storeDir);
        const out = await decide({ decision: 'restore', auth: { principal: 'local:cli', via: 'local' } });
        harness.manager.engine.run = run;

        expect(restoreCalls).toHaveLength(1);
        expect(restoreCalls[0].currentWhenCalled).toBe('2.4.0');
        expect(path.basename(restoreCalls[0].input.dir)).toBe(recovery.backup.name);
        expect(restoreCalls[0].input).toMatchObject({ confirm: record(harness).installationId, acceptSchemaChange: true, withoutConfig: true });
        expect(restoreCalls[0].input.maintenance.operationId).toBe(recovery.operationId);
        expect(out.result).toMatchObject({ outcome: 'rolled_back' });
        expect(currentId(harness)).toBe('2.4.0');
        expect(record(harness).release.version).toBe('2.4.0');
        expect(barrierOf(harness).active).toBe(false);
        expect(update(harness, 'recovery')).toBeNull();
        expect(update(harness, 'last-apply')).toMatchObject({ outcome: 'rolled_back', schemaChanging: true });
        expect(await waitFor(() => w.fakes.alive().length === w.names.length, { what: 'workers back' })).toBe(true);
    });

    test('"restore" needs a backup: an update that took none can only be retried', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] }, child: { hasData: false } });
        for (const name of w.names) w.fakes.behave(name, { ack: false });
        await apply(w.harness).catch(() => null);
        const decide = wiring.decider(w.harness.settings.storeDir);
        const failure = await decide({ decision: 'restore', auth: { principal: 'local:cli', via: 'local' } }).catch(error => error);
        expect(failure.code).toBe('NO_BACKUP');
    });

    test('a decision with nothing pending is refused', async () => {
        const w = await world();
        const decide = wiring.decider(w.harness.settings.storeDir);
        const failure = await decide({ decision: 'retry', auth: { principal: 'local:cli', via: 'local' } }).catch(error => error);
        expect(failure.code).toBe('NO_RECOVERY_PENDING');
    });
});
