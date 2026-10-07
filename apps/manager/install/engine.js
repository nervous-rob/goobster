/**
 * The setup engine's shared parts (documentation/manager_install.md, issue
 * #329): input parsing, roots, ownership checks, the step ledger, staging
 * and activation through scripts/lib/payloadStage.js, configuration through
 * configFile.write(), the feature flags a reduced payload needs, and the
 * guarded removals. The four operation kinds in
 * `engine/kinds/install.js` and the adopt kind compose these.
 *
 * Every step verifies what it finds before it acts, so running an operation
 * again after an interruption picks up at the first step whose outcome is
 * not already on disk. Nothing here shells out; the only privileged work is
 * the closed list in ../privileged.js: a step is `done`, `skipped` with
 * MANUAL_FALLBACK when the machine cannot take it (systemd absent or offline,
 * no way to elevate), or `deferred` where no helper exists for the platform.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');
const files = require('../store/files');
const { createJournal } = require('../store/journal');
const { lazy } = require('../lazy');
const privileged = require('../privileged');
const model = require('./model');
const paths = require('./paths');
const release = require('./release');
const preflight = require('./preflight');
const dbInit = require('./dbInit');
const tombstone = require('./tombstone');
const updaters = require('./updaters');
const { discover } = require('./discover');

const catalog = lazy('@goobster/core/features/catalog');
const fieldCatalog = lazy('@goobster/core/config/fieldCatalog');
const configFile = lazy('@goobster/core/config/configFile');
const featureStateModule = lazy('@goobster/core/features/featureState');

const LABEL_SHAPE = /^[\p{L}\p{N} ._'@()-]{1,80}$/u;
const FEATURE_ID = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const USER_SHAPE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_CONFIG_CHANGES = 64;
const STEP_STATUSES = Object.freeze(['pending', 'done', 'skipped', 'failed', 'deferred']);

function invalid(message, details = null) {
    return new ManagerError(400, 'INVALID_INPUT', message, details);
}

function exactKeys(input, allowed, what = 'The input') {
    if (!files.isPlainObject(input)) throw invalid(`${what} must be an object.`);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw invalid(`${what} has a field this operation does not accept.`);
    }
}

function textField(value, name, { max = 4096 } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw invalid(`"${name}" must be a non-empty string.`);
    return value;
}

function absolutePath(value, name) {
    const text = textField(value, name);
    const problem = paths.rawProblem(text);
    if (problem) throw invalid(`"${name}" must be an absolute path without ".." parts.`, { code: problem });
    return path.resolve(text);
}

function parseLabel(value) {
    const label = typeof value === 'string' ? value.trim() : '';
    if (!LABEL_SHAPE.test(label)) throw invalid('"ownerLabel" must be 1 to 80 letters, digits, spaces or ._\'@()- characters.');
    return label;
}

function parseFeatures(value) {
    if (!Array.isArray(value) || value.length > 80) throw invalid('"features" must be a list of feature ids.');
    for (const id of value) if (typeof id !== 'string' || !FEATURE_ID.test(id)) throw invalid('"features" must be a list of feature ids.');
    return [...new Set(value)];
}

const ROLE_KEYS = Object.freeze(['code', 'data', 'config', 'cache', 'logs', 'uploads', 'managerStore']);

function parseRootsInput(value) {
    if (value === undefined) return {};
    exactKeys(value, new Set(ROLE_KEYS), '"roots"');
    const out = {};
    for (const key of Object.keys(value)) out[key] = absolutePath(value[key], `roots.${key}`);
    return out;
}

function parseLayout(value, fallback) {
    if (value === undefined) return fallback;
    if (!model.LAYOUTS.includes(value)) throw invalid('"layout" must be lite, standalone or paired.');
    return value;
}

function parseRelease(value) {
    if (value === undefined) return {};
    exactKeys(value, new Set(['publicKeyFiles', 'allowUnsigned']), '"release"');
    const out = {};
    if (value.publicKeyFiles !== undefined) {
        if (!Array.isArray(value.publicKeyFiles) || value.publicKeyFiles.length > 8) throw invalid('"release.publicKeyFiles" must be a list of file paths.');
        out.publicKeyFiles = value.publicKeyFiles.map((file, index) => absolutePath(file, `release.publicKeyFiles[${index}]`));
    }
    if (value.allowUnsigned !== undefined) {
        if (typeof value.allowUnsigned !== 'boolean') throw invalid('"release.allowUnsigned" must be true or false.');
        out.allowUnsigned = value.allowUnsigned;
    }
    return out;
}

function parseRuntimeUser(value) {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !USER_SHAPE.test(value)) throw invalid('"runtimeUser" is not a valid account name.');
    return value;
}

function parseBoolean(value, name, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw invalid(`"${name}" must be true or false.`);
    return value;
}

/**
 * `config` changes: `[{ id, value }]` against the field catalog, set only.
 * Secret values are returned apart so the plan can name them without the value.
 */
function parseConfigChanges(value) {
    if (value === undefined) return { changes: [], secrets: {} };
    if (!Array.isArray(value) || value.length > MAX_CONFIG_CHANGES) throw invalid('"config" must be a list of { id, value } changes.');
    const changes = [];
    const secrets = {};
    const seen = new Set();
    for (const change of value) {
        exactKeys(change, new Set(['id', 'value']), 'A config change');
        const field = typeof change.id === 'string' ? fieldCatalog.get(change.id) : null;
        if (!field || !field.sources.includes('config')) throw invalid('A config change names a setting that does not exist or cannot be set in config.json.');
        if (seen.has(field.id)) throw invalid('A config change names the same setting twice.');
        seen.add(field.id);
        if (fieldCatalog.isMaskedValue(change.value)) throw new ManagerError(400, 'MASK_IS_NOT_A_VALUE', `The value for ${field.id} is a mask, not a value.`);
        const checked = fieldCatalog.validateValue(field, change.value);
        if (!checked.ok) throw new ManagerError(400, 'INVALID_VALUE', `${field.id} ${checked.message || 'is not valid'}`.slice(0, 200), { id: field.id });
        const secret = field.type === 'secret';
        if (secret) secrets[field.id] = checked.value;
        changes.push({ id: field.id, secret, value: secret ? undefined : checked.value });
    }
    return { changes, secrets };
}

function parseDatabase(value, settings) {
    if (value !== undefined) {
        exactKeys(value, new Set(['engine']), '"database"');
        if (!model.DB_ENGINES.includes(value.engine)) throw invalid('"database.engine" must be sqlite or postgres.');
    }
    const engine = value ? value.engine : (settings.dbUrl ? 'postgres' : 'sqlite');
    return { engine, external: engine === 'postgres' };
}

function createInstallCore({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const deps = {
        probePort: preflight.defaultProbePort,
        discover,
        initDatabase: dbInit.initDatabase,
        readCrontab: undefined,
        writeCrontab: undefined,
        home: os.homedir(),
        ...(settings.installDeps || {})
    };
    const env = settings.env || process.env;
    const stamp = () => now().toISOString();

    // ---------------------------------------------------------------- roots
    function resolveRoots(given = {}) {
        const code = given.code || env.GOOBSTER_INSTALL_ROOT || settings.root;
        const base = model.defaultRoots(code);
        const data = given.data || settings.dataDir;
        return {
            code: path.resolve(code),
            data,
            config: given.config || settings.configPath,
            cache: given.cache || env.GOOBSTER_CACHE_DIR || base.cache,
            logs: given.logs || env.GOOBSTER_LOG_DIR || base.logs,
            uploads: given.uploads || path.join(data, 'web-uploads'),
            managerStore: given.managerStore || settings.storeDir
        };
    }

    // ------------------------------------------------------------ ownership
    /** The usable, verified, managed installation record, or a refusal. */
    function ownedInstall(ctx, { requireManaged = true } = {}) {
        const current = ctx.store.readInstallation();
        if (current.status !== 'ok') {
            throw new ManagerError(409, 'NOT_INSTALLED', 'There is no usable installation record; install or adopt first.');
        }
        const seal = ctx.store.verifySeal();
        if (seal.state === 'tampered') {
            throw new ManagerError(409, 'OWNERSHIP_TAMPERED', 'installation.json does not match the seal the manager wrote; it was left as it is. Restore it or adopt again from recovery.', { reason: seal.reason });
        }
        if (requireManaged && !model.isManaged(current.doc)) {
            throw new ManagerError(409, 'NOT_MANAGED', 'The installation record has no recorded roots; install or adopt it with roots first.');
        }
        return current.doc;
    }

    function assertRecordPaths(doc) {
        for (const role of ROLE_KEYS) {
            const problem = paths.rawProblem(doc.roots[role]);
            if (problem) throw new ManagerError(409, 'PATH_ESCAPE', 'A recorded root is not a usable absolute path.');
        }
    }

    // --------------------------------------------------------- the step ledger
    const journalFor = (ctx) => ctx.journal || createJournal({ store: ctx.store, fs, now });

    function ledger(ctx, record) {
        const journal = journalFor(ctx);
        const names = (record.plan && Array.isArray(record.plan.steps)) ? record.plan.steps.map(step => step.name) : [];
        return {
            mark(name, status, code = null) {
                if (!STEP_STATUSES.includes(status)) throw new Error(`unknown step status ${status}`);
                journal.update(record.id, (r) => {
                    const progress = Array.isArray(r.progress) ? r.progress : names.map(item => ({ name: item, status: 'pending', at: null }));
                    const entry = { name, status, ...(code ? { code } : {}), at: stamp() };
                    const at = progress.findIndex(item => item.name === name);
                    if (at >= 0) progress[at] = entry;
                    else progress.push(entry);
                    r.progress = progress;
                    return r;
                });
            }
        };
    }

    /**
     * Wrap a step body. The body returns `{ status?: 'done'|'skipped'|'deferred', code?, detail? }`
     * (default done). The ledger records the outcome; the generic engine's
     * journal gets the detail, with `skipped: true` for skipped and deferred.
     */
    function step(name, body) {
        return {
            name,
            async run(record, ctx) {
                const book = ledger(ctx, record);
                let outcome;
                try {
                    outcome = (await body(record, ctx)) || {};
                } catch (error) {
                    book.mark(name, 'failed', error && error.code ? String(error.code) : 'STEP_FAILED');
                    throw error;
                }
                const status = outcome.status || 'done';
                book.mark(name, status, outcome.code || null);
                const detail = { ...(outcome.detail || {}), ...(outcome.code ? { code: outcome.code } : {}) };
                if (status === 'skipped' || status === 'deferred') detail.skipped = true;
                if (status === 'deferred') detail.deferred = true;
                return Object.keys(detail).length ? detail : undefined;
            }
        };
    }

    // ------------------------------------------------------------ resume
    function signatureOf(parts) {
        return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
    }

    /** The newest operation of `kind` with this signature that stopped before it finished. */
    function findInterrupted(ctx, kind, signature) {
        const journal = journalFor(ctx);
        for (const record of journal.list()) {
            if (!record || record.kind !== kind || !record.plan || record.plan.signature !== signature) continue;
            if (record.status === 'applied') return null;
            if (record.status === 'failed' && record.error && !['PLAN_EXPIRED', 'PREFLIGHT_FAILED'].includes(record.error.code)) {
                const progress = Array.isArray(record.progress) ? record.progress : [];
                const next = (record.plan.steps || []).map(item => item.name).find(name => {
                    const found = progress.find(item => item.name === name);
                    return !found || !['done', 'skipped', 'deferred'].includes(found.status);
                });
                return { id: record.id, resumeFrom: next || null, error: record.error.code };
            }
        }
        return null;
    }

    // ------------------------------------------------------ payload helpers
    const stage = () => release.payloadStage();

    function healthOptions(releaseInput = {}) {
        const options = { devMode: true };
        const keys = release.verifyOptions(releaseInput, fs).publicKey;
        if (keys) options.publicKey = keys;
        return options;
    }

    /** What `<code>/current` holds and whether it verifies. `hash` false is the cheap size-only check. */
    function inspectCurrent(codeRoot, releaseInput, { hash = true } = {}) {
        const current = path.join(codeRoot, 'current');
        if (!fs.existsSync(path.join(current, stage().MANIFEST_FILE))) return { present: false, healthy: false, code: 'NOT_INSTALLED' };
        try {
            const result = stage().verifyPayload(current, { ...healthOptions(releaseInput), hash });
            return { present: true, healthy: true, releaseId: result.releaseId, features: result.features, version: result.core, target: result.target, bytes: result.bytes };
        } catch (error) {
            let releaseId = null;
            try { releaseId = release.loadManifest(current, fs).releaseId; } catch { }
            return { present: true, healthy: false, code: error && error.code ? error.code : 'INCOMPLETE', releaseId };
        }
    }

    /** A ready staging directory for this release and selection that verifies, or null. */
    function findReadyStage(codeRoot, releaseId, features, options) {
        const staging = path.join(codeRoot, 'staging');
        for (const dir of stage().listStaging(staging).ready) {
            if (!path.basename(dir).startsWith(`${releaseId}-`)) continue;
            try {
                const result = stage().verifyPayload(dir, options);
                if (JSON.stringify(result.features) === JSON.stringify(features)) return { dir, result };
            } catch { }
        }
        return null;
    }

    function stageSelectionInto({ sources, codeRoot, features, profile, options, ctx }) {
        const staging = path.join(codeRoot, 'staging');
        stage().recoverInstall(codeRoot);
        stage().cleanStaging(staging);
        try {
            return stage().stageSelection(sources, staging, { features, profile }, options);
        } catch (error) {
            throw release.mapPayloadError(error) || error;
        } finally {
            void ctx;
        }
    }

    // -------------------------------------------------------- config.json
    /** The configuration document to write: what is there, plus the answers, plus what the layout needs. */
    function buildConfigDoc({ configPath, changes, secrets, layout }) {
        const read = configFile.read(configPath, { fs });
        if (read.present && !read.readable) throw new ManagerError(409, 'CONFIG_UNREADABLE', 'config.json exists and cannot be read; it was left as it is.');
        const doc = read.doc ? JSON.parse(JSON.stringify(read.doc)) : {};
        for (const change of changes) {
            const field = fieldCatalog.get(change.id);
            const value = change.secret ? secrets[change.id] : change.value;
            fieldCatalog.setPath(doc, fieldCatalog.filePath(field), value);
        }
        if (layout === 'standalone') {
            const webapp = files.isPlainObject(doc.webapp) ? doc.webapp : {};
            if (webapp.enabled === undefined) doc.webapp = { ...webapp, enabled: true };
        }
        return { doc, revision: read.revision, existed: read.present };
    }

    function writeConfigStep({ configPath, changes, secrets, layout }) {
        const built = buildConfigDoc({ configPath, changes, secrets, layout });
        const before = built.revision;
        if (!built.existed && Object.keys(built.doc).length === 0) return { status: 'skipped', code: 'NOTHING_TO_WRITE' };
        const target = JSON.stringify(built.doc);
        if (built.existed && JSON.stringify(configFile.read(configPath, { fs }).doc) === target) {
            return { status: 'skipped', code: 'ALREADY_DONE', detail: { revision: before } };
        }
        try {
            const out = configFile.write(configPath, built.doc, { expectedRevision: before, fs });
            return { status: 'done', detail: { revision: out.revision, created: !built.existed } };
        } catch (error) {
            if (error && error.name === 'ConfigFileError') {
                const code = error.code === 'STALE_REVISION' ? 'REVISION_CONFLICT' : (error.code === 'INVALID_CONFIG' ? 'INVALID_CONFIG' : 'CONFIG_WRITE_FAILED');
                throw new ManagerError(409, code, 'config.json was not written; the previous file is as it was.');
            }
            throw error;
        }
    }

    // ------------------------------------------------------ features.json
    /** Catalog features the selection leaves out, closed over `dependsOn` so the document stays valid. */
    function excludedFeatures(selected) {
        const manageable = catalog.FEATURE_IDS.filter(id => id !== 'core');
        const out = new Set(manageable.filter(id => !selected.includes(id)));
        let grew = true;
        while (grew) {
            grew = false;
            for (const id of manageable) {
                if (out.has(id)) continue;
                if (catalog.get(id).dependsOn.some(dep => out.has(dep))) {
                    out.add(id);
                    grew = true;
                }
            }
        }
        return [...out].sort();
    }

    async function writeFeaturesStep({ dataDir, selected }) {
        const excluded = excludedFeatures(selected);
        if (excluded.length === 0) return { status: 'skipped', code: 'FULL_PAYLOAD', detail: { excluded: 0 } };
        const state = featureStateModule.createFeatureState({ filePath: path.join(dataDir, 'features.json'), env: {}, config: {}, logger: { warn: () => {} } });
        const loaded = state.load();
        if (loaded.error) throw new ManagerError(409, 'FEATURE_STATE_UNREADABLE', 'features.json exists and cannot be used; it was left as it is.');
        const want = {};
        for (const id of excluded) want[id] = { installed: false, active: false };
        if (loaded.exists) {
            const has = loaded.parsed.features || {};
            if (excluded.every(id => has[id] && has[id].installed === false)) return { status: 'skipped', code: 'ALREADY_DONE', detail: { excluded: excluded.length } };
            const features = {};
            for (const [id, entry] of Object.entries(has)) features[id] = { installed: entry.installed, active: entry.active };
            Object.assign(features, want);
            try {
                const out = await state.write({ origin: 'operator', features }, { expectedRevision: loaded.parsed.revision });
                return { status: 'done', detail: { excluded: excluded.length, revision: out.revision } };
            } catch (error) {
                throw new ManagerError(409, 'FEATURE_STATE_CONFLICT', 'features.json could not be updated; it was left as it is.', { cause: error && error.code ? error.code : null });
            }
        }
        try {
            const out = await state.write({ origin: 'operator', features: want }, { expectedRevision: null });
            return { status: 'done', detail: { excluded: excluded.length, revision: out.revision } };
        } catch (error) {
            throw new ManagerError(409, 'FEATURE_STATE_CONFLICT', 'features.json could not be written.', { cause: error && error.code ? error.code : null });
        }
    }

    // ------------------------------------------------------- record shape
    function systemDependencies(manifest, selected) {
        const out = new Map();
        for (const id of selected) {
            for (const entry of (manifest.groups[id] && manifest.groups[id].system) || []) {
                if (!out.has(entry.name)) out.set(entry.name, { name: entry.name, kind: entry.kind === 'python' ? 'python-venv' : (entry.kind === 'os-package' ? 'library' : 'binary'), ownedBy: 'system' });
            }
        }
        return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    }

    function exclusiveDependencies(manifest, selected) {
        const chosen = new Set(selected);
        return manifest.dependencies
            .filter(dep => dep.exclusive && dep.owners.some(owner => chosen.has(owner)))
            .map(dep => ({ name: dep.name, kind: 'npm', ownedBy: 'installer' }))
            .sort((a, b) => (a.name < b.name ? -1 : 1))
            .slice(0, 64);
    }

    function releaseSection(manifest, selected) {
        return { releaseId: stage().releaseIdOf(manifest), version: manifest.release.core, target: manifest.target.id, features: selected };
    }

    function serviceKindForHost() {
        if (process.platform === 'win32') return 'windows-service';
        if (process.platform === 'darwin') return 'launchd';
        return 'systemd';
    }

    /** Units named goobster*.service already on this machine (a legacy Pi unit, another installation). */
    function unitNames() {
        if (deps.unitNames) return deps.unitNames();
        if (process.platform !== 'linux' || process.env.JEST_WORKER_ID) return [];
        const names = new Set();
        try {
            for (const entry of fs.readdirSync('/etc/systemd/system')) if (/^goobster[a-z0-9-]*\.service$/.test(entry)) names.add(entry);
        } catch { }
        try {
            const text = childProcess.execFileSync('systemctl', ['list-units', '--all', '--no-legend', '--plain', '--type=service', 'goobster*'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
            for (const line of text.split('\n')) {
                const name = line.trim().split(/\s+/)[0];
                if (/^goobster[a-z0-9-]*\.service$/.test(name)) names.add(name);
            }
        } catch { }
        return [...names].sort();
    }

    // ------------------------------------------------------- privileged hook
    /**
     * The runner for privileged operations: the injected one (tests), the real
     * dispatcher in production, and none under a test runner (a spec injects its
     * own) so that it can never start an elevated helper or register a real
     * service by accident.
     */
    function privilegedRunner() {
        if (deps.privileged) return deps.privileged;
        if (process.env.JEST_WORKER_ID) return null;
        return privileged;
    }

    /** Is there a runner and a helper for this operation on this machine? */
    function privilegedAvailable(operation) {
        const runner = privilegedRunner();
        if (!runner) return false;
        return typeof runner.isImplemented === 'function' ? runner.isImplemented(operation) : true;
    }

    /**
     * Run one privileged operation through the closed list (../privileged.js)
     * and record one manager audit row for it: names and outcome only.
     * @returns {Promise<{ status: 'done'|'fallback'|'failed'|'deferred', outcome?, reason?, code?, message?, manual?, detail?, log? }>}
     *   a refused input throws a ManagerError; an operation with no helper on
     *   this platform answers `deferred`
     */
    async function runPrivileged(operation, input, { record = null, ctx = null, requestDir = null, timeoutMs = null } = {}) {
        const runner = privilegedRunner();
        let result;
        if (!runner) {
            result = { status: 'deferred', code: 'NOT_IMPLEMENTED' };
        } else {
            try {
                result = await runner.run(operation, input, { requestDir, env, ...(timeoutMs ? { timeoutMs } : {}), ...(deps.privilegedOptions || {}) });
            } catch (error) {
                if (error instanceof ManagerError && error.status === 501) result = { status: 'deferred', code: 'NOT_IMPLEMENTED' };
                else throw error;
            }
        }
        if (result.status !== 'deferred' && ctx) {
            const outcome = result.status === 'done' ? (result.outcome === 'noop' ? 'noop' : 'applied') : (result.status === 'fallback' ? 'fallback' : 'failed');
            try {
                await journalFor(ctx).appendAudit({
                    action: `manager.privileged.${operation}`,
                    actor: record ? record.actor : null,
                    operationId: crypto.randomUUID(),
                    outcome,
                    via: result.via || (record ? record.via : null),
                    detail: { operationRef: record ? record.id : null, ...(result.code ? { code: result.code } : {}), ...(result.reason ? { reason: result.reason } : {}) }
                });
            } catch (error) {
                logger.error?.(`[manager] could not append the audit record for ${operation}: ${error && error.code ? error.code : 'error'}`);
            }
        }
        return result;
    }

    /**
     * A privileged step for the ledger: `done`, `skipped` (not requested, or
     * the operator's system does not allow it, with `fallbackCode`), `deferred`
     * (no helper on this platform) or a thrown failure.
     */
    async function privilegedStep(operation, { enabled = true, input = null, record = null, ctx = null, requestDir = null, fallbackCode = null } = {}) {
        if (!enabled) return { status: 'skipped', code: 'NOT_REQUESTED' };
        const result = await runPrivileged(operation, input, { record, ctx, requestDir });
        if (result.status === 'deferred') return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: operation } };
        if (result.status === 'fallback') {
            return { status: 'skipped', code: fallbackCode || result.reason, detail: { privileged: operation, reason: result.reason, ...(result.manual ? { manual: result.manual } : {}) } };
        }
        if (result.status === 'failed') {
            throw new ManagerError(409, result.code || 'HELPER_FAILED', result.message || 'The privileged helper failed.', { privileged: operation, log: result.log || [] });
        }
        return { status: 'done', detail: { privileged: operation, outcome: result.outcome, via: result.via || null, log: result.log || [] } };
    }

    // ----------------------------------------------------------- removals
    function payloadRemovals(roots) {
        return model.PAYLOAD_DIRS.map(name => path.join(roots.code, name));
    }

    function removeOwnedPath(target, roots) {
        return paths.removeOwned(target, { codeRoot: roots.code, home: deps.home, fs });
    }

    return {
        settings,
        fs,
        now,
        logger,
        deps,
        env,
        resolveRoots,
        ownedInstall,
        assertRecordPaths,
        ledger,
        step,
        signatureOf,
        findInterrupted,
        stage,
        healthOptions,
        inspectCurrent,
        findReadyStage,
        stageSelectionInto,
        buildConfigDoc,
        writeConfigStep,
        excludedFeatures,
        writeFeaturesStep,
        systemDependencies,
        exclusiveDependencies,
        releaseSection,
        serviceKindForHost,
        privilegedAvailable,
        unitNames,
        runPrivileged,
        privilegedStep,
        payloadRemovals,
        removeOwnedPath,
        journalFor
    };
}

module.exports = {
    createInstallCore,
    LABEL_SHAPE,
    ROLE_KEYS,
    exactKeys,
    textField,
    absolutePath,
    parseLabel,
    parseFeatures,
    parseRootsInput,
    parseLayout,
    parseRelease,
    parseRuntimeUser,
    parseBoolean,
    parseConfigChanges,
    parseDatabase,
    invalid,
    tombstone,
    updaters
};
