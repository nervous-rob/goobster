/**
 * The manager's own update (#342, documentation/manager_update.md "The handoff"): when the
 * manager runs from the payload an update replaces it leaves with exit code 76 and the OS
 * service brings it back on the new release, which finishes the update. These specs drive the
 * two halves in one process (the second half is `applier.resume()`, what a manager does at
 * start) and walk the crash matrix: before the flip, after the flip before the exit, after the
 * exit before verify, after verify before cutover, a watchdog that ran out, a rollback that
 * hands over again.
 */
const fs = require('node:fs');
const path = require('node:path');

const wiring = require('@goobster/manager/update/wiring');
const { EXIT_SELF_UPDATE } = require('@goobster/manager/update/apply');
const { createUpdateRuntime } = require('@goobster/manager/update/runtime');
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function world({ next = {}, deps = {}, child = {} } = {}) {
    const key = newKey(roots, 'trusted');
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0', ...next });
    const published = await publish(roots, key, second);
    const exits = [];
    const harness = await installBase({
        roots,
        key,
        base,
        sourceDir: published.dir,
        updateDeps: {
            runChild: fakeChild(child),
            runsFromPayload: true,
            osSupervised: true,
            exit: async (code) => { exits.push(code); },
            verifyTimeoutMs: 1500,
            watchdogMs: 60_000,
            ...deps
        }
    });
    await drive(harness, 'update.policy', { mode: 'apply' });
    fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ webapp: { enabled: true } }));
    const workers = await supervise(harness, { cleanups });
    await drive(harness, 'update.stage', {});
    return { key, base, second, harness, exits, applier: wiring.applier(harness.settings.storeDir), ...workers };
}

const update = (harness, name) => {
    const file = path.join(harness.settings.storeDir, 'update', `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
const currentVersion = (harness) => JSON.parse(fs.readFileSync(path.join(harness.code, 'current', 'payload-manifest.json'), 'utf8')).release.core;
const record = (harness) => harness.manager.store.readInstallation().doc;
const barrierOf = (harness) => require('@goobster/manager/maintenance/barrier').createBarrier({ settings: harness.settings, fs, now: () => new Date(), logger: console }).view();
const applyNow = (harness) => drive(harness, 'update.apply', {});

/** What the OS does after the exit: the workers come up under the new manager, which then resumes. */
async function restartLikeTheOs(w) {
    await w.supervisor.restartAll();
}

describe('the handoff', () => {
    test('exits with 76 after the flip and leaves everything for the new manager: barrier held, handoff and watchdog recorded', async () => {
        const w = await world();
        const { applied } = await applyNow(w.harness);
        expect(EXIT_SELF_UPDATE).toBe(76);
        expect(applied.result).toMatchObject({ outcome: 'handoff-pending', from: '2.4.0', to: '2.5.0' });
        expect(applied.result.handoff).toMatch(/exit code 76/);
        expect(currentVersion(w.harness)).toBe('2.5.0');
        expect(record(w.harness).release.version).toBe('2.4.0');
        expect(update(w.harness, 'handoff')).toMatchObject({ phase: 'pending', from: { version: '2.4.0' }, to: { version: '2.5.0' } });
        expect(update(w.harness, 'watchdog')).toMatchObject({ previousReleaseId: record(w.harness).release.releaseId });
        expect(barrierOf(w.harness)).toMatchObject({ active: true, phase: 'mutate' });
        const steps = Object.fromEntries(w.harness.manager.journal.read(applied.operation.id).record.progress.map(item => [item.name, item.status]));
        expect(steps).toMatchObject({ activate: 'done', handoff: 'done', verify: 'deferred', cutover: 'deferred', release: 'deferred' });

        await sleep(1500);
        expect(w.exits).toEqual([76]);
    });

    test('the new manager at start verifies, records the release and releases the barrier', async () => {
        const w = await world();
        await applyNow(w.harness);
        await restartLikeTheOs(w);
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'applied' });
        expect(out.downtimeMs).toBeGreaterThanOrEqual(0);
        expect(record(w.harness).release).toMatchObject({ version: '2.5.0' });
        expect(record(w.harness).release.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(barrierOf(w.harness).active).toBe(false);
        expect(update(w.harness, 'handoff')).toBeNull();
        expect(update(w.harness, 'watchdog')).toBeNull();
        expect(update(w.harness, 'last-apply')).toMatchObject({ outcome: 'applied', to: { version: '2.5.0' } });
        expect(await w.applier.resume()).toEqual({ resumed: false });
    });

    test('the runtime resumes at start through the same path', async () => {
        const w = await world();
        await applyNow(w.harness);
        await restartLikeTheOs(w);
        const runtime = createUpdateRuntime({ manager: w.harness.manager, settings: w.harness.settings, logger: { info() {}, warn() {}, error() {} } });
        expect(await runtime.resume()).toMatchObject({ resumed: true, outcome: 'applied' });
    });

    test('the audit log gets one entry for what the new manager finished, linked to the apply by operation id', async () => {
        const w = await world();
        const { applied } = await applyNow(w.harness);
        await restartLikeTheOs(w);
        await w.applier.resume();
        const entries = fs.readFileSync(path.join(w.harness.settings.storeDir, 'operations', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        const done = entries.filter(entry => entry.action === 'manager.update.handoff');
        expect(done).toHaveLength(1);
        expect(done[0].detail).toMatchObject({ operationRef: applied.operation.id });
        expect(done[0].outcome).toBe('applied');
    });
});

describe('without an OS supervisor', () => {
    test('the manager does not exit: HANDOFF_UNAVAILABLE with the command to run, and the update stays staged', async () => {
        const w = await world({ deps: { osSupervised: false } });
        const failure = await applyNow(w.harness).catch(error => error);
        expect(failure.code).toBe('HANDOFF_UNAVAILABLE');
        expect(failure.message).toMatch(/update apply/);
        expect(failure.details).toMatchObject({ exitCode: 76 });
        expect(currentVersion(w.harness)).toBe('2.4.0');
        expect(update(w.harness, 'staged')).not.toBeNull();
        expect(barrierOf(w.harness).active).toBe(false);
        await sleep(1400);
        expect(w.exits).toEqual([]);
    });

    test('offline (no exit handler, no supervisor): the flip happens and the next manager start finishes it', async () => {
        const key = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
        const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0' });
        const published = await publish(roots, key, second);
        const harness = await installBase({ roots, key, base, sourceDir: published.dir, updateDeps: { runChild: fakeChild(), runsFromPayload: true, osSupervised: false, watchdogMs: 60_000 } });
        await drive(harness, 'update.policy', { mode: 'apply' });
        fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ webapp: { enabled: true } }));
        await drive(harness, 'update.stage', {});
        const { applied } = await applyNow(harness);
        expect(applied.result.outcome).toBe('handoff-pending');
        expect(applied.result.handoff).toMatch(/next starts/);
        expect(currentVersion(harness)).toBe('2.5.0');
        const out = await wiring.applier(harness.settings.storeDir).resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'applied' });
        expect(record(harness).release.version).toBe('2.5.0');
        expect(barrierOf(harness).active).toBe(false);
    });
});

describe('the crash matrix', () => {
    test('before the flip: the old release is still current, so the update is abandoned and the barrier lifted', async () => {
        const w = await world();
        await applyNow(w.harness);
        const code = w.harness.code;
        fs.renameSync(path.join(code, 'current'), path.join(code, 'aside'));
        fs.renameSync(path.join(code, 'previous'), path.join(code, 'current'));
        const handoff = update(w.harness, 'handoff');
        fs.writeFileSync(path.join(w.harness.settings.storeDir, 'update', 'handoff.json'), JSON.stringify({ ...handoff, phase: 'activating' }));
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'abandoned', code: 'FLIP_NOT_REACHED' });
        expect(currentVersion(w.harness)).toBe('2.4.0');
        expect(barrierOf(w.harness).active).toBe(false);
        expect(update(w.harness, 'handoff')).toBeNull();
        expect(update(w.harness, 'last-apply')).toMatchObject({ outcome: 'abandoned' });
    });

    test('after the flip, before the exit: the same state as a clean exit, so the next start finishes it', async () => {
        const w = await world({ deps: { exit: null } });
        await applyNow(w.harness).catch(() => null);
        expect(update(w.harness, 'handoff')).toMatchObject({ phase: 'pending' });
        await restartLikeTheOs(w);
        expect(await w.applier.resume()).toMatchObject({ resumed: true, outcome: 'applied' });
    });

    test('after the exit, before verify: the new release never comes up, the watchdog runs out, the previous release comes back', async () => {
        const w = await world({ deps: { watchdogMs: 1 } });
        await applyNow(w.harness);
        await sleep(20);
        expect(update(w.harness, 'watchdog')).not.toBeNull();
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'rolling_back', code: 'WATCHDOG_EXPIRED' });
        expect(currentVersion(w.harness)).toBe('2.4.0');
        expect(update(w.harness, 'handoff')).toMatchObject({ phase: 'rollback' });
        const finished = await w.applier.resume();
        expect(finished).toMatchObject({ resumed: true, outcome: 'rolled_back', code: 'WATCHDOG_EXPIRED' });
        expect(record(w.harness).release.version).toBe('2.4.0');
        expect(barrierOf(w.harness).active).toBe(false);
        expect(w.fakes.alive().length).toBe(w.names.length);
    });

    test('an expired watchdog on a schema-changing update whose workers already ran goes to recovery, not to a rollback', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] }, deps: { watchdogMs: 1 } });
        await applyNow(w.harness);
        await sleep(20);
        const handoff = update(w.harness, 'handoff');
        fs.writeFileSync(path.join(w.harness.settings.storeDir, 'update', 'handoff.json'), JSON.stringify({ ...handoff, attempts: 1 }));
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'recovery', code: 'SCHEMA_CHANGED_DATABASE_IN_USE' });
        expect(currentVersion(w.harness)).toBe('2.5.0');
        expect(barrierOf(w.harness).active).toBe(true);
        expect(update(w.harness, 'recovery')).toMatchObject({ backup: { name: expect.any(String) } });
        expect(await w.applier.resume()).toMatchObject({ resumed: true, outcome: 'recovery' });
        const entries = fs.readFileSync(path.join(w.harness.settings.storeDir, 'operations', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        const recorded = entries.filter(entry => entry.action === 'manager.update.handoff' && entry.outcome === 'recovery');
        expect(recorded.length).toBeGreaterThan(0);
        for (const entry of recorded) expect(entry.detail).not.toHaveProperty('downtimeMs');
    });

    test('an expired watchdog on the first schema-changing handoff cannot establish a safe rollback', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] }, deps: { watchdogMs: 1 } });
        await applyNow(w.harness);
        await sleep(20);
        expect(await w.applier.resume()).toMatchObject({ resumed: true, outcome: 'recovery', cause: 'WATCHDOG_EXPIRED' });
        expect(currentVersion(w.harness)).toBe('2.5.0');
        expect(barrierOf(w.harness).active).toBe(true);
        expect(await w.applier.resume()).toMatchObject({ resumed: true, outcome: 'recovery' });
    });

    test('after verify, before cutover: the next start records the release and releases', async () => {
        const w = await world();
        await applyNow(w.harness);
        await restartLikeTheOs(w);
        const handoff = update(w.harness, 'handoff');
        fs.writeFileSync(path.join(w.harness.settings.storeDir, 'update', 'handoff.json'), JSON.stringify({ ...handoff, phase: 'verified', reached: true }));
        expect(await w.applier.resume()).toMatchObject({ resumed: true, outcome: 'applied' });
        expect(record(w.harness).release.version).toBe('2.5.0');
        expect(barrierOf(w.harness).active).toBe(false);
    });

    test('after cutover, before the release: the next start only lifts the barrier', async () => {
        const w = await world();
        await applyNow(w.harness);
        await restartLikeTheOs(w);
        await w.applier.verifyPhase(update(w.harness, 'handoff'), { restart: false });
        w.applier.cutoverPhase(update(w.harness, 'handoff'));
        expect(update(w.harness, 'handoff').phase).toBe('recorded');
        expect(barrierOf(w.harness)).toMatchObject({ active: true, phase: 'cutover' });
        expect(await w.applier.resume()).toMatchObject({ resumed: true, outcome: 'applied' });
        expect(barrierOf(w.harness).active).toBe(false);
    });

    test('a new release that fails verify is rolled back by handing over again, and the old manager finishes the rollback', async () => {
        const w = await world();
        await applyNow(w.harness);
        await sleep(1400);
        for (const name of w.names) w.fakes.behave(name, { healthy: false });
        await restartLikeTheOs(w).catch(() => null);
        w.exits.length = 0;
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'rolling_back' });
        expect(currentVersion(w.harness)).toBe('2.4.0');
        expect(update(w.harness, 'handoff')).toMatchObject({ phase: 'rollback' });
        expect(barrierOf(w.harness).active).toBe(true);
        await sleep(1500);
        expect(w.exits).toEqual([76]);

        const finished = await w.applier.resume();
        expect(finished).toMatchObject({ resumed: true, outcome: 'rolled_back' });
        expect(barrierOf(w.harness).active).toBe(false);
        expect(record(w.harness).release.version).toBe('2.4.0');
        expect(update(w.harness, 'last-apply')).toMatchObject({ outcome: 'rolled_back' });
    });

    test('the manager that comes back watches the settle window: a worker that leaves inside it sends a schema-changing update to recovery', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] }, deps: { settleMs: 400 } });
        await applyNow(w.harness);
        w.fakes.behave(w.names[0], { exitAfterMs: 120, exitCode: 9 });
        await restartLikeTheOs(w);
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'recovery', code: 'SCHEMA_CHANGED_DATABASE_IN_USE', cause: 'EXITED_AFTER_READY' });
        expect(barrierOf(w.harness).active).toBe(true);
        expect(currentVersion(w.harness)).toBe('2.5.0');
        expect(update(w.harness, 'recovery')).toMatchObject({ cause: 'EXITED_AFTER_READY', backup: { name: expect.any(String) } });
        expect(update(w.harness, 'handoff')).toMatchObject({ phase: 'recovery' });
        expect(update(w.harness, 'last-apply')).toBeNull();
    });

    test('the same exit on a release that does not change the schema hands over again and is rolled back with EXITED_AFTER_READY', async () => {
        const w = await world({ deps: { settleMs: 400 } });
        await applyNow(w.harness);
        w.fakes.behave(w.names[0], { exitAfterMs: 120, exitCode: 9 });
        await restartLikeTheOs(w);
        w.exits.length = 0;
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'rolling_back', code: 'EXITED_AFTER_READY' });
        expect(currentVersion(w.harness)).toBe('2.4.0');
        const finished = await w.applier.resume();
        expect(finished).toMatchObject({ resumed: true, outcome: 'rolled_back', code: 'EXITED_AFTER_READY' });
        expect(update(w.harness, 'last-apply')).toMatchObject({ outcome: 'rolled_back', code: 'EXITED_AFTER_READY' });
        expect(barrierOf(w.harness).active).toBe(false);
    });

    test('a quiet window ends in applied, and its length is inside the downtime', async () => {
        const w = await world({ deps: { settleMs: 300 } });
        await applyNow(w.harness);
        await restartLikeTheOs(w);
        const out = await w.applier.resume();
        expect(out).toMatchObject({ resumed: true, outcome: 'applied' });
        expect(out.downtimeMs).toBeGreaterThanOrEqual(300);
        expect(update(w.harness, 'last-apply').downtimeMs).toBeGreaterThanOrEqual(300);
    });

    test('nothing pending is nothing to do, and a stale watchdog is cleared', async () => {
        const w = await world();
        fs.mkdirSync(path.join(w.harness.settings.storeDir, 'update'), { recursive: true });
        fs.writeFileSync(path.join(w.harness.settings.storeDir, 'update', 'watchdog.json'), JSON.stringify({ deadline: new Date().toISOString() }));
        expect(await w.applier.resume()).toEqual({ resumed: false });
        expect(update(w.harness, 'watchdog')).toBeNull();
    });
});
