/**
 * The manager: state detection, the store, credentials, sessions, the
 * bridge verifier and the setup engine, assembled without the application
 * database, Discord, provider keys or any optional feature.
 *
 * States (documentation/manager.md):
 *   unclaimed  no installation.json and no evidence of an application
 *              installation: first-time setup with the bootstrap credential
 *   claimed    installation.json is usable; the app database may still be
 *              unreachable (reported, not fatal)
 *   recovery   installation.json is missing, damaged or unreadable while
 *              an installation exists (or the file itself exists): only the
 *              local recovery flow works, nothing is adopted automatically
 */

const nodeFs = require('node:fs');
const { createStore } = require('./store/installation');
const { createJournal } = require('./store/journal');
const { createLock } = require('./store/lock');
const { createOneTimeCredential } = require('./auth/credentials');
const { createSessionRegistry } = require('./auth/sessions');
const { createBridgeVerifier } = require('./auth/bridge');
const { createEngine } = require('./engine');
const { createFeaturesSetKind } = require('./engine/kinds/featuresSet');
const { createClaimKind, createAdoptKind, createRecoveryUnlockKind } = require('./engine/kinds/installation');
const { existingInstallEvidence, probeAppDatabase, DEFAULT_PROBE_TIMEOUT_MS } = require('./appDatabase');
const { reconcileAudit, pendingAuditCount } = require('./audit');
const { reconcileMigration } = require('./migration/reconcile');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { createMaintenanceStore, summarize: summarizeMaintenance, recoverOnStart } = require('./maintenance/store');
const privileged = require('./privileged');
const { readTombstone } = require('./install/tombstone');
const files = require('./store/files');
const updateWiring = require('./update/wiring');

const MANAGER_VERSION = 1;
const PROBE_TTL_MS = 10_000;
const STORE_REASONS = {
    missing: 'MANAGER_STORE_MISSING',
    corrupt: 'MANAGER_STORE_CORRUPT',
    unsupported: 'MANAGER_STORE_UNSUPPORTED',
    unreadable: 'MANAGER_STORE_UNREADABLE'
};

function readConfigJson(configPath, fs) {
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return { present: true, readable: files.isPlainObject(parsed), config: files.isPlainObject(parsed) ? parsed : {} };
    } catch (error) {
        return { present: !(error && error.code === 'ENOENT'), readable: false, config: {} };
    }
}

/**
 * @param {Object} params
 * @param {Object} params.settings resolveSettings() output
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 * @param {Object} [params.hooks] engine fault injection (tests)
 * @param {(pid: number) => boolean} [params.isProcessAlive]
 * @param {number} [params.probeTimeoutMs]
 * @param {Object} [params.logger]
 * @param {Object} [params.reconcileDeps] { loadDb, loadAudit } overrides for reconcileAudit
 * @param {Array<(deps: { settings: Object, fs: Object, now: () => Date, logger: Object }) => import('./engine').OperationKind[]>} [params.extraKinds]
 *   operation-kind families beyond the built-in four (one module each under
 *   ./engine/kinds/); a kind name registered twice is a startup error.
 */
function createManager({
    settings,
    fs = nodeFs,
    now = () => new Date(),
    hooks = {},
    isProcessAlive,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    logger = console,
    reconcileDeps = {},
    extraKinds = []
}) {
    const store = createStore({ root: settings.storeDir, fs, now });
    const initResult = store.init();
    const journal = createJournal({ store, fs, now });
    const lock = createLock({ store, fs, now, ...(isProcessAlive ? { isProcessAlive } : {}) });
    const bootstrap = createOneTimeCredential({ store, kind: 'bootstrap', fs, now });
    const recovery = createOneTimeCredential({ store, kind: 'recovery', fs, now });
    const sessions = createSessionRegistry({ now });
    const bridge = createBridgeVerifier({ store, fs, now });
    let probeCache = null;
    let reconciling = null;

    /** @returns {import('./engine').ManagerState & { evidence: string[] }} */
    function currentState() {
        const evidence = existingInstallEvidence(settings, fs);
        if (!initResult.ok) {
            return { state: 'recovery', reason: 'MANAGER_STORE_UNREADABLE', installation: null, evidence };
        }
        const installation = store.readInstallation();
        if (installation.status === 'ok') return { state: 'claimed', reason: null, installation: installation.doc, evidence };
        if (installation.status === 'missing' && readTombstone(settings.storeDir, fs).present) {
            return { state: 'recovery', reason: 'MANAGER_TOMBSTONED', installation: null, evidence: [...evidence, 'tombstone'] };
        }
        if (installation.status === 'missing' && evidence.length === 0) {
            return { state: 'unclaimed', reason: null, installation: null, evidence };
        }
        return { state: 'recovery', reason: STORE_REASONS[installation.status], installation: null, evidence };
    }

    function createFeatureState() {
        const { createFeatureState: create } = require('@goobster/core/features/featureState');
        return create({
            filePath: settings.featuresPath,
            env: settings.env,
            config: readConfigJson(settings.configPath, fs).config,
            logger: { warn: () => {} }
        });
    }

    async function probe({ fresh = false } = {}) {
        const t = now().getTime();
        if (!fresh && probeCache && t - probeCache.at < PROBE_TTL_MS) return probeCache.result;
        const result = await probeAppDatabase(settings, { fs, timeoutMs: probeTimeoutMs });
        probeCache = { at: now().getTime(), result };
        return result;
    }

    /** The barrier's verdict from the store alone; an unreadable file counts as active. */
    function maintenanceBlocksWrites() {
        const stored = coreMaintenance.readStore({ env: { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir }, fs });
        return stored.status === 'active' || stored.status === 'unreadable';
    }

    /**
     * The facade is a process singleton selected when it is first required.
     * After a migration switched the connection the manager's own selection
     * may be stale (a SQLite singleton loaded earlier): audit rows then wait
     * in the journal until the manager restarts on the new connection
     * instead of being written into the old file.
     */
    function loadApplicationDb() {
        const db = require('@goobster/core/db');
        const wanted = settings.dbUrl ? 'postgres' : 'sqlite';
        if (db.engine !== wanted) {
            throw Object.assign(new Error('the manager must restart to use the new database connection'), { code: 'MANAGER_RESTART_NEEDED' });
        }
        return db;
    }

    function reconcile() {
        if (reconciling) return reconciling;
        if (maintenanceBlocksWrites()) {
            return Promise.resolve({ pending: pendingAuditCount(journal), inserted: 0, existing: 0, deferred: true, reason: 'MAINTENANCE_ACTIVE' });
        }
        reconciling = reconcileAudit({ journal, probe: () => probe({ fresh: true }), closeAfter: true, loadDb: loadApplicationDb, ...reconcileDeps })
            .catch((error) => {
                logger.warn?.(`[manager] audit reconciliation deferred: ${error && (error.code || error.name)}`);
                return { deferred: true, reason: 'RECONCILE_FAILED' };
            })
            .finally(() => { reconciling = null; });
        return reconciling;
    }

    const kinds = {};
    const builtIn = [createFeaturesSetKind(), createAdoptKind({ settings, fs, now, logger }), createClaimKind(), createRecoveryUnlockKind()];
    for (const kind of [...builtIn, ...extraKinds.flatMap(make => make({ settings, fs, now, logger }))]) {
        if (kinds[kind.kind]) throw new Error(`operation kind ${kind.kind} is registered twice`);
        kinds[kind.kind] = kind;
    }

    const engine = createEngine({
        journal,
        lock,
        kinds,
        currentState,
        context: {
            store,
            sessions,
            bridge,
            createFeatureState,
            evidence: () => existingInstallEvidence(settings, fs)
        },
        hooks,
        now,
        logger,
        onAudit: () => {
            if (settings.reconcile) reconcile();
        }
    });

    updateWiring.bind(settings.storeDir, { engine, store, journal });

    /**
     * Boot-time housekeeping. Mints the bootstrap credential in the
     * unclaimed state (replacing any earlier one); drops it otherwise;
     * makes sure a claimed installation has its bridge key; marks
     * operations a crash interrupted.
     * @returns {Promise<{ state: Object, bootstrap: { credential: string, expiresAt: string, file: string } | null, recovered: string[] }>}
     */
    async function init({ mintBootstrap = true } = {}) {
        const state = currentState();
        let minted = null;
        if (initResult.ok) {
            if (state.state === 'unclaimed') {
                if (mintBootstrap) minted = bootstrap.mint();
            } else {
                bootstrap.revoke();
            }
            if (state.state === 'claimed') bridge.ensureKey(state.installation.installationId);
        }
        const migration = initResult.ok ? reconcileMigration({ settings, store, fs, now, logger }) : { reconciled: false, action: null };
        const recovered = initResult.ok ? await engine.recoverInterrupted() : [];
        const maintenance = initResult.ok ? recoverOnStart(createMaintenanceStore({ storeDir: settings.storeDir, fs, now })) : null;
        return { state, bootstrap: minted, recovered, maintenance, migration };
    }

    /** Everything GET /status shows. No credential, hash, label, path or URL. */
    async function status() {
        const state = currentState();
        const appDatabase = await probe();
        const config = readConfigJson(settings.configPath, fs);
        const out = {
            service: 'goobster-manager',
            version: MANAGER_VERSION,
            state: state.state,
            reason: state.reason,
            installation: state.installation
                ? {
                    installationId: state.installation.installationId,
                    createdAt: state.installation.createdAt,
                    claimed: Boolean(state.installation.claimedAt),
                    origin: state.installation.origin
                }
                : null,
            existingInstallation: state.evidence.length > 0,
            appDatabase,
            config: { present: config.present, readable: config.readable },
            lock: initResult.ok ? lock.describe() : { held: false },
            maintenance: initResult.ok
                ? summarizeMaintenance(createMaintenanceStore({ storeDir: settings.storeDir, fs, now }).read())
                : { active: false, phase: null, fence: null, since: null, stale: false, problem: 'MANAGER_STORE_UNREADABLE' },
            audit: { pending: initResult.ok ? pendingAuditCount(journal) : 0 },
            transport: { lan: settings.lan, tls: settings.lan },
            auth: { bridge: state.state === 'claimed', strongAuthRequired: bridge.requireStrongAuth() },
            privileged: privileged.describe()
        };
        if (state.state === 'unclaimed') {
            const pending = bootstrap.describe();
            out.setup = { bootstrapPending: pending.pending, expiresAt: pending.expiresAt, expired: pending.expired };
        }
        if (state.state !== 'unclaimed') {
            const pending = recovery.describe();
            out.recovery = { credentialPending: pending.pending, expiresAt: pending.expiresAt };
        }
        return out;
    }

    return {
        settings,
        store,
        journal,
        lock,
        engine,
        sessions,
        bridge,
        credentials: { bootstrap, recovery },
        storeReady: initResult.ok,
        currentState,
        createFeatureState,
        probe,
        reconcile,
        init,
        status
    };
}

module.exports = { createManager, MANAGER_VERSION, readConfigJson };
