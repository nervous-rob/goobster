/**
 * Installation feature state (P1.2 of the installer plan, issue #317).
 *
 * One validated answer to "is this feature available in this process" for
 * every execution surface (commands, runtime steps, tools, routes, message
 * routing, portal). Spec and examples: documentation/feature_state.md.
 *
 * Precedence of the effective answer, strongest refusal first:
 *   installed -> requested -> environment -> dependencies
 * with `configured` reported alongside, never as a refusal.
 *
 * - `installed`   the payload is present. Whoever installs a reduced payload
 *                 (documentation/packaging.md) writes false for the features
 *                 it leaves out; without a file everything reports true.
 * - `configured`  required keys and dependencies exist right now. Derived
 *                 from env/config on every snapshot, never persisted. It does
 *                 not gate: an unconfigured feature keeps its surfaces and
 *                 answers with its own guidance (legacy parity). The missing
 *                 setting NAMES are returned as `warnings`.
 * - `requested`   the operator's enablement: `active` in `data/features.json`,
 *                 or, when there is no usable file, the effective legacy
 *                 switch (today's behaviour, see ./legacyResolver.js).
 * - `env`         GOOBSTER_FEATURE_<ID>=0|false|no|off can only deactivate.
 * - dependencies  every `dependsOn` must itself be active.
 *
 * Reads never create or modify anything. The snapshot is computed once and
 * memoised; a `pendingActive` value in the file is a change waiting for the
 * next restart and never affects the running snapshot.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const catalog = require('./catalog');
const { createLegacyResolver } = require('./legacyResolver');

const STATE_VERSION = 1;
const ORIGINS = ['legacy-seed', 'fresh-preset', 'operator'];
const CORE_ID = catalog.CORE_ID;
const OFF_WORDS = new Set(['0', 'false', 'no', 'off']);

class FeatureStateError extends Error {
    /**
     * @param {string} code UNKNOWN_FEATURE | UNSUPPORTED_VERSION | CORRUPT_STATE | STATE_UNREADABLE
     *   | CORE_IMMUTABLE | INVALID_STATE | DEPENDENCY_CONFLICT | STALE_REVISION
     * @param {string} message
     * @param {Object} [extra] Structured fields (`feature`, `conflicts`, ...). Never state contents.
     */
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'FeatureStateError';
        this.code = code;
        Object.assign(this, extra);
    }

    toJSON() {
        const out = { code: this.code, message: this.message };
        if (this.feature) out.feature = this.feature;
        if (this.conflicts) out.conflicts = this.conflicts;
        return out;
    }
}

class StaleRevisionError extends FeatureStateError {
    constructor(expected, actual) {
        super('STALE_REVISION', `features.json is at revision ${actual}, not ${expected}; reload and retry.`, { expected, actual });
        this.name = 'StaleRevisionError';
    }
}

/** Upper snake env variable that can deactivate `id`: screenVision -> GOOBSTER_FEATURE_SCREEN_VISION. */
function envVarFor(id) {
    return `GOOBSTER_FEATURE_${id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatUtc(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

const MANAGEABLE_IDS = catalog.FEATURE_IDS.filter(id => id !== CORE_ID);

/**
 * Validate a parsed document and return its normalised form. Throws
 * FeatureStateError; never echoes file contents into the message.
 */
function normalizeParsed(raw) {
    if (!isPlainObject(raw)) {
        throw new FeatureStateError('CORRUPT_STATE', 'features.json must contain a JSON object.');
    }
    if (typeof raw.version !== 'number' || !Number.isFinite(raw.version)) {
        throw new FeatureStateError('CORRUPT_STATE', 'features.json has no numeric "version".');
    }
    if (raw.version !== STATE_VERSION) {
        throw new FeatureStateError(
            'UNSUPPORTED_VERSION',
            `features.json is version ${raw.version}; this build understands version ${STATE_VERSION}.`,
            { version: raw.version }
        );
    }
    if (!Number.isInteger(raw.revision) || raw.revision < 0) {
        throw new FeatureStateError('CORRUPT_STATE', 'features.json "revision" must be a non-negative integer.');
    }
    if (raw.updatedAt !== undefined && raw.updatedAt !== null && typeof raw.updatedAt !== 'string') {
        throw new FeatureStateError('CORRUPT_STATE', 'features.json "updatedAt" must be a string.');
    }
    if (!ORIGINS.includes(raw.origin)) {
        throw new FeatureStateError('CORRUPT_STATE', `features.json "origin" must be one of ${ORIGINS.join(', ')}.`);
    }
    if (!isPlainObject(raw.features)) {
        throw new FeatureStateError('CORRUPT_STATE', 'features.json "features" must be an object.');
    }

    for (const id of Object.keys(raw.features)) {
        if (id === CORE_ID) {
            throw new FeatureStateError('CORE_IMMUTABLE', '"core" is always available and cannot appear in features.json.', { feature: id });
        }
        if (!catalog.get(id)) {
            throw new FeatureStateError('UNKNOWN_FEATURE', `features.json names unknown feature "${id}".`, { feature: id });
        }
    }

    const features = {};
    for (const id of Object.keys(raw.features)) {
        const entry = raw.features[id];
        const bad = (what) => new FeatureStateError('CORRUPT_STATE', `features.json entry "${id}": ${what}.`, { feature: id });
        if (!isPlainObject(entry)) throw bad('must be an object');
        if (typeof entry.installed !== 'boolean') throw bad('"installed" must be true or false');
        if (typeof entry.active !== 'boolean') throw bad('"active" must be true or false');
        if (entry.pendingActive !== undefined && typeof entry.pendingActive !== 'boolean') throw bad('"pendingActive" must be true or false');
        features[id] = { installed: entry.installed, active: entry.active };
        if (entry.pendingActive !== undefined) features[id].pendingActive = entry.pendingActive;
    }

    return {
        version: STATE_VERSION,
        revision: raw.revision,
        updatedAt: raw.updatedAt ?? null,
        origin: raw.origin,
        features
    };
}

/** Cheap synchronous PATH lookup for the manager to pass as `probes.systemDependency`. Never spawns. */
function createPathProbe({ fs = nodeFs, env = process.env, platform = process.platform } = {}) {
    const memo = new Map();
    const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    const separator = platform === 'win32' ? ';' : ':';
    const exists = (candidate) => {
        try {
            return fs.existsSync(candidate);
        } catch {
            return false;
        }
    };
    return (name) => {
        if (memo.has(name)) return memo.get(name);
        const override = name === 'ffmpeg' ? env.FFMPEG_PATH : undefined;
        let found = false;
        if (override) found = exists(override);
        if (!found) {
            const dirs = String(env.PATH || '').split(separator).filter(Boolean);
            found = dirs.some(dir => extensions.some(ext => exists(path.join(dir, name + ext))));
        }
        memo.set(name, found);
        return found;
    };
}

/**
 * @param {Object} [options]
 * @param {Object} [options.fs]        { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync }
 * @param {string} [options.filePath]  default <dataDir>/features.json
 * @param {Object} [options.env]       default process.env
 * @param {Object} [options.config]    plain config.json-shaped object; omitted = the live config modules
 * @param {Object} [options.probes]    { systemDependency(name) => boolean }; also read from config.probes.
 *                                     Without a system probe, host binaries never gate a feature.
 * @param {() => Date} [options.now]
 * @param {Object} [options.logger]    { warn }
 */
function createFeatureState(options = {}) {
    const fs = options.fs || nodeFs;
    const env = options.env || process.env;
    const now = options.now || (() => new Date());
    const logger = options.logger || console;
    const filePath = options.filePath || path.join(require('../runtimePaths').dataDir, 'features.json');
    const probes = options.probes || (options.config && options.config.probes) || {};
    const legacy = createLegacyResolver({ config: options.config, env });
    const warnedEnv = new Set();

    let memo = null;

    function envState(id) {
        const name = envVarFor(id);
        const raw = env[name];
        if (raw === undefined || raw === null || String(raw).trim() === '') return { name, off: false };
        if (OFF_WORDS.has(String(raw).trim().toLowerCase())) return { name, off: true };
        if (!warnedEnv.has(name)) {
            warnedEnv.add(name);
            logger.warn(`[features] ${name} is ignored: an environment override can only deactivate a feature (0, false, no or off).`);
        }
        return { name, off: false };
    }

    /** Read and validate the file. Never writes. */
    function load() {
        let text;
        try {
            if (!fs.existsSync(filePath)) return { exists: false, parsed: null, error: null };
            text = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') return { exists: false, parsed: null, error: null };
            return {
                exists: true,
                parsed: null,
                error: new FeatureStateError('STATE_UNREADABLE', 'features.json could not be read; check its permissions.')
            };
        }
        let raw;
        try {
            raw = JSON.parse(text);
        } catch {
            return { exists: true, parsed: null, error: new FeatureStateError('CORRUPT_STATE', 'features.json is not valid JSON.') };
        }
        try {
            return { exists: true, parsed: normalizeParsed(raw), error: null };
        } catch (error) {
            if (error instanceof FeatureStateError) return { exists: true, parsed: null, error };
            throw error;
        }
    }

    function legacyRequested(id) {
        const descriptor = catalog.get(id);
        if (!descriptor.legacySwitch || descriptor.legacySwitch.kind === 'presence') return true;
        return legacy.value(id);
    }

    /** Settings `id` needs to be fully configured, as NOT_CONFIGURED warnings naming settings only. */
    function configuredReasons(id) {
        const descriptor = catalog.get(id);
        const reasons = [];
        for (const key of descriptor.apiKeys) {
            if (key.required && !legacy.isSet(key.name, key.configPath)) {
                reasons.push({ code: 'NOT_CONFIGURED', detail: key.name });
            }
        }
        if (id === 'mail') {
            for (const name of legacy.mailMissing()) reasons.push({ code: 'NOT_CONFIGURED', detail: name });
        }
        if (id === 'push') {
            for (const name of legacy.pushMissing()) reasons.push({ code: 'NOT_CONFIGURED', detail: name });
        }
        if (typeof probes.systemDependency === 'function') {
            for (const name of descriptor.requiredSystemDependencies) {
                if (!probes.systemDependency(name)) reasons.push({ code: 'NOT_CONFIGURED', detail: name });
            }
        }
        return reasons;
    }

    function compute() {
        const loaded = load();
        const fileState = loaded.parsed;
        const entries = {};

        const resolve = (id) => {
            if (entries[id]) return entries[id];
            if (id === CORE_ID) {
                entries[id] = {
                    installed: true, configured: true, requested: true, pendingActive: null, pending: false,
                    active: true, reasons: [], warnings: []
                };
                return entries[id];
            }
            const descriptor = catalog.get(id);
            const fileEntry = fileState ? fileState.features[id] : undefined;
            const installed = fileEntry ? fileEntry.installed : true;
            const requested = fileEntry ? fileEntry.active : legacyRequested(id);
            const pendingActive = fileEntry && fileEntry.pendingActive !== undefined ? fileEntry.pendingActive : null;
            const configuredIssues = configuredReasons(id);
            const override = envState(id);

            const reasons = [];
            if (!installed) reasons.push({ code: 'NOT_INSTALLED' });
            if (!requested) {
                reasons.push({
                    code: 'DISABLED',
                    detail: fileEntry
                        ? 'features.json'
                        : (descriptor.legacySwitch && (descriptor.legacySwitch.configPath || descriptor.legacySwitch.envVar)) || 'features.json'
                });
            }
            if (override.off) reasons.push({ code: 'ENV_OFF', detail: override.name });
            for (const dep of descriptor.dependsOn) {
                if (!resolve(dep).active) reasons.push({ code: 'DEPENDENCY_INACTIVE', dependency: dep });
            }
            if (reasons.length > 0 && loaded.error) {
                reasons.push({ code: 'STATE_ERROR', detail: loaded.error.code });
            }

            entries[id] = {
                installed,
                configured: configuredIssues.length === 0,
                requested,
                pendingActive,
                pending: pendingActive !== null && pendingActive !== requested,
                active: reasons.length === 0,
                reasons,
                warnings: configuredIssues
            };
            return entries[id];
        };

        for (const id of catalog.FEATURE_IDS) resolve(id);
        const view = {
            source: fileState ? 'file' : 'none',
            exists: loaded.exists,
            error: loaded.error,
            state: fileState,
            entries
        };
        return { loaded, entries, view };
    }

    function snapshot() {
        if (!memo) memo = compute();
        return memo;
    }

    function refresh() {
        memo = null;
        return snapshot();
    }

    function availability(id) {
        const entry = Object.prototype.hasOwnProperty.call(snapshot().entries, id) ? snapshot().entries[id] : null;
        if (!entry) return { id, active: false, reasons: [{ code: 'UNKNOWN_FEATURE', detail: String(id) }], warnings: [] };
        return {
            id,
            active: entry.active,
            reasons: entry.reasons.map(reason => ({ ...reason })),
            warnings: entry.warnings.map(warning => ({ ...warning }))
        };
    }

    function isActive(id) {
        const entries = snapshot().entries;
        return Object.prototype.hasOwnProperty.call(entries, id) ? entries[id].active : false;
    }

    function unavailable() {
        return catalog.FEATURE_IDS.filter(id => !isActive(id)).map(availability);
    }

    /**
     * Whether the execution surfaces must refuse `id` right now.
     *
     * `isActive` reports the effective value, which with no usable state
     * file is today's legacy switch. The existing code already honours those
     * switches in its own way (an unmounted router, a command that answers
     * "not enabled", a token route that stays open on purpose), and the
     * compatibility rule is that an installation without `features.json`
     * behaves exactly as before. So a refusal is enforced only when the
     * state file is in force, when `GOOBSTER_FEATURE_<ID>` forces the
     * feature off, or when a hard dependency is itself enforced off.
     * Adoption (the first write) turns enforcement on for every feature.
     */
    function enforcedOff(id, seen = new Set()) {
        if (isActive(id)) return false;
        if (seen.has(id)) return false;
        seen.add(id);
        const entries = snapshot().entries;
        if (!Object.prototype.hasOwnProperty.call(entries, id)) return true;
        if (snapshot().loaded.parsed) return true;
        return entries[id].reasons.some(reason =>
            reason.code === 'ENV_OFF'
            || (reason.code === 'DEPENDENCY_INACTIVE' && reason.dependency && enforcedOff(reason.dependency, seen)));
    }

    /** The features the surfaces refuse right now (a subset of `unavailable()`). */
    function enforcedUnavailable() {
        return catalog.FEATURE_IDS.filter(id => enforcedOff(id)).map(availability);
    }

    function status() {
        const { loaded, entries } = snapshot();
        const features = {};
        for (const id of catalog.FEATURE_IDS) {
            const entry = entries[id];
            features[id] = {
                installed: entry.installed,
                configured: entry.configured,
                active: entry.active,
                pending: entry.pending,
                requested: entry.requested,
                pendingActive: entry.pendingActive,
                reasons: entry.reasons.map(reason => ({ ...reason })),
                warnings: entry.warnings.map(warning => ({ ...warning }))
            };
        }
        const usable = loaded.parsed;
        return {
            source: usable ? 'file' : 'none',
            version: usable ? usable.version : null,
            revision: usable ? usable.revision : null,
            origin: usable ? usable.origin : null,
            error: loaded.error ? loaded.error.toJSON() : null,
            features
        };
    }

    /**
     * What the effective legacy switches say right now, as a state document.
     * `active` follows dependencies, so the document is always writable:
     * a feature whose dependency is legacy-off seeds as off.
     */
    function seedFromLegacy() {
        const memoActive = {};
        const seeded = (id) => {
            if (memoActive[id] === undefined) {
                memoActive[id] = legacyRequested(id) && catalog.get(id).dependsOn.every(dep => dep === CORE_ID || seeded(dep));
            }
            return memoActive[id];
        };
        const features = {};
        for (const id of MANAGEABLE_IDS) features[id] = { installed: true, active: seeded(id) };
        return { version: STATE_VERSION, revision: 0, updatedAt: null, origin: 'legacy-seed', features };
    }

    /** The #261 new-install preset from each descriptor's freshDefault. */
    function freshPreset() {
        const features = {};
        for (const id of MANAGEABLE_IDS) {
            features[id] = { installed: true, active: catalog.get(id).freshDefault !== 'off' };
        }
        return { version: STATE_VERSION, revision: 0, updatedAt: null, origin: 'fresh-preset', features };
    }

    /** Shape, ids, installed/active coherence and dependency closure of a document about to be written. */
    function normalizeForWrite(doc) {
        if (!isPlainObject(doc)) throw new FeatureStateError('INVALID_STATE', 'A state document must be an object.');
        const origin = doc.origin === undefined ? 'operator' : doc.origin;
        if (!ORIGINS.includes(origin)) {
            throw new FeatureStateError('INVALID_STATE', `"origin" must be one of ${ORIGINS.join(', ')}.`);
        }
        const input = doc.features === undefined ? {} : doc.features;
        if (!isPlainObject(input)) throw new FeatureStateError('INVALID_STATE', '"features" must be an object.');

        for (const id of Object.keys(input)) {
            if (id === CORE_ID) {
                throw new FeatureStateError('CORE_IMMUTABLE', '"core" is always available and cannot be written.', { feature: id });
            }
            if (!catalog.get(id)) {
                throw new FeatureStateError('UNKNOWN_FEATURE', `Unknown feature "${id}".`, { feature: id });
            }
        }

        const seed = seedFromLegacy().features;
        const features = {};
        for (const id of MANAGEABLE_IDS) {
            const entry = input[id] === undefined ? seed[id] : input[id];
            if (!isPlainObject(entry)) {
                throw new FeatureStateError('INVALID_STATE', `Entry "${id}" must be an object.`, { feature: id });
            }
            const installed = entry.installed === undefined ? true : entry.installed;
            if (typeof installed !== 'boolean' || typeof entry.active !== 'boolean') {
                throw new FeatureStateError('INVALID_STATE', `Entry "${id}" needs boolean "installed" and "active".`, { feature: id });
            }
            if (entry.pendingActive !== undefined && entry.pendingActive !== null && typeof entry.pendingActive !== 'boolean') {
                throw new FeatureStateError('INVALID_STATE', `Entry "${id}": "pendingActive" must be true or false.`, { feature: id });
            }
            const hasPending = typeof entry.pendingActive === 'boolean' && entry.pendingActive !== entry.active;
            if (!installed && (entry.active || (hasPending && entry.pendingActive))) {
                throw new FeatureStateError('INVALID_STATE', `"${id}" is not installed and cannot be active.`, { feature: id });
            }
            features[id] = { installed, active: entry.active };
            if (hasPending) features[id].pendingActive = entry.pendingActive;
        }

        const conflicts = [];
        const check = (valueOf) => {
            for (const id of MANAGEABLE_IDS) {
                if (!valueOf(id)) continue;
                for (const dep of catalog.get(id).dependsOn) {
                    if (dep !== CORE_ID && !valueOf(dep) && !conflicts.some(c => c.feature === id && c.dependency === dep)) {
                        conflicts.push({ feature: id, dependency: dep });
                    }
                }
            }
        };
        check(id => features[id].active);
        check(id => (features[id].pendingActive === undefined ? features[id].active : features[id].pendingActive));
        if (conflicts.length > 0) {
            const text = conflicts.map(c => `"${c.feature}" needs "${c.dependency}"`).join(', ');
            throw new FeatureStateError('DEPENDENCY_CONFLICT', `Dependencies are not satisfied: ${text}. Dependencies are never enabled automatically.`, { conflicts });
        }
        return { origin, features };
    }

    /**
     * Atomically replace the file: validate, check the revision, write
     * `<file>.tmp`, rename over the target. A leftover tmp file from an
     * interrupted write is ignored by reads and overwritten here. Does not
     * change the running snapshot; call refresh() deliberately.
     *
     * @param {Object} doc { origin?, features }
     * @param {{ expectedRevision?: number|null }} [opts] null/0 means "no file yet"
     */
    async function write(doc, { expectedRevision = null } = {}) {
        const expected = expectedRevision === null || expectedRevision === undefined ? 0 : expectedRevision;
        if (!Number.isInteger(expected) || expected < 0) {
            throw new FeatureStateError('INVALID_STATE', '"expectedRevision" must be null or a non-negative integer.');
        }
        const normalized = normalizeForWrite(doc);

        const current = load();
        if (current.error) throw current.error;
        const actual = current.exists ? current.parsed.revision : 0;
        if (actual !== expected) throw new StaleRevisionError(expected, actual);

        const out = {
            version: STATE_VERSION,
            revision: expected + 1,
            updatedAt: formatUtc(now()),
            origin: normalized.origin,
            features: normalized.features
        };
        const tmpPath = `${filePath}.tmp`;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        try {
            fs.writeFileSync(tmpPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
            fs.renameSync(tmpPath, filePath);
        } catch (error) {
            try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean */ }
            throw error;
        }
        return out;
    }

    const state = {
        filePath,
        load,
        snapshot: () => snapshot().view,
        refresh() {
            refresh();
            return state.snapshot();
        },
        isActive,
        availability,
        unavailable,
        enforcedOff: (id) => enforcedOff(id),
        enforcedUnavailable,
        status,
        seedFromLegacy,
        freshPreset,
        write
    };
    return state;
}

let singleton = null;
let singletonOptions = {};

function current() {
    if (!singleton) singleton = createFeatureState(singletonOptions);
    return singleton;
}

/**
 * The process-wide resolver, created on first use. A Proxy so that
 * `features.isActive(id)` always reaches the current instance, including
 * after `_resetForTests`.
 */
const features = new Proxy({}, {
    get(_target, property) {
        if (property === '_resetForTests') {
            return (opts = {}) => {
                singletonOptions = opts;
                singleton = null;
                return features;
            };
        }
        const value = current()[property];
        return typeof value === 'function' ? value.bind(current()) : value;
    },
    has: (_target, property) => property === '_resetForTests' || property in current()
});

module.exports = {
    STATE_VERSION,
    ORIGINS,
    FeatureStateError,
    StaleRevisionError,
    createFeatureState,
    createPathProbe,
    envVarFor,
    features
};
