/**
 * Feature catalog (P1.2 of the installer plan, issue #317).
 *
 * Pure data and validation. Ownership, dependencies, fresh defaults, legacy
 * switch locations and system dependencies come from ./inventory.js (the only
 * ownership source; nothing is duplicated here). The human-facing text, API
 * key names, config key names and documentation paths live in
 * ./descriptors/*.js. This module merges the two into one frozen descriptor
 * per feature id.
 *
 * It requires nothing but ./inventory and the descriptor modules: no
 * database, no config.json, no services. Secret VALUES never appear here,
 * only env var and config key NAMES.
 */

const inventory = require('./inventory');

const CORE_ID = 'core';
const KINDS = ['feature', 'adapter', 'pseudo-owner'];
const FRESH_DEFAULTS = ['on', 'off', 'always'];
const LEGACY_KINDS = ['flag', 'presence', 'derived'];

class CatalogError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CatalogError';
        this.code = code;
    }
}

const CORE_TEXT = {
    title: 'Core',
    summary: 'Chat, the portal shell and operator pages, settings, privacy, export, retention, the Inbox and the feature-state read path. Always available; never installable or disableable.',
    apiKeys: [],
    configKeys: [],
    docs: ['documentation/architecture.md', 'documentation/feature_inventory.md']
};

const TEXT = Object.assign(
    { [CORE_ID]: CORE_TEXT },
    require('./descriptors/adapters'),
    require('./descriptors/media'),
    require('./descriptors/workspace'),
    require('./descriptors/integrations')
);

function systemDependenciesOf(id) {
    return Object.keys(inventory.systemDependencies)
        .filter(name => inventory.ownerOf('systemDependency', name).owner === id)
        .sort();
}

function buildDescriptor(id) {
    const base = inventory.FEATURES[id];
    const text = TEXT[id];
    if (!text) throw new CatalogError('MISSING_DESCRIPTOR', `No descriptor text for feature "${id}".`);

    const inventorySwitch = inventory.legacySwitches[id] || null;
    let legacySwitch = null;
    if (inventorySwitch) {
        if (!text.legacy) {
            throw new CatalogError('MISSING_LEGACY', `Feature "${id}" has a legacy switch in the inventory but no legacy semantics in its descriptor.`);
        }
        legacySwitch = { ...inventorySwitch, ...text.legacy };
    } else if (text.legacy) {
        throw new CatalogError('UNEXPECTED_LEGACY', `Feature "${id}" declares legacy semantics but the inventory records no legacy switch.`);
    }

    return {
        id,
        kind: base.kind,
        title: text.title,
        summary: text.summary,
        dependsOn: [...base.dependsOn],
        freshDefault: base.freshDefault,
        legacySwitch,
        apiKeys: (text.apiKeys || []).map(key => ({ ...key })),
        configKeys: [...(text.configKeys || [])],
        systemDependencies: systemDependenciesOf(id),
        requiredSystemDependencies: [...(text.requiredSystemDependencies || [])],
        docs: [...(text.docs || [])],
        ...(text.helpUrl ? { helpUrl: text.helpUrl } : {})
    };
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

const FEATURE_IDS = inventory.FEATURE_IDS;

const FEATURES = {};
for (const id of FEATURE_IDS) FEATURES[id] = buildDescriptor(id);
deepFreeze(FEATURES);

/**
 * Check a catalog (the real one by default) and throw CatalogError on the
 * first structural problem: duplicate ids, descriptors that do not match the
 * id list, unknown or self dependencies, `core` as a dependency or with
 * dependencies of its own, bad enum values, and dependency cycles.
 *
 * @param {{ FEATURE_IDS: string[], FEATURES: Object }} [candidate]
 */
function validateCatalog(candidate = { FEATURE_IDS, FEATURES }) {
    const ids = candidate.FEATURE_IDS;
    const features = candidate.FEATURES;

    const seen = new Set();
    for (const id of ids) {
        if (seen.has(id)) throw new CatalogError('DUPLICATE_ID', `Feature id "${id}" is listed twice.`);
        seen.add(id);
    }
    if (!seen.has(CORE_ID)) throw new CatalogError('MISSING_CORE', 'The catalog must contain the "core" pseudo-owner.');

    for (const id of Object.keys(features)) {
        if (!seen.has(id)) throw new CatalogError('UNLISTED_DESCRIPTOR', `Descriptor "${id}" has no entry in FEATURE_IDS.`);
    }
    for (const id of ids) {
        const descriptor = features[id];
        if (!descriptor) throw new CatalogError('MISSING_DESCRIPTOR', `Feature "${id}" has no descriptor.`);
        if (descriptor.id !== id) throw new CatalogError('ID_MISMATCH', `Descriptor stored under "${id}" says id "${descriptor.id}".`);
        if (!KINDS.includes(descriptor.kind)) throw new CatalogError('BAD_KIND', `Feature "${id}" has unknown kind "${descriptor.kind}".`);
        if (!FRESH_DEFAULTS.includes(descriptor.freshDefault)) {
            throw new CatalogError('BAD_FRESH_DEFAULT', `Feature "${id}" has unknown freshDefault "${descriptor.freshDefault}".`);
        }
        if (descriptor.legacySwitch && !LEGACY_KINDS.includes(descriptor.legacySwitch.kind)) {
            throw new CatalogError('BAD_LEGACY_KIND', `Feature "${id}" has unknown legacy kind "${descriptor.legacySwitch.kind}".`);
        }
        if (typeof descriptor.title !== 'string' || !descriptor.title || typeof descriptor.summary !== 'string' || !descriptor.summary) {
            throw new CatalogError('MISSING_TEXT', `Feature "${id}" needs a title and a summary.`);
        }
        if (id === CORE_ID && descriptor.dependsOn.length > 0) {
            throw new CatalogError('CORE_HAS_DEPENDENCIES', '"core" cannot depend on anything.');
        }
        for (const dep of descriptor.dependsOn) {
            if (!seen.has(dep)) throw new CatalogError('UNKNOWN_DEPENDENCY', `"${id}" depends on unknown feature "${dep}".`);
            if (dep === CORE_ID) throw new CatalogError('CORE_AS_DEPENDENCY', `"${id}" lists "core" as a dependency; core is always available.`);
            if (dep === id) throw new CatalogError('SELF_DEPENDENCY', `"${id}" depends on itself.`);
        }
    }

    const state = new Map();
    const stack = [];
    const visit = (id) => {
        if (state.get(id) === 'done') return;
        if (state.get(id) === 'visiting') {
            const loop = [...stack.slice(stack.indexOf(id)), id];
            throw new CatalogError('DEPENDENCY_CYCLE', `Dependency cycle: ${loop.join(' -> ')}.`);
        }
        state.set(id, 'visiting');
        stack.push(id);
        for (const dep of features[id].dependsOn) visit(dep);
        stack.pop();
        state.set(id, 'done');
    };
    for (const id of ids) visit(id);
    return true;
}

function get(id) {
    return Object.prototype.hasOwnProperty.call(FEATURES, id) ? FEATURES[id] : null;
}

/** Direct dependents of `id`, in FEATURE_IDS order. */
function dependentsOf(id) {
    return FEATURE_IDS.filter(other => FEATURES[other].dependsOn.includes(id));
}

/**
 * `ids` plus everything they transitively depend on, deduplicated, in
 * FEATURE_IDS order so the result is the same whatever order was asked for.
 */
function closure(ids) {
    const wanted = new Set();
    const add = (id) => {
        if (!get(id)) throw new CatalogError('UNKNOWN_FEATURE', `Unknown feature "${id}".`);
        if (wanted.has(id)) return;
        wanted.add(id);
        for (const dep of FEATURES[id].dependsOn) add(dep);
    };
    for (const id of ids) add(id);
    return FEATURE_IDS.filter(id => wanted.has(id));
}

validateCatalog();

module.exports = {
    CORE_ID,
    FEATURE_IDS,
    FEATURES,
    inventory,
    get,
    dependentsOf,
    closure,
    validateCatalog,
    CatalogError
};
