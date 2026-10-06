/**
 * Feature catalog (#317, P1.2).
 *
 * packages/core/features/catalog.js merges the #316 inventory with the
 * descriptor modules. This spec keeps the two in step in both directions
 * (every id has a descriptor and the reverse; nothing the inventory knows is
 * restated or contradicted), proves the graph helpers and the validator
 * (including cycle detection through an injected catalog), and checks that the
 * metadata only names things that exist: documentation paths, env vars that
 * the source reads, and config.example.json sections.
 */

const fs = require('node:fs');
const path = require('node:path');

const catalog = require('@goobster/core/features/catalog');
const inventory = require('@goobster/core/features/inventory');

const ROOT = path.resolve(__dirname, '..');
const { FEATURE_IDS, FEATURES, CORE_ID, CatalogError } = catalog;

function sourceFiles(dir, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'tests', '.git'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, found);
        else if (/\.(js|cjs|mjs|ts|tsx|sh)$/.test(entry.name)) found.push(full);
    }
    return found;
}

let corpus = null;
function sourceCorpus() {
    if (!corpus) {
        corpus = ['packages', 'apps', 'scripts', 'deploy']
            .map(dir => path.join(ROOT, dir))
            .filter(dir => fs.existsSync(dir))
            .flatMap(dir => sourceFiles(dir))
            .filter(file => !file.includes(`${path.sep}features${path.sep}descriptors${path.sep}`))
            .map(file => fs.readFileSync(file, 'utf8'))
            .join('\n');
    }
    return corpus;
}

function candidate(overrides = {}) {
    const features = JSON.parse(JSON.stringify(FEATURES));
    for (const [id, patch] of Object.entries(overrides)) {
        if (patch === null) delete features[id];
        else features[id] = { ...(features[id] || { id, kind: 'feature', title: 't', summary: 's', freshDefault: 'on', dependsOn: [] }), ...patch };
    }
    return { FEATURE_IDS: Object.keys(features), FEATURES: features };
}

describe('catalog shape and the inventory', () => {
    test('every FEATURE_IDS id has a descriptor and every descriptor has an id, in the same order', () => {
        expect(FEATURE_IDS).toBe(inventory.FEATURE_IDS);
        expect(Object.keys(FEATURES)).toEqual([...FEATURE_IDS]);
        for (const id of FEATURE_IDS) expect(FEATURES[id].id).toBe(id);
    });

    test('re-exports the inventory instead of duplicating it', () => {
        expect(catalog.inventory).toBe(inventory);
        expect(CORE_ID).toBe('core');
    });

    test('ownership facts match the inventory row for row', () => {
        for (const id of FEATURE_IDS) {
            const descriptor = FEATURES[id];
            const row = inventory.FEATURES[id];
            expect(descriptor.kind).toBe(row.kind);
            expect(descriptor.dependsOn).toEqual(row.dependsOn);
            expect(descriptor.freshDefault).toBe(row.freshDefault);
            const expectedDeps = Object.keys(inventory.systemDependencies)
                .filter(name => inventory.ownerOf('systemDependency', name).owner === id)
                .sort();
            expect(descriptor.systemDependencies).toEqual(expectedDeps);
        }
        const everyDependency = Object.keys(inventory.systemDependencies).sort();
        const claimed = FEATURE_IDS.flatMap(id => FEATURES[id].systemDependencies).sort();
        expect(claimed).toEqual(everyDependency);
    });

    test('legacySwitch is the inventory record plus kind and semantics; null exactly when the inventory has none', () => {
        for (const id of FEATURE_IDS) {
            const recorded = inventory.legacySwitches[id];
            const legacy = FEATURES[id].legacySwitch;
            if (!recorded) {
                expect(legacy).toBeNull();
                continue;
            }
            expect(legacy).toMatchObject(recorded);
            expect(['flag', 'presence', 'derived']).toContain(legacy.kind);
            expect(typeof legacy.semantics).toBe('string');
            expect(legacy.note.length).toBeGreaterThan(10);
            expect(typeof legacy.defaultOn).toBe('boolean');
        }
    });

    test('the #261 preset values are in the catalog: economy, exchange and gambling off, core always, the rest on', () => {
        const off = FEATURE_IDS.filter(id => FEATURES[id].freshDefault === 'off');
        expect(off).toEqual(['economy', 'exchange', 'gambling']);
        expect(FEATURES.core.freshDefault).toBe('always');
        for (const id of FEATURE_IDS.filter(id => !off.includes(id) && id !== 'core')) {
            expect(FEATURES[id].freshDefault).toBe('on');
        }
    });

    test('descriptors are frozen and carry the contract fields', () => {
        for (const id of FEATURE_IDS) {
            const d = FEATURES[id];
            expect(Object.isFrozen(d)).toBe(true);
            expect(typeof d.title).toBe('string');
            expect(typeof d.summary).toBe('string');
            expect(Array.isArray(d.apiKeys)).toBe(true);
            expect(Array.isArray(d.configKeys)).toBe(true);
            expect(Array.isArray(d.docs)).toBe(true);
            expect(d.requiredSystemDependencies.every(name => d.systemDependencies.includes(name))).toBe(true);
        }
        const title = FEATURES.music.title;
        try { FEATURES.music.title = 'changed'; } catch { /* strict mode throws */ }
        expect(FEATURES.music.title).toBe(title);
    });

    test('get() returns the descriptor or null and never throws', () => {
        expect(catalog.get('music')).toBe(FEATURES.music);
        expect(catalog.get('nope')).toBeNull();
        expect(catalog.get('toString')).toBeNull();
        expect(catalog.get('__proto__')).toBeNull();
        expect(catalog.get(undefined)).toBeNull();
    });
});

describe('metadata only names things that exist', () => {
    test('every documentation path exists', () => {
        for (const id of FEATURE_IDS) {
            for (const doc of FEATURES[id].docs) {
                expect({ id, doc, exists: fs.existsSync(path.join(ROOT, doc)) }).toEqual({ id, doc, exists: true });
            }
        }
    });

    test('every non-core feature points at least one doc', () => {
        for (const id of FEATURE_IDS) expect(FEATURES[id].docs.length).toBeGreaterThan(0);
    });

    test('api keys are names only, well-formed and read by the source', () => {
        const text = sourceCorpus();
        const seen = new Map();
        for (const id of FEATURE_IDS) {
            for (const key of FEATURES[id].apiKeys) {
                expect(Object.keys(key).sort()).toEqual(
                    expect.arrayContaining(['name', 'purpose', 'required'])
                );
                expect(Object.keys(key).every(k => ['name', 'configPath', 'purpose', 'obtainUrl', 'required'].includes(k))).toBe(true);
                expect(key.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
                expect(typeof key.required).toBe('boolean');
                expect(key.purpose.length).toBeGreaterThan(10);
                expect({ id, name: key.name, read: text.includes(key.name) }).toEqual({ id, name: key.name, read: true });
                if (key.obtainUrl) expect(key.obtainUrl).toMatch(/^https:\/\//);
                const url = seen.get(key.name);
                if (url !== undefined) expect(key.obtainUrl).toBe(url);
                seen.set(key.name, key.obtainUrl);
            }
        }
    });

    test('config keys name sections that config.example.json or the source defines', () => {
        const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
        const text = sourceCorpus();
        for (const id of FEATURE_IDS) {
            for (const dotted of [...FEATURES[id].configKeys, ...FEATURES[id].apiKeys.map(k => k.configPath).filter(Boolean)]) {
                const [root, ...rest] = dotted.split('.');
                const leaf = rest.length ? rest[rest.length - 1] : root;
                const known = Object.prototype.hasOwnProperty.call(example, root) || text.includes(`.${root}`);
                expect({ id, dotted, known }).toEqual({ id, dotted, known: true });
                expect({ id, dotted, leaf: text.includes(leaf) }).toEqual({ id, dotted, leaf: true });
            }
        }
    });

    test('every legacy env var and config path is read by its config module or the source', () => {
        const text = sourceCorpus();
        for (const id of FEATURE_IDS) {
            const legacy = FEATURES[id].legacySwitch;
            if (!legacy) continue;
            if (legacy.envVar) expect({ id, env: legacy.envVar, read: text.includes(legacy.envVar) }).toEqual({ id, env: legacy.envVar, read: true });
            const leaf = legacy.configPath.split('.').pop();
            expect(text.includes(leaf)).toBe(true);
        }
    });

    test('no descriptor field can hold a secret value', () => {
        const serialised = JSON.stringify(FEATURES);
        expect(serialised).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
        for (const id of FEATURE_IDS) {
            for (const key of FEATURES[id].apiKeys) expect(key).not.toHaveProperty('value');
        }
    });
});

describe('graph helpers', () => {
    test('dependentsOf lists direct dependents in catalog order', () => {
        expect(catalog.dependentsOf('economy')).toEqual(['exchange', 'gambling']);
        expect(catalog.dependentsOf('github')).toEqual(['cursor']);
        expect(catalog.dependentsOf('projects')).toEqual(['observatory']);
        expect(catalog.dependentsOf('music')).toEqual([]);
        expect(catalog.dependentsOf('nope')).toEqual([]);
    });

    test('dependentsOf agrees with dependsOn for every feature', () => {
        for (const id of FEATURE_IDS) {
            for (const dependent of catalog.dependentsOf(id)) expect(FEATURES[dependent].dependsOn).toContain(id);
        }
        for (const id of FEATURE_IDS) {
            for (const dep of FEATURES[id].dependsOn) expect(catalog.dependentsOf(dep)).toContain(id);
        }
    });

    test('closure adds transitive dependencies once, in a deterministic order', () => {
        expect(catalog.closure(['observatory'])).toEqual(['projects', 'observatory', 'sandbox']);
        expect(catalog.closure(['cursor'])).toEqual(['github', 'cursor']);
        expect(catalog.closure(['exchange', 'gambling'])).toEqual(['economy', 'exchange', 'gambling']);
        expect(catalog.closure(['gambling', 'exchange', 'economy', 'gambling'])).toEqual(['economy', 'exchange', 'gambling']);
        expect(catalog.closure(['music'])).toEqual(['music']);
        expect(catalog.closure([])).toEqual([]);
    });

    test('closure is order independent and idempotent', () => {
        const a = catalog.closure(['cursor', 'observatory', 'discordActivity']);
        const b = catalog.closure(['discordActivity', 'observatory', 'cursor']);
        expect(a).toEqual(b);
        expect(catalog.closure(a)).toEqual(a);
    });

    test('closure rejects an unknown id', () => {
        expect(() => catalog.closure(['music', 'nope'])).toThrow(CatalogError);
        expect(() => catalog.closure(['nope'])).toThrow(/Unknown feature "nope"/);
    });
});

describe('validateCatalog', () => {
    test('the shipped catalog is valid', () => {
        expect(catalog.validateCatalog()).toBe(true);
    });

    function failure(candidateCatalog) {
        try {
            catalog.validateCatalog(candidateCatalog);
        } catch (error) {
            return error;
        }
        return null;
    }

    test('detects a dependency cycle through an injected catalog and names the loop', () => {
        const error = failure(candidate({
            economy: { dependsOn: ['gambling'] }
        }));
        expect(error).toBeInstanceOf(CatalogError);
        expect(error.code).toBe('DEPENDENCY_CYCLE');
        expect(error.message).toMatch(/economy -> gambling -> economy|gambling -> economy -> gambling/);
    });

    test('detects a longer cycle', () => {
        const error = failure(candidate({
            projects: { dependsOn: ['observatory'] }
        }));
        expect(error.code).toBe('DEPENDENCY_CYCLE');
    });

    test('rejects an unknown dependsOn', () => {
        expect(failure(candidate({ music: { dependsOn: ['nope'] } })).code).toBe('UNKNOWN_DEPENDENCY');
    });

    test('rejects core as a dependency and core with dependencies', () => {
        expect(failure(candidate({ music: { dependsOn: ['core'] } })).code).toBe('CORE_AS_DEPENDENCY');
        expect(failure(candidate({ core: { dependsOn: ['music'] } })).code).toBe('CORE_HAS_DEPENDENCIES');
    });

    test('rejects a self dependency', () => {
        expect(failure(candidate({ music: { dependsOn: ['music'] } })).code).toBe('SELF_DEPENDENCY');
    });

    test('rejects duplicate ids', () => {
        const dup = candidate();
        dup.FEATURE_IDS = [...dup.FEATURE_IDS, 'music'];
        expect(failure(dup).code).toBe('DUPLICATE_ID');
    });

    test('rejects a descriptor missing from the id list and an id without a descriptor', () => {
        const extra = candidate();
        extra.FEATURES.ghost = { ...extra.FEATURES.music, id: 'ghost' };
        expect(failure(extra).code).toBe('UNLISTED_DESCRIPTOR');

        const missing = candidate();
        delete missing.FEATURES.music;
        expect(failure(missing).code).toBe('MISSING_DESCRIPTOR');
    });

    test('rejects a catalog without core, bad enums and missing text', () => {
        const noCore = candidate();
        noCore.FEATURE_IDS = noCore.FEATURE_IDS.filter(id => id !== 'core');
        delete noCore.FEATURES.core;
        for (const id of Object.keys(noCore.FEATURES)) {
            noCore.FEATURES[id].dependsOn = noCore.FEATURES[id].dependsOn.filter(dep => dep !== 'core');
        }
        expect(failure(noCore).code).toBe('MISSING_CORE');
        expect(failure(candidate({ music: { freshDefault: 'maybe' } })).code).toBe('BAD_FRESH_DEFAULT');
        expect(failure(candidate({ music: { kind: 'plugin' } })).code).toBe('BAD_KIND');
        expect(failure(candidate({ music: { summary: '' } })).code).toBe('MISSING_TEXT');
        expect(failure(candidate({ music: { legacySwitch: { kind: 'other' } } })).code).toBe('BAD_LEGACY_KIND');
    });
});
