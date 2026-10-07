/**
 * The installation record the manager keeps in `installation.json`
 * (documentation/manager_install.md, issue #329).
 *
 * Version 2 extends the #323 identity (`installationId`, owner claim,
 * revision, origin) with what the setup engine owns: the layout, the roots,
 * the runtime user, owned roots / services / dependencies, who updates the
 * instance, and the release it runs. A record made by `claim` (or the label
 * form of `adopt`) has none of that and stays version 1; reading it yields
 * the same fields as `null`, so every reader sees one shape.
 *
 * Nothing here holds a secret, a file listing or a config value: roots are
 * installer-owned directories, never the contents under them.
 */

const path = require('node:path');
const { isInside } = require('./paths');

const INSTALL_FIELDS_VERSION = 2;
const LAYOUTS = Object.freeze(['lite', 'standalone', 'paired']);
const ORIGINS = Object.freeze(['claim', 'adopt', 'install']);
const SERVICE_KINDS = Object.freeze(['systemd', 'pm2', 'docker', 'windows-service', 'launchd', 'none']);
const UPDATER_KINDS = Object.freeze(['manager', 'auto-update.sh', 'pm2', 'none']);
const DEPENDENCY_KINDS = Object.freeze(['binary', 'python-venv', 'npm', 'service', 'library']);
const ROOT_ROLES = Object.freeze(['code', 'data', 'config', 'cache', 'logs', 'uploads', 'managerStore']);
const PAYLOAD_DIRS = Object.freeze(['current', 'previous', 'staging', 'releases']);
const DB_ENGINES = Object.freeze(['sqlite', 'postgres']);

const isText = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

/** Default roots for an install root: the layout `GOOBSTER_WORKSPACE_ROOT=<code>` gives the application. */
function defaultRoots(code) {
    const root = path.resolve(code);
    return {
        code: root,
        data: path.join(root, 'data'),
        config: path.join(root, 'config.json'),
        cache: path.join(root, 'cache'),
        logs: path.join(root, 'logs'),
        uploads: path.join(root, 'data', 'web-uploads'),
        managerStore: path.join(root, 'data', 'manager')
    };
}

/** Environment the application needs to find these roots (never printed with a secret). */
function envForRoots(roots) {
    return {
        GOOBSTER_WORKSPACE_ROOT: roots.code,
        GOOBSTER_DATA_DIR: roots.data,
        GOOBSTER_CONFIG_PATH: roots.config,
        GOOBSTER_CACHE_DIR: roots.cache,
        GOOBSTER_LOG_DIR: roots.logs,
        GOOBSTER_MANAGER_STATE_DIR: roots.managerStore
    };
}

/**
 * Roots the engine owns for an installation: roots only, never a listing.
 * `scope` says how much of the path is ours: `payload` is only the
 * `current/previous/staging/releases` directories of the code root,
 * `tree` is the whole directory, `file` one file.
 */
function ownedFiles({ origin, roots }) {
    const out = [];
    if (origin === 'install') out.push({ role: 'code', path: roots.code, scope: 'payload' });
    out.push({ role: 'data', path: roots.data, scope: 'tree' });
    out.push({ role: 'config', path: roots.config, scope: 'file' });
    out.push({ role: 'cache', path: roots.cache, scope: 'tree' });
    out.push({ role: 'logs', path: roots.logs, scope: 'tree' });
    if (!isInside(roots.data, roots.uploads) && roots.uploads !== roots.data) out.push({ role: 'uploads', path: roots.uploads, scope: 'tree' });
    return out;
}

function validRoots(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out = {};
    for (const role of ROOT_ROLES) {
        if (!isText(value[role]) || !path.isAbsolute(value[role])) return null;
        out[role] = value[role];
    }
    return out;
}

function validService(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (!SERVICE_KINDS.includes(entry.kind) || !isText(entry.name, 200)) return null;
    if (!['installer', 'system', 'operator', 'unknown'].includes(entry.registeredBy)) return null;
    return { kind: entry.kind, name: entry.name, registeredBy: entry.registeredBy };
}

function validDependency(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (!isText(entry.name, 200) || !DEPENDENCY_KINDS.includes(entry.kind) || !['installer', 'system'].includes(entry.ownedBy)) return null;
    return { name: entry.name, kind: entry.kind, ownedBy: entry.ownedBy };
}

function validOwned(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.files) || !Array.isArray(value.services) || !Array.isArray(value.dependencies)) return null;
    const filesOut = [];
    for (const entry of value.files) {
        if (!entry || !ROOT_ROLES.includes(entry.role) || !isText(entry.path) || !path.isAbsolute(entry.path) || !['payload', 'tree', 'file'].includes(entry.scope)) return null;
        filesOut.push({ role: entry.role, path: entry.path, scope: entry.scope });
    }
    const services = value.services.map(validService);
    const dependencies = value.dependencies.map(validDependency);
    if (services.includes(null) || dependencies.includes(null)) return null;
    return { files: filesOut, services, dependencies };
}

function validUpdater(value) {
    if (!value || typeof value !== 'object' || !UPDATER_KINDS.includes(value.kind)) return null;
    if (value.unit !== undefined && !isText(value.unit, 200)) return null;
    return { kind: value.kind, ...(value.unit ? { unit: value.unit } : {}) };
}

function validRelease(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object') return undefined;
    if (!isText(value.releaseId, 200) || !isText(value.version, 100) || !isText(value.target, 100)) return undefined;
    if (!Array.isArray(value.features) || value.features.some(id => !isText(id, 100))) return undefined;
    return { releaseId: value.releaseId, version: value.version, target: value.target, features: [...value.features] };
}

function validDatabase(value) {
    if (!value || typeof value !== 'object' || !DB_ENGINES.includes(value.engine) || typeof value.external !== 'boolean') return null;
    return { engine: value.engine, external: value.external };
}

/**
 * The install section of a raw record: the fields version 2 adds. Returns
 * `{ ok: true, install }` (all `null` for a record without them) or
 * `{ ok: false }` for a record that claims to have them and is malformed.
 */
function readInstallFields(raw) {
    const absent = raw.layout === undefined && raw.roots === undefined && raw.owned === undefined && raw.release === undefined;
    if (absent) return { ok: true, install: emptyInstall() };
    if (!LAYOUTS.includes(raw.layout)) return { ok: false };
    const roots = validRoots(raw.roots);
    const owned = validOwned(raw.owned);
    const updater = validUpdater(raw.updater);
    const release = validRelease(raw.release === undefined ? null : raw.release);
    const database = validDatabase(raw.database);
    if (!roots || !owned || !updater || release === undefined || !database) return { ok: false };
    if (raw.runtimeUser !== undefined && raw.runtimeUser !== null && !isText(raw.runtimeUser, 100)) return { ok: false };
    return {
        ok: true,
        install: {
            layout: raw.layout,
            roots,
            runtimeUser: raw.runtimeUser || null,
            owned,
            updater,
            release,
            database,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
        }
    };
}

function emptyInstall() {
    return { layout: null, roots: null, runtimeUser: null, owned: null, updater: null, release: null, database: null, updatedAt: null };
}

/** True when the record carries the engine's section (it has been installed or adopted with roots). */
function isManaged(doc) {
    return Boolean(doc && doc.roots);
}

module.exports = {
    INSTALL_FIELDS_VERSION,
    LAYOUTS,
    ORIGINS,
    SERVICE_KINDS,
    UPDATER_KINDS,
    DEPENDENCY_KINDS,
    ROOT_ROLES,
    PAYLOAD_DIRS,
    DB_ENGINES,
    defaultRoots,
    envForRoots,
    ownedFiles,
    isInside,
    readInstallFields,
    emptyInstall,
    isManaged
};
