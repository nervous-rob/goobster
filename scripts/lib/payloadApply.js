'use strict';

/**
 * Add and remove features on an installed payload through the release
 * manifest it was verified against (documentation/packaging.md, issue #328).
 *
 * An installation root holds `current/` (the active payload), optionally
 * `previous/` (the one before) and `staging/`, beside the state a change must
 * never touch: `data/` (the database, `features.json`, the manager's store
 * under `data/manager/`), `config.json` / `config/`, `logs/` and `cache/`.
 *
 * `planChange` is pure: it compares the selection `current` carries with the
 * one asked for and lists what would be added, removed, kept because another
 * selected feature still needs it, and which system tools to audit. Nothing is
 * uninstalled from the system and no feature data is purged (#328 Out of
 * scope). `applyChange` never edits `current` in place: it stages the new
 * selection from `current` (and a verified source payload for anything new),
 * verifies the copy, and activates it, so a failure at any point leaves the
 * old payload active. Node built-ins and ./payloadStage only.
 */

const fs = require('node:fs');
const path = require('node:path');

const stage = require('./payloadStage');

const { CORE, PayloadError } = stage;

/** Entries of an installation root a change never touches. */
const PROTECTED = ['data', 'config.json', 'config', 'logs', 'cache'];

const APPLY_CODES = Object.freeze({
    UNKNOWN_FEATURE: 'UNKNOWN_FEATURE',
    CORE_REQUIRED: 'CORE_REQUIRED',
    REQUIRED_BY: 'REQUIRED_BY',
    RELEASE_MISMATCH: 'RELEASE_MISMATCH',
    NOT_INSTALLED: 'NOT_INSTALLED',
    SOURCE_REQUIRED: 'SOURCE_REQUIRED',
    PLAN_STALE: 'PLAN_STALE'
});

/**
 * @typedef {Object} SystemAudit
 * @property {string} name            e.g. `ffmpeg`
 * @property {string} kind            `binary`, `python-venv`, ...
 * @property {string[]} owners        every feature of the release that declares it
 * @property {string[]} stillNeededBy owners that stay selected after the change
 * @property {'needed'|'still-needed'|'no-longer-needed'} status
 * @property {'audit'} action         reported to the operator; never uninstalled
 */

/**
 * @typedef {Object} ChangePlan
 * @property {1} version
 * @property {string} installRoot
 * @property {string|null} source      a verified payload carrying the added features' files
 * @property {boolean} needsSource
 * @property {string} releaseId
 * @property {string|null} profile
 * @property {{ before: string[], after: string[], add: string[], remove: string[] }} features
 * @property {{ add: string[], remove: string[] }} files          payload-relative paths
 * @property {{ add: string[], remove: string[] }} dependencies   payload dependency directories
 * @property {{ add: string[], remove: string[] }} chunks         dist-relative frontend chunks
 * @property {SystemAudit[]} system
 * @property {Array<{ kind: 'dependency', name: string, path: string, owners: string[], neededBy: string[] }>} keeps
 * @property {string[]} protected      installation-root entries the change never touches
 */

function failApply(code, message, details) {
    throw new PayloadError(code, message, details);
}

function difference(a, b) {
    const other = new Set(b);
    return a.filter(item => !other.has(item));
}

function loadCurrent(installRoot) {
    const current = path.join(installRoot, 'current');
    const manifestPath = path.join(current, stage.MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) failApply(APPLY_CODES.NOT_INSTALLED, 'there is no current payload to change');
    const manifest = stage.validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    return { current, manifest, selection: stage.readSelection(current) };
}

function systemAudit(manifest, before, after) {
    const declared = new Map();
    for (const [id, group] of Object.entries(manifest.groups)) {
        for (const entry of group.system || []) {
            if (!declared.has(entry.name)) declared.set(entry.name, { kind: entry.kind, owners: [] });
            declared.get(entry.name).owners.push(id);
        }
    }
    const audits = [];
    for (const [name, { kind, owners }] of [...declared].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const had = owners.filter(id => before.has(id));
        const has = owners.filter(id => after.has(id));
        let status = null;
        if (!had.length && has.length) status = 'needed';
        else if (had.length && !has.length) status = 'no-longer-needed';
        else if (has.length && difference(had, has).length) status = 'still-needed';
        if (status) audits.push({ name, kind, owners: owners.sort(), stillNeededBy: has.sort(), status, action: 'audit' });
    }
    return audits;
}

/**
 * Plan adding and removing features on the installation at `installRoot`.
 * @param {string} installRoot
 * @param {import('./payloadStage').ReleaseManifest|null} manifest  the release `current` was verified against (null: read it from current)
 * @param {{ add?: string[], remove?: string[], source?: string|null, profile?: string }} change
 * @returns {ChangePlan}
 */
function planChange(installRoot, manifest, { add = [], remove = [], source = null, profile } = {}) {
    const installed = loadCurrent(installRoot);
    const release = manifest || installed.manifest;
    if (stage.canonicalJson(release) !== stage.canonicalJson(installed.manifest)) {
        failApply(APPLY_CODES.RELEASE_MISMATCH, 'the manifest is not the one the current payload was installed from; an upgrade is a new release, not an add/remove');
    }
    for (const id of [...add, ...remove]) {
        if (!release.groups[id]) failApply(APPLY_CODES.UNKNOWN_FEATURE, `unknown feature "${id}"`, { feature: id });
    }
    if (remove.includes(CORE)) failApply(APPLY_CODES.CORE_REQUIRED, 'core cannot be removed');

    const before = stage.selectPayload(release, { features: installed.selection ? installed.selection.features : Object.keys(release.groups) });
    const beforeSet = new Set(before.features);
    const removing = new Set(remove);
    const kept = before.features.filter(id => !removing.has(id));
    const wanted = stage.closeOverRequires(release, [...kept, ...add]);
    const blocked = [...removing].filter(id => wanted.has(id));
    if (blocked.length) {
        const dependents = [...wanted].filter(id => (release.groups[id].requires || []).some(dep => blocked.includes(dep)));
        failApply(APPLY_CODES.REQUIRED_BY, `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} required by ${dependents.join(', ')}; remove those too or keep it`, { features: blocked, requiredBy: dependents });
    }
    const after = stage.selectPayload(release, { features: [...wanted] });
    const afterSet = new Set(after.features);

    const files = { add: difference(after.files, before.files), remove: difference(before.files, after.files) };
    const owners = new Map(release.files.map(file => [file.path, file]));
    const depDirs = new Set(difference(before.dependencies, after.dependencies));
    for (const relPath of files.remove) {
        const file = owners.get(relPath);
        const inRemovedDep = [...depDirs].some(dir => relPath.startsWith(`${dir}/`));
        if (file.owner === CORE && !inRemovedDep) throw new Error(`internal: plan would remove core file ${relPath}`);
    }
    const removedFeatures = before.features.filter(id => !afterSet.has(id));
    const keeps = [];
    for (const dep of release.dependencies) {
        if (!dep.path || !after.dependencies.includes(dep.path)) continue;
        if (!dep.owners.some(owner => removedFeatures.includes(owner))) continue;
        keeps.push({ kind: 'dependency', name: dep.name, path: dep.path, owners: [...dep.owners], neededBy: dep.owners.filter(owner => afterSet.has(owner)) });
    }

    return {
        version: 1,
        installRoot: path.resolve(installRoot),
        source: source ? path.resolve(source) : null,
        needsSource: files.add.length > 0,
        releaseId: stage.releaseIdOf(release),
        profile: profile || 'custom',
        features: {
            before: before.features,
            after: after.features,
            add: after.features.filter(id => !beforeSet.has(id)),
            remove: removedFeatures
        },
        files,
        dependencies: { add: difference(after.dependencies, before.dependencies), remove: [...depDirs] },
        chunks: { add: difference(after.chunks, before.chunks), remove: difference(before.chunks, after.chunks) },
        system: systemAudit(release, beforeSet, afterSet),
        keeps,
        protected: [...PROTECTED]
    };
}

/**
 * Apply a plan: stage the new selection, verify it, make it `current`.
 * @param {ChangePlan} plan
 * @param {import('./payloadStage').VerifyOptions & { stagingRoot?: string }} [options]
 * @returns {{ current: string, previous: string|null, features: string[], removed: number, added: number, audit: SystemAudit[], verified: import('./payloadStage').VerifyResult }}
 */
function applyChange(plan, options = {}) {
    const installed = loadCurrent(plan.installRoot);
    const now = stage.selectPayload(installed.manifest, { features: installed.selection ? installed.selection.features : Object.keys(installed.manifest.groups) });
    if (stage.releaseIdOf(installed.manifest) !== plan.releaseId || stage.canonicalJson(now.features) !== stage.canonicalJson(plan.features.before)) {
        failApply(APPLY_CODES.PLAN_STALE, 'the installation changed since this plan was made; plan again');
    }
    if (plan.needsSource && !plan.source) failApply(APPLY_CODES.SOURCE_REQUIRED, 'adding features needs a verified source payload that carries them');

    const verifyOptions = { ...options };
    delete verifyOptions.stagingRoot;
    const stagingRoot = options.stagingRoot || path.join(plan.installRoot, 'staging');
    const sources = [installed.current, ...(plan.source ? [plan.source] : [])];
    const staged = stage.stageSelection(sources, stagingRoot, { features: plan.features.after, profile: plan.profile }, verifyOptions);
    const activated = stage.activate(staged.stagingDir, plan.installRoot, verifyOptions);
    return {
        current: activated.current,
        previous: activated.previous,
        features: staged.features,
        removed: plan.files.remove.length,
        added: plan.files.add.length,
        audit: plan.system,
        verified: activated.verified
    };
}

module.exports = { PROTECTED, APPLY_CODES, planChange, applyChange };
