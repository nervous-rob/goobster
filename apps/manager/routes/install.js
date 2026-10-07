/**
 * Install routes of the manager API (documentation/setup_wizard.md), under
 * /manager/api. All are reads: changing the installation is an operation
 * (`install.new`, `install.reconfigure`, `install.repair`, `install.uninstall`,
 * `owner.create`, `lifecycle.start`, `lifecycle.stop`).
 *
 *   GET /install/suggest      readAuth  the platform's suggested roots, the allowed bases and their free
 *                                       space, the detected layout and candidate installations, the
 *                                       release sources found, and the fixed roots of this manager
 *   GET /install/source?dir=  readAuth  the features, sizes and system prerequisites a release source
 *                                       directory carries (its manifest only; nothing is hashed or staged)
 *   GET /install/record      readAuth  the sanitised installation record: layout, roots, release,
 *                                       features, database engine, services; no label, secret or listing
 *   GET /install/first-run   readAuth  the first-run checklist: workers, portal health, database,
 *                                       features file, configuration, owner account - pass or fail
 *                                       with a recovery hint for each
 *
 * Nothing here returns a credential, a config value or a file's content.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagerError } = require('../errors');
const model = require('../install/model');
const paths = require('../install/paths');
const release = require('../install/release');
const registry = require('../lifecycle/registry');
const { checkHealth } = require('../lifecycle/health');

const MAX_DIR = 4096;
const SOURCE_NAMES = ['', 'current', 'payload', 'release'];

function freeBytes(target, fs, statfs) {
    let current = path.resolve(target);
    for (let depth = 0; depth < 64; depth++) {
        try {
            const stat = (statfs || fs.statfsSync || nodeFs.statfsSync)(current);
            return Number(stat.bavail) * Number(stat.bsize);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    }
    return null;
}

function sourceSummary(dir, fs) {
    const { manifest, releaseId, dir: real } = release.loadManifest(dir, fs);
    const size = new Map(manifest.files.map(file => [file.path, file.size]));
    const features = Object.keys(manifest.groups).sort((a, b) => (a === 'core' ? -1 : b === 'core' ? 1 : (a < b ? -1 : 1))).map((id) => {
        const group = manifest.groups[id];
        return {
            id,
            bytes: (group.files || []).reduce((sum, rel) => sum + (size.get(rel) || 0), 0),
            requires: group.requires || [],
            system: (group.system || []).map(item => ({ name: item.name, kind: item.kind }))
        };
    });
    return {
        dir: real,
        releaseId,
        version: manifest.release.core,
        target: manifest.target.id,
        features,
        totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0)
    };
}

function createInstallMount() {
    return function mountInstallRoutes(api, helpers) {
        const { route, readAuth, manager } = helpers;
        const settings = manager.settings;
        const fs = helpers.fs || nodeFs;
        const deps = () => settings.installDeps || {};

        function core() {
            const { createInstallCore } = require('../install/engine');
            return createInstallCore({ settings, fs });
        }

        function platformInfo() {
            const platform = deps().platform || process.platform;
            const home = deps().home || os.homedir();
            const env = settings.env || process.env;
            return { platform, home, env };
        }

        api.get('/install/suggest', route(async (req) => {
            readAuth(req);
            const { platform, home, env } = platformInfo();
            const bases = paths.allowedBases({ home, platform, env });
            const roots = core().resolveRoots();
            const fixed = [];
            if (roots.data === settings.dataDir) fixed.push('data');
            if (roots.config === settings.configPath) fixed.push('config');
            if (roots.managerStore === settings.storeDir) fixed.push('managerStore');
            const insideBase = (target) => paths.isUnderAllowedBase(target, bases, { platform, fs });
            const layouts = require('../lifecycle/layouts');
            const config = require('../manager').readConfigJson(settings.configPath, fs).config;
            const resolved = layouts.resolveLayout({ env, config });

            let discovered = { candidates: [], searched: 0 };
            try {
                const found = await (deps().discover || require('../install/discover').discover)({ settings, fs, env, home });
                if (found && Array.isArray(found.candidates)) discovered = found;
            } catch { }

            const sources = [];
            const seen = new Set();
            const probes = Array.isArray(deps().sourceCandidates)
                ? deps().sourceCandidates
                : SOURCE_NAMES.map(name => path.join(settings.root, name));
            for (const dir of probes) {
                try {
                    const summary = sourceSummary(dir, fs);
                    if (seen.has(summary.dir)) continue;
                    seen.add(summary.dir);
                    sources.push(summary);
                } catch { }
            }

            return {
                platform,
                separator: platform === 'win32' ? '\\' : '/',
                bases: bases.map(base => ({ path: base, freeBytes: freeBytes(base, fs, deps().statfs) })),
                roots: Object.fromEntries(model.ROOT_ROLES.map(role => [role, {
                    path: roots[role],
                    fixed: fixed.includes(role),
                    allowed: insideBase(roots[role]),
                    freeBytes: role === 'code' ? freeBytes(roots[role], fs, deps().statfs) : undefined
                }])),
                layout: { suggested: resolved.layout, source: resolved.source, ready: resolved.error === null, problem: resolved.error, available: model.LAYOUTS },
                database: { engines: [{ engine: 'sqlite', available: true }, { engine: 'postgres', available: false }], configured: settings.dbUrl ? 'postgres' : 'sqlite' },
                ports: (() => {
                    const { portsFor } = require('../install/preflight');
                    const out = portsFor({ layout: resolved.layout, features: [], env, settings });
                    return { workers: out.list, manager: out.managerPort, lan: Boolean(settings.lan), host: settings.host };
                })(),
                candidates: discovered.candidates.map(candidate => ({
                    id: candidate.id,
                    kind: candidate.kind,
                    layout: candidate.layout,
                    dbEngine: candidate.dbEngine,
                    code: candidate.roots.code,
                    evidence: candidate.evidence
                })),
                sources
            };
        }));

        api.get('/install/source', route((req) => {
            readAuth(req);
            const dir = req.query.dir;
            if (typeof dir !== 'string' || dir.length === 0 || dir.length > MAX_DIR || dir.includes('\0') || !path.isAbsolute(dir)) {
                throw new ManagerError(400, 'INVALID_INPUT', '"dir" must be an absolute path to a release directory.');
            }
            try {
                return sourceSummary(dir, fs);
            } catch (error) {
                throw release.mapPayloadError(error) || error;
            }
        }));

        api.get('/install/record', route((req) => {
            readAuth(req);
            const read = manager.store.readInstallation();
            if (read.status !== 'ok') return { installed: false, status: read.status, record: null };
            const doc = read.doc;
            const managed = model.isManaged(doc);
            return {
                installed: managed,
                status: 'ok',
                record: {
                    installationId: doc.installationId,
                    origin: doc.origin,
                    createdAt: doc.createdAt,
                    updatedAt: doc.updatedAt || null,
                    revision: doc.revision,
                    layout: doc.layout || null,
                    roots: doc.roots || null,
                    release: doc.release || null,
                    database: doc.database || null,
                    updater: doc.updater || null,
                    services: doc.owned ? doc.owned.services : [],
                    dependencies: doc.owned ? doc.owned.dependencies : []
                }
            };
        }));

        api.get('/install/first-run', route(async (req) => {
            readAuth(req);
            const checks = await firstRun();
            return { ok: checks.every(item => item.ok === true), checks };
        }));

        async function firstRun() {
            const out = [];
            const add = (id, label, ok, detail, hint) => out.push({ id, label, ok, detail, hint: ok ? null : hint });
            const env = settings.env || process.env;
            const layouts = require('../lifecycle/layouts');
            const readConfig = require('../manager').readConfigJson(settings.configPath, fs);
            const resolved = layouts.resolveLayout({ env, config: readConfig.config });

            add('config', 'Settings file', readConfig.present && readConfig.readable && resolved.error === null,
                !readConfig.present ? 'config.json does not exist' : (!readConfig.readable ? 'config.json cannot be read' : (resolved.error ? 'the layout cannot run yet' : 'config.json is readable and the layout can run')),
                'Open Reconfigure and finish the settings this layout needs (a Discord token for the bot, or the web app switched on for the standalone layout).');

            let featuresOk = false;
            let featuresDetail = 'features.json cannot be read';
            try {
                const status = manager.createFeatureState().status();
                featuresOk = Boolean(status) && !status.error;
                featuresDetail = featuresOk ? 'the feature selection is readable' : featuresDetail;
            } catch { }
            add('features', 'Feature selection', featuresOk, featuresDetail,
                'Repair rewrites the feature selection from what you chose; nothing else is touched.');

            const checkOwner = deps().checkOwner || require('../install/owner').checkOwner;
            const read = manager.store.readInstallation();
            const doc = read.status === 'ok' ? read.doc : null;
            const roots = doc && model.isManaged(doc) ? doc.roots : { code: settings.root, data: settings.dataDir };
            const database = doc && doc.database ? doc.database : { engine: settings.dbUrl ? 'postgres' : 'sqlite', external: Boolean(settings.dbUrl) };
            const checked = await checkOwner({ roots, settings, database });
            add('database', 'Database', checked.ok === true, checked.ok === true ? `the ${database.engine} database opens` : 'the database could not be opened',
                'Run Repair: it opens the database again and applies the schema without touching your data.');
            add('owner', 'Owner account', checked.ok === true && Number(checked.operators) > 0,
                checked.ok !== true ? 'not checked: the database did not open' : (Number(checked.operators) > 0 ? 'an operator account exists' : 'no operator account yet'),
                'Create the owner account in the setup client, or sign in with Discord once the bot is connected.');

            const supervisor = registry.get(settings.storeDir);
            let workers = [];
            if (supervisor) {
                const view = await supervisor.status({ probe: true });
                workers = view.workers.map(worker => ({ name: worker.name, healthy: worker.healthy === true, acked: worker.ackedRevision !== null && worker.ackedRevision >= view.current, state: worker.state, lastExit: worker.lastExit || null }));
            } else if (resolved.error === null) {
                const view = layouts.workersFor({ settings, config: readConfig.config, env, sandboxActive: false });
                const health = await Promise.all(view.workers.map(worker => (deps().checkHealth || checkHealth)(worker.healthUrl)));
                workers = view.workers.map((worker, index) => ({ name: worker.name, healthy: health[index] === true, acked: null, state: 'unsupervised', lastExit: null }));
            }
            const notReady = workers.filter(worker => !worker.healthy || worker.acked === false);
            add('workers', 'Application processes', workers.length > 0 && notReady.length === 0,
                workers.length === 0 ? 'no worker is running' : (notReady.length === 0 ? `${workers.map(worker => worker.name).join(', ')} answered and acknowledged the current revision` : `${notReady.map(worker => worker.name).join(', ')} not ready`),
                supervisor
                    ? 'Look at the recent lines in the logs folder, fix what they name, then start again from the Host room or run Repair. If you cannot sign in, mint a recovery credential: node apps/manager/index.js --mint-recovery.'
                    : 'Nothing is running the application. Start the workers from this page, or start Goobster the way you normally do.');

            const portal = layouts.workersFor({ settings, config: readConfig.config, env, sandboxActive: false }).workers
                .find(worker => worker.name === (resolved.layout === 'standalone' ? 'api' : 'bot'));
            const portalHealthy = portal ? (workers.find(worker => worker.name === portal.name) || {}).healthy === true : false;
            add('portal', 'Web portal', portalHealthy, portalHealthy ? 'the portal answers its health check' : 'the portal does not answer yet',
                'Wait a few seconds and check again; if it stays down the process log in the logs folder says why.');
            return out;
        }
    };
}

module.exports = { createInstallMount, sourceSummary };
