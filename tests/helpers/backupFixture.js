/**
 * Fixtures for the backup and restore specs (#337): a claimed, managed
 * installation over caller-chosen data, config and database locations, with
 * fake writers that acknowledge the maintenance barrier, so `backup.create`
 * and `backup.restore` run end to end - the barrier entered by the
 * operation itself, or held by the caller.
 *
 * Nothing here opens the application database: a spec seeds it through the
 * facade (in process) or as a file (`createSeededSqlite`), and tells the
 * manager which runner to use (`inProcess: true` runs the helper operations
 * in this process, which a Postgres spec needs because a child does not
 * inherit the isolated schema).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { newHarness, drive, codeOf } = require('./installFixture');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./fakeWorkers');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore } = require('@goobster/manager/maintenance/store');
const { createInProcessRunner } = require('@goobster/manager/backup/ops');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');

const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const BRIDGE = { principal: 'owner-1', via: 'bridge' };
const LOCAL = { principal: 'local:cli', via: 'local' };

function startResponder({ fakes, settings, cleanups }) {
    const env = { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir };
    const seen = new Map();
    const timer = setInterval(() => {
        for (const name of ['api', 'bot', 'sandbox']) {
            const proc = fakes.last(name);
            if (!proc || proc.exit) continue;
            const control = coreLifecycle.readControl(name, { env });
            const request = control && control.request;
            if (!request || seen.get(name) === request.id) continue;
            seen.set(name, request.id);
            const state = request.type === 'resume' ? 'resumed' : (request.type === 'maintenance' ? 'fenced' : null);
            if (state) coreMaintenance.writeFenceAck({ worker: name, fence: request.fence, state, pid: proc.pid, env });
        }
    }, 5);
    timer.unref();
    cleanups.push(() => clearInterval(timer));
}

/**
 * @param {Object} params
 * @param {string} params.root scratch directory for the manager store and the code root
 * @param {string} params.dataDir
 * @param {string} params.configPath
 * @param {string} params.sqlitePath
 * @param {string} [params.dbUrl] set for a Postgres run
 * @param {boolean} [params.inProcess] run the helper operations in this process
 * @param {Array<Function>} params.cleanups
 * @param {Object} [params.env] more environment for the manager
 */
async function createBackupHarness({ root, dataDir, configPath, sqlitePath, dbUrl = null, inProcess = true, cleanups, env = {}, recordedEngine = null }) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify({ webapp: { enabled: true } }));
    const harness = await newHarness({
        root,
        env: {
            GOOBSTER_RUNTIME_MODE: 'standalone',
            GOOBSTER_DATA_DIR: dataDir,
            GOOBSTER_CONFIG_PATH: configPath,
            GOOBSTER_DB_PATH: sqlitePath,
            GOOBSTER_MANAGER_STATE_DIR: path.join(root, 'store'),
            ...(dbUrl ? { GOOBSTER_DB_URL: dbUrl } : {}),
            ...env
        }
    });
    const { settings, manager, code } = harness;
    manager.store.createInstallation({
        origin: 'install',
        ownerLabel: 'Rob',
        install: {
            layout: 'standalone',
            roots: {
                code,
                data: dataDir,
                config: path.dirname(configPath),
                cache: path.join(root, 'cache'),
                logs: path.join(root, 'logs'),
                uploads: path.join(dataDir, 'web-uploads'),
                managerStore: settings.storeDir
            },
            runtimeUser: null,
            owned: { files: [], services: [], dependencies: [] },
            updater: { kind: 'none' },
            release: null,
            database: { engine: dbUrl ? 'postgres' : 'sqlite', external: Boolean(dbUrl) }
        }
    });
    if (recordedEngine) {
        manager.store.updateInstallation(draft => ({ ...draft, database: { engine: recordedEngine, external: true } }));
    }

    tune(settings.storeDir, TUNING);
    const fakes = createFakeWorkers();
    const supervisor = createSupervisor({ manager, adapter: fakes.adapter, checkHealth: fakes.checkHealth, sandboxActive: () => false, logger: { info() {}, warn() {}, error() {} }, policy: { ...FAST_POLICY } });
    const unregister = registry.register(settings.storeDir, supervisor);
    await supervisor.start();
    await waitFor(async () => (await supervisor.status()).workers.every(worker => worker.ackedRevision === 0), { what: 'worker acks' });
    startResponder({ fakes, settings, cleanups });
    cleanups.push(async () => {
        tune(settings.storeDir, null);
        await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
    });

    const restarts = [];
    settings.backupDeps = {
        ...(inProcess ? { runChild: createInProcessRunner() } : {}),
        supervisor: { operatorRestart: () => { restarts.push('restart'); return { workers: ['api'] }; } }
    };

    const installationId = () => manager.store.readInstallation().doc.installationId;
    const barrierDoc = () => createMaintenanceStore({ storeDir: settings.storeDir }).read().doc;
    const enter = async (reason = 'restore') => (await manager.engine.run('maintenance.enter', { reason, timeoutSeconds: 10 }, BRIDGE)).result;
    const release = async (ref, extra = {}) => manager.engine.run('maintenance.release', { operationId: ref.operationId, fence: ref.fence, ...extra }, BRIDGE);
    const journalText = () => JSON.stringify(manager.journal.list()) + JSON.stringify(manager.journal.readAudit().entries);

    return {
        ...harness,
        fakes,
        supervisor,
        restarts,
        installationId,
        barrierDoc,
        enter,
        release,
        journalText,
        drive: (kind, input, options = {}) => drive(harness, kind, input, { auth: BRIDGE, ...options })
    };
}

module.exports = { createBackupHarness, BRIDGE, LOCAL, TUNING, drive, codeOf, waitFor };
