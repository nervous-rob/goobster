'use strict';

/**
 * Release manifest v1 and payload selection (documentation/packaging.md,
 * issue #328).
 *
 * Pure and deterministic: reads the repository (tracked files, descriptors,
 * package-lock.json) and returns data; no timestamps, no host paths, no
 * environment values. scripts/package-runtime.js writes the result as
 * `payload-manifest.json`; the manager stages and applies selections with
 * scripts/lib/payloadStage.js and payloadApply.js.
 *
 * Ownership. Every source file has exactly one owner: the feature whose
 * descriptor `payload.files` glob matches it most specifically, or `core`.
 * npm packages are owned by whoever imports them (scripts/lib/requireGraph.js):
 * a plain import by a file counts for that file's owner, a
 * `requireOptional(spec, { feature })` import counts for the named feature.
 * A package's lockfile dependencies inherit its owners. A package with one
 * owner that is not core is **exclusive** to it; anything else is shared.
 * A production dependency nobody imports is **unreferenced** and is left out
 * of every payload (packaging_proof.md B5).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const { buildRequireGraph } = require('./requireGraph');
const { createOwnerMatcher } = require('../../packages/core/features/payloadGlob');

const MANIFEST_VERSION = 1;
const CORE = 'core';
/** Repository trees whose files are attributed to an owner. */
const SOURCE_ROOTS = ['packages/core', 'apps/bot', 'apps/api', 'apps/mcp', 'apps/sandbox', 'apps/web/src', 'campaigns', 'clients'];
/** Server trees the require graph walks (the portal client is chunked by Vite instead). */
const SERVER_ROOTS = ['packages/core', 'apps/bot', 'apps/api', 'apps/mcp', 'apps/sandbox', 'clients'];
/** Workspaces whose production dependency trees the payload installs. */
const PAYLOAD_WORKSPACES = ['packages/core', 'apps/api'];
const SANDBOX_WORKSPACE = 'apps/sandbox';
/**
 * Trees that only run inside one adapter's process: apps/bot is the Discord
 * adapter, so a command file owned by Music still executes only where
 * Discord does, and its package imports count for `discord`.
 */
const HOST_TREES = { 'apps/bot/': 'discord' };

function hostOf(file) {
    for (const [prefix, host] of Object.entries(HOST_TREES)) if (file.startsWith(prefix)) return host;
    return null;
}

function sortedUnique(values) {
    return [...new Set(values)].sort();
}

/** Canonical JSON: object keys sorted, two-space indent, LF, trailing newline. */
function canonicalJson(value) {
    const normalize = (item) => {
        if (Array.isArray(item)) return item.map(normalize);
        if (item && typeof item === 'object') {
            const out = {};
            for (const key of Object.keys(item).sort()) {
                if (item[key] !== undefined) out[key] = normalize(item[key]);
            }
            return out;
        }
        return item;
    };
    return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

/** Tracked repository files (POSIX, sorted); a filtered walk outside a git checkout. */
function listTrackedFiles(root) {
    const listed = childProcess.spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (listed.status === 0 && listed.stdout) {
        return listed.stdout.split('\0').filter(Boolean).filter(file => fs.existsSync(path.join(root, file))).sort();
    }
    const files = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) visit(rel);
            else if (entry.isFile()) files.push(rel);
        }
    };
    visit('');
    return files.sort();
}

function underAny(file, roots) {
    return roots.some(root => file === root || file.startsWith(`${root}/`));
}

/** `{ <id>: payload.files }` for every catalog entry, core's carve-outs included. */
function payloadGlobs(catalog) {
    const globs = {};
    for (const id of catalog.FEATURE_IDS) globs[id] = [...(catalog.FEATURES[id].payload?.files || [])];
    return globs;
}

// ---------------------------------------------------------------------------
// package-lock.json
// ---------------------------------------------------------------------------

function platformMatches(list, value) {
    if (!Array.isArray(list) || list.length === 0 || !value) return true;
    const allowed = list.filter(item => !item.startsWith('!'));
    const denied = list.filter(item => item.startsWith('!')).map(item => item.slice(1));
    if (denied.includes(value)) return false;
    return allowed.length === 0 || allowed.includes(value);
}

/** Node's lookup over lockfile keys: `<from>/node_modules/<name>`, then each ancestor, then the root. */
function resolveLockKey(packages, from, name) {
    let base = from;
    for (;;) {
        const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
        if (packages[candidate]) return candidate;
        if (!base) return null;
        const cut = base.lastIndexOf('/node_modules/');
        if (cut !== -1) base = base.slice(0, cut);
        else if (base.startsWith('node_modules/')) base = '';
        else base = '';
    }
}

function nameFromLockKey(key) {
    const at = key.lastIndexOf('node_modules/');
    return key.slice(at + 'node_modules/'.length);
}

function workspaceOf(file) {
    const match = /^(packages|apps)\/([^/]+)\//.exec(file);
    return match ? `${match[1]}/${match[2]}` : '';
}

/**
 * Production lockfile entries a payload installs for `workspaces`, filtered
 * to one platform/arch (npm skips optional packages for other targets).
 * @returns {Map<string, { parents: Set<string> }>} lock key -> who pulls it in
 */
function installedClosure(lock, workspaces, target) {
    const packages = lock.packages || {};
    const seen = new Map();
    const stack = [];
    const push = (from, name, parent) => {
        const key = resolveLockKey(packages, from, name);
        if (!key) return;
        const entry = packages[key];
        if (entry.link || entry.dev) return;
        if (!platformMatches(entry.os, target?.platform) || !platformMatches(entry.cpu, target?.arch)) return;
        if (!seen.has(key)) {
            seen.set(key, { parents: new Set() });
            stack.push(key);
        }
        seen.get(key).parents.add(parent);
    };
    for (const workspace of workspaces) {
        const entry = packages[workspace] || {};
        for (const name of Object.keys(entry.dependencies || {})) push(workspace, name, workspace);
        for (const name of Object.keys(entry.optionalDependencies || {})) push(workspace, name, workspace);
    }
    while (stack.length) {
        const key = stack.pop();
        const entry = packages[key];
        for (const name of Object.keys(entry.dependencies || {})) push(key, name, key);
        for (const name of Object.keys(entry.optionalDependencies || {})) push(key, name, key);
        for (const name of Object.keys(entry.peerDependencies || {})) {
            if (entry.peerDependenciesMeta?.[name]?.optional) continue;
            push(key, name, key);
        }
    }
    return seen;
}

// ---------------------------------------------------------------------------
// ownership
// ---------------------------------------------------------------------------

const probeCache = new Map();

/**
 * Package names among `candidates` that the installed package at `dir` names
 * as a whole string literal: a direct `require('x')` or a probe table of
 * optional backends (`['sodium-native', ...]`) that is required by name.
 */
function probedPackages(dir, candidates) {
    let text = probeCache.get(dir);
    if (text === undefined) {
        const chunks = [];
        const visit = (current, depth) => {
            let entries;
            try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (depth < 4 && !/^(test|tests|__tests__|example|examples|docs)$/.test(entry.name)) visit(full, depth + 1);
                } else if (/\.(c?js|mjs)$/.test(entry.name)) {
                    try {
                        const stat = fs.statSync(full);
                        if (stat.size < 4 * 1024 * 1024) chunks.push(fs.readFileSync(full, 'utf8'));
                    } catch { /* unreadable file */ }
                }
            }
        };
        visit(dir, 0);
        text = chunks.join('\n');
        probeCache.set(dir, text);
    }
    return candidates.filter((name) => {
        const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        return new RegExp(`(['"\`])${quoted}\\1`).test(text);
    });
}

/**
 * @param {Object} params
 * @param {string} params.root             repository root
 * @param {Object} params.catalog          packages/core/features/catalog.js
 * @param {string[]} [params.files]        tracked files (defaults to `git ls-files`)
 * @param {Object} [params.lock]           parsed package-lock.json
 * @param {{ platform: string, arch: string }} [params.target]
 * @param {boolean} [params.withSandbox]   include apps/sandbox's dependency tree
 */
function computeOwnership({ root, catalog, files, lock, target, withSandbox = true }) {
    const tracked = files || listTrackedFiles(root);
    const lockfile = lock || JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const globs = payloadGlobs(catalog);
    const match = createOwnerMatcher(globs);

    const owners = {};
    const conflicts = [];
    const globHits = {};
    for (const file of tracked) {
        if (!underAny(file, SOURCE_ROOTS)) continue;
        const hit = match(file);
        if (hit.conflict) conflicts.push({ file, owners: hit.conflict, glob: hit.glob });
        owners[file] = hit.owner || CORE;
        if (hit.glob) globHits[hit.glob] = (globHits[hit.glob] || 0) + 1;
    }
    const unmatchedGlobs = [];
    for (const [id, list] of Object.entries(globs)) {
        for (const glob of list) if (!globHits[glob]) unmatchedGlobs.push({ owner: id, glob });
    }

    const graph = buildRequireGraph({
        root,
        files: tracked.filter(file => underAny(file, SERVER_ROOTS)),
        knownFiles: tracked
    });

    // Direct package owners from the import edges.
    const packages = lockfile.packages || {};
    const directOwners = new Map();
    const missingPackages = [];
    for (const [file, node] of Object.entries(graph.files)) {
        for (const edge of node.edges) {
            if (!edge.package) continue;
            const owner = edge.kind === 'optional' ? edge.feature : (hostOf(file) || owners[file] || CORE);
            const key = resolveLockKey(packages, workspaceOf(file), edge.package);
            if (!key) {
                missingPackages.push({ from: file, package: edge.package });
                continue;
            }
            if (!directOwners.has(key)) directOwners.set(key, new Set());
            directOwners.get(key).add(owner);
        }
    }

    const workspaces = withSandbox ? [...PAYLOAD_WORKSPACES, SANDBOX_WORKSPACE] : PAYLOAD_WORKSPACES;
    const installed = installedClosure(lockfile, workspaces, target);

    // Propagate owners down the dependency tree.
    const pkgOwners = new Map();
    for (const key of installed.keys()) pkgOwners.set(key, new Set(directOwners.get(key) || []));
    const children = new Map();
    for (const [key, info] of installed) {
        for (const parent of info.parents) {
            if (!children.has(parent)) children.set(parent, new Set());
            children.get(parent).add(key);
        }
    }
    const propagate = () => {
        let changed = true;
        while (changed) {
            changed = false;
            for (const [parent, kids] of children) {
                const from = pkgOwners.get(parent);
                if (!from || from.size === 0) continue;
                for (const kid of kids) {
                    const set = pkgOwners.get(kid);
                    for (const owner of from) {
                        if (!set.has(owner)) {
                            set.add(owner);
                            changed = true;
                        }
                    }
                }
            }
        }
    };
    propagate();

    // A package can load another one its manifest does not list (an optional
    // codec or crypto backend, probed with a literal require). Read the
    // installed package sources for those literals before calling anything
    // unreferenced.
    const pluginOf = {};
    for (;;) {
        const orphans = [...installed.keys()].filter(key => pkgOwners.get(key).size === 0);
        const names = new Map(orphans.map(key => [nameFromLockKey(key), key]));
        if (names.size === 0) break;
        let adopted = false;
        for (const [key, set] of pkgOwners) {
            if (set.size === 0) continue;
            for (const name of probedPackages(path.join(root, key), [...names.keys()])) {
                const orphan = names.get(name);
                if (!orphan || orphan === key) continue;
                for (const owner of set) pkgOwners.get(orphan).add(owner);
                (pluginOf[orphan] = pluginOf[orphan] || new Set()).add(nameFromLockKey(key));
                adopted = true;
            }
        }
        if (!adopted) break;
        propagate();
    }

    const dependencies = [];
    const unreferenced = [];
    for (const key of [...installed.keys()].sort()) {
        const entry = packages[key];
        const name = nameFromLockKey(key);
        const set = pkgOwners.get(key);
        if (set.size === 0) {
            const parents = [...installed.get(key).parents].sort();
            const declaredBy = parents.filter(parent => !parent.includes('node_modules'));
            unreferenced.push({
                name,
                path: key,
                reason: declaredBy.length
                    ? `declared by ${declaredBy.join(', ')} but imported by no source file`
                    : `only required by unreferenced ${parents.map(nameFromLockKey).join(', ')}`
            });
            continue;
        }
        const list = [...set].sort();
        dependencies.push({
            name,
            version: entry.version || null,
            path: key,
            owners: list,
            exclusive: list.length === 1 && list[0] !== CORE,
            license: entry.license || null,
            installScript: Boolean(entry.hasInstallScript),
            ...(pluginOf[key] ? { loadedBy: [...pluginOf[key]].sort() } : {})
        });
    }

    return { owners, conflicts, unmatchedGlobs, graph, dependencies, unreferenced, missingPackages, globs };
}

// ---------------------------------------------------------------------------
// payload paths
// ---------------------------------------------------------------------------

/** Repository source path -> payload path (null when the payload does not carry it). */
function payloadPathOf(repoPath) {
    if (repoPath.startsWith('packages/core/')) return `app/node_modules/@goobster/core/${repoPath.slice('packages/core/'.length)}`;
    if (repoPath.startsWith('apps/api/') || repoPath.startsWith('apps/sandbox/')) return `app/${repoPath}`;
    if (/^(documentation|campaigns|clients)\//.test(repoPath)) return `app/${repoPath}`;
    return null;
}

/** Payload path -> repository source path (null for runtime, launchers, node_modules, dist). */
function repoPathOf(payloadPath) {
    const core = 'app/node_modules/@goobster/core/';
    if (payloadPath.startsWith(core)) {
        const rest = payloadPath.slice(core.length);
        return rest.startsWith('node_modules/') ? null : `packages/core/${rest}`;
    }
    if (payloadPath.startsWith('app/node_modules/')) return null;
    const rel = payloadPath.startsWith('app/') ? payloadPath.slice(4) : null;
    if (!rel) return null;
    if (/^apps\/(api|sandbox)\//.test(rel) && !rel.includes('/node_modules/')) return rel;
    if (/^(documentation|campaigns|clients|scripts)\//.test(rel)) return rel;
    return null;
}

/** Lockfile key -> payload directory. */
function payloadDirOfLockKey(key) {
    if (key.startsWith('node_modules/')) return `app/${key}`;
    if (key.startsWith('packages/core/')) return `app/node_modules/@goobster/core/${key.slice('packages/core/'.length)}`;
    if (key.startsWith('apps/')) return `app/${key}`;
    return null;
}

// ---------------------------------------------------------------------------
// release manifest
// ---------------------------------------------------------------------------

function compatibleRange(version) {
    const major = Number(String(version).split('.')[0]) || 0;
    return `>=${version} <${major + 1}.0.0`;
}

/**
 * Build release manifest v1.
 * @param {Object} params
 * @param {ReturnType<typeof computeOwnership>} params.ownership
 * @param {Object} params.catalog
 * @param {string} params.coreVersion
 * @param {{ id: string, platform: string, arch: string }} params.target
 * @param {{ version: string, abi: string }} params.node
 * @param {Array<{ path: string, sha256: string, size: number }>} [params.files]  payload files; defaults to the source files
 * @param {Object<string, string>} [params.chunks]   dist-relative chunk file -> feature id or 'core'
 * @param {Array<{ path: string }>} [params.nativeBinaries] binaries found in the payload
 * @param {string} [params.root]  repository root, to hash source files when `files` is omitted
 */
function buildReleaseManifest({ ownership, catalog, coreVersion, target, node, files, chunks = {}, nativeBinaries = [], root }) {
    const dependencies = ownership.dependencies.map((dep) => {
        const dir = payloadDirOfLockKey(dep.path);
        const binaries = dir ? nativeBinaries.filter(binary => binary.path.startsWith(`${dir}/`)).map(binary => binary.path).sort() : [];
        return {
            name: dep.name,
            version: dep.version,
            path: dir,
            owners: dep.owners,
            exclusive: dep.exclusive,
            native: (binaries.length || dep.installScript) ? { installScript: dep.installScript, binaries } : null,
            license: dep.license
        };
    });
    const depDirs = dependencies.filter(dep => dep.path).map(dep => dep.path).sort((a, b) => b.length - a.length);
    const depByDir = new Map(dependencies.map(dep => [dep.path, dep]));

    const fileList = files || Object.keys(ownership.owners)
        .map(repoPath => ({ repoPath, payloadPath: payloadPathOf(repoPath) }))
        .filter(item => item.payloadPath)
        .map(({ repoPath, payloadPath }) => {
            const content = fs.readFileSync(path.join(root, repoPath));
            return { path: payloadPath, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
        });

    const distPrefix = 'app/apps/web/dist/';
    const manifestFiles = [];
    const chunkEntries = [];
    for (const file of [...fileList].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const entry = { path: file.path, sha256: file.sha256, size: file.size, owner: CORE };
        const depDir = file.path.includes('/node_modules/') ? depDirs.find(dir => file.path.startsWith(`${dir}/`)) : null;
        if (depDir) {
            const dep = depByDir.get(depDir);
            entry.dependency = dep.name;
            entry.owner = dep.exclusive ? dep.owners[0] : CORE;
        } else if (file.path.startsWith(distPrefix)) {
            const rel = file.path.slice(distPrefix.length);
            const owner = chunks[rel] || chunks[rel.replace(/\.map$/, '')] || CORE;
            entry.owner = owner;
            if (chunks[rel]) chunkEntries.push({ file: rel, feature: owner, sha256: file.sha256, size: file.size });
        } else {
            const source = repoPathOf(file.path);
            if (source && ownership.owners[source]) entry.owner = ownership.owners[source];
        }
        manifestFiles.push(entry);
    }

    const groups = {};
    for (const id of catalog.FEATURE_IDS) {
        const descriptor = catalog.FEATURES[id];
        const group = {
            globs: [...(descriptor.payload?.files || [])],
            files: manifestFiles.filter(file => file.owner === id && !file.dependency).map(file => file.path),
            dependencies: sortedUnique(dependencies.filter(dep => dep.owners.includes(id)).map(dep => dep.name))
        };
        if (id !== CORE) {
            group.frontend = [...(descriptor.payload?.frontend || [])];
            group.system = (descriptor.payload?.system || []).map(entry => ({ name: entry.name, kind: entry.kind }));
            group.requires = [...descriptor.dependsOn];
        } else {
            group.system = (descriptor.payload?.system || []).map(entry => ({ name: entry.name, kind: entry.kind }));
        }
        groups[id] = group;
    }

    return {
        version: MANIFEST_VERSION,
        release: { core: coreVersion, compatibleCore: compatibleRange(coreVersion) },
        target: { id: target.id, platform: target.platform, arch: target.arch },
        node: { version: node.version, abi: String(node.abi) },
        groups,
        files: manifestFiles,
        dependencies: dependencies.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        frontend: { chunks: chunkEntries.sort((a, b) => (a.file < b.file ? -1 : 1)) },
        unreferenced: ownership.unreferenced.map(({ name, reason }) => ({ name, reason }))
    };
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

/** `ids` plus everything they require, from the manifest's own groups. */
function closeOverRequires(manifest, ids) {
    const wanted = new Set([CORE]);
    const add = (id) => {
        if (!manifest.groups[id]) throw Object.assign(new Error(`Unknown feature "${id}"`), { code: 'UNKNOWN_FEATURE' });
        if (wanted.has(id)) return;
        wanted.add(id);
        for (const dep of manifest.groups[id].requires || []) add(dep);
    };
    for (const id of ids) if (id !== CORE) add(id);
    return wanted;
}

/**
 * Resolve a selection against a release manifest.
 * @param {Object} manifest   release manifest v1
 * @param {{ features: string[] }} selection
 * @returns {{ features: string[], files: string[], dependencies: string[], chunks: string[],
 *   excluded: { features: string[], files: string[], dependencies: string[], chunks: string[] } }}
 *   dependencies are payload directories; chunks are dist-relative files
 */
function selectPayload(manifest, { features = [] } = {}) {
    const selected = closeOverRequires(manifest, features);
    const keepDep = new Map();
    for (const dep of manifest.dependencies) keepDep.set(dep.path, dep.owners.some(owner => selected.has(owner)));
    const depByName = new Map();
    for (const dep of manifest.dependencies) {
        if (!depByName.has(dep.name)) depByName.set(dep.name, []);
        depByName.get(dep.name).push(dep);
    }
    const keepFile = (file) => {
        if (file.dependency) {
            const dep = manifest.dependencies.filter(item => item.name === file.dependency && file.path.startsWith(`${item.path}/`))
                .sort((a, b) => b.path.length - a.path.length)[0];
            return dep ? keepDep.get(dep.path) : true;
        }
        return selected.has(file.owner);
    };
    const files = { keep: [], drop: [] };
    for (const file of manifest.files) (keepFile(file) ? files.keep : files.drop).push(file.path);
    const deps = { keep: [], drop: [] };
    for (const dep of manifest.dependencies) (keepDep.get(dep.path) ? deps.keep : deps.drop).push(dep.path);
    const chunks = { keep: [], drop: [] };
    for (const chunk of manifest.frontend.chunks) (selected.has(chunk.feature) ? chunks.keep : chunks.drop).push(chunk.file);
    const ids = Object.keys(manifest.groups);
    return {
        features: ids.filter(id => selected.has(id)),
        files: files.keep,
        dependencies: deps.keep,
        chunks: chunks.keep,
        excluded: {
            features: ids.filter(id => !selected.has(id)),
            files: files.drop,
            dependencies: deps.drop,
            chunks: chunks.drop
        }
    };
}

/** The ownership table of one group: globs, exclusive dependencies, shared dependencies. */
function ownershipTable(manifest, id) {
    const group = manifest.groups[id];
    return {
        feature: id,
        requires: group.requires || [],
        globs: group.globs,
        files: group.files.length,
        exclusiveDependencies: sortedUnique(manifest.dependencies.filter(dep => dep.exclusive && dep.owners[0] === id).map(dep => dep.name)),
        sharedDependencies: sortedUnique(manifest.dependencies.filter(dep => !dep.exclusive && dep.owners.includes(id)).map(dep => dep.name)),
        system: group.system || []
    };
}

module.exports = {
    MANIFEST_VERSION,
    SOURCE_ROOTS,
    SERVER_ROOTS,
    HOST_TREES,
    canonicalJson,
    listTrackedFiles,
    payloadGlobs,
    resolveLockKey,
    installedClosure,
    computeOwnership,
    payloadPathOf,
    repoPathOf,
    payloadDirOfLockKey,
    compatibleRange,
    buildReleaseManifest,
    closeOverRequires,
    selectPayload,
    ownershipTable
};
