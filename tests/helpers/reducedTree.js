/**
 * Build a reduced Goobster tree the way a payload selection leaves one
 * (#328): the tracked payload trees copied into a temp directory, every file
 * owned by an unselected feature left out, and a node_modules of symlinks to
 * the checkout's installed packages that carries only the production
 * packages some selected owner (or core) imports. `data/features.json`
 * records the unselected features as not installed.
 *
 * The tree keeps the repository layout (packages/core, apps/api) so Node
 * resolves `@goobster/core` through a workspace link, as in the checkout.
 * Run it with `node --preserve-symlinks`: a linked package then resolves its
 * own requires inside the tree, as an installed copy would, instead of
 * finding whatever else the checkout has installed next to it.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const payload = require('../../scripts/lib/payloadManifest');

const COPIED_TREES = ['packages/core', 'apps/api', 'apps/sandbox', 'documentation', 'campaigns', 'clients'];
const ROOT_FILES = ['package.json'];
const HELPERS = ['tests/helpers/loadRecorder.js', 'tests/helpers/reducedPayloadProbe.js', 'tests/helpers/dormantSeed.js'];
const WORKSPACE_LINKS = { '@goobster/core': 'packages/core', '@goobster/api': 'apps/api', '@goobster/sandbox': 'apps/sandbox' };
/** Lockfile keys that are a directory of their own; nested ones travel inside their parent's. */
const TOP_LEVEL_KEY = /^((packages|apps)\/[^/]+\/)?node_modules\/(@[^/]+\/)?[^/]+$/;

function computeTreeOwnership(root) {
    const catalog = require('../../packages/core/features/catalog');
    const files = payload.listTrackedFiles(root);
    const ownership = payload.computeOwnership({
        root,
        catalog,
        files,
        target: { platform: process.platform, arch: process.arch }
    });
    return { catalog, files, ownership };
}

function link(target, at) {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at);
}

/**
 * @param {Object} params
 * @param {string} params.root        repository checkout
 * @param {string} params.dir         empty directory to build into
 * @param {string[]} params.features  requested optional features (closed over dependsOn)
 * @param {ReturnType<typeof computeTreeOwnership>} params.owned
 * @param {boolean} [params.writeState]  false leaves features.json out (the legacy no-file installation)
 * @returns {{ dir: string, selected: string[], excludedFeatures: string[], excludedFiles: string[],
 *   keptPackageKeys: string[], excludedPackageKeys: string[], excludedPackages: string[] }}
 *   package keys are lockfile keys (`node_modules/x`, `packages/core/node_modules/y`)
 */
function buildReducedTree({ root, dir, features, owned, writeState = true }) {
    const { catalog, files, ownership } = owned;
    const selected = new Set(['core', ...catalog.closure(features)]);
    const optional = catalog.FEATURE_IDS.filter(id => id !== 'core');
    const excludedFeatures = optional.filter(id => !selected.has(id));

    const excludedFiles = [];
    for (const file of files) {
        if (!COPIED_TREES.some(tree => file.startsWith(`${tree}/`))) continue;
        const owner = ownership.owners[file] || 'core';
        if (!selected.has(owner)) {
            excludedFiles.push(file);
            continue;
        }
        const to = path.join(dir, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(root, file), to);
    }

    for (const file of [...ROOT_FILES, ...HELPERS]) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }

    const keptKeys = [];
    const excludedKeys = ownership.unreferenced.map(entry => entry.path).filter(Boolean);
    for (const dep of ownership.dependencies) {
        (dep.owners.some(owner => selected.has(owner)) ? keptKeys : excludedKeys).push(dep.path);
    }
    for (const key of keptKeys) {
        if (!TOP_LEVEL_KEY.test(key)) continue;
        const source = path.join(root, key);
        if (!fs.existsSync(source)) continue;
        link(fs.realpathSync(source), path.join(dir, key));
    }
    for (const [name, rel] of Object.entries(WORKSPACE_LINKS)) {
        if (!fs.existsSync(path.join(dir, rel))) continue;
        const at = path.join(dir, 'node_modules', name);
        link(path.relative(path.dirname(at), path.join(dir, rel)), at);
    }

    const state = { version: 1, revision: 0, origin: 'operator', features: {} };
    for (const id of optional) {
        const on = selected.has(id);
        state.features[id] = { installed: on, active: on };
    }
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    if (writeState) fs.writeFileSync(path.join(dir, 'data', 'features.json'), `${JSON.stringify(state, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify({ webapp: { enabled: true, devMode: true } }, null, 2)}\n`);

    return {
        dir,
        selected: [...selected].sort(),
        excludedFeatures,
        excludedFiles,
        keptPackageKeys: [...new Set(keptKeys)].sort(),
        excludedPackageKeys: [...new Set(excludedKeys)].filter(key => !keptKeys.includes(key)).sort(),
        excludedPackages: [...new Set(excludedKeys.map(key => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)))].sort()
    };
}

/** Tree-relative path with the workspace links undone: `node_modules/@goobster/core/x` -> `packages/core/x`. */
function repoPathInTree(rel) {
    for (const [name, target] of Object.entries(WORKSPACE_LINKS)) {
        const prefix = `node_modules/${name}/`;
        if (rel.startsWith(prefix)) return `${target}/${rel.slice(prefix.length)}`;
    }
    return rel;
}

module.exports = { COPIED_TREES, WORKSPACE_LINKS, computeTreeOwnership, buildReducedTree, repoPathInTree };
