'use strict';

/**
 * Feature boundaries in the portal bundle (documentation/packaging.md,
 * issue #328). Build once, prune by manifest.
 *
 * At build time apps/web/vite.config.ts hands the module graph to
 * `labelModules`: every module reachable from the app entry without passing
 * through a feature room's lazy route module is `core`; a module reachable
 * only through the route modules of one feature (or of a feature and those
 * it requires) belongs to that feature. Rollup's normal code splitting is
 * kept; a chunk whose modules all belong to one feature is written as
 * `assets/feature-<id>-<name>-<hash>.js`, and so is its stylesheet.
 *
 * After the build `analyseDist` reads `dist/.vite/manifest.json`, labels
 * every emitted file, and checks the closure: a core chunk never statically
 * imports a feature chunk (the lazy route import is the only way in), and a
 * feature chunk imports only core chunks, its own, and those of the features
 * it requires. `writeFeatureChunks` records the labels in
 * `dist/feature-chunks.json`; `pruneDist` deletes the files (and their
 * sourcemaps) of the features a payload leaves out and writes
 * `dist/installed-features.json`.
 */

const fs = require('node:fs');
const path = require('node:path');

const CORE = 'core';
const FEATURE_FILE = /^assets\/feature-([A-Za-z0-9]+)-/;
const CHUNKS_FILE = 'feature-chunks.json';
const INSTALLED_FILE = 'installed-features.json';
const VERSION = 1;

/**
 * `{ module, feature }` for every room or view in apps/web/src/lib/rooms.cjs
 * that names a `chunk`: the lazy route modules (paths relative to
 * apps/web/src, as `main.tsx` imports them) that open a feature's code.
 */
function featureRouteModules(rooms) {
    const out = [];
    const visit = (entry) => {
        if (entry?.chunk) for (const module of entry.chunk.modules) out.push({ module, feature: entry.chunk.feature });
        for (const view of entry?.views || []) visit(view);
    };
    for (const room of rooms.ROOMS) visit(room);
    return out;
}

/** `id` -> every feature it requires, transitively (not itself). */
function requiresOf(catalog) {
    const out = {};
    for (const id of catalog.FEATURE_IDS) out[id] = catalog.closure([id]).filter(other => other !== id);
    return out;
}

/**
 * Label every module of a Rollup build.
 * @param {Object} params
 * @param {Iterable<string>} params.moduleIds
 * @param {(id: string) => ({ isEntry: boolean, importedIds: string[], dynamicallyImportedIds: string[] } | null)} params.getModuleInfo
 * @param {Map<string, string>} params.entries   absolute route module id -> feature
 * @param {Object<string, string[]>} params.requires
 * @returns {Map<string, string>} module id -> feature id or 'core'
 */
function labelModules({ moduleIds, getModuleInfo, entries, requires }) {
    const ids = [...moduleIds];
    const edges = (id) => {
        const info = getModuleInfo(id);
        return info ? [...info.importedIds, ...info.dynamicallyImportedIds] : [];
    };
    const core = new Set();
    const stack = ids.filter(id => getModuleInfo(id)?.isEntry && !entries.has(id));
    while (stack.length) {
        const id = stack.pop();
        if (core.has(id) || entries.has(id)) continue;
        core.add(id);
        stack.push(...edges(id));
    }

    const reachers = new Map();
    for (const [entry, feature] of entries) {
        const seen = new Set();
        const walk = [entry];
        while (walk.length) {
            const id = walk.pop();
            if (seen.has(id) || core.has(id)) continue;
            if (id !== entry && entries.has(id)) continue;
            seen.add(id);
            if (!reachers.has(id)) reachers.set(id, new Set());
            reachers.get(id).add(feature);
            walk.push(...edges(id));
        }
    }

    const labels = new Map();
    for (const id of ids) {
        const set = reachers.get(id);
        if (core.has(id) || !set) {
            labels.set(id, CORE);
            continue;
        }
        const features = [...set];
        const base = features.find(candidate => features.every(other => other === candidate || (requires[other] || []).includes(candidate)));
        labels.set(id, base || CORE);
    }
    return labels;
}

/**
 * The feature every module of a chunk belongs to, or null when any is core
 * or they disagree. Package modules follow the application modules beside
 * them: the graph reaches a side-effect-free package's whole index, and
 * Rollup places what is really used next to its user.
 */
function chunkFeature(moduleIds, labels) {
    const own = moduleIds.filter(id => !/[\\/]node_modules[\\/]/.test(id));
    let feature = null;
    for (const id of own.length ? own : moduleIds) {
        const label = labels.get(id);
        if (!label || label === CORE) return null;
        if (feature && feature !== label) return null;
        feature = label;
    }
    return feature;
}

function fileFeature(file) {
    return FEATURE_FILE.exec(file)?.[1] || CORE;
}

/**
 * Label the files of a built dist and check the closure.
 * @param {string} dist
 * @param {Object} params
 * @param {Object<string, string[]>} params.requires
 * @param {Object<string, string[]>} [params.frontend]  feature -> declared chunk ids (descriptor `payload.frontend`)
 * @returns {{ chunks: Object<string, string>, features: Object<string, number>, violations: Array<Object> }}
 */
function analyseDist(dist, { requires, frontend = {} }) {
    const manifestPath = path.join(dist, '.vite', 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw Object.assign(new Error(`No Vite manifest at ${manifestPath}; build with build.manifest`), { code: 'NO_VITE_MANIFEST' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const chunks = {};
    const violations = [];
    const label = file => fileFeature(file);
    for (const entry of Object.values(manifest)) {
        chunks[entry.file] = label(entry.file);
        for (const css of entry.css || []) chunks[css] = label(css);
    }
    for (const [key, entry] of Object.entries(manifest)) {
        const own = label(entry.file);
        const allowed = new Set([CORE, own, ...(requires[own] || [])]);
        for (const css of entry.css || []) {
            const other = label(css);
            if (other !== CORE && !allowed.has(other)) violations.push({ kind: 'css', from: entry.file, to: css });
        }
        for (const dep of entry.imports || []) {
            const target = manifest[dep];
            if (!target) continue;
            const other = label(target.file);
            if (own === CORE ? other !== CORE : !allowed.has(other)) violations.push({ kind: 'import', from: entry.file, to: target.file, source: key });
        }
        if (own === CORE) continue;
        for (const dep of entry.dynamicImports || []) {
            const target = manifest[dep];
            if (!target) continue;
            const other = label(target.file);
            if (!allowed.has(other)) violations.push({ kind: 'dynamicImport', from: entry.file, to: target.file, source: key });
        }
    }
    const features = {};
    for (const feature of Object.values(chunks)) if (feature !== CORE) features[feature] = (features[feature] || 0) + 1;
    for (const feature of Object.keys(features)) {
        if (!(frontend[feature] || []).includes(feature)) violations.push({ kind: 'undeclared', feature });
    }
    for (const [feature, list] of Object.entries(frontend)) {
        if (list.length && !features[feature]) violations.push({ kind: 'missing', feature });
    }
    const sorted = {};
    for (const file of Object.keys(chunks).sort()) sorted[file] = chunks[file];
    return { chunks: sorted, features, violations };
}

/**
 * The setup client (apps/web/setup.html, built into `<dist>/setup`) belongs to
 * no feature: the manager serves it before any feature is chosen. It is not in
 * feature-chunks.json, so the payload manifest owns every file of it as core;
 * this is the check that keeps that true - the page is there and no file in
 * the folder carries a feature's chunk name.
 * @param {string} dist
 * @returns {string[]} problems (empty when the setup client is sound)
 */
function checkSetupClient(dist) {
    const dir = path.join(dist, 'setup');
    const problems = [];
    if (!fs.existsSync(path.join(dir, 'index.html'))) return ['setup/index.html is missing'];
    const walk = (current, rel) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const name = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(current, entry.name), name);
            else if (FEATURE_FILE.test(name)) problems.push(`${name} is named like a feature chunk`);
        }
    };
    walk(dir, '');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const referenced = [...html.matchAll(/(?:src|href)="\/manager\/(assets\/[^"]+)"/g)].map(match => match[1]);
    if (referenced.length === 0) problems.push('setup/index.html references no script');
    for (const file of referenced) if (!fs.existsSync(path.join(dir, file))) problems.push(`${file} is referenced but missing`);
    return problems;
}

function writeFeatureChunks(dist, analysis) {
    const body = { version: VERSION, chunks: analysis.chunks };
    fs.writeFileSync(path.join(dist, CHUNKS_FILE), `${JSON.stringify(body, null, 2)}\n`);
    return body;
}

function readFeatureChunks(dist) {
    const file = path.join(dist, CHUNKS_FILE);
    if (!fs.existsSync(file)) return null;
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (body?.version !== VERSION || !body.chunks || typeof body.chunks !== 'object') {
        throw Object.assign(new Error(`${CHUNKS_FILE} is not version ${VERSION}`), { code: 'BAD_FEATURE_CHUNKS' });
    }
    return body;
}

/**
 * Remove the chunks, stylesheets and sourcemaps of every feature not in
 * `installed`, and record what the dist carries.
 * @param {string} dist
 * @param {{ installed: string[] }} selection  installed feature ids (core implied)
 * @returns {{ removed: string[], installed: string[] }}
 */
function pruneDist(dist, { installed }) {
    const map = readFeatureChunks(dist);
    if (!map) throw Object.assign(new Error(`${CHUNKS_FILE} missing from ${dist}`), { code: 'NO_FEATURE_CHUNKS' });
    const keep = new Set([CORE, ...installed]);
    const removed = [];
    for (const [file, feature] of Object.entries(map.chunks)) {
        if (keep.has(feature)) continue;
        for (const candidate of [file, `${file}.map`]) {
            const full = path.join(dist, candidate);
            if (!path.resolve(full).startsWith(path.resolve(dist) + path.sep)) continue;
            if (fs.existsSync(full)) {
                fs.rmSync(full);
                removed.push(candidate);
            }
        }
    }
    const ids = [...new Set(installed)].filter(id => id !== CORE).sort();
    fs.writeFileSync(path.join(dist, INSTALLED_FILE), `${JSON.stringify({ version: VERSION, features: ids }, null, 2)}\n`);
    return { removed: removed.sort(), installed: ids };
}

module.exports = {
    CORE,
    FEATURE_FILE,
    CHUNKS_FILE,
    INSTALLED_FILE,
    featureRouteModules,
    requiresOf,
    labelModules,
    chunkFeature,
    fileFeature,
    analyseDist,
    checkSetupClient,
    writeFeatureChunks,
    readFeatureChunks,
    pruneDist
};
